import {
  APPOINTMENT_SMS_CONSENT_DISCLOSURE,
  APPOINTMENT_SMS_PRIVACY_PATH,
  APPOINTMENT_SMS_TERMS_PATH,
  appointmentSmsConsentLabel,
} from "@/lib/sms/appointment-sms-copy";

// The appointment-SMS opt-in as the client sees it on the public booking form, and as /sms-consent shows it. ONE component, so the evidence
// page is the real step, not a picture of it. Opt-in only: unticked by default, never required, and declining does NOT block booking.
// `studioName` is the SERVER-RESOLVED studio name (never form input). In the form the box is controlled; on /sms-consent it is rendered
// read-only (`preview`), still unticked.
export function AppointmentSmsConsent({
  studioName,
  checked,
  onChange,
  preview = false,
}: {
  studioName: string;
  checked: boolean;
  onChange?: (next: boolean) => void;
  preview?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 text-[14px] leading-[1.5]">
      <input
        type="checkbox"
        name={preview ? undefined : "sms_consent_checkbox"}
        checked={checked}
        onChange={(e) => onChange?.(e.target.checked)}
        readOnly={preview}
        disabled={preview}
        className="mt-1 h-4 w-4 flex-none"
      />
      <span>
        <span className="block">{appointmentSmsConsentLabel(studioName)}</span>
        <span className="mt-1 block text-[12px]" style={{ color: "#6B6B6B" }}>
          {APPOINTMENT_SMS_CONSENT_DISCLOSURE.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
          <span className="block">
            <a className="underline" href={APPOINTMENT_SMS_PRIVACY_PATH} target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
            {" · "}
            <a className="underline" href={APPOINTMENT_SMS_TERMS_PATH} target="_blank" rel="noopener noreferrer">
              Terms
            </a>
          </span>
        </span>
      </span>
    </label>
  );
}
