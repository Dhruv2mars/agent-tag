import { chmod, open, stat, truncate } from "node:fs/promises";

import type { ServiceLogger, ServiceWorker } from "./service.ts";

/** A launchd log grows without bound (launchd never rotates); cap it at 10 MiB and keep the last 1 MiB. */
export const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const SERVICE_LOG_KEEP_BYTES = 1024 * 1024;

/**
 * Moves the last `keepBytes` of an oversized log to `<path>.1` (replacing it) and truncates the log in
 * place. Truncating, not renaming, matters: launchd opens StandardOutPath/StandardErrorPath with
 * O_APPEND and hands that descriptor to the service, so after a truncate the next write lands at offset
 * 0 of the same file, while a renamed file would keep receiving every write. Returns the size before.
 */
export async function capServiceLog(
  path: string,
  limits: { readonly maxBytes: number; readonly keepBytes: number } = {
    maxBytes: SERVICE_LOG_MAX_BYTES,
    keepBytes: SERVICE_LOG_KEEP_BYTES,
  },
): Promise<{ readonly rotated: boolean; readonly bytes: number }> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { rotated: false, bytes: 0 };
  }
  if (size <= limits.maxBytes) return { rotated: false, bytes: size };
  const keep = Math.min(limits.keepBytes, size);
  const source = await open(path, "r");
  try {
    const buffer = Buffer.alloc(keep);
    await source.read(buffer, 0, keep, size - keep);
    // Start the kept tail at a line boundary so the first record in `.1` is whole.
    const newline = buffer.indexOf(0x0a);
    const tail = newline === -1 || newline === buffer.length - 1 ? buffer : buffer.subarray(newline + 1);
    const target = await open(`${path}.1`, "w", 0o600);
    try {
      await target.writeFile(tail);
    } finally {
      await target.close();
    }
    await chmod(`${path}.1`, 0o600);
  } finally {
    await source.close();
  }
  await truncate(path, 0);
  return { rotated: true, bytes: size };
}

/** Caps each log now and returns a maintenance worker that re-checks them every `intervalMs`. */
export async function createServiceLogWorker(input: {
  readonly paths: readonly string[];
  readonly logger: ServiceLogger;
  readonly now: () => Date;
  readonly intervalMs?: number;
}): Promise<ServiceWorker> {
  const intervalMs = input.intervalMs ?? 5 * 60_000;
  const capAll = async (): Promise<boolean> => {
    let rotated = false;
    for (const path of input.paths) {
      const result = await capServiceLog(path).catch(() => ({ rotated: false, bytes: 0 }));
      if (!result.rotated) continue;
      rotated = true;
      input.logger({
        level: "info",
        event: "service.log.rotated",
        at: input.now().toISOString(),
        count: result.bytes,
        detail: `${path} was ${result.bytes} bytes; kept the last ${SERVICE_LOG_KEEP_BYTES} in ${path}.1`,
      });
    }
    return rotated;
  };
  await capAll();
  let nextCheckAt = input.now().getTime() + intervalMs;
  return {
    requiresT3: false,
    processNext: async () => {
      const current = input.now().getTime();
      if (current < nextCheckAt) return { kind: "idle" };
      nextCheckAt = current + intervalMs;
      return { kind: (await capAll()) ? "log-rotated" : "idle" };
    },
  };
}
