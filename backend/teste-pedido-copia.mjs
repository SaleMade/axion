// TESTE DO "MESMO PEDIDO GRAVADO DUAS VEZES" (02/11/2026, incidente dos 6 cards da Ines de Fatima).
// Roda a funcao DE VERDADE: recorta o handlePedidoNovo e o _botCriadoMs do worker.js e monta eles
// com dependencias de mentira (banco, autenticacao, protecao por cargo). Se alguem mexer na regra,
// este teste quebra junto.
//   node teste-pedido-copia.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function recorta(nome) {
  const i = src.indexOf('\nasync function ' + nome + '(') >= 0 ? src.indexOf('\nasync function ' + nome + '(') : src.indexOf('\nfunction ' + nome + '(');
  if (i < 0) throw new Error('nao achei a funcao ' + nome + ' no worker.js');
  const j = src.indexOf('{', src.indexOf('(', i + 1));
  let n = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') n++;
    else if (src[k] === '}') { n--; if (!n) return src.slice(i + 1, k + 1); }
  }
  throw new Error('chave nao fecha em ' + nome);
}
const CODIGO = [recorta('_botCriadoMs'), recorta('handlePedidoNovo')].join('\n');

// ── o mundo de mentira ────────────────────────────────────────────────────────
function monta(leadsIniciais) {
  const banco = { leads: (leadsIniciais || []).slice(), version: 7, gravacoes: 0 };
  const env = {
    DB: {
      prepare(sql) {
        const st = {
          _args: [],
          bind(...a) { st._args = a; return st; },
          async first() {
            if (/SELECT data, version FROM dashboard_state/.test(sql)) return { data: JSON.stringify({ leads: banco.leads, regras: {} }), version: banco.version };
            return null;
          },
          async run() {
            if (/UPDATE dashboard_state/.test(sql)) {
              const [dataStr, ver, , , base] = st._args;
              if (base !== banco.version) return { meta: { changes: 0 } };
              banco.leads = JSON.parse(dataStr).leads;
              banco.version = ver;
              banco.gravacoes++;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
        };
        return st;
      },
    },
  };
  return { banco, env };
}
const logs = [];
// `restrito` = o mundo de afiliado restrito (03/11/2026). O handlePedidoNovo recusa antes de olhar o
// corpo; aqui ele e um interruptor pra o teste cobrir os dois lados.
const fazer = (quem, restrito) => new Function('env', 'logs', 'quem', 'restrito', `
  const authUser = async () => ({ id: quem, user_id: quem, role: 'diretor' });
  const _restritoAgora = async () => !!restrito;
  const err = (m, s) => ({ erro: m, status: s || 400 });
  const json = (o) => o;
  const _arqLimpaJson = (t) => t;
  const _stateProtegido = async (e, u, novo) => novo;
  const _arqPassouDoTeto = () => false;
  const _trimBlobData = () => {};
  const console = { log: (s) => logs.push(String(s)) };
  ${CODIGO}
  return handlePedidoNovo;`)(null, logs, quem, restrito);

const AGORA = 1793652395000;   // o minuto do incidente
const pedido = (over) => ({
  id: AGORA, nome: 'Ines de fatima costa almeida', cpf: '622.574.050-30', wa: '(98) 98913-2437',
  vl: 197, at: 'atendente_6e3cbf', col: 'A Enviar', orig: 'Manual',
  comprovante_url: 'https://x/api/arquivo/comprovante%2F1%2Fvideo.mp4', ...(over || {}),
});
const req = (lead) => ({ method: 'POST', async text() { return JSON.stringify({ lead }); } });

let ok = 0, falhou = 0;
const conf = (nome, vale) => { if (vale) { ok++; } else { falhou++; console.log('  FALHOU: ' + nome); } };

// ── 1) o primeiro pedido grava ────────────────────────────────────────────────
{
  const { banco, env } = monta([]);
  const h = fazer('atendente_6e3cbf');
  const r = await h(req(pedido()), env);
  conf('primeiro pedido grava', r.ok === true && !r.ja && banco.leads.length === 1 && banco.gravacoes === 1);
}
// ── 2) o MESMO id de novo (reenvio da fila) nao duplica ───────────────────────
{
  const { banco, env } = monta([pedido()]);
  const h = fazer('atendente_6e3cbf');
  const r = await h(req(pedido()), env);
  conf('mesmo id devolve ja:true', r.ok === true && r.ja === true && !r.copia && banco.leads.length === 1 && banco.gravacoes === 0);
}
// ── 3) o incidente: 6 cliques, ids diferentes de milissegundos ────────────────
{
  const { banco, env } = monta([]);
  const h = fazer('atendente_6e3cbf');
  const ids = [116, 123, 124, 125, 127, 128].map((n) => AGORA + n);
  const rs = [];
  for (const id of ids) rs.push(await h(req(pedido({ id })), env));
  conf('6 cliques gravam UM pedido so', banco.leads.length === 1 && banco.gravacoes === 1);
  conf('os 5 seguintes voltam como copia', rs.slice(1).every((r) => r.ok && r.ja && r.copia === true));
  conf('a copia aponta pro pedido que ficou', rs.slice(1).every((r) => String(r.id) === String(ids[0])));
  conf('cada copia deixa rastro no log', logs.filter((l) => l.startsWith('PEDIDO_COPIA')).length === 5);
}
// ── 4) copia pelo TELEFONE quando o CPF esta vazio ────────────────────────────
{
  const { banco, env } = monta([pedido({ cpf: '' })]);
  const h = fazer('atendente_6e3cbf');
  const r = await h(req(pedido({ id: AGORA + 900, cpf: '' })), env);
  conf('sem CPF, o telefone segura a copia', r.copia === true && banco.leads.length === 1);
}
// ── 5) telefone com e sem o nono digito e a mesma pessoa ──────────────────────
{
  const { banco, env } = monta([pedido({ cpf: '', wa: '(98) 98913-2437' })]);
  const h = fazer('atendente_6e3cbf');
  const r = await h(req(pedido({ id: AGORA + 900, cpf: '', wa: '(98) 8913-2437' })), env);
  conf('nono digito nao engana', r.copia === true && banco.leads.length === 1);
}
// ── 6) o que NAO pode virar copia ─────────────────────────────────────────────
{
  const casos = [
    ['valor diferente', pedido({ id: AGORA + 900, vl: 497 })],
    ['outro vendedor', pedido({ id: AGORA + 900, at: 'atendente_vra3lh' })],
    ['outro cliente', pedido({ id: AGORA + 900, cpf: '111.111.111-11', wa: '(11) 91234-5678' })],
    ['mais de 2 minutos depois', pedido({ id: AGORA + 125000 })],
    ['mais de 2 minutos antes', pedido({ id: AGORA - 125000 })],
    ['comprovante diferente', pedido({ id: AGORA + 900, comprovante_url: 'https://x/api/arquivo/outro.mp4' })],
    ['sem CPF e sem telefone', pedido({ id: AGORA + 900, cpf: '', wa: '' })],
  ];
  for (const [nome, novo] of casos) {
    const { banco, env } = monta([pedido()]);
    const h = fazer('atendente_6e3cbf');
    const r = await h(req(novo), env);
    conf(nome + ' grava normal', !r.copia && banco.leads.length === 2 && banco.gravacoes === 1);
  }
}
// ── 7) um com anexo e outro sem: a janela decide (nao da pra distinguir) ──────
{
  const { banco, env } = monta([pedido({ comprovante_url: '' })]);
  const h = fazer('atendente_6e3cbf');
  const r = await h(req(pedido({ id: AGORA + 900 })), env);
  conf('um sem anexo ainda e copia', r.copia === true && banco.leads.length === 1);
}
// ── 8) relogio do vendedor adiantado: a conta e entre os IDS, nao contra o servidor ──
{
  const futuro = Date.now() + 9 * 86400000;   // o navegador que mandou esta 9 dias na frente
  const { banco, env } = monta([pedido({ id: futuro })]);
  const h = fazer('atendente_6e3cbf');
  const r = await h(req(pedido({ id: futuro + 300 })), env);
  conf('relogio adiantado nao fura a trava', r.copia === true && banco.leads.length === 1);
}
// ── 9) pedido cancelado antes nao impede um pedido novo de verdade ────────────
// (a copia olha o pedido que esta la, inclusive cancelado; por isso a janela e curta)
{
  const { banco, env } = monta([pedido({ col: 'Cancelado' })]);
  const h = fazer('atendente_6e3cbf');
  const r = await h(req(pedido({ id: AGORA + 300000 })), env);
  conf('meia hora depois cadastra de novo', !r.copia && banco.leads.length === 2);
}

// ── 10) afiliado restrito nao cadastra (03/11/2026) ───────────────────────────
// O gate do roteador ja barra a rota; esta e a segunda tranca, onde o pedido nasce.
{
  const { banco, env } = monta([]);
  const h = fazer('afiliado_fdmx9z', true);
  const r = await h(req(pedido()), env);
  conf('restrito leva 403 e nada e gravado', r && r.status === 403 && banco.leads.length === 0 && banco.gravacoes === 0);
}
{
  const { banco, env } = monta([]);
  const h = fazer('atendente_6e3cbf', false);
  const r = await h(req(pedido()), env);
  conf('quem nao e restrito cadastra igual', r.ok === true && banco.leads.length === 1);
}

console.log((falhou ? 'FALHOU' : 'OK') + ': ' + ok + ' de ' + (ok + falhou) + ' conferencias');
process.exit(falhou ? 1 : 0);
