// Teste do _nfCidadesVizinhas (worker.js): as grafias que a emissao tenta quando o Notazz recusa a
// cidade. Roda: node teste-nf-cidade.mjs
import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8')
const ini = src.indexOf('function _nfCidadesVizinhas(')
const fim = ini + src.slice(ini).search(/\r?\n\}\r?\n/) + 3 // o worker tem CRLF
const _nfCidadesVizinhas = new Function(src.slice(ini, fim) + '\nreturn _nfCidadesVizinhas;')()

let ok = 0, falhou = 0
const t = (nome, cond) => { if (cond) ok++; else { falhou++; console.log('FALHOU:', nome) } }
const v = (c) => _nfCidadesVizinhas(c)

t('Eldorado do Carajas tenta "dos" primeiro', v('Eldorado do Carajás')[0] === 'Eldorado dos Carajás')
t('dos -> do', v('Eldorado dos Carajás').includes('Eldorado do Carajás'))
t('das -> da', v('Santa Rita das Flores').includes('Santa Rita da Flores'))
t('da -> das', v('Conceição da Barra').includes('Conceição das Barra'))
t('nao mexe em "do" dentro de palavra (Eldorado)', v('Eldorado').length === 0)
t('nao mexe em "Domingos"', !v('São Domingos do Capim').some((x) => /Domingoss|Dosmingos/.test(x)))
t('hifen vira espaco', v('Biritiba-Mirim').includes('Biritiba Mirim'))
t('Moji -> Mogi', v('Moji Mirim').includes('Mogi Mirim'))
t('Mogi -> Moji', v('Mogi das Cruzes').includes('Moji das Cruzes'))
t('nunca devolve a propria cidade', !v('Eldorado do Carajás').includes('Eldorado do Carajás'))
t('no maximo 4 tentativas', v('Mogi-do Sul da Serra das Pedras').length <= 4)
t('cidade vazia nao gera tentativa', v('').length === 0 && v(null).length === 0)
t('cidade sem nada pra trocar nao gera tentativa', v('Fortaleza').length === 0)
t('maiuscula preservada', v('ELDORADO DO CARAJÁS')[0] === 'ELDORADO DOS CARAJÁS')

// O laco da emissao: so tenta vizinha quando o erro e de cidade
const corpoDoLaco = src.slice(src.indexOf('let j = await enviar(corpo);'), src.indexOf('let j = await enviar(corpo);') + 600)
t('emissao so tenta vizinha no erro de DESTINATION_CITY', /if \(!_nfOk\(j\) && \/DESTINATION_CITY\/i\.test\(_nfMotivo\(j\)\)\)/.test(corpoDoLaco))
t('grafia aceita fica no corpo', /corpo\.DESTINATION_CITY = cid/.test(corpoDoLaco))

console.log(`${ok} ok, ${falhou} falhou`)
process.exit(falhou ? 1 : 0)
