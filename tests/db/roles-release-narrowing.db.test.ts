import { afterAll, describe, expect, it } from "vitest";
import { adminTx, asUser, closePool, seedMember, seedStudio } from "./helpers/harness";

// The page copy says: a choice that LOWERS access applies at once when its key is released; a choice that RAISES access waits for the owner's
// activation. This pins that against the real 0287 engine on synthetic data. Each case runs in ONE transaction that is rolled back, because
// releasing a key is operator-only and must never persist on the shared stack.
afterAll(async () => {
  await closePool();
});

class Rollback extends Error {}
type Q = (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

async function scenario(opts: { role: "practitioner" | "receptionist"; key: string; choose: string; kind: "narrow" | "full"; activate: boolean }) {
  const s = await seedStudio(`rel-${opts.role}-${opts.key}-${opts.choose}-${opts.kind}`.slice(0, 40));
  const prac = await seedMember(s, "rel-prac");
  const out = { snapshot: "", base0: "", afterRelease: "", afterActivation: "" };
  const base = async (q: Q) => (await q(`select public.perm_base_scope($1, $2, $3) as s`, [s.studioId, opts.role, opts.key])).rows[0].s as string;
  try {
    await adminTx(async (q: Q) => {
      out.snapshot = (await q(`select ${opts.role === "practitioner" ? "snapshot_practitioner" : "snapshot_receptionist"} as s from public.permission_catalog where key = $1`, [opts.key])).rows[0].s as string;
      // basis existing_snapshot, so the base is exactly the snapshot before release and the stored choice is the owner's only
      await q(`update public.studio_permission_policy set basis = 'existing_snapshot' where studio_id = $1`, [s.studioId]);
      await q(`insert into public.studio_role_permissions (studio_id, role, key, scope, set_at) values ($1, $2, $3, $4, now() - interval '1 day')`, [s.studioId, opts.role, opts.key, opts.choose]);
      // the choice pre-dates the release (set_at one day back)
      out.base0 = await base(q);
      await q(`select public.mark_permissions_released(array[$1::text], 'T-rel', $2)`, [opts.key, opts.kind]);
      out.afterRelease = await base(q);
      if (opts.activate) {
        await q("set local role authenticated");
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: s.userId, role: "authenticated" })]);
        const prev = (await q(`select public.preview_activation($1, array[$2::text]) as r`, [s.studioId, opts.key])).rows[0].r as { preview_hash: string; version: number };
        await q(`select public.activate_released_permissions($1, array[$2::text], $3, $4, $5, true)`, [s.studioId, opts.key, prev.version, "Activating this key in a test", prev.preview_hash]);
        await q("reset role");
        out.afterActivation = await base(q);
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  void prac;
  void asUser;
  return out;
}

describe("a stored choice at release: lowering applies at once, raising waits for activation", () => {
  it("appt.cancel practitioner: snapshot is studio; a stored Off applies at release on a full release, with no activation", async () => {
    const r = await scenario({ role: "practitioner", key: "appt.cancel", choose: "off", kind: "full", activate: false });
    expect(r.snapshot).toBe("studio");
    expect(r.base0).toBe("studio"); // before release: nothing changes
    expect(r.afterRelease).toBe("off"); // the lowering applies at once
  });

  it("the same on a narrow release", async () => {
    const r = await scenario({ role: "practitioner", key: "appt.cancel", choose: "off", kind: "narrow", activate: false });
    expect(r.afterRelease).toBe("off");
  });

  it("a stored 'own' (lower than studio) also applies at release", async () => {
    const r = await scenario({ role: "practitioner", key: "appt.cancel", choose: "own", kind: "full", activate: false });
    expect(r.afterRelease).toBe("own");
  });

  it("raising: appt.book receptionist, snapshot off, stored studio: stays at the snapshot after a FULL release until activation, then applies", async () => {
    const r = await scenario({ role: "receptionist", key: "appt.book", choose: "studio", kind: "full", activate: true });
    expect(r.snapshot).toBe("off");
    expect(r.afterRelease).toBe("off"); // a widening waits
    expect(r.afterActivation).toBe("studio");
  });

  it("raising on a NARROW release stays at the snapshot even after activation (it waits for a later full release)", async () => {
    const r = await scenario({ role: "receptionist", key: "appt.book", choose: "studio", kind: "narrow", activate: false });
    expect(r.afterRelease).toBe("off");
  });
});
