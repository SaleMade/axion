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

const SESSION_TTL_HOURS = 24 * 30;  // 30 dias de base; com renovação deslizante (sliding),
                                    // sessão ATIVA nunca expira — só a inativa por 30 dias.

// Versão mínima do app com permissão de ESCREVER no estado.
// Abaixo disso o cliente é uma aba velha em cache (lógica de sync antiga que
// sobrescrevia o estado inteiro). Ele recebe 426 e é forçado a recarregar.
// Ao subir uma versão que muda o formato do estado, atualize aqui também.
const MIN_APP_VERSION = '2.79.0';

// Coleções vigiadas pela guarda anti-apagamento em massa
const GUARDED_COLLECTIONS = ['leads','vendas','clientes','chips','invest','gastos','aportes','payouts','produtos','pressels'];

// Compara "2.69.0" vs "2.68.0" → <0 se a<b, 0 se igual, >0 se a>b.
// Versão ausente/inválida vira 0.0.0 (= cliente antigo).
function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
                                     // (era 30 dias — sessão zumbi viva por 1 mês se token vazasse)
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
    `SELECT s.expires_at, s.user_id, u.id, u.login, u.name, u.abbr, u.role, u.color, u.bg, u.com_pct
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token = ? AND s.expires_at > ?`
  ).bind(token, now).first();
  if (!row) return null;
  // Sliding expiry: enquanto o usuário usa, renova o prazo. Pra não gravar a cada
  // request (polling de 10s), só renova quando falta menos de (TTL - 1 dia) →
  // no máximo ~1 write/dia por sessão. Assim sessão ativa nunca expira.
  const fullTtl = SESSION_TTL_HOURS * 3600;
  if (row.expires_at - now < fullTtl - 86400) {
    try {
      await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
        .bind(now + fullTtl, token).run();
    } catch (_) { /* renovação é best-effort */ }
  }
  return row;
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

// ─── Backup automático do estado (R2) ─────────────────────────────────────
// Snapshot horário do dashboard_state. Existe porque o estado é um blob único
// sobrescrito por completo a cada gravação: um cliente ruim apaga tudo de uma vez
// e sem cópia não há volta. Retenção de 30 dias, limpeza automática.
const BACKUP_PREFIX = 'backups/state-';
const BACKUP_MIN_INTERVAL = 3600;      // no máx. 1 snapshot por hora
const BACKUP_RETENTION = 30 * 86400;   // 30 dias

async function _backupState(env) {
  if (!env.MEDIA) return false;                       // sem R2 ligado, não faz nada
  const agora = Math.floor(Date.now() / 1000);
  const ultimo = Number(await _readConfig(env, 'backup_ts')) || 0;
  if (agora - ultimo < BACKUP_MIN_INTERVAL) return false;

  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  if (!row || !row.data) return false;
  // Nada mudou desde o último snapshot? Não gasta espaço à toa.
  const ultimaVer = Number(await _readConfig(env, 'backup_ver')) || -1;
  if (Number(row.version) === ultimaVer) {
    await _writeConfig(env, 'backup_ts', String(agora));  // adia a próxima checagem
    return false;
  }

  const key = `${BACKUP_PREFIX}${agora}-v${row.version}.json`;
  await env.MEDIA.put(key, row.data, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { version: String(row.version), created_at: String(agora) },
  });
  await _writeConfig(env, 'backup_ts', String(agora));
  await _writeConfig(env, 'backup_ver', String(row.version));

  // Limpeza: remove snapshots com mais de 30 dias (o timestamp está na chave)
  try {
    const lista = await env.MEDIA.list({ prefix: BACKUP_PREFIX, limit: 1000 });
    const corte = agora - BACKUP_RETENTION;
    for (const obj of (lista.objects || [])) {
      const ts = Number((obj.key.slice(BACKUP_PREFIX.length).split('-')[0]) || 0);
      if (ts && ts < corte) { try { await env.MEDIA.delete(obj.key); } catch (_) {} }
    }
  } catch (_) {}
  return true;
}

// Lista os backups disponíveis (só diretor) — pra saber o que dá pra restaurar
async function handleListBackups(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Sem permissão', 403);
  if (!env.MEDIA) return json({ backups: [] });
  const lista = await env.MEDIA.list({ prefix: BACKUP_PREFIX, limit: 1000, include: ['customMetadata'] });
  const backups = (lista.objects || []).map(o => {
    // chave: backups/state-<ts>-v<versao>.json — a versão sai da própria chave
    // (o list do R2 nem sempre devolve customMetadata)
    const resto = o.key.slice(BACKUP_PREFIX.length);
    const ts = Number(resto.split('-')[0]) || 0;
    const mv = /-v(\d+)\.json$/.exec(resto);
    return {
      key: o.key,
      created_at: ts,
      size: o.size,
      version: mv ? Number(mv[1]) : ((o.customMetadata && Number(o.customMetadata.version)) || null),
    };
  }).sort((a, b) => b.created_at - a.created_at);
  return json({ backups });
}

async function handleGetState(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const row = await env.DB.prepare(
    'SELECT data, version, updated_at, updated_by FROM dashboard_state WHERE id = 1'
  ).first();
  if (!row) return json({ data: {}, version: 0, updated_at: 0, min_version: MIN_APP_VERSION });
  let data;
  try { data = JSON.parse(row.data); } catch (e) { data = {}; }
  // min_version viaja junto pro cliente detectar sozinho que está velho e recarregar
  return json({ data, version: row.version, updated_at: row.updated_at, updated_by: row.updated_by, min_version: MIN_APP_VERSION });
}

async function handlePostState(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.data !== 'object') return err('Body inválido — esperado { data, base_version? }');

  // ── TRAVA 1: gate de versão ────────────────────────────────────────────
  // Aba antiga em cache roda a lógica de sync ANTIGA, que no conflito reenviava
  // o blob inteiro e sobrescrevia tudo (apagou 5 vendas / 4 leads / 11 chips em
  // 21/07/2026). Cliente desatualizado NÃO escreve: recebe 426 e recarrega.
  if (cmpVer(body.app_version, MIN_APP_VERSION) < 0) {
    return json({
      error: 'versao_antiga',
      message: 'Esta aba está com uma versão antiga da dash. Recarregue (Ctrl+F5) pra continuar.',
      min_version: MIN_APP_VERSION,
      your_version: body.app_version || null,
    }, 426);
  }

  // Optimistic concurrency: se cliente envia base_version, valida que não houve write desde então
  const current = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  const curVer = current?.version || 0;
  if (typeof body.base_version === 'number' && body.base_version < curVer) {
    return json({ error: 'conflict', current_version: curVer }, 409);
  }

  // ── TRAVA 2: guarda anti-apagamento em massa ───────────────────────────
  // Rede de segurança contra QUALQUER escrita (bug, aba zumbi, merge ruim) que
  // sumiria com um monte de registro de uma vez. Exclusão pontual passa normal.
  if (!body.allow_shrink && current?.data) {
    let cur = {};
    try { cur = JSON.parse(current.data); } catch (_) { cur = {}; }
    const perdas = [];
    for (const k of GUARDED_COLLECTIONS) {
      const antes = Array.isArray(cur[k]) ? cur[k].length : 0;
      const depois = Array.isArray(body.data[k]) ? body.data[k].length : 0;
      if (antes >= 10 && depois < antes) {
        const perdidos = antes - depois;
        // Barra a partir de 3 itens sumindo numa única gravação. Apagar 1 ou 2 é
        // uso normal e passa direto. Limite por PORCENTAGEM não serve: o estrago
        // de 21/07 sumiu com 5 vendas de 179 (2,8%) e teria passado batido.
        if (perdidos >= 3) perdas.push({ colecao: k, antes, depois, perdidos });
      }
    }
    if (perdas.length) {
      return json({
        error: 'perda_em_massa',
        message: 'Escrita bloqueada: apagaria muitos registros de uma vez.',
        perdas,
      }, 422);
    }
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
  // Inclui arquivados — frontend filtra conforme contexto.
  // O campo `archived` (0/1) chega serializado pro frontend decidir o que mostrar.
  // Tenta query com archived; se a coluna não existe (banco antigo), tenta fallback.
  let rows;
  try {
    rows = await env.DB.prepare(
      'SELECT id, login, name, abbr, role, color, bg, com_pct, created_at, ' +
      'COALESCE(archived, 0) AS archived, archived_at, ' +
      'CASE WHEN pwd_hash IS NOT NULL AND pwd_hash != "" THEN 1 ELSE 0 END AS has_password ' +
      'FROM users ORDER BY archived ASC, name'
    ).all();
  } catch (e) {
    // Coluna archived ainda não existe — tenta criar e refaz a query
    try {
      await env.DB.prepare('ALTER TABLE users ADD COLUMN archived INTEGER DEFAULT 0').run();
    } catch (_) {}
    try {
      await env.DB.prepare('ALTER TABLE users ADD COLUMN archived_at INTEGER').run();
    } catch (_) {}
    rows = await env.DB.prepare(
      'SELECT id, login, name, abbr, role, color, bg, com_pct, created_at, ' +
      'COALESCE(archived, 0) AS archived, archived_at, ' +
      'CASE WHEN pwd_hash IS NOT NULL AND pwd_hash != "" THEN 1 ELSE 0 END AS has_password ' +
      'FROM users ORDER BY archived ASC, name'
    ).all();
  }
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

// DELETE /api/users/:id agora ARQUIVA por padrão (soft-delete) pra preservar
// histórico de pagamentos, vendas atribuídas, etc. Se quiser hard-delete
// (apaga definitivo), passar ?hard=1 — caso de exceção, não dia-a-dia.
async function handleDeleteUser(req, env, userId) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode remover usuários', 403);
  if (userId === u.user_id) return err('Você não pode se auto-excluir', 400);

  const url = new URL(req.url);
  const hard = url.searchParams.get('hard') === '1';

  if (hard) {
    const r = await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    if (!r.meta.changes) return err('Usuário não encontrado', 404);
    try { await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run(); } catch (_) {}   // revoga sessões (corta acesso na hora)
    return json({ ok: true, action: 'deleted' });
  }

  // Soft-delete: marca como archived + zera login pra liberar pra reuso (login UNIQUE)
  // O nome/role/dados ficam intactos pra histórico continuar mostrando.
  // Tenta com archived; se coluna não existe, cria.
  try {
    const r = await env.DB.prepare(
      "UPDATE users SET archived = 1, archived_at = strftime('%s','now'), login = login || '_arch_' || strftime('%s','now') WHERE id = ?"
    ).bind(userId).run();
    if (!r.meta.changes) return err('Usuário não encontrado', 404);
  } catch (_) {
    try {await env.DB.prepare('ALTER TABLE users ADD COLUMN archived INTEGER DEFAULT 0').run();} catch (_) {}
    try {await env.DB.prepare('ALTER TABLE users ADD COLUMN archived_at INTEGER').run();} catch (_) {}
    const r = await env.DB.prepare(
      "UPDATE users SET archived = 1, archived_at = strftime('%s','now'), login = login || '_arch_' || strftime('%s','now') WHERE id = ?"
    ).bind(userId).run();
    if (!r.meta.changes) return err('Usuário não encontrado', 404);
  }
  try { await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run(); } catch (_) {}   // revoga sessões do arquivado (senão o token vive até expirar)
  return json({ ok: true, action: 'archived' });
}

// POST /api/users/:id/restore → desarquiva (admin pode reativar)
async function handleRestoreUser(req, env, userId) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode restaurar usuários', 403);
  const r = await env.DB.prepare(
    "UPDATE users SET archived = 0, archived_at = NULL WHERE id = ?"
  ).bind(userId).run();
  if (!r.meta.changes) return err('Usuário não encontrado', 404);
  return json({ ok: true, action: 'restored' });
}

// ─── Config armazenada no D1 (API keys configuráveis via UI) ──
// Tabela criada sob demanda (idempotente) — não precisa migrar manualmente.
// Apenas Diretor pode ler/escrever.
// Memoização de schema: criar tabela é idempotente e o schema não muda em runtime, então roda
// UMA vez por isolate, não a cada request/mensagem. Isso era a causa do Erro 1102 (Worker
// exceeded resource limits): um lote de 50 capturas fazia ~50x20 = 1000 subrequests só de DDL,
// estourava o limite do Cloudflare e o lote inteiro falhava — a venda não era gravada e o painel
// mostrava vermelho. Deploy novo = isolate novo = o DDL roda de novo (pega colunas novas).
let _cfgTablesOk = false, _waTablesOk = false, _scTablesOk = false, _saleTablesOk = false, _leadTablesOk = false, _attribTablesOk = false, _cpfTablesOk = false;
async function _ensureConfigTable(env) {
  if (_cfgTablesOk) return;
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)'
    ).run();
    _cfgTablesOk = true;
  } catch (_) {}
}

// dashboard_state é um blob de ~1.3 MB (tem leads/chips/pressels tudo junto). Parsear ele a cada
// lead novo / clique de pressel custava CPU demais e era a 2ª causa do Erro 1102 no pico. Aqui um
// cache curto por isolate: os caminhos quentes do backend (pixel, roteamento, seed) leem 1x a cada
// poucos segundos em vez de por evento. NÃO usar isto pra servir a tela do Diretor (ele precisa ver
// a própria edição na hora); só pra leitura de config operacional, onde 8s de atraso é invisível.
let _dashCache = null, _dashCacheT = 0;
async function _getDashData(env, maxAgeMs) {
  const now = Date.now();
  if (_dashCache && (now - _dashCacheT) < (maxAgeMs || 8000)) return _dashCache;
  try {
    const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
    _dashCache = JSON.parse(row?.data || '{}');
    _dashCacheT = now;
  } catch (_) { if (!_dashCache) _dashCache = {}; }
  return _dashCache;
}
// Lê uma config do D1. Retorna null se não setada.
async function _readConfig(env, key) {
  await _ensureConfigTable(env);
  try {
    const row = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?').bind(key).first();
    return row?.value || null;
  } catch (_) { return null; }
}

// Salva uma config no D1. Se value vazio, deleta.
async function _writeConfig(env, key, value) {
  await _ensureConfigTable(env);
  if (!value) {
    await env.DB.prepare('DELETE FROM app_config WHERE key = ?').bind(key).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value).run();
}

// Resolve qual API key usar pra um provider. Preferência:
//   1. Config no D1 (configurado via UI da Dashboard)
//   2. Secret do Worker (configurado via `wrangler secret put`)
async function getAIKey(env, provider) {
  const dbKey = await _readConfig(env, `ai_${provider}_key`);
  if (dbKey) return dbKey;
  if (provider === 'gemini' && env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  if (provider === 'anthropic' && env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  return null;
}

// GET /api/config/ai-keys → status das keys (sem expor o valor)
async function handleAIConfigGet(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode ver config de IA', 403);

  const geminiDb = await _readConfig(env, 'ai_gemini_key');
  const anthropicDb = await _readConfig(env, 'ai_anthropic_key');

  // Mascara a key (mostra primeiros 8 + últimos 4, se for grande o bastante)
  // Pra keys curtas, mostra só prefixo pra evitar exposição/sobreposição
  const mask = k => {
    if (!k) return null;
    if (k.length < 16) return k.slice(0, 3) + '…' + '*'.repeat(Math.max(0, k.length - 3));
    return `${k.slice(0, 8)}…${k.slice(-4)}`;
  };

  return json({
    gemini: {
      configured: !!(geminiDb || env.GEMINI_API_KEY),
      source: geminiDb ? 'dashboard' : (env.GEMINI_API_KEY ? 'secret' : null),
      preview: mask(geminiDb || env.GEMINI_API_KEY),
    },
    anthropic: {
      configured: !!(anthropicDb || env.ANTHROPIC_API_KEY),
      source: anthropicDb ? 'dashboard' : (env.ANTHROPIC_API_KEY ? 'secret' : null),
      preview: mask(anthropicDb || env.ANTHROPIC_API_KEY),
    },
  });
}

// POST /api/config/ai-keys → salva uma ou mais keys
async function handleAIConfigSet(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode mudar config de IA', 403);

  const body = await req.json().catch(() => null);
  if (!body) return err('Body inválido');

  // Aceita { gemini_key, anthropic_key } — qualquer um pode vir
  if (body.gemini_key !== undefined) {
    const k = String(body.gemini_key || '').trim();
    // Validação básica formato Gemini (AIza...)
    if (k && !k.startsWith('AIza') && k.length < 30) {
      return err('Key do Gemini parece inválida (deve começar com "AIza")');
    }
    await _writeConfig(env, 'ai_gemini_key', k);
  }
  if (body.anthropic_key !== undefined) {
    const k = String(body.anthropic_key || '').trim();
    if (k && !k.startsWith('sk-ant-')) {
      return err('Key do Anthropic parece inválida (deve começar com "sk-ant-")');
    }
    await _writeConfig(env, 'ai_anthropic_key', k);
  }

  return json({ ok: true });
}

// POST /api/config/ai-keys/test → faz uma chamada teste pra validar a key
async function handleAIConfigTest(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode testar IA', 403);

  const body = await req.json().catch(() => ({}));
  const provider = body.provider || 'gemini';
  const key = await getAIKey(env, provider);
  if (!key) return err(`${provider} não configurado`, 400);

  // Chamada mínima — uma única palavra de resposta
  try {
    if (provider === 'gemini') {
      // Tenta cada modelo até um responder OK. Se TODOS derem 429, dá mensagem clara.
      const triedErrors = [];
      for (const model of GEMINI_MODELS) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Responda apenas "ok" sem nada mais.' }] }],
            generationConfig: { maxOutputTokens: 8 },
          }),
        });
        if (r.ok) {
          const data = await r.json();
          const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          return json({ ok: true, provider, model, response: txt.trim() });
        }
        const t = await r.text().catch(() => '');
        triedErrors.push({ model, status: r.status });
        // 429/403/404 = tenta o próximo. Outros = erro fatal.
        if (r.status === 400 && t.includes('API_KEY_INVALID')) {
          return err(`API key inválida. Gere uma nova em aistudio.google.com/apikey`, 400);
        }
        if (![429, 403, 404].includes(r.status)) {
          return err(`Teste falhou (${r.status}): ${t.slice(0, 200)}`, 502);
        }
      }
      // Todos os modelos retornaram quota/permission
      const tries = triedErrors.map(e => `${e.model} (${e.status})`).join(' · ');
      return err(`Todos os modelos Gemini esgotaram quota ou bloquearam. Tentei: ${tries}. Soluções: (1) aguarde 1-2 min e teste de novo (rate limit) · (2) habilite billing em console.cloud.google.com → Billing (gratuito dentro do free tier) · (3) gere nova API key em aistudio.google.com/apikey.`, 429);
    }
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Responda apenas "ok".' }],
        }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return err(`Teste falhou (${r.status}): ${t.slice(0, 200)}`, 502);
      }
      const data = await r.json();
      return json({ ok: true, provider, response: (data.content?.[0]?.text || '').trim() });
    }
    return err('Provider desconhecido');
  } catch (e) {
    return err('Teste falhou: ' + e.message, 502);
  }
}

// ─── AI: Gerador de copy ───────────────────────────────────────
// Endpoint: POST /api/ai/generate-copy
// Body: { persona, dor, gancho, angulo, duracao, estrutura, dna_vencedores, contexto }
// Retorno: { blocos: { hook, cena_vida, ... }, usage, model, provider }
//
// PROVIDERS (escolhe automático na ordem):
//   1. GEMINI_API_KEY  — Google AI Studio, free tier 1500 req/dia (RECOMENDADO)
//   2. ANTHROPIC_API_KEY — Anthropic, paga por uso (fallback)
//
// Setup do Gemini (gratuito, sem cartão):
//   1. https://aistudio.google.com/apikey → login Google → Create API Key
//   2. cd backend && npx wrangler secret put GEMINI_API_KEY
//   3. npx wrangler deploy

// Constrói os prompts compartilhados entre os providers
function _aiBuildPrompts(payload) {
  const { persona, dor, gancho, angulo, duracao, estrutura, dna_vencedores, contexto } = payload;
  const blocosNomes = estrutura.map(b => `[${b.t}] ${b.l} (chave: ${b.k})`).join('\n');
  const dnaTexto = (dna_vencedores && dna_vencedores.length)
    ? `\n\nDNA — CRIATIVOS VENCEDORES JÁ TESTADOS (use como referência de tom, NÃO copie literalmente):\n${dna_vencedores.slice(0, 3).map((d, i) => `--- VENCEDOR ${i+1} ---\n${d}`).join('\n\n')}`
    : '';

  const system = `Você é o melhor copywriter de anúncios para TikTok Ads no nicho de SAÚDE/BEM-ESTAR (controle de açúcar no sangue, energia, vitalidade) pra público brasileiro 40+, modelo COD (paga na entrega). Você escreve no formato VSL-ANÚNCIO das copys CAMPEÃS já validadas: copy LONGA, narrada em primeira pessoa por uma PERSONA com nome e profissão humilde, que converte dentro do próprio anúncio e joga o lead direto no WhatsApp.

O QUE FAZ A COPY CAMPEÃ CONVERTER (siga a função de cada bloco da estrutura pedida):
- GANCHO DE RUPTURA: quebra de padrão ("vou quebrar meu silêncio", "abre o olho antes que seja tarde", "cansei de ver homem sofrendo calado") + um "truque/segredo de 10 segundos" + a humilhação que isso resolveu + um resultado mensurável + prazo curto.
- PERSONA HONESTA (credibilidade): nome + profissão humilde (caminhoneiro, lavrador, costureira) + vida de honestidade e palavra dada + "não preciso de fama nem de like" + "você acha que eu ia queimar o meu nome pra te enganar?" + "não quero o teu dinheiro, mas você precisa dessa verdade" + "me dá 3 dias".
- GARANTIA-DESAFIO: "se em 3 dias [sintoma 1], [sintoma 2] e [sintoma 3] não melhorarem, pode me chamar de mentiroso na praça pública".
- AGITAÇÃO/HUMILHAÇÃO: a verdade é dura, a doença acabando com a pessoa por dentro, uma CENA íntima de vergonha vivida calado (ex: não dar conta na cama e virar de costas fingindo que dorme), "isso não é vida, isso é o desmanche do homem/mulher".
- VILÃO/INIMIGO: médico de jaleco, fortuna em consulta, remédio de farmácia = "conversa pra boi dormir", "você vira refém", "não resolve, só te amarra". A indústria lucra com você doente.
- VIRADA/MENTOR: um amigo(a) de infância sentou e falou na lata ("larga de ser burro, você tá na mão da indústria, o que falta é regular o organismo de forma natural"), me entregou "o mapa da mina", "o protocolo que o alto escalão usa em segredo": é o PRODUTO (natural, faz em casa sem ninguém saber).
- PROVA PESSOAL: testei com meus próprios olhos, e o resultado (foco no benefício mais desejado da persona, ex: "a patroa foi quem mais agradeceu", "voltei a dormir a noite inteira", "voltei a enxergar o rosto dos netos").
- DESINTERESSE + PROVA SOCIAL: "não tô aqui pra te vender nada, tô passando adiante como recebi", não é química cara pra te prender todo mês, resolveu a vida de um monte de gente que sofria calada.
- CTA + IDENTIDADE: "se você quer saber o que [mentor] me revelou... clica aqui embaixo, me chama no WhatsApp" + "faz isso por você, faz isso pela tua mulher/família" + soco de identidade ("homem que é homem não aceita viver na sombra de uma doença. Homem resolve" / "Mulher resolve").

REGRAS ABSOLUTAS:
1. Tom 100% coloquial e REGIONAL brasileiro, visceral, de quem senta do teu lado e conta a real ("tava", "tô", "pra", "meu amigo", "companheiro", "a patroa", "o maridão", "rapaz").
2. Copy LONGA: cada bloco com 2 a 5 frases de verdade. É uma VSL falada, não um post curto.
3. PALAVRAS PROIBIDAS (compliance TikTok) — NUNCA use, nem entre aspas:
   - "diabetes", "diabético" → "açúcar alto", "açúcar no sangue"
   - "metformina", "glibenclamida", "insulina" → "remédio que o médico passa", "comprimido", "injeção"
   - "cura", "curado" → "melhora", "transformação"
   - "disfunção erétil", "impotência", "ereção" → "fraqueza lá embaixo", "firmeza", "o motor"
   - "milagre" → "transformação"
4. COD: deixe claro que paga só na entrega ("você só paga quando o produto chegar na sua porta, sem cartão, sem PIX antes").
5. A persona define o tom: caminhoneiro fala diferente de vovó, dona de casa diferente de pedreiro. Adapte a cena de humilhação ao gênero da persona.
6. Gancho WHITE: não precisa cravar a doença no primeiro segundo — fale por sintoma e sensação.

LINGUAGEM DO PÚBLICO (idoso, interior, pouca escola) — INEGOCIÁVEL:
- Use SÓ palavra simples do dia a dia. Se a vó de 70 anos no interior não usa, você não escreve. Nada de palavra difícil, técnica ou bonita demais.
- PROIBIDO frase "meta"/explicativa tipo "no sentido literal", "metaforicamente", "por assim dizer", "literalmente". Fale direto, como gente conversando.
- PROIBIDO palavra genérica de IA ("jornada", "transformação incrível", "bem-estar pleno", "qualidade de vida", "potencializar"). Fale concreto e visual: "voltei a subir a escada sem parar", "voltei a dormir a noite toda", "voltei a enxergar o rosto do meu neto".
- Frase curta. Como se tivesse sentado na cozinha contando pra um amigo.

VARIEDADE OBRIGATÓRIA (cada copy tem que parecer uma PESSOA DIFERENTE):
- NÃO abra sempre com "Companheiro". Varie muito o começo: às vezes um vocativo ("Meu amigo", "Ô", "Olha", "Minha gente", "Escuta uma coisa"), às vezes JÁ entra na história sem vocativo nenhum.
- NÃO repita as mesmas muletas em toda copy. Expressões como "mapa da mina", "conversa pra boi dormir", "alto escalão", "homem resolve" são exemplos de UMA forma — cada persona inventa a SUA. Use sinônimos e jeitos de falar diferentes pra mesma ideia.
- Varie a forma de revelar o produto, de criticar o remédio e de fechar com identidade. Duas copys NUNCA podem ter as mesmas frases.
- O resultado: a pessoa que vê vários anúncios NÃO percebe que é a mesma fórmula trocando o nome. Cada uma soa como outra pessoa de verdade, com outro vocabulário e outro ritmo, mas todas batem na mesma dor.

RETORNE APENAS JSON VÁLIDO, sem markdown, sem comentários antes ou depois. Uma chave por bloco da estrutura, exatamente as chaves pedidas.`;

  const user = `Escreva uma copy de anúncio (VSL-anúncio) com estes parâmetros:

PERSONA (quem narra): ${persona || 'genérica'}
DOR / EIXO: ${dor || 'geral'}
ÂNGULO: ${angulo || 'história pessoal'}
${gancho ? `INSPIRAÇÃO DE ABERTURA: ${gancho}` : ''}
${contexto ? `PRODUTO/OFERTA: ${contexto}` : ''}

ESTRUTURA OBRIGATÓRIA (use exatamente essas chaves no JSON, nessa ordem):
${blocosNomes}
${dnaTexto}

EXEMPLO DE QUALIDADE E TOM (copy campeã real — NÃO copie, só absorva o estilo e o ritmo):

"Eu cansei de ver homem bom sendo destruído por dentro em silêncio. Esse truque de 10 segundos me tirou da vergonha de falhar com a minha mulher por causa do açúcar no sangue e fez o açúcar despencar logo nos primeiros dias. Companheiro, meu nome é Valdir, rodei 35 anos dirigindo ônibus por esse Brasil, criei minha família na palavra dada. Você acha que eu ia jogar o meu nome no lixo pra te empurrar mentira? Não quero o teu dinheiro, mas você precisa dessa verdade. Me dá 3 dias. Se em 3 dias o teu açúcar não despencar, se você não parar de correr pro banheiro toda noite, pode me chamar de mentiroso na praça pública. A verdade é dura: o açúcar alto vai castrando o homem por dentro, e eu passei por essa humilhação. Os médicos de jaleco, fortuna em consulta, comprimido todo dia... conversa pra boi dormir, você só vira refém. Até que o João sentou comigo e falou na lata: larga de ser burro, você tá na mão da indústria. Me entregou o mapa da mina, o protocolo que o alto escalão usa em segredo: o [PRODUTO]. Testei, e a patroa foi quem mais agradeceu. Não tô aqui pra te vender nada, tô passando adiante. Se você quer saber o que o João me revelou, clica aqui embaixo, me chama no WhatsApp. Faz isso pela tua mulher. Homem que é homem não aceita viver na sombra de uma doença. Homem resolve."

Agora ESCREVA o JSON, cada bloco no tom acima — longo, visceral, em primeira pessoa, na voz da persona. SÓ o JSON puro.`;

  return { system, user };
}

// Extrai JSON da resposta de IA (tolerante a fence markdown ```json ... ```)
function _aiParseJSON(txt) {
  let s = String(txt || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) s = fenced[1].trim();
  // Se ainda tem texto antes/depois do primeiro {, tenta isolar
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace > -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(s);
}

// ─── Provider: Gemini (Google AI Studio) ───
// Tenta modelos em cascata. Se um der 429 (quota), tenta o próximo.
// Ordem: do mais novo/melhor pro mais estável/generoso no free tier.
const GEMINI_MODELS = [
  'gemini-2.5-flash',         // 10 RPM, 250 RPD free tier
  'gemini-2.0-flash-exp',     // Experimental, free tier separado
  'gemini-2.0-flash',         // GA, pode pedir billing
  'gemini-1.5-flash',         // 15 RPM, 1500 RPD — mais generoso, estável
  'gemini-1.5-flash-8b',      // ainda mais barato, free tier maior
];

async function _callGeminiModel(env, prompts, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    system_instruction: { parts: [{ text: prompts.system }] },
    contents: [{ role: 'user', parts: [{ text: prompts.user }] }],
    generationConfig: {
      temperature: 1.05,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    },
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const err = new Error(`Gemini ${model} ${r.status}: ${t.slice(0, 300)}`);
    err.status = r.status;
    err.modelTried = model;
    throw err;
  }
  const data = await r.json();
  const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return {
    blocos: _aiParseJSON(txt),
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
    model,
    provider: 'gemini',
  };
}

async function _callGemini(env, prompts) {
  // Tenta cada modelo em sequência. 429 / 403 / 404 = pula pro próximo.
  // Outros erros (500, JSON inválido) = retorna o erro.
  const triedErrors = [];
  for (const model of GEMINI_MODELS) {
    try {
      return await _callGeminiModel(env, prompts, model);
    } catch (e) {
      const isQuota = e.status === 429;
      const isPerm = e.status === 403;
      const isNotFound = e.status === 404;
      const isBadModel = e.message.includes('not found') || e.message.includes('does not exist');
      triedErrors.push({ model, status: e.status, msg: e.message.slice(0, 150) });
      // Esses erros = modelo indisponível → tenta o próximo
      if (isQuota || isPerm || isNotFound || isBadModel) continue;
      // Outros = erro real, retorna
      throw e;
    }
  }
  // Todos falharam por quota/permissão — agrega
  throw new Error(`Todos os modelos Gemini falharam. Tentei ${triedErrors.length}: ${triedErrors.map(t=>`${t.model} (${t.status})`).join(' · ')}. Verifique a key, billing e quotas.`);
}


// ─── Provider: Anthropic (Claude) ───
async function _callAnthropic(env, prompts) {
  const model = 'claude-haiku-4-5';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 1,
      system: prompts.system,
      messages: [{ role: 'user', content: prompts.user }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const txt = data.content?.[0]?.text || '';
  return {
    blocos: _aiParseJSON(txt),
    usage: data.usage || null,
    model: data.model || model,
    provider: 'anthropic',
  };
}

async function handleAIGenerateCopy(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);

  // Busca keys preferindo D1 (configurado via UI) → env (wrangler secret)
  const geminiKey = await getAIKey(env, 'gemini');
  const anthropicKey = await getAIKey(env, 'anthropic');

  if (!geminiKey && !anthropicKey) {
    return err('IA não configurada. Diretor: acesse Configurações → Integrações → IA e cole sua API key do Gemini (grátis em aistudio.google.com/apikey).', 503);
  }

  const body = await req.json().catch(() => null);
  if (!body) return err('Body inválido');
  if (!body.estrutura || !Array.isArray(body.estrutura) || !body.estrutura.length) {
    return err('Campo "estrutura" obrigatório (array de blocos)');
  }

  const prompts = _aiBuildPrompts(body);
  // Patch env temporário pra _callGemini/_callAnthropic continuarem funcionando
  const envWithKeys = { ...env, GEMINI_API_KEY: geminiKey, ANTHROPIC_API_KEY: anthropicKey };

  try {
    if (geminiKey) {
      const result = await _callGemini(envWithKeys, prompts);
      return json({ ok: true, ...result });
    }
    if (anthropicKey) {
      const result = await _callAnthropic(envWithKeys, prompts);
      return json({ ok: true, ...result });
    }
  } catch (e) {
    if (geminiKey && anthropicKey) {
      try {
        const result = await _callAnthropic(envWithKeys, prompts);
        return json({ ok: true, ...result, fallback: true });
      } catch (e2) {
        return err(`Ambos providers falharam. Gemini: ${e.message} · Anthropic: ${e2.message}`, 502);
      }
    }
    return err(`IA falhou: ${e.message}`, 502);
  }
}

// ─── PAYT WEBHOOK ─────────────────────────────────────────────
// PAYT envia POST com {event, order:{customer:{...}, ...}}
// URL: /webhook/payt/<chave>
// Validamos a chave, encontramos/criamos o lead, aplicamos o mapeamento
// configurado em DB.payt_mapping (que vive no state blob), persistimos.

const norm = s => String(s || '').replace(/\D/g, '');

// Mapeia evento+status real da PAYT pra chave de mapeamento usada na Dash.
// PAYT envia algo tipo {event:"new_order", order:{status:"confirmed", payment_modality:"on_delivery"}}
// e nossa Dash tem keys como "aguardando_pagamento","finalizada","cancelada", etc.
function mapPaytEvent(eventRaw, status, modality) {
  const e = String(eventRaw || '').toLowerCase();
  const s = String(status || '').toLowerCase();
  const m = String(modality || '').toLowerCase();
  const isCOD = m.includes('on_delivery') || m.includes('cod') || m.includes('apos_receber') || m.includes('entrega');

  // Se já vier com chave canônica (legacy/manual), passa direto
  const known = ['aguardando_pagamento','finalizada','faturada','cancelada','cancelada_chargeback',
    'cancelada_reembolsada','abandono_checkout','entrega_atualizada','solicitacao_reembolso',
    'pagamento_expirado','aguardando_confirmacao','pedido_confirmado','pedido_frustrado'];
  if (known.includes(e)) return e;

  // Mapeamento por status (mais específico) — inclui os status reais do Payt V1
  if (s === 'pending' || s === 'awaiting_payment' || s === 'waiting_payment') return 'aguardando_pagamento';
  if (s === 'paid')        return 'finalizada';
  if (s === 'billed')      return 'faturada';
  if (s === 'lost_cart')   return 'abandono_checkout';
  if (s === 'separation' || s === 'shipped') return 'entrega_atualizada';
  if (s === 'confirmed')   return isCOD ? 'aguardando_confirmacao' : 'finalizada';
  if (s === 'canceled' || s === 'cancelled') return 'cancelada';
  if (s === 'refunded')    return 'cancelada_reembolsada';
  if (s === 'chargeback' || s === 'charged_back') return 'cancelada_chargeback';
  if (s === 'expired')     return 'pagamento_expirado';
  if (s === 'delivered')   return 'pedido_confirmado';
  if (s === 'returned' || s === 'frustrated' || s === 'failed') return 'pedido_frustrado';
  if (s === 'abandoned')   return 'abandono_checkout';

  // Mapeamento por event (fallback)
  if (e === 'new_order')         return isCOD ? 'aguardando_confirmacao' : 'aguardando_pagamento';
  if (e === 'order_paid')        return 'finalizada';
  if (e === 'order_canceled')    return 'cancelada';
  if (e === 'order_refunded')    return 'cancelada_reembolsada';
  if (e === 'order_chargeback')  return 'cancelada_chargeback';
  if (e === 'order_delivered')   return 'pedido_confirmado';
  if (e === 'order_expired')     return 'pagamento_expirado';
  if (e === 'checkout_abandoned')return 'abandono_checkout';
  if (e === 'tracking_updated' || e === 'shipping_updated') return 'entrega_atualizada';

  return e || 'unknown';
}

// Extrai dados do payload PAYT (formato real + variações legadas)
function extractPaytData(body) {
  const order = body?.order || body?.pedido || body || {};
  // PAYT real: client_* direto no order, address como objeto separado
  const address = order.address || order.endereco || {};
  // Legacy: customer/cliente como objeto
  const customer = order.customer || order.cliente || body?.customer || body?.cliente || {};

  // ─── Payt V1 real: objeto transaction (valores em CENTAVOS) + commission[] ───
  const tx = body?.transaction || {};
  const commArr = Array.isArray(body?.commission) ? body.commission : [];
  const aff = commArr.find(c => ['affiliation','affiliate','afiliado'].includes(String(c?.type || '').toLowerCase()));
  // Endereço V1 vem em customer.billing_address ou shipping.address
  const v1addr = (body?.shipping && body.shipping.address) || customer.billing_address || {};

  const eventRaw = String(body?.event || body?.evento || body?.tipo || '').toLowerCase();
  // status real: transaction.payment_status ou status na raiz
  const status = tx.payment_status || order.status || body?.status || '';
  const modality = order.payment_modality || order.modalidade_pagamento || (body?.type === 'cash_on_delivery' ? 'on_delivery' : '') || '';
  const event = mapPaytEvent(eventRaw, status, modality);

  // Valor bruto: Payt V1 manda transaction.total_price em CENTAVOS
  const amount = tx.total_price != null
    ? Number(tx.total_price) / 100
    : Number(order.total_amount || order.amount || order.valor || order.total || body?.amount || body?.valor || 0);
  // Comissão REAL do afiliado (centavos → reais). null se não veio.
  const comiss_real = aff ? Number(aff.amount) / 100 : null;

  return {
    event,           // chave canônica usada no payt_mapping
    event_raw: eventRaw,
    status,
    modality,
    // dedup: transaction_id é o id único do pedido no Payt V1
    order_id: body?.transaction_id || order.id || order.order_id || body?.id || body?.pedido_id || '',
    name: customer.name || order.client_name || customer.nome || '',
    email: customer.email || order.client_email || '',
    phone: customer.phone || order.client_whatsapp || order.client_phone || customer.telefone || customer.whatsapp || customer.celular || '',
    cpf: customer.doc || order.cpf || order.client_cpf || customer.cpf || customer.document || customer.documento || '',
    amount,
    comiss_real,
    paid_at: tx.paid_at || '',
    product: body?.product?.name || body?.link?.title || body?.treatment?.name || order.treatment?.name || order.product || order.produto || (Array.isArray(order.products) ? order.products[0]?.name : '') || '',
    sku: body?.product?.sku || '',
    payment_method: tx.payment_method || order.payment_method || order.metodo_pagamento || '',
    tracking_code: order.tracking_code || '',
    brand: order.brand || '',
    seller_id: body?.seller_id || body?.seller?.id || '',
    seller_name: body?.seller?.name || '',
    // Endereço estruturado
    cep: v1addr.zipcode || address.cep || address.zipcode || customer.zipcode || customer.cep || '',
    street: v1addr.street || address.street || address.endereco || customer.endereco || '',
    number: v1addr.street_number || address.number || address.numero || '',
    complement: v1addr.complement || address.complement || address.complemento || '',
    neighborhood: v1addr.district || address.neighborhood || address.bairro || '',
    city: v1addr.city || address.city || customer.city || '',
    state: v1addr.state || address.state || customer.state || customer.uf || '',
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

// ─── Ponte CPF → atendente ────────────────────────────────────────────────
// A Evolution já sabe QUEM atendeu (a instância ax_<at>) no momento em que a
// venda é marcada como concluída no WhatsApp; e a mensagem "Pedido Concluído"
// traz o CPF do cliente. Gravamos CPF → atendente ali. Quando a venda cai na
// Payt (que só tem o CPF), ela atribui sozinha ao vendedor certo.

// instância Evolution (ax_<at> / ax_<at>_b) → id do atendente no time
function _instToAt(instance) {
  return String(instance || '').replace(/^ax_/, '').replace(/_b$/, '');
}

// Extrai um CPF (11 dígitos) de texto livre: tenta o rótulo "CPF:" primeiro,
// depois o formato pontuado, e por fim qualquer sequência isolada de 11 dígitos.
function extractCpf(text) {
  const t = String(text || '');
  let m = t.match(/CPF[^0-9]{0,8}(\d{3}\D?\d{3}\D?\d{3}\D?\d{2})/i);
  if (!m) m = t.match(/\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b/);
  if (!m) m = t.match(/(?:^|[^\d])(\d{11})(?:[^\d]|$)/);
  const digits = m ? m[1].replace(/\D/g, '') : '';
  return digits.length === 11 ? digits : '';
}

// Grava/atualiza a ligação CPF → atendente (chave: CPF só dígitos). Upsert idempotente.
async function saveCpfAttrib(env, cpf, instance, name, phone) {
  const c = norm(cpf);
  if (c.length !== 11) return;
  try {
    if (!_cpfTablesOk) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS cpf_attrib (cpf TEXT PRIMARY KEY, at_id TEXT, instance TEXT, name TEXT, phone TEXT, updated_at INTEGER)').run(); _cpfTablesOk = true; }
    await env.DB.prepare(
      `INSERT INTO cpf_attrib (cpf, at_id, instance, name, phone, updated_at) VALUES (?,?,?,?,?,strftime('%s','now'))
       ON CONFLICT(cpf) DO UPDATE SET at_id=excluded.at_id, instance=excluded.instance,
         name=COALESCE(NULLIF(excluded.name,''), cpf_attrib.name), phone=excluded.phone, updated_at=excluded.updated_at`
    ).bind(c, _instToAt(instance), String(instance || ''), String(name || ''), String(phone || '')).run();
  } catch (_) {}
}

// Resolve o atendente responsável por um CPF. Retorna o id do time ou null.
async function resolveAtByCpf(env, cpf) {
  const c = norm(cpf);
  if (c.length !== 11) return null;
  try {
    const row = await env.DB.prepare('SELECT at_id FROM cpf_attrib WHERE cpf = ?').bind(c).first();
    const at = row && row.at_id ? String(row.at_id).trim() : '';
    return at || null;
  } catch (_) { return null; }
}

// Fallback: resolve o atendente pelo TELEFONE do cliente. O rastreio de atendimento
// (wa_attrib = inbound WhatsApp, wa_lead = clique da pressel) guarda telefone → instância
// ax_<at>. Cobre ~90% dos pedidos recentes que passaram pelo WhatsApp. Casa pelos
// últimos 8 dígitos pra ser robusto ao 55/DDD/9º dígito; pega o registro mais recente.
async function resolveAtByPhone(env, phone) {
  const d = norm(phone);
  if (d.length < 8) return null;
  const like = '%' + d.slice(-8);
  try {
    let row = await env.DB.prepare("SELECT instance FROM wa_attrib WHERE phone LIKE ? ORDER BY rowid DESC LIMIT 1").bind(like).first();
    if (!row) row = await env.DB.prepare("SELECT inst AS instance FROM wa_lead WHERE phone LIKE ? ORDER BY ts DESC LIMIT 1").bind(like).first();
    const at = _instToAt(row && row.instance ? String(row.instance) : '');
    return at || null;
  } catch (_) { return null; }
}

function todayBR() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
}
function nowTimeBR() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// Grava dashboard_state com concorrência otimista (compare-and-swap por version).
// Retorna true se gravou; false se a versão mudou no meio (o chamador deve reler e
// reprocessar). Usado pelos webhooks, que faziam read-modify-write no blob e antes
// se sobrescreviam entre si (lost update: lead criado/pago sumia do banco).
async function _casState(env, curVer, state, who) {
  const now = Math.floor(Date.now() / 1000);
  if (!curVer) {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, 1, ?, ?)`
    ).bind(JSON.stringify(state), now, who).run();
    return !!(r.meta && r.meta.changes);
  }
  const r = await env.DB.prepare(
    `UPDATE dashboard_state SET data = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = 1 AND version = ?`
  ).bind(JSON.stringify(state), curVer + 1, now, who, curVer).run();
  return !!(r.meta && r.meta.changes);
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

  // Reprocessa com concorrência otimista: se outro write (webhook/dash) gravar no
  // meio, relê o state fresco e reaplica. Antes o write era incondicional e dois
  // webhooks concorrentes se sobrescreviam (lost update / lead sumia).
  for (let _attempt = 0; _attempt < 6; _attempt++) {
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

  // ─── DEBUG TEMPORÁRIO: captura o payload cru pra mapear o formato real da Payt ───
  // Guarda os últimos 20 payloads completos em state.payt_debug. Não altera leads/vendas.
  state.payt_debug = state.payt_debug || [];
  state.payt_debug.unshift({
    ts: Math.floor(Date.now() / 1000),
    event: data.event, event_raw: data.event_raw, status: data.status,
    test: !!(body && body.test), order_id: data.order_id || '',
    body,
  });
  state.payt_debug = state.payt_debug.slice(0, 20);
  // Payload de teste (botão "Testar URL" da Payt): só captura, não cria lead/venda.
  if (body && body.test === true) {
    const tVer = curVer + 1, tNow = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(JSON.stringify(state), tVer, tNow, 'payt-webhook-test').run();
    return json({ ok: true, test: true, captured: true, event_mapped: data.event });
  }

  const mapping = (state.payt_mapping || {})[data.event];

  // Encontra lead existente
  let lead = findLead(state.leads, data);
  let action_taken = '';
  let lead_id_result = null;
  let resolvedLead = null;
  // Atribuição automática: quem atendeu esse cliente. Tenta pelo CPF (mais preciso,
  // capturado na venda concluída do WhatsApp) e, se não achar, pelo TELEFONE
  // (rastreio de atendimento wa_attrib/wa_lead) — que cobre a maioria dos pedidos.
  const attribAt = (data.cpf ? await resolveAtByCpf(env, data.cpf) : null)
    || (data.phone ? await resolveAtByPhone(env, data.phone) : null);

  // Detecta modalidade COD baseado no payload
  const isCOD = data.modality && (
    data.modality.toLowerCase().includes('on_delivery') ||
    data.modality.toLowerCase().includes('cod') ||
    data.modality.toLowerCase().includes('apos_receber') ||
    data.modality.toLowerCase().includes('entrega')
  );

  if (lead) {
    // Aplica mapeamento sobre lead existente
    const prev = lead.col;
    // Backfill do atendente: se o lead ainda não tem dono e a ponte CPF conhece quem
    // atendeu, atribui agora (não sobrescreve atribuição manual já existente).
    if (!lead.at && attribAt) lead.at = attribAt;
    if (mapping?.etapa) lead.col = mapping.etapa;
    if (mapping?.spg) lead.spg = mapping.spg;
    if (mapping?.action === 'tag' && mapping.tag) {
      lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
      if (!lead.tags.includes(mapping.tag)) lead.tags.push(mapping.tag);
    }
    // Atualiza dados do lead com info nova vinda da PAYT (se chegou)
    if (data.tracking_code && !lead.track) lead.track = data.tracking_code;
    if (data.payment_method && !lead.pgto) lead.pgto = data.payment_method;
    if (data.amount && !lead.vl) lead.vl = data.amount;
    // Histórico do lead
    lead.hist = Array.isArray(lead.hist) ? lead.hist : [];
    lead.hist.push({
      from: prev,
      to: lead.col,
      who: 'payt',
      time: `${todayBR()} ${nowTimeBR()}`,
      note: `PAYT: ${data.event_raw||data.event} (${data.status||'-'})`,
    });
    action_taken = 'updated';
    lead_id_result = lead.id;
    resolvedLead = lead;
  } else if (mapping || ['aguardando_pagamento','aguardando_confirmacao','finalizada'].includes(data.event)) {
    // Cria lead novo se evento for de início de pedido
    state.nextLead = state.nextLead || 1;
    const newLead = {
      id: state.nextLead++,
      external_id: data.order_id,
      nome: data.name || '(sem nome)',
      cpf: data.cpf || '',
      wa: data.phone || '',
      email: data.email || '',
      cep: data.cep || '',
      end: data.street || '',
      num: data.number || '',
      comp: data.complement || '',
      bairro: data.neighborhood || '',
      cidade: data.city || '',
      uf: data.state || '',
      data: todayBR(),
      orig: 'PAYT',
      prod: data.product || '',
      trat: data.product || '',
      vl: data.amount || 0,
      com_pct: 12,
      track: data.tracking_code || '',
      pgto: data.payment_method || '',
      spg: mapping?.spg || 'Pendente',
      mod: isCOD ? 'entrega' : 'antecipado',
      at: attribAt,
      col: mapping?.etapa || (isCOD ? 'A Enviar' : 'A Enviar'),
      obs: `Pedido PAYT ${data.order_id}${data.brand?` · brand: ${data.brand}`:''}${data.seller_name?` · seller: ${data.seller_name}`:''}`,
      link: '',
      tags: mapping?.action === 'tag' && mapping.tag ? [mapping.tag, 'payt'] : ['payt'],
      fu: null,
      hist: [{
        from: '—',
        to: mapping?.etapa || 'A Enviar',
        who: 'payt',
        time: `${todayBR()} ${nowTimeBR()}`,
        note: `Pedido criado via PAYT: ${data.event_raw||data.event} (${data.status||'-'})`,
      }],
      comments: [],
    };
    state.leads.unshift(newLead);
    action_taken = 'created';
    lead_id_result = newLead.id;
    resolvedLead = newLead;
  } else {
    action_taken = 'skipped';
  }

  // ─── VENDA REAL (Payt V1) — comissão líquida do afiliado, dedup por transaction_id ───
  // Só grava receita de venda PAGA e SÓ com a comissão real do postback (nunca estimativa).
  // Estorno/chargeback/reembolso/expiração tira a venda da receita (status 'estornado').
  state.vendas = state.vendas || [];
  const _paytId = data.order_id || '';
  const _paidEvt = (mapping && mapping.action === 'pagar') ||
    ['finalizada','faturada','pedido_confirmado'].includes(data.event);
  const _revEvt = ['cancelada','cancelada_reembolsada','cancelada_chargeback',
    'pagamento_expirado','pedido_frustrado'].includes(data.event);
  if (_paytId) {
    const _vi = state.vendas.findIndex(v => v.payt_id === _paytId);
    if (_paidEvt && data.comiss_real != null) {
      const _p = (data.paid_at || '').slice(0, 10);
      const _ddmm = (_p && _p[4] === '-') ? (_p.slice(8, 10) + '/' + _p.slice(5, 7)) : todayBR().slice(0, 5);
      const _venda = {
        id: _vi >= 0 ? state.vendas[_vi].id : Date.now(),
        payt_id: _paytId,
        leadId: resolvedLead ? resolvedLead.id : null,
        nome: data.name || (resolvedLead && resolvedLead.nome) || '',
        cpf: data.cpf || '',
        prod: data.product || '',
        sku: data.sku || '',
        vl: data.amount || 0,
        custo: 0, com_pct: 0,
        comiss: data.comiss_real,
        lucro: data.comiss_real,
        status: 'confirmado',
        at: (resolvedLead && resolvedLead.at) || attribAt || '',
        data: _ddmm,
        orig: 'PAYT',
      };
      if (_vi >= 0) state.vendas[_vi] = _venda; else state.vendas.unshift(_venda);
    } else if (_revEvt && _vi >= 0) {
      state.vendas[_vi].status = 'estornado';
    }
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

  // Persiste com CAS; se a versão mudou no meio, reprocessa (continue).
  const _ok = await _casState(env, curVer, state, 'payt-webhook');
  if (!_ok) { if (_attempt < 5) continue; return json({ ok: false, busy: true, error: 'estado ocupado, reenvie' }, 409); }

  return json({
    ok: true,
    event_raw: data.event_raw,
    event_mapped: data.event,
    status: data.status,
    modality: data.modality,
    action: action_taken,
    lead_id: lead_id_result,
    mapping_found: !!mapping,
  });
  }
}

// ─── FORNECEDOR WEBHOOK ──────────────────────────────────────
// Recebe eventos de fornecedor / plataforma de captação (criação E status).
// URL: /webhook/fornecedor/<chave>
// Aceita payload flexível: formato PAYT-like (event + order.*) ou raiz achatada.
async function handleFornecedorWebhook(req, env, urlToken) {
  const expected = (env && env.FORN_TOKEN) || FORN_TOKEN_DEFAULT;
  if (urlToken !== expected) {
    return json({ error: 'token inválido' }, 401);
  }

  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'payload JSON inválido' }, 400); }

  // ── Extração flexível: raiz E aninhado (body.order.*, body.address.*, body.customer.*) ──
  const o = body.order || body.pedido || {};
  const a = (body.address || body.endereco || o.address || o.endereco || {});
  const c = (body.customer || body.cliente || o.customer || o.cliente || {});

  const pick = (...vals) => {
    for (const v of vals) {
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  };

  const lead_data = {
    nome:      String(pick(body.nome, body.name, body.client_name, body.cliente, body.customer_name,
                           o.client_name, o.customer_name, o.name, o.nome, c.name, c.nome) || ''),
    cpf:       String(pick(body.cpf, body.document, body.documento, o.cpf, o.document, c.cpf, c.document) || ''),
    telefone:  String(pick(body.telefone, body.phone, body.whatsapp, body.celular, body.wa, body.client_whatsapp,
                           o.client_whatsapp, o.whatsapp, o.phone, o.telefone, c.phone, c.whatsapp) || ''),
    email:     String(pick(body.email, body.e_mail, body.client_email, o.client_email, o.email, c.email) || ''),
    cep:       String(pick(body.cep, body.zipcode, body.zip, a.cep, a.zipcode, a.zip, a.postal_code) || ''),
    endereco:  String(pick(body.endereco, body.address, body.end, body.rua, body.street,
                           a.street, a.rua, a.endereco, a.address) || ''),
    numero:    String(pick(body.numero, body.num, body.number, a.number, a.numero, a.num) || ''),
    complemento: String(pick(body.complemento, body.comp, body.complement, a.complement, a.complemento) || ''),
    bairro:    String(pick(body.bairro, body.neighborhood, a.neighborhood, a.bairro) || ''),
    cidade:    String(pick(body.cidade, body.city, a.city, a.cidade) || ''),
    uf:        String(pick(body.uf, body.state, body.estado, a.state, a.uf, a.estado) || ''),
    produto:   String(pick(body.produto, body.product, body.item, body.brand,
                           o.product, o.produto, o.brand, o.item, body?.treatment?.name, o?.treatment?.name) || ''),
    valor:     Number(pick(body.valor, body.amount, body.preco, body.price, body.total,
                           o.total_amount, o.amount, o.valor, o.total, o.price) || 0),
    modalidade:String(pick(body.modalidade, body.mod, body.tipo, body.payment_modality,
                           o.payment_modality, o.modalidade, o.modality) || ''),
    origem:    String(pick(body.origem, body.fonte, body.source, body.platform,
                           o.source, o.platform, o.origem) || 'Fornecedor'),
    obs:       String(pick(body.obs, body.notes, body.observacao, body.comment,
                           o.notes, o.obs, o.observacao) || ''),
    external_id: String(pick(body.external_id, body.id, body.order_id,
                             o.id, o.order_id, o.external_id) || ''),
    track:     String(pick(body.track, body.tracking, body.tracking_code,
                           o.tracking_code, o.tracking) || ''),
    payment_method: String(pick(body.payment_method, body.metodo_pagamento,
                                o.payment_method, o.metodo_pagamento) || ''),
  };

  // ── Detecta evento (mesma lógica do PAYT) ──
  const eventRaw = String(pick(body.event, body.evento, body.tipo, body.type) || '').toLowerCase();
  const status = String(pick(body.status, o.status) || '').toLowerCase();
  const event = mapPaytEvent(eventRaw, status, lead_data.modalidade);
  const isCOD = lead_data.modalidade && (
    lead_data.modalidade.toLowerCase().includes('on_delivery') ||
    lead_data.modalidade.toLowerCase().includes('cod') ||
    lead_data.modalidade.toLowerCase().includes('apos_receber') ||
    lead_data.modalidade.toLowerCase().includes('entrega')
  );
  const mod = isCOD ? 'entrega' : 'antecipado';

  // Reprocessa com concorrência otimista (mesmo motivo do webhook Payt).
  for (let _attempt = 0; _attempt < 6; _attempt++) {
  // ── Carrega state ──
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

  // Mapping: usa forn_mapping; se vazio, fallback pro payt_mapping
  const forn_map = state.forn_mapping || state.payt_mapping || {};
  const mapping = forn_map[event];

  // ── Busca lead existente (external_id > CPF > WA > email) ──
  let lead = null;
  if (lead_data.external_id) {
    lead = state.leads.find(l => l.external_id === lead_data.external_id) || null;
  }
  if (!lead) {
    lead = findLead(state.leads, { cpf: lead_data.cpf, phone: lead_data.telefone, email: lead_data.email });
  }

  let action_taken = '';
  let lead_id_result = null;

  if (lead) {
    // ── Atualiza lead existente: aplica mapping + dados novos ──
    const prev = lead.col;
    if (mapping?.etapa) lead.col = mapping.etapa;
    if (mapping?.spg) lead.spg = mapping.spg;
    if (mapping?.action === 'tag' && mapping.tag) {
      lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
      if (!lead.tags.includes(mapping.tag)) lead.tags.push(mapping.tag);
    }
    if (lead_data.track && !lead.track) lead.track = lead_data.track;
    if (lead_data.payment_method && !lead.pgto) lead.pgto = lead_data.payment_method;
    if (lead_data.valor && !lead.vl) lead.vl = lead_data.valor;
    // Garante external_id pra próximas chamadas
    if (lead_data.external_id && !lead.external_id) lead.external_id = lead_data.external_id;

    lead.hist = Array.isArray(lead.hist) ? lead.hist : [];
    lead.hist.push({
      from: prev,
      to: lead.col,
      who: 'fornecedor',
      time: `${todayBR()} ${nowTimeBR()}`,
      note: `Fornecedor: ${eventRaw || event} (${status || '-'})`,
    });

    // VENDA ESTIMADA DO PRODUTOR DESATIVADA (v2.30): a receita real vem da Payt
    // (comissão líquida do afiliado, via postback/CSV). Não criamos mais venda com
    // bruto × 12% chutado aqui pra não poluir/duplicar o número real. O produtor só
    // move etapa/status do lead acima.
    action_taken = 'updated';
    lead_id_result = lead.id;
  } else if (
    !event ||
    event === 'unknown' ||
    mapping ||
    ['aguardando_pagamento','aguardando_confirmacao','finalizada'].includes(event) ||
    eventRaw === 'new_order' || eventRaw === 'novo_pedido' || eventRaw === 'novo_lead'
  ) {
    // ── Cria lead novo se for evento de pedido novo ou sem evento (compat antigo) ──
    if (!lead_data.nome) {
      return json({
        error: 'lead novo precisa de "nome" (ou "name" / "client_name")',
        hint: 'aceito: nome, name, client_name, cliente, customer_name — na raiz ou em order.*'
      }, 400);
    }
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
      comp: lead_data.complemento,
      bairro: lead_data.bairro,
      cidade: lead_data.cidade,
      uf: lead_data.uf,
      data: todayBR(),
      orig: lead_data.origem,
      prod: lead_data.produto,
      trat: lead_data.produto,
      vl: lead_data.valor,
      com_pct: 12,
      track: lead_data.track,
      pgto: lead_data.payment_method,
      spg: mapping?.spg || (isCOD ? 'Pendente' : 'Pendente'),
      mod: mod,
      at: null,
      col: mapping?.etapa || 'A Enviar',
      obs: lead_data.obs || (lead_data.external_id ? `Pedido fornecedor ${lead_data.external_id}` : ''),
      link: '',
      tags: mapping?.action === 'tag' && mapping.tag ? [mapping.tag, 'fornecedor'] : ['fornecedor'],
      fu: null,
      hist: [{
        from: '—',
        to: mapping?.etapa || 'A Enviar',
        who: 'fornecedor',
        time: `${todayBR()} ${nowTimeBR()}`,
        note: `Lead criado via fornecedor: ${eventRaw || 'novo_lead'} (${status || '-'})`,
      }],
      comments: [],
    };
    state.leads.unshift(newLead);
    action_taken = 'created';
    lead_id_result = newLead.id;
  } else {
    action_taken = 'skipped';
  }

  // ── Log ──
  state.wh_log_server.unshift({
    ts: Math.floor(Date.now() / 1000),
    org: 'Fornecedor',
    evt: event || eventRaw || 'novo_lead',
    evt_raw: eventRaw,
    status: status,
    lid: lead_id_result,
    action: action_taken,
    order_id: lead_data.external_id || '',
    origem: lead_data.origem,
  });
  state.wh_log_server = state.wh_log_server.slice(0, 100);

  // ── Persiste com CAS; reprocessa se a versão mudou no meio ──
  const _ok = await _casState(env, curVer, state, 'fornecedor-webhook');
  if (!_ok) { if (_attempt < 5) continue; return json({ ok: false, busy: true, error: 'estado ocupado, reenvie' }, 409); }

  return json({
    ok: true,
    event_raw: eventRaw,
    event_mapped: event,
    status: status,
    action: action_taken,
    lead_id: lead_id_result,
  });
  }
}

// ─── WhatsApp (Evolution API) ─────────────────────────────────
// A Dash chama o Worker (HTTPS) e o Worker repassa pra Evolution API na VPS.
// Vantagem dupla: esconde a API key da Evolution (fica só no D1, nunca no
// frontend) e evita mixed-content — navegador bloqueia https→http direto.
// Config guardada no D1 (app_config): wa_url, wa_key, wa_instance.

async function getWAConfig(env) {
  const url = await _readConfig(env, 'wa_url');
  const key = await _readConfig(env, 'wa_key');
  const instance = await _readConfig(env, 'wa_instance');
  return {
    url: String(url || '').replace(/\/+$/, ''),
    key: key || '',
    instance: instance || '',
  };
}

// Normaliza número pro formato da Evolution (DDI+DDD+numero, só dígitos)
function waNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 11) d = '55' + d;  // sem DDI → assume Brasil
  return d;
}

// GET /api/config/wa → status da config (sem expor a key inteira)
async function handleWAConfigGet(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode ver config do WhatsApp', 403);
  const cfg = await getWAConfig(env);
  const mask = k => k ? (k.length < 12 ? k.slice(0, 3) + '…' : `${k.slice(0, 6)}…${k.slice(-4)}`) : null;
  return json({
    configured: !!(cfg.url && cfg.key && cfg.instance),
    url: cfg.url,
    instance: cfg.instance,
    key_preview: mask(cfg.key),
  });
}

// POST /api/config/wa → salva { url, key, instance } (qualquer um pode vir)
async function handleWAConfigSet(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode mudar config do WhatsApp', 403);
  const body = await req.json().catch(() => null);
  if (!body) return err('Body inválido');
  if (body.url !== undefined)      await _writeConfig(env, 'wa_url', String(body.url || '').trim().replace(/\/+$/, ''));
  if (body.key !== undefined)      await _writeConfig(env, 'wa_key', String(body.key || '').trim());
  if (body.instance !== undefined) await _writeConfig(env, 'wa_instance', String(body.instance || '').trim());
  return json({ ok: true });
}

// GET /api/wa/status → estado da conexão da instância (open = conectado)
async function handleWAStatus(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const cfg = await getWAConfig(env);
  if (!cfg.url || !cfg.key || !cfg.instance) return err('WhatsApp não configurado', 503);
  try {
    const r = await fetch(`${cfg.url}/instance/connectionState/${cfg.instance}`, {
      headers: { apikey: cfg.key },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return err(`Evolution respondeu ${r.status}`, 502);
    return json({ ok: true, state: data?.instance?.state || 'unknown', instance: cfg.instance });
  } catch (e) {
    return err('Falha ao falar com a Evolution: ' + e.message, 502);
  }
}

// POST /api/wa/send → { number, text, instance? } envia texto.
// Se instance não vier, usa a instância padrão configurada (wa_instance).
async function handleWASend(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const cfg = await getWAConfig(env);
  if (!cfg.url || !cfg.key) return err('WhatsApp não configurado', 503);
  const body = await req.json().catch(() => null);
  if (!body || !body.number || !body.text) return err('Campos obrigatórios: number, text');
  const instance = String(body.instance || cfg.instance || '').trim();
  if (!instance) return err('Nenhuma instância informada nem padrão configurada', 400);
  const number = waNumber(body.number);
  if (!number) return err('Número inválido');
  try {
    const r = await fetch(`${cfg.url}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { apikey: cfg.key, 'content-type': 'application/json' },
      body: JSON.stringify({ number, text: String(body.text) }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return err(`Evolution respondeu ${r.status}: ${JSON.stringify(data).slice(0, 200)}`, 502);
    await _waLogMsg(env, { phone: number, instance, direction: 'out', type: 'text', body: String(body.text), msgId: data?.key?.id });
    return json({ ok: true, id: data?.key?.id || null, status: data?.status || null, to: number, instance });
  } catch (e) {
    return err('Falha ao enviar: ' + e.message, 502);
  }
}

// ── Gestão multi-instância (1 número/instância por atendente) ──
// Helper: chama a Evolution com a config global (url+key do D1). Nunca expõe a key.
async function evoFetch(env, path, opts = {}) {
  const cfg = await getWAConfig(env);
  if (!cfg.url || !cfg.key) return { _noconfig: true };
  const r = await fetch(`${cfg.url}${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: cfg.key, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let data = {}; try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, data };
}

// ─── VOZ + MÍDIA (o "ZapVoice" nosso, server-side e conectado à Dash) ──
// Base64 helpers (Workers têm btoa/atob nativos)
function _bytesToB64(bytes) {
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function _b64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// Embrulha PCM 16-bit mono (do Gemini TTS) num container WAV → base64
function _pcmB64ToWavB64(pcmB64, sampleRate) {
  const pcm = _b64ToBytes(pcmB64);
  const numCh = 1, bps = 16, byteRate = sampleRate * numCh * bps / 8, blockAlign = numCh * bps / 8;
  const header = new Uint8Array(44), dv = new DataView(header.buffer);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, byteRate, true); dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bps, true); wr(36, 'data'); dv.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(header, 0); out.set(pcm, 44);
  return _bytesToB64(out);
}
// Gera áudio TTS a partir de texto. Providers: elevenlabs, openai, gemini (usa a chave que existir).
// Retorna { b64, mime } (base64 puro) ou null.
async function _ttsGenerate(env, text, opts = {}) {
  const t = String(text || '').trim(); if (!t) return null;
  let provider = (opts.provider || '').trim() || (await _readConfig(env, 'tts_provider')) || '';
  if (!provider) {
    if (await getAIKey(env, 'elevenlabs')) provider = 'elevenlabs';
    else if (await getAIKey(env, 'openai')) provider = 'openai';
    else provider = 'gemini';
  }
  try {
    if (provider === 'elevenlabs') {
      const key = await getAIKey(env, 'elevenlabs'); if (!key) return null;
      const voice = opts.voice || (await _readConfig(env, 'tts_voice')) || '21m00Tcm4TlvDq8ikWAM';
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
        method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: t, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      });
      if (!r.ok) return null;
      return { b64: _bytesToB64(new Uint8Array(await r.arrayBuffer())), mime: 'audio/mpeg' };
    }
    if (provider === 'openai') {
      const key = await getAIKey(env, 'openai'); if (!key) return null;
      const voice = opts.voice || (await _readConfig(env, 'tts_voice')) || 'onyx';
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: t, response_format: 'mp3' }),
      });
      if (!r.ok) return null;
      return { b64: _bytesToB64(new Uint8Array(await r.arrayBuffer())), mime: 'audio/mpeg' };
    }
    // Gemini TTS — usa a chave que já temos. Retorna PCM 16-bit → embrulha em WAV.
    const gkey = await getAIKey(env, 'gemini'); if (!gkey) return null;
    const voice = opts.voice || (await _readConfig(env, 'tts_voice')) || 'Charon';
    const body = { contents: [{ parts: [{ text: t }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } };
    for (const mdl of ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${gkey}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const part = (d?.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
      const inline = part?.inlineData || part?.inline_data;
      const pcmB64 = inline?.data; if (!pcmB64) continue;
      const mime = inline.mimeType || inline.mime_type || '';
      const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
      return { b64: _pcmB64ToWavB64(pcmB64, rate), mime: 'audio/wav' };
    }
    return null;
  } catch (_) { return null; }
}
// Envia áudio (nota de voz/PTT) via Evolution. audioB64 = base64 puro.
async function _waSendAudio(env, instance, number, audioB64, delay) {
  return evoFetch(env, `/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`, {
    method: 'POST', body: { number, audio: audioB64, encoding: true, ...(delay ? { delay } : {}) },
  });
}
// Envia mídia (imagem/vídeo/documento) via Evolution. media = URL ou base64 puro.
async function _waSendMedia(env, instance, number, m) {
  return evoFetch(env, `/message/sendMedia/${encodeURIComponent(instance)}`, {
    method: 'POST', body: {
      number, mediatype: m.mediatype || 'image',
      ...(m.mimetype ? { mimetype: m.mimetype } : {}),
      media: m.media,
      ...(m.fileName ? { fileName: m.fileName } : {}),
      ...(m.caption ? { caption: m.caption } : {}),
    },
  });
}
// POST /api/wa/send-audio { number, instance?, audio_base64?, text?, voice?, provider?, delay? }
async function handleWASendAudio(req, env) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  const cfg = await getWAConfig(env);
  if (!cfg.url || !cfg.key) return err('WhatsApp não configurado', 503);
  const body = await req.json().catch(() => null);
  if (!body || !body.number) return err('Campo obrigatório: number');
  const instance = String(body.instance || cfg.instance || '').trim();
  if (!instance) return err('Nenhuma instância informada nem padrão configurada', 400);
  const number = waNumber(body.number); if (!number) return err('Número inválido');
  let audioB64 = body.audio_base64 ? String(body.audio_base64).replace(/^data:[^;]+;base64,/, '') : '';
  if (!audioB64 && body.text) {
    const tts = await _ttsGenerate(env, body.text, { voice: body.voice, provider: body.provider });
    if (!tts) return err('Falha ao gerar áudio (TTS). Configure a chave/provider de voz.', 502);
    audioB64 = tts.b64;
  }
  if (!audioB64) return err('Informe audio_base64 ou text', 400);
  const res = await _waSendAudio(env, instance, number, audioB64, body.delay);
  if (res._noconfig) return err('WhatsApp não configurado', 503);
  if (!res.ok) return err(`Evolution respondeu ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`, 502);
  await _waLogMsg(env, { phone: number, instance, direction: 'out', type: 'audio', body: body.text ? ('🎤 ' + body.text) : '[áudio]', msgId: res.data?.key?.id });
  return json({ ok: true, id: res.data?.key?.id || null, to: number, instance });
}
// POST /api/wa/send-media { number, instance?, media(url|base64), mediatype, mimetype?, fileName?, caption? }
async function handleWASendMedia(req, env) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  const cfg = await getWAConfig(env);
  if (!cfg.url || !cfg.key) return err('WhatsApp não configurado', 503);
  const body = await req.json().catch(() => null);
  if (!body || !body.number || !body.media) return err('Campos obrigatórios: number, media');
  const instance = String(body.instance || cfg.instance || '').trim();
  if (!instance) return err('Nenhuma instância informada nem padrão configurada', 400);
  const number = waNumber(body.number); if (!number) return err('Número inválido');
  const media = String(body.media).replace(/^data:[^;]+;base64,/, '');
  const mediatype = ['image', 'video', 'document'].includes(body.mediatype) ? body.mediatype : 'image';
  const res = await _waSendMedia(env, instance, number, { mediatype, mimetype: body.mimetype, media, fileName: body.fileName, caption: body.caption });
  if (res._noconfig) return err('WhatsApp não configurado', 503);
  if (!res.ok) return err(`Evolution respondeu ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`, 502);
  await _waLogMsg(env, { phone: number, instance, direction: 'out', type: mediatype, body: body.caption || ('[' + mediatype + ']'), msgId: res.data?.key?.id });
  return json({ ok: true, id: res.data?.key?.id || null, to: number, instance });
}
// GET/POST /api/config/tts — provider/voz + status das chaves (sem expor valor)
async function handleTTSConfig(req, env) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode mexer na config de voz', 403);
  if (req.method === 'POST') {
    const b = await req.json().catch(() => null);
    if (b?.provider !== undefined) await _writeConfig(env, 'tts_provider', String(b.provider || '').trim());
    if (b?.voice !== undefined) await _writeConfig(env, 'tts_voice', String(b.voice || '').trim());
    if (b?.openai_key !== undefined) await _writeConfig(env, 'ai_openai_key', String(b.openai_key || '').trim());
    if (b?.elevenlabs_key !== undefined) await _writeConfig(env, 'ai_elevenlabs_key', String(b.elevenlabs_key || '').trim());
    return json({ ok: true });
  }
  return json({
    ok: true,
    provider: (await _readConfig(env, 'tts_provider')) || '',
    voice: (await _readConfig(env, 'tts_voice')) || '',
    has_openai: !!(await getAIKey(env, 'openai')),
    has_elevenlabs: !!(await getAIKey(env, 'elevenlabs')),
    has_gemini: !!(await getAIKey(env, 'gemini')),
  });
}
// POST /api/wa/tts-test { text?, voice?, provider? } — gera o áudio e devolve tamanho, SEM enviar
async function handleTTSTest(req, env) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor', 403);
  const b = await req.json().catch(() => ({}));
  const text = (b?.text || 'Olá! Aqui é da equipe de saúde. Tudo bem com o senhor?').slice(0, 500);
  const tts = await _ttsGenerate(env, text, { voice: b?.voice, provider: b?.provider });
  if (!tts) return err('Falha ao gerar áudio. Verifique a chave/config de voz.', 502);
  return json({ ok: true, mime: tts.mime, bytes: Math.round(tts.b64.length * 3 / 4), provider: (b?.provider || (await _readConfig(env, 'tts_provider')) || 'auto') });
}

// GET /api/wa/instances → lista todas as instâncias e seus estados
async function handleWAInstances(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const res = await evoFetch(env, '/instance/fetchInstances');
  if (res._noconfig) return err('WhatsApp não configurado', 503);
  if (!res.ok) return err(`Evolution respondeu ${res.status}`, 502);
  // Normaliza pra { name, state } (a Evolution varia o formato entre versões)
  const arr = Array.isArray(res.data) ? res.data : (res.data?.instances || []);
  const list = arr.map(x => {
    const i = x.instance || x;
    return { name: i.instanceName || i.name, state: i.connectionStatus || i.state || i.status || 'unknown' };
  }).filter(x => x.name);
  return json({ ok: true, instances: list });
}

// POST /api/wa/instance/create → { instanceName } cria (idempotente) e já devolve QR
async function handleWAInstanceCreate(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const body = await req.json().catch(() => null);
  const name = String(body?.instanceName || '').trim();
  if (!name) return err('instanceName obrigatório');
  // Cria (se já existir, a Evolution retorna erro 403/409 — tratamos como ok e seguimos pro connect)
  await evoFetch(env, '/instance/create', {
    method: 'POST',
    body: { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS' },
  });
  const res = await evoFetch(env, `/instance/connect/${name}`);
  if (res._noconfig) return err('WhatsApp não configurado', 503);
  // Registra o webhook de volta apontando pro nosso Worker (best-effort)
  try { await _waSetWebhook(env, name, new URL(req.url).origin); } catch (_) {}
  const qr = res.data?.base64 || res.data?.qrcode?.base64 || res.data?.qr || null;
  return json({ ok: true, instance: name, qr, pairingCode: res.data?.pairingCode || res.data?.code || null });
}

// GET /api/wa/instance/connect?instance=NAME → QR atualizado pra reconectar
async function handleWAInstanceConnect(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const name = new URL(req.url).searchParams.get('instance');
  if (!name) return err('parâmetro "instance" obrigatório');
  const res = await evoFetch(env, `/instance/connect/${encodeURIComponent(name)}`);
  if (res._noconfig) return err('WhatsApp não configurado', 503);
  if (!res.ok) return err(`Evolution respondeu ${res.status}`, 502);
  const qr = res.data?.base64 || res.data?.qrcode?.base64 || res.data?.qr || null;
  return json({ ok: true, instance: name, qr, pairingCode: res.data?.pairingCode || res.data?.code || null });
}

// GET /api/wa/instance/status?instance=NAME → estado de uma instância
async function handleWAInstanceStatus(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const name = new URL(req.url).searchParams.get('instance');
  if (!name) return err('parâmetro "instance" obrigatório');
  const res = await evoFetch(env, `/instance/connectionState/${encodeURIComponent(name)}`);
  if (res._noconfig) return err('WhatsApp não configurado', 503);
  if (!res.ok) return err(`Evolution respondeu ${res.status}`, 502);
  return json({ ok: true, instance: name, state: res.data?.instance?.state || 'unknown' });
}

// POST /api/wa/instance/logout → { instance } desconecta e remove a instância
async function handleWAInstanceLogout(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode remover conexões', 403);
  const body = await req.json().catch(() => null);
  const name = String(body?.instance || '').trim();
  if (!name) return err('instance obrigatório');
  await evoFetch(env, `/instance/logout/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await evoFetch(env, `/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE' });
  try { await env.DB.prepare('DELETE FROM wa_conn WHERE instance=?').bind(name).run(); } catch (_) {}   // tira do liveSet pra roleta não mandar lead pra número removido
  return json({ ok: true, instance: name, removed: true });
}
// POST /api/wa/instance/disconnect → { instance } só DESCONECTA (logout), mantém a instância + configs (webhook/groupsIgnore)
async function handleWAInstanceDisconnect(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  let body = {}; try { body = await req.json(); } catch (_) {}
  const name = String(body?.instance || '').trim();
  if (!name) return err('instance obrigatório');
  // desconecta DE VERDADE: logout → confere o estado REAL na Evolution → se ainda 'open', tenta de novo
  // (o logout às vezes não pega de primeira quando o socket travou). Não grava 'close' otimista:
  // se o número seguir conectado, a dash mostra a verdade em vez de mentir "desconectado".
  const _state = async () => {
    try { const live = await _evoInstances(env); if (!live) return null; const f = live.find(i => String(i.name) === name); return f ? { state: f.state, number: f.number || '' } : { state: 'close', number: '' }; }
    catch (_) { return null; }
  };
  let st = null;
  for (let i = 0; i < 2; i++) {
    try { await evoFetch(env, `/instance/logout/${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (_) {}
    st = await _state();
    if (!st || st.state !== 'open') break;   // st null = Evolution fora do ar; não fica em loop
  }
  const open = !!(st && st.state === 'open');
  try { await env.DB.prepare("UPDATE wa_conn SET state=?, number=?, updated_at=strftime('%s','now') WHERE instance=?").bind(open ? 'open' : 'close', open ? (st.number || '') : '', name).run(); } catch (_) {}
  return json({ ok: !open, instance: name, disconnected: !open, state: open ? 'open' : 'close' });
}

// ─── Webhook de volta (Evolution → Worker) ───────────────────
// Recebe eventos da Evolution: mensagens recebidas (auto-resposta de primeiro
// contato + atribuição de vendedor) e mudança de conexão (detectar número
// caído). Tudo gated pela chave-mestra wa_autom_on. Conexão/atribuição/dedupe
// ficam em tabelas D1 próprias, pra NÃO conflitar com o blob de estado da dash.
async function _waEnsureTables(env) {
  if (_waTablesOk) return;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_conn (instance TEXT PRIMARY KEY, state TEXT, updated_at INTEGER)').run();
    try{ await env.DB.prepare('ALTER TABLE wa_conn ADD COLUMN number TEXT').run(); }catch(_){}   // número REALMENTE conectado (ownerJid da Evolution)
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_attrib (phone TEXT PRIMARY KEY, instance TEXT, updated_at INTEGER)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_replied (phone TEXT PRIMARY KEY, updated_at INTEGER)').run();
    // Conversas (inbox/CRM): cada mensagem in/out + resumo por contato pro inbox
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_messages (msg_id TEXT PRIMARY KEY, phone TEXT NOT NULL, instance TEXT, direction TEXT, type TEXT, body TEXT, push_name TEXT, ts INTEGER)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON wa_messages(phone, ts)').run();
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_msg_inst_ts ON wa_messages(instance, ts)').run(); } catch (_) {}   // carga recente por instância (balanceador)
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_chats (phone TEXT PRIMARY KEY, instance TEXT, name TEXT, last_text TEXT, last_ts INTEGER, last_dir TEXT, unread INTEGER DEFAULT 0, assigned_to TEXT, updated_at INTEGER)').run();
    _waTablesOk = true;
  } catch (_) {}
}
// Extrai tipo + texto de uma mensagem recebida da Evolution (pro histórico do inbox)
function _waExtractMsg(data) {
  const mm = data?.message || {};
  if (mm.conversation) return { type: 'text', body: mm.conversation };
  if (mm.extendedTextMessage?.text) return { type: 'text', body: mm.extendedTextMessage.text };
  if (mm.imageMessage) return { type: 'image', body: mm.imageMessage.caption || '' };
  if (mm.audioMessage) return { type: 'audio', body: '' };
  if (mm.videoMessage) return { type: 'video', body: mm.videoMessage.caption || '' };
  if (mm.documentMessage) return { type: 'document', body: mm.documentMessage.fileName || '' };
  if (mm.stickerMessage) return { type: 'sticker', body: '' };
  if (mm.locationMessage) return { type: 'location', body: '' };
  return { type: 'other', body: '' };
}
// Grava uma mensagem (in/out) no histórico e atualiza o resumo do inbox.
// Dedup natural por msg_id (PK). Nunca quebra o fluxo de quem chama.
async function _waLogMsg(env, m) {
  try {
    await _waEnsureTables(env);
    const phone = String(m.phone || '').replace(/\D/g, '');
    if (!phone) return;
    const ts = Number(m.ts) || Math.floor(Date.now() / 1000);
    const dir = m.direction === 'out' ? 'out' : 'in';
    const id = m.msgId || (dir + '_' + ts + '_' + Math.random().toString(36).slice(2, 8));
    const type = m.type || 'text';
    const body = String(m.body == null ? '' : m.body).slice(0, 4000);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO wa_messages (msg_id, phone, instance, direction, type, body, push_name, ts) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(id, phone, m.instance || '', dir, type, body, m.pushName || '', ts).run();
    const incUnread = dir === 'in' ? 1 : 0;
    const preview = type === 'text' ? body : ('[' + type + ']');
    await env.DB.prepare(
      `INSERT INTO wa_chats (phone, instance, name, last_text, last_ts, last_dir, unread, updated_at)
       VALUES (?,?,?,?,?,?,?,strftime('%s','now'))
       ON CONFLICT(phone) DO UPDATE SET
         instance = excluded.instance,
         name = COALESCE(NULLIF(excluded.name,''), wa_chats.name),
         last_text = excluded.last_text,
         last_ts = excluded.last_ts,
         last_dir = excluded.last_dir,
         unread = CASE WHEN ? = 1 THEN wa_chats.unread + 1 ELSE wa_chats.unread END,
         updated_at = excluded.updated_at`
    ).bind(phone, m.instance || '', m.pushName || '', preview, ts, dir, incUnread, incUnread).run();
  } catch (_) {}
}
async function _waWebhookToken(env) {
  // Fail-closed: o token só vem do D1 (config) ou de um secret do Worker. Sem
  // fallback fixo no código — antes o token estava hardcoded no fonte, então
  // quem visse o repo podia forjar eventos (venda fantasma no pixel, envio forçado).
  return (await _readConfig(env, 'wa_webhook_token')) || (env && env.WA_WEBHOOK_TOKEN) || '';
}
// Registra o webhook na Evolution pra uma instância apontando pro nosso Worker
async function _waSetWebhook(env, instance, origin) {
  const token = await _waWebhookToken(env);
  const url = `${origin}/webhook/evolution/${token}`;
  await evoFetch(env, `/webhook/set/${encodeURIComponent(instance)}`, {
    method: 'POST',
    body: { webhook: { enabled: true, url, webhookByEvents: false, webhookBase64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] } },
  });
}
// Preenche template no servidor (lead pode ser parcial; usa pushName de fallback)
function _waFillTpl(tpl, lead, pushName) {
  const nome = (lead && lead.nome) || pushName || '';
  const f = String(nome).split(' ')[0];
  return String(tpl || '')
    .replace(/\{primeiro_nome\}/g, f)
    .replace(/\{nome\}/g, nome)
    .replace(/\{produto\}/g, (lead && (lead.prod || lead.trat)) || '')
    .replace(/\{valor\}/g, lead && lead.vl ? ('R$ ' + Number(lead.vl).toFixed(2).replace('.', ',')) : '')
    .replace(/\{cidade\}/g, (lead && lead.cidade) || '')
    .replace(/\{rastreio\}/g, (lead && lead.track) || '');
}
// Escolhe a regra de primeiro contato que casa com a instância (vendedor)
function _waPickInboundRule(state, instance) {
  const rules = (state.wa_automacoes || []).filter(r => r.ativo && r.gatilho === 'primeiro_contato');
  if (!rules.length) return null;
  const atId = instance.indexOf('ax_') === 0 ? instance.slice(3) : null;
  // O Worker não tem o time (fora do blob), então casa por 'todos', 'user:<atId>'
  // ou qualquer 'role:' (inbound é sempre contexto de atendente).
  for (const r of rules) {
    const a = r.alvo || 'todos';
    if (a === 'todos') return r;
    if (atId && a === 'user:' + atId) return r;
    if (a.indexOf('role:') === 0) return r;
  }
  return null;
}
async function _waOnConnection(env, instance, data) {
  if (!instance) return;
  await _waEnsureTables(env);
  const st = data?.state || data?.connection || 'unknown';
  // No 'open', já captura o número que conectou (ownerJid) e grava junto — evita janela em que o
  // wa_conn.number fica com o número antigo e o roteador pula o número recém-conectado.
  if (String(st) === 'open') {
    let num = '';
    try { const live = await _evoInstances(env); const it = (live || []).find(x => x.name === instance); if (it) num = it.number || ''; } catch (_) {}
    // conectou: grava o número que entrou. Se não resolveu (num=''), LIMPA o antigo → serve-time fica fail-open (não usa número velho errado).
    await env.DB.prepare(
      `INSERT INTO wa_conn (instance, state, number, updated_at) VALUES (?, ?, ?, strftime('%s','now'))
       ON CONFLICT(instance) DO UPDATE SET state = excluded.state, number = excluded.number, updated_at = excluded.updated_at`
    ).bind(instance, String(st), num).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO wa_conn (instance, state, updated_at) VALUES (?, ?, strftime('%s','now'))
       ON CONFLICT(instance) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
    ).bind(instance, String(st)).run();
  }
}
// Transcreve um áudio recebido (Gemini). Retorna texto ou ''.
async function _waTranscribeAudio(env, instance, msgKey) {
  try {
    const gkey = await getAIKey(env, 'gemini'); if (!gkey) return '';
    const media = await evoFetch(env, `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, { method: 'POST', body: { message: { key: { id: msgKey.id, remoteJid: msgKey.remoteJid, fromMe: !!msgKey.fromMe } } } });
    const b64 = media?.data?.base64; if (!b64) return '';
    const body = { contents: [{ parts: [{ text: 'Transcreva este áudio em português do Brasil. Responda só a transcrição.' }, { inline_data: { mime_type: 'audio/ogg', data: b64 } }] }] };
    for (const mdl of ['gemini-2.5-flash', 'gemini-2.0-flash-exp']) {
      const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${gkey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (g.ok) { const d = await g.json(); return (d.candidates?.[0]?.content?.parts?.[0]?.text || '').trim(); }
      if (![429, 403, 404].includes(g.status)) break;
    }
  } catch (_) {}
  return '';
}
// Texto de um registro: conversation/extendedText, ou transcreve áudio se pedido.
async function _waRecText(env, instance, rec, transcribe) {
  const mm = rec.message || {};
  if (mm.conversation) return mm.conversation;
  if (mm.extendedTextMessage?.text) return mm.extendedTextMessage.text;
  if (mm.audioMessage) return transcribe ? await _waTranscribeAudio(env, instance, rec.key) : '[áudio]';
  if (mm.imageMessage) return mm.imageMessage.caption || '[imagem]';
  return '';
}
// Bot de IA em TESTE: responde só o chat whitelistado (wa_bot_test_*). Agrupa
// mensagens picadas usando um BUFFER próprio no D1 (confiável, sem depender do
// findMessages que atrasa), transcreve áudio, responde como humano (várias
// mensagens curtas com "digitando..."). Retorna true se tratou.
async function _waBotTestReply(env, instance, key, data) {
  const testInst = await _readConfig(env, 'wa_bot_test_instance');
  const testPhone = await _readConfig(env, 'wa_bot_test_phone');
  if (!testInst || !testPhone) return false;
  if (instance !== testInst) return false;
  const realPhone = String(key.remoteJidAlt || key.remoteJid || '').split('@')[0].replace(/\D/g, '');
  const testPhones = String(testPhone).split(',').map(s => s.replace(/\D/g, '')).filter(Boolean);
  if (!testPhones.includes(realPhone)) return false; // whitelist: aceita vários números de teste
  // Interruptor mestre do robô (aba Automações → DB.wa_bot_on). Desligado por padrão.
  try {
    const st = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
    if (!JSON.parse(st?.data || '{}').wa_bot_on) return false; // bot desligado → não responde
  } catch (_) { return false; }
  const jid = key.remoteJid, myMsgId = key.id || ('m' + Date.now());
  const mm = data?.message || {};
  let kind = 'text', payload = '';
  if (mm.conversation) payload = mm.conversation;
  else if (mm.extendedTextMessage?.text) payload = mm.extendedTextMessage.text;
  else if (mm.audioMessage) kind = 'audio';
  else if (mm.imageMessage) payload = mm.imageMessage.caption || '[imagem]';
  else return true; // tipo não suportado, mas não cai no template
  console.log('BOTTEST in:', realPhone, 'kind', kind, 'id', myMsgId);
  // 1) Grava no buffer NA HORA (fonte confiável pro agrupamento)
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_buf (id TEXT PRIMARY KEY, phone TEXT, jid TEXT, ts INTEGER, kind TEXT, payload TEXT, done INTEGER DEFAULT 0)').run();
    await env.DB.prepare('INSERT OR IGNORE INTO wa_buf (id, phone, jid, ts, kind, payload, done) VALUES (?,?,?,?,?,?,0)')
      .bind(myMsgId, realPhone, jid, Date.now(), kind, payload).run();
  } catch (e) { console.log('BOTTEST buf err', e.message); }
  // 2) Debounce: espera juntar as mensagens picadas
  await new Promise(res => setTimeout(res, 7000));
  // 3) Reivindica atomicamente TODAS as pendentes desse telefone (1 invocação só pega)
  let claimed = [];
  try {
    const r = await env.DB.prepare('UPDATE wa_buf SET done=1 WHERE phone=? AND done=0 RETURNING id, jid, ts, kind, payload').bind(realPhone).all();
    claimed = (r?.results) || [];
  } catch (e) { console.log('BOTTEST claim err', e.message); return true; }
  console.log('BOTTEST claimed', claimed.length, 'mine?', claimed.some(c => c.id === myMsgId));
  if (!claimed.length || !claimed.some(c => c.id === myMsgId)) return true; // outra invocação respondeu o lote
  claimed.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const claimedIds = new Set(claimed.map(c => c.id));
  // 4) Monta a fala do lead (transcreve áudios do lote)
  const pendTexts = [];
  for (const c of claimed) {
    if (c.kind === 'audio') {
      const t = await _waTranscribeAudio(env, instance, { id: c.id, remoteJid: c.jid, fromMe: false });
      if (t) { pendTexts.push(t); try { await env.DB.prepare('UPDATE wa_buf SET payload=? WHERE id=?').bind(t, c.id).run(); } catch (_) {} try { await env.DB.prepare("UPDATE wa_messages SET body=? WHERE msg_id=?").bind('🎤 ' + t, c.id).run(); } catch (_) {} }
    } else if (c.payload) pendTexts.push(c.payload);
  }
  const userTurn = pendTexts.join('\n').trim();
  console.log('BOTTEST userTurn:', JSON.stringify(userTurn).slice(0, 160));
  if (!userTurn) return true;
  // 5) Histórico do NOSSO buffer (confiável, inclui as respostas do bot = kind 'out'),
  //    excluindo o turno atual. Resolve o re-cumprimento (o bot enxerga o que já falou).
  const contents = [];
  try {
    const hr = await env.DB.prepare('SELECT id, ts, kind, payload FROM wa_buf WHERE phone=? ORDER BY ts ASC').bind(realPhone).all();
    const rows = (hr?.results || []).filter(x => !claimedIds.has(x.id) && x.payload);
    for (const row of rows.slice(-16)) {
      contents.push({ role: row.kind === 'out' ? 'model' : 'user', parts: [{ text: row.payload }] });
    }
  } catch (_) {}
  contents.push({ role: 'user', parts: [{ text: userTurn }] });
  // 6) Gemini → resposta → envio humano
  const gkey = await getAIKey(env, 'gemini'); if (!gkey) return true;
  let prompt = await getBotPrompt(env);
  const leadName = String(data?.pushName || '').trim();
  if (leadName) prompt += `\n\nNOME DO LEAD (do WhatsApp dele): "${leadName}". Trate ele pelo PRIMEIRO nome, de forma natural e calorosa (ex: "Oi, seu João!", "Beleza, dona Maria?"). Só caia pra "senhor"/"senhora" sem nome se esse valor parecer um nome comercial, número, ou algo que claramente não é nome de pessoa.`;
  const reqBody = { system_instruction: { parts: [{ text: prompt }] }, contents: contents.slice(-16), generationConfig: { temperature: 0.9, maxOutputTokens: 400 } };
  for (const mdl of ['gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-2.5-flash-lite']) {
    try {
      const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${gkey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqBody) });
      if (!g.ok) { if ([429, 403, 404].includes(g.status)) continue; console.log('BOTTEST gemini fail', g.status); return true; }
      const d = await g.json();
      let reply = (d.candidates?.[0]?.content?.parts?.[0]?.text || '').replace(/\[HANDOFF\]/ig, '').trim();
      console.log('BOTTEST reply len', reply.length);
      if (reply) {
        const parts = reply.split(/\n*-{3,}\n*|\n\s*\n/).map(s => s.trim()).filter(Boolean);
        let oi = 0;
        for (const part of parts) {
          // digitação proporcional ao tamanho: curtas ~1.8s, longas até ~9s
          const delayMs = Math.min(9000, Math.max(1800, Math.round(part.length * 75)));
          await evoFetch(env, `/message/sendText/${encodeURIComponent(instance)}`, { method: 'POST', body: { number: realPhone, text: part, delay: delayMs } });
          await _waLogMsg(env, { phone: realPhone, instance, direction: 'out', type: 'text', body: part });
          // guarda a resposta no buffer (vira histórico do bot na próxima vez)
          try { await env.DB.prepare('INSERT OR IGNORE INTO wa_buf (id, phone, jid, ts, kind, payload, done) VALUES (?,?,?,?,?,?,1)').bind('out_' + myMsgId + '_' + (oi++), realPhone, jid, Date.now(), 'out', part).run(); } catch (_) {}
        }
      }
      return true;
    } catch (_) { continue; }
  }
  return true;
}
async function _waOnInbound(env, instance, data) {
  const key = data?.key || {};
  if (key.fromMe) return;                          // ignora o que NÓS mandamos
  const jid = String(key.remoteJid || '');
  if (!jid || jid.indexOf('@g.us') >= 0) return;   // ignora grupo
  // telefone REAL: em chat @lid o remoteJid é um id interno, o número certo vem em remoteJidAlt (mesma regra da venda)
  const phone = String(key.remoteJidAlt || key.remoteJid || '').split('@')[0].replace(/\D/g, '');
  if (!phone) return;
  // Guarda a mensagem recebida no histórico do inbox (independente de automação)
  const _ex = _waExtractMsg(data);
  await _waLogMsg(env, { phone, instance, direction: 'in', type: _ex.type, body: _ex.body, msgId: key.id, pushName: data?.pushName, ts: Number(data?.messageTimestamp) || 0 });
  // Sale Chat Engine (sombra): espelha o inbound da Evolution na auditoria crua pra comparar cobertura (sc x evo). Fire-and-forget, nunca afeta o fluxo.
  try { await env.DB.prepare("INSERT INTO sc_ingest_audit (source, self_number, phone, from_me, msg_id, type, body, push_name, ts, received_at, at_id) VALUES ('evo',?,?,0,?,?,?,?,?,strftime('%s','now'),?)").bind(String(instance || ''), phone, String(key.id || ''), String(_ex.type || 'text'), String(_ex.body || '').slice(0, 2000), String(data?.pushName || ''), Number(data?.messageTimestamp) || 0, String(instance || '').replace(/^ax_/, '')).run(); } catch (_) {}
  await _waLeadCapture(env, instance, phone, _ex.body, '', _ex.type, Number(data?.messageTimestamp) || 0);   // 1ª msg = LEAD: casa com o clique pelo código no texto e dispara evento pro pixel
  // Bot de IA em teste: trata só o chat whitelistado e encerra (não cai no template)
  if (await _waBotTestReply(env, instance, key, data)) return;
  await _waEnsureTables(env);
  // Atribuição: qual número (vendedor) falou com esse lead
  await env.DB.prepare(
    `INSERT INTO wa_attrib (phone, instance, updated_at) VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(phone) DO UPDATE SET instance = excluded.instance, updated_at = excluded.updated_at`
  ).bind(phone, instance).run();
  // Auto-resposta de primeiro contato — só com a chave-mestra ligada
  const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let state = {}; try { state = JSON.parse(row?.data || '{}'); } catch (_) {}
  if (!state.wa_autom_on) return;
  const rule = _waPickInboundRule(state, instance);
  if (!rule) return;
  const lead = (state.leads || []).find(l => norm(l.wa) === phone);
  const msg = _waFillTpl(rule.msg, lead, data?.pushName);
  if (!msg) return;
  const now = Math.floor(Date.now() / 1000);
  // Claim ATÔMICO antes de enviar: só a 1ª invocação dentro de 12h passa. Evita
  // auto-resposta DUPLICADA quando o lead manda várias mensagens em rajada (dois
  // webhooks concorrentes liam o dedupe vazio e ambos enviavam). Um só statement
  // com WHERE no conflito → a 2ª invocação vê changes=0 e não envia.
  const claim = await env.DB.prepare(
    `INSERT INTO wa_replied (phone, updated_at) VALUES (?, ?)
     ON CONFLICT(phone) DO UPDATE SET updated_at = excluded.updated_at
     WHERE wa_replied.updated_at < ?`
  ).bind(phone, now, now - 12 * 3600).run();
  if (!claim.meta || claim.meta.changes === 0) return;  // já respondido nas últimas 12h
  // Responde pelo MESMO número que o lead contatou (é resposta, baixo risco de ban)
  await evoFetch(env, `/message/sendText/${encodeURIComponent(instance)}`, { method: 'POST', body: { number: phone, text: msg } });
  await _waLogMsg(env, { phone, instance, direction: 'out', type: 'text', body: msg });
}
async function handleEvolutionWebhook(req, env, token, ctx) {
  const expected = await _waWebhookToken(env);
  if (!expected || token !== expected) return json({ error: 'token inválido' }, 401);
  let body; try { body = await req.json(); } catch (_) { return json({ ok: true }); }
  const event = String(body?.event || '').toLowerCase().replace(/_/g, '.');
  const instance = body?.instance || body?.instanceName || '';
  const data = body?.data || {};
  try {
    if (event === 'connection.update') await _waOnConnection(env, instance, data);
    else if (event === 'messages.upsert') {
      // Se a fonte virou o Sale Chat, a Evolution NÃO computa (senão duplica lead/venda/pixel).
      if ((await _waCaptureSource(env)) === 'sc') { /* fonte = Sale Chat */ }
      else { await _waOnInbound(env, instance, data); await _waDetectSale(env, instance, data); }
    }
  } catch (_) { /* nunca quebra o webhook */ }
  return json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════
// SALE CHAT ENGINE — motor que vai substituir a Evolution API.
// FASE 0 (aditiva, NADA aqui altera o fluxo vivo da Evolution):
// o Sale Chat captura no navegador e manda pra cá; por ora só gravamos
// numa auditoria CRUA pra PROVAR a captura (as PoCs) antes de ligar o
// fluxo real. Token fail-closed em app_config (sc_ingest_token).
// Plano: AXION/PLANO-SALECHAT-SUBSTITUI-EVOLUTION.md
// ═══════════════════════════════════════════════════════════════
async function _scIngestToken(env) {
  let t = await _readConfig(env, 'sc_ingest_token');
  if (!t) {
    t = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : (String(Date.now()) + Math.random().toString(36).slice(2));
    await _writeConfig(env, 'sc_ingest_token', t);
  }
  return t;
}
// Chave de virada: 'evo' (padrão, Evolution computa) ou 'sc' (o Sale Chat vira a fonte:
// o ingest computa lead/venda + pixel, e a Evolution para de computar pra não duplicar).
async function _waCaptureSource(env) {
  try { return (await _readConfig(env, 'wa_capture_source')) === 'sc' ? 'sc' : 'evo'; } catch (_) { return 'evo'; }
}
async function _scEnsureTables(env) {
  if (_scTablesOk) return;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS sc_ingest_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, self_number TEXT, phone TEXT, from_me INTEGER, msg_id TEXT, type TEXT, body TEXT, push_name TEXT, ts INTEGER, received_at INTEGER)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS sc_heartbeat (self_number TEXT PRIMARY KEY, at_id TEXT, instance TEXT, wpp_seen INTEGER, last_seen INTEGER, meta TEXT)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_number_owner (number TEXT PRIMARY KEY, at_id TEXT, instance TEXT, source TEXT, updated_at INTEGER)').run();
    try { await env.DB.prepare('ALTER TABLE sc_ingest_audit ADD COLUMN at_id TEXT').run(); } catch (_) {}   // idempotente: falha se a coluna já existe
    try { await env.DB.prepare('ALTER TABLE wa_number_owner ADD COLUMN num_key TEXT').run(); } catch (_) {}   // chave canônica (DDD+8) pra casar com/sem DDI
    try { await env.DB.prepare('ALTER TABLE wa_number_owner ADD COLUMN created_at INTEGER').run(); } catch (_) {}   // nascimento do número (só no 1º INSERT) → aquecimento por número
    // IDENTIDADE DO SALE CHAT: cada instalação (máquina do vendedor) tem um id fixo que sobrevive a
    // troca de número, reinstalação do WhatsApp e reboot. A atribuição passa a ser POR VENDEDOR, não
    // por número. Era a falha de fundo: o número roda, muda de dono, fica órfão — e lead/venda sumiam.
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS sc_install (install_id TEXT PRIMARY KEY, at_id TEXT, num_last TEXT, first_seen INTEGER, last_seen INTEGER)').run();
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sc_install_at ON sc_install(at_id)').run(); } catch (_) {}
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_owner_key ON wa_number_owner(num_key)').run(); } catch (_) {}
    // Índices pros scans quentes (proteção anti-buraco-negro, atribuição, painel de captura).
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sc_audit_recv ON sc_ingest_audit(received_at)').run(); } catch (_) {}
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sc_audit_self ON sc_ingest_audit(self_number, received_at)').run(); } catch (_) {}
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ttp_ts ON tt_pending(ts)').run(); } catch (_) {}
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ttp_numkey ON tt_pending(num_key, claimed, ts)').run(); } catch (_) {}
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ttp_ttclid ON tt_pending(ttclid)').run(); } catch (_) {}
    _scTablesOk = true;
  } catch (_) {}
}
// Chave canônica de número BR — resolve o desencontro que deixava TODO lead/venda sem dono:
// a dash grava o chip como "(15) 99237-3877" → 15992373877 (11 dígitos, SEM DDI), mas o Sale Chat
// manda o número logado no WhatsApp → 5515992373877 (13 dígitos, COM DDI 55). Como resolveOwner
// casava por igualdade exata, nunca batia: at_id ficava null e a captura não virava lead nem venda.
function _waNumKey(n) {
  let d = String(n || '').replace(/\D/g, '');
  if (!d) return '';
  // tira o DDI 55 só quando sobra um número nacional (10-11 dígitos) — assim não come o DDD 55 (RS)
  if (d.length >= 12 && d.slice(0, 2) === '55') d = d.slice(2);
  if (d.length < 10) return d;
  return d.slice(0, 2) + d.slice(-8);   // DDD + 8 finais → imune também ao 9º dígito
}
// Semeia wa_number_owner a partir dos chips do estado da dash (número -> vendedor).
// Server-side: é a fonte de verdade da atribuição, nunca o que o cliente diz ser.
async function _scSeedOwners(env) {
  try {
    const data = await _getDashData(env);   // cacheado
    const chips = Array.isArray(data.chips) ? data.chips : [];
    let n = 0;
    const vivos = [];
    for (const c of chips) {
      const num = String((c && c.num) || '').replace(/\D/g, '');
      const at = c && (c.at != null ? String(c.at) : '');
      if (!num || !at) continue;
      vivos.push(num);
      // instância por PAPEL: reserva vai pra ax_<at>_b (igual o frontend monta em _vendRoles).
      // Se os 2 números do vendedor ficassem na MESMA instância, eles colidiriam depois no
      // mergeSc do handleWAConn (byInst) e só um apareceria como "WhatsApp rodando".
      const inst = 'ax_' + at + (c.bkp === true ? '_b' : '');
      await env.DB.prepare(
        // created_at fica SÓ no INSERT (fora do DO UPDATE): é o nascimento do número no sistema, usado
        // pelo aquecimento. Se entrasse no UPDATE, todo seed do cron "rejuvenesceria" o número e ele
        // ficaria eternamente em aquecimento com teto baixo.
        `INSERT INTO wa_number_owner (number, at_id, instance, source, num_key, created_at, updated_at) VALUES (?, ?, ?, 'chips', ?, strftime('%s','now'), strftime('%s','now'))
         ON CONFLICT(number) DO UPDATE SET at_id=excluded.at_id, instance=excluded.instance, source=excluded.source, num_key=excluded.num_key, updated_at=excluded.updated_at`
      ).bind(num, at, inst, _waNumKey(num)).run();
      n++;
    }
    // Remove dono ÓRFÃO: chip que perdeu o atendente ou saiu da base. Sem isso a linha velha fica
    // pra sempre e um número reaproveitado sequestraria a instância do vendedor antigo (o lead dele
    // seria atribuído pro dono errado). Guarda: só limpa se realmente leu chips, pra um read vazio
    // ou falho nunca zerar a tabela de atribuição inteira.
    // NUNCA APAGAR o dono. O número pode sair da coluna na Contingência e continuar recebendo
    // conversa (a página antiga fica aberta no celular do lead) e FECHANDO VENDA. Apagar o dono
    // jogava tudo em quarentena e a venda sumia — foi o que custou 6 vendas hoje.
    // Só marca como inativo, guardando o último dono conhecido pra atribuição continuar funcionando.
    // Guarda: só mexe se leu uma lista plausível (evita zerar tudo num read parcial) e se cabe no
    // limite de parâmetros do D1.
    if (vivos.length >= 3 && vivos.length <= 90) {
      try {
        const ph = vivos.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE wa_number_owner SET source='chips_off' WHERE source='chips' AND number NOT IN (${ph})`).bind(...vivos).run();
      } catch (_) {}
    }
    return n;
  } catch (_) { return 0; }
}
// Resolve o número do vendedor -> {at_id, instance}. SEMPRE server-side; nunca
// confia no que o cliente diz ser o vendedor. FASE 0: só lê a tabela (pode estar
// vazia -> null = quarentena, o número captura mas não atribui a ninguém ainda).
// Resolve o vendedor pelo SALE CHAT (identidade estável da máquina dele). Se a instalação ainda não
// tem dono, adota o dono ATUAL do número que ela está rodando (bootstrap automático) e trava ali.
// A partir daí, trocar de número não muda mais a atribuição: a venda é de quem atendeu.
async function resolveInstall(env, installId, selfNumber) {
  const id = String(installId || '').trim();
  if (!id) return null;
  const num = String(selfNumber || '').replace(/\D/g, '');
  try {
    const row = await env.DB.prepare('SELECT at_id FROM sc_install WHERE install_id = ?').bind(id).first();
    if (row && row.at_id) {
      try { await env.DB.prepare("UPDATE sc_install SET num_last=?, last_seen=strftime('%s','now') WHERE install_id=?").bind(num, id).run(); } catch (_) {}
      return { at_id: String(row.at_id), instance: 'ax_' + row.at_id };
    }
    // sem dono ainda: adota o dono do número atual (é como o Sale Chat "aprende" de quem ele é)
    const ow = await resolveOwner(env, num);
    await env.DB.prepare(
      `INSERT INTO sc_install (install_id, at_id, num_last, first_seen, last_seen) VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))
       ON CONFLICT(install_id) DO UPDATE SET at_id=COALESCE(sc_install.at_id, excluded.at_id), num_last=excluded.num_last, last_seen=excluded.last_seen`
    ).bind(id, ow ? ow.at_id : null, num).run();
    return ow ? { at_id: ow.at_id, instance: 'ax_' + ow.at_id } : null;
  } catch (_) { return null; }
}
async function resolveOwner(env, selfNumber) {
  const num = String(selfNumber || '').replace(/\D/g, '');
  if (!num) return null;
  try {
    let row = await env.DB.prepare('SELECT at_id, instance FROM wa_number_owner WHERE number = ?').bind(num).first();
    if (!row) {   // não casou exato → tenta pela chave canônica (com/sem DDI, com/sem 9º dígito)
      const key = _waNumKey(num);
      // Prefere o chip ATIVO na Contingência; só cai no inativo (chips_off) se não houver ativo,
      // senão um número aposentado poderia ganhar de um número em uso e o lead ia pro vendedor errado.
      if (key) row = await env.DB.prepare("SELECT at_id, instance FROM wa_number_owner WHERE num_key = ? ORDER BY CASE WHEN source='chips' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1").bind(key).first();
    }
    if (row && row.at_id) return { at_id: row.at_id, instance: row.instance || ('ax_' + row.at_id) };
  } catch (_) {}
  return null;
}
// POST /api/salechat/ingest/<token> — recebe um LOTE de eventos capturados pelo Sale Chat.
// FASE 0: grava só na auditoria crua e devolve o ack (msg_id aceitos) pro injetor drenar a fila.
async function handleSalechatIngest(req, env, token) {
  const expected = await _scIngestToken(env);
  if (!expected || token !== expected) return json({ error: 'token inválido' }, 401);
  let body; try { body = await req.json(); } catch (_) { return json({ ok: true, ack: [] }); }
  const events = Array.isArray(body?.events) ? body.events : (Array.isArray(body) ? body : []);
  await _scEnsureTables(env);
  const now = Math.floor(Date.now() / 1000);
  const ack = [];
  const ownerCache = {};
  const installId = String(body?.installId || '').trim();   // identidade do Sale Chat do vendedor
  const src = await _waCaptureSource(env);   // 'sc' = computar aqui (lead/venda/pixel); 'evo' = só auditar
  const salesOut = [];   // vendas registradas neste lote (pro Sale Chat confirmar pro vendedor)
  for (const e of events) {
    try {
      const msgId = String(e?.msgId || e?.id || '');
      const selfNumber = String(e?.selfNumber || '').replace(/\D/g, '');
      const phone = String(e?.phone || '').replace(/\D/g, '');
      let atId = null, ownInst = '';   // dono resolvido no SERVIDOR (null = quarentena)
      // PRIORIDADE 1: o dono do SALE CHAT (identidade da máquina, estável). Trocar de número, o chip
      // ser banido ou ficar sem atendente na Contingência não desatribui mais nada — a venda continua
      // sendo de quem atendeu. PRIORIDADE 2 (fallback): o dono do número, como era antes.
      if (installId) {
        if (!(installId in ownerCache)) { ownerCache[installId] = await resolveInstall(env, installId, selfNumber); }
        const oi = ownerCache[installId];
        if (oi) { atId = oi.at_id; ownInst = oi.instance || ''; }
      }
      if (!atId && selfNumber) {
        if (!(selfNumber in ownerCache)) { ownerCache[selfNumber] = await resolveOwner(env, selfNumber); }
        const ow = ownerCache[selfNumber];
        atId = ow ? ow.at_id : null;
        ownInst = ow ? (ow.instance || '') : '';   // instância do PAPEL (complementar = ax_<at>_b)
      }
      await env.DB.prepare(
        'INSERT INTO sc_ingest_audit (source, self_number, phone, from_me, msg_id, type, body, push_name, ts, received_at, at_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      ).bind('sc', selfNumber, phone, e?.fromMe ? 1 : 0, msgId, String(e?.type || 'text'),
             String(e?.body || '').slice(0, 2000), String(e?.pushName || ''), Number(e?.ts) || 0, now, atId).run();
      // FASE 2: quando o Sale Chat é a fonte, o SERVIDOR computa aqui (reusa a mesma lógica da Evolution).
      if (src === 'sc' && atId && phone && !e?.lid) {   // pula @lid nao resolvido (nao vira lead fantasma)
        // Instância do PAPEL do número (complementar = ax_<at>_b). Antes era 'ax_'+atId fixo, e por
        // isso TODO lead do 2º número era carimbado com o número do principal nas métricas, e o
        // casamento do ttclid (tt_pending por instância) falhava justamente pros leads do complementar.
        const inst = ownInst || ('ax_' + atId);
        // Espelha no histórico (wa_messages/wa_chats). É daqui que saem o RITMO da roleta e o TETO
        // de rajada anti-ban; sem isso o balanceador ficava cego (nenhuma linha) e não conseguia
        // respeitar o limite por número. Também alimenta a caixa de entrada do CRM.
        try {
          await _waLogMsg(env, {
            phone, instance: inst, direction: e?.fromMe ? 'out' : 'in',
            type: String(e?.type || 'text'), body: String(e?.body || ''),
            pushName: String(e?.pushName || ''), ts: Number(e?.ts) || now, msgId: msgId || null
          });
        } catch (_) {}
        try {
          if (e?.fromMe) {
            // mensagem do vendedor: se for "Pedido Concluído", vira venda + dispara pixel (CompletePayment)
            const sr = await _waDetectSale(env, inst, { message: { conversation: String(e?.body || '') }, key: { remoteJid: phone + '@c.us', remoteJidAlt: phone + '@c.us', id: msgId || null, fromMe: true } });
            // Só confirma "VENDA CONFIRMADA" pro vendedor se REALMENTE gravou. Com erro de banco o
            // painel dizia confirmado e a venda não existia — o vendedor seguia tranquilo e ninguém
            // via. Sem confirmar, o resgate do cron pega depois e o painel não mente.
            if (sr && sr.sale && !sr.error && msgId) salesOut.push({ msgId: msgId, value: sr.value || 0 });
          } else {
            // mensagem do lead: 1ª vira LEAD (casa ttclid pelo código, pixel InitiateCheckout) + atribuição
            if (!_attribTablesOk) { try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_attrib (phone TEXT PRIMARY KEY, instance TEXT, updated_at INTEGER)').run(); _attribTablesOk = true; } catch (_) {} }
            await _waLeadCapture(env, inst, phone, String(e?.body || ''), selfNumber, String(e?.type || ''), Number(e?.ts) || 0);   // selfNumber = número REAL que atendeu
            await env.DB.prepare("INSERT INTO wa_attrib (phone, instance, updated_at) VALUES (?, ?, strftime('%s','now')) ON CONFLICT(phone) DO UPDATE SET instance=excluded.instance, updated_at=excluded.updated_at").bind(phone, inst).run();
          }
        } catch (_) {}
      }
      if (msgId) ack.push(msgId);
    } catch (_) { /* nunca quebra o lote inteiro por um evento ruim */ }
  }
  return json({ ok: true, ack, count: ack.length, sales: salesOut });
}
// POST /api/salechat/heartbeat/<token> — o injetor avisa periodicamente que o número está vivo/logado.
async function handleSalechatHeartbeat(req, env, token) {
  const expected = await _scIngestToken(env);
  if (!expected || token !== expected) return json({ error: 'token inválido' }, 401);
  let body; try { body = await req.json(); } catch (_) { body = {}; }
  await _scEnsureTables(env);
  const selfNumber = String(body?.selfNumber || '').replace(/\D/g, '');
  const installId = String(body?.installId || '').trim();
  if (!selfNumber) return json({ ok: true });
  // Dono do SALE CHAT primeiro (estável); se a instalação ainda não tem dono, ela adota o do número.
  let owner = installId ? await resolveInstall(env, installId, selfNumber) : null;
  if (!owner) owner = await resolveOwner(env, selfNumber);
  // Número reportando presença mas SEM dono = chip que o Diretor acabou de cadastrar/trocar.
  // Ressemeia na hora (no máx. 1x por minuto, pra não martelar o banco) em vez de esperar o cron:
  // sem dono a captura desse número não vira lead, venda nem pixel. Auto-cura em ~30s.
  if (!owner) {
    try {
      const last = Number(await _readConfig(env, 'sc_reseed_ts')) || 0;
      const agora = Math.floor(Date.now() / 1000);
      if (agora - last > 60) {
        await _writeConfig(env, 'sc_reseed_ts', String(agora));
        await _scSeedOwners(env);
        owner = await resolveOwner(env, selfNumber);
      }
    } catch (_) {}
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO sc_heartbeat (self_number, at_id, instance, wpp_seen, last_seen, meta) VALUES (?,?,?,?,?,?)
       ON CONFLICT(self_number) DO UPDATE SET at_id=excluded.at_id, instance=excluded.instance, wpp_seen=excluded.wpp_seen, last_seen=excluded.last_seen, meta=excluded.meta`
    ).bind(selfNumber, owner?.at_id || null, owner?.instance || null, Number(body?.wppSeen) || 0, now,
           JSON.stringify(body?.meta || {}).slice(0, 1000)).run();
  } catch (_) {}
  // Mantém wa_conn vivo pela presença do Sale Chat (número logado), pra a página de Pressels/roleta
  // e o "num" do lead funcionarem sem depender da Evolution.
  if (owner && owner.instance) {
    try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_conn (instance TEXT PRIMARY KEY, state TEXT, updated_at INTEGER)').run(); } catch (_) {}
    try { await env.DB.prepare('ALTER TABLE wa_conn ADD COLUMN number TEXT').run(); } catch (_) {}
    try { await env.DB.prepare(`INSERT INTO wa_conn (instance, state, number, updated_at) VALUES (?, 'sc', ?, strftime('%s','now')) ON CONFLICT(instance) DO UPDATE SET state='sc', number=excluded.number, updated_at=excluded.updated_at`).bind(owner.instance, selfNumber).run(); } catch (_) {}
    // Um número só pode estar num slot. Ao trocar o chip de vendedor, a linha antiga
    // (ex: ax_ccol_5 com o número que virou do Murilo) ficava pendurada e aparecia como uma
    // conexão fantasma, com o mesmo número em dois vendedores na lista de instâncias.
    try { await env.DB.prepare("DELETE FROM wa_conn WHERE number=? AND instance<>?").bind(selfNumber, owner.instance).run(); } catch (_) {}
  }
  // Devolve o NOME do vendedor pro painel mostrar na aba Captura: o vendedor confere na hora se o
  // Sale Chat dele está marcado com a pessoa certa (e avisa o Diretor se estiver trocado).
  let ownerName = '';
  try {
    if (owner && owner.at_id) {
      const u = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(String(owner.at_id)).first();
      ownerName = (u && u.name) ? String(u.name) : '';
    }
  } catch (_) {}
  return json({ ok: true, owner: owner ? owner.at_id : null, ownerName });
}
// GET /api/salechat/health (Diretor) — janela do que o Sale Chat está capturando (pra provar as PoCs).
async function handleSalechatHealth(req, env) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor', 403);
  await _scEnsureTables(env);
  const seeded = await _scSeedOwners(env);
  const token = await _scIngestToken(env);
  let recent = [], beats = [], counts = {}, coverage = [];
  try { recent = (await env.DB.prepare('SELECT * FROM sc_ingest_audit ORDER BY id DESC LIMIT 50').all()).results || []; } catch (_) {}
  try { beats = (await env.DB.prepare('SELECT * FROM sc_heartbeat ORDER BY last_seen DESC').all()).results || []; } catch (_) {}
  try {
    const c = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(SUM(from_me),0) fm FROM sc_ingest_audit').first();
    counts = { total: c?.n || 0, fromMe: c?.fm || 0 };
  } catch (_) {}
  // Cobertura: quantos leads (telefones distintos) cada fonte capturou. Sale Chat (sc) deve >= Evolution (evo).
  try { coverage = (await env.DB.prepare("SELECT source, COUNT(*) n, COUNT(DISTINCT phone) leads FROM sc_ingest_audit GROUP BY source").all()).results || []; } catch (_) {}
  return json({ ok: true, ingest_token: token, owners_seeded: seeded, counts, coverage, heartbeats: beats, recent });
}
// GET/POST /api/salechat/source (Diretor) — lê/vira a chave de captura (evo|sc). É o botão da Contingência.
async function handleSalechatSource(req, env) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor', 403);
  if (req.method === 'POST') {
    let body = {}; try { body = await req.json(); } catch (_) {}
    const s = body?.source === 'sc' ? 'sc' : 'evo';
    await _writeConfig(env, 'wa_capture_source', s);
    return json({ ok: true, source: s });
  }
  return json({ ok: true, source: await _waCaptureSource(env) });
}

// GET /api/wa/conn → estados de conexão recebidos (dash age em número caído)
// Lista as instâncias direto da Evolution: estado REAL + número conectado (ownerJid).
// Não confia só no webhook (que pode ficar defasado e mostrar "conectado" falso).
async function _evoInstances(env) {
  const res = await evoFetch(env, '/instance/fetchInstances');
  if (res._noconfig || !res.ok) return null;
  const arr = Array.isArray(res.data) ? res.data : (res.data?.instances || []);
  return arr.map(x => {
    const i = x.instance || x;
    const name = i.instanceName || i.name;
    const state = i.connectionStatus || i.state || i.status || 'unknown';
    const number = String(i.ownerJid || i.owner || i.number || '').replace(/@.*/, '').replace(/\D/g, '');
    return { name, state, number };
  }).filter(x => x.name);
}
async function handleWAConn(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _waEnsureTables(env);
  // Saturação da roleta (todos os números bateram o teto de rajada recentemente) → a dash avisa
  // pra adicionar mais números. Só considera "agora" se foi nos últimos 15min.
  let satTs = 0; try { const v = await _readConfig(env, 'roleta_sat_ts'); satTs = Number(v) || 0; } catch (_) {}
  const sat = satTs && (Math.floor(Date.now() / 1000) - satTs) < 900 ? satTs : 0;
  // Conexões do SALE CHAT: número com heartbeat recente (< 3min) = rodando ('sc'). Fonte nova, tem prioridade.
  let scConns = [];
  try {
    await _scEnsureTables(env);
    const hb = await env.DB.prepare("SELECT self_number, instance FROM sc_heartbeat WHERE last_seen > strftime('%s','now')-180").all();
    scConns = (hb.results || []).map(h => ({ instance: h.instance || ('sc_' + h.self_number), state: 'sc', number: h.self_number }));
    // Rede de segurança: número que ACABOU de entregar mensagem está vivo por definição, mesmo que
    // o heartbeat falhe (ex.: painel antigo sem __zvGetSelfNumber). Nunca mostrar "parado" pra quem
    // está entregando captura pro servidor agora.
    try {
      const vistos = {}; scConns.forEach(c => { vistos[String(c.number)] = 1; });
      const ing = await env.DB.prepare("SELECT DISTINCT self_number FROM sc_ingest_audit WHERE source='sc' AND received_at > strftime('%s','now')-180").all();
      (ing.results || []).forEach(r => {
        const n = String(r.self_number || ''); if (!n || vistos[n]) return;
        scConns.push({ instance: 'sc_' + n, state: 'sc', number: n });
      });
    } catch (_) {}
    // instância ÚNICA por número: os 2 números do MESMO vendedor não podem colapsar numa chave só.
    // O frontend monta _waConnMap por instance — se colidir, um dos números some da lista e o card
    // mostra "WhatsApp parado" com o Sale Chat rodando normalmente.
    const _seenInst = {};
    scConns.forEach(c => { if (_seenInst[c.instance]) c.instance = 'sc_' + c.number; _seenInst[c.instance] = 1; });
  } catch (_) {}
  const mergeSc = (list) => {
    const scKeys = {}; scConns.forEach(c => { const k = _waNumKey(c.number); if (k) scKeys[k] = 1; });
    const byInst = {};
    (list || []).forEach(c => {
      const k = _waNumKey(c.number);
      if (k && scKeys[k]) return;   // Sale Chat manda nesse número: não deixa linha velha da Evolution mascarar
      byInst[c.instance] = c;
    });
    scConns.forEach(c => { byInst[c.instance] = c; });   // Sale Chat rodando ganha da Evolution
    return Object.values(byInst);
  };
  // Estado REAL + número conectado direto da Evolution; grava no wa_conn (pra roleta usar também).
  // Com a captura 100% no Sale Chat a Evolution sai de cena: não consulta, não grava e não mostra
  // conexão fantasma dela na tela. O Baileys é o maior risco de ban, então nada aqui pode dar a
  // impressão de que ele ainda faz parte da operação.
  const _src = await _waCaptureSource(env);
  try {
    const live = _src === 'sc' ? null : await _evoInstances(env);
    if (live && live.length) {
      for (const it of live) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_conn (instance, state, number, updated_at) VALUES (?, ?, ?, strftime('%s','now'))
             ON CONFLICT(instance) DO UPDATE SET state=excluded.state, number=excluded.number, updated_at=excluded.updated_at`
          ).bind(it.name, String(it.state), it.number || '').run();
        } catch (_) {}
      }
      return json({ ok: true, sat, conn: mergeSc(live.map(it => ({ instance: it.name, state: it.state, number: it.number }))) });
    }
  } catch (_) {}
  // fallback: Evolution não respondeu → usa o DB (que ja tem os heartbeats do Sale Chat)
  // NÚMERO CAPTURANDO SEM DONO: o chip perdeu o atendente na Contingência mas o Sale Chat continua
  // rodando nele. Sem dono o servidor joga tudo em quarentena e LEAD E VENDA SOMEM EM SILÊNCIO
  // (caso real: 2 vendas de R$697 perdidas). Isso tem que aparecer na cara do Diretor.
  let semDono = [];
  try {
    const sd = await env.DB.prepare("SELECT self_number FROM sc_heartbeat WHERE at_id IS NULL AND last_seen > strftime('%s','now')-600").all();
    semDono = (sd.results || []).map(r => String(r.self_number || '')).filter(Boolean);
  } catch (_) {}
  const rows = await env.DB.prepare('SELECT instance, state, number, updated_at FROM wa_conn').all();
  // 'sc' velho = Sale Chat que parou de reportar. A linha fica gravada, então sem checar a idade
  // o número aparecia "WhatsApp rodando" depois de ter caído. Vencido vira 'close' (vermelho).
  const nowS = Math.floor(Date.now() / 1000);
  const limpos = (rows.results || [])
    // com a fonte no Sale Chat, linha da Evolution não aparece mais como conexão da operação
    .filter(r => _src !== 'sc' || String(r.state) === 'sc')
    .map(r => ((nowS - Number(r.updated_at || 0)) > 180) ? { ...r, state: 'close' } : r);
  return json({ ok: true, sat, semDono, conn: mergeSc(limpos) });
}

// ─── Sale Chat (soundboard) ──────────────────────────────────
// GET /api/salechat → config do Sale Chat (mensagens de texto + funis/sequencias)
// que o Diretor edita na dash (fica em DB.salechat, salvo pelo sync normal).
// Publico de proposito: sao roteiros de venda, nao dado sensivel; o injetor
// (Node) e a extensao puxam isso pra montar o painel dentro do WhatsApp.
async function handleSaleChatGet(req, env) {
  const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let state = {}; try { state = JSON.parse(row?.data || '{}'); } catch (_) {}
  // Perfis independentes: vendedores (state.salechat) e cobradores (state.salechatCob).
  const perfil = ((new URL(req.url)).searchParams.get('perfil') || 'vendedores');
  const cob = perfil === 'cobradores';
  // Os bots recebem o que foi PUBLICADO (botão "Salvar e publicar" na dash), NAO o rascunho.
  // Fallback pro rascunho so na transicao (antes da 1a publicacao existir).
  const pub = cob ? state.salechatCobPub : state.salechatPub;
  const draft = cob ? state.salechatCob : state.salechat;
  const sc = (pub || draft || {});
  return json({
    ok: true,
    perfil: perfil === 'cobradores' ? 'cobradores' : 'vendedores',
    messages: Array.isArray(sc.messages) ? sc.messages : [],
    sequences: Array.isArray(sc.sequences) ? sc.sequences : [],
    media: Array.isArray(sc.media) ? sc.media : [],
    triggers: Array.isArray(sc.triggers) ? sc.triggers : [],
    updated_at: sc.updated_at || 0,
    ingest_token: await _scIngestToken(env),   // MODO TESTE: o injetor pega o token de captura daqui (travar antes de producao real)
  });
}
// POST /api/salechat/media (Diretor) → sobe um arquivo pro R2. Body = bytes crus,
// Content-Type = mime do arquivo. Devolve a key; a dash guarda a metadata em DB.salechat.
async function handleSaleChatMediaUpload(req, env) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode subir mídia', 403);
  if (!env.MEDIA) return err('Armazenamento (R2) não configurado', 503);
  const mime = req.headers.get('content-type') || 'application/octet-stream';
  const buf = await req.arrayBuffer();
  if (!buf || buf.byteLength === 0) return err('Arquivo vazio', 400);
  if (buf.byteLength > 60 * 1024 * 1024) return err('Arquivo grande demais (máx 60MB)', 413);
  const ext = mime.indexOf('audio') >= 0 ? 'ogg' : mime.indexOf('video') >= 0 ? 'mp4' : mime.indexOf('png') >= 0 ? 'png' : (mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0) ? 'jpg' : mime.indexOf('pdf') >= 0 ? 'pdf' : 'bin';
  const key = 'm/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
  try { await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } }); }
  catch (e) { return err('Falha ao salvar no R2: ' + (e.message || ''), 502); }
  return json({ ok: true, key, mime, size: buf.byteLength });
}
// GET /api/salechat/media/<key> → serve a mídia do R2 (público; o injetor puxa por aqui)
async function handleSaleChatMediaGet(req, env, key) {
  if (!env.MEDIA) return err('R2 não configurado', 503);
  try {
    const obj = await env.MEDIA.get(key);
    if (!obj) return err('Mídia não encontrada', 404);
    return new Response(obj.body, { headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=86400',
      'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
    } });
  } catch (e) { return err('Erro ao ler mídia: ' + (e.message || ''), 502); }
}
// DELETE /api/salechat/media/<key> (Diretor)
async function handleSaleChatMediaDelete(req, env, key) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor', 403);
  if (env.MEDIA) { try { await env.MEDIA.delete(key); } catch (_) {} }
  return json({ ok: true });
}

// ─── Inbox / Conversas (CRM) ─────────────────────────────────
// GET /api/wa/chats?instance=&assigned=&q= → lista de conversas pro inbox
async function handleWAChats(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _waEnsureTables(env);
  const url = new URL(req.url);
  const inst = (url.searchParams.get('instance') || '').trim();
  const assigned = (url.searchParams.get('assigned') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();
  let sql = 'SELECT phone, instance, name, last_text, last_ts, last_dir, unread, assigned_to FROM wa_chats';
  const where = [], binds = [];
  if (inst) { where.push('instance = ?'); binds.push(inst); }
  if (assigned) { where.push('assigned_to = ?'); binds.push(assigned); }
  if (q) { where.push('(name LIKE ? OR phone LIKE ?)'); binds.push('%' + q + '%', '%' + q.replace(/\D/g, '') + '%'); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY last_ts DESC LIMIT 300';
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return json({ ok: true, chats: rows.results || [] });
}
// GET /api/wa/messages?phone=&limit= → thread de uma conversa
async function handleWAMessages(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _waEnsureTables(env);
  const url = new URL(req.url);
  const phone = String(url.searchParams.get('phone') || '').replace(/\D/g, '');
  if (!phone) return err('phone obrigatório');
  const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
  const rows = await env.DB.prepare(
    'SELECT msg_id, phone, instance, direction, type, body, push_name, ts FROM wa_messages WHERE phone = ? ORDER BY ts ASC LIMIT ?'
  ).bind(phone, limit).all();
  const chat = await env.DB.prepare('SELECT phone, instance, name, unread, assigned_to FROM wa_chats WHERE phone = ?').bind(phone).first();
  return json({ ok: true, phone, chat: chat || null, messages: rows.results || [] });
}
// POST /api/wa/chat/read { phone } → zera o não-lido
async function handleWAChatRead(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _waEnsureTables(env);
  const body = await req.json().catch(() => null);
  const phone = String(body?.phone || '').replace(/\D/g, '');
  if (!phone) return err('phone obrigatório');
  await env.DB.prepare('UPDATE wa_chats SET unread = 0 WHERE phone = ?').bind(phone).run();
  return json({ ok: true });
}
// POST /api/wa/chat/assign { phone, user_id|null } → distribui a conversa pro vendedor
async function handleWAChatAssign(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _waEnsureTables(env);
  const body = await req.json().catch(() => null);
  const phone = String(body?.phone || '').replace(/\D/g, '');
  if (!phone) return err('phone obrigatório');
  const assigned = body?.user_id == null || body.user_id === '' ? null : String(body.user_id);
  await env.DB.prepare("UPDATE wa_chats SET assigned_to = ?, updated_at = strftime('%s','now') WHERE phone = ?").bind(assigned, phone).run();
  return json({ ok: true });
}
// Detecta VENDA pela mensagem de confirmação ("Pedido Concluído", enviada após o
// cliente aceitar o termo). Registra em wa_sales (dedupe por telefone/24h).
async function _waDetectSale(env, instance, data) {
  const m = data?.message || {};
  const text = m.conversation || m.extendedTextMessage?.text || '';
  if (!text || text.indexOf('Pedido Conclu') < 0) return { sale: false }; // assinatura da venda
  const key = data?.key || {};
  const jid = String(key.remoteJid || '');
  if (!jid || jid.indexOf('@g.us') >= 0) return { sale: false };   // ignora grupo (senão "Pedido Conclu" em grupo vira venda fantasma)
  const phone = String(key.remoteJidAlt || key.remoteJid || '').split('@')[0].replace(/\D/g, '');
  if (!phone) return { sale: false };
  const name = ((text.match(/Nome:\s*([^\n📍📲⭐]+)/i) || [])[1] || '').trim();
  const valM = text.match(/Valor do Pedido:\s*R\$?\s*([\d.,]+)/i);
  const value = valM ? Number(valM[1].replace(/\./g, '').replace(',', '.')) : 0;
  const msgId = (key && key.id) || null;
  // Ponte de atribuição: grava CPF → atendente (a instância = quem atendeu).
  const cpfDetect = extractCpf(text);
  if (cpfDetect) await saveCpfAttrib(env, cpfDetect, instance, name, phone);
  try {
    if (!_saleTablesOk) {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_sales (phone TEXT, instance TEXT, name TEXT, value REAL, ts INTEGER)').run();
      try{ await env.DB.prepare('ALTER TABLE wa_sales ADD COLUMN msg_id TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE wa_sales ADD COLUMN raw TEXT').run(); }catch(_){}   // texto completo do "Pedido Concluído" (pra revisar na dash)
      try{ await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_sales_msgid ON wa_sales(msg_id)').run(); }catch(_){}
      _saleTablesOk = true;
    }
    // Trava de 24h POR PEDIDO, não por telefone. Antes qualquer 2ª venda do mesmo número em 24h era
    // descartada: se o cliente comprava DE NOVO no mesmo dia, a venda sumia da dash e do TikTok.
    // Agora só é considerada repetição o mesmo pedido recolado pelo atendente (mesmo valor E mesmo
    // CPF). Valor ou CPF diferente = pedido novo de verdade → registra e dispara o CompletePayment.
    const rec = await env.DB.prepare("SELECT value, raw FROM wa_sales WHERE phone=? AND ts > strftime('%s','now')-86400 LIMIT 10").bind(phone).all();
    const dupe = (rec.results || []).some(r => {
      const sameVal = Math.abs((Number(r.value) || 0) - (Number(value) || 0)) < 0.01;
      const sameCpf = (extractCpf(String(r.raw || '')) || '') === (cpfDetect || '');
      return sameVal && sameCpf;
    });
    if (dupe) return { sale: true, value }; // mesmo pedido já registrado nas últimas 24h
    // idempotente por msg_id: reentrega do mesmo webhook não conta 2x nem dispara 2 CompletePayment
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO wa_sales (phone, instance, name, value, ts, msg_id, raw) VALUES (?,?,?,?,strftime('%s','now'),?,?)").bind(phone, instance, name, value, msgId, String(text||'').slice(0,2000)).run();
    if (ins.meta && ins.meta.changes === 0) return { sale: true, value }; // msg_id repetido → já registrada
    await _ttFireSale(env, phone, (value > 0 ? value : null), msgId || '', instance);   // venda pro pixel (sem value 0 se o parse falhar)
    return { sale: true, value };   // registrada agora
  } catch (_) { return { sale: true, value, error: true }; }
}

// ─── Respostas automáticas ───────────────────────────────────────────────────────────────
// Configuradas na dash (Sale Chat > Respostas automáticas, perfil vendedores). Quando o VENDEDOR
// envia uma mensagem com a palavra-gatilho (ex: "Pedido Concluído"), a API responde sozinha pro
// cliente com um texto e, se configurado, um CARD DE CONTATO (ex: o rapaz da entrega/cobrança).
async function _evoSendContact(env, instance, to, name, number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return;
  const wuid = digits.length <= 11 ? ('55' + digits) : digits;   // garante DDI 55
  await evoFetch(env, `/message/sendContact/${encodeURIComponent(instance)}`, {
    method: 'POST',
    body: { number: to, contact: [{ fullName: String(name || 'Contato'), wuid, phoneNumber: '+' + wuid }] },
  });
}
async function _waAutoReplies(env, instance, data, ctx) {
  try {
    const key = data?.key || {};
    if (!key.fromMe) return;                              // só dispara na mensagem DO VENDEDOR (saída)
    const jid = String(key.remoteJid || '');
    if (!jid || jid.indexOf('@g.us') >= 0) return;        // ignora grupo
    const m = data?.message || {};
    const text = (m.conversation || m.extendedTextMessage?.text || '').toLowerCase();
    if (!text) return;
    const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
    let st = {}; try { st = JSON.parse(row?.data || '{}'); } catch (_) {}
    const sc = st.salechatPub || st.salechat || {};       // publicado (vendedores)
    const replies = Array.isArray(sc.autoreplies) ? sc.autoreplies : [];
    if (!replies.length) return;
    const to = String(key.remoteJidAlt || key.remoteJid || '').split('@')[0].replace(/\D/g, '');
    if (!to) return;
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_autoreply_log (k TEXT PRIMARY KEY, ts INTEGER)').run();
    for (const rp of replies) {
      if (!rp || rp.on === false) continue;
      const kws = String(rp.trigger || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (!kws.length || !kws.some(k => text.indexOf(k) >= 0)) continue;
      // dedup GRAVADO JÁ (antes do delay): se o webhook reentregar nos próximos segundos, não agenda 2x.
      const dk = 'ar_' + (rp.id || '') + '_' + to;
      const recent = await env.DB.prepare("SELECT ts FROM wa_autoreply_log WHERE k=? AND ts > strftime('%s','now')-21600").bind(dk).first();
      if (recent) continue;
      await env.DB.prepare("INSERT INTO wa_autoreply_log (k, ts) VALUES (?, strftime('%s','now')) ON CONFLICT(k) DO UPDATE SET ts=strftime('%s','now')").bind(dk).run();
      // Espera antes de enviar (padrão 10s, mais humano). Roda em segundo plano (ctx.waitUntil):
      // o webhook responde na hora e o envio dispara depois — sem segurar a conexão da Evolution.
      const delayMs = Math.max(0, Math.min(90, (rp.delaySec == null ? 10 : Number(rp.delaySec) || 0))) * 1000;
      const send = async () => {
        try {
          if (delayMs) await new Promise(r => setTimeout(r, delayMs));
          if (rp.text && String(rp.text).trim()) {
            try { await evoFetch(env, `/message/sendText/${encodeURIComponent(instance)}`, { method: 'POST', body: { number: to, text: String(rp.text) } }); } catch (_) {}
          }
          if (rp.contactNumber && String(rp.contactNumber).replace(/\D/g, '')) {
            try { await _evoSendContact(env, instance, to, rp.contactName || 'Contato', rp.contactNumber); } catch (_) {}
          }
        } catch (_) {}
      };
      if (ctx && ctx.waitUntil) ctx.waitUntil(send()); else await send();
    }
  } catch (_) {}
}
// Envia um evento pro TikTok Events API (server-side). Telefone hasheado (advanced matching);
// inclui ttclid quando temos (atribuição precisa ao anúncio).
// Tabela de conferencia dos eventos mandados pro TikTok. Antes o envio era "manda e esquece":
// erro de rede, token vencido ou recusa do TikTok sumiam no catch e a venda NUNCA era remandada,
// sem ninguem ficar sabendo. Agora cada envio fica registrado com o resultado, e o que falhou o
// cron reenvia sozinho. Reenvio e SEGURO: vai com o MESMO event_id, e o TikTok deduplica por ele
// (nao conta a venda 2x).
let _ttTableOk = false;   // roda no caminho de TODO lead: cria a tabela 1x por isolate, não a cada evento
async function _ttEnsureTable(env) {
  if (_ttTableOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tt_events (
    event_id TEXT PRIMARY KEY, event TEXT, phone TEXT, value REAL, ttclid TEXT,
    pid TEXT, instance TEXT, status TEXT, code TEXT, msg TEXT,
    tries INTEGER DEFAULT 0, ts INTEGER, next_try INTEGER)`).run();
  _ttTableOk = true;   // só marca DEPOIS de criar: se falhar, a próxima chamada tenta de novo
  // Índice do reenvio: sem ele o cron varria a tabela inteira a cada 2min pra achar 0 falhas.
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tt_retry ON tt_events(status, next_try)").run(); } catch (_) {}
}
// Envia e CONFERE a resposta. Atencao: o TikTok responde HTTP 200 mesmo recusando o evento —
// o que vale e o campo "code" do corpo (0 = aceito). Antes so o status HTTP era olhado (e nem isso).
async function _ttSend(env, pixel, token, event, phoneDigits, opts) {
  opts = opts || {};
  if (!phoneDigits) return { ok: false, code: 'sem_telefone' };
  const evId = String(opts.eventId || (event + '_' + phoneDigits));
  if (!pixel || !token) {
    // Sem pixel/token nao da nem pra tentar: registra como pendente pro cron tentar depois
    // (ex: a pressel ainda nao tinha token configurado na hora da venda).
    try {
      await _ttEnsureTable(env);
      await env.DB.prepare(`INSERT INTO tt_events (event_id,event,phone,value,ttclid,pid,instance,status,code,msg,tries,ts,next_try)
        VALUES (?,?,?,?,?,?,?, 'erro','sem_pixel','pressel sem pixel/token na hora do envio',0,strftime('%s','now'),strftime('%s','now')+300)
        ON CONFLICT(event_id) DO NOTHING`)
        .bind(evId, event, String(phoneDigits), (opts.value == null ? null : Number(opts.value)), String(opts.ttclid || ''), String(opts.pid || ''), String(opts.instance || '')).run();
    } catch (_) {}
    return { ok: false, code: 'sem_pixel' };
  }
  let ok = false, code = '', msg = '';
  try {
    const user = { phone: await sha256Hex('+' + phoneDigits) };
    if (opts.ttclid) user.ttclid = String(opts.ttclid);
    const ev = { event, event_time: Math.floor((opts.eventTime ? Number(opts.eventTime) : Date.now() / 1000)), event_id: evId, user };
    if (opts.value != null) ev.properties = { currency: 'BRL', value: Number(opts.value) || 0, content_type: 'product' };
    const body = { event_source: 'web', event_source_id: pixel, data: [ev] };
    const r = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await r.text();
    let j = {}; try { j = JSON.parse(txt); } catch (_) {}
    code = String(j.code != null ? j.code : r.status);
    msg = String(j.message || '').slice(0, 180);
    ok = (r.ok && String(j.code) === '0');            // 0 = aceito de verdade
    console.log('TTEV', event, 'http=' + r.status, 'code=' + code, msg.slice(0, 60));
  } catch (e) { code = 'rede'; msg = String((e && e.message) || e).slice(0, 180); }
  // Registra o resultado. Se falhou, o cron reenvia (backoff: 5min, 10min, 20min...).
  try {
    await _ttEnsureTable(env);
    await env.DB.prepare(`INSERT INTO tt_events (event_id,event,phone,value,ttclid,pid,instance,status,code,msg,tries,ts,next_try)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'),?)
      ON CONFLICT(event_id) DO UPDATE SET status=excluded.status, code=excluded.code, msg=excluded.msg,
        tries=tt_events.tries+1, next_try=excluded.next_try`)
      .bind(evId, event, String(phoneDigits), (opts.value == null ? null : Number(opts.value)), String(opts.ttclid || ''),
            String(opts.pid || ''), String(opts.instance || ''), ok ? 'ok' : 'erro', code, msg, ok ? 0 : 1,
            ok ? 0 : (Math.floor(Date.now() / 1000) + 300)).run();
  } catch (_) {}
  return { ok, code, msg };
}
// Reenvia o que falhou (roda no cron). Mesmo event_id -> o TikTok deduplica, entao nao conta 2x.
async function _ttRetryFailed(env) {
  try {
    await _ttEnsureTable(env);
    const rows = await env.DB.prepare(
      `SELECT * FROM tt_events WHERE status='erro' AND tries < 6 AND COALESCE(next_try,0) <= strftime('%s','now')
       ORDER BY ts ASC LIMIT 20`).all();
    for (const e of (rows.results || [])) {
      const { pixel, token } = await _ttPixelToken(env, e.pid || '', e.instance || '');
      if (!pixel || !token) {   // ainda sem pixel: adia sem gastar tentativa
        try { await env.DB.prepare("UPDATE tt_events SET next_try=strftime('%s','now')+1800 WHERE event_id=?").bind(e.event_id).run(); } catch (_) {}
        continue;
      }
      const backoff = Math.min(3600, 300 * Math.pow(2, Number(e.tries) || 0));
      const res = await _ttSend(env, pixel, token, e.event, e.phone, {
        value: e.value, ttclid: e.ttclid || '', eventId: e.event_id, pid: e.pid, instance: e.instance,
        eventTime: e.ts,                      // hora REAL do evento (nao a do reenvio)
      });
      if (!res.ok) { try { await env.DB.prepare("UPDATE tt_events SET next_try=strftime('%s','now')+? WHERE event_id=?").bind(backoff, e.event_id).run(); } catch (_) {} }
    }
  } catch (_) {}
}
// Resolve pixel+token: 1) da pressel (pid) se tiver os dois; 2) da pressel do vendedor (ax_<at>); 3) global.
async function _ttPixelToken(env, pid, instance) {
  let pixel = '', token = '';
  try {
    const data = await _getDashData(env);   // cacheado: era parseado por lead (1.3MB), estourava CPU no lote
    const pressels = Array.isArray(data.pressels) ? data.pressels : [];
    let p = pid ? pressels.find(x => String(x.id) === String(pid) && x.pixel_tt && x.pixel_tt_token) : null;
    if (!p && instance) {
      // fallback pelo vendedor: SÓ se ele estiver em UMA pressel com pixel (senão mandaria pro pixel/BM errado)
      const at = String(instance).replace(/^ax_/, '').replace(/_b$/, '');   // número backup (ax_<at>_b) cai no mesmo vendedor
      const cand = pressels.filter(x => x.pixel_tt && x.pixel_tt_token && (x.vendedores || []).some(v => String(v.at) === at && v.ativo !== false));
      if (cand.length === 1) p = cand[0];
    }
    if (p) { pixel = String(p.pixel_tt); token = String(p.pixel_tt_token); }
  } catch (_) {}
  if (!pixel || !token) { pixel = await _readConfig(env, 'tt_pixel_id'); token = await _readConfig(env, 'tt_access_token'); }
  return { pixel, token };
}
// Tipos que o WhatsApp Web emite mas que NÃO são mensagem de gente: ruído de protocolo. Se um
// desses criar o lead, ele nasce sem texto e sem código, e a mensagem real é descartada depois.
// ATENÇÃO: 'ciphertext' NÃO entra aqui. Ele parece ruído (body vazio) mas é a mensagem REAL do lead
// ainda não decifrada, e medido em produção só 12 de 2.002 ganham uma versão legível depois — o
// injetor captura uma vez e o dedup por msgId barra a reemissão. Descartar ciphertext apagaria
// ~2.000 leads reais. O tratamento certo dele é o caminho de UPGRADE mais abaixo.
const _WA_NAO_MSG = new Set(['e2e_notification', 'notification_template', 'protocol',
  'gp2', 'broadcast_notification', 'call_log', 'revoked', 'unknown', 'gp', 'newsletter_notification']);
// LEAD: na 1ª mensagem do número, casa com o clique pelo CÓDIGO no texto (atribuição EXATA).
// Quem manda sem código (lead antigo, indicação, orgânico) não veio de pressel → não conta. 1x por número.
async function _waLeadCapture(env, instance, phone, body, selfNum, msgType, msgTs) {
  try {
    // GUARDA 1 — evento de PROTOCOLO não é mensagem de lead.
    // O Sale Chat encaminha tudo que o WhatsApp Web emite, e ~94% do volume é ruído de protocolo:
    // 'ciphertext' (mensagem ainda não decifrada, chega ANTES da versão legível), 'e2e_notification'
    // (troca de chave) e 'notification_template'. Como esses vêm com body VAZIO e chegam primeiro,
    // o lead era criado sem texto, o código nunca era lido, e a mensagem de verdade caía no
    // `exists` e era ignorada. Foi isso que zerou a atribuição por código em 20/07.
    const _t = String(msgType || '').toLowerCase();
    if (_t && _WA_NAO_MSG.has(_t)) return;
    // GUARDA 2 — sincronização de histórico não é lead novo.
    // Quando um número reconecta, o injetor despeja a conversa inteira (855 msgs em 11min no
    // número de cobrança em 21/07) e cada contato antigo virava "lead novo sem rastreio", inflando
    // a métrica do gestor de tráfego. Mensagem com mais de 15min de idade é histórico, não lead.
    const _ts = Number(msgTs) || 0;
    if (_ts > 0 && (Math.floor(Date.now() / 1000) - _ts) > 900) return;
    if (!_leadTablesOk) {   // DDL uma vez por isolate (era causa do 1102 no lote de captura)
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_lead (phone TEXT PRIMARY KEY, pid TEXT, ttclid TEXT, ts INTEGER)').run();
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN inst TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}   // origem da atribuição: 'code' (exato) | 'fifo' (clique recente no mesmo número)
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN num TEXT').run(); }catch(_){}   // número (do atendente) que recebeu o lead — pra dividir por número na visão de Leads
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS tt_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, inst TEXT, ttclid TEXT, pid TEXT, ts INTEGER, claimed INTEGER DEFAULT 0)').run();
      try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN code TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN num_key TEXT').run(); }catch(_){}   // número que recebeu o clique (últimos 8 dígitos)
      _leadTablesOk = true;
    }
    // O código precisa ser lido ANTES do `exists`, senão o caminho de upgrade nunca acontece.
    const codeM = String(body || '').match(/desconto[^A-Za-z0-9]{0,4}([A-Za-z0-9]{4,12})/i);
    const code = codeM ? codeM[1] : '';
    const exists = await env.DB.prepare('SELECT phone, pid, ttclid, src FROM wa_lead WHERE phone=?').bind(phone).first();
    // UPGRADE: o lead pode ter nascido de um evento sem texto (ciphertext chega cifrado e o injetor
    // só manda uma vez). Nesse caso ele entrou por chute do FIFO, ou sem rastreio nenhum. Quando a
    // mensagem legível com o código aparece depois, ela CORRIGE a atribuição em vez de ser jogada
    // fora. Sem código novo não há o que melhorar, e quem já está em 'code' é exato: sai fora.
    if (exists && (exists.src === 'code' || !code)) return;
    const isUpgrade = !!exists;
    // 1) casa pelo CÓDIGO da mensagem (ex: Código de desconto "k2EGu"!) — atribuição EXATA.
    let ttclid = '', pid = '', src = '';
    if (code) {
      try {
        const cl = await env.DB.prepare("UPDATE tt_pending SET claimed=1 WHERE id=(SELECT id FROM tt_pending WHERE code=? AND (claimed IS NULL OR claimed=0) ORDER BY ts DESC LIMIT 1) RETURNING ttclid, pid").bind(code).first();
        if (cl) { ttclid = cl.ttclid || ''; pid = cl.pid || ''; src = 'code'; }
      } catch (_) {}
    }
    // 2) FALLBACK (sem código): casa com o clique recente NÃO reivindicado no MESMO número (janela 60min, o mais antigo).
    // Recupera o lead que apagou o código. Vale porque esses números só recebem tráfego de pressel.
    // Casa primeiro pelo NÚMERO que atendeu, não pelo slot. Trocar um número de principal↔
    // complementar muda a instância (ax_<at> ↔ ax_<at>_b) e os cliques ficavam órfãos no slot
    // antigo: o lead chegava e entrava "sem rastreio", sem pixel e sem saber de qual pressel veio.
    // No UPGRADE os fallbacks ficam DE FORA de propósito: o lead já tem uma atribuição por chute, e
    // deixar ele reivindicar outro clique roubaria a linha de um lead novo de verdade. No upgrade só
    // vale o que é exato: o código, ou a letra dele.
    const nk = String(selfNum || '').replace(/\D/g, '').slice(-8);
    if (!isUpgrade && !pid && nk) {
      try {
        const fb = await env.DB.prepare("UPDATE tt_pending SET claimed=1 WHERE id=(SELECT id FROM tt_pending WHERE num_key=? AND (claimed IS NULL OR claimed=0) AND ts > strftime('%s','now')-3600 ORDER BY (ttclid IS NOT NULL AND ttclid<>'') DESC, ts ASC LIMIT 1) RETURNING ttclid, pid").bind(nk).first();
        if (fb) { ttclid = fb.ttclid || ''; pid = fb.pid || ''; src = 'fifo'; }
      } catch (_) {}
    }
    // fallback: linhas antigas, gravadas antes do num_key existir
    if (!isUpgrade && !pid) {
      try {
        const fb = await env.DB.prepare("UPDATE tt_pending SET claimed=1 WHERE id=(SELECT id FROM tt_pending WHERE inst=? AND (claimed IS NULL OR claimed=0) AND ts > strftime('%s','now')-3600 ORDER BY (ttclid IS NOT NULL AND ttclid<>'') DESC, ts ASC LIMIT 1) RETURNING ttclid, pid").bind(instance).first();
        if (fb) { ttclid = fb.ttclid || ''; pid = fb.pid || ''; src = 'fifo'; }
      } catch (_) {}
    }
    // último recurso: clique de QUALQUER número do MESMO vendedor (principal ou complementar).
    // O número pode ter trocado de papel entre o clique e a mensagem, e aí o clique fica no slot
    // antigo. Dentro do mesmo vendedor a origem do tráfego é a mesma, então casar ali é honesto
    // e recupera o lead que entraria como "sem rastreio".
    if (!isUpgrade && !pid && instance) {
      const base = String(instance).replace(/_b$/, '');
      try {
        const fb = await env.DB.prepare("UPDATE tt_pending SET claimed=1 WHERE id=(SELECT id FROM tt_pending WHERE (inst=? OR inst=?) AND (claimed IS NULL OR claimed=0) AND ts > strftime('%s','now')-3600 ORDER BY (ttclid IS NOT NULL AND ttclid<>'') DESC, ts ASC LIMIT 1) RETURNING ttclid, pid").bind(base, base + '_b').first();
        if (fb) { ttclid = fb.ttclid || ''; pid = fb.pid || ''; src = 'fifo'; }
      } catch (_) {}
    }
    // REDE DE SEGURANÇA: o lead trouxe um código mas nenhuma linha casou (clique já reivindicado,
    // purgado pelos 7 dias, ou banco recriado). A 1ª letra do código diz a pressel, então dá pra
    // salvar a origem mesmo sem a linha. Perde-se o ttclid (logo o pixel), mas o gestor de tráfego
    // continua vendo de qual BM o lead veio — que é o ponto todo do código carregar a letra.
    if (!pid && code) {
      const pl = await _pidFromCode(env, code);
      if (pl) { pid = pl; src = 'letra'; }
    }
    // SEM NENHUMA atribuição (nem código, nem clique no número, nem no vendedor, nem pela letra) =
    // NÃO veio da pressel. É conversa antiga do chip, orgânico, ou replay do histórico do WhatsApp
    // quando o Sale Chat conecta num número que já era usado (caso real: 1422 mensagens antigas
    // entraram de uma vez e viraram 20 "leads sem rastreio" num número recém-trocado).
    // Não vira lead: a conversa continua no inbox, só não conta como lead de pressel nem suja a
    // contagem do número. Assim todo lead que aparece na tela É rastreado, como o Bruno quer.
    if (!pid && !ttclid) return;
    // Número que REALMENTE recebeu o lead. Prefere o que o Sale Chat informou (exato); só cai na
    // busca por instância quando não veio (Evolution). Derivar da instância carimbava o lead do
    // número complementar com o número do principal e escondia a divisão da roleta nas métricas.
    let num=String(selfNum||'').replace(/\D/g,'');
    if(!num){ try{ const cn=await env.DB.prepare('SELECT number FROM wa_conn WHERE instance=?').bind(instance).first(); num=(cn&&cn.number)||''; }catch(_){} }
    if (isUpgrade) {
      // corrige a atribuição do lead que já existia, sem mexer no ts (senão ele "renasce" e pula de
      // dia na métrica) nem no inst (quem atendeu não mudou por causa de uma mensagem nova).
      await env.DB.prepare("UPDATE wa_lead SET pid=?, ttclid=?, src=? WHERE phone=?").bind(pid, ttclid, src, phone).run();
    } else {
      await env.DB.prepare("INSERT OR IGNORE INTO wa_lead (phone, pid, ttclid, inst, src, num, ts) VALUES (?,?,?,?,?,?,strftime('%s','now'))").bind(phone, pid, ttclid, instance, src, num).run();
    }
    // só dispara evento de LEAD pro pixel quando existe ttclid (clique de anúncio rastreável).
    // Agora que TODO lead de pressel tem pid (inclusive orgânico), testar `pid` mandaria evento
    // sem ttclid pro TikTok — evento que ele não consegue atribuir e que só suja a otimização.
    // No upgrade só dispara se o lead AINDA NÃO tinha ttclid, pra não mandar o evento duas vezes.
    if (ttclid && !(exists && exists.ttclid)) {
      const { pixel, token } = await _ttPixelToken(env, pid, instance);
      await _ttSend(env, pixel, token, 'InitiateCheckout', phone, { ttclid, eventId: 'lead_' + phone, pid, instance });   // LEAD = InitiateCheckout (evento que o GT otimiza)
    }
  } catch (_) {}
}
// VENDA: usa a pressel/ttclid capturados do lead (wa_lead) e dispara pro pixel certo, com ttclid.
async function _ttFireSale(env, phone, value, eventId, instance) {
  try {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return;
    let ttclid = '', pid = '';
    try { const l = await env.DB.prepare('SELECT pid, ttclid FROM wa_lead WHERE phone=?').bind(digits).first(); if (l) { ttclid = l.ttclid || ''; pid = l.pid || ''; } } catch (_) {}
    // NÃO tentar adivinhar o ttclid da venda sem rastreio. Foi avaliado e REPROVADO em 22/07:
    // tt_pending nasce quando a PÁGINA da pressel carrega, não quando a pessoa abre o WhatsApp
    // (o `clicked=1` é que marca isso, e vem depois, por beacon). Entre uma coisa e outra o lead
    // assiste a VSL, o que leva minutos, e nesse meio tempo entram vários outros page views que
    // nunca viram lead. Logo "o clique mais próximo antes do contato" é quase sempre de OUTRA
    // pessoa: mandaria a venda pro criativo errado e ainda queimaria (claimed=1) o clique que era a
    // atribuição exata de um lead futuro, virando dois erros. Sem ttclid o TikTok ainda casa pelo
    // telefone hasheado; com ttclid de estranho, não tem conserto. Quem resolve isso de verdade é a
    // captura do CÓDIGO na 1ª mensagem, não palpite na hora da venda.
    // Venda SEM pressel identificada (lead sem rastreio, ou venda lançada na mão): antes caía no
    // pixel GLOBAL e a venda sumia da BM que realmente trouxe o lead — o gestor de tráfego via a
    // venda faltando. Agora deduz a pressel pelo tráfego REAL: a que mais mandou clique pros números
    // desse vendedor hoje. Não é exato, mas é muito melhor que jogar no pixel errado.
    if (!pid && instance) {
      try {
        const at = String(instance).replace(/^ax_/, '').replace(/_b$/, '');
        const dom = await env.DB.prepare(
          `SELECT p.pid, COUNT(*) n FROM tt_pending p
           JOIN wa_number_owner o ON substr(o.num_key,-8) = p.num_key
           WHERE o.at_id = ? AND p.ts > strftime('%s','now')-86400 AND p.pid IS NOT NULL AND p.pid<>''
           GROUP BY p.pid ORDER BY n DESC LIMIT 1`
        ).bind(at).first();
        if (dom && dom.pid) pid = String(dom.pid);
      } catch (_) {}
    }
    const { pixel, token } = await _ttPixelToken(env, pid, instance);
    await _ttSend(env, pixel, token, 'CompletePayment', digits, { value, ttclid, eventId, pid, instance });
  } catch (_) {}
}
// GET /api/wa/sales → vendas detectadas no WhatsApp (a dash mostra/usa)
async function handleWASales(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_sales (phone TEXT, instance TEXT, name TEXT, value REAL, ts INTEGER)').run();
    try{ await env.DB.prepare('ALTER TABLE wa_sales ADD COLUMN raw TEXT').run(); }catch(_){}   // garante a coluna pro SELECT
    try{ await env.DB.prepare('ALTER TABLE wa_sales ADD COLUMN msg_id TEXT').run(); }catch(_){}   // idem: sem ela o SELECT quebrava e a tela vinha VAZIA (sem erro)
    try{ await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_lead (phone TEXT PRIMARY KEY, pid TEXT, ttclid TEXT, ts INTEGER)').run(); }catch(_){}
    try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}   // garante l.src pro JOIN
    const params = new URL(req.url).searchParams;
    const day = params.get('day') || '', from = params.get('from') || '', to = params.get('to') || '';
    const D = /^\d{4}-\d{2}-\d{2}$/;
    let where = '', binds = [];
    if (D.test(from) && D.test(to)) {   // filtro por PERÍODO (BRT), inclusivo nas duas pontas
      const start = Math.floor(new Date(from+'T00:00:00-03:00').getTime()/1000);
      const end   = Math.floor(new Date(to  +'T00:00:00-03:00').getTime()/1000) + 86400;   // +1 dia p/ incluir o "to" inteiro
      where = 'WHERE s.ts>=? AND s.ts<?'; binds = [start, end];
    } else if (D.test(day)) {   // filtro por dia (BRT) — compat
      const start = Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), end = start + 86400;
      where = 'WHERE s.ts>=? AND s.ts<?'; binds = [start, end];
    }
    try { await _ttEnsureTable(env); } catch (_) {}   // garante o JOIN do status do TikTok
    // LEFT JOIN wa_lead pra saber se a venda veio de pressel (pid) — mostra "da pressel" vs "sem rastreio" na tela.
    // LEFT JOIN tt_events (pelo msg_id = event_id do envio) pra mostrar se o TikTok ACEITOU a venda.
    const stmt = env.DB.prepare(`SELECT s.rowid AS id, s.phone, s.instance, s.name, s.value, s.ts, s.raw,
        l.pid AS pid, l.src AS src, l.ttclid AS ttclid,
        t.status AS tt_status, t.code AS tt_code, t.msg AS tt_msg, t.tries AS tt_tries
      FROM wa_sales s LEFT JOIN wa_lead l ON l.phone=s.phone
      LEFT JOIN tt_events t ON t.event_id=s.msg_id AND t.event='CompletePayment'
      ${where} ORDER BY s.ts DESC LIMIT 1000`);
    const rows = await (binds.length ? stmt.bind(...binds) : stmt).all();
    return json({ ok: true, sales: rows.results || [] });
  } catch (e) { return json({ ok: true, sales: [] }); }
}
// POST /api/wa/sale/delete → { id } remove um pedido detectado (tira da contagem de vendas). Só diretor.
async function handleWASaleDelete(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode remover pedidos', 403);
  let body = {}; try { body = await req.json(); } catch (_) {}
  const id = Number(body?.id);
  if (!id) return err('id obrigatório');
  try { await env.DB.prepare('DELETE FROM wa_sales WHERE rowid=?').bind(id).run(); } catch (_) {}
  return json({ ok: true, id, removed: true });
}
// POST /api/wa/sale/add → { raw, at } adiciona um pedido MANUAL (indicação/orgânico).
// Faz o MESMO parse do "Pedido Concluído", grava em wa_sales no nome do vendedor
// escolhido, mas NÃO dispara o pixel do TikTok (não é venda de anúncio). Entra como
// "sem rastreio" e conta pro vendedor. Só diretor.
async function handleWASaleAdd(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode adicionar pedido', 403);
  const body = await req.json().catch(() => null);
  if (!body || !body.raw || !String(body.raw).trim()) return err('Cole a mensagem do "Pedido Concluído"');
  const text = String(body.raw);
  const at = String(body.at || '').trim();
  const instance = at ? ('ax_' + at) : 'manual';
  const name = ((text.match(/Nome:\s*([^\n📍📲⭐]+)/i) || [])[1] || '').trim();
  const valM = text.match(/Valor do Pedido:\s*R\$?\s*([\d.,]+)/i);
  const value = valM ? Number(valM[1].replace(/\./g, '').replace(',', '.')) : 0;
  // telefone do cliente: a linha do 📲, senão o 1º celular com DDD que aparecer.
  // A classe NÃO pode conter \n (senão varre a próxima linha e gruda dígitos de outro campo).
  let phone = '';
  const phM = text.match(/📲[^\d\n]*([\d()\-. ]{10,})/);
  if (phM) phone = phM[1].replace(/\D/g, '');
  if (!phone) { const any = text.match(/\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/); if (any) phone = any[0].replace(/\D/g, ''); }
  // CRÍTICO: normaliza pro MESMO formato do JID do WhatsApp (55+DDD+num), igual o caminho
  // automático (_waDetectSale usa os dígitos do remoteJid). Sem isso o telefone da venda
  // manual (sem 55) NUNCA casa: (1) fura o dedup de 24h → a mesma venda entra 2x quando o
  // webhook entrega atrasado; (2) não casa no JOIN com wa_lead → fica "sem rastreio" eterno
  // mesmo com o lead existindo. Era o bug que duplicou uma venda real.
  phone = waNumber(phone);
  const cpf = extractCpf(text);
  if (cpf && at) { try { await saveCpfAttrib(env, cpf, instance, name, phone); } catch (_) {} }
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_sales (phone TEXT, instance TEXT, name TEXT, value REAL, ts INTEGER)').run();
    try { await env.DB.prepare('ALTER TABLE wa_sales ADD COLUMN msg_id TEXT').run(); } catch (_) {}
    try { await env.DB.prepare('ALTER TABLE wa_sales ADD COLUMN raw TEXT').run(); } catch (_) {}
    const msgId = 'manual_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);   // único: não colide com o dedupe por msg_id
    // NÃO DUPLICAR: a venda pode já ter entrado sozinha com o telefone em OUTRO formato — o WhatsApp
    // às vezes entrega sem o 9º dígito (553196888246) e o texto do pedido traz com (5531996888246),
    // então comparar o telefone inteiro não pega. Compara pelos últimos 8 dígitos, que é o que
    // sempre bate. Aconteceu de verdade: o Diretor lançou na mão uma venda que já estava registrada.
    const k8v = String(phone || '').replace(/\D/g, '').slice(-8);
    if (k8v) {
      const ja = await env.DB.prepare(
        "SELECT phone, ts FROM wa_sales WHERE substr(replace(phone,'+',''),-8) = ? AND ts > strftime('%s','now')-86400 LIMIT 1"
      ).bind(k8v).first();
      if (ja) {
        return json({ ok: true, dup: true, name: name || 'Cliente', value, phone, at,
          msg: 'Esta venda já estava registrada (entrou pelo Sale Chat às ' + new Date((Number(ja.ts) - 10800) * 1000).toISOString().slice(11, 16) + ')' });
      }
    }
    await env.DB.prepare("INSERT INTO wa_sales (phone, instance, name, value, ts, msg_id, raw) VALUES (?,?,?,?,strftime('%s','now'),?,?)")
      .bind(phone || '', instance, name || 'Cliente', value, msgId, text.slice(0, 2000)).run();
    // Venda lançada na mão TAMBÉM dispara o pixel. O Diretor só lança quando a captura falhou, e sem
    // isso a BM nunca recebia o crédito dessa venda — foi o que aconteceu com 6 vendas num único dia.
    // _ttFireSale busca a origem em wa_lead; se não achar, deduz a pressel dominante do vendedor.
    try { await _ttFireSale(env, phone, value > 0 ? value : null, msgId, instance); } catch (_) {}
    return json({ ok: true, name: name || 'Cliente', value, phone, at, pixel: true });
  } catch (e) { return err('Falha ao salvar: ' + (e && e.message), 502); }
}
// POST /api/wa/sale/reassign → { id, at } troca o vendedor de um pedido (o número
// passou de mão e a venda caiu pro atendente errado). Só reatribui o crédito na dash;
// não mexe no pixel. Só diretor.
async function handleWASaleReassign(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor pode trocar o vendedor', 403);
  const body = await req.json().catch(() => null);
  const id = Number(body && body.id);
  const at = String((body && body.at) || '').trim();
  if (!id) return err('id obrigatório');
  if (!at) return err('vendedor (at) obrigatório');
  try {
    const r = await env.DB.prepare('UPDATE wa_sales SET instance=? WHERE rowid=?').bind('ax_' + at, id).run();
    if (!r.meta || r.meta.changes === 0) return err('Pedido não encontrado', 404);
  } catch (e) { return err('Falha ao trocar: ' + (e && e.message), 502); }
  return json({ ok: true, id, at });
}

// ─── Cérebro do bot de atendimento (IA) ──────────────────────
// Modelado no script oficial + conversas reais GlicoVax. Pré-qualifica
// e prepara handoff pro vendedor humano. Override via D1 (wa_bot_prompt).
const BOT_PROMPT_DEFAULT = `Você é atendente da equipe de saúde da GlicoVax, no WhatsApp, falando com pessoas que pediram informação sobre o tratamento natural GlicoVax (controle de açúcar no sangue e saúde do homem). Seu trabalho NÃO é fechar a venda: é acolher na hora, criar conexão, QUALIFICAR o lead e preparar pra um especialista ligar e finalizar. Você fala como gente de verdade, nunca como robô.

COMO VOCÊ FALA (É O QUE TE FAZ PARECER HUMANO, leve a sério):
- Mensagens CURTAS: no máximo 1 ou 2 frases curtas. Como gente conversa no zap, não um texto de venda. Texto longo entrega na hora que é robô.
- Tom informal e de pessoa real. Se souber o primeiro nome do lead, chame ele pelo nome ("seu João", "dona Maria") em vez de só "senhor". Emoji no máximo 1 de vez em quando.
- NUNCA cumprimente ou se apresente duas vezes. A saudação é só na PRIMEIRA mensagem da conversa.
- NUNCA repita uma pergunta que o lead já respondeu. Se ele já disse a dor (ex: ereção), siga em frente, não pergunte de novo.
- Se o lead mandar várias mensagens picadas ou curtas, entenda o conjunto e responda UMA vez só.
- Se ele já perguntou o preço, responda direto e simples, sem enrolar.
- Nada de linguagem de folheto ("vigor", "qualidade de vida", "age na causa" repetido). Fale simples, como um atendente de verdade.
- Uma ideia por mensagem. Responda só a próxima fala, curta.
- SEMPRE termine com uma PERGUNTA que leva a conversa adiante (aprofundar a dor, confirmar interesse, etc). Nunca deixe a conversa parada.
- Valide a dor com empatia antes de oferecer ("entendo, senhor, muita gente passa por isso..."), aí faça a próxima pergunta. Ex (áudio do lead dizendo que tá pra baixo e sem disposição): "Poxa, entendo, senhor. Essa falta de disposição e o desânimo são bem comuns em quem tá com o açúcar alterado. / Me diz: além disso, o senhor tem sentido formigamento, vontade de urinar de noite ou perda de firmeza?"

O PRODUTO (o que você sabe):
- GlicoVax: tratamento natural, composto por mais de 30 ervas medicinais. Vem em gotinhas: 15 gotas embaixo da língua, em jejum, todo dia. Atua na causa, não mascara.
- Ajuda no controle do açúcar no sangue, mais disposição, e na firmeza/desempenho do homem (chega a 20-40 min). Já na primeira semana costuma sentir diferença.
- Plano completo de 8 meses (8 frascos). É 8 meses porque o organismo precisa desse tempo pra responder de verdade. Por isso já mandamos o tratamento completo de uma vez.
- Valor: 12x de R$ 72 ou R$ 697 à vista.
- PAGAMENTO SÓ NA ENTREGA: não paga nada agora, paga quando o produto chegar em casa. Entrega de 10 a 12 dias úteis no endereço.
- Garantia: se fizer o protocolo de 8 meses e não resolver, o dinheiro volta.

SEU FLUXO (siga de forma natural, sem soar script):
1. Saudação acolhedora SÓ na primeira mensagem da conversa: "Olá! Aqui é da equipe de saúde da GlicoVax, vi que o senhor pediu informação sobre o tratamento." Logo em seguida já pergunte a dor: "Pra eu te ajudar melhor, o que mais tem te incomodado hoje? É mais a questão do açúcar no sangue ou a saúde e desempenho do homem?"
2. DEIXE o lead responder a dor. Não avance sem ouvir. Nunca repita essa pergunta se ele já respondeu.
3. Valide a dor com empatia e cite sintomas comuns (visão embaçada, formigamento nos pés, levantar de noite, cansaço, perder a firmeza). Mostre que entende e que tem solução.
4. Plante a esperança: explique simples que o GlicoVax é natural, atua na causa, e que já nas primeiras semanas costuma sentir melhora.
5. Apresente como funciona (gotinhas) e a condição: paga só na entrega, R$ 697 o tratamento de 8 meses, chega em casa. Deixe o pagamento na entrega MUITO claro.
6. QUALIFIQUE: confirme que o senhor topa receber e pagar na entrega E que está de acordo com o valor. Esse é o ponto-chave.
7. Quando ele confirmar que aceita pagar na entrega E aceita o valor, diga que vai pedir pro especialista ligar pra liberar o envio com segurança, e encerre seu papel marcando o handoff.

QUALIFICADO = o lead deixou claro que ACEITA PAGAR NA ENTREGA e ACEITA O VALOR do produto. Só aí ele está pronto pro vendedor.

HANDOFF: assim que o lead estiver qualificado, OU pedir pra comprar/fechar, OU pedir pra falar com alguém, OU fizer pergunta que você não deve responder (desconto especial, dúvida médica específica, mudar pedido) — responda algo curto e acolhedor avisando que um especialista vai falar com ele já já, e termine sua mensagem com a tag [HANDOFF] (essa tag é interna, o sistema remove antes de enviar).

COMO RESPONDER AS OBJEÇÕES (use o jeito, não decore):
- "Não tenho dinheiro agora": dá pra agendar o envio pra perto do dia que o senhor recebe, chega na hora certa, e só paga quando receber.
- "É muito tempo / por que não 1 mês": 8 meses é o que a equipe recomenda pra RESOLVER de verdade; menos que isso só alivia, não resolve. Por isso já mandamos o completo.
- "Tá caro": dividido dá só R$72 por mês, menos do que muita gente gasta com outras coisas, e o senhor só paga quando receber.
- "Medo de comprar pela internet": por isso não paga nada agora, recebe primeiro e paga depois. Mais seguro pro senhor.
- "Já usei outros e não funcionou": a maioria chega dizendo isso; o nosso resolve seguindo o protocolo de 8 meses, e se não resolver o dinheiro volta.
- "Vou pensar / falar com a esposa": pergunta com leveza se é pelo valor ou se ficou alguma dúvida; se for dúvida, esclareça na hora.
- "Posso buscar na clínica": não, trabalhamos só com entrega; chega lacrado em casa, recebe primeiro e paga depois.
- "Onde fica a clínica / onde é fabricado / quero pesquisar": diga que vai mandar as informações (endereço, médico responsável, composição) e marque [HANDOFF] pro especialista enviar.

PERGUNTAS COMUNS (responda com naturalidade, no mesmo tom, assim):
- "Tem efeito colateral?": Não. Não é remédio, é 100% natural, feito pra ajudar o organismo. Sem efeito colateral.
- "Posso tomar junto com o remédio que eu já tomo / que o médico passou?": Pode, tranquilo. Como é natural, não tem risco de usar junto com o que o senhor já toma.
- "Preciso parar meu remédio?": Não precisa parar nada. Quem orienta isso certinho é o especialista.
- "É natural mesmo? O que tem dentro?": É sim, mais de 30 ervas naturais. Posso te mandar a composição pra conferir.
- "Como toma?": É simples: 15 gotinhas embaixo da língua, todo dia de manhã ao acordar. Cada frasco é um mês de tratamento.
- "Como eu pago / qual a forma de pagamento?": O senhor paga só quando o produto chegar na sua casa. Aí nossa equipe liga, confere se veio tudo certinho, e combina a melhor forma de pagamento com o senhor.

NUNCA:
- Nunca prometa cura nem use a palavra "cura". Fale em "melhora" e "controle".
- Nunca dê diagnóstico ou conselho médico específico, nem mande parar remédio. Diga que o especialista orienta.
- Nunca invente preço, desconto ou prazo diferente do que está aqui. Na dúvida, [HANDOFF].
- Nunca mande link.
- Nunca diga que é inteligência artificial ou robô. Você é da equipe de saúde.

FORMATO DA RESPOSTA: responda como o atendente responderia agora, curto. Quando fizer sentido mandar em partes (como gente faz no zap), quebre em 2 ou 3 mensagens curtas separadas por uma linha só com "---". Nunca mande textão. Nada além das mensagens.`;

async function getBotPrompt(env) {
  return (await _readConfig(env, 'wa_bot_prompt')) || BOT_PROMPT_DEFAULT;
}

// POST /api/wa/bot/preview { message, history? } → resposta do bot SEM enviar (modo teste)
async function handleBotPreview(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const body = await req.json().catch(() => null);
  const message = String(body?.message || '').trim();
  if (!message) return err('Campo "message" obrigatório');
  const history = Array.isArray(body?.history) ? body.history : [];
  const gkey = await getAIKey(env, 'gemini');
  if (!gkey) return err('Gemini não configurado', 503);
  const prompt = await getBotPrompt(env);
  const contents = [];
  for (const h of history.slice(-12)) {
    contents.push({ role: (h.from === 'nos' || h.from === 'bot') ? 'model' : 'user', parts: [{ text: String(h.text || '') }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });
  const reqBody = {
    system_instruction: { parts: [{ text: prompt }] },
    contents,
    generationConfig: { temperature: 0.9, maxOutputTokens: 400 },
  };
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-2.5-flash-lite'];
  for (const mdl of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${gkey}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqBody),
      });
      if (!r.ok) { if ([429, 403, 404].includes(r.status)) continue; const t = await r.text(); return err(`Gemini ${r.status}: ${t.slice(0, 150)}`, 502); }
      const data = await r.json();
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const handoff = /\[HANDOFF\]/i.test(text);
      text = text.replace(/\[HANDOFF\]/ig, '').trim();
      return json({ ok: true, reply: text, handoff, model: mdl });
    } catch (e) { continue; }
  }
  return err('Todos os modelos Gemini falharam (quota)', 502);
}

// ─── Pressel pública (roleta de WhatsApp) ───
// Lead da campanha cai em /p/<id>, a roleta escolhe um número (o "em uso" de
// cada atendente ativo, pulando banido/restrito) e manda pro WhatsApp.
function _escHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function _waLink(num, msg){
  let d = String(num||'').replace(/\D/g,'');
  if(!d) return null;
  if(d.length<=11) d='55'+d;
  let u='https://wa.me/'+d;
  if(msg) u+='?text='+encodeURIComponent(msg);
  return u;
}
// Código curto (sem caracteres ambíguos) que vai no texto do WhatsApp pra casar o lead com o clique
function _genCode(n){ n=n||6; const cs='abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const a=new Uint8Array(n); crypto.getRandomValues(a); let s=''; for(let i=0;i<n;i++) s+=cs[a[i]%cs.length]; return s; }
// 1ª LETRA do código = a pressel de origem. Redundância proposital: mesmo que a linha do clique
// suma (purga de 7 dias, banco perdido), a própria mensagem do lead ainda diz de qual BM ele veio.
// Alfabeto sem I/O/Q pra não confundir com 1/0 quando alguém lê o código na tela.
const _PLET = 'ABCDEFGHJKLMNPRSTUVWXYZ';
function _presselLetter(pid){
  const s = String(pid == null ? '' : pid);
  const n = parseInt(s, 10);
  if (Number.isFinite(n) && n >= 1) return _PLET[(n - 1) % _PLET.length];   // id 1→A, 2→B, 3→C
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;   // id não-numérico → hash estável
  return _PLET[h % _PLET.length];
}
// Código = letra da pressel + aleatório. Mesmo tamanho de antes (6), então nada mais muda.
function _genLeadCode(pid){ return _presselLetter(pid) + _genCode(5); }
// Reverso: dado o código, descobre a pressel pela 1ª letra. Só roda no caminho frio (quando o
// clique não foi achado no banco), então pode ler o estado sem pesar no fluxo normal.
async function _pidFromCode(env, code){
  const L = String(code || '').charAt(0).toUpperCase();
  if (!L) return '';
  try {
    const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
    const st = row ? JSON.parse(row.data) : null;
    const ps = (st && st.pressels) || [];
    const hit = ps.filter(p => _presselLetter(p.id) === L);
    if (hit.length === 1) return String(hit[0].id);   // ambíguo (2 pressels na mesma letra) → não chuta
  } catch (_) {}
  return '';
}
// Resolve os números da roleta a partir do estado salvo (chips + vendedores)
function _resolvePresselNumbers(p, chips, liveSet){
  const out=[];
  for(const v of (p.vendedores||[])){
    if(v.ativo===false) continue;
    // se veio a lista de instâncias conectadas, pula vendedor cujo WhatsApp está CAÍDO (não 'open')
    if(liveSet && !liveSet.has('ax_'+String(v.at))) continue;
    const mine=chips.filter(c=>String(c.at)===String(v.at) && c.st!=='aquecimento' && c.st!=='banido');
    if(!mine.length) continue;
    const active=mine.find(c=>c.em_uso===true || c.wa_st==='em_uso') || mine[0];
    if(!active) continue;
    const wa=String(active.wa_st||'').toLowerCase();
    if(wa==='restrito' || wa==='banido') continue;
    if(active.num) out.push(active.num);
  }
  return out;
}
// Igual ao _resolvePresselNumbers mas devolve o vendedor completo {num, at, inst} pra balancear.
// instância base do vendedor (tira o sufixo _b do número backup) — pra métrica/pixel somarem no mesmo vendedor
function _instBase(inst){ return String(inst||'').replace(/_b$/,''); }
// Compara dois números por os últimos 8 dígitos (ignora DDI 55, 9º dígito, formatação)
function _lastDigitsEq(a,b){ const na=String(a||'').replace(/\D/g,'').slice(-8), nb=String(b||'').replace(/\D/g,'').slice(-8); return na.length>=8 && na===nb; }
// Número OK pra rotear lead? Conectado = é o ownerJid de ALGUMA instância 'open'.
// Checa por NÚMERO (não pelo slot da instância): assim, trocar o número de
// principal↔reserva (ou reconectar noutro slot) NÃO gera falso "não conectado".
// FAIL-OPEN: sem info nenhuma (Evolution fora / números desconhecidos) não bloqueia.
function _servConnOk(liveSet, inst, chipNum){
  if(!liveSet) return true;                             // sem info → fail-open
  if(!chipNum) return false;
  let anyKnown=false;
  for(const cn of liveSet.values()){                   // liveSet: instância(open) → número conectado
    if(cn){ anyKnown=true; if(_lastDigitsEq(cn, chipNum)) return true; }   // número aberto em ALGUMA instância
  }
  if(anyKnown) return false;                            // sabemos os números abertos e este não está entre eles
  return liveSet.has(inst);                             // nenhum número conhecido → fail-open pelo slot
}
// Resolve, por vendedor, o número PRINCIPAL (em uso, instância ax_<at>) e o BACKUP (chip bkp, instância ax_<at>_b).
// Os dois entram só se estiverem conectados AGORA (liveSet) COM O NÚMERO CERTO e não banidos/restritos.
function _resolvePresselSellers(p, chips, liveSet, emUsoIds){
  const out=[];
  const okWa=(c)=>{ const wa=String((c&&c.wa_st)||'').toLowerCase(); return wa!=='restrito' && wa!=='banido'; };
  // "Em uso" igual o frontend enxerga: flag em_uso (true OU 1 — o JSON grava dos dois
  // jeitos) ou um status cujo id/label é "Em uso" (a dash usa ids customizados tipo
  // st_xxxx, então comparar com a string 'em_uso' não basta).
  const isEmUso=(c)=> c.em_uso===true || c.em_uso===1 || (emUsoIds && emUsoIds.has(String(c.wa_st||''))) || String(c.wa_st||'')==='em_uso';
  for(const v of (p.vendedores||[])){
    if(!v.at) continue;                                    // vendedor sem atendente → ignora
    // v.ativo=false = PRINCIPAL desligado (não o vendedor inteiro). O complementar ainda pode rodar
    // sozinho: o Bruno desliga o número sob risco de ban e mantém o outro. Só pula tudo se os DOIS
    // estiverem desligados (checado no final: primary e backup ambos null).
    const principalOn = v.ativo !== false;
    // c.at obrigatório: sem isso, String(null)==='null' casaria vendedor órfão com
    // os chips da coluna "Disponíveis" (número fora de uso recebendo lead sem aparecer na tela).
    const mine=chips.filter(c=>c.at && String(c.at)===String(v.at) && c.st!=='aquecimento' && c.st!=='banido');
    if(!mine.length) continue;
    const instP='ax_'+String(v.at), instB='ax_'+String(v.at)+'_b';
    // SEM fallback pra mine[0]: se o vendedor não tem chip marcado "Em uso", ele está
    // FORA da roleta (é o que o frontend mostra: "sem número em uso"). O fallback antigo
    // pegava QUALQUER chip dele e roteava lead pra um número que a tela dava como fora.
    // Principal = chip "Em uso". Se o vendedor não marcou NENHUM (caso real: a equipe usa a tag
    // "Ativo" e nunca "Em uso"), cai no 1º número utilizável que NÃO seja a reserva — que é
    // exatamente o número que a tela mostra como principal (o frontend também cai em chips[0]).
    // Sem esse fallback o worker descartava vendedores que a dash exibia ligados → pressel offline.
    const emChip=mine.find(isEmUso) || mine.find(c=>c.bkp!==true) || null;            // conectado em instP
    if(!emChip) continue;                                                            // sem nenhum número = não entra na roleta
    let bkChip=mine.find(c=>c.bkp===true);                                          // conectado em instB
    if(bkChip && emChip && (String(bkChip.id)===String(emChip.id) || _lastDigitsEq(bkChip.num, emChip.num))) bkChip=null;   // reserva NÃO pode ser o mesmo número do principal (o mesmo WhatsApp em 2 instâncias briga e cai)
    const swap=!!(v.swap && emChip && bkChip);                                      // v.swap troca só o PAPEL (número fica na sua conexão)
    const pChip=swap?bkChip:emChip, pInst=swap?instB:instP;                         // principal = recebe primeiro
    const rChip=swap?emChip:bkChip, rInst=swap?instP:instB;                         // reserva = overflow
    const primary=(principalOn && pChip && okWa(pChip) && pChip.num && _servConnOk(liveSet, pInst, pChip.num)) ? {num:pChip.num, inst:pInst} : null;   // principal só entra com o interruptor dele ligado
    const backup =(v.reserva_on!==false && rChip && okWa(rChip) && rChip.num && _servConnOk(liveSet, rInst, rChip.num)) ? {num:rChip.num, inst:rInst} : null;   // reserva só entra com o interruptor ligado
    if(!primary && !backup) continue;   // os DOIS desligados/caídos → vendedor fora da roleta
    out.push({at:String(v.at), cap:Math.max(0,Number(v.cap)||0), mode:(v.reserva_mode==='split'?'split':'overflow'), primary, backup});
  }
  return out;
}
// LEADS DE HOJE POR NÚMERO — fonte de verdade do placar da roleta.
// Tem que vir de wa_lead, não do `claimed` de tt_pending. `claimed` conta CLIQUE reivindicado, e o
// fallback de atribuição pode reivindicar o clique de um número pra um lead que chegou em OUTRO
// número do mesmo vendedor. Medido em 22/07: claimed dava 90/53/33/11/1 enquanto o lead real era
// 97/45/25/13/1. wa_lead bate exatamente com o que a dash mostra (143 x 38, total 181).
// Cache de 30s por isolate: o placar anda ~1 lead a cada 3min, então não precisa ler a cada clique.
let _leadDiaCache=null, _leadDiaT=0, _leadDiaKey=0;
async function _leadsHojePorNumero(env, dayStart){
  const agora=Date.now();
  if(_leadDiaCache && _leadDiaKey===dayStart && (agora-_leadDiaT)<30000) return _leadDiaCache;
  const out={};
  try{
    const r=await env.DB.prepare(
      "SELECT substr(replace(num,'+',''),-8) AS nk, COUNT(*) AS n FROM wa_lead WHERE ts >= ? AND num IS NOT NULL AND num<>'' GROUP BY nk"
    ).bind(dayStart).all();
    (r.results||[]).forEach(x=>{ const k=String(x.nk||''); if(k) out[k]=Number(x.n)||0; });
  }catch(_){ return _leadDiaCache || {}; }   // erro de leitura não pode zerar o placar
  _leadDiaCache=out; _leadDiaT=agora; _leadDiaKey=dayStart;
  return out;
}
const PACE_WIN=900, BURST_WIN=600, BURST_CAP=10, WARMUP_MIN=30, WARM_MIN_CAP=3;
// Contador em MEMÓRIA dos últimos envios por número. A gravação do clique (tt_pending) leva alguns
// instantes pra aparecer na LEITURA, e numa rajada isso deixava passar bem mais que o teto antes de
// desviar (medido: 18 num teto de 10). Este contador é imediato e fecha essa janela. É por isolate,
// então não é global — some junto com o isolate e serve só pra frear a rajada, não pra contabilidade.
const _pickLog = {};   // num_key -> [timestamps]
function _pickBump(k){ if(!k) return; const t=Math.floor(Date.now()/1000); (_pickLog[k]=_pickLog[k]||[]).push(t); }
function _pickRecent(k, win){ if(!k) return 0; const t=Math.floor(Date.now()/1000); const a=_pickLog[k]; if(!a) return 0; const keep=a.filter(x=>t-x<win); _pickLog[k]=keep; return keep.length; }
// ═══════════════════════════════════════════════════════════════════════════════════════════
// ROLETA — REGRA ÚNICA: o lead vai pro VENDEDOR que fez MENOS LEAD HOJE.
//
// Foi reescrita do zero porque a versão anterior tinha 7 sinais competindo (ritmo de 15min, carga
// de 1h, justiça por vendedor, cota, aquecimento, regra especial de pico, rodízio) e, na hora do
// aperto, um sinal derrubava o outro e um número levava 167 leads enquanto outro levava 50.
// Regra que não dá pra entender numa lida é regra que ninguém consegue confiar.
//
// A MÉTRICA É LEAD, NÃO CLIQUE. Contar clique parecia certo e não era: em 22/07 os três números
// receberam 1130, 1124 e 1123 cliques (diferença de 0,6%) e fizeram 53, 33 e 90 leads, fechando o
// dia em 143 x 38. Número restrito converte 2 a 3x pior porque o WhatsApp avisa o lead que a conta
// é suspeita e ele desiste antes de mandar mensagem. Igualar clique não iguala lead, e o placar que
// vale pro negócio é lead. Fonte: wa_lead (o MESMO número que a dash mostra), não o `claimed` de
// tt_pending, que é aproximado.
//
// AGRUPA POR VENDEDOR, não por número. Quem roda dois números não leva o dobro só por isso. Dentro
// do vendedor vale a mesma régua entre os números dele: o que fez menos lead recebe agora.
//
// SEM TETO. Não há trava de rajada nem limite de compensação: quem está atrás recebe o quanto for
// preciso até empatar. Um número ou está restrito (converte pior mas funciona) ou banido — e banido
// sai sozinho da roleta quando o Sale Chat para de dar sinal. O caso que um teto protegeria (número
// vivo com 0% pra sempre) não existe na operação, e o teto só segurava a recuperação antes do
// empate. Receber muita mensagem também não bane: a própria Meta documenta isso ("receiving many
// messages at once will not result in an account ban"); o que bane é ENVIO em massa.
// ═══════════════════════════════════════════════════════════════════════════════════════════
async function _presselBalancedPick(env, id, sellers){
  const now=Math.floor(Date.now()/1000);
  const dayStart=Math.floor(new Date(_brDay()+'T00:00:00-03:00').getTime()/1000);
  const k8=n=>String(n||'').replace(/\D/g,'').slice(-8);

  // 1) Candidatos: TODO número ligado (principal e complementar valem igual).
  let avail=[];
  for(const s of sellers){
    if(s.primary) avail.push({num:s.primary.num, at:s.at, inst:s.primary.inst});
    if(s.backup)  avail.push({num:s.backup.num,  at:s.at, inst:s.backup.inst});
  }
  if(!avail.length) return null;

  // 2) NÃO existe mais filtro de "buraco negro" aqui. Ele tirava da roleta o número que recebia
  //    clique e quase não virava conversa, mas isso estava errado por dois motivos. Primeiro, taxa
  //    baixa não é número morto: a mensagem chega normal, o que cai é a conversão, porque o
  //    WhatsApp mostra pro lead o aviso de conta suspeita e ele desiste antes de falar. Segundo, e
  //    mais importante: a restrição é por CONTA, não por chip, então quando todos estão restritos a
  //    regra empurrava o dia inteiro pra um número só — e concentrar tudo num número queima ele
  //    ainda mais rápido. Ligado na pressel = recebe. Decisão do Diretor, com o risco conhecido.
  if(avail.length===1){ const u=avail[0]; try{ _pickBump(k8(u.num)); }catch(_){} return u; }

  // 3) Clique de hoje (tt_pending) + LEAD de hoje (wa_lead, cacheado 30s). São tabelas diferentes de
  //    propósito: clique é o que a roleta manda, lead é o que de fato chegou. O clique só serve de
  //    desempate; quem manda no placar é o lead.
  const hoje={};
  let conv={};
  try{
    const [r, lh] = await Promise.all([
      env.DB.prepare(
        `SELECT num_key, COUNT(*) AS dia
           FROM tt_pending
          WHERE ts >= ? AND num_key IS NOT NULL AND num_key<>''
          GROUP BY num_key`
      ).bind(dayStart).all(),
      _leadsHojePorNumero(env, dayStart),
    ]);
    (r.results||[]).forEach(x=>{ const k=String(x.num_key||''); if(!k) return; hoje[k]=Number(x.dia)||0; });
    conv=lh||{};
  }catch(_){}
  // _pickRecent = o que esta instância acabou de mandar e o banco ainda não enxerga (leitura atrasa
  // alguns segundos; sem isso, uma rajada de cliques ia toda pro mesmo número).
  const cargaDia=a=>{ const k=k8(a.num); return (hoje[k]||0) + _pickRecent(k, 120); };

  // 4) SEM teto de rajada. Ele existia justamente pra impedir que um número novo (que entra zerado)
  //    absorvesse de uma vez o que os outros já tinham recebido — e é EXATAMENTE isso que precisa
  //    acontecer pro vendedor atrasado alcançar dentro do mesmo dia. Na prática ele nem funcionava:
  //    no volume real (~23 cliques por número a cada 10min contra um teto de 10) todos estouravam e
  //    o código ignorava o teto. Pior, no meio da recuperação ele desviava justamente o lead do
  //    número que estava correndo atrás, e aí a igualdade nunca fechava.
  //    Também não se sustenta pelo lado do ban: a própria Meta documenta que RECEBER muita mensagem
  //    de uma vez não bane ("receiving many messages at once will not result in an account ban").
  //    O que bane é ENVIO em massa, e aqui quem manda a mensagem é o lead, não o número.
  const pool=avail;

  // 5) A REGRA: o ATENDENTE que menos VIROU CONVERSA hoje recebe agora.
  //
  // Antes contava CLIQUE por número, e clique igual NÃO dá lead igual. Medido em 22/07: os três
  // números ativos receberam 1130, 1124 e 1123 cliques (praticamente idênticos, a roleta estava
  // certa) e viraram 53, 33 e 90 leads. Número restrito converte 2 a 3x pior, porque o WhatsApp
  // mostra pro lead o aviso de conta suspeita e ele desiste antes de mandar mensagem. No fim do dia
  // deu 144 x 44 e parecia falha de distribuição, mas era diferença de conversão.
  //
  // Agora o placar da roleta é o MESMO que o Bruno cobra: lead por atendente. Quem está atrás em
  // LEAD recebe mais CLIQUE, até empatar. Também agrupa por atendente (não por número): quem roda
  // dois números não leva o dobro só por isso.
  const porAt={};
  pool.forEach(a=>{
    const k=String(a.at); const nk=k8(a.num);
    if(!porAt[k]) porAt[k]={at:k, cli:0, cv:0, nums:[]};
    porAt[k].cli+=cargaDia(a); porAt[k].cv+=(conv[nk]||0); porAt[k].nums.push(a);
  });
  // SEM teto de compensação. Existia uma trava de 3x aqui, tirada a pedido do Diretor: na operação
  // real um número ou está restrito (converte pior, mas funciona) ou está banido — e banido sai
  // sozinho da roleta, porque o Sale Chat para de dar sinal de vida e o número deixa de entrar em
  // `avail`. Ou seja, o caso que a trava protegia (número vivo com 0% pra sempre) não existe, e ela
  // só atrapalhava: segurava a recuperação antes de empatar. A métrica é UMA: lead por vendedor.
  const ats=Object.values(porAt);
  ats.sort((a,b)=>(a.cv-b.cv) || (a.cli-b.cli));   // menos LEAD hoje recebe; empate → menos clique
  const menorCv=ats[0].cv;
  const empAt=ats.filter(x=>x.cv===menorCv);
  // Empate → rodízio atômico (escrita no banco, é o único contador imediato; leitura atrasaria e
  // criaria um "vencedor" fixo na rajada).
  const escAt = empAt.length<=1 ? ats[0] : empAt[await _presselNextIndex(env, id, empAt.length)];
  // Dentro do vendedor, vale a MESMA régua: o número dele que fez menos LEAD hoje recebe agora
  // (empate → o que recebeu menos clique). É a "escadinha": quem roda 40 num número e 10 no outro
  // passa a alimentar o de 10 até emparelhar, sem parar de receber em nenhum dos dois.
  escAt.nums.sort((a,b)=>((conv[k8(a.num)]||0)-(conv[k8(b.num)]||0)) || (cargaDia(a)-cargaDia(b)));
  const escolhido=escAt.nums[0];
  try{ _pickBump(k8(escolhido.num)); }catch(_){}
  return escolhido;
}
// Marca que a roleta saturou (todos os números no teto). Throttle in-memory: no máx 1 escrita/min.
let _lastSatWrite=0;
async function _roletaMarkSaturated(env){
  const now=Math.floor(Date.now()/1000);
  if(now-_lastSatWrite<60) return;
  _lastSatWrite=now;
  try{ await _ensureConfigTable(env); await env.DB.prepare("INSERT INTO app_config (key,value,updated_at) VALUES ('roleta_sat_ts',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(String(now),now).run(); }catch(_){}
}
function _ttPixel(p){
  if(!p.pixel_tt) return '';
  const id=JSON.stringify(String(p.pixel_tt)).replace(/</g,'\\u003c');   // neutraliza </script>
  return `<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=d.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load(${id});}(window,document,'ttq');</script>`;
}
function _presselHtml(html){
  return new Response(html, { status:200, headers:{ 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' } });
}
function _presselOffline(){
  return _presselHtml(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui,Arial,sans-serif;background:#0b1220;color:#cbd5e1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px"><div><h2 style="margin:0 0 8px">Indisponível no momento</h2><p style="opacity:.7">Tente novamente em instantes.</p></div></body>`);
}
// Elementos da pressel (compat: monta de img+cta se ainda não tiver elementos)
function _presselElsServer(p){
  if(Array.isArray(p.elementos) && p.elementos.length) return p.elementos;
  const els=[]; let n=1;
  if(p.img) els.push({id:n++,type:'imagem',src:p.img});
  els.push({id:n++,type:'botao',label:p.cta||'FALAR NO WHATSAPP',bg:'#22c55e',color:'#ffffff'});
  return els;
}
function _elPublicHtml(e, wa){
  if(e.type==='imagem') return e.src?`<img src="${_escHtml(e.src)}" alt="">`:'';
  if(e.type==='texto') return `<div style="padding:14px;font-size:${Number(e.size)||16}px;text-align:${_escHtml(e.align||'center')};color:${_escHtml(e.color||'#111')};line-height:1.4">${_escHtml(e.text||'')}</div>`;
  if(e.type==='botao') return `<div style="padding:14px"><a href="${_escHtml(wa)}" onclick="event.preventDefault();event.stopPropagation();go()" style="display:flex;align-items:center;justify-content:center;gap:10px;background:${_escHtml(e.bg||'#22c55e')};color:${_escHtml(e.color||'#fff')};border-radius:14px;padding:16px 18px;font-weight:800;font-size:19px;text-transform:uppercase;letter-spacing:.3px;text-decoration:none;box-shadow:0 4px 0 rgba(0,0,0,.18),0 7px 14px rgba(0,0,0,.13)"><svg viewBox="0 0 32 32" width="24" height="24" style="flex-shrink:0" fill="currentColor"><path d="M16.04 4C9.4 4 4 9.4 4 16.04c0 2.12.55 4.18 1.6 6L4 28l6.13-1.6a12 12 0 0 0 5.9 1.5c6.63 0 12.03-5.4 12.03-12.04C28.06 9.4 22.67 4 16.04 4Zm0 21.9a9.9 9.9 0 0 1-5.06-1.38l-.36-.22-3.64.96.97-3.55-.24-.37a9.86 9.86 0 1 1 8.33 4.56Zm5.43-7.42c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.49 0 1.47 1.08 2.89 1.23 3.09.15.2 2.12 3.24 5.13 4.54.72.31 1.27.5 1.71.64.72.23 1.37.2 1.89.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.12-.27-.19-.57-.34Z"/></svg><span>${_escHtml(e.label||'FALAR NO WHATSAPP')}</span></a></div>`;
  if(e.type==='html') return e.html||'';
  return '';
}
// Round-robin de verdade (distribuição IGUAL): contador por pressel numa
// tabela própria, sem mexer no dashboard_state (evita conflito de sync).
async function _presselNextIndex(env, id, len){
  if(len<=1) return 0;
  try{
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_rr (pid TEXT PRIMARY KEY, n INTEGER)').run();
    // Incremento ATÔMICO num só statement (D1 serializa writes): duas roletas
    // concorrentes recebem n distintos, mantendo a distribuição igual. Antes era
    // SELECT + UPDATE separados, e uma rajada podia dar o mesmo índice pros dois.
    const row=await env.DB.prepare('INSERT INTO pressel_rr (pid,n) VALUES (?,1) ON CONFLICT(pid) DO UPDATE SET n=n+1 RETURNING n').bind(String(id)).first();
    const n=(Number(row&&row.n)||1)-1;   // n vem 1-based após o incremento; volta pra 0-based
    return n%len;
  }catch(_){ return Math.floor(Math.random()*len); }
}
// Contador de métricas da pressel (views = chegou; clicks = foi pro WhatsApp)
// Dia no fuso do Brasil (UTC-3, sem horário de verão), formato YYYY-MM-DD.
function _brDay(tsSec){ const ms=(tsSec?tsSec*1000:Date.now())-3*3600000; return new Date(ms).toISOString().slice(0,10); }
async function _bumpPressel(env, id, field){
  const col = field === 'clicks' ? 'clicks' : 'views';
  try{
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_stats (pid TEXT PRIMARY KEY, views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0)').run();
    await env.DB.prepare(`INSERT INTO pressel_stats (pid, ${col}) VALUES (?, 1) ON CONFLICT(pid) DO UPDATE SET ${col} = ${col} + 1`).bind(String(id)).run();
    // e por DIA, pra dash conseguir filtrar por data
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_day (pid TEXT, day TEXT, views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, PRIMARY KEY(pid,day))').run();
    await env.DB.prepare(`INSERT INTO pressel_day (pid, day, ${col}) VALUES (?, ?, 1) ON CONFLICT(pid,day) DO UPDATE SET ${col} = ${col} + 1`).bind(String(id), _brDay()).run();
  }catch(_){}
}
// GET /api/pressel/stats → views/clicks por pressel (a dash mostra na métrica)
async function handlePresselStats(req, env){
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  try{
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_stats (pid TEXT PRIMARY KEY, views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0)').run();
    const rows = await env.DB.prepare('SELECT pid, views, clicks FROM pressel_stats').all();
    return json({ ok:true, stats: rows.results || [] });
  }catch(e){ return json({ ok:true, stats: [] }); }
}
// GET /api/pressel/metrics?day=YYYY-MM-DD (default: hoje BRT). Métricas REAIS do dia:
// views/clicks por pressel (pressel_day) + contatos/vendas reais por instância (wa_messages/wa_sales).
// Métricas do dia por pressel, atribuídas pela PRESSEL de origem do lead (wa_lead.pid),
// NÃO pelo vendedor (que é compartilhado entre pressels — senão o mesmo contato conta em todas).
async function _presselDayMetrics(env, day){
  const start = Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), end = start + 86400;
  const m = { vc:{}, contatos:{}, contatosVI:{}, vendas:{}, valor:{}, vendasVI:{}, vendasInst:{} };
  // As 5 consultas são INDEPENDENTES — roda em PARALELO (1 ida ao banco no lugar de 5). Tabelas já existem
  // em produção; se faltar (DB novo) o .catch devolve vazio (zeros) sem quebrar.
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r=>r.results||[]).catch(()=>[]);
  const [pr, c, c2, s, sa] = await Promise.all([
    q('SELECT pid, views, clicks FROM pressel_day WHERE day=?', day),
    q("SELECT pid, COUNT(*) c FROM wa_lead WHERE ts>=? AND ts<? AND pid IS NOT NULL AND pid<>'' GROUP BY pid", start, end),
    q("SELECT pid, inst, COUNT(*) c FROM wa_lead WHERE ts>=? AND ts<? AND pid IS NOT NULL AND pid<>'' AND inst IS NOT NULL GROUP BY pid, inst", start, end),
    q("SELECT l.pid pid, s.instance inst, COUNT(*) v, COALESCE(SUM(s.value),0) val FROM wa_sales s JOIN wa_lead l ON l.phone=s.phone WHERE s.ts>=? AND s.ts<? AND l.pid IS NOT NULL AND l.pid<>'' GROUP BY l.pid, s.instance", start, end),
    q("SELECT s.instance inst, COUNT(*) v, COALESCE(SUM(s.value),0) val FROM wa_sales s WHERE s.ts>=? AND s.ts<? GROUP BY s.instance", start, end),
  ]);
  pr.forEach(r=>{ m.vc[String(r.pid)]={views:Number(r.views)||0, clicks:Number(r.clicks)||0}; });
  c.forEach(r=>{ m.contatos[String(r.pid)]=Number(r.c)||0; });
  c2.forEach(r=>{ const pid=String(r.pid); (m.contatosVI[pid]=m.contatosVI[pid]||{})[r.inst]=Number(r.c)||0; });
  s.forEach(r=>{ const pid=String(r.pid); m.vendas[pid]=(m.vendas[pid]||0)+(Number(r.v)||0); m.valor[pid]=(m.valor[pid]||0)+(Number(r.val)||0); (m.vendasVI[pid]=m.vendasVI[pid]||{})[r.inst||'']=Number(r.v)||0; });
  sa.forEach(r=>{ m.vendasInst[String(r.inst||'')]={ v:Number(r.v)||0, val:Number(r.val)||0 }; });
  return m;
}
async function handlePresselMetricsLive(req, env){
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  let day = new URL(req.url).searchParams.get('day') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = _brDay();
  const M = await _presselDayMetrics(env, day);
  const pressels = {};
  new Set([...Object.keys(M.vc), ...Object.keys(M.contatos), ...Object.keys(M.vendas)]).forEach(pid=>{
    const vc = M.vc[pid]||{};
    const p = { views:Number(vc.views)||0, clicks:Number(vc.clicks)||0, contatos:M.contatos[pid]||0, vendas:M.vendas[pid]||0, valor:M.valor[pid]||0, vend:{} };
    const cvi = M.contatosVI[pid]||{}, vvi = M.vendasVI[pid]||{};
    new Set([...Object.keys(cvi), ...Object.keys(vvi)]).forEach(inst=>{ const b=_instBase(inst); const e=(p.vend[b]=p.vend[b]||{contatos:0,vendas:0}); e.contatos+=cvi[inst]||0; e.vendas+=vvi[inst]||0; });   // backup (_b) soma no mesmo vendedor
    pressels[pid] = p;
  });
  return json({ ok:true, day, today: _brDay(), pressels });
}
// GET /m/<id> — página PÚBLICA de métricas (pra compartilhar com gestores de tráfego)
async function handlePresselMetricsPage(req, env, id){
  const row=await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let data={}; try{ data=JSON.parse(row?.data||'{}'); }catch(_){}
  const p=(Array.isArray(data.pressels)?data.pressels:[]).find(x=>String(x.id)===String(id));
  if(!p) return _presselHtml(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b1220;color:#cbd5e1;text-align:center;padding:60px">Pressel não encontrada.</body>`);
  const chips=Array.isArray(data.chips)?data.chips:[];
  let day=new URL(req.url).searchParams.get('day')||'';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) day=_brDay();
  else { const _dp=day.split('-'); if(+_dp[1]<1||+_dp[1]>12||+_dp[2]<1||+_dp[2]>31) day=_brDay(); }   // rejeita mês/dia impossível (ex: 2026-00-01)
  const today=_brDay(); if(day>today) day=today;   // seletor de data (não deixa o futuro)
  const isToday=(day===today);
  const M=await _presselDayMetrics(env, day);
  const vc=M.vc[String(id)]||{}, views=Number(vc.views)||0, clicks=Number(vc.clicks)||0;
  const contatos=M.contatos[String(id)]||0, vendas=M.vendas[String(id)]||0;
  const cvi=M.contatosVI[String(id)]||{}, vvi=M.vendasVI[String(id)]||{};
  let nameMap={};
  try{ const us=await env.DB.prepare('SELECT id, name FROM users').all(); (us.results||[]).forEach(u=>{nameMap[String(u.id)]=u.name;}); }catch(_){}
  // vendedores da roleta AGORA + qualquer um com atividade hoje nesta pressel (mesmo já tirado da roleta) — o dado não some
  const _vAt=(inst)=>String(inst).replace(/^ax_/,'').replace(/_b$/,'');
  const vm={};
  const ens=(at)=>{ at=String(at); if(at && !vm[at]){ const mine=chips.filter(c=>String(c.at)===at && c.st!=='aquecimento' && c.st!=='banido'); const active=mine.find(c=>c.em_uso===true||c.wa_st==='em_uso')||mine[0]; vm[at]={name:nameMap[at]||'Vendedor', num:active?active.num:'—', contatos:0, vendas:0}; } };
  (p.vendedores||[]).filter(v=>v.ativo!==false).forEach(v=>ens(v.at));
  Object.keys(cvi).forEach(inst=>ens(_vAt(inst)));
  Object.keys(vvi).forEach(inst=>ens(_vAt(inst)));
  Object.keys(cvi).forEach(inst=>{ const at=_vAt(inst); if(vm[at]) vm[at].contatos+=Number(cvi[inst])||0; });
  Object.keys(vvi).forEach(inst=>{ const at=_vAt(inst); if(vm[at]) vm[at].vendas+=Number(vvi[inst])||0; });
  const vend=Object.values(vm);
  const dBR=day.split('-'); const dLabel=dBR.length===3?(dBR[2]+'/'+dBR[1]):day;
  const card=(lbl,val,color)=>`<div style="flex:1;min-width:150px;background:#141c2b;border:1px solid #233047;border-radius:16px;padding:18px 20px"><div style="font-size:12px;color:#8b9bb4">${lbl}</div><div style="font-size:30px;font-weight:800;color:${color};margin-top:4px">${val}</div></div>`;
  const rows=vend.length?vend.map(v=>{const conv=v.contatos>0?Math.round((v.vendas/v.contatos)*100)+'%':'—';return `<tr style="border-top:1px solid #233047"><td style="padding:13px 10px"><div style="font-weight:600;font-size:14px">${_escHtml(v.name)}</div><div style="font-size:12px;color:#8b9bb4;font-family:ui-monospace,monospace">${_escHtml(v.num)}</div></td><td style="text-align:center;color:#34d399">${v.contatos}</td><td style="text-align:center">${v.vendas||'—'}</td><td style="text-align:center;color:#7aa2ff">${conv}</td></tr>`;}).join(''):`<tr><td colspan="4" style="padding:16px;text-align:center;color:#8b9bb4">Nenhum vendedor nessa pressel.</td></tr>`;
  return _presselHtml(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${isToday?'<meta http-equiv="refresh" content="30">':''}<title>Métricas — ${_escHtml(p.nome||'')}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1220;color:#e6edf6;font-family:system-ui,-apple-system,Arial,sans-serif;padding:24px}.wrap{max-width:880px;margin:0 auto}h1{font-size:20px;margin-bottom:4px}table{width:100%;border-collapse:collapse;font-size:13px;margin-top:18px}th{color:#8b9bb4;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:6px 10px}</style></head><body><div class="wrap"><h1>Métricas — ${_escHtml(p.nome||'')}</h1><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:18px"><input type="date" value="${day}" max="${today}" onchange="if(this.value)location.href='?day='+this.value" style="background:#141c2b;border:1px solid #233047;color:#e6edf6;border-radius:8px;padding:5px 9px;font-size:12.5px;font-family:inherit;color-scheme:dark;cursor:pointer">${isToday?'<span style="color:#6b7a93;font-size:12px">atualiza sozinho a cada 30s</span>':'<a href="?" style="color:#7aa2ff;font-size:12.5px;text-decoration:none">← voltar pra hoje</a>'}</div><div style="display:flex;gap:12px;flex-wrap:wrap">${card('Chegaram na pressel',views,'#7aa2ff')}${card('Foram pro WhatsApp',clicks,'#34d399')}${card('Iniciaram contato',contatos,'#34d399')}${card('Vendas',vendas,'#34d399')}</div><table><thead><tr><th style="text-align:left">Vendedor</th><th>Iniciaram</th><th>Vendas</th><th>Conversão</th></tr></thead><tbody>${rows}</tbody></table><p style="color:#6b7a93;font-size:11.5px;margin-top:16px;line-height:1.5">Todos os números são reais e do dia selecionado. Chegaram e Foram pro WhatsApp contam só tráfego do TikTok (ttclid). Iniciaram contato e Vendas vêm do WhatsApp (Evolution).</p></div>${_diagHtml?`<aside class="side">${_diagHtml}</aside>`:''}</div></body></html>`);
}
const PRESSEL_DOMS = ['area-acesso.com', 'area-glico.fun', 'painel-glico.fun'];
function _presselDom(p){ return (p && p.dominio && PRESSEL_DOMS.includes(p.dominio)) ? p.dominio : 'painel-glico.fun'; }
// GET /pressels-total — página PÚBLICA consolidada: TOTAL somando todas + cada pressel numa seção.
// Pega TODAS as pressels do estado automaticamente (pressel nova entra sozinha).
// SAÚDE DOS NÚMEROS. Clique entrando e quase ninguém falando = o WhatsApp está mostrando pro lead
// o aviso de conta suspeita e ele desiste antes de mandar mensagem. A mensagem de quem manda chega
// normal, então não é número morto: é conversão caindo, e o sinal de que aquele chip precisa ser
// trocado. Aqui é só INFORMATIVO — a roleta não tira ninguém por causa disso (ligado = recebe).
async function _roletaDiagHtml(env, day, chips, nameMap){
  try{
    const ini=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), fim=ini+86400;
    // Clique vem de tt_pending; LEAD vem de wa_lead (o mesmo número que a dash mostra). Antes usava
    // o `claimed` do tt_pending e dava valor aproximado, porque o fallback de atribuição reivindica
    // clique de um número pra lead que chegou em outro do mesmo vendedor (dava 90 onde eram 97).
    const [r, lr] = await Promise.all([
      env.DB.prepare(
        `SELECT num_key, COUNT(*) cliques FROM tt_pending
          WHERE ts>=? AND ts<? AND num_key IS NOT NULL AND num_key<>''
          GROUP BY num_key HAVING cliques >= 50`
      ).bind(ini, fim).all(),
      env.DB.prepare(
        "SELECT substr(replace(num,'+',''),-8) AS nk, COUNT(*) n FROM wa_lead WHERE ts>=? AND ts<? AND num IS NOT NULL AND num<>'' GROUP BY nk"
      ).bind(ini, fim).all(),
    ]);
    const k8=n=>String(n||'').replace(/\D/g,'').slice(-8);
    const leadDe={}; (lr.results||[]).forEach(x=>{ const k=String(x.nk||''); if(k) leadDe[k]=Number(x.n)||0; });
    const ruins=(r.results||[]).map(x=>{
      const k=String(x.num_key||''), cl=Number(x.cliques)||0, cv=leadDe[k]||0;
      return { k, cl, cv, taxa: cl?(cv*100/cl):0 };
    }).filter(x=>x.taxa<2).sort((a,b)=>b.cl-a.cl);
    if(!ruins.length) return '';
    const dono=k=>{ const c=chips.find(c=>k8(c.num)===k); return c&&c.at?(nameMap[String(c.at)]||String(c.at)):''; };
    const linhas=ruins.map(x=>{
      const d=dono(x.k);
      return `<li style="margin:5px 0"><b style="font-family:ui-monospace,monospace;color:#e6edf6">${_escHtml(x.k)}</b>${d?` <span style="color:#8b9bb4">de ${_escHtml(d)}</span>`:''}<br><span style="color:#8b9bb4">recebeu</span> <b style="color:#f87171">${x.cl}</b> <span style="color:#8b9bb4">cliques e virou só</span> <b style="color:#f87171">${x.cv}</b> <span style="color:#8b9bb4">lead${x.cv===1?'':'s'}</span> (${x.taxa.toFixed(1)}%)</li>`;
    }).join('');
    return `<div style="background:#241d10;border:1px solid #7c5e10;border-radius:12px;padding:13px 16px">`
      + `<div style="font-size:13px;font-weight:800;color:#fbbf24">Chip pedindo troca</div>`
      // Deixa explícito que a conta é POR NÚMERO. Sem isso dá pra ler "Guilherme, 1 lead" e achar
      // que é o total do vendedor, quando é só o desempenho daquele chip específico dele.
      + `<div style="font-size:10.5px;color:#8b9bb4;margin:2px 0 7px">número a número, não é o total do vendedor</div>`
      + `<ul style="margin:0 0 7px 18px;font-size:12.5px;color:#cbd5e1">${linhas}</ul>`
      + `<div style="font-size:11.5px;color:#8b9bb4;line-height:1.5">Clique entrando e quase ninguém falando é sinal de número <b style="color:#cbd5e1">restrito pelo WhatsApp</b>: o lead vê o aviso de conta suspeita e desiste antes de mandar mensagem. Continua recebendo lead normalmente, mas vale trocar o chip.</div></div>`;
  }catch(_){ return ''; }
}
async function handlePresselsTotalPage(req, env){
  const row=await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let data={}; try{ data=JSON.parse(row?.data||'{}'); }catch(_){}
  const pressels=Array.isArray(data.pressels)?data.pressels:[];
  const chips=Array.isArray(data.chips)?data.chips:[];
  let day=new URL(req.url).searchParams.get('day')||'';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) day=_brDay();
  else { const _dp=day.split('-'); if(+_dp[1]<1||+_dp[1]>12||+_dp[2]<1||+_dp[2]>31) day=_brDay(); }   // rejeita mês/dia impossível (ex: 2026-00-01)
  const today=_brDay(); if(day>today) day=today;   // seletor de data (não deixa escolher o futuro)
  const isToday=(day===today);
  const _vq=new URL(req.url).searchParams.get('view')||''; const view=(_vq==='vendas'||_vq==='leads')?_vq:'metricas';   // alterna Métricas / Pedidos / Leads
  // Modo completo (números de lead sem máscara + clicáveis + copiar): SÓ com sessão válida (token da dash via ?k=).
  // Sem token → página pública mostra só o final do número (protege os leads, que são o ativo da empresa).
  const kParam=new URL(req.url).searchParams.get('k')||'';
  let full=false;
  // Só libera modo completo pra DIRETOR/SÓCIO ativo (não arquivado). Leads é só-diretor; vendedor não pode
  // puxar a carteira dos outros. JOIN em users barra até sessão antiga de usuário já arquivado/demitido.
  if(/^[a-f0-9]{64}$/i.test(kParam)){ try{ const _now=Math.floor(Date.now()/1000); const _s=await env.DB.prepare('SELECT u.role role, COALESCE(u.archived,0) arch FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?').bind(kParam,_now).first(); if(_s && Number(_s.arch)!==1 && ROLE_DIRETOR.includes(_s.role)) full=true; }catch(_){} }
  const kq=full?('k='+encodeURIComponent(kParam)):'';   // preserva o token na navegação interna (data/abas)
  const _pq=new URL(req.url).searchParams.get('per')||''; const per=(_pq==='mes')?'mes':'dia';   // Leads: visão diária (default) ou mensal
  // Pula a agregação pesada de métricas quando a aba é Pedidos/Leads (elas não usam) — deixa a troca de aba MUITO mais rápida.
  const M = view==='metricas' ? await _presselDayMetrics(env, day) : { vc:{}, contatos:{}, contatosVI:{}, vendas:{}, valor:{}, vendasVI:{}, vendasInst:{} };
  let nameMap={};
  try{ const us=await env.DB.prepare('SELECT id, name FROM users').all(); (us.results||[]).forEach(u=>{nameMap[String(u.id)]=u.name;}); }catch(_){}
  const _diagHtml=await _roletaDiagHtml(env, day, chips, nameMap);   // aviso de número furando a roleta (vale em todas as abas)
  const _vAt=(inst)=>String(inst).replace(/^ax_/,'').replace(/_b$/,'');   // instância -> id do vendedor
  // "Em uso" igual a dash enxerga (a dash usa ids de status customizados tipo st_xxxx com label "Em uso")
  const _emUsoIds=new Set(['em_uso']);
  try{ (Array.isArray(data.wa_statuses)?data.wa_statuses:[]).forEach(s=>{ const lbl=String((s&&(s.label||s.id))||'').toLowerCase().replace(/[_\s]+/g,' ').trim(); if(lbl==='em uso' && s && s.id) _emUsoIds.add(String(s.id)); }); }catch(_){}
  const _isEmUso=(c)=> !!c && (c.em_uso===true || c.em_uso===1 || _emUsoIds.has(String(c.wa_st||'')));
  const _chipsDo=(at)=>chips.filter(c=>String(c.at)===String(at) && c.st!=='aquecimento' && c.st!=='banido');
  // Vendedor rodando DOIS números (modo COMPLEMENTAR) mostra os DOIS números empilhados
  // embaixo do nome, numa linha SÓ, com Iniciaram/Vendas/Conversão SOMADOS dos dois.
  const _splitAts=new Set();
  pressels.forEach(p=>(p.vendedores||[]).forEach(v=>{
    if(!v || !v.at || v.reserva_mode!=='split' || v.reserva_on===false) return;
    const mine=_chipsDo(v.at);
    if(mine.some(_isEmUso) && mine.some(c=>c.bkp===true)) _splitAts.add(String(v.at));   // só se tiver os 2 chips mesmo
  }));
  // Uma célula por vendedor. nums = número principal (+ o complementar embaixo, se rodar 2).
  const _vendCell=(at)=>{
    at=String(at);
    const mine=_chipsDo(at);
    const em=mine.find(_isEmUso)||mine[0];
    const nums=[]; if(em&&em.num) nums.push(em.num);
    if(_splitAts.has(at)){ const bk=mine.find(c=>c.bkp===true); if(bk&&bk.num&&bk.num!==(em&&em.num)) nums.push(bk.num); }   // 2º número (complementar) empilhado embaixo
    if(!nums.length) nums.push('—');
    return {at, name:nameMap[at]||'Vendedor', nums, contatos:0, vendas:0};
  };
  // TOPS EM CIMA: uma linha por vendedor, ranqueada por vendas → conversão → contatos.
  const _rankVend=(vend)=>{
    const cv=(x)=>{ const c=Number(x.contatos)||0; return c>0 ? (Number(x.vendas)||0)/c : 0; };
    return (vend||[]).slice().sort((a,b)=> ((Number(b.vendas)||0)-(Number(a.vendas)||0)) || (cv(b)-cv(a)) || ((Number(b.contatos)||0)-(Number(a.contatos)||0)));
  };
  const secs=pressels.map(p=>{
    const pid=String(p.id), vc=M.vc[pid]||{}, cvi=M.contatosVI[pid]||{}, vvi=M.vendasVI[pid]||{};
    // mostra os vendedores da roleta AGORA + qualquer um que teve contato/venda hoje (mesmo já tirado da roleta) — o dado não some
    const vm={}; const ens=(at)=>{ at=String(at); if(at && !vm[at]) vm[at]=_vendCell(at); };
    (p.vendedores||[]).filter(v=>v.ativo!==false).forEach(v=>ens(v.at));
    Object.keys(cvi).forEach(inst=>ens(_vAt(inst)));
    Object.keys(vvi).forEach(inst=>ens(_vAt(inst)));
    // soma os 2 números do vendedor (o _b cai no mesmo _vAt)
    Object.keys(cvi).forEach(inst=>{ const at=_vAt(inst); if(vm[at]) vm[at].contatos+=Number(cvi[inst])||0; });
    Object.keys(vvi).forEach(inst=>{ const at=_vAt(inst); if(vm[at]) vm[at].vendas+=Number(vvi[inst])||0; });
    const vend=Object.values(vm);
    return {nome:p.nome||('Pressel '+p.id), url:'https://'+_presselDom(p)+'/p/'+p.id, views:Number(vc.views)||0, clicks:Number(vc.clicks)||0, contatos:M.contatos[pid]||0, vendas:M.vendas[pid]||0, vend};
  });
  const tot=secs.reduce((a,s)=>({views:a.views+s.views, clicks:a.clicks+s.clicks, contatos:a.contatos+s.contatos, vendas:a.vendas+s.vendas}), {views:0,clicks:0,contatos:0,vendas:0});
  tot.vendas=Object.values(M.vendasInst||{}).reduce((a,x)=>a+(Number(x.v)||0),0);   // TOTAL conta TODAS as vendas fechadas (com ou sem código)
  const dBR=day.split('-'); const dLabel=dBR.length===3?(dBR[2]+'/'+dBR[1]):day;
  const card=(lbl,val,color)=>`<div style="flex:1;min-width:130px;background:#141c2b;border:1px solid #233047;border-radius:14px;padding:14px 16px"><div style="font-size:11px;color:#8b9bb4">${lbl}</div><div style="font-size:26px;font-weight:800;color:${color};margin-top:3px">${val}</div></div>`;
  const cardsHtml=(m)=>`<div style="display:flex;gap:10px;flex-wrap:wrap">${card('Chegaram na pressel',m.views,'#7aa2ff')}${card('Foram pro WhatsApp',m.clicks,'#34d399')}${card('Iniciaram contato',m.contatos,'#34d399')}${card('Vendas',m.vendas,'#34d399')}</div>`;
  const vendTable=(vendRaw)=>{
    const vend=_rankVend(vendRaw||[]);   // tops (mais vendas / melhor conversão) em cima
    const rows=vend.length?vend.map(v=>{const conv=v.contatos>0?Math.round((v.vendas/v.contatos)*100)+'%':'—';const numsHtml=(v.nums&&v.nums.length?v.nums:['—']).map(n=>`<div style="font-size:11.5px;color:#8b9bb4;font-family:ui-monospace,monospace;line-height:1.55">${_escHtml(n)}</div>`).join('');return `<tr style="border-top:1px solid #233047"><td style="padding:10px 8px"><div style="font-weight:600;font-size:13px;margin-bottom:1px">${_escHtml(v.name)}</div>${numsHtml}</td><td style="text-align:center;padding:10px 12px;color:#34d399">${v.contatos}</td><td style="text-align:center;padding:10px 12px">${v.vendas||'—'}</td><td style="text-align:center;padding:10px 12px;color:#7aa2ff">${conv}</td></tr>`;}).join(''):`<tr><td colspan="4" style="padding:12px;text-align:center;color:#8b9bb4;font-size:12px">Sem vendedores.</td></tr>`;
    return `<table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-top:12px"><thead><tr><th style="text-align:left;color:#8b9bb4;font-size:11px;padding:5px 8px">Vendedor</th><th style="color:#8b9bb4;font-size:11px;padding:6px 12px;text-align:center">Iniciaram</th><th style="color:#8b9bb4;font-size:11px;padding:6px 12px;text-align:center">Vendas</th><th style="color:#8b9bb4;font-size:11px;padding:6px 12px;text-align:center">Conversão</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  // vendedores (únicos) somando contatos/vendas de TODAS as pressels — inclui quem já saiu da roleta mas teve atividade hoje, o dado NÃO some
  const _vt={};
  const _vtEns=(k)=>{ k=String(k); if(k && !_vt[k]) _vt[k]=_vendCell(k); };
  pressels.forEach(p=>(p.vendedores||[]).filter(v=>v.ativo!==false).forEach(v=>_vtEns(v.at)));   // vendedores na roleta agora
  Object.keys(M.contatosVI||{}).forEach(pid=>Object.keys(M.contatosVI[pid]).forEach(inst=>_vtEns(_vAt(inst))));   // + quem teve contato hoje
  Object.keys(M.vendasInst||{}).forEach(inst=>_vtEns(_vAt(inst)));   // + quem vendeu hoje (mesmo fora da roleta)
  Object.keys(M.contatosVI||{}).forEach(pid=>Object.keys(M.contatosVI[pid]).forEach(inst=>{ const at=_vAt(inst); if(_vt[at]) _vt[at].contatos+=Number(M.contatosVI[pid][inst])||0; }));   // os 2 números somam no vendedor (_b cai no mesmo)
  Object.keys(M.vendasInst||{}).forEach(inst=>{ const at=_vAt(inst); if(_vt[at]) _vt[at].vendas+=Number((M.vendasInst[inst]||{}).v)||0; });   // TODAS as vendas do vendedor (com ou sem código)
  const totVend=Object.values(_vt);
  const totalSec=`<div style="background:#101d2e;border:1px solid #2b6cb0;border-radius:16px;padding:20px;margin-bottom:24px"><div style="font-size:16px;font-weight:800;margin-bottom:12px;color:#7aa2ff">TOTAL · todas as pressels</div>${cardsHtml(tot)}${vendTable(totVend)}</div>`;
  const presselSecs=secs.length?secs.map(s=>`<div style="border:1px solid #233047;border-radius:16px;padding:18px;margin-bottom:16px"><div style="font-size:15px;font-weight:700">${_escHtml(s.nome)}</div><div style="font-size:11.5px;color:#6b7a93;font-family:ui-monospace,monospace;margin:2px 0 12px">${_escHtml(s.url)}</div>${cardsHtml(s)}${vendTable(s.vend)}</div>`).join(''):`<div style="color:#8b9bb4;text-align:center;padding:30px">Nenhuma pressel criada ainda.</div>`;
  const dayQ=isToday?'':('day='+day);
  const _seg=(lbl,v)=>{ const active=view===v; const qs=[v!=='metricas'?('view='+v):'',dayQ,kq,(v==='leads'&&per==='mes')?'per=mes':''].filter(Boolean).join('&'); return `<a href="?${qs}" style="padding:7px 12px;font-size:12.5px;font-weight:700;text-decoration:none;border-radius:8px;${active?'background:#2b6cb0;color:#fff':'color:#7aa2ff'}">${lbl}</a>`; };
  const toggleBtn=`<div style="margin-left:auto;display:inline-flex;gap:2px;background:#141c2b;border:1px solid #2b6cb0;border-radius:10px;padding:3px">${_seg('Métricas','metricas')}${_seg('Pedidos','vendas')}${_seg('Leads','leads')}</div>`;
  let ordersHtml='';
  if(view==='vendas'){
    let orders=[];
    try{
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}   // garante l.src pro JOIN
      const dstart=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), dend=dstart+86400;
      const r=await env.DB.prepare("SELECT s.name, s.phone phone, s.instance, s.value, s.ts, l.pid pid, l.src src FROM wa_sales s LEFT JOIN wa_lead l ON l.phone=s.phone WHERE s.ts>=? AND s.ts<? ORDER BY s.ts DESC LIMIT 300").bind(dstart,dend).all();
      orders=r.results||[];
    }catch(_){}
    const _pnm={}; pressels.forEach(pp=>{ _pnm[String(pp.id)]=pp.nome||('Pressel '+pp.id); });   // pid -> nome da pressel
    const pad=n=>String(n).padStart(2,'0');
    const totV=orders.reduce((a,o)=>a+(Number(o.value)||0),0);
    const nP=orders.filter(o=>o.pid&&String(o.pid).trim()!=='').length, nS=orders.length-nP;
    // WhatsApp pro cobrador falar com quem converteu (antes do pedido chegar). Numero completo +
    // link SO no modo desbloqueado (full = diretor logado via ?k). Na versao publica que o Bruno
    // manda pro gestor de trafego (sem token) NAO aparece — protege a carteira de leads.
    const WA_ICON='<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.297-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893A11.821 11.821 0 0020.885 3.488"/></svg>';
    const waHref=ph=>{ let d=String(ph||'').replace(/\D/g,''); if(!d) return ''; if(d.length<=11) d='55'+d; return 'https://wa.me/'+d; };
    const fmtPhone=ph=>{ let d=String(ph||'').replace(/\D/g,''); if(!d) return ''; if(d.startsWith('55')&&d.length>11) d=d.slice(2); return d; };
    const oCards=orders.length?orders.map(o=>{
      const at=String(o.instance||'').replace(/^ax_/,'').replace(/_b$/,'');
      const seller=nameMap[at]||o.instance||'—';
      const bt=new Date((Number(o.ts||0)-10800)*1000);
      const hora=isNaN(bt)?'':`${pad(bt.getUTCDate())}/${pad(bt.getUTCMonth()+1)} ${pad(bt.getUTCHours())}:${pad(bt.getUTCMinutes())}`;
      const attr=!!(o.pid&&String(o.pid).trim()!=='');
      const pnome=attr?(_pnm[String(o.pid)]||('Pressel '+o.pid)):'';
      const aprox=o.src==='fifo'?' <span style="opacity:.7;font-weight:500">(aprox)</span>':'';
      const tag=attr?`<span style="font-size:10px;font-weight:700;color:#34d399;background:rgba(52,211,153,.14);padding:2px 8px;border-radius:20px">${_escHtml(pnome)}${aprox}</span>`:`<span style="font-size:10px;font-weight:700;color:#8b9bb4;background:#1a2436;padding:2px 8px;border-radius:20px">sem rastreio</span>`;
      const val=Number(o.value)||0;
      const href=full&&o.phone?waHref(o.phone):'';
      const wa=href?`<a href="${href}" target="_blank" rel="noopener" title="Falar no WhatsApp com ${_escHtml(o.name||'o cliente')}" style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:11px;background:rgba(52,211,153,.14);color:#34d399;text-decoration:none">${WA_ICON}</a>`:'';
      const phoneLine=full&&o.phone?`<div style="font-size:12px;color:#34d399;margin-top:2px;font-family:ui-monospace,monospace">${_escHtml(fmtPhone(o.phone))}</div>`:'';
      return `<div style="border:1px solid #233047;border-radius:14px;background:#141c2b;padding:14px 16px;margin-bottom:9px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:0"><div style="font-size:14.5px;font-weight:700">${_escHtml(o.name||'Cliente')}${val>0?` · <span style="color:#34d399">R$ ${val}</span>`:''}</div><div style="font-size:12px;color:#8b9bb4;margin-top:3px">Vendedor: ${_escHtml(seller)} · ${hora}</div>${phoneLine}</div>${tag}${wa}</div></div>`;
    }).join(''):`<div style="color:#8b9bb4;text-align:center;padding:40px">Nenhum pedido confirmado nesse dia.</div>`;
    ordersHtml=`<div style="font-size:13px;color:#8b9bb4;margin-bottom:14px"><b style="color:#e6edf6">${orders.length}</b> pedido(s)${totV>0?` · total <b style="color:#34d399">R$ ${totV}</b>`:''}${nS>0?` · <b style="color:#34d399">${nP}</b> das pressels · <b style="color:#e6edf6">${nS}</b> sem rastreio`:''}</div>${oCards}`;
  }
  let leadsHtml='';
  if(view==='leads'){
    const _pnm={}; pressels.forEach(pp=>{ _pnm[String(pp.id)]=pp.nome||('Pressel '+pp.id); });
    const pad=n=>String(n).padStart(2,'0');
    const fmtNum=n=>{ n=String(n||'').replace(/\D/g,''); if(!n) return 'número não registrado'; return n.startsWith('55')?n.slice(2):n; };
    const waHref=ph=>{ let d=String(ph||'').replace(/\D/g,''); if(!d) return ''; if(d.length<=11) d='55'+d; return 'https://wa.me/'+d; };   // link direto pra conversa
    const baseAt=inst=>String(inst||'').replace(/^ax_/,'').replace(/_b$/,'')||'?';   // instância -> id do vendedor (backup _b soma no mesmo)
    const byName=(a,b)=>String(nameMap[a]||a).localeCompare(String(nameMap[b]||b));
    const cpBlocks=[];   // texto de cópia por vendedor (só no modo autenticado)
    // Seletor Dia / Mês (fica dentro do painel de Leads)
    const _perSeg=(lbl,pv)=>{ const act=per===pv; const qs=['view=leads',pv==='mes'?'per=mes':'',dayQ,kq].filter(Boolean).join('&'); return `<a href="?${qs}" style="padding:6px 15px;font-size:12px;font-weight:700;text-decoration:none;border-radius:7px;${act?'background:#2b6cb0;color:#fff':'color:#7aa2ff'}">${lbl}</a>`; };
    const perToggle=`<div style="display:inline-flex;gap:2px;background:#141c2b;border:1px solid #2b6cb0;border-radius:9px;padding:3px;margin-bottom:14px">${_perSeg('Dia','dia')}${_perSeg('Mês','mes')}</div>`;
    let bodyHtml='';
    if(per==='mes'){
      // ── VISÃO MENSAL: por vendedor, quantos leads chegaram, quantos compraram, quanto faturou + lista de compradores ──
      const dP=day.split('-'); const mY=+dP[0], mM=+dP[1];
      const monthStart=Math.floor(new Date(dP[0]+'-'+dP[1]+'-01T00:00:00-03:00').getTime()/1000);
      const nY=mM===12?mY+1:mY, nM=mM===12?1:mM+1;
      const monthEnd=Math.floor(new Date(nY+'-'+pad(nM)+'-01T00:00:00-03:00').getTime()/1000);
      const mNames=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
      const monthLabel=mNames[mM-1]+'/'+mY;
      let mLeads=[], mSales=[];
      try{
        try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN num TEXT').run(); }catch(_){}
        const lr=await env.DB.prepare("SELECT phone, inst, ts FROM wa_lead WHERE ts>=? AND ts<?").bind(monthStart,monthEnd).all();
        mLeads=lr.results||[];
        const sr=await env.DB.prepare("SELECT phone, instance, name, value, ts FROM wa_sales WHERE ts>=? AND ts<? ORDER BY ts ASC").bind(monthStart,monthEnd).all();
        mSales=sr.results||[];
      }catch(_){}
      const lByAt={}; mLeads.forEach(l=>{ const at=baseAt(l.inst); (lByAt[at]=lByAt[at]||[]).push(l); });
      // buyerInfo: telefone -> compra agregada do mês (soma valor, última data/nome). O crédito de conversão segue o DONO do lead, não quem fechou.
      const buyerInfo={}; mSales.forEach(s=>{ const p=String(s.phone||'').replace(/\D/g,''); if(!p) return; const v=Number(s.value)||0, t=Number(s.ts||0); if(!buyerInfo[p]){ buyerInfo[p]={value:v,ts:t,name:s.name||''}; } else { buyerInfo[p].value+=v; if(t>=buyerInfo[p].ts){ buyerInfo[p].ts=t; if(s.name) buyerInfo[p].name=s.name; } } });
      // TOPS EM CIMA: quem mais converteu → melhor % → mais faturou → mais leads
      const _mc=(at)=>(lByAt[at]||[]).reduce((s,l)=>{ const p=String(l.phone||'').replace(/\D/g,''); return s+((p&&buyerInfo[p])?1:0); },0);
      const _mr=(at)=>(lByAt[at]||[]).reduce((s,l)=>{ const p=String(l.phone||'').replace(/\D/g,''); const b=p?buyerInfo[p]:null; return s+(b?(Number(b.value)||0):0); },0);
      const allAts=Object.keys(lByAt).filter(a=>a&&a!=='?').sort((a,b)=>{
        const ca=_mc(a), cb=_mc(b), la=(lByAt[a]||[]).length, lb=(lByAt[b]||[]).length;
        const pa=la>0?ca/la:0, pb=lb>0?cb/lb:0;
        return (cb-ca) || (pb-pa) || (_mr(b)-_mr(a)) || (lb-la) || byName(a,b);
      });
      if(lByAt['?']) allAts.push('?');   // leads sem instância vão pro fim
      // Totais: leads do mês e quantos DESSES leads compraram (distintos; wa_lead.phone é PK)
      let totComp=0, totRev=0;
      mLeads.forEach(l=>{ const p=String(l.phone||'').replace(/\D/g,''); if(!p) return; const b=buyerInfo[p]; if(b){ totComp++; totRev+=Number(b.value)||0; } });
      const totLeads=mLeads.length;
      const cardM=(lbl,val,color)=>`<div style="flex:1;min-width:120px;background:#141c2b;border:1px solid #233047;border-radius:12px;padding:12px 14px"><div style="font-size:10.5px;color:#8b9bb4">${lbl}</div><div style="font-size:22px;font-weight:800;color:${color};margin-top:2px">${val}</div></div>`;
      const kpi=(l,v,c)=>`<div style="flex:1"><div style="font-size:10px;color:#8b9bb4">${l}</div><div style="font-size:15px;font-weight:800;color:${c}">${v}</div></div>`;
      const summary=`<div style="font-size:13px;color:#8b9bb4;margin-bottom:12px">Mês de <b style="color:#e6edf6;text-transform:capitalize">${monthLabel}</b>${full?' · <span style="color:#34d399">verde = comprou</span> · toque no número pra abrir a conversa':''}</div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">${cardM('Leads no mês',totLeads,'#7aa2ff')}${cardM('Converteram',totComp,'#34d399')}${cardM('Faturou','R$ '+totRev,'#34d399')}</div>`;
      const cols=allAts.length?allAts.map(at=>{
        const name=nameMap[at]||(at==='?'?'Sem vendedor':'Vendedor');
        const arrL=lByAt[at]||[];
        const lc=arrL.length;   // wa_lead.phone é PK -> leads já distintos
        // leads DESTE vendedor que compraram (subconjunto dos leads -> conversão nunca passa de 100%)
        const buyers=[]; const bseen=new Set();
        arrL.forEach(l=>{ const p=String(l.phone||'').replace(/\D/g,''); if(!p||bseen.has(p)) return; bseen.add(p); const b=buyerInfo[p]; if(b) buyers.push({phone:p,value:b.value,ts:b.ts,name:b.name}); });
        buyers.sort((a,b)=>(Number(b.ts||0)-Number(a.ts||0)));   // compra mais recente primeiro
        const comp=buyers.length;
        const rev=buyers.reduce((a,b)=>a+(Number(b.value)||0),0);
        const pct=lc>0?Math.round(comp/lc*100)+'%':'—';
        const cpLines=[name+' — compradores de '+monthLabel];
        const buyerRows=buyers.length?buyers.map(b=>{
          const bt=new Date((Number(b.ts||0)-10800)*1000);
          const dh=isNaN(bt)?'':(pad(bt.getUTCDate())+'/'+pad(bt.getUTCMonth()+1)+' '+pad(bt.getUTCHours())+':'+pad(bt.getUTCMinutes()));
          const ph=b.phone;
          const val=Number(b.value)||0;
          if(full && ph){ cpLines.push(fmtNum(ph)+'  '+dh+(val>0?('  R$ '+val):'')+(b.name?('  '+b.name):'')+'  '+waHref(ph)); }
          const numCell=(full&&ph)
            ? `<a href="${waHref(ph)}" target="_blank" rel="noopener" title="Abrir conversa no WhatsApp" style="color:#34d399;font-weight:700;font-family:ui-monospace,monospace;text-decoration:none;cursor:pointer">${_escHtml(fmtNum(ph))}</a>`
            : `<span style="color:#34d399;font-weight:700;font-family:ui-monospace,monospace">${ph?('…'+ph.slice(-4)):''}</span>`;
          return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid #1a2436;font-size:11.5px"><span style="color:#8b9bb4;font-variant-numeric:tabular-nums;white-space:nowrap">${dh}</span><span style="flex:1;min-width:0">${numCell}${b.name?` <span style="color:#6b7a93">· ${_escHtml(String(b.name))}</span>`:''}</span>${val>0?`<span style="color:#34d399;font-weight:700;white-space:nowrap">R$ ${val}</span>`:''}</div>`;
        }).join(''):`<div style="font-size:11.5px;color:#6b7a93;padding:8px 0">Nenhum lead comprou ainda.</div>`;
        let cpBtn='';
        if(full && buyers.length){ const idx=cpBlocks.length; cpBlocks.push(cpLines.join('\n')); cpBtn=`<button onclick="cpSeller(${idx},this)" style="font-size:10.5px;font-weight:700;color:#7aa2ff;background:#15233a;border:1px solid #2b6cb0;border-radius:8px;padding:4px 10px;cursor:pointer">Copiar compradores</button>`; }
        return `<div style="flex:1;min-width:250px;max-width:360px;background:#141c2b;border:1px solid #233047;border-radius:14px;padding:14px 16px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="font-size:14px;font-weight:800">${_escHtml(name)}</div>${cpBtn}</div><div style="display:flex;gap:8px;margin:10px 0 6px">${kpi('Leads',lc,'#7aa2ff')}${kpi('Converteram',comp,'#34d399')}${kpi('Conversão',pct,'#e6edf6')}${kpi('Faturou','R$ '+rev,'#34d399')}</div><div style="font-size:11px;color:#8b9bb4;font-weight:700;margin-top:6px;border-top:1px solid #233047;padding-top:8px">Compradores</div>${buyerRows}</div>`;
      }).join(''):`<div style="color:#8b9bb4;text-align:center;padding:40px">Nenhum lead nesse mês.</div>`;
      bodyHtml=`${summary}<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">${cols}</div>`;
    } else {
      // ── VISÃO DIÁRIA (padrão) ──
      let leads=[];
      let saleSet=new Set();
      const nameByPhone={};   // telefone (só dígitos) -> nome do perfil do WhatsApp
      try{
        try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN num TEXT').run(); }catch(_){}
        try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}
        const dstart=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), dend=dstart+86400;
        const r=await env.DB.prepare("SELECT phone, inst, num, pid, src, ts FROM wa_lead WHERE ts>=? AND ts<? ORDER BY ts ASC").bind(dstart,dend).all();
        leads=r.results||[];
        // telefones que VIRARAM venda (do dia em diante) → pra pintar o número de verde
        try{ const sr=await env.DB.prepare("SELECT DISTINCT phone FROM wa_sales WHERE ts>=?").bind(dstart).all(); (sr.results||[]).forEach(x=>{ const p=String(x.phone||'').replace(/\D/g,''); if(p) saleSet.add(p); }); }catch(_){}
        // NOME do lead: o WhatsApp manda o nome do perfil na captura (wa_chats.name). Puxa só pros
        // telefones do dia (JOIN, sem estourar limite de parâmetro) pra mostrar ao lado do número.
        try{ const nr=await env.DB.prepare("SELECT c.phone, c.name FROM wa_chats c JOIN (SELECT DISTINCT phone FROM wa_lead WHERE ts>=? AND ts<?) l ON l.phone=c.phone WHERE c.name IS NOT NULL AND c.name<>''").bind(dstart,dend).all(); (nr.results||[]).forEach(x=>{ const p=String(x.phone||'').replace(/\D/g,''); if(p&&x.name) nameByPhone[p]=String(x.name); }); }catch(_){}
      }catch(_){}
      const isSale=ph=>!!(ph&&saleSet.has(ph));
      const byAt={};
      leads.forEach(l=>{ const at=baseAt(l.inst); (byAt[at]=byAt[at]||[]).push(l); });
      // TOPS EM CIMA: quem mais vendeu → melhor conversão → mais leads (nome só desempata)
      const _dv=(at)=>(byAt[at]||[]).reduce((s,l)=>s+(isSale(String(l.phone||'').replace(/\D/g,''))?1:0),0);
      const ats=Object.keys(byAt).sort((a,b)=>{
        const va=_dv(a), vb=_dv(b), la=(byAt[a]||[]).length, lb=(byAt[b]||[]).length;
        const pa=la>0?va/la:0, pb=lb>0?vb/lb:0;
        return (vb-va) || (pb-pa) || (lb-la) || byName(a,b);
      });
      const cols=ats.length?ats.map(at=>{
        const arr=byAt[at], name=nameMap[at]||'Vendedor';
        const daP=arr.filter(l=>l.pid&&String(l.pid).trim()!=='').length;
        const byNum={}, numOrder=[];
        arr.forEach(l=>{ const k=String(l.num||''); if(!(k in byNum)){ byNum[k]=[]; numOrder.push(k); } byNum[k].push(l); });
        const cpLines=[name+' — leads de '+dLabel];   // conteúdo do botão "Copiar leads"
        const numSecs=numOrder.map(k=>{
          const ls=byNum[k];
          const rows=ls.map(l=>{
            const bt=new Date((Number(l.ts||0)-10800)*1000);
            const hora=isNaN(bt)?'':`${pad(bt.getUTCHours())}:${pad(bt.getUTCMinutes())}`;
            const attr=!!(l.pid&&String(l.pid).trim()!=='');
            const pnome=attr?(_pnm[String(l.pid)]||'pressel'):'sem rastreio';
            const tag=attr?`<span style="font-size:9.5px;font-weight:700;color:#34d399">${_escHtml(_pnm[String(l.pid)]||'pressel')}</span>`:`<span style="font-size:9.5px;color:#6b7a93">sem rastreio</span>`;
            const ph=String(l.phone||'').replace(/\D/g,'');
            const sale=isSale(ph);
            const nome=nameByPhone[ph]||'';   // nome do perfil do WhatsApp (se veio na captura)
            if(full && ph){ cpLines.push(fmtNum(ph)+(nome?('  '+nome):'')+'  '+hora+'  '+pnome+(sale?'  VENDA':'')+'  '+waHref(ph)); }
            const numCol=sale?'#34d399':(full?'#e2e8f0':'#cbd5e1');   // verde = virou venda
            const numTxt=full&&ph?fmtNum(ph):(ph?('…'+ph.slice(-4)):'');
            // NÚMERO em cima (destaque), nome embaixo (menor, cinza). Sem nome, mostra só o número.
            const ident=nome
              ? `<span style="display:flex;flex-direction:column;line-height:1.25;min-width:0"><span style="color:${numCol};font-weight:${sale?'700':'600'};font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escHtml(numTxt)}</span><span style="color:#8b9bb4;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escHtml(nome)}</span></span>`
              : `<span style="color:${numCol};font-weight:${sale?'700':(full?'600':'400')};font-family:ui-monospace,monospace">${_escHtml(numTxt)}</span>`;
            const numCell=(full&&ph)
              ? `<a href="${waHref(ph)}" target="_blank" rel="noopener" title="Abrir conversa no WhatsApp" style="flex:1;min-width:0;text-decoration:none;cursor:pointer">${ident}</a>`
              : `<span style="flex:1;min-width:0">${ident}</span>`;
            return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid #1a2436;font-size:11.5px"><span style="color:#8b9bb4;font-variant-numeric:tabular-nums;flex:none">${hora}</span>${numCell}${tag}</div>`;
          }).join('');
          return `<div style="margin-top:11px"><div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#7aa2ff;font-weight:700"><span style="font-family:ui-monospace,monospace">${_escHtml(fmtNum(k))}</span><span style="background:#1a2942;padding:1px 8px;border-radius:9px">${ls.length}</span></div>${rows}</div>`;
        }).join('');
        let cpBtn='';
        if(full){ const idx=cpBlocks.length; cpBlocks.push(cpLines.join('\n')); cpBtn=`<button onclick="cpSeller(${idx},this)" style="font-size:10.5px;font-weight:700;color:#7aa2ff;background:#15233a;border:1px solid #2b6cb0;border-radius:8px;padding:4px 10px;cursor:pointer">Copiar leads</button>`; }
        return `<div style="flex:1;min-width:230px;max-width:340px;background:#141c2b;border:1px solid #233047;border-radius:14px;padding:14px 16px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="font-size:14px;font-weight:800">${_escHtml(name)}</div>${cpBtn}</div><div style="font-size:11.5px;color:#8b9bb4;margin-top:2px"><b style="color:#e6edf6">${arr.length}</b> leads · <b style="color:#34d399">${daP}</b> da pressel</div>${numSecs}</div>`;
      }).join(''):`<div style="color:#8b9bb4;text-align:center;padding:40px">Nenhum lead nesse dia.</div>`;
      const totL=leads.length, totP=leads.filter(l=>l.pid&&String(l.pid).trim()!=='').length;
      const hint=full?' · <span style="color:#34d399">verde = virou venda</span> · toque no número pra abrir a conversa':'';
      bodyHtml=`<div style="font-size:13px;color:#8b9bb4;margin-bottom:14px"><b style="color:#e6edf6">${totL}</b> leads novos${totP<totL?` · <b style="color:#34d399">${totP}</b> da pressel · ${totL-totP} sem rastreio`:''}${hint}</div><div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">${cols}</div>`;
    }
  const cpData=full?`<script>var _CP=${JSON.stringify(cpBlocks).replace(/</g,'\\u003c')};function cpSeller(i,b){try{navigator.clipboard.writeText(_CP[i]||'');var o=b.textContent;b.textContent='Copiado!';setTimeout(function(){b.textContent=o},1400);}catch(e){}}</script>`:'';
    leadsHtml=`${perToggle}${bodyHtml}${cpData}`;
  }
  return _presselHtml(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${isToday?'<meta http-equiv="refresh" content="30">':''}<title>Métricas — Todas as Pressels</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1220;color:#e6edf6;font-family:system-ui,-apple-system,Arial,sans-serif;padding:24px}.wrap{max-width:920px;margin:0 auto}h1{font-size:22px;margin-bottom:4px}table{width:100%;border-collapse:collapse}th{font-weight:600}.shell{display:flex;gap:20px;align-items:flex-start;justify-content:center;max-width:1580px;margin:0 auto}.shell>.wrap{flex:0 1 920px;min-width:0;margin:0}.side-sp{flex:0 100 300px;min-width:0}.side{flex:0 0 300px;position:sticky;top:24px}@media(max-width:1120px){.shell{flex-wrap:wrap}.side-sp{display:none}.side{flex:1 1 100%;position:static;order:-1}}</style></head><body><div class="shell">${_diagHtml?`<div class="side-sp"></div>`:''}<div class="wrap"><h1>Métricas — Todas as Pressels</h1><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:20px"><input type="date" value="${day}" max="${today}" onchange="if(this.value)location.href='?day='+this.value+'${view!=='metricas'?('&view='+view):''}${kq?('&'+kq):''}${(view==='leads'&&per==='mes')?'&per=mes':''}'" style="background:#141c2b;border:1px solid #233047;color:#e6edf6;border-radius:8px;padding:5px 9px;font-size:12.5px;font-family:inherit;color-scheme:dark;cursor:pointer">${isToday?'<span style="color:#6b7a93;font-size:12px">atualiza sozinho a cada 30s</span>':`<a href="?${[view!=='metricas'?('view='+view):'',kq,(view==='leads'&&per==='mes')?'per=mes':''].filter(Boolean).join('&')}" style="color:#7aa2ff;font-size:12.5px;text-decoration:none">← voltar pra hoje</a>`}${toggleBtn}</div>${view==='vendas'?ordersHtml:(view==='leads'?leadsHtml:(totalSec+presselSecs))}<p style="color:#6b7a93;font-size:11.5px;margin-top:16px;line-height:1.5">${view==='vendas'?'Pedidos confirmados ("Pedido Concluído") do dia. A etiqueta verde mostra de qual pressel o pedido veio; "(aprox)" = casado pelo clique recente no número (o lead apagou o código). "sem rastreio" = não deu pra atribuir a nenhuma pressel.':view==='leads'?'Leads NOVOS do dia (1º contato de cada número — lead antigo que remanda NÃO conta de novo), separados por atendente e pelo número que recebeu. A divisória por número separa, por ex., o número da manhã do que entrou depois. Verde = veio da pressel · "~" = casado por tempo (código apagado).':'Números reais do dia selecionado. Chegaram e Foram pro WhatsApp contam só tráfego do TikTok (ttclid). Iniciaram contato e Vendas vêm do WhatsApp.'}</p></div>${_diagHtml?`<aside class="side">${_diagHtml}</aside>`:''}</div></body></html>`);
}
async function handlePresselPublic(req, env, id){
  const data = await _getDashData(env);   // cacheado: era parseado (1.3MB) a cada clique de anúncio
  const pressels=Array.isArray(data.pressels)?data.pressels:[];
  const chips=Array.isArray(data.chips)?data.chips:[];
  const p=pressels.find(x=>String(x.id)===String(id));
  if(!p || (p.status && p.status!=='ativa')) return _presselOffline();
  // só roteia lead pra número com WhatsApp conectado AGORA (pula número caído automaticamente)
  // Map: instância → número conectado (pra roteador conferir o número certo).
  // 'sc' = Sale Chat rodando. A roleta NÃO pode depender só da Evolution (que está saindo de
  // operação): sem contar o Sale Chat, wa_conn fica sem nenhuma linha 'open', o Map fica VAZIO
  // (que é truthy!) e _servConnOk reprova TODO número → a pressel serve offline e não entra lead.
  let liveSet=null;
  try{
    // A linha 'sc' do wa_conn NÃO expira sozinha: ela fica gravada com o último heartbeat. Sem checar
    // a idade, um número que caiu continuava "vivo" pra sempre e seguia recebendo lead (aconteceu de
    // verdade: o WhatsApp caiu e a roleta continuou mandando). Só vale 'sc' com sinal dos últimos 3min.
    // A validade vale pros DOIS estados. Antes só o 'sc' expirava, e uma linha 'open' velha da
    // Evolution ficava valendo pra sempre — bastava um registro antigo pra manter um número morto
    // recebendo lead eternamente. Com a operação 100% no Sale Chat, isso viraria um ralo silencioso.
    const cs=await env.DB.prepare("SELECT instance, number FROM wa_conn WHERE updated_at > strftime('%s','now')-180 AND state IN ('open','sc')").all();
    const m=new Map((cs.results||[]).map(r=>[r.instance, r.number||'']));
    // heartbeat recente do Sale Chat também vale como número vivo (independe do wa_conn ter sido gravado)
    try{
      const hb=await env.DB.prepare("SELECT self_number FROM sc_heartbeat WHERE last_seen > strftime('%s','now')-180").all();
      (hb.results||[]).forEach(h=>{ if(h && h.self_number) m.set('sc_'+h.self_number, String(h.self_number)); });
    }catch(_){}
    liveSet = m.size ? m : null;   // vazio = não sabemos nada → fail-open (null), NUNCA fail-closed
  }catch(_){}
  // ids de status que significam "Em uso" (a dash grava ids customizados tipo st_xxxx
  // com label "Em uso"; sem isso o worker não reconhecia o principal e tirava o
  // vendedor da roleta enquanto a tela mostrava ele ligado).
  const emUsoIds=new Set(['em_uso']);
  try{ (Array.isArray(data.wa_statuses)?data.wa_statuses:[]).forEach(s=>{
    const lbl=String((s&&(s.label||s.id))||'').toLowerCase().replace(/[_\s]+/g,' ').trim();
    if(lbl==='em uso' && s && s.id) emUsoIds.add(String(s.id));
  }); }catch(_){}
  const sellers=_resolvePresselSellers(p, chips, liveSet, emUsoIds);
  if(!sellers.length) return _presselOffline();
  const pick=await _presselBalancedPick(env, id, sellers);   // número efetivo (overflow por cota) do vendedor mais "atrás" hoje
  if(!pick) return _presselOffline();
  try{  // conta TODO acesso à pressel (diagnóstico: tráfego real vs rastreado)
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_hits (pid TEXT, day TEXT, hits INTEGER DEFAULT 0, PRIMARY KEY(pid,day))').run();
    await env.DB.prepare('INSERT INTO pressel_hits (pid, day, hits) VALUES (?, ?, 1) ON CONFLICT(pid,day) DO UPDATE SET hits = hits + 1').bind(String(id), _brDay()).run();
  }catch(_){}
  const ttclid = new URL(req.url).searchParams.get('ttclid') || '';   // click id do anúncio do TikTok
  let leadCode = '';
  // SEMPRE gera o código, com ou sem ttclid. O servidor SABE qual pressel está servindo esta
  // página, então deixar o lead chegar "sem rastreio" era jogar fora uma informação que já
  // estava na mão. Sem ttclid (orgânico, link compartilhado, TikTok que não passou o parâmetro)
  // perde-se só o pixel — a PRESSEL continua rastreada. A 1ª letra do código é a pressel.
  try{  // gera/reusa um CÓDIGO por clique (vai no texto do WhatsApp p/ atribuição EXATA); dedup por ttclid
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS tt_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, inst TEXT, ttclid TEXT, pid TEXT, ts INTEGER, claimed INTEGER DEFAULT 0)').run();
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN code TEXT').run(); }catch(_){}
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN clicked INTEGER DEFAULT 0').run(); }catch(_){}   // pra deduplicar "Foram pro WhatsApp" por ttclid
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN num_key TEXT').run(); }catch(_){}
    const ex = ttclid ? await env.DB.prepare('SELECT code FROM tt_pending WHERE ttclid=? LIMIT 1').bind(ttclid).first() : null;
    if(ex){ leadCode = ex.code || ''; }
    else {
      leadCode = _genLeadCode(id);
      // Grava também o NÚMERO pra onde a pessoa foi. A atribuição casa por número, então
      // trocar o número de principal↔complementar não desliga mais o rastreio do lead.
      const _nk = String(pick.num||'').replace(/\D/g,'').slice(-8);
      await env.DB.prepare("INSERT INTO tt_pending (inst, ttclid, pid, ts, claimed, code, num_key) VALUES (?,?,?,strftime('%s','now'),0,?,?)").bind(pick.inst, ttclid, String(id), leadCode, _nk).run();
      if(ttclid){ try{ await _bumpPressel(env, id, 'views'); }catch(_){} }   // conta SÓ tráfego real do TikTok, 1x por clique
    }
  }catch(_){}
  // mensagem do WhatsApp com o código do clique — pra atribuição exata pelo código
  let waMsg = String(p.msg||'');
  if(leadCode){ waMsg += (waMsg?'\n':'') + 'Código de desconto "'+leadCode+'"!'; }
  const wa=_waLink(pick.num, waMsg);
  if(!wa) return _presselOffline();
  const bg=/^(#[0-9a-fA-F]{3,8}|rgb\([\d,\s.]+\)|rgba\([\d,\s.%]+\)|[a-zA-Z]+)$/.test(String(p.bg||''))?String(p.bg):'#ffffff';   // valida cor, evita injeção de CSS no <style>
  const secs=Math.max(0, Number(p.redirect)||0);
  const waJson=JSON.stringify(wa);
  let _wd=String(pick.num||'').replace(/\D/g,''); if(_wd.length<=11) _wd='55'+_wd;
  const waAppJson=JSON.stringify('whatsapp://send?phone='+_wd+(waMsg?('&text='+encodeURIComponent(waMsg)):''));   // deep link: abre o app DIRETO na conversa (com o código no texto)
  const head=`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_escHtml(p.nome||'')}</title>${_ttPixel(p)}<style>*{margin:0;padding:0;box-sizing:border-box}body{background:${bg};font-family:system-ui,-apple-system,Arial,sans-serif;min-height:100vh}.wrap{max-width:480px;margin:0 auto}img{width:100%;display:block}</style></head>`;
  const script=`<script>var _ttc=new URLSearchParams(location.search).get('ttclid')||'';var IS_TT=!!_ttc;if(IS_TT){try{ttq&&ttq.page()}catch(e){}}var _tk=false;function track(){if(_tk||!IS_TT)return;_tk=true;try{ttq&&ttq.track('ClickButton')}catch(e){}try{navigator.sendBeacon('/pc/${id}?ttclid='+encodeURIComponent(_ttc))}catch(e){}}function go(){track();try{location.href=${waAppJson}}catch(e){}setTimeout(function(){if(!document.hidden)location.href=${waJson}},1500);}${secs>0?`setTimeout(go,${secs*1000});`:''}</script>`;
  const els=_presselElsServer(p);
  let body=els.map(e=>_elPublicHtml(e, wa)).join('');
  if(p.fullclick){
    return _presselHtml(`${head}<body onclick="go()" style="cursor:pointer"><div class="wrap">${body}</div>${script}</body></html>`);
  }
  // Garante um botão de WhatsApp se o usuário não adicionou nenhum
  if(!els.some(e=>e.type==='botao')){
    body+=`<div style="padding:14px"><a href="${_escHtml(wa)}" onclick="event.preventDefault();event.stopPropagation();go()" style="display:flex;align-items:center;justify-content:center;gap:10px;background:#22c55e;color:#fff;border-radius:14px;padding:16px 18px;font-weight:800;font-size:19px;text-transform:uppercase;letter-spacing:.3px;text-decoration:none;box-shadow:0 4px 0 rgba(0,0,0,.18),0 7px 14px rgba(0,0,0,.13)"><svg viewBox="0 0 32 32" width="24" height="24" style="flex-shrink:0" fill="currentColor"><path d="M16.04 4C9.4 4 4 9.4 4 16.04c0 2.12.55 4.18 1.6 6L4 28l6.13-1.6a12 12 0 0 0 5.9 1.5c6.63 0 12.03-5.4 12.03-12.04C28.06 9.4 22.67 4 16.04 4Zm0 21.9a9.9 9.9 0 0 1-5.06-1.38l-.36-.22-3.64.96.97-3.55-.24-.37a9.86 9.86 0 1 1 8.33 4.56Zm5.43-7.42c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.49 0 1.47 1.08 2.89 1.23 3.09.15.2 2.12 3.24 5.13 4.54.72.31 1.27.5 1.71.64.72.23 1.37.2 1.89.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.12-.27-.19-.57-.34Z"/></svg><span>FALAR NO WHATSAPP</span></a></div>`;
  }
  return _presselHtml(`${head}<body><div class="wrap">${body}</div>${script}</body></html>`);
}

// ─── Router ───

export default {
  // Cron: mantém wa_conn (estado + número conectado) fresco mesmo com a dash FECHADA, puxando da Evolution.
  // Assim o roteador nunca manda lead pra número caído por causa de estado defasado (webhook às vezes perde o logout).
  async scheduled(event, env, ctx) {
    // BACKUP AUTOMÁTICO do estado da dash (incidente 21/07: aba antiga sobrescreveu
    // tudo e só deu pra recuperar porque o Time Travel do D1 existe — 30 dias e olhe lá).
    // Guarda no R2 (blob de ~1.4MB não deve inchar o D1). Roda no máx. 1x/hora e só
    // quando a versão mudou, e apaga sozinho o que passou de 30 dias.
    try { await _backupState(env); } catch (_) {}
    // Semeia número → vendedor ANTES de falar com a Evolution. A chamada externa pode demorar
    // (VPS lenta/fora) e engolir a rodada inteira do cron, e foi isso que deixou a tabela de donos
    // 18min desatualizada: número novo do vendedor ficava sem dono e a captura dele não virava
    // lead nem venda. O que é nosso roda primeiro; o que depende de fora roda depois.
    try { await _scEnsureTables(env); await _scSeedOwners(env); } catch (_) {}
    // Purga o que já não serve pra roteamento/atribuição, pra as tabelas quentes não crescerem sem
    // fim (deixavam os scans lentos e o custo do Worker subindo com a verba). Só apaga o antigo:
    // auditoria de captura > 3 dias e cliques pendentes > 7 dias (a janela de atribuição é 1h).
    // RESGATE DE VENDA EM QUARENTENA: "Pedido Concluído" que chegou quando o número ainda não tinha
    // dono ficou só na auditoria e NÃO virou venda (custou 6 vendas num único dia, todas lançadas na
    // mão). Agora, toda rodada, reprocessa as das últimas 24h cujo número JÁ tem dono. O
    // _waDetectSale é idempotente (dedupe por msg_id e por telefone/24h), então repassar é seguro.
    try {
      const q = await env.DB.prepare(
        `SELECT a.self_number, a.phone, a.msg_id, a.body FROM sc_ingest_audit a
         WHERE a.from_me=1 AND a.body LIKE '%Pedido Conclu%'
           AND a.received_at > strftime('%s','now')-86400
           AND NOT EXISTS (SELECT 1 FROM wa_sales s WHERE s.msg_id = a.msg_id)
         LIMIT 20`
      ).all();
      for (const r of (q.results || [])) {
        let ow = await resolveOwner(env, String(r.self_number || ''));
        // O número pode não estar mais atribuído na Contingência (o Diretor tirou o chip da coluna),
        // mas o SALE CHAT que capturou continua sendo de um vendedor. Vale a identidade da máquina.
        if (!ow || !ow.at_id) {
          try {
            const ins = await env.DB.prepare('SELECT at_id FROM sc_install WHERE num_last = ? AND at_id IS NOT NULL ORDER BY last_seen DESC LIMIT 1').bind(String(r.self_number || '')).first();
            if (ins && ins.at_id) ow = { at_id: String(ins.at_id), instance: 'ax_' + ins.at_id };
          } catch (_) {}
        }
        if (!ow || !ow.at_id) continue;   // ainda sem dono: fica pra próxima rodada
        // RESGATA TAMBÉM A ORIGEM: sem o LEAD, a venda entra "sem rastreio" e o CompletePayment sai
        // sem ttclid — a BM não recebe o crédito (43% das vendas de hoje ficaram assim). Recupera a
        // 1ª mensagem daquele cliente e casa com o clique ancorado NA HORA DA MENSAGEM (nunca em
        // "agora", senão o FIFO rouba o clique de outra pessoa e o pixel sai com o ttclid errado).
        try {
          const ja = await env.DB.prepare('SELECT phone FROM wa_lead WHERE phone=?').bind(String(r.phone || '')).first();
          if (!ja) {
            const inb = await env.DB.prepare(
              "SELECT body, ts, received_at FROM sc_ingest_audit WHERE phone=? AND from_me=0 ORDER BY received_at ASC LIMIT 1"
            ).bind(String(r.phone || '')).first();
            if (inb) {
              const mts = Number(inb.ts) || Number(inb.received_at) || 0;
              if (mts) {
                const cl = await env.DB.prepare(
                  `UPDATE tt_pending SET claimed=1 WHERE id=(SELECT id FROM tt_pending
                     WHERE (claimed IS NULL OR claimed=0) AND ttclid IS NOT NULL AND ttclid<>''
                       AND ts <= ? AND ts > ?-3600
                     ORDER BY ts DESC LIMIT 1) RETURNING ttclid, pid`
                ).bind(mts, mts).first();
                if (cl && cl.pid) {
                  await env.DB.prepare("INSERT OR IGNORE INTO wa_lead (phone, pid, ttclid, inst, src, num, ts) VALUES (?,?,?,?,'resgate',?,?)")
                    .bind(String(r.phone || ''), cl.pid, cl.ttclid || '', ow.instance || ('ax_' + ow.at_id), String(r.self_number || ''), mts).run();
                }
              }
            }
          }
        } catch (_) {}
        await _waDetectSale(env, ow.instance || ('ax_' + ow.at_id), {
          message: { conversation: String(r.body || '') },
          key: { remoteJid: String(r.phone || '') + '@c.us', remoteJidAlt: String(r.phone || '') + '@c.us', id: r.msg_id || null, fromMe: true }
        });
        try { await env.DB.prepare('UPDATE sc_ingest_audit SET at_id=? WHERE msg_id=?').bind(ow.at_id, r.msg_id).run(); } catch (_) {}
      }
    } catch (_) {}
    try { await env.DB.prepare("DELETE FROM sc_ingest_audit WHERE received_at < strftime('%s','now')-259200").run(); } catch (_) {}
    try { await env.DB.prepare("DELETE FROM tt_pending WHERE ts < strftime('%s','now')-604800").run(); } catch (_) {}
    // Reenvia pro TikTok o que falhou (rede/token/recusa). Sem isso a venda ficava marcada só na
    // dash e NUNCA chegava no pixel, e ninguém via. Mesmo event_id = TikTok deduplica, não conta 2x.
    try { await _ttRetryFailed(env); } catch (_) {}
    // Guarda o histórico dos envios por 60 dias (serve de prova pro gestor de tráfego).
    try { await env.DB.prepare("DELETE FROM tt_events WHERE status='ok' AND ts < strftime('%s','now')-5184000").run(); } catch (_) {}
    try {
      // Fonte no Sale Chat = não conversa mais com a Evolution. Sem isso o cron ficava
      // reescrevendo as linhas dela a cada 2min e ressuscitando conexão fantasma na tela.
      const live = (await _waCaptureSource(env)) === 'sc' ? null : await _evoInstances(env);
      if (live && live.length) {
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_conn (instance TEXT PRIMARY KEY, state TEXT, updated_at INTEGER)').run();
        try { await env.DB.prepare('ALTER TABLE wa_conn ADD COLUMN number TEXT').run(); } catch (_) {}
        for (const it of live) {
          try {
            await env.DB.prepare(
              `INSERT INTO wa_conn (instance, state, number, updated_at) VALUES (?, ?, ?, strftime('%s','now'))
               ON CONFLICT(instance) DO UPDATE SET state=excluded.state, number=excluded.number, updated_at=excluded.updated_at`
            ).bind(it.name, String(it.state), it.number || '').run();
          } catch (_) {}
        }
      }
    } catch (_) {}
  },
  async fetch(req, env, ctx) {
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
      if (req.method === 'GET'   && path === '/api/backups') return handleListBackups(req, env);

      // users CRUD
      if (req.method === 'GET'    && path === '/api/users')         return handleListUsers(req, env);
      if (req.method === 'POST'   && path === '/api/users')         return handleCreateOrUpdateUser(req, env);
      const restoreMatch = path.match(/^\/api\/users\/([^/]+)\/restore$/);
      if (req.method === 'POST'   && restoreMatch)                  return handleRestoreUser(req, env, restoreMatch[1]);

      // IA — gera copy via Gemini/Anthropic
      if (req.method === 'POST'   && path === '/api/ai/generate-copy') return handleAIGenerateCopy(req, env);

      // IA — config de API keys (gerenciável via UI da Dashboard)
      if (req.method === 'GET'    && path === '/api/config/ai-keys')      return handleAIConfigGet(req, env);
      if (req.method === 'POST'   && path === '/api/config/ai-keys')      return handleAIConfigSet(req, env);
      if (req.method === 'POST'   && path === '/api/config/ai-keys/test') return handleAIConfigTest(req, env);

      // WhatsApp (Evolution API) — ponte segura Dash → Worker → Evolution
      if (req.method === 'GET'    && path === '/api/config/wa') return handleWAConfigGet(req, env);
      if (req.method === 'POST'   && path === '/api/config/wa') return handleWAConfigSet(req, env);
      if (req.method === 'GET'    && path === '/api/wa/status') return handleWAStatus(req, env);
      if (req.method === 'POST'   && path === '/api/wa/send')       return handleWASend(req, env);
      if (req.method === 'POST'   && path === '/api/wa/send-audio') return handleWASendAudio(req, env);
      if (req.method === 'POST'   && path === '/api/wa/send-media') return handleWASendMedia(req, env);
      if (req.method === 'POST'   && path === '/api/wa/tts-test')   return handleTTSTest(req, env);
      if ((req.method === 'GET' || req.method === 'POST') && path === '/api/config/tts') return handleTTSConfig(req, env);
      // WhatsApp multi-instância (1 conexão por atendente)
      if (req.method === 'GET'    && path === '/api/wa/instances')        return handleWAInstances(req, env);
      if (req.method === 'POST'   && path === '/api/wa/instance/create')  return handleWAInstanceCreate(req, env);
      if (req.method === 'GET'    && path === '/api/wa/instance/connect') return handleWAInstanceConnect(req, env);
      if (req.method === 'GET'    && path === '/api/wa/instance/status')  return handleWAInstanceStatus(req, env);
      if (req.method === 'POST'   && path === '/api/wa/instance/logout')  return handleWAInstanceLogout(req, env);
      if (req.method === 'POST'   && path === '/api/wa/instance/disconnect') return handleWAInstanceDisconnect(req, env);
      if (req.method === 'GET'    && path === '/api/wa/conn')             return handleWAConn(req, env);
      if (req.method === 'GET'    && path === '/api/salechat')            return handleSaleChatGet(req, env);
      if (req.method === 'POST'   && path === '/api/salechat/media')      return handleSaleChatMediaUpload(req, env);
      const scMediaMatch = path.match(/^\/api\/salechat\/media\/(.+)$/);
      if (scMediaMatch && req.method === 'GET')    return handleSaleChatMediaGet(req, env, decodeURIComponent(scMediaMatch[1]));
      if (scMediaMatch && req.method === 'DELETE') return handleSaleChatMediaDelete(req, env, decodeURIComponent(scMediaMatch[1]));
      // Sale Chat Engine (Fase 0): captura em auditoria crua + heartbeat + saúde
      if (req.method === 'GET'    && path === '/api/salechat/health')     return handleSalechatHealth(req, env);
      if ((req.method === 'GET' || req.method === 'POST') && path === '/api/salechat/source') return handleSalechatSource(req, env);
      const scIngestMatch = path.match(/^\/api\/salechat\/ingest\/([a-zA-Z0-9_-]+)$/);
      if (scIngestMatch && req.method === 'POST')  return handleSalechatIngest(req, env, scIngestMatch[1]);
      const scHbMatch = path.match(/^\/api\/salechat\/heartbeat\/([a-zA-Z0-9_-]+)$/);
      if (scHbMatch && req.method === 'POST')      return handleSalechatHeartbeat(req, env, scHbMatch[1]);
      if (req.method === 'GET'    && path === '/api/wa/chats')            return handleWAChats(req, env);
      if (req.method === 'GET'    && path === '/api/wa/messages')         return handleWAMessages(req, env);
      if (req.method === 'POST'   && path === '/api/wa/chat/read')        return handleWAChatRead(req, env);
      if (req.method === 'POST'   && path === '/api/wa/chat/assign')      return handleWAChatAssign(req, env);
      if (req.method === 'GET'    && path === '/api/wa/sales')            return handleWASales(req, env);
      if (req.method === 'POST'   && path === '/api/wa/sale/delete')      return handleWASaleDelete(req, env);
      if (req.method === 'POST'   && path === '/api/wa/sale/add')         return handleWASaleAdd(req, env);
      if (req.method === 'POST'   && path === '/api/wa/sale/reassign')    return handleWASaleReassign(req, env);
      if (req.method === 'POST'   && path === '/api/wa/bot/preview')      return handleBotPreview(req, env);

      // Webhook de volta da Evolution (mensagens recebidas + conexão)
      const evoMatch = path.match(/^\/webhook\/evolution\/([a-zA-Z0-9_-]+)$/);
      if (evoMatch && (req.method === 'POST' || req.method === 'GET')) {
        if (req.method === 'GET') return json({ name: 'axion-evolution-webhook', ok: true, ready: true });
        return handleEvolutionWebhook(req, env, evoMatch[1], ctx);
      }
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

      // Pressel pública — lead da campanha cai aqui e a roleta manda pro WhatsApp
      // Métricas da pressel (dash lê) + beacon de clique (público)
      if (req.method === 'GET' && path === '/api/pressel/stats') return handlePresselStats(req, env);
      if (req.method === 'GET' && path === '/api/pressel/metrics') return handlePresselMetricsLive(req, env);
      const pcMatch = path.match(/^\/pc\/([a-zA-Z0-9_-]+)$/);
      if (pcMatch) {
        if (req.method === 'POST') {
          try {
            const _ttc = url.searchParams.get('ttclid') || '';
            if (_ttc) {   // dedup por ttclid: 1 "Foram pro WhatsApp" por visitante (nunca passa de "Chegaram")
              const u = await env.DB.prepare('UPDATE tt_pending SET clicked=1 WHERE ttclid=? AND (clicked IS NULL OR clicked=0)').bind(_ttc).run();
              if (u.meta && u.meta.changes > 0) await _bumpPressel(env, pcMatch[1], 'clicks');
            }
          } catch (_) {}
        }
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
      }

      const presselMatch = path.match(/^\/p\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && presselMatch) return handlePresselPublic(req, env, presselMatch[1]);

      // Página pública de métricas (compartilhar com gestores de tráfego)
      const mMatch = path.match(/^\/m\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && mMatch) return handlePresselMetricsPage(req, env, mMatch[1]);

      // Página pública CONSOLIDADA: total de todas + cada pressel numa seção
      if (req.method === 'GET' && path === '/pressels-total') return handlePresselsTotalPage(req, env);

      return err('Rota não encontrada', 404);
    } catch (e) {
      console.error('worker error', e?.stack || e);
      return err('Erro interno: ' + (e?.message || 'desconhecido'), 500);
    }
  },
};
