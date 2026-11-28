import type { ReactNode } from "react";
import Link from "next/link";
import type { PortalUpcomingAppointment } from "@/lib/portal/queries";
import { formatPortalCopy, type PortalPresentation } from "@/lib/portal/presentation";
import { AppointmentReadFailure } from "./AppointmentReadFailure";
import styles from "./portal-home.module.css";

type WelcomeProps = {
  presentation: PortalPresentation;
  studioName: string;
  firstName: string;
};

export type OverviewProps = WelcomeProps & {
  timezone: string;
  upcoming: PortalUpcomingAppointment[] | null;
  formsDue: number;
  unreadCount: number;
  hasTasks: boolean;
  hasPayment: boolean;
  canBook: boolean | null;
  hasCare: boolean;
  signedFormsCount: number | null;
  preview?: boolean;
};

function studioCopy(props: WelcomeProps, text: string) {
  return formatPortalCopy(text, {
    clientName: props.firstName,
    studioName: props.studioName,
    ownerName: props.presentation.ownerName,
  });
}

export function PortalGreeting(props: WelcomeProps) {
  return (
    <div className={styles.intro}>
      <h1>{studioCopy(props, props.presentation.welcomeHeading)}</h1>
      {props.presentation.welcomeMessage && <p>{studioCopy(props, props.presentation.welcomeMessage)}</p>}
    </div>
  );
}

function PortalAction({ href, preview, children, prominent }: {
  href: string;
  preview?: boolean;
  children: ReactNode;
  prominent?: boolean;
}) {
  const className = prominent ? styles.primaryLink : styles.actionLink;
  if (preview) return <span className={className}>{children}</span>;
  return <a data-portal-nav href={href} className={className}>{children}<span aria-hidden="true"> →</span></a>;
}

function VisitTime({ appointment, timezone }: { appointment: PortalUpcomingAppointment; timezone: string }) {
  return (
    <time dateTime={appointment.startsAt}>
      {new Intl.DateTimeFormat("en", {
        dateStyle: "full", timeZone: timezone,
      }).format(new Date(appointment.startsAt))} · {new Intl.DateTimeFormat("en", {
        hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: timezone,
      }).format(new Date(appointment.startsAt))}
    </time>
  );
}

export function PortalAppointments({ upcoming, studioName, timezone, title, description, preview }: {
  upcoming: PortalUpcomingAppointment[] | null;
  studioName: string;
  timezone: string;
  title: string;
  description?: string;
  preview?: boolean;
}) {
  const next = upcoming?.[0];
  return (
    <section className={styles.appointments} aria-label={title}>
      <div className={styles.cardHead}>
        <h2>{title}</h2>
        {next && <span className={styles.badge}>Booked</span>}
      </div>
      {description && <p className={styles.cardNote}>{description}</p>}
      {upcoming === null ? (
        <div className={styles.cardBody}><AppointmentReadFailure /></div>
      ) : !next ? (
        <div className={styles.cardBody}><p>No upcoming appointments</p></div>
      ) : (
        <>
          <div className={styles.visit} data-portal-appointment-id={next.id}>
            <div className={styles.dateSlip} aria-hidden="true">
              <span>{new Intl.DateTimeFormat("en", { month: "short", timeZone: timezone }).format(new Date(next.startsAt))}</span>
              <strong>{new Intl.DateTimeFormat("en", { day: "numeric", timeZone: timezone }).format(new Date(next.startsAt))}</strong>
            </div>
            <div>
              <h3>{next.serviceName}</h3>
              <p><VisitTime appointment={next} timezone={timezone} /></p>
              <p>{next.durationMinutes} min · {studioName}</p>
            </div>
          </div>
          {next.manageToken && !preview && (
            <div className={styles.cardFoot}>
              <Link prefetch={false} className={styles.actionLink} href={`/manage/${next.manageToken}`}>Manage appointment →</Link>
            </div>
          )}
          {upcoming.length > 1 && (
            <details className={styles.later}>
              <summary>{upcoming.length - 1} more upcoming {upcoming.length === 2 ? "appointment" : "appointments"}</summary>
              <ul>{upcoming.slice(1).map(appointment => (
                <li key={appointment.id} data-portal-appointment-id={appointment.id}>
                  <div><strong>{appointment.serviceName}</strong><p><VisitTime appointment={appointment} timezone={timezone} /> · {appointment.durationMinutes} min</p></div>
                  {appointment.manageToken && !preview && <Link prefetch={false} className={styles.actionLink} href={`/manage/${appointment.manageToken}`}>Manage</Link>}
                </li>
              ))}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

export function PortalOverview(props: OverviewProps) {
  const { presentation, formsDue, unreadCount, hasTasks, signedFormsCount, preview } = props;
  // A pending form is the client's first task. Otherwise lead with their booking.
  const featured = formsDue > 0 ? "tasks" : "appointments";
  const sections = presentation.sections.filter(section => section.visible);
  const first = sections.find(section => section.id === featured);
  const ordered = first ? [first, ...sections.filter(section => section !== first)] : sections;
  return (
    <div className={styles.grid}>
      {ordered.map(section => {
        const { id } = section;
        const title = studioCopy(props, section.title);
        const description = studioCopy(props, section.description);
        if (id === "appointments") {
          return <PortalAppointments key={id} {...props} title={title} description={description} />;
        }
        if (id === "booking") {
          if (props.canBook === false) return null;
          return (
            <section key={id} className={styles.bookCard}>
              <h2>{title}</h2>
              <p>{description || (props.canBook === null ? "Booking availability couldn’t load." : "Choose a service and see available times.")}</p>
              <PortalAction href="/portal?view=booking" preview={preview} prominent>{props.canBook === null ? "View booking" : "Find a time"}</PortalAction>
            </section>
          );
        }
        if (id === "tasks") {
          if (!hasTasks) return null;
          return (
            <section key={id} className={styles.taskCard}>
              <h2>{title}</h2>
              {description && <p>{description}</p>}
              {formsDue > 0 && <p className={styles.taskCount}>{formsDue} {formsDue === 1 ? "form" : "forms"} to complete</p>}
              {unreadCount > 0 && <p>{unreadCount} unread {unreadCount === 1 ? "message" : "messages"}</p>}
              <PortalAction href="/portal?view=records#portal-tasks" preview={preview} prominent>{formsDue ? "Review forms" : "View tasks"}</PortalAction>
            </section>
          );
        }
        if ((id === "care" && !props.hasCare) || (id === "payment" && !props.hasPayment)) return null;
        const href = id === "care" ? "/portal?view=care" : id === "payment" ? "/portal?view=records#portal-payment" : "/portal?view=records";
        const detail = id === "records" && signedFormsCount !== null ? `${signedFormsCount} completed ${signedFormsCount === 1 ? "form" : "forms"}` : "";
        const content = <><span><strong>{title}</strong>{(description || detail) && <small>{description || detail}</small>}</span><span aria-hidden="true">→</span></>;
        return preview ? <div key={id} className={styles.resource}>{content}</div> : <a key={id} className={styles.resource} href={href} data-portal-nav>{content}</a>;
      })}
    </div>
  );
}
