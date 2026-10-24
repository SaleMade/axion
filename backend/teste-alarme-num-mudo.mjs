// TESTE DO ALARME POR NUMERO (23/10/2026, revisto no mesmo dia a pedido do Bruno: "esses alertas
// estao meio perdidos (...) os numeros estao todos corretos").
//
// O alarme nasceu pro 8066 do Guilherme: um numero morto no meio de numeros vivos, 97 cliques pagos
// queimados, e o alarme do vendedor calado porque os outros numeros dele registravam.
// A revisao: o aviso saia 1 minuto depois da prisao (o 3977 foi solto 1 min depois do aviso), dizia
// "parou de receber" num numero que recebia normal, e ia pra direcao em tudo. Agora: so avisa quem
// continua preso depois de 10 min, a frase diz o que e (nao esta marcando / esta fechado), e a
// direcao so recebe o que passa de 40 min sem conserto.
//
// Roda o codigo DE VERDADE: recorta a funcao do worker.js e executa com banco e push de mentira.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg); };

const ini = src.indexOf('const MUDO_AVISO_VENDEDOR');
const fim = src.indexOf('\nasync function _alarmeCapturaParada(env) {', ini);
if (ini < 0 || fim < 0) { console.error('NAO ACHEI a _alarmeNumeroMudo no worker.js'); process.exit(1); }
const fonte = src.slice(ini, fim);

ok(/'roleta_mudo_preso'/.test(fonte), 'o alarme sai do mesmo conjunto que a roleta mantem');
ok(/21600/.test(fonte), 'tem trinco de 6 h por numero');
ok(!/parou de receber/.test(fonte), 'nao diz mais "parou de receber" (o numero recebe; o que falha e a marcacao)');
ok(src.indexOf('await _alarmeNumeroMudo(env)') > 0, 'o cron chama o alarme');

const agora = () => Math.floor(Date.now() / 1000);
const monta = (cfg, chips, users, uso) => {
  const avisos = [];
  let grav = 0;
  const mod = 'let _cfg = ' + JSON.stringify(cfg) + ';\n'
    + 'let _grav = 0;\n'
    + 'const _readConfig = async (env, k) => (k in _cfg ? _cfg[k] : null);\n'
    + 'const _writeConfig = async (env, k, v) => { _cfg[k] = v; _grav += 1; };\n'
    + 'const _getDashData = async () => (' + JSON.stringify({ chips }) + ');\n'
    + 'const _wpParaPessoa = async (env, id, msg) => { globalThis.__avisos.push({ id, title: msg.title, body: msg.body, tag: msg.tag }); };\n'
    + fonte
    + '\nreturn { roda: _alarmeNumeroMudo, cfg: () => _cfg, grav: () => _grav };';
  globalThis.__avisos = avisos;
  const api = new Function(mod)();
  const resp = (sql, args) => {
    if (/swweb_uso/.test(sql)) return (uso || []).filter((x) => x.ate > args[0]);
    if (/lower\(role\)/.test(sql)) return users.filter((u) => ['diretor', 'socio'].includes(u.role));
    return users;
  };
  const env = { DB: { prepare: (sql) => ({ all: async () => ({ results: resp(sql, []) }), bind: (...a) => ({ all: async () => ({ results: resp(sql, a) }) }) }) } };
  return { ...api, env, avisos };
};

const CHIPS = [
  { num: '(11) 97251-8066', at: 'atendente_vra3lh' },
  { num: '(15) 99250-3977', at: 'atendente_vra3lh' },
  { num: '(15) 97400-9352', at: 'ccol_6' },
  { num: '(54) 98108-9176', at: 'atendente_awpftn', afl: 'afl_3d767329' },
];
const USERS = [{ id: 'dir', name: 'Heynan Dantas', role: 'diretor' }, { id: 'atendente_vra3lh', name: 'Guilherme Souza', role: 'atendente' }];
// aberto ha 3 h nesta maquina (o aluguel: desde quando e ate quando vale)
const ABERTO_8066 = [{ nk: '1172518066', desde: agora() - 3 * 3600, ate: agora() + 120 }];
const aberto = (nk, haSeg) => [{ nk, desde: agora() - haSeg, ate: agora() + 120 }];
const preso = (o) => ({ roleta_mudo_preso: JSON.stringify(o) });

// ── 1. O CASO DO 3977: preso ha 1 minuto nao avisa ninguem ───────────────────────────────────
{
  const m = monta(preso({ 92503977: agora() - 60 }), CHIPS, USERS, []);
  await m.roda(m.env);
  ok(m.avisos.length === 0, 'preso ha 1 min (o 3977 foi solto 1 min depois do aviso): ninguem e avisado');
}

// ── 2. preso ha 15 min, com o app aberto: o vendedor, com a frase certa ──────────────────────
{
  const m = monta(preso({ 72518066: agora() - 900 }), CHIPS, USERS, ABERTO_8066);
  await m.roda(m.env);
  ok(m.avisos.length === 1 && m.avisos[0].id === 'atendente_vra3lh', 'aos 15 min avisa so o dono (deu: ' + m.avisos.map((a) => a.id).join(',') + ')');
  const a = m.avisos[0] || {};
  ok(/97251-8066 não está marcando os leads/.test(a.title), 'diz QUAL numero e que ele nao esta marcando: ' + a.title);
  ok(/Feche e abra/.test(a.body) && /volta sozinho quando a primeira mensagem dele chegar na dash/.test(a.body), 'e o que fazer, sem prometer volta na hora: ' + a.body);
  ok(a.tag === 'num-mudo-72518066', 'a etiqueta e por numero');
  await m.roda(m.env);
  ok(m.avisos.length === 1, 'na volta seguinte do cron nao repete');
}

// ── 3. NINGUEM COM ELE ABERTO NAO AVISA NINGUEM (24/10/2026: 14 avisos "esta fechado" de madrugada) ──
{
  const m = monta(preso({ 72518066: agora() - 5 * 3600 }), CHIPS, USERS, [{ nk: '1172518066', desde: agora() - 9 * 3600, ate: agora() - 30 }]);
  await m.roda(m.env);
  ok(m.avisos.length === 0, 'aluguel vencido (vendedor dormindo, app fechado): ninguem e avisado, nem a direcao');
  await m.roda(m.env);
  ok(m.avisos.length === 0 && !(JSON.parse(m.cfg().roleta_mudo_avisado || '{}')['72518066']), 'e nao entra no trinco: se ele abrir e nao marcar, o aviso ainda sai')
  // de manha ele abre: o relogio conta da abertura, nao da prisao
  const m2 = monta(preso({ 72518066: agora() - 5 * 3600 }), CHIPS, USERS, aberto('1172518066', 300));
  await m2.roda(m2.env);
  ok(m2.avisos.length === 0, 'preso de madrugada e aberto ha 5 min: ainda nao avisa (10 min contados da abertura)');
  const m3 = monta(preso({ 72518066: agora() - 5 * 3600 }), CHIPS, USERS, aberto('1172518066', 900));
  await m3.roda(m3.env);
  ok(m3.avisos.map((a) => a.id).join(',') === 'atendente_vra3lh', 'aberto ha 15 min e sem marcar: so o vendedor (a direcao so com 40 min de aberto)');
}

// ── 4. a direcao so aos 40 min, e uma vez ─────────────────────────────────────────────────────
{
  const m = monta(preso({ 72518066: agora() - 900 }), CHIPS, USERS, ABERTO_8066);
  await m.roda(m.env);
  // passou o tempo: agora faz 45 min
  m.cfg().roleta_mudo_preso = JSON.stringify({ 72518066: agora() - 2700 });
  await m.roda(m.env);
  const dir = m.avisos.filter((x) => x.id === 'dir');
  ok(dir.length === 1, 'aos 45 min sem conserto a direcao recebe (deu ' + dir.length + ')');
  ok(dir[0] && /^Guilherme: \(11\) 97251-8066 não está marcando os leads$/.test(dir[0].title), 'com o nome de quem e: ' + (dir[0] || {}).title);
  ok(dir[0] && /Faz 45 min/.test(dir[0].body) && /Guilherme fechar e abrir/.test(dir[0].body), 'e quanto tempo faz: ' + (dir[0] || {}).body);
  ok(m.avisos.filter((x) => x.id === 'atendente_vra3lh').length === 1, 'o vendedor nao recebe de novo');
  await m.roda(m.env);
  ok(m.avisos.length === 2, 'e ninguem recebe de novo na volta seguinte');
}

// ── 5. aberto faz horas, preso faz horas e nunca avisado (deploy no meio): os dois de uma vez ──
{
  const m = monta(preso({ 72518066: agora() - 5 * 3600 }), CHIPS, USERS, ABERTO_8066);
  await m.roda(m.env);
  ok(m.avisos.map((a) => a.id).sort().join(',') === 'atendente_vra3lh,dir', 'aberto ha 3 h e preso ha 5 h sem aviso: dono e direcao');
}

// ── 6. PISCA (solto e preso de novo): nao avisa de novo dentro de 6 h ─────────────────────────
{
  const m = monta(preso({ 72518066: agora() - 900 }), CHIPS, USERS, ABERTO_8066);
  await m.roda(m.env);
  m.cfg().roleta_mudo_preso = '{}';
  await m.roda(m.env);
  m.cfg().roleta_mudo_preso = JSON.stringify({ 72518066: agora() - 700 });
  await m.roda(m.env);
  ok(m.avisos.length === 1, 'voltou e caiu de novo dentro de 6 h: nao avisa outra vez (antes avisava a cada piscada)');
  // 7 h depois do aviso, o trinco venceu
  const ja = JSON.parse(m.cfg().roleta_mudo_avisado);
  ja['72518066'] = { v: agora() - 7 * 3600 };
  m.cfg().roleta_mudo_avisado = JSON.stringify(ja);
  await m.roda(m.env);
  ok(m.avisos.length === 2 && m.avisos[1].id === 'atendente_vra3lh', 'passadas 6 h, se ainda estiver preso, avisa de novo');
}

// ── 7. o formato velho do trinco ({ nk: ts }) conta como ja avisado ───────────────────────────
{
  const m = monta({ ...preso({ 72518066: agora() - 5 * 3600 }), roleta_mudo_avisado: JSON.stringify({ 72518066: agora() - 3600 }) }, CHIPS, USERS, ABERTO_8066);
  await m.roda(m.env);
  ok(m.avisos.length === 0, 'quem ja foi avisado no formato antigo nao recebe de novo depois do deploy');
}

// ── 8. numero sem dono (coluna da Contingencia): so a direcao, no primeiro prazo ─────────────
{
  const m = monta(preso({ 74009352: agora() - 900 }), CHIPS, USERS, aberto('1574009352', 3600));
  await m.roda(m.env);
  ok(m.avisos.length === 1 && m.avisos[0].id === 'dir', 'numero de coluna aberto e sem marcar avisa a direcao aos 15 min');
}

// ── 9. numero de AFILIADO: so o dono dele, nunca a direcao, e sem gravar a cada volta ─────────
{
  const m = monta(preso({ 81089176: agora() - 5 * 3600 }), CHIPS, USERS, aberto('5481089176', 3600));
  await m.roda(m.env);
  ok(m.avisos.length === 1 && m.avisos[0].id === 'atendente_awpftn', 'numero de afiliado avisa so o dono (deu: ' + m.avisos.map((a) => a.id).join(',') + ')');
  const g = m.grav();
  await m.roda(m.env);
  ok(m.grav() === g && m.avisos.length === 1, 'e na volta seguinte nao avisa nem regrava nada');
}

// ── 10. conjunto vazio nao faz nada ───────────────────────────────────────────────────────────
{
  const m = monta(preso({}), CHIPS, USERS, []);
  await m.roda(m.env);
  ok(m.avisos.length === 0 && m.grav() === 0, 'ninguem preso, ninguem avisado, nada gravado');
}

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  todas as conferencias passaram.');
