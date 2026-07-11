import type { TaskRunLease } from "./process-ownership.js";

export async function runWithLeaseFinalization<Result>(
  subject: string,
  lease: Pick<TaskRunLease, "release">,
  run: () => Promise<Result>
): Promise<Result> {
  const outcome = await run().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );

  try {
    await lease.release();
  } catch (releaseError) {
    const releaseSummary = `${subject} lease release failed: ${errorMessage(releaseError)}`;
    if (!outcome.ok) {
      throw new Error(`${errorMessage(outcome.error)}; ${releaseSummary}`, {
        cause: new AggregateError([outcome.error, releaseError])
      });
    }
    throw new Error(releaseSummary, { cause: releaseError });
  }

  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
