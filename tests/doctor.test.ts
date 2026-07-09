import { describe, expect, it } from "vitest";
import { isSupportedNodeVersion } from "../src/doctor.js";

describe("isSupportedNodeVersion", () => {
  it("requires a Node.js version where node:sqlite does not print experimental warnings", () => {
    expect(isSupportedNodeVersion("22.5.1")).toBe(false);
    expect(isSupportedNodeVersion("22.13.0")).toBe(false);
    expect(isSupportedNodeVersion("25.7.0")).toBe(false);
    expect(isSupportedNodeVersion("26.0.0")).toBe(true);
  });
});
