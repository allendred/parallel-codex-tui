import { parse, stringify } from "@iarna/toml";
import { join } from "node:path";
import { z } from "zod";
import { pathExists, readTextIfExists, writeText } from "./file-store.js";

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

const InteractiveCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([])
});

const RolePromptConfigSchema = z.object({
  title: z.string().min(1),
  instructions: z.array(z.string()).default([])
});

const UiColorOverridesSchema = z.object({
  chrome: z.string().min(1).optional(),
  surface: z.string().min(1).optional(),
  rail: z.string().min(1).optional(),
  successSurface: z.string().min(1).optional(),
  dangerSurface: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  muted: z.string().min(1).optional(),
  accent: z.string().min(1).optional(),
  warning: z.string().min(1).optional(),
  success: z.string().min(1).optional(),
  danger: z.string().min(1).optional()
}).default({});

const CodexRouterConfigSchema = z.object({
  command: z.string().min(1).default("codex"),
  args: z.array(z.string()).default(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"]),
  timeoutMs: z.number().int().positive().default(120000),
  fallback: z.enum(["simple", "complex"]).default("complex")
});

const WorkerCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  firstOutputTimeoutMs: z.number().int().positive().optional(),
  model: WorkerModelConfigSchema.default({}),
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
  workers: z.object({
    codex: WorkerCommandSchema,
    claude: WorkerCommandSchema,
    mock: WorkerCommandSchema
  }),
  pairing: z.object({
    main: z.enum(["codex", "claude", "mock"]),
    judge: z.enum(["codex", "claude", "mock"]),
    actor: z.enum(["codex", "claude", "mock"]),
    critic: z.enum(["codex", "claude", "mock"])
  }),
  roles: z.object({
    main: RolePromptConfigSchema,
    judge: RolePromptConfigSchema,
    actor: RolePromptConfigSchema,
    critic: RolePromptConfigSchema
  }),
  ui: z.object({
    showStatusBar: z.boolean(),
    autoOpenFailedWorker: z.boolean(),
    theme: z.enum(["codex", "graphite", "paper"]).default("codex"),
    colors: UiColorOverridesSchema
  })
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function defaultConfig(projectRoot: string): AppConfig {
  return {
    projectRoot,
    dataDir: ".parallel-codex",
    router: {
      defaultMode: "auto",
      codex: {
        command: "codex",
        args: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"],
        timeoutMs: 120000,
        fallback: "complex"
      }
    },
    workers: {
      codex: {
        command: "codex",
        args: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"],
        timeoutMs: 45 * 60 * 1000,
        idleTimeoutMs: 5 * 60 * 1000,
        firstOutputTimeoutMs: 2 * 60 * 1000,
        model: {
          name: "",
          provider: "",
          args: [],
          env: {}
        },
        nativeSession: {
          enabled: true,
          resumeArgs: ["exec", "resume", "{sessionId}", "--skip-git-repo-check", "-"],
          detectSessionId: true,
          fallback: "new"
        },
        interactive: {
          command: "codex",
          args: ["resume", "{sessionId}"]
        }
      },
      claude: {
        command: "claude",
        args: ["--print", "--permission-mode", "acceptEdits", "--output-format", "text"],
        timeoutMs: 45 * 60 * 1000,
        idleTimeoutMs: 5 * 60 * 1000,
        firstOutputTimeoutMs: 2 * 60 * 1000,
        model: {
          name: "",
          provider: "",
          args: [],
          env: {}
        },
        nativeSession: {
          enabled: true,
          resumeArgs: ["--print", "--resume", "{sessionId}", "--permission-mode", "acceptEdits", "--output-format", "text"],
          detectSessionId: true,
          fallback: "new"
        },
        interactive: {
          command: "claude",
          args: ["--resume", "{sessionId}"]
        }
      },
      mock: {
        command: "mock",
        args: [],
        model: {
          name: "",
          provider: "",
          args: [],
          env: {}
        },
        nativeSession: {
          enabled: true,
          resumeArgs: ["resume", "{sessionId}", "-"],
          detectSessionId: true,
          fallback: "fail"
        },
        interactive: {
          command: "mock",
          args: ["resume", "{sessionId}"]
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

  const parsed = parse(await readTextIfExists(file)) as Partial<AppConfig>;
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
        ...(parsed.router?.codex ?? {})
      }
    },
    workers: {
      codex: {
        ...base.workers.codex,
        ...(parsed.workers?.codex ?? {}),
        model: {
          ...base.workers.codex.model,
          ...(parsed.workers?.codex?.model ?? {}),
          env: {
            ...base.workers.codex.model.env,
            ...(parsed.workers?.codex?.model?.env ?? {})
          }
        },
        nativeSession: {
          ...base.workers.codex.nativeSession,
          ...(parsed.workers?.codex?.nativeSession ?? {})
        },
        interactive: {
          ...base.workers.codex.interactive,
          ...(parsed.workers?.codex?.interactive ?? {})
        }
      },
      claude: {
        ...base.workers.claude,
        ...(parsed.workers?.claude ?? {}),
        model: {
          ...base.workers.claude.model,
          ...(parsed.workers?.claude?.model ?? {}),
          env: {
            ...base.workers.claude.model.env,
            ...(parsed.workers?.claude?.model?.env ?? {})
          }
        },
        nativeSession: {
          ...base.workers.claude.nativeSession,
          ...(parsed.workers?.claude?.nativeSession ?? {})
        },
        interactive: {
          ...base.workers.claude.interactive,
          ...(parsed.workers?.claude?.interactive ?? {})
        }
      },
      mock: {
        ...base.workers.mock,
        ...(parsed.workers?.mock ?? {}),
        model: {
          ...base.workers.mock.model,
          ...(parsed.workers?.mock?.model ?? {}),
          env: {
            ...base.workers.mock.model.env,
            ...(parsed.workers?.mock?.model?.env ?? {})
          }
        },
        nativeSession: {
          ...base.workers.mock.nativeSession,
          ...(parsed.workers?.mock?.nativeSession ?? {})
        },
        interactive: {
          ...base.workers.mock.interactive,
          ...(parsed.workers?.mock?.interactive ?? {})
        }
      }
    },
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

function assertObjectSections(parsed: Partial<AppConfig>): void {
  const sections: Array<[string, unknown]> = [
    ["router", parsed.router],
    ["router.codex", parsed.router?.codex],
    ["workers", parsed.workers],
    ["workers.codex", parsed.workers?.codex],
    ["workers.codex.model", parsed.workers?.codex?.model],
    ["workers.codex.model.env", parsed.workers?.codex?.model?.env],
    ["workers.codex.nativeSession", parsed.workers?.codex?.nativeSession],
    ["workers.codex.interactive", parsed.workers?.codex?.interactive],
    ["workers.claude", parsed.workers?.claude],
    ["workers.claude.model", parsed.workers?.claude?.model],
    ["workers.claude.model.env", parsed.workers?.claude?.model?.env],
    ["workers.claude.nativeSession", parsed.workers?.claude?.nativeSession],
    ["workers.claude.interactive", parsed.workers?.claude?.interactive],
    ["workers.mock", parsed.workers?.mock],
    ["workers.mock.model", parsed.workers?.mock?.model],
    ["workers.mock.model.env", parsed.workers?.mock?.model?.env],
    ["workers.mock.nativeSession", parsed.workers?.mock?.nativeSession],
    ["workers.mock.interactive", parsed.workers?.mock?.interactive],
    ["pairing", parsed.pairing],
    ["roles", parsed.roles],
    ["roles.main", parsed.roles?.main],
    ["roles.judge", parsed.roles?.judge],
    ["roles.actor", parsed.roles?.actor],
    ["roles.critic", parsed.roles?.critic],
    ["ui", parsed.ui],
    ["ui.colors", parsed.ui?.colors]
  ];

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
  const config = defaultConfig(projectRoot);
  const tomlText = stringify({
    router: config.router,
    workers: config.workers,
    pairing: config.pairing,
    roles: config.roles,
    ui: config.ui
  });

  await writeText(configPath(projectRoot), tomlText);
}
