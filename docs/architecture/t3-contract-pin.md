# T3 contract pin

Agent Tag targets T3 Code `0.0.42`, tag `v0.0.42`, commit `719a76ca1dbf5490f1aa33ffb9966301e02be9a9`. The published contracts and client runtime are private workspace packages, not a supported public SDK. Agent Tag therefore owns a narrow compatibility adapter and tests it against the release binary. It does not import T3's database or mutate T3 state directly.

The adapter may use only these public server boundaries:

- `/oauth/token` to exchange a one-time bootstrap credential for a scoped bearer token;
- `/api/auth/websocket-ticket` to mint a short-lived WebSocket ticket;
- authenticated `/ws` Effect RPC for server probe/config, orchestration command dispatch, thread subscription, and attachment URLs where needed.

Requested scopes start with `orchestration:read` and `orchestration:operate`. Terminal, review, access-administration, and relay scopes stay absent until a tested acceptance flow requires one.

Stable Agent Tag operation IDs derive T3 command IDs. The bridge persists intent before dispatch and reconciles receipts/snapshots after transport loss. It never blindly repeats an external write.

`t3.lock.json` records the source commit, release artifact checksum, npm launcher integrity, and the Effect transport version used by the release. `bun run verify:t3-pin` checks those values against GitHub and npm. A release upgrade must update the lock and pass the full adapter contract suite first.
