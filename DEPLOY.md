# 🚀 Deploy do AXION — Guia Prático

Você tem 3 caminhos. Recomendo começar pelo **Caminho 1** (você fica online hoje em 5 min) e evoluir pro 2 quando tiver demanda real.

---

## 🟢 CAMINHO 1 — MVP no ar em 5 minutos (Cloudflare Pages)

Resultado: URL pública tipo `https://axion-seu.pages.dev` rodando exatamente como o preview.

**Limitação:** os dados ficam no `localStorage` de cada navegador (não sincroniza entre dispositivos). Bom pra você usar sozinho ou pra demo.

### Passos:

1. **Crie conta na Cloudflare** (grátis): https://dash.cloudflare.com/sign-up
2. No menu lateral, clique em **Workers & Pages**
3. Clique em **Create** → aba **Pages** → **Upload assets**
4. Dê um nome ao projeto (ex: `axion`)
5. Arraste o arquivo `axion_v2.html` para a área de upload
6. **Renomeie** o arquivo para `index.html` antes de subir (Cloudflare serve `index.html` por padrão)
7. Clique **Deploy site**

✅ Pronto — em ~30 segundos você tem `https://axion.pages.dev` online.

> **Dica:** pra atualizar depois, você arrasta o novo `index.html` na mesma página e ele republica em segundos.

---

## 🔵 CAMINHO 2 — Backend real com webhooks PAYT (~1h)

Resultado: dados num banco central · webhook PAYT funcionando · multi-usuário.

### Pré-requisitos:
- Conta Cloudflare (grátis)
- Node.js instalado: https://nodejs.org
- Terminal (PowerShell no Windows)

### Passo 1 — Instalar Wrangler (CLI da Cloudflare)

```powershell
npm install -g wrangler
wrangler login
```

Vai abrir o navegador para autenticar com sua conta.

### Passo 2 — Criar banco D1 (SQLite na nuvem da Cloudflare)

```powershell
cd C:\Users\bruno\Desktop\AXION
wrangler d1 create axion-db
```

Vai imprimir um `database_id`. **Copie esse ID** e cole em [wrangler.toml](wrangler.toml) na linha `database_id = "..."`.

### Passo 3 — Aplicar o schema

```powershell
wrangler d1 execute axion-db --file=./schema.sql
```

> ⚠ O schema atual tem comandos PostgreSQL específicos. Para D1 (SQLite), preciso adaptar — me avise quando chegar aqui que eu gero o `schema.d1.sql` adaptado.

### Passo 4 — Deploy do Worker

```powershell
wrangler deploy
```

Vai te dar uma URL tipo `https://axion-webhook.SEU-USER.workers.dev`. **Anote essa URL** — é o endpoint que você vai colar na PAYT.

### Passo 5 — Configurar PAYT

No painel da PAYT:
1. Vá em **Postbacks** → **Criar Postback**
2. Cole a URL: `https://axion-webhook.SEU-USER.workers.dev/payt/SEU_TOKEN`
3. Marque **todos os 13 eventos** (Aguardando Pagamento, Finalizada, Faturada, etc.)
4. Salve

### Passo 6 — Frontend usar API em vez de localStorage

Aqui precisa de uma adaptação no `axion_v2.html` — me avise quando chegar nesse ponto que eu adapto pra fazer fetch nas rotas do worker em vez de ler/escrever no `localStorage`.

---

## 🟣 CAMINHO 3 — Pro com domínio próprio

Tudo do Caminho 2 + :

### Domínio personalizado

1. Compre um domínio (Registro.br, Hostinger, GoDaddy — ~R$50/ano)
2. No Cloudflare Dashboard → **Add a Site** → cole o domínio
3. Cloudflare te dá 2 nameservers — cole no painel onde comprou o domínio
4. Volte ao seu Pages project → **Custom domains** → **Set up custom domain** → digite `app.seudominio.com`
5. Pronto: `https://app.seudominio.com` aponta pra Dash

### Autenticação

Para limitar quem acessa (não vazar dados sensíveis):
1. Cloudflare Dashboard → **Zero Trust** → **Access** → **Applications**
2. **Add application** → **Self-hosted** → defina o domínio
3. Crie política: "apenas e-mails da minha empresa podem acessar"
4. Ao abrir a Dash, vai pedir login (Google/email/etc.)

### Backups automáticos

Adicionar cron no Worker que roda diariamente e faz dump do D1:

```toml
# em wrangler.toml
[[triggers]]
crons = ["0 3 * * *"]  # todo dia às 3h
```

E uma função no worker que copia os dados pra Cloudflare R2 (storage tipo S3).

---

## 📊 Comparação de custos

| | Caminho 1 | Caminho 2 | Caminho 3 |
|---|---|---|---|
| **Cloudflare Pages** | Grátis (até 500 builds/mês) | Grátis | Grátis |
| **Worker** | — | Grátis até 100k req/dia | Grátis até 100k req/dia |
| **D1 (banco)** | — | Grátis até 5GB | Grátis até 5GB |
| **Domínio** | — | — | ~R$50/ano |
| **Cloudflare Access** | — | — | Grátis até 50 usuários |
| **Total/mês** | **R$ 0** | **R$ 0** | **~R$ 4** (R$50/ano amortizado) |

---

## 🎯 Minha recomendação

1. **Hoje:** Caminho 1 — você está online em 5 minutos, mostra pra time, valida o produto
2. **Quando começar a ter dados reais que importam:** Caminho 2 — eu te ajudo a adaptar o frontend
3. **Quando crescer:** Caminho 3 — quando tiver mais de 1 pessoa usando

**Próximo passo prático:** quer que eu prepare o arquivo `index.html` (renomeado e com qualquer ajuste pra Cloudflare Pages), pronto pra você arrastar lá?
