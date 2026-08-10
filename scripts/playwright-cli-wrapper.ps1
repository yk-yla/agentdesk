[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CliArguments
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$command = Join-Path $repoRoot "node_modules\.bin\playwright-cli.cmd"
if (-not (Test-Path -LiteralPath $command -PathType Leaf)) {
  throw "找不到项目内 playwright-cli：$command"
}

& $command @CliArguments
exit $LASTEXITCODE
