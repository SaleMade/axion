// FECHOU O APP / TETO DE NUMEROS ABERTOS NA ROTA DE VERDADE (31/10/2026). O teste-app-fechado.mjs
// prova a regra recortada; este roda o worker inteiro (bundle do wrangler) contra um D1 de mentira e
// prova o que so a rota prova: que o interruptor recusa LIGAR com o app do dono fechado (pelas duas
// rotas, a da direcao e a do vendedor), que o aviso de fechamento do app desliga tudo da pessoa, e
// que o teto de numeros abertos gravado pela direcao chega na lista que o app do vendedor le.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-app-fechado-rota.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-app-fechado-rota.mjs <bundle>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER, versao TEXT)');
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

const exp = Math.floor(Date.now() / 1000) + 86400;
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('dir', 'dir', 'x', 'Diretor', 'DI', 'diretor');
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('kev', 'kev', 'x', 'Kevin Marques', 'KE', 'vendedor');
const TK = { dir: 'd'.repeat(64), kev: 'b'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, exp);

const E = '97973450', NUM = '(15) 99797-3450', NK_APP = '1597973450';
const estado = {
  wa_statuses: [{ id: 'st_uso', label: 'Em uso', papel: 'em_uso' }],
  chips: [{ id: 'cE', num: NUM, at: 'kev', em_uso: true, wa_st: 'st_uso', idx: 2 }],
  pressels: [{ id: 1, nome: 'P1', status: 'ativa', vendedores: [{ at: 'kev' }] }, { id: 2, nome: 'P2', status: 'ativa', vendedores: [] }],
  leads: [],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-app-fechado.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB }, ctx = { waitUntil: () => {} };
const chama = async (tk, path, body, maquina) => {
  const h = { authorization: 'Bearer ' + tk };
  if (body) h['content-type'] = 'application/json';
  if (maquina) { h['x-sw-maquina'] = maquina; h['x-sw-versao'] = '1.25.38'; }
  const r = await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return { st: r.status, d: await r.json().catch(() => ({})) };
};
const ler = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data);
const ligadoEm = (pid) => {
  const p = ler().pressels.find((x) => x.id === pid);
  const v = (p.vendedores || []).find((x) => x.at === 'kev');
  return !v || !(v.ativo === false || (v.off && v.off[E]));
};
const ligado = () => ligadoEm(1) && ligadoEm(2);
const desligado = () => !ligadoEm(1) && !ligadoEm(2);
const registro = () => { try { return sq.prepare("SELECT por_nome, acao, nk FROM pressel_num_log ORDER BY id").all(); } catch (_) { return []; } };

_log('\nAPP FECHADO E TETO DE NUMEROS ABERTOS NA ROTA\n');

// 1) desligar sempre pode, com o app aberto ou fechado
let r = await chama(TK.dir, '/api/pressel/num', { at: 'kev', num: NUM, on: false });
vale('a direcao DESLIGA o numero do Kevin com o app dele fechado', r.st === 200 && desligado(), r.st + ' ' + JSON.stringify(r.d).slice(0, 80));

// 2) ligar com o app do dono fechado e recusado, com a frase, pelas duas rotas
r = await chama(TK.dir, '/api/pressel/num', { at: 'kev', num: NUM, on: true });
vale('a direcao NAO liga com o app do Kevin fechado (409)', r.st === 409 && desligado(), r.st);
vale('e a frase diz quem esta com o app fechado', /^Kevin está com o SellWave Web fechado/.test(String(r.d.error || '')), r.d.error);
r = await chama(TK.kev, '/api/pressel/meu-numero', { num: NUM, on: true });
vale('o vendedor tambem nao liga pela tela dele na dash com o app fechado (409)', r.st === 409 && desligado(), r.st);
vale('e a frase diz o que fazer', /^Abra o SellWave Web pra ligar/.test(String(r.d.error || '')), r.d.error);

// 3) abriu o numero no app (aluguel): liga
r = await chama(TK.kev, '/api/swweb/uso', { nk: NK_APP }, 'm1');
vale('o Kevin abre o numero no app (aluguel de uso)', r.st === 200 && r.d.ok === true, r.st + ' ' + JSON.stringify(r.d).slice(0, 80));
r = await chama(TK.kev, '/api/pressel/meu-numero', { num: NUM, on: true });
vale('com o app aberto, ele liga', r.st === 200 && ligado(), r.st + ' ' + JSON.stringify(r.d).slice(0, 80));

// 4) o app avisa que esta fechando: desliga tudo dele, na hora
r = await chama(TK.kev, '/api/swweb/fechando', { por: 'fechou o app' }, 'm1');
vale('o aviso de fechamento desliga os numeros dele em todas as pressels', r.st === 200 && r.d.desligou === 1 && desligado(), r.st + ' ' + JSON.stringify(r.d));
{
  const reg = registro();
  const ult = reg[reg.length - 1] || {};
  vale('e fica no registro como "Sistema (fechou o SellWave Web)"', ult.por_nome === 'Sistema (fechou o SellWave Web)' && ult.acao === 'desliga' && ult.nk === E, JSON.stringify(ult));
}
r = await chama(TK.kev, '/api/swweb/fechando', { por: 'fechou o app' }, 'm1');
vale('aviso repetido nao grava de novo', r.st === 200 && r.d.desligou === 0, JSON.stringify(r.d));
r = await chama(TK.kev, '/api/swweb/fechando', { por: 'fechou o app' });
vale('sem identificar a maquina, recusa (nao da pra saber qual aluguel ignorar)', r.st === 400, r.st);

// 5) o teto de numeros abertos: da direcao, chega na lista do vendedor
r = await chama(TK.kev, '/api/swweb/config', { maxAbertos: 9 }, 'm1');
vale('o vendedor nao muda o teto de numeros abertos (403)', r.st === 403, r.st + ' ' + (r.d.error || ''));
r = await chama(TK.dir, '/api/swweb/config', { maxAbertos: 8 }, 'm9');
vale('a direcao grava 8', r.st === 200 && r.d.maxAbertos === 8, r.st + ' ' + JSON.stringify(r.d).slice(0, 100));
r = await chama(TK.kev, '/api/swweb/numeros', null, 'm1');
vale('e a lista que o app do vendedor le traz o 8', r.st === 200 && r.d.config && r.d.config.maxAbertos === 8, JSON.stringify(r.d.config));
vale('sem perder as duas regras de proxy', r.d.config && r.d.config.travaProxy === true && r.d.config.exigirBrasil === true, JSON.stringify(r.d.config));
r = await chama(TK.dir, '/api/swweb/config', { maxAbertos: 50 }, 'm9');
vale('mais de 20 vira 20 (o mesmo corte do app)', r.st === 200 && r.d.maxAbertos === 20, JSON.stringify(r.d).slice(0, 80));
r = await chama(TK.dir, '/api/swweb/config', { maxAbertos: 0 }, 'm9');
vale('zero e recusado', r.st === 400, r.st);
r = await chama(TK.dir, '/api/swweb/config', { travaProxy: false }, 'm9');
vale('desligar a trava de proxy continua recusado (409)', r.st === 409, r.st);

// 6) AQUECIMENTO COM O APP FECHADO VAI PRO PLANTAO (05/11/2026, pedido do Bruno: os leads da
//    madrugada aquecem o chip). A direcao clica pra ligar o numero em aquecimento do Kevin com o app
//    dele fechado: em vez do 409, ele fica desligado com a marca do plantao. Producao segue recusada.
sq.exec('DELETE FROM swweb_uso');   // ninguem com o app aberto
const AQ = '88931194', AQ_NUM = '(49) 98893-1194';
{
  const d = ler();
  d.chips.push({ id: 'cA', num: AQ_NUM, at: 'kev', st: 'aquecimento', warm_start: new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10), idx: 3 });
  for (const p of d.pressels) {
    let v = (p.vendedores || []).find((x) => x.at === 'kev');
    if (!v) { v = { at: 'kev', ativo: true }; (p.vendedores = p.vendedores || []).push(v); }
    v.off = { ...(v.off || {}), [AQ]: true };   // desligado de proposito durante o dia (cinza)
  }
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d));
}
const vAq = (pid) => (ler().pressels.find((x) => x.id === pid).vendedores || []).find((x) => x.at === 'kev') || {};
r = await chama(TK.dir, '/api/pressel/num', { at: 'kev', num: AQ_NUM, on: true });
vale('a direcao clica pra ligar o numero em aquecimento com o app fechado: 200 de plantao', r.st === 200 && r.d.plantao === true && r.d.on === false, r.st + ' ' + JSON.stringify(r.d).slice(0, 120));
vale('ele continua DESLIGADO no interruptor nas duas pressels', !!(vAq(1).off && vAq(1).off[AQ]) && !!(vAq(2).off && vAq(2).off[AQ]));
vale('e ganha a marca do plantao nas duas', !!(vAq(1).app_off && vAq(1).app_off[AQ]) && !!(vAq(2).app_off && vAq(2).app_off[AQ]), JSON.stringify(vAq(1).app_off));
vale('sem "ate amanha" (quem decide a volta e o dono abrir o app)', !(vAq(1).volta && vAq(1).volta[AQ]));
{
  const reg = registro();
  const ult = reg[reg.length - 1] || {};
  vale('e fica no registro como plantao, com o nome de quem clicou', ult.acao === 'plantao' && ult.nk === AQ && ult.por_nome === 'Diretor', JSON.stringify(ult));
}
r = await chama(TK.dir, '/api/pressel/num', { at: 'kev', num: NUM, on: true });
vale('o numero de PRODUCAO continua recusado com o app fechado (409)', r.st === 409, r.st + ' ' + (r.d.error || ''));
r = await chama(TK.kev, '/api/pressel/meu-numero', { num: AQ_NUM, on: true });
vale('o vendedor pela tela dele na dash continua tendo que abrir o app (409)', r.st === 409, r.st + ' ' + (r.d.error || ''));
r = await chama(TK.kev, '/api/swweb/uso', { nk: '4988931194' }, 'm1');
vale('o Kevin abre o app', r.st === 200 && r.d.ok === true, r.st + ' ' + JSON.stringify(r.d).slice(0, 80));
r = await chama(TK.dir, '/api/pressel/num', { at: 'kev', num: AQ_NUM, on: true });
vale('com o app do Kevin aberto, o mesmo clique LIGA de verdade (sem plantao)', r.st === 200 && r.d.on === true && !r.d.plantao && !(vAq(1).off && vAq(1).off[AQ]) && !(vAq(1).app_off && vAq(1).app_off[AQ]), r.st + ' ' + JSON.stringify(r.d).slice(0, 120));


// 7) LIGAR TIRA O DONO DO PLANTAO, ABRIR NAO (10/11/2026). Dois numeros de producao do Kevin com a
//    marca do plantao (o app dele fechou com os dois ligados). Ele ja esta com o app aberto (secao 6)
//    e liga UM: a marca dos DOIS sai, pelas duas rotas do interruptor.
const E2 = '97973451', NUM2 = '(15) 99797-3451';
const marcaOsDois = () => {
  const d = ler();
  if (!d.chips.some((c) => c.id === 'cE2')) d.chips.push({ id: 'cE2', num: NUM2, at: 'kev', em_uso: true, wa_st: 'st_uso', idx: 4 });
  for (const p of d.pressels) {
    let v = (p.vendedores || []).find((x) => x.at === 'kev');
    if (!v) { v = { at: 'kev', ativo: true }; (p.vendedores = p.vendedores || []).push(v); }
    v.off = { ...(v.off || {}), [E]: true, [E2]: true };
    v.app_off = { [E]: true, [E2]: true };
  }
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d));
};
const marcas = (pid) => Object.keys(vAq(pid).app_off || {}).sort().join();
marcaOsDois();
vale('antes: os dois numeros do Kevin de plantao nas duas pressels', marcas(1) === [E, E2].sort().join() && marcas(2) === [E, E2].sort().join(), marcas(1) + ' / ' + marcas(2));
r = await chama(TK.kev, '/api/pressel/meu-numero', { num: NUM, on: true });
vale('o Kevin liga UM numero pela tela dele: 200', r.st === 200, r.st + ' ' + (r.d.error || ''));
vale('e a marca dos DOIS sai nas duas pressels (ele voltou)', !marcas(1) && !marcas(2), marcas(1) + ' / ' + marcas(2));
vale('o outro numero continua desligado: so volta se ele ligar', !!(vAq(1).off && vAq(1).off[E2]) && !!(vAq(2).off && vAq(2).off[E2]));
marcaOsDois();
r = await chama(TK.dir, '/api/pressel/num', { at: 'kev', num: NUM2, on: true });
vale('pela rota do interruptor (a do SellWave Web e da direcao) e igual: ligou um, a marca dos dois sai', r.st === 200 && r.d.on === true && !marcas(1) && !marcas(2), r.st + ' ' + marcas(1) + ' / ' + marcas(2));

_log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram.');
if (falhas.length) { _log('\nFALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
process.exit(0);
