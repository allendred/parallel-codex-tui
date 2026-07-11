import React, { useEffect } from "react";
import { Box, Text, type TextProps } from "ink";
import type {
  CollaborationEvent,
  CollaborationFeature,
  CollaborationRole,
  CollaborationTimeline
} from "../core/collaboration-timeline.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type CollaborationTimelineTone = "heading" | "muted" | "actor" | "critic" | "success" | "warning" | "danger";

export interface CollaborationTimelineLine {
  text: string;
  tone: CollaborationTimelineTone;
}

export interface CollaborationTimelineViewProps {
  timeline: CollaborationTimeline | null;
  featureIndex: number;
  loading?: boolean;
  error?: string | null;
  scrollOffset?: number;
  height?: number;
  terminalWidth?: number;
  onViewportChange?: (viewport: { offset: number; maxOffset: number }) => void;
}

export function CollaborationTimelineView({
  timeline,
  featureIndex,
  loading = false,
  error = null,
  scrollOffset = 0,
  height = 20,
  terminalWidth = process.stdout.columns || 120,
  onViewportChange
}: CollaborationTimelineViewProps) {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = collaborationTimelineContentWidth(terminalWidth);
  const layout = collaborationTimelineLayout(timeline, featureIndex, terminalWidth, { loading, error });
  const header = layout.header.slice(0, viewportHeight);
  const eventHeight = Math.max(0, viewportHeight - header.length);
  const maxOffset = Math.max(0, layout.events.length - eventHeight);
  const clampedOffset = Math.min(maxOffset, Math.max(0, Math.trunc(scrollOffset)));
  const start = Math.max(0, layout.events.length - eventHeight - clampedOffset);
  const visibleEvents = eventHeight > 0 ? layout.events.slice(start, start + eventHeight) : [];
  const lines = [...header, ...visibleEvents];
  const blankRows = Math.max(0, viewportHeight - lines.length);

  useEffect(() => {
    onViewportChange?.({ offset: clampedOffset, maxOffset });
  }, [clampedOffset, maxOffset, onViewportChange]);

  return (
    <Box flexDirection="column" height={viewportHeight}>
      {lines.map((line, index) => (
        <CollaborationTimelineRow key={`${index}-${line.tone}`} line={line} width={width} />
      ))}
      {Array.from({ length: blankRows }, (_, index) => (
        <Text key={`collaboration-fill-${index}`} backgroundColor={TUI_THEME.surface}>
          {" ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

export function collaborationTimelineDisplayLines(
  timeline: CollaborationTimeline,
  featureIndex: number,
  terminalWidth: number
): CollaborationTimelineLine[] {
  const layout = collaborationTimelineLayout(timeline, featureIndex, terminalWidth);
  return [...layout.header, ...layout.events];
}

export function nextCollaborationFeatureIndex(current: number, delta: number, featureCount: number): number {
  const count = Math.max(0, Math.trunc(featureCount));
  if (count === 0) {
    return -1;
  }
  const slotCount = count + 1;
  const currentSlot = Math.min(count, Math.max(0, Math.trunc(current) + 1));
  const nextSlot = ((currentSlot + Math.trunc(delta)) % slotCount + slotCount) % slotCount;
  return nextSlot - 1;
}

function collaborationTimelineLayout(
  timeline: CollaborationTimeline | null,
  featureIndex: number,
  terminalWidth: number,
  state: { loading?: boolean; error?: string | null } = {}
): { header: CollaborationTimelineLine[]; events: CollaborationTimelineLine[] } {
  const width = collaborationTimelineContentWidth(terminalWidth);
  const feature = selectedCollaborationFeature(timeline, featureIndex);
  const events = timeline ? collaborationEventsForFeature(timeline.events, feature) : [];
  const header: CollaborationTimelineLine[] = [
    {
      text: fitCollaborationCandidates(["Collaboration timeline", "Timeline", "Flow"], width),
      tone: "heading"
    },
    {
      text: collaborationTimelineSummary(timeline, feature, events.length, width),
      tone: "muted"
    }
  ];

  if (state.loading && !timeline) {
    return { header, events: [{ text: fitCollaborationText("loading collaboration evidence", width), tone: "muted" }] };
  }
  if (state.error) {
    return { header, events: [{ text: fitCollaborationText(`error · ${safeCollaborationText(state.error)}`, width), tone: "danger" }] };
  }
  if (!timeline) {
    return { header, events: [{ text: fitCollaborationText("no collaboration timeline", width), tone: "muted" }] };
  }
  if (events.length === 0) {
    return { header, events: [{ text: fitCollaborationText("no collaboration events in this scope", width), tone: "muted" }] };
  }
  return {
    header,
    events: events.flatMap((event) => collaborationEventLines(event, width, terminalWidth))
  };
}

function selectedCollaborationFeature(
  timeline: CollaborationTimeline | null,
  featureIndex: number
): CollaborationFeature | null {
  if (!timeline || featureIndex < 0 || featureIndex >= timeline.features.length) {
    return null;
  }
  return timeline.features[Math.trunc(featureIndex)] ?? null;
}

function collaborationEventsForFeature(
  events: CollaborationEvent[],
  feature: CollaborationFeature | null
): CollaborationEvent[] {
  if (!feature) {
    return events;
  }
  return events.filter((event) => (
    event.featureId === feature.id || event.type.startsWith("feature.wave_")
  ));
}

function collaborationTimelineSummary(
  timeline: CollaborationTimeline | null,
  feature: CollaborationFeature | null,
  eventCount: number,
  width: number
): string {
  if (!timeline) {
    return fitCollaborationCandidates(["waiting for task evidence", "waiting"], width);
  }
  if (feature) {
    const findings = `${feature.findings} ${feature.findings === 1 ? "finding" : "findings"}`;
    const replies = `${feature.replies} ${feature.replies === 1 ? "reply" : "replies"}`;
    return fitCollaborationCandidates([
      `${safeCollaborationText(feature.title)} · ${humanizeState(feature.state)} · ${eventCount} events · ${findings} · ${replies}`,
      `${safeCollaborationText(feature.title)} · ${humanizeState(feature.state)} · ${eventCount} events`,
      `${safeCollaborationText(feature.title)} · ${humanizeState(feature.state)}`,
      safeCollaborationText(feature.id)
    ], width);
  }
  const approved = timeline.features.filter((item) => item.state === "approved").length;
  const revision = timeline.features.filter((item) => item.state === "revision_needed").length;
  return fitCollaborationCandidates([
    `all · ${timeline.features.length} features · approved ${approved} · revision ${revision} · ${eventCount} events`,
    `all · ${timeline.features.length} features · ${eventCount} events`,
    `all · ${timeline.features.length}f · ${eventCount}e`,
    "all"
  ], width);
}

function collaborationEventLines(
  event: CollaborationEvent,
  width: number,
  terminalWidth: number
): CollaborationTimelineLine[] {
  const role = collaborationRoleLabel(event.role);
  const action = safeCollaborationText(event.action);
  if (terminalWidth < 28) {
    return [{
      text: fitCollaborationCandidates([
        `${event.time.slice(11, 16)} ${role.toLowerCase()} · ${action}`,
        `${role.toLowerCase()} · ${action}`,
        action
      ], width),
      tone: collaborationEventTone(event)
    }];
  }
  const scope = collaborationEventScope(event);
  const turn = event.turnId ? `T${event.turnId}` : "";
  const meta = [event.time.slice(11, 19), turn, role, scope].filter(Boolean).join(" · ");
  const countParts = [
    ...(event.findings ? [`${event.findings} ${event.findings === 1 ? "finding" : "findings"}`] : []),
    ...(event.replies ? [`${event.replies} ${event.replies === 1 ? "reply" : "replies"}`] : []),
    ...(event.artifacts.length > 0 ? [`${event.artifacts.length} ${event.artifacts.length === 1 ? "artifact" : "artifacts"}`] : [])
  ];
  const detail = [action, safeCollaborationText(event.message), ...countParts].filter(Boolean).join(" · ");
  return [
    { text: fitCollaborationText(meta, width), tone: collaborationRoleTone(event.role) },
    { text: fitCollaborationText(`  ${detail}`, width), tone: collaborationEventTone(event) }
  ];
}

function collaborationEventScope(event: CollaborationEvent): string {
  if (event.featureTitle) {
    return safeCollaborationText(event.featureTitle);
  }
  const wave = event.message.match(/\bWave\s+\d+(?:\/\d+)?/i)?.[0];
  return wave ? wave.replace(/^wave/i, "Wave") : "Task";
}

function CollaborationTimelineRow({ line, width }: { line: CollaborationTimelineLine; width: number }) {
  const fill = Math.max(0, width - displayWidth(line.text));
  return (
    <Text>
      <Text {...collaborationTimelineTheme(line.tone)}>{line.text}</Text>
      {fill > 0 ? <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(fill)}</Text> : null}
    </Text>
  );
}

function collaborationTimelineTheme(
  tone: CollaborationTimelineTone
): Pick<TextProps, "backgroundColor" | "bold" | "color"> {
  return {
    backgroundColor: TUI_THEME.surface,
    color: tone === "heading" || tone === "actor"
      ? TUI_THEME.accent
      : tone === "critic" || tone === "warning"
        ? TUI_THEME.warning
        : tone === "success"
          ? TUI_THEME.success
          : tone === "danger"
            ? TUI_THEME.danger
            : TUI_THEME.muted,
    ...(tone === "heading" || tone === "danger" ? { bold: true } : {})
  };
}

function collaborationRoleTone(role: CollaborationRole): CollaborationTimelineTone {
  if (role === "actor") {
    return "actor";
  }
  if (role === "critic") {
    return "critic";
  }
  return "muted";
}

function collaborationEventTone(event: CollaborationEvent): CollaborationTimelineTone {
  if (/revision|failed|cancelled/i.test(`${event.action} ${event.message}`)) {
    return /failed|cancelled/i.test(`${event.action} ${event.message}`) ? "danger" : "warning";
  }
  if (/approved|verified|integrated|completed/i.test(event.action)) {
    return "success";
  }
  return collaborationRoleTone(event.role);
}

function collaborationRoleLabel(role: CollaborationRole): string {
  return role === "actor" ? "Actor" : role === "critic" ? "Critic" : "Supervisor";
}

function humanizeState(state: CollaborationFeature["state"]): string {
  if (state === "revision_needed") {
    return "revision pending";
  }
  return state.replaceAll("_", " ");
}

function fitCollaborationCandidates(candidates: string[], width: number): string {
  const safe = candidates.map(safeCollaborationText);
  return safe.find((candidate) => displayWidth(candidate) <= width)
    ?? fitCollaborationText(safe.at(-1) ?? "", width);
}

function fitCollaborationText(text: string, width: number): string {
  return compactEndByDisplayWidth(safeCollaborationText(text), Math.max(1, width));
}

function safeCollaborationText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collaborationTimelineContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 2);
}
