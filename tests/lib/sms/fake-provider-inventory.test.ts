import { describe, expect, it } from "vitest";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";

// FAKE-PROVIDER FIDELITY — one number, one truth.
//
// The fake stands in for Twilio in every orchestration test, so a behaviour it
// permits that the real provider cannot is worse than a missing test: it makes
// green mean nothing in exactly the place we rely on it. `preOwnedNumbers` was
// added for the adoption path and taught only `lookupOwnedNumber` about it, so
// the same number could be simultaneously reported as already owned AND
// advertised as available AND purchased — three answers no account can give.
//
// These are cross-path tests on purpose. Each surface alone looked right.

const WILLOW = "+14165550100";
const WILLOW_PN = "PN" + "a".repeat(32);
const FREE = "+14165550777";
const CLAIM = "hone-sms-claim-test";

function preOwned() {
  return new FakeSmsProvisioningProvider({
    preOwnedNumbers: { [WILLOW]: WILLOW_PN },
    accountServices: [{ sid: "MG" + "b".repeat(32), numbers: [WILLOW] }],
  });
}

describe("a pre-owned number is owned on EVERY surface", () => {
  it("ownedNumbers() includes it", () => {
    expect(preOwned().ownedNumbers()).toContain(WILLOW);
  });

  it("isNumberAvailable() says NO", async () => {
    const p = preOwned();
    const r = await p.isNumberAvailable({ country: "CA", phoneNumber: WILLOW });
    expect(r.ok && r.available).toBe(false);
  });

  it("searchAvailableNumbers() never advertises it", async () => {
    const p = preOwned();
    const r = await p.searchAvailableNumbers({ country: "CA", areaCode: "416", limit: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidates.map((c) => c.phoneNumber)).not.toContain(WILLOW);
  });

  it("purchaseNumber() REFUSES it rather than creating a duplicate", async () => {
    const p = preOwned();
    const r = await p.purchaseNumber({ claimKey: CLAIM, phoneNumber: WILLOW });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("number_no_longer_available");
    // And no second resource was conjured under the claim.
    expect(p.ownedNumbers().filter((n) => n === WILLOW)).toHaveLength(1);
  });
});

describe("THE COLLISION: the three answers must agree", () => {
  it("a number cannot be both already-owned and purchasable", async () => {
    const p = preOwned();
    const lookup = await p.lookupOwnedNumber({
      phoneNumber: WILLOW,
      expectedMessagingServiceSid: "MG" + "b".repeat(32),
    });
    // Adoption sees it as owned...
    expect(lookup.ok && lookup.facts.phoneNumberSid).toBe(WILLOW_PN);
    // ...so the purchase path must not see it as buyable.
    const avail = await p.isNumberAvailable({ country: "CA", phoneNumber: WILLOW });
    expect(avail.ok && avail.available).toBe(false);
    const buy = await p.purchaseNumber({ claimKey: CLAIM, phoneNumber: WILLOW });
    expect(buy.ok).toBe(false);
  });
});

describe("genuinely available numbers are unaffected", () => {
  it("a free number is still available, searchable and purchasable", async () => {
    const p = preOwned();
    const avail = await p.isNumberAvailable({ country: "CA", phoneNumber: FREE });
    expect(avail.ok && avail.available).toBe(true);

    const buy = await p.purchaseNumber({ claimKey: CLAIM, phoneNumber: FREE });
    expect(buy.ok).toBe(true);
    expect(p.ownedNumbers()).toContain(FREE);

    // And once bought it stops being available -- the pre-existing rule.
    const after = await p.isNumberAvailable({ country: "CA", phoneNumber: FREE });
    expect(after.ok && after.available).toBe(false);
  });

  it("a fake with NO preOwnedNumbers behaves exactly as before", async () => {
    const p = new FakeSmsProvisioningProvider();
    expect(p.ownedNumbers()).toEqual([]);
    const buy = await p.purchaseNumber({ claimKey: CLAIM, phoneNumber: FREE });
    expect(buy.ok).toBe(true);
  });
});
