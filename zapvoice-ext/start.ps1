# ZapVoice Nosso — lancador do modo APP (WhatsApp da Windows Store / WebView2)
# 1) liga a porta de debug do WebView2 (uma vez, persiste)
# 2) garante o WhatsApp aberto com a porta
# 3) injeta o painel dentro do app e fica vigiando (reinjeta se reiniciar)
$ErrorActionPreference = 'Continue'
$PORT = 9222
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-Port { try { Invoke-RestMethod ("http://127.0.0.1:$PORT/json/version") -TimeoutSec 2 | Out-Null; return $true } catch { return $false } }

function Close-WhatsApp {
  try {
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match '5319275A' -or $_.CommandLine -match 'WhatsAppDesktop' -or $_.CommandLine -match 'webview-exe-name=WhatsApp') } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}
}

function Open-WhatsApp {
  $app = Get-StartApps | Where-Object { $_.Name -match 'WhatsApp' } | Select-Object -First 1
  if ($app) { Start-Process ("shell:AppsFolder\" + $app.AppID) }
}

function Ensure-Port {
  if (Test-Port) { return $true }
  Write-Host "Reiniciando o WhatsApp pra ativar a porta de debug..."
  Close-WhatsApp
  Start-Sleep -Milliseconds 1500
  Open-WhatsApp
  for ($i = 0; $i -lt 40; $i++) { if (Test-Port) { return $true }; Start-Sleep -Milliseconds 1000 }
  return (Test-Port)
}

# 1) env var persistente
$want = "--remote-debugging-port=$PORT"
$cur = [Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'User')
if ($cur -notmatch [regex]::Escape($want)) {
  [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', $want, 'User')
  Write-Host "Porta de debug ativada no WhatsApp (config unica)."
}

# 0) auto-atualizacao: puxa a versao mais nova do repo (best-effort; ignora se nao der)
try {
  $repo = Split-Path -Parent $here
  if (Test-Path (Join-Path $repo '.git')) {
    Write-Host "Buscando a versao mais nova do Sale Chat..."
    & git -C $repo pull --ff-only 2>&1 | Out-Null
    Write-Host "Atualizado."
  }
} catch { Write-Host "(sem atualizacao; segui com a versao local)" }

Write-Host "Sale Chat - modo APP. Deixe esta janela aberta."
# 2 + 3) loop resiliente: garante a porta e injeta; se cair, reergue
while ($true) {
  if (Ensure-Port) {
    Write-Host "Conectado. Injetando o painel no WhatsApp..."
    node (Join-Path $here 'inject.js')
    Write-Host "Injetor encerrou (WhatsApp fechou/recarregou). Retomando em 3s..."
  } else {
    Write-Host "Nao consegui abrir a porta. Abra o WhatsApp e aguarde..."
  }
  Start-Sleep -Seconds 3
}
