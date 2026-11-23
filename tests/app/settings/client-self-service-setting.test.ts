import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseClientSelfServiceForm } from "@/lib/booking/client-self-service-form";
import { clientSelfServicePolicyFromStudio } from "@/lib/booking/client-self-service-policy";

// HON-47 owner setting for client self-service (0234 columns). Synthetic data.

vi.mock("server-only", () => ({}));

const st = vi.hoisted(() => ({
  managed: false as unknown,
  rpcResult: true as unknown,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  role: "owner" as string,
  studioId: "studio-A",
  updates: [] as Array<{ patch: Record<string, unknown>; id: unknown }>,
  error: null as { code?: string; message: string } | null,
  revalidated: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => st.revalidated.push(p) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { role: st.role },
    studio: { id: st.studioId, studio_managed_appointments: st.managed },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: unknown) => { st.rpcCalls.push({name, args}); return { data: st.rpcResult, error: st.error }; },
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
  st.managed = false;
  st.rpcResult = true;
  st.rpcCalls.length = 0;
  st.role = "owner";
  st.studioId = "studio-A";
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
    const src = read("app/(app)/settings/studio/client-self-service/page.tsx");
    expect(src).toContain('practitioner.role !== "owner"');
    expect(src).toContain("ClientSelfServiceForm");
    expect(src).toContain("clientSelfServicePolicyFromStudio({ ...studio, studio_managed_appointments: false })");
  });
});


describe("studio-managed appointments owner command", () => {
  function managedForm(value: string) { const f = new FormData(); f.set("studio_managed_appointments", value); f.set("studio_id", "other-studio"); return f; }
  it("saves only the mode for the session-selected studio, ignoring a forged browser studio ID", async () => {
    const { setStudioManagedAppointmentsAction } = await import("@/app/(app)/settings/studio/actions");
    expect(await setStudioManagedAppointmentsAction(managedForm("true"))).toEqual({ok:true});
    expect(st.rpcCalls).toEqual([{name:"set_studio_managed_appointments",args:{p_studio_id:"studio-A",p_enabled:true}}]);
    expect(st.updates).toEqual([]);
  });
  it("an owner with another selected studio passes that selected studio rather than the posted ID", async () => {
    st.studioId="studio-selected-B";
    const { setStudioManagedAppointmentsAction } = await import("@/app/(app)/settings/studio/actions");
    expect(await setStudioManagedAppointmentsAction(managedForm("true"))).toEqual({ok:true});
    expect(st.rpcCalls).toEqual([{name:"set_studio_managed_appointments",args:{p_studio_id:"studio-selected-B",p_enabled:true}}]);
    expect(st.updates).toEqual([]);
  });
  it("accepts the confirmed false result when restoring saved preferences", async () => {
    st.managed=true; st.rpcResult=false;
    const { setStudioManagedAppointmentsAction } = await import("@/app/(app)/settings/studio/actions");
    expect(await setStudioManagedAppointmentsAction(managedForm("false"))).toEqual({ok:true});
    expect(st.updates).toEqual([]);
  });
  it.each(["practitioner","receptionist"])("refuses %s without database writes",async role=>{
    st.role=role;
    const { setStudioManagedAppointmentsAction } = await import("@/app/(app)/settings/studio/actions");
    expect((await setStudioManagedAppointmentsAction(managedForm("true"))).ok).toBe(false);
    expect(st.rpcCalls).toEqual([]);
  });
  it.each(["on","TRUE",""])("rejects malformed %s before writes",async value=>{
    const { setStudioManagedAppointmentsAction } = await import("@/app/(app)/settings/studio/actions");
    expect((await setStudioManagedAppointmentsAction(managedForm(value))).ok).toBe(false);
    expect(st.rpcCalls).toEqual([]);
  });
  it("does not offer activation before the schema exists",async()=>{
    st.managed=undefined;
    const { setStudioManagedAppointmentsAction } = await import("@/app/(app)/settings/studio/actions");
    expect((await setStudioManagedAppointmentsAction(managedForm("true"))).ok).toBe(false);
    expect(st.rpcCalls).toEqual([]);
  });
  it.each([null,false])("a missing or mismatched RPC response %s is not saved",async value=>{
    st.rpcResult=value;
    const { setStudioManagedAppointmentsAction } = await import("@/app/(app)/settings/studio/actions");
    expect((await setStudioManagedAppointmentsAction(managedForm("true"))).ok).toBe(false);
    expect(st.revalidated).toEqual([]);
  });
});
