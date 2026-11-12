// TESTE DO "O COBRADOR ESTA LIVRE?" (12/11/2026): o agente de verdade, numa pagina de verdade.
//
// Pedido do Bruno: a mensagem automatica da cobranca so sai "quando o meu cobrador nao estiver em
// ligacao, quando ele nao estiver respondendo a ninguem, quando estiver tudo tranquilo". Quem sabe
// disso e a pagina do WhatsApp de cada numero (`window.__swOcupado` no ui/agente.js). Aqui cada sinal
// e provocado do jeito que acontece na vida: tecla e clique de verdade (sendInputEvent, nao evento
// fabricado), microfone de verdade (o de mentira do Chromium), mensagem chegando pelo evento do motor,
// som tocando num <audio>. O que e dublado e so o WhatsApp.
//
// Uso:  env -u ELECTRON_RUN_AS_NODE npx electron src/teste-ocupado.js
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let ok = 0, ruim = 0
function conta(nome, bom, detalhe) {
  if (bom) { ok += 1; console.log('  ok   ' + nome) }
  else { ruim += 1; console.log('  RUIM ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
const AGENTE = fs.readFileSync(path.join(__dirname, 'ui', 'agente.js'), 'utf8')
const PAG = path.join(os.tmpdir(), 'sw-teste-ocupado-' + process.pid + '.html')
fs.writeFileSync(PAG, '<meta charset="utf-8"><body style="margin:0"><div style="width:400px;height:3000px">ocupado</div></body>')

const WPP_FALSO = `
  var ouvintes = {}
  window.__mandados = []
  window.WPP = {
    on: function (ev, fn) { (ouvintes[ev] = ouvintes[ev] || []).push(fn) },
    off: function (ev, fn) { ouvintes[ev] = (ouvintes[ev] || []).filter(function (f) { return f !== fn }) },
    conn: { isAuthenticated: function () { return true } },
    whatsapp: {
      ContactStore: { get: function () { return null } },
      lidPnCache: { getPhoneNumber: function () { return null } },
      UserPrefs: { getMaybeMeUser: function () { return { user: '5515974060653', _serialized: '5515974060653@c.us' } } },
    },
    chat: {
      get: function () { return null },
      list: async function () { return [] },
      getMessages: async function () { return [] },
      markIsComposing: async function () { return true },
      sendTextMessage: async function (id, t) { window.__mandados.push(t); return { id: 'X' } },
    },
    contact: { get: async function () { return null } },
  }
  window.__dispara = function (msg) { (ouvintes['chat.new_message'] || []).forEach(function (f) { f(msg) }) }
  window.__evento = function (ev) { (ouvintes[ev] || []).forEach(function (f) { f({}) }) }
  'ok'
`
const agoraS = () => Math.floor(Date.now() / 1000)
let seq = 0
const msg = (extra) => Object.assign({
  id: { id: 'OC' + (++seq), _serialized: 'true_5511999998888@c.us_OC' + seq, fromMe: true },
  from: '5515974060653@c.us', to: '5511999998888@c.us', fromMe: true, t: agoraS(), type: 'chat', body: 'oi',
}, extra || {})

let j = null
const js = (c) => j.webContents.executeJavaScript(c, false)
// Pagina nova, agente novo. `comMotor` espera o agente ligar os eventos do WhatsApp (ele liga a cada 2 s).
async function nova(comMotor) {
  const velha = j
  j = new BrowserWindow({ show: false, width: 500, height: 400, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  if (velha) { try { velha.destroy() } catch (_) { /* ok */ } }
  await j.loadFile(PAG)
  await js(WPP_FALSO)
  await js(AGENTE)
  if (comMotor) await espera(2400)
}
const oc = async () => JSON.parse(await js('JSON.stringify(window.__swOcupado())'))
// O relogio da pagina anda `ms` pra frente (o que ja foi carimbado fica onde estava).
const adianta = (ms) => js('(function () { var r = Date.now; var d = ' + Number(ms) + '; Date.now = function () { return r() + d } })(); "ok"')

async function rodar() {
  console.log('\nPAGINA PARADA')
  await nova(false)
  let o = await oc()
  conta('ninguem mexendo, nada tocando: livre', o.ocupado === false && o.motivo === '', JSON.stringify(o))
  conta('o agente expoe a pergunta pro app', (await js('typeof window.__swOcupado')) === 'function')

  console.log('\nMAO NO WHATSAPP')
  await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); "ok"')
  o = await oc()
  conta('evento fabricado por script (nao e a mao de ninguem) nao conta', o.ocupado === false, JSON.stringify(o))
  j.webContents.focus()
  j.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
  j.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' })
  await espera(300)
  o = await oc()
  conta('tecla de verdade nesta pagina: ocupado, "mexendo no WhatsApp"', o.ocupado === true && o.motivo === 'mexendo no WhatsApp', JSON.stringify(o))
  await adianta(60000)
  conta('60 s depois ainda segura (a calma e de 90 s)', (await oc()).ocupado === true)
  await adianta(31000)
  conta('91 s sem mexer: livre de novo', (await oc()).ocupado === false, JSON.stringify(await oc()))
  await nova(false)
  j.webContents.focus()
  j.webContents.sendInputEvent({ type: 'mouseDown', x: 50, y: 50, button: 'left', clickCount: 1 })
  j.webContents.sendInputEvent({ type: 'mouseUp', x: 50, y: 50, button: 'left', clickCount: 1 })
  await espera(300)
  o = await oc()
  conta('clique de verdade tambem conta', o.ocupado === true && o.motivo === 'mexendo no WhatsApp', JSON.stringify(o))
  await nova(false)
  j.webContents.focus()
  // duas voltas da rodinha: a primeira depois de a pagina abrir o Chromium costuma engolir
  for (let i = 0; i < 2; i++) { j.webContents.sendInputEvent({ type: 'mouseWheel', x: 50, y: 50, deltaX: 0, deltaY: -120, canScroll: true }); await espera(350) }
  conta('rolar a conversa tambem conta', (await oc()).ocupado === true, JSON.stringify(await oc()))

  console.log('\nMICROFONE (ligacao em andamento ou audio sendo gravado)')
  await nova(false)
  const temMic = await js('!!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)')
  conta('a pagina de teste tem microfone (senao este bloco nao prova nada)', temMic === true)
  const abriu = await js('navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) { window.__mic = s; return s.getAudioTracks().length }, function (e) { return "erro: " + e })')
  conta('o microfone abre pelo caminho de sempre (o agente nao quebra o getUserMedia)', abriu === 1, String(abriu))
  o = await oc()
  conta('microfone aberto: ocupado, "em ligação ou gravando áudio"', o.ocupado === true && o.motivo === 'em ligação ou gravando áudio', JSON.stringify(o))
  await adianta(40 * 60000)
  conta('ligacao de 40 min continua segurando (microfone nao vence em 90 s)', (await oc()).ocupado === true)
  await js('window.__mic.getTracks().forEach(function (t) { t.stop() }); "ok"')
  conta('desligou (o WhatsApp soltou o microfone): livre', (await oc()).ocupado === false, JSON.stringify(await oc()))
  await nova(false)
  await js('navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) { window.__mic = s; return 1 })')
  await adianta(121 * 60000)
  conta('microfone esquecido aberto ha mais de 2 h deixa de segurar (nao trava a automatica pra sempre)', (await oc()).ocupado === false, JSON.stringify(await oc()))
  await nova(false)
  await js('navigator.mediaDevices.getUserMedia({ video: true }).then(function (s) { window.__cam = s; return 1 }, function () { return 0 })')
  conta('so camera, sem microfone, nao e ligacao de voz', (await oc()).ocupado === false, JSON.stringify(await oc()))

  console.log('\nELE RESPONDEU ALGUEM')
  await nova(true)
  await js('window.__dispara(' + JSON.stringify(msg({ fromMe: false, id: { id: 'IN1', _serialized: 'false_5511999998888@c.us_IN1', fromMe: false }, from: '5511999998888@c.us', to: '5515974060653@c.us' })) + '); "ok"')
  conta('mensagem do CLIENTE chegando nao e o cobrador ocupado', (await oc()).ocupado === false, JSON.stringify(await oc()))
  await js('window.__dispara(' + JSON.stringify(msg({ t: agoraS() - 3600 })) + '); "ok"')
  conta('mensagem nossa de uma hora atras (o WhatsApp sincronizando) nao conta', (await oc()).ocupado === false, JSON.stringify(await oc()))
  await js('window.__dispara(' + JSON.stringify(msg({ __swVia: 'varredura' })) + '); "ok"')
  conta('mensagem nossa relida pela varredura nao conta', (await oc()).ocupado === false, JSON.stringify(await oc()))
  await js('window.__dispara(' + JSON.stringify(msg({ type: 'e2e_notification', body: '' })) + '); "ok"')
  conta('aviso de protocolo nao conta', (await oc()).ocupado === false, JSON.stringify(await oc()))
  await js('window.__dispara(' + JSON.stringify(msg()) + '); "ok"')
  o = await oc()
  conta('mensagem nossa de agora (daqui ou do celular): ocupado, "respondendo um cliente"', o.ocupado === true && o.motivo === 'respondendo um cliente', JSON.stringify(o))
  const cd = JSON.parse(await js('window.__swChatDe("5511999998888", "").then(JSON.stringify)'))
  conta('e a conferencia da conversa recusa sozinha (vale pro app que ainda nao pergunta)', cd.ok === false && cd.ocupado === true && /cobrador ocupado: respondendo um cliente/.test(cd.erro), JSON.stringify(cd))
  await adianta(91000)
  const cd2 = JSON.parse(await js('window.__swChatDe("5511999998888", "").then(JSON.stringify)'))
  conta('passada a calma, a conferencia volta a responder normal', cd2.ok === true && cd2.achou === false && !cd2.ocupado, JSON.stringify(cd2))

  console.log('\nO QUE O APP MANDA NAO E "o cobrador respondendo"')
  await nova(true)
  const m1 = await js('window.__swManda("5511999998888@c.us", { tipo: "texto", texto: "Boa tarde", auto: true, espera: 0 }).then(function (r) { return r }, function (e) { return "erro: " + e })')
  conta('a mensagem automatica sai pelo envio de sempre', m1 === true && (await js('window.__mandados.length')) === 1, String(m1))
  await js('window.__dispara(' + JSON.stringify(msg({ body: 'Boa tarde' })) + '); "ok"')
  conta('e a volta dela pela captura nao vira "ocupado" (senao uma automatica seguraria a proxima)', (await oc()).ocupado === false, JSON.stringify(await oc()))
  await adianta(11000)
  await js('window.__dispara(' + JSON.stringify(msg({ t: agoraS() + 11 })) + '); "ok"')
  conta('mas mensagem nossa DEPOIS disso e ele respondendo', (await oc()).motivo === 'respondendo um cliente', JSON.stringify(await oc()))
  await nova(true)
  await js('window.__swManda("5511999998888@c.us", { tipo: "texto", texto: "do painel", espera: 0 }).then(function (r) { return r }, function (e) { return "erro: " + e })')
  o = await oc()
  conta('item que ELE disparou pelo painel (funil, mensagem pronta): ocupado, "mandando pelo painel"', o.ocupado === true && o.motivo === 'mandando pelo painel', JSON.stringify(o))

  console.log('\nLIGACAO')
  await nova(true)
  await js('window.__evento("call.incoming_call"); "ok"')
  o = await oc()
  conta('ligacao tocando: ocupado, "em ligação"', o.ocupado === true && o.motivo === 'em ligação', JSON.stringify(o))
  await nova(true)
  await js('window.__dispara(' + JSON.stringify(msg({ type: 'call_log', body: '', t: agoraS() - 900, callDuration: 880, callOutcome: 'Connected' })) + '); "ok"')
  o = await oc()
  conta('ligacao de 15 min que acabou agora (feita no celular, o registro chega no fim): ocupado', o.ocupado === true && o.motivo === 'em ligação', JSON.stringify(o))
  await nova(true)
  await js('window.__dispara(' + JSON.stringify(msg({ type: 'call_log', body: '', t: agoraS() - 5 * 3600, callDuration: 60 })) + '); "ok"')
  conta('registro de ligacao de horas atras (historico) nao conta', (await oc()).ocupado === false, JSON.stringify(await oc()))

  console.log('\nOUVINDO O CLIENTE')
  const SOM = `(function (seg, mudo) {
    var taxa = 8000, n = taxa * seg, b = new ArrayBuffer(44 + n), v = new DataView(b)
    var txt = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    txt(0, 'RIFF'); v.setUint32(4, 36 + n, true); txt(8, 'WAVE'); txt(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
    v.setUint32(24, taxa, true); v.setUint32(28, taxa, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); txt(36, 'data'); v.setUint32(40, n, true)
    for (var k = 0; k < n; k++) v.setUint8(44 + k, 128)
    var a = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' })))
    a.muted = !!mudo
    window.__som = a
    return new Promise(function (ok) { a.addEventListener('loadedmetadata', function () { a.play().then(function () { setTimeout(function () { ok(a.currentTime > 0 ? 'tocou' : 'parado') }, 900) }, function (e) { ok('erro: ' + e) }) }) })
  })`
  await nova(false)
  let tocou = await j.webContents.executeJavaScript(SOM + '(6, false)', true)
  o = await oc()
  conta('audio de 6 s tocando com som: ocupado, "ouvindo um áudio"', tocou === 'tocou' && o.ocupado === true && o.motivo === 'ouvindo um áudio', tocou + ' ' + JSON.stringify(o))
  await nova(false)
  tocou = await j.webContents.executeJavaScript(SOM + '(2, false)', true)
  conta('som curto (o plim de mensagem) nao conta', tocou === 'tocou' && (await oc()).ocupado === false, tocou + ' ' + JSON.stringify(await oc()))
  await nova(false)
  tocou = await j.webContents.executeJavaScript(SOM + '(6, true)', true)
  conta('som mudo (video sem som na conversa) nao conta', tocou === 'tocou' && (await oc()).ocupado === false, tocou + ' ' + JSON.stringify(await oc()))

  console.log('\n' + ok + ' certos, ' + ruim + ' errados')
  try { fs.unlinkSync(PAG) } catch (_) { /* ok */ }
  app.exit(ruim ? 1 : 0)
}

app.on('window-all-closed', () => { /* a janela e trocada a cada cenario; o teste sai sozinho no fim */ })
app.whenReady().then(() => {
  rodar().catch((e) => { console.log('ESTOUROU: ' + ((e && e.stack) || e)); try { fs.unlinkSync(PAG) } catch (_) { /* ok */ } app.exit(1) })
})
