import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { writeText } from "../src/core/file-store.js";
import type { EngineName } from "../src/domain/schemas.js";
import { runLiveAgentProbes } from "../src/workers/live-probe.js";
import type { WorkerAdapter, WorkerResult, WorkerRunSpec } from "../src/workers/types.js";

describe("runLiveAgentProbes", () => {
  it("verifies fresh and resumed turns for every active real engine and cleans successful artifacts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-agent-probe-ok-"));
    const config = defaultConfig(workspace);
    const codex = new ProbeAdapter("codex");
    const claude = new ProbeAdapter("claude");

    const result = await runLiveAgentProbes(config, workspace, ["codex", "claude"], {
      registry: new Map([
        ["codex", codex],
        ["claude", claude]
      ]),
      nonce: () => "a1b2c3d4"
    });

    expect(result.ok).toBe(true);
    expect(result.lines[0]).toMatch(/^codex live probe: ok \(fresh \+ resume; session codex-se\.\.\.; /);
    expect(result.lines[1]).toMatch(/^claude live probe: ok \(fresh \+ resume; session claude-s\.\.\.; /);
    expect(codex.specs).toHaveLength(2);
    expect(claude.specs).toHaveLength(2);
    expect(codex.specs[1]?.nativeSession?.session_id).toBe("codex-session-1234");
    expect(claude.specs[1]?.nativeSession?.session_id).toBe("claude-session-1234");
    expect(await readdir(join(workspace, ".parallel-codex", "probes"))).toEqual([]);
  });

  it("preserves failed probe artifacts and reports the worker failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-agent-probe-fail-"));
    const config = defaultConfig(workspace);
    const codex = new ProbeAdapter("codex", { fail: true });

    const result = await runLiveAgentProbes(config, workspace, ["codex"], {
      registry: new Map([["codex", codex]]),
      nonce: () => "a1b2c3d4"
    });

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain("codex live probe: failed (probe failed; artifacts ");
    const entries = await readdir(join(workspace, ".parallel-codex", "probes"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\.agent-/);
  });

  it("runs only the fresh turn when native session detection is disabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-agent-probe-fresh-"));
    const config = defaultConfig(workspace);
    config.workers.codex.nativeSession.detectSessionId = false;
    const codex = new ProbeAdapter("codex");

    const result = await runLiveAgentProbes(config, workspace, ["codex"], {
      registry: new Map([["codex", codex]]),
      nonce: () => "a1b2c3d4"
    });

    expect(result.ok).toBe(true);
    expect(result.lines[0]).toContain("fresh; native resume disabled");
    expect(codex.specs).toHaveLength(1);
  });
});

class ProbeAdapter implements WorkerAdapter {
  readonly specs: WorkerRunSpec[] = [];

  constructor(
    readonly name: EngineName,
    private readonly options: { fail?: boolean } = {}
  ) {}

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.specs.push(spec);
    if (this.options.fail) {
      await writeText(spec.outputLogPath, "probe failed\n");
      return {
        workerId: spec.workerId,
        exitCode: 1,
        signal: null,
        failure: {
          phase: "probe",
          summary: "probe failed"
        }
      };
    }

    const segments = spec.prompt.match(/joined value:\s*(.+)$/m)?.[1]
      ?.split("|")
      .map((segment) => segment.trim())
      .filter(Boolean) ?? [];
    await writeText(spec.outputLogPath, `${segments.join("_")}\n`);
    await spec.onNativeSession?.(`${this.name}-session-1234`);
    return {
      workerId: spec.workerId,
      exitCode: 0,
      signal: null
    };
  }
}
