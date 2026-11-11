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
  src.match(/^const META_MENSAL = .*$/m)[0], recortaFuncao('_metaMesIni'), recortaFuncao('_metaMesPorVendedor'),
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
  const estado = { leads: mundo.leads || [], chips: mundo.chips || [], pressels: mundo.pressels || [], wa_statuses: mundo.wa_statuses || [], tags: mundo.tags || [], ...(mundo.estadoExtra || {}) };
  // O que o bot gravou no pedido pelo handleUpdateLead (10/11/2026) e os links curtos que ele fez.
  const gravacoes = [];
  const curtos = [];
  const authPorReq = new WeakMap();
  const chat = (mundo.chat || []).map((x, i) => ({ id: i + 1, chamadas: 0, alerta: 0, resp_status: '', resp_msg_id: '', ...x }));
  let seq = chat.length;
  const quem = (mundo.quem || []).slice();   // bot_quem
  const fila = (mundo.outbox || []).map((x, i) => ({ id: i + 1, status: 'enviado', dia: DIA, ...x }));   // bot_outbox: o que foi pro WhatsApp Web
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
    // 10/11/2026: a oferta do "sim" vale so a primeira mensagem da pessoa depois dela; o link curto do pedido; o usuario
    // de quem pediu a acao (pro handleUpdateLead).
    if (/FROM bot_chat WHERE jid=\? AND de_jid=\? AND ts>\? AND msg_id<>\?/.test(sql)) return { results: [{ n: chat.filter((x) => x.jid === a[0] && x.de_jid === a[1] && Number(x.ts) > Number(a[2]) && x.msg_id !== a[3]).length }], meta: {} };
    if (/SELECT code FROM short_links WHERE lead_id = \? AND url = \?/.test(sql)) { const x = curtos.find((c) => c.lead_id === String(a[0]) && c.url === String(a[1])); return { results: x ? [{ code: x.code }] : [], meta: {} }; }
    if (/INSERT INTO short_links/.test(sql)) { curtos.push({ code: a[0], url: a[1], created_at: a[2], lead_id: a[3], created_by: a[4] }); return um; }
    if (/SELECT id, login, name, abbr, role/.test(sql)) { const u = USERS.find((x) => x.id === String(a[0])); return { results: u ? [{ id: u.id, login: u.id, name: u.name, role: u.role, afiliado_id: u.afiliado_id || null }] : [], meta: {} }; }
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
    // as ultimas mensagens do grupo (_botIaLinhaDoTempo): bot_chat sem a provocacao + o que o bot postou (bot_outbox)
    if (/SELECT ts, msg_id, de_nome, texto, acao, resposta FROM bot_chat WHERE jid=\?/.test(sql)) return { results: chat.filter((x) => x.jid === a[0] && Number(x.ts) > Number(a[1]) && x.acao !== 'provocou').sort(desc).slice(0, 16), meta: {} };
    if (/SELECT ts, feito_ts, tipo, texto, midia FROM bot_outbox WHERE jid=\?/.test(sql)) return { results: fila.filter((x) => x.jid === a[0] && Number(x.ts) > Number(a[1]) && x.status === 'enviado').sort(desc).slice(0, 6), meta: {} };
    // a cadencia: respostas de texto do bot pra mesma pessoa (reacao nao conta) e as ultimas respostas dele no grupo
    if (/SELECT COUNT\(\*\) AS n FROM bot_chat WHERE jid=\? AND de_jid=\?/.test(sql)) return { results: [{ n: chat.filter((x) => x.jid === a[0] && x.de_jid === a[1] && ['respondeu', 'pendente'].includes(x.acao) && !/^\(reagiu com /.test(String(x.resposta || '')) && Number(x.ts) > Number(a[2])).length }], meta: {} };
    if (/SELECT resposta, ts FROM bot_chat WHERE jid=\? AND acao IN/.test(sql)) return { results: chat.filter((x) => x.jid === a[0] && ['respondeu', 'pendente'].includes(x.acao) && Number(x.ts) > Number(a[1])).sort(desc).slice(0, 4).map((x) => ({ resposta: x.resposta, ts: x.ts })), meta: {} };
    // bot_outbox lido pelo bot vivo: provocacao ja dita, post citado, comemoracao do marco, provocacoes do dia, ultimo post
    if (/SELECT texto FROM bot_outbox WHERE jid=\? AND tipo='ia_provoca'/.test(sql)) return { results: fila.filter((x) => x.jid === a[0] && x.tipo === 'ia_provoca' && Number(x.ts) > Number(a[1])).sort(desc).slice(0, 3).map((x) => ({ texto: x.texto })), meta: {} };
    if (/SELECT texto FROM bot_outbox WHERE jid=\? AND ts>\? AND tipo IN/.test(sql)) return { results: fila.filter((x) => x.jid === a[0] && Number(x.ts) > Number(a[1]) && ['marco', 'meta', 'cob_marco', 'cob_meta', 'ia_provoca', 'livre', 'cob_livre', 'incentivo', 'cob_incentivo'].includes(x.tipo)).sort(desc).slice(0, 20).map((x) => ({ texto: x.texto })), meta: {} };
    if (/SELECT texto FROM bot_outbox WHERE jid=\? AND tipo IN \('marco'/.test(sql)) return { results: fila.filter((x) => x.jid === a[0] && ['marco', 'meta', 'cob_marco', 'cob_meta'].includes(x.tipo) && Number(x.ts) > Number(a[1])).sort(desc).slice(0, 4).map((x) => ({ texto: x.texto })), meta: {} };
    if (/SELECT texto FROM bot_outbox WHERE tipo='ia_provoca' AND dia=\?/.test(sql)) return { results: fila.filter((x) => x.tipo === 'ia_provoca' && x.dia === a[0]).sort(desc).slice(0, 6).map((x) => ({ texto: x.texto })), meta: {} };
    if (/SELECT MAX\(ts\) AS t FROM bot_outbox WHERE jid=\?/.test(sql)) { const tss = fila.filter((x) => x.jid === a[0]).map((x) => Number(x.ts) || 0); return { results: [{ t: tss.length ? Math.max(...tss) : null }], meta: {} }; }
    if (/SELECT resposta, ts, motivo FROM bot_chat WHERE de_jid=\? AND jid=\?/.test(sql)) return { results: chat.filter((x) => x.de_jid === a[0] && x.jid === a[1] && ['respondeu', 'pendente'].includes(x.acao) && Number(x.ts) > Number(a[2])).sort(desc).slice(0, 1), meta: {} };
    if (/SELECT texto, msg_id FROM bot_chat WHERE jid=\? AND de_jid=\?/.test(sql)) return { results: chat.filter((x) => x.jid === a[0] && x.de_jid === a[1] && Number(x.ts) > Number(a[2])).sort(desc).slice(0, 6).map((x) => ({ texto: x.texto, msg_id: x.msg_id })), meta: {} };
    if (/UPDATE bot_chat SET motivo=\? WHERE id=\?/.test(sql)) { const x = chat.find((r) => r.id === Number(a[1])); if (!x) return vazio; x.motivo = a[0]; return um; }
    if (/SELECT resposta FROM bot_chat WHERE jid=\?/.test(sql)) return { results: chat.filter((x) => x.jid === a[0] && Number(x.ts) > Number(a[1]) && (x.acao === a[2] || x.acao === a[3])).sort(desc).slice(0, 30).map((x) => ({ resposta: x.resposta })), meta: {} };
    if (/SELECT 1 AS ok FROM bot_chat WHERE jid=\? AND de_jid=\? AND motivo LIKE 'festa: rea%'/.test(sql)) return { results: chat.some((x) => x.jid === a[0] && x.de_jid === a[1] && /^festa: rea/.test(String(x.motivo || '')) && Number(x.ts) > Number(a[2])) ? [{ ok: 1 }] : [], meta: {} };
    if (/SELECT 1 AS ok FROM bot_chat WHERE jid=\? AND de_jid=\? AND acao IN/.test(sql)) {
      const semReacao = /NOT LIKE '\(reagiu com %'/.test(sql), semFesta = /NOT LIKE 'festa%'/.test(sql), semCaiu = /NOT LIKE 'n_mero caiu%'/.test(sql);
      return { results: chat.some((x) => x.jid === a[0] && x.de_jid === a[1] && ['respondeu', 'pendente'].includes(x.acao) && Number(x.ts) > Number(a[2]) && !(semReacao && /^\(reagiu com /.test(String(x.resposta || ''))) && !(semFesta && /^festa/.test(String(x.motivo || ''))) && !(semCaiu && /^n.mero caiu/.test(String(x.motivo || '')))) ? [{ ok: 1 }] : [], meta: {} };
    }
    if (/COUNT\(\*\) AS n FROM bot_chat WHERE acao='provocou'/.test(sql)) return { results: [{ n: chat.filter((x) => x.acao === 'provocou' && x.dia === a[0]).length }], meta: {} };
    if (/SELECT acao, COUNT\(\*\) AS n FROM bot_chat WHERE grupo=\? AND dia=\?/.test(sql)) {
      const conta = {};
      for (const x of chat) if (x.grupo === a[0] && x.dia === a[1] && !Number(x.teste) && ['respondeu', 'pendente', 'calado', 'erro'].includes(x.acao)) conta[x.acao] = (conta[x.acao] || 0) + 1;
      return { results: Object.keys(conta).map((k) => ({ acao: k, n: conta[k] })), meta: {} };
    }
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
    if (spec.status && spec.status !== 200) return { ok: false, status: spec.status, json: async () => ({ error: { message: 'erro ' + spec.status } }), text: async () => String(spec.body || '') };
    const texto = spec.texto != null ? String(spec.texto) : JSON.stringify(spec.json || {});
    // A Claude devolve o pensamento num bloco antes do texto (vazio por padrao) e o stop_reason.
    if (anthropic) return { ok: true, status: 200, json: async () => ({ model: modelo, stop_reason: spec.stop || 'end_turn', stop_details: spec.stop_details || null, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: texto }], usage: { input_tokens: 3000, output_tokens: 400 } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: texto }] }, finishReason: spec.finish || 'STOP' }] }) };
  };

  const deps = {
    Date: DataFalsa,
    // `mundo.sorte` fixa o sorteio da forma e do tempero da resposta (Math.random); sem ele, o Math de verdade.
    Math: (typeof mundo.sorte === 'number') ? Object.assign(Object.create(Math), { random: () => mundo.sorte }) : Math,
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
    getAIKey: async (_e, p) => (p === 'gemini' ? 'AIza-teste' : (p === 'gemini_bot' ? (mundo.chaveBot || null) : (p === 'anthropic' ? (mundo.anthropic || null) : null))),
    _wpParaPessoa: async (_e, userId, payload) => { pushes.push({ userId, payload }); return mundo.push ? 1 : 0; },
    authUser: async () => ({ id: 'dir', name: 'Heynan Dantas', role: 'diretor' }),
    isDirector: () => true,
    isAfiliado: () => false,
    json: (o, s) => ({ _json: o, _status: s || 200 }),
    err: (m, s) => ({ _json: { error: m }, _status: s || 400 }),
    // 10/11/2026: o que o bot da cobranca usa de fora do modulo. A gravacao no pedido e a rota da dash de verdade em
    // producao; aqui ela registra o patch, confere quem pediu e aplica o que a dash deixaria (cobrador nao troca `cob`).
    _cobConversas: async () => (mundo.conversas instanceof Map ? mundo.conversas : new Map(Object.entries(mundo.conversas || {}))),
    _n8sDoDono: () => [],
    _shortEnsure: async () => {},
    _shortCode: () => 'cod' + (curtos.length + 1),
    _authPorReq: authPorReq,
    Request,
    _cobAceitos: async () => USERS.filter((u) => !u.afiliado_id && ['cobrador', 'diretor', 'socio'].includes(u.role)).map((u) => ({ id: u.id, com_pct: u.role === 'cobrador' ? 3 : 0, direcao: u.role !== 'cobrador' })),
    handleUpdateLead: async (req, _env, id) => {
      const u = authPorReq.get(req);
      const body = JSON.parse(await req.text());
      const patch = body.patch || {};
      gravacoes.push({ id: String(id), patch, quem: u ? u.id : '' });
      if (mundo.gravaFalha) return { _json: { ok: false, error: mundo.gravaFalha }, _status: 409 };
      const lead = estado.leads.find((l) => String(l.id) === String(id));
      if (!lead) return { _json: { error: 'Lead não encontrado' }, _status: 404 };
      const dir = u && ['diretor', 'socio'].includes(u.role);
      const negados = ('cob' in patch && !dir) ? ['cob'] : [];
      if ('wa' in patch) lead.wa = patch.wa;
      if ('cob' in patch && dir) lead.cob = patch.cob;
      if (patch.comment_add) (lead.comments = lead.comments || []).unshift({ who: u.id, tx: patch.comment_add.tx, time: '05/11 11:00' });
      return { _json: { ok: true, version: 2, ...(negados.length ? { negados } : {}) }, _status: 200 };
    },
  };
  const nomes = Object.keys(deps);
  const f = new Function(...nomes, CODIGO + '\n;return { _botCfgPadrao, _botNormaliza, _botIaPadrao, _botIaNormaliza, _botIaEscuta, _botIaQuem, _botIaFreio, _botIaChamar, _botIaLimpa, _botIaNorm, _botIaNumerosDe, _botIaAcharPedidos, _botIaPedidoTexto, _botIaResponder, _botIaMensagem, _botIaAck, _botIaFaxina, _botIaProvocaTick, _botIaSistema, _botCfgLer, _cobNomes, _cobTagMap, handleBotAgente, handleBotChat, handleBotIaTeste, BOT_IA_SEM_TEXTO, BOT_IA_MODELOS, _botIaGrupoDe, _botIaEhTeste, _botIaTesteTexto, _botIaTesteMudou, _botIaProvocaTeste, _botIaTextoSemMarca, BOT_IA_HORA, BOT_IA_DIA, BOT_IA_PESSOA_10MIN, BOT_IA_EXEMPLOS, BOT_IA_MARCADO, BOT_IA_NAO_SEI_QUEM, BOT_IA_MANUAL, _botIaManualPara, _botIaPseudo, _botIaNomeBonito, _botIaGemFora, _botMetaMes, _botMetaTxt, _botDados, _botIaPlacarTexto, META_MENSAL, BOT_IA_TOM_VELHOS, _botIaIntensidade, _botIaSemVocativo, BOT_IA_ASSUNTO_VENDA_RE, BOT_IA_GRITO_RE, _botIaTextoProblema, _botIaFichaCurta, _botIaChamouOutroPeloNome, BOT_IA_MARCA_OUTRO_RE, _botIaLinhaDoTempo, _botIaSoRiso, _botIaEscolheForma, _botIaTempero, _botIaRepete, _botIaFormaDe, _botIaMarcoAgora, BOT_IA_QUEM_MANDA_RE, _botIaVersaoOk, _botIaComMidia, _botIaCitouResposta, _botIaReacaoOk, BOT_IA_TOM_VEND, BOT_IA_TOM_COB, BOT_IA_CAIU, BOT_IA_CAIU_SEM_AVISO, BOT_IA_FESTA_REACOES, _botIaNumeroCaiu, _botIaFoneParecido, _botIaFoneFora, _botIaListaTipo, _botIaConfirma, _botIaFilaDe, _botIaListaTexto, _botIaOndeAparece, _botCobSituacao, _botDadosCob, _botTextoCobranca, _botIaMascaraNum, _botIaPendChave };');
  return { api: f(...nomes.map((n) => deps[n])), env, cfgdb, chat, quem, fila, envios, chamadas, pushes, tetos, estado, mundo, gravacoes, curtos };
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
  conf(/^Animado, ousado e zoeiro/.test(p.tom.vend) && /^Mesma energia do grupo dos vendedores/.test(p.tom.cob) && p.instrucoes === '', 'tons padrao por grupo (06/11 tarde: mais ousado, a cobranca com a mesma energia) e instrucoes vazias');
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
  conf(r.acao === 'respondeu' && api.BOT_IA_CAIU.includes(r.resposta) && chamadas.length === 0, '"meu numero caiu" sem marcar: a frase curta do numero caido, sem IA (09/11)');
  r = await api._botIaResponder(env, cfg, pacote({ texto: 'esse cliente ja pagou o pedido?' }));
  conf(r.acao === 'visto' && chamadas.length === 0, '"?", cliente e pedido NAO acendem sozinhos no grupo dos vendedores');
  const soMarcado = cfgDe(api, { ia: { ...CFG_RAW.ia, so_marcado: { vend: true, cob: true } } });
  r = await api._botIaResponder(env, soMarcado, pacote({ texto: 'meu numero caiu' }));
  conf(r.acao === 'visto' && chamadas.length === 0, 'com "so quando marcarem" ligado, nem o numero caido acende sem mencao');
  r = await api._botIaResponder(env, soMarcado, pacote({ texto: 'meu numero caiu?', menciona: true, marcado: true }));
  conf(r.acao === 'respondeu' && chamadas.length === 1, 'mencao ao bot com pergunta chama a IA');
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
  conf(r.acao === 'respondeu' && api.BOT_IA_CAIU.includes(r.resposta) && chamadas.length === 0, 'numero caido em pausa de cota: a frase curta sai igual (nao precisa da IA)');
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
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: '@Barbadinho meu numero caiu?', menciona: true, marcado: true }));
  const user = chamadas[0].user;
  conf(/Números de Guilherme \(3 cadastrados, 1 em uso ou aquecimento, 1 recebendo lead agora, 1 com queda registrada\):/.test(user), '"meu numero caiu": o cabecalho dos numeros do vendedor, com prova');
  conf(/\(15\) \.\.\.-0001: em uso · RECEBENDO lead agora · interruptor: ligado em 2 de 2 pressels/.test(user), 'o numero em uso: recebe lead, interruptor ligado em 2 de 2 (a pressel pausada nao conta)');
  conf(/\.\.\.-0002: parado · NÃO recebe lead agora \(não está Em uso\) · app aberto/.test(user), 'o numero parado: nao recebe porque nao esta Em uso, e o interruptor dele nem aparece');
  conf(/\.\.\.-0003: banido/.test(user), 'o banido aparece como banido');
  conf(/QUEDA REGISTRADA às 10:55 \(caiu\), já desligado da roleta pelo sistema/.test(user), 'queda registrada em swweb_queda, com hora e o que o sistema fez');
  conf(/\.\.\.-0002: [^\n]*queda ainda não registrada pelo app/.test(user), 'numero sem linha em swweb_queda: "queda ainda nao registrada pelo app" (o registro atrasa)');
  conf(/app aberto por Guilherme desde 10:00/.test(user), 'swweb_uso com `ate` no futuro: app aberto por ele');
  conf(/último estado reportado pelo app: caiu \(pediu QR\) às 10:55/.test(user) && /o app nunca reportou estado desse número/.test(user), 'swweb_conn: o estado que o app reportou, ou "nunca reportou"');
  conf(!/conectado/i.test(user), 'NUNCA a palavra "conectado" sem o app ter reportado pronto');
  conf(!/55159888/.test(user), 'o numero inteiro nao vai (so DDD e 4 ultimos)');
}
{
  const { api, env, chamadas } = monta({ ...MUNDO, conn: [{ nk: '5515988880001', st: 'pronto', ts: agoraS() - 60 }] });
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: '@Barbadinho meu numero caiu?', menciona: true, marcado: true }));
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
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: '@Barbadinho meu numero caiu?', menciona: true, marcado: true }));
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
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: '@Barbadinho meu numero caiu?', menciona: true, marcado: true }));
  const user = chamadas[0].user;
  conf(/\.\.\.-0001: em uso · NÃO recebe lead agora \(o SellWave Web dele fechou; fica de plantão \(recebe quando nenhum número está ligado\) até ele voltar e ligar\) · interruptor: desligado em todas as pressels \(1 desligadas porque o SellWave Web fechou\)/.test(user), 'app fechado: nao recebe, o motivo e o app (de plantao), nao queda');
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
  await api._botIaResponder(env, cfgDe(api), pacote({ texto: '@Barbadinho meu numero caiu?', menciona: true, marcado: true }));
  const user = chamadas[0].user;
  conf(/\.\.\.-0001: em uso · NÃO recebe lead agora \(o SellWave Web dele fechou; fica de plantão \([^)]*\) até ele voltar e ligar\) · interruptor: desligado em todas as pressels/.test(user), 'pressel de afiliado nao liga o numero da casa');
}
{
  const { api, env, chamadas } = monta(MUNDO);
  const cfg = cfgDe(api);
  await api._botIaResponder(env, cfg, { ...pacote({ texto: 'como ta minha mesa hoje?', menciona: true, jid: GC, de_jid: '111222333444@lid', de_fone: '', de_nome: 'Bryan' }), grupo: 'cob' });
  const user = chamadas[0].user, system = chamadas[0].system;
  conf(/Mesa de Bryan Amorim agora: convertidos hoje 0, faltam cobrar 1 \(desses, 1 em cobrança, com combinado andando: [^)]*\), atrasados 0 \(retorno vencido num dia anterior, sem combinado\), a receber 1 pedido\./.test(user), 'grupo dos cobradores: a mesa de quem perguntou, em PEDIDOS (o combinado separado do atrasado, 10/11)');
  conf(/Agenda de Bryan agora: 1 pedido na fila de cobrança, 0 com retorno vencido, 0 com retorno pra hoje, 0 sem retorno marcado/.test(user), 'e a agenda dele (retorno vencido, hoje, sem retorno, a caminho) pra pergunta de numero');
  conf(!/R\$/.test(user), 'e nenhum R$ (o valor total nao vai pros cobradores)');
  conf(/Jeito de falar neste grupo: Tom da cobranca X/.test(system), 'o system leva o tom DO GRUPO');
  conf(/Instruções da direção[^\n]*\nNunca prometa prazo de entrega\./.test(system), 'e as instrucoes da direcao');
  conf(/EXEMPLOS DO JEITO CERTO neste grupo/.test(system) && /"@Barbadinho a C1 pagou\?" \(pedido encontrado: C1, Londrina\/PR/.test(system) && !/Boa, Fulano, 5 vendas/.test(system), 'no grupo dos cobradores vao os exemplos da cobranca, nunca as frases cruas do marco');
  await api._botIaResponder(env, cfg, pacote({ texto: 'e ai barbadinho', menciona: true }));
  const sys2 = chamadas[1].system;
  conf(/EXEMPLOS DO JEITO CERTO neste grupo/.test(sys2) && /ISSO AÍ PORRAAAA 🔥🔥 10 cravadas/.test(sys2) && !/Especial Fulano/.test(sys2) && !/a Ivone Cardoso pagou/.test(sys2), 'no vend vao os exemplos dos vendedores (as frases cruas do marco nao entram mais)');
  conf(/Jeito de falar neste grupo: Animado, ousado e zoeiro/.test(sys2), 'tom padrao dos vendedores quando nao foi escrito');
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
  b = busca('o cliente pagou metade, como marco?', quemG);
  conf(!b.termos.length && !b.ids.length, '"pagou metade, como marco?": nenhuma palavra vira nome (verbo depois de "como", metade)');
  b = busca('pagou metade, como joselina?', quemG);
  conf(!b.ids.length, 'a palavra logo depois de "como" nao e procurada como nome');
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
  conf(/são de outra pessoa: C1 \(fila de Haynan\)/.test(m.chamadas[0].user) && !/Carlos Pereira/.test(m.chamadas[0].user), 'e o contexto que vai pra IA diz "fila de Haynan" (o cliente pelo codigo)');
}

// ══ 9. O BLOCO DO PEDIDO ═══════════════════════════════════════════════════════════════
titulo('9. O bloco do pedido (nasce de _cobDetalhe, sem CPF, endereco nem comentario)');
{
  const { api, env, estado } = monta(MUNDO);
  const nomes = await api._cobNomes(env);
  const bloco = (id, completo) => api._botIaPedidoTexto(LEADS.find((l) => l.id === id), estado, nomes, {}, completo !== false);
  const t1 = bloco(1793903844876);
  conf(/^#1793903844876 Joselina Da Silva \(Sorocaba\/SP\) · GlicoSix 3 un · R\$ 297,00 · cadastrado em 01\/11\nVendedor \(quem vendeu e cadastrou\): Guilherme\. Cobrador \(dono da cobrança\): Bryan Amorim\./.test(t1), 'cabecalho: id, nome, cidade, produto, valor e quando; vendedor e cobrador numa linha propria, cada um com o seu papel (10/11)');
  conf(/Situação: pago em 04\/11 \(Pix\)\./.test(t1), 'pago: "pago em DD/MM" com a forma');
  conf(/Pagamento: quitado\./.test(t1), 'pagamento quitado');
  conf(/Último movimento: Entregues -> Pagos em 04\/11 15:20 \(Bryan Amorim\)\./.test(t1), 'so o ULTIMO movimento do historico, com quem fez');
  conf(/Anotações no pedido: 1, a última em 04\/11 15:21 \(o texto não vem pra você\)\./.test(t1), 'comentarios: so a contagem e a data');
  conf(!/99999-0000/.test(t1) && !/cliente pagou/.test(t1), 'o TEXTO do comentario nunca vai (tem telefone dentro dele)');
  conf(!/12345678901/.test(t1) && !/123\.456/.test(t1) && !/Rua das Flores/.test(t1) && !/18000/.test(t1), 'nem CPF, nem endereco, nem CEP');
  conf(!/https?:/.test(t1) && !/fivedelivery/.test(t1), 'nem link');
  const t2 = bloco(2);
  conf(/Situação: entregue, em cobrança · recebeu em 03\/11 \(há 1 dia\) · transportadora diz: Entregue \(03\/11\)\./.test(t2), 'Entregues nao pago: a coluna em palavras, ha quanto tempo o cliente recebeu e o selo da transportadora com a data');
  conf(/Pagamento: não pago, falta R\$ 197,00\./.test(t2) && /Retorno marcado: 07\/11 09:00\./.test(t2), 'falta pagar e o retorno marcado (agend) em DD/MM HH:MM');
  conf(/Rastreio: sem código ainda\./.test(t2), 'sem rastreio');
  const t3 = bloco(3);
  conf(/falta R\$ 147,00 \(já entrou R\$ 50,00 em 1 parcela\)\./.test(t3) && /Cobrador \(dono da cobrança\): sem cobrador ainda\./.test(t3), 'pagamento parcial: "ja entrou" e o saldo; sem cobrador = "sem cobrador ainda"');
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
  conf(r.acao === 'respondeu' && /^Joselina Da Silva \(Sorocaba\/SP\): pago em 04\/11 \(Pix\)\. cobrador Bryan, vendedor Guilherme\./.test(r.resposta) && /resposta pronta do pedido/.test(r.motivo), 'MARCADO, a IA calou e tem pedido na mao: sai a resposta pronta do pedido (10/11), nunca silencio');
  ({ r } = await pergunta({ ia: [{ json: { responder: false, texto: '' } }] }, '@Barbadinho como vc ta hoje?'));
  conf(r.acao === 'respondeu' && /^tô aqui!/.test(r.resposta) && /saiu a resposta padrão/.test(r.motivo), 'MARCADO e a IA calou sem pedido nenhum: sai a resposta padrao do grupo, nunca silencio');
  {
    const m = monta({ ...MUNDO, chat: [{ ts: agoraS() - 60, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'cvz', de_jid: '5515999990001@s.whatsapp.net', de_nome: 'Guilherme', quem_id: GUI, texto: '@Barbadinho fala', acao: 'respondeu', resposta: 'fala!', motivo: 'leu: oi', chamadas: 1 }], ia: [{ json: { responder: false, texto: '' } }] });
    const r2 = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'e o meu app, ta travando de novo', menciona: false }));
    conf(r2.acao === 'calado' && /a IA preferiu/.test(r2.motivo) && !r2.resposta, 'sem marcar (na conversa) e a IA calou: calado de verdade');
    conf(/Te chamaram nesta mensagem/.test((await pergunta({ ia: [JSON_OK] })).chamadas[0].user) && !/Te chamaram nesta mensagem|Falaram seu nome|Responderam uma mensagem sua/.test(m.chamadas[0].user), 'a IA sabe quando foi marcada e quando entrou sozinha');
    conf(/Quando te MARCAM \(@Barbadinho\), responda sempre/.test(m.chamadas[0].system) && /no condicional/.test(m.chamadas[0].system) && /Prometer mudar seu jeito/.test(m.chamadas[0].system), 'as regras: marcado responde sempre; provavel no condicional; nao promete mudar o jeito');
  }
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'Liga pra ela no 15 99999 0000.' } }] }));
  conf(r.acao === 'respondeu' && !/99999/.test(r.resposta) && /^Joselina Da Silva/.test(r.resposta) && /escreveu dado pessoal \(telefone\); saiu a resposta pronta/.test(r.motivo), 'telefone na saida: a frase da IA NUNCA sai; com o pedido na mao sai a resposta pronta dele (10/11)');
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'Liga pra ela no 15 99999 0000.' } }] }, '@Barbadinho me ajuda aqui'));
  conf(r.acao === 'calado' && /dado pessoal \(telefone\)/.test(r.motivo) && r.resposta === '', 'telefone na saida, sem pedido na mao: calado (a resposta e publica)');
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'Manda por wa.me/5515999990000' } }] }, '@Barbadinho me ajuda aqui'));
  conf(r.acao === 'calado' && /\(link\)/.test(r.motivo), 'link wa.me na saida: calado');
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'CPF 123.456.789-01 confere' } }] }, '@Barbadinho me ajuda aqui'));
  conf(r.acao === 'calado' && /\(cpf\)/.test(r.motivo), 'CPF na saida: calado');
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'CPF 123.456.789-01 confere' } }] }));
  conf(r.acao === 'respondeu' && !/123\.456/.test(r.resposta) && /^Joselina/.test(r.resposta), 'CPF na saida com pedido na mao: o CPF nunca sai, sai a resposta pronta');
  ({ r } = await pergunta({ ia: [{ json: { responder: true, texto: 'O pedido #1793903844876 da Joselina está pago.' } }] }));
  conf(r.acao === 'respondeu' && /#1793903844876/.test(r.resposta), 'o id do pedido que veio nos dados passa');
  {
    // O rastreio do pedido encontrado nao e telefone (medido ao vivo: J&T de 15 digitos calava o bot).
    const leads = LEADS.map((l) => (l.id === 1793903844876 ? { ...l, track: '888031023495895' } : l));
    const x = await pergunta({ leads, ia: [{ json: { responder: true, texto: 'Pago. Rastreio J&T 888031023495895.' } }] });
    conf(x.r.acao === 'respondeu' && /888031023495895/.test(x.r.resposta), 'o codigo de rastreio do pedido encontrado passa pela mascara');
    const y = await pergunta({ leads, ia: [{ json: { responder: true, texto: 'Rastreio 999999999999999.' } }] });
    conf(!/999999999999999/.test(y.r.resposta) && /dado pessoal \(telefone\)/.test(y.r.motivo), 'um numero longo que nao veio nos dados continua barrado (sai a resposta pronta do pedido no lugar)');
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
  conf(/Pedido PROVÁVEL \(confirme antes de afirmar pagamento\):\n#1793903844876 C\d+ \(Sorocaba\/SP\)/.test(chamadas[1].user) && !/Joselina/.test(chamadas[1].user) && r.viu.some((v) => /2a busca: 1793903844876/.test(v)), 'o pedido achado entra no contexto da segunda rodada');
}
{
  // Aviso a direcao = push na dash pra cada diretor/socio, registrado, e 1 por assunto a cada 30 min.
  const m = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'Relaxa, tem 2 numeros ligados. Já avisei a direção.', avisar_direcao: 'numero do Guilherme caiu' } }] });
  const cfg = cfgDe(m.api);
  let r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: '@Barbadinho meu numero caiu?', menciona: true, marcado: true }));
  conf(r.alerta === 1 && m.pushes.length === 2 && m.pushes.map((p) => p.userId).sort().join() === 'dir,socio_x4dy6d', 'avisar_direcao: push pra CADA diretor/socio da casa (nao pro afiliado), alerta 1');
  conf(/Barbadinho: pedido de ajuda no grupo/.test(m.pushes[0].payload.title) && /Guilherme no grupo GlicoSix - Vendedores: "@Barbadinho meu numero caiu\?" · numero do Guilherme caiu/.test(m.pushes[0].payload.body), 'o push diz quem, em que grupo, o que e o resumo da IA');
  conf(m.envios.length === 1 && m.envios[0].tipo === 'ia_aviso' && m.envios[0].status === 'enviado' && m.envios[0].via === 'push', 'registro em bot_envios tipo ia_aviso');
  conf(!!m.cfgdb['bot_iaav_' + GUI + ':numero'], 'a marca do assunto (pessoa:numero) fica em app_config');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: 'meu numero caiu de novo' }));
  conf(r.alerta === 0 && m.pushes.length === 2 && m.envios.length === 1 && m.api.BOT_IA_CAIU.includes(r.resposta) && /já tinha sido avisada/.test(r.motivo), 'a segunda vez em 30 min nao manda de novo, e a frase curta ainda diz que avisou (o aviso de antes vale)');
}
{
  const { r, chamadas } = await pergunta({ ia: [{ status: 429 }, JSON_OK] });
  conf(r.acao === 'respondeu' && chamadas.length === 2 && chamadas[1].modelo === 'gemini-2.5-flash' && r.modelo === 'gemini-2.5-flash', '429 no primeiro modelo: o segundo responde');
  const dois = await pergunta({ ia: [{ status: 429 }, { status: 429 }, JSON_OK] });
  conf(dois.r.acao === 'respondeu' && dois.chamadas.length === 3, '429 nos dois primeiros: o terceiro modelo responde (3 tentativas por mensagem)');
  const tres = await pergunta({ ia: [{ status: 429 }] });
  conf(tres.r.acao === 'respondeu' && tres.chamadas.length === 3 && /cota da IA esgotada/.test(tres.r.motivo) && /^Joselina Da Silva/.test(tres.r.resposta) && /resposta pronta do pedido/.test(tres.r.motivo), '429 nos tres modelos com o pedido na mao: sai a resposta pronta dele (10/11)');
  const tresSem = await pergunta({ ia: [{ status: 429 }] }, '@Barbadinho bom dia');
  conf(tresSem.r.acao === 'respondeu' && /manda de novo/.test(tresSem.r.resposta) && /saiu a resposta reserva/.test(tresSem.r.motivo), '429 nos tres modelos sem pedido: marcado recebe a resposta reserva (nunca vacuo)');
  conf(Number(tres.cfgdb.bot_ia_quota_ate) === agoraS() + 3600, 'e a pausa de 1 h fica gravada em bot_ia_quota_ate');
  const max = await pergunta({ ia: [{ finish: 'MAX_TOKENS', json: { responder: true, texto: 'cortado' } }, JSON_OK] });
  conf(max.r.acao === 'respondeu' && max.chamadas.length === 2 && max.r.modelo === 'gemini-2.5-flash', 'finishReason MAX_TOKENS: passa pro proximo modelo');
  conf(!max.cfgdb.bot_ia_quota_ate, '(e nao e cota: nada de pausa)');
  const vazio = await pergunta({ ia: [{ texto: '' }, JSON_OK] });
  conf(vazio.r.acao === 'respondeu' && vazio.chamadas.length === 2, 'texto vazio: passa pro proximo');
  const proibido = await pergunta({ ia: [{ status: 403 }, JSON_OK] });
  conf(proibido.r.acao === 'respondeu' && proibido.chamadas.length === 1 && /403/.test(proibido.r.motivo) && /^Joselina Da Silva/.test(proibido.r.resposta) && !proibido.cfgdb.bot_ia_quota_ate, '403: para na hora (a chave e que esta errada), sem pausa de cota; com pedido na mao sai a resposta pronta');
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
  conf(/^Intensidade: GRITÃO liberado \(13 hoje, 10 ou mais\)[^\n]*\.\nVendedor: Guilherme\. Pedidos hoje: 13\. Próximo marco: 15 \(faltam 2\)\. Hora: 11:00\.$/.test(m.chamadas[0].user), 'a IA recebe a intensidade, o vendedor e o marco, sem tempo parado e sem lider (soava cobranca de chefe)');
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
  conf(m.fila.length === 1 && m.fila[0].texto === 'Guilherme, faltam 2 pro 15 👀 vai deixar escapar agora?', 'IA fora (429): sai a frase reserva com o nome de verdade');
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
  const r = await m.api.handleBotIaTeste(req('/api/bot/ia/teste', { grupo: 'vend', texto: 'meu numero caiu?', quem_id: GUI }), m.env);
  conf(r._json.ok === true && r._json.responder === true && r._json.resposta === 'Tem 2 ligados.' && m.chamadas.length === 1, 'com 8 chamadas na hora o teste ainda chama a IA (sem freio)');
  conf(!r._json.viu.includes('placar de hoje') && r._json.viu.includes('números de Guilherme'), 'e devolve o que viu (os numeros; numero caido nao precisa do placar)');
  conf(/Quem perguntou: Guilherme \(vendedor\)/.test(m.chamadas[0].user) && /aviso_entregue: false/.test(m.chamadas[0].user), 'o quem_id escolhido na tela vira a pessoa, e aviso_entregue e false no teste');
  conf(m.chat.length === 9 && m.chat[8].acao === 'teste' && m.chat[8].quem_id === GUI && m.chat[8].alerta === 1, 'grava acao "teste" (nenhuma linha visto)');
  conf(m.pushes.length === 0 && m.envios.length === 0 && m.fila.length === 0, 'nao avisa a direcao nem manda nada');
  const curta = await m.api.handleBotIaTeste(req('/api/bot/ia/teste', { grupo: 'vend', texto: '2248 caiu', quem_id: GUI }), m.env);
  conf(curta._json.responder === true && m.api.BOT_IA_CAIU.includes(curta._json.resposta) && m.chamadas.length === 1 && m.pushes.length === 0 && /teste, sem aviso/.test(curta._json.motivo), 'Pergunte ao bot com "2248 caiu": a frase curta, sem IA e sem aviso (09/11)');
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
  conf(/#1793903844876 C1 /.test(m.chamadas[0].user) && !/Joselina/.test(m.chamadas[0].user), 'com o pedido da fila do Bryan no contexto (pelo codigo)');
  conf(m.chat.length === 1 && m.chat[0].jid === TG && m.chat[0].grupo === 'cob' && m.chat[0].quem_id === BRYAN && m.chat[0].acao === 'pendente', 'a linha fica com o jid do grupo de teste, como cobradores, no nome do Bryan');
  conf(m.quem.length === 0, 'o quem e quem nao guarda quem escreve no grupo de teste');
  const fora = await m.api._botIaMensagem(m.env, cfg, msg({ jid: GC, texto: 'a joselina pagou?', menciona: true, de_jid: '111222333444@lid', de_fone: '', de_nome: 'Bryan' }));
  conf(fora.ignorar === true && m.chamadas.length === 1, 'no grupo de verdade (desligado) nada muda: ignorado, sem IA');
}
{
  // Sem pessoa escolhida: conta como quem ligou o teste (o Bruno, socio: ve a fila inteira).
  const m = monta({ ...MUNDO, cfg: CFG_TESTE({ quem_id: '' }), ia: [JSON_OK] });
  await m.api._botIaMensagem(m.env, m.api._botNormaliza(m.mundo.cfg, null), msg({ jid: TG, texto: 'o carlos pereira pagou?', menciona: true, ...BRUNO_WA }));
  conf(/Quem perguntou: Bruno Correa \(sócio, da direção\)/.test(m.chamadas[0].user) && /#4 C1 /.test(m.chamadas[0].user) && !/Carlos Pereira/.test(m.chamadas[0].user), 'sem pessoa escolhida: conta como quem ligou o teste, com a visao da direcao');
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
  conf(m.api.BOT_IA_CAIU.includes(r.resposta) && m.chamadas.length === 0, 'como Vendedores, "meu numero caiu" sem marcar responde com a frase curta (igual ao grupo de verdade)');
  conf(m.chat[m.chat.length - 1].quem_id === GUI && m.chat[m.chat.length - 1].grupo === 'vend', 'e conta como o Guilherme, no grupo dos Vendedores');
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
  conf(r4._json.ok && r4._json.resposta === 'Guilherme, faltam 5 pro 5 👀 vai deixar escapar agora?' && /Pedidos hoje: 0\./.test(m3.chamadas[0].user), 'sem pedido hoje e IA fora: a frase reserva, e a IA soube que ele ainda nao vendeu');
}

// ══ 17. A CASCATA DO GEMINI ════════════════════════════════════════════════════════════
titulo('17. A cascata do Gemini: teto curto no 1o modelo e modelo cheio fica de fora');
{
  const m = monta({ ...MUNDO, ia: (_ch, i) => (i === 0 ? { status: 503 } : JSON_OK) });
  const M = m.api.BOT_IA_MODELOS;
  const r1 = await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(!!r1.texto && m.chamadas.length === 2 && m.chamadas[0].modelo === M[0] && m.chamadas[1].modelo === M[1], '503 no 1o modelo: o 2o responde');
  conf(m.tetos[0] === 7000 && m.tetos[1] === 7000, 'com 3 tentativas por mensagem, o 1o e o 2o modelo tem teto de 7 s (ainda tem outro na fila)');
  const r2 = await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(!!r2.texto && m.chamadas.length === 3 && m.chamadas[2].modelo === M[1], 'na chamada seguinte o modelo cheio fica de fora: vai direto no 2o');
  RELOGIO.agora += 6 * 60000;
  try { await m.api._botIaChamar(m.env, 'sys', 'user', {}); } finally { RELOGIO.agora -= 6 * 60000; }
  conf(m.chamadas[3].modelo === M[0], 'passados 5 min ele volta a ser o primeiro');
  const p = monta({ ...MUNDO, ia: [{ status: 503 }] });
  await p.api._botIaChamar(p.env, 'sys', 'user', { maxModelos: 1 });
  conf(p.tetos[0] === 15000 && p.chamadas.length === 1, 'com um modelo so (a provocacao) o teto e o cheio, 15 s');
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
  conf(/Pedido encontrado:\n#1793903844876 C1 /.test(m.chamadas[0].user), 'o id do pedido ao lado da marcacao continua achado');
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
  // Citou a resposta do bot sem marcar: "valeu" solto nem chama a IA (cadencia, 07/11); com algo a mais, a IA e avisada
  // que so responde se for com ela.
  const chat = [{ ts: agoraS() - 300, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'rv1', de_jid: '', de_nome: 'Kevin', texto: 'oi', acao: 'respondeu', resposta: 'Relaxa, Kevin: 2 numeros ligados ainda.', chamadas: 1 }];
  const m = monta({ ...MUNDO, chat, ia: [{ json: { responder: false, texto: '' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'valeu', responde: true, citado: 'Relaxa, Kevin: 2 numeros ligados ainda.' }));
  conf(r.acao === 'visto' && r.motivo === 'só risada ou ok' && m.chamadas.length === 0, '"valeu" solto citando a resposta do bot: nem chama a IA (cadencia de 07/11)');
  const r1b = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'valeu, salvou meu dia', responde: true, citado: 'Relaxa, Kevin: 2 numeros ligados ainda.' }));
  conf(r1b.acao === 'calado' && /Responderam uma mensagem sua sem te marcar/.test(m.chamadas[0].user), 'algo a mais citando a resposta do bot: a IA sabe que pode calar, e calou (sem resposta padrao)');
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
  const m2 = monta({ ...MUNDO, ia: (ch) => (ch.modelo === M[3] ? { status: 503 } : { status: 429 }) });
  await m2.api._botIaChamar(m2.env, 'sys', 'user', { modelos: [M[3], M[0], M[1]], maxModelos: 2 });   // poe o 4o (latest) de fora
  const r = await m2.api._botIaChamar(m2.env, 'sys', 'user', {});
  conf(r.quota === true, 'o modelo fora era o 4o (fora dos 3 tentados): 429 nos tentados pausa a cota como antes');
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
  conf(/ANTES DE ESCREVER, ESCOLHA UM MODO/.test(sys) && /na dúvida, PROBLEMA/.test(sys) && /PROBLEMA: acolhe primeiro e resolve/.test(sys), 'o modo por mensagem, com PROBLEMA na frente (acolhe e resolve)');
  conf(/soltar a franga/.test(sys) && /nenhum no PROBLEMA/.test(sys) && /Palavrão de comemoração vale nos dois grupos/.test(sys) && /GRITÃO de torcida/.test(sys), 'giria de tiozao proibida; emoji na festa e na zoeira (nunca no problema); palavrao de comemoracao nos dois grupos (06/11 tarde)');
  const vend = api.BOT_IA_EXEMPLOS.vend.join('\n'), cob = api.BOT_IA_EXEMPLOS.cob.join('\n');
  conf(!/[—–]/.test(vend + cob) && /🔥/u.test(vend) && /💰/u.test(cob), 'nenhum exemplo tem travessao; a festa dos dois grupos tem emoji');
  conf(!/\b(desgraçado|as bb|gin|revoada)\b/i.test(vend + cob), 'nenhum exemplo tem a piada das bb nem xingamento pesado');
  conf(/contam por aí que o último a bater 5/.test(vend) && /ISSO AÍ PORRAAAA/.test(cob) && /nunca repita uma que já saiu/.test(sys), 'a zoeira tem mini historinha (sempre inventada, sem repetir) e a cobranca tem a mesma energia');
  conf(api.BOT_IA_EXEMPLOS.vend.some((e) => /^"Barbadinho tu é fera"/.test(e)) && api.BOT_IA_EXEMPLOS.cob.some((e) => /^"Barbadinho tu é fera"/.test(e)), 'o elogio pelo nome (sem marcar) tem resposta nos dois grupos');
}
{
  // A limpeza da saida tira emoji que escapar.
  const { api } = monta({});
  conf(api._botIaLimpa('BOOORA 🔥🔥 10 cravadas 🍾', []).texto === 'BOOORA 🔥🔥 10 cravadas 🍾', 'emoji fica na resposta (06/11 tarde: o Bruno quer emoji na festa)');
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
  conf(r4.acao === 'visto' && r4.motivo === 'só risada ou ok' && !r4.resposta && m3.chamadas.length === 0, 'na conversa, risada solta nem chama a IA (cadencia de 07/11)');
}
{
  // Falou o nome pra elogiar ("Barbadinho tu e fera"): a linha diz pra responder quando e COM o bot.
  const m = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'fera é vc com 2 hj kkkkk' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'Barbadinho tu é fera', menciona: true, marcado: false }));
  conf(r.acao === 'respondeu' && /Te chamaram nesta mensagem/.test(m.chamadas[0].user), 'nome no elogio (no comeco da frase): conta como chamar o bot, e ele responde');
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
  conf(/#6 C1 /.test(m.chamadas[0].user) && !/Pedro Manual|pedro manual/.test(m.chamadas[0].user) && /aguardando aprovação da direção/.test(m.chamadas[0].user), '"o pedido do pedro manual nao subiu": acha o pedido e diz que espera a aprovacao da direcao');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho bati 5 hoje, solta um audio comemorando', menciona: true, marcado: true }));
  conf(!/Nenhum pedido encontrado/.test(m2.chamadas[0].user), 'comemoracao com "bati", "audio", "comemorando": nao vira busca de pedido');
}

// ══ 22. CHAMAR PELO NOME (06/11) ═══════════════════════════════════════════════════════
titulo('22. O nome no comeco ou no fim da mensagem e chamar o bot');
{
  const m = monta({ ...MUNDO, ia: [{ json: { responder: false, texto: '' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'Massa meu querido barbadinho', menciona: true, marcado: false }));
  conf(r.acao === 'respondeu' && /^tô aqui!/.test(r.resposta) && /Te chamaram nesta mensagem/.test(m.chamadas[0].user), '"Massa meu querido barbadinho" (nome no fim): conta como marcar, nunca fica calado');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: 'Barbadinho voce consegue tirar duvida da dash?', menciona: true, marcado: false }));
  conf(/Te chamaram nesta mensagem/.test(m2.chamadas[0].user), '"Barbadinho voce consegue..." (nome no comeco): conta como marcar');
  const m3 = monta({ ...MUNDO, ia: [{ json: { responder: false, texto: '' } }] });
  const r3 = await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: 'kkkk o barbadinho zoou o Kevin', menciona: true, marcado: false }));
  conf(r3.acao === 'calado' && /Falaram seu nome/.test(m3.chamadas[0].user), 'o nome no meio da frase (falando DELE): a IA decide, e pode calar');
  conf(/agradecimento ou elogio pra você ganha resposta curta e animada/.test(m3.chamadas[0].system), 'elogio e agradecimento pro bot ganham resposta curta');
}

// ══ 23. NUMERO CAIU: ACOLHER, NAO DESMENTIR (06/11) ════════════════════════════════════
titulo('23. Numero caiu: acolhe e resolve, nunca desmente quem relatou');
{
  const { api } = monta({});
  const sys = api._botIaSistema(api._botNormaliza(CFG_RAW, null), 'vend');
  conf(/acolhe primeiro e resolve, sem duvidar de quem relatou/.test(sys) && /NUNCA diga que não aparece queda/.test(sys), 'a regra: acolher e nunca usar a falta de registro de queda pra desmentir');
  conf(/não perder o bonde/.test(sys) && /quando fizer sentido e tiver graça/.test(sys) && /nunca em duas respostas seguidas/.test(sys), 'trocadilho quando fizer sentido, sem forcar e nunca dois seguidos');
  conf((api.BOT_IA_EXEMPLOS.vend.join('\n').match(/bonde/g) || []).length === 0 && /Resposta CURTA, uma frase/.test(sys) && !/desliga o interruptor/i.test(api.BOT_IA_EXEMPLOS.vend.join('\n')), 'numero caido curto (09/11): nenhum exemplo com trocadilho nem interruptor, e o prompt pede uma frase');
  const ex = api.BOT_IA_EXEMPLOS.vend.join('\n');
  conf(!/ainda não aparece queda/.test(ex) && /relaxa queridão/.test(ex), 'nenhum exemplo desmente a queda; o exemplo de numero caido acolhe');
}

// ══ 24. A IA FORA (06/11) ══════════════════════════════════════════════════════════════
titulo('24. A IA fora: marcado e problema nunca ficam no vacuo');
{
  const m = monta({ ...MUNDO, ia: [{ status: 503 }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'caiu meu numero de novo pqp' }));
  conf(r.acao === 'respondeu' && m.api.BOT_IA_CAIU.includes(r.resposta) && m.pushes.length >= 1 && m.chamadas.length === 0, 'numero caido nao depende da IA: com o Gemini fora (503) a frase curta e o aviso saem igual');
  const m1 = monta({ ...MUNDO, chat: [{ ts: agoraS() - 60, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'cvy', de_jid: '5515999990001@s.whatsapp.net', de_nome: 'Guilherme', quem_id: GUI, texto: '@Barbadinho oi', acao: 'respondeu', resposta: 'fala!', motivo: 'leu: oi', chamadas: 1 }], ia: [{ status: 503 }] });
  const r1 = await m1.api._botIaResponder(m1.env, cfgDe(m1.api), pacote({ texto: 'o app travou aqui de novo' }));
  conf(r1.acao === 'respondeu' && /já avisei o Bruno/.test(r1.resposta) && m1.pushes.length >= 1 && m1.chamadas.length === 3, 'problema na conversa com a IA fora (503 nos 3 modelos): resposta reserva e aviso a direcao mesmo assim');
  const m2 = monta({ ...MUNDO, ia: [{ status: 503 }] });
  const r2 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho quantas vendas eu tenho?', menciona: true, marcado: true }));
  conf(r2.acao === 'respondeu' && /manda de novo daqui a pouco/.test(r2.resposta) && m2.pushes.length === 0, 'marcado com a IA fora: avisa que deu ruim e pede pra mandar de novo (sem aviso a direcao)');
  const chat = [{ ts: agoraS() - 60, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'cvx', de_jid: '5515999990001@s.whatsapp.net', de_nome: 'Guilherme', quem_id: GUI, texto: 'oi', acao: 'respondeu', resposta: 'fala!', chamadas: 1 }];
  const m3 = monta({ ...MUNDO, chat, ia: [{ status: 503 }] });
  const r3 = await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: 'e ai, bora?' }));
  conf(r3.acao === 'erro' && !r3.resposta, 'conversa sem marcar e sem problema com a IA fora: fica quieto (nao enche o grupo)');
  const m4 = monta({ ...MUNDO, ia: [{ status: 503 }], push: false });
  const r4 = await m4.api._botIaResponder(m4.env, cfgDe(m4.api), pacote({ texto: 'meu numero caiu' }));
  conf(r4.acao === 'respondeu' && m4.api.BOT_IA_CAIU_SEM_AVISO.includes(r4.resposta) && /marca o Bruno aqui/.test(r4.resposta) && r4.alerta === 0, 'sem push que chegue: pede pra marcar o Bruno (nunca diz que avisou)');
}

// ══ 25. A CHAVE DO BOT (06/11) ═════════════════════════════════════════════════════════
titulo('25. A chave so do bot (o credito do Google AI Pro vai so pro bot)');
{
  const m = monta({ ...MUNDO, chaveBot: 'AIza-do-bot', ia: [JSON_OK] });
  await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(/key=AIza-do-bot/.test(m.chamadas[0].url), 'com a chave do bot colada, o bot chama o Gemini com ela');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m2.api._botIaChamar(m2.env, 'sys', 'user', {});
  conf(/key=AIza-teste/.test(m2.chamadas[0].url), 'sem a chave do bot, usa a chave geral');
}

// ══ 26. O MANUAL (06/11) ═══════════════════════════════════════════════════════════════
titulo('26. O manual: a duvida de uso puxa so os itens que batem');
{
  const { api } = monta({});
  const temas = (txt, g) => api._botIaManualPara(txt, g).map((x) => x.t);
  conf(temas('meu numero caiu, e agora?')[0] === 'Número caiu', '"meu numero caiu": o item do numero caido vem primeiro');
  conf(temas('posso usar o sellwave web em duas maquinas ao mesmo tempo?')[0] === 'SellWave Web em dois computadores', '"posso usar em duas maquinas?": o item dos dois computadores vem primeiro');
  conf(temas('como faço pra parar de receber lead pra almocar?').includes('Ligar e desligar o recebimento'), '"parar de receber pra almocar": o item do interruptor');
  conf(temas('o pedido da maria nao subiu').includes('Pedido não subiu ou não aparece'), '"o pedido nao subiu": o item do pedido que nao subiu');
  conf(!temas('o pixel ta disparando').includes('Cliente quer pagar'), 'palavra curta so inteira ("pix" nao casa com "pixel")');
  conf(temas('bom dia galera').length === 0, 'papo sem duvida: nenhum item');
  const fora = api.BOT_IA_MANUAL.filter((x) => !temas(x.q, x.g).includes(x.t)).map((x) => x.t);
  conf(!fora.length, 'a pergunta de exemplo de cada item puxa o proprio item' + (fora.length ? ' (falhou: ' + fora.join(', ') + ')' : ''));
  conf(temas('o que significa cada linha do resumo?', 'cob')[0] === 'Linhas do resumo da cobrança' && temas('o que significa cada linha do resumo?', 'vend')[0] === 'Linhas do resumo do dia', 'empate: vem antes o item do grupo em que perguntaram');
  conf(api.BOT_IA_MANUAL.length >= 70 && api.BOT_IA_MANUAL.every((x) => x.t && x.q && x.k.length && x.r && !/\d{8,}/.test(x.r) && !/[—–]/.test(x.r) && !/https?:|www\./i.test(x.r)), 'todo item tem tema, exemplo, palavras e resposta, sem numero longo, travessao nem link');
}
{
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho posso usar o sellwave web em duas maquinas?', menciona: true, marcado: true }));
  conf(/MANUAL \(como fazer, conferido no sistema/.test(m.chamadas[0].user) && /Pode instalar em quantos computadores quiser/.test(m.chamadas[0].user) && r.viu.some((v) => /manual:/.test(v)), 'a duvida vai pra IA com o item do manual nos DADOS');
  conf(/QUEM RESOLVE/.test(m.chamadas[0].system) && /Heynan \(comercial\): campanha e orçamento/.test(m.chamadas[0].system), 'o system leva quem resolve cada assunto');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho como desligo meu numero pra almocar?', menciona: true, marcado: true, de_jid: '5599000000000@s.whatsapp.net', de_fone: '5599000000000', de_nome: 'Fulano' }));
  conf(/Pessoa não identificada/.test(m2.chamadas[0].user) && /MANUAL/.test(m2.chamadas[0].user), 'pessoa nao identificada tambem recebe o manual (nao tem dado pessoal)');
}

// ══ 27. TETO DA CHAVE PAGA (06/11) ═════════════════════════════════════════════════════
titulo('27. O teto do mes da chave paga do bot');
{
  const mes = 'bot_ia_pagas_' + DIA.slice(0, 7);
  const m = monta({ ...MUNDO, chaveBot: 'AIza-do-bot', ia: [JSON_OK] });
  await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(/key=AIza-do-bot/.test(m.chamadas[0].url) && m.cfgdb[mes] === '1', 'abaixo do teto: usa a chave paga e conta a chamada do mes');
  const m2 = monta({ ...MUNDO, chaveBot: 'AIza-do-bot', config: { [mes]: '1600' }, ia: [JSON_OK] });
  const r2 = await m2.api._botIaChamar(m2.env, 'sys', 'user', {});
  conf(/key=AIza-teste/.test(m2.chamadas[0].url) && m2.cfgdb[mes] === '1600' && r2.tentativas.some((x) => /teto do mês/.test(x)), 'no teto (1.600 ate dezembro): volta pra chave geral (gratis), sem contar mais');
  const m3 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m3.api._botIaChamar(m3.env, 'sys', 'user', {});
  conf(!m3.cfgdb[mes], 'sem chave paga: nao conta nada');
}

// ══ 28. PRIVACIDADE NA IA (06/11) ══════════════════════════════════════════════════════
titulo('28. Privacidade: o nome do cliente nao vai pra IA e volta na resposta');
{
  const { api } = monta({});
  const L = [
    { id: 1, nome: 'Joselina Da Silva' }, { id: 2, nome: 'JOSE CARLOS LIMA' }, { id: 3, nome: 'José Ribamar Teixeira' },
    { id: 4, nome: 'Bruno Souza' }, { id: 5, nome: 'Maria das Dores' }, { id: 6, nome: 'Ana Afiliada', afl: 'x' },
  ];
  const ps = api._botIaPseudo(L, ['Bruno Correa', 'Guilherme']);
  conf(ps.cliente(L[0]) === 'C1' && ps.cliente(L[0]) === 'C1' && ps.cliente(L[1]) === 'C2', 'cada cliente ganha um codigo, sempre o mesmo dentro da mensagem');
  conf(ps.texto('a dona joselina da silva ja pagou?') === 'a dona C1 ja pagou?', 'nome completo digitado (minusculo, com "da") vira o codigo');
  conf(ps.texto('e a Joselina?') === 'e a C1?', 'primeiro nome solto de cliente com codigo vira o codigo');
  conf(ps.texto('a silva pagou?') === 'a silva pagou?', 'sobrenome solto nao vira (palavra comum demais)');
  conf(ps.texto('o jose carlos lima pagou?') === 'o C2 pagou?', 'nome todo em maiuscula na base casa com o digitado');
  conf(ps.texto('ontem a Maria das Dores mandou o comprovante') === 'ontem a C3 mandou o comprovante', 'cliente da base ainda sem codigo: primeiro nome + sobrenome vira codigo novo');
  conf(ps.texto('to com dores nas costas') === 'to com dores nas costas', 'palavra do nome que nao e o primeiro, sozinha, fica');
  conf(ps.texto('marca o Bruno aqui') === 'marca o Bruno aqui' && ps.texto('o Bruno Souza pagou?') === 'o C4 pagou?', 'primeiro nome da equipe solto nunca vira codigo; com o sobrenome do cliente vira');
  conf(ps.texto('a Ana Afiliada pagou?') === 'a Ana Afiliada pagou?', 'cliente do afiliado nao entra no indice (o mundo do afiliado nao e lido)');
  conf(ps.texto('liga no 15 98888-7777 ou cpf 123.456.789-01') === 'liga no [número final 7777] ou cpf [número final 8901]', 'telefone e CPF digitados: so o final');
  conf(ps.texto('o pedido 1234 e o kit de 3') === 'o pedido 1234 e o kit de 3', 'numero curto fica');
  const ps2 = api._botIaPseudo(L, []);
  ps2.cliente(L[1]); ps2.cliente(L[2]);
  conf(ps2.texto('o josé pagou?') === 'o [cliente] pagou?', 'primeiro nome de dois clientes com codigo: [cliente], sem chutar');
  conf(ps2.texto('o josé ribamar pagou?') === 'o C2 pagou?', 'o segundo nome desempata');
  const ps3 = api._botIaPseudo(L, []);
  ps3.cliente(L[0]);
  conf(ps3.rastreio('AA123456789BR') === 'R1' && ps3.rastreio('AA123456789BR') === 'R1', 'rastreio vira R1');
  conf(ps3.restaura('C1 pagou em 04/11 no Pix. C1 tá em dia') === 'Joselina Da Silva pagou em 04/11 no Pix. Joselina tá em dia', 'a volta: nome completo na primeira vez, primeiro nome depois');
  conf(ps3.restaura('a C1 pagou, o pedido da C1 tá pago. Se for a C1 de Itu/SP') === 'Joselina Da Silva pagou, o pedido de Joselina tá pago. Se for Joselina de Itu/SP', 'o artigo que a IA pos some (ela nao sabe se e homem ou mulher)');
  conf(ps3.restaura('A C1 pagou') === 'Joselina Da Silva pagou' && ps3.restaura('Da C1 nada ainda') === 'De Joselina Da Silva nada ainda', 'artigo em maiuscula no comeco da frase');
  conf(ps3.restaura('rastreio R1') === 'rastreio AA123456789BR' && ps3.restaura('C9 pagou') === 'C9 pagou' && ps3.restaura('a casa e o carro') === 'a casa e o carro', 'rastreio volta; codigo que nao existe e texto comum ficam como vieram');
  conf(ps3.desfaz('C1') === 'Joselina Da Silva', 'o que a IA pede pra buscar volta a ser o nome');
  conf(api._botIaNomeBonito('JOSE CARLOS DA SILVA') === 'Jose Carlos da Silva' && api._botIaNomeBonito('Maria de Lourdes') === 'Maria de Lourdes', 'nome todo em maiuscula fica bonito; o digitado com cuidado fica como esta');
}
{
  const m = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'pagou sim! a C1 entrou em 04/11 no Pix' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho a joselina da silva ja pagou?', menciona: true, marcado: true }));
  const u = m.chamadas[0].user;
  conf(!/joselina/i.test(u) && /#1793903844876 C1 \(Sorocaba\/SP\)/.test(u) && /"@Barbadinho a C1 ja pagou\?"/.test(u), 'na IA so vai o codigo: na pergunta e no pedido');
  conf(r.resposta === 'pagou sim! Joselina Da Silva entrou em 04/11 no Pix', 'e a resposta volta com o nome no lugar do codigo');
  conf(/Cliente vem como C1, C2/.test(m.chamadas[0].system), 'o system explica o codigo');
}
{
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho o 15 98888-7777 pagou?', menciona: true, marcado: true }));
  const u = m.chamadas[0].user;
  conf(/\[número final 7777\]/.test(u) && !/98888/.test(u) && /#1793903844876 C1 /.test(u), 'telefone digitado: acha o pedido pelo numero inteiro, mas na IA vai so o final');
}
{
  const chat = [{ ts: agoraS() - 120, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'pv1', de_jid: '', de_nome: 'Kevin', texto: 'a joselina da silva pagou?', acao: 'respondeu', resposta: 'pagou sim! Joselina Da Silva entrou em 04/11 no Pix', chamadas: 1 }];
  const m = monta({ ...MUNDO, chat, ia: [JSON_OK] });
  await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho e o rastreio?', menciona: true, marcado: true }));
  const u = m.chamadas[0].user;
  conf(/Últimas mensagens do grupo \(hora de Brasília/.test(u) && !/joselina/i.test(u) && /Barbadinho: pagou sim! C1 entrou em 04\/11/.test(u), 'as ultimas mensagens do grupo (inclusive a resposta do bot) vao sem o nome do cliente');
}
{
  const chat = [{ ts: agoraS() - 120, dia: DIA, grupo: 'vend', jid: GV, msg_id: 'pv2', de_jid: '', de_nome: 'Kevin', texto: 'a joselina da silva pagou?', acao: 'respondeu', resposta: 'pagou sim', chamadas: 1 }];
  const m = monta({ ...MUNDO, chat, ia: [{ json: { responder: true, texto: 'Deixa eu ver', buscar: 'C1' } }, { json: { responder: true, texto: 'achei: C1 pagou em 04/11' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho e o pedido dela?', menciona: true, marcado: true }));
  conf(/Kevin: a C1 pagou\?/.test(m.chamadas[0].user) && r.viu.some((v) => /2a busca: 1793903844876/.test(v)) && r.resposta === 'achei: Joselina Da Silva pagou em 04/11', 'a IA pede pra buscar "C1" (que ela viu nas ultimas mensagens): a busca usa o nome de verdade e a resposta volta com ele');
}

// ══ 29. COTA DO DIA (06/11) ════════════════════════════════════════════════════════════
titulo('29. 429 da cota do DIA: o modelo fica fora ate a cota voltar');
{
  const corpoDia = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }, { retryDelay: '55971s' }] } });
  const m = monta({ ...MUNDO, ia: [{ status: 429, body: corpoDia }, { status: 429, body: '{"error":{"code":429}}' }, JSON_OK] });
  const r = await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(r.texto && r.tentativas[0] === 'gemini-3.5-flash 429 (cota do dia)' && r.tentativas[1] === 'gemini-2.5-flash 429', '429 com PerDay no corpo e marcado como cota do dia; o 429 comum continua comum');
  const f1 = m.api._botIaGemFora.get('gemini-3.5-flash|geral'), f2 = m.api._botIaGemFora.get('gemini-2.5-flash|geral');
  conf(f1 && f1.ate - DataFalsa.now() > 15 * 3600000 && f1.ate - DataFalsa.now() <= 24 * 3600000 && f2 && f2.ate - DataFalsa.now() <= 3 * 60000 + 1000, 'cota do dia: fora pelo retryDelay (15 h); 429 comum: 3 min');
  m.api._botIaGemFora.clear();
}

// ══ 30. O DIA DO BOT NA ABA BOT DE IA (06/11) ══════════════════════════════════════════
titulo('30. GET /api/bot/chat traz quantas respostas hoje e se a chave e paga');
{
  const chat = [
    linhaChat({ msg_id: 'h1', grupo: 'vend', jid: GV, acao: 'respondeu' }), linhaChat({ msg_id: 'h2', grupo: 'vend', jid: GV, acao: 'pendente' }),
    linhaChat({ msg_id: 'h3', grupo: 'vend', jid: GV, acao: 'calado' }), linhaChat({ msg_id: 'h4', grupo: 'vend', jid: TG, acao: 'respondeu', teste: 1 }),
    linhaChat({ msg_id: 'h5', grupo: 'cob', jid: GC, acao: 'respondeu' }),
  ];
  const m = monta({ ...MUNDO, chat, chaveBot: 'AIza-do-bot' });
  const r = await m.api.handleBotChat({ url: 'https://api.sellwave.com.br/api/bot/chat?grupo=vend', headers: { get: () => 'Bearer x' } }, m.env);
  const j = r._json || {};
  conf(j.hoje && j.hoje.respondeu === 2 && j.hoje.calado === 1 && j.ia_chave === 'paga', 'vend: 2 respostas hoje (pendente conta), 1 calado, o teste fica de fora; chave paga');
  const m2 = monta({ ...MUNDO, chat });
  const r2 = await m2.api.handleBotChat({ url: 'https://api.sellwave.com.br/api/bot/chat?grupo=cob', headers: { get: () => 'Bearer x' } }, m2.env);
  conf((r2._json || {}).hoje.respondeu === 1 && (r2._json || {}).ia_chave === 'gratis', 'cob: 1 resposta hoje; sem chave do bot = gratis');
}

// ══ 31. REVISAO DA PRIVACIDADE (06/11) ═════════════════════════════════════════════════
titulo('31. Revisao: nome parecido, particula, e-mail, endereco, traco, data, pedido sem nome, volta e chave');
{
  const { api } = monta({});
  const duasMarias = [{ id: 901, nome: 'Maria Aparecida Silva' }, { id: 900, nome: 'Maria Silva Costa' }];
  const p1 = api._botIaPseudo(duasMarias, []);
  conf(p1.texto('a Maria Silva disse que paga amanhã') === 'a C1 disse que paga amanhã' && p1.desfaz('C1') === 'Maria Silva', 'nome digitado que bate em dois pedidos: codigo com o nome DIGITADO (sem chutar outra cliente)');
  const p2 = api._botIaPseudo(duasMarias, []);
  p2.cliente(duasMarias[1]);
  conf(p2.texto('a maria silva pagou?') === 'a C1 pagou?', 'nome que bate em dois pedidos, um deles ja com codigo (o achado pela busca): usa o dele');
  const p3 = api._botIaPseudo([{ id: 1, nome: 'Maria Silva Santos' }, { id: 2, nome: 'Maria Silva' }], []);
  conf(p3.texto('a maria silva me chamou de novo') === 'a C1 me chamou de novo' && p3.desfaz('C1') === 'Maria Silva', 'com o nome exato na base, fica com ele');
  const base4 = [{ id: 1, nome: 'Maria Silva' }, { id: 2, nome: 'Maria Souza Lima' }, { id: 3, nome: 'Pedro Souza' }];
  const p4 = api._botIaPseudo(base4, []);
  conf(p4.texto('a maria silva e a maria souza lima') === 'a C1 e a C2', 'duas clientes com o mesmo primeiro nome na mesma frase: dois codigos');
  const p5 = api._botIaPseudo(base4, []);
  p5.cliente(base4[0]);
  conf(p5.texto('a Maria Ferreira ligou') === 'a [cliente] ligou' && p5.texto('a maria souza ligou') === 'a C2 ligou', 'primeiro nome igual ao da C1 com outro sobrenome: nao vira a C1');
  const nomes = [{ id: 11, nome: "Joana D'Arc Ferreira" }, { id: 12, nome: 'Carlos Del Rio' }, { id: 13, nome: 'Ana Van Der Berg' }, { id: 14, nome: 'Ana-Paula Souza' }, { id: 15, nome: 'Kelly C. Moraes' }];
  const p6 = api._botIaPseudo(nomes, []);
  conf(p6.texto("a Joana D'Arc Ferreira, o Carlos Del Rio, a Ana Van Der Berg, a Ana-Paula Souza e a Kelly C. Moraes") === 'a C1, o C2, a C3, a C4 e a C5', "D'Arc, Del, Van Der, hifen e inicial: o nome inteiro vira o codigo");
  const p7 = api._botIaPseudo([], []);
  conf(p7.texto('pediu boleto no joana.ferreira@gmail.com, mora na rua das Acácias 145') === 'pediu boleto no [e-mail], mora na [endereço]', 'e-mail e endereco com numero viram marcador');
  conf(p7.texto('o pedido tá na rua desde 05/11') === 'o pedido tá na rua desde 05/11', '"ta na rua" (saiu pra entrega) e data ficam');
  conf(p7.texto('+55 11 98765 4321 e 11 98765–4321 e 11 98765‑4321') === '[número final 4321] e [número final 4321] e [número final 4321]', 'telefone com espaco fixo, meia-risca e hifen nao separavel: so o final');
  conf(p7.texto('entregue em 06/11/2026, pedidos 101 102 103') === 'entregue em 06/11/2026, pedidos 101 102 103' && p7.texto('cpf 123.456.789-01') === 'cpf [número final 8901]', 'data com ano e lista de numeros curtos ficam; CPF vira o final');
  const p8 = api._botIaPseudo([], []);
  p8.cliente({ id: 9, nome: '' });
  conf(p8.texto('esse numero da empresa caiu de novo?') === 'esse numero da empresa caiu de novo?' && p8.restaura('C1 pagou') === 'esse cliente pagou', 'pedido sem nome: "esse" do texto nao vira codigo; a volta diz "esse cliente"');
  const p9 = api._botIaPseudo([{ id: 1, nome: 'Jose Carlos Lima' }, { id: 2, nome: 'Jose Ribamar Teixeira' }], []);
  p9.cliente({ id: 1, nome: 'Jose Carlos Lima' }); p9.cliente({ id: 2, nome: 'Jose Ribamar Teixeira' });
  conf(p9.restaura('se for o C1 ja da. é o C1 ou o C2?') === 'se for Jose Carlos Lima ja da. é Jose Carlos Lima ou Jose Ribamar Teixeira?', 'dois codigos com o mesmo primeiro nome: a volta repete o nome completo');
  conf(p9.restaura('c1 pagou; [cliente] nao; o [número final 7777] caiu; manda no [e-mail]') === 'Jose Carlos Lima pagou; esse cliente nao; o final 7777 caiu; manda no e-mail', 'codigo em minuscula e marcador copiado pela IA voltam como texto normal');
  const L1 = api._botIaLimpa('liga no 11 98765–4321', []);
  conf(L1.barrou === 'telefone', 'o filtro da saida pega telefone com meia-risca');
}
{
  const m = monta({ ...MUNDO, chat: [], anthropic: 'sk-ant-x' });
  const r = await m.api.handleBotChat({ url: 'https://api.sellwave.com.br/api/bot/chat?grupo=vend', headers: { get: () => 'Bearer x' } }, m.env);
  conf((r._json || {}).ia_chave === 'claude', 'com a chave da Anthropic, a tela diz Claude');
  const mes = 'bot_ia_pagas_' + DIA.slice(0, 7);
  const m2 = monta({ ...MUNDO, chat: [], chaveBot: 'AIza-do-bot', config: { [mes]: '1600' } });
  const r2 = await m2.api.handleBotChat({ url: 'https://api.sellwave.com.br/api/bot/chat?grupo=vend', headers: { get: () => 'Bearer x' } }, m2.env);
  conf((r2._json || {}).ia_chave === 'gratis', 'chave paga no teto do mes: a tela diz gratis (e o que o bot usa)');
}
{
  // A cota do dia da chave gratis nao tira o modelo da chave paga.
  const corpoDia = JSON.stringify({ error: { code: 429, details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay: '50000s' }] } });
  const m = monta({ ...MUNDO, ia: [{ status: 429, body: corpoDia }, JSON_OK] });
  await m.api._botIaChamar(m.env, 'sys', 'user', {});
  conf(!!m.api._botIaGemFora.get('gemini-3.5-flash|geral') && !m.api._botIaGemFora.get('gemini-3.5-flash|bot'), 'a cota do dia fica marcada so na chave em que deu 429');
}

// ══ 32. META DO MES (06/11) ════════════════════════════════════════════════════════════
titulo('32. A meta do mes no lugar da meta da semana dos vendedores');
{
  const { api } = monta({});
  const m0 = api._botMetaMes({ mes: 152, cheios: 130 });
  conf(!m0.faixa && m0.proxima.pedidos === 200 && m0.faltam_mes === 48 && m0.ok80 && m0.pct497 === 86, '152 pedidos, 130 de 497+: faltam 48 pra 200, 80% ok');
  const m1 = api._botMetaMes({ mes: 230, cheios: 150 });
  conf(m1.faixa.pedidos === 220 && m1.proxima.pedidos === 240 && !m1.ok80 && m1.travado, '230 com 65% de 497+: faixa 220 alcancada mas travada pelos 80%');
  const m2 = api._botMetaMes({ mes: 290, cheios: 290 });
  conf(m2.faixa.pedidos === 280 && !m2.proxima && m2.faltam_mes === 0, 'passou de 280: topo, nada falta');
  conf(api._botMetaTxt(m0) === '152 pedidos, faltam 48 pra 200' && api._botMetaTxt(m1) === '230 pedidos, faltam 10 pra 240 (497+: 65%, precisa 80%)' && api._botMetaTxt(m2) === '290 pedidos, bateu 280', 'o texto da meta: falta, topo e o 497+ so quando esta abaixo');
  const n = api._botNormaliza({ relatorio: { rotulos: { meta: 'Meta da semana' } }, meta_batida: { frases: ['Meta da semana batida, {nome}: {n} pedidos', 'Boa {nome}!'] } });
  conf(n.relatorio.rotulos.meta === 'Meta do mês' && n.meta_batida.frases[0] === 'BOOORA {nome}! {n} pedidos no mês, faixa batida. Agora é a próxima.' && n.meta_batida.frases[1] === 'Boa {nome}!', 'config gravada com a meta da semana: rotulo e frase viram os do mes, frase propria fica');
  const n2 = api._botNormaliza({ relatorio: { rotulos: { meta: 'Meta' } } });
  conf(n2.relatorio.rotulos.meta === 'Meta', 'rotulo escrito pelo Bruno fica como esta');
}
{
  const m = monta({ ...MUNDO });
  const dados = await m.api._botDados(m.env, DIA, cfgDe(m.api), 'diario', false, { leads: LEADS, chips: [] });
  const g = dados.vendedores.find((v) => v.id === GUI);
  conf(g && g.mes === 4 && g.cheios === 0 && g.proxima.pedidos === 200 && g.faltam === 196 && g.meta === 200, 'Guilherme em novembro: 4 pedidos (Joselina, Pedro manual, 101 e 102), faltam 196 pra 200');
  const placar = m.api._botIaPlacarTexto(dados, cfgDe(m.api), { id: GUI });
  conf(/Meta do mês \(de cada vendedor/.test(placar) && /meta do mês: 4 pedidos, faltam 196 pra 200 \(497\+: 0%, precisa 80%\)/.test(placar) && !/semana/.test(placar), 'o que a IA ve: a regra e a meta do mes de quem perguntou, sem semana');
}

// ══ 33. REVISAO DA META DO MES (06/11) ═════════════════════════════════════════════════
titulo('33. Revisao da meta do mes: 80% arredondado, frase do Bruno com "semana" e midia');
{
  const { api } = monta({});
  const m = api._botMetaMes({ mes: 252, cheios: 201 });
  conf(!m.ok80 && m.pct497 === 79 && /497\+: 79%, precisa 80%/.test(api._botMetaTxt(m)), '201 de 252 (79,8%): mostra 79%, nunca "80%, precisa 80%"');
  const n = api._botNormaliza({ meta_batida: { frases: ['Que semana, {nome}!', 'Meta da semana batida, {nome}: {n} pedidos'], frases_midia: [{ key: 'a'.repeat(24) + '.jpg' }, { key: 'b'.repeat(24) + '.jpg' }],
    por_vendedor: { v1: { frases: ['Boa {nome}', 'Missão da semana cumprida por {nome}: {n} pedidos.'], frases_midia: [{ key: 'c'.repeat(24) + '.jpg' }, { key: 'd'.repeat(24) + '.png' }] } } } });
  const pv = n.meta_batida.por_vendedor.v1;
  conf(n.meta_batida.frases[0] === 'Que semana, {nome}!' && n.meta_batida.frases[1].startsWith('BOOORA') && pv.frases[0] === 'Boa {nome}' && pv.frases[1].startsWith('BOOORA'), 'so a frase antiga conhecida troca; a do Bruno com "semana" fica');
  conf(pv.frases_midia[0] && pv.frases_midia[0].key === 'c'.repeat(24) + '.jpg' && n.meta_batida.frases_midia[0] && n.meta_batida.frases_midia[0].key === 'a'.repeat(24) + '.jpg', 'a lista por vendedor mantem a midia da frase que ficou');
}

// ══ 34. FESTA SEM MARCAR E O JEITO OUSADO (06/11 tarde) ════════════════════════════════
titulo('34. Festa sem marcar: so palavra forte, so com o placar, uma tentativa a cada 10 min');
{
  const m = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'SEGURA O HOMIII 🐐🔥' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'BOOORA +1 KRL', menciona: false }), { reage: true });
  conf(r.responder && m.api.BOT_IA_FESTA_REACOES.includes(r.reacao) && r.resposta === '(reagiu com ' + r.reacao + ')' && r.motivo === 'festa: reação' && m.chamadas.length === 0, 'comemoracao sem marcar (09/11): so uma reacao, sem texto e sem IA');
  const m1 = monta({ ...MUNDO, ia: [JSON_OK] });
  const r1 = await m1.api._botIaResponder(m1.env, cfgDe(m1.api), pacote({ texto: 'BOOORA +1 KRL', menciona: false }));
  conf(r1.acao === 'calado' && /bot do PC não reage/.test(r1.motivo) && m1.chamadas.length === 0, 'sem o bot do PC que reage: calado (nunca vira texto)');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  const r2 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: 'bora almoçar galera', menciona: false }));
  conf(r2.acao === 'visto' && m2.chamadas.length === 0, '"bora" sozinho nao e festa: nem chama a IA');
  const m3 = monta({ ...MUNDO, ia: [JSON_OK] });
  const r3 = await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: 'porra, ja pagou?', menciona: false }));
  conf(r3.acao === 'visto' && m3.chamadas.length === 0, 'pergunta nao e festa');
  const chat = [linhaChat({ msg_id: 'f1', grupo: 'vend', jid: GV, acao: 'respondeu', resposta: '(reagiu com 🔥)', motivo: 'festa: reação', ts: agoraS() - 120 })];
  const m4 = monta({ ...MUNDO, chat, ia: [JSON_OK] });
  const r4 = await m4.api._botIaResponder(m4.env, cfgDe(m4.api), pacote({ texto: 'ISSO AÍ PORRAAA fechei', menciona: false }), { reage: true });
  conf(r4.acao === 'respondeu' && !!r4.reacao && m4.chamadas.length === 0, 'a reacao de festa de OUTRA pessoa ha 2 min nao segura a desta (09/11: por pessoa)');
  const m4b = monta({ ...MUNDO, chat: [linhaChat({ msg_id: 'f2', grupo: 'vend', jid: GV, de_jid: '5515999990001@s.whatsapp.net', de_nome: 'Guilherme', acao: 'respondeu', resposta: '(reagiu com 🔥)', motivo: 'festa: reação', ts: agoraS() - 120 })], ia: [JSON_OK] });
  const r4b = await m4b.api._botIaResponder(m4b.env, cfgDe(m4b.api), pacote({ texto: 'ISSO AÍ PORRAAA fechei', menciona: false }), { reage: true });
  conf(r4b.acao === 'visto' && !r4b.reacao && m4b.chamadas.length === 0, 'a mesma pessoa ja ganhou a reacao ha 2 min: fica quieto');
  const m5 = monta({ ...MUNDO, ia: [JSON_OK] });
  const r5 = await m5.api._botIaResponder(m5.env, cfgDe(m5.api, { ia: { ...CFG_RAW.ia, so_marcado: { vend: true, cob: true } } }), pacote({ texto: 'BOOORA +1 KRL', menciona: false }));
  conf(r5.acao === 'visto' && m5.chamadas.length === 0, 'com "so quando marcarem" ligado, festa sem marcar nao entra');
  const n = m.api._botIaNormaliza({ tom: { vend: m.api.BOT_IA_TOM_VELHOS[0], cob: m.api.BOT_IA_TOM_VELHOS[1] } });
  conf(/ousado e zoeiro/.test(n.tom.vend) && /Mesma energia do grupo dos vendedores/.test(n.tom.cob), 'o jeito gravado igual ao padrao antigo vira o novo (mais ousado) nos dois grupos');
}

// ══ 35. ZOEIRA LIMPA COM A BARBARA (06/11 tarde) ═══════════════════════════════════════
titulo('35. Com a Barbara a zoeira e limpa: vai nos DADOS da mensagem e na provocacao');
{
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho conta uma piada', menciona: true, marcado: true }));
  conf(!/zoeira são LIMPAS/.test(m.chamadas[0].user), 'com o Guilherme, nada de linha de zoeira limpa');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho conta uma piada', menciona: true, marcado: true }), { quem: { id: 'atendente_barb', nome: 'Barbara Marin', role: 'atendente', chefe: false, equipe: [] } });
  conf(/Com Barbara a festa e a zoeira são LIMPAS/.test(m2.chamadas[0].user), 'com a Barbara, a linha de zoeira limpa vai nos dados da mensagem');
}

// ══ 36. COBRADORES: VARIOS TELEFONES E A INTENSIDADE (06/11 tarde) ═══════════════════════
titulo('36. Varios telefones na mensagem sao varios pedidos; a festa segue o numero do dia');
{
  const { api } = monta({});
  const L = [
    { id: 11, nome: 'Raimunda Jose dos Santos', wa: '5575987062647', col: 'A Enviar', at: GUI, cob: BRYAN, vl: 497, ts: Date.now() },
    { id: 12, nome: 'Verineide Silva', wa: '5575981483452', col: 'A Enviar', at: KEVIN, cob: BRYAN, vl: 497, ts: Date.now() },
    { id: 13, nome: 'Outra Cliente', wa: '5594981079476', col: 'Entregues', at: KEVIN, cob: HAYNAN, vl: 297, ts: Date.now() },
  ];
  const quemB = { id: BRYAN, nome: 'Bryan', role: 'cobrador', chefe: false };
  const b = api._botIaAcharPedidos({ leads: L }, '+55 75 8706-2647 Raimunda e +55 75 8148-3452 Neide nao estao na minha dash', quemB, 'cob', {}, {});
  conf(b.certo && b.varios && !b.ambiguo && b.ids.join() === '11,12', 'dois telefones, cada um com o seu pedido: dois pedidos certos (nada de "qual deles?")');
  const b2 = api._botIaAcharPedidos({ leads: L }, '75 8706-2647 e 94 8107-9476', quemB, 'cob', {}, {});
  conf(b2.certo && b2.ids.join() === '11' && b2.foraDoEscopo.length === 1 && b2.foraDoEscopo[0].id === 13, 'um telefone da fila dele e outro da fila de outro cobrador: os dois aparecem');
  const L2 = [{ id: 21, nome: 'Ana Souza', wa: '5511999990000', col: 'Entregues', at: GUI, cob: BRYAN, vl: 197, ts: Date.now() - 86400000 }, { id: 22, nome: 'Ana Souza', wa: '5511999990000', col: 'Entregues', at: GUI, cob: BRYAN, vl: 197, ts: Date.now() }];
  const b3 = api._botIaAcharPedidos({ leads: L2 }, '11 99999-0000', quemB, 'cob', {}, {});
  conf(b3.ambiguo && !b3.varios, 'o MESMO telefone com dois pedidos continua ambiguo (pergunta qual)');
  conf(/leve e de boa/.test(api._botIaIntensidade ? api._botIaIntensidade(5) : 'leve e de boa'), 'intensidade com 5: leve');
}
{
  const m = monta({ ...MUNDO });
  const dados = await m.api._botDados(m.env, DIA, cfgDe(m.api), 'diario', false, { leads: LEADS, chips: [] });
  const placar = m.api._botIaPlacarTexto(dados, cfgDe(m.api), { id: GUI });
  conf(/Intensidade se for FESTA ou ZOEIRA com quem perguntou: leve e de boa \(2 hoje, até 5\)/.test(placar), 'o placar diz a intensidade de quem perguntou (Guilherme com 2 hoje: leve)');
  const sys = m.api._botIaSistema(cfgDe(m.api), 'vend');
  conf(/a intensidade segue o número do dia/.test(sys) && /bati 5 hj krl" \(Guilherme, placar 5; intensidade leve\) -> boaaa/.test(sys), 'a regra da intensidade e o exemplo leve do 5 no prompt');
}

// ══ 37. O NUMERO DITO NA FESTA X O PLACAR (06/11 tarde) ═══════════════════════════════════
titulo('37. "fechei a 10" com menos no placar: o aviso vai nos dados');
{
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho fechei a 10 caralho', menciona: true, marcado: true }));
  conf(/ATENÇÃO: Guilherme falou em 10, mas o placar de hoje mostra 2\. NÃO comemore o 10/.test(m.chamadas[0].user) && r.viu.some((v) => /disse 10, placar 2/.test(v)), 'disse 10 com 2 no placar: a IA e avisada pra nao comemorar o 10');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho bati 2 hj krl', menciona: true, marcado: true }));
  conf(!/ATENÇÃO:/.test(m2.chamadas[0].user), 'disse o numero certo: sem aviso');
  const m3 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: '@Barbadinho bati, entrou as 15:30 do dia 06/11', menciona: true, marcado: true }));
  conf(!/ATENÇÃO:/.test(m3.chamadas[0].user), 'hora e data nao contam como numero dito');
}

// ══ 38. SEM EMPURRAO DE VENDA EM TODA RESPOSTA (06/11 noite) ═══════════════════════════════
titulo('38. "bora buscar" so quando o assunto e venda ou cobranca');
{
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho vc torce pra qual time?', menciona: true, marcado: true }));
  conf(/Placar e fila ficaram de fora \(a mensagem não pergunta do número do dia\)/.test(m.chamadas[0].user), 'pergunta boba: a IA e avisada pra nao empurrar venda');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho quantas vendas eu tenho hj?', menciona: true, marcado: true }));
  conf(!/ninguém falou de venda/.test(m2.chamadas[0].user), 'pergunta de venda: sem o aviso (o empurrao pode)');
  const sys = m.chamadas[0].system;
  conf(/NÃO fecha toda resposta/.test(sys) && /Sem placar, sem fila, sem venda e sem empurrão/.test(sys), 'as regras do empurrao no prompt');
  const ex = m.api.BOT_IA_EXEMPLOS.vend.concat(m.api.BOT_IA_EXEMPLOS.cob);
  const comBora = ex.filter((e) => /bora (buscar|moer)|mete marcha/.test(e.split('->')[1] || ''));
  conf(comBora.length <= 4, 'poucos exemplos terminam com empurrao (' + comBora.length + ')');
}

// ══ 39. ZOEIRA PURA, O NOME DE QUEM FALOU E A PERSONA (06/11 noite) ═════════════════════════
titulo('39. Zoeira sem placar, sem o nome de quem falou, festa sem repetir e o bot bolsonarista');
{
  const { api } = monta({});
  const sv = api._botIaSemVocativo;
  conf(sv('foda é vc, Guilherme! tamo junto kkkk', 'Guilherme Sá') === 'foda é vc! tamo junto kkkk', 'tira ", Guilherme!" do meio');
  conf(sv('kkkkk hackear urna eu não sei, Bruno, mas se me derem a senha', 'Bruno Correa') === 'kkkkk hackear urna eu não sei, mas se me derem a senha', 'tira ", Bruno," do meio');
  conf(sv('Guilherme, tá voando hj', 'Guilherme') === 'tá voando hj' && sv('Guilherme tá com 9', 'Guilherme') === 'Guilherme tá com 9', 'no comeco sai so o chamamento (com virgula); o sujeito da frase fica');
  conf(sv('quem me cria é o Bruno na dash', 'Bruno') === 'quem me cria é o Bruno na dash', 'o nome no meio da frase fica');
  conf(sv('o pedido tá na fila do Haynan, Bryan.', 'Bryan Amorim') === 'o pedido tá na fila do Haynan.', 'o nome de outra pessoa fica');
  conf(sv('boaaa, bárbara 🔥', 'Barbara') === 'boaaa 🔥' && sv('fala, GUILHERME kkkkk', 'Guilherme') === 'fala kkkkk', 'acento, caixa, emoji e risada depois do nome');
  conf(sv('ISSO AÍ PORRAAAA 🔥 10 cravadas, Guilherme! tu é foda', 'Guilherme') === 'ISSO AÍ PORRAAAA 🔥 10 cravadas! tu é foda' && sv('boa, Guilhermes!', 'Guilherme') === 'boa, Guilhermes!', 'nome no meio do grito sai; nome maior (outra palavra) fica');
  const re = api.BOT_IA_ASSUNTO_VENDA_RE;
  const zoeira = ['Barbadinho vai ser convertido em breve, vai hackear as urnas', 'kkkk 22 na veia', 'vc tem q ser bolsonarista igual seus criadores barbadinho', 'Vc é foda', 'to vendo aqui kkk', 'Vc é lula ou bolsonaro barbadinho?', 'como vc ta hj?', 'esse cliente me fez esperar 2 horas pra fechar, que desgraçado kkkk', 'a cliente pagou mas reclamou pra caramba kkkk', 'o pedido da maria subiu?'];
  const numero = ['to com 9 ja', 'quantas eu tenho hj?', '+1', 'falta quanto pro 10?', 'como to hj?', 'como ta minha mesa hoje?', 'bati 5', 'fechei a 10 caralho', '10 hj krl', 'ta errado isso ai porra', 'quem ta ganhando?', 'qual pedido eu dou prioridade?', 'quantos faltam cobrar hj?', 'vendi 3 hj'];
  conf(zoeira.every((x) => !re.test(x)), 'zoeira e politica nao sao assunto de venda: ' + zoeira.filter((x) => re.test(x)).join(' | '));
  conf(numero.every((x) => re.test(x)), 'numero do dia, pagamento e pergunta de placar sao: ' + numero.filter((x) => !re.test(x)).join(' | '));
  conf(api.BOT_IA_GRITO_RE.test('ISSO AÍ PORRAAAA 🔥') && api.BOT_IA_GRITO_RE.test('SEGURA O HOMIII 🐐') && !api.BOT_IA_GRITO_RE.test('foda é vc! tamo junto kkkk'), 'o grito de festa e reconhecido; zoeira nao');
}
{
  // zoeira: o placar nao vai pra IA e o nome de quem falou sai da resposta
  const m = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'foda é vc, Guilherme! tamo junto kkkk' } }] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho vc tem q ser bolsonarista igual seus criadores', menciona: true, marcado: true }));
  conf(!/Placar de hoje/.test(m.chamadas[0].user) && /Placar e fila ficaram de fora/.test(m.chamadas[0].user) && r.viu.includes('sem placar'), 'zoeira: o placar fica de fora dos DADOS');
  conf(/^foda é vc! tamo junto k{3,11}$/.test(r.resposta) && r.viu.includes('tirou o nome'), 'zoeira: o nome de quem falou sai da resposta (a risada sai com tamanho de gente)');
  // pergunta de numero: o placar vai e o nome pode, uma vez
  const m2 = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'falta 3 pro 5, Guilherme, bora lá!' } }] });
  const r2 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho falta quanto pro 5?', menciona: true, marcado: true }));
  conf(/Placar de hoje/.test(m2.chamadas[0].user) && r2.resposta === 'falta 3 pro 5, Guilherme, bora lá!', 'numero: placar nos DADOS e o nome pode na primeira');
  // a resposta anterior pra mesma pessoa ja usou o nome: esta sai sem
  const deJid = '5515999990001@s.whatsapp.net';
  const m3 = monta({ ...MUNDO, chat: [linhaChat({ de_jid: deJid, de_nome: 'Guilherme', resposta: 'boaaa, Guilherme! 2 hj', ts: agoraS() - 120 })], ia: [{ json: { responder: true, texto: 'falta 3 pro 5, Guilherme, bora lá!' } }] });
  const r3 = await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: '@Barbadinho falta quanto pro 5?', menciona: true, marcado: true }));
  conf(r3.resposta === 'falta 3 pro 5, bora lá!', 'o nome nunca em duas respostas seguidas pra mesma pessoa');
  // a mensagem citada fala de numero (a provocacao): o placar vai
  const m4 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m4.api._botIaResponder(m4.env, cfgDe(m4.api), pacote({ texto: '@Barbadinho ta dando mole', menciona: true, marcado: true, citado: 'BOORA! 8 no bolso hj kkkkk faltam só 2 pro 10' }));
  conf(/Placar de hoje/.test(m4.chamadas[0].user), 'citou a provocacao com numero: o placar vai');
  // festa repetida: a IA sabe que ja comemorou e nao repete o grito
  const m5 = monta({ ...MUNDO, chat: [linhaChat({ de_jid: deJid, de_nome: 'Guilherme', resposta: 'ISSO AÍ PORRAAAA 🔥 10 cravadas! tu é foda', motivo: 'festa espontânea', ts: agoraS() - 60 })], ia: [JSON_OK] });
  const r5 = await m5.api._botIaResponder(m5.env, cfgDe(m5.api), pacote({ texto: 'bati as 10, to liberado pro meu jiu jitsu @Barbadinho', menciona: true, marcado: true }));
  conf(/Você acabou de comemorar com Guilherme \(há 1 min: "ISSO AÍ PORRAAAA/.test(m5.chamadas[0].user) && /Não repita a festa, o grito nem o número/.test(m5.chamadas[0].user) && r5.viu.includes('já comemorou com Guilherme'), 'festa repetida: o aviso vai nos DADOS');
  const m6 = monta({ ...MUNDO, chat: [linhaChat({ de_jid: deJid, de_nome: 'Guilherme', resposta: 'ISSO AÍ PORRAAAA 🔥', motivo: 'festa espontânea', ts: agoraS() - 900 })], ia: [JSON_OK] });
  await m6.api._botIaResponder(m6.env, cfgDe(m6.api), pacote({ texto: 'bati as 10 @Barbadinho', menciona: true, marcado: true }));
  conf(!/Você acabou de comemorar/.test(m6.chamadas[0].user), 'festa de 15 min atras: pode comemorar de novo');
  // cobradores: zoeira sem a mesa; pergunta da fila com a mesa
  const m7 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m7.api._botIaResponder(m7.env, cfgDe(m7.api), { ...pacote({ texto: '@Barbadinho essa barbadinho é ia?', menciona: true, marcado: true, jid: GC, de_jid: '111222333444@lid', de_fone: '', de_nome: 'Bryan' }), grupo: 'cob' });
  conf(!/Mesa de/.test(m7.chamadas[0].user) && /Placar e fila ficaram de fora/.test(m7.chamadas[0].user), 'cobradores: zoeira sem a mesa do dia');
  // a persona e os limites no prompt
  const sys = m.chamadas[0].system;
  conf(/bolsonarista assumido, 22 na veia/.test(sys) && /Nunca diga que não fala de política/.test(sys) && !/Falar de cliente \(nem zoando\), política/.test(sys), 'persona politica no prompt; politica saiu da lista do NUNCA');
  conf(/sem dizer que eleição ou urna é fraudada e sem violência/.test(sys) && /nunca pra alguém do grupo/.test(sys), 'a zoeira politica tem o limite (sem fraude, sem violencia, sem mirar alguem do grupo)');
  conf(/"Vc é lula ou bolsonaro barbadinho\?" \(Guilherme\) -> 22 na veia/.test(sys) && /-> realmente, odeio pagar imposto$/m.test(sys), 'os exemplos do Lula ou Bolsonaro e do imposto (sem kkkkk desde 07/11)');
  conf(/O nome de quem falou quase nunca/.test(sys) && /Empurrar pro Bruno ou pra dash sem precisar/.test(sys), 'as regras do nome e do "Bruno na dash"');
  const ex = m.api.BOT_IA_EXEMPLOS.vend.concat(m.api.BOT_IA_EXEMPLOS.cob);
  const comBruno = ex.filter((e) => /Bruno (lá )?na dash|reclama com ele/.test(e.split('->')[1] || '') && !/Quem é quem/.test(e));
  conf(comBruno.length === 0, 'nenhum exemplo empurra pro "Bruno na dash" (so o de apresentar pessoa nova): ' + comBruno.join(' | '));
  const zoeiraComNome = ex.filter((e) => !/^\(provoca/.test(e) && /\((Guilherme|Kevin|Bryan|Bruno)(,| conversando)?[^;:\d]*\) ->/.test(e) && /, (Guilherme|Kevin|Bryan|Bruno)\b/.test(e.split('->')[1] || ''));
  conf(zoeiraComNome.length === 0, 'nenhum exemplo de zoeira chama a pessoa pelo nome: ' + zoeiraComNome.join(' | '));
}

{
  // piada com cliente ou pagamento: a busca do pedido continua, o placar e a mesa nao
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), { ...pacote({ texto: '@Barbadinho a joselina da silva pagou mas reclamou pra caramba kkkk', menciona: true, marcado: true, jid: GC, de_jid: '111222333444@lid', de_fone: '', de_nome: 'Bryan' }), grupo: 'cob' });
  conf(!/Mesa de/.test(m.chamadas[0].user) && /Pedido encontrado|PROVÁVEL|AMBÍGUO/.test(m.chamadas[0].user), 'piada com cliente: o pedido vai, a mesa nao (' + r.viu.join(', ') + ')');
  // o que o bot ja disse no grupo vai como "nao repita"
  const frase = '22 na veia, meu querido 🇧🇷 petista aqui não tem vez kkkkk';
  const m2 = monta({ ...MUNDO, chat: [linhaChat({ de_jid: '5515999990077@s.whatsapp.net', resposta: frase, ts: agoraS() - 3600 }), linhaChat({ de_jid: '5515999990078@s.whatsapp.net', resposta: frase, ts: agoraS() - 3000 }), linhaChat({ de_jid: '5515999990079@s.whatsapp.net', resposta: 'realmente, odeio pagar imposto kkkkk', ts: agoraS() - 2500 })], ia: [JSON_OK] });
  await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: '@Barbadinho qual seu candidato?', menciona: true, marcado: true }));
  const u2 = m2.chamadas[0].user;
  conf(u2.includes('Frases suas que já saíram neste grupo hoje (não repita nenhuma, nem o mesmo começo):\n- realmente, odeio pagar imposto kkkkk\n- ' + frase + '\n') && u2.split('22 na veia, meu querido').length === 2, 'as frases que o bot ja disse vao como "nao repita", a mais nova primeiro e sem repetir a mesma');
  const m2b = monta({ ...MUNDO, chat: [linhaChat({ resposta: frase, ts: agoraS() - 3600 })], ia: [JSON_OK] });
  await m2b.api.handleBotIaTeste(req('/api/bot/ia/teste', { grupo: 'vend', texto: 'qual seu candidato?', quem_id: GUI }), m2b.env);
  conf(!/Frases suas que já saíram/.test(m2b.chamadas[0].user), 'no Pergunte ao bot (teste) a lista nao vai');
  // pergunta de numero: a intensidade nao vira gritao
  conf(/Intensidade se for FESTA ou ZOEIRA com quem perguntou: [^\n]*Pergunta de número é DADO: o número direto, sem grito\./.test(m2.chamadas[0].user) === false, 'zoeira: nem a linha da intensidade vai (sem placar)');
  const m3 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: '@Barbadinho quantas eu tenho hj?', menciona: true, marcado: true }));
  conf(/Pergunta de número é DADO: o número direto, sem grito\./.test(m3.chamadas[0].user), 'pergunta de numero: a intensidade avisa que DADO e sem grito');
}

// ══ 40. FALANDO COM OUTRA PESSOA E O CLIENTE QUE BLOQUEOU (07/11) ═══════════════════════════
titulo('40. Marcou outra pessoa: o bot fica de fora; "lead bloqueou" nao e numero caido');
{
  const { api } = monta({});
  const tp = api._botIaTextoProblema;
  const cli = (s) => /clientebloqueou/.test(tp(s)) && !/\bbloque/i.test(tp(s));
  conf(['Lead bloqueou', 'o lead me bloqueou', 'Ent bloqueou', 'a cliente bloqueou meu número', 'meu numero foi bloqueado pelo cliente', 'ela me bloqueou kkkk', 'me bloqueou no whats', 'deve ter bloqueado'].every(cli), 'bloqueio do cliente vira "clientebloqueou" (lead, cliente, ela, "me bloqueou", bloqueou solto)');
  conf(['meu número foi bloqueado', 'bloquearam meu chip', 'o whats me bloqueou', 'tô bloqueado', 'tomei bloqueio no zap', 'cara, meu número foi bloqueado'].every((s) => tp(s) === s), 'numero bloqueado pelo WhatsApp continua problema');
  conf(tp(tp('Lead bloqueou')) === tp('Lead bloqueou') && tp('meu numero caiu') === 'meu numero caiu', 'a troca nao mexe no resto e nao roda duas vezes');
  const tit = (txt, g) => api._botIaManualPara(txt, g).map((x) => x.t);
  conf(tit('meu numero caiu', 'cob').includes('Número de cobrança caiu') && !tit('meu numero caiu', 'cob').includes('Número caiu'), 'grupo dos cobradores: o numero caido sem interruptor');
  conf(tit('meu numero caiu', 'vend')[0] === 'Número caiu' && !tit('meu numero caiu', 'vend').includes('Número de cobrança caiu'), 'grupo dos vendedores: o do interruptor');
  conf(tit('Lead bloqueou', 'cob')[0] === 'Cliente bloqueou' && !tit('o lead me bloqueou', 'cob').some((x) => /^Número/.test(x)) && !tit('o lead me bloqueou', 'vend').some((x) => /^Número/.test(x)), 'lead bloqueou: o item do cliente que bloqueou, nunca o do numero caido');
  const cobCaiu = api.BOT_IA_MANUAL.find((x) => x.t === 'Número de cobrança caiu');
  conf(!!cobCaiu && !/desliga o interruptor|interruptor dele/i.test(cobCaiu.r), 'o item da cobranca nao manda desligar interruptor');
  const sys = api._botIaSistema(api._botNormaliza(CFG_RAW, null), 'cob');
  conf(/Cliente que bloqueou \("lead bloqueou"/.test(sys) && /No grupo dos cobradores não existe interruptor nem roleta/.test(sys) && /Mensagem que marca outra pessoa \(@Fulano, @alguém\)/.test(sys) && /"@Barbadinho o lead me bloqueou"/.test(sys), 'o prompt: cliente que bloqueou, cobranca sem interruptor, marcou outra pessoa = calado, e o exemplo');
  conf(api._botIaChamouOutroPeloNome('Heynan, o lead sumiu', [{ nome: 'Heynan Dantas' }], 'Elias Santos') === 'Heynan' && api._botIaChamouOutroPeloNome('Kevin bateu a meta', [{ nome: 'Kevin Marques' }], 'Guilherme') === '' && api._botIaChamouOutroPeloNome('Boa!', [{ nome: 'Kevin Marques' }], 'Guilherme') === '', 'chamar pelo nome: so o nome do time no comeco, com virgula, ? ou sozinho');
}
{
  // O print (grupo dos cobradores, espontaneo liberado como em producao): "Lead bloqueou" nao e problema.
  const cfgCob = (api) => cfgDe(api, { ia: { ...CFG_RAW.ia, so_marcado: { vend: false, cob: false } } });
  const BRY = { jid: GC, de_jid: '111222333444@lid', de_fone: '', de_nome: 'Bryan' };
  const m = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'putz, vish! desliga o interruptor dele', avisar_direcao: 'numero caiu' } }] });
  let r = await m.api._botIaResponder(m.env, cfgCob(m.api), { ...pacote({ texto: 'Lead bloqueou', ...BRY }), grupo: 'cob' });
  conf(r.acao === 'visto' && m.chamadas.length === 0 && m.pushes.length === 0, '"Lead bloqueou" sem marcar: visto, sem IA e sem aviso pra direcao');
  r = await m.api._botIaResponder(m.env, cfgCob(m.api), { ...pacote({ texto: 'Ent bloqueou', ...BRY }), grupo: 'cob' });
  conf(r.acao === 'visto' && m.chamadas.length === 0, '"Ent bloqueou": visto');
  r = await m.api._botIaResponder(m.env, cfgCob(m.api), { ...pacote({ texto: 'meu numero foi bloqueado', ...BRY }), grupo: 'cob' });
  conf(r.acao === 'respondeu' && m.api.BOT_IA_CAIU.includes(r.resposta) && m.chamadas.length === 0, '"meu numero foi bloqueado" continua sendo numero caido: a frase curta, sem IA');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  await m2.api._botIaResponder(m2.env, cfgCob(m2.api), { ...pacote({ texto: '@Barbadinho o lead me bloqueou', menciona: true, marcado: true, ...BRY }), grupo: 'cob' });
  const u2 = m2.chamadas[0].user;
  conf(/- Cliente bloqueou: Quem bloqueou foi o cliente/.test(u2) && !/Número caiu:|Número de cobrança caiu:/.test(u2), 'marcado: a IA recebe o manual do cliente que bloqueou, sem o do numero caido');
}
{
  // Marcou outra pessoa nesta mensagem: o bot fica de fora; marcou o bot junto, responde.
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  const cfg = cfgDe(m.api);
  let r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: '@Bruno meu numero caiu' }));
  conf(r.acao === 'visto' && r.motivo === 'falando com outra pessoa (marcou outra pessoa)' && m.chamadas.length === 0 && m.pushes.length === 0, 'marcou o Bruno no problema: o bot fica de fora (sem IA e sem aviso)');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: 'precisa de algo @alguém ? meu numero caiu' }));
  conf(r.acao === 'visto' && m.chamadas.length === 0, '"@alguém" (marcado fora do quem e quem) tambem conta');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: '@Kevin boraaa porra' }));
  conf(r.acao === 'visto' && m.chamadas.length === 0, 'festa marcando outra pessoa: o bot fica de fora');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: '@Bruno o que vc acha disso?', responde: true, citado: 'Relaxa.' }));
  conf(r.acao === 'visto' && m.chamadas.length === 0, 'citou o bot mas marcou o Bruno: e com o Bruno');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: '@Barbadinho @Bruno meu numero caiu', menciona: true, marcado: true }));
  conf(r.acao === 'respondeu' && m.api.BOT_IA_CAIU.includes(r.resposta) && m.chamadas.length === 0, 'marcou o bot E outra pessoa: o bot responde (a frase curta do numero caido)');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: 'Kevin, meu numero caiu' }));
  conf(r.acao === 'visto' && r.motivo === 'falando com outra pessoa (chamou Kevin)' && m.chamadas.length === 0, 'chamou alguem do time pelo nome no comeco ("Kevin, ..."): fica de fora');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: 'galera, meu numero caiu' }));
  conf(r.acao === 'respondeu' && m.api.BOT_IA_CAIU.includes(r.resposta), '"galera, ..." nao e ninguem do time: o numero caido responde');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: 'barbadinho, meu numero caiu', menciona: true }));
  conf(r.acao === 'respondeu' && m.api.BOT_IA_CAIU.includes(r.resposta), '"barbadinho, ..." e chamar o bot');
  r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: 'mandei pro fulano@gmail.com e meu numero caiu' }));
  conf(r.acao === 'respondeu' && m.api.BOT_IA_CAIU.includes(r.resposta) && m.chamadas.length === 0, 'e-mail no meio do texto nao e marcacao');
}
{
  // O print inteiro: a ficha, "@alguém @Bruno" e, segundos depois, o resto (sem marcar o bot).
  const ELI = { jid: GC, de_jid: '140948612857962@lid', de_fone: '', de_nome: 'Elias Santos' };
  const linha = (o) => linhaChat({ ...ELI, grupo: 'cob', acao: 'visto', resposta: '', chamadas: 0, ...o });
  const cfgCob = (api) => cfgDe(api, { ia: { ...CFG_RAW.ia, so_marcado: { vend: false, cob: false } } });
  const m = monta({ ...MUNDO, chat: [linha({ msg_id: 'e1', texto: 'Regina Pantoja\nCPF: 765.208.250-18', ts: agoraS() - 15 }), linha({ msg_id: 'e2', texto: '@alguém @Bruno', ts: agoraS() - 10 })], ia: [JSON_OK] });
  let r = await m.api._botIaMensagem(m.env, cfgCob(m.api), msg({ ...ELI, texto: 'meu numero caiu tbm' }));
  const row = m.chat[m.chat.length - 1];
  conf(r.resposta === '' && m.chamadas.length === 0 && row.acao === 'visto' && row.motivo === 'falando com outra pessoa (marcou outra pessoa agora há pouco)', 'marcou o Bruno e o Heynan 10 s antes: o que vem depois e pra eles (o motivo fica na linha)');
  const m2 = monta({ ...MUNDO, chat: [linha({ msg_id: 'c1', texto: '@Barbadinho oi', acao: 'respondeu', resposta: 'faaala!', chamadas: 1, ts: agoraS() - 60 }), linha({ msg_id: 'c2', texto: '@Bruno liga pra ela', ts: agoraS() - 20 })], ia: [JSON_OK] });
  r = await m2.api._botIaMensagem(m2.env, cfgCob(m2.api), msg({ ...ELI, texto: 'Mete o terror nessa verme' }));
  conf(r.resposta === '' && m2.chamadas.length === 0, 'estava conversando com o bot, mas marcou o Bruno depois: a zoeira e pro Bruno, o bot fica de fora');
  const m3 = monta({ ...MUNDO, chat: [linha({ msg_id: 'd1', texto: '@Bruno liga pra ela', ts: agoraS() - 100 }), linha({ msg_id: 'd2', texto: '@Barbadinho ela pagou?', acao: 'respondeu', resposta: 'ainda nao', chamadas: 1, ts: agoraS() - 40 })], ia: [JSON_OK] });
  r = await m3.api._botIaMensagem(m3.env, cfgCob(m3.api), msg({ ...ELI, texto: 'e o pedido da outra?' }));
  conf(m3.chamadas.length === 1, 'marcou o Bruno e depois o bot: a conversa segue com o bot');
  const m4 = monta({ ...MUNDO, chat: [linha({ msg_id: 'v1', texto: '@Bruno bom dia', ts: agoraS() - 400 })], ia: [JSON_OK] });
  r = await m4.api._botIaMensagem(m4.env, cfgCob(m4.api), msg({ ...ELI, texto: 'meu numero caiu' }));
  conf(m4.api.BOT_IA_CAIU.includes(r.resposta), 'marcou alguem ha mais de 3 min: o numero caido volta a ter resposta');
  const m5 = monta({ ...MUNDO, chat: [linhaChat({ grupo: 'cob', jid: GC, de_jid: '111222333444@lid', de_nome: 'Bryan', acao: 'visto', resposta: '', chamadas: 0, msg_id: 'o1', texto: '@Bruno bom dia', ts: agoraS() - 20 })], ia: [JSON_OK] });
  r = await m5.api._botIaMensagem(m5.env, cfgCob(m5.api), msg({ ...ELI, texto: 'meu numero caiu' }));
  conf(m5.api.BOT_IA_CAIU.includes(r.resposta), 'a marcacao de OUTRA pessoa nao cala quem escreve agora');
}
{
  // A ficha colada no grupo vai pra IA so como "mandou a ficha" (o nome fora da base escapava da troca por C1).
  const ficha = 'Regina Pantoja\nCPF: 765.208.250-18\nWhatsApp: (95) 99157-2810\nRua CC-28, 108 - Uma rua depois da distribuidora\nLaura Moreira - Boa Vista/RR\nCEP: 69318-135\nTratamento: Glico Six - 4 Meses\nTotal: R$ 497,00';
  const fichaBase = 'Joselina Da Silva\nCPF: 123.456.789-01\nWhatsApp: (15) 98888-7777\nTotal: R$ 297,00';
  const ELI = { de_nome: 'Elias Santos', de_jid: '140948612857962@lid', acao: 'visto', resposta: '', chamadas: 0 };
  const m = monta({ ...MUNDO, chat: [linhaChat({ ...ELI, msg_id: 'fx', texto: ficha, ts: agoraS() - 30 }), linhaChat({ ...ELI, msg_id: 'fy', texto: fichaBase, ts: agoraS() - 20 })], ia: [JSON_OK] });
  await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho bom dia', menciona: true, marcado: true }));
  const u = m.chamadas[0].user;
  conf(/Elias Santos: \[mandou a ficha de um cliente; nome, CPF, telefone e endereço ficam de fora\]/.test(u) && !/Pantoja|Regina|CPF:|Laura|69318|99157/.test(u), 'ficha com nome fora da base: so "mandou a ficha de um cliente"');
  conf(/Elias Santos: \[mandou a ficha de C\d+;/.test(u) && !/Joselina/.test(u), 'ficha de cliente da base: "mandou a ficha de C1" (a IA ainda pode pedir a busca)');
  conf(m.api._botIaFichaCurta('Bryan: o cliente pagou o total: R$ 297') === 'Bryan: o cliente pagou o total: R$ 297', 'mensagem comum com um sinal so fica como esta');
}

// ══ 41. O BOT VIVO DE VERDADE (07/11 noite) ═════════════════════════════════════════════
titulo('41. Ve o que ele postou, nao responde toda linha, varia o tamanho, reage e nao grita junto com o marco');
{
  // A LINHA DO TEMPO (print do Bruno: "quem e o cara do momento" um minuto depois da comemoracao das 15 do Guilherme):
  // o que o bot postou entra na ordem, com a hora; a mensagem respondida nao repete.
  const t = agoraS();
  const G = '5515999990001@s.whatsapp.net';
  const chat = [
    linhaChat({ msg_id: 'lt1', de_jid: G, de_nome: 'Guilherme', texto: '+1', acao: 'respondeu', resposta: '(reagiu com 🔥)', motivo: 'festa: reação (a comemoração do marco 15 vai sair agora)', ts: t - 120 }),
    linhaChat({ msg_id: 'lt2', de_jid: '5515999990002@s.whatsapp.net', de_nome: 'Kevin', texto: '[vídeo]', acao: 'visto', resposta: '', ts: t - 90 }),
    linhaChat({ msg_id: 'lt3', de_jid: '', de_nome: 'Barbadinho', texto: 'faltam 2 pra 10 (Kevin)', acao: 'provocou', resposta: 'provocação que já vai pelo outbox', ts: t - 50 }),
  ];
  const outbox = [
    { ts: t - 100, feito_ts: t - 95, tipo: 'marco', jid: GV, texto: '🚨 SEGURA ESSE HOMI! GUILHERME CRAVOU 15 VENDAS, CARALHOOOO!', midia: JSON.stringify({ key: 'a.mp4', tipo: 'video' }) },
    { ts: t - 50, feito_ts: t - 48, tipo: 'ia_provoca', jid: GV, texto: 'urgente: o 10 do Kevin foi visto rondando o grupo' },
    { ts: t - 40, tipo: 'livre', jid: GV, texto: 'recado pendente', status: 'pend' },
  ];
  const m = monta({ ...MUNDO, chat, outbox, sorte: 0, ia: [{ json: { leitura: 'Guilherme quer ouvir que é ele', responder: true, texto: 'é tu, porra! 15 num sábado', curta: 'é tu, máquina', minima: 'é tu', reacao: '🐐', melhor: 'texto' } }] });
  const r = await m.api._botIaMensagem(m.env, cfgDe(m.api), msg({ msg_id: 'lt4', texto: 'Fala pra mim quem é o cara do momento barbadinho', menciona: true }));
  const u = m.chamadas[0].user;
  const iMais1 = u.indexOf('Guilherme: +1'), iReagiu = u.indexOf('Barbadinho reagiu com 🔥'), iMarco = u.indexOf('Barbadinho (comemoração automática, com vídeo): 🚨 SEGURA'), iProv = u.indexOf('Barbadinho (provocação automática): urgente');
  conf(iMais1 > 0 && iReagiu > iMais1 && iMarco > iReagiu && iProv > iMarco, 'as ultimas mensagens trazem o que o bot postou, na ordem: o +1, a reacao, a comemoracao com video, a provocacao');
  conf(/Kevin: \[vídeo\]/.test(u) && !/provocação que já vai pelo outbox/.test(u) && !/recado pendente/.test(u), 'midia aparece como [vídeo]; a linha "provocou" do bot_chat e o post que nao saiu ficam de fora');
  conf((u.match(/quem é o cara do momento/g) || []).length === 1, 'a mensagem respondida vai uma vez so (no fim), nao repete nas ultimas mensagens');
  conf(/Placar de hoje/.test(u) && /A pergunta é sobre quem é o destaque/.test(u) && /Te chamaram nesta mensagem/.test(u), '"quem e o cara do momento barbadinho": o nome no fim chama o bot, o placar vai e a dica do destaque tambem');
  conf(r.resposta === 'é tu, porra! 15 num sábado' && m.chat.find((x) => x.msg_id === 'lt4').motivo === 'leu: Guilherme quer ouvir que é ele', 'a resposta sai e a leitura da IA fica no motivo da linha');
}
{
  // A MARCA DA MIDIA na linha guardada; a IA sabe que veio uma foto com legenda e que nao ve a foto.
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  await m.api._botIaMensagem(m.env, cfgDe(m.api), msg({ msg_id: 'md1', texto: '', tipo: 'video' }));
  await m.api._botIaMensagem(m.env, cfgDe(m.api), msg({ msg_id: 'md2', texto: 'olha isso @Barbadinho', tipo: 'imagem', menciona: true, marcado: true }));
  conf(m.chat.find((x) => x.msg_id === 'md1').texto === '[vídeo]' && m.chat.find((x) => x.msg_id === 'md2').texto === '[foto] olha isso @Barbadinho', 'a linha guarda a marca da midia: "[vídeo]" e "[foto] legenda"');
  conf(/Mensagem de Guilherme \(\[foto\] com legenda; você não vê a mídia\): "olha isso @Barbadinho"/.test(m.chamadas[0].user), 'a IA sabe que veio uma foto com legenda e que nao ve a foto');
  conf(m.api._botIaComMidia('', 'audio') === '[áudio]' && m.api._botIaComMidia('oi', 'texto') === 'oi', 'texto puro fica como esta');
}
{
  const { api } = monta({});
  const sim = ['kkkkkkkkkkkkkkk boa', 'KKKKKKKKKKKKK', 'pprt kkkk', 'Exatamente', 'bora', 'Vamooooo', 'Kakakakakaka', 'Show mano', '🔥🔥', 'Lá ele', 'tmj', 'valeu'];
  const nao = ['+1', 'kkk os cara é foda', 'KKKKKKKK Q VIDEO BOM', 'Boaaaa porra', 'ta on ai?', 'Já tamo vendo', 'meu numero caiu', 'vai tomando por de dentro', 'Fala pra mim quem é o cara do momento barbadinho'];
  conf(sim.every((x) => api._botIaSoRiso(x)), 'risada e ok solto: ' + sim.filter((x) => !api._botIaSoRiso(x)).join(' | '));
  conf(nao.every((x) => !api._botIaSoRiso(x)), 'o resto nao e so risada: ' + nao.filter((x) => api._botIaSoRiso(x)).join(' | '));
}
{
  // CADENCIA: risada solta na conversa nem chama a IA; quem marcou continua com resposta.
  const G = '5515999990001@s.whatsapp.net';
  const conversa = [linhaChat({ msg_id: 'cd1', de_jid: G, de_nome: 'Guilherme', texto: '@Barbadinho fala', resposta: 'faaala', ts: agoraS() - 60 })];
  const m = monta({ ...MUNDO, chat: conversa, ia: [JSON_OK] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'kkkkkkkkkkkkkkk boa' }));
  conf(r.acao === 'visto' && r.motivo === 'só risada ou ok' && m.chamadas.length === 0, 'risada solta na conversa: visto, sem gastar IA');
  const r2 = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'kkkkk @Barbadinho', menciona: true, marcado: true }));
  conf(r2.acao === 'respondeu' && m.chamadas.length === 1, 'risada marcando o bot: responde');
  // SEQUENCIA (16h11 do dia 07: seis respostas seguidas pro Guilherme): ja respondeu ele 2 vezes em 4 min
  const duas = [linhaChat({ msg_id: 'sq1', de_jid: G, de_nome: 'Guilherme', resposta: 'tomei bonito', ts: agoraS() - 150 }), linhaChat({ msg_id: 'sq2', de_jid: G, de_nome: 'Guilherme', resposta: 'covarde nada', ts: agoraS() - 70 })];
  const m2 = monta({ ...MUNDO, chat: duas, ia: [JSON_OK] });
  const r3 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: 'vai tomando por de dentro' }));
  conf(r3.acao === 'visto' && /já respondi essa pessoa 2 vezes/.test(r3.motivo) && m2.chamadas.length === 0, 'terceira resposta seguida pra mesma pessoa, sem citar o bot: fica de fora, sem IA');
  const r4 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: 'KKKKKKKKK Q VIDEO BOM' }), { reage: true, sorte: 0.2 });
  conf(r4.acao === 'respondeu' && r4.reacao === '😂' && r4.resposta === '(reagiu com 😂)' && m2.chamadas.length === 0, 'na sequencia, com risada e o bot do PC novo: as vezes vira uma reacao 😂 (sem IA)');
  const r5 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: 'KKKKKKKKK Q VIDEO BOM' }), { reage: true, sorte: 0.8 });
  conf(r5.acao === 'visto' && !r5.reacao && m2.chamadas.length === 0, '...e as vezes nao: fica so de fora');
  const r6 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: 'a proxima ta vindo?' }));
  conf(r6.acao === 'respondeu' && m2.chamadas.length === 1, 'pergunta na sequencia: a IA decide');
  const r7 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: 'ooow barbadinho vc é covarde', menciona: true, marcado: false }));
  conf(r7.acao === 'respondeu' && m2.chamadas.length === 2, 'falou o nome do bot na sequencia: a IA decide (a cadencia so vale pra quem nem citou o bot)');
  const m3 = monta({ ...MUNDO, chat: duas, ia: [JSON_OK] });
  const r8 = await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: 'meu numero caiu' }));
  conf(r8.acao === 'respondeu' && m3.api.BOT_IA_CAIU.includes(r8.resposta) && m3.chamadas.length === 0, 'numero caido nunca cai na cadencia (a frase curta sai)');
  const m4 = monta({ ...MUNDO, chat: [duas[0], { ...duas[1], resposta: '(reagiu com 😂)' }], ia: [JSON_OK] });
  const r9 = await m4.api._botIaResponder(m4.env, cfgDe(m4.api), pacote({ texto: 'vai tomando por de dentro' }));
  conf(r9.acao === 'respondeu' && m4.chamadas.length === 1, 'reacao nao conta como resposta seguida');
}
{
  // A FORMA: o sorteio pesa a escolha da IA, nao repete o tamanho das duas ultimas nem frase que ja saiu.
  const { api } = monta({});
  const j = { texto: 'tô tomando e comemorando, traz mais que essa tá paga', curta: 'tomei bonito', minima: 'tomei', reacao: '😂', melhor: 'minima' };
  const c = (o) => ({ sorte: 0, reage: true, pergunta: false, marcado: false, festa: false, hist: [], ditas: [], ...o });
  conf(api._botIaEscolheForma(j, c({ sorte: 0 })).forma === 'texto' && api._botIaEscolheForma(j, c({ sorte: 0.9999 })).forma === 'reacao', 'o sorteio cobre as quatro formas (do texto a reacao)');
  conf(api._botIaEscolheForma(j, c({ sorte: 0.5 })).forma === 'minima', 'a forma que a IA acha melhor pesa mais');
  conf(api._botIaEscolheForma(j, c({ sorte: 0.9999, reage: false })).forma !== 'reacao' && api._botIaEscolheForma(j, c({ sorte: 0.9999, pergunta: true })).forma !== 'reacao', 'sem o bot do PC novo ou em pergunta: nunca reacao');
  conf(api._botIaEscolheForma(j, c({ sorte: 0.5, hist: ['aí sim', 'é tu'] })).forma !== 'minima', 'as duas ultimas foram curtinhas: a terceira nao e');
  conf(api._botIaEscolheForma(j, c({ sorte: 0, ditas: ['tô tomando e comemorando, traz mais que essa tá paga'] })).forma !== 'texto', 'frase que ja saiu no grupo nao repete');
  conf(api._botIaEscolheForma({ texto: 'só o texto' }, c({ sorte: 0.9 })).texto === 'só o texto', 'IA que mandou so o texto: vai o texto');
  conf(api._botIaRepete('ouvi dizer que quem empaca no 8 dorme de meia', ['ouvi dizer que quem fica no 9 o dia todo dorme de meia kkkkk']) && !api._botIaRepete('urgente: o 10 foi visto rondando o grupo', ['ouvi dizer que quem fica no 9 dorme de meia']), 'repeticao: 4 palavras seguidas iguais ("ouvi dizer que quem")');
  conf(api._botIaVersaoOk('1.7.0', '1.7.0') && api._botIaVersaoOk('1.10.0', '1.7.0') && !api._botIaVersaoOk('1.6.1', '1.7.0') && !api._botIaVersaoOk('', '1.7.0'), 'versao do bot do PC: 1.7.0 ou mais nova reage');
  conf(api._botIaReacaoOk('🔥') === '🔥' && api._botIaReacaoOk('lol') === '' && api._botIaReacaoOk('🍆') === '', 'reacao so da lista');
}
{
  // O TEMPERO: risada nao em toda resposta e com tamanho de gente; emoji no maximo 1 (festa, 2).
  const { api } = monta({});
  const tp = api._botIaTempero;
  conf(tp('tô tomando e comemorando kkkkk traz mais', { hist: ['te tirando nada kkkkk'], sorte: 0.3 }) === 'tô tomando e comemorando, traz mais', 'a ultima resposta riu: esta vai sem kkkk (no meio vira virgula)');
  conf(tp('kkkkk pode deixar', { hist: ['boa kkkk', 'aí sim kkkkk'], sorte: 0.3 }) === 'pode deixar', 'duas das tres ultimas com risada: tira (no comeco some)');
  const v = tp('esse vídeo é patrimônio kkkkk', { hist: ['aí sim'], sorte: 0.3 });
  conf(/^esse vídeo é patrimônio k{3,11}$/.test(v), 'sem risada antes: a risada fica, com tamanho de gente (' + v + ')');
  conf(/^cinema puro K{3,11}$/.test(tp('cinema puro kkkkk', { hist: [], msg: 'KKKKKKKK Q VIDEO BOM', sorte: 0.3 })), 'quem falou riu em caixa alta: a risada vem em caixa alta');
  conf(/^k{3,11}$/.test(tp('kkkkk', { hist: ['kkkk', 'boa kkkk'], sorte: 0.3 })), 'resposta que e so risada fica (so muda o tamanho)');
  conf(tp('ciúme de bot é nova 😂', { hist: ['tô vendo 👀'], sorte: 0.3 }) === 'ciúme de bot é nova', 'a ultima teve emoji: esta vai sem');
  conf(tp('ISSO AÍ PORRAAAA 🔥🔥🚀 tu é foda', { festa: true, hist: ['boa 🔥'], sorte: 0.3 }) === 'ISSO AÍ PORRAAAA 🔥🔥 tu é foda', 'na festa ate 2 emojis, mesmo depois de uma com emoji');
  conf(tp('é tu 🐐🔥', { hist: [], sorte: 0.3 }) === 'é tu 🐐', 'fora da festa, no maximo 1 emoji');
  const lens = new Set([0.05, 0.2, 0.4, 0.6, 0.8, 0.95].map((s) => (tp('boa kkkkk', { hist: [], sorte: s }).match(/k+$/) || [''])[0].length));
  conf(lens.size >= 3, 'o tamanho da risada muda de uma resposta pra outra (' + [...lens].join(', ') + ' k)');
}
{
  // A FORMA no caminho inteiro.
  const G = '5515999990001@s.whatsapp.net';
  const JF = { json: { leitura: 'Guilherme devolvendo a provocação', responder: true, texto: 'tô tomando e comemorando, essa doeu', curta: 'tomei bonito', minima: 'tomei', reacao: '😂', melhor: 'minima' } };
  const m = monta({ ...MUNDO, ia: [JF] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'Ent vai tomando @Barbadinho', menciona: true, marcado: true }), { sorte: 0.7 });
  conf(r.resposta === 'tomei' && r.viu.some((v) => /^forma: minima \(as outras: texto: "tô tomando/.test(v)) && /leu: Guilherme devolvendo a provocação/.test(r.motivo), 'zoeira: sai a forma sorteada (a minima, que a IA achou melhor), as outras ficam no "viu" e a leitura no motivo');
  const conversa = [linhaChat({ msg_id: 'fm0', de_jid: G, de_nome: 'Guilherme', resposta: 'faaala', ts: agoraS() - 60 })];
  const m2 = monta({ ...MUNDO, chat: conversa, ia: [JF] });
  const r2 = await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ texto: 'Ent vai tomando' }), { sorte: 0.9999, reage: true });
  conf(r2.reacao === '😂' && r2.resposta === '(reagiu com 😂)' && r2.acao === 'respondeu', 'com o bot do PC novo, a forma pode ser a reacao');
  const m3 = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: '2 hj! faltam 3 pro 5 kkkkk', curta: '2 hj', minima: '2', melhor: 'minima' } }] });
  const r3 = await m3.api._botIaResponder(m3.env, cfgDe(m3.api), pacote({ texto: '@Barbadinho quantas eu tenho hj?', menciona: true, marcado: true }), { sorte: 0.7 });
  conf(r3.resposta === '2 hj! faltam 3 pro 5 kkkkk' && !r3.viu.some((v) => /^forma:/.test(v)), 'pergunta de numero (dado): sai o texto inteiro, sem sortear forma nem mexer na risada');
}
{
  // A REACAO chega ao agente so se ele for 1.7.0+: resposta vazia + `reacao`; a linha guarda "(reagiu com ...)".
  const G = '5515999990001@s.whatsapp.net';
  const JR = { json: { responder: true, texto: 'tomei bonito, essa doeu', curta: 'tomei bonito', minima: 'tomei', reacao: '😂', melhor: 'reacao' } };
  const conversa = [linhaChat({ msg_id: 'rc0', de_jid: G, de_nome: 'Guilherme', resposta: 'faaala', ts: agoraS() - 60 })];
  const m = monta({ ...MUNDO, chat: conversa, ia: [JR], sorte: 0.9999 });
  const a = await m.api._botIaMensagem(m.env, cfgDe(m.api), msg({ msg_id: 'rc1', texto: 'Ent vai tomando' }), { versao: '1.7.0' });
  const row = m.chat.find((x) => x.msg_id === 'rc1');
  conf(a.resposta === '' && a.reacao === '😂' && row.acao === 'pendente' && row.resposta === '(reagiu com 😂)', 'bot do PC 1.7.0: a reacao vai no campo `reacao` (resposta vazia) e a linha guarda "(reagiu com 😂)"');
  await m.api._botIaAck(m.env, { chat_id: a.chat_id, ok: true, msg_id: 'R1' });
  conf(row.acao === 'respondeu', 'o agente confirma a reacao como qualquer resposta');
  const m2 = monta({ ...MUNDO, chat: conversa, ia: [JR], sorte: 0.9999 });
  const b2 = await m2.api._botIaMensagem(m2.env, cfgDe(m2.api), msg({ msg_id: 'rc2', texto: 'Ent vai tomando' }), { versao: '1.6.1' });
  conf(b2.reacao === '' && !!b2.resposta && !/reagiu/.test(b2.resposta), 'bot do PC antigo (1.6.1): nunca reacao, vai uma resposta de texto (' + b2.resposta + ')');
}
{
  // FESTA NO MARCO (16h11 do dia 07): "+1" que bate um marco ainda nao comemorado: a comemoracao automatica faz a festa.
  const base = mundoProv(10, 1);
  const cfg = monta({}).api._botNormaliza(base.cfg, null);
  const m = monta({ ...base, ia: [JSON_OK] });
  const r = await m.api._botIaResponder(m.env, cfg, pacote({ texto: '+1' }), { reage: true });
  conf(r.reacao === '🔥' && r.resposta === '(reagiu com 🔥)' && r.motivo === 'festa: reação (a comemoração do marco 10 vai sair agora)' && m.chamadas.length === 0, '"+1" que bate o 10 ainda nao comemorado: reage 🔥, sem IA, e a comemoracao automatica faz a festa');
  const m2 = monta({ ...base, ia: [JSON_OK] });
  const r2 = await m2.api._botIaResponder(m2.env, cfg, pacote({ texto: '+1' }));
  conf(r2.acao === 'calado' && r2.motivo === 'festa: a comemoração do marco 10 vai sair agora' && m2.chamadas.length === 0, 'sem o bot do PC novo e sem marcar: fica calado (a comemoracao vem sozinha)');
  const m3 = monta({ ...base, ia: [JSON_OK] });
  await m3.api._botIaResponder(m3.env, cfg, pacote({ texto: '@Barbadinho +1 fechei as 10', menciona: true, marcado: true }));
  conf(/A comemoração automática do marco 10 de Guilherme vai sair no grupo agora: não grite junto/.test(m3.chamadas[0].user), 'marcou o bot: a IA responde curtinho, sabendo que a comemoracao vem');
  const feito10 = { ...base.config, ['bot_marcos_' + DIA]: JSON.stringify({ [GUI]: 10 }) };
  const m4 = monta({ ...base, config: feito10, outbox: [{ ts: agoraS() - 60, tipo: 'marco', jid: GV, texto: '🔥 Guilherme CRAVOU 10 VENDAS!' }], ia: [JSON_OK] });
  const r4 = await m4.api._botIaResponder(m4.env, cfg, pacote({ texto: '+1' }), { reage: true });
  conf(r4.reacao === '🔥' && /acabou de sair/.test(r4.motivo) && m4.chamadas.length === 0, 'a comemoracao do marco saiu ha 1 min: reage, nao repete o grito');
  const m5 = monta({ ...base, config: feito10, outbox: [{ ts: agoraS() - 900, tipo: 'marco', jid: GV, texto: '🔥 Guilherme CRAVOU 10 VENDAS!' }], ia: [JSON_OK] });
  const r5 = await m5.api._botIaResponder(m5.env, cfg, pacote({ texto: '+1' }), { reage: true, sorte: 0 });
  conf(r5.acao === 'respondeu' && m5.api.BOT_IA_FESTA_REACOES.includes(r5.reacao) && r5.motivo === 'festa: reação' && m5.chamadas.length === 0, 'comemoracao do marco de 15 min atras: a reacao normal da festa, sem IA (09/11)');
  const m6 = monta({ ...base, ia: [JSON_OK] });
  const r6 = await m6.api._botIaResponder(m6.env, cfg, pacote({ texto: 'fechei mais uma pro time, vamo que vamo porra' }), { reage: true });
  conf(r6.reacao === '🔥' && m6.chamadas.length === 0, 'venda dita com muitas palavras ("fechei mais uma pro time...") tambem e o +1 do marco: reage 🔥');
  // FESTA SEM VENDA: grito solto sem venda nova de quem gritou nem entra (sem IA)
  const m7 = monta({ ...MUNDO, ia: [JSON_OK] });
  const r7 = await m7.api._botIaResponder(m7.env, cfgDe(m7.api), pacote({ texto: 'Boraa rapeizes', de_jid: '5515999990009@s.whatsapp.net', de_fone: '5515999990009', de_nome: 'Bruno' }));
  conf(r7.acao === 'calado' && /^festa: sem venda nova/.test(r7.motivo) && m7.chamadas.length === 0, '"Boraa rapeizes" (Bruno, 22h37, sem venda): nem chama a IA');
  const m8 = monta({ ...mundoProv(3, 3), ia: [JSON_OK] });
  const r8 = await m8.api._botIaResponder(m8.env, monta({}).api._botNormaliza(mundoProv(3, 3).cfg, null), pacote({ texto: 'BOOORA PORRA' }), { reage: true });
  conf(r8.acao === 'respondeu' && m8.api.BOT_IA_FESTA_REACOES.includes(r8.reacao) && m8.chamadas.length === 0, 'grito do Guilherme com venda de 3 min atras: a festa entra (com a reacao)');
  const m9 = monta({ ...mundoProv(3, 40), ia: [JSON_OK] });
  const r9 = await m9.api._botIaResponder(m9.env, monta({}).api._botNormaliza(mundoProv(3, 40).cfg, null), pacote({ texto: 'BOOORA PORRA' }));
  conf(r9.acao === 'calado' && m9.chamadas.length === 0, 'grito do Guilherme com a ultima venda de 40 min atras: nao e festa');
}
{
  const { api } = monta({});
  const re = api.BOT_IA_QUEM_MANDA_RE;
  const sim = ['Fala pra mim quem é o cara do momento barbadinho', 'quem tá voando hj?', 'quem manda nessa porra', 'quem é o brabo?', 'o cara do sabadão'];
  const nao = ['o cara não paga', 'esse cara é foda', 'Vc é foda', 'como vc ta hj?', 'quem me cria é o Bruno', 'Vc é lula ou bolsonaro barbadinho?'];
  conf(sim.every((x) => re.test(x)) && nao.every((x) => !re.test(x)), '"quem e o cara" e assunto de numero; "o cara nao paga" nao: ' + sim.filter((x) => !re.test(x)).concat(nao.filter((x) => re.test(x))).join(' | '));
}
{
  // CITOU A COMEMORACAO DO BOT ("milagre nada"): e com ele, mesmo sem pergunta (o resumo continua precisando de pergunta).
  const texto = '🍾 PODE CHAMAR O PADRE, PORQUE ISSO AQUI É MILAGRE! Guilherme chegou nas 5 vendas!';
  const m = monta({ ...MUNDO, outbox: [{ ts: agoraS() - 60, tipo: 'marco', jid: GV, texto }], ia: [JSON_OK] });
  const r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'Milagre nada, trabalhando pra krl aqui rapaz kkkk', responde: true, citado: texto }));
  conf(r.acao === 'respondeu' && /Responderam uma mensagem sua sem te marcar \(a citada, que pode ser uma resposta, uma comemoração ou uma provocação sua\)/.test(m.chamadas[0].user), 'citou a comemoracao do bot sem pergunta: e com ele (a IA responde a isso)');
  const base = mundoProv(5, 1);
  const cfg5 = monta({}).api._botNormaliza(base.cfg, null);
  const ob = [{ ts: agoraS() - 30, tipo: 'marco', jid: GV, texto }];
  const m2 = monta({ ...base, config: { ...base.config, ['bot_marcos_' + DIA]: JSON.stringify({ [GUI]: 5 }) }, outbox: ob, ia: [JSON_OK] });
  const r2 = await m2.api._botIaResponder(m2.env, cfg5, pacote({ texto: 'Milagre nada, trabalhando pra krl aqui rapaz kkkk' }), { reage: true });
  conf(r2.acao === 'visto' && !r2.reacao && !r2.resposta && m2.chamadas.length === 0, 'sem citar, logo depois da comemoracao: "trabalhando pra krl aqui" nao e grito de festa nem e com o bot, fica quieto (09/11; citando, a IA responde)');
  const m3 = monta({ ...base, config: { ...base.config, ['bot_marcos_' + DIA]: JSON.stringify({ [GUI]: 5 }) }, outbox: ob, ia: [JSON_OK] });
  const r3 = await m3.api._botIaResponder(m3.env, cfg5, pacote({ texto: 'ISSO AÍ PORRAAA' }), { reage: true });
  conf(r3.reacao === '🔥' && m3.chamadas.length === 0, 'o grito curto logo depois da comemoracao automatica dele: reage 🔥, nao grita de novo');
}
{
  // A PROVOCACAO NAO REPETE A DO DIA ("dorme de meia" saiu duas vezes no dia 07).
  const prov = 'ouvi dizer que quem fica no 9 empacado até 16h dorme de meia kkkkk 👀 só falta +1 pro 10, Guilherme, chama!';
  const velha = [{ ts: agoraS() - 7200, tipo: 'ia_provoca', jid: GV, texto: prov }];
  const m = monta({ ...mundoProv(13, 50, { ia: [{ json: { texto: 'ouvi dizer que quem empaca no 13 a essa hora dorme de meia 👀 faltam 2 pro 15', outra: 'urgente: o 15 do Guilherme foi visto rondando o grupo, faltam 2. chama!' } }] }), outbox: velha });
  await tick(m);
  const nova = m.fila.filter((x) => x.tipo === 'ia_provoca' && x.status === 'pend');
  conf(nova.length === 1 && /^urgente: o 15 do Guilherme/.test(nova[0].texto) && /Provocações que você já mandou hoje/.test(m.chamadas[0].user), 'a provocacao do dia vai como "nao repita" e sai a opcao que nao repete');
  const m2 = monta({ ...mundoProv(13, 50, { ia: [{ json: { texto: 'ouvi dizer que quem empaca no 13 dorme de meia', outra: 'ouvi dizer que quem fica no 13 dorme de meia' } }] }), outbox: velha });
  await tick(m2);
  const nova2 = m2.fila.filter((x) => x.tipo === 'ia_provoca' && x.status === 'pend');
  conf(nova2.length === 1 && /faltam 2 pro 15/.test(nova2[0].texto) && !/dorme de meia/.test(nova2[0].texto), 'as duas opcoes repetem: sai a frase reserva');
  const m3 = monta({ ...mundoProv(13, 50), outbox: [{ ts: agoraS() - 120, tipo: 'marco', jid: GV, texto: 'Kevin bateu 10' }] });
  await tick(m3);
  conf(m3.fila.filter((x) => x.status === 'pend').length === 0 && m3.chamadas.length === 0, 'o bot postou no grupo ha 2 min: a provocacao espera (nao emenda um post no outro)');
}
{
  // O TOM E O PROMPT NOVOS.
  const { api } = monta({});
  const n = api._botIaNormaliza({ tom: { vend: api.BOT_IA_TOM_VELHOS[4], cob: api.BOT_IA_TOM_VELHOS[5] } });
  conf(n.tom.vend === api.BOT_IA_TOM_VEND && n.tom.cob === api.BOT_IA_TOM_COB && !/kkkkk/.test(api.BOT_IA_TOM_VEND + api.BOT_IA_TOM_COB) && /cada resposta de um tamanho/.test(api.BOT_IA_TOM_VEND), 'o jeito gravado igual ao padrao de 06/11 (kkkkk e 1 a 3 emojis) vira o novo sozinho');
  const sys = api._botIaSistema(api._botNormaliza(CFG_RAW, null), 'vend');
  conf(/COMO SER VIVO/.test(sys) && /"leitura"/.test(sys) && /"melhor"/.test(sys) && /Risada é tempero, não assinatura/.test(sys) && !/kkkkk \(5 a 8 k\)/.test(sys), 'o prompt novo: entender antes, as quatro formas, risada de tempero');
  conf(/"Quem é o cara do momento\?"/.test(sys) && /"q vídeo bom"/.test(sys) && /Frase que serviria pra qualquer mensagem/.test(sys), 'o prompt fala do que o bot postou, do "quem e o cara" e proibe a frase generica');
  const ex = api.BOT_IA_EXEMPLOS.vend.concat(api.BOT_IA_EXEMPLOS.cob);
  const comKkkkk = ex.filter((e) => /k{5,}/i.test(e.split('->')[1] || ''));
  conf(comKkkkk.length <= 4, 'poucos exemplos com risada (' + comKkkkk.length + ')');
  conf(/tu, e de jato/.test(sys) && /essa eu mereci/.test(sys) && !/dorme de meia/.test(sys) && !/Q VIDEO BOM|Ent vai tomando|cara do momento barbadinho/.test(sys), 'os exemplos novos sao parecidos com o dia 07, nunca os casos de verdade com a resposta pronta (o modelo copiava)');
}
{
  // PRIVACIDADE: o recado que o bot postou com nome de cliente vai trocado (C1) pra IA, como as mensagens do grupo.
  const m = monta({ ...MUNDO, outbox: [{ ts: agoraS() - 60, tipo: 'livre', jid: GV, texto: 'galera, a Joselina Da Silva pagou' }], ia: [JSON_OK] });
  await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: '@Barbadinho viu isso?', menciona: true, marcado: true }));
  conf(!/joselina/i.test(m.chamadas[0].user) && /Barbadinho \(recado da direção pelo bot\): galera, a C\d+ pagou/.test(m.chamadas[0].user), 'o que o bot postou passa pela mesma troca de nome de cliente (C1)');
}

// ══ 42. O BOT SO FALA QUANDO E COM ELE (09/11) ═════════════════════════════════════════
titulo('42. So fala quando e com ele: numero caido curto, festa so com reacao, problema sem chamar fica de fora');
{
  const { api } = monta({});
  const t = (s) => api._botIaNumeroCaiu(api._botIaTextoProblema(s));
  const sim = [['2248 caiu', '2248'], ['0026 caiu', '0026'], ['Meu número 1859 caiu', '1859'], ['meu whats caiu', ''], ['o meu tambem caiu', ''], ['tomei ban', ''], ['tô bloqueado', ''], ['pediu QR de novo', ''], ['(15) 98888-0001 caiu', '0001'], ['caiu a conexão do 2248', '2248'], ['caiu meu 3996, tava cheio de lead', '3996']];
  const nao = ['CAIU O PIX DA C1 KRL', 'caiu a ficha', 'a internet caiu aqui', 'o app caiu', 'caiu um lead no 2248', 'Lead bloqueou', 'Hoje ta muito devagar, as campanhas deram uma travada', 'mas mesmo assim ta dando erro :(', '+55 16 99609-4932 - caiu a ligação', 'caiu 1500 no pix', 'caiu de novo', 'o número do cliente caiu na caixa postal', 'meu pix caiu'];
  conf(sim.every(([s, fim]) => t(s).caiu && t(s).fim === fim), 'numero caido (com o final certo): ' + sim.filter(([s, fim]) => !(t(s).caiu && t(s).fim === fim)).map((x) => x[0]).join(' | '));
  conf(nao.every((s) => !t(s).caiu), 'nao e numero caido: ' + nao.filter((s) => t(s).caiu).join(' | '));
  conf(api.BOT_IA_CAIU.every((x) => x.length <= 32 && /Bruno/.test(x) && !/interruptor|roleta|kkk/i.test(x)) && api.BOT_IA_CAIU_SEM_AVISO.every((x) => /marca o Bruno/.test(x) && !/avisei|avisado|sabendo/.test(x)), 'as frases: curtas, falam do Bruno, sem interruptor; a de sem aviso nunca diz que avisou');
}
{
  // O dia 09 no grupo dos vendedores, pela rota do agente: o 2248 e o 0026 do Kevin, 6 min de diferenca.
  const KEV = { de_jid: '5515977770001@s.whatsapp.net', de_fone: '5515977770001', de_nome: 'Kevin' };
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  const cfg = cfgDe(m.api);
  const antes = RELOGIO.agora;
  let r = await m.api._botIaMensagem(m.env, cfg, msg({ ...KEV, texto: '2248 caiu' }), { versao: '1.7.0' });
  const a = r.resposta;
  conf(m.api.BOT_IA_CAIU.includes(a) && m.chamadas.length === 0, '"2248 caiu": uma frase curta da lista (' + a + '), sem IA');
  conf(m.pushes.length === 2 && /^Barbadinho: número caiu$/.test(m.pushes[0].payload.title) && /^Kevin Marques no grupo GlicoSix - Vendedores: "2248 caiu" · número \(final 2248\) caiu$/.test(m.pushes[0].payload.body), 'e o aviso de verdade pra direcao, com o final do numero');
  const row = m.chat[m.chat.length - 1];
  conf(row.acao === 'pendente' && row.motivo === 'número caiu (final 2248): avisei a direção' && row.alerta === 1 && row.quem_id === KEVIN, 'a linha guarda o motivo, o alerta e quem e');
  await m.api._botIaAck(m.env, { chat_id: r.chat_id, ok: true, msg_id: 'K1' });
  RELOGIO.agora += 6 * 60000;
  r = await m.api._botIaMensagem(m.env, cfg, msg({ ...KEV, texto: '0026 caiu', ts: agoraS() }), { versao: '1.7.0' });
  conf(m.api.BOT_IA_CAIU.includes(r.resposta) && r.resposta !== a && m.pushes.length === 4 && m.chamadas.length === 0, 'o "0026 caiu" 6 min depois: OUTRA frase (' + r.resposta + ') e outro aviso (cada numero tem o seu)');
  await m.api._botIaAck(m.env, { chat_id: r.chat_id, ok: true, msg_id: 'K2' });
  r = await m.api._botIaMensagem(m.env, cfg, msg({ ...KEV, texto: 'caiu o 0026 mesmo, pqp', ts: agoraS() }), { versao: '1.7.0' });
  conf(r.resposta === '' && r.reacao === '🫡' && m.pushes.length === 4, 'o mesmo numero de novo em seguida: so uma reacao, sem aviso repetido');
  r = await m.api._botIaMensagem(m.env, cfg, msg({ ...KEV, texto: 'pqp hoje ta osso', ts: agoraS() }), { versao: '1.7.0' });
  conf(r.resposta === '' && !r.reacao && m.chamadas.length === 0, 'a frase do numero caido nao abre conversa: o desabafo seguinte fica de fora');
  const m2 = monta({ ...MUNDO, ia: [JSON_OK] });
  const r2 = await m2.api._botIaMensagem(m2.env, cfg, msg({ ...KEV, texto: '2248 caiu' }), { versao: '1.6.1' });
  conf(m2.api.BOT_IA_CAIU.includes(r2.resposta) && !r2.reacao, 'o bot do PC antigo (sem reacao) tambem recebe a frase curta');
  RELOGIO.agora = antes;
}
{
  // Problema que ninguem perguntou pro bot fica de fora (no dia 09 era o Bruno e o Bryan falando com a direcao).
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  const BRU = { de_jid: '777777777777@lid', de_fone: '5515999990009', de_nome: 'Bruno' };
  let r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ ...BRU, texto: 'Hoje ta muito devagar, as campanhas deram uma travada' }));
  conf(r.acao === 'visto' && r.motivo === 'não era pra mim' && m.chamadas.length === 0 && m.pushes.length === 0, '"as campanhas deram uma travada" (Bruno, sem chamar o bot): visto, sem IA e sem aviso');
  const cfgCob = cfgDe(m.api, { ia: { ...CFG_RAW.ia, so_marcado: { vend: false, cob: false } } });
  const BRY = { jid: GC, de_jid: '111222333444@lid', de_fone: '', de_nome: 'Bryan' };
  for (const texto of ['+55 11 96847-3130 / ~Ismael Nunes - Não consigo acessar o checkout dele para enviar o boleto', 'mas mesmo assim ta dando erro :(', 'não to conseguindo acessar o checkout do Ismael Nunes']) {
    r = await m.api._botIaResponder(m.env, cfgCob, { ...pacote({ ...BRY, texto }), grupo: 'cob' });
    conf(r.acao === 'visto' && m.chamadas.length === 0 && m.pushes.length === 0, 'cobranca, sem chamar o bot: "' + texto.slice(0, 42) + '..." fica de fora');
  }
  r = await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ ...BRU, texto: '2248 caiu' }));
  conf(r.acao === 'visto' && /quem contou é da direção/.test(r.motivo) && m.pushes.length === 0, 'numero caido contado pela direcao: fica de fora (e quem resolve)');
  const sys = m.api._botIaSistema(cfgDe(m.api), 'vend');
  conf(/Sem te chamarem você não entra, nem em problema nem em festa/.test(sys) && !/só entre se for problema que os dados resolvem/.test(sys), 'o prompt: sem te chamarem, nao entra');
  // O aviso pela IA nunca vai pra quem escreveu (o Bruno ganhou push da propria mensagem no dia 09).
  const m2 = monta({ ...MUNDO, ia: [{ json: { responder: true, texto: 'putz, ja avisei o Heynan', avisar_direcao: 'campanhas travadas' } }] });
  await m2.api._botIaResponder(m2.env, cfgDe(m2.api), pacote({ ...BRU, texto: '@Barbadinho as campanhas travaram?', menciona: true, marcado: true }));
  conf(m2.pushes.length === 1 && m2.pushes[0].userId === 'dir', 'o aviso da IA vai pro outro da direcao, nunca pra quem escreveu');
}
{
  // 09:17 do dia 09: "vendi pra esse mentiroso ai kkkkk" sem chamar o bot ganhou texto e abriu conversa. Agora: so reacao,
  // e a pergunta seguinte, sem o nome do bot, fica de fora; depois de chamar o bot pelo nome, a conversa vale.
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  const cfg = cfgDe(m.api);
  let r = await m.api._botIaMensagem(m.env, cfg, msg({ texto: 'vendi pra esse mentiroso ai kkkkk' }), { versao: '1.7.0' });
  conf(r.resposta === '' && m.api.BOT_IA_FESTA_REACOES.includes(r.reacao) && m.chamadas.length === 0, 'venda comemorada sem chamar o bot: so a reacao ' + r.reacao + ', sem texto e sem IA');
  await m.api._botIaAck(m.env, { chat_id: r.chat_id, ok: true, msg_id: 'G1' });
  r = await m.api._botIaMensagem(m.env, cfg, msg({ texto: 'Quem é o cara do momento?' }), { versao: '1.7.0' });
  conf(r.resposta === '' && !r.reacao && m.chamadas.length === 0, '"Quem é o cara do momento?" logo depois, sem o nome do bot: fica de fora');
  r = await m.api._botIaMensagem(m.env, cfg, msg({ texto: 'Bom dia barbadinho u.u', menciona: true }), { versao: '1.7.0' });
  conf(!!r.resposta && m.chamadas.length === 1, '"Bom dia barbadinho" (chamou pelo nome): a IA responde');
  await m.api._botIaAck(m.env, { chat_id: r.chat_id, ok: true, msg_id: 'G2' });
  r = await m.api._botIaMensagem(m.env, cfg, msg({ texto: 'Quem é o cara do momento?' }), { versao: '1.7.0' });
  conf(m.chamadas.length === 2 && /Essa pessoa estava conversando com você agora há pouco/.test(m.chamadas[1].user), 'agora sim e conversa: a mesma pergunta vai pra IA decidir');
  r = await m.api._botIaMensagem(m.env, cfg, msg({ texto: 'Milagre nada, trabalhando pra krl aqui rapaz kkkk', de_jid: '5515977770001@s.whatsapp.net', de_fone: '5515977770001', de_nome: 'Kevin' }), { versao: '1.7.0' });
  conf(r.resposta === '' && !r.reacao && m.chamadas.length === 2, 'frase comprida com palavrao, sem venda e sem chamar o bot: nem reacao');
}
{
  // Falar DELE (16:01 do dia 09, "Barbadinho ta viajando ja, vou ver aqui"): e com ele, a IA responde curto.
  const m = monta({ ...MUNDO, ia: [JSON_OK] });
  await m.api._botIaResponder(m.env, cfgDe(m.api), pacote({ texto: 'kkkk o barbadinho ta viajando hj', menciona: true, marcado: false }));
  conf(/se estão falando com você ou de você/.test(m.chamadas[0].user) && /responda curto/.test(m.chamadas[0].user), 'o nome no meio da frase: falar dele tambem e com ele (a IA decide, curto)');
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

// ══ 43. O BARBADINHO DA COBRANCA (10/11/2026) ══════════════════════════════════════════
// Pedido do Bruno olhando o grupo dos cobradores: "preciso que o Barbadinho consiga ajudar mais os cobradores (...)
// puxar algum lead e dar alguns detalhes um pouco melhor". Os casos sao os de verdade do grupo de 06 a 10/11: o
// Francisco com o telefone digitado errado, o paraguaio, o Daniel esperando aprovacao, a lista de prioridade, o
// checkout que nao abria.
titulo('43. A cobranca: telefone parecido, onde o pedido aparece, a lista, o link e as acoes');
const hb = (d, hm) => ms('2026-11-' + d + 'T' + hm + ':00-03:00');
const COB_TAGS = [{ id: 'tg_parc', name: 'Pagamento Parcial' }, { id: 'tg_dev', name: 'Devolução' }, { id: 'tg_ctt', name: 'Em Contato' }];
const COB_LEADS = [
  { id: 9001, nome: 'Francisco Valdimir Pereira Sousa', wa: '(11) 99521-0837', cpf: '37758853072', cidade: 'São Paulo', uf: 'SP', col: 'Cobrança', at: KEVIN, cob: BRYAN, vl: 497, agend: '2026-11-06T09:00', ship: 'DELIVERED', ship_ts: hb('04', '10:00'), track: '888031031052563', link: 'https://checkout.payt.com.br/f227862e', fonte: 'paylog', five_id: 'PL-ORDEF8VYS', ts: hb('01', '10:00'), comments: [{ who: BRYAN, tx: 'Chamei o lead, aguardando resposta. tel 11 98888-7777', time: '04/11 20:55' }] },
  { id: 9002, nome: 'Francisco Martins dos Santos Junior', wa: '(93) 98402-0826', cidade: 'Santarém', uf: 'PA', col: 'Entregues', at: GUI, cob: BRYAN, vl: 297, ship_ts: hb('03', '10:00'), ts: hb('01', '09:00') },
  { id: 9003, nome: 'Francisco Duarte de Souza', wa: '(11) 97595-0459', cidade: 'São Paulo', uf: 'SP', col: 'Pagos', spg: 'Pago', at: KEVIN, cob: BRYAN, vl: 497, pago_ts: hb('05', '10:00'), ts: hb('01', '08:00') },
  { id: 9004, nome: 'Braulio Valensuela', wa: '(59) 95973-3638', cidade: 'Bela Vista', uf: 'MS', col: 'Entregues', at: GUI, cob: BRYAN, vl: 497, ts: hb('01', '07:00') },
  { id: 9005, nome: 'Daniel De Souza Firme', wa: '(31) 97131-4360', cidade: 'Belo Horizonte', uf: 'MG', col: 'A Enviar', orig: 'Manual', at: GUI, cob: BRYAN, vl: 497, agend: '2026-11-20T12:00', ts: hb('04', '15:00') },
  { id: 9006, nome: 'Raimundo Nascimento', wa: '(91) 98111-0001', cidade: 'Belém', uf: 'PA', col: 'Retirada', at: GUI, cob: BRYAN, vl: 497, agend: '2026-11-03T09:00', hist: [{ from: 'Enviado', to: 'Retirar nos Correios', time: '01/11 10:00', who: 'five' }], ts: hb('01', '06:00') },
  { id: 9007, nome: 'Lazaro Andrade', wa: '(62) 98111-0002', cidade: 'Goiânia', uf: 'GO', col: 'Entregues', at: KEVIN, cob: BRYAN, vl: 497, agend: '2026-11-04T10:00', ts: hb('01', '05:00') },
  { id: 9008, nome: 'Marco Antonio Pereira', wa: '(27) 98111-0003', cidade: 'Vitória', uf: 'ES', col: 'Entregues', at: KEVIN, cob: BRYAN, vl: 497, agend: '2026-11-02T08:00', tags: ['tg_parc'], ts: hb('01', '04:00') },
  { id: 9009, nome: 'Manoel Bezerra Da Silva', wa: '(85) 98111-0004', cidade: 'Fortaleza', uf: 'CE', col: 'Entregues', at: GUI, cob: BRYAN, vl: 497, agend: '2026-11-05T14:00', ts: hb('01', '03:00') },
  { id: 9010, nome: 'Tereza Barbosa Inácio', wa: '(81) 98111-0005', cidade: 'Recife', uf: 'PE', col: 'Entregues', at: GUI, cob: BRYAN, vl: 497, ship_ts: hb('02', '10:00'), ts: hb('01', '02:00') },
  { id: 9011, nome: 'Lenice de Souza Soares', wa: '(71) 98111-0006', cidade: 'Salvador', uf: 'BA', col: 'Entregues', at: GUI, cob: BRYAN, vl: 197, ship_ts: hb('03', '10:00'), ts: hb('01', '01:00') },
  { id: 9012, nome: 'Joaquim Pereira de Souza', wa: '(15) 99111-2222', cidade: 'Sorocaba', uf: 'SP', col: 'Entregues', at: GUI, cob: BRYAN, vl: 497, agend: '2026-11-07T09:00', ts: hb('01', '00:00') },
  { id: 9013, nome: 'Maria Daura Souza', wa: '(48) 98111-0007', cidade: 'Florianópolis', uf: 'SC', col: 'Saiu para Entrega', at: GUI, cob: BRYAN, vl: 497, agend: '2026-11-03T12:00', hist: [{ from: 'Enviado', to: 'Saiu para Entrega', time: '05/11 08:00', who: 'five' }], ts: hb('01', '00:30') },
  { id: 9014, nome: 'Carlos Pereira Lima', wa: '(11) 98111-0008', cidade: 'Campinas', uf: 'SP', col: 'Entregues', at: GUI, cob: HAYNAN, vl: 297, agend: '2026-11-04T09:00', ts: hb('01', '00:40') },
];
// O cliente da 9012 escreveu hoje 10:30 num numero do Bryan e ninguem respondeu (o `contato` do quadro do app).
const COB_CONV = { '91112222': { in: Math.floor(hb('05', '10:30') / 1000), out: Math.floor(hb('04', '18:00') / 1000), n8: '99990002' } };
// Uma copia nova por cenario: a gravacao de mentira mexe no pedido (o telefone trocado, a anotacao)
const cobMundo = () => ({ ...MUNDO, leads: JSON.parse(JSON.stringify(COB_LEADS)), tags: COB_TAGS, conversas: COB_CONV });
const doBryan = (texto, extra) => ({ ...pacote({ jid: GC, de_jid: '111222333444@lid', de_fone: '5515999990002', de_nome: 'Bryan', texto, menciona: true, ...(extra || {}) }), grupo: 'cob' });
const doBruno = (texto, extra) => ({ ...pacote({ jid: GC, de_jid: '5515999990009@s.whatsapp.net', de_fone: '5515999990009', de_nome: 'Bruno', texto, menciona: true, ...(extra || {}) }), grupo: 'cob' });
const OFERTA = 'o telefone do cadastro termina em 0837 e o que vc mandou em 8373. quer que eu troque o do pedido pelo que vc mandou? responde *sim*';
{
  const { api } = monta({});
  conf(api._botIaFoneParecido('+55 11 95210-8373', '(11) 99521-0837') && !api._botIaFoneParecido('(11) 95210-8373', '(21) 91234-5678') && !api._botIaFoneParecido('(11) 95210-8373', '11 5210-8373') && !api._botIaFoneParecido('19600-000', '(19) 96000-0000'), 'telefone parecido: o do Francisco (um 9 a mais e o 3 do fim perdido) e; numero qualquer, o mesmo numero sem o nono digito e CEP nao');
  conf(api._botIaFoneFora('(59) 95973-3638') && api._botIaFoneFora('+595 973 363 838') && !api._botIaFoneFora('(11) 95210-8373') && !api._botIaFoneFora('+55 82 9399-5560'), 'numero de fora do Brasil: DDD que nao existe ou codigo de pais que nao e 55');
  const tipo = (t) => api._botIaListaTipo(api._botIaNorm(t));
  conf(tipo('barbadinho, você consegue me auxiliar em qual lead devo dar prioridade máxima?') === 'prioridade' && tipo('consegue me enviar em uma lista com nomes em qual devo dar prioridade?') === 'prioridade', 'pedido de lista do Bryan em 06/11: prioridade');
  conf(tipo('quantos clientes tenho que cobrar hoje?') === '' && tipo('de quem é o lead Daniel?') === '' && tipo('quem é o cara do momento?') === '' && tipo('quais os nomes dos cobradores?') === '', 'pergunta de numero, de dono, o cara do momento e os nomes do time nao sao lista');
  conf(tipo('qual a ordem que eu cobro hoje?') === 'prioridade' && tipo('manda a lista') === 'prioridade', '"qual a ordem que eu cobro" e "manda a lista": a fila inteira');
  conf(tipo('retornos de hoje') === 'hoje' && tipo('os atrasados') === 'atrasados' && tipo('quem me escreveu') === 'contato' && tipo('quais estão sem retorno') === 'sem_retorno', 'o que o "e mais" ensina a pedir funciona sozinho');
  conf(tipo('quantos sao os atrasados?') === '' && tipo('o lead ficou sem retorno, o que eu faço?') === '', '"quantos" e numero (a IA responde) e "lead sem retorno" e o cliente que sumiu, nao a lista');
  {
    const f = { fila: 6, contato: [], hoje: [], proximos: [], semRetorno: [], chegando: [], pagosHoje: [], pagosOntem: [], aprovacao: 0,
      atrasados: [1, 2, 3, 4, 5, 6].map((n) => ({ l: { nome: 'Cliente ' + n, col: 'Entregues', cidade: 'Itu', uf: 'SP' }, t: ms('2026-11-0' + n + 'T09:00:00-03:00') - 10 * 86400000 })) };
    const t = api._botIaListaTexto(f, 'prioridade', { nome: 'Bryan Amorim' }, true, RELOGIO.agora);
    conf(/\ne mais 2: me pede "os atrasados" que eu mando todos\n/.test(t), 'na lista inteira, o "e mais" diz como pedir o grupo todo');
    conf(!/me pede/.test(api._botIaListaTexto(f, 'atrasados', { nome: 'Bryan Amorim' }, true, RELOGIO.agora)), 'na lista de um grupo so, nao');
  }
  conf(tipo('quais estão pra retirar na agência?') === 'retirada' && tipo('me manda os atrasados') === 'atrasados' && tipo('quem pagou hoje?') === 'pagos' && tipo('quais retornos de hoje?') === 'hoje' && tipo('quem me escreveu e eu nao respondi?') === 'contato' && tipo('quais estao sem retorno?') === 'sem_retorno', 'os tipos: retirada, atrasados, pagos, hoje, quem escreveu e sem retorno');
  const c = api._botIaConfirma;
  conf(c('sim') === 'sim' && c('Sim, pode') === 'sim' && c('pode sim barbadinho') === 'sim' && c('ok') === 'sim' && c('isso ai') === 'sim', 'sim, pode, ok, isso ai: confirmam');
  conf(c('não') === 'nao' && c('deixa quieto') === 'nao' && c('nao precisa') === 'nao', 'nao, deixa quieto, nao precisa: recusam');
  conf(c('pode deixar') === '' && c('sim, mas amanha eu vejo isso') === '' && c('simbora galera') === '', '"pode deixar", frase comprida e outra palavra: nem sim nem nao');
  conf(api._botIaMascaraNum('cliente pagou 2x de 250, tel 11 98888-7777, cpf 053.334.448-46, dia 10/11/2026') === 'cliente pagou 2x de 250, tel final 7777, cpf final 4846, dia 10/11/2026', 'a anotacao que vai pro grupo: telefone e CPF so pelo final, data e valor ficam');
}
{
  // O FRANCISCO DO BRYAN (10/11): WhatsApp 11 95210-8373, cadastro (11) 99521-0837. Antes: os 4 Franciscos da fila.
  const m = monta({ ...cobMundo(), ia: [{ json: { leitura: 'quer o pedido na dash dele', responder: true, texto: 'C1 já é da sua fila, em cobrança desde 04/11' } }] });
  const cfg = cfgDe(m.api);
  const r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho +55 11 95210-8373 | ~Francisco joga ele na minha dash por favor'));
  const u = m.chamadas[0].user;
  conf(/Pedido encontrado:\n#9001 C\d+ \(São Paulo\/SP\)/.test(u) && !/#9002|#9003/.test(u), 'telefone digitado errado no cadastro: acha o pedido certo (telefone parecido + nome), sem os outros Franciscos');
  conf(/Telefone: o do cadastro é DIFERENTE do da mensagem \(no cadastro termina em 0837, na mensagem em 8373\)/.test(u), 'a IA sabe que o telefone do cadastro esta diferente (so pelos finais)');
  conf(/Vendedor \(quem vendeu e cadastrou\): Kevin Marques\. Cobrador \(dono da cobrança\): Bryan Amorim\./.test(u), 'vendedor e cobrador em linhas de papel separado');
  conf(/Na dash de Bryan: está na fila de cobrança dele \(Faltam cobrar e Agenda\)/.test(u), 'onde aparece: na fila de cobranca dele');
  conf(/Ele pediu pra jogar esse pedido pra dash dele: o pedido JÁ É da fila dele/.test(u), '"joga na minha dash" de pedido que ja e dele: a IA sabe que ja e');
  conf(/Link de pagamento: tem \(se pedirem, o sistema manda/.test(u) && /Anotações no pedido: 1/.test(u) && !/Chamei o lead/.test(u), 'a IA sabe que tem link e anotacao, sem ver o texto da anotacao');
  conf(!/99521|95210|37758853072|98888|payt/.test(u), 'nenhum telefone inteiro, CPF ou link vai pra IA');
  conf(r.acao === 'respondeu' && /^Francisco Valdimir Pereira Sousa já é da sua fila/.test(r.resposta), 'a resposta da IA sai com o nome do cliente de volta');
  conf(r.resposta.indexOf('_última anotação (Bryan, 04/11 20:55): Chamei o lead, aguardando resposta. tel final 7777_') > 0, 'embaixo, a ultima anotacao do pedido (telefone so pelo final)');
  conf(r.resposta.indexOf(OFERTA) > 0, 'e a oferta de trocar o telefone do cadastro');
  const chave = m.api._botIaPendChave(GC, '111222333444@lid');
  const pend = JSON.parse(m.cfgdb[chave] || 'null');
  conf(!!pend && pend.tipo === 'fone' && pend.lead === '9001' && pend.para_txt === '(11) 95210-8373' && pend.de_txt === '(11) 99521-0837' && pend.quem === BRYAN, 'a oferta fica guardada esperando o sim');
  const r2 = await m.api._botIaResponder(m.env, cfg, doBryan('sim', { menciona: false }));
  conf(r2.acao === 'respondeu' && /^pronto, troquei: o pedido de Francisco Valdimir Pereira Sousa agora tá com o telefone final 8373/.test(r2.resposta), '"sim" solto (sem marcar): troca e confirma');
  const g = m.gravacoes[0] || { patch: {} };
  conf(m.gravacoes.length === 1 && g.id === '9001' && g.quem === BRYAN && g.patch.wa === '(11) 95210-8373' && /trocado de \(11\) 99521-0837 pra \(11\) 95210-8373, a pedido de Bryan no grupo/.test((g.patch.comment_add || {}).tx || ''), 'a gravacao vai pela rota da dash como o Bryan, com uma anotacao do que mudou');
  conf(!m.cfgdb[chave], 'e a oferta morre: uma resposta so');
  const r3 = await m.api._botIaResponder(m.env, cfg, doBryan('sim', { menciona: false }));
  conf(r3.acao === 'visto' && m.gravacoes.length === 1 && m.chamadas.length === 1, 'outro "sim" depois: nada, e o sim nunca gasta IA');
}
{
  // O "sim" que vem depois de a pessoa falar de outra coisa nao vale; citando a oferta vale.
  const m = monta({ ...cobMundo(), ia: [{ json: { responder: true, texto: 'C1 tá na sua fila' } }] });
  const cfg = cfgDe(m.api);
  await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho +55 11 95210-8373 | ~Francisco pagou?'));
  m.chat.push({ id: 900, ts: agoraS() + 5, dia: DIA, grupo: 'cob', jid: GC, msg_id: 'outra', de_jid: '111222333444@lid', de_nome: 'Bryan', texto: 'heynan tu ta on?', acao: 'visto' });
  const r = await m.api._botIaResponder(m.env, cfg, doBryan('sim', { menciona: false }));
  conf(r.acao === 'visto' && !m.gravacoes.length, 'o "sim" depois de falar de outra coisa nao troca nada');
  const r2 = await m.api._botIaResponder(m.env, cfg, doBryan('sim', { menciona: false, responde: true, citado: OFERTA }));
  conf(r2.acao === 'respondeu' && m.gravacoes.length === 1, 'citando a oferta, vale');
}
{
  const m = monta({ ...cobMundo(), ia: [{ json: { responder: true, texto: 'C1 tá na sua fila' } }] });
  const cfg = cfgDe(m.api);
  await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho +55 11 95210-8373 | ~Francisco pagou?'));
  const r = await m.api._botIaResponder(m.env, cfg, doBryan('não, deixa', { menciona: false }));
  conf(r.acao === 'respondeu' && r.resposta === 'beleza, deixei como tá' && !m.gravacoes.length && !m.cfgdb[m.api._botIaPendChave(GC, '111222333444@lid')], '"nao": nada muda e a oferta morre');
}
{
  // No grupo de teste a oferta e o "sim" funcionam, mas nada e gravado.
  const m = monta({ ...cobMundo(), ia: [{ json: { responder: true, texto: 'C1 tá na sua fila' } }] });
  const cfg = cfgDe(m.api);
  const quemT = { id: BRYAN, nome: 'Bryan Amorim', role: 'cobrador', chefe: false };
  await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho +55 11 95210-8373 | ~Francisco pagou?'), { grupoTeste: true, quem: quemT });
  const r = await m.api._botIaResponder(m.env, cfg, doBryan('sim', { menciona: false }), { grupoTeste: true, quem: quemT });
  conf(/^\(grupo de teste: não mexi em nada\)/.test(r.resposta) && !m.gravacoes.length, 'grupo de teste: diz o que faria e nao grava');
  const t = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho +55 11 95210-8373 | ~Francisco pagou?'), { teste: true, quem: quemT });
  conf(t.resposta.indexOf('responde *sim*') < 0, 'no Pergunte ao bot a troca nem e oferecida');
}
{
  // O paraguaio e o Daniel (esperando aprovacao).
  const m = monta({ ...cobMundo(), ia: [JSON_OK] });
  const cfg = cfgDe(m.api);
  const r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho nao consigo falar com Braulio Valensuela (59) 95973-3638, ele nao aparece na minha dash'));
  conf(/Telefone: número de FORA do Brasil no cadastro \(o "DDD" 59 não existe aqui\)/.test(m.chamadas[0].user) && r.resposta.indexOf('responde *sim*') < 0, 'numero de fora do Brasil: a IA sabe e nao tem oferta de troca');
  await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho de quem é o lead +55 31 7131-4360 | ~Daniel De Souza Firme'));
  const u = m.chamadas[1].user;
  conf(/Vendedor \(quem vendeu e cadastrou\): Guilherme\. Cobrador \(dono da cobrança\): Bryan Amorim\./.test(u) && /Na dash de Bryan: NÃO aparece em dash nenhuma \(nem no Kanban nem no app\) até a direção aprovar/.test(u), 'o Daniel: o cobrador e o proprio Bryan, e nao aparece porque espera a aprovacao (o "do Guilherme" de 09/11)');
  conf(/"de quem é" o pedido quer dizer de qual COBRADOR é a fila/.test(m.chamadas[1].system), 'e a regra do "de quem e" esta no prompt');
  await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho +55 11 91234-0000 ~Francisco joga ele na minha dash'));
  conf(/NENHUM pedido tem o telefone da mensagem\. Pelo NOME há estes candidatos/.test(m.chamadas[2].user), 'telefone que nao bate com nada e nome com varios: a IA sabe que o telefone nao bateu (nada de "desse numero")');
}
{
  // A LISTA (06/11, "consegue me enviar em uma lista com nomes em qual devo dar prioridade?").
  const m = monta({ ...cobMundo(), ia: [JSON_OK] });
  const cfg = cfgDe(m.api);
  const r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho consegue me enviar em uma lista com nomes em qual devo dar prioridade?'));
  const t = r.resposta;
  conf(r.acao === 'respondeu' && m.chamadas.length === 0 && /sem IA/.test(r.motivo), 'a lista sai do codigo, sem IA');
  conf(t.indexOf('*Sua fila agora:* 10 em cobrança · 1 te escreveu sem resposta · 3 com retorno vencido · 1 pra hoje · 4 sem retorno') === 0, 'o resumo da fila no topo');
  const pos = ['Joaquim Pereira de Souza · Sorocaba/SP · te escreveu hoje 10:30', 'Marco Antonio Pereira · Vitória/ES · retorno era 02/11 08:00', 'Raimundo Nascimento · Belém/PA · retorno era 03/11 09:00 · na agência', 'Lazaro Andrade · Goiânia/GO · retorno era ontem 10:00', 'Manoel Bezerra Da Silva · Fortaleza/CE · retorno 14:00', 'Braulio Valensuela · Bela Vista/MS · entregue 01/11 · sem retorno', 'Tereza Barbosa Inácio · Recife/PE · entregue 02/11 · sem retorno', 'Francisco Martins dos Santos Junior · Santarém/PA · entregue 03/11 · sem retorno', 'Lenice de Souza Soares · Salvador/BA · entregue 03/11 · sem retorno'].map((x) => t.indexOf(x));
  conf(pos.every((p, i) => p > 0 && (i === 0 || p > pos[i - 1])), 'na ordem da Agenda: quem escreveu, retorno vencido (o mais velho primeiro), hoje, sem retorno (o maior valor primeiro)');
  conf(!/R\$/.test(t) && !/Daniel|Carlos Pereira|Francisco Duarte|Maria Daura/.test(t), 'sem valor, sem o pedido esperando aprovacao, sem o pago, sem o do Haynan e sem o que esta na rua');
  let x = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho quais estão pra retirar?'));
  conf(x.resposta === '*Na agência pra retirar (o mais antigo primeiro)*\n1. Raimundo Nascimento · Belém/PA · na agência desde 01/11 · retorno 03/11 09:00', 'lista dos que estao na agencia');
  x = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho quem pagou hoje?'));
  conf(/^\*Pagaram hoje\*\n1\. Francisco Duarte de Souza · São Paulo\/SP · pagou 10:00$/.test(x.resposta), 'quem pagou hoje');
  x = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho me manda os atrasados'));
  conf(/^\*Sua fila: 3 retornos vencidos\* \(o mais antigo primeiro\)/.test(x.resposta), 'so os retornos vencidos');
  x = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho manda a lista do Haynan'));
  conf(/^a fila de Haynan é com ele/.test(x.resposta), 'cobrador nao ve a lista do outro');
  x = await m.api._botIaResponder(m.env, cfg, doBruno('@Barbadinho manda a lista da cobrança'));
  conf(/^\*Cobrança agora\*\nBryan: 10 em cobrança · 1 escreveu sem resposta · 3 com retorno vencido · 1 pra hoje · 4 sem retorno\nHaynan: 1 em cobrança · 1 com retorno vencido/.test(x.resposta) && !/Joaquim/.test(x.resposta), 'a direcao sem dizer de quem: o retrato de cada cobrador, sem nome de cliente');
  x = await m.api._botIaResponder(m.env, cfg, doBruno('@Barbadinho manda a lista do Bryan'));
  conf(/^\*Fila de Bryan agora:\* 10 em cobrança · 1 escreveu sem resposta/.test(x.resposta), 'a direcao com o nome: a lista daquele cobrador');
  conf(m.chamadas.length === 0, 'nenhuma lista gastou IA');
  await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho quantos faltam cobrar hj?'));
  conf(m.chamadas.length === 1 && /Agenda de Bryan agora: 10 pedidos na fila de cobrança, 3 com retorno vencido, 1 com retorno pra hoje, 4 sem retorno marcado, 1 a caminho \(1 saindo pra entrega\), 1 esperando aprovação da direção/.test(m.chamadas[0].user), 'pergunta de numero nao e lista: vai pra IA, com a agenda dele nos dados');
}
{
  // O LINK (09/11, "nao consigo acessar o checkout dele para enviar o boleto").
  const m = monta({ ...cobMundo(), ia: [{ json: { responder: true, texto: 'C1 tá em cobrança, falta R$ 497' } }] });
  const cfg = cfgDe(m.api);
  let r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho nao consigo acessar o checkout do Francisco Valdimir pra mandar o boleto'));
  conf(r.resposta.indexOf('Link de pagamento de Francisco Valdimir Pereira Sousa: https://sellwave.com.br/checkout/cod1') > 0, 'o link de pagamento curto vai embaixo da resposta');
  conf(m.curtos.length === 1 && m.curtos[0].lead_id === '9001' && /checkout\.payt\.com\.br\/f227862e\?/.test(m.curtos[0].url) && /utm_content=ped9001/.test(m.curtos[0].url) && m.curtos[0].created_by === 'bot:' + BRYAN, 'o link curto aponta pro checkout do pedido (o mesmo da ficha, com o utm do pedido)');
  conf(!/37758853072|document=|full_name/.test(r.resposta) && !/payt|https?:/.test(m.chamadas[0].user), 'nada do cliente no grupo e nenhum link pra IA');
  r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho manda o link de pagamento do Francisco Valdimir de novo'));
  conf(m.curtos.length === 1 && r.resposta.indexOf('/checkout/cod1') > 0, 'pediu de novo: o mesmo link, sem criar outro');
  r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho manda o rastreio do Francisco Valdimir'));
  conf(r.resposta.indexOf('Rastreio de Francisco Valdimir Pereira Sousa: https://glico-six.rastreio.vip/rastreio?codigo=888031031052563') > 0, 'o link do rastreio');
  r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho o Francisco Duarte pagou? manda o link'));
  conf(!/Link de pagamento/.test(r.resposta), 'pedido pago nao ganha link de pagamento');
}
{
  // ANOTAR NO PEDIDO e PASSAR DE COBRADOR (direcao).
  const m = monta({ ...cobMundo(), ia: [JSON_OK] });
  const cfg = cfgDe(m.api);
  let r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho anota no pedido do Francisco Valdimir: vai pagar sexta no pix'));
  conf(r.acao === 'respondeu' && r.resposta === 'anotado no pedido de Francisco Valdimir Pereira Sousa' && m.chamadas.length === 0, 'anota no pedido: responde sem IA');
  conf(m.gravacoes.length === 1 && m.gravacoes[0].id === '9001' && m.gravacoes[0].quem === BRYAN && m.gravacoes[0].patch.comment_add.tx === 'vai pagar sexta no pix' && Object.keys(m.gravacoes[0].patch).length === 1, 'grava so a anotacao, como o Bryan');
  r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho anota no pedido do Francisco: liguei e nao atendeu'));
  conf(/^achei mais de um com esse nome/.test(r.resposta) && m.gravacoes.length === 1, 'nome que bate em varios: pergunta, nao anota');
  r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho anota no pedido do Francisco Valdimir: teste'), { teste: true, quem: { id: BRYAN, nome: 'Bryan Amorim', role: 'cobrador' } });
  conf(/^\(teste: não anotei nada\)/.test(r.resposta) && m.gravacoes.length === 1, 'no Pergunte ao bot nao grava');
  r = await m.api._botIaResponder(m.env, cfg, doBruno('@Barbadinho passa o pedido do Francisco Valdimir pro Haynan'));
  conf(r.resposta === 'feito: o pedido de Francisco Valdimir Pereira Sousa (São Paulo/SP) agora é da fila de Haynan' && m.gravacoes.length === 2 && m.gravacoes[1].patch.cob === HAYNAN && m.gravacoes[1].quem === 'socio_x4dy6d', 'a direcao passa o pedido de cobrador, pela rota da dash');
  r = await m.api._botIaResponder(m.env, cfg, doBruno('@Barbadinho passa o Francisco Valdimir pro Haynan'));
  conf(/já é da fila de Haynan/.test(r.resposta) && m.gravacoes.length === 2, 'de novo: ja e dele, nada gravado');
  const antes = m.chamadas.length;
  r = await m.api._botIaResponder(m.env, cfg, doBryan('@Barbadinho passa o Lazaro Andrade pro Haynan'));
  conf(m.gravacoes.length === 2 && m.chamadas.length === antes + 1, 'cobrador pedindo pra passar: nao grava, vai pra IA (so a direcao troca o cobrador)');
  r = await m.api._botIaResponder(m.env, cfg, doBruno('@Barbadinho passa o link pro cliente do Lazaro'));
  conf(m.gravacoes.length === 2, '"passa o link pro cliente": nao e troca de cobrador');
}
{
  // O cobrador pedindo pra jogar na dash dele um pedido que nao e dele: a IA explica e a direcao e avisada.
  const leads = COB_LEADS.map((l) => (l.id === 9007 ? { ...l, cob: HAYNAN } : l));
  const m = monta({ ...cobMundo(), leads, ia: [JSON_OK] });
  const cfg = cfgDe(m.api);
  await m.api._botIaResponder(m.env, cfg, { ...doBryan('@Barbadinho joga o Lazaro Andrade na minha dash'), grupo: 'cob' });
  conf(/Pedido\(s\) com esse nome ou número existem, mas são de outra pessoa: C\d+ \(fila de Haynan\)/.test(m.chamadas[0].user), 'pedido de outro cobrador: a IA diz de quem e');
}

console.log('\n' + (falhas.length ? 'FALHOU' : 'OK') + ': ' + ok + ' de ' + (ok + falhas.length) + ' conferencias');
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
