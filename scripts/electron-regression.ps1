param(
  [switch]$LiveProviders,
  [switch]$ClaudeOnly,
  [switch]$SkipCore,
  [switch]$KeepRunning,
  [string]$NpmCommand = $env:AGENTDESK_NPM_COMMAND,
  [string]$PlaywrightWrapper = $env:AGENTDESK_PLAYWRIGHT_WRAPPER
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot

if (-not $PlaywrightWrapper) {
  $PlaywrightWrapper = Join-Path $env:USERPROFILE ".claude\skills\playwright-cli\scripts\playwright-cli.ps1"
}
if (-not (Test-Path -LiteralPath $PlaywrightWrapper -PathType Leaf)) {
  throw "找不到 playwright-cli wrapper：$PlaywrightWrapper"
}
if (-not $NpmCommand) {
  $NpmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $NpmCommand -PathType Leaf)) {
  throw "找不到 npm 命令：$NpmCommand"
}

$session = "agentdesk-regression-$PID"
$attached = $false
$started = $false
$developmentProcess = $null
$logRoot = Join-Path $repoRoot "build\logs"
$stdoutLog = Join-Path $logRoot "electron-regression-$PID.stdout.log"
$stderrLog = Join-Path $logRoot "electron-regression-$PID.stderr.log"

function Get-DescendantProcessIds {
  param([int]$RootProcessId)
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Get-DescendantProcessIds ([int]$child.ProcessId)
    [int]$child.ProcessId
  }
}

function Stop-OwnedProcessTree {
  param([int]$RootProcessId)
  $processIds = @((Get-DescendantProcessIds $RootProcessId), $RootProcessId) | Select-Object -Unique
  foreach ($processId in $processIds) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

function Write-DevelopmentLogTail {
  if (Test-Path -LiteralPath $stdoutLog) {
    Write-Output "--- npm run dev stdout ---"
    Get-Content -LiteralPath $stdoutLog -Tail 80
  }
  if (Test-Path -LiteralPath $stderrLog) {
    Write-Output "--- npm run dev stderr ---"
    Get-Content -LiteralPath $stderrLog -Tail 80
  }
}

function Invoke-PlaywrightChecked {
  param([string[]]$Arguments)
  $output = & $PlaywrightWrapper @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  $text = $output -join "`n"
  $output | Write-Output
  if ($exitCode -ne 0 -or $text -match "(?m)^### Error") {
    throw "Playwright 操作失败：$($Arguments -join ' ')"
  }
  if ($Arguments -contains "run-code" -and $text -notmatch '(?ms)^### Result\s*\r?\n\{"ok":true') {
    throw "Playwright 回归没有返回明确的成功结果：$($Arguments -join ' ')"
  }
}

try {
  $occupiedPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 3000 -or $_.LocalPort -eq 9223 })
  if ($occupiedPorts.Count) {
    throw "Electron 回归端口 3000 或 9223 已被占用，请先停止现有开发实例。"
  }
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $developmentProcess = Start-Process -FilePath $NpmCommand -ArgumentList @("run", "dev") -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
  $started = $true

  $cdpReady = $false
  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    if ($developmentProcess.HasExited) {
      throw "npm run dev 在 Electron CDP 就绪前退出，退出码 $($developmentProcess.ExitCode)。"
    }
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:9223/json/version" -TimeoutSec 2
      $cdpReady = $true
      break
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  if (-not $cdpReady) {
    throw "Electron CDP 9223 在启动后仍不可用。"
  }

  Invoke-PlaywrightChecked @("-s=$session", "attach", "--cdp=http://127.0.0.1:9223")
  $attached = $true
  if ($ClaudeOnly) {
    Invoke-PlaywrightChecked @("-s=$session", "run-code", "--filename=$(Join-Path $scriptRoot 'electron-live-claude-smoke.js')")
  } elseif (-not $SkipCore) {
    Invoke-PlaywrightChecked @("-s=$session", "run-code", "--filename=$(Join-Path $scriptRoot 'electron-core-smoke.js')")
  }

  if ($LiveProviders) {
    Invoke-PlaywrightChecked @("-s=$session", "run-code", "--filename=$(Join-Path $scriptRoot 'electron-live-provider-smoke.js')")
  }

  $console = & $PlaywrightWrapper "-s=$session" "console" "error" 2>&1
  $console | Write-Output
  if ($LASTEXITCODE -ne 0 -or ($console -join "`n") -match "(?m)^### Error|Errors:\s*[1-9]") {
    throw "Electron Renderer 控制台存在错误。"
  }
  Write-Output "AgentDesk Electron 核心回归通过。"
} catch {
  Write-DevelopmentLogTail
  throw
} finally {
  if ($attached) {
    & $PlaywrightWrapper "-s=$session" "detach" | Write-Output
  }
  if ($started -and -not $KeepRunning) {
    Stop-OwnedProcessTree $developmentProcess.Id
    Write-Output "已停止本轮 Electron 回归启动的开发进程。"
  }
}
