export interface NativeInputKey {
  ctrl?: boolean;
  escape?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  tab?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

export interface NativeInputUpdate {
  draft: string;
  outbound: string | null;
  exit: boolean;
}

export interface NativeInputChunkUpdate extends NativeInputUpdate {
  scrollDelta: number;
}

const NATIVE_ATTACH_DETACH = "\x1d";

export function applyNativeInputKey(currentDraft: string, input: string, key: NativeInputKey): NativeInputUpdate {
  if ((key.ctrl && input === "]") || input === NATIVE_ATTACH_DETACH) {
    return {
      draft: "",
      outbound: null,
      exit: true
    };
  }

  if (key.escape) {
    return {
      draft: currentDraft,
      outbound: "\x1b",
      exit: false
    };
  }

  if (key.return) {
    return {
      draft: "",
      outbound: "\r",
      exit: false
    };
  }

  if (key.backspace || key.delete) {
    return {
      draft: dropLastCodePoint(currentDraft),
      outbound: "\x7f",
      exit: false
    };
  }

  if (key.tab) {
    return {
      draft: `${currentDraft}\t`,
      outbound: "\t",
      exit: false
    };
  }

  if (key.ctrl && input.length === 1) {
    return {
      draft: currentDraft,
      outbound: controlLetter(input),
      exit: false
    };
  }

  const arrow = arrowSequence(key);
  if (arrow) {
    return {
      draft: currentDraft,
      outbound: arrow,
      exit: false
    };
  }

  return {
    draft: `${currentDraft}${input}`,
    outbound: input || null,
    exit: false
  };
}

export function applyNativeInputChunk(currentDraft: string, chunk: string, pageSize = 0): NativeInputChunkUpdate {
  if (chunk === NATIVE_ATTACH_DETACH) {
    return {
      draft: "",
      outbound: null,
      exit: true,
      scrollDelta: 0
    };
  }

  return {
    draft: visibleDraftAfterChunk(currentDraft, chunk),
    outbound: chunk || null,
    exit: false,
    scrollDelta: 0
  };
}

function controlLetter(input: string): string | null {
  const code = input.toLowerCase().charCodeAt(0);
  if (code < 97 || code > 122) {
    return null;
  }
  return String.fromCharCode(code - 96);
}

function visibleDraftAfterChunk(currentDraft: string, chunk: string): string {
  let draft = currentDraft;
  const visible = chunk
    .replaceAll("\x1b[200~", "")
    .replaceAll("\x1b[201~", "")
    .replace(/\x1b\[M[\s\S]{3}/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1bO./g, "");

  for (const char of visible) {
    if (char === "\r" || char === "\n") {
      draft = "";
    } else if (char === "\x7f" || char === "\b") {
      draft = dropLastCodePoint(draft);
    } else if (char >= " " && char !== "\x1b") {
      draft += char;
    }
  }
  return draft;
}

function dropLastCodePoint(value: string): string {
  return [...value].slice(0, -1).join("");
}

function arrowSequence(key: NativeInputKey): string | null {
  if (key.upArrow) {
    return "\x1b[A";
  }
  if (key.downArrow) {
    return "\x1b[B";
  }
  if (key.rightArrow) {
    return "\x1b[C";
  }
  if (key.leftArrow) {
    return "\x1b[D";
  }
  return null;
}
