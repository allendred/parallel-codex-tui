import type { RuntimePreflightResult } from "./doctor.js";

export interface StartupPreflightMessage {
  from: "system";
  text: string;
}

export function startupPreflightMessages(
  preflight: RuntimePreflightResult
): StartupPreflightMessage[] {
  const issues = preflight.lines.filter(isStartupPreflightIssue);
  if (issues.length === 0) {
    return [];
  }

  const summary = issues.slice(0, 4).join(" · ");
  const remainder = issues.length > 4 ? ` · ${issues.length - 4} more` : "";
  return [{
    from: "system",
    text: `${preflight.ok ? "Startup preflight warning" : "Startup preflight needs attention"} · ${summary}${remainder} · run parallel-codex-tui --doctor before starting workers`
  }];
}

function isStartupPreflightIssue(line: string): boolean {
  return /(?:^|: )(?:warning\b|missing\b|incompatible\b|unreachable\b|invalid\b|denied\b|failed\b)/i.test(line);
}
