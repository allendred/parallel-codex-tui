import { resolve } from "node:path";
import { homedir } from "node:os";
import { normalizeTuiThemeName, TUI_THEME_NAMES, type TuiThemeName } from "./tui/theme.js";
import { TaskIdSchema } from "./domain/schemas.js";

export interface CliArgs {
  appRoot: string;
  cancelRun: boolean;
  cancelRunId: string | null;
  diagnostics: boolean;
  diagnosticsPath: string | null;
  doctor: boolean;
  explicitWorkspace: string | null;
  help: boolean;
  init: boolean;
  json: boolean;
  probeAgents: boolean;
  probeRouter: boolean;
  runs: boolean;
  submit: boolean;
  submitRequest: string | null;
  idempotencyKey: string | null;
  wait: boolean;
  waitRun: boolean;
  waitRunId: string | null;
  waitTimeoutMs: number | null;
  workspaceRoot: string;
  taskId: string | null;
  theme: TuiThemeName | null;
  themes: boolean;
  version: boolean;
}

const allowedValueOptions = new Set([
  "--app-root",
  "--workspace",
  "-w",
  "--task",
  "-t",
  "--theme",
  "--diagnostics",
  "--cancel-run",
  "--submit",
  "--idempotency-key",
  "--wait-run",
  "--wait-timeout"
]);
const allowedBooleanOptions = new Set([
  "--doctor",
  "--help",
  "-h",
  "--init",
  "--json",
  "--probe-agents",
  "--probe-router",
  "--runs",
  "--wait",
  "--themes",
  "--version",
  "-v"
]);

export function parseCliArgs(args: string[], cwd: string): CliArgs {
  const optionArgs = argsBeforeTerminator(args);
  const appRootFlagIndex = lastFlagIndex(optionArgs, (arg) => arg === "--app-root" || arg.startsWith("--app-root="));
  const workspaceFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--workspace" || arg.startsWith("--workspace=") || arg === "-w" || arg.startsWith("-w=")
  );
  const taskFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--task" || arg.startsWith("--task=") || arg === "-t" || arg.startsWith("-t=")
  );
  const themeFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--theme" || arg.startsWith("--theme=")
  );
  const diagnosticsFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--diagnostics" || arg.startsWith("--diagnostics=")
  );
  const cancelRunFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--cancel-run" || arg.startsWith("--cancel-run=")
  );
  const cancelRun = cancelRunFlagIndex >= 0;
  const cancelRunId = flagValue(optionArgs, cancelRunFlagIndex);
  const submitFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--submit" || arg.startsWith("--submit=")
  );
  const idempotencyKeyFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--idempotency-key" || arg.startsWith("--idempotency-key=")
  );
  const submit = submitFlagIndex >= 0;
  const submitRequest = flagValue(optionArgs, submitFlagIndex, true);
  const idempotencyKey = flagValue(optionArgs, idempotencyKeyFlagIndex);
  const waitRunFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--wait-run" || arg.startsWith("--wait-run=")
  );
  const waitTimeoutFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--wait-timeout" || arg.startsWith("--wait-timeout=")
  );
  const waitRun = waitRunFlagIndex >= 0;
  const waitRunId = flagValue(optionArgs, waitRunFlagIndex);
  const waitTimeoutSeconds = Number(flagValue(optionArgs, waitTimeoutFlagIndex));
  const waitTimeoutMs = waitTimeoutFlagIndex >= 0 && Number.isFinite(waitTimeoutSeconds)
    ? waitTimeoutSeconds * 1000
    : null;
  const diagnostics = diagnosticsFlagIndex >= 0;
  const doctor = optionArgs.includes("--doctor");
  const help = optionArgs.includes("--help") || optionArgs.includes("-h");
  const init = optionArgs.includes("--init");
  const json = optionArgs.includes("--json");
  const probeAgents = optionArgs.includes("--probe-agents");
  const probeRouter = optionArgs.includes("--probe-router");
  const runs = optionArgs.includes("--runs");
  const wait = optionArgs.includes("--wait");
  const themes = optionArgs.includes("--themes");
  const version = optionArgs.includes("--version") || optionArgs.includes("-v");
  const appRootValue = flagValue(optionArgs, appRootFlagIndex);
  const appRoot = appRootValue ? resolvePathArg(cwd, appRootValue) : cwd;
  const explicitWorkspace = flagValue(optionArgs, workspaceFlagIndex);
  const workspaceRoot = explicitWorkspace ? resolvePathArg(cwd, explicitWorkspace) : cwd;
  const taskId = flagValue(optionArgs, taskFlagIndex);
  const theme = cliThemeValue(flagValue(optionArgs, themeFlagIndex));
  const diagnosticsValue = flagValue(optionArgs, diagnosticsFlagIndex);
  const diagnosticsPath = diagnosticsValue ? resolvePathArg(cwd, diagnosticsValue) : null;

  return {
    appRoot,
    cancelRun,
    cancelRunId,
    diagnostics,
    diagnosticsPath,
    doctor,
    explicitWorkspace,
    help,
    init,
    json,
    probeAgents,
    probeRouter,
    runs,
    submit,
    submitRequest,
    idempotencyKey,
    wait,
    waitRun,
    waitRunId,
    waitTimeoutMs,
    workspaceRoot,
    taskId,
    theme,
    themes,
    version
  };
}

function resolvePathArg(cwd: string, value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }

  return resolve(cwd, value);
}

export function validateCliArgs(args: string[]): string[] {
  const errors: string[] = [];
  const optionArgs = argsBeforeTerminator(args);
  for (const arg of optionArgs) {
    if (!arg.startsWith("-") || arg === "-") {
      continue;
    }

    if (allowedBooleanOptions.has(arg) || allowedValueOptions.has(arg)) {
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const optionName = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    if (allowedValueOptions.has(optionName)) {
      continue;
    }

    errors.push(`Unknown option: ${arg}`);
  }

  const themeFlagIndex = lastFlagIndex(optionArgs, (arg) => arg === "--theme" || arg.startsWith("--theme="));
  const rawThemeValue = flagValue(optionArgs, themeFlagIndex);
  if (rawThemeValue?.trim() && !normalizeTuiThemeName(rawThemeValue)) {
    errors.push(`Invalid --theme: ${rawThemeValue.trim()} (expected ${TUI_THEME_NAMES.join(", ")})`);
  }
  const taskFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--task" || arg.startsWith("--task=") || arg === "-t" || arg.startsWith("-t=")
  );
  const rawTaskId = flagValue(optionArgs, taskFlagIndex);
  if (rawTaskId && !TaskIdSchema.safeParse(rawTaskId).success) {
    errors.push("Invalid --task: expected task- followed by letters, numbers, dot, underscore, or hyphen");
  }
  if (optionArgs.includes("--probe-router") && !optionArgs.includes("--doctor")) {
    errors.push("--probe-router requires --doctor");
  }
  if (optionArgs.includes("--probe-agents") && !optionArgs.includes("--doctor")) {
    errors.push("--probe-agents requires --doctor");
  }
  const runs = optionArgs.includes("--runs");
  const cancelRunFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--cancel-run" || arg.startsWith("--cancel-run=")
  );
  const cancelRun = cancelRunFlagIndex >= 0;
  const cancelRunId = flagValue(optionArgs, cancelRunFlagIndex);
  const submitFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--submit" || arg.startsWith("--submit=")
  );
  const idempotencyKeyFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--idempotency-key" || arg.startsWith("--idempotency-key=")
  );
  const submit = submitFlagIndex >= 0;
  const submitRequest = flagValue(optionArgs, submitFlagIndex, true);
  const idempotencyKey = flagValue(optionArgs, idempotencyKeyFlagIndex);
  const wait = optionArgs.includes("--wait");
  const waitRunFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--wait-run" || arg.startsWith("--wait-run=")
  );
  const waitRun = waitRunFlagIndex >= 0;
  const waitRunId = flagValue(optionArgs, waitRunFlagIndex);
  const supervisorCommandCount = [runs, cancelRun, waitRun, submit].filter(Boolean).length;
  if (supervisorCommandCount > 1) {
    errors.push("Only one of --runs, --cancel-run, --wait-run, or --submit may be used");
  }
  if (optionArgs.includes("--json") && supervisorCommandCount === 0) {
    errors.push("--json requires --runs, --cancel-run, --wait-run, or --submit");
  }
  if (submit && !submitRequest) {
    errors.push("Invalid --submit: expected request text or - for piped stdin");
  }
  if (wait && !submit) {
    errors.push("--wait requires --submit");
  }
  if (idempotencyKeyFlagIndex >= 0) {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      errors.push("Invalid --idempotency-key: expected 1-128 letters, numbers, dot, underscore, colon, or hyphen");
    }
    if (!submit) {
      errors.push("--idempotency-key requires --submit");
    }
  }
  if (cancelRunId && !/^run-[A-Za-z0-9._-]+$/.test(cancelRunId)) {
    errors.push("Invalid --cancel-run: expected run- followed by letters, numbers, dot, underscore, or hyphen");
  }
  if (waitRunId && !/^run-[A-Za-z0-9._-]+$/.test(waitRunId)) {
    errors.push("Invalid --wait-run: expected run- followed by letters, numbers, dot, underscore, or hyphen");
  }
  const waitTimeoutFlagIndex = lastFlagIndex(
    optionArgs,
    (arg) => arg === "--wait-timeout" || arg.startsWith("--wait-timeout=")
  );
  if (waitTimeoutFlagIndex >= 0) {
    const rawWaitTimeout = flagValue(optionArgs, waitTimeoutFlagIndex);
    const waitTimeoutSeconds = Number(rawWaitTimeout);
    if (!rawWaitTimeout || !Number.isFinite(waitTimeoutSeconds) || waitTimeoutSeconds <= 0) {
      errors.push("Invalid --wait-timeout: expected a positive number of seconds");
    }
    if (!waitRun && !submit) {
      errors.push("--wait-timeout requires --wait-run or --submit");
    }
  }
  return errors;
}

function argsBeforeTerminator(args: string[]): string[] {
  const terminatorIndex = args.indexOf("--");
  return terminatorIndex >= 0 ? args.slice(0, terminatorIndex) : args;
}

function lastFlagIndex(args: string[], predicate: (arg: string) => boolean): number {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (predicate(args[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

function flagValue(args: string[], flagIndex: number, allowDash = false): string | null {
  const flag = flagIndex >= 0 ? args[flagIndex] : null;
  const inlineMatch = flag?.match(/^-{1,2}[^=]+=(.*)$/);
  if (inlineMatch) {
    return inlineMatch[1] || null;
  }

  const value = flagIndex >= 0 ? args[flagIndex + 1] : null;
  return value && (!value.startsWith("-") || (allowDash && value === "-")) ? value : null;
}

function cliThemeValue(value: string | null): TuiThemeName | null {
  return normalizeTuiThemeName(value);
}
