import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseClientSelfServiceForm } from "@/lib/booking/client-self-service-form";
import { clientSelfServicePolicyFromStudio } from "@/lib/booking/client-self-service-policy";

// HON-47 owner setting for client self-service (0234 columns). Synthetic data.

vi.mock("server-only", () => ({}));

const st = vi.hoisted(() => ({
  role: "owner" as string,
  studioId: "studio-A",
  // 0252: extra keys on the loaded studio row (the column is present only after apply).
  studioExtra: {} as Record<string, unknown>,
  updates: [] as Array<{ patch: Record<string, unknown>; id: unknown }>,
  error: null as { code?: string; message: string } | null,
  revalidated: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => st.revalidated.push(p) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: st.role },
    studio: { id: st.studioId, ...st.studioExtra },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      expect(table).toBe("studios");
      return {
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: unknown) => {
            st.updates.push({ patch, id });
            return { error: st.error };
          },
        }),
      };
    },
  }),
}));

function form(c: string | null, r: string | null): FormData {
  const f = new FormData();
  if (c !== null) f.set("client_cancellation_enabled", c);
  if (r !== null) f.set("client_reschedule_enabled", r);
  return f;
}

beforeEach(() => {
  st.role = "owner";
  st.studioId = "studio-A";
  st.studioExtra = {};
  st.updates.length = 0;
  st.error = null;
  st.revalidated.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("parseClientSelfServiceForm", () => {
  it("accepts only literal true/false for BOTH keys", () => {
    expect(parseClientSelfServiceForm(form("true", "false"))).toEqual({ cancellation: true, reschedule: false });
    expect(parseClientSelfServiceForm(form("false", "false"))).toEqual({ cancellation: false, reschedule: false });
  });
  it.each([
    [null, "true"],
    ["true", null],
    ["on", "true"],
    ["1", "false"],
    ["", "true"],
    ["TRUE", "true"],
  ])("refuses %s / %s instead of coercing", (c, r) => {
    expect(parseClientSelfServiceForm(form(c, r))).toBeNull();
  });
});

describe("setClientSelfServiceAction", () => {
  it("OFF state: an owner writes exactly the two flags on their own studio", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    const res = await setClientSelfServiceAction(form("false", "false"));
    expect(res).toEqual({ ok: true });
    expect(st.updates).toEqual([
      { patch: { client_cancellation_enabled: false, client_reschedule_enabled: false }, id: "studio-A" },
    ]);
  });

  it("ON state round-trips and touches no other column", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    await setClientSelfServiceAction(form("true", "true"));
    expect(Object.keys(st.updates[0].patch).sort()).toEqual([
      "client_cancellation_enabled",
      "client_reschedule_enabled",
    ]);
  });

  it("cross-studio: the studio id comes from the session, never from the form", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    const f = form("false", "true");
    f.set("studio_id", "studio-B");
    f.set("id", "studio-B");
    st.studioId = "studio-A";
    await setClientSelfServiceAction(f);
    expect(st.updates.map((u) => u.id)).toEqual(["studio-A"]);
  });

  it.each(["practitioner", "receptionist"])("%s is refused and nothing is written", async (role) => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    st.role = role;
    const res = await setClientSelfServiceAction(form("false", "false"));
    expect(res.ok).toBe(false);
    expect(st.updates).toEqual([]);
  });

  it("a malformed submission writes nothing", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    expect((await setClientSelfServiceAction(form("false", null))).ok).toBe(false);
    expect(st.updates).toEqual([]);
  });

  it("a database error is a fixed sentence, not the database message", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    st.error = { code: "42501", message: "secret detail jane@example.test" };
    const res = await setClientSelfServiceAction(form("false", "true"));
    expect(res).toEqual({ ok: false, error: "Could not save settings. Please try again." });
  });
});

function formWithPortal(portal: string): FormData {
  const f = form("true", "true");
  f.set("client_portal_enabled", portal);
  return f;
}

describe("0252 portal switch: parser", () => {
  it("an absent portal key means 'leave it alone', never 'off'", () => {
    expect(parseClientSelfServiceForm(form("true", "false"))).toEqual({ cancellation: true, reschedule: false });
  });
  it("a present portal key must be exactly true or false", () => {
    expect(parseClientSelfServiceForm(formWithPortal("false"))).toEqual({ cancellation: true, reschedule: true, portal: false });
    expect(parseClientSelfServiceForm(formWithPortal("true"))).toEqual({ cancellation: true, reschedule: true, portal: true });
    for (const bad of ["on", "1", "", "FALSE", "off"]) {
      expect(parseClientSelfServiceForm(formWithPortal(bad)), bad).toBeNull();
    }
  });
});

describe("0252 portal switch: action", () => {
  it("before 0252 is applied (no column on the row) a submission without the portal key writes exactly the two older flags", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    const res = await setClientSelfServiceAction(form("false", "true"));
    expect(res.ok).toBe(true);
    expect(st.updates).toHaveLength(1);
    expect(Object.keys(st.updates[0].patch).sort()).toEqual(["client_cancellation_enabled", "client_reschedule_enabled"]);
  });
  it("before 0252 is applied a submission that names the portal key is refused whole: nothing is written", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    const res = await setClientSelfServiceAction(formWithPortal("false"));
    expect(res).toEqual({ ok: false, error: "The client portal switch is not available yet." });
    expect(st.updates).toHaveLength(0);
    expect(st.revalidated).toHaveLength(0);
  });
  it("a non-boolean column value is treated as absent (never written)", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    st.studioExtra = { client_portal_enabled: null };
    expect((await setClientSelfServiceAction(formWithPortal("false"))).ok).toBe(false);
    expect(st.updates).toHaveLength(0);
  });
  it("after 0252 (column present) the owner's portal value is written with the other two, on the caller's studio only", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    st.studioExtra = { client_portal_enabled: true };
    const res = await setClientSelfServiceAction(formWithPortal("false"));
    expect(res.ok).toBe(true);
    expect(st.updates).toEqual([
      { patch: { client_cancellation_enabled: true, client_reschedule_enabled: true, client_portal_enabled: false }, id: "studio-A" },
    ]);
  });
  it("after 0252 a submission WITHOUT the portal key still leaves the portal column alone", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    st.studioExtra = { client_portal_enabled: false };
    await setClientSelfServiceAction(form("true", "true"));
    expect(Object.keys(st.updates[0].patch)).not.toContain("client_portal_enabled");
  });
  it("a non-owner is refused even with the column present", async () => {
    const { setClientSelfServiceAction } = await import("@/app/(app)/settings/studio/actions");
    st.role = "practitioner";
    st.studioExtra = { client_portal_enabled: true };
    expect((await setClientSelfServiceAction(formWithPortal("false"))).ok).toBe(false);
    expect(st.updates).toHaveLength(0);
  });
});

describe("0252 portal switch: what the copy may claim", () => {
  it("the staff and switch wording never claims portal links are withdrawn from every email (that needs 0247's snapshot change)", async () => {
    const { PORTAL_OFF_STAFF_MESSAGE } = await import("@/lib/booking/client-self-service-policy");
    const form = readFileSync("app/(app)/settings/studio/ClientSelfServiceForm.tsx", "utf8");
    for (const text of [PORTAL_OFF_STAFF_MESSAGE, form]) {
      expect(text).not.toMatch(/no portal links are sent|withdrawn from|removed from (every|all) email|links? (are|is) (removed|withdrawn)/i);
    }
    expect(PORTAL_OFF_STAFF_MESSAGE).toMatch(/Clients cannot sign in to the portal/);
  });
  it("the switch row renders only when the studio row carries the column", () => {
    const f = readFileSync("app/(app)/settings/studio/ClientSelfServiceForm.tsx", "utf8");
    const page = readFileSync("app/(app)/settings/studio/page.tsx", "utf8");
    expect(f).toContain("portalSwitchAvailable ? [...ROWS, PORTAL_ROW] : ROWS");
    expect(f).toContain('if (portalSwitchAvailable) fd.set("client_portal_enabled"');
    expect(page).toContain('portalSwitchAvailable={typeof studio.client_portal_enabled === "boolean"}');
  });
});

describe("policy defaults and independence", () => {
  it("absent or null columns mean ON (today's behaviour)", () => {
    expect(clientSelfServicePolicyFromStudio({})).toMatchObject({ cancellation: true, reschedule: true });
    expect(clientSelfServicePolicyFromStudio(null)).toMatchObject({ cancellation: true, reschedule: true });
  });
  it("each flag is independent", () => {
    expect(clientSelfServicePolicyFromStudio({ client_cancellation_enabled: false })).toMatchObject({
      cancellation: false,
      reschedule: true,
    });
  });
});

describe("reminders and postcare are independent of the setting", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("the setting action never writes a reminder, postcare or notification column", () => {
    const src = read("app/(app)/settings/studio/actions.ts");
    const body = src.slice(src.indexOf("export async function setClientSelfServiceAction"), src.indexOf("updateStudioPostcareAction"));
    for (const col of ["send_24h_reminders", "send_2h_reminders", "send_intake_reminders", "send_confirmation_emails", "postcare"]) {
      expect(body).not.toContain(col);
    }
  });
  it("the reminder cron decides sending without reading the self-service flags", () => {
    const src = read("app/api/cron/appointment-reminders/route.ts");
    expect(src).not.toMatch(/client_(cancellation|reschedule)_enabled|clientSelfServicePolicy/);
  });
  it("the postcare send does not gate on the self-service flags", () => {
    const src = read("app/(app)/calendar/actions.ts");
    const i = src.indexOf("sendPostcareEmailAction");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i)).not.toMatch(/client_(cancellation|reschedule)_enabled|clientSelfServicePolicy/);
  });
  it("the settings page is owner-only and shows the form from the live policy", () => {
    const src = read("app/(app)/settings/studio/page.tsx");
    expect(src).toContain('practitioner.role !== "owner"');
    expect(src).toContain("ClientSelfServiceForm");
    expect(src).toContain("clientSelfServicePolicyFromStudio(studio)");
  });
});
