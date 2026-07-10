import React, { useEffect, useState } from "react";
import { basename, dirname, join } from "node:path";
import { readdir } from "node:fs/promises";
import { Box, Text, type TextProps } from "ink";
import { pathExists, readTextIfExists } from "../core/file-store.js";
import type { WorkerRole } from "../domain/schemas.js";
import { compactEndByDisplayWidth, displayWidth, wrapByDisplayWidth } from "./display-width.js";
import { selectViewportLines } from "./scrolling.js";
import { TUI_THEME } from "./theme.js";

interface WorkerOutputSection {
  group: "role" | "feature" | "process";
  title: string;
  text: string;
}

interface ProcessOutputSanitizeOptions {
  hideAssistantNarration?: boolean;
  renderedArtifactFiles?: Set<string>;
}

export type WorkerOutputLineKind =
  | "group"
  | "section"
  | "content"
  | "placeholder"
  | "blank"
  | "heading"
  | "list"
  | "list-detail"
  | "ordered-list"
  | "task"
  | "quote"
  | "table"
  | "rule"
  | "code"
  | "source-line"
  | "summary"
  | "json"
  | "json-message"
  | "command"
  | "success"
  | "error"
  | "diff-file"
  | "diff-summary"
  | "diff-hunk"
  | "diff-context"
  | "diff-meta"
  | "diff-add"
  | "diff-remove";

type WorkerOutputLineTheme = Pick<TextProps, "backgroundColor" | "bold" | "color" | "dimColor">;

interface RenderLine {
  kind: WorkerOutputLineKind;
  text: string;
}

interface DisplayLine extends RenderLine {
  continuation?: boolean;
  preformatted?: boolean;
}

interface WorkerOutputContentState {
  key: string;
  lines: RenderLine[];
}

const EMPTY_WORKER_OUTPUT_TEXT = "waiting for output";
const LOADING_WORKER_OUTPUT_TEXT = "loading output";
const NO_WORKER_OUTPUT_TEXT = "No workers yet · start a complex task";

interface ParsedDiffFile {
  title: string;
  added: number;
  removed: number;
  lines: RenderLine[];
}

export interface WorkerOutputDiffColumns {
  lineNumber: string;
  sign: "+" | "-" | " ";
  code: string;
}

export interface WorkerOutputSourceColumns {
  lineNumber: string;
  code: string;
}

export interface WorkerOutputViewProps {
  title: string;
  role?: WorkerRole;
  logPath: string | null;
  scrollOffset?: number;
  height?: number;
  terminalWidth?: number;
  onViewportChange?: (viewport: { offset: number; maxOffset: number }) => void;
}

export function WorkerOutputView({
  title,
  role,
  logPath,
  scrollOffset = 0,
  height = 24,
  terminalWidth = Number(process.stdout.columns) || 120,
  onViewportChange
}: WorkerOutputViewProps) {
  const nanoOutput = isNanoWorkerOutputWidth(terminalWidth);
  const contentKey = workerOutputContentKey(role, logPath, nanoOutput);
  const [contentState, setContentState] = useState<WorkerOutputContentState>({ key: "", lines: [] });

  useEffect(() => {
    let active = true;
    const loadKey = contentKey;

    async function load() {
      if (!logPath) {
        setContentState({
          key: loadKey,
          lines: [{ kind: "placeholder", text: NO_WORKER_OUTPUT_TEXT }]
        });
        return;
      }
      if (nanoOutput) {
        const lines = await loadNanoWorkerOutputLines(logPath, height);
        if (active) {
          setContentState({
            key: loadKey,
            lines
          });
        }
        return;
      }
      const sections = await loadWorkerOutputSections(role, logPath);
      if (active) {
        setContentState({
          key: loadKey,
          lines: renderLinesFromSections(sections, { nanoProcess: nanoOutput, height })
        });
      }
    }

    void load();
    const interval = setInterval(() => {
      void load();
    }, 1000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [contentKey, height, logPath, nanoOutput, role]);

  const content = contentState.key === contentKey
    ? contentState.lines
    : [{ kind: "placeholder" as const, text: LOADING_WORKER_OUTPUT_TEXT }];
  const sourceLines = isNanoWorkerOutputWidth(terminalWidth) ? tinyWorkerOutputSourceLines(content, height) : content;
  const panelWidth = workerOutputPanelRailWidth(terminalWidth);
  const nanoRender = isNanoWorkerOutputWidth(terminalWidth);
  const displayLines = renderDisplayLines(sourceLines, terminalWidth, {
    contentWidth: nanoRender ? undefined : Math.max(1, panelWidth - 2),
    nano: nanoRender
  });
  const selection = selectViewportLines(displayLines.map((line) => line.text).join("\n"), height, scrollOffset);
  const end = displayLines.length - selection.clampedOffset;
  const rawStart = Math.max(0, end - Math.max(1, height));
  const start = workerOutputVisibleStart(displayLines, rawStart, end, {
    preferGroup: selection.clampedOffset === 0 && selection.maxOffset > 0 ? "process" : null,
    preferLatestSection: selection.clampedOffset === 0 && selection.maxOffset > 0
  });
  const visibleLines = displayLines.slice(start, end);
  const topPaddingLines = start > rawStart
    ? 0
    : workerOutputTailTopPaddingLines(
      selection.clampedOffset,
      selection.maxOffset,
      visibleLines.length,
      height
    );

  useEffect(() => {
    onViewportChange?.({
      offset: selection.clampedOffset,
      maxOffset: selection.maxOffset
    });
  }, [onViewportChange, selection.clampedOffset, selection.maxOffset]);

  const scrollLabel = workerOutputScrollDisplay(selection.clampedOffset, selection.maxOffset, terminalWidth);
  const displayTitle = workerOutputHeaderDisplay(
    title,
    selection.maxOffset > 0 ? scrollLabel : null,
    Math.max(1, panelWidth - 2)
  );

  return (
    <Box flexDirection="column">
      <WorkerOutputTitleRail title={displayTitle} width={panelWidth} />
      {Array.from({ length: topPaddingLines }, (_, index) => <WorkerOutputBlankLine key={`tail-pad-${index}`} width={panelWidth} />)}
      {visibleLines.length > 0
        ? visibleLines.map((line, index) =>
          nanoRender
            ? <WorkerOutputNanoLine key={index} fillWidth={panelWidth} line={line} width={terminalWidth} />
            : <WorkerOutputLine key={index} line={line} width={panelWidth} />
        )
        : <Text {...workerOutputEmptyFallbackTheme()}>{EMPTY_WORKER_OUTPUT_TEXT}</Text>}
    </Box>
  );
}

function WorkerOutputTitleRail({ title, width }: { title: string; width: number }) {
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

function workerOutputPanelRailWidth(terminalWidth: number): number {
  const renderWidth = typeof process.stdout.columns === "number"
    ? Math.max(1, Math.min(terminalWidth, process.stdout.columns))
    : terminalWidth;
  return Math.max(1, renderWidth - 4);
}

function tinyWorkerOutputSourceLines(lines: RenderLine[], height: number): RenderLine[] {
  const maxSourceLines = Math.max(8, height * 2);
  if (lines.length <= maxSourceLines) {
    return lines;
  }

  const processStart = lastIndexWhere(lines, (line) => line.kind === "group" && line.text === "process");
  const start = processStart >= 0 ? processStart : Math.max(0, lines.length - maxSourceLines);
  const tail = lines.slice(start).filter((line) => line.kind !== "blank" && line.kind !== "code" && line.kind !== "source-line");
  if (tail.length <= maxSourceLines) {
    return tail.length > 0 ? tail : lines.slice(-maxSourceLines);
  }

  const first = tail[0];
  const keepFirst = first && (first.kind === "group" || first.kind === "section" || first.kind === "heading");
  const remainingBudget = keepFirst ? maxSourceLines - 1 : maxSourceLines;
  return [
    ...(keepFirst ? [first] : []),
    ...tail.slice(-Math.max(1, remainingBudget))
  ];
}

function isNanoWorkerOutputWidth(width: number): boolean {
  return width <= 12;
}

function lastIndexWhere<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] as T)) {
      return index;
    }
  }
  return -1;
}

function workerOutputContentKey(role: WorkerRole | undefined, logPath: string | null, nanoOutput = false): string {
  return `${role ?? ""}:${logPath ?? ""}:${nanoOutput ? "nano" : "full"}`;
}

export function workerOutputTitleDisplay(title: string, width: number): string {
  const match = title.match(/^(.+?)\s+\(([^)]+)\)\s+output(?:\s+\((\d+\/\d+)\))?$/i);
  if (!match) {
    return compactEndByDisplayWidth(title.replace(/\s+output\b/i, "").trim(), width);
  }

  const role = (match[1] ?? "").trim().toLowerCase();
  const provider = (match[2] ?? "").trim().toLowerCase();
  const page = match[3] ?? "";
  const compact = joinWorkerOutputChromeParts([`${role}/${provider}`, page]);
  if (displayWidth(compact) <= width) {
    return compact;
  }

  const roleOnly = joinWorkerOutputChromeParts([role, page]);
  if (displayWidth(roleOnly) <= width) {
    return roleOnly;
  }

  if (page) {
    const tinyTitle = tinyWorkerOutputPageTitle(role, page, width);
    if (tinyTitle && displayWidth(roleOnly) > width) {
      return tinyTitle;
    }
    const roleBudget = Math.max(1, width - displayWidth(page) - 1);
    if (roleBudget < displayWidth(role)) {
      if (tinyTitle) {
        return tinyTitle;
      }
    }
    return [compactEndByDisplayWidth(role, roleBudget), page].filter(Boolean).join(" ");
  }

  return compactEndByDisplayWidth(`${role}/${provider}`, width);
}

export function workerOutputHeaderDisplay(title: string, scrollLabel: string | null, width: number): string {
  const label = scrollLabel?.trim() ?? "";
  if (!label) {
    return workerOutputTitleDisplay(title, width);
  }

  const titleOnly = workerOutputTitleDisplay(title, width);
  const separator = " · ";
  const titleBudget = Math.max(1, width - displayWidth(separator) - displayWidth(label));
  const display = `${workerOutputTitleDisplay(title, titleBudget)}${separator}${label}`;
  if (displayWidth(display) <= width) {
    if (shouldPreferWorkerTitleOnlyOverTail(titleOnly, display, label, width)) {
      return titleOnly;
    }
    if (label === "tail" && displayWidth(titleOnly) <= width && /\b\d+\/\d+\b/.test(titleOnly) && !/\b\d+\/\d+\b/.test(display)) {
      return titleOnly;
    }
    return display;
  }

  const tightSeparator = " ";
  const tightTitleBudget = Math.max(1, width - displayWidth(tightSeparator) - displayWidth(label));
  const tightDisplay = `${workerOutputTitleDisplay(title, tightTitleBudget)}${tightSeparator}${label}`;
  if (displayWidth(tightDisplay) <= width) {
    if (shouldPreferWorkerTitleOnlyOverTail(titleOnly, tightDisplay, label, width)) {
      return titleOnly;
    }
    if (displayWidth(titleOnly) <= width && /\b\d+\/\d+\b/.test(titleOnly) && !/\b\d+\/\d+\b/.test(tightDisplay)) {
      return titleOnly;
    }
    return tightDisplay;
  }

  return displayWidth(titleOnly) <= width ? titleOnly : compactEndByDisplayWidth(tightDisplay, width);
}

function shouldPreferWorkerTitleOnlyOverTail(titleOnly: string, display: string, label: string, width: number): boolean {
  if (label !== "tail" || displayWidth(titleOnly) > width) {
    return false;
  }
  const page = titleOnly.match(/\b\d+\/\d+\b/)?.[0];
  return Boolean(page && !display.includes(`· ${page}`));
}

export function workerOutputScrollDisplay(offset: number, maxOffset: number, width: number): string {
  if (maxOffset <= 0 || offset <= 0) {
    return "tail";
  }
  if (offset >= maxOffset) {
    return "top";
  }
  if (width < 32) {
    return `${offset}/${maxOffset}`;
  }
  return `back ${offset}/${maxOffset}`;
}

const WORKER_TAIL_GROUP_ALIGNMENT_MAX_LOST_ROWS = 3;
const WORKER_TAIL_SECTION_ALIGNMENT_MAX_LOST_ROWS = 8;
const WORKER_TAIL_NEXT_SECTION_ALIGNMENT_MAX_LOST_ROWS = 12;
const WORKER_TAIL_ORPHAN_CONTINUATION_MAX_LOST_ROWS = 3;

export function workerOutputTailTopPaddingLines(
  scrollOffset: number,
  maxOffset: number,
  visibleLineCount: number,
  bodyHeight: number
): number {
  if (scrollOffset !== 0 || maxOffset <= 0 || bodyHeight < 8) {
    return 0;
  }
  if (visibleLineCount > Math.floor(Math.max(1, bodyHeight) / 2)) {
    return 0;
  }
  return Math.max(0, Math.max(1, bodyHeight) - visibleLineCount);
}

function joinWorkerOutputChromeParts(parts: string[]): string {
  return parts.filter(Boolean).join(" · ");
}

function tinyWorkerOutputPageTitle(role: string, page: string, width: number): string | null {
  const roleInitial = role.trim().slice(0, 1);
  const candidates = [
    roleInitial ? `${roleInitial} ${page}` : "",
    page,
    roleInitial
  ].filter(Boolean);

  return candidates.find((candidate) => displayWidth(candidate) <= width) ?? null;
}

export function workerOutputVisibleStart(
  lines: Array<{ kind: WorkerOutputLineKind; text?: string }>,
  start: number,
  end: number,
  options: { preferGroup?: string | null; preferLatestSection?: boolean } = {}
): number {
  let visibleStart = start;
  while (visibleStart < end - 1 && lines[visibleStart]?.kind === "blank") {
    visibleStart += 1;
  }
  visibleStart = skipOrphanedTailContinuations(lines, visibleStart, end);
  if (options.preferLatestSection) {
    const latestSectionStart = latestSectionBoundaryWithinTail(lines, visibleStart, end);
    if (latestSectionStart !== null) {
      return latestSectionStart;
    }
  }
  if (isMeaningfulTailStartLine(lines[visibleStart])) {
    return visibleStart;
  }
  if (options.preferGroup) {
    for (let index = end - 1; index > visibleStart; index -= 1) {
      const line = lines[index];
      if (line?.kind === "group" && line.text === options.preferGroup) {
        const preferredStart = preferredBoundaryBeforeGroup(lines, visibleStart, index) ?? { index, kind: "group" as const };
        const maxLostRows = preferredStart.kind === "section" || preferredStart.kind === "group"
          ? WORKER_TAIL_SECTION_ALIGNMENT_MAX_LOST_ROWS
          : WORKER_TAIL_GROUP_ALIGNMENT_MAX_LOST_ROWS;
        const chosenStart = preferredStart.index - visibleStart > maxLostRows
          ? visibleStart
          : preferredStart.index;
        if (isSparseTailStart(chosenStart, start, end)) {
          return compactContextBeforeGroup(lines, visibleStart, index) ?? chosenStart;
        }
        return chosenStart;
      }
    }
  }
  return nextSectionBoundaryWithinTail(lines, visibleStart, end) ?? visibleStart;
}

function isSparseTailStart(chosenStart: number, start: number, end: number): boolean {
  const viewportHeight = Math.max(1, end - start);
  return end - chosenStart < Math.max(5, Math.ceil(viewportHeight * 0.65));
}

function compactContextBeforeGroup(
  lines: Array<{ kind: WorkerOutputLineKind; text?: string; continuation?: boolean }>,
  visibleStart: number,
  groupIndex: number
): number | null {
  const minIndex = Math.max(visibleStart, groupIndex - 10, latestStructuralBoundaryBefore(lines, visibleStart, groupIndex));
  for (let index = minIndex; index < groupIndex; index += 1) {
    const line = lines[index];
    if (!line || line.kind === "blank" || line.continuation) {
      continue;
    }
    if (line.kind === "content" && isCompactTailContextLine(line.text?.trim() ?? "")) {
      return index;
    }
  }
  return null;
}

function isCompactTailContextLine(text: string): boolean {
  return /^(?:Verification|Verify|Findings|Blocking|Critic review):\s*/i.test(text) || /^tests\s+\d+\/\d+\b/i.test(text);
}

function latestStructuralBoundaryBefore(
  lines: Array<{ kind: WorkerOutputLineKind }>,
  visibleStart: number,
  groupIndex: number
): number {
  let boundary = visibleStart;
  for (let index = visibleStart; index < groupIndex; index += 1) {
    const kind = lines[index]?.kind;
    if (kind === "section" || kind === "group") {
      boundary = index;
    }
  }
  return boundary;
}

function isMeaningfulTailStartLine(line: { kind: WorkerOutputLineKind; text?: string } | undefined): boolean {
  if (!line) {
    return false;
  }
  if (line.kind === "group" || line.kind === "section" || line.kind === "heading") {
    return true;
  }
  if (line.kind === "list") {
    return true;
  }
  if (line.kind === "summary" || line.kind === "success" || line.kind === "command" || line.kind === "error") {
    return true;
  }
  return /^APPROVED\b/i.test(line.text?.trim() ?? "");
}

function skipOrphanedTailContinuations(
  lines: Array<{ kind: WorkerOutputLineKind; text?: string; continuation?: boolean }>,
  start: number,
  end: number
): number {
  let index = start;
  while (
    index < end - 1 &&
    index - start < WORKER_TAIL_ORPHAN_CONTINUATION_MAX_LOST_ROWS &&
    isOrphanedTailContinuationLine(lines[index])
  ) {
    index += 1;
  }
  return index;
}

function isOrphanedTailContinuationLine(
  line: { kind: WorkerOutputLineKind; continuation?: boolean } | undefined
): boolean {
  return Boolean(line?.continuation) || line?.kind === "list-detail";
}

function preferredBoundaryBeforeGroup(
  lines: Array<{ kind: WorkerOutputLineKind; text?: string }>,
  start: number,
  groupIndex: number
): { index: number; kind: WorkerOutputLineKind } | null {
  for (let index = start; index < groupIndex; index += 1) {
    const line = lines[index];
    if (!line || line.kind === "blank") {
      continue;
    }
    if (line.kind === "group" || line.kind === "section" || line.kind === "heading") {
      return { index, kind: line.kind };
    }
  }
  return null;
}

function nextSectionBoundaryWithinTail(
  lines: Array<{ kind: WorkerOutputLineKind; text?: string }>,
  start: number,
  end: number
): number | null {
  const maxIndex = Math.min(end, start + WORKER_TAIL_NEXT_SECTION_ALIGNMENT_MAX_LOST_ROWS + 1);
  for (let index = start + 1; index < maxIndex; index += 1) {
    const line = lines[index];
    if (line?.kind === "section" || line?.kind === "group") {
      return index;
    }
  }
  return null;
}

function latestSectionBoundaryWithinTail(
  lines: Array<{ kind: WorkerOutputLineKind; text?: string }>,
  start: number,
  end: number
): number | null {
  let latestSectionStart: number | null = null;
  for (let index = start + 1; index < end; index += 1) {
    if (lines[index]?.kind === "section") {
      latestSectionStart = index;
    }
  }
  return latestSectionStart !== null && end - latestSectionStart >= 3 ? latestSectionStart : null;
}

async function loadWorkerOutputSections(role: WorkerRole | undefined, logPath: string): Promise<WorkerOutputSection[]> {
  const workerDir = dirname(logPath);
  const sections: WorkerOutputSection[] = [];
  const artifactFiles = roleArtifactFiles(role);

  for (const file of artifactFiles) {
    const text = (await readTextIfExists(join(workerDir, file))).trim();
    if (!text) {
      continue;
    }
    sections.push({ group: "role", title: file, text });
  }

  for (const artifact of await featureArtifactSections(role, workerDir)) {
    const text = artifact.text.trim();
    if (!text) {
      continue;
    }
    sections.push({ group: "feature", title: artifact.label, text });
  }

  const rawOutput = (await readTextIfExists(logPath)).trimEnd();
  if (rawOutput) {
    sections.push({ group: "process", title: "output.log", text: rawOutput });
  }

  return sections;
}

async function loadNanoWorkerOutputLines(logPath: string, height: number): Promise<RenderLine[]> {
  const rawOutput = (await readTextIfExists(logPath)).trimEnd();
  if (!rawOutput) {
    return [{ kind: "placeholder", text: EMPTY_WORKER_OUTPUT_TEXT }];
  }

  const lines = renderNanoProcessContent(compactNanoProcessText(rawOutput, height));
  return lines.length > 0
    ? [{ kind: "group", text: "process" }, ...lines]
    : [{ kind: "placeholder", text: EMPTY_WORKER_OUTPUT_TEXT }];
}

function renderNanoProcessContent(text: string): RenderLine[] {
  const lines: RenderLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).replace(/\r/g, "").trimEnd();
    const trimmed = line.trim();
    if (!trimmed || workerOutputSourceColumns(trimmed)) {
      continue;
    }
    if (/^(?:ERROR|Error|error):\s+/.test(trimmed) || /\bCodex ran out of room\b/i.test(trimmed)) {
      lines.push({ kind: "error", text: trimmed });
      continue;
    }
    if (/^Smoke test passed\b/i.test(trimmed)) {
      lines.push({ kind: "success", text: trimmed });
      continue;
    }
    if (
      isProcessStatusWithCommandLine(trimmed) ||
      isBuildOutputSummaryLine(trimmed) ||
      isNoMatchesSummaryLine(trimmed) ||
      /^Node tests passed\b/i.test(trimmed) ||
      /^Dev server fallback\b/i.test(trimmed)
    ) {
      lines.push({ kind: "summary", text: trimmed });
      continue;
    }
    if (isProcessCommandDisplayLine(trimmed)) {
      continue;
    }
    lines.push({ kind: "content", text: trimmed });
  }
  return lines;
}

function roleArtifactFiles(role: WorkerRole | undefined): string[] {
  if (role === "judge") {
    return ["requirements.md", "plan.md", "acceptance.md"];
  }
  if (role === "actor") {
    return ["worklog.md", "actor-worklog.md", "patch.diff", "actor-replies.jsonl"];
  }
  if (role === "critic") {
    return ["review.md", "critic-findings.jsonl"];
  }
  return [];
}

async function featureArtifactSections(role: WorkerRole | undefined, workerDir: string): Promise<Array<{ label: string; text: string }>> {
  const files = featureArtifactFiles(role);
  if (files.length === 0) {
    return [];
  }

  const taskDir = dirname(workerDir);
  const featuresDir = join(taskDir, "features");
  if (!(await pathExists(featuresDir))) {
    return [];
  }

  const entries = await readdir(featuresDir, { withFileTypes: true });
  const featureDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const sections: Array<{ label: string; text: string }> = [];

  for (const featureDir of featureDirs) {
    for (const file of files) {
      const path = join(featuresDir, featureDir, file);
      const text = await readTextIfExists(path);
      if (text.trim()) {
        sections.push({
          label: join("features", basename(featureDir), file),
          text
        });
      }
    }
  }

  return sections;
}

function featureArtifactFiles(role: WorkerRole | undefined): string[] {
  if (role === "actor") {
    return ["actor-worklog.md", "actor-replies.jsonl"];
  }
  if (role === "critic") {
    return ["critic-findings.jsonl", "decisions.md"];
  }
  return [];
}

function compactDecisionMarkdown(text: string): string {
  const lines = text.split("\n");
  if (!lines.some((line) => decisionBlockName(line) !== null)) {
    return text;
  }

  const kept: string[] = [];
  let currentBlock: string | null = null;
  let blockLines: string[] = [];

  const flushBlock = () => {
    if (currentBlock === null) {
      kept.push(...blockLines);
    } else if (currentBlock === "critic review") {
      kept.push(...compactDecisionReviewBlock(blockLines));
    } else if (currentBlock === "critic findings") {
      kept.push("Critic findings:");
      kept.push(...trimOuterBlankLines(blockLines));
    }
    blockLines = [];
  };

  for (const line of lines) {
    const blockName = decisionBlockName(line);
    if (blockName) {
      flushBlock();
      currentBlock = blockName;
      blockLines = [];
      continue;
    }
    blockLines.push(line);
  }
  flushBlock();

  return compactDecisionStatusBlankLines(
    compactDecisionFeatureTurnLines(
      compactDecisionBlankLines(kept)
        .filter((line) => !isTruncatedDecisionFragment(line))
    )
  )
    .join("\n")
    .trim();
}

function compactDecisionFeatureTurnLines(lines: string[]): string[] {
  const compacted: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    const feature = line.match(/^Feature:\s*(.+)$/i);
    const turn = next.match(/^Turn:\s*(.+)$/i);
    if (feature && turn) {
      const featureId = feature[1] ?? "";
      const turnId = turn[1] ?? "";
      compacted.push(featureId === turnId ? `Feature ${featureId}` : `Feature ${featureId} · Turn ${turnId}`);
      index += 1;
      continue;
    }
    compacted.push(line);
  }
  return compacted;
}

function compactDecisionStatusBlankLines(lines: string[]): string[] {
  const compacted: string[] = [];
  let blankPending = false;

  for (const line of lines) {
    if (!line.trim()) {
      blankPending = compacted.length > 0;
      continue;
    }

    const previous = compacted[compacted.length - 1] ?? "";
    if (blankPending && !(isDecisionStatusLine(previous) && isDecisionStatusLine(line))) {
      compacted.push("");
    }
    compacted.push(line);
    blankPending = false;
  }

  return compacted;
}

function isDecisionStatusLine(line: string): boolean {
  return /^(?:Feature\s+\S+|Feature:\s*\S+\s+·\s+Turn:\s*\S+|Summary:|Review:|Blocking:|Findings:)/i.test(line.trim());
}

function decisionBlockName(line: string): string | null {
  const normalized = line.trim().replace(/：$/, ":").toLowerCase();
  if (normalized === "requirements:") {
    return "requirements";
  }
  if (normalized === "actor work:") {
    return "actor work";
  }
  if (normalized === "critic review:") {
    return "critic review";
  }
  if (normalized === "critic findings:") {
    return "critic findings";
  }
  return null;
}

function compactDecisionReviewBlock(lines: string[]): string[] {
  const kept: string[] = ["Critic review:"];
  const reviewLines = trimOuterBlankLines(lines);
  let skippedRedundantHeading = false;
  for (let index = 0; index < reviewLines.length; index += 1) {
    const line = reviewLines[index] ?? "";
    const trimmed = line.trim();
    if (index === 0 && isRedundantFeatureReviewHeading(trimmed)) {
      skippedRedundantHeading = true;
      continue;
    }
    if (skippedRedundantHeading && !trimmed) {
      continue;
    }
    skippedRedundantHeading = false;
    if (/^##\s+(User Request|Actor Behavior|Evidence|Verification|Residual Risk)\b/i.test(trimmed)) {
      break;
    }
    kept.push(line);
  }
  return kept;
}

function isRedundantFeatureReviewHeading(line: string): boolean {
  return /^#\s+Critic Review\s*[-–]\s*Feature\s+\S+/i.test(line);
}

function trimOuterBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1]?.trim()) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function compactDecisionBlankLines(lines: string[]): string[] {
  const compacted: string[] = [];
  let blankPending = false;
  for (const line of lines) {
    if (!line.trim()) {
      blankPending = compacted.length > 0;
      continue;
    }
    if (blankPending) {
      compacted.push("");
      blankPending = false;
    }
    compacted.push(line);
  }
  return compacted;
}

function isTruncatedDecisionFragment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "..." || /`\S*\.\.\.$/.test(trimmed) || /\S\.\.\.$/.test(trimmed);
}

function renderLinesFromSections(
  sections: WorkerOutputSection[],
  options: { nanoProcess?: boolean; height?: number } = {}
): RenderLine[] {
  const lines: RenderLine[] = [];
  let currentGroup: WorkerOutputSection["group"] | null = null;
  const supersededArtifacts = supersededRoleArtifactFiles(sections);
  const renderedArtifactFiles = new Set<string>(supersededArtifacts);

  for (const section of sections) {
    if (supersededArtifacts.has(basename(section.title))) {
      continue;
    }
    const displaySection = options.nanoProcess && section.group === "process"
      ? { ...section, text: compactNanoProcessText(section.text, options.height ?? 8) }
      : section;
    const sectionLines = renderSectionContent(displaySection, renderedArtifactFiles);
    if (sectionLines.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push({ kind: "blank", text: "" });
    }
    if (section.group !== currentGroup) {
      lines.push({ kind: "group", text: groupTitle(section.group) });
      currentGroup = section.group;
    }
    if (section.group !== "process") {
      lines.push({ kind: "section", text: section.title });
    }
    lines.push(...sectionLines);
    if (section.group !== "process") {
      renderedArtifactFiles.add(basename(section.title));
    }
  }

  return lines.length > 0 ? lines : [{ kind: "placeholder", text: EMPTY_WORKER_OUTPUT_TEXT }];
}

function compactNanoProcessText(text: string, height: number): string {
  const rawLines = text.split(/\r?\n/);
  const maxLines = Math.max(8, height * 2);
  if (rawLines.length <= maxLines) {
    return text;
  }

  const compacted = rawLines
    .map((line) => stripAnsi(line).replace(/\r/g, "").trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return Boolean(trimmed) && !workerOutputSourceColumns(trimmed);
    });
  const important = compacted.filter(isNanoProcessImportantLine);
  const selected = important.length > 0 ? important : compacted;
  return selected.slice(-maxLines).join("\n");
}

function isNanoProcessImportantLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    isProcessStatusWithCommandLine(trimmed) ||
    isBuildOutputSummaryLine(trimmed) ||
    isNoMatchesSummaryLine(trimmed) ||
    /^Smoke test passed\b/i.test(trimmed) ||
    /^Node tests passed\b/i.test(trimmed) ||
    /^Dev server fallback\b/i.test(trimmed) ||
    /^(?:ERROR|Error|error):\s+/.test(trimmed) ||
    /\bCodex ran out of room\b/i.test(trimmed)
  );
}

function supersededRoleArtifactFiles(sections: WorkerOutputSection[]): Set<string> {
  const hasFeatureDecisions = sections.some((section) => section.group === "feature" && basename(section.title) === "decisions.md");
  if (!hasFeatureDecisions) {
    return new Set();
  }
  return new Set(
    sections
      .filter((section) => section.group === "role" && basename(section.title) === "review.md")
      .map((section) => basename(section.title))
  );
}

function renderSectionContent(section: WorkerOutputSection, renderedArtifactFiles = new Set<string>()): RenderLine[] {
  if (section.title.endsWith(".diff")) {
    return renderDiffContent(section.text);
  }

  const lines: RenderLine[] = [];
  let inCodeFence = false;
  const sectionText = section.title.endsWith("decisions.md")
    ? compactDecisionMarkdown(section.text)
    : section.text;
  const displayText = section.group === "process"
    ? sanitizeProcessOutput(sectionText, {
      hideAssistantNarration: renderedArtifactFiles.size > 0,
      renderedArtifactFiles
    })
    : sectionText;
  const hiddenProcessDiffFiles = section.group === "process" ? renderedArtifactFiles : new Set<string>();
  const rawLines = displayText.split("\n");
  let codeFenceLanguage = "";

  for (let index = 0; index < rawLines.length;) {
    const rawLine = stripAnsi(rawLines[index] ?? "").replace(/\r/g, "");
    const sourceLine = section.group === "process" ? workerOutputSourceColumns(rawLine) : null;
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (sourceLine) {
      lines.push({ kind: "source-line", text: `${sourceLine.lineNumber}\t${sourceLine.code}` });
      index += 1;
      continue;
    }

    if (!trimmed) {
      lines.push({ kind: "blank", text: "" });
      index += 1;
      continue;
    }

    if (section.title.endsWith(".jsonl")) {
      lines.push(...renderJsonLine(trimmed));
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```") && section.group === "process") {
      index += 1;
      continue;
    }

    const codeFence = trimmed.match(/^```\s*([A-Za-z0-9_-]*)/);
    if (codeFence) {
      if (inCodeFence) {
        inCodeFence = false;
        codeFenceLanguage = "";
      } else {
        inCodeFence = true;
        codeFenceLanguage = (codeFence[1] ?? "").toLowerCase();
      }
      index += 1;
      continue;
    }

    if (inCodeFence) {
      const codeLine = decodeHtmlEntities(line.trimStart());
      lines.push(
        isShellCodeFenceLanguage(codeFenceLanguage) && codeLine.trim()
          ? { kind: "command", text: shellCodeFenceCommandLine(codeLine) }
          : { kind: "code", text: codeLine }
      );
      index += 1;
      continue;
    }

    if (isDiffStartLine(line.trimStart())) {
      const diffBlock = collectEmbeddedDiffBlock(rawLines, index);
      if (processDiffBlockTargetsArtifacts(diffBlock.lines, hiddenProcessDiffFiles)) {
        index = diffBlock.nextIndex;
        continue;
      }
      if (lines.length > 0 && lines[lines.length - 1]?.kind !== "blank") {
        lines.push({ kind: "blank", text: "" });
      }
      const diffSummary = section.group === "process" ? summarizeProcessDiffBlock(diffBlock.lines) : null;
      const collapseDiff = Boolean(diffSummary && shouldCollapseProcessDiffBlock(diffSummary));
      lines.push(...(
        collapseDiff && diffSummary
          ? renderCollapsedProcessDiffContent(diffSummary)
          : renderDiffContent(diffBlock.lines.join("\n"))
      ));
      index = collapseDiff ? skipProcessDiffTailContext(rawLines, diffBlock.nextIndex) : diffBlock.nextIndex;
      continue;
    }

    if (section.group === "process" && hiddenProcessDiffFiles.size > 0 && isDiffHunkLine(line.trimStart())) {
      index = collectBareDiffHunkBlock(rawLines, index).nextIndex;
      continue;
    }

    if (
      section.group === "process" &&
      isCollapsedOutputSummaryLine(trimmed) &&
      nextSignificantProcessLineStartsDiff(rawLines, index + 1)
    ) {
      index += 1;
      continue;
    }

    if (section.group === "process" && isProcessCodeOutputLine(trimmed)) {
      const codeFragment = collectProcessCodeFragmentRun(rawLines, index);
      if (nextSignificantProcessLineStartsDiff(rawLines, codeFragment.nextIndex)) {
        index = codeFragment.nextIndex;
        continue;
      }
    }

    if (section.group === "process" && isBareProcessDiffBodyLine(line)) {
      const bareDiffBody = collectBareProcessDiffBodyRun(rawLines, index);
      if (bareDiffBody.bodyLines >= 1) {
        index = bareDiffBody.nextIndex;
        continue;
      }
    }

    const tableBlock = collectMarkdownTableBlock(rawLines, index);
    if (tableBlock) {
      lines.push(...tableBlock.lines);
      index = tableBlock.nextIndex;
      continue;
    }

    lines.push(classifyRenderedLine(section, line));
    index += 1;
  }

  return compactRenderedBlankLines(
    removeRedundantSectionHeading(
      section,
      compactVerificationListBlocks(
        compactWorkerHeadingValuePairs(
          compactRenderedBlankLines(
            refineListDetailLines(section.group === "process" ? cleanProcessRenderLines(lines) : lines)
          )
        )
      )
    )
  );
}

function processDiffBlockTargetsArtifacts(diffLines: string[], artifactFiles: Set<string>): boolean {
  return diffLines.some((line) => {
    const title = renderDiffFileTitle(line.trimStart());
    if (!title) {
      return false;
    }
    return artifactFiles.has(diffTitlePath(title));
  });
}

function compactRenderedBlankLines(lines: RenderLine[]): RenderLine[] {
  const compacted: RenderLine[] = [];
  let blankPending = false;

  for (const line of lines) {
    if (line.kind === "blank" || !line.text.trim()) {
      blankPending = compacted.length > 0;
      continue;
    }

    const previousLine = compacted[compacted.length - 1];
    if (
      blankPending &&
      previousLine?.kind !== "blank" &&
      shouldKeepBlankBetweenRenderedLines(previousLine, line)
    ) {
      compacted.push({ kind: "blank", text: "" });
    }
    compacted.push(line);
    blankPending = false;
  }

  return compacted;
}

function refineListDetailLines(lines: RenderLine[]): RenderLine[] {
  const refined: RenderLine[] = [];
  let inFileDetailRun = false;

  for (const line of lines) {
    if (line.kind !== "list") {
      refined.push(line);
      if (line.kind === "blank" || !line.text.trim() || line.kind === "heading" || line.kind === "section" || line.kind === "group") {
        inFileDetailRun = false;
      }
      continue;
    }

    const fileWithDescription = splitFilePathListItemDescription(line.text);
    if (fileWithDescription) {
      refined.push({ kind: "list", text: fileWithDescription.path });
      refined.push({ kind: "list-detail", text: fileWithDescription.description });
      inFileDetailRun = true;
      continue;
    }

    if (isFilePathListItem(line.text)) {
      refined.push(line);
      inFileDetailRun = true;
      continue;
    }

    refined.push(inFileDetailRun ? { kind: "list-detail", text: line.text } : line);
  }

  return refined;
}

function compactWorkerHeadingValuePairs(lines: RenderLine[]): RenderLine[] {
  const compacted: RenderLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    if (line && next && shouldCompactWorkerHeadingValuePair(line, next)) {
      const headingText = compactWorkerHeadingLabelText(line.text);
      compacted.push({
        kind: "content",
        text: compactWorkerHeadingValueText(headingText, next.text)
      });
      index += 1;
      continue;
    }
    if (line) {
      compacted.push(line);
    }
  }

  return compacted;
}

function compactVerificationListBlocks(lines: RenderLine[]): RenderLine[] {
  const compacted: RenderLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.kind !== "heading" || !/^Verification$/i.test(line.text.trim())) {
      if (line) {
        compacted.push(line);
      }
      continue;
    }

    const items: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor]?.kind === "blank") {
      cursor += 1;
    }
    while (cursor < lines.length) {
      const candidate = lines[cursor];
      if (!candidate || (candidate.kind !== "list" && candidate.kind !== "list-detail")) {
        break;
      }
      items.push(candidate.text);
      cursor += 1;
    }

    const summary = verificationListSummary(items);
    if (!summary) {
      compacted.push(line);
      continue;
    }

    compacted.push({ kind: "content", text: `Verification: ${summary}` });
    index = cursor - 1;
  }

  return compacted;
}

function verificationListSummary(items: string[]): string | null {
  if (items.length < 2) {
    return null;
  }

  const signals: string[] = [];
  const joined = items.join(" ");
  const focusedTests = joined.match(/\bnode --test\b.*?\bpassed,\s*(\d+\/\d+)/i);
  if (focusedTests) {
    signals.push(`unit ${focusedTests[1] ?? ""}`);
  }
  const npmTests = joined.match(/\bnpm test\b.*?\bpassed,\s*(\d+\/\d+)/i);
  if (npmTests) {
    signals.push(`tests ${npmTests[1] ?? ""}`);
  } else if (/\bnpm test\b.*?\bpassed\b/i.test(joined)) {
    signals.push("tests passed");
  }
  if (/\bnpm run smoke\b.*?\bpassed\b/i.test(joined)) {
    signals.push("smoke passed");
  }
  if (/\bnpm run build\b.*?\bpassed\b/i.test(joined)) {
    signals.push("build passed");
  }
  if (/\bnpm run dev\b.*?\b(?:could not bind|fallback|dist\/?\s*fallback)\b/i.test(joined)) {
    signals.push("dev fallback");
  }

  return signals.length >= 2 ? signals.join(" · ") : null;
}

function shouldCompactWorkerHeadingValuePair(heading: RenderLine, value: RenderLine): boolean {
  if (!isCompactWorkerHeadingLine(heading) || value.kind !== "content") {
    return false;
  }
  const label = compactWorkerHeadingLabelText(heading.text).toLowerCase();
  if (!COMPACT_WORKER_HEADING_VALUE_LABELS.has(label)) {
    return false;
  }
  const text = value.text.trim();
  if (label === "blocking findings" && isEmptyBlockingFindingsText(text)) {
    return true;
  }
  if (label === "critic findings" && isEmptyCriticFindingsText(text)) {
    return true;
  }
  return Boolean(text) && displayWidth(text) <= 64 && !isMarkdownListLikeLine(text);
}

function compactWorkerHeadingValueText(headingText: string, valueText: string): string {
  const heading = headingText.trim();
  const value = valueText.trim();
  if (/^supervisor summary$/i.test(heading)) {
    return compactSupervisorSummaryForWidth(`${heading}: ${value}`, 80);
  }
  if (/^critic review$/i.test(heading)) {
    return compactCriticReviewBodyForWidth(`${heading}: ${value}`, 80);
  }
  if (/^blocking findings$/i.test(heading) && isEmptyBlockingFindingsText(value)) {
    return "Blocking: none";
  }
  if (/^critic findings$/i.test(heading) && isEmptyCriticFindingsText(value)) {
    return "Findings: none";
  }
  return `${heading}: ${value}`;
}

function isEmptyBlockingFindingsText(text: string): boolean {
  return /^(?:no findings\.?|none\.?|\(empty\))$/i.test(text);
}

function isEmptyCriticFindingsText(text: string): boolean {
  return (
    /^(?:no findings\.?|none\.?|\(empty\))$/i.test(text) ||
    /^No active Critic findings were present for this feature;/.test(text)
  );
}

function isCompactWorkerHeadingLine(line: RenderLine): boolean {
  return line.kind === "heading" || (line.kind === "content" && /[：:]\s*$/.test(line.text.trim()));
}

function compactWorkerHeadingLabelText(text: string): string {
  return text.trim().replace(/[：:]\s*$/, "");
}

const COMPACT_WORKER_HEADING_VALUE_LABELS = new Set([
  "blocking findings",
  "critic findings",
  "critic review",
  "feature",
  "supervisor summary",
  "turn",
  "user request"
]);

function removeRedundantSectionHeading(section: WorkerOutputSection, lines: RenderLine[]): RenderLine[] {
  const redundantHeading = redundantSectionHeading(section.title);
  if (!redundantHeading) {
    return lines;
  }

  const firstContentIndex = lines.findIndex((line) => line.kind !== "blank" && line.text.trim());
  if (firstContentIndex < 0) {
    return lines;
  }
  const firstContent = lines[firstContentIndex];
  if (firstContent?.kind !== "heading" || firstContent.text.trim().toLowerCase() !== redundantHeading) {
    return lines;
  }

  return lines.filter((_, index) => index !== firstContentIndex);
}

function redundantSectionHeading(title: string): string | null {
  const file = basename(title).toLowerCase();
  if (file === "actor-worklog.md") {
    return "actor feature worklog";
  }
  if (file === "decisions.md") {
    return "decisions";
  }
  return null;
}

function splitFilePathListItemDescription(text: string): { path: string; description: string } | null {
  const match = text.trim().match(/^(\S+)\s+-\s+(.+)$/);
  if (!match) {
    return null;
  }
  const path = match[1] ?? "";
  const description = match[2] ?? "";
  return isFilePathListItem(path) && description.trim()
    ? { path, description: description.trim() }
    : null;
}

function isFilePathListItem(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes(",")) {
    const paths = trimmed.split(",").map((path) => path.trim()).filter(Boolean);
    return paths.length > 1 && paths.every((path) => isSingleFilePathListItem(path));
  }
  return isSingleFilePathListItem(trimmed);
}

function isSingleFilePathListItem(trimmed: string): boolean {
  return (
    /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+*?-]+)*\.[A-Za-z0-9._@+*?-]+$/.test(trimmed) ||
    /^[A-Za-z0-9._@+-]+\/[A-Za-z0-9._@+*?/-]+$/.test(trimmed)
  );
}

function cleanProcessRenderLines(lines: RenderLine[]): RenderLine[] {
  return removePatchDiffReadbackNoise(removeDiffAdjacentCodeSummaries(mergeSmokeStatusSuccessLines(lines)));
}

function mergeSmokeStatusSuccessLines(lines: RenderLine[]): RenderLine[] {
  const merged: RenderLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    if (line.kind === "command" && isSmokeCommandLine(line.text)) {
      const status = nextNonBlankRenderLine(lines, index + 1);
      const duration = status?.line ? succeededStatusDuration(status.line) : null;
      const success = status ? nextNonBlankRenderLine(lines, status.index + 1) : null;
      if (duration && success?.line.kind === "success" && isSmokePassedLine(success.line.text)) {
        merged.push({
          kind: "success",
          text: mergeSmokeStatusText(success.line.text, duration)
        });
        index = success.index;
        continue;
      }
    }

    const smokeStatus = smokeStatusDuration(line);
    if (!smokeStatus) {
      merged.push(line);
      continue;
    }

    const next = nextNonBlankRenderLine(lines, index + 1);
    if (!next?.line || next.line.kind !== "success" || !isSmokePassedLine(next.line.text)) {
      merged.push(line);
      continue;
    }

    merged.push({
      kind: "success",
      text: mergeSmokeStatusText(next.line.text, smokeStatus.duration)
    });
    index = next.index;
  }

  return merged;
}

function smokeStatusDuration(line: RenderLine): { duration: string } | null {
  if (line.kind !== "summary") {
    return null;
  }
  const match = line.text.match(/^succeeded\s+in\s+(\d+(?:ms|s|m)?):?\s+\(\$\s+npm\s+run\s+smoke\b[^)]*\)$/i);
  return match ? { duration: match[1] ?? "" } : null;
}

function succeededStatusDuration(line: RenderLine): string | null {
  if (line.kind !== "summary") {
    return null;
  }
  const match = line.text.match(/^succeeded\s+in\s+(\d+(?:ms|s|m)?):?$/i);
  return match?.[1] ?? null;
}

function isSmokeCommandLine(text: string): boolean {
  return /^\$\s+npm\s+run\s+smoke\b/i.test(text.trim());
}

function isSmokePassedLine(text: string): boolean {
  return /^Smoke test passed\b/i.test(text.trim());
}

function mergeSmokeStatusText(text: string, duration: string): string {
  const match = text.trim().match(/^Smoke test passed:?\s*(.*)$/i);
  const detail = match?.[1]?.trim() ?? "";
  return [`Smoke test passed in ${duration}`, detail ? `: ${detail}` : ""].join("");
}

function removeDiffAdjacentCodeSummaries(lines: RenderLine[]): RenderLine[] {
  return lines.filter((line, index) => {
    if (line.kind !== "summary" || !/^Collapsed code output:/i.test(line.text.trim())) {
      return true;
    }
    return !(
      nearbyNonBlankLineIsCollapsedDiff(lines, index, -1) ||
      nearbyNonBlankLineIsCollapsedDiff(lines, index, 1)
    );
  });
}

function nearbyNonBlankLineIsCollapsedDiff(lines: RenderLine[], startIndex: number, direction: -1 | 1): boolean {
  for (let index = startIndex + direction; index >= 0 && index < lines.length; index += direction) {
    const line = lines[index];
    if (!line || line.kind === "blank" || !line.text.trim()) {
      continue;
    }
    return line.kind === "summary" && /^Collapsed diff:/i.test(line.text.trim());
  }
  return false;
}

function removePatchDiffReadbackNoise(lines: RenderLine[]): RenderLine[] {
  const hidden = new Set<number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.kind !== "command" || !isPatchDiffReadbackCommand(line.text)) {
      continue;
    }

    const status = nextNonBlankRenderLine(lines, index + 1);
    const afterStatus = status ? nextNonBlankRenderLine(lines, status.index + 1) : null;
    if (
      status?.line.kind === "summary" &&
      isProcessStatusLine(status.line.text.trim()) &&
      afterStatus?.line.kind === "summary" &&
      /^Collapsed diff:/i.test(afterStatus.line.text.trim())
    ) {
      hidden.add(index);
      hidden.add(status.index);
    }
  }

  return lines.filter((_, index) => !hidden.has(index));
}

function nextNonBlankRenderLine(lines: RenderLine[], startIndex: number): { line: RenderLine; index: number } | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && line.kind !== "blank" && line.text.trim()) {
      return { line, index };
    }
  }
  return null;
}

function isPatchDiffReadbackCommand(text: string): boolean {
  return /^\$\s+(?:cat|sed|nl|head|tail|bat|less|more)\b/.test(text.trim()) && /\bpatch\.diff\b/.test(text);
}

function shouldKeepBlankBetweenRenderedLines(previousLine: RenderLine, nextLine: RenderLine): boolean {
  if (isCollapsedDiffSummaryLine(previousLine) && isCollapsedDiffSummaryLine(nextLine)) {
    return false;
  }
  if (isCompactStatusRenderLine(previousLine) && isCompactStatusRenderLine(nextLine)) {
    return false;
  }
  if (previousLine.kind === "heading" || nextLine.kind === "heading") {
    return false;
  }
  return !(isDenseProcessEventLine(previousLine) && isDenseProcessEventLine(nextLine));
}

function isCompactStatusRenderLine(line: RenderLine): boolean {
  return line.kind === "content" && isDecisionStatusLine(line.text);
}

function isDenseProcessEventLine(line: RenderLine): boolean {
  if (isCollapsedDiffSummaryLine(line)) {
    return false;
  }
  return line.kind === "summary" || line.kind === "success" || line.kind === "command" || line.kind === "error";
}

function isCollapsedDiffSummaryLine(line: RenderLine): boolean {
  return line.kind === "summary" && /^Collapsed diff:/i.test(line.text.trim());
}

function diffTitlePath(title: string): string {
  const match = title.match(/^Update\((.+?)(?: -> .+)?\)$/);
  return match?.[1] ?? title;
}

const SOURCE_OUTPUT_COLLAPSE_MIN_LINES = 8;
const CODE_OUTPUT_COLLAPSE_MIN_LINES = 4;
const FILE_LIST_OUTPUT_COLLAPSE_MIN_LINES = 12;
const READ_SUMMARY_RUN_COLLAPSE_MIN_ITEMS = 3;
const NODE_TEST_OUTPUT_COLLAPSE_MIN_PASSES = 3;
const PROCESS_DIFF_COLLAPSE_MIN_BODY_LINES = 1;
const PROCESS_DIFF_COLLAPSE_MIN_FILES = 4;

function sanitizeProcessOutput(text: string, options: ProcessOutputSanitizeOptions = {}): string {
  const rawLines = text.split("\n");
  const kept: string[] = [];
  const hideAssistantNarration = options.hideAssistantNarration ?? false;
  const renderedArtifactFiles = options.renderedArtifactFiles ?? new Set<string>();

  for (let index = 0; index < rawLines.length;) {
    const line = normalizedProcessLine(rawLines[index] ?? "");
    const trimmed = line.trim();

    if (shouldDropNoisyProcessLine(trimmed, line)) {
      index = skipNoisyProcessLine(rawLines, index);
      continue;
    }

    if (isNpmLifecycleEchoStart(trimmed)) {
      index = skipNpmLifecycleEchoBlock(rawLines, index);
      continue;
    }

    if (isCodexStartupPreamble(trimmed)) {
      index = skipCodexStartupPreamble(rawLines, index);
      continue;
    }

    if (hideAssistantNarration && isAssistantNarrativeMarker(trimmed)) {
      index = skipAssistantNarrativeBlock(rawLines, index);
      continue;
    }

    if (hideAssistantNarration && isUnmarkedAssistantNarrativeStart(trimmed)) {
      index = skipAssistantNarrativeTextBlock(rawLines, index);
      continue;
    }

    const npmStatusCommand = npmLifecycleCommandAfterStatus(rawLines, index);
    if (npmStatusCommand) {
      kept.push(`${trimmed} ($ ${npmStatusCommand})`);
      index += 1;
      continue;
    }

    if (isRolePromptTranscriptStart(trimmed)) {
      index = skipRolePromptTranscript(rawLines, index);
      continue;
    }

    const execCommand = collectProcessExecCommand(rawLines, index);
    if (execCommand) {
      if (
        processCommandReadsRenderedArtifact(execCommand.command, renderedArtifactFiles) ||
        processCommandReadsParallelCodexTaskFile(execCommand.command) ||
        processCommandInspectsSessionMetadata(execCommand.command) ||
        processCommandReadsSessionSystemFile(execCommand.command) ||
        processCommandReadsSkillDocument(execCommand.command)
      ) {
        index = skipProcessCommandOutputBlock(rawLines, execCommand.nextIndex);
        continue;
      }
      kept.push(execCommand.commandLine);
      index = execCommand.nextIndex;
      continue;
    }

    kept.push(rawLines[index] ?? "");
    index += 1;
  }

  return collapseProcessOutputLines(
    compactReadSummaryRuns(
      compactNoMatchSearchCommandBlocks(
        compactAnnotatedStatusCommandPairs(
          compactNodeTestOutputBlocks(
            compactBuildOutputBlocks(
              compactDevServerFallbackBlocks(
                compactCollapsedCommandBlocks(dropSuccessfulInternalLaunchCommands(collapseVerboseProcessOutput(kept)))
              )
            )
          )
        )
      )
    )
  ).join("\n").trimEnd();
}

function collectProcessExecCommand(
  rawLines: string[],
  startIndex: number
): { command: string; commandLine: string; nextIndex: number } | null {
  const line = normalizedProcessLine(rawLines[startIndex] ?? "");
  const trimmed = line.trim();

  if (trimmed === "exec") {
    const nextLine = normalizedProcessLine(rawLines[startIndex + 1] ?? "").trim();
    const command = parseShellExecCommand(nextLine);
    if (command) {
      return {
        command,
        commandLine: `$ ${command}`,
        nextIndex: startIndex + 2
      };
    }
    return null;
  }

  const command = parseShellExecCommand(trimmed);
  if (!command) {
    return null;
  }

  return {
    command,
    commandLine: `$ ${command}`,
    nextIndex: startIndex + 1
  };
}

function processCommandReadsRenderedArtifact(command: string, artifactFiles: Set<string>): boolean {
  if (artifactFiles.size === 0) {
    return false;
  }
  const trimmed = command.trim();
  if (!/^(?:cat|sed|nl|head|tail|wc|bat|less|more)\b/.test(trimmed)) {
    return false;
  }
  if (!trimmed.includes(".parallel-codex/sessions/")) {
    return false;
  }
  return Array.from(artifactFiles).some((file) =>
    trimmed.endsWith(file) ||
    trimmed.includes(`/${file}`) ||
    trimmed.includes(` ${file}`)
  );
}

function processCommandReadsParallelCodexTaskFile(command: string): boolean {
  const trimmed = command.trim();
  if (!/^(?:cat|sed|nl|head|tail|bat|less|more)\b/.test(trimmed)) {
    return false;
  }
  if (!trimmed.includes(".parallel-codex/sessions/")) {
    return false;
  }
  return /\.(?:md|json|jsonl|diff|toml|txt)\b/.test(trimmed);
}

function processCommandInspectsSessionMetadata(command: string): boolean {
  const trimmed = command.trim();
  return (
    /^(?:find|ls|wc|stat|du)\b/.test(trimmed) &&
    trimmed.includes(".parallel-codex/sessions/")
  );
}

function processCommandReadsSessionSystemFile(command: string): boolean {
  const trimmed = command.trim();
  if (!/^(?:cat|sed|nl|head|tail|bat|less|more)\b/.test(trimmed)) {
    return false;
  }
  if (!trimmed.includes(".parallel-codex/sessions/")) {
    return false;
  }
  return /\/(?:prompt\.md|meta\.json|user-request\.md|native-session\.json)\b/.test(trimmed);
}

function processCommandReadsSkillDocument(command: string): boolean {
  const trimmed = command.trim();
  return (
    /^(?:cat|sed|nl|head|tail|bat|less|more)\b/.test(trimmed) &&
    trimmed.includes("/.codex/") &&
    trimmed.includes("SKILL.md")
  );
}

function skipProcessCommandOutputBlock(rawLines: string[], startIndex: number): number {
  let index = startIndex;
  while (index < rawLines.length) {
    const line = normalizedProcessLine(rawLines[index] ?? "");
    const trimmed = line.trim();
    if (
      trimmed === "exec" ||
      trimmed.startsWith("$ ") ||
      parseShellExecCommand(trimmed) !== null ||
      isAssistantNarrativeMarker(trimmed) ||
      isDiffStartLine(trimmed)
    ) {
      return index;
    }
    index += 1;
  }
  return index;
}

function parseShellExecCommand(line: string): string | null {
  const match = line.match(/^\/(?:[\w.-]+\/)*(?:zsh|bash|sh)\s+-lc\s+(.+)$/);
  if (!match) {
    return null;
  }

  const rest = match[1]?.trim() ?? "";
  const quoted = readQuotedShellArgument(rest);
  if (quoted) {
    return normalizeShellDisplayCommand(quoted.value);
  }

  return rest.replace(/\s+in\s+\/.+$/, "").trim() || null;
}

function normalizeShellDisplayCommand(command: string): string {
  return command.replace(/'"([^']*?)"'/g, "'$1'");
}

function readQuotedShellArgument(text: string): { value: string; endIndex: number } | null {
  if (text[0] !== "\"" && text[0] !== "'") {
    return null;
  }

  let value = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";

    if (/\s/.test(char)) {
      break;
    }

    if (char === "\"" || char === "'") {
      const segment = readQuotedShellSegment(text, index);
      if (!segment) {
        return null;
      }
      value += segment.value;
      index = segment.endIndex;
      continue;
    }

    value += char;
    index += 1;
  }

  return { value, endIndex: index };
}

function readQuotedShellSegment(text: string, startIndex: number): { value: string; endIndex: number } | null {
  const quote = text[startIndex];
  if (quote !== "\"" && quote !== "'") {
    return null;
  }

  let value = "";
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "\\" && quote === "\"") {
      const next = text[index + 1];
      if (next) {
        value += next;
        index += 1;
        continue;
      }
    }
    if (char === quote) {
      return { value, endIndex: index + 1 };
    }
    value += char;
  }

  return null;
}

function isAssistantNarrativeMarker(trimmed: string): boolean {
  return trimmed === "codex" || trimmed === "assistant";
}

function skipAssistantNarrativeBlock(rawLines: string[], startIndex: number): number {
  return skipAssistantNarrativeTextBlock(rawLines, startIndex + 1);
}

function skipAssistantNarrativeTextBlock(rawLines: string[], startIndex: number): number {
  let index = startIndex;
  while (index < rawLines.length) {
    const line = normalizedProcessLine(rawLines[index] ?? "");
    const trimmed = line.trim();

    if (shouldDropNoisyProcessLine(trimmed, line)) {
      index = skipNoisyProcessLine(rawLines, index);
      continue;
    }

    if (isAssistantNarrativeBoundary(trimmed) || isDiffStartLine(trimmed) || isRolePromptTranscriptStart(trimmed)) {
      return index;
    }

    index += 1;
  }

  return index;
}

function isUnmarkedAssistantNarrativeStart(trimmed: string): boolean {
  return (
    /^Blocking findings:/i.test(trimmed) ||
    /^I(?:'ve| have) completed the critic review\b/i.test(trimmed) ||
    /^Wrote\s+`?APPROVED`?\b/i.test(trimmed) ||
    /^Verified:\s*$/i.test(trimmed) ||
    /^已在\s+worker\s+目录写好/.test(trimmed) ||
    /^我只写了任务文档/.test(trimmed)
  );
}

function isAssistantNarrativeBoundary(trimmed: string): boolean {
  if (!trimmed) {
    return false;
  }
  return (
    trimmed.startsWith("$ ") ||
    trimmed === "exec" ||
    parseShellExecCommand(trimmed) !== null ||
    /^(succeeded|failed) in \d+/i.test(trimmed) ||
    /^(ERROR|Error|error|Traceback|Exception|Failed|failed|Failure|failure)\b/.test(trimmed)
  );
}

function normalizedProcessLine(line: string): string {
  return stripAnsi(line).replace(/\r/g, "");
}

function collapseVerboseProcessOutput(lines: string[]): string[] {
  const collapsed: string[] = [];

  for (let index = 0; index < lines.length;) {
    const fileListRun = collectFileListOutputRun(lines, index);
    if (fileListRun && fileListRun.pathLines >= FILE_LIST_OUTPUT_COLLAPSE_MIN_LINES) {
      collapsed.push(`Collapsed file list output: ${fileListRun.pathLines} paths`);
      index = fileListRun.nextIndex;
      continue;
    }

    const sourceRun = collectSourceOutputRun(lines, index);
    if (sourceRun && sourceRun.sourceLines >= SOURCE_OUTPUT_COLLAPSE_MIN_LINES) {
      collapsed.push(`Collapsed source output: ${sourceRun.sourceLines} ${pluralizeLine(sourceRun.sourceLines)}`);
      index = sourceRun.nextIndex;
      continue;
    }

    const codeRun = collectCodeOutputRun(lines, index);
    if (codeRun && codeRun.codeLines >= CODE_OUTPUT_COLLAPSE_MIN_LINES) {
      collapsed.push(`Collapsed code output: ${codeRun.codeLines} ${pluralizeLine(codeRun.codeLines)}`);
      index = codeRun.nextIndex;
      continue;
    }

    collapsed.push(lines[index] ?? "");
    index += 1;
  }

  return collapsed;
}

function compactCollapsedCommandBlocks(lines: string[]): string[] {
  const compacted: string[] = [];
  const pendingCommands: string[] = [];

  for (let index = 0; index < lines.length;) {
    const currentLine = normalizedProcessLine(lines[index] ?? "").trim();

    if (isProcessCommandDisplayLine(currentLine)) {
      pendingCommands.push(lines[index] ?? "");
      index += 1;
      continue;
    }

    if (!currentLine && pendingCommands.length > 0 && nextNonBlankLineStartsCollapsedStatusBlock(lines, index + 1)) {
      index += 1;
      continue;
    }

    const collapsedBlock = collectStatusCollapsedOutputBlock(lines, index);
    if (collapsedBlock) {
      const commandLine = pendingCommands.shift();
      const summaryCommand = commandLine
        ? summaryCommandForCollapsedOutput(normalizedProcessLine(commandLine).trim(), collapsedBlock.collapsedLine)
        : null;
      compacted.push(
        summaryCommand
          ? `${collapsedBlock.statusLine} ${collapsedBlock.collapsedLine} (${summaryCommand})`
          : `${collapsedBlock.statusLine} ${collapsedBlock.collapsedLine}`
      );
      index = collapsedBlock.nextIndex;
      continue;
    }

    compacted.push(...pendingCommands);
    pendingCommands.length = 0;
    compacted.push(lines[index] ?? "");
    index += 1;
  }

  compacted.push(...pendingCommands);

  return compacted;
}

interface ReadSummaryLine {
  target: string;
  lineCount: number;
}

function compactReadSummaryRuns(lines: string[]): string[] {
  const compacted: string[] = [];

  for (let index = 0; index < lines.length;) {
    const run = collectReadSummaryRun(lines, index);
    if (run.items.length >= READ_SUMMARY_RUN_COLLAPSE_MIN_ITEMS) {
      compacted.push(formatReadSummaryRun(run.items));
      index = run.nextIndex;
      continue;
    }

    compacted.push(lines[index] ?? "");
    index += 1;
  }

  return compacted;
}

function collectReadSummaryRun(lines: string[], startIndex: number): { items: ReadSummaryLine[]; nextIndex: number } {
  const items: ReadSummaryLine[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const currentLine = normalizedProcessLine(lines[index] ?? "");
    const item = readSummaryLine(currentLine);
    if (!item) {
      if (items.length > 0 && !currentLine.trim()) {
        index += 1;
        continue;
      }
      break;
    }
    items.push(item);
    index += 1;
  }

  return { items, nextIndex: index };
}

function readSummaryLine(line: string): ReadSummaryLine | null {
  const match = normalizedProcessLine(line)
    .trim()
    .match(/^((?:succeeded|failed|exited\s+\d+)\s+in\s+\d+(?:ms|s|m)?):?\s+(Collapsed (?:code|source) output: (\d+) lines)(?:\s+\((\$ .+)\))?$/i);
  if (!match?.[4]) {
    return null;
  }

  const target = readTargetFromCommand(match[4]);
  if (!target) {
    return null;
  }

  return {
    target: formatReadTarget(target).replace(/:\d+-\d+$/, ""),
    lineCount: Number.parseInt(match[3] ?? "0", 10)
  };
}

function formatReadSummaryRun(items: ReadSummaryLine[]): string {
  const totalLines = items.reduce((sum, item) => sum + item.lineCount, 0);
  const targets = compactReadSummaryTargets(items.map((item) => item.target));
  return `Collapsed read summaries: ${items.length} chunks, ${totalLines} lines (${targets})`;
}

function compactReadSummaryTargets(targets: string[]): string {
  const uniqueTargets = Array.from(new Set(targets));
  const visibleTargets = uniqueTargets.slice(0, 3).join(", ");
  const remaining = uniqueTargets.length - 3;
  return remaining > 0 ? `${visibleTargets}, +${remaining} more` : visibleTargets;
}

function nextNonBlankLineStartsCollapsedStatusBlock(lines: string[], startIndex: number): boolean {
  for (let index = startIndex; index < lines.length; index += 1) {
    const trimmed = normalizedProcessLine(lines[index] ?? "").trim();
    if (!trimmed) {
      continue;
    }
    return collectStatusCollapsedOutputBlock(lines, index) !== null;
  }
  return false;
}

function collectStatusCollapsedOutputBlock(
  lines: string[],
  startIndex: number
): { statusLine: string; collapsedLine: string; nextIndex: number } | null {
  const statusLine = normalizedProcessLine(lines[startIndex] ?? "").trim();
  if (!isProcessStatusLine(statusLine)) {
    return null;
  }

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = normalizedProcessLine(lines[index] ?? "");
    const trimmed = line.trim();

    if (isCollapsedOutputSummaryLine(trimmed)) {
      return {
        statusLine,
        collapsedLine: trimmed,
        nextIndex: index + 1
      };
    }

    if (!isIgnorableOutputPreludeBeforeCollapsedSummary(trimmed)) {
      return null;
    }
  }

  return null;
}

function isIgnorableOutputPreludeBeforeCollapsedSummary(line: string): boolean {
  return !line || /^total\s+\d+$/i.test(line) || /^[dl-][rwx-]{9}@?\s+\d+\s+\S+\s+\S+\s+\d+\s+\w{3}\s+\d+\s+\d{1,2}:\d{2}\s+.+$/.test(line);
}

function summaryCommandForCollapsedOutput(commandLine: string, collapsedLine: string): string {
  if (/^Collapsed file list output:/i.test(collapsedLine) && /^\$\s+pwd\s+&&\s+rg\s+--files\b/.test(commandLine)) {
    return "$ pwd && rg --files";
  }
  return commandLine;
}

function dropSuccessfulInternalLaunchCommands(lines: string[]): string[] {
  const filtered: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizedProcessLine(lines[index] ?? "").trim();
    if (isInternalWorkerLaunchCommand(line) && !launchCommandHasFailureContext(lines, index + 1)) {
      continue;
    }
    filtered.push(lines[index] ?? "");
  }

  return filtered;
}

function compactNoMatchSearchCommandBlocks(lines: string[]): string[] {
  const compacted: string[] = [];

  for (let index = 0; index < lines.length;) {
    const commandLine = normalizedProcessLine(lines[index] ?? "").trim();
    const statusLine = normalizedProcessLine(lines[index + 1] ?? "").trim();
    const noMatch = noMatchSearchStatusLine(commandLine, statusLine);

    if (noMatch && nextLineHasNoCommandOutput(lines, index + 2)) {
      compacted.push(noMatch);
      index += 2;
      continue;
    }

    compacted.push(lines[index] ?? "");
    index += 1;
  }

  return compacted;
}

function compactDevServerFallbackBlocks(lines: string[]): string[] {
  const compacted: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = normalizedProcessLine(lines[index] ?? "").trim();

    if (/^Unable to bind a local dev server in this environment\.?$/i.test(line)) {
      compacted.push("Dev server fallback: dist/index.html");
      index += 1;

      while (index < lines.length && normalizedProcessLine(lines[index] ?? "").trim() === "") {
        index += 1;
      }
      if (/^Built static app in dist\/?$/i.test(normalizedProcessLine(lines[index] ?? "").trim())) {
        index += 1;
      }
      while (index < lines.length && normalizedProcessLine(lines[index] ?? "").trim() === "") {
        index += 1;
      }
      if (isDevServerFallbackOpenLine(normalizedProcessLine(lines[index] ?? "").trim())) {
        index += 1;
      }
      continue;
    }

    compacted.push(lines[index] ?? "");
    index += 1;
  }

  return compacted;
}

function isDevServerFallbackOpenLine(line: string): boolean {
  return /^Open\s+(?:file:\/\/\S+\/)?dist\/index\.html\b/i.test(line);
}

function compactBuildOutputBlocks(lines: string[]): string[] {
  const compacted: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = normalizedProcessLine(lines[index] ?? "").trim();
    const nextIndex = nextNonBlankLineIndex(lines, index + 1);
    const next = nextIndex === null ? "" : normalizedProcessLine(lines[nextIndex] ?? "").trim();

    if (nextIndex !== null && isNpmBuildStatusCommand(line) && /^Built static app in dist\/?$/i.test(next)) {
      compacted.push(`${line} Build output: dist/`);
      index = nextIndex + 1;
      continue;
    }

    compacted.push(lines[index] ?? "");
    index += 1;
  }

  return compacted;
}

function nextNonBlankLineIndex(lines: string[], startIndex: number): number | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (normalizedProcessLine(lines[index] ?? "").trim() !== "") {
      return index;
    }
  }
  return null;
}

function isNpmBuildStatusCommand(line: string): boolean {
  return isProcessStatusWithCommandLine(line) && /\(\$\s+npm\s+run\s+build\b/.test(line);
}

function compactAnnotatedStatusCommandPairs(lines: string[]): string[] {
  const compacted: string[] = [];
  const annotatedCommands = new Set(
    lines
      .map((line) => annotatedStatusCommand(normalizedProcessLine(line).trim()))
      .filter((command): command is string => command !== null)
  );

  for (let index = 0; index < lines.length; index += 1) {
    const commandLine = normalizedProcessLine(lines[index] ?? "").trim();
    if (isProcessCommandDisplayLine(commandLine) && annotatedCommands.has(commandLine)) {
      continue;
    }
    if (isProcessCommandDisplayLine(commandLine)) {
      const next = nextNonBlankLine(lines, index + 1);
      if (next && annotatedStatusCommand(next.line) === commandLine) {
        continue;
      }
    }
    compacted.push(lines[index] ?? "");
  }

  return compacted;
}

function compactNodeTestOutputBlocks(lines: string[]): string[] {
  const compacted: string[] = [];

  for (let index = 0; index < lines.length;) {
    const block = collectNodeTestOutputBlock(lines, index);
    if (block && block.passCount >= NODE_TEST_OUTPUT_COLLAPSE_MIN_PASSES) {
      compacted.push(formatNodeTestOutputSummary(block));
      index = block.nextIndex;
      continue;
    }

    compacted.push(lines[index] ?? "");
    index += 1;
  }

  return compacted;
}

interface NodeTestOutputBlock {
  passCount: number;
  totalCount: number;
  skippedCount: number;
  duration: string | null;
  nextIndex: number;
}

function collectNodeTestOutputBlock(lines: string[], startIndex: number): NodeTestOutputBlock | null {
  let index = startIndex;
  let passLines = 0;
  let totalCount: number | null = null;
  let passCount: number | null = null;
  let failCount: number | null = null;
  let skippedCount = 0;
  let duration: string | null = null;
  let sawInfoLine = false;

  while (index < lines.length) {
    const trimmed = normalizedProcessLine(lines[index] ?? "").trim();

    if (!trimmed && passLines > 0) {
      index += 1;
      continue;
    }

    if (isNodeTestPassLine(trimmed)) {
      passLines += 1;
      index += 1;
      continue;
    }

    if (isNodeTestFailureLine(trimmed)) {
      return null;
    }

    const info = parseNodeTestInfoLine(trimmed);
    if (info && passLines > 0) {
      sawInfoLine = true;
      if (info.key === "tests") {
        totalCount = info.value;
      } else if (info.key === "pass") {
        passCount = info.value;
      } else if (info.key === "fail" && info.value > 0) {
        return null;
      } else if (info.key === "fail") {
        failCount = info.value;
      } else if (info.key === "skipped" || info.key === "cancelled" || info.key === "todo") {
        skippedCount += info.value;
      } else if (info.key === "duration_ms") {
        duration = formatWorkerDuration(`${info.rawValue}ms`);
      }
      index += 1;
      continue;
    }

    break;
  }

  if (passLines === 0 || (!sawInfoLine && passLines < NODE_TEST_OUTPUT_COLLAPSE_MIN_PASSES)) {
    return null;
  }

  if (failCount !== null && failCount > 0) {
    return null;
  }

  const resolvedPassCount = passCount ?? passLines;
  return {
    passCount: resolvedPassCount,
    totalCount: totalCount ?? resolvedPassCount,
    skippedCount,
    duration,
    nextIndex: index
  };
}

function isNodeTestPassLine(line: string): boolean {
  return /^✔\s+.+\(\d+(?:\.\d+)?ms\)$/.test(line);
}

function isNodeTestFailureLine(line: string): boolean {
  return /^✖\s+/.test(line) || /^not ok\b/i.test(line);
}

function parseNodeTestInfoLine(line: string): { key: string; value: number; rawValue: string } | null {
  const match = line.match(/^ℹ\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }
  return {
    key: (match[1] ?? "").toLowerCase(),
    value: Number.parseFloat(match[2] ?? "0"),
    rawValue: match[2] ?? "0"
  };
}

function formatNodeTestOutputSummary(block: NodeTestOutputBlock): string {
  const total = Math.max(block.totalCount, block.passCount);
  const skipped = block.skippedCount > 0 ? `, ${block.skippedCount} skipped` : "";
  const duration = block.duration ? ` in ${block.duration}` : "";
  return `Node tests passed: ${block.passCount}/${total}${skipped}${duration}`;
}

function formatWorkerDuration(value: string): string {
  const trimmed = value.trim();
  const milliseconds = trimmed.match(/^(\d+(?:\.\d+)?)ms$/i);
  if (milliseconds) {
    return `${Math.max(0, Math.round(Number.parseFloat(milliseconds[1] ?? "0")))}ms`;
  }
  return trimmed;
}

function nextNonBlankLine(lines: string[], startIndex: number): { line: string; index: number } | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = normalizedProcessLine(lines[index] ?? "").trim();
    if (line) {
      return { line, index };
    }
  }
  return null;
}

function annotatedStatusCommand(line: string): string | null {
  const match = line.match(/^(?:succeeded|failed|exited\s+\d+)\s+in\s+\d+(?:ms|s|m)?(?::)?\s+\((\$ .+)\)(?:\s+Build output:\s*.+)?$/i);
  return match?.[1] ?? null;
}

function noMatchSearchStatusLine(commandLine: string, statusLine: string): string | null {
  if (!isNoMatchSearchCommand(commandLine)) {
    return null;
  }
  const match = statusLine.match(/^exited\s+1\s+in\s+(\d+(?:ms|s|m)?):?$/i);
  return match ? `No matches in ${match[1] ?? ""} (${commandLine})`.trim() : null;
}

function isNoMatchSearchCommand(commandLine: string): boolean {
  return /^\$\s+(?:rg|grep|git\s+grep)\b/.test(commandLine);
}

function nextLineHasNoCommandOutput(lines: string[], startIndex: number): boolean {
  for (let index = startIndex; index < lines.length; index += 1) {
    const trimmed = normalizedProcessLine(lines[index] ?? "").trim();
    if (!trimmed) {
      continue;
    }
    return (
      isProcessCommandDisplayLine(trimmed) ||
      isProcessStatusLine(trimmed) ||
      isNoMatchesSummaryLine(trimmed) ||
      trimmed === "exec" ||
      isAssistantNarrativeMarker(trimmed) ||
      isDiffStartLine(trimmed)
    );
  }
  return true;
}

function isInternalWorkerLaunchCommand(line: string): boolean {
  return (
    /^\$\s+codex\s+exec\b/.test(line) ||
    /^\$\s+claude\s+--print\b/.test(line)
  );
}

function launchCommandHasFailureContext(lines: string[], startIndex: number): boolean {
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 5); index += 1) {
    const trimmed = normalizedProcessLine(lines[index] ?? "").trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("$ ")) {
      return false;
    }
    return /^(error|Error|failed|Failed|Usage:|Not inside|permission denied|command not found)\b/.test(trimmed);
  }
  return false;
}

function isProcessCommandDisplayLine(line: string): boolean {
  return line.startsWith("$ ");
}

function isProcessStatusLine(line: string): boolean {
  return /^(?:succeeded|failed|exited\s+\d+)\s+in\s+\d+(?:ms|s|m)?(?::)?$/i.test(line);
}

function isProcessStatusWithCommandLine(line: string): boolean {
  return /^(?:succeeded|failed|exited\s+\d+)\s+in\s+\d+(?:ms|s|m)?(?::)?\s+\(\$ .+\)$/i.test(line);
}

function isBuildOutputSummaryLine(line: string): boolean {
  return /^(?:succeeded|failed|exited\s+\d+)\s+in\s+\d+(?:ms|s|m)?(?::)?\s+\(\$ .+\)\s+Build output:\s*.+$/i.test(line);
}

function isNoMatchesSummaryLine(line: string): boolean {
  return /^No matches in \d+(?:ms|s|m)?(?:\s+\(\$ .+\))?$/i.test(line);
}

function isCollapsedOutputSummaryLine(line: string): boolean {
  return /^Collapsed (?:code|file list|source) output: \d+ (?:lines|paths)$/i.test(line);
}

function isCollapsedOutputSummaryDisplayLine(line: string): boolean {
  return (
    /\bCollapsed (?:code|file list|source) output: \d+ (?:lines|paths)\b/i.test(line) ||
    /^Collapsed read summaries: \d+ chunks, \d+ lines\b/i.test(line) ||
    /^Node tests passed: \d+\/\d+/i.test(line) ||
    /^Dev server fallback:/i.test(line)
  );
}

function collectFileListOutputRun(
  lines: string[],
  startIndex: number
): { pathLines: number; nextIndex: number } | null {
  let index = startIndex;
  let pathLines = 0;
  let consumedBlank = false;

  while (index < lines.length) {
    const line = normalizedProcessLine(lines[index] ?? "");
    const trimmed = line.trim();
    if (trimmed && isFileListOutputLine(trimmed)) {
      pathLines += 1;
      consumedBlank = false;
      index += 1;
      continue;
    }

    if (!trimmed && pathLines > 0) {
      consumedBlank = true;
      index += 1;
      continue;
    }

    break;
  }

  if (pathLines === 0) {
    return null;
  }

  if (consumedBlank) {
    index -= 1;
  }

  return {
    pathLines,
    nextIndex: index
  };
}

function isFileListOutputLine(line: string): boolean {
  if (
    line.startsWith("$ ") ||
    isActionableProcessBoundary(line) ||
    isDiffStartLine(line) ||
    isDiffHunkLine(line)
  ) {
    return false;
  }

  const pathSegment = String.raw`[A-Za-z0-9._@+-]+`;
  const pathPattern = new RegExp(String.raw`^(?:/)?${pathSegment}(?:/${pathSegment})+(?:\s+[A-Za-z0-9._@+-]+)?$`);
  if (pathPattern.test(line)) {
    return true;
  }

  return /^[A-Za-z0-9._@+-]+\.(?:cjs|css|diff|html|js|json|jsonl|lock|md|mjs|toml|ts|tsx|txt|yml|yaml)$/.test(line);
}

function collectSourceOutputRun(
  lines: string[],
  startIndex: number
): { sourceLines: number; nextIndex: number } | null {
  let index = startIndex;
  let sourceLines = 0;
  let consumedBlank = false;

  while (index < lines.length) {
    const line = normalizedProcessLine(lines[index] ?? "");
    const trimmed = line.trim();
    if (workerOutputSourceColumns(line)) {
      sourceLines += 1;
      consumedBlank = false;
      index += 1;
      continue;
    }

    if (!trimmed && sourceLines > 0) {
      consumedBlank = true;
      index += 1;
      continue;
    }

    break;
  }

  if (sourceLines === 0) {
    return null;
  }

  if (consumedBlank) {
    index -= 1;
  }

  return {
    sourceLines,
    nextIndex: index
  };
}

function collectCodeOutputRun(
  lines: string[],
  startIndex: number
): { codeLines: number; nextIndex: number } | null {
  let index = startIndex;
  let codeLines = 0;
  let consumedBlank = false;

  while (index < lines.length) {
    const line = normalizedProcessLine(lines[index] ?? "");
    const trimmed = line.trim();
    if (trimmed && isProcessCodeOutputLine(trimmed)) {
      codeLines += 1;
      consumedBlank = false;
      index += 1;
      continue;
    }

    if (!trimmed && codeLines > 0) {
      consumedBlank = true;
      index += 1;
      continue;
    }

    break;
  }

  if (codeLines === 0) {
    return null;
  }

  if (consumedBlank) {
    index -= 1;
  }

  return {
    codeLines,
    nextIndex: index
  };
}

function isProcessCodeOutputLine(line: string): boolean {
  return isCodeLikeProcessLine(line) || isJavaScriptLikeProcessLine(line) || isCssLikeProcessLine(line);
}

function isCssLikeProcessLine(line: string): boolean {
  const selectorPart = String.raw`[.#]?[A-Za-z0-9_-]+(?:\[[^\]]+\])?(?::[A-Za-z-]+)?`;
  return (
    /^@media\b.*\{$/.test(line) ||
    /^:[A-Za-z-]+(?:,|\s*\{)$/.test(line) ||
    /^\*,$/.test(line) ||
    new RegExp(`^(?:${selectorPart}|\\*)(?:::[A-Za-z-]+)?(?:\\s+${selectorPart})*(?:,|\\s*\\{)$`).test(line) ||
    /^[A-Za-z-]+:\s*$/.test(line) ||
    /^--[A-Za-z0-9-]+:\s*.+;?$/.test(line) ||
    /^(?:radial-gradient|linear-gradient)\(.*[;,]$/.test(line) ||
    /^-?[A-Za-z][A-Za-z0-9-]*,$/.test(line) ||
    /^"[^"]+",$/.test(line) ||
    /^[A-Za-z][A-Za-z0-9-]*;$/.test(line)
  );
}

function isJavaScriptLikeProcessLine(line: string): boolean {
  return (
    /^(?:const|let|var|import|export|await|return|if|else|for|while|switch|try|catch|finally|function|class|new)\b/.test(line) ||
    /^\}\s*else\b/.test(line) ||
    /^\.[A-Za-z_$][\w$]*(?:\s*\(|\.)/.test(line) ||
    /^[A-Za-z_$][\w$.[\]'"]*\s*(?:[+\-*/%]?=|\(|\.)/.test(line) ||
    /^[A-Za-z_$][\w$]*,?$/.test(line) ||
    /^[A-Za-z_$][\w$]*(?:\[[^\]]+\])+\s*=/.test(line) ||
    /^(?:\d+|["']?[A-Za-z_$][\w$-]*["']?):\s*.+,?$/.test(line) ||
    /^\}\s+from\s+["']/.test(line) ||
    /^#[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*[;{]?$/.test(line) ||
    /^\*::[A-Za-z-]+(?:,|\s*\{)?$/.test(line) ||
    /^\[[\s\S]*[,;\]]?$/.test(line) ||
    /^\.\.\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\([^)]*\))?[,;]?$/.test(line) ||
    /^[A-Za-z_$][\w$]*\?\.\(/.test(line) ||
    /^["'`].*[,;]?$/.test(line) ||
    /^[{[(]+[,;)]*$/.test(line) ||
    /^[}\])]+[,;)]*$/.test(line) ||
    /^[);]+$/.test(line) ||
    /=>/.test(line)
  );
}

function skipNoisyProcessLine(rawLines: string[], startIndex: number): number {
  const trimmed = normalizedProcessLine(rawLines[startIndex] ?? "").trim();
  if (/^tokens used$/i.test(trimmed)) {
    let index = startIndex + 1;
    while (index < rawLines.length && /^\d[\d,]*$/.test(normalizedProcessLine(rawLines[index] ?? "").trim())) {
      index += 1;
    }
    return index;
  }
  return startIndex + 1;
}

function shouldDropNoisyProcessLine(trimmed: string, line: string): boolean {
  if (!trimmed) {
    return false;
  }
  return (
    /^tokens used$/i.test(trimmed) ||
    trimmed.includes("codex_models_manager::manager: failed to refresh available models") ||
    (trimmed.includes("failed to decode models response") && trimmed.includes("body: {\"data\"")) ||
    trimmed.startsWith("body: {\"data\"") ||
    /^202\d-\d\d-\d\dT.*codex_models_manager::manager/.test(trimmed) ||
    /^reasoning summaries:/i.test(trimmed) ||
    /^session id:/i.test(trimmed) ||
    /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/.test(trimmed) ||
    line === "--------"
  );
}

function isNpmLifecycleEchoStart(trimmed: string): boolean {
  return /^>\s+(?:@[^/\s]+\/)?[^@\s]+@\S+\s+\S+/.test(trimmed);
}

function npmLifecycleCommandAfterStatus(rawLines: string[], statusIndex: number): string | null {
  const statusLine = normalizedProcessLine(rawLines[statusIndex] ?? "").trim();
  if (!isProcessStatusLine(statusLine)) {
    return null;
  }

  let index = statusIndex + 1;
  while (index < rawLines.length && !normalizedProcessLine(rawLines[index] ?? "").trim()) {
    index += 1;
  }

  const lifecycleLine = normalizedProcessLine(rawLines[index] ?? "").trim();
  const match = lifecycleLine.match(/^>\s+(?:@[^/\s]+\/)?[^@\s]+@\S+\s+([^\s]+)$/);
  if (!match) {
    return null;
  }

  const scriptName = match[1] ?? "";
  return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
}

function skipNpmLifecycleEchoBlock(rawLines: string[], startIndex: number): number {
  let index = startIndex + 1;
  const nextLine = normalizedProcessLine(rawLines[index] ?? "").trim();
  if (/^>\s+\S+/.test(nextLine) && !isNpmLifecycleEchoStart(nextLine)) {
    index += 1;
  }
  if (!normalizedProcessLine(rawLines[index] ?? "").trim()) {
    index += 1;
  }
  return index;
}

function isCodexStartupPreamble(trimmed: string): boolean {
  return /^OpenAI Codex v/i.test(trimmed);
}

function skipCodexStartupPreamble(rawLines: string[], startIndex: number): number {
  let index = startIndex + 1;
  while (index < rawLines.length) {
    const trimmed = normalizedProcessLine(rawLines[index] ?? "").trim();
    if (trimmed === "user") {
      return index + 1;
    }
    if (isRolePromptTranscriptStart(trimmed) || isActionableProcessBoundary(trimmed) || isDiffStartLine(trimmed)) {
      return index;
    }
    index += 1;
  }
  return index;
}

function isRolePromptTranscriptStart(trimmed: string): boolean {
  return /^#?\s*Role:\s+(Actor|Critic|Judge)\b/i.test(trimmed);
}

function skipRolePromptTranscript(rawLines: string[], startIndex: number): number {
  let index = startIndex + 1;
  let inUserRequest = false;
  let sawUserRequest = false;

  while (index < rawLines.length) {
    const line = normalizedProcessLine(rawLines[index] ?? "");
    const trimmed = line.trim();

    if (shouldDropNoisyProcessLine(trimmed, line)) {
      index = skipNoisyProcessLine(rawLines, index);
      continue;
    }

    if (/^User request:\s*$/i.test(trimmed)) {
      sawUserRequest = true;
      inUserRequest = true;
      index += 1;
      continue;
    }

    if (inUserRequest) {
      if (!trimmed) {
        inUserRequest = false;
      }
      index += 1;
      continue;
    }

    if ((sawUserRequest || trimmed === "codex" || trimmed === "assistant") && isActionableProcessBoundary(trimmed)) {
      return index;
    }

    if (isDiffStartLine(trimmed)) {
      return index;
    }

    index += 1;
  }

  return index;
}

function isActionableProcessBoundary(trimmed: string): boolean {
  if (!trimmed) {
    return false;
  }
  return (
    trimmed.startsWith("$ ") ||
    trimmed === "exec" ||
    /^\/.*\s+in\s+\/.+/.test(trimmed) ||
    /^(succeeded|failed) in \d+/i.test(trimmed) ||
    /^(ERROR|Error|error|Traceback|Exception|Failed|failed|Failure|failure)\b/.test(trimmed) ||
    /^(✓|✔|\[ok\]|\[done\])/.test(trimmed) ||
    /\b(passed|success|succeeded|complete)\b/i.test(trimmed)
  );
}

function collapseProcessOutputLines(lines: string[]): string[] {
  const collapsed: string[] = [];
  let previousContent = "";
  let blankPending = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = normalizedProcessLine(line).trim();

    if (!trimmed) {
      blankPending = collapsed.length > 0;
      continue;
    }

    if (trimmed === previousContent) {
      blankPending = false;
      continue;
    }

    if (blankPending) {
      collapsed.push("");
      blankPending = false;
    }

    collapsed.push(line);
    previousContent = trimmed;
  }

  return collapsed;
}

function collectEmbeddedDiffBlock(rawLines: string[], startIndex: number): { lines: string[]; nextIndex: number } {
  const lines: string[] = [];
  let index = startIndex;
  let insideHunk = false;
  let hunkCounts: { oldRemaining: number; newRemaining: number } | null = null;

  while (index < rawLines.length) {
    const line = stripAnsiForDiff(rawLines[index] ?? "");
    const trimmedStart = line.trimStart();

    if (lines.length === 0) {
      if (!isDiffStartLine(trimmedStart)) {
        break;
      }
      lines.push(trimmedStart);
      index += 1;
      continue;
    }

    if (isDiffStartLine(trimmedStart)) {
      lines.push(trimmedStart);
      insideHunk = false;
      hunkCounts = null;
      index += 1;
      continue;
    }

    if (isDiffHunkLine(trimmedStart)) {
      lines.push(trimmedStart);
      insideHunk = true;
      hunkCounts = parseHunkCounts(trimmedStart);
      index += 1;
      continue;
    }

    if (isDiffMetaLine(trimmedStart)) {
      lines.push(trimmedStart);
      index += 1;
      continue;
    }

    if (insideHunk && isDiffBodyLine(line)) {
      if (hunkCounts && hunkCounts.oldRemaining <= 0 && hunkCounts.newRemaining <= 0) {
        break;
      }
      lines.push(line);
      hunkCounts = consumeHunkLine(line, hunkCounts);
      index += 1;
      continue;
    }

    break;
  }

  return { lines, nextIndex: index };
}

function collectBareDiffHunkBlock(rawLines: string[], startIndex: number): { nextIndex: number } {
  let index = startIndex;
  let insideHunk = false;
  let hunkCounts: { oldRemaining: number; newRemaining: number } | null = null;

  while (index < rawLines.length) {
    const line = stripAnsiForDiff(rawLines[index] ?? "");
    const trimmedStart = line.trimStart();

    if (isDiffHunkLine(trimmedStart)) {
      insideHunk = true;
      hunkCounts = parseHunkCounts(trimmedStart);
      index += 1;
      continue;
    }

    if (insideHunk && isDiffBodyLine(line)) {
      if (hunkCounts && hunkCounts.oldRemaining <= 0 && hunkCounts.newRemaining <= 0) {
        break;
      }
      hunkCounts = consumeHunkLine(line, hunkCounts);
      index += 1;
      continue;
    }

    if (insideHunk && isDiffMetaLine(trimmedStart)) {
      index += 1;
      continue;
    }

    break;
  }

  return { nextIndex: index };
}

function collectBareProcessDiffBodyRun(rawLines: string[], startIndex: number): { bodyLines: number; nextIndex: number } {
  let index = startIndex;
  let bodyLines = 0;

  while (index < rawLines.length) {
    const line = stripAnsiForDiff(rawLines[index] ?? "").trimEnd();
    if (!isBareProcessDiffBodyLine(line)) {
      break;
    }
    bodyLines += 1;
    index += 1;
  }

  return { bodyLines, nextIndex: index };
}

function isBareProcessDiffBodyLine(line: string): boolean {
  const trimmedStart = line.trimStart();
  if (trimmedStart.startsWith("+++") || trimmedStart.startsWith("---")) {
    return false;
  }
  if (/^[-*]\s+\S/.test(trimmedStart)) {
    return false;
  }
  return /^[+-](?:\S|\s{2,}|$)/.test(trimmedStart);
}

function collectProcessCodeFragmentRun(rawLines: string[], startIndex: number): { codeLines: number; nextIndex: number } {
  let index = startIndex;
  let codeLines = 0;

  while (index < rawLines.length) {
    const trimmed = normalizedProcessLine(rawLines[index] ?? "").trim();
    if (!trimmed || !isProcessCodeOutputLine(trimmed)) {
      break;
    }
    codeLines += 1;
    index += 1;
  }

  return { codeLines, nextIndex: index };
}

function nextSignificantProcessLineStartsDiff(rawLines: string[], startIndex: number): boolean {
  for (let index = startIndex; index < rawLines.length; index += 1) {
    const line = normalizedProcessLine(rawLines[index] ?? "");
    const trimmed = line.trim();
    if (
      !trimmed ||
      isBareProcessDiffBodyLine(line) ||
      isProcessCodeOutputLine(trimmed) ||
      isCollapsedOutputSummaryLine(trimmed)
    ) {
      continue;
    }
    return isDiffStartLine(trimmed);
  }
  return false;
}

interface ProcessDiffFileSummary {
  title: string;
  added: number;
  removed: number;
}

interface ProcessDiffSummary {
  files: ProcessDiffFileSummary[];
  added: number;
  removed: number;
  bodyLines: number;
}

function summarizeProcessDiffBlock(diffLines: string[]): ProcessDiffSummary | null {
  const files: ProcessDiffFileSummary[] = [];
  let currentFile: ProcessDiffFileSummary | null = null;
  let insideHunk = false;
  let hunkCounts: { oldRemaining: number; newRemaining: number } | null = null;
  let bodyLines = 0;

  const flushCurrentFile = () => {
    if (currentFile) {
      files.push(currentFile);
      currentFile = null;
    }
  };

  for (const rawLine of diffLines) {
    const line = stripAnsiForDiff(rawLine);
    const trimmedStart = line.trimStart();
    const fileTitle = renderDiffFileTitle(trimmedStart);

    if (fileTitle) {
      flushCurrentFile();
      currentFile = { title: fileTitle, added: 0, removed: 0 };
      insideHunk = false;
      hunkCounts = null;
      continue;
    }

    if (parseHunkStart(trimmedStart)) {
      insideHunk = true;
      hunkCounts = parseHunkCounts(trimmedStart);
      continue;
    }

    if (!currentFile || !insideHunk || !isDiffBodyLine(line)) {
      continue;
    }

    if (hunkCounts && hunkCounts.oldRemaining <= 0 && hunkCounts.newRemaining <= 0) {
      insideHunk = false;
      continue;
    }

    if (line.startsWith("+")) {
      currentFile.added += 1;
    } else if (line.startsWith("-")) {
      currentFile.removed += 1;
    }

    bodyLines += 1;
    hunkCounts = consumeHunkLine(line, hunkCounts);
  }

  flushCurrentFile();

  if (files.length === 0) {
    return null;
  }

  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    bodyLines
  };
}

function shouldCollapseProcessDiffBlock(summary: ProcessDiffSummary): boolean {
  return (
    summary.bodyLines >= PROCESS_DIFF_COLLAPSE_MIN_BODY_LINES ||
    summary.files.length >= PROCESS_DIFF_COLLAPSE_MIN_FILES
  );
}

function renderCollapsedProcessDiffContent(summary: ProcessDiffSummary): RenderLine[] {
  const changedFiles = summary.files.filter((file) => file.added > 0 || file.removed > 0);
  if (changedFiles.length === 0) {
    return [];
  }
  const changedSummary = {
    files: changedFiles,
    added: changedFiles.reduce((sum, file) => sum + file.added, 0),
    removed: changedFiles.reduce((sum, file) => sum + file.removed, 0)
  };
  return [
    {
      kind: "summary",
      text: `Collapsed diff: ${changedSummary.files.length} ${pluralizeFile(changedSummary.files.length)}, added ${changedSummary.added} ${pluralizeLine(changedSummary.added)}, removed ${changedSummary.removed} ${pluralizeLine(changedSummary.removed)} (${formatProcessDiffSummaryTargets(changedFiles)})`
    }
  ];
}

function formatProcessDiffSummaryTargets(files: ProcessDiffFileSummary[]): string {
  const targets = files.map((file) => diffTitlePath(file.title));
  const visibleTargets = targets.slice(0, 4).join(", ");
  const remaining = targets.length - 4;
  return remaining > 0 ? `${visibleTargets}, +${remaining} more` : visibleTargets;
}

function skipProcessDiffTailContext(rawLines: string[], startIndex: number): number {
  let index = startIndex;
  let skippedTail = false;

  while (index < rawLines.length) {
    const line = normalizedProcessLine(rawLines[index] ?? "");
    const trimmed = line.trim();

    if (!trimmed && (skippedTail || nextLineLooksLikeProcessDiffTail(rawLines, index + 1))) {
      index += 1;
      continue;
    }

    if (
      !trimmed ||
      isHardProcessBoundary(trimmed) ||
      isDiffStartLine(trimmed) ||
      isAssistantNarrativeMarker(trimmed) ||
      isRolePromptTranscriptStart(trimmed)
    ) {
      return index;
    }

    if (line.startsWith(" ") && isProcessCodeOutputLine(trimmed)) {
      skippedTail = true;
      index += 1;
      continue;
    }

    return index;
  }

  return index;
}

function nextLineLooksLikeProcessDiffTail(rawLines: string[], startIndex: number): boolean {
  for (let index = startIndex; index < rawLines.length; index += 1) {
    const line = normalizedProcessLine(rawLines[index] ?? "");
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    return line.startsWith(" ") && isProcessCodeOutputLine(trimmed);
  }
  return false;
}

function isHardProcessBoundary(trimmed: string): boolean {
  return (
    trimmed.startsWith("$ ") ||
    trimmed === "exec" ||
    parseShellExecCommand(trimmed) !== null ||
    isProcessStatusLine(trimmed) ||
    isProcessStatusWithCommandLine(trimmed) ||
    /^(ERROR|Error|error|Traceback|Exception|Failed|failed|Failure|failure)\b/.test(trimmed)
  );
}

function renderDiffContent(text: string): RenderLine[] {
  const rendered: RenderLine[] = [];
  let currentFile: ParsedDiffFile | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;
  let insideHunk = false;

  const flushCurrentFile = () => {
    if (!currentFile) {
      return;
    }
    rendered.push({ kind: "diff-file", text: currentFile.title });
    rendered.push({ kind: "diff-summary", text: summarizeDiffStats(currentFile.added, currentFile.removed) });
    rendered.push(...currentFile.lines);
    currentFile = null;
  };

  for (const rawLine of text.split("\n")) {
    const line = stripAnsiForDiff(rawLine);
    const trimmedStart = line.trimStart();
    const isBlankContextLine = Boolean(currentFile && insideHunk && line.startsWith(" "));
    if (!line.trim() && !isBlankContextLine) {
      continue;
    }

    const fileTitle = renderDiffFileTitle(trimmedStart);
    if (fileTitle) {
      flushCurrentFile();
      currentFile = { title: fileTitle, added: 0, removed: 0, lines: [] };
      oldLineNumber = 0;
      newLineNumber = 0;
      insideHunk = false;
      continue;
    }

    const hunkStart = parseHunkStart(trimmedStart);
    if (hunkStart) {
      oldLineNumber = hunkStart.oldStart;
      newLineNumber = hunkStart.newStart;
      insideHunk = true;
      continue;
    }

    if (currentFile && insideHunk && line.startsWith("+")) {
      currentFile.added += 1;
      currentFile.lines.push({
        kind: "diff-add",
        text: formatDiffCodeLine(newLineNumber, "+", line.slice(1))
      });
      newLineNumber += 1;
      continue;
    }

    if (currentFile && insideHunk && line.startsWith("-")) {
      currentFile.removed += 1;
      currentFile.lines.push({
        kind: "diff-remove",
        text: formatDiffCodeLine(oldLineNumber, "-", line.slice(1))
      });
      oldLineNumber += 1;
      continue;
    }

    if (currentFile && insideHunk && line.startsWith(" ")) {
      currentFile.lines.push({
        kind: "diff-context",
        text: formatDiffCodeLine(newLineNumber, " ", line.slice(1))
      });
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    if (isDiffMetaLine(trimmedStart)) {
      continue;
    }

    if (currentFile) {
      currentFile.lines.push({ kind: "diff-meta", text: trimmedStart });
      continue;
    }

    rendered.push({ kind: "diff-meta", text: trimmedStart });
  }

  flushCurrentFile();

  return rendered;
}

function renderDiffFileLine(line: string): RenderLine | null {
  const title = renderDiffFileTitle(line);
  if (!title) {
    return null;
  }
  return {
    kind: "diff-file",
    text: title
  };
}

function renderDiffFileTitle(line: string): string | null {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  const unifiedMatch = line.match(/^diff -u a\/(.+) b\/(.+)$/);
  if (!match && !unifiedMatch) {
    return null;
  }
  const oldPath = match?.[1] ?? unifiedMatch?.[1] ?? "";
  const newPath = match?.[2] ?? unifiedMatch?.[2] ?? "";
  const oldDisplayPath = formatDiffDisplayPath(oldPath);
  const newDisplayPath = formatDiffDisplayPath(newPath);
  if (oldDisplayPath === newDisplayPath) {
    return `Update(${newDisplayPath})`;
  }
  return `Update(${oldDisplayPath} -> ${newDisplayPath})`;
}

function formatDiffDisplayPath(path: string): string {
  const workerArtifact = path.match(/^\.parallel-codex\/sessions\/[^/]+\/[^/]+\/(.+)$/);
  if (workerArtifact) {
    return workerArtifact[1] ?? path;
  }
  return path;
}

function isDiffStartLine(line: string): boolean {
  return line.startsWith("diff --git ") || line.startsWith("diff -u ");
}

function isDiffHunkLine(line: string): boolean {
  return line.startsWith("@@");
}

function isDiffMetaLine(line: string): boolean {
  return (
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line.startsWith("Binary files ") ||
    line.startsWith("GIT binary patch") ||
    /^literal \d+/.test(line) ||
    /^delta \d+/.test(line) ||
    line.startsWith("\\ No newline at end of file")
  );
}

function isDiffBodyLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-") || line.startsWith(" ");
}

function parseHunkCounts(line: string): { oldRemaining: number; newRemaining: number } | null {
  const match = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
  if (!match) {
    return null;
  }
  return {
    oldRemaining: Number.parseInt(match[1] ?? "1", 10),
    newRemaining: Number.parseInt(match[2] ?? "1", 10)
  };
}

function consumeHunkLine(
  line: string,
  counts: { oldRemaining: number; newRemaining: number } | null
): { oldRemaining: number; newRemaining: number } | null {
  if (!counts || line.startsWith("\\ ")) {
    return counts;
  }
  if (line.startsWith("+")) {
    return { ...counts, newRemaining: Math.max(0, counts.newRemaining - 1) };
  }
  if (line.startsWith("-")) {
    return { ...counts, oldRemaining: Math.max(0, counts.oldRemaining - 1) };
  }
  if (line.startsWith(" ")) {
    return {
      oldRemaining: Math.max(0, counts.oldRemaining - 1),
      newRemaining: Math.max(0, counts.newRemaining - 1)
    };
  }
  return counts;
}

function parseHunkStart(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) {
    return null;
  }
  return {
    oldStart: Number.parseInt(match[1] ?? "0", 10),
    newStart: Number.parseInt(match[2] ?? "0", 10)
  };
}

function summarizeDiffStats(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`Added ${added} ${pluralizeLine(added)}`);
  }
  if (removed > 0) {
    const prefix = parts.length > 0 ? "removed" : "Removed";
    parts.push(`${prefix} ${removed} ${pluralizeLine(removed)}`);
  }
  return parts.length > 0 ? parts.join(", ") : "No line changes";
}

function pluralizeLine(count: number): string {
  return count === 1 ? "line" : "lines";
}

function pluralizeFile(count: number): string {
  return count === 1 ? "file" : "files";
}

function formatDiffCodeLine(lineNumber: number, marker: "+" | "-" | " ", code: string): string {
  return `${String(lineNumber).padStart(3, " ")} ${marker} ${code}`;
}

function classifyRenderedLine(section: WorkerOutputSection, line: string): RenderLine {
  const trimmed = line.trimStart();
  const decodedLine = decodeHtmlEntities(line);
  const decodedTrimmed = decodedLine.trimStart();
  const isProcessSection = section.group === "process";

  if (section.title.endsWith(".diff") || trimmed.startsWith("diff --git")) {
    const fileLine = renderDiffFileLine(trimmed);
    if (fileLine) {
      return fileLine;
    }
    if (trimmed.startsWith("@@")) {
      return { kind: "diff-hunk", text: trimmed };
    }
    if (trimmed.startsWith("+")) {
      return { kind: "diff-add", text: trimmed.slice(1) };
    }
    if (trimmed.startsWith("-")) {
      return { kind: "diff-remove", text: trimmed.slice(1) };
    }
  }

  const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    return { kind: "heading", text: stripInlineMarkdown(heading[2] ?? trimmed) };
  }

  if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
    return { kind: "rule", text: "────" };
  }

  const workerSectionHeading = workerSectionHeadingText(trimmed);
  if (workerSectionHeading) {
    return { kind: "heading", text: workerSectionHeading };
  }

  if (isProcessStatusLine(trimmed) || isProcessStatusWithCommandLine(trimmed) || isBuildOutputSummaryLine(trimmed)) {
    return { kind: "summary", text: trimmed };
  }

  if (isNoMatchesSummaryLine(trimmed)) {
    return { kind: "summary", text: trimmed };
  }

  if (
    (isProcessSection || isExplicitErrorLine(trimmed)) &&
    isErrorProcessLine(trimmed) &&
    !isMarkdownListLikeLine(trimmed)
  ) {
    return { kind: "error", text: trimmed };
  }

  if (isCollapsedOutputSummaryDisplayLine(trimmed)) {
    return { kind: "summary", text: trimmed };
  }

  if (isProcessSection && isCodeLikeProcessLine(decodedTrimmed)) {
    return { kind: "code", text: decodedTrimmed };
  }

  const quote = trimmed.match(/^>\s?(.+)$/);
  if (quote) {
    return { kind: "quote", text: stripInlineMarkdown(quote[1] ?? trimmed) };
  }

  const taskItem = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
  if (taskItem) {
    const checked = taskItem[1]?.toLowerCase() === "x";
    return {
      kind: "task",
      text: `${checked ? "☑" : "☐"} ${stripInlineMarkdown(taskItem[2] ?? "")}`
    };
  }

  const orderedItem = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
  if (orderedItem) {
    return {
      kind: "ordered-list",
      text: `${orderedItem[1] ?? "1"}. ${stripInlineMarkdown(orderedItem[2] ?? "")}`
    };
  }

  const listItem = trimmed.match(/^[-*]\s+(.+)$/);
  if (listItem) {
    return { kind: "list", text: stripInlineMarkdown(listItem[1] ?? trimmed) };
  }

  if (trimmed.startsWith("$ ") || trimmed.startsWith("> ")) {
    return { kind: "command", text: trimmed };
  }

  if (isProcessSection && isCodeLikeProcessLine(trimmed)) {
    return { kind: "code", text: decodedTrimmed };
  }

  if (
    (isProcessSection || isExplicitErrorLine(trimmed)) &&
    isErrorProcessLine(trimmed) &&
    !isMarkdownListLikeLine(trimmed)
  ) {
    return { kind: "error", text: trimmed };
  }

  if (isCollapsedOutputSummaryDisplayLine(trimmed)) {
    return { kind: "summary", text: trimmed };
  }

  if (isProcessSection && /^(✓|✔|\[ok\]|\[done\])|\b(passed|success|succeeded|complete)\b/i.test(trimmed)) {
    return { kind: "success", text: trimmed };
  }

  return { kind: "content", text: stripInlineMarkdown(decodedLine) };
}

function isErrorProcessLine(line: string): boolean {
  return /\b(error|failed|failure|exception|traceback)\b/i.test(line);
}

function isExplicitErrorLine(line: string): boolean {
  return /^(?:ERROR|Error|error|Traceback|Exception|Failed|failed|Failure|failure)\b/.test(line);
}

function workerSectionHeadingText(line: string): string | null {
  const normalized = line.replace(/[:：]$/, "").trim();
  if (!normalized) {
    return null;
  }

  if (WORKER_SECTION_HEADINGS.has(normalized.toLowerCase())) {
    return normalized;
  }

  if (/^任务\s*\d+\s*[：:]\s*\S+/.test(normalized)) {
    return normalized;
  }

  return null;
}

function isShellCodeFenceLanguage(language: string): boolean {
  return language === "bash" || language === "sh" || language === "shell" || language === "zsh";
}

function shellCodeFenceCommandLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.startsWith("$") ? trimmed : `$ ${trimmed}`;
}

const WORKER_SECTION_HEADINGS = new Set([
  "acceptance",
  "artifacts",
  "blocking findings",
  "change made",
  "code quality",
  "critic findings",
  "dev server / browser check",
  "evidence",
  "feature",
  "files changed",
  "files changed in this turn",
  "final verification commands run after implementation",
  "findings",
  "judge files read",
  "non-blocking findings",
  "open questions",
  "observed expected red state",
  "project files reviewed",
  "recommendation",
  "residual risk",
  "review",
  "risks",
  "summary",
  "task",
  "tdd note",
  "tdd record",
  "tdd/verification",
  "test coverage",
  "user request",
  "verification",
  "verdict",
  "where things are written",
  "ui 验收",
  "ui/体验需求",
  "不可接受情况",
  "代码质量验收",
  "功能需求",
  "功能验收",
  "技术约束",
  "架构原则",
  "目标",
  "必须通过的命令",
  "输入需求",
  "输入验收",
  "现有项目上下文",
  "用户目标",
  "验收标准",
  "非目标"
]);

function isMarkdownListLikeLine(line: string): boolean {
  return /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
}

function isCodeLikeProcessLine(line: string): boolean {
  return (
    /^<![A-Za-z][\s\S]*>?$/i.test(line) ||
    /^<\/?[A-Za-z][\s\S]*>?$/.test(line) ||
    /^>\s*<\/?[A-Za-z][\s\S]*>?$/.test(line) ||
    /^[A-Za-z_:][-A-Za-z0-9_:.]*=(?:"[^"]*"|'[^']*'|[^\s>]+),?$/.test(line) ||
    /^[.#]?[A-Za-z0-9_-]+\s*\{/.test(line) ||
    /^[A-Za-z-]+\s*:\s*.+;?$/.test(line) ||
    line === "}" ||
    line.startsWith("</")
  );
}

function isMarkdownTableSeparator(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableRow(line: string): boolean {
  return line.startsWith("|") && line.endsWith("|") && line.split("|").length > 2;
}

function collectMarkdownTableBlock(rawLines: string[], startIndex: number): { lines: RenderLine[]; nextIndex: number } | null {
  const rows: string[][] = [];
  let index = startIndex;
  let consumed = false;

  while (index < rawLines.length) {
    const line = stripAnsi(rawLines[index] ?? "").replace(/\r/g, "").trim();
    if (!line) {
      break;
    }
    if (isMarkdownTableSeparator(line)) {
      consumed = true;
      index += 1;
      continue;
    }
    if (!isMarkdownTableRow(line)) {
      break;
    }
    const row = parseMarkdownTableRow(line);
    if (row.length > 0) {
      rows.push(row);
    }
    consumed = true;
    index += 1;
  }

  if (!consumed) {
    return null;
  }
  return {
    lines: renderMarkdownTableRows(rows),
    nextIndex: index
  };
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .split("|")
    .map((cell) => stripInlineMarkdown(cell.trim()))
    .filter(Boolean);
}

function renderMarkdownTableRows(rows: string[][]): RenderLine[] {
  if (rows.length === 0) {
    return [];
  }
  const columnWidths = markdownTableColumnWidths(rows);
  return rows.map((row) => ({
    kind: "table",
    text: row
      .map((cell, index) =>
        index === row.length - 1
          ? cell
          : `${cell}${" ".repeat(Math.max(0, (columnWidths[index] ?? 0) - displayWidth(cell)))}`
      )
      .join("  ")
  }));
}

function markdownTableColumnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, displayWidth(cell));
    });
  }
  return widths;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, target: string) => formatMarkdownLink(label, target))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}

function formatMarkdownLink(label: string, target: string): string {
  const text = stripInlineMarkdownLinkText(label);
  const href = target.trim();
  if (!href) {
    return text;
  }
  return isExternalMarkdownLinkTarget(href) ? `${text} <${href}>` : text;
}

function stripInlineMarkdownLinkText(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}

function isExternalMarkdownLinkTarget(target: string): boolean {
  return /^(?:https?:|mailto:)/i.test(target);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&larr;/g, "←")
    .replace(/&rarr;/g, "→")
    .replace(/&uarr;/g, "↑")
    .replace(/&darr;/g, "↓")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function renderJsonLine(line: string): RenderLine[] {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const summary = summarizeJsonRecord(value);
    return [
      {
        kind: "json",
        text: summary.meta
      },
      ...summary.messages.map((message) => ({ kind: "json-message" as const, text: message }))
    ];
  } catch {
    return [{ kind: "content", text: line }];
  }
}

function summarizeJsonRecord(value: Record<string, unknown>): { meta: string; messages: string[] } {
  const state = stringField(value, "status") || stringField(value, "severity");
  const id = stringField(value, "id") || stringField(value, "finding_id") || stringField(value, "findingId");
  const to = stringField(value, "to");
  const from = stringField(value, "from");
  const direction = from && to ? `${from} -> ${to}` : to ? `to ${to}` : from ? `from ${from}` : "";
  const file = stringField(value, "file") || stringField(value, "path");
  const line = numberLikeField(value, "line");
  const column = numberLikeField(value, "column") || numberLikeField(value, "col");
  const location = formatJsonRecordLocation(file, line, column);
  const messages = jsonRecordMessages(value);
  const marker = state ? `[${state}]` : "";
  const lead = [marker, id].filter(Boolean).join(" ");
  const details = [direction, location].filter(Boolean);
  const meta = id
    ? [lead, ...details].filter(Boolean).join(" · ")
    : [lead, ...details].filter(Boolean).join(" ");
  return {
    meta: meta || "json",
    messages: messages.length > 0 ? messages : [JSON.stringify(value)]
  };
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function jsonRecordMessages(value: Record<string, unknown>): string[] {
  const primary = stringField(value, "message") || stringField(value, "summary");
  if (primary) {
    return [primary];
  }
  return [
    ...textFragmentsField(value, "title"),
    ...textFragmentsField(value, "detail").map((text) => `detail · ${text}`),
    ...textFragmentsField(value, "details").map((text) => `detail · ${text}`),
    ...textFragmentsField(value, "recommendation").map((text) => `fix · ${text}`)
  ].filter(uniqueTextFragmentFilter());
}

function textFragmentsField(value: Record<string, unknown>, key: string): string[] {
  return textFragmentsValue(value[key]);
}

function textFragmentsValue(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => textFragmentsValue(item));
  }
  return [];
}

function uniqueTextFragmentFilter(): (value: string) => boolean {
  const seen = new Set<string>();
  return (value: string) => {
    const normalized = value.toLowerCase();
    if (!value || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  };
}

function numberLikeField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field === "number" && Number.isFinite(field)) {
    return String(field);
  }
  if (typeof field !== "string") {
    return "";
  }
  const trimmed = field.trim();
  return /^\d+$/.test(trimmed) ? trimmed : "";
}

function formatJsonRecordLocation(file: string, line: string, column: string): string {
  if (!file) {
    return "";
  }
  if (!line) {
    return file;
  }
  return column ? `${file}:${line}:${column}` : `${file}:${line}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function stripAnsiForDiff(value: string): string {
  return stripAnsi(value).replace(/\r$/, "");
}

function groupTitle(group: WorkerOutputSection["group"]): string {
  if (group === "role") {
    return "artifacts";
  }
  if (group === "feature") {
    return "mailbox";
  }
  return "process";
}

export function workerOutputLineTheme(kind: WorkerOutputLineKind): WorkerOutputLineTheme {
  if (kind === "group") {
    return { backgroundColor: TUI_THEME.chrome, bold: true, color: TUI_THEME.text };
  }
  if (kind === "section") {
    return { backgroundColor: TUI_THEME.rail, color: TUI_THEME.warning };
  }
  if (kind === "content" || kind === "list" || kind === "list-detail" || kind === "ordered-list" || kind === "task") {
    return { backgroundColor: TUI_THEME.surface, color: TUI_THEME.text };
  }
  if (kind === "placeholder") {
    return workerOutputEmptyFallbackTheme();
  }
  if (kind === "heading") {
    return { backgroundColor: TUI_THEME.surface, bold: true, color: TUI_THEME.text };
  }
  if (kind === "quote") {
    return { backgroundColor: TUI_THEME.surface, color: TUI_THEME.muted };
  }
  if (kind === "table") {
    return { backgroundColor: TUI_THEME.rail, color: TUI_THEME.text };
  }
  if (kind === "rule") {
    return { backgroundColor: TUI_THEME.surface, color: TUI_THEME.muted, dimColor: true };
  }
  if (kind === "blank") {
    return { backgroundColor: TUI_THEME.surface };
  }
  if (kind === "code") {
    return { backgroundColor: TUI_THEME.rail, color: TUI_THEME.muted };
  }
  if (kind === "source-line") {
    return { backgroundColor: TUI_THEME.surface, color: TUI_THEME.text };
  }
  if (kind === "summary") {
    return { backgroundColor: TUI_THEME.rail, color: TUI_THEME.muted };
  }
  if (kind === "json") {
    return { backgroundColor: TUI_THEME.rail, color: TUI_THEME.accent };
  }
  if (kind === "json-message") {
    return { backgroundColor: TUI_THEME.surface };
  }
  if (kind === "command") {
    return { backgroundColor: TUI_THEME.chrome, color: TUI_THEME.accent };
  }
  if (kind === "success") {
    return { backgroundColor: TUI_THEME.successSurface, color: TUI_THEME.success };
  }
  if (kind === "error") {
    return { backgroundColor: TUI_THEME.dangerSurface, color: TUI_THEME.danger };
  }
  if (kind === "diff-file") {
    return { backgroundColor: TUI_THEME.surface, bold: true, color: TUI_THEME.accent };
  }
  if (kind === "diff-summary") {
    return { backgroundColor: TUI_THEME.surface, color: TUI_THEME.text };
  }
  if (kind === "diff-hunk" || kind === "diff-meta") {
    return { backgroundColor: TUI_THEME.rail, color: TUI_THEME.muted };
  }
  if (kind === "diff-add") {
    return { backgroundColor: TUI_THEME.successSurface, color: TUI_THEME.success };
  }
  if (kind === "diff-remove") {
    return { backgroundColor: TUI_THEME.dangerSurface, color: TUI_THEME.danger };
  }
  if (kind === "diff-context") {
    return { backgroundColor: TUI_THEME.surface, color: TUI_THEME.muted };
  }
  return {};
}

export function workerOutputEmptyFallbackTheme(): WorkerOutputLineTheme {
  return {
    backgroundColor: TUI_THEME.surface,
    color: TUI_THEME.muted,
    dimColor: true
  };
}

export function workerOutputLineFillTheme(kind: WorkerOutputLineKind): NonNullable<TextProps["backgroundColor"]> | null {
  const backgroundColor = workerOutputLineTheme(kind).backgroundColor;
  return backgroundColor ?? null;
}

export function workerOutputLineLayout(kind: WorkerOutputLineKind, text: string): { gutter: string; body: string } {
  if (kind === "section") {
    return { gutter: "", body: joinWorkerOutputChromeParts([workerSectionLabel(text), formatWorkerSectionTitle(text)]) };
  }
  if (kind === "content" || kind === "placeholder") {
    return { gutter: "", body: formatPlainDisplayText(text) };
  }
  if (kind === "heading") {
    return { gutter: "", body: text };
  }
  if (kind === "list") {
    return { gutter: "", body: `• ${formatPlainDisplayText(text)}` };
  }
  if (kind === "list-detail") {
    return { gutter: "", body: `  ${formatPlainDisplayText(text)}` };
  }
  if (kind === "ordered-list" || kind === "task") {
    return { gutter: "", body: text };
  }
  if (kind === "quote") {
    return { gutter: "", body: `│ ${text}` };
  }
  if (kind === "table" || kind === "rule") {
    return { gutter: "", body: text };
  }
  if (kind === "code") {
    return { gutter: "", body: `| ${text}` };
  }
  if (kind === "source-line") {
    return { gutter: "", body: text };
  }
  if (kind === "summary") {
    return { gutter: "", body: `· ${formatSummaryDisplayText(text)}` };
  }
  if (kind === "json") {
    return { gutter: "", body: text };
  }
  if (kind === "json-message") {
    return { gutter: "", body: text };
  }
  if (kind === "command") {
    return { gutter: "", body: formatCommandDisplayText(text) };
  }
  if (kind === "success") {
    return { gutter: "", body: `· ${formatSuccessDisplayText(text)}` };
  }
  if (kind === "error") {
    return { gutter: "", body: formatErrorDisplayText(text) };
  }
  if (kind === "diff-file") {
    return { gutter: "", body: `● ${text}` };
  }
  if (kind === "diff-summary") {
    return { gutter: "", body: `└ ${text}` };
  }
  if (kind === "diff-hunk") {
    return { gutter: "", body: `hunk ${text}` };
  }
  if (kind === "diff-context") {
    return { gutter: "", body: text };
  }
  if (kind === "diff-meta") {
    return { gutter: "", body: `meta ${text}` };
  }
  if (kind === "diff-add") {
    return { gutter: "", body: text };
  }
  if (kind === "diff-remove") {
    return { gutter: "", body: text };
  }
  return { gutter: "", body: text };
}

function formatWorkerSectionTitle(title: string): string {
  const featureMatch = title.match(/^features\/([^/]+)\/([^/]+)$/);
  const turn = featureMatch?.[1] ?? "";
  const file = (featureMatch?.[2] ?? basename(title)).toLowerCase();
  if (turn && isTurnScopedWorkerArtifact(file)) {
    return turn;
  }
  if (file === "requirements.md" || file === "plan.md" || file === "acceptance.md" || file === "worklog.md") {
    return "";
  }
  if (file === "patch.diff") {
    return "patch";
  }
  return title.replace(/^features\//, "");
}

function workerSectionLabel(title: string): string {
  const file = basename(title).toLowerCase();
  if (file === "requirements.md") {
    return "requirements";
  }
  if (file === "plan.md") {
    return "plan";
  }
  if (file === "acceptance.md") {
    return "acceptance";
  }
  if (file === "actor-worklog.md" || file === "worklog.md") {
    return "worklog";
  }
  if (file === "decisions.md") {
    return "decision";
  }
  if (file.endsWith(".diff")) {
    return "diff";
  }
  if (file === "actor-replies.jsonl") {
    return "mail";
  }
  if (file === "critic-findings.jsonl") {
    return "findings";
  }
  if (file.endsWith(".jsonl")) {
    return "jsonl";
  }
  return "file";
}

function isTurnScopedWorkerArtifact(file: string): boolean {
  return file === "actor-worklog.md" ||
    file === "decisions.md" ||
    file === "actor-replies.jsonl" ||
    file === "critic-findings.jsonl";
}

function formatSummaryDisplayText(text: string): string {
  const readRun = text.match(/^Collapsed read summaries: (\d+) chunks, (\d+) lines(?: \((.+)\))?$/i);
  if (readRun) {
    return [
      `read ${readRun[1] ?? "0"} chunks`,
      `${readRun[2] ?? "0"} lines`,
      readRun[3] ?? ""
    ].filter(Boolean).join(" · ");
  }

  const nodeTests = text.match(/^Node tests passed: (\d+)\/(\d+)(?:, (\d+) skipped)?(?: in (.+))?$/i);
  if (nodeTests) {
    return [
      nodeTests[1] === nodeTests[2]
        ? `tests ${nodeTests[1] ?? "0"} passed`
        : `tests ${nodeTests[1] ?? "0"}/${nodeTests[2] ?? "0"} passed`,
      nodeTests[3] ? `${nodeTests[3]} skipped` : "",
      nodeTests[4] ?? ""
    ].filter(Boolean).join(" · ");
  }

  const collapsedDiff = text.match(/^Collapsed diff: (\d+) files?, added (\d+) lines?, removed (\d+) lines?(?: \((.+)\))?$/i);
  if (collapsedDiff) {
    return [
      `diff ${collapsedDiff[1] ?? "0"} ${Number(collapsedDiff[1] ?? 0) === 1 ? "file" : "files"}`,
      Number(collapsedDiff[2] ?? 0) > 0 ? `+${collapsedDiff[2] ?? "0"}` : "",
      Number(collapsedDiff[3] ?? 0) > 0 ? `-${collapsedDiff[3] ?? "0"}` : "",
      collapsedDiff[4] ?? ""
    ].filter(Boolean).join(" · ");
  }

  const devFallback = text.match(/^Dev server fallback:\s*(.+)$/i);
  if (devFallback) {
    return ["dev server unavailable", "built dist fallback", devFallback[1] ?? ""].filter(Boolean).join(" · ");
  }

  const match = text.match(/^((?:succeeded|failed|exited\s+\d+)\s+in\s+\d+(?:ms|s|m)?):?\s+(Collapsed (?:code|file list|source) output: \d+ (?:lines|paths))(?:\s+\((\$ .+)\))?$/i);
  if (match) {
    const readSummary = match[3] ? formatReadSummary(match[3], match[2] ?? "", match[1] ?? "") : null;
    if (readSummary) {
      return readSummary;
    }
    return [
      formatSummaryStatus(match[1] ?? ""),
      formatCollapsedSummary(match[2] ?? ""),
      match[3] ? formatSummaryCommand(match[3]) : ""
    ].filter(Boolean).join(" · ");
  }

  if (isProcessStatusLine(text.trim())) {
    return formatSummaryStatus(text.replace(/:$/, ""));
  }

  const buildOutput = text.match(/^((?:succeeded|failed|exited\s+\d+)\s+in\s+\d+(?:ms|s|m)?):?\s+\((\$ .+)\)\s+Build output:\s*(.+)$/i);
  if (buildOutput) {
    return [
      formatSummaryStatus(buildOutput[1] ?? ""),
      formatSummaryCommand(buildOutput[2] ?? ""),
      `built ${formatBuildOutputTarget(buildOutput[3] ?? "")}`.trim()
    ].filter(Boolean).join(" · ");
  }

  const statusCommand = text.match(/^((?:succeeded|failed|exited\s+\d+)\s+in\s+\d+(?:ms|s|m)?):?\s+\((\$ .+)\)$/i);
  if (statusCommand) {
    return [
      formatSummaryStatus(statusCommand[1] ?? ""),
      formatSummaryCommand(statusCommand[2] ?? "")
    ].filter(Boolean).join(" · ");
  }

  const noMatches = text.match(/^No matches in (\d+(?:ms|s|m)?)(?:\s+\((\$ .+)\))?$/i);
  if (noMatches) {
    return [
      `no matches ${noMatches[1] ?? ""}`.trim(),
      noMatches[2] ? formatNoMatchSearchTarget(noMatches[2]) : ""
    ].filter(Boolean).join(" · ");
  }

  return text;
}

function formatErrorDisplayText(text: string): string {
  const message = text.replace(/^(?:ERROR|Error|error):\s*/, "").trim();
  if (/Codex ran out of room\b.*context window/i.test(message)) {
    return "error · Codex context window full · start a new thread or clear history";
  }
  return `error · ${message || text}`;
}

function formatSuccessDisplayText(text: string): string {
  const smokeWithDuration = text.match(/^Smoke test passed in (\d+(?:ms|s|m)?):?\s*(.*)$/i);
  if (smokeWithDuration) {
    const detail = compactSmokeSuccessDetail(smokeWithDuration[2]?.trim() ?? "");
    return [
      "smoke passed",
      smokeWithDuration[1] ?? "",
      detail
    ].filter(Boolean).join(" · ");
  }

  const smoke = text.match(/^Smoke test passed:?\s*(.*)$/i);
  if (smoke) {
    return ["smoke passed", compactSmokeSuccessDetail(smoke[1]?.trim() ?? "")].filter(Boolean).join(" · ");
  }
  return text;
}

function compactSmokeSuccessDetail(detail: string): string {
  return /\bDOM\/canvas\b/i.test(detail) ? "DOM/canvas ok" : detail;
}

function formatReadSummary(command: string, summary: string, status: string): string | null {
  const readTarget = readTargetFromCommand(command);
  if (!readTarget) {
    return null;
  }

  const parts = [
    isOkSummaryStatus(status) ? "" : formatSummaryStatus(status),
    formatReadTarget(readTarget),
    formatCollapsedReadSummary(summary)
  ].filter(Boolean);
  return parts.join(" · ");
}

function formatReadTarget(target: string): string {
  return target
    .replace(/^src\//, "")
    .replace(/^\.\/src\//, "");
}

function readTargetFromCommand(command: string): string | null {
  const sed = command.match(/^\$\s+sed\s+-n\s+'(\d+),(\d+)p'\s+(.+)$/);
  if (sed) {
    return `${sed[3] ?? ""}:${sed[1] ?? ""}-${sed[2] ?? ""}`;
  }

  const chainedSed = command.match(/^\$\s+.+?\s+&&\s+sed\s+-n\s+'(\d+),(\d+)p'\s+(.+)$/);
  if (chainedSed) {
    return `${chainedSed[3] ?? ""}:${chainedSed[1] ?? ""}-${chainedSed[2] ?? ""}`;
  }

  const nlSed = command.match(/^\$\s+nl\s+-ba\s+(\S+)\s+\|\s+sed\s+-n\s+'(\d+),(\d+)p'$/);
  if (nlSed) {
    return `${nlSed[1] ?? ""}:${nlSed[2] ?? ""}-${nlSed[3] ?? ""}`;
  }

  return null;
}

function formatCollapsedReadSummary(summary: string): string {
  const match = summary.match(/^Collapsed (code|file list|source) output: (\d+) (lines|paths)$/i);
  if (!match) {
    return summary;
  }

  const kind = (match[1] ?? "").toLowerCase() === "file list" ? "files" : (match[1] ?? "").toLowerCase();
  return `${match[2] ?? "0"} ${kind}`.trim();
}

function isOkSummaryStatus(status: string): boolean {
  return /^succeeded\s+in\s+\d+(?:ms|s|m)?$/i.test(status.replace(/:$/, ""));
}

function formatCollapsedSummary(summary: string): string {
  const match = summary.match(/^Collapsed (code|file list|source) output: (\d+) (lines|paths)$/i);
  if (!match) {
    return summary;
  }

  const kind = (match[1] ?? "").toLowerCase() === "file list" ? "files" : (match[1] ?? "").toLowerCase();
  return `${kind} ${match[2] ?? "0"} ${match[3] ?? ""}`.trim();
}

function formatSummaryStatus(status: string): string {
  const succeeded = status.match(/^succeeded\s+in\s+(.+)$/i);
  if (succeeded) {
    return `ok ${succeeded[1] ?? ""}`.trim();
  }
  const failed = status.match(/^failed\s+in\s+(.+)$/i);
  if (failed) {
    return `fail ${failed[1] ?? ""}`.trim();
  }
  const exited = status.match(/^exited\s+(\d+)\s+in\s+(.+)$/i);
  if (exited) {
    return `exit ${exited[1] ?? ""} ${exited[2] ?? ""}`.trim();
  }
  return status;
}

function formatBuildOutputTarget(target: string): string {
  return target.trim().replace(/\/$/, "");
}

function formatSummaryCommand(command: string): string {
  const readTarget = readTargetFromCommand(command);
  if (readTarget) {
    return formatReadTarget(readTarget);
  }

  if (/^\$\s+pwd\s+&&\s+rg\s+--files\b/.test(command)) {
    return "$ rg --files";
  }

  return command;
}

function formatNoMatchSearchTarget(command: string): string {
  if (/^\$\s+rg\s+TODO markers\b/i.test(command)) {
    return "TODO markers";
  }

  const markerScan = command.match(/^\$\s+rg\s+(?:-[\w-]+\s+)*"([^"]+)"\s+.+$/i);
  if (markerScan && /\b(?:TBD|TODO)\b|占位|待定/i.test(markerScan[1] ?? "")) {
    return "TODO markers";
  }

  const todoScan = command.match(/^\$\s+rg\s+TODO\s+(.+)$/i);
  if (todoScan) {
    return `TODO ${formatCommandPath(todoScan[1] ?? "")}`.trim();
  }

  const query = command.match(/^\$\s+(?:rg|grep|git\s+grep)\s+(.+)$/i);
  return query ? `search ${compactEndByDisplayWidth(query[1] ?? "", 32)}` : command;
}

function formatCommandDisplayText(text: string): string {
  const todoScan = text.match(/^\$\s+rg\s+-n\s+"TBD\|TODO\|implement later\|fill in\|占位\|待定"\s+(.+)$/);
  if (todoScan) {
    return `$ rg TODO markers ${formatCommandPath(todoScan[1] ?? "")}`;
  }

  return text.replace(/(?:^|\s)(\S*\.parallel-codex\/sessions\/task-\d{8}-\d{6}-\d+\/\S+)/g, (match, path: string) => {
    const prefix = match.startsWith(" ") ? " " : "";
    return `${prefix}${formatCommandPath(path)}`;
  });
}

function formatCommandPath(path: string): string {
  return path
    .replace(/.*\.parallel-codex\/sessions\/task-\d{8}-\d{6}-\d+\//, ".parallel-codex/<task>/")
    .replace(/\.parallel-codex\/<task>\/(?:[^/\s]+\/)*([^/\s]+\/\*\.md)$/, "$1");
}

function formatPlainDisplayText(text: string): string {
  return text
    .replace(/\bfile:\/\/\/\S+/g, (url) => formatFileUrlDisplay(url))
    .replace(/\bFeature mailbox features\/(\d{4}\/[A-Za-z0-9._@+-]+)\b/g, "mailbox $1")
    .replace(/\bfeatures\/(\d{4}\/[A-Za-z0-9._@+-]+)\b/g, "$1");
}

function formatFileUrlDisplay(url: string): string {
  const path = url.replace(/^file:\/\//, "");
  const distMatch = path.match(/\/(dist\/\S+)$/);
  if (distMatch) {
    return distMatch[1] ?? url;
  }

  const segments = path.split("/").filter(Boolean);
  return segments.slice(-2).join("/") || url;
}

function WorkerOutputLine({ line, width }: { line: DisplayLine; width: number }) {
  const theme = workerOutputLineTheme(line.kind);
  const fillBackground = workerOutputLineFillTheme(line.kind);
  if (line.kind === "blank") {
    return <WorkerOutputBlankLine width={width} />;
  }
  if (line.kind === "group") {
    const body = ` ${line.text} `;
    return (
      <Box>
        <Text {...theme}>{body}</Text>
        <WorkerOutputTrailingFill backgroundColor={fillBackground} width={width} usedWidth={displayWidth(body)} />
      </Box>
    );
  }

  if (line.preformatted) {
    const body = line.text || " ";
    return (
      <Box>
        <WorkerOutputIndent backgroundColor={fillBackground} />
        <Text {...theme} wrap="truncate-end">{body}</Text>
        <WorkerOutputTrailingFill backgroundColor={fillBackground} width={width} usedWidth={2 + displayWidth(body)} />
      </Box>
    );
  }

  const layout = workerOutputLineLayout(line.kind, line.text);
  if (line.kind === "code") {
    return (
      <Box>
        <WorkerOutputIndent backgroundColor={fillBackground} />
        <Text {...theme} wrap="wrap">{line.text || " "}</Text>
        <WorkerOutputTrailingFill backgroundColor={fillBackground} width={width} usedWidth={2 + displayWidth(line.text || " ")} />
      </Box>
    );
  }

  if (line.kind === "source-line") {
    const sourceParts = sourceDisplayLineParts(line.text);
    if (sourceParts) {
      const usedWidth = 2 + displayWidth(sourceParts.gutter) + displayWidth(sourceParts.code || " ");
      return (
        <Box>
          <WorkerOutputIndent backgroundColor={fillBackground} />
          <Text backgroundColor={TUI_THEME.surface} color={TUI_THEME.muted}>{sourceParts.gutter}</Text>
          <Text backgroundColor={TUI_THEME.surface} color={TUI_THEME.text} wrap="truncate-end">{sourceParts.code}</Text>
          <WorkerOutputTrailingFill backgroundColor={fillBackground} width={width} usedWidth={usedWidth} />
        </Box>
      );
    }
    const body = line.text || " ";
    return (
      <Box>
        <WorkerOutputIndent backgroundColor={fillBackground} />
        <Text {...theme}>{body}</Text>
        <WorkerOutputTrailingFill backgroundColor={fillBackground} width={width} usedWidth={2 + displayWidth(body)} />
      </Box>
    );
  }

  if (line.continuation && isDiffCodeKind(line.kind)) {
    const body = line.text || " ";
    return (
      <Box>
        <WorkerOutputIndent backgroundColor={fillBackground} />
        <Text {...theme} wrap="truncate-end">{body}</Text>
        <WorkerOutputTrailingFill backgroundColor={fillBackground} width={width} usedWidth={2 + displayWidth(body)} />
      </Box>
    );
  }

  const diffCodeLine = diffCodeLineParts(line);
  if (diffCodeLine) {
    const prefix = `${diffCodeLine.lineNumber} ${diffCodeLine.sign} `;
    const code = diffCodeLine.code || " ";
    return (
      <Box>
        <WorkerOutputIndent backgroundColor={fillBackground} />
        <Text {...theme}>{prefix}</Text>
        <Text {...theme} wrap="wrap">{code}</Text>
        <WorkerOutputTrailingFill backgroundColor={fillBackground} width={width} usedWidth={2 + displayWidth(prefix) + displayWidth(code)} />
      </Box>
    );
  }

  const gutter = layout.gutter ? formatGutter(layout.gutter) : "";
  const body = layout.body || " ";
  return (
    <Box>
      <WorkerOutputIndent backgroundColor={fillBackground} />
      {gutter ? <Text {...theme}>{gutter}</Text> : null}
      <Text {...theme} wrap="truncate-end">{body}</Text>
      <WorkerOutputTrailingFill backgroundColor={fillBackground} width={width} usedWidth={2 + displayWidth(gutter) + displayWidth(body)} />
    </Box>
  );
}

function WorkerOutputIndent({ backgroundColor }: { backgroundColor: NonNullable<TextProps["backgroundColor"]> | null }) {
  return backgroundColor
    ? <Text backgroundColor={backgroundColor}>  </Text>
    : <Text color={TUI_THEME.muted} dimColor>  </Text>;
}

function WorkerOutputBlankLine({ width }: { width: number }) {
  const theme = workerOutputLineTheme("blank");
  const fillWidth = shouldRenderWorkerOutputRailFill() ? Math.max(1, width) : 1;
  return <Text {...theme}>{" ".repeat(fillWidth)}</Text>;
}

function WorkerOutputTrailingFill({
  backgroundColor,
  usedWidth,
  width
}: {
  backgroundColor: NonNullable<TextProps["backgroundColor"]> | null;
  usedWidth: number;
  width: number;
}) {
  if (!backgroundColor || !shouldRenderWorkerOutputRailFill()) {
    return null;
  }
  const fillWidth = Math.max(0, width - usedWidth);
  return fillWidth > 0 ? <Text backgroundColor={backgroundColor}>{" ".repeat(fillWidth)}</Text> : null;
}

function shouldRenderWorkerOutputRailFill(): boolean {
  return process.stdout.isTTY === true && typeof process.stdout.columns === "number";
}

function WorkerOutputNanoLine({ fillWidth, line, width }: { fillWidth: number; line: DisplayLine; width: number }) {
  const theme = workerOutputLineTheme(line.kind);
  const fillBackground = workerOutputLineFillTheme(line.kind);
  const text = compactEndByDisplayWidth(workerOutputNanoLineText(line), Math.max(1, width));
  const body = text || " ";
  return (
    <Box>
      <Text {...theme} wrap="truncate-end">{body}</Text>
      <WorkerOutputTrailingFill backgroundColor={fillBackground} width={fillWidth} usedWidth={displayWidth(body)} />
    </Box>
  );
}

function workerOutputNanoLineText(line: DisplayLine): string {
  if (line.kind === "blank") {
    return "";
  }
  if (line.kind === "group") {
    return line.text;
  }
  if (line.preformatted) {
    return line.text;
  }
  return workerOutputLineLayout(line.kind, line.text).body;
}

function sourceDisplayLineParts(text: string): { gutter: string; code: string } | null {
  const numbered = text.match(/^(\s*\d+)(\s{2})(.*)$/);
  if (numbered) {
    return {
      gutter: `${numbered[1] ?? ""}${numbered[2] ?? ""}`,
      code: numbered[3] ?? ""
    };
  }

  const blankNumbered = text.match(/^(\s*\d+)$/);
  if (blankNumbered) {
    return {
      gutter: `${blankNumbered[1] ?? ""}  `,
      code: ""
    };
  }

  const continuation = text.match(/^(\s{6,})(.*)$/);
  return continuation
    ? {
      gutter: continuation[1] ?? "",
      code: continuation[2] ?? ""
    }
    : null;
}

function diffCodeLineParts(line: RenderLine): WorkerOutputDiffColumns | null {
  if (line.kind !== "diff-add" && line.kind !== "diff-remove" && line.kind !== "diff-context") {
    return null;
  }
  return workerOutputDiffColumns(line.text);
}

export function workerOutputDiffColumns(text: string): WorkerOutputDiffColumns | null {
  const match = text.match(/^(\s*\d+)\s([+\- ])\s(.*)$/);
  if (!match) {
    return null;
  }
  const sign = match[2];
  if (sign !== "+" && sign !== "-" && sign !== " ") {
    return null;
  }
  return {
    lineNumber: match[1] ?? "",
    sign,
    code: match[3] ?? ""
  };
}

function renderDisplayLines(
  lines: RenderLine[],
  width = Number(process.stdout.columns) || 120,
  options: { contentWidth?: number; nano?: boolean } = {}
): DisplayLine[] {
  const contentWidth = options.contentWidth ?? Math.max(1, width - 4);
  if (options.nano ?? isNanoWorkerOutputWidth(width)) {
    return renderNanoDisplayLines(lines, contentWidth);
  }
  return lines.flatMap((line) => {
    if (line.kind === "blank" || line.kind === "group") {
      return [line];
    }
    if (line.kind === "source-line") {
      return workerOutputSourceDisplayLines(line.text, contentWidth).map((text, index) => ({
        kind: line.kind,
        text,
        continuation: index > 0
      }));
    }
    if (line.kind === "code") {
      return workerOutputCodeDisplayLines(line.text, contentWidth).map((text, index) => ({
        kind: line.kind,
        text,
        continuation: index > 0
      }));
    }
    if (isDiffCodeKind(line.kind)) {
      return workerOutputDiffDisplayLines(line.text, contentWidth).map((text, index) => ({
        kind: line.kind,
        text,
        continuation: index > 0
      }));
    }
    return workerOutputBodyDisplayLines(line.kind, line.text, contentWidth).map((text, index) => ({
      kind: line.kind,
      text,
      continuation: index > 0,
      preformatted: true
    }));
  });
}

function renderNanoDisplayLines(lines: RenderLine[], contentWidth: number): DisplayLine[] {
  const displayLines: DisplayLine[] = [];
  const sourceLines = tinyWorkerOutputSourceLines(lines, 8);
  for (const line of sourceLines) {
    if (line.kind === "blank" || line.kind === "group") {
      pushNanoDisplayLine(displayLines, line);
      continue;
    }
    if (line.kind === "source-line" || line.kind === "code") {
      continue;
    }
    const texts = workerOutputBodyDisplayLines(line.kind, line.text, contentWidth).slice(0, 2);
    for (const text of texts) {
      pushNanoDisplayLine(displayLines, {
        kind: line.kind,
        text,
        preformatted: true
      });
    }
  }
  return displayLines.length > 0 ? displayLines : [{ kind: "content", text: "empty", preformatted: true }];
}

function pushNanoDisplayLine(displayLines: DisplayLine[], line: DisplayLine): void {
  const previous = displayLines[displayLines.length - 1];
  if (previous?.kind === line.kind && previous.text === line.text) {
    return;
  }
  displayLines.push(line);
}

export function workerOutputBodyDisplayLines(kind: WorkerOutputLineKind, text: string, width: number): string[] {
  const layout = workerOutputLineLayout(kind, text);
  const rawBody = `${layout.gutter ? formatGutter(layout.gutter) : ""}${layout.body}`;
  const body = compactWorkerBodyForWidth(kind, rawBody, Math.max(1, width));
  const continuationPrefix = workerOutputContinuationPrefix(kind, body);
  return wrapBodyWithContinuation(body, Math.max(1, width), continuationPrefix);
}

function compactWorkerBodyForWidth(kind: WorkerOutputLineKind, body: string, width: number): string {
  if (kind === "summary") {
    return compactSummaryBodyForWidth(body, width);
  }
  if (kind === "success") {
    return compactSuccessBodyForWidth(body, width);
  }
  if (kind === "error" && /Codex context window full/i.test(body)) {
    return compactContextWindowErrorForWidth(body, width);
  }
  if (
    (kind === "content" || kind === "list" || kind === "list-detail" || kind === "quote" || kind === "ordered-list" || kind === "task") &&
    /^Verification:\s+/i.test(body)
  ) {
    return compactVerificationBodyForWidth(body, width);
  }
  if (kind === "heading" && /^Critic Findings$/i.test(body) && width < 16) {
    return width < 8 ? "Find" : "Findings";
  }
  if (kind === "content" && /^Summary:\s*done$/i.test(body) && width < 14) {
    return "Done";
  }
  if (kind === "content" && /^Review:\s*approved$/i.test(body) && width < 16) {
    return "Approved";
  }
  if (kind === "content" && /^Blocking:\s*none$/i.test(body) && width < 44) {
    return compactBlockingNoneForWidth(width);
  }
  if (kind === "content" && /^Findings:\s*none$/i.test(body) && width < 44) {
    return compactFindingsNoneForWidth(width);
  }
  if (kind === "content" && /^No active Critic findings were present for this feature;/.test(body)) {
    return width < 12 ? "None." : "No findings.";
  }
  if (
    width < 40 &&
    displayWidth(body) > width &&
    (kind === "content" || kind === "list" || kind === "list-detail" || kind === "quote" || kind === "ordered-list" || kind === "task")
  ) {
    return compactNarrowWorkerBody(body, width);
  }
  return body;
}

function compactContextWindowErrorForWidth(body: string, width: number): string {
  if (width < 7) {
    return "ctx";
  }
  if (width < 10) {
    return "err ctx";
  }
  if (width < 14) {
    return "err · ctx";
  }
  if (width < 18) {
    return "err · ctx full";
  }
  if (width < 26) {
    return "err · ctx full · start new thread";
  }

  if (displayWidth(body) <= width) {
    return body;
  }

  const readable = "error · context full; new thread";
  if (displayWidth(readable) <= width) {
    return readable;
  }

  const compact = "err · ctx full; new thread";
  if (displayWidth(compact) <= width) {
    return compact;
  }

  return body;
}

function compactSuccessBodyForWidth(body: string, width: number): string {
  const bullet = body.match(/^·\s+/)?.[0] ?? "";
  const text = bullet ? body.slice(bullet.length) : body;
  if (!/^smoke passed\b/i.test(text)) {
    return body;
  }
  if (width < 14) {
    return `${bullet}smoke`;
  }
  if (width < 28) {
    return `${bullet}smoke passed`;
  }
  const smoke = text.match(/^smoke passed(?: · ([^·]+))?(?: · (.+))?$/i);
  const maybeDuration = smoke?.[1]?.trim() ?? "";
  const detail = smoke?.[2]?.trim() ?? "";
  const duration = /^\d+(?:ms|s|m)$/i.test(maybeDuration) ? maybeDuration : "";
  const visibleDetail = duration ? detail : [maybeDuration, detail].filter(Boolean).join(" · ");
  if (/\bDOM\/canvas\b/i.test(visibleDetail)) {
    const candidates = [
      duration ? `${bullet}smoke passed · ${duration} · DOM/canvas ok` : "",
      `${bullet}smoke passed · DOM/canvas ok`,
      `${bullet}smoke passed`
    ].filter(Boolean);
    return candidates.find((candidate) => displayWidth(candidate) <= width) ?? `${bullet}smoke passed`;
  }
  return body;
}

function compactNarrowWorkerBody(body: string, width: number): string {
  if (/^No active Critic findings were present for this feature;/.test(body)) {
    return "No findings.";
  }
  if (/^Verification:\s+/i.test(body)) {
    return compactVerificationBodyForWidth(body, width);
  }
  if (/^Supervisor summary:\s+/i.test(body)) {
    return compactSupervisorSummaryForWidth(body, width);
  }
  if (/^Critic review:\s+/i.test(body)) {
    return compactCriticReviewBodyForWidth(body, width);
  }
  if (/^Feature:\s+/i.test(body) && /\s+·\s+Turn:\s+/i.test(body)) {
    return compactFeatureTurnBodyForWidth(body, width);
  }
  if (/^Blocking:\s*none$/i.test(body)) {
    return width < 44 ? compactBlockingNoneForWidth(width) : body;
  }
  if (/^Findings:\s*none$/i.test(body)) {
    return width < 24 ? compactFindingsNoneForWidth(width) : body;
  }
  const findingsLabel = width < 24 ? "findings" : "findings.jsonl";
  const repliesLabel = width < 24 ? "replies" : "replies.jsonl";
  const worklogLabel = width < 24 ? "worklog" : "worklog.md";
  return body
    .replace(/^(•\s+)?npm run dev could not bind\b.*$/i, (_match, marker: string | undefined) => `${marker ?? ""}dev fallback.`)
    .replace(/\bcritic-findings\.jsonl\b/g, findingsLabel)
    .replace(/\bactor-replies\.jsonl\b/g, repliesLabel)
    .replace(/\bactor-worklog\.md\b/g, worklogLabel)
    .replace(/\bdist\/\s+fallback\b/g, "dist fallback");
}

function compactBlockingNoneForWidth(width: number): string {
  return width < 14 ? "No block" : "No blockers.";
}

function compactFindingsNoneForWidth(width: number): string {
  return width < 14 ? "No find" : "No findings.";
}

function compactVerificationBodyForWidth(body: string, width: number): string {
  const tests = body.match(/\btests\s+(\d+\/\d+)/i)?.[1];
  const parts = [
    tests ? `tests ${tests}` : /\btests passed\b/i.test(body) ? "tests" : "",
    /\bsmoke passed\b/i.test(body) ? "smoke" : "",
    /\bbuild passed\b/i.test(body) ? "build" : "",
    /\bdev fallback\b/i.test(body) ? "dev" : ""
  ].filter(Boolean);
  if (parts.length < 2) {
    return body;
  }
  if (width < 44) {
    return compactMidWidthVerificationParts(parts).join(" · ");
  }
  const compact = `Verify: ${parts.join(" · ")}`;
  return displayWidth(body) <= width ? body : compact;
}

function compactMidWidthVerificationParts(parts: string[]): string[] {
  const buildIndex = parts.indexOf("build");
  const devIndex = parts.indexOf("dev");
  if (buildIndex < 0 || devIndex < 0 || devIndex !== buildIndex + 1) {
    return parts;
  }
  return [
    ...parts.slice(0, buildIndex),
    "build+dev",
    ...parts.slice(devIndex + 1)
  ];
}

function compactSupervisorSummaryForWidth(body: string, width: number): string {
  if (/\bcompleted\b|\bdone\b/i.test(body)) {
    return width < 14 ? "Done" : "Summary: done";
  }
  return body.replace(/^Supervisor summary:/i, "Summary:");
}

function compactCriticReviewBodyForWidth(body: string, width: number): string {
  if (/\bAPPROVED\b/i.test(body)) {
    return width < 16 ? "Approved" : "Review: approved";
  }
  return body.replace(/^Critic review:/i, "Review:");
}

function compactFeatureTurnBodyForWidth(body: string, width: number): string {
  const match = body.match(/^Feature:\s*(\S+)\s+·\s+Turn:\s*(\S+)/i);
  if (!match) {
    return body;
  }
  const feature = match[1] ?? "";
  const turn = match[2] ?? "";
  const candidates = [
    `Feature ${feature}`,
    feature === turn ? `F ${feature}` : `F ${feature} T ${turn}`
  ];
  return candidates.find((candidate) => displayWidth(candidate) <= width) ?? body;
}

function compactSummaryBodyForWidth(body: string, width: number): string {
  const commandSummary = compactCommandSummaryForWidth(body, width);
  if (commandSummary) {
    return commandSummary;
  }

  const fallbackSummary = compactDevFallbackSummaryForWidth(body, width);
  if (fallbackSummary) {
    return fallbackSummary;
  }

  const fileListSummary = compactFileListSummaryForWidth(body, width);
  if (fileListSummary) {
    return fileListSummary;
  }

  const nodeTestSummary = compactNodeTestSummaryForWidth(body, width);
  if (nodeTestSummary) {
    return nodeTestSummary;
  }

  const formattedCommandSummary = compactFormattedCommandSummaryForWidth(body, width);
  if (formattedCommandSummary) {
    return formattedCommandSummary;
  }

  const noMatchSummary = compactNoMatchSummaryForWidth(body, width);
  if (noMatchSummary) {
    return noMatchSummary;
  }

  if (displayWidth(body) <= width) {
    return body;
  }

  const readRunSummary = compactReadRunSummaryForWidth(body, width);
  if (readRunSummary) {
    return readRunSummary;
  }

  const diffSummary = compactDiffSummaryForWidth(body, width);
  if (diffSummary) {
    return diffSummary;
  }

  const parts = body.split(" · ");
  if (parts.length < 2) {
    return body;
  }

  const lastPart = parts[parts.length - 1] ?? "";
  const targetCompacted = compactSummaryTargetSegment(parts, lastPart, width);
  if (targetCompacted) {
    return targetCompacted;
  }

  if (looksLikePathTarget(lastPart)) {
    const shortenedPath = [...parts.slice(0, -1), basename(lastPart)].join(" · ");
    if (displayWidth(shortenedPath) <= width) {
      return shortenedPath;
    }
  }

  const withoutTarget = parts.slice(0, -1).join(" · ");
  return displayWidth(withoutTarget) <= width ? withoutTarget : body;
}

function compactCommandSummaryForWidth(body: string, width: number): string | null {
  if (width >= 48 || !body.includes("$ npm")) {
    return null;
  }

  const compacted = body
    .replace(/\$ npm run build\b/g, "build")
    .replace(/\$ npm run smoke\b/g, "smoke")
    .replace(/\$ npm run dev\b/g, "dev")
    .replace(/\$ npm test\b/g, "test");

  const candidates = [
    compacted.replace(/\s+·\s+built dist\b/i, " · dist"),
    compacted,
    compacted.replace(/\s+·\s+dist\b/i, ""),
    compacted.replace(/\s+·\s+built dist\b/i, ""),
    ...compactTinyNpmCommandSummaryCandidates(compacted, width)
  ];
  return candidates.find((candidate) => displayWidth(candidate) <= width) ?? null;
}

function compactTinyNpmCommandSummaryCandidates(body: string, width: number): string[] {
  const tinyFirst = width <= 8;
  if (/\bbuild\b/i.test(body)) {
    return tinyFirst ? ["· build", "· build ok", "· build · dist"] : ["· build · dist", "· build ok", "· build"];
  }
  if (/\bsmoke\b/i.test(body)) {
    return tinyFirst ? ["· smoke", "· smoke ok"] : ["· smoke ok", "· smoke"];
  }
  if (/\btest\b/i.test(body)) {
    return tinyFirst ? ["· test", "· test ok"] : ["· test ok", "· test"];
  }
  if (/\bdev\b/i.test(body)) {
    return tinyFirst ? ["· dev", "· dev ok"] : ["· dev ok", "· dev"];
  }
  return [];
}

function compactFileListSummaryForWidth(body: string, width: number): string | null {
  if (width >= 32) {
    return null;
  }

  const match = body.match(/^· (?:ok \d+(?:ms|s|m) · )?files (\d+) paths(?: · .+)?$/i);
  if (!match) {
    return null;
  }

  const count = match[1] ?? "0";
  const candidates = [
    `· files ${count} paths`,
    `· files ${count}`
  ];
  return candidates.find((candidate) => displayWidth(candidate) <= width) ?? null;
}

function compactNodeTestSummaryForWidth(body: string, width: number): string | null {
  if (width >= 24) {
    return null;
  }
  const match = body.match(/^· tests (\d+)(?:\/(\d+))? passed(?: · .+)?$/i);
  if (!match) {
    return null;
  }
  const count = match[2] && match[1] !== match[2]
    ? `${match[1] ?? "0"}/${match[2] ?? "0"}`
    : match[1] ?? "0";
  const candidates = [
    `· tests ${count} ok`,
    `· tests ${count}`,
    `· ${count} tests ok`,
    `· ${count} ok`
  ];
  return candidates.find((candidate) => displayWidth(candidate) <= width) ?? null;
}

function compactNoMatchSummaryForWidth(body: string, width: number): string | null {
  if (width >= 24) {
    return null;
  }
  const match = body.match(/^· no matches \d+(?:ms|s|m)?(?: · (.+))?$/i);
  if (!match) {
    return null;
  }

  const target = match[1]?.trim() ?? "";
  if (/^TODO markers$/i.test(target)) {
    const candidates = width < 20
      ? ["· no TODO", "· none"]
      : ["· no TODO markers", "· no TODO", "· none"];
    return candidates.find((candidate) => displayWidth(candidate) <= width) ?? null;
  }

  const candidates = [
    target ? `· no ${target}` : "",
    "· no matches",
    "· none"
  ].filter(Boolean);
  return candidates.find((candidate) => displayWidth(candidate) <= width) ?? null;
}

function compactFormattedCommandSummaryForWidth(body: string, width: number): string | null {
  if (width >= 18) {
    return null;
  }
  const match = body.match(/^· ok \d+(?:ms|s|m) · (build|dev|smoke|test)(?: · (?:built )?dist)?$/i);
  if (!match) {
    return null;
  }
  const action = (match[1] ?? "").toLowerCase();
  const hasDist = /\bdist\b/i.test(body);
  const candidates = [
    hasDist ? `· ${action} · dist` : "",
    `· ${action} ok`,
    `· ${action}`
  ].filter(Boolean);
  return candidates.find((candidate) => displayWidth(candidate) <= width) ?? null;
}

function compactDiffSummaryForWidth(body: string, width: number): string | null {
  if (width >= 32) {
    return null;
  }

  const match = body.match(/^· diff (\d+) files? · \+(\d+)(?: · -(\d+))?(?: · .+)?$/i);
  if (!match) {
    return null;
  }

  const files = match[1] ?? "0";
  const added = match[2] ?? "0";
  const removed = match[3] ?? "";
  const candidates = [
    [`· diff ${files}`, `+${added}`, removed ? `-${removed}` : ""].filter(Boolean).join(" · "),
    [`· diff ${files}`, `+${added}`].join(" · "),
    `· diff ${files}`
  ];
  return candidates.find((candidate) => displayWidth(candidate) <= width) ?? null;
}

function compactDevFallbackSummaryForWidth(body: string, width: number): string | null {
  if (width >= 48 || !/^· dev server unavailable\b/i.test(body)) {
    return null;
  }

  for (const candidate of [
    "· dev fallback · dist",
    "· dev fallback",
    "· dev · dist",
    "· dev"
  ]) {
    if (displayWidth(candidate) <= width) {
      return candidate;
    }
  }
  return null;
}

function compactReadRunSummaryForWidth(body: string, width: number): string | null {
  if (width >= 32) {
    return null;
  }
  const match = body.match(/^· read (\d+) chunks · ([\d,]+) lines(?: · .+)?$/i);
  if (!match) {
    return null;
  }

  const chunks = match[1] ?? "0";
  const lines = match[2] ?? "0";
  for (const candidate of [
    `· read ${chunks} · ${lines} lines`,
    `· read ${chunks} · ${lines}`,
    `· read ${chunks}`
  ]) {
    if (displayWidth(candidate) <= width) {
      return candidate;
    }
  }
  return null;
}

function compactSummaryTargetSegment(parts: string[], targetSegment: string, width: number): string | null {
  if (!targetSegment.includes(",")) {
    return null;
  }

  const parsed = parseSummaryTargets(targetSegment);
  if (!parsed) {
    return null;
  }

  for (let visibleCount = parsed.targets.length; visibleCount >= 1; visibleCount -= 1) {
    const hidden = parsed.targets.length - visibleCount + parsed.hidden;
    const visibleTargets = parsed.targets.slice(0, visibleCount);
    const compactedSegment = [
      ...visibleTargets,
      hidden > 0 ? `+${hidden} more` : ""
    ].filter(Boolean).join(", ");
    const compacted = [...parts.slice(0, -1), compactedSegment].join(" · ");
    if (displayWidth(compacted) <= width) {
      return compacted;
    }

    if (visibleCount === 1 && looksLikePathTarget(visibleTargets[0] ?? "")) {
      const shortenedSegment = [
        basename(visibleTargets[0] ?? ""),
        hidden > 0 ? `+${hidden} more` : ""
      ].filter(Boolean).join(", ");
      const shortened = [...parts.slice(0, -1), shortenedSegment].join(" · ");
      if (displayWidth(shortened) <= width) {
        return shortened;
      }
    }
  }

  const hiddenOnly = [...parts.slice(0, -1), `${parsed.targets.length + parsed.hidden} targets`].join(" · ");
  if (displayWidth(hiddenOnly) <= width) {
    return hiddenOnly;
  }

  const withoutTarget = parts.slice(0, -1).join(" · ");
  return displayWidth(withoutTarget) <= width ? withoutTarget : null;
}

function parseSummaryTargets(segment: string): { targets: string[]; hidden: number } | null {
  const pieces = segment.split(",").map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length < 2) {
    return null;
  }

  let hidden = 0;
  const last = pieces[pieces.length - 1] ?? "";
  const hiddenMatch = last.match(/^\+(\d+)\s+more$/i);
  if (hiddenMatch) {
    hidden = Number.parseInt(hiddenMatch[1] ?? "0", 10);
    pieces.pop();
  }

  if (pieces.length === 0 || pieces.some((piece) => piece.startsWith("$ "))) {
    return null;
  }

  return { targets: pieces, hidden };
}

function looksLikePathTarget(value: string): boolean {
  return /^[A-Za-z0-9._@+-]+\/[A-Za-z0-9._@+/-]+$/.test(value);
}

function wrapBodyWithContinuation(body: string, width: number, continuationPrefix: string): string[] {
  if (displayWidth(body) <= width) {
    return [body];
  }

  const lines: string[] = [];
  let remaining = body;
  let nextWidth = width;
  const continuationWidth = Math.max(1, width - displayWidth(continuationPrefix));

  while (remaining) {
    const chunk = wrapByDisplayWidth(remaining, nextWidth)[0] ?? remaining;
    if (!chunk) {
      break;
    }
    let displayChunk = chunk.trimEnd();
    let nextRemaining = remaining.slice(chunk.length).replace(/^\s+/, "");
    if (nextRemaining && displayChunk.endsWith("·")) {
      const withoutSeparator = displayChunk.replace(/\s*·$/, "");
      if (withoutSeparator.trim()) {
        displayChunk = withoutSeparator;
      }
    }
    if (nextRemaining.startsWith("· ")) {
      nextRemaining = nextRemaining.replace(/^·\s+/, "");
    }
    lines.push(lines.length === 0 ? displayChunk : `${continuationPrefix}${displayChunk.trimStart()}`.trimEnd());
    remaining = nextRemaining;
    nextWidth = continuationWidth;
  }

  return lines.length > 0 ? lines : [body];
}

function workerOutputContinuationPrefix(kind: WorkerOutputLineKind, body: string): string {
  if (kind === "ordered-list") {
    const marker = body.match(/^\d+[.)]\s+/);
    return marker ? " ".repeat(displayWidth(marker[0])) : "   ";
  }
  if (
    kind === "list" ||
    kind === "list-detail" ||
    kind === "task" ||
    kind === "quote" ||
    kind === "summary" ||
    kind === "success" ||
    kind === "command" ||
    kind === "diff-file" ||
    kind === "diff-summary" ||
    kind === "diff-meta"
  ) {
    return "  ";
  }
  return "";
}

export function workerOutputDiffDisplayLines(text: string, width: number): string[] {
  const columns = workerOutputDiffColumns(text);
  if (!columns) {
    return [text];
  }
  const prefix = `${columns.lineNumber} ${columns.sign} `;
  const continuationPrefix = " ".repeat(prefix.length);
  const codeWidth = Math.max(1, width - prefix.length);
  const chunks = wrapTextByWidth(columns.code || " ", codeWidth);
  return chunks.map((chunk, index) => `${index === 0 ? prefix : continuationPrefix}${chunk}`.trimEnd());
}

export function workerOutputCodeDisplayLines(text: string, width: number): string[] {
  const prefix = "| ";
  const continuationPrefix = "  ";
  const codeWidth = Math.max(1, width - prefix.length);
  const chunks = wrapTextByWidth(text || " ", codeWidth);
  return chunks.map((chunk, index) => `${index === 0 ? prefix : continuationPrefix}${chunk}`.trimEnd());
}

function wrapTextByWidth(text: string, width: number): string[] {
  return wrapByDisplayWidth(text, width);
}

function isDiffCodeKind(kind: WorkerOutputLineKind): boolean {
  return kind === "diff-add" || kind === "diff-remove" || kind === "diff-context";
}

export function workerOutputSourceColumns(text: string): WorkerOutputSourceColumns | null {
  const match = text.match(/^(\s*)(\d+)(?:(\t)(.*)| {2,}(.*)|)$/);
  if (!match) {
    return null;
  }
  const hasTabSeparator = match[3] !== undefined;
  const hasSpaceSeparator = match[5] !== undefined;
  if (!hasTabSeparator && !hasSpaceSeparator) {
    return null;
  }
  return {
    lineNumber: match[2] ?? "",
    code: match[4] ?? match[5] ?? ""
  };
}

export function workerOutputSourceDisplayLines(text: string, width: number): string[] {
  const columns = workerOutputSourceColumns(text) ?? parseFormattedSourceLine(text);
  if (!columns) {
    return [text];
  }
  const prefix = `${columns.lineNumber.padStart(4, " ")}  `;
  const continuationPrefix = " ".repeat(prefix.length);
  const codeWidth = Math.max(1, width - prefix.length);
  const chunks = wrapTextByWidth(columns.code || " ", codeWidth);
  return chunks.map((chunk, index) => `${index === 0 ? prefix : continuationPrefix}${chunk}`.trimEnd());
}

function parseFormattedSourceLine(text: string): WorkerOutputSourceColumns | null {
  const match = text.match(/^(\s*\d+)\s{2}(.*)$/);
  if (!match) {
    return null;
  }
  return {
    lineNumber: (match[1] ?? "").trim(),
    code: match[2] ?? ""
  };
}


function formatGutter(value: string): string {
  return value ? `${value.padEnd(4, " ")} | ` : "       ";
}
