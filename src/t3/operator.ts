import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { CommandRunner } from "../command.ts";
import type { ResolvedT3Config } from "../config.ts";
import { readSecretFile } from "../security/secret-file.ts";
import type { ServiceLogger } from "../service.ts";
import { managedT3Credentials, T3CredentialLifecycle } from "./credentials.ts";
import { inspectInstalledT3 } from "./install.ts";
import type { T3Pin } from "./pin.ts";
import { type EnvironmentFetch, fetchT3EnvironmentDescriptor, t3DescriptorProblem } from "./protocol.ts";
import {
  type ManagedT3Binary,
  prepareManagedT3Binary,
  redactT3Output,
  T3ManagedRuntime,
  type T3ManagedRuntimeOptions,
} from "./supervisor.ts";

export type ManagedT3Config = Extract<ResolvedT3Config, { readonly mode: "managed" }>;

export function requireManagedT3(t3: ResolvedT3Config, command: string): ManagedT3Config {
  if (t3.mode !== "managed") {
    throw new Error(`t3 ${command} needs t3.mode "managed"; this config uses an external T3 at ${t3.baseUrl}`);
  }
  return t3;
}

/** Resolves on SIGINT/SIGTERM with "signal", or with "fatal" when `onFatal` reports a crash loop. */
export function waitForShutdownOrFatal(onFatal?: (listener: (error: Error) => void) => void): Promise<"signal" | "fatal"> {
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (reason: "signal" | "fatal"): void => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolveWait(reason);
    };
    const onSignal = (): void => finish("signal");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    onFatal?.(() => finish("fatal"));
  });
}

/** Exit code when the managed T3 crash-loops: EX_TEMPFAIL, so launchd/systemd restart Agent Tag. */
export const T3_FATAL_EXIT_CODE = 75;

/**
 * `agent-tag t3 serve CONFIG`: the managed runtime in the foreground, without Slack. Prints
 * `{baseUrl, pid, version, homeDir}` once ready, then runs until a signal or a crash loop.
 */
export async function runManagedT3Serve(input: {
  readonly t3: ManagedT3Config;
  readonly pin: T3Pin;
  readonly logger: ServiceLogger;
  readonly print: (line: string) => void;
  readonly wait?: typeof waitForShutdownOrFatal;
  /** Tests: skip install with an already verified binary, and tune the runtime (env, timing). */
  readonly installed?: ManagedT3Binary;
  readonly runtimeOptions?: Partial<Omit<T3ManagedRuntimeOptions, "settings" | "installed" | "logger">>;
}): Promise<number> {
  const installed = input.installed
    ?? (await prepareManagedT3Binary({ settings: input.t3.managed, pin: input.pin, logger: input.logger }));
  const runtime = new T3ManagedRuntime({
    ...input.runtimeOptions,
    settings: input.t3.managed,
    installed,
    logger: input.logger,
  });
  const descriptor = await runtime.start();
  try {
    input.print(JSON.stringify({
      baseUrl: runtime.baseUrl,
      pid: runtime.status().pid,
      version: descriptor.serverVersion,
      protocol: descriptor.orchestrationProtocol,
      homeDir: input.t3.managed.homeDir,
    }, null, 2));
    const reason = await (input.wait ?? waitForShutdownOrFatal)((listener) => runtime.onFatal(listener));
    return reason === "fatal" ? T3_FATAL_EXIT_CODE : 0;
  } finally {
    await runtime.stop();
  }
}

const serverRuntimeSchema = z.object({ pid: z.number().int().positive() });

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The `runtime` part of `t3 status` for managed mode, read from `server-runtime.json` and the
 * environment descriptor; works whether or not Agent Tag is running and never starts T3.
 */
export async function inspectManagedT3Runtime(input: {
  readonly t3: ManagedT3Config;
  readonly pinnedVersion: string;
  readonly fetch?: EnvironmentFetch;
}): Promise<{
  readonly running: boolean;
  readonly pid: number | null;
  readonly protocol: number | null;
  readonly serverVersion: string | null;
  readonly problem: string | null;
}> {
  let pid: number | null = null;
  try {
    const parsed = serverRuntimeSchema.safeParse(
      JSON.parse(await readFile(join(input.t3.managed.homeDir, "userdata", "server-runtime.json"), "utf8")),
    );
    if (parsed.success && processAlive(parsed.data.pid)) pid = parsed.data.pid;
  } catch {
    pid = null;
  }
  try {
    const descriptor = await fetchT3EnvironmentDescriptor({
      baseUrl: input.t3.baseUrl,
      signal: AbortSignal.timeout(3_000),
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    return {
      running: pid !== null,
      pid,
      protocol: descriptor.orchestrationProtocol,
      serverVersion: descriptor.serverVersion ?? null,
      problem: t3DescriptorProblem(descriptor, { pinnedVersion: input.pinnedVersion })?.message ?? null,
    };
  } catch (error) {
    return {
      running: false,
      pid,
      protocol: null,
      serverVersion: null,
      problem: `not reachable on ${input.t3.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const pairingSchema = z.object({
  pairUrl: z.string().min(1).optional(),
  credential: z.string().min(1).optional(),
  expiresAt: z.string().min(1),
});

/**
 * `agent-tag t3 pair CONFIG`: a 5-minute pairing link for the T3 web UI of the managed runtime.
 * The link is a credential: it goes to the operator's terminal only (refused when stdout is not a
 * TTY unless explicitly allowed) and never into an error message or log.
 */
export async function runManagedT3Pair(input: {
  readonly t3: ManagedT3Config;
  readonly pin: T3Pin;
  readonly run: CommandRunner;
  readonly stdoutIsTty: boolean;
  readonly allowNonTty: boolean;
  readonly print: (line: string) => void;
  readonly fetch?: EnvironmentFetch;
  /** Tests: stands in for the read-only install check. */
  readonly inspectInstall?: typeof inspectInstalledT3;
}): Promise<number> {
  if (!input.stdoutIsTty && !input.allowNonTty) {
    throw new Error("t3 pair prints a live credential; run it in a terminal (or pass --allow-non-tty to print it anyway)");
  }
  const { managed, baseUrl } = input.t3;
  const install = await (input.inspectInstall ?? inspectInstalledT3)({ pin: input.pin, runtimeDir: managed.runtimeDir });
  if (!install.filesVerified || install.binary === null) {
    throw new Error(
      `managed T3 ${input.pin.version} is not installed and verified in ${managed.runtimeDir}${install.problem === null ? "" : ` (${install.problem})`}; run \`agent-tag t3 install CONFIG\``,
    );
  }
  const runtime = await inspectManagedT3Runtime({
    t3: input.t3,
    pinnedVersion: input.pin.version,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  if (!runtime.running || runtime.problem !== null) {
    throw new Error(
      `managed T3 is not running and ready on ${baseUrl}${runtime.problem === null ? "" : ` (${runtime.problem})`}; start Agent Tag or \`agent-tag t3 serve CONFIG\` first`,
    );
  }
  const result = await input.run([
    install.binary,
    "auth",
    "pairing",
    "create",
    "--base-dir",
    managed.homeDir,
    "--ttl",
    "5m",
    "--label",
    "agent-tag-operator",
    "--base-url",
    baseUrl,
    "--json",
  ]);
  if (result.exitCode !== 0) {
    // stdout may hold a credential; only redacted stderr is surfaced.
    const stderr = redactT3Output(result.stderr).slice(0, 2_000);
    throw new Error(`t3 auth pairing create failed with exit code ${result.exitCode}${stderr.length === 0 ? "" : `: ${stderr}`}`);
  }
  let pairing: z.infer<typeof pairingSchema>;
  try {
    pairing = pairingSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new Error("t3 auth pairing create returned an unrecognized response");
  }
  const link = pairing.pairUrl ?? (pairing.credential === undefined ? undefined : `${baseUrl}/pair#token=${pairing.credential}`);
  if (link === undefined) throw new Error("t3 auth pairing create returned no pairing link");
  input.print(`Open this link to pair a browser with the managed T3 (expires ${pairing.expiresAt}; do not share it):`);
  input.print(link);
  return 0;
}

/** How `t3 rotate` gets an admin credential in external mode (onboard's flags). */
export type ExternalT3AdminFlags =
  | { readonly adminTokenFile: string }
  | { readonly t3BaseDir: string; readonly t3Bin: string };

/**
 * `agent-tag t3 rotate CONFIG`: mints a new restricted token and swaps it in atomically while
 * Agent Tag keeps running. Managed mode uses the installed binary and `homeDir`, records the old
 * token, and a running service revokes it after `rotation.revokeGraceMinutes`. External mode takes
 * an admin credential from flags; its old token is not revoked and expires on its own.
 * Prints `{mode, label, expiresAt, daysRemaining, …}`; never a token.
 */
export async function runT3Rotate(input: {
  readonly t3: ResolvedT3Config;
  readonly pin: T3Pin;
  readonly run: CommandRunner;
  readonly logger: ServiceLogger;
  readonly print: (line: string) => void;
  readonly external?: ExternalT3AdminFlags;
  readonly fetch?: EnvironmentFetch;
  readonly now?: () => Date;
  /** Tests: stands in for the read-only install check. */
  readonly inspectInstall?: typeof inspectInstalledT3;
}): Promise<number> {
  const { t3 } = input;
  const now = input.now ?? (() => new Date());
  let credentials: T3CredentialLifecycle;
  if (t3.mode === "managed") {
    if (input.external !== undefined) {
      throw new Error("--admin-token-file, --t3-base-dir and --t3-bin only apply to t3.mode external; managed mode uses its own runtime");
    }
    const install = await (input.inspectInstall ?? inspectInstalledT3)({ pin: input.pin, runtimeDir: t3.managed.runtimeDir });
    if (!install.filesVerified || install.binary === null) {
      throw new Error(
        `managed T3 ${input.pin.version} is not installed and verified in ${t3.managed.runtimeDir}${install.problem === null ? "" : ` (${install.problem})`}; run \`agent-tag t3 install CONFIG\``,
      );
    }
    const runtime = await inspectManagedT3Runtime({
      t3,
      pinnedVersion: input.pin.version,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    if (!runtime.running || runtime.problem !== null) {
      throw new Error(
        `managed T3 is not running and ready on ${t3.baseUrl}${runtime.problem === null ? "" : ` (${runtime.problem})`}; start Agent Tag or \`agent-tag t3 serve CONFIG\` first`,
      );
    }
    credentials = managedT3Credentials({ t3, binary: install.binary, logger: input.logger, now, run: input.run });
  } else {
    if (input.external === undefined) {
      throw new Error("t3 rotate in external mode needs --admin-token-file FILE, or --t3-base-dir DIR [--t3-bin BIN] for the T3 at " + t3.baseUrl);
    }
    // The admin credential only goes to a server that passes the protocol check.
    const descriptor = await fetchT3EnvironmentDescriptor({
      baseUrl: t3.baseUrl,
      signal: AbortSignal.timeout(5_000),
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    const problem = t3DescriptorProblem(descriptor, {});
    if (problem !== undefined) throw new Error(`refusing to rotate against T3 at ${t3.baseUrl}: ${problem.message}`);
    const flags = input.external;
    credentials = new T3CredentialLifecycle({
      mode: "external",
      baseUrl: t3.baseUrl,
      tokenFile: t3.tokenFile,
      admin: "adminTokenFile" in flags
        ? { kind: "token", token: await readSecretFile(flags.adminTokenFile) }
        : { kind: "cli", t3Bin: flags.t3Bin, baseDir: flags.t3BaseDir, run: input.run },
      logger: input.logger,
      now,
    });
  }
  const rotated = await credentials.rotate("manual");
  input.print(JSON.stringify({
    mode: t3.mode,
    tokenFile: t3.tokenFile,
    label: rotated.label,
    expiresAt: rotated.expiresAt,
    daysRemaining: rotated.daysRemaining,
    previousToken: t3.mode === "managed"
      ? `revoked by the running service after ${t3.managed.rotation.revokeGraceMinutes} minutes`
      : "not revoked; it expires on its own",
  }, null, 2));
  return 0;
}
