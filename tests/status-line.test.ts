import { describe, expect, it } from "vitest";
import * as statusLineModule from "../src/tui/status-line.js";
import {
  effectiveWorkerWatchdog,
  formatFooterHelp,
  formatSelectedWorkerStatus,
  formatStatusLine,
  formatWorkerRuntimeStatus,
  selectedWorkerStatusIsRedundant
} from "../src/tui/status-line.js";
import { displayWidth } from "../src/tui/display-width.js";

describe("formatStatusLine", () => {
  it("matches the worker runtime rules for effective watchdogs", () => {
    expect(effectiveWorkerWatchdog(120_000, 45 * 60_000)).toBe(120_000);
    expect(effectiveWorkerWatchdog(120_000, 60_000)).toBeUndefined();
    expect(effectiveWorkerWatchdog(120_000, 120_000)).toBeUndefined();
    expect(effectiveWorkerWatchdog(undefined, 60_000)).toBeUndefined();
  });

  it("formats idle state", () => {
    expect(formatStatusLine(null)).toBe("idle");
  });

  it("formats worker states", () => {
    expect(
      formatStatusLine({
        taskId: "task-a1b2",
        judge: "done",
        actor: "running",
        critic: "waiting"
      })
    ).toBe("a1b2 | judge done | actor run | critic wait");
  });

  it("formats main chat state", () => {
    expect(
      formatStatusLine({
        taskId: "main",
        main: "running"
      })
    ).toBe("main | main run");
  });

  it("identifies the actual Main engine in chat status", () => {
    expect(
      formatStatusLine({
        taskId: "main",
        main: "starting · process spawned",
        mainEngine: "claude"
      })
    ).toBe("main | main/claude starting");
  });

  it("distinguishes a silent Main worker from an active Router request", () => {
    expect(
      formatStatusLine({
        taskId: "main",
        main: "starting · process starting · Starting claude",
        mainEngine: "claude",
        mainProgress: {
          phase: "process-starting",
          elapsedMs: 12_700,
          firstOutputTimeoutMs: 120_000,
          idleTimeoutMs: 300_000
        }
      })
    ).toBe("main | main/claude waiting output · 12s / 2m first");
  });

  it("keeps the first second of Main progress visually stable", () => {
    expect(
      formatStatusLine({
        taskId: "main",
        main: "starting",
        mainEngine: "claude",
        mainProgress: {
          phase: "process-starting",
          elapsedMs: 480,
          firstOutputTimeoutMs: 5_000
        }
      })
    ).toBe("main | main/claude waiting output · 0s / 5s first");
  });

  it("reports buffered Main output as active work instead of silent startup", () => {
    expect(
      formatStatusLine({
        taskId: "main",
        main: "starting · process buffered",
        mainEngine: "claude",
        mainProgress: {
          phase: "process-buffered",
          elapsedMs: 12_700,
          firstOutputTimeoutMs: 45 * 60 * 1000
        }
      })
    ).toBe("main | main/claude working · buffered");
  });

  it("does not present an initialized Main worker as idle", () => {
    expect(
      formatStatusLine({
        taskId: "main",
        main: "idle · initialized · Main chat worker initialized",
        mainEngine: "claude",
        mainProgress: {
          phase: "initialized",
          elapsedMs: 20,
          firstOutputTimeoutMs: 5_000
        }
      })
    ).toBe("main | main/claude starting");
  });

  it("shows Main idle progress after the first output arrives", () => {
    expect(
      formatStatusLine({
        taskId: "main",
        main: "running · process output · Working",
        mainEngine: "claude",
        mainProgress: {
          phase: "process-output",
          elapsedMs: 4_900,
          firstOutputTimeoutMs: 120_000,
          idleTimeoutMs: 300_000
        }
      })
    ).toBe("main | main/claude responding · 4s / 5m idle");
  });

  it("keeps the current Main turn ahead of completed historical task workers", () => {
    expect(formatStatusLine({
      taskId: "task-20260707-033720-fefc",
      main: "done",
      workers: [
        { label: "Judge (codex)", status: "done/process-exited" },
        { label: "Actor (codex)", status: "done/process-exited" },
        { label: "Critic (codex)", status: "done/process-exited" }
      ]
    })).toBe("033720-fefc | main done");
  });

  it("formats concise route evidence while preserving exceptional sources", () => {
    const formatRouteStatus = (
      statusLineModule as typeof statusLineModule & {
        formatRouteStatus?: (route: Record<string, unknown> | null) => string;
      }
    ).formatRouteStatus;

    expect(formatRouteStatus).toBeTypeOf("function");
    expect(formatRouteStatus?.({ mode: "simple", source: "codex", duration_ms: 42 })).toBe("route simple · 42ms");
    expect(formatRouteStatus?.({ mode: "simple", source: "forced", duration_ms: 0 })).toBe("route simple · forced");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "codex",
      duration_ms: 42,
      router_attempt: 2
    })).toBe("route simple · try 2 · 42ms");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "codex",
      duration_ms: 42,
      router_command: "acme-router"
    })).toBe("route simple · 42ms");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "codex",
      duration_ms: 900,
      router_attempt: 2,
      router_total_duration_ms: 31500,
      router_recovered_from: "timeout",
      router_recovered_via: "auto-retry",
      router_recovered_timeout_kind: "idle",
      router_recovered_failure_stage: "streaming"
    })).toBe("route simple · auto recovered idle timeout · try 2 · 32s total");
    expect(formatRouteStatus?.({
      mode: "complex",
      source: "fallback",
      reason: "Codex router failed: Codex router timed out after 120000ms. Codex router fallback forced complex.",
      duration_ms: 120000
    })).toBe(
      "route complex · fallback · timeout · 120s"
    );
    expect(formatRouteStatus?.({
      mode: "complex",
      source: "fallback",
      reason: "Configured fallback selected.",
      duration_ms: 120000,
      router_failure_kind: "timeout",
      router_failure_stage: "streaming",
      router_timeout_kind: "total",
      router_stdout_bytes: 18
    })).toBe("route complex · fallback · total timeout after stdout · 120s");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Configured fallback selected.",
      router_failure_kind: "auth"
    })).toBe("route simple · fallback · auth");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Configured fallback selected."
    })).toBe("route simple · fallback · unknown failure");
    expect(formatRouteStatus?.({
      mode: "complex",
      source: "fallback",
      reason: "Codex router failed: connect ECONNREFUSED 127.0.0.1:7890. Codex router fallback forced complex."
    })).toBe("route complex · fallback · network");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router failed: Codex router timed out after 30000ms: Connecting through proxy http://***@127.0.0.1:7890. Codex router fallback forced simple.",
      duration_ms: 30000,
      router_failure_stage: "streaming",
      router_stdout_bytes: 0,
      router_stderr_bytes: 73
    })).toBe("route simple · fallback · timeout after stderr · proxy set · 30s");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router failed: Codex router timed out after 30000ms with proxy configured. Codex router fallback forced simple.",
      duration_ms: 30000,
      router_failure_stage: "waiting-output"
    })).toBe("route simple · fallback · timeout waiting output · proxy set · 30s");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router timed out after 30000ms.",
      duration_ms: 30000,
      router_failure_stage: "waiting-output",
      proxy_configured: true,
      proxy_source: "router-config",
      proxy_variable: "HTTPS_PROXY",
      proxy_endpoint: "proxy.test:8443"
    })).toBe("route simple · fallback · timeout waiting output · via proxy.test:8443 · 30s");
    expect(formatRouteStatus?.({
      mode: "complex",
      source: "fallback",
      reason: "Codex router timed out after 30000ms.",
      duration_ms: 30000,
      router_failure_stage: "waiting-output",
      proxy_configured: false
    })).toBe("route complex · fallback · timeout waiting output · direct · 30s");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router first output timed out after 15000ms.",
      duration_ms: 15000,
      router_failure_stage: "waiting-output",
      router_timeout_kind: "first-output",
      proxy_configured: false
    })).toBe("route simple · fallback · first output timeout · direct · 15s");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router idle timed out after 25000ms.",
      duration_ms: 25000,
      router_failure_stage: "streaming",
      router_timeout_kind: "idle",
      router_stdout_bytes: 0,
      router_stderr_bytes: 73,
      proxy_configured: true,
      proxy_endpoint: "proxy.test:8443"
    })).toBe("route simple · fallback · idle timeout after stderr · via proxy.test:8443 · 25s");
    expect(formatRouteStatus?.({
      mode: "complex",
      source: "fallback",
      reason: "Codex router timed out after 120000ms.",
      duration_ms: 120000,
      router_failure_stage: "streaming",
      router_timeout_kind: "total",
      router_stdout_bytes: 18,
      router_stderr_bytes: 0,
      proxy_configured: false
    })).toBe("route complex · fallback · total timeout after stdout · direct · 120s");
    expect(formatRouteStatus?.({
      mode: "complex",
      source: "fallback",
      reason: "Codex router timed out after 30000ms. User selected Parallel after Router fallback.",
      duration_ms: 30000,
      router_total_duration_ms: 60500,
      router_failure_stage: "waiting-output",
      router_attempt: 2,
      router_fallback_resolution: "parallel"
    })).toBe("route complex · fallback · user Parallel · try 2 · timeout waiting output · 61s total");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router timed out after 30000ms. User cancelled after Router fallback.",
      duration_ms: 30000,
      router_fallback_resolution: "cancelled"
    })).toBe("route simple · fallback · user cancelled · timeout · 30s");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router failed: proxy connection refused. Codex router fallback forced simple."
    })).toBe("route simple · fallback · proxy");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router exited with code 1: HTTP 401 Unauthorized; please sign in."
    })).toBe("route simple · fallback · auth");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router exited with code 1: HTTP 429 Too Many Requests; rate limit exceeded."
    })).toBe("route simple · fallback · rate limit");
    expect(formatRouteStatus?.({
      mode: "complex",
      source: "fallback",
      reason: "Codex router failed: Codex router exited with code 2. Codex router fallback forced complex."
    })).toBe("route complex · fallback · exit");
    expect(formatRouteStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "Codex router failed: No JSON object in Codex router output. Codex router fallback forced simple."
    })).toBe("route simple · fallback · invalid output");
    expect(formatRouteStatus?.({
      mode: "complex",
      source: "fallback",
      reason: "Codex router failed: Invalid Codex router mode. Codex router fallback forced complex."
    })).toBe("route complex · fallback · invalid output");
    expect(formatRouteStatus?.({
      mode: "complex",
      source: "forced",
      reason: "Forced complex mode after a timeout.",
      duration_ms: 120000
    })).toBe(
      "route complex · forced · 120s"
    );
    expect(formatRouteStatus?.(null)).toBe("");
  });

  it("formats the active router scope and maximum wait before a decision", () => {
    const formatRoutePendingStatus = (
      statusLineModule as typeof statusLineModule & {
      formatRoutePendingStatus?: (state: Record<string, unknown> | null, elapsedMs?: number) => string;
      }
    ).formatRoutePendingStatus;

    expect(formatRoutePendingStatus).toBeTypeOf("function");
    expect(formatRoutePendingStatus?.({ scope: "initial", mode: "auto", timeoutMs: 30000 })).toBe(
      "route checking · 30s max"
    );
    expect(formatRoutePendingStatus?.({ scope: "follow-up", mode: "auto", timeoutMs: 20000 })).toBe(
      "route follow-up · 20s max"
    );
    expect(formatRoutePendingStatus?.({ scope: "initial", mode: "auto", timeoutMs: 30000 }, 7300)).toBe(
      "route checking · 7s / 30s"
    );
    expect(formatRoutePendingStatus?.({ scope: "follow-up", mode: "auto", timeoutMs: 20000 }, 99999)).toBe(
      "route follow-up · 20s / 20s"
    );
    expect(formatRoutePendingStatus?.({
      scope: "initial",
      mode: "auto",
      timeoutMs: 30000,
      firstOutputTimeoutMs: 15000,
      idleTimeoutMs: 15000,
      phase: "waiting-output",
      command: "acme-router",
      proxyConfigured: false
    }, 7300)).toBe("route waiting output · runner acme-router · direct · 7s / 15s first · 30s total");
    expect(formatRoutePendingStatus?.({
      scope: "initial",
      mode: "auto",
      timeoutMs: 30000,
      firstOutputTimeoutMs: 15000,
      idleTimeoutMs: 15000,
      phase: "waiting-output",
      proxyConfigured: true,
      proxyEndpoint: "proxy.test:8443"
    }, 7300)).toBe("route waiting output · via proxy.test:8443 · 7s / 15s first · 30s total");
    expect(formatRoutePendingStatus?.({
      scope: "initial",
      mode: "auto",
      timeoutMs: 30000,
      firstOutputTimeoutMs: 15000,
      idleTimeoutMs: 15000,
      phase: "receiving-stderr",
      proxyConfigured: true,
      proxyEndpoint: "proxy.test:8443"
    }, 7300)).toBe("route diagnostics · via proxy.test:8443 · 7s / 30s total · 15s idle");
    expect(formatRoutePendingStatus?.({
      scope: "initial",
      mode: "auto",
      timeoutMs: 30000,
      firstOutputTimeoutMs: 15000,
      idleTimeoutMs: 15000,
      phase: "receiving-response",
      proxyConfigured: false
    }, 7300)).toBe("route receiving · direct · 7s / 30s total · 15s idle");
    expect(formatRoutePendingStatus?.({
      scope: "follow-up",
      mode: "auto",
      timeoutMs: 20000,
      phase: "parsing",
      proxyConfigured: false
    }, 19900)).toBe("route parsing · direct · 19s / 20s");
    expect(formatRoutePendingStatus?.({
      scope: "initial",
      mode: "auto",
      timeoutMs: 30000,
      phase: "stopping",
      proxyConfigured: false
    }, 30500)).toBe("route stopping · direct · 30s / 30s");
    expect(formatRoutePendingStatus?.({
      scope: "initial",
      mode: "auto",
      timeoutMs: 30000,
      phase: "retrying",
      attempt: 2,
      maxAttempts: 2,
      retryDelayMs: 500,
      command: "acme-router",
      proxyConfigured: true,
      proxyEndpoint: "proxy.test:8443"
    }, 300)).toBe("route retry 2/2 · runner acme-router · via proxy.test:8443 · 500ms backoff");
    expect(formatRoutePendingStatus?.({
      scope: "initial",
      mode: "auto",
      timeoutMs: 30000,
      phase: "starting",
      attempt: 2,
      maxAttempts: 2,
      proxyConfigured: false
    }, 300)).toBe("route starting · try 2 · direct · 0s / 30s");
    expect(formatRoutePendingStatus?.({ scope: "initial", mode: "complex", timeoutMs: 120000 })).toBe(
      "route complex · forced"
    );
    expect(formatRoutePendingStatus?.(null)).toBe("");
  });

  it("formats worker states as a compact summary instead of full worker logs", () => {
    const state: NonNullable<Parameters<typeof formatStatusLine>[0]> = {
      taskId: "task-a1b2",
      workers: [
        { label: "Actor (codex)", status: "running/editing native:019f1e36...: writing files" },
        { label: "Critic (claude)", status: "done/process-exited: claude exited with code 0" },
        { label: "Critic (codex)", status: "failed/process-idle-timeout: codex produced no output" }
      ]
    };

    expect(formatStatusLine(state)).toBe("a1b2 | workers 3 | fail 1 run 1 done 1");
    expect(formatSelectedWorkerStatus(state, 1)).toBe("critic/claude done");
  });

  it("identifies a selected worker footer as redundant only for a uniform worker state", () => {
    expect(selectedWorkerStatusIsRedundant({
      taskId: "task-uniform",
      workers: [
        { label: "Judge (codex)", status: "done/process-exited" },
        { label: "Actor (codex)", status: "done/process-exited" }
      ]
    })).toBe(true);
    expect(selectedWorkerStatusIsRedundant({
      taskId: "task-mixed",
      workers: [
        { label: "Judge (codex)", status: "done/process-exited" },
        { label: "Actor (codex)", status: "failed/process-exited" }
      ]
    })).toBe(false);
    expect(selectedWorkerStatusIsRedundant(null)).toBe(false);
  });

  it("keeps feature wave progress alongside worker counts", () => {
    const state: NonNullable<Parameters<typeof formatStatusLine>[0]> = {
      taskId: "task-a1b2",
      featureProgress: {
        wave: 1,
        waves: 3,
        phase: "actor",
        completed: 2,
        total: 4
      },
      workers: [
        { label: "Actor (codex) · UI", status: "running" },
        { label: "Actor (codex) · Engine", status: "running" },
        { label: "Actor (codex) · Audio", status: "done" },
        { label: "Actor (codex) · Input", status: "done" }
      ]
    };

    expect(formatStatusLine(state)).toBe(
      "a1b2 | wave 1/3 · actor 2/4 | workers 4 | run 2 done 2"
    );
  });

  it("shows the atomic integration phase after feature review", () => {
    expect(formatStatusLine({
      taskId: "task-a1b2",
      featureProgress: {
        wave: 2,
        waves: 3,
        phase: "integration",
        completed: 0,
        total: 1
      },
      workers: [
        { label: "Actor (codex) · UI", status: "done" },
        { label: "Critic (claude) · UI", status: "done" }
      ]
    })).toBe("a1b2 | wave 2/3 · integration 0/1 | workers 2 | done 2");
  });

  it("shows combined Wave Critic verification before live commit", () => {
    expect(formatStatusLine({
      taskId: "task-a1b2",
      featureProgress: {
        wave: 2,
        waves: 3,
        phase: "verification",
        completed: 0,
        total: 1
      },
      workers: [
        { label: "Critic (codex) · Wave 2/3", status: "running" }
      ]
    })).toBe("a1b2 | wave 2/3 · verification 0/1 | workers 1 | run 1");
  });

  it("keeps cancelled worker state concise and ahead of completed workers", () => {
    const state = {
      taskId: "task-stop",
      workers: [
        { label: "Judge (codex)", status: "done/process-exited" },
        { label: "Actor (codex)", status: "cancelled/process-cancelled" }
      ]
    };

    expect(formatStatusLine(state)).toBe("stop | workers 2 | stop 1 done 1");
    expect(formatSelectedWorkerStatus(state, 1)).toBe("actor/codex stop");
  });

  it("keeps feature titles out of the selected worker identity", () => {
    const state = {
      taskId: "task-feature-status",
      workers: [
        {
          label: "Actor (codex) · Input reliability and terminal interaction",
          status: "running/process-output"
        }
      ]
    };

    expect(formatSelectedWorkerStatus(state, 0)).toBe("actor/codex run");
  });

  it("shortens dated task ids for the footer", () => {
    expect(
      formatStatusLine({
        taskId: "task-20260630-093326-1980",
        workers: [
          { label: "Judge (codex)", status: "done/process-exited" },
          { label: "Actor (codex)", status: "failed/process-exited" }
        ]
      })
    ).toBe("093326-1980 | workers 2 | fail 1 done 1");
  });

  it("formats runtime worker status as readable status text", () => {
    expect(
      formatWorkerRuntimeStatus({
        state: "failed",
        phase: "process-idle-timeout",
        summary: "claude produced no output for 300000ms",
        native_session_id: "abc123"
      })
    ).toBe("failed · idle timeout · session abc123 · claude produced no output for 300000ms");
  });

  it("keeps runtime worker status compact when the session id is long", () => {
    expect(
      formatWorkerRuntimeStatus({
        state: "done",
        phase: "process-exited",
        summary: "",
        native_session_id: "019f1b9b-768b-7753-9c3b-33b17f25bc6b"
      })
    ).toBe("done · exited · session 019f1b9b... · no summary");
  });

  it("truncates runtime worker status by terminal display width", () => {
    const status = formatWorkerRuntimeStatus({
      state: "running",
      phase: "editing",
      summary: "正在编写俄罗斯方块游戏界面并修复状态栏中文显示宽度问题让底部提示在窄屏也稳定",
      native_session_id: "abc123"
    });

    expect(status).toContain("...");
    expect(displayWidth(status)).toBeLessThanOrEqual(96);
  });

  it("omits empty runtime worker phases instead of showing filler text", () => {
    expect(
      formatWorkerRuntimeStatus({
        state: "running",
        phase: "",
        summary: "writing files"
      })
    ).toBe("running · writing files");
  });

  it("keeps footer help short and mode aware", () => {
    expect(formatFooterHelp("chat")).toBe("^W logs · Tab · ^O attach");
    expect(formatFooterHelp("worker")).toBe("scroll · Tab · ^O attach · Esc chat");
    expect(formatFooterHelp("native")).toBe("scroll · ^] logs");
  });

  it("keeps the footer route summary short while retaining failure semantics", () => {
    const formatRouteSummaryStatus = (
      statusLineModule as typeof statusLineModule & {
        formatRouteSummaryStatus?: (route: Record<string, unknown> | null) => string;
      }
    ).formatRouteSummaryStatus;
    const formatRoutePendingSummaryStatus = (
      statusLineModule as typeof statusLineModule & {
        formatRoutePendingSummaryStatus?: (route: Record<string, unknown> | null, elapsedMs?: number) => string;
      }
    ).formatRoutePendingSummaryStatus;

    expect(formatRouteSummaryStatus?.({
      mode: "complex",
      source: "codex",
      duration_ms: 15000,
      proxy_configured: true,
      proxy_endpoint: "127.0.0.1:7890"
    })).toBe("route complex");
    expect(formatRouteSummaryStatus?.({
      mode: "simple",
      source: "fallback",
      reason: "router timed out",
      router_failure_kind: "timeout",
      duration_ms: 30000
    })).toBe("route simple · fallback · timeout");
    expect(formatRoutePendingSummaryStatus?.({
      scope: "initial",
      mode: "auto",
      command: "codex",
      timeoutMs: 30000,
      firstOutputTimeoutMs: 15000,
      idleTimeoutMs: 15000,
      phase: "waiting-output",
      attempt: 1,
      maxAttempts: 2,
      proxyConfigured: true
    }, 7400)).toBe("route waiting output · 7s");
  });
});
