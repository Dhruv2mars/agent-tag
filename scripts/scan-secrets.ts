import { resolve } from "node:path";

import { loadConfig } from "../src/config.ts";
import { readSecretFile } from "../src/security/secret-file.ts";
import { scanForSecrets, type SecretCanary } from "../src/security/secret-scan.ts";

function usage(): never {
  throw new Error("usage: scan-secrets [--config CONFIG] ROOT [ROOT ...]");
}

const arguments_ = process.argv.slice(2);
let configPath: string | undefined;
if (arguments_[0] === "--config") {
  configPath = arguments_[1];
  if (configPath === undefined) usage();
  arguments_.splice(0, 2);
}

const configuredRoots: string[] = [];
const canaries: SecretCanary[] = [];
const excludedPaths: string[] = [];
if (configPath !== undefined) {
  const config = await loadConfig(resolve(configPath));
  const secretFiles = [
    { name: "t3-service-token", path: config.t3.tokenFile },
    { name: "slack-app-token", path: config.slack.appTokenFile },
    { name: "slack-bot-token", path: config.slack.botTokenFile },
  ];
  configuredRoots.push(config.dataDir, ...config.profiles.flatMap((profile) => profile.repositoryRoots));
  for (const secretFile of secretFiles) {
    const secret = await readSecretFile(secretFile.path);
    canaries.push({ name: secretFile.name, secret });
    excludedPaths.push(secretFile.path);
  }
}

const roots = [...arguments_.map((path) => resolve(path)), ...configuredRoots];
if (roots.length === 0) usage();
const result = await scanForSecrets({ roots, canaries, excludedPaths });
console.log(JSON.stringify(result, null, 2));
if (result.findings.length > 0 || result.symlinksSkipped > 0) process.exitCode = 1;
