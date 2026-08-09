import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, promises as fsPromises, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveExecutableFromPath } from "../../executablePath";

export const MAX_CLAUDE_BINARY_BYTES = 400 * 1024 * 1024;

export interface ClaudeSignatureInspection {
  status: string;
  signer: string;
  issuer: string;
  enhancedKeyUsages: string[];
  chainStatus: string[];
}

const CODE_SIGNING_OID = "1.3.6.1.5.5.7.3.3";
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function normalizePowerShellError(value: string) {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/^Exception:\s*/i, "")
    .slice(-64 * 1024);
}

export function isOfficialClaudeSignature(signature: ClaudeSignatureInspection) {
  if (signature.status !== "Valid" || signature.chainStatus.some((item) => item && item !== "Valid")) return false;
  if (!/^CN="Anthropic, PBC", O="Anthropic, PBC"(?:,|$)/i.test(signature.signer)) return false;
  return signature.enhancedKeyUsages.some((item) => item === CODE_SIGNING_OID || /代码签名|code signing/i.test(item));
}

export function managedClaudeExecutablePath() {
  const configured = process.env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured) return configured;
  return resolveExecutableFromPath("claude.exe") || path.join(homedir(), ".local", "bin", "claude.exe");
}

function normalizedSignature(output: string) {
  const signature = JSON.parse(output || "{}") as Partial<ClaudeSignatureInspection>;
  const normalized: ClaudeSignatureInspection = {
    status: typeof signature.status === "string" ? signature.status : "",
    signer: typeof signature.signer === "string" ? signature.signer : "",
    issuer: typeof signature.issuer === "string" ? signature.issuer : "",
    enhancedKeyUsages: Array.isArray(signature.enhancedKeyUsages) ? signature.enhancedKeyUsages.map(String) : [],
    chainStatus: Array.isArray(signature.chainStatus) ? signature.chainStatus.map(String) : [],
  };
  return {
    signatureValid: isOfficialClaudeSignature(normalized),
    signer: normalized.signer.slice(0, 500),
    signatureStatus: normalized.status,
    signatureIssuer: normalized.issuer.slice(0, 500),
    signatureEnhancedKeyUsages: normalized.enhancedKeyUsages,
    signatureChainStatus: normalized.chainStatus,
  };
}

function assertWindowsExecutable(executablePath: string) {
  const descriptor = openSync(executablePath, "r");
  const headerBuffer = Buffer.alloc(2);
  try { readSync(descriptor, headerBuffer, 0, 2, 0); } finally { closeSync(descriptor); }
  if (headerBuffer.toString("ascii") !== "MZ") throw new Error("下载内容不是有效的 Windows 可执行文件。");
}

function assertZipArchive(zipPath: string) {
  const descriptor = openSync(zipPath, "r");
  const headerBuffer = Buffer.alloc(4);
  let bytesRead = 0;
  try { bytesRead = readSync(descriptor, headerBuffer, 0, 4, 0); } finally { closeSync(descriptor); }
  const signature = bytesRead === 4 ? headerBuffer.readUInt32LE(0) : 0;
  if (![0x04034b50, 0x06054b50, 0x08074b50].includes(signature)) throw new Error("Claude 更新包无效或不完整。");
}

function powershellPath() {
  return resolveExecutableFromPath("pwsh.exe") || resolveExecutableFromPath("powershell.exe") || "powershell.exe";
}

function runPowerShell(script: string, args: string[], timeoutMs = 60_000) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        AGENTDESK_PS_ARG0: args[0] || "",
        AGENTDESK_PS_ARG1: args[1] || "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Claude 更新文件检查超时。"));
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(normalizePowerShellError(stderr || stdout) || "Claude 更新文件检查失败。"));
    });
  });
}

export async function inspectAndExtractClaudeZip(zipPath: string, extractedPath: string) {
  assertZipArchive(zipPath);
  const script = [
    "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = [IO.Compression.ZipFile]::OpenRead($env:AGENTDESK_PS_ARG0)",
    "try {",
    "  $files = @($zip.Entries | Where-Object { $_.Name })",
    "  if ($files.Count -ne 1) { throw 'AGENTDESK_CLAUDE_ZIP_ENTRY_COUNT_INVALID' }",
    "  $entry = $files[0]",
    "  if ([IO.Path]::GetFileName($entry.FullName) -ne 'claude.exe') { throw 'AGENTDESK_CLAUDE_ZIP_ENTRY_INVALID' }",
    `  if ($entry.Length -le 0 -or $entry.Length -gt ${MAX_CLAUDE_BINARY_BYTES}) { throw 'AGENTDESK_CLAUDE_BINARY_SIZE_INVALID' }`,
    "  [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $env:AGENTDESK_PS_ARG1, $true)",
    "} finally { $zip.Dispose() }",
  ].join("; ");
  try {
    await runPowerShell(script, [path.resolve(zipPath), path.resolve(extractedPath)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("AGENTDESK_CLAUDE_ZIP_ENTRY_COUNT_INVALID")) {
      throw new Error("Claude 更新包必须只包含一个文件。" );
    }
    if (message.includes("AGENTDESK_CLAUDE_ZIP_ENTRY_INVALID")) {
      throw new Error("Claude 更新包中缺少唯一的 claude.exe。" );
    }
    if (message.includes("AGENTDESK_CLAUDE_BINARY_SIZE_INVALID")) {
      throw new Error("Claude 更新包中的 claude.exe 大小无效。" );
    }
    if (message.includes("OpenRead") || message.includes("ZIP") || message.includes("ArgumentException")) {
      throw new Error("Claude 更新包无效或不完整。");
    }
    throw error;
  }
  return inspectClaudeExecutable(extractedPath);
}

export async function inspectClaudeExecutable(executablePath: string) {
  const resolved = path.resolve(executablePath);
  assertWindowsExecutable(resolved);
  const script = [
    "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop",
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:AGENTDESK_PS_ARG0",
    "$eku = if ($signature.SignerCertificate) { @($signature.SignerCertificate.EnhancedKeyUsageList | ForEach-Object { [string]$_.ObjectId; [string]$_.FriendlyName }) } else { @() }",
    "$chainStatus = @()",
    "if ($signature.SignerCertificate) { $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain; $chain.Build($signature.SignerCertificate) | Out-Null; $chainStatus = @($chain.ChainStatus | ForEach-Object { [string]$_.Status }) }",
    "[pscustomobject]@{ status = [string]$signature.Status; signer = [string]$signature.SignerCertificate.Subject; issuer = [string]$signature.SignerCertificate.Issuer; enhancedKeyUsages = $eku; chainStatus = $chainStatus } | ConvertTo-Json -Compress",
  ].join("; ");
  return normalizedSignature(await runPowerShell(script, [resolved]));
}

export async function replaceClaudeExecutable(extractedPath: string, targetPath: string, verify: () => Promise<string>) {
  const target = path.resolve(targetPath);
  const source = path.resolve(extractedPath);
  const backup = `${target}.agentdesk-backup`;
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  if (existsSync(backup)) await fsPromises.unlink(backup);
  let movedOld = false;
  try {
    if (existsSync(target)) {
      await fsPromises.rename(target, backup);
      movedOld = true;
    }
    await fsPromises.rename(source, target);
    return { version: await verify(), backupPath: movedOld ? backup : undefined };
  } catch (error) {
    if (existsSync(target)) await fsPromises.unlink(target).catch(() => undefined);
    if (movedOld && existsSync(backup)) await fsPromises.rename(backup, target).catch(() => undefined);
    throw error;
  }
}
