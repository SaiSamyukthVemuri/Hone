// ---------------------------------------------------------------------------
// WIKI-AUTO-01: the runner's GitHub identity is a GitHub App installation
// token, never an operator's personal token.
//
// The token is requested NARROWED to RUNNER_TOKEN_PERMISSIONS and the
// response is checked for exactly that set: a token that could also write
// workflows, administer the repository or read anything else is refused
// before it is used. Without `workflows`, GitHub itself rejects any push that
// touches .github/workflows/, so the scaffold OpenWiki writes on init can
// never be published even by mistake.
//
// The token lives in memory only. It reaches git through GIT_ASKPASS reading
// an environment variable (see nightly.mjs), never argv, a URL or a file.
//
// Errors carry `tokenCause` (a code from report.mjs TOKEN_CAUSES) and
// `httpStatus`. The runner reads only those fields. A message can quote API
// data, so it never reaches a report.
// ---------------------------------------------------------------------------

import { createSign } from "node:crypto";

export const RUNNER_TOKEN_PERMISSIONS = Object.freeze({
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
});

const API = "https://api.github.com";

function failure(message, fields) {
  return Object.assign(new Error(message), fields);
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

/** RS256 App JWT: issued 60 s in the past for clock skew, valid 9 minutes. */
export function createAppJwt({ appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

/** Throws unless `actual` grants exactly `expected`, naming permissions but never token material. */
export function assertExactPermissions(actual, expected = RUNNER_TOKEN_PERMISSIONS) {
  const got = actual ?? {};
  const problems = [];
  for (const [name, level] of Object.entries(expected)) {
    if (got[name] !== level) problems.push(`${name}: expected ${level}, got ${got[name] ?? "none"}`);
  }
  for (const name of Object.keys(got)) {
    if (!(name in expected)) problems.push(`${name}: not allowed (${got[name]})`);
  }
  if (problems.length > 0) throw failure(`installation token permissions are not exact: ${problems.join("; ")}`, { tokenCause: "permissions-not-exact" });
}

function headers(auth) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${auth}`,
    "User-Agent": "hone-wiki-runner",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Mint an installation token for one repository with exactly the runner's
 * permissions. `repository` is "owner/name".
 */
export async function createInstallationToken({ appId, installationId, privateKeyPem, repository, fetchImpl = fetch, nowSeconds }) {
  const [, name] = String(repository).split("/");
  if (!name) throw failure("repository must be owner/name", { tokenCause: "invalid-repository" });
  const jwt = createAppJwt({ appId, privateKeyPem, nowSeconds });
  const response = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...headers(jwt), "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [name], permissions: RUNNER_TOKEN_PERMISSIONS }),
  });
  if (!response.ok) throw failure(`installation token request failed: HTTP ${response.status}`, { tokenCause: "http-status", httpStatus: response.status });
  const data = await response.json();
  assertExactPermissions(data.permissions);
  const repos = (data.repositories ?? []).map((r) => r.full_name);
  if (repos.length !== 1 || repos[0] !== repository) {
    throw failure("installation token is not scoped to exactly the configured repository", { tokenCause: "repository-scope" });
  }
  return { token: data.token, expiresAt: data.expires_at };
}

/**
 * The GitHub writes the runner makes: open one pull request, post one comment
 * on it, and close it again when it cannot be completed. No merge call exists.
 */
export function createGitHubClient({ token, repository, fetchImpl = fetch }) {
  async function call(method, route, body) {
    const response = await fetchImpl(`${API}/repos/${repository}${route}`, {
      method,
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw failure(`${method} ${route} failed: HTTP ${response.status}`, { httpStatus: response.status });
    return response.json();
  }
  return {
    async createPullRequest({ head, base, title, body }) {
      const pr = await call("POST", "/pulls", { head, base, title, body, draft: false, maintainer_can_modify: false });
      return { number: pr.number, url: pr.html_url, headSha: pr.head?.sha };
    },
    async comment(number, body) {
      await call("POST", `/issues/${number}/comments`, { body });
    },
    async closePullRequest(number) {
      await call("PATCH", `/pulls/${number}`, { state: "closed" });
    },
  };
}
