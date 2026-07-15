import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import {
  assignableWorkerProviderIds,
  workerProvider,
  workerProviderLabel,
  workerProviders
} from "../src/workers/provider.js";
import { createWorkerRegistry } from "../src/workers/registry.js";

describe("Worker providers", () => {
  it("enumerates configured providers and excludes non-assignable mock from Feature cycling", () => {
    const config = defaultConfig("/tmp/project");

    expect(workerProviders(config).map((provider) => provider.id)).toEqual(["claude", "codex", "mock"]);
    expect(assignableWorkerProviderIds(config)).toEqual(["claude", "codex"]);
    expect(workerProvider(config, "codex").config.command).toBe("codex");
  });

  it("registers and labels a named provider without a hard-coded engine branch", () => {
    const config = defaultConfig("/tmp/project");
    config.workers.vendor = {
      ...config.workers.codex,
      command: "vendor-coder",
      model: {
        ...config.workers.codex.model,
        name: "vendor-model",
        provider: "openai-compatible"
      }
    };

    expect(createWorkerRegistry(config).has("vendor")).toBe(true);
    expect(workerProviderLabel(config, "vendor")).toBe("vendor/vendor-model/openai-compatible");
    expect(workerProviderLabel(config, "removed-provider")).toBe("removed-provider");
  });

  it("reports a removed provider instead of falling through to another Worker", () => {
    const config = defaultConfig("/tmp/project");

    expect(() => workerProvider(config, "removed-provider")).toThrow(
      "Worker provider is not configured: removed-provider"
    );
  });
});
