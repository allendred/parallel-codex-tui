import React, { useEffect, useRef, useState } from "react";
import { basename } from "node:path";
import { Box, Text, useApp, useInput, useStdin, type TextProps } from "ink";
import type { AppConfig } from "../core/config.js";
import { readJson } from "../core/file-store.js";
import { WorkerStatusSchema } from "../domain/schemas.js";
import type { Orchestrator, WorkerLogRef } from "../orchestrator/orchestrator.js";
import {
  formatSelectedWorkerStatus,
  formatStatusLine,
  formatWorkerRuntimeStatus,
  type StatusLineState
} from "./status-line.js";
import { applyChatInputChunk } from "./chat-input.js";
import { AppShell } from "./AppShell.js";
import { InputBar } from "./InputBar.js";
import { applyNativeInputChunk } from "./native-input.js";
import { nextScrollOffset } from "./scrolling.js";
import { chooseSubmitTarget, nextSubmitMemoryState, shouldClearWorkersForSubmit } from "./task-memory.js";
import { TerminalOutput } from "./TerminalOutput.js";
import { NativeTerminalScreen } from "./terminal-screen.js";
import { WorkerOutputView } from "./WorkerOutputView.js";
import { compactEndByDisplayWidth, displayWidth, wrapByDisplayWidth } from "./display-width.js";
import { isAttachShortcut, isExitShortcut, isLogsShortcut, mouseScrollDelta, scrollDelta } from "./keyboard.js";
import { createRawInputDecoder } from "./raw-input-decoder.js";
import { configureTuiTheme, TUI_THEME } from "./theme.js";
import {
  buildNativeAttachLaunch,
  startNativeAttachProcess,
  type NativeAttachLaunch,
  type NativeAttachProcessRef
} from "../workers/native-attach.js";

export interface AppProps {
  config: AppConfig;
  orchestrator: Orchestrator;
  cwd: string;
  initialTaskId?: string | null;
  prepareNativeAttach?: (worker: WorkerLogRef) => Promise<NativeAttachLaunch>;
  startNativeAttach?: (
    launch: NativeAttachLaunch,
    handlers: {
      onOutput: (chunk: string) => void;
      onClose: (code: number) => void;
      onError: (error: Error) => void;
    }
  ) => NativeAttachProcessRef;
}

export interface Message {
  from: "user" | "system";
  text: string;
}

export interface ChatDisplayLine {
  from: Message["from"];
  text: string;
  continuation: boolean;
}

type ChatLineTheme = Pick<TextProps, "backgroundColor" | "color" | "dimColor">;
type ChatEmptyStateTheme = Pick<TextProps, "backgroundColor" | "bold" | "color">;
type ChatViewportBlankLineTheme = Pick<TextProps, "backgroundColor">;
type NativeAttachStartingTheme = Pick<TextProps, "backgroundColor" | "color" | "dimColor">;

export function App({
  config,
  orchestrator,
  cwd,
  initialTaskId = null,
  prepareNativeAttach,
  startNativeAttach
}: AppProps) {
  configureTuiTheme({
    theme: config.ui.theme,
    colors: config.ui.colors
  });

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusLineState | null>(initialTaskId ? { taskId: initialTaskId } : null);
  const [view, setView] = useState<"chat" | "worker" | "native">("chat");
  const [workers, setWorkers] = useState<WorkerLogRef[]>([]);
  const [selectedWorkerIndex, setSelectedWorkerIndex] = useState(0);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(initialTaskId);
  const [activeMode, setActiveMode] = useState<"simple" | "complex" | null>(initialTaskId ? "complex" : null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [nativeInput, setNativeInput] = useState("");
  const [workerScrollOffset, setWorkerScrollOffset] = useState(0);
  const [workerMaxScrollOffset, setWorkerMaxScrollOffset] = useState(0);
  const [nativeAttach, setNativeAttach] = useState<{
    launch: NativeAttachLaunch;
    process: NativeAttachProcessRef;
    screen: NativeTerminalScreen;
    snapshot: string;
    closedCode: number | null;
  } | null>(null);
  const { exit } = useApp();
  const { setRawMode, internal_eventEmitter: stdinEvents } = useStdin();
  const nativeAttachRef = useRef(nativeAttach);
  const nativeInputRef = useRef(nativeInput);
  const inputRef = useRef(input);
  const viewRef = useRef(view);
  const busyRef = useRef(busy);
  const workersRef = useRef(workers);
  const selectedWorkerIndexRef = useRef(selectedWorkerIndex);
  const workerMaxScrollOffsetRef = useRef(workerMaxScrollOffset);
  const autoSelectedFailedWorkerRef = useRef(false);
  const userSelectedWorkerRef = useRef(false);
  const attachSelectedWorkerRef = useRef<(worker: WorkerLogRef) => Promise<void>>(attachSelectedWorker);
  const submitRef = useRef<(value: string) => Promise<void>>(submit);
  const exitRef = useRef(exit);
  const rawInputDecoderRef = useRef(createRawInputDecoder());

  const contentHeight = appContentHeight(process.stdout.rows || 30, Boolean(attachError), config.ui.showStatusBar);
  const outputHeight = Math.max(1, contentHeight);
  const terminalWidth = process.stdout.columns || 120;
  const selectedWorkerStatus = formatSelectedWorkerStatus(status, selectedWorkerIndex);
  const visibleWorkerStatus = view === "chat" ? "" : selectedWorkerStatus;

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    exitRef.current = exit;
  }, [exit]);

  useEffect(() => {
    workersRef.current = workers;
  }, [workers]);

  useEffect(() => {
    selectedWorkerIndexRef.current = selectedWorkerIndex;
  }, [selectedWorkerIndex]);

  useEffect(() => {
    workerMaxScrollOffsetRef.current = workerMaxScrollOffset;
  }, [workerMaxScrollOffset]);

  useEffect(() => {
    attachSelectedWorkerRef.current = attachSelectedWorker;
    submitRef.current = submit;
  });

  useEffect(() => {
    nativeAttachRef.current = nativeAttach;
  }, [nativeAttach]);

  useEffect(() => {
    nativeInputRef.current = nativeInput;
  }, [nativeInput]);

  useEffect(() => {
    if (!initialTaskId) {
      return;
    }

    const taskId = initialTaskId;
    let active = true;
    async function loadInitialWorkers() {
      try {
        const restored = await orchestrator.listTaskWorkers(taskId);
        if (!active || restored.length === 0) {
          return;
        }
        setWorkers(restored);
        selectedWorkerIndexRef.current = 0;
        autoSelectedFailedWorkerRef.current = false;
        userSelectedWorkerRef.current = false;
        setSelectedWorkerIndex(0);
      } catch (error) {
        if (active) {
          setAttachError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void loadInitialWorkers();
    return () => {
      active = false;
    };
  }, [initialTaskId, orchestrator]);

  useEffect(() => {
    if (workers.length === 0 || !status) {
      return;
    }

    let active = true;

    async function refreshWorkerStatuses() {
      const updates = await Promise.all(
        workers.map(async (worker) => {
          try {
            const workerStatus = await readJson(worker.statusPath, WorkerStatusSchema);
            return {
              label: worker.label,
              role: worker.role,
              state: workerStatus.state,
              status: formatWorkerRuntimeStatus(workerStatus)
            };
          } catch {
            return null;
          }
        })
      );

      if (!active) {
        return;
      }

      setStatus((current) => {
        if (!current) {
          return current;
        }

        const next: StatusLineState = { ...current };
        next.workers = updates
          .filter((update): update is NonNullable<typeof update> => update !== null)
          .map((update) => ({
            label: update.label,
            status: update.status
          }));
        for (const update of updates) {
          if (update) {
            next[update.role] = update.status;
          }
        }
        return next;
      });
      const failedWorkerIndex = updates.findIndex((update) => update?.state === "failed");
      if (
        config.ui.autoOpenFailedWorker &&
        failedWorkerIndex >= 0 &&
        !autoSelectedFailedWorkerRef.current &&
        !userSelectedWorkerRef.current
      ) {
        autoSelectedFailedWorkerRef.current = true;
        selectedWorkerIndexRef.current = failedWorkerIndex;
        setSelectedWorkerIndex(failedWorkerIndex);
        setWorkerScrollOffset(0);
        if (viewRef.current !== "native") {
          setView("worker");
        }
      }
    }

    void refreshWorkerStatuses();
    const interval = setInterval(() => {
      void refreshWorkerStatuses();
    }, 1000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [config.ui.autoOpenFailedWorker, status?.taskId, workers]);

  useEffect(() => {
    setRawMode(true);
    process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    const handleRawInput = (data: unknown) => {
      const chunk = rawInputDecoderRef.current.write(Buffer.isBuffer(data) ? data : String(data ?? ""));
      if (!chunk) {
        return;
      }
      const currentView = viewRef.current;
      if (currentView === "worker") {
        if (isExitShortcut(chunk, {})) {
          exitRef.current();
          return;
        }
        if (chunk === "\x1b") {
          userSelectedWorkerRef.current = true;
          setView("chat");
          return;
        }
        const delta = mouseScrollDelta(chunk, 3);
        if (delta !== 0) {
          setWorkerScrollOffset((current) => nextScrollOffset(current, delta, workerMaxScrollOffsetRef.current));
        }
        return;
      }

      if (currentView === "chat") {
        if (chunk === "\x1b") {
          userSelectedWorkerRef.current = true;
          setView("chat");
          return;
        }
        const wheelDelta = mouseScrollDelta(chunk, 3);
        if (wheelDelta !== 0 && workersRef.current.length > 0) {
          setView("worker");
          setWorkerScrollOffset((current) => nextScrollOffset(current, wheelDelta, workerMaxScrollOffsetRef.current));
          return;
        }
        if (chunk === "\u0017") {
          setView("worker");
          setWorkerScrollOffset(0);
          return;
        }
        if (chunk === "\u000f") {
          const worker = workersRef.current[selectedWorkerIndexRef.current];
          if (!worker) {
            setAttachError("No worker selected. Run a complex task or wait for workers to load before attaching.");
            return;
          }
          void attachSelectedWorkerRef.current(worker);
          return;
        }
        if (chunk === "\t" && workersRef.current.length > 0) {
          const nextIndex = (selectedWorkerIndexRef.current + 1) % workersRef.current.length;
          userSelectedWorkerRef.current = true;
          selectedWorkerIndexRef.current = nextIndex;
          setSelectedWorkerIndex(nextIndex);
          setView("worker");
          setWorkerScrollOffset(0);
          return;
        }

        const update = applyChatInputChunk(inputRef.current, chunk);
        inputRef.current = update.value;
        if (update.exit) {
          exitRef.current();
          return;
        }
        if (!busyRef.current) {
          setInput(update.value);
        }
        if (update.submit !== null) {
          void submitRef.current(update.submit);
        }
        return;
      }

      const nativeWheelDelta = mouseScrollDelta(chunk, Math.max(3, Math.floor(outputHeight / 2)));
      if (nativeWheelDelta !== 0) {
        nativeAttachRef.current?.screen.scrollLines(-nativeWheelDelta);
        setNativeAttach((current) =>
          current
            ? {
                ...current,
                snapshot: current.screen.snapshot()
              }
            : current
        );
        return;
      }

      const update = applyNativeInputChunk(nativeInputRef.current, chunk, outputHeight - 1);
      if (update.exit) {
        nativeAttachRef.current?.process.kill();
        nativeAttachRef.current = null;
        nativeInputRef.current = "";
        setNativeAttach(null);
        setNativeInput("");
        setView("worker");
        return;
      }
      if (update.scrollDelta !== 0) {
        nativeAttachRef.current?.screen.scrollLines(-update.scrollDelta);
        setNativeAttach((current) =>
          current
            ? {
                ...current,
                snapshot: current.screen.snapshot()
              }
            : current
        );
        return;
      }

      nativeInputRef.current = update.draft;
      setNativeInput(update.draft);
      if (update.outbound) {
        nativeAttachRef.current?.process.write(update.outbound);
      }
    };

    stdinEvents.on("input", handleRawInput);
    return () => {
      stdinEvents.removeListener("input", handleRawInput);
      rawInputDecoderRef.current.end();
      process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
      setRawMode(false);
    };
  }, [outputHeight, setRawMode, stdinEvents]);

  useInput((inputKey, key) => {
    if (view === "worker") {
      if (isExitShortcut(inputKey, key)) {
        exitRef.current();
        return;
      }
      const delta = scrollDelta(inputKey, key, outputHeight - 1);
      if (delta !== 0) {
        setWorkerScrollOffset((current) => nextScrollOffset(current, delta, workerMaxScrollOffset));
        return;
      }
    }

    if (key.escape) {
      userSelectedWorkerRef.current = true;
      setView("chat");
      return;
    }
    if (isLogsShortcut(inputKey, key)) {
      setView("worker");
      setWorkerScrollOffset(0);
    }
    if ((key.tab || inputKey === "\t") && workers.length > 0) {
      userSelectedWorkerRef.current = true;
      setSelectedWorkerIndex((index) => (index + 1) % workers.length);
      setView("worker");
      setWorkerScrollOffset(0);
    }
    if (isAttachShortcut(inputKey, key)) {
      const worker = workers[selectedWorkerIndex];
      if (!worker) {
        setAttachError("No worker selected. Run a complex task or wait for workers to load before attaching.");
        return;
      }
      void attachSelectedWorker(worker);
    }
  }, { isActive: view !== "native" && view !== "chat" });

  async function attachSelectedWorker(worker: WorkerLogRef) {
    setAttachError(null);
    try {
      const launch = await (prepareNativeAttach
        ? prepareNativeAttach(worker)
        : buildNativeAttachLaunch({
            config,
            worker
          }));
      const terminalCols = process.stdout.columns || 120;
      const nativeTerminalCols = nativeAttachTerminalColumns(terminalCols);
      const terminalRows = Math.max(1, contentHeight - 2);
      const screen = new NativeTerminalScreen({
        cols: nativeTerminalCols,
        rows: terminalRows
      });
      const sizedLaunch: NativeAttachLaunch = {
        ...launch,
        cols: nativeTerminalCols,
        rows: terminalRows
      };
      const processRef = (startNativeAttach ?? startNativeAttachProcess)(sizedLaunch, {
        onOutput: (chunk) => {
          void screen.write(chunk).then(() => {
            setNativeAttach((current) =>
              current && current.screen === screen
                ? {
                    ...current,
                    snapshot: screen.snapshot()
                  }
                : current
            );
          });
        },
        onClose: (code) => {
          void screen.write(`\r\n${nativeAttachExitLine(code, nativeTerminalCols)}\r\n`).then(() => {
            setNativeAttach((current) =>
              current && current.screen === screen
                ? {
                    ...current,
                    closedCode: code,
                    snapshot: screen.snapshot()
                  }
                : current
            );
          });
        },
        onError: (error) => {
          setAttachError(error.message);
        }
      });
      setNativeAttach({
        launch: sizedLaunch,
        process: processRef,
        screen,
        snapshot: screen.snapshot(),
        closedCode: null
      });
      setNativeInput("");
      setView("native");
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : String(error));
    }
  }

  async function submit(value: string) {
    const request = value.trim();
    if (!request || busyRef.current) {
      return;
    }

    inputRef.current = "";
    setInput("");
    busyRef.current = true;
    setBusy(true);
    setMessages((current) => [...current, { from: "user", text: request }]);

    try {
      const callbacks = {
        onStatus: setStatus,
        onWorker: (worker: WorkerLogRef) => {
          setWorkers((current) => upsertWorker(current, worker));
        }
      };
      const memory = {
        activeTaskId,
        activeMode
      };
      const followUpRoute =
        activeTaskId && activeMode === "complex"
          ? await orchestrator.routeTaskFollowUp({
              request,
              cwd,
              taskId: activeTaskId,
              ...callbacks
            })
          : undefined;
      const target = chooseSubmitTarget(memory, followUpRoute);
      if (shouldClearWorkersForSubmit(target)) {
        setWorkers([]);
        selectedWorkerIndexRef.current = 0;
        autoSelectedFailedWorkerRef.current = false;
        userSelectedWorkerRef.current = false;
        setSelectedWorkerIndex(0);
        setWorkerScrollOffset(0);
        setWorkerMaxScrollOffset(0);
      }
      const result =
        target.kind === "task-turn"
          ? await orchestrator.handleTaskTurn({
              request,
              cwd,
              taskId: target.taskId,
              ...callbacks
            })
          : target.kind === "task-question"
            ? await orchestrator.answerTaskQuestion({
                request,
                cwd,
                taskId: target.taskId,
                ...callbacks
              })
          : await orchestrator.handleRequest({
              request,
              cwd,
              ...callbacks
            });

      const nextMemory = nextSubmitMemoryState(
        memory,
        target,
        result
      );
      setActiveMode(nextMemory.activeMode);
      setActiveTaskId(nextMemory.activeTaskId);
      setMessages((current) => [...current, { from: "system", text: result.summary }]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { from: "system", text: error instanceof Error ? error.message : String(error) }
      ]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <AppShell
      view={view}
      cwd={cwd}
      taskId={activeTaskId}
      statusText={`${formatStatusLine(status)}${visibleWorkerStatus ? ` | ${visibleWorkerStatus}` : ""}`}
      contentHeight={contentHeight}
      showStatusBar={config.ui.showStatusBar}
      input={
        <InputBar
          mode={view}
          busy={busy}
          hasWorkers={workers.length > 0}
          nativeClosed={view === "native" && nativeAttach?.closedCode !== null}
          value={view === "native" ? "" : input}
          terminalWidth={terminalWidth}
          onChange={view === "native" ? setNativeInput : setInput}
          onSubmit={view === "native" ? undefined : submit}
        />
      }
      error={attachError}
    >
        {view === "native" ? (
          <NativeAttachView attach={nativeAttach} />
        ) : view === "chat" ? (
          <ChatView
            messages={messages}
            cwd={cwd}
            activeTaskId={activeTaskId}
            terminalWidth={terminalWidth}
            viewportHeight={contentHeight}
          />
        ) : (
          <WorkerOutputView
            title={workerTitle(workers, selectedWorkerIndex)}
            role={workers[selectedWorkerIndex]?.role}
            logPath={workers[selectedWorkerIndex]?.logPath ?? null}
            scrollOffset={workerScrollOffset}
            height={Math.max(1, outputHeight - 1)}
            terminalWidth={terminalWidth}
            onViewportChange={({ offset, maxOffset }) => {
              setWorkerMaxScrollOffset(maxOffset);
              if (offset !== workerScrollOffset) {
                setWorkerScrollOffset(offset);
              }
            }}
          />
        )}
    </AppShell>
  );
}

export function ChatView({
  messages,
  cwd,
  activeTaskId,
  terminalWidth = process.stdout.columns || 120,
  viewportHeight
}: {
  messages: Message[];
  cwd: string;
  activeTaskId: string | null;
  terminalWidth?: number;
  viewportHeight?: number;
}) {
  const height = viewportHeight ? Math.max(1, viewportHeight) : undefined;
  if (messages.length === 0) {
    const spacerLines = chatViewportSpacerLineCount(1, height);

    return (
      <Box flexDirection="column" height={height}>
        <ChatViewportSpacerLines count={spacerLines} terminalWidth={terminalWidth} />
        <ChatEmptyState cwd={cwd} activeTaskId={activeTaskId} terminalWidth={terminalWidth} />
      </Box>
    );
  }
  const lines = chatMessageDisplayLines(messages, terminalWidth, height ?? 12);
  const spacerLines = chatViewportSpacerLineCount(lines.length, height);

  return (
    <Box flexDirection="column" height={height}>
      <ChatViewportSpacerLines count={spacerLines} terminalWidth={terminalWidth} />
      {lines.map((line, index) => (
        <Text
          key={`${line.from}-${index}`}
          {...chatLineTheme(line)}
        >
          {line.text || " "}
        </Text>
      ))}
    </Box>
  );
}

export function chatLineTheme(line: ChatDisplayLine): ChatLineTheme {
  if (line.from === "user") {
    return { backgroundColor: TUI_THEME.surface, color: TUI_THEME.accent };
  }
  if (!line.text.trim()) {
    return { backgroundColor: TUI_THEME.surface, color: TUI_THEME.muted, dimColor: true };
  }
  return { backgroundColor: TUI_THEME.surface, color: TUI_THEME.text };
}

export function chatMessageDisplayLines(messages: Message[], terminalWidth: number, maxLines = 12): ChatDisplayLine[] {
  const contentWidth = Math.max(8, terminalWidth - 2);
  const rendered = messages.flatMap((message) => chatSingleMessageDisplayLines(message, contentWidth));
  return rendered.slice(-maxLines);
}

export function chatViewportBlankLineTheme(): ChatViewportBlankLineTheme {
  return {
    backgroundColor: TUI_THEME.surface
  };
}

function ChatViewportSpacerLines({ count, terminalWidth }: { count: number; terminalWidth: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <Text key={`chat-spacer-${index}`} {...chatViewportBlankLineTheme()}>
          {" ".repeat(chatViewportBlankLineWidth(terminalWidth))}
        </Text>
      ))}
    </>
  );
}

function chatViewportSpacerLineCount(contentLines: number, viewportHeight: number | undefined): number {
  return viewportHeight ? Math.max(0, viewportHeight - contentLines) : 0;
}

function chatViewportBlankLineWidth(terminalWidth: number): number {
  return Math.max(1, Math.max(8, terminalWidth - 2));
}

function chatSingleMessageDisplayLines(message: Message, contentWidth: number): ChatDisplayLine[] {
  const rawLines = message.from === "system"
    ? chatSystemDisplayLines(message.text)
    : message.text.split(/\r?\n/);
  const rendered: ChatDisplayLine[] = [];

  rawLines.forEach((rawLine, rawIndex) => {
    const isFirstRawLine = rawIndex === 0;
    const firstPrefix = message.from === "user" && isFirstRawLine ? "> " : message.from === "user" ? "  " : "";
    const wrapWidth = Math.max(1, contentWidth - displayWidth(firstPrefix));
    const wrapped = wrapByDisplayWidth(rawLine, wrapWidth);

    wrapped.forEach((chunk, chunkIndex) => {
      const continuation = !isFirstRawLine || chunkIndex > 0;
      const prefix = chatLinePrefix(message.from, rawLine, continuation, chunkIndex > 0);
      const lineWidth = Math.max(1, contentWidth - displayWidth(prefix));
      const fitted = displayWidth(chunk) > lineWidth
        ? wrapByDisplayWidth(chunk, lineWidth)
        : [chunk];
      fitted.forEach((part, partIndex) => {
        rendered.push({
          from: message.from,
          text: `${prefix}${part}`,
          continuation: continuation || partIndex > 0
        });
      });
    });
  });

  return rendered;
}

function chatLinePrefix(
  from: Message["from"],
  rawLine: string,
  continuation: boolean,
  wrappedContinuation: boolean
): string {
  if (from === "user") {
    return continuation ? "  " : "> ";
  }
  if (from === "system" && wrappedContinuation && isCompactChatSummaryLine(rawLine)) {
    return "  ";
  }
  return "";
}

function chatSystemDisplayLines(text: string): string[] {
  return compactSupervisorSummaryForChat(text) ?? text.split(/\r?\n/);
}

function compactSupervisorSummaryForChat(text: string): string[] | null {
  const rawLines = text.split(/\r?\n/);
  if (!/^Complex task completed\.$/i.test((rawLines[0] ?? "").trim())) {
    return null;
  }

  const sections = [
    { label: "requirements", heading: "Requirements:" },
    { label: "actor", heading: "Actor work:" },
    { label: "review", heading: "Critic review:" },
    { label: "findings", heading: "Critic findings:" }
  ];
  const indexes = sections.map((section) => rawLines.findIndex((line) => line.trim() === section.heading));
  if (indexes.every((index) => index < 0)) {
    return null;
  }

  return [
    "done · complex task completed",
    ...sections.map((section, index) => {
      const start = indexes[index] ?? -1;
      const nextStarts = indexes.slice(index + 1).filter((item) => item > start);
      const end = nextStarts.length > 0 ? Math.min(...nextStarts) : rawLines.length;
      const value = start >= 0 ? chatSummarySectionValue(rawLines.slice(start + 1, end)) : "none";
      return `${section.label} · ${value}`;
    })
  ];
}

function chatSummarySectionValue(lines: string[]): string {
  for (const line of lines) {
    const cleaned = cleanChatSummaryLine(line);
    if (cleaned && !isChatSummaryHeading(cleaned)) {
      return cleaned;
    }
  }
  return "none";
}

function cleanChatSummaryLine(line: string): string {
  const cleaned = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .trim();
  return cleaned === "(empty)" ? "none" : cleaned;
}

function isChatSummaryHeading(line: string): boolean {
  return /^(?:requirements|actor work|worklog|critic review|review|critic findings)$/i.test(line);
}

function isCompactChatSummaryLine(line: string): boolean {
  return /^(?:done|requirements|actor|review|findings) · /i.test(line.trim());
}

function ChatEmptyState({
  cwd,
  activeTaskId,
  terminalWidth
}: {
  cwd: string;
  activeTaskId: string | null;
  terminalWidth: number;
}) {
  const contentWidth = Math.max(8, terminalWidth - 2);

  return (
    <Box flexDirection="column">
      <Text {...chatEmptyStateTheme()}>{chatEmptyStateDisplayLine(cwd, activeTaskId, contentWidth)}</Text>
    </Box>
  );
}

export function chatEmptyStateTheme(): ChatEmptyStateTheme {
  return {
    backgroundColor: TUI_THEME.surface,
    bold: true,
    color: TUI_THEME.success
  };
}

function chatEmptyStateDisplayLine(cwd: string, activeTaskId: string | null, contentWidth: number): string {
  const project = compactChatWorkspace(cwd);
  const task = activeTaskId ? compactChatTaskId(activeTaskId) : "";
  if (contentWidth < 14) {
    return compactChatText(project || task || "ready", contentWidth);
  }
  const roomyPrefix = task ? `ready · ${project} · ` : "ready · ";
  const roomyValue = task || project;
  const roomy = `${roomyPrefix}${compactChatText(roomyValue, Math.max(1, contentWidth - displayWidth(roomyPrefix)))}`;
  if (displayWidth(roomy) <= contentWidth && !roomy.endsWith(" · ") && displayWidth(roomyValue) <= Math.max(0, contentWidth - displayWidth(roomyPrefix))) {
    return roomy;
  }

  const readyPrefix = "ready · ";
  const readyProject = `${readyPrefix}${compactChatText(project, Math.max(1, contentWidth - displayWidth(readyPrefix)))}`;
  if (displayWidth(project) <= Math.max(0, contentWidth - displayWidth(readyPrefix)) && displayWidth(readyProject) <= contentWidth) {
    return readyProject;
  }

  const readyValue = task || project;
  const readyCompact = `${readyPrefix}${compactChatText(readyValue, Math.max(1, contentWidth - displayWidth(readyPrefix)))}`;
  if (displayWidth(readyCompact) <= contentWidth && !readyCompact.endsWith(" · ")) {
    return readyCompact;
  }

  const compactPrefix = task ? `${project} · ` : readyPrefix;
  const compactValue = task || project;
  const compact = `${compactPrefix}${compactChatText(compactValue, Math.max(1, contentWidth - displayWidth(compactPrefix)))}`;
  if (displayWidth(compact) <= contentWidth && !compact.endsWith(" · ")) {
    return compact;
  }

  return compactChatText(task || project || "ready", contentWidth);
}

function compactChatWorkspace(cwd: string): string {
  return basename(cwd) || cwd;
}

function compactChatTaskId(taskId: string | null): string {
  if (!taskId) {
    return "none";
  }
  const match = taskId.match(/^task-\d{8}-(.+)$/);
  if (match) {
    return match[1] ?? taskId;
  }
  return taskId.startsWith("task-") ? taskId.slice("task-".length) : taskId;
}

function compactChatText(text: string, maxLength: number): string {
  if (maxLength <= 5) {
    return takeChatTextStartByDisplayWidth(text, maxLength);
  }
  return compactEndByDisplayWidth(text, maxLength);
}

function takeChatTextStartByDisplayWidth(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }
  if (displayWidth(text) <= maxLength) {
    return text;
  }

  let result = "";
  let width = 0;
  for (const char of Array.from(text)) {
    const charWidth = displayWidth(char);
    if (width + charWidth > maxLength) {
      break;
    }
    result += char;
    width += charWidth;
  }
  return result;
}

function upsertWorker(workers: WorkerLogRef[], worker: WorkerLogRef): WorkerLogRef[] {
  const existingIndex = workers.findIndex((item) => item.id === worker.id);
  if (existingIndex >= 0) {
    return workers.map((item, index) => (index === existingIndex ? worker : item));
  }
  return [...workers, worker];
}

function workerTitle(workers: WorkerLogRef[], selectedWorkerIndex: number): string {
  const worker = workers[selectedWorkerIndex];
  if (!worker) {
    return "Worker Output";
  }
  return `${worker.label} output (${selectedWorkerIndex + 1}/${workers.length})`;
}

export function appContentHeight(rows: number, hasError = false, showStatusBar = true): number {
  const headerRows = 1;
  const inputRows = 1;
  const statusRows = showStatusBar ? 1 : 0;
  const errorRows = hasError ? 1 : 0;
  return Math.max(2, rows - headerRows - inputRows - statusRows - errorRows);
}

function NativeAttachView({
  attach
}: {
  attach: {
    launch: NativeAttachLaunch;
    snapshot: string;
    screen: NativeTerminalScreen;
    closedCode: number | null;
  } | null;
}) {
  if (!attach) {
    return <Text {...nativeAttachStartingTheme()}>Starting native attach...</Text>;
  }
  const terminalWidth = process.stdout.columns || 120;
  const panelWidth = nativeAttachPanelRailWidth(terminalWidth);
  const scroll = attach.screen.scrollState();
  const scrollLabel = nativeTerminalScrollDisplay(scroll.offset, scroll.maxOffset, terminalWidth);
  const title = nativeAttachTitleDisplay(
    attach.launch.label,
    attach.launch.sessionId,
    attach.closedCode,
    panelWidth,
    scrollLabel
  );

  return (
    <Box flexDirection="column">
      <NativeAttachTitleRail title={title} width={panelWidth} />
      <TerminalOutput lines={attach.screen.styledSnapshotLines({ showCursor: true })} />
    </Box>
  );
}

export function nativeAttachStartingTheme(): NativeAttachStartingTheme {
  return {
    backgroundColor: TUI_THEME.surface,
    color: TUI_THEME.muted,
    dimColor: true
  };
}

function NativeAttachTitleRail({ title, width }: { title: string; width: number }) {
  const titleText = ` ${title} `;
  const renderWidth = typeof process.stdout.columns === "number"
    ? width
    : null;
  const trailingWidth = renderWidth === null
    ? 0
    : Math.max(0, renderWidth - displayWidth(titleText));

  return (
    <Box>
      <Text backgroundColor={TUI_THEME.chrome} color={TUI_THEME.text} bold>{titleText}</Text>
      {trailingWidth > 0 ? <Text backgroundColor={TUI_THEME.chrome}>{" ".repeat(trailingWidth)}</Text> : null}
    </Box>
  );
}

function nativeAttachPanelRailWidth(terminalWidth: number): number {
  const renderWidth = typeof process.stdout.columns === "number"
    ? Math.max(1, Math.min(terminalWidth, process.stdout.columns))
    : terminalWidth;
  return Math.max(1, renderWidth - 4);
}

export function nativeAttachTitleDisplay(
  label: string,
  sessionId: string,
  closedCode: number | null,
  terminalWidth = process.stdout.columns || 120,
  scrollLabel: string | null = null
): string {
  const exit = closedCode === null ? "" : `exit:${closedCode}`;
  const contentWidth = Math.max(1, terminalWidth - 2);

  if (terminalWidth < 24) {
    return tinyNativeAttachTitle(label, exit ? ` ${exit}` : "", contentWidth);
  }

  const compactLabel = compactNativeAttachLabel(label);
  const roleLabel = compactNativeAttachRole(label);

  if (exit) {
    return firstNativeTitleThatFits(withNativeTitleSuffix([
      `native ${compactLabel} · ${exit}`,
      `native ${roleLabel} · ${exit}`,
      `${roleLabel} ${exit}`
    ], scrollLabel), contentWidth);
  }

  const prefix = `native ${compactLabel}`;
  const separator = " · ";
  const sessionBudget = Math.max(0, contentWidth - displayWidth(prefix) - displayWidth(separator));
  const session = sessionBudget > 3 ? compactNativeSessionForTitle(sessionId, sessionBudget) : "";
  return firstNativeTitleThatFits(withNativeTitleSuffix([
    session ? `${prefix}${separator}${session}` : prefix,
    prefix,
    `native ${roleLabel}`,
    roleLabel
  ], scrollLabel), contentWidth);
}

export function nativeTerminalScrollDisplay(offset: number, maxOffset: number, width: number): string | null {
  if (maxOffset <= 0) {
    return null;
  }
  if (offset <= 0) {
    return "tail";
  }
  if (offset >= maxOffset) {
    return "top";
  }
  return width < 32 ? `${offset}/${maxOffset}` : `back ${offset}/${maxOffset}`;
}

export function nativeAttachTerminalColumns(terminalWidth = process.stdout.columns || 120): number {
  return Math.max(1, terminalWidth - 2);
}

export function nativeAttachExitLine(code: number, nativeTerminalCols: number): string {
  const contentWidth = Math.max(1, nativeTerminalCols);
  const candidates = [
    `[process exited with code ${code}]`,
    `[exit ${code}]`,
    `exit:${code}`
  ];
  return firstNativeTitleThatFits(candidates, contentWidth);
}

function withNativeTitleSuffix(candidates: string[], suffix: string | null): string[] {
  const cleanSuffix = suffix?.trim();
  if (!cleanSuffix) {
    return candidates;
  }
  return [
    ...candidates.map((candidate) => `${candidate} · ${cleanSuffix}`),
    ...candidates
  ];
}

function firstNativeTitleThatFits(candidates: string[], contentWidth: number): string {
  for (const candidate of candidates) {
    if (displayWidth(candidate) <= contentWidth) {
      return candidate;
    }
  }
  return compactEndByDisplayWidth(candidates.at(-1) ?? "", contentWidth);
}

function tinyNativeAttachTitle(label: string, exit: string, contentWidth: number): string {
  const compactLabel = compactNativeAttachLabel(label);
  const roleLabel = compactNativeAttachRole(label);

  if (exit) {
    const roleExit = `${roleLabel}${exit}`;
    if (displayWidth(roleExit) <= contentWidth) {
      return roleExit;
    }
    const exitOnly = exit.trim();
    return displayWidth(exitOnly) <= contentWidth ? exitOnly : compactEndByDisplayWidth(exitOnly, contentWidth);
  }

  for (const candidate of [`native ${compactLabel}`, compactLabel, roleLabel]) {
    if (displayWidth(candidate) <= contentWidth) {
      return candidate;
    }
  }

  return compactEndByDisplayWidth(roleLabel, contentWidth);
}

function compactNativeAttachLabel(label: string): string {
  const match = label.match(/^\s*([^(]+?)\s*\(([^)]+)\)\s*$/);
  if (match) {
    return `${(match[1] ?? "").trim().toLowerCase()}/${(match[2] ?? "").trim().toLowerCase()}`;
  }
  return label.trim().toLowerCase().replace(/\s+/g, "/");
}

function compactNativeAttachRole(label: string): string {
  const match = label.match(/^\s*([^(]+?)\s*(?:\([^)]+\))?\s*$/);
  return (match?.[1] ?? label).trim().toLowerCase().replace(/\s+/g, "/");
}

function compactNativeSessionForTitle(sessionId: string, maxLength: number): string {
  return compactEndByDisplayWidth(sessionId, Math.min(maxLength, 16));
}
