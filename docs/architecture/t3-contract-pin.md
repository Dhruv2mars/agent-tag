# T3 contract pin

Agent Tag targets T3 Code `0.0.45`, tag `v0.0.45`, commit `6c8fed35dded9ff71c5b46807125457acbb76be6`, which speaks orchestration protocol 1 like `0.0.42`. The published contracts and client runtime are private workspace packages, not a supported public SDK. Agent Tag therefore owns a narrow compatibility adapter and tests it against the release binary. It does not import T3's database or mutate T3 state directly.

The adapter may use only these public server boundaries:

- unauthenticated `/.well-known/t3/environment` to read `orchestrationProtocolVersion` (missing means 1) and fail closed on any protocol other than 1;
- `/oauth/token` to exchange a one-time bootstrap credential for a scoped bearer token;
- `/api/auth/websocket-ticket` to mint a short-lived WebSocket ticket;
- authenticated `/ws` Effect RPC, advertising `orchestrationProtocol=1`, for server probe/config, orchestration command dispatch, thread subscription, and signed attachment upload/download plus pending-attachment deletion.

Requested scopes start with `orchestration:read` and `orchestration:operate`. Terminal, review, access-administration, and relay scopes stay absent until a tested acceptance flow requires one.

Stable Agent Tag operation IDs derive T3 command IDs. The bridge persists intent before dispatch and reconciles receipts/snapshots after transport loss. It never blindly repeats an external write.

`t3.lock.json` records the source commit, release artifact checksums (darwin-arm64, linux-arm64, linux-x64), npm launcher integrity, and the Effect transport version used by the release. `bun run verify:t3-pin` checks those values against GitHub and npm. A release upgrade must update the lock and pass the full adapter contract suite first.
