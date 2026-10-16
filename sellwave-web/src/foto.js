// TIRA FOTO das telas do app, pra conferir o visual sem precisar abrir na mao.
// Uso:  SW_FOTO=1 npx electron .     (as imagens caem em <userData>/fotos)
//
// Existe porque "ficou bom?" nao se responde lendo CSS. Sao tres fotos: a casca com a tela de
// entrar, a casca com a lista de numeros, e o painel por dentro do WhatsApp Web.

const { app, BaseWindow, WebContentsView, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const vivas = []

// Roteiro e lead de exemplo, so pra foto mostrar a tela cheia em vez do estado vazio.
const EXEMPLO = `(() => {
  roteiro = {
    mediaBase: '',
    messages: [
      { id: 'm1', label: 'Tudo ficou claro?', text: 'Tudo ficou bem claro pra voce?', grp: 'Abertura' },
      { id: 'm2', label: 'Confirma o endereco', text: 'Pode confirmar o endereco?', grp: 'Abertura' },
      { id: 'm3', label: 'Pagamento na entrega', text: 'O pagamento e na entrega.', grp: 'Fechamento' },
      { id: 'm4', label: 'Prazo de entrega', text: 'Chega em ate 5 dias uteis.', grp: 'Fechamento' }
    ],
    sequences: [
      { id: 's1', label: 'H - Etapa 1 - Abertura', items: [{},{}], grp: 'Homem' },
      { id: 's2', label: 'H - Etapa 2 - Dor', items: [{},{},{}], grp: 'Homem' },
      { id: 's3', label: 'M - Etapa 1 - Abertura', items: [{},{}], grp: 'Mulher' }
    ],
    media: []
  }
  estadoWa = { motor: true, envia: true, chatId: '5592993117635@c.us', phone: '5592993117635', nome: 'Raimunda', eu: '5515974076200' }
  document.getElementById('meu').textContent = '(15) 97407-6200'
  document.getElementById('lead').innerHTML = '<div class="nm">Raimunda Souza</div><div class="ln">Glico Six - 4 Meses · Manaus/AM</div><span class="tag">A Enviar</span>'
  document.getElementById('rod').textContent = 'pronto'
  desenha()
  return 'ok'
})()`

async function salva(view, nome, pasta) {
  try {
    const img = await view.webContents.capturePage()
    const f = path.join(pasta, nome + '.png')
    fs.writeFileSync(f, img.toPNG())
    console.log('  foto: ' + f)
    return f
  } catch (e) {
    console.error('  nao fotografou ' + nome + ': ' + ((e && e.message) || e))
    return ''
  }
}

async function rodar(ctx) {
  const pasta = path.join(app.getPath('userData'), 'fotos')
  fs.mkdirSync(pasta, { recursive: true })
  console.log('\n=== fotos do Sellwave Web ===')

  // 1) a casca como o vendedor ve ao abrir
  await salva(ctx.casca, '1-entrar', pasta)

  // 2) a casca com numeros de exemplo na barra, pra ver a lista colorida sem precisar de login
  try {
    await ctx.casca.webContents.executeJavaScript(`(() => {
      estado.temToken = true
      estado.nome = 'Guilherme'
      estado.maxAbertos = 6
      estado.numeros = [
        { numero: '(15) 97407-6200', nk: '1574076200', dono: 'Guilherme', status: 'Em Uso', cor: '#29db64', proxy: { host: 'isp.decodo.com', porta: 10001 } },
        { numero: '(19) 99598-3293', nk: '1995983293', dono: 'Guilherme', status: 'Em Uso', cor: '#29db64', proxy: { host: 'isp.decodo.com', porta: 10002 } },
        { numero: '(47) 99740-5847', nk: '4799740584', dono: 'Kevin Marques', status: 'Ativo', cor: '#4487c5', proxy: { host: 'isp.decodo.com', porta: 10003 } },
        { numero: '(54) 98108-9151', nk: '5498108915', dono: 'Kevin Marques', status: 'Restrito', cor: '#ecf755', proxy: null },
        { numero: '(71) 99275-9887', nk: '7199275988', dono: 'Murilo', status: 'Banido', cor: '#cc1919', proxy: null },
        { numero: '(82) 99121-5713', nk: '8299121571', dono: 'Murilo', status: 'Morto', cor: '#64748b', proxy: { host: 'isp.decodo.com', porta: 10004 } },
      ]
      estado.abertos = ['1574076200']
      ativo = '1574076200'
      desenhaTrava(); desenhaLista(); telaVazia()
      ativo = '1574076200'; desenhaLista()
      document.getElementById('versao').textContent = 'Guilherme'
      return 'ok'
    })()`)
    await new Promise((r) => setTimeout(r, 600))
    await salva(ctx.casca, '2-lista', pasta)
  } catch (e) { console.error('  nao montei a lista: ' + ((e && e.message) || e)) }

  // 3) o painel de venda, que agora e janela propria
  try {
    const j2 = new BaseWindow({ width: 316, height: 900, show: true })
    const v = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'preload-painel.js'), contextIsolation: true, partition: 'persist:sw-foto-painel' },
    })
    session.fromPartition('persist:sw-foto-painel').setProxy({ mode: 'direct' })
    j2.contentView.addChildView(v)
    v.setBounds({ x: 0, y: 0, width: 316, height: 900 })
    vivas.push(v, j2)
    await new Promise((ok) => {
      v.webContents.once('did-finish-load', ok)
      v.webContents.once('did-fail-load', ok)
      v.webContents.loadFile(path.join(__dirname, 'ui', 'painel.html'))
    })
    await new Promise((r) => setTimeout(r, 900))
    await v.webContents.executeJavaScript(EXEMPLO)
    await new Promise((r) => setTimeout(r, 700))
    await salva(v, '3-painel', pasta)
  } catch (e) { console.error('  nao fotografei o painel: ' + ((e && e.message) || e)) }


  console.log('\npasta: ' + pasta)
  app.exit(0)
}

module.exports = { rodar }
