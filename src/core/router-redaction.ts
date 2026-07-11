const ROUTER_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu;
const ROUTER_SECRET_ASSIGNMENT_PATTERN = /\b((?:(?:[a-z][a-z0-9]*_)*(?:api_?key|access_?token|auth_?token|token|password|passwd|secret|client_?secret))\s*(?:=|:)\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu;
const ROUTER_AUTHORIZATION_PATTERN = /\b((?:authorization\s*:\s*)?(?:bearer|basic)\s+)[^\s,;]+/giu;
const ROUTER_RAW_TOKEN_PATTERN = /\b(?:sk-[a-z0-9_-]{8,}|npm_[a-z0-9]{20,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/giu;
const ROUTER_URL_TRAILING_PUNCTUATION = /[),.;!?，。；！？、]+$/u;

export function sanitizeRouterText(value: string): string {
  return value
    .replace(ROUTER_URL_PATTERN, sanitizeRouterUrl)
    .replace(ROUTER_AUTHORIZATION_PATTERN, "$1***")
    .replace(ROUTER_SECRET_ASSIGNMENT_PATTERN, "$1***")
    .replace(ROUTER_RAW_TOKEN_PATTERN, "***");
}

function sanitizeRouterUrl(value: string): string {
  const trailing = value.match(ROUTER_URL_TRAILING_PUNCTUATION)?.[0] ?? "";
  const candidate = trailing ? value.slice(0, -trailing.length) : value;
  try {
    const parsed = new URL(candidate);
    const credentials = parsed.username || parsed.password ? "***@" : "";
    return `${parsed.protocol}//${credentials}${parsed.host}${trailing}`;
  } catch {
    const authority = candidate.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/iu);
    if (!authority) {
      return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/iu, "$1***@");
    }
    const safeAuthority = authority[2]?.includes("@")
      ? `***@${authority[2].slice(authority[2].lastIndexOf("@") + 1)}`
      : authority[2] ?? "";
    return `${authority[1]}${safeAuthority}${trailing}`;
  }
}
