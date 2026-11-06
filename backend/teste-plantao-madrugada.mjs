// PLANTAO DA MADRUGADA (31/10/2026).
//
// Pedido do Bruno: "as vezes acaba caindo algum lead de madrugada e acabam chegando pessoas (...)
// gostaria que a pressel sempre mandasse para algum numero que esta em algum dos vendedores, caso
// todos eles estejam com o SellWave Web fechado, para que assim a gente nao perca alguns leads".
//
// O QUE ESTE TESTE GUARDA, e todas as quatro quebram em SILENCIO (ninguem descobre olhando a tela;
// descobre vendo o faturamento de madrugada, dias depois):
//
//  1. O PLANTAO NAO PODE RELIGAR O QUE GENTE DESLIGOU. O off do sistema e o off de gente gravam a
//     MESMA coisa (off[nk] = true). A separacao e a marca `app_off`, e se ela vazar pra um numero
//     que o Bruno desligou por risco de ban, a roleta volta a mandar clique pago pra la de
//     madrugada - o pior caso possivel, porque ninguem esta olhando.
//  2. O PLANTAO E ULTIMO RECURSO. Se ele entrar junto com gente apta, a roleta passa a dividir lead
//     com numero desligado em pleno dia e o interruptor para de valer.
//  3. QUEM ABRIU O APP SAI DO PLANTAO. Sem isso, de manha o vendedor abre o app, nao liga a chave, e
//     continua recebendo - exatamente a regra de 31/10 ("quando acessar de novo, tem que ligar")
//     desfeita pela porta de tras.
//  4. A MARCA TEM QUE SOBREVIVER. Ela e apagada por clique de gente (certo) mas NAO pode ser apagada
//     por uma tela que salva a pressel inteira (errado): ai o plantao morre em silencio e a
//     madrugada seguinte volta a perder lead, sem nada ligando o defeito ao clique de "salvar".
//
// Le as funcoes DO PROPRIO worker.js (recorta e avalia) e roda contra um D1 de mentira em cima do
// node:sqlite, com o SQL de verdade. Copia da logica testaria a copia.
//
//   node teste-plantao-madrugada.mjs
//   WORKER=<caminho> node teste-plantao-madrugada.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const fonte = fs.readFileSync(process.env.WORKER || path.join(AQUI, 'worker.js'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
function funcao(nome) {
  let i = fonte.indexOf('\nfunction ' + nome + '(');
  if (i < 0) i = fonte.indexOf('\nasync function ' + nome + '(');
  if (i < 0) return null;
  const j = fonte.indexOf('{', fonte.indexOf('(', i));
  let nivel = 0;
  for (let k = j; k < fonte.length; k++) {
    const ch = fonte[k];
    if (ch === '{') nivel++;
    else if (ch === '}') { nivel--; if (nivel === 0) return fonte.slice(i + 1, k + 1); }
  }
  return null;
}
const linha = (inicio) => fonte.split('\n').find((l) => l.startsWith(inicio)) || null;

let ok = 0;
const falhas = [];
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome); }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (detalhe ? '   -> ' + detalhe : '')); }
};

const nomes = ['_cobIds', 
  '_swwebAppAbertos', '_swwebLigadosPorDono', '_swwebDesligaDonos', '_desligaAppFechado',
  '_plantaoDonos', '_plantaoLimpa',
  '_estadoLe', '_estadoGrava', '_presselAplicaNum', '_limpaMarcasDesligado', '_amanhaBR',
  '_presselNumLogEnsure', '_presselNumLog', '_emUsoIdsDe', '_foraIdsDe', '_aquecIdsDe',
  '_papelSt', '_papelPeloNomeSt', '_swwebApto', '_chipEmUso',
  '_resolvePresselSellers', '_chipVivo', '_modoRoleta', '_servConnOk', '_lastDigitsEq', '_waNumKey',
];
const blocos = nomes.map((n) => [n, funcao(n)]);
const consts = ['let _cobIdsMem = ', 'const _ehIdDeCobrador = ', 'const _chipDeCobranca = ', 'const _swwebK8 = ', 'const _PAPEIS_ST = ', 'const APP_FECHADO_FOLGA = '].map((c) => [c, linha(c)]);
const faltando = blocos.filter(([, b]) => !b).map(([n]) => n).concat(consts.filter(([, l]) => !l).map(([c]) => c));
conta('o worker tem as funcoes do plantao', !faltando.length, 'faltando: ' + faltando.join(', '));
if (faltando.length) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1); }

// ── o relogio e o banco de mentira ──────────────────────────────────────────────────────────────
let AGORA = 1793491200;   // 31/10/2026 20:00 (noite: todo mundo fechando)
Date.now = () => AGORA * 1000;
const sq = new DatabaseSync(':memory:');
const limpa = (a) => a.map((x) => (x === undefined ? null : x));
let quebraUso = false;
const DB = {
  prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = limpa(a); return st; },
      async first() { return sq.prepare(sql).get(...args) ?? null; },
      async all() { if (quebraUso && /swweb_uso/.test(sql)) throw new Error('D1 fora'); return { results: sq.prepare(sql).all(...args) }; },
      async run() { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return st;
  },
};
const env = { DB };
sq.exec('CREATE TABLE dashboard_state (id INTEGER PRIMARY KEY, data TEXT, version INTEGER, updated_at INTEGER, updated_by TEXT)');
sq.exec('CREATE TABLE swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER)');
sq.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT)');
sq.exec("INSERT INTO users VALUES ('kevin','Kevin Marques','atendente'),('gui','Guilherme','atendente'),('hay','Haynan','cobrador')");

const fabrica = new Function('_getDashData', '_brDay', '_chipAquecendo', '_numDoAquecimento', '_chipsDaPressel',
  'let _dashCache = null; let _apiMorto = new Set(); let _apiMortoEm = 0;\n'
  + consts.map(([, l]) => l).join('\n') + '\n' + blocos.map(([, b]) => b).join('\n')
  + '\nreturn { _swwebLigadosPorDono, _swwebDesligaDonos, _desligaAppFechado, _plantaoDonos, _plantaoLimpa,'
  + ' _resolvePresselSellers, _presselAplicaNum, _limpaMarcasDesligado, _emUsoIdsDe, _foraIdsDe, _aquecIdsDe, _cobIds, _chipDeCobranca };');

// chip em aquecimento = tem warm_start ou a tag de aquecimento; o teto da rampa nao importa aqui
const aquecIdsGlobal = new Set(['aquecimento', 'st_aquec']);
const ehAquec = (c) => !!(c && (c.warm_start || aquecIdsGlobal.has(String(c.wa_st || '')) || c.st === 'aquecimento'));
const F = fabrica(
  async () => estado(),
  () => '2026-10-31',
  (c) => ehAquec(c),
  (c) => (ehAquec(c) ? { lim: 5, ordem: -1, dia: 2, teto: 5 } : null),   // -1 = na frente da fila, igual o _numDoAquecimento
  (p, chips) => chips,
);

// ── a operacao ──────────────────────────────────────────────────────────────────────────────────
// Kevin: dois de producao. Guilherme: dois de producao, um deles o que o Bruno desligou por risco
// de ban, e um em aquecimento. Duas pressels da casa e uma de afiliado.
const K1 = '5515991872193', K2 = '5515991879743';
const G1 = '5515974076200', G_RISCO = '5515992503977', G_AQ = '5549988931497';
const AF = '5511999990000', COB = '5521988887777';
const k8 = (n) => String(n).replace(/\D/g, '').slice(-8);
const nkApp = (n) => String(n).replace(/\D/g, '').replace(/^55/, '').replace(/^(\d\d)9(\d{8})$/, '$1$2');
const EM_USO = 'st_emuso', AQUEC = 'st_aquec';
const STATUS = [
  { id: EM_USO, label: 'Em Uso', papel: 'em_uso' },
  { id: AQUEC, label: 'Em Aquecimento', papel: 'aquecimento' },
  { id: 'st_restr', label: 'Restrito', papel: 'restrito' },
];
const CHIPS = [
  { num: K1, at: 'kevin', st: 'ativo', wa_st: EM_USO, em_uso: true },
  { num: K2, at: 'kevin', st: 'ativo', wa_st: EM_USO, em_uso: true },
  { num: G1, at: 'gui', st: 'ativo', wa_st: EM_USO, em_uso: true },
  { num: G_RISCO, at: 'gui', st: 'ativo', wa_st: EM_USO, em_uso: true },
  { num: G_AQ, at: 'gui', st: 'ativo', wa_st: AQUEC, warm_start: '2026-10-29' },
  { num: AF, at: 'kevin', afl: 'aflX', st: 'ativo', wa_st: EM_USO, em_uso: true },
  // O NUMERO DO COBRADOR (corte da Sell 02, 31/10/2026): fica na operacao e esta "Em uso", mas
  // nunca entra na roleta - nem na primeira passada, nem no plantao. Ver a secao 11.
  { num: COB, at: 'hay', st: 'ativo', wa_st: EM_USO, em_uso: true },
];
function monta(vend) {
  const data = {
    wa_statuses: STATUS,
    chips: JSON.parse(JSON.stringify(CHIPS)),
    pressels: [
      { id: 1, vendedores: JSON.parse(JSON.stringify(vend || [])) },
      { id: 12, vendedores: JSON.parse(JSON.stringify(vend || [])) },
      { id: 99, afl: 'aflX', vendedores: [{ at: 'kevin', ativo: true }] },
    ],
  };
  sq.exec('DELETE FROM dashboard_state');
  sq.exec('DELETE FROM swweb_uso');
  try { sq.exec('DELETE FROM pressel_num_log'); } catch (_) {}
  sq.prepare('INSERT INTO dashboard_state VALUES (1, ?, 1, 0, ?)').run(JSON.stringify(data), 'teste');
}
const estado = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data);
const versao = () => sq.prepare('SELECT version FROM dashboard_state WHERE id=1').get().version;
const aluga = (num, user, ate, maq) => sq.prepare('INSERT INTO swweb_uso VALUES (?,?,?,?,?,?) ON CONFLICT(nk) DO UPDATE SET user_id=excluded.user_id, maquina=excluded.maquina, ate=excluded.ate')
  .run(nkApp(num), user, user, maq || ('maq-' + user), AGORA - 600, ate);
const pressel = (pid) => estado().pressels.find((x) => x.id === pid);
const vend = (pid, at) => (pressel(pid).vendedores || []).find((x) => String(x.at) === at) || {};
const appOffDe = (pid, at) => Object.keys(vend(pid, at).app_off || {});
const offDe = (pid, at) => Object.keys(vend(pid, at).off || {});

// a roleta de verdade, com a pressel do estado. `plantao` = true pede a segunda passada.
// O CORTE DE COBRANCA ENTRA AQUI DE PROPOSITO. Na producao ele mora no `_chipsDaPressel`, por onde
// passam os TRES chamadores do _resolvePresselSellers (roleta, /api/swweb/numeros e Chegada de
// leads), e a segunda passada do plantao usa a MESMA lista de chips da primeira. O teste chama a
// funcao DE VERDADE (`_chipDeCobranca`) em vez de reescrever o filtro, senao ele provaria a copia.
const roleta = (pid, plantao) => {
  const d = estado();
  const chips = d.chips.filter((c) => !c.afl && !F._chipDeCobranca(c));
  return F._resolvePresselSellers(pressel(pid), chips, new Map(), F._emUsoIdsDe(d),
    F._foraIdsDe(d), aquecIdsGlobal, plantao);
};
const numerosDa = (pid, plantao) => roleta(pid, plantao).flatMap((s) => (s.nums || []).map((n) => k8(n.num))).sort();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A OPERACAO COMO ELA E, EM TODA SECAO: Kevin com os dois ligados, Guilherme com o G1 ligado e o
// G_RISCO desligado NA MAO (e o numero que o Bruno tirou por risco de ban). Escrever isso uma vez e
// usar sempre evita o erro que a primeira versao deste teste cometeu: deixar o Guilherme SEM
// registro em algumas secoes faz "ausente = ligado" valer, os numeros dele entram no plantao, e a
// conferencia acusa defeito onde o codigo esta certo.
const OPERACAO = () => [
  { at: 'kevin', ativo: true },
  { at: 'gui', ativo: true, off: { [k8(G_RISCO)]: true } },
];

console.log('\n1. A MARCA DO SISTEMA: quem fechou o app vira plantao, quem gente desligou NAO');
monta(OPERACAO());
await F._desligaAppFechado(env);   // ninguem com aluguel: os dois estao fechados
conta('desligou os dois numeros do Kevin', offDe(1, 'kevin').sort().join() === [k8(K1), k8(K2)].sort().join(),
  offDe(1, 'kevin').join());
conta('e marcou os dois como plantao', appOffDe(1, 'kevin').sort().join() === [k8(K1), k8(K2)].sort().join(),
  appOffDe(1, 'kevin').join());
conta('o G1 do Guilherme virou plantao', appOffDe(1, 'gui').includes(k8(G1)), appOffDe(1, 'gui').join());
conta('o numero que o Bruno desligou por risco de ban NAO virou plantao',
  !appOffDe(1, 'gui').includes(k8(G_RISCO)), appOffDe(1, 'gui').join());
// O chip em aquecimento estava ligado, entao ele GANHA a marca como qualquer outro. Quem o tira do
// plantao e a roleta, na segunda passada (secao 3) - nao a marca. Conferir as duas coisas separadas,
// senao uma passa a esconder a outra.
conta('o numero em aquecimento tambem ganha a marca (ele estava ligado)',
  appOffDe(1, 'gui').includes(k8(G_AQ)), appOffDe(1, 'gui').join());
conta('a pressel do afiliado nao foi tocada',
  !(pressel(99).vendedores || []).some((v) => v.off || v.app_off));

console.log('\n2. O PLANTAO SO ENTRA QUANDO NAO SOBRA NINGUEM');
conta('primeira passada: com todo mundo desligado, a roleta nao acha ninguem', roleta(1, false).length === 0,
  JSON.stringify(numerosDa(1, false)));
conta('sem pedir plantao, continua vazia (quem nao pede nao recebe)', roleta(1).length === 0);
const pl = roleta(1, true);
conta('pedindo plantao, a roleta acha numero', pl.length > 0, JSON.stringify(numerosDa(1, true)));
conta('e vem marcado plantao:true, pra tela nao mentir', pl.every((s) => s.plantao === true && (s.nums || []).every((n) => n.plantao === true)));

console.log('\n3. O QUE O PLANTAO PODE E O QUE NAO PODE PEGAR');
const nums = numerosDa(1, true);
conta('pega os numeros de producao que estavam ligados', nums.includes(k8(K1)) && nums.includes(k8(K2)) && nums.includes(k8(G1)), nums.join());
conta('NAO pega o que gente desligou (risco de ban)', !nums.includes(k8(G_RISCO)), nums.join());
// AQUECIMENTO FAZ PLANTAO desde 05/11/2026 (pedido do Bruno: os leads da madrugada aquecem o chip).
// Ele entra com o teto da rampa e na FRENTE da fila do vendedor, entao pega a vez antes do de producao.
conta('pega o numero em aquecimento (05/11: os leads da madrugada aquecem o chip)', nums.includes(k8(G_AQ)), nums.join());
{
  const gui = roleta(1, true).find((s) => s.at === 'gui') || { nums: [] };
  const aq = gui.nums.find((n) => k8(n.num) === k8(G_AQ));
  conta('e ele vem com o teto da rampa, em modo limite', !!aq && aq.lim === 5 && aq.dist === 'limite' && !!aq.aquec, JSON.stringify(aq));
  const fila = gui.nums.filter((n) => n.dist === 'limite').sort((x, y) => (x.ordem - y.ordem));
  conta('e na frente da fila do Guilherme no plantao', !!fila.length && k8(fila[0].num) === k8(G_AQ), fila.map((n) => k8(n.num) + ':' + n.ordem).join());
}

console.log('\n4. COM ALGUEM APTO, O PLANTAO NEM APARECE (ultimo recurso de verdade)');
monta([{ at: 'kevin', ativo: true, off: { [k8(K2)]: true }, app_off: { [k8(K2)]: true } }, { at: 'gui', ativo: true }]);
const comApto = numerosDa(1, true);
conta('o K1 ligado manda, e o K2 em plantao fica de fora', comApto.includes(k8(K1)) && !comApto.includes(k8(K2)), comApto.join());
conta('ninguem vem marcado plantao', roleta(1, true).every((s) => !s.plantao));

console.log('\n5. CLIQUE DE GENTE TIRA O NUMERO DO PLANTAO');
monta(OPERACAO());
await F._desligaAppFechado(env);
conta('antes do clique, o K1 esta em plantao', appOffDe(1, 'kevin').includes(k8(K1)));
{
  // o mesmo caminho do interruptor: liga e desliga na mao
  const d = estado();
  const p = d.pressels.find((x) => x.id === 1);
  F._presselAplicaNum(p, 'kevin', k8(K1), true, false, [k8(K1), k8(K2)]);
  sq.prepare('UPDATE dashboard_state SET data=? WHERE id=1').run(JSON.stringify(d));
}
conta('LIGAR na mao apaga a marca', !appOffDe(1, 'kevin').includes(k8(K1)), appOffDe(1, 'kevin').join());
{
  const d = estado();
  const p = d.pressels.find((x) => x.id === 1);
  F._presselAplicaNum(p, 'kevin', k8(K1), false, false, [k8(K1), k8(K2)]);
  sq.prepare('UPDATE dashboard_state SET data=? WHERE id=1').run(JSON.stringify(d));
}
conta('DESLIGAR na mao tambem deixa sem marca: a decisao e dela', !appOffDe(1, 'kevin').includes(k8(K1)), appOffDe(1, 'kevin').join());
conta('e o K1 saiu do plantao, sobrando o K2, o G1 e o aquecimento do Guilherme',
  numerosDa(1, true).join() === [k8(K2), k8(G1), k8(G_AQ)].sort().join(), numerosDa(1, true).join());

console.log('\n6. "DESLIGADO ATE AMANHA" NAO VIRA PLANTAO');
monta([
  { at: 'kevin', ativo: true, off: { [k8(K1)]: true }, volta: { [k8(K1)]: '2026-11-01' } },
  { at: 'gui', ativo: true, off: { [k8(G_RISCO)]: true } },
]);
await F._desligaAppFechado(env);
conta('o numero parado ate amanha nao ganhou marca', !appOffDe(1, 'kevin').includes(k8(K1)), appOffDe(1, 'kevin').join());
conta('e o outro, que estava ligado, ganhou', appOffDe(1, 'kevin').includes(k8(K2)));
conta('de madrugada sobram o K2, o G1 e o aquecimento, nunca o parado ate amanha',
  numerosDa(1, true).join() === [k8(K2), k8(G1), k8(G_AQ)].sort().join(), numerosDa(1, true).join());

console.log('\n7. POR PRESSEL, NAO POR NUMERO');
// o K1 esta ligado na pressel 1 e desligado na mao na 12: so a 1 pode usa-lo de plantao
monta(OPERACAO());
{
  const d = estado();
  const p12 = d.pressels.find((x) => x.id === 12);
  p12.vendedores = [{ at: 'kevin', ativo: true, off: { [k8(K1)]: true } },
    { at: 'gui', ativo: true, off: { [k8(G_RISCO)]: true } }];
  sq.prepare('UPDATE dashboard_state SET data=? WHERE id=1').run(JSON.stringify(d));
}
await F._desligaAppFechado(env);
conta('na pressel 1 (estava ligado) o K1 e plantao', appOffDe(1, 'kevin').includes(k8(K1)), appOffDe(1, 'kevin').join());
conta('na pressel 12 (gente desligou) o K1 NAO e plantao', !appOffDe(12, 'kevin').includes(k8(K1)), appOffDe(12, 'kevin').join());
conta('e a roleta respeita isso: a 1 usa o K1, a 12 nao',
  numerosDa(1, true).includes(k8(K1)) && !numerosDa(12, true).includes(k8(K1)),
  '1=' + numerosDa(1, true).join() + '  12=' + numerosDa(12, true).join());

console.log('\n8. QUEM ABRE O APP SAI DO PLANTAO');
monta(OPERACAO());
await F._desligaAppFechado(env);
conta('a noite: os dois em plantao', appOffDe(1, 'kevin').length === 2 && appOffDe(1, 'gui').length >= 1,
  'kevin=' + appOffDe(1, 'kevin').length + ' gui=' + appOffDe(1, 'gui').length);
conta('os donos com marca aparecem no _plantaoDonos', [...F._plantaoDonos(estado())].sort().join() === 'gui,kevin',
  [...F._plantaoDonos(estado())].join());
// de manha o Kevin abre o app (aluguel vivo) e NAO liga a chave
AGORA += 10 * 3600;
aluga(K1, 'kevin', AGORA + 120);
const vAntes = versao();
await F._desligaAppFechado(env);
conta('o Kevin perdeu a marca de plantao', appOffDe(1, 'kevin').length === 0, appOffDe(1, 'kevin').join());
conta('mas o numero dele CONTINUA desligado: ele tem que ligar', offDe(1, 'kevin').length === 2, offDe(1, 'kevin').join());
conta('o Guilherme, ainda fechado, segue em plantao', appOffDe(1, 'gui').includes(k8(G1)));
conta('gravou (a versao andou)', versao() > vAntes, vAntes + ' -> ' + versao());
conta('com o Kevin fora do plantao, a madrugada cai nos numeros do Guilherme',
  numerosDa(1, true).join() === [k8(G1), k8(G_AQ)].sort().join(), numerosDa(1, true).join());
const v2 = versao();
await F._desligaAppFechado(env);
conta('e a batida seguinte nao grava de novo (nao fica rodando a toa)', versao() === v2, v2 + ' -> ' + versao());

console.log('\n9. LEITURA DOS ALUGUEIS FALHANDO NAO ESVAZIA O PLANTAO');
monta(OPERACAO());
await F._desligaAppFechado(env);
const antesQuebra = appOffDe(1, 'kevin').length;
quebraUso = true;
const v3 = versao();
await F._desligaAppFechado(env);
quebraUso = false;
conta('D1 fora: as marcas ficam como estavam', appOffDe(1, 'kevin').length === antesQuebra,
  antesQuebra + ' -> ' + appOffDe(1, 'kevin').length);
conta('e nada foi gravado', versao() === v3);

console.log('\n10. A MARCA SOBREVIVE A TELA QUE SALVA A PRESSEL INTEIRA');
// o normalizador do PUT de pressel (handleUpdatePressel) so deixa passar auto_off, volta e app_off
const normaliza = fonte.slice(fonte.indexOf('if (Array.isArray(patch.vendedores)) {'));
conta('o normalizador do patch carrega app_off junto', /for \(const mk of \['auto_off', 'volta', 'app_off'\]\)/.test(normaliza.slice(0, 2000)));
conta('e o _limpaMarcasDesligado apaga as tres',
  /for \(const mk of \['auto_off', 'volta', 'app_off'\]\)/.test(funcao('_limpaMarcasDesligado')));

console.log('\n11. O NUMERO DO COBRADOR NUNCA FAZ PLANTAO');
// A mesa de cobranca nao recebe comprador novo: se o numero do Haynan virasse o plantao da
// madrugada, quem clicasse no anuncio as 3h cairia na COBRANCA em vez de num vendedor. Seria ao
// contrario do funil e nao daria erro em lugar nenhum.
monta([...OPERACAO(), { at: 'hay', ativo: true }]);
await F._cobIds(env);   // carrega o _cobIdsMem do banco (a propria funcao do worker)
conta('o worker reconhece o chip do cobrador', F._chipDeCobranca({ at: 'hay', num: COB })
  && !F._chipDeCobranca({ at: 'gui', num: G1 }));
await F._desligaAppFechado(env);
const comCob = numerosDa(1, true);
conta('o numero do cobrador NAO esta no plantao', !comCob.includes(k8(COB)), comCob.join());
conta('e o plantao continua achando o numero do vendedor', comCob.includes(k8(G1)), comCob.join());
conta('nem na primeira passada ele aparece', !numerosDa(1, false).includes(k8(COB)));

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) { console.log('\nFALHOU:'); for (const f of falhas) console.log('  - ' + f); process.exit(1); }
