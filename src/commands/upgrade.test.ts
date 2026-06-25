import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLatestRelease, githubAuthHeaders } from "./upgrade.js";

// Swap in a fake `fetch` that records the request it receives and returns a
// canned latest-release payload. Restores the real fetch afterward.
function withFakeFetch(
  run: (captured: { url: string; headers: Headers }[]) => Promise<void>,
): Promise<void> {
  const captured: { url: string; headers: Headers }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify({ tag_name: "v9.9.9", assets: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return run(captured).finally(() => {
    globalThis.fetch = real;
  });
}

test("githubAuthHeaders attaches a Bearer token when GITHUB_TOKEN is set", () => {
  const prevGithub = process.env.GITHUB_TOKEN;
  const prevGh = process.env.GH_TOKEN;
  try {
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "secret-token";
    assert.deepEqual(githubAuthHeaders(), { Authorization: "Bearer secret-token" });
  } finally {
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithub;
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
  }
});

test("githubAuthHeaders falls back to GH_TOKEN", () => {
  const prevGithub = process.env.GITHUB_TOKEN;
  const prevGh = process.env.GH_TOKEN;
  try {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "gh-token";
    assert.deepEqual(githubAuthHeaders(), { Authorization: "Bearer gh-token" });
  } finally {
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithub;
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
  }
});

test("githubAuthHeaders is empty when no token is set", () => {
  const prevGithub = process.env.GITHUB_TOKEN;
  const prevGh = process.env.GH_TOKEN;
  try {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    assert.deepEqual(githubAuthHeaders(), {});
  } finally {
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithub;
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
  }
});

test("fetchLatestRelease sends Authorization when GITHUB_TOKEN is set", async () => {
  const prev = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = "secret-token";
    await withFakeFetch(async (captured) => {
      const release = await fetchLatestRelease();
      assert.equal(release.tag_name, "v9.9.9");
      assert.equal(captured.length, 1);
      assert.equal(captured[0].headers.get("authorization"), "Bearer secret-token");
      assert.equal(captured[0].headers.get("accept"), "application/vnd.github+json");
    });
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});

test("fetchLatestRelease omits Authorization when no token is set", async () => {
  const prevGithub = process.env.GITHUB_TOKEN;
  const prevGh = process.env.GH_TOKEN;
  try {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    await withFakeFetch(async (captured) => {
      await fetchLatestRelease();
      assert.equal(captured[0].headers.has("authorization"), false);
    });
  } finally {
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithub;
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
  }
});
