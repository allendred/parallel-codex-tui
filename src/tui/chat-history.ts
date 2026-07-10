export interface ChatDraft {
  value: string;
  cursor: number;
}

export interface ChatDraftHistoryState {
  offset: number;
  draft: ChatDraft;
}

export interface ChatDraftHistoryUpdate extends ChatDraft {
  state: ChatDraftHistoryState;
}

export function chatRequestHistory(messages: readonly { from: string; text: string }[]): string[] {
  return messages
    .filter((message) => message.from === "user")
    .map((message) => message.text);
}

export function navigateChatDraftHistory(
  history: readonly string[],
  current: ChatDraft,
  state: ChatDraftHistoryState,
  delta: number
): ChatDraftHistoryUpdate {
  const nextOffset = clampOffset(state.offset + Math.trunc(delta), history.length);
  if (nextOffset === state.offset) {
    return { ...current, state };
  }

  const draft = state.offset === 0 && nextOffset > 0 ? current : state.draft;
  const nextState = { offset: nextOffset, draft };
  if (nextOffset === 0) {
    return { ...draft, state: nextState };
  }

  const value = history[history.length - nextOffset] ?? "";
  return {
    value,
    cursor: Array.from(value).length,
    state: nextState
  };
}

function clampOffset(offset: number, historyLength: number): number {
  return Math.min(Math.max(0, offset), historyLength);
}
