// Compiled by test/compiled-binary.test.ts: proves a compiled binary installs service units that
// execute the binary itself (resolved through symlinks), not bun plus a src/cli.ts that does not exist.
import { currentServiceUnitPaths } from "../../src/service-unit.ts";

const configPath = process.argv[2];
if (configPath === undefined) throw new Error("usage: compiled-service-unit-probe CONFIG");
console.log(JSON.stringify(await currentServiceUnitPaths(configPath)));
