import type { AppConfig } from "../core/config.js";
import type { EngineName } from "../domain/schemas.js";
import { MockWorkerAdapter } from "./mock-adapter.js";
import { ProcessWorkerAdapter } from "./process-adapter.js";
import { workerProviders } from "./provider.js";
import type { WorkerAdapter } from "./types.js";

export type WorkerRegistry = Map<EngineName, WorkerAdapter>;

export function createWorkerRegistry(config: AppConfig): WorkerRegistry {
  return new Map<EngineName, WorkerAdapter>(workerProviders(config).map(({ id, config: provider }) => [
    id,
    id === "mock"
      ? new MockWorkerAdapter()
      : new ProcessWorkerAdapter(provider.command, provider.args, id, {
          timeoutMs: provider.timeoutMs,
          idleTimeoutMs: provider.idleTimeoutMs,
          firstOutputTimeoutMs: provider.firstOutputTimeoutMs,
          model: provider.model,
          capabilities: provider.capabilities
        })
  ]));
}

export function getAdapter(registry: WorkerRegistry, engine: EngineName): WorkerAdapter {
  const adapter = registry.get(engine);

  if (!adapter) {
    throw new Error(`No worker adapter registered for engine: ${engine}`);
  }

  return adapter;
}
