import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pathExists, readJson, readTextIfExists, writeText } from "../src/core/file-store.js";
import { WorkerStatusSchema } from "../src/domain/schemas.js";

vi.mock("../src/core/process-ownership.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/process-ownership.js")>(
    "../src/core/process-ownership.js"
  );
  return {
    ...actual,
    writeWorkerProcessRecord: vi.fn(async () => {
      throw new Error("ownership disk unavailable");
    })
  };
});

import { ProcessWorkerAdapter } from "../src/workers/process-adapter.js";

describe("ProcessWorkerAdapter ownership failure", () => {
  it("does not send the prompt when process ownership cannot be recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-ownership-failure-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const promptReceivedPath = join(root, "prompt-received.txt");
    const script = [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; });",
      `process.stdin.on('end', () => { require('node:fs').writeFileSync(${JSON.stringify(promptReceivedPath)}, input); process.exit(0); });`,
      "setInterval(() => {}, 1000);"
    ].join("");

    await writeText(promptPath, "do not execute");
    await writeText(outputLogPath, "");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "actor-ownership-failure",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "do not execute",
      timeoutMs: 2000
    });

    expect(result.failure).toEqual({
      phase: "process-ownership-error",
      summary: `${process.execPath} process ownership could not be recorded: ownership disk unavailable`
    });
    expect(await pathExists(promptReceivedPath)).toBe(false);
    await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-ownership-error"
    });
    expect(await readTextIfExists(outputLogPath)).toContain(
      "Process ownership record failed: ownership disk unavailable"
    );
  });
});
