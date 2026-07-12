import { describe, expect, it } from "vitest";
import { startupRecoveryMessages } from "../src/cli-startup-recovery.js";
import type { InterruptedTaskRecovery } from "../src/core/session-manager.js";

describe("startupRecoveryMessages", () => {
  it("distinguishes a restored follow-up turn from missing completion evidence", () => {
    const recovery = recoveredTask({ previousState: "done", turnsRepaired: 1 });

    expect(startupRecoveryMessages([recovery], recovery.taskId)).toEqual([{
      from: "system",
      text: expect.stringMatching(
        /^Recovered follow-up turn #.+ · request and route kept · checkpoints kept · Ctrl\+R resume$/
      )
    }]);
  });

  it("keeps worker and legacy completion recovery actions specific", () => {
    const worker = recoveredTask({ previousState: "actor_running", workersRecovered: 2 });
    const legacyDone = recoveredTask({ taskId: "task-legacy", previousState: "done" });

    expect(startupRecoveryMessages([worker], worker.taskId)[0]?.text).toContain(
      "2 workers stopped · checkpoints kept · Ctrl+R resume"
    );
    expect(startupRecoveryMessages([legacyDone], legacyDone.taskId)[0]?.text).toContain(
      "completion evidence missing · checkpoints kept · Ctrl+R rebuild"
    );
  });

  it("summarizes restored turns when recovered tasks are not active", () => {
    const repaired = recoveredTask({ turnsRepaired: 1 });
    const ordinary = recoveredTask({ taskId: "task-other" });

    expect(startupRecoveryMessages([repaired, ordinary], null)).toEqual([{
      from: "system",
      text: "Recovered 2 interrupted tasks · 1 turn restored · checkpoints kept · Ctrl+T inspect"
    }]);
  });
});

function recoveredTask(
  override: Partial<InterruptedTaskRecovery> = {}
): InterruptedTaskRecovery {
  return {
    taskId: "task-20260711-143017-partial",
    previousState: "actor_running",
    workersRecovered: 0,
    featuresRecovered: 0,
    processesTerminated: 0,
    ...override
  };
}
