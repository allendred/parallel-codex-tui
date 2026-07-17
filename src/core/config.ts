import { parse } from "@iarna/toml";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z, type ZodOptional } from "zod";
import { EngineNameSchema } from "../domain/schemas.js";
import { pathExists, readTextIfExists, writeText } from "./file-store.js";
import {
  normalizeTuiThemeColorValue,
  normalizeTuiThemeName,
  TUI_THEME_FIELDS,
  TUI_THEME_NAMES,
  type TuiThemeField
} from "../tui/theme.js";

const NativeSessionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  resumeArgs: z.array(z.string()).default([]),
  detectSessionId: z.boolean().default(true),
  fallback: z.enum(["fail", "new"]).default("fail")
});

const WorkerModelConfigSchema = z.object({
  name: z.string().default(""),
  provider: z.string().default(""),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({})
});

const WorkerCapabilitiesConfigSchema = z.object({
  profile: z.enum(["codex", "claude", "generic"]),
  writableDirArgs: z.array(z.string()).default([]),
  freshSessionArgs: z.array(z.string()).default([])
}).strict().superRefine((value, context) => {
  if (value.writableDirArgs.length > 0 && !value.writableDirArgs.some((arg) => arg.includes("{dir}"))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["writableDirArgs"],
      message: "writableDirArgs must include a {dir} template"
    });
  }
  if (value.freshSessionArgs.length > 0 && !value.freshSessionArgs.some((arg) => arg.includes("{sessionId}"))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["freshSessionArgs"],
      message: "freshSessionArgs must include a {sessionId} template"
    });
  }
});

const InteractiveCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  forkArgs: z.array(z.string()).default([])
}).superRefine((value, context) => {
  if (value.forkArgs.length > 0 && !value.forkArgs.some((arg) => arg.includes("{sessionId}"))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["forkArgs"],
      message: "forkArgs must include a {sessionId} template"
    });
  }
});

const RolePromptConfigSchema = z.object({
  title: z.string().min(1),
  instructions: z.array(z.string()).default([])
});

const TuiColorValueSchema = z.string().min(1).refine((value) => normalizeTuiThemeColorValue(value) !== null, {
  message: "Invalid TUI color value. Use a Chalk color name, #rgb/#rrggbb, rgb(r,g,b), or ansi256(0..255)."
}).transform((value) => normalizeTuiThemeColorValue(value) ?? value.trim());

const TuiThemeNameSchema = z.preprocess(
  (value) => typeof value === "string" ? normalizeTuiThemeName(value) ?? value.trim() : value,
  z.enum(TUI_THEME_NAMES)
).default("codex");

const UiColorOverridesSchema = z.object(
  Object.fromEntries(TUI_THEME_FIELDS.map((field) => [field, TuiColorValueSchema.optional()])) as Record<
    TuiThemeField,
    ZodOptional<typeof TuiColorValueSchema>
  >
).strict().default({});

const CodexRouterConfigSchema = z.object({
  command: z.string().min(1).default("codex"),
  args: z.array(z.string()).default([
    "exec",
    "--ephemeral",
    "--ignore-rules",
    "-c",
    "model_reasoning_effort=low",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-"
  ]),
  timeoutMs: z.number().int().positive().default(60000),
  firstOutputTimeoutMs: z.number().int().positive().default(30000),
  idleTimeoutMs: z.number().int().positive().default(30000),
  maxOutputBytes: z.number().int().min(1024).max(16 * 1024 * 1024).default(1024 * 1024),
  maxAttempts: z.number().int().min(1).max(3).default(2),
  retryDelayMs: z.number().int().min(0).max(10000).default(500),
  followUpTimeoutMs: z.number().int().positive().max(120000).default(45000),
  fallback: z.enum(["simple", "complex"]).default("simple"),
  env: z.record(z.string()).default({})
});

const OrchestrationConfigSchema = z.object({
  maxParallelFeatures: z.number().int().min(1).max(8),
  maxRevisionRounds: z.number().int().min(1).max(10),
  maxConflictReplans: z.number().int().min(0).max(8)
}).strict();

const UiConfigSchema = z.object({
  showStatusBar: z.boolean(),
  autoOpenFailedWorker: z.boolean(),
  theme: TuiThemeNameSchema,
  colors: UiColorOverridesSchema
}).strict();

const WorkerCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  assignable: z.boolean().default(true),
  timeoutMs: z.number().int().positive().optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  firstOutputTimeoutMs: z.number().int().positive().optional(),
  model: WorkerModelConfigSchema.default({}),
  capabilities: WorkerCapabilitiesConfigSchema,
  nativeSession: NativeSessionConfigSchema,
  interactive: InteractiveCommandSchema
});

const AppConfigSchema = z.object({
  projectRoot: z.string().min(1),
  dataDir: z.string().min(1),
  router: z.object({
    defaultMode: z.enum(["auto", "simple", "complex"]),
    codex: CodexRouterConfigSchema.default({})
  }),
  orchestration: OrchestrationConfigSchema,
  workers: z.object({
    codex: WorkerCommandSchema,
    claude: WorkerCommandSchema,
    mock: WorkerCommandSchema
  }).catchall(WorkerCommandSchema),
  pairing: z.object({
    main: EngineNameSchema,
    judge: EngineNameSchema,
    actor: EngineNameSchema,
    critic: EngineNameSchema
  }),
  roles: z.object({
    main: RolePromptConfigSchema,
    judge: RolePromptConfigSchema,
    actor: RolePromptConfigSchema,
    critic: RolePromptConfigSchema
  }),
  ui: UiConfigSchema
}).superRefine((config, context) => {
  for (const [role, workerId] of Object.entries(config.pairing)) {
    if (!config.workers[workerId]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pairing", role],
        message: `Unknown Worker profile: ${workerId}`
      });
    }
  }
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
type WorkerCommandConfig = z.infer<typeof WorkerCommandSchema>;

type ParsedWorkerConfig = Partial<Omit<
  WorkerCommandConfig,
  "model" | "capabilities" | "nativeSession" | "interactive"
>> & {
  extends?: string;
  model?: Partial<WorkerCommandConfig["model"]> & { env?: Record<string, string> };
  capabilities?: Partial<WorkerCommandConfig["capabilities"]>;
  nativeSession?: Partial<WorkerCommandConfig["nativeSession"]>;
  interactive?: Partial<WorkerCommandConfig["interactive"]>;
};

type ParsedAppConfig = {
  projectRoot?: string;
  dataDir?: string;
  router?: Partial<AppConfig["router"]> & {
    codex?: Partial<AppConfig["router"]["codex"]> & { env?: Record<string, string> };
  };
  orchestration?: Partial<AppConfig["orchestration"]>;
  workers?: Record<string, ParsedWorkerConfig>;
  pairing?: Partial<AppConfig["pairing"]>;
  roles?: {
    main?: Partial<AppConfig["roles"]["main"]>;
    judge?: Partial<AppConfig["roles"]["judge"]>;
    actor?: Partial<AppConfig["roles"]["actor"]>;
    critic?: Partial<AppConfig["roles"]["critic"]>;
  };
  ui?: Partial<AppConfig["ui"]> & { colors?: Partial<AppConfig["ui"]["colors"]> };
};

export function defaultConfig(projectRoot: string): AppConfig {
  return {
    projectRoot,
    dataDir: ".parallel-codex",
    router: {
      defaultMode: "auto",
      codex: {
        command: "codex",
        args: [
          "exec",
          "--ephemeral",
          "--ignore-rules",
          "-c",
          "model_reasoning_effort=low",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "-"
        ],
        timeoutMs: 60000,
        firstOutputTimeoutMs: 30000,
        idleTimeoutMs: 30000,
        maxOutputBytes: 1024 * 1024,
        maxAttempts: 2,
        retryDelayMs: 500,
        followUpTimeoutMs: 45000,
        fallback: "simple",
        env: {}
      }
    },
    orchestration: {
      maxParallelFeatures: 3,
      maxRevisionRounds: 3,
      maxConflictReplans: 2
    },
    workers: {
      codex: {
        command: "codex",
        args: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"],
        assignable: true,
        timeoutMs: 45 * 60 * 1000,
        idleTimeoutMs: 5 * 60 * 1000,
        firstOutputTimeoutMs: 2 * 60 * 1000,
        model: {
          name: "",
          provider: "",
          args: [],
          env: {}
        },
        capabilities: {
          profile: "codex",
          writableDirArgs: ["--add-dir", "{dir}"],
          freshSessionArgs: []
        },
        nativeSession: {
          enabled: true,
          resumeArgs: ["exec", "resume", "{sessionId}", "--skip-git-repo-check", "-"],
          detectSessionId: true,
          fallback: "new"
        },
        interactive: {
          command: "codex",
          args: ["resume", "{sessionId}"],
          forkArgs: ["fork", "{sessionId}"]
        }
      },
      claude: {
        command: "claude",
        args: ["--print", "--permission-mode", "auto", "--output-format", "text"],
        assignable: true,
        timeoutMs: 45 * 60 * 1000,
        idleTimeoutMs: 5 * 60 * 1000,
        firstOutputTimeoutMs: 2 * 60 * 1000,
        model: {
          name: "",
          provider: "",
          args: [],
          env: {}
        },
        capabilities: {
          profile: "claude",
          writableDirArgs: ["--add-dir", "{dir}"],
          freshSessionArgs: ["--session-id", "{sessionId}"]
        },
        nativeSession: {
          enabled: true,
          resumeArgs: ["--print", "--resume", "{sessionId}", "--permission-mode", "auto", "--output-format", "text"],
          detectSessionId: true,
          fallback: "new"
        },
        interactive: {
          command: "claude",
          args: ["--resume", "{sessionId}"],
          forkArgs: ["--resume", "{sessionId}", "--fork-session"]
        }
      },
      mock: {
        command: "mock",
        args: [],
        assignable: false,
        model: {
          name: "",
          provider: "",
          args: [],
          env: {}
        },
        capabilities: {
          profile: "generic",
          writableDirArgs: [],
          freshSessionArgs: []
        },
        nativeSession: {
          enabled: true,
          resumeArgs: ["resume", "{sessionId}", "-"],
          detectSessionId: true,
          fallback: "fail"
        },
        interactive: {
          command: "mock",
          args: ["resume", "{sessionId}"],
          forkArgs: []
        }
      }
    },
    pairing: {
      main: "claude",
      judge: "codex",
      actor: "codex",
      critic: "codex"
    },
    roles: {
      main: {
        title: "Main",
        instructions: ["Answer the user directly for simple chat and explanation requests."]
      },
      judge: {
        title: "Judge",
        instructions: ["You clarify requirements and write task files. Do not implement code."]
      },
      actor: {
        title: "Actor",
        instructions: ["Read Judge files, implement the requested change, and record your work."]
      },
      critic: {
        title: "Critic",
        instructions: ["Review Actor work against Judge requirements. Lead with blocking findings."]
      }
    },
    ui: {
      showStatusBar: true,
      autoOpenFailedWorker: true,
      theme: "codex",
      colors: {}
    }
  };
}

export function configPath(projectRoot: string): string {
  return join(projectRoot, ".parallel-codex", "config.toml");
}

export async function loadConfig(projectRoot: string): Promise<AppConfig> {
  const base = defaultConfig(projectRoot);
  const file = configPath(projectRoot);

  if (!(await pathExists(file))) {
    return base;
  }

  const parsed = parse(await readTextIfExists(file)) as ParsedAppConfig;
  assertObjectSections(parsed);
  const merged = {
    ...base,
    ...parsed,
    projectRoot,
    router: {
      ...base.router,
      ...(parsed.router ?? {}),
      codex: {
        ...base.router.codex,
        ...(parsed.router?.codex ?? {}),
        env: {
          ...base.router.codex.env,
          ...(parsed.router?.codex?.env ?? {})
        }
      }
    },
    orchestration: {
      ...base.orchestration,
      ...(parsed.orchestration ?? {})
    },
    workers: resolveWorkerConfigs(base.workers, parsed.workers ?? {}),
    pairing: {
      ...base.pairing,
      ...(parsed.pairing ?? {})
    },
    roles: {
      main: {
        ...base.roles.main,
        ...(parsed.roles?.main ?? {})
      },
      judge: {
        ...base.roles.judge,
        ...(parsed.roles?.judge ?? {})
      },
      actor: {
        ...base.roles.actor,
        ...(parsed.roles?.actor ?? {})
      },
      critic: {
        ...base.roles.critic,
        ...(parsed.roles?.critic ?? {})
      }
    },
    ui: {
      ...base.ui,
      ...(parsed.ui ?? {}),
      colors: {
        ...base.ui.colors,
        ...(parsed.ui?.colors ?? {})
      }
    }
  };

  return AppConfigSchema.parse(merged);
}

function resolveWorkerConfigs(
  builtins: AppConfig["workers"],
  configured: Record<string, ParsedWorkerConfig>
): AppConfig["workers"] {
  const resolved = new Map<string, WorkerCommandConfig>();
  const resolving = new Set<string>();
  const ids = [...new Set([...Object.keys(builtins), ...Object.keys(configured)])];

  const resolve = (id: string): WorkerCommandConfig => {
    const cached = resolved.get(id);
    if (cached) {
      return cached;
    }
    if (!EngineNameSchema.safeParse(id).success) {
      throw new Error(`Invalid Worker profile id: ${id}`);
    }
    if (resolving.has(id)) {
      throw new Error(`Circular Worker profile inheritance: ${[...resolving, id].join(" -> ")}`);
    }
    resolving.add(id);
    try {
      const override = configured[id] ?? {};
      const builtin = builtins[id];
      if (builtin && override.extends) {
        throw new Error(`Built-in Worker profile ${id} cannot declare extends`);
      }
      let parent = builtin;
      if (!parent) {
        const parentId = override.extends?.trim();
        if (!parentId || parentId === "generic") {
          parent = genericWorkerConfig(id, override.command);
        } else {
          if (!builtins[parentId] && !configured[parentId]) {
            throw new Error(`Unknown Worker profile inherited by ${id}: ${parentId}`);
          }
          parent = resolve(parentId);
        }
      }
      const worker = mergeWorkerConfig(parent, override);
      resolved.set(id, worker);
      return worker;
    } finally {
      resolving.delete(id);
    }
  };

  for (const id of ids) {
    resolve(id);
  }
  return Object.fromEntries(resolved) as AppConfig["workers"];
}

function genericWorkerConfig(id: string, command = id): WorkerCommandConfig {
  return {
    command,
    args: [],
    assignable: true,
    timeoutMs: 45 * 60 * 1000,
    idleTimeoutMs: 5 * 60 * 1000,
    firstOutputTimeoutMs: 2 * 60 * 1000,
    model: {
      name: "",
      provider: "",
      args: [],
      env: {}
    },
    capabilities: {
      profile: "generic",
      writableDirArgs: [],
      freshSessionArgs: []
    },
    nativeSession: {
      enabled: false,
      resumeArgs: [],
      detectSessionId: false,
      fallback: "fail"
    },
    interactive: {
      command,
      args: [],
      forkArgs: []
    }
  };
}

function mergeWorkerConfig(
  base: WorkerCommandConfig,
  override: ParsedWorkerConfig
): WorkerCommandConfig {
  const { extends: _extends, ...values } = override;
  return {
    ...base,
    ...values,
    model: {
      ...base.model,
      ...(override.model ?? {}),
      env: {
        ...base.model.env,
        ...(override.model?.env ?? {})
      }
    },
    capabilities: {
      ...base.capabilities,
      ...(override.capabilities ?? {})
    },
    nativeSession: {
      ...base.nativeSession,
      ...(override.nativeSession ?? {})
    },
    interactive: {
      ...base.interactive,
      ...(override.interactive ?? {})
    }
  };
}

export function withUiThemeOverride(config: AppConfig, theme: AppConfig["ui"]["theme"] | null): AppConfig {
  if (!theme) {
    return config;
  }

  return {
    ...config,
    ui: {
      ...config.ui,
      theme
    }
  };
}

function assertObjectSections(parsed: ParsedAppConfig): void {
  const sections: Array<[string, unknown]> = [
    ["router", parsed.router],
    ["router.codex", parsed.router?.codex],
    ["router.codex.env", parsed.router?.codex?.env],
    ["orchestration", parsed.orchestration],
    ["workers", parsed.workers],
    ["pairing", parsed.pairing],
    ["roles", parsed.roles],
    ["roles.main", parsed.roles?.main],
    ["roles.judge", parsed.roles?.judge],
    ["roles.actor", parsed.roles?.actor],
    ["roles.critic", parsed.roles?.critic],
    ["ui", parsed.ui],
    ["ui.colors", parsed.ui?.colors]
  ];

  if (isPlainObject(parsed.workers)) {
    for (const [id, value] of Object.entries(parsed.workers)) {
      sections.push([`workers.${id}`, value]);
      if (!isPlainObject(value)) {
        continue;
      }
      const worker = value as Record<string, unknown>;
      sections.push(
        [`workers.${id}.model`, worker.model],
        [`workers.${id}.capabilities`, worker.capabilities],
        [`workers.${id}.nativeSession`, worker.nativeSession],
        [`workers.${id}.interactive`, worker.interactive]
      );
      if (isPlainObject(worker.model)) {
        sections.push([`workers.${id}.model.env`, worker.model.env]);
      }
    }
  }

  for (const [path, value] of sections) {
    if (value !== undefined && !isPlainObject(value)) {
      throw new Error(`Invalid config section [${path}]: expected a table`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function writeDefaultConfig(projectRoot: string): Promise<void> {
  await writeText(configPath(projectRoot), await readExampleConfig());
}

async function readExampleConfig(): Promise<string> {
  return readFile(new URL("../../.parallel-codex/config.example.toml", import.meta.url), "utf8");
}
