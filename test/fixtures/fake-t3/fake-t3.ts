// Run through the `t3` shim next to this file. Keep FAKE_PAIRING_TOKEN in sync with index.ts.
// A stand-in for the T3 CLI, driven by a JSON control file at $FAKE_T3_CONTROL (re-read on every
// request, so a test can change what the running server reports). It implements `--version`,
// `serve` (descriptor, `userdata/server-runtime.json`, a fake pairing credential on stdout and
// stderr, crash and SIGTERM-ignoring modes) and `auth pairing create --json`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Control {
  readonly version?: string;
  readonly serverVersion?: string;
  readonly protocol?: number;
  readonly environmentId?: string;
  /** Exit with this code right after printing the pairing details (before writing server-runtime.json). */
  readonly exitAtStartup?: number;
  /** Write this pid into server-runtime.json instead of our own. */
  readonly runtimePid?: number;
  readonly ignoreSigterm?: boolean;
  /** Where `serve` writes the environment it was started with. */
  readonly envFile?: string;
  readonly pairingCredential?: string;
}

function control(): Control {
  const path = process.env.FAKE_T3_CONTROL;
  if (path === undefined) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Control;
  } catch {
    return {};
  }
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const FAKE_PAIRING_TOKEN = "fake-pairing-credential-7f3a9c";

const args = process.argv.slice(2);
const initial = control();

if (args[0] === "--version") {
  console.log(`t3 v${initial.version ?? "0.0.45"}`);
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "pairing" && args[2] === "create") {
  const credential = initial.pairingCredential ?? FAKE_PAIRING_TOKEN;
  console.log(JSON.stringify({ credential, expiresAt: "2026-10-09T12:05:00.000Z" }));
  process.exit(0);
}

if (args[0] === "serve") {
  const port = Number(option(args, "--port"));
  const baseDir = option(args, "--base-dir") ?? ".";
  if (initial.envFile !== undefined) writeFileSync(initial.envFile, JSON.stringify(process.env));
  // The real `t3 serve` prints headless pairing details (a live credential) on startup.
  console.log(`Pair a browser: http://127.0.0.1:${port}/pair#token=${FAKE_PAIRING_TOKEN}`);
  console.error(`pairing link http://127.0.0.1:${port}/pair#token=${FAKE_PAIRING_TOKEN}`);
  console.error(`{"token":"${FAKE_PAIRING_TOKEN}"}`);
  console.error("fake t3 serve starting");
  if (initial.exitAtStartup !== undefined) process.exit(initial.exitAtStartup);
  if (initial.ignoreSigterm === true) process.on("SIGTERM", () => {});
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const current = control();
      if (new URL(request.url).pathname !== "/.well-known/t3/environment") return new Response("not found", { status: 404 });
      return Response.json({
        environmentId: current.environmentId ?? "env-fake-1",
        serverVersion: current.serverVersion ?? current.version ?? "0.0.45",
        orchestrationProtocolVersion: current.protocol ?? 1,
      });
    },
  });
  mkdirSync(join(baseDir, "userdata"), { recursive: true });
  writeFileSync(
    join(baseDir, "userdata", "server-runtime.json"),
    JSON.stringify({ version: 1, pid: initial.runtimePid ?? process.pid, host: "127.0.0.1", port }),
  );
} else {
  console.error(`fake t3: unsupported command ${args.join(" ")}`);
  process.exit(2);
}
