import { describe, expect, it } from "vitest";
import { nextScrollOffset, selectViewportLines } from "../src/tui/scrolling.js";

describe("scrolling", () => {
  it("selects log lines from the bottom by default", () => {
    const text = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(selectViewportLines(text, 3, 0)).toEqual({
      lines: ["line 8", "line 9", "line 10"],
      clampedOffset: 0,
      maxOffset: 7
    });
  });

  it("uses an offset from the bottom when viewing older log lines", () => {
    const text = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(selectViewportLines(text, 3, 2)).toEqual({
      lines: ["line 6", "line 7", "line 8"],
      clampedOffset: 2,
      maxOffset: 7
    });
  });

  it("clamps scroll offsets to the available history", () => {
    expect(nextScrollOffset(2, 10, 7)).toBe(7);
    expect(nextScrollOffset(2, -10, 7)).toBe(0);
  });
});
