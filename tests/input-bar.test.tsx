import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { chatBusyDisplayValue, chatInputDisplayValue, chatPlaceholderDisplayValue, InputBar, inputRailLayout } from "../src/tui/InputBar.js";
import { displayWidth } from "../src/tui/display-width.js";

describe("InputBar", () => {
  it("shows chat input busy state without mounting raw input", () => {
    const { lastFrame } = render(<InputBar mode="chat" busy value="hello" onChange={() => {}} />);

    expect(lastFrame()).toContain("working");
    expect(lastFrame()).toContain("Esc stop");
    expect(lastFrame()).toContain("run");
    expect(lastFrame()).not.toContain("Running...");
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
    expect(chatPlaceholderDisplayValue(24)).toBe("message");

    const { lastFrame } = render(
      <InputBar mode="chat" value="" terminalWidth={12} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> | msg");
    expect(frame).not.toContain("...");
    expect(displayWidth(frame)).toBeLessThanOrEqual(12);
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

  it("shows task shortcuts in the empty chat prompt once workers exist", () => {
    expect(chatPlaceholderDisplayValue(80, { hasWorkers: true })).toBe("message · ^W logs · Tab · ^O attach");
    expect(chatPlaceholderDisplayValue(42, { hasWorkers: true })).toBe("message · ^W logs · Tab · ^O attach");
    expect(chatPlaceholderDisplayValue(41, { hasWorkers: true })).toBe("message · ^W logs · Tab · ^O attach");
    expect(chatPlaceholderDisplayValue(40, { hasWorkers: true })).toBe("message · ^W · ^O");
    expect(chatPlaceholderDisplayValue(30, { hasWorkers: true })).toBe("message · ^W · ^O");
    expect(chatPlaceholderDisplayValue(20, { hasWorkers: true })).toBe("msg · ^W · ^O");
    expect(chatPlaceholderDisplayValue(19, { hasWorkers: true })).toBe("msg · ^W · ^O");
    expect(chatPlaceholderDisplayValue(18, { hasWorkers: true })).toBe("msg · ^W");
    expect(chatPlaceholderDisplayValue(16, { hasWorkers: true })).toBe("msg · ^W");

    const { lastFrame } = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={80} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Type a message");
    expect(frame).toContain("message");
    expect(frame).toContain("^W logs");
    expect(frame).toContain("Tab");
    expect(frame).toContain("^O attach");
  });

  it("uses an intentional compact task hint instead of a clipped word at 40 columns", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" value="" hasWorkers hasActiveTask terminalWidth={40} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> | message · ^W · ^O");
    expect(frame).not.toContain("...age");
    expect(displayWidth(frame)).toBeLessThanOrEqual(40);
  });

  it("shows the new-task shortcut only while a complex task is active", () => {
    const roomy = render(
      <InputBar mode="chat" value="" hasWorkers hasActiveTask terminalWidth={80} onChange={() => {}} />
    );
    try {
      expect(roomy.lastFrame()).toContain("message · ^N new · ^W logs · Tab · ^O attach");
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
    expect(noTask.lastFrame()).not.toContain("^N");

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
      "message · scroll · ^W logs · Tab · ^O attach"
    );
    expect(chatPlaceholderDisplayValue(80, scrolled)).toBe(
      "message · back 3/20 · PgDn latest"
    );
    expect(chatPlaceholderDisplayValue(30, scrolled)).toBe("back 3/20 · PgDn");
    expect(chatPlaceholderDisplayValue(16, scrolled)).toBe("back 3");
    expect(chatPlaceholderDisplayValue(30, { maxScrollOffset: 20 } as Parameters<typeof chatPlaceholderDisplayValue>[1])).toBe(
      "message · scroll"
    );
  });

  it("keeps ultra-narrow task chat prompt off the terminal edge", () => {
    const eighteen = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={18} onChange={() => {}} />
    );

    try {
      const frame = eighteen.lastFrame() ?? "";
      expect(frame).toContain("> | msg · ^W");
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
      expect(frame).toContain("> | msg · ^W · ^O");
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
    expect(frame).toContain("> | message · ^W · ^O");
    expect(frame).not.toContain("logs");
    expect(frame).not.toContain("attach");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(30);
  });

  it("keeps worker chat shortcuts discoverable in tiny terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="chat" value="" hasWorkers terminalWidth={20} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> | msg · ^W · ^O");
    expect(frame).not.toContain("message");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(20);
  });

  it("uses intentional busy text in ultra narrow terminals", () => {
    expect(chatBusyDisplayValue(10)).toBe("");
    expect(chatBusyDisplayValue(16)).toBe("busy");
    expect(chatBusyDisplayValue(24)).toBe("working");
    expect(chatBusyDisplayValue(40)).toBe("working · Esc stop");

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
    expect(frame).not.toContain("Tab worker");
    expect(frame).not.toContain("wheel/Pg");
    expect(frame).not.toContain("read");
    expect(frame).not.toContain("Type a message");
    expect(frame).not.toContain("做个俄罗斯方块");
  });

  it("keeps worker guidance compact in narrow terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={42} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("logs · scroll · Tab · ^O · Esc");
    expect(frame).not.toContain("wheel/Pg");
    expect(frame).not.toContain("attach");
    expect(frame).not.toContain("read");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(42);
  });

  it("keeps actionable worker shortcuts visible in small terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={32} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("logs · Pg · Tab · ^O · Esc");
    expect(frame).not.toContain("read");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(32);
  });

  it("falls back to essential worker shortcuts in tiny terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={24} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("logs · Pg · Esc");
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
    expect(frame).toContain("log · Pg · Esc");
    expect(frame).not.toContain("logs");
    expect(frame).not.toContain("read");
    expect(frame).not.toContain("^O");
    expect(frame.split("\n")).toHaveLength(1);
  });

  it("keeps the chat return shortcut visible in sub-15-column worker terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={13} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("log · Esc");
    expect(frame).not.toContain("read");
    expect(frame).not.toContain("Pg");
    expect(frame).not.toContain("^O");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(13);
  });

  it("keeps worker hints to one short token in nano terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="worker" value="" terminalWidth={10} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("log");
    expect(frame).not.toContain("read");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(10);
  });

  it("keeps native guidance compact in narrow terminals", () => {
    const { lastFrame } = render(
      <InputBar mode="native" value="" terminalWidth={42} onChange={() => {}} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("native · scroll · ^]");
    expect(frame).not.toContain("wheel/Pg");
    expect(frame).not.toContain("logs");
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
    expect(narrowFrame).toContain("closed · scroll · ^]");
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
    expect(frame).toContain("native · Pg · ^]");
    expect(frame).not.toContain("detach");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(30);
  });
});
