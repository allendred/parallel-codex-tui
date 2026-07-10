import React from "react";
import { Box, Text, type TextProps } from "ink";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export interface StatusBarProps {
  text: string;
  terminalWidth?: number;
  showTask?: boolean;
  fillRail?: boolean;
}

interface Segment {
  label: string;
  value: string;
  tone?: StatusTone;
}

export type StatusTone = "idle" | "run" | "done" | "fail" | "wait";
type StatusSegmentTheme = Pick<TextProps, "backgroundColor" | "bold" | "color">;

export function StatusBar({ text, terminalWidth: providedTerminalWidth, showTask = false, fillRail: providedFillRail }: StatusBarProps) {
  const terminalWidth = providedTerminalWidth ?? process.stdout.columns ?? 120;
  const fillRail = providedFillRail ?? (providedTerminalWidth !== undefined || typeof process.stdout.columns === "number");
  const parsedSegments = parseStatusText(text, { hideTask: !showTask || terminalWidth < 40 });
  if (isIdleStatus(parsedSegments)) {
    return <IdleStatusRail terminalWidth={terminalWidth} fill={fillRail} />;
  }

  const segments = omitTinyCurrentSegment(
    parsedSegments,
    terminalWidth
  );
  const compact = shouldUseCompactStatus(segments, terminalWidth);
  const fittedSegments = fitStatusSegments(segments, terminalWidth, compact);

  if (isIdleStatus(fittedSegments)) {
    return <IdleStatusRail terminalWidth={terminalWidth} fill={fillRail} />;
  }

  const { leadingWidth, trailingWidth } = statusRailLayout(
    terminalWidth,
    statusSegmentsWidth(fittedSegments, compact),
    { fill: fillRail }
  );

  return (
    <Box>
      {leadingWidth > 0 ? <Text backgroundColor={TUI_THEME.rail}>{" ".repeat(leadingWidth)}</Text> : null}
      {fittedSegments.map((segment, index) => (
        <StatusSegment
          key={`${segment.label}-${index}`}
          segment={segment}
          compact={compact}
          isLast={index === fittedSegments.length - 1}
        />
      ))}
      {trailingWidth > 0 ? <Text backgroundColor={TUI_THEME.rail}>{" ".repeat(trailingWidth)}</Text> : null}
    </Box>
  );
}

function IdleStatusRail({ terminalWidth, fill }: { terminalWidth: number; fill: boolean }) {
  const { leadingWidth, trailingWidth } = statusRailLayout(terminalWidth, 0, { fill });
  return (
    <Box>
      <Text backgroundColor={TUI_THEME.rail}>{" ".repeat(leadingWidth + trailingWidth)}</Text>
    </Box>
  );
}

export function statusRailLayout(
  terminalWidth: number,
  contentWidth: number,
  options: { fill?: boolean } = {}
): { leadingWidth: number; trailingWidth: number } {
  const leadingWidth = terminalWidth > 1 ? 1 : 0;
  if (options.fill === false) {
    return { leadingWidth, trailingWidth: 0 };
  }

  const renderWidth = typeof process.stdout.columns === "number"
    ? Math.max(1, Math.min(terminalWidth, process.stdout.columns))
    : Math.max(1, terminalWidth);
  const barWidth = Math.max(1, renderWidth - 1);

  return {
    leadingWidth,
    trailingWidth: Math.max(0, barWidth - leadingWidth - Math.max(0, contentWidth))
  };
}

function omitTinyCurrentSegment(segments: Segment[], terminalWidth: number): Segment[] {
  if (terminalWidth >= 24 || segments.length <= 1) {
    return segments;
  }
  const compacted = segments.filter((segment) => segment.label.toLowerCase() !== "current");
  return compacted.length > 0 ? compacted : segments;
}

function shouldUseCompactStatus(segments: Segment[], terminalWidth: number): boolean {
  if (terminalWidth < 56) {
    return true;
  }
  const roomyDisplays = segments.map((segment) => statusSegmentDisplay(segment, false));
  return statusSegmentsDisplayWidth(roomyDisplays, false) > Math.max(1, terminalWidth - 2);
}

function isIdleStatus(segments: Segment[]): boolean {
  return segments.length === 1 && segments[0]?.tone === "idle" && segments[0]?.value === "idle";
}

function StatusSegment({ segment, compact, isLast }: { segment: Segment; compact: boolean; isLast: boolean }) {
  const display = statusSegmentDisplay(segment, compact);

  return (
    <Box flexShrink={0}>
      {display.label ? (
        <>
          <Text
            {...statusSegmentLabelTheme(segment.tone)}
          >
            {display.label}
          </Text>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{display.separator}</Text>
        </>
      ) : null}
      <Text
        {...statusSegmentValueTheme(segment.tone)}
        wrap="truncate-end"
      >
        {display.value}
      </Text>
      {!isLast ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{statusSegmentSeparator(compact)}</Text> : null}
    </Box>
  );
}

function fitStatusSegments(segments: Segment[], terminalWidth: number, compact: boolean): Segment[] {
  const contentWidth = Math.max(1, terminalWidth - 2);
  if (statusSegmentsWidth(segments, compact) <= contentWidth) {
    return segments;
  }

  const displays = segments.map((segment) => statusSegmentDisplay(segment, compact));
  const totalWidth = statusSegmentsDisplayWidth(displays, compact);
  const currentIndex = segments.map((segment) => segment.label.toLowerCase()).lastIndexOf("current");
  if (currentIndex >= 0) {
    const currentDisplay = displays[currentIndex];
    if (currentDisplay) {
      const overflow = totalWidth - contentWidth;
      const nextValueWidth = Math.max(1, displayWidth(currentDisplay.value) - overflow);
      const fitted = segments.map((segment, index) =>
        index === currentIndex
          ? { ...segment, value: compactCurrentStatusValue(segment.value, nextValueWidth) }
          : segment
      );
      if (statusSegmentsWidth(fitted, compact) <= contentWidth) {
        return fitted;
      }
      return selectStatusSegmentsThatFit(fitted, contentWidth, compact);
    }
  }

  return selectStatusSegmentsThatFit(segments, contentWidth, compact);
}

function statusSegmentsDisplayWidth(displays: Array<{ label: string; separator: string; value: string }>, compact: boolean): number {
  const segmentWidths = displays.map((display) => displayWidth(`${display.label}${display.separator}${display.value}`));
  return segmentWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, displays.length - 1) * displayWidth(statusSegmentSeparator(compact));
}

function statusSegmentsWidth(segments: Segment[], compact: boolean): number {
  return statusSegmentsDisplayWidth(segments.map((segment) => statusSegmentDisplay(segment, compact)), compact);
}

function selectStatusSegmentsThatFit(segments: Segment[], contentWidth: number, compact: boolean): Segment[] {
  const selected: Array<{ index: number; segment: Segment }> = [];
  const candidates = segments
    .map((segment, index) => ({ index, segment }))
    .sort((left, right) => statusSegmentKeepPriority(left.segment) - statusSegmentKeepPriority(right.segment));

  for (const candidate of candidates) {
    const next = [...selected, candidate].sort((left, right) => left.index - right.index).map((item) => item.segment);
    if (statusSegmentsWidth(next, compact) <= contentWidth) {
      selected.push(candidate);
    }
  }

  if (selected.length > 0) {
    return selected.sort((left, right) => left.index - right.index).map((item) => item.segment);
  }

  return [compactSingleStatusSegment(segments[0] ?? { label: "STATUS", value: "idle", tone: "idle" }, contentWidth, compact)];
}

function statusSegmentKeepPriority(segment: Segment): number {
  const label = segment.label.toLowerCase();
  if (segment.tone === "fail" || label === "fail") {
    return 0;
  }
  if (segment.tone === "run" || label === "run") {
    return 1;
  }
  if (segment.tone === "wait" || label === "wait") {
    return 2;
  }
  if (label === "workers") {
    return 3;
  }
  if (segment.tone === "done" || label === "done") {
    return 4;
  }
  if (label === "current") {
    return 5;
  }
  if (label === "route") {
    return 7;
  }
  return 6;
}

function compactSingleStatusSegment(segment: Segment, contentWidth: number, compact: boolean): Segment {
  const display = statusSegmentDisplay(segment, compact);
  const labelWidth = displayWidth(`${display.label}${display.separator}`);
  return {
    ...segment,
    value: compactStatusTextEnd(display.value, Math.max(1, contentWidth - labelWidth))
  };
}

function statusSegmentSeparator(compact: boolean): string {
  return compact ? " " : " · ";
}

function compactStatusTextEnd(text: string, maxLength: number): string {
  return compactEndByDisplayWidth(text, maxLength);
}

function compactCurrentStatusValue(text: string, maxLength: number): string {
  if (displayWidth(text) <= maxLength) {
    return text;
  }
  const role = workerIdentityRole(text);
  if (role && displayWidth(role) <= maxLength) {
    return role;
  }
  return compactStatusTextEnd(text, maxLength);
}

function workerIdentityRole(text: string): string | null {
  const match = text.trim().match(/^(main|judge|actor|critic)\/.+$/i);
  if (!match) {
    return null;
  }
  return displayRoleStatusLabel((match[1] ?? "").toLowerCase());
}

function statusSegmentDisplay(segment: Segment, compact: boolean): { label: string; separator: string; value: string } {
  const label = segment.label.toLowerCase();
  if (label === "task") {
    return { label: "", separator: "", value: segment.value };
  }
  if (isRoleStatusLabel(label)) {
    return {
      label: compact ? compactRoleStatusLabel(label) : displayRoleStatusLabel(label),
      separator: compact ? ":" : " ",
      value: segment.value
    };
  }
  if (label === "route") {
    return {
      label: compact ? "r" : "route",
      separator: compact ? ":" : " ",
      value: compactRouteStatusValue(segment.value, compact)
    };
  }
  if (label === "wave") {
    return {
      label: "wave",
      separator: " ",
      value: compact ? compactWaveStatusValue(segment.value) : segment.value
    };
  }
  if (!compact) {
    if (label === "current") {
      return { label: "@", separator: " ", value: segment.value };
    }
    if (label === "workers") {
      return { label: "", separator: "", value: workerCountDisplay(segment.value) };
    }
    if (segment.tone && segment.tone !== "idle" && label === segment.tone) {
      return { label: "", separator: "", value: statusCountDisplay(segment.tone, segment.value) };
    }
    if (segment.tone && segment.tone !== "idle") {
      return { label: segment.tone, separator: " ", value: segment.value };
    }
    return { label, separator: " ", value: segment.value };
  }
  if (label === "workers") {
    return { label: "w", separator: "", value: segment.value };
  }
  if (label === "current") {
    return { label: "@", separator: " ", value: workerIdentityRole(segment.value) ?? segment.value };
  }
  if (segment.tone && segment.tone !== "idle") {
    return { label: compactToneLabel(segment.tone), separator: "", value: segment.value };
  }
  return { label, separator: " ", value: segment.value };
}

function compactRouteStatusValue(value: string, compact: boolean): string {
  if (compact && /(?:^|\s·\s)fallback(?:\s·\s|$)/i.test(value)) {
    return "fallback";
  }
  return value;
}

function compactWaveStatusValue(value: string): string {
  return value
    .replace(/\s+·\s+actor\s+/i, " a")
    .replace(/\s+·\s+critic\s+/i, " c")
    .replace(/\s+·\s+revision\s+/i, " r")
    .replace(/\s+·\s+integration\s+/i, " i")
    .replace(/\s+·\s+verification\s+/i, " v");
}

function compactToneLabel(tone: Exclude<StatusTone, "idle">): string {
  if (tone === "run") {
    return "r";
  }
  if (tone === "done") {
    return "d";
  }
  if (tone === "fail") {
    return "f";
  }
  return "w";
}

function workerCountDisplay(value: string): string {
  return `${value} ${value === "1" ? "worker" : "workers"}`;
}

function statusCountDisplay(tone: Exclude<StatusTone, "idle">, value: string): string {
  if (tone === "run") {
    return `${value} running`;
  }
  if (tone === "fail") {
    return `${value} failed`;
  }
  if (tone === "wait") {
    return `${value} waiting`;
  }
  return `${value} done`;
}

function isRoleStatusLabel(label: string): boolean {
  return label === "main" || label === "judge" || label === "actor" || label === "critic";
}

function displayRoleStatusLabel(label: string): string {
  return label === "main" ? "chat" : label;
}

function compactRoleStatusLabel(label: string): string {
  if (label === "main") {
    return "chat";
  }
  return label.slice(0, 1);
}

function parseStatusText(text: string, options: { hideTask?: boolean } = {}): Segment[] {
  const parts = text
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return [{ label: "STATUS", value: "idle", tone: "idle" }];
  }

  if (parts.length === 1 && parts[0] === "idle") {
    return [{ label: "STATUS", value: "idle", tone: "idle" }];
  }

  const segments: Segment[] = [];
  const [first = "idle", ...rest] = parts;
  const statusParts = isStatusPart(first) ? parts : rest;

  if (!isStatusPart(first) && !options.hideTask) {
    segments.push({ label: "TASK", value: first, tone: first === "idle" ? "idle" : undefined });
  }

  for (const part of statusParts) {
    const wave = parseWaveProgress(part);
    if (wave) {
      segments.push(wave);
      continue;
    }

    const workerMatch = part.match(/^workers\s+(\d+)$/i);
    if (workerMatch) {
      segments.push({ label: "WORKERS", value: workerMatch[1] ?? "0" });
      continue;
    }

    const routeMatch = part.match(/^route\s+(.+)$/i);
    if (routeMatch) {
      const value = routeMatch[1]?.trim() || "unknown";
      segments.push({
        label: "ROUTE",
        value,
        tone: /(?:^|\s·\s)fallback(?:\s·\s|$)/i.test(value) ? "wait" : undefined
      });
      continue;
    }

    const counts = parseStateCounts(part);
    if (counts.length > 0) {
      segments.push(...counts);
      continue;
    }

    segments.push(parseCurrentStatus(part));
  }

  return segments.length > 0 ? segments : [{ label: "STATUS", value: "idle", tone: "idle" }];
}

function isStatusPart(part: string): boolean {
  return parseWaveProgress(part) !== null
    || /^workers\s+\d+$/i.test(part)
    || /^route\s+\S+/i.test(part)
    || parseStateCounts(part).length > 0;
}

function parseWaveProgress(part: string): Segment | null {
  const match = part.match(/^wave\s+(\d+\/\d+)\s+·\s+(actor|critic|revision|integration|verification)\s+(\d+\/\d+)$/i);
  if (!match) {
    return null;
  }
  return {
    label: "WAVE",
    value: `${match[1]} · ${(match[2] ?? "actor").toLowerCase()} ${match[3]}`,
    tone: "run"
  };
}

function parseStateCounts(part: string): Segment[] {
  const matches = Array.from(part.matchAll(/\b(run|done|fail|wait|idle)\s+(\d+)\b/gi));
  if (matches.length === 0) {
    return [];
  }
  return matches.map((match) => {
    const tone = normalizeTone(match[1] ?? "idle");
    return {
      label: tone.toUpperCase(),
      value: match[2] ?? "0",
      tone
    };
  });
}

function parseCurrentStatus(part: string): Segment {
  const roleStatus = parseRoleStatus(part);
  if (roleStatus) {
    return roleStatus;
  }

  const toneMatch = part.match(/\b(run|done|fail|wait|idle)\b/i);
  const tone = toneMatch ? normalizeTone(toneMatch[1] ?? "idle") : undefined;
  const value = toneMatch ? part.replace(toneMatch[0], "").trim() || part : part;
  return {
    label: "CURRENT",
    value,
    tone
  };
}

function parseRoleStatus(part: string): Segment | null {
  const match = part.match(/^(main|judge|actor|critic)\s+(run|done|fail|wait|idle)\b/i);
  if (!match) {
    return null;
  }
  const tone = normalizeTone(match[2] ?? "idle");
  return {
    label: (match[1] ?? "main").toUpperCase(),
    value: tone,
    tone
  };
}

function normalizeTone(value: string): StatusTone {
  const normalized = value.toLowerCase();
  if (normalized === "run" || normalized === "done" || normalized === "fail" || normalized === "wait") {
    return normalized;
  }
  return "idle";
}

export function statusSegmentLabelTheme(_tone?: StatusTone): StatusSegmentTheme {
  return {
    backgroundColor: TUI_THEME.rail,
    color: TUI_THEME.muted
  };
}

export function statusSegmentValueTheme(tone?: StatusTone): StatusSegmentTheme {
  return {
    backgroundColor: TUI_THEME.rail,
    color: valueColorForTone(tone),
    ...(tone === "run" || tone === "fail" ? { bold: true } : {})
  };
}

function colorForTone(tone: StatusTone | undefined): TextProps["color"] {
  if (tone === "run") {
    return TUI_THEME.accent;
  }
  if (tone === "done") {
    return TUI_THEME.success;
  }
  if (tone === "fail") {
    return TUI_THEME.danger;
  }
  if (tone === "wait") {
    return TUI_THEME.warning;
  }
  return TUI_THEME.muted;
}

function valueColorForTone(tone: StatusTone | undefined): TextProps["color"] {
  if (tone === "run" || tone === "done" || tone === "fail" || tone === "wait") {
    return colorForTone(tone);
  }
  return TUI_THEME.text;
}
