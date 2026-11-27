// PARTE PAGA PELO LINK DA PAYT NAO VIRA PAGO (27/11/2026, audio do Heynan: "o pagamento parcial esta
// indo pra Pagos"). Roda o worker inteiro (bundle do wrangler) contra um D1 de mentira, manda o aviso da
// Payt do jeito que ela manda (boleto, total_price em centavos, utm_content=ped<id>) e prova:
//
//  1) boleto de R$ 250 num pedido de R$ 497 com a parte ja anotada pelo cobrador: continua Parcial, na
//     etapa dele, a ficha NAO ganha a parcela inventada "fechou a conta" e a anotada vira confirmada;
//  2) o aviso repetido da mesma transacao (finalizada e depois faturada) nao mexe em nada;
//  3) boleto da parte SEM anotacao: a Payt lanca a parcela; o cobrador anota depois e nao entra em dobro;
//  4) boleto do valor cheio continua virando Pago (e o card vai pra Pago);
//  5) parte que fecha a conta: Pago, com a parcela de verdade (nada de "fechou a conta");
//  6) desconto combinado (valor_neg 400) pago inteiro: Pago;
//  7) estorno da parte paga pelo link tira a parcela da Payt.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-pagamento-parcial-link.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-pagamento-parcial-link.mjs <bundle>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function stmt(sql, args = []) {
  return {
    __sql: sql,
    bind: (...a) => stmt(sql, a.map(conv)),
    first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  };
}
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (l) => { const out = []; for (const s of (l || [])) out.push(/^\s*SELECT/i.test(String(s.__sql || '')) ? await s.all() : await s.run()); return out; },
  exec: async (s) => sq.exec(s),
};
globalThis.fetch = async (u) => { throw new Error('rede bloqueada no teste: ' + String(u).slice(0, 60)); };
const _log = console.log;
console.log = () => {};

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

const agoraS = Math.floor(Date.now() / 1000);
const usuarios = [['dir', 'Diretor', 'diretor'], ['kev', 'Kevin Marques', 'atendente'], ['bry', 'Bryan Amorim', 'cobrador']];
for (const [id, nome, role] of usuarios) sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role);
const TK = { dir: 'd'.repeat(64), bry: 'c'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, agoraS + 86400);
try { sq.exec('CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)'); } catch (_) {}
sq.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run('payt_token', 'chave-de-teste');

const p2 = (n) => String(n).padStart(2, '0');
const dataBr = (diasAtras) => { const d = new Date(Date.now() - diasAtras * 86400000 - 3 * 3600000); return p2(d.getUTCDate()) + '/' + p2(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(); };
const idMs = (dias) => String(Date.now() - dias * 86400000);
const A = idMs(10), B = idMs(11), C = idMs(12), D = idMs(13), E = idMs(14);
const base = (n) => ({ col: 'Cobrança', spg: 'Pendente', at: 'kev', cob: 'bry', vl: 497, five_id: 'PL-ORD' + n, cpf: '0000000000' + n, wa: '3197777000' + n });
const estado = {
  leads: [
    { id: A, nome: 'Ana Boleto Parte', ...base(1), spg: 'Parcial',
      pagamentos: [{ ts: agoraS - 14 * 3600, data: dataBr(0.6), valor: 250, who: 'bry', obs: 'parcial pelo SellWave Web' }] },
    { id: B, nome: 'Bia Parte Sem Anotar', ...base(2) },
    { id: C, nome: 'Caio Boleto Cheio', ...base(3) },
    { id: D, nome: 'Duda Fecha a Conta', ...base(4), spg: 'Parcial',
      pagamentos: [{ ts: agoraS - 12 * 86400, data: dataBr(12), valor: 250, who: 'bry', obs: 'pix' }] },
    { id: E, nome: 'Edu Desconto', ...base(5), valor_neg: 400 },
  ],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-parcial-link.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB, ARQ_SEGREDO: 'segredo-de-teste' };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const chama = async (tk, path, body) => {
  const h = {};
  if (tk) h.authorization = 'Bearer ' + tk;
  if (body) h['content-type'] = 'application/json';
  h['x-sw-maquina'] = 'm1'; h['x-sw-versao'] = '1.26.25';
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.clone().json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};
// O aviso da Payt no formato real (boleto: sem price_without_installments, total em centavos).
const nowPayt = () => { const d = new Date(Date.now() - 3 * 3600000); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':00'; };
const payt = (leadId, n, centavos, tid, status = 'paid') => chama('', '/webhook/payt/chave-de-teste', {
  type: 'order', status, transaction_id: tid, seller_id: 's1', test: false,
  customer: { name: 'Cliente ' + n, doc: '0000000000' + n, phone: '553197777000' + n },
  product: { name: '4 Meses - GlicoSix', price: 49700 },
  link: { title: 'GlicoSix', sources: { utm_content: 'ped' + leadId }, query_params: {} },
  transaction: { payment_method: 'boleto', payment_status: status, total_price: centavos, paid_at: nowPayt() },
  commission: [],
});
const ler = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data);
const lead = (id) => (ler().leads || []).find((l) => String(l.id) === String(id));
const soma = (l) => (l.pagamentos || []).reduce((s, p) => s + (Number(p.valor) || 0), 0);
const notas = (l, re) => (l.hist || []).filter((h) => re.test(String(h.note || ''))).length;

_log('\nBOLETO DA PARTE, COM A PARTE JA ANOTADA PELO COBRADOR\n');
let r = await payt(A, 1, 25000, 'TXA1');
let l = lead(A);
vale('o aviso entra', r.st === 200, r.st + ' ' + JSON.stringify(r.d).slice(0, 100));
vale('NAO vira Pago', l.spg === 'Parcial' && !l.pago_ts, l.spg + ' pago_ts=' + l.pago_ts);
vale('fica na etapa dele (nao vai pra Pago)', l.col === 'Cobrança', l.col);
vale('a ficha nao ganha o resto inventado', (l.pagamentos || []).length === 1 && soma(l) === 250, JSON.stringify(l.pagamentos));
vale('a parte anotada vira confirmada pela Payt', l.pagamentos[0].payt === 'TXA1', JSON.stringify(l.pagamentos[0]));
vale('o historico diz que foi parcial e quanto falta', notas(l, /pagamento parcial, falta R\$ 247,00/) === 1 && notas(l, /ja estava anotada/) === 1, JSON.stringify((l.hist || []).slice(-2)));
vale('sem a nota de "pago pelo link"', notas(l, /Pago pelo link de pagamento|o card vai pra Pago/) === 0);
const fo = sq.prepare("SELECT charge_status FROM five_orders WHERE order_id='PL-ORD1'").get();
vale('o pedido da plataforma nao vira PAID', !fo || fo.charge_status !== 'PAID', JSON.stringify(fo));

_log('\nO MESMO AVISO DE NOVO (faturada)\n');
r = await payt(A, 1, 25000, 'TXA1', 'billed');
l = lead(A);
vale('nao mexe em nada', l.spg === 'Parcial' && (l.pagamentos || []).length === 1 && notas(l, /pagamento parcial/) === 1, l.spg + ' ' + JSON.stringify(l.pagamentos));

_log('\nBOLETO DA PARTE SEM ANOTACAO, O COBRADOR ANOTA DEPOIS\n');
r = await payt(B, 2, 20000, 'TXB1');
l = lead(B);
vale('a Payt lanca a parcela', (l.pagamentos || []).length === 1 && l.pagamentos[0].valor === 200 && l.pagamentos[0].who === 'payt', JSON.stringify(l.pagamentos));
vale('o pedido fica Parcial, na etapa dele', l.spg === 'Parcial' && l.col === 'Cobrança' && !l.pago_ts, l.spg + ' ' + l.col);
r = await chama(TK.bry, '/api/lead/' + B, { patch: { pagamento_add: { valor: 200, obs: 'parcial pelo SellWave Web' }, antes: { spg: 'Parcial', col: 'Cobrança' } } });
l = lead(B);
vale('o cobrador anota a mesma parte', r.st === 200 && r.d.ok && Number(r.d.parcelas) === 1, r.st + ' ' + JSON.stringify(r.d).slice(0, 100));
vale('e ela NAO entra em dobro', (l.pagamentos || []).length === 1 && soma(l) === 200 && l.pagamentos[0].anotada === 'bry', JSON.stringify(l.pagamentos));
vale('continua Parcial', l.spg === 'Parcial', l.spg);
r = await chama(TK.bry, '/api/lead/' + B, { patch: { pagamento_add: { valor: 150, obs: 'pix' }, antes: { spg: 'Parcial', col: 'Cobrança' } } });
l = lead(B);
vale('outra parte de valor diferente entra normal', (l.pagamentos || []).length === 2 && soma(l) === 350 && l.spg === 'Parcial', JSON.stringify(l.pagamentos));

_log('\nBOLETO DO VALOR CHEIO\n');
r = await payt(C, 3, 49700, 'TXC1');
l = lead(C);
vale('vira Pago', l.spg === 'Pago' && !!l.pago_ts, l.spg);
vale('o card vai pra Pago', l.col === 'Pago', l.col);
vale('sem ficha de parcelas', !Array.isArray(l.pagamentos) || l.pagamentos.length === 0, JSON.stringify(l.pagamentos));

_log('\nPARTE QUE FECHA A CONTA\n');
r = await payt(D, 4, 24700, 'TXD1');
l = lead(D);
vale('vira Pago', l.spg === 'Pago' && l.col === 'Pago', l.spg + ' ' + l.col);
vale('a ficha tem as duas partes de verdade', (l.pagamentos || []).length === 2 && soma(l) === 497 && l.pagamentos[1].who === 'payt' && l.pagamentos[1].payt === 'TXD1', JSON.stringify(l.pagamentos));
vale('sem "fechou a conta"', !(l.pagamentos || []).some((p) => /fechou a conta/.test(String(p.obs || ''))));

_log('\nDESCONTO COMBINADO PAGO INTEIRO\n');
r = await payt(E, 5, 40000, 'TXE1');
l = lead(E);
vale('R$ 400 com valor combinado de R$ 400 vira Pago', l.spg === 'Pago' && l.col === 'Pago', l.spg + ' ' + l.col);

_log('\nESTORNO DA PARTE PAGA PELO LINK\n');
r = await payt(B, 2, 20000, 'TXB1', 'refunded');
l = lead(B);
vale('a parcela da Payt sai e a que o cobrador anotou fica', (l.pagamentos || []).length === 1 && soma(l) === 150, JSON.stringify(l.pagamentos));
vale('continua Parcial', l.spg === 'Parcial', l.spg);

_log('\n' + ok + ' ok, ' + falhas.length + ' falharam' + (falhas.length ? ': ' + falhas.join(' | ') : ''));
process.exit(falhas.length ? 1 : 0);
