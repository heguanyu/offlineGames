# Deploy the site + server to the Azure Web App "offlineGames" FROM THIS MACHINE.
# This replaced the GitHub Actions CD (main_offlinegames.yml, decommissioned 2026-07-09) —
# deployment is now: bump sw.js CACHE → commit/push → run THIS script.
#
#   pwsh tools/deploy-azure.ps1        (or powershell.exe -File tools/deploy-azure.ps1)
#
# What it does (mirrors the old workflow):
#   1. node tools/pack-voice.js         — regenerate the voice sprites (git-ignored output)
#   2. stage the publishable site into _deploy (excludes .git/.github/test/server data+modules)
#      + write the deploy package.json (type:module, start script, runtime deps)
#   3. zip WITHOUT node_modules and `az webapp deploy` it with SCM_DO_BUILD_DURING_DEPLOYMENT=true:
#      Kudu/Oryx runs `npm install` ON THE AZURE LINUX RUNTIME, so better-sqlite3's native binary
#      always matches the host (the old workflow compiled on a Node 20 runner while the app runs
#      NODE|24-lts — building server-side is strictly safer).
#   4. verify /health + the live sw.js version.
# Requires: Azure CLI logged in (`az login`) with access to resource group offlineGamesRg.
$ErrorActionPreference = 'Stop'
$RG = 'offlineGamesRg'; $APP = 'offlineGames'
$root = Split-Path -Parent $PSScriptRoot

Write-Host '==> packing voice sprites'
node (Join-Path $root 'tools\pack-voice.js')
if ($LASTEXITCODE) { throw 'pack-voice failed' }

Write-Host '==> generating sub-hub service workers'
node (Join-Path $root 'tools\gen-subhub.js')
if ($LASTEXITCODE) { throw 'gen-subhub failed' }

Write-Host '==> staging site into _deploy'
$stage = Join-Path $root '_deploy'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory $stage | Out-Null
robocopy $root $stage /E /NFL /NDL /NJH /NJS /NP `
  /XD (Join-Path $root '.git') (Join-Path $root '.github') (Join-Path $root 'test') `
      (Join-Path $root 'server\node_modules') (Join-Path $root 'server\data') $stage `
  /XF (Join-Path $root 'deploy.zip') | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

# The deploy package.json — Oryx installs these deps during the server-side build.
'{"name":"mahjong-online-deploy","private":true,"type":"module","engines":{"node":">=20"},"scripts":{"start":"node server/index.js"},"dependencies":{"ws":"^8.18.0","better-sqlite3":"^11.10.0"}}' |
  Set-Content -Encoding ascii (Join-Path $stage 'package.json')

Write-Host '==> zipping'
$zip = Join-Path $root 'deploy.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
# tar.exe (bsdtar, ships with Windows 10+) writes zip by extension — much faster than Compress-Archive
tar -a -c -f $zip -C $stage .
if ($LASTEXITCODE) { throw 'zip failed' }
Write-Host ("    {0:n1} MB" -f ((Get-Item $zip).Length / 1MB))

Write-Host '==> ensuring server-side build is enabled'
az webapp config appsettings set -g $RG -n $APP --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true ENABLE_ORYX_BUILD=true --output none

Write-Host '==> deploying (upload + remote npm install; a few minutes)'
az webapp deploy -g $RG -n $APP --src-path $zip --type zip --timeout 1200 --output none
if ($LASTEXITCODE) {
  # The SCM gateway can 504 while the server-side deployment keeps running (seen in practice:
  # CLI gave up at ~4 min, deployment finished fine). Poll the deployment record to a terminal
  # state before declaring failure. status: 1=in progress, 4=success, 3=failed.
  Write-Host '    az returned an error - polling the server-side deployment status...'
  $sub = az account show --query id -o tsv
  $deployed = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 10
    $st = az rest --method get --url "https://management.azure.com/subscriptions/$sub/resourceGroups/$RG/providers/Microsoft.Web/sites/$APP/deployments?api-version=2023-12-01" --query 'value[0].properties.status' -o tsv 2>$null
    Write-Host "    deployment status: $st"
    if ($st -eq '4') { $deployed = $true; break }
    if ($st -eq '3') { break }
  }
  if (-not $deployed) { throw 'az webapp deploy failed (deployment did not reach success)' }
}

Write-Host '==> verifying'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $h = Invoke-WebRequest -UseBasicParsing "https://offlinegames.azurewebsites.net/health" -TimeoutSec 15
    if ($h.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
  Start-Sleep -Seconds 5
}
if (-not $ok) { throw 'health check FAILED after deploy — investigate (az webapp log tail)' }
$swLive = (Invoke-WebRequest -UseBasicParsing "https://offlinegames.azurewebsites.net/sw.js" -TimeoutSec 30).Content
$verLive = ([regex]"offline-games-[0-9.]+").Match($swLive).Value
$verLocal = ([regex]"offline-games-[0-9.]+").Match((Get-Content (Join-Path $root 'sw.js') -Raw)).Value
Write-Host "    live: $verLive   local: $verLocal"
if ($verLive -ne $verLocal) { throw 'live sw.js version does not match local — deploy may not have taken' }
Write-Host "DEPLOY OK — $verLive is live"
