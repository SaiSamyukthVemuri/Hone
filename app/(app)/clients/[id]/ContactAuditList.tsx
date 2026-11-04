import { CONTACT_AUDIT_EMPTY, CONTACT_AUDIT_NOTE, describeContactAuditRow, type ContactAuditRow } from "@/lib/clients/contact-audit-view";

// Contact-change history for one client (R5, held 0290). Prepared, not wired: nothing renders it yet. Whoever wires it renders it only when
// the database returned rows to this user (RLS decides who may read); an empty list is shown identically for "none" and "not allowed".
export function ContactAuditList({ rows }: { rows: ContactAuditRow[] }) {
  const items = rows.map(describeContactAuditRow);
  return (
    <section aria-label="Contact change history" data-testid="contact-audit">
      <p className="text-sm text-muted-foreground">{CONTACT_AUDIT_NOTE}</p>
      {items.length === 0 ? (
        <p className="mt-2 text-sm" data-testid="contact-audit-empty">{CONTACT_AUDIT_EMPTY}</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {items.map((i) => (
            <li key={i.id} className="text-sm" data-testid="contact-audit-row">
              <span className="font-medium">{i.label}</span>: {i.from} → {i.to}
              <span className="text-muted-foreground"> · {i.who} · {new Date(i.at).toISOString().slice(0, 10)} UTC</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
