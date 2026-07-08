import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists } from "../src/core/file-store.js";
import { listWorkspaceChoices, prepareWorkspace, resolveWorkspaceSelection } from "../src/core/workspace.js";

describe("workspace selection", () => {
  it("creates explicit workspaces and remembers them", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-app-"));
    const workspaceRoot = join(appRoot, "projects", "new-project");

    await expect(prepareWorkspace(appRoot, workspaceRoot)).resolves.toBe(workspaceRoot);

    expect(await pathExists(workspaceRoot)).toBe(true);
    await expect(resolveWorkspaceSelection({ appRoot, cwd: appRoot })).resolves.toBe(workspaceRoot);
  });

  it("uses cwd when no explicit or remembered workspace exists", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-empty-"));

    await expect(resolveWorkspaceSelection({ appRoot, cwd: appRoot })).resolves.toBe(appRoot);
  });

  it("resolves relative explicit workspaces from the current directory", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-relative-"));

    await expect(resolveWorkspaceSelection({ appRoot, cwd: appRoot, explicitWorkspace: "game" })).resolves.toBe(
      join(appRoot, "game")
    );
  });

  it("keeps a recent workspace list with newest projects first", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-list-"));
    const first = join(appRoot, "first-project");
    const second = join(appRoot, "second-project");

    await prepareWorkspace(appRoot, first);
    await prepareWorkspace(appRoot, second);
    await prepareWorkspace(appRoot, first);

    const choices = await listWorkspaceChoices(appRoot);

    expect(choices.map((choice) => choice.path)).toEqual([first, second]);
    expect(choices.map((choice) => choice.exists)).toEqual([true, true]);
  });

  it("uses the newest remembered workspace before cwd", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-existing-"));
    const newest = join(appRoot, "newest-project");
    const existing = join(appRoot, "existing-project");

    await prepareWorkspace(appRoot, existing);
    await prepareWorkspace(appRoot, newest);

    await expect(resolveWorkspaceSelection({ appRoot, cwd: appRoot })).resolves.toBe(newest);

    const choices = await listWorkspaceChoices(appRoot);

    expect(choices[0]).toMatchObject({ path: newest, exists: true });
    expect(choices[1]).toMatchObject({ path: existing, exists: true });
  });
});
