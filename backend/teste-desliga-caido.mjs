// NUMERO QUE CAIU NO WHATSAPP SAI DA ROLETA SOZINHO (21/10/2026).
//
// Pedido do Bruno: "quando o numero cair, se voce conseguir provar 100% de certeza de que ele caiu,
// eu quero que voce desative tambem automaticamente. Claro, o meu vendedor pode ligar de novo".
// Prova = o WhatsApp bloqueou, ou o numero ficou PRONTO nesta mesma abertura (aluguel) e o WhatsApp
// pediu QR de novo. 90 s de espera; voltar a PRONTO cancela; desliga uma vez por queda.
//
// Le as funcoes DO PROPRIO worker.js (recorta e avalia) e roda contra um D1 de mentira em cima do
// node:sqlite, com o SQL de verdade. Copia da logica testaria a copia.
//
//   node teste-desliga-caido.mjs
//   WORKER=<caminho> node teste-desliga-caido.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const fonte = fs.readFileSync(process.env.WORKER || path.join(AQUI, 'worker.js'), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
function funcao(nome) {
  let i = fonte.indexOf('\nfunction ' + nome + '(');
  if (i < 0) i = fonte.indexOf('\nasync function ' + nome + '(');
  if (i < 0) return null;
  const j = fonte.indexOf('{', fonte.indexOf('(', i));
  let nivel = 0;
  for (let k = j; k < fonte.length; k++) {
    const ch = fonte[k];
    if (ch === '{') nivel++;
    else if (ch === '}') { nivel--; if (nivel === 0) return fonte.slice(i + 1, k + 1); }
  }
  return null;
}
const linha = (inicio) => fonte.split('\n').find((l) => l.startsWith(inicio)) || null;

let ok = 0;
const falhas = [];
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome); }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (detalhe ? '   -> ' + detalhe : '')); }
};

const nomes = ['_roletaDesligaNum', '_swwebQuedaTabela', '_swwebMarcaQueda', '_desligaCaidos', '_desligaBanidos',
  '_presselAplicaNum', '_presselEstadoNum', '_presselNumLogEnsure', '_presselNumLog', '_limpaMarcasDesligado', '_amanhaBR',
  '_contMarcaBloqueado', '_contMarcaStatus', '_papelSt', '_papelPeloNomeSt', '_ehVendedorDaCasa'];
const blocos = nomes.map((n) => [n, funcao(n)]);
const consts = ['const _donoDe = ', 'const SWWEB_QUEDA_CONFIRMA = ', 'const _PAPEIS_ST = ', 'const _vendCache = '].map((c) => [c, linha(c)]);
const faltando = blocos.filter(([, b]) => !b).map(([n]) => n).concat(consts.filter(([, l]) => !l).map(([c]) => c));
conta('o worker tem as funcoes da queda e do desligamento', !faltando.length, 'faltando: ' + faltando.join(', '));
if (faltando.length) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1); }

// ── o relogio e o banco de mentira ──────────────────────────────────────────────────────────────
let AGORA = 1792580000;   // 21/10/2026 de manha
Date.now = () => AGORA * 1000;
const sq = new DatabaseSync(':memory:');
const limpa = (a) => a.map((x) => (x === undefined ? null : x));
const DB = {
  prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = limpa(a); return st; },
      async first() { return sq.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sq.prepare(sql).all(...args) }; },
      async run() { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return st;
  },
};
const env = { DB };
sq.exec("CREATE TABLE dashboard_state (id INTEGER PRIMARY KEY, data TEXT, version INTEGER, updated_at INTEGER, updated_by TEXT)");
sq.exec('CREATE TABLE swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER)');
sq.exec('CREATE TABLE swweb_conn (nk TEXT PRIMARY KEY, st TEXT, espontaneo INTEGER DEFAULT 0, modo TEXT, info TEXT, queda TEXT, por TEXT, ts INTEGER)');
sq.exec('CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, archived INTEGER, afiliado_id TEXT)');
sq.exec('CREATE TABLE wa_api_numbers (num_key TEXT, display_phone TEXT, at_id TEXT, status TEXT)');
sq.exec('CREATE TABLE sc_heartbeat (self_number TEXT PRIMARY KEY, at_id TEXT, instance TEXT, wpp_seen INTEGER, last_seen INTEGER, meta TEXT)');
sq.exec("INSERT INTO users VALUES ('dir','diretor',0,NULL),('kevin','vendedor',0,NULL),('gui','vendedor',0,NULL)");

const config = new Map();
const pushes = [];
const fabrica = new Function('env_', '_readConfig', '_writeConfig', '_wpParaPessoa',
  'let _dashCache = null; let _pnlOk = false; let _swQuedaOk = false;\n'
  + consts.map(([, l]) => l).join('\n') + '\n' + blocos.map(([, b]) => b).join('\n')
  + '\nreturn { _swwebMarcaQueda, _desligaCaidos, _desligaBanidos, _roletaDesligaNum, _contMarcaBloqueado, _contMarcaStatus, _ehVendedorDaCasa };');
const F = fabrica(env,
  async (_e, k) => (config.has(k) ? config.get(k) : null),
  async (_e, k, v) => { config.set(k, v); },
  async (_e, id, p) => { pushes.push({ id, ...p }); });

// a operacao: dois numeros do Kevin, um do Guilherme e um de afiliado; duas pressels da casa e uma do afiliado
const K1 = '5515991872193', K2 = '5515991879743', G1 = '5515974076200', AF = '5511999990000';
// O CASO DO PRINT (25/10/2026): numero estacionado numa COLUNA do cadastro, sem vendedor atras.
// Os oito numeros com BANNED na producao naquele dia eram todos assim, e o aviso acordava o Bruno
// as 00:07 pra dizer que um numero parado continuava parado.
const PARADO = '5515981430517';
const nkApp = (n) => String(n).replace(/\D/g, '').replace(/^55/, '').replace(/^(\d\d)9(\d{8})$/, '$1$2');   // como o app manda (DDD + 8)
const k8 = (n) => String(n).replace(/\D/g, '').slice(-8);
// a lista de status igual a dele em 21/10 (ids e papeis de verdade)
const EM_USO = 'st_mpafmypw', BANIDO = 'st_mpah411p', AQUEC = 'st_mpalmegl', REESTAB = 'st_mtyrsx0n', SEMQ = 'st_mulu46p2_9';
const STATUS = [
  { id: EM_USO, label: 'Em Uso', papel: 'em_uso' }, { id: 'st_mpafn8em', label: 'Ativo', papel: 'ativo' },
  { id: 'st_mpafn8zm', label: 'Restrito', papel: 'restrito' }, { id: BANIDO, label: 'Banido', papel: 'banido' },
  { id: AQUEC, label: 'Em Aquecimento', papel: 'aquecimento' }, { id: REESTAB, label: 'Reestabelecido', papel: 'restabelecido' },
  { id: SEMQ, label: 'Sem quedas' },
];
function estadoInicial(extra) {
  const data = {
    wa_statuses: STATUS,
    chips: [
      { num: K1, at: 'kevin', st: 'ativo', wa_st: EM_USO, wa_st2: SEMQ, em_uso: true },
      { num: K2, at: 'kevin', st: 'ativo', wa_st: EM_USO, wa_st2: SEMQ, em_uso: true },
      { num: G1, at: 'gui', st: 'ativo', wa_st: EM_USO, wa_st2: REESTAB, em_uso: true, restab_start: '2026-10-01' },
      { num: AF, at: 'kevin', afl: 'aflX', st: 'ativo', wa_st: EM_USO, em_uso: true },
      { num: PARADO, at: 'ccol_1', st: 'ativo', wa_st: 'st_mpafn8zm', wa_st2: SEMQ, em_uso: false },
    ],
    pressels: [{ id: 1, vendedores: [] }, { id: 12, vendedores: [] }, { id: 99, afl: 'aflX', vendedores: [] }],
    ...(extra || {}),
  };
  sq.exec('DELETE FROM dashboard_state');
  sq.prepare('INSERT INTO dashboard_state VALUES (1, ?, 1, 0, ?)').run(JSON.stringify(data), 'teste');
}
const estado = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data);
const ligadoEm = (num, at, pid) => {
  const p = estado().pressels.find((x) => x.id === pid);
  const v = (p.vendedores || []).find((x) => String(x.at) === at) || {};
  return !(v.ativo === false || (v.off && v.off[k8(num)]));
};
const log = () => sq.prepare("SELECT por_nome, nk, acao FROM pressel_num_log ORDER BY id").all();
const chipDe = (num) => estado().chips.find((c) => k8(c.num) === k8(num));
const poeStatus = (num, wa_st, em_uso) => {
  const d = estado(); const c = d.chips.find((x) => k8(x.num) === k8(num)); c.wa_st = wa_st; c.em_uso = em_uso;
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d));
};
const aluga = (nk, user, desde, ate) => sq.prepare('INSERT INTO swweb_uso VALUES (?,?,?,?,?,?) ON CONFLICT(nk) DO UPDATE SET user_id=excluded.user_id, desde=excluded.desde, ate=excluded.ate').run(nk, user, user, 'maq-' + user, desde, ate);
const solta = (nk) => sq.prepare('DELETE FROM swweb_uso WHERE nk=?').run(nk);
// o que o POST /api/swweb/conexao faz: grava o estado e chama a marca
async function reporta(nk, st, user, queda) {
  sq.prepare("INSERT INTO swweb_conn (nk, st, por, ts) VALUES (?,?,?,?) ON CONFLICT(nk) DO UPDATE SET st=excluded.st, por=excluded.por, ts=excluded.ts").run(nk, st, user, AGORA);
  return F._swwebMarcaQueda(env, nk, st, { id: user }, { queda: queda || null });
}
const anda = (s) => { AGORA += s; };

console.log('\nO 2193 DO KEVIN EM 21/10: PRONTO AS 08:29, QR AS 08:36\n');
estadoInicial();
{
  const nk = nkApp(K1);
  const desde0 = AGORA;
  const renova = () => aluga(nk, 'kevin', desde0, AGORA + 120);   // o app renova a cada 45 s; o `desde` fica
  aluga(nk, 'kevin', AGORA, AGORA + 120);
  anda(40); await reporta(nk, 'pronto', 'kevin');
  for (let i = 0; i < 7; i++) { anda(60); aluga(nk, 'kevin', AGORA - 40 - i * 60 - 60, AGORA + 120); }   // renovacao a cada minuto, `desde` fica
  const m = await reporta(nk, 'qr', 'kevin', { modo: 'REQUIRE_AUTH', motivo: '', ts: AGORA * 1000 });
  conta('QR depois de PRONTO na mesma abertura marca a queda', m === 'caiu', String(m));
  anda(30); await F._desligaCaidos(env);
  conta('com 30 s ainda nao desliga (espera os 90)', ligadoEm(K1, 'kevin', 1) && ligadoEm(K1, 'kevin', 12));
  anda(65); await F._desligaCaidos(env);
  conta('passados 90 s, com o numero ainda fora, desliga nas duas pressels da casa', !ligadoEm(K1, 'kevin', 1) && !ligadoEm(K1, 'kevin', 12));
  conta('o outro numero do Kevin continua ligado', ligadoEm(K2, 'kevin', 1) && ligadoEm(K2, 'kevin', 12));
  const l = log();
  conta('fica no registro como "Sistema (caiu no WhatsApp)"', l.length === 1 && l[0].por_nome === 'Sistema (caiu no WhatsApp)' && l[0].nk === k8(K1) && l[0].acao === 'desliga', JSON.stringify(l));
  const ids = pushes.map((p) => p.id).sort().join(',');
  conta('avisa a direcao e o dono do numero', ids === 'dir,kevin', ids);
  conta('com a mesma tag do aviso de queda (substitui no celular)', pushes.every((p) => p.tag === 'swconn-' + nk), JSON.stringify(pushes.map((p) => p.tag)));
  conta('o texto diz o numero, que virou Restrito e o que fazer quando conectar', /\(15\) 99187-2193/.test(pushes[0].body) && /marquei como Restrito na Contingencia/.test(pushes[0].body) && /volte o status dele na Contingencia e religue o interruptor/.test(pushes[0].body), pushes[0].body);
  conta('o texto nao tem travessao', !/[–—]/.test(pushes[0].body + pushes[0].title));
  pushes.length = 0;
  anda(60); await F._desligaCaidos(env);
  conta('a batida seguinte nao repete nem avisa de novo', log().length === 1 && pushes.length === 0, JSON.stringify(log()));

  // O VENDEDOR RELIGA COM O NUMERO AINDA CAIDO: o sistema nao briga com ele
  const d = estado();
  for (const p of d.pressels) for (const v of (p.vendedores || [])) if (v.off) delete v.off[k8(K1)];
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d));
  anda(60); renova(); await reporta(nk, 'qr', 'kevin'); anda(120); await F._desligaCaidos(env);
  conta('religado na mao com o numero ainda em QR: o sistema nao desliga de novo', ligadoEm(K1, 'kevin', 1) && log().length === 1, JSON.stringify(log()));
  // voltou a PRONTO e caiu de novo: e queda nova, desliga de novo
  anda(30); renova(); await reporta(nk, 'pronto', 'kevin');
  anda(300); renova(); const m2 = await reporta(nk, 'caiu', 'kevin');
  anda(95); await F._desligaCaidos(env);
  conta('depois de PRONTO de novo, a queda seguinte desliga de novo', m2 === 'caiu' && !ligadoEm(K1, 'kevin', 1) && log().length === 2, String(m2) + ' ' + JSON.stringify(log()));
  solta(nk);
}

console.log('\nO QUE NAO E PROVA NAO DESLIGA\n');
estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM swweb_queda'); pushes.length = 0;
{
  // o 9743 em 21/10: pronto ONTEM, fechado, e hoje abriu ja em QR
  const nk = nkApp(K2);
  aluga(nk, 'kevin', AGORA, AGORA + 120); anda(30); await reporta(nk, 'pronto', 'kevin');
  solta(nk); anda(50000);
  aluga(nk, 'kevin', AGORA, AGORA + 120); anda(10);
  const m = await reporta(nk, 'qr', 'kevin', { modo: 'REQUIRE_AUTH', motivo: '', ts: AGORA * 1000 });
  anda(200); await F._desligaCaidos(env);
  conta('QR ao abrir (o PRONTO foi de outra abertura) nao marca nem desliga', m === null && ligadoEm(K2, 'kevin', 1), String(m));
  solta(nk);
}
{
  // piscada: QR e PRONTO de novo antes dos 90 s
  const nk = nkApp(K2);
  aluga(nk, 'kevin', AGORA, AGORA + 120); anda(20); await reporta(nk, 'pronto', 'kevin');
  anda(60); const m = await reporta(nk, 'qr', 'kevin');
  anda(40); await reporta(nk, 'pronto', 'kevin');
  anda(120); await F._desligaCaidos(env);
  conta('caiu e voltou a PRONTO antes dos 90 s: nao desliga', m === 'caiu' && ligadoEm(K2, 'kevin', 1) && !log().length, JSON.stringify(log()));
  solta(nk);
}
{
  // quem reporta nao e quem esta com o numero aberto
  const nk = nkApp(K2);
  aluga(nk, 'kevin', AGORA, AGORA + 120); anda(20); await reporta(nk, 'pronto', 'kevin');
  anda(60); const m = await reporta(nk, 'qr', 'gui');
  conta('QR reportado por outra pessoa (sem o aluguel) nao marca', m === null, String(m));
  // o aluguel venceu (app fechado a forca)
  anda(400); const m2 = await reporta(nk, 'qr', 'kevin');
  conta('com o aluguel vencido nao marca', m2 === null, String(m2));
  anda(200); await F._desligaCaidos(env);
  conta('e nada foi desligado', ligadoEm(K2, 'kevin', 1) && !log().length);
  solta(nk);
}
{
  // offline, conflito e proxy nao sao queda
  const nk = nkApp(K2);
  aluga(nk, 'kevin', AGORA, AGORA + 120); anda(20); await reporta(nk, 'pronto', 'kevin');
  const r = [];
  for (const st of ['offline', 'conflito', 'proxy', 'sincronizando', 'naosei', 'fechado']) { anda(5); aluga(nk, 'kevin', AGORA - 25, AGORA + 120); r.push(await reporta(nk, st, 'kevin')); }
  anda(200); await F._desligaCaidos(env);
  conta('offline, conflito, proxy, sincronizando, naosei e fechado nao marcam', r.every((x) => x === null) && ligadoEm(K2, 'kevin', 1), JSON.stringify(r));
  solta(nk);
}

{
  // O 3697 DA BARBARA EM 21/10: janela aberta desde ONTEM, o aluguel venceu e voltou hoje (`desde`
  // novo) e o PRONTO ficou pra tras. Quem prova que estava conectado nesta abertura e a batida.
  const nk = nkApp(K2);
  aluga(nk, 'kevin', AGORA, AGORA + 120); anda(20); await reporta(nk, 'pronto', 'kevin');
  anda(86400); aluga(nk, 'kevin', AGORA, AGORA + 120);   // aluguel novo, mesma janela
  const bate = () => sq.prepare("INSERT INTO sc_heartbeat VALUES (?, 'kevin', 'ax_kevin', 1, ?, 'swweb') ON CONFLICT(self_number) DO UPDATE SET last_seen=excluded.last_seen, meta=excluded.meta").run('55' + nk, AGORA);
  const d1 = AGORA;
  anda(60); bate(); anda(60); bate(); anda(30); aluga(nk, 'kevin', d1, AGORA + 120);   // renovado, o desde fica
  const m = await reporta(nk, 'qr', 'kevin');
  anda(95); await F._desligaCaidos(env);
  conta('janela antiga com batida autenticada neste aluguel: a queda desliga', m === 'caiu' && !ligadoEm(K2, 'kevin', 1), String(m));
  sq.exec('DELETE FROM swweb_queda'); solta(nk); estadoInicial(); sq.exec('DELETE FROM pressel_num_log'); pushes.length = 0;
  // batida so de ANTES do aluguel (abertura anterior): nao prova nada
  aluga(nk, 'kevin', AGORA + 10, AGORA + 130); anda(20);
  const m2 = await reporta(nk, 'qr', 'kevin');
  conta('batida so da abertura anterior nao marca', m2 === null, String(m2));
  // batida de outra fonte (Sale Chat) tambem nao
  sq.exec("UPDATE sc_heartbeat SET last_seen = " + (AGORA + 5) + ", meta = 'sc'");
  const m3 = await reporta(nk, 'qr', 'kevin');
  conta('batida que nao e do SellWave Web nao marca', m3 === null, String(m3));
  sq.exec('DELETE FROM sc_heartbeat'); solta(nk);
}

console.log('\nBLOQUEIO, AFILIADO E BATIDAS SOBREPOSTAS\n');
estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM swweb_queda'); pushes.length = 0;
{
  // o WhatsApp bloqueou: e afirmacao dele, nao precisa do PRONTO antes
  const nk = nkApp(G1);
  aluga(nk, 'gui', AGORA, AGORA + 120); anda(10);
  const m = await reporta(nk, 'bloqueado', 'gui', { modo: 'LOGOUT_REASON', motivo: 'account_locked', ts: AGORA * 1000 });
  anda(95);
  await Promise.all([F._desligaCaidos(env), F._desligaCaidos(env), F._desligaCaidos(env)]);
  conta('bloqueado pelo WhatsApp marca sem precisar do PRONTO', m === 'bloqueado', String(m));
  conta('e desliga com "Sistema (bloqueado no WhatsApp)"', !ligadoEm(G1, 'gui', 1) && log().length === 1 && log()[0].por_nome === 'Sistema (bloqueado no WhatsApp)', JSON.stringify(log()));
  conta('tres batidas ao mesmo tempo: um desligamento e um aviso por pessoa', pushes.length === 2, String(pushes.length));
  conta('o aviso traz o motivo do WhatsApp', /account_locked/.test(pushes[0].body), pushes[0].body);
  // A CONTINGENCIA (pedido do Bruno em 21/10): bloqueio de verdade vira o status Banido no cartao
  const c = chipDe(G1);
  conta('bloqueado no WhatsApp: o cartao vira Banido na Contingencia', c.wa_st === BANIDO, c.wa_st);
  conta('e sai do Em uso, como o seletor da tela faz', c.em_uso === false, String(c.em_uso));
  conta('o restab_start zera (o handleChipSave faz igual)', c.restab_start === '', String(c.restab_start));
  conta('a segunda marcacao, a coluna e o dono nao mudam', c.wa_st2 === REESTAB && c.at === 'gui', JSON.stringify({ wa_st2: c.wa_st2, at: c.at }));
  conta('o aviso conta que marcou', /marquei como Banido na Contingencia/.test(pushes[0].body), pushes[0].body);
  conta('o aviso nao tem travessao', !/[–—]/.test(pushes[0].body + pushes[0].title));
  solta(nk);
}
{
  // so CAIU (pediu QR): desliga da roleta e o cartao vira RESTRITO (24/10/2026, pedido do Bruno: "toda
  // vez que o numero for desconectado ou for restrito (...) saia do status de em uso e seja marcado como
  // restrito"). Nunca Banido: desconectar nao e bloqueio.
  estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM swweb_queda'); pushes.length = 0;
  const nk = nkApp(K1);
  aluga(nk, 'kevin', AGORA, AGORA + 120); anda(20); await reporta(nk, 'pronto', 'kevin');
  anda(60); await reporta(nk, 'qr', 'kevin'); anda(95); await F._desligaCaidos(env);
  const c = chipDe(K1);
  conta('numero que caiu sai da roleta e o cartao vira Restrito, fora do Em uso', !ligadoEm(K1, 'kevin', 1) && c.wa_st === 'st_mpafn8zm' && c.em_uso === false, JSON.stringify({ wa_st: c.wa_st, em_uso: c.em_uso }));
  conta('a segunda marcacao (Sem quedas) e decisao dele: fica', c.wa_st2 === SEMQ, c.wa_st2);
  solta(nk);
}
{
  // aquecimento que cai: Restrito, campo ativo, e o relogio do aquecimento FICA (restrito e passageiro)
  estadoInicial(); pushes.length = 0;
  const d = estado(); const c0 = d.chips.find((x) => k8(x.num) === k8(K2)); c0.st = 'aquecimento'; c0.wa_st = AQUEC; c0.warm_start = '2026-10-20'; c0.em_uso = false;
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d));
  const r = await F._contMarcaStatus(env, k8(K2), 'restrito');
  const c = chipDe(K2);
  conta('aquecimento que caiu: Restrito, campo ativo e o relogio do aquecimento fica', r && r.mudou && c.wa_st === 'st_mpafn8zm' && c.st === 'ativo' && c.warm_start === '2026-10-20', JSON.stringify({ wa_st: c.wa_st, st: c.st, warm: c.warm_start }));
  // Banido nao vira Restrito
  poeStatus(K1, BANIDO, false);
  const r2 = await F._contMarcaStatus(env, k8(K1), 'restrito');
  conta('um Banido nunca e rebaixado pra Restrito', r2 && r2.mudou === false && chipDe(K1).wa_st === BANIDO, JSON.stringify(r2))
  const r3 = await F._contMarcaStatus(env, k8(AF), 'restrito');
  conta('numero de afiliado fica de fora do Restrito tambem', r3 && r3.mudou === false && chipDe(AF).wa_st === EM_USO, JSON.stringify(r3))
}
{
  // bloqueado com o interruptor JA desligado na mao: nao desliga de novo, mas marca e avisa
  estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM swweb_queda'); pushes.length = 0;
  const d = estado(); for (const p of d.pressels) if (!p.afl) p.vendedores = [{ at: 'kevin', off: { [k8(K2)]: true } }];
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d));
  const nk = nkApp(K2);
  aluga(nk, 'kevin', AGORA, AGORA + 120); anda(10); await reporta(nk, 'bloqueado', 'kevin'); anda(95); await F._desligaCaidos(env);
  conta('ja desligado: nada no registro do interruptor, mas o cartao vira Banido', !log().length && chipDe(K2).wa_st === BANIDO, JSON.stringify(log()));
  conta('e o aviso diz so que marcou', pushes.length > 0 && /^.+ foi bloqueado pelo WhatsApp\. Marquei como Banido na Contingencia\.$/.test(pushes[0].body), pushes[0] && pushes[0].body);
  solta(nk);
}
{
  // numero em aquecimento bloqueado: o campo volta pra ativo e o relogio zera (igual a tela)
  estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM swweb_queda'); pushes.length = 0;
  const d = estado(); const c0 = d.chips.find((x) => k8(x.num) === k8(K2)); Object.assign(c0, { st: 'aquecimento', wa_st: AQUEC, em_uso: false, warm_start: '2026-10-15' });
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d));
  const r = await F._contMarcaBloqueado(env, k8(K2));
  const c = chipDe(K2);
  conta('aquecimento bloqueado: Banido, campo ativo e relogio zerado', r && r.mudou && c.wa_st === BANIDO && c.st === 'ativo' && c.warm_start === '', JSON.stringify({ wa_st: c.wa_st, st: c.st, warm: c.warm_start }));
  const r2 = await F._contMarcaBloqueado(env, k8(K2));
  conta('marcar de novo um ja Banido nao grava nada', r2 && r2.mudou === false, JSON.stringify(r2));
  const rA = await F._contMarcaBloqueado(env, k8(AF));
  conta('numero de afiliado nao e marcado', rA && rA.mudou === false && chipDe(AF).wa_st === EM_USO, JSON.stringify(rA));
}
{
  // se ele criar um status chamado Bloqueado, vale ele
  estadoInicial({ wa_statuses: STATUS.concat([{ id: 'st_bloq', label: 'Bloqueado' }]) });
  const r = await F._contMarcaBloqueado(env, k8(K1));
  conta('com um status "Bloqueado" na lista, e ele que vai pro cartao', r && r.mudou && chipDe(K1).wa_st === 'st_bloq' && r.status === 'Bloqueado', JSON.stringify(r));
  // e sem Banido nem Bloqueado, nao inventa
  estadoInicial({ wa_statuses: STATUS.filter((x) => x.id !== BANIDO) });
  const r2 = await F._contMarcaBloqueado(env, k8(K1));
  conta('sem status de banido na lista, nao inventa nenhum', r2 && r2.mudou === false && chipDe(K1).wa_st === EM_USO, JSON.stringify(r2));
}
{
  const nk = nkApp(AF);
  aluga(nk, 'kevin', AGORA, AGORA + 120); anda(20); await reporta(nk, 'pronto', 'kevin');
  anda(60); await reporta(nk, 'qr', 'kevin'); anda(95); const antes = pushes.length, logAntes = log().length; await F._desligaCaidos(env);
  conta('numero de afiliado nao e desligado pelo sistema', ligadoEm(AF, 'kevin', 99) && pushes.length === antes && log().length === logAntes, JSON.stringify(log()));
  solta(nk);
}

console.log('\nO _desligaBanidos CONTINUA IGUAL (mesmo helper agora)\n');
estadoInicial(); sq.exec('DELETE FROM pressel_num_log'); pushes.length = 0; config.clear();
{
  sq.prepare("INSERT INTO wa_api_numbers VALUES (?,?,?,?)").run('74076200', '+' + G1, 'gui', 'BANNED');
  await F._desligaBanidos(env);
  conta('banido na Meta desliga com "Sistema (banido na Meta)"', !ligadoEm(G1, 'gui', 1) && !ligadoEm(G1, 'gui', 12) && log().length === 1 && log()[0].por_nome === 'Sistema (banido na Meta)', JSON.stringify(log()));
  conta('e avisa a direcao uma vez', pushes.length === 1 && pushes[0].id === 'dir' && pushes[0].tag === 'banido-74076200', JSON.stringify(pushes));
  await F._desligaBanidos(env);
  conta('rodar de novo com ele ja desligado nao grava nem avisa', log().length === 1 && pushes.length === 1);
  // religado por alguem sem saber: o banido desliga de novo (o comportamento de 18/10)
  const d = estado();
  for (const p of d.pressels) for (const v of (p.vendedores || [])) if (v.off) delete v.off[k8(G1)];
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d));
  await F._desligaBanidos(env);
  conta('banido religado na mao: desliga de novo (e o aviso segura 12 h)', !ligadoEm(G1, 'gui', 1) && log().length === 2 && pushes.length === 1, JSON.stringify(log()));
  // A CONTINGENCIA: banido na Meta vira Banido no cartao, UMA vez por ban
  conta('banido na Meta: o cartao vira Banido e sai do Em uso', chipDe(G1).wa_st === BANIDO && chipDe(G1).em_uso === false, JSON.stringify(chipDe(G1)));
  conta('o aviso diz que desligou e que marcou', /Tirei ele da chegada de leads pra nao receber clique pago e marquei como Banido na Contingencia\. Nao religa sozinho\./.test(pushes[0].body), pushes[0].body);
  poeStatus(G1, REESTAB, false);   // ele troca o cartao na mao, com a Meta ainda dizendo BANNED
  await F._desligaBanidos(env);
  conta('trocado na mao com a Meta ainda BANNED: o sistema nao briga com o cartao', chipDe(G1).wa_st === REESTAB, chipDe(G1).wa_st);
  sq.exec("UPDATE wa_api_numbers SET status='CONNECTED'"); await F._desligaBanidos(env);
  conta('a Meta parou de dizer BANNED: a trava rearma', !JSON.parse(config.get('cont_bloqueado_meta') || '{}')[k8(G1)], config.get('cont_bloqueado_meta'));
  poeStatus(G1, EM_USO, true);
  sq.exec("UPDATE wa_api_numbers SET status='BANNED'"); await F._desligaBanidos(env);
  conta('banido de novo: marca de novo', chipDe(G1).wa_st === BANIDO, chipDe(G1).wa_st);
}
{
  // ja desligado e ainda Em Uso no cartao (o 6200 do Guilherme em 21/10): so marca, e avisa isso
  estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM wa_api_numbers'); pushes.length = 0; config.clear();
  const d = estado(); for (const p of d.pressels) if (!p.afl) p.vendedores = [{ at: 'gui', off: { [k8(G1)]: true } }];
  sq.prepare('UPDATE dashboard_state SET data=?, version=version+1 WHERE id=1').run(JSON.stringify(d));
  sq.prepare("INSERT INTO wa_api_numbers VALUES (?,?,?,?)").run('74076200', '+' + G1, 'gui', 'BANNED');
  await F._desligaBanidos(env);
  conta('o 6200: ja desligado, o cartao vira Banido', chipDe(G1).wa_st === BANIDO && !log().length, JSON.stringify(log()));
  conta('e o aviso diz so que marcou', pushes.length === 1 && /esta banido na Meta\. Marquei como Banido na Contingencia\.$/.test(pushes[0].body) && pushes[0].title === 'Numero banido na Meta', JSON.stringify(pushes[0]));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// NUMERO PARADO NAO ACORDA NINGUEM (25/10/2026, pedido do Bruno: "so quero receber esse tipo de
// notificacao quando realmente o numero for banido, quando cair o numero de um vendedor").
//
// O PARADO esta numa COLUNA do cadastro (at = ccol_1), que e onde ele estaciona numero fora de uso.
// Coluna nao e pessoa: nao tem fila, nao recebe lead e nao ha ninguem pra avisar. Os OITO numeros
// com BANNED na producao em 25/10 eram todos assim, e o aviso chegava as 00:07 da madrugada.
console.log('\nNUMERO PARADO NAO ACORDA NINGUEM\n');
{
  estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM wa_api_numbers'); pushes.length = 0; config.clear();
  sq.prepare('INSERT INTO wa_api_numbers VALUES (?,?,?,?)').run('81430517', '+' + PARADO, 'ccol_1', 'BANNED');
  await F._desligaBanidos(env);
  conta('banido numa coluna do cadastro: nenhum aviso', pushes.length === 0, JSON.stringify(pushes.map((p) => p.title)));
  conta('e nem mexe no interruptor (coluna nao esta em fila nenhuma)', !log().length, JSON.stringify(log()));
}
{
  // E O DE VENDEDOR CONTINUA AVISANDO: a regra nova nao pode ter calado o caso que importa.
  estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM wa_api_numbers'); pushes.length = 0; config.clear();
  sq.prepare('INSERT INTO wa_api_numbers VALUES (?,?,?,?)').run('74076200', '+' + G1, 'gui', 'BANNED');
  await F._desligaBanidos(env);
  conta('banido de vendedor: o aviso sai', pushes.length > 0 && /banido/i.test(pushes[0].title), JSON.stringify(pushes.map((p) => p.title)));
  conta('e esse aviso NAO toca som de venda', pushes.every((p) => p.aviso === true), JSON.stringify(pushes.map((p) => [p.title, p.aviso])));
}
{
  // A QUEDA SEGUE A MESMA REGRA. O numero da coluna cai no WhatsApp: desliga e marca (sao verdade),
  // mas ninguem e acordado por isso.
  estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM swweb_queda; DELETE FROM wa_api_numbers'); pushes.length = 0; config.clear();
  const nkP = nkApp(PARADO);
  aluga(nkP, 'dir', AGORA - 300, AGORA + 300);
  await reporta(nkP, 'pronto', 'dir');
  anda(60); await reporta(nkP, 'qr', 'dir');
  anda(120); await F._desligaCaidos(env);
  conta('queda de numero de coluna: nenhum aviso', pushes.length === 0, JSON.stringify(pushes.map((p) => p.title)));
  solta(nkP);
}
{
  // E a queda de um numero de VENDEDOR continua avisando, agora sem som de venda.
  estadoInicial(); sq.exec('DELETE FROM pressel_num_log; DELETE FROM swweb_queda; DELETE FROM wa_api_numbers'); pushes.length = 0; config.clear();
  const nkK = nkApp(K1);
  aluga(nkK, 'kevin', AGORA - 300, AGORA + 300);
  await reporta(nkK, 'pronto', 'kevin');
  anda(60); await reporta(nkK, 'qr', 'kevin');
  anda(120); await F._desligaCaidos(env);
  conta('queda de numero de vendedor: o aviso sai', pushes.length > 0, JSON.stringify(pushes.map((p) => p.title)));
  conta('e tambem sem som de venda', pushes.every((p) => p.aviso === true), JSON.stringify(pushes.map((p) => [p.title, p.aviso])));
  solta(nkK);
}

console.log('\nAS LIGACOES NO WORKER\n');
conta('o POST /api/swweb/conexao chama a marca depois de gravar o estado',
  /INSERT INTO swweb_conn[\s\S]{0,900}?_swwebMarcaQueda\(env, nk, st, u, b\)/.test(fonte));
conta('o cron confere toda batida, logo depois do funil e antes da trava',
  /await _waFunnelTick\(env\);[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*try \{ await _desligaCaidos\(env\); \}/.test(fonte));
conta('o _desligaBanidos usa o mesmo helper', /_roletaDesligaNum\(env, nk8, \{ por_nome: 'Sistema \(banido na Meta\)'/.test(fonte));

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) process.exit(1);
