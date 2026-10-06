// Shared helpers for store modules.
import type { Database } from "bun:sqlite";

import { nonEmpty } from "./schema.ts";
import type { StoreFaultPoint } from "./types.ts";

/** What a store module needs when it also has to fire fault-injection points. */
export interface StoreContext {
  readonly database: Database;
  readonly faultInjector: (point: StoreFaultPoint) => void;
}

export function requiredId(value: string, name: string): string {
  const parsed = nonEmpty.safeParse(value);
  if (!parsed.success) throw new Error(`${name} must not be empty`);
  return parsed.data;
}

export function parseStoredJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}
