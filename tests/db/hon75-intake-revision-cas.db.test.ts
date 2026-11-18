import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, adminTx, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// HON-75 G1: the intake revision compare-and-swap (0243 write_intake_revision), proven THROUGH THE FUNCTION on the real chain with synthetic placeholder
// answers. Two-tab stale saves, a late save after submit and after review, a repeat submit, wrong-scope ids, and that every refusal leaves the stored row
// byte-identical. Each test is a reproduction attempt; a failure here is a REPRODUCED defect to report before any product change.
afterAll(async () => {
  await closePool();
});

type Outcome = { outcome: string; new_revision: string | null };
const write = async (studioId: string, clientId: string, intakeId: string, expected: number | string | null, responses: object, op: "save" | "submit" | "handoff" = "save", step = 2): Promise<Outcome> =>
  adminTx(async (q) => {
    await q("set local role service_role");
    const r = await q(`select * from public.write_intake_revision($1, $2, $3, $4, $5::jsonb, $6, $7)`, [intakeId, studioId, clientId, expected, JSON.stringify(responses), step, op]);
    await q("reset role");
    return r.rows[0] as Outcome;
  });
const rowOf = async (id: string) =>
  (await adminQuery(`select to_jsonb(f) - 'updated_at' as r from public.client_intake_forms f where id = $1`, [id])).rows[0].r as Record<string, unknown>;
const seed = async (studio: SeededStudio, state: "in_progress" | "submitted" | "reviewed") => {
  const id = randomUUID();
  if (state === "in_progress") await adminQuery(`insert into public.client_intake_forms (id, studio_id, client_id, status, responses) values ($1, $2, $3, 'in_progress', '{"q":"draft"}'::jsonb)`, [id, studio.studioId, studio.clientId]);
  else if (state === "submitted") await adminQuery(`insert into public.client_intake_forms (id, studio_id, client_id, status, responses, submitted_at) values ($1, $2, $3, 'submitted', '{"q":"orig"}'::jsonb, now())`, [id, studio.studioId, studio.clientId]);
  else await adminQuery(`insert into public.client_intake_forms (id, studio_id, client_id, status, responses, submitted_at, reviewed_at, reviewed_by) values ($1, $2, $3, 'reviewed', '{"q":"orig"}'::jsonb, now(), now(), $4)`, [id, studio.studioId, studio.clientId, studio.practitionerId]);
  return id;
};

let A: SeededStudio;
let B: SeededStudio;

describe("HON-75 G1: intake revision CAS through write_intake_revision", () => {
  it("setup", async () => {
    A = await seedStudio("hon75-a");
    B = await seedStudio("hon75-b");
  });

  it("two tabs: the first save wins; the second names the old revision and is refused with the first tab's answers intact", async () => {
    const id = await seed(A, "in_progress");
    const start = String((await rowOf(id)).revision);
    const tabA = await write(A.studioId, A.clientId, id, start, { q: "tab A" });
    expect(tabA.outcome).toBe("saved");
    expect(Number(tabA.new_revision)).toBe(Number(start) + 1);
    const afterA = await rowOf(id);
    const tabB = await write(A.studioId, A.clientId, id, start, { q: "tab B (stale)" });
    expect(tabB.outcome).toBe("conflict");
    expect(tabB.new_revision).toBeNull();
    expect(await rowOf(id), "the refused write changed nothing").toEqual(afterA);
    expect((afterA.responses as { q: string }).q).toBe("tab A");
  });

  it("a save with the CURRENT revision succeeds and advances it by exactly one; a repeat of the same call is then stale", async () => {
    const id = await seed(A, "in_progress");
    const r0 = Number((await rowOf(id)).revision);
    const first = await write(A.studioId, A.clientId, id, r0, { q: "one" });
    expect(first.outcome).toBe("saved");
    const again = await write(A.studioId, A.clientId, id, r0, { q: "one" });
    expect(again.outcome).toBe("conflict");
    expect(Number((await rowOf(id)).revision)).toBe(r0 + 1);
  });

  it("submit at the current revision submits; a late autosave and a repeat submit are then 'terminal', answers and status unchanged", async () => {
    const id = await seed(A, "in_progress");
    const r0 = Number((await rowOf(id)).revision);
    const sub = await write(A.studioId, A.clientId, id, r0, { q: "final" }, "submit", 5);
    expect(sub.outcome).toBe("submitted");
    const submitted = await rowOf(id);
    expect(submitted.status).toBe("submitted");
    const late = await write(A.studioId, A.clientId, id, r0, { q: "late autosave" });
    const current = await write(A.studioId, A.clientId, id, Number(submitted.revision), { q: "late autosave, current revision" });
    const repeat = await write(A.studioId, A.clientId, id, r0, { q: "again" }, "submit", 5);
    expect([late.outcome, current.outcome, repeat.outcome]).toEqual(["terminal", "terminal", "terminal"]);
    expect(await rowOf(id), "nothing changed after submit").toEqual(submitted);
  });

  it("a save after REVIEW is terminal too, with the reviewed row identical", async () => {
    const id = await seed(A, "reviewed");
    const before = await rowOf(id);
    const r = await write(A.studioId, A.clientId, id, Number(before.revision), { q: "after review" });
    expect(r.outcome).toBe("terminal");
    expect(await rowOf(id)).toEqual(before);
  });

  it("an already-submitted row refuses a save even with a stale revision (terminal is decided before conflict)", async () => {
    const id = await seed(A, "submitted");
    const before = await rowOf(id);
    expect((await write(A.studioId, A.clientId, id, 999, { q: "x" })).outcome).toBe("terminal");
    expect(await rowOf(id)).toEqual(before);
  });

  it("wrong scope is indistinguishable from a missing id, and writes nothing: other studio, wrong client, random id, soft-deleted", async () => {
    const id = await seed(A, "in_progress");
    const before = await rowOf(id);
    const rev = Number(before.revision);
    const outcomes = [
      await write(B.studioId, A.clientId, id, rev, { q: "x" }), // another studio
      await write(A.studioId, B.clientId, id, rev, { q: "x" }), // another client
      await write(A.studioId, A.clientId, randomUUID(), rev, { q: "x" }), // nonexistent
    ];
    expect(outcomes.map((o) => o.outcome)).toEqual(["not_available", "not_available", "not_available"]);
    expect(new Set(outcomes.map((o) => JSON.stringify(o))).size, "identical output for all three").toBe(1);
    expect(await rowOf(id)).toEqual(before);
    await adminQuery(`update public.client_intake_forms set deleted_at = now() where id = $1`, [id]);
    expect((await write(A.studioId, A.clientId, id, rev + 1, { q: "x" })).outcome).toBe("not_available");
  });

  it("malformed requests are refused before touching the row: negative or missing revision, bad step, bad operation, non-object answers", async () => {
    const id = await seed(A, "in_progress");
    const before = await rowOf(id);
    const rev = Number(before.revision);
    expect((await write(A.studioId, A.clientId, id, -1, { q: "x" })).outcome).toBe("invalid_request");
    expect((await write(A.studioId, A.clientId, id, null, { q: "x" })).outcome).toBe("invalid_request");
    expect((await write(A.studioId, A.clientId, id, rev, { q: "x" }, "save", 9)).outcome).toBe("invalid_request");
    expect((await write(A.studioId, A.clientId, id, rev, { q: "x" }, "submit", 2)).outcome, "submit only at the last step").toBe("invalid_request");
    expect((await write(A.studioId, A.clientId, id, rev, [] as unknown as object)).outcome).toBe("invalid_request");
    expect(await rowOf(id)).toEqual(before);
  });

  it("the function is callable by the server role only: an authenticated or anonymous role is refused", async () => {
    const id = await seed(A, "in_progress");
    const before = await rowOf(id);
    for (const role of ["authenticated", "anon"]) {
      const r = await adminTx(async (q) => {
        await q(`set local role ${role}`);
        try {
          await q(`select * from public.write_intake_revision($1, $2, $3, 0, '{"q":"x"}'::jsonb, 2, 'save')`, [id, A.studioId, A.clientId]);
          return "allowed";
        } catch (e) {
          return String((e as Error).message);
        }
      }).catch((e) => String((e as Error).message));
      expect(r, `${role} must not execute it`).toMatch(/permission denied|must be owner|not allowed/i);
    }
    expect(await rowOf(id)).toEqual(before);
  });
});
