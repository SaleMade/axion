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
// PARA NA ROTA NOVA, nao no handleUpdateLead: a GET /api/lead/<id>/comments (30/10/2026) nasceu
// entre as duas funcoes, e levar ela no recorte poe no eval um monte de dependencia que este teste
// nao finge (authUser, leads_arquivo).
const fim = src.indexOf('\nasync function handleLeadComments(', ini);
if (ini < 0 || fim < 0) { console.error('NAO ACHEI a _comentarioRapido no worker.js'); process.exit(1); }
const fonte = src.slice(ini, fim);
// O REGISTRO VAI JUNTO, DE VERDADE (30/10/2026): o caminho curto chama _comentLogStmt e poe a
// instrucao no MESMO lote da conferencia. Com um dublê isso nao seria testado - e e justamente o
// pedaco que pode custar uma ida a mais ao banco na acao mais usada do modal.
const iniLog = src.indexOf('let _comentLogOk = false;');
const fimLog = src.indexOf('\n// COMENTARIO NAO PRECISA REESCREVER O BLOB INTEIRO', iniLog);
if (iniLog < 0 || fimLog < 0) { console.error('NAO ACHEI o _comentLogStmt no worker.js'); process.exit(1); }
const fonteLog = src.slice(iniLog, fimLog);
// A TRAVA DO PEDIDO DO COLEGA (19/11/2026): a de verdade, recortada do worker.
const mSoVe = src.match(/function _soVePedido\([\s\S]*?\r?\n\}\r?\n/);
if (!mSoVe) { console.error('NAO ACHEI a _soVePedido no worker.js'); process.exit(1); }

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
const monta = (leads, { mudaIndice = false, semJsonEach = false, mentirNaConferencia = false, registroQuebra = false } = {}) => {
  const estado = { leads: JSON.parse(JSON.stringify(leads)) };
  let gravou = null, chamadas = 0;
  const registros = [];   // o que foi pro coment_log
  let lotes = 0;          // quantas idas ao banco o lote economizou (tem que ser 1 por salvamento)
  const mod = 'const err = (m, c) => ({ __erro: true, status: c || 400, msg: m });\n'
    + 'const json = (o) => ({ __ok: true, corpo: o });\n'
    + 'const afiliadoSemVinculo = (u) => u.role === "afiliado" && !u.afiliado_id;\n'
    + 'const noMundoAfiliado = (u) => !!u.afiliado_id;\n'
    + 'const aflDe = (u) => String(u.afiliado_id || "");\n'
    + 'const isDirector = (u) => u && ["diretor", "socio", "produtor"].includes(u.role);\n'
    + 'const _SO_VER_PEDIDO = "so ver";\n'
    + mSoVe[0] + '\n'
    + 'const _comentarioLimpo = (c, u) => ({ who: String((c && c.who) || u.id), tx: String((c && c.tx) || ""), time: String((c && c.time) || "01/01 00:00") });\n'
    + fonteLog + '\n' + fonte + '\nreturn _comentarioRapido;';
  const fn = new Function(mod)();
  const env = {
    DB: {
      batch: async (lista) => {
        lotes += 1;
        const out = [];
        for (const st of (lista || [])) {
          if (st && st.__coment) { registros.push(st.__b); out.push({ results: [] }); continue; }
          const row = (st && st.first) ? await st.first() : null;
          out.push({ results: row ? [row] : [] });
        }
        return out;
      },
      prepare: (sql) => ({
        __sql: sql,
        run: async () => {
          // CREATE TABLE do registro (a primeira gravacao de cada isolate)
          if (registroQuebra && /coment_log/.test(sql)) throw new Error('sem permissao pra criar tabela');
          return { meta: { changes: 1 } };
        },
        bind: (...b) => ({
          __sql: sql,
          __b: b,
          __coment: /INSERT INTO coment_log/.test(sql),
          first: async () => {
            if (semJsonEach) throw new Error('no such function: json_each');
            if (/json_each/.test(sql)) {
              const i = estado.leads.findIndex((l) => String(l.id) === String(b[0]));
              if (i < 0) return null;
              const l = estado.leads[i];
              return { idx: i, afl: String(l.afl || ''), at: String(l.at || ''), coments: JSON.stringify(l.comments || []) };
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
        first: async () => {
          // a RELEITURA depois de gravar: devolve quantos comentarios aquele lead tem agora
          if (/json_array_length/.test(sql)) {
            if (mentirNaConferencia) return { version: 777, n: 999 };
            const m = sql.match(/\$\.leads\[(\d+)\]/);
            const l = estado.leads[Number(m[1])];
            return { version: 777, n: ((l && l.comments) || []).length };
          }
          return /SELECT version/.test(sql) ? { version: 777 } : null;
        },
      }),
    },
  };
  return { fn, env, estado, ver: () => gravou, chamadas: () => chamadas, registros: () => registros, lotes: () => lotes };
};

const LEADS = [
  { id: '100', afl: '', comments: [{ who: 'a', tx: 'velho', time: '01/01 10:00' }] },
  { id: '200', afl: 'afl_x', comments: [] },
  { id: '300', afl: '' },
  { id: '500', afl: '', at: 'atendente_a', comments: [] },
  { id: '600', afl: '', at: 'atendente_b', comments: [{ who: 'atendente_b', tx: 'dele', time: '02/01 10:00' }] },
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

// 2b. O REGISTRO DA GRAVACAO (30/10/2026): uma linha por salvamento, no MESMO lote da conferencia.
{
  const m = monta(LEADS);
  const r = await m.fn(m.env, COBRADOR, '100', { comment_add: { tx: 'novo' } });
  ok(r && r.__ok, 'salvou');
  const reg = m.registros();
  ok(reg.length === 1, 'registrou UMA linha no coment_log (deu: ' + reg.length + ')');
  // ts, quem, lead, via, depois, nota
  ok(reg[0] && reg[0][1] === 'atendente_k1s0gl' && String(reg[0][2]) === '100' && reg[0][3] === 'curto',
    'o registro diz quem, qual pedido e por qual caminho (deu: ' + JSON.stringify(reg[0]) + ')');
  ok(reg[0] && reg[0][4] === 2, 'o registro guarda com quantos comentarios o pedido FICOU (deu: ' + (reg[0] && reg[0][4]) + ')');
  ok(m.lotes() === 1, 'UM lote so: o registro nao custa uma ida a mais ao banco (deu: ' + m.lotes() + ')');
}

// 2c. REGISTRO QUE FALHA NAO DERRUBA A ANOTACAO. Quem escreveu no pedido nao pode receber erro
// porque a tabela de diagnostico nao deu certo.
{
  const m = monta(LEADS, { registroQuebra: true });
  const r = await m.fn(m.env, COBRADOR, '100', { comment_add: { tx: 'novo' } });
  ok(r && r.__ok, 'salvou mesmo com o registro quebrado (deu: ' + JSON.stringify(r) + ')');
  const l = m.estado.leads.find((x) => x.id === '100');
  ok(l.comments.length === 2 && l.comments[0].tx === 'novo', 'o comentario entrou do mesmo jeito');
  ok(m.registros().length === 0, 'e nao registrou nada (a tabela nao existe)');
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

// ── 8. COMENTARIO QUE CHEGA VAZIO NAO PODE VIRAR "ok" (o caso do Bruno em 29/10) ─────────────
{
  const m = monta(LEADS);
  const r = await m.fn(m.env, DIRETOR, '100', { comment_add: 'isso nao e um comentario' });
  ok(r && r.__erro && r.status === 400, 'comentario que nao e objeto vira ERRO, nao ok silencioso (deu: ' + JSON.stringify(r) + ')');
  ok(m.estado.leads[0].comments.length === 1, 'e nada foi gravado por cima');
}

// ── 9. GRAVOU MAS NAO CONFERE: passa a vez em vez de mentir ──────────────────────────────────
{
  const m = monta(LEADS, { mentirNaConferencia: true });
  const r = await m.fn(m.env, DIRETOR, '100', { comment_add: { tx: 'novo' } });
  ok(r === null, 'se a releitura nao bate, devolve null pro caminho de sempre em vez de dizer que salvou');
}

// ── 10. o ok agora diz QUANTOS comentarios ficaram ───────────────────────────────────────────
{
  const m = monta(LEADS);
  const r = await m.fn(m.env, DIRETOR, '100', { comment_add: { tx: 'mais um' } });
  ok(r && r.__ok && r.corpo.comentarios === 2, 'a resposta diz quantos comentarios o pedido tem agora');
}

// ── 11. o vendedor ve o quadro da equipe, mas so mexe no pedido DELE (19/11/2026) ────────────
{
  const VENDEDOR = { id: 'atendente_a', role: 'atendente' };
  const m = monta(LEADS);
  const r = await m.fn(m.env, VENDEDOR, '500', { comment_add: { tx: 'no meu' } });
  ok(r && r.__ok && r.corpo.ok !== false && m.ver() && m.ver().idx === 3, 'o vendedor comenta no pedido dele');
  const m2 = monta(LEADS);
  const r2 = await m2.fn(m2.env, VENDEDOR, '600', { comment_add: { tx: 'no do colega' } });
  ok(r2 && r2.corpo && r2.corpo.ok === false && r2.corpo.error === 'so ver' && !m2.ver() && m2.chamadas() === 0, 'no pedido do colega o comentario e recusado e nada grava');
  const m3 = monta(LEADS);
  const r3 = await m3.fn(m3.env, VENDEDOR, '600', { comment_del: { who: 'atendente_b', time: '02/01 10:00' } });
  ok(r3 && r3.corpo && r3.corpo.ok === false && m3.estado.leads[4].comments.length === 1, 'nem apaga o comentario do colega');
  const m4 = monta(LEADS);
  const r4 = await m4.fn(m4.env, VENDEDOR, '300', { comment_add: { tx: 'sem dono' } });
  ok(r4 && r4.corpo && r4.corpo.ok === false && !m4.ver(), 'pedido sem vendedor tambem e so leitura pra ele');
  const m5 = monta(LEADS);
  const r5 = await m5.fn(m5.env, COBRADOR, '600', { comment_add: { tx: 'cobrando' } });
  ok(r5 && r5.__ok && r5.corpo.ok !== false && m5.ver(), 'o cobrador continua comentando em qualquer pedido da casa');
  const m6 = monta(LEADS);
  const r6 = await m6.fn(m6.env, DIRETOR, '600', { comment_add: { tx: 'direcao' } });
  ok(r6 && r6.__ok && r6.corpo.ok !== false && m6.ver(), 'e a direcao tambem');
}

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  todas as conferencias passaram.');
