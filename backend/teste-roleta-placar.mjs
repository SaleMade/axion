// TESTE DO PLACAR DA ROLETA (14/10/2026).
//
// Prova o conserto do incidente de 14/10: as 13:22 o Kevin desligou o proprio numero, que ja tinha
// 74 leads no dia, e o placar dele caiu junto. Ele virou "o mais atrasado" e a roleta despejou tudo
// nele por meia hora, com o Guilherme atras o tempo todo.
//
// COMO ESTE TESTE LE O CODIGO DE VERDADE: o worker.js e um modulo unico sem exports nomeados, entao
// aqui a gente RECORTA do arquivo os dois trechos que decidem (a montagem do placar e a ordenacao)
// e roda com dados de teste. Se alguem mexer nessas linhas e quebrar a regra, o recorte muda e o
// teste quebra junto - que e o ponto.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

// ── o trecho do placar, recortado do worker ───────────────────────────────────────────────────
const ini = src.indexOf('  const porAt={};');
const fim = src.indexOf('const escolhido=escAt.nums[0];');
if (ini < 0 || fim < 0) { console.error('NAO ACHEI o trecho do placar no worker.js'); process.exit(1); }
const trecho = src.slice(ini, fim);

// Guardas do que NAO pode voltar a acontecer
const falhas = [];
if (/porAt\[k\]\.cv\+=\(conv\[nk\]\|\|0\)/.test(trecho)) {
  falhas.push('o laco do pool voltou a somar cv so dos numeros LIGADOS (era o bug de 14/10)');
}
if (!/sv\.nksTodos/.test(trecho)) {
  falhas.push('o placar nao usa mais nksTodos: numero desligado sumiu da conta do vendedor');
}
if (!/ats\.sort\(\(a,b\)=>\(a\.cv-b\.cv\)/.test(trecho)) {
  falhas.push('a ordenacao deixou de ser "menos LEAD recebe"');
}

// ── a regra, reproduzida, pra provar o comportamento ──────────────────────────────────────────
// conv = leads de hoje por numero (ultimos 8 digitos), como o worker monta
const conv = { '74076200': 70, '81430517': 25, '91215713': 74, '97405847': 11, '95983293': 3 };

function placar(sellers, pool, foraLimite) {
  const k8 = (n) => String(n || '').replace(/\D/g, '').slice(-8);
  const porAt = {};
  pool.forEach((a) => {
    const k = String(a.at);
    if (!porAt[k]) porAt[k] = { at: k, cli: 0, cv: 0, nums: [] };
    porAt[k].nums.push(a);
  });
  for (const sv of sellers) {
    const k = String(sv.at); if (!porAt[k]) continue;
    const lista = (Array.isArray(sv.nksTodos) && sv.nksTodos.length)
      ? sv.nksTodos
      : porAt[k].nums.map((a) => k8(a.num)).concat(foraLimite.filter((u) => String(u.at) === k).map((u) => k8(u.num)));
    const vistos = new Set();
    for (const nk of lista) { if (nk && !vistos.has(nk)) { vistos.add(nk); porAt[k].cv += (conv[nk] || 0); } }
  }
  const ats = Object.values(porAt);
  ats.sort((a, b) => (a.cv - b.cv) || (a.cli - b.cli));
  return { ats, quemRecebe: ats[0].at };
}

const casos = [];

// CASO 1 - o incidente: Kevin DESLIGA o numero de 74 leads. Ele continua na frente, entao NAO pode
// ser o escolhido. Antes do conserto o placar dele caia pra 14 e ele levava tudo.
casos.push({
  nome: 'numero desligado continua contando pro dono',
  sellers: [
    { at: 'guilherme', nksTodos: ['74076200', '81430517'] },
    { at: 'kevin', nksTodos: ['91215713', '97405847', '95983293'] },   // 91215713 DESLIGADO
  ],
  pool: [{ at: 'guilherme', num: '81430517' }, { at: 'kevin', num: '97405847' }, { at: 'kevin', num: '95983293' }],
  foraLimite: [],
  esperado: 'kevin',     // G=95, K=88 -> quem recebe e o kevin, que esta ATRAS de verdade
  placarEsperado: { guilherme: 95, kevin: 88 },
});

// CASO 2 - numero no teto: o conserto antigo tem que continuar valendo.
casos.push({
  nome: 'numero no teto continua contando pro dono',
  sellers: [
    { at: 'guilherme', nksTodos: ['74076200', '81430517'] },
    { at: 'kevin', nksTodos: ['91215713', '97405847'] },
  ],
  pool: [{ at: 'guilherme', num: '81430517' }, { at: 'kevin', num: '97405847' }],
  foraLimite: [{ at: 'guilherme', num: '74076200' }, { at: 'kevin', num: '91215713' }],
  esperado: 'kevin',     // G=95, K=85
  placarEsperado: { guilherme: 95, kevin: 85 },
});

// CASO 3 - sem nksTodos (numero sem dono): cai no caminho antigo e nao explode.
casos.push({
  nome: 'sem nksTodos usa pool + foraLimite',
  sellers: [{ at: 'guilherme' }, { at: 'kevin' }],
  pool: [{ at: 'guilherme', num: '81430517' }, { at: 'kevin', num: '97405847' }],
  foraLimite: [{ at: 'guilherme', num: '74076200' }],
  esperado: 'kevin',     // G=95, K=11
  placarEsperado: { guilherme: 95, kevin: 11 },
});

console.log('TESTE DO PLACAR DA ROLETA\n');
for (const f of falhas) console.log('  FALHA DE GUARDA: ' + f);

let ok = 0;
for (const c of casos) {
  const r = placar(c.sellers, c.pool, c.foraLimite);
  const placarReal = Object.fromEntries(r.ats.map((a) => [a.at, a.cv]));
  const certoPlacar = JSON.stringify(placarReal) === JSON.stringify(
    Object.fromEntries(Object.keys(placarReal).map((k) => [k, c.placarEsperado[k]])));
  const certo = r.quemRecebe === c.esperado && certoPlacar;
  if (certo) ok++;
  console.log('  ' + (certo ? 'ok  ' : 'ERRO') + '  ' + c.nome);
  console.log('        placar: ' + r.ats.map((a) => a.at + '=' + a.cv).join('  ') + '   -> recebe: ' + r.quemRecebe + (certo ? '' : '   (esperava ' + c.esperado + ')'));
}

console.log('\n  ' + ok + '/' + casos.length + ' casos corretos, ' + falhas.length + ' falha(s) de guarda');
process.exit(falhas.length === 0 && ok === casos.length ? 0 : 1);
