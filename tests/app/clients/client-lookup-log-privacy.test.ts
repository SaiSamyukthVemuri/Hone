import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  committedPatch: null as Record<string, unknown> | null, pendingPatch: null as Record<string, unknown> | null,
  identity: vi.fn(), lookup: vi.fn(), duplicate: vi.fn(), audit: vi.fn(), redirect: vi.fn(), revalidate: vi.fn(), filters: [] as Array<[string, unknown]>, writes: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: h.identity }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (table: string) => {
  if (table === "audit_logs") return { insert: h.audit };
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
import { updateClientAction, archiveClientAction, unarchiveClientAction } from "@/app/(app)/clients/[id]/actions";

const STUDIO = "11111111-2222-4333-8444-555555555555";
const CLIENT = "22222222-3333-4444-8555-666666666666";
function form() {
  const data = new FormData();
  data.set("client_id", CLIENT); data.set("name", "Synthetic Client");
  return data;
}
beforeEach(() => {
  vi.clearAllMocks(); h.filters = []; h.committedPatch = null; h.pendingPatch = null;
  h.audit.mockReset(); h.redirect.mockReset(); h.revalidate.mockReset();
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


describe("client UPDATE failure diagnostic privacy", () => {
  function prepareUpdate(error: { code: string; message: string }) {
    h.lookup.mockResolvedValue({ data: { id: CLIENT }, error: null });
    h.duplicate.mockReset(); h.duplicate.mockResolvedValue({ data: [], error: null });
    const query = { eq: vi.fn() };
    query.eq.mockReturnValueOnce(query).mockResolvedValueOnce({ error });
    h.writes.mockReset(); h.writes.mockReturnValue(query);
    const data = form(); data.set("email", "synthetic-email@example.test");
    return { data, updateFilters: query.eq };
  }
  it("omits UPDATE error free text while preserving safe metadata, scope and generic response", async () => {
    const sentinel = `synthetic-patient@example.test private-clinical-sentinel synthetic-token ${CLIENT}`;
    const { data, updateFilters } = prepareUpdate({ code: "23514", message: sentinel });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(updateClientAction(data)).resolves.toEqual({ ok: false, error: "Couldn't save the client. Please try again." });
    // Two single-row reads: visibility, then (HON-58 I1) the stored name, phone
    // and date of birth that decide whether the probable-duplicate check runs.
    expect(h.identity).toHaveBeenCalledOnce(); expect(h.lookup).toHaveBeenCalledTimes(2);
    expect(h.duplicate).toHaveBeenCalledExactlyOnceWith(1); expect(h.writes).toHaveBeenCalledOnce();
    expect(updateFilters.mock.calls).toEqual([["id", CLIENT], ["studio_id", STUDIO]]);
    expect(log).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(log.mock.calls[0]![0]));
    expect(payload).toEqual({ event: "client_update_failed", clientId: "[id]", code: "23514", timestamp: expect.any(String) });
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
    for (const text of ["synthetic-patient", "private-clinical", "synthetic-token", CLIENT])
      expect(JSON.stringify(log.mock.calls)).not.toContain(text);
  });
  it.each([
    [null, "That email is already used by another active client. Use a different email or archive the duplicate client first."],
    ["2026-10-20T00:00:00Z", "That email belongs to an archived client. Unarchive that client or use a different email."],
  ])("keeps duplicate race classification and recheck for archived_at=%s", async (archivedAt, error) => {
    const { data, updateFilters } = prepareUpdate({ code: "23505", message: "clients_studio_normalized_email_uniq" });
    h.duplicate.mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [{ id: "other-synthetic-client", archived_at: archivedAt }], error: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(updateClientAction(data)).resolves.toEqual({ ok: false, error });
    expect(h.duplicate.mock.calls).toEqual([[1], [1]]);
    expect(h.writes).toHaveBeenCalledOnce();
    expect(updateFilters.mock.calls).toEqual([["id", CLIENT], ["studio_id", STUDIO]]);
    expect(log).not.toHaveBeenCalled();
  });
});


const ACTOR = "33333333-4444-4555-8666-777777777777";
const NAV = new Error("synthetic redirect control flow");
describe.each([
  { name: "archive", action: archiveClientAction, event: "client_archive_audit_failed", auditAction: "client_archived", destination: "/clients" },
  { name: "unarchive", action: unarchiveClientAction, event: "client_unarchive_audit_failed", auditAction: "client_unarchived", destination: `/clients/${CLIENT}` },
])("$name audit diagnostic privacy", ({ name, action, event, auditAction, destination }) => {
  function setup() {
    h.identity.mockResolvedValue({ practitioner: { id: ACTOR }, studio: { id: STUDIO } });
    h.lookup.mockResolvedValue({ data: { id: CLIENT }, error: null });
    const update = { eq: vi.fn(), is: vi.fn(), not: vi.fn() };
    update.eq.mockReturnValue(update);
    const commit = async () => { h.committedPatch = { ...h.pendingPatch! }; return { error: null }; };
    update.is.mockImplementation(commit); update.not.mockImplementation(commit);
    h.writes.mockReset(); h.writes.mockImplementation((patch: Record<string, unknown>) => { h.pendingPatch = patch; return update; });
    h.audit.mockResolvedValue({ error: null });
    h.redirect.mockImplementation(() => { throw NAV; });
    return update;
  }
  it("omits returned audit-error free text but preserves audit row, UPDATE scope and redirect", async () => {
    const update = setup();
    const sentinel = `synthetic-patient@example.test private-clinical-sentinel synthetic-token ${CLIENT}`;
    h.audit.mockResolvedValue({ error: { code: "23514", message: sentinel } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(action(form())).rejects.toBe(NAV);
    expect(h.identity).toHaveBeenCalledOnce(); expect(h.lookup).toHaveBeenCalledOnce();
    expect(h.filters).toEqual([["id", CLIENT], ["studio_id", STUDIO]]);
    expect(h.writes).toHaveBeenCalledOnce();
    expect(update.eq.mock.calls).toEqual([["id", CLIENT], ["studio_id", STUDIO]]);
    const mutation = h.writes.mock.calls[0]![0];
    expect(mutation).toEqual(name === "archive"
      ? { archived_at: expect.any(String), archived_by: ACTOR } : { archived_at: null, archived_by: null });
    expect(update.is.mock.calls).toEqual(name === "archive" ? [["archived_at", null]] : []);
    expect(update.not.mock.calls).toEqual(name === "unarchive" ? [["archived_at", "is", null]] : []);
    expect(h.audit).toHaveBeenCalledExactlyOnceWith({
      studio_id: STUDIO, actor_id: ACTOR, action: auditAction, entity_type: "client", entity_id: CLIENT,
      metadata: name === "archive" ? { archived_at: mutation.archived_at } : {},
    });
    expect(h.revalidate.mock.calls).toEqual([[`/clients/${CLIENT}`], ["/clients"]]);
    expect(h.redirect).toHaveBeenCalledExactlyOnceWith(destination);
    expect(log).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(log.mock.calls[0]![0]));
    expect(payload).toEqual({ event, clientId: "[id]", code: "23514", timestamp: expect.any(String) });
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
    for (const text of ["synthetic-patient", "private-clinical", "synthetic-token", CLIENT])
      expect(JSON.stringify(log.mock.calls)).not.toContain(text);
  });
  it("preserves committed success and safe diagnostics when inline audit insert throws", async () => {
    const update = setup();
    const sentinel = `synthetic-patient@example.test private-clinical-sentinel synthetic-token ${CLIENT}`;
    h.audit.mockRejectedValue(new Error(sentinel));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(action(form())).rejects.toBe(NAV);
    expect(h.committedPatch).toEqual(name === "archive"
      ? { archived_at: expect.any(String), archived_by: ACTOR } : { archived_at: null, archived_by: null });
    expect(h.writes).toHaveBeenCalledOnce();
    expect(update.eq.mock.calls).toEqual([["id", CLIENT], ["studio_id", STUDIO]]);
    expect(update.is.mock.calls).toEqual(name === "archive" ? [["archived_at", null]] : []);
    expect(update.not.mock.calls).toEqual(name === "unarchive" ? [["archived_at", "is", null]] : []);
    expect(h.audit).toHaveBeenCalledExactlyOnceWith({
      studio_id: STUDIO, actor_id: ACTOR, action: auditAction, entity_type: "client", entity_id: CLIENT,
      metadata: name === "archive" ? { archived_at: h.committedPatch!.archived_at } : {},
    });
    expect(h.revalidate.mock.calls).toEqual([[`/clients/${CLIENT}`], ["/clients"]]);
    expect(h.redirect).toHaveBeenCalledExactlyOnceWith(destination);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ event, clientId: "[id]", code: "audit_write_unavailable", timestamp: expect.any(String) });
    for (const raw of [sentinel, "synthetic-patient", "private-clinical", "synthetic-token", CLIENT])
      expect(JSON.stringify(log.mock.calls)).not.toContain(raw);
  });
  it("preserves normal committed success without inventing an audit warning", async () => {
    setup(); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(action(form())).rejects.toBe(NAV);
    expect(h.committedPatch).toEqual(name === "archive"
      ? { archived_at: expect.any(String), archived_by: ACTOR } : { archived_at: null, archived_by: null });
    expect(h.audit).toHaveBeenCalledOnce();
    expect(h.revalidate.mock.calls).toEqual([[`/clients/${CLIENT}`], ["/clients"]]);
    expect(h.redirect).toHaveBeenCalledExactlyOnceWith(destination);
    expect(log).not.toHaveBeenCalled();
  });
  it("preserves UPDATE failure before audit and redirect", async () => {
    const update = setup();
    update.is.mockResolvedValue({ error: { message: "synthetic update refusal" } });
    update.not.mockResolvedValue({ error: { message: "synthetic update refusal" } });
    await expect(action(form())).rejects.toThrow(`Failed to ${name} client: synthetic update refusal`);
    expect(h.committedPatch).toBeNull();
    expect(h.audit).not.toHaveBeenCalled(); expect(h.revalidate).not.toHaveBeenCalled(); expect(h.redirect).not.toHaveBeenCalled();
  });
  it.each(["auth", "visibility"])("preserves %s refusal before UPDATE or audit", async (mode) => {
    setup();
    if (mode === "auth") h.identity.mockRejectedValue(new Error("synthetic auth refusal"));
    else h.lookup.mockResolvedValue({ data: null, error: null });
    await expect(action(form())).rejects.toThrow(mode === "auth" ? "synthetic auth refusal" : "Client not found.");
    if (mode === "auth") expect(h.lookup).not.toHaveBeenCalled();
    expect(h.committedPatch).toBeNull();
    expect(h.writes).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
    expect(h.revalidate).not.toHaveBeenCalled(); expect(h.redirect).not.toHaveBeenCalled();
  });
});
