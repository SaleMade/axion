// TESTE DO SAQUE DO TIME DO AFILIADO (23/10/2026).
//
// A vendedora do Giovane pediu saque de R$ 3.014,84 e ele nao tinha como registrar o pagamento: a
// rota era so do diretor da casa. Agora ele processa o saque de quem e do mundo dele - e so dele.
//
// A PARTE QUE MAIS IMPORTA e a segunda: o dinheiro do afiliado NAO pode entrar no caixa da casa.
// `data.lancamentos` alimenta o Caixa, o extrato e o DRE do Bruno e nao tem recorte por mundo; se o
// saque da equipe do Giovane virasse lancamento, o lucro do Bruno cairia por um dinheiro que nunca
// saiu da conta dele.
//
// Roda o codigo DE VERDADE: recorta o handleSaqueUpdate do worker.js e executa.
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); console.log((cond ? '  ok   ' : '  RUIM ') + msg); };

const ini = src.indexOf('async function handleSaqueUpdate(req, env) {');
const fim = src.indexOf('\nasync function ', ini + 10);
if (ini < 0 || fim < 0) { console.error('NAO ACHEI o handleSaqueUpdate no worker.js'); process.exit(1); }
const fonte = src.slice(ini, fim);

const ESTADO = () => ({
  saques: [
    { id: 3, nome: 'Tháriky Moura', user_id: 'atendente_awpftn', valor: 3014.84, status: 'pendente' },
    { id: 9, nome: 'Guilherme', user_id: 'atendente_vra3lh', valor: 500, status: 'pendente' },
  ],
  payouts: [],
  lancamentos: [],
  notifs: [],
});

// de quem e cada pessoa: '' = casa
const MUNDO = { atendente_awpftn: 'afl_3d767329', atendente_vra3lh: '' };

const roda = async (user, corpo) => {
  const estado = ESTADO();
  const mod = 'const isDirector = (u) => ["diretor","socio","produtor"].includes(String(u.role||""));\n'
    + 'const isAfiliado = (u) => String(u.role||"") === "afiliado";\n'
    + 'const afiliadoSemVinculo = (u) => !u.afiliado_id;\n'
    + 'const aflDe = (u) => String(u.afiliado_id || "");\n'
    + 'const authUser = async () => globalThis.__u;\n'
    + 'const err = (m, c) => ({ __erro: true, status: c || 400, msg: m });\n'
    + 'const json = (o) => ({ __ok: true, corpo: o });\n'
    + 'const _casState = async (env, ver, st) => { globalThis.__gravado = JSON.parse(JSON.stringify(st)); return true; };\n'
    + fonte + '\nreturn handleSaqueUpdate;';
  globalThis.__u = user;
  const fn = new Function(mod)();
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...b) => ({
          first: async () => {
            if (/FROM users WHERE id/.test(sql)) return { afl: MUNDO[String(b[0])] !== undefined ? MUNDO[String(b[0])] : '' };
            return null;
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
        first: async () => (/FROM dashboard_state/.test(sql) ? { data: JSON.stringify(estado), version: 1 } : null),
        run: async () => ({ meta: { changes: 1 } }),
      }),
    },
  };
  // quem grava e o _casState (stub la em cima): ele guarda o estado final em globalThis.__gravado
  globalThis.__gravado = null;
  const r = await fn({ json: async () => corpo }, env);
  return { r, gravado: globalThis.__gravado };
};

const DIRETOR = { id: 'dir', role: 'diretor' };
const GIOVANE = { id: 'afiliado_fdmx9z', role: 'afiliado', afiliado_id: 'afl_3d767329' };
const VENDEDOR = { id: 'atendente_vra3lh', role: 'atendente' };

// ── 1. o afiliado paga o saque do time DELE ───────────────────────────────────────────────────
{
  const { r, gravado } = await roda(GIOVANE, { id: 3, status: 'pago' });
  ok(r && r.__ok, 'o afiliado consegue marcar como pago o saque da vendedora dele');
  const s = gravado && gravado.saques.find((x) => x.id === 3);
  ok(s && s.status === 'pago', 'o saque ficou pago');
  ok(gravado && gravado.payouts.length === 1, 'gerou o repasse no payouts');
  ok(gravado && gravado.payouts[0].afl === 'afl_3d767329', 'o repasse sai carimbado com o mundo dele');
  ok(gravado && gravado.lancamentos.length === 0, 'NAO lancou saida no caixa da casa (o dinheiro e dele, nao do Bruno)');
}

// ── 2. o afiliado NAO mexe em saque da casa ───────────────────────────────────────────────────
{
  const { r } = await roda(GIOVANE, { id: 9, status: 'pago' });
  ok(r && r.__erro && r.status === 403, 'saque de vendedor da casa e recusado pro afiliado (deu: ' + JSON.stringify(r) + ')');
}

// ── 3. vendedor comum nao processa saque nenhum ───────────────────────────────────────────────
{
  const { r } = await roda(VENDEDOR, { id: 9, status: 'pago' });
  ok(r && r.__erro && r.status === 403, 'vendedor nao processa saque');
}

// ── 4. o diretor continua fazendo tudo, e o saque DA CASA continua lancando no caixa ─────────
{
  const { r, gravado } = await roda(DIRETOR, { id: 9, status: 'pago' });
  ok(r && r.__ok, 'o diretor paga o saque da casa');
  ok(gravado && gravado.lancamentos.length === 1, 'saque da casa continua virando saida no caixa');
  ok(gravado && gravado.lancamentos[0].tipo === 'pagamento_equipe', 'e continua como pagamento_equipe');
}

// ── 5. o diretor tambem resolve saque de afiliado, mas sem mexer no caixa dele ────────────────
{
  const { r, gravado } = await roda(DIRETOR, { id: 3, status: 'pago' });
  ok(r && r.__ok, 'o diretor tambem pode resolver o saque do time do afiliado');
  ok(gravado && gravado.lancamentos.length === 0, 'e mesmo assim nao entra no caixa da casa');
}

// ── 6. recusar tambem funciona pro afiliado ───────────────────────────────────────────────────
{
  const { r, gravado } = await roda(GIOVANE, { id: 3, status: 'recusado' });
  ok(r && r.__ok, 'o afiliado consegue recusar');
  const s = gravado && gravado.saques.find((x) => x.id === 3);
  ok(s && s.status === 'recusado', 'o saque ficou recusado');
  ok(gravado && gravado.payouts.length === 0, 'recusar nao gera repasse');
}

console.log('');
if (falhas.length) { console.error('FALHOU:\n- ' + falhas.join('\n- ')); process.exit(1); }
console.log('  todas as conferencias passaram.');
