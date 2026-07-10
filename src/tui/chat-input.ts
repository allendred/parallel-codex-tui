export interface ChatInputUpdate {
  value: string;
  cursor: number;
  submit: string | null;
  exit: boolean;
}

export function applyChatInputChunk(currentValue: string, chunk: string, currentCursor?: number): ChatInputUpdate {
  let chars = Array.from(currentValue);
  let cursor = clampCursor(currentCursor ?? chars.length, chars.length);
  if (chunk === "\x03") {
    return {
      value: currentValue,
      cursor,
      submit: null,
      exit: true
    };
  }

  let submit: string | null = null;
  for (const match of chunk.matchAll(/\x1b\[M[\s\S]{3}|\x1b\[[0-?]*[ -/]*[@-~]|\x1bO.|\x1b.|./gsu)) {
    const token = match[0];
    if (token === "\x1b[D" || token === "\x1bOD") {
      cursor = Math.max(0, cursor - 1);
    } else if (token === "\x1b[C" || token === "\x1bOC") {
      cursor = Math.min(chars.length, cursor + 1);
    } else if (token === "\x1b[H" || token === "\x1b[1~" || token === "\x1bOH" || token === "\x01") {
      cursor = 0;
    } else if (token === "\x1b[F" || token === "\x1b[4~" || token === "\x1bOF" || token === "\x05") {
      cursor = chars.length;
    } else if (token === "\x1b[3~") {
      if (cursor < chars.length) {
        chars.splice(cursor, 1);
      }
    } else if (token.startsWith("\x1b")) {
      continue;
    } else if (token === "\r" || token === "\n") {
      submit = chars.join("");
      chars = [];
      cursor = 0;
    } else if (token === "\x7f" || token === "\b") {
      if (cursor > 0) {
        chars.splice(cursor - 1, 1);
        cursor -= 1;
      }
    } else if (token >= " ") {
      chars.splice(cursor, 0, token);
      cursor += 1;
    }
  }

  return {
    value: chars.join(""),
    cursor,
    submit,
    exit: false
  };
}

function clampCursor(cursor: number, length: number): number {
  return Math.min(length, Math.max(0, Math.trunc(cursor)));
}
