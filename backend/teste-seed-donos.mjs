// Teste LOCAL (23/11/2026, inspecao): o dono de cada numero (wa_number_owner) so e regravado quando a
// lista de chips MUDA, mesmo com a batida do cron caindo num isolate novo, e a faxina dos orfaos volta
// a rodar com mais de 90 numeros. Bundle real + D1 de mentira (node:sqlite), rede bloqueada.
//
// Por que existe: medido em 22-23/11, toda batida de 'conexao' regravava os ~99 numeros um a um
// (56 mil escritas por dia), porque a assinatura da ultima gravacao morava so na memoria do isolate.
// E a faxina tinha teto de 90 numeros (um `?` por numero) e parou em 30/10.
//
// Uso: npx wrangler deploy --dry-run --outdir <pasta>  e depois  node teste-seed-donos.mjs <pasta>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
const schema = JSON.parse(readFileSync(new URL('./teste-schema-producao.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
let gravacoesDono = 0;
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const conta = (sql) => { if (/^\s*INSERT INTO wa_number_owner/.test(sql)) gravacoesDono++; };
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a.map(conv)),
  first: async (col) => { conta(sql); const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
  all: async () => { conta(sql); return { results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
  run: async () => { conta(sql); const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => { const o = []; for (const s of l) o.push(await s.all()); return o; }, exec: async (s) => sq.exec(s) };
globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });

// o bundle de producao importa cloudflare:sockets, que o node nao tem: copia sem a linha
const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm, 'const connect = () => { throw new Error("sem sockets no teste"); };');
const copia = bundle.replace(/\.m?js$/, '') + '-seed-teste.mjs';
writeFileSync(copia, fonte);
let geracao = 0;
const isolateNovo = async () => (await import(pathToFileURL(copia).href + '?iso=' + (++geracao))).default;

const chipsDe = (n, dono) => Array.from({ length: n }, (_, i) => ({ num: '55119' + String(10000000 + i).padStart(8, '0'), at: typeof dono === 'function' ? dono(i) : dono }));
const gravaEstado = (chips, v) => {
  sq.prepare('DELETE FROM dashboard_state').run();
  sq.prepare('INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, 0, ?)').run(JSON.stringify({ leads: [], chips }), v, 'teste');
};
const env = { DB };
const pend = [];
const ctx = { waitUntil: (p) => pend.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} };
const batidaConexao = async (worker) => {
  // o passo sai do contador: ultimo = 4 faz a proxima batida ser a 0, 'conexao'
  sq.prepare("DELETE FROM app_config WHERE key IN ('cron_lock','cron_passo_ult')").run();
  sq.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('cron_passo_ult', '4', 0)").run();
  const orig = console.log; console.log = () => {}; const oe = console.error; console.error = () => {};
  try { await worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env, ctx); while (pend.length) await pend.shift(); }
  finally { console.log = orig; console.error = oe; }
};
const res = [];
const ok = (nome, cond, extra = '') => res.push(`${cond ? 'OK    ' : 'FALHOU'} ${nome}${extra !== '' ? ' (' + extra + ')' : ''}`);
const linhas = (src) => sq.prepare('SELECT COUNT(*) n FROM wa_number_owner WHERE source = ?').get(src).n;

// 1) primeira batida: grava os 95 donos e guarda a assinatura no banco
let chips = chipsDe(95, (i) => (i % 2 ? 'vend_a' : 'vend_b'));
gravaEstado(chips, 1);
gravacoesDono = 0;
await batidaConexao(await isolateNovo());
ok('1a batida grava os 95 donos', gravacoesDono === 95 && linhas('chips') === 95, gravacoesDono + ' gravacoes, ' + linhas('chips') + ' linhas');
const sig = sq.prepare("SELECT value FROM app_config WHERE key = 'seed_owners_sig'").get();
ok('a assinatura ficou no banco', !!(sig && JSON.parse(sig.value).h), sig && sig.value);

// 2) batida seguinte em OUTRO isolate, lista igual: nao regrava nada
gravacoesDono = 0;
await batidaConexao(await isolateNovo());
ok('isolate novo com a lista igual nao regrava', gravacoesDono === 0, gravacoesDono + ' gravacoes');

// 3) um numero troca de dono: o isolate novo ve a mudanca e regrava
chips = chips.map((c, i) => (i === 3 ? { ...c, at: 'vend_c' } : c));
gravaEstado(chips, 2);
gravacoesDono = 0;
await batidaConexao(await isolateNovo());
const dono3 = sq.prepare('SELECT at_id FROM wa_number_owner WHERE number = ?').get(chips[3].num);
ok('lista mudou: regrava', gravacoesDono === 95 && dono3 && dono3.at_id === 'vend_c', gravacoesDono + ' gravacoes, dono ' + (dono3 && dono3.at_id));

// 4) a faxina dos orfaos com MAIS de 90 numeros: um numero sai da lista e vira chips_off
const saiu = chips[10].num;
chips = chips.filter((_, i) => i !== 10);
gravaEstado(chips, 3);
await batidaConexao(await isolateNovo());
const linhaSaiu = sq.prepare('SELECT source, at_id FROM wa_number_owner WHERE number = ?').get(saiu);
ok('com 94 numeros vivos, o que saiu vira chips_off (sem apagar o dono)', linhaSaiu && linhaSaiu.source === 'chips_off' && !!linhaSaiu.at_id, JSON.stringify(linhaSaiu));
ok('os 94 vivos continuam chips', linhas('chips') === 94, linhas('chips'));

// 5) passou meia hora: regrava mesmo sem mudar (seguro contra linha mexida por fora)
sq.prepare("UPDATE app_config SET value = json_set(value, '$.t', 0) WHERE key = 'seed_owners_sig'").run();
gravacoesDono = 0;
await batidaConexao(await isolateNovo());
ok('assinatura com mais de 30 min: regrava', gravacoesDono === 94, gravacoesDono + ' gravacoes');

for (const r of res) console.log(r);
const falhou = res.filter((r) => r.startsWith('FALHOU')).length;
console.log(falhou ? falhou + ' falharam' : 'TUDO PASSOU (' + res.length + ')');
process.exit(falhou ? 1 : 0);
