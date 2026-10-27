// A CIFRADA QUE DEPOIS VIRA LEGIVEL (27/10/2026).
//
// O WhatsApp Web entrega como 'ciphertext', de corpo VAZIO, a mensagem que ele recebeu mas nao
// conseguiu decifrar: e a "Aguardando mensagem. Abra o WhatsApp no seu celular" que o vendedor ve na
// lista de conversas. O aparelho reenvia depois e a versao legivel chega com O MESMO msg_id - e o
// INSERT OR IGNORE do _waLogMsg jogava o texto fora. A linha ficava vazia PRA SEMPRE, mesmo o
// WhatsApp ja tendo decifrado na tela do vendedor.
//
// MEDIDO em 27/10 no (15) 97400-8709: as 7 conversas do print do Bruno sao exatamente as 7 linhas
// ciphertext gravadas entre 09:41 e 09:52, hora em que o numero levou 58 cliques pagos e TODAS as 7
// mensagens recebidas falharam a decifragem. No banco inteiro: 70 linhas assim, 43 telefones com a
// conversa vazia na dash e 12 que nunca viraram lead.
//
// Recorta o SQL e a condicao DO PROPRIO worker.js e roda contra um sqlite de verdade com o schema
// de producao. Nada e reescrito aqui: se alguem mudar a regra no worker, e a regra mudada que roda.
//   node teste-cifrada-promove.mjs
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ── RECORTE ─────────────────────────────────────────────────────────────────────────────────────
// Pega a string SQL inteira (entre aspas duplas) que contem o trecho procurado. Procurar pelo
// PEDACO e nao pela linha exata de proposito: reindentar ou renomear bind nao quebra o teste.
// Acha o trecho e abre pros lados ate as aspas duplas que delimitam a string. Andar pros lados em
// vez de casar pares de aspas no arquivo inteiro e de proposito: o worker tem 24 mil linhas cheias
// de aspas dentro de comentario, e um par torto ali desalinharia a busca inteira.
function sqlQueContem(trecho, nome) {
  const i = src.indexOf(trecho);
  if (i < 0) throw new Error('nao achei o SQL com ' + JSON.stringify(trecho) + ' (' + nome + ')');
  const ini = src.lastIndexOf('"', i);
  const fim = src.indexOf('"', i + trecho.length);
  if (ini < 0 || fim < 0) throw new Error('o SQL de ' + nome + ' nao esta entre aspas duplas');
  return src.slice(ini + 1, fim);
}
const SQL_MSG = sqlQueContem("WHERE msg_id=? AND type='ciphertext'", 'promocao da mensagem');
const SQL_CHAT = sqlQueContem("COALESCE(last_text,'')='[ciphertext]'", 'resumo da conversa');
const L_COND = (src.split('\n').find((l) => l.includes('_promoveu = false') === false && l.includes("type !== 'ciphertext'") && l.includes('_novaLinha')) || '').trim();
const L_NAOMSG = (src.match(/const _WA_NAO_MSG = new Set\(\[[\s\S]*?\]\);/) || [])[0] || '';

let ok = 0;
const falhas = [];
const conta = (nome, certo, det) => {
  if (certo) { ok += 1; console.log('  ok    ' + nome); }
  else { falhas.push(nome); console.log('  ERRO  ' + nome + (det ? '   -> ' + det : '')); }
};

conta('o worker tem o UPDATE que promove a linha cifrada', !!SQL_MSG);
conta('o worker tem o UPDATE do resumo da conversa', !!SQL_CHAT);
conta('o worker tem a condicao que decide promover', !!L_COND, L_COND.slice(0, 60));
if (!SQL_MSG || !SQL_CHAT || !L_COND || !L_NAOMSG) { console.log('\n' + ok + ' certos, ' + falhas.length + ' errados'); process.exit(1); }

// ── A CONDICAO, COM A REGRA DE VERDADE ──────────────────────────────────────────────────────────
// Monta `promove(...)` a partir da linha do worker. `_WA_NAO_MSG` vem recortado tambem.
const promove = new Function('_novaLinha', 'dir', 'type',
  L_NAOMSG + '\n' + L_COND.replace(/\{\s*$/, '{ return true; } return false;'));

console.log('\nQUANDO PROMOVER');
conta('texto legivel chegando depois da cifrada promove', promove(false, 'in', 'text') === true);
conta('audio legivel chegando depois da cifrada promove', promove(false, 'in', 'audio') === true);
conta('a propria cifrada nao promove nada', promove(false, 'in', 'ciphertext') === false);
conta('aviso de troca de chave NAO promove (apagaria o texto)', promove(false, 'in', 'e2e_notification') === false);
conta('modelo de notificacao NAO promove', promove(false, 'in', 'notification_template') === false);
conta('mensagem APAGADA nao promove', promove(false, 'in', 'revoked') === false);
conta('linha nova (nao era repetida) nao entra na promocao', promove(true, 'in', 'text') === false);
conta('saida nossa nunca promove linha de entrada', promove(false, 'out', 'text') === false);

// ── O SQL, CONTRA UM SQLITE DE VERDADE ──────────────────────────────────────────────────────────
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE wa_messages (msg_id TEXT PRIMARY KEY, phone TEXT NOT NULL, instance TEXT, direction TEXT, type TEXT, body TEXT, push_name TEXT, ts INTEGER, media_url TEXT, status TEXT, err TEXT, status_ts INTEGER, mundo TEXT)');
db.exec('CREATE TABLE wa_chats (phone TEXT PRIMARY KEY, instance TEXT, name TEXT, last_text TEXT, last_ts INTEGER, last_dir TEXT, unread INTEGER, updated_at INTEGER, crm_stage TEXT, crm_ts INTEGER)');

const poeMsg = (id, tipo, corpo, nome, midia) => db.prepare(
  'INSERT OR REPLACE INTO wa_messages (msg_id, phone, instance, direction, type, body, push_name, ts, media_url) VALUES (?,?,?,?,?,?,?,?,?)'
).run(id, '5543996170284', 'ax_atendente_vra3lh_74008709', 'in', tipo, corpo, nome, 1000, midia);
const leMsg = (id) => db.prepare('SELECT * FROM wa_messages WHERE msg_id=?').get(id);
// Roda o UPDATE do worker com os mesmos binds que ele usa, na mesma ordem.
const promoveMsg = (id, tipo, corpo, pushName, midia) =>
  db.prepare(SQL_MSG).run(tipo, corpo, pushName ?? '', midia ?? null, id).changes;

console.log('\nO QUE O UPDATE FAZ NA MENSAGEM');
{
  // O caso do print: a cifrada entrou vazia as 09:41 e o texto chegou depois.
  poeMsg('AC75C39D', 'ciphertext', '', '', null);
  const n = promoveMsg('AC75C39D', 'text', 'Olá! Gostaria de saber mais sobre o tratamento. Código k2EGu', 'Maria', null);
  const r = leMsg('AC75C39D');
  conta('a cifrada vira a mensagem legivel', n === 1 && r.type === 'text' && /Código k2EGu/.test(r.body), r.type + ' / ' + JSON.stringify(r.body).slice(0, 40));
  conta('e o nome do contato entra junto quando estava vazio', r.push_name === 'Maria', r.push_name);
}
{
  // A GARANTIA AO CONTRARIO, que e a que protege a operacao: mensagem de verdade NUNCA e
  // sobrescrita. Se o WhatsApp mandar uma cifrada atrasada com o mesmo id, o texto fica.
  poeMsg('REAL1', 'text', 'tenho interesse', 'Jose', null);
  const n = promoveMsg('REAL1', 'ciphertext', '', '', null);
  const r = leMsg('REAL1');
  conta('mensagem legivel NAO e sobrescrita por nada', n === 0 && r.body === 'tenho interesse', 'changes=' + n + ' body=' + r.body);
}
{
  poeMsg('AUD1', 'ciphertext', '', 'Ana', null);
  promoveMsg('AUD1', 'audio', '', 'Outro Nome', 'r2/audio-123.ogg');
  const r = leMsg('AUD1');
  conta('audio promovido leva a midia junto', r.type === 'audio' && r.media_url === 'r2/audio-123.ogg', r.type + ' / ' + r.media_url);
  conta('e o nome que JA existia nao e trocado', r.push_name === 'Ana', r.push_name);
}
{
  poeMsg('MID1', 'ciphertext', '', '', 'ja-no-r2.ogg');
  promoveMsg('MID1', 'audio', '', '', null);
  conta('promocao sem midia nova nao apaga a midia que ja estava la', leMsg('MID1').media_url === 'ja-no-r2.ogg', String(leMsg('MID1').media_url));
}
{
  const n = promoveMsg('NAO_EXISTE', 'text', 'oi', '', null);
  conta('id que nao existe nao cria linha nenhuma', n === 0 && !leMsg('NAO_EXISTE'), 'changes=' + n);
}

console.log('\nO QUE O UPDATE FAZ NO RESUMO DA CONVERSA');
const poeChat = (phone, texto, ts) => db.prepare(
  'INSERT OR REPLACE INTO wa_chats (phone, instance, name, last_text, last_ts, last_dir, unread, updated_at) VALUES (?,?,?,?,?,?,?,?)'
).run(phone, 'ax', '', texto, ts, 'in', 1, 0);
const leChat = (phone) => db.prepare('SELECT * FROM wa_chats WHERE phone=?').get(phone);
const promoveChat = (preview, phone, ts) => db.prepare(SQL_CHAT).run(preview, phone, ts).changes;
{
  poeChat('c1', '[ciphertext]', 1000);
  promoveChat('Olá! Gostaria de saber mais', 'c1', 1000);
  conta('o resumo sai de [ciphertext] e mostra o texto', leChat('c1').last_text === 'Olá! Gostaria de saber mais', leChat('c1').last_text);
}
{
  // DEPOIS DA CIFRADA O LEAD MANDOU OUTRA COISA: o resumo e da mensagem NOVA, nao da promovida.
  // Sem esta guarda a conversa voltaria no tempo na lista do inbox.
  poeChat('c2', 'quanto custa?', 2000);
  promoveChat('Olá! Gostaria de saber mais', 'c2', 1000);
  conta('mensagem mais nova no resumo nao volta no tempo', leChat('c2').last_text === 'quanto custa?', leChat('c2').last_text);
}
{
  poeChat('c3', 'bom dia', 1000);
  promoveChat('Olá!', 'c3', 1000);
  conta('resumo que ja era texto de verdade nao e mexido', leChat('c3').last_text === 'bom dia', leChat('c3').last_text);
}
{
  const n = promoveChat('Olá!', 'nao_existe', 1000);
  conta('conversa que nao existe nao e criada pela promocao', n === 0, 'changes=' + n);
}

console.log('\n' + ok + ' certos, ' + falhas.length + ' errados');
process.exit(falhas.length ? 1 : 0);
