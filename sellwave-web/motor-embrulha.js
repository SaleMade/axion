// EMBRULHA O MOTOR (wa-js) ANTES DE SUBIR PRO R2 (25/11/2026).
//
// O motor servido em /api/swweb/motor.js (objeto R2 salechat-media/sellwave-web/motor.js) nao roda
// na tela de entrada nova do WhatsApp (/login/). Ali nao ha app pra enganchar e o wa-js ocupa a
// pagina: o QR levava 90 a 110 s pra aparecer em 5 de 7 aberturas medidas, contra 9 a 16 s sem ele
// (mesma proxy, mesmo agente, janela Electron limpa). Embrulhado, ele espera a pagina sair do
// /login/ (o WhatsApp navega pra / depois que le o QR, e ai o preload injeta de novo no inicio do
// documento); fora do /login/ roda na hora, exatamente como antes.
//
// TODA TROCA DE VERSAO DO wa-js PASSA POR AQUI, senao o QR volta a demorar:
//   node sellwave-web/motor-embrulha.js wppconnect-wa.js motor.js
//   npx wrangler r2 object put salechat-media/sellwave-web/motor.js --file motor.js --remote
// O app so baixa o motor quando abre: quem estiver com ele aberto precisa fechar e abrir.
const fs = require('node:fs')

const [, , de, para] = process.argv
if (!de || !para) { console.error('uso: node motor-embrulha.js <wa-js baixado> <saida>'); process.exit(1) }
const orig = fs.readFileSync(de, 'utf8')
if (orig.includes('__swMotorEspera')) { console.error('esse arquivo ja esta embrulhado'); process.exit(1) }
if (orig.length < 100000 || orig.indexOf('self.WPP=') < 0) { console.error('nao parece o wa-js (' + orig.length + ' bytes)'); process.exit(1) }

const cab = '/*! sellwave 25/11/2026: na tela de entrada nova do WhatsApp (/login/) o motor so atrapalha: la nao ha app pra enganchar e ele ocupa a pagina (o QR levava 1 a 2 min pra aparecer; 10 s sem ele). Ali ele espera a pagina sair do /login/; fora dele roda na hora, como sempre. */\n'
const abre = '(function(){var naEntrada=function(){try{var p=String(location.pathname||"");return p==="/login"||p.indexOf("/login/")===0}catch(_){return false}};var rodar=function(){\n'
// Na espera: um relogio de 1 s so (a marca impede o segundo, se o app injetar de novo no did-finish-load)
// e nunca roda por cima de um WPP que ja exista.
const fecha = '\n};if(!naEntrada())return rodar();if(window.__swMotorEspera)return;window.__swMotorEspera=1;var t=setInterval(function(){if(!naEntrada()){clearInterval(t);if(typeof window.WPP==="undefined")rodar()}},1000)})();\n'

const novo = cab + abre + orig + fecha
new (require('node:vm').Script)(novo, { filename: 'motor.js' })   // sintaxe, sem executar
fs.writeFileSync(para, novo)
console.log('ok: ' + orig.length + ' -> ' + novo.length + ' bytes em ' + para)
