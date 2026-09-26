import { z } from "zod";

const pinSchema = z.object({
  version: z.string().min(1),
  tag: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  releasedAt: z.iso.datetime(),
  sourceUrl: z.url(),
  releaseUrl: z.url(),
  effectVersion: z.string().min(1),
  npm: z.object({
    package: z.string().min(1),
    integrity: z.string().startsWith("sha512-"),
  }),
  artifacts: z.record(
    z.string(),
    z.object({ name: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
});

const githubReleaseSchema = z.object({
  tag_name: z.string(),
  target_commitish: z.string(),
  published_at: z.string(),
  html_url: z.url(),
  assets: z.array(z.object({ name: z.string(), digest: z.string().nullable() })),
});

const npmManifestSchema = z.object({
  version: z.string(),
  dist: z.object({ integrity: z.string() }),
});

export type T3Pin = z.infer<typeof pinSchema>;

export function parseT3Pin(input: unknown): T3Pin {
  return pinSchema.parse(input);
}

export function compareRemotePin(input: {
  readonly pin: T3Pin;
  readonly githubRelease: unknown;
  readonly npmManifest: unknown;
}): string[] {
  const release = githubReleaseSchema.parse(input.githubRelease);
  const npmManifest = npmManifestSchema.parse(input.npmManifest);
  const failures: string[] = [];

  if (release.tag_name !== input.pin.tag) failures.push(`release tag ${release.tag_name}`);
  if (release.target_commitish !== input.pin.commit) {
    failures.push(`release commit ${release.target_commitish}`);
  }
  if (release.published_at !== input.pin.releasedAt) {
    failures.push(`release date ${release.published_at}`);
  }
  if (release.html_url !== input.pin.releaseUrl) failures.push(`release URL ${release.html_url}`);
  if (npmManifest.version !== input.pin.version) {
    failures.push(`npm version ${npmManifest.version}`);
  }
  if (npmManifest.dist.integrity !== input.pin.npm.integrity) {
    failures.push("npm integrity mismatch");
  }

  for (const artifact of Object.values(input.pin.artifacts)) {
    const published = release.assets.find((candidate) => candidate.name === artifact.name);
    if (published === undefined) {
      failures.push(`missing release artifact ${artifact.name}`);
    } else if (published.digest !== `sha256:${artifact.sha256}`) {
      failures.push(`digest mismatch for ${artifact.name}`);
    }
  }

  return failures;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "agent-tag-pin-check" },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  return body;
}

export async function verifyRemotePin(pin: T3Pin): Promise<void> {
  const repository = new URL(pin.sourceUrl).pathname.replace(/^\//, "");
  const [githubRelease, npmManifest] = await Promise.all([
    fetchJson(`https://api.github.com/repos/${repository}/releases/tags/${pin.tag}`),
    fetchJson(`https://registry.npmjs.org/${pin.npm.package}/${pin.version}`),
  ]);
  const failures = compareRemotePin({ pin, githubRelease, npmManifest });
  if (failures.length > 0) {
    throw new Error(`T3 pin verification failed: ${failures.join(", ")}`);
  }
}

export async function verifyT3Binary(input: {
  readonly pin: T3Pin;
  readonly binary: string;
}): Promise<void> {
  const child = Bun.spawn([input.binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`T3 binary check failed: ${stderr.trim()}`);
  if (stdout.trim() !== `t3 v${input.pin.version}`) {
    throw new Error(`T3 binary reported ${JSON.stringify(stdout.trim())}`);
  }
}
