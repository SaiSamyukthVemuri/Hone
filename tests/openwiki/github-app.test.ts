import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  RUNNER_TOKEN_PERMISSIONS,
  assertExactPermissions,
  createAppJwt,
  createGitHubClient,
  createInstallationToken,
  // @ts-expect-error - .mjs utility ships without type declarations
} from "../../scripts/openwiki/github-app.mjs";

// WIKI-AUTO-01. The runner's GitHub identity is an App installation token
// narrowed to exactly five permissions on exactly one repository. In
// particular it never holds `workflows`, so GitHub itself refuses any push of
// the workflow scaffold OpenWiki writes on init.

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

function fakeFetch(respond: (call: Call) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  const impl = async (url: string, init: Call["init"]) => {
    const call = { url, init };
    calls.push(call);
    const { status, json } = respond(call);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { calls, impl };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("createAppJwt", () => {
  it("is a verifiable RS256 token, issued 60 s back and valid for 9 minutes", () => {
    const jwt: string = createAppJwt({ appId: 12345, privateKeyPem: PEM, nowSeconds: 1_000_000 });
    const [header, payload, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({ iat: 999_940, exp: 1_000_540, iss: "12345" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

describe("assertExactPermissions", () => {
  it("accepts exactly the runner set", () => {
    expect(() => assertExactPermissions({ ...RUNNER_TOKEN_PERMISSIONS })).not.toThrow();
  });

  it.each([
    ["an extra workflows permission", { ...RUNNER_TOKEN_PERMISSIONS, workflows: "write" }, /workflows: not allowed/u],
    ["a missing permission", { metadata: "read", contents: "write" }, /pull_requests: expected write, got none/u],
    ["a broader level", { ...RUNNER_TOKEN_PERMISSIONS, checks: "write" }, /checks: expected read, got write/u],
  ])("refuses %s", (_label: string, actual: Record<string, string>, message: RegExp) => {
    expect(() => assertExactPermissions(actual)).toThrow(message);
  });
});

describe("createInstallationToken", () => {
  const ok = { token: "ghs_fixtureTokenValue000000000", expires_at: "2026-10-05T00:00:00Z" };

  it("requests the narrowed permission set for one repository, and returns the token", async () => {
    const fetch = fakeFetch(() => ({
      status: 201,
      json: { ...ok, permissions: RUNNER_TOKEN_PERMISSIONS, repositories: [{ full_name: "owner/repo" }] },
    }));
    const result = await createInstallationToken({ appId: 1, installationId: 99, privateKeyPem: PEM, repository: "owner/repo", fetchImpl: fetch.impl });
    expect(result.token).toBe(ok.token);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect(fetch.calls[0].init.method).toBe("POST");
    expect(JSON.parse(fetch.calls[0].init.body)).toEqual({ repositories: ["repo"], permissions: RUNNER_TOKEN_PERMISSIONS });
  });

  it("refuses a token whose grant is broader than requested", async () => {
    const fetch = fakeFetch(() => ({
      status: 201,
      json: { ...ok, permissions: { ...RUNNER_TOKEN_PERMISSIONS, administration: "write" }, repositories: [{ full_name: "owner/repo" }] },
    }));
    await expect(
      createInstallationToken({ appId: 1, installationId: 99, privateKeyPem: PEM, repository: "owner/repo", fetchImpl: fetch.impl }),
    ).rejects.toThrow(/administration: not allowed/u);
  });

  it("refuses a token scoped to another repository set", async () => {
    const fetch = fakeFetch(() => ({
      status: 201,
      json: { ...ok, permissions: RUNNER_TOKEN_PERMISSIONS, repositories: [{ full_name: "owner/repo" }, { full_name: "owner/other" }] },
    }));
    await expect(
      createInstallationToken({ appId: 1, installationId: 99, privateKeyPem: PEM, repository: "owner/repo", fetchImpl: fetch.impl }),
    ).rejects.toThrow(/exactly the configured repository/u);
  });

  it("reports an HTTP failure by status only", async () => {
    const fetch = fakeFetch(() => ({ status: 422, json: { message: "nope" } }));
    await expect(
      createInstallationToken({ appId: 1, installationId: 99, privateKeyPem: PEM, repository: "owner/repo", fetchImpl: fetch.impl }),
    ).rejects.toThrow("installation token request failed: HTTP 422");
  });
});

describe("createGitHubClient", () => {
  it("opens a non-draft pull request and posts one comment, nothing else", async () => {
    const fetch = fakeFetch((call) =>
      call.url.endsWith("/pulls")
        ? { status: 201, json: { number: 7, html_url: "https://github.com/owner/repo/pull/7", head: { sha: "f".repeat(40) } } }
        : { status: 201, json: {} },
    );
    const client = createGitHubClient({ token: "t", repository: "owner/repo", fetchImpl: fetch.impl });
    const pr = await client.createPullRequest({ head: "openwiki/nightly-x", base: "main", title: "t", body: "b" });
    await client.comment(pr.number, "@codex review");
    expect(pr).toEqual({ number: 7, url: "https://github.com/owner/repo/pull/7", headSha: "f".repeat(40) });
    expect(fetch.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST https://api.github.com/repos/owner/repo/pulls",
      "POST https://api.github.com/repos/owner/repo/issues/7/comments",
    ]);
    expect(JSON.parse(fetch.calls[0].init.body)).toMatchObject({ draft: false, base: "main", head: "openwiki/nightly-x" });
    expect(fetch.calls[0].init.headers.Authorization).toBe("Bearer t");
  });
});
