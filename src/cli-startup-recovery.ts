import type {
  InterruptedTaskRecovery,
  PendingTaskCreationRecovery
} from "./core/session-manager.js";

export interface StartupRecoveryMessage {
  from: "system";
  text: string;
}

export function startupRecoveryMessages(
  recoveredTasks: InterruptedTaskRecovery[],
  activeTaskId: string | null,
  pendingTaskCreations?: PendingTaskCreationRecovery
): StartupRecoveryMessage[] {
  return [
    ...interruptedTaskRecoveryMessages(recoveredTasks, activeTaskId),
    ...pendingTaskCreationMessages(pendingTaskCreations)
  ];
}

function interruptedTaskRecoveryMessages(
  recoveredTasks: InterruptedTaskRecovery[],
  activeTaskId: string | null
): StartupRecoveryMessage[] {
  if (recoveredTasks.length === 0) {
    return [];
  }
  const active = activeTaskId
    ? recoveredTasks.find((recovery) => recovery.taskId === activeTaskId)
    : null;
  if (active) {
    const restoredTurns = restoredTurnCount(active);
    const archived = archivedTurnDetail(active);
    if (restoredTurns > 0) {
      return [{
        from: "system",
        text: `Recovered ${restoredTurns === 1 ? "follow-up turn" : `${restoredTurns} follow-up turns`} #${compactStartupTaskId(active.taskId)} · request and route kept${archived} · checkpoints kept · Ctrl+R resume`
      }];
    }
    if (active.previousState === "done") {
      return [{
        from: "system",
        text: `Recovered incomplete task #${compactStartupTaskId(active.taskId)} · completion evidence missing${archived} · checkpoints kept · Ctrl+R rebuild`
      }];
    }
    const workerLabel = `${active.workersRecovered} ${active.workersRecovered === 1 ? "worker" : "workers"}`;
    return [{
      from: "system",
      text: `Recovered interrupted task #${compactStartupTaskId(active.taskId)} · ${workerLabel} stopped${archived} · checkpoints kept · Ctrl+R resume`
    }];
  }

  const restoredTurns = recoveredTasks.reduce((total, recovery) => total + restoredTurnCount(recovery), 0);
  const turnDetail = restoredTurns > 0
    ? ` · ${restoredTurns} ${restoredTurns === 1 ? "turn" : "turns"} restored`
    : "";
  return [{
    from: "system",
    text: `Recovered ${recoveredTasks.length} interrupted ${recoveredTasks.length === 1 ? "task" : "tasks"}${turnDetail} · checkpoints kept · Ctrl+T inspect`
  }];
}

function pendingTaskCreationMessages(
  recovery?: PendingTaskCreationRecovery
): StartupRecoveryMessage[] {
  if (!recovery || (recovery.abandoned === 0 && recovery.active === 0)) {
    return [];
  }
  const details: string[] = [];
  if (recovery.abandoned > 0) {
    details.push(
      `${recovery.abandoned} incomplete task ${recovery.abandoned === 1 ? "creation" : "creations"} archived`
    );
  }
  if (recovery.active > 0) {
    details.push(
      `${recovery.active} task ${recovery.active === 1 ? "creation" : "creations"} active in another TUI`
    );
  }
  return [{
    from: "system",
    text: `Startup cleanup · ${details.join(" · ")}`
  }];
}

function restoredTurnCount(recovery: InterruptedTaskRecovery): number {
  return (recovery.turnsPublished ?? 0) + (recovery.turnsRepaired ?? 0);
}

function archivedTurnDetail(recovery: InterruptedTaskRecovery): string {
  const count = recovery.turnsAbandoned ?? 0;
  return count > 0 ? ` · ${count} ${count === 1 ? "fragment" : "fragments"} archived` : "";
}

function compactStartupTaskId(taskId: string): string {
  const parts = taskId.split("-");
  return parts.length > 2 ? parts.slice(-2).join("-") : taskId;
}
