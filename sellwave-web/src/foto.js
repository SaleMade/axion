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
  clearInterval(window.__swPulso)   // congela: senao o pulso apaga o exemplo e a foto sai vazia
  roteiro = {
    mediaBase: '',
    messages: [
      { id: 'm1', label: 'Tudo ficou claro?', text: 'Tudo ficou bem claro pra voce? Ficou alguma duvida?', grp: 'Geral' },
      { id: 'm2', label: 'Confirma o endereco', text: 'Pode confirmar o endereco pra mim?', grp: 'Geral' },
      { id: 'm3', label: 'Pagamento na entrega', text: 'O pagamento e na entrega, em dinheiro ou cartao.', grp: 'Fechamento' },
      { id: 'm4', label: 'Prazo de entrega', text: 'Chega em ate 5 dias uteis.', grp: 'Fechamento' }
    ],
    sequences: [
      { id: 's1', label: 'H - Etapa 1 - Abertura', items: [{id:'m1',sim:4,delay:0},{id:'f1',delay:3}], grp: 'Homem' },
      { id: 's2', label: 'H - Etapa 2 - Dor', items: [{id:'f2',delay:0},{id:'m3',delay:2},{id:'f3',delay:4}], grp: 'Homem' },
      { id: 's3', label: 'M - Etapa 1 - Abertura', items: [{id:'m2',delay:0},{id:'f1',delay:3}], grp: 'Mulher' }
    ],
    media: [
      { id: 'f1', kind: 'audio', label: 'H - 01 Abertura', key: 'x', grp: 'Homem' },
      { id: 'f2', kind: 'audio', label: 'H - 02 Explicacao', key: 'x', grp: 'Homem' },
      { id: 'f3', kind: 'image', label: 'Foto do produto', key: 'x', grp: 'Homem' },
      { id: 'f4', kind: 'document', label: 'Bula em PDF', key: 'x', grp: 'Geral' }
    ]
  }
  estadoWa = { motor: true, autenticado: true, envia: true, chatId: '5592993117635@c.us', phone: '5592993117635', nome: 'Raimunda', eu: '5515974076200' }
  document.getElementById('meu').textContent = '(15) 97407-6200'
  document.getElementById('lead').innerHTML = '<div class="nm">Raimunda Souza</div><div class="ln">Glico Six - 4 Meses · Manaus/AM</div><span class="tag">A Enviar</span>'
  document.getElementById('pt').className = 'pt'   // pareado: quem pinta e o pulso, que a foto congelou
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

  // 2) a casca com numeros de exemplo na barra, pra ver a lista colorida sem precisar de login.
  //
  // DUAS FOTOS, e as duas importam: a direcao ve cadeado de proxy e a trava no topo, o vendedor NAO
  // pode ver nada disso. Sem a foto do vendedor eu so olhava a tela que EU abro, que e justamente a
  // que ele nunca vai ver. A regra e do Bruno: "para meus vendedores nao quero que nem apareca nada
  // de proxy".
  const monta = (direcao) => `(() => {
      estado.temToken = true
      estado.nome = 'Guilherme'
      estado.maxAbertos = 6
      estado.direcao = ${direcao ? 'true' : 'false'}
      estado.numeros = [
        { numero: '(15) 97407-6200', nk: '1574076200', at: 'a1', dono: 'Guilherme', status: 'Em Uso', cor: '#29db64', roleta: true,  lim_dia: 70, leads_hoje: 23, proxy: { host: 'isp.decodo.com', porta: 10001 } },
        { numero: '(19) 99598-3293', nk: '1995983293', at: 'a1', dono: 'Guilherme', status: 'Em Uso', cor: '#29db64', roleta: true,  lim_dia: 70, leads_hoje: 41, proxy: { host: 'isp.decodo.com', porta: 10002 } },
        { numero: '(47) 99740-5847', nk: '4799740584', at: 'a2', dono: 'Kevin Marques', status: 'Ativo', cor: '#4487c5', roleta: true,  lim_dia: 50, leads_hoje: 8,  proxy: { host: 'isp.decodo.com', porta: 10003 } },
        { numero: '(54) 98108-9151', nk: '5498108915', at: 'a2', dono: 'Kevin Marques', status: 'Restrito', cor: '#ecf755', roleta: false, lim_dia: 30, leads_hoje: 30, proxy: null },
        { numero: '(71) 99275-9887', nk: '7199275988', at: 'a3', dono: 'Murilo', status: 'Banido', cor: '#cc1919', roleta: false, lim_dia: 0,  leads_hoje: 0,  proxy: null },
        { numero: '(82) 99121-5713', nk: '8299121571', at: 'a3', dono: 'Murilo', status: 'Em Uso', cor: '#29db64', roleta: true,  lim_dia: 70, leads_hoje: 12, proxy: { host: 'isp.decodo.com', porta: 10004 } },
      ]
      estado.abertos = ['1574076200']
      ativo = '1574076200'
      desenhaTrava(); desenhaLista(); telaVazia()
      ativo = '1574076200'; desenhaLista()
      document.getElementById('versao').textContent = 'Guilherme'
      return 'ok'
    })()`

  try {
    await ctx.casca.webContents.executeJavaScript(monta(true))
    await new Promise((r) => setTimeout(r, 600))
    await salva(ctx.casca, '2-lista-direcao', pasta)

    await ctx.casca.webContents.executeJavaScript(monta(false))
    await new Promise((r) => setTimeout(r, 400))
    await salva(ctx.casca, '3-lista-vendedor', pasta)

    // os Ajustes do VENDEDOR: tem que sobrar so o que e da maquina dele
    await ctx.casca.webContents.executeJavaScript('janelaAjustes(); "ok"')
    await new Promise((r) => setTimeout(r, 400))
    await salva(ctx.casca, '4-ajustes-vendedor', pasta)
    await ctx.casca.webContents.executeJavaScript('fechaModal(); "ok"')

    // e os da direcao, com as duas travas
    await ctx.casca.webContents.executeJavaScript(monta(true))
    await ctx.casca.webContents.executeJavaScript('janelaAjustes(); "ok"')
    await new Promise((r) => setTimeout(r, 400))
    await salva(ctx.casca, '5-ajustes-direcao', pasta)
    await ctx.casca.webContents.executeJavaScript('fechaModal(); "ok"')
  } catch (e) { console.error('  nao montei a lista: ' + ((e && e.message) || e)) }

  // 3) o painel de venda, que agora e janela propria
  try {
    // PRECISA ESTAR VISIVEL. capturePage com show:false devolve UnknownVizError e, fora da area da
    // tela, "Current display surface not available for capture": o Windows so entrega pixel do que
    // esta sendo desenhado de verdade. Por isso o MODO FOTO pisca janela, e so ele: o autoteste
    // (SW_SMOKE) roda sem janela nenhuma. Nao rode o modo foto com alguem usando o computador.
    const j2 = new BaseWindow({ width: 316, height: 900, show: true, skipTaskbar: true })
    const v = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'preload-painel.js'), contextIsolation: true, partition: 'persist:sw-foto-painel' },
    })
    session.fromPartition('persist:sw-foto-painel').setProxy({ mode: 'direct' })
    j2.contentView.addChildView(v)
    v.setBounds({ x: 0, y: 0, width: 316, height: 900 })
    vivas.push(v, j2)
    // UM CALLBACK POR EVENTO, e com guarda. Registrar a MESMA funcao em dois `once` faz o Electron
    // estourar "One-time callback was called more than once" quando os dois eventos acontecem.
    await new Promise((ok) => {
      let pronto = false
      const fim = () => { if (!pronto) { pronto = true; ok() } }
      v.webContents.once('did-finish-load', () => fim())
      v.webContents.once('did-fail-load', () => fim())
      setTimeout(fim, 30000)
      v.webContents.loadFile(path.join(__dirname, 'ui', 'painel.html'))
    })
    await new Promise((r) => setTimeout(r, 900))
    await v.webContents.executeJavaScript(EXEMPLO)
    await new Promise((r) => setTimeout(r, 700))
    await salva(v, '6-painel', pasta)

    // 7) a aba FUNIS com a previa de um funil aberta: e onde se ve a pausa de cada passo, que e
    //    justamente o numero que estava errado (somava espera + digitando).
    await v.webContents.executeJavaScript("aba='funis'; aberto='funil:s1'; for (const b of document.querySelectorAll('.aba')) b.classList.toggle('on', b.dataset.aba==='funis'); desenha(); 'ok'")
    await new Promise((r) => setTimeout(r, 500))
    await salva(v, '7-painel-funis', pasta)
  } catch (e) { console.error('  nao fotografei o painel: ' + ((e && e.message) || e)) }


  console.log('\npasta: ' + pasta)
  app.exit(0)
}

module.exports = { rodar }
