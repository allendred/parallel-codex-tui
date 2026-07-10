# parallel-codex-tui

A standalone TypeScript TUI wrapper for routed parallel coding workflows. It keeps a main chat open while Codex routes larger tasks into Judge, Actor, and Critic workers that can write prompts, logs, session metadata, and outputs to disk.

Built with Codex-assisted development.

## Requirements

- Node.js 26+.
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
parallel-codex-tui --version
```

`--doctor` checks the configured commands and any `{env:NAME}` references in active worker model environment settings before workers start. It also reports the loaded TUI theme, core palette values, ANSI swatch previews, and color override values, including any temporary `--theme` override.

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
- Complex requests create a session under `.parallel-codex/sessions/`.
- Complex requests run Judge -> Actor -> Critic. Judge also writes a bounded `features.json` dependency plan.
- Independent features run as parallel Actor batches followed by parallel Critic batches. Dependent features start only after their prerequisite wave is approved and integrated.
- Parallel Actor, Critic, and revision batches honor `[orchestration].maxParallelFeatures` (default `3`).
- Each planned feature gets an isolated implementation workspace, Actor/Critic worker directories, logs, status, native session ids, and a mailbox under `features/<turn>-<feature>`; the shared dialogue remains in `dialogue/actor-critic.jsonl`.
- Parallel workspace isolation works for both Git and non-Git projects. A wave records `baseline`, per-feature workspaces, `staging`, and conflict evidence under `sessions/<task>/workspaces/turn-<turn>/wave-<wave>/` while excluding `.git` and the configured runtime data directory.
- Approved feature changes are three-way merged into staging first. The live workspace is updated only after the complete wave merges cleanly; independent edits to the same text file are combined automatically.
- Overlapping edits fail the task without partially changing the live workspace. The chat error names the conflicting paths and points to marker files under the wave's `conflicts/` directory; `Ctrl+R` retries in the same task and native worker sessions.
- Feature workspaces persist with the task so native attach can reopen the exact worker cwd. Delete an old task session when its audit trail and attachable workspaces are no longer needed.
- Complex follow-ups stay in the active task, append a numbered turn, reuse the same Actor/Critic native sessions when available, and inject up to five prior turn summaries as file-backed memory.
- Pressing `Esc` while a request is running stops the router or active worker and records an interrupted complex task as `cancelled`; exiting the outer TUI also terminates the active run.
- Failed and cancelled tasks expose `Ctrl+R` retry. Retry keeps the same task and turn, reuses recorded native worker sessions, preserves prior output behind a retry separator, does not route the request again, and reuses the persisted feature dependency plan.
- Simple follow-up questions run through the persistent Main native session with the active task directory, original request, up to five recent turn summaries, valid worker statuses, and log tails as file-backed context. They do not start another Judge, Actor, or Critic turn.
- Worker prompts, logs, status, and outputs are written to disk.
- The bottom status line shows the active task state and feature progress such as `wave 1/2 · actor 2/3` and `wave 1/2 · integration 0/1`.

## Router

Codex routing is enabled by default:

```toml
[router]
defaultMode = "auto"

[router.codex]
command = "codex"
args = ["exec", "--ephemeral", "--ignore-rules", "-c", "model_reasoning_effort=low", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "-"]
timeoutMs = 30000
followUpTimeoutMs = 20000
fallback = "simple"
```

Set `defaultMode = "simple"` / `defaultMode = "complex"` to force one path. In `auto` mode, routing is semantic through an ephemeral, low-reasoning Codex run. If initial routing fails or returns invalid JSON, `fallback = "simple"` or `fallback = "complex"` decides the path; the safe default is `simple` and there is no keyword-only router. Active-task follow-ups use `followUpTimeoutMs` and always fail safely to the persistent Main session instead of accidentally starting Actor/Critic workers.

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

Run `parallel-codex-tui --doctor` after changing proxy settings. Doctor checks referenced environment variables, reports when a macOS system proxy is not inherited by Codex subprocesses, and verifies that each configured proxy host and port is reachable without printing proxy credentials.

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

Customize each role independently; the main role is applied to simple chat, while Judge, Actor, and Critic receive their configured instructions during complex work:

```toml
[roles.main]
title = "Guide"
instructions = ["Answer directly and keep prior context."]

[roles.actor]
title = "Builder"
instructions = ["Implement small verified changes.", "Record decisions in worklog.md."]
```

Keep `[router.codex]` on `workspace-write`; routing only classifies requests and does not need host-level access. If a trusted local project needs Docker, OrbStack, or other host services, opt into broader worker permissions in your private `.parallel-codex/config.toml` rather than committing them.

The process adapter sends each role prompt to stdin and records stdout/stderr in `output.log`.

In chat, press `Ctrl+W` to open worker logs and `Tab` to cycle the selected worker when workers exist. While a request is running, press `Esc` to stop it. After a failed or cancelled task, press `Ctrl+R` to retry the same turn. In worker-log views, scroll with the mouse wheel or PageUp/PageDown, press `Tab` to cycle workers, and press `Esc` to return to chat.

In chat or worker-log views, press `Ctrl+O` to attach to the selected worker's native session inside `parallel-codex-tui`. Native attach runs through a PTY, so full-screen CLIs such as `codex resume {sessionId}` receive a real terminal instead of pipe stdin. Input is forwarded to the configured interactive command and output is shown in the native attach panel. Press `Ctrl+]` to return to worker logs; `Ctrl+C` is forwarded to the native agent while attached. In chat and worker-log views, press `Ctrl+C` to exit the outer TUI.

If a native resume fails because the underlying CLI reports that its context window is full, configure `fallback = "new"` under `[workers.<engine>.nativeSession]`. The old native session is archived as `native-session.retired.json`, removed from active use, and the worker is retried once with the normal fresh-session command.

## Release

GitHub Actions runs CI on pushes and pull requests to `main`.

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
- `.parallel-codex/sessions/` contains task prompts, logs, native session ids, isolated feature workspaces, and conflict evidence; never commit it.
- `docs/superpowers/` contains internal planning notes and is ignored for public releases.
