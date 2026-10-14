// Teste LOCAL da otimizacao de D1 (14/10/2026): roda o BUNDLE do worker com um D1 de mentira
// (node:sqlite, schema de producao em teste-schema-producao.json, dados ficticios), CONTA as consultas
// que chegam no banco e confere que as respostas continuam as mesmas e que mudanca no estado aparece
// na hora. Nao toca em producao: a rede fica bloqueada.
// Uso: npx wrangler deploy --dry-run --outdir <pasta>  e depois  node teste-desempenho-d1.mjs <pasta>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
const schema = JSON.parse(readFileSync(new URL('./teste-schema-producao.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
const conta = {};
const marca = (sql) => { const k = sql.replace(/\s+/g, ' ').trim().slice(0, 70); conta[k] = (conta[k] || 0) + 1; };
const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a.map(conv)),
  first: async (col) => { marca(sql); const r = sq.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
  all: async () => { marca(sql); return { results: sq.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
  run: async () => { marca(sql); const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
});
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => { const out = []; for (const s of l) out.push(await s.all()); return out; }, exec: async (s) => sq.exec(s) };
globalThis.fetch = async (u) => { throw new Error('rede bloqueada: ' + String(u).slice(0, 50)); };
const quantas = (prefixo) => Object.entries(conta).filter(([k]) => k.startsWith(prefixo)).reduce((a, [, n]) => a + n, 0);
const zera = () => { for (const k of Object.keys(conta)) delete conta[k]; };

const TOKEN = 'a'.repeat(64);
sq.prepare("INSERT INTO users (id, login, pwd_hash, name, role) VALUES ('dir', 'dir', 'x', 'Diretor', 'diretor')").run();
sq.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'dir', strftime('%s','now')+86400)").run(TOKEN);
const estado = (extra) => ({
  leads: [{ id: 1, nome: 'Cliente A', wa: '11999990000', vl: 497, col: 'A Enviar' }],
  salechatPub: { messages: [{ id: 'm1', text: 'ola v1' }], sequences: [], media: [], triggers: [] },
  pressels: [{ id: 12, nome: 'Pressel teste', status: 'publicada', dominio: 'exemplo.shop', vendedores: [{ at: 'at_a', ativo: true }] }],
  chips: [{ id: 'c1', num: '5511911112222', at: 'at_a', em_uso: true }],
  ...extra,
});
let versao = 100;
sq.prepare('INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, ?, strftime(\'%s\',\'now\'), ?)').run(JSON.stringify(estado()), versao, 'teste');
const grava = (extra) => { versao++; sq.prepare('UPDATE dashboard_state SET data=?, version=?, updated_at=strftime(\'%s\',\'now\'), updated_by=? WHERE id=1').run(JSON.stringify(estado(extra)), versao, 'teste'); };

const worker = (await import(pathToFileURL(bundle).href)).default;
const env = { DB };
const pend = [];
const ctx = { waitUntil: (p) => pend.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} };
const chama = async (caminho, opts = {}) => {
  const r = await worker.fetch(new Request('https://axion-api.axion-dash.workers.dev' + caminho, { headers: { authorization: 'Bearer ' + TOKEN }, ...opts }), env, ctx);
  while (pend.length) await pend.shift();
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, j, t };
};
const res = [];
const ok = (nome, cond, extra = '') => res.push(`${cond ? 'OK    ' : 'FALHOU'} ${nome}${extra !== '' ? ' (' + extra + ')' : ''}`);
const BLOB = 'SELECT data, version, updated_at, updated_by FROM dashboard_state';

// 1) GET /api/state: mesma resposta, sem rebaixar o blob quando nada mudou
zera();
let a = await chama('/api/state');
ok('state 1: 200 e versao certa', a.status === 200 && a.j && a.j.version === 100, a.status + ' v=' + (a.j && a.j.version));
ok('state 1: baixou o blob uma vez', quantas(BLOB) === 1, quantas(BLOB));
zera();
let b = await chama('/api/state');
ok('state 2: mesma versao', b.j && b.j.version === 100);
ok('state 2: NAO baixou o blob de novo', quantas(BLOB) === 0, JSON.stringify(conta).slice(0, 200));
ok('state 2: mesmo conteudo', JSON.stringify(a.j.data.leads) === JSON.stringify(b.j.data.leads));
grava({ leads: [{ id: 1, nome: 'Cliente A', wa: '11999990000', vl: 497, col: 'Enviado' }] });
zera();
let c = await chama('/api/state');
ok('state 3: depois da gravacao vem a versao nova', c.j && c.j.version === 101, c.j && c.j.version);
ok('state 3: e o conteudo novo', c.j && c.j.data.leads[0].col === 'Enviado', c.j && c.j.data.leads[0].col);
ok('state 3: baixou o blob uma vez', quantas(BLOB) === 1, quantas(BLOB));

// 2) GET /api/salechat: o json_extract so roda quando a versao muda
zera();
let s1 = await chama('/api/salechat');
let s2 = await chama('/api/salechat');
ok('salechat: mensagens publicadas', s1.j && s1.j.messages && s1.j.messages[0].text === 'ola v1', s1.t.slice(0, 80));
ok('salechat: json_extract uma vez em duas chamadas', quantas('SELECT json_extract(data') === 1, quantas('SELECT json_extract(data'));
grava({ salechatPub: { messages: [{ id: 'm1', text: 'ola v2' }], sequences: [], media: [], triggers: [] } });
let s3 = await chama('/api/salechat');
ok('salechat: publicacao nova aparece na hora', s3.j && s3.j.messages[0].text === 'ola v2', s3.j && s3.j.messages[0].text);

// 3) GET /api/wa/conn: roda com o indice forcado
zera();
let w = await chama('/api/wa/conn');
ok('wa/conn: 200', w.status === 200 && w.j && w.j.ok !== false, w.status + ' ' + w.t.slice(0, 100));
ok('wa/conn: usou o indice da sc_ingest_audit', quantas('SELECT DISTINCT self_number FROM sc_ingest_audit INDEXED BY') === 1, JSON.stringify(Object.keys(conta).filter((k) => k.includes('sc_ingest'))));

// 4) /api/wa/lead: le o estado pelo cache por versao e acha o pedido
zera();
let l1 = await chama('/api/wa/lead?phone=5511999990000');
ok('wa/lead: achou o pedido do telefone', l1.status === 200 && l1.j && l1.j.lead && String(l1.j.lead.id) === '1', l1.t.slice(0, 120));
ok('wa/lead: sem baixar o blob (versao igual)', quantas(BLOB) === 0 && quantas('SELECT data FROM dashboard_state') === 0, JSON.stringify(conta).slice(0, 160));

// 5) roleta: duas visitas seguidas da pressel contam o clique do dia UMA vez (cache de 15s) e as duas
//    saem com numero
grava({
  pressels: [{ id: 12, nome: 'Pressel teste', status: 'ativa', dominio: 'exemplo.shop', vendedores: [{ at: 'at_a' }, { at: 'at_b' }] }],
  chips: [{ id: 'c1', num: '5511911112222', at: 'at_a', em_uso: true }, { id: 'c2', num: '5511933334444', at: 'at_b', em_uso: true }],
});
await new Promise((r) => setTimeout(r, 8500));   // o _getDashData segura a copia por 8s (regra de antes, mantida)
zera();
const destinos = [];
for (let i = 0; i < 3; i++) {
  const r = await worker.fetch(new Request('https://axion-api.axion-dash.workers.dev/p/12?_redir=1&ttclid=TESTE' + i), env, ctx);
  while (pend.length) await pend.shift();
  const _t = await r.text();
  if (process.env.VER) console.log('RESPOSTA', r.status, r.headers.get('location'), _t.slice(0, 400).replace(/\s+/g, ' '));
  // a pagina leva o numero escolhido no link do WhatsApp (whatsapp://send?phone=... / wa.me/...)
  const _m = _t.match(/phone=(\d{10,13})/) || _t.match(/wa\.me\/(\d{10,13})/);
  destinos.push(_m ? _m[1].slice(-4) : ('status ' + r.status));
}
ok('roleta: as 3 visitas sairam com numero', destinos.every((d) => /^\d{4}$/.test(d)), destinos.join(','));
ok('roleta: dividiu entre os dois numeros', new Set(destinos).size === 2, destinos.join(','));
ok('roleta: contou o clique do dia uma vez so', quantas('SELECT num_key, COUNT(*) AS dia FROM tt_pending') === 1, quantas('SELECT num_key, COUNT(*) AS dia FROM tt_pending'));

console.log(res.join('\n'));
const f = res.filter((x) => x.startsWith('FALHOU')).length;
console.log(f ? `\n${f} FALHA(S)` : `\nTUDO PASSOU (${res.length})`);
process.exit(f ? 1 : 0);
