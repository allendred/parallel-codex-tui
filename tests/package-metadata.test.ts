import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

interface PackageJson {
  bin: Record<string, string>;
  description?: string;
  engines?: Record<string, string>;
  files?: string[];
  keywords?: string[];
  license?: string;
  private?: boolean;
  scripts?: Record<string, string>;
}

interface PackFile {
  mode?: number;
  path: string;
}

interface PackMetadata {
  files: PackFile[];
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

function parsePackJson(output: string): PackMetadata[] {
  const jsonStart = output.indexOf("[");

  if (jsonStart < 0) {
    throw new Error(`npm pack did not emit JSON: ${output}`);
  }

  return JSON.parse(output.slice(jsonStart)) as PackMetadata[];
}

describe("package metadata", () => {
  it("points the executable bin at dist/cli.js", async () => {
    const pkg = await readPackageJson();

    expect(pkg.bin["parallel-codex-tui"]).toBe("./dist/cli.js");
  });

  it("declares public open-source package metadata", async () => {
    const pkg = await readPackageJson();

    expect(pkg.private).not.toBe(true);
    expect(pkg.license).toBe("MIT");
    expect(pkg.description).toContain("parallel coding");
    expect(pkg.engines?.node).toBe(">=22.5.0");
    expect(pkg.keywords).toEqual([
      "codex",
      "claude",
      "tui",
      "parallel-coding",
      "agent-orchestration"
    ]);
    expect(pkg.files).toEqual([
      "dist/",
      "README.md",
      "LICENSE",
      ".parallel-codex/config.example.toml"
    ]);
    expect(pkg.scripts?.prepack).toBe("npm run build");
  });

  it("ships an MIT license file", async () => {
    const license = await readFile(join(process.cwd(), "LICENSE"), "utf8");

    expect(license).toContain("MIT License");
    expect(license).toContain("parallel-codex-tui contributors");
  });

  it("keeps local runtime state and private config out of the public repo", async () => {
    const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");

    expect(gitignore).toContain(".parallel-codex/config.toml");
    expect(gitignore).toContain(".parallel-codex/sessions/");
    expect(gitignore).toContain("docs/superpowers/");
  });

  it("does not track local config or internal planning artifacts", async () => {
    const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: process.cwd() });
    const trackedFiles = stdout.split("\n").filter(Boolean);

    expect(trackedFiles).not.toContain(".parallel-codex/config.toml");
    expect(trackedFiles.some((file) => file.startsWith("docs/superpowers/"))).toBe(false);
  });

  it("provides a safe example config instead of publishing local permissions", async () => {
    const example = await readFile(join(process.cwd(), ".parallel-codex", "config.example.toml"), "utf8");

    expect(example).toContain("[router]");
    expect(example).toContain("[workers.mock]");
    expect(example).not.toContain("danger-full-access");
    expect(example).not.toContain("bypassPermissions");
  });

  it("documents public installation, requirements, and local data boundaries", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("## Requirements");
    expect(readme).toContain("Node.js 22.5+");
    expect(readme).toContain("Codex CLI");
    expect(readme).toContain("Claude CLI");
    expect(readme).toContain("## Install");
    expect(readme).toContain("npm install -g parallel-codex-tui");
    expect(readme).toContain("parallel-codex-tui --init");
    expect(readme).toContain("parallel-codex-tui --doctor");
    expect(readme).toContain("parallel-codex-tui --workspace /path/to/project");
    expect(readme).toContain("parallel-codex-tui --help");
    expect(readme).toContain("parallel-codex-tui --version");
    expect(readme).toContain(".parallel-codex/config.toml");
    expect(readme).toContain(".parallel-codex/sessions/");
  });

  it("publishes the CLI bin as an executable file", async () => {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { cwd: process.cwd() });
    const [pack] = parsePackJson(stdout);
    const cliFile = pack.files.find((file) => file.path === "dist/cli.js");

    expect(cliFile?.mode).toBe(0o755);
  });
});
