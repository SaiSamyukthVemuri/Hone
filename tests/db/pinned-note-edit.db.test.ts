import { afterAll, afterEach, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioB,
  type SynthStudio,
} from "./helpers/synth-fleet";
import { randomUUID } from "node:crypto";

// Editing a mutable pinned note (client_pinned_notes) — behavioral proof of the
// server action's scoped in-place UPDATE: `set text where id + studio_id +
// client_id`. The studio_id in the scope is the AUTHED studio (session-derived in
// the action), so a foreign-studio/foreign-client/stale note matches zero rows.

let A: SynthStudio | undefined;
let B: SynthStudio | undefined;

async function seedNote(
  studioId: string,
  clientId: string,
  practitionerId: string,
  text: string,
): Promise<string> {
  const r = await adminQuery(
    `insert into public.client_pinned_notes
       (id, client_id, studio_id, text, created_by_practitioner_id)
     values ($1,$2,$3,$4,$5) returning id`,
    [randomUUID(), clientId, studioId, text, practitionerId],
  );
  return r.rows[0].id as string;
}

// Exactly the action's scoped, optimistic-concurrency update: only lands if the
// row still holds `originalText` (plus the id + studio + client scope).
const scopedEdit = (
  noteId: string,
  studioId: string,
  clientId: string,
  originalText: string,
  newText: string,
) =>
  adminQuery(
    `update public.client_pinned_notes set text=$5
      where id=$1 and studio_id=$2 and client_id=$3 and text=$4 returning id`,
    [noteId, studioId, clientId, originalText, newText],
  );

afterEach(async () => {
  for (const s of [A, B]) {
    if (!s) continue;
    await adminQuery(`delete from public.client_pinned_notes where studio_id=$1`, [s.studioId]);
    await dropSynthStudio(s);
  }
  A = B = undefined;
});
afterAll(async () => {
  await closePool();
});

describe("client_pinned_notes edit — scoped in-place update", () => {
  it("edits text in place: same id, still pinned, creator/created_at/scope unchanged, no duplicate", async () => {
    A = await seedSynthStudioB();
    const prac = A.practitioners[0].practitionerId;
    const noteId = await seedNote(A.studioId, A.clientId, prac, "original");
    const before = (
      await adminQuery(
        `select id, client_id, studio_id, created_by_practitioner_id, created_at
           from public.client_pinned_notes where id=$1`,
        [noteId],
      )
    ).rows[0];

    const upd = await scopedEdit(noteId, A.studioId, A.clientId, "original", "edited text");
    expect(upd.rowCount).toBe(1);

    const after = (
      await adminQuery(`select * from public.client_pinned_notes where id=$1`, [noteId])
    ).rows;
    expect(after).toHaveLength(1); // row preserved → still pinned
    expect(after[0].text).toBe("edited text"); // text changed
    expect(after[0].id).toBe(noteId); // id unchanged
    expect(after[0].client_id).toBe(before.client_id);
    expect(after[0].studio_id).toBe(before.studio_id);
    expect(after[0].created_by_practitioner_id).toBe(before.created_by_practitioner_id);
    expect(new Date(after[0].created_at).getTime()).toBe(
      new Date(before.created_at).getTime(),
    );

    const count = await adminQuery(
      `select count(*)::int n from public.client_pinned_notes where client_id=$1`,
      [A.clientId],
    );
    expect(count.rows[0].n).toBe(1); // no duplicate created
  });

  it("foreign-studio scope: an update carrying a different studio_id matches ZERO rows (denied)", async () => {
    A = await seedSynthStudioB();
    B = await seedSynthStudioB();
    const noteId = await seedNote(
      A.studioId,
      A.clientId,
      A.practitioners[0].practitionerId,
      "A's note",
    );
    // Studio B actor: the action scopes by the AUTHED studio (B), so A's note is invisible.
    const upd = await scopedEdit(noteId, B.studioId, A.clientId, "A's note", "hijacked");
    expect(upd.rowCount).toBe(0);
    const after = await adminQuery(
      `select text from public.client_pinned_notes where id=$1`,
      [noteId],
    );
    expect(after.rows[0].text).toBe("A's note"); // untouched
  });

  it("optimistic concurrency: a save whose original_text no longer matches (another practitioner edited first) matches ZERO rows", async () => {
    A = await seedSynthStudioB();
    const prac = A.practitioners[0].practitionerId;
    const noteId = await seedNote(A.studioId, A.clientId, prac, "original");

    // Practitioner B saves first: "original" -> "newer".
    const b = await scopedEdit(noteId, A.studioId, A.clientId, "original", "newer");
    expect(b.rowCount).toBe(1);

    // Practitioner A (who opened "original") saves late with original_text="original".
    const aLate = await scopedEdit(noteId, A.studioId, A.clientId, "original", "A's late save");
    expect(aLate.rowCount).toBe(0); // stale → nothing updated

    const after = await adminQuery(
      `select text from public.client_pinned_notes where id=$1`,
      [noteId],
    );
    expect(after.rows[0].text).toBe("newer"); // B's save is NOT silently overwritten
  });

  it("stale/deleted note: the scoped update matches zero rows", async () => {
    A = await seedSynthStudioB();
    const noteId = await seedNote(
      A.studioId,
      A.clientId,
      A.practitioners[0].practitionerId,
      "temp",
    );
    await adminQuery(`delete from public.client_pinned_notes where id=$1`, [noteId]);
    const upd = await scopedEdit(noteId, A.studioId, A.clientId, "temp", "x");
    expect(upd.rowCount).toBe(0);
  });
});
