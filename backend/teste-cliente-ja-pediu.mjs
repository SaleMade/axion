// TESTE DO "ESSE CLIENTE JA PEDIU?" (20/11/2026, caso do Jose Lourenco: vendido pelo Guilherme em
// 05/11 e de novo pelo Kevin em 17/11, com outro CPF, e o aviso ficou mudo porque so olhava CPF).
// Recorta do worker.js as funcoes DE VERDADE (_cliPedidos, _cliCasa, handleMesmoCpf,
// handlePedidoAlertas...) e roda o SQL delas num SQLite de memoria com o mesmo formato do D1
// (dashboard_state com o blob, leads_arquivo, users). Se alguem mexer na regra, quebra aqui.
//   node teste-cliente-ja-pediu.mjs
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function recorta(nome) {
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
// uma linha `const X = ...;` (ou um objeto que fecha com `};`)
function constante(nome) {
  const i = src.indexOf('\nconst ' + nome + ' =');
  if (i < 0) throw new Error('nao achei a constante ' + nome);
  const linha = src.slice(i + 1, src.indexOf('\n', i + 1));
  if (linha.trimEnd().endsWith('{')) return src.slice(i + 1, src.indexOf('\n};', i) + 3);
  return linha;
}
const CODIGO = [
  constante('_BOT_COL_ALIAS'), constante('_botColDe'), constante('_ehPago'),
  constante('_CLI_RUIM'), constante('_CLI_COL_LBL'), constante('_cliFone'), constante('_cliF8'),
  constante('_cliDdd'), constante('_cliCpf'),
  recorta('_cliTipo'), recorta('_cliColLbl'), recorta('_cliPedidos'), recorta('_cliCasa'),
  recorta('_cliNomes'), recorta('handleMesmoCpf'), recorta('handlePedidoAlertas'),
].join('\n');

// ── o mundo de mentira ────────────────────────────────────────────────────────
function monta({ leads = [], arquivo = [], users = [] }) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE dashboard_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL, version INTEGER)');
  db.exec('CREATE TABLE leads_arquivo (id TEXT PRIMARY KEY, json TEXT NOT NULL, col TEXT, ts INTEGER)');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO dashboard_state VALUES (1, ?, 1)').run(JSON.stringify({ _arq: arquivo.length, leads, regras: {} }));
  for (const l of arquivo) db.prepare('INSERT INTO leads_arquivo VALUES (?, ?, ?, 0)').run(String(l.id), JSON.stringify(l), l.col || '');
  for (const u of users) db.prepare('INSERT INTO users VALUES (?, ?)').run(u.id, u.name);
  return {
    DB: {
      prepare(sql) {
        const st = { _a: [], bind(...a) { st._a = a; return st; }, async all() { return { results: db.prepare(sql).all(...st._a) }; } };
        return st;
      },
    },
  };
}
const json = (o) => ({ _json: o });
const err = (m, s) => ({ _err: m, s });
const aflDe = (u) => (u && u.afiliado_id) ? String(u.afiliado_id) : null;
const isDirector = (u) => u && u.role === 'diretor';
const noMundoAfiliado = (u) => !isDirector(u) && !!aflDe(u);
const afiliadoSemVinculo = (u) => u && u.role === 'afiliado' && !aflDe(u);
let USER = { id: 'atendente_kevin', role: 'atendente' };
const authUser = async () => USER;
const F = new Function('json', 'err', 'aflDe', 'noMundoAfiliado', 'afiliadoSemVinculo', 'authUser',
  CODIGO + '\nreturn { _cliFone, _cliF8, _cliDdd, _cliTipo, handleMesmoCpf, handlePedidoAlertas };')(
  json, err, aflDe, noMundoAfiliado, afiliadoSemVinculo, authUser);

let ok = 0, falhou = 0;
const confere = (nome, cond, extra) => { if (cond) ok++; else { falhou++; console.log('FALHOU:', nome, extra === undefined ? '' : JSON.stringify(extra)); } };
const busca = async (env, q) => (await F.handleMesmoCpf({ url: 'https://x/api/pedido/mesmo-cpf?' + new URLSearchParams(q) }, env))._json;
const alertas = async (env, itens) => (await F.handlePedidoAlertas({ url: 'https://x/api/pedido/alertas', json: async () => ({ itens }) }, env))._json;

// CPFs de mentira (validos no formato, nao de gente)
const CPF_A = '11144477735', CPF_B = '52998224725', CPF_C = '39053344705';
const USERS = [{ id: 'atendente_gui', name: 'Guilherme' }, { id: 'atendente_kevin', name: 'Kevin Marques' }];

// 1) O CASO DO JOSE: pedido do Guilherme na agencia, Kevin cadastra com OUTRO CPF e o mesmo WhatsApp
{
  const env = monta({ users: USERS, leads: [
    { id: 1793878897411, nome: 'Jose Teste', cpf: '111.444.777-35', wa: '(98) 98462-0000', col: 'Retirada', aceito: true, at: 'atendente_gui', vl: 497, cidade: 'Itapecuru Mirim', uf: 'MA', data: '05/11' },
  ] });
  const r = await busca(env, { cpf: CPF_B, fone: '98984620000' });
  confere('caso Jose: achou pelo WhatsApp', r.achados.length === 1, r);
  const a = r.achados[0] || {};
  confere('caso Jose: em andamento', a.tipo === 'andamento', a);
  confere('caso Jose: por whatsapp', a.por === 'whatsapp', a);
  confere('caso Jose: etapa com o rotulo do Kanban', a.col_lbl === 'Retirar nos Correios', a);
  confere('caso Jose: nome de quem vendeu', a.at_nome === 'Guilherme', a);
  confere('caso Jose: data do pedido', a.data === '05/11', a);
  // o mesmo cliente escrito do jeito do WhatsApp (55, sem o nono digito)
  const r2 = await busca(env, { fone: '559884620000' });
  confere('sem o nono e com 55 casa igual', r2.achados.length === 1, r2);
  // DDD diferente com os mesmos 8 ultimos: outra pessoa
  const r3 = await busca(env, { fone: '11984620000' });
  confere('DDD diferente nao casa', r3.achados.length === 0, r3);
  // so 8 digitos (sem DDD): casa pelos 8, DDD desconhecido nao derruba
  const r4 = await busca(env, { fone: '84620000' });
  confere('sem DDD casa pelos 8 ultimos', r4.achados.length === 1, r4);
  // o proprio pedido nao conta (exceto)
  const r5 = await busca(env, { fone: '98984620000', exceto: '1793878897411' });
  confere('exceto tira o proprio', r5.achados.length === 0, r5);
  // nada pra procurar
  const r6 = await busca(env, { cpf: '123', fone: '1234' });
  confere('CPF e telefone curtos nao procuram', r6.achados.length === 0, r6);
}

// 2) CPF igual, telefone diferente (o caminho antigo continua valendo) e os dois juntos
{
  const env = monta({ users: USERS, leads: [
    { id: 1, nome: 'Maria', cpf: CPF_A, wa: '85999990001', col: 'Enviado', aceito: true, at: 'atendente_gui' },
    { id: 2, nome: 'Maria', cpf: CPF_A, wa: '85999990002', col: 'Entregue', aceito: true, at: 'atendente_gui' },
  ] });
  const r = await busca(env, { cpf: CPF_A, fone: '85999990002' });
  confere('CPF igual acha os dois', r.achados.length === 2, r);
  const p1 = r.achados.find((x) => x.id === '1') || {}, p2 = r.achados.find((x) => x.id === '2') || {};
  confere('so CPF = por cpf', p1.por === 'cpf', p1);
  confere('CPF e fone = os dois', p2.por === 'cpf e whatsapp', p2);
  confere('Entregue vira Cobranca (apelido resolvido)', p2.col_lbl === 'Cobrança' && p2.tipo === 'andamento', p2);
  confere('Enviado (apelido) vira Enviado', p1.col_lbl === 'Enviado', p1);
}

// 3) Historico: roubo e frustrado (tambem no arquivo), pago, devolvido depois de pago, cancelado
{
  const env = monta({ users: USERS,
    leads: [
      { id: 10, nome: 'C', cpf: CPF_C, wa: '21988887777', col: 'Pagos', spg: 'Pago', at: 'atendente_gui' },
      { id: 11, nome: 'C', cpf: CPF_C, wa: '21988887777', col: 'Entregues', spg: 'Pago', at: 'atendente_gui' },
      { id: 12, nome: 'C', cpf: CPF_C, wa: '21988887777', col: 'Cancelado', at: 'atendente_gui' },
    ],
    arquivo: [
      { id: 13, nome: 'C', cpf: CPF_C, wa: '21988887777', col: 'Roubos', at: 'atendente_gui' },
      { id: 14, nome: 'C', cpf: '', wa: '+55 (21) 98888-7777', col: 'Frustrado', at: 'atendente_kevin' },
      { id: 15, nome: 'C', cpf: CPF_C, wa: '', col: 'Devolvido', spg: 'Pago', at: 'atendente_gui', ts: 1795000000 },
    ] });
  const r = await busca(env, { cpf: CPF_C, fone: '21988887777' });
  const t = Object.fromEntries(r.achados.map((x) => [x.id, x.tipo]));
  confere('acha os 6 (quadro + arquivo)', r.achados.length === 6, r.achados.map((x) => x.id));
  confere('Pagos = pago', t['10'] === 'pago', t);
  confere('entregue com spg Pago = pago', t['11'] === 'pago', t);
  confere('Cancelado = cancelado', t['12'] === 'cancelado', t);
  confere('Roubos no arquivo = ruim', t['13'] === 'ruim', t);
  confere('Frustrado (apelido), so pelo fone com +55 = ruim', t['14'] === 'ruim', t);
  confere('devolvido depois de pago = ruim', t['15'] === 'ruim', t);
  confere('arquivado marcado', (r.achados.find((x) => x.id === '13') || {}).arquivado === true, r.achados);
  confere('mais novo primeiro', r.achados[0].id === '15', r.achados.map((x) => x.id));
}

// 4) Mundo do afiliado: a casa nao ve o pedido do afiliado e o afiliado nao ve o da casa
{
  const env = monta({ users: USERS, leads: [
    { id: 20, nome: 'D', cpf: CPF_A, wa: '31977776666', col: 'Enviados', at: 'atendente_gui' },
    { id: 21, nome: 'D', cpf: CPF_A, wa: '31977776666', col: 'Enviados', at: 'atendente_x', afl: 'afl_1' },
  ] });
  USER = { id: 'atendente_kevin', role: 'atendente' };
  const r = await busca(env, { fone: '31977776666' });
  confere('casa ve so o da casa', r.achados.length === 1 && r.achados[0].id === '20', r);
  USER = { id: 'afiliado_1', role: 'afiliado', afiliado_id: 'afl_1' };
  const r2 = await busca(env, { fone: '31977776666' });
  confere('afiliado ve so o dele', r2.achados.length === 1 && r2.achados[0].id === '21', r2);
  USER = { id: 'afiliado_solto', role: 'afiliado' };
  const r3 = await busca(env, { fone: '31977776666' });
  confere('afiliado sem vinculo nao ve nada', r3.achados.length === 0, r3);
  USER = { id: 'atendente_kevin', role: 'atendente' };
}

// 5) A fila das Aceitacoes
{
  const env = monta({ users: USERS,
    leads: [
      // o caso: o do Guilherme ja aceito e o do Kevin esperando aceite
      { id: 30, nome: 'Jose', cpf: CPF_A, wa: '98984620000', col: 'Retirada', aceito: true, at: 'atendente_gui', data: '05/11' },
      { id: 31, nome: 'Jose', cpf: CPF_B, wa: '98 98462-0000', col: 'A Enviar', aceito: false, at: 'atendente_kevin', data: '17/11' },
      // dois vendedores cadastraram o mesmo cliente no mesmo dia: os dois esperando aceite
      { id: 32, nome: 'Ana', cpf: '', wa: '11955554444', col: 'A Enviar', aceito: false, at: 'atendente_gui' },
      { id: 33, nome: 'Ana', cpf: '', wa: '5511955554444', col: 'A Enviar', aceito: false, at: 'atendente_kevin' },
      // cliente que so tem pedido pago antes: nao e alerta
      { id: 34, nome: 'Bia', cpf: CPF_C, wa: '41933332222', col: 'Pagos', spg: 'Pago', at: 'atendente_gui' },
      { id: 35, nome: 'Bia', cpf: CPF_C, wa: '41933332222', col: 'A Enviar', aceito: false, at: 'atendente_kevin' },
      // cliente sem nada antes
      { id: 36, nome: 'Novo', cpf: '', wa: '51922221111', col: 'A Enviar', aceito: false, at: 'atendente_kevin' },
    ],
    arquivo: [{ id: 37, nome: 'Bia', cpf: CPF_C, wa: '41933332222', col: 'Roubos', at: 'atendente_gui', data: '01/10' }],
  });
  const fila = [31, 32, 33, 35, 36].map((id) => ({ id }));
  const leads = { 31: [CPF_B, '98 98462-0000'], 32: ['', '11955554444'], 33: ['', '5511955554444'], 35: [CPF_C, '41933332222'], 36: ['', '51922221111'] };
  const r = await alertas(env, fila.map((x) => ({ id: x.id, cpf: leads[x.id][0], fone: leads[x.id][1] })));
  const A = r.alertas;
  confere('Kevin: alerta com o pedido do Guilherme', A['31'] && A['31'].length === 1 && A['31'][0].id === '30' && A['31'][0].at_nome === 'Guilherme', A['31']);
  confere('Kevin: tipo andamento e etapa', A['31'] && A['31'][0].tipo === 'andamento' && A['31'][0].col_lbl === 'Retirar nos Correios', A['31']);
  confere('mesmo dia: 32 ve o 33', A['32'] && A['32'].map((x) => x.id).join() === '33', A['32']);
  confere('mesmo dia: 33 ve o 32 (esperando aceite)', A['33'] && A['33'][0].id === '32' && A['33'][0].col_lbl === 'Esperando aceite', A['33']);
  confere('Bia: so o roubo vira alerta, o pago nao', A['35'] && A['35'].length === 1 && A['35'][0].tipo === 'ruim', A['35']);
  confere('cliente novo sem alerta', !A['36'], A['36']);
  const vazio = await alertas(env, []);
  confere('fila vazia', vazio.ok && Object.keys(vazio.alertas).length === 0, vazio);
}

// 6) telefone gravado como numero no JSON e o tel no lugar do wa
{
  const env = monta({ users: USERS, leads: [
    { id: 40, nome: 'E', cpf: '', wa: 62966665555, col: 'Enviados', at: 'atendente_gui' },
    { id: 41, nome: 'E', cpf: '', wa: '', tel: '(62) 96666-5555', col: 'Saiu para Entrega', at: 'atendente_gui' },
  ] });
  const r = await busca(env, { fone: '62966665555' });
  confere('wa numerico e tel casam', r.achados.length === 2, r);
}

// 7) as funcoes de telefone
confere('fone com 55 perde o 55', F._cliFone('5598984627666') === '98984627666');
confere('fone de 10 sem 55 fica', F._cliFone('9884627666') === '9884627666');
confere('8 ultimos iguais com e sem o nono', F._cliF8('98984627666') === F._cliF8('559884627666'));
confere('DDD so com 10 ou 11 digitos', F._cliDdd('5598984627666') === '98' && F._cliDdd('84627666') === '');

console.log(ok + ' conferencias ok' + (falhou ? ', ' + falhou + ' FALHARAM' : ''));
process.exit(falhou ? 1 : 0);
