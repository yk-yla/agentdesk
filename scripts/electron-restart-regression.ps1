param(
  [int]$VitePort = 3000,
  [int]$CdpPort = 9231,
  [string]$NpmCommand = $env:AGENTDESK_NPM_COMMAND,
  [string]$PlaywrightWrapper = $env:AGENTDESK_PLAYWRIGHT_WRAPPER
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "build"))
$profile = Join-Path $buildRoot "restart-regression-profile-$PID"
$claudeConfig = Join-Path $buildRoot "restart-regression-claude-$PID"
$logRoot = Join-Path $buildRoot "logs"
$viteLog = Join-Path $logRoot "electron-restart-$PID.vite.log"
$viteErrorLog = Join-Path $logRoot "electron-restart-$PID.vite-error.log"
$electronLog = Join-Path $logRoot "electron-restart-$PID.electron.log"
$electronErrorLog = Join-Path $logRoot "electron-restart-$PID.electron-error.log"
$electronExecutable = Join-Path $repoRoot "node_modules\electron\dist\electron.exe"
$codexFixture = Join-Path $scriptRoot "codex-app-server-fixture.cmd"
$viteProcess = $null
$electronProcess = $null
$attachedSessions = @()

if (-not $NpmCommand) { $NpmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source }
if (-not $PlaywrightWrapper) { $PlaywrightWrapper = Join-Path $repoRoot "scripts\playwright-cli-wrapper.ps1" }
foreach ($required in @($NpmCommand, $PlaywrightWrapper, $electronExecutable, $codexFixture)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "找不到重启回归依赖：$required" }
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
  param([Diagnostics.Process]$Process)
  if (-not $Process -or $Process.HasExited) { return }
  $processIds = @((Get-DescendantProcessIds $Process.Id), $Process.Id) | Select-Object -Unique
  foreach ($processId in $processIds) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
}

function Remove-TemporaryRoot {
  param([string]$Root)
  $resolved = [IO.Path]::GetFullPath($Root)
  if (-not $resolved.StartsWith("$buildRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理 build 目录外的重启回归文件：$resolved"
  }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

function Wait-HttpReady {
  param([string]$Url, [Diagnostics.Process]$Process, [int]$Attempts = 60)
  for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
    if ($Process -and $Process.HasExited) { throw "进程在服务就绪前退出，退出码 $($Process.ExitCode)。" }
    try { $null = Invoke-RestMethod -Uri $Url -TimeoutSec 2; return } catch { Start-Sleep -Milliseconds 500 }
  }
  throw "服务未按时就绪：$Url"
}

function Invoke-PlaywrightChecked {
  param([string]$Session, [string]$Action, [string]$File = "")
  $arguments = if ($Action -eq "attach") { @("-s=$Session", "attach", "--cdp=http://127.0.0.1:$CdpPort") } else { @("-s=$Session", "run-code", "--filename=$File") }
  $output = & $PlaywrightWrapper @arguments 2>&1
  $text = $output -join "`n"
  $output | Write-Output
  if ($LASTEXITCODE -ne 0 -or $text -match "(?m)^### Error" -or ($Action -eq "run" -and $text -notmatch '(?ms)^### Result\s*\r?\n\{"ok":true')) {
    throw "Playwright 重启回归失败：$Action"
  }
}

function Start-TestElectron {
  $environment = @{
    ELECTRON_RENDERER_URL = "http://127.0.0.1:$VitePort"
    CODEX_DESKTOP_CLI = $codexFixture
    CLAUDE_CONFIG_DIR = $claudeConfig
    AGENTDESK_RESTART_CONTENT_FIXTURE = "1"
  }
  $arguments = @("--user-data-dir=$profile", "--remote-debugging-port=$CdpPort", ".", "--cwd=$repoRoot")
  $process = Start-Process -FilePath $electronExecutable -ArgumentList $arguments -WorkingDirectory $repoRoot -Environment $environment -WindowStyle Hidden -RedirectStandardOutput $electronLog -RedirectStandardError $electronErrorLog -PassThru
  Wait-HttpReady "http://127.0.0.1:$CdpPort/json/version" $process
  return $process
}

try {
  $occupied = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $VitePort -or $_.LocalPort -eq $CdpPort })
  if ($occupied.Count) { throw "重启回归端口 $VitePort 或 $CdpPort 已被占用。" }
  New-Item -ItemType Directory -Path $profile, $claudeConfig, $logRoot -Force | Out-Null
  & $NpmCommand run build:main
  if ($LASTEXITCODE -ne 0) { throw "重启回归主进程构建失败。" }
  $viteProcess = Start-Process -FilePath $NpmCommand -ArgumentList @("run", "dev:web", "--", "--port", "$VitePort") -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $viteLog -RedirectStandardError $viteErrorLog -PassThru
  Wait-HttpReady "http://127.0.0.1:$VitePort" $viteProcess

  $electronProcess = Start-TestElectron
  $firstSession = "agentdesk-restart-before-$PID"
  Invoke-PlaywrightChecked $firstSession "attach"
  $attachedSessions += $firstSession
  Invoke-PlaywrightChecked $firstSession "run" (Join-Path $scriptRoot "electron-restart-prepare.js")
  Invoke-PlaywrightChecked $firstSession "run" (Join-Path $scriptRoot "electron-restart-quit.js")
  if (-not $electronProcess.WaitForExit(15000)) { throw "AgentDesk 第一轮正常退出超时。" }
  & $PlaywrightWrapper "-s=$firstSession" "detach" 2>&1 | Write-Output

  $electronProcess = Start-TestElectron
  $secondSession = "agentdesk-restart-after-$PID"
  Invoke-PlaywrightChecked $secondSession "attach"
  $attachedSessions += $secondSession
  Invoke-PlaywrightChecked $secondSession "run" (Join-Path $scriptRoot "electron-restart-verify.js")
  Invoke-PlaywrightChecked $secondSession "run" (Join-Path $scriptRoot "electron-restart-quit.js")
  if (-not $electronProcess.WaitForExit(15000)) { throw "AgentDesk 第二轮正常退出超时。" }
  Write-Output "AgentDesk 真实退出重启恢复回归通过。"
} finally {
  foreach ($session in $attachedSessions) { & $PlaywrightWrapper "-s=$session" "detach" 2>&1 | Write-Output }
  Stop-OwnedProcessTree $electronProcess
  Stop-OwnedProcessTree $viteProcess
  Remove-TemporaryRoot $profile
  Remove-TemporaryRoot $claudeConfig
}
