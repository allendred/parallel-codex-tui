import { describe, expect, it } from "vitest";
import { applyChatInputChunk } from "../src/tui/chat-input.js";
import * as chatInputModule from "../src/tui/chat-input.js";

describe("applyChatInputChunk", () => {
  it("accumulates quick consecutive chunks without dropping characters", () => {
    let value = "";
    for (const chunk of ["做", "个", "俄罗斯", "方块", "的游戏"]) {
      value = applyChatInputChunk(value, chunk).value;
    }

    expect(value).toBe("做个俄罗斯方块的游戏");
  });

  it("submits the current value on return and clears the visible input", () => {
    expect(applyChatInputChunk("hello", "\r")).toEqual({
      value: "",
      cursor: 0,
      submit: "hello",
      exit: false
    });
  });

  it("treats ctrl-c as an outer TUI exit shortcut in chat input", () => {
    expect(applyChatInputChunk("hello", "\x03")).toEqual({
      value: "hello",
      cursor: 5,
      submit: null,
      exit: true
    });
  });

  it("handles backspace by code point", () => {
    expect(applyChatInputChunk("你好", "\x7f")).toEqual({
      value: "你",
      cursor: 1,
      submit: null,
      exit: false
    });
  });

  it("ignores mouse wheel escape sequences in chat input", () => {
    expect(applyChatInputChunk("hello", "\x1b[<64;10;5M")).toEqual({
      value: "hello",
      cursor: 5,
      submit: null,
      exit: false
    });
    expect(applyChatInputChunk("hello", "\x1b[M`*%")).toEqual({
      value: "hello",
      cursor: 5,
      submit: null,
      exit: false
    });
  });

  it("moves a Unicode cursor and inserts text in the middle", () => {
    const moved = applyChatInputChunk("你好界", "\x1b[D", 3);
    expect(moved).toEqual({ value: "你好界", cursor: 2, submit: null, exit: false });

    const inserted = applyChatInputChunk(moved.value, "世", moved.cursor);
    expect(inserted).toEqual({ value: "你好世界", cursor: 3, submit: null, exit: false });

    expect(applyChatInputChunk(inserted.value, "\x1b[C", inserted.cursor).cursor).toBe(4);
  });

  it("supports Home, End, Backspace, and Delete around the cursor", () => {
    expect(applyChatInputChunk("你好世界", "\x1b[H", 3).cursor).toBe(0);
    expect(applyChatInputChunk("你好世界", "\x01", 3).cursor).toBe(0);
    expect(applyChatInputChunk("你好世界", "\x1b[F", 1).cursor).toBe(4);
    expect(applyChatInputChunk("你好世界", "\x05", 1).cursor).toBe(4);
    expect(applyChatInputChunk("你好世界", "\x7f", 2)).toEqual({
      value: "你世界",
      cursor: 1,
      submit: null,
      exit: false
    });
    expect(applyChatInputChunk("你好世界", "\x1b[3~", 1)).toEqual({
      value: "你世界",
      cursor: 1,
      submit: null,
      exit: false
    });
  });

  it("inserts a sanitized multiline paste at the Unicode cursor without submitting", () => {
    const insertChatPaste = (
      chatInputModule as typeof chatInputModule & {
        insertChatPaste?: (value: string, paste: string, cursor: number) => ReturnType<typeof applyChatInputChunk>;
      }
    ).insertChatPaste;

    expect(insertChatPaste).toBeTypeOf("function");
    expect(insertChatPaste?.("前后", "第一行\r\n第二行\t值\x1b[31m红\x1b[0m\x00", 1)).toEqual({
      value: "前第一行\n第二行\t值红后",
      cursor: 11,
      submit: null,
      exit: false
    });
  });
});
