import type {
  ClaimRow,
  FailResult,
  FinalizeResult,
  ProvisioningStore,
} from "@/lib/sms/provisioning";

// An in-memory ProvisioningStore written to migration 0191's contract.
//
// A NEW FILE rather than an extraction. `tests/lib/sms/provisioning.test.ts`
// carries its own copy of this class; lifting it out would mean editing a
// merged, heavily-reviewed test file for no behavioural gain, so the copy is
// left alone and future suites use this one. Worth folding together the next
// time that file is opened for its own reasons.
//
// It models what the DATABASE decides, and only that: owner re-derivation, the
// write-once number binding, claim exclusivity, lease expiry and takeover,
// generation fencing, and the readiness rule. It cannot prove any of them --
// tests/db/studio-sms-sender.db.test.ts does that against PostgreSQL. What it
// proves is ORCHESTRATION: that a caller respects the contract it is given.

export type Membership = { userId: string; studioId: string; role: "owner" | "practitioner" };

export type Row = {
  id: string;
  studioId: string;
  status: "off" | "selecting" | "provisioning" | "active" | "suspended" | "error" | "releasing" | "released";
  claimKey: string;
  claimedPhoneNumber: string | null;
  phoneNumber: string | null;
  phoneNumberSid: string | null;
  messagingServiceSid: string | null;
  provisionedAt: string | null;
  lastTestOkAt: string | null;
  lastErrorCode: string | null;
  claimAt: number;
  leaseGeneration: number;
};

export class InMemoryProvisioningStore implements ProvisioningStore {
  rows: Row[] = [];
  private seq = 0;
  /** Virtual clock, so lease expiry is tested without waiting. */
  now = 0;
  readonly leaseMs = 5 * 60 * 1000;
  /** Every renewLease answer, so a test can prove the fence was consulted. */
  readonly fenceCalls: Array<{ generation: number; phoneNumber: string; granted: boolean }> = [];

  /**
   * Model the LOST RESPONSE: finalize COMMITS, and the caller is told
   * `invalid_input` anyway. This is not hypothetical — createProvisioningStore
   * maps both a transport error and an unrecognised payload to `invalid_input`,
   * and neither says anything about whether the transaction committed.
   */
  loseFinalizeResponse = false;

  /**
   * finalize fails and NOTHING commits: the row stays `provisioning`. The
   * caller sees the same `invalid_input` as the lost-response case, which is
   * the point — the two are indistinguishable from the answer alone, so only
   * the STORE can say which one happened.
   */
  failFinalizeWithoutCommitting = false;

  /**
   * Force what the parking write ANSWERS, without changing whether the row
   * moved. Models `createProvisioningStore.fail`, which maps a transport error
   * or an unrecognised payload to `invalid_input` — an answer that says nothing
   * about whether the transition landed.
   */
  failReturns: FailResult | null = null;

  constructor(private readonly members: Membership[]) {}

  private nextKey(): string {
    this.seq += 1;
    return `hone-sms-${this.seq.toString(16).padStart(32, "0")}`;
  }

  live(studioId: string): Row | undefined {
    return this.rows.find((r) => r.studioId === studioId && r.status !== "released");
  }

  async claim(input: {
    studioId: string;
    actorUserId: string;
    country: string;
    areaCode: string | null;
    phoneNumber: string;
  }): Promise<ClaimRow> {
    const refuse = (result: ClaimRow["result"]): ClaimRow => ({
      result,
      senderId: null,
      claimKey: null,
      senderStatus: null,
      leaseGeneration: null,
    });

    if (!/^[A-Z]{2}$/.test(input.country)) return refuse("invalid_input");
    // 0191: v_number := nullif(btrim(coalesce(p_phone_number,'')),'')
    // The claim TRIMS and stores the trimmed value. renewLease then compares
    // `claimed_phone_number = p_phone_number` with NO trim, so a caller that
    // keeps carrying its raw value fails its own fence. Modelling the trim here
    // is what makes that reachable in a test; the earlier version validated the
    // raw string and refused whitespace outright, which hid the defect.
    const number = input.phoneNumber.trim();
    if (!/^\+[1-9][0-9]{7,14}$/.test(number)) return refuse("invalid_input");

    // Authorization is re-derived from (studio, authenticated user). Adoption
    // gets no privileged entry: an operator acting for a studio is subject to
    // the same rule as the owner.
    const member = this.members.find(
      (m) => m.studioId === input.studioId && m.userId === input.actorUserId,
    );
    if (!member) {
      const studioExists = this.members.some((m) => m.studioId === input.studioId);
      return refuse(studioExists ? "not_a_member" : "studio_not_found");
    }
    if (member.role !== "owner") return refuse("not_owner");

    const existing = this.live(input.studioId);
    if (!existing) {
      const row: Row = {
        id: `sender-${this.rows.length + 1}`,
        studioId: input.studioId,
        status: "provisioning",
        claimKey: this.nextKey(),
        claimedPhoneNumber: number,
        phoneNumber: null,
        phoneNumberSid: null,
        messagingServiceSid: null,
        provisionedAt: null,
        lastTestOkAt: null,
        lastErrorCode: null,
        claimAt: this.now,
        leaseGeneration: 1,
      };
      this.rows.push(row);
      return {
        result: "claimed",
        senderId: row.id,
        claimKey: row.claimKey,
        senderStatus: row.status,
        leaseGeneration: row.leaseGeneration,
      };
    }

    // WRITE-ONCE. A retry or takeover must carry the bound number; a different
    // one is how one claim buys two.
    if (
      existing.claimedPhoneNumber !== null &&
      existing.claimedPhoneNumber !== number
    ) {
      return {
        result: "number_mismatch",
        senderId: existing.id,
        claimKey: null,
        senderStatus: existing.status,
        leaseGeneration: null,
      };
    }

    if (existing.status === "active") {
      return {
        result: "already_active",
        senderId: existing.id,
        claimKey: existing.claimKey,
        senderStatus: existing.status,
        leaseGeneration: existing.leaseGeneration,
      };
    }

    if (existing.status === "provisioning") {
      if (this.now - existing.claimAt < this.leaseMs) {
        // A live attempt EXCLUDES this one; it performs no provider effect.
        return {
          result: "claim_held",
          senderId: existing.id,
          claimKey: null,
          senderStatus: existing.status,
          leaseGeneration: null,
        };
      }
      existing.claimAt = this.now;
      existing.leaseGeneration += 1;
      return {
        result: "claimed",
        senderId: existing.id,
        claimKey: existing.claimKey,
        senderStatus: existing.status,
        leaseGeneration: existing.leaseGeneration,
      };
    }

    if (existing.status === "off" || existing.status === "selecting" || existing.status === "error") {
      existing.status = "provisioning";
      existing.claimedPhoneNumber ??= number;
      existing.claimAt = this.now;
      existing.leaseGeneration += 1;
      return {
        result: "claimed",
        senderId: existing.id,
        claimKey: existing.claimKey,
        senderStatus: existing.status,
        leaseGeneration: existing.leaseGeneration,
      };
    }

    return {
      result: "not_claimable",
      senderId: existing.id,
      claimKey: null,
      senderStatus: existing.status,
      leaseGeneration: null,
    };
  }

  async renewLease(input: {
    studioId: string;
    claimKey: string;
    leaseGeneration: number;
    phoneNumber: string;
  }): Promise<boolean> {
    const row = this.rows.find(
      (r) => r.studioId === input.studioId && r.claimKey === input.claimKey && r.status !== "released",
    );
    const granted =
      row !== undefined &&
      row.status === "provisioning" &&
      row.leaseGeneration === input.leaseGeneration &&
      row.claimedPhoneNumber === input.phoneNumber;
    this.fenceCalls.push({
      generation: input.leaseGeneration,
      phoneNumber: input.phoneNumber,
      granted,
    });
    // ATOMIC check-and-RENEW: the takeover boundary stays outside the bounded
    // provider call rather than somewhere inside it.
    if (granted && row) row.claimAt = this.now;
    return granted;
  }

  async finalize(input: {
    studioId: string;
    claimKey: string;
    leaseGeneration: number;
    phoneNumber: string;
    phoneNumberSid: string;
    messagingServiceSid: string;
    testOk: boolean;
  }): Promise<FinalizeResult> {
    if (this.failFinalizeWithoutCommitting) return "invalid_input";
    const row = this.rows.find(
      (r) => r.studioId === input.studioId && r.claimKey === input.claimKey && r.status !== "released",
    );
    if (!row) return "claim_not_found";
    if (row.leaseGeneration !== input.leaseGeneration) return "lease_lost";

    if (row.status === "active") {
      return row.phoneNumberSid === input.phoneNumberSid &&
        row.messagingServiceSid === input.messagingServiceSid &&
        row.phoneNumber === input.phoneNumber
        ? "already_active"
        : "conflict";
    }
    if (row.status !== "provisioning") return "not_provisioning";
    if (
      row.phoneNumberSid !== null &&
      (row.phoneNumberSid !== input.phoneNumberSid ||
        row.messagingServiceSid !== input.messagingServiceSid ||
        row.phoneNumber !== input.phoneNumber)
    ) {
      return "conflict";
    }

    row.phoneNumber ??= input.phoneNumber;
    row.phoneNumberSid ??= input.phoneNumberSid;
    row.messagingServiceSid ??= input.messagingServiceSid;
    row.provisionedAt ??= "2026-01-01T00:00:00.000Z";
    if (input.testOk) row.lastTestOkAt = "2026-01-01T00:00:00.000Z";

    // THE READINESS RULE, as 0191's CHECK states it: `active` is unreachable
    // without every identifier AND a successful test.
    const ready =
      row.phoneNumber !== null &&
      row.phoneNumberSid !== null &&
      row.messagingServiceSid !== null &&
      row.provisionedAt !== null &&
      row.lastTestOkAt !== null;

    if (ready) {
      row.status = "active";
      row.lastErrorCode = null;
      // THE COMMIT LANDED. Only the answer was lost.
      if (this.loseFinalizeResponse) return "invalid_input";
      return input.testOk ? "activated" : "provisioned_untested";
    }
    if (this.loseFinalizeResponse) return "invalid_input";
    return "provisioned_untested";
  }

  async fail(input: {
    studioId: string;
    claimKey: string;
    leaseGeneration: number;
    errorCode: string;
  }): Promise<FailResult> {
    if (this.failReturns !== null) return this.failReturns;
    const row = this.rows.find(
      (r) => r.studioId === input.studioId && r.claimKey === input.claimKey && r.status !== "released",
    );
    if (!row) return "claim_not_found";
    if (row.leaseGeneration !== input.leaseGeneration) return "lease_lost";
    if (row.status === "active") return "already_active";
    if (row.status !== "provisioning") return "not_provisioning";
    row.status = "error";
    row.lastErrorCode = input.errorCode;
    return "failed";
  }
}
