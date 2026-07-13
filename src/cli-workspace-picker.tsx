import React, { useEffect, useMemo, useRef, useState } from "react";
import { basename } from "node:path";
import { Box, Text, render, useInput } from "ink";
import type { WorkspaceChoice } from "./core/workspace.js";
import { resolveWorkspacePath } from "./core/workspace.js";
import { compactEndByDisplayWidth, compactTailByDisplayWidth, displayWidth } from "./tui/display-width.js";
import { TUI_THEME } from "./tui/theme.js";

export interface WorkspacePickerInput {
  cwd: string;
  choices: WorkspaceChoice[];
  invalidExplicitWorkspace?: {
    path: string;
    reason: "file" | "missing";
  };
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface WorkspacePickerProps extends Omit<WorkspacePickerInput, "stdin" | "stdout"> {
  terminalHeight: number;
  terminalWidth: number;
  onCancel: () => void;
  onSelect: (workspace: string) => void;
}

interface WorkspacePickerOption {
  kind: "workspace" | "new";
  shortcut: string;
  path: string | null;
  exists: boolean;
}

const WORKSPACE_SHORTCUT_DELAY_MS = 500;

export class WorkspaceSelectionCancelledError extends Error {
  constructor() {
    super("Workspace selection cancelled.");
    this.name = "WorkspaceSelectionCancelledError";
  }
}

export async function promptForWorkspaceTui(input: WorkspacePickerInput): Promise<string> {
  let resolveSelection: (workspace: string) => void = () => undefined;
  let rejectSelection: (error: Error) => void = () => undefined;
  const selection = new Promise<string>((resolve, reject) => {
    resolveSelection = resolve;
    rejectSelection = reject;
  });
  const cancelSelection = () => rejectSelection(new WorkspaceSelectionCancelledError());
  let instance: ReturnType<typeof render> | null = null;
  process.on("SIGINT", cancelSelection);

  try {
    instance = render(
      <WorkspacePicker
        cwd={input.cwd}
        choices={input.choices}
        invalidExplicitWorkspace={input.invalidExplicitWorkspace}
        terminalHeight={input.stdout.rows ?? 24}
        terminalWidth={input.stdout.columns ?? 80}
        onCancel={cancelSelection}
        onSelect={resolveSelection}
      />,
      {
        stdin: input.stdin,
        stdout: input.stdout,
        stderr: input.stdout,
        exitOnCtrlC: false,
        patchConsole: false
      }
    );
    void instance.waitUntilExit().catch((error: unknown) => {
      rejectSelection(error instanceof Error ? error : new Error(String(error)));
    });
    return await selection;
  } finally {
    process.off("SIGINT", cancelSelection);
    instance?.clear();
    instance?.unmount();
  }
}

export function WorkspacePicker({
  cwd,
  choices,
  invalidExplicitWorkspace,
  terminalHeight,
  terminalWidth,
  onCancel,
  onSelect
}: WorkspacePickerProps) {
  const options = useMemo(
    () => workspacePickerOptions(choices, invalidExplicitWorkspace),
    [choices, invalidExplicitWorkspace]
  );
  const defaultWorkspace = invalidExplicitWorkspace?.reason === "missing"
    ? invalidExplicitWorkspace.path
    : null;
  const [mode, setMode] = useState<"list" | "path">(
    options.some((option) => option.kind === "workspace") ? "list" : "path"
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pathValue, setPathValue] = useState("");
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const pathValueRef = useRef("");
  const settledRef = useRef(false);
  const shortcutBufferRef = useRef("");
  const shortcutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const width = Math.max(1, terminalWidth - 1);
  const visibleRows = Math.max(1, Math.min(9, terminalHeight - (invalidExplicitWorkspace ? 7 : 6)));
  const visible = workspacePickerWindow(options, selectedIndex, visibleRows);
  const contentRows = 1
    + (invalidExplicitWorkspace ? 1 : 0)
    + 1
    + (mode === "list" ? visible.items.length + 1 : 2);
  const trailingRows = Math.max(0, terminalHeight - contentRows);

  useEffect(() => () => {
    if (shortcutTimerRef.current) {
      clearTimeout(shortcutTimerRef.current);
    }
  }, []);

  function clearShortcutBuffer() {
    shortcutBufferRef.current = "";
    if (shortcutTimerRef.current) {
      clearTimeout(shortcutTimerRef.current);
      shortcutTimerRef.current = null;
    }
  }

  function finish(value: string) {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    clearShortcutBuffer();
    setOpeningPath(value);
    onSelect(value);
  }

  function replacePathValue(value: string) {
    pathValueRef.current = value;
    setPathValue(value);
  }

  function submitPath(value: string) {
    const requested = value.trim() || defaultWorkspace || cwd;
    finish(resolveWorkspacePath(cwd, requested));
  }

  function openOption(option: WorkspacePickerOption | undefined) {
    clearShortcutBuffer();
    if (!option || option.kind === "new" || !option.path) {
      replacePathValue("");
      setMode("path");
      return;
    }
    finish(option.path);
  }

  function selectNumericShortcut(digits: string) {
    const candidate = `${shortcutBufferRef.current}${digits}`;
    const exactIndex = options.findIndex((option) => option.shortcut === candidate);
    const hasLonger = options.some((option) => (
      option.shortcut.length > candidate.length && option.shortcut.startsWith(candidate)
    ));

    if (exactIndex < 0 && !hasLonger) {
      clearShortcutBuffer();
      return;
    }

    shortcutBufferRef.current = candidate;
    if (exactIndex >= 0) {
      setSelectedIndex(exactIndex);
    }
    if (exactIndex >= 0 && !hasLonger) {
      openOption(options[exactIndex]);
      return;
    }

    if (shortcutTimerRef.current) {
      clearTimeout(shortcutTimerRef.current);
    }
    shortcutTimerRef.current = setTimeout(() => {
      const pending = shortcutBufferRef.current;
      clearShortcutBuffer();
      openOption(options.find((option) => option.shortcut === pending));
    }, WORKSPACE_SHORTCUT_DELAY_MS);
  }

  useInput((input, key) => {
    if (settledRef.current) {
      return;
    }
    const inputHasReturn = /[\r\n]/.test(input);
    const printableInput = input.replace(/[\u0000-\u001f\u007f]/g, "");
    if (key.ctrl && input.toLowerCase() === "c") {
      if (!settledRef.current) {
        settledRef.current = true;
        onCancel();
      }
      return;
    }

    if (mode === "path") {
      clearShortcutBuffer();
      if (key.escape) {
        if (options.some((option) => option.kind === "workspace")) {
          setMode("list");
        } else {
          onCancel();
        }
        return;
      }
      if (key.return) {
        submitPath(pathValueRef.current);
        return;
      }
      if (key.backspace || key.delete) {
        replacePathValue(Array.from(pathValueRef.current).slice(0, -1).join(""));
        return;
      }
      if (key.ctrl && input.toLowerCase() === "u") {
        replacePathValue("");
        return;
      }
      if (!key.ctrl && !key.meta) {
        const nextValue = `${pathValueRef.current}${printableInput}`;
        if (inputHasReturn) {
          submitPath(nextValue);
        } else if (printableInput) {
          replacePathValue(nextValue);
        }
      }
      return;
    }

    if (key.escape) {
      clearShortcutBuffer();
      onCancel();
      return;
    }
    if (key.upArrow || (key.tab && key.shift)) {
      clearShortcutBuffer();
      setSelectedIndex((current) => (current - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow || key.tab) {
      clearShortcutBuffer();
      setSelectedIndex((current) => (current + 1) % options.length);
      return;
    }
    if (key.return) {
      const pending = shortcutBufferRef.current;
      if (pending) {
        clearShortcutBuffer();
        openOption(options.find((option) => option.shortcut === pending));
        return;
      }
      openOption(options[selectedIndex]);
      return;
    }

    const newPath = printableInput.match(/^n(?:ew)?\s+(.+)$/i)?.[1]?.trim();
    if (newPath) {
      submitPath(newPath);
      return;
    }
    if (/^n(?:ew)?$/i.test(printableInput)) {
      clearShortcutBuffer();
      replacePathValue("");
      setMode("path");
      return;
    }
    if (/^\d+$/.test(printableInput)) {
      selectNumericShortcut(printableInput);
      return;
    }

    if (printableInput) {
      clearShortcutBuffer();
      if (inputHasReturn) {
        submitPath(printableInput);
      } else {
        replacePathValue(printableInput);
        setMode("path");
      }
    }
  });

  return (
    <Box flexDirection="column">
      <WorkspacePickerHeader width={width} />
      {invalidExplicitWorkspace ? (
        <WorkspacePickerNotice invalid={invalidExplicitWorkspace} width={width} />
      ) : null}
      <WorkspacePickerTitle
        count={choices.length}
        mode={mode}
        openingPath={openingPath}
        width={width}
      />
      {mode === "list" ? (
        <>
          {visible.items.map(({ option, index }) => (
            <WorkspacePickerOptionRow
              key={`${option.kind}-${option.path ?? "new"}`}
              option={option}
              selected={index === selectedIndex}
              width={width}
            />
          ))}
          <WorkspacePickerFooter
            text={openingPath
              ? workspacePickerOpeningStatus(openingPath)
              : workspacePickerListStatus(selectedIndex, options.length)}
            width={width}
          />
        </>
      ) : (
        <>
          <WorkspacePickerPathRow
            defaultWorkspace={defaultWorkspace ?? cwd}
            locked={Boolean(openingPath)}
            value={pathValue}
            width={width}
          />
          <WorkspacePickerFooter
            text={openingPath
              ? workspacePickerOpeningStatus(openingPath)
              : choices.length > 0 ? `${choices.length} recent` : "new workspace"}
            width={width}
          />
        </>
      )}
      {Array.from({ length: trailingRows }, (_, index) => (
        <FilledText
          key={`workspace-fill-${index}`}
          text=""
          width={width}
          backgroundColor={TUI_THEME.surface}
          color={TUI_THEME.text}
        />
      ))}
    </Box>
  );
}

function WorkspacePickerHeader({ width }: { width: number }) {
  const fullBrand = " parallel-codex-tui";
  const fullSection = " · workspace";
  const brand = width >= displayWidth(`${fullBrand}${fullSection}`)
    ? fullBrand
    : width >= 9 ? " pct" : compactEndByDisplayWidth("pct", width);
  const section = width >= displayWidth(`${brand}${fullSection}`)
    ? fullSection
    : width >= displayWidth(`${brand} · ws`) ? " · ws" : "";
  const fill = Math.max(0, width - displayWidth(brand) - displayWidth(section));
  return (
    <Text>
      <Text backgroundColor={TUI_THEME.chrome} color={TUI_THEME.accent} bold>{brand}</Text>
      <Text backgroundColor={TUI_THEME.chrome} color={TUI_THEME.muted}>{section}</Text>
      <Text backgroundColor={TUI_THEME.chrome}>{" ".repeat(fill)}</Text>
    </Text>
  );
}

function WorkspacePickerNotice({
  invalid,
  width
}: {
  invalid: NonNullable<WorkspacePickerProps["invalidExplicitWorkspace"]>;
  width: number;
}) {
  const label = invalid.reason === "missing" ? "Workspace does not exist" : "Workspace is not a directory";
  const text = compactEndByDisplayWidth(` ${label}: ${invalid.path}`, width);
  return <FilledText text={text} width={width} backgroundColor={TUI_THEME.dangerSurface} color={TUI_THEME.danger} />;
}

function WorkspacePickerTitle({
  count,
  mode,
  openingPath,
  width
}: {
  count: number;
  mode: "list" | "path";
  openingPath: string | null;
  width: number;
}) {
  const rawLabel = openingPath ? " Opening project" : mode === "list" ? " Open project" : " Workspace path";
  const rawMeta = !openingPath && mode === "list" && count > 0 ? `  ${count} recent` : "";
  const label = compactEndByDisplayWidth(rawLabel, width);
  const meta = displayWidth(label) + displayWidth(rawMeta) <= width ? rawMeta : "";
  const fill = Math.max(0, width - displayWidth(label) - displayWidth(meta));
  return (
    <Text>
      <Text backgroundColor={TUI_THEME.surface} color={TUI_THEME.text} bold>{label}</Text>
      <Text backgroundColor={TUI_THEME.surface} color={TUI_THEME.muted}>{meta}</Text>
      <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(fill)}</Text>
    </Text>
  );
}

function WorkspacePickerOptionRow({
  option,
  selected,
  width
}: {
  option: WorkspacePickerOption;
  selected: boolean;
  width: number;
}) {
  const backgroundColor = selected ? TUI_THEME.rail : TUI_THEME.surface;
  const rawName = option.kind === "new" ? "New project" : basename(option.path ?? "") || option.path || "workspace";
  if (width < 12) {
    return (
      <FilledText
        text={`${selected ? ">" : " "} ${rawName}`}
        width={width}
        backgroundColor={backgroundColor}
        color={selected ? TUI_THEME.accent : TUI_THEME.text}
      />
    );
  }
  const indicator = selected ? " > " : "   ";
  const shortcut = `${option.shortcut.padStart(2)} `;
  const status = option.kind === "workspace" && !option.exists && width >= 20 ? " new" : "";
  const fixedWidth = displayWidth(indicator) + displayWidth(shortcut) + displayWidth(status);
  const showPath = option.kind === "workspace" && width >= 46;
  const nameBudget = Math.max(4, Math.min(24, width - fixedWidth - (showPath ? 14 : 0)));
  const name = compactEndByDisplayWidth(rawName, nameBudget);
  const pathBudget = Math.max(0, width - fixedWidth - displayWidth(name) - (showPath ? 2 : 0));
  const path = showPath ? compactTailByDisplayWidth(option.path ?? "", pathBudget) : "";
  const gap = path ? "  " : "";
  const used = displayWidth(indicator) + displayWidth(shortcut) + displayWidth(name) + displayWidth(gap) + displayWidth(path) + displayWidth(status);
  const fill = Math.max(0, width - used);

  return (
    <Text>
      <Text backgroundColor={backgroundColor} color={selected ? TUI_THEME.accent : TUI_THEME.muted} bold={selected}>{indicator}</Text>
      <Text backgroundColor={backgroundColor} color={TUI_THEME.muted}>{shortcut}</Text>
      <Text backgroundColor={backgroundColor} color={TUI_THEME.text} bold={selected}>{name}</Text>
      {gap ? <Text backgroundColor={backgroundColor}>{gap}</Text> : null}
      {path ? <Text backgroundColor={backgroundColor} color={TUI_THEME.muted}>{path}</Text> : null}
      {status ? <Text backgroundColor={backgroundColor} color={TUI_THEME.warning}>{status}</Text> : null}
      {fill > 0 ? <Text backgroundColor={backgroundColor}>{" ".repeat(fill)}</Text> : null}
    </Text>
  );
}

function WorkspacePickerPathRow({
  defaultWorkspace,
  locked,
  value,
  width
}: {
  defaultWorkspace: string;
  locked: boolean;
  value: string;
  width: number;
}) {
  if (width < 4) {
    return <FilledText text={locked ? "·" : "|"} width={width} backgroundColor={TUI_THEME.rail} color={locked ? TUI_THEME.muted : TUI_THEME.accent} />;
  }
  const prefix = locked ? "   " : " > ";
  const cursor = locked ? "" : "|";
  const valueWidth = Math.max(1, width - displayWidth(prefix) - displayWidth(cursor));
  const visibleValue = value
    ? compactTailByDisplayWidth(value, valueWidth)
    : compactTailByDisplayWidth(defaultWorkspace, valueWidth);
  const valueColor = value ? TUI_THEME.text : TUI_THEME.muted;
  const used = displayWidth(prefix) + displayWidth(visibleValue) + displayWidth(cursor);
  const fill = Math.max(0, width - used);
  return (
    <Text>
      <Text backgroundColor={TUI_THEME.rail} color={locked ? TUI_THEME.muted : TUI_THEME.accent} bold={!locked}>{prefix}</Text>
      <Text backgroundColor={TUI_THEME.rail} color={valueColor}>{visibleValue}</Text>
      {cursor ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{cursor}</Text> : null}
      {fill > 0 ? <Text backgroundColor={TUI_THEME.rail}>{" ".repeat(fill)}</Text> : null}
    </Text>
  );
}

function WorkspacePickerFooter({ text, width }: { text: string; width: number }) {
  return <FilledText text={` ${text}`} width={width} backgroundColor={TUI_THEME.chrome} color={TUI_THEME.muted} />;
}

function FilledText({
  backgroundColor,
  color,
  text,
  width
}: {
  backgroundColor: string;
  color: string;
  text: string;
  width: number;
}) {
  const visible = compactEndByDisplayWidth(text, width);
  const fill = Math.max(0, width - displayWidth(visible));
  return (
    <Text>
      <Text backgroundColor={backgroundColor} color={color}>{visible}</Text>
      {fill > 0 ? <Text backgroundColor={backgroundColor}>{" ".repeat(fill)}</Text> : null}
    </Text>
  );
}

function workspacePickerOptions(
  choices: WorkspaceChoice[],
  invalidExplicitWorkspace: WorkspacePickerProps["invalidExplicitWorkspace"]
): WorkspacePickerOption[] {
  const explicit = invalidExplicitWorkspace?.reason === "missing" ? invalidExplicitWorkspace.path : null;
  const options: WorkspacePickerOption[] = [];
  if (explicit && !choices.some((choice) => choice.path === explicit)) {
    options.push({ kind: "workspace", shortcut: "+", path: explicit, exists: false });
  }
  options.push(...choices.map((choice, index) => ({
    kind: "workspace" as const,
    shortcut: String(index + 1),
    path: choice.path,
    exists: choice.exists
  })));
  options.push({ kind: "new", shortcut: "n", path: null, exists: false });
  return options;
}

function workspacePickerWindow(
  options: WorkspacePickerOption[],
  selectedIndex: number,
  limit: number
): {
  start: number;
  end: number;
  items: Array<{ option: WorkspacePickerOption; index: number }>;
} {
  const maxStart = Math.max(0, options.length - limit);
  const start = Math.min(maxStart, Math.max(0, selectedIndex - Math.floor(limit / 2)));
  const end = Math.min(options.length, start + limit);
  return {
    start,
    end,
    items: options.slice(start, end).map((option, offset) => ({ option, index: start + offset }))
  };
}

function workspacePickerListStatus(selectedIndex: number, total: number): string {
  return `${Math.min(total, selectedIndex + 1)} / ${total}`;
}

function workspacePickerOpeningStatus(path: string): string {
  return `opening ${basename(path) || path}`;
}
