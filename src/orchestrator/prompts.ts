export interface MainPromptInput {
  request: string;
  role?: RolePromptConfig;
  context?: string;
}

export interface JudgePromptInput {
  request: string;
  taskDir: string;
  workerDir?: string;
  workspaceDir?: string;
  turn?: PromptTurnContext;
  role?: RolePromptConfig;
}

export interface RolePromptInput {
  request: string;
  taskDir: string;
  judgeDir: string;
  actorDir?: string;
  workspaceDir?: string;
  revision?: string;
  turn?: PromptTurnContext;
  feature?: PromptFeatureContext;
  role?: RolePromptConfig;
}

export interface RolePromptConfig {
  title: string;
  instructions: string[];
}

export interface WaveRolePromptInput {
  request: string;
  taskDir: string;
  judgeDir: string;
  workerDir: string;
  workspaceDir: string;
  wave: number;
  waves: number;
  featureIds: string[];
  review?: string;
  turn?: PromptTurnContext;
  role?: RolePromptConfig;
}

export interface PromptTurnContext {
  turnId: string;
  turnDir: string;
  previousSummaries?: string[];
}

export interface PromptFeatureContext {
  featureId: string;
  featureTitle: string;
  featureDescription: string;
  featureSpecPath: string;
  featureDependencies: string[];
  featureDir: string;
  dialoguePath: string;
  actorWorklogPath: string;
  actorRepliesPath: string;
  criticFindingsPath: string;
  decisionsPath: string;
}

export function buildMainPrompt(input: MainPromptInput): string {
  const role = roleConfig(input.role, "Main", [
    "Answer the user directly for simple chat and explanation requests."
  ]);
  return [
    `# Role: ${role.title}`,
    "",
    ...instructionLines(role.instructions),
    ...(input.context?.trim()
      ? ["", "# Active task context", "", input.context.trim()]
      : []),
    "",
    "User request:",
    input.request,
    ""
  ].join("\n");
}

export function buildJudgePrompt(input: JudgePromptInput): string {
  const role = roleConfig(input.role, "Judge", [
    "You clarify requirements and write task files. Do not implement code."
  ]);
  return [
    `# Role: ${role.title}`,
    "",
    ...instructionLines(role.instructions),
    "",
    `Task directory: ${input.taskDir}`,
    ...(input.workerDir ? [`Worker directory: ${input.workerDir}`] : []),
    ...(input.workspaceDir ? [
      `Project workspace (read-only): ${input.workspaceDir}`,
      "Inspect the project workspace when needed, but never modify it. Write only the Judge artifacts listed below.",
      "Actors execute in isolated feature workspaces. In every artifact, use logical project root to mean the Actor's assigned feature workspace/current working directory.",
      "Never put the absolute live workspace path into implementation instructions or acceptance paths."
    ] : []),
    ...turnLines(input.turn),
    "",
    "Write these files in the worker directory above:",
    "- requirements.md",
    "- plan.md",
    "- acceptance.md",
    "- actor-brief.md",
    "- critic-brief.md",
    "- features.json",
    "",
    "Markdown artifact contract:",
    "- requirements.md must use list items with stable requirement ids, for example: - [R-001] one actionable requirement",
    "- plan.md must use ordered steps with stable plan ids, for example: 1. [P-001] one concrete implementation step",
    "- acceptance.md must use list items with stable acceptance ids and related requirement ids, for example: - [A-001] [R-001] one observable check or command",
    "- actor-brief.md and critic-brief.md must contain concrete role guidance below their headings",
    "- Do not leave TODO, TBD, 待定, or placeholder-only content in any artifact",
    "",
    "features.json must contain version 1 and at most 8 features.",
    "Use safe lowercase ids made from letters, numbers, and hyphens.",
    "List dependencies in \"depends_on\"; independent features can run in parallel.",
    "Example: {\"version\":1,\"features\":[{\"id\":\"ui\",\"title\":\"UI\",\"description\":\"Build the interface\",\"depends_on\":[]}]}",
    "",
    "User request:",
    input.request,
    ""
  ].join("\n");
}

export function buildActorPrompt(input: RolePromptInput): string {
  const role = roleConfig(input.role, "Actor", [
    "Read Judge files, implement the requested change, and record your work."
  ]);
  return [
    `# Role: ${role.title}`,
    "",
    ...instructionLines(role.instructions),
    "",
    `Task directory: ${input.taskDir}`,
    `Judge directory: ${input.judgeDir}`,
    ...(input.workspaceDir ? [
      `Feature workspace: ${input.workspaceDir}`,
      "The feature workspace above is the logical project root for this run.",
      "Resolve every project-root, repository-root, or current-project path to this exact feature workspace.",
      "Never write implementation files to the shared live workspace or any parent of the task directory.",
      "Keep all implementation changes inside this feature workspace. Use task and feature directories only for coordination files."
    ] : []),
    ...turnLines(input.turn),
    ...featureLines(input.feature),
    "",
    "Read:",
    "- requirements.md",
    "- plan.md",
    "- acceptance.md",
    "- actor-brief.md",
    "",
    "Write in your worker directory:",
    "- worklog.md",
    "- patch.diff when a diff is available",
    "",
    "Feature mailbox writes:",
    "- actor-worklog.md with implementation notes for this feature.",
    '- actor-replies.jsonl with one JSON object per Critic finding you fixed: {"finding_id":"C-001","status":"fixed","notes":"what changed"}.',
    "",
    input.revision ? `Revision request:\n${input.revision}` : "No Critic revision request is active.",
    "",
    "User request:",
    input.request,
    ""
  ].join("\n");
}

export function buildCriticPrompt(input: RolePromptInput): string {
  const role = roleConfig(input.role, "Critic", [
    "Review Actor work against Judge requirements. Lead with blocking findings."
  ]);
  return [
    `# Role: ${role.title}`,
    "",
    ...instructionLines(role.instructions),
    "",
    `Task directory: ${input.taskDir}`,
    `Judge directory: ${input.judgeDir}`,
    `Actor directory: ${input.actorDir ?? ""}`,
    ...(input.workspaceDir ? [
      `Review workspace: ${input.workspaceDir}`,
      "This is a disposable review copy of the Actor feature workspace and is the logical project root for review.",
      "Do not modify implementation files. Any implementation changes made in this review copy are discarded.",
      "Do not modify the Actor feature workspace or live workspace."
    ] : []),
    ...turnLines(input.turn),
    ...featureLines(input.feature),
    "",
    "Read Judge files and Actor output.",
    "Read actor-replies.jsonl when reviewing a revision.",
    "",
    "Write review.md in your worker directory. Include APPROVED when no blocking findings remain.",
    "If revision is required, include REVISION_REQUIRED and a concise fix list.",
    'Write critic-findings.jsonl in the feature mailbox with one JSON object per blocking issue: {"id":"C-001","severity":"blocker","summary":"what must change"}.',
    "",
    "User request:",
    input.request,
    ""
  ].join("\n");
}

export function buildWaveCriticPrompt(input: WaveRolePromptInput): string {
  const role = waveRoleConfig(input.role, "Wave Critic", [
    "Verify the combined feature result against all Judge requirements before it reaches the live workspace."
  ]);
  return [
    `# Role: ${role.title}`,
    "",
    ...instructionLines(role.instructions),
    "",
    `Task directory: ${input.taskDir}`,
    `Judge directory: ${input.judgeDir}`,
    `Worker directory: ${input.workerDir}`,
    `Combined verification workspace: ${input.workspaceDir}`,
    `Wave: ${input.wave}/${input.waves}`,
    `Features in this wave: ${input.featureIds.join(", ")}`,
    ...turnLines(input.turn),
    "",
    "Live workspace has not been updated. Review only the combined verification workspace.",
    "Treat the combined verification workspace as the logical project root for this review.",
    "Read Judge requirements.md, plan.md, acceptance.md, critic-brief.md, and every feature decisions.md.",
    "Run relevant tests, builds, and cross-feature checks in the combined verification workspace.",
    "Do not modify implementation files.",
    "",
    "Write review.md in the worker directory.",
    "Include APPROVED only when the combined result satisfies the full request and Judge acceptance.md.",
    "Otherwise include REVISION_REQUIRED with a concise, actionable fix list.",
    "Do not omit the decision marker.",
    "",
    "User request:",
    input.request,
    ""
  ].join("\n");
}

export function buildWaveActorPrompt(input: WaveRolePromptInput): string {
  const role = waveRoleConfig(input.role, "Wave Actor", [
    "Resolve combined integration findings without reopening approved feature scope unnecessarily."
  ]);
  return [
    `# Role: ${role.title}`,
    "",
    ...instructionLines(role.instructions),
    "",
    `Task directory: ${input.taskDir}`,
    `Judge directory: ${input.judgeDir}`,
    `Worker directory: ${input.workerDir}`,
    `Combined integration workspace: ${input.workspaceDir}`,
    `Wave: ${input.wave}/${input.waves}`,
    `Features in this wave: ${input.featureIds.join(", ")}`,
    ...turnLines(input.turn),
    "",
    "Modify only the combined integration workspace. Do not modify the live workspace or isolated feature workspaces.",
    "Treat the combined integration workspace as the logical project root for this revision.",
    "Read Judge requirements and acceptance, feature decisions, and the Wave Critic review below.",
    "Run relevant verification after fixing the combined result.",
    "Write worklog.md and patch.diff in the worker directory.",
    "",
    "Wave Critic review:",
    input.review?.trim() || "REVISION_REQUIRED\nNo review details were provided.",
    "",
    "User request:",
    input.request,
    ""
  ].join("\n");
}

function roleConfig(role: RolePromptConfig | undefined, title: string, instructions: string[]): RolePromptConfig {
  return {
    title: role?.title ?? title,
    instructions: role?.instructions?.length ? role.instructions : instructions
  };
}

function waveRoleConfig(role: RolePromptConfig | undefined, title: string, instructions: string[]): RolePromptConfig {
  return {
    title: role ? `${role.title} · Wave` : title,
    instructions: role?.instructions?.length ? role.instructions : instructions
  };
}

function instructionLines(instructions: string[]): string[] {
  if (instructions.length === 1) {
    return [instructions[0]];
  }
  return instructions.map((instruction) => `- ${instruction}`);
}

function featureLines(feature: PromptFeatureContext | undefined): string[] {
  if (!feature) {
    return [];
  }

  return [
    `Feature id: ${feature.featureId}`,
    `Feature title: ${feature.featureTitle}`,
    `Feature description: ${feature.featureDescription}`,
    `Feature specification: ${feature.featureSpecPath}`,
    `Feature dependencies: ${feature.featureDependencies.length > 0 ? feature.featureDependencies.join(", ") : "(none)"}`,
    "Work only on this feature scope and honor completed dependency outputs.",
    `Feature directory: ${feature.featureDir}`,
    `Actor/Critic dialogue log: ${feature.dialoguePath}`,
    `Actor feature worklog: ${feature.actorWorklogPath}`,
    `Critic findings: ${feature.criticFindingsPath}`,
    `Actor replies: ${feature.actorRepliesPath}`,
    `Feature decisions: ${feature.decisionsPath}`
  ];
}

function turnLines(turn: PromptTurnContext | undefined): string[] {
  if (!turn) {
    return [];
  }

  return [
    `Current turn: ${turn.turnId}`,
    `Current turn directory: ${turn.turnDir}`,
    "Previous turn summaries:",
    ...(turn.previousSummaries?.length ? turn.previousSummaries.map((summary) => `- ${summary}`) : ["- (none)"])
  ];
}
