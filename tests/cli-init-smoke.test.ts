import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CLI init", () => {
  it("writes a safe local config and exits without starting the TUI", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-init-"));

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--init"],
      {
        cwd: process.cwd(),
        timeout: 5000
      }
    );

    const configPath = join(appRoot, ".parallel-codex", "config.toml");
    const config = await readFile(configPath, "utf8");

    expect(stderr).toBe("");
    expect(stdout).toContain(`Wrote ${configPath}`);
    expect(config).toContain("[router]");
    expect(config).toContain("[workers.codex]");
    expect(config).toContain('fallback = "new"');
    expect(config).not.toContain("danger-full-access");
    expect(config).not.toContain("bypassPermissions");
  });

  it("does not overwrite an existing local config", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-init-existing-"));
    const configPath = join(appRoot, ".parallel-codex", "config.toml");
    const existingConfig = "[router]\ndefaultMode = \"simple\"\n";

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(configPath, existingConfig, "utf8");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--init"],
      {
        cwd: process.cwd(),
        timeout: 5000
      }
    );

    await expect(readFile(configPath, "utf8")).resolves.toBe(existingConfig);
    expect(stderr).toBe("");
    expect(stdout).toContain(`Config already exists: ${configPath}`);
  });
});
