import React from "react";
import { Box, Text } from "ink";
import type { ConfigurableRole, RoleConfigurationScope } from "../core/role-configuration.js";
import { compactEndByDisplayWidth, compactTailByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export interface InputBarProps {
  mode: "chat" | "worker" | "worker-search" | "workers" | "features" | "collaboration" | "native" | "router" | "sessions" | "status" | "roles";
  ready?: boolean;
  busy?: boolean;
  routeFallback?: boolean;
  collaborationDetail?: boolean;
  collaborationUnresolved?: boolean;
  collaborationBack?: "workers" | "features";
  featureCanCancel?: boolean;
  featureCanPause?: boolean;
  featureCanReassign?: boolean;
  featureCancelConfirm?: boolean;
  featurePauseConfirm?: boolean;
  featureAssignment?: boolean;
  featureEditingModel?: { role: "actor" | "critic"; value: string; cursor: number } | null;
  taskSessionAction?: TaskSessionInputAction | null;
  taskSessionsIncludeArchived?: boolean;
  mainConversationSessions?: boolean;
  taskSessionDetail?: boolean;
  taskSessionDetailHasNative?: boolean;
  taskSessionDetailCanFork?: boolean;
  canRetry?: boolean;
  hasWorkers?: boolean;
  hasActiveTask?: boolean;
  hasTaskResult?: boolean;
  taskResultExpanded?: boolean;
  chatScrollOffset?: number;
  chatMaxScrollOffset?: number;
  nativeClosed?: boolean;
  searchMatchIndex?: number;
  searchMatchCount?: number;
  clipboardNotice?: { state: "copying" | "copied"; text: string } | null;
  roleScope?: RoleConfigurationScope;
  roleEditingModel?: { role: ConfigurableRole; value: string; cursor: number } | null;
  roleCanApply?: boolean;
  roleSaving?: boolean;
  roleHasOverride?: boolean;
  value: string;
  cursor?: number;
  terminalWidth?: number;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export type TaskSessionInputAction =
  | { type: "rename"; value: string; cursor: number }
  | { type: "delete"; title: string };

export function InputBar({
  mode,
  ready = true,
  busy = false,
  routeFallback = false,
  collaborationDetail = false,
  collaborationUnresolved = false,
  collaborationBack = "workers",
  featureCanCancel = false,
  featureCanPause = false,
  featureCanReassign = false,
  featureCancelConfirm = false,
  featurePauseConfirm = false,
  featureAssignment = false,
  featureEditingModel = null,
  taskSessionAction = null,
  taskSessionsIncludeArchived = false,
  mainConversationSessions = false,
  taskSessionDetail = false,
  taskSessionDetailHasNative = false,
  taskSessionDetailCanFork = false,
  canRetry = false,
  hasWorkers = false,
  hasActiveTask = false,
  hasTaskResult = false,
  taskResultExpanded = false,
  chatScrollOffset = 0,
  chatMaxScrollOffset = 0,
  nativeClosed = false,
  searchMatchIndex = 0,
  searchMatchCount = 0,
  clipboardNotice = null,
  roleScope = "next",
  roleEditingModel = null,
  roleCanApply = true,
  roleSaving = false,
  roleHasOverride = false,
  value,
  cursor,
  terminalWidth: providedTerminalWidth,
  onChange,
  onSubmit
}: InputBarProps) {
  const terminalWidth = providedTerminalWidth ?? process.stdout.columns ?? 120;
  const fillRail = providedTerminalWidth !== undefined || typeof process.stdout.columns === "number";

  if (clipboardNotice) {
    const contentWidth = Math.max(1, terminalWidth - (terminalWidth > 1 ? 2 : 0));
    const text = compactEndByDisplayWidth(clipboardNotice.text, contentWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(text)} fill={fillRail}>
        <Text
          backgroundColor={TUI_THEME.rail}
          color={clipboardNotice.state === "copied" ? TUI_THEME.success : TUI_THEME.warning}
          bold
        >
          {text}
        </Text>
      </InputRail>
    );
  }

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

  if (mode === "roles") {
    if (roleEditingModel) {
      const prefix = `${roleEditingModel.role} model > `;
      const valueWidth = Math.max(1, terminalWidth - displayWidth(prefix) - 3);
      const display = chatInputDisplayParts(roleEditingModel.value, roleEditingModel.cursor, valueWidth);
      const textWidth = displayWidth(`${prefix}${display.before}|${display.after}`);
      return (
        <InputRail terminalWidth={terminalWidth} textWidth={textWidth} fill={fillRail}>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{prefix}</Text>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.before}</Text>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>|</Text>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.after}</Text>
        </InputRail>
      );
    }
    const hints = roleConfigurationInputHints(
      terminalWidth,
      roleScope,
      roleCanApply,
      roleSaving,
      roleHasOverride
    );
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={roleSaving ? TUI_THEME.warning : TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "features" && featureEditingModel) {
    const prefix = `${featureEditingModel.role} model > `;
    const valueWidth = Math.max(1, terminalWidth - displayWidth(prefix) - 3);
    const display = chatInputDisplayParts(featureEditingModel.value, featureEditingModel.cursor, valueWidth);
    const textWidth = displayWidth(`${prefix}${display.before}|${display.after}`);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={textWidth} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{prefix}</Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.before}</Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>|</Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.after}</Text>
      </InputRail>
    );
  }

  if (mode === "status") {
    const hints = statusDetailInputHints(terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "sessions") {
    if (taskSessionAction?.type === "rename") {
      const prefix = terminalWidth < 12 ? "> " : "rename > ";
      const valueWidth = Math.max(1, terminalWidth - displayWidth(prefix) - 3);
      const display = chatInputDisplayParts(taskSessionAction.value, taskSessionAction.cursor, valueWidth);
      const textWidth = displayWidth(`${prefix}${display.before}|${display.after}`);
      return (
        <InputRail terminalWidth={terminalWidth} textWidth={textWidth} fill={fillRail}>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{prefix}</Text>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.before}</Text>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>|</Text>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{display.after}</Text>
        </InputRail>
      );
    }
    if (taskSessionAction?.type === "delete") {
      const hints = taskSessionDeleteInputHints(terminalWidth, taskSessionAction.title);
      return (
        <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.danger} bold>{hints.label}</Text>
          {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
        </InputRail>
      );
    }
    if (taskSessionDetail) {
      const hints = taskSessionDetailInputHints(
        terminalWidth,
        taskSessionDetailHasNative,
        taskSessionDetailCanFork
      );
      return (
        <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
          {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
        </InputRail>
      );
    }
    if (mainConversationSessions) {
      const hints = mainConversationSessionsInputHints(terminalWidth, taskSessionsIncludeArchived);
      return (
        <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
          <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
          {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
        </InputRail>
      );
    }
    const hints = taskSessionsInputHints(terminalWidth, taskSessionsIncludeArchived);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "collaboration") {
    const hints = collaborationDetail
      ? collaborationDetailInputHints(terminalWidth)
      : collaborationTimelineInputHints(terminalWidth, collaborationUnresolved, collaborationBack);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${hints.label}${hints.detail}`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{hints.label}</Text>
        {hints.detail ? <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.muted}>{hints.detail}</Text> : null}
      </InputRail>
    );
  }

  if (mode === "features") {
    const hints = featureBoardInputHints(terminalWidth, {
      canCancel: featureCanCancel,
      canPause: featureCanPause,
      canReassign: featureCanReassign,
      confirmCancel: featureCancelConfirm,
      confirmPause: featurePauseConfirm,
      assignment: featureAssignment,
      canRetry
    });
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
      hasTaskResult,
      taskResultExpanded,
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
      <Text backgroundColor={TUI_THEME.rail} color={canRetry ? TUI_THEME.warning : hasTaskResult ? TUI_THEME.accent : TUI_THEME.muted}>{placeholder}</Text>
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
  if (options.hasTaskResult) {
    return chatTaskResultPlaceholderDisplayValue(
      terminalWidth,
      Boolean(options.taskResultExpanded),
      Boolean(options.hasWorkers),
      scrollOffset,
      maxScrollOffset
    );
  }
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
    return chatTaskPlaceholderDisplayValue(terminalWidth, maxScrollOffset > 0);
  }
  if (maxScrollOffset > 0 && terminalWidth >= 22) {
    return selectChatPlaceholder(terminalWidth, ["message · scroll", "message", "msg"]);
  }
  return selectChatPlaceholder(terminalWidth, [
    "message · ^N new · ^P project · ^T tasks · ^G routes",
    "message · ^N new · ^P project · ^G routes",
    "message · ^N new · ^P project",
    "message · ^N new",
    "message",
    "msg"
  ]);
}

export interface ChatPlaceholderOptions {
  hasWorkers?: boolean;
  hasActiveTask?: boolean;
  hasTaskResult?: boolean;
  taskResultExpanded?: boolean;
  canRetry?: boolean;
  scrollOffset?: number;
  maxScrollOffset?: number;
}

function chatTaskResultPlaceholderDisplayValue(
  terminalWidth: number,
  expanded: boolean,
  hasWorkers: boolean,
  scrollOffset: number,
  maxScrollOffset: number
): string {
  const toggle = expanded ? "^D compact" : "^D details";
  const position = expanded && maxScrollOffset > 0
    ? scrollOffset > 0 ? `result ${scrollOffset}/${maxScrollOffset}` : "result · scroll"
    : "message";
  const candidates = hasWorkers
    ? [
        `${position} · ${toggle} · ^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach`,
        `${position} · ${toggle} · ^N new · ^W logs · ^T tasks · Tab · ^O attach`,
        `${position} · ${toggle} · ^W logs · ^B workers · ^T tasks · Tab · ^O attach`,
        `${position} · ${toggle} · ^W logs · ^T tasks · Tab · ^O attach`,
        `${position} · ${toggle} · ^W logs · Tab · ^O attach`,
        `${position} · ${toggle} · ^W logs`,
        `${toggle} · ^W logs`,
        toggle,
        "^D"
      ]
    : [
        `${position} · ${toggle} · ^N new`,
        `${position} · ${toggle}`,
        toggle,
        "^D"
      ];
  return selectChatPlaceholder(terminalWidth, candidates);
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

function chatTaskPlaceholderDisplayValue(terminalWidth: number, scrollable = false): string {
  if (terminalWidth >= 72) {
    const activeCandidates = scrollable
      ? [
          "message · scroll · ^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes",
          "scroll · ^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes",
          "message · scroll · ^N new · ^W logs · ^B workers · Tab · ^O attach · ^G routes"
        ]
      : [
          "message · ^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes",
          "^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes",
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
          "scroll · ^W logs · Tab · ^O attach",
          "scroll · ^W logs · ^O attach",
          "^W logs · ^O attach",
          "message · ^W logs",
          "msg · ^W logs",
          "^W logs",
          "msg"
        ]
      : [
          "message · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes",
          "message · ^W logs · ^B workers · Tab · ^O attach · ^G routes",
          "message · ^W logs · Tab · ^O attach · ^G routes",
          "message · ^W logs · Tab · ^O attach",
          "message · ^W logs · ^O attach",
          "^W logs · ^O attach",
          "message · ^W logs",
          "msg · ^W logs",
          "^W logs",
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
  if (width < 10) {
    return { label: "log", detail: "" };
  }
  if (width < 16) {
    return { label: "Esc chat", detail: "" };
  }
  if (width < 17) {
    return { label: "log", detail: " · Esc chat" };
  }
  if (width < 22) {
    return { label: "logs", detail: " · Esc chat" };
  }
  if (width < 28) {
    return { label: "logs", detail: " · Pg · Esc chat" };
  }
  if (width < 32) {
    return { label: "logs", detail: " · Pg · Tab · Esc chat" };
  }
  if (width < 44) {
    return { label: "logs", detail: " · scroll · Tab · Esc chat" };
  }
  if (width < 54) {
    return { label: "logs", detail: " · scroll · Tab · ^O attach · Esc chat" };
  }
  if (width < 71) {
    return { label: "logs", detail: " · scroll · ^F find · Tab · ^O attach · Esc chat" };
  }
  if (width < 84) {
    return { label: "logs", detail: " · scroll · ^F find · E err · D diff · Tab · ^O attach · Esc chat" };
  }
  return { label: "logs", detail: " · scroll · ^F find · E err · D diff · Tab · ^B workers · ^O attach · Esc chat" };
}

function statusDetailInputHints(width: number): { label: string; detail: string } {
  return selectInputHints(width, [
    { label: "status", detail: " · ^E roles · ^X diagnostics · ^S/Esc back · ^C exit" },
    { label: "status", detail: " · ^E roles · ^X diag · ^S/Esc back · ^C exit" },
    { label: "status", detail: " · ^S back · ^C exit" },
    { label: "status", detail: " · ^S back" },
    { label: "status", detail: "" },
    { label: "st", detail: "" }
  ]);
}

function roleConfigurationInputHints(
  width: number,
  scope: RoleConfigurationScope,
  canApply: boolean,
  saving: boolean,
  hasOverride: boolean
): { label: string; detail: string } {
  const label = saving ? "roles · saving" : `roles · ${scope}`;
  const apply = canApply ? "Enter apply" : "task unavailable";
  const reset = hasOverride ? " · X reset" : "";
  return selectInputHints(width, [
    { label, detail: ` · Tab scope · Up/Dn role · Left/Right provider · M model · ${apply}${reset} · ^E/Esc back` },
    { label, detail: ` · Tab scope · Up/Dn · Left/Right provider · M model · ${apply}${reset} · Esc back` },
    { label, detail: ` · Tab · Up/Dn · Left/Right · M model · ${apply}${reset}` },
    { label, detail: ` · Tab · arrows · M · ${canApply ? "Enter" : "no task"}` },
    { label: "roles", detail: " · Tab · arrows · M · Enter" },
    { label: "roles", detail: "" }
  ]);
}

function workerOverviewInputHints(width: number): { label: string; detail: string } {
  if (width < 16) {
    return { label: "wrk", detail: "" };
  }
  if (width < 20) {
    return { label: "wrk", detail: " · Esc back" };
  }
  if (width < 28) {
    return { label: "workers", detail: " · Esc back" };
  }
  if (width < 41) {
    return { label: "workers", detail: " · Up/Dn · Esc back" };
  }
  if (width < 53) {
    return { label: "workers", detail: " · Up/Dn · Enter logs · Esc back" };
  }
  if (width < 72) {
    return { label: "workers", detail: " · Up/Dn · Enter logs · ^O attach · Esc back" };
  }
  if (width < 86) {
    return { label: "workers", detail: " · Up/Dn · Enter logs · F board · C flow · ^O attach · Esc back" };
  }
  return { label: "workers", detail: " · Up/Dn select · Enter logs · F features · C timeline · ^O attach · Esc back" };
}

function featureBoardInputHints(
  width: number,
  options: {
    canCancel: boolean;
    canPause: boolean;
    canReassign: boolean;
    confirmCancel: boolean;
    confirmPause: boolean;
    assignment: boolean;
    canRetry: boolean;
  }
): { label: string; detail: string } {
  if (options.assignment) {
    return selectInputHints(width, [
      { label: "assign", detail: " · A/C provider · 1/2 model · M/Esc done" },
      { label: "assign", detail: " · A/C provider · 1/2 model · Esc done" },
      { label: "assign", detail: " · A/C provider · 1/2 model" },
      { label: "provider", detail: " · A · C · Esc" },
      { label: "provider", detail: "" },
      { label: "M", detail: "" }
    ]);
  }
  if (options.confirmPause) {
    return selectInputHints(width, [
      { label: "pause feature?", detail: " · P confirm · Esc keep" },
      { label: "pause?", detail: " · P confirm · Esc keep" },
      { label: "pause?", detail: " · Esc keep" },
      { label: "Esc keep", detail: "" },
      { label: "hold?", detail: "" },
      { label: "?", detail: "" }
    ]);
  }
  if (options.confirmCancel) {
    return selectInputHints(width, [
      { label: "cancel feature?", detail: " · X confirm · Esc keep" },
      { label: "cancel?", detail: " · X confirm · Esc keep" },
      { label: "cancel?", detail: " · Esc keep" },
      { label: "Esc keep", detail: "" },
      { label: "stop?", detail: "" },
      { label: "?", detail: "" }
    ]);
  }
  if (options.canCancel || options.canPause) {
    const controls = [
      ...(options.canPause ? ["P pause"] : []),
      ...(options.canCancel ? ["X cancel"] : [])
    ].join(" · ");
    return selectInputHints(width, [
      { label: "features", detail: ` · Up/Dn select · Enter timeline · ${controls} · R refresh · Esc workers` },
      { label: "features", detail: ` · Up/Dn select · ${controls} · R refresh · Esc workers` },
      { label: "features", detail: ` · Up/Dn select · ${controls} · Esc workers` },
      { label: "features", detail: ` · ${controls} · Esc workers` },
      { label: "ft", detail: ` · ${controls} · Esc workers` },
      { label: "f", detail: ` · ${controls} · Esc workers` },
      { label: "features", detail: ` · ${controls}` },
      { label: "ft", detail: ` · ${controls}` },
      { label: "f", detail: ` · ${controls}` },
      { label: "features", detail: "" },
      { label: "ft", detail: "" },
      { label: "f", detail: "" }
    ]);
  }
  if (options.canRetry) {
    return selectInputHints(width, [
      { label: "features", detail: ` · Up/Dn select · Enter timeline · ${options.canReassign ? "M provider · " : ""}^R retry task · R refresh · Esc workers` },
      { label: "features", detail: ` · Up/Dn select · ${options.canReassign ? "M provider · " : ""}^R retry task · R refresh · Esc workers` },
      { label: "features", detail: ` · Up/Dn select · ${options.canReassign ? "M provider · " : ""}^R retry · Esc workers` },
      { label: "features", detail: " · ^R retry · Esc workers" },
      { label: "features", detail: " · Esc workers" },
      { label: "features", detail: "" },
      { label: "ft", detail: "" },
      { label: "f", detail: "" }
    ]);
  }
  return selectInputHints(width, [
    { label: "features", detail: " · Up/Dn select · Enter timeline · R refresh · Esc workers" },
    { label: "features", detail: " · Up/Dn select · Enter timeline · Esc workers" },
    { label: "features", detail: " · Up/Dn select · Esc workers" },
    { label: "features", detail: " · Esc workers" },
    { label: "features", detail: "" },
    { label: "ft", detail: "" },
    { label: "f", detail: "" }
  ]);
}

function collaborationTimelineInputHints(
  width: number,
  unresolvedOnly: boolean,
  back: "workers" | "features"
): { label: string; detail: string } {
  const backAction = `Esc ${back}`;
  const filterAction = unresolvedOnly ? "U all" : "U unresolved";
  const compactFilterAction = unresolvedOnly ? "U all" : "U open";
  return selectInputHints(width, [
    {
      label: "timeline",
      detail: ` · Up/Dn event · Enter detail · Tab feature · ${filterAction} · R refresh · ${backAction}`
    },
    {
      label: "timeline",
      detail: ` · Up/Dn event · Enter detail · Tab feature · ${compactFilterAction} · R refresh · ${backAction}`
    },
    {
      label: "timeline",
      detail: ` · Up/Dn event · Enter detail · Tab feature · ${compactFilterAction} · ${backAction}`
    },
    { label: "timeline", detail: ` · Up/Dn event · Enter detail · Tab feature · ${backAction}` },
    { label: "timeline", detail: ` · Up/Dn event · Enter detail · ${backAction}` },
    { label: "timeline", detail: ` · Enter detail · ${backAction}` },
    { label: "timeline", detail: ` · ${backAction}` },
    { label: backAction, detail: "" },
    { label: "flow", detail: "" },
    { label: "tl", detail: "" },
    { label: "t", detail: "" }
  ]);
}

function collaborationDetailInputHints(width: number): { label: string; detail: string } {
  return selectInputHints(width, [
    { label: "event detail", detail: " · scroll · Enter/Esc timeline" },
    { label: "event", detail: " · Pg scroll · Enter/Esc timeline" },
    { label: "event", detail: " · Pg scroll · Esc timeline" },
    { label: "event", detail: " · Esc timeline" },
    { label: "Esc timeline", detail: "" },
    { label: "event", detail: "" },
    { label: "e", detail: "" }
  ]);
}

function taskSessionsInputHints(width: number, includeArchived: boolean): { label: string; detail: string } {
  const archivedAction = includeArchived ? "H hide archived" : "H archived";
  return selectInputHints(width, [
    { label: "sessions", detail: ` · Up/Dn select · Enter restore · C conversations · I inspect · R rename · A archive · D delete · E export · ${archivedAction} · Esc back` },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · C conversations · I inspect · R rename · A archive · D delete · E export · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · C chats · I inspect · R rename · A archive · D delete · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · C chats · I inspect · R rename · A archive · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · C chats · I inspect · R rename · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · C chats · R rename · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · C chats · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · I inspect · R rename · A archive · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · I inspect · R rename · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · R rename · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · I inspect · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Enter restore · Esc back" },
    { label: "sessions", detail: " · Up/Dn select · Esc back" },
    { label: "sessions", detail: " · Esc back" },
    { label: "Esc back", detail: "" },
    { label: "sessions", detail: "" },
    { label: "ses", detail: "" },
    { label: "s", detail: "" }
  ]);
}

export function mainConversationSessionsInputHints(
  width: number,
  includeArchived: boolean
): { label: string; detail: string } {
  const archivedAction = includeArchived ? "H hide archived" : "H archived";
  return selectInputHints(width, [
    { label: "conversations", detail: ` · Up/Dn select · Enter restore · R rename · A archive · D delete · E export · ${archivedAction} · N new · T tasks · Esc back` },
    { label: "conversations", detail: " · Up/Dn select · Enter restore · R rename · A archive · D delete · E export · N new · T tasks · Esc back" },
    { label: "conversations", detail: " · Up/Dn select · Enter restore · R rename · A archive · D delete · N new · T tasks · Esc back" },
    { label: "conversations", detail: " · Up/Dn select · Enter restore · R rename · A archive · N new · T tasks · Esc back" },
    { label: "conversations", detail: " · Up/Dn select · Enter restore · R rename · N new · T tasks · Esc back" },
    { label: "conversations", detail: " · Up/Dn select · Enter restore · N new · T tasks · Esc back" },
    { label: "conversations", detail: " · Up/Dn select · Enter restore · T tasks · Esc back" },
    { label: "conversations", detail: " · Up/Dn select · Enter restore · Esc back" },
    { label: "conversations", detail: " · Up/Dn select · Esc back" },
    { label: "conversations", detail: " · Esc back" },
    { label: "Esc back", detail: "" },
    { label: "chats", detail: "" },
    { label: "c", detail: "" }
  ]);
}

function taskSessionDetailInputHints(
  width: number,
  hasNative: boolean,
  canFork: boolean
): { label: string; detail: string } {
  const nativeActions = hasNative
    ? `${canFork ? "C continue · B branch" : "C continue"} · `
    : "";
  return selectInputHints(width, [
    { label: "session", detail: ` · Up/Dn worker · Enter logs · ${nativeActions}R refresh · Esc tasks` },
    { label: "session", detail: ` · Up/Dn worker · Enter logs · ${nativeActions}Esc tasks` },
    { label: "session", detail: ` · Up/Dn · Enter logs · ${nativeActions}Esc tasks` },
    { label: "session", detail: ` · Enter logs · ${nativeActions}Esc tasks` },
    { label: "session", detail: ` · ${hasNative ? "C continue · " : ""}Esc tasks` },
    { label: "session", detail: " · Esc tasks" },
    { label: "Esc tasks", detail: "" },
    { label: "session", detail: "" },
    { label: "ses", detail: "" },
    { label: "s", detail: "" }
  ]);
}

function taskSessionDeleteInputHints(width: number, title: string): { label: string; detail: string } {
  const safeTitle = title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return selectInputHints(width, [
    { label: "delete", detail: ` · ${safeTitle} · D confirm · Esc cancel` },
    { label: "delete", detail: " · D confirm · Esc cancel" },
    { label: "D confirm", detail: " · Esc cancel" },
    { label: "D confirm", detail: "" },
    { label: "D", detail: "" }
  ]);
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
  return selectInputHints(width, [
    { label: "routes", detail: " · scroll · Tab scope · ^G refresh · Esc chat" },
    { label: "routes", detail: " · scroll · ^G refresh · Esc chat" },
    { label: "routes", detail: " · Pg scroll · Esc chat" },
    { label: "routes", detail: " · Esc chat" },
    { label: "Esc chat", detail: "" },
    { label: "routes", detail: "" },
    { label: "rt", detail: "" },
    { label: "r", detail: "" }
  ]);
}

function selectInputHints(
  width: number,
  candidates: ReadonlyArray<{ label: string; detail: string }>
): { label: string; detail: string } {
  const contentWidth = Math.max(1, Math.trunc(width) - (width > 1 ? 2 : 0));
  return candidates.find((candidate) => displayWidth(`${candidate.label}${candidate.detail}`) <= contentWidth)
    ?? candidates.at(-1)
    ?? { label: "", detail: "" };
}
