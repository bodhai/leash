# Saves your API keys into .env straight from the clipboard, then tests them.
# The values are never printed. Run via setup-keys.bat (double-click).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $root ".env.example") $envFile }

function Set-EnvValue([string]$name, [string]$value) {
  $lines = @(Get-Content $envFile)
  $found = $false
  $lines = $lines | ForEach-Object {
    if ($_ -match "^\s*#?\s*$name\s*=") { $found = $true; "$name=$value" } else { $_ }
  }
  if (-not $found) { $lines += "$name=$value" }
  [IO.File]::WriteAllLines($envFile, $lines)
}

function Mask([string]$v) { if ($v.Length -lt 10) { return "(too short)" } return $v.Substring(0, 6) + "..." + $v.Substring($v.Length - 3) + " ($($v.Length) characters)" }

function Get-EnvValue([string]$name) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$name\s*=(.*)$" } | Select-Object -First 1
  if ($line -and $line -match "=(.*)$") { return $Matches[1].Trim() } else { return "" }
}

function Ask-Key([string]$name, [string]$where, [scriptblock]$check) {
  $current = Get-EnvValue $name
  if ($current -and (& $check $current)) {
    Write-Host ""
    Write-Host "== $name ==  currently saved: $(Mask $current)" -ForegroundColor Cyan
    $ans = Read-Host "  Press Enter to KEEP it, or type N then Enter to paste a NEW one"
    if ($ans -notmatch "^[Nn]") { return $current }
  }
  while ($true) {
    Write-Host ""
    Write-Host "== $name ==" -ForegroundColor Cyan
    Write-Host "  $where"
    Read-Host "  Click the Copy button there, then press Enter here" | Out-Null
    $v = ((Get-Clipboard -Raw) -replace "\s", "")
    if (& $check $v) {
      Set-EnvValue $name $v
      Write-Host "  Saved: $(Mask $v)" -ForegroundColor Green
      return $v
    }
    Write-Host "  That doesn't look right ($(Mask $v)). Copy it again and retry." -ForegroundColor Yellow
  }
}

Write-Host "Leash key setup - values go into $envFile and are never shown." -ForegroundColor White
$ak = Ask-Key "ANTHROPIC_API_KEY" "console.anthropic.com > API Keys (create a key if you closed the 'Save your API key' box)" { param($v) $v -like "sk-ant-*" -and $v.Length -gt 40 }
$pid_ = Ask-Key "PAYPAL_CLIENT_ID" "developer.paypal.com > Apps & Credentials (Sandbox) > Leash > Client ID copy icon" { param($v) $v.Length -gt 50 -and $v -notlike "sk-ant-*" }
$ps = Ask-Key "PAYPAL_CLIENT_SECRET" "Same page > Secret key 1 copy icon" { param($v) $v.Length -gt 50 -and $v -ne $pid_ -and $v -notlike "sk-ant-*" }
Set-Clipboard -Value " "  # don't leave the secret sitting in the clipboard

Write-Host ""
Write-Host "Testing the keys..." -ForegroundColor Cyan
try {
  $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${pid_}:${ps}"))
  $t = Invoke-RestMethod -Method Post -Uri "https://api-m.sandbox.paypal.com/v1/oauth2/token" -Headers @{ Authorization = "Basic $basic" } -Body "grant_type=client_credentials" -ContentType "application/x-www-form-urlencoded"
  Write-Host "  PayPal sandbox: OK" -ForegroundColor Green
  if ($t.scope -match "vault") { Write-Host "  PayPal Vault:   enabled" -ForegroundColor Green }
  else { Write-Host "  PayPal Vault:   NOT enabled - tick Vault / Save payment methods in the app's Features and save" -ForegroundColor Yellow }
} catch { Write-Host "  PayPal sandbox: FAILED - check you copied the Sandbox Client ID and Secret ($($_.Exception.Message))" -ForegroundColor Red }
try {
  Invoke-RestMethod -Uri "https://api.anthropic.com/v1/models?limit=1" -Headers @{ "x-api-key" = $ak; "anthropic-version" = "2023-06-01" } | Out-Null
  Write-Host "  Claude API:     OK" -ForegroundColor Green
} catch { Write-Host "  Claude API:     FAILED - create a new key at console.anthropic.com > API Keys ($($_.Exception.Message))" -ForegroundColor Red }
Write-Host ""
Write-Host "Done. Go back to Claude and type: saved" -ForegroundColor White
