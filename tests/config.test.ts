import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeText } from "../src/core/file-store.js";
import { loadConfig, withUiThemeOverride, writeDefaultConfig } from "../src/core/config.js";

describe("config", () => {
  it("returns defaults when config file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-default-"));
    const config = await loadConfig(root);

    expect(config.projectRoot).toBe(root);
    expect(config.dataDir).toBe(".parallel-codex");
    expect("engine" in config.router).toBe(false);
    expect("complexityThreshold" in config.router).toBe(false);
    expect(config.router.codex.args).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-rules",
      "-c",
      "model_reasoning_effort=low",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-"
    ]);
    expect(config.router.codex.timeoutMs).toBe(30000);
    expect(config.router.codex.firstOutputTimeoutMs).toBe(15000);
    expect(config.router.codex.idleTimeoutMs).toBe(15000);
    expect(config.router.codex.maxOutputBytes).toBe(1024 * 1024);
    expect(config.router.codex.maxAttempts).toBe(2);
    expect(config.router.codex.retryDelayMs).toBe(500);
    expect(config.router.codex.fallback).toBe("simple");
    expect(config.router.codex.env).toEqual({});
    expect(config.router.codex.followUpTimeoutMs).toBe(20000);
    expect(config.workers.codex.args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--color",
      "never",
      "-"
    ]);
    expect(config.pairing.main).toBe("claude");
    expect(config.pairing.actor).toBe("codex");
    expect(config.pairing.critic).toBe("codex");
    expect(config.orchestration.maxParallelFeatures).toBe(3);
    expect(config.orchestration.maxRevisionRounds).toBe(3);
    expect(config.roles.actor.title).toBe("Actor");
    expect(config.roles.critic.instructions.join("\n")).toContain("blocking findings");
    expect(config.ui.theme).toBe("codex");
    expect(config.ui.colors).toEqual({});
    expect(config.workers.claude.args).toEqual([
      "--print",
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "text"
    ]);
    expect(config.workers.codex.nativeSession.resumeArgs).toEqual([
      "exec",
      "resume",
      "{sessionId}",
      "--skip-git-repo-check",
      "-"
    ]);
    expect(config.workers.codex.interactive.args).toEqual([
      "resume",
      "{sessionId}"
    ]);
    expect(config.workers.codex.interactive.forkArgs).toEqual(["fork", "{sessionId}"]);
    expect(config.workers.claude.interactive.args).toEqual(["--resume", "{sessionId}"]);
    expect(config.workers.claude.interactive.forkArgs).toEqual([
      "--resume",
      "{sessionId}",
      "--fork-session"
    ]);
    expect(config.workers.codex.nativeSession.fallback).toBe("new");
    expect(config.workers.codex.capabilities).toEqual({
      profile: "codex",
      writableDirArgs: ["--add-dir", "{dir}"],
      freshSessionArgs: []
    });
    expect(config.workers.claude.capabilities).toEqual({
      profile: "claude",
      writableDirArgs: ["--add-dir", "{dir}"],
      freshSessionArgs: ["--session-id", "{sessionId}"]
    });
  });

  it("loads TOML overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-file-"));

    await writeDefaultConfig(root);
    const config = await loadConfig(root);

    expect(config.workers.codex.command).toBe("codex");
    expect(config.ui.showStatusBar).toBe(true);
  });

  it("loads and bounds the parallel feature limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-parallel-limit-"));
    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      ["[orchestration]", "maxParallelFeatures = 2", "maxRevisionRounds = 4"].join("\n")
    );

    const config = await loadConfig(root);
    expect(config.orchestration.maxParallelFeatures).toBe(2);
    expect(config.orchestration.maxRevisionRounds).toBe(4);

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      ["[orchestration]", "maxParallelFeatures = 9"].join("\n")
    );
    await expect(loadConfig(root)).rejects.toThrow();
  });

  it("writes the curated example config for init", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-init-example-"));

    await writeDefaultConfig(root);

    const configText = await readFile(join(root, ".parallel-codex", "config.toml"), "utf8");
    const exampleText = await readFile(join(process.cwd(), ".parallel-codex", "config.example.toml"), "utf8");
    expect(configText).toBe(exampleText);
  });

  it("loads TUI theme and color overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-theme-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[ui]",
        'theme = "graphite"',
        "showStatusBar = true",
        "autoOpenFailedWorker = false",
        "",
        "[ui.colors]",
        'chrome = "ansi256(238)"',
        'accent = "magenta"'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.ui.theme).toBe("graphite");
    expect(config.ui.autoOpenFailedWorker).toBe(false);
    expect(config.ui.colors).toEqual({
      chrome: "ansi256(238)",
      accent: "magenta"
    });
  });

  it("normalizes TUI color override values during config load", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-theme-colors-normalized-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[ui.colors]",
        'chrome = "  ansi256( 238 )  "',
        'surface = " rgb(22, 27, 34) "',
        'accent = "  magenta  "',
        'warning = " #AABBCC "',
        'success = " ansi256(001) "'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.ui.colors).toEqual({
      chrome: "ansi256(238)",
      surface: "rgb(22,27,34)",
      accent: "magenta",
      warning: "#aabbcc",
      success: "ansi256(1)"
    });
  });

  it("normalizes the TUI theme name during config load", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-theme-name-normalized-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[ui]",
        'theme = "  graphite  "'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.ui.theme).toBe("graphite");
  });

  it("applies a transient UI theme override without mutating loaded config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-theme-override-"));
    const config = await loadConfig(root);

    const overridden = withUiThemeOverride(config, "paper");

    expect(overridden.ui.theme).toBe("paper");
    expect(config.ui.theme).toBe("codex");
    expect(overridden.ui.colors).toEqual(config.ui.colors);
  });

  it("keeps default worker timeouts when TOML overrides only command fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-worker-merge-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[workers.codex]",
        'command = "codex"',
        'args = ["exec", "-"]',
        "",
        "[workers.claude]",
        'command = "claude"',
        'args = ["--print"]'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.workers.codex.args).toEqual(["exec", "-"]);
    expect(config.workers.codex.timeoutMs).toBe(45 * 60 * 1000);
    expect(config.workers.codex.idleTimeoutMs).toBe(5 * 60 * 1000);
    expect(config.workers.codex.nativeSession.enabled).toBe(true);
    expect(config.workers.claude.timeoutMs).toBe(45 * 60 * 1000);
  });

  it("merges interactive native TUI command overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-interactive-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[workers.codex.interactive]",
        'command = "codex-beta"',
        'args = ["resume", "{sessionId}", "--model", "{model}"]',
        'forkArgs = ["fork", "{sessionId}", "--model", "{model}"]',
        "",
        "[workers.claude.interactive]",
        'args = ["--resume", "{sessionId}", "--dangerously-skip-permissions"]'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.workers.codex.interactive.command).toBe("codex-beta");
    expect(config.workers.codex.interactive.args).toEqual(["resume", "{sessionId}", "--model", "{model}"]);
    expect(config.workers.codex.interactive.forkArgs).toEqual([
      "fork",
      "{sessionId}",
      "--model",
      "{model}"
    ]);
    expect(config.workers.claude.interactive.command).toBe("claude");
    expect(config.workers.claude.interactive.args).toEqual([
      "--resume",
      "{sessionId}",
      "--dangerously-skip-permissions"
    ]);
    expect(config.workers.claude.interactive.forkArgs).toEqual([
      "--resume",
      "{sessionId}",
      "--fork-session"
    ]);
  });

  it("rejects interactive fork args without a session id template", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-interactive-fork-template-"));
    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[workers.codex.interactive]",
        'forkArgs = ["fork", "static-session"]'
      ].join("\n")
    );

    await expect(loadConfig(root)).rejects.toThrow(/forkArgs must include a \{sessionId\} template/);
  });

  it("merges native session TOML overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-native-session-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[workers.claude.nativeSession]",
        "enabled = true",
        'resumeArgs = ["--print", "--resume", "{sessionId}"]',
        'fallback = "new"'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.workers.claude.nativeSession.resumeArgs).toEqual(["--print", "--resume", "{sessionId}"]);
    expect(config.workers.claude.nativeSession.detectSessionId).toBe(true);
    expect(config.workers.claude.nativeSession.fallback).toBe("new");
  });

  it("loads worker model and third-party provider overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-model-provider-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[workers.codex.model]",
        'name = "gpt-5.5"',
        'provider = "custom"',
        'args = ["--model", "{model}", "--provider", "{provider}"]',
        "",
        "[workers.codex.model.env]",
        'OPENAI_BASE_URL = "https://third-party.example/v1"',
        'OPENAI_API_KEY = "{env:OPENAI_API_KEY}"'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.workers.codex.model.name).toBe("gpt-5.5");
    expect(config.workers.codex.model.provider).toBe("custom");
    expect(config.workers.codex.model.args).toEqual(["--model", "{model}", "--provider", "{provider}"]);
    expect(config.workers.codex.model.env).toEqual({
      OPENAI_BASE_URL: "https://third-party.example/v1",
      OPENAI_API_KEY: "{env:OPENAI_API_KEY}"
    });
    expect(config.workers.claude.model.args).toEqual([]);
  });

  it("loads named Worker providers and lets every role select one independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-named-providers-"));
    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[workers.openai_compat]",
        'extends = "codex"',
        'command = "openai-coder"',
        "",
        "[workers.openai_compat.model]",
        'name = "deepseek-v3"',
        'provider = "openai-compatible"',
        'args = ["--model", "{model}", "--provider", "{provider}"]',
        "",
        "[workers.openai_compat.model.env]",
        'OPENAI_API_KEY = "{env:OPENAI_COMPAT_KEY}"',
        "",
        "[workers.anthropic_compat]",
        'extends = "claude"',
        'command = "anthropic-coder"',
        "",
        "[workers.anthropic_compat.interactive]",
        'command = "anthropic-coder"',
        "",
        "[pairing]",
        'main = "anthropic_compat"',
        'judge = "openai_compat"',
        'actor = "openai_compat"',
        'critic = "anthropic_compat"'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.pairing).toEqual({
      main: "anthropic_compat",
      judge: "openai_compat",
      actor: "openai_compat",
      critic: "anthropic_compat"
    });
    expect(config.workers.openai_compat).toMatchObject({
      command: "openai-coder",
      assignable: true,
      capabilities: { profile: "codex" },
      model: {
        name: "deepseek-v3",
        provider: "openai-compatible",
        env: { OPENAI_API_KEY: "{env:OPENAI_COMPAT_KEY}" }
      }
    });
    expect(config.workers.openai_compat.nativeSession.resumeArgs).toEqual(
      config.workers.codex.nativeSession.resumeArgs
    );
    expect(config.workers.anthropic_compat.interactive.command).toBe("anthropic-coder");
    expect(config.workers.anthropic_compat.capabilities.profile).toBe("claude");
  });

  it("provides conservative defaults for a generic custom Worker provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-generic-provider-"));
    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[workers.vendor]",
        'extends = "generic"',
        'command = "vendor-coder"',
        'args = ["run", "--stdin"]',
        "",
        "[pairing]",
        'actor = "vendor"'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.workers.vendor).toMatchObject({
      command: "vendor-coder",
      args: ["run", "--stdin"],
      assignable: true,
      capabilities: {
        profile: "generic",
        writableDirArgs: [],
        freshSessionArgs: []
      },
      nativeSession: {
        enabled: false,
        detectSessionId: false,
        fallback: "fail"
      },
      interactive: {
        command: "vendor-coder",
        args: [],
        forkArgs: []
      }
    });
    expect(config.pairing.actor).toBe("vendor");
  });

  it("rejects unknown, unsafe, and circular Worker provider references", async () => {
    const cases = [
      ['[pairing]', 'actor = "missing"'],
      ['[workers.Bad.Provider]', 'command = "bad"'],
      ['[workers.first]', 'extends = "second"', '[workers.second]', 'extends = "first"']
    ];

    for (const lines of cases) {
      const root = await mkdtemp(join(tmpdir(), "pct-config-invalid-provider-"));
      await writeText(join(root, ".parallel-codex", "config.toml"), lines.join("\n"));
      await expect(loadConfig(root)).rejects.toThrow(/Worker profile|Worker provider|inheritance/i);
    }
  });

  it("loads an explicit third-party CLI capability contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-worker-capabilities-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[workers.codex.capabilities]",
        'profile = "generic"',
        'writableDirArgs = ["--allow-root", "{dir}"]',
        'freshSessionArgs = ["--new-session", "{sessionId}"]'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.workers.codex.capabilities).toEqual({
      profile: "generic",
      writableDirArgs: ["--allow-root", "{dir}"],
      freshSessionArgs: ["--new-session", "{sessionId}"]
    });
  });

  it("rejects capability argument lists without their required templates", async () => {
    const cases = [
      'writableDirArgs = ["--allow-root", "/tmp/static"]',
      'freshSessionArgs = ["--new-session", "static-id"]'
    ];

    for (const entry of cases) {
      const root = await mkdtemp(join(tmpdir(), "pct-config-worker-capability-template-"));
      await writeText(
        join(root, ".parallel-codex", "config.toml"),
        ["[workers.codex.capabilities]", 'profile = "generic"', entry].join("\n")
      );

      await expect(loadConfig(root)).rejects.toThrow(/must include/);
    }
  });

  it("loads Codex router command overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-codex-router-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[router.codex]",
        'command = "codex"',
        'args = ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"]',
        "timeoutMs = 120000",
        "firstOutputTimeoutMs = 15000",
        "idleTimeoutMs = 25000",
        "maxOutputBytes = 2048",
        "maxAttempts = 3",
        "retryDelayMs = 750",
        "followUpTimeoutMs = 9000",
        'fallback = "complex"',
        "",
        "[router.codex.env]",
        'HTTPS_PROXY = "http://127.0.0.1:7890"'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.router.codex.command).toBe("codex");
    expect(config.router.codex.args).toContain("exec");
    expect(config.router.codex.timeoutMs).toBe(120000);
    expect(config.router.codex.firstOutputTimeoutMs).toBe(15000);
    expect(config.router.codex.idleTimeoutMs).toBe(25000);
    expect(config.router.codex.maxOutputBytes).toBe(2048);
    expect(config.router.codex.maxAttempts).toBe(3);
    expect(config.router.codex.retryDelayMs).toBe(750);
    expect(config.router.codex.followUpTimeoutMs).toBe(9000);
    expect(config.router.codex.fallback).toBe("complex");
    expect(config.router.codex.env).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:7890"
    });
  });

  it("rejects the removed heuristic router fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-router-heuristic-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      ["[router.codex]", 'fallback = "heuristic"'].join("\n")
    );

    await expect(loadConfig(root)).rejects.toThrow();
  });

  it("rejects non-positive Router watchdog limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-router-watchdogs-"));

    for (const field of ["firstOutputTimeoutMs", "idleTimeoutMs"]) {
      await writeText(
        join(root, ".parallel-codex", "config.toml"),
        ["[router.codex]", `${field} = 0`].join("\n")
      );
      await expect(loadConfig(root)).rejects.toThrow();
    }
  });

  it("rejects invalid Router retry budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-router-retry-"));

    for (const entry of ["maxAttempts = 0", "maxAttempts = 4", "retryDelayMs = -1", "retryDelayMs = 10001"]) {
      await writeText(
        join(root, ".parallel-codex", "config.toml"),
        ["[router.codex]", entry].join("\n")
      );
      await expect(loadConfig(root)).rejects.toThrow();
    }
  });

  it("rejects unsafe Router output limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-router-output-limit-"));

    for (const value of [1023, 16 * 1024 * 1024 + 1]) {
      await writeText(
        join(root, ".parallel-codex", "config.toml"),
        ["[router.codex]", `maxOutputBytes = ${value}`].join("\n")
      );
      await expect(loadConfig(root)).rejects.toThrow();
    }
  });

  it("rejects invalid TUI color overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-invalid-theme-color-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[ui.colors]",
        'accent = "cyan-ish"',
        'chrome = "ansi256(999)"'
      ].join("\n")
    );

    await expect(loadConfig(root)).rejects.toThrow(/Invalid TUI color value/);
  });

  it("rejects unknown TUI color override keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-unknown-theme-color-key-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[ui.colors]",
        'accent = "cyan"',
        'acccent = "magenta"'
      ].join("\n")
    );

    await expect(loadConfig(root)).rejects.toThrow(/acccent/);
  });

  it("rejects unknown UI section keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-unknown-ui-key-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[ui]",
        'theme = "paper"',
        'theem = "graphite"'
      ].join("\n")
    );

    await expect(loadConfig(root)).rejects.toThrow(/theem/);
  });

  it("rejects invalid nested section types instead of silently using defaults", async () => {
    const cases = [
      ["workers.codex", '[workers]\ncodex = "bad"\n'],
      ["router.codex", '[router]\ncodex = "bad"\n'],
      ["roles.actor", '[roles]\nactor = "bad"\n'],
      ["ui.colors", '[ui]\ncolors = "bad"\n']
    ];

    for (const [label, text] of cases) {
      const root = await mkdtemp(join(tmpdir(), `pct-config-invalid-section-${label.replace(".", "-")}-`));
      await writeText(join(root, ".parallel-codex", "config.toml"), text);

      await expect(loadConfig(root), label).rejects.toThrow();
    }
  });

  it("loads role prompt overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-config-roles-"));

    await writeText(
      join(root, ".parallel-codex", "config.toml"),
      [
        "[roles.actor]",
        'title = "Builder"',
        'instructions = ["Prefer small patches.", "Always update worklog.md."]',
        "",
        "[roles.critic]",
        'instructions = ["Check tests first."]'
      ].join("\n")
    );

    const config = await loadConfig(root);

    expect(config.roles.actor.title).toBe("Builder");
    expect(config.roles.actor.instructions).toEqual(["Prefer small patches.", "Always update worklog.md."]);
    expect(config.roles.critic.title).toBe("Critic");
    expect(config.roles.critic.instructions).toEqual(["Check tests first."]);
  });
});
