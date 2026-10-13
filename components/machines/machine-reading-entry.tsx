"use client";

import { useState } from "react";

import { SectionLabel } from "@/components/ui/section-label";
import { nativeFieldGroups, type FieldDescriptor } from "@/lib/machines/charting";
import type {
  MachineMode,
  MachineProfile,
  ReadingValue,
} from "@/lib/machines/profile-contract";
import type { ReadingSubmission } from "@/lib/machines/machine-queries";

// MPX-03 — recording what the machine showed.
//
// WHAT CHANGED, AND WHY THE OLD RULE IS GONE. Until the storage migration
// landed this panel deliberately rendered no inputs: there were no reading
// columns, and a clinical form that accepted numbers and then dropped them
// would be worse than one that did not ask. The columns exist now, so the
// inputs appear - and the tests that asserted "no input anywhere" were
// REPLACED rather than deleted, with assertions that inputs exist only once a
// machine is chosen and that saving goes through the owner-gated command.
//
// FIELDS COME FROM THE MODEL, NOT FROM THIS FILE. The inputs are generated from
// `nativeFieldGroups`, so the labels, the native units and the decimal
// precision are the machine's own and this component knows nothing about any
// particular machine.
//
// WHAT IT REFUSES TO DO. It does not clamp, round, or reject a value for being
// outside a documented range: a reading is what the practitioner saw. Advisory
// text is shown beside the field, and the only input it will not submit is one
// that is not a finite number - which is malformed rather than surprising.
// Server-side, `recordReadingsAction` validates the field against the model and
// the database refuses a block or machine in another studio.

export type MachineReadingEntryProps = {
  profile: MachineProfile;
  mode: MachineMode;
  /** The treatment block being charted. */
  blockId: string;
  deviceId: string;
  /** Submits one settings group. Injected so the panel owns the transport. */
  onRecord: (input: {
    blockId: string;
    machineId: string;
    modeKey: string;
    groupKey: string;
    channels: number[];
    readings: ReadingSubmission[];
  }) => Promise<{ ok: boolean; error?: string }>;
};

type Draft = Record<string, string>;

/** A blank, non-numeric or non-finite entry is not a reading. */
function parse(raw: string): ReadingValue | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return { kind: "value", value: n };
}

export function MachineReadingEntry({
  profile,
  mode,
  blockId,
  deviceId,
  onRecord,
}: MachineReadingEntryProps) {
  const groups = nativeFieldGroups(profile, mode);
  const [draft, setDraft] = useState<Draft>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // How many captures this mount has recorded. Drives the confirmation copy
  // and distinguishes the first capture from a later revision.
  const [captures, setCaptures] = useState(0);

  const key = (g: string, f: FieldDescriptor) => `${g}::${f.stageKey ?? ""}::${f.key}`;

  const required = groups.flatMap((g) =>
    g.fields.filter((f) => !f.optional).map((f) => key(g.key, f)),
  );
  const ready = required.every((k) => parse(draft[k] ?? "") !== null);

  async function submit() {
    setPending(true);
    setMessage(null);
    const readings: ReadingSubmission[] = [];
    for (const g of groups) {
      for (const f of g.fields) {
        const value = parse(draft[key(g.key, f)] ?? "");
        // A field left blank is simply not recorded. It is NOT written as a
        // zero and NOT written as "not-applicable", because neither is what she
        // told us.
        if (value === null) continue;
        readings.push({
          stageKey: f.stageKey,
          fieldKey: f.key,
          value,
          observationSource: "practitioner-entered",
        });
      }
    }

    const out = await onRecord({
      blockId,
      machineId: deviceId,
      modeKey: mode.key,
      groupKey: "g1",
      channels: [],
      readings,
    });
    setPending(false);
    if (out.ok) {
      setCaptures((n) => n + 1);
      setSaved(true);
      setMessage("Saved to this treatment.");
    } else {
      setMessage(out.error ?? "Could not save those settings.");
    }
  }

  if (saved) {
    return (
      <div
        className="flex flex-col gap-2"
        data-testid="machine-reading-saved"
        role="status"
      >
        {/*
          THE SCHEMA CHANGED UNDER THIS COPY, TWICE, AND IT HAS TRACKED BOTH.

          Originally it claimed "a change of setting is recorded as a new
          reading", which the write-once schema refused. That was corrected to
          say settings could not be overwritten and to send the practitioner to
          free-text notes. Append-only revision CAPTURES then shipped, which
          makes that second version wrong in the opposite direction: the
          structured path now exists, and sending her to prose throws it away
          (Codex, 752a7ef6).

          So: say what is true - the capture is permanent and a change is a NEW
          capture - and give her the control to make one, rather than requiring
          a page reload to reach a path the database supports.
        */}
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          {captures === 1
            ? "Settings saved to this treatment. This capture is permanent and cannot be edited."
            : `${captures} captures saved to this treatment. Each one is permanent and cannot be edited.`}{" "}
          If a setting changes during the treatment, record it as a new capture
          - the earlier one stays in the record.
        </p>
        <button
          type="button"
          onClick={() => {
            // A NEW capture, not an edit of the last one. The draft is cleared
            // deliberately: pre-filling from the previous capture would invite
            // a practitioner to submit values she has not re-read off the
            // machine, which is the opposite of what a reading is.
            setDraft({});
            setMessage(null);
            setSaved(false);
          }}
          className="self-start rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          data-testid="machine-reading-record-change"
        >
          Record a setting change
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="machine-reading-entry">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          <SectionLabel size="caption">{group.label}</SectionLabel>
          <div className="grid gap-3 md:grid-cols-2">
            {group.fields.map((f) => {
              const k = key(group.key, f);
              return (
                <label key={k} className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {/* Same ids as the panel's read-only list; only one of the
                        two renders at a time. See the note there. */}
                    <span data-testid={`field-label-${f.key}`}>{f.label}</span>
                    {f.unit && (
                      <span
                        className="ml-1 font-normal text-neutral-500"
                        data-testid={`field-unit-${f.key}`}
                      >
                        ({f.unit})
                      </span>
                    )}
                    {f.optional && (
                      <span className="ml-1 font-normal text-neutral-500">
                        optional
                      </span>
                    )}
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={f.decimals === 0 ? 1 : 1 / 10 ** f.decimals}
                    disabled={!f.editable}
                    value={draft[k] ?? ""}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [k]: e.target.value }))
                    }
                    data-testid={`reading-${f.key}`}
                    className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
                  />
                  {f.advisory.map((note, i) => (
                    <span key={i} className="text-xs text-neutral-500">
                      {note}
                    </span>
                  ))}
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending || !ready}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          data-testid="machine-reading-save"
        >
          {pending ? "Saving…" : "Save these settings"}
        </button>
        {!ready && (
          <span className="text-xs text-neutral-500">
            Enter every required field before saving.
          </span>
        )}
      </div>

      {message && (
        <p className="text-xs text-neutral-600 dark:text-neutral-400" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
