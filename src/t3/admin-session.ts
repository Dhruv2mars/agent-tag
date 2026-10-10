import { z } from "zod";

import type { CommandRunner } from "../command.ts";
import { SecretString } from "../security/secret-file.ts";
import { redactT3Output } from "./supervisor.ts";

/**
 * Short-lived T3 admin sessions from `t3 auth session issue|revoke`, shared by onboarding and the
 * credential lifecycle. An admin token lives in memory only, for at most this TTL, and is revoked as
 * soon as the restricted token is minted. Errors never include stdout, which holds the token.
 */
export const T3_ADMIN_SESSION_TTL = "10m";

const issuedSessionSchema = z.object({ sessionId: z.string().min(1), token: z.string().min(1) });

export interface IssuedT3AdminSession {
  readonly sessionId: string;
  readonly token: SecretString;
}

/** Parses `t3 auth session issue --json` output (live 0.0.45: `{sessionId, token, scopes, client, expiresAt, …}`). */
export function parseIssuedT3Session(stdout: string): IssuedT3AdminSession | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const parsed = issuedSessionSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return { sessionId: parsed.data.sessionId, token: new SecretString(parsed.data.token) };
}

export interface T3AdminSessionTarget {
  readonly t3Bin: string;
  readonly baseDir: string;
}

export function t3AdminSessionIssueCommand(input: T3AdminSessionTarget & { readonly label: string }): string[] {
  return [
    input.t3Bin, "auth", "session", "issue", "--base-dir", input.baseDir,
    "--ttl", T3_ADMIN_SESSION_TTL, "--label", input.label, "--json",
  ];
}

export function t3AdminSessionRevokeCommand(input: T3AdminSessionTarget & { readonly sessionId: string }): string[] {
  return [input.t3Bin, "auth", "session", "revoke", "--base-dir", input.baseDir, input.sessionId];
}

function firstStderrLine(stderr: string): string {
  const line = redactT3Output(stderr.split("\n")[0] ?? "").slice(0, 500);
  return line.length === 0 ? "" : `: ${line}`;
}

export async function issueT3AdminSession(
  input: T3AdminSessionTarget & { readonly label: string; readonly run: CommandRunner; readonly signal?: AbortSignal },
): Promise<IssuedT3AdminSession> {
  const command = t3AdminSessionIssueCommand(input);
  const result = await input.run(command, input.signal === undefined ? undefined : { signal: input.signal });
  input.signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    throw new Error(`\`${command.slice(0, 4).join(" ")}\` failed with exit code ${result.exitCode}${firstStderrLine(result.stderr)}`);
  }
  const issued = parseIssuedT3Session(result.stdout.trim());
  if (issued === undefined) {
    throw new Error(
      `\`${command.slice(0, 4).join(" ")}\` printed output Agent Tag does not recognize; any session it issued expires in ${T3_ADMIN_SESSION_TTL}`,
    );
  }
  return issued;
}

export async function revokeT3AdminSession(
  input: T3AdminSessionTarget & { readonly sessionId: string; readonly run: CommandRunner; readonly signal?: AbortSignal },
): Promise<void> {
  const result = await input.run(t3AdminSessionRevokeCommand(input), input.signal === undefined ? undefined : { signal: input.signal });
  if (result.exitCode !== 0) {
    throw new Error(`t3 auth session revoke failed with exit code ${result.exitCode}${firstStderrLine(result.stderr)}`);
  }
}
