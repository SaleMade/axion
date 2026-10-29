// O COMENTARIO TEM QUE SALVAR SEM REESCREVER O BLOB INTEIRO (29/10/2026).
//
// O cobrador reclamou que escreve, clica e o comentario some ou demora horrores. Medido na producao
// com a sessao dele: 8 s, 18 s e 21 s em tres salvamentos seguidos, e o do meio voltou 409 (perdeu).
// O caminho de sempre move 1,37 MB por TENTATIVA e sao ate 10 tentativas.
//
// Este teste roda a _comentarioRapido DE VERDADE (recortada do worker.js) com um banco de mentira,
// e guarda as quatro coisas que fazem ela ser segura: a lista certa, o gate de mundo, o indice que
// muda no meio do caminho e a passada de vez quando o lead nao esta no blob.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg); };

const ini = src.indexOf('async function _comentarioRapido(env, u, leadId, patch) {');
const fim = src.indexOf('\nasync function handleUpdateLead(', ini);
if (ini < 0 || fim < 0) { console.error('NAO ACHEI a _comentarioRapido no worker.js'); process.exit(1); }
const fonte = src.slice(ini, fim);

// ── guardas de forma: o que nao pode voltar ───────────────────────────────────────────────────
ok(/json_set\(data, '\$\.leads\[" \+ idx \+ "\]\.comments'|json_set\(data, '" \+ caminho \+ "\.comments'/.test(fonte)
  || fonte.includes("json_set(data, '"), 'grava com json_set no caminho do lead, nao o blob inteiro');
ok(!/SELECT data, version FROM dashboard_state/.test(fonte), 'nao le o blob inteiro em lugar nenhum');
ok(/CAST\(json_extract\(data, '" \+ caminho \+ "\.id'\) AS TEXT\) = \?/.test(fonte),
  'a gravacao confere o id NAQUELE indice (protege de o lead mudar de posicao)');
ok(/version = version \+ 1/.test(fonte), 'sobe a version (quem grava o blob inteiro perde o CAS e retenta)');
ok(src.includes('if (_soComent) {'), 'o handleUpdateLead desvia pro caminho curto');
ok(/k === 'comment_add' \|\| k === 'comment_set' \|\| k === 'comment_del'/.test(src),
  'so desvia quando o patch e SO de comentario (campo com gate de cargo nao passa por aqui)');

// ── roda de verdade ───────────────────────────────────────────────────────────────────────────
const monta = (leads, { mudaIndice = false, semJsonEach = false } = {}) => {
  const estado = { leads: JSON.parse(JSON.stringify(leads)) };
  let gravou = null, chamadas = 0;
  const mod = 'const err = (m, c) => ({ __erro: true, status: c || 400, msg: m });\n'
    + 'const json = (o) => ({ __ok: true, corpo: o });\n'
    + 'const afiliadoSemVinculo = (u) => u.role === "afiliado" && !u.afiliado_id;\n'
    + 'const noMundoAfiliado = (u) => !!u.afiliado_id;\n'
    + 'const aflDe = (u) => String(u.afiliado_id || "");\n'
    + 'const _comentarioLimpo = (c, u) => ({ who: String((c && c.who) || u.id), tx: String((c && c.tx) || ""), time: String((c && c.time) || "01/01 00:00") });\n'
    + fonte + '\nreturn _comentarioRapido;';
  const fn = new Function(mod)();
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...b) => ({
          first: async () => {
            if (semJsonEach) throw new Error('no such function: json_each');
            if (/json_each/.test(sql)) {
              const i = estado.leads.findIndex((l) => String(l.id) === String(b[0]));
              if (i < 0) return null;
              const l = estado.leads[i];
              return { idx: i, afl: String(l.afl || ''), coments: JSON.stringify(l.comments || []) };
            }
            return null;
          },
          run: async () => {
            chamadas += 1;
            const m = sql.match(/\$\.leads\[(\d+)\]/);
            const i = Number(m[1]);
            // o banco so grava se o id daquele indice ainda for o mesmo (e o WHERE da instrucao)
            if (mudaIndice && chamadas === 1) estado.leads.unshift({ id: 'outro', comments: [] });
            const l = estado.leads[i];
            if (!l || String(l.id) !== String(b[3])) return { meta: { changes: 0 } };
            l.comments = JSON.parse(b[0]);
            gravou = { idx: i, por: b[2] };
            return { meta: { changes: 1 } };
          },
        }),
        first: async () => (/SELECT version/.test(sql) ? { version: 777 } : null),
      }),
    },
  };
  return { fn, env, estado, ver: () => gravou, chamadas: () => chamadas };
};

const LEADS = [
  { id: '100', afl: '', comments: [{ who: 'a', tx: 'velho', time: '01/01 10:00' }] },
  { id: '200', afl: 'afl_x', comments: [] },
  { id: '300', afl: '' },
];
const DIRETOR = { id: 'dir', role: 'diretor' };
const COBRADOR = { id: 'atendente_k1s0gl', role: 'cobrador' };
const DO_AFILIADO = { id: 'at_afl', role: 'atendente', afiliado_id: 'afl_x' };

// 1. o comentario entra na FRENTE e o resto fica
{
  const m = monta(LEADS);
  const r = await m.fn(m.env, COBRADOR, '100', { comment_add: { tx: 'novo' } });
  ok(r && r.__ok, 'o cobrador salva o comentario (deu: ' + JSON.stringify(r) + ')');
  const l = m.estado.leads.find((x) => x.id === '100');
  ok(l.comments.length === 2 && l.comments[0].tx === 'novo' && l.comments[1].tx === 'velho',
    'entra na frente e nao apaga o que havia (deu: ' + JSON.stringify(l.comments.map((c) => c.tx)) + ')');
  ok(m.ver() && m.ver().por === 'coment:atendente_k1s0gl', 'carimba quem gravou');
  ok(r.corpo && r.corpo.version === 777, 'devolve a version nova pra tela nao recarregar o quadro');
}

// 2. lead sem a chave comments nasce com a lista
{
  const m = monta(LEADS);
  await m.fn(m.env, DIRETOR, '300', { comment_add: { tx: 'primeiro' } });
  const l = m.estado.leads.find((x) => x.id === '300');
  ok(Array.isArray(l.comments) && l.comments.length === 1, 'lead sem comentario nenhum ganha a lista');
}

// 3. teto de 200
{
  const muitos = [{ id: '400', afl: '', comments: Array.from({ length: 200 }, (_, i) => ({ who: 'a', tx: 'c' + i, time: 't' + i })) }];
  const m = monta(muitos);
  await m.fn(m.env, DIRETOR, '400', { comment_add: { tx: 'novo' } });
  const l = m.estado.leads[0];
  ok(l.comments.length === 200 && l.comments[0].tx === 'novo', 'mantem o teto de 200, cortando o mais antigo');
}

// 4. editar e apagar
{
  const m = monta(LEADS);
  await m.fn(m.env, DIRETOR, '100', { comment_set: { who: 'a', time: '01/01 10:00', tx: 'corrigido' } });
  ok(m.estado.leads[0].comments[0].tx === 'corrigido' && m.estado.leads[0].comments[0].editado === true, 'editar troca o texto e marca editado');
  const m2 = monta(LEADS);
  await m2.fn(m2.env, DIRETOR, '100', { comment_del: { who: 'a', time: '01/01 10:00' } });
  ok(m2.estado.leads[0].comments.length === 0, 'apagar tira da lista');
}

// 5. GATE DE MUNDO: o afiliado nao comenta em pedido da casa, e vice-versa
{
  const m = monta(LEADS);
  const r = await m.fn(m.env, DO_AFILIADO, '100', { comment_add: { tx: 'xereta' } });
  ok(r && r.__erro && r.status === 404, 'gente do afiliado nao comenta em pedido da casa');
  const m2 = monta(LEADS);
  const r2 = await m2.fn(m2.env, DO_AFILIADO, '200', { comment_add: { tx: 'meu' } });
  ok(r2 && r2.__ok, 'mas comenta no pedido do mundo dela');
  const m3 = monta(LEADS);
  const r3 = await m3.fn(m3.env, { id: 'solto', role: 'afiliado' }, '100', { comment_add: { tx: 'x' } });
  ok(r3 && r3.__erro && r3.status === 404, 'afiliado sem vinculo nao comenta em nada');
}

// 6. O INDICE MUDOU NO MEIO (a captura inseriu um lead no topo): refaz e grava no lugar certo
{
  const m = monta(LEADS, { mudaIndice: true });
  const r = await m.fn(m.env, DIRETOR, '100', { comment_add: { tx: 'depois da enxurrada' } });
  ok(r && r.__ok, 'grava mesmo com o lead mudando de posicao no meio (deu: ' + JSON.stringify(r) + ')');
  const l = m.estado.leads.find((x) => x.id === '100');
  ok(l.comments[0].tx === 'depois da enxurrada', 'e o comentario foi pro lead CERTO');
  const outro = m.estado.leads.find((x) => x.id === 'outro');
  ok(!outro.comments.length, 'o lead que entrou no topo nao recebeu nada');
  ok(m.chamadas() === 2, 'precisou de 2 tentativas, nao de 10 (deu ' + m.chamadas() + ')');
}

// 7. PASSA A VEZ quando nao e caso dele
{
  const m = monta(LEADS);
  const r = await m.fn(m.env, DIRETOR, '999', { comment_add: { tx: 'x' } });
  ok(r === null, 'lead que nao esta no blob (arquivo) devolve null pro caminho de sempre');
  const m2 = monta(LEADS, { semJsonEach: true });
  const r2 = await m2.fn(m2.env, DIRETOR, '100', { comment_add: { tx: 'x' } });
  ok(r2 === null, 'banco sem json_each tambem devolve null em vez de quebrar');
}

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  todas as conferencias passaram.');
