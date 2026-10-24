import os from "node:os";
import path from "node:path";

// TWILIO-EGRESS-FAKE (MSG-006). The preload that keeps every browser lane away
// from the real Twilio API, and how a spec addresses it. Self-contained (no
// import from ./local-env) so local-env can compose it into the lane's
// NODE_OPTIONS without an import cycle. See e2e/helpers/twilio-egress-fake.cjs.

export const E2E_TWILIO_EGRESS_FAKE = path.join(__dirname, "twilio-egress-fake.cjs");

/**
 * Last four digits of a destination that select the fake's outcome for a
 * Messages.json POST. Any other number gets the DEFAULT: a refusal before the
 * connection opens (a definite, retryable non-send). Keep these in step with
 * the constants at the top of twilio-egress-fake.cjs; a unit test holds them.
 */
export const TWILIO_FAKE_AMBIGUOUS_503_LAST4 = "0153";
export const TWILIO_FAKE_ACCEPT_LAST4 = "0150";

/** The run log for one worktree and port, so two worktrees never mix records. */
export function twilioEgressLogPath(worktree: string, port: number | string): string {
  return path.join(os.tmpdir(), "hone-e2e-twilio-egress", `${path.basename(worktree)}-${port}.jsonl`);
}

/**
 * NODE_OPTIONS carrying the fake, COMPOSED with whatever is already there (the
 * Sentry guard, an operator's own options). Idempotent, and quoted only when
 * the path needs it (NODE_OPTIONS splits on spaces outside double quotes).
 *
 * `--import`, NOT a second `--require`. Next re-derives NODE_OPTIONS for its
 * build and render workers (next/dist/server/lib/utils
 * getFormattedNodeOptionsWithoutInspect), parsing it into ONE value per option
 * name: a second `--require` is merged into the first as a single path with a
 * space in it, and every worker then dies with MODULE_NOT_FOUND before any spec
 * runs (#1117 run 40140137937, every browser lane). The Sentry guard keeps the
 * `--require` slot; `--import` preloads this CommonJS file just as early on
 * Node 20 and 24, and survives Next's re-formatting as its own option.
 */
export function withTwilioEgressFake(existing: string | undefined): string {
  const current = (existing ?? "").trim();
  if (current.includes(E2E_TWILIO_EGRESS_FAKE)) return current;
  const target = /[\s"\\]/.test(E2E_TWILIO_EGRESS_FAKE)
    ? `"${E2E_TWILIO_EGRESS_FAKE.replace(/(["\\])/g, "\\$1")}"`
    : E2E_TWILIO_EGRESS_FAKE;
  return [current, `--import ${target}`].filter(Boolean).join(" ");
}
