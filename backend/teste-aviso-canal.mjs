// TESTE DO CANAL E DO TEXTO DOS AVISOS (23/10/2026).
//
// O Bruno recebeu dois avisos de numero parado com o SOM DE VENDA e disse: "nunca sei se e uma venda
// ou se e uma notificacao de algum problema". O som e do CANAL do Android e canal e imutavel depois
// de criado, entao a unica saida e mandar problema por outro canal. E pediu tambem texto curto:
// "numero tal nao esta recebendo mensagens, vou desligar ele da roleta".
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const nativo = fs.readFileSync(new URL('../../axion-produtor/src/lib/nativo.js', import.meta.url), 'utf8');
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg); };

// ── a escolha do canal, recortada e executada ─────────────────────────────────────────────────
const linha = (src.match(/const _fcmCanal = [^\n]+/) || [])[0];
if (!linha) { console.error('NAO ACHEI o _fcmCanal no worker.js'); process.exit(1); }
const raw = (src.match(/const _FCM_RAW = [^\n]+/) || [])[0];
const canal = new Function(raw + '\n' + linha + '\nreturn _fcmCanal;')();

ok(canal('', false, true) === 'avisos', 'problema vai pro canal de aviso (som do sistema)');
ok(canal('caixa', false, true) === 'avisos', 'problema ignora o toque de venda escolhido pela pessoa');
ok(canal('caixa', false, false) === 'vendas_venda', 'venda continua no canal do toque escolhido');
ok(canal('som2', false, false) === 'vendas_venda_2', 'o segundo toque de venda continua valendo');
ok(canal('caixa', true, true) === 'vendas_mudo', 'quem desligou o som nao toca nem no aviso');
ok(canal('caixa', true, false) === 'vendas_mudo', 'e nem na venda');

ok(/const canal = _fcmCanal\(insc\.toque, !!payload\.silent, !!payload\.aviso\)/.test(src),
  'o envio passa a marca de aviso pra escolha do canal');

// ── os dois alarmes mandam marcado como aviso, e com texto curto ─────────────────────────────
const bloco = (nome) => {
  const i = src.indexOf('async function ' + nome + '(env) {');
  const f = src.indexOf('\nasync function ', i + 10);
  return src.slice(i, f > 0 ? f : src.length);
};
for (const nome of ['_alarmeNumeroMudo', '_alarmeCapturaParada']) {
  const b = bloco(nome);
  ok(/aviso: true/.test(b), nome + ' manda marcado como aviso');
  const corpos = [...b.matchAll(/body: ([^\n]+)/g)].map((m) => m[1]);
  ok(corpos.length > 0, nome + ' tem corpo de mensagem');
}

// O QUE O AVISO PRECISA DIZER, nao as palavras exatas. O texto foi reescrito depois (a versao de
// agora separa "fechado no SellWave Web" de "nao esta marcando os leads" e diz ha quanto tempo, o
// que e melhor que o meu original). A guarda fica no sentido: qual numero, que ele saiu da roleta e
// o que fazer - era tudo isso que o paragrafo antigo enterrava.
const bNum = bloco('_alarmeNumeroMudo');
ok(/const titulo = /.test(bNum), 'o aviso monta um titulo proprio');
ok(/fim \+/.test(bNum) || /\+ fim/.test(bNum), 'e o titulo carrega o NUMERO');
ok(/fora da roleta|saiu da roleta/.test(bNum), 'o corpo diz que o numero saiu da roleta');
ok(/SellWave Web/.test(bNum), 'e diz o que fazer: mexer no SellWave Web');

// ── o app cria o canal de aviso SEM som proprio ──────────────────────────────────────────────
const i = nativo.indexOf("id: 'avisos'");
ok(i > 0, 'o app cria o canal de avisos');
if (i > 0) {
  const trecho = nativo.slice(i - 200, i + 420);
  ok(!/sound:/.test(trecho.slice(trecho.indexOf("id: 'avisos'"))), 'o canal de avisos NAO define som (usa o do sistema)');
  ok(/importance: 5/.test(trecho), 'o aviso aparece por cima da tela, como o de venda');
}

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  todas as conferencias passaram.');
