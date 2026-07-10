const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const MIN_BUFFERED_START_PREFIX = 4;

export interface ChatPasteEvent {
  kind: "input" | "paste";
  text: string;
}

export interface ChatPasteDecodeResult {
  intercepted: boolean;
  events: ChatPasteEvent[];
}

export interface ChatPasteDecoder {
  write(chunk: string): ChatPasteDecodeResult;
  reset(): void;
}

export function createChatPasteDecoder(): ChatPasteDecoder {
  let startPrefix = "";
  let pasteText: string | null = null;
  let endPrefix = "";

  return {
    write(chunk) {
      const hadStartPrefix = startPrefix.length > 0;
      let data = `${startPrefix}${chunk}`;
      startPrefix = "";
      const events: ChatPasteEvent[] = [];
      let intercepted = hadStartPrefix || pasteText !== null;

      while (data) {
        if (pasteText !== null) {
          data = `${endPrefix}${data}`;
          endPrefix = "";
          const endIndex = data.indexOf(BRACKETED_PASTE_END);
          if (endIndex < 0) {
            const keep = suffixPrefixLength(data, BRACKETED_PASTE_END);
            pasteText += data.slice(0, data.length - keep);
            endPrefix = data.slice(data.length - keep);
            return { intercepted: true, events };
          }

          pasteText += data.slice(0, endIndex);
          events.push({ kind: "paste", text: pasteText });
          pasteText = null;
          data = data.slice(endIndex + BRACKETED_PASTE_END.length);
          intercepted = true;
          continue;
        }

        const startIndex = data.indexOf(BRACKETED_PASTE_START);
        if (startIndex >= 0) {
          intercepted = true;
          if (startIndex > 0) {
            events.push({ kind: "input", text: data.slice(0, startIndex) });
          }
          pasteText = "";
          data = data.slice(startIndex + BRACKETED_PASTE_START.length);
          continue;
        }

        const keep = suffixPrefixLength(data, BRACKETED_PASTE_START);
        if (keep >= MIN_BUFFERED_START_PREFIX) {
          intercepted = true;
          const input = data.slice(0, data.length - keep);
          if (input) {
            events.push({ kind: "input", text: input });
          }
          startPrefix = data.slice(data.length - keep);
          return { intercepted, events };
        }

        if (intercepted) {
          events.push({ kind: "input", text: data });
          return { intercepted, events };
        }
        return { intercepted: false, events: [] };
      }

      return { intercepted, events };
    },
    reset() {
      startPrefix = "";
      pasteText = null;
      endPrefix = "";
    }
  };
}

function suffixPrefixLength(value: string, marker: string): number {
  const limit = Math.min(value.length, marker.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) {
      return length;
    }
  }
  return 0;
}
