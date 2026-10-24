import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  adminQuery,
  asRole,
  asUser,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "@/tests/db/helpers/harness";

// HON-50 PR B. Behaviour of the studio arrival-instructions and
// address-visibility migration against a real database (CI DB lane; this file
// runs only once the numbered migration exists). Its source contract is
// tests/migrations/<NNNN>-studio-arrival-and-address-visibility.test.ts.
// All data is synthetic.

async function location(studioId: string) {
  const { rows } = await adminQuery(
    `select address_visibility, arrival_instructions from public.studios where id = $1`,
    [studioId],
  );
  return rows[0] as { address_visibility: string; arrival_instructions: string | null };
}

const pgCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  }
};

describe("defaults keep today's behaviour", () => {
  it("a studio inserted without the new fields reads visibility 'both' and no instructions", async () => {
    const id = randomUUID();
    await adminQuery(
      `insert into public.studios (id, name, owner_email) values ($1, $2, $3)`,
      [id, "Bare HON-50", `bare-${id.slice(0, 8)}@harness.local`],
    );
    expect(await location(id)).toEqual({ address_visibility: "both", arrival_instructions: null });
  });

  it("the column default is exactly 'both' and the column is NOT NULL", async () => {
    const { rows } = await adminQuery(
      `select column_default, is_nullable, data_type
         from information_schema.columns
        where table_schema = 'public' and table_name = 'studios'
          and column_name = 'address_visibility'`,
    );
    expect(rows[0]).toEqual({ column_default: "'both'::text", is_nullable: "NO", data_type: "text" });
  });
});

describe("the CHECKs", () => {
  let studio: SeededStudio;
  beforeAll(async () => {
    studio = await seedStudio("hon50-checks");
  });

  it.each(["booking_page", "emails", "both"])("accepts visibility %s", async (v) => {
    await adminQuery(`update public.studios set address_visibility = $2 where id = $1`, [studio.studioId, v]);
    expect((await location(studio.studioId)).address_visibility).toBe(v);
  });

  it("refuses a visibility outside the closed set (23514)", async () => {
    expect(
      await pgCode(adminQuery(`update public.studios set address_visibility = 'public' where id = $1`, [studio.studioId])),
    ).toBe("23514");
  });

  it("refuses NULL visibility (23502)", async () => {
    expect(
      await pgCode(adminQuery(`update public.studios set address_visibility = null where id = $1`, [studio.studioId])),
    ).toBe("23502");
  });

  it.each(["", "   ", "\n\t"])("refuses blank instructions %j (23514): NULL is the only 'none'", async (v) => {
    expect(
      await pgCode(adminQuery(`update public.studios set arrival_instructions = $2 where id = $1`, [studio.studioId, v])),
    ).toBe("23514");
  });

  it("accepts 1000 characters and refuses 1001 (23514)", async () => {
    await adminQuery(`update public.studios set arrival_instructions = $2 where id = $1`, [studio.studioId, "x".repeat(1000)]);
    expect((await location(studio.studioId)).arrival_instructions).toHaveLength(1000);
    expect(
      await pgCode(
        adminQuery(`update public.studios set arrival_instructions = $2 where id = $1`, [studio.studioId, "x".repeat(1001)]),
      ),
    ).toBe("23514");
  });
});

describe("who can read and write (RLS from 0001, unchanged)", () => {
  let studio: SeededStudio;
  let member: { userId: string };
  let other: SeededStudio;
  beforeAll(async () => {
    studio = await seedStudio("hon50-rls");
    member = await seedMember(studio, "hon50-member");
    other = await seedStudio("hon50-other");
  });

  it("the owner can set both fields through the owner update policy", async () => {
    await asUser(studio.userId, (q) =>
      q(`update public.studios set address_visibility = 'emails', arrival_instructions = 'Side door.' where id = $1`, [
        studio.studioId,
      ]),
    );
    expect(await location(studio.studioId)).toEqual({ address_visibility: "emails", arrival_instructions: "Side door." });
  });

  it("a non-owner member can read them but their update changes nothing", async () => {
    const read = await asUser(member.userId, (q) =>
      q(`select address_visibility from public.studios where id = $1`, [studio.studioId]),
    );
    expect(read.rows).toEqual([{ address_visibility: "emails" }]);
    const res = await asUser(member.userId, (q) =>
      q(`update public.studios set address_visibility = 'both' where id = $1`, [studio.studioId]),
    );
    expect(res.rowCount).toBe(0);
    expect((await location(studio.studioId)).address_visibility).toBe("emails");
  });

  it("another studio's owner can neither read nor change them", async () => {
    const read = await asUser(other.userId, (q) =>
      q(`select address_visibility from public.studios where id = $1`, [studio.studioId]),
    );
    expect(read.rows).toEqual([]);
    const res = await asUser(other.userId, (q) =>
      q(`update public.studios set arrival_instructions = 'x' where id = $1`, [studio.studioId]),
    );
    expect(res.rowCount).toBe(0);
  });

  it("anon reads no studio row at all", async () => {
    const res = await asRole("anon", (q) =>
      q(`select address, address_visibility from public.studios where id = $1`, [studio.studioId]).catch(
        (e: { code?: string }) => ({ rows: [], code: e.code }),
      ),
    );
    expect(res.rows).toEqual([]);
  });

  it("an owner's location update leaves new-client admission untouched (0204 guard unaffected)", async () => {
    const before = await adminQuery(`select new_client_admission_mode from public.studios where id = $1`, [studio.studioId]);
    await asUser(studio.userId, (q) =>
      q(`update public.studios set address_visibility = 'booking_page' where id = $1`, [studio.studioId]),
    );
    const after = await adminQuery(`select new_client_admission_mode from public.studios where id = $1`, [studio.studioId]);
    expect(after.rows).toEqual(before.rows);
  });
});
