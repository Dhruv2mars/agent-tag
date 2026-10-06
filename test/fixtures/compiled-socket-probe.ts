// Compiled by test/compiled-binary.test.ts and executed outside the repository, where
// node_modules is unreachable: proves the Slack Socket Mode transport is bundled.
import { installUndiciWebSocketCompat } from "../../src/slack/undici-compat.ts";

installUndiciWebSocketCompat();
console.log("socket-mode-transport-ok");
