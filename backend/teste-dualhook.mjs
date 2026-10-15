// Teste LOCAL da integracao Dualhook (15/10/2026): bundle real + D1 de mentira. Confere que o numero
// cadastrado com chave dh_live_ fala com api.dualhook.com (e so com a chave), que a mensagem recebida
// e o eco do celular entram no inbox, e que a midia baixa pela rota da Dualhook.
// Uso: node teste-dualhook.mjs <pasta do dry-run>/worker.js
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

const CHAVE = 'dh_live_' + 'k'.repeat(40);
const chamadas = [];
globalThis.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u);
  const auth = String((init && init.headers && (init.headers.authorization || init.headers.Authorization)) || '');
  chamadas.push({ url, auth });
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://api.dualhook.com/v25.0/')) {
    if (auth !== 'Bearer ' + CHAVE) return J({ error: { message: 'bad key' } }, 401);
    if (/\/v25\.0\/1387870000000001\?fields=/.test(url)) return J({ display_phone_number: '+55 11 95555-0001', verified_name: 'Glico', quality_rating: 'GREEN', id: '1387870000000001' });
    if (/\/v25\.0\/1603700000000001\/message_templates/.test(url)) return J({ data: [{ name: 'oi', status: 'APPROVED', category: 'UTILITY', language: 'pt_BR', components: [] }] });
    if (/\/v25\.0\/MID1$/.test(url)) return J({ url: 'https://api.dualhook.com/v25.0/MID1/content', mime_type: 'audio/ogg', id: 'MID1' });
    if (/\/v25\.0\/MID1\/content$/.test(url)) return new Response(new Uint8Array([79, 103, 103, 83, 1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/ogg' } });
    return J({ error: { message: 'nao previsto ' + url } }, 404);
  }
  if (url.includes('graph.facebook.com')) return J({ error: { message: 'Meta nao devia ser chamada pra numero Dualhook' } }, 400);
  return new Response('{}', { status: 404 });
};

const TOKEN = 'c'.repeat(64);
sq.prepare("INSERT INTO users (id, login, pwd_hash, name, role) VALUES ('dir','dir','x','Diretor','diretor')").run();
sq.prepare("INSERT INTO users (id, login, pwd_hash, name, role) VALUES ('at_g','g','x','Guilherme','atendente')").run();
sq.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 'dir', strftime('%s','now')+86400)").run(TOKEN);
sq.prepare("INSERT INTO dashboard_state (id, data, version, updated_at, updated_by) VALUES (1, ?, 1, 0, 't')").run(JSON.stringify({ chips: [{ id: 'c1', num: '5511955550001', at: 'at_g', em_uso: true, api: true }] }));
const r2 = new Map();
const env = { DB, MEDIA: { put: async (k, v) => { r2.set(k, v); }, get: async (k) => r2.get(k) || null } };
const pend = [];
const ctx = { waitUntil: (p) => pend.push(Promise.resolve(p).catch(() => {})), passThroughOnException: () => {} };
const worker = (await import(pathToFileURL(bundle).href)).default;
const chama = async (metodo, caminho, corpo, autentica = true) => {
  const h = { 'content-type': 'application/json' };
  if (autentica) h.authorization = 'Bearer ' + TOKEN;
  const r = await worker.fetch(new Request('https://axion-api.axion-dash.workers.dev' + caminho, { method: metodo, headers: h, body: corpo ? JSON.stringify(corpo) : undefined }), env, ctx);
  while (pend.length) await pend.shift();
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { st: r.status, j, t };
};
const res = [];
const ok = (n, c, x = '') => res.push((c ? 'OK     ' : 'FALHOU ') + n + (x !== '' ? ' (' + x + ')' : ''));

// 1) tela: endereco e codigo do webhook
let r = await chama('GET', '/api/wa/dualhook/numero');
ok('GET devolve webhook e codigo', r.st === 200 && /\/api\/wa\/cloud$/.test(r.j.webhook_url) && String(r.j.verify_token).length > 8, r.t.slice(0, 120));
// 2) chave errada / formato errado
r = await chama('POST', '/api/wa/dualhook/numero', { phone_number_id: '1387870000000001', waba_id: '1603700000000001', chave: 'EAAB123' });
ok('chave que nao e dh_live_ recusada', r.st === 400 && /dh_live_/.test(r.j.error || ''), r.t.slice(0, 100));
// 3) cadastro certo
chamadas.length = 0;
r = await chama('POST', '/api/wa/dualhook/numero', { phone_number_id: '1387870000000001', waba_id: '1603700000000001', chave: CHAVE });
ok('cadastro ok', r.st === 200 && r.j.ok && r.j.numero && r.j.numero.display_phone === '5511955550001', r.t.slice(0, 160));
ok('conferiu na Dualhook com a chave', chamadas.some((c) => c.url.startsWith('https://api.dualhook.com/v25.0/1387870000000001') && c.auth === 'Bearer ' + CHAVE));
ok('nao tocou na Meta', !chamadas.some((c) => c.url.includes('graph.facebook.com')));
const lin = sq.prepare("SELECT token, waba_id, at_id, verified FROM wa_api_numbers WHERE phone_number_id='1387870000000001'").get();
ok('chave gravada no numero', lin && lin.token === CHAVE && lin.waba_id === '1603700000000001' && lin.verified === 1);
r = await chama('GET', '/api/wa/dualhook/numero');
ok('lista mostra o numero sem a chave', r.j.numeros.length === 1 && !('token' in r.j.numeros[0]) && !r.t.includes(CHAVE));
// 4) templates da conta pela Dualhook
chamadas.length = 0;
r = await chama('GET', '/api/wa/template?waba_id=1603700000000001');
ok('templates lidos pela Dualhook', r.st === 200 && r.j.templates && r.j.templates[0] && r.j.templates[0].name === 'oi', r.t.slice(0, 160));
// 5) dono do numero (Contingencia) pro webhook achar o vendedor
sq.prepare("INSERT OR REPLACE INTO wa_number_owner (number, at_id, instance, source, num_key, created_at, updated_at) VALUES ('5511955550001','at_g','ax_at_g','chips','1155550001',0,0)").run();
// 6) mensagem recebida com audio
chamadas.length = 0;
const ent = (field, value) => ({ object: 'whatsapp_business_account', entry: [{ id: '1603700000000001', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '5511955550001', phone_number_id: '1387870000000001' }, ...value } }] }] });
r = await chama('POST', '/api/wa/cloud', ent('messages', { contacts: [{ wa_id: '5521988887777', profile: { name: 'Lead' } }], messages: [{ from: '5521988887777', id: 'wamid.IN1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'audio', audio: { id: 'MID1', mime_type: 'audio/ogg' } }] }), false);
const msgIn = sq.prepare("SELECT direction, instance, type, media_url FROM wa_messages WHERE msg_id='wamid.IN1'").get();
ok('mensagem do lead no inbox, no vendedor certo', msgIn && msgIn.direction === 'in' && /^ax_at_g/.test(msgIn.instance), JSON.stringify(msgIn));
ok('audio baixado pela rota da Dualhook', chamadas.some((c) => c.url === 'https://api.dualhook.com/v25.0/MID1/content' && c.auth === 'Bearer ' + CHAVE) && msgIn && msgIn.media_url && r2.has(msgIn.media_url), msgIn && msgIn.media_url);
// 7) eco do celular
r = await chama('POST', '/api/wa/cloud', ent('smb_message_echoes', { message_echoes: [{ from: '5511955550001', to: '5521988887777', id: 'wamid.ECO1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Oi, tudo bem? Te mando o audio' } }] }), false);
const eco = sq.prepare("SELECT direction, instance, body FROM wa_messages WHERE msg_id='wamid.ECO1'").get();
ok('o que o vendedor digitou no celular entra como enviada', eco && eco.direction === 'out' && /^ax_at_g/.test(eco.instance) && /Te mando/.test(eco.body), JSON.stringify(eco));
ok('eco nao vira lead novo', !sq.prepare("SELECT 1 FROM sc_ingest_audit WHERE msg_id='wamid.ECO1' AND source='cloud'").get());

console.log(res.join('\n'));
process.exit(res.some((x) => x.startsWith('FALHOU')) ? 1 : 0);
