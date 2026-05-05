# Setup do Backend AXION (Worker + D1)

Comandos a rodar **na pasta `backend/`**.

## 1. Login na Cloudflare (1ª vez)

```powershell
npx wrangler login
```

Abre o navegador, autoriza. Depois disso o Wrangler já está autenticado.

## 2. Criar o banco D1

```powershell
npx wrangler d1 create axion
```

Vai imprimir algo como:

```toml
[[d1_databases]]
binding = "DB"
database_name = "axion"
database_id = "abc123-def456-..."
```

**Copia o `database_id`** e cola em `wrangler.toml` (substitui `REPLACE-ME`).

## 3. Aplicar o schema

```powershell
npx wrangler d1 execute axion --remote --file=./schema.sql
```

Cria as 3 tabelas (`users`, `sessions`, `dashboard_state`) no D1 da Cloudflare.

## 4. Criar o primeiro usuário (Diretor)

Calcular hash SHA-256 da senha:

```powershell
# Substituir SENHAFORTE pela senha que você quer
$senha = "SENHAFORTE"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($senha)
$hash  = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace("-","").ToLower()
echo "Hash: $hash"
```

Anota o hash. Insere o usuário:

```powershell
# Substituir HASH_AQUI pelo hash que você anotou
npx wrangler d1 execute axion --remote --command "INSERT INTO users (id, login, pwd_hash, name, abbr, role, color, bg, com_pct) VALUES ('dir', 'diretor', 'HASH_AQUI', 'Diretor', 'DIR', 'diretor', '#3b82f6', 'rgba(59,130,246,.15)', 0)"
```

## 5. Deploy do Worker

```powershell
npx wrangler deploy
```

Vai imprimir a URL pública, tipo:

```
https://axion-api.SEU-USUARIO.workers.dev
```

**Anota essa URL.** Cola ela na Dashboard (configurações → Integrações → API Backend) ou
no campo `API_URL` no início do `index.html`.

## 6. Verificar

```powershell
# health check
curl https://axion-api.SEU-USUARIO.workers.dev/

# tentativa de login
curl -X POST https://axion-api.SEU-USUARIO.workers.dev/auth/login `
  -H "content-type: application/json" `
  -d '{"login":"diretor","password":"SENHAFORTE"}'
```

Deve retornar `{"token":"...", "user":{...}}`.

## Próximos usuários

A partir daqui, novos usuários são adicionados pela própria Dashboard (Configurações →
Gerenciar Equipe → + Adicionar membro). O Worker cria/atualiza no D1.

## Troubleshooting

- **`Error: not authenticated`**: rode `npx wrangler login` de novo.
- **`Error: D1_ERROR: no such table`**: você esqueceu de rodar o `wrangler d1 execute --file=schema.sql`.
- **Erro de CORS no browser**: o Worker já tem `Access-Control-Allow-Origin: *`. Se mesmo assim der CORS, confere se a URL `API_URL` no frontend está correta (com `https://` e sem barra final).
