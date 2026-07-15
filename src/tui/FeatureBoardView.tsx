import React from "react";
import { Box, Text, type TextProps } from "ink";
import type {
  CollaborationFeature,
  CollaborationFeatureState,
  CollaborationTimeline
} from "../core/collaboration-timeline.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type FeatureBoardLineTone = "heading" | "muted" | "text" | "active" | "success" | "warning" | "danger";

export interface FeatureBoardLine {
  text: string;
  tone: FeatureBoardLineTone;
  featureIndex?: number;
}

export interface FeatureBoardViewProps {
  timeline: CollaborationTimeline | null;
  selectedIndex: number;
  loading?: boolean;
  error?: string | null;
  notice?: string | null;
  height?: number;
  terminalWidth?: number;
}

export function FeatureBoardView({
  timeline,
  selectedIndex,
  loading = false,
  error = null,
  notice = null,
  height = 20,
  terminalWidth = process.stdout.columns || 120
}: FeatureBoardViewProps) {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = featureBoardContentWidth(terminalWidth);
  const lines = featureBoardDisplayLines(timeline, selectedIndex, viewportHeight, terminalWidth, {
    loading,
    error,
    notice
  });
  const blankRows = Math.max(0, viewportHeight - lines.length);

  return (
    <Box flexDirection="column" height={viewportHeight}>
      {lines.map((line, index) => (
        <FeatureBoardRow key={`${line.featureIndex ?? line.tone}-${index}`} line={line} width={width} />
      ))}
      {Array.from({ length: blankRows }, (_, index) => (
        <Text key={`feature-board-fill-${index}`} backgroundColor={TUI_THEME.surface}>
          {" ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

export function featureBoardDisplayLines(
  timeline: CollaborationTimeline | null,
  selectedIndex: number,
  height: number,
  terminalWidth: number,
  state: { loading?: boolean; error?: string | null; notice?: string | null } = {}
): FeatureBoardLine[] {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = featureBoardContentWidth(terminalWidth);
  const lines: FeatureBoardLine[] = [
    { text: fitFeatureBoardCandidates(["Feature board", "Features", "Feat"], width), tone: "heading" }
  ];
  if (viewportHeight >= 3) {
    lines.push({ text: featureBoardSummary(timeline, width), tone: "muted" });
  }
  let slots = Math.max(0, viewportHeight - lines.length);
  if (slots === 0) {
    return lines;
  }
  if (state.loading && !timeline) {
    lines.push({ text: fitFeatureBoardText("loading feature evidence", width), tone: "muted" });
    return lines;
  }
  if (state.error) {
    lines.push({ text: fitFeatureBoardText(`error · ${safeFeatureBoardText(state.error)}`, width), tone: "danger" });
    return lines;
  }
  if (!timeline) {
    lines.push({ text: fitFeatureBoardText("no feature board", width), tone: "muted" });
    return lines;
  }
  if (timeline.features.length === 0) {
    lines.push({ text: fitFeatureBoardText("no planned features", width), tone: "muted" });
    return lines;
  }

  if (state.notice && lines.length < viewportHeight) {
    lines.push({
      text: fitFeatureBoardText(safeFeatureBoardText(state.notice), width),
      tone: "warning"
    });
    slots = Math.max(0, viewportHeight - lines.length);
  }
  if (slots === 0) {
    return lines;
  }

  const selected = clampFeatureIndex(selectedIndex, timeline.features.length);
  const rowsPerFeature = terminalWidth >= 48 && slots >= timeline.features.length * 2 ? 2 : 1;
  const visibleCount = Math.min(timeline.features.length, Math.max(1, Math.floor(slots / rowsPerFeature)));
  const start = featureBoardWindowStart(selected, timeline.features.length, visibleCount);
  for (let index = start; index < start + visibleCount; index += 1) {
    const feature = timeline.features[index];
    if (!feature) {
      continue;
    }
    const blocked = featureBoardBlockedDependencies(timeline, feature);
    lines.push({
      text: featureBoardFeatureText(feature, index === selected, blocked, width),
      tone: featureBoardStateTone(feature.state),
      featureIndex: index
    });
    if (rowsPerFeature === 2) {
      lines.push({
        text: featureBoardEvidenceText(timeline, feature, width),
        tone: "muted",
        featureIndex: index
      });
    }
  }
  return lines;
}

export function moveFeatureBoardSelection(
  current: number,
  delta: number,
  featureCount: number,
  wrap = false
): number {
  if (featureCount <= 0) {
    return 0;
  }
  const normalized = clampFeatureIndex(current, featureCount);
  const next = normalized + Math.trunc(delta);
  if (wrap) {
    return ((next % featureCount) + featureCount) % featureCount;
  }
  return Math.min(featureCount - 1, Math.max(0, next));
}

function FeatureBoardRow({ line, width }: { line: FeatureBoardLine; width: number }) {
  const fill = Math.max(0, width - displayWidth(line.text));
  return (
    <Text>
      <Text {...featureBoardLineTheme(line.tone)}>{line.text}</Text>
      {fill > 0 ? <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(fill)}</Text> : null}
    </Text>
  );
}

function featureBoardSummary(timeline: CollaborationTimeline | null, width: number): string {
  if (!timeline) {
    return fitFeatureBoardCandidates(["waiting for task evidence", "waiting"], width);
  }
  const approved = timeline.features.filter((feature) => feature.state === "approved").length;
  const active = timeline.features.filter((feature) => featureBoardStateIsActive(feature.state)).length;
  const revision = timeline.features.filter((feature) => feature.state === "revision_needed").length;
  const paused = timeline.features.filter((feature) => feature.state === "paused").length;
  const failed = timeline.features.filter((feature) => feature.state === "failed" || feature.state === "cancelled").length;
  const blocked = timeline.features.filter((feature) => featureBoardBlockedDependencies(timeline, feature).length > 0).length;
  const full = [
    `${timeline.features.length} ${timeline.features.length === 1 ? "feature" : "features"}`,
    ...(approved > 0 ? [`${approved} approved`] : []),
    ...(active > 0 ? [`${active} active`] : []),
    ...(revision > 0 ? [`${revision} ${revision === 1 ? "revision" : "revisions"}`] : []),
    ...(paused > 0 ? [`${paused} paused`] : []),
    ...(blocked > 0 ? [`${blocked} blocked`] : []),
    ...(failed > 0 ? [`${failed} failed`] : [])
  ].join(" · ");
  return fitFeatureBoardCandidates([
    full,
    `${timeline.features.length} features · ${approved} done · ${blocked} blocked`,
    `${timeline.features.length} features`,
    `${timeline.features.length}f`
  ], width);
}

function featureBoardFeatureText(
  feature: CollaborationFeature,
  selected: boolean,
  blocked: CollaborationFeature[],
  width: number
): string {
  const marker = selected ? "> " : "  ";
  const state = humanizeFeatureState(feature.state);
  const debt = typeof feature.unresolvedFindings === "number"
    ? feature.unresolvedFindings
    : Math.max(0, feature.findings - feature.replies);
  const review = debt > 0 ? `${debt} open ${debt === 1 ? "finding" : "findings"}` : "";
  const blocker = blocked.length > 0
    ? `blocked by ${blocked.map((item) => safeFeatureBoardText(item.title)).join(", ")}`
    : "";
  return fitFeatureBoardCandidates([
    [marker + `T${feature.turnId}`, safeFeatureBoardText(feature.title), state, review, blocker].filter(Boolean).join(" · "),
    [marker + safeFeatureBoardText(feature.title), state, review, blocker].filter(Boolean).join(" · "),
    [marker + safeFeatureBoardText(feature.title), state].join(" · "),
    marker + safeFeatureBoardText(feature.id),
    marker.trimEnd()
  ], width);
}

function featureBoardEvidenceText(
  timeline: CollaborationTimeline,
  feature: CollaborationFeature,
  width: number
): string {
  const dependencies = featureBoardDependencies(timeline, feature);
  const dependencyText = dependencies.length > 0
    ? `deps ${dependencies.map((item) => safeFeatureBoardText(item.title)).join(", ")}`
    : "independent";
  const evidence = feature.latestFinding
    ? `finding · ${safeFeatureBoardText(feature.latestFinding)}`
    : feature.latestReply
      ? `reply · ${safeFeatureBoardText(feature.latestReply)}`
      : safeFeatureBoardText(feature.description);
  return fitFeatureBoardText(`    ${[dependencyText, evidence].filter(Boolean).join(" · ")}`, width);
}

function featureBoardDependencies(
  timeline: CollaborationTimeline,
  feature: CollaborationFeature
): CollaborationFeature[] {
  return feature.dependsOn.flatMap((dependency) => {
    const resolved = timeline.features.find((candidate) => (
      candidate.id === dependency || candidate.id === `${feature.turnId}-${dependency}`
    ));
    return resolved ? [resolved] : [];
  });
}

function featureBoardBlockedDependencies(
  timeline: CollaborationTimeline,
  feature: CollaborationFeature
): CollaborationFeature[] {
  if (feature.state === "approved") {
    return [];
  }
  return featureBoardDependencies(timeline, feature).filter((dependency) => dependency.state !== "approved");
}

function featureBoardStateIsActive(state: CollaborationFeatureState): boolean {
  return state === "actor_running" || state === "critic_running" || state === "integrating" || state === "verifying";
}

function featureBoardStateTone(state: CollaborationFeatureState): FeatureBoardLineTone {
  if (state === "approved") {
    return "success";
  }
  if (state === "failed" || state === "cancelled") {
    return "danger";
  }
  if (state === "revision_needed" || state === "paused") {
    return "warning";
  }
  if (featureBoardStateIsActive(state)) {
    return "active";
  }
  return "muted";
}

function humanizeFeatureState(state: CollaborationFeatureState): string {
  if (state === "revision_needed") {
    return "revision pending";
  }
  return state.replaceAll("_", " ");
}

function featureBoardWindowStart(selected: number, count: number, visibleCount: number): number {
  if (visibleCount <= 0 || count <= visibleCount) {
    return 0;
  }
  return Math.min(count - visibleCount, Math.max(0, selected - Math.floor(visibleCount / 2)));
}

function clampFeatureIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, Math.trunc(index)));
}

function fitFeatureBoardCandidates(candidates: string[], width: number): string {
  const fitted = candidates.find((candidate) => displayWidth(candidate) <= width);
  return fitted ?? fitFeatureBoardText(candidates.at(-1) ?? "", width);
}

function fitFeatureBoardText(text: string, width: number): string {
  return compactEndByDisplayWidth(text, Math.max(1, width));
}

function safeFeatureBoardText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function featureBoardLineTheme(tone: FeatureBoardLineTone): Pick<TextProps, "backgroundColor" | "bold" | "color"> {
  return {
    backgroundColor: TUI_THEME.surface,
    color: tone === "heading" || tone === "active"
      ? TUI_THEME.accent
      : tone === "success"
        ? TUI_THEME.success
        : tone === "warning"
          ? TUI_THEME.warning
          : tone === "danger"
            ? TUI_THEME.danger
            : tone === "muted"
              ? TUI_THEME.muted
              : TUI_THEME.text,
    ...(tone === "heading" || tone === "danger" ? { bold: true } : {})
  };
}

function featureBoardContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 2);
}
