import { expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  currentServiceUnitPaths,
  describeInstalledProgram,
  installedUnitPaths,
  NOT_INSTALLED,
  serviceProgramArguments,
  serviceProgramFor,
  serviceProgramPaths,
} from "../src/service-unit.ts";
import { isCompiledEntrypoint } from "../src/version.ts";

test("recognizes Bun's embedded filesystem entrypoints on POSIX and Windows", () => {
  expect(isCompiledEntrypoint("/$bunfs/root/agent-tag")).toBe(true);
  expect(isCompiledEntrypoint("B:\\~BUN\\root\\agent-tag.exe")).toBe(true);
  expect(isCompiledEntrypoint("/srv/agent-tag/src/cli.ts")).toBe(false);
});

test("a compiled binary runs itself; a checkout runs bun with its src/cli.ts", () => {
  const binary = serviceProgramFor({ mainPath: "/$bunfs/root/agent-tag", execPath: "/home/a/.local/bin/agent-tag", sourceRoot: "/$bunfs" });
  expect(binary).toEqual({ kind: "binary", binaryPath: "/home/a/.local/bin/agent-tag" });
  expect(serviceProgramArguments(binary, "run", "/cfg.json")).toEqual(["/home/a/.local/bin/agent-tag", "run", "/cfg.json"]);
  expect(serviceProgramArguments(binary, "doctor", "/cfg.json")).toEqual(["/home/a/.local/bin/agent-tag", "doctor", "/cfg.json"]);
  expect(serviceProgramPaths(binary)).toEqual(["/home/a/.local/bin/agent-tag"]);

  const source = serviceProgramFor({ mainPath: "/srv/agent-tag/src/cli.ts", execPath: "/usr/bin/bun", sourceRoot: "/srv/agent-tag" });
  expect(source).toEqual({ kind: "source", bunPath: "/usr/bin/bun", cliPath: "/srv/agent-tag/src/cli.ts" });
  expect(serviceProgramArguments(source, "doctor", "/cfg.json")).toEqual(["/usr/bin/bun", "run", "/srv/agent-tag/src/cli.ts", "doctor", "/cfg.json"]);
  expect(serviceProgramPaths(source)).toEqual(["/usr/bin/bun", "/srv/agent-tag/src/cli.ts"]);
});

test("reads both unit shapes back and ignores anything else", () => {
  expect(installedUnitPaths(["/usr/bin/bun", "run", "/srv/src/cli.ts", "run", "/cfg.json"], "/srv")).toEqual({
    program: { kind: "source", bunPath: "/usr/bin/bun", cliPath: "/srv/src/cli.ts" },
    configPath: "/cfg.json",
    workingDirectory: "/srv",
  });
  expect(installedUnitPaths(["/bin/agent-tag", "run", "/cfg.json"], "/")).toEqual({
    program: { kind: "binary", binaryPath: "/bin/agent-tag" },
    configPath: "/cfg.json",
    workingDirectory: "/",
  });
  expect(installedUnitPaths(["/bin/agent-tag", "doctor", "/cfg.json"], undefined)).toEqual({});
  expect(installedUnitPaths(["/bin/true"], undefined)).toEqual({});
  expect(describeInstalledProgram({ unitPath: "/u", ...NOT_INSTALLED })).toBe("unrecognized unit");
});

test("a source checkout installs a unit that runs this checkout's CLI from its root", async () => {
  const root = resolve(import.meta.dir, "..");
  const paths = await currentServiceUnitPaths("/cfg/agent-tag.json");
  expect(paths).toEqual({
    program: { kind: "source", bunPath: process.execPath, cliPath: resolve(root, "src", "cli.ts") },
    configPath: "/cfg/agent-tag.json",
    workingDirectory: root,
  });
});
