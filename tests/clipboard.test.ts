import { describe, expect, it } from "vitest";
import { copyTextToClipboard, normalizeClipboardText, osc52ClipboardSequence } from "../src/core/clipboard.js";

describe("clipboard", () => {
  it("removes terminal control sequences while preserving visible layout", () => {
    expect(normalizeClipboardText("\n  \x1b[31mred\x1b[0m  \r\n  diff + value\u0000\n")).toBe(
      "  red\n  diff + value"
    );
  });

  it("encodes UTF-8 text for OSC 52", () => {
    expect(osc52ClipboardSequence("复制 ok")).toBe(
      `\x1b]52;c;${Buffer.from("复制 ok", "utf8").toString("base64")}\x07`
    );
  });

  it("uses pbcopy on macOS when it is available", async () => {
    const calls: Array<{ command: string; args: string[]; text: string }> = [];
    const result = await copyTextToClipboard("visible text", {
      platform: "darwin",
      runCommand: async (command, args, text) => {
        calls.push({ command, args, text });
      }
    });

    expect(result.method).toBe("pbcopy");
    expect(calls).toEqual([{ command: "/usr/bin/pbcopy", args: [], text: "visible text" }]);
  });

  it("falls back to OSC 52 without disabling mouse tracking", async () => {
    const terminalWrites: string[] = [];
    const result = await copyTextToClipboard("wheel and copy", {
      platform: "linux",
      env: { DISPLAY: ":0" },
      runCommand: async () => {
        throw new Error("clipboard tool missing");
      },
      writeTerminal: (sequence) => terminalWrites.push(sequence)
    });

    expect(result.method).toBe("osc52");
    expect(terminalWrites).toEqual([osc52ClipboardSequence("wheel and copy")]);
    expect(terminalWrites[0]).not.toContain("?1000l");
    expect(terminalWrites[0]).not.toContain("?1002l");
  });
});
