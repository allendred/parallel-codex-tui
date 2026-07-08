import { describe, expect, it } from "vitest";
import { detectNativeSessionId, detectResumeSessionId } from "../src/workers/native-session-detection.js";

describe("native session detection", () => {
  it("detects labeled native session ids from worker output", () => {
    expect(detectNativeSessionId("session id: native-123")).toBe("native-123");
    expect(detectNativeSessionId("session_id = abc.12345")).toBe("abc.12345");
  });

  it("detects resume command hints from worker output", () => {
    const sessionId = "019f1b9b-768b-7753-9c3b-33b17f25bc6b";

    expect(detectNativeSessionId(`To continue, run: codex resume ${sessionId}`)).toBe(sessionId);
    expect(detectResumeSessionId(`To continue, run: codex resume ${sessionId}`)).toBe(sessionId);
  });

  it("ignores ordinary resume wording", () => {
    expect(detectNativeSessionId("I will resume work after reading the files.")).toBeNull();
    expect(detectResumeSessionId("I will resume work after reading the files.")).toBeNull();
  });
});
