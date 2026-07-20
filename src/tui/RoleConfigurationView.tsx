import React from "react";
import { Box, Text, type TextProps } from "ink";
import {
  CONFIGURABLE_ROLES,
  type RoleConfigurationScope,
  type RoleConfigurationSnapshot,
  type RoleExecutionSelection
} from "../core/role-configuration.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { roleConfigurationScopeHasOverride, roleConfigurationScopeLabel } from "./role-configuration-state.js";
import { TUI_THEME } from "./theme.js";

export type RoleConfigurationLineTone = "heading" | "accent" | "text" | "muted" | "success" | "warning" | "danger";

export interface RoleConfigurationDisplayLine {
  text: string;
  tone: RoleConfigurationLineTone;
  selected?: boolean;
}

export interface RoleConfigurationViewProps {
  snapshot: RoleConfigurationSnapshot | null;
  draft: RoleExecutionSelection | null;
  scope: RoleConfigurationScope;
  selectedRoleIndex: number;
  loading?: boolean;
  saving?: boolean;
  notice?: string | null;
  error?: string | null;
  hasActiveTask?: boolean;
  height?: number;
  terminalWidth?: number;
}

export function RoleConfigurationView({
  height = 20,
  terminalWidth = process.stdout.columns || 120,
  ...input
}: RoleConfigurationViewProps) {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = Math.max(1, terminalWidth - 2);
  const lines = roleConfigurationDisplayLines(input, width).slice(0, viewportHeight);
  const blanks = Math.max(0, viewportHeight - lines.length);

  return (
    <Box flexDirection="column" height={viewportHeight}>
      {lines.map((line, index) => (
        <RoleConfigurationRow key={`${line.text}-${index}`} line={line} width={width} />
      ))}
      {Array.from({ length: blanks }, (_, index) => (
        <Text key={`role-config-fill-${index}`} backgroundColor={TUI_THEME.surface}>
          {" ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

export function roleConfigurationDisplayLines(
  input: Omit<RoleConfigurationViewProps, "height" | "terminalWidth">,
  width: number
): RoleConfigurationDisplayLine[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const lines: RoleConfigurationDisplayLine[] = [
    { text: "Role & model control", tone: "heading" },
    {
      text: `scope · ${roleConfigurationScopeLabel(input.scope)}`,
      tone: input.scope === "task" && !input.hasActiveTask ? "warning" : "accent"
    }
  ];

  if (input.loading || !input.snapshot || !input.draft) {
    lines.push({ text: "loading role configuration...", tone: "muted" });
    return lines.map((line) => fittedRoleLine(line, safeWidth));
  }

  if (input.scope === "task" && !input.hasActiveTask) {
    lines.push({ text: "No active Task · choose next request or future requests.", tone: "warning" });
  } else {
    lines.push({
      text: roleConfigurationScopeHasOverride(input.snapshot, input.scope)
        ? "saved override · Enter updates it · X resets inheritance"
        : "inheriting defaults · Enter saves this matrix",
      tone: roleConfigurationScopeHasOverride(input.snapshot, input.scope) ? "success" : "muted"
    });
  }
  lines.push({ text: "", tone: "text" });

  for (const [index, role] of CONFIGURABLE_ROLES.entries()) {
    const target = input.draft[role];
    const provider = input.snapshot.providers.find((candidate) => candidate.id === target.engine);
    const remote = provider?.modelProvider.trim();
    const model = target.model.trim() || provider?.model.trim() || "default";
    const prefix = index === input.selectedRoleIndex ? ">" : " ";
    const roleLabel = `${role[0]?.toUpperCase() ?? ""}${role.slice(1)}`.padEnd(7, " ");
    lines.push({
      text: `${prefix} ${roleLabel} ${target.engine} · ${[remote, model].filter(Boolean).join("/")}`,
      tone: index === input.selectedRoleIndex ? "accent" : "text",
      selected: index === input.selectedRoleIndex
    });
  }

  lines.push({ text: "", tone: "text" });
  const active = input.snapshot.activeTurn;
  if (active) {
    lines.push({
      text: `active turn · ${CONFIGURABLE_ROLES.map((role) => `${role}/${active[role].engine}/${active[role].model || "default"}`).join(" · ")}`,
      tone: "muted"
    });
  }
  if (input.saving) {
    lines.push({ text: "saving role configuration...", tone: "warning" });
  } else if (input.error?.trim()) {
    lines.push({ text: `error · ${input.error.trim()}`, tone: "danger" });
  } else if (input.notice?.trim()) {
    lines.push({ text: input.notice.trim(), tone: "success" });
  }

  return lines.map((line) => fittedRoleLine(line, safeWidth));
}

function RoleConfigurationRow({ line, width }: { line: RoleConfigurationDisplayLine; width: number }) {
  const text = compactEndByDisplayWidth(line.text, width);
  const trailing = Math.max(0, width - displayWidth(text));
  const theme = roleConfigurationLineTheme(line.tone, line.selected);
  return (
    <Text>
      <Text {...theme}>{text}</Text>
      {trailing > 0 ? <Text backgroundColor={theme.backgroundColor}>{" ".repeat(trailing)}</Text> : null}
    </Text>
  );
}

export function roleConfigurationLineTheme(
  tone: RoleConfigurationLineTone,
  selected = false
): Pick<TextProps, "backgroundColor" | "bold" | "color"> {
  return {
    backgroundColor: selected ? TUI_THEME.rail : TUI_THEME.surface,
    color: tone === "heading" || tone === "accent"
      ? TUI_THEME.accent
      : tone === "success"
        ? TUI_THEME.success
        : tone === "warning"
          ? TUI_THEME.warning
          : tone === "danger"
            ? TUI_THEME.danger
            : tone === "muted"
              ? TUI_THEME.muted
              : TUI_THEME.text,
    ...(tone === "heading" || tone === "danger" || selected ? { bold: true } : {})
  };
}

function fittedRoleLine(line: RoleConfigurationDisplayLine, width: number): RoleConfigurationDisplayLine {
  return { ...line, text: compactEndByDisplayWidth(line.text, width) };
}
