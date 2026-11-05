// Preload FALSO do teste de CRIAR E ORGANIZAR (05/11/2026). Faz o papel do processo principal E do
// servidor: guarda o que o painel cria, devolve no roteiro (em cima do oficial, como o worker), e
// lembra o que foi escondido. Nao responde "ok pra tudo": recusa o que o servidor recusaria, pra a
// tela ter que mostrar o erro.
const { contextBridge } = require('electron')

const chamadas = []
const OFICIAL = {
  messages: [{ id: 'm1', label: 'Bom dia', text: 'Bom dia!', grp: 'Homem' }, { id: 'm2', label: 'Valores', text: 'Sao R$ 497', grp: 'Follow' }],
  media: [
    { id: 'a1', kind: 'audio', label: 'H - 02 Explicacao', key: 'm/ccc333.ogg', mime: 'audio/ogg', grp: 'Homem' },
    { id: 'i1', kind: 'image', label: 'Tabela 497', key: 'm/aaa111.png', mime: 'image/png', caption: '', grp: 'Homem' },
  ],
  sequences: [{ id: 's1', label: 'Boas-vindas', grp: 'Homem', items: [{ id: 'm1', sim: 3 }, { id: 'a1', sim: 3 }] }],
}
const meus = []            // { id, tipo, escopo, dados }
let ocultos = []
let seq = 0
let organiza = true
let falhaSalvar = 0
let grupos = { itens: [], funis: [] }
const RESERVADO = ['meus itens', 'meus funis', 'da equipe']
const limpaGrp = (v) => { const g = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 40); return RESERVADO.includes(g.toLowerCase()) ? '' : g }

function roteiro() {
  const sw = (x) => ({ meu: true, pode: true, escopo: x.escopo, de: '', grp: x.dados.grp || '' })
  const msgs = meus.filter((x) => x.tipo === 'text').map((x) => ({ id: x.id, label: x.dados.label, text: x.dados.text, grp: x.dados.grp || 'Meus itens', sw: sw(x) }))
  const med = meus.filter((x) => !['text', 'funil'].includes(x.tipo)).map((x) => ({ id: x.id, kind: x.tipo, label: x.dados.label, key: x.dados.key, mime: x.dados.mime, caption: x.dados.caption, grp: x.dados.grp || 'Meus itens', sw: sw(x) }))
  const seqs = meus.filter((x) => x.tipo === 'funil').map((x) => ({ id: x.id, label: x.dados.label, grp: x.dados.grp || 'Meus funis', items: x.dados.passos, sw: sw(x) }))
  return {
    ok: true,
    messages: msgs.concat(OFICIAL.messages), media: med.concat(OFICIAL.media), sequences: seqs.concat(OFICIAL.sequences),
    mediaBase: 'https://exemplo/api/salechat/media/', ocultos: ocultos.slice(), organiza,
    grupos: JSON.parse(JSON.stringify(grupos)),
  }
}

const ESTADO = {
  motor: true, autenticado: true, envia: true,
  chatId: '5519995983293@c.us', phone: '5519995983293', nome: 'Cliente de Teste',
  eu: '5515974060653', nk: '95983293', trocado: '', lid: 0, grupo: false,
}
const reg = (nome, valor) => (...args) => { chamadas.push({ nome, args }); return Promise.resolve(valor) }

contextBridge.exposeInMainWorld('swp', {
  roteiro: (forcar) => { chamadas.push({ nome: 'roteiro', args: [!!forcar] }); return Promise.resolve(roteiro()) },
  salvaItem: (dados) => {
    chamadas.push({ nome: 'salvaItem', args: [dados] })
    if (falhaSalvar > 0) { falhaSalvar -= 1; return Promise.resolve({ ok: false, erro: 'Só quem criou pode mudar esse item.' }) }
    const d = dados || {}
    if (d.id) {
      const x = meus.find((m) => m.id === d.id)
      if (!x) return Promise.resolve({ ok: false, erro: 'Esse item não existe mais.' })
      x.escopo = d.escopo === 'todos' ? 'todos' : 'eu'
      x.dados = { ...x.dados, label: d.label || x.dados.label, text: d.text, key: d.key || x.dados.key, mime: d.mime || x.dados.mime, caption: d.caption, passos: d.passos || x.dados.passos, grp: limpaGrp(d.grp) }
      return Promise.resolve({ ok: true, id: d.id })
    }
    if (d.tipo === 'text' && !String(d.text || '').trim()) return Promise.resolve({ ok: false, erro: 'Escreva a mensagem.' })
    if (!['text', 'funil'].includes(d.tipo) && !/^m\//.test(String(d.key || ''))) return Promise.resolve({ ok: false, erro: 'O arquivo não subiu. Escolha de novo.' })
    seq += 1
    const id = 'swteste' + seq
    meus.push({ id, tipo: d.tipo, escopo: d.escopo === 'todos' ? 'todos' : 'eu', dados: { label: d.label || d.tipo, text: d.text, key: d.key, mime: d.mime, caption: d.caption, passos: d.passos, grp: limpaGrp(d.grp) } })
    return Promise.resolve({ ok: true, id })
  },
  grupoOrdem: (qual, ordem) => {
    chamadas.push({ nome: 'grupoOrdem', args: [qual, ordem] })
    grupos[qual] = (ordem || []).map(String)
    return Promise.resolve({ ok: true, ordem: grupos[qual].slice() })
  },
  // Como o servidor: so renomeia grupo que tem item meu e nenhum oficial.
  grupoRenomear: (qual, de, para) => {
    chamadas.push({ nome: 'grupoRenomear', args: [qual, de, para] })
    const daAba = (x) => (qual === 'funis' ? x.tipo === 'funil' : x.tipo !== 'funil')
    const padrao = qual === 'funis' ? 'Meus funis' : 'Meus itens'
    const doGrupo = meus.filter((x) => daAba(x) && (x.dados.grp || padrao) === de)
    const oficial = qual === 'funis' ? OFICIAL.sequences : OFICIAL.messages.concat(OFICIAL.media)
    if (!doGrupo.length) return Promise.resolve({ ok: false, erro: 'Esse grupo não tem item seu.' })
    if (oficial.some((x) => x.grp === de)) return Promise.resolve({ ok: false, erro: 'Esse grupo tem item de outra pessoa.' })
    for (const x of doGrupo) x.dados.grp = limpaGrp(para)
    const nome = limpaGrp(para) || padrao
    grupos[qual] = grupos[qual].map((k) => (k === de ? nome : k))
    return Promise.resolve({ ok: true, n: doGrupo.length, grp: nome })
  },
  apagaItem: (id) => {
    chamadas.push({ nome: 'apagaItem', args: [id] })
    const i = meus.findIndex((m) => m.id === id)
    if (i >= 0) meus.splice(i, 1)
    return Promise.resolve({ ok: true })
  },
  ocultar: (id, oculto) => {
    chamadas.push({ nome: 'ocultar', args: [id, oculto] })
    ocultos = ocultos.filter((x) => x !== id)
    if (oculto) ocultos.push(id)
    return Promise.resolve({ ok: true, ocultos: ocultos.slice() })
  },
  // Os bytes viajam como Uint8Array; o teste guarda o tamanho e os 4 primeiros (OggS, PNG).
  sobeMidia: (mime, bytes) => {
    const b = bytes || new Uint8Array(0)
    const cabeca = String.fromCharCode(b[0] || 0, b[1] || 0, b[2] || 0, b[3] || 0)
    chamadas.push({ nome: 'sobeMidia', args: [mime, b.length, cabeca] })
    return Promise.resolve({ ok: true, key: 'm/novo' + (seq + 1) + '.' + (String(mime).split('/')[1] || 'bin'), mime })
  },
  lead: reg('lead', { ok: true, achou: false }),
  estado: reg('estado', ESTADO),
  manda: (nk, chatId, item) => {
    chamadas.push({ nome: 'manda', args: [nk, chatId, item] })
    return new Promise((r) => setTimeout(() => r({ ok: true }), 150))
  },
  parar: reg('parar', { ok: true }),
  disparo: reg('disparo', { ok: true }),
  disparos: reg('disparos', { ok: true, itens: [] }),
  aoMudarDisparos: () => {},
  funisFeitos: reg('funisFeitos', { ok: true, feitos: [] }),
  funilFeito: reg('funilFeito', { ok: true }),
  marcarLida: reg('marcarLida', { ok: true }),
  rascunhos: reg('rascunhos', { ok: true, rascunhos: [] }),
  rascunhoSalvar: reg('rascunhoSalvar', { ok: true, id: '1' }),
  rascunhoApagar: reg('rascunhoApagar', { ok: true }),
  tratamentos: reg('tratamentos', { ok: true, offers: [] }),
  abrirMidia: reg('abrirMidia', { ok: true }),
  aoMudarModo: () => {},
  fechar: reg('fechar', { ok: true }),
  recarregar: reg('recarregar', { ok: true }),
  esconder: reg('esconder', { ok: true }),
})
contextBridge.exposeInMainWorld('__ver', () => JSON.parse(JSON.stringify(chamadas)))
contextBridge.exposeInMainWorld('__falhaSalvar', (n) => { falhaSalvar = Number(n) || 0 })
contextBridge.exposeInMainWorld('__organiza', (v) => { organiza = !!v })
