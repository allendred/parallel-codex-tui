import { describe, expect, it } from "vitest";
import { version } from "../src/version.js";

describe("version", () => {
  it("exposes the package version used by the CLI", () => {
    expect(version).toBe("0.4.3");
  });
});
