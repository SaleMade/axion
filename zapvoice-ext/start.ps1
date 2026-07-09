# Sale Chat - lancador do modo APP (WhatsApp da Windows Store / WebView2)
# Suporta os dois apps: WhatsApp normal e WhatsApp Beta, cada um numa porta propria,
# pra nao se cruzarem. Use start-normal.bat ou start-beta.bat (ou este com -Mode).
#   1) liga a porta de debug do WebView2 SO pro app escolhido
#   2) garante o app aberto com a porta
#   3) injeta o painel dentro do app e fica vigiando (reinjeta se reiniciar)
param(
  [ValidateSet('normal','beta')][string]$Mode = 'normal',
  [int]$Port = 0
)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Port -eq 0) { $Port = if ($Mode -eq 'beta') { 9223 } else { 9222 } }
$Label = if ($Mode -eq 'beta') { 'WhatsApp Beta' } else { 'WhatsApp' }

# Acha o app certo no Menu Iniciar (normal = sem "Beta"; beta = com "Beta")
$all = Get-StartApps | Where-Object { $_.Name -match 'WhatsApp' }
if ($Mode -eq 'beta') { $app = $all | Where-Object { $_.Name -match 'Beta' } | Select-Object -First 1 }
else { $app = $all | Where-Object { $_.Name -notmatch 'Beta' } | Select-Object -First 1 }
if (-not $app) {
  Write-Host "Nao achei o app '$Label' no Menu Iniciar. Instale pela Microsoft Store."
  Write-Host "Apps WhatsApp encontrados:"; $all | ForEach-Object { Write-Host " - $($_.Name)" }
  pause; exit 1
}
# Package family name (parte antes do '!') aparece na linha de comando do WebView2 desse app
$pfn = ($app.AppID -split '!')[0]

function Test-Port { try { Invoke-RestMethod ("http://127.0.0.1:$Port/json/version") -TimeoutSec 2 | Out-Null; return $true } catch { return $false } }
function Set-DebugPort { [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', "--remote-debugging-port=$Port", 'User') }
function Close-App {
  try {
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($pfn)) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
}
function Open-App { Start-Process ("shell:AppsFolder\" + $app.AppID) }
function Ensure-Port {
  if (Test-Port) { return $true }
  Write-Host "Abrindo/reiniciando o $Label na porta $Port..."
  Set-DebugPort
  Close-App; Start-Sleep -Milliseconds 1500; Open-App
  for ($i = 0; $i -lt 40; $i++) { if (Test-Port) { return $true }; Start-Sleep -Milliseconds 1000 }
  return (Test-Port)
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

function Minimize-Self {
  try {
    Add-Type -Name W -Namespace SC -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);' -ErrorAction SilentlyContinue
    [SC.W]::ShowWindow([SC.W]::GetConsoleWindow(), 6) | Out-Null
  } catch {}
}

# 1) porta de debug SO pra este app: seta a env var e reinicia este app pra pegar a porta
Set-DebugPort
if (-not (Test-Port)) { Close-App; Start-Sleep -Milliseconds 1200 }

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

Write-Host "Sale Chat - $Label (porta $Port) rodando. Pode MINIMIZAR esta janela (nao feche)."
Minimize-Self
while ($true) {
  if (Ensure-Port) {
    Write-Host "Conectado ao $Label. Injetando o painel..."
    $env:ZV_PORT = "$Port"
    & $nodeExe (Join-Path $here 'inject.js')
    Write-Host "Injetor encerrou ($Label fechou/recarregou). Retomando em 3s..."
  } else {
    Write-Host "Nao consegui abrir a porta do $Label. Abra o app e aguarde..."
  }
  Start-Sleep -Seconds 3
}
