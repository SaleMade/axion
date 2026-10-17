// TESTE DA BUSCA DE CEP: O CODIGO DE VERDADE, DENTRO DO ELECTRON, CONTRA AS BASES DE VERDADE.
//
// POR QUE ELE EXISTE (17/10/2026). O Bruno reclamou tres vezes que o CEP do app nao puxava rua,
// bairro e cidade. O `teste-painel` cobria a tela e passava, porque la a busca e DUBLADA pelo
// preload de teste: ele responde "Rua Curitiba" sem sair da maquina. Entao o teste provava que a
// TELA faz a coisa certa com a resposta, e nunca provava que a resposta chega.
//
// E nao chegava: o `_cepBusca` do main.js usava `net.fetch`, que sai pela SESSAO PADRAO do Electron,
// e a sessao padrao deste app esta num buraco negro de proxy de proposito (main.js, `socks5://
// 127.0.0.1:1`, pra nada vazar por engano). As tres bases morriam em ERR_PROXY, as tres viravam
// `falhou`, e isso e indistinguivel de "ninguem respondeu": campo girando, nenhum erro, nenhum log.
//
// COMO ELE NAO CAI NA MESMA ARMADILHA:
//  1. RECORTA O TRECHO REAL do main.js e roda ele. Nao e uma copia do algoritmo aqui dentro - se
//     alguem trocar `fetch` por `net.fetch` de novo, este teste quebra.
//  2. BOTA A SESSAO PADRAO NO MESMO BURACO NEGRO antes de medir, que e a condicao de producao. Sem
//     isso o `net.fetch` funcionaria aqui (sessao limpa, sem proxy) e o teste daria verde no bug.
//  3. PROVA O CONTRARIO TAMBEM: confere que o `net.fetch` FALHA nessa condicao. Teste que so mostra
//     o caminho bom nao sabe dizer se o ruim era ruim mesmo.
//  4. FALA COM AS BASES DE VERDADE. CEP e servico de terceiro; dublar aqui seria repetir o erro.
//
// Como rodar:
//   MSYS_NO_PATHCONV=1 env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe src/teste-cep.js
// (ou `npm run teste-cep`)
const { app, net, session } = require('electron')
const fs = require('fs')
const path = require('path')

let ok = 0, ruim = 0
function conta(nome, bom, detalhe) {
  if (bom) { ok += 1; console.log('  ok   ' + nome) }
  else { ruim += 1; console.log('  RUIM ' + nome + (detalhe ? '  ->  ' + detalhe : '')) }
}

// ── O TRECHO REAL, RECORTADO DO main.js ────────────────────────────────────────────────────
const fonte = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const ABRE = 'const _cepCache = new Map()'
// A MARCA DE FIM E UM COMENTARIO NO main.js, nao uma linha de codigo: a primeira versao recortava
// pela linha do cache, e a primeira vez que alguem mexeu nessa linha (foi no mesmo dia, pra parar de
// guardar recusa) o teste deixou de achar o bloco. Marca que muda junto com o codigo nao e marca.
const FECHA = '// ─── fim-busca-cep ───'
const ini = fonte.indexOf(ABRE)
const fim = fonte.indexOf(FECHA)
if (ini < 0 || fim < 0) {
  console.log('NAO ACHEI O BLOCO DE CEP no main.js (as marcas mudaram). Conserte este teste.')
  process.exit(1)
}
const trecho = fonte.slice(ini, fim + FECHA.length)
// SEM COMENTARIO, pro guarda abaixo ler CODIGO. A primeira versao deste teste reprovou o proprio
// conserto: o comentario que explica o bug cita `net.fetch`, e o teste leu o comentario como codigo.
const codigo = trecho.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')

async function roda() {
  // A MESMA CONDICAO DA PRODUCAO: sessao padrao no buraco negro (main.js faz isso no arranque).
  await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1' })

  console.log('\nBUSCA DE CEP')

  // 1. A ESCOLHA DE FETCH, lida no fonte. E a linha que o Bruno sentiu tres vezes.
  conta('o _cepBusca usa o fetch do Node', /const r = await fetch\(url, \{ signal/.test(codigo),
    codigo.split('\n').filter((l) => /await .*fetch\(url/.test(l)).join(' | ') || '(nao achei a linha)')
  conta('e nao usa net.fetch, que sai pela sessao padrao', !/net\.fetch/.test(codigo),
    codigo.split('\n').filter((l) => /net\.fetch/.test(l)).join(' | '))

  // 2. O CAMINHO ERRADO ERA ERRADO MESMO: na condicao de producao, net.fetch nao sai.
  let erroNet = ''
  try {
    await net.fetch('https://brasilapi.com.br/api/cep/v2/01310100', { signal: AbortSignal.timeout(8000) })
    erroNet = '(respondeu! a sessao padrao nao esta no buraco negro)'
  } catch (e) { erroNet = String((e && e.message) || e) }
  conta('net.fetch morre no buraco negro de proxy (era o bug)',
    /PROXY|TUNNEL|SUPPORTED_PROXIES|failed/i.test(erroNet), erroNet)

  // 3. O FETCH DO NODE SAI: e por isso que a troca conserta.
  let statusNode = 0
  try {
    const r = await fetch('https://brasilapi.com.br/api/cep/v2/01310100', { signal: AbortSignal.timeout(8000) })
    statusNode = r.status
  } catch (e) { statusNode = -1; console.log('       (fetch do Node: ' + ((e && e.message) || e) + ')') }
  conta('o fetch do Node sai, mesmo com a sessao padrao bloqueada', statusNode === 200, 'status ' + statusNode)

  // ── 4. O CODIGO DE VERDADE, CONTRA AS BASES DE VERDADE ───────────────────────────────────
  // AS FONTES E O CACHE SAEM JUNTO, pra dar pra testar as DECISOES com fontes controladas sem
  // reimplementar o algoritmo aqui: o `buscaCep` que decide continua sendo o do main.js.
  const { buscaCep, _cepFontes, _cepCache } = new Function(trecho + '\nreturn { buscaCep, _cepFontes, _cepCache }')()

  // CEP CONHECIDO: Avenida Paulista. Se ESTE nao preencher, o vendedor nao preenche nenhum.
  const paulista = await buscaCep('01310100')
  conta('01310-100 acha o endereco', paulista.achou === true, JSON.stringify(paulista))
  const d = paulista.dados || {}
  conta('e vem rua, bairro, cidade e UF (o que a tela trava)',
    /Paulista/i.test(d.end || '') && !!d.bairro && /S.o Paulo/i.test(d.cidade || '') && d.uf === 'SP',
    JSON.stringify(d))

  // CEP DE OUTRO ESTADO, pra nao provar com um caso so (e e o do teste da tela).
  const sc = await buscaCep('88504411')
  conta('88504-411 acha e volta SC', sc.achou === true && (sc.dados || {}).uf === 'SC', JSON.stringify(sc))

  // PREFIXO 00 NAO EXISTE: tem que dizer "invalido", nao "nao deu pra consultar".
  const zero = await buscaCep('00000000')
  conta('00000-000 e invalido, sem nem sair da maquina', zero.invalido === true && zero.achou === false, JSON.stringify(zero))

  // MENOS DE 8 DIGITOS NAO BUSCA: era o que fazia a tela chutar estado a cada tecla.
  const curto = await buscaCep('8850')
  conta('CEP pela metade nao busca nada', curto.achou === false && curto.invalido === false, JSON.stringify(curto))

  // ── 5. OS TRES RECADOS, QUE SAO TRES SITUACOES DIFERENTES ────────────────────────────────
  // A tela tem que dizer coisas diferentes pra "este CEP nao existe", "as bases nao tem o endereco
  // deste CEP" e "nao deu pra consultar". O campo `respondeu` e o que deixa ela distinguir - sem
  // ele os dois ultimos chegavam identicos (achou: false, invalido: false) e o recado era chute.
  //
  // MEDIDO EM 17/10/2026: nenhuma das tres bases conhece CEP terminado em 000 (testei 01000-000,
  // 13000-000, 20000-000, 30000-000, 40000-000, 60000-000, 69900-000, 88000-000 - as tres dizem que
  // nao tem). Entao o CEP geral de cidade e um caso DE TODO DIA, nao uma falha de rede: a tela manda
  // digitar na mao e NAO oferece "tentar de novo", que seria mentira.
  const geral = await buscaCep('01000000')
  conta('CEP geral de cidade: as bases responderam, so nao tem o endereco',
    geral.achou === false && geral.invalido === false && geral.respondeu === true, JSON.stringify(geral))
  conta('e por isso nao pode ser chamado de CEP invalido', geral.invalido === false, JSON.stringify(geral))
  conta('CEP que acha tambem vem com respondeu', paulista.respondeu === true, JSON.stringify(paulista))
  conta('e o prefixo 00 responde sem sair da maquina', zero.respondeu === true, JSON.stringify(zero))

  // ── 6. AS DUAS REGRAS QUE DECIDEM SE UM PEDIDO PASSA OU PARA ────────────────────────────
  //
  // Daqui pra baixo as tres fontes sao trocadas por fontes de mentira, DE PROPOSITO: o que esta
  // sendo medido e a DECISAO do buscaCep (quantas fontes precisam dizer "nao existe", e o que vai
  // pro cache), e isso nao da pra provocar com as bases de verdade - elas nao ficam fora do ar na
  // hora que o teste quer. O `buscaCep` continua sendo o do main.js, recortado: so as fontes mudam.
  const originais = _cepFontes.slice()
  const poe = (...fs) => { for (let i = 0; i < _cepFontes.length; i++) _cepFontes[i] = fs[i] }
  const naoAchou = async () => ({ naoAchou: true })
  const falhou = async () => ({ falhou: true })
  const achouSP = async () => ({ end: 'Rua Teste', bairro: 'Centro', cidade: 'Sao Paulo', uf: 'SP' })
  const demora = (ms) => async () => { await new Promise((r) => setTimeout(r, ms)); return { falhou: true } }

  // UMA FONTE SO NAO CONDENA. Uma diz "nao existe" e as outras duas estao fora do ar: isso NAO e
  // CEP invalido. A regra antiga daqui ("todas as que responderam disseram que nao") barrava o
  // pedido de um cliente de verdade por causa de um 404 solto de uma base ruim.
  _cepCache.clear()
  poe(naoAchou, falhou, falhou)
  const uma = await buscaCep('12345678')
  conta('uma fonte sozinha NAO condena o CEP', uma.invalido === false, JSON.stringify(uma))

  // DUAS FONTES CONDENAM. E a regra da dash (cep.js:125): duas dizendo a mesma coisa ja e sinal.
  _cepCache.clear()
  poe(naoAchou, naoAchou, falhou)
  const duas = await buscaCep('12345678')
  conta('duas fontes dizendo que nao existe condenam', duas.invalido === true, JSON.stringify(duas))

  // E A CONDENACAO NAO FICA GUARDADA. Guardar prendia o pedido: o "tentar de novo" relia o cache e
  // devolvia na hora a MESMA recusa - o botao de tentar de novo nao tentava de novo.
  conta('e a recusa NAO entra no cache, senao o tentar de novo nao tenta', _cepCache.has('12345678') === false,
    'cache=' + [..._cepCache.keys()].join(','))
  let idas = 0
  poe(async () => { idas += 1; return { naoAchou: true } }, naoAchou, falhou)
  await buscaCep('12345678')
  await buscaCep('12345678')
  conta('o mesmo CEP recusado sai pela rede nas duas vezes', idas === 2, 'idas=' + idas)

  // O QUE DEU CERTO FICA GUARDADO, que e o ponto do cache: digitar o mesmo CEP de novo nao
  // reconsulta tres servicos de terceiro.
  _cepCache.clear()
  let idasBoas = 0
  poe(async () => { idasBoas += 1; return { end: 'Rua Teste', bairro: 'Centro', cidade: 'Sao Paulo', uf: 'SP' } }, falhou, falhou)
  await buscaCep('01311000')
  await buscaCep('01311000')
  conta('e o que deu certo e guardado, sai pela rede uma vez so', idasBoas === 1, 'idas=' + idasBoas)

  // CORRIDA: RESPOSTA COMPLETA ENCERRA. Com Promise.all, quem mandava no tempo era a fonte mais
  // lenta, e o campo girava o tempo-limite inteiro COM O ENDERECO JA NA MEMORIA.
  _cepCache.clear()
  poe(achouSP, demora(4000), demora(4000))
  const t0 = Date.now()
  const rapido = await buscaCep('01312000')
  const gastou = Date.now() - t0
  conta('resposta completa encerra a busca, sem esperar a fonte lenta',
    rapido.achou === true && gastou < 1500, 'gastou ' + gastou + 'ms')

  poe(...originais)
  console.log('\n' + ok + ' de ' + (ok + ruim) + '\n')
  app.exit(ruim ? 1 : 0)
}

app.whenReady().then(() => {
  roda().catch((e) => { console.log('ESTOUROU: ' + ((e && e.stack) || e)); app.exit(1) })
})
