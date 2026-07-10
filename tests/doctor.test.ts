import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { diagnoseProxyEnvironment, isSupportedNodeVersion } from "../src/doctor.js";

describe("isSupportedNodeVersion", () => {
  it("requires a Node.js version where node:sqlite does not print experimental warnings", () => {
    expect(isSupportedNodeVersion("22.5.1")).toBe(false);
    expect(isSupportedNodeVersion("22.13.0")).toBe(false);
    expect(isSupportedNodeVersion("25.7.0")).toBe(false);
    expect(isSupportedNodeVersion("26.0.0")).toBe(true);
  });
});

describe("diagnoseProxyEnvironment", () => {
  it("warns when a macOS system proxy is not inherited by Codex subprocesses", async () => {
    const config = defaultConfig("/tmp/project");

    const result = await diagnoseProxyEnvironment(
      config,
      {},
      { host: "127.0.0.1", port: 7890 },
      async () => true
    );

    expect(result.ok).toBe(true);
    expect(result.lines).toContain(
      "router proxy: warning (macOS system proxy 127.0.0.1:7890 is not inherited; configure [router.codex.env])"
    );
    expect(result.lines).toContain(
      "workers.codex proxy: warning (macOS system proxy 127.0.0.1:7890 is not inherited; configure [workers.codex.model.env])"
    );
  });

  it("reports reachable configured proxy endpoints without exposing credentials", async () => {
    const config = defaultConfig("/tmp/project");
    config.router.codex.env.HTTPS_PROXY = "http://user:secret@127.0.0.1:7890";
    config.workers.codex.model.env.ALL_PROXY = "socks5h://127.0.0.1:7890";
    const checked: string[] = [];

    const result = await diagnoseProxyEnvironment(config, {}, null, async (host, port) => {
      checked.push(`${host}:${port}`);
      return true;
    });

    expect(result.ok).toBe(true);
    expect(result.lines).toEqual([
      "router proxy: ok (127.0.0.1:7890)",
      "workers.codex proxy: ok (127.0.0.1:7890)"
    ]);
    expect(result.lines.join("\n")).not.toContain("secret");
    expect(checked).toEqual(["127.0.0.1:7890"]);
  });

  it("fails when a configured proxy endpoint cannot be reached", async () => {
    const config = defaultConfig("/tmp/project");
    config.router.codex.env.HTTPS_PROXY = "http://127.0.0.1:7890";

    const result = await diagnoseProxyEnvironment(config, {}, null, async () => false);

    expect(result.ok).toBe(false);
    expect(result.lines).toContain("router proxy: unreachable (127.0.0.1:7890)");
  });
});
