import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminQuery, adminTx, asRole, asUser, closePool, seedMember, seedStudio } from "./helpers/harness";

const q = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (await adminQuery(text, params)).rows as T[];

// ===========================================================================
// 0323 — launch controls. Part A: the admission matrix lets an invited booking through Closed.
// Part B — count_competing_waitlist_invitations: how many live invitations in the
// caller's studio compete with a window. Scope columns have no API grant, so the
// narrowing is done inside an owner-gated function that returns one integer.
// ===========================================================================

const COUNT = `select public.count_competing_waitlist_invitations($1,$2::date,$3::date,$4::int[]) as n`;
const root = join(__dirname, "..", "..");
const UP = readFileSync(join(root, "supabase/migrations/0323_waitlist_launch_controls.sql"), "utf8");
const DOWN = readFileSync(join(root, "supabase/rollbacks/0323_waitlist_launch_controls.down.sql"), "utf8");

afterAll(async () => {
  await closePool();
});

const DAY = 86_400_000;
const date = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const dow = (offset: number) => new Date(`${date(offset)}T12:00:00Z`).getUTCDay();

type Studio = { studioId: string; userId: string; serviceId: string };

async function studio(label: string): Promise<Studio> {
  const s = await seedStudio(`b323-${label}`);
  const svc = await q<{ id: string }>(
    `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
     values ($1,'Consultation',30,true,'consultation') returning id`,
    [s.studioId],
  );
  await q(`select * from public.open_new_client_waitlist_admission_round($1,$2,20)`, [s.studioId, s.userId]);
  return { studioId: s.studioId, userId: s.userId, serviceId: svc[0].id };
}

let seq = 0;
async function invite(s: Studio, from: number, to: number, weekdays: number[] | null = null, serviceId = s.serviceId) {
  seq += 1;
  const e = await q<any>(
    `select * from public.create_practitioner_waitlist_entry($1,$2,'Prospect',$3,null,null)`,
    [s.studioId, s.userId, `b323-${seq}-${s.studioId.slice(0, 8)}@example.com`],
  );
  const a = await q<any>(
    `select * from public.admit_new_client_waitlist_entry($1,$2,$3,$4,$5,$6,$7,72)`,
    [s.studioId, s.userId, e[0].entry_id, serviceId, date(from), date(to), weekdays],
  );
  expect(a[0].result).toBe("admitted");
  return a[0].invitation_id as string;
}

const count = (s: Studio, from: number, to: number, weekdays: number[] | null = null, asOwner = s.userId) =>
  asUser(asOwner, (query) => query(COUNT, [s.studioId, date(from), date(to), weekdays])).then((r) => r.rows[0].n as number);

async function stamp(studioId: string, mode: string) {
  await adminTx(async (query) => {
    await query("select set_config('hone.admission_mode_studio_id', $1, true)", [studioId]);
    await query(
      `update public.studios set new_client_admission_mode = $2, new_client_admission_mode_set_at = now() where id = $1`,
      [studioId, mode],
    );
  });
}
const gate = async (studioId: string, op: string) =>
  (await q<{ r: string }>(`select public.assert_new_client_admission($1,$2,false) as r`, [studioId, op]))[0].r;
const markerExists = async () =>
  (await q<{ n: number }>(
    `select count(*)::int as n from pg_proc where proname='waitlist_closed_invited_booking_enabled' and pronamespace='public'::regnamespace`,
  ))[0].n === 1;

describe("0323 part A — the admission matrix", () => {
  // The whole matrix, every operation under every mode. Closed: no public booking, no public
  // join, but an invited booking passes. Unknown cannot be stamped, so it is covered by the
  // static test and by 0204's own suite.
  const EXPECT: Record<string, Record<string, string>> = {
    open: { book: "ok", invited_book: "ok", join_waitlist: "new_client_admission_refused" },
    waitlist: { book: "new_client_admission_refused", invited_book: "ok", join_waitlist: "ok" },
    closed: { book: "new_client_admission_refused", invited_book: "ok", join_waitlist: "new_client_admission_refused" },
  };
  for (const [mode, ops] of Object.entries(EXPECT)) {
    it(`mode ${mode}: ${Object.entries(ops).map(([o, r]) => `${o}=${r === "ok" ? "ok" : "refused"}`).join(", ")}`, async () => {
      const s = await studio(`mx-${mode}`);
      await stamp(s.studioId, mode);
      for (const [op, want] of Object.entries(ops)) expect(await gate(s.studioId, op), `${mode}/${op}`).toBe(want);
    });
  }

  it("UNKNOWN still refuses invited_book (and every other operation): a missing studio, and an unstamped studio with no bridge fact", async () => {
    const missing = randomUUID();
    for (const op of ["book", "invited_book", "join_waitlist"]) {
      expect(await gate(missing, op), `missing studio / ${op}`).toBe("new_client_admission_refused");
    }
    const s = await studio("mx-unknown");
    await adminTx(async (query) => {
      await query("select set_config('hone.admission_mode_studio_id', $1, true)", [s.studioId]);
      await query(
        `update public.studios set new_client_admission_mode = 'open', new_client_admission_mode_set_at = null,
                new_client_admission_mode_set_by = null where id = $1`,
        [s.studioId],
      );
    });
    for (const op of ["book", "invited_book", "join_waitlist"]) {
      const r = await q<{ r: string }>(`select public.assert_new_client_admission($1,$2,null) as r`, [s.studioId, op]);
      expect(r[0].r, `unstamped, no bridge fact / ${op}`).toBe("new_client_admission_refused");
    }
  });

  it("an unknown operation is refused in every mode", async () => {
    const s = await studio("mx-unk");
    for (const mode of ["open", "waitlist", "closed"]) {
      await stamp(s.studioId, mode);
      expect(await gate(s.studioId, "anything_else")).toBe("new_client_admission_refused");
    }
  });

  it("the matrix is callable by NOBODY through the API roles", async () => {
    const s = await studio("mx-priv");
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await expect(
        asRole(role, (query) => query(`select public.assert_new_client_admission($1,'invited_book',false)`, [s.studioId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("the marker exists, answers true, and only service_role may call it", async () => {
    expect(await markerExists()).toBe(true);
    const r = await asRole("service_role", (query) => query(`select public.waitlist_closed_invited_booking_enabled() as v`));
    expect(r.rows[0].v).toBe(true);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(
        asRole(role, (query) => query(`select public.waitlist_closed_invited_booking_enabled()`)),
        role,
      ).rejects.toMatchObject({ code: "42501" });
    }
    const acl = await q<{ n: number }>(
      `select count(*)::int as n from pg_proc p cross join lateral aclexplode(p.proacl) a
        where p.oid = 'public.waitlist_closed_invited_booking_enabled()'::regprocedure and a.grantee = 0`,
    );
    expect(acl[0].n).toBe(0);
  });
});

describe("0323 part B — what counts as competing", () => {
  it("does not count an invitation whose weekdays are disjoint from the window's", async () => {
    const s = await studio("wd");
    await invite(s, 1, 14, [dow(1)]);
    const other = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== dow(1))[0];
    // The invitation permits one weekday; a window that permits only a different one shares no day.
    expect(await count(s, 1, 14, [other])).toBe(0);
  });

  it("counts an invitation whose weekdays and dates overlap the window", async () => {
    const s = await studio("ov");
    await invite(s, 1, 14, [dow(1)]);
    expect(await count(s, 1, 14, [dow(1)])).toBe(1);
    expect(await count(s, 1, 14, null)).toBe(1);
  });

  it("counts a partial date overlap and not a window that only touches the next day", async () => {
    const s = await studio("part");
    await invite(s, 1, 7, null);
    expect(await count(s, 7, 20)).toBe(1);
    expect(await count(s, 8, 20)).toBe(0);
  });

  it("checks weekdays only on the dates both ranges share, not on each range alone", async () => {
    const s = await studio("inter");
    // Seven consecutive days contain each weekday once, so day 1's weekday does not recur
    // between days 2 and 7: the ranges overlap and the weekdays match elsewhere, yet no
    // shared date satisfies both.
    await invite(s, 1, 7, [dow(1)]);
    expect(await count(s, 2, 30, [dow(1)])).toBe(0);
    expect(await count(s, 1, 30, [dow(1)])).toBe(1);
  });

  it("counts an invitation for ANOTHER service: the studio is one calendar", async () => {
    const s = await studio("svc");
    const second = await q<{ id: string }>(
      `insert into public.services (studio_id,name,default_duration_minutes,active,modality)
       values ($1,'Other',45,true,'consultation') returning id`,
      [s.studioId],
    );
    await invite(s, 1, 14, null, second[0].id);
    expect(await count(s, 1, 14)).toBe(1);
  });

  it("counts several invitations", async () => {
    const s = await studio("many");
    await invite(s, 1, 14);
    await invite(s, 1, 14, [dow(1)]);
    await invite(s, 40, 50);
    expect(await count(s, 1, 14)).toBe(2);
  });
});

describe("0323 — who can ask", () => {
  it("refuses an owner of another studio, and counts nothing for their own", async () => {
    const a = await studio("a");
    await invite(a, 1, 14);
    const b = await studio("b");
    await expect(count(a, 1, 14, null, b.userId)).rejects.toMatchObject({ code: "42501" });
    expect(await count(b, 1, 14)).toBe(0);
  });

  it("refuses a non-owner member of the same studio", async () => {
    const s = await studio("member");
    const m = await seedMember({ studioId: s.studioId, userId: s.userId, practitionerId: "", clientId: "" }, "m");
    await invite(s, 1, 14);
    await expect(count(s, 1, 14, null, m.userId)).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a malformed window or weekday list", async () => {
    const s = await studio("bad");
    await expect(count(s, 5, 1)).rejects.toMatchObject({ code: "22023" });
    await expect(count(s, 1, 500)).rejects.toMatchObject({ code: "22023" });
    await expect(count(s, 1, 14, [7])).rejects.toMatchObject({ code: "22023" });
  });
});

describe("0323 — privileges, by role name", () => {
  const exec = async (role: string) =>
    (await q<{ ok: boolean }>(
      `select has_function_privilege($1,'public.count_competing_waitlist_invitations(uuid,date,date,integer[])','EXECUTE') as ok`,
      [role],
    ))[0].ok;

  it("only authenticated can execute it; PUBLIC, anon and service_role cannot", async () => {
    expect(await exec("authenticated")).toBe(true);
    expect(await exec("anon")).toBe(false);
    expect(await exec("service_role")).toBe(false);
    const acl = await q<{ n: number }>(
      `select count(*)::int as n from pg_proc p cross join lateral aclexplode(p.proacl) a
        where p.oid = 'public.count_competing_waitlist_invitations(uuid,date,date,integer[])'::regprocedure and a.grantee = 0`,
    );
    expect(acl[0].n).toBe(0);
  });

  it("the revoked roles are refused when they try to call it", async () => {
    const s = await studio("roles");
    for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (query) => query(COUNT, [s.studioId, date(1), date(14), null]))).rejects.toMatchObject({
        code: "42501",
      });
    }
  });

  it("authenticated without a signed-in user is refused by the function itself", async () => {
    const s = await studio("nouser");
    await expect(asRole("authenticated", (query) => query(COUNT, [s.studioId, date(1), date(14), null]))).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("0323 — down then up", () => {
  it("the rollback removes the function and re-applying the migration restores it with the same grants", async () => {
    const s = await studio("downup");
    await invite(s, 1, 14);
    const s2 = await studio("downup-mx");
    await stamp(s2.studioId, "closed");
    expect(await gate(s2.studioId, "invited_book")).toBe("ok");
    expect(await markerExists()).toBe(true);
    try {
      await adminQuery(DOWN);
      // The marker goes WITH the rule: absent exactly when closed refuses an invited booking again.
      expect(await markerExists()).toBe(false);
      expect(await gate(s2.studioId, "invited_book")).toBe("new_client_admission_refused");
      expect(await gate(s2.studioId, "book")).toBe("new_client_admission_refused");
      const gone = await q<{ n: number }>(
        `select count(*)::int as n from pg_proc where proname='count_competing_waitlist_invitations' and pronamespace='public'::regnamespace`,
      );
      expect(gone[0].n).toBe(0);
      // The data it read is untouched.
      const live = await q<{ n: number }>(
        `select count(*)::int as n from public.new_client_waitlist_invitations where studio_id=$1`, [s.studioId],
      );
      expect(live[0].n).toBe(1);
    } finally {
      await adminQuery(UP);
    }
    expect(await count(s, 1, 14)).toBe(1);
    expect(await markerExists()).toBe(true);
    expect(await gate(s2.studioId, "invited_book")).toBe("ok");
    expect(
      (await q<{ ok: boolean }>(
        `select has_function_privilege('service_role','public.count_competing_waitlist_invitations(uuid,date,date,integer[])','EXECUTE') as ok`,
      ))[0].ok,
    ).toBe(false);
  });
});
