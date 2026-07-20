import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendText, pathExists, readJson, readTextIfExists, writeJson, writeText } from "../src/core/file-store.js";
import { SessionIndex } from "../src/core/session-index.js";
import { SessionManager, type TaskSession } from "../src/core/session-manager.js";
import {
  claimTaskRunLease,
  processIsAlive,
  taskRunOwnerPath,
  workerProcessRecordPath,
  writeWorkerProcessRecord
} from "../src/core/process-ownership.js";
import {
  MainConversationArchiveSchema,
  NativeSessionSchema,
  RetiredNativeSessionSchema,
  RouteDecisionSchema,
  TaskMetaSchema,
  TurnMetaSchema,
  WorkerStatusSchema
} from "../src/domain/schemas.js";

describe("SessionManager", () => {
  it("renames, archives, exports, unarchives, and deletes a terminal task session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-session-management-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      index,
      now: () => new Date("2026-07-15T08:30:45.000Z"),
      randomId: () => "managed"
    });
    const task = await manager.createTask({
      request: "Original title",
      cwd: root,
      route: testComplexRoute("Manage this task.")
    });
    await completeTaskWithoutFeatures(manager, task, "Managed task complete.");

    const renamed = await manager.renameTask(task.id, "  中文 会话\n名称  ");
    expect(renamed.title).toBe("中文 会话 名称");
    await expect(index.listTasks(10)).resolves.toEqual([
      expect.objectContaining({ id: task.id, title: "中文 会话 名称" })
    ]);

    await index.setActiveTaskId(null);
    const archived = await manager.setTaskArchived(task.id, true);
    expect(archived.archived_at).toBe("2026-07-15T08:30:45.000Z");
    await expect(index.listTasks(10)).resolves.toEqual([]);
    await expect(index.listTasks(10, { includeArchived: true })).resolves.toEqual([
      expect.objectContaining({ id: task.id, archived_at: "2026-07-15T08:30:45.000Z" })
    ]);
    await expect(manager.latestTask()).resolves.toBeNull();

    const exported = await manager.exportTask(task.id);
    expect(exported.path).toContain(join(root, ".parallel-codex", "exports", task.id));
    expect(await pathExists(join(exported.path, "manifest.json"))).toBe(true);
    expect(await pathExists(join(exported.path, "report.md"))).toBe(true);
    expect(await pathExists(join(exported.path, "report.json"))).toBe(true);
    expect(await pathExists(join(exported.path, "session", "meta.json"))).toBe(true);
    expect(await pathExists(join(exported.path, "session", "run-owner.json"))).toBe(false);
    expect(await readTextIfExists(join(exported.path, "session", "events.jsonl"))).toContain("task.exported");
    expect(JSON.parse(await readTextIfExists(join(exported.path, "manifest.json")))).toMatchObject({
      report_path: "report.md",
      report_json_path: "report.json"
    });
    expect(JSON.parse(await readTextIfExists(join(exported.path, "report.json")))).toMatchObject({
      format: "parallel-codex-task-report-v1",
      task: { id: task.id, title: "中文 会话 名称" },
      workspace: { reconciliation: { state: "no-integrations" } }
    });
    expect(await readTextIfExists(join(exported.path, "report.md"))).toContain("# Task Report: 中文 会话 名称");

    const unarchived = await manager.setTaskArchived(task.id, false);
    expect(unarchived.archived_at).toBeUndefined();
    await manager.deleteTask(task.id);
    await expect(manager.hasTask(task.id)).resolves.toBe(false);
    await expect(index.countRows("tasks")).resolves.toBe(0);
    await expect(index.countRows("turns")).resolves.toBe(0);
    expect(await pathExists(task.dir)).toBe(false);
    index.close();
  });

  it("blocks unsafe management of active, nonterminal, or leased tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-session-management-guard-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      index,
      now: () => new Date("2026-07-15T08:31:00.000Z"),
      randomId: () => "guarded"
    });
    const task = await manager.createTask({
      request: "Guarded task",
      cwd: root,
      route: testComplexRoute("Guard this task.")
    });

    await expect(manager.setTaskArchived(task.id, true)).rejects.toThrow("while it is routed");
    await expect(manager.deleteTask(task.id)).rejects.toThrow("Cannot delete active task");
    await expect(manager.exportTask(task.id)).rejects.toThrow("while it is routed");

    const lease = await claimTaskRunLease(task.dir, { ownerId: "other-tui" });
    try {
      await expect(manager.renameTask(task.id, "Blocked rename")).rejects.toThrow(
        "Task is already running in another parallel-codex-tui process"
      );
    } finally {
      await lease.release();
      index.close();
    }
  });

  it("persists bounded workspace chat history and skips corrupt JSONL rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-chat-history-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-10T12:00:00.000Z")
    });
    const chatManager = manager as SessionManager & {
      appendChatMessage?: (message: { from: "user" | "system"; text: string; taskId?: string }) => Promise<void>;
      readChatHistory?: (limit?: number) => Promise<Array<{
        time: string;
        from: "user" | "system";
        text: string;
        task_id?: string;
      }>>;
    };

    expect(chatManager.appendChatMessage).toBeTypeOf("function");
    expect(chatManager.readChatHistory).toBeTypeOf("function");
    await chatManager.appendChatMessage?.({ from: "user", text: "记住暗号蓝色", taskId: "task-blue" });
    await chatManager.appendChatMessage?.({ from: "system", text: "已经记住。", taskId: "task-blue" });
    await chatManager.appendChatMessage?.({ from: "user", text: "普通聊天" });
    await chatManager.appendChatMessage?.({ from: "user", text: "其他任务", taskId: "task-other" });

    const chatPath = join(root, ".parallel-codex", "sessions", "main", "chat.jsonl");
    await appendText(chatPath, "not-json\n{\"from\":\"other\",\"text\":\"bad\"}\n");

    await expect(chatManager.readChatHistory?.()).resolves.toEqual([
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "user",
        text: "记住暗号蓝色",
        task_id: "task-blue"
      },
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "system",
        text: "已经记住。",
        task_id: "task-blue"
      },
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "user",
        text: "普通聊天"
      },
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "user",
        text: "其他任务",
        task_id: "task-other"
      }
    ]);
    await expect(chatManager.readChatHistory?.(1)).resolves.toEqual([
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "user",
        text: "其他任务",
        task_id: "task-other"
      }
    ]);
    await expect(manager.readScopedChatHistory("task-blue", 2)).resolves.toEqual([
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "user",
        text: "记住暗号蓝色",
        task_id: "task-blue"
      },
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "system",
        text: "已经记住。",
        task_id: "task-blue"
      }
    ]);
    await expect(manager.readScopedChatHistory(null, 2)).resolves.toEqual([
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "user",
        text: "普通聊天"
      }
    ]);
  });

  it("lists and restores isolated Main conversations with their original native sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-main-conversation-"));
    const randomIds = ["first", "second"];
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      randomId: () => randomIds.shift() ?? "later"
    });
    await manager.appendChatMessage({ from: "user", text: "legacy memory" });

    const workerDir = join(manager.mainSessionDir(), "main-codex");
    await manager.writeNativeSession({ dir: workerDir }, NativeSessionSchema.parse({
      engine: "codex",
      role: "main",
      worker_id: "main-codex",
      session_id: "native-before-reset",
      scope: "main",
      cwd: root,
      created_at: "2026-07-10T11:00:00.000Z",
      last_used_at: "2026-07-10T11:30:00.000Z",
      source: "output-detected"
    }));

    const first = await manager.startNewMainConversation();
    expect(first).toEqual({
      version: 1,
      id: "conversation-20260710-120000-first",
      created_at: "2026-07-10T12:00:00.000Z"
    });
    await expect(manager.readNativeSession({ dir: workerDir })).resolves.toBeNull();
    await expect(readJson(
      join(workerDir, "native-session.retired.json"),
      RetiredNativeSessionSchema
    )).resolves.toEqual(expect.objectContaining({
      session_id: "native-before-reset",
      retired_reason: "new Main conversation"
    }));
    await expect(manager.readScopedChatHistory(null)).resolves.toEqual([]);

    await manager.appendChatMessage({ from: "system", text: "fresh context" });
    await manager.appendChatMessage({ from: "user", text: "first conversation question" });
    await manager.appendChatMessage({ from: "user", text: "task context", taskId: "task-other" });
    await expect(manager.readScopedChatHistory(null)).resolves.toEqual([
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "system",
        text: "fresh context",
        conversation_id: first.id
      },
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "user",
        text: "first conversation question",
        conversation_id: first.id
      }
    ]);
    await expect(manager.readScopedChatHistory("task-other")).resolves.toEqual([{
      time: "2026-07-10T12:00:00.000Z",
      from: "user",
      text: "task context",
      task_id: "task-other"
    }]);
    expect(await manager.readChatHistory()).toEqual([
      expect.objectContaining({ text: "legacy memory" }),
      expect.objectContaining({ text: "fresh context", conversation_id: first.id }),
      expect.objectContaining({ text: "first conversation question", conversation_id: first.id }),
      expect.objectContaining({ text: "task context", task_id: "task-other" })
    ]);

    await manager.writeNativeSession({ dir: workerDir }, NativeSessionSchema.parse({
      engine: "codex",
      role: "main",
      worker_id: "main-codex",
      session_id: "native-first-conversation",
      scope: "main",
      cwd: root,
      created_at: "2026-07-10T12:00:00.000Z",
      last_used_at: "2026-07-10T12:00:00.000Z",
      source: "output-detected"
    }));

    const second = await manager.startNewMainConversation();
    expect(second).toEqual({
      version: 1,
      id: "conversation-20260710-120000-second",
      created_at: "2026-07-10T12:00:00.000Z",
      previous_id: first.id
    });
    await expect(manager.readScopedChatHistory(null)).resolves.toEqual([]);
    await expect(manager.readChatHistory()).resolves.toHaveLength(4);

    const beforeRestore = await manager.listMainConversations();
    expect(beforeRestore[0]?.id).toBe(second.id);
    expect(new Set(beforeRestore.map((conversation) => conversation.id))).toEqual(new Set([
      second.id,
      first.id,
      null
    ]));
    expect(beforeRestore.find((conversation) => conversation.id === first.id)).toMatchObject({
      title: "first conversation question",
      messageCount: 2,
      userMessageCount: 1,
      nativeSessionCount: 1,
      current: false
    });
    expect(beforeRestore.find((conversation) => conversation.id === null)).toMatchObject({
      title: "legacy memory",
      nativeSessionCount: 1,
      current: false
    });

    const restoredFirst = await manager.activateMainConversation(first.id);
    expect(restoredFirst).toMatchObject({
      changed: true,
      restoredNativeSessions: 1,
      conversation: {
        id: first.id,
        title: "first conversation question",
        current: true
      }
    });
    await expect(manager.readNativeSession({ dir: workerDir })).resolves.toMatchObject({
      session_id: "native-first-conversation"
    });
    await expect(manager.readScopedChatHistory(null)).resolves.toHaveLength(2);

    const restoredLegacy = await manager.activateMainConversation(null);
    expect(restoredLegacy).toMatchObject({
      changed: true,
      restoredNativeSessions: 1,
      conversation: {
        id: null,
        title: "legacy memory",
        current: true
      }
    });
    await expect(manager.readMainConversationState()).resolves.toBeNull();
    await expect(manager.readNativeSession({ dir: workerDir })).resolves.toMatchObject({
      session_id: "native-before-reset"
    });
    await expect(manager.readScopedChatHistory(null)).resolves.toEqual([
      expect.objectContaining({ text: "legacy memory" })
    ]);
  });

  it("does not catalog an empty legacy conversation before the first explicit Main conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-empty-main-conversation-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      randomId: () => "first"
    });

    const conversation = await manager.startNewMainConversation();
    const conversations = await manager.listMainConversations();

    expect(conversations).toEqual([
      expect.objectContaining({
        id: conversation.id,
        current: true,
        messageCount: 0,
        nativeSessionCount: 0
      })
    ]);
    await expect(pathExists(join(
      manager.mainSessionDir(),
      "conversations",
      "legacy",
      "meta.json"
    ))).resolves.toBe(false);
  });

  it("renames, archives, exports, and atomically deletes a noncurrent Main conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-main-conversation-management-"));
    const randomIds = ["first", "second"];
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      randomId: () => randomIds.shift() ?? "later"
    });
    const first = await manager.startNewMainConversation();
    await manager.appendChatMessage({ from: "user", text: "first private message" });
    await manager.appendChatMessage({ from: "system", text: "first answer" });
    const workerDir = join(manager.mainSessionDir(), "main-codex");
    await manager.writeNativeSession({ dir: workerDir }, NativeSessionSchema.parse({
      engine: "codex",
      role: "main",
      worker_id: "main-codex",
      session_id: "native-first",
      scope: "main",
      cwd: root,
      created_at: "2026-07-10T12:00:00.000Z",
      last_used_at: "2026-07-10T12:00:00.000Z",
      source: "output-detected"
    }));

    const second = await manager.startNewMainConversation();
    await manager.appendChatMessage({ from: "user", text: "second retained message" });
    await manager.appendChatMessage({ from: "user", text: "task retained message", taskId: "task-retained" });
    const chatPath = join(manager.mainSessionDir(), "chat.jsonl");
    await appendText(chatPath, "{broken-chat-evidence\n");

    const renamed = await manager.renameMainConversation(first.id, "  第一段\n会话  ");
    expect(renamed.title).toBe("第一段 会话");
    await expect(readJson(
      join(manager.mainSessionDir(), "conversations", first.id, "meta.json"),
      MainConversationArchiveSchema
    )).resolves.toMatchObject({ title: "第一段 会话" });

    const archived = await manager.setMainConversationArchived(first.id, true);
    expect(archived.archivedAt).toBe("2026-07-10T12:00:00.000Z");
    expect((await manager.listMainConversations()).map((conversation) => conversation.id)).toEqual([second.id]);
    expect(await manager.listMainConversations(100, { includeArchived: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, title: "第一段 会话", archivedAt: archived.archivedAt }),
      expect.objectContaining({ id: second.id, current: true })
    ]));
    await expect(manager.activateMainConversation(first.id)).rejects.toThrow("Unarchive it first");

    const unarchived = await manager.setMainConversationArchived(first.id, false);
    expect(unarchived.archivedAt).toBeUndefined();
    const exported = await manager.exportMainConversation(first.id);
    const manifest = JSON.parse(await readTextIfExists(join(exported.path, "manifest.json"))) as {
      format: string;
      message_count: number;
      native_session_count: number;
      conversation: { id: string | null; title: string };
    };
    expect(manifest).toMatchObject({
      format: "parallel-codex-main-conversation-export-v1",
      message_count: 2,
      native_session_count: 1,
      conversation: { id: first.id, title: "第一段 会话" }
    });
    expect(await readTextIfExists(join(exported.path, "chat.jsonl"))).toContain("first private message");
    expect(await readTextIfExists(join(exported.path, "chat.jsonl"))).not.toContain("second retained message");
    expect(await pathExists(join(exported.path, "native-sessions", "main-codex.json"))).toBe(true);

    await expect(manager.setMainConversationArchived(second.id, true)).rejects.toThrow("current Main conversation");
    await expect(manager.deleteMainConversation(second.id)).rejects.toThrow("current Main conversation");
    await manager.deleteMainConversation(first.id);

    expect((await manager.listMainConversations(100, { includeArchived: true }))
      .some((conversation) => conversation.id === first.id)).toBe(false);
    const retainedChat = await readTextIfExists(chatPath);
    expect(retainedChat).not.toContain("first private message");
    expect(retainedChat).not.toContain("first answer");
    expect(retainedChat).toContain("second retained message");
    expect(retainedChat).toContain("task retained message");
    expect(retainedChat).toContain("{broken-chat-evidence");
    expect(await pathExists(join(manager.mainSessionDir(), "conversations", first.id))).toBe(false);
  });

  it("rolls back every Main conversation file when deletion event persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-main-conversation-delete-rollback-"));
    const randomIds = ["rollback-target", "rollback-current"];
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-20T09:15:00.000Z"),
      randomId: () => randomIds.shift() ?? "later"
    });
    const target = await manager.startNewMainConversation();
    await manager.appendChatMessage({ from: "user", text: "must survive failed deletion" });
    await manager.startNewMainConversation();
    await manager.appendChatMessage({ from: "user", text: "current conversation remains" });

    if (!target.id) {
      throw new Error("Expected a named Main conversation id");
    }
    const chatPath = join(manager.mainSessionDir(), "chat.jsonl");
    const archivePath = join(manager.mainSessionDir(), "conversations", target.id);
    const before = await readTextIfExists(chatPath);
    const appendEvent = vi.spyOn(
      manager as unknown as { appendEvent: (...args: unknown[]) => Promise<void> },
      "appendEvent"
    );
    appendEvent.mockRejectedValueOnce(new Error("event storage unavailable"));

    await expect(manager.deleteMainConversation(target.id)).rejects.toThrow("event storage unavailable");

    expect(await readTextIfExists(chatPath)).toBe(before);
    expect(await pathExists(archivePath)).toBe(true);
    expect((await manager.listMainConversations(100, { includeArchived: true })))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: target.id, title: "must survive failed deletion" })
      ]));
    expect((await readdir(manager.mainSessionDir())).some((entry) => entry.startsWith(".conversation-delete-")))
      .toBe(false);

    await expect(manager.renameMainConversation(target.id, "Recovered conversation"))
      .resolves.toMatchObject({ title: "Recovered conversation" });
  });

  it("restores legacy Codex chat transcripts as final answers without rewriting evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-chat-codex-transcript-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-17T08:31:03.000Z")
    });
    const transcript = [
      "$ codex exec resume native-session -",
      "OpenAI Codex v0.144.4",
      "--------",
      "workdir: /tmp/project",
      "--------",
      "user",
      "User request:",
      "你来监控啊",
      "codex",
      "好，我来持续监控。",
      "tokens used",
      "7,527",
      "好，我来持续监控。"
    ].join("\n");
    await manager.appendChatMessage({ from: "system", text: transcript });

    const restored = await manager.readChatHistory();
    const persisted = await readTextIfExists(join(root, ".parallel-codex", "sessions", "main", "chat.jsonl"));

    expect(restored[0]?.text).toBe("好，我来持续监控。");
    expect(persisted).toContain("OpenAI Codex v0.144.4");
    expect(persisted).toContain("tokens used");
  });

  it("creates a complex task session with standard files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-session-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });

    const task = await manager.createTask({
      request: "Implement parallel coding.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });

    expect(task.id).toBe("task-20260630-033000-a1b2");
    expect(await readTextIfExists(join(task.dir, "user-request.md"))).toContain("Implement parallel coding.");
    expect(await readTextIfExists(join(task.dir, "turns", "0001", "user.md"))).toContain(
      "Implement parallel coding."
    );

    const meta = await readJson(join(task.dir, "meta.json"), TaskMetaSchema);
    const route = await readJson(join(task.dir, "route.json"), RouteDecisionSchema);
    const turn = await readJson(join(task.dir, "turns", "0001", "turn.json"), TurnMetaSchema);
    const turnRoute = await readJson(join(task.dir, "turns", "0001", "route.json"), RouteDecisionSchema);

    expect(meta.status).toBe("routed");
    expect(route.mode).toBe("complex");
    expect(turn.turn_id).toBe("0001");
    expect(turnRoute.mode).toBe("complex");
    const events = await readTextIfExists(task.eventsPath);
    expect(events.indexOf('"type":"task.created"')).toBeLessThan(events.indexOf('"type":"task.routed"'));
  });

  it("rejects task status changes that skip lifecycle phases", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-status-invalid-transition-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "invalid-transition"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    await expect(manager.updateTaskStatus(task, "critic_running")).rejects.toThrow(
      `Task ${task.id} cannot move from routed to critic_running`
    );
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "routed" });
    expect(await readTextIfExists(task.eventsPath)).not.toContain('"type":"task.critic_running"');
  });

  it("records repeated task status transitions idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-status-idempotent-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "idempotent"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    await advanceTaskToReady(manager, task);
    await manager.updateTaskStatus(task, "actor_running");
    await manager.updateTaskStatus(task, "actor_running");

    const events = await readTextIfExists(task.eventsPath);
    expect(countOccurrences(events, '"type":"task.actor_running"')).toBe(1);
    expect(events).toContain('"message":"Task moved from ready_for_pair to actor_running"');
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "actor_running" });
  });

  it("repairs a committed task transition after a transient index projection failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-status-projection-retry-"));
    const initial = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "projection-retry"
    });
    const task = await initial.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await advanceTaskToReady(initial, task);
    const upsertTask = vi.fn()
      .mockRejectedValueOnce(new Error("index temporarily unavailable"))
      .mockResolvedValue(undefined);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:31:00.000Z"),
      index: { upsertTask } as unknown as SessionIndex
    });

    await expect(manager.updateTaskStatus(task, "actor_running")).rejects.toThrow("index temporarily unavailable");
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "actor_running" });

    await expect(manager.updateTaskStatus(task, "actor_running")).resolves.toBeUndefined();

    const events = await readTextIfExists(task.eventsPath);
    expect(countOccurrences(events, '"type":"task.actor_running"')).toBe(1);
    expect(events).toContain('"message":"Task moved from ready_for_pair to actor_running"');
    expect(upsertTask).toHaveBeenCalledTimes(2);
  });

  it("repairs the previous committed transition before recording a later failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-status-event-retry-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:32:00.000Z"),
      randomId: () => "event-retry"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await advanceTaskToReady(manager, task);
    const readyMeta = await readJson(task.metaPath, TaskMetaSchema);
    const readyMetaWithoutTransition = { ...readyMeta };
    delete readyMetaWithoutTransition.status_transition;
    await writeJson(task.metaPath, readyMetaWithoutTransition);
    const eventsBackup = `${task.eventsPath}.backup`;
    await rename(task.eventsPath, eventsBackup);
    await mkdir(task.eventsPath);

    await expect(manager.updateTaskStatus(task, "actor_running")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({
      status: "actor_running",
      status_transition: { from: "ready_for_pair", to: "actor_running" }
    });

    await rm(task.eventsPath, { recursive: true });
    await rename(eventsBackup, task.eventsPath);
    await manager.updateTaskStatus(task, "failed");

    const events = await readTextIfExists(task.eventsPath);
    expect(countOccurrences(events, '"type":"task.actor_running"')).toBe(1);
    expect(countOccurrences(events, '"type":"task.failed"')).toBe(1);
    expect(events.indexOf('"type":"task.actor_running"')).toBeLessThan(events.indexOf('"type":"task.failed"'));
  });

  it("rejects terminal done before the latest turn completion evidence is published", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-done-guard-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "done-guard"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await advanceTaskToIntegrating(manager, task);

    await expect(manager.updateTaskStatus(task, "done")).rejects.toThrow(
      `Task ${task.id} cannot move to done before latest-turn completion evidence is published`
    );
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Complex task completed.\n");
    await writeJson(join(task.dir, "features", "0001-mismatch", "status.json"), {
      feature_id: "0001-mismatch",
      task_id: task.id,
      turn_id: "0000",
      title: "Mismatched",
      description: "Wrong turn evidence",
      depends_on: [],
      state: "approved",
      updated_at: "2026-06-30T03:30:00.000Z"
    });
    await expect(manager.updateTaskStatus(task, "done")).rejects.toThrow(
      `Task ${task.id} cannot move to done before latest-turn completion evidence is published`
    );
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "integrating" });
    expect(await readTextIfExists(task.eventsPath)).not.toContain('"type":"task.done"');
  });

  it("protects complete done tasks from regression while allowing a new follow-up turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-done-regression-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "done-regression"
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "mock" as const,
      actor_engine: "mock" as const,
      critic_engine: "mock" as const
    };
    const task = await manager.createTask({ request: "Build it.", cwd: root, route });
    await advanceTaskToIntegrating(manager, task);
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Complex task completed.\n");
    await manager.updateTaskStatus(task, "done");

    await expect(manager.updateTaskStatus(task, "failed")).rejects.toThrow(
      `Task ${task.id} is completely done and cannot move backward to failed`
    );
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "done" });

    await manager.appendTurn(task, { request: "Continue it.", route });
    await expect(manager.updateTaskStatus(task, "judging")).resolves.toBeUndefined();
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "judging" });
  });

  it("appends follow-up turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-turns-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "codex" as const,
      actor_engine: "codex" as const,
      critic_engine: "claude" as const
    };
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route
    });
    await manager.updateTaskStatus(task, "judging");
    await manager.updateTaskStatus(task, "ready_for_pair");
    await manager.updateTaskStatus(task, "actor_running");
    await manager.updateTaskStatus(task, "critic_running");
    await manager.updateTaskStatus(task, "integrating");
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Initial task completed.\n");
    await manager.updateTaskStatus(task, "done");

    const turn = await manager.appendTurn(task, {
      request: "继续改",
      route
    });

    expect(turn.turnId).toBe("0002");
    expect(await readTextIfExists(join(task.dir, "turns", "0002", "user.md"))).toContain("继续改");
    const meta = await readJson(join(task.dir, "turns", "0002", "turn.json"), TurnMetaSchema);
    expect(meta.turn_id).toBe("0002");
    expect((await readdir(join(task.dir, "turns"))).filter((entry) => entry.endsWith(".pending"))).toEqual([]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "routed" });
  });

  it("reads the latest persisted route across task turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-latest-route-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Initial route.",
        source: "codex",
        duration_ms: 120,
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });
    await manager.appendTurn(task, {
      request: "继续",
      route: {
        mode: "complex",
        reason: "Codex router timed out after 30000ms.",
        source: "fallback",
        duration_ms: 30000,
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });

    await expect(manager.readLatestRoute(task)).resolves.toMatchObject({
      reason: "Codex router timed out after 30000ms.",
      source: "fallback",
      duration_ms: 30000
    });

    await writeText(join(task.dir, "turns", "0002", "route.json"), "{");
    await expect(manager.readLatestRoute(task)).resolves.toMatchObject({
      reason: "Initial route.",
      source: "codex",
      duration_ms: 120
    });
  });

  it("prefers the latest task route evidence over an older worker turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-latest-task-route-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Initial route.",
        source: "codex",
        duration_ms: 120,
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });
    await manager.appendTurn(task, {
      request: "继续",
      route: {
        mode: "complex",
        reason: "Codex router timed out after 120000ms.",
        source: "fallback",
        duration_ms: 120000,
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });
    await writeJson(join(task.dir, "latest-route.json"), RouteDecisionSchema.parse({
      mode: "simple",
      reason: "A short task question.",
      source: "codex",
      duration_ms: 9210,
      router_attempt: 2,
      router_total_duration_ms: 39710,
      router_recovered_from: "timeout",
      router_recovered_via: "auto-retry",
      router_recovered_timeout_kind: "idle",
      router_recovered_failure_stage: "streaming",
      suggested_roles: []
    }));

    await expect(manager.readLatestRoute(task)).resolves.toMatchObject({
      mode: "simple",
      source: "codex",
      duration_ms: 9210,
      router_attempt: 2,
      router_total_duration_ms: 39710,
      router_recovered_from: "timeout",
      router_recovered_via: "auto-retry",
      router_recovered_timeout_kind: "idle",
      router_recovered_failure_stage: "streaming"
    });

    await writeText(join(task.dir, "latest-route.json"), "{");
    await expect(manager.readLatestRoute(task)).resolves.toMatchObject({
      mode: "complex",
      source: "fallback",
      duration_ms: 120000
    });
  });

  it("appends follow-up turns when task metadata is corrupt but the active task is known", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-turns-corrupt-meta-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "mock" as const,
      actor_engine: "mock" as const,
      critic_engine: "mock" as const
    };
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route
    });
    await expect(index.activeTaskId()).resolves.toBe(task.id);
    await writeText(task.metaPath, "{");

    const turn = await manager.appendTurn(task, {
      request: "继续改",
      route
    });

    expect(turn.turnId).toBe("0002");
    expect(await readTextIfExists(join(task.dir, "turns", "0002", "user.md"))).toContain("继续改");
    await expect(index.countRows("turns")).resolves.toBe(2);
    index.close();
  });

  it("finds the latest complex task from session files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-latest-task-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T15:00:00.000Z"),
      randomId: () => "a1b2"
    });
    const first = await manager.createTask({
      request: "First task.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const second = await manager.createTask({
      request: "Second task.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    expect(second.id).not.toBe(first.id);
    expect(await pathExists(first.metaPath)).toBe(true);
    expect(await pathExists(second.metaPath)).toBe(true);

    const latest = await manager.latestTask();

    expect(latest?.id).toBe(second.id);
  });

  it("claims unique task ids when two creators collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-id-collision-"));
    const options = {
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T15:01:00.000Z"),
      randomId: () => "same"
    };
    const left = new SessionManager(options);
    const right = new SessionManager(options);
    const route = testComplexRoute("Concurrent task creation.");

    const [first, second] = await Promise.all([
      left.createTask({ request: "First concurrent task.", cwd: root, route }),
      right.createTask({ request: "Second concurrent task.", cwd: root, route })
    ]);

    expect(new Set([first.id, second.id])).toEqual(new Set([
      "task-20260711-150100-same",
      "task-20260711-150100-same-0002"
    ]));
    expect(await readTextIfExists(join(first.dir, "user-request.md"))).toContain("First concurrent task.");
    expect(await readTextIfExists(join(second.dir, "user-request.md"))).toContain("Second concurrent task.");
  });

  it("publishes a complete task creation left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-pending-task-complete-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T15:02:00.000Z")
    });
    const taskId = "task-20260711-150159-stale";
    const stagingDir = join(root, ".parallel-codex", "sessions", `.${taskId}.creating`);
    await writePendingTaskCreation(stagingDir, taskId, root, 2147483647, true);

    await expect(manager.reconcilePendingTaskCreations()).resolves.toEqual({
      published: 1,
      abandoned: 0,
      active: 0,
      publishedTaskIds: [taskId]
    });

    const task = manager.taskFromId(taskId);
    expect(await pathExists(stagingDir)).toBe(false);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "routed" });
    await expect(manager.latestTurn(task)).resolves.toMatchObject({ turnId: "0001" });
    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([
      expect.objectContaining({ taskId, previousState: "routed" })
    ]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("settles concurrent recovery of one complete task creation without failing startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-pending-task-concurrent-"));
    const taskId = "task-20260711-150159-concurrent";
    const stagingDir = join(root, ".parallel-codex", "sessions", `.${taskId}.creating`);
    await writePendingTaskCreation(stagingDir, taskId, root, 2147483647, true);
    const managers = [
      new SessionManager({ projectRoot: root, dataDir: ".parallel-codex" }),
      new SessionManager({ projectRoot: root, dataDir: ".parallel-codex" })
    ];

    const results = await Promise.all(managers.map((manager) => manager.reconcilePendingTaskCreations()));

    expect(results.reduce((total, result) => total + result.published, 0)).toBeGreaterThanOrEqual(1);
    expect(results.reduce((total, result) => total + result.abandoned, 0)).toBe(0);
    expect(await pathExists(stagingDir)).toBe(false);
    await expect(readJson(managers[0]!.taskFromId(taskId).metaPath, TaskMetaSchema)).resolves.toMatchObject({
      status: "routed"
    });
  });

  it("does not project a corrupt published creation turn into SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-pending-task-corrupt-turn-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({ projectRoot: root, dataDir: ".parallel-codex", index });
    const taskId = "task-20260711-150159-corrupt-turn";
    const sessionsDir = join(root, ".parallel-codex", "sessions");
    const stagingDir = join(sessionsDir, `.${taskId}.creating`);
    const finalDir = join(sessionsDir, taskId);
    await writePendingTaskCreation(stagingDir, taskId, root, 2147483647, true);
    await rename(stagingDir, finalDir);
    await writeText(join(finalDir, "turns", "0001", "route.json"), "{");

    try {
      await expect(manager.reconcilePendingTaskCreations()).resolves.toMatchObject({ published: 1 });
      await expect(index.countRows("tasks")).resolves.toBe(1);
      await expect(index.countRows("turns")).resolves.toBe(0);
    } finally {
      index.close();
    }
  });

  it("archives an incomplete task creation left by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-pending-task-incomplete-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex"
    });
    const taskId = "task-20260711-150200-incomplete";
    const stagingName = `.${taskId}.creating`;
    const stagingDir = join(root, ".parallel-codex", "sessions", stagingName);
    await writePendingTaskCreation(stagingDir, taskId, root, 2147483647, false);

    await expect(manager.reconcilePendingTaskCreations()).resolves.toEqual({
      published: 0,
      abandoned: 1,
      active: 0,
      publishedTaskIds: []
    });

    expect(await pathExists(stagingDir)).toBe(false);
    expect(await pathExists(join(root, ".parallel-codex", "sessions", ".abandoned", stagingName))).toBe(true);
    await expect(manager.latestTask()).resolves.toBeNull();
  });

  it("leaves a task creation owned by a live process untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-pending-task-active-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex"
    });
    const taskId = "task-20260711-150201-active";
    const stagingDir = join(root, ".parallel-codex", "sessions", `.${taskId}.creating`);
    await writePendingTaskCreation(stagingDir, taskId, root, process.pid, false);

    await expect(manager.reconcilePendingTaskCreations()).resolves.toEqual({
      published: 0,
      abandoned: 0,
      active: 1,
      publishedTaskIds: []
    });

    expect(await pathExists(stagingDir)).toBe(true);
    expect(await pathExists(manager.taskFromId(taskId).dir)).toBe(false);
  });

  it("skips corrupt task metadata when finding the latest complex task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-latest-task-corrupt-meta-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "good"
    });
    const good = await manager.createTask({
      request: "Good task.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const corruptDir = join(root, ".parallel-codex", "sessions", "task-20260630-033100-bad");
    await writeText(join(corruptDir, "meta.json"), "{");

    const latest = await manager.latestTask();

    expect(latest?.id).toBe(good.id);
  });

  it("does not resolve unsafe or mismatched task identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-identity-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "good"
    });
    const good = await manager.createTask({
      request: "Good task.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await writeJson(
      join(root, ".parallel-codex", "sessions", "task-directory-name", "meta.json"),
      TaskMetaSchema.parse({
        id: "task-different-id",
        title: "Mismatched task",
        created_at: "2026-06-30T03:31:00.000Z",
        cwd: root,
        mode: "complex",
        status: "done"
      })
    );

    await expect(manager.hasTask("../outside")).resolves.toBe(false);
    expect(() => manager.taskFromId("../outside")).toThrow("Invalid task session id");
    await expect(manager.latestTask()).resolves.toMatchObject({ id: good.id });
  });

  it("backfills turn 0001 before appending to legacy tasks with user-request but no turns directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-legacy-turns-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Original.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await rm(join(task.dir, "turns"), { recursive: true, force: true });

    const turn = await manager.appendTurn(task, {
      request: "继续",
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    expect(turn.turnId).toBe("0002");
    expect(await readTextIfExists(join(task.dir, "turns", "0001", "user.md"))).toContain("Original.");
    expect(await readTextIfExists(join(task.dir, "turns", "0002", "user.md"))).toContain("继续");
  });

  it("backfills legacy task turns with fallback route when route and task metadata are corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-legacy-corrupt-route-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "mock" as const,
      actor_engine: "mock" as const,
      critic_engine: "mock" as const
    };
    const task = await manager.createTask({
      request: "Original.",
      cwd: root,
      route
    });
    await rm(join(task.dir, "turns"), { recursive: true, force: true });
    await writeText(task.routePath, "{");
    await writeText(task.metaPath, "{");

    const turn = await manager.appendTurn(task, {
      request: "继续",
      route
    });

    expect(turn.turnId).toBe("0002");
    expect(await readTextIfExists(join(task.dir, "turns", "0001", "user.md"))).toContain("Original.");
    const backfilledRoute = await readJson(join(task.dir, "turns", "0001", "route.json"), RouteDecisionSchema);
    expect(backfilledRoute.reason).toBe("Requires workers.");
  });

  it("indexes legacy task metadata when appending the first follow-up turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-legacy-index-turns-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Original.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await rm(join(task.dir, "turns"), { recursive: true, force: true });
    await index.rebuildFromFiles();

    await manager.appendTurn(task, {
      request: "继续",
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    await expect(index.countRows("tasks")).resolves.toBe(1);
    await expect(index.countRows("turns")).resolves.toBe(2);
    index.close();
  });

  it("initializes worker status files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });

    const task = await manager.createTask({
      request: "Build the MVP.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    const worker = await manager.initializeWorker(task, {
      workerId: "judge-mock",
      role: "judge",
      engine: "mock",
      prompt: "Write requirements."
    });

    const status = await readJson(worker.statusPath, WorkerStatusSchema);

    expect(status.worker_id).toBe("judge-mock");
    expect(status.state).toBe("idle");
    expect(await readTextIfExists(worker.promptPath)).toContain("Write requirements.");
  });

  it("clears stale Judge artifacts while preserving its native session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-judge-artifacts-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Build the MVP.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "judge-mock",
      role: "judge",
      engine: "mock",
      prompt: "Write first-turn requirements."
    });
    await writeText(join(worker.dir, "requirements.md"), "stale requirements\n");
    await writeJson(join(worker.dir, "features.json"), { version: 1, features: [{ id: "stale" }] });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "judge",
      worker_id: "judge-mock",
      session_id: "judge-session",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });

    await manager.initializeWorker(task, {
      workerId: "judge-mock",
      role: "judge",
      engine: "mock",
      prompt: "Write second-turn requirements."
    });

    expect(await pathExists(join(worker.dir, "requirements.md"))).toBe(false);
    expect(await pathExists(join(worker.dir, "features.json"))).toBe(false);
    expect((await manager.readNativeSession(worker))?.session_id).toBe("judge-session");
  });

  it("never truncates an existing worker run log when the run is resumed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-log-resume-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Build the MVP.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "First run."
    });
    await writeText(worker.outputLogPath, "FIRST_RUN_EVIDENCE\n");

    await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Resume the same run."
    });

    const output = await readTextIfExists(worker.outputLogPath);
    expect(output).toContain("FIRST_RUN_EVIDENCE");
    expect(output).toContain("--- resume 2026-06-30T03:30:00.000Z ---");
  });

  it("stores worker native session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });

    const task = await manager.createTask({
      request: "Build the MVP.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });

    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-123",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });

    const record = await manager.readNativeSession(worker);
    const raw = await readJson(join(worker.dir, "native-session.json"), NativeSessionSchema);

    expect(record?.session_id).toBe("native-123");
    expect(raw.session_id).toBe("native-123");
    await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      native_session_id: "native-123"
    });
    await expect(index.workerNativeSessionId(task.id, worker.workerId)).resolves.toBe("native-123");
    index.close();
  });

  it("keeps a valid native session when only its SQLite projection fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-projection-failure-"));
    const initial = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "native-projection-failure"
    });
    const task = await initial.createTask({
      request: "Keep the active session.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await initial.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await writeJson(join(worker.dir, "native-session.json"), NativeSessionSchema.parse({
      engine: "mock",
      role: "actor",
      worker_id: worker.workerId,
      session_id: "native-valid",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:31:00.000Z",
      source: "manual"
    }));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      index: {
        upsertWorker: vi.fn().mockRejectedValue(new Error("worker index unavailable")),
        upsertNativeSession: vi.fn()
      } as unknown as SessionIndex
    });

    await expect(manager.readNativeSession(worker)).rejects.toThrow("worker index unavailable");

    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(true);
    await expect(readJson(join(worker.dir, "native-session.json"), NativeSessionSchema)).resolves.toMatchObject({
      session_id: "native-valid"
    });
  });

  it("retires worker native session metadata without leaving it active", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-retired-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });

    const task = await manager.createTask({
      request: "Build the MVP.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-123",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });
    await writeJson(worker.statusPath, WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-06-30T03:31:00.000Z",
      summary: "mock exited",
      native_session_id: "native-123"
    }));

    await manager.retireNativeSession(worker, "context window full");

    expect(await manager.readNativeSession(worker)).toBeNull();
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
    const status = await readJson(worker.statusPath, WorkerStatusSchema);
    expect(status.native_session_id).toBeUndefined();
    const retired = await readJson(join(worker.dir, "native-session.retired.json"), NativeSessionSchema.extend({
      retired_at: NativeSessionSchema.shape.last_used_at,
      retired_reason: NativeSessionSchema.shape.session_id
    }));
    expect(retired.session_id).toBe("native-123");
    expect(retired.retired_reason).toBe("context window full");
  });

  it("does not revive a native session after its retirement tombstone was committed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-retirement-tombstone-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:32:00.000Z"),
      randomId: () => "retirement-tombstone",
      index
    });
    const task = await manager.createTask({
      request: "Retire the old session.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    const record = NativeSessionSchema.parse({
      engine: "mock",
      role: "actor",
      worker_id: worker.workerId,
      session_id: "native-retired",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:31:00.000Z",
      source: "manual"
    });
    await manager.writeNativeSession(worker, record);
    await writeJson(worker.statusPath, WorkerStatusSchema.parse({
      worker_id: worker.workerId,
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-06-30T03:31:00.000Z",
      summary: "done",
      native_session_id: record.session_id
    }));
    await writeJson(join(worker.dir, "native-session.retired.json"), {
      ...record,
      retired_at: "2026-06-30T03:32:00.000Z",
      retired_reason: "context window full"
    });

    await expect(manager.readNativeSession(worker)).resolves.toBeNull();

    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
    await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.not.toHaveProperty("native_session_id");
    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    index.close();
  });

  it("defers retirement cleanup while another TUI owns the task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-retirement-lease-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:32:00.000Z"),
      randomId: () => "retirement-lease"
    });
    const task = await manager.createTask({
      request: "Keep the live owner safe.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    const record = NativeSessionSchema.parse({
      engine: "mock",
      role: "actor",
      worker_id: worker.workerId,
      session_id: "native-owned",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:31:00.000Z",
      source: "manual"
    });
    await manager.writeNativeSession(worker, record);
    await writeJson(join(worker.dir, "native-session.retired.json"), {
      ...record,
      retired_at: "2026-06-30T03:32:00.000Z",
      retired_reason: "context window full"
    });
    const lease = await claimTaskRunLease(task.dir, { ownerId: "live-owner" });

    try {
      await expect(manager.reconcileNativeSessionState()).resolves.toBe(0);
      expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(true);
    } finally {
      await lease.release();
    }

    await expect(manager.reconcileNativeSessionState()).resolves.toBe(1);
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
  });

  it("defers Main native-session cleanup while another TUI owns the shared session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-main-native-session-lease-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:32:00.000Z")
    });
    const mainDir = manager.mainSessionDir();
    const workerDir = join(mainDir, "main-mock");
    const nativePath = join(workerDir, "native-session.json");
    const record = NativeSessionSchema.parse({
      engine: "mock",
      role: "main",
      worker_id: "main-mock",
      session_id: "native-main-owned",
      scope: "main",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:31:00.000Z",
      source: "manual"
    });
    await mkdir(workerDir, { recursive: true });
    await writeJson(nativePath, record);
    await writeJson(join(workerDir, "native-session.retired.json"), {
      ...record,
      retired_at: "2026-06-30T03:32:00.000Z",
      retired_reason: "context window full"
    });
    await writeJson(join(workerDir, "status.json"), WorkerStatusSchema.parse({
      worker_id: "main-mock",
      role: "main",
      engine: "mock",
      state: "running",
      phase: "process-output",
      last_event_at: "2026-06-30T03:31:00.000Z",
      summary: "Main worker is active",
      native_session_id: record.session_id
    }));
    const lease = await claimTaskRunLease(mainDir, { ownerId: "live-main-owner" });

    try {
      await expect(manager.reconcileInterruptedMainSession()).resolves.toBeNull();
      await expect(manager.reconcileNativeSessionState()).resolves.toBe(0);
      expect(await pathExists(nativePath)).toBe(true);
      await expect(readJson(join(workerDir, "status.json"), WorkerStatusSchema)).resolves.toMatchObject({
        state: "running",
        phase: "process-output"
      });
    } finally {
      await lease.release();
    }

    await expect(manager.reconcileNativeSessionState()).resolves.toBe(1);
    expect(await pathExists(nativePath)).toBe(false);
  });

  it("keeps a fresh native session when its id differs from the retirement tombstone", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-retirement-new-session-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:32:00.000Z"),
      randomId: () => "retirement-new-session"
    });
    const task = await manager.createTask({
      request: "Keep the replacement session.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    const replacement = NativeSessionSchema.parse({
      engine: "mock",
      role: "actor",
      worker_id: worker.workerId,
      session_id: "native-new",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:32:00.000Z",
      last_used_at: "2026-06-30T03:32:00.000Z",
      source: "output-detected"
    });
    await manager.writeNativeSession(worker, replacement);
    await writeJson(join(worker.dir, "native-session.retired.json"), {
      ...replacement,
      session_id: "native-old",
      retired_at: "2026-06-30T03:31:00.000Z",
      retired_reason: "context window full"
    });

    await expect(manager.reconcileNativeSessionState()).resolves.toBe(0);
    await expect(manager.readNativeSession(worker)).resolves.toMatchObject({ session_id: "native-new" });
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(true);
  });

  it("clears corrupt native session metadata when retiring it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-retire-corrupt-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Build the MVP.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-corrupt",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });
    await writeText(join(worker.dir, "native-session.json"), "{");
    await writeJson(worker.statusPath, WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-06-30T03:31:00.000Z",
      summary: "mock exited",
      native_session_id: "native-corrupt"
    }));

    await expect(manager.retireNativeSession(worker, "context window full")).resolves.toBeUndefined();
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
    expect(await pathExists(join(worker.dir, "native-session.retired.json"))).toBe(false);
    const status = await readJson(worker.statusPath, WorkerStatusSchema);
    expect(status.native_session_id).toBeUndefined();
    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    index.close();
  });

  it("clears corrupt worker native session metadata when reading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-corrupt-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Build the MVP.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-corrupt",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });
    await writeText(join(worker.dir, "native-session.json"), "{");
    await writeJson(worker.statusPath, WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-06-30T03:31:00.000Z",
      summary: "mock exited",
      native_session_id: "native-corrupt"
    }));

    await expect(manager.readNativeSession(worker)).resolves.toBeNull();
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
    const status = await readJson(worker.statusPath, WorkerStatusSchema);
    expect(status.native_session_id).toBeUndefined();
    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    index.close();
  });

  it("ignores corrupt worker status while clearing corrupt native sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-corrupt-status-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Build the MVP.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-corrupt",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });
    await writeText(join(worker.dir, "native-session.json"), "{");
    await writeText(worker.statusPath, "{");

    await expect(manager.readNativeSession(worker)).resolves.toBeNull();
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    index.close();
  });

  it("mirrors session writes into the SQLite index", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-session-indexed-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "mock" as const,
      actor_engine: "mock" as const,
      critic_engine: "mock" as const
    };
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route
    });
    await manager.appendTurn(task, {
      request: "继续",
      route
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-123",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });

    await expect(index.countRows("tasks")).resolves.toBe(1);
    await expect(index.countRows("turns")).resolves.toBe(2);
    await expect(index.countRows("workers")).resolves.toBe(1);
    await expect(index.countRows("native_sessions")).resolves.toBe(1);
    index.close();
  });

  it("removes retired native sessions from the SQLite index", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-session-retired-index-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-123",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });

    await manager.retireNativeSession(worker, "context window full");

    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    index.close();
  });

  it("reconciles an interrupted task while preserving its retry checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-interrupted-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:00.000Z"),
      randomId: () => "orphan",
      index
    });
    const task = await manager.createTask({
      request: "实现可恢复任务",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });
    await advanceTaskToActor(manager, task);
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-codex-0001-ui",
      featureId: "0001-ui",
      featureTitle: "Game UI",
      role: "actor",
      engine: "codex",
      prompt: "implement UI"
    });
    await writeJson(worker.statusPath, {
      worker_id: worker.workerId,
      feature_id: "0001-ui",
      feature_title: "Game UI",
      role: "actor",
      engine: "codex",
      state: "running",
      phase: "process-output",
      last_event_at: "2026-07-11T14:29:00.000Z",
      summary: "editing UI",
      native_session_id: "native-ui-session"
    });
    const featureStatusPath = join(task.dir, "features", "0001-ui", "status.json");
    await writeJson(featureStatusPath, {
      feature_id: "0001-ui",
      task_id: task.id,
      turn_id: "0001",
      title: "Game UI",
      description: "Render the UI",
      depends_on: [],
      state: "actor_running",
      updated_at: "2026-07-11T14:29:00.000Z"
    });
    const passiveFeatureStatuses = [
      { id: "0001-engine", title: "Game Engine", state: "queued" },
      { id: "0001-docs", title: "Game Help", state: "actor_done" },
      { id: "0001-qa", title: "Game QA", state: "critic_done" }
    ] as const;
    for (const feature of passiveFeatureStatuses) {
      await writeJson(join(task.dir, "features", feature.id, "status.json"), {
        feature_id: feature.id,
        task_id: task.id,
        turn_id: "0001",
        title: feature.title,
        description: feature.title,
        depends_on: [],
        state: feature.state,
        updated_at: "2026-07-11T14:29:00.000Z"
      });
    }
    await writeJson(taskRunOwnerPath(task.dir), {
      version: 1,
      owner_id: "dead-tui",
      pid: 2147483647,
      acquired_at: "2026-07-11T14:28:00.000Z",
      process_start_token: "dead-token"
    });
    await writeWorkerProcessRecord(worker.dir, {
      workerId: worker.workerId,
      pid: 2147483647,
      command: "codex"
    });

    const recovered = await manager.reconcileInterruptedTasks();

    expect(recovered).toEqual([{
      taskId: task.id,
      previousState: "actor_running",
      workersRecovered: 1,
      featuresRecovered: 4,
      processesTerminated: 0
    }]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
    await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "cancelled",
      phase: "orphaned-after-restart",
      native_session_id: "native-ui-session"
    });
    expect(JSON.parse(await readTextIfExists(featureStatusPath))).toMatchObject({
      state: "cancelled",
      updated_at: "2026-07-11T14:30:00.000Z"
    });
    for (const feature of passiveFeatureStatuses) {
      expect(JSON.parse(await readTextIfExists(
        join(task.dir, "features", feature.id, "status.json")
      ))).toMatchObject({ state: "cancelled" });
    }
    expect(await readTextIfExists(worker.outputLogPath)).toContain("Recovered after previous TUI exit");
    expect(await readTextIfExists(task.eventsPath)).toContain("task.recovered_after_restart");
    expect(await pathExists(taskRunOwnerPath(task.dir))).toBe(false);
    expect(await pathExists(workerProcessRecordPath(worker.dir))).toBe(false);
    await expect(index.listTasks()).resolves.toEqual([
      expect.objectContaining({ id: task.id, status: "cancelled" })
    ]);
    index.close();
  });

  it("terminates and records an orphaned Main worker before a new runtime starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-main-orphan-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:00.000Z")
    });
    const mainDir = manager.mainSessionDir();
    const workerDir = join(mainDir, "main-mock");
    const statusPath = join(workerDir, "status.json");
    const outputLogPath = join(workerDir, "output.log");
    await mkdir(workerDir, { recursive: true });
    await writeJson(statusPath, WorkerStatusSchema.parse({
      worker_id: "main-mock",
      role: "main",
      engine: "mock",
      state: "running",
      phase: "process-output",
      last_event_at: "2026-07-11T14:29:00.000Z",
      summary: "answering a question",
      native_session_id: "main-native-session"
    }));
    await writeText(outputLogPath, "Main output before hard exit\n");
    await writeJson(taskRunOwnerPath(mainDir), {
      version: 1,
      owner_id: "dead-main-tui",
      pid: 2147483647,
      acquired_at: "2026-07-11T14:28:00.000Z",
      process_start_token: "dead-token"
    });
    const detached = process.platform !== "win32";
    const orphan = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached,
      stdio: "ignore"
    });
    orphan.unref();
    const orphanPid = orphan.pid ?? 0;
    if (!orphanPid) {
      throw new Error("Main orphan process did not receive a pid");
    }
    await writeWorkerProcessRecord(workerDir, {
      workerId: "main-mock",
      pid: orphanPid,
      command: process.execPath,
      ...(detached ? { processGroupId: orphanPid } : {})
    });

    try {
      const recovery = await (manager as SessionManager & {
        reconcileInterruptedMainSession(): Promise<{
          workersRecovered: number;
          processesTerminated: number;
        } | null>;
      }).reconcileInterruptedMainSession();

      expect(recovery).toEqual({ workersRecovered: 1, processesTerminated: 1 });
      expect(processIsAlive(orphanPid)).toBe(false);
      await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
        state: "cancelled",
        phase: "orphaned-after-restart",
        native_session_id: "main-native-session"
      });
      expect(await readTextIfExists(outputLogPath)).toContain("Recovered after previous TUI exit");
      expect(await pathExists(workerProcessRecordPath(workerDir))).toBe(false);
      expect(await pathExists(taskRunOwnerPath(mainDir))).toBe(false);
    } finally {
      if (processIsAlive(orphanPid)) {
        try {
          process.kill(detached ? -orphanPid : orphanPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed recovery assertion.
        }
      }
    }
  });

  it("blocks Main recovery when a recorded process identity is unverifiable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-main-unverifiable-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:00.000Z")
    });
    const mainDir = manager.mainSessionDir();
    const workerDir = join(mainDir, "main-mock");
    const statusPath = join(workerDir, "status.json");
    await writeJson(statusPath, WorkerStatusSchema.parse({
      worker_id: "main-mock",
      role: "main",
      engine: "mock",
      state: "running",
      phase: "process-output",
      last_event_at: "2026-07-11T14:29:00.000Z",
      summary: "answering a question"
    }));
    await writeJson(workerProcessRecordPath(workerDir), {
      version: 1,
      worker_id: "main-mock",
      pid: process.pid,
      owner_pid: 2147483647,
      command: process.execPath,
      started_at: "2026-07-11T14:29:00.000Z"
    });

    await expect(manager.reconcileInterruptedMainSession()).rejects.toThrow(
      "Startup recovery blocked for Main session"
    );

    await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "running",
      phase: "process-output"
    });
    expect(await pathExists(workerProcessRecordPath(workerDir))).toBe(true);
    expect(await pathExists(taskRunOwnerPath(mainDir))).toBe(false);
  });

  it("repairs a committed terminal transition projection during startup reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-status-transition-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:29:30.000Z"),
      randomId: () => "transition-repair",
      index
    });
    const task = await manager.createTask({
      request: "修复已提交状态投影",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Complex task completed.\n");
    const meta = await readJson(task.metaPath, TaskMetaSchema);
    await writeJson(task.metaPath, TaskMetaSchema.parse({
      ...meta,
      status: "done",
      status_transition: {
        id: "transition-created-done",
        from: "created",
        to: "done",
        at: "2026-07-11T14:29:15.000Z"
      }
    }));

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);
    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);

    const events = await readTextIfExists(task.eventsPath);
    expect(countOccurrences(events, '"transition_id":"transition-created-done"')).toBe(1);
    expect(events).toContain('"type":"task.done"');
    expect(events).toContain('"from_state":"created"');
    expect(events).toContain('"to_state":"done"');
    await expect(index.listTasks()).resolves.toEqual([
      expect.objectContaining({ id: task.id, status: "done" })
    ]);
    index.close();
  });

  it("recovers an incomplete terminal done task instead of hiding missing completion evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-incomplete-done-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:10.000Z"),
      randomId: () => "incomplete-done"
    });
    const task = await manager.createTask({
      request: "Build completion evidence.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const featureStatusPath = join(task.dir, "features", "0001-completion", "status.json");
    await writeJson(featureStatusPath, {
      feature_id: "0001-completion",
      task_id: task.id,
      turn_id: "0001",
      title: "Completion",
      description: "Publish completion evidence",
      depends_on: [],
      state: "integrating",
      updated_at: "2026-07-11T14:30:00.000Z"
    });
    await writeJson(join(task.dir, "workspaces", "turn-0001", "wave-0001", "integration.json"), {
      version: 1,
      state: "integrated",
      changed_paths: []
    });
    const legacyMeta = await readJson(task.metaPath, TaskMetaSchema);
    await writeJson(task.metaPath, { ...legacyMeta, status: "done" });

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([{
      taskId: task.id,
      previousState: "done",
      workersRecovered: 0,
      featuresRecovered: 1,
      processesTerminated: 0
    }]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
    expect(JSON.parse(await readTextIfExists(featureStatusPath))).toMatchObject({ state: "cancelled" });
    expect(await readTextIfExists(task.eventsPath)).toContain("task.recovered_incomplete_done");
  });

  it("recovers a follow-up turn that was persisted before its routed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-persisted-follow-up-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:15.000Z"),
      randomId: () => "persisted-follow-up"
    });
    const route = {
      mode: "complex" as const,
      reason: "Project work.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "mock" as const,
      actor_engine: "mock" as const,
      critic_engine: "mock" as const
    };
    const task = await manager.createTask({ request: "Build it.", cwd: root, route });
    await manager.updateTaskStatus(task, "judging");
    await manager.updateTaskStatus(task, "ready_for_pair");
    await manager.updateTaskStatus(task, "actor_running");
    await manager.updateTaskStatus(task, "critic_running");
    await manager.updateTaskStatus(task, "integrating");
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Initial task completed.\n");
    await manager.updateTaskStatus(task, "done");
    const completedMeta = await readJson(task.metaPath, TaskMetaSchema);

    await manager.appendTurn(task, { request: "Continue it.", route });
    await writeJson(task.metaPath, completedMeta);

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([{
      taskId: task.id,
      previousState: "done",
      workersRecovered: 0,
      featuresRecovered: 0,
      processesTerminated: 0
    }]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
    expect(await readTextIfExists(task.eventsPath)).toContain("task.recovered_incomplete_done");
  });

  it("publishes a complete pending follow-up turn during startup recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-pending-turn-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:16.000Z"),
      randomId: () => "pending-turn"
    });
    const route = testComplexRoute("Recovered pending route.");
    const task = await manager.createTask({ request: "Build it.", cwd: root, route });
    await completeTaskWithoutFeatures(manager, task, "Initial task completed.");
    const pendingDir = join(task.dir, "turns", ".turn-0002-crashed.pending");
    await writeText(join(pendingDir, "user.md"), "Continue the feature.\n");
    await writeJson(join(pendingDir, "route.json"), route);
    await writeJson(join(pendingDir, "turn.json"), {
      task_id: task.id,
      turn_id: "0002",
      created_at: "2026-07-11T14:30:15.000Z",
      request_path: "turns/0002/user.md"
    });

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([{
      taskId: task.id,
      previousState: "done",
      workersRecovered: 0,
      featuresRecovered: 0,
      processesTerminated: 0,
      turnsPublished: 1
    }]);

    expect(await pathExists(pendingDir)).toBe(false);
    await expect(manager.latestTurn(task)).resolves.toMatchObject({ turnId: "0002" });
    await expect(readJson(join(task.dir, "turns", "0002", "route.json"), RouteDecisionSchema)).resolves.toMatchObject({
      reason: "Recovered pending route."
    });
    expect(await readTextIfExists(task.eventsPath)).toContain("turn.recovered_after_restart");
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("repairs a partial pending turn from its durable request and latest route", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-partial-turn-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:17.000Z"),
      randomId: () => "partial-turn"
    });
    const initialRoute = testComplexRoute("Initial route.");
    const followUpRoute = testComplexRoute("Latest follow-up route.");
    const task = await manager.createTask({ request: "Build it.", cwd: root, route: initialRoute });
    await completeTaskWithoutFeatures(manager, task, "Initial task completed.");
    await manager.recordLatestRoute(task, followUpRoute);
    const pendingDir = join(task.dir, "turns", ".turn-0002-input-only.pending");
    await writeText(join(pendingDir, "user.md"), "Continue from this exact request.\n");

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([
      expect.objectContaining({ taskId: task.id, turnsRepaired: 1 })
    ]);

    expect(await pathExists(pendingDir)).toBe(false);
    expect(await readTextIfExists(join(task.dir, "turns", "0002", "user.md"))).toContain(
      "Continue from this exact request."
    );
    await expect(readJson(join(task.dir, "turns", "0002", "route.json"), RouteDecisionSchema)).resolves.toMatchObject({
      reason: "Latest follow-up route."
    });
    expect(await readTextIfExists(task.eventsPath)).toContain("turn.repaired_after_restart");
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("quarantines an empty pending turn without changing a completed task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-empty-pending-turn-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:18.000Z"),
      randomId: () => "empty-pending-turn"
    });
    const route = testComplexRoute("Initial route.");
    const task = await manager.createTask({ request: "Build it.", cwd: root, route });
    await completeTaskWithoutFeatures(manager, task, "Initial task completed.");
    const pendingName = ".turn-0002-empty.pending";
    const pendingDir = join(task.dir, "turns", pendingName);
    await writeText(join(pendingDir, "incomplete.tmp"), "");

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);
    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);

    expect(await pathExists(pendingDir)).toBe(false);
    expect(await pathExists(join(task.dir, "turns", ".abandoned", pendingName))).toBe(true);
    expect((await readdir(join(task.dir, "turns"))).filter((entry) => /^\d{4}$/.test(entry))).toEqual(["0001"]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "done" });
    expect(countOccurrences(await readTextIfExists(task.eventsPath), "turn.pending_abandoned")).toBe(1);
  });

  it("keeps an evidence-complete terminal done task untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-complete-done-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:20.000Z"),
      randomId: () => "complete-done"
    });
    const task = await manager.createTask({
      request: "Build complete evidence.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Complex task completed.\n");
    await writeJson(join(task.dir, "features", "0001-complete", "status.json"), {
      feature_id: "0001-complete",
      task_id: task.id,
      turn_id: "0001",
      title: "Complete",
      description: "Complete evidence",
      depends_on: [],
      state: "approved",
      updated_at: "2026-07-11T14:30:19.000Z"
    });
    await advanceTaskToIntegrating(manager, task);
    await manager.updateTaskStatus(task, "done");

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "done" });
  });

  it("allows only one startup process to reconcile the same interrupted task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-race-"));
    const left = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:30.000Z"),
      randomId: () => "race"
    });
    const right = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:31.000Z"),
      randomId: () => "unused"
    });
    const task = await left.createTask({
      request: "并发恢复任务",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await advanceTaskToActor(left, task);
    const worker = await left.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "keep working"
    });
    await writeJson(worker.statusPath, {
      worker_id: worker.workerId,
      role: "actor",
      engine: "mock",
      state: "running",
      phase: "process-output",
      last_event_at: "2026-07-11T14:30:00.000Z",
      summary: "working"
    });

    type ReconcileInternals = {
      reconcileTaskWorkers(task: TaskSession): Promise<{ recovered: number; terminated: number }>;
    };
    let entrants = 0;
    let openGate = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    for (const manager of [left, right]) {
      const internal = manager as unknown as ReconcileInternals;
      const original = internal.reconcileTaskWorkers.bind(manager);
      internal.reconcileTaskWorkers = async (currentTask) => {
        entrants += 1;
        if (entrants === 2) {
          openGate();
        }
        await Promise.race([
          gate,
          new Promise((resolve) => setTimeout(resolve, 100))
        ]);
        return original(currentTask);
      };
    }

    const results = await Promise.all([
      left.reconcileInterruptedTasks(),
      right.reconcileInterruptedTasks()
    ]);

    expect(results.flat()).toHaveLength(1);
    expect(entrants).toBe(1);
    expect(countOccurrences(await readTextIfExists(task.eventsPath), "task.recovered_after_restart")).toBe(1);
    expect(countOccurrences(await readTextIfExists(worker.outputLogPath), "Recovered after previous TUI exit")).toBe(1);
    expect(await pathExists(taskRunOwnerPath(task.dir))).toBe(false);
  });

  it("leaves a nonterminal task untouched while its owner lease is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-live-owner-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:31:00.000Z"),
      randomId: () => "live"
    });
    const task = await manager.createTask({
      request: "保持运行",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await advanceTaskToActor(manager, task);
    const lease = await claimTaskRunLease(task.dir, { ownerId: "live-tui" });

    try {
      await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);
      await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "actor_running" });
    } finally {
      await lease.release();
    }
  });

  it("does not commit recovery while a recorded worker process cannot be verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-unverifiable-worker-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:31:30.000Z"),
      randomId: () => "unverifiable"
    });
    const task = await manager.createTask({
      request: "安全恢复无法验证的进程",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await advanceTaskToActor(manager, task);
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      featureId: "0001-safety",
      role: "actor",
      engine: "mock",
      prompt: "keep working"
    });
    await writeJson(worker.statusPath, {
      worker_id: worker.workerId,
      feature_id: "0001-safety",
      role: "actor",
      engine: "mock",
      state: "running",
      phase: "process-output",
      last_event_at: "2026-07-11T14:31:00.000Z",
      summary: "working"
    });
    const featureStatusPath = join(task.dir, "features", "0001-safety", "status.json");
    await writeJson(featureStatusPath, {
      feature_id: "0001-safety",
      task_id: task.id,
      turn_id: "0001",
      title: "Recovery safety",
      description: "Do not overlap workers",
      depends_on: [],
      state: "actor_running",
      updated_at: "2026-07-11T14:31:00.000Z"
    });
    await writeJson(workerProcessRecordPath(worker.dir), {
      version: 1,
      worker_id: worker.workerId,
      pid: process.pid,
      owner_pid: 2147483647,
      command: process.execPath,
      started_at: "2026-07-11T14:31:00.000Z"
    });

    await expect(manager.reconcileInterruptedTasks()).rejects.toThrow(
      `Startup recovery blocked for task ${task.id}`
    );

    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "actor_running" });
    await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "running",
      phase: "process-output"
    });
    expect(JSON.parse(await readTextIfExists(featureStatusPath))).toMatchObject({ state: "actor_running" });
    expect(await pathExists(workerProcessRecordPath(worker.dir))).toBe(true);
    expect(await pathExists(taskRunOwnerPath(task.dir))).toBe(false);
    expect(await readTextIfExists(worker.outputLogPath)).not.toContain("Recovered after previous TUI exit");
    expect(await readTextIfExists(task.eventsPath)).toContain("task.recovery_blocked");
    expect(await readTextIfExists(task.eventsPath)).not.toContain("task.cancelled");
  });

  it("terminates a recorded orphan even when its worker status is already terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-terminal-worker-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:32:00.000Z"),
      randomId: () => "terminal-worker"
    });
    const task = await manager.createTask({
      request: "恢复超时进程",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await advanceTaskToActor(manager, task);
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "keep running"
    });
    await writeJson(worker.statusPath, {
      worker_id: worker.workerId,
      role: "actor",
      engine: "mock",
      state: "failed",
      phase: "process-idle-timeout",
      last_event_at: "2026-07-11T14:31:00.000Z",
      summary: "worker timed out"
    });
    const detached = process.platform !== "win32";
    const orphan = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached,
      stdio: "ignore"
    });
    orphan.unref();
    const orphanPid = orphan.pid ?? 0;
    if (!orphanPid) {
      throw new Error("Orphan process did not receive a pid");
    }
    await writeWorkerProcessRecord(worker.dir, {
      workerId: worker.workerId,
      pid: orphanPid,
      command: process.execPath,
      ...(detached ? { processGroupId: orphanPid } : {})
    });

    try {
      const recovered = await manager.reconcileInterruptedTasks();

      expect(recovered).toEqual([{
        taskId: task.id,
        previousState: "actor_running",
        workersRecovered: 0,
        featuresRecovered: 0,
        processesTerminated: 1
      }]);
      expect(processIsAlive(orphanPid)).toBe(false);
      expect(await pathExists(workerProcessRecordPath(worker.dir))).toBe(false);
      await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
        state: "failed",
        phase: "process-idle-timeout"
      });
    } finally {
      if (processIsAlive(orphanPid)) {
        try {
          process.kill(detached ? -orphanPid : orphanPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed reconciliation assertion.
        }
      }
    }
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function advanceTaskToReady(manager: SessionManager, task: TaskSession): Promise<void> {
  await manager.updateTaskStatus(task, "judging");
  await manager.updateTaskStatus(task, "ready_for_pair");
}

async function advanceTaskToActor(manager: SessionManager, task: TaskSession): Promise<void> {
  await advanceTaskToReady(manager, task);
  await manager.updateTaskStatus(task, "actor_running");
}

async function advanceTaskToIntegrating(manager: SessionManager, task: TaskSession): Promise<void> {
  await advanceTaskToActor(manager, task);
  await manager.updateTaskStatus(task, "critic_running");
  await manager.updateTaskStatus(task, "integrating");
}

async function completeTaskWithoutFeatures(
  manager: SessionManager,
  task: TaskSession,
  summary: string
): Promise<void> {
  await advanceTaskToIntegrating(manager, task);
  await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), `${summary}\n`);
  await manager.updateTaskStatus(task, "done");
}

function testComplexRoute(reason: string) {
  return RouteDecisionSchema.parse({
    mode: "complex",
    reason,
    suggested_roles: ["judge", "actor", "critic"],
    judge_engine: "mock",
    actor_engine: "mock",
    critic_engine: "mock"
  });
}

async function writePendingTaskCreation(
  stagingDir: string,
  taskId: string,
  cwd: string,
  pid: number,
  complete: boolean
): Promise<void> {
  await writeJson(`${stagingDir}.json`, {
    version: 1,
    task_id: taskId,
    pid,
    started_at: "2026-07-11T15:01:59.000Z"
  });
  await writeText(join(stagingDir, "user-request.md"), "Recover this task creation.\n");
  if (!complete) {
    return;
  }

  const route = testComplexRoute("Recovered task creation.");
  await writeJson(join(stagingDir, "meta.json"), TaskMetaSchema.parse({
    id: taskId,
    title: "Recover this task creation.",
    created_at: "2026-07-11T15:01:59.000Z",
    cwd,
    mode: "complex",
    status: "routed"
  }));
  await writeJson(join(stagingDir, "route.json"), route);
  await writeText(join(stagingDir, "turns", "0001", "user.md"), "Recover this task creation.\n");
  await writeJson(join(stagingDir, "turns", "0001", "route.json"), route);
  await writeJson(join(stagingDir, "turns", "0001", "turn.json"), TurnMetaSchema.parse({
    task_id: taskId,
    turn_id: "0001",
    created_at: "2026-07-11T15:01:59.000Z",
    request_path: "turns/0001/user.md"
  }));
}
