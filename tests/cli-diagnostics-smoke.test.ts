import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists } from "../src/core/file-store.js";

describe("CLI diagnostics export", () => {
  it("creates a sanitized bundle without entering the interactive TUI", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-diagnostics-"));
    const appRoot = join(root, "app");
    const workspace = join(root, "workspace");
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[pairing]",
        'main = "mock"',
        'judge = "mock"',
        'actor = "mock"',
        'critic = "mock"',
        ""
      ].join("\n")
    );

    const result = await runCli([
      "--app-root",
      appRoot,
      "--workspace",
      workspace,
      "--diagnostics"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^Diagnostics exported: .+\n$/);
    const destination = result.stdout.trim().slice("Diagnostics exported: ".length);
    expect(destination).toContain(join(workspace, ".parallel-codex", "diagnostics"));
    expect(await pathExists(join(destination, "manifest.json"))).toBe(true);
    expect(await pathExists(join(destination, "doctor.txt"))).toBe(true);
    expect(JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"))).toMatchObject({
      format: "parallel-codex-diagnostics-v1",
      redaction: { enabled: true }
    });
  }, 15_000);
});

function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", ...args],
      { cwd: process.cwd(), timeout: 12_000 },
      (error, stdout, stderr) => {
        if (error && !("code" in error)) {
          reject(error);
          return;
        }
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr
        });
      }
    );
  });
}
