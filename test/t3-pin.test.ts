import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { compareRemotePin, parseT3Pin } from "../src/t3/pin.ts";

const pinPath = resolve(import.meta.dir, "..", "t3.lock.json");
const pin = parseT3Pin(await Bun.file(pinPath).json());

function matchingRelease(): unknown {
  return {
    tag_name: pin.tag,
    target_commitish: pin.commit,
    published_at: pin.releasedAt,
    html_url: pin.releaseUrl,
    assets: Object.values(pin.artifacts).map((artifact) => ({
      name: artifact.name,
      digest: `sha256:${artifact.sha256}`,
    })),
  };
}

function matchingManifest(): unknown {
  return { version: pin.version, dist: { integrity: pin.npm.integrity } };
}

describe("T3 release pin", () => {
  test("accepts matching release metadata", () => {
    expect(
      compareRemotePin({
        pin,
        githubRelease: matchingRelease(),
        npmManifest: matchingManifest(),
      }),
    ).toEqual([]);
  });

  test("rejects a retargeted tag", () => {
    const release = {
      tag_name: pin.tag,
      target_commitish: "0".repeat(40),
      published_at: pin.releasedAt,
      html_url: pin.releaseUrl,
      assets: Object.values(pin.artifacts).map((artifact) => ({
        name: artifact.name,
        digest: `sha256:${artifact.sha256}`,
      })),
    };
    expect(
      compareRemotePin({ pin, githubRelease: release, npmManifest: matchingManifest() }),
    ).toContain(`release commit ${"0".repeat(40)}`);
  });
});
