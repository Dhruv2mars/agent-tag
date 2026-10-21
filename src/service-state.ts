import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { T3StartupWait } from "./t3/startup.ts";

/** `<dataDir>/service-state.json`: what the running service is doing, for `agent-tag status` and doctor. */
export const SERVICE_STATE_FILE = "service-state.json";

const serviceStateSchema = z.object({
  state: z.enum(["waiting-for-t3", "running", "stopped"]),
  pid: z.number().int().positive(),
  since: z.string(),
  updatedAt: z.string(),
  t3: z
    .object({
      baseUrl: z.string(),
      attempts: z.number().int().nonnegative(),
      lastError: z.string(),
      nextAttemptAt: z.string(),
    })
    .optional(),
});

export type ServiceState = z.infer<typeof serviceStateSchema>;

/** The recorded state plus whether its process is still alive (a crashed service leaves a stale file). */
export type ServiceStateReport = ServiceState & { readonly alive: boolean };

export function serviceStatePath(dataDir: string): string {
  return join(dataDir, SERVICE_STATE_FILE);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another user, so it is not our service.
    return false;
  }
}

/** Undefined when no service has recorded a state yet, or the file is unreadable. */
export async function readServiceState(
  dataDir: string,
  alive: (pid: number) => boolean = processAlive,
): Promise<ServiceStateReport | undefined> {
  let raw: string;
  try {
    raw = await readFile(serviceStatePath(dataDir), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = serviceStateSchema.safeParse(parsed);
  if (!result.success) return undefined;
  return { ...result.data, alive: result.data.state !== "stopped" && alive(result.data.pid) };
}

/** Records service state transitions; writes are atomic and best-effort (a full disk must not stop the service). */
export class ServiceStateRecorder {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #pid: number;
  #state: ServiceState["state"] | undefined;
  #since = "";

  constructor(input: { readonly dataDir: string; readonly now: () => Date; readonly pid?: number }) {
    this.#path = serviceStatePath(input.dataDir);
    this.#now = input.now;
    this.#pid = input.pid ?? process.pid;
  }

  async waitingForT3(wait: T3StartupWait): Promise<void> {
    await this.#write("waiting-for-t3", wait);
  }

  async running(): Promise<void> {
    await this.#write("running");
  }

  async stopped(): Promise<void> {
    await this.#write("stopped");
  }

  async #write(state: ServiceState["state"], t3?: T3StartupWait): Promise<void> {
    const at = this.#now().toISOString();
    if (this.#state !== state) {
      this.#state = state;
      this.#since = at;
    }
    const record: ServiceState = {
      state,
      pid: this.#pid,
      since: this.#since,
      updatedAt: at,
      ...(t3 === undefined ? {} : { t3 }),
    };
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
