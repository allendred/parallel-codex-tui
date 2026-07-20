import { prepareAppRoot } from "./core/app-root.js";
import { configPath, loadConfig, writeDefaultConfig, type AppConfig } from "./core/config.js";
import { ensureDir, pathExists } from "./core/file-store.js";
import { routerRuntimeDir } from "./core/paths.js";
import { RoleConfigurationManager } from "./core/role-configuration.js";
import { SessionIndex } from "./core/session-index.js";
import {
  SessionManager,
  type InterruptedTaskRecovery,
  type PendingTaskCreationRecovery
} from "./core/session-manager.js";
import { prepareWorkspace } from "./core/workspace.js";
import {
  reconcileWorkspaceCommitIntents,
  type WorkspaceCommitRecovery
} from "./core/workspace-commit-recovery.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createWorkerRegistry, type WorkerRegistry } from "./workers/registry.js";

export interface AppRuntime {
  config: AppConfig;
  workspaceRoot: string;
  routerCwd: string;
  index: SessionIndex;
  sessions: SessionManager;
  workers: WorkerRegistry;
  orchestrator: Orchestrator;
  roleConfiguration: RoleConfigurationManager;
  pendingTaskCreations: PendingTaskCreationRecovery;
  workspaceCommitRecovery: WorkspaceCommitRecovery;
  recoveredTasks: InterruptedTaskRecovery[];
}

export async function createRuntime(appRoot: string, workspaceRoot = appRoot): Promise<AppRuntime> {
  await prepareAppRoot(appRoot);
  if (!(await pathExists(configPath(appRoot)))) {
    await writeDefaultConfig(appRoot);
  }
  const config = await loadConfig(appRoot);
  const routerCwd = routerRuntimeDir(appRoot, config.dataDir);
  await ensureDir(routerCwd);
  const preparedWorkspace = await prepareWorkspace(appRoot, workspaceRoot);
  const index = await SessionIndex.open(preparedWorkspace, config.dataDir);
  try {
    await index.rebuildFromFiles();
    const sessions = new SessionManager({
      projectRoot: preparedWorkspace,
      dataDir: config.dataDir,
      index
    });
    const roleConfiguration = await RoleConfigurationManager.open({
      config,
      appRoot,
      workspaceRoot: preparedWorkspace
    });
    const pendingTaskCreations = await sessions.reconcilePendingTaskCreations();
    const workspaceCommitRecovery = await reconcileWorkspaceCommitIntents(preparedWorkspace, config.dataDir);
    await sessions.reconcileInterruptedMainSession();
    await sessions.reconcileNativeSessionState();
    const recoveredTasks = await sessions.reconcileInterruptedTasks();
    const workers = createWorkerRegistry(config);
    const orchestrator = new Orchestrator(
      config,
      sessions,
      workers,
      undefined,
      routerCwd,
      async () => (await loadConfig(appRoot)).router,
      { roleConfiguration }
    );

    return {
      config,
      workspaceRoot: preparedWorkspace,
      routerCwd,
      index,
      sessions,
      workers,
      orchestrator,
      roleConfiguration,
      pendingTaskCreations,
      workspaceCommitRecovery,
      recoveredTasks
    };
  } catch (error) {
    try {
      index.close();
    } catch {
      // Preserve the startup failure that prevented the runtime from being created.
    }
    throw error;
  }
}
