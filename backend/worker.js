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
const GUARDED_COLLECTIONS = ['leads','vendas','clientes','chips','invest','gastos','entradas','aportes','payouts','produtos','pressels','saques'];

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
// CARGO AFILIADO (23/08/2026). Gente de FORA que vende pra gente e ganha uma dash propria: o
// afiliado ve os pedidos DELE, a equipe DELE e a comissao DELE, e mais nada da nossa operacao.
// Nunca entra em ROLE_DIRETOR: aquela lista governa financeiro da empresa, folha e permissoes.
// `u.afiliado_id` e o que amarra a pessoa ao afiliado. Vale pro proprio afiliado E pra equipe dele
// (o vendedor de um afiliado tem o afiliado_id do dono), e e assim que o escopo desce em cascata.
const isAfiliado = (u) => String((u && u.role) || '').toLowerCase() === 'afiliado';
const aflDe = (u) => (u && u.afiliado_id) ? String(u.afiliado_id) : null;
// Alguem preso ao mundo de um afiliado: o afiliado ou alguem da equipe dele.
const noMundoAfiliado = (u) => !isDirector(u) && !!aflDe(u);
// FALHA FECHADA (24/08/2026). O Bruno cadastrou um afiliado pela tela "Novo usuario" (Lista de
// Usuarios) em vez da area de Afiliados. Aquela tela cria o USUARIO mas nao cria o afiliado nem
// preenche afiliado_id - entao `noMundoAfiliado` dava false e ele caia na regra do vendedor comum:
// recebia os 48 leads da operacao INTEIRA, com nome, CPF, telefone e endereco de cada cliente.
// Conferido ao vivo antes de corrigir.
// Regra nova: cargo afiliado SEM vinculo nao ve nada. Um afiliado sem afiliado_id e um cadastro
// pela metade, e a metade que falta e justamente a que diz o que e dele. Na duvida, nada.
const afiliadoSemVinculo = (u) => isAfiliado(u) && !aflDe(u);

// Chave única configurada no postback da PAYT — acesso ao webhook
// Pra trocar: editar aqui ou configurar como secret via `wrangler secret put PAYT_TOKEN`
const PAYT_TOKEN_DEFAULT = 'b562d560380649cbc6c8ade3550eb7f8';

// Segredo do webhook da FIVE (mesmo esquema do PAYT_TOKEN). Trocar via `wrangler secret put FIVE_TOKEN`.
// A URL cadastrada na Five deve virar:  <API_BASE>/five/glico-six?k=<FIVE_TOKEN>
const FIVE_TOKEN_DEFAULT = '78c6313579a0264cbf1eebef2b530570';
// Modo estrito: REJEITA /five sem o ?k= correto. Ficou FALSE até a URL na Five ser trocada; a
// condição pra ligar era o five_debug mostrar os eventos chegando com o ?k= certo, e em 17/08/2026
// os 16 eventos gravados vieram TODOS com a chave certa (uma query só, `?k=78c6...`). Ligado.
// Sem isso, quem descobrisse a URL conseguia inventar pedido, receita e comissão na dash.
// O log cru do five_debug roda ANTES desta checagem de propósito: evento recusado ainda deixa rastro.
const FIVE_STRICT = true;

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
  // A COLUNA afiliado_id PODE NAO EXISTIR AINDA. Este SELECT roda em TODA requisicao e ANTES de
  // qualquer ALTER TABLE do worker - entao, num banco que ainda nao tem a coluna, ele derruba a API
  // INTEIRA com "no such column" (aconteceu em 23/08/2026: /api/state e /api/wa/chats caindo em
  // 1101 ate a coluna ser criada na mao). O mesmo valeria pro banco do Giovane, que roda este
  // codigo com D1 proprio. Por isso: tenta o SELECT completo, e se a coluna faltar, cria e refaz.
  // Nunca deixe este caminho depender de uma coluna nova sem esta rede.
  let row;
  const SEL = (extra) => `SELECT s.expires_at, s.user_id, u.id, u.login, u.name, u.abbr, u.role, u.color, u.bg, u.com_pct,
            u.photo, u.banner, u.email${extra}
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token = ? AND s.expires_at > ?`;
  try {
    row = await env.DB.prepare(SEL(', u.afiliado_id')).bind(token, now).first();
  } catch (_) {
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN afiliado_id TEXT').run(); } catch (_2) {}
    try { row = await env.DB.prepare(SEL(', u.afiliado_id')).bind(token, now).first(); }
    catch (_3) { row = await env.DB.prepare(SEL('')).bind(token, now).first(); }
  }
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

// O valor pago so pode DESCER em relacao ao pedido: e desconto, nao remarcacao. Sem este teto, um
// vendedor poderia inflar a propria comissao digitando um numero maior que o pedido.
function _valorPago(v, lead) {
  const n = Number(v) || 0;
  const cheio = Number(lead && lead.vl) || 0;
  if (n <= 0) return 0;
  return cheio > 0 ? Math.min(n, cheio) : n;
}

function isDirector(user) {
  return user && ROLE_DIRETOR.includes(user.role);
}

// QUEM PODE MEXER NA PRESSEL E NA ROLETA (só estes handlers, nada mais).
//
// A pressel é a ferramenta de trabalho de quem toca anúncio: pixel, domínio, criativo, mensagem e
// pra qual número o lead vai. O Bruno pediu em 17/08/2026 que o gestor de tráfego tenha aqui o mesmo
// que ele. A tela já foi liberada, mas sem isto o gestor via os botões e levava 403 em todos: pior
// que o botão escondido, porque parece defeito da dash.
//
// NÃO adicione 'gestor' em ROLE_DIRETOR pra resolver isso. Aquela lista governa financeiro, aprovar
// saque, apagar usuário e configuração de IA: seria dar a operação inteira pra quem cuida de anúncio.
// Pressel e roleta agora tem DONO (24/08/2026). Sem `afl` = nossa. Com `afl` = daquele afiliado.
// O afiliado mexe na dele; o gestor de trafego continua mexendo na nossa.
const _podeMexerPressel = (u) => isDirector(u) || String((u && u.role) || '').toLowerCase() === 'gestor' || isAfiliado(u);
const _donoDe = (x) => String((x && x.afl) || '');
// QUEM MEXE NA NOSSA CONTA DA META. Separado do _podeMexerPressel de proposito: la o afiliado entra
// porque tem pressel e chip PROPRIOS, com dono. Aqui nao ha "dele": a WABA, o token da Graph e os
// numeros oficiais sao da casa, e registrar numero pela API ja queimou dois chips em coexistencia.
const _podeMexerMeta = (u) => isDirector(u) || String((u && u.role) || '').toLowerCase() === 'gestor';
// Cargo que so toca campanha e nunca ve cliente (vale tambem pra equipe de um afiliado).
const _soCampanhaRole = (u) => ['gestor', 'designer'].includes(String((u && u.role) || '').toLowerCase());

// CHIPS QUE UMA PRESSEL PODE USAR: so os do MESMO dono.
//
// E a linha que separa os dois mundos na roleta. Pressel nossa (sem afl) so roteia pra chip nosso
// (sem afl); pressel de afiliado so roteia pros numeros daquele afiliado. Sem isto, publicar a
// pressel de um afiliado mandaria lead dele pros NOSSOS numeros - e vice-versa.
//
// NO DIA DO DEPLOY ISTO E INOCUO, de proposito: nenhuma pressel e nenhum chip tem `afl`, entao os
// dois lados da comparacao sao '' e nada muda na roleta que esta rodando. A memoria do projeto tem
// quatro casos de roleta que morreu em silencio; a forma segura de mexer aqui e assim, com um
// filtro que comprovadamente nao filtra nada ate alguem criar o primeiro registro com dono.
// IDS DE PRESSEL QUE ESTE USUARIO PODE VER. null = todas (diretor, gestor). Pro afiliado, so as
// dele - e afiliado sem vinculo recebe Set vazio, que corta tudo (fail-closed).
const _presselIdsVisiveis = (u, data) => {
  // VALE PRO MUNDO INTEIRO DELE, nao so pro afiliado (auditoria de 24/08/2026). Testar so
  // isAfiliado devolvia null pro vendedor, cobrador e gestor que ELE cadastrou - e null quer dizer
  // "ve tudo". Ou seja, a equipe dele enxergava as NOSSAS pressels em tres rotas de metrica.
  if (!noMundoAfiliado(u) && !afiliadoSemVinculo(u)) return null;
  const meu = aflDe(u);
  const ps = Array.isArray(data && data.pressels) ? data.pressels : [];
  return new Set(ps.filter((p) => p && meu && String(p.afl || '') === meu).map((p) => String(p.id)));
};

const _chipsDaPressel = (p, chips) => {
  const dono = _donoDe(p);
  return (chips || []).filter((c) => _donoDe(c) === dono);
};

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
    // afiliado_id vai junto: a dash do afiliado usa ele pra saber quais pedidos sao dele nas telas
    // que filtram no cliente (painel, destaques). O escopo de verdade continua sendo do servidor.
    'SELECT id, login, pwd_hash, name, abbr, role, color, bg, com_pct, photo, banner, email, afiliado_id FROM users WHERE lower(login) = ?'
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

// ─── Captura de webhooks da Five (plataforma da fábrica/produtor) ──────────
// Modo diagnóstico: guarda o payload CRU (headers + body) pra a gente ver o
// formato exato de cada evento (Pedido Criado, Cobrança Atualizada, Envio...)
// ANTES de construir a ingestão de verdade. Sem auth de propósito (webhook externo).
async function handleFiveCapture(req, env, subpath) {
  const now = Math.floor(Date.now() / 1000);
  let bodyText = '';
  try { bodyText = await req.text(); } catch (_) { bodyText = ''; }
  const headers = {};
  try { for (const [k, v] of req.headers.entries()) headers[k] = v; } catch (_) {}
  const u = new URL(req.url);
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS five_debug (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, subpath TEXT, method TEXT, query TEXT, headers TEXT, body TEXT)').run();
    await env.DB.prepare('INSERT INTO five_debug (ts, subpath, method, query, headers, body) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(now, subpath || '', req.method, u.search || '', JSON.stringify(headers).slice(0, 4000), String(bodyText).slice(0, 40000)).run();
  } catch (_) {}
  // Auth do webhook (modo transição): valida o ?k= quando vier; só BLOQUEIA de fato quando
  // FIVE_STRICT=true (aí a URL cadastrada na Five já tem o ?k=). O log cru acima roda ANTES,
  // então dá pra ver no five_debug quando os eventos começam a chegar com o ?k= certo (query LIKE '%k=...').
  const _k = u.searchParams.get('k') || '';
  const _expected = (env && env.FIVE_TOKEN) || FIVE_TOKEN_DEFAULT;
  const _verified = !!_k && _k === _expected;
  if (FIVE_STRICT && !_verified) return err('unauthorized', 401);
  // Ingestão estruturada: além do log cru, sobe pro modelo de pedidos (five_orders)
  // E espelha no Kanban (data.leads) pro acompanhamento andar sozinho. Best-effort:
  // nunca quebra o 200 (webhook precisa responder ok mesmo se o parse/gravação falhar).
  let _p = null; try { _p = JSON.parse(bodyText); } catch (_) { _p = null; }
  if (_p) {
    try { await _fiveUpsertOrder(env, _p); } catch (_) {}
    try { await _fiveUpsertLead(env, _p); } catch (_) {}
  }
  return json({ ok: true, received: true });
}

// Modelo de dados do produtor (todas as tabelas se conversam por chaves):
//  five_orders      1 linha por pedido (fatos do pedido, atualizado a cada evento)
//  five_commissions comissão normalizada: (pedido, afiliado) -> percent, amount
//  five_affiliates  registro de afiliados (afiliado da Five -> nome + nosso usuário)
//  five_products    catálogo de produtos do produtor
// tenant = project_id da Five (separa os produtores quando clonar pro amigo)
async function _ensureFiveTables(env) {
  // UMA VEZ POR ISOLATE, igual _waEnsureTables e _scEnsureTables ja faziam. Sem esta linha as seis
  // DDL (CREATE/ALTER) rodavam a CADA requisicao, e como cada ida ao D1 custa uns 200ms de rede, o
  // /api/five/summary e o /api/five/orders levavam DOIS SEGUNDOS pra devolver 200 bytes. Era pura
  // espera de ida e volta, com uma tabela de 1 linha. Deploy novo zera o isolate e as DDL rodam de
  // novo, entao continua seguro pra mudanca de schema.
  if (_fiveTablesOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS five_orders (
    order_id TEXT PRIMARY KEY,
    project_id TEXT, project_name TEXT,
    product_id TEXT, product_name TEXT,
    offer_id TEXT, offer_title TEXT, offer_price REAL, offer_qty INTEGER,
    customer_name TEXT, customer_doc TEXT, customer_mail TEXT, customer_phone TEXT, customer_address TEXT,
    charge_status TEXT, charge_method TEXT, charge_amount REAL, charge_code TEXT, charge_updated_at TEXT,
    commissions TEXT,
    shipping_platform TEXT, shipping_code TEXT, shipping_status TEXT, shipping_core_id TEXT,
    last_event TEXT, last_status TEXT, created_at INTEGER, updated_at INTEGER, raw TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS five_commissions (
    order_id TEXT, affiliate_id TEXT, percent REAL, amount REAL,
    PRIMARY KEY (order_id, affiliate_id)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS five_affiliates (
    affiliate_id TEXT PRIMARY KEY, tenant TEXT, name TEXT, our_user_id TEXT, created_at INTEGER
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS five_products (
    product_id TEXT PRIMARY KEY, tenant TEXT, name TEXT, created_at INTEGER
  )`).run();
  // CADASTRO DE AFILIADO (23/08/2026). A tabela nasceu como um stub que a Five preenchia sozinha:
  // so id + nome. O Bruno passou a GERIR afiliado (area propria na dash), e gerir pede o que a Five
  // nao manda: contato, chave Pix, % combinado e se esta ativo. Colunas adicionadas uma a uma e com
  // try/catch porque o D1 nao tem "ADD COLUMN IF NOT EXISTS" e isto roda a cada boot.
  // `slug` (25/08/2026): a etiqueta do afiliado na URL publica da pressel dele, ver _aflSlugDe.
  for (const col of ['phone TEXT', 'doc TEXT', 'pix TEXT', 'pct REAL', 'status TEXT', 'obs TEXT',
                     'origem TEXT', 'updated_at INTEGER', 'slug TEXT']) {
    try { await env.DB.prepare('ALTER TABLE five_affiliates ADD COLUMN ' + col).run(); } catch (_) {}
  }
  // O QUE JA FOI PAGO A CADA AFILIADO. Sem isto, "a pagar" seria sempre a comissao inteira: a dash
  // nunca saberia que o Bruno ja acertou. Uma linha por pagamento (nao um saldo), pra o historico
  // sobreviver a correcao e a dash poder mostrar quando e como cada acerto saiu.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS afiliado_pagamentos (
    id TEXT PRIMARY KEY, affiliate_id TEXT, valor REAL, data TEXT, metodo TEXT, obs TEXT,
    criado_por TEXT, created_at INTEGER
  )`).run();
  // O QUE O CLIENTE PAGOU DE VERDADE (com o juro do parcelamento) e quanto foi so juro.
  // charge_amount guarda o valor da VENDA, que e o dinheiro do produtor - e o que as ~10 somas
  // daqui e os ~30 pontos do front leem como receita. Estas duas colunas existem pra NAO perder
  // o valor real da fatura, que e o que bate com o extrato numa conferencia. Ver _valorDaVenda.
  for (const col of ['charge_pago REAL', 'charge_juros REAL']) {
    try { await env.DB.prepare('ALTER TABLE five_orders ADD COLUMN ' + col).run(); } catch (_) {}
  }
  // A dash do afiliado depende desta coluna, e o authUser (que roda antes de tudo) ja a le.
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN afiliado_id TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_afil_pag ON afiliado_pagamentos(affiliate_id)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_five_comm_aff ON five_commissions(affiliate_id)').run(); } catch (_) {}
  try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_five_orders_prod ON five_orders(product_id)').run(); } catch (_) {}
  _fiveTablesOk = true;
}
function _num(v) { const n = Number(v); return isNaN(n) ? null : n; }
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

// ── QUANTO DESTA VENDA E DINHEIRO DO BRUNO ──────────────────────────────────
//
// O cliente que parcela no cartao paga MAIS que o preco do kit, e a diferenca e juro do
// parcelamento: e da operadora, nunca do produtor. O primeiro cartao parcelado da operacao
// (Jose Francisco, 24/08/2026) chegou como charge.amount = 541,12 num kit de 497 e os 44,12 de
// juro entraram na dash como receita: card do Kanban, "Receita recebida", ticket, lucro, ROAS e
// ate a base da comissao do vendedor. Palavras do Bruno: "esse valor mais alto e apenas juros, o
// que eu recebo sempre vai ser o valor de 497".
//
// A conta certa esta no MESMO payload: offer.price e o preco de tabela do kit e numberOfItems a
// quantidade. Regras, nesta ordem:
//   - sem preco de tabela, so resta o cobrado (melhor um numero com juro do que nenhum);
//   - cobrado MENOR que a tabela e DESCONTO de verdade (o vendedor negociou), e vale o cobrado;
//   - cobrado MAIOR e juro de parcelamento, e vale a tabela.
// numberOfItems 0 vale 1: a Five manda 0 na maioria dos pedidos reais (mesmo caso ja tratado no
// _frascosDoPedido). Multiplicar por 0 zeraria a venda inteira.
function _valorDaVenda(offer, charge) {
  const preco = _num(offer && offer.price);
  const itens = Math.max(1, _num(offer && offer.numberOfItems) || 1);
  const cobrado = (charge && charge.amount != null) ? (_num(charge.amount) || 0) : 0;
  if (!(preco > 0)) return cobrado;       // sem preco de tabela so resta o cobrado (_num devolve null, nao 0)
  if (cobrado <= 0) return preco;         // evento sem cobranca: preco de tabela, sem multiplicar
  const tabela = preco * itens;
  // A multiplicacao so vale se o cliente REALMENTE pagou o total: se pagou menos, ou foi desconto
  // ou numberOfItems nao era quantidade de kits, e nos dois casos o cobrado e a verdade.
  return cobrado < tabela ? cobrado : tabela;
}
// Quanto o cliente pagou a mais so de juro (0 quando pagou a vista ou com desconto).
function _jurosDaVenda(offer, charge) {
  const cobrado = (charge && charge.amount != null) ? _num(charge.amount) : 0;
  return Math.max(0, Math.round((cobrado - _valorDaVenda(offer, charge)) * 100) / 100);
}

// Upsert de um pedido a partir de um payload da Five. Campos comuns sempre atualizam;
// campos específicos do evento usam COALESCE pra não apagar o que outro evento já gravou.
async function _fiveUpsertOrder(env, p) {
  const oid = p && (p.orderId || (p.order && p.order.id));
  if (!oid) return false;
  if (_isFiveDemo(p)) return false; // payload de teste/demo não entra em five_orders (não infla receita)
  await _ensureFiveTables(env);
  const now = Math.floor(Date.now() / 1000);
  const prod = p.product || {}, offer = prod.offer || {}, cust = p.customer || {}, proj = p.project || {};
  const charge = p.charge || null, ship = p.shipping || null;
  await env.DB.prepare(`INSERT INTO five_orders
    (order_id, project_id, project_name, product_id, product_name, offer_id, offer_title, offer_price, offer_qty,
     customer_name, customer_doc, customer_mail, customer_phone, customer_address,
     charge_status, charge_method, charge_amount, charge_pago, charge_juros, charge_code, charge_updated_at, commissions,
     shipping_platform, shipping_code, shipping_status, shipping_core_id,
     last_event, last_status, created_at, updated_at, raw)
    VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET
     project_id=COALESCE(excluded.project_id, five_orders.project_id), project_name=COALESCE(excluded.project_name, five_orders.project_name),
     product_id=COALESCE(excluded.product_id, five_orders.product_id), product_name=COALESCE(excluded.product_name, five_orders.product_name),
     offer_id=COALESCE(excluded.offer_id, five_orders.offer_id), offer_title=COALESCE(excluded.offer_title, five_orders.offer_title), offer_price=COALESCE(excluded.offer_price, five_orders.offer_price), offer_qty=COALESCE(excluded.offer_qty, five_orders.offer_qty),
     customer_name=COALESCE(excluded.customer_name, five_orders.customer_name), customer_doc=COALESCE(excluded.customer_doc, five_orders.customer_doc), customer_mail=COALESCE(excluded.customer_mail, five_orders.customer_mail), customer_phone=COALESCE(excluded.customer_phone, five_orders.customer_phone),
     customer_address=COALESCE(excluded.customer_address, five_orders.customer_address),
     charge_status=COALESCE(excluded.charge_status, five_orders.charge_status),
     charge_method=COALESCE(excluded.charge_method, five_orders.charge_method),
     charge_amount=COALESCE(excluded.charge_amount, five_orders.charge_amount),
     charge_pago=COALESCE(excluded.charge_pago, five_orders.charge_pago),
     charge_juros=COALESCE(excluded.charge_juros, five_orders.charge_juros),
     charge_code=COALESCE(excluded.charge_code, five_orders.charge_code),
     charge_updated_at=COALESCE(excluded.charge_updated_at, five_orders.charge_updated_at),
     commissions=COALESCE(excluded.commissions, five_orders.commissions),
     shipping_platform=COALESCE(excluded.shipping_platform, five_orders.shipping_platform),
     shipping_code=COALESCE(excluded.shipping_code, five_orders.shipping_code),
     shipping_status=COALESCE(excluded.shipping_status, five_orders.shipping_status),
     shipping_core_id=COALESCE(excluded.shipping_core_id, five_orders.shipping_core_id),
     last_event=excluded.last_event, last_status=excluded.last_status,
     updated_at=excluded.updated_at, raw=excluded.raw`)
    .bind(oid, proj.id || null, proj.name || null, prod.id || null, prod.name || null,
      offer.id || null, offer.title || null, _num(offer.price), offer.numberOfItems != null ? _num(offer.numberOfItems) : null,
      cust.name || null, cust.document || null, cust.mail || null, cust.phoneNumber || null, cust.address ? JSON.stringify(cust.address) : null,
      charge && charge.status ? String(charge.status).toUpperCase() : null, charge ? (charge.paymentMethod || null) : null,
      // charge_amount = valor da VENDA (sem juro de parcelamento). So preenche quando a Five mandou
      // cobranca de verdade: deixar null pra pedido sem cobranca e o que mantem 'pago x nao pago'
      // funcionando nas somas e no front (que testa charge_amount antes de cair no offer_price).
      (charge && charge.amount != null) ? _valorDaVenda(offer, charge) : null,
      (charge && charge.amount != null) ? _num(charge.amount) : null,
      (charge && charge.amount != null) ? _jurosDaVenda(offer, charge) : null,
      charge ? (charge.code || null) : null, charge ? (charge.updatedAt || null) : null,
      Array.isArray(p.commissions) && p.commissions.length ? JSON.stringify(p.commissions) : null, // array VAZIO -> null (COALESCE mantém a comissão já gravada, não zera)
      ship ? (ship.platform || null) : null, ship ? (ship.shippingCode || null) : null, ship && ship.shippingStatus ? String(ship.shippingStatus).toUpperCase() : null, ship ? (ship.coreShippingId || null) : null,
      p.event || null, p.eventStatus || null, now, now, JSON.stringify(p).slice(0, 40000)).run();

  // Catálogo de produto (stub) — conecta pedido -> produto do produtor
  if (prod.id) {
    await env.DB.prepare(`INSERT INTO five_products (product_id, tenant, name, created_at) VALUES (?,?,?,?)
      ON CONFLICT(product_id) DO UPDATE SET name=COALESCE(excluded.name, five_products.name), tenant=COALESCE(excluded.tenant, five_products.tenant)`)
      .bind(prod.id, proj.id || null, prod.name || null, now).run();
  }
  // Comissões: normaliza numa tabela própria e registra o afiliado (stub, nomeado depois).
  // Só mexe quando o evento traz comissões NÃO vazias (CHARGE_UPDATED), pra não apagar as existentes.
  // (array vazio -> não mexe; senão um evento sem comissões zerava as já gravadas)
  if (Array.isArray(p.commissions) && p.commissions.length) {
    await env.DB.prepare('DELETE FROM five_commissions WHERE order_id=?').bind(oid).run();
    for (const c of p.commissions) {
      const afid = c && c.affiliateId; if (!afid) continue;
      await env.DB.prepare('INSERT OR REPLACE INTO five_commissions (order_id, affiliate_id, percent, amount) VALUES (?,?,?,?)')
        .bind(oid, afid, _num(c.percent), _num(c.amount)).run();
      await env.DB.prepare(`INSERT INTO five_affiliates (affiliate_id, tenant, name, our_user_id, created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(affiliate_id) DO UPDATE SET tenant=COALESCE(excluded.tenant, five_affiliates.tenant)`)
        .bind(afid, proj.id || null, null, null, now).run();
    }
  }
  return true;
}

// ── Ponte Five -> Kanban (data.leads) ──────────────────────────────────────
// Espelha o pedido da Five como card no Kanban pra o acompanhamento andar sozinho.
// Casa por five_id = orderId (upsert). CAS otimista igual handleMoveLead (não sobrescreve
// escrita concorrente). Best-effort: chamada dentro de try no webhook, nunca quebra o 200.
// A MESMA coluna tem dois nomes no sistema: o que a Five manda ('Enviado', 'Cobranca', 'Pago') e o
// id do board na dash ('Enviados', 'Entregues', 'Pagos'), que e o que fica gravado quando alguem
// arrasta o card na mao. So os nomes da Five estavam ranqueados aqui: depois de UM arrasto manual o
// rank do pedido virava 0 e o proximo evento da Five empurrava ele PRA TRAS (um pedido em 'Pagos'
// voltava pra 'Enviado' no primeiro rastreio novo dos Correios). Os dois nomes valem o mesmo rank.
const FIVE_COL_RANK = {
  'A Enviar': 1, 'Reportado': 1, 'Reportados': 1,
  'Enviado': 2, 'Enviada': 2, 'Enviados': 2,
  'Rota de Entrega': 3, 'Saiu para Entrega': 3, 'Saiu pra Entrega': 3, 'Retirada': 3, 'Retirar nos Correios': 3,
  // 3.5 de proposito: 'Requer Atenção' e um DESVIO no meio do caminho, nao uma etapa a mais. Precisa
  // ser maior que a rota (senao a entrega que falha nao tira o card de 'Saiu para Entrega', que e
  // justamente de onde ela falha) e menor que a cobranca (pra entrega refeita seguir pra frente).
  'Atenção': 3.5, 'Requer Atenção': 3.5,
  'Cobrança': 4, 'Entregue': 4, 'Entregues': 4, 'Inadimplência': 4, 'Inadimplências': 4,
  'Pago': 5, 'Pagos': 5,
};
// Fim de linha: pedido que ja deu errado nao volta pro fluxo normal por causa de um rastreio atrasado.
const FIVE_COL_FIM = ['Frustrado', 'Frustrados', 'Devolvido', 'Devolvido com Reverso', 'Retornado', 'Cancelado', 'Cancelado sem Custo', 'Roubo', 'Roubos'];
// Coluna-alvo a partir do evento/status. null = não move (mantém a coluna atual).
function _fiveColFor(p) {
  const ev = String(p.event || '').toUpperCase();
  const s = (String((p.shipping && p.shipping.shippingStatus) || '') + ' ' + String(p.eventStatus || '')).toLowerCase();
  if (ev === 'ORDER_CREATE') return 'A Enviar';
  if (ev === 'SHIPPING_REGISTER') return 'Enviado';
  if (ev === 'CHARGE_UPDATED') {
    const cs = String((p.charge && p.charge.status) || '').toUpperCase();
    if (cs === 'PAID') return 'Pago';
    if (/REFUND|CHARGEBACK|CANCEL|ESTORN/.test(cs)) return 'Cancelado'; // estorno/chargeback -> terminal negativo
    return null;
  }
  if (ev === 'SHIPPING_UPDATE') {
    // devolução/extravio -> terminal negativo (testar antes; "devolvido" não colide com os demais)
    if (/devolv|return|extraviad|recus|nao.?retir|n[ãa]o.?retir/.test(s)) return 'Devolvido';
    // A FIVE MANDA O STATUS EM INGLES E EM MAIUSCULA. Conferido no que ela ja enviou de verdade:
    // IN_TRANSIT, IN_TRANSIT_TO_DELIVERY, DELIVERED, SENDED (e vazio no SHIPPING_REGISTER). Os
    // termos em portugues ficam por seguranca, caso ela mude o texto.
    // ORDEM IMPORTA DUAS VEZES: "saiu para entrega" contem "entreg", entao vem ANTES do entregue;
    // e IN_TRANSIT_TO_DELIVERY contem IN_TRANSIT, entao a rota vem ANTES do transito. Era isso que
    // estava errado (23/08/2026): o pedido do Elias saiu pra entrega na Five e caiu em "Enviado"
    // aqui, porque nenhum termo de rota casava com o nome ingles e o teste de transito pegava
    // primeiro. A coluna "Saiu para Entrega" vivia zerada por causa disso.
    // ENTREGA QUE FALHOU -> 'Requer Atenção', a mesma coluna que ele ve no painel da Five.
    // TEM QUE VIR ANTES do teste de entregue, porque NOT_DELIVERED contem DELIVERED: ate 24/08/2026
    // o pedido NAO entregue caia em 'Cobrança' e o cobrador ligava cobrando quem nunca recebeu o
    // produto (aconteceu com o pedido do Carlos Roberto, R$ 497). Nao e terminal de proposito: se a
    // transportadora reentregar, o DELIVERED seguinte leva o card pra Cobrança normalmente.
    if (/not.?deliver|deliver\w*.?fail|fail\w*.?deliver|n[ãa]o.?entregue|entrega.?frustrad|entrega.?n[ãa]o.?(realizada|efetuada)|sem.?sucesso|destinat[áa]rio.?ausente|ausente|endere[çc]o.?(incorreto|errado|inv[áa]lido|insuficiente|incompleto|n[ãa]o.?localizado)|address.?(issue|problem|incorrect|invalid|not.?found)|avaria|damaged|retido|on.?hold|aten[çc][ãa]o|attention|pend[êe]ncia|problem/.test(s)) return 'Requer Atenção';
    if (/saiu|out.?for.?delivery|to.?delivery|delivery.?route|\brota\b/.test(s)) return 'Rota de Entrega';
    if (/retir|waiting.?pickup|awaiting.?pickup|available.?for.?pickup|pickup|withdraw|ag[êe]ncia|dispon[íi]vel para retirada/.test(s)) return 'Retirada';
    if (/entregue|delivered|entrega efetuada|entrega realizada|entrega conclu/.test(s)) return 'Cobrança'; // entregue DE FATO -> cobrar (COD)
    if (/tr[aâ]nsito|in.?transit|postado|posted|sended|shipped|\bsent\b|enviad/.test(s)) return 'Enviado';
    return null;                                                   // status desconhecido: não move
  }
  return null;
}
// Pula os payloads DEMO (testes da Five) pra não poluir o Kanban real.
function _isFiveDemo(p) {
  const pj = String((p.project && p.project.name) || '').toLowerCase();
  const cn = String((p.customer && p.customer.name) || '').toLowerCase();
  const doc = String((p.customer && p.customer.document) || '').replace(/\D/g, '');
  return pj.includes('demo') || cn.includes('fict') || doc === '12345678900';
}
// Meses do tratamento a partir do título da oferta ("Glico Six - 6 Meses" -> 6). O tratamento é um
// frasco por mês, então mês = frasco. É a única fonte que existe: a Five manda `numberOfItems` = 0
// no pedido real (conferido no payload salvo), e sem isso todo kit entra valendo 1 frasco.
function _mesesDoTitulo(titulo) {
  const m = String(titulo || '').match(/(\d+)\s*m[eê]s/i);
  if (m) return Math.max(1, parseInt(m[1], 10));
  const u = String(titulo || '').match(/(\d+)\s*(frasco|pote)/i);
  return u ? Math.max(1, parseInt(u[1], 10)) : 0;
}
// CATÁLOGO DE KITS NASCENDO SOZINHO DO PEDIDO.
// `custos.kits` alimenta estoque, custo por frasco, conferência de devolução e o painel de Início.
// Estava VAZIO (o Bruno nunca cadastrou na mão) e por isso tudo que conta frasco caía em 1. Cada
// pedido da Five já traz oferta, título e preço; então o kit se cadastra na primeira venda.
// Só PREENCHE o que falta: se ele editou preço ou frascos, o que vale é o que ele digitou.
function _fiveUpsertKit(data, offer, prodNome) {
  if (!offer || !offer.id) return;
  if (!data.custos || typeof data.custos !== 'object') data.custos = {};
  if (!Array.isArray(data.custos.kits)) data.custos.kits = [];
  const lista = data.custos.kits;
  const oid = String(offer.id);
  const titulo = offer.title || prodNome || 'Kit';
  const meses = _mesesDoTitulo(titulo);
  const preco = _num(offer.price) || 0;
  const k = lista.find((x) => x && String(x.offer_id || x.id) === oid);
  if (!k) {
    lista.push({ id: oid, offer_id: oid, nome: titulo, label: titulo, preco, frascos: meses || 0, ativo: true, origem: 'five' });
    return;
  }
  if (!k.offer_id) k.offer_id = oid;
  if (!k.nome) k.nome = titulo;
  if (!Number(String(k.preco || '').toString().replace(',', '.')) && preco) k.preco = preco;
  if (!Number(k.frascos) && meses) k.frascos = meses;
}
// QUANTOS FRASCOS SAEM NESTE PEDIDO. O kit e a mesma coisa que o tratamento: 4 Meses = 4 frascos.
// Procura na ordem: kit cadastrado em Custos & Regras (regras.kits, que e o que a tela edita), kit
// que a Five cadastrou sozinha (custos.kits), e por ultimo o proprio titulo da oferta ("... - 4
// Meses"). Zero = nao da pra saber, e ai NAO baixa estoque (melhor saldo parado que saldo errado).
function _frascosDoPedido(data, offer, prodNome) {
  const oid = String((offer && offer.id) || '');
  const titulo = String((offer && offer.title) || prodNome || '');
  const nm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const listas = [
    (data && data.regras && Array.isArray(data.regras.kits)) ? data.regras.kits : [],
    (data && data.custos && Array.isArray(data.custos.kits)) ? data.custos.kits : [],
  ];
  for (const lista of listas) {
    const k = lista.find((x) => x && (String(x.offer_id || '') === oid || String(x.id || '') === oid))
      || lista.find((x) => x && nm(x.nome || x.label) === nm(titulo));
    const fr = k ? Number(k.frascos) || 0 : 0;
    if (fr > 0) return fr;
  }
  return _mesesDoTitulo(titulo) || 0;
}
async function _fiveUpsertLead(env, p) {
  const oid = p && (p.orderId || (p.order && p.order.id));
  if (!oid || _isFiveDemo(p)) return;
  const ev = String(p.event || '').toUpperCase();
  const prod = p.product || {}, offer = prod.offer || {}, cust = p.customer || {}, addr = cust.address || {}, charge = p.charge || {}, ship = p.shipping || {};
  const targetCol = _fiveColFor(p);
  const now = Math.floor(Date.now() / 1000), nowISO = new Date().toISOString();
  const d = new Date();
  // Atribuição do vendedor (mesma lógica do Payt): vínculo do afiliado da Five -> nosso vendedor,
  // senão a ponte CPF->atendente, senão o telefone (wa_attrib/wa_lead). Resolve 1x, fora do CAS.
  const _affId = (Array.isArray(p.commissions) && p.commissions.length) ? p.commissions[0].affiliateId : null;
  const attribAt = (await resolveAtByAffiliate(env, _affId))
    || (cust.document ? await resolveAtByCpf(env, cust.document) : null)
    || (cust.phoneNumber ? await resolveAtByPhone(env, cust.phoneNumber) : null);
  const _cpfC = String(cust.document || '').replace(/\D/g, '');
  const _waC = String(cust.phoneNumber || '').replace(/\D/g, '');
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return;
    let data; try { data = JSON.parse(row.data); } catch (_) { return; }
    if (!Array.isArray(data.leads)) data.leads = [];
    _fiveUpsertKit(data, offer, prod.name);   // catálogo de kits se cadastra na primeira venda
    let lead = data.leads.find((l) => l && String(l.five_id) === String(oid));
    if (!lead && (_cpfC || _waC.length >= 8)) {
      // Adota um lead que JÁ existe (pressel/roleta/manual) do MESMO cliente sem five_id,
      // casando por CPF (preferido) ou últimos 8 dígitos do telefone. Evita card duplicado
      // e preserva o vendedor (lead.at) já atribuído. Banco canônico: 1 pedido por cliente.
      lead = data.leads.find((l) => l && !l.five_id && (
        (_cpfC && String(l.cpf || '').replace(/\D/g, '') === _cpfC) ||
        (_waC.length >= 8 && String(l.wa || '').replace(/\D/g, '').length >= 8 && String(l.wa).replace(/\D/g, '').slice(-8) === _waC.slice(-8))
      )) || null;
      if (lead) {
        lead.five_id = String(oid);
        if (!lead.external_id) lead.external_id = 'FIVE-' + String(oid);
        if (Array.isArray(lead.hist)) lead.hist.push({ from: lead.col || '—', to: lead.col || 'A Enviar', who: 'five', time: nowISO, note: 'vinculado ao pedido Five ' + String(oid) });
      }
    }
    if (!lead) {
      lead = {
        id: Date.now(), five_id: String(oid), external_id: 'FIVE-' + String(oid), orig: 'Five',
        nome: '', cpf: '', wa: '', email: '', cep: '', end: '', num: '', comp: '', bairro: '', cidade: '', uf: '',
        // com_pct sai VAZIO, nao zero: zero valia como "taxa combinada neste pedido" e fazia todo
        // pedido da Five pagar 0%, ignorando o cadastro do vendedor em silencio. Vazio deixa a
        // dash cair na taxa do vendedor, que e o certo ate alguem combinar outra coisa.
        prod: '', trat: '', vl: 0, com_pct: '', pgto: '', spg: 'Pendente', mod: 'entrega',
        at: attribAt || null, col: 'A Enviar', obs: '', tags: [], fu: null, agend: '', track: '', link: '',
        data: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`,
        hist: [{ from: '—', to: 'A Enviar', who: 'five', time: nowISO }], comments: [], five_status: ev.toLowerCase(),
      };
      data.leads.unshift(lead);
    }
    // ACEITE AUTOMATICO (pedido do Bruno em 20/08/2026). O pedido chegar da plataforma JA E o
    // aceite: o time lanca o pedido la, a plataforma devolve o pedido pra ca, e ficar clicando
    // "Aceitar" depois disso e trabalho repetido - e enquanto ninguem clica, o pedido fica parado na
    // fila de aceitacao como se estivesse pendente.
    // So vale pro que NASCEU na nossa dash (orig 'Manual'), que e o que aparece na fila de
    // Aceitacoes. Pedido que nasceu na Five nunca esteve nessa fila e nao vira "aceito" a toa - se
    // virasse, a tabela de aceitos viraria a lista de todos os pedidos da operacao.
    if (String(lead.orig) === 'Manual' && !lead.aceito) {
      lead.aceito = true;
      lead.aceito_em = nowISO;
      lead.aceito_por = 'auto';   // quem aceitou: 'auto' = veio da plataforma, senao e o id de quem clicou
      if (Array.isArray(lead.hist)) lead.hist.push({ from: lead.col || '—', to: lead.col || '—', who: 'five', time: nowISO, note: 'aceito automaticamente: o pedido voltou da plataforma (' + String(oid) + ')' });
    }
    // Se ainda não tem dono e a Five/ponte sabe quem atendeu, credita agora (não sobrescreve dono manual).
    if (!lead.at && attribAt) lead.at = attribAt;
    // DE QUAL AFILIADO E ESTE PEDIDO (23/08/2026). O Kanban dos Afiliados e a versao de dash do
    // afiliado filtram por este campo; sem ele o pedido de afiliado ficaria indistinguivel do nosso
    // e o afiliado veria pedido que nao e dele. Sempre atualiza (nao e setIf): quem manda e a Five,
    // e um evento posterior corrigindo o afiliado tem que valer.
    if (_affId) {
      lead.afl = String(_affId);
      const _an = (p.commissions[0] && (p.commissions[0].affiliateName || p.commissions[0].name)) || null;
      if (_an) lead.afl_nome = String(_an);
    }
    // Preenche só o que está vazio (um evento não apaga o que outro trouxe).
    const setIf = (k, v) => { if (v != null && v !== '' && (lead[k] == null || lead[k] === '')) lead[k] = v; };
    setIf('nome', cust.name); setIf('cpf', cust.document); setIf('wa', cust.phoneNumber); setIf('email', cust.mail);
    setIf('prod', prod.name || offer.title); setIf('trat', offer.title);
    setIf('cep', addr.zipCode); setIf('end', addr.address); setIf('num', addr.number);
    setIf('bairro', addr.neighborhood); setIf('cidade', addr.city); setIf('uf', addr.state);
    if ((!lead.vl || lead.vl === 0) && offer.price != null) lead.vl = Number(offer.price) || 0;
    lead.five_status = ev.toLowerCase();
    if (ev === 'CHARGE_UPDATED') {
      const _cs = String(charge.status || '').toUpperCase();
      // VALOR DO PEDIDO SEM O JURO DO PARCELAMENTO (ver _valorDaVenda). Esta linha gravava
      // charge.amount direto e o card do Jose Francisco virou R$ 541,12 num kit de R$ 497.
      const _vv = _valorDaVenda(offer, charge);
      if (_vv > 0) lead.vl = _vv;
      // O que o cliente pagou de verdade fica gravado a parte: e o numero que bate com a
      // fatura/extrato numa conferencia, e some se a gente so guardar o valor da venda.
      if (charge.amount != null) {
        lead.vl_cobrado = _num(charge.amount);
        const _ju = _jurosDaVenda(offer, charge);
        if (_ju > 0) lead.vl_juros = _ju; else delete lead.vl_juros;
      }
      if (charge.paymentMethod) lead.pgto = charge.paymentMethod;
      // MODALIDADE (antecipado x na entrega) pelo meio de pagamento da Five. O card do Kanban mostra
      // isso num selo, e sem esta linha todo pedido nascido na Five ficava no default 'entrega'
      // mesmo tendo sido pago no cartão. Só decide quando a Five diz alguma coisa reconhecível, e
      // NÃO mexe no que veio do nosso cadastro (lá quem escolheu foi o vendedor, na hora da venda).
      if (String(lead.orig || '') === 'Five') {
        const _pm = String(charge.paymentMethod || '');
        if (/cod|cash|delivery|entrega|contra/i.test(_pm)) lead.mod = 'entrega';
        else if (/credit|debit|card|cart|pix|billet|boleto|bank/i.test(_pm)) lead.mod = 'antecipado';
      }
      if (_cs === 'PAID') lead.spg = 'Pago';
      else if (/REFUND|CHARGEBACK|CANCEL|ESTORN/.test(_cs)) lead.spg = 'Recusado'; // estorno/chargeback tira o Pago
      if (Array.isArray(p.commissions) && p.commissions.length) {
        lead.five_commissions = p.commissions;
        const pct = Number(p.commissions[0] && p.commissions[0].percent);
        if (!isNaN(pct) && pct > 0) lead.com_pct = pct; // % de comissão real do afiliado (card mostrava 0%)
      }
    }
    if ((ev === 'SHIPPING_REGISTER' || ev === 'SHIPPING_UPDATE') && ship.shippingCode) lead.track = ship.shippingCode;
    // O NUMERO QUE RASTREIA DE VERDADE E OUTRO. `shippingCode` (FVJ...BR) e o codigo da FIVE, e a
    // pagina deles exige o CPF do comprador e ainda assim nao mostra nada (o Bruno tentou). Quem
    // entrega e a J&T Express, e o numero dela vem no MESMO payload como `coreShippingId`
    // (ex: 888030889629565) - esse abre em qualquer rastreador, sem CPF e sem captcha.
    if (ship.coreShippingId) lead.track_core = String(ship.coreShippingId);
    if (ship.platform) lead.transp_nome = String(ship.platform);
    // SELO DE ENTREGA NO CARD (25/08/2026, pedido do Bruno: "o Kanban da Five tem os selinhos
    // Preparando / Em transito / Rota de Entrega / Nao entregue / Entregue, quero na nossa").
    // A Five ja mandava isso: `shipping.shippingStatus`, que ja era gravado em five_orders e era
    // JOGADO FORA na hora de espelhar no lead - o front so tinha a COLUNA, que e grossa demais
    // (os 27 "Enviado" incluem quem so foi postado e quem ja esta na rua).
    //
    // TRES CUIDADOS, cada um vale um bug:
    // 1) So escreve DENTRO de evento de envio e so quando tem valor. Um CHARGE_UPDATED chega depois
    //    do entregue (3 pedidos em producao estao assim) e, se a escrita fosse incondicional, ele
    //    apagaria o selo verde de quem ja recebeu - e o cobrador ligaria cobrando no escuro.
    // 2) SHIPPING_REGISTER vem com shippingStatus NULL (5 pedidos hoje): isso NAO e ausencia, e
    //    "postado, sem evento da transportadora ainda" = o "Preparando" da Five. Vira REGISTERED.
    // 3) REGISTERED nao rebaixa quem ja andou. A Five reenvia evento (327 webhooks pra 42 pedidos)
    //    e um SHIPPING_REGISTER repetido faria um pedido entregue voltar pra "Preparando".
    if (ev === 'SHIPPING_REGISTER' || ev === 'SHIPPING_UPDATE') {
      const _ss = ship.shippingStatus ? String(ship.shippingStatus).toUpperCase()
        : (ev === 'SHIPPING_REGISTER' ? 'REGISTERED' : '');
      if (_ss && !(_ss === 'REGISTERED' && lead.ship)) {
        lead.ship = _ss;
        lead.ship_ts = now;   // "Rastreio atualizado em" do card, em segundos
      }
    }
    // Coluna: só move PRA FRENTE (rank maior) ou pra terminal negativo. Nunca volta.
    if (targetCol && targetCol !== lead.col) {
      const cur = FIVE_COL_RANK[lead.col] || 0, tgt = FIVE_COL_RANK[targetCol] || 0;
      const jaAcabou = FIVE_COL_FIM.includes(lead.col);
      if (!jaAcabou && (tgt > cur || FIVE_COL_FIM.includes(targetCol))) {
        const from = lead.col; lead.col = targetCol;
        if (Array.isArray(lead.hist)) lead.hist.push({ from: from || '—', to: targetCol, who: 'five', time: nowISO });
      }
    }
    // BAIXA DE ESTOQUE NO DESPACHO. "Saiu o pedido" = SHIPPING_REGISTER, que e quando a Five posta.
    // Vai no MESMO salvamento do card, entao ou grava tudo ou nao grava nada. A repeticao e barrada
    // pelo proprio extrato: se ja existe uma saida deste pedido, nao lanca de novo (a Five reenvia
    // evento, e estoque contado duas vezes some com frasco que existe na prateleira).
    if (ev === 'SHIPPING_REGISTER') {
      if (!Array.isArray(data.estoque_movs)) data.estoque_movs = [];
      const jaBaixou = data.estoque_movs.some((m) => m && m.tipo === 'saida_pedido' && String(m.order_id) === String(oid));
      if (!jaBaixou) {
        const fr = _frascosDoPedido(data, offer, prod.name);
        if (fr > 0) {
          data.estoque_movs.unshift({
            id: 'mv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            ts: Date.now(), tipo: 'saida_pedido', qtd: fr,
            motivo: 'Pedido despachado na Five', obs: String(cust.name || ''),
            order_id: String(oid), ref: '',
          });
        }
      }
    }
    const newVer = (row.version || 0) + 1;
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), newVer, now, 'five:' + String(oid), row.version).run();
    if (res && res.meta && res.meta.changes > 0) return;
    await new Promise((r) => setTimeout(r, 12 * (attempt + 1))); // backoff: outra escrita ganhou o version; espera e re-tenta
  }
  // CAS esgotado: o pedido está salvo em five_orders (atômico), mas o card do Kanban não subiu.
  // Não fica em silêncio (a Five recebeu 200): registra pra dar pra reprocessar/depurar.
  try { await env.DB.prepare('INSERT INTO five_debug (ts, subpath, method, query, headers, body) VALUES (?,?,?,?,?,?)').bind(now, 'CAS_EXHAUSTED', ev, String(oid), '', JSON.stringify(p).slice(0, 4000)).run(); } catch (_) {}
}

// Lista os pedidos ingeridos da Five (só diretor). Consumido pelo dash de produtor.
// O GESTOR DE TRÁFEGO também lê daqui, mas SEM dinheiro e SEM cliente. Ele precisa do volume (quantos
// pedidos, de que produto, em que dia) pra medir campanha; comissão, dado do comprador e endereço não
// são assunto dele. Antes o gate era binário (só diretor) e a dash dele abria vazia, que é pior que
// não ter a tela: parece que a campanha não vendeu nada.
const _gestorLe = (u) => isDirector(u) || String((u && u.role) || '').toLowerCase() === 'gestor';

// QUEM SAO AS PESSOAS DO MUNDO DE UM AFILIADO (ele + a equipe dele). O inbox amarra a conversa a
// uma INSTANCIA nomeada ax_<id-do-usuario>_<8digitos>, entao pra saber quais conversas sao do mundo
// dele o caminho e: pegar os ids das pessoas dele e casar pelo prefixo da instancia.
// O afiliado e o "diretor" do mundo dele: ve a conversa dos vendedores DELE, como o Bruno ve a dos
// nossos. Um vendedor dentro do mundo dele continua vendo so as proprias (regra que ja existia).
// AS INSTANCIAS QUE ESTE USUARIO PODE TOCAR. Um lugar so, porque a auditoria de 24/08/2026 achou
// SEIS rotas de WhatsApp repetindo (ou esquecendo) essa regra: conversa, mensagem, envio, funil,
// venda e conexao. Regra: diretor tudo; quem e do mundo de um afiliado leva as instancias do mundo
// dele; o resto so a propria. Instancia sem atendente resolvido (dc_*, sc_*) so diretor.
async function _idsQuePossoVer(env, u) {
  if (isDirector(u)) return null;                       // null = sem corte
  if (afiliadoSemVinculo(u)) return [];                 // fail-closed
  if (noMundoAfiliado(u)) return await _idsDoMundoAfiliado(env, aflDe(u));
  return [String(u.id)];
}
// A instancia `inst` pertence a algum dos ids? (nome e ax_<id> ou ax_<id>_<sufixo>)
const _instEhDe = (inst, ids) => {
  const t = String(inst || '');
  return (ids || []).some((id) => t === 'ax_' + id || t.indexOf('ax_' + id + '_') === 0);
};
// Condicao SQL + binds pro corte por instancia. ids vazio vira 1=0 (nunca "sem filtro").
// substr e nao LIKE: '_' e curinga no LIKE e casaria instancia de outro vendedor.
function _sqlInst(col, ids) {
  if (!ids || !ids.length) return { cond: '1=0', binds: [] };
  const ors = [], binds = [];
  for (const id of ids) {
    const pf = 'ax_' + id + '_';
    ors.push('(' + col + ' = ? OR substr(' + col + ',1,?) = ?)');
    binds.push('ax_' + id, pf.length, pf);
  }
  return { cond: '(' + ors.join(' OR ') + ')', binds };
}

async function _idsDoMundoAfiliado(env, afiliadoId) {
  if (!afiliadoId) return [];
  try {
    const r = await env.DB.prepare('SELECT id FROM users WHERE afiliado_id = ?').bind(afiliadoId).all();
    return ((r && r.results) || []).map((x) => String(x.id));
  } catch (_) { return []; }
}
async function handleFiveOrders(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // O AFILIADO LE A FATIA DELE (24/08/2026). As telas que o Bruno liberou pra ele - Evolucao
  // Diaria, Projecao Mensal, Analise de Pedidos - leem TODAS daqui, via useProdutor. Com o 403 de
  // antes elas abririam vazias e pareceriam quebradas. O recorte e por five_commissions: pedido com
  // comissao do afiliado dele. Sem vinculo, nao le nada (fail-closed, igual ao resto).
  const _afl = (noMundoAfiliado(u) || afiliadoSemVinculo(u)) ? aflDe(u) : null;
  const _souAfl = isAfiliado(u) || afiliadoSemVinculo(u) || (noMundoAfiliado(u) && !isDirector(u));
  if (!_gestorLe(u) && !_souAfl) return err('Sem permissão', 403);
  if (_souAfl && !_afl) return json({ orders: [], escopo: 'afiliado-sem-vinculo' });
  const _full = isDirector(u);
  try {
    await _ensureFiveTables(env);
    // Período opcional (startTs/endTs em ms). created_at/updated_at são epoch em SEGUNDOS.
    // Teto alto (não os 200 de antes) pra o cliente ter o dataset completo e o filtro de período/derivadas baterem.
    const url = new URL(req.url);
    const startTs = Number(url.searchParams.get('startTs')) || 0;
    const endTs = Number(url.searchParams.get('endTs')) || 0;
    const conds = [], binds = [];
    if (startTs) { conds.push('COALESCE(created_at, updated_at) >= ?'); binds.push(Math.floor(startTs / 1000)); }
    if (endTs) { conds.push('COALESCE(created_at, updated_at) <= ?'); binds.push(Math.floor(endTs / 1000)); }
    // O corte do afiliado entra como condicao de SQL, nao como filtro depois: assim nem chega a
    // sair do banco pedido que nao e dele.
    if (_afl) { conds.push('order_id IN (SELECT order_id FROM five_commissions WHERE affiliate_id = ?)'); binds.push(_afl); }
    const where = conds.length ? ('WHERE ' + conds.join(' AND ')) : '';
    const rows = await env.DB.prepare(`SELECT * FROM five_orders ${where} ORDER BY updated_at DESC LIMIT 20000`).bind(...binds).all();
    const orders = (rows.results || []).map(r => {
      const { raw, ...rest } = r;
      const cheio = { ...rest, customer_address: r.customer_address ? safeJson(r.customer_address) : null, commissions: r.commissions ? safeJson(r.commissions) : [] };
      if (_full) return cheio;
      // O afiliado ve o pedido INTEIRO - ele e dele: e o cliente dele que comprou, e ele precisa do
      // nome e do endereco pra tocar a entrega. O gestor de trafego e que nao pode ver cliente.
      // O gestor de trafego e o designer DELE nao veem cliente (mesma regra do nosso gestor), e a
      // linha de comissao do PRODUTOR (a nossa margem, com e-mail) nunca vai pra ninguem do mundo
      // dele: so a linha de AFILIADO. Auditoria de 24/08/2026 achou a margem de R$473,69 saindo aqui.
      if (_afl && _soCampanhaRole(u)) {
        const { customer_name, customer_doc, customer_mail, customer_phone, customer_address, commissions, charge_code, ...semPii2 } = cheio;
        return semPii2;
      }
      if (_afl) return { ...cheio, commissions: (Array.isArray(cheio.commissions) ? cheio.commissions : []).filter((c) => /affiliate|afiliad/i.test(String((c && c.type) || ''))) };
      // Sem dinheiro e sem cliente: o que sobra é o que mede campanha (produto, oferta, status, data).
      const { customer_name, customer_doc, customer_mail, customer_phone, customer_address, commissions, charge_code, ...semPii } = cheio;
      return semPii;
    });
    return json({ orders, escopo: _full ? 'full' : (_afl ? 'afiliado' : 'gestor') });
  } catch (e) { return json({ orders: [], error: String((e && e.message) || e) }); }
}

// Resumo do produtor: totais, comissões a pagar, por status, por afiliado, por produto.
async function handleFiveSummary(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // Mesma logica do /api/five/orders: o afiliado recebe o resumo da fatia dele.
  const _afl = (noMundoAfiliado(u) || afiliadoSemVinculo(u)) ? aflDe(u) : null;
  const _souAfl = isAfiliado(u) || afiliadoSemVinculo(u) || (noMundoAfiliado(u) && !isDirector(u));
  if (!isDirector(u) && !_souAfl) return err('Sem permissão', 403);
  if (_souAfl && !_afl) return json({ totals: {}, comissoes: {}, porStatus: [], porAfiliado: [], porProduto: [] });
  // Filtro reaproveitado nas 5 consultas. Diretor: sem corte. Afiliado: so o que tem comissao dele.
  // Cada consulta recebe o bind so quando o corte existe (por isso o array `bAfl`).
  const cutO = _afl ? " AND o.order_id IN (SELECT order_id FROM five_commissions WHERE affiliate_id = ?)" : '';
  const cutBare = _afl ? " WHERE order_id IN (SELECT order_id FROM five_commissions WHERE affiliate_id = ?)" : '';
  const cutC = _afl ? " AND c.affiliate_id = ?" : '';
  const bAfl = _afl ? [_afl] : [];
  try {
    await _ensureFiveTables(env);
    const qTotals = env.DB.prepare(`SELECT COUNT(*) AS pedidos,
       SUM(CASE WHEN charge_status='PAID' THEN 1 ELSE 0 END) AS pagos,
       COALESCE(SUM(CASE WHEN charge_status='PAID' THEN charge_amount ELSE 0 END),0) AS receita_paga
       FROM five_orders${cutBare}`).bind(...bAfl).first();
    // COMISSAO SO DE PEDIDO PAGO. Duas linhas acima a receita ja filtra charge_status='PAID'; esta
    // somava TODAS as linhas de comissao, inclusive de pedido que nunca foi pago. O numero vira
    // "Comissoes a cair" / "Total devido aos afiliados" e e SUBTRAIDO do lucro: um pedido de R$ 397
    // que ninguem pagou entrava como R$ 47,64 devidos e comia esse tanto do lucro, tendo gerado
    // R$ 0,00 de receita. Numa operacao COD, onde boa parte nao paga, era a maior distorcao da dash.
    // Regra do Bruno (18/08/2026): comissao existe sobre o que o cliente PAGOU. Nao pagou, nao ha.
    const qComissoes = env.DB.prepare(`SELECT COUNT(DISTINCT c.order_id) AS pedidos_com_comissao, COALESCE(SUM(c.amount),0) AS total
       FROM five_commissions c JOIN five_orders o ON o.order_id=c.order_id
       WHERE o.charge_status='PAID'${cutC}`).bind(...bAfl).first();
    const qPorStatus = (env.DB.prepare(`SELECT COALESCE(last_status,'—') AS status, COUNT(*) AS n FROM five_orders${cutBare} GROUP BY last_status ORDER BY n DESC`).bind(...bAfl).all());
    // idem por afiliado: so pedido pago gera comissao devida
    const qPorAfiliado = (env.DB.prepare(`SELECT c.affiliate_id, a.name, COUNT(*) AS pedidos, COALESCE(SUM(c.amount),0) AS comissao
       FROM five_commissions c
       JOIN five_orders o ON o.order_id=c.order_id AND o.charge_status='PAID'
       LEFT JOIN five_affiliates a ON a.affiliate_id=c.affiliate_id
       WHERE 1=1${cutC}
       GROUP BY c.affiliate_id ORDER BY comissao DESC LIMIT 50`).bind(...bAfl).all());
    const qPorProduto = (env.DB.prepare(`SELECT o.product_id, COALESCE(p.name,o.product_name) AS name, COUNT(*) AS pedidos,
       COALESCE(SUM(CASE WHEN o.charge_status='PAID' THEN o.charge_amount ELSE 0 END),0) AS receita
       FROM five_orders o LEFT JOIN five_products p ON p.product_id=o.product_id
       WHERE 1=1${cutO}
       GROUP BY o.product_id ORDER BY receita DESC LIMIT 50`).bind(...bAfl).all());
    // AS CINCO CONSULTAS RODAM JUNTAS. Elas nao dependem uma da outra, mas estavam em await
    // sequencial: cada ida ao D1 custa uns 200ms de rede, entao a tela do diretor esperava a soma de
    // todas (medido em 18/08/2026: quase 2s pra devolver 200 bytes, com a tabela tendo 1 linha).
    const [totals, comissoes, rStatus, rAfiliado, rProduto] = await Promise.all([qTotals, qComissoes, qPorStatus, qPorAfiliado, qPorProduto]);
    const porStatus = (rStatus && rStatus.results) || [];
    const porAfiliado = (rAfiliado && rAfiliado.results) || [];
    const porProduto = (rProduto && rProduto.results) || [];
    return json({ totals, comissoes, porStatus, porAfiliado, porProduto });
  } catch (e) { return json({ error: String((e && e.message) || e) }); }
}

// Produtos da Five (do produtor): por produto -> ofertas/planos (título+preço+vendas), comissões,
// evolução mensal e afiliados. Tudo derivado dos pedidos ingeridos (five_orders). Só diretor.
async function handleFiveProducts(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // Mesma regra dos pedidos: o gestor de tráfego precisa saber O QUE vende (produto, oferta, preço,
  // volume) pra escolher criativo e oferta. Comissão e afiliado saem do payload dele.
  //
  // O AFILIADO TAMBEM LE (25/08/2026). Ele vende o NOSSO produto, entao precisa do catalogo - e a
  // IMAGEM do produto vem por aqui: com o 403, a tela de Produtos dele abria sem a foto do
  // GlicoSix, que era o defeito que o Bruno viu. Ele entra na mesma faixa do gestor: produto,
  // oferta, preco e imagem; a comissao por afiliado e o dinheiro por produto ficam de fora (o
  // `_full` continua so pro diretor).
  if (!_gestorLe(u) && !isAfiliado(u)) return err('Sem permissão', 403);
  if (afiliadoSemVinculo(u)) return err('Sem permissão', 403);
  const _full = isDirector(u);
  try {
    await _ensureFiveTables(env);
    const prods = (await env.DB.prepare(`SELECT o.product_id AS product_id, COALESCE(p.name,o.product_name,'Produto') AS name,
        COUNT(*) AS pedidos,
        SUM(CASE WHEN o.charge_status='PAID' THEN 1 ELSE 0 END) AS pagos,
        SUM(CASE WHEN o.shipping_status='DELIVERED' THEN 1 ELSE 0 END) AS entregues,
        COALESCE(SUM(CASE WHEN o.charge_status='PAID' THEN o.charge_amount ELSE 0 END),0) AS receita
      FROM five_orders o LEFT JOIN five_products p ON p.product_id=o.product_id
      GROUP BY o.product_id ORDER BY receita DESC`).all()).results || [];
    // AGRUPA POR offer_id, NAO PELO TITULO (20/08/2026). O titulo e texto que a Five edita quando
    // quer: a oferta b1c4c1fd nasceu como "Glico Six - 4 Meses" e virou "GlicoSix - 4 Meses" (so o
    // espaco), e como o GROUP BY tinha offer_title junto, o MESMO kit apareceu DUAS VEZES na tela do
    // Bruno, com 2 e 5 pedidos, sem somar os 7. offer_id e a identidade e nao muda.
    // O nome exibido passa a ser o do pedido MAIS RECENTE daquela oferta: se a Five renomeou, a
    // dash mostra o nome novo, nao o primeiro que entrou.
    const offers = (await env.DB.prepare(`SELECT product_id, offer_id,
        COALESCE((SELECT f2.offer_title FROM five_orders f2
                   WHERE f2.offer_id = f.offer_id AND f2.product_id = f.product_id AND f2.offer_title IS NOT NULL AND f2.offer_title <> ''
                   ORDER BY f2.created_at DESC LIMIT 1), '—') AS offer_title,
        MAX(offer_price) AS offer_price,
        COUNT(*) AS pedidos,
        SUM(CASE WHEN charge_status='PAID' THEN 1 ELSE 0 END) AS pagos,
        COALESCE(SUM(CASE WHEN charge_status='PAID' THEN charge_amount ELSE 0 END),0) AS receita
      FROM five_orders f GROUP BY product_id, offer_id ORDER BY receita DESC`).all()).results || [];
    const comm = (await env.DB.prepare(`SELECT o.product_id AS product_id, COALESCE(SUM(c.amount),0) AS comissao, AVG(c.percent) AS pct
      FROM five_commissions c JOIN five_orders o ON o.order_id=c.order_id GROUP BY o.product_id`).all()).results || [];
    const monthly = (await env.DB.prepare(`SELECT product_id, strftime('%Y-%m', created_at, 'unixepoch') AS ym,
        COUNT(*) AS pedidos, SUM(CASE WHEN charge_status='PAID' THEN 1 ELSE 0 END) AS pagos,
        COALESCE(SUM(CASE WHEN charge_status='PAID' THEN charge_amount ELSE 0 END),0) AS receita
      FROM five_orders GROUP BY product_id, ym ORDER BY ym`).all()).results || [];
    const afil = (await env.DB.prepare(`SELECT o.product_id AS product_id, c.affiliate_id, a.name,
        COUNT(*) AS pedidos, COALESCE(SUM(c.amount),0) AS comissao
      FROM five_commissions c JOIN five_orders o ON o.order_id=c.order_id LEFT JOIN five_affiliates a ON a.affiliate_id=c.affiliate_id
      GROUP BY o.product_id, c.affiliate_id ORDER BY comissao DESC`).all()).results || [];

    const byId = {};
    for (const p of prods) byId[p.product_id] = { ...p, comissao: 0, comPct: null, offers: [], monthly: [], afiliados: [] };
    for (const o of offers) { const t = byId[o.product_id]; if (t) t.offers.push(o); }
    for (const c of comm) { const t = byId[c.product_id]; if (t) { t.comissao = c.comissao || 0; t.comPct = c.pct != null ? Math.round(c.pct) : null; } }
    for (const m of monthly) { const t = byId[m.product_id]; if (t) t.monthly.push(m); }
    for (const a of afil) { const t = byId[a.product_id]; if (t && t.afiliados.length < 6) t.afiliados.push(a); }
    try {
      await _ensureProductImages(env);
      const imgs = (await env.DB.prepare('SELECT product_id, image FROM product_images').all()).results || [];
      for (const im of imgs) { const t = byId[im.product_id]; if (t) t.image = im.image; }
    } catch (_) { /* imagem é opcional */ }
    const saida = Object.values(byId).map((p) => {
      if (_full) return p;
      const { comissao, comPct, afiliados, ...semDinheiro } = p;   // comissão e afiliado não são assunto do gestor
      return semDinheiro;
    });
    return json({ products: saida, escopo: _full ? 'full' : 'gestor' });
  } catch (e) { return json({ products: [], error: String((e && e.message) || e) }); }
}

// Imagem custom por produto (nossa, não da Five) — data URL guardada no D1.
async function _ensureProductImages(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS product_images (product_id TEXT PRIMARY KEY, image TEXT, updated_at INTEGER)').run();
}
async function handleProductImage(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Sem permissão', 403);
  await _ensureProductImages(env);
  const body = await req.json().catch(() => ({}));
  const id = body && body.id != null ? String(body.id) : '';
  if (!id) return err('id obrigatório');
  const image = body && typeof body.image === 'string' ? body.image : '';
  if (image === '') { await env.DB.prepare('DELETE FROM product_images WHERE product_id=?').bind(id).run(); return json({ ok: true, removed: true }); }
  if (image.length > 400000) return err('Imagem muito grande (máx ~300KB)');
  await env.DB.prepare(`INSERT INTO product_images (product_id, image, updated_at) VALUES (?,?,?)
    ON CONFLICT(product_id) DO UPDATE SET image=excluded.image, updated_at=excluded.updated_at`)
    .bind(id, image, Math.floor(Date.now() / 1000)).run();
  return json({ ok: true });
}

// ─── EQUIPE (fonte única de pessoas: produtor, sócio, vendedores, GT, cobrador) ───
async function _ensureTeamTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS team_members (
    id TEXT PRIMARY KEY,
    name TEXT,
    role TEXT,
    role_label TEXT,
    status TEXT,
    task TEXT,
    affiliate_id TEXT,
    is_you INTEGER DEFAULT 0,
    done INTEGER DEFAULT 0,
    sort INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`).run();
}
// A ETIQUETA DO AFILIADO NA URL DA PRESSEL (25/08/2026).
//
// PEDIDO DO BRUNO: "eu quero que esses links da URL publica sejam sempre diferentes pra eles nao
// ficarem iguais aos meus da minha dash principal (...) o da deles deve ser algo como
// https://painel-glico.fun/p/giovane/1".
//
// O id da pressel ja era global (o proximo numero sai do maior de TODAS), entao /p/3 do afiliado
// nunca foi /p/3 nosso - colisao de verdade nao havia. O que havia era pior de outro jeito: o link
// dele nascia no MESMO espaco de numeros que o nosso, sem nada dizendo de quem e, e a numeracao
// dele pulava buracos conforme a gente criasse pressel (ele criava a primeira dele e recebia /p/3).
// Agora cada afiliado tem a faixa dele: /p/<slug>/1, /p/<slug>/2... e o `n` e um contador SO dele,
// gravado na pressel no momento da criacao. Gravado, e nao calculado por posicao no array: se ele
// apagar a pressel 1, a 2 continua sendo a 2 e o anuncio que aponta pra ela nao vira outra pagina.
//
// O slug sai do nome e e gravado UMA VEZ em five_affiliates.slug. Renomear o afiliado depois NAO
// muda o slug de proposito: o link ja esta em anuncio pago, e trocar a URL derruba a campanha.
// O /p/<id> antigo continua respondendo pra todo mundo - link velho em anuncio nao pode morrer.
const _slugLivre = async (env, base, aflId) => {
  const raiz = _slug(base) || 'afiliado';
  // 'img' colidiria com /p/<id>/img/<hash>; so-digitos colidiria com o /p/<id> das nossas.
  const proibido = (t) => ['img', 'p', 'm', 'api', 'pc'].includes(t) || /^\d+$/.test(t);
  for (let i = 0; i < 50; i++) {
    const tent = i === 0 ? raiz : raiz + '-' + (i + 1);
    if (proibido(tent)) continue;
    const ja = await env.DB.prepare('SELECT affiliate_id FROM five_affiliates WHERE slug=? AND affiliate_id<>?')
      .bind(tent, String(aflId || '')).first().catch(() => null);
    if (!ja) return tent;
  }
  return 'afl-' + String(aflId || '').slice(-6);
};
async function _aflSlugDe(env, aflId) {
  if (!aflId) return '';
  try {
    // A COLUNA PODE NAO EXISTIR AINDA. Ela e criada no _ensureFiveTables, que NAO roda no caminho
    // de salvar pressel - foi assim que o slug voltou vazio no primeiro teste, sem erro nenhum na
    // tela. Mesmo remendo do users.afiliado_id: tenta ler, cria a coluna, tenta de novo.
    let r;
    try { r = await env.DB.prepare('SELECT slug, name FROM five_affiliates WHERE affiliate_id=?').bind(String(aflId)).first(); }
    catch (_) {
      try { await env.DB.prepare('ALTER TABLE five_affiliates ADD COLUMN slug TEXT').run(); } catch (_2) {}
      r = await env.DB.prepare('SELECT slug, name FROM five_affiliates WHERE affiliate_id=?').bind(String(aflId)).first();
    }
    if (!r) return '';
    if (r.slug) return String(r.slug);
    const novo = await _slugLivre(env, r.name || aflId, aflId);
    await env.DB.prepare('UPDATE five_affiliates SET slug=? WHERE affiliate_id=?').bind(novo, String(aflId)).run();
    return novo;
  } catch (_) { return ''; }
}
// Acha a pressel pelas DUAS formas de endereco: /p/<id> (a nossa, e todo link antigo) e
// /p/<slug>/<n> (a do afiliado). Devolve o objeto; quem chama passa a usar p.id daqui pra frente.
// O caminho publico da pressel: /p/<id> pra nossa, /p/<slug>/<n> pra de afiliado.
function _presselRefPub(p) {
  return (p && p.afl_slug && Number(p.num) > 0) ? (p.afl_slug + '/' + p.num) : String(p && p.id);
}
function _acharPressel(pressels, a, b) {
  const lista = Array.isArray(pressels) ? pressels : [];
  if (b == null || b === '') return lista.find((x) => x && String(x.id) === String(a)) || null;
  return lista.find((x) => x && String(x.afl_slug || '') === String(a) && String(x.num || '') === String(b)) || null;
}

const _slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || ('m' + Date.now());
// Seed inicial da equipe (exemplo) — vira a fonte única que todas as telas leem.
const _TEAM_SEED = [
  { id: 'bruno', name: 'Bruno', role: 'produtor', role_label: 'Produtor (você)', status: 'Online', task: 'Gestão e estratégia', is_you: 1, done: 48, sort: 1 },
  { id: 'socio', name: 'Sócio', role: 'socio', role_label: 'Sócio', status: 'Online', task: 'Estratégia e finanças', is_you: 0, done: 35, sort: 2 },
  { id: 'joao-vendas', name: 'João Vendas', role: 'vendedor', role_label: 'Vendedor', status: 'Online', task: 'Atendimento e fechamento', is_you: 0, done: 132, sort: 3 },
  { id: 'lucas-ads', name: 'Lucas Ads', role: 'vendedor', role_label: 'Vendedor', status: 'Em reunião', task: 'Follow-up de leads', is_you: 0, done: 98, sort: 4 },
  { id: 'maria-trafego', name: 'Maria Tráfego', role: 'gt', role_label: 'Gestor de tráfego', status: 'Ocupado', task: 'Campanhas no TikTok', is_you: 0, done: 64, sort: 5 },
  { id: 'carlos-cobranca', name: 'Carlos Cobrança', role: 'cobrador', role_label: 'Cobrador', status: 'Online', task: 'Recuperação de pedidos', is_you: 0, done: 72, sort: 6 },
];
async function _seedTeamIfEmpty(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM team_members').first();
  if (row && row.n > 0) return;
  const now = new Date().toISOString();
  for (const m of _TEAM_SEED) {
    await env.DB.prepare(`INSERT OR IGNORE INTO team_members (id,name,role,role_label,status,task,affiliate_id,is_you,done,sort,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(m.id, m.name, m.role, m.role_label, m.status, m.task, null, m.is_you, m.done, m.sort, now, now).run();
  }
}
async function handleTeam(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Sem permissão', 403);
  try {
    await _ensureTeamTable(env);
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const id = b.id || _slug(b.name);
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO team_members (id,name,role,role_label,status,task,affiliate_id,is_you,done,sort,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, role_label=excluded.role_label,
          status=excluded.status, task=excluded.task, affiliate_id=excluded.affiliate_id, is_you=excluded.is_you,
          done=excluded.done, sort=excluded.sort, updated_at=excluded.updated_at`)
        .bind(id, b.name || '', b.role || 'vendedor', b.role_label || '', b.status || 'Online', b.task || '', b.affiliate_id || null,
          b.is_you ? 1 : 0, Number(b.done) || 0, Number(b.sort) || 0, now, now).run();
      return json({ ok: true, id });
    }
    await _seedTeamIfEmpty(env);
    const rows = (await env.DB.prepare('SELECT * FROM team_members ORDER BY sort ASC, name ASC').all()).results || [];
    return json({ members: rows });
  } catch (e) { return json({ members: [], error: String((e && e.message) || e) }); }
}
async function handleTeamDelete(req, env, id) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Sem permissão', 403);
  try {
    await _ensureTeamTable(env);
    await env.DB.prepare('DELETE FROM team_members WHERE id=?').bind(id).run();
    return json({ ok: true });
  } catch (e) { return err(String((e && e.message) || e), 500); }
}

// Afiliados: GET lista com totais; POST nomeia/vincula ao nosso usuário (só diretor).
async function handleFiveAffiliates(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Sem permissão', 403);
  await _ensureFiveTables(env);
  if (req.method === 'POST') {
    const b = await req.json().catch(() => null);
    if (!b || !b.affiliate_id) return err('affiliate_id obrigatório');
    await env.DB.prepare(`INSERT INTO five_affiliates (affiliate_id, tenant, name, our_user_id, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(affiliate_id) DO UPDATE SET name=excluded.name, our_user_id=excluded.our_user_id`)
      .bind(b.affiliate_id, b.tenant || null, b.name || null, b.our_user_id || null, Math.floor(Date.now() / 1000)).run();
    return json({ ok: true });
  }
  const rows = (await env.DB.prepare(`SELECT a.affiliate_id, a.name, a.our_user_id, a.tenant,
     COUNT(c.order_id) AS pedidos, COALESCE(SUM(c.amount),0) AS comissao_total
     FROM five_affiliates a LEFT JOIN five_commissions c ON c.affiliate_id=a.affiliate_id
     GROUP BY a.affiliate_id ORDER BY comissao_total DESC`).all()).results || [];
  return json({ affiliates: rows });
}

// -- AFILIADOS ---------------------------------------------------------------
//
// Area propria pedida pelo Bruno em 23/08/2026: "toda a nossa dash que a gente ja tem hoje continua
// do jeito que esta; tudo que tem a ver com afiliado fica separado nesse acordeao". Por isso estes
// endpoints sao NOVOS e nao mexem em nenhum calculo do produtor.
//
// DE ONDE VEM O NUMERO (importa entender, senao alguem vai "consertar" um zero que e verdade):
//   - QUEM e o afiliado: five_affiliates. A Five preenche sozinha quando manda commissions[], e o
//     Bruno tambem cadastra na mao (origem='manual') pra ja ter a lista antes da Five ligar.
//   - QUANTO vendeu / comissionou: five_commissions X five_orders. Hoje a Five NAO manda
//     commissions[] (conferido em 23/08/2026: 36 pedidos, campo vazio em todos), entao estes numeros
//     saem 0 de verdade. O campo `five_ligada` na resposta diz isso pra tela ser honesta em vez de
//     mostrar zero como se fosse resultado ruim.
//   - QUANTO ja foi pago: afiliado_pagamentos, digitado por ele.
//
// REGRA DE COMISSAO (a mesma do resto da dash, ver handleFiveSummary): comissao existe sobre o que o
// cliente PAGOU. charge_status='PAID'. Pedido nao pago nao gera comissao devida.
const _AFIL_PAGO = "o.charge_status='PAID'";

const _afilId = () => 'afl_' + Math.random().toString(16).slice(2, 10);

// ACESSO DO AFILIADO (23/08/2026). O Bruno pediu: "na hora que eu cadastrar ele, automaticamente ja
// gera um login para ele acessar a nossa dash na versao de afiliado dele".
//
// A senha e mostrada UMA VEZ, na resposta do cadastro, e nunca mais: o banco guarda so o hash, igual
// a de qualquer usuario. Se ele perder, o caminho e gerar outra (botao "Novo acesso"), nao consultar
// a antiga. Guardar senha legivel pra poder reexibir seria a pior troca possivel aqui.
const _afilSlug = (nome) => String(nome || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 20) || 'afiliado';

// Sem I/l/0/O de proposito: essa senha vai ser DITADA no WhatsApp ou lida de um print, e o par
// I/l e o 0/O sao exatamente onde a pessoa erra e volta dizendo que a dash nao aceita.
const _afilSenha = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  for (const b of buf) out += abc[b % abc.length];
  return out;
};

// Cria (ou refaz) o usuario de um afiliado. Devolve { login, senha } pra tela mostrar uma vez so.
async function _afilCriarAcesso(env, affiliateId, nome, loginDesejado) {
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN afiliado_id TEXT').run(); } catch (_) {}
  const senha = _afilSenha();
  const hash = await sha256Hex(senha);
  const jaTem = await env.DB.prepare("SELECT id, login FROM users WHERE afiliado_id=? AND role='afiliado'").bind(affiliateId).first();
  if (jaTem) {
    // Ja existe: isto e "gerar nova senha", nao criar outro usuario. Criar um segundo login pro
    // mesmo afiliado deixaria dois donos pro mesmo mundo e ninguem saberia qual vale.
    await env.DB.prepare('UPDATE users SET pwd_hash=?, name=? WHERE id=?').bind(hash, nome, jaTem.id).run();
    return { login: jaTem.login, senha, id: jaTem.id, novo: false };
  }
  // Login unico: tenta o nome, depois nome.2, nome.3... Um afiliado homonimo nao pode roubar o
  // login do outro nem fazer o cadastro falhar calado.
  const base = _afilSlug(loginDesejado || nome);
  let login = base;
  for (let i = 2; i < 40; i++) {
    const dup = await env.DB.prepare('SELECT id FROM users WHERE lower(login)=?').bind(login).first();
    if (!dup) break;
    login = base + '.' + i;
  }
  const id = 'afiliado_' + Math.random().toString(36).slice(2, 8);
  const abbr = String(nome || 'AF').trim().split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase() || 'AF';
  await env.DB.prepare('INSERT INTO users (id, login, pwd_hash, name, abbr, role, com_pct, salario, afiliado_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, login, hash, nome, abbr, 'afiliado', 0, 0, affiliateId).run();
  return { login, senha, id, novo: true };
}
const _afilTexto = (v, max) => { const t = String(v == null ? '' : v).trim(); return t ? t.slice(0, max || 200) : null; };

// Uma consulta so com tudo que a tela precisa por afiliado: cadastro + venda + comissao + pago.
async function handleAfiliados(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Nao autenticado', 401);
  if (!isDirector(u)) return err('Sem permissao', 403);
  await _ensureFiveTables(env);
  try {
    const qLista = env.DB.prepare('SELECT a.affiliate_id AS id, a.name AS nome, a.phone AS telefone, a.doc,' +
      " a.pix, a.pct, COALESCE(a.status,'ativo') AS status, a.obs, a.our_user_id, a.tenant," +
      " COALESCE(a.origem, CASE WHEN a.affiliate_id LIKE 'afl_%' THEN 'manual' ELSE 'five' END) AS origem," +
      ' a.created_at,' +
      ' COUNT(DISTINCT c.order_id) AS pedidos,' +
      ' COUNT(DISTINCT CASE WHEN ' + _AFIL_PAGO + ' THEN c.order_id END) AS pedidos_pagos,' +
      ' COALESCE(SUM(CASE WHEN ' + _AFIL_PAGO + ' THEN o.charge_amount ELSE 0 END),0) AS vendas,' +
      ' COALESCE(SUM(CASE WHEN ' + _AFIL_PAGO + ' THEN c.amount ELSE 0 END),0) AS comissao' +
      ' FROM five_affiliates a' +
      ' LEFT JOIN five_commissions c ON c.affiliate_id = a.affiliate_id' +
      ' LEFT JOIN five_orders o ON o.order_id = c.order_id' +
      ' GROUP BY a.affiliate_id').all();
    const qPagos = env.DB.prepare('SELECT affiliate_id, COALESCE(SUM(valor),0) AS pago, COUNT(*) AS n FROM afiliado_pagamentos GROUP BY affiliate_id').all();
    // A Five ja mandou comissao alguma vez? E o que separa "ninguem vendeu" de "a integracao ainda
    // nao manda esse dado". A tela escreve coisas diferentes pros dois casos.
    const qLigada = env.DB.prepare('SELECT COUNT(*) AS n FROM five_commissions').first();
    // Quem ja tem login na dash de afiliado, pra tela nao oferecer "criar acesso" pra quem ja tem.
    const qAcessos = env.DB.prepare("SELECT afiliado_id, login FROM users WHERE role='afiliado' AND afiliado_id IS NOT NULL").all();
    // Tamanho do time de cada afiliado. Eles ficam isolados, mas o Bruno continua acompanhando
    // daqui - e este e o unico lugar onde a equipe deles aparece pra ele.
    const qEquipes = env.DB.prepare("SELECT afiliado_id, COUNT(*) AS n FROM users WHERE afiliado_id IS NOT NULL AND role <> 'afiliado' AND COALESCE(archived,0)=0 GROUP BY afiliado_id").all();
    const [rLista, rPagos, rLigada, rAcessos, rEquipes] = await Promise.all([qLista, qPagos, qLigada, qAcessos, qEquipes]);
    const equipePor = {};
    for (const r of (rEquipes && rEquipes.results) || []) equipePor[r.afiliado_id] = Number(r.n) || 0;
    const loginPor = {};
    for (const r of (rAcessos && rAcessos.results) || []) loginPor[r.afiliado_id] = r.login;

    const pagoPor = {};
    for (const r of (rPagos && rPagos.results) || []) pagoPor[r.affiliate_id] = { pago: Number(r.pago) || 0, n: Number(r.n) || 0 };

    const afiliados = ((rLista && rLista.results) || []).map((r) => {
      const pg = pagoPor[r.id] || { pago: 0, n: 0 };
      const comissao = Number(r.comissao) || 0;
      return Object.assign({}, r, {
        pct: r.pct == null ? null : Number(r.pct),
        vendas: Number(r.vendas) || 0,
        comissao: comissao,
        pago: pg.pago,
        pagamentos: pg.n,
        login: loginPor[r.id] || null,
        equipe: equipePor[r.id] || 0,
        // A PAGAR nunca fica negativo: se ele adiantou mais do que devia, isso e credito e nao
        // "divida negativa". Mostrar -R$ 200 na coluna "a pagar" so confunde na hora de acertar.
        a_pagar: Math.max(0, comissao - pg.pago),
      });
    }).sort((x, y) => (y.comissao - x.comissao) || String(x.nome || '').localeCompare(String(y.nome || '')));

    const soma = (f) => afiliados.reduce((t, a) => t + (Number(f(a)) || 0), 0);
    return json({
      afiliados: afiliados,
      five_ligada: !!(rLigada && Number(rLigada.n) > 0),
      totais: {
        afiliados: afiliados.length,
        ativos: afiliados.filter((a) => a.status === 'ativo').length,
        pedidos: soma((a) => a.pedidos_pagos),
        vendas: soma((a) => a.vendas),
        comissao: soma((a) => a.comissao),
        pago: soma((a) => a.pago),
        a_pagar: soma((a) => a.a_pagar),
      },
    });
  } catch (e) { return err('Falha ao ler afiliados: ' + String((e && e.message) || e), 500); }
}

// Criar ou editar. Sem `id` cria um afiliado manual; com `id` edita (inclusive um que veio da Five,
// pra ele poder por o contato e o Pix de quem a Five so mandou o nome).
async function handleAfiliadoSalvar(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Nao autenticado', 401);
  if (!isDirector(u)) return err('Sem permissao', 403);
  const b = await req.json().catch(() => null);
  if (!b) return err('Corpo invalido');
  const nome = _afilTexto(b.nome || b.name, 120);
  if (!nome) return err('O nome do afiliado e obrigatorio');
  await _ensureFiveTables(env);
  const idInformado = _afilTexto(b.id, 80);
  const id = idInformado || _afilId();
  const novo = !idInformado;
  const pct = (b.pct === '' || b.pct == null) ? null : Math.max(0, Math.min(100, Number(b.pct) || 0));
  const status = b.status === 'pausado' ? 'pausado' : 'ativo';
  const agora = Math.floor(Date.now() / 1000);
  try {
    // Um UPSERT so pros dois casos. O created_at nao entra no UPDATE de proposito: editar um
    // afiliado nao pode fazer ele "nascer" hoje e sumir da ordem de entrada.
    await env.DB.prepare('INSERT INTO five_affiliates' +
      ' (affiliate_id, tenant, name, our_user_id, phone, doc, pix, pct, status, obs, origem, created_at, updated_at)' +
      ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)' +
      ' ON CONFLICT(affiliate_id) DO UPDATE SET' +
      ' name=excluded.name, our_user_id=excluded.our_user_id, phone=excluded.phone, doc=excluded.doc,' +
      ' pix=excluded.pix, pct=excluded.pct, status=excluded.status, obs=excluded.obs,' +
      ' updated_at=excluded.updated_at')
      .bind(id, _afilTexto(b.tenant, 80), nome, _afilTexto(b.our_user_id, 80), _afilTexto(b.telefone || b.phone, 40),
            _afilTexto(b.doc, 40), _afilTexto(b.pix, 140), pct, status, _afilTexto(b.obs, 500),
            novo ? 'manual' : (_afilTexto(b.origem, 20) || 'five'), agora, agora).run();
    // ACESSO AUTOMATICO no cadastro novo. Sai desligado no update: reeditar o telefone de um
    // afiliado nao pode trocar a senha dele por acidente.
    let acesso = null;
    if (novo && b.criar_login !== false) {
      try { acesso = await _afilCriarAcesso(env, id, nome, b.login); }
      catch (e2) {
        // O afiliado esta cadastrado; so o login falhou. Devolver erro aqui apagaria o cadastro da
        // tela e ele digitaria tudo de novo. Melhor: cadastro salvo + aviso, e o botao "Novo acesso"
        // resolve depois.
        return json({ ok: true, id: id, acesso: null, acesso_erro: String((e2 && e2.message) || e2) });
      }
    }
    // A COMISSAO TEM UMA VERDADE SO (25/08/2026). O percentual mora em five_affiliates.pct (o que o
    // Bruno edita na area de Afiliados), mas varias telas leem users.com_pct do usuario dele - e as
    // duas ficavam divergindo: ele atualizou pra 65% aqui e a tela de Produtos continuou mostrando
    // 55%, que era o valor velho no cadastro de usuario. Agora salvar aqui espelha no usuario.
    // O caminho contrario (editar pela Lista de Usuarios) espelha de volta, logo abaixo.
    if (pct != null) {
      try { await env.DB.prepare("UPDATE users SET com_pct=? WHERE afiliado_id=? AND role='afiliado'").bind(pct, id).run(); } catch (_) {}
    }
    return json({ ok: true, id: id, acesso: acesso });
  } catch (e) { return err('Falha ao salvar: ' + String((e && e.message) || e), 500); }
}

// Gerar acesso pra um afiliado que ainda nao tem (ou trocar a senha do que tem). Devolve a senha
// uma vez so.
async function handleAfiliadoAcesso(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Nao autenticado', 401);
  if (!isDirector(u)) return err('Sem permissao', 403);
  const b = await req.json().catch(() => null);
  const id = b && _afilTexto(b.id, 80);
  if (!id) return err('id obrigatorio');
  await _ensureFiveTables(env);
  const a = await env.DB.prepare('SELECT name FROM five_affiliates WHERE affiliate_id=?').bind(id).first();
  if (!a) return err('Afiliado nao encontrado', 404);
  try {
    const acesso = await _afilCriarAcesso(env, id, a.name || 'Afiliado', b.login);
    return json({ ok: true, acesso: acesso });
  } catch (e) { return err('Falha ao gerar acesso: ' + String((e && e.message) || e), 500); }
}

// Remover. So sai da lista quem NAO tem pedido nem pagamento: apagar um afiliado com comissao
// lancada deixaria a comissao orfa e o total do mes mudaria sozinho. Nesse caso a saida e pausar.
async function handleAfiliadoRemover(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Nao autenticado', 401);
  if (!isDirector(u)) return err('Sem permissao', 403);
  const b = await req.json().catch(() => null);
  const id = b && _afilTexto(b.id, 80);
  if (!id) return err('id obrigatorio');
  await _ensureFiveTables(env);
  try {
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM five_commissions WHERE affiliate_id=?').bind(id).first();
    if (c && Number(c.n) > 0) return err('Este afiliado ja tem ' + c.n + ' comissao(oes) lancada(s). Pause ele em vez de remover, senao a comissao fica sem dono.', 409);
    const pg = await env.DB.prepare('SELECT COUNT(*) AS n FROM afiliado_pagamentos WHERE affiliate_id=?').bind(id).first();
    if (pg && Number(pg.n) > 0) return err('Este afiliado tem ' + pg.n + ' pagamento(s) registrado(s). Pause ele em vez de remover.', 409);
    await env.DB.prepare('DELETE FROM five_affiliates WHERE affiliate_id=?').bind(id).run();
    // O LOGIN VAI JUNTO. Sem isto, remover o afiliado tirava ele da lista mas deixava a conta dele
    // VIVA: ele continuaria entrando na dash de afiliado normalmente, so que invisivel pro Bruno,
    // que acabou de ver "removido" na tela. A sessao aberta tambem cai (o authUser faz JOIN em
    // users, entao sem a linha o token para de valer na hora).
    try {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE afiliado_id=?)").bind(id).run();
      await env.DB.prepare('DELETE FROM users WHERE afiliado_id=?').bind(id).run();
    } catch (_) {}
    return json({ ok: true });
  } catch (e) { return err('Falha ao remover: ' + String((e && e.message) || e), 500); }
}

// Pagamentos feitos a afiliado: listar, registrar e apagar.
async function handleAfiliadoPagamentos(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Nao autenticado', 401);
  if (!isDirector(u)) return err('Sem permissao', 403);
  await _ensureFiveTables(env);
  if (req.method === 'POST') {
    const b = await req.json().catch(() => null);
    if (!b) return err('Corpo invalido');
    const id = _afilTexto(b.affiliate_id || b.id, 80);
    const valor = Number(b.valor);
    if (!id) return err('Escolha o afiliado');
    if (!(valor > 0)) return err('O valor precisa ser maior que zero');
    try {
      await env.DB.prepare('INSERT INTO afiliado_pagamentos (id, affiliate_id, valor, data, metodo, obs, criado_por, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind('pag_' + Math.random().toString(16).slice(2, 10), id, valor,
              _afilTexto(b.data, 20) || new Date().toISOString().slice(0, 10),
              _afilTexto(b.metodo, 40) || 'Pix', _afilTexto(b.obs, 300), String(u.id || u.login || ''), Math.floor(Date.now() / 1000)).run();
      return json({ ok: true });
    } catch (e) { return err('Falha ao registrar: ' + String((e && e.message) || e), 500); }
  }
  if (req.method === 'DELETE') {
    const b = await req.json().catch(() => null);
    const pid = b && _afilTexto(b.id, 80);
    if (!pid) return err('id obrigatorio');
    try { await env.DB.prepare('DELETE FROM afiliado_pagamentos WHERE id=?').bind(pid).run(); return json({ ok: true }); }
    catch (e) { return err('Falha ao apagar: ' + String((e && e.message) || e), 500); }
  }
  try {
    const rows = (await env.DB.prepare('SELECT p.*, a.name AS afiliado_nome FROM afiliado_pagamentos p' +
      ' LEFT JOIN five_affiliates a ON a.affiliate_id=p.affiliate_id' +
      ' ORDER BY p.data DESC, p.created_at DESC LIMIT 300').all()).results || [];
    return json({ pagamentos: rows });
  } catch (e) { return err('Falha ao ler pagamentos: ' + String((e && e.message) || e), 500); }
}

// LINK DE CHECKOUT POR KIT, POR AFILIADO (25/08/2026).
//
// COMO O BRUNO DESCREVEU: cada afiliado tem os links de checkout DELE na Payt, um por kit e por
// modalidade (antecipado x pagamento na entrega). Ele abre o kit em Produtos, clica em "Link de
// checkout" e cola os dois. Quando ele cadastra um pedido daquele kit, o lead ja nasce com o link
// certo, e e esse link que aparece no card - o mesmo que ele configurou aqui.
//
// Onde mora: data.afl_checkout = { <affiliate_id>: { <id do kit>: { antecipado, entrega } } }.
// Endpoint proprio, e nao o POST /api/state generico, pelo mesmo motivo das outras chaves com dono:
// assim o afiliado escreve SO o galho dele e nunca reescreve o mapa inteiro.
async function handleAfiliadoCheckout(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Nao autenticado', 401);
  if (afiliadoSemVinculo(u)) return err('Sem permissao', 403);
  const meu = isAfiliado(u) ? aflDe(u) : null;
  if (!isDirector(u) && !meu) return err('Sem permissao', 403);

  if (req.method === 'GET') {
    const data = await _getDashData(env).catch(() => ({}));
    const todos = (data && data.afl_checkout) || {};
    // O afiliado le so o galho dele; o diretor pode pedir o de um especifico ou o mapa inteiro.
    if (meu) return json({ ok: true, checkout: { [meu]: todos[meu] || {} } });
    const q = String(new URL(req.url).searchParams.get('afiliado') || '').trim();
    return json({ ok: true, checkout: q ? { [q]: todos[q] || {} } : todos });
  }

  const b = await req.json().catch(() => null);
  if (!b) return err('Corpo invalido');
  // O diretor pode gravar pra um afiliado (mandando `afiliado`); o afiliado sempre grava no dele.
  const alvo = meu || String(b.afiliado || '').trim();
  if (!alvo) return err('Informe o afiliado');
  const kit = String(b.kit || '').trim();
  if (!kit) return err('Informe o kit');
  const limpaUrl = (v) => {
    const t = String(v == null ? '' : v).trim();
    if (!t) return '';
    // So http(s). Sem isto daria pra guardar javascript: e o link acabaria clicavel na tela.
    if (!/^https?:\/\//i.test(t)) return null;
    return t.slice(0, 600);
  };
  const ant = limpaUrl(b.antecipado);
  const ent = limpaUrl(b.entrega);
  if (ant === null || ent === null) return err('O link precisa comecar com http:// ou https://');

  for (let tent = 0; tent < 6; tent++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado nao encontrado', 404);
    let data; try { data = JSON.parse(row.data); } catch (_) { return err('Estado invalido', 500); }
    if (!data.afl_checkout || typeof data.afl_checkout !== 'object') data.afl_checkout = {};
    if (!data.afl_checkout[alvo] || typeof data.afl_checkout[alvo] !== 'object') data.afl_checkout[alvo] = {};
    if (!ant && !ent) delete data.afl_checkout[alvo][kit];
    else data.afl_checkout[alvo][kit] = { antecipado: ant, entrega: ent };
    const nv = (row.version || 0) + 1;
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), nv, Math.floor(Date.now() / 1000), 'checkout:' + String(u.id), row.version).run();
    if (res && res.meta && res.meta.changes > 0) return json({ ok: true, version: nv });
  }
  return err('Conflito ao salvar. Tente de novo.', 409);
}

// Qual link vale pra este lead: o do afiliado dele, no kit e na modalidade do pedido.
// Sem configuracao, devolve '' e o card cai no checkout padrao da Five, como sempre foi.
function _linkCheckoutDoLead(data, lead) {
  try {
    const afl = String((lead && lead.afl) || '');
    if (!afl) return '';
    const mapa = ((data && data.afl_checkout) || {})[afl] || {};
    const kits = ((data && data.regras) || {}).kits || [];
    // Casa o kit pelo id da oferta ou pelo nome do tratamento, normalizado (a Five manda
    // "GlicoSix - 4 Meses" sem espaco e o cadastro tem "Glico Six - 4 Meses").
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const alvo = norm(lead && (lead.trat || lead.prod));
    let chave = null;
    for (const k of kits) {
      const id = String(k.offer_id || k.id || '');
      if (id && mapa[id] && (norm(k.nome) === alvo || norm(k.id) === norm(lead && lead.offer_id))) { chave = id; break; }
    }
    if (!chave) for (const id of Object.keys(mapa)) { if (norm(id) === alvo) { chave = id; break; } }
    if (!chave) return '';
    const cfg = mapa[chave] || {};
    const ant = String((lead && lead.mod) || '').toLowerCase() === 'antecipado';
    return String((ant ? cfg.antecipado : cfg.entrega) || cfg.entrega || cfg.antecipado || '');
  } catch (_) { return ''; }
}

// Pedidos que vieram POR AFILIADO. Alimenta o Kanban e a tela de logistica do acordeao. So pedido
// com comissao de afiliado entra aqui - e o que faz dele "pedido de afiliado" e nao pedido nosso.
async function handleAfiliadoPedidos(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Nao autenticado', 401);
  if (!isDirector(u)) return err('Sem permissao', 403);
  await _ensureFiveTables(env);
  try {
    const rows = (await env.DB.prepare('SELECT o.order_id, o.customer_name, o.customer_phone, o.customer_address,' +
      ' o.product_name, o.offer_id, o.offer_title, o.offer_price, o.offer_qty, o.charge_status, o.charge_amount, o.charge_method,' +
      ' o.shipping_status, o.shipping_code, o.shipping_core_id, o.shipping_platform, o.last_status,' +
      ' o.created_at, o.updated_at, o.devolucao_id,' +
      ' c.affiliate_id, c.amount AS comissao, c.percent AS pct,' +
      ' a.name AS afiliado_nome' +
      ' FROM five_commissions c' +
      ' JOIN five_orders o ON o.order_id = c.order_id' +
      ' LEFT JOIN five_affiliates a ON a.affiliate_id = c.affiliate_id' +
      ' ORDER BY o.created_at DESC LIMIT 500').all()).results || [];
    return json({ pedidos: rows });
  } catch (e) { return err('Falha ao ler pedidos: ' + String((e && e.message) || e), 500); }
}

// ── QUEM VE / QUEM ESCREVE O BLOB DA EMPRESA (/api/state) ────────────────────
//
// O endpoint entregava o blob INTEIRO pra qualquer login e aceitava o blob inteiro de volta. Numa
// operacao com gente de fora (o gestor de trafego e contratado) isso quer dizer: os 123 lancamentos
// de gasto, o extrato do ContaSimples, os cartoes, a margem por kit, o custo do frasco e - o pior -
// `regras.fixos`, que e a FOLHA SALARIAL nominal ("Salario - Thiago, R$ 2.400"). A dash escondia as
// telas, mas a rota entregava tudo pra quem pedisse com o token dela.
//
// Duas listas, porque sao dois problemas diferentes:
// OCULTO   = nao sai no GET pra quem nao e diretor (dinheiro e segredo de operacao).
// SO_DIR   = nao entra pelo POST de quem nao e diretor. Isso vale para o OCULTO inteiro (senao a
//            primeira gravacao de uma tela permitida - aparencia, pressel - salvava de volta um blob
//            SEM as chaves que ele nunca recebeu, e apagava a empresa) e vale tambem pra acl_v2, que
//            e a matriz de permissao: sem isso um vendedor se promovia a diretor com um POST.
// cs_ok / cs_motivos / cats_despesa entraram em 24/08/2026 com a curadoria de gastos do cartao.
// PRECISAM estar aqui: quem esta no STATE_OCULTO tambem entra no STATE_SO_DIRETOR_ESCREVE, e e
// isso que faz o _stateProtegido devolver a chave do banco quando um cargo restrito salva o
// estado. Sem isso o primeiro POST do gestor (ele grava Registros de Trafego pelo /api/state com
// o blob inteiro) apagaria as decisoes de despesa em silencio, e o lucro pularia sozinho.
const STATE_OCULTO = ['gastos','entradas','saidas','aportes','nextAporte','invest','invCats','nextInv','payouts','nextPayout','fechamentos','caixaPlat','caixaPlatUpd','cs_cards','payt_debug','lancamentos','proConfig','demConfig','trafego_aloc','nextGasto','nextEntrada','nextSaida','cs_ok','cs_motivos','cats_despesa','doms_off'];
const STATE_SO_DIRETOR_ESCREVE = STATE_OCULTO.concat(['acl_v2','regras','custos','custos_produtor']);
// CHAVES QUE NINGUEM GRAVA POR ESTE CAMINHO. Cada uma tem endpoint proprio, com gate proprio:
// chips e pressels vao por /api/pressel/save e /api/chip/save, o Sale Chat por /api/salechat/save.
// Deixa-las passar no POST /api/state generico e dar a qualquer login uma porta lateral pra
// reescrever a roleta, a pressel e o roteiro de venda inteiro. Vale pra TODO cargo, diretor
// inclusive: se um dia uma tela precisar gravar por aqui, o certo e ela usar o endpoint dela.
const STATE_NUNCA_POR_AQUI = ['chips', 'pressels', 'salechat', 'salechatPub', 'salechatCob', 'salechatCobPub', 'scVend', 'scVendPub'];

// Cargo que so toca campanha: nao trabalha pedido nenhum, entao nao ve nem custo de produto.
// (O gestor de trafego e contratado de fora; designer idem.)
const ROLE_SO_CAMPANHA = ['gestor', 'designer'];

// O que o GET devolve pra quem nao e diretor.
async function _stateVisivel(u, data, env) {
  if (isDirector(u)) return data;
  // Ids do mundo do afiliado, pra filtrar o Sale Chat por pessoa. So consulta quando e o caso.
  const _idsMundo = (env && (noMundoAfiliado(u) || afiliadoSemVinculo(u))) ? await _idsDoMundoAfiliado(env, aflDe(u)) : [];
  const d = { ...data };
  for (const k of STATE_OCULTO) delete d[k];
  const soCampanha = ROLE_SO_CAMPANHA.includes(String(u && u.role || ''));
  // `regras` guarda duas coisas muito diferentes no mesmo lugar: o custo do produto (que o vendedor
  // PRECISA ver - a tela "Analise por vendedor" e liberada pra ele justamente pra mostrar o lucro
  // por pedido) e `fixos`, que e a FOLHA nominal ("Salario - Thiago"). Sai a folha, fica o resto.
  // Quem so toca campanha nao precisa de nenhum dos dois: leva so o catalogo de kits.
  if (d.regras && typeof d.regras === 'object') {
    if (soCampanha) d.regras = { kits: Array.isArray(d.regras.kits) ? d.regras.kits : [] };
    else { const { fixos, ...semFolha } = d.regras; d.regras = semFolha; }
  }
  if (soCampanha) {
    delete d.custos_produtor; delete d.custos;
    // DADO DE CLIENTE TAMBEM NAO. A poda cuidou do dinheiro e esqueceu o cliente: o gestor de
    // trafego, que e contratado de FORA, recebia nome, CPF, telefone e endereco de cada lead dentro
    // do blob. As telas dele (Dashboard de Trafego e Meu Painel) so usam a CONTAGEM e a data - o
    // gastoTs le apenas o campo `data`. Entao o lead vai reduzido ao minimo que faz as telas dele
    // funcionarem, e nada mais.
    // `afl` VAI JUNTO. A poda de campanha reduz o lead ao minimo, e onze linhas abaixo o corte do
    // afiliado exige l.afl === o dele: sem esta chave, o gestor de trafego DELE ficava com leads
    // sempre vazio e o Dashboard mostrava "0 pedidos" com "N pagos" logo abaixo, se contradizendo.
    // Preservar nao abre nada: `afl` e um id opaco, sem nome, CPF, telefone ou endereco.
    if (Array.isArray(d.leads)) d.leads = d.leads.map((l) => ({ id: l && l.id, data: l && l.data, ts: l && l.ts, afl: l && l.afl }));
    d.clientes = [];
    d.vendas = [];
  }
  // O MUNDO DO AFILIADO. Ele e de fora: leva os pedidos DELE e nada da nossa operacao.
  //
  // LISTA BRANCA, E NAO LISTA NEGRA (25/08/2026). Ate hoje isto era "apague o que e nosso", e o
  // Bruno perguntou se podia confiar. Varri as 92 rotas e o blob inteiro: continuavam passando as
  // FOTOS da nossa equipe (37 KB), a matriz de permissao de TODOS os cargos, os mapeamentos da
  // Payt e do fornecedor. Nenhum deles estava na lista de apagar - e nunca estaria, porque lista
  // negra so cobre o que alguem lembrou de escrever.
  // Invertido: ele recebe SO o que esta em CHAVES_DO_AFILIADO. Chave nova no blob (hoje ou daqui a
  // seis meses) nasce INVISIVEL pra ele por padrao, e so aparece se alguem decidir e escrever aqui.
  // Quem mexer: acrescentar chave nesta lista e uma decisao de exposicao. Pense antes.
  //
  // O corte dos pedidos e por `lead.afl`, carimbado pelo webhook da Five e NAO editavel pelo
  // /api/lead - e o que impede um afiliado de se dar de presente o pedido dos outros.
  if (noMundoAfiliado(u) || afiliadoSemVinculo(u)) {
    const meuAfl = aflDe(u);
    // Sem vinculo, meuAfl e null e nenhum lead casa: a lista sai vazia, que e o certo.
    if (Array.isArray(d.leads)) d.leads = d.leads.filter((l) => l && meuAfl && String(l.afl || '') === meuAfl);
    // Base de clientes e vendas sao da NOSSA operacao inteira; ele reconstroi a parte dele pelos
    // proprios leads. Mandar a lista completa e podar depois seria facil de esquecer.
    d.clientes = [];
    d.vendas = [];
    // Custo do nosso produto, margem por kit e regras de custo sao segredo de operacao: e o que ele
    // usaria pra saber exatamente quanto a gente ganha em cima dele. Fica so o catalogo de kits,
    // que ele precisa pra reconhecer o que foi vendido.
    delete d.custos_produtor; delete d.custos;
    if (d.regras && typeof d.regras === 'object') d.regras = { kits: Array.isArray(d.regras.kits) ? d.regras.kits : [] };
    // PRESSEL E ROLETA DELE, SIM (24/08/2026). Cada pressel e cada chip tem dono (`afl`); ele leva
    // os dele e nunca os nossos. Um afiliado sem vinculo tem meuAfl null e nada casa: lista vazia.
    for (const k of ['pressels', 'chips']) {
      if (Array.isArray(d[k])) d[k] = d[k].filter((x) => x && meuAfl && String(x.afl || '') === meuAfl);
    }
    // SALE CHAT: O MODELO PADRAO FICA (24/08/2026, pedido do Bruno: "o nosso sale chat, que hoje ja
    // tem um funilzinho padrao ali de vendas, pode deixar"). Ele recebe o PUBLICADO (salechatPub),
    // que e o funil que roda de verdade, e usa como ponto de partida - do mesmo jeito que o vendedor
    // da casa herda o modelo. O RASCUNHO nosso (salechat) sai: e a nossa mesa de trabalho, com
    // versao pela metade. E o do cobrador nao e assunto dele.
    // Gravar continua indo pro slot dele (handleSaleChatSave escreve scVend[uid] pra quem nao e
    // diretor), entao ele nunca edita o nosso modelo - so a copia dele.
    // SALE CHAT VAZIO PRO AFILIADO (25/08/2026). Em 24/08 o Bruno mandou deixar o nosso funil
    // padrao como base; no dia seguinte ele reviu: "o certo e a gente separar as coisas; nao quero
    // que voce deixe meu funil, minhas mensagens, meus audios pra eles". Faz sentido: o roteiro e o
    // audio sao a voz da operacao dele, nao um template. Sai tudo que e nosso; ele comeca em branco
    // e monta o proprio, que vai pro slot dele (scVend[uid]) e chega por outro caminho.
    delete d.salechat; delete d.salechatPub; delete d.salechatCob; delete d.salechatCobPub;
    delete d.cs_cards;
    // GASTO DE TRAFEGO TEM DONO (24/08/2026). Eu tinha escrito `delete d.trafego`, mas a chave de
    // verdade e `trafego_registros` - entao a poda nao pegava nada e os NOSSOS 6 lancamentos de
    // anuncio (R$ 503,60 e companhia) estavam indo inteiros pro afiliado. Conferido ao vivo.
    //
    // Agora, em vez de apagar, RECORTA: o afiliado tem gestor de trafego proprio e precisa lancar e
    // ver o gasto DELE. Cada registro carrega `afl`; o nosso continua sem o campo.
    if (Array.isArray(d.trafego_registros)) {
      d.trafego_registros = d.trafego_registros.filter((r) => r && meuAfl && String(r.afl || '') === meuAfl);
    }
    // ESTOQUE E NOSSO (24/08/2026). O extrato de frascos (39 movimentos) estava indo inteiro pro
    // afiliado e virava a faixa "Estoque de frascos" na tela de Produtos dele. Estoque e logistica
    // da casa: quanto a gente tem em maos, quanto entrou e quanto saiu nao e conta dele.
    delete d.estoque_movs; delete d.estoque; delete d.nextEstoque;
    // NUNCA FORAM PODADAS (auditoria de 24/08/2026): o nosso investimento em midia lancado a mao,
    // as despesas recorrentes, as devolucoes e os snapshots viajavam item a item no GET pra todo o
    // mundo do afiliado. Nao apareciam em tela nenhuma dele - o que e pior, porque ninguem ia notar.
    delete d.midia_gasto; delete d.despesas_rec; delete d.devolucoes; delete d.snapshots;
    // A PODA FINAL, por lista branca. O que nao esta aqui nao chega nele.
    //   leads/clientes/vendas -> ja recortados acima, sao os pedidos DELE
    //   regras                -> so o catalogo de kits (a folha e o custo ja sairam acima)
    //   tags                  -> so as usadas nos pedidos dele (recortadas abaixo)
    //   wa_*                  -> configuracao de atendimento que a tela dele usa
    //   cont*                 -> contingencia DELE (o sufixo do mundo dele ja foi resolvido acima)
    //   scVend/scVendPub      -> Sale Chat por pessoa, ja filtrado ao mundo dele
    //   team                  -> derivado, ja escopado no handleGetState
    //   estoque_movs          -> NAO entra: e logistica da casa
    const CHAVES_DO_AFILIADO = new Set([
      'leads', 'clientes', 'vendas', 'regras', 'tags', 'team',
      'kb_cols', 'wa_statuses', 'contCols', 'contColColors', 'cont_col_order',
      'scVend', 'scVendPub', 'wa_ativo', 'wa_automacoes', 'wa_autom_on', 'wa_bot_on', 'funil_auto',
      'pressels', 'chips', 'trafego_registros', 'saques', 'notifs',
      'afl_checkout',
    ]);
    // ...mas so o galho DELE do mapa de checkout (o mapa tem um galho por afiliado).
    if (d.afl_checkout && typeof d.afl_checkout === 'object') {
      d.afl_checkout = meuAfl && d.afl_checkout[meuAfl] ? { [meuAfl]: d.afl_checkout[meuAfl] } : {};
    }
    for (const k of Object.keys(d)) if (!CHAVES_DO_AFILIADO.has(k)) delete d[k];
    // CONTINGENCIA DELE. Se ja tem as proprias, leva as dele; se ainda nao mexeu, leva uma COPIA
    // das nossas como ponto de partida (a organizacao que ja funciona), e o primeiro ajuste cria as
    // dele. As chaves com sufixo de OUTROS afiliados saem todas.
    for (const k of ['wa_statuses', 'contCols', 'contColColors', 'cont_col_order']) {
      const minha = d[k + '__' + meuAfl];
      if (minha !== undefined) d[k] = minha;
    }
    for (const k of Object.keys(d)) {
      if (/^(wa_statuses|contCols|contColColors|cont_col_order)__/.test(k)) delete d[k];
    }
    // TAGS: SO AS QUE APARECEM NOS PEDIDOS DELE. O catalogo de etiquetas do nosso CRM (VIP, Quente,
    // Frio, Recuperar, Fornecedor...) e leitura da nossa operacao: diz como a gente classifica
    // cliente. Mandar so as usadas nos leads dele mantem nome e cor certos no card, sem entregar o
    // catalogo. Este filtro roda DEPOIS do corte de d.leads, de proposito.
    if (Array.isArray(d.tags)) {
      const usadas = new Set();
      for (const l of (d.leads || [])) for (const t of ((l && l.tags) || [])) usadas.add(String(t));
      d.tags = d.tags.filter((t) => t && usadas.has(String(t.id)));
    }
    // O CATALOGO DELE VEM JUNTO (27/08/2026, pedido do Bruno: "gostaria que eles conseguissem
    // controlar ali as tags deles"). Ele guarda em tags__<afl>, igual as colunas da Contingencia.
    // As NOSSAS continuam fora - so sobrevivem as que ja estao marcadas num pedido dele, pra o card
    // nao perder nome e cor. Ele comeca com a lista vazia de proposito: nome de etiqueta nossa diz
    // como a gente classifica cliente, e isso nao e dele.
    {
      const _minhas = data['tags' + String(meuAfl ? ('__' + meuAfl) : '')];
      if (Array.isArray(_minhas) && meuAfl) {
        const jaTem = new Set((d.tags || []).map((t) => t && String(t.id)));
        d.tags = (d.tags || []).concat(_minhas.filter((t) => t && !jaTem.has(String(t.id))));
      }
    }
    // SALE CHAT DELE, SIM (24/08/2026). O roteiro por pessoa vive em scVend[<id do usuario>], entao
    // da pra entregar so os do mundo dele: o dele e o dos vendedores dele. O MODELO da casa
    // (salechat) continua fora - ele monta o proprio, nao herda o nosso.
    const _meus = new Set(_idsMundo || []);
    for (const k of ['scVend', 'scVendPub']) {
      const orig = d[k];
      if (orig && typeof orig === 'object') {
        const so = {};
        for (const uid of Object.keys(orig)) if (_meus.has(String(uid))) so[uid] = orig[uid];
        d[k] = so;
      }
    }
  }
  // saque e notificacao sao pessoais: cada um ve o seu (e o que e pra todo mundo).
  const meu = String(u && u.id || '');
  if (Array.isArray(d.saques)) d.saques = d.saques.filter((x) => String(x && (x.at || x.user_id || x.para) || '') === meu);
  // 'owner' e recado de dono (aprovar saque, alerta de caixa): nao vai pra quem nao e diretor.
  if (Array.isArray(d.notifs)) d.notifs = d.notifs.filter((x) => { const t = String(x && x.to || ''); return !t || t === meu || t === 'todos' || t === 'all'; });
  return d;
}

// O que o POST aceita de quem nao e diretor: o resto volta a valer o que ja estava no banco.
function _stateProtegido(u, novo, atual) {
  // As chaves com endpoint proprio voltam sempre do banco, pra qualquer cargo.
  if (novo && typeof novo === 'object') {
    novo = { ...novo };
    for (const k of STATE_NUNCA_POR_AQUI) {
      if (Object.prototype.hasOwnProperty.call(atual, k)) novo[k] = atual[k]; else delete novo[k];
    }
  }
  // QUEM RECEBE PODADO NAO PODE GRAVAR PODADO. O gestor recebe os leads reduzidos a {id,data,ts} e
  // TEM permissao de gravar (ele salva Registros de Trafego, que passam pelo /api/state com o blob
  // inteiro). Sem esta restauracao, o primeiro registro dele apagaria nome, CPF, telefone e endereco
  // de todo mundo em silencio - e a guarda anti-apagamento nao pegaria, porque a lista continua com
  // o mesmo TAMANHO, so vazia por dentro.
  if (novo && typeof novo === 'object' && ROLE_SO_CAMPANHA.includes(String(u && u.role || ''))) {
    novo = { ...novo };
    for (const k of ['leads', 'clientes', 'vendas']) {
      if (Object.prototype.hasOwnProperty.call(atual, k)) novo[k] = atual[k]; else delete novo[k];
    }
  }
  // MESMA REGRA PRO AFILIADO, e aqui ela e ainda mais critica: ele recebe SO os leads dele, entao um
  // POST inocente da tela dele reescreveria data.leads com a listinha curta e apagaria os pedidos de
  // todo mundo. A guarda anti-apagamento tambem nao pegaria isso sozinha em todos os casos.
  if (novo && typeof novo === 'object' && (noMundoAfiliado(u) || afiliadoSemVinculo(u))) {
    novo = { ...novo };
    // As chaves de contingencia entram aqui tambem: o afiliado RECEBE uma copia das nossas (pra ter
    // base), e sem esta restauracao o primeiro salvamento generico dele gravaria essa copia por
    // cima das NOSSAS. Quem grava as dele e o /api/cont/save, que usa o sufixo do mundo dele.
    for (const k of ['clientes', 'vendas', 'custos', 'custos_produtor', 'regras', 'cs_cards', 'estoque_movs', 'estoque', 'nextEstoque',
                     'midia_gasto', 'despesas_rec', 'devolucoes', 'snapshots', 'tags',
                     'wa_statuses', 'contCols', 'contColColors', 'cont_col_order', 'afl_checkout']) {
      if (Object.prototype.hasOwnProperty.call(atual, k)) novo[k] = atual[k]; else delete novo[k];
    }
    // GASTO DE TRAFEGO: aqui NAO da pra so restaurar do banco, senao o gestor de trafego dele nunca
    // conseguiria lancar nada (ele recebe so os registros dele e devolveria a lista curta, que
    // apagaria os nossos). Entao: MERGE. Ficam os nossos como estao, e entram os dele vindos da
    // tela, carimbados no dono. Registro que ele mandar sem ser dele simplesmente nao entra.
    const meuAfl = aflDe(u);
    const antigos = Array.isArray(atual.trafego_registros) ? atual.trafego_registros : [];
    const nossos = antigos.filter((r) => !r || String(r.afl || '') !== String(meuAfl || ''));
    const dele = (Array.isArray(novo.trafego_registros) ? novo.trafego_registros : [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({ ...r, afl: meuAfl }));
    novo.trafego_registros = meuAfl ? nossos.concat(dele) : antigos;

    // PEDIDO NOVO DELE PRECISA ENTRAR (auditoria de 24/08/2026). `leads` estava na lista de cima,
    // restaurada cega do banco: o botao "Novo Pedido" respondia 200, o toast dizia "cadastrado", a
    // version subia e o lead SUMIA. Pior tipo de defeito - o sistema mente que salvou.
    // Aqui e merge conservador: nada do banco e alterado por ele (nem coluna, nem valor, nem dono),
    // e da tela dele so entram ids que AINDA NAO EXISTEM, carimbados no mundo dele. Teto de 20 por
    // gravacao porque este caminho aceita array vindo do navegador e o blob tem teto de 1 MB.
    const leadsBanco = Array.isArray(atual.leads) ? atual.leads : [];
    if (meuAfl) {
      const idsBanco = new Set(leadsBanco.map((l) => String(l && l.id)));
      const novosDele = (Array.isArray(novo.leads) ? novo.leads : [])
        .filter((l) => l && typeof l === 'object' && !idsBanco.has(String(l.id)))
        .slice(0, 20)
        // JA NASCE COM O LINK DE CHECKOUT DELE. E o mesmo link que ele configurou por kit em
        // Produtos; o card do lead le `lead.link` e monta a URL com os dados do cliente
        // (checkoutPreenchido no orders.js), entao nao ha caminho novo pra manter.
        // So preenche quando ele NAO mandou link proprio no cadastro.
        .map((l) => {
          const novo = { ...l, afl: meuAfl };
          if (!String(novo.link || '').trim()) {
            const lk = _linkCheckoutDoLead(atual, novo);
            if (lk) novo.link = lk;
          }
          return novo;
        });
      novo.leads = leadsBanco.concat(novosDele);
    } else {
      novo.leads = leadsBanco;
    }
  }
  // `team` e DERIVADO (montado na leitura a partir da tabela users) e nunca deve ser gravado no
  // blob: se entrar, vira copia velha do cadastro e ainda come o teto de 1 MB. Vale pra todo cargo,
  // diretor inclusive - por isso sai antes do atalho de diretor.
  if (novo && typeof novo === 'object' && 'team' in novo) { novo = { ...novo }; delete novo.team; }
  if (isDirector(u)) return novo;
  const d = { ...novo };
  for (const k of STATE_SO_DIRETOR_ESCREVE) {
    if (Object.prototype.hasOwnProperty.call(atual, k)) d[k] = atual[k];
    else delete d[k];
  }
  // saques/notifs vem filtrados no GET, entao regravar direto apagaria os dos outros: mantem os
  // alheios e aceita so a parte que e da pessoa.
  const meu = String(u && u.id || '');
  const meuDono = (x) => String(x && (x.at || x.user_id || x.para) || '') === meu;
  if (Array.isArray(atual.saques)) d.saques = (atual.saques.filter((x) => !meuDono(x))).concat(Array.isArray(novo.saques) ? novo.saques.filter(meuDono) : []);
  if (Array.isArray(atual.notifs)) {
    const meuN = (x) => String(x && x.to || '') === meu;
    d.notifs = (atual.notifs.filter((x) => !meuN(x))).concat(Array.isArray(novo.notifs) ? novo.notifs.filter(meuN) : []);
  }
  return d;
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
  // QUEM E CADA VENDEDOR VAI JUNTO. O front tem um teamMapFrom(state) que le `state.team` pra
  // mostrar nome, iniciais e cor do vendedor no Kanban, na Agenda, no Dashboard e no Financeiro - e
  // essa chave NUNCA existiu no blob (nem `team` nem `users`). Resultado: o card do pedido dizia
  // "Sem vendedor", o filtro por vendedor vinha vazio e o seletor mostrava o id cru
  // ("atendente_iqq91p"). Justo na tela onde o diretor confirma pagamento e comissao.
  // E derivado da tabela users, montado na leitura: nao entra no blob (o _stateProtegido apaga na
  // escrita) e nao gasta o teto de 1 MB.
  let team = [];
  try {
    // ESCOPO DO `team` (24/08/2026). Esta lista e montada FORA do _stateVisivel, entao ela escapava
    // inteira da poda: o afiliado recebia a NOSSA EQUIPE toda em data.team - Bruno Correa (socio),
    // os tres vendedores, o cobrador, o diretor e o gestor de trafego, com nome e cargo. Era o que
    // o Bruno viu na tela "Vendedores" da dash do afiliado. Conferido ao vivo antes de corrigir.
    // Agora quem esta no mundo de um afiliado so recebe o proprio mundo.
    const _mundo = (noMundoAfiliado(u) || afiliadoSemVinculo(u)) ? aflDe(u) : null;
    const _souDoMundo = isAfiliado(u) || afiliadoSemVinculo(u) || noMundoAfiliado(u);
    const tr = _souDoMundo
      ? await env.DB.prepare('SELECT id, name, abbr, role, color, bg, com_pct, salario, photo FROM users WHERE COALESCE(archived,0)=0 AND afiliado_id = ? ORDER BY name').bind(_mundo || '__sem_vinculo__').all()
      // Do lado do produtor, `team` tinha SO A CASA, com a justificativa de que "lead nosso nunca
      // e atendido por gente de afiliado". ESSA PREMISSA MORREU (28/08/2026): pedido que o vendedor
      // do afiliado cadastra cai tambem na NOSSA area de pedidos, de proposito. Resultado: o card
      // do Antonio Portella aparecia como "Sem vendedor" pro Bruno, sendo que tinha vendedor - o
      // nome so nao existia no mapa. Perder de vista quem vendeu e pior que a mistura que o filtro
      // evitava.
      // O DIRETOR passa a receber todo mundo, com `afl` carimbado em quem e de afiliado. E mapa de
      // NOME (o Diretorio de usuarios e a tela de Vendedores leem /api/users, que segue so com a
      // casa), e remuneracao de gente de afiliado NAO entra - ver o com_pct logo abaixo.
      : isDirector(u)
        ? await env.DB.prepare('SELECT id, name, abbr, role, color, bg, com_pct, salario, photo, afiliado_id FROM users WHERE COALESCE(archived,0)=0 ORDER BY name').all()
        : await env.DB.prepare('SELECT id, name, abbr, role, color, bg, com_pct, salario, photo FROM users WHERE COALESCE(archived,0)=0 AND afiliado_id IS NULL ORDER BY name').all();
    const dir = isDirector(u);
    team = (tr.results || []).map((x) => ({
      id: x.id, name: x.name, abbr: x.abbr, role: x.role, color: x.color, bg: x.bg,
      photo: _fotoUrl(req, x.id, x.photo),
      // De quem e essa pessoa. Vazio = da casa. A tela usa pra nao contar gente de afiliado como
      // nossa equipe (o nome aparece no card, mas ele nao e nosso funcionario).
      ...(x.afiliado_id ? { afl: String(x.afiliado_id) } : {}),
      // a taxa de comissao e do diretor, MENOS a propria: o vendedor precisa dela pra ver o que ele
      // ganha (sem isso a comissao dele aparece como R$ 0,00 no painel dele).
      // Gente de AFILIADO fica de fora: quanto o vendedor do Giovane ganha e assunto do Giovane, e
      // aqui e so mapa de nome.
      ...((dir && !x.afiliado_id) || String(x.id) === String(u.id) ? { com_pct: x.com_pct } : {}),
    }));
  } catch (_) { team = []; }
  return json({ data: { ...(await _stateVisivel(u, data, env)), team }, version: row.version, updated_at: row.updated_at, updated_by: row.updated_by, min_version: MIN_APP_VERSION });
}

// Move UM lead de coluna (kanban) de forma cirúrgica: lê o estado, troca só o
// campo `col` daquele lead e regrava. NÃO recebe o blob do cliente (evita o
// incidente de sobrescrita da aba antiga). Só diretor.
async function handleMoveLead(req, env, leadId) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // O afiliado toca o funil DELE: sem isso a dash dele teria um Kanban que nao move, e trabalhar o
  // pedido e justamente o que ele vai fazer o dia inteiro. QUAL card e dele so da pra saber depois
  // de achar o lead, entao a checagem de dono fica logo abaixo, dentro do laco.
  if (!isDirector(u) && !noMundoAfiliado(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const col = body && body.col;
  if (!col) return err('col obrigatório');
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data;
    try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
    const leads = Array.isArray(data.leads) ? data.leads : [];
    const lead = leads.find((l) => String(l.id) === String(leadId));
    if (!lead) return err('Lead não encontrado', 404);
    // Card de OUTRO afiliado responde 404, nao 403: 403 confirmaria que o pedido existe, e dai da
    // pra varrer os ids pra descobrir o volume dos concorrentes. Pra ele, simplesmente nao existe.
    if (noMundoAfiliado(u) && String(lead.afl || '') !== aflDe(u)) return err('Lead não encontrado', 404);
    const from = lead.col;
    if (from === col) return json({ ok: true, version: row.version, noop: true });
    lead.col = col;
    if (Array.isArray(lead.hist)) lead.hist.push({ from: from || '—', to: col, who: String(u.id), time: new Date().toISOString() });
    const newVer = (row.version || 0) + 1;
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'kanban:' + String(u.id), row.version).run();
    if (res && res.meta && res.meta.changes > 0) return json({ ok: true, version: newVer, from, to: col });
  }
  return err('Conflito ao salvar. Tente de novo.', 409);
}

// ACEITAR um pedido das Aceitações — e NÃO deixar virar dois cards.
//
// O fluxo do Bruno é: o pedido chega na dash → ele copia e lança na FIVE → só então clica em
// Aceitar. Ou seja, o webhook da Five costuma chegar ANTES do aceite. Aí ficam dois cards do mesmo
// cliente: o que a Five criou (com five_id) e o nosso manual indo pra "Enviado".
//
// O caminho contrário já era tratado (`_fiveUpsertLead` adota lead sem five_id casando por CPF),
// mas ele só roda quando a Five fala. Depois que o card da Five existe, os eventos seguintes acham
// pelo five_id e nunca mais procuram o irmão manual — o duplicado ficava pra sempre.
//
// Então o aceite faz a mesma checagem, do outro lado: acha o pedido da Five pelo CPF (ou pelos 8
// últimos dígitos do telefone), joga pra dentro dele o que só o nosso tem (vendedor, comissão,
// modalidade, observação, tags, agendamento) e APAGA o manual. Sem CPF batendo, é só mover pra
// "Enviado" como antes — e aí quem adota é a Five quando chegar.
async function handleAceitarLead(req, env, leadId) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const col = (body && body.col) || 'Enviado';
  const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data;
    try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
    const leads = Array.isArray(data.leads) ? data.leads : [];
    const i = leads.findIndex((l) => String(l.id) === String(leadId));
    if (i < 0) return err('Lead não encontrado', 404);
    const lead = leads[i];
    const cpf = soDig(lead.cpf), wa = soDig(lead.wa);
    const nowISO = new Date().toISOString();
    // Irmão da Five: mesmo cliente, já com five_id. CPF é a chave (o Bruno pediu assim e é o que
    // não muda); telefone é desempate pra pedido lançado sem documento.
    const irmao = (cpf || wa.length >= 8) ? leads.find((l) => l && l.five_id && String(l.id) !== String(lead.id) && (
      (cpf && soDig(l.cpf) === cpf) ||
      (!cpf && wa.length >= 8 && soDig(l.wa).length >= 8 && soDig(l.wa).slice(-8) === wa.slice(-8))
    )) : null;
    let resposta;
    if (irmao) {
      // O que a Five NÃO sabe vem do nosso cadastro. Só preenche o que está vazio lá, com uma
      // exceção: o VENDEDOR. Quem registrou o pedido sabe de quem ele é; a Five no máximo deduz
      // pelo afiliado, e errar isso é errar comissão.
      if (lead.at) irmao.at = lead.at;
      const puxa = ['nome', 'cpf', 'wa', 'email', 'cep', 'end', 'num', 'comp', 'bairro', 'cidade', 'uf', 'prod', 'trat', 'obs', 'mod', 'pgto', 'agend', 'link'];
      for (const k of puxa) if ((irmao[k] == null || irmao[k] === '') && lead[k] != null && lead[k] !== '') irmao[k] = lead[k];
      if (!Number(irmao.vl) && Number(lead.vl)) irmao.vl = Number(lead.vl);
      if (!Number(irmao.com_pct) && Number(lead.com_pct)) irmao.com_pct = Number(lead.com_pct);
      if (Array.isArray(lead.tags) && lead.tags.length) irmao.tags = [...new Set([...(Array.isArray(irmao.tags) ? irmao.tags : []), ...lead.tags])];
      if (Array.isArray(lead.comments) && lead.comments.length) irmao.comments = [...(Array.isArray(irmao.comments) ? irmao.comments : []), ...lead.comments];
      if (!Array.isArray(irmao.hist)) irmao.hist = [];
      irmao.hist.push({ from: irmao.col || '—', to: irmao.col || '—', who: String(u.id), time: nowISO, note: 'aceite juntou o cadastro manual #' + String(lead.id) + ' (mesmo CPF)' });
      irmao.aceito = true; irmao.aceito_em = nowISO;
      leads.splice(i, 1);   // o manual sai: o pedido da Five é o card que a operação acompanha
      resposta = { ok: true, fundido: true, lead_id: irmao.id, five_id: irmao.five_id, col: irmao.col };
    } else {
      const from = lead.col;
      lead.col = col; lead.aceito = true; lead.aceito_em = nowISO;
      if (Array.isArray(lead.hist)) lead.hist.push({ from: from || '—', to: col, who: String(u.id), time: nowISO, note: 'aceito (aguardando o pedido da Five casar por CPF)' });
      resposta = { ok: true, fundido: false, lead_id: lead.id, col };
    }
    const newVer = (row.version || 0) + 1;
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'aceite:' + String(u.id), row.version).run();
    if (res && res.meta && res.meta.changes > 0) return json({ ...resposta, version: newVer });
  }
  return err('Conflito ao salvar. Tente de novo.', 409);
}

// Reagenda um lead (campo `agend`, ISO 'YYYY-MM-DDTHH:MM'). Cirúrgico, só diretor.
async function handleSetAgend(req, env, leadId) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const agend = body && typeof body.agend === 'string' ? body.agend : '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data;
    try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
    const leads = Array.isArray(data.leads) ? data.leads : [];
    const lead = leads.find((l) => String(l.id) === String(leadId));
    if (!lead) return err('Lead não encontrado', 404);
    lead.agend = agend;
    const newVer = (row.version || 0) + 1;
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'agenda:' + String(u.id), row.version).run();
    if (res && res.meta && res.meta.changes > 0) return json({ ok: true, version: newVer, agend });
  }
  return err('Conflito ao salvar. Tente de novo.', 409);
}

// Edita vários campos de UM lead (cirúrgico, whitelist, só diretor). CAS (WHERE version=?) num loop
// pra NÃO sobrescrever writes concorrentes dos webhooks (evita o incidente da aba antiga).
async function handleUpdateLead(req, env, leadId) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const dir = isDirector(u);
  // cobrador gerencia a cobrança (reagendar, marcar pago, mover etapa), mas NÃO reatribui/valor/comissão
  const canManage = dir || String(u.role || '').toLowerCase() === 'cobrador';
  const body = await req.json().catch(() => ({}));
  const patch = (body && typeof body.patch === 'object' && body.patch) ? body.patch : (body || {});
  // campos livres (qualquer usuário logado). spg/col/agend -> diretor ou cobrador; at/vl/com_pct -> só diretor.
  // comprovante_url/mime entram aqui: sao do PEDIDO (o arquivo que prova a venda COD), e ficavam de
  // fora, entao anexar comprovante ao EDITAR um pedido dizia "atualizado" e nao gravava nada. O
  // vendedor via salvo, reabria e nao tinha anexo. Sao so a URL no R2 e o mime, nunca o arquivo.
  // 'transp' = como o pedido vai (transportadora que entrega em casa x Correios com retirada na
  // agencia). Faltava aqui E nas duas listas do front: o vendedor escolhia Correios, a tela dizia
  // salvo e o valor era descartado antes de sair do navegador. Mesmo defeito do comprovante, que
  // ja tinha acontecido nesta mesma lista - campo novo TEM que entrar nas TRES.
  const SCALAR = ['nome', 'cpf', 'wa', 'email', 'orig', 'cep', 'end', 'num', 'comp', 'bairro', 'cidade', 'uf', 'prod', 'trat', 'mod', 'pgto', 'track', 'link', 'obs', 'transp', 'comprovante_url', 'comprovante_mime', 'entrega_url', 'entrega_mime', 'track_core', 'transp_nome'];
  const now14 = () => { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data;
    try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
    const leads = Array.isArray(data.leads) ? data.leads : [];
    const lead = leads.find((l) => String(l.id) === String(leadId));
    if (!lead) return err('Lead não encontrado', 404);
    const fromCol = lead.col;
    // GATE DE MUNDO, NO TOPO (auditoria 24/08/2026). O handleMoveLead ja tinha; aqui faltava, e
    // `tags` e `comments` eram gravados FORA do bloco de dono - entao qualquer autenticado
    // reescrevia etiqueta e comentario de QUALQUER pedido nosso.
    if (afiliadoSemVinculo(u)) return err('Lead não encontrado', 404);
    if (noMundoAfiliado(u) && String(lead.afl || '') !== aflDe(u)) return err('Lead não encontrado', 404);
    // IDOR: só diretor/cobrador OU o dono do lead (vendedor atribuído) editam os campos do cliente.
    // Antes qualquer autenticado alterava nome/cpf/endereço/rastreio de QUALQUER lead.
    // Dono do lead: o vendedor atribuido OU, no mundo de afiliado, quem e daquele afiliado. Sem a
    // segunda metade o afiliado abria o proprio pedido e nao conseguia anotar nada (o lead.at e o
    // vendedor, nunca ele).
    const owns = String(lead.at) === String(u.id) || (noMundoAfiliado(u) && String(lead.afl || '') === aflDe(u));
    // O QUE FOR RECUSADO VOLTA NA RESPOSTA. Antes os campos sem permissão eram descartados em
    // silêncio e o endpoint respondia 200 ok: a tela dava "Lead salvo", o valor continuava na frente
    // dele (edição otimista) e só no F5 seguinte voltava tudo. Isso é a queixa do Bruno de "edito e
    // volta ao antigo", só que vinda da permissão, não do salvamento.
    // Não bloqueio a chamada inteira de propósito: quem edita o próprio cliente e de passagem manda
    // um campo de diretor deve gravar o que pode, e SABER o que não gravou.
    const negados = [];
    // SO E RECUSA SE O VALOR MUDA. O Novo Pedido manda o formulario INTEIRO em todo salvamento, e
    // `at`, `vl` e `com_pct` vao sempre - entao o vendedor levava "Salvo, menos: vendedor, valor,
    // comissao" em TODA edicao, mesmo corrigindo so o endereco. Nada tinha sido recusado de
    // verdade: o valor que chegou era o mesmo que ja estava gravado. Reclamacao do vendedor do
    // Bruno em 21/08/2026 ("nao consigo editar, ta dando bug").
    const _igual = (a2, b2) => String(a2 == null ? '' : a2) === String(b2 == null ? '' : b2);
    const nega = (cond, ...ks) => { if (!cond) for (const k of ks) if (k in patch && !_igual(patch[k], lead[k])) negados.push(k); };
    // PRECO DO KIT, do catalogo (data.regras.kits, o mesmo que a tela oferece no seletor).
    const _precoDoKit = (nome) => {
      const kits = (data.regras && Array.isArray(data.regras.kits)) ? data.regras.kits : [];
      const alvo = String(nome || '').trim().toLowerCase();
      for (const k of kits) {
        if (String((k && k.nome) || '').trim().toLowerCase() !== alvo) continue;
        const p = Number(String(k.preco == null ? '' : k.preco).replace(/\./g, '').replace(',', '.'));
        if (p > 0) return p;
      }
      return 0;
    };
    // TROCAR O KIT NAO E DIGITAR PRECO. `vl` e campo de diretor pra impedir preco inventado, mas o
    // Novo Pedido nao deixa digitar valor nenhum: ele vem do tratamento escolhido. Com a regra
    // antiga, o vendedor trocava de 4 pra 3 meses e o pedido ficava "Glico Six - 3 Meses" custando
    // R$ 497 - nome de um kit com o preco de outro, envenenando receita, comissao e margem (caso
    // real: Romi Machado Teixeira, 21/08/2026). Agora o dono do lead pode gravar o valor QUANDO ele
    // bate com o preco de catalogo do tratamento que veio no mesmo salvamento.
    const _vlDeCatalogo = ('vl' in patch) && ('trat' in patch)
      && Math.abs(_precoDoKit(patch.trat) - (Number(patch.vl) || 0)) < 0.01;
    const _podeVl = dir || (owns && _vlDeCatalogo);
    if (canManage || owns) { for (const k of SCALAR) { if (k in patch) lead[k] = patch[k]; } }
    else nega(false, ...SCALAR);
    nega(dir, 'at', 'com_pct');
    nega(_podeVl, 'vl');
    nega(canManage, 'spg', 'agend', 'col');
    // valor_neg (o que o cliente PAGOU de verdade) sai da lista de diretor: quem negocia o desconto
    // e o vendedor, no WhatsApp, e a dash nao ve isso. Sem poder registrar, a comissao dele saia
    // sobre o valor cheio - o oposto da regra do Bruno. O dono do lead pode gravar.
    nega(canManage || owns, 'valor_neg');
    // NAO GRAVA METADE. Quando o vendedor manda o mesmo patch com `spg: Pago` e `valor_neg: 350`, o
    // `spg` era recusado (so diretor/cobrador marcam pago) e o `valor_neg` gravava. O pedido ficava
    // "Pendente" valendo 350: a receita nao entrava, a comissao nao registrava e ainda sumia a
    // diferenca do que o cliente devia. Meia gravacao e pior que recusa inteira - agora os dois caem
    // juntos, e a tela avisa.
    if (negados.includes('spg') && 'valor_neg' in patch && !negados.includes('valor_neg')) negados.push('valor_neg');
    if (!canManage && Array.isArray(patch.pagamentos)) negados.push('pagamentos');
    if (_podeVl && 'vl' in patch) lead.vl = Number(patch.vl) || 0;   // diretor sempre; dono so com preco do catalogo
    if (dir) {
      if ('at' in patch) lead.at = patch.at;
      // Valor invalido virava 12%, um numero que ninguem combinou. Agora vira VAZIO, e a dash usa
      // a taxa cadastrada do vendedor. String vazia tambem passa: e como o front limpa a taxa.
      if ('com_pct' in patch) { const c = Number(patch.com_pct); lead.com_pct = (patch.com_pct === '' || isNaN(c)) ? '' : c; }
    }
    // Fora do bloco de gestao: o vendedor grava o valor pago do PROPRIO pedido.
    // O `nega()` acima so MARCA o campo como recusado, quem grava e esta linha. Na primeira versao
    // deste conserto eu marquei o valor_neg como negado e esqueci de barrar a gravacao: a resposta
    // dizia "recusado" e o valor entrava no banco assim mesmo - a tela desfazia na frente do
    // vendedor e o banco ficava com 350. Pior que o bug original. Pego num teste com o dono do lead.
    if ((canManage || owns) && 'valor_neg' in patch && !negados.includes('valor_neg')) lead.valor_neg = _valorPago(patch.valor_neg, lead);
    if (canManage) {
      if ('spg' in patch) lead.spg = patch.spg;
      if ('agend' in patch) lead.agend = patch.agend;
      if (Array.isArray(patch.pagamentos)) { // ficha de cobrança: parcelas efetivamente pagas
        lead.pagamentos = patch.pagamentos.slice(0, 60).map((p) => ({
          ts: Number(p && p.ts) || 0, data: String((p && p.data) || ''), valor: Number(p && p.valor) || 0,
          obs: String((p && p.obs) || ''), who: (p && p.who != null) ? String(p.who) : undefined,
        })).filter((p) => p.valor > 0 || p.obs);
      }
      if ('col' in patch && patch.col) {
        if (patch.col !== fromCol) {
          if (!Array.isArray(lead.hist)) lead.hist = [];
          lead.hist.push({ from: fromCol || '—', to: patch.col, who: 'kanban:' + String(u.id), time: now14() });
        }
        lead.col = patch.col;
      }
    }
    if (Array.isArray(patch.tags)) {
      // O catalogo que vale e o de quem esta salvando: sem isto, o afiliado marcava uma etiqueta que
      // ele mesmo criou, o servidor respondia 200 e a etiqueta sumia - o pior tipo de defeito, o que
      // mente que salvou. As nossas continuam valendo pra quem e da casa.
      const t = (Array.isArray(data.tags) ? data.tags : []).concat(_tagsDe(data, u));
      lead.tags = t.length ? patch.tags.filter((x) => t.some((y) => y.id === x)) : patch.tags;
    }
    if (Array.isArray(patch.comments)) lead.comments = patch.comments;
    const newVer = (row.version || 0) + 1;
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'kanban:' + String(u.id), row.version).run();
    if (res && res.meta && res.meta.changes > 0) {
      // `negados` só aparece quando existe: chamador antigo continua vendo { ok, version }.
      return negados.length ? json({ ok: true, version: newVer, negados }) : json({ ok: true, version: newVer });
    }
  }
  return err('Conflito ao salvar. Tente de novo.', 409);
}

// POST /api/lead/delete { id } → apaga UM pedido de data.leads. SÓ DIRETOR/SÓCIO/PRODUTOR.
//
// Pedido do Bruno em 18/08/2026: "quero a opção de excluir, apenas eu como diretor ou sócio; meus
// vendedores não vão ter a opção de deletar nenhum pedido".
//
// Até aqui só existia /api/wa/sale/delete, que remove a linha de VENDA detectada no WhatsApp. Pedido
// cadastrado na mão vive em data.leads e não tinha como sair: o botão da lixeira nem aparecia.
//
// Apagar é IRREVERSÍVEL no blob, então: gate de cargo antes de qualquer leitura, CAS pra não
// atropelar escrita concorrente, e devolve o que removeu pra tela poder conferir.
// ── COMPROVANTE DE ENTREGA (a foto que a transportadora tira ao entregar) ──────────────────────
//
// Onde plugar quando a Five comecar a mandar. Em 18/08/2026 eu varri TODOS os payloads que ela ja
// enviou (five_orders.raw + five_debug): 52 campos distintos e NENHUM de foto, imagem, anexo ou
// assinatura. Ou seja, hoje ela nao manda - nao e questao de a gente nao estar lendo.
//
// O Bruno vai confirmar com a Five se existe evento/endpoint pra isso. Enquanto nao existe, o campo
// `entrega_url` do lead e preenchido A MAO (a tela deixa anexar a foto que a transportadora manda no
// WhatsApp). Quando a Five ligar o evento, e so chamar esta funcao de dentro do webhook dela com a
// URL que vier: o resto da dash ja le esse campo, nada mais muda.
//
// Guardar no NOSSO R2 e nao a URL deles e de proposito: link de terceiro expira, e o comprovante de
// entrega e justamente o que segura uma contestacao meses depois.
async function _salvarComprovanteEntrega(env, leadId, url, mime) {
  if (!leadId || !url) return false;
  for (let t = 0; t < 4; t++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return false;
    let data; try { data = JSON.parse(row.data); } catch (_) { return false; }
    const leads = Array.isArray(data.leads) ? data.leads : [];
    const l = leads.find((x) => String(x.id) === String(leadId));
    if (!l) return false;
    l.entrega_url = String(url);
    l.entrega_mime = String(mime || '');
    if (await _casState(env, row.version, data, 'entrega-foto')) return true;
  }
  return false;
}

async function handleLeadDelete(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Só um diretor pode excluir pedido', 403);
  const body = await req.json().catch(() => ({}));
  const id = String((body && body.id) || '').trim();
  if (!id) return err('id obrigatório');
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data;
    try { data = JSON.parse(row.data); } catch (_) { return err('Estado inválido', 500); }
    const leads = Array.isArray(data.leads) ? data.leads : [];
    const i = leads.findIndex((l) => String(l.id) === id);
    if (i < 0) return err('Pedido não encontrado', 404);
    const removido = leads[i];
    data.leads = leads.filter((_, k) => k !== i);
    const ok = await _casState(env, row.version, data, 'lead-delete:' + String(u.id));
    if (ok) return json({ ok: true, version: (row.version || 0) + 1, removido: { id: removido.id, nome: removido.nome || '' } });
  }
  return err('Estado ocupado, tente de novo', 409);
}

// Salva UMA pressel (cirúrgico, só diretor). O cliente manda { id, patch } — NUNCA o blob inteiro,
// então não tem risco de apagar chips/leads/etc (o incidente da aba antiga). id=0/ausente cria nova
// (id = max+1 no servidor). patch só aplica campos permitidos; arrays (vendedores/elementos) quando
// vierem SUBSTITUEM (edição intencional), quando não vierem ficam intactos.
// DOMINIOS QUE O SALVAMENTO DA PRESSEL ACEITA. Esta lista e uma TRAVA: se o dominio escolhido na
// dash nao estiver aqui, a linha do `dominio` no patch e simplesmente ignorada, SEM erro nenhum -
// o Bruno escolhe, salva, e o campo volta pro valor antigo sem explicacao. Entao dominio novo tem
// que entrar AQUI antes de qualquer outra coisa.
//
// Os 4 `.shop` entraram em 27/08/2026: os tres antigos queimaram e o Bruno comprou os novos. Eles
// ficam na lista mesmo ANTES de existirem no Cloudflare, porque isto so libera o SALVAMENTO - a
// pressel so responde de verdade depois que o dominio for anexado ao worker como Custom Domain.
// Ver o comentario em wrangler.toml sobre por que eles NAO entram nas `routes` ainda.
const _PRESSEL_DOMS = [
  'area-acesso.com', 'area-glico.fun', 'painel-glico.fun',
  'glico6-painel.shop', 'glico6-acesso.shop', 'glico-area.shop', 'glico-painel.shop',
];
async function handlePresselSave(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!_podeMexerPressel(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const patch = (body && body.patch && typeof body.patch === 'object') ? body.patch : null;
  if (!patch) return err('patch obrigatório');
  // GRAVA COM CONFERENCIA DE VERSAO (pedido do Bruno em 25/08/2026: "quero que o interruptor mande").
  // Sem o "AND version=?" abaixo, uma gravacao concorrente do blob desfazia esta em silencio, e a tela
  // ainda dizia que salvou. E o jeito de um numero que ele tirou da roleta voltar a receber sozinho.
  // Se a versao mudou no meio, refaz do estado novo em vez de sobrescrever o trabalho do outro.
  for (let tent = 0; tent < 6; tent++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
    if (!Array.isArray(data.pressels)) data.pressels = [];
    let id = Number(body.id) || 0;
    let target;
    // DONO DA PRESSEL. O afiliado so abre e edita a dele; a nossa responde 404 (nao 403: 403
    // confirmaria que existe, e daria pra varrer ids pra mapear a operacao da casa).
    const _meuAfl = isAfiliado(u) ? aflDe(u) : null;
    if (isAfiliado(u) && !_meuAfl) return err('Cadastro de afiliado incompleto', 403);
    if (id) {
      target = data.pressels.find((x) => String(x.id) === String(id));
      if (!target) return err('Pressel não encontrada', 404);
      if (_meuAfl && String(target.afl || '') !== _meuAfl) return err('Pressel não encontrada', 404);
    } else {
      id = data.pressels.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
      target = { id, nome: 'Nova Pressel', status: 'ativa', msg: '', pixel_tt: '', pixel_tt_token: '',
        pixel_meta: '', pixel_meta_token: '', bg: '#ffffff', redirect: 0, fullclick: false, dominio: 'painel-glico.fun',
        elementos: [{ id: 1, type: 'imagem', src: '' }, { id: 2, type: 'botao', label: 'FALAR NO WHATSAPP', bg: '#22c55e', color: '#ffffff' }],
        vendedores: [], metrics: { cliques: 0, contatos: 0, vendas: 0 }, _rr: 0 };
      // Nasce carimbada com o dono. Pressel nossa continua sem o campo, que e o que mantem a roleta
      // de hoje intacta.
      if (_meuAfl) {
        target.afl = _meuAfl;
        // ENDERECO PROPRIO: /p/<slug dele>/<n dele>. O `n` conta so as pressels DELE, entao a
        // primeira dele e sempre 1 - independente de quantas a gente ja tenha criado.
        target.afl_slug = await _aflSlugDe(env, _meuAfl);
        target.num = data.pressels.reduce((m, x) => (x && String(x.afl || '') === _meuAfl ? Math.max(m, Number(x.num) || 0) : m), 0) + 1;
        // A PRESSEL DELE NASCE EM BRANCO (25/08/2026). Por algumas horas ela herdou a APARENCIA da
        // nossa (so elementos e cor, nunca pixel nem dominio), a pedido do Bruno; no mesmo dia ele
        // reviu e mandou tirar. E coerente com o Sale Chat: o criativo e a mensagem sao a cara da
        // operacao DELE, nao um template da casa. Ele monta a dele do zero.
      }
      data.pressels.push(target);
    }
    // PRESSEL DE AFILIADO QUE NASCEU ANTES DISTO ganha slug e numero na primeira gravacao. Sem
    // este remendo ela ficaria pra sempre so no /p/<id>, que e justamente o que o Bruno pediu pra
    // separar. Roda dentro do laco de CAS, junto com o resto da gravacao.
    for (const x of data.pressels) {
      if (!x || !x.afl || (x.afl_slug && Number(x.num) > 0)) continue;
      if (!x.afl_slug) x.afl_slug = await _aflSlugDe(env, x.afl);
      if (!(Number(x.num) > 0)) {
        x.num = data.pressels.reduce((m, y) => (y && y !== x && String(y.afl || '') === String(x.afl) ? Math.max(m, Number(y.num) || 0) : m), 0) + 1;
      }
    }
    const STR = ['nome', 'msg', 'pixel_tt', 'pixel_tt_token', 'pixel_meta', 'pixel_meta_token', 'bg'];
    for (const k of STR) if (k in patch) target[k] = String(patch[k] == null ? '' : patch[k]).slice(0, 4000);
    // O 2º PIXEL DO TIKTOK SAIU (27/08/2026, pedido do Bruno: "pode remover esse segundo pixel do
    // TikTok, que não vamos usar essa função"). Era o espelho que mandava os mesmos eventos reais
    // pra uma segunda BM. Nada aqui aceita mais pixel2_*; o que já estiver gravado numa pressel
    // vira campo morto e não dispara nada.
    // EVENTO DE CADA ETAPA. Guardado à parte do STR de propósito: aqui o valor NÃO pode ser texto
    // livre. Ele acaba interpolado dentro de um <script> na pressel, que é página de tráfego pago —
    // texto livre ali seria execução de código. Só passa nome da lista do TikTok ou 'off' (desligar);
    // qualquer outra coisa vira '' e o disparo volta ao padrão de hoje.
    for (const k of ['ev_view', 'ev_click', 'ev_lead', 'ev_sale']) {
      if (!(k in patch)) continue;
      const v = String(patch[k] == null ? '' : patch[k]).trim();
      target[k] = (v === 'off' || _EV_TT.includes(v)) ? v : '';
    }
    if ('status' in patch) target.status = (patch.status === 'pausada' ? 'pausada' : 'ativa');
    if ('redirect' in patch) target.redirect = Math.max(0, Number(patch.redirect) || 0);
    if ('fullclick' in patch) target.fullclick = !!patch.fullclick;
    if ('dominio' in patch && _PRESSEL_DOMS.includes(String(patch.dominio))) target.dominio = String(patch.dominio);
    // LIGAR/DESLIGAR UM NUMERO E UM COMANDO, NAO O ARRAY INTEIRO.
    //
    // A tela mandava `vendedores` inteiro, montado da copia que ela carregou no boot. Com a aba
    // aberta ha horas (ou duas abas, ou o desligamento automatico gravando junto), a copia velha
    // voltava por cima e o "desliguei esse numero" sumia sem erro nenhum. O CAS nao salva disso: a
    // gravacao e valida, o conteudo e que esta velho. Aqui o pedido diz so o que MUDOU e a mudanca
    // e aplicada em cima do estado que acabou de ser lido, dentro do laco de tentativa.
    // Pedido do Bruno em 25/08/2026: "quero que o interruptor mande".
    if (patch.vend_off && typeof patch.vend_off === 'object') {
      const at = String(patch.vend_off.at || '');
      const nk = String(patch.vend_off.num || '').replace(/\D/g, '').slice(-8);
      const ligar = !!patch.vend_off.on;
      if (at && nk) {
        if (!Array.isArray(target.vendedores)) target.vendedores = [];
        let v = target.vendedores.find((x) => x && String(x.at) === at);
        if (!v) { v = { at, ativo: true }; target.vendedores.push(v); }
        if (at === '__sd') {
          // Numero sem dono guarda os LIGADOS (o contrario dos vendedores): ausente = desligado.
          const on = (v.on && typeof v.on === 'object') ? { ...v.on } : {};
          if (ligar) on[nk] = true; else delete on[nk];
          if (Object.keys(on).length) v.on = on; else delete v.on;
        } else {
          const off = (v.off && typeof v.off === 'object') ? { ...v.off } : {};
          if (ligar) { delete off[nk]; v.ativo = true; } else off[nk] = true;
          if (Object.keys(off).length) v.off = off; else delete v.off;
        }
      }
    }
    if (Array.isArray(patch.vendedores)) {
      target.vendedores = patch.vendedores.map((v) => {
        const o = { at: String((v && v.at) || ''), ativo: v.ativo !== false };
        // Interruptor POR NÚMERO: mapa de números DESLIGADOS (chave = últimos 8 dígitos). Ausente = ligado.
        // Guardar os "off" (e não os "on") faz todo número novo "Em uso" já entrar ligado por padrão.
        if (v && v.off && typeof v.off === 'object') {
          const off = {}; for (const k in v.off) { const nk = String(k).replace(/\D/g, '').slice(-8); if (nk && v.off[k]) off[nk] = true; }
          if (Object.keys(off).length) o.off = off;
        }
        // Números SEM VENDEDOR (v.at === '__sd'): aqui o mapa é de LIGADOS, não de desligados. Número
        // solto entra na roleta só quando alguém liga explicitamente — o padrão "ausente = ligado" dos
        // vendedores colocaria todo número órfão do cadastro pra receber lead sem ninguém pedir.
        if (v && v.on && typeof v.on === 'object') {
          const on = {}; for (const k in v.on) { const nk = String(k).replace(/\D/g, '').slice(-8); if (nk && v.on[k]) on[nk] = true; }
          if (Object.keys(on).length) o.on = on;
        }
        return o;
      }).filter((v) => v.at);
    }
    // Link fixo do botão: só http/https entra (um javascript: aqui viraria execução na página do anúncio).
    if ('link' in patch) {
      const u2 = String(patch.link == null ? '' : patch.link).trim().slice(0, 500);
      target.link = (!u2 || /^https?:\/\//i.test(u2)) ? u2 : (target.link || '');
    }
    if ('link_on' in patch) target.link_on = !!patch.link_on;
    if (Array.isArray(patch.elementos)) target.elementos = patch.elementos;   // editor de elementos valida no cliente
    const newVer = (row.version || 0) + 1;
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'pressel:' + String(u.id), row.version).run();
    if (res && res.meta && res.meta.changes > 0) return json({ ok: true, version: newVer, pressel: target });
    await new Promise((r) => setTimeout(r, 12 * (tent + 1)));   // outra escrita ganhou o version: espera e refaz
  }
  return err('Conflito ao salvar. Tente de novo.', 409);
}
// Remove UMA pressel (cirúrgico, só diretor).
async function handlePresselDelete(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!_podeMexerPressel(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const id = Number(body && body.id);
  if (!id) return err('id obrigatório');
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  if (!row) return err('Estado não encontrado', 404);
  let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
  const before = Array.isArray(data.pressels) ? data.pressels.length : 0;
  // O afiliado so apaga a pressel DELE. Sem esta guarda, ele apagaria a nossa mandando o id na mao -
  // e apagar pressel derruba trafego pago que esta rodando.
  if (isAfiliado(u)) {
    const _a = aflDe(u);
    const alvo = (data.pressels || []).find((x) => String(x.id) === String(id));
    if (!_a || !alvo || String(alvo.afl || '') !== _a) return err('Pressel não encontrada', 404);
  }
  data.pressels = (data.pressels || []).filter((x) => String(x.id) !== String(id));
  if (data.pressels.length === before) return err('Pressel não encontrada', 404);
  const newVer = (row.version || 0) + 1;
  await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1')
    .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'pressel:' + String(u.id)).run();
  return json({ ok: true, version: newVer, removed: id });
}
// Salva UM chip (cirúrgico, só diretor). patch por id. Regra "Em uso": ligar em_uso num chip
// desliga os irmãos do mesmo atendente (um por atendente). Usado pela roleta (reserva/swap) e pela
// Contingência. Nunca manda o blob inteiro → não apaga o resto.
// POST /api/wa/meu-numero — o ATENDENTE escolhe por qual dos SEUS números ele vai disparar.
// Antes a tela chamava /api/chip/save, que é do diretor: o vendedor tomava 'Sem permissão' e ficava
// preso num número só. E o caminho era errado de origem, porque marcava o chip como 'Em uso' —
// isso é decisão de ROLETA (quem recebe lead), não de quem dispara. São duas coisas diferentes:
// os dois números dele podem receber lead ao mesmo tempo, e ele escolhe de qual fala.
// A escolha vive em data.wa_ativo[<usuário>] e vale só pra CONVERSA NOVA: respondendo alguém, a
// resposta sai pelo número que recebeu (senão o lead vê a conversa pular de número).
async function handleMeuNumero(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const body = await req.json().catch(() => ({}));
  const chipId = body && body.chip_id != null ? String(body.chip_id) : '';
  if (!chipId) return err('chip_id obrigatório');
  for (let t = 0; t < 5; t++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data; try { data = JSON.parse(row.data); } catch (_) { return err('Estado inválido', 500); }
    const chips = Array.isArray(data.chips) ? data.chips : [];
    const chip = chips.find((c) => String(c.id) === chipId);
    if (!chip) return err('Número não encontrado', 404);
    // Só o dono do número escolhe (o diretor pode escolher por qualquer um, pra socorrer).
    if (!isDirector(u) && String(chip.at || '') !== String(u.id)) return err('Esse número não é seu', 403);
    // Só número EM USO dispara. Estacionado/aquecendo não: era exatamente assim que lead ia parar
    // em chip parado e queimava número (regra antiga da roleta, vale aqui também).
    const emUsoIds = _emUsoIdsDe(data);
    const emUso = chip.em_uso === true || chip.em_uso === 1 || emUsoIds.has(String(chip.wa_st || '')) || String(chip.wa_st || '') === 'em_uso';
    if (!emUso) return err('Esse número não está "Em uso" — só número em uso pode disparar', 400);
    if (chip.st === 'banido' || chip.st === 'aquecimento') return err('Número em aquecimento ou banido não dispara', 400);
    if (!data.wa_ativo || typeof data.wa_ativo !== 'object') data.wa_ativo = {};
    data.wa_ativo[String(chip.at || u.id)] = String(chip.num || '').replace(/\D/g, '').slice(-8);
    const novaV = (row.version || 0) + 1;
    const r = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), novaV, Math.floor(Date.now() / 1000), 'meunum:' + String(u.id), row.version).run();
    if (r && r.meta && r.meta.changes > 0) return json({ ok: true, num: chip.num, num_key: data.wa_ativo[String(chip.at || u.id)] });
    await new Promise((res) => setTimeout(res, 12 * (t + 1)));
  }
  return err('Conflito ao salvar. Tente de novo.', 409);
}
async function handleChipSave(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!_podeMexerPressel(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const id = body && body.id;
  const patch = (body && body.patch && typeof body.patch === 'object') ? body.patch : null;
  if (id == null || !patch) return err('id e patch obrigatórios');
  // GRAVA COM CONFERENCIA DE VERSAO (pedido do Bruno em 25/08/2026: "quero que o interruptor mande").
  // Sem o "AND version=?" abaixo, uma gravacao concorrente do blob desfazia esta em silencio, e a tela
  // ainda dizia que salvou. E o jeito de um numero que ele tirou da roleta voltar a receber sozinho.
  // Se a versao mudou no meio, refaz do estado novo em vez de sobrescrever o trabalho do outro.
  for (let tent = 0; tent < 6; tent++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
    if (!Array.isArray(data.chips)) return err('Sem chips', 404);
    const chip = data.chips.find((c) => String(c.id) === String(id));
    if (!chip) return err('Chip não encontrado', 404);
    const _donoAntes = String(chip.at || '').trim();
    // Mesmo gate da pressel: o afiliado so mexe no numero dele.
    const _meuAflC = isAfiliado(u) ? aflDe(u) : null;
    if (isAfiliado(u) && !_meuAflC) return err('Cadastro de afiliado incompleto', 403);
    if (_meuAflC && String(chip.afl || '') !== _meuAflC) return err('Chip não encontrado', 404);
    const eq8 = (a, b) => { const x = String(a || '').replace(/\D/g, '').slice(-8), y = String(b || '').replace(/\D/g, '').slice(-8); return x.length >= 8 && x === y; };
    // helpers de status (a roleta conta "Em uso" pela TAG também, não só pela flag em_uso)
    const _norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const _waSt = Array.isArray(data.wa_statuses) ? data.wa_statuses : [];
    const _stLabel = (wid) => { const s = _waSt.find((x) => String(x.id) === String(wid)); return _norm(s ? (s.label || s.id) : wid); };
    const _isEmUsoId = (wid) => !!wid && (String(wid) === 'em_uso' || _stLabel(wid) === 'em uso');
    const _isRestabId = (wid) => { const n = _stLabel(wid); return n === 'restabelecido' || n === 'reestabelecido'; };
    const _ativoId = (() => { const s = _waSt.find((x) => _norm(x.label || x.id) === 'ativo'); if (s) return s.id; const nb = _waSt.find((x) => { const n = _norm(x.label || x.id); return n !== 'em uso' && n !== 'banido'; }); return nb ? nb.id : 'ativo'; })();
    // 'proxy' = o endereco da proxy que esse numero usa (host:porta:usuario:senha, do jeito que o
    // provedor entrega). E anotacao operacional: fica guardada junto do chip pra o Bruno achar rapido
    // quando for reconectar o aparelho. O worker NAO usa esse valor pra sair pra internet.
    const STR = ['num', 'at', 'mod', 'op', 'rec', 'wa_st', 'wa_st2', 'note', 'st', 'warm_start', 'restab_start', 'proxy'];
    for (const k of STR) if (k in patch) chip[k] = String(patch[k] == null ? '' : patch[k]);
    if ('idx' in patch) chip.idx = Number(patch.idx) || chip.idx;
    if ('dia' in patch) chip.dia = Number(patch.dia) || chip.dia;
    if ('dia_uso' in patch) chip.dia_uso = (patch.dia_uso === null || patch.dia_uso === '') ? null : Number(patch.dia_uso);
    if ('api' in patch) chip.api = !!patch.api;
    if ('bkp' in patch) { chip.bkp = !!patch.bkp; if (chip.bkp) chip.em_uso = false; }
    if ('em_uso' in patch) {
      chip.em_uso = !!patch.em_uso;
      // Vários números "Em uso" por atendente são PERMITIDOS agora: a roleta simples distribui os leads
      // entre TODOS os números ligados do vendedor. NÃO rebaixa mais os irmãos (cada "Em uso" entra na
      // roleta com seu próprio interruptor, controlado por pressel em v.off).
      if (chip.em_uso) chip.bkp = false;
    }
    // timer do "Restabelecido" (espelha _syncRestabTimer): liga ao entrar na tag, LIMPA ao sair — evita promoção precoce
    if ('wa_st' in patch && !('restab_start' in patch)) {
      if (_isRestabId(chip.wa_st)) { if (!chip.restab_start) chip.restab_start = new Date().toISOString().split('T')[0]; }
      else chip.restab_start = '';
    }
    // saneamento (autocura da antiga): chip sem atendente nunca carrega "em uso" nem "reserva"
    if (!String(chip.at || '').trim()) { chip.em_uso = false; chip.bkp = false; }
    // TROCOU DE DONO? PERDE O "EM USO".
    //
    // Arrastar o chip de um vendedor pro outro na Contingencia manda so { at, st } e o numero
    // continuava marcado "Em uso" - so que o interruptor da pressel e guardado DENTRO da entrada do
    // vendedor ANTIGO (v.off e por par vendedor+numero). Resultado: o numero reaparecia LIGADO
    // embaixo do dono novo e voltava a receber lead sozinho, sem ninguem pedir. Ja ha desligamento
    // orfao gravado hoje na pressel 1 por causa disso. Mesma regra que estacionar ja tinha ("entra
    // com status neutro, pra nao fixar chip sem querer"): trocou de dono, o Diretor remarca.
    if (_donoAntes !== String(chip.at || '').trim() && chip.em_uso) { chip.em_uso = false; if (_isEmUsoId(chip.wa_st)) chip.wa_st = _ativoId; }
    const newVer = (row.version || 0) + 1;
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'chip:' + String(u.id), row.version).run();
    if (res && res.meta && res.meta.changes > 0) return json({ ok: true, version: newVer, chip });
    await new Promise((r) => setTimeout(r, 12 * (tent + 1)));   // outra escrita ganhou o version: espera e refaz
  }
  return err('Conflito ao salvar. Tente de novo.', 409);
}
// POST /api/chip/create { chip } → adiciona um chip novo (cirúrgico, só diretor; nasce em aquecimento)
async function handleChipCreate(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!_podeMexerPressel(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const inp = (body && body.chip && typeof body.chip === 'object') ? body.chip : null;
  if (!inp || !String(inp.num || '').trim()) return err('num obrigatório');
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  if (!row) return err('Estado não encontrado', 404);
  let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
  if (!Array.isArray(data.chips)) data.chips = [];
  const nextId = Number(data.nextChip) || (data.chips.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0) + 1);
  const hoje = new Date().toISOString().split('T')[0];
  const maxIdx = data.chips.reduce((m, c) => Math.max(m, Number(c.idx) || 0), 0);
  const chip = {
    id: nextId,
    idx: Number(inp.idx) || (maxIdx + 1),
    num: String(inp.num || ''),
    at: inp.at ? String(inp.at) : null,
    mod: String(inp.mod || ''),
    op: String(inp.op || 'Vivo'),
    st: 'aquecimento', dia: 1, warm_start: hoje,
    wa_st: inp.wa_st ? String(inp.wa_st) : '',
    dia_uso: (inp.dia_uso === null || inp.dia_uso === '' || inp.dia_uso === undefined) ? null : Number(inp.dia_uso),
    rec: String(inp.rec || hoje), recv: 0, tags: [], note: String(inp.note || ''),
  };
  // Dono do numero. Chip nosso continua SEM o campo - e o que mantem a roleta de hoje identica.
  if (isAfiliado(u)) {
    const _a = aflDe(u);
    if (!_a) return err('Cadastro de afiliado incompleto', 403);
    chip.afl = _a;
  }
  data.chips.unshift(chip);
  data.nextChip = nextId + 1;
  const newVer = (row.version || 0) + 1;
  await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1')
    .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'chip:' + String(u.id)).run();
  return json({ ok: true, version: newVer, chip });
}
// POST /api/chip/delete { id } → remove um chip (cirúrgico, só diretor)
async function handleChipDelete(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!_podeMexerPressel(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const id = body && body.id;
  if (id == null) return err('id obrigatório');
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  if (!row) return err('Estado não encontrado', 404);
  let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
  if (!Array.isArray(data.chips)) return err('Sem chips', 404);
  const before = data.chips.length;
  // Idem pro numero: o afiliado so apaga o dele.
  if (isAfiliado(u)) {
    const _a = aflDe(u);
    const alvo = data.chips.find((c) => String(c.id) === String(id));
    if (!_a || !alvo || String(alvo.afl || '') !== _a) return err('Chip não encontrado', 404);
  }
  data.chips = data.chips.filter((c) => String(c.id) !== String(id));
  if (data.chips.length === before) return err('Chip não encontrado', 404);
  const newVer = (row.version || 0) + 1;
  await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1')
    .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'chip:' + String(u.id)).run();
  return json({ ok: true, version: newVer });
}
// POST /api/saque/create { valor, obs? } → vendedor pede saque da comissão a receber.
// Cirúrgico: grava data.saques (ciclo de vida pendente/aprovado/pago) + data.notifs (aviso pro diretor).
// Qualquer usuário autenticado pede o PRÓPRIO saque (não exige diretor). NUNCA o blob inteiro.
async function handleSaqueCreate(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const body = await req.json().catch(() => ({}));
  const valor = Math.round(Number(body && body.valor) * 100) / 100;
  if (!valor || !(valor > 0)) return err('valor inválido');
  const obs = String((body && body.obs) || '').slice(0, 300);
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  if (!row) return err('Estado não encontrado', 404);
  let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
  if (!Array.isArray(data.saques)) data.saques = [];
  if (!Array.isArray(data.notifs)) data.notifs = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const nome = String(u.name || u.login || u.id);
  const nextId = data.saques.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0) + 1;
  const saque = {
    id: nextId,
    user_id: String(u.id),
    nome,
    com_pct: (u.com_pct != null ? Number(u.com_pct) : null),
    valor,
    status: 'pendente',
    obs,
    solicitado_em: nowSec,
    aprovado_por: null, aprovado_em: null, pago_em: null, pago_por: null,
  };
  data.saques.unshift(saque);
  const valorTxt = 'R$ ' + valor.toFixed(2).replace('.', ',');
  const nextNotif = data.notifs.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0) + 1;
  data.notifs.unshift({
    id: nextNotif,
    type: 'saque',
    title: 'Solicitação de saque',
    description: `${nome} solicitou saque de ${valorTxt}`,
    to: 'diretor',
    from_id: String(u.id),
    unread: true,
    ts: nowSec,
    ref: 'saque:' + nextId,
    link: '/dashboard/finance',
  });
  const newVer = (row.version || 0) + 1;
  await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1')
    .bind(JSON.stringify(data), newVer, nowSec, 'saque:' + String(u.id)).run();
  return json({ ok: true, version: newVer, saque });
}

// POST /api/gasto/estorno { key, estornado } → marca/desmarca um gasto do ContaSimples como ESTORNADO.
// Gasto estornado (ex.: cobrança de verificação do cartão reembolsada) sai do total de gastos e do lucro.
// key = cs_id (preferido, estável) ou id do gasto. Só diretor. Escrita com CAS (não atropela webhook concorrente).
async function handleGastoEstorno(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const key = String((body && body.key) != null ? body.key : '').trim();
  if (!key) return err('key obrigatório');
  const estornado = !!(body && body.estornado);
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
    const arr = Array.isArray(data.gastos) ? data.gastos : [];
    const g = arr.find((x) => (x.cs_id != null && String(x.cs_id) === key) || String(x.id) === key);
    if (!g) return err('Gasto não encontrado', 404);
    if (estornado) g.estornado = true; else delete g.estornado;
    const ok = await _casState(env, row.version, data, 'gasto-estorno:' + String(u.id));
    if (ok) return json({ ok: true, key, estornado });
  }
  return json({ ok: false, busy: true, error: 'estado ocupado, reenvie' }, 409);
}

// POST /api/saque/update { id, status } → o Financeiro PROCESSA o saque do funcionário (pagar/recusar). Só diretor.
// 'pago' marca pago_em/pago_por + registra 1 linha em data.payouts (o repasse) + avisa o funcionário.
// A comissão já está no lucro (accrual); o payout é o REGISTRO do pagamento, não conta de novo como despesa.
async function handleSaqueUpdate(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas o Financeiro pode processar saques', 403);
  const body = await req.json().catch(() => ({}));
  const id = body && body.id;
  const status = String((body && body.status) || '').toLowerCase();
  if (id == null) return err('id obrigatório');
  if (!['pago', 'recusado', 'aprovado', 'pendente'].includes(status)) return err('status inválido');
  const nowSec = Math.floor(Date.now() / 1000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
    const arr = Array.isArray(data.saques) ? data.saques : [];
    const s = arr.find((x) => String(x.id) === String(id));
    if (!s) return err('Saque não encontrado', 404);
    s.status = status;
    if (status === 'pago') {
      s.pago_em = nowSec; s.pago_por = String(u.id);
      if (!s.aprovado_em) { s.aprovado_em = nowSec; s.aprovado_por = String(u.id); }
      if (!Array.isArray(data.payouts)) data.payouts = [];
      if (!data.payouts.some((p) => String(p.saque_id) === String(s.id))) {
        const pid = data.payouts.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0) + 1;
        data.payouts.unshift({ id: pid, saque_id: s.id, user_id: s.user_id, nome: s.nome, valor: s.valor, kind: 'saque', ts: nowSec, por: String(u.id) });
      }
    } else if (status === 'aprovado') { s.aprovado_em = nowSec; s.aprovado_por = String(u.id); }
    else if (status === 'recusado') { s.recusado_em = nowSec; s.recusado_por = String(u.id); }
    // Avisa o funcionário
    if (!Array.isArray(data.notifs)) data.notifs = [];
    const nid = data.notifs.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0) + 1;
    const valorTxt = 'R$ ' + Number(s.valor || 0).toFixed(2).replace('.', ',');
    const msg = status === 'pago' ? `Seu saque de ${valorTxt} foi PAGO` : status === 'recusado' ? `Seu saque de ${valorTxt} foi recusado` : `Seu saque de ${valorTxt} foi ${status}`;
    data.notifs.unshift({ id: nid, type: 'saque', title: 'Atualização do saque', description: msg, to: String(s.user_id), from_id: String(u.id), unread: true, ts: nowSec, ref: 'saque:' + s.id, link: '/dashboard/settings/profile' });
    const ok = await _casState(env, row.version, data, 'saque-update:' + String(u.id));
    if (ok) return json({ ok: true, id: s.id, status });
  }
  return json({ ok: false, busy: true, error: 'estado ocupado, reenvie' }, 409);
}
// POST /api/acl/save { acl } → salva a matriz de permissões por cargo (data.acl). Só diretor. Cirúrgico.
// acl = { <cargo>: { <area>: 0|1, ... }, ... } — só cargos restritos; full sempre têm acesso total.
async function handleAclSave(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const acl = (body && body.acl && typeof body.acl === 'object' && !Array.isArray(body.acl)) ? body.acl : null;
  if (!acl) return err('acl obrigatório');
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  if (!row) return err('Estado não encontrado', 404);
  let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
  data.acl_v2 = acl; // campo NOVO (não colide com a ACL legada da AXION em data.acl)
  const newVer = (row.version || 0) + 1;
  await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1')
    .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'acl:' + String(u.id)).run();
  return json({ ok: true, version: newVer });
}
// POST /api/cont/save { wa_statuses?, contCols?, contColColors?, cont_col_order? } → patch cirúrgico da
// config da Contingência (catálogo de status WhatsApp + colunas custom). Só diretor. NUNCA o blob inteiro.
// AS COLUNAS DA CONTINGENCIA TEM DONO (25/08/2026, pedido do Bruno: "usa a nossa contingencia que a
// gente tem hoje, as colunas, como base pra eles, e caso queiram editar, acesso total").
//
// COMO FUNCIONA: as nossas ficam em contCols/wa_statuses/etc. As do afiliado ficam nas MESMAS
// chaves com o id dele no fim (contCols__afl_xxx). Na leitura, se ele ainda nao tem as dele, ele
// recebe uma COPIA das nossas - e a partir do primeiro ajuste passa a ter as proprias. Assim ele
// comeca com a nossa organizacao pronta e mexe a vontade sem nunca tocar na nossa.
const _sufAfl = (u) => (isAfiliado(u) && aflDe(u)) ? ('__' + aflDe(u)) : '';
// Mesmo sufixo, mas valendo pro MUNDO dele (o afiliado E quem trabalha pra ele). Tag e catalogo
// de equipe: o vendedor dele precisa ver e marcar a mesma etiqueta que o chefe criou.
const _sufMundoAfl = (u) => ((noMundoAfiliado(u) || afiliadoSemVinculo(u)) && aflDe(u)) ? ('__' + aflDe(u)) : '';
// O catalogo de tags que vale PRA ESTA PESSOA: o do mundo dela, se existir.
const _tagsDe = (data, u) => {
  const sfx = _sufMundoAfl(u);
  const minhas = sfx ? data['tags' + sfx] : data.tags;
  return Array.isArray(minhas) ? minhas : [];
};
const _CHAVES_CONT = ['wa_statuses', 'contCols', 'contColColors', 'cont_col_order'];

async function handleContConfig(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // O afiliado gerencia a contingencia DELE. Sem isto a tela abria e nenhum botao funcionava.
  if (!isDirector(u) && !isAfiliado(u)) return err('Sem permissão', 403);
  if (afiliadoSemVinculo(u)) return err('Sem permissão', 403);
  const body = await req.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  if (!row) return err('Estado não encontrado', 404);
  let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
  const sfx = _sufAfl(u);   // '' pro diretor = grava nas chaves da casa
  if (Array.isArray(body.wa_statuses)) data['wa_statuses' + sfx] = body.wa_statuses;
  if (Array.isArray(body.contCols)) data['contCols' + sfx] = body.contCols;
  if (body.contColColors && typeof body.contColColors === 'object') data['contColColors' + sfx] = body.contColColors;
  if (Array.isArray(body.cont_col_order)) data['cont_col_order' + sfx] = body.cont_col_order;
  const newVer = (row.version || 0) + 1;
  await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1')
    .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'cont:' + String(u.id)).run();
  return json({ ok: true, version: newVer });
}
// POST /api/tags/save { tags: [...] } → grava SO o catalogo de etiquetas do CRM.
//
// Antes isso ia pelo POST /api/state generico: a tela baixava o blob inteiro, trocava `tags` e
// mandava tudo de volta. Funcionava pra quem recebe o blob completo, mas o AFILIADO recebe podado,
// entao `tags` estava na lista de chaves restauradas do banco e a gravacao dele era descartada em
// silencio. Aqui e cirurgico e cada mundo grava a chave dele: a casa em `tags`, o afiliado em
// `tags__<afl>` (mesma convencao das colunas da Contingencia).
async function handleTagsSave(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const _cob = String(u.role || '').toLowerCase() === 'cobrador';
  const _afl = noMundoAfiliado(u) || afiliadoSemVinculo(u);
  if (!isDirector(u) && !_cob && !_afl) return err('Sem permissão', 403);
  if (_afl && !aflDe(u)) return err('Cadastro de afiliado incompleto', 403);
  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body.tags)) return err('tags obrigatório');
  // Teto: isto aceita array vindo do navegador e o blob tem limite de 1 MB.
  const limpas = body.tags.slice(0, 200).map((t) => ({
    id: String((t && t.id) || '').slice(0, 60),
    name: String((t && t.name) || '').slice(0, 60),
    color: String((t && t.color) || '').slice(0, 30),
  })).filter((t) => t.id && t.name);
  const chave = 'tags' + _sufMundoAfl(u);
  for (let tent = 0; tent < 6; tent++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return err('Estado não encontrado', 404);
    let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
    data[chave] = limpas;
    const newVer = (row.version || 0) + 1;
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'tags:' + String(u.id), row.version).run();
    if (res && res.meta && res.meta.changes > 0) return json({ ok: true, version: newVer, tags: limpas });
    await new Promise((r) => setTimeout(r, 12 * (tent + 1)));
  }
  return err('Conflito ao salvar. Tente de novo.', 409);
}
// Salva o Sale Chat (cirúrgico, só diretor). Body { profile:'vend'|'cob', draft:{messages,media,sequences,triggers}, publish? }.
// Escreve SÓ as fatias do salechat (rascunho + pub no publish), nunca o blob inteiro → sem risco pro resto.
async function handleSaleChatSave(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const dir = isDirector(u);
  const body = await req.json().catch(() => ({}));
  const profile = (body && body.profile === 'cob') ? 'cob' : 'vend';
  const draft = body && body.draft;
  if (!draft || typeof draft !== 'object') return err('draft obrigatório');
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  if (!row) return err('Estado não encontrado', 404);
  let data; try { data = JSON.parse(row.data); } catch (e) { return err('Estado inválido', 500); }
  const arr = (x) => Array.isArray(x) ? x : [];
  const now = Math.floor(Date.now() / 1000);
  // PASSO SEM ITEM NAO ENTRA NO ESTADO. Em 18/08/2026 um bug do seletor da tela gravou tres passos
  // com id vazio; o funil ficava com cara de montado e o motor descartava aqueles passos, entao o
  // cliente recebia menos do que estava na tela e ninguem via. O bug do front foi corrigido, mas a
  // porta fica fechada aqui: e um lugar so, e vale pra qualquer tela que venha a gravar errado.
  const _limpaSeqs = (seqs) => arr(seqs).map((s2) => {
    if (!s2 || typeof s2 !== 'object') return s2;
    const itens = arr(s2.items).filter((it) => (typeof it === 'string' ? it.trim() : String((it && it.id) || '').trim()));
    return { ...s2, items: itens };
  });
  // DISPARO AUTOMATICO no lead novo. Vem junto do salvamento do Sale Chat porque e la que o funil
  // e montado - separar em outro endpoint faria a escolha e o funil viverem em telas diferentes.
  // So DIRETOR muda: e uma regra da operacao inteira, nao preferencia de um vendedor.
  if (dir && body && body.funil_auto && typeof body.funil_auto === 'object') {
    const fa = body.funil_auto;
    data.funil_auto = {
      on: !!fa.on,
      seq_id: String(fa.seq_id || '').slice(0, 80),
      delay_s: Math.max(0, Math.min(60, Number(fa.delay_s) || 1)),
    };
  }
  const clean = { messages: arr(draft.messages), media: arr(draft.media), sequences: _limpaSeqs(draft.sequences), triggers: arr(draft.triggers), updated_at: now };
  const pubOf = () => ({ messages: clean.messages, media: clean.media, sequences: clean.sequences, triggers: clean.triggers, updated_at: now, published_at: now, published_by: String((u.name || u.id) || '') });
  if (dir) {
    // diretor edita o MODELO (vendedores ou cobradores)
    const draftKey = profile === 'cob' ? 'salechatCob' : 'salechat';
    const pubKey = profile === 'cob' ? 'salechatCobPub' : 'salechatPub';
    if ((data[draftKey] || {}).champSeeded) clean.champSeeded = true;
    data[draftKey] = clean;
    if (body.publish) data[pubKey] = pubOf();
  } else {
    // vendedor edita SÓ a cópia DELE (scVend[uid]), nunca o modelo; cobradores não têm slot por-usuário nesta fase
    const uid = String(u.id);
    if (!data.scVend || typeof data.scVend !== 'object') data.scVend = {};
    if ((data.scVend[uid] || {}).champSeeded) clean.champSeeded = true;
    data.scVend[uid] = clean;
    if (body.publish) {
      if (!data.scVendPub || typeof data.scVendPub !== 'object') data.scVendPub = {};
      data.scVendPub[uid] = pubOf();
    }
  }
  const newVer = (row.version || 0) + 1;
  await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1')
    .bind(JSON.stringify(data), newVer, now, 'salechat:' + String(u.id)).run();
  return json({ ok: true, version: newVer, updated_at: now, published: !!body.publish });
}

// GET /api/salechat/mine → editor do VENDEDOR: a cópia dele (scVend), semeada do modelo publicado quando ainda não editou
async function handleSaleChatMine(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let data = {}; try { data = JSON.parse(row?.data || '{}'); } catch (e) { data = {}; }
  const uid = String(u.id);
  // COBRADOR PARTE DO ROTEIRO DE COBRANCA, nao do de vendas. O Bruno liberou esta tela pra eles em
  // 24/08/2026 pra acrescentarem mensagem e audio proprios; semeando do modelo de VENDEDOR, o
  // cobrador abria a tela cheia de script de venda ("Fechar pedido", "Pedir dados") e nenhum dos
  // audios de cobranca. A copia continua sendo dele (scVend[uid]) - ele nunca escreve no modelo.
  const ehCob = String(u.role || '').toLowerCase() === 'cobrador';
  // NO MUNDO DO AFILIADO NAO HA MODELO DA CASA (25/08/2026). Aqui a copia de cada pessoa nasce
  // semeada do nosso roteiro; pro afiliado e pra equipe dele isso entregava justamente o funil e os
  // audios que o Bruno mandou separar. Eles comecam do zero e montam o proprio.
  const _semModelo = noMundoAfiliado(u) || afiliadoSemVinculo(u);
  const model = _semModelo ? {} : (ehCob
    ? (data.salechatCobPub || data.salechatCob || {})
    : (data.salechatPub || data.salechat || {}));
  const slotDraft = (data.scVend && data.scVend[uid]) || null;
  const slotPub = (data.scVendPub && data.scVendPub[uid]) || null;
  // O MODELO SEMPRE ENTRA, E ELE MANDA.
  //
  // Antes era `slotDraft || slotPub || model`: bastava a pessoa ter uma copia propria pra ela NUNCA
  // MAIS enxergar o que o diretor publicasse depois. A copia nasce na primeira vez que ela salva
  // qualquer coisa e congela ali. Medido em 25/08/2026: o modelo tinha 12 mensagens, 34 midias e 15
  // funis; a copia do vendedor tinha 8, 22 e 9, e nenhum item proprio - ou seja ele so estava
  // PERDENDO 4 mensagens, 12 midias e 6 funis que o socio publicou depois. E o mesmo material que o
  // Inbox mostra pra ele (o Inbox le o modelo publicado direto), entao a mesma pessoa via duas
  // listas diferentes na mesma dash. Palavras do Bruno: "quero que apareca tudo que tem hoje no ar".
  //
  // Regra: item do MODELO sempre aparece e vale a versao do modelo; o que a pessoa acrescentou por
  // conta propria (id que nao existe no modelo) fica junto, no fim. Item do modelo que ela apagou
  // volta - de proposito: o roteiro do diretor nao e opcional. Casar por id e seguro porque todo
  // item tem id estavel (m1, f1, seq_abertura, mmsz0tabr6xv...) e os funis referenciam midia por
  // esse mesmo id, entao trazer o funil do modelo traz junto a midia que ele usa.
  const juntar = (base, extra) => {
    const out = {};
    for (const balde of ['messages', 'media', 'sequences', 'triggers']) {
      const m = Array.isArray(base && base[balde]) ? base[balde] : [];
      const e = Array.isArray(extra && extra[balde]) ? extra[balde] : [];
      const jaTem = new Set(m.map((x) => x && x.id).filter(Boolean));
      out[balde] = m.concat(e.filter((x) => x && x.id && !jaTem.has(x.id)));
    }
    return out;
  };
  return json({ ok: true, draft: juntar(model, slotDraft || slotPub), pub: juntar(model, slotPub), seeded: !!(slotDraft || slotPub) });
}
// Roster de cartões do ContaSimples (data.cs_cards). GET lê; POST substitui a lista (cirúrgico, só diretor).
async function handleCsCards(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
  let data = {};
  try { data = JSON.parse(row?.data || '{}'); } catch (e) { data = {}; }
  if (!isDirector(u)) return err('Sem permissão', 403);
  if (req.method === 'GET') return json({ cards: Array.isArray(data.cs_cards) ? data.cs_cards : [] });
  if (!row) return err('Estado não encontrado', 404);
  const body = await req.json().catch(() => ({}));
  const cards = Array.isArray(body.cards) ? body.cards : [];
  data.cs_cards = cards;
  const newVer = (row.version || 0) + 1;
  await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1')
    .bind(JSON.stringify(data), newVer, Math.floor(Date.now() / 1000), 'cscards:' + String(u.id)).run();
  return json({ ok: true, version: newVer, cards });
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

  // Poda o que este cargo nao pode escrever ANTES de qualquer conferencia: pra quem nao e diretor o
  // GET nem mandou essas chaves, entao o blob que volta vem sem elas e a guarda de baixo leria isso
  // como "apagou 123 gastos" e recusaria a gravacao inteira (422) numa tela legitima.
  let _atual = {}; try { _atual = JSON.parse(current?.data || '{}'); } catch (_) { _atual = {}; }
  body.data = _stateProtegido(u, body.data, _atual);

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

// ── FOTO DE PERFIL FORA DO JSON ──────────────────────────────────────────────
//
// As fotos sao guardadas como data URI na coluna users.photo, e o /api/users devolvia isso inteiro.
// Medido em 18/08/2026: a lista de 7 pessoas pesava 225 KB, sendo 224 KB de foto - a do Guilherme
// sozinha tem 187 KB. Dez telas chamam /api/users, e toda chamada rebaixava tudo de novo, porque
// JSON nao entra no cache do navegador. Era a maior parte da lentidao ao trocar de tela.
//
// Agora a lista devolve uma URL no lugar do data URI. Como o front sempre usa o campo dentro de um
// <img src>, nada muda pra ele; e a imagem passa a ser um arquivo de verdade, com cache de 1 ano.
// O hash do conteudo vai NA URL: trocou a foto, muda a URL, e o cache velho nao atrapalha.
function _fotoHash(txt) {
  // hash curto e estavel (FNV-1a). Nao precisa ser cripto: so serve pra invalidar cache.
  let h = 2166136261;
  const t = String(txt || '');
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function _fotoUrl(req, id, photo) {
  if (!photo) return null;
  const p = String(photo);
  if (!p.startsWith('data:')) return p;   // ja e URL (ou veio de fora): passa direto
  const origem = new URL(req.url).origin;
  return origem + '/api/users/foto/' + encodeURIComponent(String(id)) + '/' + _fotoHash(p);
}
// GET /api/users/foto/:id/:hash  → a imagem de verdade, cacheavel. Publica de proposito: <img> nao
// manda cabecalho de autorizacao, e o que ela expoe e um avatar de equipe atras de um hash.
async function handleUserPhoto(req, env, id) {
  const row = await env.DB.prepare('SELECT photo FROM users WHERE id = ?').bind(String(id)).first().catch(() => null);
  const p = String((row && row.photo) || '');
  if (!p.startsWith('data:')) return new Response('sem foto', { status: 404 });
  const m = p.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!m) return new Response('foto invalida', { status: 404 });
  const mime = m[1] || 'image/jpeg';
  let corpo;
  if (m[2]) {
    const bin = atob(m[3]);
    corpo = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) corpo[i] = bin.charCodeAt(i);
  } else {
    corpo = decodeURIComponent(m[3]);
  }
  return new Response(corpo, {
    headers: {
      'content-type': mime,
      // immutable porque a URL carrega o hash do conteudo: foto nova = URL nova.
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  });
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
      'SELECT id, login, name, abbr, role, color, bg, com_pct, email, com_ant, com_ent, COALESCE(salario, 0) AS salario, photo, banner, created_at, ' +
      'COALESCE(archived, 0) AS archived, archived_at, afiliado_id, ' +
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
    try {
      await env.DB.prepare('ALTER TABLE users ADD COLUMN salario REAL DEFAULT 0').run();
    } catch (_) {}
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN photo TEXT').run(); } catch (_) {}
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN banner TEXT').run(); } catch (_) {}
    // Vendedores (14/08/2026): e-mail e as DUAS comissões (antecipado x entrega), como na Midas.
    // É por aqui que elas nascem: a primeira listagem falha por coluna inexistente e cai neste catch.
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN email TEXT').run(); } catch (_) {}
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN com_ant REAL').run(); } catch (_) {}
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN com_ent REAL').run(); } catch (_) {}
    rows = await env.DB.prepare(
      'SELECT id, login, name, abbr, role, color, bg, com_pct, email, com_ant, com_ent, COALESCE(salario, 0) AS salario, photo, banner, created_at, ' +
      'COALESCE(archived, 0) AS archived, archived_at, afiliado_id, ' +
      'CASE WHEN pwd_hash IS NOT NULL AND pwd_hash != "" THEN 1 ELSE 0 END AS has_password ' +
      'FROM users ORDER BY archived ASC, name'
    ).all();
  }
  // DOIS MUNDOS, DUAS LISTAS (25/08/2026, pedido do Bruno: "a dash dele de afiliado e algo a parte,
  // nao quero nenhuma ligacao"). A regra e simetrica:
  //   - quem e do mundo de um afiliado ve SO o mundo dele;
  //   - o PRODUTOR ve so a equipe DA CASA. O afiliado e o time dele NAO entram no "Diretorio de
  //     usuarios": ele criou um vendedor dentro da area do Giovane e o vendedor apareceu na lista
  //     dele, como se fosse funcionario nosso. Afiliado se gerencia no acordeao de Afiliados.
  // `?afiliado=<id>` e a excecao explicita, pra nossa area de Afiliados poder mostrar a equipe de
  // um deles quando pedirmos. Nunca e o padrao.
  if (noMundoAfiliado(u) || afiliadoSemVinculo(u)) {
    const meuAfl = aflDe(u);
    if (rows && rows.results) rows = { ...rows, results: rows.results.filter((r) => meuAfl && String(r.afiliado_id || '') === meuAfl) };
  } else if (rows && rows.results) {
    const _quer = String(new URL(req.url).searchParams.get('afiliado') || '').trim();
    rows = { ...rows, results: rows.results.filter((r) => (_quer ? String(r.afiliado_id || '') === _quer : !r.afiliado_id)) };
  }
  // Comissão, salário e e-mail são do DIRETOR. Todo cargo restrito (vendedor, cobrador, gestor de
  // tráfego) chama este endpoint só pra saber NOME de quem é quem, e estava recebendo a folha inteira
  // da equipe junto. Aqui a resposta encolhe pro que a tela dele precisa.
  if (!isDirector(u)) {
    // A PROPRIA COMISSAO E DELE. Esconder a taxa dos OUTROS esta certo; esconder a DO PROPRIO
    // vendedor quebrava a tela dele: sem com_pct a conta cai em zero e o painel mostrava o pedido
    // mas "R$ 0,00" em comissao, como se ele nao tivesse vendido nada. Foi o que o Guilherme
    // reportou em 19/08/2026. Cada um ve a sua linha completa; a dos colegas continua so com nome,
    // cor e foto.
    const meu = String(u.id);
    // O AFILIADO PRECISA DA LINHA COMPLETA DA EQUIPE DELE (auditoria 24/08/2026), e a falta disso
    // DESTRUIA DADO: sem com_pct/com_ant/com_ent/salario na resposta, o formulario da Lista de
    // Usuarios abria com 0, e o Salvar - que manda todos os campos - gravava 0 por cima da comissao
    // real do vendedor dele. Ele so queria corrigir o nome e apagava a remuneracao no banco.
    // E dele o mundo: pode ver a remuneracao de quem ele mesmo contratou. A dos NOSSOS continua
    // fora (a condicao exige o afiliado_id dele).
    const meuAfl = isAfiliado(u) ? aflDe(u) : null;
    const linhaCheia = (r) => String(r.id) === meu || (!!meuAfl && String(r.afiliado_id || '') === meuAfl);
    return json({ users: (rows.results || []).map((r) => ({
      id: r.id, name: r.name, login: r.login, role: r.role, abbr: r.abbr,
      color: r.color, bg: r.bg, photo: _fotoUrl(req, r.id, r.photo), archived: r.archived,
      ...(linhaCheia(r) ? { com_pct: r.com_pct, com_ant: r.com_ant, com_ent: r.com_ent, email: r.email, salario: r.salario, created_at: r.created_at, has_password: r.has_password } : {}),
    })) });
  }
  // banner tambem sai da lista: e imagem grande e NENHUMA tela de lista usa (so o proprio perfil,
  // que le do usuario logado).
  return json({ users: (rows.results || []).map((r) => ({ ...r, photo: _fotoUrl(req, r.id, r.photo), banner: r.banner ? '1' : null })) });
}

async function handleCreateOrUpdateUser(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // Permissão: diretor gerencia qualquer um; não-diretor só edita o PRÓPRIO perfil (campos sensíveis ficam travados abaixo).
  const isDir = isDirector(u);

  const body = await req.json().catch(() => null);
  if (!body) return err('Body inválido');
  const { id, login, password, name, abbr, role, color, bg, com_pct, salario, photo, banner, email, com_ant, com_ent } = body;
  if (!name || !login || !role) return err('Campos obrigatórios: name, login, role');
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN salario REAL DEFAULT 0').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN photo TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN banner TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN email TEXT').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN com_ant REAL').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN com_ent REAL').run(); } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN afiliado_id TEXT').run(); } catch (_) {}

  const loginNorm = String(login).toLowerCase().trim();

  // Detecta create vs update
  const existing = id ? await env.DB.prepare('SELECT id, pwd_hash FROM users WHERE id = ?').bind(id).first() : null;

  // Só o diretor cria usuário ou edita outra pessoa. Não-diretor só mexe no próprio registro.
  const isSelf = existing && String(id) === String(u.id);
  // O AFILIADO MONTA A PROPRIA EQUIPE (23/08/2026): "ele vai ter os proprios cobradores dele, os
  // proprios vendedores dele". Ele cria e edita gente DENTRO do mundo dele e so nos cargos de
  // operacao - nunca diretor, nunca outro afiliado, e nunca alguem de fora do afiliado dele.
  // OS CARGOS QUE O AFILIADO CONTRATA. 'gestor' entrou em 24/08/2026 a pedido do Bruno: o afiliado
  // tem gestor de trafego proprio, que lanca o gasto DELE (trafego_registros com o afl dele) e le o
  // dashboard de trafego dele. Nunca 'diretor'/'socio'/'produtor' e nunca outro 'afiliado': isso
  // criaria alguem fora do mundo dele, ou um segundo dono pro mesmo mundo.
  const CARGOS_DO_AFILIADO = ['vendedor', 'atendente', 'cobrador', 'gestor', 'designer'];
  const aflDono = aflDe(u);
  let comoAfiliado = false;
  if (!isDir && isAfiliado(u) && aflDono) {
    const alvoJaEDele = existing
      ? String((await env.DB.prepare('SELECT afiliado_id FROM users WHERE id=?').bind(id).first() || {}).afiliado_id || '') === aflDono
      : true;
    if (alvoJaEDele && CARGOS_DO_AFILIADO.includes(String(role || '').toLowerCase())) comoAfiliado = true;
  }
  if (!isDir && !isSelf && !comoAfiliado) return err('Apenas Diretor pode gerenciar usuários', 403);
  // Campos privilegiados (login, cargo, comissão, salário) só o diretor altera; no self-edit são preservados.
  const canPriv = isDir || comoAfiliado;
  // A QUE MUNDO A PESSOA PERTENCE. Quem o afiliado cria nasce carimbado com o afiliado DELE, sem
  // ele poder escolher: e o campo que decide o que a pessoa enxerga. O diretor pode carimbar de
  // proposito (mover alguem pro time de um afiliado). Ninguem mais mexe nisso.
  const aflB = comoAfiliado ? aflDono : (isDir && body.afiliado_id !== undefined ? (String(body.afiliado_id || '').trim() || null) : null);

  // Login único (só barra quando o login vai de fato ser gravado)
  const dup = await env.DB.prepare('SELECT id FROM users WHERE lower(login) = ? AND id != ?').bind(loginNorm, id || '').first();
  if (dup && (canPriv || !existing)) return err('Login já está em uso', 409);

  let pwdHash = existing?.pwd_hash || null;
  if (password) {
    if (String(password).length < 6) return err('Senha precisa ter pelo menos 6 caracteres');
    // TROCAR A PRÓPRIA SENHA EXIGE A SENHA ATUAL. Sem isto, qualquer um que pegasse a dash aberta
    // (o celular do vendedor na mesa, o navegador do escritório) trocava a senha dele e o dono
    // perdia a conta. O diretor continua podendo redefinir a senha de alguém sem saber a antiga:
    // é ele quem socorre quem esqueceu.
    if (!isDir && isSelf) {
      const atual = String((body && (body.senha_atual || body.current_password)) || '');
      if (!atual) return err('Informe a senha atual pra trocar a senha', 400);
      const hashAtual = await sha256Hex(atual);
      if (!existing?.pwd_hash || hashAtual !== existing.pwd_hash) return err('Senha atual não confere', 403);
    }
    pwdHash = await sha256Hex(password);
  }
  if (!pwdHash) return err('Senha obrigatória ao criar usuário');

  // Cada campo opcional: só sobrescreve se vier no body (COALESCE mantém o atual quando não vier).
  // Assim o perfil pessoal (que manda só name/login/role) não zera salário/comissão/cor, e a foto não some.
  // A LISTA NAO MANDA MAIS O DATA URI, manda a URL da foto (ver _fotoUrl). Entao, quando a tela de
  // perfil salva sem trocar a imagem, o que volta e a URL - e gravar isso apagaria a foto de
  // verdade. Aqui a URL nossa (e o marcador '1' do banner) contam como "nao mexeu": vira null e o
  // COALESCE do UPDATE mantem o que ja estava. String vazia continua sendo "remover", que e o botao
  // Remover da tela.
  const _naoMexeu = (v) => { const t = String(v || ''); return t !== '' && !t.startsWith('data:') && (t.includes('/api/users/foto/') || t === '1'); };
  const photoB = (photo == null || _naoMexeu(photo)) ? null : String(photo);
  const bannerB = (banner == null || _naoMexeu(banner)) ? null : String(banner);
  const abbrB = (abbr === undefined) ? null : (abbr || null);
  const colorB = (color === undefined) ? null : (color || null);
  const bgB = (bg === undefined) ? null : (bg || null);
  // Privilegiados: no self-edit de não-diretor viram null (COALESCE preserva o valor atual).
  const loginB = canPriv ? loginNorm : null;
  const roleB = canPriv ? role : null;
  const comPctB = (!canPriv || com_pct === undefined) ? null : (Number(com_pct) || 0);
  const salarioB = (!canPriv || salario === undefined) ? null : (Number(salario) || 0);
  // E-mail e as duas comissões: mesma regra dos privilegiados (só diretor muda) e COALESCE
  // pra o perfil pessoal, que manda só name/login/role, não zerar o que o diretor cadastrou.
  const emailB = (!canPriv || email === undefined) ? null : (String(email || '').trim() || null);
  const comAntB = (!canPriv || com_ant === undefined) ? null : (Number(com_ant) || 0);
  const comEntB = (!canPriv || com_ent === undefined) ? null : (Number(com_ent) || 0);
  if (existing) {
    // Update
    await env.DB.prepare(
      `UPDATE users SET afiliado_id=COALESCE(?, afiliado_id), login=COALESCE(?, login), pwd_hash=?, name=?, abbr=COALESCE(?, abbr), role=COALESCE(?, role), color=COALESCE(?, color), bg=COALESCE(?, bg), com_pct=COALESCE(?, com_pct), salario=COALESCE(?, salario), photo=COALESCE(?, photo), banner=COALESCE(?, banner), email=COALESCE(?, email), com_ant=COALESCE(?, com_ant), com_ent=COALESCE(?, com_ent) WHERE id=?`
    ).bind(aflB, loginB, pwdHash, name, abbrB, roleB, colorB, bgB, comPctB, salarioB, photoB, bannerB, emailB, comAntB, comEntB, id).run();
    // Espelha de volta no cadastro de afiliado quando o percentual e editado pela Lista de
    // Usuarios: sem isto, as duas telas voltariam a divergir pelo outro lado.
    if (String(role || '').toLowerCase() === 'afiliado' && comPctB != null) {
      try {
        const _r = await env.DB.prepare('SELECT afiliado_id FROM users WHERE id=?').bind(id).first();
        if (_r && _r.afiliado_id) await env.DB.prepare('UPDATE five_affiliates SET pct=? WHERE affiliate_id=?').bind(comPctB, _r.afiliado_id).run();
      } catch (_) {}
    }
    return json({ ok: true, id, action: 'updated' });
  } else {
    // Create — gera id se não veio
    const newId = id || `${role}_${Math.random().toString(36).slice(2, 8)}`;
    // CARGO AFILIADO CRIADO POR AQUI TAMBEM VIRA AFILIADO DE VERDADE. O Bruno cadastrou o Giovane
    // pela Lista de Usuarios, que e o caminho natural de quem esta criando "mais um usuario" - e
    // ficava um afiliado sem afiliado_id, ou seja, sem dono dos pedidos. Em vez de proibir a tela
    // (ele ia bater na parede sem entender), ela passa a fazer a coisa certa: cria a linha em
    // five_affiliates e amarra o usuario nela. Os dois caminhos levam ao mesmo lugar.
    let aflFinal = aflB;
    if (!aflFinal && isDir && String(role || '').toLowerCase() === 'afiliado') {
      try {
        await _ensureFiveTables(env);
        const novoAfl = _afilId();
        const agoraS = Math.floor(Date.now() / 1000);
        await env.DB.prepare('INSERT INTO five_affiliates (affiliate_id, name, pct, status, origem, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
          .bind(novoAfl, name, (Number(com_pct) || null), 'ativo', 'manual', agoraS, agoraS).run();
        aflFinal = novoAfl;
      } catch (_) { /* se falhar, o usuario nasce sem vinculo - e o fail-closed nao deixa ele ver nada */ }
    }
    await env.DB.prepare(
      `INSERT INTO users (id, afiliado_id, login, pwd_hash, name, abbr, role, color, bg, com_pct, salario, photo, banner, email, com_ant, com_ent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(newId, aflFinal, loginNorm, pwdHash, name, abbr || null, role, color || null, bg || null, Number(com_pct) || 0, Number(salario) || 0, photoB, bannerB, emailB, comAntB, comEntB).run();
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
let _cfgTablesOk = false, _waTablesOk = false, _scTablesOk = false, _saleTablesOk = false, _leadTablesOk = false, _attribTablesOk = false, _cpfTablesOk = false, _fiveTablesOk = false;
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

  // VALOR DA VENDA, SEM O JURO DO PARCELAMENTO (em CENTAVOS no payload da Payt).
  //
  // total_price e o que o CLIENTE paga: no cartao parcelado ele vem inflado pelo juro da operadora,
  // que nao e receita do produtor. A propria Payt entrega o numero certo ao lado, e o nome do campo
  // nao deixa duvida: `price_without_installments`. Payload real de 24/08/2026 (Jose Francisco):
  //   total_price 54112 | installments 4 | installment_price 13528 | price_without_installments 49700
  // Ou seja: R$ 541,12 pagos em 4x de R$ 135,28 num kit de R$ 497,00.
  // Palavras do Bruno: "esse valor mais alto e apenas juros, o que eu recebo sempre vai ser 497".
  const amount = tx.price_without_installments != null
    ? Number(tx.price_without_installments) / 100
    : (tx.total_price != null
      ? Number(tx.total_price) / 100
      : Number(order.total_amount || order.amount || order.valor || order.total || body?.amount || body?.valor || 0));
  // O que o cliente pagou de verdade (com juro) e em quantas vezes. Nao entra em receita nenhuma:
  // existe pra conferir com a fatura e pra tela poder explicar a diferenca.
  const amount_pago = tx.total_price != null ? Number(tx.total_price) / 100 : amount;
  const parcelas = tx.installments != null ? Number(tx.installments) : null;
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
    amount_pago,
    parcelas,
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
  return _atFromInst(instance);
}

// Extrai um CPF (11 dígitos) de texto livre: tenta o rótulo "CPF:" primeiro,
// depois o formato pontuado, e por fim qualquer sequência isolada de 11 dígitos.
// Valida CPF pelo dígito verificador (usado só no fallback de 11 dígitos crus).
function _cpfValid(d) {
  if (!/^\d{11}$/.test(d)) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // todos iguais
  let s = 0; for (let i = 0; i < 9; i++) s += Number(d[i]) * (10 - i);
  let r = (s * 10) % 11; if (r === 10) r = 0; if (r !== Number(d[9])) return false;
  s = 0; for (let i = 0; i < 10; i++) s += Number(d[i]) * (11 - i);
  r = (s * 10) % 11; if (r === 10) r = 0; return r === Number(d[10]);
}
function extractCpf(text) {
  const t = String(text || '');
  // 1) rótulo "CPF:" e 2) formatado xxx.xxx.xxx-xx têm contexto explícito → confia.
  let m = t.match(/CPF[^0-9]{0,8}(\d{3}\D?\d{3}\D?\d{3}\D?\d{2})/i);
  if (m) { const d = m[1].replace(/\D/g, ''); return d.length === 11 ? d : ''; }
  m = t.match(/\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b/);
  if (m) { const d = m[1].replace(/\D/g, ''); return d.length === 11 ? d : ''; }
  // 3) fallback 11 dígitos crus: exige checksum válido, senão um TELEFONE (também 11 dígitos) virava "CPF" e sujava a ponte CPF→atendente.
  m = t.match(/(?:^|[^\d])(\d{11})(?:[^\d]|$)/);
  if (m && _cpfValid(m[1])) return m[1];
  return '';
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

// Resolve o NOSSO vendedor a partir do affiliateId da Five (vínculo salvo pelo diretor em
// five_affiliates.our_user_id via /api/five/affiliates). Retorna o id do time ou null.
async function resolveAtByAffiliate(env, affId) {
  const a = String(affId || '').trim();
  if (!a) return null;
  try {
    const row = await env.DB.prepare('SELECT our_user_id FROM five_affiliates WHERE affiliate_id = ?').bind(a).first();
    const at = row && row.our_user_id ? String(row.our_user_id).trim() : '';
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
  // LOG CRU ANTES DE QUALQUER COISA, igual ao da Five. Sem isso a gente fica CEGO: hoje não dá pra
  // saber se a Payt está postando e a dash rejeitou (token errado, payload estranho) ou se ela
  // simplesmente nunca postou — e a diferença entre as duas muda quem tem que mexer onde.
  const _tsPayt = Math.floor(Date.now() / 1000);
  let _rawPayt = '';
  try { _rawPayt = await req.clone().text(); } catch (_) { _rawPayt = ''; }
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS payt_debug (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, token_ok INTEGER, method TEXT, body TEXT)').run();
    await env.DB.prepare('INSERT INTO payt_debug (ts, token_ok, method, body) VALUES (?,?,?,?)')
      .bind(_tsPayt, urlToken === ((env && env.PAYT_TOKEN) || PAYT_TOKEN_DEFAULT) ? 1 : 0, req.method, String(_rawPayt).slice(0, 40000)).run();
    await env.DB.prepare("DELETE FROM payt_debug WHERE ts < strftime('%s','now')-1209600").run();  // 14 dias, não vira depósito
  } catch (_) {}
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
  // Usa CAS (não INSERT incondicional) pra não sobrescrever uma gravação concorrente de webhook real (incidente da aba antiga).
  if (body && body.test === true) {
    await _casState(env, curVer, state, 'payt-webhook-test');
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

  // Comissão REAL do postback (comiss_real/amount) -> % pra o card e as telas do vendedor
  // não estimarem 12% chutado. null quando o postback não trouxe comissão.
  const _paytPct = (data.comiss_real != null && Number(data.amount) > 0)
    ? Math.round((Number(data.comiss_real) / Number(data.amount)) * 1000) / 10 : null;
  if (lead) {
    // Aplica mapeamento sobre lead existente
    const prev = lead.col;
    let _colMantida = false;   // ver a regra "quem paga manda no pagamento" logo abaixo
    // Backfill do atendente: se o lead ainda não tem dono e a ponte CPF conhece quem
    // atendeu, atribui agora (não sobrescreve atribuição manual já existente).
    if (!lead.at && attribAt) lead.at = attribAt;
    if (_paytPct != null && _paytPct > 0 && (!lead.com_pct || lead.com_pct === 12)) lead.com_pct = _paytPct; // % real (não sobrescreve % editado à mão)
    if (mapping?.etapa) {
      // A FIVE E DONA DA ETAPA DO PEDIDO DELA. O mapeamento da Payt escrevia a coluna sem olhar
      // onde o pedido estava: um postback de cartao chegando depois ('aguardando_pagamento' ->
      // 'A Enviar') devolvia pro comeco um pedido que a Five ja tinha postado, e a etapa que o
      // Bruno le no Cadastro de Pedidos andava pra tras sozinha. Pedido sem five_id (venda so de
      // cartao) segue como era: quem manda na coluna dele e a Payt.
      //
      // E O CHECKOUT NAO DECIDE O DESTINO DE UM PEDIDO QUE JA ESTA VIAJANDO (28/08/2026).
      // Caso real, pedido do Antonio Portella (R$ 297, pagamento NA ENTREGA, postado pela Five e
      // 'em transito' no rastreio): o afiliado mandou o link de Pix pra ele, o cliente abriu e nao
      // pagou, e a Payt disparou `abandono_checkout` e depois `pagamento_expirado`. O mapeamento
      // levou o card pra 'Cobranca' e em seguida pra 'Frustrado' - um pedido que estava a caminho
      // do cliente aparecia como perdido na dash, enquanto na Five estava normal.
      // O mapeamento nao esta errado: ele foi escrito pra venda que so existe no checkout, onde
      // link expirado E o fim. Errado e aplica-lo a um pedido COD que a Five ja despachou, onde o
      // Pix e apenas UMA tentativa de pagar e o cliente ainda pode pagar na porta.
      //
      // A REGRA: com five_id, a Payt so mexe na COLUNA quando traz pagamento CONFIRMADO - que e o
      // unico fato que a Five nao conhece e que de verdade adianta o pedido. Todo o resto continua
      // valendo em `spg` e nas tags (o Bruno segue vendo "nao pagou o Pix"), mas a etapa fisica
      // continua sendo da Five. Quem paga manda no pagamento; quem envia manda na etapa.
      const _confirmouPgto = mapping.action === 'pagar' || String(mapping.spg || '') === 'Pago';
      const _cur = FIVE_COL_RANK[lead.col] || 0, _tgt = FIVE_COL_RANK[mapping.etapa] || 0;
      const _paraTras = lead.five_id && (FIVE_COL_FIM.includes(lead.col) || (_tgt && _cur && _tgt < _cur));
      const _soCheckout = !!lead.five_id && !_confirmouPgto;
      if (!_paraTras && !_soCheckout) lead.col = mapping.etapa;
      // Barrado fica REGISTRADO: o historico logo abaixo grava o evento de qualquer jeito (com
      // from == to) e ganha o motivo no fim da nota. Sem dizer o motivo, o card mostraria o
      // postback chegando e nada acontecendo, que parece integracao quebrada.
      else if (_soCheckout && mapping.etapa !== lead.col) _colMantida = true;
    }
    if (mapping?.spg) lead.spg = mapping.spg;
    if (mapping?.action === 'tag' && mapping.tag) {
      lead.tags = Array.isArray(lead.tags) ? lead.tags : [];
      if (!lead.tags.includes(mapping.tag)) lead.tags.push(mapping.tag);
    }
    // Atualiza dados do lead com info nova vinda da PAYT (se chegou)
    if (data.tracking_code && !lead.track) lead.track = data.tracking_code;
    if (data.payment_method && !lead.pgto) lead.pgto = data.payment_method;
    if (data.amount && !lead.vl) lead.vl = data.amount;
    // Juro do parcelamento: fica registrado no lead so pra explicar a diferenca na tela.
    if (data.amount_pago > 0 && data.amount > 0 && data.amount_pago > data.amount) {
      lead.vl_cobrado = data.amount_pago;
      lead.vl_juros = Math.round((data.amount_pago - data.amount) * 100) / 100;
      if (data.parcelas > 1) lead.vl_parcelas = data.parcelas;
    }
    // Histórico do lead
    lead.hist = Array.isArray(lead.hist) ? lead.hist : [];
    lead.hist.push({
      from: prev,
      to: lead.col,
      who: 'payt',
      time: `${todayBR()} ${nowTimeBR()}`,
      note: `PAYT: ${data.event_raw||data.event} (${data.status||'-'})`
        + (_colMantida ? ' - coluna mantida: a Five e dona da etapa deste pedido' : ''),
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
      // Sem comissao no postback, NAO chuta 12%: numero inventado vira dinheiro combinado na
      // cabeca de alguem. Vazio faz a dash usar a taxa cadastrada do vendedor.
      com_pct: (_paytPct != null && _paytPct > 0) ? _paytPct : '',
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
    const _existing = _vi >= 0 ? state.vendas[_vi] : null;
    if (_paidEvt && data.comiss_real != null) {
      if (_existing && _existing.status === 'estornado') {
        // Estorno é TERMINAL: um postback de pago reenviado depois do reembolso não ressuscita a receita.
      } else {
        const _p = (data.paid_at || '').slice(0, 10);
        const _ddmm = (_p && _p[4] === '-') ? (_p.slice(8, 10) + '/' + _p.slice(5, 7)) : todayBR().slice(0, 5);
        const _venda = {
          id: _existing ? _existing.id : Date.now(),
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
      }
    } else if (_revEvt) {
      if (_vi >= 0) {
        state.vendas[_vi].status = 'estornado';
      } else {
        // Estorno chegou ANTES do evento de pago (webhooks fora de ordem): grava placeholder estornado
        // pra um postback de pago atrasado não recriar a venda como confirmada.
        state.vendas.unshift({
          id: Date.now(), payt_id: _paytId,
          leadId: resolvedLead ? resolvedLead.id : null,
          nome: data.name || (resolvedLead && resolvedLead.nome) || '',
          cpf: data.cpf || '', prod: data.product || '', sku: data.sku || '',
          vl: data.amount || 0, custo: 0, com_pct: 0, comiss: 0, lucro: 0,
          status: 'estornado',
          at: (resolvedLead && resolvedLead.at) || attribAt || '',
          data: todayBR().slice(0, 5), orig: 'PAYT',
        });
      }
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
      // Vazio, nao 12: taxa inventada no backend vira dinheiro combinado na cabeca de alguem.
      // A dash usa a taxa cadastrada do vendedor quando o pedido nao tem uma combinada.
      com_pct: '',
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

// Config da Evolution em CACHE por isolate. Antes eram 3 SELECTs no D1 a cada evoFetch, e o D1 fica
// em outra região: ~100ms por leitura. Abrir o QR faz 3 evoFetch, ou seja ~1s jogado fora só lendo
// config que quase nunca muda. Com cache, o custo vira zero da 2ª chamada em diante.
let _waCfgCache = null, _waCfgAt = 0;
const WA_CFG_TTL = 60000;
function _waCfgInvalidate() { _waCfgCache = null; _waCfgAt = 0; }
async function getWAConfig(env) {
  if (_waCfgCache && (Date.now() - _waCfgAt) < WA_CFG_TTL) return _waCfgCache;
  // as 3 leituras não dependem uma da outra: em paralelo custam 1 ida, não 3
  const [url, key, instance] = await Promise.all([
    _readConfig(env, 'wa_url'), _readConfig(env, 'wa_key'), _readConfig(env, 'wa_instance'),
  ]);
  _waCfgCache = {
    url: String(url || '').replace(/\/+$/, ''),
    key: key || '',
    instance: instance || '',
  };
  _waCfgAt = Date.now();
  return _waCfgCache;
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
  _waCfgInvalidate();   // senão o cache serviria a config velha por até 1min depois de salvar
  return json({ ok: true });
}

// GET /api/wa/status → saúde da integração Evolution: cadastrada? servidor no ar? quantos números
// conectados AGORA? Antes checava só UMA instância padrão (wa_instance); com vários números por QR,
// essa instância "padrão" some/muda e o card acusava "Offline" mesmo com números conectados. Agora
// não depende dela: 503 só sem servidor (url/key), 502 se o servidor cair, senão conta os 'open'.
async function handleWAStatus(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const cfg = await getWAConfig(env);
  if (!cfg.url || !cfg.key) return err('WhatsApp não configurado', 503);
  try {
    const list = await _evoInstances(env);   // TODAS as instâncias [{name, state, number}]
    if (list == null) return err('Evolution não respondeu', 502);
    const open = list.filter(i => String(i.state || '').toLowerCase() === 'open');
    // estado da instância padrão, se ela existir (compat com telas antigas que leem state/instance)
    let dstate = 'unknown';
    if (cfg.instance) { const di = list.find(i => i.name === cfg.instance); dstate = di ? di.state : 'unknown'; }
    return json({ ok: true, configured: true, server: true, connected: open.length, total: list.length, state: dstate, instance: cfg.instance || '' });
  } catch (e) {
    return err('Falha ao falar com a Evolution: ' + e.message, 502);
  }
}

// POST /api/wa/send → { number, text, instance? } envia texto.
// Se instance não vier, usa a instância padrão configurada (wa_instance).
// Qual instância usar pra ENVIAR a resposta do atendente.
// Com a instância POR NÚMERO, mandar pra `ax_<vendedor>` (hoje fechada) ou pra instância padrão
// `wa_instance` (que pode nem existir na VPS, no caso do Bruno era "salemade") fazia a resposta
// falhar em silêncio. Ordem de preferência:
//   1) a que o front pediu, SE estiver conectada agora
//   2) a que ATENDEU esse telefone (responde pelo mesmo número que o lead procurou)
//   3) qualquer instância conectada desse vendedor
//   4) o que veio (comportamento antigo), pra não quebrar setup legado
async function _resolveSendInstance(env, { atId, phone, hint }) {
  const conectada = async (name) => {
    if (!name) return false;
    try {
      const r = await env.DB.prepare(
        "SELECT 1 FROM wa_conn WHERE instance=? AND state='open' AND updated_at > strftime('%s','now')-600"
      ).bind(name).first();
      return !!r;
    } catch (_) { return false; }
  };
  if (hint && await conectada(hint)) return hint;
  try {
    const d = String(phone || '').replace(/\D/g, '');
    if (d) {
      const row = await env.DB.prepare('SELECT instance FROM wa_attrib WHERE phone=?').bind(d).first();
      if (row && row.instance && await conectada(row.instance)) return row.instance;
    }
  } catch (_) {}
  try {
    if (atId) {
      const row = await env.DB.prepare(
        // só 'open' (Evolution): 'sc' é Sale Chat, que hoje SÓ captura, não envia. Escolher uma
        // instância 'sc' aqui mandaria o texto pra uma instância que nem existe na Evolution.
        "SELECT instance FROM wa_conn WHERE state='open' AND updated_at > strftime('%s','now')-600 AND (instance=? OR instance LIKE ?) ORDER BY updated_at DESC LIMIT 1"
      ).bind('ax_' + atId, 'ax_' + atId + '_%').first();
      if (row && row.instance) return row.instance;
    }
  } catch (_) {}
  return String(hint || '').trim();
}
// A conversa é de um número OFICIAL (Cloud API)? Descobre pela INSTÂNCIA da própria conversa, não
// pelo dono. O sync do Datacrazy (_dcSyncInbox) grava a conversa como `ax_<at>_<8 últimos dígitos do
// NOSSO número>` (e `dc_<num>` quando o número ainda não tem dono). Esses 8 dígitos identificam o
// número EXATO que o lead procurou, então é por ele que a resposta tem que sair.
// Resolver só por at_id erra quando o vendedor tem mais de um número oficial (hoje o atendente_iqq91p
// tem o 5515991504525 e o 5515991258028): o lead escreve pro A e recebe do B.
async function _apiNumFromInstance(env, inst) {
  const s = String(inst || '');
  const m = s.match(/^ax_.+_(\d{8})$/) || s.match(/^dc_(\d{8,})$/);
  if (!m) return null;
  const suf = String(m[1]).slice(-8);
  try {
    const row = await env.DB.prepare(
      'SELECT phone_number_id, waba_id, at_id, display_phone, verified, token FROM wa_api_numbers WHERE substr(display_phone, -8) = ? ORDER BY verified DESC, updated_at DESC LIMIT 1'
    ).bind(suf).first();
    return row || null;
  } catch (_) { return null; }
}
// DONO DA CONVERSA (19/08/2026). Os 5 handlers de envio so conferiam se o usuario estava LOGADO.
// Como o resolveApiNumber tira o numero de saida do wa_chats.instance, um vendedor que chamasse a
// rota com o telefone de um lead do COLEGA mandava mensagem SAINDO PELO NUMERO DO COLEGA - o cliente
// recebia do outro atendente e o dono da conversa nem ficava sabendo. Mesma regra que o
// handleWAChatStage ja usava. Conversa que ainda NAO existe passa (e o vendedor abrindo contato
// novo); o diretor passa sempre, pra poder socorrer.
// O COBRADOR VE O INBOX INTEIRO, MAS SO O QUE FECHOU, E SO PRA LER (24/08/2026).
// Ele nao atende: entra pra consultar o historico do cliente que ja comprou, antes de ligar
// cobrando. Por isso ele nao cai no filtro por instancia (nenhuma conversa e "dele", a lista sairia
// vazia) e ganha um filtro proprio pela etapa do CRM. Enviar continua barrado no
// _podeFalarNaConversa, que e o gate dos 5 endpoints de envio.
const _ehCobrador = (u) => String((u && u.role) || '').toLowerCase() === 'cobrador';
async function _podeFalarNaConversa(env, u, phone) {
  if (_ehCobrador(u)) return false;                 // cobrador NUNCA manda mensagem
  if (isDirector(u)) return true;
  const fone = String(phone || '').replace(/\D/g, '');
  if (!fone) return true;
  let chat = null;
  try { chat = await env.DB.prepare('SELECT instance FROM wa_chats WHERE phone = ?').bind(fone).first(); } catch (_) { return true; }
  if (!chat) return true;   // conversa nova: nao ha dono ainda
  const x = String(chat.instance || '');
  return x === 'ax_' + u.id || x.indexOf('ax_' + u.id + '_') === 0;
}
async function handleWASend(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const body = await req.json().catch(() => null);
  if (!body || !body.number || !body.text) return err('Campos obrigatórios: number, text');
  if (!(await _podeFalarNaConversa(env, u, body.number))) return err(String(u.role || '').toLowerCase() === 'cobrador' ? 'Sua área do inbox é só pra consulta' : 'Essa conversa é de outro atendente', 403);
  // Roteamento: responde PELO MESMO NÚMERO em que a conversa está.
  // O sufixo `_<8díg>` sozinho NÃO quer dizer Evolution: o sync do Datacrazy grava a conversa do
  // número OFICIAL nesse mesmo formato. A regra antiga (`_convEvo`) tratava o sufixo como Evolution e
  // por isso mandava 100% do inbox oficial pra uma instância que nem existe na VPS (wa_conn não tem
  // ax_atendente_iqq91p_91258028 / ax_atendente_vra3lh_74076200 / ax_atendente_vra3lh_91215713), e a
  // resposta morria em 502 "Evolution respondeu 404".
  // Ordem nova: (1) a instância casa com um número oficial NOSSO -> Cloud API por ESSE número;
  // (2) instância sem identidade de número -> regra antiga (número oficial do dono, se tiver);
  // (3) qualquer outro caso segue pra Evolution exatamente como hoje.
  const _atId = (isDirector(u) && body.at_id != null) ? String(body.at_id) : String(u.id);
  const _instConv = String(body.instance || '');
  // instância que carrega identidade de NÚMERO (a que a regra antiga jogava direto na Evolution)
  const _convPorNumero = /^ax_.+_\d{8}$/.test(_instConv) || /^dc_\d{8,}$/.test(_instConv);
  let _apiNum = null, _oficialFixo = false;
  try {
    // A instância está VIVA na Evolution AGORA? Então o lead falou pelo app: responde pelo mesmo canal.
    // Guarda contra o caso de coexistência em que o mesmo número existe nos dois lados.
    const _evoViva = _instConv ? await env.DB.prepare(
      "SELECT 1 FROM wa_conn WHERE instance=? AND state='open' AND updated_at > strftime('%s','now')-600"
    ).bind(_instConv).first() : null;
    if (!_evoViva) { _apiNum = await _apiNumFromInstance(env, _instConv); _oficialFixo = !!_apiNum; }
    // sem identidade de número na instância -> comportamento antigo, pra não mexer em Sale Chat/legado
    if (!_apiNum && !_convPorNumero) _apiNum = await resolveApiNumber(env, { atId: _atId, instance: _instConv, convPhone: body.number });
  } catch (_) { _apiNum = null; _oficialFixo = false; }
  // `_oficialFixo` = a conversa É daquele número oficial. Nesse caso a Evolution NÃO é alternativa:
  // em vez de cair calado pro caminho errado, devolve o erro com motivo.
  if (_apiNum && _apiNum.phone_number_id && (_apiNum.verified || _oficialFixo)) {
    if (!_apiNum.verified) return json({ ok: false, error: 'Este número oficial ainda não foi registrado na Meta, então não dá pra responder por ele.', code: 'not_registered' }, 400);
    const r = await _waCloudSendText(env, _atId, body.number, body.text, _apiNum);
    if (!r.ok) return json({ ok: false, error: r.error, code: r.code || null }, r.code === 'window_closed' ? 409 : 400);
    return json({ ok: true, id: r.id, via: 'cloud', from: _apiNum.display_phone || null, to: waNumber(body.number) });
  }
  const cfg = await getWAConfig(env);
  if (!cfg.url || !cfg.key) return err('WhatsApp não configurado', 503);
  const instance = (await _resolveSendInstance(env, { atId: _atId, phone: body.number, hint: body.instance }))
    || String(body.instance || cfg.instance || '').trim();
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

// Envia TEXTO pela Cloud API oficial. `atId` define o número de origem (phone_number_id do vendedor).
// Loga outbound e roda detecção de venda (resgata o CompletePayment, já que o vendedor envia por aqui).
// `apiNumFixo` (opcional) é o número oficial JÁ resolvido a partir da conversa (_apiNumFromInstance).
// Sem ele a função resolve por at_id, e vendedor com DOIS números oficiais responderia pelo número
// errado (o lead escreve pro A e recebe do B). Os 3 chamadores antigos passam 4 argumentos e continuam
// funcionando igual: o parâmetro é opcional.
async function _waCloudSendText(env, atId, number, text, apiNumFixo) {
  const num = String(number || '').replace(/\D/g, '');
  const txt = String(text || '');
  if (!num || !txt) return { ok: false, error: 'number/text obrigatórios' };
  const apiNum = apiNumFixo || await resolveApiNumber(env, { atId, convPhone: num });
  if (!apiNum || !apiNum.phone_number_id) return { ok: false, error: 'vendedor sem número oficial', code: 'no_official' };
  if (!apiNum.verified) return { ok: false, error: 'número oficial ainda não registrado', code: 'not_registered' };
  // guarda janela 24h: free-form só dentro de 24h do último inbound do lead
  try {
    const li = await env.DB.prepare("SELECT ts FROM wa_messages WHERE phone=? AND direction='in' ORDER BY ts DESC LIMIT 1").bind(num).first();
    const lastIn = (li && Number(li.ts)) || 0;
    if (lastIn && (Math.floor(Date.now() / 1000) - lastIn) > 86400) {
      // Erro EXPLÍCITO e com a idade da janela. Hoje as 12 conversas do inbox estão fora das 24h (de
      // 25h a 496h desde o último inbound), então esta é a mensagem que o vendedor mais vai ver: ela
      // precisa dizer o motivo e a saída, não só "falha ao enviar".
      const _h = Math.floor((Math.floor(Date.now() / 1000) - lastIn) / 3600);
      return { ok: false, error: 'Janela de 24h fechada: o lead falou pela última vez há ' + _h + 'h. Só dá pra reabrir com um template aprovado.', code: 'window_closed' };
    }
  } catch (_) {}
  const g = await _graph(env, `/${encodeURIComponent(apiNum.phone_number_id)}/messages`, {
    method: 'POST', token: apiNum.token, retry: 1,
    body: JSON.stringify({ messaging_product: 'whatsapp', to: num, type: 'text', text: { body: txt, preview_url: false } })
  });
  if (!g.ok) {
    const e = (g.data && g.data.error) || {};
    await _waFalhaLog(env, { phone: num, instance: 'ax_' + atId, kind: 'text', code: e.code || g.status, msg: e.message || '' });
    return { ok: false, error: _waErroTxt(e.code, e.message || ('graph ' + g.status)), code: e.code || g.status };
  }
  const wamid = g.data && g.data.messages && g.data.messages[0] && g.data.messages[0].id;
  // Instância no MESMO formato que o sync do Datacrazy grava (ax_<at>_<8 últimos díg do nosso número>).
  // Antes o outbound entrava como ax_<at> e a mesma conversa ficava com duas instâncias diferentes na
  // wa_messages, então a métrica POR NÚMERO perdia o envio. _atFromInst tira o sufixo `_<8díg>`, então
  // a atribuição por vendedor (_waDetectSale) continua exatamente igual.
  const _disp = String((apiNum && apiNum.display_phone) || '').replace(/\D/g, '');
  const inst = 'ax_' + atId + (_disp.length >= 8 ? '_' + _disp.slice(-8) : '');
  try { await _waLogMsg(env, { phone: num, instance: inst, direction: 'out', type: 'text', body: txt, msgId: wamid }); } catch (_) {}
  try { await _waDetectSale(env, inst, { message: { conversation: txt }, key: { remoteJid: num + '@c.us', remoteJidAlt: num + '@c.us', id: wamid || null, fromMe: true } }); } catch (_) {}
  return { ok: true, id: wamid || null };
}
// POST /api/wa/cloud/send { number, text, at_id? } — entrypoint explícito de envio pela Cloud API.
// Envia um TEMPLATE aprovado (pra reabrir conversa fora da janela de 24h). Sem variáveis por enquanto.
// `params` = valores das variáveis do corpo, na ordem ({{1}}, {{2}}, ...). Sem eles a Meta RECUSA
// todo template que tem variável, que é a maioria dos 26 aprovados aqui: o payload antigo mandava só
// name + language e o envio morria com "number of parameters does not match".
// `bodyTxt` é o corpo já preenchido, só pra thread mostrar o que o lead vai ler (em vez de "[template]").
async function _waCloudSendTemplate(env, atId, number, name, lang, params, bodyTxt) {
  const num = String(number || '').replace(/\D/g, '');
  if (!num || !name) return { ok: false, error: 'number/name obrigatórios' };
  const vars = (Array.isArray(params) ? params : []).map((v) => String(v == null ? '' : v)).filter((v) => v !== '');
  const componentes = vars.length ? [{ type: 'body', parameters: vars.map((v) => ({ type: 'text', text: v })) }] : [];
  // Template TEM que sair do número que recebeu: ele é aprovado dentro da WABA daquele número.
  const apiNum = await resolveApiNumber(env, { atId, convPhone: num });
  if (!apiNum || !apiNum.phone_number_id) return { ok: false, error: 'vendedor sem número oficial', code: 'no_official' };
  if (!apiNum.verified) return { ok: false, error: 'número oficial ainda não registrado', code: 'not_registered' };
  // Confere o template NA CONTA DO NUMERO que vai enviar.
  let _lang = String(lang || 'pt_BR');
  try {
    if (apiNum.waba_id) {
      const lst = await _graph(env, `/${encodeURIComponent(apiNum.waba_id)}/message_templates?fields=name,language,status&limit=200`, { token: apiNum.token || undefined });
      if (lst.ok) {
        const todos = (lst.data && lst.data.data) || [];
        const doNome = todos.filter((t) => String(t.name || '') === String(name));
        if (!doNome.length) {
          return { ok: false, code: 'template_outra_conta', error: 'Esse template não existe na conta do número ' + (apiNum.display_phone || '') + '. Escolha um template desse número.' };
        }
        // idioma exato do template (o cadastro pode estar em pt_BR, pt ou en_US)
        const igual = doNome.find((t) => String(t.language || '') === _lang);
        if (!igual) _lang = String((doNome.find((t) => String(t.status || '').toUpperCase() === 'APPROVED') || doNome[0]).language || _lang);
      }
    }
  } catch (_) {}
  const g = await _graph(env, `/${encodeURIComponent(apiNum.phone_number_id)}/messages`, {
    method: 'POST', token: apiNum.token, retry: 1, body: JSON.stringify({
      messaging_product: 'whatsapp', to: num, type: 'template',
      template: componentes.length
        ? { name: String(name), language: { code: _lang }, components: componentes }
        : { name: String(name), language: { code: _lang } },
    })
  });
  if (!g.ok) { const e = (g.data && g.data.error) || {}; await _waFalhaLog(env, { phone: num, instance: 'ax_' + atId, kind: 'midia/template', code: e.code || g.status, msg: e.message || '' }); return { ok: false, error: _waErroTxt(e.code, e.message || ('graph ' + g.status)), code: e.code || g.status }; }
  const wamid = g.data && g.data.messages && g.data.messages[0] && g.data.messages[0].id;
  // Grava na thread o texto QUE O LEAD VAI LER, não "[template] nome": o vendedor precisa saber o que
  // foi disparado pra continuar a conversa sem repetir.
  const _logTxt = String(bodyTxt || '').trim() || ('[template] ' + name);
  // CARIMBO COM O NUMERO, igual texto e midia. Era o unico envio que gravava 'ax_<at>' pelado, e
  // isso re-carimbava a conversa SEM os 8 digitos: dali pra frente resolveApiNumber nao reconhecia
  // mais o chip da conversa e caia no numero escolhido no seletor. Com dois numeros por vendedor,
  // um template mandava as respostas seguintes pelo numero errado.
  const _dispT = String((apiNum && apiNum.display_phone) || '').replace(/\D/g, '');
  const _instT = 'ax_' + atId + (_dispT.length >= 8 ? '_' + _dispT.slice(-8) : '');
  try { await _waLogMsg(env, { phone: num, instance: _instT, direction: 'out', type: 'template', body: _logTxt, msgId: wamid }); } catch (_) {}
  return { ok: true, id: wamid || null };
}
// A CONVERSA ESTA NUMA EVOLUTION VIVA? Devolve a instancia, ou '' quando o caminho e Cloud API.
// Existe porque o painel Sale Chat (texto rapido, audio do microfone, midia) mandava TUDO pela
// Cloud API sem olhar onde a conversa vive. Com o vendedor trocando um numero restrito por um de
// QR (21/08/2026), isso fazia o audio e a midia sairem pelo numero RESTRITO do mesmo vendedor -
// o lead recebendo mensagem de um contato com quem nunca falou, pelo chip que acabou de ser punido.
async function _instEvoViva(env, phone, hint) {
  const num = String(phone || '').replace(/\D/g, '');
  let inst = String(hint || '');
  if (!inst && num) {
    try { const c = await env.DB.prepare('SELECT instance FROM wa_chats WHERE phone=?').bind(num).first(); inst = String((c && c.instance) || ''); } catch (_) { inst = ''; }
  }
  if (!inst) return '';
  try {
    const viva = await env.DB.prepare("SELECT 1 FROM wa_conn WHERE instance=? AND state='open' AND updated_at > strftime('%s','now')-600").bind(inst).first();
    return viva ? inst : '';
  } catch (_) { return ''; }
}
async function handleWACloudSend(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  let b; try { b = await req.json(); } catch (_) { b = {}; }
  if (!(await _podeFalarNaConversa(env, u, b.number))) return err(String(u.role || '').toLowerCase() === 'cobrador' ? 'Sua área do inbox é só pra consulta' : 'Essa conversa é de outro atendente', 403);
  const atId = (isDirector(u) && b.at_id != null) ? String(b.at_id) : String(u.id);
  if (b.template && b.template.name) {
    // params = valores das variáveis na ordem; body = corpo cru do template (só pra logar já preenchido)
    const rt = await _waCloudSendTemplate(env, atId, b.number, b.template.name, b.template.language, b.template.params, b.template.body);
    if (!rt.ok) return json({ ok: false, error: rt.error, code: rt.code || null }, 400);
    return json({ ok: true, id: rt.id, via: 'cloud-template' });
  }
  const _evo = await _instEvoViva(env, b.number, b.instance);
  if (_evo) {
    const num = String(b.number || '').replace(/\D/g, '');
    const rr = await evoFetch(env, '/message/sendText/' + encodeURIComponent(_evo), { method: 'POST', body: { number: num, text: String(b.text || '') } });
    if (!rr || rr.ok === false || rr._noconfig) return json({ ok: false, error: 'O WhatsApp deste número não respondeu agora. Tente de novo.', code: 'evo' }, 502);
    const _id = (rr.data && rr.data.key && rr.data.key.id) || null;
    try { await _waLogMsg(env, { phone: num, instance: _evo, direction: 'out', type: 'text', body: String(b.text || ''), msgId: _id }); } catch (_) {}
    try { await _waDetectSale(env, _evo, { message: { conversation: String(b.text || '') }, key: { remoteJid: num + '@c.us', id: _id, fromMe: true } }); } catch (_) {}
    return json({ ok: true, id: _id, via: 'evolution' });
  }
  const r = await _waCloudSendText(env, atId, b.number, b.text);
  if (!r.ok) return json({ ok: false, error: r.error, code: r.code || null }, r.code === 'window_closed' ? 409 : 400);
  return json({ ok: true, id: r.id, via: 'cloud' });
}
// Baixa a mídia recebida pela Cloud API (a Meta entrega um id, não os bytes) e grava no R2,
// depois preenche wa_messages.media_url. Roda em ctx.waitUntil (nunca bloqueia o ACK do webhook).
async function _waCloudDownloadMedia(env, mediaId, msgId) {
  try {
    if (!env.MEDIA || !mediaId) return;
    const meta = await _graph(env, `/${encodeURIComponent(mediaId)}`);
    const murl = meta.ok && meta.data && meta.data.url;
    if (!murl) return;
    const mime = (meta.data && meta.data.mime_type) || 'application/octet-stream';
    const token = await _readConfig(env, 'wa_api_token');
    const r = await fetch(murl, { headers: token ? { authorization: 'Bearer ' + token } : {} });
    if (!r.ok) return;
    const buf = await r.arrayBuffer();
    if (!buf || buf.byteLength === 0) return;
    const ext = mime.indexOf('ogg') >= 0 ? 'ogg' : (mime.indexOf('mpeg') >= 0 || mime.indexOf('mp3') >= 0) ? 'mp3' : mime.indexOf('mp4') >= 0 ? 'mp4' : mime.indexOf('png') >= 0 ? 'png' : (mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0) ? 'jpg' : mime.indexOf('webp') >= 0 ? 'webp' : mime.indexOf('pdf') >= 0 ? 'pdf' : 'bin';
    const key = 'm/wa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
    await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } });
    if (msgId) { try { await env.DB.prepare('UPDATE wa_messages SET media_url=? WHERE msg_id=?').bind(key, msgId).run(); } catch (_) {} }
  } catch (_) {}
}
// Baixa a mídia INBOUND da Evolution pro R2 e seta media_url (igual _waCloudDownloadMedia faz pro Cloud).
// A Evolution entrega o arquivo CHEIO decriptado (não só thumbnail) via getBase64FromMediaMessage — o
// mesmo endpoint da transcrição de áudio. Roda em ctx.waitUntil (não bloqueia o ACK do webhook).
async function _waEvoDownloadMedia(env, instance, key, mm, msgId) {
  try {
    if (!env.MEDIA || !msgId) return;
    const node = mm.imageMessage || mm.audioMessage || mm.videoMessage || mm.documentMessage || mm.stickerMessage;
    if (!node) return;
    const media = await evoFetch(env, `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
      method: 'POST',
      body: { message: { key: { id: key.id, remoteJid: key.remoteJid, fromMe: !!key.fromMe } } },
    });
    const b64 = media && media.data && media.data.base64; if (!b64) return;
    const mime = String((media.data && media.data.mimetype) || node.mimetype || 'application/octet-stream').split(';')[0];
    const bytes = _b64ToBytes(b64);
    if (!bytes || !bytes.byteLength) return;
    const ext = mime.indexOf('ogg') >= 0 ? 'ogg' : (mime.indexOf('mpeg') >= 0 || mime.indexOf('mp3') >= 0) ? 'mp3' : mime.indexOf('mp4') >= 0 ? 'mp4' : mime.indexOf('png') >= 0 ? 'png' : (mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0) ? 'jpg' : mime.indexOf('webp') >= 0 ? 'webp' : mime.indexOf('pdf') >= 0 ? 'pdf' : 'bin';
    const rkey = 'm/wa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
    await env.MEDIA.put(rkey, bytes, { httpMetadata: { contentType: mime } });
    try { await env.DB.prepare('UPDATE wa_messages SET media_url=? WHERE msg_id=?').bind(rkey, msgId).run(); } catch (_) {}
  } catch (_) {}
}
// Guarda bytes de mídia (base64) do injetor Sale Chat no R2 e devolve a key. '' se falhar.
// É assim que a mídia RECEBIDA do Sale Chat vira visualizável: o injetor baixa via WPP.chat.downloadMedia
// e manda os bytes; aqui a gente persiste e o media_url aponta pra cá.
async function _scStoreMedia(env, b64, mimeHint) {
  try {
    if (!env.MEDIA || !b64) return '';
    const bytes = _b64ToBytes(String(b64).replace(/^data:[^;]+;base64,/, ''));
    if (!bytes || !bytes.byteLength) return '';
    const mime = String(mimeHint || 'application/octet-stream').split(';')[0];
    const ext = mime.indexOf('ogg') >= 0 ? 'ogg' : (mime.indexOf('mpeg') >= 0 || mime.indexOf('mp3') >= 0) ? 'mp3' : mime.indexOf('mp4') >= 0 ? 'mp4' : mime.indexOf('png') >= 0 ? 'png' : (mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0) ? 'jpg' : mime.indexOf('webp') >= 0 ? 'webp' : mime.indexOf('pdf') >= 0 ? 'pdf' : 'bin';
    const key = 'm/wa' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
    return key;
  } catch (_) { return ''; }
}
// Sobe um arquivo pra Media API da Meta e devolve o media id. Necessário pra NOTA DE VOZ (voice:true),
// que a Meta só aceita com mídia enviada (id), não com link. Busca os bytes do R2 pelo próprio link.
// O PORQUE DA FALHA TEM QUE APARECER. Esta funcao devolvia null em quatro pontos diferentes, todos
// calados, e a tela mostrava sempre a mesma frase ("Nao consegui preparar o audio"). O vendedor fica
// sem saber se e o microfone, o navegador dele ou a Meta, e quem for consertar tambem nao sabe.
// Agora cada saida diz o motivo no log do Worker e o motivo volta em .motivo pra quem chamou.
async function _waCloudUploadMedia(env, phoneNumberId, token, link, mimeHint) {
  const falha = (motivo, extra) => { try { console.error('WA_UPLOAD_FALHOU ' + motivo + (extra ? ' | ' + String(extra).slice(0, 200) : '')); } catch (_) {} return { erro: true, motivo }; };
  try {
    // O ARQUIVO E NOSSO: le DIRETO do R2, sem HTTP.
    //
    // Antes isto era um fetch(link) na propria URL publica do worker - ou seja, o worker fazendo
    // requisicao pra ele mesmo. Isso falha (o Cloudflare barra/instabiliza subrequest pro proprio
    // host) e o vendedor via "O audio nao foi encontrado no servidor. Grave de novo." - gravando de
    // novo dez vezes sem nunca resolver, porque o arquivo SEMPRE esteve la.
    // Le do bucket pela chave; so cai no fetch quando o link e de terceiro (nao e do nosso R2).
    let buf = null, rct = '';
    const _key = (() => {
      const m = String(link || '').match(/\/api\/salechat\/media\/(.+)$/);
      if (!m) return '';
      try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
    })();
    if (_key && env.MEDIA) {
      try {
        const obj = await env.MEDIA.get(_key);
        if (obj) { buf = await obj.arrayBuffer(); rct = (obj.httpMetadata && obj.httpMetadata.contentType) || ''; }
        else return falha('r2_sem_objeto', _key);
      } catch (e) { return falha('r2_erro', String((e && e.message) || e)); }
    }
    if (!buf) {
      let r;
      try { r = await fetch(link); } catch (e) { return falha('nao_baixou_do_r2', String((e && e.message) || e)); }
      if (!r.ok) return falha('r2_http_' + r.status, link);
      buf = await r.arrayBuffer();
      rct = r.headers.get('content-type') || '';
    }
    if (!buf || !buf.byteLength) return falha('arquivo_vazio', link);
    // Detecta o formato pelos BYTES (não confia no hint): só ogg/opus vira NOTA DE VOZ (voice:true).
    const head = new Uint8Array(buf.slice(0, 64));
    const s = String.fromCharCode.apply(null, head);
    const isOpus = s.indexOf('OggS') === 0 && s.indexOf('OpusHead') >= 0;
    // NAO ADIANTA MANDAR 'audio/ogg; codecs=opus' AQUI - ja testei em 19/08/2026, contra a API de
    // verdade, quando o Bruno relatou "o audio vai como arquivo e nao como voz gravada":
    //   - subindo como 'audio/ogg'            -> a Meta aceita e guarda mime_type = audio/ogg
    //   - subindo como 'audio/ogg; codecs=opus' -> a Meta aceita e guarda mime_type = audio/ogg
    // Ela DESCARTA o parametro do codec nos dois casos, entao mudar esta linha nao muda nada no que
    // chega no celular do lead. Nao repita esse teste.
    // O que ja esta certo do nosso lado (medido no mesmo dia): os 79 audios do sistema sao ogg/opus
    // de verdade (73 vivos, 6 apagados do R2), mono, e o envio usa media id + voice:true - nunca o
    // link, que e o que fazia o WhatsApp marcar como ENCAMINHADA.
    const mime = isOpus ? 'audio/ogg'
      : (/audio\/(mpeg|mp3)/i.test(rct) ? 'audio/mpeg'
        : /audio\/(mp4|m4a|aac)/i.test(rct) ? 'audio/mp4'
          : /audio\/webm/i.test(rct) ? 'audio/webm'
            : (mimeHint || rct || 'audio/ogg'));
    const ext = isOpus ? 'ogg' : (mime.indexOf('mpeg') >= 0 ? 'mp3' : mime.indexOf('mp4') >= 0 ? 'm4a' : mime.indexOf('webm') >= 0 ? 'webm' : 'ogg');
    const tk = token || await _readConfig(env, 'wa_api_token');
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', mime);
    fd.append('file', new Blob([buf], { type: mime }), 'audio.' + ext);
    const up = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(phoneNumberId) + '/media', { method: 'POST', headers: { authorization: 'Bearer ' + tk }, body: fd });
    const txt = await up.text();
    let j = {}; try { j = JSON.parse(txt); } catch (_) {}
    if (up.ok && j && j.id) return { id: String(j.id), isOpus, mime };
    return falha('meta_recusou_http_' + up.status + '_mime_' + mime, txt);
  } catch (e) { return falha('excecao', String((e && e.stack) || e)); }
}
// Envia MÍDIA (imagem/áudio/vídeo/documento) pela Cloud API, por um `link` público (R2).
// opts: { kind, link, caption?, filename?, mediaKey? }.
async function _waCloudSendMedia(env, atId, number, opts) {
  const num = String(number || '').replace(/\D/g, '');
  const kind = String((opts && opts.kind) || 'image');
  if (!num || !opts || !opts.link) return { ok: false, error: 'number/link obrigatórios' };
  // Mídia pelo mesmo número da conversa (o upload fica preso ao phone_number_id de origem).
  // opts.apiNum = número JÁ resolvido pelo chamador (o funil manda o dele, pinado no início).
  const apiNum = (opts && opts.apiNum) || await resolveApiNumber(env, { atId, convPhone: num });
  if (!apiNum || !apiNum.phone_number_id) return { ok: false, error: 'vendedor sem número oficial', code: 'no_official' };
  if (!apiNum.verified) return { ok: false, error: 'número oficial ainda não registrado', code: 'not_registered' };
  try {
    const li = await env.DB.prepare("SELECT ts FROM wa_messages WHERE phone=? AND direction='in' ORDER BY ts DESC LIMIT 1").bind(num).first();
    const lastIn = (li && Number(li.ts)) || 0;
    if (lastIn && (Math.floor(Date.now() / 1000) - lastIn) > 86400) return { ok: false, error: 'janela de 24h fechada; use um template', code: 'window_closed' };
  } catch (_) {}
  const media = { link: opts.link };
  if (kind === 'document' && opts.filename) media.filename = opts.filename;
  if ((kind === 'image' || kind === 'video' || kind === 'document') && opts.caption) media.caption = opts.caption;
  // ÁUDIO como NOTA DE VOZ (ondinhas, igual gravado no celular): a Meta exige mídia ENVIADA (media
  // id) + voice:true. Só o `link` vira ARQUIVO de áudio (linha reta). Subimos o ogg/opus, pegamos o
  // id e mandamos voice:true. Se o upload falhar, cai no link (manda como arquivo, mas manda).
  let payload;
  if (kind === 'audio') {
    const _mu = await _waCloudUploadMedia(env, apiNum.phone_number_id, apiNum.token, opts.link, 'audio/ogg');
    const mu = (_mu && !_mu.erro) ? _mu : null;
    const _motivo = (_mu && _mu.motivo) || 'sem_motivo';
    // voice:true (ondinhas) SÓ quando os bytes são realmente ogg/opus; senão manda como arquivo válido.
    // NUNCA cair no `link` pra audio. O link faz a Meta reusar a midia que ela ja baixou daquela
    // URL, e o WhatsApp marca a mensagem como ENCAMINHADA - foi o que o Guilherme viu: audio com a
    // setinha de encaminhado, cara de arquivo repassado, nao de voz gravada pra aquele cliente.
    // Sem upload nao ha envio: prefiro devolver erro a mandar algo que chega com cara de spam.
    if (!mu) {
      // A frase muda conforme o motivo: mandar o vendedor "gravar de novo" quando o problema e a Meta
      // recusando o formato faz ele gravar dez vezes e nada resolver.
      const amigavel = _motivo.startsWith('meta_recusou') ? 'O WhatsApp recusou o formato deste áudio. Grave pelo celular ou pelo Chrome (o Safari grava num formato que a Meta não aceita como voz).'
        : _motivo.startsWith('r2_http') || _motivo === 'nao_baixou_do_r2' ? 'O áudio não foi encontrado no servidor. Grave de novo.'
          : _motivo === 'arquivo_vazio' ? 'A gravação saiu vazia. Segure o botão até terminar de falar.'
            : 'Não consegui preparar o áudio pra enviar como voz. Tente gravar de novo.';
      return { ok: false, error: amigavel, motivo: _motivo };
    }
    payload = { messaging_product: 'whatsapp', to: num, type: 'audio', audio: mu.isOpus ? { id: mu.id, voice: true } : { id: mu.id } };
    // Fica registrado quando NAO foi como nota de voz, pra dar pra achar depois de quem e o problema
    // (hoje: iPhone/Safari, que so grava AAC e nao tem o conversor do navegador).
    if (!mu.isOpus) { try { console.log('WA_AUDIO_NAO_VOZ', atId, num); } catch (_) {} }
  } else {
    payload = { messaging_product: 'whatsapp', to: num, type: kind, [kind]: media };
  }
  const g = await _graph(env, `/${encodeURIComponent(apiNum.phone_number_id)}/messages`, {
    method: 'POST', token: apiNum.token, retry: 1, body: JSON.stringify(payload)
  });
  if (!g.ok) { const e = (g.data && g.data.error) || {}; await _waFalhaLog(env, { phone: num, instance: 'ax_' + atId, kind: 'midia/template', code: e.code || g.status, msg: e.message || '' }); return { ok: false, error: _waErroTxt(e.code, e.message || ('graph ' + g.status)), code: e.code || g.status }; }
  const wamid = g.data && g.data.messages && g.data.messages[0] && g.data.messages[0].id;
  // A instancia da SAIDA leva o numero que REALMENTE enviou. O _waLogMsg faz upsert em wa_chats
  // com essa instancia; gravando 'ax_<at>' pelado, a saida APAGAVA da conversa a pista de qual
  // numero atende aquele lead, e a proxima resposta saia pelo outro numero (janela fechada, 131047).
  const inst = _instComNumero(atId, apiNum && apiNum.display_phone, '');
  try { await _waLogMsg(env, { phone: num, instance: inst, direction: 'out', type: kind, body: opts.caption || '', msgId: wamid, media_url: opts.mediaKey || opts.link }); } catch (_) {}
  return { ok: true, id: wamid || null };
}
// POST /api/wa/cloud/send-media { number, kind, link, caption?, filename?, mediaKey?, at_id? }
async function handleWACloudSendMedia(req, env) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  let b; try { b = await req.json(); } catch (_) { b = {}; }
  if (!(await _podeFalarNaConversa(env, u, b.number))) return err(String(u.role || '').toLowerCase() === 'cobrador' ? 'Sua área do inbox é só pra consulta' : 'Essa conversa é de outro atendente', 403);
  const atId = (isDirector(u) && b.at_id != null) ? String(b.at_id) : String(u.id);
  const _evo = await _instEvoViva(env, b.number, b.instance);
  if (_evo) {
    const num = String(b.number || '').replace(/\D/g, '');
    const kind = ['image', 'audio', 'video', 'document'].includes(String(b.kind)) ? String(b.kind) : 'document';
    let rr = null;
    if (kind === 'audio') {
      // NOTA DE VOZ, nao arquivo de audio: e assim que o vendedor grava no microfone da dash.
      let b64 = '';
      try { if (b.mediaKey && env.MEDIA) { const o = await env.MEDIA.get(String(b.mediaKey)); if (o) b64 = _bytesToB64(new Uint8Array(await o.arrayBuffer())); } } catch (_) {}
      if (!b64 && b.link) { try { const g = await fetch(String(b.link)); if (g.ok) b64 = _bytesToB64(new Uint8Array(await g.arrayBuffer())); } catch (_) {} }
      if (!b64) return json({ ok: false, error: 'Não consegui ler o áudio pra enviar.', code: 'sem_midia' }, 400);
      rr = await _waSendAudio(env, _evo, num, b64);
    } else {
      rr = await _waSendMedia(env, _evo, num, { mediatype: kind, media: String(b.link || ''), ...(b.filename ? { fileName: String(b.filename) } : {}), ...(b.caption ? { caption: String(b.caption) } : {}) });
    }
    if (!rr || rr.ok === false || rr._noconfig) return json({ ok: false, error: 'O WhatsApp deste número não respondeu agora. Tente de novo.', code: 'evo' }, 502);
    const _id = (rr.data && rr.data.key && rr.data.key.id) || null;
    try { await _waLogMsg(env, { phone: num, instance: _evo, direction: 'out', type: kind, body: String(b.caption || ''), msgId: _id, media_url: String(b.link || '') }); } catch (_) {}
    return json({ ok: true, id: _id, via: 'evolution' });
  }
  const r = await _waCloudSendMedia(env, atId, b.number, { kind: b.kind, link: b.link, caption: b.caption, filename: b.filename, mediaKey: b.mediaKey });
  if (!r.ok) return json({ ok: false, error: r.error, code: r.code || null }, r.code === 'window_closed' ? 409 : 400);
  return json({ ok: true, id: r.id, via: 'cloud' });
}

// ── Gestão multi-instância (1 número/instância por atendente) ──
// Helper: chama a Evolution com a config global (url+key do D1). Nunca expõe a key.
async function evoFetch(env, path, opts = {}) {
  const cfg = await getWAConfig(env);
  if (!cfg.url || !cfg.key) return { _noconfig: true };
  // TIMEOUT obrigatório: sem ele, VPS pendurada = requisição pendurada, e a dash inteira trava
  // esperando (o painel de conexão chama isso a cada 30s). Melhor falhar rápido e dizer que caiu.
  try {
    const r = await fetch(`${cfg.url}${path}`, {
      method: opts.method || 'GET',
      headers: { apikey: cfg.key, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeout || 12000),
    });
    const text = await r.text();
    let data = {}; try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: {}, _timeout: true, _err: String((e && e.message) || e) };
  }
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
  if (!(await _podeFalarNaConversa(env, u, body.number))) return err(String(u.role || '').toLowerCase() === 'cobrador' ? 'Sua área do inbox é só pra consulta' : 'Essa conversa é de outro atendente', 403);
  const instance = (await _resolveSendInstance(env, { atId: (body.at_id != null ? String(body.at_id) : String(u.id)), phone: body.number, hint: body.instance }))
    || String(body.instance || cfg.instance || '').trim();
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
  if (!(await _podeFalarNaConversa(env, u, body.number))) return err(String(u.role || '').toLowerCase() === 'cobrador' ? 'Sua área do inbox é só pra consulta' : 'Essa conversa é de outro atendente', 403);
  const instance = (await _resolveSendInstance(env, { atId: (body.at_id != null ? String(body.at_id) : String(u.id)), phone: body.number, hint: body.instance }))
    || String(body.instance || cfg.instance || '').trim();
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
  // O NOME DA INSTANCIA CARREGA O ID DO VENDEDOR (ax_<id>_<8dig>), entao listar todas entregava o
  // mapa da nossa operacao - e servia de cardapio pras rotas de envio, que aceitam `instance` do
  // corpo. Auditoria de 24/08/2026.
  const _idsInst = await _idsQuePossoVer(env, u);
  const res = await evoFetch(env, '/instance/fetchInstances');
  if (res._noconfig) return err('WhatsApp não configurado', 503);
  if (!res.ok) return err(`Evolution respondeu ${res.status}`, 502);
  // Normaliza pra { name, state } (a Evolution varia o formato entre versões)
  const arr = Array.isArray(res.data) ? res.data : (res.data?.instances || []);
  const list = arr.map(x => {
    const i = x.instance || x;
    return { name: i.instanceName || i.name, state: i.connectionStatus || i.state || i.status || 'unknown' };
  }).filter(x => x.name);
  return json({ ok: true, instances: _filtraInst(list, _idsInst) });
}

// POST /api/wa/instance/create → { instanceName } cria (idempotente) e já devolve QR
async function handleWAInstanceCreate(req, env, ctx) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const body = await req.json().catch(() => null);
  const name = String(body?.instanceName || '').trim();
  if (!name) return err('instanceName obrigatório');
  // SO O DONO DO NUMERO (ou um diretor). Esta rota nao e so "criar": com reset:true, e tambem no
  // ramo sem QR, ela faz logout + delete na Evolution e limpa o wa_conn. Estava aberta pra qualquer
  // login, entao qualquer usuario derrubava o WhatsApp de qualquer vendedor com uma chamada - e com
  // verba rodando o lead chega e nao entra em lugar nenhum.
  // NAO uso isDirector puro de proposito: o atendente precisa gerar o QR do proprio numero.
  if (!isDirector(u) && _atFromInst(name) !== String(u.id)) return err('Esse número não é seu', 403);
  // RESET EXPLÍCITO (só quando o usuário pede, ex: clicou em "conectado com outro número").
  // Derruba a sessão atual de verdade e apaga a instância, pra o QR novo nascer limpo. Não fica no
  // caminho normal de conexão de propósito: é lento (logout + delete + espera) e antes rodava em
  // TODO clique, o que deixava conectar um número em ~10s.
  if (body?.reset) {
    try { await evoFetch(env, `/instance/logout/${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (_) {}
    try { await evoFetch(env, `/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (_) {}
    try { await env.DB.prepare('DELETE FROM wa_conn WHERE instance=?').bind(name).run(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));   // o Baileys precisa de um respiro antes de recriar
  }
  // CAMINHO CURTO, igual à dash antiga (que conectava quase instantâneo): cria (idempotente) e já
  // pede o QR. Nada de checar estado, deslogar, apagar e recriar aqui — isso custava ~10s por clique
  // e é o que deixou a conexão lenta e instável. Se não vier QR, quem trata é o front (reset + retry).
  // syncFullHistory:false + groupsIgnore:true = menos RAM por número e menos ruído (grupo não vira lead).
  const cr = await evoFetch(env, '/instance/create', {
    method: 'POST',
    body: { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS', syncFullHistory: false, groupsIgnore: true },
  });
  if (cr._noconfig) return err('WhatsApp não configurado', 503);
  // Registrar o webhook é obrigatório (é o que faz o lead voltar pra dash), mas NÃO precisa segurar
  // o QR na tela. waitUntil garante que roda até o fim mesmo depois da resposta sair.
  const _hook = (async () => { try { await _waSetWebhook(env, name, new URL(req.url).origin); } catch (_) {} })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(_hook); else await _hook;
  // O QR já costuma vir no create (qrcode:true); senão, UMA tentativa pelo connect.
  let qr = cr.data?.qrcode?.base64 || cr.data?.base64 || cr.data?.qr || null;
  let pairingCode = cr.data?.qrcode?.pairingCode || cr.data?.pairingCode || cr.data?.code || null;
  // No reset, o Baileys às vezes leva um instante pra ter o QR pronto: tenta mais de uma vez.
  // No fluxo normal segue uma tentativa só (é o que mantém a conexão rápida).
  const tentativas = body?.reset ? 4 : 1;
  for (let i = 0; i < tentativas && !qr; i++) {
    if (i) await new Promise((r) => setTimeout(r, 700));
    const res = await evoFetch(env, `/instance/connect/${encodeURIComponent(name)}`);
    if (res._noconfig) return err('WhatsApp não configurado', 503);
    qr = res.data?.base64 || res.data?.qrcode?.base64 || res.data?.qr || null;
    pairingCode = pairingCode || res.data?.pairingCode || res.data?.code || null;
  }
  // AINDA sem QR = a instância está PRESA (segurando uma sessão que não é a que queremos, ou morta).
  // Nesse ponto a Evolution não vai emitir QR nenhum enquanto ela existir. Reseta e tenta de novo,
  // que é exatamente o que a dash antiga fazia. Isso só roda no caso travado, então não pesa no
  // caminho normal — e resolve o "não consegui gerar o QR" sem depender de o front pedir reset.
  if (!qr && !body?.reset) {
    try { await evoFetch(env, `/instance/logout/${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (_) {}
    try { await evoFetch(env, `/instance/delete/${encodeURIComponent(name)}`, { method: 'DELETE' }); } catch (_) {}
    try { await env.DB.prepare('DELETE FROM wa_conn WHERE instance=?').bind(name).run(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));
    const cr2 = await evoFetch(env, '/instance/create', {
      method: 'POST',
      body: { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS', syncFullHistory: false, groupsIgnore: true },
    });
    qr = cr2.data?.qrcode?.base64 || cr2.data?.base64 || cr2.data?.qr || null;
    pairingCode = pairingCode || cr2.data?.qrcode?.pairingCode || cr2.data?.pairingCode || null;
    for (let i = 0; i < 4 && !qr; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const res2 = await evoFetch(env, `/instance/connect/${encodeURIComponent(name)}`);
      qr = res2.data?.base64 || res2.data?.qrcode?.base64 || res2.data?.qr || null;
      pairingCode = pairingCode || res2.data?.pairingCode || res2.data?.code || null;
    }
    try { await _waSetWebhook(env, name, new URL(req.url).origin); } catch (_) {}
  }
  return json({ ok: true, instance: name, qr, pairingCode });
}

// GET /api/wa/instance/connect?instance=NAME → QR atualizado pra reconectar
// Pode tocar nesta instancia? Fail-closed: nome que nao resolve num atendente do mundo dele nao passa.
async function _instMinha(env, u, name) {
  const ids = await _idsQuePossoVer(env, u);
  if (ids === null) return true;
  return _instEhDe(name, ids);
}
async function handleWAInstanceConnect(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // AS IRMAS (create e disconnect) JA TINHAM ESTA GUARDA; esta faltava. Sem ela, o afiliado gerava o
  // QR de uma instancia NOSSA desconectada, pareava o celular dele no nosso slot e derrubava o
  // vendedor da roleta - e o worker ainda RECRIAVA a instancia no 404. Auditoria de 24/08/2026.
  {
    const _n = String(new URL(req.url).searchParams.get('instanceName') || new URL(req.url).searchParams.get('name') || '');
    if (_n && !(await _instMinha(env, u, _n))) return err('Instância não encontrada', 404);
  }
  const name = new URL(req.url).searchParams.get('instance');
  if (!name) return err('parâmetro "instance" obrigatório');
  // JA CONECTADO = NAO ENCOSTA. Pedir QR pra uma instancia que acabou de parear e o que estava
  // DERRUBANDO a conexao: a Evolution recusa o connect nesse estado, o codigo abaixo lia o "!ok"
  // como "instancia sumiu" e RECRIAVA - matando a sessao que o vendedor tinha acabado de ativar no
  // celular. Foi o "conecta, aparece sincronizando e cai" de 21/08/2026 (a instancia do Murilo
  // abriu 14:51 e voltou pra close as 15:00). Agora confere o estado ANTES.
  const st0 = await evoFetch(env, `/instance/connectionState/${encodeURIComponent(name)}`);
  if (st0._noconfig) return err('WhatsApp não configurado', 503);
  if (st0.ok && String(st0.data?.instance?.state || '') === 'open') {
    return json({ ok: true, instance: name, qr: null, state: 'open', pairingCode: null });
  }
  let res = await evoFetch(env, `/instance/connect/${encodeURIComponent(name)}`);
  if (res._noconfig) return err('WhatsApp não configurado', 503);
  // 404 = a instância não existe (foi apagada num reset). Antes isso virava "Evolution respondeu 404"
  // vermelho na cara do usuário. Quem abre essa tela quer um QR, não um código de status: então
  // recria a instância e pede o QR de novo. Autocura, sem erro técnico na tela.
  // SO recria quando a instancia REALMENTE nao existe (404). Recriar por qualquer erro derrubava
  // sessao viva - ver o comentario acima.
  if (!res.ok && res.status === 404) {
    await evoFetch(env, '/instance/create', {
      method: 'POST',
      body: { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS', syncFullHistory: false, groupsIgnore: true },
    });
    try { await _waSetWebhook(env, name, new URL(req.url).origin); } catch (_) {}
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 600));
      res = await evoFetch(env, `/instance/connect/${encodeURIComponent(name)}`);
      if (res.ok && (res.data?.base64 || res.data?.qrcode?.base64 || res.data?.qr)) break;
    }
  }
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
  const state = res.data?.instance?.state || 'unknown';
  // Ao CONECTAR, já devolve QUAL número entrou e grava no wa_conn na hora. Assim a pressel fica
  // verde imediatamente, sem esperar o próximo ciclo de leitura (eram ~5s de vermelho depois de
  // um QR que já tinha dado certo). Só custa a consulta extra no momento da conexão.
  let number = '';
  if (state === 'open') {
    try {
      // A Evolution leva um instante pra publicar o dono da sessão (ownerJid) depois do QR. Enquanto
      // ela não publica, a dash não tem como saber que ESTE número conectou e a linha fica vermelha
      // (eram os ~10s de espera que o Bruno via). Insiste um pouco aqui, que é barato e acontece só
      // no momento da conexão.
      let live = await _evoInstances(env);
      let it = (live || []).find((x) => x.name === name);
      number = (it && it.number) || '';
      for (let i = 0; i < 2 && !number; i++) {
        await new Promise((r) => setTimeout(r, 600));
        live = await _evoInstances(env);
        it = (live || []).find((x) => x.name === name);
        number = (it && it.number) || '';
      }
      if (number) {
        await env.DB.prepare(
          `INSERT INTO wa_conn (instance, state, number, updated_at) VALUES (?, 'open', ?, strftime('%s','now'))
           ON CONFLICT(instance) DO UPDATE SET state='open', number=excluded.number, updated_at=excluded.updated_at`
        ).bind(name, number).run();
      }
    } catch (_) {}
  }
  return json({ ok: true, instance: name, state, number });
}

// POST /api/wa/instance/logout → { instance } desconecta e remove a instância
async function handleWAInstanceLogout(req, env) {
  _evoCache = null;
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
  _evoCache = null;   // some com o cache: a queda tem que aparecer na hora
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  let body = {}; try { body = await req.json(); } catch (_) {}
  const name = String(body?.instance || '').trim();
  if (!name) return err('instance obrigatório');
  // SO O DONO DO NUMERO (ou um diretor) DERRUBA. Estava aberto pra qualquer login: um clique e o
  // WhatsApp de outro vendedor caia, e com verba rodando o lead chega e nao entra em lugar nenhum.
  // O nome da instancia carrega o atendente (ax_<at>_<8digitos>), entao da pra conferir sem consultar.
  if (!isDirector(u) && _atFromInst(name) !== String(u.id)) return err('Esse numero nao e seu', 403);
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
    try { await env.DB.prepare('ALTER TABLE wa_messages ADD COLUMN media_url TEXT').run(); } catch (_) {}   // chave R2 da mídia (imagem/áudio/vídeo/doc) pro render inline no inbox
    // O QUE A META RESPONDEU DEPOIS. A gente guardava só que MANDOU: o inbox dizia "enviado" porque
    // a requisição saiu, não porque chegou. Em 18/08/2026 um vendedor mandou áudio, o inbox mostrou
    // enviado, e 15 minutos depois a mensagem não estava no WhatsApp do lead. A Meta AVISA isso por
    // webhook (sent/delivered/read/failed + o motivo do erro) e a gente ignorava o aviso inteiro.
    try { await env.DB.prepare('ALTER TABLE wa_messages ADD COLUMN status TEXT').run(); } catch (_) {}     // sent | delivered | read | failed
    try { await env.DB.prepare('ALTER TABLE wa_messages ADD COLUMN err TEXT').run(); } catch (_) {}        // motivo, quando failed
    try { await env.DB.prepare('ALTER TABLE wa_messages ADD COLUMN status_ts INTEGER').run(); } catch (_) {}
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON wa_messages(phone, ts)').run();
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_msg_inst_ts ON wa_messages(instance, ts)').run(); } catch (_) {}   // carga recente por instância (balanceador)
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_chats_inst_last ON wa_chats(instance, last_ts)').run(); } catch (_) {}   // inbox do atendente ordenado por recente
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_chats_last ON wa_chats(last_ts)').run(); } catch (_) {}   // inbox do diretor (todos os números)
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_chats (phone TEXT PRIMARY KEY, instance TEXT, name TEXT, last_text TEXT, last_ts INTEGER, last_dir TEXT, unread INTEGER DEFAULT 0, assigned_to TEXT, updated_at INTEGER)').run();
    try { await env.DB.prepare('ALTER TABLE wa_chats ADD COLUMN crm_stage TEXT').run(); } catch (_) {}   // etapa do CRM do atendimento (novo/atendimento/sem_resposta/qualificado/fechou/perdido)
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
    const type = m.type || 'text';
    const body = String(m.body == null ? '' : m.body).slice(0, 4000);
    // SEM msg_id A DEDUPLICACAO NAO EXISTE. O id vira aleatorio, o INSERT OR IGNORE nunca colide e a
    // MESMA mensagem entra de novo por outro caminho. Foi assim que o Bruno viu 4 baloes iguais em
    // 19/08/2026 (webhook do Datacrazy gravando sem id) e uma venda "Pedido Concluido" duplicada
    // (scan gravando o id sem o prefixo 'dc:'). Consertei os dois na origem, mas AINDA existem
    // caminhos que podem chegar aqui sem id (auto-resposta do bot pela Evolution, ingest do Sale
    // Chat e webhook da Cloud quando a origem nao manda id), entao a guarda fica AQUI, valendo pra
    // todos - inclusive pros que forem escritos amanha.
    //
    // A ASSIMETRIA E DE PROPOSITO e vale mais que a simetria:
    //   SAIDA sem id  -> deduplica. Nos sabemos que mandamos uma vez; repetir na tela e ruido, e
    //                    mandar de novo pro cliente e o que queima numero.
    //   ENTRADA sem id -> NAO deduplica, insere sempre. Lead pode mandar "sim" duas vezes em 1min de
    //                    verdade, e SUMIR com mensagem de lead e o pior defeito possivel deste inbox
    //                    (foi o que consertei de manha). Balao repetido incomoda; mensagem perdida
    //                    custa venda. Fica so o log pra achar o caminho culpado.
    let id = m.msgId;
    if (!id) {
      if (dir === 'out') {
        try {
          const ja = await env.DB.prepare(
            "SELECT 1 FROM wa_messages WHERE phone=? AND direction='out' AND type=? AND COALESCE(body,'')=? AND ts > ? LIMIT 1"
          ).bind(phone, type, body, ts - 120).first();
          if (ja) return;   // ja registramos este envio
        } catch (_) {}
      } else {
        try { console.error('WA_MSG_SEM_ID entrada fone=' + phone + ' tipo=' + type + ' inst=' + String(m.instance || '')); } catch (_) {}
      }
      id = dir + '_' + ts + '_' + Math.random().toString(36).slice(2, 8);
    }
    // DEDUP DE ENTRADA ENTRE FONTES (26/08/2026). O MESMO inbound chega por DOIS caminhos com id
    // DIFERENTE: webhook da Cloud API ('wamid.<id>') e Datacrazy ('dc:<id>') — e às vezes Evolution.
    // Como o PK é o msg_id, cada fonte insere e o balão aparece 2x (visto em 558781723121: 'wamid.' e
    // 'dc:', MESMO ts 18:13:57, MESMO texto). O Datacrazy NÃO expõe o wamid (conferido na API deles:
    // campos id/createdAt/received/attachments, nenhum id do WhatsApp), então não dá pra convergir o id
    // na origem. Deduplica aqui pelo que as fontes têm IGUAL: telefone + ts EXATO + tipo + corpo.
    // ts EXATO de propósito: repetição de verdade do lead ("sim" "sim") sai em segundos DIFERENTES e
    // por isso NUNCA é fundida — sumir com mensagem de lead é o pior defeito, balão repetido é só ruído.
    // Só roda quando há msg_id (o caso das duas fontes); entrada SEM id segue inserindo sempre (regra
    // antiga de nunca perder mensagem de lead). Ligado a [[inbox-datacrazy-poll-vs-sync]].
    if (dir === 'in' && m.msgId) {
      try {
        const dup = await env.DB.prepare(
          "SELECT msg_id FROM wa_messages WHERE phone=? AND direction='in' AND type=? AND COALESCE(body,'')=? AND ts=? AND msg_id<>? LIMIT 1"
        ).bind(phone, type, body, ts, id).first();
        if (dup) {
          // Preferir o 'wamid' quando ele chega DEPOIS do 'dc:' (recibo de leitura e citação precisam
          // dele): sobe o id da linha existente pro wamid e completa mídia/instância se faltarem.
          if (String(id).startsWith('wamid') && !String(dup.msg_id).startsWith('wamid')) {
            try {
              await env.DB.prepare(
                "UPDATE wa_messages SET msg_id=?, media_url=COALESCE(media_url, ?), instance=CASE WHEN COALESCE(instance,'')='' THEN ? ELSE instance END WHERE msg_id=?"
              ).bind(id, m.media_url || null, m.instance || '', dup.msg_id).run();
            } catch (_) {}
          }
          return;   // dedup: a mensagem já está na thread pela outra fonte
        }
      } catch (_) {}
    }
    await env.DB.prepare(
      'INSERT OR IGNORE INTO wa_messages (msg_id, phone, instance, direction, type, body, push_name, ts, media_url) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind(id, phone, m.instance || '', dir, type, body, m.pushName || '', ts, m.media_url || null).run();
    // Preenche a mídia depois (download assíncrono da Cloud API grava o media_url pós-INSERT).
    if (m.media_url) { try { await env.DB.prepare('UPDATE wa_messages SET media_url=? WHERE msg_id=?').bind(m.media_url, id).run(); } catch (_) {} }
    const incUnread = dir === 'in' ? 1 : 0;
    const preview = type === 'text' ? body : ('[' + type + ']');
    await env.DB.prepare(
      `INSERT INTO wa_chats (phone, instance, name, last_text, last_ts, last_dir, unread, updated_at)
       VALUES (?,?,?,?,?,?,?,strftime('%s','now'))
       ON CONFLICT(phone) DO UPDATE SET
         -- QUEM RECEBEU manda no carimbo. Antes era instance = excluded.instance seco, entao um
         -- ENVIO pelo chip errado reescrevia a conversa com esse chip, e o resolveApiNumber (passo 1)
         -- passava a ler dali: errou uma vez, travou ali pra sempre. Em 19/08/2026 o Guilherme ficou
         -- com 6 conversas presas no 15 97407-6200 (chip que nao recebe inbound desde 28/07) e TODA
         -- resposta morria com 131047. Agora: entrada sempre manda; saida so carimba se a conversa
         -- ainda nao souber o numero.
         instance = CASE WHEN excluded.last_dir = 'in' THEN excluded.instance
                         WHEN wa_chats.instance GLOB '*_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
                           OR wa_chats.instance GLOB 'dc_[0-9]*' THEN wa_chats.instance
                         ELSE excluded.instance END,
         name = COALESCE(NULLIF(excluded.name,''), wa_chats.name),
         last_text = excluded.last_text,
         last_ts = excluded.last_ts,
         last_dir = excluded.last_dir,
         unread = CASE WHEN ? = 1 THEN wa_chats.unread + 1 ELSE wa_chats.unread END,
         updated_at = excluded.updated_at
       WHERE excluded.last_ts > COALESCE(wa_chats.last_ts, 0)`
    ).bind(phone, m.instance || '', m.pushName || '', preview, ts, dir, incUnread, incUnread).run();
    // Auto CRM: a 1ª resposta do ATENDENTE (não do bot/auto-reply) tira o lead de "Lead Novo" pra
    // "Em Atendimento". Só sobe de novo/vazio — não mexe nas etapas manuais nem na lixeira.
    if (dir === 'out' && !m.bot) {
      try { await env.DB.prepare("UPDATE wa_chats SET crm_stage='atendimento', updated_at=strftime('%s','now') WHERE phone=? AND (crm_stage IS NULL OR crm_stage='' OR crm_stage='novo')").bind(phone).run(); } catch (_) {}
    }
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
          await _waLogMsg(env, { phone: realPhone, instance, direction: 'out', type: 'text', body: part, bot: true });
          // guarda a resposta no buffer (vira histórico do bot na próxima vez)
          try { await env.DB.prepare('INSERT OR IGNORE INTO wa_buf (id, phone, jid, ts, kind, payload, done) VALUES (?,?,?,?,?,?,1)').bind('out_' + myMsgId + '_' + (oi++), realPhone, jid, Date.now(), 'out', part).run(); } catch (_) {}
        }
      }
      return true;
    } catch (_) { continue; }
  }
  return true;
}
async function _waOnInbound(env, instance, data, ctx) {
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
  // Mídia recebida: baixa o arquivo cheio pro R2 e preenche media_url (assíncrono, não bloqueia).
  if (['image', 'audio', 'ptt', 'voice', 'video', 'document', 'sticker'].includes(_ex.type)) {
    const _mm = data && data.message ? data.message : {};
    if (ctx && ctx.waitUntil) ctx.waitUntil(_waEvoDownloadMedia(env, instance, key, _mm, key.id));
    else await _waEvoDownloadMedia(env, instance, key, _mm, key.id);
  }
  // Sale Chat Engine (sombra): espelha o inbound da Evolution na auditoria crua pra comparar cobertura (sc x evo). Fire-and-forget, nunca afeta o fluxo.
  try { await env.DB.prepare("INSERT INTO sc_ingest_audit (source, self_number, phone, from_me, msg_id, type, body, push_name, ts, received_at, at_id) VALUES ('evo',?,?,0,?,?,?,?,?,strftime('%s','now'),?)").bind(String(instance || ''), phone, String(key.id || ''), String(_ex.type || 'text'), String(_ex.body || '').slice(0, 2000), String(data?.pushName || ''), Number(data?.messageTimestamp) || 0, _atFromInst(instance)).run(); } catch (_) {}
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
  await _waLogMsg(env, { phone, instance, direction: 'out', type: 'text', body: msg, bot: true });
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
      // A chave global (sc) vale pros números do Sale Chat. MAS um número conectado por QR na Evolution
      // tem instância DEDICADA (ax_<at>_<8díg>) e SÓ é visto aqui — o Sale Chat nem o enxerga. Então
      // ele computa pela Evolution mesmo com a global em 'sc', sem duplicar: os dois caminhos são
      // DISJUNTOS (cada número físico está num único path). Números legados (ax_<at>) seguem a global.
      const perNumEvo = /^ax_.+_\d{8}$/.test(String(instance || ''));
      if ((await _waCaptureSource(env)) === 'sc' && !perNumEvo) { /* fonte = Sale Chat */ }
      else { await _waOnInbound(env, instance, data, ctx); await _waDetectSale(env, instance, data); }
    }
    else if (event === 'messages.update') {
      // ACK DE ENTREGA DA EVOLUTION (26/08/2026). Os números de QR/Evolution NÃO davam retorno nenhum:
      // o inbox mostrava "enviado" pra sempre e, se o áudio não saía, NINGUÉM via (queixa do vendedor,
      // 26/08). A Cloud API já processa isto (statuses do webhook da Meta, ~linha 7124); aqui é o mesmo
      // pros números da Evolution. Casa pelo msg_id que a gente gravou no envio (res.data.key.id) com o
      // keyId/key.id do update. Aceita as DUAS formas de payload (array cru do Baileys e objeto
      // normalizado da Evolution) e status tanto string ('DELIVERY_ACK') quanto número (Baileys 2/3/4).
      // Só AVANÇA (read não volta pra sent) e 'failed'/ERROR sempre ganha. Se a Evolution não estiver
      // inscrita no evento MESSAGES_UPDATE, este ramo fica dormente (nunca dispara) — não quebra nada.
      // Ligado a [[carimbo-chip-conversa-131047]], [[inbox-datacrazy-poll-vs-sync]].
      const ups = Array.isArray(data) ? data : [data];
      const _mapa = { pending: 'sent', server_ack: 'sent', delivery_ack: 'delivered', read: 'read', read_ack: 'read', played: 'read', error: 'failed' };
      const _rank = { sent: 1, delivered: 2, read: 3 };
      for (const u of ups) {
        if (!u || typeof u !== 'object') continue;
        const mid = String(u.keyId || (u.key && u.key.id) || u.messageId || '').trim();
        if (!mid) continue;
        const raw = String((u.status != null ? u.status : (u.update && u.update.status)) || '').toLowerCase();
        const estado = _mapa[raw] || (raw === '2' ? 'sent' : raw === '3' ? 'delivered' : (raw === '4' || raw === '5') ? 'read' : (raw === '0' || raw === '1') ? 'failed' : '');
        if (!estado) continue;
        try {
          if (estado === 'failed') {
            await env.DB.prepare("UPDATE wa_messages SET status='failed', err=COALESCE(NULLIF(err,''),'Evolution: falha na entrega'), status_ts=strftime('%s','now') WHERE msg_id=? AND direction='out'").bind(mid).run();
          } else {
            await env.DB.prepare(
              `UPDATE wa_messages SET status=?, status_ts=strftime('%s','now') WHERE msg_id=? AND direction='out'
                 AND COALESCE(status,'') <> 'failed'
                 AND (CASE COALESCE(status,'') WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END) < ?`
            ).bind(estado, mid, _rank[estado]).run();
          }
        } catch (_) {}
      }
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
    // Número da API OFICIAL (Cloud API). Identidade de TRANSPORTE (phone_number_id, waba_id) — separada
    // da atribuição (wa_number_owner), que é re-semeada/soft-deleted todo cron. Join por num_key.
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_api_numbers (phone_number_id TEXT PRIMARY KEY, display_phone TEXT, num_key TEXT, waba_id TEXT, at_id TEXT, quality TEXT, name_status TEXT, verified INTEGER DEFAULT 0, updated_at INTEGER, created_at INTEGER)').run();
    try { await env.DB.prepare('ALTER TABLE wa_api_numbers ADD COLUMN token TEXT').run(); } catch (_) {}   // token da Meta do PRÓPRIO número (vem do Datacrazy /instances) — envio usa ele, não o wa_api_token
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_api_key ON wa_api_numbers(num_key)').run(); } catch (_) {}
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_api_at ON wa_api_numbers(at_id)').run(); } catch (_) {}
    // Funil automático rodando numa conversa (envia os áudios um a um; para quando o lead responde).
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_funnel_run (phone TEXT PRIMARY KEY, at_id TEXT, seq_id TEXT, items TEXT, idx INTEGER, next_at INTEGER, status TEXT, updated_at INTEGER)').run();
    try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_wa_funnel_due ON wa_funnel_run(status, next_at)').run(); } catch (_) {}
    // CREATE TABLE IF NOT EXISTS nao acrescenta coluna em tabela que ja existe: as tres abaixo
    // precisam de ALTER proprio. tentativas = quantas vezes o passo atual falhou; parar_resp = a
    // caixinha "Parar se o lead responder"; iniciado_em = quando o funil comecou (pra so contar
    // resposta que veio DEPOIS disso).
    try { await env.DB.prepare('ALTER TABLE wa_funnel_run ADD COLUMN tentativas INTEGER DEFAULT 0').run(); } catch (_) {}
    try { await env.DB.prepare('ALTER TABLE wa_funnel_run ADD COLUMN parar_resp INTEGER DEFAULT 0').run(); } catch (_) {}
    try { await env.DB.prepare('ALTER TABLE wa_funnel_run ADD COLUMN iniciado_em INTEGER').run(); } catch (_) {}
    // POR QUAL NUMERO ESTE FUNIL FALA. Guardado no INICIO e nao redescoberto a cada passo: o
    // vendedor passou a ter DOIS numeros oficiais, e o chip vinha do carimbo da conversa, que muda
    // se o lead escrever pro outro numero nosso no meio do funil. Sem isto, o passo 3 sai por um
    // numero diferente do passo 2 e o lead ve a mesma sequencia vindo de dois contatos.
    try { await env.DB.prepare('ALTER TABLE wa_funnel_run ADD COLUMN inst TEXT').run(); } catch (_) {}
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
      // Chip marcado como API oficial → liga o vendedor (at_id) ao número oficial (Cloud API) por num_key.
      // O phone_number_id nasce no registro (Fase R); aqui só conecta o dono quando a linha já existe.
      if (c && c.api === true) {
        try { await env.DB.prepare("UPDATE wa_api_numbers SET at_id=?, updated_at=strftime('%s','now') WHERE num_key=?").bind(at, _waNumKey(num)).run(); } catch (_) {}
      }
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

// ─── API OFICIAL (Cloud API) ───────────────────────────────────────────────
// Chamada à Graph API v21.0 com o token de sistema permanente (wa_api_token). Espelha evoFetch.
// TROPECO DA META NAO PODE VIRAR FALHA NA CARA DO VENDEDOR. 131000 ("Something went wrong") e
// 131016 ("Service unavailable") nao dizem nada sobre a mensagem: sao erro do lado deles, sem causa
// do nosso. Idem 5xx e queda de rede (status 0). Aconteceu em 20/08/2026 com o Murilo, disparando
// funil: uma vez, e nunca mais. Com uma segunda tentativa 2s depois isso nao chega na tela.
// So vale com `retry: 1` explicito, e SO nos envios: nao e pra sair repetindo POST de configuracao.
const _GRAPH_TRANSITORIO = new Set([131000, 131016]);
// O QUE O VENDEDOR LE. A Meta responde em ingles e com o codigo colado no texto
// ("(#131000) Something went wrong"), que nao diz nada pra quem esta atendendo: ele nao sabe se a
// culpa e dele, se o lead recebeu, nem o que fazer. Cada codigo aqui vira uma frase que responde
// essas tres coisas. Codigo que nao esta na lista continua mostrando o texto cru da Meta.
const _WA_ERRO_PT = {
  131000: 'O WhatsApp tropeçou agora (erro temporário da Meta, não é você). Já tentei de novo automaticamente. Espere alguns segundos e mande outra vez.',
  131016: 'O serviço do WhatsApp está fora do ar neste momento. Tente de novo em instantes.',
  131026: 'A Meta não conseguiu entregar: o número pode não ter WhatsApp ou estar escrito errado.',
  131047: 'Janela de 24h fechada: esse lead só recebe por template aprovado agora.',
  131051: 'Esse tipo de mensagem não é aceito por este número.',
  130429: 'Muita mensagem em pouco tempo neste número. Espere um pouco antes de mandar de novo.',
  368: 'Número bloqueado temporariamente pela Meta por violação de política.',
};
const _waErroTxt = (code, cru) => _WA_ERRO_PT[Number(code)] || cru;
// REGISTRO DA FALHA. Sem isto, envio que falha na hora (a resposta da Meta, nao o webhook de
// status) nao deixa rastro nenhum: o vendedor ve o aviso vermelho, fecha, e nao sobra nada pra
// olhar depois. Foi o que aconteceu em 20/08/2026 com o 131000 do Murilo.
async function _waFalhaLog(env, o) {
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_send_fail (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, phone TEXT, instance TEXT, kind TEXT, code TEXT, msg TEXT)').run();
    await env.DB.prepare("INSERT INTO wa_send_fail (ts, phone, instance, kind, code, msg) VALUES (strftime('%s','now'),?,?,?,?,?)")
      .bind(String(o.phone || ''), String(o.instance || ''), String(o.kind || ''), String(o.code || ''), String(o.msg || '').slice(0, 300)).run();
  } catch (_) {}
}
function _graphTropecou(r) {
  if (!r || r.ok) return false;
  if (r.status === 0 || r.status >= 500) return true;
  const c = Number(r.data && r.data.error && r.data.error.code);
  return _GRAPH_TRANSITORIO.has(c);
}
async function _graph(env, path, opts = {}) {
  const { token: optToken, retry, ...fetchOpts } = opts;   // token do PRÓPRIO número (Datacrazy) tem prioridade; senão cai no wa_api_token
  const token = optToken || await _readConfig(env, 'wa_api_token');
  const base = 'https://graph.facebook.com/v21.0';
  const headers = { ...(fetchOpts.headers || {}) };
  if (token) headers.authorization = 'Bearer ' + token;
  if (fetchOpts.body && typeof fetchOpts.body === 'string' && !headers['content-type']) headers['content-type'] = 'application/json';
  const uma = async () => {
    try {
      const r = await fetch(base + (path.startsWith('/') ? path : '/' + path), { ...fetchOpts, headers });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok && !data.error, status: r.status, data, token_present: !!token };
    } catch (e) { return { ok: false, status: 0, data: { error: { message: String(e) } }, token_present: !!token }; }
  };
  let out = await uma();
  const _n = Math.max(0, Math.min(Number(retry) || 0, 2));
  for (let i = 0; i < _n && _graphTropecou(out); i++) {
    console.log('GRAPH_RETRY ' + path + ' status=' + out.status + ' code=' + String((out.data && out.data.error && out.data.error.code) || ''));
    await _dorme(2);
    out = await uma();
  }
  return out;
}
// Grava/atualiza o número oficial. at_id/quality/etc só sobrescrevem quando vêm preenchidos (COALESCE).
async function _waApiUpsert(env, o) {
  await _scEnsureTables(env);
  const pnid = String((o && o.phone_number_id) || '').trim();
  if (!pnid) return;
  const disp = String((o && o.display_phone) || '').replace(/\D/g, '');
  await env.DB.prepare(
    `INSERT INTO wa_api_numbers (phone_number_id, display_phone, num_key, waba_id, at_id, quality, name_status, verified, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,strftime('%s','now'),strftime('%s','now'))
     ON CONFLICT(phone_number_id) DO UPDATE SET
       display_phone=COALESCE(excluded.display_phone, wa_api_numbers.display_phone),
       num_key=COALESCE(excluded.num_key, wa_api_numbers.num_key),
       waba_id=COALESCE(excluded.waba_id, wa_api_numbers.waba_id),
       at_id=COALESCE(excluded.at_id, wa_api_numbers.at_id),
       quality=COALESCE(excluded.quality, wa_api_numbers.quality),
       name_status=COALESCE(excluded.name_status, wa_api_numbers.name_status),
       verified=MAX(excluded.verified, wa_api_numbers.verified),
       updated_at=excluded.updated_at`
  ).bind(pnid, disp || null, disp ? _waNumKey(disp) : null, (o.waba_id || null), (o.at_id != null && o.at_id !== '' ? String(o.at_id) : null), (o.quality || null), (o.name_status || null), (o.verified ? 1 : 0)).run();
}
// Tira os 8 dígitos finais do NOSSO número de dentro da instância da conversa.
// Formatos que existem em produção hoje: `ax_<at>_<8díg>` (padrão da dash) e `dc_<número cheio>`
// (número do Datacrazy ainda sem dono). `ax_<at>` e `ax_<at>_b` não carregam número: devolve ''.
// A instancia PRECISA dizer QUAL numero recebeu, senao a resposta sai por outro.
//
// Incidente de 18/08/2026: o lead escreveu 11:17 e o audio saiu 13:38 - duas horas depois, dentro
// da janela. A Meta recusou com 131047 ("mais de 24h desde a ultima resposta PARA ESTE NUMERO"),
// porque a resposta saiu por um numero diferente do que recebeu. O vendedor tem dois numeros, e a
// instancia gravada no inbound era so 'ax_<at>', sem dizer qual. Sem essa pista o resolveApiNumber
// escolhe um dos dois, e quando escolhe o errado a janela esta fechada e a mensagem morre calada.
function _instComNumero(atId, selfNumber, ownInst) {
  if (_instNum8(ownInst)) return String(ownInst);          // ja veio com o numero: mantem
  const d = String(selfNumber || '').replace(/\D/g, '');
  const n8 = d.length >= 8 ? d.slice(-8) : '';
  if (atId != null && n8) return 'ax_' + atId + '_' + n8;
  return ownInst || (atId != null ? ('ax_' + atId) : '');
}

function _instNum8(inst) {
  const s = String(inst || '');
  let m = /_(\d{8})$/.exec(s);
  if (m) return m[1];
  m = /^dc_(\d{10,15})$/.exec(s);
  if (m) return m[1].slice(-8);
  return '';
}
// Resolve o número OFICIAL de transporte (de onde a mensagem SAI).
// ORDEM: 1) o número que RECEBEU a conversa  2) o at_id (vendedor)  3) o telefone informado.
async function resolveApiNumber(env, opts = {}) {
  const cols = 'phone_number_id, waba_id, at_id, display_phone, verified, token';
  // Desempate ESTÁVEL. `updated_at` NÃO serve de critério: _dcSyncInstances e _scSeedOwners
  // reescrevem wa_api_numbers inteira a cada rodada do cron (2min) e os números caem no MESMO
  // segundo, então o "mais recente" virava sorteio e o vendedor respondia o mesmo lead por um
  // número diferente a cada mensagem. phone_number_id é imutável: a escolha não muda mais.
  const ORD = 'ORDER BY verified DESC, phone_number_id ASC LIMIT 1';
  try {
    // 1) MESMO NÚMERO QUE RECEBEU. Responder por outro número quebra a conversa no celular do lead
    // (ele pergunta num chat e a resposta chega em outro) e a janela de 24h daquele chat não vale
    // pro outro número. Só assume se o número for oficial E registrado; senão cai pro vendedor.
    let inst = String(opts.instance || '');
    const conv = String(opts.convPhone || '').replace(/\D/g, '');
    if (!_instNum8(inst) && conv) {
      const c = await env.DB.prepare('SELECT instance FROM wa_chats WHERE phone = ?').bind(conv).first();
      inst = (c && c.instance) || '';
      if (!_instNum8(inst)) {
        const ms = await env.DB.prepare('SELECT instance FROM wa_messages WHERE phone = ? ORDER BY ts DESC LIMIT 30').bind(conv).all();
        for (const r of ((ms && ms.results) || [])) { if (_instNum8(r.instance)) { inst = String(r.instance); break; } }
      }
    }
    const n8 = _instNum8(inst);
    if (n8) {
      const row = await env.DB.prepare(`SELECT ${cols} FROM wa_api_numbers WHERE display_phone LIKE ? ${ORD}`).bind('%' + n8).first();
      if (row && row.verified) return row;
    }
    // 2) número do vendedor (conversa nova, sem histórico ainda).
    // Antes do desempate automático vem a ESCOLHA DELE (data.wa_ativo, o seletor do inbox): quem tem
    // dois números em uso decide de qual fala, e essa decisão não pode ser sobrescrita por um
    // 'ORDER BY' qualquer.
    if (opts.atId != null && String(opts.atId) !== '') {
      try {
        const st = await _getDashData(env, 30000);
        const escolhido = st && st.wa_ativo && st.wa_ativo[String(opts.atId)];
        if (escolhido) {
          const row = await env.DB.prepare(`SELECT ${cols} FROM wa_api_numbers WHERE at_id = ? AND display_phone LIKE ? ${ORD}`).bind(String(opts.atId), '%' + String(escolhido)).first();
          if (row && row.verified) return row;
        }
      } catch (_) {}
      const row = await env.DB.prepare(`SELECT ${cols} FROM wa_api_numbers WHERE at_id = ? ${ORD}`).bind(String(opts.atId)).first();
      if (row) return row;
    }
    // 3) telefone explícito
    const num = String(opts.phone || '').replace(/\D/g, '');
    if (num) {
      let row = await env.DB.prepare(`SELECT ${cols} FROM wa_api_numbers WHERE display_phone = ?`).bind(num).first();
      if (!row) { const key = _waNumKey(num); if (key) row = await env.DB.prepare(`SELECT ${cols} FROM wa_api_numbers WHERE num_key = ? ${ORD}`).bind(key).first(); }
      if (row) return row;
    }
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
        const inst = _instComNumero(atId, selfNumber, ownInst);   // sem o numero, a resposta sai pelo outro chip (131047)
        // Espelha no histórico (wa_messages/wa_chats). É daqui que saem o RITMO da roleta e o TETO
        // de rajada anti-ban; sem isso o balanceador ficava cego (nenhuma linha) e não conseguia
        // respeitar o limite por número. Também alimenta a caixa de entrada do CRM.
        try {
          // Mídia recebida: o injetor manda os bytes (mediaB64); persiste no R2 e preenche media_url
          // pra a bolha virar imagem/áudio/vídeo/doc de verdade (não mais base64 no corpo).
          let mediaUrl = '';
          if (e?.mediaB64) { try { mediaUrl = await _scStoreMedia(env, e.mediaB64, e.mediaMime); } catch (_) {} }
          await _waLogMsg(env, {
            phone, instance: inst, direction: e?.fromMe ? 'out' : 'in',
            type: String(e?.type || 'text'), body: String(e?.body || ''),
            pushName: String(e?.pushName || ''), ts: Number(e?.ts) || now, msgId: msgId || null,
            media_url: mediaUrl || null
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
// ═══════════════════════════════════════════════════════════════════════════════════════════
// WhatsApp Cloud API (OFICIAL) — webhook de captura.
//  GET  = a Meta manda hub.challenge pra verificar o webhook (respondemos o challenge).
//  POST = mensagens RECEBIDAS (o lead manda primeiro). Reusa TODA a atribuição do Sale Chat:
//         resolveOwner(número oficial) → _waLeadCapture (casa o clique da pressel → lead + pixel) → wa_attrib.
//  IMPORTANTE: a Cloud API NÃO devolve a mensagem que o VENDEDOR envia, então a venda ("Pedido
//  Concluído", que é uma mensagem de saída) NÃO chega por aqui. A detecção de venda pela via oficial
//  depende do ENVIO passar pelo AXION (fase seguinte, quando os nomes forem aprovados e ligarmos a
//  caixa de saída). Por enquanto: captura de lead + atribuição + pixel de lead. É o grosso do valor.
//  Pra atribuir ao vendedor, o número oficial precisa estar na Contingência atribuído a alguém.
// ═══════════════════════════════════════════════════════════════════════════════════════════
async function _waCloudVerifyToken(env) {
  let t = await _readConfig(env, 'wa_api_verify_token');
  if (!t) { t = 'ax_wh_' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12); await _writeConfig(env, 'wa_api_verify_token', t); }
  return t;
}

// ═══ Conexão API oficial (Coexistência) — Embedded Signup ═══
// O front lança o popup oficial da Meta (Facebook Login for Business). Pra isso precisa do
// app_id + de um config_id (a "configuração de Login" criada no painel do app da Meta).
// Enquanto o config_id não existir, o botão fica travado (ready=false) e a UI explica o que falta.
async function handleWaEsConfig(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // app_id e verify_token sao da NOSSA conta Meta: nao ha "a conta dele" aqui.
  if (noMundoAfiliado(u) || afiliadoSemVinculo(u)) return err('Sem permissão', 403);
  const app_id = await _readConfig(env, 'wa_api_app_id');
  const config_id = await _readConfig(env, 'wa_es_config_id');
  const verify = await _readConfig(env, 'wa_api_verify_token');
  let last = null; try { last = JSON.parse((await _readConfig(env, 'wa_es_last_onboard')) || 'null'); } catch (_) {}
  return json({
    ok: true,
    app_id: app_id || '',
    config_id: config_id || '',
    ready: !!(app_id && config_id),
    verify_token_set: !!verify,
    webhook_url: 'https://axion-api.axion-dash.workers.dev/api/wa/cloud',
    last
  });
}

// POST /api/wa/es/finish — recebe o que o popup do Embedded Signup devolveu (code + waba_id +
// phone_number_id) e finaliza a ligação: assina nosso app na WABA (webhook), e dispara o sync
// inicial da coexistência (contatos + histórico), que a Meta exige rodar dentro de 24h do pareamento.
// Cada passo é isolado e volta com status próprio pra a gente ver, no dia da conexão, o que passou.
// Guarda o payload cru primeiro pra nunca perder o code (janela de 24h).
async function handleWaEsFinish(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  let b; try { b = await req.json(); } catch (_) { b = {}; }
  const waba_id = String(b?.waba_id || '').trim();
  const phone_number_id = String(b?.phone_number_id || '').trim();
  const code = String(b?.code || '').trim();
  const phone = String(b?.phone || '').replace(/\D/g, '');
  await _writeConfig(env, 'wa_es_last_onboard', JSON.stringify({ waba_id, phone_number_id, code, phone, at: Math.floor(Date.now() / 1000) }));
  const token = await _readConfig(env, 'wa_api_token');
  const V = 'https://graph.facebook.com/v21.0';
  const steps = {};
  async function step(name, url, opts) {
    try {
      const r = await fetch(url, opts);
      const j = await r.json().catch(() => ({}));
      steps[name] = { ok: r.ok && !j.error, status: r.status, resp: j };
    } catch (e) { steps[name] = { ok: false, error: String(e) }; }
  }
  const H = token ? { authorization: 'Bearer ' + token } : {};
  const HJ = token ? { authorization: 'Bearer ' + token, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
  if (token && waba_id) {
    // confere se o app já está assinado (o ES normalmente já assina); assina se não estiver
    await step('subscribed_apps_get', `${V}/${encodeURIComponent(waba_id)}/subscribed_apps`, { headers: H });
    await step('subscribed_apps', `${V}/${encodeURIComponent(waba_id)}/subscribed_apps`, { method: 'POST', headers: H });
  }
  if (token && phone_number_id) {
    // sync inicial da coexistência (precisa rodar em até 24h após o pareamento, senão a Meta desfaz)
    await step('sync_contacts', `${V}/${encodeURIComponent(phone_number_id)}/smb_app_data`, { method: 'POST', headers: HJ, body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' }) });
    await step('sync_history', `${V}/${encodeURIComponent(phone_number_id)}/smb_app_data`, { method: 'POST', headers: HJ, body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: 'history' }) });
    // status final do número (o alvo é platform_type=CLOUD_API)
    await step('status', `${V}/${encodeURIComponent(phone_number_id)}?fields=display_phone_number,platform_type,name_status,code_verification_status,quality_rating`, { headers: H });
  }
  // Grava no mapa de número oficial (transporte). Se veio pela coexistência, marca verificado.
  if (phone_number_id) {
    const st = steps.status && steps.status.resp || {};
    try { await _waApiUpsert(env, { phone_number_id, display_phone: (st.display_phone_number || phone).replace(/\D/g, ''), waba_id, quality: st.quality_rating, name_status: st.name_status, verified: 1 }); } catch (_) {}
  }
  return json({ ok: true, waba_id, phone_number_id, token_present: !!token, steps });
}

// GET /api/wa/official/numbers  → lista os números oficiais mapeados (com dono, qualidade, status)
// POST /api/wa/official/numbers → registra/atualiza um número { phone_number_id, display_phone?, waba_id?, at_id? }
//   e busca quality_rating/name_status na Graph. Também faz backfill do último onboarding (wa_es_last_onboard).
async function handleWaOfficialNumbers(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // A WABA E DA CASA. Eu tinha trocado o gate do /api/wa/register pra _podeMexerMeta e esqueci
  // deste, que LISTA: a varredura de 25/08 mostrou 7 numeros nossos, com display_phone e o id do
  // nosso vendedor, indo pro afiliado. Devolvo lista VAZIA em vez de 403 porque o modal da tela de
  // pressels cai no catch com 403 e trava em erro; com lista vazia o fluxo segue e ele le a
  // mensagem certa.
  if (noMundoAfiliado(u) || afiliadoSemVinculo(u)) return json({ ok: true, numbers: [] });
  if (!_podeMexerPressel(u)) return err('Sem permissão', 403);
  await _scEnsureTables(env);
  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch (_) { b = {}; }
    // backfill: se não passar phone_number_id, tenta puxar do último onboarding salvo
    let pnid = String(b.phone_number_id || '').trim();
    let waba = String(b.waba_id || '').trim();
    let disp = String(b.display_phone || '').replace(/\D/g, '');
    if (!pnid) {
      try { const last = JSON.parse((await _readConfig(env, 'wa_es_last_onboard')) || 'null'); if (last) { pnid = pnid || last.phone_number_id; waba = waba || last.waba_id; disp = disp || String(last.phone || '').replace(/\D/g, ''); } } catch (_) {}
    }
    if (!pnid) return err('phone_number_id obrigatório (ou salve um onboarding antes)');
    // busca metadados na Graph (display real, qualidade, status do nome)
    let quality = null, name_status = null;
    try {
      const g = await _graph(env, `/${encodeURIComponent(pnid)}?fields=display_phone_number,quality_rating,name_status,platform_type`);
      if (g.ok && g.data) { disp = disp || String(g.data.display_phone_number || '').replace(/\D/g, ''); quality = g.data.quality_rating || null; name_status = g.data.name_status || null; }
    } catch (_) {}
    await _waApiUpsert(env, { phone_number_id: pnid, display_phone: disp, waba_id: waba, at_id: b.at_id, quality, name_status, verified: b.verified ? 1 : 0 });
    // religa o dono a partir dos chips marcados api (por num_key)
    try { await _scSeedOwners(env); } catch (_) {}
    const row = await env.DB.prepare('SELECT * FROM wa_api_numbers WHERE phone_number_id=?').bind(pnid).first();
    return json({ ok: true, number: row || null });
  }
  const rows = await env.DB.prepare('SELECT * FROM wa_api_numbers ORDER BY updated_at DESC').all();
  // O TOKEN DA META NAO SAI DAQUI. O SELECT * trazia a coluna `token` junto, e esta rota e liberada
  // pra quem mexe na pressel - o gestor de trafego inclusive, que e gente de fora. Com esse token da
  // pra mandar mensagem como a empresa, ler conversa e apagar template. Nenhuma tela usa o campo: a
  // dash so mostra numero, dono, qualidade e status.
  const numbers = (rows.results || []).map((r) => { const { token, ...resto } = r; return { ...resto, tem_token: token ? 1 : 0 }; });
  return json({ ok: true, numbers });
}

// POST /api/wa/register (diretor) — registro OTP de um número na Cloud API (self-serve com o token).
// body.step: 'list' (lista números da WABA) | 'request_code' | 'verify_code' | 'register'
async function handleWARegister(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // _podeMexerMeta e nao _podeMexerPressel: registrar numero usa o NOSSO token da Graph na NOSSA
  // WABA, e ja queimou dois chips em coexistencia. O afiliado nao tem "conta Meta dele" aqui.
  if (!_podeMexerMeta(u)) return err('Sem permissão', 403);
  await _scEnsureTables(env);
  let b; try { b = await req.json(); } catch (_) { b = {}; }
  const step = String(b.step || '').trim();
  const pnid = String(b.phone_number_id || '').trim();
  if (step === 'list') {
    let waba = String(b.waba_id || '').trim();
    if (!waba) { try { const l = JSON.parse((await _readConfig(env, 'wa_es_last_onboard')) || 'null'); if (l) waba = l.waba_id || ''; } catch (_) {} }
    // Sem Embedded Signup nunca existiu `wa_es_last_onboard`, e a tela morria em "waba_id
    // obrigatório" — mas a WABA de cada número JÁ ESTÁ gravada (veio do Datacrazy, na coexistência).
    // Usa a do número que está sendo conectado; se não vier número, a mais recente conhecida.
    if (!waba) {
      try {
        const nk = String(b.num || b.display_phone || '').replace(/\D/g, '').slice(-8);
        const row = nk
          ? await env.DB.prepare('SELECT waba_id FROM wa_api_numbers WHERE num_key LIKE ? AND waba_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1').bind('%' + nk).first()
          : await env.DB.prepare('SELECT waba_id FROM wa_api_numbers WHERE waba_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1').first();
        if (row && row.waba_id) waba = String(row.waba_id);
      } catch (_) {}
    }
    if (!waba) return err('Nenhuma conta oficial (WABA) conhecida ainda. Conecte um número pelo Datacrazy ou faça o cadastro na Meta primeiro.');
    const g = await _graph(env, `/${encodeURIComponent(waba)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,name_status,platform_type,code_verification_status`);
    if (!g.ok) return json({ ok: false, error: (g.data && g.data.error && g.data.error.message) || ('graph ' + g.status) }, 400);
    for (const n of ((g.data && g.data.data) || [])) {
      const isReg = (n.platform_type === 'CLOUD_API') || (n.code_verification_status === 'VERIFIED');
      try { await _waApiUpsert(env, { phone_number_id: n.id, display_phone: n.display_phone_number, waba_id: waba, quality: n.quality_rating, name_status: n.name_status, verified: isReg ? 1 : 0 }); } catch (_) {}
    }
    try { await _scSeedOwners(env); } catch (_) {}
    return json({ ok: true, numbers: (g.data && g.data.data) || [] });
  }
  if (!pnid) return err('phone_number_id obrigatório');
  if (step === 'request_code') {
    const g = await _graph(env, `/${encodeURIComponent(pnid)}/request_code`, { method: 'POST', body: JSON.stringify({ code_method: String(b.method || 'SMS'), language: String(b.language || 'pt_BR') }) });
    return json({ ok: g.ok, resp: g.data, status: g.status });
  }
  if (step === 'verify_code') {
    const g = await _graph(env, `/${encodeURIComponent(pnid)}/verify_code`, { method: 'POST', body: JSON.stringify({ code: String(b.code || '') }) });
    return json({ ok: g.ok, resp: g.data, status: g.status });
  }
  if (step === 'register') {
    const pin = String(b.pin || '').trim();
    if (!/^\d{6}$/.test(pin)) return err('pin de 6 dígitos obrigatório');
    const g = await _graph(env, `/${encodeURIComponent(pnid)}/register`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', pin }) });
    if (g.ok) { try { await _waApiUpsert(env, { phone_number_id: pnid, verified: 1 }); await _scSeedOwners(env); } catch (_) {} }
    return json({ ok: g.ok, resp: g.data, status: g.status });
  }
  return err('step inválido');
}

// Lista as WABAs conhecidas, cada uma com o TOKEN que enxerga ela e o número dono.
// Na coexistência pelo Datacrazy cada número tem WABA PRÓPRIA e token PRÓPRIO (medido: 4 números =
// 4 WABAs diferentes) e o wa_api_token do AXION não enxerga nenhuma delas — era por isso que a aba
// Templates ficava em erro. Ordem ESTÁVEL por phone_number_id (imutável): com `updated_at` o cron
// reescrevia a tabela a cada 2min e a WABA escolhida trocava sozinha entre uma leitura e a seguinte.
// `atId` restringe às WABAs dos números DAQUELE atendente: o vendedor precisa dos templates que ele
// pode disparar, não do catálogo da casa inteira.
// `num` (8 dígitos) restringe à conta DAQUELE número: template vive dentro de uma conta, e oferecer
// template de outra só produz o erro #132001 da Meta na cara do vendedor.
async function _waWabaList(env, hint, atId, num) {
  const w = String(hint || '').trim();
  let rows = [];
  try {
    const so = atId != null && String(atId) !== '';
    const n8 = String(num || '').replace(/\D/g, '').slice(-8);
    const cond = ["waba_id IS NOT NULL AND waba_id<>''"];
    const binds = [];
    if (so) { cond.push('at_id = ?'); binds.push(String(atId)); }
    if (n8) { cond.push('display_phone LIKE ?'); binds.push('%' + n8); }
    const sql = 'SELECT waba_id, token, display_phone FROM wa_api_numbers WHERE ' + cond.join(' AND ') + " ORDER BY verified DESC, CASE WHEN token IS NULL OR token='' THEN 1 ELSE 0 END, phone_number_id ASC";
    const st = env.DB.prepare(sql);
    const r = await (binds.length ? st.bind(...binds) : st).all();
    rows = (r && r.results) || [];
  } catch (_) {}
  const vistas = new Set();
  const out = [];
  for (const x of rows) {
    const id = String(x.waba_id);
    if (vistas.has(id)) continue;   // 1 entrada por WABA (a de melhor token, pela ordem acima)
    vistas.add(id);
    out.push({ waba: id, token: x.token || null, display_phone: x.display_phone || null });
  }
  if (w) { const achou = out.find(x => x.waba === w); return [achou || { waba: w, token: null, display_phone: null }]; }
  try {
    const l = JSON.parse((await _readConfig(env, 'wa_es_last_onboard')) || 'null');
    if (l && l.waba_id) {
      const i = out.findIndex(x => x.waba === String(l.waba_id));
      if (i > 0) out.unshift(out.splice(i, 1)[0]);
      else if (i < 0) out.unshift({ waba: String(l.waba_id), token: null, display_phone: null });
    }
  } catch (_) {}
  return out;
}
// Uma WABA só, agora estável: a 1ª da lista. Mantido pra quem só precisa do id.
async function _waWabaId(env, hint) { const l = await _waWabaList(env, hint); return l.length ? l[0].waba : ''; }
// GET /api/wa/template  → lista templates (name, status, category, language, components)
// POST /api/wa/template → cria e SUBMETE um template { name, language?, category?, header?, body, footer?, buttons? }
async function handleWATemplate(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // LISTAR e de quem ATENDE. Era 403 pra todo mundo fora do diretor, e por isso a aba Templates do
  // vendedor aparecia vazia com "nenhum template ainda" mesmo havendo 26 aprovados na Meta - ele
  // ficava sem a unica forma de reabrir conversa fora das 24h. CRIAR e submeter continua do diretor:
  // template mal escrito e reprovacao que respinga na qualidade do numero.
  if (req.method !== 'GET' && !isDirector(u)) return err('Só o diretor', 403);
  if (req.method === 'GET') {
    const url = new URL(req.url);
    // Varre TODAS as WABAs, cada uma com o SEU token. Antes pegava só "a mais recente" e chamava a
    // Graph com o wa_api_token, que não tem permissão na WABA do Datacrazy: a tela ficava em erro.
    // Diretor ve todas; atendente ve so as contas dos numeros dele.
    // `num` = número da conversa aberta. Com ele, a lista traz SÓ o que aquele número dispara.
    const alvos = await _waWabaList(env, url.searchParams.get('waba_id'), isDirector(u) ? null : u.id, url.searchParams.get('num'));
    if (!alvos.length) return json({ ok: true, templates: [], note: 'sem_waba' });
    const porChave = new Map(); const erros = [];
    for (const a of alvos) {
      const g = await _graph(env, `/${encodeURIComponent(a.waba)}/message_templates?fields=name,status,category,language,components,quality_score&limit=200`, { token: a.token || undefined });
      if (!g.ok) { erros.push({ waba_id: a.waba, numero: a.display_phone, erro: (g.data && g.data.error && g.data.error.message) || ('graph ' + g.status) }); continue; }
      for (const t of ((g.data && g.data.data) || [])) {
        // dedup por nome+idioma: o front usa essa chave como key do React, duplicata quebrava a lista
        const k = String(t.name || '') + '|' + String(t.language || '');
        const ant = porChave.get(k);
        if (!ant || (String(t.status || '').toUpperCase() === 'APPROVED' && String(ant.status || '').toUpperCase() !== 'APPROVED')) {
          porChave.set(k, { ...t, waba_id: a.waba, display_phone: a.display_phone || null });
        }
      }
    }
    const lista = Array.from(porChave.values());
    if (!lista.length && erros.length) return json({ ok: false, error: erros[0].erro, erros }, 400);
    return json({ ok: true, waba_id: alvos[0].waba, templates: lista, erros: erros.length ? erros : undefined });
  }
  let b; try { b = await req.json(); } catch (_) { b = {}; }
  // Submeter template precisa do token DA WABA (o wa_api_token do AXION não enxerga a do Datacrazy).
  const _wc = (await _waWabaList(env, b.waba_id))[0] || null;
  const waba = _wc ? _wc.waba : '';
  const wabaTok = _wc ? _wc.token : null;
  if (!waba) return err('waba_id obrigatório');
  const name = String(b.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
  if (!name) return err('nome obrigatório (só letras/números/underscore)');
  if (!b.body) return err('corpo (body) obrigatório');
  const language = String(b.language || 'pt_BR');
  const category = String(b.category || 'MARKETING').toUpperCase();
  const components = [];
  if (b.header) components.push({ type: 'HEADER', format: 'TEXT', text: String(b.header).slice(0, 60) });
  components.push({ type: 'BODY', text: String(b.body).slice(0, 1024) });
  if (b.footer) components.push({ type: 'FOOTER', text: String(b.footer).slice(0, 60) });
  if (Array.isArray(b.buttons) && b.buttons.length) components.push({ type: 'BUTTONS', buttons: b.buttons.slice(0, 3).map(t => ({ type: 'QUICK_REPLY', text: String(t).slice(0, 25) })) });
  const g = await _graph(env, `/${encodeURIComponent(waba)}/message_templates`, { method: 'POST', token: wabaTok || undefined, body: JSON.stringify({ name, language, category, components }) });
  if (!g.ok) return json({ ok: false, error: (g.data && g.data.error && g.data.error.message) || ('graph ' + g.status), resp: g.data }, 400);
  return json({ ok: true, id: g.data && g.data.id, status: g.data && g.data.status, name });
}

// ─── Funil automático dentro do inbox (envia os itens um a um; para quando o lead responde) ───
// SEM USO desde 18/08/2026: o intervalo entre passos passou a ser o que o Bruno configura em cada
// item ("espera", no Sale Chat). Este 90 fixo era aplicado em TODO funil e apagava a configuracao
// dele. Fica aqui so como piso de referencia; se voltar a aparecer no codigo, e regressao.
const WA_FUNNEL_GAP = 90;
function _r2PublicUrl(key) { return 'https://axion-api.axion-dash.workers.dev/api/salechat/media/' + String(key || '').split('/').map(encodeURIComponent).join('/'); }
async function _waFunnelSeq(env, seqId) {
  const data = await _getDashData(env);
  const sc = (data && (data.salechatPub || data.salechat)) || {};
  const seqs = Array.isArray(sc.sequences) ? sc.sequences : [];
  const seq = seqs.find(s => s && s.id === seqId);
  if (!seq) return null;
  // GUARDA O PASSO INTEIRO, nao so o id. Antes era .map(it => it.id) e a ESPERA que o Bruno
  // configurou (21s, 70s, 20s...) era jogada fora: todo funil andava num intervalo fixo de 90s.
  // Ele acertava o ritmo na tela e o cliente recebia outro. Os ids soltos (formato antigo) viram
  // passo com espera 0, que e como se comportavam.
  const passos = (Array.isArray(seq.items) ? seq.items : [])
    .map(it => (typeof it === 'string' ? { id: it, delay: 0, sim: 0 } : { id: (it && it.id) || '', delay: Math.max(0, Number(it && it.delay) || 0), sim: Math.max(0, Number(it && it.sim) || 0) }))
    .filter(p => p.id);
  return { seq, items: passos, media: Array.isArray(sc.media) ? sc.media : [], msgs: Array.isArray(sc.messages) ? sc.messages : [], pararResp: seq.stopOnReply === true };
}
// ── A PAUSA DO FUNIL ─────────────────────────────────────────────────────────
//
// A tela tinha DOIS campos por passo, "espera" e "simula", e eles SOMAVAM: o Bruno reclamou em
// 18/08/2026 que ficava 10s parado e depois mais 10s "digitando" antes de sair a mensagem. Ele quer
// UMA pausa so, e que ela aconteca colada no envio (manda, pausa, manda), nao como tempo morto
// depois da mensagem anterior.
//
// Agora e uma pausa efetiva por passo: vale `sim` se estiver preenchido, senao `delay`. Nunca soma.
const _pausaDoPasso = (p) => {
  const sim = Math.max(0, Number(p && p.sim) || 0);
  const del = Math.max(0, Number(p && p.delay) || 0);
  return sim > 0 ? sim : del;
};
const _dorme = (seg) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(seg, 120)) * 1000));

// "DIGITANDO..." DE VERDADE, quando der. A Cloud API tem o indicador (conferido: o endpoint aceita
// typing_indicator e so reclama do id), mas ele exige o wamid de uma mensagem RECEBIDA - a Meta nao
// tem um "comecar a digitar" solto. Hoje quem recebe o webhook dos 4 numeros e o app do Datacrazy, e
// as mensagens chegam pra nos pelo poll deles, com id proprio ('dc:...'): nunca tivemos um wamid de
// entrada (conferido, zero). Entao a funcao existe, tenta, e se nao houver wamid ela simplesmente
// nao faz nada - a pausa acontece do mesmo jeito. No dia em que o webhook for nosso, o "digitando"
// liga sozinho, sem mexer aqui.
async function _waDigitando(env, atId, phone, apiNumFixo) {
  try {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return false;
    const m = await env.DB.prepare("SELECT msg_id FROM wa_messages WHERE phone=? AND direction='in' AND msg_id LIKE 'wamid%' ORDER BY ts DESC LIMIT 1").bind(digits).first();
    const wamid = m && m.msg_id;
    if (!wamid) return false;
    const apiNum = apiNumFixo || await resolveApiNumber(env, { atId, convPhone: digits });
    if (!apiNum || !apiNum.phone_number_id) return false;
    const r = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(apiNum.phone_number_id) + '/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + (apiNum.token || await _readConfig(env, 'wa_api_token')), 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: String(wamid), typing_indicator: { type: 'text' } }),
    });
    return r.ok;
  } catch (_) { return false; }
}

// O FUNIL PELA EVOLUTION (numero conectado por QR, nao oficial). Existe porque o funil inteiro
// falava so Cloud API: numero de Evolution NAO esta em wa_api_numbers, entao o disparo ou morria
// com "vendedor sem numero oficial" ou - pior - saia pelo OUTRO numero do mesmo vendedor, o
// oficial. Com o Bruno trocando um numero restrito por um de Evolution no meio da campanha
// (21/08/2026), isso seria o funil do vendedor saindo pelo chip errado sem ninguem ver.
async function _waFunnelEvo(env, inst, phone, passo, info) {
  const itemId = (passo && typeof passo === 'object') ? passo.id : passo;
  const num = String(phone || '').replace(/\D/g, '');
  const falha = (r, oq) => ({ ok: false, error: 'Evolution nao enviou o ' + oq + ' (' + String((r && (r._err || r.status)) || 'sem resposta') + ')', code: 'evo' });
  const md = (info.media || []).find(m => m && m.id === itemId);
  if (md && md.key) {
    const kind = ['image', 'audio', 'video', 'document'].includes(md.kind) ? md.kind : 'document';
    if (kind === 'audio') {
      // AUDIO TEM QUE SAIR COMO NOTA DE VOZ (ondinhas). Pelo sendMedia ele viraria ARQUIVO de audio,
      // que o cliente quase nao abre - e o funil do Bruno e feito de audio. Por isso le do R2 e manda
      // no endpoint de PTT, que e o unico que grava como voz.
      let b64 = '';
      try { const o = await env.MEDIA.get(md.key); if (o) b64 = _bytesToB64(new Uint8Array(await o.arrayBuffer())); } catch (_) {}
      if (!b64) return { ok: false, error: 'audio do passo nao esta no arquivo', code: 'sem_midia' };
      const r = await _waSendAudio(env, inst, num, b64);
      if (!r || r.ok === false || r._noconfig) return falha(r, 'audio');
      try { await _waLogMsg(env, { phone: num, instance: inst, direction: 'out', type: 'audio', body: '', msgId: r.data && r.data.key && r.data.key.id, media_url: _r2PublicUrl(md.key) }); } catch (_) {}
      return { ok: true, id: (r.data && r.data.key && r.data.key.id) || null };
    }
    const r = await _waSendMedia(env, inst, num, {
      mediatype: kind, media: _r2PublicUrl(md.key),
      ...(md.mime ? { mimetype: md.mime } : {}),
      ...(md.label ? { fileName: md.label } : {}),
      ...(md.caption ? { caption: md.caption } : {}),
    });
    if (!r || r.ok === false || r._noconfig) return falha(r, kind);
    try { await _waLogMsg(env, { phone: num, instance: inst, direction: 'out', type: kind, body: md.caption || '', msgId: r.data && r.data.key && r.data.key.id, media_url: _r2PublicUrl(md.key) }); } catch (_) {}
    return { ok: true, id: (r.data && r.data.key && r.data.key.id) || null };
  }
  const tx = (info.msgs || []).find(m => m && m.id === itemId);
  const texto = tx && (tx.text || tx.body);
  if (texto) {
    const r = await evoFetch(env, '/message/sendText/' + encodeURIComponent(inst), { method: 'POST', body: { number: num, text: String(texto) } });
    if (!r || r.ok === false || r._noconfig) return falha(r, 'texto');
    try { await _waLogMsg(env, { phone: num, instance: inst, direction: 'out', type: 'text', body: String(texto), msgId: r.data && r.data.key && r.data.key.id }); } catch (_) {}
    try { await _waDetectSale(env, inst, { message: { conversation: String(texto) }, key: { remoteJid: num + '@c.us', id: (r.data && r.data.key && r.data.key.id) || null, fromMe: true } }); } catch (_) {}
    return { ok: true, id: (r.data && r.data.key && r.data.key.id) || null };
  }
  console.error('WA_FUNIL_PASSO_INEXISTENTE(evo) fone=' + num + ' item=' + JSON.stringify(itemId));
  return { ok: false, error: 'item nao encontrado', code: 'no_item' };
}
// apiNum = numero oficial JA resolvido (o chip pinado no inicio do funil). Sem ele, cada passo
// resolveria de novo pela conversa e poderia trocar de numero no meio.
// inst = a instancia da conversa; se ela estiver VIVA na Evolution, o passo sai por la.
async function _waFunnelSendItem(env, atId, phone, passo, info, apiNum, inst) {
  // Canal pela CONEXAO, nao pelo cadastro: a mesma conta pode ter numero oficial e numero de QR.
  // Vale so quando a instancia esta 'open' e com sinal recente (10 min), igual ao compositor.
  if (inst) {
    let viva = null;
    try {
      viva = await env.DB.prepare("SELECT 1 FROM wa_conn WHERE instance=? AND state='open' AND updated_at > strftime('%s','now')-600").bind(String(inst)).first();
    } catch (_) { viva = null; }
    if (viva) return await _waFunnelEvo(env, String(inst), phone, passo, info);
    // NAO VAZAR PRO OUTRO CHIP. Se a conversa tem numero proprio no carimbo, esse numero nao e um
    // oficial nosso (apiNum vazio) e a Evolution dele nao esta viva, entao NAO existe canal pra
    // esta conversa. Sem esta parada o passo cairia no resolveApiNumber e sairia pelo OUTRO numero
    // do mesmo vendedor - o cliente recebendo funil de um contato com quem nunca falou.
    const _temNum = /^ax_.+_\d{8}$/.test(String(inst)) || /^dc_\d{8,}$/.test(String(inst));
    if (_temNum && !apiNum) {
      return { ok: false, error: 'O número desta conversa não está conectado agora (WhatsApp caiu ou saiu do ar). O funil parou aqui.', code: 'canal_fora' };
    }
  }
  const itemId = (passo && typeof passo === 'object') ? passo.id : passo;
  const md = (info.media || []).find(m => m && m.id === itemId);
  if (md && md.key) {
    const kind = ['image', 'audio', 'video', 'document'].includes(md.kind) ? md.kind : 'document';
    return await _waCloudSendMedia(env, atId, phone, { kind, link: _r2PublicUrl(md.key), caption: md.caption || '', filename: md.label || '', mediaKey: md.key, apiNum: apiNum || null });
  }
  const tx = (info.msgs || []).find(m => m && m.id === itemId);
  if (tx && (tx.text || tx.body)) return await _waCloudSendText(env, atId, phone, tx.text || tx.body, apiNum || null);
  // PASSO QUE NAO EXISTE NAO PODE PASSAR EM SILENCIO. Ele acontece quando o funil guarda um id que
  // nao casa com nenhuma midia nem mensagem: ou a midia foi apagada nas abas do Sale Chat, ou o item
  // entrou sem id (bug do seletor, corrigido em 18/08/2026 - o React lia e.target.value depois de o
  // campo ja ter sido zerado). O tick trata 'no_item' como passo comum e SEGUE pro proximo, que e o
  // comportamento certo em tempo de execucao (melhor pular um passo do que travar o funil inteiro do
  // cliente), so que ninguem ficava sabendo: o funil dizia que rodou e o cliente nunca recebeu aquele
  // audio. Agora fica no log do Worker com o funil e o item, pra dar pra achar qual passo consertar.
  console.error('WA_FUNIL_PASSO_INEXISTENTE at=' + String(atId) + ' fone=' + String(phone) + ' item=' + JSON.stringify(itemId));
  return { ok: false, error: 'item não encontrado', code: 'no_item' };
}
async function _waFunnelStop(env, phone, why) {
  // RESPEITA A CAIXINHA "parar se o lead responder" (parar_resp). O _waFunnelTick ja conferia isso
  // com cuidado, mas nunca chegava a rodar: os 3 caminhos de entrada de mensagem chamavam esta
  // funcao com 'lead_respondeu' e ela parava TODO run 'running', marcada ou desmarcada. Resultado:
  // as 9 sequencias estavam com a caixinha DESMARCADA e mesmo assim o funil morria na 1a resposta
  // do lead - justo quem demonstrou interesse parava de receber. Parada manual ('stopped') e as
  // outras razoes seguem incondicionais; so o gatilho da resposta passa a olhar parar_resp.
  const fone = String(phone || '').replace(/\D/g, '');
  const cond = (why === 'lead_respondeu') ? " AND COALESCE(parar_resp,0)=1" : "";
  try { await env.DB.prepare("UPDATE wa_funnel_run SET status=?, updated_at=strftime('%s','now') WHERE phone=? AND status='running'" + cond).bind(why || 'stopped', fone).run(); } catch (_) {}
}
async function _waFunnelTick(env) {
  try {
    await _scEnsureTables(env);
    const now = Math.floor(Date.now() / 1000);
    // LIMIT 5, nao 20: cada linha pode dormir a pausa dela dentro desta invocacao, entao pegar 20 de
    // uma vez faria a batida arrastar e a seguinte pegar as mesmas linhas.
    // `inst_agora` = o numero em que a conversa esta AGORA (wa_chats segue o ultimo inbound). Vem
    // junto pra dar pra ver, sem consulta extra, se o lead voltou por outro numero no meio do funil.
    const due = await env.DB.prepare("SELECT f.phone, f.at_id, f.seq_id, f.items, f.idx, COALESCE(f.tentativas,0) tentativas, COALESCE(f.parar_resp,0) parar_resp, f.iniciado_em, f.next_at, f.inst, c.instance inst_agora FROM wa_funnel_run f LEFT JOIN wa_chats c ON c.phone = f.phone WHERE f.status='running' AND f.next_at <= ? ORDER BY f.next_at ASC LIMIT 5").bind(now).all();
    const seqCache = {};
    const chipCache = {};   // instancia -> numero oficial (resolve 1x, vale pra todos os passos dela)
    for (const r of (due.results || [])) {
      // ── RESERVA A LINHA ANTES DE TRABALHAR ────────────────────────────────
      // O cron bate de minuto em minuto e um passo pode DORMIR mais que isso (a pausa que o Bruno
      // configura, ate 70s, mais o encadeamento). Enquanto dormia, a linha continuava 'running' com
      // next_at ja vencido: a batida seguinte pegava a MESMA linha e mandava o MESMO audio de novo.
      // Cliente recebendo a mesma mensagem duas vezes e o tipo de coisa que queima numero.
      // A reserva e um UPDATE condicionado ao estado exato que eu li; se outra invocacao chegou
      // antes, changes=0 e esta aqui desiste em silencio. O prazo cobre pausa + os 100s do
      // encadeamento, e o passo 'manutencao' destrava quem ficar presa (ver _cronPurga).
      const reserva = await env.DB.prepare(
        "UPDATE wa_funnel_run SET status='enviando', updated_at=? WHERE phone=? AND idx=? AND status='running' AND next_at=?"
      ).bind(now, r.phone, Number(r.idx) || 0, Number(r.next_at) || 0).run().catch(() => null);
      if (!reserva || !reserva.meta || !reserva.meta.changes) continue;
      const items = (() => { try { return JSON.parse(r.items || '[]'); } catch (_) { return []; } })();
      const idx = Number(r.idx) || 0;
      if (idx >= items.length) { await env.DB.prepare("UPDATE wa_funnel_run SET status='done', updated_at=? WHERE phone=?").bind(now, r.phone).run(); continue; }
      if (!(r.seq_id in seqCache)) seqCache[r.seq_id] = await _waFunnelSeq(env, r.seq_id);
      const info = seqCache[r.seq_id];
      if (!info) { await env.DB.prepare("UPDATE wa_funnel_run SET status='error', updated_at=? WHERE phone=?").bind(now, r.phone).run(); continue; }
      // PARAR SE O LEAD RESPONDER. A caixinha existia na tela e NAO EXISTIA no worker (grep zero):
      // marcar ou desmarcar dava no mesmo, o funil ia ate o fim por cima de quem respondeu. Conferido
      // aqui, e nao la no caminho de quem RECEBE mensagem, de proposito: mexer na entrada de
      // mensagem hoje, com verba rodando, e risco que nao vale. A diferenca pratica e o funil parar
      // no proximo passo em vez de na hora, e os passos sao espacados de qualquer jeito.
      if (Number(r.parar_resp) === 1) {
        const desde = Number(r.iniciado_em) || 0;
        let resp = null;
        try { resp = await env.DB.prepare("SELECT 1 FROM wa_messages WHERE phone=? AND direction='in' AND ts > ? LIMIT 1").bind(String(r.phone), desde).first(); } catch (_) {}
        if (resp) { await env.DB.prepare("UPDATE wa_funnel_run SET status='lead_respondeu', updated_at=? WHERE phone=? AND status='enviando'").bind(now, r.phone).run(); continue; }
      }
      // A PAUSA VEM ANTES DO ENVIO, colada nele. Antes ela virava tempo morto depois da mensagem
      // anterior (next_at) e ainda somava com o segundo campo: dava mensagem, silencio, silencio de
      // novo, mensagem. Agora e: pausa (com "digitando" quando houver wamid) e manda.
      // CHIP DESTE FUNIL: o que foi pinado quando ele comecou. Linha antiga (sem inst) segue como
      // antes, resolvendo pela conversa.
      const _instPin = String(r.inst || '');
      // O LEAD VOLTOU POR OUTRO NUMERO: o funil deste chip PARA aqui. Regra do ultimo clique
      // (Bruno, 20/08/2026): a partir do segundo numero tudo e do vendedor novo, entao continuar
      // mandando por este seria o cliente recebendo a mesma sequencia de dois contatos diferentes.
      // So compara quando os DOIS lados tem numero no carimbo; sem isso ninguem para por engano.
      const _s8 = (x) => (String(x || '').match(/_(\d{8})$/) || [])[1] || '';
      const _pinN = _s8(_instPin), _agoraN = _s8(r.inst_agora);
      if (_pinN && _agoraN && _pinN !== _agoraN) {
        console.log('WA_FUNIL_MIGROU fone=' + String(r.phone) + ' pino=' + _pinN + ' agora=' + _agoraN);
        await env.DB.prepare("UPDATE wa_funnel_run SET status='migrou', updated_at=? WHERE phone=? AND status='enviando'").bind(now, r.phone).run().catch(() => {});
        continue;
      }
      if (_instPin && !(_instPin in chipCache)) chipCache[_instPin] = await _apiNumFromInstance(env, _instPin);
      const apiNumPin = _instPin ? chipCache[_instPin] : null;
      const passo = items[idx];
      const pausa = _pausaDoPasso(passo);
      if (pausa > 0) {
        await _waDigitando(env, r.at_id, r.phone, apiNumPin);
        await _dorme(pausa);
      }
      const send = await _waFunnelSendItem(env, r.at_id, r.phone, passo, info, apiNumPin, _instPin || r.inst_agora);
      const falhou = !!(send && send.ok === false);
      const semItem = falhou && send.code === 'no_item';
      // FALHA DE ENVIO NAO PODE CONTAR COMO ENTREGUE. Antes so tres codigos viravam erro; qualquer
      // outra falha (a Meta recusando o audio, rede caindo) avancava o indice do mesmo jeito e o
      // funil terminava 'done'. O cliente nao recebia nada e a dash dizia que recebeu.
      // Passo que NAO EXISTE continua pulando: melhor perder um passo do que travar o funil inteiro.
      // Falha de envio de verdade PARA e fica marcada, em vez de reenviar: audio repetido no cliente
      // e pior do que um funil parado que o vendedor ve e retoma na mao.
      if (falhou && !semItem) {
        console.error('WA_FUNIL_PASSO_FALHOU fone=' + String(r.phone) + ' seq=' + String(r.seq_id) + ' idx=' + idx + ' code=' + String(send.code || '') + ' erro=' + String(send.error || '').slice(0, 120));
        await env.DB.prepare("UPDATE wa_funnel_run SET status='error', tentativas=COALESCE(tentativas,0)+1, updated_at=? WHERE phone=? AND status='enviando'").bind(now, r.phone).run();
        continue;
      }
      const nidx = idx + 1;
      // O PROXIMO PASSO NAO ESPERA O PROXIMO MINUTO DO CRON. Se ele cabe no tempo que sobra desta
      // invocacao, sai agora, com a pausa dele. Sem isso, um funil de 3 passos com pausa de 3s
      // levava 3 MINUTOS pra sair, porque cada passo esperava a batida seguinte - e o ritmo que o
      // Bruno monta na tela nao existia na pratica. O teto de 100s por invocacao segura o resto: o
      // que passar disso continua na batida seguinte, normalmente.
      // `AND status='enviando'` em toda escrita de avanco: se a manutencao destravou a linha no meio
      // (invocacao presa), esta aqui nao pode rebobinar o idx e repetir a sequencia.
      // A LINHA FICA RESERVADA ENQUANTO ESTA INVOCACAO TRABALHA (19/08/2026, "funil 3 de prova social
      // esta repetindo 2x", reportado pelo vendedor). Aqui a linha voltava pra 'running' com
      // next_at=AGORA e so DEPOIS vinha o encadeamento, que dorme ate ~100s. Ou seja: a linha ficava
      // livre e vencida enquanto a invocacao ainda estava mandando. A batida seguinte do cron
      // reservava a MESMA linha e remandava o MESMO passo. Media no ar: o mesmo audio 4x em 166s
      // pro mesmo lead, ~55s de intervalo, que e exatamente o ritmo do cron.
      // Pior: o UPDATE de avanco de dentro do encadeamento exige status='enviando', e como esta
      // linha ja tinha voltado pra 'running' ele nao casava com nada - o idx NUNCA avancava no
      // banco pelo encadeamento. Cada batida andava 1 passo e repetia a cauda toda de novo.
      // Agora: segue 'enviando' com next_at no futuro ate a invocacao acabar, e o status final
      // ('done' ou 'running') so e escrito no fim, fora do laco. Funil comprido (prova social tem 5
      // passos) e justamente o que mais sofria, porque o encadeamento dele atravessa a batida.
      const GUARDA = 240;   // folga > pausa maxima + os 100s do encadeamento; a manutencao destrava aos 10min
      await env.DB.prepare("UPDATE wa_funnel_run SET idx=?, next_at=?, status='enviando', tentativas=0, updated_at=? WHERE phone=? AND status='enviando'").bind(nidx, Math.floor(Date.now() / 1000) + GUARDA, now, r.phone).run();
      let i2 = nidx, gasto = 0;
      while (i2 < items.length && gasto < 100) {
        if (Number(r.parar_resp) === 1) {
          let resp2 = null;
          try { resp2 = await env.DB.prepare("SELECT 1 FROM wa_messages WHERE phone=? AND direction='in' AND ts > ? LIMIT 1").bind(String(r.phone), Number(r.iniciado_em) || 0).first(); } catch (_) {}
          if (resp2) { await env.DB.prepare("UPDATE wa_funnel_run SET status='lead_respondeu', updated_at=? WHERE phone=?").bind(Math.floor(Date.now() / 1000), r.phone).run(); break; }
        }
        const p2 = items[i2];
        const pa2 = _pausaDoPasso(p2);
        if (gasto + pa2 > 100) break;                 // nao cabe: fica pra proxima batida
        if (pa2 > 0) { await _waDigitando(env, r.at_id, r.phone, apiNumPin); await _dorme(pa2); gasto += pa2; }
        const s2 = await _waFunnelSendItem(env, r.at_id, r.phone, p2, info, apiNumPin, _instPin || r.inst_agora);   // MESMO chip do passo anterior
        const f2 = !!(s2 && s2.ok === false);
        if (f2 && s2.code !== 'no_item') {
          console.error('WA_FUNIL_PASSO_FALHOU fone=' + String(r.phone) + ' seq=' + String(r.seq_id) + ' idx=' + i2 + ' code=' + String(s2.code || ''));
          await env.DB.prepare("UPDATE wa_funnel_run SET status='error', tentativas=COALESCE(tentativas,0)+1, updated_at=? WHERE phone=?").bind(Math.floor(Date.now() / 1000), r.phone).run();
          break;
        }
        i2++;
        await env.DB.prepare("UPDATE wa_funnel_run SET idx=?, next_at=?, status='enviando', updated_at=? WHERE phone=? AND status='enviando'").bind(i2, Math.floor(Date.now() / 1000) + GUARDA, Math.floor(Date.now() / 1000), r.phone).run();
      }
      // LIBERA A LINHA no fim da invocacao. So mexe em quem continua 'enviando': se o laco saiu por
      // resposta do lead ou por falha de envio, o status de la e o que vale e nao pode ser desfeito.
      const fim = Math.floor(Date.now() / 1000);
      await env.DB.prepare("UPDATE wa_funnel_run SET status=?, next_at=?, updated_at=? WHERE phone=? AND status='enviando'")
        .bind(i2 >= items.length ? 'done' : 'running', fim, fim, r.phone).run();
    }
  } catch (_) {}
}
// GET /api/wa/funnel/queue -> TODOS os funis ativos DO VENDEDOR, nao so o da conversa aberta.
// Nasceu porque no inbox a barra "Funil em andamento" vivia dentro da conversa: trocou de lead, a
// barra sumia e o vendedor ficava sem saber se ainda estava enviando, em que passo estava e sem
// como pausar. No Sale Chat antigo (painel injetado) a pilha de envios ficava fixa no canto, com
// uma linha por lead, o passo atual e um Pausar proprio - e era assim que eles queriam.
// Devolve o rotulo do funil e o rotulo do passo atual, que e o que a linha mostra.
// GET /api/leads/contagem?de=<ts>&ate=<ts> -> quantos LEADS DE VERDADE entraram no periodo.
// Nasceu porque o Dashboard de Trafego mostrava "Total de leads" lendo data.leads, que NAO sao leads:
// sao os CARDS DE PEDIDO do Kanban. Em 20/08/2026 a tela dizia 23 leads num dia de 198 - o gestor de
// trafego tomava decisao de verba com um numero que era, na pratica, a contagem de pedidos.
// A fonte certa e wa_lead (1 linha por telefone na PRIMEIRA vez que ele fala com a gente), a mesma
// que a Chegada de Leads usa. `de`/`ate` em segundos; sem eles, conta o dia de hoje.
async function handleLeadsContagem(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const q = new URL(req.url).searchParams;
  const hojeIni = Math.floor(new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).setHours(0, 0, 0, 0) / 1000);
  const de = Number(q.get('de')) || hojeIni;
  // SEM `ate` = ATE AGORA, nao "de + 1 dia" (bug meu, corrigido em 20/08/2026). O filtro do topo da
  // dash usa endTs=0 pra dizer "ate agora" (hoje, esta semana, este mes), entao a tela nao manda o
  // `ate` nesses casos. Com o padrao antigo a janela fechava no dia seguinte ao INICIO do periodo:
  // com o filtro no mes, contava leads de 1 e 2 de agosto e devolvia ZERO - foi o "Leads gerados: 0"
  // que o Bruno viu com 201 leads no dia.
  const ate = Number(q.get('ate')) || (Math.floor(Date.now() / 1000) + 60);
  // O MUNDO DO AFILIADO VEM ANTES (auditoria 24/08/2026). O gate abaixo libera o total da operacao
  // pra qualquer role 'gestor', e o gestor de trafego que o AFILIADO cadastra tem exatamente esse
  // role - ele lia o volume de leads da nossa operacao em tres telas. Aqui o mundo dele resolve
  // primeiro e retorna; quem sobra cai nas regras de sempre.
  if (afiliadoSemVinculo(u)) return json({ total: 0, porVendedor: {} });
  if (noMundoAfiliado(u)) {
    const _idsC = await _idsDoMundoAfiliado(env, aflDe(u));
    const _cut = _sqlInst('inst', _idsC);
    try {
      const r = await env.DB.prepare('SELECT inst, COUNT(*) AS n FROM wa_lead WHERE ts>=? AND ts<? AND ' + _cut.cond + ' GROUP BY inst')
        .bind(de, ate, ..._cut.binds).all();
      const linhas = (r && r.results) || [];
      const porVendedor = {};
      let total = 0;
      for (const x of linhas) { const at = _atFromInst(x.inst); total += Number(x.n) || 0; if (at) porVendedor[at] = (porVendedor[at] || 0) + (Number(x.n) || 0); }
      return json({ total, porVendedor });
    } catch (_) { return json({ total: 0, porVendedor: {} }); }
  }
  // Escopo: cargo full ve a operacao; o resto so o que entrou no PROPRIO numero. O gestor de trafego
  // NAO e full, mas o total de leads e o numero que ele precisa pra decidir verba - e volume de
  // anuncio, nao dado de cliente - entao ele entra na lista de quem ve o total.
  const papel = String(u.role || '').toLowerCase();
  const veTudo = isDirector(u) || papel === 'gestor';
  try {
    if (veTudo) {
      const r = await env.DB.prepare('SELECT COUNT(*) n FROM wa_lead WHERE ts >= ? AND ts < ?').bind(de, ate).first();
      const porV = await env.DB.prepare(
        "SELECT inst, COUNT(*) n FROM wa_lead WHERE ts >= ? AND ts < ? AND inst IS NOT NULL AND inst <> '' GROUP BY inst"
      ).bind(de, ate).all().catch(() => null);
      const vend = {};
      for (const x of ((porV && porV.results) || [])) { const at = _atFromInst(x.inst); if (at) vend[at] = (vend[at] || 0) + (Number(x.n) || 0); }
      return json({ ok: true, total: Number(r && r.n) || 0, porVendedor: vend, de, ate });
    }
    const pf = 'ax_' + u.id;
    const r = await env.DB.prepare(
      "SELECT COUNT(*) n FROM wa_lead WHERE ts >= ? AND ts < ? AND (inst = ? OR substr(inst,1,?) = ?)"
    ).bind(de, ate, pf, pf.length + 1, pf + '_').first();
    return json({ ok: true, total: Number(r && r.n) || 0, porVendedor: {}, de, ate });
  } catch (e) { return err('Não consegui contar os leads: ' + String((e && e.message) || e), 500); }
}
async function handleWAFunnelQueue(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _scEnsureTables(env);
  // Escopo por cargo: vendedor so ve o que e dele. Diretor ve a operacao inteira.
  const dono = isDirector(u) ? null : String(u.id);
  const sql = "SELECT f.phone, f.at_id, f.seq_id, f.idx, f.items, f.status, f.next_at, c.name nome"
    + " FROM wa_funnel_run f LEFT JOIN wa_chats c ON c.phone = f.phone"
    + " WHERE f.status IN ('running','enviando')" + (dono ? " AND f.at_id = ?" : "")
    + " ORDER BY f.status DESC, f.next_at ASC LIMIT 30";
  const st = dono ? env.DB.prepare(sql).bind(dono) : env.DB.prepare(sql);
  const rs = await st.all().catch(() => null);
  const linhas = (rs && rs.results) || [];
  const cache = {};
  const runs = [];
  let naFila = 0;
  for (const r of linhas) {
    if (!(r.seq_id in cache)) cache[r.seq_id] = await _waFunnelSeq(env, r.seq_id).catch(() => null);
    const info = cache[r.seq_id];
    let itens = [];
    try { itens = JSON.parse(r.items || '[]'); } catch (_) {}
    const idx = Number(r.idx) || 0;
    const enviando = r.status === 'enviando';
    // rotulo do passo ATUAL: no 'enviando' e o item de indice idx-1 (o que acabou de sair ou esta
    // saindo); no 'running' e o proximo a sair. Vem do catalogo (midia/mensagem), igual a aba Funis.
    const alvo = itens[enviando ? Math.max(0, idx - 1) : idx];
    let passoLbl = '';
    if (alvo && info) {
      const pid = String((alvo && alvo.id) || alvo || '');
      const md = (info.media || []).find((x) => x && x.id === pid);
      const ms = (info.msgs || []).find((x) => x && x.id === pid);
      passoLbl = String((md && md.label) || (ms && ms.label) || '');
    }
    if (!enviando) naFila++;
    runs.push({
      phone: r.phone,
      nome: r.nome || '',
      at_id: r.at_id,
      seq_id: r.seq_id,
      label: (info && info.seq && info.seq.label) || r.seq_id,
      grp: (info && info.seq && info.seq.grp) || '',
      idx, total: itens.length,
      status: r.status,
      enviando,
      fila: enviando ? 0 : naFila,   // quantos na frente (o proprio incluido), pra "Na fila · N na frente"
      passo: passoLbl,
    });
  }
  return json({ ok: true, runs });
}
async function handleWAFunnel(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _scEnsureTables(env);
  if (req.method === 'GET') {
    const phone = String((new URL(req.url)).searchParams.get('phone') || '').replace(/\D/g, '');
    const r = await env.DB.prepare('SELECT phone, seq_id, idx, items, status FROM wa_funnel_run WHERE phone=?').bind(phone).first();
    let total = 0; try { total = JSON.parse((r && r.items) || '[]').length; } catch (_) {}
    return json({ ok: true, run: r ? { phone: r.phone, seq_id: r.seq_id, idx: r.idx, status: r.status, total } : null });
  }
  let b; try { b = await req.json(); } catch (_) { b = {}; }
  const phone = String(b.phone || '').replace(/\D/g, '');
  if (!phone) return err('phone obrigatório');
  if (b.action === 'stop') { await _waFunnelStop(env, phone, 'stopped'); return json({ ok: true }); }
  const atId = (isDirector(u) && b.at_id != null) ? String(b.at_id) : String(u.id);
  const r = await _waFunnelIniciar(env, atId, phone, String(b.seq_id || ''));
  if (!r.ok) return json({ ok: false, error: r.error, code: r.code || null }, r.code === 'window_closed' ? 409 : 400);
  return json(r);
}

// DISPARO AUTOMATICO no lead novo (pedido do Bruno em 21/08/2026).
//
// Config no blob: data.funil_auto = { on: true, seq_id: '<id>', delay_s: 1 }. Sem ela ligada, nada
// acontece - quem decide qual funil sai e a tela do Sale Chat, nao o codigo.
//
// TRES TRAVAS, todas necessarias:
// 1. So na PRIMEIRA mensagem daquele telefone. Sem isso, todo "oi" do lead re-disparava o funil.
// 2. So se NAO houver funil rodando/rodado pra ele. Evita empilhar em cima de um manual.
// 3. Roda em waitUntil, nunca no caminho do ACK do webhook: se a Meta nao recebe 200 rapido, ela
//    reenvia o evento e a mensagem entra duplicada.
async function _waFunnelAuto(env, atId, phone) {
  try {
    if (!atId || !phone) return;
    const data = await _getDashData(env);
    const cfg = (data && data.funil_auto) || null;
    if (!cfg || !cfg.on || !cfg.seq_id) return;
    // ja existe run pra esse telefone? (rodando, pausado ou concluido) -> nao dispara de novo
    const jaTem = await env.DB.prepare('SELECT phone FROM wa_funnel_run WHERE phone=?').bind(phone).first();
    if (jaTem) return;
    // primeira mensagem da conversa? conta o que existe de ENTRADA
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM wa_messages WHERE phone=? AND direction='in'").bind(phone).first();
    if (Number((n && n.c) || 0) > 1) return;
    const esperar = Math.max(0, Math.min(60, Number(cfg.delay_s) || 1));
    if (esperar > 0) await new Promise((r) => setTimeout(r, esperar * 1000));
    const r = await _waFunnelIniciar(env, String(atId), phone, String(cfg.seq_id));
    if (!r.ok) console.log('FUNIL_AUTO_FALHOU', phone, r.error || '');
  } catch (e) { try { console.log('FUNIL_AUTO_ERRO', String((e && e.message) || e).slice(0, 120)); } catch (_) {} }
}

// INICIA UM FUNIL numa conversa. Extraida do handleWAFunnel pra o disparo AUTOMATICO (lead novo)
// usar exatamente o mesmo caminho do manual - duas implementacoes divergiriam na primeira mudanca.
async function _waFunnelIniciar(env, atId, phone, seqId) {
  const info = await _waFunnelSeq(env, String(seqId || ''));
  if (!info || !info.items.length) return { ok: false, error: 'sequência sem itens' };
  const now = Math.floor(Date.now() / 1000);
  // PINA O NUMERO AGORA. O funil inteiro vai falar por este chip, mesmo que a conversa seja
  // re-carimbada no meio (o lead escrevendo pro outro numero do mesmo vendedor).
  let instConv = '';
  try {
    const c = await env.DB.prepare('SELECT instance FROM wa_chats WHERE phone=?').bind(phone).first();
    instConv = String((c && c.instance) || '');
  } catch (_) {}
  const _pin = instConv ? await _apiNumFromInstance(env, instConv) : null;
  const apiNumPin = (_pin && _pin.verified) ? _pin : null;
  const first = await _waFunnelSendItem(env, atId, phone, info.items[0], info, apiNumPin, instConv);
  if (first && first.ok === false) return { ok: false, error: first.error, code: first.code || null };
  const st = info.items.length > 1 ? 'running' : 'done';
  await env.DB.prepare(
    `INSERT INTO wa_funnel_run (phone, at_id, seq_id, items, idx, next_at, status, updated_at, tentativas, parar_resp, iniciado_em, inst) VALUES (?,?,?,?,?,?,?,?,0,?,?,?)
     ON CONFLICT(phone) DO UPDATE SET at_id=excluded.at_id, seq_id=excluded.seq_id, items=excluded.items, idx=excluded.idx, next_at=excluded.next_at, status=excluded.status, updated_at=excluded.updated_at, tentativas=0, parar_resp=excluded.parar_resp, iniciado_em=excluded.iniciado_em, inst=excluded.inst`
  ).bind(phone, atId, info.seq.id, JSON.stringify(info.items), 1, now, st, now, info.pararResp ? 1 : 0, now, instConv || '').run();
  return { ok: true, sent: 1, total: info.items.length, status: st };
}

async function handleWhatsappCloudWebhook(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const tok = url.searchParams.get('hub.verify_token');
    const chal = url.searchParams.get('hub.challenge');
    const expected = await _waCloudVerifyToken(env);
    if (mode === 'subscribe' && tok && tok === expected) return new Response(chal || '', { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response('forbidden', { status: 403 });
  }
  let body; try { body = await req.json(); } catch (_) { return json({ ok: true }); }
  try {
    await _scEnsureTables(env);
    const now = Math.floor(Date.now() / 1000);
    const ownerCache = {};
    for (const entry of (body?.entry || [])) {
      for (const ch of (entry?.changes || [])) {
        const val = ch?.value || {};
        const selfNumber = String(val?.metadata?.display_phone_number || '').replace(/\D/g, '');
        const nomePorWa = {};
        (val?.contacts || []).forEach(c => { if (c?.wa_id) nomePorWa[String(c.wa_id).replace(/\D/g, '')] = (c?.profile?.name || ''); });
        // ── O QUE ACONTECEU COM O QUE A GENTE MANDOU ──────────────────────────────
        // A Meta manda um evento por mudanca de estado da mensagem: sent (ela aceitou e vai
        // entregar), delivered (chegou no aparelho), read (o lead abriu) e failed (nao vai chegar,
        // com o motivo). A gente nunca leu isso, entao o inbox mostrava "enviado" pra sempre - foi
        // o que fez o vendedor achar que tinha mandado e o lead nunca receber.
        //
        // Guardo direto na propria mensagem (msg_id = o wamid que a Meta devolveu no envio). Ordem
        // importa: a Meta pode reentregar eventos fora de ordem, entao 'read' nao pode voltar pra
        // 'sent'. O `failed` sempre ganha, porque e o unico que exige acao de alguem.
        const _ordemSt = { sent: 1, delivered: 2, read: 3 };
        for (const st of (val?.statuses || [])) {
          const wamid = String(st?.id || '');
          if (!wamid) continue;
          const estado = String(st?.status || '').toLowerCase();
          const quando = Number(st?.timestamp) || now;
          const e0 = (Array.isArray(st?.errors) && st.errors[0]) || null;
          const motivo = e0 ? [e0.code, e0.title || e0.message, e0?.error_data?.details].filter(Boolean).join(' · ').slice(0, 300) : null;
          try {
            if (estado === 'failed') {
              await env.DB.prepare('UPDATE wa_messages SET status=?, err=?, status_ts=? WHERE msg_id=?')
                .bind('failed', motivo || 'falhou (sem motivo informado)', quando, wamid).run();
            } else if (_ordemSt[estado]) {
              // so avanca: COALESCE trata a linha que ainda nao tem status
              await env.DB.prepare(
                `UPDATE wa_messages SET status=?, status_ts=? WHERE msg_id=?
                   AND COALESCE(status,'') <> 'failed'
                   AND (CASE COALESCE(status,'') WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END) < ?`
              ).bind(estado, quando, wamid, _ordemSt[estado]).run();
            }
          } catch (_) {}
          // Falha fica registrada tambem no audit, que e onde a gente olha quando o Bruno pergunta
          // "por que nao chegou" - a linha da mensagem guarda o estado atual, o audit guarda a
          // historia.
          if (estado === 'failed') {
            try {
              await env.DB.prepare('INSERT INTO sc_ingest_audit (source, self_number, phone, from_me, msg_id, type, body, push_name, ts, received_at, at_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                .bind('cloud-status', selfNumber, String(st?.recipient_id || '').replace(/\D/g, ''), 1, wamid, 'failed', String(motivo || '').slice(0, 2000), '', quando, now, null).run();
            } catch (_) {}
          }
        }

        for (const m of (val?.messages || [])) {
          const phone = String(m?.from || '').replace(/\D/g, '');
          const msgId = String(m?.id || '');
          const ts = Number(m?.timestamp) || now;
          const type = String(m?.type || 'text');
          const bodyTxt = (m?.text?.body) || (m?.button?.text) || (m?.interactive?.list_reply?.title)
            || (m?.interactive?.button_reply?.title) || (m?.[type] && m[type].caption) || '';
          const pushName = nomePorWa[phone] || '';
          let atId = null, ownInst = '';
          if (selfNumber) {
            if (!(selfNumber in ownerCache)) ownerCache[selfNumber] = await resolveOwner(env, selfNumber);
            const ow = ownerCache[selfNumber];
            if (ow) { atId = ow.at_id; ownInst = ow.instance || ''; }
          }
          try {
            await env.DB.prepare('INSERT INTO sc_ingest_audit (source, self_number, phone, from_me, msg_id, type, body, push_name, ts, received_at, at_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
              .bind('cloud', selfNumber, phone, 0, msgId, type, String(bodyTxt).slice(0, 2000), pushName, ts, now, atId).run();
          } catch (_) {}
          if (atId && phone) {
            const inst = _instComNumero(atId, selfNumber, ownInst);
            try { await _waLogMsg(env, { phone, instance: inst, direction: 'in', type, body: String(bodyTxt), pushName, ts, msgId: msgId || null }); } catch (_) {}
            // Mídia recebida: a Meta manda só o id. Baixa em background (nunca bloqueia o ACK 200).
            try {
              const mid = (m && m[type] && m[type].id) || null;
              if (mid && ctx && ctx.waitUntil) ctx.waitUntil(_waCloudDownloadMedia(env, mid, msgId));
            } catch (_) {}
            // Lead respondeu → para o funil automático (não empurra áudio por cima da resposta dele).
            try { await _waFunnelStop(env, phone, 'lead_respondeu'); } catch (_) {}
            // Lead NOVO: dispara o funil escolhido em Sale Chat. Em waitUntil pra nao segurar o ACK.
            try { if (ctx && ctx.waitUntil) ctx.waitUntil(_waFunnelAuto(env, atId, phone)); } catch (_) {}
            try {
              if (!_attribTablesOk) { try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_attrib (phone TEXT PRIMARY KEY, instance TEXT, updated_at INTEGER)').run(); _attribTablesOk = true; } catch (_) {} }
              await _waLeadCapture(env, inst, phone, String(bodyTxt), selfNumber, type, ts);
              await env.DB.prepare("INSERT INTO wa_attrib (phone, instance, updated_at) VALUES (?, ?, strftime('%s','now')) ON CONFLICT(phone) DO UPDATE SET instance=excluded.instance, updated_at=excluded.updated_at").bind(phone, inst).run();
            } catch (_) {}
          }
        }
      }
    }
  } catch (_) {}
  return json({ ok: true });   // responde 200 rápido sempre; senão a Meta reenvia e pode desativar o webhook
}
// ───────────────────────── Datacrazy → AXION ─────────────────────────
// O Datacrazy é o CRM/inbox; ele FORWARDA cada evento (via Automação: gatilho "mensagem recebida"
// + bloco API/HTTP) pra cá. A gente alimenta o MESMO pipeline do webhook oficial: log da mensagem,
// captura de lead (dispara InitiateCheckout se tiver atribuição da pressel) e detecção de venda
// (dispara CompletePayment). Instrumentado: grava o payload CRU em dc_events pra ver o formato real
// que a Automação manda e travar o mapa de campos. Nunca bloqueia: responde 200 sempre.
let _dcTablesOk = false;
async function _dcEnsureTables(env) {
  if (_dcTablesOk) return;
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS dc_events (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at INTEGER, ok INTEGER, phone TEXT, self TEXT, direction TEXT, event TEXT, text TEXT, raw TEXT)').run(); } catch (_) {}
  _dcTablesOk = true;
}
function _dcDeep(o, path) { try { return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); } catch (_) { return undefined; } }
function _dcPick(o, keys) { for (const k of keys) { const v = _dcDeep(o, k); if (v != null && String(v) !== '') return v; } return ''; }
// GET CRU na API do Datacrazy. Devolve SEMPRE { ok, status, dados, erro } pra quem chama conseguir
// separar "deu certo e veio vazio" de "falhou". Antes virava null nos dois casos e o inbox mostrava
// "nenhuma conversa" tanto com a chave vencida quanto num dia sem mensagem. Medido em 17/08/2026:
// com chave invalida a API responde HTTP 401 {"message":"Unauthorized","statusCode":401} — o motivo
// vinha no corpo e o `if (!r.ok) return null` jogava fora.
async function _dcApiGetRaw(env, path) {
  const key = await _readConfig(env, 'dc_api_key');
  if (!key) return { ok: false, status: 0, dados: null, erro: 'sem_dc_api_key' };
  let r;
  try {
    r = await fetch('https://api.g1.datacrazy.io/api/v1' + path, { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } });
  } catch (e) {
    return { ok: false, status: 0, dados: null, erro: 'rede: ' + String((e && e.message) || e) };
  }
  if (!r.ok) {
    // o CORPO do erro e o que diz se e chave vencida (401), permissao/plano (403) ou throttle (429)
    const corpo = await r.text().catch(() => '');
    return { ok: false, status: r.status, dados: null, erro: 'HTTP ' + r.status + ' ' + corpo.slice(0, 200) };
  }
  try {
    return { ok: true, status: r.status, dados: await r.json(), erro: '' };
  } catch (_) {
    return { ok: false, status: r.status, dados: null, erro: 'resposta nao-JSON' };
  }
}
// Compatibilidade: os outros caminhos do Datacrazy (leads, tags, instancias, CRM) continuam
// recebendo o corpo ou null, entao nada mais muda de contrato. A diferenca e que agora a falha
// DEIXA RASTRO no log do Worker (observability ja esta ligado no wrangler.toml; o problema era o
// `catch (_) {}` mudo, que aparece 226 vezes neste arquivo contra 1 unico console.error).
async function _dcApiGet(env, path) {
  const r = await _dcApiGetRaw(env, path);
  if (!r.ok) console.error('[dc] GET ' + path + ' falhou: ' + r.erro);
  return r.ok ? r.dados : null;
}
// Rastro da ultima rodada do sync do inbox. Fica em app_config, que ja e a tabela de estado
// operacional do worker (backup_ts, roleta_sat_ts e sc_reseed_ts moram la) — nao inventa tabela
// nova e nao precisa de migracao. Sem isto o cron de 2min podia falhar por dias sem nada mudar.
let _dcSaudeCache = null, _dcSaudeCacheT = 0;
async function _dcSyncSaude(env, reg) {
  const r = Object.assign({ ts: Math.floor(Date.now() / 1000), ok: false, parcial: false, erro: '', conversas: 0, mensagens: 0 }, reg || {});
  r.erro = String(r.erro || '').slice(0, 300);
  if (!r.ok || r.parcial) console.error('[dc-sync] ' + (r.ok ? 'parcial: ' : 'falhou: ') + (r.erro || 'sem motivo'));
  try { await _writeConfig(env, 'dc_sync_health', JSON.stringify(r)); }
  catch (e) { console.error('[dc-sync] nao gravou dc_sync_health: ' + String((e && e.message) || e)); }
  _dcSaudeCache = r; _dcSaudeCacheT = Date.now();
  return r;
}
// ── Sincronismo do INBOX: Datacrazy → wa_chats/wa_messages ──────────────────
// Auditado em 15/08/2026: o inbox da dash estava com ZERO conversa enquanto o Datacrazy tinha 11.
// Motivo: os números vivem em COEXISTÊNCIA e quem recebe o webhook da Meta é o app do Datacrazy
// (conferido no subscribed_apps da WABA: só o número 6200 tem o nosso app junto, e mesmo assim
// nada chegava). Depender do "forward por Automação" deixou a tela vazia e ninguém percebeu.
// Aqui a gente PUXA: a API do Datacrazy lista conversas e mensagens, e isso alimenta as MESMAS
// tabelas que o inbox já lê. Idempotente (msg_id é chave), então rodar de novo não duplica.
// Anexo do Datacrazy. O payload REAL deles (conferido na API em 17/08/2026) NAO tem m.type nem
// m.mediaURL: a midia vem em m.attachments[] = [{ type:'IMAGE'|'AUDIO'|'VIDEO', mimeType, url,
// fileName, size }] e o body vem AUSENTE quando a foto/audio nao tem legenda. Sem ler isso aqui, a
// foto virava type='text' + body='' + media_url=null, ou seja, uma linha invisivel no inbox (o
// msgVisible do front descarta mensagem 'text' sem corpo e sem arquivo).
// MENSAGEM NAO SUPORTADA VEM COM TEXTO DE SISTEMA (28/08/2026). O Datacrazy marca a mensagem com
// `unsupported: true` e MESMO ASSIM preenche o `body` com o nome interno do evento dele -
// "campaign_event_trigger" foi o que apareceu. Gravar esse texto faz o inbox mostrar
// "campaign_event_trigger" como se o LEAD tivesse escrito aquilo, na lista e no balao. O Bruno viu e
// perguntou "que merda e essa".
//
// Nao e mensagem: e evento de sistema que o WhatsApp nao sabe representar. Vira o marcador que o
// front JA desenha como "Mensagem nao suportada" (wa.js, NAO_SUPORTADA), entao a conversa continua
// aparecendo - o lead existe e precisa ser atendido - so para de fingir que ele mandou um texto.
//
// Olha o `unsupported`, nao o texto: assim vale pra QUALQUER nome de evento que eles inventem
// depois, e nao so pra este. Medido em 28/08: 12 mensagens, 7 telefones, desde 20/08.
const _dcBody = (m) => (m && m.unsupported ? 'unsupported_unknown_message_type' : String((m && m.body) || ''));

function _dcAttach(m) {
  const a = (m && Array.isArray(m.attachments) && m.attachments.length) ? m.attachments[0] : null;
  if (!a || !a.url) return null;
  const mime = String(a.mimeType || '').split(';')[0].trim().toLowerCase();   // "audio/ogg; codecs=opus" -> "audio/ogg"
  const t = String(a.type || '').toLowerCase();
  // tipo no vocabulario que o inbox JA entende (image/audio/video/document/sticker): decide pelo mime
  // (que e o dado confiavel) e so cai no a.type se o mime vier estranho.
  const tipo = /^image\//.test(mime) ? (t === 'sticker' ? 'sticker' : 'image')
    : /^audio\//.test(mime) ? 'audio'
    : /^video\//.test(mime) ? 'video'
    : (t === 'image' ? 'image' : t === 'audio' ? 'audio' : t === 'video' ? 'video' : t === 'sticker' ? 'sticker' : 'document');
  return { url: String(a.url), mime: mime || 'application/octet-stream', tipo };
}
// Copia o anexo do CDN do Datacrazy pro NOSSO R2 e devolve a key, exatamente como _waCloudDownloadMedia
// (Cloud API) e _waEvoDownloadMedia (Evolution) ja fazem. Devolve '' se falhar: nesse caso o sync deixa
// a URL do Datacrazy gravada e a imagem aparece do mesmo jeito.
// Guardar o audio como .ogg com contentType audio/ogg faz o /api/salechat/media devolver
// "audio/ogg; codecs=opus", que e o que transforma o balao em nota de voz com ondinha.
async function _dcStoreAttachment(env, url, mime) {
  try {
    if (!env.MEDIA || !url) return '';
    const r = await fetch(url);   // CDN deles e publico: responde 200 sem Authorization (conferido com curl)
    if (!r.ok) return '';
    const buf = await r.arrayBuffer();
    if (!buf || buf.byteLength === 0) return '';
    const m = String(mime || '').toLowerCase();
    const ext = m.indexOf('ogg') >= 0 ? 'ogg' : (m.indexOf('mpeg') >= 0 || m.indexOf('mp3') >= 0) ? 'mp3' : m.indexOf('mp4') >= 0 ? 'mp4' : m.indexOf('png') >= 0 ? 'png' : (m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0) ? 'jpg' : m.indexOf('webp') >= 0 ? 'webp' : m.indexOf('pdf') >= 0 ? 'pdf' : 'bin';
    const key = 'm/dc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
    await env.MEDIA.put(key, buf, { httpMetadata: { contentType: m || 'application/octet-stream' } });
    return key;
  } catch (_) { return ''; }
}
async function _dcSyncInbox(env, limiteConversas = 40, limiteMsgs = 40) {
  const key = await _readConfig(env, 'dc_api_key');
  // Sem chave nao e "inbox vazio", e integracao DESLIGADA: fica registrado como falha, senao a tela
  // mostra "nenhuma conversa" com a mesma cara de um dia parado.
  if (!key) { await _dcSyncSaude(env, { ok: false, erro: 'sem_dc_api_key' }); return { ok: false, motivo: 'sem_dc_api_key' }; }
  await _waEnsureTables(env);
  // A API deles IGNORA "limit" e so obedece "take" (conferido: ?limit=1 devolveu as 13 conversas,
  // ?take=1 devolveu 1, da mais recente pra mais antiga). Com "limit" o sync puxa TODAS as conversas
  // e dispara 1 request de mensagens pra cada uma, a cada 2 minutos do cron: com a base crescendo isso
  // estoura o limite de subrequests do Worker e o rate limit do Datacrazy, e ai o inbox para calado.
  // Se a LISTA falhar nao existe "0 conversa", existe ERRO: antes o null virava lista vazia e a
  // funcao respondia ok:true, deixando chave vencida identica a dia sem mensagem nenhuma.
  const res = await _dcApiGetRaw(env, `/conversations?take=${limiteConversas}`);
  if (!res.ok) {
    await _dcSyncSaude(env, { ok: false, erro: 'lista de conversas: ' + res.erro });
    return { ok: false, motivo: res.erro, status: res.status };
  }
  const convs = res.dados;
  const lista = Array.isArray(convs) ? convs : (convs && Array.isArray(convs.data) ? convs.data : []);
  // baixadas = teto de downloads de midia por rodada do cron. nFalhasMsgs = conversa cujo historico
  // falhou: e o que faz o sync se declarar PARCIAL em vez de dizer que deu tudo certo.
  let nChats = 0, nMsgs = 0, baixadas = 0, nFalhasMsgs = 0;
  // ORCAMENTO DE CPU (18/08/2026). Esta conta e Workers FREE: 10ms de CPU por invocacao. O laco
  // abaixo fazia, PARA CADA conversa, um SELECT no D1 (dono do numero) e um GET de historico na API
  // do Datacrazy - com 19 conversas isso e 19 consultas e 19 requisicoes por batida, toda batida,
  // inclusive pras conversas que ninguem tocou desde ontem. Estourava o limite e a batida morria no
  // meio, calada. Tres economias, nenhuma muda o resultado:
  //  (a) os donos vem numa consulta so, num mapa;
  //  (b) o que ja esta gravado vem numa consulta so, num mapa;
  //  (c) conversa cujo lastMessageDate NAO passou do que ja temos nao busca historico nenhum.
  const donos = new Map();
  try {
    const dr = await env.DB.prepare('SELECT display_phone, at_id FROM wa_api_numbers').all();
    for (const x of (dr.results || [])) if (x.display_phone) donos.set(String(x.display_phone), x.at_id || '');
  } catch (_) {}
  // MARCADOR PROPRIO DO SYNC ("ja puxei o historico desta conversa ate T"). Antes o gate comparava a
  // lastMessageDate do Datacrazy com wa_chats.last_ts, e isso furava de DOIS jeitos, os dois medidos
  // em 19/08/2026:
  //   1) ENVIO NOSSO adiantava o last_ts. O Datacrazy NAO enxerga o que sai pela Cloud API, entao uma
  //      mensagem que o VENDEDOR mandou do celular as 09:44 ficava atras do nosso envio das 09:46 e a
  //      conversa era pulada PARA SEMPRE - 45min depois ela ainda nao estava na thread.
  //   2) O POLL, que roda ANTES na mesma batida, gravava a ULTIMA mensagem e ja igualava o last_ts.
  //      Se o lead mandasse tres audios seguidos, o sync pulava a conversa e os dois primeiros
  //      sumiam: so o ultimo entrava no inbox.
  // Agora o marcador so anda quando o historico foi REALMENTE puxado, e quem escreve nele e so este
  // sync. Envio nosso e gravacao do poll nao mexem mais nele.
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS dc_sync_wm (phone TEXT PRIMARY KEY, ts INTEGER)').run(); } catch (_) {}
  const jaTem = new Map();
  try {
    const jr = await env.DB.prepare('SELECT phone, ts FROM dc_sync_wm').all();
    for (const x of (jr.results || [])) jaTem.set(String(x.phone), Number(x.ts) || 0);
  } catch (_) {}
  // Teto de historicos por batida. O que passar do teto entra na proxima (a lista vem da mais nova
  // pra mais antiga, entao o que interessa vem primeiro).
  let historicos = 0;
  const TETO_HISTORICO = 10;   // era 6; com o marcador proprio passam mais conversas por batida e o plano e pago
  for (const c of lista) {
    const phone = String(c?.contact?.phoneNumber || c?.contact?.contactId || '').replace(/\D/g, '');
    if (!phone) continue;
    // instância = número NOSSO que recebeu. Mesmo formato do resto da dash (ax_<at>_<8díg>) quando
    // o número já tem dono; senão marca a origem pra não sumir da lista do diretor.
    const selfNum = String(c?.instance?.config?.phoneNumber || '').replace(/\D/g, '');
    const donoAt = selfNum ? (donos.get(selfNum) || '') : '';
    const inst = donoAt ? ('ax_' + donoAt + '_' + selfNum.slice(-8)) : ('dc_' + (selfNum || 'sem'));
    const nome = String(c?.name || c?.contact?.name || '').slice(0, 120);
    const lm = c?.lastMessage || {};
    const ts = Math.floor(new Date(c?.lastMessageDate || lm.createdAt || Date.now()).getTime() / 1000);
    const dir = lm.received ? 'in' : 'out';
    // Preview da lista: foto/audio sem legenda vem com body vazio, entao mostra o rotulo do tipo,
    // igual o _waLogMsg ja faz ('[image]', '[audio]'). Senao o lead que mandou comprovante aparece
    // com a linha em branco e parece que nao respondeu nada.
    const anexoLM = _dcAttach(lm);
    const txt = (String(lm.body || '') || (anexoLM ? '[' + anexoLM.tipo + ']' : '')).slice(0, 500);
    // GUARDA DE RECENCIA (WHERE no fim do DO UPDATE). wa_chats e chaveada so por TELEFONE, mas o
    // mesmo contato pode ter uma conversa por numero NOSSO. Sem esta guarda as duas caiam na mesma
    // linha e se desfaziam a cada rodada de 2 min: a mais nova entrava e subia o last_ts, a mais
    // velha empurrava de volta, e no ciclo seguinte a condicao de nao-lida dava verdadeiro de novo.
    // O contador crescia sozinho pra sempre (achamos um em 65 sem mensagem desde 28/07), o inbox
    // tocava o ding e notificava de 2 em 2 minutos sem ninguem ter escrito, e o `instance` ficava
    // preso na conversa MAIS ANTIGA - o que joga a conversa pro inbox do vendedor errado, porque o
    // escopo por cargo filtra justamente por instance.
    // Com a guarda a linha assenta na conversa mais RECENTE, que e a que tem o dono certo.
    await env.DB.prepare(
      `INSERT INTO wa_chats (phone, instance, name, last_text, last_ts, last_dir, unread, updated_at)
       VALUES (?,?,?,?,?,?,?,strftime('%s','now'))
       ON CONFLICT(phone) DO UPDATE SET
         -- mesma regra do _waLogMsg: quem RECEBEU manda no carimbo (ver comentario la).
         instance=CASE WHEN excluded.last_dir='in' THEN excluded.instance
                       WHEN wa_chats.instance GLOB '*_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
                         OR wa_chats.instance GLOB 'dc_[0-9]*' THEN wa_chats.instance
                       ELSE excluded.instance END, name=COALESCE(NULLIF(excluded.name,''), wa_chats.name),
         last_text=excluded.last_text, last_ts=excluded.last_ts, last_dir=excluded.last_dir,
         unread=CASE WHEN excluded.last_ts > COALESCE(wa_chats.last_ts,0) AND excluded.last_dir='in'
                     THEN COALESCE(wa_chats.unread,0) + 1 ELSE COALESCE(wa_chats.unread,0) END,
         updated_at=strftime('%s','now')
       WHERE excluded.last_ts > COALESCE(wa_chats.last_ts, 0)`
    ).bind(phone, inst, nome, txt, ts, dir, dir === 'in' ? 1 : 0).run().catch(() => {});
    nChats++;
    // NADA MUDOU NESTA CONVERSA: pula o historico. A lista ja traz o lastMessageDate, entao da pra
    // saber sem gastar uma requisicao. Conversa nova (nao esta no mapa) sempre busca, pra trazer o
    // historico da primeira vez.
    const tinha = jaTem.get(phone);
    if (tinha !== undefined && ts <= tinha) continue;
    if (historicos >= TETO_HISTORICO) { nFalhasMsgs++; continue; }   // fica pra proxima batida
    historicos++;
    // histórico da conversa
    // Falha aqui NAO derruba a rodada (a conversa ja entrou na lista), mas e CONTADA: senao
    // "puxei 40 conversas e zero mensagem" passava como sucesso completo.
    const rm = await _dcApiGetRaw(env, `/conversations/${encodeURIComponent(c.id)}/messages?limit=${limiteMsgs}`);
    if (!rm.ok) { nFalhasMsgs++; console.error('[dc-sync] historico da conversa ' + c.id + ' falhou: ' + rm.erro); continue; }
    const ms = rm.dados;
    const msgs = Array.isArray(ms?.messages) ? ms.messages : (Array.isArray(ms) ? ms : (ms?.data || []));
    for (const m of msgs) {
      const id = String(m?.id || m?._id || '');
      if (!id) continue;
      const corpo = _dcBody(m).slice(0, 4000);
      const anexo = _dcAttach(m);   // foto/audio/video vem em attachments[], NAO em m.type/m.mediaURL
      const tipo = anexo ? anexo.tipo : String(m?.type || 'text').toLowerCase();
      const quando = Math.floor(new Date(m?.createdAt || Date.now()).getTime() / 1000);
      // Grava JA com a URL do CDN deles: a foto aparece na hora, mesmo se o R2 falhar (o resolveMedia
      // do front aceita tanto key do R2 quanto URL absoluta). Logo abaixo a gente troca pela key do R2.
      // O DO UPDATE conserta as linhas que o sync antigo gravou sem midia e as que ainda estao na URL
      // deles; nunca sobrescreve midia que ja foi pro R2 (key nao comeca com http).
      const ins = await env.DB.prepare(
        `INSERT INTO wa_messages (msg_id, phone, instance, direction, type, body, push_name, ts, media_url)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(msg_id) DO UPDATE SET type=excluded.type, media_url=excluded.media_url
           WHERE excluded.media_url IS NOT NULL
             AND (wa_messages.media_url IS NULL OR wa_messages.media_url LIKE 'http%')`
      ).bind('dc:' + id, phone, inst, m?.received ? 'in' : 'out', tipo, corpo, nome, quando, anexo ? anexo.url : null).run().catch(() => null);
      // So a mensagem NOVA (ou a recem-consertada) baixa o arquivo: 1 download por midia. Teto por
      // rodada pra nao estourar o tempo do cron; o que passar do teto continua com a URL do Datacrazy
      // e cai no R2 na proxima rodada (o WHERE acima deixa passar enquanto for http).
      const nova = !!(ins && ins.meta && ins.meta.changes);
      // ── A VENDA E DETECTADA AQUI, NO HISTORICO, e nao so na ultima mensagem ────────────────
      // O _dcPoll so olha `lastMessage` da conversa. Se o vendedor manda "Pedido Concluido" e digita
      // qualquer outra coisa antes da proxima rodada (2 min), a frase deixa de ser a ultima e a
      // venda NUNCA e detectada: nao entra em wa_sales, nao conta pro vendedor e nao vai pro pixel.
      // Foi o que aconteceu com a venda do Guilherme em 19/08/2026 - ele mandou o "Pedido Concluido"
      // as 11:42:37 e a mensagem seguinte saiu 13 SEGUNDOS depois. A do Murilo entrou porque a frase
      // dele ficou por acaso como ultima na hora da rodada. Ou seja: detectar venda estava na sorte.
      // Aqui a gente ve TODA mensagem do historico, entao a frase nao escapa. So dispara na primeira
      // vez que a mensagem entra (`nova`), e o _waDetectSale ainda e idempotente por msg_id.
      if (nova && !m?.received && /pedido\s+conclu/i.test(corpo)) {
        try { await _waDetectSale(env, inst, { message: { conversation: corpo }, key: { remoteJid: phone + '@c.us', id: 'dc:' + id, fromMe: true } }); }
        catch (e) { console.error('[dc-sync] venda do historico falhou: ' + String((e && e.message) || e)); }
      }
      if (anexo && nova && baixadas < 12) {
        baixadas++;
        const rkey = await _dcStoreAttachment(env, anexo.url, anexo.mime);
        if (rkey) { try { await env.DB.prepare('UPDATE wa_messages SET media_url=? WHERE msg_id=?').bind(rkey, 'dc:' + id).run(); } catch (_) {} }
      }
      nMsgs++;
    }
    // Historico desta conversa puxado ate a ultima mensagem que o Datacrazy conhece: marca. So aqui.
    try { await env.DB.prepare('INSERT INTO dc_sync_wm (phone, ts) VALUES (?,?) ON CONFLICT(phone) DO UPDATE SET ts=excluded.ts WHERE excluded.ts > dc_sync_wm.ts').bind(phone, ts).run(); } catch (_) {}
  }
  // Sucesso de verdade = a lista veio. Se o historico de alguma conversa falhou sai como PARCIAL,
  // com o numero na mao, pra tela poder avisar em vez de mostrar um "ok" mentiroso.
  const parcial = nFalhasMsgs > 0;
  await _dcSyncSaude(env, { ok: true, parcial, erro: parcial ? (nFalhasMsgs + ' conversa(s) sem historico') : '', conversas: nChats, mensagens: nMsgs });
  return { ok: true, parcial, conversas: nChats, mensagens: nMsgs, falhas_msgs: nFalhasMsgs };
}

// POST /api/wa/dc/sync — puxa o inbox do Datacrazy na hora (o cron de 2min já faz sozinho).
// Serve pro botão de recarregar do Atendimento não depender de esperar a próxima rodada.
// GET /api/tt/diag  → descobre POR QUE o TikTok recusa o evento quando ele sai do Worker.
// Nao cria evento nenhum: bate no user/info (leitura) e num event/track com data VAZIO, que a API
// recusa por validacao em vez de registrar conversao. O que interessa e o HTTP: 403 significa que
// fomos barrados antes de chegar na API; 200 significa que passamos.
// POST /api/tt/ads-config { token, advertiser_id }  → liga a leitura de gasto do TikTok.
// Guarda em app_config e JA TESTA a credencial, devolvendo o gasto de hoje. Sem o teste, uma
// credencial errada ficaria salva e o cartao mostraria zero pra sempre, parecendo que nao gastou.
async function handleTtAdsConfig(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Só o diretor', 403);
  let b = {}; try { b = await req.json(); } catch (_) {}
  const token = String(b.token || '').trim();
  const adv = String(b.advertiser_id || '').replace(/\D/g, '');
  if (!token || !adv) return err('Preciso do token e do advertiser_id');
  const hoje = _brDay();
  const qs = new URLSearchParams({
    advertiser_id: adv, report_type: 'BASIC', data_level: 'AUCTION_ADVERTISER',
    dimensions: JSON.stringify(['advertiser_id']), metrics: JSON.stringify(['spend']),
    start_date: hoje, end_date: hoje, page_size: '1',
  });
  let j = {}, http = 0;
  try {
    const r = await fetch('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?' + qs.toString(), {
      headers: { 'Access-Token': token, 'Accept': 'application/json', 'User-Agent': 'SellWave/1.0 (+https://sellwave.com.br)' },
    });
    http = r.status; j = await r.json().catch(() => ({}));
  } catch (e) { return err('Não consegui falar com o TikTok: ' + String((e && e.message) || e), 502); }
  if (String(j.code) !== '0') return err('O TikTok recusou: ' + String(j.message || ('HTTP ' + http)), 400);
  await _writeConfig(env, 'tt_ads_token', token);
  await _writeConfig(env, 'tt_advertiser_id', adv);
  const lista = (j.data && j.data.list) || [];
  const gasto = lista.reduce((a, x) => a + (Number(x && x.metrics && x.metrics.spend) || 0), 0);
  return json({ ok: true, gasto_hoje: gasto, advertiser_id: adv });
}
async function handleTtDiag(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Só o diretor', 403);
  const { pixel, token } = await _ttPixelToken(env, '1', '');
  const provas = [];
  const bate = async (nome, url, init) => {
    try {
      const r = await fetch(url, init);
      const t = await r.text();
      provas.push({ nome, http: r.status, corpo: t.slice(0, 160) });
    } catch (e) { provas.push({ nome, http: 0, corpo: 'rede: ' + String((e && e.message) || e) }); }
  };
  await bate('leitura (user/info)', 'https://business-api.tiktok.com/open_api/v1.3/user/info/', { headers: { 'Access-Token': token } });
  const corpoVazio = JSON.stringify({ event_source: 'web', event_source_id: pixel, data: [] });
  await bate('track sem UA', 'https://business-api.tiktok.com/open_api/v1.3/event/track/', { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json' }, body: corpoVazio });
  await bate('track com UA de navegador', 'https://business-api.tiktok.com/open_api/v1.3/event/track/', { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Accept-Language': 'pt-BR,pt;q=0.9', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }, body: corpoVazio });
  await bate('track com UA curl', 'https://business-api.tiktok.com/open_api/v1.3/event/track/', { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json', 'User-Agent': 'curl/8.4.0' }, body: corpoVazio });
  // ISOLA O QUE DISPARA O 403. Todos os eventos presos tem ttclid longo (250-320 caracteres); as
  // sondas que passaram nao tinham. Aqui vai o MESMO formato, com ttclid de verdade, mas com pixel
  // INVALIDO: se voltar 401/40001 (permissao), passamos pela protecao e o ttclid nao e o problema;
  // se voltar 403, e ele (ou o tamanho do corpo). Nao registra conversao nenhuma nos dois casos.
  let clidReal = '';
  try { const q = await env.DB.prepare("SELECT ttclid FROM tt_events WHERE ttclid<>'' ORDER BY ts DESC LIMIT 1").first(); clidReal = (q && q.ttclid) || ''; } catch (_) {}
  const comClid = JSON.stringify({ event_source: 'web', event_source_id: 'PIXEL_INVALIDO_DIAG',
    data: [{ event: 'InitiateCheckout', event_time: Math.floor(Date.now() / 1000), event_id: 'diag_clid',
             user: { phone: await sha256Hex('+5500000000000'), ttclid: clidReal } }] });
  const semClid = JSON.stringify({ event_source: 'web', event_source_id: 'PIXEL_INVALIDO_DIAG',
    data: [{ event: 'InitiateCheckout', event_time: Math.floor(Date.now() / 1000), event_id: 'diag_semclid',
             user: { phone: await sha256Hex('+5500000000000') } }] });
  const cab = { 'Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'SellWave/1.0 (+https://sellwave.com.br)' };
  await bate('pixel invalido COM ttclid real (' + clidReal.length + ' chars)', 'https://business-api.tiktok.com/open_api/v1.3/event/track/', { method: 'POST', headers: cab, body: comClid });
  await bate('pixel invalido SEM ttclid', 'https://business-api.tiktok.com/open_api/v1.3/event/track/', { method: 'POST', headers: cab, body: semClid });
  // SONDA REMOVIDA (2a vez). Ela mandava pro pixel REAL um evento com nome invalido, apostando que o
  // TikTok recusaria na validacao. Ele respondeu code=0 e ACEITOU: diagnostico registrando lixo no
  // pixel que paga a campanha, exatamente o que eu tinha dito que nao ia repetir.
  // REGRA: sonda que toca o pixel real usa event_source_id INVALIDO. Sempre.


  // MESMO FORMATO DE UM EVENTO REAL (user com telefone em sha256 e ttclid), mas com pixel INVALIDO:
  // a API recusa por validacao e nao registra conversao. Serve pra separar "fomos barrados por causa
  // do formato" de "fomos barrados por causa do IP/ritmo".
  const corpoReal = JSON.stringify({
    event_source: 'web', event_source_id: 'PIXEL_INVALIDO_DIAG',
    data: [{ event: 'InitiateCheckout', event_time: Math.floor(Date.now() / 1000), event_id: 'diag_' + Date.now(),
             user: { phone: await sha256Hex('+5500000000000'), ttclid: 'E_C_P_DIAGNOSTICO' } }],
  });
  await bate('track com payload real (pixel invalido)', 'https://business-api.tiktok.com/open_api/v1.3/event/track/', { method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'SellWave/1.0 (+https://sellwave.com.br)' }, body: corpoReal });
  // SONDA REMOVIDA (18/08/2026). Ela mandava um evento com o pixel VERDADEIRO e data de 8 dias
  // atras, esperando que o TikTok recusasse por janela. Ele ACEITOU (code 0), ou seja: a sonda
  // registrou um evento de mentira no pixel do Bruno. Um evento sem ttclid e com telefone falso nao
  // muda otimizacao, mas diagnostico NAO PODE escrever no pixel que paga a campanha. O que ela
  // provou ja esta provado: o Worker consegue enviar evento real, logo o 403 e passageiro, e o
  // conserto e insistir (ver o reenvio em _ttRetryFailed).

  return json({ ok: true, pixel_len: String(pixel || '').length, token_len: String(token || '').length, provas });
}
async function handleDcPollDiag(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Só o diretor', 403);
  const url = new URL(req.url);
  const janela = Math.min(Number(url.searchParams.get('janela')) || 900, 604800);
  const simular = url.searchParams.get('simular') !== '0';   // padrão: NÃO grava
  const passo = await _dcPoll(env, { janela, simular });
  return json({ ok: true, janela, simular, passo });
}
async function handleDcSync(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // O sync fala com o Datacrazy pela NOSSA chave e traz as NOSSAS conversas. O botao de recarregar
  // do Atendimento chama isto, e o afiliado tem a tela - entao ele gastava a nossa cota e via a
  // contagem do nosso inbox no toast. Nao uso isDirector aqui de proposito: vendedor, cobrador e
  // gestor NOSSOS usam esse botao todo dia e passariam a levar erro vermelho.
  if (noMundoAfiliado(u) || afiliadoSemVinculo(u)) return err('Sem permissão', 403);
  const r = await _dcSyncInbox(env, 60, 60).catch((e) => ({ ok: false, motivo: String((e && e.message) || e) }));
  // Falha de verdade (chave vencida, API fora, rede) tem que sair como ERRO HTTP: o api() do front
  // (axion-produtor/src/lib/api.js) so joga excecao quando o status nao e 2xx, e era exatamente por
  // isso que o botao de recarregar mostrava sucesso com a integracao morta. O campo que o front le
  // e `error`.
  if (!r || r.ok === false) {
    console.error('[dc-sync] sync manual falhou: ' + ((r && r.motivo) || 'sem motivo'));
    return json({ ok: false, error: 'Datacrazy nao respondeu: ' + ((r && r.motivo) || 'erro desconhecido'), motivo: (r && r.motivo) || '', status_dc: (r && r.status) || 0 }, 502);
  }
  return json(r);
}

// Dado o telefone do lead, acha a conversa no Datacrazy e devolve o NÚMERO que recebeu (self = instance.config.phoneNumber),
// o TEXTO da última mensagem recebida e o nome. Reforço pra quando a Automação não mandar esses campos: basta o ${leadPhone}.
async function _dcResolveConv(env, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const j = await _dcApiGet(env, '/conversations?take=5&search=' + encodeURIComponent(digits));
  const arr = (j && (j.data || j)) || [];
  if (!Array.isArray(arr) || !arr.length) return null;
  const same = arr.filter(c => String((c.contact && c.contact.phoneNumber) || '').replace(/\D/g, '') === digits);
  const inbound = same.filter(c => c.lastMessage && c.lastMessage.received === true);   // prefere a conversa de ENTRADA (o número que recebeu o lead)
  const list = inbound.length ? inbound : (same.length ? same : arr);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  const c = list[0];
  const self = String((c.instance && c.instance.config && c.instance.config.phoneNumber) || '').replace(/\D/g, '');
  const lm = c.lastMessage || {};
  const text = lm.received ? _dcBody(lm) : '';
  const name = String((c.contact && c.contact.name) || '');
  return { self, text, name, convId: c.id };
}
async function handleDatacrazyEvent(req, env, ctx) {
  await _dcEnsureTables(env);
  let b; try { b = await req.json(); } catch (_) { b = {}; }
  const url = new URL(req.url);
  const secret = req.headers.get('x-dc-secret') || url.searchParams.get('secret') || (b && b.secret) || '';
  const expected = await _readConfig(env, 'dc_hook_secret');
  const authed = !!expected && secret === expected;
  // Extração tolerante: o corpo é montado pelo Bruno na Automação, então aceitamos vários nomes.
  const _ph = v => /^\{.*\}$/.test(String(v == null ? '' : v).trim());   // "{texto da mensagem}" = placeholder que o Bruno não trocou
  const _cl = v => (_ph(v) ? '' : String(v == null ? '' : v));
  const phone = String(_dcPick(b, ['phone', 'telefone', 'rawPhone', 'lead.phone', 'lead.rawPhone', 'leadPhone', 'from', 'contact.phone', 'contact.phoneNumber'])).replace(/\D/g, '');
  let self = String(_dcPick(b, ['instance', 'number', 'numero', 'instancia', 'self', 'selfNumber', 'instancePhone', 'instance.phoneNumber', 'channel'])).replace(/\D/g, '');
  let text = _cl(_dcPick(b, ['text', 'body', 'message', 'mensagem', 'message.text', 'content']));
  let name = _cl(_dcPick(b, ['name', 'nome', 'lead.name', 'leadName', 'contact.name', 'pushName']));
  const evt = String(_dcPick(b, ['event', 'type', 'trigger']) || 'message_in');
  const dirRaw = String(_dcPick(b, ['direction', 'dir', 'fromMe']) || '').toLowerCase();
  const isOut = dirRaw === 'out' || dirRaw === 'true' || dirRaw === 'outbound' || evt.includes('sent') || evt.includes('enviad');
  const direction = isOut ? 'out' : 'in';
  // Recuperação server-side: se o número que recebeu (self) ou o texto vierem vazios/placeholder,
  // busca a conversa do lead no Datacrazy pela API — basta o telefone. Assim a Automação só precisa
  // mandar o ${leadPhone} certo; instância e texto o AXION descobre sozinho.
  if (authed && direction === 'in' && phone && (!self || !text)) {
    try {
      const rc = await _dcResolveConv(env, phone);
      if (rc) { if (!self) self = rc.self; if (!text) text = rc.text; if (!name) name = rc.name; }
    } catch (_) {}
  }
  try {
    await env.DB.prepare("INSERT INTO dc_events (received_at, ok, phone, self, direction, event, text, raw) VALUES (strftime('%s','now'),?,?,?,?,?,?,?)")
      .bind(authed ? 1 : 0, phone || null, self || null, direction, evt, String(text).slice(0, 500), JSON.stringify(b).slice(0, 4000)).run();
  } catch (_) {}
  if (!authed) return json({ ok: true, note: 'logged' });   // segredo ausente/errado: loga mas não processa
  try {
    if (phone) {
      let atId = null, ownInst = '';
      if (self) { const ow = await resolveOwner(env, self); if (ow) { atId = ow.at_id; ownInst = ow.instance || ''; } }
      const inst = _instComNumero(atId, self, ownInst);   // idem: a instancia TEM que dizer qual numero recebeu
      const now = Math.floor(Date.now() / 1000);
      if (inst) {
        // MESMA MENSAGEM ENTRANDO 2x NO INBOX (19/08/2026, o Bruno viu 4 baloes iguais na tela).
        // Este webhook gravava SEM msg_id, entao o _waLogMsg gerava um id aleatorio e o INSERT OR
        // IGNORE nunca colidia com o 'dc:<id>' que o poll/sync grava da MESMA mensagem: as duas
        // versoes ficavam na thread, com segundos de diferenca.
        // 1) se a Automacao mandar o id da mensagem, usa ele com o MESMO prefixo do poll ('dc:') e a
        //    colisao resolve sozinha;
        // 2) se nao mandar (o corpo e montado a mao no Datacrazy), procura uma mensagem igual na
        //    mesma conversa nos ultimos 120s e desiste. Perder uma repeticao real do lead dentro de
        //    2min e MUITO mais barato que mostrar tudo dobrado.
        const _dcId = String(_dcPick(b, ['msgId', 'messageId', 'message.id', 'messageID', 'id']) || '').trim();
        let _pular = false;
        if (!_dcId) {
          try {
            const _ja = await env.DB.prepare(
              "SELECT 1 FROM wa_messages WHERE phone=? AND direction=? AND COALESCE(body,'')=? AND ts > ? LIMIT 1"
            ).bind(phone, direction, String(text || ''), now - 120).first();
            _pular = !!_ja;
          } catch (_) {}
        }
        if (!_pular) {
          try { await _waLogMsg(env, { phone, instance: inst, direction, type: 'text', body: text, pushName: name, ts: now, msgId: _dcId ? ('dc:' + _dcId) : null }); } catch (_) {}
        }
        if (direction === 'in') {
          try { await _waFunnelStop(env, phone, 'lead_respondeu'); } catch (_) {}
          // Lead NOVO por este caminho tambem dispara o funil escolhido no Sale Chat.
          try { if (ctx && ctx.waitUntil) ctx.waitUntil(_waFunnelAuto(env, atId, phone)); } catch (_) {}
          try { await _waLeadCapture(env, inst, phone, text, self, 'text', now); } catch (_) {}
          try { await _dcCrmLeadIn(env, phone, name); } catch (_) {}   // negócio em "Lead Novo" + tag
        } else {
          let _srw = null;
          try { _srw = await _waDetectSale(env, inst, { message: { conversation: text }, key: { remoteJid: phone + '@c.us', remoteJidAlt: phone + '@c.us', id: null, fromMe: true } }); } catch (_) {}
          if (_srw && _srw.sale) { try { await _dcCrmSale(env, phone, name, _srw.value, phone); } catch (_) {} }   // tag "Comprou" + pedido em "A Enviar"
        }
      }
    }
  } catch (_) {}
  return json({ ok: true });
}
// GET /api/dc/events — diretor inspeciona os últimos payloads crus recebidos do Datacrazy.
async function handleDatacrazyEventsList(req, env) {
  const u = await authUser(req, env); if (!u || !isDirector(u)) return err('Não autorizado', 403);
  await _dcEnsureTables(env);
  const r = await env.DB.prepare('SELECT id, received_at, ok, phone, self, direction, event, text, raw FROM dc_events ORDER BY id DESC LIMIT 30').all();
  return json({ events: (r && r.results) || [] });
}
// PUXA os leads novos do Datacrazy pela API (roda no cron). Não depende da Automação do Datacrazy
// disparar — o AXION busca as conversas recentes, pega as mensagens INBOUND novas (dedup por msg_id)
// e roda o mesmo pipeline (log + captura de lead + pixel + para funil). É o backbone confiável;
// a Automação/webhook é só o caminho em tempo real (os dois deduplicam, não conta lead 2x).
// Sincroniza o token da Meta de cada número (do Datacrazy /instances) pra dentro do wa_api_numbers.
// O envio (funil/áudio/mídia/texto) sai pela Cloud API usando o token do PRÓPRIO número — o wa_api_token
// do AXION não tem permissão nos números da WABA do Datacrazy. Roda no cron pra manter o token fresco.
async function _dcSyncInstances(env) {
  const j = await _dcApiGet(env, '/instances');
  const arr = (j && (j.data || j)) || [];
  if (!Array.isArray(arr) || !arr.length) return;
  for (const inst of arr) {
    try {
      const cfg = (inst && inst.config) || {};
      const disp = String(cfg.phoneNumber || '').replace(/\D/g, '');
      const token = String(cfg.token || '');
      if (!disp || !token) continue;
      const nk = _waNumKey(disp);
      const r = await env.DB.prepare("UPDATE wa_api_numbers SET token=?, waba_id=COALESCE(?, waba_id), updated_at=strftime('%s','now') WHERE num_key=?").bind(token, String(cfg.wabaId || '') || null, nk).run();
      // Número CONECTADO NO DATACRAZY e ainda sem cadastro aqui entra agora. Antes isso era só
      // UPDATE: número novo (coexistência de 15/08) nunca aparecia na dash, ficava sem dono, e a
      // conversa dele só o diretor via. Sem at_id de propósito — quem escolhe o vendedor é o Bruno.
      const mexeu = r && r.meta && (r.meta.changes || r.meta.rows_written);
      if (!mexeu && cfg.phoneNumberId) {
        await _waApiUpsert(env, {
          phone_number_id: String(cfg.phoneNumberId),
          display_phone: disp,
          waba_id: String(cfg.wabaId || cfg.businessId || '') || null,
          verified: 1,
        });
        await env.DB.prepare("UPDATE wa_api_numbers SET token=? WHERE phone_number_id=?").bind(token, String(cfg.phoneNumberId)).run().catch(() => {});
      }
    } catch (_) {}
  }
}
let _dcSeenOk = false;
// AGENDA: avisa quem marcou o retorno na hora marcada.
// O cobrador marcava "retornar 14:30" e ninguém avisava ninguém: data.notifs só tinha saque e
// mudança de permissão, e nada no servidor olhava os agendamentos. Sem isto a Agenda é um caderno
// que ninguém abre na hora certa — que é exatamente quando ela vale.
// Regras que evitam os dois jeitos de isso virar lixo:
//  - só avisa uma vez por HORÁRIO (grava lead.agend_avisado com o horário avisado). Reagendou pra
//    outra hora, avisa de novo; salvou o pedido sem mexer na hora, não repete.
//  - ignora agendamento com mais de 24h de atraso: ligar isso hoje não pode despejar um ano de
//    retorno vencido no sino de todo mundo.
//  - o aviso vai pra QUEM É DONO do lead (lead.at). Sem dono, vai pro diretor, que é quem sobra.
async function _agendaTick(env) {
  const agora = Math.floor(Date.now() / 1000);
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return 0;
    let data; try { data = JSON.parse(row.data); } catch (_) { return 0; }
    const leads = Array.isArray(data.leads) ? data.leads : [];
    if (!Array.isArray(data.notifs)) data.notifs = [];
    let proximoId = data.notifs.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0) + 1;
    const criadas = [];
    for (const l of leads) {
      if (!l || !l.agend) continue;
      if (String(l.agend_avisado || '') === String(l.agend)) continue;   // esse horário já foi avisado
      // 'YYYY-MM-DDTHH:MM' é hora LOCAL (BR, UTC-3). Sem o fuso explícito o JS trataria como UTC e o
      // aviso sairia 3 horas adiantado.
      const t = Math.floor(new Date(String(l.agend).length <= 16 ? String(l.agend) + ':00-03:00' : String(l.agend)).getTime() / 1000);
      if (!t || isNaN(t)) continue;
      if (t > agora) continue;                       // ainda não chegou a hora
      if (agora - t > 86400) { l.agend_avisado = l.agend; continue; }   // atrasado demais: marca e não avisa
      const quem = String(l.at || '') || 'diretor';
      const hora = String(l.agend).slice(11, 16);
      criadas.push({
        id: proximoId++, type: 'cobranca', title: 'Retorno agendado agora',
        description: (l.nome || 'Cliente') + (hora ? (' · combinado pra ' + hora) : ''),
        to: quem, unread: true, ts: agora, ref: 'agend:' + l.id + ':' + l.agend, link: '/apps/calendar',
      });
      l.agend_avisado = l.agend;
      if (criadas.length >= 20) break;   // teto por rodada: sino não vira enxurrada
    }
    if (!criadas.length) return 0;
    data.notifs = [...criadas.reverse(), ...data.notifs].slice(0, 200);   // guarda as 200 últimas
    const novaV = (row.version || 0) + 1;
    const r = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), novaV, agora, 'agenda', row.version).run();
    if (r && r.meta && r.meta.changes > 0) { console.error('[agenda] ' + criadas.length + ' aviso(s) de retorno'); return criadas.length; }
    await new Promise((res) => setTimeout(res, 15 * (tentativa + 1)));   // outra escrita ganhou: relê e refaz
  }
  return 0;
}
async function _dcPoll(env, opts = {}) {
  // JANELA DE 6 HORAS, não de 15 minutos. O corte de 15min existia pra não transformar histórico em
  // lead ao ligar a integração, mas ele media a idade da MENSAGEM e nós só enxergamos a mensagem
  // quando a API do Datacrazy a expõe. Medido em 17/08/2026: as 13 conversas do dia foram TODAS
  // rejeitadas por 'velha' (a mais nova tinha 97 minutos) e por isso wa_lead estava zerado - lead
  // nenhum, evento nenhum pro pixel, com a campanha prestes a subir.
  // Abrir a janela é seguro porque quem impede reprocessar é o dc_seen (uma linha por mensagem já
  // tratada), não o relógio. O histórico que existia antes desta mudança foi marcado como visto na
  // mão, então nada velho vira lead novo.
  const janela = Number(opts.janela) > 0 ? Number(opts.janela) : 21600;   // idade máxima da mensagem, em segundos
  const simular = !!opts.simular;                                       // true = não grava nada, só conta
  // CONTADOR POR GUARDA. Sem isto o poll é caixa preta: ele roda "ok", não cria lead nenhum e não há
  // como saber em qual guarda a mensagem parou. Cada campo é uma porta por onde a mensagem sai.
  const passo = { conversas: 0, sem_lastmessage: 0, sem_id: 0, velha: 0, so_vendedor: 0, ja_vista: 0, sem_telefone: 0, sem_dono: 0, processada: 0, erro: 0 };
  const key = await _readConfig(env, 'dc_api_key');
  if (!key) return passo;
  const j = await _dcApiGet(env, '/conversations?take=40');
  const arr = (j && (j.data || j)) || [];
  if (!Array.isArray(arr) || !arr.length) return passo;
  passo.conversas = arr.length;
  await _dcEnsureTables(env);
  if (!_dcSeenOk) { try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS dc_seen (msg_id TEXT PRIMARY KEY, ts INTEGER)').run(); _dcSeenOk = true; } catch (_) {} }
  const now = Math.floor(Date.now() / 1000);
  try { await env.DB.prepare("DELETE FROM dc_seen WHERE ts < strftime('%s','now')-172800").run(); } catch (_) {}   // poda > 2 dias
  let baixadasLM = 0;   // teto de midias copiadas pro R2 por batida (igual ao _dcSyncInbox)
  for (const c of arr) {
    try {
      const lm = c.lastMessage;
      if (!lm) { passo.sem_lastmessage++; continue; }
      const inbound = lm.received === true;   // true = lead mandou; false = vendedor mandou
      const msgId = String(lm.id || '');
      if (!msgId) { passo.sem_id++; continue; }
      const mts = lm.createdAt ? Math.floor(new Date(lm.createdAt).getTime() / 1000) : now;
      if (now - mts > janela) { passo.velha++; continue; }   // só o recente — não reprocessa histórico ao ligar
      const text = _dcBody(lm);
      // venda = "Pedido Concluído" que o VENDEDOR posta (mesma assinatura da dash). _waDetectSale confere o resto.
      const isSale = !inbound && /pedido\s+conclu/i.test(text);
      if (!inbound && !isSale) { passo.so_vendedor++; continue; }   // mensagem normal do vendedor (não-venda): ignora
      // DEDUPE só CONSULTA aqui. Marcar como visto ANTES de processar era o que apagava a mensagem
      // pra sempre: número sem dono caía fora do "if (inst)" e na rodada seguinte batia em "já visto".
      let jaVisto = null;
      try { jaVisto = await env.DB.prepare('SELECT 1 FROM dc_seen WHERE msg_id=? LIMIT 1').bind(msgId).first(); } catch (_) {}
      if (jaVisto) { passo.ja_vista++; continue; }
      const phone = String((c.contact && c.contact.phoneNumber) || '').replace(/\D/g, '');
      const self = String((c.instance && c.instance.config && c.instance.config.phoneNumber) || '').replace(/\D/g, '');
      const name = String((c.contact && c.contact.name) || '');
      if (!phone) { passo.sem_telefone++; continue; }
      let atId = null, ownInst = '';
      if (self) { const ow = await resolveOwner(env, self); if (ow) { atId = ow.at_id; ownInst = ow.instance || ''; } }
      const inst = _instComNumero(atId, self, ownInst);   // idem: a instancia TEM que dizer qual numero recebeu
      // QUARENTENA: número ainda SEM DONO (o _dcSyncInstances cadastra número novo do Datacrazy com
      // at_id nulo de propósito; até o Bruno atribuir na Contingência, resolveOwner devolve nada).
      // NÃO marca como visto: a próxima rodada do cron (2min) tenta de novo. Enquanto isso a mensagem
      // fica registrada na auditoria com source 'dc' (antes NADA escrevia 'dc' lá, por isso o resgate
      // do cron não cobria este caminho) pro resgate conseguir enxergar depois que o dono aparecer.
      // Não vira loop eterno: a janela de 15min lá em cima (now - mts > 900) para de trazer a
      // mensagem quando ela envelhece. É a mesma janela do _waLeadCapture, que também recusa
      // mensagem com mais de 900s pra histórico não virar lead novo.
      if (!inst) {
        passo.sem_dono++;
        if (simular) continue;
        let jaAud = null;
        try { jaAud = await env.DB.prepare('SELECT 1 FROM sc_ingest_audit WHERE msg_id=? LIMIT 1').bind(msgId).first(); } catch (_) {}
        if (!jaAud) {
          try {
            await env.DB.prepare('INSERT INTO sc_ingest_audit (source, self_number, phone, from_me, msg_id, type, body, push_name, ts, received_at, at_id) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)')
              .bind('dc', self || '', phone, inbound ? 0 : 1, msgId, 'text', text.slice(0, 2000), name, mts, now).run();
          } catch (_) {}
          try { await env.DB.prepare("INSERT INTO dc_events (received_at, ok, phone, self, direction, event, text, raw) VALUES (strftime('%s','now'),0,?,?,?,'poll-sem-dono',?,?)").bind(phone, self || null, inbound ? 'in' : 'out', text.slice(0, 500), JSON.stringify({ via: 'poll', convId: c.id, msgId, motivo: 'numero_sem_dono' }).slice(0, 1000)).run(); } catch (_) {}
        }
        continue;
      }
      passo.processada++;
      // Em SIMULAÇÃO o item para aqui: contou, não gravou. É o que permite perguntar "esse lead
      // viraria lead?" sem criar lead, sem disparar pixel e sem mexer no Datacrazy.
      if (simular) continue;
      try { await env.DB.prepare("INSERT INTO dc_events (received_at, ok, phone, self, direction, event, text, raw) VALUES (strftime('%s','now'),1,?,?,?,?,?,?)").bind(phone, self || null, inbound ? 'in' : 'out', isSale ? 'poll-sale' : 'poll', text.slice(0, 500), JSON.stringify({ via: 'poll', convId: c.id, msgId }).slice(0, 1000)).run(); } catch (_) {}
      // msg_id com o MESMO prefixo do _dcSyncInbox ('dc:'), senão a mesma mensagem entra 2x no inbox
      // (o sync grava 'dc:<id>' e o poll gravaria '<id>', chaves diferentes, linha duplicada na tela).
      // AUDIO DO LEAD SUMINDO DO INBOX (19/08/2026, reportado pelo vendedor do Guilherme). Aqui era
      // type:'text' chumbado e o lastMessage.attachments ia pro lixo: nota de voz virava linha
      // type='text' com body VAZIO, e o msgVisible() do front nao desenha balao nenhum pra isso. O
      // vendedor ouvia o audio no WhatsApp e nao achava nada no inbox - "estava confundindo a cabeca,
      // eu ouvia por um e respondia pelo outro".
      // NAO adiantava contar com o _dcSyncInbox pra consertar depois: ele roda DEPOIS do poll na
      // MESMA batida e pula a conversa quando `ts <= wa_chats.last_ts`, valor que o proprio poll
      // acabou de igualar. Quem grava primeiro decide o tipo, e o poll grava primeiro quase sempre.
      // Medido em 19/08: 16 audios no Datacrazy, 12 certos e 4 (os mais recentes) virados texto vazio.
      const anexoLM = _dcAttach(lm);
      let mediaLM = anexoLM ? anexoLM.url : null;   // CDN deles; o resolveMedia do front aceita url absoluta
      if (anexoLM && baixadasLM < 12) {             // copia pro R2 (o CDN deles pode expirar); teto por batida
        baixadasLM++;
        try { const k = await _dcStoreAttachment(env, anexoLM.url, anexoLM.mime); if (k) mediaLM = k; } catch (_) {}
      }
      try { await _waLogMsg(env, { phone, instance: inst, direction: inbound ? 'in' : 'out', type: anexoLM ? anexoLM.tipo : 'text', body: text, pushName: name, ts: mts, msgId: 'dc:' + msgId, media_url: mediaLM }); } catch (_) {}
      if (inbound) {
        try { await _waFunnelStop(env, phone, 'lead_respondeu'); } catch (_) {}
        // Aqui NAO ha ctx (roda no cron, que ja e fora do caminho de request), entao chama direto.
        try { await _waFunnelAuto(env, atId, phone); } catch (_) {}
        // passa a MESMA janela do poll: aqui a mensagem já foi deduplicada por dc_seen, então o
        // teto de 15min só serviria pra descartar lead de verdade por atraso da API deles.
        try { await _waLeadCapture(env, inst, phone, text, self, anexoLM ? anexoLM.tipo : 'text', mts, janela); } catch (_) {}   // 1ª msg = lead → InitiateCheckout
        try { await _dcCrmLeadIn(env, phone, name); } catch (_) {}   // cria negócio em "Lead Novo" + tag no Datacrazy
      } else if (isSale) {
        let _sr2 = null;
        try { _sr2 = await _waDetectSale(env, inst, { message: { conversation: text }, key: { remoteJid: phone + '@c.us', remoteJidAlt: phone + '@c.us', id: msgId, fromMe: true } }); } catch (_) {}   // "Pedido Concluído" → CompletePayment
        if (_sr2 && _sr2.sale) { try { await _dcCrmSale(env, phone, name, _sr2.value, phone); } catch (_) {} }   // tag "Comprou" + pedido em "A Enviar"
      }
      // BAIXA no FIM: só marca como visto depois de processar com dono. Se a rodada morrer no meio
      // (D1 fora, cron cortado), a mensagem volta na próxima. Repassar é seguro porque tudo acima é
      // idempotente (wa_messages por msg_id, wa_lead por telefone, _waDetectSale por msg_id, dc_crm).
      try { await env.DB.prepare("INSERT OR IGNORE INTO dc_seen (msg_id, ts) VALUES (?, ?)").bind(msgId, now).run(); } catch (_) {}
    } catch (_) {}
  }
  // Rede de segurança da VENDA: o "Pedido Concluído" pode NÃO ser a última msg (o lead responde depois e o
  // poll só enxerga a última). Nas conversas cuja última é do LEAD, varre as mensagens e pega a venda ainda
  // não vista. Limitado a 15 conversas/rodada pra não estourar a API do Datacrazy (120 req/min).
  let _scanned = 0;
  for (const c of arr) {
    if (_scanned >= 15) break;
    const lm = c.lastMessage;
    if (!lm || lm.received !== true) continue;
    const cu = c.updatedAt ? Math.floor(new Date(c.updatedAt).getTime() / 1000) : 0;
    if (now - cu > 900) continue;   // só conversas ativas nos últimos 15min
    _scanned++;
    try { await _dcScanConvSales(env, c, now); } catch (_) {}
  }
  // Uma linha por rodada COM movimento. Rodada parada não loga (senão vira ruído a cada 2min), mas
  // no dia em que o lead não virar lead, o log diz em qual guarda ele parou.
  if (passo.processada || passo.sem_dono || passo.erro) console.error('[dc-poll] ' + JSON.stringify(passo));
  return passo;
}
// Varre as últimas mensagens de UMA conversa e dispara a venda ("Pedido Concluído" do vendedor) ainda não vista.
async function _dcScanConvSales(env, c, now) {
  const j = await _dcApiGet(env, '/conversations/' + encodeURIComponent(c.id) + '/messages?take=12');
  const msgs = (j && (j.data || j.messages || j)) || [];
  if (!Array.isArray(msgs) || !msgs.length) return;
  const phone = String((c.contact && c.contact.phoneNumber) || '').replace(/\D/g, '');
  const self = String((c.instance && c.instance.config && c.instance.config.phoneNumber) || '').replace(/\D/g, '');
  if (!phone) return;
  let atId = null, ownInst = '';
  if (self) { const ow = await resolveOwner(env, self); if (ow) { atId = ow.at_id; ownInst = ow.instance || ''; } }
  const inst = _instComNumero(atId, self, ownInst);   // idem
  if (!inst) return;
  for (const m of msgs) {
    if (m.received === true) continue;   // só outbound do vendedor
    const body = String(m.body || '');
    if (!/pedido\s+conclu/i.test(body)) continue;
    const mid = String(m.id || '');
    if (!mid) continue;
    const mts = m.createdAt ? Math.floor(new Date(m.createdAt).getTime() / 1000) : now;
    if (now - mts > 1800) continue;   // venda até 30min atrás
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO dc_seen (msg_id, ts) VALUES (?, ?)").bind(mid, now).run();
    if (!ins.meta || ins.meta.changes === 0) continue;   // já vista
    try { await env.DB.prepare("INSERT INTO dc_events (received_at, ok, phone, self, direction, event, text, raw) VALUES (strftime('%s','now'),1,?,?,'out','poll-sale',?,?)").bind(phone, self || null, body.slice(0, 500), JSON.stringify({ via: 'poll-scan', convId: c.id, msgId: mid }).slice(0, 1000)).run(); } catch (_) {}
    // PREFIXO 'dc:' OBRIGATORIO, igual ao _dcPoll e ao _dcSyncInbox. Sem ele a MESMA mensagem de
    // "Pedido Concluido" entrava 2x na thread: aqui como '<id>' e la como 'dc:<id>', chaves
    // diferentes, entao o INSERT OR IGNORE nunca colidia. Achado em 19/08/2026 com uma venda real
    // duplicada no inbox. O proprio comentario do _dcPoll ja avisava disso.
    try { await _waLogMsg(env, { phone, instance: inst, direction: 'out', type: 'text', body, ts: mts, msgId: 'dc:' + mid }); } catch (_) {}
    let _sr = null;
    try { _sr = await _waDetectSale(env, inst, { message: { conversation: body }, key: { remoteJid: phone + '@c.us', remoteJidAlt: phone + '@c.us', id: mid, fromMe: true } }); } catch (_) {}
    if (_sr && _sr.sale) { try { await _dcCrmSale(env, phone, (c.contact && c.contact.name) || '', _sr.value, phone); } catch (_) {} }
  }
}
// ── CRM Datacrazy: cria lead+negócio e aplica tags, andando o kanban sozinho (dedup local em dc_crm) ──
const DC_TAG_LEAD_NOVO = '36443ad1-0487-4fdc-8568-87e847972ca2';
const DC_TAG_COMPROU = 'a5dfd99c-332f-4faa-96b4-aaa36284df2d';
const DC_STAGE_LEAD_NOVO = 'bb318d1d-73ea-4f58-938a-bafe91dba925';   // Sale Made · Leads → Lead Novo
const DC_STAGE_FECHOU = '119ab9a8-13e5-4729-accc-e06c3ccf330a';      // Sale Made · Leads → Fechou
const DC_STAGE_A_ENVIAR = '85194b90-2371-4860-a3f6-b43558008140';    // Sale Made · Pedidos → A Enviar
async function _dcApiSend(env, method, path, body) {
  const key = await _readConfig(env, 'dc_api_key');
  if (!key) return null;
  try {
    const r = await fetch('https://api.g1.datacrazy.io/api/v1' + path, { method, headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: body != null ? JSON.stringify(body) : undefined });
    let j = null; try { const t = await r.text(); j = t ? JSON.parse(t) : null; } catch (_) {}
    return { ok: r.ok, status: r.status, data: j };
  } catch (_) { return null; }
}
function _dcId(r) { const d = r && r.data; return (d && (d.id || (d.data && d.data.id))) || null; }
let _dcCrmOk = false;
async function _dcCrmTable(env) {
  if (_dcCrmOk) return;
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS dc_crm (phone TEXT PRIMARY KEY, lead_id TEXT, lead_deal TEXT, order_deal TEXT, updated_at INTEGER)').run(); _dcCrmOk = true; } catch (_) {}
}
// Acha (no cache local) ou cria o lead no Datacrazy pelo telefone. Retorna leadId.
async function _dcCrmLead(env, phone, name) {
  await _dcCrmTable(env);
  const row = await env.DB.prepare('SELECT lead_id FROM dc_crm WHERE phone=?').bind(phone).first();
  if (row && row.lead_id) return row.lead_id;
  const id = _dcId(await _dcApiSend(env, 'POST', '/leads', { name: name || ('+' + phone), phone: '+' + phone }));
  if (!id) return null;
  await env.DB.prepare("INSERT INTO dc_crm (phone, lead_id, updated_at) VALUES (?,?,strftime('%s','now')) ON CONFLICT(phone) DO UPDATE SET lead_id=excluded.lead_id, updated_at=excluded.updated_at").bind(phone, id).run();
  return id;
}
// Adiciona uma tag ao lead SEM apagar as existentes (o PATCH substitui o array, então mescla).
async function _dcCrmAddTag(env, leadId, tagId) {
  const r = await _dcApiGet(env, '/leads/' + leadId);
  const l = (r && (r.data || r)) || {};
  const cur = (l.tags || []).map(t => t.id).filter(Boolean);
  if (cur.includes(tagId)) return;
  await _dcApiSend(env, 'PATCH', '/leads/' + leadId, { tags: [...new Set([...cur, tagId])].map(id => ({ id })) });
}
// Lead novo entrou → garante negócio em "Lead Novo" + tag (uma vez por telefone).
async function _dcCrmLeadIn(env, phone, name) {
  try {
    await _dcCrmTable(env);
    const row = await env.DB.prepare('SELECT lead_deal FROM dc_crm WHERE phone=?').bind(phone).first();
    if (row && row.lead_deal) return;   // já tem negócio de lead
    const leadId = await _dcCrmLead(env, phone, name);
    if (!leadId) return;
    const bid = _dcId(await _dcApiSend(env, 'POST', '/businesses', { leadId, stageId: DC_STAGE_LEAD_NOVO }));
    await _dcCrmAddTag(env, leadId, DC_TAG_LEAD_NOVO);
    if (bid) await env.DB.prepare("UPDATE dc_crm SET lead_deal=?, updated_at=strftime('%s','now') WHERE phone=?").bind(bid, phone).run();
  } catch (_) {}
}
// Venda → tag "Comprou" + cria o pedido em "A Enviar" + move o negócio de lead pra "Fechou".
async function _dcCrmSale(env, phone, name, valor, orderId) {
  try {
    await _dcCrmTable(env);
    const row = await env.DB.prepare('SELECT lead_id, lead_deal, order_deal FROM dc_crm WHERE phone=?').bind(phone).first();
    if (row && row.order_deal) return;   // pedido já criado (evita duplicar)
    const leadId = (row && row.lead_id) || await _dcCrmLead(env, phone, name);
    if (!leadId) return;
    await _dcCrmAddTag(env, leadId, DC_TAG_COMPROU);
    const bid = _dcId(await _dcApiSend(env, 'POST', '/businesses', { leadId, stageId: DC_STAGE_A_ENVIAR, externalId: String(orderId || ('venda-' + phone)) }));
    if (row && row.lead_deal) { try { await _dcApiSend(env, 'POST', '/businesses/actions/move', { ids: [row.lead_deal], destinationStageId: DC_STAGE_FECHOU }); } catch (_) {} }
    await env.DB.prepare("INSERT INTO dc_crm (phone, lead_id, order_deal, updated_at) VALUES (?,?,?,strftime('%s','now')) ON CONFLICT(phone) DO UPDATE SET order_deal=excluded.order_deal, lead_id=excluded.lead_id, updated_at=excluded.updated_at").bind(phone, leadId, bid || 'created').run();
  } catch (_) {}
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
  const _wppSeen = Number(body?.wppSeen) || 0;   // 1 = WhatsApp AUTENTICADO (injetor manda isAuthenticated)
  try {
    await env.DB.prepare(
      `INSERT INTO sc_heartbeat (self_number, at_id, instance, wpp_seen, last_seen, meta) VALUES (?,?,?,?,?,?)
       ON CONFLICT(self_number) DO UPDATE SET at_id=excluded.at_id, instance=excluded.instance, wpp_seen=excluded.wpp_seen, last_seen=excluded.last_seen, meta=excluded.meta`
    ).bind(selfNumber, owner?.at_id || null, owner?.instance || null, _wppSeen, now,
           JSON.stringify(body?.meta || {}).slice(0, 1000)).run();
  } catch (_) {}
  // Mantém wa_conn vivo pela presença do Sale Chat (número logado). SÓ marca vivo quando AUTENTICADO
  // (_wppSeen): número deslogado que ainda bate heartbeat (WhatsApp Web quebrou o isAuthenticated) não
  // pode marcar "conectado" e receber lead. Sem _wppSeen a linha não é renovada e expira em 180s.
  if (owner && owner.instance && _wppSeen) {
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
// Cache curto da lista de instâncias. Existe pra dash poder perguntar de poucos em poucos segundos
// (queda de número aparecendo rápido) sem transformar isso em ida à VPS a cada pergunta.
// NUNCA cacheia resposta ruim (null): se a Evolution falhar, a próxima pergunta tenta de novo.
let _evoCache = null, _evoCacheAt = 0;
async function _evoInstancesCached(env, ttlMs = 4000) {
  if (_evoCache && (Date.now() - _evoCacheAt) < ttlMs) return _evoCache;
  const r = await _evoInstances(env);
  if (r) { _evoCache = r; _evoCacheAt = Date.now(); }
  return r;
}
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
// Recorta uma lista de instancias pelo que o usuario pode ver. null = sem corte (diretor).
const _filtraInst = (lista, ids) => (ids === null ? lista : (lista || []).filter((x) => _instEhDe(x && x.name, ids)));
// Filtra a lista de conexao pelo mundo de quem pediu. null = sem corte.
const _connDoMundo = (lista, ids) => (ids === null ? lista : (lista || []).filter((x) => {
  const inst = String((x && x.instance) || '');
  // Instancia nomeada ax_<id>_... ou o Sale Chat, que usa sc_<numero> e nao carrega o id do dono.
  // Sem dono resolvido, so diretor ve (fail-closed).
  return _instEhDe(inst, ids);
}));
async function handleWAConn(req, env) {
  const u = await authUser(req, env);
  // ESTA ROTA ENTREGAVA 19 CONEXOES COM O TELEFONE REAL DOS NOSSOS CHIPS (25/08/2026), e a tela de
  // Pressels faz poll nela de 8 em 8 segundos. O corte e por instancia do mundo de quem pediu.
  const _idsConn = u ? await _idsQuePossoVer(env, u) : [];
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
    const hb = await env.DB.prepare("SELECT self_number, instance FROM sc_heartbeat WHERE last_seen > strftime('%s','now')-180 AND wpp_seen=1").all();
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
  // Número da API OFICIAL (Datacrazy/coexistência) está SEMPRE vivo do lado da Meta — não depende de
  // Sale Chat/Evolution. Entra como 'cloud' pra dash mostrar verde (senão aparece "WhatsApp parado" à toa).
  let apiConns = [];
  try {
    const api = await env.DB.prepare("SELECT at_id, display_phone FROM wa_api_numbers WHERE verified=1 AND at_id IS NOT NULL AND (quality IS NULL OR quality<>'RED')").all();
    // Chave POR NÚMERO (ax_<at>_<8 dígitos>), não por vendedor. Com a chave só do vendedor, quem tem
    // DOIS números oficiais (o caso do Guilherme e do Murilo) via os dois colapsarem numa linha só:
    // sobrava um número no mapa e o outro aparecia "API desconectada" pra sempre.
    apiConns = (api.results || []).filter(a => a.at_id && a.display_phone)
      .map(a => ({ instance: 'ax_' + a.at_id + '_' + String(a.display_phone).replace(/\D/g, '').slice(-8), state: 'cloud', number: String(a.display_phone) }));
  } catch (_) {}
  // Cloud API SOBRESCREVE o que já estiver na lista, não cede a vez. O número oficial vive do lado da
  // Meta e não "cai" como WhatsApp Web; quem mandava aqui era uma linha VELHA da Evolution com
  // state 'close' (e até com o número de outro vendedor), que escondia a entrada da API e pintava os
  // 4 números oficiais de vermelho na tela de roleta.
  const withApi = (list) => {
    const byInst = {};
    (list || []).forEach(c => { byInst[c.instance] = c; });
    apiConns.forEach(a => { byInst[a.instance] = a; });
    return Object.values(byInst);
  };
  // Estado REAL + número conectado direto da Evolution; grava no wa_conn (pra roleta usar também).
  // Com a captura 100% no Sale Chat a Evolution sai de cena: não consulta, não grava e não mostra
  // conexão fantasma dela na tela. O Baileys é o maior risco de ban, então nada aqui pode dar a
  // impressão de que ele ainda faz parte da operação.
  // A fonte de captura ('sc' x 'evo') decide QUEM computa lead/venda, NÃO o que a tela de conexão
  // mostra. Desde que a roleta passou a conectar número por número por QR na Evolution, esconder as
  // instâncias dela fazia número REALMENTE conectado aparecer vermelho na roleta (o Bruno conectava,
  // dava certo no servidor, e a dash dizia que não). Aqui a tela mostra a realidade, sempre.
  const _src = await _waCaptureSource(env);
  try {
    // A dash pergunta isso de poucos em poucos segundos (pra queda de número aparecer rápido).
    // Sem cache, cada pergunta viraria uma ida à VPS + uma escrita no D1 por instância — com a dash
    // aberta em várias abas isso vira martelo. O cache curto segura o custo sem atrasar a detecção,
    // e as escritas só acontecem quando os dados são NOVOS (cache frio).
    const _fresco = !(_evoCache && (Date.now() - _evoCacheAt) < 4000);
    const live = await _evoInstancesCached(env);
    if (live && live.length) {
      if (_fresco) for (const it of live) {
        try {
          await env.DB.prepare(
            `INSERT INTO wa_conn (instance, state, number, updated_at) VALUES (?, ?, ?, strftime('%s','now'))
             ON CONFLICT(instance) DO UPDATE SET state=excluded.state, number=excluded.number, updated_at=excluded.updated_at`
          ).bind(it.name, String(it.state), it.number || '').run();
        } catch (_) {}
      }
      return json({ ok: true, sat, conn: _connDoMundo(withApi(mergeSc(live.map(it => ({ instance: it.name, state: it.state, number: it.number })))), _idsConn) });
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
    // Reserva (Evolution fora do ar): mostra o último estado conhecido. Só 'sc' (Sale Chat),
    // 'open' (Evolution por QR) e 'cloud' (API oficial) contam como conexão viva.
    .filter(r => ['sc', 'open', 'cloud'].includes(String(r.state)))
    .map(r => ((nowS - Number(r.updated_at || 0)) > 180) ? { ...r, state: 'close' } : r);
  // `semDono` e diagnostico da casa (numero sem atendente resolvido): nao vai pro mundo do afiliado.
  return json({ ok: true, sat, semDono: (_idsConn === null ? semDono : []), conn: _connDoMundo(withApi(mergeSc(limpos)), _idsConn) });
}

// ─── Sale Chat (soundboard) ──────────────────────────────────
// GET /api/salechat → config do Sale Chat (mensagens de texto + funis/sequencias)
// que o Diretor edita na dash (fica em DB.salechat, salvo pelo sync normal).
// Publico de proposito: sao roteiros de venda, nao dado sensivel; o injetor
// (Node) e a extensao puxam isso pra montar o painel dentro do WhatsApp.
async function handleSaleChatGet(req, env) {
  // ESTA ROTA ENTREGAVA O NOSSO FUNIL INTEIRO (25/08/2026). Eu tinha podado o Sale Chat do
  // /api/state e dado o assunto por resolvido; a varredura por rota mostrou que este endpoint
  // dedicado continuava servindo o modelo da casa - 12 mensagens, 15 sequencias e 34 audios, que e
  // exatamente o que o Bruno mandou NAO dar pra eles.
  // Ele nao e publico: e o mesmo caminho que os bots usam, entao o gate e por mundo, nao 403 seco.
  {
    const _u = await authUser(req, env);
    if (_u && (noMundoAfiliado(_u) || afiliadoSemVinculo(_u))) {
      return json({ ok: true, perfil: 'vendedores', messages: [], media: [], sequences: [], triggers: [] });
    }
  }
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
    // O TOKEN DE CAPTURA SAIU DAQUI (18/08/2026, auditoria pre-producao). Esta rota é PÚBLICA — os
    // bots leem o modelo sem login — e ela devolvia o token junto. Com ele, qualquer um na internet
    // injetava venda falsa (comissão pra vendedor + CompletePayment no pixel, envenenando a
    // otimização da campanha) e batimento falso de número (a roleta mandaria lead de verdade pra um
    // número que não está rodando nada, e o lead sumia).
    // Quem já tem o Sale Chat instalado guardou o token na instalação; pra reconfigurar, ele sai em
    // /api/salechat/health, que é só do diretor.
  });
}
// POST /api/salechat/media (Diretor) → sobe um arquivo pro R2. Body = bytes crus,
// Content-Type = mime do arquivo. Devolve a key; a dash guarda a metadata em DB.salechat.
async function handleSaleChatMediaUpload(req, env) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  // qualquer usuário autenticado pode subir mídia (diretor pro modelo; vendedor pro material dele). Delete segue só-diretor.
  if (!env.MEDIA) return err('Armazenamento (R2) não configurado', 503);
  const mime = req.headers.get('content-type') || 'application/octet-stream';
  const buf = await req.arrayBuffer();
  if (!buf || buf.byteLength === 0) return err('Arquivo vazio', 400);
  if (buf.byteLength > 60 * 1024 * 1024) return err('Arquivo grande demais (máx 60MB)', 413);
  // Extensão pelo SUBTIPO real do áudio (não forçar .ogg em tudo — quebrava mp4/aac do Safari,
  // que a Meta aceita). Só cai em 'ogg' quando é áudio sem subtipo reconhecido.
  const ext = /audio\/ogg/i.test(mime) ? 'ogg'
    : /audio\/(mp4|m4a|aac)/i.test(mime) ? 'm4a'
      : /audio\/(mpeg|mp3)/i.test(mime) ? 'mp3'
        : /audio\/webm/i.test(mime) ? 'webm'
          : /audio\/amr/i.test(mime) ? 'amr'
            : mime.indexOf('audio') >= 0 ? 'ogg'
              : mime.indexOf('video') >= 0 ? 'mp4'
                : mime.indexOf('png') >= 0 ? 'png'
                  : (mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0) ? 'jpg'
                    : mime.indexOf('pdf') >= 0 ? 'pdf' : 'bin';
  const key = 'm/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
  try { await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } }); }
  catch (e) { return err('Falha ao salvar no R2: ' + (e.message || ''), 502); }
  return json({ ok: true, key, mime, size: buf.byteLength });
}
// GET /api/salechat/media/<key> → serve a mídia do R2 (público; o injetor puxa por aqui)
// ── COMPROVANTE DO PEDIDO (imagem, video ou audio) ───────────────────────────
//
// A tela de Cadastro de Pedidos EXIGE comprovante pra venda na entrega, e o arquivo nunca era
// guardado: o front chamava dispatchToFive(), que e um stub e so escrevia no console do navegador.
// O vendedor anexava, cadastrava, e depois nao achava o arquivo em lugar nenhum - do lado dele
// parecia que o upload nao funcionava. E o modal do pedido no Kanban lia lead.comprovante_url, um
// campo que NINGUEM gravava, entao mostrava "Nenhum comprovante anexado" pra sempre.
//
// Aqui o arquivo vai pro R2 (mesmo bucket da midia do Sale Chat) e a resposta devolve a URL, que o
// front guarda no lead. O arquivo NAO entra no estado: o blob tem teto de 1 MB e um video estouraria
// tudo, derrubando qualquer gravacao da dash.
// TETO DO COMPROVANTE. Subiu de 25 MB pra 95 MB em 19/08/2026: o Guilherme fechou uma venda, o
// comprovante tinha 56 MB e o PEDIDO NAO FOI CADASTRADO - o erro barrava o cadastro inteiro, nao so
// o anexo. Video de celular gravado em 4K passa fácil dos 25 MB.
// 95 e o maximo com folga: o teto de corpo de requisicao do Cloudflare e 100 MB e NAO sobe com o
// plano Workers Paid (ele muda CPU e invocacoes, nao o tamanho do corpo). Acima de 100 MB a
// requisicao morre ANTES de chegar no nosso codigo, entao nao adianta subir mais este numero.
const COMPROVANTE_MAX = 95 * 1024 * 1024;
const COMPROVANTE_MAX_MB = Math.round(COMPROVANTE_MAX / 1048576);
async function handleComprovanteUpload(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!env.MEDIA) return err('Armazenamento de arquivo não configurado', 503);
  const qs = new URL(req.url).searchParams;
  const mime = String(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^(image|audio|video)\//.test(mime)) return err('Só imagem, áudio ou vídeo (recebi "' + (mime || 'nada') + '")');
  // MEDE PELO CABECALHO E NAO CARREGA O ARQUIVO NA MEMORIA. Antes era arrayBuffer() antes de qualquer
  // conferencia: um video de 90 MB era lido inteiro pra RAM do isolate (que tem 128 MB) so pra ser
  // recusado na linha seguinte. Agora recusa pelo content-length, antes de ler um byte, e o corpo vai
  // DIRETO pro R2 em fluxo. So cai no buffer quando o navegador nao manda o tamanho.
  const declarado = Number(req.headers.get('content-length') || 0);
  if (declarado > COMPROVANTE_MAX) {
    return err('Arquivo muito grande (' + Math.round(declarado / 1048576) + ' MB). O limite é ' + COMPROVANTE_MAX_MB + ' MB.');
  }
  // extensao pelo nome que o front mandou; se nao vier, deduz do mime. Serve pra download e pro
  // handleSaleChatMediaGet acertar o content-type do audio.
  const nome = String(qs.get('nome') || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  const extNome = (nome.match(/\.([a-zA-Z0-9]{2,5})$/) || [])[1];
  const ext = (extNome || (mime.split('/')[1] || 'bin')).toLowerCase();
  const lead = String(qs.get('lead') || 'sem').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'sem';
  const key = 'comprovante/' + lead + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  let tam = declarado;
  try {
    if (declarado > 0) {
      await env.MEDIA.put(key, req.body, { httpMetadata: { contentType: mime } });
    } else {
      // sem content-length: nao da pra confiar no tamanho, entao le e confere antes de gravar
      const buf = await req.arrayBuffer();
      if (!buf || !buf.byteLength) return err('Arquivo vazio');
      if (buf.byteLength > COMPROVANTE_MAX) return err('Arquivo muito grande (' + Math.round(buf.byteLength / 1048576) + ' MB). O limite é ' + COMPROVANTE_MAX_MB + ' MB.');
      tam = buf.byteLength;
      await env.MEDIA.put(key, buf, { httpMetadata: { contentType: mime } });
    }
  } catch (e) {
    return err('Não deu pra guardar o arquivo: ' + String((e && e.message) || e), 502);
  }
  if (!tam) return err('Arquivo vazio');
  const origem = new URL(req.url).origin;
  return json({ ok: true, url: origem + '/api/arquivo/' + encodeURIComponent(key), key, mime, tam });
}

async function handleSaleChatMediaGet(req, env, key) {
  if (!env.MEDIA) return err('R2 não configurado', 503);
  // O BACKUP DO ESTADO MORA NO MESMO BUCKET DA MIDIA, e esta rota e publica de proposito (o <img> e
  // o <audio> do painel nao mandam cabecalho de autorizacao, e a Meta busca a midia do funil por
  // link cru). Sem esta linha, quem adivinhasse a chave baixava a empresa inteira sem login:
  // conferido em 18/08/2026, 270 KB com CPF do cliente, folha salarial nominal, 7 cartoes do
  // ContaSimples e os 42 chips. A chave e previsivel (backups/state-<ts>-v<versao>.json).
  // Backup nao e midia: nao sai por aqui, ponto.
  if (String(key || '').startsWith(BACKUP_PREFIX) || String(key || '').startsWith('backups/')) return err('Mídia não encontrada', 404);
  try {
    const obj = await env.MEDIA.get(key);
    if (!obj) return err('Mídia não encontrada', 404);
    let ct = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
    // Nota de voz (ondinhas) só quando o content-type DECLARA opus. Declaramos codecs=opus APENAS quando
    // o áudio guardado É ogg (ct audio/ogg, ou legado sem type mas com key .ogg). NUNCA forçar em mp4/aac/webm
    // (a key .ogg antiga era chumbada em TODO áudio): isso destruía o mp4/AAC do Safari, que a Meta aceitaria.
    if (/^audio\/ogg/i.test(ct) || ((!ct || /octet-stream/i.test(ct)) && /\.ogg$/i.test(String(key || '')))) ct = 'audio/ogg; codecs=opus';
    return new Response(obj.body, { headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=86400',
      'content-type': ct,
    } });
  } catch (e) { return err('Erro ao ler mídia: ' + (e.message || ''), 502); }
}
// DELETE /api/salechat/media/<key> (Diretor)
// APAGAR ARQUIVO E IRREVERSIVEL, entao ele so sai se ninguem estiver usando.
//
// Antes esta rota apagava do R2 direto, sem olhar nada. O caminho perigoso e trocar o arquivo de um
// audio: a tela apaga o antigo NA HORA, mas o PUBLICADO (que o bot e os vendedores usam) continua
// apontando pro arquivo velho ate o Bruno clicar em "Salvar e publicar" - e se ele fechar a tela no
// meio, ou nunca publicar, o funil publicado fica apontando pra um arquivo que nao existe mais. Nao
// da pra desfazer: o R2 aqui nao tem versao anterior. Conferido em 18/08/2026: a copia particular do
// Guilherme ja tem 11 audios nessa situacao (o modelo publicado, esse sim, esta inteiro).
//
// Arquivo orfao acumulando no R2 custa centavos. Audio de venda perdido custa venda.
async function handleSaleChatMediaDelete(req, env, key) {
  const u = await authUser(req, env); if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Apenas Diretor', 403);
  const alvo = String(key || '');
  if (!alvo) return err('key obrigatória');
  try {
    const data = await _getDashData(env, 0);   // sem cache: a decisao e sobre o estado de AGORA
    const perfis = [data.salechat, data.salechatPub, data.salechatCob, data.salechatCobPub];
    for (const m of [data.scVend, data.scVendPub]) {
      if (m && typeof m === 'object') for (const k of Object.keys(m)) perfis.push(m[k]);
    }
    const usada = perfis.some((sc) => sc && Array.isArray(sc.media) && sc.media.some((x) => x && String(x.key || '') === alvo));
    if (usada) return json({ ok: false, em_uso: true, error: 'Esse arquivo ainda está em uso no Sale Chat. Tire ele da lista primeiro; o arquivo antigo fica guardado.' }, 409);
  } catch (_) { return err('Não deu pra conferir se o arquivo está em uso; não apaguei.', 503); }
  if (env.MEDIA) { try { await env.MEDIA.delete(alvo); } catch (_) {} }
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
  // LEVA A JANELA DE 24H JUNTO DA LISTA (19/08/2026). A tela so sabia da janela DENTRO da conversa
  // aberta, entao lead esperando resposta era invisivel na lista: em 19/08 dois leads perderam a
  // janela sem ninguem responder e outros tres estavam a menos de 40min de perder. `ult_in` = ultima
  // mensagem QUE O LEAD mandou (e dela que conta as 24h da Meta); `ult_out` = ultima resposta NOSSA
  // que nao falhou. Se ult_out < ult_in, a bola esta com a gente.
  // Um LEFT JOIN sobre um GROUP BY unico, nao subconsulta por linha: sao ate 300 conversas por
  // requisicao e o inbox faz poll.
  let sql = `SELECT c.phone, c.instance, c.name, c.last_text, c.last_ts, c.last_dir, c.unread, c.assigned_to, c.crm_stage,
                    m.ult_in, m.ult_out
             FROM wa_chats c
             LEFT JOIN (SELECT phone,
                               MAX(CASE WHEN direction='in' THEN ts END) ult_in,
                               MAX(CASE WHEN direction='out' AND status IS NULL THEN ts END) ult_out
                        FROM wa_messages GROUP BY phone) m ON m.phone = c.phone`;
  const where = [], binds = [];
  if (inst) { where.push('c.instance = ?'); binds.push(inst); }
  if (assigned) { where.push('c.assigned_to = ?'); binds.push(assigned); }
  if (q) { where.push('(c.name LIKE ? OR c.phone LIKE ?)'); binds.push('%' + q + '%', '%' + q.replace(/\D/g, '') + '%'); }
  // Escopo por vendedor: quem não é diretor só vê as próprias conversas (a instância dele).
  // Compara por PREFIXO: com a instância por número (ax_<at>_<8díg>) a igualdade exata deixava o
  // vendedor com o Atendimento VAZIO. substr em vez de LIKE porque '_' é curinga no LIKE.
  // O MUNDO DO AFILIADO VEM PRIMEIRO, ANTES DO COBRADOR (25/08/2026). O cobrador que o AFILIADO
  // cadastra tem role 'cobrador': testando cobrador antes, ele caia no ramo "ve tudo que fechou
  // venda" e enxergava as NOSSAS conversas. Medido: 56 conversas nossas na conta dele.
  // Dentro do mundo dele o cobrador continua com a regra de cobrador (ve o que fechou), mas so
  // entre as conversas do mundo dele - as duas condicoes se somam com AND.
  if (noMundoAfiliado(u) || afiliadoSemVinculo(u)) {
    if (_ehCobrador(u)) where.push("c.crm_stage = 'fechou'");
    // Afiliado: as conversas dele E as da equipe dele. Sem nenhuma pessoa no mundo (nem ele), a
    // condicao vira 1=0 e a lista sai vazia - nunca "sem filtro", que entregaria o inbox inteiro.
    const ids = await _idsDoMundoAfiliado(env, aflDe(u));
    if (!ids.length) where.push('1=0');
    else {
      const ors = [], bs = [];
      for (const id of ids) { const pf = 'ax_' + id + '_'; ors.push('(c.instance = ? OR substr(c.instance,1,?) = ?)'); bs.push('ax_' + id, pf.length, pf); }
      where.push('(' + ors.join(' OR ') + ')');
      binds.push(...bs);
    }
  } else if (_ehCobrador(u)) {
    // Cobrador: todas as conversas, de qualquer vendedor, MAS so as que ja fecharam venda.
    where.push("c.crm_stage = 'fechou'");
  } else if (!isDirector(u)) { const _pf = 'ax_' + u.id + '_'; where.push('(c.instance = ? OR substr(c.instance,1,?) = ?)'); binds.push('ax_' + u.id, _pf.length, _pf); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY c.last_ts DESC LIMIT 300';
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  // Saude do sync do Datacrazy junto da lista: e o unico jeito de a tela avisar sem ninguem clicar
  // em nada (o cron roda a cada 2min e o botao de recarregar quase nunca e apertado). Cache de 30s
  // por isolate pra nao somar 1 leitura de D1 a cada poll de 6s de cada atendente.
  let dcSaude = null;
  try {
    if (!_dcSaudeCache || (Date.now() - _dcSaudeCacheT) > 30000) {
      _dcSaudeCache = JSON.parse((await _readConfig(env, 'dc_sync_health')) || 'null');
      _dcSaudeCacheT = Date.now();
    }
    dcSaude = _dcSaudeCache;
  } catch (_) { dcSaude = null; }
  return json({ ok: true, chats: rows.results || [], dc: dcSaude });
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
  const chat = await env.DB.prepare('SELECT phone, instance, name, unread, assigned_to, crm_stage FROM wa_chats WHERE phone = ?').bind(phone).first();
  // Cobrador: abre QUALQUER conversa que ja fechou venda (e o historico do cliente que ele vai
  // cobrar), e so essas. Ler nao e falar: o envio segue barrado no _podeFalarNaConversa.
  if (_ehCobrador(u)) {
    if (!chat || String(chat.crm_stage || '') !== 'fechou') return err('Sem acesso a essa conversa', 403);
  } else if (!isDirector(u)) {
    // prefixo: cobre ax_<at>, ax_<at>_b (legado) e ax_<at>_<8díg> (instância por número)
    const _meu = (i) => { const x = String(i || ''); return x === 'ax_' + u.id || x.indexOf('ax_' + u.id + '_') === 0; };
    if (!chat || !_meu(chat.instance)) return err('Sem acesso a essa conversa', 403);
  }
  const rows = await env.DB.prepare(
    'SELECT msg_id, phone, instance, direction, type, body, push_name, ts, media_url, status, err FROM wa_messages WHERE phone = ? ORDER BY ts ASC LIMIT ?'
  ).bind(phone, limit).all();
  return json({ ok: true, phone, chat: chat || null, messages: rows.results || [] });
}
// GET /api/wa/lead?phone= → o lead (CRM) da conversa, pra o painel Leads do Atendimento.
// Escopado: o vendedor só lê o lead de conversa da própria instância (não expõe o CRM inteiro,
// diferente do /api/state). Casa pelo telefone (últimos 8 dígitos, campo l.wa), igual à AXION.
async function handleWALead(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _waEnsureTables(env);
  const url = new URL(req.url);
  const phone = String(url.searchParams.get('phone') || '').replace(/\D/g, '');
  if (!phone) return err('phone obrigatório');
  // Escopo por vendedor: quem não é diretor só vê lead de conversa da própria instância.
  if (_ehCobrador(u)) {
    const chat = await env.DB.prepare('SELECT crm_stage FROM wa_chats WHERE phone = ?').bind(phone).first();
    if (!chat || String(chat.crm_stage || '') !== 'fechou') return err('Sem acesso a esse lead', 403);
  } else if (!isDirector(u)) {
    const chat = await env.DB.prepare('SELECT instance FROM wa_chats WHERE phone = ?').bind(phone).first();
    // prefixo: cobre ax_<at>, ax_<at>_b (legado) e ax_<at>_<8díg> (instância por número)
    const _meu = (i) => { const x = String(i || ''); return x === 'ax_' + u.id || x.indexOf('ax_' + u.id + '_') === 0; };
    if (!chat || !_meu(chat.instance)) return err('Sem acesso a esse lead', 403);
  }
  const tail = phone.slice(-8);
  if (tail.length < 8) return json({ ok: true, lead: null });
  const row = await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let st = {}; try { st = JSON.parse(row?.data || '{}'); } catch (_) {}
  const lead = (Array.isArray(st.leads) ? st.leads : []).find((l) => {
    const p = String((l && (l.wa || l.tel || l.telefone || l.phone)) || '').replace(/\D/g, '');
    return p && p.endsWith(tail);
  }) || null;
  return json({ ok: true, lead });
}
// POST /api/wa/chat/read { phone } → zera o não-lido
async function handleWAChatRead(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _waEnsureTables(env);
  const body = await req.json().catch(() => null);
  const phone = String(body?.phone || '').replace(/\D/g, '');
  if (!phone) return err('phone obrigatório');
  // ERA O UNICO DA FAMILIA SEM CHECAGEM (auditoria 24/08/2026): zerava o "nao lido" de qualquer
  // conversa nossa so mandando o telefone. Marcar como lido some com o aviso na tela de quem
  // deveria responder, entao vale a mesma regra de dono das irmas.
  const _idsR = await _idsQuePossoVer(env, u);
  if (_idsR !== null && !_ehCobrador(u)) {
    const c = await env.DB.prepare('SELECT instance FROM wa_chats WHERE phone = ?').bind(phone).first();
    if (c && !_instEhDe(c.instance, _idsR)) return err('Conversa não encontrada', 404);
  }
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
  // QUEM PODE PASSAR CONVERSA PRA QUEM. Sem isto, qualquer login (ate um afiliado) reatribuia
  // QUALQUER conversa pra QUALQUER pessoa - e como a venda segue o dono da conversa, era comissao
  // trocando de mao com uma chamada. Diretor remaneja a vontade; o resto so puxa pra si mesmo, e so
  // conversa que esta sem dono ou que ja e dele.
  if (!isDirector(u)) {
    if (assigned !== null && assigned !== String(u.id)) return err('Voce so pode puxar a conversa pra voce', 403);
    const dono = await env.DB.prepare('SELECT assigned_to, instance FROM wa_chats WHERE phone = ?').bind(phone).first();
    const atual = dono && dono.assigned_to != null ? String(dono.assigned_to) : '';
    if (atual && atual !== String(u.id)) return err('Essa conversa e de outro vendedor. So um diretor passa.', 403);
    // CONVERSA SEM DONO TAMBEM TEM MUNDO (auditoria 24/08/2026). A checagem acima so barra conversa
    // que JA tem dono, entao uma conversa NOSSA ainda sem assigned_to podia ser carimbada pelo
    // afiliado. E como a venda segue o dono da conversa, isso e comissao trocando de mao.
    const _idsA = await _idsQuePossoVer(env, u);
    if (_idsA !== null && dono && !_instEhDe(dono.instance, _idsA)) return err('Conversa não encontrada', 404);
  }
  await env.DB.prepare("UPDATE wa_chats SET assigned_to = ?, updated_at = strftime('%s','now') WHERE phone = ?").bind(assigned, phone).run();
  return json({ ok: true });
}
// POST /api/wa/chat/stage { phone, stage } → move a conversa numa etapa do CRM do Atendimento
// (novo/atendimento/sem_resposta/qualificado/fechou/perdido). Pipeline SEPARADA da do pedido (lead.col).
async function handleWAChatStage(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  await _waEnsureTables(env);
  const body = await req.json().catch(() => null);
  const phone = String(body?.phone || '').replace(/\D/g, '');
  const stage = String(body?.stage || '').trim().slice(0, 40);
  if (!phone || !stage) return err('phone e stage obrigatórios');
  if (!['novo', 'atendimento', 'sem_resposta', 'qualificado', 'fechou', 'perdido', 'lixo'].includes(stage)) return err('stage inválido');
  // Cobrador NAO move card: a area dele e de leitura. Mover mudaria a etapa do vendedor.
  if (_ehCobrador(u)) return err('Sua área do inbox é só pra consulta', 403);
  // Escopo por vendedor: só mexe em conversa da própria instância.
  if (!isDirector(u)) {
    const chat = await env.DB.prepare('SELECT instance FROM wa_chats WHERE phone = ?').bind(phone).first();
    // prefixo: cobre ax_<at>, ax_<at>_b (legado) e ax_<at>_<8díg> (instância por número)
    const _meu = (i) => { const x = String(i || ''); return x === 'ax_' + u.id || x.indexOf('ax_' + u.id + '_') === 0; };
    if (!chat || !_meu(chat.instance)) return err('Sem acesso a essa conversa', 403);
  }
  await env.DB.prepare("UPDATE wa_chats SET crm_stage = ?, updated_at = strftime('%s','now') WHERE phone = ?").bind(stage, phone).run();
  return json({ ok: true });
}
// Detecta VENDA pela mensagem de confirmação ("Pedido Concluído", enviada após o
// cliente aceitar o termo). Registra em wa_sales (dedupe por telefone/24h).
async function _waDetectSale(env, instance, data) {
  const m = data?.message || {};
  const text = m.conversation || m.extendedTextMessage?.text || '';
  // ASSINATURA DA VENDA. Era so 'pedido conclu': no primeiro dia real (18/08/2026) o vendedor
  // escreveu "Pedido finalizado" e NENHUMA venda foi capturada - wa_sales ficou vazia o dia inteiro,
  // e com ela sumiu o verde na lista de leads, a aba Pedidos e a ponte CPF/atendente.
  // Agora aceita as formas que eles usam de verdade. Continua exigindo a palavra "pedido" junto, pra
  // um "finalizado" solto no meio da conversa nao virar venda.
  const _txtV = text.toLowerCase();
  if (!text || !/pedido\s*(conclu|finaliz|fechad|confirmad)/i.test(_txtV)) return { sale: false };
  const key = data?.key || {};
  const jid = String(key.remoteJid || '');
  if (!jid || jid.indexOf('@g.us') >= 0) return { sale: false };   // ignora grupo (senão "Pedido Conclu" em grupo vira venda fantasma)
  // QUEM FECHA A VENDA SOMOS NOS. O texto "Pedido Concluído" e a mensagem que o VENDEDOR manda; se
  // o proprio lead escrever isso (reenviando a confirmacao, mandando print em texto, ou so
  // repetindo), virava venda registrada + evento de compra no pixel do TikTok - dinheiro de
  // anuncio otimizando pra mentira. No caminho Cloud a chamada sempre vem com fromMe:true; no
  // webhook da Evolution ela chega pros DOIS lados, entao a guarda mora aqui, que e o lugar unico.
  if (key.fromMe === false) return { sale: false };
  const phone = String(key.remoteJidAlt || key.remoteJid || '').split('@')[0].replace(/\D/g, '');
  if (!phone) return { sale: false };
  // Auto CRM: venda fechada -> card do Atendimento vai automatico pra "Fechou" (override de qualquer etapa).
  try { await env.DB.prepare("UPDATE wa_chats SET crm_stage='fechou', updated_at=strftime('%s','now') WHERE phone=?").bind(phone).run(); } catch (_) {}
  const name = ((text.match(/Nome:\s*([^\n📍📲⭐]+)/i) || [])[1] || '').trim();
  const valM = text.match(/Valor do Pedido:\s*R\$?\s*([\d.,]+)/i);
  const value = valM ? Number(valM[1].replace(/\./g, '').replace(',', '.')) : 0;
  // MESMA MENSAGEM, DUAS CHAVES. Os dois caminhos do Datacrazy passam o MESMO id da mensagem em
  // formatos diferentes: o _dcSyncInbox manda 'dc:<id>' e o _dcPoll manda '<id>' cru. Como o unico
  // dedup era o indice UNIQUE em msg_id, e as duas strings sao diferentes, a venda entrava DUAS
  // vezes - e, pior que a linha repetida na tela, o event_id do pixel tambem saia diferente e o
  // TikTok recebeu DOIS CompletePayment da mesma venda (caso real: Geraldo Domingos, R$ 497, em
  // 22/08/2026, os dois com code=0). Este mesmo erro ja tinha acontecido no wa_messages em 19/08 e
  // foi corrigido la; aqui tinha ficado. Agora a chave e sempre a CRUA.
  const msgId = String((key && key.id) || '').replace(/^dc:/, '') || null;
  // Ponte de atribuição: grava CPF → atendente (a instância = quem atendeu).
  const cpfDetect = extractCpf(text);
  if (cpfDetect) await saveCpfAttrib(env, cpfDetect, instance, name, phone);
  // ID do evento pro pixel: usa o msg_id; se vier nulo, sintetiza um estável por PEDIDO (telefone+valor+cpf/nome)
  // pra dois pedidos distintos não colidirem no CompletePayment (antes msgId nulo mandava '' pra todos).
  const evId = msgId || ('wa:' + phone + ':' + Math.round((value || 0) * 100) + ':' + (cpfDetect || name || 'x'));
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
    // Compara pelos últimos 8 dígitos (robusto a DDI/9º dígito): o mesmo número às vezes chega formatado diferente.
    const last8 = phone.slice(-8);
    const rec = await env.DB.prepare("SELECT value, raw FROM wa_sales WHERE substr(phone,-8)=? AND ts > strftime('%s','now')-86400 LIMIT 10").bind(last8).all();
    const dupe = (rec.results || []).some(r => {
      const sameVal = Math.abs((Number(r.value) || 0) - (Number(value) || 0)) < 0.01;
      // Só é o MESMO pedido se o CPF bater E existir: sem CPF não dá pra afirmar que é repetição
      // (antes '' === '' fazia dois pedidos distintos sem CPF virarem duplicata e sumirem da dash).
      const sameCpf = !!cpfDetect && (extractCpf(String(r.raw || '')) || '') === cpfDetect;
      return sameVal && sameCpf;
    });
    if (dupe) return { sale: true, value }; // mesmo pedido já registrado nas últimas 24h
    // idempotente por msg_id: reentrega do mesmo webhook não conta 2x nem dispara 2 CompletePayment
    // TRES REDES, nesta ordem, porque cada uma pega um tipo de repetido:
    //  1) a linha antiga que ficou gravada com 'dc:' (antes da normalizacao acima);
    //  2) MESMO CLIENTE, MESMO VALOR, EM 10 MINUTOS - e o pedido do Bruno de "controle de
    //     duplicata" aqui tambem: cobre o caso em que os ids sao completamente diferentes (a
    //     mensagem chegou por dois caminhos, ou o vendedor mandou a confirmacao duas vezes);
    //  3) o indice UNIQUE em msg_id, que continua sendo a trava final.
    // Venda de verdade repetida pro mesmo cliente no mesmo valor em menos de 10 min nao existe na
    // operacao: e sempre o mesmo pedido chegando de novo.
    try {
      const jaTem = await env.DB.prepare(
        "SELECT 1 FROM wa_sales WHERE (msg_id IS NOT NULL AND msg_id = ?) OR (phone = ? AND ABS(COALESCE(value,0) - ?) < 0.01 AND ts > strftime('%s','now') - 600) LIMIT 1"
      ).bind('dc:' + String(msgId || ''), phone, value || 0).first();
      if (jaTem) {
        console.log('WA_VENDA_REPETIDA fone=' + phone + ' valor=' + value + ' msg=' + String(msgId || ''));
        return { sale: false, dup: true, value };
      }
    } catch (_) { /* se a checagem falhar, o INSERT OR IGNORE abaixo ainda segura o repetido por id */ }
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO wa_sales (phone, instance, name, value, ts, msg_id, raw) VALUES (?,?,?,?,strftime('%s','now'),?,?)").bind(phone, instance, name, value, msgId, String(text||'').slice(0,2000)).run();
    if (ins.meta && ins.meta.changes === 0) return { sale: true, value }; // msg_id repetido → já registrada
    await _ttFireSale(env, phone, (value > 0 ? value : null), evId, instance);   // venda pro pixel (event_id estável por pedido; sem value 0 se o parse falhar)
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
    tries INTEGER DEFAULT 0, ts INTEGER, next_try INTEGER, stage TEXT)`).run();
  // `stage` guarda a ETAPA do funil (pressel/whatsapp/contato/venda), que NÃO muda quando o Bruno
  // troca o nome do evento. Quem pergunta "o TikTok aceitou a venda?" pergunta pela etapa.
  // ALTER separado pro banco que já existia antes desta coluna (erro = já tem, e tudo bem).
  try { await env.DB.prepare('ALTER TABLE tt_events ADD COLUMN stage TEXT').run(); } catch (_) {}
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
    // O User-Agent NAO E ENFEITE. Em 18/08/2026, com a campanha rodando, 4 dos 10 leads do dia
    // levaram 403 do TikTok com o corpo VAZIO - nao e erro de token nem de pixel: o mesmo evento,
    // byte por byte, foi aceito (code 0) quando saiu de um computador comum. A diferenca era o
    // cabecalho: o fetch do Worker vai sem User-Agent, e a protecao deles trata isso como robo.
    // Sem esses eventos a campanha otimiza no escuro, que e pior do que nao ter pixel.
    const r = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
      method: 'POST',
      headers: {
        'Access-Token': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'SellWave/1.0 (+https://sellwave.com.br)',
      },
      body: JSON.stringify(body),
    });
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
    // O UPDATE do conflito passou a gravar `event` e `stage` também. Antes só mexia em status/code:
    // se o Bruno trocasse o nome do evento, a linha antiga guardava o nome VELHO pra sempre, e o
    // cron reenviava com ele por dias.
    await env.DB.prepare(`INSERT INTO tt_events (event_id,event,phone,value,ttclid,pid,instance,status,code,msg,tries,ts,next_try,stage)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'),?,?)
      ON CONFLICT(event_id) DO UPDATE SET status=excluded.status, code=excluded.code, msg=excluded.msg,
        event=excluded.event, stage=excluded.stage,
        tries=tt_events.tries+1, next_try=excluded.next_try`)
      .bind(evId, event, String(phoneDigits), (opts.value == null ? null : Number(opts.value)), String(opts.ttclid || ''),
            String(opts.pid || ''), String(opts.instance || ''), ok ? 'ok' : 'erro', code, msg, ok ? 0 : 1,
            ok ? 0 : (Math.floor(Date.now() / 1000) + 300), String(opts.stage || '')).run();
  } catch (_) {}
  return { ok, code, msg };
}
// Reenvia o que falhou (roda no cron). Mesmo event_id -> o TikTok deduplica, entao nao conta 2x.
// LEAD QUE NAO GEROU EVENTO NENHUM NO PIXEL.
//
// O _ttRetryFailed so enxerga linha com status='erro'. Quando a batida do cron morria ANTES de
// chamar o pixel (era o que acontecia enquanto o cron estourava o limite de CPU), o lead era gravado
// e o evento nunca chegava a existir - nao havia linha nenhuma, entao nada reenviava. Aconteceu com
// 2 dos 7 leads de 18/08/2026, com verba rodando: conversao que o TikTok nunca soube que existiu.
//
// Esta varredura pega lead das ultimas 24h sem linha em tt_events e manda o evento com a HORA REAL
// do lead (nao a de agora, senao o TikTok atribui a janela errada). O event_id e o mesmo que o
// caminho normal usaria ('lead_<telefone>'), entao se o evento tiver saido por outro caminho o
// TikTok deduplica e nao conta duas vezes.
// CONVERSAO QUE NAO ENTRA TEM QUE APARECER PRA ALGUEM.
//
// O 403 do TikTok e passageiro e quase sempre o reenvio resolve, mas quando nao resolve o prejuizo e
// invisivel: a campanha otimiza sem saber que a venda aconteceu, e nada na dash diz isso. Passando de
// 8 tentativas, o diretor recebe notificacao com a conta. Uma notificacao por dia, no maximo, pra nao
// virar barulho que ninguem le.
// VENDA QUE NAO VIROU EVENTO NO PIXEL.
//
// O CompletePayment so era disparado por DOIS caminhos: a frase "Pedido Concluido" que o vendedor
// manda no WhatsApp (_waDetectSale) e o postback da Payt. Quem CADASTRA o pedido na dash - que e como
// o vendedor fecha venda na entrega, o padrao aqui - nao disparava nada. A tela contava a venda e o
// TikTok nunca ficava sabendo. Conferido em 18/08/2026: a venda do dia estava no painel e tt_events
// nao tinha um unico CompletePayment.
//
// Isso e pior do que perder o evento do lead: CompletePayment e o evento que ensina a campanha a
// achar comprador. Sem ele o TikTok otimiza pra quem conversa, nao pra quem compra.
//
// Esta varredura fecha o buraco por fora, sem depender de qual tela criou a venda: pega pedido dos
// ultimos 3 dias que ainda nao tem evento de venda e dispara. O event_id e o do PEDIDO (venda_<id>),
// entao reenviar nao conta duas vezes; e antes de disparar confere se aquele telefone ja teve evento
// de venda por qualquer outro caminho, pra nao contar a mesma venda duas vezes com ids diferentes.
async function _ttVarrerVendasSemEvento(env) {
  try {
    await _ttEnsureTable(env);
    const data = await _getDashData(env);
    const leads = Array.isArray(data && data.leads) ? data.leads : [];
    if (!leads.length) return;
    const desde = Math.floor(Date.now() / 1000) - 3 * 86400;
    let n = 0;
    for (const l of leads) {
      if (n >= 10) break;
      const val = Number((l && (l.valor_neg || l.vl)) || 0);
      if (!(val > 0)) continue;
      // SO VENDA PAGA VIRA CompletePayment. Antes bastava o lead ter valor: uma VENDA FUTURA de
      // R$ 497, nao paga e nem despachada, ensinou o TikTok que houve compra hoje. Numa operacao COD
      // isso e a distorcao mais cara que existe - o cliente so paga na entrega, dias depois, e nao ha
      // como desfazer um evento ja enviado. Se ele nunca pagar, a campanha otimizou pra um comprador
      // que nao existiu.
      // DISPARA NO CADASTRO DO PEDIDO, nao no pagamento. Decisao do Bruno em 19/08/2026, e faz
      // sentido pro modelo dele: no COD o dinheiro so entra na entrega, dias depois, e a janela de
      // atribuicao do TikTok (7 dias) ja teria fechado - a campanha aprenderia com quase nada.
      // Cadastrar o pedido E o momento em que o vendedor fechou a venda.
      // (Isto substitui de proposito a trava que exigia 'pago'; se for reverter, falar com ele.)
      const quando = Number(l && l.ts) > 0 ? Number(l.ts) : Math.floor((Number(l && l.id) || 0) / 1000);
      if (!(quando >= desde)) continue;
      const fone = String((l && l.wa) || '').replace(/\D/g, '');
      if (fone.length < 10) continue;
      // Ja existe evento de venda pra este telefone? (qualquer caminho, qualquer id)
      let ja = null;
      try { ja = await env.DB.prepare("SELECT 1 FROM tt_events WHERE substr(phone,-8)=? AND stage='venda' AND ts > ? LIMIT 1").bind(fone.slice(-8), desde).first(); } catch (_) {}
      if (ja) continue;
      // CASA PELOS ULTIMOS 8 DIGITOS, e usa o telefone do RASTREIO, nao o do pedido.
      // O pedido guarda o que o vendedor digitou ("(73) 9905-7792"); o rastreio guarda o numero que
      // chegou no WhatsApp, com DDI ("5573999057792"). Comparar inteiro nunca casa - foi por isso
      // que a primeira versao desta varredura nao disparou nada. E o telefone que vai pro TikTok
      // tem que ser o do rastreio: e o hash dele que o TikTok cruza com o clique.
      let lead = null;
      try { lead = await env.DB.prepare('SELECT phone, pid, inst FROM wa_lead WHERE substr(phone,-8)=? ORDER BY ts DESC LIMIT 1').bind(fone.slice(-8)).first(); } catch (_) {}
      // SEM RASTREIO TAMBEM DISPARA. O Bruno garantiu: "nenhuma venda vem por fora, sempre vem de um
      // lead da pressel". Quando nao existe wa_lead e porque a captura falhou no meio (o cliente
      // fechou por ligacao, o inbox engasgou), nao porque o cliente caiu do ceu. Descartar a venda
      // por falta da nossa propria linha era punir a campanha pelo nosso furo.
      // O _ttFireSale sabe se virar: com lead, usa o ttclid exato; sem lead, deduz a PRESSEL pelo
      // trafego dominante daquele vendedor (nivel pressel, nao chute de clique) e ainda grava um
      // wa_lead minimo com src='deduzido' - que e o que faz a venda passar a contar pro vendedor no
      // painel de leads.
      let fonePixel = lead && lead.phone ? String(lead.phone) : '';
      let instPixel = lead && lead.inst ? String(lead.inst) : '';
      if (!fonePixel) {
        // Sem lead: acha o numero REAL (com DDI) pelo historico de conversa, que e o que o TikTok
        // cruza. O pedido guarda o que o vendedor digitou, sem DDI.
        try {
          const c = await env.DB.prepare("SELECT phone, instance FROM wa_messages WHERE substr(phone,-8)=? ORDER BY ts DESC LIMIT 1").bind(fone.slice(-8)).first();
          if (c && c.phone) { fonePixel = String(c.phone); instPixel = instPixel || String(c.instance || ''); }
        } catch (_) {}
      }
      if (!fonePixel) fonePixel = fone.length <= 11 ? ('55' + fone) : fone;   // ultimo recurso
      if (!instPixel && l && l.at) instPixel = 'ax_' + String(l.at);          // pra deduzir a pressel do vendedor
      n++;
      await _ttFireSale(env, fonePixel, val, 'venda_' + String((l && l.id) || fone), instPixel);
    }
    if (n) console.log('[tt] varredura de venda: ' + n + ' disparada(s)');
  } catch (e) { console.error('[tt] varredura de venda falhou: ' + String((e && e.message) || e)); }
}

async function _ttAvisarPresos(env) {
  try {
    // AVISA SO O QUE NAO VAI SE RESOLVER SOZINHO (23/08/2026). O corte era `tries >= 8`, e com a
    // auto-cura do _ttRetryFailed isso vira alarme falso: o 403 do TikTok e passageiro, o evento
    // acumula tentativa e volta a passar minutos depois. Avisar nesse meio-tempo e incomodar o Bruno
    // com um problema que ja esta se consertando - e ele pediu exatamente pra parar de ser incomodado
    // com isso. Agora so entra no aviso quem falha HA MAIS DE 6 HORAS: passou disso, a insistencia ja
    // teve dezenas de chances e ai sim e problema de verdade.
    const r = await env.DB.prepare("SELECT COUNT(*) n FROM tt_events WHERE status='erro' AND tries >= 8 AND ts < strftime('%s','now')-21600").first();
    const n = Number((r && r.n) || 0);
    if (!n) {
      // ZERO PRESOS: FECHA O AVISO ANTIGO. Ate 24/08/2026 esta funcao so sabia ABRIR alarme, nunca
      // fechar: os eventos foram recuperados no dia 23 e o sino continuou dizendo "3 conversoes nao
      // chegaram no TikTok", com o Bruno perguntando por que ninguem tinha arrumado - sendo que ja
      // estava arrumado. Alarme que nao se apaga sozinho vira ruido e, pior, ensina a ignorar o sino.
      // Troca os avisos abertos por UM aviso de encerramento, pra ele saber que terminou bem.
      try {
        const row0 = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
        if (!row0) return;
        let d0 = {}; try { d0 = JSON.parse(row0.data || '{}'); } catch (_) { return; }
        const antes = Array.isArray(d0.notifs) ? d0.notifs : [];
        const abertos = antes.filter((x) => x && String(x.id || '').startsWith('ttpresos-') && !String(x.id || '').startsWith('ttpresos-ok-'));
        if (!abertos.length) return;                       // nada aberto: nao mexe no blob a toa
        d0.notifs = antes.filter((x) => !(x && String(x.id || '').startsWith('ttpresos-')));
        d0.notifs.unshift({
          id: 'ttpresos-ok-' + Date.now(), type: 'geral', to: 'owner',
          title: 'Conversões do TikTok em dia',
          description: 'O que estava preso foi enviado e aceito. Nenhuma conversão pendente agora.',
          ts: Math.floor(Date.now() / 1000), unread: true, link: '/pressels/leads',
        });
        d0.notifs = d0.notifs.slice(0, 100);
        await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
          .bind(JSON.stringify(d0), (row0.version || 0) + 1, Math.floor(Date.now() / 1000), 'ttpresos:ok', row0.version).run();
        // Libera a marca do dia: se travar de novo depois, o aviso pode voltar hoje mesmo.
        try { await _writeConfig(env, 'ttpresos:' + _brDay(), ''); } catch (_) {}
      } catch (_) {}
      return;
    }
    const marca = 'ttpresos:' + _brDay();
    if (await _readConfig(env, marca)) return;   // ja avisou hoje
    await _writeConfig(env, marca, String(n));
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    let data = {}; try { data = JSON.parse(row?.data || '{}'); } catch (_) { return; }
    if (!Array.isArray(data.notifs)) data.notifs = [];
    data.notifs.unshift({
      id: 'ttpresos-' + Date.now(), type: 'alerta', to: 'owner',
      // Singular e plural escritos por extenso. "conversão(ões) não chegaram" e a cara de aviso
      // gerado por sistema, e o Bruno pediu pra tirar. Aviso que ele le todo dia tem que estar em
      // portugues de gente.
      title: n === 1 ? 'Uma conversão não chegou no TikTok' : (n + ' conversões não chegaram no TikTok'),
      description: n === 1
        ? 'O TikTok recusou o envio mesmo depois de várias tentativas. A campanha está otimizando sem esse evento.'
        : 'O TikTok recusou o envio mesmo depois de várias tentativas. A campanha está otimizando sem esses eventos.',
      ts: Math.floor(Date.now() / 1000), unread: true, link: '/pressels/leads',
    });
    data.notifs = data.notifs.slice(0, 100);
    await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), (row.version || 0) + 1, Math.floor(Date.now() / 1000), 'ttpresos', row.version).run();
  } catch (e) { console.error('[tt] aviso de presos falhou: ' + String((e && e.message) || e)); }
}
async function _ttVarrerLeadsSemEvento(env) {
  try {
    await _ttEnsureTable(env);
    const rows = await env.DB.prepare(
      `SELECT l.phone, l.pid, l.ttclid, l.inst, l.ts FROM wa_lead l
       WHERE l.ts > strftime('%s','now')-86400
         AND NOT EXISTS (SELECT 1 FROM tt_events e WHERE e.event_id = 'lead_' || l.phone)
       ORDER BY l.ts DESC LIMIT 10`).all();
    for (const l of (rows.results || [])) {
      const { pixel, token, ev } = await _ttPixelToken(env, l.pid || '', l.inst || '');
      if (!pixel || !token || !ev.ev_lead) continue;
      await _ttSend(env, pixel, token, ev.ev_lead, l.phone, {
        ttclid: l.ttclid || '', eventId: 'lead_' + l.phone, pid: l.pid, instance: l.inst,
        eventTime: l.ts, stage: 'contato',
      });
    }
  } catch (e) { console.error('[tt] varredura de lead sem evento falhou: ' + String((e && e.message) || e)); }
}

async function _ttRetryFailed(env) {
  try {
    await _ttEnsureTable(env);
    // AUTO-CURA: SUCESSO RECENTE DESTRAVA QUEM FICOU PRESO (23/08/2026).
    //
    // O 403 do TikTok e passageiro e do lado deles - o MESMO evento, byte por byte, e aceito minutos
    // depois (ja provado em 18/08 e de novo hoje: peguei dois presos com 60 tentativas e os dois
    // voltaram code=0 na hora). O problema nunca foi o evento; era o freio: `tries < 60` matava a
    // linha PRA SEMPRE, e o corte de 24h enterrava o resto. Resultado de hoje: 110 conversoes presas,
    // 107 delas do proprio dia, com a campanha otimizando sem elas.
    //
    // A regra agora e: se ALGUM evento saiu com code=0 na ultima hora, o caminho esta funcionando
    // (token, pixel, User-Agent, rede) - entao nao existe motivo pra manter ninguem parado. Zera o
    // contador e a espera de quem ficou pra tras e deixa a fila andar de novo. E o proprio sucesso
    // que destrava; nao depende de ninguem perceber e mexer na mao.
    // Idempotente: o TikTok deduplica pelo event_id, entao reenviar o mesmo evento nao conta 2x.
    try {
      const vivo = await env.DB.prepare(
        "SELECT 1 FROM tt_events WHERE status='ok' AND code='0' AND ts > strftime('%s','now')-3600 LIMIT 1").first();
      if (vivo) {
        await env.DB.prepare(
          "UPDATE tt_events SET tries=0, next_try=0 WHERE status='erro' AND tries >= 20 AND ts > strftime('%s','now')-259200").run();
      }
    } catch (_) {}
    const rows = await env.DB.prepare(
      // NUNCA DESISTIR DE CONVERSAO DO DIA. O corte era por numero de tentativas (6, depois 12, depois
      // 20) e foi ele que perdeu evento em 18/08/2026: seis leads bateram as 20 tentativas durante uma
      // janela em que o TikTok estava recusando (HTTP 403 com corpo vazio, do lado deles - o mesmo
      // evento e aceito minutos depois), e a partir dai ficaram fora da fila PRA SEMPRE. Provado: zerei
      // o contador e os seis entraram de primeira, code=0.
      // Agora o corte e por IDADE: enquanto o evento for do ultimo dia, ele continua tentando. Passou
      // de 24h, a janela de atribuicao do TikTok ja nao ajuda muito e o _ttAvisarPresos ja avisou o
      // diretor. O teto de 20 fica so como freio de loop.
      `SELECT * FROM tt_events WHERE status='erro' AND ts > strftime('%s','now')-259200
         AND COALESCE(next_try,0) <= strftime('%s','now')
       ORDER BY ts ASC LIMIT 20`).all();
    for (const e of (rows.results || [])) {
      const { pixel, token, ev } = await _ttPixelToken(env, e.pid || '', e.instance || '');
      if (!pixel || !token) {   // ainda sem pixel: adia sem gastar tentativa
        try { await env.DB.prepare("UPDATE tt_events SET next_try=strftime('%s','now')+1800 WHERE event_id=?").bind(e.event_id).run(); } catch (_) {}
        continue;
      }
      // Espera menor entre tentativas (teto de 15 min, nao de 1 hora): a recusa e passageira, entao
      // insistir cedo resolve; e o proprio TikTok deduplica pelo event_id, nao ha risco de contar 2x.
      // Espera entre tentativas do MESMO evento (teto 30min). O `tries` agora so espaca; ele nao
      // elimina mais ninguem - quem elimina e a idade (3 dias), e ate la a auto-cura acima reabre.
      const backoff = Math.min(1800, 120 * Math.pow(2, Math.min(Number(e.tries) || 0, 8)));
      // Reenvia com o nome que a pressel usa HOJE, não com o que estava gravado. Se o Bruno trocou
      // o evento justamente porque o antigo estava errado, a fila presa em erro continuaria saindo
      // com o nome velho por dias. A ETAPA é que manda; linha antiga (sem stage) mantém o nome dela.
      const chave = { pressel: 'ev_view', whatsapp: 'ev_click', contato: 'ev_lead', venda: 'ev_sale' }[String(e.stage || '')];
      const nome = (chave && ev[chave]) || e.event;
      const res = await _ttSend(env, pixel, token, nome, e.phone, {
        value: e.value, ttclid: e.ttclid || '', eventId: e.event_id, pid: e.pid, instance: e.instance,
        eventTime: e.ts,                      // hora REAL do evento (nao a do reenvio)
        stage: e.stage || '',
      });
      if (!res.ok) { try { await env.DB.prepare("UPDATE tt_events SET next_try=strftime('%s','now')+? WHERE event_id=?").bind(backoff, e.event_id).run(); } catch (_) {} }
    }
  } catch (_) {}
}
// Resolve pixel+token: 1) da pressel (pid) se tiver os dois; 2) da pressel do vendedor (ax_<at>); 3) global.
async function _ttPixelToken(env, pid, instance) {
  let pixel = '', token = '', ev = _evTodos(null);
  try {
    const data = await _getDashData(env);   // cacheado: era parseado por lead (1.3MB), estourava CPU no lote
    const pressels = Array.isArray(data.pressels) ? data.pressels : [];
    let p = pid ? pressels.find(x => String(x.id) === String(pid) && x.pixel_tt && x.pixel_tt_token) : null;
    // fallback pelo vendedor SÓ quando NÃO se sabe a pressel (pid vazio). Com o pid conhecido mas sem
    // pixel configurado, o evento tem que ir pro pixel GLOBAL, nunca pro de OUTRA pressel do vendedor
    // (senão o GT de uma BM via lead que não era dele e o da certa não via nada).
    if (!p && !pid && instance) {
      // fallback pelo vendedor: SÓ se ele estiver em UMA pressel com pixel (senão mandaria pro pixel/BM errado)
      const at = _atFromInst(instance);   // número backup (ax_<at>_b) cai no mesmo vendedor
      const cand = pressels.filter(x => x.pixel_tt && x.pixel_tt_token && (x.vendedores || []).some(v => String(v.at) === at && v.ativo !== false));
      if (cand.length === 1) p = cand[0];
    }
    if (p) {
      pixel = String(p.pixel_tt); token = String(p.pixel_tt_token); ev = _evTodos(p);
    }
  } catch (_) {}
  if (!pixel || !token) { pixel = await _readConfig(env, 'tt_pixel_id'); token = await _readConfig(env, 'tt_access_token'); }
  // `ev` sai junto do pixel porque vem da MESMA pressel: quem resolve "qual pixel" já resolveu
  // "quais eventos". Caindo no pixel global (sem pressel), valem os padrões.
  return { pixel, token, ev };
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
// `maxIdade` (segundos) só é passado por quem JÁ deduplica a mensagem por id — hoje, o pull do
// Datacrazy. Ele existe porque o pull não vê a mensagem na hora em que ela é enviada: em 17/08/2026
// a conversa mais nova da API tinha 97 minutos, e a guarda de 15min descartava TODAS, deixando
// wa_lead zerado com a campanha prestes a subir. Quem não passa nada continua com os 15min de
// sempre, que é o que protege do despejo de histórico quando um número reconecta.
async function _waLeadCapture(env, instance, phone, body, selfNum, msgType, msgTs, maxIdade) {
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
    const _teto = Number(maxIdade) > 0 ? Number(maxIdade) : 900;
    if (_ts > 0 && (Math.floor(Date.now() / 1000) - _ts) > _teto) return;
    if (!_leadTablesOk) {   // DDL uma vez por isolate (era causa do 1102 no lote de captura)
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS wa_lead (phone TEXT PRIMARY KEY, pid TEXT, ttclid TEXT, ts INTEGER)').run();
      // A identificacao da Meta acompanha o lead: e o que liga a VENDA (que acontece dias depois)
      // ao clique que a pagou. Sem isto, Purchase chega na Meta sem `fbc` e ela nao sabe de qual
      // anuncio veio - o gerenciador mostra venda "organica" e o ROAS da campanha fica falso.
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN fbc TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN fbp TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN inst TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}   // origem da atribuição: 'code' (exato) | 'fifo' (clique recente no mesmo número)
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN num TEXT').run(); }catch(_){}   // número (do atendente) que recebeu o lead — pra dividir por número na visão de Leads
      // Campanha que trouxe o lead (JSON com os utm_* e as macros do TikTok). Sem isso o gestor de
      // tráfego sabe QUANTO lead entrou e não sabe de QUAL anúncio: o ttclid identifica a pessoa,
      // não a campanha, e ele só descobriria abrindo o TikTok e cruzando na mão.
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN utm TEXT').run(); }catch(_){}
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS tt_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, inst TEXT, ttclid TEXT, pid TEXT, ts INTEGER, claimed INTEGER DEFAULT 0)').run();
      try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN code TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN num_key TEXT').run(); }catch(_){}   // número que recebeu o clique (últimos 8 dígitos)
      _leadTablesOk = true;
    }
    // O código precisa ser lido ANTES do `exists`, senão o caminho de upgrade nunca acontece.
    const codeM = String(body || '').match(/desconto[^A-Za-z0-9]{0,4}([A-Za-z0-9]{4,12})/i);
    const code = codeM ? codeM[1] : '';
    const exists = await env.DB.prepare('SELECT phone, pid, ttclid, src, inst, num FROM wa_lead WHERE phone=?').bind(phone).first();
    // ÚLTIMO CLIQUE MANDA (decisão do Bruno, 20/08/2026). Cada vendedor passou a rodar DOIS números,
    // então o mesmo lead pode clicar no anúncio de novo e cair num número diferente - inclusive de
    // outro vendedor. Quando isso acontece, o lead é DO NÚMERO NOVO: a conversa já migra sozinha
    // (wa_chats segue o último inbound) e a venda já sai carimbada pelo chip atual, mas o wa_lead
    // ficava preso no primeiro para sempre (INSERT OR IGNORE + a saída antecipada logo abaixo), e a
    // métrica continuava contando o contato pro vendedor que perdeu o lead.
    // MIGRAÇÃO = a mensagem chegou num número NOSSO diferente do que está gravado no lead.
    const _nk8 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : ''; };
    const _nkAgora = _nk8(selfNum) || ((String(instance || '').match(/_(\d{8})$/) || [])[1] || '');
    const _nkAntes = _nk8(exists && exists.num) || ((String((exists && exists.inst) || '').match(/_(\d{8})$/) || [])[1] || '');
    const migrou = !!(exists && _nkAgora && _nkAntes && _nkAgora !== _nkAntes);
    // UPGRADE: o lead pode ter nascido de um evento sem texto (ciphertext chega cifrado e o injetor
    // só manda uma vez). Nesse caso ele entrou por chute do FIFO, ou sem rastreio nenhum. Quando a
    // mensagem legível com o código aparece depois, ela CORRIGE a atribuição em vez de ser jogada
    // fora. Sem código novo não há o que melhorar, e quem já está em 'code' é exato: sai fora.
    // Na MIGRAÇÃO nada disso vale: número novo é lead novo, refaz a atribuição do zero.
    if (!migrou && exists && (exists.src === 'code' || !code)) return;
    // Migração entra pelo caminho de lead NOVO (isUpgrade=false) de propósito: assim os fallbacks
    // por número voltam a valer e o clique que trouxe ele de volta é reivindicado pro número certo.
    const isUpgrade = !!exists && !migrou;
    // 1) casa pelo CÓDIGO da mensagem (ex: Código de desconto "k2EGu"!) — atribuição EXATA.
    let ttclid = '', pid = '', src = '', utm = '';
    // Viajam junto com a atribuicao: quem descobriu de QUAL visita veio este lead ja sabe qual era
    // o clique da Meta daquela visita. Buscar isso depois, por telefone, nao teria como acertar.
    let fbc = '', fbp = '';
    if (code) {
      try {
        const cl = await env.DB.prepare("UPDATE tt_pending SET claimed=1 WHERE id=(SELECT id FROM tt_pending WHERE code=? AND (claimed IS NULL OR claimed=0) ORDER BY ts DESC LIMIT 1) RETURNING ttclid, pid, utm").bind(code).first();
        if (cl) { ttclid = cl.ttclid || ''; pid = cl.pid || ''; src = 'code'; utm = cl.utm || ''; fbc = cl.fbc || ''; fbp = cl.fbp || ''; }
      } catch (_) {}
      // 1b) O código É deste lead, mesmo que a linha já tenha sido reivindicada pelo FIFO de OUTRO
      // lead antes (o fifo é guloso e drena o pool de cliques do vendedor). Sem re-reivindicar, lê o
      // ttclid do clique DELE. Antes esses caíam em 'letra' sem ttclid e o TikTok não atribuía a venda
      // ao anúncio — era a maior fonte do descasamento que o gestor de tráfego via.
      if (!pid) {
        try {
          const cl2 = await env.DB.prepare("SELECT ttclid, pid, utm, fbc, fbp FROM tt_pending WHERE code=? ORDER BY ts DESC LIMIT 1").bind(code).first();
          if (cl2 && (cl2.ttclid || cl2.pid)) { ttclid = cl2.ttclid || ''; pid = cl2.pid || ''; src = 'code'; utm = cl2.utm || ''; fbc = cl2.fbc || ''; fbp = cl2.fbp || ''; }
        } catch (_) {}
      }
    }
    // 2) FALLBACK (sem código): casa com o clique recente NÃO reivindicado no MESMO número (janela 60min, o mais antigo).
    // Recupera o lead que apagou o código. Vale porque esses números só recebem tráfego de pressel.
    // Casa primeiro pelo NÚMERO que atendeu, não pelo slot. Trocar um número de principal↔
    // complementar muda a instância (ax_<at> ↔ ax_<at>_b) e os cliques ficavam órfãos no slot
    // antigo: o lead chegava e entrava "sem rastreio", sem pixel e sem saber de qual pressel veio.
    // No UPGRADE os fallbacks ficam DE FORA de propósito: o lead já tem uma atribuição por chute, e
    // deixar ele reivindicar outro clique roubaria a linha de um lead novo de verdade. No upgrade só
    // vale o que é exato: o código, ou a letra dele.
    // num_key = últimos 8 díg do número que atendeu. O Sale Chat informa em selfNum; na Evolution vem
    // vazio, então derivo da instância dedicada (ax_<at>_<8díg>) pra o casamento por número funcionar
    // mesmo quando o lead não traz o código no texto.
    let nk = String(selfNum || '').replace(/\D/g, '').slice(-8);
    if (!nk) { const _mnk = String(instance || '').match(/_(\d{8})$/); if (_mnk) nk = _mnk[1]; }
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
    // Lead que JA e de pressel e voltou por outro numero transfere mesmo sem casar clique novo: ele
    // ja foi rastreado uma vez, o que mudou foi com quem ele fala. Sem esta ressalva a transferencia
    // so acontecia quando o clique novo casasse, e o contato ficava no vendedor que perdeu o lead.
    if (!pid && !ttclid && !(migrou && exists && (exists.pid || exists.ttclid))) return;
    // Número que REALMENTE recebeu o lead. Prefere o que o Sale Chat informou (exato); só cai na
    // busca por instância quando não veio (Evolution). Derivar da instância carimbava o lead do
    // número complementar com o número do principal e escondia a divisão da roleta nas métricas.
    let num=String(selfNum||'').replace(/\D/g,'');
    if(!num){ try{ const cn=await env.DB.prepare('SELECT number FROM wa_conn WHERE instance=?').bind(instance).first(); num=(cn&&cn.number)||''; }catch(_){} }
    if (isUpgrade) {
      // Só melhora quando casou o clique EXATO pelo código (src='code'). Se só resolveu pela LETRA
      // (pid sem ttclid), NÃO rebaixa: o lead já tinha uma atribuição com ttclid (do fifo que o
      // criou), e sobrescrever com ttclid vazio apagava o click id — e a VENDA disparava sem ele.
      // Não mexe no ts (senão "renasce" e pula de dia) nem no inst (quem atendeu não muda por msg nova).
      if (src === 'code') {
        // Preserva o que já existia quando o novo vier vazio: um código que casou a PRESSEL (pid) mas
        // sem ttclid não pode apagar o ttclid que o fifo já tinha gravado (a venda dispararia sem click id).
        const newTt = ttclid || exists.ttclid || '';
        const newPid = pid || exists.pid || '';
        await env.DB.prepare("UPDATE wa_lead SET pid=?, ttclid=?, src='code' WHERE phone=?").bind(newPid, newTt, phone).run();
      }
    } else if (migrou) {
      // TRANSFERE o lead pro número/vendedor novo. pid/ttclid só trocam se o clique novo trouxe algo
      // (senão o rastreio do anúncio original se perderia à toa). O `ts` NÃO muda: é quando o lead
      // apareceu pela primeira vez, e mexer nele faria relatório de dia fechado mudar sozinho.
      await env.DB.prepare(
        "UPDATE wa_lead SET inst=?, num=?, pid=CASE WHEN ?<>'' THEN ? ELSE pid END, ttclid=CASE WHEN ?<>'' THEN ? ELSE ttclid END, src=CASE WHEN ?<>'' THEN ? ELSE src END WHERE phone=?"
      ).bind(instance, num, pid, pid, ttclid, ttclid, src, src, phone).run();
      console.log('WA_LEAD_MIGROU fone=' + phone + ' de=' + String((exists && exists.inst) || '') + ' para=' + String(instance) + ' src=' + String(src || exists.src || ''));
    } else {
      await env.DB.prepare("INSERT OR IGNORE INTO wa_lead (phone, pid, ttclid, inst, src, num, ts, utm, fbc, fbp) VALUES (?,?,?,?,?,?,strftime('%s','now'),?,?,?)").bind(phone, pid, ttclid, instance, src, num, utm, fbc, fbp).run();
    }
    // Dispara InitiateCheckout pra TODO lead que veio da pressel (tem pid), com ou sem ttclid. O
    // GT compara o nº de leads da dash com o do TikTok, e limitar a `ttclid` deixava ~40% de fora
    // (137 na dash x 77 com ttclid em 23/07). O _ttSend SEMPRE manda o telefone com hash (advanced
    // matching), então o TikTok consegue casar por telefone mesmo sem o click id. Lead orgânico de
    // verdade (sem pid) continua fora. No upgrade só dispara se ainda não tinha disparado.
    if ((ttclid || pid) && !(exists && (exists.ttclid || exists.pid))) {
      const { pixel, token, ev } = await _ttPixelToken(env, pid, instance);
      // O nome vem da pressel (padrão InitiateCheckout, que é o evento que o GT otimiza). Vazio =
      // o Bruno desligou esta etapa nas Configurações da pressel.
      if (ev.ev_lead) await _ttSend(env, pixel, token, ev.ev_lead, phone, { ttclid, eventId: 'lead_' + phone, pid, instance, stage: 'contato' });
      // META: `Lead` sai aqui, no contato REAL (a mensagem chegou). O `Contact` do navegador e
      // outra coisa - e a INTENCAO, disparada quando a pessoa toca no botao. Nomes diferentes de
      // proposito: sao dois fatos diferentes e nenhum conta o outro em dobro.
      const _fb = await _fbPixelToken(env, pid);
      if (_fb.pixel) await _fbSend(env, _fb.pixel, _fb.token, 'Lead', phone, { fbc, fbp, pid, eventId: 'lead_' + phone });
    }
  } catch (_) {}
}
// VENDA: usa a pressel/ttclid capturados do lead (wa_lead) e dispara pro pixel certo, com ttclid.
async function _ttFireSale(env, phone, value, eventId, instance) {
  let _fbcL = '', _fbpL = '';   // identificacao da Meta guardada no lead (ver wa_lead.fbc/fbp)
  try {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return;
    let ttclid = '', pid = '', hadLead = false;
    try { const l = await env.DB.prepare('SELECT pid, ttclid, fbc, fbp FROM wa_lead WHERE phone=?').bind(digits).first(); if (l) { hadLead = true; _fbcL = l.fbc || ''; _fbpL = l.fbp || ''; ttclid = l.ttclid || ''; pid = l.pid || ''; } } catch (_) {}
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
        const at = _atFromInst(instance);
        const dom = await env.DB.prepare(
          `SELECT p.pid, COUNT(*) n FROM tt_pending p
           JOIN wa_number_owner o ON substr(o.num_key,-8) = p.num_key
           WHERE o.at_id = ? AND p.ts > strftime('%s','now')-86400 AND p.pid IS NOT NULL AND p.pid<>''
           GROUP BY p.pid ORDER BY n DESC LIMIT 1`
        ).bind(at).first();
        if (dom && dom.pid) pid = String(dom.pid);
      } catch (_) {}
    }
    // Venda de cliente que fechou por LIGAÇÃO e nunca mandou mensagem (caso Nelcy/José): não existe
    // linha em wa_lead, então a venda saía "sem rastreio" na tela e não aparecia na aba Leads, dando
    // a impressão de que a atribuição falhou. Aqui, quando a pressel foi deduzida pelo tráfego
    // dominante (agregado, confiável no nível PRESSEL — não é palpite de clique), grava um lead
    // mínimo pra tela mostrar a pressel e a aba Leads bater com a de Pedidos. src='deduzido' e SEM
    // ttclid de propósito: o nível certo aqui é a pressel, não um clique específico.
    if (!hadLead && pid && instance) {
      try {
        const cn = await env.DB.prepare('SELECT number FROM wa_conn WHERE instance=?').bind(instance).first();
        const num = String((cn && cn.number) || '');
        await env.DB.prepare(
          "INSERT INTO wa_lead (phone, pid, ttclid, ts, inst, src, num) VALUES (?,?,'',strftime('%s','now'),?,'deduzido',?) ON CONFLICT(phone) DO NOTHING"
        ).bind(digits, pid, instance, num).run();
      } catch (_) {}
    }
    const { pixel, token, ev } = await _ttPixelToken(env, pid, instance);
    // `stage:'venda'` é o que a tela de pedidos consulta pra mostrar "o TikTok aceitou". Antes ela
    // procurava pelo NOME 'CompletePayment' num JOIN; com o nome configurável, o selo sumiria em
    // silêncio no dia em que o Bruno trocasse o evento. A etapa não muda, o nome sim.
    if (ev.ev_sale) await _ttSend(env, pixel, token, ev.ev_sale, digits, { value, ttclid, eventId, pid, instance, stage: 'venda' });
    // META: `Purchase` com o valor. So chega aqui em VENDA REAL - nao existe caminho que dispare
    // compra a partir de engajamento, que e o que estraga a otimizacao da campanha (e o motivo de
    // a Meta punir conta que reporta compra demais). O `fbc` vem do clique guardado no lead, entao
    // a venda de hoje ainda credita o anuncio que a trouxe dias atras.
    const _fbv = await _fbPixelToken(env, pid);
    if (_fbv.pixel) await _fbSend(env, _fbv.pixel, _fbv.token, 'Purchase', digits, { value, fbc: _fbcL, fbp: _fbpL, pid, eventId: 'venda_' + String(eventId || digits) });
  } catch (_) {}
}
// GET /api/wa/sales → vendas detectadas no WhatsApp (a dash mostra/usa)
async function handleWASales(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // ESTA ROTA NAO TINHA ESCOPO NENHUM (auditoria 24/08/2026) e devolvia as ultimas 1000 vendas da
  // operacao com o TEXTO CRU do pedido: nome, CPF, endereco e telefone do nosso cliente. O afiliado
  // abre isto so de entrar em Cadastro de Pedidos e no Atendimento.
  const _idsWS = await _idsQuePossoVer(env, u);
  // Cobrador NOSSO continua vendo tudo: a tela dele e justamente trabalhar o pedido dos outros.
  const _semCorte = (_idsWS === null) || (_ehCobrador(u) && !noMundoAfiliado(u) && !afiliadoSemVinculo(u));
  const _cutWS = _semCorte ? { cond: '', binds: [] } : _sqlInst('s.instance', _idsWS);
  // O corte entra como AND depois do where do periodo; sem where, vira o proprio WHERE.

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
    // Junta o filtro de periodo com o corte por mundo. Sem periodo, o corte vira o WHERE.
    const _where2 = _cutWS.cond ? (where ? (where + ' AND ' + _cutWS.cond) : ('WHERE ' + _cutWS.cond)) : where;
    const stmt = env.DB.prepare(`SELECT s.rowid AS id, s.phone, s.instance, s.name, s.value, s.ts, s.raw,
        l.pid AS pid, l.src AS src, l.ttclid AS ttclid,
        t.status AS tt_status, t.code AS tt_code, t.msg AS tt_msg, t.tries AS tt_tries
      FROM wa_sales s LEFT JOIN wa_lead l ON l.phone=s.phone
      LEFT JOIN tt_events t ON t.event_id=s.msg_id AND (t.stage='venda' OR (t.stage IS NULL AND t.event='CompletePayment'))
      ${_where2} ORDER BY s.ts DESC LIMIT 1000`);
    const _bindsFinais = binds.concat(_cutWS.binds);
    const rows = await (_bindsFinais.length ? stmt.bind(..._bindsFinais) : stmt).all();
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
// POST /api/wa/sale/add: registra um pedido a partir do texto "Pedido Concluído" e DISPARA o pixel
// (CompletePayment), deduplicado por telefone/24h. Serve pra quando a captura automática falha (ex:
// número banido finaliza a venda mas não é contabilizado). Diretor credita qualquer vendedor (body.at);
// vendedor só credita a si mesmo (u.id).
async function handleWASaleAdd(req, env) {
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  const body = await req.json().catch(() => null);
  if (!body || !body.raw || !String(body.raw).trim()) return err('Cole a mensagem do "Pedido Concluído"');
  const text = String(body.raw);
  // Diretor pode creditar qualquer vendedor (body.at); vendedor só credita a si mesmo.
  // AFILIADO credita alguem do MUNDO DELE (auditoria 24/08/2026): sem isto ele inseria venda na
  // NOSSA tabela wa_sales (que alimenta a pagina publica do gestor de trafego) e o disparo caia no
  // NOSSO pixel do TikTok. Fora do mundo dele, recusa.
  let at = isDirector(u) ? String(body.at || '').trim() : String(u.id);
  if (!isDirector(u) && noMundoAfiliado(u)) {
    const _idsV = await _idsDoMundoAfiliado(env, aflDe(u));
    const alvo = String(body.at || '').trim() || String(u.id);
    if (!_idsV.includes(alvo)) return err('Esse vendedor não é da sua equipe', 403);
    at = alvo;
  }
  if (afiliadoSemVinculo(u)) return err('Sem permissão', 403);
  const instance = at ? ('ax_' + at) : 'manual';
  const name = ((text.match(/Nome:\s*([^\n📍📲⭐]+)/i) || [])[1] || '').trim();
  const valM = text.match(/Valor do Pedido:\s*R\$?\s*([\d.,]+)/i);
  const value = valM ? Number(valM[1].replace(/\./g, '').replace(',', '.')) : 0;
  // telefone do cliente: a linha do 📲, senão o 1º celular com DDD que aparecer.
  // A classe NÃO pode conter \n (senão varre a próxima linha e gruda dígitos de outro campo).
  let phone = String(body.phone || '').replace(/\D/g, '');   // telefone da conversa, se veio (mais confiável que o parse do texto)
  if (!phone) { const phM = text.match(/📲[^\d\n]*([\d()\-. ]{10,})/); if (phM) phone = phM[1].replace(/\D/g, ''); }
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
    // Auto CRM: garante o card na coluna "Fechou" (o vendedor pode ter registrado direto, sem arrastar).
    try { if (phone) await env.DB.prepare("UPDATE wa_chats SET crm_stage='fechou', updated_at=strftime('%s','now') WHERE phone=?").bind(phone).run(); } catch (_) {}
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
// Instância → id do VENDEDOR. Tira o prefixo `ax_`, o sufixo `_b` (backup legado) E o `_<8dígitos>`
// da instância POR NÚMERO (ax_<at>_<8díg>, usada desde que cada número passou a conectar sozinho).
// Sem tirar o número, o lead/venda era atribuído a um vendedor inexistente (ex: "atendente_x_84384245")
// e SUMIA das métricas por vendedor, da comissão e do placar da roleta, em silêncio.
function _atFromInst(inst){ return String(inst||'').replace(/^ax_/,'').replace(/_b$/,'').replace(/_\d{8}$/,''); }
// Compara dois números por os últimos 8 dígitos (ignora DDI 55, 9º dígito, formatação)
function _lastDigitsEq(a,b){ const na=String(a||'').replace(/\D/g,'').slice(-8), nb=String(b||'').replace(/\D/g,'').slice(-8); return na.length>=8 && na===nb; }
// Número OK pra rotear lead? Conectado = é o ownerJid de ALGUMA instância 'open'.
// Checa por NÚMERO (não pelo slot da instância): assim, trocar o número de
// principal↔reserva (ou reconectar noutro slot) NÃO gera falso "não conectado".
// FAIL-OPEN: sem info nenhuma (Evolution fora / números desconhecidos) não bloqueia.
function _servConnOk(liveSet, inst, chipNum){
  if(!liveSet) return true;                             // sem info → fail-open
  if(!chipNum) return false;
  const base=String(inst).replace(/_\d{8}$/,'');        // ax_<at> (identidade do vendedor)
  const alvo=base+'_'+String(chipNum).replace(/\D/g,'').slice(-8);   // instância POR NÚMERO deste chip
  // 1) a instância própria deste número está aberta? confere o dono quando já resolvido.
  if(liveSet.has(alvo)){ const cn=liveSet.get(alvo); if(!cn || _lastDigitsEq(cn, chipNum)) return true; }
  // 1b) SALE CHAT: a chave é o próprio número (sc_<numero>), não o vendedor. Sem olhar essas chaves,
  // vendedor com 2+ números "Em uso" no Sale Chat colapsava todos em `ax_<at>` (uma linha só no
  // wa_conn, o último heartbeat vencia) e só UM número era aprovado por vez — os outros ficavam
  // fora da roleta e o front ainda os desligava sozinho. Aqui o número é a identidade, então casar
  // por número é exato e não cruza vendedor.
  for(const [k,cn] of liveSet.entries()){
    if(String(k).indexOf('sc_')!==0) continue;
    if(cn && _lastDigitsEq(cn, chipNum)) return true;
  }
  // 2) senão procura o número SÓ entre as instâncias DESTE vendedor.
  // Antes varria TODAS: um número aberto na instância de OUTRO vendedor aprovava este chip, e a
  // roleta mandava lead pra um número que quem atende é outra pessoa (a mensagem chega na instância
  // do outro e a venda é creditada pra ele). Caso real com o número do Murilo no slot do Guilherme.
  let anyKnown=false;
  for(const [k,cn] of liveSet.entries()){
    if(k!==base && !String(k).startsWith(base+'_')) continue;
    if(cn){ anyKnown=true; if(_lastDigitsEq(cn, chipNum)) return true; }
  }
  if(anyKnown) return false;                            // sabemos os números abertos deste vendedor e este não está
  return liveSet.has(inst);                             // nenhum número conhecido → fail-open pelo slot
}
// Resolve, por vendedor, o número PRINCIPAL (em uso, instância ax_<at>) e o BACKUP (chip bkp, instância ax_<at>_b).
// Os dois entram só se estiverem conectados AGORA (liveSet) COM O NÚMERO CERTO e não banidos/restritos.
// Quem está VIVO agora: instância aberta na Evolution, Sale Chat com heartbeat dos últimos 3min e
// número oficial da Cloud API (esse não cai como WhatsApp Web, entra direto).
// Saiu de dentro do handler da pressel pra a TELA DE DIAGNÓSTICO poder chamar a MESMA função: com
// duas cópias da regra, a tela diria "tudo certo" enquanto a roleta não entrega número nenhum.
async function _presselLiveSet(env){
  try{
    // A linha 'sc' do wa_conn NÃO expira sozinha: ela fica gravada com o último heartbeat. Sem checar
    // a idade, um número que caiu continuava "vivo" pra sempre e seguia recebendo lead (aconteceu de
    // verdade: o WhatsApp caiu e a roleta continuou mandando). Só vale 'sc' com sinal dos últimos 3min.
    // A validade vale pros DOIS estados. Antes só o 'sc' expirava, e uma linha 'open' velha da
    // Evolution ficava valendo pra sempre — bastava um registro antigo pra manter um número morto
    // recebendo lead eternamente. Com a operação 100% no Sale Chat, isso viraria um ralo silencioso.
    // UMA IDA SO PRAS TRES CONSULTAS (27/08/2026). Eram tres awaits em fila, ~3 idas ao D1 no
    // caminho do clique pago. O batch manda tudo junto e devolve na mesma ordem. Se o batch falhar
    // (banco antigo, tabela faltando), cai no jeito antigo, uma a uma, sem mudar o resultado.
    // FLAG, NAO O CONTEUDO. A primeira versao testava `_hb && _hb.results` pra decidir se caia no
    // jeito antigo - e `{ results: [] }` e TRUTHY, entao a queda NUNCA acontecia: se o batch
    // estourasse, sc_heartbeat e wa_api_numbers viravam vazio em silencio e os numeros da Cloud API
    // sumiam do liveSet. Como o Map nao fica vazio (o wa_conn ainda responde), o fail-open nao
    // salvava: a roleta simplesmente parava de entregar pra esses vendedores.
    let cs = { results: [] }, _hb = null, _api = null, _loteOk = false;
    try {
      const _lote = await env.DB.batch([
        env.DB.prepare("SELECT instance, number FROM wa_conn WHERE updated_at > strftime('%s','now')-180 AND state IN ('open','sc','cloud')"),
        env.DB.prepare("SELECT self_number FROM sc_heartbeat WHERE last_seen > strftime('%s','now')-180 AND wpp_seen=1"),
        env.DB.prepare("SELECT at_id, display_phone FROM wa_api_numbers WHERE verified=1 AND at_id IS NOT NULL AND (quality IS NULL OR quality<>'RED')"),
      ]);
      cs = _lote[0] || cs; _hb = _lote[1] || null; _api = _lote[2] || null; _loteOk = true;
    } catch (_) {
      try { cs = await env.DB.prepare("SELECT instance, number FROM wa_conn WHERE updated_at > strftime('%s','now')-180 AND state IN ('open','sc','cloud')").all(); } catch (_2) {}
    }
    const m=new Map((cs.results||[]).map(r=>[r.instance, r.number||'']));
    // heartbeat recente do Sale Chat também vale como número vivo (independe do wa_conn ter sido gravado)
    try{
      const hb = (_loteOk && _hb) ? _hb : await env.DB.prepare("SELECT self_number FROM sc_heartbeat WHERE last_seen > strftime('%s','now')-180 AND wpp_seen=1").all();
      (hb.results||[]).forEach(h=>{ if(h && h.self_number) m.set('sc_'+h.self_number, String(h.self_number)); });
    }catch(_){}
    // Número OFICIAL (Cloud API) está SEMPRE vivo do lado da Meta (não cai como WhatsApp Web).
    // Entra direto no liveSet pra roleta rotear pra ele, sem depender de heartbeat. Descarta qualidade RED.
    try{
      const api = (_loteOk && _api) ? _api : await env.DB.prepare("SELECT at_id, display_phone FROM wa_api_numbers WHERE verified=1 AND at_id IS NOT NULL AND (quality IS NULL OR quality<>'RED')").all();
      // Chave POR NÚMERO, igual à da tela de conexão: com a chave só do vendedor, o segundo número
      // oficial dele ficava fora da roleta (o Map guarda um valor por chave, e _servConnOk procura
      // exatamente ax_<at>_<8 dígitos>).
      (api.results||[]).forEach(a=>{ if(a && a.at_id && a.display_phone) m.set('ax_'+a.at_id+'_'+String(a.display_phone).replace(/\D/g,'').slice(-8), String(a.display_phone)); });
    }catch(_){}
    return m.size ? m : null;   // vazio = não sabemos nada → fail-open (null), NUNCA fail-closed
  }catch(_){ return null; }
}
// ids de status que significam "Em uso" (a dash grava ids customizados tipo st_xxxx
// com label "Em uso"; sem isso o worker não reconhecia o principal e tirava o
// vendedor da roleta enquanto a tela mostrava ele ligado).
function _emUsoIdsDe(data){
  const ids=new Set(['em_uso']);
  try{ (Array.isArray(data && data.wa_statuses)?data.wa_statuses:[]).forEach(s=>{
    const lbl=String((s&&(s.label||s.id))||'').toLowerCase().replace(/[_\s]+/g,' ').trim();
    if(lbl==='em uso' && s && s.id) ids.add(String(s.id));
  }); }catch(_){}
  return ids;
}
// Ids dos status que TIRAM o numero da roleta. Mesma historia do "Em uso": a dash guarda no chip o
// ID do status (st_mpafn8zm), e o nome ("Restrito") vive em data.wa_statuses. O guard comparava o id
// com a palavra 'restrito' e portanto NUNCA barrava ninguem: numero marcado Restrito ou Banido
// continuava elegivel pra receber lead. E o mesmo erro que ja tinha mandado lead pra numero parado.
function _foraIdsDe(data){
  const ids=new Set(['restrito','banido']);
  try{ (Array.isArray(data && data.wa_statuses)?data.wa_statuses:[]).forEach(s=>{
    const lbl=String((s&&(s.label||s.id))||'').toLowerCase().replace(/[_\s]+/g,' ').trim();
    if((lbl==='restrito' || lbl==='banido' || lbl==='sem whatspp' || lbl==='sem whatsapp') && s && s.id) ids.add(String(s.id));
  }); }catch(_){}
  return ids;
}
function _resolvePresselSellers(p, chips, liveSet, emUsoIds, foraIds){
  const out=[];
  const _fora = foraIds || new Set(['restrito','banido']);
  const okWa=(c)=>!_fora.has(String((c&&c.wa_st)||'').toLowerCase());
  // "Em uso" igual o frontend enxerga: flag em_uso (true OU 1 — o JSON grava dos dois
  // jeitos) ou um status cujo id/label é "Em uso" (a dash usa ids customizados tipo
  // st_xxxx, então comparar com a string 'em_uso' não basta).
  const isEmUso=(c)=> c.em_uso===true || c.em_uso===1 || (emUsoIds && emUsoIds.has(String(c.wa_st||''))) || String(c.wa_st||'')==='em_uso';
  // AUSENTE = LIGADO, igual a tela mostra. A dash lista TODO atendente que tem chip "Em uso" e,
  // sem entrada em p.vendedores, pinta o interruptor de VERDE ("Recebendo lead") — porque a regra
  // declarada é guardar os OFF, não os ON. Só que aqui o loop percorria apenas p.vendedores, então
  // quem não tinha entrada NUNCA recebia lead: o Diretor via tudo verde e o vendedor ficava o dia
  // zerado (foi o que aconteceu com a BM01 do Giovane, salva com vendedores:[]). Agora o backend
  // enxerga o mesmo conjunto que a tela: quem tem chip "Em uso" entra, e quem não deve receber é
  // desligado no interruptor (isso sim vira registro, em v.off).
  const _vs = Array.isArray(p.vendedores) ? p.vendedores.slice() : [];
  try {
    const jaTem = new Set(_vs.map(v => String(v && v.at)));
    for (const c of chips) {
      if (!c || !c.at || jaTem.has(String(c.at))) continue;
      // ccol_N e id de COLUNA da Contingencia (o "Nova coluna"), nao pessoa. Chip estacionado numa
      // coluna e marcado "Em uso" entrava na roleta por este caminho e ficava INVISIVEL na tela de
      // Pressels, que so desenha linha pra quem existe em /api/users - ou seja, recebia lead pago e
      // nao tinha interruptor pra desligar. Pior: o lead nascia com dono inexistente
      // (ax_ccol_4_91258028 esta gravado em wa_lead) e sumia da metrica e da comissao.
      if (/^ccol_/i.test(String(c.at))) continue;
      if (c.st === 'aquecimento' || c.st === 'banido') continue;
      if (!isEmUso(c) || !c.num || !okWa(c)) continue;
      jaTem.add(String(c.at));
      _vs.push({ at: c.at });   // sem off: todos os números "Em uso" dele entram ligados
    }
  } catch (_) {}
  for(const v of _vs){
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
    // PRINCIPAL = SÓ o chip explicitamente "Em uso". NÃO cai mais no 1º número da coluna.
    // BUG GRAVE corrigido (25/07): o fallback `mine.find(c=>c.bkp!==true)` pegava QUALQUER número
    // não-reserva estacionado na coluna de um vendedor ativo (status "Ativo", sem "Em uso") e o
    // roteava como principal, recebendo lead. Isso mandou lead pra número novo, de API oficial, e
    // de vendedor que nem estava trabalhando, queimando chip e perdendo venda a semana toda. O
    // próprio front declara "Em uso" como a FONTE DE VERDADE do número ativo; agora o backend
    // respeita isso. Estacionar número não roteia mais nada; quem deve receber tem que estar "Em uso".
    if(!principalOn) continue;   // v.ativo===false = vendedor inteiro desligado (master/legado); a UI nova controla por número (v.off)
    // ROLETA SIMPLES: TODOS os números "Em uso" do vendedor entram, cada um com seu interruptor (v.off).
    // Sem principal/reserva/swap. Regra de ouro mantida: SÓ "Em uso" recebe, sem fallback pro mine[0].
    // Todos vão pra MESMA instância ax_<at> (a atribuição casa por NÚMERO, não pela instância).
    const off = (v.off && typeof v.off === 'object') ? v.off : null;               // números DESLIGADOS (chave = últimos 8 dígitos)
    const nums = [];
    for(const c of mine){
      if(!isEmUso(c) || !c.num || !okWa(c)) continue;                              // só "Em uso", com número, não banido/restrito
      const nk = String(c.num).replace(/\D/g,'').slice(-8);
      if(off && off[nk]) continue;                                                 // interruptor DESSE número desligado
      if(!_servConnOk(liveSet, instP, c.num)) continue;                            // não conectado agora (casa por número)
      nums.push({num:c.num, inst:instP});
    }
    if(!nums.length) continue;                                                      // nenhum número ligado/conectado → fora da roleta
    out.push({at:String(v.at), nums});
  }
  // NÚMEROS SEM VENDEDOR (pedido do Giovane, 17/08/2026). Ele distribui os leads entre os
  // atendentes num sistema DELE, então exigir que cada número esteja dentro de um vendedor aqui só
  // dava trabalho. Aqui o número entra na roleta sozinho.
  // Duas diferenças de propósito em relação ao número com dono:
  //  - é OPT-IN por número (`on`), nunca ligado por ausência. O padrão "ausente = ligado" vale pra
  //    quem tem dono; aplicar isso aqui colocaria na roleta todo número solto do cadastro.
  //  - NÃO passa pelo _servConnOk. Esse número costuma estar fora da nossa infra (é justamente o
  //    caso de quem usa outro distribuidor), então a checagem de conexão reprovaria sempre. Quem
  //    liga assume que ele está no ar; a tela avisa isso com todas as letras.
  // A instância fica `ax__<8 dígitos>`: _atFromInst devolve string vazia, então o lead nasce SEM
  // vendedor em vez de nascer com um dono inventado.
  try{
    const sd = _vs.find(v => v && String(v.at) === '__sd');
    const liga = (sd && sd.on && typeof sd.on === 'object') ? sd.on : null;
    if(liga){
      const nums = [];
      for(const c of chips){
        if(!c || c.at) continue;                                   // aqui só entra quem NÃO tem dono
        if(c.st === 'aquecimento' || c.st === 'banido') continue;
        if(!isEmUso(c) || !c.num || !okWa(c)) continue;
        const nk = String(c.num).replace(/\D/g,'').slice(-8);
        if(!liga[nk]) continue;                                    // ligado um por um, na mão
        nums.push({num:c.num, inst:'ax__'+nk});
      }
      if(nums.length) out.push({at:'', nums});
    }
  }catch(_){}
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
    for(const n of (s.nums||[])) avail.push({num:n.num, at:s.at, inst:n.inst});
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
// QUAL EVENTO SAI EM CADA ETAPA DO FUNIL (escolhido por pressel).
//
// Pedido do Bruno em 17/08/2026: "gostaria de poder configurar quais são os eventos que vão ser
// disparados em cada etapa do funil". São 4 etapas, e elas saem de DOIS lugares diferentes do
// código: as duas primeiras no NAVEGADOR (dentro do HTML da pressel) e as duas últimas no SERVIDOR
// (Events API). Mexer só num lado configura metade do funil.
//
//   ev_view  "chegaram na pressel"   navegador   padrão PageView
//   ev_click "foram pro WhatsApp"    navegador   padrão ClickButton
//   ev_lead  "iniciaram contato"     servidor    padrão InitiateCheckout   <- é o que o GT otimiza
//   ev_sale  "vendas"                servidor    padrão CompletePayment
//
// TRÊS REGRAS QUE NÃO PODEM CAIR:
// 1. NOME SÓ DA LISTA. O nome é interpolado dentro de um <script> na página do anúncio, que é
//    tráfego pago. Nome livre ali é execução de código na pressel. Fora da lista cai no padrão:
//    configuração errada nunca pode derrubar o pixel.
// 2. O PADRÃO É O DE HOJE, byte a byte. Pressel que ninguém configurou continua disparando igual.
// 3. 'off' desliga a etapa de propósito (devolve string vazia).
const _EV_TT = ['PageView', 'ViewContent', 'ClickButton', 'Search', 'AddToWishlist', 'AddToCart',
  'InitiateCheckout', 'AddPaymentInfo', 'CompletePayment', 'PlaceAnOrder', 'Contact', 'Download',
  'SubmitForm', 'CompleteRegistration', 'Subscribe'];
const _EV_PADRAO = { ev_view: 'PageView', ev_click: 'ClickButton', ev_lead: 'InitiateCheckout', ev_sale: 'CompletePayment' };
const _EV_ETAPA = { ev_view: 'pressel', ev_click: 'whatsapp', ev_lead: 'contato', ev_sale: 'venda' };
function _evDe(p, chave) {
  const v = String((p && p[chave]) || '').trim();
  if (v === 'off') return '';
  if (v && _EV_TT.includes(v)) return v;
  return _EV_PADRAO[chave] || '';
}
const _evTodos = (p) => ({ ev_view: _evDe(p, 'ev_view'), ev_click: _evDe(p, 'ev_click'), ev_lead: _evDe(p, 'ev_lead'), ev_sale: _evDe(p, 'ev_sale') });

// 2º PIXEL (espelho). O Bruno quis mandar os MESMOS eventos reais pra um segundo pixel (outra BM),
// escolhendo o evento por etapa. A REGRA que separa espelho de fraude: SÓ a etapa de VENDA real
// (ev_sale) pode disparar evento de compra concluída. Em contato/engajamento, CompletePayment/
// Purchase/PlaceAnOrder são bloqueados (viram o padrão), então não dá pra marcar compra sem compra.

// ══ META (Facebook / Instagram) ═══════════════════════════════════════════
//
// ISTO NAO EXISTIA (27/08/2026). Os campos "Pixel da Meta" e "Access Token" estavam no editor da
// pressel e eram gravados no estado desde sempre, mas NADA no worker os lia: nenhuma linha injetava
// o pixel na pagina, nenhuma chamada ia pra Conversions API. Ou seja, quem preenchesse aqueles dois
// campos e subisse campanha no Meta Ads rodaria com ZERO traqueamento e sem perceber - o campo
// preenchido da a impressao de que esta ligado. O Bruno avisou que vai comecar a rodar Meta Ads,
// entao o caminho foi construido inteiro, espelhando o que ja existe pro TikTok.
//
// COMO FICA O FUNIL (de proposito SEM nome de evento repetido entre navegador e servidor, que e o
// que dispensa deduplicacao e e onde esse tipo de integracao costuma contar em dobro):
//   navegador  PageView  -> ao abrir a pressel
//   navegador  Contact   -> quando a pessoa vai pro WhatsApp
//   servidor   Lead      -> quando a mensagem CHEGA de verdade (nao e intencao, e lead real)
//   servidor   Purchase  -> so em venda confirmada, com valor
//
// A parte que da qualidade de match e a identificacao: `fbc` (o clique do anuncio) e `fbp` (o
// cookie do proprio pixel) sao gravados na visita e reaproveitados no envio do servidor, junto do
// telefone com hash. Sem eles a Meta recebe o evento mas casa mal, e o custo por resultado no
// gerenciador fica pior do que a operacao realmente e.
function _fbPixel(p){
  if(!p || !p.pixel_meta) return '';
  const id = JSON.stringify(String(p.pixel_meta)).replace(/</g,'\\u003c');   // neutraliza </script>
  // PageView sai pra TODO visitante, e nao so pra quem tem fbclid: e assim que a Meta monta
  // publico e atribui. (O TikTok aqui e gated por ttclid pra nao quebrar a serie historica de
  // cliques, que ja existe ha meses; na Meta estamos comecando do zero.)
  return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${id});fbq('track','PageView');</script>`;
}

// SHA-256 em hex. A Meta exige os dados pessoais com hash (telefone, email); mandar cru e recusado.
async function _sha256Hex(txt){
  const b = new TextEncoder().encode(String(txt || ''));
  const h = await crypto.subtle.digest('SHA-256', b);
  return Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function _fbEnsureTable(env){
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fb_events (
      event_id TEXT PRIMARY KEY, event TEXT, phone TEXT, value REAL, fbc TEXT, fbp TEXT,
      pid TEXT, status TEXT, code TEXT, msg TEXT, ts INTEGER)`).run();
  } catch (_) {}
}

// Conversions API. Mesma ideia do _ttSend: manda e GUARDA a resposta, porque erro de pixel/token
// aqui e silencioso - a Meta responde 200 com o problema descrito dentro do corpo.
async function _fbSend(env, pixel, token, event, phoneDigits, opts){
  opts = opts || {};
  const evId = String(opts.eventId || (event + '_' + phoneDigits));
  await _fbEnsureTable(env);
  const reg = async (status, code, msg) => {
    try {
      await env.DB.prepare(`INSERT INTO fb_events (event_id,event,phone,value,fbc,fbp,pid,status,code,msg,ts)
        VALUES (?,?,?,?,?,?,?,?,?,?,strftime('%s','now')) ON CONFLICT(event_id) DO UPDATE SET
        status=excluded.status, code=excluded.code, msg=excluded.msg, ts=excluded.ts`)
        .bind(evId, event, String(phoneDigits || ''), (opts.value == null ? null : Number(opts.value)),
              String(opts.fbc || ''), String(opts.fbp || ''), String(opts.pid || ''), status, String(code || ''), String(msg || '').slice(0, 300)).run();
    } catch (_) {}
  };
  if (!pixel || !token) { await reg('erro', 'sem_pixel', 'pressel sem pixel/token da Meta'); return { ok: false }; }
  try {
    const user = {};
    const tel = String(phoneDigits || '').replace(/\D/g, '');
    // Telefone com DDI: a Meta casa por E.164 sem o "+". Numero BR sem 55 na frente nao bate.
    if (tel) user.ph = [await _sha256Hex(tel.length <= 11 ? '55' + tel : tel)];
    if (opts.fbc) user.fbc = String(opts.fbc);
    if (opts.fbp) user.fbp = String(opts.fbp);
    if (opts.ip) user.client_ip_address = String(opts.ip);
    if (opts.ua) user.client_user_agent = String(opts.ua);
    if (tel) user.external_id = [await _sha256Hex(tel)];
    const ev = {
      event_name: event,
      event_time: Math.floor(Date.now() / 1000),
      event_id: evId,                    // se um dia o mesmo nome sair tambem do navegador, dedup pronto
      action_source: 'website',
      user_data: user,
    };
    if (opts.url) ev.event_source_url = String(opts.url);
    if (opts.value != null) ev.custom_data = { value: Number(opts.value), currency: 'BRL' };
    const r = await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(pixel) + '/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [ev], access_token: String(token) }),
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
    // A Meta responde 200 com `events_received`. Erro vem em `error.message`, tambem com 200 as vezes.
    const erro = j && j.error;
    if (!r.ok || erro) { await reg('erro', String((erro && erro.code) || r.status), String((erro && erro.message) || txt).slice(0, 300)); return { ok: false }; }
    await reg('ok', String((j && j.events_received) || 1), '');
    return { ok: true };
  } catch (e) {
    await reg('erro', 'excecao', String((e && e.message) || e));
    return { ok: false };
  }
}

// Qual pixel/token da Meta vale pra esta pressel. Mesma regra do TikTok: o da pressel; sem ele,
// nada (a Meta nao tem pixel global configurado hoje).
async function _fbPixelToken(env, pid){
  try {
    const data = await _getDashData(env);
    const p = (Array.isArray(data.pressels) ? data.pressels : []).find((x) => String(x.id) === String(pid));
    if (p && p.pixel_meta && p.pixel_meta_token) return { pixel: String(p.pixel_meta), token: String(p.pixel_meta_token) };
  } catch (_) {}
  return { pixel: '', token: '' };
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
// GET /p/:pid/img/:hash  → a imagem da pressel como arquivo, cacheavel pra sempre.
// Publica de proposito: a pressel inteira e publica, e a URL so existe pra quem recebeu a pagina.
async function handlePresselImg(env, pid, hash, num) {
  const data = await _getDashData(env).catch(() => null);
  const p = _acharPressel((data && data.pressels) || [], pid, num);
  if (!p) return new Response('nao achei', { status: 404 });
  const cands = [];
  for (const e of _presselElsServer(p)) if (e && e.type === 'imagem' && e.src) cands.push(String(e.src));
  if (p.img) cands.push(String(p.img));
  const achou = cands.find((src) => src.startsWith('data:') && _fotoHash(src) === String(hash));
  if (!achou) return new Response('imagem nao encontrada', { status: 404 });
  const m = achou.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!m) return new Response('imagem invalida', { status: 404 });
  let corpo;
  if (m[2]) {
    const bin = atob(m[3]);
    corpo = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) corpo[i] = bin.charCodeAt(i);
  } else corpo = decodeURIComponent(m[3]);
  return new Response(corpo, {
    headers: {
      'content-type': m[1] || 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*',
    },
  });
}

function _presselElsServer(p){
  if(Array.isArray(p.elementos) && p.elementos.length) return p.elementos;
  const els=[]; let n=1;
  if(p.img) els.push({id:n++,type:'imagem',src:p.img});
  els.push({id:n++,type:'botao',label:p.cta||'FALAR NO WHATSAPP',bg:'#22c55e',color:'#ffffff'});
  return els;
}
// A IMAGEM DA PRESSEL NAO VAI MAIS DENTRO DO HTML.
//
// Ela e guardada como data URI no estado, e a pagina saia com o base64 embutido: 122 KB de pagina,
// sendo 118 KB de imagem (o HTML de verdade tem 4 KB). Medido em 18/08/2026, com a campanha no ar:
// 94 KB transferidos e 2,2s pra pagina aparecer - e com `no-store`, entao cada visita baixava tudo
// de novo. Isso e trafego PAGO chegando numa tela em branco por dois segundos.
//
// Agora a imagem e um arquivo separado, com o hash do conteudo na URL e cache de 1 ano. A pagina cai
// pra ~4 KB e pinta na hora; a imagem entra logo atras e, na segunda visita, ja esta no aparelho.
// Trocou a imagem na dash, muda o hash, muda a URL: nao existe imagem velha presa em cache.
function _presselImgSrc(pid, src){
  const t = String(src || '');
  if (!t.startsWith('data:')) return t;   // ja e URL: passa direto
  return '/p/' + encodeURIComponent(String(pid)) + '/img/' + _fotoHash(t);
}
function _elPublicHtml(e, wa, pid){
  if(e.type==='imagem') return e.src?`<img src="${_escHtml(_presselImgSrc(pid, e.src))}" alt="" fetchpriority="high">`:'';
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
    // Incremento ATÔMICO num só statement (D1 serializa writes): duas roletas
    // concorrentes recebem n distintos, mantendo a distribuição igual. Antes era
    // SELECT + UPDATE separados, e uma rajada podia dar o mesmo índice pros dois.
    const row=await env.DB.prepare('INSERT INTO pressel_rr (pid,n) VALUES (?,1) ON CONFLICT(pid) DO UPDATE SET n=n+1 RETURNING n').bind(String(id)).first();
    const n=(Number(row&&row.n)||1)-1;   // n vem 1-based após o incremento; volta pra 0-based
    return n%len;
  }catch(_){ return Math.floor(Math.random()*len); }   // tabela ainda nao criada: sorteia, que e o mesmo efeito
}
// Contador de métricas da pressel (views = chegou; clicks = foi pro WhatsApp)
// Dia no fuso do Brasil (UTC-3, sem horário de verão), formato YYYY-MM-DD.
function _brDay(tsSec){ const ms=(tsSec?tsSec*1000:Date.now())-3*3600000; return new Date(ms).toISOString().slice(0,10); }
async function _bumpPressel(env, id, field){
  const col = field === 'clicks' ? 'clicks' : 'views';
  try{
    await _presselEnsure(env);
    await env.DB.prepare(`INSERT INTO pressel_stats (pid, ${col}) VALUES (?, 1) ON CONFLICT(pid) DO UPDATE SET ${col} = ${col} + 1`).bind(String(id)).run();
    // e por DIA, pra dash conseguir filtrar por data
    await env.DB.prepare(`INSERT INTO pressel_day (pid, day, ${col}) VALUES (?, ?, 1) ON CONFLICT(pid,day) DO UPDATE SET ${col} = ${col} + 1`).bind(String(id), _brDay()).run();
  }catch(_){}
}
// GET /api/pressel/diag → por pressel, PRA ONDE o botão do WhatsApp está mandando agora.
//
// Existe porque o modo de falhar é silencioso e caro: a pressel continua abrindo bonita, o anúncio
// continua gastando, e o botão simplesmente não leva a lugar nenhum (o worker serve `go(){...if(!"")
// return}` quando não achou número). Já aconteceu de virar o dia inteiro assim. Aqui a dash pergunta
// pro MESMO código que a roleta usa e mostra o número real — e, quando não tem, o motivo.
async function handlePresselDiag(req, env){
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  // SEM CACHE (maxAge 0). O diagnóstico é lido logo depois de ligar/desligar um número, e o cache de
  // 8s do estado devolvia a resposta ANTERIOR: o Bruno desligou o número e a faixa continuou verde.
  // É uma tela de diretor, uma leitura por vez — ler direto do banco aqui não pesa.
  const data = await _getDashData(env, 0);
  const _idsDiag = _presselIdsVisiveis(u, data);
  const pressels = (Array.isArray(data.pressels) ? data.pressels : []).filter((p) => !_idsDiag || _idsDiag.has(String(p && p.id)));
  const chips = Array.isArray(data.chips) ? data.chips : [];
  const liveSet = await _presselLiveSet(env);
  const emUsoIds = _emUsoIdsDe(data);
  const foraIds = _foraIdsDe(data);
  const isEmUso = (c) => c.em_uso===true || c.em_uso===1 || emUsoIds.has(String(c.wa_st||'')) || String(c.wa_st||'')==='em_uso';
  const okWa = (c) => !foraIds.has(String((c&&c.wa_st)||'').toLowerCase());
  const out = pressels.map((p)=>{
    const sellers = _resolvePresselSellers(p, _chipsDaPressel(p, chips), liveSet, emUsoIds, foraIds);
    const numeros = [];
    for(const s of sellers) for(const n of (s.nums||[])) numeros.push({ at:s.at, num:n.num });
    // Motivo: repete os MESMOS testes da roleta, um por vez, pra dizer em qual deles todo mundo caiu.
    let motivo = '';
    if(!numeros.length){
      const usaveis = chips.filter(c=>c && c.at && c.st!=='aquecimento' && c.st!=='banido' && c.num && isEmUso(c) && okWa(c));
      const offMap = {};
      for(const v of (Array.isArray(p.vendedores)?p.vendedores:[])){
        if(!v || !v.at) continue;
        if(v.ativo === false) offMap['@'+String(v.at)] = true;                       // vendedor inteiro desligado
        for(const k of Object.keys((v.off && typeof v.off==='object') ? v.off : {})) if(v.off[k]) offMap[String(v.at)+':'+k] = true;
      }
      const desligados = usaveis.filter(c=>{
        const nk = String(c.num).replace(/\D/g,'').slice(-8);
        return offMap['@'+String(c.at)] || offMap[String(c.at)+':'+nk];
      });
      const ligados = usaveis.filter(c=>!desligados.includes(c));
      const conectados = ligados.filter(c=>_servConnOk(liveSet, 'ax_'+String(c.at), c.num));
      if(!usaveis.length) motivo = 'nenhum número está "Em uso" — a roleta só entrega lead pra número marcado assim';
      else if(!ligados.length) motivo = 'os ' + usaveis.length + ' números "Em uso" estão DESLIGADOS nesta pressel (interruptor do vendedor)';
      else if(!conectados.length) motivo = 'os números estão ligados, mas nenhum aparece conectado agora (WhatsApp caído ou Sale Chat fechado)';
      else motivo = 'nenhum número disponível no momento';
    }
    return { id:p.id, nome:p.nome||'', status:p.status||'ativa', numeros, motivo };
  });
  return json({ ok:true, pressels: out });
}
// GET /api/pressel/stats → views/clicks por pressel (a dash mostra na métrica)
async function handlePresselStats(req, env){
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  try{
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_rr (pid TEXT PRIMARY KEY, n INTEGER)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_stats (pid TEXT PRIMARY KEY, views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0)').run();
    // RECORTE POR DONO (auditoria 24/08/2026): era a unica das tres rotas de metrica sem corte, e
    // devolvia views/clicks de TODAS as pressels.
    const _idsS = _presselIdsVisiveis(u, await _getDashData(env).catch(() => ({})));
    const rows = await env.DB.prepare('SELECT pid, views, clicks FROM pressel_stats').all();
    if (_idsS) rows.results = (rows.results || []).filter((r) => _idsS.has(String(r.pid)));
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
  // As duas consultas do bloco de baixo (dupes/vinc) entram AQUI tambem: elas nao dependem de nada
  // do primeiro bloco, e esperar por elas depois somava mais duas idas ao banco em fila. Esta tela e
  // a que o Bruno mais abre.
  const [pr, c, c2, s, sa, dupes0, vinc0, st0] = await Promise.all([
    q('SELECT pid, views, clicks FROM pressel_day WHERE day=?', day),
    q("SELECT pid, COUNT(*) c FROM wa_lead WHERE ts>=? AND ts<? AND pid IS NOT NULL AND pid<>'' GROUP BY pid", start, end),
    q("SELECT pid, inst, COUNT(*) c FROM wa_lead WHERE ts>=? AND ts<? AND pid IS NOT NULL AND pid<>'' AND inst IS NOT NULL GROUP BY pid, inst", start, end),
    q("SELECT l.pid pid, s.instance inst, COUNT(*) v, COALESCE(SUM(s.value),0) val FROM wa_sales s JOIN wa_lead l ON l.phone=s.phone WHERE s.ts>=? AND s.ts<? AND l.pid IS NOT NULL AND l.pid<>'' GROUP BY l.pid, s.instance", start, end),
    q("SELECT s.instance inst, COUNT(*) v, COALESCE(SUM(s.value),0) val FROM wa_sales s WHERE s.ts>=? AND s.ts<? GROUP BY s.instance", start, end),
    q("SELECT s.phone p FROM wa_sales s WHERE s.ts>=? AND s.ts<?", start, end),
    q("SELECT phone, pid, inst FROM wa_lead WHERE pid IS NOT NULL AND pid<>''"),
    _getDashData(env).catch(() => ({})),
  ]);
  pr.forEach(r=>{ m.vc[String(r.pid)]={views:Number(r.views)||0, clicks:Number(r.clicks)||0}; });
  c.forEach(r=>{ m.contatos[String(r.pid)]=Number(r.c)||0; });
  c2.forEach(r=>{ const pid=String(r.pid); (m.contatosVI[pid]=m.contatosVI[pid]||{})[r.inst]=Number(r.c)||0; });
  s.forEach(r=>{ const pid=String(r.pid); m.vendas[pid]=(m.vendas[pid]||0)+(Number(r.v)||0); m.valor[pid]=(m.valor[pid]||0)+(Number(r.val)||0); (m.vendasVI[pid]=m.vendasVI[pid]||{})[r.inst||'']=Number(r.v)||0; });
  sa.forEach(r=>{ m.vendasInst[String(r.inst||'')]={ v:Number(r.v)||0, val:Number(r.val)||0 }; });

  // VENDA CADASTRADA NA DASH TAMBEM CONTA.
  //
  // Ate aqui "Vendas" saia SO da wa_sales, que e a venda detectada pela frase "Pedido Concluido" no
  // WhatsApp. Pedido criado pelo Novo Pedido vive em data.leads e nao aparecia: em 18/08/2026 o
  // Murilo cadastrou uma venda de R$ 497 e a Chegada de leads seguiu marcando zero. Sao duas fontes
  // pro mesmo fato e a tela olhava so uma.
  //
  // Casa pelo TELEFONE com wa_lead, que e quem sabe de qual pressel o lead veio. Dedup pelo telefone:
  // se a mesma venda existe nas duas fontes (o vendedor cadastrou E mandou a frase), conta UMA.
  try {
    const st = st0 || {};
    const leads = Array.isArray(st && st.leads) ? st.leads : [];
    if (leads.length) {
      const jaTem = new Set();
      const dupes = dupes0 || [];
      dupes.forEach(r => jaTem.add(String(r.p || '').replace(/\D/g, '').slice(-8)));
      const vinc = vinc0 || [];
      const porTel = {};
      vinc.forEach(r => { const k = String(r.phone || '').replace(/\D/g, '').slice(-8); if (k) porTel[k] = r; });
      for (const l of leads) {
        const ts = Number(l && l.ts) || 0;
        // sem carimbo de tempo no lead, usa o id (o Novo Pedido usa Date.now() como id)
        const quando = ts > 0 ? ts : Math.floor((Number(l && l.id) || 0) / 1000);
        if (!(quando >= start && quando < end)) continue;
        const tel = String((l && l.wa) || '').replace(/\D/g, '').slice(-8);
        if (!tel || jaTem.has(tel)) continue;
        const v = porTel[tel];
        if (!v) continue;                       // sem pressel conhecida: nao da pra atribuir
        jaTem.add(tel);
        const pid = String(v.pid);
        const inst = String(v.inst || '');
        const val = Number((l && (l.valor_neg || l.vl)) || 0);
        m.vendas[pid] = (m.vendas[pid] || 0) + 1;
        m.valor[pid] = (m.valor[pid] || 0) + val;
        (m.vendasVI[pid] = m.vendasVI[pid] || {})[inst] = (m.vendasVI[pid][inst] || 0) + 1;
        const ai = m.vendasInst[inst] || (m.vendasInst[inst] = { v: 0, val: 0 });
        ai.v += 1; ai.val += val;
      }
    }
  } catch (_) { /* sem blob: mantem so o que veio da wa_sales */ }
  return m;
}
async function handlePresselMetricsLive(req, env){
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  let day = new URL(req.url).searchParams.get('day') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = _brDay();
  const M = await _presselDayMetrics(env, day);
  // Metrica e por id de pressel: com o conjunto permitido em maos, o resto sai sozinho.
  const _idsM = _presselIdsVisiveis(u, await _getDashData(env).catch(() => ({})));
  const pressels = {};
  new Set([...Object.keys(M.vc), ...Object.keys(M.contatos), ...Object.keys(M.vendas)]).forEach(pid=>{
    const vc = M.vc[pid]||{};
    const p = { views:Number(vc.views)||0, clicks:Number(vc.clicks)||0, contatos:M.contatos[pid]||0, vendas:M.vendas[pid]||0, valor:M.valor[pid]||0, vend:{} };
    const cvi = M.contatosVI[pid]||{}, vvi = M.vendasVI[pid]||{};
    new Set([...Object.keys(cvi), ...Object.keys(vvi)]).forEach(inst=>{ const b=_atFromInst(inst); const e=(p.vend[b]=p.vend[b]||{contatos:0,vendas:0}); e.contatos+=cvi[inst]||0; e.vendas+=vvi[inst]||0; });   // chave = at (tira ax_ E _b) pra casar com metric.vend[at.id] no front
    if (_idsM && !_idsM.has(String(pid))) return;
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
  // O NOME VEM DE users e nao passava pelo recorte: com sessao de afiliado, "Guilherme" e "Murilo"
  // continuavam na tabela por vendedor mesmo com as pressels ja filtradas. Agora, quando ha recorte
  // ativo (_idsPag na pagina, _idsOk no JSON), so entram os nomes do mundo de quem pediu.
  try{
    const _cortaNome = (typeof _idsPag !== 'undefined' ? _idsPag : (typeof _idsOk !== 'undefined' ? _idsOk : null)) !== null;
    const _uNome = _cortaNome ? await authUser(req, env).catch(() => null) : null;
    const _aflNome = _uNome ? aflDe(_uNome) : null;
    const us=await env.DB.prepare('SELECT id, name, afiliado_id FROM users').all();
    (us.results||[]).forEach(u=>{
      if (_cortaNome && String(u.afiliado_id||'') !== String(_aflNome||' ')) return;
      nameMap[String(u.id)]=u.name;
    });
  }catch(_){}
  // vendedores da roleta AGORA + qualquer um com atividade hoje nesta pressel (mesmo já tirado da roleta) — o dado não some
  const _vAt=(inst)=>_atFromInst(inst);
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
// ─── Site institucional da marca (pra a Meta aprovar o nome de exibição do WhatsApp) ───
// Serve na RAIZ dos domínios glico. As pressels ficam em /p/<id>, então não conflita.
// Tom deliberadamente tranquilo, de marca de bem-estar, SEM promessa de saúde/cura (o que trava a
// aprovação e viola política). O nome tem que BATER com o que a Meta vê no site: por isso o nome
// da marca aqui (BRAND_NAME) é o mesmo do nome de exibição pedido no WhatsApp.
const BRAND_NAME = 'Glico Natural';   // troca aqui pra mudar o nome no site inteiro
// Dados legais reais da empresa (do Cartão CNPJ). Aparecem no rodapé, no contato e nas políticas.
// ATENÇÃO: preencher com os dados REAIS antes de deployar. Têm que bater AO CARACTERE com o
// Cartão CNPJ e com o que for cadastrado no Business Manager da Meta (mismatch = causa nº 1 de reprovação).
const BRAND_LEGAL = '[RAZÃO SOCIAL LTDA]';                      // razão social exata do Cartão CNPJ (não o nome fantasia)
const BRAND_CNPJ  = '[00.000.000/0001-00]';                    // CNPJ formatado
const BRAND_ADDR  = '[endereço completo, igual ao Cartão CNPJ]'; // sem abreviar
const BRAND_PHONE = '[(00) 00000-0000]';                       // telefone comercial
const BRAND_FB_DV = '';                                         // código da Verificação de Domínio da Meta (facebook-domain-verification); preencher quando a Meta gerar
const BRAND_DOMS = ['area-glico.fun', 'painel-glico.fun'];
function _brandEmail(host){ return 'contato@' + (BRAND_DOMS.includes(host) ? host : 'painel-glico.fun'); }
// Ilustração de frasco conta-gotas (SVG inline) — visual de marca natural, sem foto de terceiros.
function _bottleSvg(){
  return '<svg viewBox="0 0 120 150" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:96px;height:120px">'
    + '<rect x="46" y="6" width="28" height="16" rx="4" fill="#0e7a43"/>'
    + '<rect x="52" y="20" width="16" height="10" fill="#0b5c34"/>'
    + '<path d="M38 34c0-3 3-6 6-6h32c3 0 6 3 6 6v92c0 8-6 14-14 14H52c-8 0-14-6-14-14V34z" fill="#ffffff" stroke="#0e7a43" stroke-width="3"/>'
    + '<path d="M44 96c0 20 10 30 16 30s16-10 16-30c0-6-16-30-16-30S44 90 44 96z" fill="#d6f0e1"/>'
    + '<circle cx="60" cy="104" r="7" fill="#12945a"/>'
    + '</svg>';
}
// Ícones SVG inline (padrão da marca — sem emoji). Cor verde por padrão, herda contexto.
const _ICONS = {
  leaf:['M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z','M2 22 17 7'],
  box:['M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z','M3.3 7 12 12l8.7-5','M12 22V12'],
  chat:['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  bag:['M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z','M3 6h18','M16 10a4 4 0 0 1-8 0'],
  check:['M20 6 9 17l-5-5']
};
function _ic(name, sz){
  const arr = _ICONS[name] || [];
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:' + (sz||'1em') + ';height:' + (sz||'1em') + ';vertical-align:-.15em;color:var(--verde)" aria-hidden="true">' + arr.map(function(d){return '<path d="' + d + '"/>';}).join('') + '</svg>';
}
function _brandShell(title, inner, withJs){
  const js = withJs ? ('<script>(function(){var c=document.querySelector(".slides");if(c){var slides=c.children.length,i=0,dots=document.querySelectorAll(".dot");function go(n){i=(n+slides)%slides;c.style.transform="translateX("+(-i*100)+"%)";dots.forEach(function(d,k){d.className="dot"+(k===i?" on":"");});}var pv=document.querySelector(".c-prev"),nx=document.querySelector(".c-next");if(pv)pv.onclick=function(){go(i-1);};if(nx)nx.onclick=function(){go(i+1);};dots.forEach(function(d,k){d.onclick=function(){go(k);};});var t=setInterval(function(){go(i+1);},4500);c.parentElement.addEventListener("mouseenter",function(){clearInterval(t);});go(0);}'
    + 'document.querySelectorAll(".acc-q").forEach(function(q){q.onclick=function(){q.parentElement.classList.toggle("open");};});})();<\/script>') : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${BRAND_NAME} — produtos naturais de bem-estar para o seu dia a dia.">
${BRAND_FB_DV ? '<meta name="facebook-domain-verification" content="' + BRAND_FB_DV + '">' : ''}
<style>
:root{--verde:#0e7a43;--verde2:#12945a;--claro:#e8f5ee;--tinta:#14231c;--cinza:#5b6b62;--linha:#e4ebe6;--fundo:#f6faf7;--card:#fff}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--tinta);background:var(--fundo);line-height:1.6;-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}a{color:inherit;text-decoration:none}
.wrap{max-width:1080px;margin:0 auto;padding:0 22px}
header{position:sticky;top:0;background:rgba(246,250,247,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--linha);z-index:9}
.nav{display:flex;align-items:center;justify-content:space-between;height:66px}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;letter-spacing:-.01em}
.logo .mark{width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,var(--verde),var(--verde2));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px}
.nav-links{display:flex;gap:24px;font-size:14.5px;color:var(--cinza)}
.nav-links a:hover{color:var(--verde)}
.nav .btn{padding:9px 18px;font-size:13.5px}
.btn{display:inline-block;background:var(--verde);color:#fff;font-weight:700;font-size:15px;padding:13px 28px;border-radius:12px;transition:.15s;border:none;cursor:pointer}
.btn:hover{background:var(--verde2);transform:translateY(-1px)}
.btn.ghost{background:transparent;color:var(--verde);border:1.5px solid var(--verde)}
.hero{position:relative;overflow:hidden;background:linear-gradient(180deg,#eef8f2,var(--fundo))}
.hero-in{display:grid;grid-template-columns:1.15fr .85fr;gap:34px;align-items:center;padding:66px 0 58px}
.hero h1{font-size:clamp(30px,4.6vw,48px);line-height:1.12;letter-spacing:-.025em;margin-bottom:18px}
.hero h1 span{color:var(--verde)}
.hero p{font-size:clamp(15px,2.2vw,18px);color:var(--cinza);margin-bottom:26px;max-width:480px}
.hero-cta{display:flex;gap:12px;flex-wrap:wrap}
.hero-art{background:radial-gradient(120% 120% at 70% 20%,#d6f0e1,#eef8f2);border:1px solid var(--linha);border-radius:24px;min-height:280px;display:flex;align-items:center;justify-content:center;position:relative}
.hero-art .badge{position:absolute;bottom:18px;left:18px;background:#fff;border:1px solid var(--linha);border-radius:12px;padding:9px 13px;font-size:12.5px;font-weight:700;box-shadow:0 6px 20px #0e7a4315}
.trust{display:flex;flex-wrap:wrap;gap:26px;justify-content:center;padding:22px 0;border-bottom:1px solid var(--linha);font-size:13.5px;color:var(--cinza)}
.trust b{color:var(--tinta)}
.sec{padding:60px 0}
.sec-h{text-align:center;max-width:620px;margin:0 auto 34px}
.sec-h h2{font-size:clamp(23px,3.4vw,32px);letter-spacing:-.02em;margin-bottom:10px}
.sec-h p{color:var(--cinza);font-size:15.5px}
.carousel{position:relative;overflow:hidden;border-radius:22px;border:1px solid var(--linha);background:var(--card)}
.slides{display:flex;transition:transform .5s ease}
.slide{min-width:100%;display:grid;grid-template-columns:.9fr 1.1fr;gap:0}
.slide .pic{min-height:300px;display:flex;align-items:center;justify-content:center}
.slide .txt{padding:38px}
.slide .txt span{display:inline-block;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--verde);background:var(--claro);padding:5px 11px;border-radius:20px;margin-bottom:12px}
.slide .txt h3{font-size:24px;letter-spacing:-.01em;margin-bottom:10px}
.slide .txt p{color:var(--cinza);font-size:15px}
.c-nav{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:40px;border-radius:50%;background:#fff;border:1px solid var(--linha);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--verde);box-shadow:0 4px 14px #0e7a4318;z-index:2}
.c-prev{left:14px}.c-next{right:14px}
.dots{display:flex;gap:8px;justify-content:center;margin-top:18px}
.dot{width:9px;height:9px;border-radius:50%;background:#cfe3d7;cursor:pointer;border:none}
.dot.on{background:var(--verde);width:22px;border-radius:5px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--linha);border-radius:18px;padding:26px}
.card .ic{width:46px;height:46px;border-radius:12px;background:var(--claro);display:flex;align-items:center;justify-content:center;margin-bottom:14px;font-size:22px}
.card h3{font-size:16.5px;margin-bottom:6px}
.card p{font-size:14px;color:var(--cinza)}
.about{display:grid;grid-template-columns:1fr 1fr;gap:34px;align-items:center;background:var(--card);border:1px solid var(--linha);border-radius:22px;padding:40px;overflow:hidden}
.about h2{font-size:clamp(22px,3.2vw,30px);letter-spacing:-.02em;margin-bottom:14px}
.about p{color:var(--cinza);font-size:15.5px;margin-bottom:12px}
.about .art{background:radial-gradient(120% 120% at 30% 20%,#d6f0e1,#f2faf5);border-radius:18px;min-height:240px;display:flex;align-items:center;justify-content:center}
.faq{max-width:760px;margin:0 auto}
.acc-item{background:var(--card);border:1px solid var(--linha);border-radius:14px;margin-bottom:12px;overflow:hidden}
.acc-q{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:18px 22px;cursor:pointer;font-weight:700;font-size:15.5px}
.acc-q .pl{color:var(--verde);font-size:22px;transition:.2s}
.acc-item.open .acc-q .pl{transform:rotate(45deg)}
.acc-a{max-height:0;overflow:hidden;transition:max-height .3s ease}
.acc-item.open .acc-a{max-height:240px}
.acc-a p{padding:0 22px 20px;color:var(--cinza);font-size:14.5px}
.contato{background:linear-gradient(135deg,var(--verde),var(--verde2));color:#fff;border-radius:22px;padding:38px;display:flex;flex-wrap:wrap;gap:22px;justify-content:space-between;align-items:center}
.contato .lbl{font-size:12px;opacity:.85;text-transform:uppercase;letter-spacing:.06em}
.contato .val{font-size:17px;font-weight:800}
.contato .btn{background:#fff;color:var(--verde)}
footer{border-top:1px solid var(--linha);margin-top:8px;padding:32px 0;color:var(--cinza);font-size:13.5px}
.foot{display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between;align-items:center}
.foot a:hover{color:var(--verde)}
.legal{max-width:760px}.legal h2{margin:26px 0 10px;font-size:20px}.legal p{color:var(--cinza);margin-bottom:12px;font-size:15px}
.hero-art{overflow:hidden}.hero-art img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.slide .pic{overflow:hidden;padding:0}.slide .pic img{width:100%;height:100%;object-fit:cover}
.about .art{overflow:hidden}.about .art img{width:100%;height:100%;object-fit:cover;min-height:240px}
@media(max-width:760px){.hero-in{grid-template-columns:1fr;padding:44px 0}.hero-art{min-height:220px}.slide{grid-template-columns:1fr}.slide .pic{min-height:200px}.slide .txt{padding:26px}.about{grid-template-columns:1fr;padding:28px}.nav-links{display:none}}
</style></head><body>
<header><div class="wrap nav">
  <a class="logo" href="/"><span class="mark">G</span> ${BRAND_NAME}</a>
  <nav class="nav-links"><a href="/#produtos">Produtos</a><a href="/#sobre">Sobre</a><a href="/#faq">Dúvidas</a><a href="/#contato">Contato</a></nav>
  <a class="btn" href="/#contato">Fale conosco</a>
</div></header>
${inner}
<footer><div class="wrap" style="display:flex;flex-direction:column;gap:14px">
  <div class="foot">
    <div>© 2026 ${BRAND_NAME}. Todos os direitos reservados.</div>
    <div style="display:flex;gap:16px;flex-wrap:wrap"><a href="/privacidade">Privacidade</a><a href="/termos">Termos</a><a href="/entrega-e-trocas">Trocas e Entrega</a><a href="/#contato">Contato</a></div>
  </div>
  <div style="font-size:12.5px;color:var(--cinza);line-height:1.55;border-top:1px solid var(--linha);padding-top:14px">
    ${BRAND_LEGAL} — CNPJ ${BRAND_CNPJ}<br>${BRAND_ADDR}
  </div>
</div></footer>
${js}</body></html>`;
}
function _brandHome(host){
  const mail = _brandEmail(host);
  const b = _bottleSvg();
  const IMG = '/img/produto.jpg?v=2';
  const slide = (tag, h, p) => '<div class="slide"><div class="pic"><img src="' + IMG + '" alt="" loading="lazy"></div><div class="txt"><span>' + tag + '</span><h3>' + h + '</h3><p>' + p + '</p></div></div>';
  const inner = `<main>
  <section class="hero"><div class="wrap hero-in">
    <div>
      <h1>Bem-estar natural para o seu <span>dia a dia</span></h1>
      <p>A ${BRAND_NAME} reúne produtos naturais selecionados para acompanhar a sua rotina com mais leveza, praticidade e cuidado.</p>
      <div class="hero-cta"><a class="btn" href="/#contato">Fale com a gente</a><a class="btn ghost" href="/#produtos">Ver produtos</a></div>
    </div>
    <div class="hero-art"><img src="/img/produto.jpg?v=2" alt="${BRAND_NAME}"><div class="badge">${_ic('leaf','15px')} 100% de origem natural</div></div>
  </div></section>

  <div class="trust wrap"><div>${_ic('leaf','17px')} <b>Ingredientes naturais</b></div><div>${_ic('box','17px')} <b>Entrega em casa</b></div><div>${_ic('chat','17px')} <b>Atendimento humano</b></div><div>${_ic('bag','17px')} <b>Compra sem complicação</b></div></div>

  <section class="sec wrap" id="produtos">
    <div class="sec-h"><h2>Nossos produtos</h2><p>Feitos para o cuidado do dia a dia, com componentes de origem natural.</p></div>
    <div class="carousel">
      <div class="slides">
        ${slide('Linha bem-estar', 'Cuidado do dia a dia', 'Nossa linha principal, pensada para acompanhar a sua rotina de forma leve e prática.')}
        ${slide('Origem natural', 'Feito com o que a natureza oferece', 'Selecionamos componentes de origem natural em cada uma das nossas fórmulas.')}
        ${slide('Praticidade', 'Simples de usar no seu dia', 'Produtos pensados para caber na correria, sem complicar a sua rotina.')}
      </div>
      <button class="c-nav c-prev" aria-label="Anterior">‹</button>
      <button class="c-nav c-next" aria-label="Próximo">›</button>
    </div>
    <div class="dots"><button class="dot on"></button><button class="dot"></button><button class="dot"></button></div>
  </section>

  <section class="sec wrap">
    <div class="cards">
      <div class="card"><div class="ic">${_ic('leaf','24px')}</div><h3>Ingredientes naturais</h3><p>Fórmulas com componentes de origem natural, para o cuidado do dia a dia.</p></div>
      <div class="card"><div class="ic">${_ic('check','24px')}</div><h3>Qualidade selecionada</h3><p>Cada item passa por um processo de seleção antes de chegar até você.</p></div>
      <div class="card"><div class="ic">${_ic('box','24px')}</div><h3>Entrega em casa</h3><p>Você recebe no conforto da sua casa, com acompanhamento do começo ao fim.</p></div>
      <div class="card"><div class="ic">${_ic('chat','24px')}</div><h3>Atendimento próximo</h3><p>Uma equipe humana pra tirar dúvidas e acompanhar o seu pedido com atenção.</p></div>
    </div>
  </section>

  <section class="sec wrap" id="sobre">
    <div class="about">
      <div>
        <h2>Sobre a ${BRAND_NAME}</h2>
        <p>Somos uma marca de produtos naturais de bem-estar. Nosso propósito é simples: oferecer opções de qualidade para quem busca cuidar da rotina de um jeito prático e tranquilo.</p>
        <p>Trabalhamos com atendimento humano e próximo, acompanhando cada cliente com atenção e transparência, do primeiro contato até a entrega em casa.</p>
        <p style="font-size:14px"><strong>${BRAND_LEGAL}</strong> — CNPJ ${BRAND_CNPJ}.</p>
      </div>
      <div class="art"><img src="/img/produto.jpg?v=2" alt="${BRAND_NAME}" loading="lazy"></div>
    </div>
  </section>

  <section class="sec wrap" id="faq">
    <div class="sec-h"><h2>Dúvidas frequentes</h2></div>
    <div class="faq">
      <div class="acc-item open"><div class="acc-q">Como funciona a entrega?<span class="pl">+</span></div><div class="acc-a"><p>Você recebe no conforto da sua casa. Nossa equipe acompanha o pedido do início ao fim e avisa sobre cada etapa.</p></div></div>
      <div class="acc-item"><div class="acc-q">Os produtos são naturais?<span class="pl">+</span></div><div class="acc-a"><p>Sim. Trabalhamos com componentes de origem natural, selecionados para o cuidado do dia a dia.</p></div></div>
      <div class="acc-item"><div class="acc-q">Como faço para comprar?<span class="pl">+</span></div><div class="acc-a"><p>É só falar com a nossa equipe pelo contato abaixo. A gente te explica tudo com calma, sem complicação.</p></div></div>
      <div class="acc-item"><div class="acc-q">Vocês dão suporte depois da compra?<span class="pl">+</span></div><div class="acc-a"><p>Damos sim. Nosso atendimento continua disponível para tirar dúvidas e ajudar no que você precisar.</p></div></div>
    </div>
  </section>

  <section class="sec wrap" id="contato">
    <div class="contato">
      <div><div class="lbl">E-mail</div><div class="val">${mail}</div></div>
      <div><div class="lbl">Telefone</div><div class="val">${BRAND_PHONE}</div></div>
      <div><div class="lbl">Atendimento</div><div class="val">Seg a sáb, 9h às 18h</div></div>
      <a class="btn" href="mailto:${mail}">Enviar e-mail</a>
    </div>
    <p style="text-align:center;color:var(--cinza);font-size:13px;margin-top:16px;line-height:1.55">${BRAND_LEGAL} — CNPJ ${BRAND_CNPJ}<br>${BRAND_ADDR}</p>
  </section>
</main>`;
  return _brandShell(BRAND_NAME + ' — bem-estar natural', inner, true);
}
function _brandLegal(kind, host){
  const mail = _brandEmail(host);
  const ident = BRAND_LEGAL + ', inscrita no CNPJ ' + BRAND_CNPJ + ', com sede em ' + BRAND_ADDR;
  const priv = `<h1 style="font-size:26px;margin-bottom:6px">Política de Privacidade</h1>
    <p>Esta Política descreve como a ${BRAND_NAME} (${ident}) trata os dados pessoais dos seus clientes, em conformidade com a Lei Geral de Proteção de Dados (Lei nº 13.709/2018 — LGPD).</p>
    <h2>Controlador dos dados</h2>
    <p>${ident}. Contato para assuntos de privacidade: ${mail}.</p>
    <h2>Quais dados coletamos</h2>
    <p>Coletamos apenas os dados necessários para atender e entregar os pedidos: nome, telefone de contato, endereço de entrega e as informações trocadas durante o atendimento.</p>
    <h2>Para que usamos</h2>
    <p>Usamos os dados exclusivamente para responder ao seu contato, combinar e realizar a entrega e prestar suporte após a compra.</p>
    <h2>Com quem compartilhamos</h2>
    <p>Não vendemos nem compartilhamos os seus dados para fins de marketing de terceiros. Compartilhamos apenas o necessário com parceiros de entrega e de pagamento, para concluir o seu pedido.</p>
    <h2>Por quanto tempo guardamos</h2>
    <p>Mantemos os dados apenas pelo tempo necessário para o atendimento, a entrega e o cumprimento de obrigações legais.</p>
    <h2>Seus direitos</h2>
    <p>Nos termos do art. 18 da LGPD, você pode a qualquer momento solicitar a confirmação, o acesso, a correção, a portabilidade ou a exclusão dos seus dados, além de revogar consentimentos. Basta escrever para ${mail}.</p>`;
  const term = `<h1 style="font-size:26px;margin-bottom:6px">Termos de Uso</h1>
    <p>Estes Termos regem o uso deste site e o atendimento da ${BRAND_NAME} (${ident}).</p>
    <h2>Sobre os produtos</h2>
    <p>Comercializamos produtos de bem-estar de origem natural. Eles não são medicamentos e não substituem a orientação, o diagnóstico ou o tratamento de um profissional de saúde. Em caso de dúvida sobre o uso, consulte um especialista de sua confiança.</p>
    <h2>Atendimento e pedidos</h2>
    <p>O atendimento e a finalização da compra são feitos por contato direto com a nossa equipe. Ao entrar em contato, você concorda em fornecer informações verdadeiras e necessárias para o atendimento e a entrega.</p>
    <h2>Responsabilidades</h2>
    <p>Comprometemo-nos a prestar informações claras sobre produtos, preços e condições de entrega. O cliente é responsável por fornecer dados corretos de contato e endereço.</p>
    <h2>Contato</h2>
    <p>Dúvidas sobre estes Termos podem ser enviadas para ${mail}.</p>`;
  const troca = `<h1 style="font-size:26px;margin-bottom:6px">Trocas, Devolução e Entrega</h1>
    <p>A ${BRAND_NAME} (${ident}) preza pela sua satisfação e segue o Código de Defesa do Consumidor (Lei nº 8.078/1990).</p>
    <h2>Direito de arrependimento</h2>
    <p>Conforme o art. 49 do CDC, você pode desistir da compra em até <strong>7 (sete) dias corridos</strong> a contar do recebimento do produto, sem necessidade de justificativa. Basta entrar em contato pelo ${mail}.</p>
    <h2>Troca e devolução</h2>
    <p>Aceitamos troca ou devolução de produtos com defeito ou avaria. Para solicitar, entre em contato pelo ${mail} informando o número do pedido e, se possível, fotos do produto. O item deve ser devolvido na embalagem original.</p>
    <h2>Reembolso</h2>
    <p>Confirmada a devolução dentro das condições acima, o valor pago é reembolsado pelo mesmo meio utilizado na compra, no prazo previsto em lei após o recebimento do produto de volta.</p>
    <h2>Entrega</h2>
    <p>As entregas são combinadas no atendimento e realizadas no endereço informado pelo cliente. O prazo e a forma de entrega são apresentados no momento da compra, conforme a sua região.</p>`;
  const map = { privacidade: priv, termos: term, trocas: troca };
  const titles = { privacidade: 'Privacidade', termos: 'Termos', trocas: 'Trocas e Entrega' };
  const inner = `<main class="wrap" style="padding:46px 0"><div class="legal">${map[kind] || priv}</div></main>`;
  return _brandShell(BRAND_NAME + ' — ' + (titles[kind] || 'Privacidade'), inner, false);
}
// NAO acrescentar os dominios novos aqui. Esta lista so serve de ULTIMO recurso no _presselDom
// (`PRESSEL_DOMS[length-1]`), pra pressel sem dominio salvo e sem host na requisicao. O ultimo
// elemento tem que ser um dominio que RESPONDE hoje; por um que ainda nao foi anexado e trocar um
// fallback que funciona por um que da erro de DNS.
const PRESSEL_DOMS = ['area-acesso.com', 'area-glico.fun', 'painel-glico.fun'];
// O DOMINIO DA PRESSEL E O DELA, NAO O NOSSO (27/08/2026).
//
// Isto exigia que o dominio estivesse na lista dos NOSSOS tres e, quando nao estava, devolvia
// 'painel-glico.fun' chumbado. Numa operacao que roda em dominio proprio (a do Giovane usa
// nutrapremium.sbs) a pressel dele aparecia na tela de Leads com o NOSSO endereco - ele ve o
// dominio da nossa operacao dentro da dash dele, e o link nem abre a pressel dele.
// A lista continua existindo pro que e NOSSO (as rotas de marca), mas ela nao manda mais no que
// se mostra: vale o dominio gravado na pressel e, sem ele, o host de quem esta pedindo a pagina -
// que e o proprio worker de cada operacao. Dominio de outra gente nunca mais entra por padrao.
const _hostOk = (h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(String(h || ''));
function _presselDom(p, host){
  const d = String((p && p.dominio) || '').trim();
  if (_hostOk(d)) return d;
  return _hostOk(host) ? String(host) : PRESSEL_DOMS[PRESSEL_DOMS.length - 1];
}
// GET /pressels-total — página PÚBLICA consolidada: TOTAL somando todas + cada pressel numa seção.
// Pega TODAS as pressels do estado automaticamente (pressel nova entra sozinha).
// CONVERSÃO POR NÚMERO. Painel só de MÉTRICA (não é aviso): pra cada número que rodou hoje, quantos
// cliques recebeu, quantos viraram lead e a %. Número a número, de cada atendente. O padrão da
// operação é 1-2% e isso é normal — por isso nada de "trocar chip", só o dado.
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
          GROUP BY num_key HAVING cliques >= 30`
      ).bind(ini, fim).all(),
      env.DB.prepare(
        "SELECT substr(replace(num,'+',''),-8) AS nk, COUNT(*) n FROM wa_lead WHERE ts>=? AND ts<? AND num IS NOT NULL AND num<>'' GROUP BY nk"
      ).bind(ini, fim).all(),
    ]);
    const k8=n=>String(n||'').replace(/\D/g,'').slice(-8);
    const fmtTel=(raw)=>{ let t=String(raw||'').replace(/\D/g,''); if(t.startsWith('55')&&t.length>11) t=t.slice(2); if(t.length>=10){ const ddd=t.slice(0,2), rest=t.slice(2); return '('+ddd+') '+rest.slice(0,rest.length-4)+'-'+rest.slice(-4); } return String(raw||''); };
    const leadDe={}; (lr.results||[]).forEach(x=>{ const k=String(x.nk||''); if(k) leadDe[k]=Number(x.n)||0; });
    const nums=(r.results||[]).map(x=>{
      const k=String(x.num_key||''), cl=Number(x.cliques)||0, cv=leadDe[k]||0;
      const c=chips.find(c=>k8(c.num)===k);
      return { k, cl, cv, taxa: cl?(cv*100/cl):0, nome: (c&&c.at)?(nameMap[String(c.at)]||String(c.at)):'', tel: c?fmtTel(c.num):fmtTel(k) };
    }).sort((a,b)=>b.cl-a.cl).slice(0,8);
    if(!nums.length) return '';
    const linhas=nums.map(x=>{
      const pct=x.taxa.toFixed(1)+'%';
      return `<div style="padding:9px 0;border-top:1px solid #1a2436">`
        + `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">`
        +   `<span style="font-family:ui-monospace,monospace;font-weight:700;color:#e6edf6;font-size:13px">${_escHtml(x.tel)}</span>`
        +   `<span style="font-weight:800;color:#7aa2ff;font-size:13px;font-variant-numeric:tabular-nums">${pct}</span>`
        + `</div>`
        + `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-top:2px">`
        +   `<span style="font-size:11px;color:#8b9bb4">${x.nome?_escHtml(x.nome):'—'}</span>`
        +   `<span style="font-size:11px;color:#8b9bb4;font-variant-numeric:tabular-nums"><b style="color:#cbd5e1">${x.cl}</b> cliques → <b style="color:#34d399">${x.cv}</b> lead${x.cv===1?'':'s'}</span>`
        + `</div>`
      + `</div>`;
    }).join('');
    return `<div style="background:#101827;border:1px solid #233047;border-radius:12px;padding:14px 16px">`
      + `<div style="font-size:13px;font-weight:800;color:#e6edf6">Conversão por número</div>`
      + `<div style="font-size:10.5px;color:#8b9bb4;margin:2px 0 4px">quanto de clique virou lead, número a número</div>`
      + linhas
      + `</div>`;
  }catch(_){ return ''; }
}
// Dados da "Conversão por número" (mesma query do _roletaDiagHtml, pra dash renderizar nativo).
async function _roletaDiagData(env, day, chips, nameMap){
  try{
    const ini=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), fim=ini+86400;
    const [r, lr] = await Promise.all([
      env.DB.prepare(
        `SELECT num_key, COUNT(*) cliques FROM tt_pending
          WHERE ts>=? AND ts<? AND num_key IS NOT NULL AND num_key<>''
          GROUP BY num_key HAVING cliques >= 30`
      ).bind(ini, fim).all(),
      env.DB.prepare(
        "SELECT substr(replace(num,'+',''),-8) AS nk, COUNT(*) n FROM wa_lead WHERE ts>=? AND ts<? AND num IS NOT NULL AND num<>'' GROUP BY nk"
      ).bind(ini, fim).all(),
    ]);
    const k8=n=>String(n||'').replace(/\D/g,'').slice(-8);
    const fmtTel=(raw)=>{ let t=String(raw||'').replace(/\D/g,''); if(t.startsWith('55')&&t.length>11) t=t.slice(2); if(t.length>=10){ const ddd=t.slice(0,2), rest=t.slice(2); return '('+ddd+') '+rest.slice(0,rest.length-4)+'-'+rest.slice(-4); } return String(raw||''); };
    const leadDe={}; (lr.results||[]).forEach(x=>{ const k=String(x.nk||''); if(k) leadDe[k]=Number(x.n)||0; });
    return (r.results||[]).map(x=>{
      const k=String(x.num_key||''), cl=Number(x.cliques)||0, cv=leadDe[k]||0;
      const c=chips.find(c=>k8(c.num)===k);
      return { cl, cv, taxa: cl?(cv*100/cl):0, nome: (c&&c.at)?(nameMap[String(c.at)]||String(c.at)):'', tel: c?fmtTel(c.num):fmtTel(k) };
    }).sort((a,b)=>b.cl-a.cl).slice(0,8);
  }catch(_){ return []; }
}
// MESMA computação da página /pressels-total, mas devolve DADOS estruturados pra dash renderizar nativo
// (sem iframe). full = diretor logado → número completo; senão mascarado (…1234). Espelha exatamente a
// lógica da página HTML (atribuição, ranking, split de vendedor, agregação de comprador).
async function _presselsTotalData(env, day, view, per, full, _uAtual, _host){
  // DUAS ECONOMIAS DE ESPERA, e as duas doiam: esta tela e a que o Bruno mais abre e levava de 1,2 a
  // 2,0 SEGUNDOS pra devolver menos de 1 KB - era tudo ida e volta ao banco, uma esperando a outra.
  //  (a) o blob vinha de um SELECT cru, relido e reparseado (275 KB) a CADA requisicao, ignorando o
  //      _getDashData, que ja guarda o mesmo objeto por 8s. Esta funcao so LE o data (conferido),
  //      entao pode usar o cache compartilhado sem risco de sujar o estado de ninguem.
  //  (b) a lista de usuarios nao depende do blob: as duas saem juntas em vez de em fila.
  const [data, us] = await Promise.all([
    _getDashData(env).catch(() => ({})),
    env.DB.prepare('SELECT id, name, COALESCE(archived,0) AS archived FROM users').all().catch(() => null),
  ]);
  // Recorte por dono: o afiliado ve so as pressels dele nesta tela inteira (metricas, pedidos e
  // leads). Filtrar aqui, na origem, cobre os tres modos de uma vez.
  const _idsOk = _presselIdsVisiveis(_uAtual, data);
  const pressels=(Array.isArray(data.pressels)?data.pressels:[]).filter(p=>!_idsOk||_idsOk.has(String(p&&p.id)));
  // Os chips entram no _vendCell, que anexa os 4 ultimos digitos do numero na linha do vendedor.
  // Sem recorte, o afiliado veria o final dos NOSSOS numeros.
  const _meuMundoChip = _idsOk ? (isAfiliado(_uAtual) ? aflDe(_uAtual) : '\u0000') : null;
  const chips=(Array.isArray(data.chips)?data.chips:[]).filter(c=>!_idsOk||String((c&&c.afl)||'')===String(_meuMundoChip||''));
  let nameMap={};
  const _arquivados=new Set(); let _temUsers=false;
  try{ ((us&&us.results)||[]).forEach(u=>{nameMap[String(u.id)]=u.name; if(Number(u.archived)) _arquivados.add(String(u.id));}); _temUsers=((us&&us.results)||[]).length>0; }catch(_){}
  const today=_brDay(); const isToday=(day===today);
  const out={ ok:true, view, per, day, today, isToday, full:!!full };
  // "Conversão por número" (diagnóstico de chip queimando) expõe telefone completo do atendente +
  // conversão por número: é privado do diretor. GT/vendedor NÃO vê perda (regra gt-nao-ve-perda).
  // O DIAGNOSTICO LATERAL E AS METRICAS DO DIA NAO DEPENDEM UM DO OUTRO, entao saem juntos. Antes o
  // `await` aqui segurava tudo: o diagnostico ia inteiro (varias consultas) e SO DEPOIS comecavam as
  // metricas. Agora os dois disparam e a espera e a do mais lento, nao a soma.
  const pDiag = full ? _roletaDiagData(env, day, chips, nameMap).catch(() => []) : Promise.resolve([]);
  const pMetr = _presselDayMetrics(env, day).catch(() => null);
  const _vAt=(inst)=>_atFromInst(inst);
  const _emUsoIds=new Set(['em_uso']);
  try{ (Array.isArray(data.wa_statuses)?data.wa_statuses:[]).forEach(s=>{ const lbl=String((s&&(s.label||s.id))||'').toLowerCase().replace(/[_\s]+/g,' ').trim(); if(lbl==='em uso' && s && s.id) _emUsoIds.add(String(s.id)); }); }catch(_){}
  const _isEmUso=(c)=> !!c && (c.em_uso===true || c.em_uso===1 || _emUsoIds.has(String(c.wa_st||'')));
  const _chipsDo=(at)=>chips.filter(c=>String(c.at)===String(at) && c.st!=='aquecimento' && c.st!=='banido');
  const _splitAts=new Set();
  pressels.forEach(p=>(p.vendedores||[]).forEach(v=>{ if(!v||!v.at||v.reserva_mode!=='split'||v.reserva_on===false) return; const mine=_chipsDo(v.at); if(mine.some(_isEmUso)&&mine.some(c=>c.bkp===true)) _splitAts.add(String(v.at)); }));
  // TODOS os "Em uso" (roleta multi-número). Fora do diretor o número sai MASCARADO: esta tela é a
  // que o gestor de tráfego usa, e o telefone dos chips é o ativo mais sensível da operação (é o que
  // permite mapear a roleta inteira por fora). Ele precisa do volume por vendedor, não do número.
  // Numero sempre no MESMO formato. O chip e cadastrado a mao e vem de dois jeitos no banco
  // ("(15) 99125-8028" e "8291215713"), e a tabela mostrava um de cada, o que parece defeito.
  const _fmtFone=(n)=>{ const d=String(n||'').replace(/\D/g,'').replace(/^55/,''); if(d.length<10) return String(n||'—'); const ddd=d.slice(0,2), r=d.slice(2); return '(' + ddd + ') ' + r.slice(0, r.length-4) + '-' + r.slice(-4); };
  const _vendCell=(at)=>{ at=String(at); const mine=_chipsDo(at); let nums=mine.filter(_isEmUso).map(c=>c.num).filter(Boolean); if(!nums.length){ const any=mine[0]; nums.push((any&&any.num)||'—'); } nums=full?nums.map(_fmtFone):nums.map(n=>{ const p=String(n||'').replace(/\D/g,''); return p?('…'+p.slice(-4)):'—'; }); return {at, name:nameMap[at]||'Vendedor', nums, contatos:0, vendas:0}; };
  const _rankVend=(vend)=>{ const cv=(x)=>{ const c=Number(x.contatos)||0; return c>0?(Number(x.vendas)||0)/c:0; }; return (vend||[]).slice().sort((a,b)=> ((Number(b.vendas)||0)-(Number(a.vendas)||0)) || (cv(b)-cv(a)) || ((Number(b.contatos)||0)-(Number(a.contatos)||0))); };
  // ── QUEM APARECE NA TABELA POR VENDEDOR ─────────────────────────────────────
  //
  // Ela listava TODO mundo cadastrado na pressel, e o Bruno abriu em 18/08/2026 com cinco linhas onde
  // duas trabalhavam: aparecia um vendedor ARQUIVADO havia semanas, o socio (que nao atende), e uma
  // linha "Vendedor" sem numero, que e um balde interno (__sd) sem usuario nenhum atras. Tabela cheia
  // de gente que nao trabalha esconde o que importa, que e quem esta recebendo lead agora.
  //
  // A regra: entra quem PRODUZIU no periodo (contato ou venda) ou quem esta NA ESCALA agora, isto e,
  // tem numero "Em uso" e nao esta desligado no interruptor da pressel. Assim, no comeco do dia quem
  // esta de plantao aparece com zero (e certo: ele esta recebendo), e quem saiu de operacao nao volta.
  // Arquivado nunca entra. `at` sem usuario no banco tambem nao - esse corte so vale quando a lista de
  // usuarios carregou, senao uma falha na consulta esvaziaria a tabela inteira.
  const _naEscala=(p, at)=>{
    const v=(p&&(p.vendedores||[])).find(x=>x&&String(x.at)===String(at));
    if(!v || v.ativo===false) return false;
    const off=v.off||{};
    return _chipsDo(at).some(c=>_isEmUso(c) && !off[String(c.num||'').replace(/\D/g,'').slice(-8)] && !off[String(c.id)]);
  };
  const _vendVisivel=(x, p)=>{
    const at=String((x&&x.at)||'');
    if(!at) return false;
    if(_arquivados.has(at)) return false;
    if(_temUsers && !nameMap[at]) return false;
    if(Number(x.contatos)>0 || Number(x.vendas)>0) return true;
    return p ? _naEscala(p, at) : pressels.some(pp=>_naEscala(pp, at));
  };
  const pad=n=>String(n).padStart(2,'0');
  const fmtNum=n=>{ n=String(n||'').replace(/\D/g,''); if(!n) return ''; return n.startsWith('55')?n.slice(2):n; };
  const mask=ph=>{ const p=String(ph||'').replace(/\D/g,''); return p?('…'+p.slice(-4)):''; };
  const baseAt=inst=>_atFromInst(inst)||'?';
  const byName=(a,b)=>String(nameMap[a]||a).localeCompare(String(nameMap[b]||b));

  if(view==='metricas'){
    const M=await pMetr;
    // RECORTE DAS METRICAS CRUAS (25/08/2026). Erro critico que o Bruno pegou: a Chegada de leads
    // do afiliado mostrava "2 vendas" com ZERO pressels dele. O filtro por dono cortava so a LISTA
    // de pressels; o cartao TOTAL vinha de M.vendasInst e a tabela por vendedor de M.contatosVI,
    // que sao mapas da operacao INTEIRA e nao sabem de quem e a pressel.
    //
    // Aqui as duas fontes viram copias podadas ANTES de qualquer soma:
    //   _cvi  = contatos por instancia, so das pressels que ele pode ver;
    //   _vinst = vendas por instancia, reconstruidas a partir de vendasVI das pressels dele
    //            (vendasInst e por instancia e nao guarda de qual pressel veio, entao nao da pra
    //             filtrar; tem que remontar).
    // Com _idsOk null (diretor e gestor), copia tudo e a conta do Bruno nao muda em nada.
    const _cvi = {}, _vinst = {};
    for (const pid of Object.keys(M.contatosVI || {})) {
      if (_idsOk && !_idsOk.has(String(pid))) continue;
      _cvi[pid] = M.contatosVI[pid];
    }
    if (!_idsOk) {
      Object.assign(_vinst, M.vendasInst || {});
    } else {
      for (const pid of Object.keys(M.vendasVI || {})) {
        if (!_idsOk.has(String(pid))) continue;
        for (const inst of Object.keys(M.vendasVI[pid] || {})) {
          const n = Number(M.vendasVI[pid][inst]) || 0;
          const e = _vinst[inst] || (_vinst[inst] = { v: 0, val: 0 });
          e.v += n;
        }
      }
    }
    const secs=pressels.map(p=>{
      const pid=String(p.id), vc=M.vc[pid]||{}, cvi=M.contatosVI[pid]||{}, vvi=M.vendasVI[pid]||{};
      const vm={}; const ens=(at)=>{ at=String(at); if(at && !vm[at]) vm[at]=_vendCell(at); };
      (p.vendedores||[]).filter(v=>v.ativo!==false).forEach(v=>ens(v.at));
      Object.keys(cvi).forEach(inst=>ens(_vAt(inst)));
      Object.keys(vvi).forEach(inst=>ens(_vAt(inst)));
      Object.keys(cvi).forEach(inst=>{ const at=_vAt(inst); if(vm[at]) vm[at].contatos+=Number(cvi[inst])||0; });
      Object.keys(vvi).forEach(inst=>{ const at=_vAt(inst); if(vm[at]) vm[at].vendas+=Number(vvi[inst])||0; });
      return {id:String(p.id), nome:p.nome||('Pressel '+p.id), url:'https://'+_presselDom(p,_host)+'/p/'+_presselRefPub(p), views:Number(vc.views)||0, clicks:Number(vc.clicks)||0, contatos:M.contatos[pid]||0, vendas:M.vendas[pid]||0, vend:_rankVend(Object.values(vm).filter(x=>_vendVisivel(x,p)))};
    });
    const tot=secs.reduce((a,s)=>({views:a.views+s.views, clicks:a.clicks+s.clicks, contatos:a.contatos+s.contatos, vendas:a.vendas+s.vendas}), {views:0,clicks:0,contatos:0,vendas:0});
    // O override existe pra contar venda que chegou SEM pid (nao casou com pressel). Pro afiliado
    // isso nao vale: venda sem pressel identificada nao e dele, e era exatamente o caminho pelo
    // qual as nossas 2 vendas entravam no total dele. Com corte, o total e a soma das pressels dele.
    if (!_idsOk) tot.vendas=Object.values(M.vendasInst||{}).reduce((a,x)=>a+(Number(x.v)||0),0);
    const _vt={}; const _vtEns=(k)=>{ k=String(k); if(k && !_vt[k]) _vt[k]=_vendCell(k); };
    pressels.forEach(p=>(p.vendedores||[]).filter(v=>v.ativo!==false).forEach(v=>_vtEns(v.at)));
    Object.keys(_cvi).forEach(pid=>Object.keys(_cvi[pid]).forEach(inst=>_vtEns(_vAt(inst))));
    Object.keys(_vinst).forEach(inst=>_vtEns(_vAt(inst)));
    Object.keys(_cvi).forEach(pid=>Object.keys(_cvi[pid]).forEach(inst=>{ const at=_vAt(inst); if(_vt[at]) _vt[at].contatos+=Number(_cvi[pid][inst])||0; }));
    Object.keys(_vinst).forEach(inst=>{ const at=_vAt(inst); if(_vt[at]) _vt[at].vendas+=Number((_vinst[inst]||{}).v)||0; });
    out.total=tot; out.pressels=secs; out.totVend=_rankVend(Object.values(_vt).filter(x=>_vendVisivel(x,null)));
    // Investido no MESMO periodo que a tela esta mostrando. Em 'mes' pega o mes inteiro do dia
    // escolhido; no resto, o dia. So pra quem ve tudo (o gestor de trafego nao ve dinheiro).
    if (full) {
      const de = (per === 'mes') ? (day.slice(0, 7) + '-01') : day;
      const ate = (per === 'mes') ? (day.slice(0, 7) + '-31') : day;
      out.gasto = await _ttGasto(env, de, ate);
      // CPA NA LATERAL (pedido do Bruno em 20/08/2026, os mesmos dois numeros do Dashboard de
      // Trafego, pra tela nenhuma contar diferente da outra):
      //   por pedido -> investido / pedidos fechados. Assume que todo pedido paga.
      //   real       -> investido / pedidos que PAGARAM. Sempre maior, porque COD nem sempre paga.
      // `pagos` nao existia neste payload (tot.vendas e pedido fechado, nao pago), entao conta aqui.
      try {
        const ini = Math.floor(new Date(de + 'T00:00:00-03:00').getTime() / 1000);
        const fim = Math.floor(new Date(ate + 'T23:59:59-03:00').getTime() / 1000);
        const pg = await env.DB.prepare(
          "SELECT COUNT(*) n FROM five_orders WHERE charge_status='PAID' AND created_at >= ? AND created_at <= ?"
        ).bind(ini, fim).first();
        const inv = Number(out.gasto && out.gasto.valor) || 0;
        const ped = Number(tot && tot.vendas) || 0;
        const pagos = Number(pg && pg.n) || 0;
        out.cpa = {
          investido: inv, pedidos: ped, pagos,
          porPedido: ped > 0 && inv > 0 ? inv / ped : 0,
          real: pagos > 0 && inv > 0 ? inv / pagos : 0,
        };
      } catch (_) { out.cpa = null; }
    }
  } else if(view==='vendas'){
    let orders=[];
    try{
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}
      const dstart=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), dend=dstart+86400;
      const r=await env.DB.prepare("SELECT s.name, s.phone phone, s.instance, s.value, s.ts, l.pid pid, l.src src FROM wa_sales s LEFT JOIN wa_lead l ON l.phone=s.phone WHERE s.ts>=? AND s.ts<? ORDER BY s.ts DESC LIMIT 300").bind(dstart,dend).all();
      orders=r.results||[];
    }catch(_){}
    const _pnm={}; pressels.forEach(pp=>{ _pnm[String(pp.id)]=pp.nome||('Pressel '+pp.id); });
    out.totV=orders.reduce((a,o)=>a+(Number(o.value)||0),0);
    out.nP=orders.filter(o=>o.pid&&String(o.pid).trim()!=='').length; out.nS=orders.length-out.nP; out.count=orders.length;
    out.orders=orders.map(o=>{ const at=baseAt(o.instance); const attr=!!(o.pid&&String(o.pid).trim()!==''); const ph=String(o.phone||'').replace(/\D/g,''); return { at, name:o.name||'Cliente', seller:nameMap[at]||o.instance||'—', value:Number(o.value)||0, ts:Number(o.ts||0), attr, pnome:attr?(_pnm[String(o.pid)]||('Pressel '+o.pid)):'', aprox:o.src==='fifo', phone: full?ph:'', phoneFmt: full?fmtNum(ph):mask(ph) }; });
  } else if(view==='leads' && per==='mes'){
    const dP=day.split('-'); const mY=+dP[0], mM=+dP[1];
    const monthStart=Math.floor(new Date(dP[0]+'-'+dP[1]+'-01T00:00:00-03:00').getTime()/1000);
    const nY=mM===12?mY+1:mY, nM=mM===12?1:mM+1;
    const monthEnd=Math.floor(new Date(nY+'-'+pad(nM)+'-01T00:00:00-03:00').getTime()/1000);
    const mNames=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    out.monthLabel=mNames[mM-1]+'/'+mY;
    let mLeads=[], mSales=[];
    try{
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN num TEXT').run(); }catch(_){}
      const lr=await env.DB.prepare("SELECT phone, inst, ts FROM wa_lead WHERE ts>=? AND ts<?").bind(monthStart,monthEnd).all(); mLeads=lr.results||[];
      const sr=await env.DB.prepare("SELECT phone, instance, name, value, ts FROM wa_sales WHERE ts>=? AND ts<? ORDER BY ts ASC").bind(monthStart,monthEnd).all(); mSales=sr.results||[];
    }catch(_){}
    const lByAt={}; mLeads.forEach(l=>{ const at=baseAt(l.inst); (lByAt[at]=lByAt[at]||[]).push(l); });
    const buyerInfo={}; mSales.forEach(s=>{ const p=String(s.phone||'').replace(/\D/g,''); if(!p) return; const v=Number(s.value)||0, t=Number(s.ts||0); if(!buyerInfo[p]){ buyerInfo[p]={value:v,ts:t,name:s.name||''}; } else { buyerInfo[p].value+=v; if(t>=buyerInfo[p].ts){ buyerInfo[p].ts=t; if(s.name) buyerInfo[p].name=s.name; } } });
    const _mc=(at)=>(lByAt[at]||[]).reduce((s,l)=>{ const p=String(l.phone||'').replace(/\D/g,''); return s+((p&&buyerInfo[p])?1:0); },0);
    const _mr=(at)=>(lByAt[at]||[]).reduce((s,l)=>{ const p=String(l.phone||'').replace(/\D/g,''); const b=p?buyerInfo[p]:null; return s+(b?(Number(b.value)||0):0); },0);
    const allAts=Object.keys(lByAt).filter(a=>a&&a!=='?').sort((a,b)=>{ const ca=_mc(a), cb=_mc(b), la=(lByAt[a]||[]).length, lb=(lByAt[b]||[]).length; const pa=la>0?ca/la:0, pb=lb>0?cb/lb:0; return (cb-ca)||(pb-pa)||(_mr(b)-_mr(a))||(lb-la)||byName(a,b); });
    if(lByAt['?']) allAts.push('?');
    let totComp=0, totRev=0; mLeads.forEach(l=>{ const p=String(l.phone||'').replace(/\D/g,''); if(!p) return; const b=buyerInfo[p]; if(b){ totComp++; totRev+=Number(b.value)||0; } });
    out.totLeads=mLeads.length; out.totComp=totComp; out.totRev=totRev;
    out.sellers=allAts.map(at=>{
      const name=nameMap[at]||(at==='?'?'Sem vendedor':'Vendedor');
      const arrL=lByAt[at]||[]; const lc=arrL.length;
      const buyers=[]; const bseen=new Set();
      arrL.forEach(l=>{ const p=String(l.phone||'').replace(/\D/g,''); if(!p||bseen.has(p)) return; bseen.add(p); const b=buyerInfo[p]; if(b) buyers.push({phone:p,value:b.value,ts:b.ts,name:b.name}); });
      buyers.sort((a,b)=>(Number(b.ts||0)-Number(a.ts||0)));
      const comp=buyers.length; const rev=buyers.reduce((a,b)=>a+(Number(b.value)||0),0);
      return { name, leads:lc, comp, rev, pct: lc>0?Math.round(comp/lc*100):null, buyers: buyers.map(b=>({ phone: full?b.phone:'', phoneFmt: full?fmtNum(b.phone):mask(b.phone), value:Number(b.value)||0, ts:Number(b.ts||0), name:b.name||'' })) };
    });
  } else {
    let leads=[]; let saleSet=new Set(); const nameByPhone={};
    const dstart=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), dend=dstart+86400;
    try{
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN num TEXT').run(); }catch(_){}
      try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}
      const r=await env.DB.prepare("SELECT phone, inst, num, pid, src, ts FROM wa_lead WHERE ts>=? AND ts<? ORDER BY ts ASC").bind(dstart,dend).all(); leads=r.results||[];
      try{ const sr=await env.DB.prepare("SELECT DISTINCT phone FROM wa_sales WHERE ts>=?").bind(dstart).all(); (sr.results||[]).forEach(x=>{ const p=String(x.phone||'').replace(/\D/g,''); if(p) saleSet.add(p); }); }catch(_){}
      try{ const nr=await env.DB.prepare("SELECT c.phone, c.name FROM wa_chats c JOIN (SELECT DISTINCT phone FROM wa_lead WHERE ts>=? AND ts<?) l ON l.phone=c.phone WHERE c.name IS NOT NULL AND c.name<>''").bind(dstart,dend).all(); (nr.results||[]).forEach(x=>{ const p=String(x.phone||'').replace(/\D/g,''); if(p&&x.name) nameByPhone[p]=String(x.name); }); }catch(_){}
    }catch(_){}
    const isSale=ph=>!!(ph&&saleSet.has(ph));
    const _pnm={}; pressels.forEach(pp=>{ _pnm[String(pp.id)]=pp.nome||('Pressel '+pp.id); });
    const byAt={}; leads.forEach(l=>{ const at=baseAt(l.inst); (byAt[at]=byAt[at]||[]).push(l); });
    const _dv=(at)=>(byAt[at]||[]).reduce((s,l)=>s+(isSale(String(l.phone||'').replace(/\D/g,''))?1:0),0);
    const ats=Object.keys(byAt).filter(at=>(byAt[at]||[]).length).sort((a,b)=>{ const va=_dv(a), vb=_dv(b), la=byAt[a].length, lb=byAt[b].length; const pa=la>0?va/la:0, pb=lb>0?vb/lb:0; return (vb-va)||(pb-pa)||(lb-la)||byName(a,b); });
    out.sellers=ats.map(at=>{
      const arr=byAt[at]; const name=nameMap[at]||'Vendedor';
      const daP=arr.filter(l=>l.pid&&String(l.pid).trim()!=='').length;
      const byNum={}, numOrder=[];
      arr.forEach(l=>{ const k=String(l.num||''); if(!(k in byNum)){ byNum[k]=[]; numOrder.push(k); } byNum[k].push(l); });
      const nums=numOrder.map(k=>({ num:fmtNum(k)||'número não registrado', count:byNum[k].length, leads: byNum[k].map(l=>{ const ph=String(l.phone||'').replace(/\D/g,''); const bt=new Date((Number(l.ts||0)-10800)*1000); const hora=isNaN(bt)?'':`${pad(bt.getUTCHours())}:${pad(bt.getUTCMinutes())}`; const attr=!!(l.pid&&String(l.pid).trim()!==''); return { hora, phone: full?ph:'', phoneFmt: full?(fmtNum(ph)||''):(ph?('…'+ph.slice(-4)):''), nome:nameByPhone[ph]||'', attr, pnome: attr?(_pnm[String(l.pid)]||'pressel'):'', sale:isSale(ph) }; }) }));
      return { name, total:arr.length, daP, nums };
    });
    out.totL=leads.length; out.totP=leads.filter(l=>l.pid&&String(l.pid).trim()!=='').length;
  }
  // O painel lateral vale pra TODAS as abas, como era antes de eu paralelizar. Se ficasse so dentro
  // do ramo 'metricas', ele sumiria em Pedidos e Leads sem ninguem pedir.
  out.side = await pDiag;
  return out;
}
// GET /pressels-total.json — mesmos dados da página, em JSON, pra dash renderizar nativo. Auth por Bearer.
// ── QUANTO JA SE GASTOU EM ANUNCIO NO PERIODO ────────────────────────────────
//
// O Bruno pediu em 18/08/2026 o investido do periodo em cima do "Conversao por numero", pra ver o
// gasto junto do resultado sem abrir o gerenciador do TikTok.
//
// DUAS FONTES, nesta ordem:
//  1. TIKTOK AO VIVO, quando existirem `tt_ads_token` e `tt_advertiser_id` no app_config. O token do
//     pixel que temos hoje NAO SERVE: ele e de Events API e o TikTok recusa leitura de relatorio com
//     ele ("advertiser does not grant you /pixel/list/:GET permission", conferido no dia). Precisa de
//     token com escopo de Reporting/Ads Management.
//  2. LANCADO A MAO, enquanto o token nao vem: soma data.trafego_registros do periodo e, na falta
//     dele, os gastos do ContaSimples com cara de TikTok. Assim o cartao ja nasce com numero de
//     verdade em vez de zero, e a tela diz de onde veio.
//
// A resposta carrega `fonte` de proposito: numero de dinheiro sem origem e o comeco de toda
// discussao boba sobre "esse valor esta certo?".
async function _ttGasto(env, de, ate) {
  const cacheKey = 'ttgasto:' + de + ':' + ate;
  try {
    const c = JSON.parse((await _readConfig(env, cacheKey)) || 'null');
    if (c && (Math.floor(Date.now() / 1000) - Number(c.ts || 0)) < 300) return c;   // 5 min
  } catch (_) {}
  let out = { valor: 0, fonte: 'sem_dado', moeda: 'BRL', ts: Math.floor(Date.now() / 1000) };
  const token = await _readConfig(env, 'tt_ads_token');
  const adv = await _readConfig(env, 'tt_advertiser_id');
  if (token && adv) {
    try {
      const qs = new URLSearchParams({
        advertiser_id: String(adv), report_type: 'BASIC', data_level: 'AUCTION_ADVERTISER',
        dimensions: JSON.stringify(['advertiser_id']), metrics: JSON.stringify(['spend']),
        start_date: de, end_date: ate, page_size: '1',
      });
      const r = await fetch('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?' + qs.toString(), {
        headers: { 'Access-Token': token, 'Accept': 'application/json', 'User-Agent': 'SellWave/1.0 (+https://sellwave.com.br)' },
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && String(j.code) === '0') {
        const lista = (j.data && j.data.list) || [];
        const soma = lista.reduce((a, x) => a + (Number(x && x.metrics && x.metrics.spend) || 0), 0);
        out = { valor: soma, fonte: 'tiktok', moeda: 'BRL', ts: Math.floor(Date.now() / 1000) };
      } else {
        out.erro = 'tiktok: ' + String(j.message || ('HTTP ' + r.status)).slice(0, 120);
      }
    } catch (e) { out.erro = 'tiktok: ' + String((e && e.message) || e).slice(0, 120); }
  }
  if (out.fonte !== 'tiktok') {
    // Lancado a mao. `dia` e YYYY-MM-DD nos registros de trafego; nos gastos do ContaSimples a data
    // vem 'DD/MM', entao compara pelo par dia+mes dentro do intervalo.
    try {
      const data = await _getDashData(env);
      const regs = (Array.isArray(data.trafego_registros) ? data.trafego_registros : [])
        .filter((x) => { const d = String((x && x.dia) || '').slice(0, 10); return d >= de && d <= ate; });
      if (regs.length) {
        out = { valor: regs.reduce((a, x) => a + (Number(x.total) || 0), 0), fonte: 'manual', moeda: 'BRL', ts: Math.floor(Date.now() / 1000) };
      } else {
        const dentro = (ddmm) => {
          const m = String(ddmm || '').match(/^(\d{2})\/(\d{2})/); if (!m) return false;
          const iso = de.slice(0, 4) + '-' + m[2] + '-' + m[1];
          return iso >= de && iso <= ate;
        };
        const g = (Array.isArray(data.gastos) ? data.gastos : [])
          .filter((x) => /tiktok|bytedance/i.test(String((x && x.campanha) || '')) && dentro(x && x.data));
        if (g.length) out = { valor: g.reduce((a, x) => a + (Number(x.valor) || 0), 0), fonte: 'contasimples', moeda: 'BRL', ts: Math.floor(Date.now() / 1000) };
      }
    } catch (_) {}
  }
  try { await _writeConfig(env, cacheKey, JSON.stringify(out)); } catch (_) {}
  return out;
}

// ANALISE DE ANUNCIOS DO TIKTOK (27/08/2026, pedido do Bruno). Tudo sai do NOSSO banco: o
// `tt_pending.utm` guarda campanha, conjunto e ad_id de cada visita (11.903 de 12.365 nos ultimos
// 7 dias, 96%), o `wa_lead` guarda uma copia do utm no momento em que o lead nasce e o `wa_sales`
// fecha a venda. Ou seja o funil anuncio -> visita -> lead -> venda fecha INTEIRO sem falar com o
// TikTok. Ler relatorio pela API deles so acrescenta gasto/impressao/CPM, e isso depende de um
// token que ainda nao existe (ver handleTtAdsConfig).
//
// ROTA PROPRIA, E SO DIRETOR, de proposito. A tela usa `verTudo = !isGestor(role)` pra decidir as
// abas, e isso da true pro AFILIADO. O recorte por dono (_presselIdsVisiveis) filtra data.pressels
// e NAO alcanca tt_pending, entao pendurar isto no /pressels-total.json mostraria os nossos
// anuncios pro afiliado. Aqui o gate e isDirector e ponto.
//
// DUAS RESSALVAS QUE A TELA PRECISA DIZER, senao o numero mente:
//  - `clicked` NAO e toque no botao. Com o redirect ligado o go() dispara sozinho, entao a coluna
//    mede PERMANENCIA (~1s na pagina), nao intencao. Por isso ela se chama "Ficaram".
//  - tt_pending so tem quem chegou COM ttclid. Cerca de 35% dos acessos pagos chegam sem, entao o
//    denominador daqui e menor que o acesso real (pressel_hits). O KPI de acessos mostra os dois.
async function handleTtAnuncios(req, env){
  const u = await authUser(req, env);
  if (!u) return err('Não autenticado', 401);
  if (!isDirector(u)) return err('Só o diretor vê o desempenho dos anúncios', 403);
  const q = new URL(req.url).searchParams;
  const dias = Math.min(30, Math.max(1, Number(q.get('dias')) || 7));
  const de = Math.floor(Date.now()/1000) - dias*86400;
  const J = (c) => "json_extract(utm,'$." + c + "')";
  const one = async (sql, ...b) => { try { const r = await env.DB.prepare(sql).bind(...b).all(); return (r && r.results) || []; } catch(_) { return []; } };
  try{
    // Por ANUNCIO. A cauda e enorme e inutil (142 ad_id em 7 dias, mas 5 concentram 98% das
    // visitas e 93 tem UMA visita so: e variacao automatica do CBO, nao criativo novo). Corta em
    // 25 e a tela agrega o resto numa linha, pra ninguem achar que sumiu.
    const ads = await one(
      "SELECT " + J('ad_id') + " ad_id, " + J('utm_campaign') + " campanha, " + J('utm_content') + " criativo," +
      " COUNT(*) visitas, SUM(clicked) ficaram, SUM(claimed) leads" +
      " FROM tt_pending WHERE ts >= ? AND utm IS NOT NULL AND utm <> '' AND " + J('ad_id') + " IS NOT NULL" +
      " GROUP BY 1,2,3 ORDER BY 4 DESC", de);
    // Venda por anuncio: wa_sales -> wa_lead (phone e chave unica, o join nao infla) -> utm do lead.
    const vendas = await one(
      "SELECT json_extract(l.utm,'$.ad_id') ad_id, COUNT(*) vendas, COALESCE(SUM(s.value),0) receita" +
      " FROM wa_sales s JOIN wa_lead l ON l.phone = s.phone" +
      " WHERE s.ts >= ? AND l.utm IS NOT NULL AND l.utm <> '' GROUP BY 1", de);
    const vmap = {}; for (const v of vendas) if (v.ad_id) vmap[String(v.ad_id)] = v;
    // Por CAMPANHA (o corte que decide verba)
    const camps = await one(
      "SELECT " + J('utm_campaign') + " campanha, COUNT(*) visitas, SUM(clicked) ficaram, SUM(claimed) leads" +
      " FROM tt_pending WHERE ts >= ? AND utm IS NOT NULL AND utm <> '' GROUP BY 1 ORDER BY 2 DESC", de);
    // Serie diaria por campanha (mostra sozinha quando a verba trocou de criativo)
    const serie = await one(
      "SELECT date(ts,'unixepoch','-3 hours') dia, " + J('utm_campaign') + " campanha, COUNT(*) visitas, SUM(claimed) leads" +
      " FROM tt_pending WHERE ts >= ? AND utm IS NOT NULL AND utm <> '' GROUP BY 1,2 ORDER BY 1", de);
    // Hora do dia: metrica barata que ninguem tem hoje e que serve de argumento de dayparting.
    const horas = await one(
      "SELECT CAST(strftime('%H',ts,'unixepoch','-3 hours') AS INTEGER) h, COUNT(*) visitas, SUM(claimed) leads" +
      " FROM tt_pending WHERE ts >= ? GROUP BY 1 ORDER BY 1", de);
    // Contraste honesto: acesso REAL a pagina (inclui quem chegou sem ttclid) x o que da pra
    // atribuir. Sem isto a tela sugere que o TikTok mandou menos gente do que mandou.
    const hits = await one("SELECT COALESCE(SUM(hits),0) n FROM pressel_hits WHERE day >= date('now','-" + dias + " days')");
    const janela = await one("SELECT MIN(ts) a, MAX(ts) b FROM tt_pending");

    const nAds = ads.map((a) => { const v = vmap[String(a.ad_id)] || {}; return {
      ad_id: String(a.ad_id||''), campanha: String(a.campanha||'—'), criativo: String(a.criativo||'—'),
      visitas: Number(a.visitas)||0, ficaram: Number(a.ficaram)||0, leads: Number(a.leads)||0,
      vendas: Number(v.vendas)||0, receita: Number(v.receita)||0 }; });
    const top = nAds.slice(0, 25);
    const resto = nAds.slice(25);
    const kpi = {
      visitas: nAds.reduce((s,a)=>s+a.visitas,0),
      ficaram: nAds.reduce((s,a)=>s+a.ficaram,0),
      leads: nAds.reduce((s,a)=>s+a.leads,0),
      vendas: nAds.reduce((s,a)=>s+a.vendas,0),
      receita: nAds.reduce((s,a)=>s+a.receita,0),
      acessos: Number((hits[0]||{}).n)||0,
      anuncios: nAds.length,
    };
    return json({ ok:true, dias, de,
      kpi, top, outros: { n: resto.length, visitas: resto.reduce((s,a)=>s+a.visitas,0), leads: resto.reduce((s,a)=>s+a.leads,0) },
      campanhas: camps.map((c)=>({ campanha:String(c.campanha||'—'), visitas:Number(c.visitas)||0, ficaram:Number(c.ficaram)||0, leads:Number(c.leads)||0 })),
      serie: serie.map((x)=>({ dia:String(x.dia||''), campanha:String(x.campanha||'—'), visitas:Number(x.visitas)||0, leads:Number(x.leads)||0 })),
      horas: horas.map((x)=>({ h:Number(x.h)||0, visitas:Number(x.visitas)||0, leads:Number(x.leads)||0 })),
      // A tela avisa que o historico e curto: o cron apaga tt_pending com mais de 7 dias, entao
      // "semana passada" por anuncio simplesmente nao existe ainda.
      janela: { desde: Number((janela[0]||{}).a)||0, ate: Number((janela[0]||{}).b)||0, purga_dias: 7 },
    });
  } catch(e){ return err('Não consegui montar a análise: ' + String((e&&e.message)||e), 500); }
}
async function handlePresselsTotalJson(req, env){
  const u=await authUser(req, env);
  if(!u) return err('Não autenticado', 401);
  const full=isDirector(u);
  const url=new URL(req.url);
  let day=url.searchParams.get('day')||'';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) day=_brDay();
  else { const _dp=day.split('-'); if(+_dp[1]<1||+_dp[1]>12||+_dp[2]<1||+_dp[2]>31) day=_brDay(); }
  const today=_brDay(); if(day>today) day=today;
  const _vq=url.searchParams.get('view')||''; const view=(_vq==='vendas'||_vq==='leads')?_vq:'metricas';
  const _pq=url.searchParams.get('per')||''; const per=(_pq==='mes')?'mes':'dia';
  // Leads: o vendedor VÊ, mas só a carteira DELE (pedido do Bruno em 16/08/2026 — antes tomava
  // "Só o diretor vê os leads" em vermelho na tela). O diretor continua vendo todo mundo.
  // O corte é aqui no servidor, não no navegador: o lead dos outros nem sai daqui.
  const dados = await _presselsTotalData(env, day, view, per, full, u, (() => { try { return new URL(req.url).host; } catch (_) { return ''; } })());
  if (view === 'leads' && !full) {
    const meu = String(u.name || '').trim().toLowerCase();
    const meuId = String(u.id || '');
    dados.sellers = (dados.sellers || []).filter((s) => {
      const n = String(s.name || '').trim().toLowerCase();
      return n === meu || n === meuId;
    });
    dados.totL = (dados.sellers || []).reduce((soma, s) => soma + (s.total || 0), 0);
    dados.totP = (dados.sellers || []).reduce((soma, s) => soma + (s.daP || 0), 0);
    dados.escopo = 'meus';
  }
  // LEADS DO MES TAMBEM E POR VENDEDOR. O corte acima so pegava a aba de leads do DIA; no mes o
  // vendedor via os cartoes do topo com o numero da operacao inteira (137 leads, R$ 3.876) e a
  // propria linha dele logo abaixo com outro valor - dois numeros brigando na mesma tela.
  // E no lugar do FATUROU ele ve COMISSAO PREVISTA: faturamento e numero do dono; o que interessa
  // pro vendedor e quanto daquilo e dele. Sai calculado aqui pra taxa dele nao viajar pro navegador.
  // ABA PEDIDOS: mesma regra da aba Leads, que ate agora nao valia aqui. Sem este corte o vendedor
  // recebia nome do cliente, valor e VENDEDOR de toda a empresa, mais o faturamento do dia no
  // cartao do topo. O corte de leads compara por NOME (fragil: dois 'Murilo' se confundem); aqui
  // uso o ID que veio na propria linha, que e o dono da instancia que fechou a venda.
  if (view === 'vendas' && !full) {
    const meuId = String(u.id || '');
    dados.orders = (dados.orders || []).filter((o) => String(o.at || '') === meuId);
    dados.totV = dados.orders.reduce((soma, o) => soma + (Number(o.value) || 0), 0);
    dados.nP = dados.orders.filter((o) => o.attr).length;
    dados.nS = dados.orders.length - dados.nP;
    dados.count = dados.orders.length;
    dados.escopo = 'meus';
  }

  if (view === 'leads' && per === 'mes' && !full) {
    const meu = String(u.name || '').trim().toLowerCase();
    const meuId = String(u.id || '');
    dados.sellers = (dados.sellers || []).filter((s) => {
      const n = String(s.name || '').trim().toLowerCase();
      return n === meu || n === meuId;
    });
    dados.totLeads = dados.sellers.reduce((a2, s2) => a2 + (Number(s2.leads) || 0), 0);
    dados.totComp = dados.sellers.reduce((a2, s2) => a2 + (Number(s2.comp) || 0), 0);
    dados.totRev = dados.sellers.reduce((a2, s2) => a2 + (Number(s2.rev) || 0), 0);
    const pct = Number(u.com_pct) || 0;
    dados.totCom = Math.round(dados.totRev * pct) / 100;   // comissao prevista sobre o que ele vendeu
    dados.comPct = pct;
    dados.escopo = 'meus';
  }
  return json(dados);
}
async function handlePresselsTotalPage(req, env){
  // Host de quem pediu: e o dominio da operacao dona desta pagina. Serve de padrao quando a
  // pressel nao tem dominio proprio gravado (ver _presselDom).
  const _hostReq = (() => { try { return new URL(req.url).host; } catch (_) { return ''; } })();
  const row=await env.DB.prepare('SELECT data FROM dashboard_state WHERE id = 1').first();
  let data={}; try{ data=JSON.parse(row?.data||'{}'); }catch(_){}
  // ESTA PAGINA E PUBLICA DE PROPOSITO (o gestor de trafego abre sem login), mas quem chega com
  // SESSAO de afiliado nao pode ver a nossa: a varredura de 25/08 achou "BM Br", "Guilherme" e
  // "Murilo" servidos pro token do afiliado. Aqui o recorte vale quando ha sessao identificada;
  // sem sessao, a pagina segue como sempre foi.
  // (O acesso anonimo por URL continua existindo e e decisao antiga - ver memoria gt-nao-ve-perda.)
  let _idsPag = null;
  try {
    const _up = await authUser(req, env);
    if (_up) _idsPag = _presselIdsVisiveis(_up, data);
  } catch (_) { /* sem sessao: pagina publica normal */ }
  const _donoPag = _idsPag ? ' ' : null;
  const pressels=(Array.isArray(data.pressels)?data.pressels:[]).filter(p=>!_idsPag||_idsPag.has(String(p&&p.id)));
  const chips=(Array.isArray(data.chips)?data.chips:[]).filter(c=>!_idsPag||String((c&&c.afl)||'')!==String(_donoPag));
  let day=new URL(req.url).searchParams.get('day')||'';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) day=_brDay();
  else { const _dp=day.split('-'); if(+_dp[1]<1||+_dp[1]>12||+_dp[2]<1||+_dp[2]>31) day=_brDay(); }   // rejeita mês/dia impossível (ex: 2026-00-01)
  const today=_brDay(); if(day>today) day=today;   // seletor de data (não deixa escolher o futuro)
  const isToday=(day===today);
  const _vq=new URL(req.url).searchParams.get('view')||''; let view=(_vq==='vendas'||_vq==='leads')?_vq:'metricas';   // alterna Métricas / Pedidos / Leads
  // Modo completo (números de lead sem máscara + clicáveis + copiar): SÓ com sessão válida (token da dash via ?k=).
  // Sem token → página pública mostra só o final do número (protege os leads, que são o ativo da empresa).
  const kParam=new URL(req.url).searchParams.get('k')||'';
  let full=false;
  // Só libera modo completo pra DIRETOR/SÓCIO ativo (não arquivado). Leads é só-diretor; vendedor não pode
  // puxar a carteira dos outros. JOIN em users barra até sessão antiga de usuário já arquivado/demitido.
  if(/^[a-f0-9]{64}$/i.test(kParam)){ try{ const _now=Math.floor(Date.now()/1000); const _s=await env.DB.prepare('SELECT u.role role, COALESCE(u.archived,0) arch FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?').bind(kParam,_now).first(); if(_s && Number(_s.arch)!==1 && ROLE_DIRETOR.includes(_s.role)) full=true; }catch(_){} }
  // PRIVACIDADE: Leads e Pedidos mostram telefone/nome do cliente — SÓ com token de diretor (a dash manda sozinha).
  // Sem token (link público / ex-gestor de tráfego) cai nas Métricas, que continuam públicas (só o funil).
  if((view==='leads'||view==='vendas') && !full) view='metricas';
  const kq=full?('k='+encodeURIComponent(kParam)):'';   // preserva o token na navegação interna (data/abas)
  const _pq=new URL(req.url).searchParams.get('per')||''; const per=(_pq==='mes')?'mes':'dia';   // Leads: visão diária (default) ou mensal
  // Pula a agregação pesada de métricas quando a aba é Pedidos/Leads (elas não usam) — deixa a troca de aba MUITO mais rápida.
  const M = view==='metricas' ? await _presselDayMetrics(env, day) : { vc:{}, contatos:{}, contatosVI:{}, vendas:{}, valor:{}, vendasVI:{}, vendasInst:{} };
  let nameMap={};
  // O NOME VEM DE users e nao passava pelo recorte: com sessao de afiliado, "Guilherme" e "Murilo"
  // continuavam na tabela por vendedor mesmo com as pressels ja filtradas. Agora, quando ha recorte
  // ativo (_idsPag na pagina, _idsOk no JSON), so entram os nomes do mundo de quem pediu.
  try{
    const _cortaNome = (typeof _idsPag !== 'undefined' ? _idsPag : (typeof _idsOk !== 'undefined' ? _idsOk : null)) !== null;
    const _uNome = _cortaNome ? await authUser(req, env).catch(() => null) : null;
    const _aflNome = _uNome ? aflDe(_uNome) : null;
    const us=await env.DB.prepare('SELECT id, name, afiliado_id FROM users').all();
    (us.results||[]).forEach(u=>{
      if (_cortaNome && String(u.afiliado_id||'') !== String(_aflNome||' ')) return;
      nameMap[String(u.id)]=u.name;
    });
  }catch(_){}
  const _sideHtml=full?await _roletaDiagHtml(env, day, chips, nameMap):'';   // "Conversão por número" (telefone + conversão) é SÓ diretor (gt-nao-ve-perda)
  const _vAt=(inst)=>_atFromInst(inst);   // instância -> id do vendedor
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
    const nums=mine.filter(_isEmUso).map(c=>c.num).filter(Boolean);   // TODOS os números "Em uso" (roleta multi-número)
    if(!nums.length){ const any=mine[0]; nums.push((any&&any.num)||'—'); }
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
    return {nome:p.nome||('Pressel '+p.id), url:'https://'+_presselDom(p,_hostReq)+'/p/'+_presselRefPub(p), views:Number(vc.views)||0, clicks:Number(vc.clicks)||0, contatos:M.contatos[pid]||0, vendas:M.vendas[pid]||0, vend};
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
  const toggleBtn=`<div style="margin-left:auto;display:inline-flex;gap:2px;background:#141c2b;border:1px solid #2b6cb0;border-radius:10px;padding:3px">${_seg('Métricas','metricas')}${full?(_seg('Pedidos','vendas')+_seg('Leads','leads')):''}</div>`;
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
      const at=_atFromInst(o.instance);
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
    const baseAt=inst=>_atFromInst(inst)||'?';   // instância -> id do vendedor (backup _b soma no mesmo)
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
      const dstart=Math.floor(new Date(day+'T00:00:00-03:00').getTime()/1000), dend=dstart+86400;
      try{
        try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN num TEXT').run(); }catch(_){}
        try{ await env.DB.prepare('ALTER TABLE wa_lead ADD COLUMN src TEXT').run(); }catch(_){}
        const r=await env.DB.prepare("SELECT phone, inst, num, pid, src, ts FROM wa_lead WHERE ts>=? AND ts<? ORDER BY ts ASC").bind(dstart,dend).all();
        leads=r.results||[];
        // telefones que VIRARAM venda (do dia em diante) → pra pintar o número de verde
        try{ const sr=await env.DB.prepare("SELECT DISTINCT phone FROM wa_sales WHERE ts>=?").bind(dstart).all(); (sr.results||[]).forEach(x=>{ const p=String(x.phone||'').replace(/\D/g,''); if(p) saleSet.add(p); }); }catch(_){}
        // NOME do lead: o WhatsApp manda o nome do perfil na captura (wa_chats.name). Puxa só pros
        // telefones do dia (JOIN, sem estourar limite de parâmetro) pra mostrar ao lado do número.
        try{ const nr=await env.DB.prepare("SELECT c.phone, c.name FROM wa_chats c JOIN (SELECT DISTINCT phone FROM wa_lead WHERE ts>=? AND ts<?) l ON l.phone=c.phone WHERE c.name IS NOT NULL AND c.name<>''").bind(dstart,dend).all(); (nr.results||[]).forEach(x=>{ const p=String(x.phone||'').replace(/\D/g,''); if(p&&x.name) nameByPhone[p]=String(x.name); }); }catch(_){}
      }catch(_){}
      const isSale=ph=>!!(ph&&saleSet.has(ph));
      // Sem separação novo/antigo. A classificação por "clique no número hoje" não é confiável
      // quando um vendedor roda DOIS números conectados ao mesmo tempo (ou troca o em_uso no meio do
      // dia): o clique fica gravado no número que estava ativo na hora, mas a mensagem chega no
      // outro, e a régua marcava lead NOVO como antigo (caso real 23/07: 65 leads frescos do
      // Guilherme foram parar em "antigos"). Os leads não se perdem — caem no número conectado dele.
      // Mostra todos como leads do dia, sem rótulo que engana.
      const byAt={};
      leads.forEach(l=>{ const at=baseAt(l.inst); (byAt[at]=byAt[at]||[]).push(l); });
      // CARD de um vendedor a partir dos leads dele.
      const _card=(at, arr)=>{
        const name=nameMap[at]||'Vendedor';
        const daP=arr.filter(l=>l.pid&&String(l.pid).trim()!=='').length;
        const byNum={}, numOrder=[];
        arr.forEach(l=>{ const k=String(l.num||''); if(!(k in byNum)){ byNum[k]=[]; numOrder.push(k); } byNum[k].push(l); });
        const cpLines=[name+' — leads de '+dLabel];
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
        // Botão "Copiar leads" removido a pedido do Bruno (23/07): não quer exportar leads da tela.
        const cpBtn='';
        return `<div style="flex:1;min-width:230px;max-width:340px;background:#141c2b;border:1px solid #233047;border-radius:14px;padding:14px 16px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="font-size:14px;font-weight:800">${_escHtml(name)}</div>${cpBtn}</div><div style="font-size:11.5px;color:#8b9bb4;margin-top:2px"><b style="color:#e6edf6">${arr.length}</b> leads · <b style="color:#34d399">${daP}</b> da pressel</div>${numSecs}</div>`;
      };
      // ordena os tops: mais venda → conversão → volume (nome desempata)
      const _dv=(at)=>(byAt[at]||[]).reduce((s,l)=>s+(isSale(String(l.phone||'').replace(/\D/g,''))?1:0),0);
      const ats=Object.keys(byAt).filter(at=>(byAt[at]||[]).length).sort((a,b)=>{
        const va=_dv(a), vb=_dv(b), la=byAt[a].length, lb=byAt[b].length;
        const pa=la>0?va/la:0, pb=lb>0?vb/lb:0;
        return (vb-va) || (pb-pa) || (lb-la) || byName(a,b);
      });
      const cols=ats.length?ats.map(at=>_card(at, byAt[at])).join(''):`<div style="color:#8b9bb4;text-align:center;padding:40px">Nenhum lead nesse dia.</div>`;
      const totL=leads.length, totP=leads.filter(l=>l.pid&&String(l.pid).trim()!=='').length;
      const hint=full?' · <span style="color:#34d399">verde = virou venda</span> · toque no número pra abrir a conversa':'';
      bodyHtml=`<div style="font-size:13px;color:#8b9bb4;margin-bottom:14px"><b style="color:#e6edf6">${totL}</b> leads${totP<totL?` · <b style="color:#34d399">${totP}</b> da pressel · ${totL-totP} sem rastreio`:''}${hint}</div><div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">${cols}</div>`;
    }
  const cpData=full?`<script>var _CP=${JSON.stringify(cpBlocks).replace(/</g,'\\u003c')};function cpSeller(i,b){try{navigator.clipboard.writeText(_CP[i]||'');var o=b.textContent;b.textContent='Copiado!';setTimeout(function(){b.textContent=o},1400);}catch(e){}}</script>`:'';
    leadsHtml=`${perToggle}${bodyHtml}${cpData}`;
  }
  return _presselHtml(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${isToday?'<meta http-equiv="refresh" content="30">':''}<title>Métricas — Todas as Pressels</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b1220;color:#e6edf6;font-family:system-ui,-apple-system,Arial,sans-serif;padding:24px}.wrap{max-width:920px;margin:0 auto}h1{font-size:22px;margin-bottom:4px}table{width:100%;border-collapse:collapse}th{font-weight:600}.shell{display:flex;gap:20px;align-items:flex-start;justify-content:center;max-width:1580px;margin:0 auto}.shell>.wrap{flex:0 1 920px;min-width:0;margin:0}.side-sp{flex:0 100 300px;min-width:0}.side{flex:0 0 300px;position:sticky;top:24px}@media(max-width:1120px){.shell{flex-wrap:wrap}.side-sp{display:none}.side{flex:1 1 100%;position:static;order:-1}}</style></head><body><div class="shell">${_sideHtml?`<div class="side-sp"></div>`:''}<div class="wrap"><h1>Métricas — Todas as Pressels</h1><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:20px"><input type="date" value="${day}" max="${today}" onchange="if(this.value)location.href='?day='+this.value+'${view!=='metricas'?('&view='+view):''}${kq?('&'+kq):''}${(view==='leads'&&per==='mes')?'&per=mes':''}'" style="background:#141c2b;border:1px solid #233047;color:#e6edf6;border-radius:8px;padding:5px 9px;font-size:12.5px;font-family:inherit;color-scheme:dark;cursor:pointer">${isToday?'<span style="color:#6b7a93;font-size:12px">atualiza sozinho a cada 30s</span>':`<a href="?${[view!=='metricas'?('view='+view):'',kq,(view==='leads'&&per==='mes')?'per=mes':''].filter(Boolean).join('&')}" style="color:#7aa2ff;font-size:12.5px;text-decoration:none">← voltar pra hoje</a>`}${toggleBtn}</div>${view==='vendas'?ordersHtml:(view==='leads'?leadsHtml:(totalSec+presselSecs))}<p style="color:#6b7a93;font-size:11.5px;margin-top:16px;line-height:1.5">${view==='vendas'?'Pedidos confirmados ("Pedido Concluído") do dia. A etiqueta verde mostra de qual pressel o pedido veio; "(aprox)" = casado pelo clique recente no número (o lead apagou o código). "sem rastreio" = não deu pra atribuir a nenhuma pressel.':view==='leads'?'Leads do dia (1º contato de cada número), separados por atendente e pelo número que recebeu. A divisória por número separa, por ex., o número da manhã do que entrou depois. Verde = virou venda.':'Números reais do dia selecionado. Chegaram e Foram pro WhatsApp contam só tráfego do TikTok (ttclid). Iniciaram contato e Vendas vêm do WhatsApp.'}</p></div>${_sideHtml?`<aside class="side">${_sideHtml}</aside>`:''}</div></body></html>`);
}
// ── AS TABELAS DA PRESSEL SO SAO PREPARADAS UMA VEZ ──────────────────────────
//
// A pagina da pressel e o destino do anuncio: cada clique PAGO passa por ela. E ela rodava, a cada
// clique, dez comandos de esquema (CREATE TABLE IF NOT EXISTS e ALTER TABLE ADD COLUMN) espalhados
// pelo caminho. Cada ida ao D1 custa uns 200ms, entao so isso somava ~2 segundos: medido em
// 18/08/2026 com a campanha no ar, a pagina levava 2,2s pra sair, com 3,7 KB de conteudo. Dois
// segundos de tela branca em cima de clique comprado.
//
// Agora roda uma vez por isolate, igual _waEnsureTables e _scEnsureTables. Deploy novo zera o
// isolate e o esquema e reaplicado, entao continua seguro pra mudanca de coluna.
let _presselTablesOk = false;
async function _presselEnsure(env){
  if (_presselTablesOk) return;
  try{
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_hits (pid TEXT, day TEXT, hits INTEGER DEFAULT 0, PRIMARY KEY(pid,day))').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS tt_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, inst TEXT, ttclid TEXT, pid TEXT, ts INTEGER, claimed INTEGER DEFAULT 0)').run();
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN code TEXT').run(); }catch(_){}
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN clicked INTEGER DEFAULT 0').run(); }catch(_){}
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN num_key TEXT').run(); }catch(_){}
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN utm TEXT').run(); }catch(_){}
    // IDENTIFICACAO DA META (27/08/2026). `fbc` e o clique do anuncio (fb.1.<ts>.<fbclid>) e `fbp`
    // e o cookie do proprio pixel. Guardados na visita porque o envio server-side acontece DEPOIS,
    // quando a mensagem chega no WhatsApp - e ali nao ha mais navegador nem URL do anuncio.
    // Ficam na MESMA linha do tt_pending de proposito: ela ja e criada em toda visita (mesmo sem
    // ttclid) e ja carrega o `code` que casa a mensagem com a visita. Tabela nova so duplicaria o
    // mecanismo de atribuicao que ja funciona.
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN fbc TEXT').run(); }catch(_){}
    try{ await env.DB.prepare('ALTER TABLE tt_pending ADD COLUMN fbp TEXT').run(); }catch(_){}
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_stats (pid TEXT PRIMARY KEY, views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pressel_day (pid TEXT, day TEXT, views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, PRIMARY KEY(pid,day))').run();
    _presselTablesOk = true;
  }catch(_){ /* nao trava a pagina: se o esquema falhar, o proximo acesso tenta de novo */ }
}

async function handlePresselPublic(req, env, id, ctx){
  // CONTADOR NAO SEGURA A PAGINA. Cada gravacao no D1 custa ~200ms de rede, e o caminho do clique
  // pago fazia sete delas em fila (visita, clique pendente, views, roleta) antes de mandar o HTML.
  // O visitante nao precisa esperar por nenhuma: `depois()` joga isso pro waitUntil, que roda com a
  // resposta ja entregue. Se nao houver ctx (chamada interna), roda como antes, aguardando.
  const _depois = [];
  const depois = (p) => { if (ctx && ctx.waitUntil) _depois.push(p); return ctx && ctx.waitUntil ? null : p; };
  const soltar = () => { if (ctx && ctx.waitUntil && _depois.length) ctx.waitUntil(Promise.allSettled(_depois)); };
  // O ESQUEMA NAO SEGURA A PAGINA (27/08/2026). _presselEnsure roda 9 comandos de tabela EM FILA e
  // so e memoizado por isolate - e a Cloudflare cria isolate novo o tempo todo, entao boa parte dos
  // visitantes pagava ~9 idas ao banco antes de qualquer coisa. As tabelas ja existem em producao,
  // e tudo que escreve nelas aqui e best-effort (`depois()` com catch) ou cria a propria tabela.
  // Entao: dispara em segundo plano e segue. Numa base nova, o primeiro clique nao grava contador e
  // o segundo ja grava - preco baratissimo perto de 1,8s no clique pago.
  depois(_presselEnsure(env));
  // AS DUAS LEITURAS DE ABERTURA VAO JUNTAS. Sao independentes (uma le o blob, a outra a conexao dos
  // numeros) e estavam em fila, custando uma ida a mais em todo clique.
  const [data, liveSetInicial] = await Promise.all([
    _getDashData(env),   // cacheado: era parseado (1.3MB) a cada clique de anúncio
    _presselLiveSet(env),
  ]);
  const pressels=Array.isArray(data.pressels)?data.pressels:[];
  const chips=Array.isArray(data.chips)?data.chips:[];
  // `id` pode chegar como o numero de sempre ou como { slug, num } do afiliado; daqui pra baixo
  // vale sempre o id interno, que e o que as metricas, a roleta e o pixel usam.
  const p = _acharPressel(pressels, (id && id.slug != null) ? id.slug : id, (id && id.num != null) ? id.num : '');
  if(!p || (p.status && p.status!=='ativa')) return _presselOffline();
  id = String(p.id);
  // só roteia lead pra número com WhatsApp conectado AGORA (pula número caído automaticamente)
  // Map: instância → número conectado (pra roteador conferir o número certo).
  // 'sc' = Sale Chat rodando. A roleta NÃO pode depender só da Evolution (que está saindo de
  // operação): sem contar o Sale Chat, wa_conn fica sem nenhuma linha 'open', o Map fica VAZIO
  // (que é truthy!) e _servConnOk reprova TODO número → a pressel serve offline e não entra lead.
  const liveSet = liveSetInicial;   // ja veio no Promise.all la de cima (nao chamar de novo: sao 3 consultas)
  const emUsoIds = _emUsoIdsDe(data);
  const sellers=_resolvePresselSellers(p, _chipsDaPressel(p, chips), liveSet, emUsoIds, _foraIdsDe(data));
  // A PÁGINA SEMPRE ABRE quando a pressel está ativa. Ela é o destino do anúncio: derrubar tudo
  // porque nenhum número está conectado é o pior cenário possível — o clique já foi PAGO e o
  // visitante recebia "Indisponível no momento". Sem número, a oferta continua na tela e só o
  // botão do WhatsApp fica inerte (não leva a lugar nenhum) até alguém conectar.
  const pick = sellers.length ? await _presselBalancedPick(env, id, sellers) : null;
  // conta TODO acesso à pressel (diagnóstico: tráfego real vs rastreado)
  await depois(env.DB.prepare('INSERT INTO pressel_hits (pid, day, hits) VALUES (?, ?, 1) ON CONFLICT(pid,day) DO UPDATE SET hits = hits + 1').bind(String(id), _brDay()).run().catch(()=>{}));
  const _qs = new URL(req.url).searchParams;
  const ttclid = _qs.get('ttclid') || '';   // click id do anúncio do TikTok
  // META: o clique do anuncio vem em `fbclid` e a Meta espera ele guardado como `fb.1.<ms>.<id>`.
  // O `_fbp` e cookie que o proprio pixel cria; na PRIMEIRA visita ele ainda nao existe (o pixel
  // roda depois desta resposta), por isso o beacon do clique atualiza a linha mais tarde.
  const _fbclid = (_qs.get('fbclid') || '').slice(0, 400);
  const _fbc = _fbclid ? ('fb.1.' + Date.now() + '.' + _fbclid) : '';
  const _fbp = (() => {
    const m = String(req.headers.get('cookie') || '').match(/(?:^|;\s*)_fbp=([^;]+)/);
    return m ? decodeURIComponent(m[1]).slice(0, 120) : '';
  })();
  // CAMPANHA. O ttclid diz QUEM clicou, mas não de QUAL anúncio: sem isso o gestor de tráfego
  // sabe que entrou lead e não sabe qual campanha trouxe. Guardamos os utm_* padrão e também os
  // nomes que o TikTok manda nas macros (campaign_name, adgroup_name, ad_name, campaign_id...).
  // Fica como JSON num campo só: parâmetro de anúncio muda com o tempo e não vale uma coluna nova
  // por vez. Só entra o que veio; link sem utm continua funcionando igual.
  const _utm = (() => {
    const campos = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','campaign_name','campaign_id','adgroup_name','adgroup_id','ad_name','ad_id','placement','sub1'];
    const o = {};
    for (const c of campos) { const v = (_qs.get(c) || '').trim(); if (v) o[c] = v.slice(0, 120); }
    return Object.keys(o).length ? JSON.stringify(o) : '';
  })();
  let leadCode = '';
  // SEM número conectado o clique CONTINUA sendo registrado: o tráfego foi PAGO e tem que aparecer
  // no funil. Antes isso ficava dentro de um `if(pick)` e um dia com todos os números offline ficava
  // idêntico a um dia sem anúncio nenhum (0/0/0/0), escondendo justamente o prejuízo.
  {
  // SEMPRE gera o código, com ou sem ttclid. O servidor SABE qual pressel está servindo esta
  // página, então deixar o lead chegar "sem rastreio" era jogar fora uma informação que já
  // estava na mão. Sem ttclid (orgânico, link compartilhado, TikTok que não passou o parâmetro)
  // perde-se só o pixel — a PRESSEL continua rastreada. A 1ª letra do código é a pressel.
  try{  // gera/reusa um CÓDIGO por clique (vai no texto do WhatsApp p/ atribuição EXATA); dedup por ttclid
    // (esquema garantido no _presselEnsure, no comeco do handler)
    const ex = ttclid ? await env.DB.prepare('SELECT code FROM tt_pending WHERE ttclid=? LIMIT 1').bind(ttclid).first() : null;
    if(ex){ leadCode = ex.code || ''; }
    else {
      leadCode = _genLeadCode(id);
      // Grava também o NÚMERO pra onde a pessoa foi. A atribuição casa por número, então
      // trocar o número de principal↔complementar não desliga mais o rastreio do lead.
      // sem número: grava mesmo assim, com inst/num_key vazios. Guarda a PRESSEL de origem e mantém
      // a deduplicação por ttclid (senão um refresh contaria a mesma visita duas vezes).
      const _nk = pick ? String(pick.num||'').replace(/\D/g,'').slice(-8) : '';
      await depois(env.DB.prepare("INSERT INTO tt_pending (inst, ttclid, pid, ts, claimed, code, num_key, utm, fbc, fbp) VALUES (?,?,?,strftime('%s','now'),0,?,?,?,?,?)").bind(pick?pick.inst:'', ttclid, String(id), leadCode, _nk, _utm, _fbc, _fbp).run().catch(()=>{}));
      if(ttclid){ await depois(_bumpPressel(env, id, 'views').catch(()=>{})); }   // conta SÓ tráfego real do TikTok, 1x por clique
    }
  }catch(_){}
  }
  // mensagem do WhatsApp com o código do clique — pra atribuição exata pelo código
  let waMsg = String(p.msg||'');
  if(leadCode){ waMsg += (waMsg?'\n':'') + 'Código de desconto "'+leadCode+'"!'; }
  // LINK FIXO NO BOTÃO (pedido do Bruno em 17/08/2026): com o interruptor ligado, a pressel deixa de
  // distribuir e manda todo mundo pro endereço escolhido — vira uma página de anúncio comum. Só
  // http/https: sem isso um `javascript:` colado no campo viraria execução na página do anúncio.
  const _destino = (p.link_on && /^https?:\/\//i.test(String(p.link||'').trim())) ? String(p.link).trim() : '';
  const wa = _destino || (pick ? (_waLink(pick.num, waMsg) || '') : '');
  const waJson=JSON.stringify(wa);
  // SEM DESTINO = A UNICA FORMA DE ALGUEM NAO SER REDIRECIONADO (27/08/2026). Se a roleta nao
  // devolveu numero e nao ha link fixo, o go() nao tem pra onde ir E o botao tambem morre: a
  // pessoa fica olhando uma pagina que nao faz nada, e nada na dash acusa. Nao invento um numero
  // aqui de proposito (mandaria lead pago pra um WhatsApp que ninguem esta olhando, que e pior);
  // o que faco e gritar, pra parar de ser silencioso. Medido em 27/08: 0 ocorrencias em 12.350
  // visitas dos ultimos 8 dias, entao isto e rede de seguranca, nao remendo de bug corrente.
  if(!wa){
    try{ await depois(env.DB.prepare("INSERT INTO five_debug (ts, subpath, method, body) VALUES (strftime('%s','now'),?,?,?)").bind('PRESSEL_SEM_NUMERO/'+String(id),'GET',JSON.stringify({pid:String(id),ttclid:ttclid||''}).slice(0,900)).run().catch(()=>{})); }catch(_){}
  }
  let _wd=String((pick&&pick.num)||'').replace(/\D/g,''); if(_wd && _wd.length<=11) _wd='55'+_wd;
  // deep link whatsapp:// abre o app DIRETO com o texto (o CÓDIGO) preenchido. A NAVEGAÇÃO direta é o
  // único jeito que preenche de verdade no celular — o fetch/JSON quebrava isso e todo lead chegava
  // SEM código (medido 25/07: 63 pessoas, 0 códigos). Voltamos pro que funciona; o cache do wa.me no
  // TikTok é problema do lado DELE (resolve trocando a URL do anúncio / migrando pra API oficial).
  // Com link fixo não existe deep link de app: o destino é o mesmo dos dois lados, senão o go()
  // tentaria abrir "whatsapp://send?phone=" vazio antes de cair no link.
  const waAppJson=_destino ? waJson : JSON.stringify('whatsapp://send?phone='+_wd+(waMsg?('&text='+encodeURIComponent(waMsg)):''));
  const bg=/^(#[0-9a-fA-F]{3,8}|rgb\([\d,\s.]+\)|rgba\([\d,\s.%]+\)|[a-zA-Z]+)$/.test(String(p.bg||''))?String(p.bg):'#ffffff';   // valida cor, evita injeção de CSS no <style>
  const secs=Math.max(0, Number(p.redirect)||0);
  const head=`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${_escHtml(p.nome||'')}</title>${_ttPixel(p)}${_fbPixel(p)}<style>*{margin:0;padding:0;box-sizing:border-box}body{background:${bg};font-family:system-ui,-apple-system,Arial,sans-serif;min-height:100vh}.wrap{max-width:480px;margin:0 auto}img{width:100%;display:block}</style></head>`;
  // go() abre o WhatsApp por NAVEGAÇÃO direta (deep link primeiro, wa.me de fallback): preenche o
  // texto/código de verdade.
  //
  // O AUTO-REDIRECT VALE PRA TODO MUNDO (27/08/2026). Ate aqui ele estava dentro de um
  // `if(IS_TT)`, ou seja so acontecia quando a URL trazia `ttclid`. Quem chegasse sem o click
  // id NUNCA era levado pro WhatsApp: tinha que achar e tocar no botao. Isso pegava (a) o
  // Bruno testando a propria pressel, que abria e nao ia a lugar nenhum e leu como bug; e,
  // pior, (b) trafego pago de verdade - na operacao do amigo 55% das visitas chegam sem
  // ttclid (769 de 1.396 linhas de tt_pending), entao mais da metade do que ele pagou parava
  // numa pagina que nao redirecionava.
  // O `track()` CONTINUA exigindo ttclid por conta propria (guarda `if(_tk||!IS_TT)return`),
  // entao o contador de "Foram pro WhatsApp" e o pixel nao mudam de base: quem nao tem click
  // id segue fora da metrica, so passa a ser redirecionado. Sem isso, a serie historica de
  // cliques quebraria no meio.
  // Evento das DUAS etapas do navegador, escolhido nas Configurações da pressel.
  //
  // O nome entra dentro de um <script> desta página, então passa pelo mesmo escape do _ttPixel
  // (JSON.stringify + <): um nome com </script> executaria código na página do anúncio. O
  // _evDe já só devolve nome da lista, mas o escape fica porque defesa de injeção não se apoia numa
  // validação só.
  //
  // "Chegaram na pressel" no padrão emite ttq.page(), e NÃO ttq.track('PageView'): para o TikTok os
  // dois não são a mesma coisa (page() alimenta o relatório de tráfego do pixel; um track('PageView')
  // entraria como evento customizado). Só quando o Bruno escolhe OUTRO evento é que vira track.
  const _evV=_evDe(p,'ev_view'), _evC=_evDe(p,'ev_click');
  const _esc=(s)=>JSON.stringify(String(s)).replace(/</g,'\\u003c');
  const _jsView=!_evV ? '' : (_evV==='PageView' ? 'try{ttq&&ttq.page()}catch(e){}' : `try{ttq&&ttq.track(${_esc(_evV)})}catch(e){}`);
  const _jsClick=!_evC ? '' : `try{ttq&&ttq.track(${_esc(_evC)})}catch(e){}`;
  // META no clique. Duas coisas, as duas de fora do `track()` de proposito - aquele exige ttclid e
  // trafego da Meta nunca traz ttclid:
  //   1. `Contact` no pixel do navegador (a INTENCAO de falar; o Lead real sai do servidor).
  //   2. um beacon com o CODIGO da visita, so pra o servidor gravar o cookie `_fbp` na linha dela.
  //      O _fbp so passa a existir depois que o pixel roda, ou seja, DEPOIS que a pagina ja
  //      respondeu - por isso ele nao da pra capturar na renderizacao.
  // Tudo em try/catch e sem nada bloqueante: o redirect nao pode depender de pixel.
  const _jsFbClick = !p.pixel_meta ? '' : `try{window.fbq&&fbq('track','Contact')}catch(e){}try{navigator.sendBeacon('/pc/${id}?fb=1&code='+encodeURIComponent(${JSON.stringify(String(leadCode||''))}))}catch(e){}`;
  // O beacon vem ANTES do ttq de propósito: ele é quem alimenta "Foram pro WhatsApp" na dash. Com o
  // pixel primeiro, um erro ali levava a métrica junto.
  // TODO MUNDO VAI PRO WHATSAPP (27/08/2026, exigencia do Bruno: "nao tolero erro nessa parte,
  // literalmente todo mundo tem que ser redirecionado"). Tres mudancas em cima do que existia:
  //
  // 1) O AGENDAMENTO E INCONDICIONAL. Era `${secs>0 ? ... : ''}`, entao `0` significava DESLIGADO.
  //    Agora 0 quer dizer 0 SEGUNDOS: manda na hora. Nao existe mais valor que desliga o redirect.
  // 2) O DISPARO TEM REDE. Antes era uma unica tentativa web 1,5s depois do deep link. Se o
  //    `whatsapp://` nao pegasse (navegador que ignora o esquema, app fechando sozinho) e essa
  //    unica tentativa caisse com a aba escondida, a pessoa ficava parada na pagina pra sempre.
  //    Agora sao duas tentativas (1,2s e 3,5s) MAIS uma quando a aba volta a ficar visivel, que e
  //    exatamente o caso de quem tentou abrir o app e voltou. Essa terceira e UMA VEZ SO: quem
  //    abriu o WhatsApp, mandou a mensagem e voltou pro navegador nao pode ficar sendo jogado
  //    de volta pro app em loop.
  // 3) `?preview=1` pula SO o automatico (o botao continua indo). E pra ele abrir a propria pressel
  //    pelo botao "Abrir pagina" da dash sem ser jogado no WhatsApp a cada conferida. Trafego de
  //    anuncio nunca traz esse parametro.
  //
  // O `track()` continua exigindo ttclid por conta propria: quem chega sem click id passa a ser
  // redirecionado, mas nao entra no contador de cliques nem no pixel, entao a serie historica nao
  // quebra. A atribuicao dele acontece pelo CODIGO que vai no texto do WhatsApp.
  // DE ONDE VINHAM OS ~2 SEGUNDOS QUE O BRUNO SENTIA (medido em 27/08/2026).
  //
  // Nao era o servidor: com a pagina de 4 KB, o custo dela em cima de uma rota vazia do mesmo worker
  // ficou em 30 a 260ms depois que as idas ao D1 sairam da fila. O tempo estava AQUI, na espera do
  // deep link. O fluxo e: `whatsapp://` primeiro (abre o app com o texto pronto) e, se ele nao
  // pegar, cai no wa.me. A primeira tentativa de queda era 1,2s DEPOIS - e ela e justamente o caso
  // COMUM no trafego pago: o TikTok abre o link no navegador de dentro do proprio app, onde o
  // esquema `whatsapp://` costuma nao fazer nada e nao avisa. Resultado: 1,2 segundo de tela parada
  // pra boa parte de quem clicou no anuncio.
  //
  // Agora sao tres tentativas (350ms, 1,4s e 3,5s). Baixar a primeira e seguro porque `_web` so age
  // com a aba VISIVEL: se o app abriu, a pagina esta escondida e a queda nao faz nada. O pior caso
  // de quem abriu o app e o wa.me carregar atras, que tambem leva pro WhatsApp. Mantive as duas
  // tentativas longas porque aparelho lento demora mais pra trocar de app.
  const script=`<script>var _ttc=new URLSearchParams(location.search).get('ttclid')||'';var IS_TT=!!_ttc;var _pv=new URLSearchParams(location.search).get('preview')==='1';if(IS_TT){${_jsView}}var _tk=false;function track(){if(_tk||!IS_TT)return;_tk=true;try{navigator.sendBeacon('/pc/${id}?ttclid='+encodeURIComponent(_ttc))}catch(e){}${_jsClick}}var _foi=false;function _web(){if(document.hidden)return;try{location.href=${waJson}}catch(e){}}function go(){if(!${waJson})return;track();${_jsFbClick}_foi=true;try{location.href=${waAppJson}}catch(e){}setTimeout(_web,350);setTimeout(_web,1400);setTimeout(_web,3500);}var _volta=false;document.addEventListener('visibilitychange',function(){if(_foi&&!_volta&&!document.hidden){_volta=true;setTimeout(_web,400)}});if(!_pv){setTimeout(go,${secs*1000});}</script>`;
  const els=_presselElsServer(p);
  let body=els.map(e=>_elPublicHtml(e, wa, id)).join('');
  if(p.fullclick){
    soltar();
    return _presselHtml(`${head}<body onclick="go()" style="cursor:pointer"><div class="wrap">${body}</div>${script}</body></html>`);
  }
  // Garante um botão de WhatsApp se o usuário não adicionou nenhum
  if(!els.some(e=>e.type==='botao')){
    body+=`<div style="padding:14px"><a href="${_escHtml(wa||'#')}" onclick="event.preventDefault();event.stopPropagation();go()" style="display:flex;align-items:center;justify-content:center;gap:10px;background:#22c55e;color:#fff;border-radius:14px;padding:16px 18px;font-weight:800;font-size:19px;text-transform:uppercase;letter-spacing:.3px;text-decoration:none;box-shadow:0 4px 0 rgba(0,0,0,.18),0 7px 14px rgba(0,0,0,.13)"><svg viewBox="0 0 32 32" width="24" height="24" style="flex-shrink:0" fill="currentColor"><path d="M16.04 4C9.4 4 4 9.4 4 16.04c0 2.12.55 4.18 1.6 6L4 28l6.13-1.6a12 12 0 0 0 5.9 1.5c6.63 0 12.03-5.4 12.03-12.04C28.06 9.4 22.67 4 16.04 4Zm0 21.9a9.9 9.9 0 0 1-5.06-1.38l-.36-.22-3.64.96.97-3.55-.24-.37a9.86 9.86 0 1 1 8.33 4.56Zm5.43-7.42c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.49 0 1.47 1.08 2.89 1.23 3.09.15.2 2.12 3.24 5.13 4.54.72.31 1.27.5 1.71.64.72.23 1.37.2 1.89.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.12-.27-.19-.57-.34Z"/></svg><span>FALAR NO WHATSAPP</span></a></div>`;
  }
  soltar();
  return _presselHtml(`${head}<body><div class="wrap">${body}</div>${script}</body></html>`);
}

// ─── Router ───


// ── PASSOS DO CRON (cada um roda numa invocacao propria; ver o scheduled la embaixo) ──────────
// Estes tres blocos sairam de dentro do scheduled na mesma mudanca de 18/08/2026. Estavam inline
// e rodavam TODOS na mesma batida, que e o que estourava o limite de CPU.

// Resgata venda e lead que ficaram em quarentena por falta de dono do numero.
async function _cronResgates(env) {
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
  // RESGATE DO LEAD EM QUARENTENA (caminho Datacrazy): mensagem que chegou num número SEM DONO fica
  // só na auditoria com source 'dc' e at_id nulo. Quando o Bruno atribui o número na Contingência,
  // esta rodada transforma ela em lead, dentro de 24h. Sem isso, "deixar pra próxima rodada" só
  // resolveria os 15min da janela do poll, e o dono costuma aparecer horas depois.
  // Ancora o clique NA HORA DA MENSAGEM (nunca em "agora", senão o FIFO rouba o ttclid de outro).
  try {
    const qa = await env.DB.prepare(
      `SELECT a.id, a.self_number, a.phone, a.msg_id, a.body, a.push_name, a.ts FROM sc_ingest_audit a
       WHERE a.source='dc' AND a.from_me=0 AND (a.at_id IS NULL OR a.at_id='')
         AND a.received_at > strftime('%s','now')-86400
         AND NOT EXISTS (SELECT 1 FROM wa_lead l WHERE l.phone = a.phone)
       LIMIT 20`
    ).all();
    for (const r of (qa.results || [])) {
      const ow = await resolveOwner(env, String(r.self_number || ''));
      if (!ow || !ow.at_id) continue;   // ainda sem dono: fica pra próxima rodada
      const inst = ow.instance || ('ax_' + ow.at_id);
      const mts = Number(r.ts) || 0;
      const fone = String(r.phone || '');
      try { await _waLogMsg(env, { phone: fone, instance: inst, direction: 'in', type: 'text', body: String(r.body || ''), pushName: String(r.push_name || ''), ts: mts, msgId: 'dc:' + String(r.msg_id || '') }); } catch (_) {}
      if (mts) {
        try {
          const cl = await env.DB.prepare(
            `UPDATE tt_pending SET claimed=1 WHERE id=(SELECT id FROM tt_pending
               WHERE (claimed IS NULL OR claimed=0) AND ttclid IS NOT NULL AND ttclid<>''
                 AND ts <= ? AND ts > ?-3600
               ORDER BY ts DESC LIMIT 1) RETURNING ttclid, pid`
          ).bind(mts, mts).first();
          await env.DB.prepare("INSERT OR IGNORE INTO wa_lead (phone, pid, ttclid, inst, src, num, ts) VALUES (?,?,?,?,'resgate',?,?)")
            .bind(fone, (cl && cl.pid) || '', (cl && cl.ttclid) || '', inst, String(r.self_number || ''), mts).run();
        } catch (_) {}
      }
      try { await env.DB.prepare('UPDATE sc_ingest_audit SET at_id=? WHERE id=?').bind(ow.at_id, r.id).run(); } catch (_) {}
    }
  } catch (_) {}
}

// Limpeza das tabelas quentes + reenvio pro TikTok do que falhou.
// AVISO DE ESTOQUE BAIXO. O saldo cai sozinho a cada pedido despachado, entao o Bruno so ia
// descobrir que acabou abrindo a tela. Aqui o proprio cron olha o extrato e manda pro sino quando
// cruza os limites (padrao 500 = metade, e 100 = comprar agora), que foi o que ele pediu.
// Avisa UMA VEZ por nivel: `estoque_nivel_avisado` guarda o ultimo nivel avisado e so zera quando o
// saldo sobe de novo (compra nova), senao o sino repetiria o mesmo aviso a cada 80 minutos.
async function _cronEstoque(env) {
  for (let tent = 0; tent < 4; tent++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return;
    let data; try { data = JSON.parse(row.data); } catch (_) { return; }
    const movs = Array.isArray(data.estoque_movs) ? data.estoque_movs : [];
    if (!movs.length) return;                                   // sem extrato nao ha o que avisar
    const soma = (t) => movs.filter((m) => m && m.tipo === t).reduce((a, m) => a + (Number(m.qtd) || 0), 0);
    const saldo = soma('entrada') + soma('reintegracao') + soma('ajuste') - soma('perda') - soma('saida_pedido');
    const regras = (data.regras && typeof data.regras === 'object') ? data.regras : {};
    const meio = Number(regras.estoque_alerta_meio) > 0 ? Number(regras.estoque_alerta_meio) : 500;
    const critico = Number(regras.estoque_alerta_critico) > 0 ? Number(regras.estoque_alerta_critico) : 100;
    const nivel = saldo <= critico ? 'critico' : (saldo <= meio ? 'meio' : '');
    const antes = String(data.estoque_nivel_avisado || '');
    if (nivel === antes) return;                                 // nada mudou de nivel
    if (!nivel) { data.estoque_nivel_avisado = ''; }              // subiu de novo (compra): rearma
    else {
      if (!Array.isArray(data.notifs)) data.notifs = [];
      const nextId = data.notifs.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0) + 1;
      data.notifs.unshift({
        id: nextId,
        type: 'estoque',
        title: nivel === 'critico' ? 'Estoque acabando' : 'Estoque na metade',
        description: 'Restam ' + saldo + ' frascos' + (nivel === 'critico' ? '. Hora de comprar mais.' : ' (menos de ' + meio + ').'),
        to: 'diretor', unread: true, ts: Math.floor(Date.now() / 1000),
        ref: 'estoque:' + nivel, link: '/logistica/estoque',
      });
      data.estoque_nivel_avisado = nivel;
    }
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), (row.version || 0) + 1, Math.floor(Date.now() / 1000), 'cron:estoque', row.version).run();
    if (res && res.meta && res.meta.changes > 0) return;
    await new Promise((r) => setTimeout(r, 15 * (tent + 1)));
  }
}
// RECONCILIA O SELO DE ENTREGA (25/08/2026). O caminho normal e o webhook (_fiveUpsertLead), mas
// ele tem tres buracos que so esta funcao tapa:
//   1) BACKFILL. Os 42 pedidos que ja existiam quando o selo nasceu nao tem o campo. Os que ainda
//      andam recebem evento novo e se resolvem sozinhos, mas os TERMINAIS (entregue / nao entregue)
//      nunca mais recebem nada: sem isso ficariam pra sempre sem selo.
//   2) WEBHOOK PERDIDO. O _fiveUpsertLead roda dentro de `catch (_) {}` e o CAS dele desiste depois
//      de 8 tentativas (grava CAS_EXHAUSTED e devolve 200 pra Five, que nunca reenvia). O pedido
//      fica salvo em five_orders (escrita atomica, fora do CAS) e some do lead. Aqui ele volta.
//   3) DIVERGENCIA. five_orders e a verdade do que a Five mandou; o lead e a copia. Nada mais no
//      worker compara os dois.
// Roda junto do passo frequente porque e BARATA quando nao ha nada: uma consulta por marca d'agua e
// sai. So encosta no blob (que e caro, tem CAS e teto de 1 MB) quando ha pedido novo de verdade.
async function _cronRastreio(env) {
  const MARCA = 'rastreio_wm';
  let wm = Number(await _readConfig(env, MARCA)) || 0;
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT order_id, shipping_status, last_event, updated_at FROM five_orders
        WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 300`
    ).bind(wm).all();
  } catch (_) { return; }
  const lista = (rows && rows.results) || [];
  if (!lista.length) return;
  const maior = lista.reduce((m, r) => Math.max(m, Number(r.updated_at) || 0), wm);
  // Mesma escada do webhook: status nulo em SHIPPING_REGISTER e "postado, sem evento ainda".
  const statusDe = (r) => (r.shipping_status ? String(r.shipping_status).toUpperCase()
    : (String(r.last_event || '') === 'SHIPPING_REGISTER' ? 'REGISTERED' : ''));

  for (let tent = 0; tent < 4; tent++) {
    const row = await env.DB.prepare('SELECT data, version FROM dashboard_state WHERE id = 1').first();
    if (!row) return;
    let data; try { data = JSON.parse(row.data); } catch (_) { return; }
    if (!Array.isArray(data.leads)) return;
    const porId = new Map();
    for (const l of data.leads) if (l && l.five_id) porId.set(String(l.five_id), l);
    let mudou = 0;
    for (const r of lista) {
      const lead = porId.get(String(r.order_id));
      if (!lead) continue;
      const ss = statusDe(r);
      // Nao rebaixa quem ja andou (a Five reenvia SHIPPING_REGISTER) e nao reescreve o que ja bate:
      // reescrita a toa gera versao nova do blob e briga de CAS com o resto da dash a toa.
      if (!ss || lead.ship === ss || (ss === 'REGISTERED' && lead.ship)) continue;
      lead.ship = ss;
      lead.ship_ts = Number(r.updated_at) || Math.floor(Date.now() / 1000);
      mudou++;
    }
    if (!mudou) { await _writeConfig(env, MARCA, String(maior)); return; }
    const res = await env.DB.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=?, updated_by=? WHERE id=1 AND version=?')
      .bind(JSON.stringify(data), (row.version || 0) + 1, Math.floor(Date.now() / 1000), 'cron:rastreio', row.version).run();
    if (res && res.meta && res.meta.changes > 0) { await _writeConfig(env, MARCA, String(maior)); return; }
    await new Promise((r) => setTimeout(r, 15 * (tent + 1)));
  }
  // CAS perdido nas 4 tentativas: NAO avanca a marca d'agua, entao a proxima batida tenta de novo.
}

async function _cronPurga(env) {
  // FUNIL PRESO EM 'enviando'. A reserva do _waFunnelTick marca a linha antes de dormir; se aquela
  // invocacao morrer no meio (deploy, limite de recurso, rede), a linha ficaria travada pra sempre e
  // o lead nunca receberia o resto. Passou de 10 minutos, vira 'error': fica visivel pro vendedor
  // retomar na mao. NAO volta pra 'running' de proposito - reenviar sozinho um passo que talvez
  // tenha saido e como mandar o mesmo audio duas vezes, que e justamente o que a reserva evita.
  try {
    await env.DB.prepare("UPDATE wa_funnel_run SET status='error', updated_at=strftime('%s','now') WHERE status='enviando' AND updated_at < strftime('%s','now')-600").run();
  } catch (_) {}
  try { await env.DB.prepare("DELETE FROM sc_ingest_audit WHERE received_at < strftime('%s','now')-259200").run(); } catch (_) {}
  try { await env.DB.prepare("DELETE FROM tt_pending WHERE ts < strftime('%s','now')-604800").run(); } catch (_) {}
  // Reenvia pro TikTok o que falhou (rede/token/recusa). Sem isso a venda ficava marcada só na
  // dash e NUNCA chegava no pixel, e ninguém via. Mesmo event_id = TikTok deduplica, não conta 2x.
  try { await _ttRetryFailed(env); } catch (_) {}
  // Guarda o histórico dos envios por 60 dias (serve de prova pro gestor de tráfego).
  try { await env.DB.prepare("DELETE FROM tt_events WHERE status='ok' AND ts < strftime('%s','now')-5184000").run(); } catch (_) {}
}

// Mantem wa_conn fresco pras instancias da Evolution.
async function _cronEvolution(env) {
  try {
    // Mantém wa_conn fresco pras instâncias da Evolution. NÃO pode depender da fonte de captura:
    // a roleta só roteia lead pra quem tem wa_conn atualizado nos últimos 180s, então com o cron
    // calado o número conectado por QR ficava verde na tela mas SAÍA DA ROLETA em 3 minutos e
    // parava de receber lead em silêncio. O estado gravado é o REAL vindo da Evolution (open/close),
    // então não ressuscita conexão fantasma: o que caiu entra como 'close' e é filtrado.
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
}

export default {
  // Cron: mantém wa_conn (estado + número conectado) fresco mesmo com a dash FECHADA, puxando da Evolution.
  // Assim o roteador nunca manda lead pra número caído por causa de estado defasado (webhook às vezes perde o logout).
  // ── O CRON FAZ UM PASSO POR BATIDA ──────────────────────────────────────────
  //
  // Descoberto em 18/08/2026, com a campanha do Bruno JA NO AR: toda batida do cron morria com
  // outcome=exceededCpu. Esta conta e Workers FREE, que da 10ms de CPU por invocacao, e a batida
  // fazia tudo de uma vez: backup, semear donos, sincronizar o inbox, funil, tokens da Meta, poll de
  // lead, agenda, dois resgates de quarentena, purga e Evolution. Estourava no meio e MORRIA CALADA
  // (nao vira excecao: a invocacao e cortada). Da metade pra frente nada acontecia, e o poll de
  // lead - o passo que transforma mensagem em lead e o lead em evento pro pixel - estava justamente
  // na segunda metade. Deu 4h20 sem capturar UM lead com verba rodando: 14 cliques, zero lead.
  //
  // O conserto e servir um passo por vez. A batida passou a ser de 1 em 1 minuto (wrangler.toml) e
  // cada uma faz UM passo, com os 10ms so pra ela. Passo sozinho cabe: o mesmo sync rodando como
  // requisicao HTTP responde 200 gastando menos de 10ms de CPU - os 15 segundos dele sao espera de
  // rede, e espera de rede nao conta CPU.
  //
  // A ordem abaixo e o que a operacao precisa: LEAD a cada 2 minutos (e o dinheiro), inbox a cada 4
  // (o atendente esta conversando agora), conexao e agenda a cada 10, e a manutencao gira devagar.
  //
  // SE FOR ACRESCENTAR PASSO: crie um slot novo, NAO empilhe dentro de um que ja existe - empilhar e
  // exatamente o que quebrou. Se um dia a conta virar Workers Paid (30s de CPU), da pra voltar tudo
  // pra uma batida so, mas nao precisa: assim tambem esta certo e falha isolado.
  async scheduled(event, env, ctx) {
    const minuto = Math.floor((event && event.scheduledTime ? event.scheduledTime : Date.now()) / 60000);
    // LEAD E INBOX TODA BATIDA (ou seja, de minuto em minuto). O rodizio abaixo nasceu como remedio
    // pro teto de 10ms de CPU do plano gratuito; em 18/08/2026 o Bruno assinou o Workers Paid e o
    // teto virou 30 SEGUNDOS por invocacao, entao nao ha mais motivo pra fazer lead so a cada 2min e
    // inbox a cada 4. Esses dois sao o que o dinheiro e o atendimento sentem: lead que nao entra nao
    // vira evento no pixel, e mensagem que nao aparece e cliente esperando.
    //
    // MANTIVE a divisao pro RESTO. Nao e mais por CPU, e por isolamento: estourar recurso NAO gera
    // excecao (a invocacao e cortada no meio e o try/catch nao pega), entao empilhar tudo numa batida
    // faz um passo pesado levar os outros junto - foi assim que ficamos 4h20 sem capturar lead. Passo
    // pesado e raro (backup, resgates, purga) roda sozinho, na vez dele.
    const RODIZIO = ['conexao', 'agenda', 'conexao', 'agenda', 'manutencao'];
    const passo = RODIZIO[minuto % RODIZIO.length];
    let erro = '';
    // BATIMENTO EM DOIS TEMPOS. Grava ANTES de trabalhar ('ini') e de novo depois ('ok'/'erro').
    // Estourar o limite de CPU NAO gera excecao: a invocacao e cortada e nada mais roda. Se so
    // houvesse a gravacao do fim, a batida morta seria invisivel de novo. Com o 'ini' fica assim: se
    // o batimento estiver velho E marcado 'ini', o passo escrito ali e exatamente o que esta matando
    // a batida. Foi assim que este bug apareceu.
    const hb = async (fase) => { try { await _writeConfig(env, 'cron_hb', JSON.stringify({ ts: Math.floor(Date.now() / 1000), passo, fase, erro })); } catch (_) {} };
    await hb('ini');
    // PUXA lead novo do Datacrazy (nao depende da automacao deles disparar) e sincroniza o inbox
    // (nos numeros em coexistencia quem recebe o webhook da Meta e o app do Datacrazy, nao o nosso).
    // Os dois em try separado: a API deles cair de um lado nao pode parar o outro.
    try { await _dcPoll(env); } catch (e) { erro = 'lead: ' + String((e && e.message) || e).slice(0, 90); console.error('[cron] lead falhou: ' + String((e && e.stack) || e)); }
    // FUNIL TODA BATIDA. Ele entrega UM passo por conversa por rodada, entao a frequencia dele E a
    // velocidade do funil pro cliente. Eu tinha mandado ele pro rodizio lento quando dividi o cron
    // por causa do teto de CPU do plano gratuito, e com isso o passo seguinte demorava 20 minutos:
    // pro vendedor pareceu que "nao vai funil nenhum" (foi o que o Guilherme reportou em 18/08/2026).
    // Nao ha mais motivo pra economia: a conta e paga.
    try { await _waFunnelTick(env); } catch (e) { erro = (erro ? erro + ' | ' : '') + 'funil: ' + String((e && e.message) || e).slice(0, 90); console.error('[cron] funil falhou: ' + String((e && e.stack) || e)); }
    try {
      const rDc = await _dcSyncInbox(env, 40, 40);
      if (!rDc || rDc.ok === false) console.error('[dc-sync] cron nao sincronizou: ' + ((rDc && rDc.motivo) || 'sem motivo'));
    } catch (e) {
      erro = (erro ? erro + ' | ' : '') + 'inbox: ' + String((e && e.message) || e).slice(0, 90);
      console.error('[dc-sync] cron explodiu: ' + String((e && e.stack) || e));
      try { await _dcSyncSaude(env, { ok: false, erro: 'excecao: ' + String((e && e.message) || e) }); } catch (_) {}
    }
    try {
      if (passo === 'conexao') {
        // Semeia numero -> vendedor e atualiza o estado real das instancias. Numero sem dono nao
        // vira lead nem venda.
        await _scEnsureTables(env); await _scSeedOwners(env);
        await _cronEvolution(env);
      } else if (passo === 'agenda') {
        await _agendaTick(env);   // avisa quem marcou retorno pra agora
        // O PIXEL ANDA JUNTO DA AGENDA porque os dois sao leves e os dois precisam ser frequentes.
        // Evento recusado pelo TikTok (403 em rajada, token trocado) e conversao que a campanha nao
        // recebe: deixar isso pra manutencao, de 80 em 80 minutos, e tarde demais com verba rodando.
        await _ttRetryFailed(env);
        await _ttVarrerLeadsSemEvento(env);
        await _ttVarrerVendasSemEvento(env);
        await _ttAvisarPresos(env);
        // Anda junto porque e do mesmo feitio: consulta barata por marca d'agua, e so mexe no blob
        // quando a Five mandou movimento novo. Poe o selo de entrega no card em minutos, nao no
        // rodizio de 80 em 80 (o Bruno acompanha entrega pelo Kanban durante o dia).
        await _cronRastreio(env);
      } else if (passo === 'manutencao') {
        // Gira entre quatro tarefas lentas: cada uma cai a cada 80 minutos, que e de sobra pro que
        // elas fazem. Backup e guardado por dentro (1x/hora e so se a versao mudou).
        const volta = Math.floor(minuto / RODIZIO.length) % 4;
        if (volta === 0) await _backupState(env);
        else if (volta === 1) await _dcSyncInstances(env);        // token de envio (Meta) de cada numero
        else if (volta === 2) await _cronResgates(env);           // venda/lead que ficaram sem dono
        else {
          await _cronEstoque(env); // avisa quando o saldo de frascos cruza os limites
          await _cronPurga(env);   // limpeza (o reenvio do pixel saiu daqui: roda no passo 'agenda')
          // SESSAO EXPIRADA NAO E APAGADA POR NINGUEM. Conferido em 18/08/2026: 227 linhas em
          // sessions, 57 ja vencidas. Nao e falha de seguranca (o authUser confere expires_at), mas e
          // tabela crescendo pra sempre num banco que a gente le o tempo todo. Some o que venceu ha
          // mais de 7 dias; o que venceu ontem fica, pra ajudar a investigar acesso se precisar.
          try { await env.DB.prepare("DELETE FROM sessions WHERE expires_at < strftime('%s','now')-604800").run(); } catch (_) {}
        }
      }
    } catch (e) {
      erro = (erro ? erro + ' | ' : '') + passo + ': ' + String((e && e.message) || e).slice(0, 120);
      console.error('[cron] passo ' + passo + ' falhou: ' + String((e && e.stack) || e));
    }
    // A dash le este batimento no Atendimento e avisa quando o cron para.
    await hb(erro ? 'erro' : 'ok');
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
      // Site institucional da marca na RAIZ dos domínios glico (pra a Meta aprovar o nome).
      const _host = String(req.headers.get('host') || '').toLowerCase().split(':')[0];
      // Imagens públicas do site (servidas do R2). Ex: /img/produto.jpg?v=2
      const _imgMatch = path.match(/^\/img\/([a-zA-Z0-9._-]+)$/);
      if (req.method === 'GET' && _imgMatch && BRAND_DOMS.includes(_host)) {
        try {
          const obj = await env.MEDIA.get('site/' + _imgMatch[1]);
          if (obj) return new Response(obj.body, { status: 200, headers: { 'content-type': obj.httpMetadata && obj.httpMetadata.contentType || 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
        } catch (_) {}
        return new Response('', { status: 404 });
      }
      if (req.method === 'GET' && BRAND_DOMS.includes(_host)) {
        if (path === '/' )            return new Response(_brandHome(_host),           { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
        if (path === '/privacidade')  return new Response(_brandLegal('privacidade', _host), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (path === '/termos')       return new Response(_brandLegal('termos', _host),       { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (path === '/entrega-e-trocas') return new Response(_brandLegal('trocas', _host),     { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      // health check + raiz (demais domínios)
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
      if (req.method === 'POST'  && path === '/api/pressel/save')   return handlePresselSave(req, env);
      if (req.method === 'POST'  && path === '/api/pressel/delete') return handlePresselDelete(req, env);
      if (req.method === 'POST'  && path === '/api/chip/save')      return handleChipSave(req, env);
      if (req.method === 'POST'  && path === '/api/chip/create')    return handleChipCreate(req, env);
      if (req.method === 'POST'  && path === '/api/chip/delete')    return handleChipDelete(req, env);
      if (req.method === 'POST'  && path === '/api/cont/save')      return handleContConfig(req, env);
      if (req.method === 'POST'  && path === '/api/tags/save')      return handleTagsSave(req, env);
      if (req.method === 'POST'  && path === '/api/saque/create')   return handleSaqueCreate(req, env);
      if (req.method === 'POST'  && path === '/api/saque/update')   return handleSaqueUpdate(req, env);
      if (req.method === 'POST'  && path === '/api/gasto/estorno')  return handleGastoEstorno(req, env);
      if (req.method === 'POST'  && path === '/api/acl/save')       return handleAclSave(req, env);
      const leadMoveMatch = path.match(/^\/api\/lead\/([^/]+)\/move$/);
      if (req.method === 'POST'  && leadMoveMatch)           return handleMoveLead(req, env, decodeURIComponent(leadMoveMatch[1]));
      const leadAceiteMatch = path.match(/^\/api\/lead\/([^/]+)\/aceitar$/);
      if (req.method === 'POST'  && leadAceiteMatch)         return handleAceitarLead(req, env, decodeURIComponent(leadAceiteMatch[1]));
      const leadAgendMatch = path.match(/^\/api\/lead\/([^/]+)\/agend$/);
      if (req.method === 'POST'  && leadAgendMatch)          return handleSetAgend(req, env, decodeURIComponent(leadAgendMatch[1]));
      // ORDEM IMPORTA: /api/lead/delete casa com o padrao de editar (/api/lead/<id>), que fica
      // logo abaixo. Registrado depois, ele viraria uma edicao do lead de id 'delete' e devolveria
      // 404 em silencio - a lixeira nao funcionaria e o erro nao diria por que.
      if (req.method === 'POST' && path === '/api/lead/delete') return handleLeadDelete(req, env);
      const leadUpdMatch = path.match(/^\/api\/lead\/([^/]+)$/);
      if (req.method === 'POST'  && leadUpdMatch)            return handleUpdateLead(req, env, decodeURIComponent(leadUpdMatch[1]));
      if (path === '/api/cs/cards' && (req.method === 'GET' || req.method === 'POST')) return handleCsCards(req, env);
      if (req.method === 'GET'   && path === '/api/backups') return handleListBackups(req, env);

      // Dados do produtor (leitura, só diretor)
      if (req.method === 'GET' && path === '/api/five/orders') return handleFiveOrders(req, env);
      if (req.method === 'GET' && path === '/api/five/summary') return handleFiveSummary(req, env);
      if (req.method === 'GET' && path === '/api/five/products') return handleFiveProducts(req, env);
      if (req.method === 'POST' && path === '/api/product-image') return handleProductImage(req, env);
      if ((req.method === 'GET' || req.method === 'POST') && path === '/api/five/affiliates') return handleFiveAffiliates(req, env);
      // Area de Afiliados (23/08/2026). Separada do produtor de proposito: nenhuma destas rotas
      // toca no calculo das telas que ja existiam.
      // AFILIADO SEM VINCULO NAO ENCOSTA NO WHATSAPP. O afiliado COM vinculo tem inbox e Sale Chat
      // (pedido do Bruno em 24/08/2026), mas escopados: o inbox filtra pelas instancias do mundo
      // dele (_waEscopoInstancias) e o Sale Chat ja gravava so no slot do proprio usuario. Quem
      // esta sem vinculo e cadastro pela metade e nao ve nada - fail-closed, igual ao resto.
      if (path.startsWith('/api/wa/') || path.startsWith('/api/salechat')) {
        const _uw = await authUser(req, env);
        if (_uw && afiliadoSemVinculo(_uw)) return err('Sem permissão', 403);
      }
      if (req.method === 'GET' && path === '/api/afiliados') return handleAfiliados(req, env);
      if (req.method === 'POST' && path === '/api/afiliados/salvar') return handleAfiliadoSalvar(req, env);
      if (req.method === 'POST' && path === '/api/afiliados/remover') return handleAfiliadoRemover(req, env);
      if (req.method === 'POST' && path === '/api/afiliados/acesso') return handleAfiliadoAcesso(req, env);
      if (['GET', 'POST'].includes(req.method) && path === '/api/afiliados/checkout') return handleAfiliadoCheckout(req, env);
      if (req.method === 'GET' && path === '/api/afiliados/pedidos') return handleAfiliadoPedidos(req, env);
      if (['GET', 'POST', 'DELETE'].includes(req.method) && path === '/api/afiliados/pagamentos') return handleAfiliadoPagamentos(req, env);
      // Equipe (fonte única de pessoas: produtor, sócio, vendedores, GT, cobrador)
      if ((req.method === 'GET' || req.method === 'POST') && path === '/api/team') return handleTeam(req, env);
      const teamDelMatch = path.match(/^\/api\/team\/([^/]+)$/);
      if (req.method === 'DELETE' && teamDelMatch) return handleTeamDelete(req, env, decodeURIComponent(teamDelMatch[1]));
      // Webhook da Five (captura + ingestão). Aceita qualquer subpath e método.
      const fiveMatch = path.match(/^\/five(?:\/(.*))?$/);
      if (fiveMatch) return handleFiveCapture(req, env, fiveMatch[1] || '');

      // users CRUD
      if (req.method === 'GET'    && path === '/api/users')         return handleListUsers(req, env);
      if (req.method === 'GET'    && path.startsWith('/api/users/foto/')) return handleUserPhoto(req, env, decodeURIComponent(path.split('/')[4] || ''));
      if (req.method === 'POST'   && path === '/api/users')         return handleCreateOrUpdateUser(req, env);
      const restoreMatch = path.match(/^\/api\/users\/([^/]+)\/restore$/);
      if (req.method === 'POST'   && restoreMatch)                  return handleRestoreUser(req, env, restoreMatch[1]);
      const userDelMatch = path.match(/^\/api\/users\/([^/]+)$/);
      if (req.method === 'DELETE' && userDelMatch)                  return handleDeleteUser(req, env, decodeURIComponent(userDelMatch[1]));

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
      if (req.method === 'POST'   && path === '/api/wa/cloud/send') return handleWACloudSend(req, env);
      if (req.method === 'POST'   && path === '/api/wa/cloud/send-media') return handleWACloudSendMedia(req, env);
      if (req.method === 'POST'   && path === '/api/wa/send-audio') return handleWASendAudio(req, env);
      if (req.method === 'POST'   && path === '/api/wa/send-media') return handleWASendMedia(req, env);
      if (req.method === 'POST'   && path === '/api/wa/tts-test')   return handleTTSTest(req, env);
      if ((req.method === 'GET' || req.method === 'POST') && path === '/api/config/tts') return handleTTSConfig(req, env);
      // WhatsApp multi-instância (1 conexão por atendente)
      if (req.method === 'GET'    && path === '/api/wa/instances')        return handleWAInstances(req, env);
      if (req.method === 'POST'   && path === '/api/wa/instance/create')  return handleWAInstanceCreate(req, env, ctx);
      if (req.method === 'GET'    && path === '/api/wa/instance/connect') return handleWAInstanceConnect(req, env);
      if (req.method === 'GET'    && path === '/api/wa/instance/status')  return handleWAInstanceStatus(req, env);
      if (req.method === 'POST'   && path === '/api/wa/instance/logout')  return handleWAInstanceLogout(req, env);
      if (req.method === 'POST'   && path === '/api/wa/instance/disconnect') return handleWAInstanceDisconnect(req, env);
      if (req.method === 'GET'    && path === '/api/wa/conn')             return handleWAConn(req, env);
      if (req.method === 'GET'    && path === '/api/salechat')            return handleSaleChatGet(req, env);
      if (req.method === 'GET'    && path === '/api/salechat/mine')       return handleSaleChatMine(req, env);
      if (req.method === 'POST'   && path === '/api/salechat/save')       return handleSaleChatSave(req, env);
      if (req.method === 'POST'   && path === '/api/salechat/media')      return handleSaleChatMediaUpload(req, env);
      // Comprovante do pedido: sobe aqui e e servido pelo /api/arquivo (mesmo leitor do R2 que a
      // midia do Sale Chat usa, so com nome que faz sentido pra quem le o codigo).
      if (req.method === 'POST' && path === '/api/comprovante') return handleComprovanteUpload(req, env);
      const arqMatch = path.match(/^\/api\/arquivo\/(.+)$/);
      if (arqMatch && req.method === 'GET') return handleSaleChatMediaGet(req, env, decodeURIComponent(arqMatch[1]));
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
      // WhatsApp Cloud API (oficial): GET = verificação da Meta, POST = mensagens recebidas
      if ((req.method === 'GET' || req.method === 'POST') && path === '/api/wa/cloud') return handleWhatsappCloudWebhook(req, env, ctx);
      // Datacrazy → AXION: recebe eventos das Automações do Datacrazy (pixel/atribuição/venda)
      if (req.method === 'POST'   && path === '/api/dc/event')  return handleDatacrazyEvent(req, env, ctx);
      if (req.method === 'GET'    && path === '/api/dc/events') return handleDatacrazyEventsList(req, env);
      // Conexão API oficial (Coexistência) — Embedded Signup: status da config + finalizar ligação
      if (req.method === 'GET'    && path === '/api/wa/es/config')        return handleWaEsConfig(req, env);
      if (req.method === 'POST'   && path === '/api/wa/es/finish')        return handleWaEsFinish(req, env);
      if ((req.method === 'GET' || req.method === 'POST') && path === '/api/wa/official/numbers') return handleWaOfficialNumbers(req, env);
      if (req.method === 'POST'   && path === '/api/wa/register')          return handleWARegister(req, env);
      if ((req.method === 'GET' || req.method === 'POST') && path === '/api/wa/template') return handleWATemplate(req, env);
      // Diagnóstico do pull: roda o MESMO caminho que o cron e devolve em qual guarda cada mensagem
      // parou. Sem simular=0 ele não grava nada, então dá pra perguntar "esse lead viraria lead?"
      // sem criar lead nem disparar pixel.
      if (req.method === 'POST'   && path === '/api/wa/meu-numero')     return handleMeuNumero(req, env);
      if (req.method === 'POST'   && path === '/api/wa/dc/poll')        return handleDcPollDiag(req, env);
      if (req.method === 'GET'    && path === '/api/tt/diag')           return handleTtDiag(req, env);
      if (req.method === 'POST'   && path === '/api/tt/ads-config')     return handleTtAdsConfig(req, env);
      if (req.method === 'POST'   && path === '/api/wa/dc/sync')          return handleDcSync(req, env);
      if (req.method === 'GET' && path === '/api/leads/contagem') return handleLeadsContagem(req, env);
      if (req.method === 'GET' && path === '/api/wa/funnel/queue') return handleWAFunnelQueue(req, env);
      if ((req.method === 'GET' || req.method === 'POST') && path === '/api/wa/funnel') return handleWAFunnel(req, env);
      if (req.method === 'GET'    && path === '/api/wa/chats')            return handleWAChats(req, env);
      if (req.method === 'GET'    && path === '/api/wa/messages')         return handleWAMessages(req, env);
      if (req.method === 'GET'    && path === '/api/wa/lead')             return handleWALead(req, env);
      if (req.method === 'POST'   && path === '/api/wa/chat/read')        return handleWAChatRead(req, env);
      if (req.method === 'POST'   && path === '/api/wa/chat/stage')       return handleWAChatStage(req, env);
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
        // Webhook do FORNECEDOR ANTIGO DESLIGADO (viramos produtor; a fonte agora e Payt/FIVE).
        // Responde 410 e NAO cria mais lead do fornecedor antigo. A funcao handleFornecedorWebhook
        // fica no codigo caso precise reativar, mas a rota nao chama mais.
        if (req.method === 'GET') {
          return json({ name: 'axion-fornecedor-webhook', ok: false, disabled: true, doc: 'Endpoint desativado (viramos produtor; fonte agora e Payt/FIVE).' });
        }
        return new Response('fornecedor webhook desativado', { status: 410 });
      }

      // Pressel pública — lead da campanha cai aqui e a roleta manda pro WhatsApp
      // Métricas da pressel (dash lê) + beacon de clique (público)
      if (req.method === 'GET' && path === '/api/pressel/stats') return handlePresselStats(req, env);
      if (req.method === 'GET' && path === '/api/pressel/diag') return handlePresselDiag(req, env);
      if (req.method === 'GET' && path === '/api/pressel/metrics') return handlePresselMetricsLive(req, env);
      const pcMatch = path.match(/^\/pc\/([a-zA-Z0-9_-]+)$/);
      if (pcMatch) {
        if (req.method === 'POST') {
          try {
            // META: guarda o cookie `_fbp` na linha desta visita. Ele so nasce depois que o pixel
            // roda no navegador, ou seja, DEPOIS que a pagina ja respondeu - entao nao ha como
            // captura-lo na renderizacao. Aqui o beacon chega ao nosso proprio dominio, o cookie
            // vem junto no cabecalho e a linha da visita (achada pelo codigo) recebe o valor.
            // NAO mexe em `clicked` nem chama _bumpPressel: "Foram pro WhatsApp" continua contando
            // so trafego com ttclid, entao a serie historica do TikTok nao muda de base.
            if (url.searchParams.get('fb') === '1') {
              try {
                const _cod = (url.searchParams.get('code') || '').slice(0, 40);
                const m = String(req.headers.get('cookie') || '').match(/(?:^|;\s*)_fbp=([^;]+)/);
                const _fbpC = m ? decodeURIComponent(m[1]).slice(0, 120) : '';
                if (_cod && _fbpC) {
                  await env.DB.prepare("UPDATE tt_pending SET fbp=? WHERE code=? AND (fbp IS NULL OR fbp='')").bind(_fbpC, _cod).run();
                }
              } catch (_) {}
            }
            const _ttc = url.searchParams.get('ttclid') || '';
            if (_ttc) {   // dedup por ttclid: 1 "Foram pro WhatsApp" por visitante (nunca passa de "Chegaram")
              const u = await env.DB.prepare('UPDATE tt_pending SET clicked=1 WHERE ttclid=? AND (clicked IS NULL OR clicked=0)').bind(_ttc).run();
              if (u.meta && u.meta.changes > 0) await _bumpPressel(env, pcMatch[1], 'clicks');
            }
          } catch (_) {}
        }
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
      }

      // A imagem da pressel como arquivo separado (ver _presselImgSrc). Tem que vir ANTES da rota da
      // pagina, senao /p/1/img/xxx nao casa com nenhuma das duas.
      const presselImgMatch = path.match(/^\/p\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_-]+))?\/img\/([a-zA-Z0-9]+)$/);
      if (req.method === 'GET' && presselImgMatch) return handlePresselImg(env, presselImgMatch[1], presselImgMatch[3], presselImgMatch[2]);
      const presselMatch = path.match(/^\/p\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && presselMatch) return handlePresselPublic(req, env, presselMatch[1], ctx);
      // A PRESSEL DO AFILIADO: /p/<slug dele>/<n dele>. Depois da rota de imagem de proposito,
      // senao /p/1/img/xxx casaria aqui como se 'img' fosse o numero da pressel.
      const presselAflMatch = path.match(/^\/p\/([a-zA-Z0-9_-]+)\/([0-9]+)$/);
      if (req.method === 'GET' && presselAflMatch) return handlePresselPublic(req, env, { slug: presselAflMatch[1], num: presselAflMatch[2] }, ctx);

      // Página pública de métricas (compartilhar com gestores de tráfego)
      const mMatch = path.match(/^\/m\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && mMatch) return handlePresselMetricsPage(req, env, mMatch[1]);

      // Página pública CONSOLIDADA: total de todas + cada pressel numa seção
      if (req.method === 'GET' && path === '/api/tt/anuncios') return handleTtAnuncios(req, env);
      if (req.method === 'GET' && path === '/pressels-total.json') return handlePresselsTotalJson(req, env);
      if (req.method === 'GET' && path === '/pressels-total') return handlePresselsTotalPage(req, env);

      return err('Rota não encontrada', 404);
    } catch (e) {
      console.error('worker error', e?.stack || e);
      return err('Erro interno: ' + (e?.message || 'desconhecido'), 500);
    }
  },
};
