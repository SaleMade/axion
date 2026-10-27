// NUMERO CEGO NAO PODE ATRAIR CLIQUE (27/10/2026).
//
// A CEGUEIRA SE AUTO-ALIMENTAVA. O balanceador escolhe por "menos lead hoje recebe agora", e isso
// presume que o contador diz a verdade. Numero que nao esta sendo capturado marca ZERO lead faca o
// que fizer: ele parece o mais atrasado do grupo e leva TODO o clique novo.
//
// MEDIDO no (17) 99701-1859 em 26/10, cliques por hora:
//     07h 14 | 08h 40 | 09h 3 | 10h 14 | 11h 13 | 12h 9 | 13h 16 | 14h 10 | 15h 375 | 16h 205
// 580 dos 699 cliques do dia em DUAS horas, no numero que nao capturou uma mensagem o dia inteiro.
//
// O RISCO QUE O BRUNO LEVANTOU: um numero em AQUECIMENTO, de 1 ou 2 dias de rampa, se ficar cego
// marca 0 lead, o teto do dia nunca dispara e o dia inteiro cai nele. Numero novo levando 300
// cliques e numero queimado.
//
// Recorta a ordenacao DO PROPRIO worker.js e roda. Nada e reescrito aqui.
//   node teste-cego-nao-atrai.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// a linha do sort e a do `_ceg`, cortadas do arquivo
const linha = (marca) => (src.split('\n').find((l) => l.includes(marca)) || '').trim();
// Pega a ordenacao SEJA QUAL FOR a formula dela, de proposito: se alguem tirar o cego do sort, o
// recorte continua funcionando e quem acusa e o COMPORTAMENTO la embaixo, que e o que importa.
// Conferir a presenca do texto so provaria que a linha existe, nao que ela faz a coisa certa.
const L_CEG = linha('const _ceg = (u) =>') || 'const _ceg = () => 0;';
const L_SORT = linha('escAt.nums.sort(');

let ok = 0;
const falhas = [];
const conta = (nome, certo, det) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome); }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (det ? '   -> ' + det : '')); }
};

conta('o worker tem a ordenacao dos numeros do vendedor', !!L_SORT, 'sort=' + !!L_SORT);
if (!L_SORT) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1); }

// Monta a escolha com as DUAS linhas de verdade. `conv` = leads de hoje por numero, `cargaDia` =
// cliques de hoje, `_mudos` = o mapa de quem esta sem capturar (visitas, sem mensagem nenhuma).
function escolhe({ nums, conv, cliques, mudos }) {
  const k8 = (n) => String(n || '').replace(/\D/g, '').slice(-8);
  const cargaDia = (a) => cliques[k8(a.num)] || 0;
  const _mudos = mudos;
  const escAt = { nums: nums.map((n) => ({ num: n })) };
  // eslint-disable-next-line no-new-func
  const f = new Function('escAt', 'conv', 'cargaDia', '_mudos', 'k8', L_CEG + '\n' + L_SORT + '\nreturn escAt.nums[0].num');
  return f(escAt, conv, cargaDia, _mudos, k8);
}

const A = '5517997011859';   // o cego do dia 26
const B = '5515992774144';   // um que captura normal
const C = '5511966632248';   // outro que captura normal

// ── O CASO DE 26/10, COM OS NUMEROS DE VERDADE ────────────────────────────────────────────────
{
  // O cego marcou 0 lead porque nao captura; os vivos marcaram 16 e 31. Pela regua antiga o cego
  // ganharia sempre, e foi o que aconteceu: 580 cliques em duas horas.
  const r = escolhe({
    nums: [A, B, C],
    conv: { '97011859': 0, '92774144': 16, '66632248': 31 },
    cliques: { '97011859': 699, '92774144': 692, '66632248': 178 },
    mudos: { '97011859': 375 },
  });
  conta('o cego NAO recebe, mesmo marcando 0 lead contra 16 e 31', r !== A, 'escolheu ' + r);
  conta('e quem recebe e o vivo com menos lead', r === B, 'escolheu ' + r);
}

// ── A REGUA NORMAL CONTINUA VALENDO ENTRE OS VIVOS ────────────────────────────────────────────
{
  const r = escolhe({
    nums: [B, C], conv: { '92774144': 40, '66632248': 10 },
    cliques: { '92774144': 100, '66632248': 100 }, mudos: {},
  });
  conta('sem cego, continua sendo "menos lead hoje recebe agora"', r === C, 'escolheu ' + r);
}
{
  const r = escolhe({
    nums: [B, C], conv: { '92774144': 10, '66632248': 10 },
    cliques: { '92774144': 300, '66632248': 50 }, mudos: {},
  });
  conta('empatado em lead, desempata por quem levou menos clique', r === C, 'escolheu ' + r);
}

// ── NINGUEM FICA SEM NUMERO ───────────────────────────────────────────────────────────────────
{
  // O caso GRAVE: varios cegos ao mesmo tempo. A guarda antiga (que TIRA da roleta) desiste inteira
  // aqui, pra nao esvaziar a lista - e era quando o balanceador voltava a despejar no pior. Esta
  // regra so ORDENA, entao com todos cegos ela nao tira ninguem e a regua normal decide.
  const r = escolhe({
    nums: [A, B], conv: { '97011859': 0, '92774144': 0 },
    cliques: { '97011859': 699, '92774144': 50 },
    mudos: { '97011859': 375, '92774144': 120 },
  });
  conta('com TODOS cegos, ninguem fica sem numero e o menos carregado recebe', r === B, 'escolheu ' + r);
}

// ── O CASO DO AQUECIMENTO, que foi o medo dele ────────────────────────────────────────────────
{
  // Numero novo, dia 1 de rampa, teto baixo. Se ele ficar cego marca 0 lead, o teto nunca dispara e
  // o dia inteiro cai nele. Com a regra, o clique vai pro veterano mesmo ele tendo mais lead.
  const NOVO = '5515999990001';
  const r = escolhe({
    nums: [NOVO, C],
    conv: { '99990001': 0, '66632248': 28 },
    cliques: { '99990001': 40, '66632248': 300 },
    mudos: { '99990001': 40 },
  });
  conta('numero em aquecimento CEGO nao vira o ralo do dia', r !== NOVO, 'escolheu ' + r);
}
{
  // E o aquecimento SAUDAVEL continua recebendo: a regra e sobre cegueira, nao sobre ser novo.
  const NOVO = '5515999990001';
  const r = escolhe({
    nums: [NOVO, C],
    conv: { '99990001': 2, '66632248': 28 },
    cliques: { '99990001': 40, '66632248': 300 },
    mudos: {},
  });
  conta('e o aquecimento que ESTA capturando continua recebendo normal', r === NOVO, 'escolheu ' + r);
}

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados');
process.exit(falhas.length ? 1 : 0);
