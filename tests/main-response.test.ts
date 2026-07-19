import { describe, expect, it } from "vitest";
import { extractMainResponse, sanitizePersistedMainMessage } from "../src/core/main-response.js";

const CODEX_TRANSCRIPT = [
  "$ codex exec resume session-123 --skip-git-repo-check -",
  "OpenAI Codex v0.144.4",
  "--------",
  "workdir: /tmp/project",
  "model: gpt-5.6-sol",
  "provider: custom",
  "approval: never",
  "--------",
  "user",
  "# Role: Main",
  "",
  "User request:",
  "你来监控啊",
  "",
  "codex",
  "好，我来持续监控。",
  "",
  "- 异常会立即报告",
  "- 完成后给出结果",
  "tokens used",
  "7,527",
  "好，我来持续监控。",
  "",
  "- 异常会立即报告",
  "- 完成后给出结果",
  ""
].join("\n");

describe("extractMainResponse", () => {
  it("returns only the final Codex stdout response", () => {
    expect(extractMainResponse(CODEX_TRANSCRIPT)).toBe([
      "好，我来持续监控。",
      "",
      "- 异常会立即报告",
      "- 完成后给出结果"
    ].join("\n"));
  });

  it("falls back to the last assistant block when stdout is absent", () => {
    const transcript = CODEX_TRANSCRIPT.replace(
      "tokens used\n7,527\n好，我来持续监控。\n\n- 异常会立即报告\n- 完成后给出结果\n",
      "tokens used\n7,527\n"
    );

    expect(extractMainResponse(transcript)).toContain("好，我来持续监控。");
    expect(extractMainResponse(transcript)).not.toContain("OpenAI Codex");
    expect(extractMainResponse(transcript)).not.toContain("tokens used");
  });

  it("keeps plain Claude and mock responses while removing launch lines", () => {
    expect(extractMainResponse("$ claude --print\n回答内容\n")).toBe("回答内容");
    expect(extractMainResponse("[mock:main]\nMock answer\n")).toBe("Mock answer");
  });

  it("sanitizes only persisted system messages", () => {
    expect(sanitizePersistedMainMessage("system", CODEX_TRANSCRIPT)).toBe(extractMainResponse(CODEX_TRANSCRIPT));
    expect(sanitizePersistedMainMessage("user", CODEX_TRANSCRIPT)).toBe(CODEX_TRANSCRIPT);
    expect(sanitizePersistedMainMessage("system", "讨论 codex 与 tokens used 的格式")).toBe("讨论 codex 与 tokens used 的格式");
    expect(sanitizePersistedMainMessage("system", "  保留原始空白  ")).toBe("  保留原始空白  ");
  });
});
