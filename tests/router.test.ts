import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import * as router from "../src/core/router.js";
import { routeRequestWithCodex } from "../src/core/router.js";
import type { CodexRouteRunner } from "../src/core/router.js";

describe("routeRequestWithCodex", () => {
  it("does not expose a local heuristic routeRequest API", () => {
    expect("routeRequest" in router).toBe(false);
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
    config.router.codex.args = ["-e", "setInterval(() => {}, 1000)"];
    config.router.codex.timeoutMs = 25;

    const route = await routeRequestWithCodex("你好", config, undefined, root);

    expect(route).toMatchObject({
      mode: "simple",
      source: "fallback",
      suggested_roles: []
    });
    expect(route.reason).toContain("timed out after 25ms");
    expect(route.duration_ms).toBeGreaterThanOrEqual(20);
    expect(route.duration_ms).toBeLessThan(1000);
  });

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

    const route = await routeRequestWithCodex("你好", config, undefined, root);

    expect(route).toMatchObject({
      mode: "simple",
      source: "codex",
      reason: "proxy environment reached router"
    });
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
