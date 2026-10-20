import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  identity: vi.fn(), lookup: vi.fn(), duplicate: vi.fn(), filters: [] as Array<[string, unknown]>, writes: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: h.identity }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => {
  const query = {
    select: () => query,
    eq: (key: string, value: unknown) => { h.filters.push([key, value]); return query; },
    maybeSingle: h.lookup,
    neq: (key: string, value: unknown) => { h.filters.push([`exclude:${key}`, value]); return query; },
    limit: h.duplicate,
    update: h.writes,
  };
  return query;
} }) }));
import { updateClientAction } from "@/app/(app)/clients/[id]/actions";

const STUDIO = "11111111-2222-4333-8444-555555555555";
const CLIENT = "22222222-3333-4444-8555-666666666666";
function form() {
  const data = new FormData();
  data.set("client_id", CLIENT); data.set("name", "Synthetic Client");
  return data;
}
beforeEach(() => {
  vi.clearAllMocks(); h.filters = [];
  h.identity.mockResolvedValue({ studio: { id: STUDIO } });
});
afterEach(() => vi.restoreAllMocks());

describe("client visibility lookup diagnostic privacy", () => {
  it("omits DB free text while preserving selected-studio refusal and no write", async () => {
    const sentinel = "synthetic-patient@example.test private-clinical-sentinel synthetic-token";
    h.lookup.mockResolvedValue({ data: null, error: { code: "57014", message: sentinel } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(updateClientAction(form())).resolves.toEqual({ ok: false, error: "Client not found." });
    expect(h.identity).toHaveBeenCalledOnce();
    expect(h.filters).toEqual([["id", CLIENT], ["studio_id", STUDIO]]);
    expect(h.writes).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(log.mock.calls[0]![0]));
    expect(payload).toEqual({ event: "client_visible_lookup_failed", timestamp: expect.any(String) });
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
  });
  it("keeps a missing or out-of-studio client refused without a write", async () => {
    h.lookup.mockResolvedValue({ data: null, error: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(updateClientAction(form())).resolves.toEqual({ ok: false, error: "Client not found." });
    expect(h.filters).toEqual([["id", CLIENT], ["studio_id", STUDIO]]);
    expect(h.writes).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
  it("keeps identity failure ahead of the client lookup", async () => {
    h.identity.mockRejectedValue(new Error("synthetic auth refusal"));
    await expect(updateClientAction(form())).rejects.toThrow("synthetic auth refusal");
    expect(h.lookup).not.toHaveBeenCalled(); expect(h.writes).not.toHaveBeenCalled();
  });
});


describe("duplicate-email lookup diagnostic privacy", () => {
  const EMAIL = "synthetic-email@example.test";
  function duplicateForm() {
    const data = form(); data.set("email", `  ${EMAIL.toUpperCase()}  `); return data;
  }
  it("withholds raw DB free text and identifiers without changing the scoped query or generic refusal", async () => {
    const sentinel = `synthetic-patient@example.test private-clinical-sentinel synthetic-token ${CLIENT} ${CLIENT.replaceAll("-", "%2D")}`;
    h.lookup.mockResolvedValue({ data: { id: CLIENT }, error: null });
    h.duplicate.mockResolvedValue({ data: null, error: { code: "57014", message: sentinel } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(updateClientAction(duplicateForm())).resolves.toEqual({ ok: false, error: "Couldn't save the client. Please try again." });
    expect(h.identity).toHaveBeenCalledOnce(); expect(h.lookup).toHaveBeenCalledOnce();
    expect(h.duplicate).toHaveBeenCalledExactlyOnceWith(1);
    expect(h.filters).toEqual([["id", CLIENT], ["studio_id", STUDIO], ["studio_id", STUDIO], ["normalized_email", EMAIL], ["exclude:id", CLIENT]]);
    expect(h.writes).not.toHaveBeenCalled(); expect(log).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(log.mock.calls[0]![0]));
    expect(payload).toEqual({ event: "client_duplicate_email_lookup_failed", code: "57014", timestamp: expect.any(String) });
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
    for (const text of ["synthetic-patient", "private-clinical", "synthetic-token", CLIENT, "%2D"])
      expect(JSON.stringify(log.mock.calls)).not.toContain(text);
  });
  it.each([
    [null, "That email is already used by another active client. Use a different email or archive the duplicate client first."],
    ["2026-10-20T00:00:00Z", "That email belongs to an archived client. Unarchive that client or use a different email."],
  ])("preserves the existing duplicate response for archived_at=%s", async (archivedAt, error) => {
    h.lookup.mockResolvedValue({ data: { id: CLIENT }, error: null });
    h.duplicate.mockResolvedValue({ data: [{ id: "other-synthetic-client", archived_at: archivedAt }], error: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(updateClientAction(duplicateForm())).resolves.toEqual({ ok: false, error });
    expect(h.writes).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
});
