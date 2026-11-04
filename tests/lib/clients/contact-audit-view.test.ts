import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CONTACT_AUDIT_EMPTY, describeContactAuditRow, loadContactAudit, type ContactAuditRow } from "@/lib/clients/contact-audit-view";
import { ContactAuditList } from "@/app/(app)/clients/[id]/ContactAuditList";

const r = (over: Partial<ContactAuditRow> = {}): ContactAuditRow => ({ id: "1", field: "email", masked_from: "j•••@e•••.com", masked_to: "j•••@e•••.org", actor_kind: "practitioner", changed_at: "2026-11-04T10:00:00Z", actor_name: "Sam", ...over });

describe("contact audit view (R5, held 0290; prepared)", () => {
  it("words each row: field label, masked from and to, and who", () => {
    expect(describeContactAuditRow(r())).toMatchObject({ label: "Email", from: "j•••@e•••.com", to: "j•••@e•••.org", who: "Sam" });
    expect(describeContactAuditRow(r({ actor_kind: "system", actor_name: null })).who).toBe("No signed-in user (for example a server process, import or booking)");
    expect(describeContactAuditRow(r({ actor_kind: "unknown", actor_name: null })).who).toBe("Unknown");
    expect(describeContactAuditRow(r({ actor_name: null })).who).toBe("A team member");
    expect(describeContactAuditRow(r({ field: "preferred_name" })).label).toBe("Preferred name");
  });
  it("renders masked values only and states that full values are never kept", () => {
    const html = renderToStaticMarkup(createElement(ContactAuditList, { rows: [r(), r({ id: "2", field: "phone", masked_from: "•••• 0123", masked_to: "(empty)" })] }));
    expect(html).toContain("j•••@e•••.com");
    expect(html).toContain("•••• 0123");
    expect(html).toContain("(empty)");
    expect(html).toContain("Full old and new values are never kept in this history.");
    expect(html.match(/data-testid="contact-audit-row"/g)).toHaveLength(2);
  });
  it("an empty list reads the same whether there were no changes or the viewer may not see them", () => {
    const html = renderToStaticMarkup(createElement(ContactAuditList, { rows: [] }));
    expect(html).toContain(CONTACT_AUDIT_EMPTY);
    expect(html).not.toMatch(/permission|not allowed|restricted|hidden/i);
  });
  it("the loader reads only masked columns, scoped to the studio and client, newest first, capped", async () => {
    const calls: unknown[] = [];
    const chain = { select: (c: string) => (calls.push(["select", c]), chain), eq: (k: string, v: string) => (calls.push(["eq", k, v]), chain), order: (c: string, o: unknown) => (calls.push(["order", c, o]), chain), limit: (n: number) => (calls.push(["limit", n]), Promise.resolve({ data: [r()], error: null })) };
    const supabase = { from: vi.fn(() => chain) };
    const out = await loadContactAudit(supabase, "S", "C", 9999);
    expect(out).toEqual({ ok: true, rows: [r()] });
    expect(supabase.from).toHaveBeenCalledWith("client_contact_audit");
    expect(calls).toEqual([["select", "id, field, masked_from, masked_to, actor_kind, changed_at"], ["eq", "studio_id", "S"], ["eq", "client_id", "C"], ["order", "changed_at", { ascending: false }], ["limit", 200]]);
  });
  it("a read error is reported as unavailable, never as an empty history", async () => {
    const chain: Record<string, unknown> = {};
    for (const k of ["select", "eq", "order"]) chain[k] = () => chain;
    chain.limit = () => Promise.resolve({ data: null, error: { code: "42P01" } });
    expect(await loadContactAudit({ from: () => chain }, "S", "C")).toEqual({ ok: false });
  });
});
