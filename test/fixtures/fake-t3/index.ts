import { join } from "node:path";

/** The `t3` shim of the fake T3 CLI (see fake-t3.ts). */
export const FAKE_T3_BINARY = join(import.meta.dir, "t3");

/** The credential the fake `t3 serve` prints on stdout and stderr, as the real one prints pairing details. */
export const FAKE_PAIRING_TOKEN = "fake-pairing-credential-7f3a9c";
