import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { chatBusyDisplayValue, chatInputDisplayValue, chatPlaceholderDisplayValue, InputBar, inputRailLayout, mainConversationSessionsInputHints } from "../src/tui/InputBar.js";
import { displayWidth } from "../src/tui/display-width.js";

describe("InputBar", () => {
  it("shows copy confirmation without overflowing any terminal width", () => {
    const invalid: string[] = [];
    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar
          mode="worker"
          value=""
          terminalWidth={width}
          clipboardNotice={{ state: "copied", text: "copied visible logs · wheel still active" }}
          onChange={() => {}}
        />
      );
      const frame = view.lastFrame() ?? "";
      if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
        invalid.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      view.unmount();
    }
    expect(invalid).toEqual([]);
  });

  it("keeps generated chat placeholders semantic across every supported width", () => {
    const states = [
      ["idle", {}],
      ["workers", { hasWorkers: true }],
      ["task", { hasWorkers: true, hasActiveTask: true }],
      ["scrollable", { hasWorkers: true, hasActiveTask: true, maxScrollOffset: 20 }],
      ["active", { hasActiveTask: true }],
      ["retry", { canRetry: true }],
      ["retry-task", { canRetry: true, hasActiveTask: true }],
      ["back", { hasWorkers: true, scrollOffset: 3, maxScrollOffset: 20 }],
      ["history", { maxScrollOffset: 20 }],
      ["result", { hasWorkers: true, hasActiveTask: true, hasTaskResult: true }],
      ["result-expanded", { hasWorkers: true, hasActiveTask: true, hasTaskResult: true, taskResultExpanded: true }],
      ["result-scroll", { hasWorkers: true, hasActiveTask: true, hasTaskResult: true, taskResultExpanded: true, scrollOffset: 4, maxScrollOffset: 12 }]
    ] as const;
    const clipped: string[] = [];

    for (const [name, options] of states) {
      for (let width = 8; width <= 100; width += 1) {
        const value = chatPlaceholderDisplayValue(width, options);
        if (value.includes("...")) {
          clipped.push(`${name}:${width}:${value}`);
        }
      }
    }

    expect(clipped).toEqual([]);
  });

  it("keeps every empty chat prompt on one row across terminal widths", () => {
    const states = [
      ["idle", {}],
      ["workers", { hasWorkers: true }],
      ["task", { hasWorkers: true, hasActiveTask: true }],
      ["scrollable", { hasWorkers: true, hasActiveTask: true, chatMaxScrollOffset: 20 }],
      ["active", { hasActiveTask: true }],
      ["retry", { canRetry: true }],
      ["retry-task", { canRetry: true, hasActiveTask: true }],
      ["back", { hasWorkers: true, chatScrollOffset: 3, chatMaxScrollOffset: 20 }],
      ["history", { chatMaxScrollOffset: 20 }],
      ["result", { hasWorkers: true, hasActiveTask: true, hasTaskResult: true }],
      ["result-expanded", { hasWorkers: true, hasActiveTask: true, hasTaskResult: true, taskResultExpanded: true }],
      ["result-scroll", { hasWorkers: true, hasActiveTask: true, hasTaskResult: true, taskResultExpanded: true, chatScrollOffset: 4, chatMaxScrollOffset: 12 }]
    ] as const;
    const invalid: string[] = [];

    for (const [name, props] of states) {
      for (let width = 8; width <= 100; width += 1) {
        const view = render(
          <InputBar mode="chat" value="" terminalWidth={width} onChange={() => {}} {...props} />
        );
        const frame = view.lastFrame() ?? "";
        if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
          invalid.push(`${name}:${width}:${displayWidth(frame)}:${frame}`);
        }
        view.unmount();
      }
    }

    expect(invalid).toEqual([]);
  });

  it("shows chat input busy state without mounting raw input", () => {
    const { lastFrame } = render(<InputBar mode="chat" busy value="hello" onChange={() => {}} />);

    expect(lastFrame()).toContain("working");
    expect(lastFrame()).toContain("Esc stop");
    expect(lastFrame()).toContain("run");
    expect(lastFrame()).not.toContain("Running...");
  });

  it("shows a one-key Router fallback choice without overflowing", () => {
    const roomy = render(
      <InputBar mode="chat" busy routeFallback value="" terminalWidth={100} onChange={() => {}} />
    );
    expect(roomy.lastFrame()).toContain("route failed · 1 Main · 2 Parallel · R retry · Esc cancel");
    roomy.unmount();

    const overflow: string[] = [];
    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar mode="chat" busy routeFallback value="" terminalWidth={width} onChange={() => {}} />
      );
      const frame = view.lastFrame() ?? "";
      if (frame.split("\n").length > 1 || displayWidth(frame) > width) {
        overflow.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      view.unmount();
    }
    expect(overflow).toEqual([]);
  });

  it("hides actionable chat controls until the raw input listener is ready", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" ready={false} value="" hasWorkers terminalWidth={40} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame.trim()).toBe("starting");
    expect(frame).not.toContain("|");
    expect(frame).not.toContain("^W");
    expect(frame).not.toContain("^O");
  });

  it("shows a visible cursor at the end of chat input", () => {
    const { lastFrame } = render(<InputBar mode="chat" value="hello" onChange={() => {}} />);

    expect(lastFrame()).toContain("> hello|");
    expect(lastFrame()).not.toContain("Input:");
  });

  it("renders the cursor at a Unicode code-point position", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" value="你好世界" cursor={2} terminalWidth={40} onChange={() => {}} />
    );

    expect(lastFrame()).toContain("> 你好|世界");
  });

  it("renders multiline paste markers on one stable input row", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" value={"第一行\t参数\n第二行"} cursor={10} terminalWidth={40} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> 第一行⇥参数↵第二行|");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(40);
  });

  it("keeps both sides of a middle cursor visible in long narrow input", () => {
    const value = "前面的中文内容很长需要隐藏中间光标后面的内容同样很长";
    const cursor = [...value].indexOf("光");
    const { lastFrame } = render(
      <InputBar mode="chat" value={value} cursor={cursor} terminalWidth={32} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("中间|光标");
    expect(frame.match(/\.\.\./g)?.length).toBe(2);
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(32);
  });

  it("shows retry as the primary idle action for a failed task", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" canRetry value="" terminalWidth={40} onChange={() => {}} />
    );

    expect(lastFrame()).toContain("> | message · ^R retry");
  });

  it("offers retry or a new task after an active task fails", () => {
    const roomy = render(
      <InputBar mode="chat" canRetry hasActiveTask value="" terminalWidth={40} onChange={() => {}} />
    );
    expect(roomy.lastFrame()).toContain("> | message · ^R retry · ^N new");

    const narrow = render(
      <InputBar mode="chat" canRetry hasActiveTask value="" terminalWidth={28} onChange={() => {}} />
    );
    expect(narrow.lastFrame()).toContain("> | ^R retry · ^N");
    expect(displayWidth(narrow.lastFrame() ?? "")).toBeLessThanOrEqual(28);
  });

  it("keeps long chat input to one visible tail row", () => {
    const value = "请帮我继续优化这个并行编码终端界面让它在窄屏下也保持专业稳定不要换行乱掉";
    const { lastFrame } = render(
      <InputBar mode="chat" value={value} terminalWidth={32} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("...");
    expect(frame).toContain("不要换行乱掉|");
    expect(frame).not.toContain("请帮我继续优化");
    expect(frame.split("\n")).toHaveLength(1);
  });

  it("keeps the full chat input display when it fits", () => {
    expect(chatInputDisplayValue("做个俄罗斯方块的游戏", 120)).toBe("做个俄罗斯方块的游戏");
  });

  it("uses intentional chat placeholders in ultra narrow terminals", () => {
    expect(chatPlaceholderDisplayValue(10)).toBe("msg");
    expect(chatPlaceholderDisplayValue(16)).toBe("message");
    expect(chatPlaceholderDisplayValue(24)).toBe("message · ^N new");

    const { lastFrame } = render(
      <InputBar mode="chat" value="" terminalWidth={12} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> | msg");
    expect(frame).not.toContain("...");
    expect(displayWidth(frame)).toBeLessThanOrEqual(12);
  });

  it("exposes the workspace switcher when the input rail has room", () => {
    expect(chatPlaceholderDisplayValue(40)).toBe("message · ^N new · ^P project");
    expect(chatPlaceholderDisplayValue(80)).toBe("message · ^N new · ^P project · ^T tasks · ^G routes");
    expect(chatPlaceholderDisplayValue(40, { hasActiveTask: true })).toBe(
      "message · ^N new · ^P project"
    );
    expect(chatPlaceholderDisplayValue(80, { hasActiveTask: true })).toBe(
      "message · ^N new · ^P project · ^T tasks · ^G routes"
    );
  });

  it("fills short chat input rows to the reserved rail width without stdout columns", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" value="" terminalWidth={40} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    const layout = inputRailLayout(40, displayWidth("> | message"));

    expect(frame).toContain("> | message");
    expect(layout.leadingWidth + displayWidth("> | message") + layout.trailingWidth).toBe(39);
  });

  it("keeps the prompt marker visible in nano chat terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={8} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain(">|msg");
    expect(frame).not.toContain("  | msg");
    expect(displayWidth(frame)).toBeLessThanOrEqual(8);
  });

  it("shows worker and new-conversation shortcuts in the empty chat prompt once workers exist", () => {
    expect(chatPlaceholderDisplayValue(80, { hasWorkers: true })).toBe("^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes");
    expect(chatPlaceholderDisplayValue(42, { hasWorkers: true })).toBe("message · ^W logs · Tab · ^O attach");
    expect(chatPlaceholderDisplayValue(41, { hasWorkers: true })).toBe("message · ^W logs · Tab · ^O attach");
    expect(chatPlaceholderDisplayValue(40, { hasWorkers: true })).toBe("message · ^W logs · ^O attach");
    expect(chatPlaceholderDisplayValue(30, { hasWorkers: true })).toBe("^W logs · ^O attach");
    expect(chatPlaceholderDisplayValue(20, { hasWorkers: true })).toBe("msg · ^W logs");
    expect(chatPlaceholderDisplayValue(19, { hasWorkers: true })).toBe("msg · ^W logs");
    expect(chatPlaceholderDisplayValue(18, { hasWorkers: true })).toBe("^W logs");
    expect(chatPlaceholderDisplayValue(16, { hasWorkers: true })).toBe("^W logs");

    const { lastFrame } = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={80} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Type a message");
    expect(frame).toContain("^N new");
    expect(frame).toContain("^W logs");
    expect(frame).toContain("Tab");
    expect(frame).toContain("^O attach");
    expect(frame).toContain("^B workers");
    expect(frame).toContain("^T tasks");
    expect(frame).toContain("^G routes");
  });

  it("keeps Worker chat actions semantic across terminal widths", () => {
    const states = [
      ["workers", { hasWorkers: true }],
      ["active", { hasWorkers: true, hasActiveTask: true }],
      ["scrollable", { hasWorkers: true, maxScrollOffset: 20 }],
      ["active-scrollable", { hasWorkers: true, hasActiveTask: true, maxScrollOffset: 20 }]
    ] as const;
    const semantics = [
      ["logs", /\^W logs?/],
      ["attach", /\^O attach/],
      ["workers", /\^B workers/],
      ["scroll", /(?:scroll|Pg(?:Up\/Dn)?)/]
    ] as const;
    const overflow: string[] = [];
    const bareActions: string[] = [];
    const semanticLoss: string[] = [];

    for (const [stateName, props] of states) {
      const seenSemantics = new Set<string>();
      for (let width = 8; width <= 100; width += 1) {
        const view = render(
          <InputBar mode="chat" value="" terminalWidth={width} onChange={() => {}} {...props} />
        );
        const frame = view.lastFrame() ?? "";
        const separatorIndex = frame.indexOf("|");
        const guidance = (separatorIndex >= 0 ? frame.slice(separatorIndex + 1) : frame).trimStart();
        if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
          overflow.push(`${stateName}:${width}:${displayWidth(frame)}:${frame}`);
        }
        if (/(?:^| · )\^(?:W|O|B)(?= ·|$)/.test(guidance)) {
          bareActions.push(`${stateName}:${width}:${frame}`);
        }
        for (const [name, pattern] of semantics) {
          if (pattern.test(guidance)) {
            seenSemantics.add(name);
          } else if (seenSemantics.has(name)) {
            semanticLoss.push(`${stateName}:${width}:${name}:${frame}`);
          }
        }
        view.unmount();
      }
    }

    expect(overflow).toEqual([]);
    expect(bareActions).toEqual([]);
    expect(semanticLoss).toEqual([]);
  });

  it("prioritizes the task-result toggle after a complex task completes", () => {
    expect(chatPlaceholderDisplayValue(80, {
      hasWorkers: true,
      hasActiveTask: true,
      hasTaskResult: true,
      taskResultExpanded: true
    })).toContain("^D compact");
    expect(chatPlaceholderDisplayValue(42, {
      hasWorkers: true,
      hasActiveTask: true,
      hasTaskResult: true,
      taskResultExpanded: false
    })).toContain("^D details");
    expect(chatPlaceholderDisplayValue(16, {
      hasWorkers: true,
      hasActiveTask: true,
      hasTaskResult: true,
      taskResultExpanded: true
    })).toBe("^D compact");
  });

  it("renders the result toggle in the themed chat rail", () => {
    const { lastFrame } = render(<InputBar
      mode="chat"
      value=""
      hasWorkers
      hasActiveTask
      hasTaskResult
      taskResultExpanded
      terminalWidth={60}
    />);

    expect(lastFrame()).toContain("^D compact");
  });

  it("uses an intentional compact task hint instead of a clipped word at 40 columns", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" value="" hasWorkers hasActiveTask terminalWidth={40} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> | message · ^W logs · ^O attach");
    expect(frame).not.toContain("...age");
    expect(displayWidth(frame)).toBeLessThanOrEqual(40);
  });

  it("shows the new-conversation shortcut whenever the chat rail has room", () => {
    const roomy = render(
      <InputBar mode="chat" value="" hasWorkers hasActiveTask terminalWidth={80} onChange={() => {}} />
    );
    try {
      expect(roomy.lastFrame()).toContain("^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes");
    } finally {
      roomy.unmount();
    }

    const narrow = render(
      <InputBar mode="chat" value="" hasWorkers hasActiveTask terminalWidth={42} onChange={() => {}} />
    );
    try {
      expect(narrow.lastFrame()).toContain("message · ^W logs · Tab · ^O attach");
      expect(narrow.lastFrame()).not.toContain("^N");
      expect(displayWidth(narrow.lastFrame() ?? "")).toBeLessThanOrEqual(42);
    } finally {
      narrow.unmount();
    }

    const noTask = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={80} onChange={() => {}} />
    );
    expect(noTask.lastFrame()).toContain("^N new");

    const loadingWorkers = render(
      <InputBar mode="chat" value="" hasActiveTask terminalWidth={40} onChange={() => {}} />
    );
    expect(loadingWorkers.lastFrame()).toContain("message · ^N new");
    expect(loadingWorkers.lastFrame()).not.toContain("^W");
  });

  it("shows chat history navigation without crowding narrow prompts", () => {
    const scrollable = { hasWorkers: true, maxScrollOffset: 20 } as Parameters<typeof chatPlaceholderDisplayValue>[1];
    const scrolled = {
      hasWorkers: true,
      scrollOffset: 3,
      maxScrollOffset: 20
    } as Parameters<typeof chatPlaceholderDisplayValue>[1];

    expect(chatPlaceholderDisplayValue(80, scrollable)).toBe(
      "message · scroll · ^W logs · ^B workers · Tab · ^O attach · ^G routes"
    );
    expect(chatPlaceholderDisplayValue(80, scrolled)).toBe(
      "message · back 3/20 · PgDn latest"
    );
    expect(chatPlaceholderDisplayValue(30, scrolled)).toBe("back 3/20 · PgDn");
    expect(chatPlaceholderDisplayValue(20, scrolled)).toBe("back 3/20");
    expect(chatPlaceholderDisplayValue(16, scrolled)).toBe("back 3");
    expect(chatPlaceholderDisplayValue(38, scrolled)).toBe("back 3/20 · PgDn latest");
    expect(chatPlaceholderDisplayValue(30, { maxScrollOffset: 20 } as Parameters<typeof chatPlaceholderDisplayValue>[1])).toBe(
      "message · scroll"
    );
    expect(chatPlaceholderDisplayValue(40, {
      hasWorkers: true,
      hasActiveTask: true,
      maxScrollOffset: 20
    })).toBe("scroll · ^W logs · Tab · ^O attach");
    expect(chatPlaceholderDisplayValue(24, {
      hasWorkers: true,
      hasActiveTask: true,
      maxScrollOffset: 20
    })).toBe("message · ^W logs");
    expect(chatPlaceholderDisplayValue(22, { canRetry: true })).toBe("^R retry");
  });

  it("keeps ultra-narrow task chat prompt off the terminal edge", () => {
    const eighteen = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={18} onChange={() => {}} />
    );

    try {
      const frame = eighteen.lastFrame() ?? "";
      expect(frame).toContain("> | ^W logs");
      expect(frame).not.toContain("^O");
      expect(displayWidth(frame)).toBeLessThanOrEqual(18);
    } finally {
      eighteen.unmount();
    }

    const nineteen = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={19} onChange={() => {}} />
    );

    try {
      const frame = nineteen.lastFrame() ?? "";
      expect(frame).toContain("> | msg · ^W logs");
      expect(displayWidth(frame)).toBeLessThanOrEqual(19);
    } finally {
      nineteen.unmount();
    }
  });

  it("keeps task shortcut chat prompt compact in narrow terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={30} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> | ^W logs · ^O attach");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(30);
  });

  it("keeps worker chat shortcuts discoverable in tiny terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={20} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> | msg · ^W logs");
    expect(frame).not.toContain("^O");
    expect(frame).not.toContain("message");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(20);
  });

  it("uses intentional busy text in ultra narrow terminals", () => {
    expect(chatBusyDisplayValue(10)).toBe("");
    expect(chatBusyDisplayValue(16)).toBe("busy");
    expect(chatBusyDisplayValue(24)).toBe("working");
    expect(chatBusyDisplayValue(40)).toBe("working · Esc stop");
    expect(chatBusyDisplayValue(80, true)).toBe("working · Esc stop · ^C detach");
    expect(chatBusyDisplayValue(80, true, false)).toBe("observing · ^C detach");
    expect(chatBusyDisplayValue(28, true, false)).toBe("^C detach");

    const { lastFrame } = render(
      <InputBar mode="chat" busy value="" terminalWidth={10} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toBe(" run");
    expect(frame).not.toContain("Running");
    expect(displayWidth(frame)).toBeLessThanOrEqual(10);
  });

  it("shows native attach guidance without a separate local draft", () => {
    const { lastFrame } = render(<InputBar mode="native" value="你好" onChange={() => {}} />);

    expect(lastFrame()).toContain("native");
    expect(lastFrame()).not.toContain("你好");
  });

  it("shows worker log browsing state instead of a fake chat prompt", () => {
    const { lastFrame } = render(<InputBar mode="worker" value="做个俄罗斯方块" onChange={() => {}} />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("logs");
    expect(frame).toContain("scroll");
    expect(frame).toContain("Tab");
    expect(frame).toContain("^O attach");
    expect(frame).toContain("^B workers");
    expect(frame).toContain("^F find");
    expect(frame).toContain("E err");
    expect(frame).toContain("D diff");
    expect(frame).not.toContain("Tab worker");
    expect(frame).not.toContain("wheel/Pg");
    expect(frame).not.toContain("read");
    expect(frame).not.toContain("Type a message");
    expect(frame).not.toContain("做个俄罗斯方块");
  });

  it("shows Router diagnostics navigation and refresh guidance", () => {
    const roomy = render(
      <InputBar mode="router" value="ignored" terminalWidth={80} onChange={() => {}} />
    );
    const roomyFrame = roomy.lastFrame() ?? "";
    expect(roomyFrame).toContain("routes · scroll · Tab scope · ^G refresh · Esc chat");
    expect(roomyFrame).not.toContain("ignored");
    expect(roomyFrame.split("\n")).toHaveLength(1);
    expect(displayWidth(roomyFrame)).toBeLessThanOrEqual(80);
    roomy.unmount();

    const narrow = render(
      <InputBar mode="router" value="" terminalWidth={24} onChange={() => {}} />
    );
    const narrowFrame = narrow.lastFrame() ?? "";
    expect(narrowFrame).toContain("routes · Esc chat");
    expect(narrowFrame.split("\n")).toHaveLength(1);
    expect(displayWidth(narrowFrame)).toBeLessThanOrEqual(24);
    narrow.unmount();
  });

  it("keeps Router diagnostics actions semantic across every terminal width", () => {
    const overflow: string[] = [];
    const bareActions: string[] = [];
    const semanticLoss: string[] = [];
    const seenSemantics = new Set<string>();
    const semantics = [
      ["scroll", /(?:Pg scroll|scroll)/],
      ["scope", /Tab scope/],
      ["refresh", /\^G refresh/],
      ["chat", /Esc chat/]
    ] as const;
    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar mode="router" value="" terminalWidth={width} onChange={() => {}} />
      );
      const frame = view.lastFrame() ?? "";
      const guidance = frame.trimStart();
      if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
        overflow.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      if (/(?:^| · )(?:Pg|Esc|Tab|\^G)(?= ·|$)/.test(guidance)) {
        bareActions.push(`${width}:${frame}`);
      }
      for (const [name, pattern] of semantics) {
        if (pattern.test(guidance)) {
          seenSemantics.add(name);
        } else if (seenSemantics.has(name)) {
          semanticLoss.push(`${width}:${name}:${frame}`);
        }
      }
      view.unmount();
    }
    expect(overflow).toEqual([]);
    expect(bareActions).toEqual([]);
    expect(semanticLoss).toEqual([]);
  });

  it.each([
    [8, "routes"],
    [10, "Esc chat"],
    [19, "routes · Esc chat"],
    [31, "routes · Pg scroll · Esc chat"],
    [41, "routes · scroll · ^G refresh · Esc chat"],
    [53, "routes · scroll · Tab scope · ^G refresh · Esc chat"]
  ])("uses semantic Router diagnostics guidance at the %i-column boundary", (width, expected) => {
    const view = render(
      <InputBar mode="router" value="" terminalWidth={width} onChange={() => {}} />
    );

    expect(view.lastFrame()).toContain(expected);
    view.unmount();
  });

  it("shows Worker overview selection and action guidance", () => {
    const roomy = render(
      <InputBar mode="workers" value="ignored" terminalWidth={100} onChange={() => {}} />
    );
    const roomyFrame = roomy.lastFrame() ?? "";
    expect(roomyFrame).toContain(
      "workers · Up/Dn select · Enter logs · F features · C timeline · ^O attach · Esc back"
    );
    expect(roomyFrame).not.toContain("ignored");
    expect(roomyFrame.split("\n")).toHaveLength(1);
    expect(displayWidth(roomyFrame)).toBeLessThanOrEqual(100);
    roomy.unmount();

    const narrow = render(
      <InputBar mode="workers" value="" terminalWidth={28} onChange={() => {}} />
    );
    const narrowFrame = narrow.lastFrame() ?? "";
    expect(narrowFrame).toContain("workers · Up/Dn · Esc back");
    expect(narrowFrame.split("\n")).toHaveLength(1);
    expect(displayWidth(narrowFrame)).toBeLessThanOrEqual(28);
    narrow.unmount();
  });

  it("keeps Worker overview guidance legible across terminal widths", () => {
    const overflow: string[] = [];
    const bareActions: string[] = [];
    const semanticLoss: string[] = [];
    const seenSemantics = new Set<string>();
    const semantics = [
      ["back", /Esc back/],
      ["selection", /Up\/Dn/],
      ["logs", /Enter logs/],
      ["attach", /\^O attach/],
      ["features", /F (?:board|features)/],
      ["timeline", /C (?:flow|timeline)/]
    ] as const;
    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar mode="workers" value="" terminalWidth={width} onChange={() => {}} />
      );
      const frame = view.lastFrame() ?? "";
      if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
        overflow.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      if (/(?:^| · )(?:Enter|\^O|Esc)(?= ·|$)/.test(frame)) {
        bareActions.push(`${width}:${frame}`);
      }
      for (const [name, pattern] of semantics) {
        if (pattern.test(frame)) {
          seenSemantics.add(name);
        } else if (seenSemantics.has(name)) {
          semanticLoss.push(`${width}:${name}:${frame}`);
        }
      }
      view.unmount();
    }

    expect(overflow).toEqual([]);
    expect(bareActions).toEqual([]);
    expect(semanticLoss).toEqual([]);
  });

  it.each([
    [8, "wrk"],
    [15, "wrk"],
    [16, "wrk · Esc back"],
    [20, "workers · Esc back"],
    [28, "workers · Up/Dn · Esc back"],
    [41, "workers · Up/Dn · Enter logs · Esc back"],
    [53, "workers · Up/Dn · Enter logs · ^O attach · Esc back"],
    [72, "workers · Up/Dn · Enter logs · F board · C flow · ^O attach · Esc back"],
    [86, "workers · Up/Dn select · Enter logs · F features · C timeline · ^O attach · Esc back"],
    [100, "workers · Up/Dn select · Enter logs · F features · C timeline · ^O attach · Esc back"]
  ])("uses semantic Worker overview guidance at the %i-column boundary", (width, expected) => {
    const view = render(
      <InputBar mode="workers" value="" terminalWidth={width} onChange={() => {}} />
    );

    expect(view.lastFrame()).toContain(expected);
    view.unmount();
  });

  it("labels Worker overview attach and back actions at medium width", () => {
    const view = render(
      <InputBar mode="workers" value="" terminalWidth={80} onChange={() => {}} />
    );

    expect(view.lastFrame()).toContain(
      "workers · Up/Dn · Enter logs · F board · C flow · ^O attach · Esc back"
    );
    view.unmount();
  });

  it("shows Feature board selection and timeline guidance", () => {
    const featureMode = "features" as Parameters<typeof InputBar>[0]["mode"];
    const roomy = render(
      <InputBar mode={featureMode} value="ignored" terminalWidth={100} onChange={() => {}} />
    );
    expect(roomy.lastFrame()).toContain(
      "features · Up/Dn select · Enter timeline · R refresh · Esc workers"
    );
    expect(roomy.lastFrame()).not.toContain("ignored");
    roomy.unmount();

    const overflow: string[] = [];
    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar mode={featureMode} value="" terminalWidth={width} onChange={() => {}} />
      );
      const frame = view.lastFrame() ?? "";
      if (frame.split("\n").length > 1 || displayWidth(frame) > width) {
        overflow.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      view.unmount();
    }
    expect(overflow).toEqual([]);
  });

  it("shows deliberate Feature cancel confirmation and task retry controls without wrapping", () => {
    const featureMode = "features" as Parameters<typeof InputBar>[0]["mode"];
    const active = render(
      <InputBar
        mode={featureMode}
        featureCanCancel
        value=""
        terminalWidth={100}
        onChange={() => {}}
      />
    );
    expect(active.lastFrame()).toContain("X cancel");
    active.unmount();

    const confirm = render(
      <InputBar
        mode={featureMode}
        featureCancelConfirm
        value=""
        terminalWidth={100}
        onChange={() => {}}
      />
    );
    expect(confirm.lastFrame()).toContain("cancel feature? · X confirm · Esc keep");
    confirm.unmount();

    const retry = render(
      <InputBar
        mode={featureMode}
        canRetry
        value=""
        terminalWidth={100}
        onChange={() => {}}
      />
    );
    expect(retry.lastFrame()).toContain("^R retry task");
    retry.unmount();

    const overflow: string[] = [];
    for (const props of [
      { featureCanCancel: true },
      { featureCancelConfirm: true },
      { canRetry: true }
    ]) {
      for (let width = 8; width <= 100; width += 1) {
        const view = render(
          <InputBar mode={featureMode} value="" terminalWidth={width} onChange={() => {}} {...props} />
        );
        const frame = view.lastFrame() ?? "";
        if (frame.split("\n").length > 1 || displayWidth(frame) > width) {
          overflow.push(`${JSON.stringify(props)}:${width}:${displayWidth(frame)}:${frame}`);
        }
        view.unmount();
      }
    }
    expect(overflow).toEqual([]);
  });

  it("keeps every Feature board action explicit and monotonic across terminal widths", () => {
    const featureMode = "features" as Parameters<typeof InputBar>[0]["mode"];
    const states = [
      ["default", {}, [
        ["select", /Up\/Dn select/],
        ["timeline", /Enter timeline/],
        ["refresh", /R refresh/],
        ["back", /Esc workers/]
      ]],
      ["cancel", { featureCanCancel: true }, [
        ["select", /Up\/Dn select/],
        ["timeline", /Enter timeline/],
        ["cancel", /X cancel/],
        ["refresh", /R refresh/],
        ["back", /Esc workers/]
      ]],
      ["retry", { canRetry: true }, [
        ["select", /Up\/Dn select/],
        ["timeline", /Enter timeline/],
        ["retry", /\^R retry(?: task)?/],
        ["refresh", /R refresh/],
        ["back", /Esc workers/]
      ]],
      ["confirm", { featureCancelConfirm: true }, [
        ["confirm", /X confirm/],
        ["keep", /Esc keep/]
      ]]
    ] as const;
    const overflow: string[] = [];
    const bareActions: string[] = [];
    const semanticLoss: string[] = [];

    for (const [stateName, props, semantics] of states) {
      const seenSemantics = new Set<string>();
      for (let width = 8; width <= 100; width += 1) {
        const view = render(
          <InputBar mode={featureMode} value="" terminalWidth={width} onChange={() => {}} {...props} />
        );
        const frame = view.lastFrame() ?? "";
        const guidance = frame.trimStart();
        if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
          overflow.push(`${stateName}:${width}:${displayWidth(frame)}:${frame}`);
        }
        if (/(?:^| · )(?:Up\/Dn|X\/Esc|Esc|Enter|R|\^R)(?= ·|$)/.test(guidance)) {
          bareActions.push(`${stateName}:${width}:${frame}`);
        }
        for (const [name, pattern] of semantics) {
          if (pattern.test(guidance)) {
            seenSemantics.add(name);
          } else if (seenSemantics.has(name)) {
            semanticLoss.push(`${stateName}:${width}:${name}:${frame}`);
          }
        }
        view.unmount();
      }
    }

    expect(overflow).toEqual([]);
    expect(bareActions).toEqual([]);
    expect(semanticLoss).toEqual([]);
  });

  it.each([
    [8, {}, "ft"],
    [10, {}, "features"],
    [24, {}, "features · Esc workers"],
    [39, {}, "features · Up/Dn select · Esc workers"],
    [56, {}, "features · Up/Dn select · Enter timeline · Esc workers"],
    [68, {}, "features · Up/Dn select · Enter timeline · R refresh · Esc workers"],
    [35, { featureCanCancel: true }, "features · X cancel · Esc workers"],
    [50, { featureCanCancel: true }, "features · Up/Dn select · X cancel · Esc workers"],
    [62, { featureCanCancel: true }, "features · Up/Dn select · X cancel · R refresh · Esc workers"],
    [79, { featureCanCancel: true }, "features · Up/Dn select · Enter timeline · X cancel · R refresh · Esc workers"],
    [35, { canRetry: true }, "features · ^R retry · Esc workers"],
    [50, { canRetry: true }, "features · Up/Dn select · ^R retry · Esc workers"],
    [67, { canRetry: true }, "features · Up/Dn select · ^R retry task · R refresh · Esc workers"],
    [84, { canRetry: true }, "features · Up/Dn select · Enter timeline · ^R retry task · R refresh · Esc workers"],
    [8, { featureCancelConfirm: true }, "stop?"],
    [10, { featureCancelConfirm: true }, "Esc keep"],
    [20, { featureCancelConfirm: true }, "cancel? · Esc keep"],
    [32, { featureCancelConfirm: true }, "cancel? · X confirm · Esc keep"],
    [40, { featureCancelConfirm: true }, "cancel feature? · X confirm · Esc keep"]
  ])("uses semantic Feature board guidance at the %i-column boundary", (width, props, expected) => {
    const view = render(
      <InputBar mode="features" value="" terminalWidth={width} onChange={() => {}} {...props} />
    );

    expect(view.lastFrame()).toContain(expected);
    view.unmount();
  });

  it("shows separate pause and cancel actions for an active feature", () => {
    const active = render(
      <InputBar
        mode="features"
        value=""
        terminalWidth={80}
        featureCanPause
        featureCanCancel
        onChange={() => {}}
      />
    );
    expect(active.lastFrame()).toContain("P pause");
    expect(active.lastFrame()).toContain("X cancel");
    active.unmount();

    const confirm = render(
      <InputBar mode="features" value="" terminalWidth={40} featurePauseConfirm onChange={() => {}} />
    );
    expect(confirm.lastFrame()).toContain("pause feature? · P confirm · Esc keep");
    confirm.unmount();
  });

  it("shows Feature model reassignment controls without wrapping", () => {
    const retry = render(
      <InputBar
        mode="features"
        value=""
        terminalWidth={100}
        canRetry
        featureCanReassign
        onChange={() => {}}
      />
    );
    expect(retry.lastFrame()).toContain("M provider");
    expect(retry.lastFrame()).toContain("^R retry task");
    retry.unmount();

    const assignment = render(
      <InputBar
        mode="features"
        value=""
        terminalWidth={100}
        featureAssignment
        onChange={() => {}}
      />
    );
    expect(assignment.lastFrame()).toContain("assign · A/C provider · 1/2 model · M/Esc done");
    assignment.unmount();

    const model = render(
      <InputBar
        mode="features"
        value=""
        terminalWidth={100}
        featureAssignment
        featureEditingModel={{ role: "critic", value: "claude-opus", cursor: 6 }}
        onChange={() => {}}
      />
    );
    expect(model.lastFrame()).toContain("critic model > claude|-opus");
    model.unmount();

    const overflow: string[] = [];
    for (const props of [
      { canRetry: true, featureCanReassign: true },
      { featureAssignment: true }
    ]) {
      for (let width = 8; width <= 100; width += 1) {
        const view = render(
          <InputBar mode="features" value="" terminalWidth={width} onChange={() => {}} {...props} />
        );
        const frame = view.lastFrame() ?? "";
        if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
          overflow.push(`${JSON.stringify(props)}:${width}:${displayWidth(frame)}:${frame}`);
        }
        view.unmount();
      }
    }
    expect(overflow).toEqual([]);
  });

  it("shows collaboration timeline filtering and refresh guidance", () => {
    const collaborationMode = "collaboration" as Parameters<typeof InputBar>[0]["mode"];
    const roomy = render(
      <InputBar mode={collaborationMode} value="" terminalWidth={100} onChange={() => {}} />
    );
    expect(roomy.lastFrame()).toContain(
      "timeline · Up/Dn event · Enter detail · Tab feature · U unresolved · R refresh · Esc workers"
    );
    roomy.unmount();

    const unresolved = render(
      <InputBar
        mode={collaborationMode}
        collaborationUnresolved
        value=""
        terminalWidth={100}
        onChange={() => {}}
      />
    );
    expect(unresolved.lastFrame()).toContain("U all");
    unresolved.unmount();

    const fromFeatures = render(
      <InputBar
        mode={collaborationMode}
        collaborationBack="features"
        value=""
        terminalWidth={100}
        onChange={() => {}}
      />
    );
    expect(fromFeatures.lastFrame()).toContain("Esc features");
    expect(fromFeatures.lastFrame()).not.toContain("Esc workers");
    fromFeatures.unmount();

    const detail = render(
      <InputBar
        mode={collaborationMode}
        collaborationDetail
        value=""
        terminalWidth={100}
        onChange={() => {}}
      />
    );
    expect(detail.lastFrame()).toContain("event detail · scroll · Enter/Esc timeline");
    detail.unmount();

    const states = [
      ["timeline", {}, [
        ["back", /Esc workers/],
        ["select", /Up\/Dn event/],
        ["detail", /Enter detail/],
        ["feature", /Tab feature/],
        ["filter", /U (?:open|unresolved)/],
        ["refresh", /R refresh/]
      ]],
      ["timeline-unresolved", { collaborationUnresolved: true }, [
        ["back", /Esc workers/],
        ["select", /Up\/Dn event/],
        ["detail", /Enter detail/],
        ["feature", /Tab feature/],
        ["filter", /U all/],
        ["refresh", /R refresh/]
      ]],
      ["timeline-features", { collaborationBack: "features" as const }, [
        ["back", /Esc features/],
        ["select", /Up\/Dn event/],
        ["detail", /Enter detail/],
        ["feature", /Tab feature/],
        ["filter", /U (?:open|unresolved)/],
        ["refresh", /R refresh/]
      ]],
      ["detail", { collaborationDetail: true }, [
        ["back", /Esc timeline/],
        ["scroll", /(?:Pg scroll|scroll)/],
        ["close", /Enter\/Esc timeline/]
      ]]
    ] as const;
    const overflow: string[] = [];
    const bareActions: string[] = [];
    const semanticLoss: string[] = [];

    for (const [stateName, props, semantics] of states) {
      const seenSemantics = new Set<string>();
      for (let width = 8; width <= 100; width += 1) {
        const view = render(
          <InputBar mode={collaborationMode} value="" terminalWidth={width} onChange={() => {}} {...props} />
        );
        const frame = view.lastFrame() ?? "";
        const guidance = frame.trimStart();
        if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
          overflow.push(`${stateName}:${width}:${displayWidth(frame)}:${frame}`);
        }
        if (/(?:^| · )(?:Up\/Dn|Pg|Esc|Enter|Tab|U|R)(?= ·|$)/.test(guidance)) {
          bareActions.push(`${stateName}:${width}:${frame}`);
        }
        for (const [name, pattern] of semantics) {
          if (pattern.test(guidance)) {
            seenSemantics.add(name);
          } else if (seenSemantics.has(name)) {
            semanticLoss.push(`${stateName}:${width}:${name}:${frame}`);
          }
        }
        view.unmount();
      }
    }

    expect(overflow).toEqual([]);
    expect(bareActions).toEqual([]);
    expect(semanticLoss).toEqual([]);
  });

  it.each([
    [8, {}, "flow"],
    [13, {}, "Esc workers"],
    [24, {}, "timeline · Esc workers"],
    [39, {}, "timeline · Enter detail · Esc workers"],
    [53, {}, "timeline · Up/Dn event · Enter detail · Esc workers"],
    [67, {}, "timeline · Up/Dn event · Enter detail · Tab feature · Esc workers"],
    [76, {}, "timeline · Up/Dn event · Enter detail · Tab feature · U open · Esc workers"],
    [88, {}, "timeline · Up/Dn event · Enter detail · Tab feature · U open · R refresh · Esc workers"],
    [94, {}, "timeline · Up/Dn event · Enter detail · Tab feature · U unresolved · R refresh · Esc workers"],
    [100, { collaborationUnresolved: true }, "timeline · Up/Dn event · Enter detail · Tab feature · U all · R refresh · Esc workers"],
    [100, { collaborationBack: "features" as const }, "timeline · Up/Dn event · Enter detail · Tab feature · U unresolved · R refresh · Esc features"],
    [8, { collaborationDetail: true }, "event"],
    [14, { collaborationDetail: true }, "Esc timeline"],
    [22, { collaborationDetail: true }, "event · Esc timeline"],
    [34, { collaborationDetail: true }, "event · Pg scroll · Esc timeline"],
    [40, { collaborationDetail: true }, "event · Pg scroll · Enter/Esc timeline"],
    [44, { collaborationDetail: true }, "event detail · scroll · Enter/Esc timeline"]
  ])("uses semantic collaboration guidance at the %i-column boundary", (width, props, expected) => {
    const view = render(
      <InputBar mode="collaboration" value="" terminalWidth={width} onChange={() => {}} {...props} />
    );

    expect(view.lastFrame()).toContain(expected);
    view.unmount();
  });

  it("shows Task session restore and management guidance", () => {
    const roomy = render(
      <InputBar mode="sessions" value="ignored" terminalWidth={80} onChange={() => {}} />
    );
    const roomyFrame = roomy.lastFrame() ?? "";
    expect(roomyFrame).toContain("sessions · Up/Dn select · Enter restore · C chats · R rename · Esc back");
    expect(roomyFrame).not.toContain("ignored");
    expect(roomyFrame.split("\n")).toHaveLength(1);
    expect(displayWidth(roomyFrame)).toBeLessThanOrEqual(80);
    roomy.unmount();

    const narrow = render(
      <InputBar mode="sessions" value="" terminalWidth={24} onChange={() => {}} />
    );
    const narrowFrame = narrow.lastFrame() ?? "";
    expect(narrowFrame).toContain("sessions · Esc back");
    expect(narrowFrame.split("\n")).toHaveLength(1);
    expect(displayWidth(narrowFrame)).toBeLessThanOrEqual(24);
    narrow.unmount();
  });

  it("renders Unicode Task session search with a stable cursor", () => {
    const view = render(
      <InputBar
        mode="sessions"
        value=""
        terminalWidth={80}
        taskSessionAction={{ type: "search", value: "task:俄罗斯 role:actor", cursor: 7 }}
        onChange={() => {}}
      />
    );

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("find > task:俄罗|斯 role:actor");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(80);
    view.unmount();
  });

  it("shows Task session search and clear controls when space permits", () => {
    const view = render(
      <InputBar
        mode="sessions"
        value=""
        terminalWidth={180}
        taskSessionQuery="provider:claude"
        onChange={() => {}}
      />
    );

    expect(view.lastFrame()).toContain("Esc back · ^F edit · X clear");
    view.unmount();
  });

  it("keeps Task session actions semantic across every terminal width", () => {
    const overflow: string[] = [];
    const bareActions: string[] = [];
    const semanticLoss: string[] = [];
    const seenSemantics = new Set<string>();
    const semantics = [
      ["select", /Up\/Dn select/],
      ["restore", /Enter restore/],
      ["conversations", /C (?:conversations|chats)/],
      ["inspect", /I inspect/],
      ["rename", /R rename/],
      ["archive", /A archive/],
      ["delete", /D delete/],
      ["export", /E export/],
      ["back", /Esc back/]
    ] as const;

    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar mode="sessions" value="" terminalWidth={width} onChange={() => {}} />
      );
      const frame = view.lastFrame() ?? "";
      const guidance = frame.trimStart();
      if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
        overflow.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      if (/(?:^| · )(?:Up\/Dn|Esc|Enter|R|A|D|E|H)(?= ·|$)/.test(guidance)) {
        bareActions.push(`${width}:${frame}`);
      }
      for (const [name, pattern] of semantics) {
        if (pattern.test(guidance)) {
          seenSemantics.add(name);
        } else if (seenSemantics.has(name)) {
          semanticLoss.push(`${width}:${name}:${frame}`);
        }
      }
      view.unmount();
    }

    expect(overflow).toEqual([]);
    expect(bareActions).toEqual([]);
    expect(semanticLoss).toEqual([]);
  });

  it.each([
    [8, "ses"],
    [10, "Esc back"],
    [21, "sessions · Esc back"],
    [36, "sessions · Up/Dn select · Esc back"],
    [52, "sessions · Up/Dn select · Enter restore · Esc back"],
    [61, "sessions · Up/Dn select · Enter restore · Esc back"],
    [63, "sessions · Up/Dn select · Enter restore · C chats · Esc back"],
    [75, "sessions · Up/Dn select · Enter restore · C chats · R rename · Esc back"],
    [86, "sessions · Up/Dn select · Enter restore · C chats · I inspect · R rename · Esc back"],
    [97, "sessions · Up/Dn select · Enter restore · C chats · I inspect · R rename · A archive · Esc back"]
  ])("uses semantic Task session guidance at the %i-column boundary", (width, expected) => {
    const view = render(
      <InputBar mode="sessions" value="" terminalWidth={width} onChange={() => {}} />
    );

    expect(view.lastFrame()).toContain(expected);
    view.unmount();
  });

  it.each([
    [12, "Esc back"],
    [30, "conversations · Esc back"],
    [52, "conversations · Up/Dn select · Esc back"],
    [70, "conversations · Up/Dn select · Enter restore · T tasks · Esc back"],
    [90, "conversations · Up/Dn select · Enter restore · R rename · N new · T tasks · Esc back"]
  ])("uses semantic Main conversation guidance at the %i-column boundary", (width, expected) => {
    const view = render(
      <InputBar
        mode="sessions"
        value=""
        terminalWidth={width}
        mainConversationSessions
        onChange={() => {}}
      />
    );

    expect(view.lastFrame()).toContain(expected);
    expect(displayWidth(view.lastFrame() ?? "")).toBeLessThanOrEqual(width);
    view.unmount();
  });

  it("keeps Main conversation management actions semantic across terminal widths", () => {
    const overflow: string[] = [];
    const bareActions: string[] = [];
    const semanticLoss: string[] = [];
    const seenSemantics = new Set<string>();
    const semantics = [
      ["select", /Up\/Dn select/],
      ["restore", /Enter restore/],
      ["rename", /R rename/],
      ["archive", /A archive/],
      ["delete", /D delete/],
      ["export", /E export/],
      ["archived", /H (?:archived|hide archived)/],
      ["new", /N new/],
      ["tasks", /T tasks/],
      ["back", /Esc back/]
    ] as const;

    for (let width = 8; width <= 180; width += 1) {
      const hints = mainConversationSessionsInputHints(width, false);
      const guidance = `${hints.label}${hints.detail}`;
      const contentWidth = Math.max(1, width - 2);
      if (displayWidth(guidance) > contentWidth) {
        overflow.push(`${width}:${displayWidth(guidance)}:${guidance}`);
      }
      if (/(?:^| · )(?:Up\/Dn|Esc|Enter|R|A|D|E|H|N|T)(?= ·|$)/.test(guidance)) {
        bareActions.push(`${width}:${guidance}`);
      }
      for (const [name, pattern] of semantics) {
        if (pattern.test(guidance)) {
          seenSemantics.add(name);
        } else if (seenSemantics.has(name)) {
          semanticLoss.push(`${width}:${name}:${guidance}`);
        }
      }
    }

    expect(overflow).toEqual([]);
    expect(bareActions).toEqual([]);
    expect(semanticLoss).toEqual([]);
    expect(seenSemantics).toEqual(new Set(semantics.map(([name]) => name)));
    expect(mainConversationSessionsInputHints(180, true).detail).toContain("H hide archived");
  });

  it("shows native continuation and branch controls in Task session detail", () => {
    const detail = render(
      <InputBar
        mode="sessions"
        value=""
        terminalWidth={100}
        taskSessionDetail
        taskSessionDetailHasNative
        taskSessionDetailCanFork
        onChange={() => {}}
      />
    );
    expect(detail.lastFrame()).toContain(
      "session · Up/Dn worker · Enter logs · C continue · B branch · R refresh · Esc tasks"
    );
    detail.unmount();

    const withoutNative = render(
      <InputBar mode="sessions" value="" terminalWidth={80} taskSessionDetail onChange={() => {}} />
    );
    expect(withoutNative.lastFrame()).toContain("session · Up/Dn worker · Enter logs · R refresh · Esc tasks");
    expect(withoutNative.lastFrame()).not.toContain("continue");
    withoutNative.unmount();

    const overflow: string[] = [];
    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar
          mode="sessions"
          value=""
          terminalWidth={width}
          taskSessionDetail
          taskSessionDetailHasNative
          taskSessionDetailCanFork
          onChange={() => {}}
        />
      );
      const frame = view.lastFrame() ?? "";
      if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
        overflow.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      view.unmount();
    }
    expect(overflow).toEqual([]);
  });

  it("renders Unicode rename editing and destructive delete confirmation", () => {
    const rename = render(
      <InputBar
        mode="sessions"
        value=""
        taskSessionAction={{ type: "rename", value: "中文名称", cursor: 2 }}
        terminalWidth={40}
      />
    );
    expect(rename.lastFrame()).toContain("rename > 中文|名称");
    expect(displayWidth(rename.lastFrame() ?? "")).toBeLessThanOrEqual(40);
    rename.unmount();

    const deletion = render(
      <InputBar
        mode="sessions"
        value=""
        taskSessionAction={{ type: "delete", title: "旧任务" }}
        terminalWidth={50}
      />
    );
    expect(deletion.lastFrame()).toContain("delete · 旧任务 · D confirm · Esc cancel");
    expect(displayWidth(deletion.lastFrame() ?? "")).toBeLessThanOrEqual(50);
    deletion.unmount();
  });

  it("renders a Unicode Worker log search cursor and match position", () => {
    const roomy = render(
      <InputBar
        mode="worker-search"
        value="中文目标"
        cursor={2}
        searchMatchIndex={1}
        searchMatchCount={3}
        terminalWidth={80}
        onChange={() => {}}
      />
    );
    const roomyFrame = roomy.lastFrame() ?? "";
    expect(roomyFrame).toContain("/ 中文|目标 · 2/3 · Enter next · Up/Dn · Esc logs");
    expect(roomyFrame.split("\n")).toHaveLength(1);
    expect(displayWidth(roomyFrame)).toBeLessThanOrEqual(80);
    roomy.unmount();

    const overflow: string[] = [];
    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar
          mode="worker-search"
          value="很长的中文搜索目标和EnglishQuery"
          cursor={8}
          searchMatchIndex={0}
          searchMatchCount={0}
          terminalWidth={width}
          onChange={() => {}}
        />
      );
      const frame = view.lastFrame() ?? "";
      if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
        overflow.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      view.unmount();
    }
    expect(overflow).toEqual([]);
  });

  it("keeps worker guidance compact in narrow terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={44} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("logs · scroll · Tab · ^O attach · Esc chat");
    expect(frame).not.toContain("wheel/Pg");
    expect(frame).toContain("attach");
    expect(frame).not.toContain("read");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(44);
  });

  it("keeps actionable worker shortcuts visible in small terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={32} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("logs · scroll · Tab · Esc chat");
    expect(frame).not.toContain("^O");
    expect(frame).not.toContain("read");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(32);
  });

  it("keeps medium-width worker shortcuts self-describing", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={80} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain(
      "logs · scroll · ^F find · E err · D diff · Tab · ^O attach · Esc chat"
    );
    expect(frame).not.toContain("^B");
    expect(frame).not.toMatch(/(?:^| · )(?:\^(?:B|O)|Esc)(?= ·|$)/);
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(80);
  });

  it("keeps worker guidance legible on one row across terminal widths", () => {
    const overflow: string[] = [];
    const bareActions: string[] = [];
    const semanticLoss: string[] = [];
    const seenSemantics = new Set<string>();
    const semantics = [
      ["scroll", /(?:Pg|scroll)/],
      ["next", /Tab/],
      ["attach", /\^O attach/],
      ["find", /\^F find/],
      ["errors", /E err/],
      ["diffs", /D diff/],
      ["workers", /\^B workers/],
      ["chat", /Esc chat/]
    ] as const;
    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar mode="worker" value="" terminalWidth={width} onChange={() => {}} />
      );
      const frame = view.lastFrame() ?? "";
      const guidance = frame.trimStart();
      if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
        overflow.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      if (/(?:^| · )(?:\^(?:B|O)|Esc)(?= ·|$)/.test(guidance)) {
        bareActions.push(`${width}:${frame}`);
      }
      for (const [name, pattern] of semantics) {
        if (pattern.test(guidance)) {
          seenSemantics.add(name);
        } else if (seenSemantics.has(name)) {
          semanticLoss.push(`${width}:${name}:${frame}`);
        }
      }
      view.unmount();
    }

    expect(overflow).toEqual([]);
    expect(bareActions).toEqual([]);
    expect(semanticLoss).toEqual([]);
  });

  it.each([
    [8, "log"],
    [10, "Esc chat"],
    [16, "log · Esc chat"],
    [17, "logs · Esc chat"],
    [22, "logs · Pg · Esc chat"],
    [28, "logs · Pg · Tab · Esc chat"],
    [32, "logs · scroll · Tab · Esc chat"],
    [44, "logs · scroll · Tab · ^O attach · Esc chat"],
    [54, "logs · scroll · ^F find · Tab · ^O attach · Esc chat"],
    [71, "logs · scroll · ^F find · E err · D diff · Tab · ^O attach · Esc chat"],
    [84, "logs · scroll · ^F find · E err · D diff · Tab · ^B workers · ^O attach · Esc chat"],
    [100, "logs · scroll · ^F find · E err · D diff · Tab · ^B workers · ^O attach · Esc chat"]
  ])("uses semantic worker guidance at the %i-column boundary", (width, expected) => {
    const view = render(
      <InputBar mode="worker" value="" terminalWidth={width} onChange={() => {}} />
    );

    expect(view.lastFrame()).toContain(expected);
    view.unmount();
  });

  it("falls back to essential worker shortcuts in tiny terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={24} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("logs · Pg · Esc chat");
    expect(frame).not.toContain("Tab");
    expect(frame).not.toContain("^O");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(24);
  });

  it("uses an intentional worker hint label in ultra narrow terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={16} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("log · Esc chat");
    expect(frame).not.toContain("logs");
    expect(frame).not.toContain("read");
    expect(frame).not.toContain("Pg");
    expect(frame).not.toContain("^O");
    expect(frame.split("\n")).toHaveLength(1);
  });

  it("keeps the chat return shortcut explicit in sub-15-column worker terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={13} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Esc chat");
    expect(frame).not.toContain("read");
    expect(frame).not.toContain("Pg");
    expect(frame).not.toContain("^O");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(13);
  });

  it("prioritizes the explicit chat return in nano worker terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={10} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Esc chat");
    expect(frame).not.toContain("log");
    expect(frame).not.toContain("read");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(10);
  });

  it("keeps native guidance compact in narrow terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="native" value="" terminalWidth={42} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("native · scroll · ^] logs");
    expect(frame).not.toContain("wheel/Pg");
    expect(frame).toContain("logs");
    expect(frame).not.toContain("detach");
    expect(frame.split("\n")).toHaveLength(1);
  });

  it("shows native scroll and detach guidance in roomy terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="native" value="" terminalWidth={80} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("native · scroll · ^] logs");
    expect(frame).not.toContain("wheel/Pg");
    expect(frame).not.toContain("detach");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(80);
  });

  it("shows closed native attach guidance after the process exits", () => {
    const roomy = render(
      <InputBar mode="native" value="" nativeClosed terminalWidth={80} onChange={() => {}} />
    );
    expect(roomy.lastFrame()).toContain("closed · scroll · ^] logs");
    expect(roomy.lastFrame()).not.toContain("wheel/Pg");
    expect(roomy.lastFrame()).not.toContain("back");
    roomy.unmount();

    const tiny = render(
      <InputBar mode="native" value="" nativeClosed terminalWidth={20} onChange={() => {}} />
    );
    const tinyFrame = tiny.lastFrame() ?? "";
    expect(tinyFrame).toContain("closed · ^]");
    expect(tinyFrame).not.toContain("native");
    expect(displayWidth(tinyFrame)).toBeLessThanOrEqual(20);
    tiny.unmount();

    const nano = render(
      <InputBar mode="native" value="" nativeClosed terminalWidth={12} onChange={() => {}} />
    );
    const nanoFrame = nano.lastFrame() ?? "";
    expect(nanoFrame).toContain("closed ^]");
    expect(nanoFrame).not.toContain("close · ^]");
    expect(nanoFrame.split("\n")).toHaveLength(1);
    expect(displayWidth(nanoFrame)).toBeLessThanOrEqual(12);
    nano.unmount();

    const narrow = render(
      <InputBar mode="native" value="" nativeClosed terminalWidth={42} onChange={() => {}} />
    );
    const narrowFrame = narrow.lastFrame() ?? "";
    expect(narrowFrame).toContain("closed · scroll · ^] logs");
    expect(narrowFrame).not.toContain("wheel/Pg");
    expect(narrowFrame).not.toContain("back");
    expect(displayWidth(narrowFrame)).toBeLessThanOrEqual(42);
    narrow.unmount();
  });

  it("keeps only the native detach chord in tiny terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="native" value="" terminalWidth={20} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("native · ^]");
    expect(frame).not.toContain("detach");
    expect(frame).not.toContain("logs");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(20);
  });

  it("keeps native attach guidance legible in nano terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="native" value="" terminalWidth={10} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("nat ^]");
    expect(frame).not.toContain("native");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(10);
  });

  it("keeps native scroll guidance visible before detach text fits", () => {
    const { lastFrame } = render(
      <InputBar mode="native" value="" terminalWidth={30} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("native · scroll · ^] logs");
    expect(frame).not.toContain("detach");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(30);
  });

  it("renders a compact status-details return rail", () => {
    const roomy = render(
      <InputBar mode="status" value="" terminalWidth={80} onChange={() => {}} />
    );
    const narrow = render(
      <InputBar mode="status" value="" terminalWidth={12} onChange={() => {}} />
    );

    expect(roomy.lastFrame()).toContain("status · ^E roles · ^X diagnostics · ^S/Esc back · ^C exit");
    expect(narrow.lastFrame()).toContain("status");
    expect(displayWidth(narrow.lastFrame() ?? "")).toBeLessThanOrEqual(12);
    roomy.unmount();
    narrow.unmount();
  });

  it("renders role controls and Unicode model editing on one stable row", () => {
    const controls = render(
      <InputBar
        mode="roles"
        value=""
        terminalWidth={100}
        roleScope="task"
        roleCanApply
        roleHasOverride
        onChange={() => {}}
      />
    );
    const editing = render(
      <InputBar
        mode="roles"
        value=""
        terminalWidth={36}
        roleEditingModel={{ role: "critic", value: "模型-sonnet", cursor: 2 }}
        onChange={() => {}}
      />
    );

    expect(controls.lastFrame()).toContain("roles · task");
    expect(controls.lastFrame()).toContain("M model");
    expect(controls.lastFrame()).toContain("Enter apply");
    expect(controls.lastFrame()).toContain("X reset");
    expect(editing.lastFrame()).toContain("critic model > 模型|-");
    expect((editing.lastFrame() ?? "").split("\n")).toHaveLength(1);
    expect(displayWidth(editing.lastFrame() ?? "")).toBeLessThanOrEqual(36);
    controls.unmount();
    editing.unmount();
  });

  it("keeps role configuration guidance inside every supported terminal width", () => {
    const invalid: string[] = [];
    for (let width = 8; width <= 100; width += 1) {
      const view = render(
        <InputBar mode="roles" value="" terminalWidth={width} roleScope="next" onChange={() => {}} />
      );
      const frame = view.lastFrame() ?? "";
      if (frame.split("\n").length !== 1 || displayWidth(frame) > width) {
        invalid.push(`${width}:${displayWidth(frame)}:${frame}`);
      }
      view.unmount();
    }
    expect(invalid).toEqual([]);
  });
});
