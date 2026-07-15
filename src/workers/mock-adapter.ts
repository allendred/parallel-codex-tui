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
      if (spec.prompt.includes("# Role:") && spec.prompt.includes("· Final acceptance")) {
        const criterionIds = promptJsonArray(spec.prompt, "Required acceptance criterion ids");
        const changedPaths = promptJsonArray(spec.prompt, "Authoritative changed paths");
        await writeJson(join(spec.filesDir, "final-acceptance.json"), {
          version: 1,
          decision: "approved",
          summary: "Mock Final Judge verified every acceptance criterion.",
          acceptance: criterionIds.map((criterionId) => ({
            criterion_id: criterionId,
            status: "passed",
            evidence: "Mock verification completed."
          })),
          changed_paths: changedPaths
        });
      } else {
        await writeText(join(spec.filesDir, "requirements.md"), "# Requirements\n\n- [R-001] Mock requirements derived from the user request.\n");
        await writeText(join(spec.filesDir, "plan.md"), "# Plan\n\n1. [P-001] Implement the scoped change.\n2. [P-002] Run focused verification.\n");
        await writeText(join(spec.filesDir, "acceptance.md"), "# Acceptance\n\n- [A-001] [R-001] Focused tests pass for the requested behavior.\n");
        await writeText(join(spec.filesDir, "actor-brief.md"), "# Actor Brief\n\nImplement the requested change and write a worklog.\n");
        await writeText(join(spec.filesDir, "critic-brief.md"), "# Critic Brief\n\nReview the Actor output against acceptance criteria.\n");
      }
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

function promptJsonArray(prompt: string, label: string): string[] {
  const line = prompt.split("\n").find((item) => item.startsWith(`${label}: `));
  if (!line) {
    return [];
  }
  try {
    const value = JSON.parse(line.slice(label.length + 2));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function setStatus(
  spec: WorkerRunSpec,
  state: WorkerStatus["state"],
  phase: string,
  summary: string,
  nativeSessionId?: string
): Promise<void> {
  const status = {
    worker_id: spec.workerId,
    ...(spec.featureId ? { feature_id: spec.featureId } : {}),
    ...(spec.featureTitle ? { feature_title: spec.featureTitle } : {}),
    role: spec.role,
    engine: spec.engine,
    ...(spec.modelConfig?.name.trim() ? { model_name: spec.modelConfig.name.trim() } : {}),
    ...(spec.modelConfig?.provider.trim() ? { model_provider: spec.modelConfig.provider.trim() } : {}),
    state,
    phase,
    last_event_at: new Date().toISOString(),
    summary,
    ...(nativeSessionId ? { native_session_id: nativeSessionId } : {})
  } satisfies WorkerStatus;
  await writeJson(spec.statusPath, status);
  notifyStatus(spec, status);
}

function notifyStatus(spec: WorkerRunSpec, status: WorkerStatus): void {
  try {
    void Promise.resolve(spec.onStatus?.(status)).catch(() => {});
  } catch {
    // Status observers cannot change the worker outcome.
  }
}
