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

  it("each change is audited as client_archived / client_unarchived", () => {
    const src = read(ACTIONS);
    expect(src).toContain('action: "client_archived"');
    expect(src).toContain('action: "client_unarchived"');
  });

  it("the clients list has exactly two views, and an unknown ?view= is the active view", () => {
    const src = read("app/(app)/clients/page.tsx");
    expect(src).toContain('type View = "active" | "archived"');
    expect(src).toContain('return value === "archived" ? "archived" : "active"');
    expect(src).toContain("/clients?view=archived");
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

  it("next-visit behaviour: archive does not cancel upcoming appointments, and GAP, pinned: the reminder cron does not read archived_at", () => {
    const archive = read(ACTIONS);
    const body = archive.slice(archive.indexOf("export async function archiveClientAction"), archive.indexOf("export async function unarchiveClientAction"));
    expect(body).not.toMatch(/appointments/);
    expect(read("app/api/cron/appointment-reminders/route.ts")).not.toMatch(/archived/);
  });

  it("public booking and quick-book exclude archived clients", () => {
    expect(read("app/book/[slug]/actions.ts")).toContain('.is("archived_at", null)');
    expect(read("lib/supabase/queries.ts")).toContain("loadStudioClientDirectory");
  });
});
