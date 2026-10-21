import type { DoctorCheck } from "./doctor.ts";
import type { ServiceStateReport } from "./service-state.ts";
import { inspectInstalledT3, type T3InstallStatus } from "./t3/install.ts";
import { inspectManagedT3Runtime, type ManagedT3Config } from "./t3/operator.ts";
import type { T3Pin } from "./t3/pin.ts";

/** What doctor's `t3-runtime` check reads: the verified install, the running server, and who started it. */
export interface T3RuntimeProbe {
  readonly install: Pick<T3InstallStatus, "supported" | "installed" | "filesVerified" | "version" | "runtimeDir" | "problem">;
  readonly runtime: Awaited<ReturnType<typeof inspectManagedT3Runtime>>;
  /** Parent pid of the running T3, or null when it is not running or could not be read. */
  readonly parentPid: number | null;
}

async function parentPidOf(pid: number): Promise<number | null> {
  try {
    const child = Bun.spawn(["ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) return null;
    const parent = Number(output.trim());
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

/** Read-only: re-hashes the install, reads `server-runtime.json` and the descriptor; never starts T3. */
export async function probeManagedT3Runtime(t3: ManagedT3Config, pin: T3Pin): Promise<T3RuntimeProbe> {
  const install = await inspectInstalledT3({ pin, runtimeDir: t3.managed.runtimeDir });
  const runtime = await inspectManagedT3Runtime({ t3, pinnedVersion: pin.version });
  return { install, runtime, parentPid: runtime.pid === null ? null : await parentPidOf(runtime.pid) };
}

/**
 * Managed mode only: the pinned T3 is installed and verifies, and the server answering on the
 * managed port is the one the Agent Tag service started (its pid from `server-runtime.json` is a
 * child of the service pid).
 */
export function checkT3Runtime(
  t3: ManagedT3Config,
  serviceState: ServiceStateReport | undefined,
  probe: T3RuntimeProbe,
): DoctorCheck {
  const id = "t3-runtime";
  const { managed, baseUrl } = t3;
  const { install, runtime, parentPid } = probe;
  if (!install.supported) {
    return { id, status: "fail", summary: install.problem ?? "managed T3 is unavailable on this platform", hint: 'use t3.mode "external" with your own T3 server' };
  }
  if (!install.filesVerified) {
    const summary = install.installed
      ? `managed T3 in ${install.runtimeDir} does not verify: ${install.problem ?? "unknown problem"}`
      : `managed T3 is not installed in ${install.runtimeDir} yet`;
    const repairs = managed.autoInstall && !runtime.running;
    return {
      id,
      status: repairs ? "warn" : "fail",
      summary,
      hint: repairs
        ? "the service downloads and verifies the pinned T3 when it starts; or run `agent-tag t3 install CONFIG` now"
        : "run `agent-tag t3 install CONFIG`, then restart the service",
    };
  }
  const installed = `T3 ${install.version ?? "?"} installed and verified`;
  if (runtime.pid === null) {
    if (runtime.protocol !== null) {
      return {
        id,
        status: "fail",
        summary: `a server answers on ${baseUrl}, but ${managed.homeDir} records no live managed T3`,
        hint: "stop whatever listens on that port, or change t3.port",
      };
    }
    if (serviceState?.alive === true) {
      return { id, status: "warn", summary: `${installed}; not running while service pid ${serviceState.pid} is up (restarting?)`, hint: "check `agent-tag service logs` for t3.runtime events" };
    }
    return { id, status: "pass", summary: `${installed}; not running (the Agent Tag service starts it)` };
  }
  if (runtime.problem !== null) {
    return { id, status: "fail", summary: `managed T3 pid ${runtime.pid}: ${runtime.problem}`, hint: "restart the service so it starts the pinned T3" };
  }
  const running = `${installed}; pid ${runtime.pid} serves protocol ${runtime.protocol ?? "?"} on ${baseUrl}`;
  if (serviceState?.alive !== true) {
    return { id, status: "warn", summary: `${running} without the Agent Tag service`, hint: "a foreground `agent-tag t3 serve`, or an orphan the next service start reaps" };
  }
  if (parentPid === null) {
    return { id, status: "warn", summary: `${running}, but its parent pid could not be read to confirm service pid ${serviceState.pid} started it` };
  }
  if (parentPid !== serviceState.pid) {
    return {
      id,
      status: "warn",
      summary: `${running}, but its parent is pid ${parentPid}, not service pid ${serviceState.pid}`,
      hint: "stop the other T3 (`agent-tag t3 serve`?) and restart the service",
    };
  }
  return { id, status: "pass", summary: `${running}, supervised by service pid ${serviceState.pid}` };
}
