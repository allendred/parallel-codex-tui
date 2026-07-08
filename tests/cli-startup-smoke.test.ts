import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CLI startup", () => {
  it("prints a friendly error for invalid config without a stack trace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-startup-invalid-config-"));
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(join(appRoot, ".parallel-codex", "config.toml"), '[router]\ndefaultMode = "not-real"\n', "utf8");

    let stderr = "";
    await expect(
      execFileAsync(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot], {
        cwd: process.cwd(),
        timeout: 5000
      })
        .catch((error) => {
          stderr = String((error as { stderr?: string }).stderr ?? "");
          throw error;
        })
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Config error:")
    });

    expect(stderr).toContain("Run parallel-codex-tui --doctor for details.");
    expect(stderr).not.toContain("ZodError");
    expect(stderr).not.toContain("at ");
  });

  it("does not label workspace startup errors as config errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-startup-workspace-error-"));
    const appRoot = join(root, "app");
    const workspaceFile = join(root, "not-a-directory");
    await mkdir(appRoot, { recursive: true });
    await writeFile(workspaceFile, "not a directory", "utf8");

    let stderr = "";
    await expect(
      execFileAsync(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspaceFile], {
        cwd: process.cwd(),
        timeout: 5000
      })
        .catch((error) => {
          stderr = String((error as { stderr?: string }).stderr ?? "");
          throw error;
        })
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Startup error:")
    });

    expect(stderr).not.toContain("Config error:");
    expect(stderr).not.toContain("at ");
  });

  it("rejects missing explicit task sessions before starting the TUI", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-startup-missing-task-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-startup-missing-task-workspace-"));

    let stderr = "";
    await expect(
      execFileAsync(
        process.execPath,
        [
          "./node_modules/.bin/tsx",
          "src/cli.tsx",
          "--app-root",
          appRoot,
          "--workspace",
          workspace,
          "--task",
          "task-20990101-000000-missing"
        ],
        {
          cwd: process.cwd(),
          timeout: 5000
        }
      )
        .catch((error) => {
          stderr = String((error as { stderr?: string }).stderr ?? "");
          throw error;
        })
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Startup error:")
    });

    expect(stderr).toContain("Task session not found in workspace");
    expect(stderr).toContain("task-20990101-000000-missing");
    expect(stderr).toContain(workspace);
    expect(stderr).not.toContain("at ");
  });
});
