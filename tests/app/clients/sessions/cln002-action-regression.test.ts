import { beforeEach, describe, expect, it, vi } from "vitest";

// CLN-002 REGRESSION (test-only). Behavioural cases for the deployed #978
// containment in startSessionAction that were pinned only as source text, or
// not at all: the reverse-skew PGRST202 fallback, a refused command, lineage
// refusals before the command, and the side-effect gates for a B that is not
// a confirmed, ended appointment. Synthetic ids; no database, no provider.
// The atomic selection fix itself (0241) and its concurrency proof are DB-level
// and live in tests/db/multi-studio-session-start-concurrency.db.test.ts.

const runtime = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), adminRpc: vi.fn(), revalidate: vi.fn(),
  postcare: vi.fn(), analytics: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: runtime.revalidate }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: runtime.from, rpc: runtime.rpc }) }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "practitioner" }, studio: { id: "studio" } }) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc: runtime.adminRpc }) }));
vi.mock("@/app/(app)/calendar/postcare-auto-send", () => ({ autoSendPostcareOnComplete: runtime.postcare }));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: runtime.analytics }));
vi.mock("@/lib/observability/perf-timing", () => ({ timed: async (_name: string, fn: () => unknown) => fn(), startPerfSpan: () => ({ end: vi.fn() }) }));
import { startSessionAction } from "../../../../app/(app)/clients/[id]/sessions/new/actions";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LINK_REFUSED = "The chart could not be linked to this appointment";

type Appt = { id: string; studio_id: string; client_id: string; practitioner_id: string | null; status: string; ends_at: string };
let appointment: Appt;
let linked: { data: { appointment_id: string | null } | null; error: { message: string } | null };

function form(appointmentId: string | null = B): FormData {
  const data = new FormData();
  data.set("client_id", "client"); data.set("modality", "electrolysis");
  if (appointmentId) data.set("appointment_id", appointmentId);
  return data;
}
function expectNoSideEffects() {
  expect(runtime.adminRpc).not.toHaveBeenCalled();
  expect(runtime.postcare).not.toHaveBeenCalled();
  expect(runtime.analytics).not.toHaveBeenCalled();
  expect(runtime.revalidate).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  appointment = { id: B, studio_id: "studio", client_id: "client", practitioner_id: "practitioner", status: "confirmed", ends_at: "2020-01-01T00:00:00Z" };
  linked = { data: { appointment_id: B }, error: null };
  runtime.rpc.mockResolvedValue({ data: [{ session_id: "chart", reused: false }], error: null });
  runtime.adminRpc.mockResolvedValue({ error: null });
  runtime.postcare.mockResolvedValue(undefined);
  runtime.from.mockImplementation((table: string) => {
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(async () => table === "sessions" ? linked : { data: appointment, error: null }),
    };
    return chain;
  });
});

describe("reverse skew: an app ahead of its database (PGRST202 fallback)", () => {
  it("retries exactly once on the four-argument command, carrying the validated appointment", async () => {
    runtime.rpc
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } })
      .mockResolvedValueOnce({ data: [{ session_id: "chart", reused: false }], error: null });
    await expect(startSessionAction(form())).rejects.toThrow("REDIRECT:/clients/client/sessions/chart");
    expect(runtime.rpc).toHaveBeenCalledTimes(2);
    expect(runtime.rpc.mock.calls[1]).toEqual(["start_session", {
      p_client_id: "client", p_modality: "electrolysis", p_appointment_id: B, p_coalesce_minutes: 90,
    }]);
  });

  it("an old command that coalesces B onto A's chart is still refused before any side effect", async () => {
    runtime.rpc
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } })
      .mockResolvedValueOnce({ data: [{ session_id: "chart-a", reused: true }], error: null });
    linked = { data: { appointment_id: A }, error: null };
    await expect(startSessionAction(form())).rejects.toThrow(LINK_REFUSED);
    expectNoSideEffects();
  });

  it("a second PGRST202 is not retried again and surfaces as a failed start", async () => {
    runtime.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
    await expect(startSessionAction(form())).rejects.toThrow("Failed to start session");
    expect(runtime.rpc).toHaveBeenCalledTimes(2);
    expectNoSideEffects();
  });
});

describe("a refused or empty command never reaches the lineage readback or a side effect", () => {
  it.each([
    ["a command error", { data: null, error: { code: "23514", message: "Appointment is for a different client." } }],
    ["no session id", { data: [{ reused: false }], error: null }],
    ["an empty result", { data: [], error: null }],
  ] as const)("%s throws once, with no retry", async (_name, answer) => {
    runtime.rpc.mockResolvedValue(answer);
    await expect(startSessionAction(form())).rejects.toThrow("Failed to start session");
    expect(runtime.rpc).toHaveBeenCalledTimes(1);
    expect(runtime.from).toHaveBeenCalledTimes(1); // the appointment lookup only, never sessions
    expectNoSideEffects();
  });
});

describe("appointment lineage is refused before the command runs", () => {
  it.each([
    ["another studio", { studio_id: "other-studio" }, "Appointment is not in your studio."],
    ["another client", { client_id: "other-client" }, "Appointment is for a different client."],
    ["another practitioner", { practitioner_id: "other-practitioner" }, "Appointment is assigned to a different practitioner."],
  ] as const)("an appointment for %s", async (_name, patch, message) => {
    appointment = { ...appointment, ...patch };
    await expect(startSessionAction(form())).rejects.toThrow(message);
    expect(runtime.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it("an appointment the practitioner cannot see is refused", async () => {
    runtime.from.mockImplementation(() => {
      const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle: vi.fn(async () => ({ data: null, error: null })) };
      return chain;
    });
    await expect(startSessionAction(form())).rejects.toThrow("Appointment not found.");
    expect(runtime.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it("an unassigned appointment in the same studio and client may be charted", async () => {
    appointment = { ...appointment, practitioner_id: null };
    await expect(startSessionAction(form())).rejects.toThrow("REDIRECT:/clients/client/sessions/chart");
    expect(runtime.rpc).toHaveBeenCalledWith("start_session", expect.objectContaining({ p_appointment_id: B, p_studio_id: "studio" }));
  });
});

describe("a correctly linked B chart completes B only when B is confirmed and has ended", () => {
  it.each([
    ["no_show", "2020-01-01T00:00:00Z"],
    ["cancelled", "2020-01-01T00:00:00Z"],
    ["completed", "2020-01-01T00:00:00Z"],
    ["confirmed", "2999-01-01T00:00:00Z"],
  ])("status %s ending %s: the chart opens, but no completion and no postcare", async (status, endsAt) => {
    appointment = { ...appointment, status, ends_at: endsAt };
    await expect(startSessionAction(form())).rejects.toThrow("REDIRECT:/clients/client/sessions/chart");
    expect(runtime.adminRpc).not.toHaveBeenCalled();
    expect(runtime.postcare).not.toHaveBeenCalled();
  });

  it("a failed completion is fail-soft: no postcare, and the chart still opens", async () => {
    runtime.adminRpc.mockResolvedValue({ error: { code: "P0001", message: "synthetic refusal" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(startSessionAction(form())).rejects.toThrow("REDIRECT:/clients/client/sessions/chart");
    expect(runtime.adminRpc).toHaveBeenCalledTimes(1);
    expect(runtime.postcare).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("separate appointments get separate charts: B's new chart completes B, never A", async () => {
    runtime.rpc.mockResolvedValue({ data: [{ session_id: "chart-b", reused: false }], error: null });
    await expect(startSessionAction(form())).rejects.toThrow("REDIRECT:/clients/client/sessions/chart-b");
    expect(runtime.adminRpc).toHaveBeenCalledTimes(1);
    expect(runtime.adminRpc).toHaveBeenCalledWith("mark_appointment_complete", expect.objectContaining({ p_appointment_id: B }));
    expect(runtime.analytics).toHaveBeenCalledWith(expect.objectContaining({ properties: expect.objectContaining({ is_new_session: true }) }));
  });
});
