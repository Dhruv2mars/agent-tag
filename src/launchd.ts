import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { loadConfig } from "./config.ts";

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

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(command: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function requireCommand(command: readonly string[], description: string): Promise<void> {
  const result = await runCommand(command);
  if (result.exitCode !== 0) {
    throw new Error(`${description} failed with exit code ${result.exitCode}: ${result.stderr}`);
  }
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

async function runtimeStatus(uid: number): Promise<{ readonly loaded: boolean; readonly running: boolean }> {
  const result = await runCommand(["/bin/launchctl", "print", launchctlTarget(uid)]);
  return {
    loaded: result.exitCode === 0,
    running: result.exitCode === 0 && /^\s*state = running$/m.test(result.stdout),
  };
}

async function waitUntilRunning(uid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await runtimeStatus(uid)).running) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function bootoutAndWait(uid: number, description: string): Promise<void> {
  await requireCommand(["/bin/launchctl", "bootout", launchctlTarget(uid)], description);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await runtimeStatus(uid)).loaded) {
      await Bun.sleep(250);
      return;
    }
    await Bun.sleep(100);
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
  await requireCommand(
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

export async function launchAgentStatus(): Promise<LaunchAgentStatus> {
  const uid = requireMacOS();
  const path = plistPath();
  const runtime = await runtimeStatus(uid);
  return {
    label: AGENT_TAG_LAUNCHD_LABEL,
    plistPath: path,
    installed: await pathExists(path),
    loaded: runtime.loaded,
    running: runtime.running,
  };
}

export async function installLaunchAgent(configPath: string): Promise<LaunchAgentStatus> {
  const uid = requireMacOS();
  const path = plistPath();
  if (await pathExists(path) || (await runtimeStatus(uid)).loaded) {
    throw new Error("Agent Tag LaunchAgent is already installed; use service:upgrade");
  }
  const input = await definition(configPath);
  await doctor(input);
  await prepareFiles(input);
  await writePrivateFile(path, renderLaunchAgent(input));
  try {
    await requireCommand(
      ["/bin/launchctl", "bootstrap", launchctlDomain(uid), path],
      "LaunchAgent bootstrap",
    );
    if (!(await waitUntilRunning(uid))) throw new Error("LaunchAgent did not reach running state");
  } catch (error) {
    if ((await runtimeStatus(uid)).loaded) {
      await bootoutAndWait(uid, "LaunchAgent rollback");
    }
    await rm(path, { force: true });
    throw error;
  }
  return launchAgentStatus();
}

export async function upgradeLaunchAgent(configPath: string): Promise<LaunchAgentStatus> {
  const uid = requireMacOS();
  const path = plistPath();
  if (!(await pathExists(path))) throw new Error("Agent Tag LaunchAgent is not installed");
  const input = await definition(configPath);
  await doctor(input);
  const prior = await readFile(path, "utf8");
  const loaded = (await runtimeStatus(uid)).loaded;
  if (loaded) {
    await bootoutAndWait(uid, "LaunchAgent bootout");
  }
  await prepareFiles(input);
  await writePrivateFile(path, renderLaunchAgent(input));
  try {
    await requireCommand(
      ["/bin/launchctl", "bootstrap", launchctlDomain(uid), path],
      "LaunchAgent bootstrap",
    );
    if (!(await waitUntilRunning(uid))) throw new Error("LaunchAgent did not reach running state");
  } catch (error) {
    if ((await runtimeStatus(uid)).loaded) {
      await bootoutAndWait(uid, "LaunchAgent failed-upgrade cleanup");
    }
    await writePrivateFile(path, prior);
    if (loaded) {
      await requireCommand(
        ["/bin/launchctl", "bootstrap", launchctlDomain(uid), path],
        "LaunchAgent rollback",
      );
    }
    throw error;
  }
  return launchAgentStatus();
}

export async function uninstallLaunchAgent(): Promise<LaunchAgentStatus> {
  const uid = requireMacOS();
  const path = plistPath();
  if ((await runtimeStatus(uid)).loaded) {
    await bootoutAndWait(uid, "LaunchAgent bootout");
  }
  await rm(path, { force: true });
  return launchAgentStatus();
}
