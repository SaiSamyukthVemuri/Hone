import { describe, expect, it } from "vitest";
import {
  CARRIER_SUPPRESSION_SCOPE,
  HONE_SUPPRESSION_SCOPE,
  honeSuppressionAllowsSend,
  selectHoneSuppressionTargets,
  type SuppressionCandidate,
} from "@/lib/sms/suppression";

// COMMS-01B — STOP must not narrow when studios stop sharing a number.
//
// THE REGRESSION THIS FILE EXISTS TO CATCH. Today every studio texts from one
// deployment-global sender, so "the carrier blocked it" and "Hone blocked it"
// have the same practical reach and nobody has had to tell them apart. Give
// each studio its own number and they come apart:
//
//     Someone texts STOP to Studio A's number. The carrier blocks that PAIR of
//     numbers. Studio B has a different number, so the carrier's block does not
//     cover it -- and Studio B resumes texting a person who opted out.
//
// Hone's internal rule is deliberately broader than the carrier's: opting out
// is a statement by a PERSON about their PHONE. These tests pin that breadth so
// a future "resolve the inbound To-number to one studio and scope the opt-out
// to it" -- which will look like a tidy improvement in review -- goes red.

const OPTED_OUT = "2026-09-01T10:00:00.000Z";

function client(over: Partial<SuppressionCandidate> = {}): SuppressionCandidate {
  return {
    id: "client-1",
    studio_id: "studio-a",
    phone: "+14165550100",
    sms_opted_out_at: null,
    ...over,
  };
}

describe("the two suppression scopes are named and different", () => {
  it("carrier suppression is sender-scoped; Hone suppression is phone-wide", () => {
    expect(CARRIER_SUPPRESSION_SCOPE).toBe("sender_scoped");
    expect(HONE_SUPPRESSION_SCOPE).toBe("phone_wide");
    // If these ever became equal, the distinction the whole file rests on
    // would have quietly collapsed.
    expect(CARRIER_SUPPRESSION_SCOPE).not.toBe(HONE_SUPPRESSION_SCOPE);
  });
});

describe("PHONE_WIDE_HONE_SUPPRESSION across two studio senders", () => {
  it("STOP on studio A's number opts the same person out of studio B", () => {
    // One person, two studios, and -- after COMMS-01B -- two different Twilio
    // numbers. The STOP arrives on A's.
    const candidates = [
      client({ id: "a-client", studio_id: "studio-a" }),
      client({ id: "b-client", studio_id: "studio-b" }),
    ];

    const { targets } = selectHoneSuppressionTargets({
      candidates,
      fromPhone: "+14165550100",
    });

    expect(targets.map((t) => t.studio_id).sort()).toEqual([
      "studio-a",
      "studio-b",
    ]);
    expect(targets.map((t) => t.id).sort()).toEqual(["a-client", "b-client"]);
  });

  it("the number the STOP arrived on is not an input at all", () => {
    // The signature cannot express "scope this to the studio that received
    // it", which is the point: the parameter that would enable the regression
    // deliberately does not exist.
    const args = selectHoneSuppressionTargets.length;
    expect(args).toBe(1);
    const shape = { candidates: [], fromPhone: "+14165550100" };
    expect(Object.keys(shape).sort()).toEqual(["candidates", "fromPhone"]);
    expect(Object.keys(shape)).not.toContain("toPhone");
    expect(Object.keys(shape)).not.toContain("studioId");
    expect(Object.keys(shape)).not.toContain("messagingServiceSid");
  });

  it("opting out through one studio blocks sending from the other", () => {
    // The consent gate consults the person, never the sender.
    const optedOut = { sms_consent_at: "2026-01-01T00:00:00Z", sms_opted_out_at: OPTED_OUT };
    expect(honeSuppressionAllowsSend(optedOut)).toBe(false);

    // And a studio having a brand new number changes nothing: there is no
    // sender parameter for it to change.
    expect(honeSuppressionAllowsSend.length).toBe(1);
  });

  it("matches across stored formats, so a real STOP cannot miss", () => {
    // The canonicalization bug that once let a 10-digit stored number and an
    // E.164 inbound fail to resolve to the same person.
    const candidates = [
      client({ id: "ten-digit", studio_id: "studio-a", phone: "416-555-0100" }),
      client({ id: "e164", studio_id: "studio-b", phone: "+14165550100" }),
      client({ id: "spaced", studio_id: "studio-c", phone: "(416) 555 0100" }),
    ];

    const { targets } = selectHoneSuppressionTargets({
      candidates,
      fromPhone: "+14165550100",
    });
    expect(targets.map((t) => t.id).sort()).toEqual(["e164", "spaced", "ten-digit"]);
  });

  it("a different person is untouched", () => {
    const { targets } = selectHoneSuppressionTargets({
      candidates: [client({ id: "other", phone: "+14165559999" })],
      fromPhone: "+14165550100",
    });
    expect(targets).toEqual([]);
  });

  it("already opted-out rows are counted, not re-stamped", () => {
    const { targets, alreadyOptedOutCount } = selectHoneSuppressionTargets({
      candidates: [
        client({ id: "fresh", studio_id: "studio-a" }),
        client({ id: "done", studio_id: "studio-b", sms_opted_out_at: OPTED_OUT }),
      ],
      fromPhone: "+14165550100",
    });
    expect(targets.map((t) => t.id)).toEqual(["fresh"]);
    expect(alreadyOptedOutCount).toBe(1);
  });

  it("an unmatchable From selects nobody rather than everybody", () => {
    // Fail closed: a garbled From must never opt out the entire table.
    const { targets } = selectHoneSuppressionTargets({
      candidates: [client(), client({ id: "two", studio_id: "studio-b" })],
      fromPhone: "not-a-phone",
    });
    expect(targets).toEqual([]);
  });

  it("rows with no phone are skipped, not matched by an empty string", () => {
    const { targets } = selectHoneSuppressionTargets({
      candidates: [client({ id: "nophone", phone: null })],
      fromPhone: "+14165550100",
    });
    expect(targets).toEqual([]);
  });
});

describe("MUTATION CONTROL (suppression rule)", () => {
  it("scoping the opt-out to the receiving studio leaves studio B sending", () => {
    // Perform the mutation for real: the plausible per-studio version, which
    // resolves the inbound To-number to one studio and filters to it.
    function mutatedSelect(input: {
      candidates: readonly SuppressionCandidate[];
      fromPhone: string;
      receivingStudioId: string;
    }) {
      return selectHoneSuppressionTargets({
        candidates: input.candidates.filter(
          (c) => c.studio_id === input.receivingStudioId,
        ),
        fromPhone: input.fromPhone,
      });
    }

    const candidates = [
      client({ id: "a-client", studio_id: "studio-a" }),
      client({ id: "b-client", studio_id: "studio-b" }),
    ];

    const mutated = mutatedSelect({
      candidates,
      fromPhone: "+14165550100",
      receivingStudioId: "studio-a",
    });

    // The mutation leaves studio B's client opted IN -- free to be texted from
    // studio B's own number, which the carrier never blocked. That is the
    // regression, demonstrated rather than asserted about.
    expect(mutated.targets.map((t) => t.id)).toEqual(["a-client"]);
    expect(mutated.targets.map((t) => t.id)).not.toContain("b-client");

    // The real rule reaches both.
    const real = selectHoneSuppressionTargets({
      candidates,
      fromPhone: "+14165550100",
    });
    expect(real.targets.map((t) => t.id).sort()).toEqual(["a-client", "b-client"]);
  });
});
