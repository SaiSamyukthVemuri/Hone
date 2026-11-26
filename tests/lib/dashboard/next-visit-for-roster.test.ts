import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { getNextVisitsForRoster, type NextRosterVisit } from "@/lib/dashboard/next-visit-for-roster";

const studio = "test-studio";
const time = (hours: number, minutes = 0) => new Date(Date.UTC(2026, 10, 24, hours, minutes)).toISOString();
type VisitFixture = NextRosterVisit & { client_id: string; status: string; studio_id: string };
function visit(id: string, client_id: string, starts_at: string, status = "confirmed", studio_id = studio): VisitFixture {
  return {
    id, client_id, starts_at, status, studio_id, duration_minutes: 45,
    service: { name: "Test treatment" }, practitioner: { display_name: "Test practitioner" },
  };
}

// Exercise the PostgREST builder as well as the selection rule. Its embedded order and limit belong
// to each client; setting a limit on the parent query would discard entire clients instead.
function database(records: ReturnType<typeof visit>[], failOnRequest = 0) {
  const requests: URL[] = [];
  const supabase = createClient("http://example.test", "fixture-key", { global: { fetch: async url => {
    const request = new URL(String(url));
    requests.push(request);
    if (requests.length === failOnRequest) return Response.json({ message: "unavailable" }, { status: 403 });
    const q = request.searchParams;
    expect(request.pathname).toBe("/rest/v1/clients");
    expect(q.get("select")).toBe("id,visits:appointments!appointments_client_same_studio_fk(id,starts_at,duration_minutes,service:services!appointments_service_same_studio_fk(name),practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name))");
    expect(q.get("visits.order")).toBe("starts_at.asc,id.asc");
    expect(q.get("visits.status")).toBe("eq.confirmed");
    const ids = q.get("id")!.slice(4, -1).split(",");
    const result = ids.map(id => ({ id, visits: records.filter(row =>
      row.client_id === id && "eq." + row.studio_id === q.get("studio_id") &&
      "eq." + row.status === q.get("visits.status") &&
      row.starts_at.replace(/\.(\d+)Z$/, (_, f: string) => "." + f.padEnd(6, "0") + "Z") > q.get("visits.starts_at")!.slice(3)
    ).sort((a,b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id))
      .slice(0,Number(q.get("visits.limit"))).map(({ id, starts_at, duration_minutes, service, practitioner }) => ({ id, starts_at, duration_minutes, service, practitioner })) }));
    return Response.json(result);
  } } });
  return { supabase, requests };
}

describe("next visit for each dashboard appointment", () => {
  it("chooses the next confirmed visit by client after now and the viewed visit, with stable simultaneous starts", async () => {
    const early = visit("past", "a", time(8));
    const later = visit("afternoon", "a", time(14));
    const none = visit("last", "b", time(17));
    const {supabase, requests} = database([
      early, later, none, visit("other-source", "c", time(11)), visit("past-future", "a", time(9)),
      visit("at-now", "a", time(10)), visit("first", "a", time(12)), visit("same-time", "a", time(14)),
      visit("cancelled", "a", time(15), "cancelled"), visit("completed", "a", time(15), "completed"),
      visit("other-studio", "a", time(15), "confirmed", "other-studio"), visit("z", "a", time(16)), visit("a", "a", time(16)),
      visit("old-b", "b", time(12))
    ]);
    const result = await getNextVisitsForRoster(supabase, studio, [early, later, none], time(10));
    expect(result.get(early.id)).toEqual({
      id: "first", starts_at: time(12), duration_minutes: 45,
      service: { name: "Test treatment" }, practitioner: { display_name: "Test practitioner" },
    });
    expect(result.get(later.id)?.id).toBe("a");
    expect(result.has(none.id)).toBe(false);
    expect(requests).toHaveLength(1);
  });
  it("keeps the booked time when the service or practitioner is absent", async () => {
    const source = visit("source", "a", time(8));
    const upcoming = { ...visit("unassigned", "a", time(15)), service: null, practitioner: null, duration_minutes: 30 };
    const { supabase } = database([source, upcoming]);
    const result = await getNextVisitsForRoster(supabase, studio, [source], time(9));
    expect(result.get(source.id)).toEqual({
      id: "unassigned", starts_at: time(15), duration_minutes: 30, service: null, practitioner: null,
    });
  });

  it("still finds a following visit for a later source past a full first page", async () => {
    const first = visit("am", "a", time(8));
    const late = visit("pm", "a", time(16));
    const between = Array.from({length:75},(_,i)=>visit("other-"+i,"a",time(9,i)));
    const {supabase, requests} = database([...between,late,visit("following","a",time(18))]);
    const result=await getNextVisitsForRoster(supabase, studio, [first,late], time(7));
    expect(result.get("am")?.id).toBe("other-0");
    expect(result.get("pm")?.id).toBe("following");
    expect(requests.length).toBeLessThan(5);
  });
  it("rechecks each client independently, skips its own id even if rescheduled, and preserves sub-millisecond boundaries", async () => {
    const source=visit("source","x","2026-11-24T09:00:00.123001-05:00");
    const {supabase}=database([
      visit("source","x","2026-11-24T14:00:00.123002Z"),visit("too-early","x","2026-11-24T14:00:00.123000Z"),
      visit("next","x","2026-11-24T14:00:00.123003Z")
    ]);
    const result=await getNextVisitsForRoster(supabase,studio,[source],time(10));
    expect(result.get(source.id)?.id).toBe("next");
  });
  it("does no read without a client, and batches a large roster of clients", async () => {
    const {supabase,requests}=database([]);
    expect((await getNextVisitsForRoster(supabase,studio,[{id:"orphan",client_id:null,starts_at:time(9)}],time(10))).size).toBe(0);
    expect(requests).toHaveLength(0);
    const sources=Array.from({length:177},(_,i)=>visit("source-"+i,"client-"+i,time(9)));
    await getNextVisitsForRoster(supabase,studio,sources,time(10));
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.length).toBeLessThan(10);
  });
  it("throws on a failed page instead of presenting a partial set as no more bookings", async () => {
    const first=visit("am","a",time(8)), late=visit("pm","a",time(16));
    const rows=Array.from({length:30},(_,i)=>visit("other-"+i,"a",time(10,i)));
    const {supabase}=database(rows,2);
    await expect(getNextVisitsForRoster(supabase,studio,[first,late],time(7))).rejects.toThrow("Failed to load next visits");
  });
});
