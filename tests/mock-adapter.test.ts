import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, readTextIfExists, writeText } from "../src/core/file-store.js";
import { WorkerStatusSchema } from "../src/domain/schemas.js";
import { MockWorkerAdapter } from "../src/workers/mock-adapter.js";

describe("MockWorkerAdapter", () => {
  it("writes judge artifacts and status", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-mock-"));
    const filesDir = join(root, "judge-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");

    await writeText(promptPath, "Judge prompt");

    const result = await new MockWorkerAdapter().run({
      workerId: "judge-mock",
      role: "judge",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "Judge prompt",
      onStatus: () => {
        throw new Error("observer failed");
      }
    });

    expect(result.exitCode).toBe(0);
    expect(await readTextIfExists(join(filesDir, "requirements.md"))).toContain("Mock requirements");

    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.state).toBe("done");
  });
});
