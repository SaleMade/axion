// TESTE DO NUMERO MUDO QUE FICA PRESO (23/10/2026, revisto no mesmo dia).
//
// O caso que criou a prisao: o (11) 97251-8066 do Guilherme estava com a captura parada desde as
// 22:46 da vespera e comeu 97 CLIQUES PAGOS no dia seguinte, porque a guarda media uma janela de 30
// min e esquecia. Agora quem e pego fica preso ate provar que voltou.
//
// O caso que fez a revisao: o (15) 99250-3977 foi ligado as 14:50, tomou 20 cliques em 5 min e foi
// preso as 14:55 com as mensagens dos leads a caminho (chegaram as 14:57). O Bruno viu o aviso de
// "parou de receber" num numero normal. Daqui saem as tres mudancas que este teste segura:
//   - carencia: visita dos ultimos 10 min ainda nao conta contra o numero;
//   - prova nas duas direcoes: mensagem que o vendedor mandou e foi registrada tambem prova captura;
//   - soltar por reaberto ou religado, com a contagem recomecando dali;
//   - o conjunto lido do banco a cada volta (isolates nao brigam mais).
//
// Roda o codigo DE VERDADE: recorta o bloco do worker.js e executa com um banco de mentira.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg); };

const ini = src.indexOf('let _mudoCache = null, _mudoT = 0;');
const fim = src.indexOf('function _mudoPresoAgora()', ini);
if (ini < 0 || fim < 0) { console.error('NAO ACHEI o bloco do mudo no worker.js'); process.exit(1); }
const trecho = src.slice(ini, src.indexOf('\n', fim));

ok(/MUDO_CARENCIA = 600/.test(trecho), 'a carencia da visita recente e de 10 min');
ok(/INDEXED BY idx_ttp_ts_num/.test(trecho), 'a consulta de visita continua presa ao indice (pagina do anuncio rapida)');

const monta = () => {
  const mod = 'const MUDO_JANELA = 1800;\nconst MUDO_VISITAS = 20;\n'
    + 'let _cfg = {}; let _gravou = 0;\n'
    + 'const _writeConfig = async (env, k, v) => { _cfg[k] = v; _gravou += 1; };\n'
    + trecho
    + '\nreturn { mudos: _numerosMudos, reset: () => { _mudoT = 0; }, cfg: () => _cfg, gravou: () => _gravou,'
    + ' esqueceMemoria: () => { _mudoPreso = null; _mudoT = 0; }, tabela: () => _mudoTabela, envelheLeve: () => { _mudoLeveT = 0; } };';
  return new Function(mod)();
};

const agoraS = () => Math.floor(Date.now() / 1000);
// visitas de um numero, cada uma "x minutos atras"
const V = (nk, ...minAtras) => minAtras.map((m) => ({ nk, ts: agoraS() - Math.round(m * 60) }));
const varias = (nk, n, de, ate) => Array.from({ length: n }, (_, i) => ({ nk, ts: agoraS() - Math.round((de - (de - ate) * i / Math.max(1, n - 1)) * 60) }));

// banco de mentira: responde cada consulta pelo texto do SQL
const fazEnv = (m, { visitas = [], msgs = [], conn = [], liga = [], falhaCfg = false } = {}) => ({
  DB: {
    prepare: (sql) => {
      const resp = async (...args) => {
        if (/FROM tt_pending/.test(sql)) {
          const desde = args[0];
          const g = {};
          for (const v of visitas) if (v.ts >= desde) { const b = Math.floor(v.ts / 60) * 60; const k = v.nk + '|' + b; g[k] = (g[k] || 0) + 1; }
          return { results: Object.entries(g).map(([k, n]) => ({ nk: k.split('|')[0], b: Number(k.split('|')[1]), n })) };
        }
        if (/FROM wa_messages/.test(sql)) {
          const g = {};
          for (const x of msgs) { g[x.k] = g[x.k] || { k: x.k, ent: 0, n: 0 }; g[x.k].n += 1; if (x.d === 'in') g[x.k].ent += 1; }
          return { results: Object.values(g) };
        }
        if (/FROM app_config/.test(sql)) {
          if (falhaCfg) throw new Error('D1 fora');
          return { results: Object.entries(m.cfg()).map(([key, value]) => ({ key, value })) };
        }
        if (/FROM app_config WHERE key = \?/.test(sql)) return null;
        if (/FROM swweb_conn/.test(sql)) return { results: conn.filter((c) => c.ts > args[0]) };
        if (/FROM pressel_num_log/.test(sql)) return { results: liga.filter((c) => c.ts > args[0] && c.por !== 'sistema') };
        return { results: [] };
      };
      const umaLinha = async (...a) => {
        if (falhaCfg) throw new Error('D1 fora');
        contaLeve.n += 1;
        const v = m.cfg()[a[0]];
        return v == null ? null : { value: v };
      };
      return { bind: (...a) => ({ all: () => resp(...a), first: () => umaLinha(...a), run: async () => ({}) }), all: () => resp(), run: async () => ({}) };
    },
  },
});
const presoGravado = (m) => JSON.parse(m.cfg()['roleta_mudo_preso'] || '{}');
const contaLeve = { n: 0 };

// ── 1. o mudo de verdade: visitas velhas, nenhuma mensagem ─────────────────────────────────────
{
  const m = monta();
  const r = await m.mudos(fazEnv(m, { visitas: [...varias('72518066', 42, 28, 11), ...varias('95983293', 30, 28, 2)], msgs: [{ k: '95983293', d: 'in' }] }));
  ok(r['72518066'] !== undefined, '42 visitas de mais de 10 min sem UMA mensagem: sai da roleta');
  ok(r['95983293'] === undefined, 'numero que registra mensagem nao e tocado');
  ok(presoGravado(m)['72518066'] > 0, 'o preso foi gravado no app_config');
}

// ── 2. O CASO DO 3977: ligado agora, pico de cliques, mensagem a caminho ──────────────────────
{
  const m = monta();
  const r = await m.mudos(fazEnv(m, { visitas: varias('92503977', 25, 5.5, 0.2) }));
  ok(r['92503977'] === undefined, '25 cliques nos ultimos 6 min sem mensagem AINDA: nao prende (o 3977 de 23/10)');
  // 12 min depois, se continuar sem uma mensagem sequer, ai sim
  m.reset();
  const r2 = await m.mudos(fazEnv(m, { visitas: varias('92503977', 25, 17.5, 12.2) }));
  ok(r2['92503977'] !== undefined, 'as mesmas 25 visitas, ja com mais de 10 min e ainda sem mensagem: prende');
}

// ── 3. mensagem que o VENDEDOR mandou tambem prova que a captura vive ─────────────────────────
{
  const m = monta();
  const r = await m.mudos(fazEnv(m, { visitas: varias('97011859', 40, 28, 11), msgs: [{ k: '97011859', d: 'out' }] }));
  ok(r['97011859'] === undefined, 'so mensagem de saida registrada: nao prende');
  ok(m.tabela()['97011859'] && m.tabela()['97011859'].msgs === 0 && m.tabela()['97011859'].todas === 1, 'a tabela da tela continua contando so a ENTRADA (taxa de resposta)');
}

// ── 4. preso continua preso sem prova; solta com mensagem ─────────────────────────────────────
{
  const m = monta();
  await m.mudos(fazEnv(m, { visitas: varias('72518066', 42, 28, 11) }));
  m.reset();
  let r = await m.mudos(fazEnv(m, { visitas: V('72518066', 20, 15, 12) }));
  ok(r['72518066'] !== undefined, 'janela nova com 3 visitas: CONTINUA fora (nao e retestado)');
  m.reset();
  r = await m.mudos(fazEnv(m, {}));
  ok(r['72518066'] !== undefined, 'sem visita na janela: segue preso, porque nao houve prova');
  m.reset();
  r = await m.mudos(fazEnv(m, { visitas: V('72518066', 5), msgs: [{ k: '72518066', d: 'in' }] }));
  ok(r['72518066'] === undefined && presoGravado(m)['72518066'] === undefined, 'uma mensagem solta o numero e ele some do app_config');
}

// ── 5. REABERTO NAO SOLTA (o Kevin em 23/10: conectou normal e a captura seguia morta) ─────────
{
  const m = monta();
  await m.mudos(fazEnv(m, { visitas: varias('74060653', 60, 29, 11) }));
  const desdeP = presoGravado(m)['74060653'];
  ok(desdeP > 0, '(montagem) o 0653 foi preso');
  m.reset();
  const reaberto = [{ nk: '1574060653', st: 'pronto', ts: desdeP + 30 }];
  let r = await m.mudos(fazEnv(m, { visitas: varias('74060653', 60, 29, 11), conn: reaberto }));
  ok(r['74060653'] !== undefined, 'o app conectou o numero de novo depois de preso: CONTINUA fora (conectar nao prova captura)');
  m.reset();
  r = await m.mudos(fazEnv(m, { visitas: V('74060653', 3), conn: reaberto, msgs: [{ k: '74060653', d: 'out' }] }));
  ok(r['74060653'] === undefined, 'a primeira mensagem registrada depois disso solta');
}

// ── 6. REABRIR E RELIGAR RECOMECAM A CONTAGEM de quem ainda nao foi preso ─────────────────────
{
  const m = monta();
  // 30 visitas de 28 a 11 min atras sem mensagem prenderiam; o app reconectou ha 15 min
  const r = await m.mudos(fazEnv(m, { visitas: varias('92373996', 30, 28, 11), conn: [{ nk: '1592373996', st: 'pronto', ts: agoraS() - 15 * 60 }] }));
  ok(r['92373996'] === undefined, 'reconectou ha 15 min: as visitas de antes nao contam (so 10 delas sao de depois)');
  ok(JSON.parse(m.cfg()['roleta_mudo_recomeco'] || '{}')['92373996'] > 0, 'e o recomeco fica gravado pra todos os isolates');
  const m2 = monta();
  const r2 = await m2.mudos(fazEnv(m2, { visitas: varias('92373996', 30, 28, 11), liga: [{ nk: '92373996', ts: agoraS() - 15 * 60, por: 'sistema' }] }));
  ok(r2['92373996'] !== undefined, '"liga" do proprio sistema nao recomeca nada');
  const m3 = monta();
  const r3 = await m3.mudos(fazEnv(m3, { visitas: varias('92373996', 30, 28, 11), liga: [{ nk: '92373996', ts: agoraS() - 15 * 60, por: 'atendente_vra3lh' }] }));
  ok(r3['92373996'] === undefined, 'gente religou ha 15 min: a contagem recomeca dali');
  // religar um numero JA PRESO nao solta
  m3.cfg()['roleta_mudo_preso'] = JSON.stringify({ 92373996: agoraS() - 3600 });
  m3.reset();
  const r4 = await m3.mudos(fazEnv(m3, { visitas: varias('92373996', 30, 28, 11), liga: [{ nk: '92373996', ts: agoraS() - 60, por: 'atendente_vra3lh' }] }));
  ok(r4['92373996'] !== undefined, 'religar um numero ja preso nao solta: so a mensagem')
}

// ── 7. ISOLATES: o conjunto vem do banco a cada volta ─────────────────────────────────────────
{
  const m = monta();
  await m.mudos(fazEnv(m, { visitas: varias('72518066', 42, 28, 11) }));
  m.esqueceMemoria();                       // outro isolate: memoria zerada, app_config igual
  let r = await m.mudos(fazEnv(m, { visitas: V('72518066', 1) }));
  ok(r['72518066'] !== undefined, 'isolate novo le o preso do app_config e NAO devolve o numero pra roleta');
  // outro isolate soltou (chegou mensagem) e gravou: este, que ainda tinha o numero na memoria, obedece
  m.cfg()['roleta_mudo_preso'] = '{}';
  m.cfg()['roleta_mudo_recomeco'] = JSON.stringify({ 72518066: agoraS() - 60 });
  m.reset();
  r = await m.mudos(fazEnv(m, { visitas: varias('72518066', 42, 28, 11) }));
  ok(r['72518066'] === undefined && presoGravado(m)['72518066'] === undefined, 'o que outro isolate soltou nao volta preso por memoria velha');
}

// ── 7b. O PRESO DE OUTRO ISOLATE VALE EM 30 s, sem refazer a conta pesada ───────────────────────
{
  const m = monta();
  let pesadas = 0
  const env = fazEnv(m, { visitas: varias('74060653', 15, 28, 11) })
  const prep = env.DB.prepare
  env.DB.prepare = (sql) => { if (/FROM tt_pending/.test(sql)) pesadas += 1; return prep(sql) }
  let r = await m.mudos(env)
  ok(r['74060653'] === undefined && pesadas === 1, '(montagem) 15 visitas nao prendem, e a conta pesada rodou uma vez')
  // outro isolate prendeu e gravou
  m.cfg()['roleta_mudo_preso'] = JSON.stringify({ 74060653: agoraS() })
  r = await m.mudos(env)
  ok(r['74060653'] === undefined, 'nos primeiros 30 s este isolate ainda usa o que tinha')
  m.envelheLeve()
  const antes = contaLeve.n
  r = await m.mudos(env)
  ok(r['74060653'] !== undefined, 'passados 30 s ele rele SO a linha do conjunto e o numero sai da roleta aqui tambem')
  ok(pesadas === 1 && contaLeve.n === antes + 1, 'sem refazer a conta pesada (uma leitura de uma linha)')
  // e o solto por outro isolate volta do mesmo jeito
  m.cfg()['roleta_mudo_preso'] = '{}'
  m.envelheLeve()
  r = await m.mudos(env)
  ok(r['74060653'] === undefined, 'e o que outro isolate soltou volta pra roleta em 30 s')
}

// ── 8. banco fora: nao solta ninguem e nao grava por cima ─────────────────────────────────────
{
  const m = monta();
  await m.mudos(fazEnv(m, { visitas: varias('72518066', 42, 28, 11) }));
  const antes = m.cfg()['roleta_mudo_preso'];
  const g = m.gravou();
  m.reset();
  const r = await m.mudos(fazEnv(m, { visitas: varias('99997366', 30, 28, 11), falhaCfg: true }));
  ok(r['72518066'] !== undefined, 'leitura do conjunto falhou: o preso da memoria continua fora');
  ok(m.gravou() === g && m.cfg()['roleta_mudo_preso'] === antes, 'e nada e gravado por cima');
}

// ── 9. nao grava a toa (cada gravacao e uma ida ao banco no caminho quente) ────────────────────
{
  const m = monta();
  await m.mudos(fazEnv(m, { visitas: varias('72518066', 42, 28, 11) }));
  const g1 = m.gravou();
  m.reset();
  await m.mudos(fazEnv(m, { visitas: varias('72518066', 42, 28, 11) }));
  ok(m.gravou() === g1, 'conjunto sem mudanca nao grava de novo');
}

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  todas as conferencias passaram.');
