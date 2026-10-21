// Every user-facing routine string (PR-J §3.6), as outbox payloads. Pure. Prompts and labels go
// through escapeSlackText; the only mentions emitted are the requester, a named reminder target and
// the person who cancelled.
import { describeSchedule, promptPreview, shortScheduleId, slackDateToken } from "../routines/describe.ts";
import type { TimeZoneSource } from "../routines/timezone.ts";
import type { ScheduleSummary, SlackOutboxPayload } from "../store/store.ts";
import { escapeSlackText, truncateBlockText } from "./render.ts";

export const ROUTINE_CANCEL_ACTION_ID = "agent-tag.routine.cancel";
/** Active routines shown in one list reply (Slack allows 50 blocks; each routine takes two). */
export const ROUTINE_LIST_LIMIT = 20;

type Block = NonNullable<SlackOutboxPayload["blocks"]>[number];

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text: truncateBlockText(text) } };
}

function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncateBlockText(text) }] };
}

/** The Cancel button for one routine, with a confirm dialog. */
export function cancelButtonBlock(schedule: Pick<ScheduleSummary, "scheduleId" | "prompt">): Block {
  const shortId = shortScheduleId(schedule.scheduleId);
  return {
    type: "actions",
    block_id: `agent-tag.routine.${schedule.scheduleId}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel routine" },
        action_id: ROUTINE_CANCEL_ACTION_ID,
        value: JSON.stringify({ scheduleId: schedule.scheduleId }),
        style: "danger",
        confirm: {
          title: { type: "plain_text", text: "Cancel this routine?" },
          text: { type: "mrkdwn", text: truncateBlockText(`Routine \`${shortId}\` (*${promptPreview(schedule.prompt)}*) stops for everyone here.`) },
          confirm: { type: "plain_text", text: "Cancel routine" },
          deny: { type: "plain_text", text: "Keep it" },
          style: "danger",
        },
      },
    ],
  };
}

function plainText(mrkdwn: string): string {
  return mrkdwn.replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, "$1");
}

function timeZoneNote(source: TimeZoneSource, timeZone: string, defaultTimeZone: string): string {
  switch (source) {
    case "explicit":
      return `Using the time zone you named (${escapeSlackText(timeZone)}).`;
    case "profile":
      return "Using your Slack time zone. Add “in Europe/London” (or any zone) to pick another.";
    case "default":
      return `Using the default time zone ${escapeSlackText(defaultTimeZone)} because your Slack time zone isn't available. Add “in America/New_York” (or any zone) to pick another.`;
  }
}

/** The confirmation for a new routine: what, when, next run, id, and a Cancel button. */
export function createdReply(input: {
  readonly schedule: ScheduleSummary;
  readonly recurring: boolean;
  readonly timeZoneSource: TimeZoneSource;
  readonly defaultTimeZone: string;
}): SlackOutboxPayload {
  const { schedule } = input;
  const prompt = promptPreview(schedule.prompt);
  const when = describeSchedule(schedule);
  const ids = `*Next:* ${slackDateToken(schedule.nextRunAt)} · *ID:* \`${shortScheduleId(schedule.scheduleId)}\``;
  let text: string;
  if (schedule.kind === "reminder") {
    const who = schedule.notifyUserId === null ? "this thread" : `<@${schedule.notifyUserId}>`;
    text = `:alarm_clock: I'll remind ${who} ${when}: *${prompt}*\n${ids}`;
  } else if (input.recurring) {
    text = `:repeat: Routine scheduled: *${prompt}*\n*When:* ${when} · ${ids}\nResults post in this thread.`;
  } else {
    text = `:calendar: Scheduled once: *${prompt}*\n*When:* ${when} · ${ids}\nResults post in this thread.`;
  }
  const blocks: Block[] = [section(text)];
  // A fixed cadence ("every 2 hours") does not depend on a zone, so it gets no zone note.
  if (schedule.cadenceSeconds === null && schedule.timeZone !== null) {
    blocks.push(context(timeZoneNote(input.timeZoneSource, schedule.timeZone, input.defaultTimeZone)));
  }
  blocks.push(cancelButtonBlock(schedule));
  return { text: plainText(text), blocks };
}

export interface RoutineListRow {
  readonly schedule: ScheduleSummary;
  /** The creator's display label (or raw ID); never a mention, so listing pings nobody. */
  readonly creatorLabel: string;
}

function activeRowText(index: number, row: RoutineListRow): string {
  const { schedule } = row;
  const icon = schedule.kind === "reminder" ? ":alarm_clock:" : ":repeat:";
  return (
    `${index}. ${icon} \`${shortScheduleId(schedule.scheduleId)}\` · ${describeSchedule(schedule)}\n` +
    `*${promptPreview(schedule.prompt)}*\nNext: ${slackDateToken(schedule.nextRunAt)} · by ${escapeSlackText(row.creatorLabel)}`
  );
}

function disabledRowText(row: RoutineListRow): string {
  const { schedule } = row;
  const when = schedule.endedAt === null ? "" : ` ${slackDateToken(schedule.endedAt)}`;
  return (
    `:warning: \`${shortScheduleId(schedule.scheduleId)}\` · *${promptPreview(schedule.prompt)}* · ` +
    `turned off${when} after ${schedule.consecutiveFailures} failed runs in a row`
  );
}

/**
 * The routines of one conversation. `active` is in list order (cancel by number uses it); `disabled`
 * are routines auto-disabled recently, shown without a button.
 */
export function listReply(input: {
  readonly conversationType: "channel" | "dm";
  readonly botName: string;
  readonly active: ReadonlyArray<RoutineListRow>;
  readonly disabled: ReadonlyArray<RoutineListRow>;
}): SlackOutboxPayload {
  const where = input.conversationType === "dm" ? "in this DM" : "in this channel";
  if (input.active.length === 0 && input.disabled.length === 0) {
    const text = `No routines ${where} yet. Try \`@${escapeSlackText(input.botName)} every weekday at 9am summarize open PRs\`.`;
    return { text, blocks: [section(text)] };
  }
  const header = `*Routines ${where}* (${input.active.length} active)`;
  const blocks: Block[] = [section(header)];
  const lines = [header];
  for (const [index, row] of input.active.slice(0, ROUTINE_LIST_LIMIT).entries()) {
    const text = activeRowText(index + 1, row);
    blocks.push(section(text), cancelButtonBlock(row.schedule));
    lines.push(plainText(text));
  }
  const hidden = input.active.length - ROUTINE_LIST_LIMIT;
  if (hidden > 0) {
    const more = `…and ${hidden} more. Cancel some, or run \`agent-tag schedule-list\` on the host.`;
    blocks.push(context(more));
    lines.push(more);
  }
  if (input.disabled.length > 0) {
    const text = input.disabled.slice(0, 5).map(disabledRowText).join("\n");
    blocks.push(context(text));
    lines.push(plainText(text));
  }
  blocks.push(context("Cancel one with the button, or say `cancel routine <number or ID>`."));
  return { text: lines.join("\n"), blocks };
}

/**
 * Several routines match a cancel request: list just those, each with its own button. `number` is the
 * row's position in the full list, which is what "cancel routine <n>" resolves against.
 */
export function ambiguousCancelReply(rows: ReadonlyArray<RoutineListRow & { readonly number: number }>): SlackOutboxPayload {
  const header = `${rows.length} routines match. Which one should I cancel?`;
  const blocks: Block[] = [section(header)];
  for (const row of rows.slice(0, ROUTINE_LIST_LIMIT)) {
    blocks.push(section(activeRowText(row.number, row)), cancelButtonBlock(row.schedule));
  }
  return { text: header, blocks };
}

export function cancelledReply(input: { readonly actorUserId: string; readonly schedule: ScheduleSummary }): SlackOutboxPayload {
  const text =
    `:wastebasket: <@${input.actorUserId}> cancelled routine \`${shortScheduleId(input.schedule.scheduleId)}\` ` +
    `(${describeSchedule(input.schedule)}: *${promptPreview(input.schedule.prompt)}*).`;
  return { text: plainText(text), blocks: [section(text)] };
}

function textReply(text: string): SlackOutboxPayload {
  return { text };
}

export function noMatchReply(ref: string | null): SlackOutboxPayload {
  return textReply(
    ref === null
      ? "There's no active routine here to cancel. Say `list routines` to see them."
      : `No active routine matches \`${escapeSlackText(ref).replaceAll("`", "'")}\`. Say \`list routines\` to see them.`,
  );
}

export function parseErrorReply(message: string): SlackOutboxPayload {
  return textReply(`:warning: ${escapeSlackText(message)}`);
}

export function conversationLimitReply(limit: number): SlackOutboxPayload {
  return textReply(`:warning: This conversation already has ${limit} active routines. Cancel one first.`);
}

export function deniedReply(reason: string, workspaceLimit: number): SlackOutboxPayload {
  return textReply(
    reason === "schedule-limit"
      ? `:warning: The workspace routine limit (${workspaceLimit}) is reached. Cancel a routine first.`
      : ":no_entry: You can't manage routines here with the current configuration.",
  );
}

export const ROUTINE_FAILED = textReply("Something went wrong handling that routine request. Please try again.");
export const ALREADY_ENDED = "That routine is no longer active, so there was nothing to cancel.";
export const CANCEL_DENIED = "You can't cancel that routine with the current configuration.";
