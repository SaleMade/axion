// ══════════════════════════════════════════════════════════════
// AXION — Cloudflare Worker (API multi-usuário)
//
// Endpoints:
//   POST /auth/login         { login, password } → { token, user }
//   POST /auth/logout        Authorization: Bearer <token>
//   GET  /auth/me            Authorization: Bearer <token> → { user }
//   GET  /api/state          Authorization: Bearer <token> → { data, version, updated_at }
//   POST /api/state          Authorization: Bearer <token>, body: { data, base_version }
//                            → { ok, version, updated_at }  ou 409 se conflito
//   GET  /api/users          Authorization: Bearer <token> → [users] (sem hashes)
//   POST /api/users          Authorization: Bearer <token> (Director only), body: user payload
//   DELETE /api/users/:id    Authorization: Bearer <token> (Director only)
//   POST /api/users/:id/reset-password  Authorization: Bearer <token> (Director only)
//
// CORS aberto pra que a Dash chame de qualquer origem (incluindo localhost dev).
//
// Setup:
//   wrangler d1 create axion         → copia o ID e cola em wrangler.toml
//   wrangler d1 execute axion --remote --file=./schema.sql
//   wrangler deploy
//   wrangler d1 execute axion --remote --command "SELECT * FROM users"
// ══════════════════════════════════════════════════════════════

const SESSION_TTL_HOURS = 24 * 30;  // 30 dias
const ROLE_DIRETOR = ['diretor','socio','produtor'];

// Chave única configurada no postback da PAYT — acesso ao webhook
// Pra trocar: editar aqui ou configurar como secret via `wrangler secret put PAYT_TOKEN`
const PAYT_TOKEN_DEFAULT = 'b562d560380649cbc6c8ade3550eb7f8';

// Chave única do webhook do FORNECEDOR — leads vindos de plataformas externas
// (ex: ferramenta de captação, planilha automática, integração com landing page)
const FORN_TOKEN_DEFAULT = 'frn_a47c9f8e3b21d5046ec8fa9d2b7e4513';

// ─── Helpers ───
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
  },
});

const err = (msg, status = 400) => json({ error: msg }, status);

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function authUser(req, env) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!m) return null;
  const token = m[1];
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT s.user_id, u.id, u.login, u.name, u.abbr, u.role, u.color, u.bg, u.com_pct
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token = ? AND s.expires_at > ?`
  ).bind(token, now).first();
  return row || null;
}

function isDirector(user) {
  return user && ROLE_DIRETOR.includes(user.role);
}

// Limpa sessões expiradas (oportunístico)
async function cleanExpiredSessions(env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
}

// ─── Route handlers ───

async function handleLogin(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || !body.login || !body.password) return err('Login e senha obrigatórios');
  const login = String(body.login).toLowerCase().trim();
  const pwdHash = await sha256Hex(body.password);

  const user = await env.DB.prepare(
    'SELECT id, login, pwd_hash, name, abbr, role, color, bg, com_pct FROM users WHERE lower(login) = ?'
  ).bind(login).first();

  if (!user || user.pwd_hash !== pwdHash) {
    return err('Login ou senha inválidos', 401);
  }

  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_TTL_HOURS * 3600;

  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, user.id, now, expiresAt).run();

  // Limpeza oportunística
  cleanExpiredSessions(env);

  // Não retorna pwd_hash
  const { pwd_hash, ...safe } = user;
  return json({ token, user: safe });
}

async function handleLogout(req, env) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (m) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(m[1]).run();
  }
  return json({ ok: true });
}

async function handleMe(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const { user_id, ...rest } = u;  // remove duplicado
  return json({ user: rest });
}

async function handleGetState(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const row = await env.DB.prepare(
    'SELECT data, version, updated_at, updated_by FROM dashboard_state WHERE id = 1'
  ).first();
  if (!row) return json({ data: {}, version: 0, updated_at: 0 });
  let data;
  try { data = JSON.parse(row.data); } catch (e) { data = {}; }
  return json({ data, version: row.version, updated_at: row.updated_at, updated_by: row.updated_by });
}

async function handlePostState(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.data !== 'object') return err('Body inválido — esperado { data, base_version? }');

  // Optimistic concurrency: se cliente envia base_version, valida que não houve write desde então
  const current = await env.DB.prepare('SELECT version FROM dashboard_state WHERE id = 1').first();
  const curVer = current?.version || 0;
  if (typeof body.base_version === 'number' && body.base_version < curVer) {
    return json({ error: 'conflict', current_version: curVer }, 409);
  }

  const newVer = curVer + 1;
  const now = Math.floor(Date.now() / 1000);
  const dataStr = JSON.stringify(body.data);

  await env.DB.prepare(
    `INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(dataStr, newVer, now, u.user_id).run();

  return json({ ok: true, version: newVer, updated_at: now });
}

async function handleListUsers(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const rows = await env.DB.prepare(
    'SELECT id, login, name, abbr, role, color, bg, com_pct, created_at, ' +
    'CASE WHEN pwd_hash IS NOT NULL AND pwd_hash != "" THEN 1 ELSE 0 END AS has_password FROM users ORDER BY name'
  ).all();
  return json({ users: rows.results });
}

async function handleCreateOrUpdateUser(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode gerenciar usuários', 403);

  const body = await req.json().catch(() => null);
  if (!body) return err('Body inválido');
  const { id, login, password, name, abbr, role, color, bg, com_pct } = body;
  if (!name || !login || !role) return err('Campos obrigatórios: name, login, role');

  const loginNorm = String(login).toLowerCase().trim();

  // Detecta create vs update
  const existing = id ? await env.DB.prepare('SELECT id, pwd_hash FROM users WHERE id = ?').bind(id).first() : null;

  // Login único
  const dup = await env.DB.prepare('SELECT id FROM users WHERE lower(login) = ? AND id != ?').bind(loginNorm, id || '').first();
  if (dup) return err('Login já está em uso', 409);

  let pwdHash = existing?.pwd_hash || null;
  if (password) {
    if (String(password).length < 6) return err('Senha precisa ter pelo menos 6 caracteres');
    pwdHash = await sha256Hex(password);
  }
  if (!pwdHash) return err('Senha obrigatória ao criar usuário');

  if (existing) {
    // Update
    await env.DB.prepare(
      `UPDATE users SET login=?, pwd_hash=?, name=?, abbr=?, role=?, color=?, bg=?, com_pct=? WHERE id=?`
    ).bind(loginNorm, pwdHash, name, abbr || null, role, color || null, bg || null, Number(com_pct) || 0, id).run();
    return json({ ok: true, id, action: 'updated' });
  } else {
    // Create — gera id se não veio
    const newId = id || `${role}_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare(
      `INSERT INTO users (id, login, pwd_hash, name, abbr, role, color, bg, com_pct) VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(newId, loginNorm, pwdHash, name, abbr || null, role, color || null, bg || null, Number(com_pct) || 0).run();
    return json({ ok: true, id: newId, action: 'created' });
  }
}

async function handleDeleteUser(req, env, userId) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode remover usuários', 403);
  if (userId === u.user_id) return err('Você não pode se auto-excluir', 400);

  const r = await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  if (!r.meta.changes) return err('Usuário não encontrado', 404);
  return json({ ok: true });
}

// ─── PAYT WEBHOOK ─────────────────────────────────────────────
// PAYT envia POST com {event, order:{customer:{...}, ...}}
// URL: /webhook/payt/<chave>
// Validamos a chave, encontramos/criamos o lead, aplicamos o mapeamento
// configurado em DB.payt_mapping (que vive no state blob), persistimos.

const norm = s => String(s || '').replace(/\D/g, '');

// Extrai dados do customer/order numa estrutura comum (PAYT varia campos)
function extractPaytData(body) {
  const order = body?.order || body?.pedido || body || {};
  const customer = order.customer || order.cliente || body?.customer || body?.cliente || {};
  return {
    event: String(body?.event || body?.evento || body?.tipo || '').toLowerCase(),
    order_id: order.id || order.order_id || body?.id || body?.pedido_id || '',
    name: customer.name || customer.nome || '',
    email: customer.email || '',
    phone: customer.phone || customer.telefone || customer.whatsapp || customer.celular || '',
    cpf: customer.cpf || customer.document || customer.documento || '',
    amount: Number(order.amount || order.valor || order.total || body?.amount || body?.valor || 0),
    product: order.product || order.produto || (Array.isArray(order.products) ? order.products[0]?.name : '') || '',
    address: customer.address || order.address || {},
    city: customer.city || (customer.address?.city) || '',
    state: customer.state || customer.uf || (customer.address?.state) || '',
    zipcode: customer.zipcode || customer.cep || (customer.address?.zipcode) || '',
    payment_method: order.payment_method || order.metodo_pagamento || body?.payment_method || '',
    raw: body,
  };
}

// Encontra lead existente por CPF (preferido) > WhatsApp > email
function findLead(leads, data) {
  if (!Array.isArray(leads)) return null;
  const cpfClean = norm(data.cpf);
  const phoneClean = norm(data.phone);
  if (cpfClean) {
    const byCpf = leads.find(l => norm(l.cpf) === cpfClean);
    if (byCpf) return byCpf;
  }
  if (phoneClean) {
    const byWa = leads.find(l => norm(l.wa) === phoneClean);
    if (byWa) return byWa;
  }
  if (data.email) {
    const byEmail = leads.find(l => l.email && l.email.toLowerCase() === data.email.toLowerCase());
    if (byEmail) return byEmail;
  }
  return null;
}

function todayBR() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
}
function nowTimeBR() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

async function handlePaytWebhook(req, env, urlToken) {
  // Validação da chave única
  const expected = (env && env.PAYT_TOKEN) || PAYT_TOKEN_DEFAULT;
  if (urlToken !== expected) {
    return json({ error: 'token inválido' }, 401);
  }

  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'payload JSON inválido' }, 400); }

  const data = extractPaytData(body);
  if (!data.event) {
    return json({ error: 'campo "event" ausente' }, 400);
  }

  // Carrega state atual
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  let state = {};
  let curVer = 0;
  if (row) {
    try { state = JSON.parse(row.data); } catch (e) { state = {}; }
    curVer = row.version || 0;
  }
  state.leads = state.leads || [];
  state.wh_log_server = state.wh_log_server || [];
  const mapping = (state.payt_mapping || {})[data.event];

  // Encontra lead existente
  let lead = findLead(state.leads, data);
  let action_taken = '';
  let lead_id_result = null;

  if (lead) {
    // Aplica mapeamento sobre lead existente
    const prev = lead.col;
    if (mapping?.etapa) lead.col = mapping.etapa;
    if (mapping?.spg) lead.spg = mapping.spg;
    if (mapping?.action === 'tag' && mapping.tag) {
      lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
      if (!lead.tags.includes(mapping.tag)) lead.tags.push(mapping.tag);
    }
    // Histórico do lead
    lead.hist = Array.isArray(lead.hist) ? lead.hist : [];
    lead.hist.push({
      from: prev,
      to: lead.col,
      who: 'payt',
      time: `${todayBR()} ${nowTimeBR()}`,
      note: `PAYT: ${data.event}`,
    });
    // Se ação for 'pagar' e ainda não houver venda correspondente, registra
    if (mapping?.action === 'pagar') {
      state.vendas = state.vendas || [];
      const alreadyHas = state.vendas.some(v => v.leadId === lead.id);
      if (!alreadyHas && lead.vl) {
        const com_pct = Number(lead.com_pct) || 12;
        const comiss = lead.vl * com_pct / 100;
        state.vendas.unshift({
          id: Date.now(),
          leadId: lead.id,
          nome: lead.nome,
          prod: lead.prod,
          vl: lead.vl,
          custo: lead.vl * 0.45,
          com_pct,
          comiss,
          lucro: lead.vl - lead.vl * 0.45 - comiss,
          at: lead.at,
          data: todayBR(),
          logStatus: 'Comprado',
        });
      }
    }
    action_taken = 'updated';
    lead_id_result = lead.id;
  } else if (mapping || data.event === 'aguardando_pagamento' || data.event === 'finalizada') {
    // Cria lead novo se evento for de início de pedido
    state.nextLead = state.nextLead || 1;
    const newLead = {
      id: state.nextLead++,
      nome: data.name || '(sem nome)',
      cpf: data.cpf || '',
      wa: data.phone || '',
      email: data.email || '',
      cep: data.zipcode || '',
      end: '',
      num: '',
      bairro: '',
      cidade: data.city || '',
      uf: data.state || '',
      data: todayBR(),
      orig: 'PAYT',
      prod: data.product || '',
      trat: '',
      vl: data.amount || 0,
      com_pct: 12,
      track: '',
      pgto: data.payment_method || '',
      spg: mapping?.spg || 'Pendente',
      mod: 'antecipado',
      at: null,
      col: mapping?.etapa || 'A Enviar',
      obs: `Criado via PAYT (order ${data.order_id})`,
      link: '',
      tags: mapping?.action === 'tag' && mapping.tag ? [mapping.tag] : [],
      fu: null,
      hist: [{
        from: '—',
        to: mapping?.etapa || 'A Enviar',
        who: 'payt',
        time: `${todayBR()} ${nowTimeBR()}`,
        note: `PAYT: ${data.event}`,
      }],
      comments: [],
    };
    state.leads.unshift(newLead);
    action_taken = 'created';
    lead_id_result = newLead.id;
  } else {
    action_taken = 'skipped';
  }

  // Log do webhook (até 100 entradas pra não inflar)
  state.wh_log_server.unshift({
    ts: Math.floor(Date.now() / 1000),
    org: 'PAYT',
    evt: data.event,
    lid: lead_id_result,
    action: action_taken,
    order_id: data.order_id || '',
  });
  state.wh_log_server = state.wh_log_server.slice(0, 100);

  // Persiste
  const newVer = curVer + 1;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(JSON.stringify(state), newVer, now, 'payt-webhook').run();

  return json({
    ok: true,
    event: data.event,
    action: action_taken,
    lead_id: lead_id_result,
    mapping_found: !!mapping,
  });
}

// ─── FORNECEDOR WEBHOOK ──────────────────────────────────────
// Recebe leads enviados por fornecedor / plataforma de captação.
// URL: /webhook/fornecedor/<chave>
// Aceita payload flexível com várias variações de nome de campo.
async function handleFornecedorWebhook(req, env, urlToken) {
  const expected = (env && env.FORN_TOKEN) || FORN_TOKEN_DEFAULT;
  if (urlToken !== expected) {
    return json({ error: 'token inválido' }, 401);
  }

  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'payload JSON inválido' }, 400); }

  // Extração flexível — tenta vários nomes de campo (nome PT-BR e EN)
  const lead_data = {
    nome:      body.nome || body.name || body.cliente || body.customer || '',
    cpf:       body.cpf || body.document || body.documento || '',
    telefone:  body.telefone || body.phone || body.whatsapp || body.celular || body.wa || '',
    email:     body.email || body.e_mail || '',
    cep:       body.cep || body.zipcode || body.zip || '',
    endereco:  body.endereco || body.address || body.end || body.rua || '',
    numero:    body.numero || body.num || body.number || '',
    bairro:    body.bairro || body.neighborhood || '',
    cidade:    body.cidade || body.city || '',
    uf:        body.uf || body.state || body.estado || '',
    produto:   body.produto || body.product || body.item || '',
    valor:     Number(body.valor || body.amount || body.preco || body.price || 0),
    modalidade:body.modalidade || body.mod || body.tipo || 'antecipado',
    origem:    body.origem || body.fonte || body.source || body.platform || 'Fornecedor',
    obs:       body.obs || body.notes || body.observacao || body.comment || '',
    external_id: body.external_id || body.id || body.order_id || '',
  };

  if (!lead_data.nome) return json({ error: 'campo "nome" obrigatório' }, 400);

  // Normaliza modalidade
  const modNorm = String(lead_data.modalidade).toLowerCase();
  const mod = (modNorm === 'entrega' || modNorm === 'cod' || modNorm === 'pague_apos_receber') ? 'entrega' : 'antecipado';

  // Carrega state
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  let state = {};
  let curVer = 0;
  if (row) {
    try { state = JSON.parse(row.data); } catch (e) { state = {}; }
    curVer = row.version || 0;
  }
  state.leads = state.leads || [];
  state.wh_log_server = state.wh_log_server || [];
  state.nextLead = state.nextLead || 1;

  // Idempotência: se external_id já existe, não duplica
  if (lead_data.external_id) {
    const dup = state.leads.find(l => l.external_id === lead_data.external_id);
    if (dup) {
      return json({ ok: true, action: 'skipped_duplicate', lead_id: dup.id });
    }
  }

  // Cria o lead
  const newLead = {
    id: state.nextLead++,
    external_id: lead_data.external_id || '',
    nome: lead_data.nome,
    cpf: lead_data.cpf,
    wa: lead_data.telefone,
    email: lead_data.email,
    cep: lead_data.cep,
    end: lead_data.endereco,
    num: lead_data.numero,
    comp: '',
    bairro: lead_data.bairro,
    cidade: lead_data.cidade,
    uf: lead_data.uf,
    data: todayBR(),
    orig: lead_data.origem,
    prod: lead_data.produto,
    trat: '',
    vl: lead_data.valor,
    com_pct: 12,
    track: '',
    pgto: '',
    spg: 'Pendente',
    mod: mod,
    at: null,
    col: 'A Enviar',
    obs: lead_data.obs,
    link: '',
    tags: ['fornecedor'],
    fu: null,
    hist: [{
      from: '—',
      to: 'A Enviar',
      who: 'fornecedor',
      time: `${todayBR()} ${nowTimeBR()}`,
      note: `Lead recebido de ${lead_data.origem}`,
    }],
    comments: [],
  };
  state.leads.unshift(newLead);

  // Log
  state.wh_log_server.unshift({
    ts: Math.floor(Date.now() / 1000),
    org: 'Fornecedor',
    evt: 'novo_lead',
    lid: newLead.id,
    action: 'created',
    origem: lead_data.origem,
  });
  state.wh_log_server = state.wh_log_server.slice(0, 100);

  // Persiste
  const newVer = curVer + 1;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(JSON.stringify(state), newVer, now, 'fornecedor-webhook').run();

  return json({
    ok: true,
    action: 'created',
    lead_id: newLead.id,
    nome: newLead.nome,
  });
}

// ─── Router ───

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-max-age': '86400',
      },
    });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // health check + raiz
      if (req.method === 'GET' && (path === '/' || path === '/api')) {
        return json({ name: 'axion-api', ok: true, version: 1 });
      }

      // auth
      if (req.method === 'POST'  && path === '/auth/login')  return handleLogin(req, env);
      if (req.method === 'POST'  && path === '/auth/logout') return handleLogout(req, env);
      if (req.method === 'GET'   && path === '/auth/me')     return handleMe(req, env);

      // state sync
      if (req.method === 'GET'   && path === '/api/state')   return handleGetState(req, env);
      if (req.method === 'POST'  && path === '/api/state')   return handlePostState(req, env);

      // users CRUD
      if (req.method === 'GET'    && path === '/api/users')         return handleListUsers(req, env);
      if (req.method === 'POST'   && path === '/api/users')         return handleCreateOrUpdateUser(req, env);
      const delMatch = path.match(/^\/api\/users\/([^/]+)$/);
      if (req.method === 'DELETE' && delMatch)                      return handleDeleteUser(req, env, delMatch[1]);

      // PAYT Webhook — recebe postbacks com a chave única na URL
      const paytMatch = path.match(/^\/webhook\/payt\/([a-zA-Z0-9_-]+)$/);
      if (paytMatch && (req.method === 'POST' || req.method === 'GET')) {
        if (req.method === 'GET') {
          // health check da URL pra colar na PAYT
          return json({ name: 'axion-payt-webhook', ok: true, ready: true });
        }
        return handlePaytWebhook(req, env, paytMatch[1]);
      }

      // Fornecedor Webhook — recebe leads de plataforma externa de captação
      const fornMatch = path.match(/^\/webhook\/fornecedor\/([a-zA-Z0-9_-]+)$/);
      if (fornMatch && (req.method === 'POST' || req.method === 'GET')) {
        if (req.method === 'GET') {
          return json({
            name: 'axion-fornecedor-webhook',
            ok: true,
            ready: true,
            doc: 'POST com body JSON. Campos: nome (obrigatório), cpf, telefone/whatsapp, email, cep, endereco, cidade, uf, produto, valor, modalidade (antecipado|entrega), origem, obs, external_id'
          });
        }
        return handleFornecedorWebhook(req, env, fornMatch[1]);
      }

      return err('Rota não encontrada', 404);
    } catch (e) {
      console.error('worker error', e?.stack || e);
      return err('Erro interno: ' + (e?.message || 'desconhecido'), 500);
    }
  },
};
