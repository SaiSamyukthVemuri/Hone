import { dbErrorCode } from "@/lib/logging/error-class";

// MSG-LOG-RAW-ERROR (F3). A server action that RETURNS a failure to the page
// must not put a database error's text in the result: a Postgres message can
// quote the value it rejected ("invalid input syntax for type uuid: \"<text>\""),
// names constraints, and is shown to the person and may be kept by the browser.
//
// This returns a fixed sentence for the CLASS of failure, chosen from the
// SQLSTATE alone, and logs only the closed code. `what` is a fixed phrase
// written at the call site ("add the stage"), never data.

export type DbFailureClass = "permission" | "busy" | "conflict" | "invalid" | "generic";

const BUSY = new Set(["40001", "40P01", "55P03", "57014"]);
// The change collides with something that already exists (a duplicate, a
// referenced or referencing row, an exclusion overlap).
const CONFLICT = new Set(["23503", "23505", "23P01"]);
// The values themselves were refused (a missing required value, a failed CHECK):
// not a collision with other records, so the sentence says to check the values.
const INVALID = new Set(["23502", "23514"]);

export function classifyDbFailure(code: string): DbFailureClass {
  if (code === "42501") return "permission";
  if (BUSY.has(code)) return "busy";
  if (CONFLICT.has(code)) return "conflict";
  if (INVALID.has(code)) return "invalid";
  return "generic";
}

export function userFacingDbFailure(what: string, error: unknown, event: string): string {
  const code = dbErrorCode(error);
  console.error(JSON.stringify({ event, code, timestamp: new Date().toISOString() }));
  switch (classifyDbFailure(code)) {
    case "permission":
      return `You do not have permission to ${what}.`;
    case "busy":
      return `Could not ${what} because the record is busy. Try again.`;
    case "conflict":
      return `Could not ${what} because the change conflicts with existing records.`;
    case "invalid":
      return `Could not ${what} because a value could not be accepted. Check the values and try again.`;
    default:
      return `Could not ${what}. Try again, and contact support if it keeps happening.`;
  }
}
