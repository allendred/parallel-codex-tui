import type { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

export async function resizeAndWaitForFreshScreenText(input: {
  child: { resize: (cols: number, rows: number) => void };
  screen: NativeTerminalScreen;
  screenWrites: () => Promise<void>;
  revision: () => number;
  cols: number;
  rows: number;
  text: string;
  timeoutMs?: number;
}): Promise<void> {
  const previousRevision = input.revision();
  const deadline = Date.now() + (input.timeoutMs ?? 1200);
  input.child.resize(input.cols, input.rows);
  input.screen.resize(input.cols, input.rows);

  while (Date.now() <= deadline) {
    await input.screenWrites();
    if (input.revision() > previousRevision && input.screen.snapshot().includes(input.text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for fresh resize output: ${input.text}\nSnapshot:\n${input.screen.snapshot()}`);
}
