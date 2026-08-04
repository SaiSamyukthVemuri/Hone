import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, closePool } from "./helpers/harness";
import { randomUUID } from "node:crypto";

// ===========================================================================
// 0170 — public.create_public_appointment, proven on the real migrated DB.
// ===========================================================================
//
// The public booking route used to INSERT the appointment itself and then write
// its appointment_audit row in a SEPARATE statement whose error was discarded.
// This command owns both halves in one transaction and derives every
// authoritative value from database state.
//
// GOTCHA that shaped this file: the command enforces the public booking horizon
// (public_booking_horizon_months * 31 days). The repository's usual DB-test
// convention of a fixed far-future instant like 2031-09-15 is therefore REFUSED
// with 'outside_horizon'. Every instant below is computed relative to now().

const hash64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");

type Studio = {
  studioId: string;
  ownerId: string;
  clientId: string;
  serviceId: string;
};

/** A studio open 00:00-23:59 studio-wide, every weekday, with one active service. */
async function seedPublicStudio(
  label: string,
  opts: { buffer?: number; tz?: string; durationMinutes?: number } = {},
): Promise<Studio> {
  const studioId = randomUUID();
  const userId = randomUUID();
  const ownerId = randomUUID();
  const clientId = randomUUID();
  const serviceId = randomUUID();
  const email = `${label}-${studioId.slice(0, 8)}@harness.local`;

  await adminQuery(`insert into auth.users (id, email) values ($1, $2)`, [userId, email]);
  await adminQuery(
    `insert into public.studios
       (id, name, owner_email, timezone, buffer_minutes, slug, public_booking_horizon_months)
     values ($1, $2, $3, $4, $5, $6, 3)`,
    [studioId, `Harness ${label}`, email, opts.tz ?? "UTC", opts.buffer ?? 15, `${label}-${studioId.slice(0, 8)}`],
  );
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, $4, $5, 'owner', true)`,
    [ownerId, studioId, userId, `Owner ${label}`, email],
  );
  await adminQuery(`insert into public.clients (id, studio_id, name, email) values ($1,$2,$3,$4)`, [
    clientId,
    studioId,
    `Client ${label}`,
    `client-${studioId.slice(0, 8)}@harness.local`,
  ]);
  await adminQuery(
    `insert into public.services (id, studio_id, name, default_duration_minutes, active)
     values ($1, $2, 'Consultation', $3, true)`,
    [serviceId, studioId, opts.durationMinutes ?? 60],
  );
  await adminQuery(
    `insert into public.studio_availability_default
       (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
     select $1, g, true, '00:00', '23:59', null from generate_series(0,6) g`,
    [studioId],
  );
  return { studioId, ownerId, clientId, serviceId };
}

/** An in-horizon instant: `days` from now at `hh:mm` UTC. */
function at(days: number, hh: number, mm = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

async function book(
  s: Studio,
  startsAt: string,
  over: Partial<{ clientId: string; serviceId: string; notes: string | null }> = {},
) {
  const r = await adminQuery(
    `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,$6,$7)`,
    [
      s.studioId,
      over.clientId ?? s.clientId,
      over.serviceId ?? s.serviceId,
      startsAt,
      hash64(),
      over.notes === undefined ? "hello" : over.notes,
      null,
    ],
  );
  return r.rows[0];
}

let A: Studio;
let B: Studio;

beforeAll(async () => {
  A = await seedPublicStudio("pubappt-a");
  B = await seedPublicStudio("pubappt-b");
});
afterAll(async () => {
  await closePool();
});

describe("success — the appointment and its audit row are created together", () => {
  it("creates a confirmed appointment with server-derived values", async () => {
    const row = await book(A, at(3, 10));
    expect(row.result).toBe("created");
    expect(row.appointment_id).toBeTruthy();
    expect(row.duration_minutes).toBe(60);
    expect(row.practitioner_id).toBe(A.ownerId);

    const appt = await adminQuery(
      `select status, duration_minutes, starts_at, ends_at, practitioner_id, client_id,
              service_id, booked_outside_availability, capacity_enabled, buffer_minutes_snapshot,
              blocked_ends_at, sync_version, referral_source, notes
         from public.appointments where id = $1`,
      [row.appointment_id],
    );
    const a = appt.rows[0];
    expect(a.status).toBe("confirmed");
    expect(a.duration_minutes).toBe(60);
    expect(new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()).toBe(60 * 60_000);
    expect(a.practitioner_id).toBe(A.ownerId);
    // The caller cannot request the owner-only override; it must stay false.
    expect(a.booked_outside_availability).toBe(false);
    // Trigger-derived columns are populated.
    expect(a.capacity_enabled).toBe(false);
    expect(a.buffer_minutes_snapshot).toBe(15);
    expect(a.blocked_ends_at).not.toBeNull();
    expect(a.sync_version).toBe(1);
  });

  it("writes EXACTLY ONE audit row, with the public-booking shape", async () => {
    const row = await book(A, at(4, 10));
    const audit = await adminQuery(
      `select actor_type, actor_id, action, details from public.appointment_audit
        where appointment_id = $1`,
      [row.appointment_id],
    );
    expect(audit.rowCount).toBe(1);
    const d = audit.rows[0];
    expect(d.actor_type).toBe("client");
    expect(d.actor_id).toBeNull();
    expect(d.action).toBe("created");
    expect(d.details.source).toBe("public_booking");
    expect(d.details.notes).toBe("hello");
    // The email is READ FROM the client row inside the command, never passed in.
    expect(d.details.email).toBe(`client-${A.studioId.slice(0, 8)}@harness.local`);
  });

  it("duration is re-derived from the CURRENT service row, not the caller", async () => {
    await adminQuery(`update public.services set default_duration_minutes = 45 where id = $1`, [
      A.serviceId,
    ]);
    const row = await book(A, at(5, 10));
    expect(row.duration_minutes).toBe(45);
    expect(new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()).toBe(45 * 60_000);
    await adminQuery(`update public.services set default_duration_minutes = 60 where id = $1`, [
      A.serviceId,
    ]);
  });

  it("creates the reservation shadow row via the existing trigger", async () => {
    const row = await book(A, at(6, 10));
    const res = await adminQuery(
      `select source_kind, resource_key, starts_at, ends_at
         from public.studio_calendar_reservations where source_id = $1`,
      [row.appointment_id],
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].source_kind).toBe("appointment");
    // capacity OFF -> the resource is the studio.
    expect(res.rows[0].resource_key).toBe(A.studioId);
  });
});

describe("tenant isolation", () => {
  it("rejects a cross-studio client", async () => {
    const r = await book(A, at(7, 10), { clientId: B.clientId });
    expect(r.result).toBe("invalid_client");
  });

  it("rejects a cross-studio service", async () => {
    const r = await book(A, at(7, 12), { serviceId: B.serviceId });
    expect(r.result).toBe("invalid_service");
  });

  it("rejects an unknown client with the SAME code as a cross-studio one (no enumeration)", async () => {
    const unknown = await book(A, at(7, 14), { clientId: randomUUID() });
    const foreign = await book(A, at(7, 16), { clientId: B.clientId });
    expect(unknown.result).toBe("invalid_client");
    expect(foreign.result).toBe(unknown.result);
  });

  it("rejects an archived client", async () => {
    const archived = randomUUID();
    await adminQuery(
      `insert into public.clients (id, studio_id, name, email, archived_at)
       values ($1,$2,'Archived',$3, now())`,
      [archived, A.studioId, `arch-${archived.slice(0, 8)}@harness.local`],
    );
    const r = await book(A, at(8, 10), { clientId: archived });
    expect(r.result).toBe("invalid_client");
  });

  it("rejects an inactive service", async () => {
    const svc = randomUUID();
    await adminQuery(
      `insert into public.services (id, studio_id, name, default_duration_minutes, active)
       values ($1,$2,'Retired',60,false)`,
      [svc, A.studioId],
    );
    const r = await book(A, at(8, 12), { serviceId: svc });
    expect(r.result).toBe("invalid_service");
  });

  it("rejects a studio that does not exist", async () => {
    const r = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [randomUUID(), A.clientId, A.serviceId, at(9, 10), hash64()],
    );
    expect(r.rows[0].result).toBe("studio_not_found");
  });
});

describe("availability contract — enforced with capacity OFF", () => {
  it("rejects a past instant", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const r = await book(A, past);
    expect(r.result).toBe("invalid_time");
  });

  it("rejects an instant beyond the booking horizon", async () => {
    const r = await book(A, at(200, 10));
    expect(r.result).toBe("outside_horizon");
  });

  it("rejects a closed weekday", async () => {
    const s = await seedPublicStudio("closed-day");
    // Close every day, then try to book.
    await adminQuery(`update public.studio_availability_default set is_open = false where studio_id = $1`, [
      s.studioId,
    ]);
    const r = await book(s, at(3, 10));
    // Readiness gate fires first: no open weekly day means not publicly bookable.
    expect(r.result).toBe("public_booking_unavailable");
  });

  it("rejects a time outside the open window", async () => {
    const s = await seedPublicStudio("narrow-window");
    await adminQuery(
      `update public.studio_availability_default set open_time='09:00', close_time='17:00' where studio_id=$1`,
      [s.studioId],
    );
    const r = await book(s, at(3, 20)); // 20:00 UTC, window closes 17:00
    expect(r.result).toBe("outside_availability");
  });

  it("honours a date-specific override that CLOSES the day", async () => {
    const s = await seedPublicStudio("override-closed");
    const target = at(4, 10);
    const localDate = target.slice(0, 10);
    await adminQuery(
      `insert into public.studio_availability_overrides
         (studio_id, effective_date, is_open, practitioner_id) values ($1,$2::date,false,null)`,
      [s.studioId, localDate],
    );
    const r = await book(s, target);
    expect(r.result).toBe("studio_closed");
  });

  it("rejects a full-day blockout", async () => {
    const s = await seedPublicStudio("blockout");
    const target = at(4, 10);
    await adminQuery(
      `insert into public.studio_blockouts (studio_id, starts_on, ends_on) values ($1,$2::date,$2::date)`,
      [s.studioId, target.slice(0, 10)],
    );
    const r = await book(s, target);
    expect(r.result).toBe("studio_closed");
  });

  it("rejects a timed block — which capacity-OFF reservations alone would miss", async () => {
    const s = await seedPublicStudio("timed-block");
    const target = at(5, 10);
    await adminQuery(
      `insert into public.studio_timed_blocks (studio_id, starts_at, ends_at, category, practitioner_id)
       values ($1,$2::timestamptz,$3::timestamptz,'admin',null)`,
      [s.studioId, target, at(5, 12)],
    );
    const r = await book(s, target);
    expect(r.result).toBe("time_unavailable");
  });

  it("rejects an overlapping appointment", async () => {
    const s = await seedPublicStudio("overlap");
    expect((await book(s, at(6, 10))).result).toBe("created");
    const r = await book(s, at(6, 10, 30));
    expect(r.result).toBe("time_unavailable");
  });

  it("rejects a buffer-conflicting appointment", async () => {
    const s = await seedPublicStudio("buffer", { buffer: 30 });
    expect((await book(s, at(7, 10))).result).toBe("created"); // 10:00-11:00
    // 11:15 starts inside the 30-minute gap after 11:00.
    const r = await book(s, at(7, 11, 15));
    expect(r.result).toBe("time_unavailable");
  });

  it("accepts a slot exactly one buffer after the previous end", async () => {
    const s = await seedPublicStudio("buffer-edge", { buffer: 30 });
    expect((await book(s, at(8, 10))).result).toBe("created"); // 10:00-11:00
    const r = await book(s, at(8, 11, 30)); // touching the protected end
    expect(r.result).toBe("created");
  });
});

describe("the caller cannot request privileged behaviour", () => {
  it("exposes no parameter for duration, end time, status, practitioner or override", async () => {
    const args = await adminQuery(
      `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='create_public_appointment'`,
    );
    const sig = args.rows[0].args as string;
    for (const forbidden of [
      "duration",
      "ends_at",
      "status",
      "practitioner",
      "outside_availability",
      "capacity",
      "details",
    ]) {
      expect(sig, `signature must not accept ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("assigns the single active owner", async () => {
    const s = await seedPublicStudio("owner-assign");
    // A second, non-owner practitioner must never be chosen.
    const other = randomUUID();
    const otherUser = randomUUID();
    await adminQuery(`insert into auth.users (id,email) values ($1,$2)`, [
      otherUser,
      `other-${other.slice(0, 8)}@harness.local`,
    ]);
    await adminQuery(
      `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active)
       values ($1,$2,$3,'Member',$4,'practitioner',true)`,
      [other, s.studioId, otherUser, `other-${other.slice(0, 8)}@harness.local`],
    );
    const r = await book(s, at(9, 10));
    expect(r.result).toBe("created");
    expect(r.practitioner_id).toBe(s.ownerId);
  });

  // NOTE: a studio with no active owner is covered by the regression block
  // below — it must still BOOK (with a null practitioner), which is what the
  // pre-0170 route did. Refusing was a silent visitor-facing regression.
});

describe("atomicity", () => {
  it("a refused booking leaves NO appointment, NO audit row and NO reservation", async () => {
    const s = await seedPublicStudio("atomic");
    const before = await adminQuery(
      `select (select count(*) from public.appointments where studio_id=$1) a,
              (select count(*) from public.studio_calendar_reservations where studio_id=$1) r`,
      [s.studioId],
    );
    const r = await book(s, at(200, 10)); // outside horizon
    expect(r.result).toBe("outside_horizon");
    const after = await adminQuery(
      `select (select count(*) from public.appointments where studio_id=$1) a,
              (select count(*) from public.studio_calendar_reservations where studio_id=$1) r`,
      [s.studioId],
    );
    expect(after.rows[0].a).toBe(before.rows[0].a);
    expect(after.rows[0].r).toBe(before.rows[0].r);
  });

  it("every created appointment in these suites has exactly one audit row", async () => {
    const orphans = await adminQuery(
      `select count(*)::int n from public.appointments a
        where a.studio_id = any($1::uuid[])
          and (select count(*) from public.appointment_audit x where x.appointment_id = a.id) <> 1`,
      [[A.studioId, B.studioId]],
    );
    expect(orphans.rows[0].n).toBe(0);
  });

  it("a true overlap is refused by the pre-check before the GiST exclusion is reached", async () => {
    // NOTE the honest scope: the friendly pre-check fires FIRST, so this proves
    // the pre-check, not the 23P01 path. The exclusion constraint remains the
    // race-safe backstop for the interleaving no serial test can produce, and
    // the command deliberately installs no exception handler (pinned by the
    // migration structural test) so it must roll the transaction back.
    const s = await seedPublicStudio("gist", { buffer: 0 });
    expect((await book(s, at(10, 10))).result).toBe("created");
    // With buffer 0 the pre-check still rejects a true overlap first.
    const r = await book(s, at(10, 10));
    expect(r.result).toBe("time_unavailable");
  });
});

describe("privileges", () => {
  const SIG = "(uuid,uuid,uuid,timestamptz,text,text,text)";

  it("anon and authenticated cannot execute either function", async () => {
    const r = await adminQuery(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('create_public_appointment','validate_public_booking_slot')
        order by 1`,
    );
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) {
      expect(row.anon, `${row.proname} must not be anon-executable`).toBe(false);
      expect(row.auth, `${row.proname} must not be authenticated-executable`).toBe(false);
      expect(row.svc, `${row.proname} must be service_role-executable`).toBe(true);
    }
  });

  it("anon is refused at the privilege layer when it actually calls", async () => {
    await expect(
      asRole("anon", (q) =>
        q(`select * from public.create_public_appointment($1,$2,$3,now(),$4,null,null)`, [
          A.studioId,
          A.clientId,
          A.serviceId,
          hash64(),
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("authenticated is refused at the privilege layer when it actually calls", async () => {
    await expect(
      asRole("authenticated", (q) =>
        q(`select * from public.create_public_appointment($1,$2,$3,now(),$4,null,null)`, [
          A.studioId,
          A.clientId,
          A.serviceId,
          hash64(),
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("both functions are SECURITY DEFINER with an empty pinned search_path", async () => {
    const r = await adminQuery(
      `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('create_public_appointment','validate_public_booking_slot')`,
    );
    for (const row of r.rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.cfg).toBe('search_path=""');
    }
    expect(SIG).toContain("uuid");
  });

  it("THIS PR does not revoke any appointment table grant", async () => {
    const r = await adminQuery(
      `select r.rolname,
              has_table_privilege(r.oid,'public.appointments','INSERT') ins,
              has_table_privilege(r.oid,'public.appointments','UPDATE') upd,
              has_table_privilege(r.oid,'public.appointments','DELETE') del
         from pg_roles r where r.rolname in ('anon','authenticated') order by 1`,
    );
    // Deliberately still TRUE — the revocation is a LATER PR, after every
    // remaining appointment writer has migrated to a reviewed command.
    for (const row of r.rows) {
      expect(row.ins).toBe(true);
      expect(row.upd).toBe(true);
      expect(row.del).toBe(true);
    }
  });
});

describe("regressions from adversarial review", () => {
  it("P1: a practitioner-scoped availability row must NOT override the studio-wide window", async () => {
    // The public loader reads studio-wide rows ONLY
    // (lib/booking/studio-wide-availability.ts filters practitioner_id IS NULL).
    // A studio that ever ran practitioner capacity retains scoped rows, and both
    // rows can coexist. If the command preferred the scoped row it would refuse
    // every slot the page offers — permanently, for every visitor.
    const s = await seedPublicStudio("scoped-availability");
    const target = at(3, 10); // 10:00 UTC, studio-wide window is 00:00-23:59
    const dow = new Date(target).getUTCDay();
    // Model the real lifecycle: scoped rows can only be written while capacity
    // is ON (guard_availability_practitioner_scope, 0135), and they are RETAINED
    // when it is switched back OFF — which is precisely the state that made this
    // a live hazard.
    await adminQuery(
      `update public.studios set practitioner_capacity_enabled = true where id = $1`,
      [s.studioId],
    );
    await adminQuery(
      `insert into public.studio_availability_default
         (studio_id, day_of_week, is_open, open_time, close_time, practitioner_id)
       values ($1,$2,false,null,null,$3)`,
      [s.studioId, dow, s.ownerId],
    );
    await adminQuery(
      `update public.studios set practitioner_capacity_enabled = false where id = $1`,
      [s.studioId],
    );
    const r = await book(s, target);
    expect(
      r.result,
      "the studio-wide window must win — the loader never sees the scoped row",
    ).toBe("created");
  });

  it("P1: a scoped date OVERRIDE must not override the studio-wide window either", async () => {
    const s = await seedPublicStudio("scoped-override");
    const target = at(4, 10);
    await adminQuery(
      `update public.studios set practitioner_capacity_enabled = true where id = $1`,
      [s.studioId],
    );
    await adminQuery(
      `insert into public.studio_availability_overrides
         (studio_id, effective_date, is_open, practitioner_id)
       values ($1,$2::date,false,$3)`,
      [s.studioId, target.slice(0, 10), s.ownerId],
    );
    await adminQuery(
      `update public.studios set practitioner_capacity_enabled = false where id = $1`,
      [s.studioId],
    );
    const r = await book(s, target);
    expect(r.result).toBe("created");
  });

  it("preserves pre-0170 behaviour: a studio with no active owner can still book", async () => {
    // The old route inserted `practitioner_id: owner?.id ?? null` and SUCCEEDED.
    // Refusing here would take public booking down while the page still offers
    // slots, so a null practitioner must remain bookable.
    const s = await seedPublicStudio("no-active-owner");
    await adminQuery(`update public.practitioners set active = false where studio_id = $1`, [
      s.studioId,
    ]);
    const r = await book(s, at(5, 10));
    expect(r.result).toBe("created");
    expect(r.practitioner_id).toBeNull();
    const a = await adminQuery(
      `select practitioner_id, status from public.appointments where id = $1`,
      [r.appointment_id],
    );
    expect(a.rows[0].practitioner_id).toBeNull();
    expect(a.rows[0].status).toBe("confirmed");
  });

  it("enforces the window correctly in a NON-UTC timezone", async () => {
    // Coverage gap the review found: every other case here runs at UTC, so the
    // UTC -> local projection was never actually exercised.
    const s = await seedPublicStudio("toronto", { tz: "America/Toronto" });
    await adminQuery(
      `update public.studio_availability_default
          set open_time='09:00', close_time='17:00' where studio_id=$1`,
      [s.studioId],
    );
    // 14:00 UTC is 09:00/10:00 Toronto depending on DST — inside the window.
    const inside = await book(s, at(6, 14));
    expect(inside.result).toBe("created");
    // 04:00 UTC is 23:00/00:00 Toronto the previous day — outside it.
    const outside = await book(s, at(7, 4));
    expect(["outside_availability", "studio_closed"]).toContain(outside.result);
  });

  it("the trailing buffer may extend past closing time, as the loader allows", async () => {
    // lib/booking/slots.ts:324-327 fits `start + duration <= close` and lets the
    // trailing buffer spill past close. Checking ends_at + buffer would reject
    // the last slot of every day.
    const s = await seedPublicStudio("close-edge", { buffer: 30 });
    await adminQuery(
      `update public.studio_availability_default
          set open_time='09:00', close_time='17:00' where studio_id=$1`,
      [s.studioId],
    );
    const r = await book(s, at(8, 16)); // 16:00-17:00, buffer would reach 17:30
    expect(r.result).toBe("created");
  });
});

describe("practitioner attribution is resolved by the command, under the lock", () => {
  it("returns the owner active AT COMMAND TIME, not one resolved earlier", async () => {
    // The route used to pre-fetch "the current active owner" before the RPC and
    // then use that object for every notification. This proves the command's own
    // resolution is the authoritative one: change ownership after the point a
    // caller would have pre-fetched, and the command must still return the
    // practitioner it actually assigned.
    const s = await seedPublicStudio("owner-swap");
    const ownerA = s.ownerId;

    // Introduce owner B and retire owner A — exactly the window that produced
    // the stale-attribution defect.
    const bUser = randomUUID();
    const ownerB = randomUUID();
    const bEmail = `ownerb-${ownerB.slice(0, 8)}@harness.local`;
    await adminQuery(`insert into auth.users (id,email) values ($1,$2)`, [bUser, bEmail]);
    await adminQuery(
      `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active)
       values ($1,$2,$3,'Owner B',$4,'owner',true)`,
      [ownerB, s.studioId, bUser, bEmail],
    );
    await adminQuery(`update public.practitioners set active=false where id=$1`, [ownerA]);

    const r = await book(s, at(11, 10));
    expect(r.result).toBe("created");
    expect(r.practitioner_id, "must be the owner active at command time").toBe(ownerB);
    expect(r.practitioner_id).not.toBe(ownerA);

    const a = await adminQuery(
      `select practitioner_id from public.appointments where id=$1`,
      [r.appointment_id],
    );
    expect(a.rows[0].practitioner_id).toBe(ownerB);
  });

  it("returns a NULL practitioner when no active owner remains, and still books", async () => {
    const s = await seedPublicStudio("owner-gone");
    await adminQuery(`update public.practitioners set active=false where studio_id=$1`, [
      s.studioId,
    ]);
    const r = await book(s, at(12, 10));
    expect(r.result).toBe("created");
    expect(r.practitioner_id).toBeNull();
  });
});

describe("owner ambiguity — exactly one active owner, otherwise NULL", () => {
  // The schema does not guarantee one active owner per studio. An earlier
  // revision used `order by created_at asc limit 1`, silently inventing a
  // product rule ("the oldest active owner receives all public bookings") that
  // nothing declares and that would decide attribution, the notification
  // recipient and the client-facing name by row creation order. The pre-0170
  // route used `.maybeSingle()`, which errors on multiple rows and left the
  // practitioner null — i.e. it already treated ambiguity as "no practitioner".

  async function addOwner(studioId: string, label: string, createdAt?: string) {
    const id = randomUUID();
    const user = randomUUID();
    const email = `${label}-${id.slice(0, 8)}@harness.local`;
    await adminQuery(`insert into auth.users (id,email) values ($1,$2)`, [user, email]);
    await adminQuery(
      `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active,created_at)
       values ($1,$2,$3,$4,$5,'owner',true, coalesce($6::timestamptz, now()))`,
      [id, studioId, user, `Owner ${label}`, email, createdAt ?? null],
    );
    return id;
  }

  it("ZERO active owners -> books with a NULL practitioner", async () => {
    const s = await seedPublicStudio("owners-zero");
    await adminQuery(`update public.practitioners set active=false where studio_id=$1`, [
      s.studioId,
    ]);
    const r = await book(s, at(13, 10));
    expect(r.result).toBe("created");
    expect(r.practitioner_id).toBeNull();
  });

  it("EXACTLY ONE active owner -> assigns that owner", async () => {
    const s = await seedPublicStudio("owners-one");
    const r = await book(s, at(13, 12));
    expect(r.result).toBe("created");
    expect(r.practitioner_id).toBe(s.ownerId);
  });

  it("TWO active owners -> books with a NULL practitioner, never an arbitrary winner", async () => {
    const s = await seedPublicStudio("owners-two");
    const second = await addOwner(s.studioId, "second");
    const r = await book(s, at(13, 14));
    expect(r.result, "ambiguity must not fail the booking").toBe("created");
    expect(r.practitioner_id, "no owner may be arbitrarily chosen").toBeNull();
    expect(r.practitioner_id).not.toBe(s.ownerId);
    expect(r.practitioner_id).not.toBe(second);
  });

  it("created_at ordering does NOT decide the winner", async () => {
    // The defective rule was `order by created_at asc limit 1`. Seed a SECOND
    // owner that is deliberately OLDER than the first; the result must still be
    // null, not the older row.
    const s = await seedPublicStudio("owners-created-at");
    const older = await addOwner(s.studioId, "older", "2020-01-01T00:00:00Z");
    const r = await book(s, at(13, 16));
    expect(r.result).toBe("created");
    expect(r.practitioner_id, "the oldest owner must NOT win").toBeNull();
    expect(r.practitioner_id).not.toBe(older);
  });

  it("insertion order does NOT decide the winner", async () => {
    const s = await seedPublicStudio("owners-insert-order");
    const a = await addOwner(s.studioId, "a");
    const b = await addOwner(s.studioId, "b");
    const r = await book(s, at(13, 18));
    expect(r.practitioner_id).toBeNull();
    expect([s.ownerId, a, b]).not.toContain(r.practitioner_id);
  });

  it("deactivating back down to one owner restores assignment", async () => {
    const s = await seedPublicStudio("owners-back-to-one");
    const extra = await addOwner(s.studioId, "extra");
    expect((await book(s, at(14, 10))).practitioner_id).toBeNull();
    await adminQuery(`update public.practitioners set active=false where id=$1`, [extra]);
    const r = await book(s, at(14, 12));
    expect(r.practitioner_id).toBe(s.ownerId);
  });

  it("a non-owner practitioner never counts toward the owner set", async () => {
    const s = await seedPublicStudio("owners-with-member");
    const user = randomUUID();
    const member = randomUUID();
    const email = `member-${member.slice(0, 8)}@harness.local`;
    await adminQuery(`insert into auth.users (id,email) values ($1,$2)`, [user, email]);
    await adminQuery(
      `insert into public.practitioners (id,studio_id,user_id,display_name,email,role,active)
       values ($1,$2,$3,'Member',$4,'practitioner',true)`,
      [member, s.studioId, user, email],
    );
    const r = await book(s, at(14, 14));
    expect(r.practitioner_id, "one OWNER plus a member is still unambiguous").toBe(s.ownerId);
  });

  it("THREE active owners -> NULL (the bounded limit 2 still detects ambiguity)", async () => {
    // The resolution reads at most two rows, because the decision only
    // distinguishes zero / one / more-than-one. Three must behave like two.
    const s = await seedPublicStudio("owners-three");
    await addOwner(s.studioId, "b");
    await addOwner(s.studioId, "c");
    const r = await book(s, at(15, 10));
    expect(r.result).toBe("created");
    expect(r.practitioner_id).toBeNull();
  });
});

describe("precision — public booking accepts ONLY exact-millisecond instants", () => {
  // Postgres keeps microseconds; a browser ISO string never does. An earlier
  // revision TRUNCATED inside the membership comparison but then derived,
  // persisted and returned the RAW p_starts_at — so `...123999Z` matched the
  // legitimate `...123000Z` candidate and was stored as `...123999Z`, an instant
  // the browser never offered. Sub-millisecond input is now REJECTED.

  /** A real conflict-derived candidate carrying a non-zero millisecond fraction. */
  async function candidateWithFraction(label: string) {
    const s = await seedPublicStudio(label, { buffer: 30 });
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 6);
    const d = day.toISOString().slice(0, 10);
    // A timed block ending at a .123 boundary makes its raw end an offered start.
    await adminQuery(
      `insert into public.studio_timed_blocks (studio_id, starts_at, ends_at, category, practitioner_id)
       values ($1, ($2 || 'T11:00:00.000Z')::timestamptz, ($2 || 'T12:00:00.123Z')::timestamptz, 'admin', null)`,
      [s.studioId, d],
    );
    const cand = await adminQuery(
      `select c from public.public_booking_slot_candidates($1,$2::date,60) c
        where date_part('milliseconds', c) <> 0 order by c limit 1`,
      [s.studioId, d],
    );
    expect(cand.rowCount, "a fractional candidate must exist").toBe(1);
    return { s, candidate: new Date(cand.rows[0].c).toISOString() };
  }

  it("P4/P6: an exact-millisecond candidate with a real .123 fraction succeeds", async () => {
    const { s, candidate } = await candidateWithFraction("prec-ok");
    expect(candidate).toMatch(/\.\d{3}Z$/);
    const r = await book(s, candidate);
    expect(r.result).toBe("created");
    expect(new Date(r.starts_at).toISOString()).toBe(candidate);
    expect(new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()).toBe(60 * 60_000);
  });

  it("P5: the PERSISTED appointment and reservation carry zero microsecond remainder", async () => {
    const { s, candidate } = await candidateWithFraction("prec-persist");
    const r = await book(s, candidate);
    expect(r.result).toBe("created");
    const raw = await adminQuery(
      `select to_char(a.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') a_start,
              to_char(a.ends_at   at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') a_end,
              to_char(cr.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') r_start,
              to_char(cr.ends_at   at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') r_end
         from public.appointments a
         join public.studio_calendar_reservations cr on cr.source_id = a.id
        where a.id = $1`,
      [r.appointment_id],
    );
    const row = raw.rows[0];
    // Raw textual proof — Date.getTime() would truncate and hide microseconds.
    for (const [k, v] of Object.entries(row)) {
      expect(String(v).slice(-3), `${k} must have zero microsecond remainder`).toBe("000");
    }
    expect(row.a_start).toBe(row.r_start);
    expect(row.a_end).toBe(row.r_end);
    // And the persisted value equals the validated candidate exactly.
    expect(row.a_start).toBe(candidate.replace("Z", "000").replace(/\.(\d{3})000$/, ".$1000"));
  });

  it("P1/P8: a candidate plus 999 microseconds is REJECTED and persists nothing", async () => {
    const { s, candidate } = await candidateWithFraction("prec-999us");
    const before = await adminQuery(
      `select (select count(*) from public.appointments where studio_id=$1) a,
              (select count(*) from public.studio_calendar_reservations where studio_id=$1) r,
              (select count(*) from public.calendar_sync_outbox where studio_id=$1) o`,
      [s.studioId],
    );
    const r = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,
                 ($4::timestamptz + interval '999 microseconds'),$5,null,null)`,
      [s.studioId, s.clientId, s.serviceId, candidate, hash64()],
    );
    expect(r.rows[0].result).toBe("invalid_time");
    const after = await adminQuery(
      `select (select count(*) from public.appointments where studio_id=$1) a,
              (select count(*) from public.studio_calendar_reservations where studio_id=$1) r,
              (select count(*) from public.calendar_sync_outbox where studio_id=$1) o`,
      [s.studioId],
    );
    expect(after.rows[0].a).toBe(before.rows[0].a);
    expect(after.rows[0].r).toBe(before.rows[0].r);
    expect(after.rows[0].o).toBe(before.rows[0].o);
  });

  it("P7: a candidate plus ONE microsecond is REJECTED", async () => {
    const { s, candidate } = await candidateWithFraction("prec-1us");
    const r = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,
                 ($4::timestamptz + interval '1 microsecond'),$5,null,null)`,
      [s.studioId, s.clientId, s.serviceId, candidate, hash64()],
    );
    expect(r.rows[0].result).toBe("invalid_time");
  });

  it("P2: the VALIDATOR rejects a sub-millisecond start with invalid_time", async () => {
    const { s, candidate } = await candidateWithFraction("prec-val-start");
    const r = await adminQuery(
      `select public.validate_public_booking_slot($1,$2,$3,
                ($4::timestamptz + interval '456 microseconds'),
                ($4::timestamptz + interval '456 microseconds') + make_interval(mins => 60)) as v`,
      [s.studioId, s.ownerId, s.serviceId, candidate],
    );
    // Specifically invalid_time — NOT not_a_public_slot.
    expect(r.rows[0].v).toBe("invalid_time");
  });

  it("P3: the VALIDATOR rejects a sub-millisecond END with invalid_time", async () => {
    const { s, candidate } = await candidateWithFraction("prec-val-end");
    const r = await adminQuery(
      `select public.validate_public_booking_slot($1,$2,$3,$4::timestamptz,
                $4::timestamptz + make_interval(mins => 60) + interval '789 microseconds') as v`,
      [s.studioId, s.ownerId, s.serviceId, candidate],
    );
    expect(r.rows[0].v).toBe("invalid_time");
  });

  it("the token hash of a rejected submission is never consumed", async () => {
    const { s, candidate } = await candidateWithFraction("prec-token");
    const token = hash64();
    const rejected = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,
                 ($4::timestamptz + interval '500 microseconds'),$5,null,null)`,
      [s.studioId, s.clientId, s.serviceId, candidate, token],
    );
    expect(rejected.rows[0].result).toBe("invalid_time");
    const used = await adminQuery(
      `select count(*)::int n from public.appointments where cancellation_token_hash = $1`,
      [token],
    );
    expect(used.rows[0].n).toBe(0);
    // The same token still works on a legitimate submission.
    const ok = await adminQuery(
      `select * from public.create_public_appointment($1,$2,$3,$4::timestamptz,$5,null,null)`,
      [s.studioId, s.clientId, s.serviceId, candidate, token],
    );
    expect(ok.rows[0].result).toBe("created");
  });
});
