import { describe, expect, it } from "vitest";
import { chooseSubmitTarget, nextSubmitMemoryState } from "../src/tui/task-memory.js";

describe("chooseSubmitTarget", () => {
  it("continues the active complex task for follow-up input", () => {
    expect(
      chooseSubmitTarget({
        activeTaskId: "task-a",
        activeMode: "complex"
      })
    ).toEqual({
      kind: "task-turn",
      taskId: "task-a"
    });
  });

  it("answers question-like follow-ups from the active complex task", () => {
    expect(
      chooseSubmitTarget(
        {
          activeTaskId: "task-a",
          activeMode: "complex"
        },
        {
          mode: "simple",
          taskId: null
        }
      )
    ).toEqual({
      kind: "task-question",
      taskId: "task-a"
    });
  });

  it("keeps status follow-ups out of the Actor Critic loop", () => {
    expect(
      chooseSubmitTarget(
        {
          activeTaskId: "task-a",
          activeMode: "complex"
        },
        {
          mode: "simple",
          taskId: null
        }
      )
    ).toEqual({
      kind: "task-question",
      taskId: "task-a"
    });
  });

  it("continues the active task by default for non-question follow-up input", () => {
    expect(
      chooseSubmitTarget({
        activeTaskId: "task-a",
        activeMode: "complex"
      })
    ).toEqual({
      kind: "task-turn",
      taskId: "task-a"
    });
  });

  it("continues the active task when the follow-up route is complex", () => {
    expect(
      chooseSubmitTarget(
        {
          activeTaskId: "task-a",
          activeMode: "complex"
        },
        {
          mode: "complex",
          taskId: "task-a"
        }
      )
    ).toEqual({
      kind: "task-turn",
      taskId: "task-a"
    });
  });

  it("starts a new request when there is no active task", () => {
    expect(
      chooseSubmitTarget({
        activeTaskId: null,
        activeMode: null
      })
    ).toEqual({
      kind: "new-request"
    });
  });

  it("starts a new request after simple chat", () => {
    expect(
      chooseSubmitTarget({
        activeTaskId: null,
        activeMode: "simple"
      })
    ).toEqual({
      kind: "new-request"
    });
  });

  it("keeps the active task after answering a task question", () => {
    expect(
      nextSubmitMemoryState(
        {
          activeTaskId: "task-a",
          activeMode: "complex"
        },
        {
          kind: "task-question",
          taskId: "task-a"
        },
        {
          mode: "simple",
          taskId: "task-a"
        }
      )
    ).toEqual({
      activeTaskId: "task-a",
      activeMode: "complex"
    });
  });
});
