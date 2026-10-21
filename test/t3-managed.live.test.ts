// Live managed-T3 checks (PR-O Done 3–8): a real download of the pinned release, `t3 serve`, the
// restricted token, `t3 status`, rotation with revocation, kill -9 recovery, orphan reaping, and the
// protocol gate against a real fake-T3 process. About 2 minutes; needs network access to GitHub.
//   RUN_T3_MANAGED=1 bun test test/t3-managed.live.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "../src/command.ts";
import { agentTagConfigSchema } from "../src/config.ts";
import { AgentTagService, type ServiceLogRecord, type ServiceWorker } from "../src/service.ts";
import { AgentTagStore } from "../src/store/store.ts";
import { issueT3AdminSession, revokeT3AdminSession } from "../src/t3/admin-session.ts";
import { assertRestrictedOrchestrationSession, inspectT3Session, isT3CredentialRejection, listT3AuthClients } from "../src/t3/auth.ts";
import { managedT3Credentials } from "../src/t3/credentials.ts";
import { createT3GateWorker, T3RuntimeGate } from "../src/t3/gate.ts";
import { inspectInstalledT3, installPinnedT3 } from "../src/t3/install.ts";
import { PINNED_T3, t3ArtifactFor } from "../src/t3/lock.ts";
import type { ManagedT3Config } from "../src/t3/operator.ts";
import { fetchT3EnvironmentDescriptor } from "../src/t3/protocol.ts";
import { readSecretFile } from "../src/security/secret-file.ts";
import { T3ManagedRuntime } from "../src/t3/supervisor.ts";
import { FAKE_PAIRING_TOKEN, FAKE_T3_BINARY } from "./fixtures/fake-t3/index.ts";

const enabled = Bun.env.RUN_T3_MANAGED === "1";
const repoRoot = join(import.meta.dir, "..");

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("no port");
  return port;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await Bun.sleep(50);
  }
}

async function serverRuntimePid(homeDir: string): Promise<number> {
  return JSON.parse(await readFile(join(homeDir, "userdata", "server-runtime.json"), "utf8")).pid;
}

/** A full config file for the CLI (`t3 status`, `t3 serve`); only `dataDir` and `t3` matter here. */
async function writeConfig(path: string, dataDir: string, t3: Record<string, unknown>): Promise<void> {
  const template = await Bun.file(join(repoRoot, "config", "agent-tag.example.json")).json();
  const config = { ...template, dataDir, t3 };
  agentTagConfigSchema.parse(config);
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

if (!enabled) {
  describe("managed T3 live", () => {
    test.skip("set RUN_T3_MANAGED=1 to download, run and rotate the pinned T3", () => {});
  });
} else {
  describe("managed T3 live (pinned release)", () => {
    let root: string;
    let configPath: string;
    let t3: ManagedT3Config;
    let binary: string;
    let runtime: T3ManagedRuntime | undefined;
    const logs: ServiceLogRecord[] = [];
    const outputs: string[] = [];
    const tokens: string[] = [];
    const logger = (record: ServiceLogRecord): void => {
      logs.push(record);
    };
    const events = (): string[] => logs.map((record) => record.event);

    /** Issues a short admin session from the managed home, runs `use`, and always revokes it. */
    async function withAdmin<T>(use: (token: import("../src/security/secret-file.ts").SecretString) => Promise<T>): Promise<T> {
      const admin = await issueT3AdminSession({ t3Bin: binary, baseDir: t3.managed.homeDir, label: "agent-tag-o4-verify", run: runCommand });
      try {
        return await use(admin.token);
      } finally {
        await revokeT3AdminSession({ t3Bin: binary, baseDir: t3.managed.homeDir, sessionId: admin.sessionId, run: runCommand });
      }
    }

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "agent-tag-o4-live-"));
      await chmod(root, 0o700);
      const dataDir = join(root, "data");
      await mkdir(join(root, "secrets"), { recursive: true, mode: 0o700 });
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const port = await freePort();
      configPath = join(root, "agent-tag.json");
      const raw = { mode: "managed", port, tokenFile: join(root, "secrets", "t3-token"), rotation: { rotateBeforeDays: 7, revokeGraceMinutes: 1 } };
      await writeConfig(configPath, dataDir, raw);
      const parsed = agentTagConfigSchema.parse(await Bun.file(configPath).json()).t3;
      if (parsed.mode !== "managed") throw new Error("expected managed");
      t3 = parsed;
    });

    afterAll(async () => {
      await runtime?.stop();
      await rm(root, { recursive: true, force: true });
    });

    test("Done 3: downloads, verifies and extracts the pinned release into an empty runtime dir", async () => {
      expect(Bun.which("t3", { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })).toBeNull();
      const artifact = t3ArtifactFor(PINNED_T3);
      if (artifact === undefined) throw new Error(`no pinned artifact for ${process.platform}-${process.arch}`);
      const installed = await installPinnedT3({ pin: PINNED_T3, runtimeDir: t3.managed.runtimeDir, log: (event, detail) => outputs.push(`${event} ${detail}`) });
      expect(installed.downloaded).toBe(true);
      expect(installed.archiveSha256).toBe(artifact.sha256);
      binary = installed.binary;
      const version = await runCommand([binary, "--version"]);
      expect(version.stdout.trim()).toBe(`t3 v${PINNED_T3.version}`);
      const status = await inspectInstalledT3({ pin: PINNED_T3, runtimeDir: t3.managed.runtimeDir });
      expect(status).toMatchObject({ installed: true, binarySha256Verified: true, filesVerified: true, version: PINNED_T3.version });
      console.log(`[o4-live] ${artifact.name} sha256 ${installed.archiveSha256} -> ${binary}`);
    }, 600_000);

    test("Done 3: starts t3 serve on loopback with the managed home and gates on version and protocol", async () => {
      runtime = new T3ManagedRuntime({ settings: t3.managed, installed: { binary, version: PINNED_T3.version }, logger });
      const descriptor = await runtime.start();
      expect(descriptor.serverVersion).toBe(PINNED_T3.version);
      expect(descriptor.orchestrationProtocol).toBe(1);
      const pid = runtime.status().pid;
      expect(pid).toBe(await serverRuntimePid(t3.managed.homeDir));
      const args = (await runCommand(["ps", "-ww", "-o", "args=", "-p", String(pid)])).stdout.trim();
      expect(args).toContain(`serve --host 127.0.0.1 --port ${t3.managed.port} --base-dir ${t3.managed.homeDir}`);
      console.log(`[o4-live] t3 pid ${pid}: ${args}`);
    }, 120_000);

    test("Done 3: mints a 0600 restricted token through a revoked admin session", async () => {
      const credentials = managedT3Credentials({ t3, binary, logger });
      expect(await credentials.ensureToken()).toBe("enrolled");
      expect((await stat(t3.tokenFile)).mode & 0o777).toBe(0o600);
      const token = await readSecretFile(t3.tokenFile);
      tokens.push(token.exposeToBoundary());
      assertRestrictedOrchestrationSession(await inspectT3Session({ baseUrl: t3.baseUrl, token }));
      expect(await credentials.ensureToken()).toBe("kept");
      const clients = await withAdmin((administrativeToken) => listT3AuthClients({ baseUrl: t3.baseUrl, administrativeToken }));
      const labels = (clients ?? []).map((client) => client.client?.label ?? "");
      // The enrollment admin session is gone; only the restricted client (and our verifier) remain.
      expect(labels.filter((label) => label.startsWith("agent-tag-rotate"))).toEqual([]);
      expect(labels.filter((label) => label.startsWith("agent-tag-orchestration-"))).toHaveLength(1);
      console.log(`[o4-live] clients after enroll: ${JSON.stringify(labels)}`);
    }, 60_000);

    test("Done 4: t3 status prints mode, version, sha, pid, protocol and token expiry without a secret", async () => {
      const result = await runCommand(["bun", "run", join(repoRoot, "src", "cli.ts"), "t3", "status", configPath]);
      expect(result.exitCode).toBe(0);
      outputs.push(result.stdout, result.stderr);
      const status = JSON.parse(result.stdout);
      expect(status).toMatchObject({
        mode: "managed",
        version: PINNED_T3.version,
        binarySha256Verified: true,
        pid: runtime?.status().pid,
        protocol: 1,
      });
      expect(status.token.expiresAt).toEqual(expect.any(String));
      expect(status.token.daysRemaining).toBeGreaterThan(29);
      console.log(`[o4-live] t3 status: ${result.stdout}`);
    }, 60_000);

    test("Done 5: rotation swaps the token file and revokes the replaced client after the grace period", async () => {
      const credentials = managedT3Credentials({ t3, binary, logger });
      const before = await credentials.check();
      const oldToken = await readSecretFile(t3.tokenFile);
      const rotated = await credentials.rotate("manual");
      const newToken = await readSecretFile(t3.tokenFile);
      tokens.push(newToken.exposeToBoundary());
      expect(newToken.exposeToBoundary()).not.toBe(oldToken.exposeToBoundary());
      expect(Date.parse(rotated.expiresAt)).toBeGreaterThanOrEqual(Date.parse(before.expiresAt));
      // Within the grace period the replaced token still works, so in-flight turns finish on it.
      assertRestrictedOrchestrationSession(await inspectT3Session({ baseUrl: t3.baseUrl, token: oldToken }));

      // Skip the one-minute grace with a clock two minutes ahead; maintain() then revokes.
      const later = managedT3Credentials({ t3, binary, logger, now: () => new Date(Date.now() + 120_000) });
      await later.maintain();
      expect(events()).toContain("t3.token.revoked");
      const rejected = await inspectT3Session({ baseUrl: t3.baseUrl, token: oldToken }).then(() => undefined, (error: unknown) => error);
      expect(isT3CredentialRejection(rejected)).toBe(true);
      assertRestrictedOrchestrationSession(await inspectT3Session({ baseUrl: t3.baseUrl, token: newToken }));
      const labels = ((await withAdmin((administrativeToken) => listT3AuthClients({ baseUrl: t3.baseUrl, administrativeToken }))) ?? [])
        .map((client) => client.client?.label ?? "");
      expect(labels.filter((label) => label.startsWith("agent-tag-orchestration-"))).toEqual([rotated.label]);
      console.log(`[o4-live] rotated to ${rotated.label} (expires ${rotated.expiresAt}); clients now ${JSON.stringify(labels)}`);
    }, 120_000);

    test("Done 6: kill -9 of T3 restarts it within 5 s and the token keeps working", async () => {
      if (runtime === undefined) throw new Error("runtime not started");
      const current = runtime;
      const pid = current.status().pid as number;
      const killedAt = Date.now();
      process.kill(pid, "SIGKILL");
      await until(async () => {
        const status = current.status();
        if (status.state !== "ready" || status.pid === pid) return false;
        return (await fetchT3EnvironmentDescriptor({ baseUrl: t3.baseUrl, signal: AbortSignal.timeout(1_000) }).then(() => true, () => false));
      }, 30_000, "the restarted T3");
      const elapsed = Date.now() - killedAt;
      expect(events()).toContain("t3.runtime.restarted");
      expect(elapsed).toBeLessThan(5_000);
      assertRestrictedOrchestrationSession(await inspectT3Session({ baseUrl: t3.baseUrl, token: await readSecretFile(t3.tokenFile) }));
      console.log(`[o4-live] kill -9 ${pid}: ready again as pid ${current.status().pid} after ${elapsed} ms`);
    }, 60_000);

    test("Done 6: kill -9 of the Agent Tag process leaves T3 behind, and the next start reaps it", async () => {
      await runtime?.stop();
      runtime = undefined;
      const serve = Bun.spawn(["bun", "run", join(repoRoot, "src", "cli.ts"), "t3", "serve", configPath], { stdout: "pipe", stderr: "pipe" });
      const reader = serve.stdout.getReader();
      let text = "";
      let ready: { pid: number } | undefined;
      while (ready === undefined) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`t3 serve exited: ${await new Response(serve.stderr).text()}`);
        text += new TextDecoder().decode(chunk.value);
        try {
          ready = JSON.parse(text);
        } catch {
          // Pretty-printed JSON arrives in pieces.
        }
      }
      outputs.push(text);
      const orphan = ready.pid;
      process.kill(serve.pid, "SIGKILL");
      await serve.exited;
      outputs.push(await new Response(serve.stderr).text());
      expect(alive(orphan)).toBe(true);

      const next = new T3ManagedRuntime({ settings: t3.managed, installed: { binary, version: PINNED_T3.version }, logger });
      runtime = next;
      await next.start();
      expect(alive(orphan)).toBe(false);
      expect(next.status().pid).not.toBe(orphan);
      expect(events()).toContain("t3.runtime.orphan_reaped");
      console.log(`[o4-live] agent-tag ${serve.pid} killed; orphan T3 ${orphan} reaped; new T3 pid ${next.status().pid}`);
    }, 120_000);

    test("Done 8: no token or pairing credential in any log or captured output", () => {
      const captured = `${JSON.stringify(logs)}\n${outputs.join("\n")}`;
      expect(tokens.length).toBeGreaterThanOrEqual(2);
      for (const token of tokens) expect(captured).not.toContain(token);
      expect(captured).not.toContain("/pair#token=");
      expect(captured).not.toContain("wsTicket=");
    });
  });

  describe("managed T3 live (protocol gate against a running fake T3)", () => {
    test("Done 7: a protocol switch closes the gate within 60 s, pausing T3 workers while the outbox runs; switching back reopens it", async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-tag-o4-gate-"));
      await chmod(root, 0o700);
      const homeDir = join(root, "home");
      await mkdir(homeDir, { recursive: true, mode: 0o700 });
      const controlFile = join(root, "control.json");
      await writeFile(controlFile, JSON.stringify({ protocol: 1 }));
      const port = await freePort();
      const logs: ServiceLogRecord[] = [];
      const logger = (record: ServiceLogRecord): void => {
        logs.push(record);
      };
      const runtime = new T3ManagedRuntime({
        settings: { port, homeDir, runtimeDir: join(root, "runtime") },
        installed: { binary: FAKE_T3_BINARY, version: PINNED_T3.version },
        logger,
        env: { ...process.env, FAKE_T3_CONTROL: controlFile },
      });
      const store = await AgentTagStore.open(join(root, "agent-tag.sqlite"));
      const calls = { coordinator: 0, outbox: 0 };
      const coordinator: ServiceWorker = {
        processNext: async () => {
          calls.coordinator += 1;
          return { kind: "idle" };
        },
      };
      const gate = new T3RuntimeGate({ baseUrl: `http://127.0.0.1:${port}`, pinnedVersion: PINNED_T3.version, logger });
      const service = new AgentTagService({
        store,
        bridge: {
          start: async () => {},
          stop: async () => {},
          deliverNextOutbox: async () => {
            calls.outbox += 1;
            return { kind: "idle" };
          },
        },
        coordinators: [coordinator],
        interactionWorkers: [{ processNext: async () => ({ kind: "idle" }) }],
        maintenanceWorkers: [createT3GateWorker({ gate })],
        idleMs: 20,
        logger,
        gate,
      });
      const at = (event: string): number => Date.parse(logs.filter((record) => record.event === event).at(-1)?.at ?? "");
      try {
        await runtime.start();
        await service.start();
        await until(() => gate.open && calls.coordinator > 0, 10_000, "the gate to open");

        const switchedAt = Date.now();
        await writeFile(controlFile, JSON.stringify({ protocol: 2 }));
        await until(() => !gate.open, 75_000, "the gate to close");
        const closedAfter = Date.now() - switchedAt;
        expect(closedAfter).toBeLessThanOrEqual(61_000);
        expect(logs.filter((record) => record.event === "t3.gate.closed")).toHaveLength(1);
        const paused = { ...calls };
        await Bun.sleep(1_000);
        expect(calls.coordinator).toBe(paused.coordinator);
        expect(calls.outbox).toBeGreaterThan(paused.outbox);

        const restoredAt = Date.now();
        await writeFile(controlFile, JSON.stringify({ protocol: 1 }));
        await until(() => gate.open && calls.coordinator > paused.coordinator, 20_000, "the gate to reopen and drain");
        expect(at("t3.gate.opened")).toBeGreaterThanOrEqual(restoredAt - 1_000);
        console.log(`[o4-live] gate closed ${closedAfter} ms after the switch to protocol 2 (${gate.reason ?? "open again"}); reopened ${Date.now() - restoredAt} ms after switching back`);
        console.log(`[o4-live] gate events: ${JSON.stringify(logs.filter((record) => record.event.startsWith("t3.gate.")))}`);
        expect(JSON.stringify(logs)).not.toContain(FAKE_PAIRING_TOKEN);
      } finally {
        await service.stop();
        await runtime.stop();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  });
}
