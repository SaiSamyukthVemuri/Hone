import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// HON-14 (CLIENT-STATUS-01), baseline. A SOURCE CONTRACT that pins what the
// client lifecycle is TODAY, so a Paused/Completed design is measured against
// facts and a later change shows exactly what it moved. It changes no behaviour.
// Where a line pins a gap rather than a virtue, the comment says so.

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const ACTIONS = "app/(app)/clients/[id]/actions.ts";

describe("HON-14 current client lifecycle", () => {
  it("the only persisted lifecycle state is archived_at/archived_by: no migration adds a status column to clients", () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    const hits: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
      const sql = read(`supabase/migrations/${f}`).replace(/--.*$/gm, "");
      const alters = sql.match(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?clients\b[^;]*;/gi) ?? [];
      for (const a of alters) {
        if (/add\s+column[^;]*\b(status|lifecycle\w*|paused\w*|completed\w*|inactive\w*)\b/i.test(a)) hits.push(f);
      }
    }
    expect(hits).toEqual([]);
  });

  it("archive and unarchive are conditional, studio-scoped updates that write archived_at and archived_by", () => {
    const src = read(ACTIONS);
    expect(src).toMatch(/archived_at: nowIso,\s*archived_by: practitioner\.id/);
    expect(src).toMatch(/archived_at: null,\s*archived_by: null/);
    expect(src).toContain('.is("archived_at", null)');
    expect(src).toContain('.not("archived_at", "is", null)');
    expect(src.match(/\.eq\("studio_id", studio\.id\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("GAP, pinned: archive and unarchive check the studio, not the role (any active member can do either)", () => {
    const src = read(ACTIONS);
    const archive = src.slice(src.indexOf("export async function archiveClientAction"), src.indexOf("export async function unarchiveClientAction"));
    expect(archive).toContain("assertClientVisible(studio.id, clientId)");
    expect(archive).not.toMatch(/role\s*(!==|===)\s*"owner"/);
    expect(archive).not.toMatch(/isOwner/);
  });

  it("each change is audited through the governed writer, once per change, with the change named", () => {
    const src = read(ACTIONS);
    // Direct audit_logs inserts are revoked for user roles (0242); the app calls
    // the governed command, which writes client_archived / client_unarchived.
    expect(src).toContain('import { recordClientArchiveAudit } from "@/lib/audit/governed-writes"');
    expect(src).toMatch(/recordClientArchiveAudit\(\{\s*expectedStudioId: studio\.id, clientId, change: "archive"/);
    expect(src).toMatch(/recordClientArchiveAudit\(\{\s*expectedStudioId: studio\.id, clientId, change: "unarchive"/);
    expect(src.match(/recordClientArchiveAudit\(\{/g)?.length).toBe(2);
    const governed = read("lib/audit/governed-writes.ts");
    expect(governed).toContain('"record_client_archive_audit_governed"');
  });

  it("the clients list has exactly two views, and an unknown ?view= is the active view", () => {
    // Moved by the list-view slice: the decision now lives in lib/clients/list-view.ts
    // (tests/lib/clients/list-view.test.ts pins its behaviour); the page only uses it.
    const mod = read("lib/clients/list-view.ts");
    expect(mod).toContain('export type ClientListView = "active" | "archived"');
    expect(mod).toContain('return value === "archived" ? "archived" : "active"');
    expect(mod).toContain("/clients?view=${view}");
    expect(read("app/(app)/clients/page.tsx")).toContain("parseClientListView(params.view)");
  });

  it("the directory reads split on archived_at only (active = null, archived = not null)", () => {
    const q = read("lib/supabase/queries.ts");
    expect(q).toContain("loadStudioClientDirectory(studioId, false)");
    expect(q).toContain("loadStudioClientDirectory(studioId, true)");
  });

  it("an archived client's detail page still resolves (history stays reachable); the portal and portal rebook refuse it", () => {
    expect(read(ACTIONS)).toContain("The detail page");
    expect(read("lib/portal/queries.ts")).toMatch(/clientRow\.archived_at != null\) return null/);
    expect(read("app/portal/rebook-actions.ts")).toMatch(/clientRow\.archived_at != null/);
    expect(read("app/portal/verify/[token]/actions.ts")).toMatch(/clientRow\.archived_at != null/);
  });

  it("next-visit behaviour: archive does not cancel upcoming appointments, and the reminder cron excludes archived clients (MSG-ARCH-01, #1185)", () => {
    const archive = read(ACTIONS);
    const body = archive.slice(archive.indexOf("export async function archiveClientAction"), archive.indexOf("export async function unarchiveClientAction"));
    expect(body).not.toMatch(/appointments/);
    const cron = read("app/api/cron/appointment-reminders/route.ts");
    // Selection skips an archived client on the email and the SMS path, and the
    // send re-reads archived_at after the claim, so an archive between discovery
    // and send also holds. An unavailable read is not evidence of "not archived".
    expect(cron.match(/if \(appt\.client\.archived_at\) return;/g)?.length).toBe(2);
    expect(cron).toContain('.select("archived_at")');
    expect(cron).toMatch(/if \(liveClient\?\.archived_at\) \{/);
  });

  it("public booking and quick-book exclude archived clients", () => {
    expect(read("app/book/[slug]/actions.ts")).toContain('.is("archived_at", null)');
    expect(read("lib/supabase/queries.ts")).toContain("loadStudioClientDirectory");
  });
});
