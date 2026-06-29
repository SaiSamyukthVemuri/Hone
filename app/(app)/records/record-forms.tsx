"use client";

import { Fragment, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecordActionResult } from "./actions";

// PR #280 (Chloe record-keeping feedback): shared option shapes for the
// same-studio operator dropdown + exposed-person selector. All lists are fed
// from server-side same-studio queries (getPractitionersForStudio /
// getClientsForStudio), so no cross-studio person can ever appear as an option.
export type OperatorOption = { id: string; name: string };
export type ClientContactOption = {
  id: string;
  name: string;
  phone: string;
  address: string;
};

// Sentinel select value for "Other (type a name)" — a non-staff operator.
const OTHER_OPERATOR = "__other__";

// PR #205: add-record forms for the Record Keeping logbook. Plain
// uncontrolled forms posting to the server actions; explicit saved /
// error feedback; iPad-friendly tap targets. No payment, public, or
// portal surface.

type Action = (formData: FormData) => Promise<RecordActionResult>;

const INPUT_CLS =
  "rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950";
const LABEL_CLS =
  "text-[11px] uppercase tracking-wider text-neutral-500";

function AddRecordForm({
  action,
  submitLabel,
  children,
}: {
  action: Action;
  submitLabel: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  // PR #280: bump on a successful submit to REMOUNT the fields. form.reset()
  // clears uncontrolled DOM inputs but NOT child React state (the OperatorPicker
  // select, the ExposedPersonPicker person-type) — without this, a second add
  // would keep the previous operator/person selection. Remounting resets both.
  const [resetKey, setResetKey] = useState(0);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        setError(null);
        setSaved(false);
        startTransition(async () => {
          const res = await action(fd);
          if (res.ok) {
            form.reset();
            setResetKey((k) => k + 1);
            setSaved(true);
            router.refresh();
          } else {
            setError(res.error);
          }
        });
      }}
      className="flex flex-col gap-3"
    >
      <Fragment key={resetKey}>{children}</Fragment>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        {saved && (
          <span className="text-sm text-green-700 dark:text-green-400" role="status">
            Record saved.
          </span>
        )}
        {error && (
          <span className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  placeholder,
  wide = false,
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  wide?: boolean;
  defaultValue?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 ${wide ? "sm:col-span-2" : ""}`}>
      <span className={LABEL_CLS}>
        {label}
        {required ? "" : " (optional)"}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className={INPUT_CLS}
      />
    </label>
  );
}

function NotesField({
  name = "notes",
  defaultValue,
}: {
  name?: string;
  defaultValue?: string;
}) {
  return (
    <label className="flex flex-col gap-1 sm:col-span-2">
      <span className={LABEL_CLS}>Notes (optional)</span>
      <textarea
        name={name}
        rows={2}
        defaultValue={defaultValue}
        className={INPUT_CLS}
      />
    </label>
  );
}

const PILL_ON =
  "rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900";
const PILL_OFF =
  "rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300";

// PR #280: operator dropdown — current user + active same-studio staff, with a
// free-text "Other" fallback (for an operator without an account, or legacy
// records). When a staff member is picked, only operator_practitioner_id is
// submitted and the server resolves the display name; "Other" submits a typed
// operator_name. The staff list is same-studio only (server-fed).
function OperatorPicker({
  staff,
  currentPractitionerId,
  defaultPractitionerId,
  defaultName,
}: {
  staff: OperatorOption[];
  currentPractitionerId: string;
  defaultPractitionerId?: string | null;
  defaultName?: string;
}) {
  const savedIsStaff =
    !!defaultPractitionerId && staff.some((s) => s.id === defaultPractitionerId);
  // Edit with a current-staff operator -> preselect them. Edit with a
  // legacy/free-text operator -> "Other" + prefill the name. New record ->
  // default to the current user.
  const initial = savedIsStaff
    ? (defaultPractitionerId as string)
    : defaultName
      ? OTHER_OPERATOR
      : currentPractitionerId;
  const [sel, setSel] = useState(initial);
  const isOther = sel === OTHER_OPERATOR;
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className={LABEL_CLS}>Operator</span>
        <select
          name="operator_practitioner_id"
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          className={INPUT_CLS}
        >
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.id === currentPractitionerId ? " (you)" : ""}
            </option>
          ))}
          <option value={OTHER_OPERATOR}>Other (type a name)</option>
        </select>
      </label>
      {isOther && (
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLS}>Operator name</span>
          <input
            type="text"
            name="operator_name"
            defaultValue={defaultName}
            placeholder="Name of the operator"
            className={INPUT_CLS}
          />
        </label>
      )}
    </>
  );
}

// PR #280: exposed-person selector for exposure incidents. The three stored
// fields (full name / phone / address) stay free text and editable; picking a
// same-studio Client or Staff/self just autofills them (imperatively, so the
// form still resets cleanly). "Other" is the manual path. No client/staff FK is
// stored — this only pre-fills text the member could type anyway, so the
// owner-only read posture of exposure incidents is unchanged.
function ExposedPersonPicker({
  clients,
  staff,
  defaults,
}: {
  clients: ClientContactOption[];
  staff: OperatorOption[];
  defaults?: { full_name: string; phone: string; address: string };
}) {
  const [kind, setKind] = useState<"client" | "staff" | "other">("other");
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);

  function fill(name: string, phone: string, address: string) {
    if (nameRef.current) nameRef.current.value = name;
    if (phoneRef.current) phoneRef.current.value = phone;
    if (addressRef.current) addressRef.current.value = address;
  }

  return (
    <>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <span className={LABEL_CLS}>Exposed person</span>
        <div className="flex flex-wrap gap-2">
          {(["client", "staff", "other"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={kind === k ? PILL_ON : PILL_OFF}
            >
              {k === "client" ? "Client" : k === "staff" ? "Staff / myself" : "Other"}
            </button>
          ))}
        </div>
      </div>

      {kind === "client" && (
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={LABEL_CLS}>Select client (same studio)</span>
          <select
            className={INPUT_CLS}
            defaultValue=""
            onChange={(e) => {
              const c = clients.find((x) => x.id === e.target.value);
              if (c) fill(c.name, c.phone, c.address);
            }}
          >
            <option value="" disabled>
              Choose a client…
            </option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {kind === "staff" && (
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={LABEL_CLS}>Select staff / myself (same studio)</span>
          <select
            className={INPUT_CLS}
            defaultValue=""
            onChange={(e) => {
              const s = staff.find((x) => x.id === e.target.value);
              // Practitioners carry a name (no phone/address here); leave
              // contact fields for manual entry.
              if (s) fill(s.name, "", "");
            }}
          >
            <option value="" disabled>
              Choose a person…
            </option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* The actual stored fields — always shown + editable; the pickers above
          autofill them, and the practitioner can correct anything after. */}
      <label className="flex flex-col gap-1">
        <span className={LABEL_CLS}>Exposed person&apos;s full name</span>
        <input
          ref={nameRef}
          type="text"
          name="exposed_person_full_name"
          required
          defaultValue={defaults?.full_name ?? ""}
          className={INPUT_CLS}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={LABEL_CLS}>Phone (optional)</span>
        <input
          ref={phoneRef}
          type="text"
          name="exposed_person_phone"
          defaultValue={defaults?.phone ?? ""}
          className={INPUT_CLS}
        />
      </label>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className={LABEL_CLS}>Address (optional)</span>
        <input
          ref={addressRef}
          type="text"
          name="exposed_person_address"
          defaultValue={defaults?.address ?? ""}
          className={INPUT_CLS}
        />
      </label>
    </>
  );
}

export function AddSterileItemForm({ action }: { action: Action }) {
  return (
    <AddRecordForm action={action} submitLabel="Add sterile item record">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date purchased" name="date_purchased" type="date" required />
        <Field
          label="Item description"
          name="item_description"
          required
          placeholder="e.g. Ballet F3 stainless probes"
        />
        <Field label="Manufacturer" name="manufacturer_name" placeholder="e.g. Ballet" />
        <Field label="Amount purchased" name="amount_purchased" placeholder="e.g. 50" />
        <Field label="Lot #" name="lot_number" placeholder="e.g. 460941" />
        <Field label="Expiry date" name="expiry_date" type="date" />
        <NotesField />
      </div>
    </AddRecordForm>
  );
}

export function AddDisinfectantForm({
  action,
  staff,
  currentPractitionerId,
}: {
  action: Action;
  staff: OperatorOption[];
  currentPractitionerId: string;
}) {
  return (
    <AddRecordForm action={action} submitLabel="Add disinfectant record">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date prepared" name="date_prepared" type="date" required />
        <Field
          label="Disinfectant name"
          name="disinfectant_name"
          required
          placeholder="e.g. CaviCide"
        />
        <Field label="Concentration" name="concentration" placeholder="e.g. ready to use / 1:10" />
        {/* PR #280: three distinct dates — prepared (made), discard/replace-by
            (drives the read-time due alert), and actual date discarded. */}
        <Field label="Discard / replace by" name="discard_due_date" type="date" />
        <Field label="Actual date discarded" name="date_discarded" type="date" />
        <OperatorPicker staff={staff} currentPractitionerId={currentPractitionerId} />
        <NotesField />
      </div>
    </AddRecordForm>
  );
}

export function AddExposureIncidentForm({
  action,
  clients,
  staff,
}: {
  action: Action;
  clients: ClientContactOption[];
  staff: OperatorOption[];
}) {
  return (
    <AddRecordForm action={action} submitLabel="Add exposure incident">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Incident date" name="incident_date" type="date" required />
        <ExposedPersonPicker clients={clients} staff={staff} />
        <Field label="Staff involved" name="staff_involved_name" />
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={LABEL_CLS}>How the exposure occurred</span>
          <textarea name="exposure_details" rows={3} className={INPUT_CLS} />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={LABEL_CLS}>Action taken</span>
          <textarea name="action_taken" rows={3} className={INPUT_CLS} />
        </label>
        <NotesField />
      </div>
    </AddRecordForm>
  );
}

// Explicit "Procedure risks explained and aftercare information
// provided" mark on a client procedure record. Never auto-set;
// reversible in case of a mis-tap.
export function AftercareExplainedToggle({
  sessionId,
  explainedAt,
  action,
}: {
  sessionId: string;
  explainedAt: string | null;
  action: Action;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const explained = !!explainedAt;
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={explained}
      onClick={() => {
        const fd = new FormData();
        fd.set("session_id", sessionId);
        fd.set("explained", explained ? "false" : "true");
        startTransition(async () => {
          await action(fd);
          router.refresh();
        });
      }}
      className={
        explained
          ? "rounded-md border border-green-300 bg-green-50 px-3 py-2 text-xs font-medium text-green-900 hover:bg-green-100 disabled:opacity-50 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200"
          : "rounded-md border border-neutral-300 px-3 py-2 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
      }
    >
      {explained
        ? "✓ Risks explained and aftercare provided"
        : "Mark: procedure risks explained and aftercare information provided"}
    </button>
  );
}

// PR #206: edit forms for the three logbooks. Same shared wrapper as
// the add forms (audit events are written by the 0086 DB triggers, so
// these forms carry no audit code and cannot skip it). No delete or
// archive affordance exists anywhere in this module, by design.

type SterileItemRecord = {
  id: string;
  date_purchased: string;
  item_description: string;
  manufacturer_name: string;
  amount_purchased: string;
  lot_number: string;
  expiry_date: string | null;
  notes: string | null;
};

export function EditSterileItemForm({
  record,
  action,
}: {
  record: SterileItemRecord;
  action: Action;
}) {
  return (
    <AddRecordForm action={action} submitLabel="Save changes">
      <input type="hidden" name="record_id" value={record.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Date purchased"
          name="date_purchased"
          type="date"
          required
          defaultValue={record.date_purchased?.slice(0, 10)}
        />
        <Field
          label="Item description"
          name="item_description"
          required
          defaultValue={record.item_description}
        />
        <Field
          label="Manufacturer"
          name="manufacturer_name"
          defaultValue={record.manufacturer_name}
        />
        <Field
          label="Amount purchased"
          name="amount_purchased"
          defaultValue={record.amount_purchased}
        />
        <Field label="Lot #" name="lot_number" defaultValue={record.lot_number} />
        <Field
          label="Expiry date"
          name="expiry_date"
          type="date"
          defaultValue={record.expiry_date?.slice(0, 10)}
        />
        <NotesField defaultValue={record.notes ?? ""} />
      </div>
    </AddRecordForm>
  );
}

type DisinfectantRecord = {
  id: string;
  date_prepared: string;
  disinfectant_name: string;
  concentration: string;
  discard_due_date: string | null;
  date_discarded: string | null;
  operator_practitioner_id: string | null;
  operator_name: string;
  notes: string | null;
};

export function EditDisinfectantForm({
  record,
  action,
  staff,
  currentPractitionerId,
}: {
  record: DisinfectantRecord;
  action: Action;
  staff: OperatorOption[];
  currentPractitionerId: string;
}) {
  return (
    <AddRecordForm action={action} submitLabel="Save changes">
      <input type="hidden" name="record_id" value={record.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Date prepared"
          name="date_prepared"
          type="date"
          required
          defaultValue={record.date_prepared?.slice(0, 10)}
        />
        <Field
          label="Disinfectant name"
          name="disinfectant_name"
          required
          defaultValue={record.disinfectant_name}
        />
        <Field
          label="Concentration"
          name="concentration"
          defaultValue={record.concentration}
        />
        <Field
          label="Discard / replace by"
          name="discard_due_date"
          type="date"
          defaultValue={record.discard_due_date?.slice(0, 10)}
        />
        <Field
          label="Actual date discarded"
          name="date_discarded"
          type="date"
          defaultValue={record.date_discarded?.slice(0, 10)}
        />
        <OperatorPicker
          staff={staff}
          currentPractitionerId={currentPractitionerId}
          defaultPractitionerId={record.operator_practitioner_id}
          defaultName={record.operator_name}
        />
        <NotesField defaultValue={record.notes ?? ""} />
      </div>
    </AddRecordForm>
  );
}

type ExposureIncidentRecord = {
  id: string;
  incident_date: string;
  exposed_person_full_name: string;
  exposed_person_address: string;
  exposed_person_phone: string;
  exposure_details: string;
  action_taken: string;
  staff_involved_name: string;
  notes: string | null;
};

export function EditExposureIncidentForm({
  record,
  action,
  clients,
  staff,
}: {
  record: ExposureIncidentRecord;
  action: Action;
  clients: ClientContactOption[];
  staff: OperatorOption[];
}) {
  return (
    <AddRecordForm action={action} submitLabel="Save changes">
      <input type="hidden" name="record_id" value={record.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Incident date"
          name="incident_date"
          type="date"
          required
          defaultValue={record.incident_date?.slice(0, 10)}
        />
        <ExposedPersonPicker
          clients={clients}
          staff={staff}
          defaults={{
            full_name: record.exposed_person_full_name,
            phone: record.exposed_person_phone,
            address: record.exposed_person_address,
          }}
        />
        <Field
          label="Staff involved"
          name="staff_involved_name"
          defaultValue={record.staff_involved_name}
        />
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={LABEL_CLS}>How the exposure occurred</span>
          <textarea
            name="exposure_details"
            rows={3}
            defaultValue={record.exposure_details}
            className={INPUT_CLS}
          />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className={LABEL_CLS}>Action taken</span>
          <textarea
            name="action_taken"
            rows={3}
            defaultValue={record.action_taken}
            className={INPUT_CLS}
          />
        </label>
        <NotesField defaultValue={record.notes ?? ""} />
      </div>
    </AddRecordForm>
  );
}
