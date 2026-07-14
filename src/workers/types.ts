import type { EngineName, NativeSession, WorkerRole, WorkerStatus } from "../domain/schemas.js";

export interface NativeSessionRunConfig {
  enabled: boolean;
  resumeArgs: string[];
  detectSessionId: boolean;
  fallback: "fail" | "new";
}

export interface WorkerModelRunConfig {
  name: string;
  provider: string;
  args: string[];
  env?: Record<string, string>;
}

export interface WorkerRunSpec {
  workerId: string;
  featureId?: string;
  featureTitle?: string;
  role: WorkerRole;
  engine: EngineName;
  cwd: string;
  enforceWorkspaceIsolation?: boolean;
  writableDirs?: string[];
  filesDir: string;
  promptPath: string;
  outputLogPath: string;
  statusPath: string;
  prompt: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  firstOutputTimeoutMs?: number;
  signal?: AbortSignal;
  nativeSession?: NativeSession | null;
  nativeSessionConfig?: NativeSessionRunConfig;
  modelConfig?: WorkerModelRunConfig;
  onStatus?: (status: WorkerStatus) => void | Promise<void>;
  onNativeSession?: (sessionId: string) => void | Promise<void>;
  onNativeSessionRetired?: (sessionId: string, reason: string) => void | Promise<void>;
}

export interface WorkerResult {
  workerId: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  cancelled?: boolean;
  failure?: {
    phase: string;
    summary: string;
  };
}

export interface WorkerAdapter {
  readonly name: EngineName;
  run(spec: WorkerRunSpec): Promise<WorkerResult>;
}
