import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { readTextIfExists } from "../src/core/file-store.js";
import { SessionManager } from "../src/core/session-manager.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { MockWorkerAdapter } from "../src/workers/mock-adapter.js";
import type { WorkerResult, WorkerRunSpec } from "../src/workers/types.js";

class BlockingMainAdapter extends MockWorkerAdapter {
  private announceStarted: () => void = () => undefined;
  private resumeRun: () => void = () => undefined;
  readonly started = new Promise<void>((resolve) => {
    this.announceStarted = resolve;
  });
  private readonly resume = new Promise<void>((resolve) => {
    this.resumeRun = resolve;
  });

  override async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.announceStarted();
    await this.resume;
    return super.run(spec);
  }

  release(): void {
    this.resumeRun();
  }
}

class CountingMainAdapter extends MockWorkerAdapter {
  runs = 0;

  override async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.runs += 1;
    return super.run(spec);
  }
}

describe("Orchestrator Main session lease", () => {
  it("rejects a second TUI before it overwrites an active Main session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-main-lease-"));
    const config = defaultConfig(root);
    config.pairing.main = "mock";
    config.router.defaultMode = "simple";
    const firstManager = new SessionManager({ projectRoot: root, dataDir: config.dataDir });
    const secondManager = new SessionManager({ projectRoot: root, dataDir: config.dataDir });
    const firstAdapter = new BlockingMainAdapter();
    const secondAdapter = new CountingMainAdapter();
    const firstOrchestrator = new Orchestrator(config, firstManager, new Map([["mock", firstAdapter]]));
    const secondOrchestrator = new Orchestrator(config, secondManager, new Map([["mock", secondAdapter]]));
    const promptPath = join(root, config.dataDir, "sessions", "main", "main-mock", "prompt.md");
    const outputPath = join(root, config.dataDir, "sessions", "main", "main-mock", "output.log");

    const firstRun = firstOrchestrator.handleRequest({ request: "first Main request", cwd: root });
    await firstAdapter.started;

    try {
      await expect(
        secondOrchestrator.handleRequest({ request: "second Main request", cwd: root })
      ).rejects.toThrow("Main session is already running in another parallel-codex-tui process");
      expect(secondAdapter.runs).toBe(0);
      expect(await readTextIfExists(promptPath)).toContain("first Main request");
      expect(await readTextIfExists(promptPath)).not.toContain("second Main request");
    } finally {
      firstAdapter.release();
      await firstRun;
    }

    expect(await readTextIfExists(outputPath)).toContain("Mock simple response for: first Main request");
    expect(await readTextIfExists(outputPath)).not.toContain("second Main request");
  });
});
