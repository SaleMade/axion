// FECHOU O SELLWAVE WEB, PAROU DE RECEBER LEAD (31/10/2026).
//
// Pedido do Bruno: "sempre que alguem fechasse o aplicativo, ele tambem parasse de receber leads. Ou
// seja, todos os interruptores fossem desligados para ele. Quando ele acessasse novamente o
// aplicativo, ele teria que ligar novamente".
//
// Prova de app aberto = aluguel vivo no swweb_uso (o app renova de 45 em 45 s, validade 2 min), com
// 3 min de folga depois de vencer. A regra e por PESSOA: numero hibernado num app aberto segue ligado.
//
// Le as funcoes DO PROPRIO worker.js (recorta e avalia) e roda contra um D1 de mentira em cima do
// node:sqlite, com o SQL de verdade. Copia da logica testaria a copia.
//
//   node teste-app-fechado.mjs
//   WORKER=<caminho> node teste-app-fechado.mjs

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

const nomes = ['_swwebAppAbertos', '_swwebLigadosPorDono', '_swwebDesligaDonos', '_desligaAppFechado', '_swwebRecusaLigar',
  '_estadoLe', '_estadoGrava', '_presselAplicaNum', '_limpaMarcasDesligado', '_amanhaBR', '_presselNumLogEnsure', '_presselNumLog',
  '_emUsoIdsDe', '_aquecIdsDe', '_papelSt', '_papelPeloNomeSt', '_swwebApto', '_chipAquecendo', '_chipEmUso'];
const blocos = nomes.map((n) => [n, funcao(n)]);
const consts = ['const _swwebK8 = ', 'const _PAPEIS_ST = ', 'const APP_FECHADO_FOLGA = '].map((c) => [c, linha(c)]);
const faltando = blocos.filter(([, b]) => !b).map(([n]) => n).concat(consts.filter(([, l]) => !l).map(([c]) => c));
conta('o worker tem as funcoes do app fechado', !faltando.length, 'faltando: ' + faltando.join(', '));
if (faltando.length) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1); }

// ── o relogio e o banco de mentira ──────────────────────────────────────────────────────────────
let AGORA = 1793462400;   // 31/10/2026 12:00
Date.now = () => AGORA * 1000;
const sq = new DatabaseSync(':memory:');
const limpa = (a) => a.map((x) => (x === undefined ? null : x));
let quebraUso = false;    // simula a leitura do swweb_uso falhando
const DB = {
  prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = limpa(a); return st; },
      async first() { return sq.prepare(sql).get(...args) ?? null; },
      async all() { if (quebraUso && /swweb_uso/.test(sql)) throw new Error('D1 fora'); return { results: sq.prepare(sql).all(...args) }; },
      async run() { const r = sq.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return st;
  },
};
const env = { DB };
sq.exec("CREATE TABLE dashboard_state (id INTEGER PRIMARY KEY, data TEXT, version INTEGER, updated_at INTEGER, updated_by TEXT)");
sq.exec('CREATE TABLE swweb_uso (nk TEXT PRIMARY KEY, user_id TEXT, nome TEXT, maquina TEXT, desde INTEGER, ate INTEGER)');
sq.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)');
sq.exec("INSERT INTO users VALUES ('kevin','Kevin Marques'),('gui','Guilherme')");

const fabrica = new Function('_getDashData', '_brDay',
  'let _dashCache = null; let _pnlOk = false;\n'
  + consts.map(([, l]) => l).join('\n') + '\n' + blocos.map(([, b]) => b).join('\n')
  + '\nreturn { _swwebAppAbertos, _swwebLigadosPorDono, _swwebDesligaDonos, _desligaAppFechado, _swwebRecusaLigar };');
const F = fabrica(async () => estado(), () => '2026-10-31');

// a operacao: dois numeros do Kevin, um em aquecimento dele, dois do Guilherme, um de afiliado no
// nome do Kevin, um parado numa coluna; duas pressels da casa e uma do afiliado
const K1 = '5515991872193', K2 = '5515991879743', KAQ = '5549988931497', G1 = '5515974076200', G2 = '5515992503977';
const AF = '5511999990000', PARADO = '5515981430517', KRESTRITO = '5515981111111';
const k8 = (n) => String(n).replace(/\D/g, '').slice(-8);
const nkApp = (n) => String(n).replace(/\D/g, '').replace(/^55/, '').replace(/^(\d\d)9(\d{8})$/, '$1$2');
const EM_USO = 'st_mpafmypw', AQUEC = 'st_mpalmegl', RESTRITO = 'st_mpafn8zm';
const STATUS = [
  { id: EM_USO, label: 'Em Uso', papel: 'em_uso' }, { id: 'st_mpafn8em', label: 'Ativo', papel: 'ativo' },
  { id: RESTRITO, label: 'Restrito', papel: 'restrito' }, { id: AQUEC, label: 'Em Aquecimento', papel: 'aquecimento' },
];
function estadoInicial(vend) {
  const data = {
    wa_statuses: STATUS,
    chips: [
      { num: K1, at: 'kevin', st: 'ativo', wa_st: EM_USO, em_uso: true },
      { num: K2, at: 'kevin', st: 'ativo', wa_st: EM_USO, em_uso: true },
      { num: KAQ, at: 'kevin', st: 'ativo', wa_st: AQUEC, warm_start: '2026-10-30' },
      { num: KRESTRITO, at: 'kevin', st: 'ativo', wa_st: RESTRITO, em_uso: false },
      { num: G1, at: 'gui', st: 'ativo', wa_st: EM_USO, em_uso: true },
      { num: G2, at: 'gui', st: 'ativo', wa_st: EM_USO, em_uso: true },
      { num: AF, at: 'kevin', afl: 'aflX', st: 'ativo', wa_st: EM_USO, em_uso: true },
      { num: PARADO, at: 'ccol_1', st: 'ativo', wa_st: EM_USO, em_uso: true },
    ],
    pressels: [
      { id: 1, vendedores: JSON.parse(JSON.stringify(vend || [])) },
      { id: 12, vendedores: JSON.parse(JSON.stringify(vend || [])) },
      { id: 99, afl: 'aflX', vendedores: [{ at: 'kevin', ativo: true }] },
    ],
  };
  sq.exec('DELETE FROM dashboard_state');
  sq.exec('DELETE FROM swweb_uso');
  try { sq.exec('DELETE FROM pressel_num_log'); } catch (_) {}
  sq.prepare('INSERT INTO dashboard_state VALUES (1, ?, 1, 0, ?)').run(JSON.stringify(data), 'teste');
}
const estado = () => JSON.parse(sq.prepare('SELECT data FROM dashboard_state WHERE id=1').get().data);
const versao = () => sq.prepare('SELECT version FROM dashboard_state WHERE id=1').get().version;
// ligado = o que a roleta le: vendedor presente sem off, ou ausente (o chip apto entra ligado)
const ligadoEm = (num, at, pid) => {
  const p = estado().pressels.find((x) => x.id === pid);
  const v = (p.vendedores || []).find((x) => String(x.at) === at);
  if (!v) return true;
  return !(v.ativo === false || (v.off && v.off[k8(num)]));
};
const ligadoNasDuas = (num, at) => ligadoEm(num, at, 1) && ligadoEm(num, at, 12);
const desligadoNasDuas = (num, at) => !ligadoEm(num, at, 1) && !ligadoEm(num, at, 12);
const log = () => { try { return sq.prepare('SELECT por_nome, at, nk, acao FROM pressel_num_log ORDER BY id').all(); } catch (_) { return []; } };
const aluga = (num, user, ate, maq) => sq.prepare('INSERT INTO swweb_uso VALUES (?,?,?,?,?,?) ON CONFLICT(nk) DO UPDATE SET user_id=excluded.user_id, maquina=excluded.maquina, ate=excluded.ate')
  .run(nkApp(num), user, user, maq || ('maq-' + user), AGORA - 600, ate);
const solta = (num) => sq.prepare('DELETE FROM swweb_uso WHERE nk=?').run(nkApp(num));
const vivo = () => AGORA + 100;   // aluguel renovado ha 20 s
// os dois vendedores presentes nas pressels da casa, tudo ligado
const TODOS_LIGADOS = [{ at: 'kevin', ativo: true }, { at: 'gui', ativo: true }];

console.log('\n1) ninguem com o app fechado: nada muda');
estadoInicial(TODOS_LIGADOS);
aluga(K1, 'kevin', vivo()); aluga(G1, 'gui', vivo());
{
  const v0 = versao();
  await F._desligaAppFechado(env);
  conta('com os dois apps abertos, o cron nao grava nada', versao() === v0 && !log().length, 'versao ' + v0 + ' -> ' + versao());
}

console.log('\n2) Kevin fecha pelo X (o app apaga os alugueis): todos os dele desligam, so os dele');
solta(K1);
await F._desligaAppFechado(env);
conta('K1 e K2 do Kevin desligados nas duas pressels da casa', desligadoNasDuas(K1, 'kevin') && desligadoNasDuas(K2, 'kevin'));
conta('o numero em AQUECIMENTO dele tambem desliga ("todos os interruptores")', desligadoNasDuas(KAQ, 'kevin'));
conta('o Guilherme, com o app aberto, segue ligado', ligadoNasDuas(G1, 'gui') && ligadoNasDuas(G2, 'gui'));
conta('a pressel do AFILIADO nao e tocada', estado().pressels.find((p) => p.id === 99).vendedores[0].off == null);
conta('o numero parado na COLUNA nao e tocado', !estado().pressels.some((p) => (p.vendedores || []).some((v) => String(v.at).startsWith('ccol_'))));
{
  const l = log();
  conta('cada numero desligado fica no registro como "Sistema (SellWave Web fechado)"',
    l.length === 4 && l.every((x) => x.por_nome === 'Sistema (SellWave Web fechado)' && x.at === 'kevin' && x.acao === 'desliga'),
    JSON.stringify(l));
  conta('o RESTRITO dele, que estava com a chave ligada, tambem fica desligado (nao volta ligado se voltar pro Em uso)',
    desligadoNasDuas(KRESTRITO, 'kevin'));
}
{
  const v0 = versao();
  await F._desligaAppFechado(env);
  conta('a batida seguinte nao grava de novo (ja esta tudo desligado)', versao() === v0);
}

console.log('\n3) Kevin abre o app de novo: NADA religa sozinho');
aluga(K1, 'kevin', vivo());
await F._desligaAppFechado(env);
conta('os numeros dele seguem desligados ate ele ligar', desligadoNasDuas(K1, 'kevin') && desligadoNasDuas(K2, 'kevin'));

console.log('\n4) o app caiu sem fechar (aluguel vence): so desliga depois da folga');
estadoInicial(TODOS_LIGADOS);
aluga(K1, 'kevin', AGORA - 60);   // venceu ha 1 min: internet piscou
aluga(G1, 'gui', vivo());
await F._desligaAppFechado(env);
conta('aluguel vencido ha 1 min ainda conta como aberto (internet que pisca nao derruba)', ligadoNasDuas(K1, 'kevin'));
aluga(K1, 'kevin', AGORA - 181);  // venceu ha 3 min e pouco: ~5 min sem renovar
await F._desligaAppFechado(env);
conta('passou da folga: desliga', desligadoNasDuas(K1, 'kevin') && desligadoNasDuas(K2, 'kevin'));

console.log('\n5) numero HIBERNADO num app aberto continua ligado (a regra e por pessoa)');
estadoInicial(TODOS_LIGADOS);
aluga(K1, 'kevin', vivo());       // so o K1 aberto; K2 e o aquecimento hibernados
aluga(G1, 'gui', vivo());
await F._desligaAppFechado(env);
conta('K2 fechado no app, mas o Kevin esta com o app aberto: segue ligado', ligadoNasDuas(K2, 'kevin') && ligadoNasDuas(KAQ, 'kevin'));

console.log('\n6) "desligado so ate a meia-noite" com o app fechado: nao volta a meia-noite');
estadoInicial([{ at: 'kevin', ativo: true, off: { [k8(K1)]: true, [k8(K2)]: true, [k8(KAQ)]: true, [k8(KRESTRITO)]: true }, volta: { [k8(K1)]: '2026-11-01' } }, { at: 'gui', ativo: true }]);
aluga(G1, 'gui', vivo());
await F._desligaAppFechado(env);
{
  const p = estado().pressels.find((x) => x.id === 1);
  const v = p.vendedores.find((x) => x.at === 'kevin');
  conta('a marca de volta some (o cron da meia-noite nao religa quem fechou o app)', !v.volta, JSON.stringify(v));
  conta('e o numero segue desligado', v.off && v.off[k8(K1)] === true);
  conta('so o numero que tinha a marca entra no registro', log().length === 1 && log()[0].nk === k8(K1), JSON.stringify(log()));
}

console.log('\n7) vendedor AUSENTE da pressel: chip apto conta como ligado; chip parado nao');
estadoInicial([]);   // ninguem listado: a roleta poe quem tem chip Em uso (AUSENTE = LIGADO)
aluga(G1, 'gui', vivo());
await F._desligaAppFechado(env);
{
  const p = estado().pressels.find((x) => x.id === 1);
  const v = (p.vendedores || []).find((x) => x.at === 'kevin');
  conta('o Kevin ausente com o app fechado ganha off nos numeros aptos', !!(v && v.off && v.off[k8(K1)] && v.off[k8(K2)] && v.off[k8(KAQ)]), JSON.stringify(v));
  conta('o numero RESTRITO (nao recebe nada) nao ganha off a toa', !(v && v.off && v.off[k8(KRESTRITO)]), JSON.stringify(v));
  conta('o Guilherme ausente, com o app aberto, nao ganha entrada nenhuma', !(p.vendedores || []).some((x) => x.at === 'gui'));
}

console.log('\n8) o app avisa que esta FECHANDO (POST /api/swweb/fechando)');
estadoInicial(TODOS_LIGADOS);
aluga(K1, 'kevin', vivo(), 'maq-1'); aluga(K2, 'kevin', vivo(), 'maq-1');
{
  const r = await F._swwebDesligaDonos(env, ['kevin'], { exceto: 'maq-1', por_nome: 'Sistema (fechou o SellWave Web)' });
  conta('os alugueis da maquina que esta saindo nao seguram: desliga na hora', r.length === 4 && desligadoNasDuas(K1, 'kevin') && desligadoNasDuas(K2, 'kevin'), JSON.stringify(r));
  conta('o registro diz que ele fechou o app', log().every((x) => x.por_nome === 'Sistema (fechou o SellWave Web)'));
}
estadoInicial(TODOS_LIGADOS);
aluga(K1, 'kevin', vivo(), 'maq-1'); aluga(K2, 'kevin', vivo(), 'maq-2');
{
  const r = await F._swwebDesligaDonos(env, ['kevin'], { exceto: 'maq-1' });
  conta('com OUTRA maquina dele aberta, fechar uma nao desliga nada', r.length === 0 && ligadoNasDuas(K1, 'kevin'));
}

console.log('\n9) a conferencia de novo, na hora de gravar');
estadoInicial(TODOS_LIGADOS);
aluga(K1, 'kevin', vivo());
{
  const r = await F._swwebDesligaDonos(env, ['kevin'], {});
  conta('quem abriu o app entre a olhada do cron e a gravacao nao e desligado', r.length === 0 && ligadoNasDuas(K1, 'kevin'));
}

console.log('\n10) leitura dos alugueis falhando: ninguem e desligado no escuro');
estadoInicial(TODOS_LIGADOS);
quebraUso = true;
await F._desligaAppFechado(env);
conta('D1 fora: tudo segue ligado', ligadoNasDuas(K1, 'kevin') && ligadoNasDuas(G1, 'gui'));
conta('e a recusa de ligar tambem nao trava ninguem', (await F._swwebRecusaLigar(env, 'kevin', true)) === null);
quebraUso = false;

console.log('\n11) ligar com o app fechado e recusado, com a frase');
estadoInicial(TODOS_LIGADOS);
aluga(G1, 'gui', vivo());
{
  const eu = await F._swwebRecusaLigar(env, 'kevin', true);
  const dir = await F._swwebRecusaLigar(env, 'kevin', false);
  conta('o proprio vendedor: "Abra o SellWave Web pra ligar"', /^Abra o SellWave Web pra ligar/.test(String(eu)), eu);
  conta('a direcao ligando o numero dele: diz quem esta com o app fechado', /^Kevin está com o SellWave Web fechado/.test(String(dir)), dir);
  conta('com o app aberto passa', (await F._swwebRecusaLigar(env, 'gui', true)) === null);
  conta('coluna do cadastro nao e pessoa: nao recusa por isso', (await F._swwebRecusaLigar(env, 'ccol_1', false)) === null);
}

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados');
if (falhas.length) { console.log('\nERRADOS:\n- ' + falhas.join('\n- ')); process.exit(1); }
