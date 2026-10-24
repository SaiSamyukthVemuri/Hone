import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClinicalNoteWithAuthor } from "@/lib/types/database";

// HON-44 (a), audit attribution: shared clinical notes and sessions show their
// ORIGINAL author. No author resolves to the honest "Unknown author", never to
// the viewer ("You"). Three cases, each through the real loader or component:
//   1. practitioner B views a note or session practitioner A wrote;
//   2. A has since been deactivated (still in the studio roster, inactive);
//   3. a legacy row whose author cannot be resolved.

const db = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
}));

// A PostgREST-shaped fake: every chain resolves to the table's rows, and each
// .eq() is recorded so a test can see whether a loader filtered on `active`.
function fakeClient() {
  return {
    from(table: string) {
      const result = () => ({ data: db.tables[table] ?? [], error: null, count: (db.tables[table] ?? []).length });
      const query: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: (db.tables[table] ?? [])[0] ?? null, error: null });
          }
          if (prop === "eq") {
            return (column: string, value: unknown) => { db.filters.push({ table, column, value }); return query; };
          }
          return () => query;
        },
      });
      return query;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { getClinicalNoteHistory } from "@/lib/clinical-notes/queries";
import { getClientById, sessionPerformerName } from "@/lib/supabase/queries";
import { ClinicalNotesSection } from "@/components/clinical-notes-section";
import { SessionTimeline } from "@/components/session-timeline";
import { SessionPerformerLine } from "@/components/session-performer-line";

const STUDIO = "studio-synthetic";
const CLIENT = "client-synthetic";
const AUTHOR_A = { id: "prac-a", display_name: "Avery Author", email: "a@studio.test", active: true };
const VIEWER_B = { id: "prac-b", display_name: "Blair Viewer", email: "b@studio.test", active: true };
const DEACTIVATED_C = { id: "prac-c", display_name: "Casey Former", email: "c@studio.test", active: false };

function note(id: string, practitionerId: string, authorName: string | null): ClinicalNoteWithAuthor {
  return {
    id, client_id: CLIENT, studio_id: STUDIO, practitioner_id: practitionerId,
    kind: "consultation" as const, body: `body of ${id}`, areas: [],
    occurred_at: "2026-10-20", supersedes_note_id: null,
    created_at: "2026-10-20T12:00:00Z", author_name: authorName, is_superseded: false,
  };
}

function renderNotes(notes: ClinicalNoteWithAuthor[]) {
  return renderToStaticMarkup(createElement(ClinicalNotesSection, {
    clientId: CLIENT,
    sections: [{ kind: "consultation", label: "Consultation notes", description: "d", placeholder: "p", notes, total: notes.length }],
    addAction: async () => ({ ok: false as const, code: "error" as const, error: "x" }),
    reviseAction: async () => ({ ok: false as const, code: "error" as const, error: "x" }),
  }));
}

function session(id: string, creator: string, performer: string | null) {
  return {
    id, studio_id: STUDIO, client_id: CLIENT, practitioner_id: creator,
    performed_by_practitioner_id: performer, modality: "electrolysis",
    started_at: "2026-10-20T15:00:00Z", price_paid_cents: null,
    electrolysis_entries: [], laser_entries: [],
  };
}

beforeEach(() => {
  db.tables = {};
  db.filters = [];
});

describe("clinical notes: original author, never the viewer", () => {
  it("B viewing A's note sees A's name, resolved by the real loader", async () => {
    db.tables.client_clinical_notes = [note("n1", AUTHOR_A.id, null)];
    db.tables.practitioners = [AUTHOR_A, VIEWER_B];
    const { notes } = await getClinicalNoteHistory(CLIENT, "consultation");
    expect(notes[0].author_name).toBe("Avery Author");
    const html = renderNotes(notes);
    expect(html).toContain("Avery Author");
    expect(html).not.toMatch(/>You</);
  });

  it("a deactivated author's note still shows that author's name", async () => {
    db.tables.client_clinical_notes = [note("n2", DEACTIVATED_C.id, null)];
    db.tables.practitioners = [DEACTIVATED_C, VIEWER_B];
    const { notes } = await getClinicalNoteHistory(CLIENT, "consultation");
    expect(notes[0].author_name).toBe("Casey Former");
    expect(db.filters.filter((f) => f.table === "practitioners" && f.column === "active")).toEqual([]);
    expect(renderNotes(notes)).toContain("Casey Former");
  });

  it("an author-less legacy note reads 'Unknown author', never 'You'", async () => {
    db.tables.client_clinical_notes = [note("n3", "prac-gone", null)];
    db.tables.practitioners = [VIEWER_B];
    const { notes } = await getClinicalNoteHistory(CLIENT, "consultation");
    expect(notes[0].author_name).toBeNull();
    const html = renderNotes(notes);
    expect(html).toContain("Unknown author");
    expect(html).not.toMatch(/>You</);
  });

  it("a blank display name is not an author either", () => {
    const html = renderNotes([note("n4", AUTHOR_A.id, "   ")]);
    expect(html).toContain("Unknown author");
  });
});

describe("clinical notes: a just-saved note carries the saver's own name", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const ACTIONS = readFileSync(path.join(ROOT, "app/(app)/clients/[id]/clinical-notes-actions.ts"), "utf8");
  const SECTION = readFileSync(path.join(ROOT, "components/clinical-notes-section.tsx"), "utf8");

  it("the action returns the signed-in practitioner's display name with the verified row", () => {
    expect(ACTIONS).toMatch(/return \{ ok: true, note: row, author_name: authorNameOf\(practitioner\) \};/);
  });
  it("the section merges that name instead of a null that rendered as 'You'", () => {
    expect(SECTION).toMatch(/onSaved\(result\.note, result\.author_name\)/);
    expect(SECTION).not.toMatch(/: "You"/);
  });
});

describe("sessions: original author and performer", () => {
  it("the client loader returns a full attribution roster, including deactivated members", async () => {
    db.tables.clients = [{ id: CLIENT, studio_id: STUDIO }];
    db.tables.client_pricing = [];
    db.tables.sessions = [];
    db.tables.practitioners = [AUTHOR_A, DEACTIVATED_C];
    const loaded = await getClientById(STUDIO, CLIENT);
    expect(loaded?.attributionRoster.map((p) => p.id).sort()).toEqual(["prac-a", "prac-c"]);
  });

  it("a deactivated performer is named from the attribution roster", () => {
    expect(sessionPerformerName(session("s1", DEACTIVATED_C.id, null), [AUTHOR_A, DEACTIVATED_C] as never)).toBe("Casey Former");
  });

  it("an unresolvable author is 'Unknown author', not omitted", () => {
    expect(sessionPerformerName(session("s2", "prac-gone", null), [AUTHOR_A] as never)).toBe("Unknown author");
  });

  it("the timeline names the original recorder when someone else performed it", () => {
    const html = renderToStaticMarkup(createElement(SessionTimeline, {
      clientId: CLIENT,
      sessions: [session("s3", AUTHOR_A.id, VIEWER_B.id)] as never,
      practitioners: [AUTHOR_A, VIEWER_B] as never,
    }));
    expect(html).toContain("Blair Viewer");
    expect(html).toContain("recorded by Avery Author");
  });

  it("the session page's performer line names a deactivated performer instead of 'not set'", () => {
    const html = renderToStaticMarkup(createElement(SessionPerformerLine, {
      sessionId: "s4",
      clientId: CLIENT,
      practitioners: [VIEWER_B] as never,
      initialPerformerId: DEACTIVATED_C.id,
      performerName: "Casey Former",
      updatePerformerAction: async () => {},
    } as never));
    expect(html).toContain("Casey Former");
    expect(html).not.toContain("not set");
  });
});
