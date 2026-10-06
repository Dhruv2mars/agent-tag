import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Bun resolves bare `undici` to its built-in module, which lacks the ping API
// used by Slack Socket Mode. Keep the package WebSocket and frame API together.
const websocketExports = [
  "Agent",
  "buildConnector",
  "fetch",
  "WebSocket",
  "ErrorEvent",
  "MessageEvent",
  "CloseEvent",
  "ping",
];

function asExports(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

export function copyUndiciWebSocketExports(
  target: object,
  source: object,
): boolean {
  if (typeof Reflect.get(target, "ping") === "function") return false;
  for (const key of websocketExports) {
    const value = Reflect.get(source, key);
    if (value !== undefined) Reflect.set(target, key, value);
  }
  return typeof Reflect.get(target, "ping") === "function";
}

export function installUndiciWebSocketCompat(): void {
  const target = asExports(require("undici"));
  const source = asExports(require("undici/index.js"));
  if (target === undefined || source === undefined) throw new Error("undici Socket Mode transport is unavailable");
  copyUndiciWebSocketExports(target, source);
  if (typeof Reflect.get(target, "ping") !== "function") {
    throw new Error("undici Socket Mode ping is unavailable");
  }
}
