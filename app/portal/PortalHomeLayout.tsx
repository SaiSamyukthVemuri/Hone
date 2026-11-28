import type { ReactNode } from "react";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { Button } from "@/components/ui/button";
import { MarkdownLiteBlock } from "@/app/_components/MarkdownLiteBlock";
import { formatPortalCopy } from "@/lib/portal/presentation";
import { portalLogoutAction } from "./logout/actions";
import { PortalAppointments, PortalGreeting, PortalOverview, type OverviewProps } from "./PortalOverview";
import { PortalViews } from "./PortalViews";
import styles from "./portal-home.module.css";

type Props = OverviewProps & {
  contactHref: string | null;
  expiresAt: string;
  initialView?: string | string[];
  hasHistory: boolean;
  paymentInTasks: boolean;
  booking: ReactNode;
  preCare: ReadonlyArray<{ serviceName: string; preCareText: string }>;
  postCare: ReadonlyArray<{ heading: string; text: string }>;
  paymentUnavailable: boolean;
  tasks: ReactNode;
  records: ReactNode;
  payment: ReactNode;
  cancellationPolicy: string | null;
  noShowPolicy: string | null;
};

export function PortalHomeLayout(props: Props) {
  const { presentation, studioName, firstName, hasTasks, hasHistory, hasPayment } = props;
  const context = { ownerName: presentation.ownerName, studioName, clientName: firstName };
  function sectionTitle(id: typeof presentation.sections[number]["id"]) {
    return formatPortalCopy(presentation.sections.find(section => section.id === id)!.title, context);
  }
  const hasPolicies = Boolean(props.cancellationPolicy || props.noShowPolicy);
  const careTitle = sectionTitle("care");
  const careDescription = formatPortalCopy(presentation.sections.find(s => s.id === "care")!.description, context);
  const recordsTitle = sectionTitle("records");
  return (
    <main className={styles.portal} data-testid="studio-portal">
      <a href="#portal-content" className={styles.skip}>Skip to portal content</a>
      <header className={styles.mast}>
        <div className={styles.wrap}>
          <div className={styles.brand}><span className={styles.mark} aria-hidden="true">H</span><strong>{studioName}</strong><span>Client portal</span></div>
          <div className={styles.utilities}>
            {props.contactHref && <a href={props.contactHref}>Email {presentation.ownerName || studioName}</a>}
            <form action={portalLogoutAction}><Button type="submit" variant="quiet" size="sm">Sign out</Button></form>
          </div>
        </div>
      </header>
      <div className={styles.wrap} id="portal-content" tabIndex={-1}>
        <PortalGreeting {...props} />
        <PortalViews initialView={props.initialView} panels={{
          overview: { label: "Overview", body: <PortalOverview {...props} hasCare={props.hasCare || hasPolicies} /> },
          appointments: {
            label: "Appointments",
            body: <PortalAppointments title={sectionTitle("appointments")} studioName={studioName} timezone={props.timezone} upcoming={props.upcoming} />,
          },
          ...(props.hasCare || hasPolicies ? {
            care: {
              label: careTitle,
              body: <div className={styles.contentGrid}>
                {props.hasCare && <div className={styles.paper}>
                  <h2>{careTitle}</h2>
                  {careDescription && <p>{careDescription}</p>}
                  {props.preCare.length > 0 && <h3 className={styles.kicker}>Before your appointment</h3>}
                  {props.preCare.map((entry, index) => <details key={entry.serviceName} open={index === 0} className={styles.disclosure}>
                    <summary>{entry.serviceName}</summary>
                    <MarkdownLiteBlock text={entry.preCareText} keyPrefix={`portal-before-${index}`} />
                  </details>)}
                  {props.postCare.length > 0 && <h3 className={styles.kicker}>After your appointment</h3>}
                  {props.postCare.map((entry, index) => <details key={entry.heading} open={props.preCare.length === 0 && index === 0} className={styles.disclosure}>
                    <summary>{entry.heading}</summary>
                    <MarkdownLiteBlock text={entry.text} keyPrefix={`portal-after-${index}`} />
                  </details>)}
                </div>}
                {hasPolicies && <div className={styles.paper}>
                  <h2>Studio policies</h2>
                  {props.cancellationPolicy && <details className={styles.disclosure}><summary>Cancellation policy</summary><MarkdownLiteBlock text={props.cancellationPolicy} keyPrefix="portal-cancellation" /></details>}
                  {props.noShowPolicy && <details className={styles.disclosure}><summary>No-show policy</summary><MarkdownLiteBlock text={props.noShowPolicy} keyPrefix="portal-no-show" /></details>}
                </div>}
              </div>,
            },
          } : {}),
          records: {
            label: recordsTitle,
            body: <div className={styles.contentGrid}>
              <div className={styles.stack}>
                {hasTasks && <section className={styles.paper} id="portal-tasks" aria-label={sectionTitle("tasks")}>{props.tasks}</section>}
                {hasHistory && <div className={styles.paper}>{props.records}</div>}
                {!hasHistory && props.signedFormsCount !== null && <section className={styles.paper}><h2>Completed forms</h2><p>No completed forms to show here.</p></section>}
              </div>
              {hasPayment && !props.paymentInTasks && <div id="portal-payment" className={styles.paper}>
                {props.paymentUnavailable ? <><h2>{sectionTitle("payment")}</h2><p>Card setup is unavailable right now. Please contact {studioName} if you need help.</p></> : props.payment}
              </div>}
            </div>,
          },
          ...(props.canBook !== false ? { booking: { label: "Book a visit", body: <div className={styles.paper}>{props.booking}</div> } } : {}),
        }} />
        <footer className={styles.footer}>
          <p>This device stays signed in until <FormattedDateTime iso={props.expiresAt} />.</p>
          <span>Powered by <strong>Hone</strong></span>
        </footer>
      </div>
    </main>
  );
}
