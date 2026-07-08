import { configPath, loadConfig, writeDefaultConfig, type AppConfig } from "./core/config.js";
import { pathExists } from "./core/file-store.js";
import { SessionIndex } from "./core/session-index.js";
import { SessionManager } from "./core/session-manager.js";
import { prepareWorkspace } from "./core/workspace.js";
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
  if (!(await pathExists(configPath(appRoot)))) {
    await writeDefaultConfig(appRoot);
  }
  const config = await loadConfig(appRoot);
  const preparedWorkspace = await prepareWorkspace(appRoot, workspaceRoot);
  const index = await SessionIndex.open(preparedWorkspace, config.dataDir);
  await index.rebuildFromFiles();
  const sessions = new SessionManager({
    projectRoot: preparedWorkspace,
    dataDir: config.dataDir,
    index
  });
  const workers = createWorkerRegistry(config);
  const orchestrator = new Orchestrator(config, sessions, workers);

  return {
    config,
    workspaceRoot: preparedWorkspace,
    index,
    sessions,
    workers,
    orchestrator
  };
}
