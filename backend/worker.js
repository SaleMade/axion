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
    // Se ação for 'pagar' e ainda não houver venda correspondente, registra
    // Idempotência DUPLA: por leadId E por external_order_id (evita duplicar
    // quando PAYT envia o mesmo postback 2x ou quando o mesmo cliente/CPF
    // fez 2 pedidos diferentes que caem no mesmo lead)
    if (mapping?.action === 'pagar') {
      state.vendas = state.vendas || [];
      const orderKey = data.order_id || '';
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
          external_order_id: orderKey, // pra idempotência em chamadas futuras
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
    event_raw: data.event_raw,
    event_mapped: data.event,
    status: data.status,
    modality: data.modality,
    action: action_taken,
    lead_id: lead_id_result,
    mapping_found: !!mapping,
  });
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

  // ── Persiste ──
  const newVer = curVer + 1;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, version = excluded.version,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(JSON.stringify(state), newVer, now, 'fornecedor-webhook').run();

  return json({
    ok: true,
    event_raw: eventRaw,
    event_mapped: event,
    status: status,
    action: action_taken,
    lead_id: lead_id_result,
  });
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
  return json({ ok: true, instance: name, removed: true });
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
// Resolve os números da roleta a partir do estado salvo (chips + vendedores)
function _resolvePresselNumbers(p, chips){
  const out=[];
  for(const v of (p.vendedores||[])){
    if(v.ativo===false) continue;
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
function _ttPixel(p){
  if(!p.pixel_tt) return '';
  const id=JSON.stringify(String(p.pixel_tt));
  return `<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=d.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load(${id});ttq.page();}(window,document,'ttq');</script>`;
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
  if(e.type==='botao') return `<div style="padding:14px"><a href="${_escHtml(wa)}" onclick="track()" style="display:flex;align-items:center;justify-content:center;gap:10px;background:${_escHtml(e.bg||'#22c55e')};color:${_escHtml(e.color||'#fff')};border-radius:14px;padding:16px 18px;font-weight:800;font-size:19px;text-transform:uppercase;letter-spacing:.3px;text-decoration:none;box-shadow:0 4px 0 rgba(0,0,0,.18),0 7px 14px rgba(0,0,0,.13)"><svg viewBox="0 0 32 32" width="24" height="24" style="flex-shrink:0" fill="currentColor"><path d="M16.04 4C9.4 4 4 9.4 4 16.04c0 2.12.55 4.18 1.6 6L4 28l6.13-1.6a12 12 0 0 0 5.9 1.5c6.63 0 12.03-5.4 12.03-12.04C28.06 9.4 22.67 4 16.04 4Zm0 21.9a9.9 9.9 0 0 1-5.06-1.38l-.36-.22-3.64.96.97-3.55-.24-.37a9.86 9.86 0 1 1 8.33 4.56Zm5.43-7.42c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.49 0 1.47 1.08 2.89 1.23 3.09.15.2 2.12 3.24 5.13 4.54.72.31 1.27.5 1.71.64.72.23 1.37.2 1.89.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.12-.27-.19-.57-.34Z"/></svg><span>${_escHtml(e.label||'FALAR NO WHATSAPP')}</span></a></div>`;
  if(e.type==='html') return e.html||'';
  return '';
}
// Round-robin de verdade (distribuição IGUAL): contador por pressel numa
// tabela própria, sem mexer no dashboard_state (evita conflito de sync).
async function _presselNextIndex(env, id, len){
  if(len<=1) return 0;
  try{
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_rr (pid TEXT PRIMARY KEY, n INTEGER)').run();
    const row=await env.DB.prepare('SELECT n FROM pressel_rr WHERE pid=?').bind(String(id)).first();
    const n=row?(Number(row.n)||0):0;
    await env.DB.prepare('INSERT INTO pressel_rr (pid,n) VALUES (?,?) ON CONFLICT(pid) DO UPDATE SET n=?')
      .bind(String(id), n+1, n+1).run();
    return n%len;
  }catch(_){ return Math.floor(Math.random()*len); }
}
async function handlePresselPublic(req, env, id){
  const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let data={}; try{ data=JSON.parse(row?.data||'{}'); }catch(_){}
  const pressels=Array.isArray(data.pressels)?data.pressels:[];
  const chips=Array.isArray(data.chips)?data.chips:[];
  const p=pressels.find(x=>String(x.id)===String(id));
  if(!p || (p.status && p.status!=='ativa')) return _presselOffline();
  const nums=_resolvePresselNumbers(p, chips);
  if(!nums.length) return _presselOffline();
  const pick=nums[await _presselNextIndex(env, id, nums.length)];
  const wa=_waLink(pick, p.msg);
  if(!wa) return _presselOffline();
  const bg=_escHtml(p.bg||'#ffffff');
  const secs=Math.max(0, Number(p.redirect)||0);
  const waJson=JSON.stringify(wa);
  const head=`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_escHtml(p.nome||'')}</title>${_ttPixel(p)}<style>*{margin:0;padding:0;box-sizing:border-box}body{background:${bg};font-family:system-ui,-apple-system,Arial,sans-serif;min-height:100vh}.wrap{max-width:480px;margin:0 auto}img{width:100%;display:block}</style></head>`;
  const script=`<script>function track(){try{ttq&&ttq.track('ClickButton')}catch(e){}}function go(){track();location.href=${waJson}}${secs>0?`setTimeout(go,${secs*1000});`:''}</script>`;
  const els=_presselElsServer(p);
  let body=els.map(e=>_elPublicHtml(e, wa)).join('');
  if(p.fullclick){
    return _presselHtml(`${head}<body onclick="go()" style="cursor:pointer"><div class="wrap">${body}</div>${script}</body></html>`);
  }
  // Garante um botão de WhatsApp se o usuário não adicionou nenhum
  if(!els.some(e=>e.type==='botao')){
    body+=`<div style="padding:14px"><a href="${_escHtml(wa)}" onclick="track()" style="display:flex;align-items:center;justify-content:center;gap:10px;background:#22c55e;color:#fff;border-radius:14px;padding:16px 18px;font-weight:800;font-size:19px;text-transform:uppercase;letter-spacing:.3px;text-decoration:none;box-shadow:0 4px 0 rgba(0,0,0,.18),0 7px 14px rgba(0,0,0,.13)"><svg viewBox="0 0 32 32" width="24" height="24" style="flex-shrink:0" fill="currentColor"><path d="M16.04 4C9.4 4 4 9.4 4 16.04c0 2.12.55 4.18 1.6 6L4 28l6.13-1.6a12 12 0 0 0 5.9 1.5c6.63 0 12.03-5.4 12.03-12.04C28.06 9.4 22.67 4 16.04 4Zm0 21.9a9.9 9.9 0 0 1-5.06-1.38l-.36-.22-3.64.96.97-3.55-.24-.37a9.86 9.86 0 1 1 8.33 4.56Zm5.43-7.42c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.49 0 1.47 1.08 2.89 1.23 3.09.15.2 2.12 3.24 5.13 4.54.72.31 1.27.5 1.71.64.72.23 1.37.2 1.89.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.12-.27-.19-.57-.34Z"/></svg><span>FALAR NO WHATSAPP</span></a></div>`;
  }
  return _presselHtml(`${head}<body><div class="wrap">${body}</div>${script}</body></html>`);
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
      if (req.method === 'POST'   && path === '/api/wa/send')   return handleWASend(req, env);
      // WhatsApp multi-instância (1 conexão por atendente)
      if (req.method === 'GET'    && path === '/api/wa/instances')        return handleWAInstances(req, env);
      if (req.method === 'POST'   && path === '/api/wa/instance/create')  return handleWAInstanceCreate(req, env);
      if (req.method === 'GET'    && path === '/api/wa/instance/connect') return handleWAInstanceConnect(req, env);
      if (req.method === 'GET'    && path === '/api/wa/instance/status')  return handleWAInstanceStatus(req, env);
      if (req.method === 'POST'   && path === '/api/wa/instance/logout')  return handleWAInstanceLogout(req, env);
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
      const presselMatch = path.match(/^\/p\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && presselMatch) return handlePresselPublic(req, env, presselMatch[1]);

      return err('Rota não encontrada', 404);
    } catch (e) {
      console.error('worker error', e?.stack || e);
      return err('Erro interno: ' + (e?.message || 'desconhecido'), 500);
    }
  },
};
