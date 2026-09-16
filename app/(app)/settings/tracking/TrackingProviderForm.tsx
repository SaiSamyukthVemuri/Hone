"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

type Result = { ok: true; last4?: string | null } | { ok: false; error: string };
type Action = (formData: FormData) => Promise<Result>;

type Current = {
  enabled: boolean;
  browserTagId: string | null;
  testEventCode: string | null;
  tokenLast4: string | null;
  tokenStatus: string;
};

// Owner-facing provider form. The token input is write-only: it is never
// pre-filled (we never receive it back), and only the last4 + status of an
// existing token are shown. Saving a blank token keeps the existing one.
export function TrackingProviderForm({
  provider,
  providerLabel,
  current,
  saveAction,
  clearTokenAction,
}: {
  provider: string;
  providerLabel: string;
  current: Current | null;
  saveAction: Action;
  clearTokenAction: Action;
}) {
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [pixelId, setPixelId] = useState(current?.browserTagId ?? "");
  const [testCode, setTestCode] = useState(current?.testEventCode ?? "");
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const hasToken = current?.tokenStatus === "active" && !!current?.tokenLast4;

  function save() {
    setMsg(null);
    setErr(null);
    const fd = new FormData();
    fd.set("provider", provider);
    fd.set("browser_tag_id", pixelId.trim());
    fd.set("test_event_code", testCode.trim());
    fd.set("enabled", enabled ? "true" : "false");
    if (token.trim()) fd.set("token", token.trim());
    start(async () => {
      const r = await saveAction(fd);
      if (r.ok) {
        setToken("");
        setMsg(hasToken && token.trim() ? "Saved. Token rotated." : "Saved.");
      } else setErr(r.error);
    });
  }

  function removeToken() {
    setMsg(null);
    setErr(null);
    const fd = new FormData();
    fd.set("provider", provider);
    start(async () => {
      const r = await clearTokenAction(fd);
      if (r.ok) {
        setEnabled(false);
        setMsg("Token removed. Provider disabled.");
      } else setErr(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{providerLabel}</h3>
        <span className="text-xs text-neutral-500">
          {hasToken ? `Token •••• ${current!.tokenLast4}` : "No token"}
        </span>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Pixel / Dataset ID</span>
        <input
          value={pixelId}
          onChange={(e) => setPixelId(e.target.value)}
          placeholder="e.g. 1234567890"
          className="max-w-[24rem] rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Conversions API token {hasToken ? "(leave blank to keep, or paste to rotate)" : ""}
        </span>
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={hasToken ? "•••• (unchanged)" : "Paste your CAPI token"}
          className="max-w-[24rem] rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-xs text-neutral-500">
          Stored encrypted; only the last 4 characters are ever shown.
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Test event code (optional)</span>
        <input
          value={testCode}
          onChange={(e) => setTestCode(e.target.value)}
          placeholder="TEST12345"
          className="max-w-[24rem] rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enable sending booking conversions to this provider</span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        {/* UI-R01 PROOF CONTROL — save.
            Previously a raw <button> with NO hover, NO :active and NO
            focus-visible: three of the four states this PR exists to supply
            were simply absent, and the fourth was a width-changing
            "Save" -> "Saving…" swap. */}
        <Button variant="primary" size="sm" onClick={save} pending={pending}>
          Save
        </Button>
        {hasToken && (
          /* UI-R01 PROOF CONTROL — destructive.
             This is the one DELIBERATE VISUAL CHANGE in this PR. Removing a
             provider token is destructive and was styled as an ordinary
             neutral-bordered button, indistinguishable from Cancel. `danger`
             is the variant the primitive already ships for "the destructive
             confirms"; the point of a shared control layer is that
             consequence is legible without the call site inventing a colour.
             Still disabled while a save is in flight, so the two actions
             cannot race. */
          <Button
            variant="danger"
            size="sm"
            onClick={removeToken}
            disabled={pending}
          >
            Remove token
          </Button>
        )}
        {msg && <span className="text-xs text-emerald-700 dark:text-emerald-300">{msg}</span>}
        {err && <span className="text-xs text-red-700 dark:text-red-300">{err}</span>}
      </div>
    </div>
  );
}
