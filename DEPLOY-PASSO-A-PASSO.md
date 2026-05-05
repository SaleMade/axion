# 🚀 Deploy AXION na Cloudflare — Passo a passo

Tempo total: **~10 minutos**. Custo: **R$ 0**.

---

## ✅ Pré-requisito: arquivo pronto

Já está feito — você tem o `index.html` (cópia do `axion_v2.html` com o nome que a Cloudflare espera).

---

## PARTE 1 — Subir a Dash (5 min)

### 1. Entrar na Cloudflare

Acesse: **https://dash.cloudflare.com**

Faça login na sua conta.

### 2. Ir para Workers & Pages

No menu lateral esquerdo, clique em **"Workers & Pages"**.

### 3. Criar projeto Pages

Clique no botão azul **"Create"** no canto superior direito.

Vai aparecer 2 opções: **Workers** e **Pages**. Clique na aba **"Pages"**.

Vai aparecer 2 opções: **"Connect to Git"** e **"Direct Upload"**.

Clique em **"Direct Upload"** → botão **"Get started"**.

### 4. Nomear o projeto

- **Project name:** `axion` (ou outro nome curto, sem espaços)
- **Production branch:** deixa `main` mesmo
- Clique **"Create project"**

### 5. Fazer upload

Vai aparecer uma área grande tracejada escrito **"Drag and drop your files"**.

**Arraste o arquivo `index.html`** (que está em `C:\Users\bruno\Desktop\AXION\index.html`) **para essa área**.

> ⚠ Arraste **só o `index.html`**, não a pasta inteira. Senão vai subir os outros arquivos do projeto também.

Aguarde alguns segundos. Vai aparecer "1 file uploaded ✓".

### 6. Deploy

Clique **"Deploy site"**.

Em ~30 segundos vai aparecer:

```
✅ Success! Your project is live at:
https://axion.pages.dev   (ou axion-XXX.pages.dev)
```

**Clique no link** — sua Dash está no ar. 🎉

Pode testar em qualquer dispositivo, mostrar pra time, etc.

---

## PARTE 2 — Conectar seu domínio próprio (5 min)

Vou supor que seu domínio é `seudominio.com` e você quer a Dash em `app.seudominio.com`.

### 1. Adicionar domínio à Cloudflare (se ainda não está)

Se o domínio **já está na Cloudflare** (você gerencia DNS por lá), **pule** pro passo 2.

Se ainda não:
1. Cloudflare Dashboard → menu lateral → **"Websites"** → **"Add a site"**
2. Digite seu domínio (ex: `seudominio.com`) → **Continue**
3. Escolha o plano **Free** → Continue
4. Cloudflare vai te dar **2 nameservers** (ex: `dani.ns.cloudflare.com`)
5. Vá no painel onde você comprou o domínio (Registro.br, Hostinger, GoDaddy...)
6. Procure **"DNS"** ou **"Nameservers"** ou **"Servidores DNS"**
7. **Substitua** os nameservers atuais pelos 2 da Cloudflare
8. **Salve**. Pode levar de 5 minutos a 24h pra propagar (geralmente é rápido)
9. Volte na Cloudflare → **"Check nameservers"** — quando aparecer ✅ Active, prossegue

### 2. Conectar o domínio à Dash

1. Cloudflare Dashboard → **Workers & Pages** → clique no projeto **`axion`**
2. Aba **"Custom domains"** (no topo, junto com Deployments, Settings, etc.)
3. Clique **"Set up a custom domain"**
4. Digite: `app.seudominio.com` (ou só `seudominio.com` se for o domínio raiz)
5. Cloudflare detecta automaticamente que o domínio está na sua conta e cria o registro DNS
6. Clique **"Activate domain"**
7. Aguarde 1-2 minutos. Vai virar **"Active"** ✅

### 3. Testar

Abra `https://app.seudominio.com` no navegador.

Sua Dash AXION está rodando no SEU domínio, com HTTPS automático (cadeado verde), CDN global da Cloudflare.

---

## PARTE 3 — Atualizar a Dash depois (1 min)

Toda vez que eu fizer melhorias e gerar um novo `index.html`, você atualiza assim:

1. Cloudflare Dashboard → **Workers & Pages** → projeto `axion`
2. Aba **"Deployments"** → botão **"Create deployment"**
3. Arraste o novo `index.html`
4. **Deploy**

Em ~30 segundos a versão nova fica online.

> 💡 **Dica:** o Cloudflare guarda o histórico de deploys. Se algo der errado, você consegue voltar pra versão anterior em 1 clique.

---

## 🔒 Bônus opcional: travar acesso só pra você

Se quiser que **só você** (ou só sua equipe) consiga abrir a Dash:

1. Cloudflare Dashboard → **Zero Trust** (no menu lateral)
2. **Access** → **Applications** → **Add an application** → **Self-hosted**
3. Application name: `AXION`
4. Application domain: `app.seudominio.com`
5. **Next** → criar política:
   - Policy name: `Equipe AXION`
   - Action: **Allow**
   - Include → **Emails** → digite os emails autorizados (`seu@email.com`, `parceiro@email.com`)
6. **Add application**

Pronto — quando alguém abrir `app.seudominio.com`, vai pedir login (Google/email). Se não estiver na lista, bloqueia.

Grátis até 50 usuários.

---

## 📋 Checklist final

- [ ] Conta Cloudflare criada
- [ ] Projeto Pages criado com nome `axion`
- [ ] `index.html` upload feito
- [ ] URL `axion.pages.dev` funcionando
- [ ] Domínio próprio adicionado à Cloudflare (DNS apontado)
- [ ] Custom domain configurado no projeto Pages
- [ ] `https://app.seudominio.com` abre a Dash
- [ ] (Opcional) Cloudflare Access configurado

---

## ⚠ Limitação atual deste deploy

Por enquanto, a Dash funciona **100% no navegador** — todos os dados ficam no `localStorage`. Significa:

- ✅ Você usar sozinho do mesmo computador → tudo perfeito
- ✅ Mostrar pra time/clientes → cada um vê o demo, mas com seus próprios dados
- ❌ **Webhook PAYT real ainda não funciona** — precisa do backend
- ❌ Você logar em outro dispositivo → não vê os mesmos dados

**Quando precisar resolver isso** (backend real + webhook PAYT funcionando + multi-dispositivo), me avisa que eu te ajudo no Caminho 2 do [DEPLOY.md](DEPLOY.md):
- Cria banco D1 na Cloudflare
- Adapta o `schema.sql` pra SQLite
- Deploy do `worker.js`
- Adapto o frontend pra usar a API em vez de `localStorage`
- Configura o webhook na PAYT

Tempo estimado dessa segunda fase: ~1h. Continua tudo grátis.

---

## 🆘 Se travar em algum passo

Me manda print do erro ou da tela onde você travou. Os pontos que costumam ter dúvida:

1. **"Onde fica Workers & Pages no menu?"** — Cloudflare reorganiza UI às vezes. Se não achar, use a busca da própria dashboard digitando "Pages".
2. **"Nameservers não propagam"** — espera mais 30 min. Pra checar: https://dnschecker.org → digita seu domínio.
3. **"Custom domain travou em Pending"** — confirma que o domínio aparece na lista de **Websites** da Cloudflare como **Active**.
4. **"Subi o arquivo errado"** — em **Deployments** clica nos 3 pontinhos do deploy errado → **Rollback** ou **Delete**.
