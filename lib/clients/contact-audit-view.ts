// Display side of the contact-change audit (R5, held 0290). Prepared, not wired. The database stores MASKED strings only and decides who may
// read them (can_read_client_contact_audit); this module only reads what RLS returns and words it. An empty result is ambiguous BY DESIGN:
// it means "no changes recorded" OR "you may not see them", and the screen must not say which.

export type ContactAuditRow = {
  id: string;
  field: "email" | "phone" | "preferred_name";
  masked_from: string;
  masked_to: string;
  actor_kind: "practitioner" | "system" | "unknown";
  changed_at: string;
  actor_name?: string | null;
};

export const CONTACT_FIELD_LABEL: Record<ContactAuditRow["field"], string> = {
  email: "Email",
  phone: "Phone",
  preferred_name: "Preferred name",
};

export const CONTACT_AUDIT_NOTE = "Shows that a contact detail changed and roughly where it now points. Full old and new values are never kept in this history.";
export const CONTACT_AUDIT_EMPTY = "No contact changes to show.";

export function describeContactAuditRow(r: ContactAuditRow) {
  const who = r.actor_kind === "practitioner" ? (r.actor_name?.trim() || "A team member") : r.actor_kind === "system" ? "Hone (automatic)" : "Unknown";
  return { id: r.id, label: CONTACT_FIELD_LABEL[r.field], from: r.masked_from, to: r.masked_to, who, at: r.changed_at };
}

type Reader = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (k: string, v: string) => { eq: (k: string, v: string) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }> } } };
    };
  };
};

/** Newest first, capped. Never selects an unmasked column: the table has none. A read error is reported as unavailable, never as "empty". */
export async function loadContactAudit(
  supabase: unknown,
  studioId: string,
  clientId: string,
  limit = 50,
): Promise<{ ok: true; rows: ContactAuditRow[] } | { ok: false }> {
  const { data, error } = await (supabase as Reader)
    .from("client_contact_audit")
    .select("id, field, masked_from, masked_to, actor_kind, changed_at")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("changed_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) return { ok: false };
  return { ok: true, rows: (data ?? []) as ContactAuditRow[] };
}
