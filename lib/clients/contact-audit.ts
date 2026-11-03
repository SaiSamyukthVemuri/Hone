// Masked before/after values for the client.edit_contact audit (R5). The audit exists to show THAT a contact route changed and
// roughly where it now points, never to store the values: an email or phone in an audit row would re-create the exposure the
// audit guards. Masks keep just enough to recognise a wrong edit (first letter and domain suffix, last four digits).
// Prepared, not wired: the governed write that stores the rows is a database command (held migration 0290); until it exists
// client.edit_contact is NOT enforced, so no contact edit is gated and none is silently unaudited behind a permission.

export type ContactField = "email" | "phone" | "preferred_name";
export type MaskedContactChange = { field: ContactField; from: string; to: string };
export type ContactValues = { email: string | null; phone: string | null; preferred_name: string | null };

const BLANK = "(empty)";
const DOT = "•";

export function maskEmail(value: string | null): string {
  const v = (value ?? "").trim();
  if (!v) return BLANK;
  const at = v.lastIndexOf("@");
  if (at < 1) return `${v[0]}${DOT.repeat(3)}`;
  const domain = v.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${v[0]}${DOT.repeat(3)}@${domain[0] ?? ""}${DOT.repeat(3)}${tld}`;
}

export function maskPhone(value: string | null): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (!digits) return BLANK;
  return digits.length <= 4 ? DOT.repeat(4) : `${DOT.repeat(4)} ${digits.slice(-4)}`;
}

export function maskPreferredName(value: string | null): string {
  const chars = Array.from((value ?? "").trim());
  if (chars.length === 0) return BLANK;
  return `${chars[0]}${DOT.repeat(3)} (${chars.length})`;
}

const norm = (v: string | null) => (v ?? "").trim();

/** Only the fields that actually changed, each with masked old and new values. A formatting-only phone change still counts. */
export function describeContactChanges(before: ContactValues, after: ContactValues): MaskedContactChange[] {
  const out: MaskedContactChange[] = [];
  if (norm(before.email).toLowerCase() !== norm(after.email).toLowerCase()) out.push({ field: "email", from: maskEmail(before.email), to: maskEmail(after.email) });
  if (norm(before.phone) !== norm(after.phone)) out.push({ field: "phone", from: maskPhone(before.phone), to: maskPhone(after.phone) });
  if (norm(before.preferred_name) !== norm(after.preferred_name)) out.push({ field: "preferred_name", from: maskPreferredName(before.preferred_name), to: maskPreferredName(after.preferred_name) });
  return out;
}
