import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio, seedMember, type SeededStudio } from "./helpers/harness";

// Migration 0161 — reorder_studio_service / show_studio_service, against the
// REAL migrated database.
//
// THE DEFECT THIS PROVES FIXED. `services.sort_order` is `not null default 100`
// with no uniqueness and a per-modality allocator, so tied values are the normal
// state. The old action ordered by `sort_order` alone — a partial order Postgres
// resolves in HEAP order — then swapped two values with two untransacted
// UPDATEs. The row it moved was routinely not the row on screen, and when it
// resolved the clicked row to index 0 it silently did nothing, permanently.
//
// These tests seed the exact production shape (every service at 100) and prove:
// one call = one position, positions become unique and deterministic, hidden
// services never participate, ownership is enforced, concurrent moves cannot
// interleave, and a re-shown service cannot collide with the sequence.

let studio: SeededStudio;

const SERVICES = ["Client Consultation", "Electrolysis 30", "Electrolysis 60", "Laser 30"];

async function seedTiedServices(): Promise<string[]> {
  const ids: string[] = [];
  for (const name of SERVICES) {
    const r = await adminQuery(
      `insert into public.services
         (studio_id, name, default_duration_minutes, price_cents, active, modality, sort_order)
       values ($1,$2,30,10000,true,'electrolysis',100) returning id`,
      [studio.studioId, name],
    );
    ids.push(r.rows[0].id);
  }
  return ids;
}

async function orderedNames(): Promise<string[]> {
  const r = await adminQuery(
    `select name from public.services
      where studio_id = $1 and active
      order by sort_order asc, name asc, id asc`,
    [studio.studioId],
  );
  return r.rows.map((row: { name: string }) => row.name);
}

async function sortOrders(): Promise<number[]> {
  const r = await adminQuery(
    `select sort_order from public.services
      where studio_id = $1 and active
      order by sort_order asc, name asc, id asc`,
    [studio.studioId],
  );
  return r.rows.map((row: { sort_order: number }) => Number(row.sort_order));
}

async function move(
  serviceId: string,
  dir: "top" | "up" | "down" | "bottom",
  expectedPosition: number | null = null,
) {
  return asUser(studio.userId, (q) =>
    q(`select public.reorder_studio_service($1,$2,$3,$4) as ids`, [
      studio.studioId,
      serviceId,
      dir,
      expectedPosition,
    ]),
  );
}

beforeAll(async () => {
  studio = await seedStudio("svc-reorder");
  await adminQuery(`delete from public.services where studio_id = $1`, [studio.studioId]);
});

afterAll(async () => {
  await closePool();
});

describe("the legacy shape: every service tied at sort_order = 100", () => {
  let ids: string[];

  beforeAll(async () => {
    await adminQuery(`delete from public.services where studio_id = $1`, [studio.studioId]);
    ids = await seedTiedServices();
  });

  it("starts genuinely tied — this is the production state, not a contrivance", async () => {
    expect(await sortOrders()).toEqual([100, 100, 100, 100]);
  });

  it("ONE call moves the last service to the top", async () => {
    const laserIdx = SERVICES.indexOf("Laser 30");
    await move(ids[laserIdx], "top");
    expect((await orderedNames())[0]).toBe("Laser 30");
  });

  it("normalizes every visible service to unique 10, 20, 30 … positions", async () => {
    const orders = await sortOrders();
    expect(orders).toEqual([10, 20, 30, 40]);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("Client Consultation reaches the top and STAYS there (the reported failure)", async () => {
    const consultId = ids[SERVICES.indexOf("Client Consultation")];
    await move(consultId, "top");
    expect((await orderedNames())[0]).toBe("Client Consultation");
    // Tapping "up" again at the top is a stable no-op, not a silent corruption.
    await move(consultId, "up");
    expect((await orderedNames())[0]).toBe("Client Consultation");
    expect(await sortOrders()).toEqual([10, 20, 30, 40]);
  });

  it("first → bottom, then last → top, round-trips exactly", async () => {
    const before = await orderedNames();
    const firstId = (
      await adminQuery(
        `select id from public.services where studio_id=$1 and active
          order by sort_order asc, name asc, id asc limit 1`,
        [studio.studioId],
      )
    ).rows[0].id;
    await move(firstId, "bottom");
    const afterBottom = await orderedNames();
    expect(afterBottom[afterBottom.length - 1]).toBe(before[0]);
    await move(firstId, "top");
    expect(await orderedNames()).toEqual(before);
  });

  it("middle up / down each move exactly one position", async () => {
    const rows = (
      await adminQuery(
        `select id, name from public.services where studio_id=$1 and active
          order by sort_order asc, name asc, id asc`,
        [studio.studioId],
      )
    ).rows as Array<{ id: string; name: string }>;
    const target = rows[2];
    await move(target.id, "up");
    expect((await orderedNames())[1]).toBe(target.name);
    await move(target.id, "down");
    expect((await orderedNames())[2]).toBe(target.name);
  });
});

describe("hidden services never participate", () => {
  let ids: string[];

  beforeAll(async () => {
    await adminQuery(`delete from public.services where studio_id = $1`, [studio.studioId]);
    ids = await seedTiedServices();
    // Hide the third service, leaving it with the legacy 100.
    await adminQuery(`update public.services set active = false where id = $1`, [ids[2]]);
  });

  it("a hidden service is not renumbered and not in the visible order", async () => {
    await move(ids[0], "bottom");
    const names = await orderedNames();
    expect(names).not.toContain("Electrolysis 60");
    expect(names).toHaveLength(3);
    const hidden = await adminQuery(`select sort_order, active from public.services where id=$1`, [
      ids[2],
    ]);
    expect(Number(hidden.rows[0].sort_order)).toBe(100); // untouched
    expect(hidden.rows[0].active).toBe(false);
  });

  it("re-showing it re-slots at the END and renormalizes — no collision", async () => {
    await asUser(studio.userId, (q) =>
      q(`select public.show_studio_service($1,$2) as ids`, [studio.studioId, ids[2]]),
    );
    const orders = await sortOrders();
    expect(orders).toEqual([10, 20, 30, 40]);
    expect(new Set(orders).size).toBe(4);
    expect((await orderedNames())[3]).toBe("Electrolysis 60");
  });

  it("show is IDEMPOTENT: re-showing an ALREADY-visible service never moves it", async () => {
    // Reachable from an ordinary stale tab: the Show/Hide control bakes its
    // `active` value in at render time, so a second tab rendered while the
    // service was hidden still posts active=true after the first tab showed it.
    // Before the fix this bumped the service to max+10 and 'bottom'-normalized
    // it, silently sending a curated first service to the END of the menu.
    await move(ids[2], "top");
    const before = await orderedNames();
    expect(before[0]).toBe("Electrolysis 60");

    await asUser(studio.userId, (q) =>
      q(`select public.show_studio_service($1,$2) as ids`, [studio.studioId, ids[2]]),
    );
    expect(await orderedNames(), "a visibility toggle must never reorder the menu").toEqual(
      before,
    );
    expect(await sortOrders()).toEqual([10, 20, 30, 40]);

    // Repeating it is still a no-op.
    await asUser(studio.userId, (q) =>
      q(`select public.show_studio_service($1,$2) as ids`, [studio.studioId, ids[2]]),
    );
    expect(await orderedNames()).toEqual(before);
  });

  it("show still refuses a service from another studio", async () => {
    const other = await seedStudio("svc-show-other");
    await expect(
      asUser(studio.userId, (q) =>
        q(`select public.show_studio_service($1,$2)`, [studio.studioId, other.studioId]),
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("'none' normalizes without moving anything", async () => {
    const before = await orderedNames();
    await move(before.length > 0 ? ids[2] : ids[0], "none" as never);
    expect(await orderedNames()).toEqual(before);
    expect(await sortOrders()).toEqual([10, 20, 30, 40]);
  });
});

describe("authorization", () => {
  let ids: string[];
  let memberUserId: string;

  beforeAll(async () => {
    await adminQuery(`delete from public.services where studio_id = $1`, [studio.studioId]);
    ids = await seedTiedServices();
    const member = await seedMember(studio, "practitioner");
    memberUserId = member.userId;
  });

  it("a non-owner practitioner cannot reorder", async () => {
    await expect(
      asUser(memberUserId, (q) =>
        q(`select public.reorder_studio_service($1,$2,'top',null)`, [studio.studioId, ids[0]]),
      ),
    ).rejects.toThrow(/not authorized/i);
  });

  it("another studio's owner cannot reorder this studio's services", async () => {
    const other = await seedStudio("svc-reorder-other");
    await expect(
      asUser(other.userId, (q) =>
        q(`select public.reorder_studio_service($1,$2,'top',null)`, [studio.studioId, ids[0]]),
      ),
    ).rejects.toThrow(/not authorized/i);
    // And nothing moved.
    expect(await sortOrders()).toEqual([100, 100, 100, 100]);
  });

  it("an invalid direction is rejected", async () => {
    await expect(move(ids[0], "sideways" as never)).rejects.toThrow(/top, up, down, bottom/i);
  });
});

describe("concurrency + staleness", () => {
  let ids: string[];

  beforeAll(async () => {
    await adminQuery(`delete from public.services where studio_id = $1`, [studio.studioId]);
    ids = await seedTiedServices();
    await move(ids[0], "top"); // normalize
  });

  it("a stale expected_position is REFUSED rather than applied to the wrong row", async () => {
    const rows = (
      await adminQuery(
        `select id from public.services where studio_id=$1 and active
          order by sort_order asc, name asc, id asc`,
        [studio.studioId],
      )
    ).rows as Array<{ id: string }>;
    // Claim the LAST service sits at position 0 — the interleaved-tap scenario.
    await expect(move(rows[3].id, "up", 0)).rejects.toThrow(/changed elsewhere/i);
  });

  it("a CORRECT expected_position is accepted", async () => {
    const rows = (
      await adminQuery(
        `select id, name from public.services where studio_id=$1 and active
          order by sort_order asc, name asc, id asc`,
        [studio.studioId],
      )
    ).rows as Array<{ id: string; name: string }>;
    await move(rows[3].id, "up", 3);
    expect((await orderedNames())[2]).toBe(rows[3].name);
  });

  it("two sequential moves never produce a duplicate position", async () => {
    const rows = (
      await adminQuery(
        `select id from public.services where studio_id=$1 and active
          order by sort_order asc, name asc, id asc`,
        [studio.studioId],
      )
    ).rows as Array<{ id: string }>;
    await move(rows[0].id, "bottom");
    await move(rows[1].id, "top");
    const orders = await sortOrders();
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders).toEqual([10, 20, 30, 40]);
  });
});

describe("the widened calendar_color CHECK", () => {
  it("accepts every 0161 key AND every 0153 key", async () => {
    for (const key of [
      "amber",
      "emerald",
      "teal",
      "sky",
      "indigo",
      "violet",
      "orange",
      "lime",
      "fuchsia",
      "slate",
    ]) {
      const r = await adminQuery(
        `insert into public.services
           (studio_id, name, default_duration_minutes, active, modality, calendar_color)
         values ($1,$2,30,false,'electrolysis',$3) returning calendar_color`,
        [studio.studioId, `color-${key}`, key],
      );
      expect(r.rows[0].calendar_color).toBe(key);
    }
  });

  it("still REJECTS red, rose and pink — the reserved clinical signal", async () => {
    for (const banned of ["red", "rose", "pink", "blue", "cyan", "bg-red-500"]) {
      await expect(
        adminQuery(
          `insert into public.services
             (studio_id, name, default_duration_minutes, active, modality, calendar_color)
           values ($1,$2,30,false,'electrolysis',$3)`,
          [studio.studioId, `banned-${banned}`, banned],
        ),
        `${banned} must be rejected`,
      ).rejects.toThrow(/services_calendar_color_allowed/);
    }
  });

  it("the constraint is VALIDATED, not left NOT VALID", async () => {
    const r = await adminQuery(
      `select convalidated from pg_constraint
        where conrelid = 'public.services'::regclass
          and conname = 'services_calendar_color_allowed'`,
    );
    expect(r.rows[0].convalidated).toBe(true);
  });
});

describe("privileges", () => {
  it("anon cannot execute either RPC; authenticated can", async () => {
    const r = await adminQuery(
      `select has_function_privilege('anon','public.reorder_studio_service(uuid,uuid,text,integer)','execute') as anon_reorder,
              has_function_privilege('authenticated','public.reorder_studio_service(uuid,uuid,text,integer)','execute') as auth_reorder,
              has_function_privilege('anon','public.show_studio_service(uuid,uuid)','execute') as anon_show,
              has_function_privilege('authenticated','public.show_studio_service(uuid,uuid)','execute') as auth_show`,
    );
    expect(r.rows[0]).toEqual({
      anon_reorder: false,
      auth_reorder: true,
      anon_show: false,
      auth_show: true,
    });
  });

  it("both functions are SECURITY DEFINER with a pinned search_path", async () => {
    const r = await adminQuery(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public'
          and p.proname in ('reorder_studio_service','show_studio_service')
        order by 1`,
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows as Array<{ prosecdef: boolean; proconfig: string[] | null }>) {
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig?.join(",")).toMatch(/search_path=pg_catalog,\s*pg_temp/);
    }
  });
});
