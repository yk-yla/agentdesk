param(
  [int]$Port = 9224,
  [switch]$KeepRunning,
  [string]$PlaywrightWrapper = $env:AGENTDESK_PLAYWRIGHT_WRAPPER
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$executable = Join-Path $repoRoot "build\release\win-unpacked\AgentDesk.exe"
$profile = Join-Path $repoRoot "build\package-smoke-profile"
$logRoot = Join-Path $repoRoot "build\logs"
$stdoutLog = Join-Path $logRoot "electron-package-regression-$PID.stdout.log"
$stderrLog = Join-Path $logRoot "electron-package-regression-$PID.stderr.log"
$session = "agentdesk-package-regression-$PID"
$applicationProcess = $null
$attached = $false

if (-not $PlaywrightWrapper) {
  $PlaywrightWrapper = Join-Path $env:USERPROFILE ".claude\skills\playwright-cli\scripts\playwright-cli.ps1"
}
if (-not (Test-Path -LiteralPath $PlaywrightWrapper -PathType Leaf)) {
  throw "找不到 playwright-cli wrapper：$PlaywrightWrapper"
}
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "找不到打包版程序，请先执行 npm run package：$executable"
}

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
    throw "打包版回归没有返回明确的成功结果：$($Arguments -join ' ')"
  }
}

try {
  if (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $Port }) {
    throw "打包版回归端口 $Port 已被占用。"
  }
  New-Item -ItemType Directory -Path $profile, $logRoot -Force | Out-Null
  $applicationProcess = Start-Process -FilePath $executable -ArgumentList @("--user-data-dir=$profile", "--remote-debugging-port=$Port") -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

  $cdpReady = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ($applicationProcess.HasExited) {
      throw "打包版程序在 CDP 就绪前退出，退出码 $($applicationProcess.ExitCode)。"
    }
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
      $cdpReady = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $cdpReady) {
    throw "打包版 Electron CDP $Port 在启动后仍不可用。"
  }

  Invoke-PlaywrightChecked @("-s=$session", "attach", "--cdp=http://127.0.0.1:$Port")
  $attached = $true

  $secondInstance = Start-Process -FilePath $executable -ArgumentList @("--user-data-dir=$profile", "--remote-debugging-port=$Port") -WindowStyle Hidden -PassThru
  if (-not $secondInstance.WaitForExit(10000)) {
    Stop-OwnedProcessTree $secondInstance.Id
    throw "打包版第二实例没有被单实例锁及时关闭。"
  }
  if ($applicationProcess.HasExited) {
    throw "打包版第二实例错误地关闭了主实例。"
  }
  Write-Output "打包版单实例锁可用。"

  Invoke-PlaywrightChecked @("-s=$session", "run-code", "--filename=$(Join-Path $scriptRoot 'electron-packaged-smoke.js')")

  $console = & $PlaywrightWrapper "-s=$session" "console" "error" 2>&1
  $console | Write-Output
  if ($LASTEXITCODE -ne 0 -or ($console -join "`n") -match "(?m)^### Error|Errors:\s*[1-9]") {
    throw "打包版 Electron Renderer 控制台存在错误。"
  }
  Write-Output "AgentDesk 打包版核心回归通过。"
} finally {
  if ($attached) {
    & $PlaywrightWrapper "-s=$session" "detach" | Write-Output
  }
  if ($applicationProcess -and -not $KeepRunning) {
    Stop-OwnedProcessTree $applicationProcess.Id
    Write-Output "已停止本轮回归启动的打包版进程。"
  }
}
