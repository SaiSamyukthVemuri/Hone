"use client";

// Dedicated CONSULTATION notes + SKIN/HAIR ANALYSIS clinical records
// (migration 0126), presented as TWO clearly-separate cards. Each card shows
// the current entry (dated + attributed), an "Add note" form, a "Revise" flow
// (append-only correction that supersedes the current entry), and dated
// history. Used on three surfaces via the `variant` prop:
//   * "full"   , the client-profile "Consultation" tab (default open history)
//   * "compact", inline on session charting + appointment prep (history
//                 collapsed; same add/revise write path)
//
// Write path safety:
//   * Forms post to the server actions (addClinicalNoteAction /
//     reviseClinicalNoteAction), which re-derive the studio + practitioner from
//     auth and read-back-verify the persisted row. This component NEVER assumes
//     a save succeeded. It only updates local state from the verified note the
//     action returns.
//   * The Save button is disabled while a submit is in flight (no accidental
//     double submission), and on failure the form STAYS OPEN with the entered
//     text intact (no silent loss, no duplicate-creating retry).
//   * A stale-revision conflict surfaces a distinct message + a Reload action.
//
// This component must NOT be imported by any client-portal, public-booking,
// email, or SMS surface. It is authenticated practitioner UI only.

import { useActionState, useRef, useState } from "react";
import { useNoteDraft } from "@/lib/note-drafts/use-note-draft";
import { heldText, latestDraft, seedEntry, type DraftActions } from "@/lib/note-drafts/draft-registry";
import { NoteDraftStatus } from "@/components/note-draft-status";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { targetFor, type NoteDraftFields, type NoteDraftKey, type StoredNoteDraft } from "@/lib/note-drafts/types";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { formatClinicalDate } from "@/lib/clinical-notes/clinical-date";
import { authorLabel } from "@/lib/attribution";
import type {
  ClientClinicalNote,
  ClinicalNoteKind,
  ClinicalNoteWithAuthor,
} from "@/lib/types/database";

export type ClinicalNoteActionResult =
  | { ok: true; note: ClientClinicalNote; author_name: string | null }
  | {
      ok: false;
      code: "invalid" | "not_found" | "stale_revision" | "draft_ended" | "error";
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
  // HON-130: the caller's own autosaved drafts for this client and the actions that save them. Omit both to disable autosave.
  drafts?: StoredNoteDraft[];
  draftActions?: DraftActions;
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

// `occurred_at` is a CALENDAR DATE (the form posts `YYYY-MM-DD` into a
// timestamptz, so it lands at midnight UTC). Converting it into the viewer's
// zone showed the PREVIOUS day in every negative UTC offset: every Canadian
// and US studio, so a note dated July 21 read as July 20 right beside the
// July 21 in its own date input. The shared civil-date formatter pins the day
// and lets only the month NAME follow locale.
const formatDate = formatClinicalDate;

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
  drafts,
  draftActions,
}: Props) {
  const compact = variant === "compact";
  return (
    <div className={compact ? "flex flex-col gap-4" : "flex flex-col gap-6"}>
      {(profileHref || printHref) && (
        <div className="flex items-center justify-end gap-4 text-xs">
          {printHref && (
            <a
              href={printHref}
              className="inline-flex items-center min-h-[44px] min-w-[44px] font-medium text-neutral-600 underline dark:text-neutral-300"
            >
              Print / export
            </a>
          )}
          {profileHref && compact && (
            <a
              href={profileHref}
              className="inline-flex items-center min-h-[44px] min-w-[44px] font-medium text-neutral-600 underline dark:text-neutral-300"
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
          drafts={drafts}
          draftActions={draftActions}
        />
      ))}
    </div>
  );
}

export type { DraftActions };
const NO_DRAFT_ACTIONS: DraftActions = {
  scope: "none",
  save: async () => ({ status: "error" }),
  discard: async () => ({ ok: false }),
  peek: async () => ({ ok: false, draft: null }),
};

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
  drafts,
  draftActions,
}: {
  clientId: string;
  section: ClinicalNoteSectionData;
  compact: boolean;
  addAction: ClinicalNoteAction;
  reviseAction: ClinicalNoteAction;
  drafts?: StoredNoteDraft[];
  draftActions?: DraftActions;
}) {
  const [notes, setNotes] = useState<ClinicalNoteWithAuthor[]>(
    withDerivedSupersede(section.notes),
  );
  const [total, setTotal] = useState(section.total);
  // A saved draft re-opens its editor on load (refresh / coming back), so the latest text is there without pressing Save.
  const initialOpen = (): OpenForm => {
    const mine = (drafts ?? []).filter((d) => d.key.kind === section.kind);
    const fresh = mine.find((d) => d.key.target === "new");
    if (fresh) return { mode: "add" };
    // The derived list knows which notes already HAVE a revision: a draft of such a note reopens as "this note was revised", not as a plain restore.
    const derived = withDerivedSupersede(section.notes);
    const rev = mine.find((d) => derived.some((n) => n.id === d.key.target));
    const note = rev ? derived.find((n) => n.id === rev.key.target) : undefined;
    return note ? { mode: "revise", note } : null;
  };
  const [openForm, setOpenForm] = useState<OpenForm>(initialOpen);
  const [historyOpen, setHistoryOpen] = useState(!compact);
  // Keep as new note: the destination (a NEW note's draft) may already hold text. It is never overwritten silently.
  type MoveApi = { latest: () => NoteDraftFields | null; moveOut: () => Promise<NoteDraftFields | null> };
  const [moveDialog, setMoveDialog] = useState<null | { mine: NoteDraftFields; theirs: NoteDraftFields; stored: StoredNoteDraft | null; api: MoveApi }>(null);
  const [moveNotice, setMoveNotice] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const destKey: NoteDraftKey = { clientId, kind: section.kind, target: "new" };
  async function finishMove(api: MoveApi, choice: "free" | "append" | "replace", theirs: NoteDraftFields | null, stored: StoredNoteDraft | null) {
    if (!draftActions) return;
    const text = await api.moveOut(); // ends the source draft (bounded) and returns the newest text, read AFTER the delete
    if (!text) return;
    let final = text;
    if (choice === "append" && theirs) {
      const both = [theirs.body, text.body].filter((x) => x && x.length > 0).join("\n\n");
      const areas = Array.from(new Set([...(theirs.areas ?? []), ...(text.areas ?? [])]));
      final = { ...text, body: both, ...(areas.length ? { areas } : {}), occurred_at: theirs.occurred_at ?? text.occurred_at };
    }
    // A NEW lifecycle (new generation, expected revision 0) when the destination was free; the destination's OWN lifecycle when the person
    // chose to append to or replace what it held (the same entry, so no conflict with itself).
    seedEntry(destKey, final, draftActions, choice === "free" ? null : stored);
    setMoveDialog(null);
    setOpenForm({ mode: "add" });
  }
  async function keepAsNewNote(api: MoveApi) {
    if (!draftActions) return;
    const mine = api.latest();
    if (!mine) return;
    setMoveNotice(null);
    let theirs: NoteDraftFields | null = heldText(destKey, draftActions.scope);
    let stored: StoredNoteDraft | null = null;
    if (!theirs) {
      try {
        const peeked = await draftActions.peek(destKey, draftActions.scope);
        if (!peeked.ok) {
          setMoveNotice("Couldn't check where to keep this text. It is still here; try again.");
          return;
        }
        stored = peeked.draft;
        theirs = stored?.fields ?? null;
      } catch {
        setMoveNotice("Couldn't check where to keep this text. It is still here; try again.");
        return;
      }
    }
    if (theirs) {
      setMoveDialog({ mine, theirs, stored, api });
      return;
    }
    await finishMove(api, "free", null, null);
  }

  const latest = deriveLatest(notes);
  const areaEnabled = AREA_ENABLED_KINDS.includes(section.kind);
  // History = every note except the current head, newest first.
  const history = sortNotes(notes).filter((n) => !latest || n.id !== latest.id);

  function handleSaved(note: ClientClinicalNote, authorName: string | null) {
    setNotes((prev) => {
      // Merge the verified note in, labelled with the author the server
      // verified (the signed-in practitioner). Recompute supersede flags.
      const merged: ClinicalNoteWithAuthor[] = [
        ...prev.filter((n) => n.id !== note.id),
        { ...note, author_name: authorName, is_superseded: false },
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
          restored={(drafts ?? []).find((d) => d.key.kind === section.kind && d.key.target === targetFor(section.kind, openForm.mode === "revise" ? openForm.note.id : null)) ?? null}
          draftActions={draftActions}
          onSaved={handleSaved}
          onCancel={() => setOpenForm(null)}
          onKeepAsNewNote={(api) => void keepAsNewNote(api)}
        />
      )}

      {moveNotice && (
        <p role="alert" className="text-xs text-red-700">
          {moveNotice}
        </p>
      )}
      {moveDialog && (
        <div role="dialog" aria-label="A new note draft already exists" className="flex flex-col gap-2 rounded-md border border-neutral-300 p-3 text-xs" data-testid="note-move-dialog">
          <p className="font-medium">A draft of a new note already exists. Nothing has been changed yet.</p>
          <p>Text you are moving</p>
          <pre className="whitespace-pre-wrap">{moveDialog.mine.body ?? ""}</pre>
          <p>Text already in the new note draft</p>
          <pre className="whitespace-pre-wrap">{moveDialog.theirs.body ?? ""}</pre>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="min-h-[44px] px-2 font-medium underline" onClick={() => setMoveDialog(null)}>
              Cancel
            </button>
            <button type="button" className="min-h-[44px] px-2 font-medium underline" onClick={() => void finishMove(moveDialog.api, "append", moveDialog.theirs, moveDialog.stored)}>
              Append
            </button>
            <button type="button" className="min-h-[44px] px-2 font-medium underline" onClick={() => setConfirmReplace(true)}>
              Replace
            </button>
            <ConfirmDialog
              open={confirmReplace}
              title="Replace the new note draft?"
              description="The draft's current text will be lost. Both texts stay on screen above until you confirm."
              confirmLabel="Replace"
              onConfirm={() => {
                setConfirmReplace(false);
                void finishMove(moveDialog.api, "replace", moveDialog.theirs, moveDialog.stored);
              }}
              onCancel={() => setConfirmReplace(false)}
            />
          </div>
        </div>
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
          {authorLabel(note.author_name)}
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
  restored,
  draftActions,
  onSaved,
  onCancel,
  onKeepAsNewNote,
}: {
  restored: StoredNoteDraft | null;
  draftActions?: DraftActions;
  clientId: string;
  kind: ClinicalNoteKind;
  placeholder: string;
  areaEnabled: boolean;
  mode: "add" | "revise";
  revising: ClinicalNoteWithAuthor | null;
  action: ClinicalNoteAction;
  onSaved: (note: ClientClinicalNote, authorName: string | null) => void;
  onCancel: () => void;
  /** A revision's draft cannot stay (the note was revised since): move the text to a NEW note instead. The parent checks the destination first. */
  onKeepAsNewNote?: (api: { latest: () => NoteDraftFields | null; moveOut: () => Promise<NoteDraftFields | null> }) => void;
}) {
  const router = useRouter();
  const draftKey: NoteDraftKey = { clientId, kind, target: targetFor(kind, mode === "revise" && revising ? revising.id : null) };
  // Start from the NEWEST text this tab knows (a draft held after a failed flush, or saved since the page loaded), else the page's stored draft.
  const [start] = useState(() => (draftActions ? latestDraft(draftKey, restored, draftActions.scope) : null));
  const [areasText, setAreasText] = useState(
    start?.fields.areas ? start.fields.areas.join(", ") : revising ? revising.areas.join(", ") : "",
  );
  const [body, setBody] = useState(start?.fields.body ?? (mode === "revise" && revising ? revising.body : ""));
  // The textarea stays UNCONTROLLED (defaultValue, as before): a controlled textarea mirrors its text into the DOM, which made the typed text
  // match page-level text queries before the save returned. A reset (discard, use theirs) remounts it with a new key.
  const [bodyInit, setBodyInit] = useState(body);
  const [bodyKey, setBodyKey] = useState(0);
  function resetBody(next: string) {
    setBody(next);
    setBodyInit(next);
    setBodyKey((k) => k + 1);
  }
  const [occurredAt, setOccurredAt] = useState(start?.fields.occurred_at ?? todayISODate());
  const draft = useNoteDraft(draftKey, restored, draftActions ?? NO_DRAFT_ACTIONS, Boolean(draftActions));
  // The note being revised already HAS a revision (written since this draft was): no draft of it can be saved again, so it is not autosaved and the
  // reopened editor says so, with Keep as new note, instead of presenting the text as a plain restore.
  const revised = mode === "revise" && Boolean(revising?.is_superseded);
  const [restoredAt, setRestoredAt] = useState<string | null>(start && !start.unsaved ? start.savedAt : null);
  function applyTheirs(t: NoteDraftFields) {
    // Keep what the person typed visible until they dismiss it; adopt the other window's text.
    setYourVersion(body);
    if (t.body !== undefined) resetBody(t.body);
    if (t.areas) setAreasText(t.areas.join(", "));
    if (t.occurred_at) setOccurredAt(t.occurred_at);
  }
  const [yourVersion, setYourVersion] = useState<string | null>(null);
  // A superseded target is never autosaved, but the person can still edit the reopened text before choosing Keep as new note. Those edits are HELD
  // in the registry saver (never sent; they survive this editor unmounting) and are what the move carries.
  // The editor's CURRENT text, kept fresh every render, for the moment a failed Discard resumes (its closure is older than the typing).
  const currentFields = useRef<NoteDraftFields>({ body, areas: parseAreas(areasText), occurred_at: occurredAt });
  currentFields.current = { body, areas: parseAreas(areasText), occurred_at: occurredAt };
  function touch(next: { body?: string; areasText?: string; occurredAt?: string }) {
    if (!draftActions || draft.discarding || draft.moving) return;
    const fields: NoteDraftFields = {
      body: next.body ?? body,
      areas: parseAreas(next.areasText ?? areasText),
      occurred_at: next.occurredAt ?? occurredAt,
    };
    if (revised) {
      draft.hold(fields);
      return;
    }
    setRestoredAt(null);
    draft.change(fields);
  }
  const [state, formAction] = useActionState(
    async (_prev: FormState, formData: FormData): Promise<FormState> => {
      const result = await action(formData);
      if (result.ok) {
        draft.settle(); // the save already cleared the draft in its own transaction
        onSaved(result.note, result.author_name);
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
      {/* The draft lifecycle this Save ends: the SAME transaction turns exactly this draft into a text-free tombstone. Empty when autosave is off. */}
      <input type="hidden" name="draft_generation" value={draft.generation() ?? ""} />
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
          key={bodyKey}
          readOnly={draft.moving || draft.discarding}
          defaultValue={bodyInit}
          onChange={(e) => {
            setBody(e.target.value);
            touch({ body: e.target.value });
          }}
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
            readOnly={draft.moving || draft.discarding}
            value={occurredAt}
            onChange={(e) => {
              setOccurredAt(e.target.value);
              touch({ occurredAt: e.target.value });
            }}
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
              readOnly={draft.moving || draft.discarding}
              value={areasText}
              onChange={(e) => {
                setAreasText(e.target.value);
                touch({ areasText: e.target.value });
              }}
              placeholder="e.g. chin, upper lip"
              className="min-h-[44px] rounded-md border border-neutral-300 bg-white px-3 py-2 text-base outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </label>
        )}
      </div>

      {yourVersion !== null && (
        <div className="rounded-md border border-neutral-300 p-2 text-xs" data-testid="note-draft-your-version">
          <p className="font-medium">Your version (not saved in the draft)</p>
          <pre className="whitespace-pre-wrap">{yourVersion}</pre>
          <button type="button" onClick={() => setYourVersion(null)} className="min-h-[44px] underline">Dismiss</button>
        </div>
      )}
      {draftActions && (
        <NoteDraftStatus
          state={draft.state}
          restoredAt={restoredAt}
          onRetry={draft.retry}
          onKeepMine={draft.keepMine}
          revised={revised}
          onKeepAsNew={mode === "revise" && onKeepAsNewNote ? () => onKeepAsNewNote({ latest: draft.latest, moveOut: draft.moveOut }) : draft.keepAsNew}
          onUseTheirs={() => {
            const t = draft.useTheirs();
            if (t) applyTheirs(t);
          }}
          discardFailed={draft.discardFailed}
          discarding={draft.discarding}
          onDiscard={async () => {
            if (!(await draft.discard())) {
              // Failed: the editor stays exactly as it was and the status says so. Text that reached the body in the one frame before the lock
              // rendered never reached the saver (edits are ignored while a Discard is out): hand the CURRENT text over now, so it is sent and the
              // unload guard knows about it.
              const cur = currentFields.current;
              if (revised) draft.hold(cur);
              else if (JSON.stringify(cur) !== JSON.stringify(draft.latest())) draft.change(cur);
              return;
            }
            setRestoredAt(null);
            resetBody(mode === "revise" && revising ? revising.body : "");
            setAreasText(revising ? revising.areas.join(", ") : "");
            setOccurredAt(todayISODate());
          }}
        />
      )}

      {mode === "revise" && (
        <p className="text-[11px] text-neutral-500">
          Saving records a new dated revision. The current note is kept in
          history, nothing is overwritten.
        </p>
      )}

      {state.status === "error" && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <span>{state.message}</span>
          {(state.code === "stale_revision" || state.code === "draft_ended") && (
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
