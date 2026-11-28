"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { PortalGreeting, PortalOverview } from "@/app/portal/PortalOverview";
import { defaultPortalPresentation, parsePortalPresentation, portalCopyLimits, type PortalPresentation, type PortalSection } from "@/lib/portal/presentation";
import { editPortalPresentation } from "./actions";

const fieldClass = "mt-1 w-full rounded-sm border border-neutral-400 bg-transparent px-3 py-2 text-base";
const buttonClass = "min-h-11 rounded-sm border border-neutral-400 px-4 py-2 text-sm font-medium disabled:opacity-45";
const primaryClass = buttonClass + " border-neutral-900 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900";
const helperClass = "text-sm text-neutral-600 dark:text-neutral-400";

const sampleVisit = {
  id: "preview-visit", startsAt: "2027-03-12T15:00:00Z", endsAt: "2027-03-12T15:30:00Z",
  durationMinutes: 30, serviceName: "Sample appointment", manageToken: null,
};
const sectionNames = defaultPortalPresentation().sections;

type Props = {
  studioId: string;
  studioName: string;
  timezone: string;
  initial: PortalPresentation;
  initialRevision: number;
  initiallyPublished: boolean;
};

export function PortalEditor({ studioId, studioName, timezone, initial, initialRevision, initiallyPublished }: Props) {
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [revision, setRevision] = useState(initialRevision);
  const [published, setPublished] = useState(initiallyPublished);
  const [preview, setPreview] = useState(false);
  const [firstVisit, setFirstVisit] = useState(true);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [mustReload, setMustReload] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  function updateSection(id: PortalSection["id"], patch: Partial<Omit<PortalSection, "id">>) {
    setDraft((current) => ({ ...current, sections: current.sections.map(s => s.id === id ? { ...s, ...patch } : s) }));
  }

  function moveSection(index: number, offset: -1 | 1) {
    setDraft((current) => {
      const sections = [...current.sections];
      [sections[index], sections[index + offset]] = [sections[index + offset], sections[index]];
      return { ...current, sections };
    });
  }

  function change(operation: "save" | "publish" | "classic") {
    if (pending || mustReload) return;
    setError(""); setMessage("");
    const copy = parsePortalPresentation(draft);
    if (operation === "save" && !copy) {
      setError("Give the welcome message and each overview section a heading before saving.");
      return;
    }
    startTransition(async () => {
      try {
        const result = await editPortalPresentation(studioId, revision, operation, operation === "save" ? copy : undefined);
        if (!result.ok) {
          setError(result.error);
          if (result.reload) setMustReload(true);
          return;
        }
        setRevision(result.revision);
        if (operation === "save" && copy) { setDraft(copy); setSaved(copy); }
        else setPublished(operation === "publish");
        setMessage(operation === "save" ? "Draft saved." : operation === "publish" ? "Portal published." : "Classic portal restored.");
      } catch {
        setMustReload(true);
        setError("The result could not be confirmed. Reload to see which portal is live.");
      }
    });
  }

  return <div className="flex flex-col gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3 border-y border-neutral-300 py-4">
      <p>Clients currently see the <strong>{published ? "new portal" : "classic portal"}</strong>.</p>
      {published && <button type="button" disabled={pending || mustReload} className={buttonClass} onClick={() => change("classic")}>Switch to classic</button>}
    </div>
    <p role="status" aria-live="polite" className={message ? "text-sm" : "sr-only"}>{message}</p>
    {error && <p role="alert">{error} {mustReload && <button className="underline" onClick={() => window.location.reload()}>Reload settings</button>}</p>}
    <fieldset disabled={pending || mustReload} className="flex min-w-0 flex-col gap-5">
      {preview ? <>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><h3 className="text-xl font-medium">Client preview</h3><p className={helperClass}>Sample client and appointments at {studioName}.</p></div>
          <label className="text-sm">Sample client
            <select className={fieldClass} value={firstVisit ? "new" : "returning"} onChange={e => setFirstVisit(e.target.value === "new")}>
              <option value="new">First visit · forms due</option><option value="returning">Returning · forms complete</option>
            </select>
          </label>
        </div>
        <div className="rounded-md border border-neutral-300 bg-white p-4 text-neutral-900 sm:p-6">
          <PortalGreeting presentation={draft} studioName={studioName} firstName="Alex" />
          <PortalOverview preview presentation={draft} studioName={studioName} firstName="Alex" timezone={timezone}
            upcoming={[sampleVisit]} formsDue={firstVisit ? 2 : 0} unreadCount={0} hasTasks={firstVisit}
            hasPayment={!firstVisit} canBook hasCare signedFormsCount={firstVisit ? 0 : 2} />
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={buttonClass} onClick={() => setPreview(false)}>Back to editing</button>
          <button type="button" className={primaryClass} disabled={!revision || dirty} onClick={() => change("publish")}>Publish portal</button>
        </div>
        {(!revision || dirty) && <p className={helperClass}>Save your draft before publishing.</p>}
      </> : <>
        <section className="grid gap-4" aria-label="Welcome and contact">
          <label className="text-sm">Public contact name
            <input className={fieldClass} maxLength={portalCopyLimits.owner} value={draft.ownerName}
              placeholder={studioName} onChange={e => setDraft({ ...draft, ownerName: e.target.value })} />
            <span className={helperClass}>Leave blank to use the studio name.</span>
          </label>
          <label className="text-sm">Welcome heading
            <input className={fieldClass} required maxLength={portalCopyLimits.title} value={draft.welcomeHeading}
              onChange={e => setDraft({ ...draft, welcomeHeading: e.target.value })} />
          </label>
          <label className="text-sm">Welcome message
            <textarea className={fieldClass} maxLength={portalCopyLimits.description} value={draft.welcomeMessage}
              onChange={e => setDraft({ ...draft, welcomeMessage: e.target.value })} />
          </label>
          <p className={helperClass}>Use {"{client}"} for the client’s first name, {"{studio}"} for the studio name, or {"{owner}"} for your public contact name.</p>
        </section>
        <section aria-label="Overview sections">
          <h3 className="text-lg font-medium">Overview sections</h3>
          <p className={helperClass}>Choose the order and wording clients see on their overview. They can always reach their visits, required forms and records from the portal menu.</p>
          {draft.sections.map((s, index) => {
            const original = sectionNames.find(item => item.id === s.id)!.title;
            return <details key={s.id} className="border-b border-neutral-300 py-3">
              <summary className="cursor-pointer py-2">{original} <span className={helperClass}>· {s.visible ? "Shown" : "Hidden"}</span></summary>
              <div className="grid gap-3 pb-3">
                <label className="text-sm">Section heading<input className={fieldClass} required maxLength={portalCopyLimits.title} value={s.title} onChange={e => updateSection(s.id, { title: e.target.value })} /></label>
                <label className="text-sm">Section description<textarea className={fieldClass} maxLength={portalCopyLimits.description} value={s.description} onChange={e => updateSection(s.id, { description: e.target.value })} /></label>
                <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={s.visible} onChange={e => updateSection(s.id, { visible: e.target.checked })} />Show on overview</label>
                <div className="flex gap-2">
                  <button type="button" className={buttonClass} disabled={index === 0} aria-label={'Move ' + original + ' up'} onClick={() => moveSection(index, -1)}>Move up</button>
                  <button type="button" className={buttonClass} disabled={index === draft.sections.length - 1} aria-label={'Move ' + original + ' down'} onClick={() => moveSection(index, 1)}>Move down</button>
                </div>
              </div>
            </details>;
          })}
        </section>
        <nav aria-label="Studio content settings" className="flex flex-wrap gap-x-5 gap-y-2 text-sm underline underline-offset-2">
          <Link href="/settings/forms/postcare">Edit care instructions and contact email</Link>
          <Link href="/settings/forms/cancellation-policy">Edit appointment policies</Link>
          <Link href="/settings/consent">Manage consent templates</Link>
        </nav>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={buttonClass} onClick={() => change("save")} disabled={!dirty && revision > 0}>Save draft</button>
          <button type="button" className={primaryClass} onClick={() => { setError(""); setPreview(true); }}>Preview as client</button>
        </div>
      </>}
    </fieldset>
  </div>;
}
