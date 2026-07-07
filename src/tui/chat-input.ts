export interface ChatInputUpdate {
  value: string;
  submit: string | null;
  exit: boolean;
}

export function applyChatInputChunk(currentValue: string, chunk: string): ChatInputUpdate {
  if (chunk === "\x03") {
    return {
      value: currentValue,
      submit: null,
      exit: true
    };
  }

  let value = currentValue;
  let submit: string | null = null;
  const visible = chunk
    .replaceAll("\x1b[200~", "")
    .replaceAll("\x1b[201~", "")
    .replace(/\x1b\[M[\s\S]{3}/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1bO./g, "");

  for (const char of visible) {
    if (char === "\r" || char === "\n") {
      submit = value;
      value = "";
    } else if (char === "\x7f" || char === "\b") {
      value = dropLastCodePoint(value);
    } else if (char >= " " && char !== "\x1b") {
      value += char;
    }
  }

  return {
    value,
    submit,
    exit: false
  };
}

function dropLastCodePoint(value: string): string {
  return [...value].slice(0, -1).join("");
}
