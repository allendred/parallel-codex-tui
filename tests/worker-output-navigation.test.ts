import { describe, expect, it } from "vitest";
import type { WorkerOutputLineKind } from "../src/tui/WorkerOutputView.js";
import * as outputModule from "../src/tui/WorkerOutputView.js";

describe("worker output navigation", () => {
  it("maps rendered search, error, and Diff lines to offsets from the bottom", () => {
    const navigationTargets = (
      outputModule as typeof outputModule & {
        workerOutputNavigationTargets?: (
          lines: Array<{ kind: WorkerOutputLineKind; text: string }>,
          height: number,
          query?: string
        ) => {
          searchOffsets: number[];
          searchLineIndexes: number[];
          errorOffsets: number[];
          diffOffsets: number[];
        };
      }
    ).workerOutputNavigationTargets;

    expect(navigationTargets).toBeTypeOf("function");
    expect(navigationTargets?.([
      { kind: "content", text: "旧的中文目标" },
      { kind: "error", text: "ERROR: build failed" },
      { kind: "diff-file", text: "src/router.ts  +2 -1" },
      { kind: "diff-context", text: "  10   const mode = old" },
      { kind: "content", text: "新的中文目标" },
      { kind: "diff-hunk", text: "@@ -10 +10 @@" },
      { kind: "success", text: "done" }
    ], 3, "中文目标")).toEqual({
      searchOffsets: [2, 4],
      searchLineIndexes: [4, 0],
      errorOffsets: [4],
      diffOffsets: [1, 4]
    });
  });

  it("matches case-insensitively and ignores an empty query", () => {
    const navigationTargets = (
      outputModule as typeof outputModule & {
        workerOutputNavigationTargets?: (
          lines: Array<{ kind: WorkerOutputLineKind; text: string }>,
          height: number,
          query?: string
        ) => { searchOffsets: number[] };
      }
    ).workerOutputNavigationTargets;
    const lines = [
      { kind: "content" as const, text: "Router Timeout" },
      { kind: "content" as const, text: "ready" }
    ];

    expect(navigationTargets?.(lines, 2, "router timeout").searchOffsets).toEqual([0]);
    expect(navigationTargets?.(lines, 2, "  ").searchOffsets).toEqual([]);
  });
});
