// TESTE DO NUMERO MUDO QUE FICA PRESO (23/10/2026).
//
// O caso real: o (11) 97251-8066 do Guilherme estava com a captura parada desde as 22:46 da vespera
// e mesmo assim comeu 97 CLIQUES PAGOS no dia seguinte. Ele e o primeiro da fila do vendedor, e a
// guarda de mudo media uma janela de 30 minutos e ESQUECIA: a cada janela nova o numero morto era
// retestado, e cada teste custava ate 20 cliques. O conserto e prender quem foi pego e so soltar com
// PROVA de captura (uma mensagem entrando por aquele numero).
//
// Roda o codigo DE VERDADE: recorta o bloco do worker.js e executa com um banco de mentira.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg); };

const ini = src.indexOf('let _mudoCache = null, _mudoT = 0;');
const fim = src.indexOf('function _mudoPresoAgora()', ini);
if (ini < 0 || fim < 0) { console.error('NAO ACHEI o bloco do mudo no worker.js'); process.exit(1); }
const fimLinha = src.indexOf('\n', fim);
const trecho = src.slice(ini, fimLinha);

// Guardas do que nao pode voltar
if (!/_mudoPreso\[k\] = Math\.floor/.test(trecho)) falhas.push('a guarda nao prende mais o numero pego mudo');
if (!/ROLETA_MUDO_SOLTO/.test(trecho)) falhas.push('sumiu o registro de quando o numero e solto');
if (!/_writeConfig\(env, MUDO_PRESO_KEY/.test(trecho)) falhas.push('o conjunto preso deixou de ser gravado: volta a morrer com o isolate');

const monta = () => {
  const mod = 'const MUDO_JANELA = 1800;\nconst MUDO_VISITAS = 20;\n'
    + 'let _cfg = {};\n'
    + 'let _gravou = 0;\n'
    + 'const _readConfig = async (env, k) => (k in _cfg ? _cfg[k] : null);\n'
    + 'const _writeConfig = async (env, k, v) => { _cfg[k] = v; _gravou += 1; };\n'
    + trecho
    + '\nreturn { mudos: _numerosMudos, reset: () => { _mudoT = 0; }, cfg: () => _cfg, gravou: () => _gravou,'
    + ' esqueceMemoria: () => { _mudoPreso = null; _mudoT = 0; }, tabela: () => _mudoTabela };';
  return new Function(mod)();
};

// banco de mentira: devolve as linhas de visita/mensagem que o caso quiser
const fazEnv = (linhas) => ({
  DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: linhas }), run: async () => ({}) }), run: async () => ({}) }) },
});

const L = (nk, visitas, msgs) => ({ nk, visitas, msgs });

// ── 1. pega o mudo e prende ───────────────────────────────────────────────────────────────────
{
  const m = monta();
  const r1 = await m.mudos(fazEnv([L('72518066', 42, 0), L('95983293', 60, 30)]));
  ok(r1['72518066'] !== undefined, '42 visitas sem UMA mensagem: sai da roleta');
  ok(r1['95983293'] === undefined, 'numero que registra mensagem nao e tocado');
  ok(JSON.parse(m.cfg()['roleta_mudo_preso'] || '{}')['72518066'] > 0, 'o preso foi gravado no app_config');

  // ── 2. janela seguinte com POUCA visita: continua fora (era aqui que ele voltava) ───────────
  m.reset();
  const r2 = await m.mudos(fazEnv([L('72518066', 3, 0), L('95983293', 50, 25)]));
  ok(r2['72518066'] !== undefined, 'janela nova com 3 visitas: CONTINUA fora (nao e retestado)');

  // ── 3. sem visita nenhuma: sem trafego nao ha prova, segue preso ────────────────────────────
  m.reset();
  const r3 = await m.mudos(fazEnv([L('95983293', 50, 25)]));
  ok(r3['72518066'] !== undefined, 'sem visita na janela: segue preso, porque nao houve prova');

  // ── 4. chegou UMA mensagem: solta ───────────────────────────────────────────────────────────
  m.reset();
  const r4 = await m.mudos(fazEnv([L('72518066', 5, 1), L('95983293', 50, 25)]));
  ok(r4['72518066'] === undefined, 'uma mensagem entrando solta o numero');
  ok(JSON.parse(m.cfg()['roleta_mudo_preso'] || '{}')['72518066'] === undefined, 'e some do app_config');

  // ── 5. solto, nao volta sozinho ─────────────────────────────────────────────────────────────
  m.reset();
  const r5 = await m.mudos(fazEnv([L('72518066', 5, 0), L('95983293', 50, 25)]));
  ok(r5['72518066'] === undefined, 'depois de solto, 5 visitas sem mensagem nao prendem de novo (o teto e 20)');
}

// ── 6. isolate novo: o preso tem que vir do banco, nao da memoria ──────────────────────────────
{
  const m = monta();
  await m.mudos(fazEnv([L('72518066', 42, 0)]));
  const guardado = m.cfg()['roleta_mudo_preso'];
  m.esqueceMemoria();                       // simula outro isolate: memoria zerada, app_config igual
  const r = await m.mudos(fazEnv([L('72518066', 1, 0)]));
  ok(r['72518066'] !== undefined, 'isolate novo le o preso do app_config e NAO devolve o numero pra roleta');
  ok(!!guardado, 'o conjunto estava gravado antes do isolate novo');
}

// ── 7. nao grava a toa (cada gravacao e uma ida ao banco no caminho quente) ────────────────────
{
  const m = monta();
  await m.mudos(fazEnv([L('72518066', 42, 0)]));
  const g1 = m.gravou();
  m.reset();
  await m.mudos(fazEnv([L('72518066', 42, 0)]));
  ok(m.gravou() === g1, 'conjunto sem mudanca nao grava de novo');
}

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  todas as conferencias passaram.');
