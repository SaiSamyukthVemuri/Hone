import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Owner switch for waitlist texts (0206 send_waitlist_invitation_sms). Synthetic data.

vi.mock("server-only", () => ({}));

const st = vi.hoisted(() => ({
  role: "owner" as string,
  studioId: "studio-A",
  updates: [] as Array<{ patch: Record<string, unknown>; id: unknown }>,
  error: null as { code?: string; message: string } | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { role: st.role }, studio: { id: st.studioId } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      expect(table).toBe("studios");
      return {
        update: (patch: Record<string, unknown>) => ({
          eq: async (_c: string, id: unknown) => {
            st.updates.push({ patch, id });
            return { error: st.error };
          },
        }),
      };
    },
  }),
}));

function form(v: string | null): FormData {
  const f = new FormData();
  if (v !== null) f.set("send_waitlist_invitation_sms", v);
  return f;
}

beforeEach(() => {
  st.role = "owner";
  st.studioId = "studio-A";
  st.updates.length = 0;
  st.error = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("setWaitlistTextsAction", () => {
  it("ON and OFF each write exactly the one column on the owner's own studio", async () => {
    const { setWaitlistTextsAction } = await import("@/app/(app)/settings/waitlist/texts-actions");
    expect(await setWaitlistTextsAction(form("true"))).toEqual({ ok: true });
    expect(await setWaitlistTextsAction(form("false"))).toEqual({ ok: true });
    expect(st.updates).toEqual([
      { patch: { send_waitlist_invitation_sms: true }, id: "studio-A" },
      { patch: { send_waitlist_invitation_sms: false }, id: "studio-A" },
    ]);
  });

  it("cross-studio: the studio id is the session's, never the form's", async () => {
    const { setWaitlistTextsAction } = await import("@/app/(app)/settings/waitlist/texts-actions");
    const f = form("true");
    f.set("studio_id", "studio-B");
    f.set("id", "studio-B");
    await setWaitlistTextsAction(f);
    expect(st.updates.map((u) => u.id)).toEqual(["studio-A"]);
  });

  it.each(["practitioner", "receptionist"])("%s is refused and nothing is written", async (role) => {
    const { setWaitlistTextsAction } = await import("@/app/(app)/settings/waitlist/texts-actions");
    st.role = role;
    expect((await setWaitlistTextsAction(form("true"))).ok).toBe(false);
    expect(st.updates).toEqual([]);
  });

  it.each([null, "", "on", "1", "TRUE", "yes"])("refuses %s instead of coercing", async (v) => {
    const { setWaitlistTextsAction } = await import("@/app/(app)/settings/waitlist/texts-actions");
    expect((await setWaitlistTextsAction(form(v))).ok).toBe(false);
    expect(st.updates).toEqual([]);
  });

  it("a database error is a fixed sentence", async () => {
    const { setWaitlistTextsAction } = await import("@/app/(app)/settings/waitlist/texts-actions");
    st.error = { code: "42501", message: "secret jane@example.test" };
    expect(await setWaitlistTextsAction(form("true"))).toEqual({
      ok: false,
      error: "Could not save settings. Please try again.",
    });
  });
});

describe("page wiring and independence", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("the page shows the stored value, defaulting to OFF when the column is absent", () => {
    const src = read("app/(app)/settings/waitlist/page.tsx");
    expect(src).toContain("<WaitlistTextsSetting initial={studio.send_waitlist_invitation_sms === true} />");
    expect(src).toContain('practitioner.role !== "owner"');
  });
  it("the action touches no consent, reminder or email column", () => {
    const src = read("app/(app)/settings/waitlist/texts-actions.ts");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const c of ["sms_consent", "send_24h", "send_2h", "send_intake", "send_confirmation", "postcare"]) {
      expect(code).not.toContain(c);
    }
  });
  it("the card says turning it on sends nothing by itself", () => {
    expect(read("components/waitlist/waitlist-texts-setting.tsx")).toContain("does not send anything by itself");
  });
});
