import { describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";

import { SecretString } from "../src/security/secret-file.ts";
import { compareRemotePin, parseT3Pin, verifyRemotePin } from "../src/t3/pin.ts";

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
  test("uses the CI credential only for GitHub and refuses redirects", async () => {
    const requests: { origin: string; authorization: string | null; redirect: RequestRedirect | undefined }[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (...[url, init]: Parameters<typeof fetch>) => {
      const origin = new URL(String(url)).origin;
      requests.push({ origin, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
      return Response.json(origin === "https://api.github.com" ? matchingRelease() : matchingManifest());
    }, { preconnect: fetch.preconnect }));
    try {
      await verifyRemotePin(pin, new SecretString("ci-test-canary"));
      expect(requests).toContainEqual({ origin: "https://api.github.com", authorization: "Bearer ci-test-canary", redirect: "error" });
      expect(requests).toContainEqual({ origin: "https://registry.npmjs.org", authorization: null, redirect: "error" });
    } finally { fetchSpy.mockRestore(); }
  });

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
