import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists, writeJson, writeText } from "../src/core/file-store.js";
import { reconcileWorkspaceCommitIntents } from "../src/core/workspace-commit-recovery.js";

describe("reconcileWorkspaceCommitIntents", () => {
  it("removes current and legacy pending evidence after a matching integrated checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-workspace-intent-clean-"));
    const currentWave = waveDir(root, "task-current", "0001", 1);
    const legacyWave = waveDir(root, "task-legacy", "0002", 3);
    const current = commitEvidence("committing", "0001", 1, "commit-current");
    const legacy = commitEvidence("committing", "0002", 3);
    await writeJson(join(currentWave, "integration.pending.json"), current);
    await writeJson(join(currentWave, "integration.json"), { ...current, state: "integrated" });
    await writeJson(join(legacyWave, "integration.pending.json"), legacy);
    await writeJson(join(legacyWave, "integration.json"), {
      ...legacy,
      state: "integrated",
      commit_id: "commit-added-after-legacy-intent"
    });

    await expect(reconcileWorkspaceCommitIntents(root, ".parallel-codex")).resolves.toEqual({
      cleaned: 2,
      preserved: 0
    });
    expect(await pathExists(join(currentWave, "integration.pending.json"))).toBe(false);
    expect(await pathExists(join(legacyWave, "integration.pending.json"))).toBe(false);
  });

  it("preserves conflicting, corrupt, and incomplete commit evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-workspace-intent-preserve-"));
    const conflictWave = waveDir(root, "task-conflict", "0001", 1);
    const corruptWave = waveDir(root, "task-corrupt", "0001", 2);
    const incompleteWave = waveDir(root, "task-incomplete", "0001", 3);
    const conflict = commitEvidence("committing", "0001", 1, "commit-left");
    await writeJson(join(conflictWave, "integration.pending.json"), conflict);
    await writeJson(join(conflictWave, "integration.json"), {
      ...conflict,
      state: "integrated",
      commit_id: "commit-right"
    });
    await writeText(join(corruptWave, "integration.pending.json"), "{");
    await writeJson(
      join(incompleteWave, "integration.pending.json"),
      commitEvidence("committing", "0001", 3, "commit-incomplete")
    );

    await expect(reconcileWorkspaceCommitIntents(root, ".parallel-codex")).resolves.toEqual({
      cleaned: 0,
      preserved: 3
    });
    for (const wave of [conflictWave, corruptWave, incompleteWave]) {
      expect(await pathExists(join(wave, "integration.pending.json"))).toBe(true);
    }
  });

  it("ignores unrelated directories and an absent session root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-workspace-intent-ignore-"));
    await writeJson(
      join(root, ".parallel-codex", "sessions", "notes", "workspaces", "turn-0001", "wave-0001", "integration.pending.json"),
      commitEvidence("committing", "0001", 1, "commit-not-a-task")
    );
    await writeJson(
      join(root, ".parallel-codex", "sessions", "task-safe", "workspaces", "turn-current", "wave-0001", "integration.pending.json"),
      commitEvidence("committing", "0001", 1, "commit-bad-turn")
    );

    await expect(reconcileWorkspaceCommitIntents(root, ".parallel-codex")).resolves.toEqual({
      cleaned: 0,
      preserved: 0
    });
    await expect(reconcileWorkspaceCommitIntents(join(root, "missing"), ".parallel-codex")).resolves.toEqual({
      cleaned: 0,
      preserved: 0
    });
  });
});

function waveDir(root: string, taskId: string, turnId: string, wave: number): string {
  return join(
    root,
    ".parallel-codex",
    "sessions",
    taskId,
    "workspaces",
    `turn-${turnId}`,
    `wave-${String(wave).padStart(4, "0")}`
  );
}

function commitEvidence(state: "committing" | "integrated", turnId: string, wave: number, commitId?: string) {
  return {
    version: 1,
    state,
    turn_id: turnId,
    wave,
    feature_ids: [`${turnId}-feature`],
    ...(commitId ? { commit_id: commitId } : {}),
    changed_paths: [`src/wave-${wave}.ts`]
  };
}
