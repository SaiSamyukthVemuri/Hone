#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Deterministic per-worktree E2E resources (TEST-PORT-01).
//
// WHY THIS EXISTS
// Hone is developed across many git worktrees that share one checkout's history
// and one local Supabase stack. Every browser lane bound the SAME app port
// (3111), and playwright.config.ts set `reuseExistingServer: !process.env.CI`.
// Locally that expression is TRUE, so a Playwright run started in worktree A
// found port 3111 already answering, ATTACHED TO WORKTREE B'S SERVER, and
// reported green. The evidence named worktree A and described worktree B's
// code, and nothing in the run said so.
//
// That is why concurrent local browser evidence was inadmissible. This module
// removes the cause: each worktree derives its OWN app port, so a run in A
// cannot reach B's server at all. Where two worktrees do derive the same port
// (see PORT_SPAN), Playwright's `reuseExistingServer: false` refuses to attach
// to the stranger and fails loudly rather than silently borrowing it.
//
// DERIVED, NOT REGISTERED. The port is a pure function of the worktree's
// absolute root path, so every command run inside one worktree agrees on it
// with no lockfile, daemon or shared mutable registry that could go stale.
//
// WHAT IS NOT DERIVED. Only the PORT varies. The HOST is the hardcoded string
// `localhost` and no environment variable can move it, so the local-only
// guarantee enforced by e2e/helpers/local-env.ts is untouched here. This module
// widens exactly one integer and nothing else.
//
// Usage:
//   npm run e2e:resources            # human summary
//   npm run e2e:resources -- --json  # machine-readable
//   node scripts/worktree-resources.mjs --port   # the bare port, for scripts
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * The historical E2E port, and the one CI pins explicitly. It is RESERVED: the
 * derived range starts above it, so a worktree can never be handed the port a
 * CI job or a hand-started server is already using.
 */
export const RESERVED_PORT = 3111;

/**
 * Derived ports occupy 3200-3999: above the reserved port and `next dev`'s
 * default 3000, and far below the ephemeral range the kernel hands out.
 *
 * 800 slots is not collision-free and is not trying to be. With ~26 worktrees
 * the chance any two collide is about 0.4, and a collision is SAFE: the second
 * worktree's server fails to bind, or Playwright refuses to attach to the
 * first's. Both are loud. Spending a global registry to remove a rare, loud,
 * self-announcing failure would make the evidence machinery more complicated
 * than the failure it protects against.
 */
export const PORT_BASE = 3200;
export const PORT_SPAN = 800;

/** Explicit override. CI sets this to RESERVED_PORT so CI behaviour is inert. */
export const PORT_ENV_VAR = "HONE_E2E_PORT";

/**
 * Opt-in to reusing an already-running server. OFF by default, because "reuse
 * whatever is answering on this port" is precisely the cross-worktree attach
 * this module exists to stop. A developer sharing one build across lanes in ONE
 * worktree can set it deliberately.
 */
export const REUSE_ENV_VAR = "HONE_E2E_REUSE_SERVER";

/**
 * NOT configurable, deliberately. `localhost` (not 127.0.0.1) is load-bearing:
 * the auth callback redirects to the origin as the browser presents it and the
 * session cookie must live on one host string end to end. Keeping it a literal
 * also means no environment variable can point this lane at a non-local host.
 */
export const E2E_HOST = "localhost";

/**
 * Resources that are SHARED across every worktree and are NOT isolated by this
 * module. Reported so a caller reading these resources cannot mistake "the app
 * port is isolated" for "this worktree is isolated". Naming them is the point:
 * an unlisted shared resource reads as an isolated one.
 */
export const SHARED_RESOURCES = Object.freeze([
  Object.freeze({
    name: "supabase local stack",
    detail: "one Docker project per project_id: API 54321, DB 54322, Studio 54323, Mailpit 54324",
    consequence: "`supabase db reset --local` in any worktree wipes every other worktree's in-flight run",
  }),
  Object.freeze({
    name: "local Postgres database",
    detail: "one database behind the shared stack",
    consequence: "concurrent runs survive only because each seeds run-unique rows; a reset does not",
  }),
  Object.freeze({
    name: "Mailpit inbox",
    detail: "one inbox on 54324 for every worktree",
    consequence: "magic-link capture relies on per-run unique addresses, not on inbox isolation",
  }),
]);

let cachedIdentity = null;

/**
 * The worktree's absolute root. `git rev-parse --show-toplevel` answers per
 * WORKTREE, not per repository, which is exactly the identity wanted: two
 * worktrees of one clone return two different paths.
 *
 * Falls back to the working directory when git cannot answer, so the module
 * still works in a tarball export or a container without git. The fallback is
 * reported rather than hidden: a caller can tell a real worktree identity from
 * a best-effort one.
 */
export function worktreeIdentity(cwd = process.cwd()) {
  if (cachedIdentity && cachedIdentity.cwd === cwd) return cachedIdentity;
  let root = cwd;
  let source = "cwd";
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) source = "git-toplevel";
    else root = cwd;
  } catch {
    root = cwd;
  }
  cachedIdentity = { cwd, root, source };
  return cachedIdentity;
}

/**
 * Absolute path -> a port in [PORT_BASE, PORT_BASE + PORT_SPAN).
 *
 * SHA-256 rather than a hand-rolled string hash: it is in the standard library,
 * it is stable across Node versions and platforms, and its distribution across
 * 800 buckets needs no argument. The port must be reproducible on any machine
 * for the same path, so nothing here may depend on process state.
 */
export function derivePort(root) {
  const digest = createHash("sha256").update(root, "utf8").digest();
  return PORT_BASE + (digest.readUInt32BE(0) % PORT_SPAN);
}

/**
 * Reads and validates an explicit port override. Rejects anything that is not a
 * plain integer in the unprivileged range: an override is allowed to choose a
 * PORT, never to smuggle in a host, a URL or a privileged bind.
 */
export function parsePortOverride(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = String(raw).trim();
  if (!/^[0-9]{1,5}$/.test(value)) {
    throw new Error(
      `${PORT_ENV_VAR} must be a plain port number, got ${JSON.stringify(raw)}.`,
    );
  }
  const port = Number(value);
  if (port < 1024 || port > 65535) {
    throw new Error(`${PORT_ENV_VAR} must be between 1024 and 65535, got ${port}.`);
  }
  return port;
}

/** Reuse is opt-in and only the exact string "1" enables it. */
export function parseReuse(raw) {
  return String(raw ?? "") === "1";
}

/**
 * The full resource set for one worktree. Pure with respect to its arguments so
 * the tests can derive resources for a directory they create, rather than only
 * for the checkout the test happens to run in.
 */
export function resolveResources({ cwd = process.cwd(), env = process.env } = {}) {
  const identity = worktreeIdentity(cwd);
  const override = parsePortOverride(env[PORT_ENV_VAR]);
  const port = override ?? derivePort(identity.root);
  const reuseExistingServer = parseReuse(env[REUSE_ENV_VAR]);

  return {
    worktree: identity.root,
    identitySource: identity.source,
    host: E2E_HOST,
    port,
    portSource: override === null ? "derived" : `env:${PORT_ENV_VAR}`,
    origin: `http://${E2E_HOST}:${port}`,
    reservedPort: RESERVED_PORT,
    derivedRange: [PORT_BASE, PORT_BASE + PORT_SPAN - 1],
    reuseExistingServer,
    reuseSource: reuseExistingServer ? `env:${REUSE_ENV_VAR}` : "default",
    sharedNotIsolated: SHARED_RESOURCES,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("worktree-resources.mjs")) {
  const r = resolveResources();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else if (process.argv.includes("--port")) {
    console.log(String(r.port));
  } else {
    const DIM = "[2m";
    const RESET = "[0m";
    console.log(`\nE2E resources for this worktree\n`);
    console.log(`  worktree   ${r.worktree} ${DIM}(${r.identitySource})${RESET}`);
    console.log(`  app origin ${r.origin} ${DIM}(port ${r.portSource})${RESET}`);
    console.log(
      `  reuse      ${r.reuseExistingServer} ${DIM}(${r.reuseSource}; off means a stranger's server is refused, not borrowed)${RESET}`,
    );
    console.log(
      `\n  ${DIM}derived range ${r.derivedRange[0]}-${r.derivedRange[1]}; ${r.reservedPort} is reserved and never derived${RESET}`,
    );
    console.log(`\nSHARED across worktrees, NOT isolated by this module:`);
    for (const s of r.sharedNotIsolated) {
      console.log(`  • ${s.name} ${DIM}- ${s.detail}${RESET}`);
      console.log(`    ${DIM}${s.consequence}${RESET}`);
    }
    console.log("");
  }
}
