import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ===========================================================================
// Playwright-side view of the guarded cross-process fake-Stripe ledger.
// ===========================================================================
//
// The Next.js server writes the fake ledger through the SERVER-ONLY, guarded
// module lib/stripe/e2e-fake-ledger.ts. The Playwright runner is a SEPARATE
// process and CANNOT import that module (it is `import "server-only"` and uses
// the `@/` build alias). So this test-runner helper reads / writes the SAME
// run-scoped temp files directly — the file format is the cross-process
// contract, and the temp file is the only thing the two processes share.
//
// Safety properties (mirrors the server module, pinned by the security specs):
//   * The path is built ONLY from os.tmpdir() + a fixed prefix + the validated
//     run id — never from browser input, a request value, or a user path — so
//     it cannot escape the temp dir and the browser can never read or steer it.
//   * The run id must pass the SAME regex the server guard enforces; a missing
//     or malformed run id throws loudly rather than touching a guessed path.
//   * Only test-safe fields are ever read/written (method / idempotency key /
//     synthetic connected-account / amount / currency / synthetic result id /
//     synthetic outcome). No PHI, card value, signature, secret, or email.
//   * This module is TEST-ONLY. It must never be imported by production
//     application code (enforced by tests/dependencies).

const PREFIX = "hone-e2e-stripe-";

// The same shape lib/stripe/e2e-fake-stripe.ts records. Kept in sync with the
// server FakeStripeCall by the ledger append format; extra fields are ignored.
export type FakeStripeCall = {
  runId?: string;
  method: "pi_create" | "pi_retrieve" | "pi_cancel" | "refund_create";
  idempotencyKey: string | null;
  stripeAccount: string | null;
  amountCents: number | null;
  currency: string | null;
  resultId: string;
  // INVOCATION vs EFFECT: every adapter call is recorded (an invocation);
  // replay=false marks the calls that created a NEW processor result for a
  // previously-unseen idempotency key (an effect). See lib/stripe/e2e-fake-stripe.
  replay: boolean;
};

export type FakeOutcome = "success" | "decline" | "processing";

// Same validation the server guard applies (lib/stripe/e2e-fake-guard.ts). A
// run id that fails this must never be turned into a filesystem path.
function assertValidRunId(runId: string): string {
  if (typeof runId !== "string" || !/^[a-z0-9][a-z0-9-]{7,63}$/i.test(runId)) {
    throw new Error(
      `fake-stripe-ledger-e2e: invalid HONE_E2E_RUN_ID (${JSON.stringify(runId)}).`,
    );
  }
  return runId;
}

// Resolve the active run id from the environment (set once per job for the
// Next server + the Playwright runner) unless a caller passes one explicitly.
export function activeRunId(): string {
  return assertValidRunId(process.env.HONE_E2E_RUN_ID ?? "");
}

function ledgerPath(runId: string): string {
  return join(tmpdir(), `${PREFIX}${assertValidRunId(runId)}.jsonl`);
}
function configPath(runId: string): string {
  return join(tmpdir(), `${PREFIX}${assertValidRunId(runId)}.config.json`);
}

// ----- Ledger reads (the server appends; the runner reads) ----------------------
// Strict: a malformed line fails loudly rather than being silently dropped, so a
// corrupt ledger can never masquerade as "zero calls".
export function readFakeStripeCalls(runId: string = activeRunId()): FakeStripeCall[] {
  const p = ledgerPath(runId);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.map((l, i) => {
    try {
      return JSON.parse(l) as FakeStripeCall;
    } catch {
      throw new Error(
        `fake-stripe-ledger-e2e: malformed ledger line ${i + 1} for run ${runId}.`,
      );
    }
  });
}

export function countFakeStripeCalls(
  method: FakeStripeCall["method"],
  runId: string = activeRunId(),
): number {
  return readFakeStripeCalls(runId).filter((c) => c.method === method).length;
}

// INVOCATIONS = every fake paymentIntents.create call (including replays). This
// count MUST reflect duplicate app-level server calls even when the idempotency
// key was already seen — the fake can never hide a second invocation.
export function readFakeStripeInvocations(
  runId: string = activeRunId(),
): FakeStripeCall[] {
  return readFakeStripeCalls(runId).filter((c) => c.method === "pi_create");
}

// EFFECTS = only the creates that produced a NEW synthetic PaymentIntent for a
// previously-unseen idempotency key (replay=false) = unique processor charges.
export function readFakeStripeEffects(
  runId: string = activeRunId(),
): FakeStripeCall[] {
  return readFakeStripeCalls(runId).filter(
    (c) => c.method === "pi_create" && c.replay === false,
  );
}

export function countFakeStripeInvocations(runId: string = activeRunId()): number {
  return readFakeStripeInvocations(runId).length;
}
export function countFakeStripeEffects(runId: string = activeRunId()): number {
  return readFakeStripeEffects(runId).length;
}

// ----- Behaviour config (the runner writes; the server reads) --------------------
// Atomic: write a temp file then rename into place, so the server never reads a
// half-written config. selector === null sets the default outcome.
export function configureFakeStripeOutcome(
  selector: string | null,
  outcome: FakeOutcome,
  runId: string = activeRunId(),
): void {
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
  const tmp = `${p}.e2e.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 });
  renameSync(tmp, p);
}

export function clearFakeStripeOutcome(runId: string = activeRunId()): void {
  const p = configPath(runId);
  if (existsSync(p)) rmSync(p, { force: true });
}

// ----- Lifecycle ----------------------------------------------------------------
export function resetFakeStripeLedger(runId: string = activeRunId()): void {
  const p = ledgerPath(runId);
  if (existsSync(p)) rmSync(p, { force: true });
}

export function cleanupFakeStripeLedger(runId: string = activeRunId()): void {
  for (const p of [ledgerPath(runId), configPath(runId)]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
}
