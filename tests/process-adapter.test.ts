import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, readTextIfExists, writeText } from "../src/core/file-store.js";
import { WorkerStatusSchema } from "../src/domain/schemas.js";
import { ProcessWorkerAdapter } from "../src/workers/process-adapter.js";

describe("ProcessWorkerAdapter", () => {
  it("streams process output into output.log", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-"));
    const filesDir = join(root, "main-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log('PROMPT:'+input.trim())});";

    await writeText(promptPath, "hello process");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "main-node",
      role: "main",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "hello process"
    });

    expect(result.exitCode).toBe(0);
    expect(await readTextIfExists(outputLogPath)).toContain("PROMPT:hello process");

    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.state).toBe("done");
  });

  it("waits for the full prompt to flush into worker stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-large-prompt-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const request = "做个俄罗斯方块的游戏";
    const prompt = `${request}\n${"细节".repeat(250000)}`;
    const script = [
      "let input='';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  input += chunk;",
      "  process.stdin.pause();",
      "  setTimeout(() => process.stdin.resume(), 1);",
      "});",
      "process.stdin.on('end', () => {",
      "  console.log('LEN:' + Buffer.byteLength(input, 'utf8'));",
      "  console.log('HAS_REQUEST:' + input.includes('做个俄罗斯方块的游戏'));",
      "  console.log('TAIL:' + input.slice(-6));",
      "});"
    ].join("");

    await writeText(promptPath, prompt);

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt
    });

    expect(result.exitCode).toBe(0);
    const output = await readTextIfExists(outputLogPath);
    expect(output).toContain(`LEN:${Buffer.byteLength(prompt, "utf8")}`);
    expect(output).toContain("HAS_REQUEST:true");
    expect(output).toContain("TAIL:细节细节细节");
  });

  it("updates worker status when output arrives", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-progress-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "console.log('working on renderer');setTimeout(()=>process.exit(0),200)";

    await writeText(promptPath, "hello process");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const resultPromise = adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "hello process"
    });

    const runningStatus = await waitForStatusPhase(statusPath, "process-output");
    expect(runningStatus.state).toBe("running");
    expect(runningStatus.summary).toContain("working on renderer");
    expect(await readTextIfExists(outputLogPath)).toContain("working on renderer");

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
  });

  it("fails workers that stop producing output for the idle timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-idle-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "setInterval(() => {}, 1000)";

    await writeText(promptPath, "hello process");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "hello process",
      idleTimeoutMs: 25
    });

    expect(result.exitCode).not.toBe(0);
    expect(await readTextIfExists(outputLogPath)).toContain("Process idle timed out after 25ms");

    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.state).toBe("failed");
    expect(status.phase).toBe("process-idle-timeout");
  });

  it("reports a first-output timeout when a process never emits output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-first-output-"));
    const filesDir = join(root, "critic-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "setInterval(() => {}, 1000)";

    await writeText(promptPath, "review this");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "critic-node",
      role: "critic",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "review this",
      firstOutputTimeoutMs: 25,
      idleTimeoutMs: 500
    });

    expect(result.exitCode).not.toBe(0);
    expect(await readTextIfExists(outputLogPath)).toContain("Process produced no first output after 25ms");

    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.state).toBe("failed");
    expect(status.phase).toBe("process-first-output-timeout");
  });

  it("uses resume args when a native session is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-resume-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "console.log(process.argv.slice(1).join('|'))";

    await writeText(promptPath, "resume prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script, "normal"]);
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "resume prompt",
      nativeSession: {
        engine: "mock",
        role: "actor",
        worker_id: "actor-node",
        session_id: "abc123",
        scope: "task",
        cwd: root,
        created_at: "2026-06-30T03:30:00.000Z",
        last_used_at: "2026-06-30T03:30:00.000Z",
        source: "manual"
      },
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: ["-e", script, "resume", "{sessionId}"],
        detectSessionId: true,
        fallback: "fail"
      }
    });

    expect(result.exitCode).toBe(0);
    const output = await readTextIfExists(outputLogPath);
    expect(output).toContain("$ ");
    expect(output).toContain("resume abc123");
    expect(output).toContain("resume|abc123");
    expect(output).not.toContain("normal");
  });

  it("detects native session ids from process output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-detect-session-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "console.log('session id: native-123')";
    const detected: string[] = [];

    await writeText(promptPath, "hello");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "hello",
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: ["resume", "{sessionId}", "-"],
        detectSessionId: true,
        fallback: "fail"
      },
      onNativeSession: (sessionId) => {
        detected.push(sessionId);
      }
    });

    expect(result.exitCode).toBe(0);
    expect(detected).toEqual(["native-123"]);
    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.native_session_id).toBe("native-123");
  });

  it("marks resume command failures with native resume phase", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-resume-failure-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");

    await writeText(promptPath, "resume prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", "process.exit(0)"]);
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "resume prompt",
      nativeSession: {
        engine: "mock",
        role: "actor",
        worker_id: "actor-node",
        session_id: "abc123",
        scope: "task",
        cwd: root,
        created_at: "2026-06-30T03:30:00.000Z",
        last_used_at: "2026-06-30T03:30:00.000Z",
        source: "manual"
      },
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: ["-e", "process.exit(7)", "{sessionId}"],
        detectSessionId: true,
        fallback: "fail"
      }
    });

    expect(result.exitCode).toBe(7);
    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.state).toBe("failed");
    expect(status.phase).toBe("native-resume-failed");
  });

  it("falls back to a fresh native session when resume is unrecoverable and fallback is new", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-resume-fallback-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = [
      "const mode = process.argv[1];",
      "if (mode === 'resume') {",
      "  console.error(\"ERROR: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.\");",
      "  process.exit(1);",
      "}",
      "console.log('fresh run');",
      "console.log('session id: fresh-123');"
    ].join("");
    const detected: string[] = [];
    const retired: string[] = [];

    await writeText(promptPath, "resume prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script, "normal"]);
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "resume prompt",
      nativeSession: {
        engine: "mock",
        role: "actor",
        worker_id: "actor-node",
        session_id: "abc123",
        scope: "task",
        cwd: root,
        created_at: "2026-06-30T03:30:00.000Z",
        last_used_at: "2026-06-30T03:30:00.000Z",
        source: "manual"
      },
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: ["-e", script, "resume", "{sessionId}"],
        detectSessionId: true,
        fallback: "new"
      },
      onNativeSession: (sessionId) => {
        detected.push(sessionId);
      },
      onNativeSessionRetired: (sessionId) => {
        retired.push(sessionId);
      }
    });

    expect(result.exitCode).toBe(0);
    expect(retired).toEqual(["abc123"]);
    expect(detected).toEqual(["fresh-123"]);
    const output = await readTextIfExists(outputLogPath);
    expect(output).toContain("Native resume for abc123 is unrecoverable");
    expect(output).toContain("fresh run");
    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.state).toBe("done");
    expect(status.phase).toBe("process-exited");
    expect(status.native_session_id).toBe("fresh-123");
  });

  it("does not start a fresh native session for generic resume failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-resume-generic-failure-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const retired: string[] = [];

    await writeText(promptPath, "resume prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", "console.log('normal should not run')"]);
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "resume prompt",
      nativeSession: {
        engine: "mock",
        role: "actor",
        worker_id: "actor-node",
        session_id: "abc123",
        scope: "task",
        cwd: root,
        created_at: "2026-06-30T03:30:00.000Z",
        last_used_at: "2026-06-30T03:30:00.000Z",
        source: "manual"
      },
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: ["-e", "console.error('permission denied'); process.exit(1)", "{sessionId}"],
        detectSessionId: true,
        fallback: "new"
      },
      onNativeSessionRetired: (sessionId) => {
        retired.push(sessionId);
      }
    });

    expect(result.exitCode).toBe(1);
    expect(retired).toEqual([]);
    const output = await readTextIfExists(outputLogPath);
    expect(output).toContain("permission denied");
    expect(output).not.toContain("normal should not run");
  });

  it("injects configured model provider args and env into worker processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-model-provider-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = [
      "console.log(process.argv.slice(1).join('|'));",
      "console.log('BASE:'+process.env.OPENAI_BASE_URL);",
      "console.log('KEY:'+process.env.OPENAI_API_KEY)"
    ].join("");

    await writeText(promptPath, "model prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script, "normal"], "mock", {
      model: {
        name: "gpt-5.5",
        provider: "custom",
        args: ["--model", "{model}", "--provider", "{provider}"],
        env: {
          OPENAI_BASE_URL: "https://third-party.example/v1",
          OPENAI_API_KEY: "test-key"
        }
      }
    });
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "model prompt"
    });

    expect(result.exitCode).toBe(0);
    const output = await readTextIfExists(outputLogPath);
    expect(output).toContain("--model|gpt-5.5|--provider|custom");
    expect(output).toContain("BASE:https://third-party.example/v1");
    expect(output).toContain("KEY:test-key");
  });

  it("applies model provider args to native resume commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-resume-model-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "console.log(process.argv.slice(1).join('|'))";

    await writeText(promptPath, "resume prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script, "normal"], "mock", {
      model: {
        name: "claude-sonnet-4-6",
        provider: "anthropic-gateway",
        args: ["--model", "{model}", "--provider", "{provider}"]
      }
    });
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "resume prompt",
      nativeSession: {
        engine: "mock",
        role: "actor",
        worker_id: "actor-node",
        session_id: "abc123",
        scope: "task",
        cwd: root,
        created_at: "2026-06-30T03:30:00.000Z",
        last_used_at: "2026-06-30T03:30:00.000Z",
        source: "manual"
      },
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: ["-e", script, "resume", "{sessionId}"],
        detectSessionId: true,
        fallback: "fail"
      }
    });

    expect(result.exitCode).toBe(0);
    const output = await readTextIfExists(outputLogPath);
    expect(output).toContain("resume|abc123|--model|claude-sonnet-4-6|--provider|anthropic-gateway");
  });
});

async function waitForStatusPhase(path: string, phase: string) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const status = await readJson(path, WorkerStatusSchema);
      if (status.phase === phase) {
        return status;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for status phase ${phase}`);
}
