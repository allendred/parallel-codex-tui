import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatConfigErrorMessage } from "../src/core/config-errors.js";

describe("formatConfigErrorMessage", () => {
  it("formats root-level Zod errors with a readable config label", () => {
    const parsed = z.object({ ui: z.object({ theme: z.string() }) }).safeParse("not-an-object");

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatConfigErrorMessage(parsed.error)).toContain("config: Expected object");
    }
  });

  it("preserves ordinary error messages", () => {
    expect(formatConfigErrorMessage(new Error("plain failure"))).toBe("plain failure");
  });
});
