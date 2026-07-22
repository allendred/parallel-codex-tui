import { TUI_THEME_NAMES } from "./tui/theme.js";

export function buildCliHelpText(themeNames: readonly string[] = TUI_THEME_NAMES): string {
  return `Usage: parallel-codex-tui [options]

Options:
  -w, --workspace <path>  Project workspace for worker sessions and edits
      --app-root <path>   App root for configuration lookup
  -t, --task <id>         Open an existing task session
      --theme <name>      Temporarily use a TUI theme: ${themeNames.join(", ")}
      --themes            List built-in TUI theme palettes; combine with --theme to filter
      --init              Write .parallel-codex/config.toml if missing
      --doctor            Check config, agent commands, and theme palette preview
      --diagnostics [dir] Export a sanitized support bundle; defaults inside the workspace
      --runs              List persisted Supervisor runs without opening the TUI
      --submit <request>  Submit a detached request; use - to read piped stdin
      --idempotency-key <key>  Reuse one submitted run for the same automation key
      --wait              Wait after --submit; Ctrl+C never cancels the run
      --cancel-run [id]   Cancel a run by id, or the latest active run when omitted
      --wait-run [id]     Wait for a run by id, or the latest unfinished run
      --wait-timeout <s>  Bound --wait or --wait-run; never cancels the run
      --json              Emit machine-readable Supervisor command output
      --probe-agents      With --doctor, run fresh + resume probes (uses model quota)
      --probe-router      With --doctor, run one live Codex Router request
  -v, --version           Print the current version
  -h, --help              Print this help message

Options with values also accept --name=value and -x=value forms.`;
}

export const helpText = buildCliHelpText();
