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
      --probe-router      With --doctor, run one live Codex Router request
  -v, --version           Print the current version
  -h, --help              Print this help message

Options with values also accept --name=value and -x=value forms.`;
}

export const helpText = buildCliHelpText();
