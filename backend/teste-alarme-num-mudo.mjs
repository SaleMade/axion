// TESTE DO ALARME POR NUMERO (23/10/2026).
//
// O alarme que ja existia olha o VENDEDOR e so dispara quando NENHUM funil dele teve saida. Com 3 ou
// 4 numeros por pessoa, um numero morto no meio de numeros vivos nunca chega la - foi exatamente o
// 8066 do Guilherme em 23/10, mudo desde a vespera, 97 cliques pagos queimados, alarme calado porque
// o 3293 dele continuava registrando.
//
// Roda o codigo DE VERDADE: recorta a funcao do worker.js e executa com banco e push de mentira.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg); };

const ini = src.indexOf('async function _alarmeNumeroMudo(env) {');
const fim = src.indexOf('\nasync function _alarmeCapturaParada(env) {', ini);
if (ini < 0 || fim < 0) { console.error('NAO ACHEI a _alarmeNumeroMudo no worker.js'); process.exit(1); }
const fonte = src.slice(ini, fim);

ok(/'roleta_mudo_preso'/.test(fonte), 'o alarme sai do mesmo conjunto que a roleta mantem');
ok(/21600/.test(fonte), 'tem trinco de 6 h por numero');
ok(/delete ja\[k\]/.test(fonte), 'numero que voltou sai do trinco, pra proxima queda avisar de novo');
ok(src.indexOf('await _alarmeNumeroMudo(env)') > 0, 'o cron chama o alarme');

const monta = (cfg, chips, users) => {
  const avisos = [];
  const mod = 'let _cfg = ' + JSON.stringify(cfg) + ';\n'
    + 'const _readConfig = async (env, k) => (k in _cfg ? _cfg[k] : null);\n'
    + 'const _writeConfig = async (env, k, v) => { _cfg[k] = v; };\n'
    + 'const _getDashData = async () => (' + JSON.stringify({ chips }) + ');\n'
    + 'const _wpParaPessoa = async (env, id, msg) => { globalThis.__avisos.push({ id, title: msg.title, body: msg.body, tag: msg.tag }); };\n'
    + fonte
    + '\nreturn { roda: _alarmeNumeroMudo, cfg: () => _cfg };';
  globalThis.__avisos = avisos;
  const api = new Function(mod)();
  const env = { DB: { prepare: (sql) => ({ all: async () => ({ results: /lower\(role\)/.test(sql) ? users.filter((u) => ['diretor', 'socio'].includes(u.role)) : users }) }) } };
  return { ...api, env, avisos };
};

const CHIPS = [
  { num: '(11) 97251-8066', at: 'atendente_vra3lh' },
  { num: '(19) 99598-3293', at: 'atendente_vra3lh' },
  { num: '(15) 97400-9352', at: 'ccol_6' },
  { num: '(54) 98108-9176', at: 'atendente_awpftn', afl: 'afl_3d767329' },
];
const USERS = [{ id: 'dir', name: 'Heynan Dantas', role: 'diretor' }, { id: 'atendente_vra3lh', name: 'Guilherme', role: 'atendente' }];

// ── 1. numero preso avisa o dono E a direcao, uma vez ─────────────────────────────────────────
{
  const m = monta({ roleta_mudo_preso: JSON.stringify({ 72518066: 1792700000 }) }, CHIPS, USERS);
  await m.roda(m.env);
  const ids = m.avisos.map((a) => a.id).sort();
  ok(ids.join(',') === 'atendente_vra3lh,dir', 'avisa o dono do numero e a direcao (deu: ' + ids.join(',') + ')');
  ok(m.avisos.some((a) => a.title.indexOf('97251-8066') >= 0), 'o aviso diz QUAL numero');
  ok(m.avisos.every((a) => a.tag === 'num-mudo-72518066'), 'a etiqueta e por numero, nao por vendedor');

  const antes = m.avisos.length;
  await m.roda(m.env);
  ok(m.avisos.length === antes, 'nao repete o aviso do mesmo numero (trinco)');
}

// ── 2. numero que voltou sai do trinco ────────────────────────────────────────────────────────
{
  const m = monta({ roleta_mudo_preso: JSON.stringify({ 72518066: 1 }) }, CHIPS, USERS);
  await m.roda(m.env);
  const n1 = m.avisos.length;
  // voltou a capturar: a roleta tirou do conjunto
  m.cfg().roleta_mudo_preso = JSON.stringify({});
  await m.roda(m.env);
  ok(JSON.parse(m.cfg().roleta_mudo_avisado || '{}')['72518066'] === undefined, 'saiu do trinco quando voltou');
  // e caiu de novo: avisa outra vez
  m.cfg().roleta_mudo_preso = JSON.stringify({ 72518066: 2 });
  await m.roda(m.env);
  ok(m.avisos.length > n1, 'caiu de novo depois de voltar: avisa de novo');
}

// ── 3. numero sem dono (coluna da Contingencia) avisa so a direcao ────────────────────────────
{
  const m = monta({ roleta_mudo_preso: JSON.stringify({ 74009352: 1 }) }, CHIPS, USERS);
  await m.roda(m.env);
  ok(m.avisos.length === 1 && m.avisos[0].id === 'dir', 'numero de coluna avisa so a direcao');
}

// ── 3b. numero de AFILIADO avisa so o dono dele, nunca a direcao da casa ─────────────────────
// Regra do isolamento: o Bruno nao responde por chip do Giovane, e aviso que nao e da operacao dele
// vira ruido que ensina a ignorar o aviso que importa.
{
  const m = monta({ roleta_mudo_preso: JSON.stringify({ 81089176: 1 }) }, CHIPS, USERS);
  await m.roda(m.env);
  const ids = m.avisos.map((a) => a.id);
  ok(ids.length === 1 && ids[0] === 'atendente_awpftn', 'numero de afiliado avisa so o dono (deu: ' + ids.join(',') + ')');
}

// ── 4. conjunto vazio nao faz nada ────────────────────────────────────────────────────────────
{
  const m = monta({ roleta_mudo_preso: '{}' }, CHIPS, USERS);
  await m.roda(m.env);
  ok(m.avisos.length === 0, 'ninguem preso, ninguem avisado');
}

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  todas as conferencias passaram.');
