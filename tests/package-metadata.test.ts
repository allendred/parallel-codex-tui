import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

interface PackageJson {
  bin: Record<string, string>;
  bugs?: {
    url?: string;
  };
  description?: string;
  engines?: Record<string, string>;
  files?: string[];
  homepage?: string;
  keywords?: string[];
  license?: string;
  private?: boolean;
  repository?: {
    type?: string;
    url?: string;
  };
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

    expect(pkg.bin["parallel-codex-tui"]).toBe("dist/cli.js");
  });

  it("declares public open-source package metadata", async () => {
    const pkg = await readPackageJson();

    expect(pkg.private).not.toBe(true);
    expect(pkg.license).toBe("MIT");
    expect(pkg.description).toContain("parallel coding");
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/allendred/parallel-codex-tui.git"
    });
    expect(pkg.bugs?.url).toBe("https://github.com/allendred/parallel-codex-tui/issues");
    expect(pkg.homepage).toBe("https://github.com/allendred/parallel-codex-tui#readme");
    expect(pkg.engines?.node).toBe(">=26.0.0");
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
    expect(pkg.scripts?.prepare).toBeUndefined();
  });

  it("ships an MIT license file", async () => {
    const license = await readFile(join(process.cwd(), "LICENSE"), "utf8");

    expect(license).toContain("MIT License");
    expect(license).toContain("parallel-codex-tui contributors");
  });

  it("keeps local runtime state and private config out of the public repo", async () => {
    const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");

    expect(gitignore).toContain(".parallel-codex/config.toml");
    expect(gitignore).toContain(".parallel-codex/last-workspace");
    expect(gitignore).toContain(".parallel-codex/sessions/");
    expect(gitignore).toContain(".parallel-codex/workspaces.json");
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
    expect(readme).toContain("Node.js 26+");
    expect(readme).toContain("Codex CLI");
    expect(readme).toContain("Claude CLI");
    expect(readme).toContain("## Install");
    expect(readme).toContain("npm install -g parallel-codex-tui");
    expect(readme).toContain("parallel-codex-tui --init");
    expect(readme).toContain("parallel-codex-tui --doctor");
    expect(readme).toContain("parallel-codex-tui --workspace /path/to/project");
    expect(readme).toContain("--workspace=/path/to/project");
    expect(readme).toContain("-w=/path/to/project");
    expect(readme).toContain("shows remembered projects from `.parallel-codex/workspaces.json`");
    expect(readme).toContain("If `--workspace <path>` points to an existing file");
    expect(readme).toContain("will not use that file path as the default folder to create");
    expect(readme).toContain("Router classification only receives the user request");
    expect(readme).toContain('`--doctor` checks the configured commands and any `{env:NAME}` references');
    expect(readme).toContain('OPENAI_API_KEY = "{env:OPENAI_API_KEY}"');
    expect(readme).toContain("parallel-codex-tui --help");
    expect(readme).toContain("parallel-codex-tui --version");
    expect(readme).toContain(".parallel-codex/config.toml");
    expect(readme).toContain(".parallel-codex/last-workspace");
    expect(readme).toContain(".parallel-codex/workspaces.json");
    expect(readme).toContain(".parallel-codex/sessions/");
    expect(readme).toContain("## Release");
    expect(readme).toContain("GitHub Actions runs CI on pushes and pull requests to `main`");
    expect(readme).toContain("Configure npm Trusted Publishing");
    expect(readme).toContain("add an `NPM_TOKEN` repository secret");
    expect(readme).toContain("git tag v0.1.2");
    expect(readme).toContain("git push origin v0.1.2");
    expect(readme).toContain("The release tag must match `package.json`");
  });

  it("publishes the CLI bin as an executable file", async () => {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { cwd: process.cwd() });
    const [pack] = parsePackJson(stdout);
    const cliFile = pack.files.find((file) => file.path === "dist/cli.js");

    expect(cliFile?.mode).toBe(0o755);
  });

  it("runs CI checks on GitHub Actions", async () => {
    const workflow = await readFile(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");

    expect(workflow).toContain("name: CI");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("actions/setup-node@v4");
    expect(workflow).toContain('node-version: "26.x"');
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm pack --dry-run --json");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain('CI: "0"');
    expect(workflow).toContain("git diff --check");
  });

  it("publishes tagged releases through GitHub Actions", async () => {
    const workflow = await readFile(join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");

    expect(workflow).toContain("name: Release");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("tags:");
    expect(workflow).toContain("- \"v*\"");
    expect(workflow).toContain("ref: ${{ github.event_name == 'workflow_dispatch' && inputs.version || github.ref }}");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain('node-version: "26.x"');
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain('CI: "0"');
    expect(workflow).toContain("npm pack --json");
    expect(workflow).toContain('PACKAGE_VERSION=$(node -p "require(\'./package.json\').version")');
    expect(workflow).toContain('if [ "v$PACKAGE_VERSION" != "$RELEASE_VERSION" ]; then');
    expect(workflow).toContain("npm view \"parallel-codex-tui@$PACKAGE_VERSION\" version --json");
    expect(workflow).toContain('published=$PUBLISHED');
    expect(workflow).toContain("if: steps.npm.outputs.published != 'true'");
    expect(workflow).toContain("npm publish --access public --provenance");
    expect(workflow).toContain("trying npm trusted publishing via GitHub OIDC");
    expect(workflow).toContain("sed -i '/_authToken/d'");
    expect(workflow).toContain("softprops/action-gh-release@v2");
    expect(workflow).toContain("NPM_TOKEN");
  });
});
