import type { AppConfig } from "../core/config.js";
import type { EngineName } from "../domain/schemas.js";

export type WorkerProviderConfig = AppConfig["workers"][string];

export interface WorkerProvider {
  id: EngineName;
  config: WorkerProviderConfig;
}

export function workerProvider(config: AppConfig, id: EngineName): WorkerProvider {
  const provider = config.workers[id];
  if (!provider) {
    throw new Error(`Worker provider is not configured: ${id}`);
  }
  return { id, config: provider };
}

export function workerProviders(config: AppConfig): WorkerProvider[] {
  return Object.entries(config.workers)
    .map(([id, provider]) => ({ id, config: provider }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function assignableWorkerProviderIds(config: AppConfig): EngineName[] {
  return workerProviders(config)
    .filter((provider) => provider.config.assignable)
    .map((provider) => provider.id);
}

export function workerProviderLabel(config: AppConfig, id: EngineName): string {
  const provider = config.workers[id];
  if (!provider) {
    return id;
  }
  const model = provider.model.name.trim();
  const remote = provider.model.provider.trim();
  return [id, model, remote].filter(Boolean).join("/");
}
