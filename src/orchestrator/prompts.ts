export interface JudgePromptInput {
  request: string;
  taskDir: string;
  workerDir?: string;
  turn?: PromptTurnContext;
  role?: RolePromptConfig;
}

export interface RolePromptInput {
  request: string;
  taskDir: string;
  judgeDir: string;
  actorDir?: string;
  revision?: string;
  turn?: PromptTurnContext;
  feature?: PromptFeatureContext;
  role?: RolePromptConfig;
}

export interface RolePromptConfig {
  title: string;
  instructions: string[];
}

export interface PromptTurnContext {
  turnId: string;
  turnDir: string;
  previousSummaries?: string[];
}

export interface PromptFeatureContext {
  featureId: string;
  featureDir: string;
  dialoguePath: string;
  actorWorklogPath: string;
  actorRepliesPath: string;
  criticFindingsPath: string;
  decisionsPath: string;
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
    ...turnLines(input.turn),
    "",
    "Write these files in the worker directory above:",
    "- requirements.md",
    "- plan.md",
    "- acceptance.md",
    "- actor-brief.md",
    "- critic-brief.md",
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
    "- actor-replies.jsonl with one JSON object per Critic finding you fixed.",
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
    ...turnLines(input.turn),
    ...featureLines(input.feature),
    "",
    "Read Judge files and Actor output.",
    "Read actor-replies.jsonl when reviewing a revision.",
    "",
    "Write review.md in your worker directory. Include APPROVED when no blocking findings remain.",
    "If revision is required, include REVISION_REQUIRED and a concise fix list.",
    "Write critic-findings.jsonl in the feature mailbox with one JSON object per blocking issue.",
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
