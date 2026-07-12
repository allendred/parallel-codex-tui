import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists, writeJson, writeText } from "../src/core/file-store.js";
import { listWorkspaceChoices, prepareWorkspace, resolveWorkspaceSelection } from "../src/core/workspace.js";

describe("workspace selection", () => {
  it("creates explicit workspaces and remembers them", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-app-"));
    const workspaceRoot = join(appRoot, "projects", "new-project");

    await expect(prepareWorkspace(appRoot, workspaceRoot)).resolves.toBe(workspaceRoot);

    expect(await pathExists(workspaceRoot)).toBe(true);
    expect(await pathExists(join(workspaceRoot, ".parallel-codex"))).toBe(true);
    await expect(resolveWorkspaceSelection({ appRoot, cwd: appRoot })).resolves.toBe(workspaceRoot);
  });

  it("rejects workspace paths that are existing files", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-file-app-"));
    const workspaceFile = join(appRoot, "not-a-directory");
    await writeText(workspaceFile, "not a directory");

    await expect(prepareWorkspace(appRoot, workspaceFile)).rejects.toThrow(
      `Workspace path exists but is not a directory: ${workspaceFile}`
    );
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

  it("expands home-relative explicit workspaces", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-home-"));

    await expect(resolveWorkspaceSelection({ appRoot, cwd: appRoot, explicitWorkspace: "~/pct-game" })).resolves.toBe(
      join(homedir(), "pct-game")
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

  it("preserves every workspace remembered concurrently", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-concurrent-"));
    const workspaces = Array.from(
      { length: 12 },
      (_, index) => join(appRoot, `project-${String(index + 1).padStart(2, "0")}`)
    );

    await Promise.all(workspaces.map((workspace) => prepareWorkspace(appRoot, workspace)));

    const choices = await listWorkspaceChoices(appRoot);

    expect(new Set(choices.map((choice) => choice.path))).toEqual(new Set(workspaces));
  });

  it("serializes workspace registration across CLI processes", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-processes-"));
    const gatePath = join(appRoot, "start-gate");
    const workspaces = Array.from({ length: 4 }, (_, index) => join(appRoot, `child-project-${index + 1}`));
    const children = workspaces.map((workspace, index) => spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "tests", "fixtures", "prepare-workspace-child.ts"),
        appRoot,
        workspace,
        gatePath,
        join(appRoot, `child-ready-${index + 1}`)
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] }
    ));
    const exits = children.map(waitForSuccessfulExit);

    try {
      await waitForPaths(children.map((_, index) => join(appRoot, `child-ready-${index + 1}`)));
      await writeText(gatePath, "go\n");
      await Promise.all(exits);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
    }

    const choices = await listWorkspaceChoices(appRoot);
    expect(new Set(choices.map((choice) => choice.path))).toEqual(new Set(workspaces));
  }, 15_000);

  it("removes an abandoned workspace registry claim before updating", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-abandoned-"));
    const claimPath = join(appRoot, ".parallel-codex", ".workspace-registry-claim-abandoned.json");
    const workspace = join(appRoot, "recovered-project");
    await writeJson(claimPath, {
      version: 1,
      intent_id: "abandoned",
      pid: 2147483647,
      created_at: "2026-07-12T00:00:00.000Z",
      choosing: false,
      ticket: 1,
      process_start_token: "dead-token"
    });

    await prepareWorkspace(appRoot, workspace);

    expect(await pathExists(claimPath)).toBe(false);
    expect((await listWorkspaceChoices(appRoot)).map((choice) => choice.path)).toEqual([workspace]);
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

  it("omits remembered workspace paths that are existing files", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-list-file-"));
    const fileWorkspace = join(appRoot, "workspace-file");
    const realWorkspace = join(appRoot, "real-workspace");
    await prepareWorkspace(appRoot, realWorkspace);
    await writeText(fileWorkspace, "not a directory");
    await writeJson(join(appRoot, ".parallel-codex", "workspaces.json"), {
      version: 1,
      workspaces: [
        {
          path: fileWorkspace,
          last_used_at: "2026-07-08T12:00:00.000Z"
        },
        {
          path: realWorkspace,
          last_used_at: "2026-07-08T11:00:00.000Z"
        }
      ]
    });

    const choices = await listWorkspaceChoices(appRoot);

    expect(choices.map((choice) => choice.path)).toEqual([realWorkspace]);
    await expect(resolveWorkspaceSelection({ appRoot, cwd: appRoot })).resolves.toBe(realWorkspace);
  });

  it("keeps missing remembered workspace paths selectable so startup can create them", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-workspace-list-missing-"));
    const missingWorkspace = join(appRoot, "missing-workspace");
    await writeJson(join(appRoot, ".parallel-codex", "workspaces.json"), {
      version: 1,
      workspaces: [
        {
          path: missingWorkspace,
          last_used_at: "2026-07-08T12:00:00.000Z"
        }
      ]
    });

    const choices = await listWorkspaceChoices(appRoot);

    expect(choices).toEqual([{ path: missingWorkspace, exists: false, lastUsedAt: "2026-07-08T12:00:00.000Z" }]);
    await expect(resolveWorkspaceSelection({ appRoot, cwd: appRoot })).resolves.toBe(missingWorkspace);
  });

  it("resolves legacy relative last-workspace entries from the app root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-workspace-legacy-relative-"));
    const appRoot = join(root, "app");
    const cwd = join(root, "launcher");
    await writeText(join(appRoot, ".parallel-codex", "last-workspace"), "projects/game\n");

    const choices = await listWorkspaceChoices(appRoot);

    expect(choices.map((choice) => choice.path)).toEqual([join(appRoot, "projects", "game")]);
    await expect(resolveWorkspaceSelection({ appRoot, cwd })).resolves.toBe(join(appRoot, "projects", "game"));
  });

  it("resolves relative workspace registry entries from the app root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-workspace-registry-relative-"));
    const appRoot = join(root, "app");
    const cwd = join(root, "launcher");
    await writeJson(join(appRoot, ".parallel-codex", "workspaces.json"), {
      version: 1,
      workspaces: [
        {
          path: "projects/game",
          last_used_at: "2026-07-08T10:00:00.000Z"
        }
      ]
    });

    const choices = await listWorkspaceChoices(appRoot);

    expect(choices.map((choice) => choice.path)).toEqual([join(appRoot, "projects", "game")]);
    await expect(resolveWorkspaceSelection({ appRoot, cwd })).resolves.toBe(join(appRoot, "projects", "game"));
  });
});

async function waitForPaths(paths: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await Promise.all(paths.map(pathExists))).every(Boolean)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for workspace registration children.");
}

function waitForSuccessfulExit(child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Workspace registration child exited (${code ?? signal ?? "unknown"}): ${stderr.trim()}`));
    });
  });
}
