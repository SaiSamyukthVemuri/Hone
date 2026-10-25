import { dbErrorCode } from "@/lib/logging/error-class";

// MSG-LOG-RAW-ERROR (F3). A server action that RETURNS a failure to the page
// must not put a database error's text in the result: a Postgres message can
// quote the value it rejected ("invalid input syntax for type uuid: \"<text>\""),
// names constraints, and is shown to the person and may be kept by the browser.
//
// This returns a fixed sentence for the CLASS of failure, chosen from the
// SQLSTATE alone, and logs only the closed code. `what` is a fixed phrase
// written at the call site ("add the stage"), never data.

export type DbFailureClass = "permission" | "busy" | "conflict" | "generic";

const BUSY = new Set(["40001", "40P01", "55P03", "57014"]);
const CONFLICT = new Set(["23502", "23503", "23505", "23514", "23P01"]);

export function classifyDbFailure(code: string): DbFailureClass {
  if (code === "42501") return "permission";
  if (BUSY.has(code)) return "busy";
  if (CONFLICT.has(code)) return "conflict";
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
    default:
      return `Could not ${what}. Try again, and contact support if it keeps happening.`;
  }
}
