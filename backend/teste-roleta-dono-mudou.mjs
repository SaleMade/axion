// TESTE DO PLACAR DA ROLETA QUANDO O NUMERO MUDA DE DONO (21/10/2026).
//
// O CASO REAL: o (15) 97407-6200 era do Guilherme, fez 72 leads ate as 11:37, a Meta baniu e o chip
// foi arrastado pra coluna `ccol_6` da Contingencia. O placar do vendedor lia os chips de AGORA
// (`nksTodos`), entao os 72 leads sumiram da conta dele: as 14h ele aparecia com 57 contra 127 do
// Kevin e a roleta despejou tudo nele (14h 33x3, 15h 59x25; o dia fechou 222x161). E a quarta mao do
// mesmo bug - 14/10 foi o interruptor, 18/10 a tag, 20/10 o "Em uso" que a Meta tira.
//
// ESTE TESTE RODA O CODIGO DE VERDADE: recorta o bloco do placar do worker.js e executa. O
// teste-roleta-placar.mjs tem uma COPIA do laco escrita a mao (boa pra fixar a regra, mas ela nao
// acompanha o arquivo); aqui o que roda e o que vai pro ar.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

const ini = src.indexOf('  const porAt={};');
const fim = src.indexOf('  const escolhido=escAt.nums[0];', ini);
if (ini < 0 || fim < 0) { console.error('NAO ACHEI o bloco do placar no worker.js'); process.exit(1); }
const trecho = src.slice(ini, fim);

// Guardas do que nao pode voltar a acontecer
if (/porAt\[k\]\.cv \+= \(conv\[nk\]\|\|0\)/.test(trecho)) falhas.push('o placar voltou a somar pelos chips de AGORA (conv por nksTodos)');
if (!/porAt\[k\]\.cv = Number\(leadAt\[k\]\|\|0\)/.test(trecho)) falhas.push('o placar nao sai mais do leadAt (instancia do lead)');
if (!/leadSemInst\[nk\]/.test(trecho)) falhas.push('sumiu a perna do lead sem instancia (volta a perder lead antigo)');
if (!/ats\.sort\(\(a,b\)=>\(a\.cv-b\.cv\)/.test(trecho)) falhas.push('a ordenacao deixou de ser "menos LEAD recebe"');

// Monta a funcao com o trecho real dentro.
const corpo = trecho + '\n  return { ats, escolhido: escAt, menorCv };\n';
const roda = new Function('sellers', 'pool', '_foraLimite', 'conv', 'leadAt', 'leadSemInst', 'k8', 'cargaDia', '_presselNextIndex', '_pickBump', 'env', 'id',
  'return (async () => {' + corpo + '})()');

const k8 = (n) => String(n || '').replace(/\D/g, '').slice(-8);
const cargaDia = () => 0;
const nextIndex = async () => 0;
const bump = () => {};
const chama = (c) => roda(c.sellers, c.pool, c.foraLimite || [], c.conv || {}, c.leadAt || {}, c.leadSemInst || {}, k8, cargaDia, nextIndex, bump, {}, 'p1');

const casos = [];

// CASO 1 - O INCIDENTE DE 21/10. O numero do Guilherme foi pra coluna da Contingencia depois de
// fazer 72 leads. Ele continua NA FRENTE do Kevin, entao nao pode ser o escolhido.
casos.push({
  nome: 'numero que mudou de dono continua contando pra quem fez o lead',
  sellers: [
    { at: 'guilherme', nksTodos: ['95983293', '72518066'] },   // o 74076200 ja saiu dos chips dele
    { at: 'kevin', nksTodos: ['97011859', '97405847', '97973450'] },
  ],
  pool: [{ at: 'guilherme', num: '95983293' }, { at: 'kevin', num: '97973450' }],
  leadAt: { guilherme: 130, kevin: 127 },        // o 6200 (72) esta dentro dos 130: a instancia guarda
  esperado: 'kevin',
  placarEsperado: { guilherme: 130, kevin: 127 },
});

// CASO 2 - o contrario: o dono NOVO nao herda o lead que o numero fez pelo dono antigo.
// (o (15) 99187-2193 fez 6 leads pelo Kevin de manha e virou chip do Guilherme a tarde)
casos.push({
  nome: 'dono novo nao herda o lead feito pelo dono antigo',
  sellers: [
    { at: 'guilherme', nksTodos: ['95983293', '91872193'] },   // o 2193 agora e dele
    { at: 'kevin', nksTodos: ['97405847'] },
  ],
  pool: [{ at: 'guilherme', num: '95983293' }, { at: 'kevin', num: '97405847' }],
  leadAt: { guilherme: 10, kevin: 16 },          // os 6 do 2193 estao no kevin, que foi quem os fez
  esperado: 'guilherme',
  placarEsperado: { guilherme: 10, kevin: 16 },
});

// CASO 3 - lead SEM instancia continua indo pelo dono atual do numero (comportamento antigo).
casos.push({
  nome: 'lead sem instancia cai no dono atual do numero',
  sellers: [
    { at: 'guilherme', nksTodos: ['95983293'] },
    { at: 'kevin', nksTodos: ['97405847'] },
  ],
  pool: [{ at: 'guilherme', num: '95983293' }, { at: 'kevin', num: '97405847' }],
  leadAt: { guilherme: 10, kevin: 10 },
  leadSemInst: { '95983293': 40 },               // 40 leads sem instancia no numero do guilherme
  esperado: 'kevin',
  placarEsperado: { guilherme: 50, kevin: 10 },
});

// CASO 4 - vendedor sem NENHUM lead hoje entra com zero e recebe primeiro.
casos.push({
  nome: 'vendedor zerado recebe primeiro',
  sellers: [
    { at: 'guilherme', nksTodos: ['95983293'] },
    { at: 'barbara', nksTodos: ['73623697'] },
  ],
  pool: [{ at: 'guilherme', num: '95983293' }, { at: 'barbara', num: '73623697' }],
  leadAt: { guilherme: 222 },
  esperado: 'barbara',
  placarEsperado: { guilherme: 222, barbara: 0 },
});

// CASO 5 - o numero que recebe DENTRO do vendedor continua sendo o que fez menos lead hoje.
casos.push({
  nome: 'dentro do vendedor, o numero com menos lead recebe',
  sellers: [{ at: 'guilherme', nksTodos: ['95983293', '66632248'] }],
  pool: [{ at: 'guilherme', num: '95983293' }, { at: 'guilherme', num: '66632248' }],
  conv: { '95983293': 75, '66632248': 1 },
  leadAt: { guilherme: 76 },
  esperado: 'guilherme',
  numEsperado: '66632248',
  placarEsperado: { guilherme: 76 },
});

let certos = 0;
for (const c of casos) {
  let r = null;
  try { r = await chama(c) } catch (e) { falhas.push(c.nome + ': estourou -> ' + (e && e.message)); continue }
  const placar = {}; for (const a of r.ats) placar[a.at] = a.cv;
  const quem = r.ats[0].at;
  const linhas = [];
  for (const [at, v] of Object.entries(c.placarEsperado || {})) {
    if (placar[at] !== v) linhas.push('placar de ' + at + ' deu ' + placar[at] + ' e tinha que dar ' + v);
  }
  if (quem !== c.esperado) linhas.push('quem recebe deu ' + quem + ' e tinha que ser ' + c.esperado);
  if (c.numEsperado && k8(r.escolhido.nums[0].num) !== c.numEsperado) linhas.push('o numero escolhido deu ' + k8(r.escolhido.nums[0].num) + ' e tinha que ser ' + c.numEsperado);
  if (linhas.length) { falhas.push(c.nome + ': ' + linhas.join('; ')); console.log('  FALHOU  ' + c.nome); }
  else { certos++; console.log('  ok      ' + c.nome); }
  console.log('          placar: ' + Object.entries(placar).map(([a, v]) => a + '=' + v).join('  ') + '   -> recebe: ' + quem);
}

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  ' + certos + '/' + casos.length + ' casos corretos, 0 falha(s) de guarda');
