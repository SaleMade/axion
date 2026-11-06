// A META MENSAL NO /api/podio, NA ROTA DE VERDADE (06/11/2026). Roda o worker inteiro (bundle do
// wrangler) contra um D1 de mentira e prova que o vendedor recebe, por colega, os tres numeros do mes
// que o app do diretor conta no cliente (lib/meta-mensal.js): mes, cheios e marcoTs. Mesma regra:
//   - pedido = card nao cancelado criado no mes corrente (Brasilia), inclusive o manual nao aceito;
//   - cheio  = valor a cobrar (valor_neg, senao vl) >= 497;
//   - marcoTs = quando saiu o 250o pedido do mes (0 se nao chegou);
//   - mundo do afiliado fora; vendedor sem pedido no mes vem zerado, nao ausente;
//   - a constante META_MENSAL vai junto na resposta (meta), e o "ver como" do diretor devolve o mesmo.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-podio-rota.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-podio-rota.mjs <bundle>/worker.js'); process.exit(2); }
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
const exp = agoraS + 86400;
const usuarios = [['dir', 'Diretor', 'diretor'], ['kev', 'Kevin Marques', 'atendente'], ['bar', 'Barbara Lima', 'atendente'], ['zer', 'Zerado Silva', 'atendente'], ['hay', 'Haynan Souza', 'cobrador']];
for (const [id, nome, role] of usuarios) sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role);
const TK = { dir: 'd'.repeat(64), kev: 'b'.repeat(64), hay: 'c'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, exp);

// O MES CORRENTE EM BRASILIA, igual ao worker (_metaMesIni): UTC-3, sem horario de verao.
const brt = new Date(Date.now() - 3 * 3600000);
const mesIni = Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), 1, 3, 0, 0);
const mesAnt = mesIni - 10 * 86400000;        // 10 dias antes do dia 1: mes passado
// O teste roda em qualquer dia do mes: os pedidos ficam entre o dia 1 e AGORA, nunca no futuro.
const janela = Math.max(60000, Date.now() - mesIni - 60000);
const noMes = (frac) => mesIni + Math.floor(janela * frac);
const leads = [
  { id: String(noMes(0.10)), ts: noMes(0.10), nome: 'K cheio', at: 'kev', vl: 497, col: 'A Enviar' },
  { id: String(noMes(0.12)), ts: noMes(0.12), nome: 'K 297', at: 'kev', vl: 297, col: 'Entregues' },
  { id: String(noMes(0.14)), ts: noMes(0.14), nome: 'K negociado', at: 'kev', vl: 497, valor_neg: 450, col: 'Entregues' },
  { id: String(noMes(0.16)), ts: noMes(0.16), nome: 'K frustrado', at: 'kev', vl: 597, col: 'Frustrados' },
  { id: String(noMes(0.18)), ts: noMes(0.18), nome: 'K cancelado', at: 'kev', vl: 497, col: 'Cancelado sem Custo' },
  { id: String(noMes(0.20)), ts: noMes(0.20), nome: 'K cancelado 2', at: 'kev', vl: 497, col: 'Cancelado' },
  { id: String(noMes(0.22)), ts: noMes(0.22), nome: 'K nao aceito', at: 'kev', vl: 697, col: 'A Enviar', orig: 'Manual', aceito: false },
  { id: String(mesAnt), ts: mesAnt, nome: 'K mes passado', at: 'kev', vl: 497, col: 'Pagos', spg: 'Pago', pago_ts: mesAnt + 86400000 },
  { id: String(noMes(0.30)), ts: noMes(0.30), nome: 'K do afiliado', at: 'kev', afl: 'afl_x', vl: 497, col: 'A Enviar' },
  { id: String(noMes(0.05)), ts: noMes(0.05), nome: 'B cheio', at: 'bar', vl: 497, col: 'Pagos', spg: 'Pago', pago_ts: noMes(0.5) },
];
// A CORRIDA: a Barbara faz 251 pedidos no mes (o 250o no instante marcado); o Kevin fica em 5.
let marcoEsperado = 0;
for (let i = 0; i < 251; i++) {
  const t = noMes(0.40 + 0.50 * (i / 251));
  if (i === 249) marcoEsperado = t;
  leads.push({ id: String(t) + i, ts: t, nome: 'B pedido ' + i, at: 'bar', vl: i % 5 === 0 ? 297 : 497, col: 'Enviados' });
}
const estado = { leads, chips: [], pressels: [] };
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-podio.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const chama = async (tk, path) => {
  const h = {};
  if (tk) h.authorization = 'Bearer ' + tk;
  const r = await worker.fetch(new Request('https://x' + path, { method: 'GET', headers: h }), env, ctx);
  let d = {};
  try { d = await r.clone().json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};

_log('\nA META MENSAL NO /api/podio\n');
let r = await chama(TK.kev, '/api/podio');
vale('o vendedor le o podio', r.st === 200 && r.d.ok === true, r.st + ' ' + JSON.stringify(r.d).slice(0, 120));
const v = r.d.vendedores || {};
vale('a constante META_MENSAL vai na resposta', r.d.meta && r.d.meta.faixas && r.d.meta.faixas.length === 5 && r.d.meta.faixas[0].pedidos === 200 && r.d.meta.faixas[0].bonus === 800 && r.d.meta.ticketMin === 497 && r.d.meta.pctCheios === 80 && r.d.meta.corrida.pedidos === 250 && r.d.meta.corrida.bonus === 200, JSON.stringify(r.d.meta));
vale('Kevin: 5 pedidos no mes (2 cancelados, o de mes passado e o do afiliado fora; frustrado e nao aceito dentro)', v.kev && v.kev.mes === 5, JSON.stringify(v.kev));
vale('Kevin: 3 cheios (297 e o negociado pra 450 nao sao)', v.kev && v.kev.cheios === 3, JSON.stringify(v.kev));
vale('Kevin: marcoTs 0 (nao chegou em 250)', v.kev && v.kev.marcoTs === 0, JSON.stringify(v.kev));
vale('Kevin: pedidos do periodo continuam como antes (5 no mes corrente = 5 + 1 do mes passado em "tudo")', v.kev && v.kev.pedidos === 6, JSON.stringify(v.kev));
vale('Barbara: 252 pedidos no mes', v.bar && v.bar.mes === 252, JSON.stringify(v.bar));
vale('Barbara: cheios = 252 - os de 297 (51)', v.bar && v.bar.cheios === 252 - 51, JSON.stringify(v.bar));
vale('Barbara: marcoTs = o instante do 250o pedido do mes', v.bar && v.bar.marcoTs === marcoEsperado, (v.bar && v.bar.marcoTs) + ' x ' + marcoEsperado);
vale('o 250o e o 250o pela ORDEM de criacao, nao o mais novo', v.bar && v.bar.marcoTs < noMes(0.95), '');
vale('vendedor sem pedido vem zerado, nao ausente', v.zer && v.zer.mes === 0 && v.zer.cheios === 0 && v.zer.marcoTs === 0, JSON.stringify(v.zer));
vale('o cobrador nao entra na lista de vendedores', !('hay' in v), Object.keys(v).join(','));

// O diretor vendo como o Kevin recebe o mesmo
r = await chama(TK.dir, '/api/podio?como=kev');
vale('o "ver como" do diretor devolve os mesmos numeros', r.st === 200 && r.d.vendedores && r.d.vendedores.kev && r.d.vendedores.kev.mes === 5 && r.d.vendedores.bar.marcoTs === marcoEsperado, JSON.stringify(r.d.vendedores && r.d.vendedores.kev));
// O filtro de periodo nao mexe no mes
r = await chama(TK.kev, '/api/podio?start=' + noMes(0.9));
vale('o filtro de periodo muda `pedidos`, mas nao `mes`', r.d.vendedores && r.d.vendedores.kev.pedidos === 0 && r.d.vendedores.kev.mes === 5, JSON.stringify(r.d.vendedores && r.d.vendedores.kev));

_log('\n' + ok + ' ok' + (falhas.length ? ', ' + falhas.length + ' FALHOU:\n  - ' + falhas.join('\n  - ') : ''));
process.exit(falhas.length ? 1 : 0);
