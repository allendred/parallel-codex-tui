import { describe, expect, it } from "vitest";
import { workerBuffersOutputUntilCompletion } from "../src/core/worker-output-policy.js";

describe("workerBuffersOutputUntilCompletion", () => {
  it("recognizes Claude print formats that emit only a final result", () => {
    expect(workerBuffersOutputUntilCompletion("claude", ["--print"])).toBe(true);
    expect(workerBuffersOutputUntilCompletion("claude", ["-p", "--output-format", "text"])).toBe(true);
    expect(workerBuffersOutputUntilCompletion("claude", ["--print", "--output-format=json"])).toBe(true);
  });

  it("keeps Claude stream-json under the first-output watchdog", () => {
    expect(workerBuffersOutputUntilCompletion("claude", [
      "--print",
      "--output-format",
      "stream-json"
    ])).toBe(false);
    expect(workerBuffersOutputUntilCompletion("claude", [
      "--print",
      "--output-format=stream-json"
    ])).toBe(false);
  });

  it("does not infer buffering for interactive Claude or other profiles", () => {
    expect(workerBuffersOutputUntilCompletion("claude", ["--resume", "session-id"])).toBe(false);
    expect(workerBuffersOutputUntilCompletion("codex", ["--print", "--output-format", "text"])).toBe(false);
    expect(workerBuffersOutputUntilCompletion("generic", ["--print"])).toBe(false);
  });
});
