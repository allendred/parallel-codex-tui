import { describe, expect, it } from "vitest";
import { applyNativeInputChunk, applyNativeInputKey } from "../src/tui/native-input.js";

describe("applyNativeInputKey", () => {
  it("keeps a visible draft for printable native input", () => {
    expect(applyNativeInputKey("", "你", {})).toEqual({
      draft: "你",
      outbound: "你",
      exit: false
    });
  });

  it("clears the visible draft and sends carriage return on enter", () => {
    expect(applyNativeInputKey("hello", "", { return: true })).toEqual({
      draft: "",
      outbound: "\r",
      exit: false
    });
  });

  it("updates the visible draft and sends delete for backspace", () => {
    expect(applyNativeInputKey("你好", "", { backspace: true })).toEqual({
      draft: "你",
      outbound: "\x7f",
      exit: false
    });
  });

  it("sends arrow escape sequences without changing the visible draft", () => {
    expect(applyNativeInputKey("hello", "", { upArrow: true })).toEqual({
      draft: "hello",
      outbound: "\x1b[A",
      exit: false
    });
  });

  it("sends control letters without adding printable text to the draft", () => {
    expect(applyNativeInputKey("hello", "c", { ctrl: true })).toEqual({
      draft: "hello",
      outbound: "\x03",
      exit: false
    });
  });

  it("forwards escape but treats ctrl-right-bracket as detach", () => {
    expect(applyNativeInputKey("hello", "", { escape: true })).toEqual({
      draft: "hello",
      outbound: "\x1b",
      exit: false
    });
    expect(applyNativeInputKey("hello", "]", { ctrl: true })).toEqual({
      draft: "",
      outbound: null,
      exit: true
    });
  });
});

describe("applyNativeInputChunk", () => {
  it("passes bracketed paste and Chinese text through without dropping bytes", () => {
    const raw = "\x1b[200~做个俄罗斯方块的游戏\x1b[201~";

    expect(applyNativeInputChunk("", raw)).toEqual({
      draft: "做个俄罗斯方块的游戏",
      outbound: raw,
      exit: false,
      scrollDelta: 0
    });
  });

  it("only treats ctrl-right-bracket as detach", () => {
    expect(applyNativeInputChunk("hello", "\x1d")).toEqual({
      draft: "",
      outbound: null,
      exit: true,
      scrollDelta: 0
    });
  });

  it("forwards escape and page key sequences to the native agent", () => {
    expect(applyNativeInputChunk("hello", "\x1b")).toEqual({
      draft: "hello",
      outbound: "\x1b",
      exit: false,
      scrollDelta: 0
    });
    expect(applyNativeInputChunk("hello", "\x1b[A")).toEqual({
      draft: "hello",
      outbound: "\x1b[A",
      exit: false,
      scrollDelta: 0
    });
    expect(applyNativeInputChunk("hello", "\x1b[5~", 10)).toEqual({
      draft: "hello",
      outbound: "\x1b[5~",
      exit: false,
      scrollDelta: 0
    });
    expect(applyNativeInputChunk("hello", "\x1b[6~", 10)).toEqual({
      draft: "hello",
      outbound: "\x1b[6~",
      exit: false,
      scrollDelta: 0
    });
  });

  it("keeps legacy mouse wheel sequences out of the visible draft while forwarding them", () => {
    expect(applyNativeInputChunk("hello", "\x1b[M`*%")).toEqual({
      draft: "hello",
      outbound: "\x1b[M`*%",
      exit: false,
      scrollDelta: 0
    });
  });
});
