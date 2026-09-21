# Slack ingress fixture evidence, 2026-09-21

Actor type: `automated-fixture`

## System under test

- Agent Tag branch: `feat/t3-slack-spike`
- Slack Bolt: `5.1.0`
- Bun: `1.3.13`
- Transport configuration: Socket Mode

## Checks run

The fixture suite submits unknown Slack-shaped payloads to the same parser/router used by the Bolt listeners. It proved:

1. An authorized mention selected its configured profile and repository, removed the bot mention, and created one durable operation.
2. A second `message` delivery for the same channel and timestamp but a different Slack event ID returned the first operation instead of adding a turn.
3. A second authorized human's reply in that task thread created the next ordered turn with the second human's identity intact.
4. A message in an unbound thread was ignored.
5. Wrong-workspace, unauthorized-channel, unauthorized-user, bot, and message-subtype payloads were rejected before persistence.
6. An expired in-flight Slack send was quarantined instead of being replayed without a documented Slack idempotency guarantee.
7. Interactive approval, rejection, question answer/dismissal, and turn-cancel payloads are acknowledged by Bolt before the router validates workspace, channel, user, task, thread, and interaction authority and writes a durable response.

This is not live Slack evidence. App installation, tokens, a real mention/retry, interactive actions, files, and a second human remain required.
