// Every user-facing string of the plain-language model switch (PR-P2 §3.5). What the user typed goes
// through escapeSlackText; provider diagnostics never reach Slack, only stable codes.
import type { ModelChoice, SwitchRefusalCode } from "../policy/models.ts";
import type { SlackOutboxPayload } from "../store/store.ts";
import type { T3ModelSelection } from "../t3/gateway.ts";
import { escapeSlackText } from "./render.ts";

/** A model as the thread sees it: its allowlist label when it has one. */
export interface ModelName {
  readonly selection: T3ModelSelection;
  readonly label: string;
}

const NOT_STARTED = " Your request was not started.";

function text(value: string): SlackOutboxPayload {
  return { text: value };
}

function slug(selection: T3ModelSelection): string {
  return `\`${selection.instanceId}/${selection.model}\``;
}

function named(model: ModelName): string {
  return `*${model.label}*`;
}

function choiceList(choices: ReadonlyArray<ModelChoice>): string {
  return choices.map((choice) => `${named({ selection: choice, label: choice.label })} (${slug(choice)})`).join(", ");
}

export function switchedReply(input: {
  readonly target: ModelName;
  readonly actorUserId: string;
  /** The thread has not run a turn yet (or its next request starts a fresh session). */
  readonly preStart: boolean;
}): SlackOutboxPayload {
  const first = input.preStart ? " The first turn will use it." : "";
  return text(`Switched this thread to ${named(input.target)} (${slug(input.target.selection)}), requested by <@${input.actorUserId}>.${first}`);
}

export function alreadyReply(current: ModelName): SlackOutboxPayload {
  return text(`This thread is already on ${named(current)} (${slug(current.selection)}).`);
}

export interface RefusalCopy {
  readonly code: SwitchRefusalCode;
  /** What the user typed for the model. */
  readonly query: string;
  /** The model asked for, when the query named one. */
  readonly target: ModelName | null;
  readonly current: ModelName;
  /** The driver of the thread's current model, from the T3 catalog (the instance id without one). */
  readonly currentDriver: string;
  /** The driver of the target, for the cross-provider policy refusal. */
  readonly targetDriver: string | null;
  readonly allowed: ReadonlyArray<ModelChoice>;
  /** Several allowed models matched the query. */
  readonly candidates: ReadonlyArray<ModelChoice>;
  /** A `ProviderSelectionError` code for `unavailable`. */
  readonly detail: string | null;
  /** The message also carried a request, which was not queued. */
  readonly hadRequest: boolean;
  /** How users address the bot, e.g. "Agent Tag". */
  readonly botName: string;
  /** `!restart` is enabled for this user, so it can be offered as the way to a fresh session. */
  readonly restartAvailable: boolean;
  /** An alias or slug that names the target in a new thread. */
  readonly targetHandle: string | null;
}

/** One reply per refusal; the thread always stays on its current model. */
export function refusedReply(input: RefusalCopy): SlackOutboxPayload {
  const stays = ` This thread stays on ${named(input.current)}.`;
  const tail = input.hadRequest ? NOT_STARTED : "";
  const query = `*${escapeSlackText(input.query)}*`;
  const target = input.target === null ? query : named(input.target);
  switch (input.code) {
    case "switch-disabled":
      return text(`Model switching is turned off for this channel.${tail}`);
    case "not-allowed":
      return text(`${query} isn't allowed here. Allowed: ${choiceList(input.allowed)}.${stays}${tail}`);
    case "ambiguous":
      return text(
        `${query} matches more than one model here: ${choiceList(input.candidates)}. Name one of them exactly.${stays}${tail}`,
      );
    case "unavailable":
      return text(
        `${target} is configured but its provider isn't ready on the T3 host (${input.detail ?? "unavailable"}).${stays}${tail}`,
      );
    case "cross-provider-denied":
      return text(
        `This channel doesn't allow moving a thread to another provider (${target} runs on ${input.targetDriver ?? "another provider"}).${stays}${tail}`,
      );
    case "cross-provider-started":
    case "requires-new-thread":
    case "incompatible-continuation": {
      const handle = input.targetHandle ?? "<model>";
      const restart = input.restartAvailable
        ? ` or say \`@${input.botName} !restart\` here for a fresh session (it won't remember this conversation), then switch`
        : "";
      return text(
        `This thread already started on ${named(input.current)} (${input.currentDriver}); T3 can't move a running conversation to ${target}. ` +
          `Start a new thread with \`@${input.botName} use ${handle}: <request>\`${restart}.${tail}`,
      );
    }
  }
}

/** A database or internal failure: nothing changed, the user can send the message again. */
export const MODEL_SWITCH_FAILED = text("I couldn't switch the model just now. Nothing changed; send the message again in a moment.");
/** The actor lost access between the router and the switch. */
export const MODEL_SWITCH_DENIED = text("You can't change the model for this thread.");
