import type { AppConfig } from "../core/config.js";
import type { EngineName } from "../domain/schemas.js";
import { MockWorkerAdapter } from "./mock-adapter.js";
import { ProcessWorkerAdapter } from "./process-adapter.js";
import type { WorkerAdapter } from "./types.js";

export type WorkerRegistry = Map<EngineName, WorkerAdapter>;

export function createWorkerRegistry(config: AppConfig): WorkerRegistry {
  return new Map<EngineName, WorkerAdapter>([
    ["mock", new MockWorkerAdapter()],
    [
      "codex",
      new ProcessWorkerAdapter(config.workers.codex.command, config.workers.codex.args, "codex", {
        timeoutMs: config.workers.codex.timeoutMs,
        idleTimeoutMs: config.workers.codex.idleTimeoutMs,
        firstOutputTimeoutMs: config.workers.codex.firstOutputTimeoutMs,
        model: config.workers.codex.model
      })
    ],
    [
      "claude",
      new ProcessWorkerAdapter(config.workers.claude.command, config.workers.claude.args, "claude", {
        timeoutMs: config.workers.claude.timeoutMs,
        idleTimeoutMs: config.workers.claude.idleTimeoutMs,
        firstOutputTimeoutMs: config.workers.claude.firstOutputTimeoutMs,
        model: config.workers.claude.model
      })
    ]
  ]);
}

export function getAdapter(registry: WorkerRegistry, engine: EngineName): WorkerAdapter {
  const adapter = registry.get(engine);

  if (!adapter) {
    throw new Error(`No worker adapter registered for engine: ${engine}`);
  }

  return adapter;
}
