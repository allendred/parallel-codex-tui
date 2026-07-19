import type { AppConfig } from "../core/config.js";

export type RuntimeConfigChangeKind = "router" | "restart";

export interface RuntimeConfigChange {
  kind: RuntimeConfigChangeKind;
  detail: string;
  compact: string;
}

export function runtimeConfigChange(active: AppConfig, latest: AppConfig): RuntimeConfigChange | null {
  if (runtimeConfigFingerprint(active) !== runtimeConfigFingerprint(latest)) {
    return {
      kind: "restart",
      detail: "config · roles/workers changed · restart required",
      compact: "config restart"
    };
  }
  if (JSON.stringify(active.router) !== JSON.stringify(latest.router)) {
    return {
      kind: "router",
      detail: "config · router changed · active on next request",
      compact: "config router live"
    };
  }
  return null;
}

function runtimeConfigFingerprint(config: AppConfig): string {
  const { router: _router, ...runtime } = config;
  return JSON.stringify(runtime);
}
