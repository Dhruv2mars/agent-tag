// Lease helpers shared by the operation, interaction, outbox and schedule queues.
import { isoDateTime } from "./schema.ts";

export function leaseExpiry(now: string, leaseMs: number): string {
  const parsedNow = isoDateTime.parse(now);
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
  return new Date(new Date(parsedNow).getTime() + leaseMs).toISOString();
}
