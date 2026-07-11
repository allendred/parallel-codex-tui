# parallel-codex-tui

A standalone TypeScript TUI wrapper for routed parallel coding workflows. It keeps a main chat open while Codex routes larger tasks into Judge, Actor, and Critic workers that can write prompts, logs, session metadata, and outputs to disk.

Built with Codex-assisted development.

## Requirements

- Node.js 24.15+.
- Codex CLI available as `codex` for Codex routing and Codex workers.
- Claude CLI available as `claude` only when you configure Claude workers.
- A project workspace you are comfortable letting configured workers edit.

## Install

```bash
npm install -g parallel-codex-tui
```

Run it against the project you want the workers to operate on:

```bash
cd /path/to/project
parallel-codex-tui --init
parallel-codex-tui --doctor
parallel-codex-tui --doctor --probe-router
parallel-codex-tui --workspace /path/to/project
parallel-codex-tui --theme aurora --workspace /path/to/project
parallel-codex-tui --theme studio --workspace /path/to/project
```

Startup resolves the worker project before routing:

- `--workspace <path>` opens that project when it already exists.
- If `--workspace <path>` does not exist in an interactive terminal, the themed project picker selects that create target by default; press Enter to create it, move to a remembered project, or choose `New project` and enter another path.
- If `--workspace <path>` points to an existing file, the CLI reports that it is not a directory and will not use that file path as the default folder to create.
- Without `--workspace`, an interactive terminal shows remembered projects from `.parallel-codex/workspaces.json`; use Up/Down and Enter, a displayed number, or `N` to enter a new folder path. The picker clears before the main chat opens.
- In non-interactive startup, the CLI reuses the last remembered workspace, falls back to the current directory if none was saved, and creates an explicit `--workspace` path if needed.
- The selected workspace is prepared before any router or worker process starts.
- While the TUI is idle, press `Ctrl+P` to open the same project picker without exiting. `Esc` returns with the unsent draft intact; selecting or creating a folder rebuilds the runtime in place and restores that workspace's latest task, route, workers, and chat.
- Workspace chat, task files, and `session-index.sqlite` stay isolated under each project. Router configuration and `router/routes.jsonl` remain shared under the app root, so classifications across projects use one global Router audit.

From a source checkout, install dependencies and link the local binary:

```bash
npm install
npm run build
npm link
```

For development without linking, run:

```bash
npm run dev -- --workspace /path/to/project
```

CLI options with values can also be passed as `--workspace=/path/to/project`, `--app-root=/path/to/app`, `--task=task-id`, `--theme=paper`, `-w=/path/to/project`, and `-t=task-id`.

Check available flags or the installed version without starting the TUI:

```bash
parallel-codex-tui --help
parallel-codex-tui --doctor
parallel-codex-tui --doctor --probe-router
parallel-codex-tui --version
```

`--doctor` checks configured commands and `{env:NAME}` references before workers start. It reports proxy host/port reachability as a local-endpoint check, not as proof that the proxy upstream or model API is healthy. Add `--probe-router` to run one real classification through the configured Codex Router; the command exits non-zero when that live request falls back or fails. Doctor also reports the loaded TUI theme, core palette values, ANSI swatch previews, and color override values, including any temporary `--theme` override.

## Quick Start

Create a local config in the app root:

```bash
parallel-codex-tui --init
parallel-codex-tui --doctor
```

From a source checkout, you can also copy the public example:

```bash
cp .parallel-codex/config.example.toml .parallel-codex/config.toml
```

For deterministic local testing without real agent CLIs, set all roles to mock workers in `.parallel-codex/config.toml`:

```toml
[pairing]
judge = "mock"
actor = "mock"
critic = "mock"
```

Then start the TUI:

```bash
parallel-codex-tui --workspace /path/to/project
```

## Parallel Work

Limit how many feature-level Actor or Critic agents may run at once:

```toml
[orchestration]
maxParallelFeatures = 3 # 1..8
```

Judge may plan up to eight dependency-aware features. The orchestrator keeps dependency order while running at most this many agents concurrently. When one worker fails, already-running peers are allowed to finish cleanly and queued features are not started.

## Theme

Set the TUI palette in `.parallel-codex/config.toml`:

```toml
[ui]
theme = "codex" # codex, graphite, paper, aurora, studio
showStatusBar = true
autoOpenFailedWorker = true

[ui.colors]
accent = "ansi256(81)"
chrome = "ansi256(233)"
rail = "ansi256(236)"
surface = "ansi256(234)"
```

Set `showStatusBar = false` to hide the bottom runtime status line and give that row back to the main content area.

Set `autoOpenFailedWorker = false` to keep the chat view open when a restored or running task has a failed worker.

`ui.colors` is optional and can override any theme key: `chrome`, `surface`, `rail`, `successSurface`, `dangerSurface`, `text`, `muted`, `accent`, `warning`, `success`, or `danger`. Color values are validated during config load and can use Chalk color names, `#rgb`/`#rrggbb`, `rgb(r,g,b)`, or `ansi256(0..255)`. Unknown UI and color keys are rejected so typos fail fast.

For quick previews without editing config, pass `--theme codex`, `--theme graphite`, `--theme paper`, `--theme aurora`, or `--theme studio` with `--doctor`:

```bash
parallel-codex-tui --theme graphite --doctor
parallel-codex-tui --theme studio --doctor
```

To compare every built-in palette without loading config or starting the TUI:

```bash
parallel-codex-tui --themes
parallel-codex-tui --theme paper --themes
```

The theme catalog includes complete palette groups for every built-in theme plus the same `preview:` and `semantic:` ANSI swatch rows. Built-in foreground and background pairs are kept at or above a `4.5:1` contrast ratio on every surface where the TUI renders them.

The doctor output includes `preview:` and `semantic:` ANSI swatch rows so you can see the effective terminal colors before starting a worker session. It also audits the 16 foreground/background combinations rendered by the TUI and reports custom pairs below `4.5:1` as warnings. Named colors and ANSI indexes `0..15` use the standard xterm palette for this estimate because terminals may redefine those colors.

## Behavior

- Requests are routed by Codex by default, with a configured simple/complex fallback if the router process fails.
- Router classification only receives the user request; workspace selection and session files are kept out of the router prompt.
- Simple requests stay in the main TUI flow and do not create Judge, Actor, or Critic workers.
- Consecutive simple requests reuse the main worker's native session across app restarts when the CLI exposes a session id.
- The workspace chat transcript is appended to `.parallel-codex/sessions/main/chat.jsonl`; startup restores the latest 200 valid messages and skips isolated corrupt rows.
- Chat drafts support Unicode-safe Left/Right, Home/End, Backspace, and Delete editing; Up/Down recalls persisted user requests and returns to the exact unsent draft. Long input stays on one row with the visible window centered around the logical cursor.
- Bracketed multiline paste stays in one draft instead of submitting the first line; logical line breaks and tabs appear as `↵` and `⇥` in the single-row input until the complete request is submitted.
- Complex requests create a session under `.parallel-codex/sessions/`.
- Complex requests run Judge -> Actor -> Critic. Judge also writes a bounded `features.json` dependency plan.
- Judge runs from its task-owned worker directory, reads the selected project without treating it as a write target, and snapshots `requirements.md`, `plan.md`, `acceptance.md`, role briefs, and `features.json` into each numbered turn.
- Independent features run as parallel Actor batches followed by parallel Critic batches. Dependent features start only after their prerequisite wave is approved and integrated.
- Parallel Actor, Critic, and revision batches honor `[orchestration].maxParallelFeatures` (default `3`).
- Each planned feature gets an isolated Actor implementation workspace, a disposable Critic review clone, worker directories, logs, status, native session ids, and a mailbox under `features/<turn>-<feature>`; the shared dialogue remains in `dialogue/actor-critic.jsonl`.
- Feature revision mailboxes are a checked protocol rather than prompt-only convention. A `REVISION_REQUIRED` Critic must write one `{"id":"C-001","severity":"blocker","summary":"..."}` row per blocker to `critic-findings.jsonl`; the revision Actor must write matching `{"finding_id":"C-001","status":"fixed","notes":"..."}` rows to `actor-replies.jsonl`. Missing, malformed, unacknowledged, or contradictory findings stop the task before live integration. The Supervisor snapshots pending, inconsistent, and approved fixed/open state in `finding-resolution.json`; the collaboration timeline retains the original findings and replies as history and uses resolution evidence instead of counting every reply as a fix.
- Parallel workspace isolation works for both Git and non-Git projects. A wave records `baseline`, per-feature `features/` workspaces, refreshable `reviews/` copies, `staging`, and conflict evidence under `sessions/<task>/workspaces/turn-<turn>/wave-<wave>/` while excluding `.git` and the configured runtime data directory.
- Feature Critic implementation writes are discarded with the review clone. After an Actor revision, the same Critic native session rechecks a freshly cloned review path; only Actor workspace changes can enter staging.
- Approved feature changes are three-way merged into a task-owned integration workspace first; independent edits to the same text file are combined automatically. The live workspace remains unchanged during this stage.
- Every staged wave gets a combined Wave Critic run in a disposable verification copy. It checks the full Judge acceptance criteria, cross-feature behavior, tests, and builds. A missing `APPROVED`/`REVISION_REQUIRED` decision fails safely instead of being treated as approval.
- When combined verification requests changes, a session-backed Wave Actor fixes the integration workspace and the same Wave Critic native session reviews it again. Only an explicit final `APPROVED` allows the wave to reach the live workspace.
- Wave Actor/Critic prompts, logs, immutable `verification-review-01.md`/`02.md` rounds, native session ids, minimized additional-directory permissions, and `verification.json` audit evidence are stored with the task and remain available through worker logs and native attach.
- Overlapping edits fail the task without partially changing the live workspace. The chat error names the conflicting paths and points to marker files under the wave's `conflicts/` directory; `Ctrl+R` retries in the same task and native worker sessions.
- If the live workspace changes after a wave baseline is captured, staging or commit stops with the changed paths instead of silently absorbing an escaped worker edit or overwriting concurrent user work.
- Feature workspaces persist with the task so native attach can reopen the exact worker cwd. Delete an old task session when its audit trail and attachable workspaces are no longer needed.
- Complex follow-ups stay in the active task, append a numbered turn, restore the same Judge session to re-clarify the new direction, and save a turn-local Judge snapshot. A new multi-feature plan can start parallel workers immediately.
- `Ctrl+N` leaves the active complex task intact on disk while clearing its live context, worker selection, retry state, and status so the next complex request creates an independent task from turn `0001`.
- Single-feature follow-ups reuse the same Actor/Critic native sessions when available while moving them to the new turn's isolated workspace; prompts include up to five prior turn summaries as file-backed memory. A failed follow-up retry reuses a complete saved Judge plan, or restores Judge first when the earlier Judge run never produced one.
- Automated Judge, Actor, Critic, Wave Actor, and Wave Critic runs enforce process-level isolation: Codex is clamped to `workspace-write`, and Claude is clamped to `acceptEdits`, even when private command arguments contain a broader bypass mode. Native attach remains an explicit interactive path.
- Pressing `Esc` while a request is running stops the router or active worker and records an interrupted complex task as `cancelled`; exiting the outer TUI also terminates the active run.
- Failed and cancelled tasks expose `Ctrl+R` retry. Retry keeps the same task and turn, reuses recorded native worker sessions, preserves prior output behind a retry separator, does not route the request again, and reuses the persisted feature dependency plan. A complete Judge snapshot and fully integrated waves are skipped; an unchanged in-progress wave reuses successful Actor and Critic checkpoints and runs only unfinished workers. If the live workspace no longer matches the saved baseline, the stale wave checkpoint is rejected and rebuilt from the current project before workers continue.
- Every complex run holds a task-owned `run-owner.json` lease, so another live TUI cannot concurrently retry or append a complex turn to the same task. Automated Worker processes run in owned process groups and persist `process.json` with their PID and OS process-start fingerprint while active; normal exit removes that record.
- Workspace startup reconciles nonterminal tasks only when their recorded TUI owner is gone. Recovery atomically claims the same task lease before touching status, logs, checkpoints, or processes, so concurrent TUI startups cannot recover one task twice or race a new retry. Matching orphan Worker process groups are terminated, active Worker and feature states become `cancelled`, native session ids and feature checkpoints stay intact, and the task becomes immediately retryable. A reused PID with a different start fingerprint is never signalled, and a task still owned by another live TUI is left untouched. The restored chat shows `checkpoints kept · Ctrl+R resume`; recovery events remain in `events.jsonl`.
- Simple follow-up questions run through the persistent Main native session with the active task directory, original request, up to five recent turn summaries, valid worker statuses, and log tails as file-backed context. They do not start another Judge, Actor, or Critic turn.
- Worker prompts, logs, status, and outputs are written to disk.
- The bottom status line shows the active task state and feature progress such as `wave 1/2 · actor 2/3`, `wave 1/2 · integration 0/1`, and `wave 1/2 · verification 0/1`. While classification is running, it follows the real subprocess through `starting`, `waiting output`, `diagnostics`, `receiving`, and `parsing`, keeps live elapsed/limit progress, and identifies the path as `direct` or `via <proxy-host:port>`. It then replaces that wait state with the final route source, duration, or fallback cause.
- Completed complex tasks open as a structured result at the top of the chat viewport. Requirements, the complete bounded Actor worklog, authoritative integrated changed paths, Critic review, verification evidence, and findings render as themed full-width sections instead of losing everything after each section's first line. Changed files come from the workspace integration result rather than an Actor claim; verification keeps the Critic decision and reported test/build evidence. Multi-feature delivery uses the same result protocol and includes combined Wave verification. Long results start at the title and scroll toward findings; `Ctrl+D` toggles the focused result between full detail and its five-line compact summary, and beginning the next message collapses it automatically. Result lookup follows the persisted task id, so restoring one task cannot display another task's result. Empty state and ordinary short chat remain adjacent to the input.
- Restarting an existing task restores the latest persisted route evidence in the bottom status line, including fallback cause and duration. Every active-task classification, including a simple question, atomically refreshes `sessions/<task>/latest-route.json`; a corrupt latest-route record safely falls back to the latest worker turn and then the task's initial route record.

## Router

Codex routing is enabled by default:

```toml
[router]
defaultMode = "auto"

[router.codex]
command = "codex"
args = ["exec", "--ephemeral", "--ignore-rules", "-c", "model_reasoning_effort=low", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "-"]
timeoutMs = 30000
firstOutputTimeoutMs = 30000
idleTimeoutMs = 30000
maxAttempts = 2
retryDelayMs = 500
followUpTimeoutMs = 20000
fallback = "simple"
```

Set `defaultMode = "simple"` / `defaultMode = "complex"` to force one path. In `auto` mode, routing is semantic through an ephemeral, low-reasoning Codex run. Only `simple` and `complex` are accepted route modes; harmless casing and surrounding whitespace are normalized, while invalid JSON or an unknown mode uses the configured fallback and appears as `invalid output` in the status bar. `fallback = "simple"` or `fallback = "complex"` supplies the non-interactive fallback path; the safe default is `simple` and there is no keyword-only router. `firstOutputTimeoutMs` stops a silent process, `idleTimeoutMs` resets after every stdout or stderr chunk, and `timeoutMs` remains the hard ceiling even while output continues. A watchdog only runs separately when its limit is lower than the active initial or follow-up total timeout, avoiding competing timers at the same deadline.

`maxAttempts = 2` retries one transient classification failure after `retryDelayMs = 500`; set it to `1` to disable automatic retry. First-output and idle watchdogs plus explicit network/proxy failures are retryable. Total timeouts, authentication, rate limits, unavailable commands, and invalid route JSON go directly to the existing Main/Parallel/Retry/Cancel choice because another immediate attempt is unlikely to help. The status bar shows `retry 2/2` during cancellable backoff and `try 2` after recovery. Every failed attempt is retained with `router_fallback_resolution = "auto-retry"`; exhausting the automatic budget still preserves the manual `R` retry path.

When semantic routing falls back inside the TUI, execution pauses before Main or any task worker starts. `1` selects Main, `2` selects Parallel, `R` retries Codex routing, and `Esc` cancels the request. Active-task follow-ups use the same fallback choice, so a routing outage cannot silently turn a requested implementation change into a Main-only answer. Every failed and retried classification is retained in the shared audit with `router_attempt` and `router_fallback_resolution`; choosing Main or Parallel preserves the original failure evidence while recording the user's decision.

Valid `[router]` changes are reloaded before the next classification without restarting the TUI, so mode, Codex command arguments, timeouts, retry budget/backoff, fallback, and proxy environment updates take effect on the next request. Worker, pairing, role, orchestration, data-directory, and UI changes still require a restart because those runtime components are constructed at startup.

From chat or worker-log views, press `Ctrl+G` to open the global Router diagnostics view. It reads the shared audit without invoking a model and shows each route's source, duration, fallback cause, scope, and workspace, plus its attempt and automatic/user resolution, alongside the current watchdog and retry policy. `Tab` toggles between all workspaces and the current workspace; the scope summary always retains the loaded global route total. The health row separates recovered automatic retries from terminal fallbacks. The latency panel includes p50/p95/max and each new semantic route saves all three watchdog limits, retry attempt limit/backoff, the triggered `first-output`/`idle`/`total` timeout kind, proxy-configured flag, normalized proxy source/variable, sanitized proxy host:port, and normalized failure kind. Successful Codex latency excludes fallback wait time, and the budget row marks each timeout budget as healthy, tight, or high against successful p95 without changing configuration. It requires at least three successful samples before judging a budget; smaller samples remain `learning`. New process traces preserve spawn time, first-output time, process duration, stdout/stderr byte counts, and failure stage, distinguishing a process that never started, failed while receiving input, stayed silent, emitted only diagnostics, exited, or returned an invalid response. Each new trace exposes dispatch, spawn, first output, process, parse, and total stages, with I/O byte evidence on a separate line. Every fallback adds a bounded diagnosis and a concrete next action based on that evidence. Proxy context is correlation evidence, not proof that the proxy caused a failure; a configured proxy remains context rather than a proven cause. Proxy URLs, credentials, paths, and query strings are never displayed or persisted. Scroll with the mouse wheel or PageUp/PageDown; `Ctrl+G` refreshes it and `Esc` returns with the chat draft intact.

### Proxy Environment

Some CLI runtimes do not inherit the macOS System Settings proxy. Configure the router explicitly when direct OpenAI connections are blocked:

```toml
[router.codex.env]
HTTP_PROXY = "http://127.0.0.1:7890"
HTTPS_PROXY = "http://127.0.0.1:7890"
ALL_PROXY = "socks5h://127.0.0.1:7890"
NO_PROXY = "localhost,127.0.0.1"

[workers.codex.model.env]
HTTP_PROXY = "http://127.0.0.1:7890"
HTTPS_PROXY = "http://127.0.0.1:7890"
ALL_PROXY = "socks5h://127.0.0.1:7890"
NO_PROXY = "localhost,127.0.0.1"
```

`router.codex.env` applies only to semantic classification. `workers.codex.model.env` applies to fresh/resumed Codex workers and embedded native attach sessions. Keep these values in local `config.toml`, which is ignored by Git.

Run `parallel-codex-tui --doctor` after changing proxy settings. Doctor checks referenced environment variables, reports when a macOS system proxy is not inherited by Codex subprocesses, and labels configured proxy host/port checks as local-endpoint reachability without printing credentials. Then run `parallel-codex-tui --doctor --probe-router` when you also need to verify the real Codex Router path through that proxy; this explicit probe can take up to `router.codex.timeoutMs`. A timed-out request is identified as `first output timeout`, `idle timeout after stdout/stderr`, or `total timeout`; `via <proxy-host:port>` remains context, not a claim that the proxy caused the failure. The audit never exposes the proxy URL or credentials.

## Mock Mode

For deterministic local testing, use this pairing in `.parallel-codex/config.toml`:

```toml
[pairing]
judge = "mock"
actor = "mock"
critic = "mock"
```

## Real Worker Mode

Configure Codex and Claude commands in `.parallel-codex/config.toml`:

```toml
[workers.codex]
command = "codex"
args = ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"]

[workers.codex.model]
name = "gpt-5"
provider = "openai"
args = ["--model", "{model}"]

[workers.codex.model.env]
OPENAI_API_KEY = "{env:OPENAI_API_KEY}"

[workers.codex.interactive]
command = "codex"
args = ["resume", "{sessionId}"]

[workers.claude]
command = "claude"
args = ["--print", "--permission-mode", "acceptEdits", "--output-format", "text"]

[workers.claude.interactive]
command = "claude"
args = ["--resume", "{sessionId}"]
```

`model.args` and `model.env` apply to both automated worker runs and embedded native attach sessions. Native attach appends the rendered model arguments after `interactive.args`, so third-party `{model}` and `{provider}` selections remain active when you press `Ctrl+O`.

Customize each role independently; the main role is applied to simple chat, while Judge, Actor, and Critic receive their configured instructions during complex work:

```toml
[roles.main]
title = "Guide"
instructions = ["Answer directly and keep prior context."]

[roles.actor]
title = "Builder"
instructions = ["Implement small verified changes.", "Record decisions in worklog.md."]
```

Keep `[router.codex]` on `read-only`; routing only classifies requests and does not need project writes. Automated Judge/Actor/Critic runs also clamp unsafe Codex or Claude permission flags to their isolated workspace policy, so a private `danger-full-access` or bypass flag cannot silently defeat live-workspace isolation. Use native attach for deliberate interactive host-level work such as Docker or OrbStack access.

The process adapter sends each role prompt to stdin and records stdout/stderr in `output.log`.

In chat, scroll long conversation history with the mouse wheel or PageUp/PageDown; sending a new message returns to the latest reply. After a complex task completes, use the same controls to move through its structured result and press `Ctrl+D` to toggle details. Press `Ctrl+N` to preserve the current session and start a new task, `Ctrl+W` to open worker logs, and `Tab` to cycle the selected worker when workers exist. While a request is running, press `Esc` to stop it. After a failed or cancelled task, press `Ctrl+R` to retry the same turn or `Ctrl+N` to start independently. In worker-log views, scroll with the mouse wheel or PageUp/PageDown, press `Tab` to cycle workers, `Ctrl+N` to start a new task, and `Esc` to return to chat.

`Ctrl+B` opens a live Worker overview without replacing the `Ctrl+W` log shortcut. It summarizes every Judge, Actor, and Critic by engine, state, phase, latest summary, and native-session availability. The selected active worker gets a live activity line showing its first-output deadline while starting and its idle deadline after output begins. The line stays muted while healthy, changes to warning for the final 20% and danger once overdue. Up/Down, PageUp/PageDown, the mouse wheel, or `Tab` changes the selected worker; Enter or `Ctrl+W` opens its rendered log, `Ctrl+O` attaches to its native session, and `Esc` returns to the originating chat or log view. Router diagnostics and the project picker also return to the overview when opened from there.

From Worker overview, press `F` to open the file-backed Feature board. It summarizes every planned feature by turn, state, blocked dependencies and open Critic findings while preserving descriptions and Actor replies from the same collaboration files. Use Up/Down, PageUp/PageDown, the mouse wheel, or `Tab` to select a feature; Enter opens the selected feature's collaboration timeline; `R` refreshes immediately; and `Esc` returns to Worker overview. When a timeline was opened from this board, `Esc` returns to the Feature board instead of skipping back to Workers. While the selected feature is running, press `X` twice to cancel only its active Actor or Critic process; the first press opens a confirmation and `Esc` keeps it running. After confirmation, already-running peers finish, queued workers stop, and integration remains blocked, so a partial wave never reaches the live workspace. Once the task settles as cancelled, `Ctrl+R` retries the cancelled task with persisted worker sessions; completed peers are loaded from their same-wave checkpoints instead of running again. Checkpoint load, reuse, and recovery events appear in the collaboration timeline.

From Worker overview, press `C` to open the file-backed Actor/Critic collaboration timeline. It merges `dialogue/actor-critic.jsonl`, feature status, Critic findings, Actor replies, finding resolution, and Wave events into one chronological view. The timeline follows new file evidence automatically and shows verified `fixed`/`open` counts when resolution evidence exists. Up/Down selects a collaboration event; `Enter` opens its complete event detail, including artifact paths from dialogue, status, Critic findings, Actor replies, and finding resolution; `U` filters to unresolved feature evidence; `Tab` cycles all features and each individual feature; `R` refreshes immediately; the mouse wheel or PageUp/PageDown scrolls history; and `Esc` returns to Worker overview.

`Ctrl+T` opens the workspace's persisted Task sessions without exiting the outer TUI. The list shows status, creation time, and turn, worker, and native-session counts; `>` marks the selected row and `*` marks the active task. Use Up/Down, PageUp/PageDown, the mouse wheel, or `Tab` to select, Enter to restore, `Ctrl+N` to start with an empty task context, and `Esc` to return without losing the chat draft. Restoring a task reloads its route, workers, retry state, and recorded native session ids. The selected active task is stored in `session-index.sqlite` and survives process and workspace switches; `Ctrl+N` persists an intentionally empty active-task context instead of reopening an older task on restart.

In a Worker log, `Ctrl+F` searches the final rendered Worker log rather than raw file offsets. Type Unicode text normally; Enter moves to the next match and Up/Down moves backward or forward. `Esc` closes search. The current match is marked with `>` without shifting Diff or source line-number columns. With search closed, press `E` to cycle rendered error lines or `D` to cycle Diff files and hunks.

In chat or worker-log views, press `Ctrl+O` to attach to the selected worker's native session inside `parallel-codex-tui`. Native attach runs through a PTY, so full-screen CLIs such as `codex resume {sessionId}` receive a real terminal instead of pipe stdin. Native attach follows outer terminal resize, updating both the rendered screen and child PTY so Codex or Claude reflows at the current dimensions. Input is forwarded to the configured interactive command and output is shown in the native attach panel. Press `Ctrl+]` to return to worker logs; `Ctrl+C` is forwarded to the native agent while attached. In chat and worker-log views, press `Ctrl+C` to exit the outer TUI.

If a native resume fails because the underlying CLI reports that its context window is full, configure `fallback = "new"` under `[workers.<engine>.nativeSession]`. The old native session is archived as `native-session.retired.json`, removed from active use, and the worker is retried once with the normal fresh-session command.

## Release

GitHub Actions runs CI on Node.js 24.15 and 26 for pushes and pull requests to `main`.

Releases publish to npm through npm Trusted Publishing with GitHub OIDC. Do not configure `NPM_TOKEN` for the release workflow. In npm, configure Trusted Publishing for organization/user `allendred`, repository `parallel-codex-tui`, workflow filename `release.yml`, and allowed action `npm publish`. The package already exists on npm, so future releases can use Trusted Publishing directly. You can also configure the trust relationship from an authenticated npm CLI session:

```bash
npm install -g npm@^11.15.0
npm trust github parallel-codex-tui --repo allendred/parallel-codex-tui --file release.yml --allow-publish --dry-run
npm trust github parallel-codex-tui --repo allendred/parallel-codex-tui --file release.yml --allow-publish --yes
```

Creating or listing trusted publishers may require npm two-factor authentication in the browser.

The release job installs npm `^11.5.1`, runs on Node `26.x`, publishes the prepared tarball through OIDC, waits for the package to become visible on npm, installs it globally in a temporary prefix, and checks `parallel-codex-tui --version` before creating the GitHub Release. If npm returns `ENEEDAUTH` or `E401`, fix the npm Trusted Publishing package settings rather than adding a token fallback.

To publish a release, update `package.json` and `src/version.ts` to the same version, then push a matching tag:

```bash
git tag v0.1.4
git push origin v0.1.4
```

You can also run the Release workflow manually and enter the same tag value. The release tag must match `package.json`; for example, package version `0.1.4` requires tag `v0.1.4`.

## Publishing Hygiene

- `.parallel-codex/config.toml` is local-only and ignored.
- `.parallel-codex/last-workspace` and `.parallel-codex/workspaces.json` are local workspace-selection state and are ignored.
- `.parallel-codex/router/` contains local request classification audit records and is ignored.
- `.parallel-codex/sessions/` contains the workspace chat transcript, task prompts, logs, native session ids, isolated feature workspaces, and conflict evidence; never commit it.
- `docs/superpowers/` contains internal planning notes and is ignored for public releases.
