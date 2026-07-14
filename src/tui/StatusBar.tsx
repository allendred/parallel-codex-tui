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
  hideLabel?: boolean;
}

export type StatusTone = "idle" | "run" | "done" | "fail" | "wait";
type StatusSegmentTheme = Pick<TextProps, "backgroundColor" | "bold" | "color">;

interface ResolvedStatusBar {
  segments: Segment[];
  compact: boolean;
}

export function StatusBar({ text, terminalWidth: providedTerminalWidth, showTask = false, fillRail: providedFillRail }: StatusBarProps) {
  const terminalWidth = providedTerminalWidth ?? process.stdout.columns ?? 120;
  const fillRail = providedFillRail ?? (providedTerminalWidth !== undefined || typeof process.stdout.columns === "number");
  const { segments: fittedSegments, compact } = resolveStatusBar(text, terminalWidth, showTask);
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

export function statusBarDisplayText(text: string, terminalWidth: number, showTask = false): string {
  const resolved = resolveStatusBar(text, terminalWidth, showTask);
  if (isIdleStatus(resolved.segments)) {
    return "";
  }
  return resolved.segments.map((segment, index) => {
    const display = statusSegmentDisplay(segment, resolved.compact);
    return `${display.label}${display.separator}${display.value}${
      index < resolved.segments.length - 1 ? statusSegmentSeparator(resolved.compact) : ""
    }`;
  }).join("");
}

function resolveStatusBar(text: string, terminalWidth: number, showTask: boolean): ResolvedStatusBar {
  const parsedSegments = parseStatusText(text, { hideTask: !showTask || terminalWidth < 40 });
  if (isIdleStatus(parsedSegments)) {
    return { segments: parsedSegments, compact: false };
  }

  const baseSegments = omitTinyCurrentSegment(
    readableCompletedSegments(parsedSegments, terminalWidth),
    terminalWidth
  );
  const segments = fitCompletedMainIdentityBesideRoute(baseSegments, terminalWidth);
  const compact = !segments.some((segment) => segment.hideLabel)
    && shouldUseCompactStatus(segments, terminalWidth);
  const fittedSegments = fitStatusSegments(segments, terminalWidth, compact);
  return { segments: fittedSegments, compact };
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
  const activeCurrent = segments.find((segment) => (
    segment.label.toLowerCase() === "current"
    && (segment.tone === "run" || segment.tone === "wait" || segment.tone === "fail")
    && workerIdentityStatus(segment.value)?.role === "main"
  ));
  if (activeCurrent) {
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

function readableCompletedSegments(segments: Segment[], terminalWidth: number): Segment[] {
  if (terminalWidth < 35) {
    return segments;
  }
  const workersIndex = segments.findIndex((segment) => segment.label.toLowerCase() === "workers");
  const doneIndex = segments.findIndex((segment) => (
    segment.label.toLowerCase() === "done" && segment.tone === "done"
  ));
  const routeIndex = segments.findIndex((segment) => (
    segment.label.toLowerCase() === "route"
    && !segment.tone
    && /^(?:simple|complex)(?:\s+·\s+|$)/i.test(segment.value)
  ));
  const completed = workersIndex >= 0
    && doneIndex >= 0
    && segments[workersIndex]?.value === segments[doneIndex]?.value;
  if (!completed) {
    return segments;
  }

  const readable = segments.map((segment, index) => (
    index === doneIndex
      ? { ...segment, value: "done", hideLabel: true }
      : index === routeIndex && terminalWidth < 56
        ? { ...segment, hideLabel: true }
        : segment
  ));
  return statusSegmentsWidth(readable, false) <= Math.max(1, terminalWidth - 2)
    ? readable
    : segments;
}

function fitCompletedMainIdentityBesideRoute(segments: Segment[], terminalWidth: number): Segment[] {
  if (terminalWidth < 56 || segments.length !== 2) {
    return segments;
  }
  const currentIndex = segments.findIndex((segment) => segment.label.toLowerCase() === "current");
  const routeIndex = segments.findIndex((segment) => segment.label.toLowerCase() === "route");
  if (currentIndex < 0 || routeIndex < 0 || statusSegmentsWidth(segments, false) <= terminalWidth - 2) {
    return segments;
  }
  const current = segments[currentIndex];
  const identity = current ? workerIdentityStatus(current.value) : null;
  if (
    !current
    || identity?.role !== "main"
    || current.tone === "run"
    || current.tone === "wait"
    || current.tone === "fail"
  ) {
    return segments;
  }

  const route = segments[routeIndex];
  if (!route) {
    return segments;
  }
  const contentWidth = Math.max(1, terminalWidth - 2);
  const currentValueWidth = Math.max(
    1,
    contentWidth
      - statusSegmentsWidth([route], false)
      - displayWidth(statusSegmentSeparator(false))
      - displayWidth("@ ")
  );
  const value = compactCurrentStatusValue(current.value, currentValueWidth);
  const fitted = segments.map((segment, index) => (
    index === currentIndex ? { ...segment, value } : segment
  ));
  return statusSegmentsWidth(fitted, false) <= contentWidth ? fitted : segments;
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
  const semanticSegments = segments.map((segment) => fitAtomicStatusSegment(segment, contentWidth, compact));
  if (statusSegmentsWidth(semanticSegments, compact) <= contentWidth) {
    return semanticSegments;
  }

  const activeMainPair = fitActiveMainWithCompletedRoute(semanticSegments, contentWidth, compact);
  if (activeMainPair) {
    return activeMainPair;
  }

  const displays = semanticSegments.map((segment) => statusSegmentDisplay(segment, compact));
  const totalWidth = statusSegmentsDisplayWidth(displays, compact);
  const currentIndex = semanticSegments.map((segment) => segment.label.toLowerCase()).lastIndexOf("current");
  if (currentIndex >= 0) {
    const currentDisplay = displays[currentIndex];
    if (currentDisplay) {
      const overflow = totalWidth - contentWidth;
      const nextValueWidth = Math.max(1, displayWidth(currentDisplay.value) - overflow);
      const currentRole = workerIdentityRole(semanticSegments[currentIndex]?.value ?? "");
      if (currentRole && displayWidth(currentRole) > nextValueWidth) {
        return selectStatusSegmentsThatFit(
          semanticSegments.filter((_, index) => index !== currentIndex),
          contentWidth,
          compact
        );
      }
      const fitted = semanticSegments.map((segment, index) =>
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

  return selectStatusSegmentsThatFit(semanticSegments, contentWidth, compact);
}

function fitActiveMainWithCompletedRoute(
  segments: Segment[],
  contentWidth: number,
  compact: boolean
): Segment[] | null {
  if (segments.length !== 2) {
    return null;
  }
  const currentIndex = segments.findIndex((segment) => segment.label.toLowerCase() === "current");
  const routeIndex = segments.findIndex((segment) => segment.label.toLowerCase() === "route");
  const current = segments[currentIndex];
  const route = segments[routeIndex];
  if (
    currentIndex < 0
    || routeIndex < 0
    || !current
    || !route
    || (current.tone !== "run" && current.tone !== "wait" && current.tone !== "fail")
    || !/^(?:simple|complex)(?:\s+·\s+|$)/i.test(route.value)
    || workerIdentityStatus(current.value)?.role !== "main"
  ) {
    return null;
  }

  const currentDisplay = statusSegmentDisplay(current, compact);
  const currentValueWidth = Math.max(
    1,
    contentWidth - displayWidth(`${currentDisplay.label}${currentDisplay.separator}`)
  );
  const fittedCurrent = {
    ...current,
    value: compactActiveMainStatusValue(current.value, currentValueWidth)
  };
  if (statusSegmentsWidth([fittedCurrent], compact) > contentWidth) {
    return null;
  }

  const remaining = contentWidth
    - statusSegmentsWidth([fittedCurrent], compact)
    - displayWidth(statusSegmentSeparator(compact));
  const fittedRoute = fitCompletedRouteSegment(route, remaining, compact);
  if (!fittedRoute) {
    return [fittedCurrent];
  }
  const pair = segments.map((segment, index) => (
    index === currentIndex ? fittedCurrent : fittedRoute
  ));
  return statusSegmentsWidth(pair, compact) <= contentWidth ? pair : [fittedCurrent];
}

function fitCompletedRouteSegment(segment: Segment, maxWidth: number, compact: boolean): Segment | null {
  if (maxWidth <= 0) {
    return null;
  }
  const display = statusSegmentDisplay(segment, compact);
  const valueWidth = maxWidth - displayWidth(`${display.label}${display.separator}`);
  if (valueWidth < 1) {
    return null;
  }
  const value = compactCompletedRouteStatusValue(segment.value, valueWidth);
  return value ? { ...segment, value } : null;
}

function compactCompletedRouteStatusValue(value: string, maxWidth: number): string | null {
  const parts = value.split(/\s+·\s+/).map((part) => part.trim()).filter(Boolean);
  const mode = /^(?:simple|complex)$/i.test(parts[0] ?? "") ? parts[0] : null;
  const duration = parts.find((part) => /^\d+(?:\.\d+)?(?:ms|s|m)(?:\s+total)?$/i.test(part));
  const compactFailure = compactRouteStatusValue(value, true);
  const exceptional = /(?:^|\s·\s)(?:fallback|forced)(?:\s·\s|$)/i.test(value);
  const candidates = [
    value,
    ...(mode && exceptional && compactFailure !== value
      ? [`${mode} · ${compactFailure}${duration ? ` · ${duration}` : ""}`]
      : []),
    ...(mode && duration ? [`${mode} · ${duration}`] : []),
    ...(mode ? [mode] : []),
    ...(compactFailure !== value ? [compactFailure] : []),
    ...(duration ? [duration] : [])
  ];
  return candidates.find((candidate) => displayWidth(candidate) <= maxWidth) ?? null;
}

function compactActiveMainStatusValue(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  const identity = workerIdentityStatus(text);
  if (!identity) {
    return compactCurrentStatusValue(text, maxWidth);
  }
  const fullIdentity = `${identity.role}/${identity.engine}`;
  const detail = text.slice(fullIdentity.length).trim();
  const progress = detail.match(/^(waiting output|responding)\s+·\s+(\d+(?:\.\d+)?s)\s*\/\s*(\d+(?:\.\d+)?(?:ms|s|m))\s+(?:first|idle)$/i);
  const rawAlias = /^(starting|stopping|run|done|fail|failed|idle)\b/i.exec(detail)?.[1]?.toLowerCase();
  const alias = progress?.[1]?.toLowerCase() === "responding"
    ? "reply"
    : progress
      ? "wait"
      : rawAlias === "starting"
        ? "start"
        : rawAlias === "stopping"
          ? "stop"
          : rawAlias === "failed"
            ? "fail"
            : rawAlias;
  const elapsedBudget = progress ? `${progress[2]}/${progress[3]}` : null;
  const role = workerIdentityRole(text);
  const candidates = [
    ...(alias && elapsedBudget ? [
      `${fullIdentity} ${alias} ${elapsedBudget}`,
      `${identity.engine} ${alias} ${elapsedBudget}`
    ] : []),
    ...(alias ? [
      `${fullIdentity} ${alias}`,
      `${identity.engine} ${alias}`
    ] : []),
    fullIdentity,
    identity.engine,
    ...(role ? [role] : [])
  ];
  return candidates.find((candidate) => displayWidth(candidate) <= maxWidth)
    ?? compactStatusTextEnd(text, maxWidth);
}

function fitAtomicStatusSegment(segment: Segment, contentWidth: number, compact: boolean): Segment {
  if (segment.label.toLowerCase() !== "route" || segment.tone !== "wait") {
    return segment;
  }
  const display = statusSegmentDisplay(segment, compact);
  const valueWidth = Math.max(1, contentWidth - displayWidth(`${display.label}${display.separator}`));
  if (displayWidth(display.value) <= valueWidth) {
    return segment;
  }
  return {
    ...segment,
    value: compactRouteStatusValueToWidth(segment.value, valueWidth)
  };
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
  const identity = workerIdentityStatus(text);
  if (identity) {
    const fullIdentity = `${identity.role}/${identity.engine}`;
    if (displayWidth(fullIdentity) <= maxLength) {
      return fullIdentity;
    }
    if (displayWidth(identity.engine) <= maxLength) {
      return identity.engine;
    }
  }
  const role = workerIdentityRole(text);
  if (role && displayWidth(role) <= maxLength) {
    return role;
  }
  return compactStatusTextEnd(text, maxLength);
}

function workerIdentityRole(text: string): string | null {
  const identity = workerIdentityStatus(text);
  if (!identity) {
    return null;
  }
  return displayRoleStatusLabel(identity.role);
}

function workerIdentityStatus(text: string): { role: string; engine: string } | null {
  const match = text.trim().match(/^(main|judge|actor|critic)\/([^\s]+)(?:\s+.*)?$/i);
  if (!match) {
    return null;
  }
  return {
    role: (match[1] ?? "").toLowerCase(),
    engine: match[2] ?? ""
  };
}

function statusSegmentDisplay(segment: Segment, compact: boolean): { label: string; separator: string; value: string } {
  if (segment.hideLabel) {
    return { label: "", separator: "", value: segment.value };
  }
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
    const identity = workerIdentityStatus(segment.value);
    return {
      label: "@",
      separator: " ",
      value: identity?.role === "main"
        ? segment.value
        : workerIdentityRole(segment.value) ?? segment.value
    };
  }
  if (segment.tone && segment.tone !== "idle") {
    return { label: compactToneLabel(segment.tone), separator: "", value: segment.value };
  }
  return { label, separator: " ", value: segment.value };
}

function compactRouteStatusValue(value: string, compact: boolean): string {
  if (compact && /(?:^|\s·\s)fallback(?:\s·\s|$)/i.test(value)) {
    const cause = value
      .split(/\s+·\s+/)
      .find((part) => /^(?:(?:idle|total) timeout(?: waiting output| after (?:stdout|stderr|output))?|first output timeout|timeout(?: via proxy| waiting output| after (?:stdout|stderr|output))?|proxy|auth|rate limit|network|unavailable|invalid output|exit)$/i.test(part));
    if (cause) {
      return cause.toLowerCase() === "invalid output" ? "invalid" : cause.toLowerCase();
    }
    return "fallback";
  }
  return value;
}

function compactRouteStatusValueToWidth(value: string, maxWidth: number): string {
  const compact = compactRouteStatusValue(value, true);
  const parts = value.split(/\s+·\s+/).map((part) => part.trim()).filter(Boolean);
  const duration = parts.find((part) => /^\d+(?:\.\d+)?(?:ms|s|m)(?:\s+(?:max|total|first|idle))?$/i.test(part))
    ?.replace(/\s+(?:max|total|first|idle)$/i, "");
  const progress = parts
    .map((part) => part.match(/^(\d+(?:\.\d+)?s)\s*\/\s*(\d+(?:\.\d+)?(?:ms|s|m))(?:\s+(first|total))?$/i))
    .find((match): match is RegExpMatchArray => match !== null);
  const elapsed = progress?.[1];
  const compactProgress = progress
    ? `${elapsed?.replace(/s$/i, "")}/${progress[2]}`
    : undefined;
  const progressCandidates = compactProgress
    ? [compactProgress, elapsed].filter((item): item is string => Boolean(item))
    : duration ? [duration] : [];
  const first = parts[0]?.toLowerCase() ?? "";
  const retry = first.match(/^retry\s+(\d+\/\d+)$/);
  let candidates: string[];

  if (retry) {
    candidates = [compact, `retry ${retry[1]}`, retry[1] ?? "retry", "retry"];
  } else if (first === "checking") {
    candidates = [compact, progressCandidates[0] ? `check ${progressCandidates[0]}` : "check", ...progressCandidates, "wait"];
  } else if (first === "follow-up") {
    candidates = [compact, progressCandidates[0] ? `follow ${progressCandidates[0]}` : "follow", ...progressCandidates, "wait"];
  } else if (routeProgressStatusAlias(first)) {
    const alias = routeProgressStatusAlias(first)!;
    const firstOutputProgress = progress?.[3]?.toLowerCase() === "first";
    candidates = [
      compact,
      ...(compactProgress ? [`${alias} ${compactProgress}`] : []),
      ...(firstOutputProgress && compactProgress ? [compactProgress] : []),
      ...(elapsed ? [`${alias} ${elapsed}`] : []),
      alias,
      ...progressCandidates,
      "wait"
    ];
  } else if (/(?:^|\s·\s)fallback(?:\s·\s|$)/i.test(value)) {
    candidates = [compact, ...compactRouteFailureAliases(compact), "wait"];
  } else {
    candidates = [compact, first, "route"];
  }

  return candidates.find((candidate) => displayWidth(candidate) <= maxWidth)
    ?? candidates.at(-1)
    ?? "route";
}

function compactRouteFailureAliases(value: string): string[] {
  if (value === "timeout via proxy") {
    return ["proxy", "p:to"];
  }
  if (value === "proxy") {
    return ["pxy"];
  }
  if (value === "rate limit") {
    return ["rate"];
  }
  if (value === "timeout") {
    return ["time"];
  }
  if (value === "timeout waiting output") {
    return ["wait:to", "w:to", "time"];
  }
  if (value === "timeout after stderr") {
    return ["err:to", "e:to", "time"];
  }
  if (value === "timeout after stdout") {
    return ["out:to", "o:to", "time"];
  }
  if (value === "timeout after output") {
    return ["out:to", "o:to", "time"];
  }
  if (value === "first output timeout") {
    return ["first:to", "f:to", "time"];
  }
  if (value.startsWith("idle timeout")) {
    return ["idle:to", "i:to", "time"];
  }
  if (value.startsWith("total timeout")) {
    return ["total:to", "t:to", "time"];
  }
  if (value === "network") {
    return ["net"];
  }
  if (value === "unavailable") {
    return ["down"];
  }
  if (value === "invalid") {
    return ["bad"];
  }
  if (value === "fallback") {
    return ["fall"];
  }
  return [value];
}

function routeProgressStatusAlias(value: string): string | null {
  if (value === "starting") {
    return "start";
  }
  if (value === "waiting output") {
    return "wait";
  }
  if (value === "diagnostics") {
    return "diag";
  }
  if (value === "receiving") {
    return "recv";
  }
  if (value === "parsing") {
    return "parse";
  }
  if (value === "stopping") {
    return "stop";
  }
  return null;
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
        tone: /(?:^|\s·\s)fallback(?:\s·\s|$)|^(?:checking|follow-up|starting|retry|waiting output|diagnostics|receiving|parsing|stopping)\b/i.test(value)
          ? "wait"
          : undefined
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
  const mainEngineStatus = parseMainEngineStatus(part);
  if (mainEngineStatus) {
    return mainEngineStatus;
  }
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

function parseMainEngineStatus(part: string): Segment | null {
  const match = part.match(/^main\/([^\s]+)\s+([^\s]+)\b/i);
  if (!match) {
    return null;
  }
  const status = (match[2] ?? "idle").toLowerCase();
  return {
    label: "CURRENT",
    value: part,
    tone: runtimeStatusTone(status)
  };
}

function runtimeStatusTone(status: string): StatusTone | undefined {
  if (status === "run" || status === "running" || status === "starting" || status === "responding") {
    return "run";
  }
  if (status === "done") {
    return "done";
  }
  if (status === "fail" || status === "failed" || status === "error") {
    return "fail";
  }
  if (status === "wait" || status === "waiting" || status === "queued" || status === "stopping") {
    return "wait";
  }
  if (status === "idle") {
    return "idle";
  }
  return undefined;
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
