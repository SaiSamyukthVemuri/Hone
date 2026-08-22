#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Deterministic per-worktree E2E app port (TEST-PORT-01).
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
// THE CONTRACT, in full:
//   1. each worktree deterministically derives a CANDIDATE local app port;
//   2. the candidate stays in the derived range and never equals CI port 3111;
//   3. the host is the literal `localhost`;
//   4. an explicit numeric override is permitted, and is bounded;
//   5. Playwright NEVER reuses an already-running server for Hone evidence;
//   6. an occupied candidate port makes startup FAIL LOUDLY.
//
// Global uniqueness across arbitrary worktree paths is NOT promised, and cannot
// be: a pure hash into a bounded range permits collisions. It does not need to
// be. Because reuse is unconditionally OFF, a collision cannot end in a browser
// run attaching to another worktree's server; it ends in a refusal. The
// protected property is `occupied port -> loud failure`, never
// `hash -> perfect uniqueness`.
//
// NO OPT-IN TO REUSE EXISTS, deliberately. An earlier vehicle offered
// HONE_E2E_REUSE_SERVER=1 so one worktree could share a build across lanes.
// That flag was worktree-BLIND: it meant "reuse whatever answers on this port",
// not "reuse my own server", so combined with a candidate collision it
// recreated the exact silent cross-worktree attachment this module exists to
// remove. An escape hatch that restores the original defect is not part of
// TEST-PORT-01, so there is no flag to set.
//
// DERIVED, NOT REGISTERED. The port is a pure function of the worktree's
// absolute root path, so every command run inside one worktree agrees on it
// with no lockfile, daemon, lock service or identity handshake to go stale.
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
 * derived range starts above it, so a worktree is never handed the port a CI
 * job or a hand-started server is already using.
 */
export const RESERVED_PORT = 3111;

/**
 * Derived candidates occupy 3200-3999: above the reserved port and `next dev`'s
 * default 3000, and far below the ephemeral range the kernel hands out.
 *
 * 800 slots is not collision-free and is not trying to be. A collision is SAFE
 * because reuse is unconditionally off: the second worktree's bind is refused
 * and the run stops. Spending a registry to remove a rare, loud,
 * self-announcing failure would make the evidence machinery more complicated
 * than the failure class it protects against.
 */
export const PORT_BASE = 3200;
export const PORT_SPAN = 800;

/** Explicit override. CI sets this to RESERVED_PORT so CI behaviour is inert. */
export const PORT_ENV_VAR = "HONE_E2E_PORT";

/**
 * NOT configurable, deliberately. `localhost` (not 127.0.0.1) is load-bearing:
 * the auth callback redirects to the origin as the browser presents it and the
 * session cookie must live on one host string end to end. Keeping it a literal
 * also means no environment variable can point this lane at a non-local host.
 */
export const E2E_HOST = "localhost";

/**
 * Resources that are SHARED across every worktree and are NOT isolated here.
 * Reported so a caller cannot mistake "the app port is isolated" for "this
 * worktree is isolated". Naming them is the point: an unlisted shared resource
 * reads as an isolated one.
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

/**
 * The worktree's absolute root. `git rev-parse --show-toplevel` answers per
 * WORKTREE, not per repository, which is exactly the identity wanted: two
 * worktrees of one clone return two different paths.
 *
 * Falls back to the working directory when git cannot answer, so this still
 * works in a tarball export or a container without git. The fallback is
 * REPORTED rather than hidden, so a best-effort identity is never mistaken for
 * an authoritative one.
 */
export function worktreeIdentity(cwd = process.cwd()) {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return { root, source: "git-toplevel" };
  } catch {
    // fall through
  }
  return { root: cwd, source: "cwd" };
}

/**
 * Absolute path -> a candidate port in [PORT_BASE, PORT_BASE + PORT_SPAN).
 *
 * SHA-256 rather than a hand-rolled string hash: it is in the standard library,
 * stable across Node versions and platforms, and needs no argument about its
 * distribution. The candidate must be reproducible on any machine for the same
 * path, so nothing here may depend on process state.
 */
export function derivePort(root) {
  const digest = createHash("sha256").update(root, "utf8").digest();
  return PORT_BASE + (digest.readUInt32BE(0) % PORT_SPAN);
}

/**
 * Reads and validates an explicit port override. Rejects anything that is not a
 * plain integer in the unprivileged range: an override may choose a PORT, never
 * smuggle in a host, a URL or a privileged bind.
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

/**
 * The full resource set for one worktree. Pure with respect to its arguments so
 * tests can resolve resources for a directory they create, rather than only for
 * the checkout the test happens to run in.
 *
 * There is no reuse field: reuse is not a setting. Playwright configs hardcode
 * `reuseExistingServer: false`.
 */
export function resolveResources({ cwd = process.cwd(), env = process.env } = {}) {
  const identity = worktreeIdentity(cwd);
  const override = parsePortOverride(env[PORT_ENV_VAR]);
  const port = override ?? derivePort(identity.root);

  return {
    worktree: identity.root,
    identitySource: identity.source,
    host: E2E_HOST,
    port,
    portSource: override === null ? "derived" : `env:${PORT_ENV_VAR}`,
    origin: `http://${E2E_HOST}:${port}`,
    reservedPort: RESERVED_PORT,
    derivedRange: [PORT_BASE, PORT_BASE + PORT_SPAN - 1],
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
      `\n  ${DIM}derived range ${r.derivedRange[0]}-${r.derivedRange[1]}; ${r.reservedPort} is reserved and never derived${RESET}`,
    );
    console.log(
      `  ${DIM}server reuse is never enabled: an occupied port fails loudly instead of being reused${RESET}`,
    );
    console.log(`\nSHARED across worktrees, NOT isolated by this module:`);
    for (const s of r.sharedNotIsolated) {
      console.log(`  • ${s.name} ${DIM}- ${s.detail}${RESET}`);
      console.log(`    ${DIM}${s.consequence}${RESET}`);
    }
    console.log("");
  }
}
