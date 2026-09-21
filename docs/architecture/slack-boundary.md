# Slack boundary

Agent Tag uses Slack Bolt `5.1.0` in Socket Mode. The app token needs `connections:write`; the bot scopes and event subscriptions are listed in `config/slack-manifest.example.json`. Socket Mode avoids a public inbound HTTP endpoint. Slack's Bolt documentation confirms that Socket Mode carries Events API and interactive payloads over WebSocket, and that private-channel messages use `message.groups`: <https://docs.slack.dev/tools/bolt-js/creating-an-app/>.

## Inbound invariant

Bolt acknowledges Events API envelopes before invoking event listeners. Agent Tag's listeners then do one bounded job: validate the untrusted envelope, enforce workspace/channel/user access, resolve the configured profile, and commit a normalized event plus stable operation IDs in one SQLite transaction. No T3 or Slack Web API call occurs on the inbound path.

The canonical semantic key is `channel_id:message_ts`. This collapses a Slack retry and overlapping `app_mention`/`message` subscriptions even when their delivery IDs differ. A top-level `message` event is ignored by default. A threaded `message` is accepted only when its root maps to an existing active Agent Tag task. The exact Slack timestamp is the per-task order key, so two authorized humans' messages retain Slack order even when received in the same local millisecond.

The only exception to ignoring unmentioned top-level messages is profile-level ambient opt-in. An ambient profile requires one of its configured keywords, stores a content fingerprint before dispatch, and suppresses unchanged, cooldown, and hourly-limit cases. Ambient input still passes the same workspace, channel, user, route, repository, operation, and T3 boundaries as an explicit mention. The default is disabled.

A DM is never inferred from an arbitrary `D` identifier. Its route must declare `conversationType: "dm"`, name one allowed owner, and use a profile with private DM memory enabled. Unmentioned top-level messages are explicit input in that route. The router and durable task both enforce the owner, and the coordinator derives private-memory visibility from the stored task type. A route change that conflicts with an active task fails closed.

## Outbound invariant

Slack's supported `chat.postMessage` argument surface does not document an idempotency key. Slack also warns that `fatal_error` and `internal_error` can be returned after some aspect of an operation succeeded: <https://docs.slack.dev/reference/methods/chat.postMessage/>. Agent Tag therefore disables the SDK's automatic HTTP retries. A definite successful response stores Slack's message timestamp. An API error is failed closed. If the process exits while a send is in flight, the expired outbox row is quarantined as `delivery-outcome-unknown`; it is not sent again automatically.

This trades unattended at-least-once delivery for no blind duplicate writes. GA still requires an operator reconciliation command and a live outage exercise.
