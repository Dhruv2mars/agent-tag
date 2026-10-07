import {
  installLaunchAgent,
  launchAgentLogsCommand,
  launchAgentStatus,
  launchAgentUnitState,
  type LaunchAgentStatus,
  type LaunchdHost,
  restartLaunchAgent,
  uninstallLaunchAgent,
  upgradeLaunchAgent,
} from "./launchd.ts";
import type { ServiceUnitState } from "./service-unit.ts";
import { createSystemdUserService, type SystemdUserService } from "./systemd.ts";

export type { ServiceUnitState } from "./service-unit.ts";

export type ServiceManagerKind = "launchd" | "systemd";

export interface ServiceStatusReport {
  readonly manager: ServiceManagerKind;
  readonly unitPath: string;
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly running: boolean;
  readonly hints: readonly string[];
}

export interface ServiceManager {
  readonly kind: ServiceManagerKind;
  readonly status: () => Promise<ServiceStatusReport>;
  readonly install: (configPath: string) => Promise<ServiceStatusReport>;
  readonly upgrade: (configPath: string) => Promise<ServiceStatusReport>;
  readonly uninstall: () => Promise<ServiceStatusReport>;
  readonly restart: () => Promise<ServiceStatusReport>;
  readonly unitState: (configPath: string) => Promise<ServiceUnitState>;
  readonly logsCommand: (input: { readonly lines: number; readonly follow: boolean }) => string[];
}

export const SERVICE_ACTIONS = ["install", "upgrade", "uninstall", "status", "restart", "logs"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export function isServiceAction(value: string | undefined): value is ServiceAction {
  return SERVICE_ACTIONS.some((action) => action === value);
}

const LAUNCHD_HINT = "the LaunchAgent runs only while this user is logged in and the Mac is awake";

function fromLaunchAgent(status: LaunchAgentStatus): ServiceStatusReport & { readonly label: string; readonly plistPath: string } {
  return {
    manager: "launchd",
    label: status.label,
    plistPath: status.plistPath,
    unitPath: status.plistPath,
    installed: status.installed,
    loaded: status.loaded,
    running: status.running,
    hints: [LAUNCHD_HINT],
  };
}

/** `host` lets tests drive status and restart through a fake launchctl; production uses the real user domain. */
export function launchdServiceManager(host?: LaunchdHost): ServiceManager {
  return {
    kind: "launchd",
    status: async () => fromLaunchAgent(await launchAgentStatus(host)),
    install: async (configPath) => fromLaunchAgent(await installLaunchAgent(configPath)),
    upgrade: async (configPath) => fromLaunchAgent(await upgradeLaunchAgent(configPath)),
    uninstall: async () => fromLaunchAgent(await uninstallLaunchAgent()),
    restart: async () => fromLaunchAgent(await restartLaunchAgent(host)),
    unitState: launchAgentUnitState,
    logsCommand: launchAgentLogsCommand,
  };
}

export function systemdServiceManager(service: SystemdUserService): ServiceManager {
  return {
    kind: "systemd",
    status: () => service.status(),
    install: (configPath) => service.install(configPath),
    upgrade: (configPath) => service.upgrade(configPath),
    uninstall: () => service.uninstall(),
    restart: () => service.restart(),
    unitState: (configPath) => service.unitState(configPath),
    logsCommand: (input) => service.logsCommand(input),
  };
}

export function serviceManagerKindFor(platform: NodeJS.Platform): ServiceManagerKind | undefined {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return undefined;
}

/** Returns the per-user service manager for this host, or undefined on unsupported platforms. */
export function serviceManagerFor(platform: NodeJS.Platform = process.platform): ServiceManager | undefined {
  const kind = serviceManagerKindFor(platform);
  if (kind === "launchd") return launchdServiceManager();
  if (kind === "systemd") return systemdServiceManager(createSystemdUserService());
  return undefined;
}
