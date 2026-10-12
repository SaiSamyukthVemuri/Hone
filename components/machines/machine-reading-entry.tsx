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
      setSaved(true);
      setMessage("Saved to this treatment.");
    } else {
      setMessage(out.error ?? "Could not save those settings.");
    }
  }

  if (saved) {
    return (
      <p
        className="text-sm text-neutral-700 dark:text-neutral-300"
        data-testid="machine-reading-saved"
        role="status"
      >
        {/*
          This used to read "A change of setting is recorded as a new reading,
          so this one stays as entered." The first half was false: the schema
          has one row per (block, group, stage, field), so a SECOND reading for
          the same field in the same block is refused, not appended - a changed
          setting cannot currently be recorded at all (Codex, 9c6fbbe5).
          Whether it SHOULD be is a clinical-record question recorded for
          product authority, not one to settle in UI copy. Until it is settled
          this says only what is true.
        */}
        Settings saved to this treatment, and they cannot be overwritten. To
        correct or add to them, record them in the treatment notes below.
      </p>
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
