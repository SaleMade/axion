// TESTE DO REENVIO SEM COBRANCA (11/11/2026).
//
// Caso que trouxe: o cliente pagou o pedido de 19/10 (R$ 500 no Pix), nao retirou na agencia dos
// Correios e o pacote voltou. A equipe cadastrou um pedido novo so pra mandar de novo. Esse pedido
// leva a etiqueta 'reenvio' com o valor ZERO de proposito, e aqui se prova que:
//   1. a marca le certo (zero gravado conta; valor vazio, valor cheio ou sem etiqueta nao contam);
//   2. o evento da PayLog/Payt NAO devolve o preco do kit pro valor zero (rodando a linha de verdade);
//   3. o bot nao conta como pedido nem como recebimento;
//   4. a varredura da cobranca nao da cobrador pra ele;
//   5. a automacao nao agradece pagamento, mas os avisos da entrega continuam.
// O worker.js e um modulo unico sem exports: o teste RECORTA as linhas do arquivo e roda.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const falhas = [];
let n = 0;
const ok = (cond, msg) => { n++; if (!cond) falhas.push(msg); };
const linha = (ini) => { const i = src.indexOf(ini); if (i < 0) return ''; return src.slice(i, src.indexOf('\n', i)); };

// ── 1. a marca ──────────────────────────────────────────────────────────────────────────────────
const L_RE = linha('const _ehReenvio = ');
const L_RSC = linha('const _reenvioSemCobranca = ');
ok(!!L_RE && !!L_RSC, 'nao achei _ehReenvio/_reenvioSemCobranca no worker.js');
const R = new Function('l', L_RE + '\n' + L_RSC + '\nreturn _reenvioSemCobranca(l);');
ok(R({ tags: ['reenvio'], vl: 0 }) === true, 'reenvio com valor 0 nao foi reconhecido');
ok(R({ tags: ['reenvio'], vl: '0' }) === true, 'reenvio com valor "0" (texto) nao foi reconhecido');
ok(R({ tags: ['reenvio'], vl: 397 }) === false, 'reenvio COBRADO (valor 397) virou sem cobranca');
ok(R({ tags: ['reenvio'], vl: '' }) === false, 'valor VAZIO virou sem cobranca (vazio nao e zero)');
ok(R({ tags: ['reenvio'] }) === false, 'reenvio sem valor nenhum virou sem cobranca');
ok(R({ tags: ['urgente'], vl: 0 }) === false, 'pedido de valor 0 sem a etiqueta virou reenvio');
ok(R({ vl: 0 }) === false && R(null) === false && R({}) === false, 'a marca quebrou com pedido sem etiqueta ou nulo');

// ── 2. o valor zero sobrevive ao evento da PayLog e da Payt ──────────────────────────────────────
const refis = [
  ['if ((!lead.vl || lead.vl === 0) && offer.price != null', 'ORDER_CREATE/SHIPPING da PayLog'],
  ['if (_vv > 0', 'CHARGE_UPDATED da PayLog'],
  ['if (data.amount && !lead.vl', 'postback da Payt'],
  ['if (lead_data.valor && !lead.vl', 'lead_data do webhook'],
];
for (const [ini, nome] of refis) {
  const l = linha(ini).trim();
  ok(/_reenvioSemCobranca\(lead\)/.test(l), 'a linha do ' + nome + ' reescreve o valor sem a trava do reenvio: ' + l.slice(0, 90));
  const run = new Function('lead', 'offer', '_vv', 'data', 'lead_data', L_RE + '\n' + L_RSC + '\n' + l + '\nreturn lead.vl;');
  const ctx = [{ price: 497 }, 497, { amount: 497 }, { valor: 497 }];
  ok(run({ tags: ['reenvio'], vl: 0 }, ...ctx) === 0, 'o ' + nome + ' devolveu o preco do kit pro reenvio sem cobranca');
  const comum = run({ tags: [], vl: 0 }, ...ctx);
  ok(comum === 497 || (ini.startsWith('if (_vv') && comum === 497), 'o ' + nome + ' parou de preencher o valor do pedido COMUM (veio ' + comum + ')');
}
ok(!/if \(\(!lead\.vl \|\| lead\.vl === 0\) && offer\.price != null\) lead\.vl/.test(src), 'sobrou um preenchimento do valor pela PayLog sem a trava');

// ── 3. o bot nao conta ──────────────────────────────────────────────────────────────────────────
const L_BC = linha('const _botCancelado = ');
ok(/_reenvioSemCobranca\(l\)/.test(L_BC), 'o bot voltou a contar o reenvio sem cobranca como pedido (_botCancelado)');
const iDados = src.indexOf('async function _botDadosCob(');
ok(iDados > 0 && /if \(_reenvioSemCobranca\(l\)\) continue;/.test(src.slice(iDados, iDados + 4000)), 'o resumo da cobranca do bot voltou a contar o reenvio sem cobranca');
const iUlt = src.indexOf('async function _botUltimoRecebido(');
ok(iUlt > 0 && /_reenvioSemCobranca\(l\)\) continue;/.test(src.slice(iUlt, iUlt + 900)), 'o "ultimo recebido" do bot voltou a contar o reenvio sem cobranca');

// ── 4. a varredura nao da cobrador ──────────────────────────────────────────────────────────────
const iCron = src.indexOf('async function _cronCobrador(');
const cron = src.slice(iCron, iCron + 3000);
const iSkip = cron.indexOf('if (!dono && _reenvioSemCobranca(l)) continue;');
const iPush = cron.indexOf('if (!dono) { semDono.push(l); continue; }');
ok(iSkip > 0 && iPush > iSkip, 'a varredura da cobranca voltou a dar cobrador pro reenvio sem cobranca');

// ── 5. automacao: sem "pagou", com os avisos da entrega ──────────────────────────────────────────
const iAuto = src.indexOf("const idsNovos = ['sai', 'ent', 'ret', 'nach', 'npg', 'atr', 'pag']");
const auto = src.slice(iAuto, iAuto + 3500);
ok(/if \(pago && !_reenvioSemCobranca\(l\)\) \{/.test(auto), 'a automacao voltou a agradecer pagamento no reenvio (ou a pular os avisos da entrega dele)');

if (falhas.length) { console.error('FALHOU ' + falhas.length + ' de ' + n + ':\n - ' + falhas.join('\n - ')); process.exit(1); }
console.log('ok: ' + n + ' checagens do reenvio sem cobranca');
