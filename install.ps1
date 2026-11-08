# ==============================================================================
# Antigravity Context & Token Inspector (agy-context) Installer for Windows
# ==============================================================================

$ErrorActionPreference = "Stop"

$userDir = $env:USERPROFILE
$targetPluginDir = Join-Path $userDir ".gemini\config\plugins\agy-context"
$legacySidecarDir = Join-Path $userDir ".gemini\config\sidecars\agy-context"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "  Antigravity Context & Token Inspector (agy-context) Installer  " -ForegroundColor Cyan
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Install Plugin Bundle (Sidecar is natively included in plugin)
Write-Host "[1/3] Installing Plugin Bundle..." -ForegroundColor Yellow
$samePluginDir = ($scriptDir.TrimEnd('\/') -eq $targetPluginDir.TrimEnd('\/'))
if (-not $samePluginDir) {
    if (-not (Test-Path $targetPluginDir)) {
        New-Item -ItemType Directory -Force -Path $targetPluginDir | Out-Null
    }
    Copy-Item -Path (Join-Path $scriptDir "*") -Destination $targetPluginDir -Recurse -Force -Exclude "install.ps1","install.sh","uninstall.ps1","uninstall.sh"
    # Copy install & uninstall scripts as well
    Copy-Item -Path (Join-Path $scriptDir "install.ps1") -Destination $targetPluginDir -Force
    Copy-Item -Path (Join-Path $scriptDir "install.sh") -Destination $targetPluginDir -Force
    Copy-Item -Path (Join-Path $scriptDir "uninstall.ps1") -Destination $targetPluginDir -Force
    Copy-Item -Path (Join-Path $scriptDir "uninstall.sh") -Destination $targetPluginDir -Force
    # Clean redundant sidecar scripts if present
    $redundantScripts = Join-Path $targetPluginDir "sidecars\context-panel\scripts"
    if (Test-Path $redundantScripts) {
        Remove-Item -Path $redundantScripts -Recurse -Force
    }
    Write-Host "      [OK] Plugin files installed to: $targetPluginDir" -ForegroundColor Green
} else {
    Write-Host "      [OK] Plugin directory is current location ($targetPluginDir)" -ForegroundColor Green
}

# 2. Clean Legacy Standalone Sidecar (Avoid duplicate menu items)
Write-Host "[2/3] Checking for legacy standalone sidecar configurations..." -ForegroundColor Yellow
if (Test-Path $legacySidecarDir) {
    Remove-Item -Path $legacySidecarDir -Recurse -Force
    Write-Host "      [OK] Cleaned legacy standalone sidecar to prevent duplicate items." -ForegroundColor Green
} else {
    Write-Host "      [OK] No duplicate sidecar detected." -ForegroundColor Green
}

# 3. Auto-Activate Plugin Sidecar Daemon if Antigravity is running
Write-Host "[3/3] Checking Antigravity Language Server status..." -ForegroundColor Yellow

function Activate-AntigravitySidecar {
    param([string]$SidecarId = "agy-context/context-panel")
    
    $lsPort = $null
    $token = $null
    
    # Check env variables first
    if ($env:ANTIGRAVITY_LS_ADDRESS -and $env:ANTIGRAVITY_CSRF_TOKEN) {
        $lsPort = ($env:ANTIGRAVITY_LS_ADDRESS -split ":")[-1]
        $token = $env:ANTIGRAVITY_CSRF_TOKEN
    }
    
    # Check running language_server.exe process
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
        try {
            $headers = @{
                "Content-Type" = "application/json"
                "x-codeium-csrf-token" = $token
            }
            $body = (@{ sidecarId = $SidecarId; action = "SIDECAR_ACTION_ENABLE" } | ConvertTo-Json)
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$lsPort/exa.language_server_pb.LanguageServerService/ManageSidecar" -Method Post -Headers $headers -Body $body -TimeoutSec 3 -ErrorAction Stop
            return @{ Success = $true; Port = $lsPort }
        } catch {
            return @{ Success = $false; Error = $_.Exception.Message }
        }
    }
    return @{ Success = $false; Reason = "NotRunning" }
}

$actResult = Activate-AntigravitySidecar -SidecarId "agy-context/context-panel"
if ($actResult.Success) {
    Write-Host "      [OK] Antigravity Language Server detected. Sidecar daemon activated live!" -ForegroundColor Green
} elseif ($actResult.Reason -eq "NotRunning") {
    Write-Host "      [INFO] Antigravity is not currently running. Sidecar will start on next launch." -ForegroundColor Gray
} else {
    Write-Host "      [WARNING] Could not activate live ($($actResult.Error)). Sidecar will start after Antigravity restart." -ForegroundColor Gray
}

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "  Installation Completed Successfully!                           " -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "How to Open & View:" -ForegroundColor White
Write-Host "  1. Click the top-right '...' menu -> 'Extensions >' -> 'Context Usage'" -ForegroundColor Cyan
Write-Host "  2. Or click the in-chat link: [Open Context Inspector](sidecar://agy-context/context-panel/)" -ForegroundColor Cyan
Write-Host "  3. Running continuously in background sidecar." -ForegroundColor Cyan
Write-Host ""
