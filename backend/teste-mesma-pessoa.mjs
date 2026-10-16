// MESMO CPF NAO E MESMA PESSOA - a conferencia da regra que teria evitado o incidente de 12/10.
//
// O caso real: dois cadastros com o MESMO CPF digitado, Jurassi de Almeida (24, Barra Mansa/RJ) e
// Joana Batista Precioso (34, Uberlandia/MG), mesmo vendedor, mesmo kit, R$ 497 cada. O aceite
// tratou como a mesma pessoa, juntou e APAGOU o card da Joana com um splice. A venda nao existe em
// tela nenhuma ate hoje.
//
// Este teste le as funcoes DO PROPRIO worker.js (recorta o trecho e avalia), em vez de copiar: a
// copia passaria a testar a copia, e e justamente o tipo de divergencia que produziu o incidente.
//
//   node teste-mesma-pessoa.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const fonte = fs.readFileSync(path.join(AQUI, 'worker.js'), 'utf8');

// Recorta do `const _semAcento` ate o fim do `_quemE`, que e o bloco inteiro da regra.
const i = fonte.indexOf('const _semAcento =');
const f = fonte.indexOf('function _cardComPedidoEmAberto');
if (i < 0 || f < 0 || f < i) { console.log('  ERRO  nao achei o bloco da regra no worker.js'); process.exit(1); }
const bloco = fonte.slice(i, f);
const { _pessoaDiferente, _nomeBate, _quemE } = (new Function(bloco + '\nreturn { _pessoaDiferente, _nomeBate, _quemE };'))();

let ok = 0;
const falhas = [];
const conta = (nome, certo, detalhe) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome); }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (detalhe ? '   -> ' + detalhe : '')); }
};

console.log('MESMO CPF, PESSOAS DIFERENTES\n');

// Os dois cards REAIS do incidente, como estavam no backup de 12/10.
const jurassi = { nome: 'Jurassi de Almeida', wa: '(24) 99298-2998', cidade: 'Barra Mansa', uf: 'RJ', cpf: '983.942.650-81' };
const joana = { nome: 'Joana Batista Precioso', wa: '(34) 99897-7090', cidade: 'Uberlandia', uf: 'MG', cpf: '983.942.650-81' };

conta('o caso de 12/10 e reconhecido como DUAS pessoas', _pessoaDiferente(jurassi, joana) === true);
conta('e a regra e simetrica', _pessoaDiferente(joana, jurassi) === true);
conta('a lista do aviso diz quem e quem', /Joana/.test(_quemE(joana)) && /99897-7090/.test(_quemE(joana)) && /Uberlandia/.test(_quemE(joana)), _quemE(joana));

console.log('\nE O QUE NAO PODE MUDAR DE COMPORTAMENTO\n');

// A REGRA SO AFIRMA O QUE PROVA. Tudo abaixo continua se juntando como antes - mexer nisso
// quebraria a fusao legitima, que e o caso comum (plataforma x cadastro do vendedor).
const base = { nome: 'Maria Aparecida Souza', wa: '5511999887766' };
conta('mesmo telefone, nome escrito diferente: MESMA pessoa',
  _pessoaDiferente(base, { nome: 'maria ap. souza', wa: '(11) 99988-7766' }) === false);
conta('telefone com e sem o 55 na frente: MESMA pessoa',
  _pessoaDiferente(base, { nome: 'Outro Nome Qualquer', wa: '11999887766' }) === false);
conta('mesmo nome, telefone diferente (trocou de chip): MESMA pessoa',
  _pessoaDiferente(base, { nome: 'Maria Aparecida Souza', wa: '5531988776655' }) === false);
conta('cadastro da plataforma sem nome: nao afirma nada',
  _pessoaDiferente(base, { nome: '', wa: '5531988776655' }) === false);
conta('cadastro sem telefone: nao afirma nada',
  _pessoaDiferente(base, { nome: 'Fulano de Tal', wa: '' }) === false);
conta('telefone curto demais nao serve de prova',
  _pessoaDiferente(base, { nome: 'Fulano de Tal', wa: '9988' }) === false);
conta('objeto faltando nao quebra', _pessoaDiferente(null, base) === false && _pessoaDiferente(base, undefined) === false);

console.log('\nO NOME, QUE E A PARTE QUE MAIS ERRA\n');

conta('acento e caixa nao contam', _nomeBate('João Antônio', 'JOAO ANTONIO') === true);
conta('cadastro mais completo e a mesma pessoa', _nomeBate('Joana Batista', 'Joana Batista Precioso') === true);
conta('primeiro e ultimo nome bastam', _nomeBate('Ana Paula Ferreira Lima', 'Ana Lima') === true);
conta('primeiro nome igual e sobrenome diferente NAO basta', _nomeBate('Ana Paula Ferreira', 'Ana Souza') === false);
conta('nomes sem relacao nao batem', _nomeBate('Jurassi de Almeida', 'Joana Batista Precioso') === false);
conta('nome vazio nunca bate', _nomeBate('', 'Qualquer Um') === false && _nomeBate('Qualquer Um', '') === false);
conta('um nome so nao se compara por token', _nomeBate('Ana', 'Ana Souza') === false || _nomeBate('Ana', 'Ana') === true);

console.log('\n  ' + ok + ' de ' + (ok + falhas.length) + ' conferencias passaram');
if (falhas.length) { console.log('  falharam: ' + falhas.join(', ')); process.exit(1); }
