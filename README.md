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
parallel-codex-tui --theme graphite --workspace /path/to/project
```

Startup resolves the worker project before routing:

- `--workspace <path>` opens that project when it already exists.
- If `--workspace <path>` does not exist in an interactive terminal, the CLI shows remembered projects from `.parallel-codex/workspaces.json`; press Enter to create the requested folder, pick a remembered project, or enter another path.
- If `--workspace <path>` points to an existing file, the CLI reports that it is not a directory and will not use that file path as the default folder to create.
- Without `--workspace`, an interactive terminal shows remembered projects from `.parallel-codex/workspaces.json`; choose a number or enter `n <path>` to create/open another folder.
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

`--doctor` checks the configured commands and any `{env:NAME}` references in active worker model environment settings before workers start. It also reports the loaded TUI theme and color override count.

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

## Theme

Set the TUI palette in `.parallel-codex/config.toml`:

```toml
[ui]
theme = "graphite" # codex, graphite, paper

[ui.colors]
accent = "cyan"
chrome = "ansi256(238)"
rail = "#30363d"
surface = "rgb(22, 27, 34)"
```

`ui.colors` is optional and can override any theme key: `chrome`, `surface`, `rail`, `successSurface`, `dangerSurface`, `text`, `muted`, `accent`, `warning`, `success`, or `danger`. Color values are validated during config load and can use Chalk color names, `#rgb`/`#rrggbb`, `rgb(r,g,b)`, or `ansi256(0..255)`. Unknown UI and color keys are rejected so typos fail fast.

For quick previews without editing config, pass `--theme codex`, `--theme graphite`, or `--theme paper` at startup.

## Behavior

- Requests are routed by Codex by default, with a configured simple/complex fallback if the router process fails.
- Router classification only receives the user request; workspace selection and session files are kept out of the router prompt.
- Simple requests stay in the main TUI flow and do not create Judge, Actor, or Critic workers.
- Complex requests create a session under `.parallel-codex/sessions/`.
- Complex requests run Judge -> Actor -> Critic.
- Worker prompts, logs, status, and outputs are written to disk.
- The bottom status line shows the active task state.

## Router

Codex routing is enabled by default:

```toml
[router]
defaultMode = "auto"

[router.codex]
command = "codex"
args = ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"]
timeoutMs = 120000
fallback = "complex"
```

Set `defaultMode = "simple"` / `defaultMode = "complex"` to force one path. In `auto` mode, routing is semantic through Codex. If the router process fails or returns invalid JSON, `fallback = "simple"` or `fallback = "complex"` decides the path; there is no keyword-only router.

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

Keep `[router.codex]` on `workspace-write`; routing only classifies requests and does not need host-level access. If a trusted local project needs Docker, OrbStack, or other host services, opt into broader worker permissions in your private `.parallel-codex/config.toml` rather than committing them.

The process adapter sends each role prompt to stdin and records stdout/stderr in `output.log`.

While viewing a worker log, press `Ctrl+O` to attach to the worker's native session inside `parallel-codex-tui`. Native attach runs through a PTY, so full-screen CLIs such as `codex resume {sessionId}` receive a real terminal instead of pipe stdin. Input is forwarded to the configured interactive command and output is shown in the native attach panel. Press `Ctrl+]` to detach and return to worker logs; `Ctrl+C` is forwarded to the native agent while attached. In chat and worker-log views, press `Ctrl+C` to exit the outer TUI.

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
- `.parallel-codex/sessions/` contains task prompts, logs, native session ids, and worker output; never commit it.
- `docs/superpowers/` contains internal planning notes and is ignored for public releases.
