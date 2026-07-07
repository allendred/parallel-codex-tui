export interface ViewportSelection {
  lines: string[];
  clampedOffset: number;
  maxOffset: number;
}

export function selectViewportLines(text: string, height: number, offsetFromBottom: number): ViewportSelection {
  const lines = splitLines(text);
  const viewportHeight = Math.max(1, height);
  const maxOffset = Math.max(0, lines.length - viewportHeight);
  const clampedOffset = clamp(offsetFromBottom, 0, maxOffset);
  const end = lines.length - clampedOffset;
  const start = Math.max(0, end - viewportHeight);

  return {
    lines: lines.slice(start, end),
    clampedOffset,
    maxOffset
  };
}

export function nextScrollOffset(current: number, delta: number, maxOffset: number): number {
  return clamp(current + delta, 0, Math.max(0, maxOffset));
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.replace(/\n$/, "").split("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
