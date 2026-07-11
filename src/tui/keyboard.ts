export interface KeyboardKey {
  ctrl?: boolean;
  tab?: boolean;
  escape?: boolean;
  pageDown?: boolean;
  pageUp?: boolean;
}

export function isLogsShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "w") || input === "\u0017";
}

export function isAttachShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "o") || input === "\u000f";
}

export function isExitShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "c") || input === "\u0003";
}

export function isNewTaskShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "n") || input === "\u000e";
}

export function isWorkspaceShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "p") || input === "\u0010";
}

export function isRouterDiagnosticsShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "g") || input === "\u0007";
}

export function isWorkerOverviewShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "b") || input === "\u0002";
}

export function isTaskSessionsShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "t") || input === "\u0014";
}

export function isTaskResultShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "d") || input === "\u0004";
}

export function isWorkerSearchShortcut(input: string, key: KeyboardKey): boolean {
  return (key.ctrl === true && input.toLowerCase() === "f") || input === "\u0006";
}

export function workerLogJumpKind(input: string): "error" | "diff" | null {
  if (input === "e" || input === "E") {
    return "error";
  }
  if (input === "d" || input === "D") {
    return "diff";
  }
  return null;
}

export function scrollDelta(input: string, key: KeyboardKey, pageSize: number): number {
  if (key.pageUp || (key.ctrl === true && input.toLowerCase() === "u")) {
    return pageSize;
  }
  if (key.pageDown || (key.ctrl === true && input.toLowerCase() === "d")) {
    return -pageSize;
  }
  return 0;
}

export function rawPageScrollDelta(input: string, pageSize: number): number {
  const size = Math.max(1, pageSize);
  let delta = 0;
  for (const match of input.matchAll(/\x1b\[(5|6)~/g)) {
    delta += match[1] === "5" ? size : -size;
  }
  return delta;
}

export function rawHistoryDelta(input: string): number {
  let delta = 0;
  for (const match of input.matchAll(/\x1b(?:O([AB])|\[[0-9;?]*([AB]))/g)) {
    const direction = match[1] ?? match[2];
    delta += direction === "A" ? 1 : -1;
  }
  return delta;
}

export function mouseScrollDelta(input: string, linesPerWheel = 3): number {
  let delta = 0;

  for (const match of input.matchAll(/\x1b\[<(\d+);\d+;\d+[mM]/g)) {
    delta += wheelButtonDelta(Number(match[1]), linesPerWheel);
  }

  for (const match of input.matchAll(/\x1b\[M([\s\S])[\s\S]{2}/g)) {
    delta += wheelButtonDelta(match[1].charCodeAt(0) - 32, linesPerWheel);
  }

  return delta;
}

function wheelButtonDelta(button: number, linesPerWheel: number): number {
  const wheel = button & 0b11;
  if (button >= 64 && wheel === 0) {
    return linesPerWheel;
  }
  if (button >= 64 && wheel === 1) {
    return -linesPerWheel;
  }
  return 0;
}
