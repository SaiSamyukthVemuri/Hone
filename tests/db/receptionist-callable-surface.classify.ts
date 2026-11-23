// Classifier for what a call returned to an actor who must be refused. Pure, with a unit check in tests/security. It returns a KIND, never a value.
// A denial counts as a refusal only when it has an explicit denial SHAPE: nothing in the payload may carry data besides the denial words.
export function isEmptyish(v: unknown): boolean {
  return v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v as object).length === 0);
}
export const STATUS_REFUSALS = new Set(["not_authorized", "owner_only", "forbidden", "not_found", "studio_not_found", "no_invitation", "refused"]);
const DENIAL_KEYS = new Set(["ok", "code", "status", "result", "error", "message", "choose_studio"]);
const isDenialWord = (v: unknown) => typeof v === "string" && v.length <= 64;
// ok:false JSON: only denial keys may be non-empty, and each must be a short word, not a record or list.
function isOkFalseDenial(o: Record<string, unknown>): boolean {
  return Object.entries(o).every(([k, v]) => (DENIAL_KEYS.has(k) ? v === false || v === null || isDenialWord(v) : isEmptyish(v)));
}
// status-word record: every value other than the status word itself must be empty (null, false, 0, empty).
function isStatusDenial(o: Record<string, unknown>, word: string): boolean {
  let seen = false;
  for (const v of Object.values(o)) {
    if (!seen && v === word) { seen = true; continue; }
    if (!isEmptyish(v)) return false;
  }
  return seen;
}
export function shapeOf(rows: { j?: unknown }[], isVoid: boolean): string {
  if (isVoid) return "void";
  if (rows.length === 0) return "empty";
  if (rows.length > 1) return "data";
  const v = rows[0].j;
  if (typeof v === "string") return STATUS_REFUSALS.has(v) ? `status:${v}` : v === "" ? "emptyish" : `status-other:${v}`;
  if (isEmptyish(v)) return v === null ? "null" : v === false ? "false" : "emptyish";
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.ok === false) return isOkFalseDenial(o) ? "json-ok-false" : "data";
    const first = typeof o.status === "string" ? o.status : typeof o.result === "string" ? o.result : Object.values(o).find((x) => typeof x === "string");
    if (typeof first === "string") {
      if (STATUS_REFUSALS.has(first)) return isStatusDenial(o, first) ? `status:${first}` : "data";
      if (isStatusDenial(o, first)) return `status-other:${first}`;
    }
    if (Object.values(o).every(isEmptyish)) return "record-all-empty";
  }
  return "data";
}
export const REFUSAL_KINDS = new Set(["empty", "null", "false", "emptyish", "void", "json-ok-false", "record-all-empty", ...[...STATUS_REFUSALS].map((x) => `status:${x}`)]);
export const refused = (o: { kind: string }) => o.kind.startsWith("error:") || REFUSAL_KINDS.has(o.kind);
