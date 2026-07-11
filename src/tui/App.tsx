import React, { useEffect, useMemo, useRef, useState } from "react";
import { basename } from "node:path";
import { Box, Text, useApp, useInput, useStdin, type TextProps } from "ink";
import { Lexer, type Token, type Tokens } from "marked";
import type { AppConfig } from "../core/config.js";
import type { CollaborationTimeline } from "../core/collaboration-timeline.js";
import { readJson } from "../core/file-store.js";
import type { RouterAuditRecord } from "../core/router-audit.js";
import type { TaskIndexSummary } from "../core/session-index.js";
import type { WorkspaceChoice } from "../core/workspace.js";
import { WorkerStatusSchema, type RouteDecision } from "../domain/schemas.js";
import type {
  Orchestrator,
  RouteFallbackChoice,
  RouteFallbackInfo,
  RouteStartInfo,
  WorkerLogRef,
  WorkerRunStatus
} from "../orchestrator/orchestrator.js";
import {
  formatRoutePendingStatus,
  formatSelectedWorkerStatus,
  formatRouteStatus,
  formatStatusLine,
  formatWorkerRuntimeStatus,
  selectedWorkerStatusIsRedundant,
  type StatusLineState
} from "./status-line.js";
import { applyChatInputChunk, insertChatPaste } from "./chat-input.js";
import { chatRequestHistory, navigateChatDraftHistory, type ChatDraftHistoryState } from "./chat-history.js";
import { createChatPasteDecoder } from "./chat-paste.js";
import { AppShell, type AppView } from "./AppShell.js";
import { InputBar } from "./InputBar.js";
import { applyNativeInputChunk } from "./native-input.js";
import { nextScrollOffset } from "./scrolling.js";
import { chooseSubmitTarget, newTaskMemoryState, nextSubmitMemoryState, shouldClearWorkersForSubmit } from "./task-memory.js";
import { TerminalOutput } from "./TerminalOutput.js";
import { NativeTerminalScreen } from "./terminal-screen.js";
import { WorkerOutputView, type WorkerOutputNavigationTargets } from "./WorkerOutputView.js";
import { compactEndByDisplayWidth, displayWidth, wrapByDisplayWidth } from "./display-width.js";
import { isAttachShortcut, isExitShortcut, isLogsShortcut, isNewTaskShortcut, isRouterDiagnosticsShortcut, isTaskSessionsShortcut, isWorkerOverviewShortcut, isWorkerSearchShortcut, isWorkspaceShortcut, mouseScrollDelta, rawHistoryDelta, rawPageScrollDelta, scrollDelta, workerLogJumpKind } from "./keyboard.js";
import { createRawInputDecoder, tokenizeRawInput } from "./raw-input-decoder.js";
import { decodeHtmlEntities } from "./markdown-text.js";
import { configureTuiTheme, TUI_THEME } from "./theme.js";
import { WorkspacePicker } from "../cli-workspace-picker.js";
import {
  RouterDiagnosticsView,
  routerDiagnosticsPolicy,
  type RouterDiagnosticsPolicy,
  type RouterDiagnosticsScope
} from "./RouterDiagnosticsView.js";
import { moveWorkerSelection, WorkerOverviewView } from "./WorkerOverviewView.js";
import { FeatureBoardView, moveFeatureBoardSelection } from "./FeatureBoardView.js";
import {
  CollaborationTimelineView,
  collaborationSelectionScrollOffset,
  collaborationTimelineEvents,
  moveCollaborationEventSelection,
  nextCollaborationFeatureIndex
} from "./CollaborationTimelineView.js";
import { moveTaskSessionSelection, TaskSessionsView } from "./TaskSessionsView.js";
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
  initialRoute?: RouteDecision | null;
  initialWorkers?: WorkerLogRef[];
  initialCanRetryTask?: boolean;
  initialMessages?: Message[];
  persistChatMessage?: (message: Message, taskId?: string) => Promise<void>;
  workspaceChoices?: WorkspaceChoice[];
  switchWorkspace?: (workspace: string) => Promise<void>;
  loadRouterDiagnostics?: () => Promise<{
    records: RouterAuditRecord[];
    policy: RouterDiagnosticsPolicy;
  }>;
  loadTaskSessions?: () => Promise<TaskIndexSummary[]>;
  loadCollaborationTimeline?: (taskId: string) => Promise<CollaborationTimeline>;
  activateTaskSession?: (taskId: string | null) => Promise<ActivatedTaskSession | null>;
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

export interface ActivatedTaskSession {
  taskId: string;
  route: RouteDecision | null;
  workers: WorkerLogRef[];
  canRetry: boolean;
}

export interface Message {
  from: "user" | "system";
  text: string;
}

export interface ChatDisplayLine {
  from: Message["from"];
  text: string;
  continuation: boolean;
  spans?: ChatDisplaySpan[];
  background?: ChatLineBackground;
}

export type ChatLineBackground = "surface" | "rail";
export type ChatSpanTone = "text" | "strong" | "emphasis" | "code" | "link" | "muted" | "prefix" | "heading" | "success";
export interface ChatDisplaySpan {
  text: string;
  tone: ChatSpanTone;
}

interface ChatMarkdownLine {
  spans: ChatDisplaySpan[];
  background?: ChatLineBackground;
  continuationPrefix?: string;
}

type ChatLineTheme = Pick<TextProps, "backgroundColor" | "color">;
type ChatSpanTheme = Pick<TextProps, "backgroundColor" | "bold" | "color" | "italic" | "underline">;
type ChatEmptyStateTheme = Pick<TextProps, "backgroundColor" | "bold" | "color">;
type ChatViewportBlankLineTheme = Pick<TextProps, "backgroundColor">;
type PendingRouteInfo = RouteStartInfo & { startedAtMs: number };
interface WorkerSearchState {
  open: boolean;
  query: string;
  cursor: number;
  matchIndex: number;
}
type NativeAttachStartingTheme = Pick<TextProps, "backgroundColor" | "color">;
const NO_WORKERS_ATTACH_MESSAGE = "No workers yet · start a complex task before attaching";
const NO_WORKERS_LOGS_MESSAGE = "No workers yet · start a complex task before opening logs";
const NO_WORKERS_OVERVIEW_MESSAGE = "No workers yet · start a complex task before opening overview";
const NO_ACTIVE_COLLABORATION_MESSAGE = "No active task · restore a task before opening timeline";
const NO_ACTIVE_FEATURES_MESSAGE = "No active task · restore a task before opening features";
const EMPTY_WORKER_NAVIGATION_TARGETS: WorkerOutputNavigationTargets = {
  searchOffsets: [],
  searchLineIndexes: [],
  errorOffsets: [],
  diffOffsets: []
};

export function App({
  config,
  orchestrator,
  cwd,
  initialTaskId = null,
  initialRoute = null,
  initialWorkers,
  initialCanRetryTask = false,
  initialMessages = [],
  persistChatMessage,
  workspaceChoices = [],
  switchWorkspace,
  loadRouterDiagnostics,
  loadTaskSessions,
  loadCollaborationTimeline,
  activateTaskSession,
  prepareNativeAttach,
  startNativeAttach
}: AppProps) {
  configureTuiTheme({
    theme: config.ui.theme,
    colors: config.ui.colors
  });

  const [input, setInput] = useState("");
  const [inputCursor, setInputCursor] = useState(0);
  const [inputReady, setInputReady] = useState(false);
  const [messages, setMessages] = useState<Message[]>(() => [...initialMessages]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusLineState | null>(() => restoredWorkerStatusLine(initialTaskId, initialWorkers));
  const [lastRoute, setLastRoute] = useState<RouteDecision | null>(initialRoute);
  const [routePending, setRoutePending] = useState<PendingRouteInfo | null>(null);
  const [routeElapsedMs, setRouteElapsedMs] = useState(0);
  const [routeFallbackPrompt, setRouteFallbackPrompt] = useState<RouteFallbackInfo | null>(null);
  const [view, setView] = useState<AppView | "workspace">("chat");
  const [workers, setWorkers] = useState<WorkerLogRef[]>(() => [...(initialWorkers ?? [])]);
  const [selectedWorkerIndex, setSelectedWorkerIndex] = useState(0);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(initialTaskId);
  const [activeMode, setActiveMode] = useState<"simple" | "complex" | null>(initialTaskId ? "complex" : null);
  const [canRetryTask, setCanRetryTask] = useState(initialCanRetryTask);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [nativeInput, setNativeInput] = useState("");
  const [workerScrollOffset, setWorkerScrollOffset] = useState(0);
  const [workerMaxScrollOffset, setWorkerMaxScrollOffset] = useState(0);
  const [workerSearch, setWorkerSearch] = useState<WorkerSearchState>({
    open: false,
    query: "",
    cursor: 0,
    matchIndex: 0
  });
  const [workerNavigationTargets, setWorkerNavigationTargets] = useState<WorkerOutputNavigationTargets>(
    EMPTY_WORKER_NAVIGATION_TARGETS
  );
  const [chatScrollOffset, setChatScrollOffset] = useState(0);
  const [chatMaxScrollOffset, setChatMaxScrollOffset] = useState(0);
  const [routerRecords, setRouterRecords] = useState<RouterAuditRecord[]>([]);
  const [routerPolicy, setRouterPolicy] = useState<RouterDiagnosticsPolicy>(() => routerDiagnosticsPolicy(config.router));
  const [routerLoading, setRouterLoading] = useState(false);
  const [routerError, setRouterError] = useState<string | null>(null);
  const [routerScope, setRouterScope] = useState<RouterDiagnosticsScope>("all");
  const [routerScrollOffset, setRouterScrollOffset] = useState(0);
  const [routerMaxScrollOffset, setRouterMaxScrollOffset] = useState(0);
  const [taskSessions, setTaskSessions] = useState<TaskIndexSummary[]>([]);
  const [selectedTaskSessionIndex, setSelectedTaskSessionIndex] = useState(0);
  const [taskSessionsLoading, setTaskSessionsLoading] = useState(false);
  const [taskSessionsError, setTaskSessionsError] = useState<string | null>(null);
  const [collaborationTimeline, setCollaborationTimeline] = useState<CollaborationTimeline | null>(null);
  const [featureBoardSelectedIndex, setFeatureBoardSelectedIndex] = useState(0);
  const [collaborationLoading, setCollaborationLoading] = useState(false);
  const [collaborationError, setCollaborationError] = useState<string | null>(null);
  const [collaborationFeatureIndex, setCollaborationFeatureIndex] = useState(-1);
  const [collaborationSelectedEventId, setCollaborationSelectedEventId] = useState<string | null>(null);
  const [collaborationDetailOpen, setCollaborationDetailOpen] = useState(false);
  const [collaborationUnresolvedOnly, setCollaborationUnresolvedOnly] = useState(false);
  const [collaborationScrollOffset, setCollaborationScrollOffset] = useState(0);
  const [collaborationMaxScrollOffset, setCollaborationMaxScrollOffset] = useState(0);
  const [nativeAttach, setNativeAttach] = useState<{
    hasOutput: boolean;
    launch: NativeAttachLaunch;
    process: NativeAttachProcessRef;
    screen: NativeTerminalScreen;
    snapshot: string;
    closedCode: number | null;
  } | null>(null);
  const { exit } = useApp();
  const { setRawMode, internal_eventEmitter: stdinEvents } = useStdin();
  const nativeAttachRef = useRef(nativeAttach);
  const messagesRef = useRef<Message[]>([...initialMessages]);
  const activeRunControllerRef = useRef<AbortController | null>(null);
  const activeTaskIdRef = useRef<string | null>(initialTaskId);
  const nativeInputRef = useRef(nativeInput);
  const inputRef = useRef(input);
  const inputCursorRef = useRef(inputCursor);
  const viewRef = useRef(view);
  const busyRef = useRef(busy);
  const routeFallbackPromptRef = useRef<RouteFallbackInfo | null>(null);
  const routeFallbackResolverRef = useRef<((choice: RouteFallbackChoice) => void) | null>(null);
  const workersRef = useRef(workers);
  const selectedWorkerIndexRef = useRef(selectedWorkerIndex);
  const workerSearchRef = useRef(workerSearch);
  const workerNavigationTargetsRef = useRef(workerNavigationTargets);
  const workerJumpIndexRef = useRef({ error: -1, diff: -1 });
  const workerMaxScrollOffsetRef = useRef(workerMaxScrollOffset);
  const chatScrollOffsetRef = useRef(chatScrollOffset);
  const chatMaxScrollOffsetRef = useRef(chatMaxScrollOffset);
  const routerMaxScrollOffsetRef = useRef(routerMaxScrollOffset);
  const taskSessionsRef = useRef(taskSessions);
  const selectedTaskSessionIndexRef = useRef(selectedTaskSessionIndex);
  const taskSessionsLoadingRef = useRef(taskSessionsLoading);
  const collaborationTimelineRef = useRef<CollaborationTimeline | null>(null);
  const featureBoardSelectedIndexRef = useRef(0);
  const collaborationFeatureIndexRef = useRef(-1);
  const collaborationSelectedEventIdRef = useRef<string | null>(null);
  const collaborationDetailOpenRef = useRef(false);
  const collaborationUnresolvedOnlyRef = useRef(false);
  const collaborationMaxScrollOffsetRef = useRef(0);
  const autoSelectedFailedWorkerRef = useRef(false);
  const userSelectedWorkerRef = useRef(false);
  const attachSelectedWorkerRef = useRef<(worker: WorkerLogRef) => Promise<void>>(attachSelectedWorker);
  const submitRef = useRef<(value: string) => Promise<void>>(submit);
  const retryRef = useRef<() => Promise<void>>(retryActiveTask);
  const newTaskRef = useRef<() => Promise<void>>(startNewTask);
  const openWorkspacePickerRef = useRef<() => void>(openWorkspacePicker);
  const openRouterDiagnosticsRef = useRef<() => Promise<void>>(openRouterDiagnostics);
  const openWorkerOverviewRef = useRef<() => void>(openWorkerOverview);
  const openTaskSessionsRef = useRef<() => Promise<void>>(openTaskSessions);
  const openFeatureBoardRef = useRef<() => Promise<void>>(openFeatureBoard);
  const openCollaborationTimelineRef = useRef<(featureIndex?: number) => Promise<void>>(openCollaborationTimeline);
  const refreshCollaborationTimelineRef = useRef<(showLoading?: boolean) => Promise<void>>(refreshCollaborationTimeline);
  const activateSelectedTaskSessionRef = useRef<() => Promise<void>>(activateSelectedTaskSession);
  const workspaceReturnViewRef = useRef<"chat" | "worker" | "workers" | "sessions">("chat");
  const routerReturnViewRef = useRef<"chat" | "worker" | "workers" | "sessions">("chat");
  const workerOverviewReturnViewRef = useRef<"chat" | "worker">("chat");
  const taskSessionsReturnViewRef = useRef<"chat" | "worker" | "workers" | "router">("chat");
  const collaborationReturnViewRef = useRef<"workers" | "features">("workers");
  const collaborationLoadSequenceRef = useRef(0);
  const routerLoadSequenceRef = useRef(0);
  const taskSessionsLoadSequenceRef = useRef(0);
  const exitRef = useRef(exit);
  const rawInputDecoderRef = useRef(createRawInputDecoder());
  const chatPasteDecoderRef = useRef(createChatPasteDecoder());
  const chatDraftHistoryRef = useRef<ChatDraftHistoryState>({
    offset: 0,
    draft: { value: "", cursor: 0 }
  });

  const contentHeight = appContentHeight(process.stdout.rows || 30, Boolean(attachError), config.ui.showStatusBar);
  const outputHeight = Math.max(1, contentHeight);
  const terminalWidth = process.stdout.columns || 120;
  const selectedWorkerStatus = formatSelectedWorkerStatus(status, selectedWorkerIndex);
  const visibleWorkerStatus = view === "chat" || view === "router" || view === "sessions" || view === "features" || view === "collaboration" || selectedWorkerStatusIsRedundant(status)
    ? ""
    : selectedWorkerStatus;
  const visibleRouteStatus = routePending
    ? formatRoutePendingStatus(routePending, routeElapsedMs)
    : formatRouteStatus(lastRoute);
  const visibleTaskStatus = routePending && !activeTaskId ? "" : formatStatusLine(status);
  const workerRefreshKey = workers.map((worker) => `${worker.id}\u0000${worker.statusPath}`).join("\u0001");

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    inputCursorRef.current = inputCursor;
  }, [inputCursor]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    activeTaskIdRef.current = activeTaskId;
  }, [activeTaskId]);

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
    chatScrollOffsetRef.current = chatScrollOffset;
  }, [chatScrollOffset]);

  useEffect(() => {
    chatMaxScrollOffsetRef.current = chatMaxScrollOffset;
  }, [chatMaxScrollOffset]);

  useEffect(() => {
    routerMaxScrollOffsetRef.current = routerMaxScrollOffset;
  }, [routerMaxScrollOffset]);

  useEffect(() => {
    taskSessionsRef.current = taskSessions;
  }, [taskSessions]);

  useEffect(() => {
    selectedTaskSessionIndexRef.current = selectedTaskSessionIndex;
  }, [selectedTaskSessionIndex]);

  useEffect(() => {
    taskSessionsLoadingRef.current = taskSessionsLoading;
  }, [taskSessionsLoading]);

  useEffect(() => {
    featureBoardSelectedIndexRef.current = featureBoardSelectedIndex;
  }, [featureBoardSelectedIndex]);

  useEffect(() => {
    collaborationSelectedEventIdRef.current = collaborationSelectedEventId;
  }, [collaborationSelectedEventId]);

  useEffect(() => {
    collaborationDetailOpenRef.current = collaborationDetailOpen;
  }, [collaborationDetailOpen]);

  useEffect(() => {
    collaborationUnresolvedOnlyRef.current = collaborationUnresolvedOnly;
  }, [collaborationUnresolvedOnly]);

  useEffect(() => {
    chatScrollOffsetRef.current = 0;
    setChatScrollOffset(0);
  }, [messages.length]);

  useEffect(() => {
    if (!routePending || routePending.mode !== "auto") {
      setRouteElapsedMs(0);
      return;
    }

    const updateElapsed = () => {
      setRouteElapsedMs(Math.min(routePending.timeoutMs, Date.now() - routePending.startedAtMs));
    };
    updateElapsed();
    const interval = setInterval(updateElapsed, 250);
    return () => clearInterval(interval);
  }, [routePending]);

  useEffect(() => {
    attachSelectedWorkerRef.current = attachSelectedWorker;
    submitRef.current = submit;
    retryRef.current = retryActiveTask;
    newTaskRef.current = startNewTask;
    openWorkspacePickerRef.current = openWorkspacePicker;
    openRouterDiagnosticsRef.current = openRouterDiagnostics;
    openWorkerOverviewRef.current = openWorkerOverview;
    openTaskSessionsRef.current = openTaskSessions;
    openFeatureBoardRef.current = openFeatureBoard;
    openCollaborationTimelineRef.current = openCollaborationTimeline;
    refreshCollaborationTimelineRef.current = refreshCollaborationTimeline;
    activateSelectedTaskSessionRef.current = activateSelectedTaskSession;
  });

  useEffect(() => {
    if ((view !== "collaboration" && view !== "features") || !activeTaskId || !loadCollaborationTimeline) {
      return;
    }
    const interval = setInterval(() => {
      void refreshCollaborationTimelineRef.current(false);
    }, 1500);
    return () => clearInterval(interval);
  }, [activeTaskId, loadCollaborationTimeline, view]);

  useEffect(() => {
    nativeAttachRef.current = nativeAttach;
  }, [nativeAttach]);

  useEffect(() => {
    const screen = nativeAttach?.screen;
    const nativeProcess = nativeAttach?.process;
    if (view !== "native" || !screen || !nativeProcess) {
      return;
    }

    const resizeNativeAttach = () => {
      const cols = nativeAttachTerminalColumns(process.stdout.columns || 120);
      const rows = nativeAttachTerminalRows(
        process.stdout.rows || 30,
        Boolean(attachError),
        config.ui.showStatusBar
      );
      screen.resize(cols, rows);
      nativeProcess.resize(cols, rows);
      setNativeAttach((current) =>
        current && current.screen === screen
          ? {
              ...current,
              launch: { ...current.launch, cols, rows },
              snapshot: screen.snapshot()
            }
          : current
      );
    };

    process.stdout.on("resize", resizeNativeAttach);
    resizeNativeAttach();
    return () => {
      process.stdout.off("resize", resizeNativeAttach);
    };
  }, [attachError, config.ui.showStatusBar, nativeAttach?.process, nativeAttach?.screen, view]);

  useEffect(() => {
    nativeInputRef.current = nativeInput;
  }, [nativeInput]);

  useEffect(() => {
    if (!initialTaskId || activeTaskId !== initialTaskId || initialWorkers !== undefined) {
      return;
    }

    const taskId = initialTaskId;
    let active = true;
    async function loadInitialWorkers() {
      try {
        const [restored, retryable] = await Promise.all([
          orchestrator.listTaskWorkers(taskId),
          orchestrator.canRetryTask(taskId)
        ]);
        if (!active || activeTaskIdRef.current !== taskId) {
          return;
        }
        setCanRetryTask(retryable);
        if (restored.length === 0) {
          return;
        }
        setWorkers(restored);
        setStatus(restoredWorkerStatusLine(taskId, restored));
        selectedWorkerIndexRef.current = 0;
        autoSelectedFailedWorkerRef.current = false;
        userSelectedWorkerRef.current = false;
        setSelectedWorkerIndex(0);
      } catch (error) {
        if (active && activeTaskIdRef.current === taskId) {
          setAttachError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void loadInitialWorkers();
    return () => {
      active = false;
    };
  }, [activeTaskId, initialTaskId, initialWorkers, orchestrator]);

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
              id: worker.id,
              label: worker.label,
              role: worker.role,
              state: workerStatus.state,
              status: formatWorkerRuntimeStatus(workerStatus),
              runtimeStatus: workerStatus
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
      const runtimeStatusById = new Map(
        updates
          .filter((update): update is NonNullable<typeof update> => update !== null)
          .map((update) => [update.id, update.runtimeStatus])
      );
      setWorkers((current) => {
        let changed = false;
        const next = current.map((worker) => {
          const runtimeStatus = runtimeStatusById.get(worker.id);
          if (!runtimeStatus || sameWorkerRuntimeStatus(worker.runtimeStatus, runtimeStatus)) {
            return worker;
          }
          changed = true;
          return { ...worker, runtimeStatus };
        });
        return changed ? next : current;
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
        if (
          viewRef.current !== "native" &&
          viewRef.current !== "router" &&
          viewRef.current !== "sessions" &&
          viewRef.current !== "workers" &&
          viewRef.current !== "workspace"
        ) {
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
  }, [config.ui.autoOpenFailedWorker, status?.taskId, workerRefreshKey]);

  useEffect(() => {
    setRawMode(true);
    process.stdout.write("\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    const commitChatInputUpdate = (
      update: ReturnType<typeof applyChatInputChunk>,
      previousValue: string,
      previousCursor: number
    ): boolean => {
      if (update.exit) {
        activeRunControllerRef.current?.abort();
        exitRef.current();
        return false;
      }
      if (busyRef.current) {
        return false;
      }
      inputRef.current = update.value;
      inputCursorRef.current = update.cursor;
      setInput(update.value);
      setInputCursor(update.cursor);
      if (update.value !== previousValue || update.cursor !== previousCursor || update.submit !== null) {
        chatDraftHistoryRef.current = {
          offset: 0,
          draft: { value: update.value, cursor: update.cursor }
        };
      }
      if (update.submit !== null) {
        void submitRef.current(update.submit);
        return false;
      }
      return true;
    };
    const moveSelectedWorker = (delta: number, wrap = false) => {
      const nextIndex = moveWorkerSelection(
        selectedWorkerIndexRef.current,
        delta,
        workersRef.current.length,
        wrap
      );
      selectedWorkerIndexRef.current = nextIndex;
      userSelectedWorkerRef.current = true;
      setAttachError(null);
      setSelectedWorkerIndex(nextIndex);
      setWorkerScrollOffset(0);
    };
    const moveSelectedTaskSession = (delta: number, wrap = false) => {
      const nextIndex = moveTaskSessionSelection(
        selectedTaskSessionIndexRef.current,
        delta,
        taskSessionsRef.current.length,
        wrap
      );
      selectedTaskSessionIndexRef.current = nextIndex;
      setTaskSessionsError(null);
      setSelectedTaskSessionIndex(nextIndex);
    };
    const moveSelectedFeature = (delta: number, wrap = false) => {
      const nextIndex = moveFeatureBoardSelection(
        featureBoardSelectedIndexRef.current,
        delta,
        collaborationTimelineRef.current?.features.length ?? 0,
        wrap
      );
      featureBoardSelectedIndexRef.current = nextIndex;
      setCollaborationError(null);
      setFeatureBoardSelectedIndex(nextIndex);
    };
    const commitWorkerSearch = (next: WorkerSearchState) => {
      workerSearchRef.current = next;
      setWorkerSearch(next);
    };
    const closeWorkerSearch = () => {
      commitWorkerSearch({ ...workerSearchRef.current, open: false });
    };
    const cycleWorkerSearch = (delta: number) => {
      const offsets = workerNavigationTargetsRef.current.searchOffsets;
      if (offsets.length === 0) {
        return;
      }
      const current = workerSearchRef.current;
      const nextIndex = ((current.matchIndex + delta) % offsets.length + offsets.length) % offsets.length;
      commitWorkerSearch({ ...current, matchIndex: nextIndex });
      setWorkerScrollOffset(offsets[nextIndex] ?? 0);
    };
    const jumpWorkerLog = (kind: "error" | "diff") => {
      const offsets = kind === "error"
        ? workerNavigationTargetsRef.current.errorOffsets
        : workerNavigationTargetsRef.current.diffOffsets;
      if (offsets.length === 0) {
        return;
      }
      const nextIndex = (workerJumpIndexRef.current[kind] + 1) % offsets.length;
      workerJumpIndexRef.current[kind] = nextIndex;
      setWorkerScrollOffset(offsets[nextIndex] ?? 0);
    };
    const handleRawInput = (data: unknown) => {
      const chunk = rawInputDecoderRef.current.write(Buffer.isBuffer(data) ? data : String(data ?? ""));
      if (!chunk) {
        return;
      }
      const currentView = viewRef.current;
      if (currentView === "chat" && routeFallbackPromptRef.current) {
        const fallbackChunks = tokenizeRawInput(chunk);
        if (fallbackChunks.some((fallbackChunk) => isExitShortcut(fallbackChunk, {}))) {
          activeRunControllerRef.current?.abort();
          exitRef.current();
          return;
        }
        for (const fallbackChunk of fallbackChunks) {
          if (fallbackChunk === "\x1b") {
            settleRouteFallbackChoice("cancel");
            return;
          }
          if (fallbackChunk === "1" || fallbackChunk === "m" || fallbackChunk === "M") {
            settleRouteFallbackChoice("main");
            return;
          }
          if (fallbackChunk === "2" || fallbackChunk === "p" || fallbackChunk === "P") {
            settleRouteFallbackChoice("parallel");
            return;
          }
          if (fallbackChunk === "r" || fallbackChunk === "R") {
            settleRouteFallbackChoice("retry");
            return;
          }
        }
        return;
      }
      if (currentView === "workspace") {
        return;
      }
      if (currentView === "sessions") {
        if (isExitShortcut(chunk, {})) {
          activeRunControllerRef.current?.abort();
          exitRef.current();
          return;
        }
        if (isTaskSessionsShortcut(chunk, {}) || chunk === "\x1b") {
          setTaskSessionsError(null);
          viewRef.current = taskSessionsReturnViewRef.current;
          setView(taskSessionsReturnViewRef.current);
          return;
        }
        if (taskSessionsLoadingRef.current) {
          return;
        }
        if (isRouterDiagnosticsShortcut(chunk, {})) {
          void openRouterDiagnosticsRef.current();
          return;
        }
        if (isWorkspaceShortcut(chunk, {}) && !busyRef.current) {
          openWorkspacePickerRef.current();
          return;
        }
        if (isNewTaskShortcut(chunk, {}) && !busyRef.current) {
          if (activeTaskIdRef.current) {
            void newTaskRef.current();
          } else {
            viewRef.current = "chat";
            setView("chat");
          }
          return;
        }
        if (chunk === "\r" || chunk === "\n") {
          void activateSelectedTaskSessionRef.current();
          return;
        }
        if (chunk === "\t") {
          moveSelectedTaskSession(1, true);
          return;
        }
        const selectionDelta = -(
          rawHistoryDelta(chunk)
          + rawPageScrollDelta(chunk, Math.max(1, outputHeight - 2))
          + mouseScrollDelta(chunk, 1)
        );
        if (selectionDelta !== 0) {
          moveSelectedTaskSession(selectionDelta);
        }
        return;
      }
      if (currentView === "features") {
        const featureChunks = tokenizeRawInput(chunk);
        if (featureChunks.some((featureChunk) => isExitShortcut(featureChunk, {}))) {
          activeRunControllerRef.current?.abort();
          exitRef.current();
          return;
        }
        for (const featureChunk of featureChunks) {
          if (featureChunk === "\x1b" || isWorkerOverviewShortcut(featureChunk, {})) {
            setCollaborationError(null);
            viewRef.current = "workers";
            setView("workers");
            return;
          }
          if (featureChunk === "r" || featureChunk === "R") {
            void refreshCollaborationTimelineRef.current(false);
            continue;
          }
          if (featureChunk === "\r" || featureChunk === "\n" || featureChunk === "c" || featureChunk === "C") {
            if ((collaborationTimelineRef.current?.features.length ?? 0) > 0) {
              void openCollaborationTimelineRef.current(featureBoardSelectedIndexRef.current);
            }
            return;
          }
          if (featureChunk === "\t") {
            moveSelectedFeature(1, true);
            continue;
          }
          const selectionDelta = -(
            rawHistoryDelta(featureChunk)
            + rawPageScrollDelta(featureChunk, Math.max(1, outputHeight - 2))
            + mouseScrollDelta(featureChunk, 1)
          );
          if (selectionDelta !== 0) {
            moveSelectedFeature(selectionDelta);
          }
        }
        return;
      }
      if (currentView === "collaboration") {
        const timelineChunks = tokenizeRawInput(chunk);
        if (timelineChunks.some((timelineChunk) => isExitShortcut(timelineChunk, {}))) {
          activeRunControllerRef.current?.abort();
          exitRef.current();
          return;
        }
        for (const timelineChunk of timelineChunks) {
          if (collaborationDetailOpenRef.current && (timelineChunk === "\x1b" || timelineChunk === "\r" || timelineChunk === "\n")) {
            collaborationDetailOpenRef.current = false;
            setCollaborationDetailOpen(false);
            collaborationMaxScrollOffsetRef.current = 0;
            setCollaborationMaxScrollOffset(0);
            setCollaborationScrollOffset(0);
            continue;
          }
          if (collaborationDetailOpenRef.current) {
            const detailDelta = mouseScrollDelta(timelineChunk, 3)
              + rawPageScrollDelta(timelineChunk, Math.max(1, outputHeight - 3));
            if (detailDelta !== 0) {
              setCollaborationScrollOffset((current) => (
                nextScrollOffset(current, -detailDelta, collaborationMaxScrollOffsetRef.current)
              ));
            }
            continue;
          }
          if (timelineChunk === "\x1b" || isWorkerOverviewShortcut(timelineChunk, {})) {
            setCollaborationError(null);
            viewRef.current = collaborationReturnViewRef.current;
            setView(collaborationReturnViewRef.current);
            return;
          }
          const scopedEvents = collaborationTimelineRef.current
            ? collaborationTimelineEvents(
                collaborationTimelineRef.current,
                collaborationFeatureIndexRef.current,
                collaborationUnresolvedOnlyRef.current
              )
            : [];
          if (timelineChunk === "\r" || timelineChunk === "\n") {
            const selectedId = collaborationSelectedEventIdRef.current ?? scopedEvents.at(-1)?.id ?? null;
            if (selectedId) {
              collaborationSelectedEventIdRef.current = selectedId;
              setCollaborationSelectedEventId(selectedId);
              collaborationDetailOpenRef.current = true;
              setCollaborationDetailOpen(true);
              collaborationMaxScrollOffsetRef.current = 0;
              setCollaborationMaxScrollOffset(0);
              setCollaborationScrollOffset(0);
            }
            continue;
          }
          if (timelineChunk === "\t") {
            const nextIndex = nextCollaborationFeatureIndex(
              collaborationFeatureIndexRef.current,
              1,
              collaborationTimelineRef.current?.features.length ?? 0
            );
            collaborationFeatureIndexRef.current = nextIndex;
            setCollaborationFeatureIndex(nextIndex);
            collaborationSelectedEventIdRef.current = null;
            setCollaborationSelectedEventId(null);
            collaborationDetailOpenRef.current = false;
            setCollaborationDetailOpen(false);
            collaborationMaxScrollOffsetRef.current = 0;
            setCollaborationMaxScrollOffset(0);
            setCollaborationScrollOffset(0);
            continue;
          }
          if (timelineChunk === "u" || timelineChunk === "U") {
            const unresolved = !collaborationUnresolvedOnlyRef.current;
            collaborationUnresolvedOnlyRef.current = unresolved;
            setCollaborationUnresolvedOnly(unresolved);
            collaborationSelectedEventIdRef.current = null;
            setCollaborationSelectedEventId(null);
            collaborationMaxScrollOffsetRef.current = 0;
            setCollaborationMaxScrollOffset(0);
            setCollaborationScrollOffset(0);
            continue;
          }
          if (timelineChunk === "r" || timelineChunk === "R") {
            void refreshCollaborationTimelineRef.current(false);
            continue;
          }
          const eventDelta = rawHistoryDelta(timelineChunk);
          if (eventDelta !== 0) {
            const nextId = moveCollaborationEventSelection(
              scopedEvents,
              collaborationSelectedEventIdRef.current,
              -eventDelta
            );
            collaborationSelectedEventIdRef.current = nextId;
            setCollaborationSelectedEventId(nextId);
            const lineHeight = (process.stdout.columns || 120) < 28 ? 1 : 2;
            setCollaborationScrollOffset((current) => (
              nextScrollOffset(current, eventDelta * lineHeight, collaborationMaxScrollOffsetRef.current)
            ));
            continue;
          }
          const timelineDelta = mouseScrollDelta(timelineChunk, 3)
            + rawPageScrollDelta(timelineChunk, Math.max(1, outputHeight - 3));
          if (timelineDelta !== 0) {
            setCollaborationScrollOffset((current) => (
              nextScrollOffset(current, timelineDelta, collaborationMaxScrollOffsetRef.current)
            ));
          }
        }
        return;
      }
      if (currentView === "workers") {
        if (isExitShortcut(chunk, {})) {
          activeRunControllerRef.current?.abort();
          exitRef.current();
          return;
        }
        if (isWorkerOverviewShortcut(chunk, {}) || chunk === "\x1b") {
          setAttachError(null);
          viewRef.current = workerOverviewReturnViewRef.current;
          setView(workerOverviewReturnViewRef.current);
          return;
        }
        if (isRouterDiagnosticsShortcut(chunk, {})) {
          void openRouterDiagnosticsRef.current();
          return;
        }
        if (isTaskSessionsShortcut(chunk, {}) && !busyRef.current) {
          void openTaskSessionsRef.current();
          return;
        }
        if (isWorkspaceShortcut(chunk, {}) && !busyRef.current) {
          openWorkspacePickerRef.current();
          return;
        }
        if (isNewTaskShortcut(chunk, {}) && !busyRef.current) {
          void newTaskRef.current();
          return;
        }
        if (chunk === "f" || chunk === "F") {
          void openFeatureBoardRef.current();
          return;
        }
        if (chunk === "c" || chunk === "C") {
          void openCollaborationTimelineRef.current();
          return;
        }
        if (isAttachShortcut(chunk, {})) {
          const worker = workersRef.current[selectedWorkerIndexRef.current];
          if (worker) {
            void attachSelectedWorkerRef.current(worker);
          }
          return;
        }
        if (isLogsShortcut(chunk, {}) || chunk === "\r" || chunk === "\n") {
          if (workersRef.current.length > 0) {
            viewRef.current = "worker";
            setView("worker");
            setWorkerScrollOffset(0);
          }
          return;
        }
        if (chunk === "\t") {
          moveSelectedWorker(1, true);
          return;
        }
        const selectionDelta = -(
          rawHistoryDelta(chunk)
          + rawPageScrollDelta(chunk, Math.max(1, outputHeight - 2))
          + mouseScrollDelta(chunk, 1)
        );
        if (selectionDelta !== 0) {
          moveSelectedWorker(selectionDelta);
        }
        return;
      }
      if (currentView === "router") {
        const routerChunks = tokenizeRawInput(chunk);
        if (routerChunks.some((routerChunk) => isExitShortcut(routerChunk, {}))) {
          activeRunControllerRef.current?.abort();
          exitRef.current();
          return;
        }
        for (const routerChunk of routerChunks) {
          if (isRouterDiagnosticsShortcut(routerChunk, {})) {
            void openRouterDiagnosticsRef.current();
            continue;
          }
          if (isTaskSessionsShortcut(routerChunk, {}) && !busyRef.current) {
            void openTaskSessionsRef.current();
            return;
          }
          if (routerChunk === "\t") {
            setRouterScope((current) => current === "all" ? "workspace" : "all");
            routerMaxScrollOffsetRef.current = 0;
            setRouterMaxScrollOffset(0);
            setRouterScrollOffset(0);
            continue;
          }
          if (routerChunk === "\x1b") {
            setAttachError(null);
            viewRef.current = routerReturnViewRef.current;
            setView(routerReturnViewRef.current);
            return;
          }
          const routeDelta = mouseScrollDelta(routerChunk, 3)
            + rawPageScrollDelta(routerChunk, Math.max(1, outputHeight - 1));
          if (routeDelta !== 0) {
            setRouterScrollOffset((current) => (
              nextScrollOffset(current, -routeDelta, routerMaxScrollOffsetRef.current)
            ));
          }
        }
        return;
      }
      if (currentView === "worker") {
        for (const workerChunk of tokenizeRawInput(chunk)) {
          if (isExitShortcut(workerChunk, {})) {
            activeRunControllerRef.current?.abort();
            exitRef.current();
            return;
          }
          if (workerSearchRef.current.open) {
            if (isWorkerSearchShortcut(workerChunk, {}) || workerChunk === "\x1b") {
              closeWorkerSearch();
              continue;
            }
            if (workerChunk === "\r" || workerChunk === "\n") {
              cycleWorkerSearch(1);
              continue;
            }
            const searchHistoryDelta = rawHistoryDelta(workerChunk);
            if (searchHistoryDelta !== 0) {
              cycleWorkerSearch(-searchHistoryDelta);
              continue;
            }
            const current = workerSearchRef.current;
            const update = applyChatInputChunk(current.query, workerChunk, current.cursor);
            const query = update.submit ?? update.value;
            const cursor = update.submit === null ? update.cursor : Array.from(query).length;
            commitWorkerSearch({
              open: true,
              query,
              cursor,
              matchIndex: query === current.query ? current.matchIndex : 0
            });
            continue;
          }
          if (isWorkerSearchShortcut(workerChunk, {})) {
            commitWorkerSearch({ ...workerSearchRef.current, open: true });
            continue;
          }
          const jumpKind = workerLogJumpKind(workerChunk);
          if (jumpKind) {
            jumpWorkerLog(jumpKind);
            continue;
          }
          if (isNewTaskShortcut(workerChunk, {}) && !busyRef.current) {
            void newTaskRef.current();
            return;
          }
          if (isWorkspaceShortcut(workerChunk, {}) && !busyRef.current) {
            openWorkspacePickerRef.current();
            return;
          }
          if (isRouterDiagnosticsShortcut(workerChunk, {})) {
            void openRouterDiagnosticsRef.current();
            return;
          }
          if (isTaskSessionsShortcut(workerChunk, {}) && !busyRef.current) {
            void openTaskSessionsRef.current();
            return;
          }
          if (isWorkerOverviewShortcut(workerChunk, {})) {
            openWorkerOverviewRef.current();
            return;
          }
          if (workerChunk === "\x1b") {
            userSelectedWorkerRef.current = true;
            setAttachError(null);
            setView("chat");
            return;
          }
          const delta = mouseScrollDelta(workerChunk, 3);
          if (delta !== 0) {
            setWorkerScrollOffset((current) => nextScrollOffset(current, delta, workerMaxScrollOffsetRef.current));
          }
        }
        return;
      }

      if (currentView === "chat") {
        if (isWorkspaceShortcut(chunk, {}) && !busyRef.current) {
          openWorkspacePickerRef.current();
          return;
        }
        if (isRouterDiagnosticsShortcut(chunk, {})) {
          void openRouterDiagnosticsRef.current();
          return;
        }
        if (isTaskSessionsShortcut(chunk, {}) && !busyRef.current) {
          void openTaskSessionsRef.current();
          return;
        }
        if (isWorkerOverviewShortcut(chunk, {})) {
          openWorkerOverviewRef.current();
          return;
        }
        const paste = chatPasteDecoderRef.current.write(chunk);
        if (paste.intercepted) {
          if (busyRef.current) {
            return;
          }
          for (const event of paste.events) {
            const previousValue = inputRef.current;
            const previousCursor = inputCursorRef.current;
            const update = event.kind === "paste"
              ? insertChatPaste(previousValue, event.text, previousCursor)
              : applyChatInputChunk(previousValue, event.text, previousCursor);
            if (!commitChatInputUpdate(update, previousValue, previousCursor)) {
              return;
            }
          }
          return;
        }
        if (isNewTaskShortcut(chunk, {}) && !busyRef.current) {
          void newTaskRef.current();
          return;
        }
        if (chunk === "\x1b") {
          if (busyRef.current) {
            activeRunControllerRef.current?.abort();
            return;
          }
          userSelectedWorkerRef.current = true;
          setAttachError(null);
          setView("chat");
          return;
        }
        const wheelDelta = mouseScrollDelta(chunk, 3);
        const pageDelta = rawPageScrollDelta(chunk, Math.max(1, outputHeight - 1));
        const historyDelta = wheelDelta + pageDelta;
        if (historyDelta !== 0 && chatMaxScrollOffsetRef.current > 0) {
          setChatScrollOffset((current) => {
            const next = nextScrollOffset(current, historyDelta, chatMaxScrollOffsetRef.current);
            chatScrollOffsetRef.current = next;
            return next;
          });
          return;
        }
        if (wheelDelta !== 0 && workersRef.current.length > 0) {
          setAttachError(null);
          setView("worker");
          setWorkerScrollOffset((current) => nextScrollOffset(current, wheelDelta, workerMaxScrollOffsetRef.current));
          return;
        }
        if (chunk === "\u0017") {
          if (workersRef.current.length === 0) {
            setAttachError(NO_WORKERS_LOGS_MESSAGE);
            return;
          }
          setAttachError(null);
          setView("worker");
          setWorkerScrollOffset(0);
          return;
        }
        if (chunk === "\u000f") {
          const worker = workersRef.current[selectedWorkerIndexRef.current];
          if (!worker) {
            setAttachError(NO_WORKERS_ATTACH_MESSAGE);
            return;
          }
          void attachSelectedWorkerRef.current(worker);
          return;
        }
        if (chunk === "\t" && workersRef.current.length > 0) {
          const nextIndex = (selectedWorkerIndexRef.current + 1) % workersRef.current.length;
          userSelectedWorkerRef.current = true;
          selectedWorkerIndexRef.current = nextIndex;
          setAttachError(null);
          setSelectedWorkerIndex(nextIndex);
          setView("worker");
          setWorkerScrollOffset(0);
          return;
        }
        if (chunk === "\u0012" && !busyRef.current) {
          void retryRef.current();
          return;
        }

        const draftHistoryDelta = rawHistoryDelta(chunk);
        if (draftHistoryDelta !== 0) {
          if (busyRef.current) {
            return;
          }
          const update = navigateChatDraftHistory(
            chatRequestHistory(messagesRef.current),
            { value: inputRef.current, cursor: inputCursorRef.current },
            chatDraftHistoryRef.current,
            draftHistoryDelta
          );
          chatDraftHistoryRef.current = update.state;
          inputRef.current = update.value;
          inputCursorRef.current = update.cursor;
          setInput(update.value);
          setInputCursor(update.cursor);
          return;
        }

        const previousValue = inputRef.current;
        const previousCursor = inputCursorRef.current;
        const update = applyChatInputChunk(previousValue, chunk, previousCursor);
        commitChatInputUpdate(update, previousValue, previousCursor);
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
    setInputReady(true);
    return () => {
      stdinEvents.removeListener("input", handleRawInput);
      rawInputDecoderRef.current.end();
      chatPasteDecoderRef.current.reset();
      process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l");
      setRawMode(false);
    };
  }, [outputHeight, setRawMode, stdinEvents]);

  useEffect(() => () => {
    activeRunControllerRef.current?.abort();
    collaborationLoadSequenceRef.current += 1;
    routerLoadSequenceRef.current += 1;
    taskSessionsLoadSequenceRef.current += 1;
  }, []);

  useInput((inputKey, key) => {
    if (view === "worker") {
      if (isExitShortcut(inputKey, key)) {
        activeRunControllerRef.current?.abort();
        exitRef.current();
        return;
      }
      if (isNewTaskShortcut(inputKey, key) && !busy) {
        void startNewTask();
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
      setAttachError(null);
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
        setAttachError(NO_WORKERS_ATTACH_MESSAGE);
        return;
      }
      void attachSelectedWorker(worker);
    }
  }, { isActive: view === "worker" && !workerSearch.open });

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
      const terminalRows = nativeAttachTerminalRows(
        process.stdout.rows || 30,
        Boolean(attachError),
        config.ui.showStatusBar
      );
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
                    hasOutput: true,
                    snapshot: screen.snapshot()
                  }
                : current
            );
          });
        },
        onClose: (code) => {
          void screen.write(`\r\n${nativeAttachExitLine(code, screen.dimensions().cols)}\r\n`).then(() => {
            setNativeAttach((current) =>
              current && current.screen === screen
                ? {
                    ...current,
                    hasOutput: true,
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
        hasOutput: false,
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

  function createRunCallbacks(controller: AbortController) {
    return {
      signal: controller.signal,
      onRouteStart: (state: RouteStartInfo) => {
        setRouteElapsedMs(0);
        setRoutePending({ ...state, startedAtMs: Date.now() });
      },
      onRouteFallback: (fallback: RouteFallbackInfo) => requestRouteFallbackChoice(fallback, controller.signal),
      onRoute: (route: RouteDecision) => {
        setRoutePending(null);
        setLastRoute(route);
      },
      onStatus: (nextStatus: WorkerRunStatus) => {
        setStatus(nextStatus);
        if (nextStatus.taskId !== "main") {
          activeTaskIdRef.current = nextStatus.taskId;
          setActiveTaskId(nextStatus.taskId);
          setActiveMode("complex");
        }
      },
      onWorker: (worker: WorkerLogRef) => {
        setWorkers((current) => upsertWorker(current, worker));
      }
    };
  }

  function requestRouteFallbackChoice(
    fallback: RouteFallbackInfo,
    signal: AbortSignal
  ): Promise<RouteFallbackChoice> {
    routeFallbackResolverRef.current?.("cancel");
    setRoutePending(null);
    setLastRoute(fallback.route);
    routeFallbackPromptRef.current = fallback;
    setRouteFallbackPrompt(fallback);
    viewRef.current = "chat";
    setView("chat");

    return new Promise((resolve) => {
      let settled = false;
      const finish = (choice: RouteFallbackChoice) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        const current = routeFallbackPromptRef.current;
        if (current === fallback) {
          routeFallbackPromptRef.current = null;
          routeFallbackResolverRef.current = null;
          setRouteFallbackPrompt(null);
          setLastRoute(previewRouteFallbackChoice(fallback.route, choice));
        }
        resolve(choice);
      };
      const onAbort = () => finish("cancel");
      routeFallbackResolverRef.current = finish;
      if (signal.aborted) {
        finish("cancel");
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function settleRouteFallbackChoice(choice: RouteFallbackChoice): void {
    routeFallbackResolverRef.current?.(choice);
  }

  async function appendVisibleMessage(message: Message, taskId?: string): Promise<void> {
    setMessages((current) => {
      const next = [...current, message];
      messagesRef.current = next;
      return next;
    });
    if (!persistChatMessage) {
      return;
    }
    try {
      await persistChatMessage(message, taskId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setAttachError(`Chat history write failed · ${detail}`);
    }
  }

  async function submit(value: string) {
    const request = value.trim();
    if (!request || busyRef.current) {
      return;
    }

    inputRef.current = "";
    inputCursorRef.current = 0;
    chatDraftHistoryRef.current = {
      offset: 0,
      draft: { value: "", cursor: 0 }
    };
    setInput("");
    setInputCursor(0);
    chatScrollOffsetRef.current = 0;
    setChatScrollOffset(0);
    busyRef.current = true;
    setBusy(true);
    setRoutePending(null);
    setLastRoute(null);
    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    await appendVisibleMessage(
      { from: "user", text: request },
      activeTaskIdRef.current ?? undefined
    );

    try {
      const callbacks = createRunCallbacks(controller);
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
              route: followUpRoute?.route,
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
      activeTaskIdRef.current = nextMemory.activeTaskId;
      setCanRetryTask(nextMemory.activeTaskId
        ? await orchestrator.canRetryTask(nextMemory.activeTaskId)
        : false);
      await appendVisibleMessage(
        { from: "system", text: result.summary },
        nextMemory.activeTaskId ?? undefined
      );
    } catch (error) {
      const retryTaskId = activeTaskIdRef.current;
      if (retryTaskId) {
        setCanRetryTask(await orchestrator.canRetryTask(retryTaskId));
      }
      await appendVisibleMessage({
        from: "system",
        text: isAbortError(error) ? "cancelled · request stopped" : error instanceof Error ? error.message : String(error)
      }, retryTaskId ?? undefined);
    } finally {
      if (activeRunControllerRef.current === controller) {
        activeRunControllerRef.current = null;
      }
      setRoutePending(null);
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function retryActiveTask() {
    const taskId = activeTaskIdRef.current;
    if (!taskId || busyRef.current || !canRetryTask) {
      return;
    }

    const controller = new AbortController();
    activeRunControllerRef.current = controller;
    busyRef.current = true;
    setBusy(true);
    setCanRetryTask(false);
    setRoutePending(null);
    setLastRoute(null);

    try {
      const result = await orchestrator.retryTask({
        taskId,
        cwd,
        ...createRunCallbacks(controller)
      });
      activeTaskIdRef.current = taskId;
      setActiveTaskId(taskId);
      setActiveMode("complex");
      setCanRetryTask(false);
      await appendVisibleMessage({ from: "system", text: result.summary }, taskId);
    } catch (error) {
      setCanRetryTask(await orchestrator.canRetryTask(taskId));
      await appendVisibleMessage({
        from: "system",
        text: isAbortError(error) ? "cancelled · retry stopped" : error instanceof Error ? error.message : String(error)
      }, taskId);
    } finally {
      if (activeRunControllerRef.current === controller) {
        activeRunControllerRef.current = null;
      }
      setRoutePending(null);
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function startNewTask(): Promise<void> {
    if (busyRef.current || !activeTaskIdRef.current) {
      return;
    }

    try {
      await activateTaskSession?.(null);
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : String(error));
      return;
    }

    const nextMemory = newTaskMemoryState();
    activeTaskIdRef.current = nextMemory.activeTaskId;
    setActiveTaskId(nextMemory.activeTaskId);
    setActiveMode(nextMemory.activeMode);
    setCanRetryTask(false);
    setStatus(null);
    setRoutePending(null);
    setLastRoute(null);
    setWorkers([]);
    workersRef.current = [];
    selectedWorkerIndexRef.current = 0;
    setSelectedWorkerIndex(0);
    setWorkerScrollOffset(0);
    setWorkerMaxScrollOffset(0);
    autoSelectedFailedWorkerRef.current = false;
    userSelectedWorkerRef.current = false;
    setAttachError(null);
    viewRef.current = "chat";
    setView("chat");
    chatDraftHistoryRef.current = {
      offset: 0,
      draft: { value: inputRef.current, cursor: inputCursorRef.current }
    };
    await appendVisibleMessage({ from: "system", text: "new task · ready" });
  }

  async function openRouterDiagnostics(): Promise<void> {
    const currentView = viewRef.current;
    if (currentView === "native" || currentView === "workspace") {
      return;
    }
    if (currentView !== "router") {
      routerReturnViewRef.current = currentView === "worker" || currentView === "workers" || currentView === "sessions"
        ? currentView
        : "chat";
    }

    viewRef.current = "router";
    setView("router");
    setAttachError(null);
    setRouterError(null);
    setRouterLoading(true);
    setRouterScrollOffset(0);
    routerMaxScrollOffsetRef.current = 0;
    setRouterMaxScrollOffset(0);

    const sequence = routerLoadSequenceRef.current + 1;
    routerLoadSequenceRef.current = sequence;
    try {
      if (!loadRouterDiagnostics) {
        throw new Error("Router diagnostics are unavailable");
      }
      const diagnostics = await loadRouterDiagnostics();
      if (routerLoadSequenceRef.current !== sequence) {
        return;
      }
      setRouterRecords(diagnostics.records);
      setRouterPolicy(diagnostics.policy);
    } catch (error) {
      if (routerLoadSequenceRef.current === sequence) {
        setRouterError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (routerLoadSequenceRef.current === sequence) {
        setRouterLoading(false);
      }
    }
  }

  async function openTaskSessions(): Promise<void> {
    const currentView = viewRef.current;
    if (
      busyRef.current ||
      currentView === "native" ||
      currentView === "workspace" ||
      currentView === "sessions"
    ) {
      return;
    }
    taskSessionsReturnViewRef.current = currentView === "worker" || currentView === "workers" || currentView === "router"
      ? currentView
      : "chat";
    viewRef.current = "sessions";
    setView("sessions");
    setAttachError(null);
    setTaskSessionsError(null);
    taskSessionsLoadingRef.current = true;
    setTaskSessionsLoading(true);

    const sequence = taskSessionsLoadSequenceRef.current + 1;
    taskSessionsLoadSequenceRef.current = sequence;
    try {
      if (!loadTaskSessions) {
        throw new Error("Task sessions are unavailable");
      }
      const tasks = await loadTaskSessions();
      if (taskSessionsLoadSequenceRef.current !== sequence) {
        return;
      }
      taskSessionsRef.current = tasks;
      setTaskSessions(tasks);
      const activeIndex = activeTaskIdRef.current
        ? tasks.findIndex((task) => task.id === activeTaskIdRef.current)
        : -1;
      const selectedIndex = activeIndex >= 0 ? activeIndex : 0;
      selectedTaskSessionIndexRef.current = selectedIndex;
      setSelectedTaskSessionIndex(selectedIndex);
    } catch (error) {
      if (taskSessionsLoadSequenceRef.current === sequence) {
        setTaskSessionsError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (taskSessionsLoadSequenceRef.current === sequence) {
        taskSessionsLoadingRef.current = false;
        setTaskSessionsLoading(false);
      }
    }
  }

  async function activateSelectedTaskSession(): Promise<void> {
    if (busyRef.current || taskSessionsLoadingRef.current) {
      return;
    }
    const selected = taskSessionsRef.current[selectedTaskSessionIndexRef.current];
    if (!selected) {
      return;
    }
    taskSessionsLoadingRef.current = true;
    setTaskSessionsLoading(true);
    setTaskSessionsError(null);
    const sequence = taskSessionsLoadSequenceRef.current + 1;
    taskSessionsLoadSequenceRef.current = sequence;
    try {
      if (!activateTaskSession) {
        throw new Error("Task session restore is unavailable");
      }
      const restored = await activateTaskSession(selected.id);
      if (taskSessionsLoadSequenceRef.current !== sequence) {
        return;
      }
      if (!restored) {
        throw new Error(`Task session not found: ${selected.id}`);
      }
      activeTaskIdRef.current = restored.taskId;
      setActiveTaskId(restored.taskId);
      setActiveMode("complex");
      setCanRetryTask(restored.canRetry);
      setStatus(restoredWorkerStatusLine(restored.taskId, restored.workers));
      setRoutePending(null);
      setLastRoute(restored.route);
      workersRef.current = restored.workers;
      setWorkers(restored.workers);
      selectedWorkerIndexRef.current = 0;
      setSelectedWorkerIndex(0);
      setWorkerScrollOffset(0);
      setWorkerMaxScrollOffset(0);
      autoSelectedFailedWorkerRef.current = false;
      userSelectedWorkerRef.current = false;
      setAttachError(null);
      viewRef.current = "chat";
      setView("chat");
    } catch (error) {
      if (taskSessionsLoadSequenceRef.current === sequence) {
        setTaskSessionsError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (taskSessionsLoadSequenceRef.current === sequence) {
        taskSessionsLoadingRef.current = false;
        setTaskSessionsLoading(false);
      }
    }
  }

  async function openFeatureBoard(): Promise<void> {
    if (viewRef.current !== "workers") {
      return;
    }
    if (!activeTaskIdRef.current) {
      setAttachError(NO_ACTIVE_FEATURES_MESSAGE);
      return;
    }
    viewRef.current = "features";
    setView("features");
    setAttachError(null);
    setCollaborationError(null);
    collaborationTimelineRef.current = null;
    setCollaborationTimeline(null);
    featureBoardSelectedIndexRef.current = 0;
    setFeatureBoardSelectedIndex(0);
    collaborationFeatureIndexRef.current = -1;
    setCollaborationFeatureIndex(-1);
    collaborationSelectedEventIdRef.current = null;
    setCollaborationSelectedEventId(null);
    collaborationDetailOpenRef.current = false;
    setCollaborationDetailOpen(false);
    collaborationUnresolvedOnlyRef.current = false;
    setCollaborationUnresolvedOnly(false);
    collaborationMaxScrollOffsetRef.current = 0;
    setCollaborationMaxScrollOffset(0);
    setCollaborationScrollOffset(0);
    await refreshCollaborationTimeline(true);
  }

  async function openCollaborationTimeline(featureIndex = -1): Promise<void> {
    const source = viewRef.current;
    if (source !== "workers" && source !== "features") {
      return;
    }
    if (!activeTaskIdRef.current) {
      setAttachError(NO_ACTIVE_COLLABORATION_MESSAGE);
      return;
    }
    collaborationReturnViewRef.current = source;
    viewRef.current = "collaboration";
    setView("collaboration");
    setAttachError(null);
    setCollaborationError(null);
    const existingTimeline = source === "features" ? collaborationTimelineRef.current : null;
    if (!existingTimeline) {
      collaborationTimelineRef.current = null;
      setCollaborationTimeline(null);
    }
    const nextFeatureIndex = featureIndex >= 0 && featureIndex < (existingTimeline?.features.length ?? 0)
      ? featureIndex
      : -1;
    collaborationFeatureIndexRef.current = nextFeatureIndex;
    setCollaborationFeatureIndex(nextFeatureIndex);
    collaborationSelectedEventIdRef.current = null;
    setCollaborationSelectedEventId(null);
    collaborationDetailOpenRef.current = false;
    setCollaborationDetailOpen(false);
    collaborationUnresolvedOnlyRef.current = false;
    setCollaborationUnresolvedOnly(false);
    collaborationMaxScrollOffsetRef.current = 0;
    setCollaborationMaxScrollOffset(0);
    setCollaborationScrollOffset(0);
    await refreshCollaborationTimeline(!existingTimeline);
  }

  async function refreshCollaborationTimeline(showLoading = true): Promise<void> {
    const taskId = activeTaskIdRef.current;
    if (!taskId) {
      setCollaborationError(NO_ACTIVE_COLLABORATION_MESSAGE);
      return;
    }
    const sequence = collaborationLoadSequenceRef.current + 1;
    collaborationLoadSequenceRef.current = sequence;
    if (showLoading) {
      setCollaborationLoading(true);
    }
    try {
      if (!loadCollaborationTimeline) {
        throw new Error("Collaboration timeline is unavailable");
      }
      const timeline = await loadCollaborationTimeline(taskId);
      if (collaborationLoadSequenceRef.current !== sequence) {
        return;
      }
      collaborationTimelineRef.current = timeline;
      setCollaborationTimeline(timeline);
      const currentBoardIndex = featureBoardSelectedIndexRef.current;
      const nextBoardIndex = timeline.features.length > 0
        ? Math.min(timeline.features.length - 1, Math.max(0, currentBoardIndex))
        : 0;
      if (nextBoardIndex !== currentBoardIndex) {
        featureBoardSelectedIndexRef.current = nextBoardIndex;
        setFeatureBoardSelectedIndex(nextBoardIndex);
      }
      const currentIndex = collaborationFeatureIndexRef.current;
      const nextIndex = currentIndex >= timeline.features.length ? -1 : currentIndex;
      if (nextIndex !== currentIndex) {
        collaborationFeatureIndexRef.current = nextIndex;
        setCollaborationFeatureIndex(nextIndex);
        setCollaborationScrollOffset(0);
      }
      const scopedEvents = collaborationTimelineEvents(
        timeline,
        nextIndex,
        collaborationUnresolvedOnlyRef.current
      );
      const selectedEventId = collaborationSelectedEventIdRef.current;
      if (selectedEventId && !scopedEvents.some((event) => event.id === selectedEventId)) {
        collaborationSelectedEventIdRef.current = null;
        setCollaborationSelectedEventId(null);
        collaborationDetailOpenRef.current = false;
        setCollaborationDetailOpen(false);
        setCollaborationScrollOffset(0);
      } else if (selectedEventId && !collaborationDetailOpenRef.current) {
        const minimumOffset = collaborationSelectionScrollOffset(
          scopedEvents,
          selectedEventId,
          process.stdout.columns || 120
        );
        setCollaborationScrollOffset((current) => Math.max(current, minimumOffset));
      }
      setCollaborationError(null);
    } catch (error) {
      if (collaborationLoadSequenceRef.current === sequence) {
        setCollaborationError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (collaborationLoadSequenceRef.current === sequence) {
        setCollaborationLoading(false);
      }
    }
  }

  function updateWorkerNavigationTargets(next: WorkerOutputNavigationTargets): void {
    const previous = workerNavigationTargetsRef.current;
    workerNavigationTargetsRef.current = next;
    if (!sameNumberArray(previous.errorOffsets, next.errorOffsets)) {
      workerJumpIndexRef.current.error = -1;
    }
    if (!sameNumberArray(previous.diffOffsets, next.diffOffsets)) {
      workerJumpIndexRef.current.diff = -1;
    }
    if (!sameWorkerNavigationTargets(previous, next)) {
      setWorkerNavigationTargets(next);
    }

    const search = workerSearchRef.current;
    const matchIndex = next.searchOffsets.length > 0
      ? Math.min(next.searchOffsets.length - 1, Math.max(0, search.matchIndex))
      : 0;
    if (matchIndex !== search.matchIndex) {
      const updated = { ...search, matchIndex };
      workerSearchRef.current = updated;
      setWorkerSearch(updated);
    }
    if (search.open && search.query.trim() && next.searchOffsets.length > 0) {
      setWorkerScrollOffset(next.searchOffsets[matchIndex] ?? 0);
    }
  }

  function openWorkerOverview(): void {
    const currentView = viewRef.current;
    if (currentView !== "chat" && currentView !== "worker") {
      return;
    }
    if (workersRef.current.length === 0) {
      setAttachError(NO_WORKERS_OVERVIEW_MESSAGE);
      return;
    }
    workerOverviewReturnViewRef.current = currentView;
    viewRef.current = "workers";
    setAttachError(null);
    setView("workers");
  }

  function openWorkspacePicker(): void {
    const currentView = viewRef.current;
    if (busyRef.current || !switchWorkspace || currentView === "native" || currentView === "workspace") {
      return;
    }
    workspaceReturnViewRef.current = currentView === "worker" || currentView === "workers" || currentView === "sessions"
      ? currentView
      : "chat";
    setAttachError(null);
    setView("workspace");
  }

  function closeWorkspacePicker(): void {
    setAttachError(null);
    setView(workspaceReturnViewRef.current);
  }

  async function selectWorkspace(workspace: string): Promise<void> {
    if (!switchWorkspace || workspace === cwd) {
      closeWorkspacePicker();
      return;
    }
    try {
      await switchWorkspace(workspace);
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : String(error));
      setView(workspaceReturnViewRef.current);
    }
  }

  if (view === "workspace") {
    return (
      <Box flexDirection="column" height={Math.max(1, process.stdout.rows || 30)}>
        <WorkspacePicker
          cwd={cwd}
          choices={workspaceChoices}
          terminalHeight={process.stdout.rows || 30}
          terminalWidth={terminalWidth}
          onCancel={closeWorkspacePicker}
          onSelect={(workspace) => void selectWorkspace(workspace)}
        />
      </Box>
    );
  }

  return (
    <AppShell
      view={view}
      cwd={cwd}
      taskId={activeTaskId}
      statusText={[visibleTaskStatus, visibleRouteStatus, visibleWorkerStatus].filter(Boolean).join(" | ")}
      contentHeight={contentHeight}
      showStatusBar={config.ui.showStatusBar}
      input={
        <InputBar
          mode={view === "worker" && workerSearch.open ? "worker-search" : view}
          ready={inputReady}
          busy={busy}
          routeFallback={Boolean(routeFallbackPrompt)}
          collaborationDetail={collaborationDetailOpen}
          collaborationUnresolved={collaborationUnresolvedOnly}
          collaborationBack={collaborationReturnViewRef.current}
          canRetry={canRetryTask}
          hasWorkers={workers.length > 0}
          hasActiveTask={Boolean(activeTaskId)}
          chatScrollOffset={chatScrollOffset}
          chatMaxScrollOffset={chatMaxScrollOffset}
          nativeClosed={view === "native" && nativeAttach?.closedCode !== null}
          searchMatchIndex={workerSearch.matchIndex}
          searchMatchCount={workerNavigationTargets.searchOffsets.length}
          value={workerSearch.open && view === "worker"
            ? workerSearch.query
            : view === "native" || view === "router" || view === "workers" || view === "features" || view === "sessions" || view === "collaboration" ? "" : input}
          cursor={workerSearch.open && view === "worker"
            ? workerSearch.cursor
            : view === "chat" ? inputCursor : undefined}
          terminalWidth={terminalWidth}
          onChange={view === "native" ? setNativeInput : setInput}
          onSubmit={view === "native" ? undefined : submit}
        />
      }
      error={attachError}
    >
        {view === "native" ? (
          <NativeAttachView attach={nativeAttach} viewportHeight={contentHeight} />
        ) : view === "sessions" ? (
          <TaskSessionsView
            tasks={taskSessions}
            activeTaskId={activeTaskId}
            selectedIndex={selectedTaskSessionIndex}
            loading={taskSessionsLoading}
            error={taskSessionsError}
            height={contentHeight}
            terminalWidth={terminalWidth}
          />
        ) : view === "features" ? (
          <FeatureBoardView
            timeline={collaborationTimeline}
            selectedIndex={featureBoardSelectedIndex}
            loading={collaborationLoading}
            error={collaborationError}
            height={contentHeight}
            terminalWidth={terminalWidth}
          />
        ) : view === "collaboration" ? (
          <CollaborationTimelineView
            timeline={collaborationTimeline}
            featureIndex={collaborationFeatureIndex}
            selectedEventId={collaborationSelectedEventId}
            detailOpen={collaborationDetailOpen}
            unresolvedOnly={collaborationUnresolvedOnly}
            loading={collaborationLoading}
            error={collaborationError}
            scrollOffset={collaborationScrollOffset}
            height={contentHeight}
            terminalWidth={terminalWidth}
            onViewportChange={({ offset, maxOffset }) => {
              collaborationMaxScrollOffsetRef.current = maxOffset;
              setCollaborationMaxScrollOffset(maxOffset);
              if (offset !== collaborationScrollOffset) {
                setCollaborationScrollOffset(offset);
              }
            }}
          />
        ) : view === "workers" ? (
          <WorkerOverviewView
            workers={workers}
            selectedIndex={selectedWorkerIndex}
            height={contentHeight}
            terminalWidth={terminalWidth}
          />
        ) : view === "router" ? (
          <RouterDiagnosticsView
            records={routerRecords}
            policy={routerPolicy}
            currentWorkspace={cwd}
            scope={routerScope}
            loading={routerLoading}
            error={routerError}
            scrollOffset={routerScrollOffset}
            height={contentHeight}
            terminalWidth={terminalWidth}
            onViewportChange={({ offset, maxOffset }) => {
              routerMaxScrollOffsetRef.current = maxOffset;
              setRouterMaxScrollOffset(maxOffset);
              if (offset !== routerScrollOffset) {
                setRouterScrollOffset(offset);
              }
            }}
          />
        ) : view === "chat" ? (
          <ChatView
            messages={messages}
            cwd={cwd}
            activeTaskId={activeTaskId}
            terminalWidth={terminalWidth}
            viewportHeight={contentHeight}
            scrollOffset={chatScrollOffset}
            onViewportChange={({ offset, maxOffset }) => {
              chatMaxScrollOffsetRef.current = maxOffset;
              setChatMaxScrollOffset(maxOffset);
              if (offset !== chatScrollOffsetRef.current) {
                chatScrollOffsetRef.current = offset;
                setChatScrollOffset(offset);
              }
            }}
          />
        ) : (
          <WorkerOutputView
            title={workerTitle(workers, selectedWorkerIndex)}
            role={workers[selectedWorkerIndex]?.role}
            logPath={workers[selectedWorkerIndex]?.logPath ?? null}
            scrollOffset={workerScrollOffset}
            searchQuery={workerSearch.open ? workerSearch.query : ""}
            searchMatchIndex={workerSearch.matchIndex}
            height={Math.max(1, outputHeight - 1)}
            terminalWidth={terminalWidth}
            onNavigationChange={updateWorkerNavigationTargets}
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
  viewportHeight,
  scrollOffset = 0,
  onViewportChange
}: {
  messages: Message[];
  cwd: string;
  activeTaskId: string | null;
  terminalWidth?: number;
  viewportHeight?: number;
  scrollOffset?: number;
  onViewportChange?: (viewport: { offset: number; maxOffset: number }) => void;
}) {
  const height = viewportHeight ? Math.max(1, viewportHeight) : undefined;
  const viewport = useMemo(
    () => chatMessageViewport(messages, terminalWidth, height ?? 12, scrollOffset),
    [height, messages, scrollOffset, terminalWidth]
  );

  useEffect(() => {
    onViewportChange?.({
      offset: viewport.clampedOffset,
      maxOffset: viewport.maxOffset
    });
  }, [onViewportChange, viewport.clampedOffset, viewport.maxOffset]);

  if (messages.length === 0) {
    const spacerLines = chatViewportSpacerLineCount(1, height);

    return (
      <Box flexDirection="column" height={height}>
        <ChatViewportSpacerLines count={spacerLines} terminalWidth={terminalWidth} />
        <ChatEmptyState cwd={cwd} activeTaskId={activeTaskId} terminalWidth={terminalWidth} />
      </Box>
    );
  }
  const lines = viewport.lines;
  const spacerLines = chatViewportSpacerLineCount(lines.length, height);
  const topAligned = chatCompletionIsTopAligned(messages);

  return (
    <Box flexDirection="column" height={height}>
      {!topAligned ? <ChatViewportSpacerLines count={spacerLines} terminalWidth={terminalWidth} /> : null}
      {lines.map((line, index) => (
        <ChatLine key={`${line.from}-${index}`} line={line} terminalWidth={terminalWidth} />
      ))}
      {topAligned ? <ChatViewportSpacerLines count={spacerLines} terminalWidth={terminalWidth} /> : null}
    </Box>
  );
}

export function chatLineTheme(line: ChatDisplayLine): ChatLineTheme {
  const backgroundColor = chatLineBackgroundColor(line.background);
  if (line.from === "user") {
    return { backgroundColor, color: TUI_THEME.accent };
  }
  if (!line.text.trim()) {
    return { backgroundColor, color: TUI_THEME.muted };
  }
  return { backgroundColor, color: TUI_THEME.text };
}

export function chatSpanTheme(
  from: Message["from"],
  tone: ChatSpanTone | string,
  background: ChatLineBackground = "surface"
): ChatSpanTheme {
  const baseColor = from === "user" ? TUI_THEME.accent : TUI_THEME.text;
  const backgroundColor = chatLineBackgroundColor(background);
  if (tone === "link") {
    return {
      backgroundColor,
      color: TUI_THEME.accent,
      underline: true
    };
  }
  if (tone === "code") {
    return {
      backgroundColor: TUI_THEME.rail,
      color: TUI_THEME.warning
    };
  }
  if (tone === "strong") {
    return {
      backgroundColor,
      bold: true,
      color: baseColor
    };
  }
  if (tone === "success") {
    return {
      backgroundColor,
      bold: true,
      color: TUI_THEME.success
    };
  }
  if (tone === "heading") {
    return {
      backgroundColor,
      bold: true,
      color: TUI_THEME.accent
    };
  }
  if (tone === "emphasis") {
    return {
      backgroundColor,
      color: baseColor,
      italic: true
    };
  }
  if (tone === "muted" || (tone === "prefix" && from === "system")) {
    return {
      backgroundColor,
      color: TUI_THEME.muted
    };
  }
  return {
    backgroundColor,
    color: baseColor
  };
}

function chatLineBackgroundColor(background: ChatLineBackground | undefined): NonNullable<TextProps["backgroundColor"]> {
  return background === "rail" ? TUI_THEME.rail : TUI_THEME.surface;
}

export function chatLineTrailingFillWidth(line: ChatDisplayLine, terminalWidth: number): number {
  return Math.max(0, chatContentWidth(terminalWidth) - displayWidth(chatLineDisplayText(line)));
}

export function chatMessageDisplayLines(messages: Message[], terminalWidth: number, maxLines = 12): ChatDisplayLine[] {
  return chatMessageViewport(messages, terminalWidth, maxLines, 0).lines;
}

export function chatMessageViewport(
  messages: Message[],
  terminalWidth: number,
  maxLines = 12,
  offsetFromBottom = 0
): { lines: ChatDisplayLine[]; clampedOffset: number; maxOffset: number } {
  const contentWidth = chatContentWidth(terminalWidth);
  const rendered = messages.flatMap((message) => chatSingleMessageDisplayLines(message, contentWidth));
  const viewportHeight = Math.max(1, maxLines);
  const maxOffset = Math.max(0, rendered.length - viewportHeight);
  const clampedOffset = Math.min(Math.max(0, Math.trunc(offsetFromBottom)), maxOffset);
  const end = rendered.length - clampedOffset;
  const start = Math.max(0, end - viewportHeight);

  return {
    lines: rendered.slice(start, end),
    clampedOffset,
    maxOffset
  };
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

function chatCompletionIsTopAligned(messages: Message[]): boolean {
  const latest = messages.at(-1);
  return latest?.from === "system" && compactSupervisorSummaryForChat(latest.text) !== null;
}

function chatViewportBlankLineWidth(terminalWidth: number): number {
  return Math.max(1, chatContentWidth(terminalWidth));
}

function ChatLine({ line, terminalWidth }: { line: ChatDisplayLine; terminalWidth: number }) {
  const theme = chatLineTheme(line);
  const fillWidth = chatLineTrailingFillWidth(line, terminalWidth);
  const spans = line.text && line.spans?.length ? line.spans : null;
  const backgroundColor = chatLineBackgroundColor(line.background);

  return (
    <Text>
      {spans
        ? spans.map((span, index) => (
          <Text key={`${span.tone}-${index}`} {...chatSpanTheme(line.from, span.tone, line.background)}>{span.text}</Text>
        ))
        : <Text {...theme}>{chatLineDisplayText(line)}</Text>}
      {fillWidth > 0 ? <Text backgroundColor={backgroundColor}>{" ".repeat(fillWidth)}</Text> : null}
    </Text>
  );
}

function chatLineDisplayText(line: ChatDisplayLine): string {
  return line.text || " ";
}

function chatContentWidth(terminalWidth: number): number {
  return Math.max(8, terminalWidth - 2);
}

function chatSingleMessageDisplayLines(message: Message, contentWidth: number): ChatDisplayLine[] {
  const rawLines = chatMessageMarkdownLines(message);
  const rendered: ChatDisplayLine[] = [];

  rawLines.forEach((rawLine, rawIndex) => {
    const isFirstRawLine = rawIndex === 0;
    const firstPrefix = message.from === "user" && isFirstRawLine ? "> " : message.from === "user" ? "  " : "";
    const wrapWidth = Math.max(1, contentWidth - displayWidth(firstPrefix));
    const rawSpans = rawLine.spans;
    const visibleRawLine = chatSpanText(rawSpans);
    const wrapped = wrapChatSpans(rawSpans, wrapWidth);

    wrapped.forEach((chunkSpans, chunkIndex) => {
      const chunk = chatSpanText(chunkSpans);
      const continuation = !isFirstRawLine || chunkIndex > 0;
      const prefix = chatLinePrefix(
        message.from,
        visibleRawLine,
        continuation,
        chunkIndex > 0,
        rawLine.continuationPrefix
      );
      const lineWidth = Math.max(1, contentWidth - displayWidth(prefix));
      const fitted = displayWidth(chunk) > lineWidth
        ? wrapChatSpans(chunkSpans, lineWidth)
        : [chunkSpans];
      fitted.forEach((partSpans, partIndex) => {
        const part = chatSpanText(partSpans);
        const displaySpans = mergeChatSpans([
          ...(prefix ? [{ text: prefix, tone: "prefix" as const }] : []),
          ...partSpans
        ]);
        rendered.push({
          from: message.from,
          text: `${prefix}${part}`,
          continuation: continuation || partIndex > 0,
          spans: displaySpans,
          background: rawLine.background
        });
      });
    });
  });

  return rendered;
}

function chatMessageMarkdownLines(message: Message): ChatMarkdownLine[] {
  const compact = message.from === "system" ? compactSupervisorSummaryForChat(message.text) : null;
  if (compact) {
    return compact.map((line) => ({
      spans: compactChatSummarySpans(line),
      continuationPrefix: isCompactChatSummaryLine(line) ? "  " : undefined
    }));
  }
  return chatMarkdownBlockLines(message.text);
}

function chatMarkdownBlockLines(text: string): ChatMarkdownLine[] {
  if (!text) {
    return [{ spans: [] }];
  }
  try {
    const lines = chatBlockTokensToLines(Lexer.lex(text));
    return lines.length > 0 ? lines : [{ spans: [] }];
  } catch {
    return text.split(/\r?\n/).map((line) => ({ spans: chatMarkdownSpans(line) }));
  }
}

function chatBlockTokensToLines(tokens: Token[]): ChatMarkdownLine[] {
  return tokens.flatMap((token) => chatBlockTokenToLines(token));
}

function chatBlockTokenToLines(token: Token): ChatMarkdownLine[] {
  if (token.type === "space") {
    return [{ spans: [] }];
  }
  if (token.type === "checkbox") {
    return [];
  }
  if (token.type === "heading") {
    return chatInlineMarkdownLines(tokenText(token)).map((line) => ({
      ...line,
      spans: applyChatSpanTone(line.spans, "heading")
    }));
  }
  if (token.type === "paragraph" || token.type === "text") {
    return chatInlineMarkdownLines(tokenText(token));
  }
  if (isChatListToken(token)) {
    return chatListTokenToLines(token);
  }
  if (token.type === "blockquote") {
    return chatBlockTokensToLines(tokenTokens(token)).map((line) => (
      chatMarkdownLineIsBlank(line)
        ? line
        : prependChatMarkdownLine(line, "│ ", "muted", "  ")
    ));
  }
  if (isChatCodeToken(token)) {
    return chatCodeTokenToLines(token);
  }
  if (token.type === "hr") {
    return [{ spans: [{ text: "· · ·", tone: "muted" }] }];
  }
  if (isChatTableToken(token)) {
    return chatTableTokenToLines(token);
  }
  if (token.type === "html") {
    return tokenText(token).split(/\r?\n/).map((line: string) => ({ spans: chatMarkdownSpans(line) }));
  }
  if (token.type === "def") {
    return [];
  }

  const nested = tokenTokens(token);
  if (nested.length > 0) {
    return chatBlockTokensToLines(nested);
  }
  return tokenText(token).split(/\r?\n/).map((line) => ({ spans: chatMarkdownSpans(line) }));
}

function chatInlineMarkdownLines(text: string): ChatMarkdownLine[] {
  return text.split(/\r?\n/).map((line) => ({ spans: chatMarkdownSpans(line) }));
}

function chatListTokenToLines(token: Tokens.List): ChatMarkdownLine[] {
  const rendered: ChatMarkdownLine[] = [];
  const start = typeof token.start === "number" ? token.start : 1;

  token.items.forEach((item, itemIndex) => {
    const marker = item.task
      ? item.checked ? "[x] " : "[ ] "
      : token.ordered ? `${start + itemIndex}. ` : "• ";
    const continuationPrefix = " ".repeat(displayWidth(marker));
    let hasItemContent = false;

    for (const itemToken of item.tokens) {
      if (isChatListToken(itemToken)) {
        const nested = chatListTokenToLines(itemToken);
        rendered.push(...nested.map((line) => (
          chatMarkdownLineIsBlank(line)
            ? line
            : prependChatMarkdownLine(line, continuationPrefix, "muted", continuationPrefix)
        )));
        continue;
      }

      for (const line of chatBlockTokenToLines(itemToken)) {
        if (chatMarkdownLineIsBlank(line)) {
          rendered.push(line);
          continue;
        }
        if (!hasItemContent) {
          rendered.push(prependChatMarkdownLine(line, marker, "muted", continuationPrefix));
          hasItemContent = true;
        } else {
          rendered.push(prependChatMarkdownLine(line, continuationPrefix, "muted", continuationPrefix));
        }
      }
    }

    if (!hasItemContent && !item.tokens.some((itemToken) => itemToken.type === "list")) {
      rendered.push({ spans: [{ text: marker.trimEnd(), tone: "muted" }] });
    }
  });

  return rendered;
}

function chatCodeTokenToLines(token: Tokens.Code): ChatMarkdownLine[] {
  const rendered: ChatMarkdownLine[] = [];
  const language = token.lang?.trim().split(/\s+/)[0] ?? "";
  if (language) {
    rendered.push({
      spans: [{ text: language, tone: "muted" }],
      background: "rail"
    });
  }
  const codeLines = token.text.split(/\r?\n/);
  for (const line of codeLines) {
    rendered.push({
      spans: mergeChatSpans([
        { text: "| ", tone: "muted" },
        ...(line ? [{ text: line, tone: "code" as const }] : [])
      ]),
      background: "rail",
      continuationPrefix: "  "
    });
  }
  return rendered;
}

function chatTableTokenToLines(token: Tokens.Table): ChatMarkdownLine[] {
  const row = (cells: Tokens.TableCell[], heading: boolean): ChatMarkdownLine => ({
    spans: mergeChatSpans([
      { text: "| ", tone: "muted" },
      ...cells.flatMap((cell, index) => [
        ...applyChatSpanTone(chatSpansFromTokens(cell.tokens, "text"), heading ? "strong" : "text"),
        { text: index === cells.length - 1 ? " |" : " | ", tone: "muted" as const }
      ])
    ]),
    background: "rail",
    continuationPrefix: "  "
  });
  return [row(token.header, true), ...token.rows.map((cells) => row(cells, false))];
}

function prependChatMarkdownLine(
  line: ChatMarkdownLine,
  prefix: string,
  tone: ChatSpanTone,
  continuationPrefix: string
): ChatMarkdownLine {
  return {
    ...line,
    spans: mergeChatSpans([{ text: prefix, tone }, ...line.spans]),
    continuationPrefix
  };
}

function chatMarkdownLineIsBlank(line: ChatMarkdownLine): boolean {
  return !chatSpanText(line.spans).trim();
}

function isChatListToken(token: Token): token is Tokens.List {
  return token.type === "list" && "items" in token && Array.isArray(token.items);
}

function isChatCodeToken(token: Token): token is Tokens.Code {
  return token.type === "code" && "text" in token && typeof token.text === "string";
}

function isChatTableToken(token: Token): token is Tokens.Table {
  return (
    token.type === "table" &&
    "header" in token && Array.isArray(token.header) &&
    "rows" in token && Array.isArray(token.rows)
  );
}

function chatMarkdownSpans(text: string): ChatDisplaySpan[] {
  if (!text) {
    return [];
  }
  try {
    return mergeChatSpans(chatSpansFromTokens(Lexer.lexInline(text), "text"));
  } catch {
    return [{ text, tone: "text" }];
  }
}

function chatSpansFromTokens(tokens: Token[], inheritedTone: ChatSpanTone): ChatDisplaySpan[] {
  return tokens.flatMap((token) => chatSpansFromToken(token, inheritedTone));
}

function chatSpansFromToken(token: Token, inheritedTone: ChatSpanTone): ChatDisplaySpan[] {
  const nested = tokenTokens(token);
  if (token.type === "codespan" || token.type === "code") {
    return [{ text: tokenText(token), tone: "code" }];
  }
  if (token.type === "link" || token.type === "image") {
    const label = chatSpanText(chatSpansFromTokens(nested, "text")) || tokenText(token);
    const href = tokenHref(token);
    return mergeChatSpans([
      ...(label ? [{ text: label, tone: "link" as const }] : []),
      ...(href && isExternalChatLink(href) && href !== label
        ? [{ text: ` <${href}>`, tone: "muted" as const }]
        : [])
    ]);
  }
  if (token.type === "strong") {
    return applyChatSpanTone(chatSpansFromTokens(nested, inheritedTone), "strong");
  }
  if (token.type === "em") {
    return applyChatSpanTone(chatSpansFromTokens(nested, inheritedTone), "emphasis");
  }
  if (token.type === "del") {
    return applyChatSpanTone(chatSpansFromTokens(nested, inheritedTone), "muted");
  }
  if (token.type === "br") {
    return [{ text: " ", tone: inheritedTone }];
  }
  if (nested.length > 0) {
    return chatSpansFromTokens(nested, inheritedTone);
  }

  const text = token.type === "html"
    ? tokenText(token).replace(/<[^>]*>/g, "")
    : tokenText(token);
  return text ? [{ text: decodeHtmlEntities(text), tone: inheritedTone }] : [];
}

function tokenTokens(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function tokenText(token: Token): string {
  if ("text" in token && typeof token.text === "string") {
    return token.text;
  }
  return typeof token.raw === "string" ? token.raw : "";
}

function tokenHref(token: Token): string {
  return "href" in token && typeof token.href === "string" ? token.href.trim() : "";
}

function applyChatSpanTone(spans: ChatDisplaySpan[], tone: ChatSpanTone): ChatDisplaySpan[] {
  return spans.map((span) => ({
    ...span,
    tone: span.tone === "code" || span.tone === "link" ? span.tone : tone
  }));
}

function isExternalChatLink(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href);
}

function chatSpanText(spans: ChatDisplaySpan[]): string {
  return spans.map((span) => span.text).join("");
}

function mergeChatSpans(spans: ChatDisplaySpan[]): ChatDisplaySpan[] {
  const merged: ChatDisplaySpan[] = [];
  for (const span of spans) {
    if (!span.text) {
      continue;
    }
    const previous = merged.at(-1);
    if (previous?.tone === span.tone) {
      previous.text += span.text;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function wrapChatSpans(spans: ChatDisplaySpan[], maxWidth: number): ChatDisplaySpan[][] {
  const text = chatSpanText(spans);
  if (!text) {
    return [[]];
  }
  const chunks = wrapByDisplayWidth(text, maxWidth);
  let cursor = 0;
  return chunks.map((chunk) => {
    const found = text.indexOf(chunk, cursor);
    const start = found >= 0 ? found : cursor;
    const end = start + chunk.length;
    cursor = end;
    return sliceChatSpans(spans, start, end);
  });
}

function sliceChatSpans(spans: ChatDisplaySpan[], start: number, end: number): ChatDisplaySpan[] {
  const sliced: ChatDisplaySpan[] = [];
  let offset = 0;
  for (const span of spans) {
    const spanStart = offset;
    const spanEnd = spanStart + span.text.length;
    offset = spanEnd;
    const overlapStart = Math.max(start, spanStart);
    const overlapEnd = Math.min(end, spanEnd);
    if (overlapStart < overlapEnd) {
      sliced.push({
        text: span.text.slice(overlapStart - spanStart, overlapEnd - spanStart),
        tone: span.tone
      });
    }
  }
  return mergeChatSpans(sliced);
}

function chatLinePrefix(
  from: Message["from"],
  rawLine: string,
  continuation: boolean,
  wrappedContinuation: boolean,
  markdownContinuationPrefix: string | undefined
): string {
  if (from === "user") {
    return continuation ? "  " : "> ";
  }
  if (from === "system" && wrappedContinuation) {
    return markdownContinuationPrefix ?? (isCompactChatSummaryLine(rawLine) ? "  " : "");
  }
  return "";
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

function compactChatSummarySpans(line: string): ChatDisplaySpan[] {
  const match = line.match(/^([^·]+?)\s+·\s+(.+)$/u);
  if (!match) {
    return chatMarkdownSpans(line);
  }

  const label = (match[1] ?? "").trim();
  const value = (match[2] ?? "").trim();
  const labelTone: ChatSpanTone = label === "done" ? "success" : "muted";
  const valueSpans: ChatDisplaySpan[] = label === "review" && /^APPROVED\b/i.test(value)
    ? [{ text: value, tone: "success" }]
    : label === "findings" && /^none$/i.test(value)
      ? [{ text: value, tone: "muted" }]
      : chatMarkdownSpans(value);

  return mergeChatSpans([
    { text: label, tone: labelTone },
    { text: " · ", tone: "muted" },
    ...valueSpans
  ]);
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
  const contentWidth = chatContentWidth(terminalWidth);
  const line = chatEmptyStateDisplayLine(cwd, activeTaskId, contentWidth);
  const fillWidth = Math.max(0, contentWidth - displayWidth(line));

  return (
    <Box flexDirection="column">
      <Text>
        <Text {...chatEmptyStateTheme()}>{line}</Text>
        {fillWidth > 0 ? <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(fillWidth)}</Text> : null}
      </Text>
    </Box>
  );
}

export function chatEmptyStateTrailingFillWidth(cwd: string, activeTaskId: string | null, terminalWidth: number): number {
  const contentWidth = chatContentWidth(terminalWidth);
  const line = chatEmptyStateDisplayLine(cwd, activeTaskId, contentWidth);
  return Math.max(0, contentWidth - displayWidth(line));
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
  if (contentWidth >= 38) {
    return "ready";
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

function restoredWorkerStatusLine(
  taskId: string | null,
  workers: WorkerLogRef[] | undefined
): StatusLineState | null {
  if (!taskId) {
    return null;
  }

  const state: StatusLineState = { taskId };
  const restored = (workers ?? []).flatMap((worker) => {
    if (!worker.runtimeStatus) {
      return [];
    }
    return [{
      role: worker.role,
      label: worker.label,
      status: formatWorkerRuntimeStatus(worker.runtimeStatus)
    }];
  });
  if (restored.length === 0) {
    return state;
  }

  state.workers = restored.map(({ label, status }) => ({ label, status }));
  for (const worker of restored) {
    state[worker.role] = worker.status;
  }
  return state;
}

function workerTitle(workers: WorkerLogRef[], selectedWorkerIndex: number): string {
  const worker = workers[selectedWorkerIndex];
  if (!worker) {
    return "Worker Output";
  }
  return `${worker.label} output (${selectedWorkerIndex + 1}/${workers.length})`;
}

function sameWorkerRuntimeStatus(
  left: WorkerLogRef["runtimeStatus"],
  right: WorkerLogRef["runtimeStatus"]
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.worker_id === right.worker_id &&
    left.feature_id === right.feature_id &&
    left.feature_title === right.feature_title &&
    left.role === right.role &&
    left.engine === right.engine &&
    left.state === right.state &&
    left.phase === right.phase &&
    left.last_event_at === right.last_event_at &&
    left.summary === right.summary &&
    left.native_session_id === right.native_session_id;
}

function sameWorkerNavigationTargets(
  left: WorkerOutputNavigationTargets,
  right: WorkerOutputNavigationTargets
): boolean {
  return sameNumberArray(left.searchOffsets, right.searchOffsets) &&
    sameNumberArray(left.searchLineIndexes, right.searchLineIndexes) &&
    sameNumberArray(left.errorOffsets, right.errorOffsets) &&
    sameNumberArray(left.diffOffsets, right.diffOffsets);
}

function sameNumberArray(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function previewRouteFallbackChoice(route: RouteDecision, choice: RouteFallbackChoice): RouteDecision {
  const mode = choice === "main" ? "simple" : choice === "parallel" ? "complex" : route.mode;
  return {
    ...route,
    mode,
    suggested_roles: mode === "complex" ? ["judge", "actor", "critic"] : [],
    router_fallback_resolution: choice === "cancel" ? "cancelled" : choice
  };
}

export function appContentHeight(rows: number, hasError = false, showStatusBar = true): number {
  const headerRows = 1;
  const inputRows = 1;
  const statusRows = showStatusBar ? 1 : 0;
  const errorRows = hasError ? 1 : 0;
  return Math.max(2, rows - headerRows - inputRows - statusRows - errorRows);
}

function NativeAttachView({
  attach,
  viewportHeight
}: {
  attach: {
    hasOutput: boolean;
    launch: NativeAttachLaunch;
    snapshot: string;
    screen: NativeTerminalScreen;
    closedCode: number | null;
  } | null;
  viewportHeight: number;
}) {
  if (!attach) {
    return <Text {...nativeAttachStartingTheme()}>{nativeAttachStartingText()}</Text>;
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
  const outputMinLines = Math.max(1, viewportHeight - 1);

  return (
    <Box flexDirection="column">
      <NativeAttachTitleRail title={title} width={panelWidth} />
      <TerminalOutput
        lines={attach.hasOutput ? attach.screen.styledSnapshotLines({ showCursor: true }) : []}
        minLines={outputMinLines}
        width={panelWidth}
      />
    </Box>
  );
}

export function nativeAttachStartingTheme(): NativeAttachStartingTheme {
  return {
    backgroundColor: TUI_THEME.surface,
    color: TUI_THEME.muted
  };
}

export function nativeAttachStartingText(): string {
  return "opening native session";
}

function NativeAttachTitleRail({ title, width }: { title: string; width: number }) {
  const titleText = ` ${title} `;
  const segments = nativeAttachTitleSegments(title);
  const renderWidth = typeof process.stdout.columns === "number"
    ? width
    : null;
  const trailingWidth = renderWidth === null
    ? 0
    : Math.max(0, renderWidth - displayWidth(titleText));

  return (
    <Box>
      <Text backgroundColor={TUI_THEME.chrome}> </Text>
      {segments.map((segment, index) => (
        <Text
          key={`${segment.tone}-${index}`}
          backgroundColor={TUI_THEME.chrome}
          color={segment.tone === "identity" ? TUI_THEME.accent : segment.tone === "danger" ? TUI_THEME.danger : TUI_THEME.muted}
          bold={segment.tone === "identity"}
        >
          {segment.text}
        </Text>
      ))}
      <Text backgroundColor={TUI_THEME.chrome}> </Text>
      {trailingWidth > 0 ? <Text backgroundColor={TUI_THEME.chrome}>{" ".repeat(trailingWidth)}</Text> : null}
    </Box>
  );
}

function nativeAttachTitleSegments(title: string): Array<{ text: string; tone: "identity" | "muted" | "danger" }> {
  const parts = title.split(" · ");
  if (parts.length > 1) {
    return parts.map((part, index) => ({
      text: index === 0 ? part : ` · ${part}`,
      tone: index === 0 ? "identity" : isNativeExitTitlePart(part) ? "danger" : "muted"
    }));
  }

  const exitMatch = title.match(/^(.*?)(\s+(?:exited\s+\d+|exit:\d+))$/);
  if (exitMatch?.[1]) {
    return [
      { text: exitMatch[1], tone: "identity" },
      { text: exitMatch[2] ?? "", tone: "danger" }
    ];
  }
  return [{ text: title, tone: isNativeExitTitlePart(title) ? "danger" : "identity" }];
}

function isNativeExitTitlePart(text: string): boolean {
  return /^(?:exited\s+\d+|exit:\d+)$/.test(text.trim());
}

function nativeAttachPanelRailWidth(terminalWidth: number): number {
  const renderWidth = typeof process.stdout.columns === "number"
    ? Math.max(1, Math.min(terminalWidth, process.stdout.columns))
    : terminalWidth;
  return Math.max(1, renderWidth - 2);
}

export function nativeAttachTitleDisplay(
  label: string,
  sessionId: string,
  closedCode: number | null,
  terminalWidth = process.stdout.columns || 120,
  scrollLabel: string | null = null
): string {
  const exit = closedCode === null ? "" : `exit:${closedCode}`;
  const exitReadable = closedCode === null ? "" : `exited ${closedCode}`;
  const contentWidth = Math.max(1, terminalWidth - 2);

  if (terminalWidth < 24) {
    return tinyNativeAttachTitle(label, exit ? ` ${exit}` : "", contentWidth);
  }

  const compactLabel = compactNativeAttachLabel(label);
  const roleLabel = compactNativeAttachRole(label);

  if (exit) {
    return firstNativeTitleThatFits(withNativeTitleSuffix([
      ...(terminalWidth >= 32
        ? [
            `native ${compactLabel} · ${exitReadable}`,
            `native ${roleLabel} · ${exitReadable}`,
            `${roleLabel} ${exitReadable}`,
            exitReadable
          ]
        : []),
      `native ${compactLabel} · ${exit}`,
      `native ${roleLabel} · ${exit}`,
      `${roleLabel} ${exit}`,
      exit
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

export function nativeAttachTerminalRows(
  terminalRows = process.stdout.rows || 30,
  hasError = false,
  showStatusBar = true
): number {
  return Math.max(1, appContentHeight(terminalRows, hasError, showStatusBar) - 2);
}

export function nativeAttachExitLine(code: number, nativeTerminalCols: number): string {
  const contentWidth = Math.max(1, nativeTerminalCols);
  const candidates = [
    `process exited · code ${code}`,
    `exit code ${code}`,
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
