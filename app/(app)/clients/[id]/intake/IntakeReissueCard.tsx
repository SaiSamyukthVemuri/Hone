"use client";

import { useState, useTransition } from "react";
import { requestIntakeUpdateAction } from "./actions";

type Props = {
  clientId: string;
  clientHasEmail: boolean;
};

// "Request intake update" card. Replaces the prior toast-only stub.
// Two-step interaction:
//   1. Practitioner clicks Request intake update.
//   2. Confirmation explains the new in-progress row, preserved
//      history, and the email-vs-copy choice.
//   3. On confirm, server action creates a fresh row + token; the
//      card stays mounted to show the URL + Copy button + email
//      success state.
//
// Confirmation guards against accidental duplicate-row creation by
// requiring an explicit second click.
export function IntakeReissueCard({ clientId, clientHasEmail }: Props) {
  const [stage, setStage] = useState<"idle" | "confirm" | "done">("idle");
  const [sendEmail, setSendEmail] = useState<boolean>(clientHasEmail);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [result, setResult] = useState<{
    intakeUrl: string;
    emailSent: boolean;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("send_email", sendEmail && clientHasEmail ? "true" : "false");
    setError(null);
    startTransition(async () => {
      const res = await requestIntakeUpdateAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult({ intakeUrl: res.intakeUrl, emailSent: res.emailSent });
      setStage("done");
    });
  }

  function copyLink() {
    if (!result) return;
    void navigator.clipboard.writeText(result.intakeUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        setError("Copy failed. Select and copy the link manually.");
      },
    );
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
        Request intake update
      </h2>
      {stage === "idle" && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Send the client a fresh intake form. Previous intakes stay on
            file and are not changed.
          </p>
          <div>
            <button
              type="button"
              onClick={() => setStage("confirm")}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
            >
              Request intake update
            </button>
          </div>
        </div>
      )}
      {stage === "confirm" && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            This will create a new in-progress intake for this client. The
            client&apos;s previously submitted or reviewed intakes will be
            preserved and remain viewable in the history below.
          </p>
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={sendEmail}
              disabled={!clientHasEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-neutral-400"
            />
            <span>
              Email the client the new intake link
              {!clientHasEmail && (
                <span className="ml-1 text-xs text-neutral-500">
                  (no email on file)
                </span>
              )}
            </span>
          </label>
          {error && (
            <p className="text-xs text-red-700" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={isPending}
              className="rounded-md bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
            >
              {isPending ? "Creating..." : "Create new intake request"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStage("idle");
                setError(null);
              }}
              disabled={isPending}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {stage === "done" && result && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            New intake created.
            {result.emailSent
              ? " The client has been emailed the new link."
              : clientHasEmail
                ? " Email was not sent; copy the link below to share it manually."
                : " This client has no email on file; copy the link below to share it manually."}
          </p>
          <div className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <span className="break-all text-xs text-neutral-700 dark:text-neutral-300">
              {result.intakeUrl}
            </span>
            <div>
              <button
                type="button"
                onClick={copyLink}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          </div>
          {error && (
            <p className="text-xs text-red-700" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
