import "server-only";
import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertE2eFakeStripeAllowed,
  isValidE2eRunId,
} from "@/lib/stripe/e2e-fake-guard";
import type { FakeStripeCall } from "@/lib/stripe/e2e-fake-stripe";

// Guarded, cross-process ledger for the fake Stripe processor. The in-memory
// recorder lives in the Next.js server process; the Playwright runner is a
// SEPARATE process and cannot read it. This module persists fake-call records
// and reads test-configured behaviour through run-id-keyed temp files so the two
// processes can coordinate — WITHOUT any browser-readable endpoint.
//
// Every read/write is gated by the fake-Stripe activation guard (fail-closed,
// Vercel-impossible). Paths are constructed ONLY from os.tmpdir() + the validated
// run id + a fixed prefix — never from user/browser input, so the browser cannot
// select behaviour or read the ledger, and no path can escape the temp dir.
//
// Stored fields are test-safe only (method / idempotency key / synthetic
// connected-account / amount / currency / synthetic result id / synthetic
// outcome). Never a name, email, card value, signature, key, note, or PHI.

const PREFIX = "hone-e2e-stripe-";

function assertAllowed(runId: string): void {
  // Fail-closed: never touch the filesystem unless fake mode is safely enabled.
  assertE2eFakeStripeAllowed(process.env);
  if (!isValidE2eRunId(runId)) throw new Error("Invalid E2E run id for ledger access.");
}

// Path built ONLY from tmpdir + validated run id + fixed suffix. isValidE2eRunId
// already restricts to [a-z0-9-]{8,64}, so no separator/traversal is possible.
function ledgerPath(runId: string): string {
  return join(tmpdir(), `${PREFIX}${runId}.jsonl`);
}
function configPath(runId: string): string {
  return join(tmpdir(), `${PREFIX}${runId}.config.json`);
}

export type FakeOutcome = "success" | "decline" | "processing";

// ----- Server-side (fake processor) API -----------------------------------------
// Append one call record (0o600). Bounded line; JSONL.
export function appendFakeCallToLedger(runId: string, call: FakeStripeCall): void {
  assertAllowed(runId);
  const line = JSON.stringify({ runId, ...call, at: undefined }).slice(0, 2000) + "\n";
  appendFileSync(ledgerPath(runId), line, { mode: 0o600 });
}

// The configured outcome for a selector (the attempt's idempotency key). Default
// success when no config / no entry. Read by the fake processor at charge time.
export function readFakeOutcome(runId: string, selector: string): FakeOutcome {
  try {
    assertAllowed(runId);
  } catch {
    return "success"; // guard off → the fake shouldn't even run; be inert
  }
  const p = configPath(runId);
  if (!existsSync(p)) return "success";
  try {
    const cfg = JSON.parse(readFileSync(p, "utf8")) as {
      default?: FakeOutcome;
      bySelector?: Record<string, FakeOutcome>;
    };
    return cfg.bySelector?.[selector] ?? cfg.default ?? "success";
  } catch {
    return "success";
  }
}

// ----- Test-runner API (Playwright process; NOT production) ----------------------
export function readFakeStripeCalls(runId: string): FakeStripeCall[] {
  assertAllowed(runId);
  const p = ledgerPath(runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FakeStripeCall);
}

// Atomic config write: write a temp file then rename into place.
export function setFakeStripeBehavior(
  runId: string,
  selector: string | null,
  outcome: FakeOutcome,
): void {
  assertAllowed(runId);
  const p = configPath(runId);
  let cfg: { default?: FakeOutcome; bySelector?: Record<string, FakeOutcome> } = {};
  if (existsSync(p)) {
    try {
      cfg = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      cfg = {};
    }
  }
  if (selector === null) {
    cfg.default = outcome;
  } else {
    cfg.bySelector = { ...(cfg.bySelector ?? {}), [selector]: outcome };
  }
  const tmp = `${p}.${Math.abs(hashRun(runId))}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 });
  renameSync(tmp, p);
}

export function clearFakeStripeBehavior(runId: string): void {
  assertAllowed(runId);
  const p = configPath(runId);
  if (existsSync(p)) rmSync(p, { force: true });
}

export function resetFakeStripeLedger(runId: string): void {
  assertAllowed(runId);
  const p = ledgerPath(runId);
  if (existsSync(p)) rmSync(p, { force: true });
}

export function cleanupFakeStripeFiles(runId: string): void {
  assertAllowed(runId);
  for (const p of [ledgerPath(runId), configPath(runId)]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
}

// Deterministic tmp-suffix seed from the (already validated) run id — no Math.random.
function hashRun(runId: string): number {
  let h = 0;
  for (let i = 0; i < runId.length; i++) h = (h * 31 + runId.charCodeAt(i)) | 0;
  return h;
}
