import { randomUUID } from "node:crypto";

// The over-invite form's posted values, read ONCE and treated as untrusted.
//
//  - `entryId` values are the owner's picks. They are de-duplicated here, and the SERVER re-validates every one (studio, owner, waiting,
//    consent) before anything is sent. A posted id is a request, never a fact.
//  - `shownFit` / `shownActive` / `shownExtra` are only the numbers the owner SAW. They feed the "did it change" re-ask and nothing else: they
//    never set what is sent, how many are sent, or any allowance.
//  - `batchKey` is random per render. It carries no authority and is not derived from any id.
//  - `confirmed` must be exactly "on" (the checkbox). Anything else is not a confirmation.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNT = /^\d{1,9}$/;

export type ShownNumbers = { fit: number; active: number; extra: number };

export type OverInviteSubmission = {
  batchKey: string;
  confirmed: boolean;
  entryIds: string[];
  shown: ShownNumbers | null;
  /** True when at least one posted id was not a well-formed id (dropped, never sent). */
  droppedMalformed: boolean;
};

export type ParsedOverInvite = { ok: true; submission: OverInviteSubmission } | { ok: false; reason: "malformed_submission" };

const text = (v: FormDataEntryValue | null): string | null => (typeof v === "string" ? v : null);

/** A fresh, unguessable per-render key. Never derived from an id, a name or a time alone. */
export function newBatchKey(): string {
  return randomUUID();
}

export function parseOverInviteForm(formData: FormData): ParsedOverInvite {
  const batchKey = text(formData.get("batchKey"));
  if (batchKey === null || !UUID.test(batchKey)) return { ok: false, reason: "malformed_submission" };

  const seen = new Set<string>();
  const entryIds: string[] = [];
  let droppedMalformed = false;
  for (const raw of formData.getAll("entryId")) {
    if (typeof raw !== "string" || !UUID.test(raw)) {
      droppedMalformed = true;
      continue;
    }
    const id = raw.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    entryIds.push(id);
  }

  const nums = ["shownFit", "shownActive", "shownExtra"].map((k) => text(formData.get(k)));
  const shown: ShownNumbers | null = nums.every((v) => v !== null && COUNT.test(v))
    ? { fit: Number(nums[0]), active: Number(nums[1]), extra: Number(nums[2]) }
    : null;

  return {
    ok: true,
    submission: { batchKey, confirmed: text(formData.get("confirmed")) === "on", entryIds, shown, droppedMalformed },
  };
}
