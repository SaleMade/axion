# Sale Chat - lancador do modo APP (WhatsApp da Windows Store / WebView2)
# Suporta os dois apps: WhatsApp normal e WhatsApp Beta (cada um e um pacote separado).
#   1) liga a porta de debug do WebView2 em modo PORTA-LIVRE (cada app WebView2 pega a SUA
#      porta; ninguem briga com Lenovo Vantage / Widgets / novo Outlook / etc.)
#   2) DESCOBRE em qual porta o WhatsApp abriu o debug (pelo processo dele) e usa essa
#   3) injeta o painel dentro do app e fica vigiando (reinjeta se reiniciar)
param(
  [ValidateSet('normal','beta')][string]$Mode = 'normal',
  [int]$Port = 0
)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Label = if ($Mode -eq 'beta') { 'WhatsApp Beta' } else { 'WhatsApp' }
$ScVersion = 'v4 (auto-atualiza)'   # aparece no console pra confirmar que e a versao nova
Write-Host "==================================================="
Write-Host "  Sale Chat  -  $ScVersion  -  $Label"
Write-Host "==================================================="

# Acha o app certo no Menu Iniciar (normal = sem "Beta"; beta = com "Beta")
$all = Get-StartApps | Where-Object { $_.Name -match 'WhatsApp' }
if ($Mode -eq 'beta') { $app = $all | Where-Object { $_.Name -match 'Beta' } | Select-Object -First 1 }
else { $app = $all | Where-Object { $_.Name -notmatch 'Beta' } | Select-Object -First 1 }
if (-not $app) {
  Write-Host "Nao achei o app '$Label' no Menu Iniciar. Instale pela Microsoft Store."
  Write-Host "Apps WhatsApp encontrados:"; $all | ForEach-Object { Write-Host " - $($_.Name)" }
  pause; exit 1
}
# Identificadores do app: pfn = familia (Name_Hash); pkgName = so o Name (distingue
# normal x beta e aparece no caminho de TODOS os processos do app: host + WebView).
$pfn = ($app.AppID -split '!')[0]
$pkgName = ($pfn -split '_')[0]

# Porta de debug do WebView2. Usamos "0" = porta livre automatica: assim CADA app WebView2
# (WhatsApp, Lenovo Vantage, Widgets, novo Outlook...) pega uma porta PROPRIA e ninguem briga
# pela mesma porta. Depois a gente DESCOBRE qual foi a porta do WhatsApp (pelo processo dele).
function Set-DebugPort { [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '--remote-debugging-port=0', 'User') }
# MESMA opcao, porem pela POLITICA do WebView2 no registro. Diferenca que resolve o "reinicie o PC":
# a variavel de ambiente e um retrato herdado no NASCIMENTO do processo, e app da Store nao nasce do
# Explorer (nasce pelo DcomLaunch, que sobe no boot) — por isso so pega depois de reiniciar. Ja a
# politica e lida PELO PROPRIO app na hora de criar o WebView2, entao vale JA no proximo start do
# WhatsApp. O ramo Policies e admin-only (mesmo em HKCU) -> precisa rodar como Administrador 1x.
function Set-DebugPolicy {
  $ok = $false
  foreach ($root in @('HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments',
                      'HKCU:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments')) {
    try {
      if (-not (Test-Path $root)) { New-Item -Path $root -Force -ErrorAction Stop | Out-Null }
      # Grava os 3 nomes possiveis: o AUMID do app, o exe host e o curinga (a resolucao e em cascata).
      foreach ($id in @($app.AppID, 'WhatsApp.Root.exe', '*')) {
        if ($id) { New-ItemProperty -Path $root -Name $id -Value '--remote-debugging-port=0' -PropertyType String -Force -ErrorAction Stop | Out-Null }
      }
      $ok = $true
    } catch { }
  }
  return $ok
}
# Fecha o app POR COMPLETO (host + WebViews), pra o restart nao ficar na tela de erro (cacto).
function Close-App {
  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        ($_.CommandLine -and $_.CommandLine -match [regex]::Escape($pkgName)) -or
        ($_.ExecutablePath -and $_.ExecutablePath -match [regex]::Escape($pkgName))
      } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
}
function Open-App { Start-Process ("shell:AppsFolder\" + $app.AppID) }

# ── Descobrir a porta de debug DO WHATSAPP (seja ela qual for) ─────────────────
# Em vez de forcar uma porta fixa e brigar com outros apps, a gente acha a porta que o
# proprio WhatsApp abriu: olha os processos msedgewebview2 do PACOTE do WhatsApp e ve qual
# porta TCP eles estao escutando. Assim, se o Lenovo Vantage (ou outro app WebView2) estiver
# usando outra porta, tanto faz — cada um fica no seu canto.
# Um endpoint CDP responde em /json/version com um campo "Browser".
function Test-CdpPort([int]$p) {
  try { $v = Invoke-RestMethod ("http://127.0.0.1:$p/json/version") -TimeoutSec 2; return [bool]$v.Browser } catch { return $false }
}
# Essa porta ja mostra uma pagina web.whatsapp.com?
function Port-HasWhatsApp([int]$p) {
  try { $t = Invoke-RestMethod ("http://127.0.0.1:$p/json") -TimeoutSec 2; return [bool]($t | Where-Object { $_.type -eq 'page' -and $_.url -match 'web\.whatsapp\.com' }) } catch { return $false }
}
# Acha a porta LISTEN aberta pelos processos msedgewebview2 do PACOTE do WhatsApp (0 = nao achou).
function Find-WhatsAppPort {
  $ports = @()
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($pkgName)) }
    foreach ($pr in $procs) {
      $conns = Get-NetTCPConnection -State Listen -OwningProcess $pr.ProcessId -ErrorAction SilentlyContinue
      foreach ($c in $conns) { if ($c.LocalAddress -match '^(127\.0\.0\.1|::1)$') { $ports += [int]$c.LocalPort } }
    }
  } catch {}
  $ports = @($ports | Select-Object -Unique)
  foreach ($p in $ports) { if (Port-HasWhatsApp $p) { return $p } }   # prioriza a que ja tem WhatsApp
  foreach ($p in $ports) { if (Test-CdpPort $p)     { return $p } }   # senao, a que responde CDP
  return 0
}
# Descobre a porta com um "grace period" (varias tentativas) pra NAO reagir a um blip
# transitorio (ex: reload momentaneo) e acabar reiniciando um WhatsApp que estava OK.
function Discover-Port {
  for ($g = 0; $g -lt 4; $g++) { $p = Find-WhatsAppPort; if ($p -gt 0) { return $p }; Start-Sleep -Milliseconds 700 }
  return 0
}
# O WhatsApp JA abriu com a flag de debug? Deteccao DIRETA e definitiva: a variavel de ambiente
# vira '--remote-debugging-port' na linha de comando do WebView2. Se o app esta rodando e a flag
# NAO esta la, e porque ele nao herdou a variavel -> so um LOGIN NOVO resolve (app da Store so
# recebe variavel de usuario nova num login novo). Retorna $true/$false, ou $null se indeterminado.
# SO o processo BROWSER (o unico SEM '--type=' na linha de comando). Os filhos do WebView2
# (gpu-process, utility, crashpad-handler) NUNCA recebem a flag, mesmo quando tudo deu certo —
# olhar eles daria "nao herdou" errado.
function Get-WaBrowserProc {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($pkgName)) -and ($_.CommandLine -notmatch '--type=') } |
             Sort-Object CreationDate -Descending | Select-Object -First 1)
  } catch { return @() }
}
function Test-AppHasDebugFlag {
  $b = Get-WaBrowserProc
  if ($b.Count -eq 0) { return $null }               # app sem WebView no ar: nao da pra afirmar
  if ($b[0].CommandLine -match 'remote-debugging-port') { return $true }
  # Sem a flag SO prova nao-heranca se o app nasceu DEPOIS de a gente configurar. Se ele ja estava
  # aberto de antes, e esperado que nao tenha — nesse caso o certo e reabrir o app, nao reiniciar o PC.
  try { if ($b[0].CreationDate -and $b[0].CreationDate -lt $ConfigAt) { return $null } } catch { }
  return $false
}
# O WhatsApp esta rodando (tem processo), mesmo que ainda SEM porta de debug?
function Test-AppRunning {
  try {
    $any = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
           Where-Object {
             ($_.CommandLine -and $_.CommandLine -match [regex]::Escape($pkgName)) -or
             ($_.ExecutablePath -and $_.ExecutablePath -match [regex]::Escape($pkgName))
           } | Select-Object -First 1
    return [bool]$any
  } catch { return $false }
}

# Motor (Node): usa o que vier na pasta 'node', senao o do sistema, senao baixa sozinho (1a vez).
function Ensure-Node {
  $local = Join-Path $here 'node\node.exe'
  if (Test-Path $local) { return $local }
  $sys = Get-Command node -ErrorAction SilentlyContinue
  if ($sys) { return 'node' }
  Write-Host "Primeira vez: instalando o motor (uns 30MB, so uma vez)..."
  try {
    $ProgressPreference = 'SilentlyContinue'
    $ver = 'v22.11.0'
    $url = "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip"
    $tmp = Join-Path $env:TEMP 'sc-node.zip'
    $ex  = Join-Path $env:TEMP 'sc-node'
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
    Expand-Archive -Path $tmp -DestinationPath $ex -Force
    $found = Get-ChildItem -Recurse -Path $ex -Filter node.exe | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path (Join-Path $here 'node') | Out-Null
    Copy-Item $found.FullName $local -Force
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Remove-Item $ex -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $local) { Write-Host "Motor instalado."; return $local }
  } catch { Write-Host "Nao consegui instalar o motor automaticamente. Instale o Node em nodejs.org e rode de novo." }
  return 'node'
}

# 1) liga a porta de debug em modo porta-livre (cada app WebView2 pega a sua). Obs: apps da
#    Store so herdam esse ajuste depois de um LOGIN novo (reinicio do PC) — por isso, na 1a
#    vez ou em maquina Lenovo (Vantage), pode precisar reiniciar o PC uma vez.
Set-DebugPort
$policyOk = Set-DebugPolicy      # caminho que dispensa reiniciar (precisa de admin)
$ConfigAt = Get-Date             # a partir daqui, app que abrir DEVE vir com a flag
if ($policyOk) {
  Write-Host "Modo porta-livre ativado (vale ja no proximo start do $Label, sem reiniciar)."
} else {
  Write-Host "Obs: sem permissao de administrador pra ativar o modo instantaneo."
  Write-Host "     Se pedir pra reiniciar o PC, feche e rode este atalho como Administrador uma vez (evita o reinicio)."
}

# 0) auto-atualizacao (best-effort)
try {
  $repo = Split-Path -Parent $here
  if (Test-Path (Join-Path $repo '.git')) {
    Write-Host "Buscando a versao mais nova do Sale Chat..."
    & git -C $repo pull --ff-only 2>&1 | Out-Null
    Write-Host "Atualizado."
  }
} catch { Write-Host "(sem atualizacao; segui com a versao local)" }

$nodeExe = Ensure-Node

Write-Host "Sale Chat - $Label rodando. Pode MINIMIZAR esta janela (nao feche)."
# Estrategia SEGURA: a gente DESCOBRE a porta que o WhatsApp abriu (sem brigar por porta nem
# matar outros apps). So mexemos no PROPRIO WhatsApp, e no maximo: abrir 1x se estiver fechado,
# ou reiniciar 1x se estiver aberto SEM porta de debug. Nunca num loop de kill — o atendente
# pode estar no meio de uma conversa. Depois de um inject bem-sucedido, a permissao de
# reinicio volta (pra cobrir uma queda real la na frente).
$openedOnce = $false
$restartedOnce = $false
while ($true) {
  $waPort = Discover-Port
  if ($waPort -le 0) {
    if (-not (Test-AppRunning)) {
      if (-not $openedOnce) { Write-Host "Abrindo o $Label..."; Open-App; $openedOnce = $true; Start-Sleep -Seconds 5 }
      $waPort = Discover-Port
    } elseif (-not $restartedOnce) {
      # Rodando, mas sem porta de debug. Tenta UMA vez reabrir pra aplicar a porta de debug.
      Write-Host "Preparando o $Label com a porta de debug (uma vez)..."
      Set-DebugPort; Close-App; Start-Sleep -Milliseconds 2500; Open-App; $restartedOnce = $true
      for ($i = 0; $i -lt 45; $i++) { $waPort = Find-WhatsAppPort; if ($waPort -gt 0) { break }; Start-Sleep -Milliseconds 1000 }
    }
  }
  if ($waPort -gt 0) {
    $openedOnce = $true; $restartedOnce = $false
    Write-Host "WhatsApp achado na porta de debug $waPort. Injetando o painel do Sale Chat..."
    $env:ZV_PORT = "$waPort"
    # Auto-update do injetor: baixa a versao mais nova do servidor (fallback pro local se offline).
    try {
      $tmpInj = Join-Path $here 'inject.new.js'
      Invoke-WebRequest -Uri 'https://axion.axion-dash.workers.dev/sc-inject.js' -OutFile $tmpInj -UseBasicParsing -TimeoutSec 15
      if ((Get-Item $tmpInj).Length -gt 5000) { Move-Item -Force $tmpInj (Join-Path $here 'inject.js'); Write-Host "Injetor atualizado do servidor." }
      else { Remove-Item -Force $tmpInj -ErrorAction SilentlyContinue }
    } catch { Write-Host "Sem atualizar o injetor (offline?), usando o local." }
    & $nodeExe (Join-Path $here 'inject.js')
    Write-Host "Injetor encerrou. Retomando em 3s..."
  } else {
    if ((Test-AppHasDebugFlag) -eq $false) {
      # CERTEZA: o app abriu SEM a flag -> a sessao do Windows nao tem a variavel ainda.
      Write-Host ""
      Write-Host "  ================================================================"
      Write-Host "   FALTA 1 PASSO (so nesta primeira vez)"
      Write-Host "  ================================================================"
      if (-not $policyOk) {
        Write-Host "   O $Label abriu sem o modo de conexao ligado."
        Write-Host ""
        Write-Host "   MAIS RAPIDO (sem reiniciar):"
        Write-Host "     1) Feche esta janela."
        Write-Host "     2) Clique com o BOTAO DIREITO no atalho do Sale Chat"
        Write-Host "        e escolha 'Executar como administrador'."
        Write-Host "     3) Feche o $Label por completo e abra de novo."
        Write-Host ""
        Write-Host "   Se nao der certo: reinicie o computador uma vez."
      } else {
        Write-Host "   O modo de conexao ja foi ligado, mas o $Label precisa"
        Write-Host "   ser aberto DE NOVO pra pegar (ele le isso ao abrir)."
        Write-Host ""
        Write-Host "     1) Feche o $Label POR COMPLETO (inclusive o icone perto do relogio)."
        Write-Host "     2) Abra o $Label de novo."
        Write-Host ""
        Write-Host "   Se depois disso continuar assim: reinicie o computador uma vez."
      }
      Write-Host "   So precisa fazer isso 1 vez. Deixe esta janela aberta."
      Write-Host "  ================================================================"
      Write-Host ""
      Start-Sleep -Seconds 12   # nao spamar a tela; o aviso e o mesmo ate resolver
    } else {
      Write-Host "Ainda sem a porta de debug do $Label. Deixe esta janela ABERTA que ela entra sozinha assim que der."
      Write-Host "  Se acabou de instalar OU a maquina e Lenovo: REINICIE o PC uma vez (ativa o modo porta-livre)."
      Write-Host "  Alternativa sem reiniciar: feche o app que conflita (ex: 'Lenovo Vantage') e o WhatsApp, e reabra o WhatsApp."
    }
  }
  Start-Sleep -Seconds 3
}
