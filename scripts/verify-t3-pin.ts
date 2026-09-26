import { resolve } from "node:path";

import { parseT3Pin, verifyRemotePin, verifyT3Binary } from "../src/t3/pin.ts";

const pinPath = resolve(import.meta.dir, "..", "t3.lock.json");
const pin = parseT3Pin(await Bun.file(pinPath).json());

await verifyRemotePin(pin);

const binary = Bun.env.AGENT_TAG_T3_BIN;
if (binary !== undefined) await verifyT3Binary({ pin, binary });

await Bun.write(Bun.stdout, `verified T3 ${pin.version} at ${pin.commit}\n`);
