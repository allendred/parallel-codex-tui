import { loadConfig, type AppConfig } from "./core/config.js";
import { SessionIndex } from "./core/session-index.js";
import { SessionManager } from "./core/session-manager.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createWorkerRegistry, type WorkerRegistry } from "./workers/registry.js";

export interface AppRuntime {
  config: AppConfig;
  workspaceRoot: string;
  index: SessionIndex;
  sessions: SessionManager;
  workers: WorkerRegistry;
  orchestrator: Orchestrator;
}

export async function createRuntime(appRoot: string, workspaceRoot = appRoot): Promise<AppRuntime> {
  const config = await loadConfig(appRoot);
  const index = await SessionIndex.open(workspaceRoot, config.dataDir);
  await index.rebuildFromFiles();
  const sessions = new SessionManager({
    projectRoot: workspaceRoot,
    dataDir: config.dataDir,
    index
  });
  const workers = createWorkerRegistry(config);
  const orchestrator = new Orchestrator(config, sessions, workers);

  return {
    config,
    workspaceRoot,
    index,
    sessions,
    workers,
    orchestrator
  };
}
