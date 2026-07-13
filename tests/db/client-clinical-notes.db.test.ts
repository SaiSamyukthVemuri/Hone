import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { randomUUID } from "node:crypto";

// Behavioural proof of migration 0126 (Willow PR A) — dedicated dated
// CONSULTATION notes + SKIN/HAIR ANALYSIS clinical records
// (public.client_clinical_notes) against the REAL migrated local database.
//
// Proves the DB-enforced contract that the static SQL test cannot: append-only
// (no in-place edit for ANY role), studio-derive anti-spoof, same-studio FKs,
// practitioner=author RLS, revision linkage + optimistic-concurrency conflict,
// cross-studio read/insert/supersede denial, and the CHECK constraints. RLS is
// exercised as the authenticated role with auth.uid() simulated, exactly as
// PostgREST presents a logged-in user.

let a: SeededStudio;
let b: SeededStudio;
let aMember: { userId: string; practitionerId: string };

const INS = `insert into public.client_clinical_notes
  (client_id, studio_id, practitioner_id, kind, body, areas, occurred_at, supersedes_note_id)
  values ($1, $2, $3, $4, $5, coalesce($6, '{}'::text[]), coalesce($7, now()), $8)
  returning id, studio_id, occurred_at, created_at`;

beforeAll(async () => {
  a = await seedStudio("ccn-a");
  b = await seedStudio("ccn-b");
  aMember = await seedMember(a, "ccn-a-member");
});

afterAll(async () => {
  await closePool();
});

describe("create + read (author, same studio)", () => {
  it("an active practitioner records a consultation note; studio member reads it", async () => {
    const id = await asUser(a.userId, async (q) => {
      const r = await q(INS, [
        a.clientId,
        a.studioId,
        a.practitionerId,
        "consultation",
        "Initial consult — goals discussed.",
        null,
        null,
        null,
      ]);
      expect(r.rowCount).toBe(1);
      expect(r.rows[0].studio_id).toBe(a.studioId);
      return r.rows[0].id as string;
    });
    // A second member of the same studio can read it (member SELECT policy).
    await asUser(aMember.userId, async (q) => {
      const r = await q(
        `select body, kind from public.client_clinical_notes where id = $1`,
        [id],
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows[0].kind).toBe("consultation");
    });
  });

  it("skin/hair analysis carries optional area tags", async () => {
    await asUser(a.userId, async (q) => {
      const r = await q(INS, [
        a.clientId,
        a.studioId,
        a.practitionerId,
        "skin_hair_analysis",
        "Coarse dark hair, Fitz III, chin + upper lip.",
        ["chin", "upper lip"],
        null,
        null,
      ]);
      expect(r.rowCount).toBe(1);
      const back = await q(
        `select areas from public.client_clinical_notes where id = $1`,
        [r.rows[0].id],
      );
      expect(back.rows[0].areas).toEqual(["chin", "upper lip"]);
    });
  });
});

describe("append-only (no in-place edit for any role)", () => {
  it("authenticated UPDATE is refused (privilege revoked)", async () => {
    const id = await seedNote(a, "consultation", "original body");
    await expect(
      asUser(a.userId, (q) =>
        q(`update public.client_clinical_notes set body = 'tampered' where id = $1`, [id]),
      ),
    ).rejects.toThrow();
    // Ground truth: unchanged.
    const g = await adminQuery(
      `select body from public.client_clinical_notes where id = $1`,
      [id],
    );
    expect(g.rows[0].body).toBe("original body");
  });

  it("even the bypassrls admin path cannot UPDATE (append-only trigger, no bypass)", async () => {
    const id = await seedNote(a, "consultation", "immutable body");
    await expect(
      adminQuery(`update public.client_clinical_notes set body = 'x' where id = $1`, [id]),
    ).rejects.toThrow(/append-only/i);
  });

  it("authenticated DELETE is refused (privilege revoked)", async () => {
    const id = await seedNote(a, "consultation", "keep me");
    await expect(
      asUser(a.userId, (q) =>
        q(`delete from public.client_clinical_notes where id = $1`, [id]),
      ),
    ).rejects.toThrow();
  });
});

describe("revisions + optimistic concurrency", () => {
  it("a revision inserts a new row, supersedes the original, and never mutates it", async () => {
    const originalId = await seedNote(a, "consultation", "v1 body");
    const revId = await asUser(a.userId, async (q) => {
      const r = await q(INS, [
        a.clientId,
        a.studioId,
        a.practitionerId,
        "consultation",
        "v2 body (corrected)",
        null,
        null,
        originalId,
      ]);
      return r.rows[0].id as string;
    });
    const rows = await adminQuery(
      `select id, body, supersedes_note_id from public.client_clinical_notes
       where id in ($1, $2) order by created_at`,
      [originalId, revId],
    );
    expect(rows.rowCount).toBe(2);
    const original = rows.rows.find((x) => x.id === originalId);
    const revision = rows.rows.find((x) => x.id === revId);
    expect(original.body).toBe("v1 body"); // untouched
    expect(revision.supersedes_note_id).toBe(originalId);
  });

  it("two concurrent revisions of the same note: the second is a stale-revision conflict (23505)", async () => {
    const originalId = await seedNote(a, "consultation", "contended v1");
    await asUser(a.userId, (q) =>
      q(INS, [a.clientId, a.studioId, a.practitionerId, "consultation", "winner", null, null, originalId]),
    );
    await expect(
      asUser(a.userId, (q) =>
        q(INS, [a.clientId, a.studioId, a.practitionerId, "consultation", "loser", null, null, originalId]),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a revision must match the superseded note's client + kind (trigger-enforced)", async () => {
    const consultId = await seedNote(a, "consultation", "a consult");
    await expect(
      asUser(a.userId, (q) =>
        q(INS, [
          a.clientId,
          a.studioId,
          a.practitionerId,
          "skin_hair_analysis", // wrong kind for this parent
          "mismatched kind",
          null,
          null,
          consultId,
        ]),
      ),
    ).rejects.toThrow(/same client, studio, and kind/i);
  });
});

describe("tenant isolation", () => {
  it("studio B cannot READ studio A's notes (member SELECT is studio-scoped)", async () => {
    const id = await seedNote(a, "consultation", "A private clinical note");
    await asUser(b.userId, async (q) => {
      const r = await q(
        `select id from public.client_clinical_notes where id = $1`,
        [id],
      );
      expect(r.rowCount).toBe(0); // RLS filtered, not a broken query
    });
  });

  it("studio B cannot INSERT a note against studio A's client", async () => {
    await expect(
      asUser(b.userId, (q) =>
        q(INS, [
          a.clientId, // A's client
          b.studioId,
          b.practitionerId,
          "consultation",
          "cross-tenant write attempt",
          null,
          null,
          null,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("the studio-derive trigger overrides a spoofed studio_id (anti-spoof, admin path)", async () => {
    // bypassrls admin path so ONLY the trigger + FKs act: pass B's studio for A's
    // client; the trigger must rewrite studio_id to A's.
    const r = await adminQuery(INS, [
      a.clientId,
      b.studioId, // spoofed
      a.practitionerId,
      "consultation",
      "anti-spoof",
      null,
      null,
      null,
    ]);
    expect(r.rows[0].studio_id).toBe(a.studioId);
  });

  it("a revision cannot supersede a note in another studio", async () => {
    const aNoteId = await seedNote(a, "consultation", "A note");
    await expect(
      asUser(b.userId, (q) =>
        q(INS, [
          b.clientId,
          b.studioId,
          b.practitionerId,
          "consultation",
          "cross-studio supersede",
          null,
          null,
          aNoteId, // A's note, invisible to B
        ]),
      ),
    ).rejects.toThrow();
  });
});

describe("attribution + validation", () => {
  it("a member cannot attribute a note to a DIFFERENT practitioner (author = caller)", async () => {
    await expect(
      asUser(aMember.userId, (q) =>
        q(INS, [
          a.clientId,
          a.studioId,
          a.practitionerId, // the owner, not the caller
          "consultation",
          "spoofed attribution",
          null,
          null,
          null,
        ]),
      ),
    ).rejects.toThrow();
  });

  it("blank body is rejected by CHECK", async () => {
    await expect(
      asUser(a.userId, (q) =>
        q(INS, [a.clientId, a.studioId, a.practitionerId, "consultation", "   ", null, null, null]),
      ),
    ).rejects.toThrow();
  });

  it("an unknown kind is rejected by CHECK", async () => {
    await expect(
      asUser(a.userId, (q) =>
        q(INS, [a.clientId, a.studioId, a.practitionerId, "diagnosis", "x", null, null, null]),
      ),
    ).rejects.toThrow();
  });

  it("a non-existent supersedes_note_id is rejected", async () => {
    await expect(
      asUser(a.userId, (q) =>
        q(INS, [a.clientId, a.studioId, a.practitionerId, "consultation", "x", null, null, randomUUID()]),
      ),
    ).rejects.toThrow();
  });
});

describe("dated history", () => {
  it("preserves multiple dated entries per kind, newest occurred_at first", async () => {
    const client = randomUUID();
    await adminQuery(
      `insert into public.clients (id, studio_id, name) values ($1, $2, 'History Client')`,
      [client, a.studioId],
    );
    await asUser(a.userId, async (q) => {
      await q(INS, [client, a.studioId, a.practitionerId, "consultation", "older", null, "2026-01-01", null]);
      await q(INS, [client, a.studioId, a.practitionerId, "consultation", "newer", null, "2026-06-01", null]);
    });
    const r = await adminQuery(
      `select body from public.client_clinical_notes
       where client_id = $1 and kind = 'consultation'
       order by occurred_at desc, created_at desc`,
      [client],
    );
    expect(r.rows.map((x) => x.body)).toEqual(["newer", "older"]);
  });
});

// Migration 0127: the author-INSERT policy now enforces the same-studio
// practitioner boundary at the RLS layer (0126 had a shadowed `studio_id` that
// degraded to a tautology, leaving only the composite FK enforcing it). RLS
// WITH CHECK is evaluated BEFORE the FK's AFTER-trigger, so a rejection with a
// "row-level security" message proves the POLICY (not merely the FK) enforces
// the boundary.
describe("0127 — author-INSERT policy enforces same-studio at the RLS layer", () => {
  it("positive control: a same-studio ACTIVE practitioner (the caller) can insert", async () => {
    await asUser(a.userId, async (q) => {
      const r = await q(INS, [
        a.clientId,
        a.studioId,
        a.practitionerId,
        "consultation",
        "policy positive control",
        null,
        null,
        null,
      ]);
      expect(r.rowCount).toBe(1);
    });
  });

  it("an INACTIVE practitioner cannot insert", async () => {
    // is_studio_member() (used by both the clients RLS and this policy) excludes
    // inactive practitioners, so an inactive-only caller cannot even resolve the
    // parent client: the studio-derive trigger rejects first ("does not reference
    // a visible clients row"). The policy's `p.active` clause is the second guard
    // (a user has at most one practitioner per studio, so it cannot be isolated
    // via the authenticated path). Either way, an inactive practitioner is refused.
    const userId = randomUUID();
    const pracId = randomUUID();
    const email = `ccn-inactive-${userId.slice(0, 8)}@harness.local`;
    await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [userId, email]);
    await adminQuery(
      `insert into public.practitioners
         (id, studio_id, user_id, display_name, email, role, active)
       values ($1,$2,$3,'Inactive',$4,'practitioner',false)`,
      [pracId, a.studioId, userId, email],
    );
    await expect(
      asUser(userId, (q) =>
        q(INS, [a.clientId, a.studioId, pracId, "consultation", "inactive attempt", null, null, null]),
      ),
    ).rejects.toThrow();
  });

  it("a multi-studio caller cannot attribute a note to their OTHER studio's practitioner — rejected by RLS, before the FK", async () => {
    // One auth user, an ACTIVE practitioner in BOTH studio A and studio B
    // (unique key is (studio_id, user_id), so this is reachable).
    const userId = randomUUID();
    const pracA = randomUUID();
    const pracB = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [
      userId,
      `ccn-multi-${userId.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       values ($1,$2,$3,'Multi A',$4,'practitioner',true)`,
      [pracA, a.studioId, userId, `ccn-multi-a-${userId.slice(0, 8)}@harness.local`],
    );
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       values ($1,$2,$3,'Multi B',$4,'practitioner',true)`,
      [pracB, b.studioId, userId, `ccn-multi-b-${userId.slice(0, 8)}@harness.local`],
    );
    // Note for A's client (studio derived to A), attributed to the caller's
    // studio-B practitioner. is_studio_member(A) passes (caller is in A), but the
    // practitioner clause p.studio_id = client_clinical_notes.studio_id now fails
    // at the RLS layer — no cross-studio attribution.
    await expect(
      asUser(userId, (q) =>
        q(INS, [a.clientId, a.studioId, pracB, "consultation", "cross-studio practitioner", null, null, null]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("SELECT isolation is unchanged: studio B still cannot read studio A's notes", async () => {
    const id = await seedNote(a, "consultation", "post-0127 isolation check");
    await asUser(b.userId, async (q) => {
      const r = await q(`select id from public.client_clinical_notes where id = $1`, [id]);
      expect(r.rowCount).toBe(0);
    });
  });
});

// Seed a note through the authenticated author path and return its id.
async function seedNote(
  studio: SeededStudio,
  kind: string,
  body: string,
): Promise<string> {
  return asUser(studio.userId, async (q) => {
    const r = await q(INS, [
      studio.clientId,
      studio.studioId,
      studio.practitionerId,
      kind,
      body,
      null,
      null,
      null,
    ]);
    return r.rows[0].id as string;
  });
}
