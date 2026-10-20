// TESTE DA ABA PEDIDOS DA CHEGADA DE LEADS (20/10/2026).
//
// Prova o conserto do "7 vs 6" do Guilherme em 19/10: o cartao do vendedor contava 7 e a aba Pedidos
// mostrava 6. Eram DUAS FONTES na mesma tela - o cartao lia o pedido cadastrado, a lista lia a
// wa_sales (a frase "Pedido Concluido" do WhatsApp) - e tres coisas faziam elas divergirem:
//   (a) o corte por mundo da lista olhava a PRESSEL DO LEAD: venda da casa com lead vindo de pressel
//       de afiliado desaparecia (foi o caso do Nazareno, 19/10 15:16);
//   (b) pedido cadastrado SEM a frase no WhatsApp nao entrava na lista (a Barbara cadastrou 2 em
//       19/10 e a aba dela mostrou zero);
//   (c) a frase com o telefone em outro formato virava linha a mais, sem pedido atras.
//
// COMO ELE LE O CODIGO DE VERDADE: o worker.js e um modulo unico sem exports, entao aqui a gente
// RECORTA a funcao _presselDayMetrics do arquivo e roda com um banco de mentira. Se alguem mexer na
// varredura e quebrar a regra, o teste quebra junto.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

// ── 1. recorta a funcao e roda ────────────────────────────────────────────────────────────────
const ini = src.indexOf('async function _presselDayMetrics(env, day){');
if (ini < 0) { console.error('NAO ACHEI _presselDayMetrics no worker.js'); process.exit(1); }
const fim = src.indexOf('\n}\n', src.indexOf('\n  return m;', ini));
if (fim < 0) { console.error('NAO ACHEI o fim de _presselDayMetrics'); process.exit(1); }
const fonte = src.slice(ini, fim + 3);

const COLS_CANC = ['Cancelado', 'Cancelado sem Custo'];
const atFromInst = (inst) => String(inst || '').replace(/^ax_/, '').replace(/_b$/, '').replace(/_\d{8}$/, '').replace(/_+$/, '');

// banco de mentira: responde por pedaco do SQL
const fazEnv = (cfg) => ({
  DB: {
    prepare(sql) {
      const self = {
        bind: (...b) => { self._b = b; return self; },
        all: async () => {
          if (sql.includes('FROM pressel_day')) return { results: cfg.presselDay || [] };
          if (sql.includes('COUNT(*) c FROM wa_lead') && sql.includes('GROUP BY pid,')) return { results: cfg.porInst || [] };
          if (sql.includes('COUNT(*) c FROM wa_lead')) return { results: cfg.porPid || [] };
          if (sql.includes('FROM wa_lead WHERE pid IS NOT NULL')) {
            const pedidos = new Set((self._b || []).map(String));
            return { results: (cfg.waLead || []).filter((l) => pedidos.has(String(l.phone).slice(-8))) };
          }
          return { results: [] };
        },
        first: async () => null,
        run: async () => ({}),
      };
      return self;
    },
  },
});

const roda = async (cfg, day) => {
  const mod = 'const _COLS_VENDA_CANCELADA = ' + JSON.stringify(COLS_CANC) + ';\n'
    + 'const _atFromInst = ' + atFromInst.toString() + ';\n'
    + 'const _getDashData = async () => globalThis.__ESTADO;\n'
    + fonte + '\nexport default _presselDayMetrics;\n';
  const url = 'data:text/javascript;base64,' + Buffer.from(mod, 'utf8').toString('base64');
  globalThis.__ESTADO = cfg.estado || {};
  const fn = (await import(url)).default;
  return await fn(fazEnv(cfg), day);
};

const DIA = '2026-10-19';
const T = (h, mi) => Math.floor(new Date(DIA + 'T' + String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0') + ':00-03:00').getTime() / 1000);

const cfg = {
  estado: {
    pressels: [{ id: '12', afl: '' }, { id: '7', afl: 'afl_x' }],
    leads: [
      // 1) pedido do Guilherme, lead da pressel da CASA
      { id: 1, ts: T(10, 43), nome: 'Cliente Casa', wa: '(11) 99932-8706', at: 'atendente_g', col: 'Enviado', vl: 497 },
      // 2) pedido do Guilherme, lead da pressel do AFILIADO (o caso do Nazareno)
      { id: 2, ts: T(15, 16), nome: 'Nazareno', wa: '(91) 98527-3451', at: 'atendente_g', col: 'A Enviar', vl: 497 },
      // 3) pedido SEM at: o vendedor sai do dono do numero do lead
      { id: 3, ts: T(16, 0), nome: 'Sem At', wa: '(21) 99906-8678', col: 'Enviado', vl: 497 },
      // 4) pedido SEM LEAD de pressel: entra na lista como "sem rastreio", nao conta como venda
      { id: 4, ts: T(17, 0), nome: 'Fechou na Ligacao', wa: '(62) 99806-1633', at: 'atendente_g', col: 'Enviado', vl: 397 },
      // 5) CANCELADO: nao e venda nem linha
      { id: 5, ts: T(18, 0), nome: 'Cancelou', wa: '(47) 99617-0706', at: 'atendente_g', col: 'Cancelado', vl: 497 },
      // 6) MESMO telefone do 1: uma linha so
      { id: 6, ts: T(19, 0), nome: 'Cliente Casa de novo', wa: '(11) 99932-8706', at: 'atendente_g', col: 'Enviado', vl: 497 },
      // 7) fora do dia
      { id: 7, ts: T(10, 0) - 86400, nome: 'De ontem', wa: '(85) 91111-2222', at: 'atendente_g', col: 'Enviado', vl: 497 },
    ],
  },
  waLead: [
    { phone: '5511999328706', pid: '12', inst: 'ax_atendente_g_66632248', num: '11666322481', src: 'code' },
    { phone: '559185273451', pid: '7', inst: 'ax_atendente_t_91639685', num: '71991639685', src: 'code' },
    { phone: '5521999068678', pid: '12', inst: 'ax_atendente_k_97405847', num: '11974058471', src: 'fifo' },
    { phone: '5585911112222', pid: '12', inst: 'ax_atendente_g_66632248', num: '11666322481', src: 'code' },
  ],
};

const m = await roda(cfg, DIA);
const lista = m.vendasLista || [];
const porNome = {}; for (const x of lista) porNome[x.nome] = x;

ok(lista.length === 4, 'a lista tinha que ter 4 linhas (casa, afiliado, sem at, sem rastreio) e tem ' + lista.length + ': ' + lista.map((x) => x.nome).join(', '));
ok(!!porNome['Cliente Casa'], 'o pedido com lead da casa saiu da lista');
ok(!!porNome['Nazareno'], 'VOLTOU O BUG DE 19/10: pedido da casa com lead de pressel de afiliado nao entra na lista');
ok(porNome['Nazareno'] && porNome['Nazareno'].at === 'atendente_g', 'a venda do Nazareno nao e de quem CADASTROU (at)');
ok(porNome['Nazareno'] && porNome['Nazareno'].pid === '7', 'a linha perdeu o pid do lead (a mascara de pressel e feita depois, na tela)');
ok(porNome['Sem At'] && porNome['Sem At'].at === 'atendente_k', 'pedido sem at tinha que cair no dono do numero do lead');
ok(!!porNome['Fechou na Ligacao'], 'pedido SEM lead de pressel nao entrou na lista (ele e o "sem rastreio")');
ok(porNome['Fechou na Ligacao'] && porNome['Fechou na Ligacao'].pid === '', 'pedido sem lead tinha que vir com pid vazio');
ok(!porNome['Cancelou'], 'pedido em coluna cancelada entrou na lista');
ok(!porNome['Cliente Casa de novo'], 'o mesmo telefone virou duas linhas (dedup quebrou)');
ok(!porNome['De ontem'], 'pedido de outro dia entrou na lista');
ok(porNome['Sem At'] && porNome['Sem At'].src === 'fifo', 'o src do lead nao chegou na linha (e o rotulo "aprox")');
ok(porNome['Cliente Casa'] && porNome['Cliente Casa'].val === 497, 'o valor do pedido nao chegou na linha');

// os contadores NAO podem ter mudado: venda de pressel exige lead, e a do afiliado nao entra no
// cartao da pressel dele (mundo diferente), mas continua no total por vendedor.
ok((m.vendas['12'] || 0) === 2, 'o cartao da pressel 12 tinha que contar 2 vendas e contou ' + (m.vendas['12'] || 0));
ok((m.vendas['7'] || 0) === 0, 'pedido da casa nao pode contar no cartao da pressel do afiliado');
// vendasInst e por INSTANCIA (uma chave com o sufixo do numero, outra sem, quando o cadastrante nao
// e o dono do numero); quem consome reduz por _atFromInst, e e assim que o total do vendedor fecha.
let totG = 0;
for (const k of Object.keys(m.vendasInst || {})) if (atFromInst(k) === 'atendente_g') totG += Number(m.vendasInst[k].v) || 0;
ok(totG === 2, 'o total por vendedor do Guilherme tinha que ser 2 (casa + cruzada) e deu ' + totG);

// ── 2. guardas no codigo da aba ───────────────────────────────────────────────────────────────
const iAba = src.indexOf("} else if(view==='vendas'){");
const fAba = src.indexOf("} else if(view==='leads' && per==='mes'){", iAba);
if (iAba < 0 || fAba < 0) { console.error('NAO ACHEI o ramo da aba Pedidos no worker.js'); process.exit(1); }
const aba = src.slice(iAba, fAba);
ok(!/FROM wa_sales/.test(aba), 'a aba Pedidos voltou a ler a wa_sales: sao duas fontes de novo');
ok(/_presselDayMetrics\(env, day\)/.test(aba), 'a aba Pedidos nao usa mais a varredura dos cartoes');
ok(/vendasLista/.test(aba), 'a aba Pedidos nao le mais o vendasLista');
ok(/_foraDoMundo\(String\(o\.at/.test(aba), 'o corte por mundo da aba nao e mais pelo DONO DA VENDA');
ok(/_presselNaConta\(_uAtual, data\)/.test(aba), 'saiu a mascara da pressel de outro mundo: o nome dela vaza');
ok(/const pid=_pidVis\(o\)/.test(aba), 'a linha nao passa mais pela mascara de pressel');

// ── 3. a PAGINA HTML (/pressels-total) tem que usar a mesma fonte ─────────────────────────────
// Ela tinha uma consulta propria na wa_sales, SEM corte por mundo: mostrava a venda do afiliado na
// pagina da casa e, depois do conserto da dash, uma contagem diferente da dash pro mesmo dia.
const iPag = src.indexOf('async function handlePresselsTotalPage(req, env){')
const fPag = src.indexOf("\nasync function ", iPag + 10)
if (iPag < 0) { console.error('NAO ACHEI handlePresselsTotalPage no worker.js'); process.exit(1) }
const pag = src.slice(iPag, fPag > 0 ? fPag : src.length)
// SO o bloco da aba Pedidos. O resto da pagina ainda consulta a wa_sales de proposito, pra pintar de
// verde o lead que comprou (saleSet) - aquilo e marcacao, nao contagem de pedido.
const iPagV = pag.indexOf("  if(view==='vendas'){")
const fPagV = pag.indexOf("  let leadsHtml='';", iPagV)
if (iPagV < 0 || fPagV < 0) { console.error('NAO ACHEI o bloco da aba Pedidos na pagina'); process.exit(1) }
const pagV = pag.slice(iPagV, fPagV)
ok(!/FROM wa_sales/.test(pagV), 'a aba Pedidos da pagina /pressels-total voltou a ler a wa_sales')
ok(/M\.vendasLista/.test(pag), 'a pagina nao usa mais o vendasLista da varredura')
ok(/view==='metricas' \|\| view==='vendas'/.test(pag), 'a pagina nao calcula a varredura na aba Pedidos: a lista sai vazia')
ok(/_linhaOk\(x\)/.test(pag), 'a lista da pagina perdeu o corte por mundo (_linhaOk)')
ok(/const _temPressel=/.test(pag), 'a pagina nao mascara mais a pressel de outro mundo')
ok(!/_pnm\[String\(o\.pid\)\]\|\|\('Pressel '\+o\.pid\)/.test(pag), 'voltou o fallback que vaza o numero da pressel do afiliado')

// ── 4. comissao do afiliado por pedido vem da linha AFFILIATION, nao de estimativa ───────────
const iAfl = src.indexOf('async function handleAfiliadoPedidos(req, env) {')
const fAfl = src.indexOf('\nasync function ', iAfl + 10)
const afl = src.slice(iAfl, fAfl > 0 ? fAfl : src.length)
ok(/_aflComissaoReal\(o\)/.test(afl), 'a comissao do pedido do afiliado voltou a ser so estimativa')
ok(/' created_at, updated_at, devolucao_id, commissions'/.test(afl), 'a consulta nao traz mais a coluna commissions: a comissao real nao chega')
const iFn = src.indexOf('function _aflComissaoReal(o) {')
ok(iFn > 0, 'nao achei a _aflComissaoReal')
if (iFn > 0) {
  const fn = src.slice(iFn, iFn + 700)
  ok(/affiliat\|afiliad/.test(fn), 'a _aflComissaoReal nao reconhece mais a linha por TIPO (exigir affiliateId zera tudo)')
}

const TOTAL = 31;
if (falhas.length) { console.error('FALHOU (' + falhas.length + '/' + TOTAL + '):\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('teste-aba-pedidos: ' + TOTAL + '/' + TOTAL + ' ok');
