// TESTE DO BOT NO GRUPO DOS COBRADORES (03/11/2026, pedido do Bruno: "o bot esta mandando tudo
// certinho no grupo dos vendedores, agora quero que ele faca o mesmo no grupo dos cobradores").
//
// Roda o CODIGO DE VERDADE: recorta do worker.js o modulo inteiro do bot (da linha "BOT DE WHATSAPP
// DO TIME" ate as rotas) e o _botEnviarCob, e monta tudo com dependencias de mentira (banco, blob,
// relogio). Se alguem mexer numa regra ou trocar o nome de uma funcao, este teste quebra junto.
//
// O que ele guarda, em ordem de importancia:
//   1. o grupo do TIME nao sente nada (as duas agendas sao independentes e uma nao consome a chave
//      da outra: no mesmo horario, os dois resumos tem que sair);
//   2. os numeros sao os da tela Cobranca > Cobradores (pagamento manda, mesa e estado de agora);
//   3. salvar so a cobranca nao apaga nada do time, e vice-versa.
//
//   node teste-bot-cobranca.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function recortaBloco(de, ate) {
  const i = src.indexOf(de);
  const j = src.indexOf(ate, i + 1);
  if (i < 0 || j < 0) throw new Error('nao achei o bloco entre "' + de + '" e "' + ate + '"');
  return src.slice(i, j);
}
function recortaFuncao(nome) {
  const a = src.indexOf('\nasync function ' + nome + '(');
  const i = a >= 0 ? a : src.indexOf('\nfunction ' + nome + '(');
  if (i < 0) throw new Error('nao achei a funcao ' + nome + ' no worker.js');
  const j = src.indexOf('{', src.indexOf('(', i + 1));
  let n = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') n++;
    else if (src[k] === '}') { n--; if (!n) return src.slice(i + 1, k + 1); }
  }
  throw new Error('chave nao fecha em ' + nome);
}

const MODULO = recortaBloco('// BOT DE WHATSAPP DO TIME (12/10/2026', '// ─── Rotas /api/bot/* (so diretor');
for (const esperado of ['_botCobPadrao', '_botCobNormaliza', '_botDadosCob', '_botTextoCobranca', '_botCobTick', '_botCobMarcosTick', '_botCobIncentivoTick', '_botEntregarGrupo', 'BOT_COB_ROTULOS_PADRAO']) {
  if (MODULO.indexOf(esperado) < 0) throw new Error('o modulo recortado nao tem ' + esperado + ' (alguem mudou o arquivo de lugar?)');
}
const CODIGO = MODULO + '\n' + recortaFuncao('_botEnviarCob');

// ── o mundo de mentira ──────────────────────────────────────────────────────────────────
const RELOGIO = { agora: Date.parse('2026-11-03T20:05:00-03:00') };
class DataFalsa extends Date {
  constructor(...a) { if (!a.length) super(RELOGIO.agora); else super(...a); }
  static now() { return RELOGIO.agora; }
}

function monta(mundo) {
  const cfgdb = { ...(mundo.config || {}) };
  const leads = mundo.leads || [];
  const cobradores = mundo.cobradores || [];
  const fila = [];      // bot_outbox: o que foi pro WhatsApp Web
  const envios = [];    // bot_envios: o registro
  const db = {
    prepare(sql) {
      const st = {
        _a: [],
        bind(...a) { st._a = a; return st; },
        async run() {
          if (/INSERT INTO app_config/.test(sql) && /ON CONFLICT\(key\) DO NOTHING/.test(sql)) {
            const k = String(st._a[0]);
            if (Object.prototype.hasOwnProperty.call(cfgdb, k)) return { meta: { changes: 0 } };
            cfgdb[k] = String(st._a[1] == null ? '' : st._a[1]);
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO bot_outbox/.test(sql)) { fila.push({ dia: st._a[1], tipo: st._a[2], jid: st._a[3], nome: st._a[4], texto: st._a[5], midia: st._a[7] }); return { meta: { changes: 1 } }; }
          if (/INSERT INTO bot_envios/.test(sql)) { envios.push({ tipo: st._a[2], nome: st._a[3], fone: st._a[4], via: st._a[5], status: st._a[6] }); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (/SELECT version FROM dashboard_state/.test(sql)) return { version: mundo.versao || 1 };
          return null;
        },
        async all() {
          if (/FROM users/.test(sql) && /cobrador/.test(sql)) return { results: cobradores.map((c) => ({ id: c.id, name: c.nome })) };
          if (/FROM users/.test(sql)) return { results: [] };
          return { results: [] };
        },
      };
      return st;
    },
    async batch(l) { const o = []; for (const x of l) o.push(await x.run()); return o; },
    async exec() { return {}; },
  };
  const env = { DB: db };
  const deps = {
    Date: DataFalsa,
    console: { log() {}, error() {}, warn() {} },
    fetch: async () => { throw new Error('o teste nao devia sair pra rede'); },
    AbortSignal,
    crypto,
    _agoraBR: () => new DataFalsa(RELOGIO.agora - 3 * 3600000),
    _brDay: (ts) => new DataFalsa((ts ? ts * 1000 : RELOGIO.agora) - 3 * 3600000).toISOString().slice(0, 10),
    _ehPago: (l) => String((l && l.spg) || '') === 'Pago' || ['Pago', 'Pagos'].includes(String((l && l.col) || '')),
    _COLS_VENDA_CANCELADA: ['Cancelado', 'Cancelado sem Custo'],
    _getDashData: async () => ({ leads }),
    _readConfig: async (_e, k) => (Object.prototype.hasOwnProperty.call(cfgdb, k) ? cfgdb[k] : null),
    _writeConfig: async (_e, k, v) => { cfgdb[k] = String(v); },
    _readConfigMuitas: async (_e, ks) => { const o = {}; for (const k of ks) if (Object.prototype.hasOwnProperty.call(cfgdb, k)) o[k] = cfgdb[k]; return o; },
    _ensureConfigTable: async () => {},
    _atFromInst: () => '',
    _idsDeTodoAfiliado: async () => [],
    _graph: async () => ({ ok: false, status: 0, data: {} }),
    authUser: async () => ({ id: 'u1', name: 'Bruno' }),
    isDirector: () => true,
    isAfiliado: () => false,
    json: (o, s) => ({ _json: o, _status: s || 200 }),
    err: (m, s) => ({ _json: { error: m }, _status: s || 400 }),
  };
  const nomes = Object.keys(deps);
  const f = new Function(...nomes, CODIGO + '\n;return { _botCobPadrao, _botCfgPadrao, _botNormaliza, _botCobNormaliza, _botDadosCob, _botTextoCobranca, _botDispararCob, _botCobTick, _botCobMarcosTick, _botCobIncentivoTick, _botCobProximo, _botEntregarGrupo, _botEnviarCob, _botCobDiaDoResumo, _botCfgLer };');
  return { api: f(...nomes.map((n) => deps[n])), env, cfgdb, fila, envios, mundo };
}

let ok = 0;
const falhas = [];
const conf = (cond, msg) => { if (cond) ok += 1; else falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg); };
const titulo = (t) => console.log('\n' + t);

const DIA = '2026-11-03';
const ms = (s) => Date.parse(s);
// Um pedido pago: `pg` = quando pagou, `vl` = valor, `cob` = o cobrador dono.
const pago = (o) => ({ id: o.id, col: 'Pagos', spg: 'Pago', vl: o.vl, pago_ts: ms(o.pg), cob: o.cob || '', cob_pct: o.pct == null ? 3 : o.pct, ...(o.extra || {}) });
// Um pedido na mesa (entregue, nao pago).
const naMesa = (o) => ({ id: o.id, col: o.col || 'Entregues', vl: o.vl, cob: o.cob || '', agend: o.agend || '', pagamentos: o.pagamentos || [] });

// ══ 1. A CONFIG ════════════════════════════════════════════════════════════════════════
titulo('1. A config da cobranca');
{
  const { api } = monta({});
  const p = api._botCfgPadrao();
  conf(!!p.cobranca, 'a config do bot passou a ter o bloco cobranca');
  conf(p.cobranca.ativo === false, 'e ele nasce DESLIGADO (ninguem recebe nada sem o Bruno ligar)');
  conf(p.cobranca.grupo.id === '', 'sem grupo escolhido');
  conf(p.cobranca.relatorio.hora === '20:00' && p.cobranca.relatorio.titulo === 'Cobrança do dia', 'resumo as 20:00, titulo Cobrança do dia');

  // Grupo: so aceita jid de grupo de verdade.
  const c1 = api._botCobNormaliza({ grupo: { id: '120363000000000000@g.us', nome: 'Cobradores' } }, null);
  conf(c1.grupo.id === '120363000000000000@g.us' && c1.grupo.nome === 'Cobradores', 'aceita o jid do grupo');
  const c2 = api._botCobNormaliza({ grupo: { id: '5515999999999@s.whatsapp.net' } }, null);
  conf(c2.grupo.id === '', 'recusa jid que nao e de grupo (numero de pessoa nao vira grupo)');

  // Campo invalido volta pro que estava gravado.
  const salvo = api._botCobNormaliza({ ativo: true, relatorio: { hora: '19:30', ordenar: 'pedidos' } }, null);
  const dep = api._botCobNormaliza({ relatorio: { hora: '25:99', ordenar: 'inventado' } }, salvo);
  conf(dep.relatorio.hora === '19:30', 'hora invalida fica com a que estava gravada');
  conf(dep.relatorio.ordenar === 'pedidos', 'ordenacao desconhecida fica com a gravada');
  conf(dep.ativo === true, 'e o liga/desliga nao se perde quando o POST nao fala dele');

  // Metas: so numero util.
  const mt = api._botCobNormaliza({ metas: { semanal: { cob1: 35, cob2: 0, cob3: -4, cob4: '12' } } }, null);
  conf(mt.metas.semanal.cob1 === 35 && mt.metas.semanal.cob4 === 12, 'meta da semana aceita numero e texto numerico');
  conf(!('cob2' in mt.metas.semanal) && !('cob3' in mt.metas.semanal), 'meta zero ou negativa sai da config');

  // Marcos: frase vazia some, numero repetido some, lista ordenada.
  const mc = api._botCobNormaliza({ marcos: { lista: [{ n: 10, frases: ['dez'] }, { n: 5, frases: ['cinco'] }, { n: 5, frases: ['cinco de novo'] }, { n: 7, frases: ['   '] }] } }, null);
  conf(mc.marcos.lista.map((m) => m.n).join(',') === '5,10', 'marcos: sem repetido, sem frase vazia, em ordem');

  // O teste que mais importa: salvar a cobranca nao encosta no time, e vice-versa.
  const base = api._botNormaliza({
    grupo: { id: '120363111111111111@g.us', nome: 'Vendedores' },
    pessoas: [{ id: 'v1', nome: 'Kevin', fone: '5515999990000' }],
    relatorio: { hora: '21:00' },
    cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us', nome: 'Cobradores' }, relatorio: { hora: '18:00' } },
  }, null);
  const soCob = api._botNormaliza({ cobranca: { relatorio: { hora: '19:00' } } }, base);
  conf(soCob.grupo.id === '120363111111111111@g.us', 'salvar so a cobranca NAO apaga o grupo do time');
  conf(soCob.pessoas.length === 1 && soCob.relatorio.hora === '21:00', 'nem a lista de quem recebe, nem a hora do time');
  conf(soCob.cobranca.relatorio.hora === '19:00' && soCob.cobranca.grupo.id === '120363222222222222@g.us', 'e a cobranca guarda a hora nova com o grupo dela');
  const soTime = api._botNormaliza({ relatorio: { hora: '22:00' } }, base);
  conf(soTime.cobranca.ativo === true && soTime.cobranca.relatorio.hora === '18:00' && soTime.cobranca.grupo.nome === 'Cobradores', 'salvar so o time NAO apaga a cobranca');
  // Config de antes do bloco existir (o que esta gravado hoje no app_config).
  const velha = api._botNormaliza({ ativo: true, grupo: { id: '120363111111111111@g.us' } }, null);
  conf(velha.cobranca && velha.cobranca.ativo === false, 'config antiga (sem o bloco) ganha a cobranca desligada, sem erro');
}

// ══ 2. OS NUMEROS ══════════════════════════════════════════════════════════════════════
titulo('2. Os numeros da cobranca (as contas da tela Cobranca > Cobradores)');
const MUNDO_NUM = {
  cobradores: [{ id: 'hay', nome: 'Haynan' }, { id: 'ana', nome: 'Ana Paula' }],
  leads: [
    // pagos HOJE
    pago({ id: 1, vl: 300, pg: '2026-11-03T10:00:00-03:00', cob: 'hay' }),
    pago({ id: 2, vl: 200, pg: '2026-11-03T14:00:00-03:00', cob: 'hay' }),
    pago({ id: 3, vl: 500, pg: '2026-11-03T15:00:00-03:00', cob: 'ana' }),
    // pago hoje mas ainda SEM DONO: so o geral conta
    pago({ id: 4, vl: 100, pg: '2026-11-03T16:00:00-03:00', cob: '' }),
    // pago ONTEM
    pago({ id: 5, vl: 400, pg: '2026-11-02T11:00:00-03:00', cob: 'hay' }),
    // pago hoje, mas de AFILIADO: nao e nosso
    { ...pago({ id: 6, vl: 900, pg: '2026-11-03T12:00:00-03:00', cob: 'hay' }), afl: 'afl_x' },
    // pago hoje SEM taxa congelada (pedido velho): entra no recebido, rende zero de comissao
    pago({ id: 7, vl: 1000, pg: '2026-11-03T17:00:00-03:00', cob: 'ana', pct: 0 }),
    // mesa de agora
    naMesa({ id: 8, vl: 250, cob: 'hay' }),                                  // Entregues
    naMesa({ id: 9, vl: 150, cob: 'hay', col: 'Cobrança' }),                 // apelido do Kanban
    naMesa({ id: 10, vl: 350, cob: 'ana', col: 'Retirar nos Correios' }),
    naMesa({ id: 11, vl: 180, cob: 'hay', agend: '2026-11-01T10:00:00-03:00' }),  // vencido = atrasado
    naMesa({ id: 12, vl: 999, cob: 'hay', col: 'Frustrados' }),              // perda: nao e mesa nem a receber
    naMesa({ id: 13, vl: 120, cob: 'ana', col: 'Saiu para Entrega' }),       // na rua, mas nao e fila de cobranca
    naMesa({ id: 14, vl: 777, cob: 'hay', col: 'A Enviar' }),                // nem saiu: nao e "a receber" do cobrador
  ],
};
{
  const { api, env } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ cobranca: { ativo: true, metas: { semanal: { hay: 10 } } } }, null);
  const d = await api._botDadosCob(env, DIA, cfg, 'diario');
  const hay = d.cobradores.find((c) => c.id === 'hay');
  const ana = d.cobradores.find((c) => c.id === 'ana');
  conf(hay.recebido === 500 && hay.pedidos === 2, 'recebido do Haynan hoje: R$ 500 em 2 pedidos (pela data do PAGAMENTO)');
  conf(ana.recebido === 1500 && ana.pedidos === 2, 'recebido da Ana hoje: R$ 1.500 em 2 pedidos');
  conf(d.geral.recebido === 2100 && d.geral.pedidos === 5, 'o geral soma 5 pedidos e R$ 2.100: inclui o que ainda nao tem dono');
  conf(hay.recebido + ana.recebido < d.geral.recebido, 'e por isso o geral pode ser maior que a soma das linhas (nao e erro)');
  conf(d.geral.recebido === 2100, 'o pedido do AFILIADO nao entra em lugar nenhum');
  conf(Math.round(hay.comissao * 100) / 100 === 15, 'comissao do Haynan: 3% de R$ 500 = R$ 15');
  conf(Math.round(ana.comissao * 100) / 100 === 15, 'comissao da Ana: so o pedido com taxa congelada rende (R$ 500 x 3%)');
  conf(hay.ontem.pedidos === 1 && hay.ontem.recebido === 400, 'ontem do Haynan: 1 pedido, R$ 400');
  conf(hay.em_cobranca === 3 && hay.em_cobranca_vl === 580, 'mesa do Haynan: 3 pedidos (Entregues, o apelido Cobrança e o atrasado), R$ 580');
  conf(ana.em_cobranca === 1, 'mesa da Ana: so o Retirar nos Correios');
  conf(hay.atrasados === 1, 'atrasado do Haynan: 1 (retorno marcado venceu e o pedido continua em aberto)');
  conf(ana.atrasados === 0, 'a Ana nao tem atrasado');
  conf(hay.a_receber === 580, 'a receber do Haynan: so o que esta na rua (o A Enviar e o Frustrados ficam de fora)');
  conf(ana.a_receber === 470, 'a receber da Ana: R$ 350 + R$ 120 do que saiu pra entrega');
  conf(hay.meta === 10 && hay.semana >= hay.pedidos, 'a meta da semana vem da config e a semana conta os pagos da semana');
  conf(ana.meta === 0, 'cobrador sem meta cadastrada fica com meta zero');
}
{
  // O mesmo mundo, uma semana: recebido vira a soma da semana.
  const { api, env } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ cobranca: { ativo: true } }, null);
  const d = await api._botDadosCob(env, DIA, cfg, 'semanal');
  const hay = d.cobradores.find((c) => c.id === 'hay');
  conf(hay.recebido === 900 && hay.pedidos === 3, 'no semanal o Haynan soma os 3 pedidos da semana (R$ 900)');
}

// ══ 3. O TEXTO ═════════════════════════════════════════════════════════════════════════
titulo('3. O texto que vai no grupo');
{
  const { api, env } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ cobranca: { ativo: true, metas: { semanal: { hay: 10 } }, relatorio: { mostrar: { comissao: true, ontem: true, destaque: true } } } }, null);
  const d = await api._botDadosCob(env, DIA, cfg, 'diario');
  const t = api._botTextoCobranca(cfg, d);
  conf(t.indexOf('*Cobrança do dia · 03/11/2026 (terça)*') === 0, 'comeca com o titulo e a data');
  conf(t.includes('*1. Ana Paula*') && t.includes('*2. Haynan*'), 'a ordem padrao e quem trouxe mais dinheiro');
  conf(t.includes('Recebido: R$ 1.500,00 (2 pedidos)'), 'a linha do recebido mostra valor e quantidade');
  conf(t.includes('Comissão: R$ 15,00'), 'a comissao aparece quando marcada');
  conf(t.includes('Em cobrança: 3 (R$ 580,00) · Atrasados: 1'), 'a mesa e os atrasados na mesma linha');
  conf(t.includes('A receber: R$ 580,00'), 'a receber na linha de baixo');
  conf(t.includes('Meta da semana: '), 'a meta aparece pra quem tem meta');
  conf(t.includes('Ontem: 1 pedido · R$ 400,00'), 'ontem com pedido e valor');
  conf(t.includes('*Destaque do dia:* Ana Paula'), 'o destaque e de quem mais recebeu');
  conf(t.includes('*Geral*'), 'e o bloco geral fecha o resumo');
  conf(t.indexOf('—') < 0, 'sem travessao (regra do Bruno)');
  conf(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t), 'sem emoji');

  // Desmarcar some com a linha.
  const cfg2 = api._botNormaliza({ cobranca: { ativo: true, relatorio: { mostrar: { comissao: false, em_cobranca: false, atrasados: false, a_receber: false, meta: false, geral: false } } } }, cfg);
  const t2 = api._botTextoCobranca(cfg2, d);
  conf(!t2.includes('Comissão:') && !t2.includes('Em cobrança:') && !t2.includes('A receber:'), 'desmarcou, a linha some');
  conf(!t2.includes('*Geral*'), 'o geral tambem some quando desmarcado');
  conf(t2.includes('Recebido: '), 'o recebido continua: e a razao do resumo existir');

  // Rotulo trocado (o socio renomeia as linhas).
  const cfg3 = api._botNormaliza({ cobranca: { ativo: true, relatorio: { rotulos: { recebido: 'Voltou pro caixa' } } } }, cfg);
  conf(api._botTextoCobranca(cfg3, d).includes('Voltou pro caixa: '), 'o nome da linha pode ser trocado na tela');

  // Ninguem recebeu: a frase de dia parado.
  const vazio = { dia: DIA, tipo: 'diario', semana: { inicio: '2026-11-02', fim: '2026-11-08' }, geral: { recebido: 0, pedidos: 0, comissao: 0, em_cobranca: 4, em_cobranca_vl: 900, a_receber: 900, atrasados: 2, semana: 0, ontem: { pedidos: 0, recebido: 0 } }, cobradores: [{ id: 'hay', nome: 'Haynan', recebido: 0, pedidos: 0, comissao: 0, em_cobranca: 4, em_cobranca_vl: 900, a_receber: 900, atrasados: 2, semana: 0, meta: 0, faltam: 0, ontem: { pedidos: 0, recebido: 0 } }] };
  const cfg4 = api._botNormaliza({ cobranca: { ativo: true, relatorio: { sem_recebidos: ['Hoje nao voltou nada. Tem {fila} na fila.'] } } }, null);
  const t4 = api._botTextoCobranca(cfg4, vazio);
  conf(t4.includes('Hoje nao voltou nada. Tem 4 na fila.'), 'dia sem pagamento: sai a frase escolhida, com a fila de verdade');
}

// ══ 4. A AGENDA ════════════════════════════════════════════════════════════════════════
titulo('4. A agenda (e o grupo do time, que nao pode sentir nada)');
{
  const base = { ...MUNDO_NUM };
  const { api, env, cfgdb, fila } = monta(base);
  const cfg = api._botNormaliza({
    ativo: true,
    grupo: { id: '120363111111111111@g.us', nome: 'Vendedores' },
    cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us', nome: 'Cobradores' }, relatorio: { hora: '20:00' } },
  }, null);
  await api._botCobTick(env, cfg, DIA, 20 * 60 + 5);
  conf(fila.length === 1 && fila[0].jid === '120363222222222222@g.us', 'as 20:05 o resumo da cobranca entra na fila do grupo DOS COBRADORES');
  conf(fila[0].tipo === 'cob_relatorio', 'e vai registrado como cob_relatorio (nao se mistura com o do time)');
  conf(String(fila[0].texto).includes('Cobrança do dia'), 'com o texto da cobranca');
  conf(!!cfgdb['bot_cobrel_' + DIA], 'a chave de dedupe gravada e a bot_cobrel_, propria da cobranca');
  conf(!cfgdb['bot_rel_' + DIA], 'A CHAVE DO TIME NAO FOI CONSUMIDA: o resumo dos vendedores ainda vai sair no mesmo horario');
  await api._botCobTick(env, cfg, DIA, 20 * 60 + 6);
  conf(fila.length === 1, 'na batida seguinte nao repete');
}
{
  const { api, env, fila } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, relatorio: { hora: '20:00', dias: [1, 2, 4, 5] } } }, null);
  await api._botCobTick(env, cfg, DIA, 20 * 60 + 5);   // 03/11/2026 e terca (dia 2), esta na lista
  conf(fila.length === 1, 'terca esta marcada: sai');
  const { api: a2, env: e2, fila: f2 } = monta(MUNDO_NUM);
  const cfg2 = a2._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, relatorio: { hora: '20:00', dias: [3, 5] } } }, null);
  await a2._botCobTick(e2, cfg2, DIA, 20 * 60 + 5);
  conf(f2.length === 0, 'dia da semana desmarcado: nao sai');
}
{
  const { api, env, fila } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, relatorio: { hora: '20:00' } } }, null);
  await api._botCobTick(env, cfg, DIA, 15 * 60);
  conf(fila.length === 0, 'antes da hora marcada nao sai nada');
  await api._botCobTick(env, cfg, DIA, 23 * 60 + 59);
  conf(fila.length === 0, 'e passou de 3h de atraso tambem nao: fica pra amanha');
}
{
  // Hora antes das 06:00 fecha o dia ANTERIOR (quem marca 00:10 quer o dia que acabou).
  const { api } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ cobranca: { relatorio: { hora: '00:10' } } }, null);
  conf(api._botCobDiaDoResumo(cfg, DIA) === '2026-11-02', 'resumo marcado pra 00:10 cobre o dia anterior');
  const cfg2 = api._botNormaliza({ cobranca: { relatorio: { hora: '20:00' } } }, null);
  conf(api._botCobDiaDoResumo(cfg2, DIA) === DIA, 'marcado pra 20:00 cobre o dia de hoje');
}
{
  const { api, env, fila } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, relatorio: { hora: '20:00' } } }, null);   // sem grupo
  await api._botCobTick(env, cfg, DIA, 20 * 60 + 5);
  conf(fila.length === 0, 'sem grupo escolhido nao sai nada (e nao quebra)');
}
{
  const { api, env, fila } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us', diario: false }, relatorio: { hora: '20:00' } } }, null);
  await api._botCobTick(env, cfg, DIA, 20 * 60 + 5);
  conf(fila.length === 0, 'com "Resumo diário" desmarcado em Vai pro grupo, o resumo nao vai pro grupo');
}

// ══ 5. AS COMEMORACOES ═════════════════════════════════════════════════════════════════
titulo('5. As comemoracoes da cobranca');
const mundoMarcos = (n, cob) => ({
  cobradores: [{ id: 'hay', nome: 'Haynan Silva' }],
  versao: 7,
  leads: Array.from({ length: n }, (_, i) => pago({ id: 100 + i, vl: 100, pg: '2026-11-03T1' + (i % 8) + ':00:00-03:00', cob: cob || 'hay' })),
});
{
  const { api, env, fila, cfgdb } = monta(mundoMarcos(6));
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, marcos: { lista: [{ n: 5, frases: ['{nome} trouxe {n} pedidos de volta hoje, {valor}.'] }, { n: 10, frases: ['{nome} fez {n}.'] }] } } }, null);
  await api._botCobMarcosTick(env, cfg, DIA);
  conf(fila.length === 1 && fila[0].jid === '120363222222222222@g.us', 'bateu 5 pedidos recebidos: a comemoracao vai pro grupo dos cobradores');
  conf(String(fila[0].texto) === 'Haynan trouxe 5 pedidos de volta hoje, R$ 600,00.', 'a frase sai com o primeiro nome, o marco e o valor do dia');
  conf(!!cfgdb['bot_cobmarcos_' + DIA], 'o marco fica gravado em bot_cobmarcos_ (chave propria)');
  conf(!cfgdb['bot_marcos_' + DIA], 'e nao encosta na chave de marcos do time');
  // Nova batida com o blob mudado: nao repete o 5 e ainda nao chegou no 10.
  env.__nada = 1;
  await api._botCobMarcosTick(env, cfg, DIA);
  conf(fila.length === 1, 'na batida seguinte o marco de 5 nao sai de novo');
}
{
  const m = mundoMarcos(11);
  const { api, env, fila } = monta(m);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, marcos: { lista: [{ n: 5, frases: ['cinco'] }, { n: 10, frases: ['dez'] }] } } }, null);
  await api._botCobMarcosTick(env, cfg, DIA);
  conf(fila.length === 1 && String(fila[0].texto).includes('cinco') && String(fila[0].texto).includes('dez'), 'dois marcos na mesma batida saem numa mensagem so');
}
{
  const { api, env, fila, cfgdb } = monta(mundoMarcos(12));
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, marcos: { ativo: false }, metas: { semanal: { hay: 10 } }, meta_batida: { frases: ['Meta batida, {nome}: {n} pedidos.'] } } }, null);
  await api._botCobMarcosTick(env, cfg, DIA);
  conf(fila.length === 1 && String(fila[0].texto) === 'Meta batida, Haynan: 12 pedidos.', 'bateu a meta da semana: sai a frase da meta');
  conf(!!cfgdb['bot_cobmeta_2026-11-02'], 'a meta fica marcada na semana (segunda-feira)');
  await api._botCobMarcosTick(env, cfg, DIA);
  conf(fila.length === 1, 'e nao sai de novo na mesma semana');
}
{
  const { api, env, fila } = monta(mundoMarcos(9));
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, marcos: { lista: [{ n: 5, frases: ['cinco'] }] } } }, null);   // sem grupo
  await api._botCobMarcosTick(env, cfg, DIA);
  conf(fila.length === 0, 'sem grupo a comemoracao nem roda (nao ha onde comemorar)');
}

// ══ 6. O INCENTIVO ═════════════════════════════════════════════════════════════════════
titulo('6. O incentivo (horas sem ninguem pagar)');
{
  // Ultimo pagamento as 14h, agora sao 20:05: 6h sem receber.
  const mundo = { cobradores: [{ id: 'hay', nome: 'Haynan' }], leads: [pago({ id: 1, vl: 300, pg: '2026-11-03T14:00:00-03:00', cob: 'hay' }), naMesa({ id: 2, vl: 100, cob: 'hay' })] };
  const { api, env, fila, cfgdb } = monta(mundo);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, incentivo: { ativo: true, horas: 3, de: '09:00', ate: '21:00', max_dia: 2, frases: ['Faz {horas} horas sem ninguem pagar. Tem {fila} na fila.'] } } }, null);
  await api._botCobIncentivoTick(env, cfg, DIA);
  conf(fila.length === 1 && String(fila[0].texto) === 'Faz 6 horas sem ninguem pagar. Tem 1 na fila.', '6h sem pagamento: sai o incentivo com as horas e a fila certas');
  conf(fila[0].tipo === 'cob_incentivo' && fila[0].jid === '120363222222222222@g.us', 'no grupo dos cobradores, como cob_incentivo');
  await api._botCobIncentivoTick(env, cfg, DIA);
  conf(fila.length === 1, 'logo depois nao manda de novo (conta do ULTIMO incentivo)');
  conf(JSON.parse(cfgdb['bot_cobincent_' + DIA]).n === 1, 'o contador do dia subiu pra 1');
}
{
  const mundo = { cobradores: [{ id: 'hay', nome: 'Haynan' }], leads: [pago({ id: 1, vl: 300, pg: '2026-11-03T19:30:00-03:00', cob: 'hay' })] };
  const { api, env, fila } = monta(mundo);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, incentivo: { ativo: true, horas: 3, de: '09:00', ate: '21:00', frases: ['vazio'] } } }, null);
  await api._botCobIncentivoTick(env, cfg, DIA);
  conf(fila.length === 0, 'pagou ha 35 minutos: o incentivo nao sai');
}
{
  const mundo = { cobradores: [{ id: 'hay', nome: 'Haynan' }], leads: [] };
  const { api, env, fila } = monta(mundo);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, incentivo: { ativo: true, horas: 2, de: '09:00', ate: '19:00', frases: ['vazio'] } } }, null);
  await api._botCobIncentivoTick(env, cfg, DIA);
  conf(fila.length === 0, 'fora do horario (ja passou das 19h) nao sai');
}

// ══ 7. A ENTREGA E O "ENVIAR AGORA" ════════════════════════════════════════════════════
titulo('7. A entrega no grupo certo e o Enviar agora');
{
  const { api, env, fila } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ ativo: true, grupo: { id: '120363111111111111@g.us', nome: 'Vendedores' }, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us', nome: 'Cobradores' } } }, null);
  await api._botEntregarGrupo(env, cfg, 'oi time', 'livre', DIA);
  conf(fila[0].jid === '120363111111111111@g.us', 'sem dizer o grupo, a mensagem continua indo pro grupo do TIME');
  await api._botEntregarGrupo(env, cfg, 'oi cobranca', 'cob_livre', DIA, null, cfg.cobranca.grupo);
  conf(fila[1].jid === '120363222222222222@g.us' && fila[1].texto === 'oi cobranca', 'dizendo o grupo, vai pro dos cobradores');
}
{
  const { api, env, cfgdb, fila } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, relatorio: { hora: '20:00' } } }, null);
  const r = await api._botEnviarCob(env, cfg, {}, 'cob_relatorio', DIA);
  conf(r._json && r._json.ok === true && fila.length === 1, 'Enviar agora manda o resumo da cobranca na hora');
  conf(!!cfgdb['bot_cobrel_' + DIA], 'e segura o automatico de hoje (ja passou das 20:00), pra nao sair duas vezes');
  conf(!cfgdb['bot_rel_' + DIA], 'sem encostar no automatico do time');
}
{
  const { api, env } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true } }, null);
  const r = await api._botEnviarCob(env, cfg, {}, 'cob_relatorio', DIA);
  conf(r._status === 400 && /grupo dos cobradores/.test(r._json.error), 'sem grupo, o Enviar agora explica o que falta');
}
{
  const { api, env, fila } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, marcos: { lista: [{ n: 5, frases: ['{nome} fez {n}, {valor}.'] }] } } }, null);
  await api._botEnviarCob(env, cfg, { n: 5, at: 'hay' }, 'cob_marco', DIA);
  conf(fila.length === 1 && String(fila[0].texto).startsWith('Haynan fez 5,'), 'Testar frase manda a comemoracao do cobrador escolhido');
}
{
  const { api, env } = monta(MUNDO_NUM);
  const cfg = api._botNormaliza({ ativo: true, cobranca: { ativo: true, grupo: { id: '120363222222222222@g.us' }, relatorio: { hora: '20:00' } } }, null);
  conf((await api._botCobProximo(env, cfg)) === 'amanhã às 20:00', 'a tela mostra o proximo resumo da cobranca (hoje ja passou)');
  const desligado = api._botNormaliza({ ativo: true, cobranca: { ativo: false } }, null);
  conf((await api._botCobProximo(env, desligado)) === 'desligado', 'com a cobranca desligada, a tela diz desligado');
}

console.log('\n' + (falhas.length ? 'FALHOU' : 'OK') + ': ' + ok + ' de ' + (ok + falhas.length) + ' conferencias');
if (falhas.length) { for (const f of falhas) console.log('  - ' + f); process.exit(1); }
