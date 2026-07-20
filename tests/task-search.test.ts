import { describe, expect, it } from "vitest";
import {
  matchTaskSearchDocument,
  parseTaskSearchQuery,
  type TaskSearchDocument
} from "../src/core/task-search.js";

const document: TaskSearchDocument = {
  task: {
    id: "task-20260720-search",
    title: "中文输入可靠性",
    cwd: "/tmp/tetris",
    mode: "complex",
    state: "done"
  },
  turns: [
    { turnId: "0001", request: "修复输入丢字" },
    { turnId: "0002", request: "增加回归测试" }
  ],
  workers: [{
    id: "actor-codex-0002-input",
    featureId: "0002-input-reliability",
    featureTitle: "Keyboard Input",
    role: "actor",
    provider: "codex",
    model: "gpt-5.6-codex",
    modelProvider: "openai",
    state: "done",
    phase: "implementation",
    summary: "Preserved trailing Chinese input"
  }],
  nativeSessions: [{ sessionId: "native-search-1", provider: "codex" }]
};

describe("task search", () => {
  it("parses quoted structured filters and plain Unicode terms", () => {
    expect(parseTaskSearchQuery('feature:"Keyboard Input" role:actor provider:codex 中文')).toEqual([
      { field: "feature", value: "keyboard input" },
      { field: "role", value: "actor" },
      { field: "provider", value: "codex" },
      { field: "any", value: "中文" }
    ]);
  });

  it("matches task, turn, feature, role, provider, model, and state evidence", () => {
    const match = matchTaskSearchDocument(
      'task:中文 turn:"回归测试" feature:keyboard role:actor provider:codex model:5.6 state:done',
      document
    );

    expect(match).toEqual({
      fields: ["task", "turn", "feature", "role", "provider", "model", "state"],
      summary: "match · task 中文输入可靠性 · turn 2 增加回归测试"
    });
  });

  it("requires every term and keeps unknown prefixes as plain text", () => {
    expect(matchTaskSearchDocument("role:critic", document)).toBeNull();
    expect(matchTaskSearchDocument("feature:keyboard missing", document)).toBeNull();
    expect(matchTaskSearchDocument("unknown:value", document)).toBeNull();
    expect(matchTaskSearchDocument("native-search-1", document)?.summary).toContain("session native-search-1");
  });
});
