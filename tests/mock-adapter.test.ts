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

  it("writes structured Final Judge acceptance from the prompt contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-mock-final-judge-"));
    const filesDir = join(root, "judge-mock-final-0001");
    const prompt = [
      "# Role: Judge · Final acceptance",
      'Required acceptance criterion ids: ["A-001","A-002"]',
      'Authoritative changed paths: ["src/a.ts"]'
    ].join("\n");

    await new MockWorkerAdapter().run({
      workerId: "judge-mock-final-0001",
      role: "judge",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath: join(filesDir, "prompt.md"),
      outputLogPath: join(filesDir, "output.log"),
      statusPath: join(filesDir, "status.json"),
      prompt
    });

    expect(JSON.parse(await readTextIfExists(join(filesDir, "final-acceptance.json")))).toMatchObject({
      decision: "approved",
      acceptance: [
        { criterion_id: "A-001", status: "passed" },
        { criterion_id: "A-002", status: "passed" }
      ],
      changed_paths: ["src/a.ts"]
    });
  });
});
