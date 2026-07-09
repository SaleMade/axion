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
async function _ensureConfigTable(env) {
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)'
    ).run();
  } catch (_) {}
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

  // Mapeamento por status (mais específico)
  if (s === 'pending' || s === 'awaiting_payment') return 'aguardando_pagamento';
  if (s === 'paid')        return 'finalizada';
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

  const eventRaw = String(body?.event || body?.evento || body?.tipo || '').toLowerCase();
  const status = order.status || body?.status || '';
  const modality = order.payment_modality || order.modalidade_pagamento || '';
  const event = mapPaytEvent(eventRaw, status, modality);

  return {
    event,           // chave canônica usada no payt_mapping
    event_raw: eventRaw,
    status,
    modality,
    order_id: order.id || order.order_id || body?.id || body?.pedido_id || '',
    name: order.client_name || customer.name || customer.nome || '',
    email: order.client_email || customer.email || '',
    phone: order.client_whatsapp || order.client_phone || customer.phone || customer.telefone || customer.whatsapp || customer.celular || '',
    cpf: order.cpf || order.client_cpf || customer.cpf || customer.document || customer.documento || '',
    amount: Number(order.total_amount || order.amount || order.valor || order.total || body?.amount || body?.valor || 0),
    product: body?.treatment?.name || order.treatment?.name || order.product || order.produto || (Array.isArray(order.products) ? order.products[0]?.name : '') || '',
    payment_method: order.payment_method || order.metodo_pagamento || '',
    tracking_code: order.tracking_code || '',
    brand: order.brand || '',
    seller_id: body?.seller?.id || '',
    seller_name: body?.seller?.name || '',
    // Endereço estruturado da PAYT
    cep: address.cep || address.zipcode || customer.zipcode || customer.cep || '',
    street: address.street || address.endereco || customer.endereco || '',
    number: address.number || address.numero || '',
    complement: address.complement || address.complemento || '',
    neighborhood: address.neighborhood || address.bairro || '',
    city: address.city || customer.city || '',
    state: address.state || customer.state || customer.uf || '',
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
    // VENDA ESTIMADA DESATIVADA (v2.27): não criamos mais venda com bruto × 12%
    // chutado. A receita real vem da Payt (comissão líquida do afiliado), importada
    // do CSV e — quando o parser Payt V1 ao vivo estiver pronto (usando o payt_debug
    // capturado) — direto do postback. O lead continua mudando de etapa/spg acima.
    // (bloco de criação de venda removido de propósito.)
    action_taken = 'updated';
    lead_id_result = lead.id;
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
      at: null,
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

    // Se ação for 'pagar', registra venda (com idempotência dupla)
    if (mapping?.action === 'pagar') {
      state.vendas = state.vendas || [];
      const orderKey = lead_data.external_id || '';
      const alreadyHas = state.vendas.some(v =>
        v.leadId === lead.id ||
        (orderKey && v.external_order_id === orderKey)
      );
      if (!alreadyHas && lead.vl) {
        const com_pct = Number(lead.com_pct) || 12;
        const comiss = lead.vl * com_pct / 100;
        state.vendas.unshift({
          id: Date.now(),
          leadId: lead.id,
          external_order_id: orderKey,
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
  try { await evoFetch(env, `/instance/logout/${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (_) {}
  try { await env.DB.prepare("UPDATE wa_conn SET state='close', updated_at=strftime('%s','now') WHERE instance=?").bind(name).run(); } catch (_) {}
  return json({ ok: true, instance: name, disconnected: true });
}

// ─── Webhook de volta (Evolution → Worker) ───────────────────
// Recebe eventos da Evolution: mensagens recebidas (auto-resposta de primeiro
// contato + atribuição de vendedor) e mudança de conexão (detectar número
// caído). Tudo gated pela chave-mestra wa_autom_on. Conexão/atribuição/dedupe
// ficam em tabelas D1 próprias, pra NÃO conflitar com o blob de estado da dash.
async function _waEnsureTables(env) {
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_conn (instance TEXT PRIMARY KEY, state TEXT, updated_at INTEGER)').run();
    try{ await env.DB.prepare('ALTER TABLE wa_conn ADD COLUMN number TEXT').run(); }catch(_){}   // número REALMENTE conectado (ownerJid da Evolution)
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_attrib (phone TEXT PRIMARY KEY, instance TEXT, updated_at INTEGER)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_replied (phone TEXT PRIMARY KEY, updated_at INTEGER)').run();
    // Conversas (inbox/CRM): cada mensagem in/out + resumo por contato pro inbox
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_messages (msg_id TEXT PRIMARY KEY, phone TEXT NOT NULL, instance TEXT, direction TEXT, type TEXT, body TEXT, push_name TEXT, ts INTEGER)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON wa_messages(phone, ts)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_chats (phone TEXT PRIMARY KEY, instance TEXT, name TEXT, last_text TEXT, last_ts INTEGER, last_dir TEXT, unread INTEGER DEFAULT 0, assigned_to TEXT, updated_at INTEGER)').run();
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
  await _waLeadCapture(env, instance, phone, _ex.body);   // 1ª msg = LEAD: casa com o clique pelo código no texto e dispara evento pro pixel
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
async function handleEvolutionWebhook(req, env, token) {
  const expected = await _waWebhookToken(env);
  if (!expected || token !== expected) return json({ error: 'token inválido' }, 401);
  let body; try { body = await req.json(); } catch (_) { return json({ ok: true }); }
  const event = String(body?.event || '').toLowerCase().replace(/_/g, '.');
  const instance = body?.instance || body?.instanceName || '';
  const data = body?.data || {};
  try {
    if (event === 'connection.update') await _waOnConnection(env, instance, data);
    else if (event === 'messages.upsert') { await _waOnInbound(env, instance, data); await _waDetectSale(env, instance, data); }
  } catch (_) { /* nunca quebra o webhook */ }
  return json({ ok: true });
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
  // Estado REAL + número conectado direto da Evolution; grava no wa_conn (pra roleta usar também)
  try {
    const live = await _evoInstances(env);
    if (live && live.length) {
      for (const it of live) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_conn (instance, state, number, updated_at) VALUES (?, ?, ?, strftime('%s','now'))
             ON CONFLICT(instance) DO UPDATE SET state=excluded.state, number=excluded.number, updated_at=excluded.updated_at`
          ).bind(it.name, String(it.state), it.number || '').run();
        } catch (_) {}
      }
      return json({ ok: true, conn: live.map(it => ({ instance: it.name, state: it.state, number: it.number })) });
    }
  } catch (_) {}
  // fallback: Evolution não respondeu → usa o DB
  const rows = await env.DB.prepare('SELECT instance, state, number FROM wa_conn').all();
  return json({ ok: true, conn: rows.results || [] });
}

// ─── Sale Chat (soundboard) ──────────────────────────────────
// GET /api/salechat → config do Sale Chat (mensagens de texto + funis/sequencias)
// que o Diretor edita na dash (fica em DB.salechat, salvo pelo sync normal).
// Publico de proposito: sao roteiros de venda, nao dado sensivel; o injetor
// (Node) e a extensao puxam isso pra montar o painel dentro do WhatsApp.
async function handleSaleChatGet(req, env) {
  const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let state = {}; try { state = JSON.parse(row?.data || '{}'); } catch (_) {}
  const sc = state.salechat || {};
  return json({
    ok: true,
    messages: Array.isArray(sc.messages) ? sc.messages : [],
    sequences: Array.isArray(sc.sequences) ? sc.sequences : [],
    media: Array.isArray(sc.media) ? sc.media : [],
    triggers: Array.isArray(sc.triggers) ? sc.triggers : [],
    updated_at: sc.updated_at || 0,
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
  if (!text || text.indexOf('Pedido Conclu') < 0) return; // assinatura da venda
  const key = data?.key || {};
  const jid = String(key.remoteJid || '');
  if (!jid || jid.indexOf('@g.us') >= 0) return;   // ignora grupo (senão "Pedido Conclu" em grupo vira venda fantasma)
  const phone = String(key.remoteJidAlt || key.remoteJid || '').split('@')[0].replace(/\D/g, '');
  if (!phone) return;
  const name = ((text.match(/Nome:\s*([^\n📍📲⭐]+)/i) || [])[1] || '').trim();
  const valM = text.match(/Valor do Pedido:\s*R\$?\s*([\d.,]+)/i);
  const value = valM ? Number(valM[1].replace(/\./g, '').replace(',', '.')) : 0;
  const msgId = (key && key.id) || null;
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_sales (phone TEXT, instance TEXT, name TEXT, value REAL, ts INTEGER)').run();
    try{ await env.DB.prepare('ALTER TABLE wa_sales ADD COLUMN msg_id TEXT').run(); }catch(_){}
    try{ await env.DB.prepare('ALTER TABLE wa_sales ADD COLUMN raw TEXT').run(); }catch(_){}   // texto completo do "Pedido Concluído" (pra revisar na dash)
    try{ await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_sales_msgid ON wa_sales(msg_id)').run(); }catch(_){}
    const recent = await env.DB.prepare("SELECT ts FROM wa_sales WHERE phone=? AND ts > strftime('%s','now')-86400 LIMIT 1").bind(phone).first();
    if (recent) return; // já registrada nas últimas 24h (mesmo telefone)
    // idempotente por msg_id: reentrega do mesmo webhook não conta 2x nem dispara 2 CompletePayment
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO wa_sales (phone, instance, name, value, ts, msg_id, raw) VALUES (?,?,?,?,strftime('%s','now'),?,?)").bind(phone, instance, name, value, msgId, String(text||'').slice(0,2000)).run();
    if (ins.meta && ins.meta.changes === 0) return; // msg_id repetido → já processado
    await _ttFireSale(env, phone, (value > 0 ? value : null), msgId || '', instance);   // venda pro pixel (sem value 0 se o parse falhar)
  } catch (_) {}
}

// Envia um evento pro TikTok Events API (server-side). Telefone hasheado (advanced matching);
// inclui ttclid quando temos (atribuição precisa ao anúncio).
async function _ttSend(pixel, token, event, phoneDigits, opts) {
  opts = opts || {};
  if (!pixel || !token || !phoneDigits) return;
  try {
    const user = { phone: await sha256Hex('+' + phoneDigits) };
    if (opts.ttclid) user.ttclid = String(opts.ttclid);
    const ev = { event, event_time: Math.floor(Date.now() / 1000), event_id: String(opts.eventId || (event + '_' + phoneDigits)), user };
    if (opts.value != null) ev.properties = { currency: 'BRL', value: Number(opts.value) || 0, content_type: 'product' };
    const body = { event_source: 'web', event_source_id: pixel, data: [ev] };
    const r = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try { console.log('TTEV', event, r.status, (await r.text()).slice(0, 120)); } catch (_) {}
  } catch (_) {}
}
// Resolve pixel+token: 1) da pressel (pid) se tiver os dois; 2) da pressel do vendedor (ax_<at>); 3) global.
async function _ttPixelToken(env, pid, instance) {
  let pixel = '', token = '';
  try {
    const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
    const data = JSON.parse(row?.data || '{}');
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
// LEAD: na 1ª mensagem do número, casa com o clique pelo CÓDIGO no texto (atribuição EXATA).
// Quem manda sem código (lead antigo, indicação, orgânico) não veio de pressel → não conta. 1x por número.
async function _waLeadCapture(env, instance, phone, body) {
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_lead (phone TEXT PRIMARY KEY, pid TEXT, ttclid TEXT, ts INTEGER)').run();
    try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN inst TEXT').run(); }catch(_){}
    try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}   // origem da atribuição: 'code' (exato) | 'fifo' (clique recente no mesmo número)
    try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN num TEXT').run(); }catch(_){}   // número (do atendente) que recebeu o lead — pra dividir por número na visão de Leads
    const exists = await env.DB.prepare('SELECT phone FROM wa_lead WHERE phone=?').bind(phone).first();
    if (exists) return; // já contabilizado como lead
    // 1) casa pelo CÓDIGO da mensagem (ex: Código de desconto "k2EGu"!) — atribuição EXATA.
    let ttclid = '', pid = '', src = '';
    const codeM = String(body || '').match(/desconto[^A-Za-z0-9]{0,4}([A-Za-z0-9]{4,12})/i);
    const code = codeM ? codeM[1] : '';
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS tt_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, inst TEXT, ttclid TEXT, pid TEXT, ts INTEGER, claimed INTEGER DEFAULT 0)').run();
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN code TEXT').run(); }catch(_){}
    if (code) {
      try {
        const cl = await env.DB.prepare("UPDATE tt_pending SET claimed=1 WHERE id=(SELECT id FROM tt_pending WHERE code=? AND (claimed IS NULL OR claimed=0) ORDER BY ts DESC LIMIT 1) RETURNING ttclid, pid").bind(code).first();
        if (cl) { ttclid = cl.ttclid || ''; pid = cl.pid || ''; src = 'code'; }
      } catch (_) {}
    }
    // 2) FALLBACK (sem código): casa com o clique recente NÃO reivindicado no MESMO número (janela 60min, o mais antigo).
    // Recupera o lead que apagou o código. Vale porque esses números só recebem tráfego de pressel.
    if (!pid) {
      try {
        const fb = await env.DB.prepare("UPDATE tt_pending SET claimed=1 WHERE id=(SELECT id FROM tt_pending WHERE inst=? AND (claimed IS NULL OR claimed=0) AND ttclid IS NOT NULL AND ttclid<>'' AND ts > strftime('%s','now')-3600 ORDER BY ts ASC LIMIT 1) RETURNING ttclid, pid").bind(instance).first();
        if (fb) { ttclid = fb.ttclid || ''; pid = fb.pid || ''; src = 'fifo'; }
      } catch (_) {}
    }
    let num=''; try{ const cn=await env.DB.prepare('SELECT number FROM wa_conn WHERE instance=?').bind(instance).first(); num=(cn&&cn.number)||''; }catch(_){}   // número conectado que recebeu o lead
    await env.DB.prepare("INSERT OR IGNORE INTO wa_lead (phone, pid, ttclid, inst, src, num, ts) VALUES (?,?,?,?,?,?,strftime('%s','now'))").bind(phone, pid, ttclid, instance, src, num).run();
    // só dispara evento de LEAD pro pixel se o lead veio de PRESSEL (tem ttclid/pid); orgânico não suja o pixel
    if (ttclid || pid) {
      const { pixel, token } = await _ttPixelToken(env, pid, instance);
      await _ttSend(pixel, token, 'InitiateCheckout', phone, { ttclid, eventId: 'lead_' + phone });   // LEAD = InitiateCheckout (evento que o GT otimiza)
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
    const { pixel, token } = await _ttPixelToken(env, pid, instance);
    await _ttSend(pixel, token, 'CompletePayment', digits, { value, ttclid, eventId });
  } catch (_) {}
}
// GET /api/wa/sales → vendas detectadas no WhatsApp (a dash mostra/usa)
async function handleWASales(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_sales (phone TEXT, instance TEXT, name TEXT, value REAL, ts INTEGER)').run();
    try{ await env.DB.prepare('ALTER TABLE wa_sales ADD COLUMN raw TEXT').run(); }catch(_){}   // garante a coluna pro SELECT
    try{ await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_lead (phone TEXT PRIMARY KEY, pid TEXT, ttclid TEXT, ts INTEGER)').run(); }catch(_){}
    try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}   // garante l.src pro JOIN
    let day = new URL(req.url).searchParams.get('day') || '';
    let where = '', binds = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {   // filtro por dia (BRT)
      const start = Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), end = start + 86400;
      where = 'WHERE s.ts>=? AND s.ts<?'; binds = [start, end];
    }
    // LEFT JOIN wa_lead pra saber se a venda veio de pressel (pid) — mostra "da pressel" vs "sem rastreio" na tela
    const stmt = env.DB.prepare(`SELECT s.rowid AS id, s.phone, s.instance, s.name, s.value, s.ts, s.raw, l.pid AS pid, l.src AS src FROM wa_sales s LEFT JOIN wa_lead l ON l.phone=s.phone ${where} ORDER BY s.ts DESC LIMIT 300`);
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
// Instância OK pra rotear lead? Aberta E (número conectado desconhecido OU bate com o chip selecionado). FAIL-OPEN:
// se não sabe o número conectado, NÃO bloqueia (nunca deixa a pressel offline por falta de info).
function _servConnOk(liveSet, inst, chipNum){
  if(!liveSet) return true;
  if(!liveSet.has(inst)) return false;                 // instância não está 'open'
  const cn = liveSet.get ? liveSet.get(inst) : '';     // número conectado (liveSet é Map)
  if(!cn) return true;                                  // número conectado desconhecido → fail-open
  return _lastDigitsEq(cn, chipNum);                    // aberta E número conectado bate com o chip
}
// Resolve, por vendedor, o número PRINCIPAL (em uso, instância ax_<at>) e o BACKUP (chip bkp, instância ax_<at>_b).
// Os dois entram só se estiverem conectados AGORA (liveSet) COM O NÚMERO CERTO e não banidos/restritos.
function _resolvePresselSellers(p, chips, liveSet){
  const out=[];
  const okWa=(c)=>{ const wa=String((c&&c.wa_st)||'').toLowerCase(); return wa!=='restrito' && wa!=='banido'; };
  for(const v of (p.vendedores||[])){
    if(v.ativo===false) continue;
    const mine=chips.filter(c=>String(c.at)===String(v.at) && c.st!=='aquecimento' && c.st!=='banido');
    if(!mine.length) continue;
    const instP='ax_'+String(v.at), instB='ax_'+String(v.at)+'_b';
    const emChip=mine.find(c=>c.em_uso===true || c.wa_st==='em_uso') || mine[0];   // conectado em instP
    let bkChip=mine.find(c=>c.bkp===true);                                          // conectado em instB
    if(bkChip && emChip && (String(bkChip.id)===String(emChip.id) || _lastDigitsEq(bkChip.num, emChip.num))) bkChip=null;   // reserva NÃO pode ser o mesmo número do principal (o mesmo WhatsApp em 2 instâncias briga e cai)
    const swap=!!(v.swap && emChip && bkChip);                                      // v.swap troca só o PAPEL (número fica na sua conexão)
    const pChip=swap?bkChip:emChip, pInst=swap?instB:instP;                         // principal = recebe primeiro
    const rChip=swap?emChip:bkChip, rInst=swap?instP:instB;                         // reserva = overflow
    const primary=(pChip && okWa(pChip) && pChip.num && _servConnOk(liveSet, pInst, pChip.num)) ? {num:pChip.num, inst:pInst} : null;
    const backup =(v.reserva_on!==false && rChip && okWa(rChip) && rChip.num && _servConnOk(liveSet, rInst, rChip.num)) ? {num:rChip.num, inst:rInst} : null;   // reserva só entra com o interruptor ligado
    if(!primary && !backup) continue;
    out.push({at:String(v.at), cap:Math.max(0,Number(v.cap)||0), primary, backup});
  }
  return out;
}
// ROLETA com OVERFLOW POR COTA + balanceamento:
// 1) por vendedor, resolve o número EFETIVO: principal até bater a cota do dia (cap), depois vira pro backup;
//    se o principal caiu, usa o backup direto; se não tem backup, segue no principal.
// 2) entre vendedores, manda pro que tem MENOS leads hoje (principal+backup somados). Empate → rotaciona.
async function _presselBalancedPick(env, id, sellers){
  const counts={};
  try{
    const day=_brDay();
    const start=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), end=start+86400;
    const r=await env.DB.prepare(`SELECT instance, COUNT(*) c FROM (SELECT phone, instance, MIN(ts) mt FROM wa_messages WHERE direction='in' GROUP BY phone, instance) WHERE mt>=? AND mt<? GROUP BY instance`).bind(start,end).all();
    (r.results||[]).forEach(x=>{counts[x.instance]=Number(x.c)||0;});
  }catch(_){}
  const avail=[];
  for(const s of sellers){
    const cP=s.primary?(counts[s.primary.inst]||0):0;
    const cB=s.backup?(counts[s.backup.inst]||0):0;
    let eff=null;
    if(s.primary && (s.cap<=0 || cP<s.cap)) eff=s.primary;   // principal ainda dentro da cota do dia
    else if(s.backup) eff=s.backup;                           // estourou a cota (ou principal caiu) → backup
    else if(s.primary) eff=s.primary;                         // sem backup: segue no principal
    if(!eff) continue;
    avail.push({num:eff.num, at:s.at, inst:eff.inst, total:cP+cB});
  }
  if(!avail.length) return null;
  if(avail.length===1) return avail[0];
  let min=Infinity; avail.forEach(a=>{ if(a.total<min)min=a.total; });
  const tied=avail.filter(a=>a.total===min);
  if(tied.length===1) return tied[0];
  const idx=await _presselNextIndex(env, id, tied.length);   // desempate rotativo
  return tied[idx];
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
  try{
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_day (pid TEXT, day TEXT, views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, PRIMARY KEY(pid,day))').run();
    const pr = await env.DB.prepare('SELECT pid, views, clicks FROM pressel_day WHERE day=?').bind(day).all();
    (pr.results||[]).forEach(r=>{ m.vc[String(r.pid)]={views:Number(r.views)||0, clicks:Number(r.clicks)||0}; });
  }catch(_){}
  try{
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_lead (phone TEXT PRIMARY KEY, pid TEXT, ttclid TEXT, ts INTEGER)').run();
    try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN inst TEXT').run(); }catch(_){}
    const c = await env.DB.prepare("SELECT pid, COUNT(*) c FROM wa_lead WHERE ts>=? AND ts<? AND pid IS NOT NULL AND pid<>'' GROUP BY pid").bind(start,end).all();
    (c.results||[]).forEach(r=>{ m.contatos[String(r.pid)]=Number(r.c)||0; });
  }catch(_){}
  try{  // por vendedor dentro da pressel (precisa da coluna inst — best-effort)
    const c2 = await env.DB.prepare("SELECT pid, inst, COUNT(*) c FROM wa_lead WHERE ts>=? AND ts<? AND pid IS NOT NULL AND pid<>'' AND inst IS NOT NULL GROUP BY pid, inst").bind(start,end).all();
    (c2.results||[]).forEach(r=>{ const pid=String(r.pid); (m.contatosVI[pid]=m.contatosVI[pid]||{})[r.inst]=Number(r.c)||0; });
  }catch(_){}
  try{  // vendas do dia, atribuídas pela pressel de origem do lead
    const s = await env.DB.prepare("SELECT l.pid pid, s.instance inst, COUNT(*) v, COALESCE(SUM(s.value),0) val FROM wa_sales s JOIN wa_lead l ON l.phone=s.phone WHERE s.ts>=? AND s.ts<? AND l.pid IS NOT NULL AND l.pid<>'' GROUP BY l.pid, s.instance").bind(start,end).all();
    (s.results||[]).forEach(r=>{ const pid=String(r.pid); m.vendas[pid]=(m.vendas[pid]||0)+(Number(r.v)||0); m.valor[pid]=(m.valor[pid]||0)+(Number(r.val)||0); (m.vendasVI[pid]=m.vendasVI[pid]||{})[r.inst||'']=Number(r.v)||0; });
  }catch(_){}
  try{  // TODAS as vendas por vendedor (com OU sem código): toda venda fechada conta na métrica do vendedor
    const sa = await env.DB.prepare("SELECT s.instance inst, COUNT(*) v, COALESCE(SUM(s.value),0) val FROM wa_sales s WHERE s.ts>=? AND s.ts<? GROUP BY s.instance").bind(start,end).all();
    (sa.results||[]).forEach(r=>{ m.vendasInst[String(r.inst||'')]={ v:Number(r.v)||0, val:Number(r.val)||0 }; });
  }catch(_){}
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
  const today=_brDay(); if(day>today) day=today;   // seletor de data (não deixa o futuro)
  const isToday=(day===today);
  const M=await _presselDayMetrics(env, day);
  const vc=M.vc[String(id)]||{}, views=Number(vc.views)||0, clicks=Number(vc.clicks)||0;
  const contatos=M.contatos[String(id)]||0, vendas=M.vendas[String(id)]||0;
  const cvi=M.contatosVI[String(id)]||{}, vvi=M.vendasVI[String(id)]||{};
  let nameMap={};
  try{ const us=await env.DB.prepare('SELECT id, name FROM users').all(); (us.results||[]).forEach(u=>{nameMap[String(u.id)]=u.name;}); }catch(_){}
  const vend=(p.vendedores||[]).filter(v=>v.ativo!==false).map(v=>{
    const mine=chips.filter(c=>String(c.at)===String(v.at) && c.st!=='aquecimento' && c.st!=='banido');
    const active=mine.find(c=>c.em_uso===true||c.wa_st==='em_uso')||mine[0];
    const inst='ax_'+v.at, instB=inst+'_b';   // soma principal + backup no mesmo vendedor
    return {name:nameMap[String(v.at)]||'Vendedor', num:active?active.num:'—', contatos:(Number(cvi[inst])||0)+(Number(cvi[instB])||0), vendas:(Number(vvi[inst])||0)+(Number(vvi[instB])||0)};
  });
  const dBR=day.split('-'); const dLabel=dBR.length===3?(dBR[2]+'/'+dBR[1]):day;
  const card=(lbl,val,color)=>`<div style="flex:1;min-width:150px;background:#141c2b;border:1px solid #233047;border-radius:16px;padding:18px 20px"><div style="font-size:12px;color:#8b9bb4">${lbl}</div><div style="font-size:30px;font-weight:800;color:${color};margin-top:4px">${val}</div></div>`;
  const rows=vend.length?vend.map(v=>{const conv=v.contatos>0?Math.round((v.vendas/v.contatos)*100)+'%':'—';return `<tr style="border-top:1px solid #233047"><td style="padding:13px 10px"><div style="font-weight:600;font-size:14px">${_escHtml(v.name)}</div><div style="font-size:12px;color:#8b9bb4;font-family:ui-monospace,monospace">${_escHtml(v.num)}</div></td><td style="text-align:center;color:#34d399">${v.contatos}</td><td style="text-align:center">${v.vendas||'—'}</td><td style="text-align:center;color:#7aa2ff">${conv}</td></tr>`;}).join(''):`<tr><td colspan="4" style="padding:16px;text-align:center;color:#8b9bb4">Nenhum vendedor nessa pressel.</td></tr>`;
  return _presselHtml(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${isToday?'<meta http-equiv="refresh" content="30">':''}<title>Métricas — ${_escHtml(p.nome||'')}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1220;color:#e6edf6;font-family:system-ui,-apple-system,Arial,sans-serif;padding:24px}.wrap{max-width:880px;margin:0 auto}h1{font-size:20px;margin-bottom:4px}table{width:100%;border-collapse:collapse;font-size:13px;margin-top:18px}th{color:#8b9bb4;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:6px 10px}</style></head><body><div class="wrap"><h1>Métricas — ${_escHtml(p.nome||'')}</h1><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:18px"><input type="date" value="${day}" max="${today}" onchange="if(this.value)location.href='?day='+this.value" style="background:#141c2b;border:1px solid #233047;color:#e6edf6;border-radius:8px;padding:5px 9px;font-size:12.5px;font-family:inherit;color-scheme:dark;cursor:pointer">${isToday?'<span style="color:#6b7a93;font-size:12px">atualiza sozinho a cada 30s</span>':'<a href="?" style="color:#7aa2ff;font-size:12.5px;text-decoration:none">← voltar pra hoje</a>'}</div><div style="display:flex;gap:12px;flex-wrap:wrap">${card('Chegaram na pressel',views,'#7aa2ff')}${card('Foram pro WhatsApp',clicks,'#34d399')}${card('Iniciaram contato',contatos,'#34d399')}${card('Vendas',vendas,'#34d399')}</div><table><thead><tr><th style="text-align:left">Vendedor</th><th>Iniciaram</th><th>Vendas</th><th>Conversão</th></tr></thead><tbody>${rows}</tbody></table><p style="color:#6b7a93;font-size:11.5px;margin-top:16px;line-height:1.5">Todos os números são reais e do dia selecionado. Chegaram e Foram pro WhatsApp contam só tráfego do TikTok (ttclid). Iniciaram contato e Vendas vêm do WhatsApp (Evolution).</p></div></body></html>`);
}
const PRESSEL_DOMS = ['area-acesso.com', 'area-glico.fun', 'painel-glico.fun'];
function _presselDom(p){ return (p && p.dominio && PRESSEL_DOMS.includes(p.dominio)) ? p.dominio : 'painel-glico.fun'; }
// GET /pressels-total — página PÚBLICA consolidada: TOTAL somando todas + cada pressel numa seção.
// Pega TODAS as pressels do estado automaticamente (pressel nova entra sozinha).
async function handlePresselsTotalPage(req, env){
  const row=await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let data={}; try{ data=JSON.parse(row?.data||'{}'); }catch(_){}
  const pressels=Array.isArray(data.pressels)?data.pressels:[];
  const chips=Array.isArray(data.chips)?data.chips:[];
  let day=new URL(req.url).searchParams.get('day')||'';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) day=_brDay();
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
  const M=await _presselDayMetrics(env, day);
  let nameMap={};
  try{ const us=await env.DB.prepare('SELECT id, name FROM users').all(); (us.results||[]).forEach(u=>{nameMap[String(u.id)]=u.name;}); }catch(_){}
  const secs=pressels.map(p=>{
    const pid=String(p.id), vc=M.vc[pid]||{}, cvi=M.contatosVI[pid]||{}, vvi=M.vendasVI[pid]||{};
    const vend=(p.vendedores||[]).filter(v=>v.ativo!==false).map(v=>{
      const mine=chips.filter(c=>String(c.at)===String(v.at) && c.st!=='aquecimento' && c.st!=='banido');
      const active=mine.find(c=>c.em_uso===true||c.wa_st==='em_uso')||mine[0];
      const inst='ax_'+v.at;
      return {name:nameMap[String(v.at)]||'Vendedor', num:active?active.num:'—', contatos:Number(cvi[inst])||0, vendas:Number(vvi[inst])||0};
    });
    return {nome:p.nome||('Pressel '+p.id), url:'https://'+_presselDom(p)+'/p/'+p.id, views:Number(vc.views)||0, clicks:Number(vc.clicks)||0, contatos:M.contatos[pid]||0, vendas:M.vendas[pid]||0, vend};
  });
  const tot=secs.reduce((a,s)=>({views:a.views+s.views, clicks:a.clicks+s.clicks, contatos:a.contatos+s.contatos, vendas:a.vendas+s.vendas}), {views:0,clicks:0,contatos:0,vendas:0});
  tot.vendas=Object.values(M.vendasInst||{}).reduce((a,x)=>a+(Number(x.v)||0),0);   // TOTAL conta TODAS as vendas fechadas (com ou sem código)
  const dBR=day.split('-'); const dLabel=dBR.length===3?(dBR[2]+'/'+dBR[1]):day;
  const card=(lbl,val,color)=>`<div style="flex:1;min-width:130px;background:#141c2b;border:1px solid #233047;border-radius:14px;padding:14px 16px"><div style="font-size:11px;color:#8b9bb4">${lbl}</div><div style="font-size:26px;font-weight:800;color:${color};margin-top:3px">${val}</div></div>`;
  const cardsHtml=(m)=>`<div style="display:flex;gap:10px;flex-wrap:wrap">${card('Chegaram na pressel',m.views,'#7aa2ff')}${card('Foram pro WhatsApp',m.clicks,'#34d399')}${card('Iniciaram contato',m.contatos,'#34d399')}${card('Vendas',m.vendas,'#34d399')}</div>`;
  const vendTable=(vend)=>{
    const rows=vend.length?vend.map(v=>{const conv=v.contatos>0?Math.round((v.vendas/v.contatos)*100)+'%':'—';return `<tr style="border-top:1px solid #233047"><td style="padding:10px 8px"><div style="font-weight:600;font-size:13px">${_escHtml(v.name)}</div><div style="font-size:11.5px;color:#8b9bb4;font-family:ui-monospace,monospace">${_escHtml(v.num)}</div></td><td style="text-align:center;padding:10px 12px;color:#34d399">${v.contatos}</td><td style="text-align:center;padding:10px 12px">${v.vendas||'—'}</td><td style="text-align:center;padding:10px 12px;color:#7aa2ff">${conv}</td></tr>`;}).join(''):`<tr><td colspan="4" style="padding:12px;text-align:center;color:#8b9bb4;font-size:12px">Sem vendedores.</td></tr>`;
    return `<table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-top:12px"><thead><tr><th style="text-align:left;color:#8b9bb4;font-size:11px;padding:5px 8px">Vendedor</th><th style="color:#8b9bb4;font-size:11px;padding:6px 12px;text-align:center">Iniciaram</th><th style="color:#8b9bb4;font-size:11px;padding:6px 12px;text-align:center">Vendas</th><th style="color:#8b9bb4;font-size:11px;padding:6px 12px;text-align:center">Conversão</th></tr></thead><tbody>${rows}</tbody></table>`;
  };
  // vendedores ativos (únicos), somando contatos/vendas de TODAS as pressels
  const _vt={};
  pressels.forEach(p=>(p.vendedores||[]).filter(v=>v.ativo!==false).forEach(v=>{ const at=String(v.at); if(!_vt[at]){ const mine=chips.filter(c=>String(c.at)===at && c.st!=='aquecimento' && c.st!=='banido'); const active=mine.find(c=>c.em_uso===true||c.wa_st==='em_uso')||mine[0]; _vt[at]={name:nameMap[at]||'Vendedor', num:active?active.num:'—', contatos:0, vendas:0}; } }));
  Object.keys(M.contatosVI||{}).forEach(pid=>Object.keys(M.contatosVI[pid]).forEach(inst=>{ const at=String(inst).replace(/^ax_/,'').replace(/_b$/,''); if(_vt[at]) _vt[at].contatos+=Number(M.contatosVI[pid][inst])||0; }));   // backup (_b) soma no vendedor
  Object.keys(M.vendasInst||{}).forEach(inst=>{ const at=String(inst).replace(/^ax_/,'').replace(/_b$/,''); if(_vt[at]) _vt[at].vendas+=Number((M.vendasInst[inst]||{}).v)||0; });   // TODAS as vendas do vendedor (com ou sem código)
  const totVend=Object.values(_vt);
  const totalSec=`<div style="background:#101d2e;border:1px solid #2b6cb0;border-radius:16px;padding:20px;margin-bottom:24px"><div style="font-size:16px;font-weight:800;margin-bottom:12px;color:#7aa2ff">TOTAL · todas as pressels</div>${cardsHtml(tot)}${vendTable(totVend)}</div>`;
  const presselSecs=secs.length?secs.map(s=>`<div style="border:1px solid #233047;border-radius:16px;padding:18px;margin-bottom:16px"><div style="font-size:15px;font-weight:700">${_escHtml(s.nome)}</div><div style="font-size:11.5px;color:#6b7a93;font-family:ui-monospace,monospace;margin:2px 0 12px">${_escHtml(s.url)}</div>${cardsHtml(s)}${vendTable(s.vend)}</div>`).join(''):`<div style="color:#8b9bb4;text-align:center;padding:30px">Nenhuma pressel criada ainda.</div>`;
  const dayQ=isToday?'':('day='+day);
  const _seg=(lbl,v)=>{ const active=view===v; const qs=[v!=='metricas'?('view='+v):'',dayQ,kq].filter(Boolean).join('&'); return `<a href="?${qs}" style="padding:7px 12px;font-size:12.5px;font-weight:700;text-decoration:none;border-radius:8px;${active?'background:#2b6cb0;color:#fff':'color:#7aa2ff'}">${lbl}</a>`; };
  const toggleBtn=`<div style="margin-left:auto;display:inline-flex;gap:2px;background:#141c2b;border:1px solid #2b6cb0;border-radius:10px;padding:3px">${_seg('Métricas','metricas')}${_seg('Pedidos','vendas')}${_seg('Leads','leads')}</div>`;
  let ordersHtml='';
  if(view==='vendas'){
    let orders=[];
    try{
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}   // garante l.src pro JOIN
      const dstart=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), dend=dstart+86400;
      const r=await env.DB.prepare("SELECT s.name, s.instance, s.value, s.ts, l.pid pid, l.src src FROM wa_sales s LEFT JOIN wa_lead l ON l.phone=s.phone WHERE s.ts>=? AND s.ts<? ORDER BY s.ts DESC LIMIT 300").bind(dstart,dend).all();
      orders=r.results||[];
    }catch(_){}
    const _pnm={}; pressels.forEach(pp=>{ _pnm[String(pp.id)]=pp.nome||('Pressel '+pp.id); });   // pid -> nome da pressel
    const pad=n=>String(n).padStart(2,'0');
    const totV=orders.reduce((a,o)=>a+(Number(o.value)||0),0);
    const nP=orders.filter(o=>o.pid&&String(o.pid).trim()!=='').length, nS=orders.length-nP;
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
      return `<div style="border:1px solid #233047;border-radius:14px;background:#141c2b;padding:14px 16px;margin-bottom:9px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:0"><div style="font-size:14.5px;font-weight:700">${_escHtml(o.name||'Cliente')}${val>0?` · <span style="color:#34d399">R$ ${val}</span>`:''}</div><div style="font-size:12px;color:#8b9bb4;margin-top:3px">Vendedor: ${_escHtml(seller)} · ${hora}</div></div>${tag}</div></div>`;
    }).join(''):`<div style="color:#8b9bb4;text-align:center;padding:40px">Nenhum pedido confirmado nesse dia.</div>`;
    ordersHtml=`<div style="font-size:13px;color:#8b9bb4;margin-bottom:14px"><b style="color:#e6edf6">${orders.length}</b> pedido(s)${totV>0?` · total <b style="color:#34d399">R$ ${totV}</b>`:''}${nS>0?` · <b style="color:#34d399">${nP}</b> das pressels · <b style="color:#e6edf6">${nS}</b> sem rastreio`:''}</div>${oCards}`;
  }
  let leadsHtml='';
  if(view==='leads'){
    let leads=[];
    let saleSet=new Set();
    try{
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN num TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}
      const dstart=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), dend=dstart+86400;
      const r=await env.DB.prepare("SELECT phone, inst, num, pid, src, ts FROM wa_lead WHERE ts>=? AND ts<? ORDER BY ts ASC").bind(dstart,dend).all();
      leads=r.results||[];
      // telefones que VIRARAM venda (do dia em diante) → pra pintar o número de verde
      try{ const sr=await env.DB.prepare("SELECT DISTINCT phone FROM wa_sales WHERE ts>=?").bind(dstart).all(); (sr.results||[]).forEach(x=>{ const p=String(x.phone||'').replace(/\D/g,''); if(p) saleSet.add(p); }); }catch(_){}
    }catch(_){}
    const _pnm={}; pressels.forEach(pp=>{ _pnm[String(pp.id)]=pp.nome||('Pressel '+pp.id); });
    const pad=n=>String(n).padStart(2,'0');
    const fmtNum=n=>{ n=String(n||'').replace(/\D/g,''); if(!n) return 'número não registrado'; return n.startsWith('55')?n.slice(2):n; };
    const isSale=ph=>!!(ph&&saleSet.has(ph));
    const waHref=ph=>{ let d=String(ph||'').replace(/\D/g,''); if(!d) return ''; if(d.length<=11) d='55'+d; return 'https://wa.me/'+d; };   // link direto pra conversa
    const byAt={};
    leads.forEach(l=>{ const at=String(l.inst||'').replace(/^ax_/,'').replace(/_b$/,'')||'?'; (byAt[at]=byAt[at]||[]).push(l); });
    const ats=Object.keys(byAt).sort((a,b)=>String(nameMap[a]||a).localeCompare(String(nameMap[b]||b)));
    const cpBlocks=[];   // texto de cópia por vendedor (só no modo autenticado)
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
          const tag=attr?`<span style="font-size:9.5px;font-weight:700;color:#34d399">${_escHtml(_pnm[String(l.pid)]||'pressel')}${l.src==='fifo'?' ~':''}</span>`:`<span style="font-size:9.5px;color:#6b7a93">sem rastreio</span>`;
          const ph=String(l.phone||'').replace(/\D/g,'');
          const sale=isSale(ph);
          if(full && ph){ cpLines.push(fmtNum(ph)+'  '+hora+'  '+pnome+(sale?'  VENDA':'')+'  '+waHref(ph)); }
          const numCol=sale?'#34d399':(full?'#e2e8f0':'#cbd5e1');   // verde = virou venda
          const numCell=(full&&ph)
            ? `<a href="${waHref(ph)}" target="_blank" rel="noopener" title="Abrir conversa no WhatsApp" style="flex:1;color:${numCol};font-weight:${sale?'700':'600'};font-family:ui-monospace,monospace;text-decoration:none;cursor:pointer">${_escHtml(fmtNum(ph))}</a>`
            : `<span style="flex:1;color:${numCol};font-weight:${sale?'700':'400'};font-family:ui-monospace,monospace">${ph?('…'+ph.slice(-4)):''}</span>`;
          return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid #1a2436;font-size:11.5px"><span style="color:#8b9bb4;font-variant-numeric:tabular-nums">${hora}</span>${numCell}${tag}</div>`;
        }).join('');
        return `<div style="margin-top:11px"><div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#7aa2ff;font-weight:700"><span style="font-family:ui-monospace,monospace">${_escHtml(fmtNum(k))}</span><span style="background:#1a2942;padding:1px 8px;border-radius:9px">${ls.length}</span></div>${rows}</div>`;
      }).join('');
      let cpBtn='';
      if(full){ const idx=cpBlocks.length; cpBlocks.push(cpLines.join('\n')); cpBtn=`<button onclick="cpSeller(${idx},this)" style="font-size:10.5px;font-weight:700;color:#7aa2ff;background:#15233a;border:1px solid #2b6cb0;border-radius:8px;padding:4px 10px;cursor:pointer">Copiar leads</button>`; }
      return `<div style="flex:1;min-width:230px;max-width:340px;background:#141c2b;border:1px solid #233047;border-radius:14px;padding:14px 16px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="font-size:14px;font-weight:800">${_escHtml(name)}</div>${cpBtn}</div><div style="font-size:11.5px;color:#8b9bb4;margin-top:2px"><b style="color:#e6edf6">${arr.length}</b> leads · <b style="color:#34d399">${daP}</b> da pressel</div>${numSecs}</div>`;
    }).join(''):`<div style="color:#8b9bb4;text-align:center;padding:40px">Nenhum lead nesse dia.</div>`;
    const totL=leads.length, totP=leads.filter(l=>l.pid&&String(l.pid).trim()!=='').length;
    const cpData=full?`<script>var _CP=${JSON.stringify(cpBlocks).replace(/</g,'\\u003c')};function cpSeller(i,b){try{navigator.clipboard.writeText(_CP[i]||'');var o=b.textContent;b.textContent='Copiado!';setTimeout(function(){b.textContent=o},1400);}catch(e){}}</script>`:'';
    const hint=full?' · <span style="color:#34d399">verde = virou venda</span> · toque no número pra abrir a conversa':'';
    leadsHtml=`<div style="font-size:13px;color:#8b9bb4;margin-bottom:14px"><b style="color:#e6edf6">${totL}</b> leads novos${totP<totL?` · <b style="color:#34d399">${totP}</b> da pressel · ${totL-totP} sem rastreio`:''}${hint}</div><div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">${cols}</div>${cpData}`;
  }
  return _presselHtml(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${isToday?'<meta http-equiv="refresh" content="30">':''}<title>Métricas — Todas as Pressels</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1220;color:#e6edf6;font-family:system-ui,-apple-system,Arial,sans-serif;padding:24px}.wrap{max-width:920px;margin:0 auto}h1{font-size:22px;margin-bottom:4px}table{width:100%;border-collapse:collapse}th{font-weight:600}</style></head><body><div class="wrap"><h1>Métricas — Todas as Pressels</h1><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:20px"><input type="date" value="${day}" max="${today}" onchange="if(this.value)location.href='?day='+this.value+'${view!=='metricas'?('&view='+view):''}${kq?('&'+kq):''}'" style="background:#141c2b;border:1px solid #233047;color:#e6edf6;border-radius:8px;padding:5px 9px;font-size:12.5px;font-family:inherit;color-scheme:dark;cursor:pointer">${isToday?'<span style="color:#6b7a93;font-size:12px">atualiza sozinho a cada 30s</span>':`<a href="?${[view!=='metricas'?('view='+view):'',kq].filter(Boolean).join('&')}" style="color:#7aa2ff;font-size:12.5px;text-decoration:none">← voltar pra hoje</a>`}${toggleBtn}</div>${view==='vendas'?ordersHtml:(view==='leads'?leadsHtml:(totalSec+presselSecs))}<p style="color:#6b7a93;font-size:11.5px;margin-top:16px;line-height:1.5">${view==='vendas'?'Pedidos confirmados ("Pedido Concluído") do dia. A etiqueta verde mostra de qual pressel o pedido veio; "(aprox)" = casado pelo clique recente no número (o lead apagou o código). "sem rastreio" = não deu pra atribuir a nenhuma pressel.':view==='leads'?'Leads NOVOS do dia (1º contato de cada número — lead antigo que remanda NÃO conta de novo), separados por atendente e pelo número que recebeu. A divisória por número separa, por ex., o número da manhã do que entrou depois. Verde = veio da pressel · "~" = casado por tempo (código apagado).':'Números reais do dia selecionado. Chegaram e Foram pro WhatsApp contam só tráfego do TikTok (ttclid). Iniciaram contato e Vendas vêm do WhatsApp.'}</p></div></body></html>`);
}
async function handlePresselPublic(req, env, id){
  const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let data={}; try{ data=JSON.parse(row?.data||'{}'); }catch(_){}
  const pressels=Array.isArray(data.pressels)?data.pressels:[];
  const chips=Array.isArray(data.chips)?data.chips:[];
  const p=pressels.find(x=>String(x.id)===String(id));
  if(!p || (p.status && p.status!=='ativa')) return _presselOffline();
  // só roteia lead pra número com WhatsApp conectado AGORA (pula número caído automaticamente)
  let liveSet=null;
  try{ const cs=await env.DB.prepare("SELECT instance, number FROM wa_conn WHERE state='open'").all(); liveSet=new Map((cs.results||[]).map(r=>[r.instance, r.number||''])); }catch(_){}   // Map: instância → número conectado (pra roteador conferir o número certo)
  const sellers=_resolvePresselSellers(p, chips, liveSet);
  if(!sellers.length) return _presselOffline();
  const pick=await _presselBalancedPick(env, id, sellers);   // número efetivo (overflow por cota) do vendedor mais "atrás" hoje
  if(!pick) return _presselOffline();
  try{  // conta TODO acesso à pressel (diagnóstico: tráfego real vs rastreado)
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_hits (pid TEXT, day TEXT, hits INTEGER DEFAULT 0, PRIMARY KEY(pid,day))').run();
    await env.DB.prepare('INSERT INTO pressel_hits (pid, day, hits) VALUES (?, ?, 1) ON CONFLICT(pid,day) DO UPDATE SET hits = hits + 1').bind(String(id), _brDay()).run();
  }catch(_){}
  const ttclid = new URL(req.url).searchParams.get('ttclid') || '';   // click id do anúncio do TikTok
  let leadCode = '';
  if(ttclid){
    try{  // gera/reusa um CÓDIGO por clique (vai no texto do WhatsApp p/ atribuição EXATA); dedup por ttclid
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS tt_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, inst TEXT, ttclid TEXT, pid TEXT, ts INTEGER, claimed INTEGER DEFAULT 0)').run();
      try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN code TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN clicked INTEGER DEFAULT 0').run(); }catch(_){}   // pra deduplicar "Foram pro WhatsApp" por ttclid
      const ex = await env.DB.prepare('SELECT code FROM tt_pending WHERE ttclid=? LIMIT 1').bind(ttclid).first();
      if(ex){ leadCode = ex.code || ''; }
      else {
        leadCode = _genCode(6);
        await env.DB.prepare("INSERT INTO tt_pending (inst, ttclid, pid, ts, claimed, code) VALUES (?,?,?,strftime('%s','now'),0,?)").bind(pick.inst, ttclid, String(id), leadCode).run();
        try{ await _bumpPressel(env, id, 'views'); }catch(_){}   // conta SÓ tráfego real do TikTok, 1x por clique
      }
    }catch(_){}
  }
  // mensagem do WhatsApp com o código do clique (só quando veio de anúncio) — pra atribuição exata pelo código
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
    try {
      const live = await _evoInstances(env);
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
      if (req.method === 'GET'    && path === '/api/wa/chats')            return handleWAChats(req, env);
      if (req.method === 'GET'    && path === '/api/wa/messages')         return handleWAMessages(req, env);
      if (req.method === 'POST'   && path === '/api/wa/chat/read')        return handleWAChatRead(req, env);
      if (req.method === 'POST'   && path === '/api/wa/chat/assign')      return handleWAChatAssign(req, env);
      if (req.method === 'GET'    && path === '/api/wa/sales')            return handleWASales(req, env);
      if (req.method === 'POST'   && path === '/api/wa/sale/delete')      return handleWASaleDelete(req, env);
      if (req.method === 'POST'   && path === '/api/wa/bot/preview')      return handleBotPreview(req, env);

      // Webhook de volta da Evolution (mensagens recebidas + conexão)
      const evoMatch = path.match(/^\/webhook\/evolution\/([a-zA-Z0-9_-]+)$/);
      if (evoMatch && (req.method === 'POST' || req.method === 'GET')) {
        if (req.method === 'GET') return json({ name: 'axion-evolution-webhook', ok: true, ready: true });
        return handleEvolutionWebhook(req, env, evoMatch[1]);
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
