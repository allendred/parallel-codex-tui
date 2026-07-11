import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createRawInputDecoder } from "../src/tui/raw-input-decoder.js";
import * as rawInputModule from "../src/tui/raw-input-decoder.js";

describe("createRawInputDecoder", () => {
  it("preserves UTF-8 characters split across raw terminal chunks", () => {
    const decoder = createRawInputDecoder();
    const input = "做个俄罗斯方块的游戏";
    let decoded = "";

    for (const byte of Buffer.from(input, "utf8")) {
      decoded += decoder.write(Buffer.from([byte]));
    }
    decoded += decoder.end();

    expect(decoded).toBe(input);
  });

  it("preserves mixed escape sequences and split UTF-8 text", () => {
    const decoder = createRawInputDecoder();
    const input = "\x1b[200~设置速度\x1b[201~\r";
    const bytes = Buffer.from(input, "utf8");
    const chunks = [
      bytes.subarray(0, 5),
      bytes.subarray(5, 7),
      bytes.subarray(7, 10),
      bytes.subarray(10)
    ];

    const decoded = chunks.map((chunk) => decoder.write(chunk)).join("") + decoder.end();

    expect(decoded).toBe(input);
  });

  it("tokenizes coalesced control keys, Unicode text, and ANSI sequences in order", () => {
    const tokenizeRawInput = (
      rawInputModule as typeof rawInputModule & {
        tokenizeRawInput?: (input: string) => string[];
      }
    ).tokenizeRawInput;

    expect(tokenizeRawInput).toBeTypeOf("function");
    expect(tokenizeRawInput?.("\x06不存在")).toEqual(["\x06", "不", "存", "在"]);
    expect(tokenizeRawInput?.("dd\x1b\x03")).toEqual(["d", "d", "\x1b", "\x03"]);
    expect(tokenizeRawInput?.("\x1b[A\x1b[<64;10;5M")).toEqual(["\x1b[A", "\x1b[<64;10;5M"]);
  });
});
