export function userFacingErrorMessage(error: unknown, fallback: string) {
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  message = message.trim().replace(/^Error invoking remote method '[^']+':\s*/u, "");
  while (/^Error:\s*/u.test(message)) message = message.replace(/^Error:\s*/u, "");
  return message.trim() || fallback;
}
