import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { agentTagConfigSchema } from "../src/config.ts";
import {
  classifyInboundFile,
  downloadSlackFile,
  parseSlackFileInfo,
  precheckInboundFile,
  SlackFileError,
  type SlackFileInfo,
} from "../src/slack/files.ts";
import { sniffImageMime } from "../src/slack/sniff.ts";

const baseConfig = {
  version: 1,
  dataDir: "/var/lib/agent-tag",
  t3: { baseUrl: "http://127.0.0.1:37841", tokenFile: "/var/lib/agent-tag/t3-token" },
  slack: {
    workspaceId: "T1",
    appTokenFile: "/var/lib/agent-tag/slack-app-token",
    botTokenFile: "/var/lib/agent-tag/slack-bot-token",
  },
  access: { allowedUserIds: ["U1"], allowedChannelIds: ["C1"] },
  profiles: [
    {
      id: "engineering",
      repositoryRoots: ["/srv/repos/example"],
      baseBranch: "main",
      defaultProviderInstanceId: "codex",
      defaultModel: "gpt-5.6-sol",
      runtimeMode: "approval-required",
      isolation: { mode: "trusted-same-user", acknowledgedSharedMachineAccess: true },
      externalWrites: { mode: "deny" },
      memory: { shared: true, privateDm: false, retentionDays: 180 },
    },
  ],
  routes: [{ conversationId: "C1", profileId: "engineering" }],
  limits: { maxConcurrentTasks: 1 },
};
const parseFiles = (files?: unknown) =>
  agentTagConfigSchema.parse({ ...baseConfig, ...(files === undefined ? {} : { files }) }).files;
const limits = parseFiles().inbound;
const token = { exposeToBoundary: () => "xoxb-test-token" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

/** A loopback server standing in for every https host; requests record the host and auth header. */
let server: ReturnType<typeof Bun.serve>;
const seen: { host: string; path: string; authorization: string | null }[] = [];
const routes = new Map<string, (request: Request) => Response | Promise<Response>>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      const host = request.headers.get("x-original-host") ?? "";
      seen.push({ host, path: url.pathname, authorization: request.headers.get("authorization") });
      const route = routes.get(`${host}${url.pathname}`);
      return route === undefined ? new Response("not found", { status: 404 }) : route(request);
    },
  });
});
afterAll(() => server.stop(true));

/** Sends https://<host>/<path> to the loopback server, keeping the original host in a header. */
const loopback = (url: URL, init: RequestInit) => {
  const headers = new Headers(init.headers);
  headers.set("x-original-host", url.hostname);
  return fetch(`http://127.0.0.1:${server.port}${url.pathname}`, { ...init, headers });
};

function reset() {
  seen.length = 0;
  routes.clear();
}

describe("downloadSlackFile", () => {
  test("sends the token to files.slack.com only, and follows a redirect to slack-edge without it", async () => {
    reset();
    routes.set("files.slack.com/files-pri/a", () =>
      new Response(null, { status: 302, headers: { location: "https://cdn.slack-edge.com/blob/a" } }));
    routes.set("cdn.slack-edge.com/blob/a", () => new Response(PNG, { headers: { "content-type": "image/png" } }));
    const result = await downloadSlackFile({ url: "https://files.slack.com/files-pri/a", token, maxBytes: 100, fetch: loopback });
    expect(result.bytes).toEqual(PNG);
    expect(seen).toEqual([
      { host: "files.slack.com", path: "/files-pri/a", authorization: "Bearer xoxb-test-token" },
      { host: "cdn.slack-edge.com", path: "/blob/a", authorization: null },
    ]);
  });

  test("refuses a redirect off the Slack hosts, and any non-https or non-Slack start URL", async () => {
    reset();
    routes.set("files.slack.com/files-pri/b", () =>
      new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } }));
    await expect(
      downloadSlackFile({ url: "https://files.slack.com/files-pri/b", token, maxBytes: 100, fetch: loopback }),
    ).rejects.toEqual(new SlackFileError("download-failed"));
    expect(seen.map((request) => request.host)).toEqual(["files.slack.com"]);
    for (const url of ["http://files.slack.com/x", "https://evil.example/x", "https://files.slack.com.evil.example/x", "not a url"]) {
      await expect(downloadSlackFile({ url, token, maxBytes: 100, fetch: loopback })).rejects.toEqual(
        new SlackFileError("unavailable"),
      );
    }
    expect(seen).toHaveLength(1);
  });

  test("stops after three redirects", async () => {
    reset();
    routes.set("files.slack.com/loop", () =>
      new Response(null, { status: 302, headers: { location: "https://files.slack.com/loop" } }));
    await expect(
      downloadSlackFile({ url: "https://files.slack.com/loop", token, maxBytes: 100, fetch: loopback }),
    ).rejects.toEqual(new SlackFileError("download-failed"));
    expect(seen).toHaveLength(4);
  });

  test("an HTML login page (no files:read) is a missing scope, not a file", async () => {
    reset();
    routes.set("files.slack.com/login", () => new Response("<html>sign in</html>", { headers: { "content-type": "text/html; charset=utf-8" } }));
    await expect(
      downloadSlackFile({ url: "https://files.slack.com/login", token, maxBytes: 100, fetch: loopback }),
    ).rejects.toEqual(new SlackFileError("missing-scope"));
    // A file declared as HTML is still downloaded.
    const page = await downloadSlackFile({
      url: "https://files.slack.com/login",
      token,
      maxBytes: 100,
      declaredMimeType: "text/html",
      fetch: loopback,
    });
    expect(new TextDecoder().decode(page.bytes)).toBe("<html>sign in</html>");
  });

  test("caps the streamed body, maps HTTP errors and times out", async () => {
    reset();
    routes.set("files.slack.com/big", () => new Response(new Uint8Array(4096)));
    routes.set("files.slack.com/forbidden", () => new Response("no", { status: 403 }));
    routes.set("files.slack.com/broken", () => new Response("no", { status: 500 }));
    routes.set("files.slack.com/slow", async () => {
      await Bun.sleep(500);
      return new Response("late");
    });
    await expect(downloadSlackFile({ url: "https://files.slack.com/big", token, maxBytes: 1000, fetch: loopback })).rejects.toEqual(
      new SlackFileError("too-large"),
    );
    await expect(
      downloadSlackFile({ url: "https://files.slack.com/forbidden", token, maxBytes: 1000, fetch: loopback }),
    ).rejects.toEqual(new SlackFileError("missing-scope"));
    await expect(
      downloadSlackFile({ url: "https://files.slack.com/broken", token, maxBytes: 1000, fetch: loopback }),
    ).rejects.toEqual(new SlackFileError("download-failed"));
    await expect(
      downloadSlackFile({ url: "https://files.slack.com/slow", token, maxBytes: 1000, timeoutMs: 50, fetch: loopback }),
    ).rejects.toEqual(new SlackFileError("download-failed"));
  });

  test("a caller abort propagates as the abort, not a skip", async () => {
    reset();
    routes.set("files.slack.com/slow", async () => {
      await Bun.sleep(500);
      return new Response("late");
    });
    const controller = new AbortController();
    const pending = downloadSlackFile({
      url: "https://files.slack.com/slow",
      token,
      maxBytes: 1000,
      signal: controller.signal,
      fetch: loopback,
    });
    controller.abort(new Error("shutdown"));
    await expect(pending).rejects.toThrow("shutdown");
  });
});

const ref = { id: "F1", name: "a.png", mimetype: "image/png", size: 10 };
const info = (extra: Partial<SlackFileInfo> = {}): SlackFileInfo => ({
  id: "F1",
  name: "a.png",
  mimetype: "image/png",
  size: 10,
  isExternal: false,
  urlPrivateDownload: "https://files.slack.com/files-pri/T1-F1/a.png",
  ...extra,
});

describe("classification", () => {
  test("sniffs the four T3 image types from magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
    expect(sniffImageMime(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageMime(new TextEncoder().encode("RIFF\0\0\0\0WAVE"))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("<svg/>"))).toBeNull();
  });

  test("prechecks decide from metadata before any download", () => {
    expect(precheckInboundFile(0, ref, info(), limits)).toBeNull();
    expect(precheckInboundFile(5, ref, info(), limits)).toBe("limit-count");
    expect(precheckInboundFile(0, ref, info({ isExternal: true }), limits)).toBe("external");
    expect(precheckInboundFile(0, ref, info({ mode: "tombstone" }), limits)).toBe("unavailable");
    expect(precheckInboundFile(0, ref, info({ mode: "hidden_by_limit" }), limits)).toBe("unavailable");
    expect(precheckInboundFile(0, ref, info({ filetype: "quip" }), limits)).toBe("type-denied");
    expect(precheckInboundFile(0, ref, info({ name: "run.EXE" }), { ...limits, deniedExtensions: ["exe"] })).toBe(
      "type-denied",
    );
    expect(precheckInboundFile(0, ref, info({ size: 26 * 1024 * 1024 }), limits)).toBe("too-large");
    expect(precheckInboundFile(0, ref, info({ size: 0 }), limits)).toBe("unavailable");
    const { urlPrivateDownload: _, ...noUrl } = info();
    expect(precheckInboundFile(0, ref, noUrl, limits)).toBe("unavailable");
  });

  test("images come from bytes; a declared image with other bytes is a mismatch", () => {
    expect(classifyInboundFile(ref, info(), PNG, limits)).toEqual({ kind: "attach", type: "image", mimeType: "image/png", name: "a.png" });
    expect(classifyInboundFile(ref, info(), new TextEncoder().encode("not a png"), limits)).toEqual({
      kind: "skip",
      reason: "type-mismatch",
    });
    // image/jpg is an alias Slack uses for JPEG.
    expect(classifyInboundFile(ref, info({ mimetype: "image/jpg" }), new Uint8Array([0xff, 0xd8, 0xff, 0]), limits)).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
    });
    // An image declared as something else is still sent as the image it is.
    expect(classifyInboundFile(ref, info({ mimetype: "application/octet-stream" }), PNG, limits)).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    // An SVG is not a T3 image type, so it travels as a file.
    expect(
      classifyInboundFile(ref, info({ name: "logo.svg", mimetype: "image/svg+xml" }), new TextEncoder().encode("<svg/>"), limits),
    ).toEqual({ kind: "attach", type: "file", mimeType: "image/svg+xml", name: "logo.svg" });
  });

  test("an image over the image cap is sent as a file; over the file cap it is too large", () => {
    const small = { ...limits, maxImageBytes: 4, maxFileBytes: 20 };
    expect(classifyInboundFile(ref, info(), PNG, small)).toEqual({ kind: "attach", type: "file", mimeType: "image/png", name: "a.png" });
    expect(classifyInboundFile(ref, info(), PNG, { ...small, maxFileBytes: 5 })).toEqual({ kind: "skip", reason: "too-large" });
  });

  test("snippets are text; a bad declared mime falls back to octet-stream; names are one safe line", () => {
    const text = new TextEncoder().encode("echo hi");
    expect(classifyInboundFile(ref, info({ name: "run.sh", mimetype: "", mode: "snippet" }), text, limits)).toMatchObject({
      type: "file",
      mimeType: "text/plain",
    });
    expect(classifyInboundFile(ref, info({ name: "x.bin", mimetype: "not a mime" }), text, limits)).toMatchObject({
      mimeType: "application/octet-stream",
    });
    expect(classifyInboundFile(ref, info({ name: "a\nb\u0000c.txt", mimetype: "text/plain" }), text, limits)).toMatchObject({
      name: "a b c.txt",
    });
    expect(classifyInboundFile({ id: "F9" }, info({ name: "   ", mimetype: "text/plain" }), text, limits)).toMatchObject({
      name: "F9",
    });
    expect(classifyInboundFile(ref, info({ name: "x".repeat(400), mimetype: "text/plain" }), text, limits)).toMatchObject({
      name: "x".repeat(255),
    });
  });

  test("parses files.info and drops nothing it needs", () => {
    expect(
      parseSlackFileInfo({
        ok: true,
        file: { id: "F1", name: "a.png", mimetype: "image/png", filetype: "png", size: 3, mode: "hosted", url_private_download: "https://files.slack.com/x" },
      }),
    ).toEqual({
      id: "F1",
      name: "a.png",
      mimetype: "image/png",
      filetype: "png",
      size: 3,
      mode: "hosted",
      isExternal: false,
      urlPrivateDownload: "https://files.slack.com/x",
    });
    expect(parseSlackFileInfo({ ok: true, file: { id: "F2", is_external: true } })).toEqual({ id: "F2", isExternal: true });
  });
});

describe("config", () => {
  test("defaults and caps follow T3's limits", () => {
    expect(limits).toEqual({
      enabled: true,
      maxFilesPerMessage: 5,
      maxImageBytes: 10 * 1024 * 1024,
      maxFileBytes: 25 * 1024 * 1024,
      deniedExtensions: [],
    });
    const files = { parse: parseFiles };
    expect(() => files.parse({ inbound: { maxFilesPerMessage: 9 } })).toThrow();
    expect(() => files.parse({ inbound: { maxImageBytes: 10 * 1024 * 1024 + 1 } })).toThrow();
    expect(() => files.parse({ inbound: { maxFileBytes: 50 * 1024 * 1024 + 1 } })).toThrow();
    expect(() => files.parse({ inbound: { deniedExtensions: [".exe"] } })).toThrow();
    expect(() => files.parse({ inbound: { surprise: true } })).toThrow();
  });
});
