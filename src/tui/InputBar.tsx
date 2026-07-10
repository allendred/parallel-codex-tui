import React from "react";
import { Box, Text } from "ink";
import { compactTailByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export interface InputBarProps {
  mode: "chat" | "worker" | "native";
  busy?: boolean;
  canRetry?: boolean;
  hasWorkers?: boolean;
  nativeClosed?: boolean;
  value: string;
  terminalWidth?: number;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export function InputBar({
  mode,
  busy = false,
  canRetry = false,
  hasWorkers = false,
  nativeClosed = false,
  value,
  terminalWidth: providedTerminalWidth,
  onChange,
  onSubmit
}: InputBarProps) {
  const terminalWidth = providedTerminalWidth ?? process.stdout.columns ?? 120;
  const fillRail = providedTerminalWidth !== undefined || typeof process.stdout.columns === "number";

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
    const displayValue = chatInputDisplayValue(value, terminalWidth);
    return (
      <InputRail terminalWidth={terminalWidth} textWidth={displayWidth(`${prompt} ${displayValue}|`)} fill={fillRail}>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>{prompt}</Text>
        <Text backgroundColor={TUI_THEME.rail}> </Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.text}>{displayValue}</Text>
        <Text backgroundColor={TUI_THEME.rail} color={TUI_THEME.accent} bold>|</Text>
      </InputRail>
    );
  }

  const hasLeadingPromptSpace = terminalWidth >= 10;
  const placeholder = chatPlaceholderDisplayText(
    terminalWidth,
    { hasWorkers, canRetry },
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
  options: { hasWorkers?: boolean; canRetry?: boolean } = {},
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
  return compactTailByDisplayWidth(value, valueWidth);
}

export function chatPlaceholderDisplayValue(
  terminalWidth: number,
  options: { hasWorkers?: boolean; canRetry?: boolean } = {}
): string {
  if (options.canRetry) {
    if (terminalWidth < 14) {
      return "retry";
    }
    if (terminalWidth < 22) {
      return "^R retry";
    }
    return chatInputDisplayValue("message · ^R retry", terminalWidth);
  }
  if (options.hasWorkers) {
    return chatTaskPlaceholderDisplayValue(terminalWidth);
  }
  if (terminalWidth < 14) {
    return "msg";
  }
  if (terminalWidth < 22) {
    return "message";
  }
  return chatInputDisplayValue("message", terminalWidth);
}

function chatTaskPlaceholderDisplayValue(terminalWidth: number): string {
  if (terminalWidth < 14) {
    return "msg";
  }
  if (terminalWidth < 19) {
    return "msg · ^W";
  }
  if (terminalWidth < 24) {
    return "msg · ^W · ^O";
  }
  if (terminalWidth < 38) {
    return chatInputDisplayValue("message · ^W · ^O", terminalWidth);
  }
  return chatInputDisplayValue("message · ^W logs · Tab · ^O attach", terminalWidth);
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
  if (width < 72) {
    return { label: "logs", detail: " · scroll · Tab · ^O · Esc" };
  }
  return { label: "logs", detail: " · scroll · Tab · ^O attach · Esc chat" };
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
    if (width < 36) {
      return { label: "closed", detail: " · Pg · ^]" };
    }
    if (width < 56) {
      return { label: "closed", detail: " · scroll · ^]" };
    }
    return { label: "closed", detail: " · scroll · ^] logs" };
  }
  if (width < 12) {
    return { label: "nat", detail: " ^]" };
  }
  if (width < 24) {
    return { label: "native", detail: " · ^]" };
  }
  if (width < 36) {
    return { label: "native", detail: " · Pg · ^]" };
  }
  if (width < 56) {
    return { label: "native", detail: " · scroll · ^]" };
  }
  return { label: "native", detail: " · scroll · ^] logs" };
}
