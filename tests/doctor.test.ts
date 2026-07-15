import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import {
  diagnoseProxyEnvironment,
  isSupportedNodeVersion,
  runRuntimePreflight
} from "../src/doctor.js";

describe("isSupportedNodeVersion", () => {
  it("accepts Node.js versions where node:sqlite is a release candidate", () => {
    expect(isSupportedNodeVersion("22.5.1")).toBe(false);
    expect(isSupportedNodeVersion("22.13.0")).toBe(false);
    expect(isSupportedNodeVersion("24.14.1")).toBe(false);
    expect(isSupportedNodeVersion("24.15.0")).toBe(true);
    expect(isSupportedNodeVersion("25.7.0")).toBe(true);
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
      "router proxy: reachable (127.0.0.1:7890; local endpoint only)",
      "workers.codex proxy: reachable (127.0.0.1:7890; local endpoint only)"
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

describe("runRuntimePreflight", () => {
  it("checks workspace access, active CLIs, model env, capabilities, proxy, and native trust together", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-runtime-preflight-"));
    const config = defaultConfig(workspace);
    config.router.defaultMode = "complex";
    config.pairing.judge = "codex";
    config.pairing.actor = "claude";
    config.pairing.critic = "codex";
    config.workers.codex.command = process.execPath;
    config.workers.codex.interactive.command = process.execPath;
    config.workers.claude.command = process.execPath;
    config.workers.claude.interactive.command = process.execPath;
    config.workers.codex.capabilities.profile = "generic";
    config.workers.claude.capabilities.profile = "generic";
    config.workers.codex.model.env.OPENAI_API_KEY = "{env:OPENAI_API_KEY}";
    config.workers.codex.model.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const capabilityRunner = vi.fn();

    const result = await runRuntimePreflight(config, workspace, {}, {
      systemProxy: null,
      proxyConnector: async () => false,
      capabilityRunner
    });

    expect(result.ok).toBe(false);
    expect(result.lines).toContain("workspace permissions: ok (read/write/search)");
    expect(result.lines).toContain(`${process.execPath}: ok`);
    expect(result.lines).toContain(
      "workers.codex.model.env.OPENAI_API_KEY: missing env OPENAI_API_KEY"
    );
    expect(result.lines).toContain(
      "codex capabilities (node): declared (generic CLI, writable dirs via template, output-detected fresh session, native resume configured)"
    );
    expect(result.lines).toContain(
      "claude capabilities (node): declared (generic CLI, writable dirs via template, client-assigned fresh session, native resume configured)"
    );
    expect(result.lines).toContain("workers.codex proxy: unreachable (127.0.0.1:7890)");
    expect(result.lines).toContain(
      "native workspace trust: interactive (confirm only workspaces you trust when prompted)"
    );
    expect(capabilityRunner).not.toHaveBeenCalled();
  });

  it("reports a missing workspace as a permission failure without throwing", async () => {
    const workspace = join(tmpdir(), `pct-runtime-preflight-missing-${process.pid}-${Date.now()}`);
    const config = defaultConfig(workspace);
    config.router.defaultMode = "complex";
    config.pairing.judge = "mock";
    config.pairing.actor = "mock";
    config.pairing.critic = "mock";

    const result = await runRuntimePreflight(config, workspace, {}, { systemProxy: null });

    expect(result).toEqual({
      ok: false,
      lines: [`workspace permissions: denied (${workspace}; need read/write/search)`]
    });
  });
});
