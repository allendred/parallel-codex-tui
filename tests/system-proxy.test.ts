import { describe, expect, it, vi } from "vitest";
import {
  inheritMacSystemProxy,
  parseMacSystemProxySettings
} from "../src/core/system-proxy.js";

const enabledProxy = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
    2 : <local>
    3 : localhost
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : ::1
}`;

describe("macOS system proxy inheritance", () => {
  it("parses enabled HTTP, HTTPS, SOCKS, and bypass settings", () => {
    expect(parseMacSystemProxySettings(enabledProxy)).toEqual({
      http: { host: "127.0.0.1", port: 7890 },
      https: { host: "127.0.0.1", port: 7890 },
      socks: { host: "::1", port: 7891 },
      exceptions: ["127.0.0.1", ".local", "localhost"]
    });
  });

  it("adds missing proxy variables without replacing explicit environment", async () => {
    const env: NodeJS.ProcessEnv = {
      https_proxy: "http://explicit.test:8443",
      NO_PROXY: "custom.test"
    };
    const readSettings = vi.fn(async () => enabledProxy);

    await expect(inheritMacSystemProxy(env, { platform: "darwin", readSettings })).resolves.toEqual([
      "HTTP_PROXY",
      "ALL_PROXY"
    ]);

    expect(env).toEqual({
      https_proxy: "http://explicit.test:8443",
      NO_PROXY: "custom.test",
      HTTP_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5h://[::1]:7891"
    });
    expect(readSettings).toHaveBeenCalledOnce();
  });

  it("inherits every available setting when the environment is direct", async () => {
    const env: NodeJS.ProcessEnv = {};

    await expect(inheritMacSystemProxy(env, {
      platform: "darwin",
      readSettings: async () => enabledProxy
    })).resolves.toEqual(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);

    expect(env).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "socks5h://[::1]:7891",
      NO_PROXY: "127.0.0.1,.local,localhost"
    });
  });

  it("supports opt-out and leaves non-macOS environments untouched", async () => {
    const disabledRead = vi.fn(async () => enabledProxy);
    await expect(inheritMacSystemProxy(
      { PARALLEL_CODEX_INHERIT_SYSTEM_PROXY: "0" },
      { platform: "darwin", readSettings: disabledRead }
    )).resolves.toEqual([]);
    expect(disabledRead).not.toHaveBeenCalled();

    const linuxRead = vi.fn(async () => enabledProxy);
    await expect(inheritMacSystemProxy({}, {
      platform: "linux",
      readSettings: linuxRead
    })).resolves.toEqual([]);
    expect(linuxRead).not.toHaveBeenCalled();
  });

  it("does not add bypass settings when every system proxy is disabled", async () => {
    const env: NodeJS.ProcessEnv = {};
    const disabledProxy = enabledProxy
      .replace("HTTPEnable : 1", "HTTPEnable : 0")
      .replace("HTTPSEnable : 1", "HTTPSEnable : 0")
      .replace("SOCKSEnable : 1", "SOCKSEnable : 0");

    await expect(inheritMacSystemProxy(env, {
      platform: "darwin",
      readSettings: async () => disabledProxy
    })).resolves.toEqual([]);
    expect(env).toEqual({});
  });
});
