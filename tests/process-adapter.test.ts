import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pathExists, readJson, readTextIfExists, writeText } from "../src/core/file-store.js";
import { processIsAlive, workerProcessRecordPath } from "../src/core/process-ownership.js";
import { WorkerStatusSchema, type WorkerStatus } from "../src/domain/schemas.js";
import { ProcessWorkerAdapter } from "../src/workers/process-adapter.js";

describe("ProcessWorkerAdapter", () => {
  it("passes isolated worker coordination directories to Codex before the stdin prompt marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-codex-add-dir-"));
    const filesDir = join(root, "actor-codex");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const coordinationDir = join(root, "task files");
    const script = "console.log(process.argv.slice(1).join('|'))";
    await writeText(promptPath, "isolated prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script, "exec", "-"], "codex");
    const result = await adapter.run({
      workerId: "actor-codex",
      role: "actor",
      engine: "codex",
      cwd: root,
      writableDirs: [coordinationDir],
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "isolated prompt"
    });

    expect(result.exitCode).toBe(0);
    expect(await readTextIfExists(outputLogPath)).toContain(`exec|--add-dir|${coordinationDir}|-`);
  });

  it("forces isolated Codex workers back to workspace-write", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-codex-sandbox-"));
    const filesDir = join(root, "actor-codex");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "console.log(process.argv.slice(1).join('|'))";
    await writeText(promptPath, "isolated prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, [
      "-e",
      script,
      "exec",
      "--sandbox",
      "danger-full-access",
      "--dangerously-bypass-approvals-and-sandbox",
      "-"
    ], "codex");
    const result = await adapter.run({
      workerId: "actor-codex",
      role: "actor",
      engine: "codex",
      cwd: root,
      enforceWorkspaceIsolation: true,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "isolated prompt"
    });

    const output = await readTextIfExists(outputLogPath);
    expect(result.exitCode).toBe(0);
    expect(output).toContain("exec|--sandbox|workspace-write|-");
    expect(output).not.toContain("danger-full-access");
    expect(output).not.toContain("dangerously-bypass-approvals-and-sandbox");
  });

  it("forces isolated Claude workers back to acceptEdits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-claude-permissions-"));
    const filesDir = join(root, "actor-claude");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "console.log(process.argv.slice(1).join('|'))";
    await writeText(promptPath, "isolated prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, [
      "-e",
      script,
      "--",
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions"
    ], "claude");
    const result = await adapter.run({
      workerId: "actor-claude",
      role: "actor",
      engine: "claude",
      cwd: root,
      enforceWorkspaceIsolation: true,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "isolated prompt"
    });

    const output = await readTextIfExists(outputLogPath);
    expect(result.exitCode).toBe(0);
    expect(output).toContain("--permission-mode|acceptEdits");
    expect(output).not.toContain("bypassPermissions");
    expect(output).not.toContain("dangerously-skip-permissions");
  });

  it("passes isolated worker coordination directories to resumed Claude workers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-claude-add-dir-"));
    const filesDir = join(root, "critic-claude");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const coordinationDir = join(root, "task-files");
    const script = "console.log(process.argv.slice(1).join('|'))";
    await writeText(promptPath, "resume review");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script, "fresh"], "claude");
    const result = await adapter.run({
      workerId: "critic-claude",
      role: "critic",
      engine: "claude",
      cwd: root,
      writableDirs: [coordinationDir],
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "resume review",
      nativeSession: {
        engine: "claude",
        role: "critic",
        worker_id: "critic-claude",
        session_id: "session-123",
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
    expect(await readTextIfExists(outputLogPath)).toContain(`resume|session-123|--add-dir|${coordinationDir}`);
  });

  it("passes coordination directories through Codex exec before the resume subcommand", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-codex-resume-add-dir-"));
    const filesDir = join(root, "actor-codex");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const coordinationDir = join(root, "task-files");
    const script = "console.log(process.argv.slice(1).join('|'))";
    await writeText(promptPath, "resume implementation");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script, "fresh"], "codex");
    const result = await adapter.run({
      workerId: "actor-codex",
      role: "actor",
      engine: "codex",
      cwd: root,
      writableDirs: [coordinationDir],
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "resume implementation",
      enforceWorkspaceIsolation: true,
      nativeSession: {
        engine: "codex",
        role: "actor",
        worker_id: "actor-codex",
        session_id: "session-456",
        scope: "task",
        cwd: root,
        created_at: "2026-06-30T03:30:00.000Z",
        last_used_at: "2026-06-30T03:30:00.000Z",
        source: "manual"
      },
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: [
          "-e",
          script,
          "exec",
          "--sandbox",
          "danger-full-access",
          "--dangerously-bypass-approvals-and-sandbox",
          "resume",
          "{sessionId}",
          "-"
        ],
        detectSessionId: true,
        fallback: "fail"
      }
    });

    expect(result.exitCode).toBe(0);
    expect(await readTextIfExists(outputLogPath)).toContain(
      `exec|--sandbox|workspace-write|--add-dir|${coordinationDir}|resume|session-456|-`
    );
    expect(await readTextIfExists(outputLogPath)).not.toContain("danger-full-access");
  });

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

  it("preserves UTF-8 worker output split across process chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-split-utf8-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const output = Buffer.from("进度：开始实现\n", "utf8");
    const characterOffset = output.indexOf(Buffer.from("开", "utf8"));
    const first = output.subarray(0, characterOffset + 1).toString("base64");
    const second = output.subarray(characterOffset + 1).toString("base64");
    const script = [
      `process.stdout.write(Buffer.from(${JSON.stringify(first)},'base64'));`,
      `setTimeout(()=>process.stdout.end(Buffer.from(${JSON.stringify(second)},'base64')),80);`
    ].join("");
    await writeText(promptPath, "实现功能");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "actor-split-utf8",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "实现功能"
    });

    const log = await readTextIfExists(outputLogPath);
    expect(result.exitCode).toBe(0);
    expect(log).toContain("进度：开始实现\n");
    expect(log).not.toContain("�");
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
    const statusEvents: WorkerStatus[] = [];
    const resultPromise = adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "hello process",
      onStatus: (status) => {
        statusEvents.push(status);
      }
    });

    const runningStatus = await waitForStatusPhase(statusPath, "process-output");
    expect(runningStatus.state).toBe("running");
    expect(runningStatus.summary).toContain("working on renderer");
    expect(await readTextIfExists(outputLogPath)).toContain("working on renderer");

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(statusEvents.map((status) => status.phase)).toEqual([
      "process-starting",
      "process-output",
      "process-exited"
    ]);
  });

  it("does not let a status observer failure change a successful process result", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-status-observer-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    await writeText(promptPath, "hello observer");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", "console.log('success')"]);
    const result = await adapter.run({
      workerId: "actor-node",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "hello observer",
      onStatus: (status) => {
        if (status.phase === "process-output") {
          throw new Error("observer failed");
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(await readJson(statusPath, WorkerStatusSchema)).toMatchObject({
      state: "done",
      phase: "process-exited"
    });
  });

  it("keeps a silent worker in starting state until its first output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-starting-state-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "setTimeout(()=>console.log('first output'),400);setTimeout(()=>process.exit(0),500)";

    await writeText(promptPath, "wait for output");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const running = adapter.run({
      workerId: "actor-starting",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "wait for output",
      firstOutputTimeoutMs: 1000,
      idleTimeoutMs: 1000
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "starting",
      phase: "process-starting"
    });
    await expect(waitForStatusPhase(statusPath, "process-output")).resolves.toMatchObject({
      state: "running"
    });
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
  });

  it("records the owned child identity while running and clears it after exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-ownership-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const controller = new AbortController();
    const adapter = new ProcessWorkerAdapter(process.execPath, [
      "-e",
      "console.log('owned child ready');setInterval(()=>{},1000)"
    ]);

    const running = adapter.run({
      workerId: "actor-owned",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "keep running",
      signal: controller.signal
    });

    await waitForStatusPhase(statusPath, "process-output");
    await waitForPath(workerProcessRecordPath(filesDir));
    const record = JSON.parse(await readTextIfExists(workerProcessRecordPath(filesDir))) as {
      worker_id: string;
      pid: number;
      process_group_id?: number;
      process_start_token?: string;
    };
    expect(record.worker_id).toBe("actor-owned");
    expect(processIsAlive(record.pid)).toBe(true);
    expect(record.process_group_id).toBe(process.platform === "win32" ? undefined : record.pid);
    expect(record.process_start_token).toEqual(expect.any(String));

    controller.abort();
    await running;
    expect(await pathExists(workerProcessRecordPath(filesDir))).toBe(false);
  });

  it("cancels a running worker through AbortSignal and persists cancelled state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-cancel-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const controller = new AbortController();
    const script = "console.log('ready to cancel');setInterval(() => {}, 1000)";

    await writeText(promptPath, "cancel me");
    await writeText(outputLogPath, "");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const running = adapter.run({
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "cancel me",
      signal: controller.signal
    });

    await waitForStatusPhase(statusPath, "process-output");
    controller.abort();
    const result = await running;
    const status = await readJson(statusPath, WorkerStatusSchema);

    expect(result.cancelled).toBe(true);
    expect(status.state).toBe("cancelled");
    expect(status.phase).toBe("process-cancelled");
    expect(await readTextIfExists(outputLogPath)).toContain("Process cancelled by user");
  });

  it("force kills a cancelled worker that ignores SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-force-cancel-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const controller = new AbortController();
    const script = "process.on('SIGTERM',()=>{});console.log('ignoring term');setInterval(()=>{},1000)";

    await writeText(promptPath, "force cancel me");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const running = adapter.run({
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "force cancel me",
      signal: controller.signal
    });

    await waitForStatusPhase(statusPath, "process-output");
    controller.abort();
    await expect(waitForStatusPhase(statusPath, "process-stopping")).resolves.toMatchObject({
      state: "running",
      phase: "process-stopping"
    });
    const result = await running;

    expect(result.cancelled).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "cancelled",
      phase: "process-cancelled"
    });
  }, 5000);

  it("keeps a total timeout failed when the worker exits zero on SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-timeout-zero-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";

    await writeText(promptPath, "time out cleanly");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "actor-timeout-zero",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "time out cleanly",
      // Give the child time to install its SIGTERM handler under parallel CI load.
      timeoutMs: 1000
    });

    expect(result.exitCode).toBe(0);
    expect(result.failure).toEqual({
      phase: "process-timeout",
      summary: `${process.execPath} exceeded 1000ms`
    });
    expect(await readTextIfExists(outputLogPath)).toContain("Process timed out after 1000ms");
    await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-timeout"
    });
    expect(await pathExists(workerProcessRecordPath(filesDir))).toBe(false);
  });

  it("force kills a timed-out worker that ignores SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-force-timeout-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";

    await writeText(promptPath, "force timeout");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "actor-force-timeout",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "force timeout",
      // Give the child time to install its SIGTERM handler under parallel CI load.
      timeoutMs: 1000
    });

    expect(result.signal).toBe("SIGKILL");
    expect(result.failure).toEqual({
      phase: "process-timeout",
      summary: `${process.execPath} exceeded 1000ms`
    });
    await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-timeout"
    });
  }, 5000);

  it("does not finish a timed-out worker while a descendant remains alive", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-process-descendant-timeout-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const parentPidPath = join(root, "parent.pid");
    const childPidPath = join(root, "child.pid");
    const descendantScript = [
      "const {writeFileSync}=require('node:fs');",
      `writeFileSync(${JSON.stringify(childPidPath)},String(process.pid));`,
      "process.on('SIGTERM',()=>{});",
      "process.send?.('ready');",
      "setInterval(()=>{},1000);"
    ].join("");
    const script = [
      "const {spawn}=require('node:child_process');",
      "const {writeFileSync}=require('node:fs');",
      `writeFileSync(${JSON.stringify(parentPidPath)},String(process.pid));`,
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:['ignore','ignore','ignore','ipc']});`,
      "child.once('message',()=>console.log('descendant ready'));",
      "setInterval(()=>{},1000);"
    ].join("");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);

    let parentPid = 0;
    let childPid = 0;
    try {
      const result = await adapter.run({
        workerId: "actor-descendant-timeout",
        role: "actor",
        engine: "mock",
        cwd: root,
        filesDir,
        promptPath,
        outputLogPath,
        statusPath,
        prompt: "stop every descendant",
        timeoutMs: 2000,
        idleTimeoutMs: 150
      });
      parentPid = Number(await readFile(parentPidPath, "utf8"));
      childPid = Number(await readFile(childPidPath, "utf8"));

      expect(result.failure?.phase).toBe("process-idle-timeout");
      expect(processIsAlive(parentPid)).toBe(false);
      expect(processIsAlive(childPid)).toBe(false);
      expect(await pathExists(workerProcessRecordPath(filesDir))).toBe(false);
    } finally {
      killProcessGroupIfAlive(parentPid, childPid);
    }
  }, 5000);

  it("cleans up Worker descendants after a successful parent exit", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-process-descendant-success-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const parentPidPath = join(root, "parent.pid");
    const childPidPath = join(root, "child.pid");
    const descendantScript = [
      "const {writeFileSync}=require('node:fs');",
      `writeFileSync(${JSON.stringify(childPidPath)},String(process.pid));`,
      "process.on('SIGTERM',()=>{});",
      "process.send?.('ready');",
      "process.disconnect?.();",
      "setInterval(()=>{},1000);"
    ].join("");
    const script = [
      "const {spawn}=require('node:child_process');",
      "const {writeFileSync}=require('node:fs');",
      `writeFileSync(${JSON.stringify(parentPidPath)},String(process.pid));`,
      `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:['ignore','ignore','ignore','ipc']});`,
      "child.once('message',()=>{console.log('parent done');process.exit(0)});"
    ].join("");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);

    let parentPid = 0;
    let childPid = 0;
    try {
      const result = await adapter.run({
        workerId: "actor-descendant-success",
        role: "actor",
        engine: "mock",
        cwd: root,
        filesDir,
        promptPath,
        outputLogPath,
        statusPath,
        prompt: "finish cleanly",
        timeoutMs: 2000
      });
      parentPid = Number(await readFile(parentPidPath, "utf8"));
      childPid = Number(await readFile(childPidPath, "utf8"));

      expect(result.exitCode).toBe(0);
      expect(result.failure).toBeUndefined();
      expect(processIsAlive(parentPid)).toBe(false);
      expect(processIsAlive(childPid)).toBe(false);
      expect(await pathExists(workerProcessRecordPath(filesDir))).toBe(false);
    } finally {
      killProcessGroupIfAlive(parentPid, childPid);
    }
  }, 5000);

  it("fails closed and keeps ownership evidence when Worker cleanup is denied", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-process-cleanup-denied-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const pidPath = join(root, "worker.pid");
    const script = [
      "const {writeFileSync}=require('node:fs');",
      `writeFileSync(${JSON.stringify(pidPath)},String(process.pid));`,
      "console.log('ready');",
      "setInterval(()=>{},1000);"
    ].join("");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
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
      const result = await adapter.run({
        workerId: "actor-cleanup-denied",
        role: "actor",
        engine: "mock",
        cwd: root,
        filesDir,
        promptPath,
        outputLogPath,
        statusPath,
        prompt: "fail closed",
        timeoutMs: 2000,
        idleTimeoutMs: 150
      });
      pid = Number(await readFile(pidPath, "utf8"));

      expect(result.failure).toMatchObject({
        phase: "process-cleanup-error",
        summary: expect.stringContaining(`Could not terminate ${process.execPath} worker process ${pid}`)
      });
      await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
        state: "failed",
        phase: "process-cleanup-error"
      });
      expect(await pathExists(workerProcessRecordPath(filesDir))).toBe(true);
      expect(processIsAlive(pid)).toBe(true);
      expect(await readTextIfExists(outputLogPath)).toContain("Process tree cleanup failed");
    } finally {
      killSpy.mockRestore();
      killProcessGroupIfAlive(pid, pid);
    }
  }, 5000);

  it("fails cleanly when a worker closes stdin before receiving the prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-input-error-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const prompt = "x".repeat(4 * 1024 * 1024);
    const script = "require('node:fs').closeSync(0);setInterval(()=>{},1000)";

    await writeText(promptPath, prompt);
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "actor-input-error",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt,
      timeoutMs: 2000
    });

    expect(result.failure?.phase).toBe("process-input-error");
    expect(await readTextIfExists(outputLogPath)).toContain("Process input failed");
    await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-input-error"
    });
  }, 5000);

  it("fails workers that stop producing output for the idle timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-idle-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "console.log('worker started');process.on('SIGTERM',()=>process.exit(0));setInterval(() => {}, 1000)";

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
      idleTimeoutMs: 1000
    });

    expect(result.exitCode).toBe(0);
    expect(result.failure).toEqual({
      phase: "process-idle-timeout",
      summary: `${process.execPath} produced no output for 1000ms`
    });
    expect(await readTextIfExists(outputLogPath)).toContain("Process idle timed out after 1000ms");

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
    const script = "process.on('SIGTERM',()=>process.exit(0));setInterval(() => {}, 1000)";

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
      firstOutputTimeoutMs: 1000,
      idleTimeoutMs: 2000
    });

    expect(result.exitCode).toBe(0);
    expect(result.failure).toEqual({
      phase: "process-first-output-timeout",
      summary: `${process.execPath} produced no first output for 1000ms`
    });
    expect(await readTextIfExists(outputLogPath)).toContain("Process produced no first output after 1000ms");

    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.state).toBe("failed");
    expect(status.phase).toBe("process-first-output-timeout");
  });

  it("does not let the idle watchdog preempt the first-output deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-watchdog-order-"));
    const filesDir = join(root, "critic-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "process.on('SIGTERM',()=>process.exit(0));setInterval(() => {}, 1000)";

    await writeText(promptPath, "review this");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "critic-watchdog-order",
      role: "critic",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "review this",
      firstOutputTimeoutMs: 400,
      idleTimeoutMs: 100,
      timeoutMs: 1000
    });

    expect(result.failure?.phase).toBe("process-first-output-timeout");
    expect(await readJson(statusPath, WorkerStatusSchema)).toMatchObject({
      state: "failed",
      phase: "process-first-output-timeout"
    });
  });

  it("keeps the total deadline authoritative during silent startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-watchdog-total-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "process.on('SIGTERM',()=>process.exit(0));setInterval(() => {}, 1000)";

    await writeText(promptPath, "implement this");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    const result = await adapter.run({
      workerId: "actor-watchdog-total",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "implement this",
      firstOutputTimeoutMs: 1000,
      idleTimeoutMs: 100,
      timeoutMs: 300
    });

    expect(result.failure?.phase).toBe("process-timeout");
    expect(await readJson(statusPath, WorkerStatusSchema)).toMatchObject({
      state: "failed",
      phase: "process-timeout"
    });
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

  it("locks the first streamed native session id instead of adopting ids printed by agent tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-lock-session-"));
    const filesDir = join(root, "critic-codex");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const ownSession = "019f4b32-84b1-7be1-b250-7c9bd60984ed";
    const actorSession = "019f4b30-747d-7e71-9411-fd2830021ade";
    const script = [
      "process.stdout.write('session ');",
      `setTimeout(() => process.stdout.write('id: ${ownSession}\\n'), 5);`,
      `setTimeout(() => console.log(JSON.stringify({session_id:'${actorSession}'})), 15);`,
      "setTimeout(() => process.exit(0), 25);"
    ].join("");
    const detected: string[] = [];
    await writeText(promptPath, "review actor session metadata");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script], "codex");
    const result = await adapter.run({
      workerId: "critic-codex",
      role: "critic",
      engine: "codex",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "review actor session metadata",
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
    expect(detected).toEqual([ownSession]);
    expect(await readJson(statusPath, WorkerStatusSchema)).toMatchObject({
      native_session_id: ownSession
    });
  });

  it("detects Codex resume session ids from process output", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-detect-codex-resume-"));
    const filesDir = join(root, "actor-codex");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const sessionId = "019f1b9b-768b-7753-9c3b-33b17f25bc6b";
    const script = `console.log('To continue, run: codex resume ${sessionId}')`;
    const detected: string[] = [];

    await writeText(promptPath, "hello");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script], "codex");
    const result = await adapter.run({
      workerId: "actor-codex",
      role: "actor",
      engine: "codex",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "hello",
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: ["exec", "resume", "{sessionId}", "--skip-git-repo-check", "-"],
        detectSessionId: true,
        fallback: "new"
      },
      onNativeSession: (id) => {
        detected.push(id);
      }
    });

    expect(result.exitCode).toBe(0);
    expect(detected).toEqual([sessionId]);
    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.native_session_id).toBe(sessionId);
  });

  it("does not mistake ordinary resume wording for native session ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-ignore-resume-word-"));
    const filesDir = join(root, "actor-codex");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "console.log('I will resume work after reading the files.')";
    const detected: string[] = [];

    await writeText(promptPath, "hello");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script], "codex");
    const result = await adapter.run({
      workerId: "actor-codex",
      role: "actor",
      engine: "codex",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "hello",
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: ["exec", "resume", "{sessionId}", "--skip-git-repo-check", "-"],
        detectSessionId: true,
        fallback: "new"
      },
      onNativeSession: (id) => {
        detected.push(id);
      }
    });

    expect(result.exitCode).toBe(0);
    expect(detected).toEqual([]);
    const status = await readJson(statusPath, WorkerStatusSchema);
    expect(status.native_session_id).toBeUndefined();
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

  it("bounds in-memory resume diagnostics while preserving the full worker log", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-resume-bounded-output-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = [
      "const mode=process.argv[1];",
      "if(mode==='resume') {",
      "  process.stderr.write('ERROR: context win');",
      "  setTimeout(()=>process.stderr.write('dow is full; start a new thread\\n',()=>{",
      "    process.stdout.write('x'.repeat(200000)+'WORKER_LOG_TAIL\\n',()=>process.exit(1));",
      "  }),10);",
      "}",
      "console.log('fresh bounded run');"
    ].join("");
    const retiredReasons: string[] = [];
    await writeText(promptPath, "resume prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script, "normal"]);
    const result = await adapter.run({
      workerId: "actor-bounded-output",
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
        worker_id: "actor-bounded-output",
        session_id: "bounded-session",
        scope: "task",
        cwd: root,
        created_at: "2026-07-12T12:00:00.000Z",
        last_used_at: "2026-07-12T12:00:00.000Z",
        source: "manual"
      },
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: ["-e", script, "resume", "{sessionId}"],
        detectSessionId: true,
        fallback: "new"
      },
      onNativeSessionRetired: (_sessionId, reason) => {
        retiredReasons.push(reason);
      }
    });

    const log = await readTextIfExists(outputLogPath);
    expect(result.exitCode).toBe(0);
    expect(retiredReasons).toHaveLength(1);
    expect(retiredReasons[0]).toContain("context window");
    expect(retiredReasons[0]?.length).toBeLessThanOrEqual(2048);
    expect(log).toContain("WORKER_LOG_TAIL");
    expect(log.length).toBeGreaterThan(200000);
    expect(log).toContain("fresh bounded run");
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

  it("does not start a fresh native session after process cleanup fails", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "pct-process-resume-cleanup-failure-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const pidsPath = join(root, "worker-pids.txt");
    const script = [
      "const {appendFileSync}=require('node:fs');",
      `appendFileSync(${JSON.stringify(pidsPath)},String(process.pid)+'\\n');`,
      "console.error('ERROR: context window is full; start a new thread');",
      "setInterval(()=>{},1000);"
    ].join("");
    const retired: string[] = [];
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (typeof pid === "number" && pid < 0 && signal === "SIGTERM") {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalKill(pid, signal);
    });

    await writeText(promptPath, "resume prompt");
    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);
    let pids: number[] = [];
    try {
      const result = await adapter.run({
        workerId: "actor-cleanup-failed-resume",
        role: "actor",
        engine: "mock",
        cwd: root,
        filesDir,
        promptPath,
        outputLogPath,
        statusPath,
        prompt: "resume prompt",
        timeoutMs: 2000,
        idleTimeoutMs: 150,
        nativeSession: {
          engine: "mock",
          role: "actor",
          worker_id: "actor-cleanup-failed-resume",
          session_id: "abc123",
          scope: "task",
          cwd: root,
          created_at: "2026-06-30T03:30:00.000Z",
          last_used_at: "2026-06-30T03:30:00.000Z",
          source: "manual"
        },
        nativeSessionConfig: {
          enabled: true,
          resumeArgs: ["-e", script, "{sessionId}"],
          detectSessionId: true,
          fallback: "new"
        },
        onNativeSessionRetired: (sessionId) => {
          retired.push(sessionId);
        }
      });
      pids = (await readFile(pidsPath, "utf8"))
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((pid) => pid > 0);

      expect(result.failure?.phase).toBe("process-cleanup-error");
      expect(pids).toHaveLength(1);
      expect(retired).toEqual([]);
      expect(await readTextIfExists(outputLogPath)).not.toContain("starting a fresh native session");
    } finally {
      killSpy.mockRestore();
      for (const pid of pids) {
        killProcessGroupIfAlive(pid, pid);
      }
    }
  }, 5000);

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

  it("logs worker commands with shell-quoted arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-quoted-command-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    const script = "console.log('quoted command ok')";

    await writeText(promptPath, "model prompt");

    const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script, "--"], "mock", {
      model: {
        name: "model with spaces",
        provider: "provider's gateway",
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
      prompt: "model prompt"
    });

    expect(result.exitCode).toBe(0);
    const output = await readTextIfExists(outputLogPath);
    expect(output).toContain("'model with spaces'");
    expect(output).toContain("'provider'\\''s gateway'");
    expect(output).toContain("quoted command ok");
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

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await pathExists(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for path ${path}`);
}

function killProcessGroupIfAlive(parentPid: number, childPid: number): void {
  if (parentPid > 0 && processIsAlive(childPid)) {
    try {
      process.kill(-parentPid, "SIGKILL");
    } catch {
      // Fall through to the descendant PID when the original group is gone.
    }
  }
  if (childPid > 0 && processIsAlive(childPid)) {
    process.kill(childPid, "SIGKILL");
  }
}
