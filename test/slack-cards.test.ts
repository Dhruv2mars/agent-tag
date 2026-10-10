import { describe, expect, test } from "bun:test";

import {
  alreadyHandledText,
  approvalMessage,
  describeDuration,
  renderInteractionCard,
  type CardRenderContext,
} from "../src/slack/cards.ts";
import type { InteractionCardView } from "../src/store/interaction-cards.ts";
import { outboxPayloadSchema } from "../src/store/schema.ts";
import type { SlackOutboxPayload } from "../src/store/store.ts";

type SlackBlock = NonNullable<SlackOutboxPayload["blocks"]>[number];

const ctx: CardRenderContext = { expirySeconds: 3600 };
const NOW = "2026-09-21T00:00:00.000Z";

function view(overrides: Partial<InteractionCardView>): InteractionCardView {
  return {
    interactionId: "i-1",
    kind: "approval",
    prompt: { requestKind: "command", detail: "run tests" },
    state: "pending",
    lastErrorCode: null,
    retriesExhausted: false,
    response: null,
    responseActorId: null,
    partial: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function blocksOf(payload: SlackOutboxPayload): SlackBlock[] {
  return payload.blocks ?? [];
}

function actionsBlocks(payload: SlackOutboxPayload): SlackBlock[] {
  return blocksOf(payload).filter((block) => block.type === "actions");
}

function contextTexts(block: SlackBlock): string[] {
  if (block.type !== "context") return [];
  return block.elements.map((element) => element.text);
}

const userInputPrompt = {
  requestId: "r",
  questions: [
    {
      id: "q1",
      header: "Target",
      question: "Which one?",
      options: [{ label: "A" }, { label: "B" }],
      multiSelect: false,
    },
    {
      id: "q2",
      header: "Env",
      question: "Where?",
      options: [{ label: "prod" }],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

describe("renderInteractionCard", () => {
  test("pending approval renders the same message as approvalMessage, with three buttons", () => {
    const prompt = { requestKind: "command", detail: "run tests" };
    const rendered = renderInteractionCard(view({ prompt }), ctx);
    expect(rendered).toEqual(approvalMessage("i-1", prompt));
    const actions = actionsBlocks(rendered);
    expect(actions).toHaveLength(1);
    const [actionBlock] = actions;
    expect(actionBlock?.type === "actions" ? actionBlock.elements.length : -1).toBe(3);
  });

  describe.each([
    {
      name: "response-pending accept by U1",
      overrides: { state: "response-pending", response: { decision: "accept" }, responseActorId: "U1" } as const,
      expected: ["Allow once, chosen by <@U1>", "Sending to the agent"],
    },
    {
      name: "inflight decline by U1",
      overrides: { state: "inflight", response: { decision: "decline" }, responseActorId: "U1" } as const,
      expected: ["Deny, chosen by <@U1>"],
    },
    {
      name: "resolved acceptForSession by U2",
      overrides: { state: "resolved", response: { decision: "acceptForSession" }, responseActorId: "U2" } as const,
      expected: ["Allowed for this thread by <@U2>", "<!date^"],
    },
    {
      name: "resolved resolved-elsewhere",
      overrides: { state: "resolved", lastErrorCode: "resolved-elsewhere" } as const,
      expected: ["Resolved outside Slack"],
    },
    {
      name: "failed expired",
      overrides: { state: "failed", lastErrorCode: "expired" } as const,
      expected: ["Expired after 1 hour"],
    },
    {
      name: "failed with retries exhausted by U1",
      overrides: { state: "failed", retriesExhausted: true, lastErrorCode: "T3Unavailable", responseActorId: "U1" } as const,
      expected: ["could not reach the agent"],
    },
    {
      name: "failed operation-settled with no actor",
      overrides: { state: "failed", lastErrorCode: "operation-settled", responseActorId: null } as const,
      expected: ["turn ended before anyone answered"],
    },
    {
      name: "failed T3CommandRejected by U1",
      overrides: { state: "failed", lastErrorCode: "T3CommandRejected", responseActorId: "U1" } as const,
      expected: ["no longer pending"],
    },
  ])("non-pending approval: $name", ({ overrides, expected }) => {
    test("drops buttons, keeps the prompt, and ends with a status context block", () => {
      const rendered = renderInteractionCard(view(overrides), ctx);
      expect(actionsBlocks(rendered)).toHaveLength(0);

      const blocks = blocksOf(rendered);
      const first = blocks[0];
      expect(first?.type === "section" ? first.text.text : "").toContain("*Approval required*");

      const last = blocks.at(-1);
      expect(last?.type).toBe("context");
      const lastText = last === undefined ? "" : contextTexts(last)[0];
      expect(lastText).toBe(rendered.text);

      expect(() => outboxPayloadSchema.parse(rendered)).not.toThrow();

      const statusLine = rendered.text;
      for (const fragment of expected) {
        expect(statusLine).toContain(fragment);
      }
    });
  });

  test("a non-Slack-shaped actor id is not rendered as a mention", () => {
    const rendered = renderInteractionCard(
      view({ state: "resolved", response: { decision: "accept" }, responseActorId: "<!channel>" }),
      ctx,
    );
    const serialized = JSON.stringify(rendered);
    expect(serialized).not.toContain("<!channel>");
    expect(serialized).not.toContain("<@<!channel>>");
    expect(rendered.text).toContain("Allowed once by");
  });

  test("pending user-input: answered question shows its answer and no buttons, others keep theirs", () => {
    const rendered = renderInteractionCard(
      view({
        kind: "user-input",
        prompt: userInputPrompt,
        partial: {
          answers: {
            q1: {
              answer: "A",
              actorUserId: "U1",
              sourceActionId: "a-1",
              answeredAt: NOW,
            },
          },
          sourceActionIds: ["a-1"],
        },
      }),
      ctx,
    );
    const blocks = blocksOf(rendered);

    const q1Index = blocks.findIndex((block) => block.type === "section" && block.text.text.includes("Which one?"));
    expect(q1Index).toBeGreaterThanOrEqual(0);
    const q1Answer = blocks[q1Index + 1];
    expect(q1Answer?.type).toBe("context");
    expect(contextTexts(q1Answer ?? { type: "context", elements: [] })[0]).toContain("Answered by <@U1>: A");

    const q0Actions = blocks.filter((block) => block.type === "actions" && block.block_id?.endsWith(":q0"));
    expect(q0Actions).toHaveLength(0);

    const q1Actions = blocks.filter((block) => block.type === "actions" && block.block_id?.endsWith(":q1"));
    expect(q1Actions).toHaveLength(1);

    const dismiss = blocks.filter((block) => block.type === "actions" && block.block_id?.endsWith(":dismiss"));
    expect(dismiss).toHaveLength(1);
    expect(() => outboxPayloadSchema.parse(rendered)).not.toThrow();
  });

  test("resolved user-input answer lists every contributor and has no buttons", () => {
    const rendered = renderInteractionCard(
      view({
        kind: "user-input",
        prompt: userInputPrompt,
        state: "resolved",
        response: { kind: "answer", contributors: ["U1", "U2"] },
        responseActorId: "U1",
      }),
      ctx,
    );
    expect(actionsBlocks(rendered)).toHaveLength(0);
    expect(rendered.text).toContain("Answered by <@U1>, <@U2>");
    expect(() => outboxPayloadSchema.parse(rendered)).not.toThrow();
  });

  test("resolved user-input dismiss reads as dismissed by the actor and has no buttons", () => {
    const rendered = renderInteractionCard(
      view({
        kind: "user-input",
        prompt: userInputPrompt,
        state: "resolved",
        response: { kind: "dismiss" },
        responseActorId: "U1",
      }),
      ctx,
    );
    expect(actionsBlocks(rendered)).toHaveLength(0);
    expect(rendered.text).toContain("Dismissed by <@U1>");
    expect(() => outboxPayloadSchema.parse(rendered)).not.toThrow();
  });

  test("an approval whose stored prompt fails validation renders without throwing and without buttons once failed", () => {
    const rendered = renderInteractionCard(
      view({ prompt: {}, state: "failed", lastErrorCode: "T3CommandRejected", responseActorId: "U1" }),
      ctx,
    );
    expect(actionsBlocks(rendered)).toHaveLength(0);
    expect(rendered.text).toContain("no longer pending");
    expect(() => outboxPayloadSchema.parse(rendered)).not.toThrow();
  });
});

describe("alreadyHandledText", () => {
  test("is null for a missing view and for a pending view", () => {
    expect(alreadyHandledText(null, ctx)).toBeNull();
    expect(alreadyHandledText(view({ state: "pending" }), ctx)).toBeNull();
  });

  test("starts with 'Already handled.' for a resolved approval", () => {
    const text = alreadyHandledText(
      view({ state: "resolved", response: { decision: "accept" }, responseActorId: "U1" }),
      ctx,
    );
    expect(text).not.toBeNull();
    expect(text?.startsWith("Already handled.")).toBe(true);
  });
});

describe("describeDuration", () => {
  test("renders whole hours, whole minutes, and seconds", () => {
    expect(describeDuration(86_400)).toBe("24 hours");
    expect(describeDuration(60)).toBe("1 minute");
    expect(describeDuration(61)).toBe("61 seconds");
  });
});
