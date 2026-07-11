import React from "react";
import { Box, Text } from "ink";
import { compactEndByDisplayWidth, compactTailByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export interface InputBarProps {
  mode: "chat" | "worker" | "worker-search" | "workers" | "collaboration" | "native" | "router" | "sessions";
  ready?: boolean;
  busy?: boolean;
  routeFallback?: boolean;
  canRetry?: boolean;
  hasWorkers?: boolean;
  hasActiveTask?: boolean;
  chatScrollOffset?: number;
  chatMaxScrollOffset?: number;
  nativeClosed?: boolean;
  searchMatchIndex?: number;
  searchMatchCount?: number;
  value: string;
  cursor?: number;
  terminalWidth?: number;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export function InputBar({
  mode,
  ready = true,
  busy = false,
  routeFallback = false,
  canRetry = false,
  hasWorkers = false,
  hasActiveTask = false,
  chatScrollOffset = 0,
  chatMaxScrollOffset = 0,
  nativeClosed = false,
  searchMatchIndex = 0,
  searchMatchCount = 0,
  value,
  cursor,
  terminalWidth: providedTerminalWidth,
  onChange,
  onSubmit
}: InputBarProps) {
  const terminalWidth = providedTerminalWidth ?? process.stdout.columns ?? 120;
  const fillRail = providedTerminalWidth !== undefined || typeof process.stdout.columns === "number";

  if (mode === "worker-search") {
    const suffix = workerSearchInputSuffix(terminalWidth, searchMatchIndex, searchMatchCount);
    const prefix = terminalWidth < 4 ? "/" : "/ ";
    const textBudget = Math.max(1, terminalWidth - (terminalWidth > 1 ? 2 : 0));
    const valueWidth = Math.max(1, textBudget - displayWidth(prefix) - 1 - displayWidth(suffix));
    const display = chatInputDisplayParts(value, cursor ?? Array.from(value).length, valueWidth + 6);
    const textWidth = displayWidth(`${prefix}${display.before}|${display.after}${suffix}`);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={textWidth} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{prefix}</Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.before}</Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>|</Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.after}</Text>
        {suffix ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{suffix}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "sessions") {
    const hints = taskSessionsInputHints(terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "collaboration") {
    const hints = collaborationTimelineInputHints(terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "workers") {
    const hints = workerOverviewInputHints(terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "worker") {
    const hints = workerInputHints(terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "native") {
    const hints = nativeInputHints(terminalWidth, nativeClosed);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "router") {
    const hints = routerInputHints(terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (!ready) {
    const starting = chatStartingDisplayValue(terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(starting)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{starting}</Text>
      </InputRail>
    );
  }

  if (routeFallback) {
    const hints = routeFallbackInputHints(terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.warning} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  const busyText = chatBusyDisplayValue(terminalWidth);
  const prompt = busy ? "run" : ">";

  if (busy) {
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(busyText ? `${prompt} ${busyText}` : prompt)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.warning} bold>{prompt}</Text>
        {busyText ? (
          <>
            <Text backgroundColor={TUI_THEME.rail}> </Text>
            <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.warning}>{busyText}</Text>
          </>
        ) : null}
      </InputRail>
    );
  }

  if (value) {
    const display = chatInputDisplayParts(value, cursor ?? Array.from(value).length, terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${prompt} ${display.before}|${display.after}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{prompt}</Text>
        <Text backgroundColor={TUI_THEME.rail}> </Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.before}</Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>|</Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.after}</Text>
      </InputRail>
    );
  }

  const hasLeadingPromptSpace = terminalWidth >= 10;
  const placeholder = chatPlaceholderDisplayText(
    terminalWidth,
    {
      hasWorkers,
      hasActiveTask,
      canRetry,
      scrollOffset: chatScrollOffset,
      maxScrollOffset: chatMaxScrollOffset
    },
    { leadingSpace: hasLeadingPromptSpace }
  );

  return (
    <InputRail
      terminalWidth={terminalWidth}
      textWidth={displayWidth(`${prompt}${hasLeadingPromptSpace ? " " : ""}|${placeholder}`)}
      fill={fillRail}
    >
      <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{prompt}</Text>
      {hasLeadingPromptSpace ? <Text backgroundColor={TUI_THEME.rail}> </Text> : null}
      <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>|</Text>
      <Text backgroundColor={TUI_THEME.rail} color={canRetry ? TUI_THEME.warning : TUI_THEME.muted}>{placeholder}</Text>
    </InputRail>
  );
}

function InputRail({
  fill,
  terminalWidth,
  textWidth,
  children
}: {
  fill: boolean;
  terminalWidth: number;
  textWidth: number;
  children: React.ReactNode;
}) {
  const { leadingWidth, trailingWidth } = inputRailLayout(terminalWidth, textWidth, { fill });

  return (
    <Box>
      {leadingWidth > 0 ? <Text backgroundColor={TUI_THEME.rail}>{" ".repeat(leadingWidth)}</Text> : null}
      {children}
      {trailingWidth > 0 ? <Text backgroundColor={TUI_THEME.rail}>{" ".repeat(trailingWidth)}</Text> : null}
    </Box>
  );
}

export function inputRailLayout(
  terminalWidth: number,
  textWidth: number,
  options: { fill?: boolean } = {}
): {
  leadingWidth: number;
  trailingWidth: number;
} {
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
    trailingWidth: Math.max(0, barWidth - leadingWidth - Math.max(0, textWidth))
  };
}

export function chatPlaceholderDisplayText(
  terminalWidth: number,
  options: ChatPlaceholderOptions = {},
  display: { leadingSpace?: boolean } = {}
): string {
  const placeholder = chatPlaceholderDisplayValue(terminalWidth, options);
  if (!placeholder) {
    return "";
  }
  return display.leadingSpace === false ? placeholder : ` ${placeholder}`;
}

export function chatInputDisplayValue(value: string, terminalWidth: number): string {
  const valueWidth = Math.max(1, terminalWidth - 6);
  return compactTailByDisplayWidth(chatInputVisibleValue(value), valueWidth);
}

export function chatInputDisplayParts(
  value: string,
  cursor: number,
  terminalWidth: number
): { before: string; after: string } {
  const sourceChars = Array.from(value);
  const chars = sourceChars.map(chatInputVisibleCharacter);
  const clampedCursor = Math.min(sourceChars.length, Math.max(0, Math.trunc(cursor)));
  const valueWidth = Math.max(1, terminalWidth - 6);
  if (displayWidth(chars.join("")) <= valueWidth) {
    return {
      before: chars.slice(0, clampedCursor).join(""),
      after: chars.slice(clampedCursor).join("")
    };
  }

  const beforeCursor = chars.slice(0, clampedCursor).join("");
  const afterCursor = chars.slice(clampedCursor).join("");
  if (valueWidth < 6) {
    return clampedCursor > 0
      ? { before: compactTailByDisplayWidth(beforeCursor, valueWidth), after: "" }
      : { before: "", after: compactEndByDisplayWidth(afterCursor, valueWidth) };
  }

  let start = clampedCursor;
  let end = clampedCursor;
  const renderedWidth = (nextStart: number, nextEnd: number): number => displayWidth([
    nextStart > 0 ? "..." : "",
    chars.slice(nextStart, nextEnd).join(""),
    nextEnd < chars.length ? "..." : ""
  ].join(""));

  while (true) {
    const canExpandLeft = start > 0 && renderedWidth(start - 1, end) <= valueWidth;
    const canExpandRight = end < chars.length && renderedWidth(start, end + 1) <= valueWidth;
    if (!canExpandLeft && !canExpandRight) {
      break;
    }
    if (canExpandLeft && canExpandRight) {
      const leftWidth = displayWidth(chars.slice(start, clampedCursor).join(""));
      const rightWidth = displayWidth(chars.slice(clampedCursor, end).join(""));
      if (leftWidth <= rightWidth) {
        start -= 1;
      } else {
        end += 1;
      }
    } else if (canExpandLeft) {
      start -= 1;
    } else {
      end += 1;
    }
  }

  return {
    before: `${start > 0 ? "..." : ""}${chars.slice(start, clampedCursor).join("")}`,
    after: `${chars.slice(clampedCursor, end).join("")}${end < chars.length ? "..." : ""}`
  };
}

function chatInputVisibleValue(value: string): string {
  return Array.from(value).map(chatInputVisibleCharacter).join("");
}

function chatInputVisibleCharacter(char: string): string {
  if (char === "\n" || char === "\r") {
    return "↵";
  }
  if (char === "\t") {
    return "⇥";
  }
  return char;
}

export function chatPlaceholderDisplayValue(
  terminalWidth: number,
  options: ChatPlaceholderOptions = {}
): string {
  if (options.canRetry) {
    return selectChatPlaceholder(
      terminalWidth,
      options.hasActiveTask
        ? ["message · ^R retry · ^N new", "^R retry · ^N", "^R retry", "retry"]
        : ["message · ^R retry", "^R retry", "retry"]
    );
  }
  const maxScrollOffset = Math.max(0, options.maxScrollOffset ?? 0);
  const scrollOffset = Math.min(Math.max(0, options.scrollOffset ?? 0), maxScrollOffset);
  if (scrollOffset > 0) {
    return chatHistoryPlaceholderDisplayValue(terminalWidth, scrollOffset, maxScrollOffset);
  }
  if (options.hasActiveTask && !options.hasWorkers) {
    return selectChatPlaceholder(terminalWidth, [
      "message · ^N new · ^P project · ^T tasks · ^G routes",
      "message · ^N new · ^P project · ^G routes",
      "message · ^N new · ^P project",
      "message · ^N new",
      "msg · ^N",
      "msg"
    ]);
  }
  if (options.hasWorkers) {
    return chatTaskPlaceholderDisplayValue(terminalWidth, maxScrollOffset > 0, options.hasActiveTask);
  }
  if (maxScrollOffset > 0 && terminalWidth >= 22) {
    return selectChatPlaceholder(terminalWidth, ["message · scroll", "message", "msg"]);
  }
  return selectChatPlaceholder(terminalWidth, [
    "message · ^P project · ^T tasks · ^G routes",
    "message · ^P project · ^G routes",
    "message · ^P project",
    "message",
    "msg"
  ]);
}

export interface ChatPlaceholderOptions {
  hasWorkers?: boolean;
  hasActiveTask?: boolean;
  canRetry?: boolean;
  scrollOffset?: number;
  maxScrollOffset?: number;
}

function chatHistoryPlaceholderDisplayValue(terminalWidth: number, offset: number, maxOffset: number): string {
  if (terminalWidth < 14) {
    return "back";
  }
  if (terminalWidth < 20) {
    return `back ${offset}`;
  }
  if (terminalWidth < 38) {
    return selectChatPlaceholder(terminalWidth, [
      `back ${offset}/${maxOffset} · PgDn`,
      `back ${offset}/${maxOffset}`,
      `back ${offset}`,
      "back"
    ]);
  }
  return selectChatPlaceholder(terminalWidth, [
    `message · back ${offset}/${maxOffset} · PgDn latest`,
    `back ${offset}/${maxOffset} · PgDn latest`,
    `back ${offset}/${maxOffset} · PgDn`,
    `back ${offset}/${maxOffset}`,
    `back ${offset}`,
    "back"
  ]);
}

function chatTaskPlaceholderDisplayValue(terminalWidth: number, scrollable = false, activeTask = false): string {
  if (activeTask && terminalWidth >= 72) {
    const activeCandidates = scrollable
      ? [
          "message · scroll · ^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes",
          "message · scroll · ^N new · ^W logs · ^B workers · Tab · ^O attach · ^G routes"
        ]
      : [
          "message · ^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes",
          "message · ^N new · ^W logs · ^B workers · Tab · ^O attach · ^G routes"
        ];
    const active = activeCandidates.find((candidate) => displayWidth(candidate) <= chatPlaceholderValueWidth(terminalWidth));
    if (active) {
      return active;
    }
  }
  return selectChatPlaceholder(
    terminalWidth,
    scrollable
      ? [
          "message · scroll · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes",
          "message · scroll · ^W logs · ^B workers · Tab · ^O attach · ^G routes",
          "message · scroll · ^W logs · Tab · ^O attach · ^G routes",
          "message · scroll · ^W logs · Tab · ^O attach",
          "PgUp/Dn · ^W log · Tab · ^O attach",
          "PgUp/Dn · ^W logs · Tab · ^O",
          "message · Pg · ^W · ^O",
          "msg · Pg · ^W · ^O",
          "msg · ^W · ^O",
          "msg · ^W",
          "msg"
        ]
      : [
          "message · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes",
          "message · ^W logs · ^B workers · Tab · ^O attach · ^G routes",
          "message · ^W logs · Tab · ^O attach · ^G routes",
          "message · ^W logs · Tab · ^O attach",
          "message · ^W · ^O",
          "msg · ^W · ^O",
          "msg · ^W",
          "msg"
        ]
  );
}

function selectChatPlaceholder(terminalWidth: number, candidates: string[]): string {
  const valueWidth = chatPlaceholderValueWidth(terminalWidth);
  return candidates.find((candidate) => displayWidth(candidate) <= valueWidth)
    ?? candidates.at(-1)
    ?? "";
}

function chatPlaceholderValueWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - (terminalWidth >= 10 ? 6 : 4));
}

export function chatBusyDisplayValue(terminalWidth: number): string {
  if (terminalWidth < 14) {
    return "";
  }
  if (terminalWidth < 22) {
    return "busy";
  }
  if (terminalWidth >= 34) {
    return "working · Esc stop";
  }
  return "working";
}

function routeFallbackInputHints(width: number): { label: string; detail: string } {
  if (width < 10) {
    return { label: "route", detail: "" };
  }
  if (width < 14) {
    return { label: "choose", detail: "" };
  }
  if (width < 20) {
    return { label: "1M", detail: " · 2P" };
  }
  if (width < 28) {
    return { label: "1 Main", detail: " · 2 Pair" };
  }
  if (width < 40) {
    return { label: "1 Main", detail: " · 2 Parallel" };
  }
  if (width < 54) {
    return { label: "route", detail: " · 1 Main · 2 Parallel · Esc" };
  }
  if (width < 75) {
    return { label: "route failed", detail: " · 1 Main · 2 Parallel · R · Esc" };
  }
  return { label: "route failed", detail: " · 1 Main · 2 Parallel · R retry · Esc cancel" };
}

export function chatStartingDisplayValue(terminalWidth: number): string {
  if (terminalWidth < 8) {
    return "";
  }
  return terminalWidth < 12 ? "start" : "starting";
}

function workerInputHints(width: number): { label: string; detail: string } {
  if (width < 12) {
    return { label: "log", detail: "" };
  }
  if (width < 16) {
    return { label: "log", detail: " · Esc" };
  }
  if (width < 18) {
    return { label: "log", detail: " · Pg · Esc" };
  }
  if (width < 28) {
    return { label: "logs", detail: " · Pg · Esc" };
  }
  if (width < 36) {
    return { label: "logs", detail: " · Pg · Tab · ^O · Esc" };
  }
  if (width < 40) {
    return { label: "logs", detail: " · scroll · Tab · ^O · Esc" };
  }
  if (width < 58) {
    return { label: "logs", detail: " · scroll · Tab · ^O attach · Esc" };
  }
  if (width < 72) {
    return { label: "logs", detail: " · scroll · ^F find · Tab · ^O · Esc" };
  }
  if (width < 96) {
    return { label: "logs", detail: " · scroll · ^F find · E err · D diff · Tab · ^B · ^O · Esc" };
  }
  return { label: "logs", detail: " · scroll · ^F find · E err · D diff · Tab · ^B workers · ^O attach · Esc chat" };
}

function workerOverviewInputHints(width: number): { label: string; detail: string } {
  if (width < 12) {
    return { label: "wrk", detail: "" };
  }
  if (width < 18) {
    return { label: "workers", detail: " · Esc" };
  }
  if (width < 28) {
    return { label: "workers", detail: " · Up/Dn · Esc" };
  }
  if (width < 38) {
    return { label: "workers", detail: " · Up/Dn · Enter · Esc" };
  }
  if (width < 58) {
    return { label: "workers", detail: " · Up/Dn · Enter logs · ^O · Esc" };
  }
  if (width < 74) {
    return { label: "workers", detail: " · Up/Dn · Enter · C flow · ^O · Esc" };
  }
  return { label: "workers", detail: " · Up/Dn select · Enter logs · C timeline · ^O attach · Esc back" };
}

function collaborationTimelineInputHints(width: number): { label: string; detail: string } {
  if (width < 10) {
    return { label: "tl", detail: "" };
  }
  if (width < 12) {
    return { label: "flow", detail: "" };
  }
  if (width < 15) {
    return { label: "flow", detail: " · Esc" };
  }
  if (width < 22) {
    return { label: "timeline", detail: " · Esc" };
  }
  if (width < 32) {
    return { label: "timeline", detail: " · Pg · Esc" };
  }
  if (width < 48) {
    return { label: "timeline", detail: " · scroll · Tab · Esc" };
  }
  if (width < 70) {
    return { label: "timeline", detail: " · scroll · Tab feature · R · Esc" };
  }
  return { label: "timeline", detail: " · scroll · Tab feature · R refresh · Esc workers" };
}

function taskSessionsInputHints(width: number): { label: string; detail: string } {
  if (width < 12) {
    return { label: "ses", detail: "" };
  }
  if (width < 18) {
    return { label: "sessions", detail: " · Esc" };
  }
  if (width < 28) {
    return { label: "sessions", detail: " · Up/Dn · Esc" };
  }
  if (width < 42) {
    return { label: "sessions", detail: " · Up/Dn · Enter · Esc" };
  }
  if (width < 62) {
    return { label: "sessions", detail: " · Up/Dn · Enter restore · ^N · Esc" };
  }
  return { label: "sessions", detail: " · Up/Dn select · Enter restore · ^N new · Esc back" };
}

function workerSearchInputSuffix(width: number, matchIndex: number, matchCount: number): string {
  const count = Math.max(0, Math.trunc(matchCount));
  const index = count > 0
    ? Math.min(count - 1, Math.max(0, Math.trunc(matchIndex))) + 1
    : 0;
  const position = `${index}/${count}`;
  if (width < 16) {
    return "";
  }
  if (width < 24) {
    return ` · ${position}`;
  }
  if (width < 36) {
    return ` · ${position} · Esc`;
  }
  if (width < 52) {
    return ` · ${position} · Enter · Esc`;
  }
  return ` · ${position} · Enter next · Up/Dn · Esc logs`;
}

function nativeInputHints(width: number, closed = false): { label: string; detail: string } {
  if (closed) {
    if (width < 12) {
      return { label: "done", detail: " ^]" };
    }
    if (width < 14) {
      return { label: "closed", detail: " ^]" };
    }
    if (width < 24) {
      return { label: "closed", detail: " · ^]" };
    }
    if (width < 27) {
      return { label: "closed", detail: " · Pg · ^]" };
    }
    return { label: "closed", detail: " · scroll · ^] logs" };
  }
  if (width < 12) {
    return { label: "nat", detail: " ^]" };
  }
  if (width < 24) {
    return { label: "native", detail: " · ^]" };
  }
  if (width < 27) {
    return { label: "native", detail: " · Pg · ^]" };
  }
  return { label: "native", detail: " · scroll · ^] logs" };
}

function routerInputHints(width: number): { label: string; detail: string } {
  if (width < 12) {
    return { label: "rt", detail: "" };
  }
  if (width < 14) {
    return { label: "rt", detail: " · Esc" };
  }
  if (width < 18) {
    return { label: "routes", detail: " · Esc" };
  }
  if (width < 28) {
    return { label: "routes", detail: " · Pg · Esc" };
  }
  if (width < 44) {
    return { label: "routes", detail: " · scroll · ^G · Esc" };
  }
  if (width < 58) {
    return { label: "routes", detail: " · scroll · Tab · ^G · Esc" };
  }
  return { label: "routes", detail: " · scroll · Tab scope · ^G refresh · Esc chat" };
}
