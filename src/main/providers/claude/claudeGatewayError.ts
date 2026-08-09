export type ClaudeGatewayFailureKind = "unauthorized" | "rateLimited" | "serverError" | "truncatedSse" | "timeout" | "offline" | "unknown";

export interface ClaudeGatewayFailure {
  kind: ClaudeGatewayFailureKind;
  message: string;
  retryable: boolean;
  statusCode?: number;
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) return value.map(errorText).filter(Boolean).join("\n");
  return typeof value === "string" ? value : String(value ?? "");
}

/** Keep gateway errors understandable without forwarding headers, credentials or raw response bodies. */
export function classifyClaudeGatewayFailure(value: unknown, hint?: ClaudeGatewayFailureKind): ClaudeGatewayFailure {
  const text = errorText(value);
  const lower = text.toLowerCase();
  const status = Number(lower.match(/(?:status(?: code)?|http|error)\D{0,12}(\d{3})/)?.[1] || lower.match(/\b(401|429|5\d\d)\b/)?.[1] || 0) || undefined;
  const kind: ClaudeGatewayFailureKind = status === 401 || /unauthori[sz]ed|authentication[_ ]error|invalid api key|invalid x-api-key/.test(lower)
    ? "unauthorized"
    : status === 429 || /rate[_ -]?limit|too many requests/.test(lower)
      ? "rateLimited"
      : Boolean(status && status >= 500) || /internal server error|bad gateway|service unavailable|gateway timeout/.test(lower)
        ? "serverError"
        : /unexpected end|premature close|terminated|socket hang up|econnreset|incomplete.*stream|stream.*incomplete|sse/.test(lower)
          ? "truncatedSse"
          : /etimedout|timeout|timed out|headers timeout|body timeout/.test(lower)
            ? "timeout"
            : /econnrefused|enotfound|eai_again|network is unreachable|failed to connect|fetch failed/.test(lower)
              ? "offline"
              : hint || "unknown";

  if (kind === "unauthorized") return { kind, statusCode: 401, retryable: false, message: "Claude 网关认证失败（401），请检查认证配置后重试。" };
  if (kind === "rateLimited") return { kind, statusCode: 429, retryable: true, message: "Claude 网关请求过于频繁（429），请稍后重试。" };
  if (kind === "serverError") return { kind, ...(status ? { statusCode: status } : {}), retryable: true, message: `Claude 网关服务异常${status ? `（${status}）` : ""}，请稍后重试。` };
  if (kind === "truncatedSse") return { kind, retryable: true, message: "Claude 网关流式响应不完整，当前回合已结束，请重试。" };
  if (kind === "timeout") return { kind, retryable: true, message: "连接 Claude 网关超时，当前回合已结束，请检查网络后重试。" };
  if (kind === "offline") return { kind, retryable: true, message: "无法连接 Claude 网关，请检查网络或网关地址后重试。" };
  return { kind, retryable: true, message: "Claude Code 请求失败，当前回合已结束，请重试。" };
}
