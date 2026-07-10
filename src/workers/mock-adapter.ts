import { join } from "node:path";
import { appendText, readTextIfExists, writeJson, writeText } from "../core/file-store.js";
import type { WorkerStatus } from "../domain/schemas.js";
import type { WorkerAdapter, WorkerResult, WorkerRunSpec } from "./types.js";

export class MockWorkerAdapter implements WorkerAdapter {
  readonly name = "mock" as const;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.signal?.aborted) {
      return cancelMockWorker(spec);
    }
    const nativeSessionId = spec.nativeSession?.session_id ?? `mock-${spec.workerId}`;
    await spec.onNativeSession?.(nativeSessionId);
    await setStatus(spec, "running", "mock-running", `${spec.role} mock worker running`, nativeSessionId);
    await appendText(spec.outputLogPath, `[mock:${spec.role}] started\n`);

    if (spec.role === "judge") {
      await writeText(join(spec.filesDir, "requirements.md"), "# Requirements\n\n- Mock requirements derived from the user request.\n");
      await writeText(join(spec.filesDir, "plan.md"), "# Plan\n\n1. Run Actor.\n2. Run Critic.\n");
      await writeText(join(spec.filesDir, "acceptance.md"), "# Acceptance\n\n- Mock review approves the result.\n");
      await writeText(join(spec.filesDir, "actor-brief.md"), "# Actor Brief\n\nImplement the requested change and write a worklog.\n");
      await writeText(join(spec.filesDir, "critic-brief.md"), "# Critic Brief\n\nReview the Actor output against acceptance criteria.\n");
    }

    if (spec.role === "actor") {
      await writeText(join(spec.filesDir, "worklog.md"), "# Worklog\n\n- Mock actor completed the implementation.\n");
      await writeText(join(spec.filesDir, "patch.diff"), "diff --git a/mock b/mock\n");
      const featureDir = featureDirFromPrompt(spec.prompt);
      if (featureDir) {
        await writeText(join(featureDir, "actor-worklog.md"), "# Worklog\n\n- Mock actor completed the implementation.\n");
      }
    }

    if (spec.role === "critic") {
      await writeText(join(spec.filesDir, "review.md"), "# Review\n\nAPPROVED\n\nNo blocking findings in mock review.\n");
      const featureDir = featureDirFromPrompt(spec.prompt);
      if (featureDir) {
        const findingsPath = join(featureDir, "critic-findings.jsonl");
        if (!(await readTextIfExists(findingsPath)).trim()) {
          await writeText(findingsPath, "");
        }
      }
    }

    if (spec.role === "main") {
      await appendText(spec.outputLogPath, `Mock simple response for: ${mainRequestFromPrompt(spec.prompt)}\n`);
    }

    if (spec.signal?.aborted) {
      return cancelMockWorker(spec, nativeSessionId);
    }

    await appendText(spec.outputLogPath, `[mock:${spec.role}] done\n`);
    await setStatus(spec, "done", "mock-done", `${spec.role} mock worker done`, nativeSessionId);

    return {
      workerId: spec.workerId,
      exitCode: 0,
      signal: null
    };
  }
}

async function cancelMockWorker(spec: WorkerRunSpec, nativeSessionId?: string): Promise<WorkerResult> {
  await appendText(spec.outputLogPath, "[mock] cancelled\n");
  await setStatus(spec, "cancelled", "mock-cancelled", `${spec.role} mock worker cancelled`, nativeSessionId);
  return {
    workerId: spec.workerId,
    exitCode: 130,
    signal: "SIGTERM",
    cancelled: true
  };
}

function mainRequestFromPrompt(prompt: string): string {
  const marker = "\nUser request:\n";
  const markerIndex = prompt.indexOf(marker);
  return markerIndex >= 0 ? prompt.slice(markerIndex + marker.length).trim() : prompt.trim();
}

function featureDirFromPrompt(prompt: string): string | null {
  const line = prompt.split("\n").find((item) => item.startsWith("Feature directory: "));
  return line ? line.replace("Feature directory: ", "").trim() : null;
}

async function setStatus(
  spec: WorkerRunSpec,
  state: WorkerStatus["state"],
  phase: string,
  summary: string,
  nativeSessionId?: string
): Promise<void> {
  await writeJson(spec.statusPath, {
    worker_id: spec.workerId,
    role: spec.role,
    engine: spec.engine,
    state,
    phase,
    last_event_at: new Date().toISOString(),
    summary,
    ...(nativeSessionId ? { native_session_id: nativeSessionId } : {})
  } satisfies WorkerStatus);
}
