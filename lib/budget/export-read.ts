import { isMissingRelationError } from "@/lib/supabase/missing-relation";
import { CLIENT_BUDGET_CONTEXT_RELATION } from "./levels";

// THE ONE DECISION the studio export makes about client_budget_context.
//
// It lives here, as a pure function, because the alternative — an inline
// condition buried in a 1200-line exporter — is exactly how "tolerate the
// migration window" quietly became "tolerate everything". The whole failure
// model is three lines and every branch is directly testable.
//
// Three outcomes, and the distinction between the last two is the point:
//
//   export             the read succeeded. Rows may be EMPTY; a studio that
//                      has recorded no budgets still gets a valid
//                      header-only CSV and a manifest count of 0. "Zero rows"
//                      is data, not an error.
//
//   omit_not_installed the ONE tolerated failure: the table does not exist,
//                      i.e. migration 0183 has not been applied (or has been
//                      rolled back). The rest of the export is unaffected and
//                      the manifest records the omission honestly. The file
//                      is omitted rather than written empty, because an empty
//                      file would falsely assert the studio holds no budget
//                      context.
//
//   fail               EVERYTHING else — permission, RLS, network, timeout, a
//                      failed later pagination page, or the paginator's own
//                      "refusing to return a partial table" refusal. A
//                      portability export that silently lacks known data is
//                      worse than one that fails, because the owner cannot
//                      tell it happened.

export type BudgetExportDecision =
  | { kind: "export"; rows: Array<Record<string, unknown>> }
  | { kind: "omit_not_installed" }
  | { kind: "fail"; message: string };

// The error is typed loosely on purpose: PostgREST errors carry `code`,
// `details` and `hint` alongside `message`, and the paginator's own refusal
// carries only `message`. Classification is delegated to
// isMissingRelationError rather than encoded in this signature.
export type BudgetExportReadResult = {
  data: Array<Record<string, unknown>> | null;
  error: ({ message?: unknown } & Record<string, unknown>) | null;
};

export function decideBudgetExportRead(
  res: BudgetExportReadResult,
): BudgetExportDecision {
  if (res.error) {
    if (isMissingRelationError(res.error, CLIENT_BUDGET_CONTEXT_RELATION)) {
      return { kind: "omit_not_installed" };
    }
    const message =
      typeof res.error.message === "string" && res.error.message.length > 0
        ? res.error.message
        : "unknown error";
    return { kind: "fail", message };
  }
  // A successful read with a null payload is not "no rows" — PostgREST returns
  // [] for that. Treat it as unreadable rather than silently exporting nothing.
  if (res.data === null) {
    return { kind: "fail", message: "budget context read returned no payload" };
  }
  return { kind: "export", rows: res.data };
}
