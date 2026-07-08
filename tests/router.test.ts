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

  it("falls back to configured non-rule routing when Codex returns invalid JSON", async () => {
    const config = defaultConfig("/tmp/project");
    const runner: CodexRouteRunner = async () => "not json";

    const route = await routeRequestWithCodex("你好", config, runner);

    expect(route.mode).toBe("complex");
    expect(route.reason).toContain("Codex router failed");
    expect(route.reason).toContain("Codex router fallback forced complex.");
  });

  it("supports an explicit simple fallback without local rules", async () => {
    const config = defaultConfig("/tmp/project");
    config.router.codex.fallback = "simple";
    const runner: CodexRouteRunner = async () => "not json";

    const route = await routeRequestWithCodex("实现一个大型功能", config, runner);

    expect(route.mode).toBe("simple");
    expect(route.reason).toContain("Codex router fallback forced simple.");
  });
});
