import { describe, expect, it } from "vitest";
import {
  DESK_MAX_WINDOW,
  DESK_PAGE_SIZE,
  mapDeskClientRow,
  normalizeDeskQuery,
  parseDeskDirectoryInput,
  readDeskDirectory,
  readDeskSchedule,
  type DeskRpc,
} from "@/lib/desk/read";

// R2 (no enumeration), R7 (status semantics, Unavailable never positive), S6 (fixed errors).

const raw = (over: Record<string, unknown> = {}) => ({
  client_id: "c1", display_name: "Janie", name_on_file: false, phone: "+1 555 0100", email: "j@example.test",
  next_appointment_at: "2031-01-01T10:00:00Z", last_visit_on: "2030-05-01", intake_state: "reviewed",
  consent_signed: true, total_count: 3, ...over,
});

function rpcOf(data: unknown, error: unknown = null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db: DeskRpc = { rpc: async (fn, args) => { calls.push({ fn, args }); return { data, error }; } };
  return { db, calls };
}

describe("input parsing (R2)", () => {
  it("page 2 or later without a real search term is page 1 (an empty-query browse is the first page only)", () => {
    expect(parseDeskDirectoryInput({ page: "2" }).page).toBe(1);
    expect(parseDeskDirectoryInput({ q: "a", page: "3" }).page).toBe(1);
    expect(parseDeskDirectoryInput({ q: "   ", page: "3" }).page).toBe(1);
    // Control: with two characters the page is honoured.
    expect(parseDeskDirectoryInput({ q: "ja", page: "3" }).page).toBe(3);
  });

  it("the window can never be walked past offset + limit = 200", () => {
    expect(DESK_MAX_WINDOW).toBe(200);
    const last = parseDeskDirectoryInput({ q: "ja", page: "999999" }).page;
    expect(last).toBe(DESK_MAX_WINDOW / DESK_PAGE_SIZE);
    expect((last - 1) * DESK_PAGE_SIZE + DESK_PAGE_SIZE).toBeLessThanOrEqual(DESK_MAX_WINDOW);
    expect(parseDeskDirectoryInput({ q: "ja", page: "-4" }).page).toBe(1);
    expect(parseDeskDirectoryInput({ q: "ja", page: "x" }).page).toBe(1);
  });

  it("filters and sort are closed sets; the query is whitespace-collapsed and bounded", () => {
    expect(parseDeskDirectoryInput({ filters: ["intake_review", "evil", "no_upcoming", "intake_review"], sort: "name; drop" })).toMatchObject({
      filters: ["intake_review", "no_upcoming"], sort: "name",
    });
    expect(parseDeskDirectoryInput({ sort: "next" }).sort).toBe("next");
    expect(normalizeDeskQuery("  Jane   \n Smith ")).toBe("Jane Smith");
    expect(normalizeDeskQuery("x".repeat(500))).toHaveLength(100);
    expect(normalizeDeskQuery(undefined)).toBe("");
  });
});

describe("directory read", () => {
  it("calls only the 0274 directory function with the studio, the term, a closed filter set and the page window", async () => {
    const { db, calls } = rpcOf([raw()]);
    await readDeskDirectory(db, "studio-1", { q: "ja", filters: ["no_upcoming"], sort: "next", page: 3 });
    expect(calls).toEqual([
      { fn: "receptionist_client_directory", args: { p_studio_id: "studio-1", p_query: "ja", p_filters: ["no_upcoming"], p_sort: "next", p_offset: 50, p_limit: 25 } },
    ]);
    const empty = rpcOf([raw()]);
    await readDeskDirectory(empty.db, "studio-1", { q: "", filters: [], sort: "name", page: 1 });
    expect(empty.calls[0].args.p_query).toBeNull();
  });

  it("maps exactly the allow-listed columns and no other value", () => {
    const row = mapDeskClientRow(raw({ address: "SENTINEL", date_of_birth: "SENTINEL", notes: "SENTINEL", legal_name: "SENTINEL", pronouns: "SENTINEL", consent_accepted_at: "SENTINEL" }));
    expect(Object.keys(row!).sort()).toEqual([
      "consentSigned", "displayName", "email", "id", "intake", "lastVisitOn", "nameOnFile", "nextAppointmentAt", "phone",
    ]);
    expect(JSON.stringify(row)).not.toContain("SENTINEL");
  });

  it("R7: an unreadable or unexpected status is Unavailable, never positive; the last visit is a date", () => {
    expect(mapDeskClientRow(raw({ intake_state: "submitted" }))!.intake).toBe("unavailable");
    expect(mapDeskClientRow(raw({ intake_state: null }))!.intake).toBe("unavailable");
    expect(mapDeskClientRow(raw({ intake_state: "reviewed" }))!.intake).toBe("reviewed");
    expect(mapDeskClientRow(raw({ consent_signed: "yes" }))!.consentSigned).toBeNull();
    expect(mapDeskClientRow(raw({ consent_signed: null }))!.consentSigned).toBeNull();
    expect(mapDeskClientRow(raw({ consent_signed: false }))!.consentSigned).toBe(false);
    expect(mapDeskClientRow(raw({ last_visit_on: "2030-05-01T13:45:00Z" }))!.lastVisitOn).toBe("2030-05-01");
    expect(mapDeskClientRow(raw({ display_name: "" }))).toBeNull();
    expect(mapDeskClientRow(null)).toBeNull();
  });

  it("paging: only the first page exists without a term; with a term the window caps at 200 and says so", async () => {
    const many = (n: number) => Array.from({ length: 25 }, (_, i) => raw({ client_id: `c${i}`, total_count: n }));
    const browse = await readDeskDirectory(rpcOf(many(500)).db, "s", { q: "", filters: [], sort: "name", page: 1 });
    expect(browse).toMatchObject({ total: 500, pageCount: 1, capped: true });
    const search = await readDeskDirectory(rpcOf(many(500)).db, "s", { q: "ja", filters: [], sort: "name", page: 1 });
    expect(search).toMatchObject({ total: 500, pageCount: 8, capped: true });
    const small = await readDeskDirectory(rpcOf(many(30)).db, "s", { q: "ja", filters: [], sort: "name", page: 1 });
    expect(small).toMatchObject({ total: 30, pageCount: 2, capped: false });
  });

  it("failure is one fixed message with no term, name, email or phone in it", async () => {
    const term = "jane.smith@example.test";
    for (const bad of [rpcOf(null, { code: "XX", message: `boom ${term}` }), rpcOf({ not: "an array" })]) {
      const err = await readDeskDirectory(bad.db, "s", { q: term, filters: [], sort: "name", page: 1 }).catch((e: Error) => e);
      expect((err as Error).message).toBe("Failed to load clients");
      expect(String((err as Error).message)).not.toContain(term);
    }
  });
});

describe("schedule read (R1, R8)", () => {
  it("calls receptionist_calendar_v2, never the closed v1, and maps booking information only", async () => {
    const { db, calls } = rpcOf([{
      appointment_id: "a1", starts_at: "2031-01-01T10:00:00Z", ends_at: "2031-01-01T11:00:00Z", status: "confirmed",
      practitioner_id: "p1", practitioner_display_name: "Pat", practitioner_color: "#fff", service_id: "s1", service_name: "Consultation",
      client_id: "c1", display_name: "Janie", name_on_file: true, notes: "SENTINEL", price: "SENTINEL", client_display_name: "SENTINEL stored",
    }]);
    const rows = await readDeskSchedule(db, "studio-1", "2031-01-01T00:00:00Z", "2031-01-08T00:00:00Z");
    expect(calls).toEqual([{ fn: "receptionist_calendar_v2", args: { p_studio_id: "studio-1", p_from: "2031-01-01T00:00:00Z", p_to: "2031-01-08T00:00:00Z" } }]);
    expect(rows).toEqual([{
      appointmentId: "a1", startsAt: "2031-01-01T10:00:00Z", endsAt: "2031-01-01T11:00:00Z", status: "confirmed",
      practitionerName: "Pat", serviceName: "Consultation", displayName: "Janie", nameOnFile: true,
    }]);
    expect(JSON.stringify(rows)).not.toContain("SENTINEL");
    expect(JSON.stringify(rows)).not.toContain("c1"); // no client id: nothing on the schedule can link anywhere
  });

  it("a failed read is a fixed message", async () => {
    await expect(readDeskSchedule(rpcOf(null, { message: "secret@example.test" }).db, "s", "a", "b")).rejects.toThrow(/^Failed to load schedule$/);
  });
});
