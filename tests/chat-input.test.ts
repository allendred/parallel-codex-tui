import { describe, expect, it } from "vitest";
import { applyChatInputChunk } from "../src/tui/chat-input.js";

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
      submit: "hello",
      exit: false
    });
  });

  it("treats ctrl-c as an outer TUI exit shortcut in chat input", () => {
    expect(applyChatInputChunk("hello", "\x03")).toEqual({
      value: "hello",
      submit: null,
      exit: true
    });
  });

  it("handles backspace by code point", () => {
    expect(applyChatInputChunk("你好", "\x7f")).toEqual({
      value: "你",
      submit: null,
      exit: false
    });
  });

  it("ignores mouse wheel escape sequences in chat input", () => {
    expect(applyChatInputChunk("hello", "\x1b[<64;10;5M")).toEqual({
      value: "hello",
      submit: null,
      exit: false
    });
    expect(applyChatInputChunk("hello", "\x1b[M`*%")).toEqual({
      value: "hello",
      submit: null,
      exit: false
    });
  });
});
