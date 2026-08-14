param(
  [int]$Port = 9224,
  [switch]$KeepRunning,
  [string]$PlaywrightWrapper = $env:AGENTDESK_PLAYWRIGHT_WRAPPER
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$executable = Join-Path $repoRoot "build\release\win-unpacked\AgentDesk.exe"
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "build"))
$profile = Join-Path $buildRoot "package-smoke-profile-$PID"
$claudeConfig = Join-Path $buildRoot "package-smoke-claude-$PID"
$claudeWorker = Join-Path $repoRoot "build\release\win-unpacked\resources\app.asar.unpacked\build\electron\main\providers\claude\claudeWorker.mjs"
$codexFixture = Join-Path $scriptRoot "codex-app-server-fixture.cmd"
$logRoot = Join-Path $repoRoot "build\logs"
$stdoutLog = Join-Path $logRoot "electron-package-regression-$PID.stdout.log"
$stderrLog = Join-Path $logRoot "electron-package-regression-$PID.stderr.log"
$session = "agentdesk-package-regression-$PID"
$applicationProcess = $null
$attached = $false

if (-not $PlaywrightWrapper) {
  $PlaywrightWrapper = Join-Path $repoRoot "scripts\playwright-cli-wrapper.ps1"
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

function Remove-TemporaryRoot {
  param([string]$Root)
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    try {
      Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 19) { throw }
      Start-Sleep -Milliseconds 250
    }
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

function Assert-WorkerImportClosure {
  param([string]$WorkerPath)
  if (-not (Test-Path -LiteralPath $WorkerPath -PathType Leaf)) {
    throw "打包版 Claude Worker 不存在：$WorkerPath"
  }
  $workerDirectory = Split-Path -Parent $WorkerPath
  $source = Get-Content -LiteralPath $WorkerPath -Raw
  $pattern = '(?:from\s+|import\s*)["''](?<specifier>\.{1,2}/[^"'']+)["'']'
  foreach ($match in [regex]::Matches($source, $pattern)) {
    $target = [IO.Path]::GetFullPath((Join-Path $workerDirectory $match.Groups["specifier"].Value))
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
      throw "打包版 Claude Worker 缺少相对依赖：$($match.Groups['specifier'].Value)"
    }
  }
}

function New-ClaudeHistoryFixture {
  param([string]$ConfigRoot, [string]$Workspace)
  $projectKey = $Workspace.Replace(":", "-").Replace("\", "-").Replace("/", "-")
  $projectDirectory = Join-Path $ConfigRoot "projects\$projectKey"
  New-Item -ItemType Directory -Path $projectDirectory -Force | Out-Null
  $sessionId = "11111111-1111-4111-8111-111111111111"
  $userId = "22222222-2222-4222-8222-222222222222"
  $assistantId = "33333333-3333-4333-8333-333333333333"
  $timestamp = [DateTimeOffset]::UtcNow.ToString("o")
  $entries = @(
    [ordered]@{
      parentUuid = $null
      isSidechain = $false
      type = "user"
      message = [ordered]@{ role = "user"; content = @([ordered]@{ type = "text"; text = "AgentDesk packaged Claude history fixture" }) }
      uuid = $userId
      timestamp = $timestamp
      permissionMode = "default"
      promptSource = "package-regression"
      userType = "external"
      entrypoint = "cli"
      cwd = $Workspace
      sessionId = $sessionId
      version = "package-regression"
      gitBranch = ""
    },
    [ordered]@{
      parentUuid = $userId
      isSidechain = $false
      type = "assistant"
      message = [ordered]@{
        id = "msg_package_regression"
        type = "message"
        role = "assistant"
        model = "claude-package-fixture"
        content = @([ordered]@{ type = "text"; text = "Packaged Claude history is readable." })
        stop_reason = "end_turn"
        stop_sequence = $null
        usage = [ordered]@{ input_tokens = 1; output_tokens = 1; cache_creation_input_tokens = 0; cache_read_input_tokens = 0 }
      }
      uuid = $assistantId
      timestamp = $timestamp
      userType = "external"
      entrypoint = "cli"
      cwd = $Workspace
      sessionId = $sessionId
      version = "package-regression"
      gitBranch = ""
    },
    [ordered]@{
      type = "custom-title"
      customTitle = "AgentDesk packaged provider fixture"
      sessionId = $sessionId
      uuid = "44444444-4444-4444-8444-444444444444"
      timestamp = $timestamp
    }
  )
  $lines = @($entries | ForEach-Object { $_ | ConvertTo-Json -Depth 10 -Compress })
  [IO.File]::WriteAllLines((Join-Path $projectDirectory "$sessionId.jsonl"), $lines, [Text.UTF8Encoding]::new($false))
}

try {
  if (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $Port }) {
    throw "打包版回归端口 $Port 已被占用。"
  }
  if (-not (Test-Path -LiteralPath $codexFixture -PathType Leaf)) {
    throw "找不到 Codex 打包回归夹具：$codexFixture"
  }
  Assert-WorkerImportClosure $claudeWorker
  New-Item -ItemType Directory -Path $profile, $logRoot -Force | Out-Null
  New-ClaudeHistoryFixture $claudeConfig $repoRoot
  $applicationArguments = @("--user-data-dir=$profile", "--remote-debugging-port=$Port", "--cwd=$repoRoot")
  $applicationEnvironment = @{ CLAUDE_CONFIG_DIR = $claudeConfig; CODEX_DESKTOP_CLI = $codexFixture }
  $applicationProcess = Start-Process -FilePath $executable -ArgumentList $applicationArguments -Environment $applicationEnvironment -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru

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

  $secondInstance = Start-Process -FilePath $executable -ArgumentList $applicationArguments -Environment $applicationEnvironment -WindowStyle Hidden -PassThru
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
  if (-not $KeepRunning) {
    foreach ($temporaryRoot in @($profile, $claudeConfig)) {
      $resolved = [IO.Path]::GetFullPath($temporaryRoot)
      if (-not $resolved.StartsWith("$buildRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝清理 build 目录外的打包回归临时文件：$resolved"
      }
      if (Test-Path -LiteralPath $resolved) {
        Remove-TemporaryRoot $resolved
      }
    }
  }
}
