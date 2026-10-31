// RESERVA DO AQUECIMENTO NA ROTA DE VERDADE (31/10/2026). O teste-aquecimento-reserva.mjs prova a
// regra recortada; este roda o worker inteiro (bundle do wrangler) contra um D1 de mentira e prova o
// que so a rota prova: que a leitura do banco funciona (o lote, o indice, os nomes das colunas) e que
// a pagina da pressel, o diag do diretor e a tela do vendedor contam igual. Se a leitura falhasse, a
// roleta voltaria em silencio pro jeito antigo (so o lead) - e por isso o teste confere tambem que
// nao saiu AQUEC_RESERVA_FALHOU no log.
//
// Uso:
//   npx wrangler deploy --dry-run --outdir <dir>
//   node teste-aquecimento-reserva-rota.mjs <dir>/worker.js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [bundle] = process.argv.slice(2);
if (!bundle) { console.error('uso: node teste-aquecimento-reserva-rota.mjs <bundle>/worker.js'); process.exit(2); }
const schema = JSON.parse(readFileSync(new URL('./teste-pedido-refeito-schema.json', import.meta.url), 'utf8'));
const sq = new DatabaseSync(':memory:');
for (const o of schema) { try { sq.exec(o.sql); } catch (_) {} }
sq.exec('CREATE TABLE IF NOT EXISTS swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER, versao TEXT)');
sq.exec('CREATE TABLE IF NOT EXISTS swweb_conn (nk TEXT PRIMARY KEY, st TEXT, espontaneo INTEGER DEFAULT 0, modo TEXT, info TEXT, queda TEXT, por TEXT, ts INTEGER)');
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
const logs = [];
const _log = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };

let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; _log('  OK      ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
  else { falhas.push(nome); _log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

const agora = () => Math.floor(Date.now() / 1000);
const exp = agora() + 86400;
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('dir', 'dir', 'x', 'Diretor', 'DI', 'diretor');
sq.prepare('INSERT INTO users (id,login,pwd_hash,name,abbr,role) VALUES (?,?,?,?,?,?)').run('kev', 'kev', 'x', 'Kevin', 'KE', 'vendedor');
const TK = { dir: 'd'.repeat(64), kev: 'b'.repeat(64) };
for (const k of Object.keys(TK)) sq.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(TK[k], k, exp);

const hojeBR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const A = '88931497', E = '97973450';
const estado = {
  wa_statuses: [{ id: 'st_aq', label: 'Em Aquecimento', papel: 'aquecimento' }, { id: 'st_uso', label: 'Em uso', papel: 'em_uso' }],
  chips: [
    { id: 'cA', num: '(49) 98893-1497', at: 'kev', st: 'aquecimento', wa_st: 'st_aq', warm_start: hojeBR, idx: 69 },
    { id: 'cE', num: '(15) 99797-3450', at: 'kev', em_uso: true, wa_st: 'st_uso', dist: 'limite', lim_dia: 30, lim_ordem: 1, idx: 2 },
  ],
  pressels: [{ id: 1, nome: 'P1', status: 'ativa', vendedores: [{ at: 'kev' }] }],
  leads: [],
};
sq.prepare('INSERT INTO dashboard_state (id,data,version) VALUES (1,?,1)').run(JSON.stringify(estado));

const fonte = readFileSync(bundle, 'utf8').replace(/^import\s*\{([^}]*)\}\s*from\s*['"]cloudflare:[^'"]+['"];?/gm,
  (m, nomes) => nomes.split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const [a, b] = x.split(/\s+as\s+/); return 'const ' + (b || a) + ' = class {};'; }).join(' '));
const copia = bundle.replace(/\.js$/, '') + '-teste-aquec.mjs';
writeFileSync(copia, fonte);
const worker = (await import(pathToFileURL(copia).href)).default;
const env = { DB }, ctx = { waitUntil: () => {} };
const visita = async () => { await worker.fetch(new Request('https://x/w/1'), env, ctx); };
const contaVis = (nk) => sq.prepare('SELECT COUNT(*) n FROM tt_pending WHERE num_key = ?').get(nk).n;
const chama = async (tk, path) => {
  const r = await worker.fetch(new Request('https://x' + path, { headers: { authorization: 'Bearer ' + tk } }), env, ctx);
  return r.json().catch(() => ({}));
};

// o teto da hora, pela mesma tabela do worker (o teste roda a qualquer hora)
const fw = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const DIA_ACUM = JSON.parse(fw.match(/const DIA_ACUM = (\[[^\]]+\])/)[1]);
const hora = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
const lim = Math.max(1, Math.ceil(5 * DIA_ACUM[hora] / 1000));
_log('\nRESERVA DO AQUECIMENTO NA ROTA  (agora ' + hora + 'h BRT: o chip de dia 1 pode ter ' + lim + ' de 5)\n');

// 1) app nunca aberto: o chip leva so o que cabe e o resto vai pro numero de producao
for (let i = 0; i < 10; i++) await visita();
vale('app fechado: 10 visitas, o chip que aquece leva so ' + lim, contaVis(A) === lim && contaVis(E) === 10 - lim, 'aquecimento ' + contaVis(A) + ', producao ' + contaVis(E));

// 2) app aberto ha 1 h e as visitas do chip ficaram 25 min sem virar lead: soltam a vaga
const t = agora();
sq.prepare("INSERT INTO sc_heartbeat (self_number, at_id, instance, wpp_seen, last_seen, meta) VALUES (?,?,?,?,?,?)").run('5549988931497', 'kev', 'ax_kev', 1, t, 'swweb');
sq.prepare('INSERT INTO swweb_uso (nk, user_id, nome, maquina, desde, ate, versao) VALUES (?,?,?,?,?,?,?)').run('4988931497', 'kev', 'Kevin', 'm1', t - 3600, t + 120, '1.25.37');
sq.prepare('UPDATE tt_pending SET ts = ? WHERE num_key = ?').run(t - 25 * 60, A);
const antesA = contaVis(A);
for (let i = 0; i < 6; i++) await visita();
vale('app aberto e visitas velhas sem lead: o chip volta a receber, de novo so ' + lim, contaVis(A) - antesA === lim, String(contaVis(A) - antesA));

// 3) um lead chega por uma das visitas recentes: ele ocupa a vaga que a visita ocupava, nada abre
const v1 = sq.prepare('SELECT id, code FROM tt_pending WHERE num_key = ? ORDER BY ts DESC LIMIT 1').get(A);
sq.prepare('UPDATE tt_pending SET claimed = 1 WHERE id = ?').run(v1.id);
sq.prepare("INSERT INTO wa_lead (phone, pid, ts, inst, src, num) VALUES (?,?,?,?,?,?)").run('5511999990001', '1', agora(), 'ax_kev_' + A, 'code', '5549988931497');
const antes3 = contaVis(A);
for (let i = 0; i < 4; i++) await visita();
vale('lead marcado (o placar de 30 s ainda nao viu): a vaga nao abre duas vezes', contaVis(A) === antes3, String(contaVis(A) - antes3) + ' visita(s) a mais');

// 4) app reaberto agora (1 min): nada solta, mesmo as visitas velhas
sq.prepare('UPDATE tt_pending SET ts = ? WHERE num_key = ? AND claimed = 0').run(agora() - 40 * 60, A);
sq.prepare('UPDATE swweb_uso SET desde = ? WHERE nk = ?').run(agora() - 60, '4988931497');
const antes4 = contaVis(A);
for (let i = 0; i < 4; i++) await visita();
vale('app acabou de abrir: espera 2 min antes de soltar qualquer vaga', contaVis(A) === antes4, String(contaVis(A) - antes4));

// 5) as telas dizem o mesmo que a roleta
const dg = await chama(TK.dir, '/api/pressel/diag');
const p1 = (dg.pressels || []).find((x) => String(x.id) === '1') || {};
const recebe = (p1.numeros || []).map((n) => String(n.num).replace(/\D/g, '').slice(-8));
vale('diag do diretor: a pressel entrega pro numero de producao, nao pro chip segurado', recebe.includes(E) && !recebe.includes(A), JSON.stringify(recebe));
vale('diag do diretor: manda quantos estao a caminho no chip', Number(dg.aquecReserva && dg.aquecReserva[A]) > 0, JSON.stringify(dg.aquecReserva));
vale('diag do diretor: o lead que acabou de chegar ja aparece (1)', Number(dg.leadsHoje && dg.leadsHoje[A]) === 1, JSON.stringify(dg.leadsHoje));
const meus = await chama(TK.kev, '/api/pressel/meus');
vale('tela do vendedor: nao diz "recebendo" no chip segurado', !(meus.recebendo && meus.recebendo[A]) && !!(meus.recebendo && meus.recebendo[E]), JSON.stringify(meus.recebendo));
vale('tela do vendedor: recebe quantos estao a caminho', Number(meus.aquecReserva && meus.aquecReserva[A]) > 0, JSON.stringify(meus.aquecReserva));

const app = await chama(TK.kev, '/api/swweb/numeros');
const lista = Array.isArray(app.numeros) ? app.numeros : (Array.isArray(app) ? app : []);
const linhaA = lista.find((n) => String(n.num || n.numero || '').replace(/\D/g, '').slice(-8) === A);
vale('barra do SellWave Web: o chip segurado sai como "no ritmo" (bateu), nao como "recebendo"',
  !!(linhaA && linhaA.fila && linhaA.fila.st === 'bateu'), JSON.stringify(linhaA && linhaA.fila));

vale('a leitura da reserva nunca falhou (sem AQUEC_RESERVA_FALHOU no log)', !logs.some((l) => /AQUEC_RESERVA_FALHOU/.test(l)),
  logs.filter((l) => /AQUEC_RESERVA_FALHOU/.test(l)).slice(0, 2).join(' | '));

_log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram.');
if (falhas.length) { _log('\nFALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
process.exit(0);
