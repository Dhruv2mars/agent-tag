# Initial design

## Problem

Agent Tag must acknowledge Slack quickly, preserve each human's identity and order, survive process restarts, and control T3 without becoming another agent runtime. T3 owns projects, threads, provider sessions, worktrees, approvals, checkpoints, and agent events. Agent Tag owns Slack delivery, team authority, task bindings, schedules, shared memory, and the durable handoff between those systems.

## Usage from the caller

The process starts from one validated config and one SQLite file:

```ts
const service = await AgentTag.open({ configPath });
await service.runUntilSignal();
```

Slack delivery enters one method. The method persists and acknowledges; it does not wait for T3:

```ts
const receipt = service.ingestSlackEvent(envelope);
// { kind: "accepted", deliveryId } or { kind: "duplicate", deliveryId }
```

Workers claim durable operations. T3 transport details stay behind one gateway:

```ts
const result = await t3.dispatch(operation.command);
for await (const update of t3.watchThread(operation.threadId, operation.afterSequence)) {
  await coordinator.applyT3Update(update);
}
```

## Chosen shape

SQLite is the command log and authority source for Agent Tag. One transaction converts a validated Slack delivery into an immutable inbox row and, when authorized, a task operation. A unique workspace plus Slack event key makes retries no-ops. Each operation has a stable ID; T3 command and message IDs derive from it. A per-task lease allows one dispatcher at a time while a global semaphore bounds active tasks. Slack responses use a durable outbox with stable client message IDs.

The public modules stay small:

| Module | Owns |
| --- | --- |
| `config` | Profiles, routes, access lists, limits, and secret file locations. |
| `slack` | Socket Mode/Web API parsing, fast acknowledgement, Block Kit, file transfer, and Slack-specific retry metadata. |
| `store` | SQLite migrations and atomic inbox, operation, lease, task binding, outbox, interaction, memory, schedule, and audit transitions. |
| `coordinator` | Pure authorization and state-transition decisions over typed inputs. |
| `t3` | Credential enrollment, pinned wire compatibility, commands, snapshots, subscriptions, and capability projection. |
| `policy` | Profile authority, executable external-write gates, filesystem isolation claims, and provider capability decisions. |
| `service` | Starts adapters and workers, applies concurrency bounds, and reconciles recovery. |

Boundary data is parsed into branded domain IDs. Storage rows, Slack payloads, and T3 wire values remain private to their modules. State uses discriminated unions rather than optional status fields. The first slice implements `config`, `t3`, and the minimal store transaction needed to prove replay-safe dispatch.

## Synthesis decision

Two external design candidates were launched but both platform tasks ended at the usage limit before returning artifacts. No candidate text was available to graft or judge. I compared two local shapes instead:

- A SQLite command-log core with stateless workers.
- A long-lived actor per Slack task with a persisted mailbox.

The command log is the base. It makes crash points queryable and keeps correctness in database transitions instead of actor lifecycle. The useful actor idea is retained only as a per-task lease and serial claim rule. An event-bus or generic backend interface was rejected because T3 is the only backend and SQLite already provides the required durable handoff.

## Tradeoffs accepted

- We accept polling a small SQLite queue in exchange for restart behavior that does not depend on in-memory actors.
- We accept a narrow handwritten compatibility schema in exchange for avoiding T3's private workspace packages; real-release contract tests guard it.
- We accept one local writer process for the first release in exchange for ordinary SQLite transactions and simple ownership.
- We accept that trusted same-user profiles are not filesystem isolation. Strong isolation requires a configured OS account or container and matching denial evidence.

## Open questions and risks

- Which T3 stream fields must Agent Tag project to Slack without tying the bridge to internal provider event shapes?
- Can each supported provider enforce the profile's filesystem and credential restrictions, or must that profile require OS isolation?
- Which Slack assistant-thread features are enabled for the eventual app manifest and workspace plan?
- How should an operator rotate the 30-day T3 bearer token without interrupting active subscriptions?

## Next implementation step

Persist pending approvals, questions, and cancellations as explicit interaction state. Slack actions must acknowledge before T3 work, bind to the authorized actor and task, and replay safely after a bridge restart.
