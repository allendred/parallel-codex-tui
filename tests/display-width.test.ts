import { describe, expect, it } from "vitest";
import {
  compactEndByDisplayWidth,
  compactTailByDisplayWidth,
  displayWidth,
  wrapByDisplayWidth
} from "../src/tui/display-width.js";

describe("display width helpers", () => {
  it("counts CJK characters as double-width terminal cells", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文abc")).toBe(7);
  });

  it("truncates the start side by terminal display width", () => {
    const value = compactEndByDisplayWidth("并行编码终端超级长项目名称测试", 14);

    expect(value).toBe("并行编码终...");
    expect(displayWidth(value)).toBeLessThanOrEqual(14);
  });

  it("keeps the tail of long chat input by terminal display width", () => {
    const value = compactTailByDisplayWidth("请帮我继续优化这个并行编码终端界面不要换行乱掉", 16);

    expect(value).toBe("...不要换行乱掉");
    expect(displayWidth(value)).toBeLessThanOrEqual(16);
  });

  it("wraps mixed Chinese and ASCII text by terminal display width", () => {
    const lines = wrapByDisplayWidth("继续优化 parallel-codex-tui 的 worker 日志渲染不要乱", 18);

    expect(lines.length).toBeGreaterThan(1);
    expect(Math.max(...lines.map((line) => displayWidth(line)))).toBeLessThanOrEqual(18);
    expect(lines.join("")).toContain("继续优化");
  });

  it("prefers a nearby space over splitting an English word in narrow terminals", () => {
    expect(wrapByDisplayWidth("have no contradicting evidence", 20)).toEqual([
      "have no",
      "contradicting",
      "evidence"
    ]);
  });
});
