"use client";

import { useState, useTransition } from "react";
import type { ConsentFormTemplateForPortal } from "@/lib/consent/queries";
import { signConsentFormAction } from "./consent-actions";

// PR #134. Portal-side consent form list + sign drawer. Two surfaces
// in one component:
//   1. The collapsed list of unsigned active templates. Each row
//      shows the title + description + a Review and sign button.
//   2. The expanded reading view for one selected template. Shows
//      the body, asks for a typed name + an "I have read and agree"
//      checkbox, posts to signConsentFormAction.
// After a successful sign the server-side revalidatePath('/portal')
// refreshes the parent page so the just-signed template moves to
// the "Signed" list and disappears from the unsigned list. Client-
// side we do not optimistically remove because the revalidate is
// fast and an optimistic remove on failure would mislead.
//
// The "Signed" list is rendered directly in the parent page (server
// component) because it's a read-only summary; this client
// component owns only the unsigned + signing surfaces.

const SIGNATURE_MAX = 200;

export function PortalConsentForms({
  templates,
}: {
  templates: ConsentFormTemplateForPortal[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (templates.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
      >
        Forms to review
      </h2>
      <ul className="flex flex-col gap-3">
        {templates.map((t) => (
          <li key={t.id}>
            {openId === t.id ? (
              <PortalConsentSignForm
                template={t}
                onCancel={() => setOpenId(null)}
              />
            ) : (
              <article
                className="flex flex-col gap-2 p-5"
                style={{
                  backgroundColor: "#FFFFFF",
                  border: "1px solid #0A0A0A",
                }}
              >
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[15px] font-medium text-[#0A0A0A]">
                    {t.title}
                  </p>
                  <p
                    className="text-[11px] font-medium uppercase"
                    style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
                  >
                    Not signed
                  </p>
                </header>
                {t.description && (
                  <p
                    className="text-[14px] leading-relaxed"
                    style={{ color: "#3F3F3F" }}
                  >
                    {t.description}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setOpenId(t.id)}
                  className="self-start px-5 py-2 text-[12px] font-medium uppercase"
                  style={{
                    backgroundColor: "#0A0A0A",
                    color: "#FAFAF7",
                    letterSpacing: "0.1em",
                  }}
                >
                  Review and sign
                </button>
              </article>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PortalConsentSignForm({
  template,
  onCancel,
}: {
  template: ConsentFormTemplateForPortal;
  onCancel: () => void;
}) {
  const [signatureName, setSignatureName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = signatureName.trim();
    if (trimmed.length === 0) {
      setError("Type your full name to sign.");
      return;
    }
    if (trimmed.length > SIGNATURE_MAX) {
      setError(`Name must be ${SIGNATURE_MAX} characters or fewer.`);
      return;
    }
    if (!agreed) {
      setError("Please confirm you have read and agree to this form.");
      return;
    }
    const fd = new FormData();
    fd.set("template_id", template.id);
    fd.set("signature_name", trimmed);
    fd.set("agreed", "true");
    startTransition(async () => {
      const r = await signConsentFormAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Server revalidates /portal; the parent page re-renders and
      // the template falls out of the unsigned list. We do not
      // clear local state here because the component will be
      // unmounted by the parent re-render.
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 p-5"
      style={{
        backgroundColor: "#FFFFFF",
        border: "1px solid #0A0A0A",
      }}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[15px] font-medium text-[#0A0A0A]">
          {template.title}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="text-[13px] underline"
          style={{ color: "#6B6B6B" }}
        >
          Close
        </button>
      </header>
      {template.description && (
        <p
          className="text-[14px] leading-relaxed"
          style={{ color: "#3F3F3F" }}
        >
          {template.description}
        </p>
      )}

      <div
        className="whitespace-pre-wrap text-[14px] leading-relaxed text-[#0A0A0A]"
        style={{ maxHeight: "420px", overflowY: "auto" }}
      >
        {template.body}
      </div>

      <label className="flex flex-col gap-1.5">
        <span
          className="text-[11px] font-medium uppercase"
          style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
        >
          Type your full name to sign
        </span>
        <input
          type="text"
          value={signatureName}
          onChange={(e) => setSignatureName(e.target.value)}
          maxLength={SIGNATURE_MAX}
          placeholder="e.g. Alex Smith"
          autoComplete="name"
          className="w-full bg-transparent py-2 text-[16px] outline-none"
          style={{ borderBottom: "1px solid #0A0A0A" }}
        />
      </label>

      <label
        className="flex items-start gap-3 text-[14px] leading-[1.5]"
        style={{ color: "#0A0A0A" }}
      >
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-1 h-4 w-4 flex-none"
        />
        <span>I have read and agree to this form.</span>
      </label>

      {error && (
        <p
          className="text-[13px]"
          style={{ color: "#A03030" }}
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={
            pending || signatureName.trim().length === 0 || !agreed
          }
          className="px-5 py-2 text-[12px] font-medium uppercase disabled:opacity-50"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FAFAF7",
            letterSpacing: "0.1em",
          }}
        >
          {pending ? "Signing..." : "Sign form"}
        </button>
      </div>
    </form>
  );
}
