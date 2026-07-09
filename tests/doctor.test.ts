import { describe, expect, it } from "vitest";
import { isSupportedNodeVersion } from "../src/doctor.js";

describe("isSupportedNodeVersion", () => {
  it("requires a Node.js version where node:sqlite is available without flags", () => {
    expect(isSupportedNodeVersion("22.5.1")).toBe(false);
    expect(isSupportedNodeVersion("22.12.0")).toBe(false);
    expect(isSupportedNodeVersion("22.13.0")).toBe(true);
    expect(isSupportedNodeVersion("23.0.0")).toBe(true);
  });
});
