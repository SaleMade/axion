// ROLETA: NUMERO BANIDO NO MEIO DO DIA NAO APAGA O PLACAR DO DONO (20/10/2026).
//
// O placar da roleta e "quem fez menos lead hoje recebe". Ele soma os leads de hoje de todo numero
// do vendedor (`nksTodos`, devolvido pelo _resolvePresselSellers). Ate hoje so entravam ali os
// numeros "Em uso" e fora do st 'banido'. Quando a Meta bane, o numero perde o "Em uso", os leads
// dele saem da conta do dono e a roleta passa a despejar clique nele.
// Medido em 20/10: a Meta baniu o 1970 (10:26) e o 4144 (10:50) do Kevin, 27 leads sumiram do placar
// dele, e as 11h ele levou 253 cliques contra 0 do Guilherme com o placar real 34 x 33. 133 x 105.
//
// Le o _resolvePresselSellers DO PROPRIO worker.js (recorta e avalia). Copia da logica testaria a copia.
//
//   node teste-roleta-placar-banido.mjs
//   WORKER=<caminho> node teste-roleta-placar-banido.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const nomes = ['_lastDigitsEq', '_waNumKey', '_servConnOk', '_modoRoleta', '_vivoNoApp', '_chipVivo', '_resolvePresselSellers'];
const blocos = nomes.map((n) => [n, funcao(n)]);
const constFora = linha('const _SWWEB_ST_FORA = ');
const faltando = blocos.filter(([, b]) => !b).map(([n]) => n).concat(constFora ? [] : ['_SWWEB_ST_FORA']);
conta('o worker tem as funcoes da roleta', !faltando.length, 'faltando: ' + faltando.join(', '));
if (faltando.length) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1); }

const fabrica = new Function('_chipAquecendo', '_numDoAquecimento',
  'let _apiMorto = new Set(); let _apiMortoEm = 0;\n' + constFora + '\n' + blocos.map(([, b]) => b).join('\n')
  + '\nreturn { _resolvePresselSellers };');
const F = fabrica(() => false, () => null);
const fora = new Set(['restrito', 'banido']);
const roda = (p, chips) => F._resolvePresselSellers(p, chips, new Map(), new Set(), fora, new Set());
const doKevin = (out) => out.find((s) => s.at === 'kevin') || {};

// o Kevin de hoje: um numero de pe, dois que a Meta baniu (perderam o "Em uso", ganharam a tag)
const VIVO = '5582997405847', B1 = '5582991211970', B2 = '5582991214144';
const chips = [
  { num: VIVO, at: 'kevin', wa_st: 'em_uso' },
  { num: B1, at: 'kevin', wa_st: 'banido', st: 'banido', em_uso: false },
  { num: B2, at: 'kevin', wa_st: 'banido', em_uso: false },
  { num: '5515974076200', at: 'guilherme', wa_st: 'em_uso' },
];
const p = { id: 'p1', vendedores: [{ at: 'kevin' }, { at: 'guilherme' }] };

console.log('PLACAR DO VENDEDOR COM NUMERO BANIDO\n');
{
  const k = doKevin(roda(p, chips));
  const nks = k.nksTodos || [];
  conta('o numero banido com st banido continua no placar do Kevin', nks.includes(B1.slice(-8)), JSON.stringify(nks));
  conta('o numero banido so pela tag (sem "Em uso") continua no placar', nks.includes(B2.slice(-8)), JSON.stringify(nks));
  conta('o numero de pe tambem esta la', nks.includes(VIVO.slice(-8)), JSON.stringify(nks));
  conta('e so o numero de pe RECEBE', (k.nums || []).map((n) => String(n.num).slice(-8)).join(',') === VIVO.slice(-8), JSON.stringify(k.nums));
  conta('o placar do Kevin nao leva numero do Guilherme', !nks.includes('74076200'), JSON.stringify(nks));
}
{
  // numero estacionado (sem "Em uso", sem tag) ou desligado no interruptor: lead de hoje continua do dono
  const c2 = chips.concat([{ num: '5582990000001', at: 'kevin', wa_st: 'ativo' }]);
  const pOff = { id: 'p1', vendedores: [{ at: 'kevin', off: { [VIVO.slice(-8)]: true } }, { at: 'guilherme' }] };
  const k = doKevin(roda(pOff, c2.concat([{ num: '5582990000002', at: 'kevin', wa_st: 'em_uso' }])));
  const nks = k.nksTodos || [];
  conta('numero desligado no interruptor continua no placar', nks.includes(VIVO.slice(-8)), JSON.stringify(nks));
  conta('numero que saiu do "Em uso" continua no placar', nks.includes('90000001'), JSON.stringify(nks));
  conta('e quem recebe e so o que esta ligado e Em uso', (k.nums || []).map((n) => String(n.num).slice(-8)).join(',') === '90000002', JSON.stringify(k.nums));
  conta('sem numero repetido no placar', new Set(nks).size === nks.length, JSON.stringify(nks));
}
{
  // os tres numeros do Kevin banidos: ele sai da roleta (nao ha pra quem mandar), sem explodir
  const tudo = chips.map((c) => (c.at === 'kevin' ? { ...c, wa_st: 'banido', em_uso: false } : c));
  const out = roda(p, tudo);
  conta('vendedor sem nenhum numero de pe sai da roleta', !out.find((s) => s.at === 'kevin'), JSON.stringify(out.map((s) => s.at)));
  conta('e o outro continua', !!out.find((s) => s.at === 'guilherme'));
}

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) process.exit(1);
