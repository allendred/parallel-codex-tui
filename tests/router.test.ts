import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { processIsAlive } from "../src/core/process-ownership.js";
import * as router from "../src/core/router.js";
import { routeRequestWithCodex, routerCommandLabel } from "../src/core/router.js";
import type { CodexRouteRunner } from "../src/core/router.js";

describe("routeRequestWithCodex", () => {
  it("does not expose a local heuristic routeRequest API", () => {
    expect("routeRequest" in router).toBe(false);
  });

  it("describes the effective Router proxy without exposing credentials", () => {
    const routerProxyContext = (
      router as typeof router & {
        routerProxyContext?: (
          configured: Record<string, string>,
          env?: NodeJS.ProcessEnv
        ) => Record<string, unknown>;
      }
    ).routerProxyContext;

    expect(routerProxyContext).toBeTypeOf("function");
    expect(routerProxyContext?.(
      { HTTPS_PROXY: "{env:PRIVATE_PROXY}" },
      { PRIVATE_PROXY: "https://user:secret@proxy.test:8443/private?token=hidden" }
    )).toEqual({
      configured: true,
      source: "router-config",
      variable: "HTTPS_PROXY",
      endpoint: "proxy.test:8443"
    });
    expect(routerProxyContext?.({}, {
      ALL_PROXY: "socks5://name:secret@127.0.0.1:1080"
    })).toEqual({
      configured: true,
      source: "environment",
      variable: "ALL_PROXY",
      endpoint: "127.0.0.1:1080"
    });
    expect(routerProxyContext?.({}, {})).toEqual({ configured: false });
    expect(JSON.stringify(routerProxyContext?.(
      { HTTPS_PROXY: "{env:PRIVATE_PROXY}" },
      { PRIVATE_PROXY: "https://user:secret@proxy.test:8443/private?token=hidden" }
    ))).not.toMatch(/user|secret|private|hidden/);
  });

  it("honors forced simple mode", () => {
    const config = defaultConfig("/tmp/project");
    config.router.defaultMode = "simple";
    const runner: CodexRouteRunner = async () => {
      throw new Error("runner should not be called for forced simple mode");
    };

    return expect(routeRequestWithCodex("实现一个大型功能", config, runner)).resolves.toMatchObject({
      mode: "simple",
      source: "forced",
      suggested_roles: []
    });
  });

  it("honors forced complex mode", () => {
    const config = defaultConfig("/tmp/project");
    config.router.defaultMode = "complex";
    const runner: CodexRouteRunner = async () => {
      throw new Error("runner should not be called for forced complex mode");
    };

    return expect(routeRequestWithCodex("你好", config, runner)).resolves.toMatchObject({
      mode: "complex",
      suggested_roles: ["judge", "actor", "critic"]
    });
  });

  it("uses Codex JSON route decisions when configured", async () => {
    const config = defaultConfig("/tmp/project");
    const runner: CodexRouteRunner = async () =>
      JSON.stringify({
        mode: "complex",
        reason: "Codex saw an optimization request.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      });

    const route = await routeRequestWithCodex("优化得分", config, runner);

    expect(route.mode).toBe("complex");
    expect(route.reason).toBe("Codex saw an optimization request.");
    expect(route.source).toBe("codex");
    expect(route.duration_ms).toEqual(expect.any(Number));
  });

  it("records only the executable name for a custom Router command", async () => {
    const config = defaultConfig("/tmp/project");
    config.router.codex.command = "/opt/private/bin/acme-router";
    const runner: CodexRouteRunner = async () => JSON.stringify({
      mode: "simple",
      reason: "Custom Router selected Main."
    });

    const route = await routeRequestWithCodex("你好", config, runner);

    expect(route.router_command).toBe("acme-router");
    expect(JSON.stringify(route)).not.toContain("/opt/private");
  });

  it("names a custom Router command in fallback errors", async () => {
    const config = defaultConfig("/tmp/project");
    config.router.codex.command = "/opt/private/bin/acme-router";

    const route = await routeRequestWithCodex("你好", config, async () => {
      throw new Error("upstream unavailable");
    });

    expect(route).toMatchObject({ source: "fallback", router_command: "acme-router" });
    expect(route.reason).toContain("Router acme-router failed: upstream unavailable");
    expect(route.reason).toContain("Router acme-router fallback forced simple.");
    expect(route.reason).not.toContain("Codex router");
  });

  it("normalizes harmless casing and whitespace in Codex route modes", async () => {
    const config = defaultConfig("/tmp/project");
    const runner: CodexRouteRunner = async () => JSON.stringify({
      mode: " COMPLEX ",
      reason: " Project work needs parallel workers. "
    });

    const route = await routeRequestWithCodex("实现一个功能", config, runner);

    expect(route).toMatchObject({
      mode: "complex",
      reason: "Project work needs parallel workers.",
      source: "codex",
      suggested_roles: ["judge", "actor", "critic"]
    });
  });

  it("uses the configured fallback when Codex returns an unknown route mode", async () => {
    const config = defaultConfig("/tmp/project");
    config.router.codex.fallback = "complex";
    const runner: CodexRouteRunner = async () => JSON.stringify({
      mode: "analysis",
      reason: "Unrecognized classifier label."
    });

    const route = await routeRequestWithCodex("实现一个大型功能", config, runner);

    expect(route).toMatchObject({
      mode: "complex",
      source: "fallback",
      suggested_roles: ["judge", "actor", "critic"]
    });
    expect(route.reason).toContain("Invalid Codex router mode");
    expect(route.reason).toContain("Codex router fallback forced complex.");
  });

  it("uses configured role pairing instead of router-provided engines", async () => {
    const config = defaultConfig("/tmp/project");
    config.pairing.judge = "mock";
    config.pairing.actor = "claude";
    config.pairing.critic = "codex";
    const runner: CodexRouteRunner = async () =>
      JSON.stringify({
        mode: "complex",
        reason: "Codex saw project work.",
        judge_engine: "codex",
        actor_engine: "mock",
        critic_engine: "claude"
      });

    const route = await routeRequestWithCodex("实现一个功能", config, runner);

    expect(route).toMatchObject({
      mode: "complex",
      judge_engine: "mock",
      actor_engine: "claude",
      critic_engine: "codex"
    });
  });

  it("builds router prompts from the user request without workspace context", async () => {
    const config = defaultConfig("/tmp/secret-project");
    let seenPrompt = "";
    const runner: CodexRouteRunner = async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify({
        mode: "complex",
        reason: "Codex saw project work."
      });
    };

    await routeRequestWithCodex("做个俄罗斯方块的游戏", config, runner, "/tmp/secret-project");

    expect(seenPrompt).toContain("做个俄罗斯方块的游戏");
    expect(seenPrompt).not.toContain("/tmp/secret-project");
    expect(seenPrompt).not.toContain("Workspace");
    expect(seenPrompt).not.toContain("cwd");
  });

  it("does not expose local role pairing config to the router prompt", async () => {
    const config = defaultConfig("/tmp/project");
    config.pairing.judge = "claude";
    config.pairing.actor = "mock";
    config.pairing.critic = "codex";
    let seenPrompt = "";
    const runner: CodexRouteRunner = async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify({
        mode: "complex",
        reason: "Codex saw project work."
      });
    };

    await routeRequestWithCodex("做个俄罗斯方块的游戏", config, runner);

    expect(seenPrompt).toContain("做个俄罗斯方块的游戏");
    expect(seenPrompt).not.toContain("suggested_roles");
    expect(seenPrompt).not.toContain("judge_engine");
    expect(seenPrompt).not.toContain("actor_engine");
    expect(seenPrompt).not.toContain("critic_engine");
    expect(seenPrompt).not.toContain("pairing");
    expect(seenPrompt).not.toContain("claude");
    expect(seenPrompt).not.toContain("mock");
  });

  it("passes the workspace only as the router process cwd", async () => {
    const config = defaultConfig("/tmp/project");
    let seenCwd = "";
    const runner: CodexRouteRunner = async (_prompt, _config, cwd) => {
      seenCwd = cwd;
      return JSON.stringify({
        mode: "simple",
        reason: "Codex saw chat."
      });
    };

    await routeRequestWithCodex("你好", config, runner, "/tmp/router-cwd");

    expect(seenCwd).toBe("/tmp/router-cwd");
  });

  it("preserves UTF-8 route text split across process output chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-split-utf8-"));
    const response = Buffer.from(JSON.stringify({
      mode: "complex",
      reason: "需要并行实现"
    }), "utf8");
    const characterOffset = response.indexOf(Buffer.from("需", "utf8"));
    const first = response.subarray(0, characterOffset + 1).toString("base64");
    const second = response.subarray(characterOffset + 1).toString("base64");
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      [
        `process.stdout.write(Buffer.from(${JSON.stringify(first)},'base64'));`,
        `setTimeout(()=>process.stdout.end(Buffer.from(${JSON.stringify(second)},'base64')),80);`
      ].join("")
    ];
    config.router.codex.timeoutMs = 3000;
    config.router.codex.firstOutputTimeoutMs = 1000;
    config.router.codex.idleTimeoutMs = 1000;

    const route = await routeRequestWithCodex("实现功能", config, undefined, root);

    expect(route).toMatchObject({
      mode: "complex",
      source: "codex",
      reason: "需要并行实现",
      router_stdout_bytes: response.byteLength
    });
    expect(route.reason).not.toContain("�");
  });

  it("terminates a Router whose combined output exceeds the configured memory limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-output-limit-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      "process.stdout.write('x'.repeat(600));process.stderr.write('y'.repeat(600));setInterval(()=>{},1000)"
    ];
    config.router.codex.maxOutputBytes = 1024;
    config.router.codex.timeoutMs = 3000;
    config.router.codex.firstOutputTimeoutMs = 1000;
    config.router.codex.idleTimeoutMs = 1000;

    const route = await routeRequestWithCodex("实现功能", config, undefined, root);

    expect(route).toMatchObject({
      source: "fallback",
      router_failure_kind: "invalid-output",
      router_failure_stage: "response",
      router_stdout_bytes: 600,
      router_stderr_bytes: 600
    });
    expect(route.reason).toContain("output exceeded 1024 byte limit");
    expect(route.duration_ms).toBeLessThan(900);
  });

  it("trusts the Codex route even when old keywords would have matched", async () => {
    const config = defaultConfig("/tmp/project");
    const runner: CodexRouteRunner = async () =>
      JSON.stringify({
        mode: "simple",
        reason: "Codex treated this as a question, not implementation work."
      });

    const route = await routeRequestWithCodex("做个俄罗斯方块的游戏?", config, runner);

    expect(route.mode).toBe("simple");
    expect(route.reason).toBe("Codex treated this as a question, not implementation work.");
    expect(route.suggested_roles).toEqual([]);
  });

  it("fails safely to simple routing when Codex returns invalid JSON", async () => {
    const config = defaultConfig("/tmp/project");
    const runner: CodexRouteRunner = async () => "not json";

    const route = await routeRequestWithCodex("你好", config, runner);

    expect(route.mode).toBe("simple");
    expect(route.reason).toContain("Codex router failed");
    expect(route.reason).toContain("Codex router fallback forced simple.");
    expect(route.source).toBe("fallback");
    expect(route.duration_ms).toEqual(expect.any(Number));
  });

  it("propagates cancellation instead of converting it into a fallback route", async () => {
    const config = defaultConfig("/tmp/project");
    const controller = new AbortController();
    const runner: CodexRouteRunner = async (_prompt, _config, _cwd, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("router stopped")), { once: true });
    });
    const pending = routeRequestWithCodex("实现一个大型功能", config, runner, "/tmp/router", controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "Request cancelled."
    });
  });

  it("terminates a stalled router process at the configured timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-timeout-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      "process.stderr.write('Connecting through proxy http://user:secret@127.0.0.1:7890\\n'); setInterval(() => {}, 1000)"
    ];
    config.router.codex.timeoutMs = 1000;

    const route = await routeRequestWithCodex("你好", config, undefined, root);

    expect(route).toMatchObject({
      mode: "simple",
      source: "fallback",
      router_failure_kind: "timeout",
      suggested_roles: []
    });
    expect(route.reason).toContain("timed out after 1000ms");
    expect(route.reason).toContain("Connecting through proxy http://***@127.0.0.1:7890");
    expect(route.reason).not.toContain("user:secret");
    expect(route.duration_ms).toBeGreaterThanOrEqual(800);
    expect(route.duration_ms).toBeLessThan(2000);
    expect(route).toMatchObject({
      router_failure_stage: "streaming",
      router_dispatch_ms: expect.any(Number),
      router_spawn_ms: expect.any(Number),
      router_first_output_ms: expect.any(Number),
      router_first_stderr_ms: expect.any(Number),
      router_process_ms: expect.any(Number),
      router_stdout_bytes: 0,
      router_stderr_bytes: expect.any(Number)
    });
    expect(route.router_stderr_bytes).toBeGreaterThan(0);
    expect(route.router_first_stdout_ms).toBeUndefined();
    expect(route.router_parse_ms).toBeUndefined();
  });

  it("terminates Router descendants when the total timeout expires", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-router-descendant-timeout-"));
    const sentinelPath = join(root, "orphaned-router-child.txt");
    const descendantScript = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => writeFileSync(${JSON.stringify(sentinelPath)}, 'orphaned'), 400);`,
      "setTimeout(() => process.exit(0), 650);"
    ].join("");
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
        "setInterval(() => {}, 1000);"
      ].join("")
    ];
    config.router.codex.timeoutMs = 250;

    const route = await routeRequestWithCodex("你好", config, undefined, root);
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(route).toMatchObject({
      source: "fallback",
      router_timeout_kind: "total"
    });
    await expect(access(sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for graceful Router cleanup before returning a timeout", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-router-graceful-timeout-"));
    const cleanupPath = join(root, "router-cleaned.txt");
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      [
        "const {writeFileSync}=require('node:fs');",
        "process.on('SIGTERM',()=>setTimeout(()=>{",
        `writeFileSync(${JSON.stringify(cleanupPath)},'done');`,
        "process.exit(0);",
        "},120));",
        "process.stderr.write('ready\\n');",
        "setInterval(()=>{},1000);"
      ].join("")
    ];
    config.router.codex.timeoutMs = 2000;
    config.router.codex.firstOutputTimeoutMs = 1000;
    config.router.codex.idleTimeoutMs = 100;

    const route = await routeRequestWithCodex("你好", config, undefined, root);

    expect(route).toMatchObject({ source: "fallback", router_timeout_kind: "idle" });
    await expect(readFile(cleanupPath, "utf8")).resolves.toBe("done");
    expect(route.duration_ms).toBeGreaterThanOrEqual(180);
  });

  it("force-kills an uncooperative Router before returning a timeout", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-router-force-timeout-"));
    const pidPath = join(root, "router.pid");
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      [
        "const {writeFileSync}=require('node:fs');",
        `writeFileSync(${JSON.stringify(pidPath)},String(process.pid));`,
        "process.on('SIGTERM',()=>{});",
        "process.stderr.write('ready\\n');",
        "setInterval(()=>{},1000);"
      ].join("")
    ];
    config.router.codex.timeoutMs = 2000;
    config.router.codex.firstOutputTimeoutMs = 1000;
    config.router.codex.idleTimeoutMs = 100;

    let pid = 0;
    try {
      const route = await routeRequestWithCodex("你好", config, undefined, root);
      pid = Number(await readFile(pidPath, "utf8"));

      expect(route).toMatchObject({ source: "fallback", router_timeout_kind: "idle" });
      expect(processIsAlive(pid)).toBe(false);
    } finally {
      killProcessGroupIfAlive(pid);
    }
  });

  it("waits for an uncooperative Router descendant after its parent exits", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-router-descendant-force-"));
    const pidPath = join(root, "router-descendant.pid");
    const descendantScript = [
      "const {writeFileSync}=require('node:fs');",
      `writeFileSync(${JSON.stringify(pidPath)},String(process.pid));`,
      "process.on('SIGTERM',()=>{});",
      "process.send?.('ready');",
      "setInterval(()=>{},1000);"
    ].join("");
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      [
        "const {spawn}=require('node:child_process');",
        `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:['ignore','ignore','ignore','ipc']});`,
        "child.once('message',()=>process.stderr.write('ready\\n'));",
        "setInterval(()=>{},1000);"
      ].join("")
    ];
    config.router.codex.timeoutMs = 2000;
    config.router.codex.firstOutputTimeoutMs = 1000;
    config.router.codex.idleTimeoutMs = 100;

    let pid = 0;
    try {
      const route = await routeRequestWithCodex("你好", config, undefined, root);
      pid = Number(await readFile(pidPath, "utf8"));

      expect(route).toMatchObject({
        source: "fallback",
        router_timeout_kind: "idle",
        router_failure_stage: "streaming"
      });
      expect(processIsAlive(pid)).toBe(false);
    } finally {
      killProcessGroupIfAlive(pid);
    }
  });

  it("waits for Router cleanup before completing cancellation", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-router-cancel-cleanup-"));
    const cleanupPath = join(root, "router-cancelled.txt");
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      [
        "const {writeFileSync}=require('node:fs');",
        "process.on('SIGTERM',()=>setTimeout(()=>{",
        `writeFileSync(${JSON.stringify(cleanupPath)},'done');`,
        "process.exit(0);",
        "},120));",
        "process.stderr.write('ready\\n');",
        "setInterval(()=>{},1000);"
      ].join("")
    ];
    const controller = new AbortController();
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const routeWithProgress = routeRequestWithCodex as unknown as (
      request: string,
      config: ReturnType<typeof defaultConfig>,
      runner: undefined,
      cwd: string,
      signal: AbortSignal,
      onProgress: (event: { phase: string }) => void
    ) => ReturnType<typeof routeRequestWithCodex>;
    const pending = routeWithProgress(
      "你好",
      config,
      undefined,
      root,
      controller.signal,
      (event) => {
        if (event.phase === "receiving-stderr") {
          markReady?.();
        }
      }
    );
    await ready;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(cleanupPath, "utf8")).resolves.toBe("done");
  });

  it("fails closed when Router process-group termination is not permitted", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-router-cleanup-denied-"));
    const pidPath = join(root, "router.pid");
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      [
        "const {writeFileSync}=require('node:fs');",
        `writeFileSync(${JSON.stringify(pidPath)},String(process.pid));`,
        "process.stderr.write('ready\\n');",
        "setInterval(()=>{},1000);"
      ].join("")
    ];
    config.router.codex.timeoutMs = 2000;
    config.router.codex.firstOutputTimeoutMs = 1000;
    config.router.codex.idleTimeoutMs = 100;
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (typeof pid === "number" && pid < 0 && signal === "SIGTERM") {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalKill(pid, signal);
    });

    let pid = 0;
    try {
      const error = await routeRequestWithCodex("你好", config, undefined, root)
        .catch((caught: unknown) => caught);
      pid = Number(await readFile(pidPath, "utf8"));

      expect(error).toMatchObject({
        name: "ProcessTreeCleanupError",
        message: expect.stringContaining(
          `Could not terminate Router ${routerCommandLabel(process.execPath)} process ${pid}`
        )
      });
      expect(error).not.toMatchObject({ source: "fallback" });
      expect(processIsAlive(pid)).toBe(true);
    } finally {
      killSpy.mockRestore();
      killProcessGroupIfAlive(pid);
    }
  });

  it("records configured proxy context when a stalled router is silent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-silent-proxy-timeout-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = ["-e", "setInterval(() => {}, 1000)"];
    config.router.codex.timeoutMs = 200;
    config.router.codex.env = {
      HTTPS_PROXY: "http://user:secret@127.0.0.1:7890"
    };

    const progress: string[] = [];
    const routeWithProgress = routeRequestWithCodex as unknown as (
      request: string,
      config: ReturnType<typeof defaultConfig>,
      runner: undefined,
      cwd: string,
      signal: undefined,
      onProgress: (event: { phase: string }) => void
    ) => ReturnType<typeof routeRequestWithCodex>;
    const route = await routeWithProgress(
      "你好",
      config,
      undefined,
      root,
      undefined,
      (event) => progress.push(event.phase)
    );

    expect(route.reason).toContain("timed out after 200ms with proxy configured");
    expect(route.reason).not.toContain("user:secret");
    expect(route).toMatchObject({
      router_failure_stage: "waiting-output",
      router_dispatch_ms: expect.any(Number),
      router_spawn_ms: expect.any(Number),
      router_process_ms: expect.any(Number),
      router_stdout_bytes: 0,
      router_stderr_bytes: 0,
      proxy_configured: true,
      proxy_source: "router-config",
      proxy_variable: "HTTPS_PROXY",
      proxy_endpoint: "127.0.0.1:7890"
    });
    expect(progress).toEqual(["dispatching", "starting", "waiting-output", "stopping"]);
    expect(route.router_first_output_ms).toBeUndefined();
    expect(route.router_parse_ms).toBeUndefined();
  });

  it("stops a silent Router at the first-output deadline before the total timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-first-output-timeout-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = ["-e", "setInterval(()=>{},1000)"];
    config.router.codex.timeoutMs = 1200;
    config.router.codex.firstOutputTimeoutMs = 250;
    config.router.codex.idleTimeoutMs = 700;

    const route = await routeRequestWithCodex("你好", config, undefined, root);

    expect(route).toMatchObject({
      source: "fallback",
      router_failure_stage: "waiting-output",
      router_timeout_kind: "first-output",
      router_stdout_bytes: 0,
      router_stderr_bytes: 0
    });
    expect(route.reason).toContain("first output timed out after 250ms");
    expect(route.duration_ms).toBeGreaterThanOrEqual(150);
    expect(route.duration_ms).toBeLessThan(900);
  });

  it("stops a Router that becomes idle after emitting diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-idle-timeout-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      "process.stderr.write('connected\\n');setInterval(()=>{},1000)"
    ];
    config.router.codex.timeoutMs = 1800;
    config.router.codex.firstOutputTimeoutMs = 1000;
    config.router.codex.idleTimeoutMs = 200;

    const route = await routeRequestWithCodex("你好", config, undefined, root);

    expect(route).toMatchObject({
      source: "fallback",
      router_failure_stage: "streaming",
      router_timeout_kind: "idle",
      router_stdout_bytes: 0,
      router_stderr_bytes: expect.any(Number)
    });
    expect(route.reason).toContain("idle timed out after 200ms");
    expect(route.duration_ms).toBeLessThan(1400);
  });

  it("resets the Router idle deadline whenever either output stream is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-idle-reset-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      [
        "process.stderr.write('phase-1\\n');",
        "setTimeout(()=>process.stderr.write('phase-2\\n'),150);",
        "setTimeout(()=>process.stderr.write('phase-3\\n'),300);",
        "setTimeout(()=>process.stderr.write('phase-4\\n'),450);",
        "setTimeout(()=>process.stdout.write(JSON.stringify({mode:'simple',reason:'active'})),600);"
      ].join("")
    ];
    config.router.codex.timeoutMs = 2500;
    config.router.codex.firstOutputTimeoutMs = 1000;
    config.router.codex.idleTimeoutMs = 300;

    const route = await routeRequestWithCodex("你好", config, undefined, root);

    expect(route).toMatchObject({ mode: "simple", source: "codex", reason: "active" });
    expect(route.duration_ms).toBeGreaterThanOrEqual(500);
  });

  it("keeps the total Router timeout authoritative while output remains active", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-total-timeout-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      "process.stderr.write('start\\n');setInterval(()=>process.stderr.write('.'),100)"
    ];
    config.router.codex.timeoutMs = 900;
    config.router.codex.firstOutputTimeoutMs = 700;
    config.router.codex.idleTimeoutMs = 300;

    const route = await routeRequestWithCodex("你好", config, undefined, root);

    expect(route).toMatchObject({
      source: "fallback",
      router_failure_stage: "streaming",
      router_timeout_kind: "total"
    });
    expect(route.reason).toContain("timed out after 900ms");
    expect(route.duration_ms).toBeGreaterThanOrEqual(750);
    expect(route.duration_ms).toBeLessThan(1600);
  });

  it("ignores output that arrives only while a timed-out Router is terminating", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-late-output-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      [
        "process.on('SIGTERM',()=>{",
        "process.stdout.write(JSON.stringify({mode:'simple',reason:'too late'}));",
        "setTimeout(()=>process.exit(0),20);",
        "});",
        "setInterval(()=>{},1000);"
      ].join("")
    ];
    config.router.codex.timeoutMs = 100;
    const progress: string[] = [];
    const routeWithProgress = routeRequestWithCodex as unknown as (
      request: string,
      config: ReturnType<typeof defaultConfig>,
      runner: undefined,
      cwd: string,
      signal: undefined,
      onProgress: (event: { phase: string }) => void
    ) => ReturnType<typeof routeRequestWithCodex>;

    const route = await routeWithProgress(
      "你好",
      config,
      undefined,
      root,
      undefined,
      (event) => progress.push(event.phase)
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(route).toMatchObject({ source: "fallback", router_failure_stage: "waiting-output" });
    expect(progress).toEqual(["dispatching", "starting", "waiting-output", "stopping"]);
  });

  it("records response-stage telemetry when a successful process returns invalid output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-invalid-response-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = ["-e", "process.stdout.write('not json')"];

    const route = await routeRequestWithCodex("你好", config, undefined, root);

    expect(route).toMatchObject({
      source: "fallback",
      router_failure_kind: "invalid-output",
      router_failure_stage: "response",
      router_dispatch_ms: expect.any(Number),
      router_spawn_ms: expect.any(Number),
      router_first_output_ms: expect.any(Number),
      router_first_stdout_ms: expect.any(Number),
      router_process_ms: expect.any(Number),
      router_parse_ms: expect.any(Number),
      router_stdout_bytes: 8,
      router_stderr_bytes: 0
    });
    expect(route.router_parse_ms).toBeGreaterThanOrEqual(0);
  });

  it("redacts proxy paths, query strings, and credentials from Router failures", async () => {
    const config = defaultConfig("/tmp/project");
    const runner: CodexRouteRunner = async () => {
      throw new Error(
        "proxy handshake failed at https://user:secret@proxy.test:8443/private/path?token=hidden "
        + "Authorization: Bearer bearer-secret OPENAI_API_KEY=sk-proj-routersecret "
        + "npm_abcdefghijklmnopqrstuvwxyz"
      );
    };

    const route = await routeRequestWithCodex("你好", config, runner);

    expect(route.reason).toContain("https://***@proxy.test:8443");
    expect(route.reason).not.toContain("user:secret");
    expect(route.reason).not.toContain("/private/path");
    expect(route.reason).not.toContain("hidden");
    expect(route.reason).not.toContain("bearer-secret");
    expect(route.reason).not.toContain("sk-proj-routersecret");
    expect(route.reason).not.toContain("npm_abcdefghijklmnopqrstuvwxyz");
  });

  it("fails safely when the router closes stdin before receiving the prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-input-error-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = ["-e", "require('node:fs').closeSync(0);setInterval(()=>{},1000)"];
    config.router.codex.timeoutMs = 2000;

    const route = await routeRequestWithCodex("x".repeat(4 * 1024 * 1024), config, undefined, root);

    expect(route).toMatchObject({
      mode: "simple",
      source: "fallback"
    });
    expect(route.reason).toContain(`Router ${routerCommandLabel(process.execPath)} input failed`);
    expect(route.duration_ms).toBeLessThan(1500);
    expect(route).toMatchObject({
      router_failure_kind: "input",
      router_failure_stage: "input",
      router_process_ms: expect.any(Number),
      router_stdout_bytes: 0,
      router_stderr_bytes: 0
    });
  }, 5000);

  it("passes configured environment variables to the router process", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-env-"));
    const config = defaultConfig(root);
    config.router.codex.command = process.execPath;
    config.router.codex.args = [
      "-e",
      "process.stdout.write(JSON.stringify({mode: process.env.ROUTER_MODE, reason: process.env.ROUTER_REASON}))"
    ];
    config.router.codex.env = {
      ROUTER_MODE: "simple",
      ROUTER_REASON: "proxy environment reached router"
    };

    const progress: string[] = [];
    const routeWithProgress = routeRequestWithCodex as unknown as (
      request: string,
      config: ReturnType<typeof defaultConfig>,
      runner: undefined,
      cwd: string,
      signal: undefined,
      onProgress: (event: { phase: string }) => void
    ) => ReturnType<typeof routeRequestWithCodex>;
    const route = await routeWithProgress(
      "你好",
      config,
      undefined,
      root,
      undefined,
      (event) => progress.push(event.phase)
    );

    expect(route).toMatchObject({
      mode: "simple",
      source: "codex",
      reason: "proxy environment reached router",
      router_dispatch_ms: expect.any(Number),
      router_spawn_ms: expect.any(Number),
      router_first_output_ms: expect.any(Number),
      router_first_stdout_ms: expect.any(Number),
      router_process_ms: expect.any(Number),
      router_parse_ms: expect.any(Number),
      router_stdout_bytes: expect.any(Number),
      router_stderr_bytes: 0
    });
    expect(route.duration_ms).toBeGreaterThanOrEqual(route.router_process_ms ?? 0);
    expect(route.router_stdout_bytes).toBeGreaterThan(0);
    expect(route.router_first_stderr_ms).toBeUndefined();
    expect(progress).toEqual([
      "dispatching",
      "starting",
      "waiting-output",
      "receiving-response",
      "parsing"
    ]);
  });

  it("summarizes noisy Codex router process errors before adding fallback reason", async () => {
    const config = defaultConfig("/tmp/project");
    config.router.codex.fallback = "complex";
    const runner: CodexRouteRunner = async () => {
      throw new Error(
        [
          "Codex router exited with code 2: error: unexpected argument '--ask-for-approval' found",
          "",
          "  tip: to pass '--ask-for-approval' as a value, use '-- --ask-for-approval'",
          "",
          "Usage: codex exec [OPTIONS] [PROMPT]",
          "       codex exec [OPTIONS] <COMMAND> [ARGS]",
          "",
          "For more information, try '--help'."
        ].join("\n")
      );
    };

    const route = await routeRequestWithCodex("做个俄罗斯方块的游戏", config, runner);

    expect(route.mode).toBe("complex");
    expect(route.reason).toBe(
      "Codex router failed: Codex router exited with code 2: error: unexpected argument '--ask-for-approval' found. Codex router fallback forced complex."
    );
    expect(route.reason).not.toContain("Usage:");
    expect(route.reason).not.toContain("tip:");
    expect(route.reason).not.toContain("\n");
  });

  it("supports an explicit complex fallback without local rules", async () => {
    const config = defaultConfig("/tmp/project");
    config.router.codex.fallback = "complex";
    const runner: CodexRouteRunner = async () => "not json";

    const route = await routeRequestWithCodex("实现一个大型功能", config, runner);

    expect(route.mode).toBe("complex");
    expect(route.reason).toContain("Codex router fallback forced complex.");
  });
});

function killProcessGroupIfAlive(pid: number): void {
  if (pid <= 0 || !processIsAlive(pid)) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    process.kill(pid, "SIGKILL");
  }
}
