// HON-7. The bell reader: per-recipient cancellation rows, owner-only types, and nothing else changed.
// An in-memory table evaluates the exact filters scopeNotificationsToViewer applies, so these are behavioural, not textual.

import { describe, expect, it } from "vitest";
import { OWNER_ONLY_NOTIFICATION_EVENT_TYPES, scopeNotificationsToViewer } from "@/lib/notifications/owner-only-events";

const OWNER_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const OWNER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const STAFF = "bbbbbbbb-0000-4000-8000-0000000000cc";

type Row = { id: string; event_type: string; practitioner_id: string | null; read_at: string | null; dedupe_key?: string | null };

function table(rows: Row[]) {
  const preds: Array<(r: Row) => boolean> = [];
  const q = {
    eq() { return q; },
    is(col: string, v: null) { preds.push((r) => (r as never)[col] === v); return q; },
    not(col: string, op: string, v: string) {
      expect(op).toBe("in");
      const set = v.slice(1, -1).split(",");
      preds.push((r) => !set.includes((r as never)[col]));
      return q;
    },
    or(f: string) {
      const terms = f.split(",").map((t) => t.split("."));
      preds.push((r) => terms.some(([col, op, ...rest]) => {
        const cell = ((r as never)[col] ?? null) as string | null;
        if (op === "not" && rest[0] === "like") {
          // PostgREST: a NULL cell never satisfies a negated LIKE (the filter list carries dedupe_key.is.null for that case).
          const pat = rest.slice(1).join(".").replace(/\*$/, "");
          return cell !== null && !cell.startsWith(pat);
        }
        const val = rest.join(".");
        return op === "neq" ? cell !== val : op === "is" ? cell === null : cell === val;
      }));
      return q;
    },
    rows() { return rows.filter((r) => preds.every((p) => p(r))); },
    markRead() { const hit = q.rows(); for (const r of hit) r.read_at = "now"; return hit.length; },
  };
  return q;
}

type Fake = ReturnType<typeof table>;
const scope = (t: Fake, owner: boolean, viewer: string): Fake =>
  scopeNotificationsToViewer(t as unknown as Parameters<typeof scopeNotificationsToViewer>[0], owner, viewer) as unknown as Fake;

const seed = (): Row[] => [
  { id: "1", event_type: "new_booking", practitioner_id: STAFF, read_at: null },
  { id: "2", event_type: "new_booking", practitioner_id: null, read_at: null },
  { id: "3", event_type: "appointment_cancelled", practitioner_id: OWNER_A, read_at: null, dedupe_key: "appointment_cancelled:a1:" + OWNER_A + ":1762614000123" },
  { id: "4", event_type: "appointment_cancelled", practitioner_id: OWNER_B, read_at: null, dedupe_key: "appointment_cancelled:a1:" + OWNER_B + ":1762614000123" },
  { id: "5", event_type: "appointment_cancelled", practitioner_id: null, read_at: null, dedupe_key: "appointment_cancelled:a2:studio:1762614000123" },
  // LEGACY rows (written before the recipient key existed): practitioner_id is the APPOINTMENT's practitioner, studio-wide visibility, null key.
  { id: "9", event_type: "appointment_cancelled", practitioner_id: STAFF, read_at: null },
  { id: "10", event_type: "appointment_cancelled", practitioner_id: OWNER_B, read_at: null },
  { id: "11", event_type: "appointment_cancelled", practitioner_id: null, read_at: null, dedupe_key: "stripe:legacy-format" },
  { id: "6", event_type: "card_added", practitioner_id: OWNER_A, read_at: null },
  { id: "7", event_type: "waitlist_offer_declined", practitioner_id: OWNER_A, read_at: null },
  { id: "8", event_type: "intake_submitted", practitioner_id: null, read_at: null },
];

const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

describe("scopeNotificationsToViewer", () => {
  it("an owner sees only her own cancellation rows plus the studio-wide one, and every other type", () => {
    const a = scope(table(seed()), true, OWNER_A).rows();
    expect(ids(a)).toEqual(["1", "10", "11", "2", "3", "5", "6", "7", "8", "9"]);
    const b = scope(table(seed()), true, OWNER_B).rows();
    expect(ids(b)).toEqual(["1", "10", "11", "2", "4", "5", "6", "7", "8", "9"]);
  });

  it("a non-owner never sees the owner-only types, including waitlist_offer_declined, nor another recipient's cancellation row (legacy studio-wide rows are unchanged)", () => {
    expect(OWNER_ONLY_NOTIFICATION_EVENT_TYPES).toContain("waitlist_offer_declined");
    expect(OWNER_ONLY_NOTIFICATION_EVENT_TYPES).toContain("waitlist_withdrawal_requested");
    const s = scope(table(seed()), false, STAFF).rows();
    // row 5 is a cancellation with no recipient (the no-owner fallback): it names a client, so it is OWNER-ONLY
    expect(ids(s)).toEqual(["1", "10", "11", "2", "8", "9"]);
  });

  it("new_booking, intake and every non-cancellation type: the list and the unread badge are identical before and after", () => {
    const before = (owner: boolean) =>
      seed().filter((r) => r.event_type !== "appointment_cancelled" && (owner || !["card_added", "card_replaced", "waitlist_offer_declined"].includes(r.event_type)));
    const after = (owner: boolean, viewer: string) =>
      scope(table(seed()), owner, viewer).rows().filter((r) => r.event_type !== "appointment_cancelled");
    for (const [owner, viewer] of [[true, OWNER_A], [true, OWNER_B], [false, STAFF]] as const) {
      expect(ids(after(owner, viewer))).toEqual(ids(before(owner)));
      expect(after(owner, viewer).filter((r) => r.read_at === null).length).toBe(before(owner).filter((r) => r.read_at === null).length);
    }
  });

  it("LEGACY cancellation rows stay visible to every owner, whichever practitioner they name, in the list and the unread badge (they were studio-wide before)", () => {
    for (const viewer of [OWNER_A, OWNER_B]) {
      const seen = ids(scope(table(seed()).is("read_at", null), true, viewer).rows());
      expect(seen).toEqual(expect.arrayContaining(["9", "10", "11"]));
    }
    // a NEW row for the other owner is still hidden, so the legacy rule did not reopen the recipient filter
    expect(ids(scope(table(seed()), true, OWNER_A).rows())).not.toContain("4");
  });

  it("each owner's row has its own read state: marking all read as one owner leaves the other's unread", () => {
    const rows = seed();
    const marked = scope(table(rows).is("read_at", null), true, OWNER_A).markRead();
    expect(marked).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === "3")?.read_at).toBe("now");
    expect(rows.find((r) => r.id === "4")?.read_at).toBeNull();
    expect(ids(scope(table(rows).is("read_at", null), true, OWNER_B).rows())).toContain("4");
  });

  it("refuses a viewer id that is not a uuid (it is interpolated into a filter string)", () => {
    expect(() => scope(table(seed()), true, "x,practitioner_id.is.null")).toThrow();
  });
});

describe("waitlist_offer_declined wording and link (the decline command writes the row; these are the strings its DB test pins)", () => {
  it("title, empty body and link are exactly the agreed strings, and no name variant exists", async () => {
    const m = await import("@/lib/notifications/waitlist-offer-declined");
    expect(m.WAITLIST_OFFER_DECLINED_EVENT).toBe("waitlist_offer_declined");
    expect(m.WAITLIST_OFFER_DECLINED_TITLE).toBe("A waitlist response needs your attention");
    expect(m.WAITLIST_OFFER_DECLINED_BODY).toBe("");
    expect(m.WAITLIST_OFFER_DECLINED_HREF).toBe("/settings/waitlist#follow-up");
    // The title is the same for everyone: a function of a name, or any other export that could carry one, is a regression.
    expect(typeof m.WAITLIST_OFFER_DECLINED_TITLE).toBe("string");
    expect(Object.keys(m).sort()).toEqual(["WAITLIST_OFFER_DECLINED_BODY", "WAITLIST_OFFER_DECLINED_EVENT", "WAITLIST_OFFER_DECLINED_HREF", "WAITLIST_OFFER_DECLINED_TITLE"]);
  });
});
