export type PolicyDecision = "allow" | "ask" | "deny";

export function policyForPermission(
  request: Record<string, unknown>,
): PolicyDecision {
  const kind = typeof request.kind === "string" ? request.kind : "";
  const command =
    typeof request.fullCommandText === "string" ? request.fullCommandText : "";
  const url = typeof request.url === "string" ? request.url : "";
  if (kind === "read" || kind === "write") return "allow";
  if (
    kind === "shell" &&
    !/\b(git\s+(push|commit)|curl|wget|gh\s+(pr|api|issue))\b/i.test(command)
  ) {
    return "allow";
  }
  if (
    kind === "url" ||
    kind === "mcp" ||
    /\b(git\s+(push|commit)|curl|wget|gh\s+(pr|api|issue))\b/i.test(command) ||
    url
  ) {
    return "ask";
  }
  return "deny";
}
