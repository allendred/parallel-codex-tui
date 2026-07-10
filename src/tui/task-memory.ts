export interface SubmitMemoryState {
  activeTaskId: string | null;
  activeMode: "simple" | "complex" | null;
}

export interface SubmitResultMemory {
  mode: "simple" | "complex";
  taskId: string | null;
}

export function newTaskMemoryState(): SubmitMemoryState {
  return {
    activeTaskId: null,
    activeMode: null
  };
}

export type SubmitTarget =
  | {
      kind: "new-request";
    }
  | {
      kind: "task-turn";
      taskId: string;
    }
  | {
      kind: "task-question";
      taskId: string;
    };

export function chooseSubmitTarget(state: SubmitMemoryState, route?: SubmitResultMemory): SubmitTarget {
  if (state.activeTaskId && state.activeMode === "complex") {
    if (route?.mode === "simple") {
      return {
        kind: "task-question",
        taskId: state.activeTaskId
      };
    }

    return {
      kind: "task-turn",
      taskId: state.activeTaskId
    };
  }

  return {
    kind: "new-request"
  };
}

export function nextSubmitMemoryState(
  current: SubmitMemoryState,
  target: SubmitTarget,
  result: SubmitResultMemory
): SubmitMemoryState {
  if (target.kind === "task-question") {
    return current;
  }

  return {
    activeMode: result.mode,
    activeTaskId: result.mode === "complex" ? result.taskId : null
  };
}

export function shouldClearWorkersForSubmit(target: SubmitTarget): boolean {
  return target.kind !== "task-question";
}
