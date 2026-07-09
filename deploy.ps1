# ════════════════════════════════════════════════════════════════
# AXION — Deploy do frontend (index.html) para Cloudflare Pages
# ════════════════════════════════════════════════════════════════
# Uso:  .\deploy.ps1
#
# Primeira vez: o wrangler vai abrir o navegador pra você logar
# na Cloudflare. Depois disso fica salvo e nunca mais precisa.
# ════════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

$projectName = "axion"
$rootDir     = $PSScriptRoot
$distDir     = Join-Path $rootDir "dist"
$srcFile     = Join-Path $rootDir "index.html"

if (-not (Test-Path $srcFile)) {
    Write-Host "ERRO: index.html nao encontrado em $rootDir" -ForegroundColor Red
    exit 1
}

# Cria pasta dist isolada (wrangler pages deploy espera um diretorio,
# nao um arquivo solto — e nao queremos subir backend/, README, etc).
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Path $distDir | Out-Null
Copy-Item $srcFile (Join-Path $distDir "index.html")

Write-Host ""
Write-Host "Subindo index.html para Cloudflare Pages (projeto: $projectName)..." -ForegroundColor Cyan
Write-Host ""

npx wrangler@latest pages deploy $distDir --project-name=$projectName --commit-dirty=true

Write-Host ""
Write-Host "Deploy concluido. Da F5 (Ctrl+Shift+R) na Dashboard pra ver o build novo." -ForegroundColor Green
