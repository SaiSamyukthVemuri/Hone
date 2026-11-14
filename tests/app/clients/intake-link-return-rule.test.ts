import { beforeEach, describe, expect, it, vi } from "vitest";

// Codex at 35883d5d1 (intake/actions.ts:539); Sam's group 4: resend = messaging + intake STATUS, not answers. The email may still go to the
// client, but the staff member only receives the bearer intake URL while clin.view_intake is on.

type Row = Record<string, unknown>;
const STUDIO = "studio-1";
const CLIENT = "client-1";
const INTAKE = "intake-open";

const { allowed, createClientSpy, getCurrentPractitionerWithStudio, sendEmail, createIntake, stamp } = vi.hoisted(() => ({
  allowed: { value: true },
  createClientSpy: vi.fn(),
  getCurrentPractitionerWithStudio: vi.fn(),
  sendEmail: vi.fn(),
  createIntake: vi.fn(),
  stamp: vi.fn(),
}));

vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: async () => ({ allowed: allowed.value, mode: "enforce", engine: allowed.value }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientSpy }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio, getPractitionersForStudio: vi.fn() }));
vi.mock("@/lib/intake/queries", () => ({
  createIntakeRequestForClient: createIntake,
  generateIntakeLinkUrl: () => "https://app.example.test/intake/TOKEN",
  stampIntakeLinkIssued: stamp,
}));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://app.example.test" }));
vi.mock("@/lib/rate-limit/public", () => ({ limitPractitionerClientEmail: async () => ({ allowed: true }) }));
vi.mock("@/lib/email/send-appointment", () => ({ sendIntakeUpdateRequestToClient: sendEmail }));

import { requestIntakeUpdateAction, resendIntakeEmailAction } from "@/app/(app)/clients/[id]/intake/actions";

const DATA: Record<string, Row> = {
  clients: { id: CLIENT, studio_id: STUDIO, name: "Dana", email: "dana@example.test" },
  client_intake_forms: { id: INTAKE, studio_id: STUDIO, client_id: CLIENT, status: "in_progress", deleted_at: null },
  studios: { id: STUDIO, name: "Test Studio" },
};

function fake() {
  return {
    from(table: string) {
      const row = DATA[table];
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: row ?? null, error: null });
      chain.single = chain.maybeSingle;
      return chain;
    },
  };
}

function fd(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("client_id", CLIENT);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

beforeEach(() => {
  allowed.value = true;
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ ok: true });
  stamp.mockReset();
  createIntake.mockReset();
  createIntake.mockResolvedValue({ id: "intake-new", url: "https://app.example.test/intake/NEWTOKEN" });
  createClientSpy.mockReset();
  createClientSpy.mockResolvedValue(fake());
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: { id: "prac-a", active: true, display_name: "P", email: "p@x.test" },
    studio: { id: STUDIO },
  });
});

describe("resendIntakeEmailAction returns the bearer link only with clin.view_intake", () => {
  it("key ON: the email is sent and the link is returned", async () => {
    const r = await resendIntakeEmailAction(fd({ intake_id: INTAKE }));
    expect(r).toMatchObject({ ok: true, emailSent: true, intakeUrl: "https://app.example.test/intake/TOKEN" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("key OFF: the email is STILL sent, the stamp still happens, and no link is returned", async () => {
    allowed.value = false;
    const r = await resendIntakeEmailAction(fd({ intake_id: INTAKE }));
    expect(r).toMatchObject({ ok: true, emailSent: true, intakeUrl: null });
    expect(JSON.stringify(r)).not.toContain("TOKEN");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(stamp).toHaveBeenCalledTimes(1);
  });
});

describe("requestIntakeUpdateAction (new intake) follows the same rule", () => {
  it("key ON: the link is returned", async () => {
    const r = await requestIntakeUpdateAction(fd({ send_email: "true" }));
    expect(r).toMatchObject({ ok: true, intakeUrl: "https://app.example.test/intake/NEWTOKEN" });
  });

  it("key OFF: the email still goes, the link is not returned", async () => {
    allowed.value = false;
    const r = await requestIntakeUpdateAction(fd({ send_email: "true" }));
    expect(r).toMatchObject({ ok: true, emailSent: true, intakeUrl: null });
    expect(JSON.stringify(r)).not.toContain("NEWTOKEN");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
