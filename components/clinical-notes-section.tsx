"use client";

// Dedicated CONSULTATION notes + SKIN/HAIR ANALYSIS clinical records
// (migration 0126), presented as TWO clearly-separate cards. Each card shows
// the current entry (dated + attributed), an "Add note" form, a "Revise" flow
// (append-only correction that supersedes the current entry), and dated
// history. Used on three surfaces via the `variant` prop:
//   * "full"    — the client-profile "Consultation" tab (default open history)
//   * "compact" — inline on session charting + appointment prep (history
//                 collapsed; same add/revise write path)
//
// Write path safety:
//   * Forms post to the server actions (addClinicalNoteAction /
//     reviseClinicalNoteAction), which re-derive the studio + practitioner from
//     auth and read-back-verify the persisted row. This component NEVER assumes
//     a save succeeded — it only updates local state from the verified note the
//     action returns.
//   * The Save button is disabled while a submit is in flight (no accidental
//     double submission), and on failure the form STAYS OPEN with the entered
//     text intact (no silent loss, no duplicate-creating retry).
//   * A stale-revision conflict surfaces a distinct message + a Reload action.
//
// This component must NOT be imported by any client-portal, public-booking,
// email, or SMS surface. It is authenticated practitioner UI only.

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type {
  ClientClinicalNote,
  ClinicalNoteKind,
  ClinicalNoteWithAuthor,
} from "@/lib/types/database";

export type ClinicalNoteActionResult =
  | { ok: true; note: ClientClinicalNote }
  | {
      ok: false;
      code: "invalid" | "not_found" | "stale_revision" | "error";
      error: string;
    };

type ClinicalNoteAction = (formData: FormData) => Promise<ClinicalNoteActionResult>;

export type ClinicalNoteSectionData = {
  kind: ClinicalNoteKind;
  label: string;
  description: string;
  placeholder: string;
  notes: ClinicalNoteWithAuthor[];
  total: number;
};

type Props = {
  clientId: string;
  variant?: "full" | "compact";
  sections: ClinicalNoteSectionData[];
  addAction: ClinicalNoteAction;
  reviseAction: ClinicalNoteAction;
  // Deep link to the full profile tab (compact surfaces show a "View all" link).
  profileHref?: string;
  // Deep link to the print/export view.
  printHref?: string;
};

const AREA_ENABLED_KINDS: ReadonlyArray<ClinicalNoteKind> = ["skin_hair_analysis"];

function sortNotes(notes: ClinicalNoteWithAuthor[]): ClinicalNoteWithAuthor[] {
  return [...notes].sort(
    (a, b) =>
      new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime() ||
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

// Latest = newest (occurred_at, created_at) row not superseded by any other row.
function deriveLatest(
  notes: ClinicalNoteWithAuthor[],
): ClinicalNoteWithAuthor | null {
  const superseded = new Set(
    notes.map((n) => n.supersedes_note_id).filter((x): x is string => !!x),
  );
  return sortNotes(notes).find((n) => !superseded.has(n.id)) ?? null;
}

function withDerivedSupersede(
  notes: ClinicalNoteWithAuthor[],
): ClinicalNoteWithAuthor[] {
  const superseded = new Set(
    notes.map((n) => n.supersedes_note_id).filter((x): x is string => !!x),
  );
  return notes.map((n) => ({ ...n, is_superseded: superseded.has(n.id) }));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function parseAreas(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function ClinicalNotesSection({
  clientId,
  variant = "full",
  sections,
  addAction,
  reviseAction,
  profileHref,
  printHref,
}: Props) {
  const compact = variant === "compact";
  return (
    <div className={compact ? "flex flex-col gap-4" : "flex flex-col gap-6"}>
      {(profileHref || printHref) && (
        <div className="flex items-center justify-end gap-4 text-xs">
          {printHref && (
            <a
              href={printHref}
              className="font-medium text-neutral-600 underline dark:text-neutral-300"
            >
              Print / export
            </a>
          )}
          {profileHref && compact && (
            <a
              href={profileHref}
              className="font-medium text-neutral-600 underline dark:text-neutral-300"
            >
              Open in profile
            </a>
          )}
        </div>
      )}
      {sections.map((section) => (
        <KindCard
          key={section.kind}
          clientId={clientId}
          section={section}
          compact={compact}
          addAction={addAction}
          reviseAction={reviseAction}
        />
      ))}
    </div>
  );
}

type OpenForm =
  | { mode: "add" }
  | { mode: "revise"; note: ClinicalNoteWithAuthor }
  | null;

function KindCard({
  clientId,
  section,
  compact,
  addAction,
  reviseAction,
}: {
  clientId: string;
  section: ClinicalNoteSectionData;
  compact: boolean;
  addAction: ClinicalNoteAction;
  reviseAction: ClinicalNoteAction;
}) {
  const [notes, setNotes] = useState<ClinicalNoteWithAuthor[]>(
    withDerivedSupersede(section.notes),
  );
  const [total, setTotal] = useState(section.total);
  const [openForm, setOpenForm] = useState<OpenForm>(null);
  const [historyOpen, setHistoryOpen] = useState(!compact);

  const latest = deriveLatest(notes);
  const areaEnabled = AREA_ENABLED_KINDS.includes(section.kind);
  // History = every note except the current head, newest first.
  const history = sortNotes(notes).filter((n) => !latest || n.id !== latest.id);

  function handleSaved(note: ClientClinicalNote) {
    setNotes((prev) => {
      // Merge the verified note in (author name is unknown client-side for a
      // just-created row; show "You"). Recompute supersede flags.
      const merged: ClinicalNoteWithAuthor[] = [
        ...prev.filter((n) => n.id !== note.id),
        { ...note, author_name: null, is_superseded: false },
      ];
      return withDerivedSupersede(merged);
    });
    setTotal((t) => t + 1);
    setOpenForm(null);
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 md:p-5">
      <header className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
          {section.label}
        </h2>
        <p className="text-xs text-neutral-500">{section.description}</p>
      </header>

      {latest ? (
        <NoteBlock note={latest} areaEnabled={areaEnabled} current />
      ) : (
        <p className="rounded-md border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-500 dark:border-neutral-700">
          No {section.label.toLowerCase()} recorded yet.
        </p>
      )}

      {openForm === null && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setOpenForm({ mode: "add" })}
            className="min-h-[44px] rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Add note
          </button>
          {latest && (
            <button
              type="button"
              onClick={() => setOpenForm({ mode: "revise", note: latest })}
              className="min-h-[44px] rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:border-neutral-500 dark:border-neutral-700 dark:text-neutral-200"
            >
              Revise current
            </button>
          )}
        </div>
      )}

      {openForm !== null && (
        <NoteForm
          key={openForm.mode === "revise" ? openForm.note.id : "add"}
          clientId={clientId}
          kind={section.kind}
          placeholder={section.placeholder}
          areaEnabled={areaEnabled}
          mode={openForm.mode}
          revising={openForm.mode === "revise" ? openForm.note : null}
          action={openForm.mode === "revise" ? reviseAction : addAction}
          onSaved={handleSaved}
          onCancel={() => setOpenForm(null)}
        />
      )}

      {history.length > 0 && (
        <div className="border-t border-neutral-100 pt-2 dark:border-neutral-900">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
            className="min-h-[36px] text-xs font-medium text-neutral-600 underline dark:text-neutral-400"
          >
            {historyOpen ? "Hide" : "Show"} history ({history.length}
            {total > notes.length ? " shown" : ""})
          </button>
          {historyOpen && (
            <ul className="mt-2 flex flex-col gap-3">
              {history.map((note) => (
                <li key={note.id}>
                  <NoteBlock note={note} areaEnabled={areaEnabled} />
                </li>
              ))}
              {total > notes.length && (
                <li className="text-[11px] text-neutral-500">
                  Showing the most recent {notes.length} of {total} entries.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function NoteBlock({
  note,
  areaEnabled,
  current = false,
}: {
  note: ClinicalNoteWithAuthor;
  areaEnabled: boolean;
  current?: boolean;
}) {
  return (
    <article
      className={`rounded-md px-3 py-2.5 text-sm ${
        current
          ? "bg-neutral-50 dark:bg-neutral-900"
          : "border border-neutral-100 dark:border-neutral-900"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-medium text-neutral-800 dark:text-neutral-200">
          {formatDate(note.occurred_at)}
        </span>
        <span className="text-[11px] text-neutral-500">
          {note.author_name ? note.author_name : "You"}
          {note.supersedes_note_id ? " · revision" : ""}
          {note.is_superseded ? " · superseded" : ""}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-200">
        {note.body}
      </p>
      {areaEnabled && note.areas.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {note.areas.map((area) => (
            <span
              key={area}
              className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              {area}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

type FormState =
  | { status: "idle" }
  | { status: "error"; code: string; message: string };

const INITIAL_FORM_STATE: FormState = { status: "idle" };

function todayISODate(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60_000);
  return local.toISOString().slice(0, 10);
}

function NoteForm({
  clientId,
  kind,
  placeholder,
  areaEnabled,
  mode,
  revising,
  action,
  onSaved,
  onCancel,
}: {
  clientId: string;
  kind: ClinicalNoteKind;
  placeholder: string;
  areaEnabled: boolean;
  mode: "add" | "revise";
  revising: ClinicalNoteWithAuthor | null;
  action: ClinicalNoteAction;
  onSaved: (note: ClientClinicalNote) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [areasText, setAreasText] = useState(
    revising ? revising.areas.join(", ") : "",
  );
  const [state, formAction] = useActionState(
    async (_prev: FormState, formData: FormData): Promise<FormState> => {
      const result = await action(formData);
      if (result.ok) {
        onSaved(result.note);
        return { status: "idle" };
      }
      return { status: "error", code: result.code, message: result.error };
    },
    INITIAL_FORM_STATE,
  );

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-md border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-950"
    >
      <input type="hidden" name="client_id" value={clientId} />
      <input type="hidden" name="kind" value={kind} />
      {mode === "revise" && revising && (
        <input type="hidden" name="supersedes_note_id" value={revising.id} />
      )}
      {areaEnabled && (
        <input
          type="hidden"
          name="areas"
          value={JSON.stringify(parseAreas(areasText))}
        />
      )}

      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          {mode === "revise" ? "Revised note" : "New note"}
        </label>
        <textarea
          name="body"
          defaultValue={mode === "revise" && revising ? revising.body : ""}
          rows={5}
          required
          maxLength={20000}
          placeholder={placeholder}
          autoFocus
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-base outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Date
          </span>
          <input
            type="date"
            name="occurred_at"
            defaultValue={todayISODate()}
            className="min-h-[44px] rounded-md border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </label>
        {areaEnabled && (
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
              Areas (optional, comma-separated)
            </span>
            <input
              type="text"
              value={areasText}
              onChange={(e) => setAreasText(e.target.value)}
              placeholder="e.g. chin, upper lip"
              className="min-h-[44px] rounded-md border border-neutral-300 bg-white px-3 py-2 text-base outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>
        )}
      </div>

      {mode === "revise" && (
        <p className="text-[11px] text-neutral-500">
          Saving records a new dated revision. The current note is kept in
          history — nothing is overwritten.
        </p>
      )}

      {state.status === "error" && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <span>{state.message}</span>
          {state.code === "stale_revision" && (
            <button
              type="button"
              onClick={() => router.refresh()}
              className="self-start font-medium underline"
            >
              Reload latest
            </button>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[44px] rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:text-neutral-300"
        >
          Cancel
        </button>
        <SaveButton mode={mode} />
      </div>
    </form>
  );
}

function SaveButton({ mode }: { mode: "add" | "revise" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-[44px] rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      {pending
        ? "Saving…"
        : mode === "revise"
          ? "Save revision"
          : "Save note"}
    </button>
  );
}
