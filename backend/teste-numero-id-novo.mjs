// Teste LOCAL (15/10/2026): numero reconectado no Datacrazy com phone_number_id NOVO. O cron (passo
// 'manutencao', que chama o _dcSyncInstances) tem que levar a nossa linha pro id novo sem perder dono
// nem chave. Bundle real + D1 de mentira; Datacrazy e Graph sao respostas montadas aqui.
// Uso: node teste-numero-id-novo.mjs <pasta do dry-run>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
const schema = JSON.parse(readFileSync(new URL('./teste-schema-producao.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a.map(conv)),
  first: async (col) => { const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
  all: async () => ({ results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }),
  run: async () => { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => { const o = []; for (const s of l) o.push(await s.all()); return o; }, exec: async (s) => sq.exec(s) };

const T_BOA = 'EABR' + 'x'.repeat(300), T_VELHA_SO = 'EABR' + 'y'.repeat(300);
let instancias = [];
globalThis.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u);
  const auth = String((init && init.headers && (init.headers.Authorization || init.headers.authorization)) || '');
  if (url.includes('api.g1.datacrazy.io') && url.includes('/instances')) return new Response(JSON.stringify(instancias), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('graph.facebook.com')) {
    const m = url.match(/v21\.0\/(\d+)\//);
    const id = m ? m[1] : '';
    // a chave boa abre o id NOVO; a "velha" so abria o id velho
    const ok = (auth.endsWith(T_BOA) && id === '1387870527743928') || (auth.endsWith(T_VELHA_SO) && id === '1402895979564465');
    return new Response(JSON.stringify(ok ? { data: [{ about: 'x' }] } : { error: { code: 100, message: 'Object with ID does not exist' } }), { status: ok ? 200 : 400, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};

sq.prepare('INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, 1, 0, ?)').run(JSON.stringify({ leads: [], chips: [] }), 'teste');
sq.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('dc_api_key', 'dc_teste', 0)").run();
const linha = (id, num, nk, at, tok) => sq.prepare("INSERT INTO wa_api_numbers (phone_number_id, display_phone, num_key, waba_id, at_id, verified, created_at, updated_at, token) VALUES (?,?,?,?,?,1,1790952643,0,?)").run(id, num, nk, 'W' + id, at, tok);
linha('1402895979564465', '5511966632248', '1166632248', 'atendente_vra3lh', T_VELHA_SO);   // id velho, chave que so servia nele
linha('1282718478268952', '5515981316574', '1581316574', 'atendente_vra3lh', T_BOA);       // outro numero, chave boa (vira candidata)
linha('1163899650150253', '558291215713', '8291215713', 'atendente_6e3cbf', T_BOA);
const inst = (num, id, status) => ({ name: 'x', status, isActive: true, config: { phoneNumber: num, phoneNumberId: id, wabaId: '1603706191297069', token: 'EAB****oZD' } });

const worker = (await import(pathToFileURL(bundle).href)).default;
const env = { DB };
const pend = [];
const ctx = { waitUntil: (p) => pend.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} };
const batida = async () => {
  // minuto com resto 4 (passo 'manutencao') e volta 1 do rodizio de 4 (onde mora o _dcSyncInstances)
  let alvo = Math.floor(Date.now() / 60000);
  while (!(alvo % 5 === 4 && Math.floor(alvo / 5) % 4 === 1)) alvo++;
  sq.prepare("DELETE FROM app_config WHERE key IN ('cron_lock','cron_passo_ult')").run();
  const orig = console.log; console.log = () => {}; const oe = console.error; console.error = () => {};
  try { await worker.scheduled({ scheduledTime: alvo * 60000, cron: '* * * * *' }, env, ctx); while (pend.length) await pend.shift(); }
  finally { console.log = orig; console.error = oe; }
};
const res = [];
const ok = (nome, cond, extra = '') => res.push(`${cond ? 'OK    ' : 'FALHOU'} ${nome}${extra !== '' ? ' (' + extra + ')' : ''}`);
const do2248 = () => sq.prepare("SELECT phone_number_id, waba_id, at_id, token, created_at, verified FROM wa_api_numbers WHERE num_key='1166632248'").all();

// 1) instancia velha DESCONECTADA com id novo nao mexe em nada
instancias = [inst('+55 11 96663-2248', '1387870527743928', 'DISCONNECTED')];
await batida();
ok('desconectada nao muda o id', do2248().length === 1 && do2248()[0].phone_number_id === '1402895979564465', JSON.stringify(do2248().map((x) => x.phone_number_id)));

// 2) conectada com id novo: a linha vai pro id novo, mantem dono e data, e a chave e trocada pela que abre o id novo
instancias = [inst('+55 11 96663-2248', '1387870527743928', 'CONNECTED'), inst('+55 15 98131-6574', '1282718478268952', 'CONNECTED')];
await batida();
const r = do2248();
ok('uma linha so pro numero', r.length === 1, r.length);
ok('id novo', r[0] && r[0].phone_number_id === '1387870527743928', r[0] && r[0].phone_number_id);
ok('waba nova', r[0] && r[0].waba_id === '1603706191297069', r[0] && r[0].waba_id);
ok('dono mantido', r[0] && r[0].at_id === 'atendente_vra3lh');
ok('data de cadastro mantida', r[0] && r[0].created_at === 1790952643);
ok('chave trocada pela que abre o id novo', r[0] && r[0].token === T_BOA, r[0] && r[0].token.slice(0, 5));
ok('o outro numero nao mexeu', sq.prepare("SELECT phone_number_id FROM wa_api_numbers WHERE num_key='1581316574'").get().phone_number_id === '1282718478268952');

// 3) batida seguinte: nada muda
await batida();
ok('segunda batida estavel', do2248().length === 1 && do2248()[0].phone_number_id === '1387870527743928' && do2248()[0].token === T_BOA);

console.log(res.join('\n'));
const f = res.filter((x) => x.startsWith('FALHOU')).length;
console.log(f ? `\n${f} FALHA(S)` : `\nTUDO PASSOU (${res.length})`);
process.exit(f ? 1 : 0);
