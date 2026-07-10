import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TUI_THEME_FIELDS, TUI_THEME_PRESETS } from "../src/tui/theme.js";

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
  publishConfig?: {
    access?: string;
    registry?: string;
  };
  dependencies?: Record<string, string>;
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
    expect(pkg.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/"
    });
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
    expect(pkg.dependencies?.chalk).toBe("^5.3.0");
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
    expect(gitignore).toContain(".parallel-codex/router/");
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
    for (const field of TUI_THEME_FIELDS) {
      expect(example).toContain(`# ${field} = `);
    }
    expect(example).toContain(`# chrome = "${TUI_THEME_PRESETS.codex.chrome}"`);
    expect(example).toContain(`# surface = "${TUI_THEME_PRESETS.codex.surface}"`);
    expect(example).toContain(`# rail = "${TUI_THEME_PRESETS.codex.rail}"`);
    expect(example).toContain(`# text = "${TUI_THEME_PRESETS.codex.text}"`);
    expect(example).toContain(`# muted = "${TUI_THEME_PRESETS.codex.muted}"`);
    expect(example).toContain(`# accent = "${TUI_THEME_PRESETS.codex.accent}"`);
    expect(example).toContain(`# warning = "${TUI_THEME_PRESETS.codex.warning}"`);
    expect(example).toContain(`# success = "${TUI_THEME_PRESETS.codex.success}"`);
    expect(example).toContain(`# danger = "${TUI_THEME_PRESETS.codex.danger}"`);
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
    expect(readme).toContain("parallel-codex-tui --theme aurora --workspace /path/to/project");
    expect(readme).toContain("parallel-codex-tui --theme studio --workspace /path/to/project");
    expect(readme).toContain("--workspace=/path/to/project");
    expect(readme).toContain("--theme=paper");
    expect(readme).toContain("-w=/path/to/project");
    expect(readme).toContain("shows remembered projects from `.parallel-codex/workspaces.json`");
    expect(readme).toContain("If `--workspace <path>` points to an existing file");
    expect(readme).toContain("will not use that file path as the default folder to create");
    expect(readme).toContain("Router classification only receives the user request");
    expect(readme).toContain("Valid `[router]` changes are reloaded before the next classification without restarting the TUI");
    expect(readme).toContain("Worker, pairing, role, orchestration, data-directory, and UI changes still require a restart");
    expect(readme).toContain("While classification is running, it shows the effective limit such as `route checking · 30s max`");
    expect(readme).toContain("`.parallel-codex/sessions/main/chat.jsonl`");
    expect(readme).toContain("startup restores the latest 200 valid messages");
    expect(readme).toContain("Chat drafts support Unicode-safe Left/Right, Home/End, Backspace, and Delete editing");
    expect(readme).toContain("Up/Down recalls persisted user requests and returns to the exact unsent draft");
    expect(readme).toContain("Bracketed multiline paste stays in one draft");
    expect(readme).toContain('`--doctor` checks the configured commands and any `{env:NAME}` references');
    expect(readme).toContain("reports the loaded TUI theme, core palette values, ANSI swatch previews, and color override values");
    expect(readme).toContain("including any temporary `--theme` override");
    expect(readme).toContain('OPENAI_API_KEY = "{env:OPENAI_API_KEY}"');
    expect(readme).toContain("In chat, scroll long conversation history with the mouse wheel or PageUp/PageDown");
    expect(readme).toContain("sending a new message returns to the latest reply");
    expect(readme).toContain("Press `Ctrl+N` to preserve the current session and start a new task");
    expect(readme).toContain("the next complex request creates an independent task from turn `0001`");
    expect(readme).toContain("`Ctrl+W` to open worker logs");
    expect(readme).toContain("In worker-log views, scroll with the mouse wheel or PageUp/PageDown");
    expect(readme).toContain("In chat or worker-log views, press `Ctrl+O`");
    expect(readme).toContain("Press `Ctrl+]` to return to worker logs");
    expect(readme).not.toContain("Press `Ctrl+]` to detach and return to worker logs");
    expect(readme).toContain("parallel-codex-tui --help");
    expect(readme).toContain("parallel-codex-tui --version");
    expect(readme).toContain("## Theme");
    expect(readme).toContain('theme = "codex"');
    expect(readme).toContain("showStatusBar = false");
    expect(readme).toContain("autoOpenFailedWorker = false");
    expect(readme).toContain("successSurface");
    expect(readme).toContain("Color values are validated during config load");
    expect(readme).toContain("ansi256(0..255)");
    expect(readme).toContain("Unknown UI and color keys are rejected so typos fail fast");
    expect(readme).toContain("parallel-codex-tui --theme graphite --doctor");
    expect(readme).toContain("parallel-codex-tui --theme studio --doctor");
    expect(readme).toContain("parallel-codex-tui --themes");
    expect(readme).toContain("parallel-codex-tui --theme paper --themes");
    expect(readme).toContain("complete palette groups for every built-in theme");
    expect(readme).toContain("The doctor output includes `preview:` and `semantic:` ANSI swatch rows");
    expect(readme).toContain(".parallel-codex/config.toml");
    expect(readme).toContain(".parallel-codex/last-workspace");
    expect(readme).toContain(".parallel-codex/workspaces.json");
    expect(readme).toContain(".parallel-codex/sessions/");
    expect(readme).toContain("## Release");
    expect(readme).toContain("GitHub Actions runs CI on pushes and pull requests to `main`");
    expect(readme).toContain("npm Trusted Publishing with GitHub OIDC");
    expect(readme).toContain("In npm, configure Trusted Publishing");
    expect(readme).toContain('workflow filename `release.yml`');
    expect(readme).toContain("Do not configure `NPM_TOKEN` for the release workflow");
    expect(readme).toContain("npm `^11.5.1`");
    expect(readme).toContain("npm install -g npm@^11.15.0");
    expect(readme).toContain(
      "npm trust github parallel-codex-tui --repo allendred/parallel-codex-tui --file release.yml --allow-publish --dry-run",
    );
    expect(readme).toContain(
      "npm trust github parallel-codex-tui --repo allendred/parallel-codex-tui --file release.yml --allow-publish --yes",
    );
    expect(readme).toContain("may require npm two-factor authentication");
    expect(readme).toContain("allowed action `npm publish`");
    expect(readme).toContain("npm returns `ENEEDAUTH` or `E401`");
    expect(readme).toContain("fix the npm Trusted Publishing package settings rather than adding a token fallback");
    expect(readme).toContain("git tag v0.1.4");
    expect(readme).toContain("git push origin v0.1.4");
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
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("actions/setup-node@v6");
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
    expect(workflow).toContain("group: release-${{ github.event_name == 'workflow_dispatch' && inputs.version || github.ref_name }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("ref: ${{ github.event_name == 'workflow_dispatch' && inputs.version || github.ref }}");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain('node-version: "26.x"');
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain("npm install -g npm@^11.5.1");
    expect(workflow).toContain("npm --version");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain('CI: "0"');
    expect(workflow).toContain("npm pack --json");
    expect(workflow).toContain("id: pack");
    expect(workflow).toContain("tarball=$TARBALL");
    expect(workflow).toContain('PACKAGE_VERSION=$(node -p "require(\'./package.json\').version")');
    expect(workflow).toContain('if [ "v$PACKAGE_VERSION" != "$RELEASE_VERSION" ]; then');
    expect(workflow).toContain("npm view \"parallel-codex-tui@$PACKAGE_VERSION\" version --json");
    expect(workflow).toContain('published=$PUBLISHED');
    expect(workflow).toContain("if: steps.npm.outputs.published != 'true'");
    expect(workflow).toContain('PACKAGE_TARBALL="${{ steps.pack.outputs.tarball }}"');
    expect(workflow).toContain('npm publish --access public "$PACKAGE_TARBALL"');
    expect(workflow).toContain("Publishing to npm with Trusted Publishing via GitHub OIDC");
    expect(workflow).toContain("Trusted Publishing was not accepted");
    expect(workflow).toContain("workflow filename release.yml");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("fallback");
    expect(workflow).not.toContain("_authToken");
    expect(workflow).toContain("Verify published package");
    expect(workflow).toContain('PACKAGE_SPEC="parallel-codex-tui@$PACKAGE_VERSION"');
    expect(workflow).toContain('npm view "$PACKAGE_SPEC" version --json');
    expect(workflow).toContain('npm install --global --prefix "$VERIFY_PREFIX" "$PACKAGE_SPEC"');
    expect(workflow).toContain('"$VERIFY_PREFIX/bin/parallel-codex-tui" --version');
    expect(workflow).toContain('grep -F "parallel-codex-tui $PACKAGE_VERSION"');
    expect(workflow).toContain("softprops/action-gh-release@v2");
  });
});
