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

# 1. Environment Pre-flight Check
Write-Host "[1/4] Running Environment Pre-flight Check..." -ForegroundColor Yellow

# 1.1 Check Antigravity host directories & storage
$geminiDir = Join-Path $userDir ".gemini"
$antigravityDir = Join-Path $geminiDir "antigravity"
$convDir = Join-Path $antigravityDir "conversations"

if (Test-Path $convDir) {
    $dbCount = (Get-ChildItem -Path $convDir -Filter "*.db" -ErrorAction SilentlyContinue).Count
    Write-Host "      [OK] Antigravity Conversation Storage: $dbCount database(s) found" -ForegroundColor Green
} elseif (Test-Path $antigravityDir) {
    Write-Host "      [INFO] Antigravity Storage: Initialized (conversation databases will appear after first chat)" -ForegroundColor Gray
} else {
    Write-Host "      [INFO] Antigravity directory (~/.gemini/antigravity) will be auto-created on launch" -ForegroundColor Gray
}

# 1.2 Check Antigravity Embedded Runtime & SQLite Engine
$agyNodePath = Join-Path $env:APPDATA "Antigravity\bin\agy-node.cmd"
$hasWinSqlite = Test-Path "$env:SystemRoot\System32\winsqlite3.dll"
$hasSqliteCli = [bool](Get-Command sqlite3 -ErrorAction SilentlyContinue)

if (Test-Path $agyNodePath) {
    Write-Host "      [OK] Antigravity Embedded Node (agy-node v24): Detected (node:sqlite enabled)" -ForegroundColor Green
} else {
    Write-Host "      [INFO] Antigravity runtime (agy-node) will be linked automatically by the IDE" -ForegroundColor Gray
}

if ($hasWinSqlite) {
    Write-Host "      [OK] Windows Native SQLite (winsqlite3.dll): Available (Zero-dependency fallback ready)" -ForegroundColor Green
} elseif ($hasSqliteCli) {
    Write-Host "      [OK] System sqlite3 CLI: Found in PATH" -ForegroundColor Green
} else {
    Write-Host "      [WARN] Neither winsqlite3.dll nor sqlite3 CLI found in System32/PATH." -ForegroundColor DarkYellow
    Write-Host "             Note: If running outside Antigravity, you can optionally install sqlite3 (e.g. winget install sqlite.sqlite)." -ForegroundColor DarkYellow
}

# 2. Install Plugin Bundle (Sidecar is natively included in plugin)
Write-Host "[2/4] Installing Plugin Bundle..." -ForegroundColor Yellow
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

# 2.1 Ensure plugin is registered & enabled in ~/.gemini/config/config.json
$cfgPath = Join-Path $userDir ".gemini\config\config.json"
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $changed = $false
        if (-not $cfg.plugins) {
            $cfg | Add-Member -MemberType NoteProperty -Name "plugins" -Value ([PSCustomObject]@{})
            $changed = $true
        }
        if (-not $cfg.plugins.'agy-context') {
            $cfg.plugins | Add-Member -MemberType NoteProperty -Name "agy-context" -Value ([PSCustomObject]@{ enabled = $true })
            $changed = $true
        } elseif ($cfg.plugins.'agy-context'.enabled -ne $true) {
            $cfg.plugins.'agy-context'.enabled = $true
            $changed = $true
        }
        if ($changed) {
            $json = $cfg | ConvertTo-Json -Depth 10
            [System.IO.File]::WriteAllText($cfgPath, $json, [System.Text.Encoding]::UTF8)
            Write-Host "      [OK] Registered agy-context in config.json plugins map." -ForegroundColor Green
        } else {
            Write-Host "      [OK] Plugin agy-context is registered in config.json." -ForegroundColor Green
        }
    } catch {
        Write-Host "      [WARN] Could not update config.json: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

# 2. Clean Legacy Standalone Sidecar (Avoid duplicate menu items)
Write-Host "[3/4] Checking for legacy standalone sidecar configurations..." -ForegroundColor Yellow
if (Test-Path $legacySidecarDir) {
    Remove-Item -Path $legacySidecarDir -Recurse -Force
    Write-Host "      [OK] Cleaned legacy standalone sidecar to prevent duplicate items." -ForegroundColor Green
} else {
    Write-Host "      [OK] No duplicate sidecar detected." -ForegroundColor Green
}

# 3. Auto-Activate Plugin Sidecar Daemon if Antigravity is running
Write-Host "[4/4] Checking Antigravity Language Server status..." -ForegroundColor Yellow

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
