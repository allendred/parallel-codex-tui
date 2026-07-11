import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appendState = vi.hoisted(() => ({
  delayedCall: 0,
  failedCall: 0,
  releaseBlocked: null as (() => void) | null
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: unknown[]) => {
      const path = String(args[0]);
      const options = args[2] as { flag?: string } | undefined;
      if (path.endsWith("ordered.log") && options?.flag === "a") {
        appendState.delayedCall += 1;
        if (appendState.delayedCall === 1) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }
      if (path.endsWith("failed.log") && options?.flag === "a") {
        appendState.failedCall += 1;
        if (appendState.failedCall === 1) {
          throw new Error("injected append failure");
        }
      }
      if (path.endsWith("blocked.log") && options?.flag === "a") {
        await new Promise<void>((resolve) => {
          appendState.releaseBlocked = resolve;
        });
      }
      return (actual.writeFile as unknown as (...values: unknown[]) => Promise<void>)(...args);
    }
  };
});

import { appendJsonLine, appendText } from "../src/core/file-store.js";

describe("file store append ordering", () => {
  beforeEach(() => {
    appendState.delayedCall = 0;
    appendState.failedCall = 0;
    appendState.releaseBlocked = null;
  });

  it("serializes concurrent appends to the same path in call order", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-append-order-"));
    const path = join(root, "ordered.log");

    await Promise.all([
      appendText(path, "first\n"),
      appendJsonLine(path, { order: "second" })
    ]);

    await expect(readFile(path, "utf8")).resolves.toBe('first\n{"order":"second"}\n');
  });

  it("continues a path queue after one append fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-append-failure-"));
    const path = join(root, "failed.log");

    const first = appendText(path, "first\n");
    const second = appendText(path, "second\n");

    await expect(first).rejects.toThrow("injected append failure");
    await expect(second).resolves.toBeUndefined();
    await expect(readFile(path, "utf8")).resolves.toBe("second\n");
  });

  it("does not block appends to a different path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-append-independent-"));
    const blockedPath = join(root, "blocked.log");
    const fastPath = join(root, "fast.log");
    const blocked = appendText(blockedPath, "blocked\n");
    for (let attempt = 0; attempt < 20 && !appendState.releaseBlocked; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    try {
      const fast = appendText(fastPath, "fast\n");
      const winner = await Promise.race([
        fast.then(() => "fast"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100))
      ]);

      expect(winner).toBe("fast");
      await expect(readFile(fastPath, "utf8")).resolves.toBe("fast\n");
    } finally {
      appendState.releaseBlocked?.();
      await blocked;
    }
  });
});
