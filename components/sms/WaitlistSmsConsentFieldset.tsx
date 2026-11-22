import {
  SMS_CONSENT_ANSWER_FIELD,
  SMS_CONSENT_ANSWER_NO,
  SMS_CONSENT_ANSWER_YES,
  SMS_JOIN_CONSENT_QUESTION,
  SMS_OPERATIONAL_CONSENT_DECLINED_NOTE,
} from "@/lib/waitlist/prospect-sms-consent";
import { APPOINTMENT_SMS_PRIVACY_PATH, SMS_TERMS_PATH, WAITLIST_SMS_NOTICE_LINES } from "@/lib/sms/appointment-sms-copy";

// The waitlist text-message question exactly as the join form shows it, shared with /sms-consent so the evidence is the real control.
// The QUESTION is the stored v2 wording (unchanged); the notice lines beside it are disclosure only. Two answers, neither preselected,
// and No still joins. In `preview` the radios are disabled and carry no field name, so nothing can be submitted from the evidence page.
const INK = "#0A0A0A";
const MUTED = "#6B6B6B";
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0A0A0A] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAFAF7]";

export type WaitlistSmsAnswer = typeof SMS_CONSENT_ANSWER_YES | typeof SMS_CONSENT_ANSWER_NO | null;

export function WaitlistSmsConsentFieldset({
  questionId,
  answer,
  onChange,
  preview = false,
}: {
  questionId: string;
  answer: WaitlistSmsAnswer;
  onChange?: (next: Exclude<WaitlistSmsAnswer, null>) => void;
  preview?: boolean;
}) {
  const radio = (value: typeof SMS_CONSENT_ANSWER_YES | typeof SMS_CONSENT_ANSWER_NO, label: string) => (
    <label className="flex min-h-[44px] items-center gap-2 text-[15px]" style={{ color: INK }}>
      <input
        type="radio"
        name={preview ? undefined : SMS_CONSENT_ANSWER_FIELD}
        value={value}
        checked={answer === value}
        onChange={() => onChange?.(value)}
        disabled={preview}
        className={`h-4 w-4 ${FOCUS_RING}`}
      />
      {label}
    </label>
  );
  return (
    <fieldset className="flex w-full flex-col gap-2" aria-describedby={questionId} data-testid="waitlist-sms-question">
      <legend className="text-[12px] uppercase tracking-[0.1em]" style={{ color: MUTED }}>
        Text messages <span aria-hidden="true">*</span>
      </legend>
      <p id={questionId} className="text-[15px] leading-[1.6]" style={{ color: INK }}>
        {SMS_JOIN_CONSENT_QUESTION}
      </p>
      <div className="flex flex-wrap gap-6">
        {radio(SMS_CONSENT_ANSWER_YES, "Yes")}
        {radio(SMS_CONSENT_ANSWER_NO, "No")}
      </div>
      <div className="text-[13px] leading-[1.6]" style={{ color: MUTED }} data-testid="waitlist-sms-notice">
        {WAITLIST_SMS_NOTICE_LINES.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p>
          <a className={`underline ${FOCUS_RING}`} href={APPOINTMENT_SMS_PRIVACY_PATH} target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </a>
          {" · "}
          <a className={`underline ${FOCUS_RING}`} href={SMS_TERMS_PATH} target="_blank" rel="noopener noreferrer">
            SMS Terms
          </a>
        </p>
      </div>
      {answer === SMS_CONSENT_ANSWER_NO && (
        <p className="text-[13px] leading-[1.6]" style={{ color: MUTED }} data-testid="waitlist-sms-declined-note">
          {SMS_OPERATIONAL_CONSENT_DECLINED_NOTE}
        </p>
      )}
    </fieldset>
  );
}
