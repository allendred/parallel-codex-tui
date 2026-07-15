import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TUI_THEME_FIELDS, TUI_THEME_PRESETS } from "../src/tui/theme.js";

const execFileAsync = promisify(execFile);

interface PackageJson {
  allowScripts?: Record<string, boolean>;
  bin: Record<string, string>;
  bugs?: {
    url?: string;
  };
  description?: string;
  engines?: Record<string, string>;
  files?: string[];
  homepage?: string;
  keywords?: string[];
  license?: string;
  private?: boolean;
  publishConfig?: {
    access?: string;
    registry?: string;
  };
  dependencies?: Record<string, string>;
  repository?: {
    type?: string;
    url?: string;
  };
  scripts?: Record<string, string>;
}

interface PackFile {
  mode?: number;
  path: string;
}

interface PackMetadata {
  files: PackFile[];
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

function parsePackJson(output: string): PackMetadata[] {
  const jsonStart = output.indexOf("[");

  if (jsonStart < 0) {
    throw new Error(`npm pack did not emit JSON: ${output}`);
  }

  return JSON.parse(output.slice(jsonStart)) as PackMetadata[];
}

describe("package metadata", () => {
  it("points the executable bin at dist/cli.js", async () => {
    const pkg = await readPackageJson();

    expect(pkg.bin["parallel-codex-tui"]).toBe("dist/cli.js");
  });

  it("declares public open-source package metadata", async () => {
    const pkg = await readPackageJson();

    expect(pkg.private).not.toBe(true);
    expect(pkg.license).toBe("MIT");
    expect(pkg.description).toContain("parallel coding");
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/allendred/parallel-codex-tui.git"
    });
    expect(pkg.bugs?.url).toBe("https://github.com/allendred/parallel-codex-tui/issues");
    expect(pkg.homepage).toBe("https://github.com/allendred/parallel-codex-tui#readme");
    expect(pkg.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/"
    });
    expect(pkg.engines?.node).toBe(">=24.15.0");
    expect(pkg.keywords).toEqual([
      "codex",
      "claude",
      "tui",
      "parallel-coding",
      "agent-orchestration"
    ]);
    expect(pkg.files).toEqual([
      "dist/",
      "README.md",
      "LICENSE",
      ".parallel-codex/config.example.toml"
    ]);
    expect(pkg.dependencies?.chalk).toBe("^5.3.0");
    expect(pkg.allowScripts).toEqual({
      "esbuild@0.28.1": true,
      "fsevents@2.3.3": true,
      "node-pty@1.1.0": true
    });
    expect(pkg.scripts?.pretest).toBe("node scripts/fix-node-pty-permissions.mjs");
    expect(pkg.scripts?.prepack).toBe("npm run build");
    expect(pkg.scripts?.["verify:package"]).toBe("node scripts/verify-package.mjs");
    expect(pkg.scripts?.prepare).toBeUndefined();
  });

  it("ships an MIT license file", async () => {
    const license = await readFile(join(process.cwd(), "LICENSE"), "utf8");

    expect(license).toContain("MIT License");
    expect(license).toContain("parallel-codex-tui contributors");
  });

  it("keeps local runtime state and private config out of the public repo", async () => {
    const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");

    expect(gitignore).toContain(".parallel-codex/config.toml");
    expect(gitignore).toContain(".parallel-codex/last-workspace");
    expect(gitignore).toContain(".parallel-codex/sessions/");
    expect(gitignore).toContain(".parallel-codex/exports/");
    expect(gitignore).toContain(".parallel-codex/workspaces.json");
    expect(gitignore).toContain(".parallel-codex/router/");
    expect(gitignore).toContain("docs/superpowers/");
  });

  it("does not track local config or internal planning artifacts", async () => {
    const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: process.cwd() });
    const trackedFiles = stdout.split("\n").filter(Boolean);

    expect(trackedFiles).not.toContain(".parallel-codex/config.toml");
    expect(trackedFiles.some((file) => file.startsWith("docs/superpowers/"))).toBe(false);
  });

  it("provides a safe example config instead of publishing local permissions", async () => {
    const example = await readFile(join(process.cwd(), ".parallel-codex", "config.example.toml"), "utf8");

    expect(example).toContain("[router]");
    expect(example).toContain("[workers.mock]");
    expect(example).toContain("# [workers.codex.model]");
    expect(example).toContain('# provider = "openai"');
    expect(example).toContain("# [workers.claude.model]");
    expect(example).toContain('# provider = "anthropic"');
    expect(example).toContain("# [workers.openai_compat]");
    expect(example).toContain('# extends = "codex"');
    expect(example).toContain("# [workers.anthropic_compat]");
    expect(example).toContain('# extends = "claude"');
    expect(example).toContain("# [workers.vendor]");
    expect(example).toContain('# extends = "generic"');
    expect(example).toContain('forkArgs = ["fork", "{sessionId}"]');
    expect(example).toContain('forkArgs = ["--resume", "{sessionId}", "--fork-session"]');
    for (const field of TUI_THEME_FIELDS) {
      expect(example).toContain(`# ${field} = `);
    }
    expect(example).toContain(`# chrome = "${TUI_THEME_PRESETS.codex.chrome}"`);
    expect(example).toContain(`# surface = "${TUI_THEME_PRESETS.codex.surface}"`);
    expect(example).toContain(`# rail = "${TUI_THEME_PRESETS.codex.rail}"`);
    expect(example).toContain(`# text = "${TUI_THEME_PRESETS.codex.text}"`);
    expect(example).toContain(`# muted = "${TUI_THEME_PRESETS.codex.muted}"`);
    expect(example).toContain(`# accent = "${TUI_THEME_PRESETS.codex.accent}"`);
    expect(example).toContain(`# warning = "${TUI_THEME_PRESETS.codex.warning}"`);
    expect(example).toContain(`# success = "${TUI_THEME_PRESETS.codex.success}"`);
    expect(example).toContain(`# danger = "${TUI_THEME_PRESETS.codex.danger}"`);
    expect(example).not.toContain("danger-full-access");
    expect(example).not.toContain("bypassPermissions");
  });

  it("documents public installation, requirements, and local data boundaries", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("## Requirements");
    expect(readme).toContain("Node.js 24.15+");
    expect(readme).toContain("Codex CLI");
    expect(readme).toContain("Claude CLI");
    expect(readme).toContain("## Install");
    expect(readme).toContain("npm install -g parallel-codex-tui");
    expect(readme).toContain("parallel-codex-tui --init");
    expect(readme).toContain("parallel-codex-tui --doctor");
    expect(readme).toContain("parallel-codex-tui --workspace /path/to/project");
    expect(readme).toContain("parallel-codex-tui --theme aurora --workspace /path/to/project");
    expect(readme).toContain("parallel-codex-tui --theme studio --workspace /path/to/project");
    expect(readme).toContain("--workspace=/path/to/project");
    expect(readme).toContain("--theme=paper");
    expect(readme).toContain("-w=/path/to/project");
    expect(readme).toContain("shows remembered projects from `.parallel-codex/workspaces.json`");
    expect(readme).toContain("If `--workspace <path>` points to an existing file");
    expect(readme).toContain("will not use that file path as the default folder to create");
    expect(readme).toContain("runs a quota-free startup preflight before the TUI accepts work");
    expect(readme).toContain("workspace read/write/search access");
    expect(readme).toContain("Healthy checks stay quiet; warnings and failures appear in chat");
    expect(readme).toContain("press `Ctrl+P` to open the same project picker without exiting");
    expect(readme).toContain("`Esc` returns with the unsent draft intact");
    expect(readme).toContain("locks duplicate picker input, shows the project being opened, rebuilds the runtime in place");
    expect(readme).toContain("A failed open returns to the original view without replacing its runtime or draft");
    expect(readme).toContain("Router configuration and `router/routes.jsonl` remain shared under the app root");
    expect(readme).toContain("press `Ctrl+G` to open the global Router diagnostics view");
    expect(readme).toContain("`Tab` toggles between all workspaces and the current workspace");
    expect(readme).toContain("all three watchdog limits, retry attempt limit/backoff, the triggered `first-output`/`idle`/`total` timeout kind");
    expect(readme).toContain("Successful Codex latency excludes fallback wait time");
    expect(readme).toContain("marks each timeout budget as healthy, tight, or high");
    expect(readme).toContain("at least three successful samples");
    expect(readme).toContain("Proxy context is correlation evidence, not proof that the proxy caused a failure");
    expect(readme).toContain("source, duration, fallback cause, scope, and workspace");
    expect(readme).toContain("health row separates recovered automatic retries from terminal fallbacks");
    expect(readme).toContain("`Ctrl+G` refreshes it and `Esc` returns with the chat draft intact");
    expect(readme).toContain("Router classification only receives the user request");
    expect(readme).toContain("Valid `[router]` changes are reloaded before the next classification without restarting the TUI");
    expect(readme).toContain("Worker, pairing, role, orchestration, data-directory, and UI changes still require a restart");
    expect(readme).toContain("While classification is running, it follows the real subprocess");
    expect(readme).toContain("Completed complex tasks open as a structured result at the top of the chat viewport");
    expect(readme).toContain("authoritative integrated changed paths, Critic review, verification evidence, and findings");
    expect(readme).toContain("Changed files come from the workspace integration result rather than an Actor claim");
    expect(readme).toContain("Multi-feature delivery uses the same result protocol");
    expect(readme).toContain("Concurrent text and JSONL appends inside one TUI are serialized per resolved file path");
    expect(readme).toContain("one failed append does not poison later writes");
    expect(readme).toContain("Feature revision mailboxes are a checked protocol rather than prompt-only convention");
    expect(readme).toContain("Missing, malformed, unacknowledged, or contradictory findings stop the task before live integration");
    expect(readme).toContain("snapshots pending, inconsistent, and approved fixed/open state in `finding-resolution.json`");
    expect(readme).toContain("uses resolution evidence instead of counting every reply as a fix");
    expect(readme).toContain("shows verified `fixed`/`open` counts when resolution evidence exists");
    expect(readme).toContain("`Ctrl+D` toggles the focused result between full detail and its five-line compact summary");
    expect(readme).toContain("Result lookup follows the persisted task id");
    expect(readme).toContain("Restarting an existing task restores the latest persisted route evidence");
    expect(readme).toContain("`.parallel-codex/sessions/main/chat.jsonl`");
    expect(readme).toContain("startup restores the latest 200 valid messages");
    expect(readme).toContain("Chat drafts support Unicode-safe Left/Right, Home/End, Backspace, and Delete editing");
    expect(readme).toContain("Up/Down recalls persisted user requests and returns to the exact unsent draft");
    expect(readme).toContain("Bracketed multiline paste stays in one draft");
    expect(readme).toContain('`--doctor` checks configured automated and interactive commands, `{env:NAME}` references');
    expect(readme).toContain("CLI help surfaces required for Codex exec/resume sandboxing and Claude print/resume permissions");
    expect(readme).toContain("an explicit `generic` capability contract is validated without guessing vendor-specific help");
    expect(readme).toContain("every named Worker Provider used by the active route");
    expect(readme).toContain("[workers.openai_compat]");
    expect(readme).toContain("[workers.anthropic_compat]");
    expect(readme).toContain('extends = "generic"');
    expect(readme).toContain("Every new Worker status records the actual profile ID plus its rendered model/provider snapshot");
    expect(readme).toContain("parallel-codex-tui --doctor --probe-agents");
    expect(readme).toContain("one minimal fresh request and, when configured, one same-session resume request");
    expect(readme).toContain("This explicit probe uses model quota");
    expect(readme).toContain("preserves failed artifacts under `.parallel-codex/probes/`");
    expect(readme).toContain("Claude-compatible profiles default to a generated native `--session-id`");
    expect(readme).toContain("a silent failed launch cannot create a false resumable session");
    expect(readme).toContain("proxy host/port reachability as a local-endpoint check");
    expect(readme).toContain("parallel-codex-tui --doctor --probe-router");
    expect(readme).toContain("one real classification through the configured Codex Router");
    expect(readme).toContain("spawn time, first-output time, process duration, stdout/stderr byte counts, and failure stage");
    expect(readme).toContain("dispatch, spawn, first output, process, parse, and total stages");
    expect(readme).toContain("I/O byte evidence on a separate line");
    expect(readme).toContain("a bounded diagnosis and a concrete next action");
    expect(readme).toContain("configured proxy remains context rather than a proven cause");
    expect(readme).toContain("`first output timeout`, `idle timeout after stdout/stderr`, or `total timeout`");
    expect(readme).toContain("`via <proxy-host:port>` remains context, not a claim that the proxy caused the failure");
    expect(readme).toContain("`starting`, `waiting output`, `diagnostics`, `receiving`, `parsing`, and `stopping`");
    expect(readme).toContain("normalized proxy source/variable, sanitized proxy host:port");
    expect(readme).toContain("sanitized Router executable name");
    expect(readme).toContain("reads JSONL backward in bounded chunks");
    expect(readme).toContain("first-output deadline and total ceiling");
    expect(readme).toContain("`routed` only after the turn and route files are durable");
    expect(readme).toContain("`ready_for_pair` only after Judge artifacts validate");
    expect(readme).toContain("invalid phase skips are rejected");
    expect(readme).toContain("writes every Turn into a hidden staging directory");
    expect(readme).toContain("complete pending Turns are published and request-only pending Turns are rebuilt");
    expect(readme).toContain("Task creation writes its complete first Turn into a hidden staging directory");
    expect(readme).toContain("an exclusive process-identity claim reserves the Task id");
    expect(readme).toContain("atomically publishes the whole Task");
    expect(readme).toContain("hands the creation claim directly to the task run lease");
    expect(readme).toContain("stale complete Task staging is published");
    expect(readme).toContain("incomplete staging is archived under `.abandoned`");
    expect(readme).toContain("Cancellation is rechecked after routing and after acquiring a task lease");
    expect(readme).toContain("cannot create a Task, initialize Main, append a Turn, or record a retry");
    expect(readme).toContain("Live workspace integration is the cancellation commit point");
    expect(readme).toContain("Cancellation immediately before commit leaves the live project untouched");
    expect(readme).toContain("task evidence finishes as `done` even if cancellation arrives after that commit");
    expect(readme).toContain("writes `integration.pending.json` as a durable two-phase commit intent");
    expect(readme).toContain("each live path must still match either the Wave baseline or integration snapshot");
    expect(readme).toContain("partial apply resumes without rerunning completed Workers");
    expect(readme).toContain("Any third-state content or extra live path blocks recovery");
    expect(readme).toContain("`commit_id` scopes deterministic replacement temp files");
    expect(readme).toContain("New intents use `atomic-claim-v1`");
    expect(readme).toContain("atomically moved to a commit-scoped `.backup`");
    expect(readme).toContain("File and symlink publication refuses to replace a path that reappears");
    expect(readme).toContain("Legacy temp-only intents remain recoverable");
    expect(readme).toContain("content and mode exactly match the integration snapshot");
    expect(readme).toContain("A foreign or mismatched temp file blocks recovery");
    expect(readme).toContain("intent cleanup is best-effort and cannot downgrade the committed task");
    expect(readme).toContain("Startup removes a leftover intent only when the final integrated checkpoint matches it");
    expect(readme).toContain("mismatched or unreadable evidence remains on disk");
    expect(readme).toContain("SQLite startup rebuild indexes only complete numbered Turn directories");
    expect(readme).toContain("startup notice distinguishes a restored follow-up Turn");
    expect(readme).toContain("request and route kept");
    expect(readme).toContain("`firstOutputTimeoutMs` stops a silent process");
    expect(readme).toContain("`idleTimeoutMs` resets after every stdout or stderr chunk");
    expect(readme).toContain("The 15-second first-output and idle defaults stay below the 30-second total ceiling");
    expect(readme).toContain("Two repeated silent starts settle in about 30.5 seconds");
    expect(readme).toContain("A retry, fallback choice, or completed cancellation is not exposed until that command tree is confirmed stopped");
    expect(readme).toContain("If termination cannot be verified after `SIGKILL`, the request fails closed");
    expect(readme).toContain("`maxAttempts = 2` retries one transient classification failure after `retryDelayMs = 500`");
    expect(readme).toContain("First-output and idle watchdogs plus explicit network/proxy failures are retryable");
    expect(readme).toContain("router_fallback_resolution = \"auto-retry\"");
    expect(readme).toContain("the triggered `first-output`/`idle`/`total` timeout kind");
    expect(readme).toContain("The classifier receives the original user request, while `routes.jsonl` stores a sanitized diagnostic copy");
    expect(readme).toContain("authorization values, secret assignments, and common provider tokens are removed before display or audit persistence");
    expect(readme).toContain("legacy records are sanitized again when read");
    expect(readme).toContain("When semantic routing falls back inside the TUI, execution pauses");
    expect(readme).toContain("`1` selects Main, `2` selects Parallel, `R` retries Codex routing, and `Esc` cancels");
    expect(readme).toContain("`router_attempt` and `router_fallback_resolution`");
    expect(readme).toContain("Active-task follow-ups use the same fallback choice");
    expect(readme).toContain("Follow-up Router classification has no task-side effects");
    expect(readme).toContain("a complex turn or simple question refreshes `sessions/<task>/latest-route.json` only after acquiring the task lease");
    expect(readme).toContain("A conflicting TUI leaves the previous committed route and turn files untouched");
    expect(readme).toContain("reports the loaded TUI theme, core palette values, ANSI swatch previews, and color override values");
    expect(readme).toContain("including any temporary `--theme` override");
    expect(readme).toContain('OPENAI_API_KEY = "{env:OPENAI_API_KEY}"');
    expect(readme).toContain("In chat, scroll long conversation history with the mouse wheel or PageUp/PageDown");
    expect(readme).toContain("sending a new message returns to the latest reply");
    expect(readme).toContain("Press `Ctrl+N` to preserve the current session and start a new task");
    expect(readme).toContain("the next complex request creates an independent task from turn `0001`");
    expect(readme).toContain("`Ctrl+W` to open worker logs");
    expect(readme).toContain("`Ctrl+B` opens a live Worker overview without replacing the `Ctrl+W` log shortcut");
    expect(readme).toContain("The selected active worker gets a live activity line");
    expect(readme).toContain("first-output deadline while starting and its idle deadline after output begins");
    expect(readme).toContain("warning for the final 20% and danger once overdue");
    expect(readme).toContain("press `F` to open the file-backed Feature board");
    expect(readme).toContain("blocked dependencies and open Critic findings");
    expect(readme).toContain("Enter opens the selected feature's collaboration timeline");
    expect(readme).toContain("`Esc` returns to the Feature board");
    expect(readme).toContain("press `P` twice to pause only its active Actor or Critic process");
    expect(readme).toContain("press `X` twice to cancel it");
    expect(readme).toContain("press `Ctrl+R` to resume the same task, turn, and native Worker session");
    expect(readme).toContain("already-running peers finish, queued workers stop, and integration remains blocked");
    expect(readme).toContain("Queued Feature workers remain `queued` until they acquire a concurrency slot");
    expect(readme).toContain("`actor_done` or `critic_done`");
    expect(readme).toContain("only `actor_running` and `critic_running` expose Feature cancellation");
    expect(readme).toContain("`Ctrl+R` retries the cancelled task with persisted worker sessions");
    expect(readme).toContain("an unchanged in-progress wave reuses successful Actor and Critic checkpoints");
    expect(readme).toContain("the stale wave checkpoint is rejected and rebuilt from the current project");
    expect(readme).toContain("The shared Main chat holds its own `sessions/main/run-owner.json` lease");
    expect(readme).toContain("a successful run cannot report success until its lease is released");
    expect(readme).toContain("If both the run and lease release fail");
    expect(readme).toContain("`AggregateError`");
    expect(readme).toContain("They hold the active task lease while committing the route, taking that context snapshot, and running Main");
    expect(readme).toContain("A failed or cancelled Main answer replaces the transient `running` state with its real terminal state");
    expect(readme).toContain("releases both task and Main leases, so the next question can proceed");
    expect(readme).toContain("A second TUI is rejected before it can clear or overwrite the active Main prompt, log, status, or native session");
    expect(readme).toContain("startup native-session reconciliation skips a Main session owned by another live TUI");
    expect(readme).toContain("startup atomically claims the stale Main lease");
    expect(readme).toContain("marks active Main Workers `cancelled`, preserves native session ids, and records recovery");
    expect(readme).toContain("An unverifiable or still-running Main process blocks startup");
    expect(readme).toContain("Every complex run holds a task-owned `run-owner.json` lease");
    expect(readme).toContain("Stale or corrupt lease replacement is serialized through file-backed claim intents");
    expect(readme).toContain("exactly one recovery owner can proceed");
    expect(readme).toContain("A retry revalidates the task state and reloads its latest turn, request, and route only after acquiring that lease");
    expect(readme).toContain("an older caller cannot rerun a task another TUI already completed");
    expect(readme).toContain("Recovery atomically claims the same task lease");
    expect(readme).toContain("concurrent TUI startups cannot recover one task twice or race a new retry");
    expect(readme).toContain("persist `process.json` with their PID and OS process-start fingerprint");
    expect(readme).toContain("the role prompt is sent only after that ownership evidence is durable");
    expect(readme).toContain("the process group is terminated before it receives the prompt");
    expect(readme).toContain("Worker cleanup is shown as `running/process-stopping`");
    expect(readme).toContain("normal parent exit also terminates any remaining descendants");
    expect(readme).toContain("`process-cleanup-error` and keeps `process.json`");
    expect(readme).toContain("A `process-cleanup-error` or `process-ownership-error` always blocks native-session fallback");
    expect(readme).toContain("Final log, status, native-session callback, or ownership-removal failures settle exactly once");
    expect(readme).toContain("best-effort `process-finalization-error` status");
    expect(readme).toContain("Task failure convergence attempts every Feature status and the task status independently");
    expect(readme).toContain("surfaced alongside the original Worker error");
    expect(readme).toContain("a missing or invalid Feature status is rebuilt independently");
    expect(readme).toContain("`feature.status_recovered`");
    expect(readme).toContain("Actor worklog, replies, or Critic findings");
    expect(readme).toContain("A reused PID with a different start fingerprint is never signalled");
    expect(readme).toContain("A detached leader PID reused after exit is never treated as its former process group");
    expect(readme).toContain("Every new Router fallback persists an authoritative `router_failure_kind`");
    expect(readme).toContain("chat temporarily inserts a themed route rail with `route · <mode> · <source>`");
    expect(readme).toContain("CLI `--task` input, persisted metadata, startup scanning, and SQLite rebuilding reject path separators");
    expect(readme).toContain("shows `unknown failure` instead of omitting the cause");
    expect(readme).toContain("Recovery commits cancellation only after every recorded process group is confirmed stopped");
    expect(readme).toContain("An unverifiable or still-running process blocks startup");
    expect(readme).toContain("A matching `native-session.retired.json` tombstone always wins over a leftover active session file");
    expect(readme).toContain("Every numbered turn keeps its own immutable Judge, Actor, and Critic worker directories");
    expect(readme).toContain("cycles them in turn order, and restores the same order after restart");
    expect(readme).toContain("number of distinct native sessions after deduplicating reused `engine + session_id` bindings");
    expect(readme).toContain("A valid retirement tombstone is also a cross-turn inheritance barrier");
    expect(readme).toContain("startup reconciles the active file, Worker status, and both SQLite projections before the first TUI frame");
    expect(readme).toContain("Session index rebuilding publishes either the previous complete snapshot or the new complete snapshot");
    expect(readme).toContain("Terminal completion is evidence-guarded");
    expect(readme).toContain("duplicate task and feature state writes are idempotent");
    expect(readme).toContain("every real task transition records its `from` and `to` state");
    expect(readme).toContain("Each committed task state change carries a unique transition marker in `meta.json`");
    expect(readme).toContain("startup repairs a missing event or SQLite projection from that marker");
    expect(readme).toContain("a complete `done` task cannot regress unless a new follow-up turn has first been created");
    expect(readme).toContain("Startup also audits legacy `done` tasks");
    expect(readme).toContain("have an integrated latest-turn checkpoint");
    expect(readme).toContain("rebuilds final evidence without rerunning completed workers");
    expect(readme).toContain("Legacy log-only `done` sessions without integration proof remain untouched");
    expect(readme).toContain("`checkpoints kept · Ctrl+R resume`");
    expect(readme).toContain("Checkpoint load, reuse, and recovery events appear in the collaboration timeline");
    expect(readme).toContain("press `C` to open the file-backed Actor/Critic collaboration timeline");
    expect(readme).toContain("`dialogue/actor-critic.jsonl`, feature status, Critic findings, Actor replies, finding resolution, and Wave events");
    expect(readme).toContain("`Tab` cycles all features and each individual feature");
    expect(readme).toContain("Up/Down selects a collaboration event");
    expect(readme).toContain("`Enter` opens its complete event detail");
    expect(readme).toContain("`U` filters to unresolved feature evidence");
    expect(readme).toContain("artifact paths from dialogue, status, Critic findings, Actor replies, and finding resolution");
    expect(readme).toContain("`R` refreshes immediately");
    expect(readme).toContain("Up/Down, PageUp/PageDown, the mouse wheel, or `Tab` changes the selected worker");
    expect(readme).toContain("Enter or `Ctrl+W` opens its rendered log");
    expect(readme).toContain("`Ctrl+T` opens the workspace's persisted Task sessions");
    expect(readme).toContain("turn and worker counts, plus the number of distinct native sessions");
    expect(readme).toContain("`I` to inspect the complete session hierarchy");
    expect(readme).toContain("`Project -> Task -> Turn -> Worker -> Native session`");
    expect(readme).toContain("Historical Workers from earlier turns remain selectable after same-task follow-ups");
    expect(readme).toContain("`C` or `Ctrl+O` to continue the original native session");
    expect(readme).toContain("`B` to ask the native CLI to fork it");
    expect(readme).toContain("The child fork is owned and persisted by the native CLI");
    expect(readme).toContain("The selected active task is stored in `session-index.sqlite`");
    expect(readme).toContain("Restoring a task reloads its route, workers, retry state, and recorded native session ids");
    expect(readme).toContain("`R` to rename with Unicode-safe cursor editing");
    expect(readme).toContain("`A` to archive or unarchive");
    expect(readme).toContain("`D` twice to confirm deletion");
    expect(readme).toContain("`E` to export");
    expect(readme).toContain("`H` to show or hide archived sessions");
    expect(readme).toContain("Archived sessions are hidden by default");
    expect(readme).toContain("Exports are complete file-backed snapshots under `.parallel-codex/exports/<task>-<timestamp>/`");
    expect(readme).toContain("SQLite schema changes run as ordered, transactional migrations");
    expect(readme).toContain("an integrity failure restores that backup or rebuilds the catalog from authoritative task files");
    expect(readme).toContain("`Ctrl+N` persists an intentionally empty active-task context");
    expect(readme).toContain("`Ctrl+F` searches the final rendered Worker log");
    expect(readme).toContain("Enter moves to the next match and Up/Down moves backward or forward");
    expect(readme).toContain("The current match is marked with `>` without shifting Diff or source line-number columns");
    expect(readme).toContain("press `E` to cycle rendered error lines or `D` to cycle Diff files and hunks");
    expect(readme).toContain("In worker-log views, scroll with the mouse wheel or PageUp/PageDown");
    expect(readme).toContain("In chat or worker-log views, press `Ctrl+O`");
    expect(readme).toContain("Native attach follows outer terminal resize");
    expect(readme).toContain("recognizes read-only sandbox/add-dir conflicts, untrusted directories");
    expect(readme).toContain("Overlapping attach preparations keep only the latest request");
    expect(readme).toContain("this and closing the outer App terminate the active PTY");
    expect(readme).toContain("An attach preparation that finishes after App shutdown is discarded");
    expect(readme).toContain("An operating-system SIGINT first asks the App to abort its Router or Worker and clean up any PTY");
    expect(readme).toContain("a second SIGINT restores terminal modes and forces exit");
    expect(readme).toContain("Press `Ctrl+]` to return to worker logs");
    expect(readme).not.toContain("Press `Ctrl+]` to detach and return to worker logs");
    expect(readme).toContain("parallel-codex-tui --help");
    expect(readme).toContain("parallel-codex-tui --version");
    expect(readme).toContain("## Theme");
    expect(readme).toContain('theme = "codex"');
    expect(readme).toContain("showStatusBar = false");
    expect(readme).toContain("autoOpenFailedWorker = false");
    expect(readme).toContain("successSurface");
    expect(readme).toContain("Color values are validated during config load");
    expect(readme).toContain("ansi256(0..255)");
    expect(readme).toContain("Unknown UI and color keys are rejected so typos fail fast");
    expect(readme).toContain("parallel-codex-tui --theme graphite --doctor");
    expect(readme).toContain("parallel-codex-tui --theme studio --doctor");
    expect(readme).toContain("parallel-codex-tui --themes");
    expect(readme).toContain("parallel-codex-tui --theme paper --themes");
    expect(readme).toContain("complete palette groups for every built-in theme");
    expect(readme).toContain("The doctor output includes `preview:` and `semantic:` ANSI swatch rows");
    expect(readme).toContain(".parallel-codex/config.toml");
    expect(readme).toContain(".parallel-codex/last-workspace");
    expect(readme).toContain(".parallel-codex/workspaces.json");
    expect(readme).toContain(".parallel-codex/sessions/");
    expect(readme).toContain("## Release");
    expect(readme).toContain("GitHub Actions runs CI on Ubuntu with Node.js 24.15 and 26, plus macOS with Node.js 26");
    expect(readme).toContain("installs that tarball into a clean global prefix");
    expect(readme).toContain("npm Trusted Publishing with GitHub OIDC");
    expect(readme).toContain("In npm, configure Trusted Publishing");
    expect(readme).toContain('workflow filename `release.yml`');
    expect(readme).toContain("Do not configure `NPM_TOKEN` for the release workflow");
    expect(readme).toContain("npm `^11.5.1`");
    expect(readme).toContain("npm install -g npm@^11.15.0");
    expect(readme).toContain(
      "npm trust github parallel-codex-tui --repo allendred/parallel-codex-tui --file release.yml --allow-publish --dry-run",
    );
    expect(readme).toContain(
      "npm trust github parallel-codex-tui --repo allendred/parallel-codex-tui --file release.yml --allow-publish --yes",
    );
    expect(readme).toContain("may require npm two-factor authentication");
    expect(readme).toContain("allowed action `npm publish`");
    expect(readme).toContain("npm returns `ENEEDAUTH` or `E401`");
    expect(readme).toContain("fix the npm Trusted Publishing package settings rather than adding a token fallback");
    expect(readme).toContain("git tag v0.1.4");
    expect(readme).toContain("git push origin v0.1.4");
    expect(readme).toContain("The release tag must match `package.json`");
  });

  it("publishes the CLI bin as an executable file", async () => {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { cwd: process.cwd() });
    const [pack] = parsePackJson(stdout);
    const cliFile = pack.files.find((file) => file.path === "dist/cli.js");

    expect(cliFile?.mode).toBe(0o755);
  }, 30000);

  it("runs CI checks on GitHub Actions", async () => {
    const workflow = await readFile(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");

    expect(workflow).toContain("name: CI");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain("runs-on: ${{ matrix.os }}");
    expect(workflow).toContain("os: ubuntu-latest");
    expect(workflow).toContain("os: macos-latest");
    expect(workflow).toContain('node-version: "24.15.x"');
    expect(workflow).toContain('node-version: "26.x"');
    expect(workflow).toContain("node-version: ${{ matrix.node-version }}");
    expect(workflow).toContain('test-args: "--maxWorkers=1"');
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm run verify:package");
    expect(workflow).toContain("npm test -- ${{ matrix.test-args }}");
    expect(workflow).not.toContain("Test macOS PTY layout");
    expect(workflow).toContain('CI: "0"');
    expect(workflow).toContain("git diff --check");
  });

  it("publishes tagged releases through GitHub Actions", async () => {
    const workflow = await readFile(join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");

    expect(workflow).toContain("name: Release");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("tags:");
    expect(workflow).toContain("- \"v*\"");
    expect(workflow).toContain("group: release-${{ github.event_name == 'workflow_dispatch' && inputs.version || github.ref_name }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("ref: ${{ github.event_name == 'workflow_dispatch' && inputs.version || github.ref }}");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("actions/checkout@v6");
    expect(workflow).toContain("actions/setup-node@v6");
    expect(workflow).toContain('node-version: "26.x"');
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain("npm install -g npm@^11.5.1");
    expect(workflow).toContain("npm --version");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain('CI: "0"');
    expect(workflow).toContain("npm pack --json");
    expect(workflow).toContain("id: pack");
    expect(workflow).toContain("tarball=$TARBALL");
    expect(workflow).toContain('PACKAGE_VERSION=$(node -p "require(\'./package.json\').version")');
    expect(workflow).toContain('if [ "v$PACKAGE_VERSION" != "$RELEASE_VERSION" ]; then');
    expect(workflow).toContain("npm view \"parallel-codex-tui@$PACKAGE_VERSION\" version --json");
    expect(workflow).toContain('published=$PUBLISHED');
    expect(workflow).toContain("if: steps.npm.outputs.published != 'true'");
    expect(workflow).toContain('PACKAGE_TARBALL="${{ steps.pack.outputs.tarball }}"');
    expect(workflow).toContain('npm publish --access public "$PACKAGE_TARBALL"');
    expect(workflow).toContain("Publishing to npm with Trusted Publishing via GitHub OIDC");
    expect(workflow).toContain("Trusted Publishing was not accepted");
    expect(workflow).toContain("workflow filename release.yml");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("fallback");
    expect(workflow).not.toContain("_authToken");
    expect(workflow).toContain("Verify published package");
    expect(workflow).toContain('PACKAGE_SPEC="parallel-codex-tui@$PACKAGE_VERSION"');
    expect(workflow).toContain('npm view "$PACKAGE_SPEC" version --json');
    expect(workflow).toContain('npm install --global --prefix "$VERIFY_PREFIX" --allow-scripts=node-pty "$PACKAGE_SPEC"');
    expect(workflow).toContain('"$VERIFY_PREFIX/bin/parallel-codex-tui" --version');
    expect(workflow).toContain('grep -F "parallel-codex-tui $PACKAGE_VERSION"');
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain('gh release view "$RELEASE_VERSION"');
    expect(workflow).toContain('gh release upload "$RELEASE_VERSION" "$PACKAGE_TARBALL" --clobber');
    expect(workflow).toContain('gh release create "$RELEASE_VERSION" "$PACKAGE_TARBALL" --verify-tag --title "$RELEASE_VERSION"');
    expect(workflow).not.toContain("softprops/action-gh-release");
  });
});
