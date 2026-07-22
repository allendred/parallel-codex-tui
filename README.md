# parallel-codex-tui

A standalone TypeScript TUI wrapper for routed parallel coding workflows. It keeps a main chat open while Codex routes larger tasks into Judge, Actor, and Critic workers that can write prompts, logs, session metadata, and outputs to disk.

Built with Codex-assisted development.

## Current Release

`v0.4.4` is available from [npm](https://www.npmjs.com/package/parallel-codex-tui/v/0.4.4) and as a [GitHub Release](https://github.com/allendred/parallel-codex-tui/releases/tag/v0.4.4). It adds read-only `--watch-run` streaming for persisted Supervisor events, Worker output, and terminal answers; external Feature pause/cancel commands; and detached Task retry/Feature resume commands with optional waiting and automation-safe idempotency. A terminal can now submit work, leave, watch it from another process, and recover individual Features without opening or taking control of the TUI.

Interactive Main and parallel executions run in a detached, per-request Supervisor after the Router resolves in the foreground; headless submissions route inside that Supervisor. `Ctrl+C` closes the outer TUI without stopping an attached run, reopening the same workspace restores its live events or terminal result, and `Esc` remains the explicit cancellation command. One TUI owns the control lease while additional TUIs observe the same run; an observer takes control automatically after the prior controller detaches or exits.

Supervisor requests, state, events, commands, controller ownership, acknowledgements, and diagnostic output are retained under `.parallel-codex/supervisor/runs/<run-id>/`. The Supervisor writes the final chat result itself, so completion survives a closed terminal without duplicate history when the TUI is reopened. Unexpected Supervisor exit is converted into a durable failed state instead of leaving an indefinitely running UI.

In the Task session center, `Ctrl+F` searches durable evidence across Tasks and Turns, Feature names, roles, Providers, models, Worker states, summaries, and native session ids. Filters such as `turn:"中文输入" role:actor provider:codex state:done` can be combined with ordinary Unicode text; live async results reject stale responses, Enter keeps the filter, Esc restores the previously applied query, and `X` clears it.

Every Task export now includes human-readable `report.md` and structured `report.json` beside the complete raw `session/` snapshot. Reports preserve each Turn request and route, Judge requirements/plans/acceptance criteria, supervisor summaries, Feature assignments and latest review evidence, Wave verification results, Worker Provider/model/state, active native session metadata, completion contracts, and final acceptance evidence. Integrated changed paths are compared with the current workspace as `match`, `drift`, `missing`, `unexpected`, or `unavailable`; the newest integrated wave for each path is authoritative, deleted paths are represented correctly, and unsafe or symlink-traversing paths are never read.

`Ctrl+E` opens runtime role/model control for Main, Judge, Actor, and Critic. The complete matrix can apply once to the next request, persist for retries and follow-ups in the current Task, or become the default for future requests. Saving validates every selected Provider before it writes configuration, and concurrent TUI instances atomically consume a one-shot matrix exactly once.

Feature assignment now controls both Provider and model. From a retryable Feature, press `M`, use `A`/`C` to cycle the Actor/Critic Provider, and use `1`/`2` to edit the Actor/Critic model. A model change starts a distinct Worker identity, keeps all earlier logs and native sessions, and remains an explicit Feature override when Task defaults change. Status details show separate `actual`, `next`, and `future` role matrices alongside the selected historical Worker's persisted model.

`Ctrl+T`, then `C`, opens every persisted Main conversation and provides the same durable management lifecycle as Task sessions: rename, archive, unarchive, scoped export, and confirmed deletion. Restoring one switches the exact `conversation_id`, reloads only that conversation's file-backed history, and restores its archived native Codex or Claude session ids when they are available. `Ctrl+N` creates an explicit, durable Main conversation boundary without deleting chat, Tasks, or Worker logs.

A real Claude acceptance retires the first native session, inserts 16 newer records so the secret is absent from the inline transcript, then proves a fresh Claude session can read the scoped snapshot and recover it. The same live TUI presses `Ctrl+N`, verifies the replacement session is retired, starts another native session whose prompt and archive exclude the secret, and then switches between two isolated workspaces. The bounded rollover fallback remains included: every Main call rebuilds recent context from canonical `chat.jsonl`, so a fresh Agent still receives the latest dialogue inside its current scope.

Complex task memory now retains the root Turn plus the latest 19 previous Turn summaries within a 12,000-character budget. When a longer task omits intermediate summaries inline, the prompt points the Worker to the complete immutable Turn history on disk. Main chat still extracts only the final Codex answer while retaining the complete CLI transcript in `output.log`; legacy transcript-shaped chat records are cleaned when displayed without rewriting their file-backed evidence. Workspace integration ignores known host metadata such as `.DS_Store` and AppleDouble files while continuing to reject real concurrent project edits.

The default role map is Main/Judge/Actor on Codex and Critic on Claude. Status details show the actual, next, and future role maps separately from each historical Worker's persisted Provider/model. Config monitoring labels Router-only edits as active on the next request and marks role, Worker, model, permission, or UI changes as requiring restart. Claude text/JSON print runs are recognized as buffered work, use the total deadline instead of a false first-output deadline, and run safe isolated tools through non-interactive `auto` permissions. The `v0.2.4` non-interactive Codex permission placement remains included. The release keeps terminal scrolling and copying available at the same time without requiring Shift and preserves the embedded native Agent scrollback across status-detail round trips and real PTY resizes.

Highlights:

- Judge produces validated requirements, acceptance criteria, and a dependency-aware Feature DAG. Actor/Critic pairs exchange checked JSONL findings and replies, followed by Wave Critic and final Judge acceptance.
- A conflicting parallel wave is archived with its merge evidence and returned to the same Judge native session for a bounded DAG replan. The replacement plan must retain the same Feature IDs and serialize every conflicting pair; a deterministic serialized fallback is used when the Judge response is invalid.
- Tasks retain every Turn, historical Worker log, native session binding, model snapshot, and collaboration artifact across follow-ups and restarts. A 20-turn soak verifies 80 ordered Workers before and after restart.
- Main responses, raw process evidence, active role configuration, and historical Worker identity now have separate display and persistence paths.
- `--diagnostics` and `Ctrl+X` export bounded, redacted support evidence without prompts, role instructions, command arguments, source files, or environment-variable values.
- `--watch-run` follows durable events and incremental Worker logs without claiming the TUI controller or acknowledging the result; JSON mode emits one versioned record per line.
- `--pause-feature`, `--cancel-feature`, `--resume-feature`, and `--retry-task` expose the same Supervisor-owned recovery lifecycle to scripts and CI.
- Runtime preflight checks Codex, Claude, named third-party Providers, proxy reachability, workspace access, CLI capabilities, and native attach policy before work starts.
- Named Worker Providers support Codex-compatible, Claude-compatible, OpenAI-compatible, Anthropic-compatible, and custom generic commands with independent role, model, environment, permission, resume, and interactive settings.
- Worker overview, Feature board, collaboration timeline, Task and Main conversation centers, status details, rendered Markdown/Diff/error logs, Unicode search, keyboard navigation, mouse scrolling, and configurable themes share one terminal UI system.

Release acceptance includes a real three-Feature Tetris task with parallel Actor/Critic waves and final integration review. A clean `v0.2.5` task also ran Codex Judge and Actor, a buffered Claude Critic that independently executed `node --test` and `npm test`, atomic integration, and a resumed Codex Judge that independently passed all seven acceptance criteria. Real Codex and Claude probes both proved fresh and same-session resume calls; Codex fresh and resume runs executed workspace writes with root-level `-a never`, and Claude automated sessions executed safe Bash tools with `auto` permissions. The semantic Router completed a live classification, and one TUI completed Main calls in two workspaces before restoring the first workspace without leaking chat state. PTY coverage runs in Apple Terminal, tmux, and Zellij profiles at narrow and wide sizes, including status/log equivalence, preserving the native output tail across status-detail round trips, and proving both inline and on-demand file memory after native-session rollover. Supervisor PTY coverage proves detached Main and complex execution, restart recovery, controller/observer takeover, explicit cancellation, process-owner crash recovery, out-of-process status/cancellation, detached wait/timeout commands, headless submission, idempotent concurrent retries, missing-Workspace bootstrap, same-Task continuation, read-only event and Worker-output streaming, and external Feature recovery controls. The deterministic repository suite contains 1,390 tests across 145 files: 1,389 pass by default, while one quota-consuming real-Agent test is skipped and passes through `npm run test:real-agents`.

Real Provider probes depend on valid local CLI credentials. In particular, authenticate the Claude CLI before selecting a Claude-compatible Worker, then run `parallel-codex-tui --doctor --probe-agents` to prove fresh and resumed calls on that machine.

## Requirements

- Node.js 24.15+.
- macOS or Linux. Windows is not yet covered by CI; use WSL for the supported Linux path.
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
parallel-codex-tui --doctor --probe-agents
parallel-codex-tui --doctor --probe-router
parallel-codex-tui --diagnostics
parallel-codex-tui --diagnostics ./support-bundle
parallel-codex-tui --workspace /path/to/project --runs
parallel-codex-tui --workspace /path/to/project --runs --json
parallel-codex-tui --workspace /path/to/project --submit "implement the next feature"
parallel-codex-tui --workspace /path/to/project --submit "implement the next feature" --wait --json
printf 'review the current diff\n' | parallel-codex-tui --workspace /path/to/project --submit -
parallel-codex-tui --workspace /path/to/project --cancel-run
parallel-codex-tui --workspace /path/to/project --wait-run
parallel-codex-tui --workspace /path/to/project --wait-run --wait-timeout 600 --json
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
- Every interactive open and in-place workspace switch runs a quota-free startup preflight before the TUI accepts work. It checks workspace read/write/search access, every CLI required by the active route and role configuration, referenced model environment variables, each named Worker's Codex, Claude, or declared generic CLI capabilities, configured proxy endpoint reachability, and native workspace trust policy. Healthy checks stay quiet; warnings and failures appear in chat with the `parallel-codex-tui --doctor` action. Live model requests remain opt-in through `--probe-agents` and `--probe-router`.
- While the TUI is idle, press `Ctrl+P` to open the same project picker without exiting. `Esc` returns with the unsent draft intact; selecting or creating a folder locks duplicate picker input, shows the project being opened, rebuilds the runtime in place, and restores that workspace's latest task, route, workers, and chat. A failed open returns to the original view without replacing its runtime or draft.
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

CLI options with values can also be passed as `--workspace=/path/to/project`, `--app-root=/path/to/app`, `--task=task-id`, `--theme=paper`, `--submit=request`, `--watch-run=run-id`, `--resume-feature=feature-id`, `--idempotency-key=ci:build-1`, `-w=/path/to/project`, and `-t=task-id`.

Check available flags or the installed version without starting the TUI:

```bash
parallel-codex-tui --help
parallel-codex-tui --doctor
parallel-codex-tui --doctor --probe-agents
parallel-codex-tui --doctor --probe-router
parallel-codex-tui --diagnostics
parallel-codex-tui --diagnostics ./support-bundle
parallel-codex-tui --workspace /path/to/project --runs
parallel-codex-tui --workspace /path/to/project --runs --json
parallel-codex-tui --workspace /path/to/project --submit "implement the next feature"
parallel-codex-tui --workspace /path/to/project --submit "implement the next feature" --idempotency-key ci:feature-1 --wait --json
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --submit "continue with the next requirement" --wait
parallel-codex-tui --workspace /path/to/project --cancel-run
parallel-codex-tui --workspace /path/to/project --cancel-run run-20260721T000000Z-deadbeef
parallel-codex-tui --workspace /path/to/project --wait-run
parallel-codex-tui --workspace /path/to/project --wait-run run-20260721T000000Z-deadbeef --wait-timeout 600 --json
parallel-codex-tui --workspace /path/to/project --watch-run
parallel-codex-tui --workspace /path/to/project --watch-run run-20260721T000000Z-deadbeef --json
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --pause-feature 0001-ui
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --cancel-feature 0001-ui
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --resume-feature 0001-ui --wait
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --retry-task --wait
parallel-codex-tui --version
```

`--doctor` checks configured automated and interactive commands, `{env:NAME}` references, and the CLI help surfaces required for Codex exec/resume sandboxing and Claude print/resume permissions before workers start. Recognized standard CLI help that lacks a required option fails the check; an opaque wrapper keeps the compatible built-in profile's unverified warning, while an explicit `generic` capability contract is validated without guessing vendor-specific help. Doctor performs these checks for every named Worker Provider used by the active route, rejects an explicitly read-only Codex-compatible interactive sandbox when feature attach needs writable roots, and reminds you that native workspace trust remains an interactive decision. It reports proxy host/port reachability as a local-endpoint check, not as proof that the proxy upstream or model API is healthy. Add `--probe-agents` to make one minimal fresh request and, when configured, one same-session resume request through every active process Worker Provider. This explicit probe uses model quota, removes successful probe artifacts, preserves failed artifacts under `.parallel-codex/probes/`, and exits non-zero when a fresh or resumed request cannot be proven. Fresh sessions use the configured `freshSessionArgs`; Claude-compatible profiles default to a generated native `--session-id`, persisted only after the process emits output, so a silent failed launch cannot create a false resumable session. Add `--probe-router` to run one real classification through the configured Codex Router; the command exits non-zero when that live request falls back or fails. Doctor also reports the loaded TUI theme, core palette values, ANSI swatch previews, and color override values, including any temporary `--theme` override.

## Diagnostics

Export a support bundle without starting the TUI:

```bash
parallel-codex-tui --workspace /path/to/project --diagnostics
parallel-codex-tui --workspace /path/to/project --diagnostics ./support-bundle
```

Without an explicit destination, the bundle is created under `.parallel-codex/diagnostics/<timestamp>/`. An explicit destination must not already exist. While the TUI is open, `Ctrl+X` creates the same bundle without interrupting chat, logs, Task center, or an active Worker; native attach keeps `Ctrl+X` available to the attached Agent.

The bundle contains `manifest.json`, `report.md`, `report.json`, `doctor.txt`, `tasks.json`, `workers.json`, `router-audit.jsonl`, and bounded Worker log tails. It exports at most the latest 20 tasks, 200 Workers, 100 Router rows, and 200 lines or 64 KiB per Worker log. Workspace, app-root, and home paths are aliased; URL credentials and paths, authorization values, secret assignments, common token formats, and environment-variable values are redacted. Prompts, role instructions, command arguments, source files, and lifetime logs are excluded. Review the bundle before sharing it, because application output can still contain project-specific text that no automatic redactor can fully understand.

## Background Runs

Inspect a Workspace without opening the TUI:

```bash
parallel-codex-tui --workspace /path/to/project --runs
parallel-codex-tui --workspace /path/to/project --runs --json
```

Runs are ordered newest first. Text and JSON output include the run and Task ids, operation kind, lifecycle status, control state, timestamps, Supervisor PID, process liveness, controller PID/liveness, and whether the terminal result has been acknowledged by a TUI. Control states distinguish `starting`, `controlled`, `detached`, `settled`, and `stale`. The JSON document is versioned as `1` and intentionally excludes the original request, prompts, Worker logs, command arguments, and environment values.

Submit a new request without opening the TUI, or continue an existing Task:

```bash
parallel-codex-tui --workspace /path/to/project --submit "implement the next feature"
printf 'review the current diff\n' | parallel-codex-tui --workspace /path/to/project --submit -
parallel-codex-tui --workspace /path/to/project --submit "implement the next feature" --wait --json
parallel-codex-tui --workspace /path/to/project --submit "implement the next feature" --wait-timeout 600 --json
parallel-codex-tui --workspace /path/to/project --submit "implement the next feature" --idempotency-key ci:feature-1 --json
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --submit "continue with the next requirement" --wait
```

`--submit` prepares and remembers the selected Workspace, creates the default app configuration when it is missing, persists the run, and starts a detached Supervisor before returning. The Router runs inside the Supervisor, so the calling shell does not have to remain open during classification or Worker execution. `--submit -` reads at most 1 MiB of piped UTF-8 input and rejects an interactive terminal or empty request. A submission does not claim `controller.json`, acknowledge the result, or print the request; its text and versioned JSON output contain only bounded run metadata.

Use `--wait` to remain until the submitted run settles. `--wait-timeout <seconds>` implies waiting and exits with code `4` when only the local deadline expires; it never appends a cancellation command, and the detached Supervisor continues running. Combined JSON contains separate versioned `submission` and `wait` objects. Passing an existing `--task` creates a new `handle-task-turn` run against the same durable Task and native Worker history.

For retried CI jobs, `--idempotency-key <key>` accepts 1-128 letters, numbers, dots, underscores, colons, or hyphens. The raw key is never persisted or emitted: a Workspace-scoped SHA-256 digest selects the run id. Concurrent submissions with the same key and identical request start exactly one Supervisor and reuse its metadata; changing the request for an existing key is rejected. Without an idempotency key, a second submission is rejected while another run remains active in that Workspace.

Cancel the latest active run, or address one explicitly:

```bash
parallel-codex-tui --workspace /path/to/project --cancel-run
parallel-codex-tui --workspace /path/to/project --cancel-run run-20260721T000000Z-deadbeef
parallel-codex-tui --workspace /path/to/project --cancel-run run-20260721T000000Z-deadbeef --json
```

Cancellation appends a checked command to the run's existing Supervisor command stream. It does not signal Worker PIDs directly, so the normal orchestrator cancellation, process-tree cleanup, terminal state, chat persistence, and retry evidence remain authoritative. An explicit administrative cancellation can be sent while a TUI is observing or controlling the run. Missing, stale, and already-terminal targets fail without creating a new Workspace or changing historical run evidence.

Wait for the latest unfinished run, or address one explicitly:

```bash
parallel-codex-tui --workspace /path/to/project --wait-run
parallel-codex-tui --workspace /path/to/project --wait-run run-20260721T000000Z-deadbeef
parallel-codex-tui --workspace /path/to/project --wait-run run-20260721T000000Z-deadbeef --wait-timeout 600 --json
```

When no unfinished run exists, `--wait-run` returns the newest persisted terminal run immediately. The waiter is read-only: it does not claim `controller.json`, append to `commands.jsonl`, acknowledge the result, read the original request, or inspect Worker output. `--wait-timeout` accepts positive decimal seconds and stops only the waiting CLI; the Supervisor and Workers continue normally. `Ctrl+C` likewise exits the waiter without cancelling the run.

Watch the latest unfinished run, or select one explicitly:

```bash
parallel-codex-tui --workspace /path/to/project --watch-run
parallel-codex-tui --workspace /path/to/project --watch-run run-20260721T000000Z-deadbeef
parallel-codex-tui --workspace /path/to/project --watch-run run-20260721T000000Z-deadbeef --wait-timeout 600 --json
```

`--watch-run` first replays persisted Supervisor events and complete known Worker logs, then follows only newly appended output until the run settles. Text mode labels Router, status, Worker, and log records; `--json` emits one compact, versioned JSON Lines record for each snapshot, event, Worker-output chunk, and finish result. The finish record includes the terminal Main/Task summary or failure text. Unlike `--wait-run`, watch output intentionally contains Agent and project content, so review it before forwarding it to another system.

The watcher remains an observer: it never creates `controller.json`, acknowledges the result, or writes a command. A local `--wait-timeout` exits with code `4` while the Supervisor continues, and starting after completion still replays the persisted evidence before returning. Without an id, watch selects the newest unfinished run and otherwise the newest terminal run.

Control an active Feature, or start a detached recovery run:

```bash
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --pause-feature 0001-ui
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --cancel-feature 0001-ui --json
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --resume-feature 0001-ui --wait
parallel-codex-tui --workspace /path/to/project --task task-20260721-example --retry-task --idempotency-key ci:retry-1 --wait --json
```

Pause and Feature cancellation append checked commands to the active run that owns the specified Task; they do not signal Worker PIDs directly and their response means “requested,” not “already settled.” Resume requires a paused Feature, while Task retry accepts failed, cancelled, or paused Task state. Both recovery commands create a new detached Supervisor run, preserve prior Worker logs and native session evidence, and support the same `--wait`, `--wait-timeout`, and hashed idempotency behavior as `--submit`. A Workspace still permits only one active Supervisor run at a time.

Wait results use exit code `0` for `completed`, `1` for `failed`, `2` for `cancelled`, `3` for `stale`, and `4` for `timeout`. Text and JSON results contain only the same bounded lifecycle metadata as `--runs`; JSON uses schema version `1`. This makes shell automation able to distinguish task outcomes while keeping requests, prompts, logs, command arguments, and environment values out of its output.

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
maxRevisionRounds = 3   # 1..10
maxConflictReplans = 2  # 0..8
```

Judge may plan up to eight dependency-aware features. The orchestrator keeps dependency order while running at most this many agents concurrently. When one worker fails, already-running peers are allowed to finish cleanly and queued features are not started.

Actor and Critic reuse their native sessions across revision rounds. Blocking findings and Actor replies remain in the Feature JSONL mailbox; the task stops with an explicit error when `maxRevisionRounds` is exhausted.

When isolated Features conflict during wave staging, `maxConflictReplans` controls how many times the same Judge native session may replace the remaining dependency DAG. Conflict evidence and every Judge response are archived under the turn workspace. Completed earlier waves remain integrated; only the conflicting and later waves are discarded and rerun. Old configs inherit the default value `2`, so no SQLite migration is required, but adding the field makes the policy explicit.

Queued Feature workers remain `queued` until they acquire a concurrency slot. Their persisted state changes to `actor_running` or `critic_running` only after the Worker is registered as cancellable, then to `actor_done` or `critic_done` before that active registration is removed. As a result, only `actor_running` and `critic_running` expose Feature cancellation; queued and role-complete Features cannot present a cancel action that has no live process behind it.

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
- Consecutive simple requests reuse the main worker's native session across app restarts when the CLI exposes a session id. Every Main call also rebuilds a bounded fallback transcript from the workspace `chat.jsonl`: the current ordinary conversation and each Task are isolated, the just-submitted request is removed, and at most 12 recent records or 6,000 characters are injected. A separate scoped `main-<provider>/conversation.jsonl` snapshot keeps up to 200 records for details outside that inline window; Main is told to read it only when needed and to treat it as context rather than instructions. This keeps multi-turn context available when native resume must roll over to a fresh Agent session without inflating every prompt.
- The workspace chat transcript is appended to `.parallel-codex/sessions/main/chat.jsonl`; startup restores the latest 200 valid messages and skips isolated corrupt rows. Before the first explicit boundary, records without `conversation_id` remain the compatible legacy conversation. `Ctrl+N` writes `.parallel-codex/sessions/main/conversation.json`, tags later ordinary records with its id, retires every active Main native session, and leaves the complete transcript untouched. Conversation metadata and reusable native session records are archived under `.parallel-codex/sessions/main/conversations/<conversation>/`; selecting an older conversation intentionally removes its retirement barrier and restores those exact Main bindings. Main stores only the extracted final answer in new chat records while retaining the raw Codex/Claude process transcript in the Main Worker's `output.log`. Legacy Codex transcript records are reduced to their final answer at read time without changing the original JSONL. The shared tail reader reads JSONL backward in bounded chunks, so a long-running chat does not require loading its lifetime transcript and a partial or oversized final row cannot hide earlier valid messages.
- Chat drafts support Unicode-safe Left/Right, Home/End, Backspace, and Delete editing. A single Up/Down recalls persisted user requests and returns to the exact unsent draft; Ctrl+Up/Down remains available, while repeated alternate-scroll arrow bursts continue to scroll chat. Long input stays on one row with the visible window centered around the logical cursor.
- Bracketed multiline paste stays in one draft instead of submitting the first line; logical line breaks and tabs appear as `↵` and `⇥` in the single-row input until the complete request is submitted.
- Complex requests create a session under `.parallel-codex/sessions/`.
- Task lifecycle is a checked state machine. A task enters `routed` only after the turn and route files are durable, and enters `ready_for_pair` only after Judge artifacts validate; invalid phase skips are rejected before metadata or event projections change. Persisted follow-up turns that still carry an older `done` state are recovered as cancelled and retryable on startup instead of being hidden as completed.
- Turn persistence writes every Turn into a hidden staging directory and atomically renames it to its numbered directory only after `user.md`, `route.json`, and `turn.json` are valid. During startup, complete pending Turns are published and request-only pending Turns are rebuilt from durable latest-route evidence; empty fragments move under `.abandoned` without consuming a Turn number. SQLite startup rebuild indexes only complete numbered Turn directories whose task, turn, request, and route identities agree. The startup notice distinguishes a restored follow-up Turn from missing completion evidence and says `request and route kept` before offering `Ctrl+R resume`.
- Task creation writes its complete first Turn into a hidden staging directory. Before any Task files appear, an exclusive process-identity claim reserves the Task id, so same-second collisions cannot overwrite another task. After its metadata, route, request, Turn, and creation event are valid, one rename atomically publishes the whole Task. The orchestrator hands the creation claim directly to the task run lease before reading task state or starting Judge. On startup, stale complete Task staging is published and made retryable, incomplete staging is archived under `.abandoned`, and staging owned by another live TUI remains untouched. The startup notice reports archived or externally active creations without duplicating ordinary interrupted-task recovery.
- Cancellation is rechecked after routing and after acquiring a task lease. An already-cancelled request cannot create a Task, initialize Main, append a Turn, or record a retry. Cancellation that arrives while a lease is being acquired releases that lease before returning, while a completed Router classification may remain in the shared audit without creating workspace-side execution state.
- Live workspace integration is the cancellation commit point. Cancellation immediately before commit leaves the live project untouched. Once a verified Wave commit succeeds, its integration evidence is durable; the final Wave's summary and Feature decision are completed, and task evidence finishes as `done` even if cancellation arrives after that commit. In a multi-Wave task, cancellation is observed again before the next Wave, so earlier committed checkpoints remain retry-safe without starting more work.
- Live commit persistence writes `integration.pending.json` as a durable two-phase commit intent before changing project files. On retry, each live path must still match either the Wave baseline or integration snapshot; a partial apply resumes without rerunning completed Workers, and a fully applied Wave with a lost final checkpoint is promoted using its original changed-path set. Any third-state content or extra live path blocks recovery and preserves the intent for inspection instead of rebuilding from an ambiguous workspace.
- New intents use `atomic-claim-v1`. Before a replacement or deletion, the existing target is atomically moved to a commit-scoped `.backup` and checked again against the Wave baseline. File and symlink publication refuses to replace a path that reappears, so an edit racing after preflight remains live while the pending intent, `.tmp`, and `.backup` preserve recovery evidence. Recovery finishes only owned artifacts that still match the integration and baseline snapshots. Legacy temp-only intents remain recoverable, but their ambiguous missing-target state is never assigned to the new protocol.
- Each pending `commit_id` scopes deterministic replacement temp files to one live commit. Recovery completes an owned replacement only when its content and mode exactly match the integration snapshot and its target is still baseline, missing, or already integrated. A foreign or mismatched temp file blocks recovery and remains on disk for inspection. After the final integrated checkpoint is durable, intent cleanup is best-effort and cannot downgrade the committed task. Startup removes a leftover intent only when the final integrated checkpoint matches it; mismatched or unreadable evidence remains on disk for retry and inspection.
- Complex requests run Judge -> Actor -> Critic. Judge also writes a bounded `features.json` dependency plan.
- Judge runs from its task-owned worker directory, reads the selected project without treating it as a write target, and snapshots `requirements.md`, `plan.md`, `acceptance.md`, role briefs, and `features.json` into each numbered turn.
- Before Actor starts, the orchestrator parses the Judge Markdown into stable requirement, plan, and acceptance entries and writes `judge-validation.json`. Missing lists, placeholder-only content, duplicate ids, and unknown requirement references fail before implementation; valid legacy list snapshots are normalized during retry without rerunning Judge.
- Independent features run as parallel Actor batches followed by parallel Critic batches. Dependent features start only after their prerequisite wave is approved and integrated.
- Parallel Actor, Critic, and revision batches honor `[orchestration].maxParallelFeatures` (default `3`).
- Each planned feature gets an isolated Actor implementation workspace, a disposable Critic review clone, worker directories, logs, status, native session ids, and a mailbox under `features/<turn>-<feature>`; the shared dialogue remains in `dialogue/actor-critic.jsonl`. Concurrent text and JSONL appends inside one TUI are serialized per resolved file path, preserving call order without blocking independent feature files; one failed append does not poison later writes.
- Feature revision mailboxes are a checked protocol rather than prompt-only convention. A `REVISION_REQUIRED` Critic must write one `{"id":"C-001","severity":"blocker","summary":"..."}` row per blocker to `critic-findings.jsonl`; the revision Actor must write matching `{"finding_id":"C-001","status":"fixed","notes":"..."}` rows to `actor-replies.jsonl`. Missing, malformed, unacknowledged, or contradictory findings stop the task before live integration. The Supervisor snapshots pending, inconsistent, and approved fixed/open state in `finding-resolution.json`; the collaboration timeline retains the original findings and replies as history and uses resolution evidence instead of counting every reply as a fix.
- Parallel workspace isolation works for both Git and non-Git projects. A wave records `baseline`, per-feature `features/` workspaces, refreshable `reviews/` copies, `staging`, and conflict evidence under `sessions/<task>/workspaces/turn-<turn>/wave-<wave>/` while excluding `.git`, the configured runtime data directory, and known host metadata (`.DS_Store`, AppleDouble, Spotlight/Trash indexes, `Thumbs.db`, and `desktop.ini`). Source files outside that narrow list still trigger the live-mutation guard.
- Feature Critic implementation writes are discarded with the review clone. After an Actor revision, the same Critic native session rechecks a freshly cloned review path; only Actor workspace changes can enter staging.
- Approved feature changes are three-way merged into a task-owned integration workspace first; independent edits to the same text file are combined automatically. The live workspace remains unchanged during this stage.
- Every staged wave gets a combined Wave Critic run in a disposable verification copy. It checks the full Judge acceptance criteria, cross-feature behavior, tests, and builds. A missing `APPROVED`/`REVISION_REQUIRED` decision fails safely instead of being treated as approval.
- When combined verification requests changes, a session-backed Wave Actor fixes the integration workspace and the same Wave Critic native session reviews it again. Only an explicit final `APPROVED` allows the wave to reach the live workspace.
- Wave Actor/Critic prompts, logs, immutable `verification-review-01.md`/`02.md` rounds, native session ids, minimized additional-directory permissions, and `verification.json` audit evidence are stored with the task and remain available through worker logs and native attach.
- Overlapping edits never partially change the live workspace. The orchestrator archives the conflicting paths and merge evidence, returns to `judging`, and asks the same Judge native session to serialize the affected Feature DAG. The replanned run keeps integrated earlier waves and every historical Worker log. If the bounded replan budget is exhausted or the replacement plan is invalid, the task fails with the evidence path and remains retryable through `Ctrl+R`.
- If the live workspace changes after a wave baseline is captured, staging or commit stops with the changed paths instead of silently absorbing an escaped worker edit or overwriting concurrent user work.
- Feature workspaces persist with the task so native attach can reopen the exact worker cwd. Delete an old task session when its audit trail and attachable workspaces are no longer needed.
- Complex follow-ups stay in the active task, append a numbered turn, restore the same Judge session to re-clarify the new direction, and save a turn-local Judge snapshot. A new multi-feature plan can start parallel workers immediately.
- Every numbered turn keeps its own immutable Judge, Actor, and Critic worker directories. Later turns use suffixed ids such as `judge-codex-0002`; the log viewer retains earlier workers, cycles them in turn order, and restores the same order after restart. The new worker record may reuse the prior native session id without overwriting the prior turn's prompt, status, log, or native-session metadata.
- `Ctrl+N` leaves the active complex Task and all Worker logs intact on disk, clears only the live selection and retry state, starts a new Main `conversation_id`, and retires the old Main native session. It works from ordinary chat too, so the next request cannot inherit an unrelated native or file-backed conversation; the next complex request creates an independent Task from turn `0001`.
- Single-feature follow-ups reuse the same Actor/Critic native sessions when available while moving them to the new turn's isolated workspace. File-backed prompt memory keeps the root Turn and the latest 19 previous Turn summaries within a 12,000-character ceiling; longer histories retain an inline count and path to every immutable Turn summary on disk. A failed follow-up retry reuses a complete saved Judge plan, or restores Judge first when the earlier Judge run never produced one.
- Automated Judge, Actor, Critic, Wave Actor, and Wave Critic runs enforce process-level isolation: Codex is clamped to root-level `-a never` plus `workspace-write`, and Claude is clamped to non-interactive `auto`, even when private command arguments request manual approval or contain a broader bypass mode. Native attach remains an explicit interactive path.
- Routing remains in the foreground so fallback choices stay interactive. After a route resolves, Main or parallel execution moves into a detached per-run Supervisor. Pressing `Esc` as the controller cancels the active run and records an interrupted complex task as `cancelled`; pressing `Ctrl+C` detaches and exits the outer TUI while execution continues. Reopening the workspace follows persisted events and restores the final result. A second TUI observes the run and automatically acquires the control lease after the previous controller detaches or exits.
- Failed and cancelled tasks expose `Ctrl+R` retry. Retry keeps the same task and turn, reuses recorded native worker sessions, preserves prior output behind a retry separator, does not route the request again, and reuses the persisted feature dependency plan. A complete Judge snapshot and fully integrated waves are skipped; an unchanged in-progress wave reuses successful Actor and Critic checkpoints and runs only unfinished workers. If the live workspace no longer matches the saved baseline, the stale wave checkpoint is rejected and rebuilt from the current project before workers continue.
- The shared Main chat holds its own `sessions/main/run-owner.json` lease across prompt initialization, native-session reuse, and Worker completion. A second TUI is rejected before it can clear or overwrite the active Main prompt, log, status, or native session, and startup native-session reconciliation skips a Main session owned by another live TUI. After a hard exit, startup atomically claims the stale Main lease, terminates every verifiable orphan process group, marks active Main Workers `cancelled`, preserves native session ids, and records recovery before exposing the runtime. An unverifiable or still-running Main process blocks startup without changing its status or checkpoints.
- Task and Main runs use the same lease finalizer, so a successful run cannot report success until its lease is released. If both the run and lease release fail, the top-level error preserves both causes in an `AggregateError` instead of replacing the original Worker failure.
- Every complex run holds a task-owned `run-owner.json` lease, so another live TUI cannot concurrently retry or append a complex turn to the same task. Stale or corrupt lease replacement is serialized through file-backed claim intents, so exactly one recovery owner can proceed and a competing cleaner cannot delete its replacement lease. A retry revalidates the task state and reloads its latest turn, request, and route only after acquiring that lease, so an older caller cannot rerun a task another TUI already completed. Automated Worker processes run in owned process groups and persist `process.json` with their PID and OS process-start fingerprint while active; the role prompt is sent only after that ownership evidence is durable. If ownership recording fails, the process group is terminated before it receives the prompt and the Worker records `process-ownership-error`. Worker cleanup is shown as `running/process-stopping` until the full command tree is confirmed gone. Timeout and cancellation terminate the full group; normal parent exit also terminates any remaining descendants before terminal status and ownership removal. A detached leader PID reused after exit is never treated as its former process group, while a leaderless group that still owns the reserved ID is still terminated. If cleanup cannot be verified, the Worker records `process-cleanup-error` and keeps `process.json` so startup recovery remains fail-closed; only verified cleanup removes a valid record. Final log, status, native-session callback, or ownership-removal failures settle exactly once by rejecting the adapter call, retaining ownership evidence, and attempting a best-effort `process-finalization-error` status instead of leaving orchestration pending. Task failure convergence attempts every Feature status and the task status independently, so one broken Feature status cannot block the task from becoming retryable. State convergence errors are surfaced alongside the original Worker error. On retry, a missing or invalid Feature status is rebuilt independently. The recovery records `feature.status_recovered` and does not clear its spec, Actor worklog, replies, or Critic findings.
- Workspace startup reconciles nonterminal tasks only when their recorded TUI owner is gone. Recovery atomically claims the same task lease before touching status, logs, checkpoints, or processes, so concurrent TUI startups cannot recover one task twice or race a new retry. Recovery commits cancellation only after every recorded process group is confirmed stopped or safely identified as a reused PID. Matching orphan Worker process groups are terminated, active Worker and feature states become `cancelled`, native session ids and feature checkpoints stay intact, and the task becomes immediately retryable. A reused PID with a different start fingerprint is never signalled, and a task still owned by another live TUI is left untouched. An unverifiable or still-running process blocks startup, reports its `process.json` path, and leaves task, Worker, and feature states unchanged so `Ctrl+R` cannot overlap the old process. The restored chat shows `checkpoints kept · Ctrl+R resume`; recovery events remain in `events.jsonl`.
- Native session metadata is also recoverable. `native-session.json` is the active commit point and is projected into Worker status plus the `workers` and `native_sessions` SQLite rows. A matching `native-session.retired.json` tombstone always wins over a leftover active session file, while a different replacement session id remains active. Before restoring workers, startup reconciles the active file, Worker status, and both SQLite projections before the first TUI frame; tasks owned by another live TUI are left untouched.
- Session index rebuilding publishes either the previous complete snapshot or the new complete snapshot. Clearing and repopulating task, turn, Worker, and native-session rows runs in one SQLite transaction; a filesystem or database failure rolls the whole rebuild back, while concurrent readers keep seeing the previous committed snapshot.
- Terminal completion is evidence-guarded. The latest `supervisor-summary.md`, feature `decisions.md`, and approved feature states are published before task status can become `done`; duplicate task and feature state writes are idempotent, every real task transition records its `from` and `to` state, and a complete `done` task cannot regress unless a new follow-up turn has first been created. Each committed task state change carries a unique transition marker in `meta.json`; same-process retries repair missing projections immediately, and startup repairs a missing event or SQLite projection from that marker before another transition can replace it. Startup also audits legacy `done` tasks that have an integrated latest-turn checkpoint: missing summaries or unfinished feature states are recovered to `cancelled`, then `Ctrl+R` rebuilds final evidence without rerunning completed workers. Legacy log-only `done` sessions without integration proof remain untouched.
- Simple follow-up questions run through the persistent Main native session with the active task directory, original request, root-plus-recent Turn memory, matching Task chat records, valid worker statuses, and log tails as file-backed context. They hold the active task lease while committing the route, taking that context snapshot, and running Main, so the answer cannot race an in-progress complex turn. A failed or cancelled Main answer replaces the transient `running` state with its real terminal state and releases both task and Main leases, so the next question can proceed. They do not start another Judge, Actor, or Critic turn.
- Worker prompts, logs, status, and outputs are written to disk.
- The bottom status line shows the active task state and feature progress such as `wave 1/2 · actor 2/3`, `wave 1/2 · integration 0/1`, and `wave 1/2 · verification 0/1`. Chat, Worker logs, status details, and native attach derive this summary from the same persisted runtime snapshot, so changing views does not rename or reorder task state. While classification is running, it follows the real subprocess through `starting`, `waiting output`, `diagnostics`, `receiving`, `parsing`, and `stopping`, keeps live elapsed/limit progress, identifies a non-default Router runner, and identifies the path as `direct` or `via <proxy-host:port>`. Before output arrives it shows the active first-output deadline and total ceiling; after activity begins it shows total elapsed progress and the idle watchdog. As soon as a fresh initial or follow-up route settles, chat temporarily inserts a themed route rail with `route · <mode> · <source>` followed by the indented Router reason before Main or parallel execution finishes, then replaces it with the final answer or error without adding noise to persisted chat history. Task retry restores its saved route without announcing it as a new Router decision. The status line then replaces the wait state with the final route source, duration, or fallback cause.
- Completed complex tasks open as a structured result at the top of the chat viewport. Requirements, the complete bounded Actor worklog, authoritative integrated changed paths, Critic review, verification evidence, and findings render as themed full-width sections instead of losing everything after each section's first line. Changed files come from the workspace integration result rather than an Actor claim; verification keeps the Critic decision and reported test/build evidence. Multi-feature delivery uses the same result protocol and includes combined Wave verification. Long results start at the title and scroll toward findings; `Ctrl+D` toggles the focused result between full detail and its five-line compact summary, and beginning the next message collapses it automatically. Result lookup follows the persisted task id, so restoring one task cannot display another task's result. Empty state and ordinary short chat remain adjacent to the input.
- Restarting an existing task restores the latest persisted route evidence in the bottom status line, including fallback cause and duration. Follow-up Router classification has no task-side effects: it records the attempt in shared `routes.jsonl`, then a complex turn or simple question refreshes `sessions/<task>/latest-route.json` only after acquiring the task lease. A conflicting TUI leaves the previous committed route and turn files untouched. A corrupt latest-route record safely falls back to the latest worker turn and then the task's initial route record.
- Task session ids are single `task-...` path segments. CLI `--task` input, persisted metadata, startup scanning, and SQLite rebuilding reject path separators and ignore a task whose `meta.json` id differs from its directory, so restoring a session cannot escape or alias the workspace session root.

## Router

Codex routing is enabled by default:

```toml
[router]
defaultMode = "auto"

[router.codex]
command = "codex"
args = ["-a", "never", "exec", "--ephemeral", "--ignore-rules", "-c", "model_reasoning_effort=low", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "-"]
timeoutMs = 60000
firstOutputTimeoutMs = 30000
idleTimeoutMs = 30000
maxOutputBytes = 1048576
maxAttempts = 2
retryDelayMs = 500
followUpTimeoutMs = 45000
fallback = "simple"
```

Set `defaultMode = "simple"` / `defaultMode = "complex"` to force one path. In `auto` mode, routing is semantic through an ephemeral, low-reasoning Codex run. Only `simple` and `complex` are accepted route modes; harmless casing and surrounding whitespace are normalized, while invalid JSON or an unknown mode uses the configured fallback and appears as `invalid output` in the status bar. `fallback = "simple"` or `fallback = "complex"` supplies the non-interactive fallback path; the safe default is `simple` and there is no keyword-only router. `firstOutputTimeoutMs` stops a silent process, `idleTimeoutMs` resets after every stdout or stderr chunk, and `timeoutMs` remains the hard ceiling even while output continues. `maxOutputBytes` bounds combined Router stdout and stderr in memory; exceeding it stops the process tree and reports invalid output instead of waiting for a timeout. The 1 MiB default can be configured from 1 KiB through 16 MiB. The 30-second first-output and idle defaults stay below the 60-second total ceiling, leaving room for a proxied Codex cold start while preserving distinct failure evidence. An idle deadline begins after the latest output, while the hard ceiling still bounds every attempt. A watchdog only runs separately when its limit is lower than the active initial or follow-up total timeout, avoiding competing timers at the same deadline.

On POSIX systems the Router command runs in its own process group. Timeout, cancellation, and stdin failure send `SIGTERM`, wait briefly for graceful cleanup, then use `SIGKILL` when any group member remains. A retry, fallback choice, or completed cancellation is not exposed until that command tree is confirmed stopped, so a previous classifier cannot overlap the next Router or Worker. If termination cannot be verified after `SIGKILL`, the request fails closed instead of continuing around a live process.

`maxAttempts = 2` retries one transient classification failure after `retryDelayMs = 500`; set it to `1` to disable automatic retry. First-output and idle watchdogs plus explicit network/proxy failures are retryable. Total timeouts, authentication, rate limits, unavailable commands, and invalid route JSON go directly to the existing Main/Parallel/Retry/Cancel choice because another immediate attempt is unlikely to help. The status bar shows `retry 2/2` during cancellable backoff and records whether the final decision recovered through an automatic or manual retry. `duration_ms` remains the current Codex attempt, while `router_total_duration_ms` is the accumulated attempts and automatic backoff; Router diagnostics label them `attempt` and `journey`. Every failed attempt is retained with `router_fallback_resolution = "auto-retry"`; exhausting the automatic budget still preserves the manual `R` retry path.

When semantic routing falls back inside the TUI, execution pauses before Main or any task worker starts. `1` selects Main, `2` selects Parallel, `R` retries Codex routing, and `Esc` cancels the request. Active-task follow-ups use the same fallback choice, so a routing outage cannot silently turn a requested implementation change into a Main-only answer. Every failed and retried classification is retained in the shared audit with `router_attempt` and `router_fallback_resolution`; choosing Main or Parallel preserves the original failure evidence while recording the user's decision.

Valid `[router]` changes are reloaded before the next classification without restarting the TUI, so mode, Codex command arguments, timeouts, output limit, retry budget/backoff, fallback, and proxy environment updates take effect on the next request. Worker, pairing, role, orchestration, data-directory, and UI changes still require a restart because those runtime components are constructed at startup.

From chat or worker-log views, press `Ctrl+G` to open the global Router diagnostics view. It reads only the latest 100 valid rows from the shared audit without invoking a model and shows each route's source, duration, fallback cause, scope, and workspace, plus its attempt and automatic/user resolution, alongside the current watchdog and retry policy. The same bounded reverse reader skips malformed or oversized tail rows without reading the whole lifetime audit. `Tab` toggles between all workspaces and the current workspace; the scope summary always retains the loaded route total. The health row separates recovered automatic retries from terminal fallbacks. The latency panel includes p50/p95/max and each new semantic route saves the sanitized Router executable name, all three watchdog limits, retry attempt limit/backoff, the triggered `first-output`/`idle`/`total` timeout kind, proxy-configured flag, normalized proxy source/variable, sanitized proxy host:port, and normalized failure kind. Only the executable basename is retained, so a custom runner is identifiable without exposing its installation path. Successful Codex latency excludes fallback wait time, and the budget row marks each timeout budget as healthy, tight, or high against successful p95 without changing configuration. It requires at least three successful samples before judging a budget; smaller samples remain `learning`. New process traces preserve spawn time, first-output time, process duration, stdout/stderr byte counts, and failure stage, distinguishing a process that never started, failed while receiving input, stayed silent, emitted only diagnostics, exited, or returned an invalid response. Each new trace exposes dispatch, spawn, first output, process, parse, and total stages, with I/O byte evidence on a separate line. Every fallback adds a bounded diagnosis and a concrete next action based on that evidence. Proxy context is correlation evidence, not proof that the proxy caused a failure; a configured proxy remains context rather than a proven cause. The classifier receives the original user request, while `routes.jsonl` stores a sanitized diagnostic copy. URL userinfo, paths, queries, fragments, authorization values, secret assignments, and common provider tokens are removed before display or audit persistence; legacy records are sanitized again when read. Scroll with the mouse wheel or PageUp/PageDown; `Ctrl+G` refreshes it and `Esc` returns with the chat draft intact.

Every new Router fallback persists an authoritative `router_failure_kind` alongside its stage, timeout kind, and proxy context. The status rail and restored tasks prefer that structured evidence over reason-text matching; an old fallback that cannot be classified shows `unknown failure` instead of omitting the cause.

### Proxy Environment

On macOS, startup automatically inherits enabled HTTP, HTTPS, SOCKS, and bypass settings from System Settings when the corresponding process environment variables are absent. Explicit shell variables and local config remain authoritative. Set `PARALLEL_CODEX_INHERIT_SYSTEM_PROXY=0` to opt out. Configure provider-specific values explicitly when one agent needs a different route:

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

`router.codex.env` applies only to semantic classification. `workers.<id>.model.env` applies to fresh/resumed runs and embedded native attach for that named Worker Provider. Keep these values in local `config.toml`, which is ignored by Git.

Run `parallel-codex-tui --doctor` after changing proxy settings. Doctor checks referenced environment variables and labels inherited or configured proxy host/port checks as local-endpoint reachability without printing credentials. If system-proxy detection is unavailable, Doctor reports that the macOS proxy was not inherited and points to the explicit config table. Then run `parallel-codex-tui --doctor --probe-router` when you also need to verify the real Codex Router path through that proxy; this explicit probe can take up to `router.codex.timeoutMs`. A timed-out request is identified as `first output timeout`, `idle timeout after stdout/stderr`, or `total timeout`; `via <proxy-host:port>` remains context, not a claim that the proxy caused the failure. The audit never exposes the proxy URL or credentials.

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
args = ["-a", "never", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"]

[workers.codex.model]
name = "gpt-5"
provider = "openai"
args = ["--model", "{model}"]

[workers.codex.model.env]
OPENAI_API_KEY = "{env:OPENAI_API_KEY}"

[workers.codex.capabilities]
profile = "codex"
writableDirArgs = ["--add-dir", "{dir}"]
freshSessionArgs = []

[workers.codex.interactive]
command = "codex"
args = ["resume", "{sessionId}"]
forkArgs = ["fork", "{sessionId}"]

[workers.claude]
command = "claude"
args = ["--print", "--permission-mode", "auto", "--output-format", "text"]

[workers.claude.capabilities]
profile = "claude"
writableDirArgs = ["--add-dir", "{dir}"]
freshSessionArgs = ["--session-id", "{sessionId}"]

[workers.claude.interactive]
command = "claude"
args = ["--resume", "{sessionId}"]
forkArgs = ["--resume", "{sessionId}", "--fork-session"]
```

`model.args` and `model.env` apply to both automated worker runs and embedded native attach sessions. Native attach appends the rendered model arguments after `interactive.args`, so third-party `{model}` and `{provider}` selections remain active when you press `Ctrl+O`. Codex Router and non-interactive Codex Workers use the root option `-a never` before `exec`, so they cannot stall on an approval UI the outer TUI cannot deliver; Router remains `read-only`, while coding Workers stay inside `workspace-write`. Isolated Codex roles remove broader bypass flags and replace any configured approval mode with this bounded policy. The dangerous `--dangerously-bypass-approvals-and-sandbox` mode is never required. Native Codex attach remains interactive. Claude automated roles use `auto`, allowing safe test and edit commands while retaining Claude's permission checks; commands that still require interactive approval must be continued through `Ctrl+O` instead of being falsely approved in chat.

`model.provider` names the remote model service; `capabilities.profile` describes the local CLI protocol. Worker Provider IDs are lowercase names using letters, digits, or `_`; excluding `-` keeps generated Worker directory names unambiguous. Existing `codex`, `claude`, and `mock` IDs remain compatible, while additional profiles can inherit `codex`, `claude`, another named profile, or conservative `generic` defaults.

Each role can select an independent command, model, environment, and permission contract through `[pairing]`. This example uses an OpenAI-compatible coding CLI for Judge/Actor and an Anthropic-compatible coding CLI for Main/Critic:

```toml
[workers.openai_compat]
extends = "codex"
command = "openai-compatible-coder"
args = ["exec", "--sandbox", "workspace-write", "-"]

[workers.openai_compat.model]
name = "third-party-code-model"
provider = "openai-compatible"
args = ["--model", "{model}", "--provider", "{provider}"]

[workers.openai_compat.model.env]
OPENAI_API_KEY = "{env:OPENAI_COMPAT_API_KEY}"
OPENAI_BASE_URL = "{env:OPENAI_COMPAT_BASE_URL}"

[workers.openai_compat.interactive]
command = "openai-compatible-coder"

[workers.anthropic_compat]
extends = "claude"
command = "anthropic-compatible-coder"

[workers.anthropic_compat.model]
name = "third-party-claude-model"
provider = "anthropic-compatible"

[workers.anthropic_compat.model.env]
ANTHROPIC_API_KEY = "{env:ANTHROPIC_COMPAT_API_KEY}"
ANTHROPIC_BASE_URL = "{env:ANTHROPIC_COMPAT_BASE_URL}"

[workers.anthropic_compat.interactive]
command = "anthropic-compatible-coder"

[pairing]
main = "anthropic_compat"
judge = "openai_compat"
actor = "openai_compat"
critic = "anthropic_compat"
```

`extends` inherits the complete command protocol, including capabilities, native-session behavior, watchdogs, and interactive arguments. Override both `command` and `interactive.command` when a wrapper replaces both executables. `assignable = true` exposes a profile to runtime role and Feature-level Provider cycling; custom profiles default to true, while the reserved deterministic `mock` profile defaults to false. A role that is already configured with a nonassignable profile can still display it and cycle away from it. Pairing an unknown profile, unsafe profile IDs, and inheritance cycles fail config validation before startup.

## Runtime Role Control

While the TUI is idle, press `Ctrl+E` to configure Main, Judge, Actor, and Critic without editing TOML or restarting. Up/Down selects a role, Left/Right (or `[`/`]`) cycles its configured Worker Provider, `M` edits the model name with a Unicode-safe cursor, and `Tab` changes the persistence scope. Press Enter to validate every selected CLI, environment, capability contract, and proxy before saving the complete matrix. `X` clears the saved override and inherits its parent scope, `R` discards unsaved edits, and `Esc` or `Ctrl+E` returns. `Ctrl+Y` copies the visible matrix. A Provider switch resets that role to the Provider's configured default model; a blank model edit also means the Provider default.

The three scopes are explicit:

- `next request` is stored in the current workspace at `.parallel-codex/role-configuration.next.json`, overrides every role once, and is removed only when one routed request atomically claims it. Concurrent TUI instances cannot both consume it.
- `current task` is stored beside that Task's `meta.json`, applies to retries and same-Task follow-ups, and updates inherited unfinished Feature assignments without deleting earlier Workers or logs. Explicit Feature overrides remain unchanged.
- `future requests` is stored in the app root at `.parallel-codex/role-configuration.json` and becomes the default for new Main calls and Tasks across restarts.

Every complex Turn writes the exact consumed matrix to `turns/<turn>/role-configuration.json`. Retries use that evidence instead of silently adopting a pending one-shot selection, native attach uses the selected Worker's persisted Provider/model, and status details show the actual Turn, next-request, and future-default matrices separately from historical Worker identity.

For a third-party command with its own syntax, inherit `generic` so parallel-codex-tui does not inject `--sandbox`, `--permission-mode`, or other built-in-only flags:

```toml
[workers.vendor]
extends = "generic"
command = "vendor-coder"
args = ["run", "--stdin"]

[workers.vendor.capabilities]
profile = "generic"
writableDirArgs = ["--allow-root", "{dir}"]
freshSessionArgs = ["--new-session", "{sessionId}"]

[workers.vendor.nativeSession]
enabled = true
resumeArgs = ["run", "--resume", "{sessionId}", "--stdin"]

[workers.vendor.interactive]
command = "vendor-coder"
args = ["resume", "{sessionId}"]
forkArgs = ["branch", "{sessionId}"]
```

Generic profiles start with native resume disabled, no vendor flags, and the isolated Worker cwd. Set either capability argument list to `[]` when the wrapper needs no extra argument. A non-empty `writableDirArgs` must include `{dir}`, while non-empty `freshSessionArgs` and `interactive.forkArgs` must include `{sessionId}`. Set `forkArgs = []` when a generic CLI cannot fork a native conversation. Doctor validates the declared capability contract without guessing the wrapper's `--help` format; `--doctor --probe-agents` remains the end-to-end fresh/resume check. Every new Worker status records the actual profile ID plus its rendered model/provider snapshot, so later config changes do not relabel historical runs.

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

The process adapter sends each role prompt to stdin and records stdout/stderr in `output.log`. Worker success is separate from the operating-system exit code: a total, first-output, idle, or stdin watchdog failure remains failed even when the terminated CLI handles `SIGTERM` and exits with code `0`, so the next role never starts from a timed-out checkpoint. `firstOutputTimeoutMs` owns silent startup, `idleTimeoutMs` starts only after real stdout/stderr activity, and `timeoutMs` remains the hard ceiling; equal or longer secondary watchdogs do not race the total deadline. Claude `--print` with `text` or `json` emits only its final result, so those launches display `working · buffered` and use `timeoutMs` without arming a separate first-output watchdog. Claude `stream-json` remains streaming and retains the configured first-output deadline.

In chat, scroll long conversation history with the mouse wheel or PageUp/PageDown; sending a new message returns to the latest reply. A single Up/Down recalls persisted request history, and Ctrl+Up/Down remains an alternative. The outer TUI never enables application mouse tracking, so ordinary left-drag selection and system copy work without Shift while alternate-scroll keeps the wheel active in chat and Worker logs. `Ctrl+Y` also copies the current visible chat, rendered Worker log, native Agent screen, or structured overview without changing terminal modes. macOS uses `pbcopy`; Linux uses `wl-copy`, `xclip`, or `xsel` when available and falls back to OSC 52. After a complex task completes, use the same controls to move through its structured result and press `Ctrl+D` to toggle details. Press `Ctrl+N` to preserve all history and start a fresh conversation, `Ctrl+E` to open runtime role/model control, `Ctrl+W` to open Worker logs, and `Tab` to cycle the selected Worker when Workers exist. `Ctrl+S` opens the same status detail view from chat, logs, Worker overview, or an embedded native session; it keeps the footer compact while exposing the complete route, reason, active Main/Judge/Actor/Critic Provider/model map, selected historical Provider/model, phase, activity timestamp, native session, and config effective/restart state. Press `Ctrl+S` or `Esc` to return without interrupting the underlying Worker. While a request is running, press `Esc` to cancel it or `Ctrl+C` to close the TUI and leave the Supervisor running. After a failed or cancelled Task, press `Ctrl+R` to retry the same turn or `Ctrl+N` to start independently. In Worker-log views, scroll with the mouse wheel, Up/Down, or PageUp/PageDown, press `Tab` to cycle Workers, `Ctrl+N` to start a fresh conversation, and `Esc` to return to chat.

`Ctrl+B` opens a live Worker overview without replacing the `Ctrl+W` log shortcut. It summarizes every Judge, Actor, and Critic by turn, role, named Provider, persisted model, state, phase, latest summary, and native-session availability. The selected active worker gets a live activity line showing its first-output deadline while starting and its idle deadline after output begins. The line stays muted while healthy, changes to warning for the final 20% and danger once overdue. Up/Down, PageUp/PageDown, the mouse wheel, or `Tab` changes the selected worker; Enter or `Ctrl+W` opens its rendered log, `Ctrl+O` attaches to its native session, and `Esc` returns to the originating chat or log view. Router diagnostics and the project picker also return to the overview when opened from there.

From Worker overview, press `F` to open the file-backed Feature board. It summarizes every planned feature by turn, state, blocked dependencies and open Critic findings while preserving descriptions and Actor replies from the same collaboration files. Use Up/Down, PageUp/PageDown, the mouse wheel, or `Tab` to select a feature; Enter opens the selected feature's collaboration timeline; `R` refreshes immediately; and `Esc` returns to Worker overview. When a timeline was opened from this board, `Esc` returns to the Feature board instead of skipping back to Workers. While the selected feature is running, press `P` twice to pause only its active Actor or Critic process, or press `X` twice to cancel it; the first press opens a confirmation and `Esc` keeps it running. A paused feature preserves completed peers and same-wave checkpoints; select it and press `Ctrl+R` to resume the same task, turn, and native Worker session. After cancellation, already-running peers finish, queued workers stop, and integration remains blocked, so a partial wave never reaches the live workspace. Once the task settles as cancelled, `Ctrl+R` retries the cancelled task with persisted worker sessions; completed peers are loaded from their same-wave checkpoints instead of running again. Checkpoint load, reuse, and recovery events appear in the collaboration timeline.

For a failed, cancelled, or paused task, select an unfinished Feature and press `M` to edit its assignment. `A` cycles that Feature's Actor through every `assignable` Worker Provider, `C` cycles its Critic, `1` edits the Actor model, `2` edits the Critic model, and `M` or `Esc` closes the prompt. The choice is persisted in `features/<turn>-<feature>/assignment.json`, appears on the Feature board and collaboration artifacts, and takes effect on the next `Ctrl+R` retry. A changed Provider or model starts a distinct Worker while every previous Worker log and native-session record remains available. Feature overrides survive later Task-default changes. Assignment writes hold the same task lease as execution, so another live TUI cannot change a Feature while it is resuming.

From Worker overview, press `C` to open the file-backed Actor/Critic collaboration timeline. It merges `dialogue/actor-critic.jsonl`, feature status, Critic findings, Actor replies, finding resolution, and Wave events into one chronological view. The timeline follows new file evidence automatically and shows verified `fixed`/`open` counts when resolution evidence exists. Up/Down selects a collaboration event; `Enter` opens its complete event detail, including artifact paths from dialogue, status, Critic findings, Actor replies, and finding resolution; `U` filters to unresolved feature evidence; `Tab` cycles all features and each individual feature; `R` refreshes immediately; the mouse wheel or PageUp/PageDown scrolls history; and `Esc` returns to Worker overview.

`Ctrl+T` opens the workspace's persisted Task sessions without exiting the outer TUI. The list shows status, creation time, turn and Worker counts, plus the number of distinct native sessions after deduplicating reused `engine + session_id` bindings; `>` marks the selected row and `*` marks the active Task. Use Up/Down, PageUp/PageDown, the mouse wheel, or `Tab` to select, Enter to restore, `Ctrl+F` to search, `C` to open Main conversations, `I` to inspect the complete session hierarchy, `R` to rename with Unicode-safe cursor editing, `A` to archive or unarchive, `D` twice to confirm deletion, `E` to export, `H` to show or hide archived sessions, `Ctrl+N` to leave the active Task and start a fresh Main conversation, and `Esc` to return without losing the chat draft. Search accepts plain Unicode text plus `task:`, `turn:`, `feature:`, `role:`, `provider:`, `model:`, and `state:` filters; quote a value containing spaces. Search is an AND across terms and reads the rebuildable SQLite evidence index rather than scanning lifetime Worker logs. Archived sessions are hidden by default, cannot be restored until unarchived, and are excluded from automatic startup selection.

Archive, delete, and export require a terminal Task with no live task lease; the active Task cannot be archived or deleted. Exports are complete file-backed snapshots under `.parallel-codex/exports/<task>-<timestamp>/` with a versioned manifest, `report.md`, `report.json`, the raw `session/`, and no transient lease files. The report compares every authoritative integrated path with the current workspace while blocking relative-path escape and parent-symlink traversal. Restoring a Task reloads its route, Workers, retry state, and recorded native session ids. The selected active Task is stored in `session-index.sqlite` and survives process and workspace switches; `Ctrl+N` persists an intentionally empty active-Task context instead of reopening an older Task on restart. SQLite schema changes run as ordered, transactional migrations. The current index stores bounded Turn request text and each Worker's Feature, role, Provider, model, state, and native session binding for structured search. Existing catalogs receive a pre-migration snapshot, each successful startup/reindex refreshes a healthy backup, and an integrity failure restores that backup or rebuilds the catalog from authoritative Task files while preserving the corrupt copy for inspection. `meta.json`, Turn files, and Worker files remain the rebuild authority.

The Main conversation list shows each scoped title, message count, distinct native session count, last activity, current `*` marker, and selected `>` marker. Use the same Up/Down, PageUp/PageDown, mouse-wheel, or `Tab` navigation; Enter restores the selected conversation, `R` renames it with Unicode-safe cursor editing, `A` archives or unarchives it, `D` twice confirms deletion, `E` exports it, `H` shows or hides archived conversations, `N` starts a new one, `T` returns to Tasks, and `Esc` returns to chat. Archived conversations are hidden by default and cannot be restored until unarchived; the current Main conversation cannot be archived or deleted. A Main export is a versioned, conversation-scoped snapshot under `.parallel-codex/exports/<conversation>-<timestamp>/` containing only that conversation's chat rows and matching native sessions. Confirmed deletion streams the shared chat JSONL into an atomic replacement, preserves Task chat and malformed evidence, and restores the original chat and conversation archive if publication fails. Restoration preserves every Task and Worker log, switches `conversation.json`, and rebuilds Main history from records carrying only the selected `conversation_id` (or the pre-boundary legacy scope). Before switching, active Main native sessions are archived and retired; archived bindings for the selected conversation are then restored for best-effort native resume. A brand-new empty legacy scope is not added to the catalog.

The Task detail view reads authoritative task files and presents `Project -> Task -> Turn -> Worker -> Native session`, including each request, role, engine, configured model, Worker state, native session id, working directory, and last activity time. Historical Workers from earlier turns remain selectable after same-task follow-ups. Use Up/Down or `Tab` to select a Worker, Enter to open its retained log, `C` or `Ctrl+O` to continue the original native session, `B` to ask the native CLI to fork it, `R` to refresh, and `Esc` to return to the Task list. Continue and fork restore the selected Worker's recorded cwd and writable roots while the outer TUI stays open. Codex and Claude have built-in fork commands; a generic CLI exposes `B` only when `interactive.forkArgs` is configured. The child fork is owned and persisted by the native CLI; the indexed parent session remains unchanged.

In a Worker log, `Ctrl+F` searches the final rendered Worker log rather than raw file offsets. Type Unicode text normally; Enter moves to the next match and Up/Down moves backward or forward. `Esc` closes search. The current match is marked with `>` without shifting Diff or source line-number columns. With search closed, press `E` to cycle rendered error lines or `D` to cycle Diff files and hunks.

In chat or worker-log views, press `Ctrl+O` to attach to the selected worker's native session inside `parallel-codex-tui`. Native attach runs through a PTY, so full-screen CLIs such as `codex resume {sessionId}` receive a real terminal instead of pipe stdin. Native attach follows outer terminal resize, updating both the rendered screen and child PTY so Codex or Claude reflows at the current dimensions. Input is forwarded to the configured interactive command and output is shown in the native attach panel. When a Codex feature session needs its recorded worker, turn, or feature directories and the interactive command does not already choose a sandbox, native attach adds `--sandbox workspace-write` before its `--add-dir` arguments; an explicitly configured native sandbox remains unchanged. A non-zero native exit recognizes read-only sandbox/add-dir conflicts, untrusted directories, misplaced `--skip-git-repo-check`, missing PTY input, and host permission failures, then appends the exact configuration or terminal action before the exit line scrolls away. Overlapping attach preparations keep only the latest request. Press `Ctrl+]` to return to worker logs; this and closing the outer App terminate the active PTY. An attach preparation that finishes after App shutdown is discarded instead of starting a detached agent. `Ctrl+C` is forwarded to the native agent while attached. In chat and worker-log views, `Ctrl+C` detaches an active Supervisor run and exits the outer TUI; during foreground routing it cancels classification before exiting. A second operating-system SIGINT restores terminal modes and forces exit.

If a native resume fails because the underlying CLI reports that its context window is full, configure `fallback = "new"` under `[workers.<engine>.nativeSession]`. The old native session is archived as `native-session.retired.json`, removed from active use, and the worker is retried once with the normal fresh-session command. A valid retirement tombstone is also a cross-turn inheritance barrier: a retry or later turn cannot resurrect the same session from an older worker copy, while a newer replacement session remains reusable. A `process-cleanup-error` or `process-ownership-error` always blocks native-session fallback, even when the CLI output also mentions a full context window, so a fresh Worker cannot overlap an untracked or still-running resume process.

## Testing

Run the deterministic release checks from a source checkout:

```bash
npm test
npm run test:stability
npm run test:terminal-hosts
npm run typecheck
npm run build
npm run verify:package
```

`test:stability` covers 20 same-task turns, 80 historical Workers, restart recovery, workspace switching, orphan cleanup, and interrupted startup. `test:terminal-hosts` uses real PTYs and exercises Apple Terminal, tmux, and Zellij profiles when those hosts are installed; unsupported hosts are reported as skipped.

Real Agent acceptance is deliberately opt-in because it uses model quota and local credentials:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
npm run test:real-agents
```

The test performs real Main calls in two temporary workspaces through one running TUI, switches back, and verifies that each persisted `chat.jsonl` contains only its own response. Configure the corresponding Worker environment in local `config.toml` when the CLI does not inherit process proxy variables.

## Release

GitHub Actions runs CI on Ubuntu with Node.js 24.15 and 26, plus macOS with Node.js 24.15, for pushes and pull requests to `main`. Every job also packs the release artifact, installs that tarball into a clean global prefix, and executes the installed `--version` and `--help` entrypoints.

Releases publish to npm through npm Trusted Publishing with GitHub OIDC. Do not configure `NPM_TOKEN` for the release workflow. In npm, configure Trusted Publishing for organization/user `allendred`, repository `parallel-codex-tui`, workflow filename `release.yml`, and allowed action `npm publish`. The package already exists on npm, so future releases can use Trusted Publishing directly. You can also configure the trust relationship from an authenticated npm CLI session:

```bash
npm install -g npm@^11.5.1
npm trust github parallel-codex-tui --repo allendred/parallel-codex-tui --file release.yml --allow-publish --dry-run
npm trust github parallel-codex-tui --repo allendred/parallel-codex-tui --file release.yml --allow-publish --yes
```

Creating or listing trusted publishers may require npm two-factor authentication in the browser.

The release job installs npm `^11.5.1`, runs on Node `24.15.x`, publishes the prepared tarball through OIDC, waits for the package to become visible on npm, installs it globally in a temporary prefix, and checks `parallel-codex-tui --version` before creating the GitHub Release. If npm returns `ENEEDAUTH` or `E401`, fix the npm Trusted Publishing package settings rather than adding a token fallback.

To publish a release, update `package.json` and `src/version.ts` to the same version, then push a matching tag:

```bash
VERSION=0.4.4
git tag "v$VERSION"
git push origin "v$VERSION"
```

You can also run the Release workflow manually and enter the same tag value. The release tag must match `package.json`; for example, package version `0.4.4` requires tag `v0.4.4`. Published tags such as `v0.2.10` are immutable and must not be moved or reused.

## Publishing Hygiene

- `.parallel-codex/config.toml` is local-only and ignored.
- `.parallel-codex/role-configuration.json` and `.parallel-codex/role-configuration.next.json` are local runtime role/model selections and are ignored.
- `.parallel-codex/last-workspace` and `.parallel-codex/workspaces.json` are local workspace-selection state and are ignored.
- `.parallel-codex/router/` contains local request classification audit records and is ignored.
- `.parallel-codex/supervisor/` contains detached-run requests, lifecycle state, control commands, event streams, controller leases, acknowledgements, and Supervisor diagnostics; it is local evidence and is ignored.
- `.parallel-codex/sessions/` contains the workspace chat transcript, task prompts, logs, native session ids, isolated feature workspaces, and conflict evidence; never commit it.
- `.parallel-codex/diagnostics/` contains redacted support bundles and is ignored; review a bundle before sharing it.
- `.parallel-codex/probes/` contains failed live Agent probe evidence and is ignored.
- `docs/superpowers/` contains internal planning notes and is ignored for public releases.
