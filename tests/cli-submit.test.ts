import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { resolveSubmitRequest } from "../src/cli-submit.js";

describe("resolveSubmitRequest", () => {
  it("normalizes direct request text", async () => {
    await expect(resolveSubmitRequest("  build a game  ")).resolves.toBe("build a game");
  });

  it("reads bounded Unicode and multiline text from piped stdin", async () => {
    const input = Readable.from([Buffer.from("实现"), "\n俄罗斯方块\n"]);
    await expect(resolveSubmitRequest("-", input)).resolves.toBe("实现\n俄罗斯方块");
  });

  it("rejects terminal, empty, and oversized stdin without echoing content", async () => {
    const terminal = Readable.from([]) as Readable & { isTTY?: boolean };
    terminal.isTTY = true;
    await expect(resolveSubmitRequest("-", terminal)).rejects.toThrow("requires piped stdin");
    await expect(resolveSubmitRequest("-", Readable.from(["  \n"]))).rejects.toThrow("cannot be empty");
    await expect(resolveSubmitRequest("-", Readable.from(["private-over-limit"]), 4))
      .rejects.toThrow("exceeds 4 bytes");
  });
});
