// Interface do painel. Roda na PRÓPRIA janela, ao lado da página do WhatsApp.
//
// Por que não dentro da página: aí o layout do WhatsApp teria que ser empurrado por CSS (depende do
// DOM deles, que muda) e o CSS deles poderia quebrar o nosso. Aqui o painel é imune.
//
// Quem fala com o WhatsApp é o agente injetado (src/ui/agente.js). Este arquivo só pede, por IPC:
// "qual é o estado?" e "manda este item".

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let roteiro = { messages: [], sequences: [], media: [], mediaBase: '' }
let aba = 'msg'
let filtro = ''
let ocupado = false
let pararPedido = false
let ultimoFone = ''
let estadoWa = { motor: false, envia: false, chatId: '', phone: '', nome: '' }

// ───────────────────────────────────────────────────────────── lista

const porGrupo = (lista) => {
  const g = {}
  for (const x of (lista || [])) { const k = x.grp || ''; (g[k] = g[k] || []).push(x) }
  return g
}

function itensDaAba() {
  const base = aba === 'msg' ? roteiro.messages : aba === 'seq' ? roteiro.sequences : roteiro.media
  if (!filtro) return base || []
  return (base || []).filter((x) => (String(x.label || '') + ' ' + String(x.text || '') + ' ' + String(x.grp || '')).toLowerCase().includes(filtro))
}

function desenha() {
  const corpo = $('corpo')
  const itens = itensDaAba()
  if (!itens.length) {
    corpo.innerHTML = filtro
      ? '<div class="vazio">Nada com esse nome.</div>'
      : '<div class="vazio">Nada publicado aqui ainda.<br>O roteiro vem do Sale Chat, na dash.</div>'
    return
  }
  const g = porGrupo(itens)
  let html = ''
  for (const k of Object.keys(g)) {
    if (k) html += `<div class="grp">${esc(k)}</div>`
    for (const x of g[k]) {
      const ic = aba === 'seq' ? '&#9656;' : aba === 'mid' ? '&#9834;' : '&#8250;'
      const n = aba === 'seq' && Array.isArray(x.items) ? `<span class="n">${x.items.length}</span>` : ''
      html += `<button class="it" data-id="${esc(x.id)}" title="${esc(x.text || x.caption || x.label || '')}">`
        + `<span class="ic">${ic}</span><span class="tx">${esc(x.label || x.text || x.id)}</span>${n}</button>`
    }
  }
  corpo.innerHTML = html
  for (const b of corpo.querySelectorAll('.it')) b.onclick = () => disparar(b.dataset.id)
  travaBotoes(ocupado)
}

function travaBotoes(trava) {
  for (const b of document.querySelectorAll('.it')) b.disabled = trava
  $('parar').style.display = trava ? 'inline' : 'none'
}

function rodape(txt, pct) {
  $('rod').textContent = txt
  const barra = $('barra')
  barra.style.display = pct == null ? 'none' : 'block'
  if (pct != null) barra.firstChild.style.width = Math.round(pct * 100) + '%'
}

// ───────────────────────────────────────────────────────────── disparo

const achaMsg = (id) => (roteiro.messages || []).find((m) => m.id === id)
const achaMidia = (id) => (roteiro.media || []).find((m) => m.id === id)

// Monta os itens de um funil. O item da sequência aponta pro id de uma mensagem OU de uma mídia; é
// o mesmo roteiro do Sale Chat, então a resolução é igual à de lá.
function itensDoFunil(seq) {
  const saida = []
  for (const it of (seq.items || [])) {
    const m = achaMsg(it.id)
    if (m) { saida.push({ tipo: 'texto', texto: m.text || '', sim: it.sim || 0, delay: it.delay || 0 }); continue }
    const md = achaMidia(it.id)
    if (md) saida.push({ tipo: 'midia', kind: md.kind, url: roteiro.mediaBase + md.key, caption: md.caption || '', label: md.label || '', sim: it.sim || 0, delay: it.delay || 0 })
  }
  return saida
}

async function disparar(id) {
  if (ocupado) return
  if (!estadoWa.chatId) { rodape('abra uma conversa primeiro'); return }
  if (!estadoWa.envia) { rodape('o motor do WhatsApp não está pronto'); return }

  let lista = []
  if (aba === 'msg') { const m = achaMsg(id); if (m) lista = [{ tipo: 'texto', texto: m.text || '', sim: 2 }] }
  else if (aba === 'mid') { const md = achaMidia(id); if (md) lista = [{ tipo: 'midia', kind: md.kind, url: roteiro.mediaBase + md.key, caption: md.caption || '', label: md.label || '', sim: md.kind === 'audio' ? 3 : 0 }] }
  else { const s = (roteiro.sequences || []).find((x) => x.id === id); if (s) lista = itensDoFunil(s) }
  if (!lista.length) { rodape('não achei esse item no roteiro'); return }

  // TRAVA O ALVO NO CLIQUE. Se o vendedor trocar de conversa no meio do funil, o resto tem que ir
  // pra quem ele mandou, não pra quem está na tela agora.
  const alvo = estadoWa.chatId
  ocupado = true
  pararPedido = false
  travaBotoes(true)
  for (let i = 0; i < lista.length; i++) {
    if (pararPedido) { rodape('parado em ' + (i + 1) + ' de ' + lista.length); break }
    rodape(`enviando ${i + 1} de ${lista.length}`, (i + 1) / lista.length)
    const it = lista[i]
    if (it.delay) await new Promise((r) => setTimeout(r, Number(it.delay) * 1000))
    if (pararPedido) { rodape('parado em ' + (i + 1) + ' de ' + lista.length); break }
    const r = await window.swp.manda(alvo, it)
    if (!r || !r.ok) {
      rodape('falhou: ' + ((r && r.erro) || 'sem resposta'))
      ocupado = false
      travaBotoes(false)
      return
    }
  }
  ocupado = false
  travaBotoes(false)
  if (!pararPedido) rodape('enviado')
  setTimeout(() => { if (!ocupado) rodape(estadoWa.motor ? 'pronto' : 'esperando o WhatsApp') }, 2500)
}

$('parar').onclick = () => { pararPedido = true }

// ───────────────────────────────────────────────────────────── lead

const formata = (d) => {
  const x = String(d || '').replace(/^55/, '')
  if (x.length === 11) return `(${x.slice(0, 2)}) ${x.slice(2, 7)}-${x.slice(7)}`
  if (x.length === 10) return `(${x.slice(0, 2)}) ${x.slice(2, 6)}-${x.slice(6)}`
  return String(d || '')
}

async function atualizaLead() {
  const fone = estadoWa.phone
  if (!fone) {
    if (ultimoFone !== '') {
      ultimoFone = ''
      $('lead').innerHTML = '<div class="nm">Abra uma conversa</div><div class="ln">o painel segue quem está na tela</div>'
    }
    return
  }
  if (fone === ultimoFone) return
  ultimoFone = fone
  const cabecalho = esc(estadoWa.nome || formata(fone))
  $('lead').innerHTML = `<div class="nm">${cabecalho}</div><div class="ln">procurando na dash...</div>`
  const d = await window.swp.lead(fone)
  if (estadoWa.phone !== fone) return    // trocou de conversa no meio da busca
  if (!d || !d.achou) {
    $('lead').innerHTML = `<div class="nm">${cabecalho}</div><div class="ln">${esc(formata(fone))} · sem pedido na dash</div>`
    return
  }
  const linha = [d.produto, d.cidade ? `${d.cidade}/${d.uf}` : ''].filter(Boolean).join(' · ')
  $('lead').innerHTML = `<div class="nm">${esc(d.nome || cabecalho)}</div>`
    + `<div class="ln">${esc(linha || formata(fone))}</div>`
    + (d.etapa ? `<span class="tag">${esc(d.etapa)}${d.pedidos > 1 ? ' · ' + d.pedidos + ' pedidos' : ''}</span>` : '')
}

// ───────────────────────────────────────────────────────────── ciclo

async function pulso() {
  const e = await window.swp.estado()
  if (e) estadoWa = e
  $('pt').className = 'pt' + (estadoWa.motor ? '' : ' off')
  $('meu').textContent = estadoWa.eu ? formata(estadoWa.eu) : ''
  // NUMERO TROCADO: o QR deste slot foi lido por outro aparelho. Grita, porque dali pra frente a
  // dash e o app discordam do que esta acontecendo.
  const av = $('trocado')
  if (estadoWa.trocado) {
    av.textContent = 'Atenção: este slot está pareado com ' + formata(estadoWa.trocado) + '. Desconecte e leia o QR com o aparelho certo.'
    av.style.display = 'block'
  } else { av.style.display = 'none' }
  if (!ocupado) rodape(estadoWa.motor ? 'pronto' : 'esperando o WhatsApp carregar')
  await atualizaLead()
}

for (const b of document.querySelectorAll('.abas button')) {
  b.onclick = () => {
    aba = b.dataset.aba
    for (const o of document.querySelectorAll('.abas button')) o.classList.toggle('on', o === b)
    desenha()
  }
}
$('busca').oninput = (e) => { filtro = String(e.target.value || '').toLowerCase().trim(); desenha() }

window.swp.roteiro().then((r) => {
  if (r && r.ok) roteiro = { messages: r.messages || [], sequences: r.sequences || [], media: r.media || [], mediaBase: r.mediaBase || '' }
  desenha()
}).catch(() => desenha())

setInterval(pulso, 1500)
pulso()
