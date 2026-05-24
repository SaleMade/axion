# Regras do projeto AXION / Sale Made

Memória persistente entre sessões. Leia antes de qualquer edição visual.

## 🚫 NUNCA usar emojis como ícones na UI

**Regra absoluta**: a dash tem um sistema padrão de ícones SVG (Lucide-style) definido em `ICONS = {...}` no axion_v2.html. Todos os ícones visuais da interface devem usar esse sistema.

**Como usar:**
```js
${ico('user', {size: 14})}       // dentro de template literal
${ico('settings', {size: 13})}
```

**Quando estiver editando HTML estático** (fora de template literal), copia o SVG inline direto:
```html
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">...paths...</svg>
```

**Se o ícone que você precisa não existe em ICONS**, ADICIONA no objeto `ICONS` em vez de cair pra emoji.

**Exceções autorizadas** (esses lugares específicos podem manter ícones decorativos coloridos):
- Página **Design & Copy / Copies** — ícones nos selects do framework (Persona/Dor/Gancho/Ângulo/Duração) e badges de blocos do roteiro
- **DNA ativo/inativo** badge na mesma página
- **Categorias de Investimento** (modal "Gerenciar categorias") — o user escolhe o emoji pra cada categoria
- **Status WhatsApp customizados** — user define o emoji de cada status
- **Tags coloridas customizadas** — user define o ícone
- **Toasts** ocasionalmente podem ter emoji curto pra dar tom emocional (🎉 ✓ ⚠), mas evitar quando possível

**Onde a regra se aplica** (= TROCAR todo emoji por SVG):
- Sidebar (navegação)
- Headers de páginas (Visão Geral, CRM, Financeiro, etc)
- Botões primários e secundários da topbar
- Tabs de Configurações
- Cards de métrica (`.mc-ic`)
- Botões dentro das páginas
- Hints, avisos, dicas
- Modal headers
- Painel "Sobre", "Documentação", "Dados & Backup", "Notificações", "Aparência"
- Tabs/seções de qualquer página

**Justificativa do user**: emojis são coloridos, não padronizados (cada SO renderiza diferente), e quebram a identidade visual minimalista da dash.

## 🎨 Sistema de temas

6 temas configuráveis em Configurações → Aparência:
- **Dark**: Teal Sóbrio (default), Tron Legacy, Slim Green
- **Light**: Light Teal, Light Tron, Light Slim

Implementação: classe `body.theme-*` (+ `body.is-light` pros 3 light). Todas as cores vêm de CSS custom properties (`--bg`, `--bl`, `--tx` etc) — **nunca hardcode cores em elementos**, sempre usa var.

**Cuidado especial**: SVGs com cores hardcoded (ex: mapa do Brasil) não respondem aos temas. Pra elementos visuais grandes, use `currentColor` ou referencie vars CSS via JS quando o tema mudar.

## 📐 Border-radius

- `--r: 12px` (botões, inputs, badges)
- `--rl: 18px` (cards de métrica, painéis, cfg-card, info-section, kb-col)
- `--rxl: 22px` (heros, banners, modais grandes)

**Não mexer** sem motivo claro — bugs anteriores aconteceram quando essas vars foram movidas pra fora do `:root` ou hardcoded.

## 💰 Sistema de Aporte / Pago Por

Investimentos (`DB.invest`) e Gastos de tráfego (`DB.gastos`) têm campo `pago_por`:
- `'empresa'`: pago do caixa de aportes acumulado
- `<userId>`: pago do bolso por um sócio/diretor/produtor → gera **aporte automático** vinculado via `auto_source = {kind, id}`

Função `syncAutoAporteForInvest(refId, payload, kind)` gerencia a sincronização. Delete em cascata: apagar invest/gasto apaga aporte vinculado.

## 🚀 Deploy

- Git push pra `main` → Cloudflare Pages publica em ~1 min
- 2 arquivos sempre sincronizados: `axion_v2.html` (canônico) e `index.html` (copy servido pelo Cloudflare)
- `APP_VERSION` e `APP_LAST_CHANGE` no JS pra confirmação visual no Sobre

## 🧪 Preview local

`.claude/launch.json` configura `npx serve` na porta 3000 pra usar com `preview_*` MCP tools. Use pra validar mudanças visuais antes de commitar.
