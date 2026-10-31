// RESERVA DO AQUECIMENTO (31/10/2026). Ver _aqReservaConta / _aqVivoAte / _aqPlacar no worker.js.
//
// O pedido do Bruno: "os numeros que estao em aquecimento estao recebendo um numero maior de leads do
// que deveriam" - o (49) 98893-1497 do Kevin fechou 31/10 em 11 de 5, e o do Guilherme 30/10 em 6 de 5.
// Os dois jeitos de estourar, medidos no banco:
//   1. APP FECHADO: o placar fica parado em 0 (ninguem marca lead) e o chip, primeiro da fila, leva
//      tudo. 31/10, 07:16 a 08:06: 37 + 35 visitas nos dois chips do Kevin.
//   2. APP ABERTO, RAJADA: o lead leva minutos pra ser marcado. 30/10, 14:23 a 14:42: 70 visitas no
//      (49) 98890-8842 do Guilherme.
// Este teste RECORTA o codigo de verdade do worker (rampa, reserva e fila) e reprisa as visitas reais
// daqueles dois dias, alem dos casos de borda da regra.
//
// Roda:  node teste-aquecimento-reserva.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
let ok = 0;
const falhas = [];
const vale = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  OK      ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
  else { falhas.push(nome); console.log('  FALHOU  ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

const iRampa = src.indexOf('const RAMPA_AQUECIMENTO');
const iFim = src.indexOf('// NUMEROS MUDOS:');
if (iRampa < 0 || iFim < 0 || src.indexOf('function _aqReservaConta') < 0) { console.error('NAO ACHEI os trechos no worker.js'); process.exit(1); }
const W = new Function(src.slice(iRampa, iFim) + `
  return { _tetoAcumulado, limiteDoAquecimento, _aqVivoAte, _aqReservaConta, _aqPlacar, _aplicaFilaLimite,
           AQ_RESERVA_JANELA, AQ_RESERVA_ULTIMA, AQ_RESERVA_CARENCIA };`)();

console.log('\nRESERVA DO AQUECIMENTO\n');
const MIN = 60;
const agora = 1793454000;   // 31/10/2026 ~10:40 BRT

// ── 1) quando a captura do numero esta viva ──────────────────────────────────────────────────
vale('chip da API oficial: a captura vem pelo webhook, vale agora', W._aqVivoAte({ api: true }, agora) === agora);
vale('app aberto ha tempo: vale o ultimo sinal do app', W._aqVivoAte({ hb: agora - 20, uso: { desde: agora - 3600, ate: agora + 120 } }, agora) === agora - 20);
vale('app aberto ha 1 min: ainda nao vale nada (a colheita esta marcando o que chegou fechado)',
  W._aqVivoAte({ hb: agora - 5, uso: { desde: agora - 60, ate: agora + 120 } }, agora) === 0);
vale('nunca abriu no app: nao da pra afirmar nada', W._aqVivoAte({}, agora) === 0);
vale('fechou ha 1 h: vale ate o ultimo sinal', W._aqVivoAte({ hb: agora - 3600 }, agora) === agora - 3600);

// ── 2) quantas visitas ocupam vaga ───────────────────────────────────────────────────────────
const conta = (vis, leads, teto, vivo) => W._aqReservaConta(vis, leads, teto, vivo, agora);
vale('visita de 1 min atras ocupa vaga', conta([agora - 1 * MIN], 0, 5, agora) === 1);
vale('visita de 25 min atras com o app aberto o tempo todo solta a vaga', conta([agora - 25 * MIN], 0, 5, agora) === 0);
vale('visita de 25 min atras com o app FECHADO continua ocupando (pode ter escrito e ninguem viu)',
  conta([agora - 25 * MIN], 0, 5, agora - 60 * MIN) === 1);
vale('app fechou 2 min depois da visita: nao deu pra ver, continua ocupando',
  conta([agora - 25 * MIN], 0, 5, agora - 23 * MIN) === 1);
vale('app vivo ate 25 min depois da visita e fechou: solta (deu tempo de ver)',
  conta([agora - 50 * MIN], 0, 5, agora - 25 * MIN) === 0);
vale('ULTIMA VAGA DO DIA (4 de 5): visita de 30 min ainda ocupa', conta([agora - 30 * MIN], 4, 5, agora) === 1);
vale('ULTIMA VAGA DO DIA: visita de 61 min solta', conta([agora - 61 * MIN], 4, 5, agora) === 0);
vale('fora da ultima vaga (3 de 5): visita de 30 min ja soltou', conta([agora - 30 * MIN], 3, 5, agora) === 0);
vale('mistura: 3 recentes + 2 antigas com app aberto = 3', conta([agora - 1, agora - 60, agora - 300, agora - 30 * MIN, agora - 90 * MIN], 0, 10, agora) === 3);

// ── 3) o placar que a fila compara ───────────────────────────────────────────────────────────
const lido = { visitas: { A: [agora - 60, agora - 120] }, leads: { A: 2 }, hb: { A: agora }, uso: {} };
let pl = W._aqPlacar({ A: 1, B: 7 }, [{ nk: 'A', teto: 5 }], lido, agora);
vale('chip que aquece: lead fresco (2, nao o cache 1) + 2 a caminho = 4', pl.placar.A === 4 && pl.res.A === 2, JSON.stringify(pl));
vale('numero de producao nao muda (7 continua 7)', pl.placar.B === 7);
pl = W._aqPlacar({ A: 3 }, [{ nk: 'A', teto: 5 }], null, agora);
vale('leitura falhou: fica so o lead, como era antes (a roleta nao para)', pl.placar.A === 3 && !Object.keys(pl.res).length);

// ── 4) a fila: chip segurado passa a vez pro proximo do vendedor ─────────────────────────────
const lista = [
  { num: '49988931497', at: 'kev', dist: 'limite', lim: 2, ordem: -1, idx: 1 },
  { num: '15997973450', at: 'kev', dist: 'limite', lim: 30, ordem: 1, idx: 2 },
];
const vez = (lh) => W._aplicaFilaLimite(lista, lh, '2026-10-31').ficam.map((u) => u.num.slice(-4)).join(',');
vale('sem reserva: 1 lead de 2, o chip que aquece tem a vez', vez({ 88931497: 1 }) === '1497');
vale('com 1 a caminho: 1 + 1 = 2 de 2, a vez passa pro numero de producao', vez(W._aqPlacar({ 88931497: 1 }, [{ nk: '88931497', teto: 5 }],
  { visitas: { 88931497: [agora - 30] }, leads: {}, hb: { 88931497: agora }, uso: {} }, agora).placar) === '3450');

// ── 5) REPRISE DE 31/10: o Kevin so abriu os chips as 08:19 ─────────────────────────────────
// As 76 visitas que a fila mandou pros dois chips (horario real, BRT), na ordem em que chegaram.
const hms = (s) => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + x; };
const base31 = Math.floor(Date.parse('2026-10-31T00:00:00-03:00') / 1000);
const VIS31 = ('00:37:18 03:02:40 06:16:58 06:16:58 07:16:52 07:19:42 07:21:25 07:22:14 07:23:50 07:26:44 07:27:44 07:27:46 07:27:52 07:28:40 '
  + '07:28:46 07:29:00 07:29:47 07:30:15 07:31:12 07:31:17 07:32:44 07:32:51 07:32:58 07:33:06 07:33:14 07:34:15 07:34:29 07:35:23 07:35:37 07:35:54 '
  + '07:36:17 07:36:46 07:38:53 07:39:02 07:40:07 07:41:57 07:42:42 07:43:34 07:43:51 07:44:43 07:45:15 07:45:26 07:46:08 07:46:47 07:47:42 07:48:05 '
  + '07:50:00 07:50:45 07:51:24 07:51:47 07:52:11 07:52:33 07:54:13 07:54:18 07:54:37 07:55:06 07:55:27 07:55:52 07:56:17 07:57:17 07:57:26 07:57:48 '
  + '07:58:01 07:58:33 08:00:02 08:01:20 08:02:11 08:02:29 08:02:49 08:03:09 08:03:52 08:04:23 08:04:50 08:06:36 08:13:52 08:14:54').split(' ').map((s) => base31 + hms(s));
const hbOntem = base31 - 7 * 3600;   // ultimo sinal do app: 30/10 17:00
const chips31 = [
  { num: '49988948922', at: 'kev', dist: 'limite', ordem: -1, idx: 66 },
  { num: '49988931497', at: 'kev', dist: 'limite', ordem: -1, idx: 69 },
  { num: '17997011859', at: 'kev', dist: 'limite', lim: 35, ordem: 3, idx: 3 },
];
const recebeu = { 88948922: [], 88931497: [], 97011859: [] };
for (const t of VIS31) {
  const h = Math.floor(((t - 3 * 3600) % 86400) / 3600);
  const lim = W._tetoAcumulado(5, h);
  const lidoT = { visitas: { 88948922: recebeu[88948922], 88931497: recebeu[88931497] }, leads: {}, hb: { 88948922: hbOntem, 88931497: hbOntem }, uso: {} };
  const placar = W._aqPlacar({}, [{ nk: '88948922', teto: 5 }, { nk: '88931497', teto: 5 }], lidoT, t).placar;
  const fila = chips31.map((c) => (c.ordem === -1 ? { ...c, lim } : c));
  const quem = W._aplicaFilaLimite(fila, placar, '2026-10-31').ficam[0];
  recebeu[quem.num.slice(-8)].push(t);
}
const n1 = recebeu[88948922].length, n2 = recebeu[88931497].length;
vale('31/10 app fechado ate 08:19: os dois chips levam 1 visita cada em vez de 41 e 35', n1 === 1 && n2 === 1, n1 + ' e ' + n2 + ' (o resto, ' + recebeu[97011859].length + ', foi pro (17) 99701-1859)');
vale('31/10: no pior caso (toda visita vira lead) nenhum chip passa do teto da hora', n1 <= 1 && n2 <= 1);

// ── 6) REPRISE DE 30/10: rajada com o app aberto no (49) 98890-8842 do Guilherme ──────────────
// 70 visitas das 14:23 as 14:42. Os leads foram marcados as 14:29 (2), 14:43 (2), 14:45 e 14:52.
const base30 = Math.floor(Date.parse('2026-10-30T00:00:00-03:00') / 1000);
const VIS30 = ('14:23 14:24 14:24 14:24 14:24 14:24 14:24 14:25 14:26 14:26 14:26 14:27 14:27 14:27 14:27 14:28 14:28 14:28 14:28 14:29 14:29 14:29 '
  + '14:33 14:33 14:34 14:34 14:34 14:35 14:35 14:36 14:37 14:37 14:37 14:37 14:37 14:37 14:37 14:37 14:37 14:38 14:38 14:39 14:39 14:39 14:39 14:40 '
  + '14:40 14:40 14:40 14:40 14:40 14:40 14:40 14:40 14:41 14:41 14:41 14:41 14:41 14:41 14:41 14:41 14:42 14:42 14:42 14:42 14:42 14:42 14:42 14:42')
  .split(' ').map((s, i) => base30 + hms(s + ':00') + i);   // + i: segundos distintos, mesma ordem
const LEADS30 = ['14:29:30', '14:29:40'].map((s) => base30 + hms(s));
const meus30 = [];
let maxOcup = 0;
for (const t of VIS30) {
  const h = 14, lim = W._tetoAcumulado(5, h);
  const leads = LEADS30.filter((x) => x <= t).length;
  // o lead marcado reivindica uma visita: sai da lista de nao reivindicadas
  const naoReiv = meus30.slice(Math.min(leads, meus30.length));
  const placar = W._aqPlacar({}, [{ nk: '88908842', teto: 5 }], { visitas: { 88908842: naoReiv }, leads: { 88908842: leads }, hb: { 88908842: t - 10 }, uso: {} }, t).placar;
  maxOcup = Math.max(maxOcup, placar[88908842] || 0);
  if ((placar[88908842] || 0) < lim) meus30.push(t);
}
const lim14 = W._tetoAcumulado(5, 14);
vale('30/10 app aberto: das 70 visitas da rajada o chip leva no maximo o que cabe na hora', meus30.length <= lim14,
  meus30.length + ' visitas (teto da hora: ' + lim14 + ')');

console.log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram.');
if (falhas.length) { console.log('\nFALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
