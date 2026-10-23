// CONFERE O PACOTE, NAO O CODIGO (16/10/2026, incidente: o Bruno levou "SyntaxError: Invalid or
// unexpected token" em app.asar/src/main.js ao abrir o app, com o codigo no disco perfeito).
//
// `node --check` no fonte nao prova nada sobre o que foi EMPACOTADO. O que vai pra maquina do
// vendedor e o app.asar, e entre o fonte e ele existe um empacotador - que pode gravar offset
// errado, pegar o arquivo no meio de uma escrita, ou empacotar uma versao diferente da que voce
// acabou de testar.
//
// Entao esta conferencia le o asar DIRETO, sem Electron e sem biblioteca: compara byte a byte o que
// esta dentro do pacote com o que esta no disco, e roda `new vm.Script` em cada .js pra garantir
// que o que o Electron vai carregar PARSEIA. Sao 3 segundos e e a diferenca entre publicar um app
// que abre e um que nao abre.
//
// Uso:  node src/confere-pacote.cjs <caminho do app.asar>

// Le um .asar sem Electron: o formato e 4 bytes de tamanho do pickle, 4 do tamanho do header,
// 4 do tamanho da string, 4 do tamanho do JSON, o JSON, e dai os bytes dos arquivos.
const fs = require('fs')
const path = require('node:path')
const p = process.argv[2]
const b = fs.readFileSync(p)
const tamJson = b.readUInt32LE(12)
const json = JSON.parse(b.slice(16, 16 + tamJson).toString('utf8'))
const base = 16 + tamJson + ((4 - (tamJson % 4)) % 4)
function acha(no, partes) {
  let cur = no
  for (const x of partes) { cur = cur.files && cur.files[x]; if (!cur) return null }
  return cur
}
let ruim = 0
// O package.json fica de fora de proposito: o empacotador reescreve uma versao enxuta (sem
// devDependencies nem bloco de build), entao comparar com o disco acusaria falso todo dia.
const ALVOS = [
  ['src', 'main.js'], ['src', 'preload.js'], ['src', 'preload-wa.js'], ['src', 'preload-painel.js'],
  ['src', 'ui', 'app.js'], ['src', 'ui', 'painel-ui.js'], ['src', 'ui', 'agente.js'], ['src', 'ui', 'crm.js'],
  ['src', 'ui', 'index.html'], ['src', 'ui', 'painel.html'],
]
for (const alvo of ALVOS) {
  const no = acha(json, alvo)
  if (!no) { console.log(alvo.join('/'), 'NAO ESTA NO PACOTE'); ruim++; continue }
  const off = base + Number(no.offset)
  const txt = b.slice(off, off + no.size).toString('utf8')
  const disco = fs.readFileSync(path.join(...alvo), 'utf8')
  const igual = txt === disco
  if (!igual) ruim++
  // SINTAXE DO QUE ESTA DENTRO DO PACOTE. `vm.Script` parseia sem executar: e exatamente o passo
  // que estourou na maquina do Bruno, so que aqui, antes de publicar.
  let parseia = true, erro = ''
  if (alvo[alvo.length - 1].endsWith('.js')) {
    try { new (require('node:vm').Script)(txt, { filename: alvo.join('/') }) } catch (e) { parseia = false; erro = e.message; ruim++ }
  }
  console.log(
    ((igual && parseia) ? 'OK    ' : 'PROBLEMA') + '  ' + alvo.join('/') +
    '  pacote ' + no.size + 'B  disco ' + Buffer.byteLength(disco) + 'B' +
    (parseia ? '' : '  | NAO PARSEIA: ' + erro) +
    (igual || !parseia ? '' : '  | pacote comeca: ' + JSON.stringify(txt.slice(0, 48)))
  )
}
console.log('')
if (ruim) { console.log(ruim + ' problema(s) NO PACOTE. Nao publique: o app nao vai abrir.'); process.exit(1) }
console.log('o pacote bate com o disco e tudo parseia.')
