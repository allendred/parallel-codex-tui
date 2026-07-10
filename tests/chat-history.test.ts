import { describe, expect, it } from "vitest";
import { chatRequestHistory, navigateChatDraftHistory, type ChatDraftHistoryState } from "../src/tui/chat-history.js";

const idleState = (): ChatDraftHistoryState => ({
  offset: 0,
  draft: { value: "", cursor: 0 }
});

describe("navigateChatDraftHistory", () => {
  it("builds recall history from user requests without system responses", () => {
    expect(chatRequestHistory([
      { from: "user", text: "第一条" },
      { from: "system", text: "处理完成" },
      { from: "user", text: "第二条" }
    ])).toEqual(["第一条", "第二条"]);
  });

  it("recalls newer requests first and clamps at the oldest request", () => {
    const history = ["第一条", "第二条", "第三条"];
    const current = { value: "未发送", cursor: 2 };

    const latest = navigateChatDraftHistory(history, current, idleState(), 1);
    expect(latest).toMatchObject({ value: "第三条", cursor: 3, state: { offset: 1 } });

    const older = navigateChatDraftHistory(history, latest, latest.state, 1);
    expect(older).toMatchObject({ value: "第二条", cursor: 3, state: { offset: 2 } });

    const oldest = navigateChatDraftHistory(history, older, older.state, 99);
    expect(oldest).toMatchObject({ value: "第一条", cursor: 3, state: { offset: 3 } });

    expect(navigateChatDraftHistory(history, oldest, oldest.state, 1)).toEqual(oldest);
  });

  it("restores the exact unsent draft and Unicode cursor after navigating forward", () => {
    const history = ["旧请求", "新请求"];
    const draft = { value: "草稿内容", cursor: 2 };
    const recalled = navigateChatDraftHistory(history, draft, idleState(), 1);
    const restored = navigateChatDraftHistory(history, recalled, recalled.state, -1);

    expect(restored).toEqual({
      value: "草稿内容",
      cursor: 2,
      state: {
        offset: 0,
        draft
      }
    });
  });

  it("leaves the current draft unchanged when there is nowhere to navigate", () => {
    const current = { value: "当前草稿", cursor: 1 };

    expect(navigateChatDraftHistory([], current, idleState(), 1)).toEqual({
      ...current,
      state: idleState()
    });
    expect(navigateChatDraftHistory(["历史"], current, idleState(), -1)).toEqual({
      ...current,
      state: idleState()
    });
  });
});
