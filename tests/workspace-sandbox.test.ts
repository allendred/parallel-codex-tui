import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists, readTextIfExists, writeJson, writeText } from "../src/core/file-store.js";
import {
  ParallelWorkspaceManager,
  WorkspaceLiveMutationError,
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

  it("refreshes disposable feature review workspaces without merging Critic writes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-review-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-review");
    await writeText(join(workspaceRoot, "base.txt"), "base\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const wave = await manager.prepareWave({ turnId: "0001", wave: 1, featureIds: ["0001-ui"] });
    const featureRoot = wave.featureDirs.get("0001-ui") ?? "";
    await writeText(join(featureRoot, "actor.txt"), "first\n");

    const firstReview = await manager.prepareFeatureReviewWorkspace(wave, "0001-ui");
    expect(firstReview).toContain(join("reviews", "0001-ui"));
    expect(await readTextIfExists(join(firstReview, "actor.txt"))).toBe("first\n");
    await writeText(join(firstReview, "critic-only.txt"), "must be discarded\n");
    await writeText(join(featureRoot, "actor.txt"), "revised\n");

    const refreshedReview = await manager.prepareFeatureReviewWorkspace(wave, "0001-ui");
    expect(refreshedReview).toBe(firstReview);
    expect(await readTextIfExists(join(refreshedReview, "actor.txt"))).toBe("revised\n");
    expect(await pathExists(join(refreshedReview, "critic-only.txt"))).toBe(false);

    await manager.integrateWave(wave);
    expect(await readTextIfExists(join(workspaceRoot, "actor.txt"))).toBe("revised\n");
    expect(await pathExists(join(workspaceRoot, "critic-only.txt"))).toBe(false);
  });

  it("restores an unchanged wave without deleting completed feature work", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-restore-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-restore");
    await writeText(join(workspaceRoot, "base.txt"), "base\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const input = { turnId: "0001", wave: 1, featureIds: ["0001-ui", "0001-engine"] };
    const wave = await manager.prepareWave(input);
    const completedPath = join(wave.featureDirs.get("0001-engine") ?? "", "engine.txt");
    await writeText(completedPath, "completed actor output\n");

    const restored = await manager.restoreWave(input);

    expect(restored?.rootDir).toBe(wave.rootDir);
    expect(await readTextIfExists(completedPath)).toBe("completed actor output\n");
  });

  it("resumes a partially applied live commit from its durable intent", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-partial-commit-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-partial-commit");
    await writeText(join(workspaceRoot, "base.txt"), "base\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const input = { turnId: "0001", wave: 1, featureIds: ["0001-ui"] };
    const wave = await manager.prepareWave(input);
    const featureRoot = wave.featureDirs.get("0001-ui") ?? "";
    await writeText(join(featureRoot, "first.txt"), "first\n");
    await writeText(join(featureRoot, "second.txt"), "second\n");
    const staged = await manager.stageWave(wave);
    await writePendingCommit(wave, staged.changedPaths);
    await writeText(join(workspaceRoot, "first.txt"), "first\n");

    const restored = await manager.restoreWave(input);
    expect(restored).not.toBeNull();
    if (!restored) {
      throw new Error("Pending commit was not restored");
    }
    const result = await manager.commitWave(restored);

    expect(result.changedPaths).toEqual(["first.txt", "second.txt"]);
    expect(await readTextIfExists(join(workspaceRoot, "first.txt"))).toBe("first\n");
    expect(await readTextIfExists(join(workspaceRoot, "second.txt"))).toBe("second\n");
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(false);
    expect(JSON.parse(await readTextIfExists(join(wave.rootDir, "integration.json")))).toMatchObject({
      state: "integrated",
      changed_paths: ["first.txt", "second.txt"]
    });
  });

  it("promotes a fully applied live commit when only its final checkpoint was lost", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-lost-checkpoint-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-lost-checkpoint");
    await writeText(join(workspaceRoot, "base.txt"), "base\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const wave = await manager.prepareWave({ turnId: "0001", wave: 1, featureIds: ["0001-ui"] });
    const featureRoot = wave.featureDirs.get("0001-ui") ?? "";
    await writeText(join(featureRoot, "committed.txt"), "committed\n");
    const staged = await manager.stageWave(wave);
    await writePendingCommit(wave, staged.changedPaths);
    await writeText(join(workspaceRoot, "committed.txt"), "committed\n");

    const result = await manager.commitWave(wave);

    expect(result.changedPaths).toEqual(["committed.txt"]);
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(false);
    expect(JSON.parse(await readTextIfExists(join(wave.rootDir, "integration.json")))).toMatchObject({
      state: "integrated",
      changed_paths: ["committed.txt"]
    });
  });

  it("blocks pending commit recovery when the live workspace contains an external change", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-pending-external-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-pending-external");
    await writeText(join(workspaceRoot, "base.txt"), "base\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const input = { turnId: "0001", wave: 1, featureIds: ["0001-ui"] };
    const wave = await manager.prepareWave(input);
    const featureRoot = wave.featureDirs.get("0001-ui") ?? "";
    await writeText(join(featureRoot, "first.txt"), "first\n");
    await writeText(join(featureRoot, "second.txt"), "second\n");
    const staged = await manager.stageWave(wave);
    await writePendingCommit(wave, staged.changedPaths);
    await writeText(join(workspaceRoot, "first.txt"), "first\n");
    await writeText(join(workspaceRoot, "user-change.txt"), "keep me\n");

    await expect(manager.restoreWave(input)).rejects.toMatchObject({
      name: "WorkspaceLiveMutationError",
      paths: ["user-change.txt"],
      message: expect.stringContaining("commit intent was preserved")
    });
    expect(await pathExists(join(workspaceRoot, "second.txt"))).toBe(false);
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(true);
  });

  it("recovers after the live apply succeeds but final checkpoint persistence fails", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-checkpoint-failure-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-checkpoint-failure");
    await writeText(join(workspaceRoot, "base.txt"), "base\n");
    let failIntegratedCheckpoint = true;
    const manager = new ParallelWorkspaceManager(
      { workspaceRoot, taskDir, dataDir: ".parallel-codex" },
      {
        writeIntegrationCheckpoint: async (path, value) => {
          if (
            failIntegratedCheckpoint
            && value !== null
            && typeof value === "object"
            && "state" in value
            && value.state === "integrated"
          ) {
            throw new Error("integration checkpoint disk unavailable");
          }
          await writeJson(path, value);
        }
      }
    );
    const input = { turnId: "0001", wave: 1, featureIds: ["0001-ui"] };
    const wave = await manager.prepareWave(input);
    await writeText(join(wave.featureDirs.get("0001-ui") ?? "", "committed.txt"), "committed\n");
    await manager.stageWave(wave);

    await expect(manager.commitWave(wave)).rejects.toThrow("integration checkpoint disk unavailable");
    expect(await readTextIfExists(join(workspaceRoot, "committed.txt"))).toBe("committed\n");
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(true);
    expect(JSON.parse(await readTextIfExists(join(wave.rootDir, "integration.json")))).toMatchObject({
      state: "staged"
    });

    failIntegratedCheckpoint = false;
    const restarted = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const restored = await restarted.restoreWave(input);
    expect(restored).not.toBeNull();
    if (!restored) {
      throw new Error("Lost checkpoint commit was not restored");
    }
    await expect(restarted.commitWave(restored)).resolves.toEqual({ changedPaths: ["committed.txt"] });
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(false);
  });

  it("keeps a committed wave successful when only intent cleanup fails", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-intent-cleanup-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-intent-cleanup");
    await writeText(join(workspaceRoot, "base.txt"), "base\n");
    let cleanupCalls = 0;
    const manager = new ParallelWorkspaceManager(
      { workspaceRoot, taskDir, dataDir: ".parallel-codex" },
      {
        removeIntegrationIntent: async () => {
          cleanupCalls += 1;
          throw new Error("intent unlink unavailable");
        }
      }
    );
    const input = { turnId: "0001", wave: 1, featureIds: ["0001-ui"] };
    const wave = await manager.prepareWave(input);
    await writeText(join(wave.featureDirs.get("0001-ui") ?? "", "committed.txt"), "committed\n");
    await manager.stageWave(wave);

    await expect(manager.commitWave(wave)).resolves.toEqual({ changedPaths: ["committed.txt"] });
    expect(cleanupCalls).toBe(1);
    expect(await readTextIfExists(join(workspaceRoot, "committed.txt"))).toBe("committed\n");
    expect(JSON.parse(await readTextIfExists(join(wave.rootDir, "integration.json")))).toMatchObject({
      state: "integrated"
    });
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(true);

    const restarted = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    await expect(restarted.commitWave(wave)).resolves.toEqual({ changedPaths: ["committed.txt"] });
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(false);
  });

  it("finishes an owned temporary replacement left after the live target was removed", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-owned-temp-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-owned-temp");
    const targetPath = join(workspaceRoot, "replace.txt");
    await writeText(targetPath, "baseline\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const input = { turnId: "0001", wave: 1, featureIds: ["0001-ui"] };
    const wave = await manager.prepareWave(input);
    await writeText(join(wave.featureDirs.get("0001-ui") ?? "", "replace.txt"), "integrated\n");
    const staged = await manager.stageWave(wave);
    const commitId = "owned-temp-001";
    await writePendingCommit(wave, staged.changedPaths, commitId);
    const tempPath = commitTempPath(workspaceRoot, "replace.txt", commitId);
    await writeText(tempPath, "integrated\n");
    await rm(targetPath);

    const restored = await manager.restoreWave(input);
    expect(restored).not.toBeNull();
    if (!restored) {
      throw new Error("Owned replacement temp was not restored");
    }
    await manager.commitWave(restored);

    expect(await readTextIfExists(targetPath)).toBe("integrated\n");
    expect(await pathExists(tempPath)).toBe(false);
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(false);
  });

  it("blocks an owned temporary replacement whose content is not the integration snapshot", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-corrupt-temp-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-corrupt-temp");
    const targetPath = join(workspaceRoot, "replace.txt");
    await writeText(targetPath, "baseline\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const input = { turnId: "0001", wave: 1, featureIds: ["0001-ui"] };
    const wave = await manager.prepareWave(input);
    await writeText(join(wave.featureDirs.get("0001-ui") ?? "", "replace.txt"), "integrated\n");
    const staged = await manager.stageWave(wave);
    const commitId = "corrupt-temp-001";
    await writePendingCommit(wave, staged.changedPaths, commitId);
    const tempPath = commitTempPath(workspaceRoot, "replace.txt", commitId);
    await writeText(tempPath, "tampered\n");
    await rm(targetPath);

    await expect(manager.restoreWave(input)).rejects.toThrow(
      "Pending integration temp does not match the integration snapshot: replace.txt"
    );
    expect(await readTextIfExists(tempPath)).toBe("tampered\n");
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(true);
  });

  it("treats a temporary replacement from another commit as an external live path", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-foreign-temp-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-foreign-temp");
    await writeText(join(workspaceRoot, "replace.txt"), "baseline\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const input = { turnId: "0001", wave: 1, featureIds: ["0001-ui"] };
    const wave = await manager.prepareWave(input);
    await writeText(join(wave.featureDirs.get("0001-ui") ?? "", "replace.txt"), "integrated\n");
    const staged = await manager.stageWave(wave);
    await writePendingCommit(wave, staged.changedPaths, "current-commit-001");
    const foreignTemp = commitTempPath(workspaceRoot, "replace.txt", "foreign-commit-001");
    await writeText(foreignTemp, "foreign\n");

    await expect(manager.restoreWave(input)).rejects.toMatchObject({
      name: "WorkspaceLiveMutationError",
      paths: [`.replace.txt.parallel-codex-foreign-commit-001.tmp`]
    });
    expect(await readTextIfExists(foreignTemp)).toBe("foreign\n");
  });

  it("rejects a wave checkpoint after the live workspace changes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-stale-checkpoint-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-stale");
    await writeText(join(workspaceRoot, "base.txt"), "base\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const input = { turnId: "0001", wave: 1, featureIds: ["0001-ui"] };
    await manager.prepareWave(input);
    await writeText(join(workspaceRoot, "user-change.txt"), "new live work\n");

    await expect(manager.restoreWave(input)).resolves.toBeNull();
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

    const staged = await manager.stageWave(wave);

    expect(staged.changedPaths).toEqual([
      "src/app.ts",
      "src/engine.ts",
      "src/ui.ts"
    ]);
    expect(await readTextIfExists(join(workspaceRoot, "src", "app.ts"))).toContain("title = 'base'");
    expect(await pathExists(join(workspaceRoot, "src", "ui.ts"))).toBe(false);
    expect(await pathExists(join(workspaceRoot, "src", "engine.ts"))).toBe(false);
    const combined = await readTextIfExists(join(wave.integrationDir, "src", "app.ts"));
    expect(combined).toContain("title = 'Tetris'");
    expect(combined).toContain("speed = 2");

    const verificationDir = await manager.prepareVerificationWorkspace(wave);
    expect(verificationDir).toBe(wave.verificationDir);
    expect(await pathExists(join(verificationDir, "src", "ui.ts"))).toBe(true);
    await writeText(join(verificationDir, "critic-note.txt"), "must not be committed\n");

    const result = await manager.commitWave(wave);

    const app = await readTextIfExists(join(workspaceRoot, "src", "app.ts"));
    expect(app).toContain("title = 'Tetris'");
    expect(app).toContain("speed = 2");
    expect(await pathExists(join(workspaceRoot, "src", "ui.ts"))).toBe(true);
    expect(await pathExists(join(workspaceRoot, "src", "engine.ts"))).toBe(true);
    expect(await pathExists(join(workspaceRoot, "critic-note.txt"))).toBe(false);
    expect(result.changedPaths).toEqual([
      "src/app.ts",
      "src/engine.ts",
      "src/ui.ts"
    ]);
    expect(JSON.parse(await readTextIfExists(join(wave.rootDir, "integration.json")))).toMatchObject({
      state: "integrated",
      commit_id: expect.stringMatching(/^[A-Za-z0-9-]+$/),
      changed_paths: result.changedPaths
    });
    expect(await pathExists(join(wave.rootDir, "integration.pending.json"))).toBe(false);
  });

  it("refuses staging or commit after the live workspace changes outside orchestration", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-workspace-live-mutation-"));
    const taskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-live-mutation");
    await writeText(join(workspaceRoot, "base.txt"), "base\n");
    const manager = new ParallelWorkspaceManager({ workspaceRoot, taskDir, dataDir: ".parallel-codex" });
    const firstWave = await manager.prepareWave({ turnId: "0001", wave: 1, featureIds: ["0001-safe"] });
    await writeText(join(workspaceRoot, "escaped.txt"), "escaped\n");

    await expect(manager.stageWave(firstWave)).rejects.toMatchObject({
      name: "WorkspaceLiveMutationError",
      paths: ["escaped.txt"]
    } satisfies Partial<WorkspaceLiveMutationError>);

    const secondWave = await manager.prepareWave({ turnId: "0002", wave: 1, featureIds: ["0002-safe"] });
    await writeText(join(secondWave.featureDirs.get("0002-safe") ?? "", "feature.txt"), "feature\n");
    await manager.stageWave(secondWave);
    await writeText(join(workspaceRoot, "late-escape.txt"), "escaped after staging\n");

    await expect(manager.commitWave(secondWave)).rejects.toMatchObject({
      name: "WorkspaceLiveMutationError",
      paths: ["late-escape.txt"]
    } satisfies Partial<WorkspaceLiveMutationError>);
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

async function writePendingCommit(
  wave: { rootDir: string; turnId: string; wave: number; featureIds: string[] },
  changedPaths: string[],
  commitId?: string
): Promise<void> {
  await writeJson(join(wave.rootDir, "integration.pending.json"), {
    version: 1,
    state: "committing",
    turn_id: wave.turnId,
    wave: wave.wave,
    feature_ids: wave.featureIds,
    ...(commitId ? { commit_id: commitId } : {}),
    changed_paths: changedPaths
  });
}

function commitTempPath(workspaceRoot: string, path: string, commitId: string): string {
  return join(workspaceRoot, `.${path}.parallel-codex-${commitId}.tmp`);
}
