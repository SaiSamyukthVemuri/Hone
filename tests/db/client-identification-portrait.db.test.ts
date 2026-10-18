// CLIENT IDENTIFICATION PORTRAIT — 0231 (FETT photos, HON-43).
//
// A practitioner marks one of a client's own CLIENT-SCOPED, unarchived photos
// as the client's identification portrait. Proved here against a real
// database, with synthetic rows only:
//   * the happy path, and clearing with null;
//   * the DATABASE refuses every wrong photo (another client, another studio,
//     a session photo, a treatment-area photo, an archived photo), on the
//     command AND on a direct UPDATE of clients;
//   * the command refuses every wrong actor non-disclosingly: a practitioner
//     of another studio, a DEACTIVATED practitioner, a RECEPTIONIST of the
//     same studio, and anon (EXECUTE revoked);
//   * archiving the portrait photo clears the pointer atomically (in the
//     archive command; no trigger is added to treatment_images), and an
//     archived photo can never be set again.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  adminTx,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedSession,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

const CREATE = `select public.create_treatment_image_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9) id`;
const ARCHIVE = `select public.archive_treatment_image($1,$2) id`;
const SET = `select public.set_client_portrait($1,$2) id`;

let A: SeededStudio;
let B: SeededStudio;
let otherClientInA: string;
let sessionA: { sessionId: string; blockId: string };

/** Create an image through the REAL write command, as the studio's owner. */
async function image(
  s: SeededStudio,
  clientId: string,
  scope: { sessionId?: string; blockId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const res = await userQuery(s.userId, CREATE, [
    id,
    clientId,
    scope.sessionId ?? null,
    scope.blockId ?? null,
    "treatment-images",
    `${s.studioId}/${clientId}/${id}.jpg`,
    "synthetic.jpg",
    "image/jpeg",
    1024,
  ]);
  return res.rows[0].id as string;
}

async function portraitOf(clientId: string): Promise<string | null> {
  const r = await adminQuery(`select portrait_image_id from public.clients where id = $1`, [clientId]);
  return (r.rows[0]?.portrait_image_id as string | null) ?? null;
}

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error("expected a refusal, but the call succeeded");
}

beforeAll(async () => {
  A = await seedStudio("portrait-a");
  B = await seedStudio("portrait-b");
  otherClientInA = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, 'Client other-a')`, [
    otherClientInA,
    A.studioId,
  ]);
  sessionA = await seedSession(A);
  // seedSession's block covers no area by default; the image command accepts a
  // block of the client's session, which is all the scope rule needs.
});
afterAll(async () => {
  await closePool();
});

describe("0231: setting and clearing a portrait", () => {
  it("an active practitioner sets a client-scoped photo, and clears it with null", async () => {
    const img = await image(A, A.clientId);
    const res = await userQuery(A.userId, SET, [A.clientId, img]);
    expect(res.rows[0].id).toBe(img);
    expect(await portraitOf(A.clientId)).toBe(img);

    await userQuery(A.userId, SET, [A.clientId, null]);
    expect(await portraitOf(A.clientId)).toBeNull();
  });
});

describe("0231: the DATABASE refuses every wrong photo", () => {
  it("another client's photo, in the same studio", async () => {
    const theirs = await image(A, otherClientInA);
    const r = await refusal(userQuery(A.userId, SET, [A.clientId, theirs]));
    expect(r.code).toBe(CHECK_VIOLATION);
    expect(r.message).toMatch(/current client photo of the same client/);
    expect(await portraitOf(A.clientId)).toBeNull();
  });

  it("a session photo and a treatment-area photo of the SAME client", async () => {
    const sessionPhoto = await image(A, A.clientId, { sessionId: sessionA.sessionId });
    const areaPhoto = await image(A, A.clientId, {
      sessionId: sessionA.sessionId,
      blockId: sessionA.blockId,
    });
    for (const img of [sessionPhoto, areaPhoto]) {
      const r = await refusal(userQuery(A.userId, SET, [A.clientId, img]));
      expect(r.code).toBe(CHECK_VIOLATION);
    }
    expect(await portraitOf(A.clientId)).toBeNull();
  });

  it("an archived photo", async () => {
    const img = await image(A, A.clientId);
    await userQuery(A.userId, ARCHIVE, [img, A.clientId]);
    const r = await refusal(userQuery(A.userId, SET, [A.clientId, img]));
    expect(r.code).toBe(CHECK_VIOLATION);
  });

  it("another studio's photo, even on a DIRECT update by an admin connection", async () => {
    const foreign = await image(B, B.clientId);
    const r = await refusal(
      adminQuery(`update public.clients set portrait_image_id = $2 where id = $1`, [A.clientId, foreign]),
    );
    expect(r.code).toBe(CHECK_VIOLATION);
    expect(await portraitOf(A.clientId)).toBeNull();
  });

  it("a direct UPDATE by a signed-in practitioner cannot bypass the rule", async () => {
    const theirs = await image(A, otherClientInA);
    const r = await refusal(
      userQuery(A.userId, `update public.clients set portrait_image_id = $2 where id = $1`, [
        A.clientId,
        theirs,
      ]),
    );
    // Either the trigger refuses it or the role has no UPDATE: never a write.
    expect([CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE]).toContain(r.code);
    expect(await portraitOf(A.clientId)).toBeNull();
  });
});

describe("0231: the command refuses every wrong actor, non-disclosingly", () => {
  it("a practitioner of ANOTHER studio", async () => {
    const img = await image(A, A.clientId);
    const r = await refusal(userQuery(B.userId, SET, [A.clientId, img]));
    expect(r.code).toBe(CHECK_VIOLATION);
    expect(r.message).toMatch(/That client is not available\./);
    expect(await portraitOf(A.clientId)).toBeNull();
  });

  it("an unknown client gets the SAME message as a foreign one", async () => {
    const r = await refusal(userQuery(A.userId, SET, [randomUUID(), null]));
    expect(r.message).toMatch(/That client is not available\./);
  });

  it("a DEACTIVATED practitioner of the same studio", async () => {
    const member = await seedMember(A, "portrait-deact");
    const img = await image(A, A.clientId);
    await adminQuery(`update public.practitioners set active = false where id = $1`, [member.practitionerId]);
    const r = await refusal(userQuery(member.userId, SET, [A.clientId, img]));
    expect(r.message).toMatch(/That client is not available\./);
    expect(await portraitOf(A.clientId)).toBeNull();
  });

  it("a RECEPTIONIST of the same studio (no practitioners row)", async () => {
    const userId = randomUUID();
    await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [
      userId,
      `portrait-recept-${userId.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.studio_receptionists (studio_id, user_id, display_name, active)
       values ($1, $2, 'Synthetic Front Desk', true)`,
      [A.studioId, userId],
    );
    const img = await image(A, A.clientId);
    const r = await refusal(userQuery(userId, SET, [A.clientId, img]));
    expect(r.message).toMatch(/That client is not available\./);
    expect(await portraitOf(A.clientId)).toBeNull();
  });

  it("anon cannot even call it (EXECUTE revoked)", async () => {
    const r = await refusal(asRole("anon", (q) => q(SET, [A.clientId, null])));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("0231: archiving the portrait photo clears it, atomically", () => {
  it("the archive command clears the pointer in the same transaction", async () => {
    const img = await image(A, A.clientId);
    await userQuery(A.userId, SET, [A.clientId, img]);
    expect(await portraitOf(A.clientId)).toBe(img);
    const archived = await userQuery(A.userId, ARCHIVE, [img, A.clientId]);
    expect(archived.rows[0].id).toBe(img);
    expect(await portraitOf(A.clientId), "no pointer to an archived photo").toBeNull();
    // And it can never be set again while archived.
    const r = await refusal(userQuery(A.userId, SET, [A.clientId, img]));
    expect(r.code).toBe(CHECK_VIOLATION);
  });

  it("archiving a DIFFERENT photo leaves the portrait alone", async () => {
    const portrait = await image(A, A.clientId);
    const other = await image(A, A.clientId);
    await userQuery(A.userId, SET, [A.clientId, portrait]);
    await userQuery(A.userId, ARCHIVE, [other, A.clientId]);
    expect(await portraitOf(A.clientId)).toBe(portrait);
    await userQuery(A.userId, SET, [A.clientId, null]);
  });
});

describe("0231: moving a client across studios (Codex P2 4301792066)", () => {
  async function freshClient(s: SeededStudio, label: string): Promise<string> {
    const id = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, $3)`, [
      id,
      s.studioId,
      `Client ${label}`,
    ]);
    return id;
  }
  const studioOf = async (clientId: string) =>
    (await adminQuery(`select studio_id from public.clients where id = $1`, [clientId])).rows[0]
      .studio_id as string;
  const MOVE = `update public.clients set studio_id = $2 where id = $1`;

  it("a client WITH a portrait is refused, even on a direct admin update", async () => {
    const c = await freshClient(A, "move-with");
    const img = await image(A, c);
    await userQuery(A.userId, SET, [c, img]);
    const r = await refusal(adminQuery(MOVE, [c, B.studioId]));
    expect(r.code).toBe(CHECK_VIOLATION);
    expect(r.message).toMatch(/current client photo of the same client/);
    expect(await studioOf(c)).toBe(A.studioId);
    expect(await portraitOf(c)).toBe(img);
  });

  it("a member of BOTH studios cannot move it through the members-update path either", async () => {
    const c = await freshClient(A, "move-member");
    const img = await image(A, c);
    await userQuery(A.userId, SET, [c, img]);
    const both = await seedMember(B, "portrait-both");
    // Also an active practitioner of A, so is_studio_member holds for BOTH
    // studios and RLS alone would let the move through.
    await adminQuery(
      `insert into public.practitioners (studio_id, user_id, display_name, email, role, active)
       select $2, user_id, display_name, email, 'practitioner', true from public.practitioners where id = $1`,
      [both.practitionerId, A.studioId],
    );
    // Either the trigger refuses it or the role has no UPDATE (0169): never a write.
    const r = await refusal(userQuery(both.userId, MOVE, [c, B.studioId]));
    expect([CHECK_VIOLATION, INSUFFICIENT_PRIVILEGE]).toContain(r.code);
    expect(await studioOf(c)).toBe(A.studioId);
  });

  it("a client with NO portrait still moves (the early return)", async () => {
    const c = await freshClient(A, "move-without");
    await adminQuery(MOVE, [c, B.studioId]);
    expect(await studioOf(c)).toBe(B.studioId);
  });
});

describe("0231: a concurrent archive WAITS for the setter, then clears the pointer", () => {
  it("B's archive blocks on A's FOR SHARE (asserted on the real lock), then clears it", async () => {
    // Without the lock, B's archive would commit first, A would then commit a
    // pointer to an already-archived photo, and the invariant would break.
    const img = await image(A, A.clientId);
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((r) => (releaseA = r));
    let aHolds!: () => void;
    const aHolding = new Promise<void>((r) => (aHolds = r));

    // Connection A: set the portrait and HOLD the transaction open.
    const a = asUser(A.userId, async (q) => {
      await q(SET, [A.clientId, img]);
      aHolds();
      await aMayCommit;
    });
    await aHolding;

    // Connection B: archive the same photo while A is still open.
    const b = asUser(A.userId, (q) => q(ARCHIVE, [img, A.clientId]));
    let bResult: unknown;
    try {
      // Prove B is waiting on a LOCK, not merely slow: bounded poll of
      // pg_stat_activity for a backend running the archive in a Lock wait.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const r = await adminQuery(
          `select count(*)::int n from pg_stat_activity
            where wait_event_type = 'Lock' and query like '%archive_treatment_image%'`,
        );
        blocked = (r.rows[0].n as number) > 0;
        if (!blocked) await new Promise((r) => setImmediate(r));
      }
      expect(blocked, "B must be blocked on A's row lock").toBe(true);
    } finally {
      releaseA();
      await a;
      bResult = await b;
    }
    expect((bResult as { rows: { id: string }[] }).rows[0].id).toBe(img);
    expect(await portraitOf(A.clientId), "B cleared the pointer A committed").toBeNull();
  });
});

describe("0231: a concurrent studio move WAITS for the setter's client lock (Codex P2 4302682030)", () => {
  it("set_client_portrait blocks on the moving client, then refuses; never a false success", async () => {
    // A portrait-less client may move studios. Without the lock, the setter
    // authorized against the OLD studio, its UPDATE then matched no row once
    // the move committed, and it still returned the image id: success with
    // nothing written.
    const c = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, 'Client race-move')`, [
      c,
      A.studioId,
    ]);
    const img = await image(A, c);

    let releaseMove!: () => void;
    const moveMayCommit = new Promise<void>((r) => (releaseMove = r));
    let moveHolds!: () => void;
    const moveHolding = new Promise<void>((r) => (moveHolds = r));

    // Connection M: move the client to B and HOLD the transaction open.
    const move = adminTx(async (q) => {
      await q(`update public.clients set studio_id = $2 where id = $1`, [c, B.studioId]);
      moveHolds();
      await moveMayCommit;
    });
    await moveHolding;

    // Connection S: A's owner sets the portrait while the move is open.
    const set = userQuery(A.userId, SET, [c, img]).then(
      () => ({ ok: true as const }),
      (e: { code?: string; message: string }) => ({ ok: false as const, code: e.code, message: e.message }),
    );
    try {
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const r = await adminQuery(
          `select count(*)::int n from pg_stat_activity
            where wait_event_type = 'Lock' and query like '%set_client_portrait%'`,
        );
        blocked = (r.rows[0].n as number) > 0;
        if (!blocked) await new Promise((r) => setImmediate(r));
      }
      expect(blocked, "the setter must be blocked on the moving client's row lock").toBe(true);
    } finally {
      releaseMove();
      await move;
    }
    const outcome = await set;
    expect(outcome, "never a success for a write that did not happen").toMatchObject({
      ok: false,
      code: CHECK_VIOLATION,
    });
    expect((outcome as { message: string }).message).toMatch(/That client is not available\./);
    expect(await portraitOf(c)).toBeNull();
  });
});

describe("0231: archive and setter take locks in the SAME order (Codex P2 4305077733)", () => {
  it("a setter holding the client lock makes the archive WAIT on the client, never deadlock", async () => {
    // The deadlock shape: the setter holds the CLIENT row, then its integrity
    // trigger wants FOR SHARE on the IMAGE. If the archive had already locked
    // the image (old order: image, then client), each waits on the other and
    // Postgres aborts one with 40P01. With the client locked first, the
    // archive waits on the client and never touches the image until then.
    const c = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, 'Client lock-order')`, [
      c,
      A.studioId,
    ]);
    const img = await image(A, c);

    let releaseSetter!: () => void;
    const setterMayFinish = new Promise<void>((r) => (releaseSetter = r));
    let setterHolds!: () => void;
    const setterHolding = new Promise<void>((r) => (setterHolds = r));

    // Connection S: the setter's FIRST lock (the client row), then hold.
    const setter = adminTx(async (q) => {
      await q(`select 1 from public.clients where id = $1 for update`, [c]);
      setterHolds();
      await setterMayFinish;
      // The setter's SECOND step: the pointer write, whose trigger takes FOR
      // SHARE on the image. Deadlocks only if the archive locked the image.
      await q(`update public.clients set portrait_image_id = $2 where id = $1`, [c, img]);
    }).then(
      () => ({ ok: true as const }),
      (e: { code?: string }) => ({ ok: false as const, code: e.code }),
    );
    await setterHolding;

    // Connection R: archive the same photo while the setter holds the client.
    const archive = userQuery(A.userId, ARCHIVE, [img, c]).then(
      (r) => ({ ok: true as const, id: r.rows[0].id as string | null }),
      (e: { code?: string }) => ({ ok: false as const, code: e.code }),
    );
    try {
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const r = await adminQuery(
          `select count(*)::int n from pg_stat_activity
            where wait_event_type = 'Lock' and query like '%archive_treatment_image%'`,
        );
        blocked = (r.rows[0].n as number) > 0;
        if (!blocked) await new Promise((r) => setImmediate(r));
      }
      expect(blocked, "the archive must wait on the setter's client lock").toBe(true);
    } finally {
      releaseSetter();
    }
    const [s, a] = await Promise.all([setter, archive]);
    expect(s, "the setter never dies of a deadlock").toEqual({ ok: true });
    expect(a, "the archive never dies of a deadlock").toEqual({ ok: true, id: img });
    // The archive ran after the setter committed, so it cleared the pointer.
    expect(await portraitOf(c)).toBeNull();
  });
});
