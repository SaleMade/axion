// TESTE DO BARBADINHO VIVO (05/11/2026, pedido do Bruno: "queria que o bot fosse mais vivo").
//
// Roda o CODIGO DE VERDADE: recorta do worker.js o modulo inteiro do bot (da linha "BOT DE WHATSAPP
// DO TIME" ate as rotas, o que inclui o bloco "BARBADINHO VIVO"), as rotas do agente/chat/teste e as
// funcoes de fora que o bloco usa (_cobDetalhe e familia, _foraIdsDe e irmas, _aiParseJSON), e monta
// tudo com dependencias de mentira: banco D1 que entende os SQLs do bloco, blob do estado, relogio
// parado e um `fetch` que faz o papel do Gemini (registra cada chamada e devolve o que o cenario
// mandar). Nada aqui sai pra rede.
//
// O que ele guarda, em ordem de importancia:
//   1. o bot SO AFIRMA O QUE TEM PROVA: pedido vem do escopo de quem perguntou, numero caido vem
//      de swweb_conn/swweb_queda e do interruptor, nunca "conectado" sem o app ter dito;
//   2. a resposta e PUBLICA: telefone, CPF e link na saida = bot calado; o contexto nunca leva
//      CPF, endereco nem o texto dos comentarios;
//   3. a chave do Gemini e gratis: os freios contam CHAMADAS e 429 pausa uma hora;
//   4. a rota do agente so aceita mensagem com o bot do PC aberto, e cada mensagem entra uma vez.
//
//   node teste-bot-ia.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function recortaBloco(de, ate) {
  const i = src.indexOf(de);
  const j = src.indexOf(ate, i + 1);
  if (i < 0 || j < 0) throw new Error('nao achei o bloco entre "' + de + '" e "' + ate + '"');
  return src.slice(i, j);
}
function recortaFuncao(nome) {
  const a = src.indexOf('\nasync function ' + nome + '(');
  const i = a >= 0 ? a : src.indexOf('\nfunction ' + nome + '(');
  if (i < 0) throw new Error('nao achei a funcao ' + nome + ' no worker.js');
  const j = src.indexOf('{', src.indexOf('(', i + 1));
  let n = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') n++;
    else if (src[k] === '}') { n--; if (!n) return src.slice(i + 1, k + 1); }
  }
  throw new Error('chave nao fecha em ' + nome);
}

// Funcao de topo cujo corpo tem '{' solto num comentario (a contagem de chaves se perde): vai ate o
// primeiro fecho em coluna zero.
function recortaAteFecho(nome) {
  const a = src.indexOf('\nasync function ' + nome + '(');
  const i = a >= 0 ? a : src.indexOf('\nfunction ' + nome + '(');
  if (i < 0) throw new Error('nao achei a funcao ' + nome + ' no worker.js');
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error('fecho nao achado em ' + nome);
  return src.slice(i + 1, j + 2);
}

const MODULO = recortaBloco('// BOT DE WHATSAPP DO TIME (12/10/2026', '// ─── Rotas /api/bot/* (so diretor');
for (const esperado of ['BARBADINHO VIVO', '_botIaPadrao', '_botIaNormaliza', '_botIaEscuta', '_botIaQuem', '_botIaFreio', '_botIaChamar', '_botIaLimpa', '_botIaNumerosDe', '_botIaAcharPedidos', '_botIaPedidoTexto', '_botIaResponder', '_botIaMensagem', '_botIaAck', '_botIaFaxina', '_botIaProvocaTick', 'bot_chat', 'bot_quem']) {
  if (MODULO.indexOf(esperado) < 0) throw new Error('o modulo recortado nao tem ' + esperado + ' (alguem mudou o arquivo de lugar?)');
}
// As regras do pedido do app do cobrador (_cobDetalhe e tudo que ela chama) vivem num bloco so.
const COB = recortaBloco('const _COB_BRT = 3 * 3600000;', 'function _cobPedidosDoMundo(');
for (const esperado of ['_COB_PERDA', '_cobColId', '_cobTs', '_cobCriadoTs', '_cobManualNaoAceito', '_cobSelo', '_cobDetalhe']) {
  if (COB.indexOf(esperado) < 0) throw new Error('o bloco _cob recortado nao tem ' + esperado);
}
// O papel das tags de status (o que _foraIdsDe, _emUsoIdsDe e _aquecIdsDe leem).
const PAPEL = recortaBloco('const _PAPEIS_ST = [', 'function _emUsoIdsDe(data)');
const CODIGO = [
  MODULO, COB, PAPEL,
  recortaFuncao('_cobNomes'),
  recortaBloco('const _cobTagMap = (data, mundo) => {', '\n// AS INSTANCIAS QUE O WHATSAPP'),
  recortaFuncao('_emUsoIdsDe'), recortaFuncao('_foraIdsDe'), recortaFuncao('_aquecIdsDe'),
  recortaFuncao('_chipAquecendo'), recortaFuncao('_chipEmUso'),
  recortaAteFecho('_aiParseJSON'),
  src.match(/^const _donoDe = .*$/m)[0],
  recortaFuncao('handleBotAgente'), recortaFuncao('handleBotChat'), recortaFuncao('handleBotIaTeste'),
].join('\n');

// ── o mundo de mentira ──────────────────────────────────────────────────────────────────
// Quinta, 05/11/2026, 11:00 de Brasilia (a provocacao do marco precisa de horario comercial).
const RELOGIO = { agora: Date.parse('2026-11-05T11:00:00-03:00') };
class DataFalsa extends Date {
  constructor(...a) { if (!a.length) super(RELOGIO.agora); else super(...a); }
  static now() { return RELOGIO.agora; }
}
const DIA = '2026-11-05';
const ms = (s) => Date.parse(s);
const agoraS = () => Math.floor(RELOGIO.agora / 1000);

const GV = '120363409748972155@g.us';   // GlicoSix - Vendedores
const GC = '120363428664528109@g.us';   // Cobranca Sell Wave
const NUMERO_BOT = '5515981316483';
const TOKEN = 'tok_' + 'a'.repeat(44);
const USERS = [
  { id: 'atendente_vra3lh', name: 'Guilherme', role: 'atendente' },
  { id: 'atendente_6e3cbf', name: 'Kevin Marques', role: 'atendente' },
  { id: 'cobrador_d4qn8j', name: 'Bryan Amorim', role: 'cobrador' },
  { id: 'atendente_k1s0gl', name: 'Haynan', role: 'cobrador' },
  { id: 'dir', name: 'Heynan Dantas', role: 'diretor' },
  { id: 'socio_x4dy6d', name: 'Bruno Correa', role: 'socio' },
  { id: 'afl_u1', name: 'Giovane', role: 'diretor', afiliado_id: 'afl_x' },   // de outro mundo: fora da equipe
];
const GUI = 'atendente_vra3lh', KEVIN = 'atendente_6e3cbf', BRYAN = 'cobrador_d4qn8j', HAYNAN = 'atendente_k1s0gl';

function monta(mundo) {
  const cfgdb = { ...(mundo.config || {}) };
  if (mundo.cfg && !cfgdb.bot_wa) cfgdb.bot_wa = JSON.stringify(mundo.cfg);
  const users = (mundo.users || USERS).filter((u) => !u.archived && !u.afiliado_id);
  const estado = { leads: mundo.leads || [], chips: mundo.chips || [], pressels: mundo.pressels || [], wa_statuses: mundo.wa_statuses || [], tags: [] };
  const chat = (mundo.chat || []).map((x, i) => ({ id: i + 1, chamadas: 0, alerta: 0, resp_status: '', resp_msg_id: '', ...x }));
  let seq = chat.length;
  const quem = (mundo.quem || []).slice();   // bot_quem
  const fila = [];                            // bot_outbox: o que foi pro WhatsApp Web
  const envios = [];                          // bot_envios: o registro
  const chamadas = [];                        // cada chamada ao Gemini/Anthropic falso
  const pushes = [];                          // _wpParaPessoa
  const tetos = [];                           // o teto (ms) de cada chamada de IA
  const ordem = { atendente: 0, cobrador: 1, diretor: 2, socio: 3 };
  const porNome = (a, b) => String(a.name).localeCompare(String(b.name));
  const tem = (k) => Object.prototype.hasOwnProperty.call(cfgdb, k);
  const por8 = (lista, lb) => { const ok8 = new Set(JSON.parse(lb)); return lista.filter((x) => ok8.has(String(x.nk).slice(-8))); };
  const colunas = (sql) => sql.match(/INTO bot_chat \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  const desc = (p, q) => q.id - p.id;

  // O banco: cada SQL do bloco tem a sua linha aqui. SQL desconhecido devolve vazio, como uma tabela vazia.
  function roda(sql, a) {
    const vazio = { results: [], meta: { changes: 0 } };
    const um = { results: [], meta: { changes: 1 } };
    // app_config
    if (/INSERT INTO app_config/.test(sql) && /DO NOTHING/.test(sql)) {
      const k = String(a[0]);
      if (tem(k)) return vazio;
      cfgdb[k] = String(a[1] == null ? '' : a[1]);
      return um;
    }
    if (/SELECT value FROM app_config WHERE key = \?/.test(sql)) return { results: tem(a[0]) ? [{ value: cfgdb[a[0]] }] : [], meta: {} };
    const mk = sql.match(/SELECT value FROM app_config WHERE key = '([^']+)'/);
    if (mk) return { results: tem(mk[1]) ? [{ value: cfgdb[mk[1]] }] : [], meta: {} };
    // bot_chat: UNIQUE(grupo, msg_id) e o dedupe da mensagem repetida
    if (/INSERT (OR IGNORE )?INTO bot_chat/.test(sql)) {
      const row = {}; colunas(sql).forEach((c, i) => { row[c] = a[i]; });
      const repetida = chat.some((x) => x.grupo === row.grupo && x.msg_id === row.msg_id);
      if (repetida) { if (/OR IGNORE/.test(sql)) return vazio; throw new Error('UNIQUE constraint failed: bot_chat.grupo, bot_chat.msg_id'); }
      row.id = ++seq; row.chamadas = Number(row.chamadas) || 0; row.alerta = Number(row.alerta) || 0;
      if (!('resp_status' in row)) row.resp_status = ''; if (!('resp_msg_id' in row)) row.resp_msg_id = '';
      chat.push(row);
      return { results: [], meta: { changes: 1, last_row_id: row.id } };
    }
    if (/UPDATE bot_chat SET quem_id=\?/.test(sql)) {
      const x = chat.find((r) => r.id === Number(a[9])); if (!x) return vazio;
      Object.assign(x, { quem_id: a[0], texto: a[1], acao: a[2], resposta: a[3], motivo: a[4], modelo: a[5], ms: a[6], chamadas: a[7], alerta: a[8] });
      return um;
    }
    if (/UPDATE bot_chat SET acao=CASE WHEN \?/.test(sql)) {
      const x = chat.find((r) => r.id === Number(a[5]) && r.acao === 'pendente'); if (!x) return vazio;
      x.acao = a[0] ? 'respondeu' : 'erro'; x.resp_status = a[1]; x.resp_msg_id = a[2]; if (!a[3]) x.motivo = a[4];
      return um;
    }
    if (/UPDATE bot_chat SET acao='erro'/.test(sql)) {
      let n = 0; for (const x of chat) if (x.acao === 'pendente' && Number(x.ts) < Number(a[0])) { x.acao = 'erro'; x.resp_status = 'erro'; x.motivo = 'nao saiu (o agente nao confirmou)'; n++; }
      return { results: [], meta: { changes: n } };
    }
    if (/DELETE FROM bot_chat WHERE acao='visto'/.test(sql)) { for (let i = chat.length - 1; i >= 0; i--) if (chat[i].acao === 'visto' && Number(chat[i].ts) < Number(a[0])) chat.splice(i, 1); return um; }
    if (/DELETE FROM bot_chat WHERE ts </.test(sql)) { for (let i = chat.length - 1; i >= 0; i--) if (Number(chat[i].ts) < Number(a[0])) chat.splice(i, 1); return um; }
    if (/SUM\(chamadas\)/.test(sql)) {
      let f;
      if (/WHERE jid=\? AND ts>\?/.test(sql)) f = (x) => x.jid === a[0] && Number(x.ts) > Number(a[1]);
      else if (/WHERE jid=\? AND dia=\?/.test(sql)) f = (x) => x.jid === a[0] && x.dia === a[1];
      else if (/WHERE de_jid=\? AND jid=\? AND ts>\?/.test(sql)) f = (x) => x.de_jid === a[0] && x.jid === a[1] && Number(x.ts) > Number(a[2]);
      else f = (x) => x.de_jid === a[0] && Number(x.ts) > Number(a[1]);
      return { results: [{ n: chat.filter((x) => f(x) && Number(x.chamadas) > 0).reduce((s, x) => s + Number(x.chamadas), 0) }], meta: {} };
    }
    if (/SELECT de_nome, quem_id, texto, acao, resposta FROM bot_chat WHERE jid=\?/.test(sql)) return { results: chat.filter((x) => x.jid === a[0] && Number(x.ts) > Number(a[1]) && x.acao !== a[2]).sort(desc).slice(0, Number(a[3])), meta: {} };
    if (/SELECT resposta FROM bot_chat WHERE jid=\?/.test(sql)) return { results: chat.filter((x) => x.jid === a[0] && Number(x.ts) > Number(a[1]) && (x.acao === a[2] || x.acao === a[3])).sort(desc).slice(0, 30).map((x) => ({ resposta: x.resposta })), meta: {} };
    if (/SELECT 1 AS ok FROM bot_chat WHERE jid=\? AND de_jid=\?/.test(sql)) return { results: chat.some((x) => x.jid === a[0] && x.de_jid === a[1] && ['respondeu', 'pendente'].includes(x.acao) && Number(x.ts) > Number(a[2])) ? [{ ok: 1 }] : [], meta: {} };
    if (/COUNT\(\*\) AS n FROM bot_chat WHERE acao='provocou'/.test(sql)) return { results: [{ n: chat.filter((x) => x.acao === 'provocou' && x.dia === a[0]).length }], meta: {} };
    if (/FROM bot_chat WHERE grupo=\? AND acao<>'visto'/.test(sql)) return { results: chat.filter((x) => x.grupo === a[0] && x.acao !== 'visto').sort(desc).slice(0, Number(a[1])).map((x) => ({ ...x, texto: String(x.texto || '').slice(0, 300), resposta: String(x.resposta || '').slice(0, 400) })), meta: {} };
    // bot_quem: quem escreve no grupo (upsert por grupo + jid)
    if (/INSERT INTO bot_quem/.test(sql)) {
      const [grupo, de_jid, fone, nome, ultimo_ts] = a;
      const x = quem.find((q) => q.grupo === grupo && q.de_jid === de_jid);
      if (x) { if (fone) x.fone = fone; x.nome = nome; x.ultimo_ts = ultimo_ts; x.n = (Number(x.n) || 0) + 1; }
      else quem.push({ grupo, de_jid, fone, nome, ultimo_ts, n: 1 });
      return um;
    }
    if (/DELETE FROM bot_quem/.test(sql)) { for (let i = quem.length - 1; i >= 0; i--) if (Number(quem[i].ultimo_ts) < Number(a[0])) quem.splice(i, 1); return um; }
    if (/FROM bot_quem WHERE grupo=\?/.test(sql)) return { results: quem.filter((q) => q.grupo === a[0] && Number(q.ultimo_ts) > Number(a[1])).sort((p, q) => q.ultimo_ts - p.ultimo_ts).slice(0, 60).map((q) => ({ grupo: q.grupo, jid: q.de_jid, fone: q.fone, nome: q.nome, ultimo_ts: q.ultimo_ts, n: q.n })), meta: {} };
    // o app do vendedor (SellWave Web): o que ele reportou de cada numero
    if (/FROM swweb_conn WHERE substr\(nk,-8\) IN/.test(sql)) return { results: por8(mundo.conn || [], a[0]), meta: {} };
    if (/FROM swweb_queda WHERE substr\(nk,-8\) IN/.test(sql)) return { results: por8(mundo.queda || [], a[0]), meta: {} };
    if (/FROM swweb_uso WHERE substr\(nk,-8\) IN/.test(sql)) return { results: por8(mundo.uso || [], a[0]), meta: {} };
    if (/FROM pressel_num_log WHERE at = \?/.test(sql)) return { results: (mundo.numlog || []).filter((x) => x.at === a[0] && Number(x.ts) > Number(a[1])).sort((p, q) => q.ts - p.ts), meta: {} };
    if (/FROM push_subs/.test(sql)) return { results: [{ n: mundo.push ? 1 : 0 }], meta: {} };
    // users: equipe inteira, so vendedores, so cobradores, e o mapa id -> nome
    if (/SELECT id, name, role FROM users/.test(sql)) return { results: users.slice().sort((p, q) => ((ordem[p.role] ?? 4) - (ordem[q.role] ?? 4)) || porNome(p, q)).map((u) => ({ id: u.id, name: u.name, role: u.role })), meta: {} };
    if (/FROM users/.test(sql) && /lower\(role\)='atendente'/.test(sql)) return { results: users.filter((u) => u.role === 'atendente').sort(porNome).map((u) => ({ id: u.id, name: u.name })), meta: {} };
    if (/FROM users/.test(sql) && /lower\(role\)='cobrador'/.test(sql)) return { results: users.filter((u) => u.role === 'cobrador').sort(porNome).map((u) => ({ id: u.id, name: u.name })), meta: {} };
    if (/SELECT id, name FROM users/.test(sql)) return { results: (mundo.users || USERS).map((u) => ({ id: u.id, name: u.name })), meta: {} };
    // fila do PC e registro de envios
    if (/INSERT INTO bot_outbox/.test(sql)) { fila.push({ id: fila.length + 1, ts: a[0], dia: a[1], tipo: a[2], jid: a[3], nome: a[4], texto: a[5], status: 'pend', midia: a[7] }); return um; }
    if (/INSERT INTO bot_envios/.test(sql)) { envios.push({ ts: a[0], dia: a[1], tipo: a[2], nome: a[3], fone: a[4], via: a[5], status: a[6], erro: a[7], texto: a[8] }); return um; }
    if (/COALESCE\(tent,0\) AS tent, midia FROM bot_outbox/.test(sql)) return { results: fila.filter((x) => x.status === 'pend').map((x) => ({ ...x, tent: 0 })), meta: {} };
    if (/UPDATE bot_outbox SET tent=/.test(sql)) return { results: a.slice(1, -1).map((id) => ({ id })), meta: {} };
    return vazio;
  }
  const db = {
    prepare(sql) {
      const st = {
        _a: [],
        bind(...a) { st._a = a; return st; },
        async run() { const r = roda(sql, st._a); return { meta: r.meta || {}, results: r.results || [] }; },
        async all() { const r = roda(sql, st._a); return { results: r.results || [], meta: r.meta || {} }; },
        async first() { const r = roda(sql, st._a); return (r.results && r.results[0]) || null; },
      };
      return st;
    },
    async batch(l) { const o = []; for (const x of l) o.push(await x.all()); return o; },
    async exec() { return {}; },
  };
  const env = { DB: db };

  // O GEMINI DE MENTIRA. `mundo.ia` e uma lista de respostas (uma por chamada; acabou, repete a ultima)
  // ou uma funcao (chamada, indice) => resposta. Cada resposta: { json } (o JSON do modelo), { texto }
  // (texto cru), { status: 429 }, { finish: 'MAX_TOKENS' } ou { texto: '' } (vazio).
  const fetchFalso = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    const anthropic = /api\.anthropic\.com/.test(u);
    const modelo = anthropic ? String(body.model || '') : ((u.match(/models\/([^:]+):/) || [])[1] || '');
    const ch = { url: u, modelo, anthropic, body, headers: (init && init.headers) || {},
      system: anthropic ? String(body.system || '') : String(((body.system_instruction || {}).parts || [{}])[0].text || ''),
      user: anthropic ? String(((body.messages || [{}])[0]).content || '') : String((((body.contents || [{}])[0]).parts || [{}])[0].text || '') };
    chamadas.push(ch);
    const i = chamadas.length - 1;
    const spec = (typeof mundo.ia === 'function') ? mundo.ia(ch, i) : (Array.isArray(mundo.ia) ? (mundo.ia[i] || mundo.ia[mundo.ia.length - 1]) : mundo.ia) || { json: { responder: true, texto: 'Fechado.' } };
    if (spec.status && spec.status !== 200) return { ok: false, status: spec.status, json: async () => ({ error: { message: 'erro ' + spec.status } }), text: async () => '' };
    const texto = spec.texto != null ? String(spec.texto) : JSON.stringify(spec.json || {});
    // A Claude devolve o pensamento num bloco antes do texto (vazio por padrao) e o stop_reason.
    if (anthropic) return { ok: true, status: 200, json: async () => ({ model: modelo, stop_reason: spec.stop || 'end_turn', stop_details: spec.stop_details || null, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: texto }], usage: { input_tokens: 3000, output_tokens: 400 } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: texto }] }, finishReason: spec.finish || 'STOP' }] }) };
  };

  const deps = {
    Date: DataFalsa,
    console: { log() {}, error() {}, warn() {} },
    fetch: fetchFalso,
    _fetchComTeto: (url, teto, init) => { tetos.push(teto); return fetchFalso(url, init); },
    AbortSignal,
    crypto,
    _agoraBR: () => new DataFalsa(RELOGIO.agora - 3 * 3600000),
    _brDay: (ts) => new DataFalsa((ts ? ts * 1000 : RELOGIO.agora) - 3 * 3600000).toISOString().slice(0, 10),
    _ehPago: (l) => String((l && l.spg) || '') === 'Pago' || ['Pago', 'Pagos'].includes(String((l && l.col) || '')),
    _COLS_VENDA_CANCELADA: ['Cancelado', 'Cancelado sem Custo'],
    _getDashData: async () => estado,
    _readConfig: async (_e, k) => (tem(k) ? cfgdb[k] : null),
    _writeConfig: async (_e, k, v) => { cfgdb[k] = String(v); },
    _readConfigMuitas: async (_e, ks) => { const o = {}; for (const k of ks) if (tem(k)) o[k] = cfgdb[k]; return o; },
    _ensureConfigTable: async () => {},
    _atFromInst: () => '',
    _idsDeTodoAfiliado: async () => [],
    _graph: async () => ({ ok: false, status: 0, data: {} }),
    getAIKey: async (_e, p) => (p === 'gemini' ? 'AIza-teste' : (p === 'anthropic' ? (mundo.anthropic || null) : null)),
    _wpParaPessoa: async (_e, userId, payload) => { pushes.push({ userId, payload }); return mundo.push ? 1 : 0; },
    authUser: async () => ({ id: 'dir', name: 'Heynan Dantas', role: 'diretor' }),
    isDirector: () => true,
    isAfiliado: () => false,
    json: (o, s) => ({ _json: o, _status: s || 200 }),
    err: (m, s) => ({ _json: { error: m }, _status: s || 400 }),
  };
  const nomes = Object.keys(deps);
  const f = new Function(...nomes, CODIGO + '\n;return { _botCfgPadrao, _botNormaliza, _botIaPadrao, _botIaNormaliza, _botIaEscuta, _botIaQuem, _botIaFreio, _botIaChamar, _botIaLimpa, _botIaNorm, _botIaNumerosDe, _botIaAcharPedidos, _botIaPedidoTexto, _botIaResponder, _botIaMensagem, _botIaAck, _botIaFaxina, _botIaProvocaTick, _botIaSistema, _botCfgLer, _cobNomes, _cobTagMap, handleBotAgente, handleBotChat, handleBotIaTeste, BOT_IA_SEM_TEXTO, BOT_IA_MODELOS, _botIaGrupoDe, _botIaEhTeste, _botIaTesteTexto, _botIaTesteMudou, _botIaProvocaTeste, _botIaTextoSemMarca, BOT_IA_HORA, BOT_IA_DIA, BOT_IA_PESSOA_10MIN, BOT_IA_EXEMPLOS, BOT_IA_MARCADO, BOT_IA_NAO_SEI_QUEM };');
  return { api: f(...nomes.map((n) => deps[n])), env, cfgdb, chat, quem, fila, envios, chamadas, pushes, tetos, estado, mundo };
}

let ok = 0;
const falhas = [];
const conf = (cond, msg) => { if (cond) ok += 1; else falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg); };
const titulo = (t) => console.log('\n' + t);

// Uma mensagem do agente, como o POST /api/bot/agente/msg manda (o Guilherme, pelo numero dele).
let _nMsg = 0;
const msg = (o) => ({ numero: NUMERO_BOT, jid: GV, msg_id: 'm' + (++_nMsg), de_jid: '5515999990001@s.whatsapp.net', de_fone: '5515999990001', de_nome: 'Guilherme', texto: '', tipo: 'texto', menciona: false, responde: false, citado: '', ts: agoraS(), ...o });
// O mesmo, ja com o grupo resolvido (como _botIaResponder recebe).
const pacote = (o) => ({ grupo: 'vend', ...msg(o) });
// Um pedido do agente pro worker, com o token do bot do PC.
const req = (path, body, tok) => ({ method: 'POST', url: 'https://api.sellwave.com.br' + path, headers: { get: (k) => (String(k).toLowerCase() === 'authorization' ? 'Bearer ' + (tok === undefined ? TOKEN : tok) : null) }, json: async () => body });
const JSON_OK = { json: { responder: true, texto: 'Fechado, pode deixar.' } };

// A config base: os dois grupos ligados, resposta ligada nos dois, quem e quem com jid e fone.
const CFG_RAW = {
  ativo: true,
  grupo: { id: GV, nome: 'GlicoSix - Vendedores' },
  cobranca: { ativo: true, grupo: { id: GC, nome: 'Cobranca Sell Wave' } },
  pessoas: [
    { id: GUI, nome: 'Guilherme', fone: '5515999990001', jid: '5515999990001@s.whatsapp.net' },
    { id: BRYAN, nome: 'Bryan', fone: '5515999990002', jid: '111222333444@lid' },
    { id: 'socio_x4dy6d', nome: 'Bruno', fone: '5515999990009' },
  ],
  marcos: { lista: [{ n: 5, frases: ['Boa, {nome}, {n} vendas'] }, { n: 10, frases: ['Geral {nome} fez {n}'], por_vendedor: { [GUI]: { frases: ['Especial {nome}: {n} vendas, bora'] } } }, { n: 15, frases: ['{nome} fechou {n}'] }, { n: 20, frases: ['{nome} fez {n}'] }] },
  ia: { responde: { vend: true, cob: true }, so_marcado: { vend: false, cob: true }, tom: { cob: 'Tom da cobranca X' }, instrucoes: 'Nunca prometa prazo de entrega.' },
};
const cfgDe = (api, extra) => api._botNormaliza({ ...CFG_RAW, ...(extra || {}) }, null);

// Os pedidos da operacao. Datas em ms; `ts` e a criacao (hoje so os 101/102 do Guilherme).
const hoje = (h) => ms('2026-11-05T' + h + ':00-03:00');
const LEADS = [
  { id: 1793903844876, nome: 'Joselina Da Silva', wa: '5515988887777', cpf: '12345678901', cidade: 'Sorocaba', uf: 'sp', col: 'Pagos', spg: 'Pago', at: GUI, cob: BRYAN, vl: 297, pgto: 'Pix', pago_ts: ms('2026-11-04T15:20:00-03:00'), ts: ms('2026-11-01T10:00:00-03:00'), five_id: '44812301', prod: 'GlicoSix 3 un', end: 'Rua das Flores 10', cep: '18000-000',
    hist: [{ from: 'Saiu para Entrega', to: 'Entregues', time: '03/11 14:00', who: 'five' }, { from: 'Entregues', to: 'Pagos', time: '04/11 15:20', who: BRYAN }],
    comments: [{ who: BRYAN, tx: 'cliente pagou pelo pix 11 99999-0000', time: '04/11 15:21' }] },
  { id: 2, nome: 'Maria Silva', wa: '5515977776666', cidade: 'Itu', uf: 'SP', col: 'Entregues', at: KEVIN, cob: BRYAN, vl: 197, ship: 'DELIVERED', ship_ts: ms('2026-11-03T14:00:00-03:00'), agend: '2026-11-07T09:00', ts: ms('2026-10-30T10:00:00-03:00') },
  { id: 3, nome: 'Maria Souza', wa: '5515966665555', col: 'Entregues', at: KEVIN, cob: '', vl: 197, pagamentos: [{ valor: 50, data: '04/11 10:00' }], ts: ms('2026-10-31T10:00:00-03:00') },
  { id: 4, nome: 'Carlos Pereira', wa: '5515955554444', col: 'Entregues', at: GUI, cob: HAYNAN, vl: 297, ts: ms('2026-10-29T10:00:00-03:00') },
  { id: 5, nome: 'Ana Afiliada', wa: '5515944443333', col: 'Entregues', at: GUI, afl: 'afl_x', vl: 197, ts: ms('2026-10-29T10:00:00-03:00') },
  { id: 6, nome: 'Pedro Manual', wa: '5515933332222', col: 'A Enviar', orig: 'Manual', at: GUI, vl: 197, ts: ms('2026-11-04T10:00:00-03:00') },
  { id: 101, nome: 'Venda Um', wa: '5515922221111', col: 'A Enviar', at: GUI, vl: 197, ts: hoje('09:00') },
  { id: 102, nome: 'Venda Dois', wa: '5515911110000', col: 'A Enviar', at: GUI, vl: 197, ts: hoje('10:10') },
];
// Os numeros do Guilherme na Contingencia e o interruptor por pressel.
const CHIPS = [
  { num: '5515988880001', at: GUI, st: 'ativo', wa_st: 'em_uso', em_uso: true },
  { num: '5515988880002', at: GUI, st: 'ativo' },
  { num: '5515988880003', at: GUI, st: 'banido' },
  { num: '5515977770001', at: KEVIN, st: 'ativo', em_uso: true },
  { num: '5515977770002', at: 'ccol_1', st: 'ativo' },
];
const PRESSELS = [
  { id: 'p1', vendedores: [{ at: GUI, off: { '88880002': 1 } }] },
  { id: 'p2', vendedores: [] },
  { id: 'p3', status: 'pausada', vendedores: [{ at: GUI, ativo: false }] },
];
const MUNDO = { cfg: CFG_RAW, leads: LEADS, chips: CHIPS, pressels: PRESSELS, push: true, ia: [JSON_OK] };

// ══ 1. A CONFIG ════════════════════════════════════════════════════════════════════════
titulo('1. A config da conversa (cfg.ia)');
{
  const { api } = monta({});
  const p = api._botNormaliza({}, null).ia;
  conf(p.responde.vend === false && p.responde.cob === false, 'nasce sem responder em nenhum grupo (ninguem leva resposta sem o Bruno ligar)');
  conf(p.so_marcado.vend === false && p.so_marcado.cob === true, 'vendedores: espontaneo liberado; cobradores: so quando marcarem o bot');
  conf(p.provoca.ativo === false, 'a provocacao perto do marco nasce desligada');
  conf(/^Animado e espontâneo/.test(p.tom.vend) && /^Animado, mais leve/.test(p.tom.cob) && p.instrucoes === '', 'tons padrao por grupo (o jeito do grupo, 06/11) e instrucoes vazias');
  const base = api._botNormaliza({ ia: { instrucoes: 'Nunca fale de preco', so_marcado: { vend: true }, tom: { vend: 'Tom X' } } }, null);
  const so = api._botNormaliza({ ia: { responde: { vend: true } } }, base);
  conf(so.ia.responde.vend === true && so.ia.responde.cob === false, 'ligar so o responder do time muda so ele');
  conf(so.ia.instrucoes === 'Nunca fale de preco' && so.ia.so_marcado.vend === true && so.ia.tom.vend === 'Tom X', 'e NAO apaga instrucoes, so_marcado nem o tom gravados');
  const longo = api._botNormaliza({ ia: { instrucoes: 'a'.repeat(5000), tom: { cob: 'b'.repeat(5000) } } }, null).ia;
  conf(longo.instrucoes.length === 2000 && longo.tom.cob.length === 2000, 'texto de 5000 chars corta em 2000');
  const pes = api._botNormaliza({ pessoas: [{ id: 'u1', nome: 'A', jid: '5515999990001@s.whatsapp.net' }, { id: 'u2', nome: 'B', jid: '111222333444@lid' }, { id: 'u3', nome: 'C', jid: 'abc@g.us' }, { id: 'u4', nome: 'D', jid: '123@lid' }] }, null).pessoas;
  conf(pes[0].jid === '5515999990001@s.whatsapp.net' && pes[1].jid === '111222333444@lid', 'jid de telefone e jid LID ficam em pessoas[]');
  conf(pes[2].jid === '' && pes[3].jid === '', 'jid de grupo ou curto demais vira vazio (nao identifica ninguem)');
  conf(api._botNormaliza({ ia: 'lixo' }, base).ia.instrucoes === 'Nunca fale de preco', 'secao ia invalida nao derruba o que estava gravado');
}

// ══ 2. O QUE O AGENTE ESCUTA ═══════════════════════════════════════════════════════════
titulo('2. Os grupos que o agente repassa (escuta no ping)');
{
  const { api } = monta({});
  conf(api._botIaEscuta(api._botNormaliza({ ...CFG_RAW, ativo: false }, null)).length === 0, 'bot desligado: o agente nao repassa nada');
  const e = api._botIaEscuta(cfgDe(api));
  conf(e.length === 2 && e[0] === GV && e[1] === GC, 'ligado com os dois grupos: os dois jids, vendedores primeiro');
  conf(api._botIaEscuta(cfgDe(api, { cobranca: { ativo: true, grupo: { id: '' } } })).join() === GV, 'sem grupo da cobranca escolhido, so o do time');
}

// ══ 3. O GATILHO ═══════════════════════════════════════════════════════════════════════
titulo('3. O gatilho: quando o bot abre a boca');
{
  const { api, env, chamadas } = monta(MUNDO);
  const cfg = cfgDe(api);
  let r = await api._botIaResponder(env, cfg, pacote({ texto: 'bom dia galera, hoje vai ser top' }));
  conf(r.acao === 'visto' && chamadas.length === 0, 'papo do grupo sem marcar o bot e sem problema: visto, e a IA nem e chamada');
  r = await api._botIaResponder(env, cfg, pacote({ texto: 'meu numero caiu' }));
  conf(r.acao === 'respondeu' && chamadas.length === 1, '"meu numero caiu" sem marcar, com espontaneo liberado: chama a IA');
  r = await api._botIaResponder(env, cfg, pacote({ texto: 'esse cliente ja pagou o pedido?' }));
  conf(r.acao === 'visto' && chamadas.length === 1, '"?", cliente e pedido NAO acendem sozinhos no grupo dos vendedores');
  const soMarcado = cfgDe(api, { ia: { ...CFG_RAW.ia, so_marcado: { vend: true, cob: true } } });
  r = await api._botIaResponder(env, soMarcado, pacote({ texto: 'meu numero caiu' }));
  conf(r.acao === 'visto' && chamadas.length === 1, 'com "so quando marcarem" ligado, nem o numero caido acende sem mencao');
  r = await api._botIaResponder(env, soMarcado, pacote({ texto: 'meu numero caiu', menciona: true }));
  conf(r.acao === 'respondeu' && chamadas.length === 2, 'mencao ao bot chama a IA');
}
{
  // Responder a uma mensagem do bot: resposta do bot = conversa; resumo/marco = so se parecer pergunta.
  const chat = [{ ts: agoraS() - 600, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'r1', de_jid: '', de_nome: 'Kevin', texto: 'oi', acao: 'respondeu', resposta: 'Relaxa, Kevin: 2 numeros ligados ainda.', chamadas: 1 }];
  const { api, env, chamadas } = monta({ ...MUNDO, chat });
  const cfg = cfgDe(api);
  let r = await api._botIaResponder(env, cfg, pacote({ texto: 'valeu barbadinho', responde: true, citado: 'Relaxa, Kevin: 2 numeros ligados ainda.' }));
  conf(r.acao === 'respondeu' && chamadas.length === 1, 'responder a uma RESPOSTA do bot e conversa: chama a IA mesmo sem "?"');
  r = await api._botIaResponder(env, cfg, pacote({ texto: 'bora time', responde: true, citado: '*Resumo do dia · 05/11/2026 (quinta)*' }));
  conf(r.acao === 'visto' && chamadas.length === 1, 'responder ao RESUMO sem pergunta: visto (nao e com o bot)');
  r = await api._botIaResponder(env, cfg, pacote({ texto: 'quantas faltam pra minha meta?', responde: true, citado: '*Resumo do dia · 05/11/2026 (quinta)*' }));
  conf(r.acao === 'respondeu' && chamadas.length === 2, 'responder ao resumo COM pergunta: chama');
}

// ══ 4. SEM TEXTO ═══════════════════════════════════════════════════════════════════════
titulo('4. Audio e imagem');
{
  const { api, env, chamadas } = monta(MUNDO);
  const cfg = cfgDe(api);
  let r = await api._botIaResponder(env, cfg, pacote({ texto: '', tipo: 'audio', menciona: true }));
  conf(r.acao === 'respondeu' && r.resposta === api.BOT_IA_SEM_TEXTO && chamadas.length === 0, 'audio marcando o bot: resposta fixa "Me manda por texto", sem IA');
  r = await api._botIaResponder(env, cfg, pacote({ texto: '', tipo: 'imagem', menciona: true }));
  conf(r.acao === 'calado' && r.motivo === 'sem texto' && chamadas.length === 0, 'imagem sem legenda: calado');
  r = await api._botIaResponder(env, cfg, pacote({ texto: '', tipo: 'audio' }));
  conf(r.acao === 'visto', 'audio sem marcar o bot: so visto');
}

// ══ 5. OS FREIOS ═══════════════════════════════════════════════════════════════════════
titulo('5. Os freios (a chave do Gemini e gratis e dividida)');
// Uma linha de bot_chat que CONTOU uma chamada a IA (respondeu, calado pela IA ou erro).
const linhaChat = (o) => ({ ts: agoraS() - 60, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'x' + Math.random(), de_jid: '5515999990005@s.whatsapp.net', de_nome: 'Alguem', texto: 'oi', acao: 'respondeu', resposta: 'ok', chamadas: 1, ...o });
{
  const { api, env, chamadas } = monta({ ...MUNDO, chat: Array.from({ length: 40 }, (_, i) => linhaChat({ msg_id: 'h' + i, de_jid: '5515999990' + String(100 + i) + '@s.whatsapp.net' })) });
  const r = await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'oi', menciona: true }));
  conf(r.acao === 'calado' && /limite por hora/.test(r.motivo) && chamadas.length === 0, '40 chamadas na ultima hora no grupo: calado, sem chamar a IA');
}
{
  // 60 chamadas hoje, todas ha mais de 1 h: o freio da hora passa, o do dia segura.
  const { api, env, chamadas } = monta({ ...MUNDO, chat: Array.from({ length: 300 }, (_, i) => linhaChat({ msg_id: 'd' + i, ts: agoraS() - 7200 })) });
  const r = await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'oi', menciona: true }));
  conf(r.acao === 'calado' && /limite do dia/.test(r.motivo) && chamadas.length === 0, 'orcamento do dia do grupo (300 no vend) esgotado: calado');
}
{
  const { api, env, chamadas } = monta({ ...MUNDO, chat: Array.from({ length: 8 }, (_, i) => linhaChat({ msg_id: 'p' + i, de_jid: '5515999990001@s.whatsapp.net' })) });
  const r = await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'oi', menciona: true }));
  conf(r.acao === 'calado' && /mesma pessoa/.test(r.motivo) && chamadas.length === 0, '8 da mesma pessoa em 10 min: calado');
  const r2 = await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'oi', menciona: true, de_jid: '5515999990009@s.whatsapp.net', de_fone: '5515999990009' }));
  conf(r2.acao === 'respondeu' && chamadas.length === 1, 'outra pessoa no mesmo grupo continua atendida');
}
{
  const { api, env, chamadas, cfgdb } = monta({ ...MUNDO, config: { bot_ia_quota_ate: String(agoraS() + 1800) } });
  const cfg = cfgDe(api);
  let r = await api._botIaResponder(env, cfg, pacote({ texto: 'oi', menciona: true }));
  conf(r.acao === 'respondeu' && /volto às 11:30/.test(r.resposta) && chamadas.length === 0, 'em pausa de cota, marcado: UMA resposta fixa com a hora da volta, sem IA');
  r = await api._botIaResponder(env, cfg, pacote({ texto: 'oi de novo', menciona: true }));
  conf(r.acao === 'calado' && /sem cota/.test(r.motivo) && chamadas.length === 0, 'a segunda no mesmo bloco de hora fica calada');
  r = await api._botIaResponder(env, cfg, pacote({ texto: 'meu numero caiu' }));
  conf(r.acao === 'calado' && chamadas.length === 0, 'espontaneo em pausa de cota: calado, sem aviso');
  conf(!!cfgdb['bot_ia_quotaviso_' + GV.replace(/\D/g, '').slice(-12) + '_' + Math.floor(agoraS() / 3600)], 'a reserva do aviso e por grupo de verdade (jid) e por hora (app_config)');
}

// ══ 6. QUEM E QUEM ═════════════════════════════════════════════════════════════════════
titulo('6. Quem perguntou: so por jid/telefone, nunca pelo nome do WhatsApp');
{
  const { api, env, estado } = monta(MUNDO);
  const cfg = cfgDe(api);
  const q = (jid, fone) => api._botIaQuem(env, cfg, estado, jid, fone);
  conf((await q('5515999990001@s.whatsapp.net', '')).id === GUI, 'jid igual ao de pessoas[]: e o Guilherme');
  const bry = await q('111222333444@lid', '');
  conf(bry.id === BRYAN && bry.role === 'cobrador' && bry.chefe === false, 'LID igual ao de pessoas[]: e o Bryan (cobrador, nao e chefe)');
  const bruno = await q('999999999999@lid', '15999990009');
  conf(bruno.id === 'socio_x4dy6d' && bruno.chefe === true, 'telefone bate pelos 8 ultimos digitos (sem DDI): e o Bruno, chefe');
  conf((await q('', '5515977770001')).id === KEVIN, 'numero da casa com dono vendedor ativo (chip.at) identifica o Kevin');
  conf((await q('', '5515977770002')).id === '', 'chip de coluna da Contingencia (ccol_1) nao identifica ninguem');
  conf((await q('5515900000000@s.whatsapp.net', '5515900000000')).id === '', 'numero desconhecido: ninguem');
  const nada = await q('', '');
  conf(nada.id === '' && Array.isArray(nada.equipe) && nada.equipe.length === 6, 'sem jid nem fone: ninguem (e a equipe vem junto, sem o afiliado, pra nao ler o banco duas vezes)');
}
{
  // pushName igual ao nome de um usuario NAO identifica, e sem identificacao a IA nao recebe pedido nem placar.
  const { api, env, chamadas } = monta(MUNDO);
  const r = await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'a joselina da silva ja pagou?', menciona: true, de_jid: '5515900000000@s.whatsapp.net', de_fone: '5515900000000', de_nome: 'Guilherme' }));
  const user = chamadas[0].user;
  conf(r.quem_id === '' && /Pessoa não identificada/.test(user), 'nome do WhatsApp "Guilherme" sem jid/fone conhecido: pessoa nao identificada');
  conf(!/Placar de hoje/.test(user) && !/1793903844876/.test(user) && !/Joselina Da Silva/.test(user), 'e o contexto vai SEM placar e SEM pedido');
  conf(/desconhecido \(nome no WhatsApp: Guilherme\)/.test(user) && r.viu.includes('sem identificação'), 'a IA sabe que e desconhecido (e a tela ve "sem identificação")');
}

// ══ 7. O CONTEXTO ══════════════════════════════════════════════════════════════════════
titulo('7. O contexto que vai pra IA (so o que a pessoa pode ver, com prova)');
{
  const { api, env, chamadas } = monta(MUNDO);
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'quantas vendas fiz hoje?', menciona: true }));
  const user = chamadas[0].user;
  conf(/Placar de hoje \(05\/11\/2026\): Guilherme 2 pedidos/.test(user), 'grupo dos vendedores: o placar de hoje (o Guilherme tem 2 pedidos)');
  conf(/Quem perguntou hoje: 2 pedidos, próximo marco 5 \(faltam 3\)/.test(user), 'e a linha de quem perguntou, com o proximo marco');
  conf(/Quem perguntou: Guilherme \(vendedor\)/.test(user) && /Equipe: Guilherme \(vendedor\), Kevin Marques \(vendedor\), Bryan Amorim \(cobrador\)/.test(user), 'cabecalho: quem perguntou e a equipe com cargo');
  conf(/aviso_entregue: true/.test(user), 'com push da direcao cadastrado, aviso_entregue = true');
  conf(!/Números de/.test(user), 'pergunta sem falar de numero nao traz os numeros');
}
{
  const { api, env, chamadas } = monta({ ...MUNDO,
    conn: [{ nk: '5515988880001', st: 'caiu', ts: agoraS() - 300 }],
    queda: [{ nk: '5515988880001', em: agoraS() - 300, motivo: 'caiu', feito: 1 }],
    uso: [{ nk: '5515988880002', user_id: GUI, nome: 'Guilherme', desde: agoraS() - 3600, ate: agoraS() + 600 }] });
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'meu numero caiu' }));
  const user = chamadas[0].user;
  conf(/Números de Guilherme \(3 cadastrados, 1 em uso ou aquecimento, 1 recebendo lead agora, 1 com queda registrada\):/.test(user), '"meu numero caiu": o cabecalho dos numeros do vendedor, com prova');
  conf(/\(15\) \.\.\.-0001: em uso · RECEBENDO lead agora · interruptor: ligado em 2 de 2 pressels/.test(user), 'o numero em uso: recebe lead, interruptor ligado em 2 de 2 (a pressel pausada nao conta)');
  conf(/\.\.\.-0002: parado · NÃO recebe lead agora \(não está Em uso\) · app aberto/.test(user), 'o numero parado: nao recebe porque nao esta Em uso, e o interruptor dele nem aparece');
  conf(/\.\.\.-0003: banido/.test(user), 'o banido aparece como banido');
  conf(/QUEDA REGISTRADA às 10:55 \(caiu\), já desligado da roleta pelo sistema/.test(user), 'queda registrada em swweb_queda, com hora e o que o sistema fez');
  conf(/\.\.\.-0002: [^\n]*sem queda registrada/.test(user), 'numero sem linha em swweb_queda: "sem queda registrada"');
  conf(/app aberto por Guilherme desde 10:00/.test(user), 'swweb_uso com `ate` no futuro: app aberto por ele');
  conf(/último estado reportado pelo app: caiu \(pediu QR\) às 10:55/.test(user) && /o app nunca reportou estado desse número/.test(user), 'swweb_conn: o estado que o app reportou, ou "nunca reportou"');
  conf(!/conectado/i.test(user), 'NUNCA a palavra "conectado" sem o app ter reportado pronto');
  conf(!/55159888/.test(user), 'o numero inteiro nao vai (so DDD e 4 ultimos)');
}
{
  const { api, env, chamadas } = monta({ ...MUNDO, conn: [{ nk: '5515988880001', st: 'pronto', ts: agoraS() - 60 }] });
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'meu numero caiu' }));
  conf(/pronto \(conectado\) às 10:59/.test(chamadas[0].user), 'so com o app dizendo "pronto" o contexto fala em conectado');
}
{
  // A TAG da Contingencia: o chip guarda o ID dela (st_xxxx); o que diz banido ou restrito e o PAPEL.
  const chips = [
    { num: '5515988880001', at: GUI, st: 'ativo', wa_st: 'st_ban1' },
    { num: '5515988880002', at: GUI, st: 'ativo', wa_st: 'st_res1' },
  ];
  const wa_statuses = [{ id: 'st_ban1', label: 'Banido', papel: 'banido' }, { id: 'st_res1', label: 'Restrito', papel: 'restrito' }];
  const { api, env, chamadas } = monta({ ...MUNDO, chips, wa_statuses });
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'meu numero caiu' }));
  const user = chamadas[0].user;
  conf(/\.\.\.-0001: banido/.test(user) && /\.\.\.-0002: restrito \(fora da roleta\)/.test(user), 'banido e restrito pela tag (o papel dela), nao pelo id');
}
{
  // O SellWave Web fechou: o cron desliga o interruptor e marca app_off. O bot diz o motivo certo.
  const pressels = [{ id: 'p1', vendedores: [{ at: GUI, off: { '88880001': 1 }, app_off: { '88880001': true } }] }];
  // O registro do interruptor (pressel_num_log): o mais novo de cada numero diz quem mexeu e quando.
  const numlog = [
    { at: GUI, nk: '88880001', acao: 'liga', por_nome: 'Guilherme', ts: agoraS() - 7200 },
    { at: GUI, nk: '88880001', acao: 'desliga', por_nome: 'Sistema (SellWave Web fechado)', ts: agoraS() - 3600 },
    { at: KEVIN, nk: '77770001', acao: 'desliga', por_nome: 'Kevin Marques', ts: agoraS() - 60 },
  ];
  const { api, env, chamadas } = monta({ ...MUNDO, pressels, numlog });
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'meu numero caiu' }));
  const user = chamadas[0].user;
  conf(/\.\.\.-0001: em uso · NÃO recebe lead agora \(o SellWave Web dele fechou; fica de plantão pra madrugada e religa quando ele abrir o app\) · interruptor: desligado em todas as pressels \(1 desligadas porque o SellWave Web fechou\)/.test(user), 'app fechado: nao recebe, o motivo e o app (de plantao), nao queda');
  conf(/\.\.\.-0001: [^\n]*última mudança no interruptor: desligado por Sistema \(SellWave Web fechado\) em 05\/11 10:00/.test(user), 'quem mexeu no interruptor por ultimo, e quando (o registro mais novo do numero)');
  conf(!/Kevin Marques em/.test(user), 'o registro de outro vendedor nao entra');
  conf(/0 recebendo lead agora/.test(user), 'e o cabecalho conta zero recebendo');
}
{
  // Pressel de AFILIADO sem entrada do vendedor da casa nao conta como "ligado" (chip da casa nunca
  // entra la). Medido ao vivo: 5 da casa desligadas + 5 do afiliado davam "recebendo lead".
  const pressels = [
    { id: 'p1', vendedores: [{ at: GUI, off: { '88880001': 1 }, app_off: { '88880001': true } }] },
    { id: 'pa', afl: 'afl_x', vendedores: [] },
    { id: 'pb', afl: 'afl_x', vendedores: [] },
  ];
  const { api, env, chamadas } = monta({ ...MUNDO, pressels });
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: 'meu numero caiu' }));
  const user = chamadas[0].user;
  conf(/\.\.\.-0001: em uso · NÃO recebe lead agora \(o SellWave Web dele fechou; [^)]*\) · interruptor: desligado em todas as pressels/.test(user), 'pressel de afiliado nao liga o numero da casa');
}
{
  const { api, env, chamadas } = monta(MUNDO);
  const cfg = cfgDe(api);
  await api._botIaResponder(env, cfg, { ...pacote({ texto: 'como ta minha mesa hoje?', menciona: true, jid: GC, de_jid: '111222333444@lid', de_fone: '', de_nome: 'Bryan' }), grupo: 'cob' });
  const user = chamadas[0].user, system = chamadas[0].system;
  conf(/Mesa de Bryan Amorim agora: convertidos hoje 0, faltam cobrar 1, atrasados 0, a receber 1 pedido\./.test(user), 'grupo dos cobradores: a mesa de quem perguntou, em PEDIDOS');
  conf(!/R\$/.test(user), 'e nenhum R$ (o valor total nao vai pros cobradores)');
  conf(/Jeito de falar neste grupo: Tom da cobranca X/.test(system), 'o system leva o tom DO GRUPO');
  conf(/Instruções da direção[^\n]*\nNunca prometa prazo de entrega\./.test(system), 'e as instrucoes da direcao');
  conf(/EXEMPLOS DO JEITO CERTO neste grupo/.test(system) && /a Ivone Cardoso pagou/.test(system) && !/Boa, Fulano, 5 vendas/.test(system), 'no grupo dos cobradores vao os exemplos da cobranca, nunca as frases cruas do marco');
  await api._botIaResponder(env, cfg, pacote({ texto: 'e ai barbadinho', menciona: true }));
  const sys2 = chamadas[1].system;
  conf(/EXEMPLOS DO JEITO CERTO neste grupo/.test(sys2) && /BOOORA krl, 10 cravadas/.test(sys2) && !/Especial Fulano/.test(sys2) && !/a Ivone Cardoso pagou/.test(sys2), 'no vend vao os exemplos dos vendedores (as frases cruas do marco nao entram mais)');
  conf(/Jeito de falar neste grupo: Animado e espontâneo/.test(sys2), 'tom padrao dos vendedores quando nao foi escrito');
}

// ══ 8. A BUSCA DE PEDIDO ═══════════════════════════════════════════════════════════════
titulo('8. A busca de pedido: escopo por cargo e sem chute');
{
  const { api, env, estado } = monta(MUNDO);
  const nomes = await api._cobNomes(env), tagMap = api._cobTagMap(estado, '');
  const quemG = { id: GUI, nome: 'Guilherme', role: 'atendente', chefe: false };
  const quemK = { id: KEVIN, nome: 'Kevin Marques', role: 'atendente', chefe: false };
  const quemB = { id: BRYAN, nome: 'Bryan Amorim', role: 'cobrador', chefe: false };
  const chefe = { id: 'socio_x4dy6d', nome: 'Bruno Correa', role: 'socio', chefe: true };
  const busca = (texto, quem, grupo) => api._botIaAcharPedidos(estado, texto, quem, grupo || 'vend', nomes, tagMap);
  let b = busca('a dona joselina da silva ja pagou?', quemG);
  conf(b.certo === true && b.ids.join() === '1793903844876', '"a dona joselina da silva ja pagou?" (minusculo): nome completo = CERTO');
  conf(/Joselina Da Silva/.test(b.blocos[0]) && /Situação: pago em 04\/11/.test(b.blocos[0]), 'e o bloco vem completo, com a situacao');
  b = busca('e a joselina?', quemG);
  conf(b.certo === false && b.provavel === true && b.ambiguo === false && b.ids.join() === '1793903844876', '"joselina" sozinha com um candidato so: PROVAVEL, nao certo');
  b = busca('a maria pagou?', quemK);
  conf(b.ambiguo === true && b.ids.length === 2 && b.ids.includes('2') && b.ids.includes('3'), '"a maria pagou" com Maria Silva e Maria Souza: AMBIGUO com os 2 candidatos');
  conf(b.blocos.every((x) => !/Retorno marcado/.test(x)), 'candidato ambiguo vai resumido (sem a ficha inteira)');
  b = busca('o 15 98888-7777 pagou?', quemG);
  conf(b.certo === true && b.ids.join() === '1793903844876', 'telefone com 11 digitos casa pelos 8 ultimos');
  b = busca('cpf 123.456.789-01', quemG);
  conf(b.certo === true && b.ids.join() === '1793903844876', 'CPF casa');
  b = busca('pedido 1793903844876', quemG);
  conf(b.certo === true && b.ids.join() === '1793903844876', '"pedido <id>" casa pelo id');
  b = busca('e o 44812301?', quemG);
  conf(b.certo === true && b.ids.join() === '1793903844876', 'o id da Five casa');
  // ESCOPO: filtro antes de pontuar.
  b = busca('o carlos pereira pagou?', quemK);
  conf(b.blocos.length === 0 && b.foraDoEscopo.length === 1 && String(b.foraDoEscopo[0].id) === '4', 'vendedor nao acha pedido de outro vendedor: vai pra foraDoEscopo');
  b = busca('o carlos pereira pagou?', quemG);
  conf(b.certo === true && b.ids.join() === '4', 'o dono do pedido acha');
  b = busca('o carlos pereira pagou?', quemB, 'cob');
  conf(b.blocos.length === 0 && b.foraDoEscopo.length === 1, 'cobrador nao acha pedido da fila de outro cobrador');
  b = busca('a maria souza pagou?', quemB, 'cob');
  conf(b.certo === true && b.ids.join() === '3', 'cobrador acha pedido SEM dono (a varredura ainda nao deu)');
  b = busca('a maria silva pagou?', quemB, 'cob');
  conf(b.certo === true && b.ids.join() === '2', 'e o da fila dele');
  b = busca('o carlos pereira pagou?', chefe, 'cob');
  conf(b.certo === true && b.ids.join() === '4', 'chefe acha tudo');
  b = busca('a ana afiliada pagou?', chefe);
  conf(b.blocos.length === 0 && b.foraDoEscopo.length === 0, 'pedido de afiliado nunca entra, nem pro chefe');
  b = busca('a joselina da silva pagou?', { id: '', nome: '', role: '', chefe: false });
  conf(b.blocos.length === 0 && b.termos.length === 0, 'sem identificacao nao busca');
}
{
  const muitos = Array.from({ length: 6 }, (_, i) => ({ id: 500 + i, nome: 'Jose Numero ' + i, wa: '551599900000' + i, col: 'Entregues', at: GUI, vl: 100, ts: ms('2026-10-2' + i + 'T10:00:00-03:00') }));
  const { api, env, estado } = monta({ ...MUNDO, leads: LEADS.concat(muitos) });
  const b = api._botIaAcharPedidos(estado, 'o jose pagou?', { id: GUI, chefe: false }, 'vend', await api._cobNomes(env), {});
  conf(b.ambiguo === true && b.blocos.length === 4 && b.ids.length === 4, 'seis "Jose": ate 4 candidatos');
}
{
  // MEDIDO AO VIVO em 06/11/2026: o pedido certo era da fila do Haynan e o Bryan recebia uma lista de
  // parecidos da fila dele; e "rosa helena" dava 3 candidatos quando so um tinha as duas palavras.
  const extra = [
    { id: 701, nome: 'Carlos Mendes', wa: '5515900000701', col: 'Entregues', at: KEVIN, cob: BRYAN, vl: 100, ts: ms('2026-10-20T10:00:00-03:00') },
    { id: 702, nome: 'Rosa Helena de Souza', wa: '5515900000702', col: 'Pagos', spg: 'Pago', at: KEVIN, cob: BRYAN, vl: 100, pago_ts: ms('2026-11-05T10:00:00-03:00'), ts: ms('2026-10-21T10:00:00-03:00') },
    { id: 703, nome: 'Raimundo Antero Rosa', wa: '5515900000703', col: 'Enviados', at: KEVIN, cob: BRYAN, vl: 100, ts: ms('2026-10-22T10:00:00-03:00') },
    { id: 704, nome: 'Cecilia Rosa Ponciano', wa: '5515900000704', col: 'Entregues', at: KEVIN, cob: BRYAN, vl: 100, ts: ms('2026-10-23T10:00:00-03:00') },
  ];
  const { api, env, estado } = monta({ ...MUNDO, leads: LEADS.concat(extra) });
  const nomes = await api._cobNomes(env);
  const quemB = { id: BRYAN, nome: 'Bryan Amorim', role: 'cobrador', chefe: false };
  const busca = (texto) => api._botIaAcharPedidos(estado, texto, quemB, 'cob', nomes, {});
  let b = busca('o pedido do carlos pereira foi pago?');
  conf(b.blocos.length === 0 && b.foraDoEscopo.length === 1 && String(b.foraDoEscopo[0].id) === '4', 'nome inteiro na fila de OUTRO cobrador vence o parecido da minha fila: "e da fila de outra pessoa"');
  b = busca('a dona rosa helena pagou?');
  conf(b.provavel === true && b.ids.join() === '702', '"rosa helena": o unico com as duas palavras e PROVAVEL (sem lista de Rosas)');
  b = busca('e a rosa?');
  conf(b.ambiguo === true && b.ids.length === 3, '"rosa" sozinha: os 3 candidatos');
  b = busca('quantos pedidos tenho atrasados hoje?');
  conf(b.termos.length === 0 && b.blocos.length === 0, 'pergunta da mesa ("quantos pedidos tenho atrasados") nao vira busca de nome');
  // O caminho inteiro: o contexto diz de quem e o pedido.
  const m = monta({ ...MUNDO, leads: LEADS.concat(extra) });
  await m.api._botIaResponder(m.env, cfgDe(m.api), { ...pacote({ texto: 'o pedido do carlos pereira foi pago?', menciona: true, jid: GC, de_jid: '111222333444@lid', de_fone: '', de_nome: 'Bryan' }), grupo: 'cob' });
  conf(/são de outra pessoa: Carlos Pereira \(fila de Haynan\)/.test(m.chamadas[0].user), 'e o contexto que vai pra IA diz "fila de Haynan"');
}

// ══ 9. O BLOCO DO PEDIDO ═══════════════════════════════════════════════════════════════
titulo('9. O bloco do pedido (nasce de _cobDetalhe, sem CPF, endereco nem comentario)');
{
  const { api, env, estado } = monta(MUNDO);
  const nomes = await api._cobNomes(env);
  const bloco = (id, completo) => api._botIaPedidoTexto(LEADS.find((l) => l.id === id), estado, nomes, {}, completo !== false);
  const t1 = bloco(1793903844876);
  conf(/^#1793903844876 Joselina Da Silva \(Sorocaba\/SP\) · GlicoSix 3 un · R\$ 297,00 · cadastrado em 01\/11 por Guilherme · cobrador: Bryan Amorim/.test(t1), 'cabecalho: id, nome, cidade, produto, valor, quando, vendedor e cobrador');
  conf(/Situação: pago em 04\/11 \(Pix\)\./.test(t1), 'pago: "pago em DD/MM" com a forma');
  conf(/Pagamento: quitado\./.test(t1), 'pagamento quitado');
  conf(/Último movimento: Entregues -> Pagos em 04\/11 15:20 \(Bryan Amorim\)\./.test(t1), 'so o ULTIMO movimento do historico, com quem fez');
  conf(/Comentários no pedido: 1, o último em 04\/11 15:21 \(o conteúdo fica na dash\)\./.test(t1), 'comentarios: so a contagem e a data');
  conf(!/99999-0000/.test(t1) && !/cliente pagou/.test(t1), 'o TEXTO do comentario nunca vai (tem telefone dentro dele)');
  conf(!/12345678901/.test(t1) && !/123\.456/.test(t1) && !/Rua das Flores/.test(t1) && !/18000/.test(t1), 'nem CPF, nem endereco, nem CEP');
  conf(!/https?:/.test(t1) && !/fivedelivery/.test(t1), 'nem link');
  const t2 = bloco(2);
  conf(/Situação: entregue, em cobrança · transportadora diz: Entregue \(03\/11\)\./.test(t2), 'Entregues nao pago: a coluna em palavras e o selo da transportadora com a data');
  conf(/Pagamento: não pago, falta R\$ 197,00\./.test(t2) && /Retorno marcado: 07\/11 09:00\./.test(t2), 'falta pagar e o retorno marcado (agend) em DD/MM HH:MM');
  conf(/Rastreio: sem código ainda\./.test(t2), 'sem rastreio');
  const t3 = bloco(3);
  conf(/falta R\$ 147,00 \(já entrou R\$ 50,00 em 1 parcela\)\./.test(t3) && /cobrador: sem dono ainda/.test(t3), 'pagamento parcial: "ja entrou" e o saldo; sem cobrador = "sem dono ainda"');
  conf(/Retorno marcado: nenhum\./.test(t3), 'sem retorno marcado');
  conf(/Situação: aguardando aprovação da direção\./.test(bloco(6)), 'manual nao aceito: aguardando aprovacao');
  conf(/Aprovação da direção: ainda NÃO aprovado/.test(bloco(6)) && !/Aprovação da direção/.test(bloco(2)), 'pedido manual diz se a direcao ja aprovou; pedido da plataforma nao tem a linha');
  const curto = bloco(2, false);
  conf(/Situação:/.test(curto) && !/Pagamento:/.test(curto) && !/Retorno marcado/.test(curto), 'bloco resumido (candidato ambiguo): so cabecalho e situacao');
  const frust = api._botIaPedidoTexto({ id: 7, nome: 'Perda Total', col: 'Frustrados', ship: 'NOT_DELIVERED', ship_ts: ms('2026-11-02T10:00:00-03:00'), at: GUI, vl: 197, ts: ms('2026-10-28T10:00:00-03:00') }, estado, nomes, {}, true);
  conf(/Situação: frustrado \(perda\)\./.test(frust) && !/transportadora diz/.test(frust), 'coluna de perda: a perda manda e o selo nao aparece');
  const plat = api._botIaPedidoTexto({ id: 8, nome: 'Plataforma Diz', col: 'Enviados', col_plat: 'Saiu para Entrega', at: GUI, vl: 197, ts: ms('2026-11-01T10:00:00-03:00') }, estado, nomes, {}, true);
  conf(/Situação: enviado · plataforma: Saiu para Entrega\./.test(plat), 'quando a plataforma diz outra coisa que a coluna, as duas aparecem');
}

// ══ 10. A IA E A SAIDA ═════════════════════════════════════════════════════════════════
titulo('10. A resposta da IA e a limpeza da saida (que e publica)');
// Uma pergunta do Guilherme marcando o bot, com a IA respondendo o que `mundoIa.ia` manda.
const pergunta = (mundoIa, texto) => { const m = monta({ ...MUNDO, ...mundoIa }); return m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: texto || 'a joselina da silva ja pagou?', menciona: true })).then((r) => ({ r, ...m })); };
{
  let { r, chamadas } = await pergunta({ ia: [{ json: { responder: true, texto: 'Pagou sim, dia 04/11 no Pix.' } }] });
  conf(r.acao === 'respondeu' && r.resposta === 'Pagou sim, dia 04/11 no Pix.' && r.chamadas === 1 && r.modelo === 'gemini-3.5-flash', 'JSON normal: respondeu, 1 chamada, primeiro modelo da cascata');
  conf(chamadas[0].body.generationConfig.responseMimeType === 'application/json' && chamadas[0].body.generationConfig.thinkingConfig.thinkingBudget === 0, 'pede JSON e sem pensamento (senao o 2.5 gasta o teto pensando)');
  ({ r } = await pergunta({ ia: [{ json: { responder: false, texto: '' } }] }));
  conf(r.acao === 'respondeu' && /^tô aqui!/.test(r.resposta) && /saiu a resposta padrão/.test(r.motivo), 'MARCADO e a IA calou (responder:false): sai a resposta padrao do grupo, nunca silencio');
  {
    const m = monta({ ...MUNDO, ia: [{ json: { responder: false, texto: '' } }] });
    const r2 = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'meu numero caiu', menciona: false }));
    conf(r2.acao === 'calado' && /a IA preferiu/.test(r2.motivo) && !r2.resposta, 'sem marcar (entrou sozinho) e a IA calou: calado de verdade');
    conf(/Você foi MARCADO nesta mensagem/.test((await pergunta({ ia: [JSON_OK] })).chamadas[0].user) && !/Você foi MARCADO|Falaram seu nome|Responderam uma mensagem sua/.test(m.chamadas[0].user), 'a IA sabe quando foi marcada e quando entrou sozinha');
    conf(/Quando te MARCAM \(@Barbadinho\), responda sempre/.test(m.chamadas[0].system) && /no condicional/.test(m.chamadas[0].system) && /Prometer mudar seu jeito/.test(m.chamadas[0].system), 'as regras: marcado responde sempre; provavel no condicional; nao promete mudar o jeito');
  }
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'Liga pra ela no 15 99999 0000.' } }] }));
  conf(r.acao === 'calado' && /dado pessoal \(telefone\)/.test(r.motivo) && r.resposta === '', 'telefone na saida: calado (a resposta e publica)');
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'Manda por wa.me/5515999990000' } }] }));
  conf(r.acao === 'calado' && /\(link\)/.test(r.motivo), 'link wa.me na saida: calado');
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'CPF 123.456.789-01 confere' } }] }));
  conf(r.acao === 'calado' && /\(cpf\)/.test(r.motivo), 'CPF na saida: calado');
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'O pedido #1793903844876 da Joselina está pago.' } }] }));
  conf(r.acao === 'respondeu' && /#1793903844876/.test(r.resposta), 'o id do pedido que veio nos dados passa');
  {
    // O rastreio do pedido encontrado nao e telefone (medido ao vivo: J&T de 15 digitos calava o bot).
    const leads = LEADS.map((l) => (l.id === 1793903844876 ? { ...l, track: '888031023495895' } : l));
    const x = await pergunta({ leads, ia: [{ json: { responder: true, texto: 'Pago. Rastreio J&T 888031023495895.' } }] });
    conf(x.r.acao === 'respondeu' && /888031023495895/.test(x.r.resposta), 'o codigo de rastreio do pedido encontrado passa pela mascara');
    const y = await pergunta({ leads, ia: [{ json: { responder: true, texto: 'Rastreio 999999999999999.' } }] });
    conf(y.r.acao === 'calado' && /telefone/.test(y.r.motivo), 'um numero longo que nao veio nos dados continua barrado');
  }
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'Pagou **sim** \u2014 relaxa' } }] }));
  conf(r.resposta === 'Pagou *sim*, relaxa', '**negrito** vira *negrito* e travessao vira virgula');
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'x'.repeat(2000) } }] }));
  conf(r.resposta.length === 700, 'texto de 2000 chars corta em 700');
  ({ r } = await pergunta({ ia: [{ texto: '```json\n{"responder": true, "texto": "Com cerca de código"}\n```' }] }));
  conf(r.acao === 'respondeu' && r.resposta === 'Com cerca de código', 'JSON com cerca de codigo e lido');
  ({ r } = await pergunta({ ia: [{ texto: 'Só texto solto, sem JSON' }] }));
  conf(r.acao === 'respondeu' && r.resposta === 'Só texto solto, sem JSON', 'texto solto vira resposta (tolerante)');
}
{
  // `buscar`: a IA pede um pedido que nao veio, o worker busca e chama de novo com ele.
  const { r, chamadas } = await pergunta({ ia: [{ json: { responder: true, texto: 'Deixa eu ver', buscar: 'joselina' } }, { json: { responder: true, texto: 'Achei: pago.' } }] }, 'e aquela cliente, pagou?');
  conf(r.chamadas === 2 && chamadas.length === 2 && r.resposta === 'Achei: pago.', '`buscar` preenchido: segunda chamada, e a resposta e a da segunda');
  conf(/Pedido PROVÁVEL \(confirme antes de afirmar pagamento\):\n#1793903844876 Joselina Da Silva/.test(chamadas[1].user) && r.viu.some((v) => /2a busca: 1793903844876/.test(v)), 'o pedido achado entra no contexto da segunda rodada');
}
{
  // Aviso a direcao = push na dash pra cada diretor/socio, registrado, e 1 por assunto a cada 30 min.
  const m = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'Relaxa, tem 2 numeros ligados. Já avisei a direção.', avisar_direcao: 'numero do Guilherme caiu' } }] });
  const cfg = cfgDe(m.api);
  let r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: 'meu numero caiu' }));
  conf(r.alerta === 1 && m.pushes.length === 2 && m.pushes.map((p) => p.userId).sort().join() === 'dir,socio_x4dy6d', 'avisar_direcao: push pra CADA diretor/socio da casa (nao pro afiliado), alerta 1');
  conf(/Barbadinho: pedido de ajuda no grupo/.test(m.pushes[0].payload.title) && /Guilherme no grupo GlicoSix - Vendedores: "meu numero caiu" · numero do Guilherme caiu/.test(m.pushes[0].payload.body), 'o push diz quem, em que grupo, o que e o resumo da IA');
  conf(m.envios.length === 1 && m.envios[0].tipo === 'ia_aviso' && m.envios[0].status === 'enviado' && m.envios[0].via === 'push', 'registro em bot_envios tipo ia_aviso');
  conf(!!m.cfgdb['bot_iaav_' + GUI + ':numero'], 'a marca do assunto (pessoa:numero) fica em app_config');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: 'meu numero caiu de novo' }));
  conf(r.alerta === 1 && m.pushes.length === 2 && m.envios.length === 1, 'a segunda vez em 30 min nao manda de novo (e a linha continua com alerta)');
}
{
  const { r, chamadas } = await pergunta({ ia: [{ status: 429 }, JSON_OK] });
  conf(r.acao === 'respondeu' && chamadas.length === 2 && chamadas[1].modelo === 'gemini-2.5-flash' && r.modelo === 'gemini-2.5-flash', '429 no primeiro modelo: o segundo responde');
  const dois = await pergunta({ ia: [{ status: 429 }, { status: 429 }, JSON_OK] });
  conf(dois.r.acao === 'erro' && dois.chamadas.length === 2 && /cota da IA esgotada/.test(dois.r.motivo), '429 nos dois modelos tentados: erro (no maximo 2 modelos por mensagem)');
  conf(Number(dois.cfgdb.bot_ia_quota_ate) === agoraS() + 3600, 'e a pausa de 1 h fica gravada em bot_ia_quota_ate');
  const max = await pergunta({ ia: [{ finish: 'MAX_TOKENS', json: { responder: true, texto: 'cortado' } }, JSON_OK] });
  conf(max.r.acao === 'respondeu' && max.chamadas.length === 2 && max.r.modelo === 'gemini-2.5-flash', 'finishReason MAX_TOKENS: passa pro proximo modelo');
  conf(!max.cfgdb.bot_ia_quota_ate, '(e nao e cota: nada de pausa)');
  const vazio = await pergunta({ ia: [{ texto: '' }, JSON_OK] });
  conf(vazio.r.acao === 'respondeu' && vazio.chamadas.length === 2, 'texto vazio: passa pro proximo');
  const proibido = await pergunta({ ia: [{ status: 403 }, JSON_OK] });
  conf(proibido.r.acao === 'erro' && proibido.chamadas.length === 1 && /403/.test(proibido.r.motivo) && !proibido.cfgdb.bot_ia_quota_ate, '403: para na hora (a chave e que esta errada), sem pausa de cota');
  const fora = await pergunta({ ia: [{ status: 503 }, JSON_OK] });
  conf(fora.r.acao === 'respondeu' && fora.chamadas.length === 2, '503: passa pro proximo');
}
{
  const { r, chamadas } = await pergunta({ anthropic: 'sk-ant-teste', ia: [{ json: { responder: true, texto: 'Pelo Claude.' } }] });
  conf(chamadas.length === 1 && chamadas[0].anthropic && /api\.anthropic\.com\/v1\/messages/.test(chamadas[0].url), 'com chave Anthropic a primeira chamada vai pra api.anthropic.com');
  conf(typeof chamadas[0].body.system === 'string' && /Barbadinho/.test(chamadas[0].body.system) && chamadas[0].body.model === 'claude-opus-5-5' && chamadas[0].body.messages[0].role === 'user', 'o body leva `system`, o modelo (Claude Opus 5.5) e a mensagem do usuario');
  const b0 = chamadas[0].body, h0 = chamadas[0].headers;
  conf(r.acao === 'respondeu' && r.resposta === 'Pelo Claude.' && r.modelo === 'claude-opus-5-5', 'le o bloco de TEXTO (o de pensamento vem antes e fica de fora)');
  conf(b0.output_config && b0.output_config.effort === 'medium' && b0.output_config.format && b0.output_config.format.type === 'json_schema' && b0.output_config.format.schema.additionalProperties === false, 'pede effort medium e a resposta no formato do schema (JSON garantido)');
  conf(!('temperature' in b0) && !('thinking' in b0), 'sem temperature (a versao nova da API recusa) e sem mexer no pensamento (sempre ligado no Opus 5.5)');
  conf(b0.fallbacks === 'default' && h0['anthropic-beta'] === 'server-side-fallback-2026-07-01' && h0['anthropic-version'] === '2026-10-21', 'fallbacks "default" com o cabecalho certo e a versao 2026-10-21');
  conf(b0.max_tokens >= 4000, 'max_tokens folgado (o pensamento conta nele)');
}
{
  // Claude recusou (filtro de seguranca) ou bateu no teto: cai no Gemini, sem silencio.
  const rec = await pergunta({ anthropic: 'sk-ant-teste', ia: [{ stop: 'refusal', stop_details: { category: 'cyber' }, json: {} }, JSON_OK] });
  conf(rec.r.acao === 'respondeu' && rec.chamadas.length === 2 && !rec.chamadas[1].anthropic && /gemini/.test(rec.r.modelo), 'recusa da Claude: o Gemini responde');
  const teto = await pergunta({ anthropic: 'sk-ant-teste', ia: [{ stop: 'max_tokens', texto: '{"responder": tr' }, JSON_OK] });
  conf(teto.r.acao === 'respondeu' && teto.chamadas.length === 2, 'Claude cortada no teto: o Gemini responde');
  const caiu = await pergunta({ anthropic: 'sk-ant-teste', ia: [{ status: 529 }, JSON_OK] });
  conf(caiu.r.acao === 'respondeu' && caiu.chamadas.length === 2 && !caiu.cfgdb.bot_ia_quota_ate && !caiu.chamadas[1].anthropic, 'Claude sobrecarregada (529): cai pra cascata do Gemini, sem pausa');
}

// ══ 11. A ROTA DO AGENTE ═══════════════════════════════════════════════════════════════
titulo('11. A rota do agente (POST /api/bot/agente/msg, msg-ack e o ping)');
// O bot do PC aberto, pingando ha 5 s, com o numero do Barbadinho.
const AGENTE = (o) => ({ config: { bot_agente_token: TOKEN, bot_agente: JSON.stringify({ ts: agoraS() - 5, estado: 'open', numero: NUMERO_BOT, nome: 'Barbadinho', ...(o || {}) }) } });
{
  const m = monta({ ...MUNDO, ...AGENTE() });
  const b = msg({ texto: 'barbadinho, a joselina da silva pagou?', menciona: true });
  let r = await m.api.handleBotAgente(req('/api/bot/agente/msg', b), m.env);
  conf(r._status === 200 && r._json.ok === true && r._json.resposta === 'Fechado, pode deixar.' && r._json.chat_id === 1, 'token certo + agente aberto + numero igual: responde com o texto e o chat_id');
  conf(m.chat.length === 1 && m.chat[0].acao === 'pendente' && m.chat[0].quem_id === GUI && m.chat[0].msg_id === b.msg_id && m.chat[0].chamadas === 1, 'a linha fica PENDENTE (com quem e quantas chamadas) ate o agente confirmar');
  conf(m.quem.length === 1 && m.quem[0].de_jid === b.de_jid && m.quem[0].fone === '5515999990001' && m.quem[0].n === 1, 'quem e quem: o remetente entrou em bot_quem');
  r = await m.api.handleBotAgente(req('/api/bot/agente/msg', b), m.env);
  conf(r._json.ignorar === true && r._json.motivo === 'repetida' && m.chat.length === 1 && m.chamadas.length === 1, 'a MESMA msg_id de novo: ignorar (UNIQUE), sem chamar a IA');
  conf(m.quem[0].n === 2, '(mas o quem e quem conta a repetida: e so quem/quando)');
  r = await m.api.handleBotAgente(req('/api/bot/agente/msg-ack', { chat_id: 1, ok: true, msg_id: '3EB0ABC' }), m.env);
  conf(r._json.ok === true && m.chat[0].acao === 'respondeu' && m.chat[0].resp_msg_id === '3EB0ABC' && m.chat[0].resp_status === 'enviado', 'msg-ack ok:true: a linha vira respondeu com o id da mensagem no grupo');
  const b2 = msg({ texto: 'e o kevin?', menciona: true });
  r = await m.api.handleBotAgente(req('/api/bot/agente/msg', b2), m.env);
  await m.api.handleBotAgente(req('/api/bot/agente/msg-ack', { chat_id: r._json.chat_id, ok: false, erro: 'timeout' }), m.env);
  conf(m.chat[1].acao === 'erro' && m.chat[1].motivo === 'timeout' && m.chat[1].resp_status === 'erro', 'msg-ack ok:false: vira erro com o motivo do agente');
  // Outra pessoa (o Guilherme acabou de conversar com o bot: com ele seria conversa, e a IA decidiria).
  r = await m.api.handleBotAgente(req('/api/bot/agente/msg', msg({ texto: 'bom dia', de_jid: '5515999990003@s.whatsapp.net', de_fone: '5515999990003', de_nome: 'Fulano' })), m.env);
  conf(r._json.ok === true && r._json.resposta === '' && m.chat.length === 3 && m.chat[2].acao === 'visto', 'mensagem que nao e pro bot: resposta vazia e a linha fica so como visto');
  r = await m.api.handleBotAgente(req('/api/bot/agente/msg', msg({ texto: 'oi', menciona: true, ts: agoraS() - 600 })), m.env);
  conf(r._json.ignorar === true && r._json.motivo === 'velha' && m.chat.length === 3, 'mensagem de 10 min atras: ignorar (o bot estava fora)');
  const quemAntes = m.quem.length;
  r = await m.api.handleBotAgente(req('/api/bot/agente/msg', msg({ texto: 'oi', menciona: true, jid: '120363000000000000@g.us' })), m.env);
  conf(r._json.ignorar === true && m.chat.length === 3 && m.quem.length === quemAntes, 'grupo desconhecido: ignorar, sem gravar nada');
  r = await m.api.handleBotAgente(req('/api/bot/agente/msg', msg({ texto: 'oi', menciona: true }), 'token-errado-' + 'x'.repeat(20)), m.env);
  conf(r._status === 401 && m.chat.length === 3, 'token errado: 401');
}
{
  const fechado = async (o, nome) => { const m = monta({ ...MUNDO, ...AGENTE(o) }); const r = await m.api.handleBotAgente(req('/api/bot/agente/msg', msg({ texto: 'oi', menciona: true })), m.env); conf(r._status === 403 && m.chat.length === 0 && m.quem.length === 0 && m.chamadas.length === 0, nome); };
  await fechado({ estado: 'close' }, 'agente fechado: 403 e nada gravado');
  await fechado({ ts: agoraS() - 60 }, 'ultimo ping ha 60 s: 403 (o agente pinga a cada 5 s)');
  await fechado({ numero: '5515900000000' }, 'numero gravado diferente do que o agente diz: 403');
}
{
  // Resposta desligada no grupo: o /msg so preenche o quem e quem.
  const m = monta({ ...MUNDO, cfg: { ...CFG_RAW, ia: { ...CFG_RAW.ia, responde: { vend: false, cob: true } } }, ...AGENTE() });
  const r = await m.api.handleBotAgente(req('/api/bot/agente/msg', msg({ texto: 'oi', menciona: true })), m.env);
  conf(r._json.ignorar === true && m.chat.length === 0 && m.quem.length === 1 && m.chamadas.length === 0, 'responder desligado no grupo: ignorar, so bot_quem, nenhuma linha em bot_chat');
  const p = await m.api.handleBotAgente(req('/api/bot/agente/ping', { estado: 'open', numero: NUMERO_BOT, nome: 'Barbadinho', versao: '1.6.0' }), m.env);
  conf(p._json.ok === true && Array.isArray(p._json.escuta) && p._json.escuta.join() === GC, 'o ping so manda escutar o grupo com "Responder no grupo" ligado (o outro nem chega aqui)');
  const nada = monta({ ...MUNDO, cfg: { ...CFG_RAW, ia: { ...CFG_RAW.ia, responde: { vend: false, cob: false } } }, ...AGENTE() });
  const p2 = await nada.api.handleBotAgente(req('/api/bot/agente/ping', { estado: 'open', numero: NUMERO_BOT, nome: 'Barbadinho', versao: '1.6.0' }), nada.env);
  conf(Array.isArray(p2._json.escuta) && p2._json.escuta.length === 0, 'tudo desligado: o bot do PC nao repassa nada (nada e lido)');
}

// ══ 12. A PROVOCACAO PERTO DO MARCO ════════════════════════════════════════════════════
titulo('12. A provocacao perto do marco (tick proprio, so vendedores)');
// O Guilherme com N pedidos hoje, o ultimo ha `paradoMin` minutos; provocar ligado.
const mundoProv = (n, paradoMin, extra) => {
  const leads = Array.from({ length: n }, (_, i) => ({ id: 700 + i, nome: 'Venda ' + i, col: 'A Enviar', at: GUI, vl: 197, ts: i === n - 1 ? RELOGIO.agora - paradoMin * 60000 : hoje('08:' + String(10 + i).padStart(2, '0')) }));
  // O bot do PC aberto por padrao (a provocacao do tick so sai com ele aberto); `extra.config` soma.
  const e = extra || {};
  return { ...MUNDO, leads, cfg: { ...CFG_RAW, ia: { ...CFG_RAW.ia, provoca: { ativo: true } } }, ia: [{ json: { texto: 'Guilherme, faltam 2 pra 15 e tu ai dando sopa?' } }], ...e, config: { bot_agente: JSON.stringify({ ts: agoraS() - 5, estado: 'open', numero: NUMERO_BOT }), ...(e.config || {}) } };
};
const tick = (m) => m.api._botIaProvocaTick(m.env, m.api._botNormaliza(m.mundo.cfg, null), DIA);
{
  const m = monta(mundoProv(13, 50));
  await tick(m);
  conf(m.fila.length === 1 && m.fila[0].tipo === 'ia_provoca' && m.fila[0].jid === GV && m.fila[0].texto === 'Guilherme, faltam 2 pra 15 e tu ai dando sopa?', '13 pedidos, marco 15, parado ha 50 min, 11:00: UMA provocacao na fila do grupo dos vendedores');
  conf(m.chat.length === 1 && m.chat[0].acao === 'provocou' && m.chat[0].quem_id === GUI && /faltam 2 pra 15/.test(m.chat[0].texto) && m.chat[0].resp_status === 'enviado', 'e a linha "provocou" em bot_chat');
  conf(/^Vendedor: Guilherme\. Pedidos hoje: 13\. Próximo marco: 15 \(faltam 2\)\. Hora: 11:00\.$/.test(m.chamadas[0].user), 'a IA recebe o vendedor e o marco, sem tempo parado e sem lider (soava cobranca de chefe)');
  conf(/provocação automática pra um vendedor a 2 de um marco/.test(m.chamadas[0].system) && /Sem apelido, sem citar tempo parado, sem comparar/.test(m.chamadas[0].system) && /cadê o \+1\?/.test(m.chamadas[0].system), 'o system e o do grupo + a provocacao animada, sem apelido, sem tempo parado');
  conf(!!m.cfgdb['bot_iaprov_' + DIA + '_' + GUI], 'a reserva (1 por vendedor por dia) fica em app_config');
  await tick(m);
  conf(m.fila.length === 1 && m.chamadas.length === 1, 'de novo no mesmo dia: nada (reserva)');
}
{
  const m = monta(mundoProv(14, 10));
  await tick(m);
  conf(m.fila.length === 0 && m.chamadas.length === 0, '14 pedidos mas o ultimo foi ha 10 min: nao esta parado, nada');
}
{
  const m = monta(mundoProv(13, 50, { config: { ['bot_marcos_' + DIA]: JSON.stringify({ [GUI]: 15 }) } }));
  await tick(m);
  conf(m.fila.length === 0 && m.chamadas.length === 0, 'o 15 ja foi comemorado hoje (bot_marcos_<dia>): nada');
}
{
  const m = monta(mundoProv(4, 50));
  await tick(m);
  conf(m.fila.length === 0 && m.chamadas.length === 0, '4 pedidos a 1 do marco 5: nada (marco abaixo de 10 nao provoca)');
}
{
  const m = monta(mundoProv(13, 50));
  RELOGIO.agora = Date.parse('2026-11-05T23:00:00-03:00');
  try { await tick(m); } finally { RELOGIO.agora = Date.parse('2026-11-05T11:00:00-03:00'); }
  conf(m.fila.length === 0 && m.chamadas.length === 0, 'as 23:00 (fora do horario do incentivo): nada');
}
{
  const m = monta(mundoProv(13, 50, { chat: [1, 2, 3].map((i) => ({ ts: agoraS() - 3600 * i, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'prov:' + i, de_jid: '', de_nome: 'Barbadinho', texto: 'x', acao: 'provocou', resposta: 'y', chamadas: 1 })) }));
  await tick(m);
  conf(m.fila.length === 0 && m.chamadas.length === 0, '3 provocacoes ja hoje: nada (teto do dia)');
}
{
  const m = monta(mundoProv(13, 50, { ia: [{ status: 429 }] }));
  await tick(m);
  conf(m.fila.length === 1 && m.fila[0].texto === 'Guilherme, faltam 2 pra bater 15. Vai dar mole agora?', 'IA fora (429): sai a frase reserva com o nome de verdade');
  conf(m.chat.length === 1 && /frase reserva/.test(m.chat[0].motivo) && Number(m.cfgdb.bot_ia_quota_ate) === agoraS() + 3600, 'a linha diz que foi a reserva, e a cota pausa 1 h');
}
{
  const m = monta(mundoProv(13, 50, { cfg: CFG_RAW }));
  await tick(m);
  conf(m.fila.length === 0 && m.chamadas.length === 0, 'provoca.ativo false: nada');
}

// ══ 13. AS ROTAS DA DASH ═══════════════════════════════════════════════════════════════
titulo('13. GET /api/bot/chat e POST /api/bot/ia/teste');
{
  const chat = [
    { ts: agoraS() - 100, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'c1', de_jid: '5515999990001@s.whatsapp.net', de_nome: 'Guilherme', quem_id: GUI, texto: 'oi', acao: 'visto', resposta: '' },
    { ts: agoraS() - 90, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'c2', de_jid: '5515999990001@s.whatsapp.net', de_nome: 'Guilherme', quem_id: GUI, texto: 'meu numero caiu', acao: 'respondeu', resposta: 'Relaxa.', chamadas: 1, alerta: 1 },
    { ts: agoraS() - 80, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'c3', de_jid: '5515900000000@s.whatsapp.net', de_nome: 'Fulano', quem_id: '', texto: 'oi bot', acao: 'calado', resposta: '', motivo: 'a IA preferiu não responder', chamadas: 1 },
    { ts: agoraS() - 70, dia: DIA, grupo: 'cob', jid: GC, msg_id: 'c4', de_jid: '111222333444@lid', de_nome: 'Bryan', quem_id: BRYAN, texto: 'pagou?', acao: 'respondeu', resposta: 'Pagou.', chamadas: 1 },
  ];
  const quem = [
    { grupo: 'vend', de_jid: '5515999990001@s.whatsapp.net', fone: '5515999990001', nome: 'Guilherme', ultimo_ts: agoraS() - 90, n: 2 },
    { grupo: 'vend', de_jid: '5515900000000@s.whatsapp.net', fone: '5515900000000', nome: 'Fulano', ultimo_ts: agoraS() - 80, n: 1 },
    { grupo: 'vend', de_jid: '777777777777@lid', fone: '5515999990009', nome: 'Bruno C', ultimo_ts: agoraS() - 50, n: 1 },
    { grupo: 'cob', de_jid: '111222333444@lid', fone: '', nome: 'Bryan', ultimo_ts: agoraS() - 70, n: 1 },
  ];
  const m = monta({ ...MUNDO, chat, quem, config: { bot_ia_quota_ate: String(agoraS() + 900) } });
  const get = (q) => m.api.handleBotChat({ method: 'GET', url: 'https://api.sellwave.com.br/api/bot/chat?' + q, headers: { get: () => null } }, m.env);
  const j = (await get('grupo=vend&limite=30'))._json;
  conf(j.ok === true && j.itens.length === 2 && j.itens.every((x) => x.acao !== 'visto'), 'itens do grupo: nunca traz `visto` (so o que o bot fez), e so do grupo pedido');
  conf(j.itens[0].acao === 'calado' && j.itens[1].quem_nome === 'Guilherme' && j.itens[1].alerta === 1, 'mais novo primeiro, com o nome de quem perguntou resolvido e o alerta');
  conf(j.pessoas.length === 3 && j.pessoas.find((p) => p.jid === '5515999990001@s.whatsapp.net').quem_id === GUI, 'pessoas: o remetente com jid em pessoas[] vem com quem_id');
  const bc = j.pessoas.find((p) => p.jid === '777777777777@lid');
  conf(bc.quem_id === 'socio_x4dy6d' && bc.quem_nome === 'Bruno Correa', 'remetente sem jid na lista mas com o fone do Bruno: resolve pelo fone, nome do users');
  conf(j.pessoas.find((p) => p.jid === '5515900000000@s.whatsapp.net').quem_id === '', 'remetente desconhecido vem sem dono (pra tela oferecer o Select)');
  conf(j.quota_ate === agoraS() + 900, 'quota_ate vem pra tela mostrar o selo');
  const c = (await get('grupo=cob'))._json;
  conf(c.itens.length === 1 && c.itens[0].quem_nome === 'Bryan Amorim' && c.pessoas.length === 1, 'grupo=cob: so o dos cobradores');
}
{
  // Pergunte ao bot: o mesmo caminho SEM freio, sem visto, sem mandar nada, sem avisar.
  const m = monta({ ...MUNDO, chat: Array.from({ length: 8 }, (_, i) => linhaChat({ msg_id: 't' + i })), ia: [{ json: { responder: true, texto: 'Tem 2 ligados.', avisar_direcao: 'numero caiu' } }] });
  const r = await m.api.handleBotIaTeste(req('/api/bot/ia/teste', { grupo: 'vend', texto: 'meu numero caiu', quem_id: GUI }), m.env);
  conf(r._json.ok === true && r._json.responder === true && r._json.resposta === 'Tem 2 ligados.' && m.chamadas.length === 1, 'com 8 chamadas na hora o teste ainda chama a IA (sem freio)');
  conf(r._json.viu.includes('placar de hoje') && r._json.viu.includes('números de Guilherme'), 'e devolve o que viu (placar, numeros)');
  conf(/Quem perguntou: Guilherme \(vendedor\)/.test(m.chamadas[0].user) && /aviso_entregue: false/.test(m.chamadas[0].user), 'o quem_id escolhido na tela vira a pessoa, e aviso_entregue e false no teste');
  conf(m.chat.length === 9 && m.chat[8].acao === 'teste' && m.chat[8].quem_id === GUI && m.chat[8].alerta === 1, 'grava acao "teste" (nenhuma linha visto)');
  conf(m.pushes.length === 0 && m.envios.length === 0 && m.fila.length === 0, 'nao avisa a direcao nem manda nada');
  const vazio = await m.api.handleBotIaTeste(req('/api/bot/ia/teste', { grupo: 'vend', texto: '   ', quem_id: GUI }), m.env);
  conf(vazio._status === 400, 'sem pergunta: 400');
}

// ══ 14. A FAXINA ═══════════════════════════════════════════════════════════════════════
titulo('14. A faxina diaria do bot_chat (visto dura 1 dia, o resto 60)');
{
  const l = (o) => ({ dia: DIA, grupo: 'vend', jid: GV, de_jid: '', de_nome: 'x', texto: 'x', resposta: '', ...o });
  const m = monta({ ...MUNDO, chat: [
    l({ msg_id: 'v2', acao: 'visto', ts: agoraS() - 2 * 86400 }),
    l({ msg_id: 'v0', acao: 'visto', ts: agoraS() - 3600 }),
    l({ msg_id: 'r2', acao: 'respondeu', ts: agoraS() - 2 * 86400 }),
    l({ msg_id: 'r61', acao: 'respondeu', ts: agoraS() - 61 * 86400 }),
    l({ msg_id: 'p10', acao: 'pendente', ts: agoraS() - 600, resposta: 'nao saiu' }),
    l({ msg_id: 'p1', acao: 'pendente', ts: agoraS() - 60 }),
  ], quem: [{ grupo: 'vend', de_jid: 'a@lid', fone: '', nome: 'velho', ultimo_ts: agoraS() - 31 * 86400, n: 1 }, { grupo: 'vend', de_jid: 'b@lid', fone: '', nome: 'novo', ultimo_ts: agoraS() - 86400, n: 1 }] });
  await m.api._botIaFaxina(m.env);
  const ids = m.chat.map((x) => x.msg_id);
  conf(!ids.includes('v2') && ids.includes('v0'), 'visto de 2 dias some; visto de 1 h fica (vida de 24 h)');
  conf(ids.includes('r2') && !ids.includes('r61'), 'respondeu de 2 dias fica; de 61 dias some (vida de 60 dias)');
  conf(m.chat.find((x) => x.msg_id === 'p10').acao === 'erro' && m.chat.find((x) => x.msg_id === 'p1').acao === 'pendente', 'pendente ha 10 min vira erro ("nao saiu"); pendente ha 1 min espera');
  conf(m.quem.length === 1 && m.quem[0].nome === 'novo', 'quem e quem com mais de 30 dias some');
}

// ══ 16. O GRUPO DE TESTE ═══════════════════════════════════════════════════════════════
titulo('16. O grupo de teste (o bot responde como um dos grupos, so la)');
const TG = '120363432063011744@g.us';   // o "Aa" do Bruno (ele e o bot)
const BRUNO_WA = { de_jid: '5515988889999@s.whatsapp.net', de_fone: '5515988889999', de_nome: 'Bruno' };
const CFG_TESTE = (t, extra) => ({ ...CFG_RAW, ia: { ...CFG_RAW.ia, responde: { vend: false, cob: false }, teste: { ativo: true, id: TG, nome: 'Aa', como: 'cob', quem_id: BRYAN, por: 'socio_x4dy6d', ...(t || {}) } }, ...(extra || {}) });
{
  const { api } = monta({});
  const p = api._botNormaliza({}, null).ia.teste;
  conf(p.ativo === false && p.id === '' && p.como === 'cob', 'padrao: grupo de teste desligado, sem grupo, como cobradores');
  const n = api._botNormaliza(CFG_TESTE({ como: 'vend', quem_id: GUI }), null).ia.teste;
  conf(n.ativo && n.id === TG && n.nome === 'Aa' && n.como === 'vend' && n.quem_id === GUI && n.por === 'socio_x4dy6d', 'liga com grupo, nome, jeito, pessoa e quem ligou');
  conf(api._botNormaliza(CFG_TESTE({ id: 'lixo' }), null).ia.teste.ativo === false, 'id que nao e de grupo: desliga');
  conf(api._botNormaliza(CFG_TESTE({ id: GV }), null).ia.teste.ativo === false, 'o grupo de teste nunca e o dos vendedores de verdade: desliga');
  conf(api._botNormaliza(CFG_TESTE({ id: GC }), null).ia.teste.ativo === false, 'nem o dos cobradores');
  const base = api._botNormaliza(CFG_TESTE(), null);
  const soTom = api._botNormaliza({ ia: { tom: { vend: 'outro' } } }, base).ia.teste;
  conf(soTom.ativo && soTom.id === TG && soTom.quem_id === BRYAN && soTom.por === 'socio_x4dy6d', 'salvar outra parte da conversa nao mexe no grupo de teste');
  const desl = api._botNormaliza({ ia: { teste: { ativo: false } } }, base).ia.teste;
  conf(desl.ativo === false && desl.id === TG && desl.quem_id === BRYAN, 'desligar o teste guarda o grupo e a pessoa escolhidos');
}
{
  const { api } = monta({});
  conf(JSON.stringify(api._botIaEscuta(api._botNormaliza(CFG_TESTE(), null))) === JSON.stringify([TG]), 'escuta: com os grupos de verdade desligados, so o de teste');
  conf(api._botIaEscuta(api._botNormaliza(CFG_TESTE({ ativo: false }), null)).length === 0, 'teste desligado: escuta vazia');
  const ambos = api._botIaEscuta(api._botNormaliza({ ...CFG_TESTE(), ia: { ...CFG_TESTE().ia, responde: { vend: true, cob: false } } }, null));
  conf(ambos.length === 2 && ambos[0] === GV && ambos[1] === TG, 'com o dos vendedores ligado: os dois');
  const cfg = api._botNormaliza(CFG_TESTE(), null);
  conf(api._botIaGrupoDe(cfg, TG) === 'cob' && api._botIaGrupoDe(api._botNormaliza(CFG_TESTE({ como: 'vend' }), null), TG) === 'vend', 'a mensagem do grupo de teste e tratada como o grupo escolhido');
  conf(api._botIaGrupoDe(cfg, GV) === 'vend' && api._botIaGrupoDe(cfg, GC) === 'cob' && api._botIaGrupoDe(cfg, '999@g.us') === '', 'os de verdade continuam os de verdade; outro grupo nao e nada');
}
{
  // O Bruno escreve no Aa marcando o bot: responde como o Bryan, no grupo dos cobradores, com os de verdade desligados.
  const m = monta({ ...MUNDO, cfg: CFG_TESTE(), ia: [{ json: { responder: true, texto: 'Pagou sim, no Pix em 04/11.' } }] });
  const cfg = m.api._botNormaliza(m.mundo.cfg, null);
  const r = await m.api._botIaMensagem(m.env, cfg, msg({ jid: TG, texto: 'a joselina pagou?', menciona: true, ...BRUNO_WA }));
  conf(r.ok && r.resposta === 'Pagou sim, no Pix em 04/11.', 'no grupo de teste o bot responde mesmo com os grupos de verdade desligados');
  conf(/Quem perguntou: Bryan Amorim \(cobrador\)/.test(m.chamadas[0].user) && /Grupo: Cobradores/.test(m.chamadas[0].user), 'quem escreveu conta como o Bryan, no grupo dos Cobradores');
  conf(/Joselina/.test(m.chamadas[0].user), 'com o pedido da fila do Bryan no contexto');
  conf(m.chat.length === 1 && m.chat[0].jid === TG && m.chat[0].grupo === 'cob' && m.chat[0].quem_id === BRYAN && m.chat[0].acao === 'pendente', 'a linha fica com o jid do grupo de teste, como cobradores, no nome do Bryan');
  conf(m.quem.length === 0, 'o quem e quem nao guarda quem escreve no grupo de teste');
  const fora = await m.api._botIaMensagem(m.env, cfg, msg({ jid: GC, texto: 'a joselina pagou?', menciona: true, de_jid: '111222333444@lid', de_fone: '', de_nome: 'Bryan' }));
  conf(fora.ignorar === true && m.chamadas.length === 1, 'no grupo de verdade (desligado) nada muda: ignorado, sem IA');
}
{
  // Sem pessoa escolhida: conta como quem ligou o teste (o Bruno, socio: ve a fila inteira).
  const m = monta({ ...MUNDO, cfg: CFG_TESTE({ quem_id: '' }), ia: [JSON_OK] });
  await m.api._botIaMensagem(m.env, m.api._botNormaliza(m.mundo.cfg, null), msg({ jid: TG, texto: 'o carlos pereira pagou?', menciona: true, ...BRUNO_WA }));
  conf(/Quem perguntou: Bruno Correa \(sócio, da direção\)/.test(m.chamadas[0].user) && /Carlos Pereira/.test(m.chamadas[0].user), 'sem pessoa escolhida: conta como quem ligou o teste, com a visao da direcao');
}
{
  // 8 chamadas na ultima hora no grupo de VERDADE dos cobradores nao seguram o de teste, e vice-versa.
  const cheio = Array.from({ length: 40 }, (_, i) => linhaChat({ msg_id: 'g' + i, grupo: 'cob', jid: GC, de_jid: '5515999990' + String(100 + i) + '@s.whatsapp.net' }));
  const m = monta({ ...MUNDO, cfg: CFG_TESTE(), chat: cheio, ia: [JSON_OK] });
  const cfg = m.api._botNormaliza(m.mundo.cfg, null);
  const r = await m.api._botIaMensagem(m.env, cfg, msg({ jid: TG, texto: 'quantos tenho pra cobrar hoje?', menciona: true, ...BRUNO_WA }));
  conf(r.resposta === 'Fechado, pode deixar.' && m.chamadas.length === 1, 'grupo de verdade com 8 chamadas na hora: o de teste responde (conta separada)');
  conf(await m.api._botIaFreio(m.env, 'cob', '', 'gemini', GC, false) === 'limite por hora do grupo' && await m.api._botIaFreio(m.env, 'cob', '', 'gemini', TG, true) === '', 'o freio conta por grupo (jid): o de verdade cheio, o de teste livre');
  const m2 = monta({ ...MUNDO, cfg: CFG_TESTE(), ia: [JSON_OK] });
  const cfg2 = m2.api._botNormaliza(m2.mundo.cfg, null);
  let respondeu = 0;
  for (let i = 0; i < 10; i++) { const x = await m2.api._botIaMensagem(m2.env, cfg2, msg({ jid: TG, texto: 'pergunta ' + i + ' sobre o pedido?', menciona: true, ...BRUNO_WA })); if (x.resposta) respondeu++; }
  conf(respondeu === 10, 'no teste a direcao pergunta 10 seguidas e todas respondem (sem o teto de 8 por pessoa)');
  conf(await m2.api._botIaFreio(m2.env, 'cob', BRUNO_WA.de_jid, 'gemini', GC, false) === '', 'as 10 perguntas do teste NAO gastam o teto por pessoa do grupo de verdade (revisao de 06/11)');
  const m3 = monta({ ...MUNDO, cfg: CFG_TESTE(), chat: Array.from({ length: 8 }, (_, i) => linhaChat({ msg_id: 'gc' + i, grupo: 'cob', jid: GC, de_jid: BRUNO_WA.de_jid })) });
  conf(await m3.api._botIaFreio(m3.env, 'cob', BRUNO_WA.de_jid, 'gemini', GC, false) === 'muitas perguntas da mesma pessoa', 'no grupo de verdade o teto de 8 por pessoa continua (com perguntas feitas la)');
}
{
  // Problema relatado no teste: o aviso vai so pra quem ligou o teste, marcado como teste.
  const m = monta({ ...MUNDO, cfg: CFG_TESTE({ como: 'vend', quem_id: GUI }), ia: [{ json: { responder: true, texto: 'Relaxa, vou avisar.', avisar_direcao: 'numero caiu' } }] });
  const cfg = m.api._botNormaliza(m.mundo.cfg, null);
  const r = await m.api._botIaMensagem(m.env, cfg, msg({ jid: TG, texto: 'meu numero caiu', ...BRUNO_WA }));
  conf(r.resposta === 'Relaxa, vou avisar.', 'como Vendedores, "meu numero caiu" sem marcar responde (igual ao grupo de verdade)');
  conf(/Quem perguntou: Guilherme \(vendedor\)/.test(m.chamadas[0].user) && /Grupo: Vendedores/.test(m.chamadas[0].user), 'e conta como o Guilherme, no grupo dos Vendedores');
  conf(m.pushes.length === 1 && m.pushes[0].userId === 'socio_x4dy6d' && /^\[teste\] Guilherme/.test(m.pushes[0].payload.body) && /teste/.test(m.pushes[0].payload.title), 'aviso a direcao: so pra quem ligou o teste, marcado [teste]');
  conf(!m.cfgdb['bot_iaav_' + GUI + ':numero'] && !!m.cfgdb['bot_iaav_teste_' + GUI + ':numero'], 'a repeticao do aviso de teste tem chave propria (nao segura o aviso de verdade do Guilherme)');
}
{
  // As ultimas mensagens que a IA ve sao so as do grupo de teste.
  const chat = [linhaChat({ msg_id: 'real1', grupo: 'cob', jid: GC, texto: 'conversa do grupo de verdade', resposta: 'resposta real', chamadas: 0 }), linhaChat({ msg_id: 'tst1', grupo: 'cob', jid: TG, texto: 'conversa do teste', resposta: 'resposta teste', chamadas: 0 })];
  const m = monta({ ...MUNDO, cfg: CFG_TESTE(), chat, ia: [JSON_OK] });
  await m.api._botIaMensagem(m.env, m.api._botNormaliza(m.mundo.cfg, null), msg({ jid: TG, texto: 'e a maria silva?', menciona: true, ...BRUNO_WA }));
  conf(/conversa do teste/.test(m.chamadas[0].user) && !/conversa do grupo de verdade/.test(m.chamadas[0].user), 'o contexto do grupo de teste nao mistura com o grupo de verdade');
}
{
  // Ultimas conversas na tela: marca o que veio do grupo de teste.
  const chat = [linhaChat({ msg_id: 'a1', grupo: 'cob', jid: GC }), linhaChat({ msg_id: 'a2', grupo: 'cob', jid: TG })];
  const m = monta({ ...MUNDO, cfg: CFG_TESTE(), chat });
  const j = (await m.api.handleBotChat({ method: 'GET', url: 'https://api.sellwave.com.br/api/bot/chat?grupo=cob', headers: { get: () => null } }, m.env))._json;
  conf(j.itens.length === 2 && j.itens.find((x) => x.jid === TG).no_teste === true && j.itens.find((x) => x.jid === GC).no_teste === false, 'GET /api/bot/chat: no_teste so nas linhas do grupo de teste');
}
{
  const { api } = monta({});
  const cfg = api._botNormaliza(CFG_TESTE(), null);
  const t = api._botIaTesteTexto(cfg, [{ id: BRYAN, nome: 'Bryan Amorim', role: 'cobrador' }]);
  conf(/grupo dos Cobradores/.test(t) && /conta como Bryan Amorim/.test(t) && /Me marca \(@Barbadinho\) e pergunta\.$/.test(t), 'a linha do teste diz o grupo, a pessoa e que precisa marcar (cobradores)');
  const tv = api._botIaTesteTexto(api._botNormaliza(CFG_TESTE({ como: 'vend', quem_id: GUI }), null), [{ id: GUI, nome: 'Guilherme', role: 'atendente' }]);
  conf(/grupo dos Vendedores/.test(tv) && /mesmo sem marcar/.test(tv), 'como vendedores: avisa que problema de numero responde sem marcar');
  const a = cfg.ia.teste;
  conf(api._botIaTesteMudou(null, a) && api._botIaTesteMudou({ ...a, ativo: false }, a) && api._botIaTesteMudou({ ...a, como: 'vend' }, a) && api._botIaTesteMudou({ ...a, quem_id: GUI }, a) && api._botIaTesteMudou({ ...a, id: '1@g.us' }, a), 'manda a linha: ligou, trocou o grupo, o jeito ou a pessoa');
  conf(!api._botIaTesteMudou(a, a) && !api._botIaTesteMudou(a, { ...a, ativo: false }) && !api._botIaTesteMudou(a, { ...a, nome: 'Outro nome' }), 'nao manda: igual, desligou ou so o nome mudou');
}
{
  // "Ver provocação": a provocacao do vendedor escolhido, agora, e no grupo de teste ligado como Vendedores.
  const m = monta({ ...mundoProv(3, 5), cfg: CFG_TESTE({ como: 'vend', quem_id: GUI }), ia: [{ json: { texto: 'Guilherme, faltam 2 pra 5, bora?' } }] });
  const r = await m.api.handleBotIaTeste(req('/api/bot/ia/teste', { provoca: true, quem_id: GUI }), m.env);
  conf(r._json.ok && r._json.resposta === 'Guilherme, faltam 2 pra 5, bora?' && r._json.no_grupo === 'Aa', 'devolve a provocacao e manda no grupo de teste');
  conf(m.fila.length === 1 && m.fila[0].jid === TG && m.fila[0].tipo === 'ia_provoca', 'na fila do bot do PC, pro grupo de teste (nunca pro grupo dos vendedores)');
  conf(/Pedidos hoje: 3\. Próximo marco: 5 \(faltam 2\)\./.test(m.chamadas[0].user) && !/Último pedido/.test(m.chamadas[0].user), 'sem as condicoes do tick: 3 pedidos, marco 5 (e sem tempo parado)');
  conf(m.chat.length === 1 && m.chat[0].acao === 'teste' && m.chat[0].jid === 'teste' && m.chat[0].quem_id === GUI, 'grava como teste (fora da conta do freio dos grupos)');
  const m2 = monta({ ...mundoProv(3, 5), cfg: CFG_TESTE({ como: 'cob' }), ia: [{ json: { texto: 'x' } }] });
  const r2 = await m2.api.handleBotIaTeste(req('/api/bot/ia/teste', { provoca: true, quem_id: GUI }), m2.env);
  conf(r2._json.ok && r2._json.no_grupo === '' && m2.fila.length === 0, 'grupo de teste como Cobradores: a provocacao so aparece na tela');
  const r3 = await m2.api.handleBotIaTeste(req('/api/bot/ia/teste', { provoca: true, quem_id: BRYAN }), m2.env);
  conf(r3._status === 400, 'cobrador nao tem provocacao: 400');
  const m3 = monta({ ...mundoProv(0, 5), cfg: CFG_TESTE({ como: 'vend' }), ia: [{ status: 429 }] });
  const r4 = await m3.api.handleBotIaTeste(req('/api/bot/ia/teste', { provoca: true, quem_id: GUI }), m3.env);
  conf(r4._json.ok && r4._json.resposta === 'Guilherme, faltam 5 pra bater 5. Vai dar mole agora?' && /Pedidos hoje: 0\./.test(m3.chamadas[0].user), 'sem pedido hoje e IA fora: a frase reserva, e a IA soube que ele ainda nao vendeu');
}

// ══ 17. A CASCATA DO GEMINI ════════════════════════════════════════════════════════════
titulo('17. A cascata do Gemini: teto curto no 1o modelo e modelo cheio fica de fora');
{
  const m = monta({ ...MUNDO, ia: (_ch, i) => (i === 0 ? { status: 503 } : JSON_OK) });
  const M = m.api.BOT_IA_MODELOS;
  const r1 = await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(!!r1.texto && m.chamadas.length === 2 && m.chamadas[0].modelo === M[0] && m.chamadas[1].modelo === M[1], '503 no 1o modelo: o 2o responde');
  conf(m.tetos[0] === 7000 && m.tetos[1] === 10000, 'o 1o modelo tem teto de 7 s (ainda tem outro na fila); o ultimo, 10 s');
  const r2 = await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(!!r2.texto && m.chamadas.length === 3 && m.chamadas[2].modelo === M[1], 'na chamada seguinte o modelo cheio fica de fora: vai direto no 2o');
  RELOGIO.agora += 6 * 60000;
  try { await m.api._botIaChamar(m.env, 'sys', 'user', {}); } finally { RELOGIO.agora -= 6 * 60000; }
  conf(m.chamadas[3].modelo === M[0], 'passados 5 min ele volta a ser o primeiro');
  const p = monta({ ...MUNDO, ia: [{ status: 503 }] });
  await p.api._botIaChamar(p.env, 'sys', 'user', { maxModelos: 1 });
  conf(p.tetos[0] === 10000 && p.chamadas.length === 1, 'com um modelo so (a provocacao) o teto e o cheio, 10 s');
}

// ══ 18. A MARCACAO NO TEXTO ════════════════════════════════════════════════════════════
titulo('18. A marcacao "@30662576877805" nao e pedido: vira nome antes da busca e da IA');
{
  const { api } = monta({});
  const cfg = api._botNormaliza(CFG_RAW, null);
  conf(api._botIaTextoSemMarca('@30662576877805 se prepara', cfg, NUMERO_BOT, true) === '@Barbadinho se prepara', 'marcacao desconhecida numa mensagem que marcou o bot: @Barbadinho');
  conf(api._botIaTextoSemMarca('@' + NUMERO_BOT + ' oi', cfg, NUMERO_BOT, false) === '@Barbadinho oi', 'o numero do bot: @Barbadinho');
  conf(api._botIaTextoSemMarca('fala com o @111222333444 e o @5515999990001', cfg, NUMERO_BOT, false) === 'fala com o @Bryan e o @Guilherme', 'quem esta no quem e quem: pelo LID ou pelo telefone, primeiro nome');
  conf(api._botIaTextoSemMarca('o @5599888877776 sumiu', cfg, NUMERO_BOT, false) === 'o @alguém sumiu', 'desconhecido sem marcar o bot: @alguém');
  conf(api._botIaTextoSemMarca('pedido 1793903844876 e tel 15 99999-0000', cfg, NUMERO_BOT, true) === 'pedido 1793903844876 e tel 15 99999-0000', 'numero sem @ (pedido, telefone) fica como esta');
}
{
  // Medido no Aa: "@30662576877805 se prepara que hoje vai ter festa" virava busca de pedido "prepara, festa".
  const m = monta({ ...MUNDO, cfg: CFG_TESTE(), ia: [JSON_OK] });
  await m.api._botIaMensagem(m.env, m.api._botNormaliza(m.mundo.cfg, null), msg({ jid: TG, texto: '@30662576877805 se prepara que hoje vai ter festa, manda a boa ai', menciona: true, ...BRUNO_WA }));
  const u = m.chamadas[0].user;
  conf(/Mensagem de Bryan Amorim: "@Barbadinho se prepara que hoje vai ter festa/.test(u), 'a IA recebe "@Barbadinho" no lugar do numero');
  conf(!/Nenhum pedido encontrado/.test(u) && !/PROVÁVEL|AMBÍGUO/.test(u), 'e nenhuma busca de pedido sai da marcacao');
  conf(/"@Barbadinho" é você/.test(u), 'e sabe que "@Barbadinho" e ele');
  conf(/^@Barbadinho se prepara/.test(m.chat[0].texto), 'a conversa guardada (e mostrada na tela) fica com @Barbadinho');
  conf(/Nunca abra com "Oi, Fulano!"/.test(m.chamadas[0].system), 'e o system pede pra nao abrir com "Oi, Fulano!"');
}
{
  // A direcao pergunta do numero de alguem marcando a pessoa: a marcacao vira o nome e o bot acha o vendedor.
  const m = monta({ ...MUNDO, cfg: CFG_TESTE({ como: 'vend', quem_id: '' }), ia: [JSON_OK] });
  await m.api._botIaMensagem(m.env, m.api._botNormaliza(m.mundo.cfg, null), msg({ jid: TG, texto: '@30662576877805 o numero do @5515999990001 caiu?', menciona: true, ...BRUNO_WA }));
  conf(/Números de Guilherme/.test(m.chamadas[0].user) && /Quem perguntou: Bruno Correa/.test(m.chamadas[0].user), 'a direcao marcando o Guilherme: o bot olha os numeros do Guilherme');
}
{
  // Pedido de verdade ao lado da marcacao continua achado.
  const m = monta({ ...MUNDO, cfg: CFG_TESTE(), ia: [JSON_OK] });
  await m.api._botIaMensagem(m.env, m.api._botNormaliza(m.mundo.cfg, null), msg({ jid: TG, texto: '@30662576877805 o pedido 1793903844876 foi pago?', menciona: true, ...BRUNO_WA }));
  conf(/Pedido encontrado:/.test(m.chamadas[0].user) && /Joselina/.test(m.chamadas[0].user), 'o id do pedido ao lado da marcacao continua achado');
}

// ══ 19. O QUE A REVISAO DE 06/11 ACHOU ═════════════════════════════════════════════════
titulo('19. Revisao de 06/11: marcar x falar o nome, ids do bot, pausa de cota, aviso por grupo, marca de teste');
{
  // Falar o nome sem marcar (o agente 1.6.1 manda marcado=false): a IA decide e o "nao" dela vale.
  const m = monta({ ...MUNDO, ia: [{ json: { responder: false, texto: '' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'kkkk o barbadinho zoou o Kevin', menciona: true, marcado: false }));
  conf(r.acao === 'calado' && !r.resposta, 'so falou o nome (sem marcar) e a IA calou: calado, sem a resposta padrao');
  conf(/Falaram seu nome nesta mensagem sem te marcar/.test(m.chamadas[0].user), 'e a IA soube que so falaram o nome');
  const m2 = monta({ ...MUNDO, ia: [{ json: { responder: false, texto: '' } }] });
  const r2 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho oi', menciona: true, marcado: true }));
  conf(r2.acao === 'respondeu' && /^tô aqui!/.test(r2.resposta), 'marcou de verdade e a IA calou: resposta padrao');
  const m3 = monta({ ...MUNDO, ia: [{ json: { responder: false, texto: '' } }] });
  const r3 = await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: 'oi', menciona: true, marcado: true, de_jid: '5599000000000@s.whatsapp.net', de_fone: '5599000000000', de_nome: 'Fulano' }));
  conf(r3.acao === 'respondeu' && /ainda não sei quem é vc/.test(r3.resposta), 'marcou, a IA calou e a pessoa nao e identificada: "ainda nao sei quem e voce", nao o convite pra perguntar de pedido');
}
{
  // Citou a resposta do bot sem marcar ("valeu"): a IA e avisada que so responde se for pergunta.
  const chat = [{ ts: agoraS() - 300, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'rv1', de_jid: '', de_nome: 'Kevin', texto: 'oi', acao: 'respondeu', resposta: 'Relaxa, Kevin: 2 numeros ligados ainda.', chamadas: 1 }];
  const m = monta({ ...MUNDO, chat, ia: [{ json: { responder: false, texto: '' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'valeu', responde: true, citado: 'Relaxa, Kevin: 2 numeros ligados ainda.' }));
  conf(r.acao === 'calado' && /Responderam uma mensagem sua sem te marcar/.test(m.chamadas[0].user), '"valeu" citando a resposta do bot: a IA sabe que pode calar, e calou (sem resposta padrao)');
}
{
  const { api } = monta({});
  const cfg = api._botNormaliza(CFG_RAW, null);
  const IDS = ['5515981316483', '30662576877805'];
  conf(api._botIaTextoSemMarca('@30662576877805 o numero do @99887766554433 caiu?', cfg, NUMERO_BOT, true, IDS) === '@Barbadinho o numero do @alguém caiu?', 'com os ids do bot (agente 1.6.1): so o LID do bot vira @Barbadinho; o desconhecido vira @alguém');
  conf(api._botIaTextoSemMarca('@30662576877805 o numero do @99887766554433 caiu?', cfg, NUMERO_BOT, true) === '@alguém o numero do @alguém caiu?', 'agente antigo com DUAS marcacoes desconhecidas: nenhum chute');
  conf(api._botIaTextoSemMarca('barbadinho, o @99887766554433 bateu a meta?', cfg, NUMERO_BOT, true) === 'barbadinho, o @alguém bateu a meta?', 'agente antigo, o texto fala o nome do bot: a marcacao e de outra pessoa');
}
{
  // A citada passa pela mesma troca (o numero cru na citada fazia a IA repetir e a mascara calar o bot).
  const m = monta({ ...MUNDO, cfg: CFG_TESTE({ como: 'vend', quem_id: GUI }), ia: [JSON_OK] });
  await m.api._botIaMensagem(m.env, m.api._botNormaliza(m.mundo.cfg, null), msg({ jid: TG, texto: '@30662576877805 olha isso', menciona: true, marcado: true, bot_ids: ['5515981316483', '30662576877805'], citado: '@99887766554433 teu numero caiu?', ...BRUNO_WA }));
  conf(/Mensagem citada: "@alguém teu numero caiu\?"/.test(m.chamadas[0].user) && !/99887766554433/.test(m.chamadas[0].user), 'a mensagem citada vai pra IA sem o numero cru da marcacao');
  conf(m.chat[0].teste === 1, 'a linha do grupo de teste fica marcada como teste (coluna teste)');
}
{
  // A marca "(teste)" nao some quando o grupo de teste muda.
  const chat = [linhaChat({ msg_id: 'v1', grupo: 'cob', jid: '120363000000000001@g.us', teste: 1 }), linhaChat({ msg_id: 'v2', grupo: 'cob', jid: GC, teste: 0 })];
  const m = monta({ ...MUNDO, cfg: CFG_TESTE(), chat });
  const j = (await m.api.handleBotChat({ method: 'GET', url: 'https://api.sellwave.com.br/api/bot/chat?grupo=cob', headers: { get: () => null } }, m.env))._json;
  conf(j.itens.find((x) => x.jid === '120363000000000001@g.us').no_teste === true && j.itens.find((x) => x.jid === GC).no_teste === false, 'linha de um grupo de teste antigo continua com (teste); a do grupo de verdade nao');
}
{
  // O "to sem cota" e por grupo de verdade: o teste nao gasta a vez do grupo real.
  const m = monta({ ...MUNDO, cfg: CFG_TESTE({ como: 'vend', quem_id: GUI, ativo: true }, { ia: { ...CFG_RAW.ia, responde: { vend: true, cob: false }, teste: { ativo: true, id: TG, nome: 'Aa', como: 'vend', quem_id: GUI, por: 'socio_x4dy6d' } } }), config: { bot_ia_quota_ate: String(agoraS() + 1800) } });
  const cfg = m.api._botNormaliza(m.mundo.cfg, null);
  const a = await m.api._botIaMensagem(m.env, cfg, msg({ jid: TG, texto: '@Barbadinho oi', menciona: true, marcado: true, ...BRUNO_WA }));
  const b = await m.api._botIaMensagem(m.env, cfg, msg({ jid: GV, texto: '@Barbadinho oi', menciona: true, marcado: true }));
  conf(/volto às/.test(a.resposta) && /volto às/.test(b.resposta), 'em pausa de cota: o grupo de teste e o de verdade recebem cada um o seu "to sem cota" na mesma hora');
}
{
  // A pausa de 1 hora: o botao de teste nunca grava; no tick so quando nao veio texto.
  const m = monta({ ...mundoProv(3, 5), cfg: CFG_TESTE({ como: 'vend' }), ia: [{ status: 429 }] });
  await m.api.handleBotIaTeste(req('/api/bot/ia/teste', { provoca: true, quem_id: GUI }), m.env);
  conf(!m.cfgdb.bot_ia_quota_ate && m.chamadas.length === 2, '"Ver provocação" com 429 nos dois modelos: frase reserva, e a pausa de cota NAO e gravada');
  const m2 = monta(mundoProv(13, 50, { ia: (_ch, i) => (i === 0 ? { status: 429 } : { json: { texto: 'Guilherme, faltam 2 pra 15!' } }) }));
  await m2.api._botIaProvocaTick(m2.env, m2.api._botNormaliza(m2.mundo.cfg, null), DIA);
  conf(m2.fila.length === 1 && m2.fila[0].texto === 'Guilherme, faltam 2 pra 15!' && !m2.cfgdb.bot_ia_quota_ate, 'tick: 429 no 1o modelo e o 2o escreveu: sai a provocacao da IA e nada de pausa');
  const m3 = monta(mundoProv(13, 50, { anthropic: 'sk-ant-teste', ia: (ch) => (ch.anthropic ? { status: 429 } : { json: { texto: 'Bora, Guilherme!' } }) }));
  await m3.api._botIaProvocaTick(m3.env, m3.api._botNormaliza(m3.mundo.cfg, null), DIA);
  conf(m3.fila.length === 1 && m3.fila[0].texto === 'Bora, Guilherme!' && !m3.cfgdb.bot_ia_quota_ate, 'tick: Claude 429 e o Gemini escreveu: sem pausa');
}
{
  // O melhor modelo estava cheio ha pouco (fora) e os outros deram 429: nao prova que a cota acabou.
  const m = monta({ ...MUNDO, ia: (_ch, i) => (i === 0 ? { status: 503 } : { status: 429 }) });
  const r1 = await m.api._botIaChamar(m.env, 'sys', 'user', {});
  const r2 = await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(!r1.quota && !r2.quota && m.chamadas[2].modelo !== m.api.BOT_IA_MODELOS[0], '1o modelo fora (503) e os outros 429: sem pausa de 1 hora');
}
{
  // Bot geral desligado: o grupo de teste nao existe (nada de linha "modo de teste" nem provocacao no Aa).
  const { api } = monta({});
  const desl = api._botNormaliza({ ...CFG_TESTE(), ativo: false }, null);
  conf(api._botIaEhTeste(desl, TG) === false && api._botIaEscuta(desl).length === 0 && api._botIaGrupoDe(desl, TG) === '', 'bot desligado: o grupo de teste nao vale (nem escuta, nem responde)');
  const m = monta({ ...mundoProv(3, 5), cfg: { ...CFG_TESTE({ como: 'vend' }), ativo: false }, ia: [{ json: { texto: 'x' } }] });
  const r = await m.api.handleBotIaTeste(req('/api/bot/ia/teste', { provoca: true, quem_id: GUI }), m.env);
  conf(r._json.ok && r._json.no_grupo === '' && m.fila.length === 0, 'bot desligado: o Ver provocacao so mostra na tela, nao manda no Aa');
}
{
  const fonte = src;
  conf(/tipo = 'ia_provoca' AND ts < \?/.test(fonte) && /A provocação ficou mais de 45 min esperando o bot do PC/.test(fonte), 'provocacao esperando o PC por mais de 45 min e descartada (como o incentivo)');
}

// ══ 20. SEGUNDA REVISAO (06/11) ════════════════════════════════════════════════════════
titulo('20. Segunda revisao: aviso de cota so pra quem marcou, pulouM, provocacao com o PC fechado, chute com o bot achado');
{
  // Em pausa de cota: nome solto (marcado=false) nao gasta o aviso; quem marca de verdade recebe.
  const m = monta({ ...MUNDO, config: { bot_ia_quota_ate: String(agoraS() + 1800) } });
  const cfg = cfgDe(m.api);
  const r1 = await m.api._botIaResponder(m.env, cfg, pacote({ texto: 'kkkk o barbadinho zoou o Kevin', menciona: true, marcado: false }));
  const r2 = await m.api._botIaResponder(m.env, cfg, pacote({ texto: '@Barbadinho o pedido da maria pagou?', menciona: true, marcado: true }));
  conf(!r1.resposta && /volto às/.test(r2.resposta), 'pausa de cota: nome solto fica calado; quem marca recebe o "to sem cota"');
}
{
  // So o 3o modelo (que nem seria tentado) estava fora: 429 nos dois primeiros prova cota acabada.
  const M = monta({}).api.BOT_IA_MODELOS;
  const m2 = monta({ ...MUNDO, ia: (ch) => (ch.modelo === M[2] ? { status: 503 } : { status: 429 }) });
  await m2.api._botIaChamar(m2.env, 'sys', 'user', { modelos: [M[2], M[0], M[1]], maxModelos: 2 });   // poe o latest de fora
  const r = await m2.api._botIaChamar(m2.env, 'sys', 'user', {});
  conf(r.quota === true, 'o modelo fora era o 3o (fora dos 2 tentados): 429 nos dois tentados pausa a cota como antes');
}
{
  // Provocacao do tick com o bot do PC fechado: nem IA, nem a vez do dia.
  const m = monta(mundoProv(13, 50, { config: { bot_agente: JSON.stringify({ ts: agoraS() - 3600, estado: 'open' }) } }));
  await m.api._botIaProvocaTick(m.env, m.api._botNormaliza(m.mundo.cfg, null), DIA);
  conf(m.chamadas.length === 0 && m.fila.length === 0 && !m.cfgdb['bot_iaprov_' + DIA + '_' + GUI], 'bot do PC fechado: a provocacao nem e montada (sem IA, sem reserva)');
  const m2 = monta(mundoProv(13, 50, { config: { bot_agente: JSON.stringify({ ts: agoraS() - 5, estado: 'open' }) } }));
  await m2.api._botIaProvocaTick(m2.env, m2.api._botNormaliza(m2.mundo.cfg, null), DIA);
  conf(m2.fila.length === 1, 'bot do PC aberto: a provocacao sai');
}
{
  // Agente 1.6.0 (sem bot_ids): o bot marcado pelo numero e achado, a outra marcacao desconhecida e de outra pessoa.
  const { api } = monta({});
  const cfg = api._botNormaliza(CFG_RAW, null);
  conf(api._botIaTextoSemMarca('@' + NUMERO_BOT + ' o numero do @5515977776666 caiu?', cfg, NUMERO_BOT, true) === '@Barbadinho o numero do @alguém caiu?', 'agente antigo: o bot achado pelo numero, a marcacao desconhecida vira @alguém');
}
{
  const fonte = src;
  conf(/UPDATE bot_chat SET resp_status='erro', motivo=\? WHERE acao='provocou'/.test(fonte), 'a faxina que descarta a provocacao marca a linha "provocou" como nao saiu');
}

// ══ 21. O JEITO NOVO, OS LIMITES E A CONVERSA (06/11) ══════════════════════════════════
titulo('21. Jeito do grupo, limites maiores e a conversa sem marcar');
{
  const { api } = monta({});
  conf(api.BOT_IA_HORA.gemini === 40 && api.BOT_IA_DIA.vend === 300 && api.BOT_IA_DIA.cob === 300 && api.BOT_IA_PESSOA_10MIN === 8, 'limites: 40 por hora por grupo, 300 por dia, 8 por pessoa em 10 min');
  const sys = api._botIaSistema(api._botNormaliza(CFG_RAW, null), 'vend');
  conf(/ANTES DE ESCREVER, ESCOLHA UM MODO/.test(sys) && /na dúvida, PROBLEMA/.test(sys) && /PROBLEMA: sério e prático/.test(sys), 'o modo por mensagem, com PROBLEMA na frente e serio');
  conf(/soltar a franga/.test(sys) && /Emoji nunca/.test(sys) && /só "krl"/.test(sys), 'proibe a giria de tiozao, emoji e palavrao alem de krl');
  const vend = api.BOT_IA_EXEMPLOS.vend.join('\n'), cob = api.BOT_IA_EXEMPLOS.cob.join('\n');
  conf(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(vend + cob) && !/[—–]/.test(vend + cob), 'nenhum exemplo tem emoji nem travessao');
  conf(!/\b(porra|caralho|fdp é|desgraçado|as bb|gin|revoada)\b/i.test(vend.replace(/fdp kkkk"/, '') + cob), 'nenhum exemplo tem palavrao pesado nem a piada das bb');
  conf(!/krl/.test(cob), 'nos exemplos da cobranca nao tem krl');
  conf(api.BOT_IA_EXEMPLOS.vend.some((e) => /^"Barbadinho tu é fera"/.test(e)) && api.BOT_IA_EXEMPLOS.cob.some((e) => /^"Barbadinho tu é fera"/.test(e)), 'o elogio pelo nome (sem marcar) tem resposta nos dois grupos');
}
{
  // A limpeza da saida tira emoji que escapar.
  const { api } = monta({});
  conf(api._botIaLimpa('BOOORA 🔥🔥 10 cravadas 🍾', []).texto === 'BOOORA 10 cravadas', 'emoji que escapar sai da resposta');
}
{
  // Conversa: o bot respondeu o Guilherme ha 1 min; ele escreve "ta on ai?" sem marcar: a IA decide.
  const chat = [{ ts: agoraS() - 60, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'cv1', de_jid: '5515999990001@s.whatsapp.net', de_nome: 'Guilherme', quem_id: GUI, texto: '@Barbadinho fala', acao: 'respondeu', resposta: 'fala, Gui!', chamadas: 1 }];
  const m = monta({ ...MUNDO, chat, ia: [{ json: { responder: true, texto: 'on e contando venda kkkkk' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'ta on ai?' }));
  conf(r.acao === 'respondeu' && m.chamadas.length === 1 && /Essa pessoa estava conversando com você agora há pouco/.test(m.chamadas[0].user), 'quem estava conversando com o bot e escreve sem marcar: a IA e chamada (modo conversa)');
  const r2 = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'ta on ai?', de_jid: '5515999990002@s.whatsapp.net', de_fone: '5515999990002', de_nome: 'Kevin' }));
  conf(r2.acao === 'visto' && m.chamadas.length === 1, 'outra pessoa escrevendo sem marcar: nao e conversa, nem chama a IA');
  const m2 = monta({ ...MUNDO, chat: [{ ...chat[0], ts: agoraS() - 600 }], ia: [JSON_OK] });
  const r3 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: 'ta on ai?' }));
  conf(r3.acao === 'visto' && m2.chamadas.length === 0, 'a conversa acaba em 3 min: depois disso, sem marcar, fica quieto');
  const m3 = monta({ ...MUNDO, chat, ia: [{ json: { responder: false, texto: '' } }] });
  const r4 = await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: 'kkkkk' }));
  conf(r4.acao === 'calado' && !r4.resposta, 'na conversa, risada e a IA calou: calado (sem resposta padrao, nao foi marcado)');
}
{
  // Falou o nome pra elogiar ("Barbadinho tu e fera"): a linha diz pra responder quando e COM o bot.
  const m = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'fera é vc com 2 hj kkkkk' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'Barbadinho tu é fera', menciona: true, marcado: false }));
  conf(r.acao === 'respondeu' && /se estão falando COM você/.test(m.chamadas[0].user), 'nome no elogio: a IA sabe que e com ela e responde');
}
{
  // Cascata: 429 tira o modelo da fila por 3 min (a cota gratis e por modelo).
  const M = monta({}).api.BOT_IA_MODELOS;
  const m = monta({ ...MUNDO, ia: (ch) => (ch.modelo === M[0] ? { status: 429 } : JSON_OK) });
  const a = await m.api._botIaChamar(m.env, 'sys', 'user', {});
  const b = await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(!!a.texto && !!b.texto && m.chamadas.length === 3 && m.chamadas[2].modelo === M[1], '429 no 1o modelo: a proxima chamada ja vai direto no 2o');
  const m2 = monta({ ...MUNDO, ia: [{ status: 429 }] });
  const c = await m2.api._botIaChamar(m2.env, 'sys', 'user', {});
  const d = await m2.api._botIaChamar(m2.env, 'sys', 'user', {});
  conf(c.quota === true && d.quota === true, '429 em todos: cota acabada (o modelo fora por 429 nao segura a pausa)');
  conf(M.includes('gemini-3.1-flash-lite'), 'o 3.1-flash-lite entrou na cascata (soma a cota gratis dele)');
}
{
  // Pedido que nao subiu: "subiu" faz buscar o pedido do vendedor.
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho o pedido do pedro manual nao subiu', menciona: true, marcado: true }));
  conf(/Pedro Manual/.test(m.chamadas[0].user) && /aguardando aprovação da direção/.test(m.chamadas[0].user), '"o pedido do pedro manual nao subiu": acha o pedido e diz que espera a aprovacao da direcao');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho bati 5 hoje, solta um audio comemorando', menciona: true, marcado: true }));
  conf(!/Nenhum pedido encontrado/.test(m2.chamadas[0].user), 'comemoracao com "bati", "audio", "comemorando": nao vira busca de pedido');
}

// ══ 15. TEXTO ══════════════════════════════════════════════════════════════════════════
titulo('15. As funcoes de texto');
{
  const { api } = monta({});
  conf(api._botIaNorm('Joselína DA Silva!') === 'joselina da silva' && api._botIaNorm('  São   Paulo ') === 'sao paulo', '_botIaNorm: sem acento, minusculo, um espaco so');
  const l = api._botIaLimpa('```\nOlá **João** \u2014 tudo bem?  \nSegue.\n```', []);
  conf(l.texto === 'Olá *João*, tudo bem?\nSegue.' && l.barrou === '', '_botIaLimpa: tira a cerca, ** vira *, travessao vira virgula, espaco antes da quebra some');
  conf(api._botIaLimpa('Pedido 1793903844876 pago', ['1793903844876']).barrou === '' && api._botIaLimpa('Pedido 1793903844876 pago', []).barrou === 'telefone', 'sequencia longa de digitos so passa se for id que veio nos dados');
  conf(api._botIaLimpa('veja em sellwave.com.br', []).barrou === 'link' && api._botIaLimpa('(15) ...-0001 caiu', []).barrou === '', 'dominio e link; o "(DD) ...-NNNN" dos numeros passa');
}

console.log('\n' + (falhas.length ? 'FALHOU' : 'OK') + ': ' + ok + ' de ' + (ok + falhas.length) + ' conferencias');
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
