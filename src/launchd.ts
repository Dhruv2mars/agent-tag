import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { type CommandRunner, requireSuccess, runCommand } from "./command.ts";
import { loadConfig } from "./config.ts";
import { installedUnitPaths, NOT_INSTALLED, type ServiceUnitPaths, type ServiceUnitState, unitStateFor } from "./service-unit.ts";

export const AGENT_TAG_LAUNCHD_LABEL = "dev.agent-tag.service";

export interface LaunchAgentDefinition {
  readonly label: string;
  readonly bunPath: string;
  readonly cliPath: string;
  readonly configPath: string;
  readonly workingDirectory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface LaunchAgentStatus {
  readonly label: string;
  readonly plistPath: string;
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly running: boolean;
}

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlString(value: string): string {
  return `<string>${xmlText(value)}</string>`;
}

export function renderLaunchAgent(input: LaunchAgentDefinition): string {
  const paths = [
    input.bunPath,
    input.cliPath,
    input.configPath,
    input.workingDirectory,
    input.stdoutPath,
    input.stderrPath,
  ];
  if (paths.some((path) => !isAbsolute(path))) {
    throw new Error("LaunchAgent paths must be absolute");
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(input.label)) throw new Error("invalid LaunchAgent label");
  const argumentsXml = [input.bunPath, "run", input.cliPath, "run", input.configPath]
    .map((argument) => `      ${xmlString(argument)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${xmlString(input.label)}
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key>
  ${xmlString(input.workingDirectory)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  ${xmlString(input.stdoutPath)}
  <key>StandardErrorPath</key>
  ${xmlString(input.stderrPath)}
</dict>
</plist>
`;
}

/** The launchctl seam: tests pass a fake runner so nothing touches the real user domain. */
export interface LaunchdHost {
  readonly run: CommandRunner;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly uid: number;
  readonly plistPath: string;
}

async function requireCommand(host: LaunchdHost, command: readonly string[], description: string): Promise<void> {
  await requireSuccess(host.run, command, description);
}

async function pathExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${AGENT_TAG_LAUNCHD_LABEL}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function ensurePrivateLog(path: string): Promise<void> {
  const file = await open(path, "a", 0o600);
  await file.close();
  await chmod(path, 0o600);
}

function launchctlTarget(uid: number): string {
  return `gui/${uid}/${AGENT_TAG_LAUNCHD_LABEL}`;
}

function launchctlDomain(uid: number): string {
  return `gui/${uid}`;
}

async function runtimeStatus(host: LaunchdHost): Promise<{ readonly loaded: boolean; readonly running: boolean }> {
  const result = await host.run(["/bin/launchctl", "print", launchctlTarget(host.uid)]);
  return {
    loaded: result.exitCode === 0,
    running: result.exitCode === 0 && /^\s*state = running$/m.test(result.stdout),
  };
}

async function waitUntilRunning(host: LaunchdHost): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await runtimeStatus(host)).running) return true;
    await host.sleep(100);
  }
  return false;
}

async function bootstrap(host: LaunchdHost, description: string): Promise<void> {
  await requireCommand(host, ["/bin/launchctl", "bootstrap", launchctlDomain(host.uid), host.plistPath], description);
}

async function bootoutAndWait(host: LaunchdHost, description: string): Promise<void> {
  await requireCommand(host, ["/bin/launchctl", "bootout", launchctlTarget(host.uid)], description);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await runtimeStatus(host)).loaded) {
      await host.sleep(250);
      return;
    }
    await host.sleep(100);
  }
  throw new Error(`${description} did not remove the LaunchAgent from its domain`);
}

function requireMacOS(): number {
  if (process.platform !== "darwin") throw new Error("LaunchAgent management is supported only on macOS");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("LaunchAgent management requires a user id");
  return uid;
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${AGENT_TAG_LAUNCHD_LABEL}.plist`);
}

function defaultLaunchdHost(): LaunchdHost {
  return { run: runCommand, sleep: (milliseconds) => Bun.sleep(milliseconds), uid: requireMacOS(), plistPath: plistPath() };
}

export function launchAgentPlistPath(): string {
  return plistPath();
}

export async function launchAgentDefinition(configPathInput: string): Promise<LaunchAgentDefinition> {
  return definition(configPathInput);
}

async function definition(configPathInput: string): Promise<LaunchAgentDefinition> {
  const configPath = resolve(configPathInput);
  await loadConfig(configPath);
  const repositoryRoot = resolve(import.meta.dir, "..");
  const logDirectory = join(homedir(), "Library", "Logs", "AgentTag");
  return {
    label: AGENT_TAG_LAUNCHD_LABEL,
    bunPath: process.execPath,
    cliPath: join(repositoryRoot, "src", "cli.ts"),
    configPath,
    workingDirectory: repositoryRoot,
    stdoutPath: join(logDirectory, "service.stdout.log"),
    stderrPath: join(logDirectory, "service.stderr.log"),
  };
}

async function doctor(input: LaunchAgentDefinition): Promise<void> {
  await requireSuccess(
    runCommand,
    [input.bunPath, "run", input.cliPath, "doctor", input.configPath],
    "Agent Tag doctor",
  );
}

async function prepareFiles(input: LaunchAgentDefinition): Promise<void> {
  await mkdir(dirname(plistPath()), { recursive: true });
  await mkdir(dirname(input.stdoutPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(input.stdoutPath), 0o700);
  await ensurePrivateLog(input.stdoutPath);
  await ensurePrivateLog(input.stderrPath);
}

export async function launchAgentStatus(host: LaunchdHost = defaultLaunchdHost()): Promise<LaunchAgentStatus> {
  const runtime = await runtimeStatus(host);
  return {
    label: AGENT_TAG_LAUNCHD_LABEL,
    plistPath: host.plistPath,
    installed: await pathExists(host.plistPath),
    loaded: runtime.loaded,
    running: runtime.running,
  };
}

export async function installLaunchAgent(configPath: string): Promise<LaunchAgentStatus> {
  const host = defaultLaunchdHost();
  const path = host.plistPath;
  if (await pathExists(path) || (await runtimeStatus(host)).loaded) {
    throw new Error("Agent Tag LaunchAgent is already installed; use service:upgrade");
  }
  const input = await definition(configPath);
  await doctor(input);
  await prepareFiles(input);
  await writePrivateFile(path, renderLaunchAgent(input));
  try {
    await bootstrap(host, "LaunchAgent bootstrap");
    if (!(await waitUntilRunning(host))) throw new Error("LaunchAgent did not reach running state");
  } catch (error) {
    if ((await runtimeStatus(host)).loaded) {
      await bootoutAndWait(host, "LaunchAgent rollback");
    }
    await rm(path, { force: true });
    throw error;
  }
  return launchAgentStatus(host);
}

export async function upgradeLaunchAgent(configPath: string): Promise<LaunchAgentStatus> {
  const host = defaultLaunchdHost();
  const path = host.plistPath;
  if (!(await pathExists(path))) throw new Error("Agent Tag LaunchAgent is not installed");
  const input = await definition(configPath);
  await doctor(input);
  const prior = await readFile(path, "utf8");
  const loaded = (await runtimeStatus(host)).loaded;
  if (loaded) {
    await bootoutAndWait(host, "LaunchAgent bootout");
  }
  await prepareFiles(input);
  await writePrivateFile(path, renderLaunchAgent(input));
  try {
    await bootstrap(host, "LaunchAgent bootstrap");
    if (!(await waitUntilRunning(host))) throw new Error("LaunchAgent did not reach running state");
  } catch (error) {
    if ((await runtimeStatus(host)).loaded) {
      await bootoutAndWait(host, "LaunchAgent failed-upgrade cleanup");
    }
    await writePrivateFile(path, prior);
    if (loaded) {
      await bootstrap(host, "LaunchAgent rollback");
    }
    throw error;
  }
  return launchAgentStatus(host);
}

export async function uninstallLaunchAgent(): Promise<LaunchAgentStatus> {
  const host = defaultLaunchdHost();
  if ((await runtimeStatus(host)).loaded) {
    await bootoutAndWait(host, "LaunchAgent bootout");
  }
  await rm(host.plistPath, { force: true });
  return launchAgentStatus(host);
}

/**
 * Restarts the installed LaunchAgent. A plist can be on disk while its job is not registered in the
 * user domain (for example after `launchctl bootout` or a failed bootstrap); `kickstart` cannot reach
 * an unregistered target, so the existing plist is bootstrapped first and then started.
 */
export async function restartLaunchAgent(host: LaunchdHost = defaultLaunchdHost()): Promise<LaunchAgentStatus> {
  if (!(await pathExists(host.plistPath))) throw new Error("Agent Tag LaunchAgent is not installed");
  if ((await runtimeStatus(host)).loaded) {
    await requireCommand(host, ["/bin/launchctl", "kickstart", "-k", launchctlTarget(host.uid)], "LaunchAgent restart");
  } else {
    await bootstrap(host, "LaunchAgent bootstrap");
    // RunAtLoad normally starts the job; without -k this only starts it if it is not already running.
    await requireCommand(host, ["/bin/launchctl", "kickstart", launchctlTarget(host.uid)], "LaunchAgent start");
  }
  if (!(await waitUntilRunning(host))) throw new Error("LaunchAgent did not reach running state");
  return launchAgentStatus(host);
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** Reads the program arguments and working directory back out of an installed plist. */
export function parseLaunchAgentPaths(plist: string): Partial<ServiceUnitPaths> {
  const argumentsXml = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  const programArguments = argumentsXml === undefined
    ? []
    : [...argumentsXml.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1] ?? ""));
  const workingDirectory = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(plist)?.[1];
  return installedUnitPaths(programArguments, workingDirectory === undefined ? undefined : xmlUnescape(workingDirectory));
}

/** Compares the installed plist with the one this checkout would generate for `configPath`. */
export async function launchAgentUnitState(configPath: string): Promise<ServiceUnitState> {
  const path = plistPath();
  if (!(await pathExists(path))) return { unitPath: path, ...NOT_INSTALLED };
  const existing = await readFile(path, "utf8");
  const input = await definition(configPath);
  return unitStateFor({
    unitPath: path,
    existing,
    rendered: renderLaunchAgent(input),
    installed: parseLaunchAgentPaths(existing),
    expected: input,
  });
}

export function launchAgentLogsCommand(input: { readonly lines: number; readonly follow: boolean }): string[] {
  const logDirectory = join(homedir(), "Library", "Logs", "AgentTag");
  return [
    "/usr/bin/tail",
    "-n",
    String(input.lines),
    ...(input.follow ? ["-F"] : []),
    join(logDirectory, "service.stdout.log"),
    join(logDirectory, "service.stderr.log"),
  ];
}
