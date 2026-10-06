// Lease helpers shared by the operation, interaction, outbox and schedule queues.
import { isoDateTime } from "./schema.ts";

export function leaseExpiry(now: string, leaseMs: number): string {
  const parsedNow = isoDateTime.parse(now);
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
  return new Date(new Date(parsedNow).getTime() + leaseMs).toISOString();
}

/** Error text per leased queue when a lease-guarded write no longer matches the caller's lease. */
const LEASE_LOST_MESSAGES = {
  operation: "operation lease is missing, expired, or owned by another worker",
  interaction: "interaction lease is missing, expired, or owned by another worker",
  outbox: "outbox lease is missing, expired, or owned by another worker",
  schedule: "schedule lease is missing, expired, or cancelled",
} as const;

export type LeasedQueue = keyof typeof LEASE_LOST_MESSAGES;

/**
 * Throws unless a lease-guarded UPDATE (`... AND lease_owner = ? AND lease_expires_at > ?`) changed
 * exactly one row, i.e. the caller still held a live lease. Call inside the caller's transaction so
 * the throw rolls it back.
 */
export function requireLeaseHeld(result: { readonly changes: number }, queue: LeasedQueue): void {
  if (result.changes !== 1) throw new Error(LEASE_LOST_MESSAGES[queue]);
}
