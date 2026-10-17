import { describe, expect, it } from "vitest";
import {
  campaignBindingVerdict,
  campaignBindingsFromSnapshot,
  type BindingSender,
  type RecordedCampaignBinding,
} from "@/lib/sms/campaign-binding";
import { bindingSenderFrom, campaignBindingFor, parseLiveRegistrationState } from "@/lib/sms/sender-registration";

// SMS-CAMPAIGN-BINDING-01 (HON-50 G4a): the pure verdict and the strict
// snapshot parser that #858's send-time route relies on. Everything that is
// not a well-formed, current, verified binding fails closed.

const STUDIO = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const SENDER = "aaaaaaaa-1111-4222-8333-444444444444";
const MG = `MG${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;

const sender: BindingSender = {
  id: SENDER,
  studioId: STUDIO,
  phoneNumber: "+12125550101",
  messagingServiceSid: MG,
  provisionedAt: "2026-10-01T10:00:00+00:00",
};
const verified: RecordedCampaignBinding = {
  senderId: SENDER,
  studioId: STUDIO,
  phoneNumber: "+12125550101",
  messagingServiceSid: MG,
  campaignSid: QE,
  campaignStatus: "verified",
  checkedAt: "2026-10-02T10:00:00.123456+00:00",
  verifiedAt: "2026-10-02T10:00:00.123456+00:00",
};

describe("campaignBindingVerdict", () => {
  it("ok for a verified binding of this sender, its number and service, checked after provisioning", () => {
    expect(campaignBindingVerdict(verified, sender)).toEqual({ ok: true });
    // Equal instants are not "before": a check in the same instant counts.
    expect(campaignBindingVerdict({ ...verified, checkedAt: "2026-10-01T10:00:00Z" }, sender)).toEqual({ ok: true });
  });

  it("missing without a record", () => {
    expect(campaignBindingVerdict(null, sender)).toEqual({ ok: false, reason: "missing" });
  });

  it("mismatch for another studio, sender, number or service", () => {
    for (const r of [
      { ...verified, studioId: "11111111-2222-4333-8444-555555555555" },
      { ...verified, senderId: "11111111-2222-4333-8444-555555555555" },
      { ...verified, phoneNumber: "+12125550102" },
      { ...verified, messagingServiceSid: `MG${"c".repeat(32)}` },
    ]) {
      expect(campaignBindingVerdict(r, sender), JSON.stringify(r)).toEqual({ ok: false, reason: "mismatch" });
    }
    expect(campaignBindingVerdict(verified, { ...sender, messagingServiceSid: null })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("compares numbers as canonical E.164: an unparseable side never matches, even itself", () => {
    expect(campaignBindingVerdict({ ...verified, phoneNumber: "+1 (212) 555-0101" }, sender)).toEqual({ ok: false, reason: "mismatch" });
    expect(campaignBindingVerdict({ ...verified, phoneNumber: "garbage" }, { ...sender, phoneNumber: "garbage" })).toEqual({ ok: false, reason: "mismatch" });
    expect(campaignBindingVerdict(verified, { ...sender, phoneNumber: null })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("unverified for every non-verified status, or a verified row missing its campaign or time", () => {
    for (const campaignStatus of ["pending", "in_progress", "failed", "none"] as const) {
      expect(campaignBindingVerdict({ ...verified, campaignStatus, verifiedAt: null }, sender), campaignStatus).toEqual({ ok: false, reason: "unverified" });
    }
    expect(campaignBindingVerdict({ ...verified, campaignSid: null }, sender)).toEqual({ ok: false, reason: "unverified" });
    expect(campaignBindingVerdict({ ...verified, verifiedAt: null }, sender)).toEqual({ ok: false, reason: "unverified" });
  });

  it("stale when checked before the sender was (re)provisioned or adopted, or a time is unknown or unparseable", () => {
    expect(campaignBindingVerdict({ ...verified, checkedAt: "2026-09-30T10:00:00Z" }, sender)).toEqual({ ok: false, reason: "stale" });
    expect(campaignBindingVerdict(verified, { ...sender, provisionedAt: null })).toEqual({ ok: false, reason: "stale" });
    expect(campaignBindingVerdict(verified, { ...sender, provisionedAt: "yesterday-ish" })).toEqual({ ok: false, reason: "stale" });
    expect(campaignBindingVerdict({ ...verified, checkedAt: "not a time" }, sender)).toEqual({ ok: false, reason: "stale" });
    expect(campaignBindingVerdict({ ...verified, verifiedAt: "not a time" }, sender)).toEqual({ ok: false, reason: "stale" });
    // Instants, not strings: an offset that sorts AFTER as text is still before.
    expect(campaignBindingVerdict({ ...verified, checkedAt: "2026-10-01T11:00:00+02:00" }, sender)).toEqual({ ok: false, reason: "stale" });
  });

  it("has no wall-clock expiry: an old but current, verified binding is ok", () => {
    expect(campaignBindingVerdict({ ...verified, checkedAt: "2020-01-01T00:00:00Z", verifiedAt: "2020-01-01T00:00:00Z" }, { ...sender, provisionedAt: "2019-01-01T00:00:00Z" })).toEqual({ ok: true });
  });
});

const rawRow = {
  sender_id: SENDER,
  studio_id: STUDIO,
  phone_number: "+12125550101",
  messaging_service_sid: MG,
  campaign_sid: QE,
  campaign_status: "verified",
  checked_at: "2026-10-02T10:00:00.123456+00:00",
  verified_at: "2026-10-02T10:00:00.123456+00:00",
};
const listed = new Set([SENDER]);

describe("campaignBindingsFromSnapshot", () => {
  it("absent key (0217 without 0229) is []; a well-formed row parses", () => {
    expect(campaignBindingsFromSnapshot({ senders: [] }, STUDIO, listed)).toEqual([]);
    expect(campaignBindingsFromSnapshot({ campaign_bindings: [rawRow] }, STUDIO, listed)).toEqual([verified]);
  });

  it("anything malformed, foreign, unlisted or duplicated is unreadable (null)", () => {
    for (const value of [
      null,
      "x",
      { campaign_bindings: "x" },
      { campaign_bindings: [null] },
      { campaign_bindings: [{ ...rawRow, studio_id: "11111111-2222-4333-8444-555555555555" }] },
      { campaign_bindings: [{ ...rawRow, sender_id: "11111111-2222-4333-8444-555555555555" }] },
      { campaign_bindings: [rawRow, rawRow] },
      { campaign_bindings: [{ ...rawRow, campaign_status: "VERIFIED" }] },
      { campaign_bindings: [{ ...rawRow, phone_number: "" }] },
      { campaign_bindings: [{ ...rawRow, checked_at: null }] },
      { campaign_bindings: [{ ...rawRow, campaign_sid: 7 }] },
    ]) {
      expect(campaignBindingsFromSnapshot(value, STUDIO, listed), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("parseLiveRegistrationState carries the bindings, and fails closed with them", () => {
  const snapshotSender = {
    id: SENDER,
    studio_id: STUDIO,
    status: "active",
    phone_number: "+12125550101",
    messaging_service_sid: MG,
    provisioned_at: "2026-10-01T10:00:00+00:00",
  };
  const snapshot = { senders: [snapshotSender], registrations: [], campaign_bindings: [rawRow] };

  it("parses senders' provisioned_at and the bindings; the verdict works end to end", () => {
    const state = parseLiveRegistrationState(snapshot, STUDIO);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.campaignBindings).toEqual([verified]);
    const s = bindingSenderFrom(state.senders[0]);
    expect(s).toEqual(sender);
    expect(campaignBindingVerdict(campaignBindingFor(state, s.id), s)).toEqual({ ok: true });
  });

  it("a pre-0229 snapshot (no key, no provisioned_at) reads, and every verdict is missing", () => {
    const { provisioned_at: _unused, ...pre0229Sender } = snapshotSender;
    void _unused;
    const state = parseLiveRegistrationState({ senders: [pre0229Sender], registrations: [] }, STUDIO);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.campaignBindings).toEqual([]);
    const s = bindingSenderFrom(state.senders[0]);
    expect(s.provisionedAt).toBeNull();
    expect(campaignBindingVerdict(campaignBindingFor(state, s.id), s)).toEqual({ ok: false, reason: "missing" });
  });

  it("two rows for one sender, or a binding for an unlisted sender, make the whole read unreadable", () => {
    expect(parseLiveRegistrationState({ ...snapshot, campaign_bindings: [rawRow, rawRow] }, STUDIO)).toEqual({ ok: false });
    expect(parseLiveRegistrationState({ ...snapshot, senders: [] }, STUDIO)).toEqual({ ok: false });
    expect(parseLiveRegistrationState({ ...snapshot, campaign_bindings: {} }, STUDIO)).toEqual({ ok: false });
  });
});
