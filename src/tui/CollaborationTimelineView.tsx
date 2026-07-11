import React, { useEffect } from "react";
import { Box, Text, type TextProps } from "ink";
import type {
  CollaborationEvent,
  CollaborationFeature,
  CollaborationRole,
  CollaborationTimeline
} from "../core/collaboration-timeline.js";
import { compactEndByDisplayWidth, displayWidth, wrapByDisplayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type CollaborationTimelineTone = "heading" | "text" | "muted" | "actor" | "critic" | "success" | "warning" | "danger";

export interface CollaborationTimelineLine {
  text: string;
  tone: CollaborationTimelineTone;
}

export interface CollaborationTimelineViewProps {
  timeline: CollaborationTimeline | null;
  featureIndex: number;
  loading?: boolean;
  error?: string | null;
  selectedEventId?: string | null;
  detailOpen?: boolean;
  unresolvedOnly?: boolean;
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
  selectedEventId = null,
  detailOpen = false,
  unresolvedOnly = false,
  scrollOffset = 0,
  height = 20,
  terminalWidth = process.stdout.columns || 120,
  onViewportChange
}: CollaborationTimelineViewProps) {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = collaborationTimelineContentWidth(terminalWidth);
  const layout = collaborationTimelineLayout(timeline, featureIndex, terminalWidth, {
    loading,
    error,
    selectedEventId,
    detailOpen,
    unresolvedOnly
  });
  const header = layout.header.slice(0, viewportHeight);
  const eventHeight = Math.max(0, viewportHeight - header.length);
  const maxOffset = Math.max(0, layout.events.length - eventHeight);
  const clampedOffset = Math.min(maxOffset, Math.max(0, Math.trunc(scrollOffset)));
  const start = detailOpen
    ? clampedOffset
    : Math.max(0, layout.events.length - eventHeight - clampedOffset);
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
  terminalWidth: number,
  options: {
    selectedEventId?: string | null;
    detailOpen?: boolean;
    unresolvedOnly?: boolean;
  } = {}
): CollaborationTimelineLine[] {
  const layout = collaborationTimelineLayout(timeline, featureIndex, terminalWidth, options);
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

export function collaborationTimelineEvents(
  timeline: CollaborationTimeline,
  featureIndex: number,
  unresolvedOnly = false
): CollaborationEvent[] {
  const feature = selectedCollaborationFeature(timeline, featureIndex);
  const scoped = collaborationEventsForFeature(timeline.events, feature);
  if (!unresolvedOnly) {
    return scoped;
  }
  const unresolvedFeatureIds = new Set(
    timeline.features.filter(collaborationFeatureIsUnresolved).map((item) => item.id)
  );
  if (feature && !unresolvedFeatureIds.has(feature.id)) {
    return [];
  }
  return scoped.filter((event) => (
    event.featureId
      ? unresolvedFeatureIds.has(event.featureId)
      : unresolvedFeatureIds.size > 0 && event.type.startsWith("feature.wave_")
  ));
}

export function moveCollaborationEventSelection(
  events: CollaborationEvent[],
  selectedEventId: string | null,
  delta: number
): string | null {
  if (events.length === 0) {
    return null;
  }
  const latestIndex = events.length - 1;
  const selectedIndex = selectedEventId
    ? events.findIndex((event) => event.id === selectedEventId)
    : latestIndex;
  const currentIndex = selectedIndex >= 0 ? selectedIndex : latestIndex;
  const nextIndex = Math.min(latestIndex, Math.max(0, currentIndex + Math.trunc(delta)));
  return nextIndex === latestIndex ? null : events[nextIndex]?.id ?? null;
}

export function collaborationSelectionScrollOffset(
  events: CollaborationEvent[],
  selectedEventId: string | null,
  terminalWidth: number
): number {
  if (!selectedEventId) {
    return 0;
  }
  const selectedIndex = events.findIndex((event) => event.id === selectedEventId);
  if (selectedIndex < 0) {
    return 0;
  }
  const lineHeight = terminalWidth < 28 ? 1 : 2;
  return Math.max(0, events.length - 1 - selectedIndex) * lineHeight;
}

function collaborationTimelineLayout(
  timeline: CollaborationTimeline | null,
  featureIndex: number,
  terminalWidth: number,
  state: {
    loading?: boolean;
    error?: string | null;
    selectedEventId?: string | null;
    detailOpen?: boolean;
    unresolvedOnly?: boolean;
  } = {}
): { header: CollaborationTimelineLine[]; events: CollaborationTimelineLine[] } {
  const width = collaborationTimelineContentWidth(terminalWidth);
  const feature = selectedCollaborationFeature(timeline, featureIndex);
  const unresolvedOnly = state.unresolvedOnly ?? false;
  const events = timeline ? collaborationTimelineEvents(timeline, featureIndex, unresolvedOnly) : [];
  const selectedEvent = selectedCollaborationEvent(events, state.selectedEventId ?? null);
  if (state.detailOpen) {
    return collaborationEventDetailLayout(selectedEvent, width);
  }
  const header: CollaborationTimelineLine[] = [
    {
      text: fitCollaborationCandidates(["Collaboration timeline", "Timeline", "Flow"], width),
      tone: "heading"
    },
    {
      text: collaborationTimelineSummary(timeline, feature, events.length, width, unresolvedOnly),
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
    const emptyMessage = unresolvedOnly
      ? "no unresolved collaboration events in this scope"
      : "no collaboration events in this scope";
    return { header, events: [{ text: fitCollaborationText(emptyMessage, width), tone: "muted" }] };
  }
  return {
    header,
    events: events.flatMap((event) => collaborationEventLines(
      event,
      width,
      terminalWidth,
      event.id === selectedEvent?.id
    ))
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

function collaborationFeatureIsUnresolved(feature: CollaborationFeature): boolean {
  return feature.state !== "approved"
    || (typeof feature.unresolvedFindings === "number"
      ? feature.unresolvedFindings > 0
      : feature.findings > feature.replies);
}

function selectedCollaborationEvent(
  events: CollaborationEvent[],
  selectedEventId: string | null
): CollaborationEvent | null {
  if (events.length === 0) {
    return null;
  }
  return selectedEventId
    ? events.find((event) => event.id === selectedEventId) ?? events.at(-1) ?? null
    : events.at(-1) ?? null;
}

function collaborationTimelineSummary(
  timeline: CollaborationTimeline | null,
  feature: CollaborationFeature | null,
  eventCount: number,
  width: number,
  unresolvedOnly = false
): string {
  if (!timeline) {
    return fitCollaborationCandidates(["waiting for task evidence", "waiting"], width);
  }
  if (feature) {
    const findings = `${feature.findings} ${feature.findings === 1 ? "finding" : "findings"}`;
    const replies = `${feature.replies} ${feature.replies === 1 ? "reply" : "replies"}`;
    const resolution = typeof feature.resolvedFindings === "number"
      && typeof feature.unresolvedFindings === "number"
      ? `${feature.resolvedFindings} fixed · ${feature.unresolvedFindings} open`
      : `${findings} · ${replies}`;
    return fitCollaborationCandidates([
      ...(unresolvedOnly ? [
        `${safeCollaborationText(feature.title)} · ${humanizeState(feature.state)} · unresolved · ${eventCount} events`
      ] : []),
      `${safeCollaborationText(feature.title)} · ${humanizeState(feature.state)} · ${eventCount} events · ${resolution}`,
      `${safeCollaborationText(feature.title)} · ${humanizeState(feature.state)} · ${eventCount} events`,
      `${safeCollaborationText(feature.title)} · ${humanizeState(feature.state)}`,
      safeCollaborationText(feature.id)
    ], width);
  }
  const approved = timeline.features.filter((item) => item.state === "approved").length;
  const revision = timeline.features.filter((item) => item.state === "revision_needed").length;
  return fitCollaborationCandidates([
    ...(unresolvedOnly ? [
      `all · ${timeline.features.length} features · unresolved · ${eventCount} events`,
      `all · unresolved · ${eventCount} events`
    ] : []),
    `all · ${timeline.features.length} features · approved ${approved} · revision ${revision} · ${eventCount} events`,
    `all · ${timeline.features.length} features · ${eventCount} events`,
    `all · ${timeline.features.length}f · ${eventCount}e`,
    "all"
  ], width);
}

function collaborationEventLines(
  event: CollaborationEvent,
  width: number,
  terminalWidth: number,
  selected: boolean
): CollaborationTimelineLine[] {
  const role = collaborationRoleLabel(event.role);
  const action = safeCollaborationText(event.action);
  if (terminalWidth < 28) {
    return [{
      text: fitCollaborationCandidates([
        `${selected ? "> " : "  "}${event.time.slice(11, 16)} ${role.toLowerCase()} · ${action}`,
        `${selected ? "> " : "  "}${role.toLowerCase()} · ${action}`,
        `${selected ? "> " : "  "}${action}`
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
    { text: fitCollaborationText(`${selected ? ">" : " "} ${meta}`, width), tone: collaborationRoleTone(event.role) },
    { text: fitCollaborationText(`    ${detail}`, width), tone: collaborationEventTone(event) }
  ];
}

function collaborationEventDetailLayout(
  event: CollaborationEvent | null,
  width: number
): { header: CollaborationTimelineLine[]; events: CollaborationTimelineLine[] } {
  const header: CollaborationTimelineLine[] = [
    { text: fitCollaborationCandidates(["Collaboration event", "Event"], width), tone: "heading" },
    {
      text: event
        ? fitCollaborationText([
            event.time.slice(11, 19),
            collaborationRoleLabel(event.role),
            collaborationEventScope(event)
          ].join(" · "), width)
        : fitCollaborationText("no selected event", width),
      tone: "muted"
    }
  ];
  if (!event) {
    return { header, events: [{ text: "no event in this scope", tone: "muted" }] };
  }

  const lines: CollaborationTimelineLine[] = [
    ...collaborationDetailLines("action", event.action, width, collaborationEventTone(event)),
    ...collaborationDetailLines("type", event.type, width, "muted"),
    ...(event.featureId
      ? collaborationDetailLines(
          "feature",
          `${event.featureTitle ?? event.featureId} · ${event.featureId}`,
          width,
          "muted"
        )
      : []),
    ...(event.turnId ? collaborationDetailLines("turn", event.turnId, width, "muted") : []),
    ...collaborationDetailLines("message", event.message || "(empty)", width, "text"),
    ...(typeof event.findings === "number"
      ? collaborationDetailLines("findings", String(event.findings), width, "muted")
      : []),
    ...(typeof event.replies === "number"
      ? collaborationDetailLines("replies", String(event.replies), width, "muted")
      : []),
    ...(typeof event.resolvedFindings === "number"
      ? collaborationDetailLines("fixed", String(event.resolvedFindings), width, "success")
      : []),
    ...(typeof event.unresolvedFindings === "number"
      ? collaborationDetailLines(
          "open",
          String(event.unresolvedFindings),
          width,
          event.unresolvedFindings > 0 ? "critic" : "muted"
        )
      : []),
    ...(event.artifactRefs.length > 0
      ? event.artifactRefs.flatMap((artifact) => collaborationDetailLines(
          "artifact",
          `${artifact.label} · ${artifact.path}`,
          width,
          "actor"
        ))
      : [{ text: fitCollaborationText("artifacts · none", width), tone: "muted" as const }])
  ];
  return { header, events: lines };
}

function collaborationDetailLines(
  label: string,
  value: string,
  width: number,
  tone: CollaborationTimelineTone
): CollaborationTimelineLine[] {
  return wrapByDisplayWidth(`${label} · ${safeCollaborationText(value)}`, width)
    .map((text) => ({ text, tone }));
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
            : tone === "text"
              ? TUI_THEME.text
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
