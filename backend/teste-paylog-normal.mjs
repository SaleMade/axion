// Prova do tradutor da PAYLOG NORMAL (Webhooks v2) ANTES de publicar (14/10/2026). Mesmo jeito do
// teste-tradutor-paylog.mjs: extrai as funcoes de verdade do worker (nao uma copia).
//
//   node teste-paylog-normal.mjs [eventos-v2.json eventos-v1.json]
//
// Sem argumento roda so os casos montados aqui. Com os dois arquivos (export do D1: paylog2_debug e
// paylog_debug, formato [{results:[{body,...}]}]) roda TODO evento real e compara cada pedido que veio do
// AfterPayLog com o que o webhook do AfterPayLog disse do mesmo pedido. Os arquivos tem dado de cliente:
// ficam fora do repositorio.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const pega = (ini, fim) => {
  const i = src.indexOf(ini);
  if (i < 0) throw new Error('nao achei: ' + ini);
  const j = src.indexOf(fim, i);
  if (j < 0) throw new Error('nao achei o fim de: ' + ini);
  return src.slice(i, j + fim.length);
};
const partes = [
  pega('function _num(v)', 'isNaN(n) ? null : n; }'),
  pega('function _valorDaVenda(offer, charge)', '\n}\n'),
  pega('function _mesesDoTitulo(titulo)', '\n}\n'),
  pega('const FIVE_COL_RANK', '};'),
  pega('function _fiveColFor(p)', '\n  return null;\n}'),
  pega('const _PL_OFERTAS = {', '};'),
  pega('const _PL_PRODUTO_FIVE', '\n'),
  pega('const _PL_EVENTOS = {', '\n};'),
  pega('function _plEndereco(a)', '\n}\n'),
  pega('function _plToFive(p', '\n  return q;\n}'),
  pega('const _PL2_EVENTOS = {', '\n};'),
  pega('function _plEhV2(p, cab)', '\n}\n'),
  pega('function _plEhLegado(p)', '\n}\n'),
  pega('const _plSlugOferta', ';\n'),
  pega('function _pl2ParaPl1(p)', '\n}\n'),
];
const { _plToFive, _fiveColFor, _pl2ParaPl1, _plEhV2, _plEhLegado } = new Function(partes.join('\n') +
  '\nreturn { _plToFive, _fiveColFor, _pl2ParaPl1, _plEhV2, _plEhLegado };')();

let falhas = 0;
const ok = (cond, msg, extra) => { console.log((cond ? '  ok   ' : '  FALHA') + ' ' + msg + (extra !== undefined ? '  ' + extra : '')); if (!cond) falhas++; };
const casa = (p) => { const t = _pl2ParaPl1(p); return { t, q: t.p1 ? _plToFive(t.p1) : null }; };
const fora = (p) => { const t = _pl2ParaPl1(p); return { t, q: t.p1 ? _plToFive(t.p1, { semDePara: true }) : null }; };

// Corpo no formato da doc deles (full-schema), com o pedido de exemplo de cada caso.
const base = (ev, mexe) => {
  const p = {
    event: ev, event_label: 'x', event_timestamp: '2026-10-14T11:02:59-03:00', idempotency_key: 'k-' + ev, cancelable: false,
    order: {
      pedido_id: 175001, codigo_transacao: '175001', referencia_externa: 'ref-1', plataforma: 'Manual',
      status: { code: 4, label: 'Preparação' }, motivo_parado: null,
      customer: { nome: 'Fulano de Tal', cpf: '123.456.789-09', email: 'noreply+abc@paylog.cash', telefone: '(11) 99999-9999',
        endereco: { logradouro: 'Rua Exemplo', numero: '123', complemento: 'Casa 2', bairro: 'Centro', cidade: 'Sao Paulo', uf: 'SP', cep: '01001000', pais: 'BR' } },
      items: [{ descricao: 'Tratamento 10 Meses', quantidade: 1, valor_unitario_cents: 99700, produto: { id: 880, nome: 'GLUCOSENSE' } }],
      frete_cents: 1895,
    },
    shipment: { tracking_code: null, tracking_url: null, carrier: { code: null, name: null }, tracking_status: { code: null, label: null },
      description: null, location: null, occurred_at: null, collection_address: null,
      delivery_proof: { image_url: null, signature_url: null, received_by: null, signatory: null, delivery_lat: null, delivery_lng: null } },
    meta: { webhook_version: 2, api_version: 2 },
  };
  if (mexe) mexe(p);
  return p;
};
const comRastreio = (p) => { p.shipment.tracking_code = 'AA123456789BR'; p.shipment.tracking_url = 'https://x.rastreio.vip/rastreio/AA123456789BR'; p.shipment.carrier = { code: 'correios', name: 'Correios' }; };

console.log('=== 1) reconhece qual PayLog mandou ===');
ok(_plEhV2(base('order.created')), 'v2 pelo meta.webhook_version');
ok(_plEhV2({ event: 'shipment.delivered' }), 'v2 pelo nome do evento');
ok(_plEhV2({ foo: 1 }, { 'x-webhook-event': 'order.preparing' }), 'v2 pelo cabecalho X-Webhook-Event');
ok(!_plEhV2({ event: 'em_transito', order: { code: 'ORDKS2L1R' } }), 'AfterPayLog NAO e v2');
ok(_plEhLegado({ dados: { pedido_id: 1, cod_rastreio: 'X' } }) && !_plEhV2({ dados: {} }), 'v1 legado da PayLog normal reconhecido (e nao entra)');
ok(!_plEhLegado({ event: 'cadastrado', order: {} }), 'AfterPayLog nao e o legado');

console.log('');
console.log('=== 2) cada evento cai na coluna certa ===');
const colunas = [
  ['order.created', 'A Enviar'], ['order.blocked', 'A Enviar'], ['order.label_ready', 'Preparando'], ['order.preparing', 'Preparando'],
  ['shipment.posted', 'Enviado'], ['shipment.in_transit', 'Enviado'], ['shipment.out_for_delivery', 'Rota de Entrega'],
  ['shipment.awaiting_pickup', 'Retirada'], ['shipment.delivered', 'Cobrança'], ['shipment.returning', 'Devolvido'],
  ['shipment.returned', 'Devolvido'], ['order.canceled', 'Cancelado'], ['order.refunded', 'Cancelado'],
];
const rotulos = { 'order.created': 'Pedido Criado', 'order.blocked': 'Parado', 'order.label_ready': 'Etiqueta Pronta', 'order.preparing': 'Em Preparação',
  'shipment.posted': 'Objeto Postado', 'shipment.in_transit': 'Em Trânsito', 'shipment.out_for_delivery': 'Saiu para Entrega',
  'shipment.awaiting_pickup': 'Aguardando Retirada', 'shipment.delivered': 'Entregue', 'shipment.returning': 'Em Devolução',
  'shipment.returned': 'Devolvido', 'order.canceled': 'Cancelado', 'order.refunded': 'Estornado' };
for (const [ev, col] of colunas) {
  const { q } = fora(base(ev, (p) => { p.event_label = rotulos[ev]; if (/^shipment|label_ready/.test(ev)) comRastreio(p); }));
  ok(q && _fiveColFor(q) === col, ev + ' -> ' + col, q ? _fiveColFor(q) : 'null');
}
const bl = fora(base('order.blocked', (p) => { p.event_label = 'Parado'; p.order.motivo_parado = { id: 5, label: 'Erro fiscal' }; }));
ok(bl.q.eventStatus === 'Parado: Erro fiscal', 'motivo do Parado vai no status', bl.q.eventStatus);
const pr = fora(base('shipment.delivery_proof', (p) => { comRastreio(p); p.shipment.delivery_proof = { image_url: 'https://cdn.paylog.cash/f.webp', signature_url: 'https://cdn.paylog.cash/s.webp', received_by: null, signatory: 'familiar' }; }));
ok(pr.t.p1.event === 'proof_of_delivery' && pr.q === null, 'comprovante vai pro caminho da foto (nao move card)');
ok(pr.t.p1.delivery_proof_url === 'https://cdn.paylog.cash/f.webp' && pr.t.p1.delivery_proof_signatory === 'familiar' && pr.t.p1.delivery_proof_signature_url === 'https://cdn.paylog.cash/s.webp', 'foto, assinatura e quem recebeu');
ok(pr.t.p1.order.code === '175001', 'comprovante acha o card pelo mesmo codigo');

console.log('');
console.log('=== 3) pedido de quem vende OUTRO produto (dash do Giovane) ===');
const g = fora(base('order.created', (p) => { p.event_label = 'Pedido Criado'; }));
ok(g.q.orderId === 'PL-175001', 'codigo = pedido_id da PayLog', g.q.orderId);
ok(g.q.product.offer.title === 'Tratamento 10 Meses', 'oferta com o titulo da PayLog', g.q.product.offer.title);
ok(g.q.product.offer.price === 997, 'preco em reais, o da PayLog', g.q.product.offer.price);
ok(g.q.product.offer.id === 'PL2-tratamento-10-meses', 'codigo estavel da oferta', g.q.product.offer.id);
ok(g.q.product.name === 'GLUCOSENSE', 'produto dele, nao Glico Six', g.q.product.name);
ok(g.q.product.offer.numberOfItems === 1, 'quantidade travada em 1');
const gCasa = casa(base('order.created'));
ok(gCasa.q.product.offer.id === 'man_1790822953831', 'na casa o mesmo titulo casaria com o Glico Six 10 meses (por isso o semDePara)', gCasa.q.product.offer.id);
ok(g.q.customer.document === '12345678909' && g.q.customer.phoneNumber === '11999999999', 'CPF e telefone so digitos');
ok(g.q.customer.mail === null, 'e-mail inventado pela PayLog (noreply) nao entra');
ok(g.q.customer.address.address === 'Rua Exemplo' && g.q.customer.address.number === '123' && g.q.customer.address.zipCode === '01001000', 'endereco separado sem adivinhar', JSON.stringify(g.q.customer.address));
const sn = fora(base('order.created', (p) => { p.order.customer.endereco.numero = null; p.order.customer.endereco.logradouro = 'Travessa 7 de Setembro'; }));
ok(sn.q.customer.address.number === 'S/N' && sn.q.customer.address.address === 'Travessa 7 de Setembro', 'sem numero vira S/N e a rua com numero no nome fica inteira');
ok(!g.q.charge, 'criacao nao traz cobranca');
const can = fora(base('order.canceled'));
ok(can.q.charge && can.q.charge.status === 'CANCELED' && can.q.charge.amount === 997, 'cancelado vira cobranca CANCELED no valor do pedido');
const est = fora(base('order.refunded'));
ok(est.q.charge && est.q.charge.status === 'REFUNDED', 'estornado vira REFUNDED');
const tr = fora(base('shipment.in_transit', (p) => { comRastreio(p); p.shipment.occurred_at = '2026-10-14T10:43:27-03:00'; }));
ok(tr.q.shipping.shippingCode === 'AA123456789BR' && tr.q.__trackUrl === 'https://x.rastreio.vip/rastreio/AA123456789BR' && tr.q.shipping.platform === 'correios', 'rastreio, link e transportadora');
// a hora do evento (__eventoTs) so existe no worker a partir de 09/10/2026; o da dash do Giovane e anterior
if (src.includes('q.__eventoTs')) ok(tr.q.__eventoTs === Math.floor(Date.parse('2026-10-14T10:43:27-03:00') / 1000), 'hora do evento = a da transportadora');
const vazio = fora(base('order.created', (p) => { p.order.items = []; }));
ok(vazio.q && vazio.q.product.id === null && vazio.q.product.name === null && vazio.q.product.offer.price === null, 'pedido sem item nao inventa produto nem preco');
const demo = fora(base('order.created', (p) => { p.order.pedido_id = 999999; p.order.codigo_transacao = 'DEMO-TX-123'; p.order.referencia_externa = 'demo_ref_987'; }));
ok(demo.q === null, 'pedido de demonstracao do painel nao entra');
ok(fora(base('order.whatever')).t.p1 === null, 'evento desconhecido nao entra');

console.log('');
console.log('=== 4) pedido que veio do AfterPayLog cai no MESMO card ===');
const ap = casa(base('shipment.in_transit', (p) => { comRastreio(p); p.order.plataforma = 'AfterPay Paylog'; p.order.codigo_transacao = 'ORDAF35VJ'; p.order.items = [{ descricao: 'GlicoSix - 2 Meses (2 Frascos)', quantidade: 2, valor_unitario_cents: 29700, produto: { id: 816, nome: 'Glicosix' } }]; }));
ok(ap.t.afterpay && ap.q.orderId === 'PL-ORDAF35VJ', 'codigo ORD do AfterPayLog', ap.q.orderId);
ok(ap.q.product.offer.price === 297, 'quantidade 2 (frascos) NAO multiplica o valor', ap.q.product.offer.price);
ok(ap.q.product.offer.id === 'eeaf8612-1393-42db-a3b8-e28470ee0946', 'na casa casa com o kit de 2 meses');

// ── 5) TODO evento real que a casa recebeu, se os arquivos vierem ────────────────────
const [arqV2, arqV1] = process.argv.slice(2);
if (arqV2 && arqV1) {
  console.log('');
  console.log('=== 5) eventos reais da casa ===');
  const ler = (f) => { const s = readFileSync(f, 'utf8'); return JSON.parse(s.slice(s.indexOf('['))).flatMap((x) => x.results || []); };
  const v2 = ler(arqV2).map((r) => { try { return JSON.parse(r.body); } catch { return null; } }).filter(Boolean);
  const v1 = ler(arqV1).map((r) => { try { return JSON.parse(r.body); } catch { return null; } }).filter(Boolean);
  // O que o AfterPayLog disse de cada pedido (o evento mais completo dele: o que tem item).
  const doV1 = new Map();
  for (const p of v1) { const q = _plToFive(p); if (q && q.product && q.product.offer && q.product.offer.id) doV1.set(q.orderId, q); }
  let total = 0, traduz = 0, semColuna = 0, comparados = 0, divergiu = 0, naoAfter = 0;
  const amostra = [];
  for (const p of v2) {
    total++;
    const { t, q } = casa(p);
    if (!t.p1) continue;
    traduz++;
    if (!t.afterpay) naoAfter++;
    if (q && q.event !== 'ORDER_CREATE' && _fiveColFor(q) === null && q.event !== 'CHARGE_UPDATED') semColuna++;
    const ref = q && doV1.get(q.orderId);
    if (ref && q.product.offer.id) {
      comparados++;
      const dif = [];
      if (q.product.offer.id !== ref.product.offer.id) dif.push('kit');
      if (q.product.offer.price !== ref.product.offer.price) dif.push('preco ' + q.product.offer.price + ' x ' + ref.product.offer.price);
      if (q.customer.document !== ref.customer.document) dif.push('cpf');
      if ((q.customer.phoneNumber || '').slice(-8) !== (ref.customer.phoneNumber || '').slice(-8)) dif.push('telefone');
      if (q.customer.address.zipCode !== ref.customer.address.zipCode) dif.push('cep');
      if (dif.length) { divergiu++; if (amostra.length < 5) amostra.push(q.orderId + ': ' + dif.join(', ')); }
    }
  }
  ok(traduz === total, 'todo evento real foi traduzido', traduz + ' de ' + total);
  ok(semColuna === 0, 'nenhum evento de envio ficou sem coluna', semColuna);
  ok(comparados > 0 && divergiu === 0, 'mesmo kit, preco, CPF, telefone e CEP que o AfterPayLog disse', comparados + ' comparados, ' + divergiu + ' divergiram ' + amostra.join(' | '));
  console.log('  info  eventos de pedido que NAO veio do AfterPayLog: ' + naoAfter);
}

console.log('');
console.log(falhas ? ('FALHOU: ' + falhas + ' conferencia(s)') : 'TUDO PASSOU');
process.exit(falhas ? 1 : 0);
