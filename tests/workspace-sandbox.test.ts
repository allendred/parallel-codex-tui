import { chmod, lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists, readTextIfExists, writeText } from "../src/core/file-store.js";
import {
  ParallelWorkspaceManager,
  WorkspaceMergeConflictError
} from "../src/orchestrator/workspace-sandbox.js";

describe("ParallelWorkspaceManager", () => {
  it("creates isolated feature workspaces without copying runtime or Git metadata", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-source-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-one");
    await writeText(join(workspaceRoot, "src", "game.ts"), "export const game = true;\n");
    await writeText(join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeText(join(taskDir, "meta.json"), "{}\n");

    const manager = new ParallelWorkspaceManager({
      workspaceRoot,
      taskDir,
      dataDir: ".parallel-codex"
    });
    const wave = await manager.prepareWave({
      turnId: "0001",
      wave: 1,
      featureIds: ["0001-ui", "0001-engine"]
    });

    const uiRoot = wave.featureDirs.get("0001-ui");
    const engineRoot = wave.featureDirs.get("0001-engine");
    expect(uiRoot).toBeTruthy();
    expect(engineRoot).toBeTruthy();
    expect(uiRoot).not.toBe(engineRoot);
    expect(await readTextIfExists(join(uiRoot ?? "", "src", "game.ts"))).toContain("game = true");
    expect(await pathExists(join(uiRoot ?? "", ".parallel-codex"))).toBe(false);
    expect(await pathExists(join(uiRoot ?? "", ".git"))).toBe(false);

    await writeText(join(uiRoot ?? "", "src", "game.ts"), "export const game = 'ui';\n");
    await writeText(join(uiRoot ?? "", ".git", "HEAD"), "feature-local-git\n");
    await writeText(join(uiRoot ?? "", ".parallel-codex", "injected.txt"), "feature runtime\n");
    await writeText(join(engineRoot ?? "", ".git", "HEAD"), "other-feature-git\n");
    await writeText(join(engineRoot ?? "", ".parallel-codex", "injected.txt"), "other runtime\n");
    expect(await readTextIfExists(join(engineRoot ?? "", "src", "game.ts"))).toContain("game = true");
    expect(await readTextIfExists(join(workspaceRoot, "src", "game.ts"))).toContain("game = true");

    await manager.integrateWave(wave);
    expect(await readTextIfExists(join(workspaceRoot, ".git", "HEAD"))).toBe("ref: refs/heads/main\n");
    expect(await pathExists(join(workspaceRoot, ".parallel-codex", "injected.txt"))).toBe(false);
  });

  it("merges independent feature edits through staging before updating the live workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-merge-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-two");
    await writeText(
      join(workspaceRoot, "src", "app.ts"),
      ["export const title = 'base';", "export const speed = 1;", "export const score = 0;", ""].join("\n")
    );
    await writeText(join(workspaceRoot, "README.md"), "base\n");

    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const wave = await manager.prepareWave({
      turnId: "0001",
      wave: 1,
      featureIds: ["0001-ui", "0001-engine"]
    });
    const uiRoot = wave.featureDirs.get("0001-ui") ?? "";
    const engineRoot = wave.featureDirs.get("0001-engine") ?? "";

    await writeText(
      join(uiRoot, "src", "app.ts"),
      ["export const title = 'Tetris';", "export const speed = 1;", "export const score = 0;", ""].join("\n")
    );
    await writeText(join(uiRoot, "src", "ui.ts"), "export const ui = true;\n");
    await writeText(
      join(engineRoot, "src", "app.ts"),
      ["export const title = 'base';", "export const speed = 2;", "export const score = 0;", ""].join("\n")
    );
    await writeText(join(engineRoot, "src", "engine.ts"), "export const engine = true;\n");

    const result = await manager.integrateWave(wave);

    const app = await readTextIfExists(join(workspaceRoot, "src", "app.ts"));
    expect(app).toContain("title = 'Tetris'");
    expect(app).toContain("speed = 2");
    expect(await pathExists(join(workspaceRoot, "src", "ui.ts"))).toBe(true);
    expect(await pathExists(join(workspaceRoot, "src", "engine.ts"))).toBe(true);
    expect(result.changedPaths).toEqual([
      "src/app.ts",
      "src/engine.ts",
      "src/ui.ts"
    ]);
  });

  it("keeps the live workspace unchanged and writes conflict evidence when features overlap", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-conflict-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-three");
    const sourcePath = join(workspaceRoot, "src", "game.ts");
    await writeText(sourcePath, "export const mode = 'base';\n");

    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const wave = await manager.prepareWave({
      turnId: "0001",
      wave: 1,
      featureIds: ["0001-ui", "0001-engine"]
    });
    await writeText(join(wave.featureDirs.get("0001-ui") ?? "", "src", "game.ts"), "export const mode = 'ui';\n");
    await writeText(join(wave.featureDirs.get("0001-engine") ?? "", "src", "game.ts"), "export const mode = 'engine';\n");

    let conflict: WorkspaceMergeConflictError | null = null;
    try {
      await manager.integrateWave(wave);
    } catch (error) {
      conflict = error as WorkspaceMergeConflictError;
    }

    expect(conflict).toBeInstanceOf(WorkspaceMergeConflictError);
    expect(conflict?.paths).toEqual(["src/game.ts"]);
    expect(await readTextIfExists(sourcePath)).toBe("export const mode = 'base';\n");
    const evidence = await readTextIfExists(join(conflict?.conflictDir ?? "", "src", "game.ts"));
    expect(evidence).toContain("<<<<<<<");
    expect(evidence).toContain("mode = 'ui'");
    expect(evidence).toContain("mode = 'engine'");
  });

  it("preserves executable files and binary content while integrating", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-binary-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-four");
    await writeText(join(workspaceRoot, "scripts", "run.sh"), "#!/bin/sh\necho base\n");
    await chmod(join(workspaceRoot, "scripts", "run.sh"), 0o755);

    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const wave = await manager.prepareWave({ turnId: "0001", wave: 1, featureIds: ["0001-cli"] });
    const featureRoot = wave.featureDirs.get("0001-cli") ?? "";
    await writeText(join(featureRoot, "scripts", "run.sh"), "#!/bin/sh\necho feature\n");
    await chmod(join(featureRoot, "scripts", "run.sh"), 0o755);
    await writeText(join(featureRoot, "asset.bin"), "\u0000\u0001feature");

    await manager.integrateWave(wave);

    expect((await lstat(join(workspaceRoot, "scripts", "run.sh"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(workspaceRoot, "asset.bin"))).toEqual(Buffer.from("\u0000\u0001feature"));
  });
});
