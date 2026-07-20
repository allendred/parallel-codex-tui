import React from "react";
import { Box, Text, type TextProps } from "ink";
import type { MainConversationSummary } from "../core/session-manager.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type MainConversationLineTone = "heading" | "muted" | "active" | "success" | "danger";

export interface MainConversationDisplayLine {
  text: string;
  tone: MainConversationLineTone;
  conversationIndex?: number;
}

export interface MainConversationsViewProps {
  conversations: MainConversationSummary[];
  selectedIndex: number;
  includeArchived?: boolean;
  notice?: string | null;
  action?: MainConversationViewAction | null;
  loading?: boolean;
  error?: string | null;
  height?: number;
  terminalWidth?: number;
}

export type MainConversationViewAction =
  | { type: "rename"; title: string }
  | { type: "delete"; title: string };

export function MainConversationsView({
  conversations,
  selectedIndex,
  includeArchived = false,
  notice = null,
  action = null,
  loading = false,
  error = null,
  height = 20,
  terminalWidth = process.stdout.columns || 120
}: MainConversationsViewProps) {
  const viewportHeight = Math.max(1, height);
  const width = mainConversationsContentWidth(terminalWidth);
  const lines = mainConversationsDisplayLines(
    conversations,
    selectedIndex,
    viewportHeight,
    terminalWidth,
    { includeArchived, notice, action, loading, error }
  );
  const blankRows = Math.max(0, viewportHeight - lines.length);

  return (
    <Box flexDirection="column" height={viewportHeight}>
      {lines.map((line, index) => (
        <MainConversationRow key={`${line.conversationIndex ?? line.tone}-${index}`} line={line} width={width} />
      ))}
      {Array.from({ length: blankRows }, (_, index) => (
        <Text key={`main-conversation-fill-${index}`} backgroundColor={TUI_THEME.surface}>
          {" ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

export function mainConversationsDisplayLines(
  conversations: MainConversationSummary[],
  selectedIndex: number,
  height: number,
  terminalWidth: number,
  state: {
    notice?: string | null;
    action?: MainConversationViewAction | null;
    includeArchived?: boolean;
    loading?: boolean;
    error?: string | null;
  } = {}
): MainConversationDisplayLine[] {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = mainConversationsContentWidth(terminalWidth);
  const lines: MainConversationDisplayLine[] = [{
    text: fitMainConversationCandidates([
      state.includeArchived ? "Main conversations · archived shown" : "Main conversations",
      state.includeArchived ? "Conversations · all" : "Conversations",
      "Chats",
      "C"
    ], width),
    tone: "heading"
  }];

  if (viewportHeight >= 3) {
    const messages = conversations.reduce((sum, conversation) => sum + conversation.messageCount, 0);
    const nativeSessions = conversations.reduce((sum, conversation) => sum + conversation.nativeSessionCount, 0);
    const archived = conversations.filter((conversation) => conversation.archivedAt).length;
    lines.push({
      text: fitMainConversationCandidates([
        [
          `${conversations.length} ${conversations.length === 1 ? "conversation" : "conversations"}`,
          `${messages} messages`,
          `${nativeSessions} native`,
          ...(archived > 0 ? [`${archived} archived`] : [])
        ].join(" · "),
        `${conversations.length} conversations · ${messages} messages`,
        `${conversations.length} conversations`,
        `${conversations.length} chats`
      ], width),
      tone: "muted"
    });
  }

  if (viewportHeight >= 4 && state.action) {
    lines.push({
      text: fitMainConversationText(
        state.action.type === "rename"
          ? `rename · ${safeMainConversationText(state.action.title)} · Enter save · Esc cancel`
          : `delete · ${safeMainConversationText(state.action.title)} · press D again · Esc cancel`,
        width
      ),
      tone: state.action.type === "delete" ? "danger" : "active"
    });
  } else if (viewportHeight >= 4 && state.notice) {
    lines.push({ text: fitMainConversationText(state.notice, width), tone: "success" });
  }
  const slots = Math.max(0, viewportHeight - lines.length);
  if (state.loading) {
    if (slots > 0) {
      lines.push({ text: fitMainConversationText("loading Main conversations", width), tone: "muted" });
    }
    return lines;
  }
  if (state.error) {
    if (slots > 0) {
      lines.push({ text: fitMainConversationText(`error · ${safeMainConversationText(state.error)}`, width), tone: "danger" });
    }
    return lines;
  }
  if (conversations.length === 0) {
    if (slots > 0) {
      lines.push({ text: fitMainConversationText("No saved Main conversations", width), tone: "muted" });
    }
    return lines;
  }

  const selected = clampMainConversationIndex(selectedIndex, conversations.length);
  const visibleCount = Math.min(slots, conversations.length);
  const start = mainConversationWindowStart(selected, conversations.length, visibleCount);
  for (let index = start; index < start + visibleCount; index += 1) {
    const conversation = conversations[index];
    if (!conversation) {
      continue;
    }
    lines.push({
      text: mainConversationRowText(conversation, index === selected, width),
      tone: conversation.current ? "success" : index === selected ? "active" : "muted",
      conversationIndex: index
    });
  }
  return lines;
}

export function moveMainConversationSelection(
  current: number,
  delta: number,
  conversationCount: number,
  wrap = false
): number {
  if (conversationCount <= 0) {
    return 0;
  }
  const normalizedCurrent = clampMainConversationIndex(current, conversationCount);
  const next = normalizedCurrent + Math.trunc(delta);
  if (wrap) {
    return ((next % conversationCount) + conversationCount) % conversationCount;
  }
  return Math.min(conversationCount - 1, Math.max(0, next));
}

function MainConversationRow({ line, width }: { line: MainConversationDisplayLine; width: number }) {
  const trailingWidth = Math.max(0, width - displayWidth(line.text));
  const theme = mainConversationLineTheme(line.tone);
  return (
    <Text>
      <Text {...theme}>{line.text}</Text>
      {trailingWidth > 0 ? <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(trailingWidth)}</Text> : null}
    </Text>
  );
}

function mainConversationRowText(
  conversation: MainConversationSummary,
  selected: boolean,
  width: number
): string {
  const marker = `${selected ? ">" : " "} ${conversation.current ? "*" : " "} `;
  const title = safeMainConversationText(conversation.title);
  const messages = `${conversation.messageCount} ${conversation.messageCount === 1 ? "message" : "messages"}`;
  const native = `${conversation.nativeSessionCount} native`;
  const status = conversation.archivedAt ? "archived" : null;
  const date = conversation.lastActivityAt.slice(5, 16).replace("T", " ");
  const scope = conversation.id
    ? `#${conversation.id.replace(/^conversation-/, "")}`
    : "legacy";
  return fitMainConversationCandidates([
    [marker + title, status, messages, native, date].filter(Boolean).join(" · "),
    [marker + title, status, messages, native].filter(Boolean).join(" · "),
    [marker + title, status, messages].filter(Boolean).join(" · "),
    [marker + title, date].join(" · "),
    [marker + scope, messages].join(" · "),
    marker.trimEnd()
  ], width);
}

function mainConversationWindowStart(selected: number, count: number, visibleCount: number): number {
  if (visibleCount <= 0 || count <= visibleCount) {
    return 0;
  }
  return Math.min(count - visibleCount, Math.max(0, selected - Math.floor(visibleCount / 2)));
}

function clampMainConversationIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, Math.trunc(index)));
}

function fitMainConversationCandidates(candidates: string[], width: number): string {
  return candidates.find((candidate) => displayWidth(candidate) <= width)
    ?? fitMainConversationText(candidates.at(-1) ?? "", width);
}

function fitMainConversationText(text: string, width: number): string {
  return compactEndByDisplayWidth(text, Math.max(1, width));
}

function safeMainConversationText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mainConversationLineTheme(
  tone: MainConversationLineTone
): Pick<TextProps, "backgroundColor" | "bold" | "color"> {
  return {
    backgroundColor: TUI_THEME.surface,
    color: tone === "heading" || tone === "active"
      ? TUI_THEME.accent
      : tone === "success"
        ? TUI_THEME.success
        : tone === "danger"
          ? TUI_THEME.danger
          : TUI_THEME.muted,
    ...(tone === "heading" || tone === "danger" ? { bold: true } : {})
  };
}

function mainConversationsContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 2);
}
