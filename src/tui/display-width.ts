export function displayWidth(value: string): number {
  let width = 0;
  for (const char of Array.from(value)) {
    width += charDisplayWidth(char);
  }
  return width;
}

export function compactEndByDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (displayWidth(value) <= maxWidth) {
    return value;
  }
  if (maxWidth <= 3) {
    return takeStartByDisplayWidth(value, maxWidth);
  }
  return `${takeStartByDisplayWidth(value, maxWidth - 3)}...`;
}

export function compactTailByDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (displayWidth(value) <= maxWidth) {
    return value;
  }

  const prefix = maxWidth <= 3 ? "" : "...";
  const tailWidth = Math.max(1, maxWidth - displayWidth(prefix));
  return `${prefix}${takeEndByDisplayWidth(value, tailWidth)}`;
}

export function wrapByDisplayWidth(value: string, maxWidth: number): string[] {
  if (maxWidth <= 0) {
    return [""];
  }
  if (!value) {
    return [""];
  }
  if (displayWidth(value) <= maxWidth) {
    return [value];
  }

  const chunks: string[] = [];
  let rest = value;
  while (displayWidth(rest) > maxWidth) {
    const splitAtWidth = sliceEndIndexByDisplayWidth(rest, maxWidth);
    const hardSlice = rest.slice(0, splitAtWidth);
    const breakAt = Math.max(hardSlice.lastIndexOf(" "), hardSlice.lastIndexOf("/"));
    const breakWidth = breakAt >= 0 ? displayWidth(hardSlice.slice(0, breakAt + 1)) : 0;
    const splitAt = rest[splitAtWidth] === " "
      ? splitAtWidth
      : breakWidth > Math.floor(maxWidth * 0.3)
        ? breakAt + 1
        : splitAtWidth;
    chunks.push(rest.slice(0, splitAt).trimEnd());
    rest = rest.slice(splitAt).trimStart();
  }
  chunks.push(rest);
  return chunks;
}

function takeStartByDisplayWidth(value: string, maxWidth: number): string {
  let result = "";
  let width = 0;

  for (const char of Array.from(value)) {
    const charWidth = charDisplayWidth(char);
    if (width + charWidth > maxWidth) {
      break;
    }
    result += char;
    width += charWidth;
  }

  return result;
}

function takeEndByDisplayWidth(value: string, maxWidth: number): string {
  let result = "";
  let width = 0;
  const chars = Array.from(value);

  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index] ?? "";
    const charWidth = charDisplayWidth(char);
    if (width + charWidth > maxWidth) {
      break;
    }
    result = `${char}${result}`;
    width += charWidth;
  }

  return result;
}

function sliceEndIndexByDisplayWidth(text: string, maxWidth: number): number {
  let width = 0;
  let endIndex = 0;

  for (const char of Array.from(text)) {
    const charWidth = charDisplayWidth(char);
    if (width + charWidth > maxWidth && endIndex > 0) {
      break;
    }
    endIndex += char.length;
    width += charWidth;
    if (width >= maxWidth) {
      break;
    }
  }

  return endIndex || text.length;
}

function charDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  if (isCombiningCodePoint(codePoint)) {
    return 0;
  }
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    )
  );
}
