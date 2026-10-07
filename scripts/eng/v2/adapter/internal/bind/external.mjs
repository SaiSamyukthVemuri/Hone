// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A, row 6: EXT-CONTEXT-01's closed external-check normalization.
// Pure. Every accepted GitHub value is listed; there is no default branch and
// no rule of the form "not X".
//
//   * every StatusContext is external;
//   * a CheckRun is GitHub Actions iff its app slug is "github-actions", and
//     Actions check runs are excluded whatever their state (CI authority is
//     CI-ATTEST-01's — in V1, the row-3 CI model's);
//   * a CheckRun whose check suite has no app cannot be classified: malformed;
//   * any other value outside the tables: unrecognized_context_state;
//   * malformed wins, so the reason never depends on the contexts' order.
// ---------------------------------------------------------------------------

import { fail, okValue } from "../../../contract/strict.mjs";

const ACTIONS = "github-actions";

const STATUS_CONTEXT = Object.freeze({
  SUCCESS: "success",
  PENDING: "pending",
  EXPECTED: "pending",
  ERROR: "failure",
  FAILURE: "failure",
});
const CHECK_PENDING = Object.freeze(["REQUESTED", "QUEUED", "IN_PROGRESS", "WAITING", "PENDING"]);
const CHECK_COMPLETED = "COMPLETED";
const CONCLUSION = Object.freeze({
  SUCCESS: "success",
  NEUTRAL: "success",
  SKIPPED: "success",
  FAILURE: "failure",
  CANCELLED: "failure",
  TIMED_OUT: "failure",
  ACTION_REQUIRED: "failure",
  STARTUP_FAILURE: "failure",
  STALE: "failure",
});

const lookup = (table, value) => (typeof value === "string" && Object.hasOwn(table, value) ? table[value] : null);

export function bindExternal(record) {
  try {
    let malformed = false;
    let unrecognized = false;
    const external = [];
    for (const c of record.contexts) {
      if (c.kind === "StatusContext") {
        const state = lookup(STATUS_CONTEXT, c.state);
        if (state === null) unrecognized = true;
        else external.push({ source: c.context, state });
      } else if (c.kind === "CheckRun") {
        if (c.appSlug === null) {
          malformed = true;
          continue;
        }
        if (c.appSlug === ACTIONS) continue;
        if (CHECK_PENDING.includes(c.status)) external.push({ source: c.name, state: "pending" });
        else if (c.status === CHECK_COMPLETED) {
          const state = lookup(CONCLUSION, c.conclusion);
          if (state === null) unrecognized = true;
          else external.push({ source: c.name, state });
        } else unrecognized = true;
      } else malformed = true;
    }
    if (malformed) return fail("malformed", "an external context could not be classified");
    if (unrecognized) return fail("unrecognized_context_state", "an external context value is outside the closed tables");
    return okValue({ external });
  } catch {
    return fail("malformed", "bindExternal received an input outside its contract");
  }
}
