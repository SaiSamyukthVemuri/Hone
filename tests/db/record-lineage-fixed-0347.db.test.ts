import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedSession, seedStudio, userQuery, type SeededStudio } from "./helpers/harness";

// 0347: a record keeps the client and studio it was created for. Synthetic placeholder values only.

let A: SeededStudio;
let B: SeededStudio;
let sessionA: string;
let dualUser: string; // an active practitioner of BOTH studios

const REFUSED = /cannot be re-assigned/i;

type Spec = { table: string; seed: (id: string, clientId: string) => Promise<void> };
const specs: Spec[] = [
  {
    table: "client_personal_notes",
    seed: async (id, clientId) => {
      await adminQuery(`insert into public.client_personal_notes (id, client_id, studio_id, personal_notes) values ($1,$2,$3,'synthetic')`, [id, clientId, A.studioId]);
    },
  },
  {
    table: "treatment_goals",
    seed: async (id, clientId) => {
      await adminQuery(`insert into public.treatment_goals (id, client_id, studio_id, estimated_total_minutes) values ($1,$2,$3,60)`, [id, clientId, A.studioId]);
    },
  },
  {
    table: "client_tags",
    seed: async (id, clientId) => {
      await adminQuery(`insert into public.client_tags (id, studio_id, client_id, label) values ($1,$2,$3,'synthetic')`, [id, A.studioId, clientId]);
    },
  },
  {
    table: "photos",
    seed: async (id, clientId) => {
      await adminQuery(`insert into public.photos (id, studio_id, client_id, session_id, storage_path) values ($1,$2,$3,$4,'synthetic/path')`, [id, A.studioId, clientId, sessionA]);
    },
  },
];

const newClient = async (studioId = A.studioId): Promise<string> => {
  const id = randomUUID();
  await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Synthetic client')`, [id, studioId]);
  return id;
};
const row = async (table: string, id: string) => (await adminQuery(`select * from public.${table} where id = $1`, [id])).rows[0];

beforeAll(async () => {
  A = await seedStudio("l0347-a");
  B = await seedStudio("l0347-b");
  sessionA = (await seedSession(A)).sessionId;
  dualUser = randomUUID();
  const email = `dual-${dualUser.slice(0, 8)}@harness.local`;
  await adminQuery(`insert into auth.users (id, email) values ($1,$2)`, [dualUser, email]);
  for (const s of [A, B]) {
    await adminQuery(
      `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values ($1,$2,$3,'Dual',$4,'practitioner',true)`,
      [randomUUID(), s.studioId, dualUser, email],
    );
  }
});
afterAll(async () => {
  await closePool();
});

for (const spec of specs) {
  describe(`0347 ${spec.table}: the client and studio are fixed once the row exists`, () => {
    it("a member cannot re-point the row to another client of the same studio; the row is unchanged", async () => {
      const id = randomUUID();
      await spec.seed(id, await newClient());
      const before = await row(spec.table, id);
      await expect(userQuery(A.userId, `update public.${spec.table} set client_id = $2 where id = $1`, [id, await newClient()])).rejects.toThrow(REFUSED);
      expect(await row(spec.table, id)).toEqual(before);
    });

    it("a member of two studios cannot move the row to the other studio", async () => {
      const id = randomUUID();
      await spec.seed(id, await newClient());
      await expect(userQuery(dualUser, `update public.${spec.table} set studio_id = $2 where id = $1`, [id, B.studioId])).rejects.toThrow(REFUSED);
      expect((await row(spec.table, id)).studio_id).toBe(A.studioId);
    });

    it("service_role is refused as well (row-level security is not what stops it)", async () => {
      const id = randomUUID();
      const owned = await newClient();
      await spec.seed(id, owned);
      const target = await newClient();
      await expect(
        asRole("service_role", (q) => q(`update public.${spec.table} set client_id = $2 where id = $1`, [id, target])),
      ).rejects.toThrow(REFUSED);
      await expect(
        asRole("service_role", (q) => q(`update public.${spec.table} set studio_id = $2 where id = $1`, [id, B.studioId])),
      ).rejects.toThrow(REFUSED);
      const r = await row(spec.table, id);
      expect(r.client_id).toBe(owned);
      expect(r.studio_id).toBe(A.studioId);
    });

    it("an update that re-writes the same client and studio is allowed (the upsert shape)", async () => {
      const id = randomUUID();
      await spec.seed(id, await newClient());
      const r = await userQuery(A.userId, `update public.${spec.table} set client_id = client_id, studio_id = studio_id where id = $1 returning id`, [id]);
      expect(r.rowCount).toBe(1);
    });
  });
}

describe("0347: the real writers still work", () => {
  it("the personal-notes upsert (on conflict client_id) updates in place", async () => {
    const c = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Upsert client')`, [c, A.studioId]);
    const up = (text: string) =>
      userQuery(
        A.userId,
        `insert into public.client_personal_notes (client_id, studio_id, personal_notes) values ($1,$2,$3)
         on conflict (client_id) do update set client_id = excluded.client_id, studio_id = excluded.studio_id, personal_notes = excluded.personal_notes`,
        [c, A.studioId, text],
      );
    await up("first");
    await up("second");
    const r = (await adminQuery(`select personal_notes, studio_id from public.client_personal_notes where client_id = $1`, [c])).rows;
    expect(r).toEqual([{ personal_notes: "second", studio_id: A.studioId }]);
  });

  it("the goals upsert (on conflict client_id) updates in place", async () => {
    const c = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Upsert client')`, [c, A.studioId]);
    const up = (minutes: number) =>
      userQuery(
        A.userId,
        `insert into public.treatment_goals (client_id, studio_id, estimated_total_minutes) values ($1,$2,$3)
         on conflict (client_id) do update set client_id = excluded.client_id, studio_id = excluded.studio_id, estimated_total_minutes = excluded.estimated_total_minutes`,
        [c, A.studioId, minutes],
      );
    await up(60);
    await up(90);
    expect((await adminQuery(`select estimated_total_minutes from public.treatment_goals where client_id = $1`, [c])).rows).toEqual([{ estimated_total_minutes: 90 }]);
  });

  it("a tag can be added and soft-deleted", async () => {
    const id = randomUUID();
    await userQuery(A.userId, `insert into public.client_tags (id, studio_id, client_id, label) values ($1,$2,$3,'t')`, [id, A.studioId, A.clientId]);
    const r = await userQuery(A.userId, `update public.client_tags set deleted_at = now(), deleted_by = $2 where id = $1 and studio_id = $3 and client_id = $4 and deleted_at is null returning id`, [id, A.practitionerId, A.studioId, A.clientId]);
    expect(r.rowCount).toBe(1);
  });

  it("a photo can be added for a client and a session of the studio", async () => {
    const id = randomUUID();
    await userQuery(A.userId, `insert into public.photos (id, studio_id, client_id, session_id, storage_path) values ($1,$2,$3,$4,'p')`, [id, A.studioId, A.clientId, sessionA]);
    expect((await row("photos", id)).session_id).toBe(sessionA);
  });

  it("the insert-time studio derivation of personal notes is unchanged", async () => {
    const c = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1,$2,'Derive client')`, [c, A.studioId]);
    await adminQuery(`insert into public.client_personal_notes (client_id, studio_id, personal_notes) values ($1,$2,'x')`, [c, B.studioId]);
    expect((await adminQuery(`select studio_id from public.client_personal_notes where client_id = $1`, [c])).rows[0].studio_id).toBe(A.studioId);
  });
});

describe("0347 photos: the session link may be cleared, never re-pointed", () => {
  it("clearing session_id by UPDATE is allowed", async () => {
    const id = randomUUID();
    await specs[3].seed(id, await newClient());
    await userQuery(A.userId, `update public.photos set session_id = null where id = $1`, [id]);
    expect((await row("photos", id)).session_id).toBeNull();
  });

  it("re-pointing session_id to another session is refused, for a member and for service_role", async () => {
    const id = randomUUID();
    await specs[3].seed(id, await newClient());
    const other = (await seedSession(A)).sessionId;
    await expect(userQuery(A.userId, `update public.photos set session_id = $2 where id = $1`, [id, other])).rejects.toThrow(REFUSED);
    await expect(asRole("service_role", (q) => q(`update public.photos set session_id = $2 where id = $1`, [id, other]))).rejects.toThrow(REFUSED);
    expect((await row("photos", id)).session_id).toBe(sessionA);
  });

  it("deleting the session still sets session_id to null (the ON DELETE SET NULL cascade is not refused)", async () => {
    const own = (await seedSession(A)).sessionId;
    const id = randomUUID();
    await adminQuery(`insert into public.photos (id, studio_id, client_id, session_id, storage_path) values ($1,$2,$3,$4,'p')`, [id, A.studioId, A.clientId, own]);
    await adminQuery(`delete from public.sessions where id = $1`, [own]);
    const r = await row("photos", id);
    expect(r).toBeDefined();
    expect(r.session_id).toBeNull();
  });
});

describe("0347: census", () => {
  it("exactly the five triggers exist, enabled, row-level BEFORE UPDATE, on the expected columns, with the 0160 functions", async () => {
    const r = (
      await adminQuery(
        `select c.relname as tbl, t.tgname as trg, t.tgenabled as enabled, (t.tgtype & 19) as kind, t.tgfoid::regproc::text as fn,
                (select array_agg(a.attname::text order by a.attname::text) from pg_attribute a where a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])) as cols
           from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where not t.tgisinternal and t.tgname like '%\\_lineage\\_%'
            and c.relname in ('client_personal_notes','treatment_goals','client_tags','photos')
          order by t.tgname`,
      )
    ).rows;
    const imm = "guard_immutable_clinical_lineage";
    expect(r.map((x) => [x.tbl, x.trg, x.enabled, x.kind, x.fn.replace(/^public\./, ""), x.cols])).toEqual([
      ["client_personal_notes", "client_personal_notes_lineage_fixed", "O", 19, imm, ["client_id", "studio_id"]],
      ["client_tags", "client_tags_lineage_fixed", "O", 19, imm, ["client_id", "studio_id"]],
      ["photos", "photos_lineage_fixed", "O", 19, imm, ["client_id", "studio_id"]],
      ["photos", "photos_session_lineage_clearable", "O", 19, "guard_clearable_clinical_lineage", ["session_id"]],
      ["treatment_goals", "treatment_goals_lineage_fixed", "O", 19, imm, ["client_id", "studio_id"]],
    ]);
  });
});
