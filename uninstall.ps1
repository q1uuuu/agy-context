# ==============================================================================
# Antigravity Context & Token Inspector (agy-context) Uninstaller for Windows
# ==============================================================================

$ErrorActionPreference = "SilentlyContinue"

$userDir = $env:USERPROFILE
$targetPluginDir = Join-Path $userDir ".gemini\config\plugins\agy-context"
$targetSidecarDir = Join-Path $userDir ".gemini\config\sidecars\agy-context"
$targetSidecarData = Join-Path $userDir ".gemini\antigravity\sidecar_data"
$cfgPath = Join-Path $userDir ".gemini\config\config.json"

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "  Antigravity Context Inspector (agy-context) Uninstaller        " -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Stop and Disable Sidecar via Language Server RPC if running
Write-Host "[1/4] Stopping background sidecar daemon..." -ForegroundColor Yellow

$lsPort = $null
$token = $null
if ($env:ANTIGRAVITY_LS_ADDRESS -and $env:ANTIGRAVITY_CSRF_TOKEN) {
    $lsPort = ($env:ANTIGRAVITY_LS_ADDRESS -split ":")[-1]
    $token = $env:ANTIGRAVITY_CSRF_TOKEN
}
if (-not $lsPort -or -not $token) {
    $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | 
        Where-Object { $_.CommandLine -like "*language_server.exe*" } | 
        Select-Object -First 1
    if ($proc) {
        if ($proc.CommandLine -match '--csrf_token\s+([^\s]+)') {
            $token = $matches[1]
        }
        $conns = Get-NetTCPConnection -OwningProcess $proc.ProcessId -State Listen -ErrorAction SilentlyContinue | 
            Where-Object { $_.LocalAddress -eq '127.0.0.1' }
        foreach ($c in $conns) {
            try {
                $h = Invoke-RestMethod -Uri "http://127.0.0.1:$($c.LocalPort)/healthz" -TimeoutSec 1 -ErrorAction Stop
                if ($h.status -eq "ok") {
                    $lsPort = $c.LocalPort
                    break
                }
            } catch {}
        }
    }
}

if ($lsPort -and $token) {
    $headers = @{
        "Content-Type" = "application/json"
        "x-codeium-csrf-token" = $token
    }
    # Disable both plugin sidecar and legacy standalone sidecar
    foreach ($sid in @("agy-context/context-panel", "agy-context")) {
        try {
            $body = (@{ sidecarId = $sid; action = "SIDECAR_ACTION_DISABLE" } | ConvertTo-Json)
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$lsPort/exa.language_server_pb.LanguageServerService/ManageSidecar" -Method Post -Headers $headers -Body $body -TimeoutSec 2
        } catch {}
    }
    Write-Host "      [OK] Sidecar stopped via Language Server." -ForegroundColor Green
}

# 2. Delete Sidecar Directory
Write-Host "[2/4] Removing Sidecar files..." -ForegroundColor Yellow
if (Test-Path $targetSidecarDir) {
    Remove-Item -Path $targetSidecarDir -Recurse -Force
}
Write-Host "      [OK] Standalone sidecars directory cleaned." -ForegroundColor Green

# 3. Delete Plugin Directory
Write-Host "[3/4] Removing Plugin bundle..." -ForegroundColor Yellow
if (Test-Path $targetPluginDir) {
    Remove-Item -Path $targetPluginDir -Recurse -Force
    Write-Host "      [OK] Removed: $targetPluginDir" -ForegroundColor Green
} else {
    Write-Host "      [OK] Plugin directory not present." -ForegroundColor Gray
}

# 4. Clean config.json and sidecar_data
Write-Host "[4/4] Cleaning cached data and configurations..." -ForegroundColor Yellow
$legacyData = Join-Path $targetSidecarData "agy-context"
$pluginData = Join-Path $targetSidecarData "agy-context_context-panel"
if (Test-Path $legacyData) { Remove-Item -Path $legacyData -Recurse -Force }
if (Test-Path $pluginData) { Remove-Item -Path $pluginData -Recurse -Force }

if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $changed = $false
        if ($cfg.sidecars -and $cfg.sidecars.'agy-context') {
            $cfg.sidecars.PSObject.Properties.Remove('agy-context')
            $changed = $true
        }
        if ($cfg.sidecars -and $cfg.sidecars.'agy-context/context-panel') {
            $cfg.sidecars.PSObject.Properties.Remove('agy-context/context-panel')
            $changed = $true
        }
        if ($cfg.plugins -and $cfg.plugins.'agy-context') {
            $cfg.plugins.PSObject.Properties.Remove('agy-context')
            $changed = $true
        }
        if ($changed) {
            $json = $cfg | ConvertTo-Json -Depth 10
            [System.IO.File]::WriteAllText($cfgPath, $json, [System.Text.Encoding]::UTF8)
        }
    } catch {}
}
Write-Host "      [OK] Cleanup completed." -ForegroundColor Green

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "  Uninstallation Complete! All components removed cleanly.       " -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host ""
