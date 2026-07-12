import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ensureDir, readJson, removeIfExists, writeJson } from "./file-store.js";
import { processIsAlive, readProcessStartToken } from "./process-identity.js";

const ProcessMutationIntentSchema = z.object({
  version: z.literal(1),
  intent_id: z.string().min(1),
  pid: z.number().int().positive(),
  created_at: z.string().datetime(),
  choosing: z.boolean(),
  ticket: z.number().int().nonnegative(),
  process_start_token: z.string().min(1).optional()
});

type ProcessMutationIntent = z.infer<typeof ProcessMutationIntentSchema>;

export interface AcquireProcessMutationTurnOptions {
  intentPrefix: string;
  timeoutMessage: string;
  timeoutMs?: number;
  pollMs?: number;
}

export interface ProcessMutationTurn {
  release(): Promise<void>;
}

let currentProcessStartToken: Promise<string | null> | null = null;

export async function acquireProcessMutationTurn(
  directory: string,
  options: AcquireProcessMutationTurnOptions
): Promise<ProcessMutationTurn> {
  validateIntentPrefix(options.intentPrefix);
  await ensureDir(directory);
  const identity = await currentMutationIdentity();
  const intentId = randomUUID();
  const path = join(directory, `${options.intentPrefix}${intentId}.json`);
  let intent: ProcessMutationIntent = ProcessMutationIntentSchema.parse({
    version: 1,
    intent_id: intentId,
    pid: identity.pid,
    created_at: new Date().toISOString(),
    choosing: true,
    ticket: 0,
    ...(identity.process_start_token ? { process_start_token: identity.process_start_token } : {})
  });
  await writeJson(path, intent);

  try {
    const existing = await readActiveIntents(directory, options.intentPrefix);
    intent = {
      ...intent,
      choosing: false,
      ticket: Math.max(0, ...existing.map((candidate) => candidate.ticket)) + 1
    };
    await writeJson(path, intent);

    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    while (true) {
      const candidates = await readActiveIntents(directory, options.intentPrefix);
      const blocked = candidates.some((candidate) => (
        candidate.intent_id !== intent.intent_id
        && (candidate.choosing || intentPrecedes(candidate, intent))
      ));
      if (!blocked) {
        let released = false;
        return {
          release: async () => {
            if (released) {
              return;
            }
            released = true;
            await removeIfExists(path);
          }
        };
      }
      if (Date.now() >= deadline) {
        throw new Error(options.timeoutMessage);
      }
      await delay(options.pollMs ?? 5);
    }
  } catch (error) {
    await removeIfExists(path);
    throw error;
  }
}

async function currentMutationIdentity(): Promise<Pick<ProcessMutationIntent, "pid" | "process_start_token">> {
  currentProcessStartToken ??= readProcessStartToken(process.pid);
  const processStartToken = await currentProcessStartToken;
  return {
    pid: process.pid,
    ...(processStartToken ? { process_start_token: processStartToken } : {})
  };
}

async function readActiveIntents(directory: string, prefix: string): Promise<ProcessMutationIntent[]> {
  const names = await readdir(directory);
  const tokenReads = new Map<number, Promise<string | null>>();
  const active: ProcessMutationIntent[] = [];

  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) {
      continue;
    }
    const path = join(directory, name);
    const intent = await readValidIntent(path);
    if (!intent || !processIsAlive(intent.pid)) {
      await removeIfExists(path);
      continue;
    }
    if (intent.process_start_token) {
      let tokenRead = tokenReads.get(intent.pid);
      if (!tokenRead) {
        tokenRead = readProcessStartToken(intent.pid);
        tokenReads.set(intent.pid, tokenRead);
      }
      const currentToken = await tokenRead;
      if (!currentToken || currentToken !== intent.process_start_token) {
        await removeIfExists(path);
        continue;
      }
    }
    active.push(intent);
  }

  return active;
}

async function readValidIntent(path: string): Promise<ProcessMutationIntent | null> {
  try {
    return await readJson(path, ProcessMutationIntentSchema);
  } catch {
    return null;
  }
}

function intentPrecedes(candidate: ProcessMutationIntent, current: ProcessMutationIntent): boolean {
  if (candidate.ticket !== current.ticket) {
    return candidate.ticket < current.ticket;
  }
  return candidate.intent_id < current.intent_id;
}

function validateIntentPrefix(prefix: string): void {
  if (!prefix.startsWith(".") || prefix.includes("/") || prefix.includes("\\")) {
    throw new Error(`Invalid process mutation intent prefix: ${prefix}`);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
