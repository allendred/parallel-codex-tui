import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import {
  diagnoseAgentCapabilities,
  type CapabilityCommandRunner
} from "../src/workers/capabilities.js";

const CODEX_ROOT_HELP = [
  "Usage: codex [OPTIONS] [PROMPT]",
  "--ask-for-approval <APPROVAL_POLICY>"
].join("\n");

const CODEX_EXEC_HELP = [
  "Usage: codex exec [OPTIONS] [PROMPT]",
  "--sandbox <SANDBOX_MODE>",
  "--add-dir <DIR>",
  "--skip-git-repo-check"
].join("\n");

const CODEX_EXEC_RESUME_HELP = [
  "Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]",
  "--skip-git-repo-check"
].join("\n");

const CODEX_NATIVE_HELP = [
  "Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]",
  "--sandbox <SANDBOX_MODE>",
  "--add-dir <DIR>"
].join("\n");

const CLAUDE_HELP = [
  "Usage: claude [options] [command] [prompt]",
  "--print",
  "--resume [value]",
  "--permission-mode <mode>",
  "--add-dir <directories...>"
].join("\n");

describe("diagnoseAgentCapabilities", () => {
  it("verifies every CLI surface required by active Codex and Claude roles", async () => {
    const config = defaultConfig("/tmp/project");
    const runner = vi.fn<CapabilityCommandRunner>(async (command, args) => ({
      exitCode: 0,
      stdout: helpFor(command, args),
      stderr: "",
      timedOut: false
    }));

    const result = await diagnoseAgentCapabilities(config, {}, {
      includeRouter: true,
      workerEngines: ["codex", "claude"],
      availableCommands: new Set(["codex", "claude"]),
      runner
    });

    expect(result).toEqual({
      ok: true,
      lines: [
        "codex capabilities: ok (approval policy, exec sandbox/add-dir, exec resume, native resume sandbox/add-dir)",
        "claude capabilities: ok (print/resume/permissions/add-dir)",
        "native workspace trust: interactive (confirm only workspaces you trust when prompted)"
      ]
    });
    expect(runner).toHaveBeenCalledTimes(5);
  });

  it("fails when recognized Codex help is missing the root approval option", async () => {
    const config = defaultConfig("/tmp/project");
    const runner: CapabilityCommandRunner = async (command, args) => ({
      exitCode: 0,
      stdout: args[0] === "--help"
        ? "Usage: codex [OPTIONS] [PROMPT]"
        : helpFor(command, args),
      stderr: "",
      timedOut: false
    });

    const result = await diagnoseAgentCapabilities(config, {}, {
      includeRouter: false,
      workerEngines: ["codex"],
      availableCommands: new Set(["codex"]),
      runner
    });

    expect(result.ok).toBe(false);
    expect(result.lines).toContain(
      "codex capabilities: incompatible (approval policy missing --ask-for-approval)"
    );
  });

  it("fails when recognized Codex help is missing a required native attach option", async () => {
    const config = defaultConfig("/tmp/project");
    const runner: CapabilityCommandRunner = async (_command, args) => ({
      exitCode: 0,
      stdout: args[0] === "resume"
        ? "Usage: codex resume [OPTIONS] [SESSION_ID]\n--sandbox <SANDBOX_MODE>"
        : helpFor("codex", args),
      stderr: "",
      timedOut: false
    });

    const result = await diagnoseAgentCapabilities(config, {}, {
      includeRouter: false,
      workerEngines: ["codex"],
      availableCommands: new Set(["codex"]),
      runner
    });

    expect(result.ok).toBe(false);
    expect(result.lines).toContain(
      "codex capabilities: incompatible (native resume sandbox/add-dir missing --add-dir)"
    );
  });

  it("warns without failing when a third-party wrapper does not expose recognizable help", async () => {
    const config = defaultConfig("/tmp/project");
    config.workers.codex.command = "vendor-coder";
    config.workers.codex.interactive.command = "vendor-coder";

    const result = await diagnoseAgentCapabilities(config, {}, {
      includeRouter: false,
      workerEngines: ["codex"],
      availableCommands: new Set(["vendor-coder"]),
      runner: async () => ({
        exitCode: 0,
        stdout: "vendor coder 1.0",
        stderr: "",
        timedOut: false
      })
    });

    expect(result.ok).toBe(true);
    expect(result.lines).toContain(
      "codex capabilities (vendor-coder): warning (approval policy help not recognized; exec sandbox/add-dir help not recognized; exec resume help not recognized; native resume sandbox/add-dir help not recognized; compatibility unverified)"
    );
  });

  it("trusts an explicit generic CLI contract without probing vendor-specific help", async () => {
    const config = defaultConfig("/tmp/project");
    config.workers.codex.command = "vendor-coder";
    config.workers.codex.interactive.command = "vendor-coder";
    config.workers.codex.capabilities = {
      profile: "generic",
      writableDirArgs: ["--allow-root", "{dir}"],
      freshSessionArgs: ["--new-session", "{sessionId}"]
    };
    const runner = vi.fn<CapabilityCommandRunner>();

    const result = await diagnoseAgentCapabilities(config, {}, {
      includeRouter: false,
      workerEngines: ["codex"],
      availableCommands: new Set(["vendor-coder"]),
      runner
    });

    expect(result.ok).toBe(true);
    expect(result.lines).toContain(
      "codex capabilities (vendor-coder): declared (generic CLI, writable dirs via template, client-assigned fresh session, native resume configured)"
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a generic native resume contract that drops the session id", async () => {
    const config = defaultConfig("/tmp/project");
    config.workers.codex.capabilities.profile = "generic";
    config.workers.codex.nativeSession.resumeArgs = ["resume"];

    const result = await diagnoseAgentCapabilities(config, {}, {
      includeRouter: false,
      workerEngines: ["codex"],
      availableCommands: new Set(["codex"])
    });

    expect(result.ok).toBe(false);
    expect(result.lines).toContain(
      "codex capabilities: incompatible (nativeSession.resumeArgs missing {sessionId})"
    );
  });

  it("rejects an explicit read-only Codex native sandbox before attach", async () => {
    const config = defaultConfig("/tmp/project");
    config.workers.codex.interactive.args = ["resume", "{sessionId}", "--sandbox", "read-only"];

    const result = await diagnoseAgentCapabilities(config, {}, {
      includeRouter: false,
      workerEngines: ["codex"],
      availableCommands: new Set(["codex"]),
      runner: async (command, args) => ({
        exitCode: 0,
        stdout: helpFor(command, args),
        stderr: "",
        timedOut: false
      })
    });

    expect(result.ok).toBe(false);
    expect(result.lines).toContain(
      "codex capabilities: incompatible (native resume uses read-only but feature attach requires writable --add-dir roots)"
    );
  });
});

function helpFor(command: string, args: string[]): string {
  if (command === "claude") {
    return CLAUDE_HELP;
  }
  if (args[0] === "--help") {
    return CODEX_ROOT_HELP;
  }
  if (args[0] === "exec" && args[1] === "resume") {
    return CODEX_EXEC_RESUME_HELP;
  }
  if (args[0] === "resume") {
    return CODEX_NATIVE_HELP;
  }
  return CODEX_EXEC_HELP;
}
