import { execFile } from "node:child_process";

export interface SystemProxyEndpoint {
  host: string;
  port: number;
}

export interface MacSystemProxySettings {
  http: SystemProxyEndpoint | null;
  https: SystemProxyEndpoint | null;
  socks: SystemProxyEndpoint | null;
  exceptions: string[];
}

export interface InheritMacSystemProxyOptions {
  platform?: NodeJS.Platform;
  readSettings?: () => Promise<string>;
}

const proxyEnvironmentNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const;

export async function inheritMacSystemProxy(
  env: NodeJS.ProcessEnv = process.env,
  options: InheritMacSystemProxyOptions = {}
): Promise<string[]> {
  if ((options.platform ?? process.platform) !== "darwin" || systemProxyInheritanceDisabled(env)) {
    return [];
  }

  const output = await (options.readSettings ?? readMacSystemProxySettings)();
  const settings = parseMacSystemProxySettings(output);
  if (!settings.http && !settings.https && !settings.socks) {
    return [];
  }
  const inherited: Record<(typeof proxyEnvironmentNames)[number], string | null> = {
    HTTP_PROXY: settings.http ? proxyUrl("http", settings.http) : null,
    HTTPS_PROXY: settings.https ? proxyUrl("http", settings.https) : null,
    ALL_PROXY: settings.socks ? proxyUrl("socks5h", settings.socks) : null
  };
  const applied: string[] = [];

  for (const name of proxyEnvironmentNames) {
    const value = inherited[name];
    if (!value || environmentHasName(env, name)) {
      continue;
    }
    env[name] = value;
    applied.push(name);
  }

  if (settings.exceptions.length > 0 && !environmentHasName(env, "NO_PROXY")) {
    env.NO_PROXY = settings.exceptions.join(",");
    applied.push("NO_PROXY");
  }

  return applied;
}

export function parseMacSystemProxySettings(output: string): MacSystemProxySettings {
  return {
    http: parseProxyEndpoint(output, "HTTP"),
    https: parseProxyEndpoint(output, "HTTPS"),
    socks: parseProxyEndpoint(output, "SOCKS"),
    exceptions: parseProxyExceptions(output)
  };
}

function parseProxyEndpoint(
  output: string,
  prefix: "HTTP" | "HTTPS" | "SOCKS"
): SystemProxyEndpoint | null {
  const enabled = output.match(new RegExp(`\\b${prefix}Enable\\s*:\\s*(\\d+)`))?.[1] === "1";
  const host = output.match(new RegExp(`\\b${prefix}Proxy\\s*:\\s*(\\S+)`))?.[1];
  const port = Number(output.match(new RegExp(`\\b${prefix}Port\\s*:\\s*(\\d+)`))?.[1]);
  return enabled && host && Number.isInteger(port) && port > 0 ? { host, port } : null;
}

function parseProxyExceptions(output: string): string[] {
  const block = output.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  const exceptions = [...block.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gm)]
    .map((match) => normalizeProxyException(match[1] ?? ""))
    .filter((value): value is string => Boolean(value));
  return [...new Set(exceptions)];
}

function normalizeProxyException(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized === "<local>") {
    return "localhost";
  }
  return normalized.startsWith("*.") ? normalized.slice(1) : normalized;
}

function proxyUrl(protocol: "http" | "socks5h", endpoint: SystemProxyEndpoint): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${protocol}://${host}:${endpoint.port}`;
}

function environmentHasName(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.entries(env).some(([candidate, value]) => (
    candidate.toUpperCase() === name && Boolean(value?.trim())
  ));
}

function systemProxyInheritanceDisabled(env: NodeJS.ProcessEnv): boolean {
  return /^(?:0|false|no|off)$/i.test(env.PARALLEL_CODEX_INHERIT_SYSTEM_PROXY?.trim() ?? "");
}

function readMacSystemProxySettings(): Promise<string> {
  return new Promise((resolve) => {
    execFile("scutil", ["--proxy"], { timeout: 1000 }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}
