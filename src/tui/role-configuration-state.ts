import {
  CONFIGURABLE_ROLES,
  cloneRoleSelection,
  type ConfigurableRole,
  type RoleConfigurationScope,
  type RoleConfigurationSnapshot,
  type RoleExecutionSelection,
  type RoleProviderOption
} from "../core/role-configuration.js";

const ROLE_CONFIGURATION_SCOPES = ["next", "task", "future"] as const satisfies readonly RoleConfigurationScope[];

export function roleConfigurationSelectionForScope(
  snapshot: RoleConfigurationSnapshot,
  scope: RoleConfigurationScope
): RoleExecutionSelection {
  if (scope === "future") {
    return cloneRoleSelection(snapshot.future);
  }
  if (scope === "task") {
    return cloneRoleSelection(snapshot.task ?? snapshot.future);
  }
  return cloneRoleSelection(snapshot.next ?? snapshot.future);
}

export function roleConfigurationScopeHasOverride(
  snapshot: RoleConfigurationSnapshot | null,
  scope: RoleConfigurationScope
): boolean {
  if (!snapshot) {
    return false;
  }
  if (scope === "future") {
    return !sameRoleSelection(snapshot.future, snapshot.baseline);
  }
  return scope === "next" ? snapshot.next !== null : snapshot.task !== null;
}

export function nextRoleConfigurationScope(
  scope: RoleConfigurationScope,
  delta: number,
  hasTask: boolean
): RoleConfigurationScope {
  const available = ROLE_CONFIGURATION_SCOPES.filter((candidate) => candidate !== "task" || hasTask);
  const index = Math.max(0, available.indexOf(scope));
  return available[((index + delta) % available.length + available.length) % available.length] ?? "next";
}

export function moveRoleConfigurationSelection(index: number, delta: number): number {
  const length = CONFIGURABLE_ROLES.length;
  return ((index + delta) % length + length) % length;
}

export function selectedConfigurableRole(index: number): ConfigurableRole {
  return CONFIGURABLE_ROLES[Math.max(0, Math.min(CONFIGURABLE_ROLES.length - 1, index))] ?? "main";
}

export function cycleRoleProvider(
  roles: RoleExecutionSelection,
  role: ConfigurableRole,
  providers: RoleProviderOption[],
  delta: number
): RoleExecutionSelection {
  const currentEngine = roles[role].engine;
  const selectableProviders = providers.filter((provider) => (
    provider.assignable || provider.id === currentEngine
  ));
  if (selectableProviders.length === 0) {
    return cloneRoleSelection(roles);
  }
  const currentIndex = selectableProviders.findIndex((provider) => provider.id === currentEngine);
  const start = currentIndex >= 0 ? currentIndex : 0;
  const provider = selectableProviders[
    ((start + delta) % selectableProviders.length + selectableProviders.length) % selectableProviders.length
  ] ?? selectableProviders[0];
  if (!provider) {
    return cloneRoleSelection(roles);
  }
  return {
    ...cloneRoleSelection(roles),
    [role]: {
      engine: provider.id,
      model: provider.model
    }
  };
}

export function updateRoleModel(
  roles: RoleExecutionSelection,
  role: ConfigurableRole,
  model: string
): RoleExecutionSelection {
  return {
    ...cloneRoleSelection(roles),
    [role]: {
      ...roles[role],
      model
    }
  };
}

export function sameRoleSelection(
  left: RoleExecutionSelection,
  right: RoleExecutionSelection
): boolean {
  return CONFIGURABLE_ROLES.every((role) => (
    left[role].engine === right[role].engine
    && left[role].model === right[role].model
  ));
}

export function roleConfigurationScopeLabel(scope: RoleConfigurationScope): string {
  if (scope === "next") {
    return "next request · one shot";
  }
  if (scope === "task") {
    return "current task · retries and follow-ups";
  }
  return "future requests · persisted default";
}
