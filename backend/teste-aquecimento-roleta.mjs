// TESTE DO AQUECIMENTO NA ROLETA (16/10/2026).
//
// O pedido do Bruno: numero EM AQUECIMENTO deixa de ficar fora da roleta e passa a receber pouco,
// crescendo, porque e o ATENDIMENTO que aquece o chip. A rampa e a tabela que ele confirmou:
//   dias 1-3 -> 5/dia | 4-6 -> 10 | 7-9 -> 20 | 10-15 -> 35 | 16+ -> 50 (e fica, ate ele mover
//   pra "Em uso" na mao)
//
// POR QUE ESTE TESTE EXISTE E PRECISA SER CHATO: ja houve rampa de aquecimento nesta roleta e ela
// foi REMOVIDA depois de incidente real (21/07/2026) - dava teto de rajada menor pro numero novo e
// o estabelecido absorvia o excedente, 46 contatos/h num e 9 no outro. A memoria
// roleta-pressel-gotchas (itens 10 e 14) e explicita: "nao voltar a empilhar sinal". Esta versao
// nao empilha: reusa o modo `limite` que ja existe. O que estes testes vigiam e justamente isso.
//
// COMO ELE LE O CODIGO DE VERDADE: o worker.js e um modulo unico sem exports, entao aqui a gente
// RECORTA do arquivo os trechos que decidem e os executa. Se alguem mexer na regra, o recorte muda
// e o teste quebra junto - que e o ponto.
//
// Roda:  node teste-aquecimento-roleta.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  OK      ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
  else { falhas.push(nome); console.log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

// ── recorta o bloco da rampa e o da fila, e executa ───────────────────────────────────────────
const iRampa = src.indexOf('const RAMPA_AQUECIMENTO');
const iFila = src.indexOf('function _numNoLimite');
const iFim = src.indexOf('// NUMEROS MUDOS:');
if (iRampa < 0 || iFila < 0 || iFim < 0) {
  console.error('NAO ACHEI os trechos do aquecimento no worker.js');
  process.exit(1);
}
const blocoRampa = src.slice(iRampa, iFila);
const blocoFila = src.slice(iFila, iFim);

const api = new Function(blocoRampa + blocoFila + `
  return { RAMPA_AQUECIMENTO, TETO_AQUECIDO, limiteDoAquecimento, DIA_ACUM,
           _tetoAcumulado, _diaDoAquecimento, _chipAquecendo, _numDoAquecimento,
           _numNoLimite, _aplicaFilaLimite };`)();

console.log('\nTESTE DO AQUECIMENTO NA ROLETA\n');

// ── 1) A RAMPA, exatamente como ele confirmou ─────────────────────────────────────────────────
// As BORDAS sao o que erra: 3 e 4, 6 e 7, 9 e 10, 15 e 16.
const esperado = {
  1: 5, 2: 5, 3: 5, 4: 10, 5: 10, 6: 10, 7: 20, 8: 20, 9: 20,
  10: 35, 12: 35, 15: 35, 16: 50, 30: 50, 365: 50,
};
for (const [dia, teto] of Object.entries(esperado)) {
  vale('dia ' + dia + ' -> ' + teto + '/dia', api.limiteDoAquecimento(Number(dia)) === teto,
    String(api.limiteDoAquecimento(Number(dia))));
}
vale('dia 0 ou lixo cai no dia 1, nunca em teto alto',
  api.limiteDoAquecimento(0) === 5 && api.limiteDoAquecimento(null) === 5 && api.limiteDoAquecimento('abc') === 5);
// O teto final NAO sobe sozinho: ele disse que fica em 50 ate mover pra "Em uso" na mao.
vale('nao existe degrau acima de 50', api.TETO_AQUECIDO === 50 && api.limiteDoAquecimento(9999) === 50);

// ── 2) A CURVA DO DIA, que impede a rajada ────────────────────────────────────────────────────
vale('a curva tem as 24 horas', Array.isArray(api.DIA_ACUM) && api.DIA_ACUM.length === 24, String(api.DIA_ACUM.length));
vale('a curva so cresce (acumulado nao pode cair)',
  api.DIA_ACUM.every((v, i) => i === 0 || v >= api.DIA_ACUM[i - 1]));
vale('a curva comeca em 0 e termina perto de 1000',
  api.DIA_ACUM[0] === 0 && api.DIA_ACUM[23] > 950 && api.DIA_ACUM[23] <= 1000, String(api.DIA_ACUM[23]));
// A MEDICAO que gerou a curva: 92,8% dos leads entre 07h e 17h59.
vale('a curva reflete o dia MEDIDO: as 18h ja passou de 90% do movimento',
  api.DIA_ACUM[18] > 900, String(api.DIA_ACUM[18]));
vale('e de madrugada quase nada passou', api.DIA_ACUM[6] < 20, String(api.DIA_ACUM[6]));

// O PISO DE 1 e o ponto da feature: sem ele o chip fica fora da roleta na hora do primeiro lead.
vale('de madrugada o teto acumulado e 1, nao 0', api._tetoAcumulado(5, 3) === 1, String(api._tetoAcumulado(5, 3)));
vale('teto 0 continua 0 (sem limite nao vira limite 1)', api._tetoAcumulado(0, 12) === 0);

// O GOTEJAMENTO: um chip de 5/dia nao pode ter os 5 disponiveis de manha.
const gotas = [6, 9, 11, 13, 15, 17].map((h) => api._tetoAcumulado(5, h));
vale('chip de 5/dia goteja ao longo do dia, nao libera tudo cedo',
  gotas[0] === 1 && gotas[gotas.length - 1] === 5 && gotas.every((v, i) => i === 0 || v >= gotas[i - 1]),
  gotas.join(' -> '));
vale('as 9h da manha ele ainda nao pode receber 5 de uma vez', api._tetoAcumulado(5, 9) < 5,
  String(api._tetoAcumulado(5, 9)));
// No fim do dia o teto tem que chegar no cheio, senao a cota some todo dia.
for (const teto of [5, 10, 20, 35, 50]) {
  vale('teto ' + teto + ' chega ao cheio no fim do dia', api._tetoAcumulado(teto, 23) === teto,
    String(api._tetoAcumulado(teto, 23)));
}

// ── 3) QUEM E CHIP EM AQUECIMENTO ─────────────────────────────────────────────────────────────
vale('aquecimento COM dono entra', api._chipAquecendo({ st: 'aquecimento', at: 'u1' }) === true);
vale('aquecimento SEM dono fica fora (o pool e sala de espera)',
  api._chipAquecendo({ st: 'aquecimento', at: '' }) === false);
vale('aquecimento numa COLUNA (ccol_) fica fora, como o resto da roleta',
  api._chipAquecendo({ st: 'aquecimento', at: 'ccol_4' }) === false);
vale('banido nunca entra', api._chipAquecendo({ st: 'banido', at: 'u1' }) === false);
vale('numero de producao nao e aquecimento', api._chipAquecendo({ st: 'ativo', at: 'u1' }) === false);

// ── 4) O DIA SAI DO warm_start ────────────────────────────────────────────────────────────────
const diaBR = (d) => {
  const x = new Date(Date.now() - 3 * 3600 * 1000 - d * 86400000);
  return x.toISOString().slice(0, 10);
};
vale('chip que comecou hoje esta no dia 1', api._diaDoAquecimento({ warm_start: diaBR(0) }) === 1,
  String(api._diaDoAquecimento({ warm_start: diaBR(0) })));
vale('chip de 6 dias atras esta no dia 7', api._diaDoAquecimento({ warm_start: diaBR(6) }) === 7,
  String(api._diaDoAquecimento({ warm_start: diaBR(6) })));
vale('sem warm_start cai no campo `dia` e nunca em 0',
  api._diaDoAquecimento({ dia: 4 }) === 4 && api._diaDoAquecimento({}) === 1);
vale('warm_start podre nao vira dia gigante (teto alto por acidente)',
  api._diaDoAquecimento({ warm_start: 'ontem' }) === 1);

// ── 5) O QUE ELE LEVA PRA ROLETA ──────────────────────────────────────────────────────────────
const n1 = api._numDoAquecimento({ st: 'aquecimento', at: 'u1', warm_start: diaBR(0) });
vale('entra em modo LIMITE (reusa a regra que existe, sem sinal novo)', n1.dist === 'limite', n1.dist);
vale('entra NA FRENTE da fila do vendedor', n1.ordem === -1, String(n1.ordem));
vale('o teto dele e o da rampa, acumulado pela hora', n1.teto === 5 && n1.lim >= 1 && n1.lim <= 5,
  'teto ' + n1.teto + ', agora ' + n1.lim);
// ordem 0 seria o FIM da fila: o comparador usa Number(x)||999 e 0 e falsy la.
vale('a ordem nao pode ser 0, que no comparador vira 999 (fim da fila)', n1.ordem !== 0);

// ── 6) A FILA: o aquecendo recebe ANTES do estabelecido, e passa a vez ao bater o teto ────────
// E a metade da feature. A fila do modo limite e por VENDEDOR e inclui os numeros estabelecidos:
// em posicao 4, 5 e 6 o chip em aquecimento so receberia depois dos tres estabelecidos baterem o
// teto deles, o que na maioria dos dias nao acontece - e a feature nunca sairia do papel.
const hoje = '2026-10-16';
const estab = (num, ordem, lim) => ({ num, at: 'u1', dist: 'limite', ordem, lim, livre: '', idx: 1 });
const aquecendo = (num, lim) => ({ num, at: 'u1', dist: 'limite', ordem: -1, lim, livre: '', idx: 0 });

{
  // o chip em aquecimento ainda nao bateu o teto da hora -> a vez e dele
  const lista = [estab('5515974076200', 1, 70), estab('5515970001111', 2, 70), aquecendo('5515999998888', 1)];
  const lh = { '74076200': 10, '70001111': 0, '99998888': 0 };
  const r = api._aplicaFilaLimite(lista, lh, hoje);
  vale('a vez do vendedor e do numero EM AQUECIMENTO, na frente dos estabelecidos',
    r.ficam.length === 1 && r.ficam[0].num === '5515999998888', JSON.stringify(r.ficam.map((x) => x.num)));
  vale('e os estabelecidos ficam esperando, nao fora', r.esperam.length === 2 && r.bateram.length === 0,
    'esperam ' + r.esperam.length + ', bateram ' + r.bateram.length);
}
{
  // bateu o teto da hora (1 lead com teto 1) -> passa a vez pro estabelecido
  const lista = [estab('5515974076200', 1, 70), aquecendo('5515999998888', 1)];
  const lh = { '74076200': 10, '99998888': 1 };
  const r = api._aplicaFilaLimite(lista, lh, hoje);
  vale('bateu o teto da hora, a vez passa pro estabelecido (o gotejamento)',
    r.ficam.length === 1 && r.ficam[0].num === '5515974076200', JSON.stringify(r.ficam.map((x) => x.num)));
  vale('e o que bateu aparece como bateu, nao como esperando',
    r.bateram.length === 1 && r.bateram[0].num === '5515999998888');
}
{
  // DOIS em aquecimento: o segundo so comeca depois do primeiro bater. Um de cada vez, por vendedor.
  const lista = [aquecendo('5515999998888', 1), { ...aquecendo('5515999997777', 1), idx: 2 }, estab('5515974076200', 1, 70)];
  const lh = { '99998888': 1, '99997777': 0, '74076200': 5 };
  const r = api._aplicaFilaLimite(lista, lh, hoje);
  vale('com dois em aquecimento, a vez vai pro segundo quando o primeiro bate',
    r.ficam.length === 1 && r.ficam[0].num === '5515999997777', JSON.stringify(r.ficam.map((x) => x.num)));
}
{
  // O numero de OUTRO vendedor nao entra nesta fila: a fila e por vendedor.
  const lista = [aquecendo('5515999998888', 1), { ...aquecendo('5521988887777', 1), at: 'u2' }];
  const lh = {};
  const r = api._aplicaFilaLimite(lista, lh, hoje);
  vale('cada vendedor tem a propria fila (dois em aquecimento, dois donos, os dois recebem)',
    r.ficam.length === 2, JSON.stringify(r.ficam.map((x) => x.num)));
}
{
  // O "religa por hoje" (lim_livre) NAO pode soltar o teto de um chip de tres dias.
  const n = api._numDoAquecimento({ st: 'aquecimento', at: 'u1', warm_start: diaBR(0), lim_livre: hoje });
  vale('o chip em aquecimento nao herda o lim_livre do numero de producao', !n.livre, JSON.stringify(n.livre));
}

// ── 7) GUARDAS DE REGRESSAO no texto do worker ────────────────────────────────────────────────
// O que NAO pode voltar: sinal novo dentro do balanceador.
const corpoPick = src.slice(src.indexOf('function _presselBalancedPick'), src.indexOf('// NUMEROS MUDOS:'));
vale('o balanceador continua sem saber o que e aquecimento',
  !/aquec/i.test(corpoPick.slice(0, corpoPick.indexOf('_aplicaFilaLimite'))),
  'nenhuma mencao antes do filtro de limite');
// O diag TEM que repetir os mesmos testes da roleta, senao mente no dia em que precisa avisar.
vale('o diag enxerga o aquecimento igual a roleta',
  /_chipAquecendo\(c\)[\s\S]{0,80}isEmUso\(c\)/.test(src.slice(src.indexOf('const usaveis = chips.filter'))) ||
  src.slice(src.indexOf('const usaveis = chips.filter'), src.indexOf('const usaveis = chips.filter') + 300).includes('_chipAquecendo'));
// A TDZ que ja derrubou a dash uma vez.
vale('_chipAquecendo e funcao icada, nao const (ela e usada 10 mil linhas acima)',
  /function _chipAquecendo\(c\)/.test(src) && !/const _chipAquecendo/.test(src));

console.log('');
if (falhas.length) {
  console.log('  ' + ok + ' passaram, ' + falhas.length + ' FALHARAM:');
  for (const f of falhas) console.log('   - ' + f);
  process.exit(1);
}
console.log('  ' + ok + ' de ' + ok + ' conferencias passaram.');
