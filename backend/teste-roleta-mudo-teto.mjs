// TESTE: A GUARDA DO NUMERO MUDO E O TETO DO DIA NAO PODEM ESVAZIAR A ROLETA JUNTOS (17/10/2026).
//
// O incidente: 17:14 a 17:30, 364 cliques pagos cairam em pressel sem numero. O Bruno deixou so o
// (15) 97407-6200 do Guilherme recebendo, recem consertado, mas ele carregava 35 visitas sem mensagem
// da hora em que estava quebrado. A guarda do mudo tirou ele (ROLETA_MUDO_FORA) e sobraram so numeros
// que ja tinham batido o teto: o passo do Limite devolveu ninguem (ROLETA_TODOS_NO_LIMITE numeros=5).
// A guarda promete "nunca esvazia a roleta", mas so olhava a lista antes do teto.
//
// Recorta do worker.js o trecho que decide (guarda do mudo + fila do Limite) e executa com dado falso.
// Roda:  node teste-roleta-mudo-teto.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  OK      ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
  else { falhas.push(nome); console.log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

const iFila = src.indexOf('function _numNoLimite');
const iFimFila = src.indexOf('// NUMEROS MUDOS:');
const iRampa = src.indexOf('const RAMPA_AQUECIMENTO');
const iPick = src.indexOf('async function _presselBalancedPick');
const iIni = src.indexOf('  let _mudosFora = [];', iPick);
const iFim = src.indexOf('  if(avail.length===1){', iIni);
if ([iFila, iFimFila, iRampa, iPick, iIni, iFim].some((x) => x < 0)) { console.error('NAO ACHEI os trechos no worker.js'); process.exit(1); }
const helpers = src.slice(iRampa < iFila ? iRampa : iFila, iFimFila);
const bloco = src.slice(iIni, iFim);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const roda = new AsyncFunction('avail', 'mudosFake', 'lhFake', `
  const k8 = (n) => String(n || '').replace(/\\D/g, '').slice(-8);
  const _numerosMudos = async () => mudosFake;
  const _leadsNovosHojePorNumero = async () => lhFake;
  const _brDay = () => '2026-10-17';
  const env = {}, dayStart = 0, id = 12;
  const _pre = null;   // a pagina adianta as leituras (_roletaAdianta); aqui o teste passa as falsas direto
  const console = { log() {} };
  ${helpers}
  ${bloco}
  return avail;`);

const n = (num, at, ordem, lim, extra) => ({ num, at, inst: 'ax_' + at, roleta: false, lim, livre: '', dist: 'limite', ordem, idx: ordem, ...(extra || {}) });
const G1 = n('(11) 96663-2248', 'g', 4, 70), G2 = n('(19) 99598-3293', 'g', 5, 70), G3 = n('(15) 97407-6200', 'g', 6, 50);
const K1 = n('(82) 99121-5713', 'k', 4, 70);
const lhCheio = { '66632248': 74, '95983293': 73, '74076200': 0, '91215713': 73 };

console.log('\nMUDO + TETO NAO ESVAZIAM A ROLETA\n');
{
  const r = await roda([G1, G2, G3, K1], { '74076200': 35 }, lhCheio);
  vale('o caso de 17/10: o unico abaixo do teto e mudo -> ele volta e recebe', Array.isArray(r) && r.length === 1 && r[0] === G3, r ? r.map((x) => x.num).join(',') : 'null');
}
{
  const r = await roda([G1, G2, G3, K1], {}, lhCheio);
  vale('sem mudo: o mesmo numero recebe (nada mudou)', Array.isArray(r) && r.length === 1 && r[0] === G3, r ? r.map((x) => x.num).join(',') : 'null');
}
{
  const vivoK = n('(15) 99237-1970', 'k', 5, 40);
  const r = await roda([G1, G2, G3, K1, vivoK], { '74076200': 35 }, { ...lhCheio, '92371970': 10 });
  vale('tem numero vivo abaixo do teto: o mudo continua fora', Array.isArray(r) && r.length === 1 && r[0] === vivoK, r ? r.map((x) => x.num).join(',') : 'null');
}
{
  const r = await roda([G1, G2, K1], {}, lhCheio);
  vale('todo mundo no teto e nenhum mudo: ninguem recebe (o teto continua valendo)', r === null, String(r));
}
{
  const r = await roda([G1, G2, G3, K1], { '74076200': 35 }, { ...lhCheio, '74076200': 50 });
  vale('o mudo que volta tambem respeita o teto: no teto, nao volta', r === null, String(r));
}

console.log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram.');
if (falhas.length) { console.log('  FALHARAM: ' + falhas.join(' | ')); process.exit(1); }
