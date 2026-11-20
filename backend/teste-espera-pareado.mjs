// ESPERA DE 10 MINUTOS DEPOIS DE CONECTAR (20/11/2026, pedido do Bruno: "esperar por 5 a 10 minutos.
// Eu acho que 10 minutos talvez seria um periodo bom"). Roda o worker inteiro (bundle do wrangler)
// contra um D1 de mentira e prova, pelas rotas de verdade:
//
//  1) o QR lido (qr -> pronto, ou o app dizendo `pareou`) comeca a espera, e o POST /conexao devolve
//     ate quando (`livre`);
//  2) quem abre o numero DEPOIS, em outro computador, recebe a mesma hora no GET /proxy;
//  3) reabrir um numero que ja estava conectado NAO e pareamento e nao espera nada, e o "pronto"
//     repetido nao estica a espera;
//  4) as mensagens automaticas da cobranca nao saem pelo numero na espera, e voltam depois dos 10 min.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-espera-pareado.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-espera-pareado.mjs <bundle>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER, versao TEXT)');
sq.exec('CREATE TABLE IF NOT EXISTS swweb_conn (nk TEXT PRIMARY KEY, st TEXT, espontaneo INTEGER DEFAULT 0, modo TEXT, info TEXT, queda TEXT, por TEXT, ts INTEGER)');
sq.exec('CREATE TABLE IF NOT EXISTS swweb_auto (k TEXT PRIMARY KEY, tipo TEXT, nk TEXT, fone TEXT, pedido TEXT, nome TEXT, status TEXT,'
  + ' n INTEGER DEFAULT 0, tent INTEGER DEFAULT 0, criado INTEGER, pego_ts INTEGER, feito_ts INTEGER, maquina TEXT, por TEXT, motivo TEXT)');
for (const x of ['ALTER TABLE wa_messages ADD COLUMN mundo TEXT', 'ALTER TABLE users ADD COLUMN afiliado_id TEXT', 'ALTER TABLE users ADD COLUMN archived INTEGER DEFAULT 0']) { try { sq.exec(x); } catch (_) {} }
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
// O RELOGIO E DO TESTE: 20/11/2026 17:00 de Brasilia, e anda quando o teste manda.
const T0 = Date.UTC(2026, 10, 20, 20, 0, 0);
let AGORA = T0;
Date.now = () => AGORA;
const anda = (seg) => { AGORA += seg * 1000; };
const S = () => Math.floor(AGORA / 1000);
const _log = console.log;
const logs = [];
console.log = (...a) => { logs.push(a.join(' ')); };

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome + (detalhe ? '  ->  ' + String(detalhe).slice(0, 200) : '')); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + String(detalhe).slice(0, 500) : '')); }
};

const usuarios = [['dir', 'Diretor', 'diretor'], ['gui', 'Guilherme', 'atendente'], ['bry', 'Bryan Amorim', 'cobrador'], ['kev', 'Kevin Marques', 'atendente']];
for (const [id, nome, role] of usuarios) {
  sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run(id, id, 'x', nome, nome.slice(0, 2).toUpperCase(), role);
  sq.prepare('UPDATE users SET afiliado_id=NULL, archived=0 WHERE id=?').run(id);
}
const TK = { dir: 'd'.repeat(64), gui: 'b'.repeat(64), bry: 'c'.repeat(64), kev: 'e'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, S() + 30 * 86400);

const NK_GUI = '4988931194', NK_GUI2 = '1172518066', NK_BRY = '1127335679';
const I_BRY = 'ax_bry_27335679';
const estado = {
  wa_statuses: [{ id: 'st_uso', label: 'Em uso', papel: 'em_uso' }],
  chips: [
    { id: 'c1', num: '(49) 98893-1194', at: 'gui', em_uso: true, st: 'ativo' },
    { id: 'c2', num: '(11) 97251-8066', at: 'gui', em_uso: true, st: 'ativo' },
    { id: 'c3', num: '(11) 92733-5679', at: 'bry', em_uso: true, st: 'ativo' },
  ],
  pressels: [],
  leads: [
    { id: '3001', nome: 'Tais Nao Saiu', wa: '(31) 90000-3001', col: 'A Enviar', vl: 497, mod: 'entrega', at: 'kev', cob: 'bry', end: 'Rua A', num: '1', bairro: 'Centro', cidade: 'Betim', uf: 'mg', cep: '32600-000' },
  ],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));
const px = (porta) => ({ host: 'isp.exemplo.com', porta, usuario: 'u', senha: 's', id: 'px' + porta, ver: 1 });
sq.prepare('INSERT INTO app_config (key,value,updated_at) VALUES (?,?,?)').run('swweb_proxies', JSON.stringify({ [NK_GUI]: px(10001), [NK_GUI2]: px(10001), [NK_BRY]: px(10008) }), S());
sq.prepare('INSERT INTO app_config (key,value,updated_at) VALUES (?,?,?)').run('swweb_proxy_banco', JSON.stringify({ px10001: { apelido: 'Proxy 11', host: 'isp.exemplo.com', porta: 10001, usuario: 'u', senha: 's', mexido: 1 }, px10008: { apelido: 'Proxy 18', host: 'isp.exemplo.com', porta: 10008, usuario: 'u', senha: 's', mexido: 1 } }), S());
// o cliente do Bryan escreveu e ninguem respondeu: vira recepcao automatica
sq.prepare('INSERT INTO wa_messages (msg_id, phone, instance, direction, type, body, push_name, ts, mundo) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('m1', '5531900003001', I_BRY, 'in', 'text', 'Olá! Quero acompanhar o meu pedido.', '', S() - 200, '');

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-espera-pareado.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };
const aluga = (nk, quem, maq) => sq.prepare('INSERT OR REPLACE INTO swweb_uso (nk,user_id,nome,maquina,desde,ate,versao) VALUES (?,?,?,?,?,?,?)').run(nk, quem, quem, maq, S() - 600, S() + 120, '1.26.24');
const chama = async (tk, path, body, maquina) => {
  const h = { authorization: 'Bearer ' + tk };
  if (body) h['content-type'] = 'application/json';
  if (maquina) { h['x-sw-maquina'] = maquina; h['x-sw-versao'] = '1.26.24'; }
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  let d = {};
  try { d = await r.json(); } catch (_) { d = {}; }
  return { st: r.status, d };
};
const conexao = (tk, nk, st, extra) => chama(tk, '/api/swweb/conexao', { nk, st, espontaneo: false, modo: '', info: '', queda: null, ...(extra || {}) });
const proxy = (tk, nk) => chama(tk, '/api/swweb/proxy?nk=' + nk);
const itensBry = async () => { aluga(NK_BRY, 'bry', 'mb'); return (await chama(TK.bry, '/api/swweb/auto?nks=' + NK_BRY, null, 'mb')).d; };

_log('\nO QR LIDO NO PC DA DIRECAO COMECA A ESPERA\n');
let r = await conexao(TK.dir, NK_GUI, 'qr');
vale('tela do QR nao comeca nada', r.st === 200 && !r.d.livre, JSON.stringify(r.d));
anda(30);
const pareouEm = S();
r = await conexao(TK.dir, NK_GUI, 'pronto');
vale('qr -> pronto devolve a hora em que os envios voltam (10 min)', r.d.livre === pareouEm + 600 && r.d.espera === 600, JSON.stringify(r.d));
vale('fica registrado quem pareou', (() => { const x = sq.prepare('SELECT * FROM swweb_pareado WHERE nk=?').get(NK_GUI); return x && x.em === pareouEm && x.por === 'dir'; })());

_log('\nO VENDEDOR ABRE NO PC DELE 4 MINUTOS DEPOIS (o caso do 1194)\n');
anda(240);
r = await proxy(TK.gui, NK_GUI);
vale('o GET da proxy leva a mesma hora pro outro computador', r.st === 200 && r.d.proxy && r.d.livre === pareouEm + 600, JSON.stringify({ livre: r.d.livre, esperado: pareouEm + 600 }));
r = await conexao(TK.gui, NK_GUI, 'sincronizando');
anda(20);
r = await conexao(TK.gui, NK_GUI, 'pronto');
vale('o "pronto" no PC dele devolve a mesma hora, sem esticar', r.d.livre === pareouEm + 600, JSON.stringify(r.d));
vale('a hora do pareamento nao mudou', sq.prepare('SELECT em FROM swweb_pareado WHERE nk=?').get(NK_GUI).em === pareouEm);

_log('\nDEPOIS DOS 10 MINUTOS, LIVRE\n');
anda(600 - (S() - pareouEm) + 1);
r = await proxy(TK.gui, NK_GUI);
vale('passou dos 10 min: o GET da proxy nao segura mais', r.st === 200 && r.d.livre === 0, JSON.stringify({ livre: r.d.livre }));
r = await conexao(TK.gui, NK_GUI, 'sincronizando');
r = await conexao(TK.gui, NK_GUI, 'pronto');
vale('reabrir conectado (sincronizando -> pronto) nao e pareamento', r.d.livre === 0, JSON.stringify(r.d));

_log('\nREABRIR UM NUMERO QUE JA ESTAVA CONECTADO NAO ESPERA\n');
r = await conexao(TK.gui, NK_GUI2, 'sincronizando');
r = await conexao(TK.gui, NK_GUI2, 'pronto');
vale('numero que nunca pediu QR abre livre', r.d.livre === 0 && !sq.prepare('SELECT 1 FROM swweb_pareado WHERE nk=?').get(NK_GUI2), JSON.stringify(r.d));
r = await proxy(TK.gui, NK_GUI2);
vale('e o GET da proxy tambem diz livre', r.d.livre === 0);

_log('\nO APP NOVO AVISA O PAREAMENTO QUE O SERVIDOR NAO VIU\n');
// QR lido entre duas batidas: o servidor so viu "sincronizando" antes do "pronto"
r = await conexao(TK.gui, NK_GUI2, 'sincronizando');
r = await conexao(TK.gui, NK_GUI2, 'pronto', { pareou: true });
vale('`pareou` do app comeca a espera mesmo sem o qr no servidor', r.d.livre === S() + 600, JSON.stringify(r.d));

_log('\nCAIU (QR depois de conectado) E BLOQUEADO TAMBEM SAO TELA DE QR\n');
anda(700);
r = await conexao(TK.gui, NK_GUI2, 'caiu');
r = await conexao(TK.gui, NK_GUI2, 'pronto');
vale('caiu -> pronto comeca a espera', r.d.livre === S() + 600, JSON.stringify(r.d));

_log('\nAS AUTOMATICAS DA COBRANCA ESPERAM\n');
r = await chama(TK.dir, '/api/cob/auto', { rec: true, recr: true, pos: true, sai: true, ent: true, ret: true, nach: true, npg: true, atr: true, pag: true });
vale('a direcao liga as automaticas', r.st === 200, JSON.stringify(r.d).slice(0, 120));
let d = await itensBry();
vale('sem pareamento, a recepcao sai pelo numero do Bryan', (d.itens || []).length > 0, JSON.stringify((d.itens || []).map((x) => x.tipo)));
await conexao(TK.bry, NK_BRY, 'qr');
r = await conexao(TK.bry, NK_BRY, 'pronto');
vale('o Bryan pareou agora', r.d.livre === S() + 600);
d = await itensBry();
vale('na espera, nada sai pelo numero dele', Array.isArray(d.itens) && d.itens.length === 0, JSON.stringify(d));
anda(601);
d = await itensBry();
vale('passados os 10 min, a recepcao volta', (d.itens || []).length > 0, JSON.stringify((d.itens || []).map((x) => x.tipo)));

vale('o log diz quem pareou', logs.some((l) => /SWWEB_PAREOU nk=4988931194 por=dir antes=qr app=0/.test(l)), logs.filter((l) => /PAREOU/.test(l)).join(' | '));

_log('');
console.log = _log;
if (falhas.length) { _log(falhas.length + ' FALHA(S): ' + falhas.join(' | ')); process.exit(1); }
_log('  ' + ok + ' conferencias, todas passaram.');
