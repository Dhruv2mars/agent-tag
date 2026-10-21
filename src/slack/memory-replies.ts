// Every user-facing string of the Slack memory phrases (PR-K §3.6). Note content, author labels and
// matches go through escapeSlackText, so a note can never ping anyone or inject markup.
import type { MemoryGroups } from "../memory.ts";
import type { MemoryRecord, SlackOutboxPayload } from "../store/store.ts";
import { escapeSlackText, splitForSlack } from "./render.ts";

export function shortRef(memory: Pick<MemoryRecord, "memoryId">): string {
  return memory.memoryId.slice(0, 8);
}

function text(value: string): SlackOutboxPayload {
  return { text: value };
}

export function savedReply(input: {
  readonly memory: MemoryRecord;
  readonly conversationType: "channel" | "dm";
}): SlackOutboxPayload {
  const ref = shortRef(input.memory);
  const content = escapeSlackText(input.memory.content);
  if (input.memory.scope === "shared") {
    return text(`Saved to workspace memory (\`${ref}\`). Every routed channel will see it: ${content}\n_Remove it with "forget ${ref}"._`);
  }
  const where = input.conversationType === "dm" ? "your DM memory" : "this channel's memory";
  return text(`Saved to ${where} (\`${ref}\`): ${content}\n_Remove it with "forget ${ref}"._`);
}

export function duplicateReply(memory: MemoryRecord): SlackOutboxPayload {
  return text(`Already in memory as \`${shortRef(memory)}\`.`);
}

export interface MemoryLimits {
  readonly maxEntryChars: number;
  readonly maxEntriesPerConversation: number;
  readonly maxWorkspaceEntries: number;
}

/** One line per refusal; internal reason codes never reach Slack. */
export function deniedReply(input: {
  readonly reason: string;
  readonly target: "here" | "workspace" | "edit";
  readonly conversationType: "channel" | "dm";
  readonly limits: MemoryLimits;
}): SlackOutboxPayload {
  switch (input.reason) {
    case "workspace-write-requires-public-channel":
      return text(
        input.conversationType === "dm"
          ? 'Workspace notes can only be saved from a public channel. Use "remember: …" here to save a note to your DM memory.'
          : 'Workspace notes can only be saved from a public channel. Use "remember for this channel: …" here.',
      );
    case "shared-memory-disabled":
      return text("Workspace memory is turned off for this channel's profile.");
    case "private-memory-disabled":
      return text("DM memory is turned off for this DM's profile.");
    case "entry-too-long":
      return text(`That note is longer than ${input.limits.maxEntryChars} characters. Keep notes short, and put playbooks in the repository.`);
    case "entry-empty":
      return text("That note is empty, so I didn't save anything.");
    case "memory-full": {
      const n = input.target === "workspace" ? input.limits.maxWorkspaceEntries : input.limits.maxEntriesPerConversation;
      const where = input.target === "workspace" ? "Workspace memory" : input.conversationType === "dm" ? "Your DM memory" : "This channel";
      return text(`${where} already has ${n} notes. Forget some first (say "what do you remember?").`);
    }
    case "secret-detected":
      return text("That looks like a credential, so I didn't save it. Store secrets with the operator instead.");
    case "memory-read-only":
      return text("That note can't be changed from here. Workspace notes change only from a public channel, and operator notes only through the operator.");
    default:
      return text("I couldn't change memory for that request.");
  }
}

export function notFoundReply(ref: string): SlackOutboxPayload {
  return text(`I don't have a note \`${escapeSlackText(ref)}\` here.`);
}

export function ambiguousReply(ref: string, candidates: ReadonlyArray<string>): SlackOutboxPayload {
  const refs = candidates.map((id) => `\`${id.slice(0, 13)}\``).join(", ");
  return text(`More than one note starts with \`${escapeSlackText(ref)}\`: ${refs}. Use a longer ref.`);
}

export function forgottenReply(memory: MemoryRecord): SlackOutboxPayload {
  return text(`Forgot \`${shortRef(memory)}\`: ${escapeSlackText(memory.content)}`);
}

export function updatedReply(memory: MemoryRecord): SlackOutboxPayload {
  return text(`Updated \`${shortRef(memory)}\` (version ${memory.version}): ${escapeSlackText(memory.content)}`);
}

export function noMatchReply(match: string): SlackOutboxPayload {
  return text(`I don't have a note matching "${escapeSlackText(match)}" here that I can forget.`);
}

export function matchCandidatesReply(match: string, candidates: ReadonlyArray<MemoryRecord>): SlackOutboxPayload {
  const lines = candidates.slice(0, 10).map((memory) => `• \`${shortRef(memory)}\` ${escapeSlackText(memory.content)}`);
  const more = candidates.length > 10 ? [`…and ${candidates.length - 10} more.`] : [];
  return text(
    [`More than one note matches "${escapeSlackText(match)}". Say "forget <ref>" with one of these:`, ...lines, ...more].join("\n"),
  );
}

/**
 * The list reply, split into as many messages as Slack needs. `labels` maps author IDs to display
 * names; an unknown author shows as the escaped ID, never as a mention.
 */
export function listReplies(input: {
  readonly groups: MemoryGroups;
  readonly conversationType: "channel" | "dm";
  /** Workspace notes are read-only outside public channels. */
  readonly workspaceWritable: boolean;
  readonly labels: ReadonlyMap<string, string>;
}): ReadonlyArray<SlackOutboxPayload> {
  const { groups } = input;
  const here = input.conversationType === "dm" ? groups.dm : groups.channel;
  if (here.length === 0 && groups.workspace.length === 0 && groups.operator.length === 0) {
    return [
      text(
        input.conversationType === "dm"
          ? 'I don\'t have any notes for this DM yet. Say "remember: …" to add one.'
          : 'I don\'t have any notes for this channel yet. Say "remember for this channel: …" to add one.',
      ),
    ];
  }
  const line = (memory: MemoryRecord): string => {
    const author = memory.updatedBy ?? memory.createdBy;
    const label = escapeSlackText(input.labels.get(author) ?? author);
    return `• \`${shortRef(memory)}\` ${escapeSlackText(memory.content)} — ${label} · ${memory.updatedAt.slice(0, 10)}`;
  };
  const section = (title: string, records: ReadonlyArray<MemoryRecord>): string[] =>
    records.length === 0 ? [] : ["", `${title} (${records.length})`, ...records.map(line)];
  const body = [
    "*What I remember here*",
    ...section(input.conversationType === "dm" ? "*Your DM notes*" : "*This channel*", here),
    ...section(`*Workspace*${input.workspaceWritable ? "" : " _(read-only here)_"}`, groups.workspace),
    ...section("*Operator notes* _(read-only)_", groups.operator),
    "",
    '_Forget with "forget <ref>", edit with "update memory <ref>: …"._',
  ].join("\n");
  return splitForSlack(body).map(text);
}

export const MEMORY_COMMAND_FAILED = text("Something went wrong while changing memory, so nothing was changed. Try again in a moment.");
export const MEMORY_COMMAND_DENIED = text("You can't change memory in this thread.");
