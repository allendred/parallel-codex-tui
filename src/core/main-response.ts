const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CODEX_HEADER_PATTERN = /^OpenAI Codex v\S+/;
const CODEX_COMMAND_PATTERN = /^\$\s+.*\bcodex(?:\s|$)/i;
const TOKEN_COUNT_PATTERN = /^[\d][\d,._ ]*$/;

/**
 * Keeps process transcripts in output.log while returning only the response that
 * belongs in chat. Codex writes its UI transcript to stderr and repeats the final
 * response on stdout, so the cleanest answer normally follows "tokens used".
 */
export function extractMainResponse(outputLog: string): string {
  const normalized = stripTerminalControls(outputLog).replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const isCodexTranscript = linesAreCodexTranscript(lines);

  if (isCodexTranscript) {
    const extracted = extractCodexFinalResponse(lines);
    if (extracted) {
      return extracted;
    }
  }

  return lines
    .filter((line) => !line.startsWith("$ "))
    .filter((line) => !line.startsWith("[mock:main]"))
    .join("\n")
    .trim();
}

export function sanitizePersistedMainMessage(from: "user" | "system", text: string): string {
  if (from !== "system" || !linesAreCodexTranscript(stripTerminalControls(text).split(/\r?\n/))) {
    return text;
  }
  return extractMainResponse(text);
}

function linesAreCodexTranscript(lines: string[]): boolean {
  return lines.some((line) => CODEX_HEADER_PATTERN.test(line.trim()))
    || lines.some((line) => CODEX_COMMAND_PATTERN.test(line.trim()));
}

function extractCodexFinalResponse(lines: string[]): string {
  const tokensUsedIndex = findLastLine(lines, (line) => line.trim().toLowerCase() === "tokens used");
  if (tokensUsedIndex >= 0) {
    const trailing = trimBlankLines(lines.slice(tokensUsedIndex + 1));
    if (trailing[0] && TOKEN_COUNT_PATTERN.test(trailing[0].trim())) {
      trailing.shift();
    }
    const stdoutResponse = trimBlankLines(trailing).join("\n").trim();
    if (stdoutResponse) {
      return stdoutResponse;
    }

    const assistantIndex = findLastLine(
      lines.slice(0, tokensUsedIndex),
      (line) => line.trim().toLowerCase() === "codex"
    );
    if (assistantIndex >= 0) {
      return trimBlankLines(lines.slice(assistantIndex + 1, tokensUsedIndex)).join("\n").trim();
    }
  }

  return "";
}

function findLastLine(lines: string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !(lines[start] ?? "").trim()) {
    start += 1;
  }
  while (end > start && !(lines[end - 1] ?? "").trim()) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function stripTerminalControls(text: string): string {
  return text
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_OSC_PATTERN, "");
}
