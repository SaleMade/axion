// TESTE DO POP-UP DE ATUALIZACAO (21/10/2026).
//
// O pedido do Bruno tem duas metades, e a segunda e a dificil: o pop-up aparece na ENTRADA e NUNCA
// no meio do atendimento. "Nunca" aqui tem dois inimigos:
//   1) a checagem de 6 em 6 horas, que cai em plena tarde;
//   2) o recarregamento da casca - a vigia de tela branca recarrega a pagina sozinha, entao marcar
//      "ja mostrei" dentro da pagina nao serve de nada.
// Por isso a regra mora no processo principal. Este teste RECORTA a funcao de la e roda a regra com
// o relogio na mao, e confere no texto que a casca so abre o modal quando o main manda `entrada`.
import fs from 'node:fs';

const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const casca = fs.readFileSync(new URL('./ui/app.js', import.meta.url), 'utf8');
let ok = 0;
const falhas = [];
const conta = (nome, bom, detalhe) => {
  if (bom) { ok += 1; console.log('  ok   ' + nome); }
  else { falhas.push(nome + (detalhe ? '  ->  ' + detalhe : '')); console.log('  RUIM ' + nome + (detalhe ? '  ->  ' + detalhe : '')); }
};

// ── a regra, recortada do main.js e executada ────────────────────────────────────────────────
const ini = main.indexOf('const APP_SUBIU_EM = Date.now()');
const fim = main.indexOf('\n}\n', main.indexOf('function podeAbrirPopupVersao', ini));
if (ini < 0 || fim < 0) { console.error('NAO ACHEI a regra do pop-up no main.js'); process.exit(1); }
const trecho = main.slice(ini, fim + 3);

const monta = () => {
  const mod = trecho.replace('const APP_SUBIU_EM = Date.now()', 'const APP_SUBIU_EM = 0')
    + '\nreturn { pode: podeAbrirPopupVersao, feito: (v) => { popupVersaoFeito = v }, janela: POPUP_VERSAO_JANELA_MS };';
  return new Function(mod)();
};

{
  const r = monta();
  conta('na abertura, pode abrir', r.pode(1000) === true);
}
{
  const r = monta();
  r.feito(true);
  conta('ja apareceu nesta abertura: nao repete', r.pode(2000) === false);
}
{
  const r = monta();
  conta('passou a janela de entrada: nao abre no meio do expediente', r.pode(r.janela + 1) === false);
}
{
  const r = monta();
  conta('a checagem de 6 em 6 horas nao abre', r.pode(6 * 60 * 60 * 1000) === false);
}
{
  const r = monta();
  // Rede ruim na primeira checagem: a segunda, ainda dentro da janela, PODE abrir. Sem isto, quem
  // liga o PC sem internet perde o aviso do dia inteiro.
  conta('rede ruim na primeira: a segunda ainda abre, se for logo', r.pode(60 * 1000) === true);
}

// ── guardas de texto: o caminho entre o main e a tela ────────────────────────────────────────
conta('o main so marca `entrada` pela funcao da regra', /const entrada = podeAbrirPopupVersao\(Date\.now\(\)\)/.test(main));
conta('o main marca que ja mostrou', /if \(entrada\) popupVersaoFeito = true/.test(main));
conta('o main manda `entrada` e `notas` pra casca', /avisaCasca\('sw:versao', \{[^}]*notas:[^}]*entrada \}\)/.test(main));
conta('a casca so abre o modal com `entrada`', /if \(d && d\.entrada\) janelaVersao\(/.test(casca));
conta('existe a janelaVersao', /function janelaVersao\(nova, atual, notas\)/.test(casca));
conta('clicar fora NAO fecha o pop-up', /modal\.onclick = null/.test(casca.slice(casca.indexOf('function janelaVersao'))));
conta('e o fechar-por-fora volta quando ele sai', /const sai = \(\) => \{[\s\S]{0,200}?modal\.onclick = fechaPorFora[\s\S]{0,200}?fechaModal\(\)/.test(casca));
// Os botoes tem que ser ligados ANTES do `esconder`, que e a unica linha que pode estourar ali: com
// o fechar-por-fora desligado, um erro antes deles deixa o vendedor preso num modal sem saida.
{
  const j = casca.slice(casca.indexOf('function janelaVersao'));
  const iBotao = j.indexOf("$('ver-depois')");
  const iEsconde = j.indexOf('window.sw.esconder()');
  conta('os botoes sao ligados antes do esconder', iBotao > 0 && iEsconde > iBotao);
  conta('e o esconder esta protegido', /try \{ window\.sw\.esconder\(\) \} catch/.test(j));
}
conta('a faixinha continua existindo pras outras checagens', /const el = \$\('versao-nova'\)/.test(casca));
conta('o botao chama o instalador', /window\.sw\.abrirInstalador\(\)/.test(casca.slice(casca.indexOf('function janelaVersao'))));

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  ' + ok + '/' + ok + ' conferencias passaram.');
