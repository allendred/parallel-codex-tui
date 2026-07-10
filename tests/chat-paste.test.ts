import { describe, expect, it } from "vitest";
import { createChatPasteDecoder } from "../src/tui/chat-paste.js";

describe("createChatPasteDecoder", () => {
  it("leaves ordinary terminal input on the normal input path", () => {
    const decoder = createChatPasteDecoder();

    expect(decoder.write("普通输入")).toEqual({
      intercepted: false,
      events: []
    });
  });

  it("collects a multiline bracketed paste without turning newlines into submit events", () => {
    const decoder = createChatPasteDecoder();

    expect(decoder.write("\x1b[200~第一行")).toEqual({ intercepted: true, events: [] });
    expect(decoder.write("\n第二行\x1b[20")).toEqual({ intercepted: true, events: [] });
    expect(decoder.write("1~")).toEqual({
      intercepted: true,
      events: [{ kind: "paste", text: "第一行\n第二行" }]
    });
  });

  it("preserves input around a complete paste and supports a split start marker", () => {
    const decoder = createChatPasteDecoder();

    expect(decoder.write("前\x1b[20")).toEqual({
      intercepted: true,
      events: [{ kind: "input", text: "前" }]
    });
    expect(decoder.write("0~中\x1b[201~后")).toEqual({
      intercepted: true,
      events: [
        { kind: "paste", text: "中" },
        { kind: "input", text: "后" }
      ]
    });
  });
});
