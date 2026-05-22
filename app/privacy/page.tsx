import type { Metadata } from "next";
import {
  H2,
  H3,
  P,
  UL,
  PolicyLayout,
} from "@/app/_components/PolicyLayout";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Hone collects, uses, stores, shares, and protects personal information. PIPEDA-compliant policy for the practice memory system for permanent hair removal.",
};

export default function PrivacyPolicyPage() {
  return (
    <PolicyLayout
      title="Hone Privacy Policy"
      effectiveDate="May 22, 2026"
      lastUpdated="May 22, 2026"
    >
      <H2 id="who-we-are">1. Who we are</H2>
      <P>
        Hone is a software service for electrolysis and skincare practitioners
        to manage client records, appointments, treatment notes, and related
        practice operations.
      </P>
      <P>
        Hone is operated by <strong>Sam Vemuri</strong> (an individual
        operating as Hone, pending incorporation), located in Ontario, Canada.
      </P>
      <P>
        For privacy-related questions, contact us at{" "}
        <a className="underline" href="mailto:privacy@hone.care">
          privacy@hone.care
        </a>
        .
      </P>
      <P>
        A formal mailing address will be provided here once our registered
        business address is established. In the interim, written correspondence
        may be sent to privacy@hone.care and we will provide a mailing address
        for service of legal documents upon request.
      </P>

      <H2 id="scope">2. Scope</H2>
      <P>
        This policy describes how we collect, use, store, share, and protect
        personal information when you use Hone at hone.care or any subdomain.
        It applies to:
      </P>
      <UL>
        <li>
          <strong>Practitioners</strong> who sign up to use Hone to run their
          practice (&ldquo;Studio Owners&rdquo; and &ldquo;Practitioners&rdquo;)
        </li>
        <li>
          <strong>Clients</strong> of those practitioners whose information is
          entered into Hone by the practitioner
        </li>
      </UL>
      <P>
        We process data on behalf of practitioners. Practitioners are the{" "}
        <strong>data controllers</strong> of their clients&rsquo; information.
        Hone is the <strong>data processor</strong>.
      </P>

      <H2 id="personal-information-we-collect">
        3. Personal information we collect
      </H2>

      <H3 id="from-practitioners-directly">From practitioners directly</H3>
      <UL>
        <li>Name, email address, phone number</li>
        <li>Login credentials (passwords are hashed, never stored in plaintext)</li>
        <li>Studio name, business address, business contact info</li>
        <li>Billing information (processed by our payment processor, not stored by Hone)</li>
      </UL>

      <H3 id="from-practitioners-about-clients">
        From practitioners about their clients
      </H3>
      <UL>
        <li>Client name, contact information (email, phone, address)</li>
        <li>Date of birth, gender, pronouns</li>
        <li>Skin type, Fitzpatrick classification, allergies, contraindications</li>
        <li>Treatment notes, session records, photos (if uploaded)</li>
        <li>Appointment history, treatment plans, treatment goals</li>
        <li>Emergency contact information</li>
        <li>Health intake responses</li>
      </UL>

      <H3 id="automatically-when-you-use-hone">
        Automatically when you use Hone
      </H3>
      <UL>
        <li>IP address, browser type, device information</li>
        <li>Pages visited, actions taken, timestamps</li>
        <li>Cookies and similar technologies for authentication and session management</li>
      </UL>

      <H3 id="from-third-parties">From third parties</H3>
      <UL>
        <li>Authentication providers (Google) if you sign in with them</li>
        <li>Payment processors for billing confirmation</li>
      </UL>

      <H3 id="sensitive-health-information">Sensitive health information</H3>
      <P>
        Some of the information that practitioners enter about their clients is{" "}
        <strong>sensitive health information</strong>, including:
      </P>
      <UL>
        <li>Allergies and contraindications</li>
        <li>Skin conditions and Fitzpatrick skin type</li>
        <li>Treatment notes and clinical observations</li>
        <li>Health intake responses (medical history, medications, conditions)</li>
        <li>Photographs of skin or treatment areas</li>
      </UL>
      <P>
        Sensitive health information receives enhanced protection under
        Canadian privacy law and our practices:
      </P>
      <UL>
        <li>
          Practitioners must obtain <strong>explicit, informed consent</strong>{" "}
          from clients before entering sensitive health information into Hone
        </li>
        <li>
          We apply strict access controls so this information is only visible
          to authorized practitioners within the client&rsquo;s studio
        </li>
        <li>
          Practitioners are responsible for handling this information in
          accordance with applicable health information privacy laws in their
          jurisdiction
        </li>
        <li>
          Clients have the right to know what sensitive health information
          their practitioner has stored about them and to request access
          through their practitioner
        </li>
      </UL>
      <P>
        If you are a client and have concerns about sensitive health
        information stored about you in Hone, contact your practitioner
        directly. If your practitioner does not respond, you may also contact
        us at privacy@hone.care.
      </P>

      <H2 id="how-we-use-personal-information">
        4. How we use personal information
      </H2>
      <P>We use personal information to:</P>
      <UL>
        <li>Provide the Hone service to practitioners</li>
        <li>Authenticate users and secure accounts</li>
        <li>
          Send appointment reminders and confirmations on behalf of
          practitioners (only when the practitioner has enabled this)
        </li>
        <li>Process payments and billing</li>
        <li>Respond to support requests</li>
        <li>Detect and prevent fraud, abuse, and security incidents</li>
        <li>Comply with legal obligations</li>
        <li>Improve the service through aggregate, anonymized analysis</li>
      </UL>
      <P>
        <strong>We do not:</strong>
      </P>
      <UL>
        <li>Sell personal information to third parties</li>
        <li>Use client health information for advertising</li>
        <li>Train machine learning models on practitioner or client data</li>
        <li>
          Access practitioner data except as needed for support (with
          permission) or required by law
        </li>
      </UL>

      <H2 id="where-we-store-data">5. Where we store data</H2>
      <P>
        Personal information is stored on infrastructure provided by{" "}
        <strong>Supabase</strong>, hosted in{" "}
        <strong>AWS US-East-1 (Northern Virginia, United States)</strong>.
      </P>
      <P>
        This means data may be transferred to and stored outside of Canada. The
        United States has different privacy laws than Canada, and US
        authorities may have legal access to data stored in the US under US
        law.
      </P>
      <P>
        We selected this provider because it offers strong security,
        reliability, and the technical features needed to operate Hone. We are
        evaluating Canadian data residency options for future deployments.
      </P>
      <P>
        Practitioners and clients in Canada should be aware that by using Hone,
        their information is transferred to and processed in the United States.
      </P>

      <H2 id="how-we-share-personal-information">
        6. How we share personal information
      </H2>
      <P>We share personal information only as follows:</P>
      <P>
        <strong>With service providers</strong> who help us operate Hone, under
        contract:
      </P>
      <UL>
        <li>Supabase (database and authentication)</li>
        <li>Vercel (web hosting)</li>
        <li>Resend (transactional email delivery)</li>
        <li>Twilio (SMS delivery, when enabled by practitioner)</li>
        <li>Stripe (payment processing, when enabled by practitioner)</li>
        <li>Anthropic (AI-assisted features, when enabled, with data minimization)</li>
      </UL>
      <P>
        <strong>When required by law</strong>, such as in response to a valid
        court order, subpoena, or government request, after legal review.
      </P>
      <P>
        <strong>With clients of practitioners</strong>, at the
        practitioner&rsquo;s direction (e.g., appointment confirmation emails
        sent to a client).
      </P>
      <P>
        <strong>In connection with a business transfer</strong>, such as a
        merger or sale of assets, with notice to affected users.
      </P>
      <P>We do not share personal information for marketing purposes.</P>

      <H2 id="cookies-and-tracking">7. Cookies and tracking</H2>
      <P>We use cookies for:</P>
      <UL>
        <li>Authentication (keeping you signed in)</li>
        <li>Session management</li>
        <li>Security (preventing cross-site request forgery)</li>
      </UL>
      <P>
        We do not use third-party advertising cookies, behavioral tracking
        cookies, or analytics cookies that share data with advertising
        networks.
      </P>

      <H2 id="your-rights-under-pipeda">8. Your rights under PIPEDA</H2>
      <P>
        If you are in Canada, you have the following rights under the Personal
        Information Protection and Electronic Documents Act (PIPEDA):
      </P>
      <UL>
        <li>
          <strong>Right to access</strong> the personal information we hold
          about you
        </li>
        <li>
          <strong>Right to correct</strong> inaccurate or incomplete
          information
        </li>
        <li>
          <strong>Right to withdraw consent</strong> to certain uses (subject
          to legal or contractual restrictions)
        </li>
        <li>
          <strong>Right to file a complaint</strong> with the Office of the
          Privacy Commissioner of Canada
        </li>
      </UL>
      <P>
        To exercise any of these rights, contact us at{" "}
        <strong>privacy@hone.care</strong>. We will respond within 30 days.
      </P>
      <P>
        If you are a client of a practitioner using Hone, please contact your
        practitioner first for access or correction requests, as they are the
        data controller of your information. We will assist your practitioner
        in fulfilling your request.
      </P>

      <H2 id="data-retention">9. Data retention</H2>
      <P>We retain personal information for as long as:</P>
      <UL>
        <li>The practitioner&rsquo;s account is active</li>
        <li>Necessary to provide the service</li>
        <li>
          Required by legal or regulatory obligations (typically up to 7 years
          for billing records)
        </li>
      </UL>
      <P>
        When a practitioner closes their account, we retain data for 30 days to
        allow account recovery, then delete it. Practitioners may request
        immediate deletion in writing.
      </P>
      <P>
        When a client is deleted by their practitioner in Hone, their record is
        soft-deleted (marked as deleted but retained for audit purposes) for 30
        days, then hard-deleted from active systems. Backups are purged within
        90 days.
      </P>

      <H2 id="security">10. Security</H2>
      <P>We protect personal information with:</P>
      <UL>
        <li>TLS encryption for data in transit</li>
        <li>Encryption at rest for sensitive credentials (passwords, API tokens)</li>
        <li>
          Row-level security to ensure practitioners only access their own
          studio&rsquo;s data
        </li>
        <li>Authentication via secure password hashing (bcrypt) and OAuth</li>
        <li>Multi-factor authentication available for all accounts</li>
        <li>Regular security reviews and updates</li>
      </UL>
      <P>
        No system is completely secure. If we become aware of a security breach
        affecting your personal information, we will notify you and applicable
        regulators as required by law.
      </P>

      <H2 id="childrens-privacy">11. Children&rsquo;s privacy</H2>
      <P>
        Hone is intended for use by adult practitioners. Practitioners may
        store information about minor clients, but only as authorized by the
        minor&rsquo;s parent or guardian as part of their professional
        services.
      </P>
      <P>
        We do not knowingly collect personal information directly from children
        under 16. If you believe we have, contact privacy@hone.care.
      </P>

      <H2 id="international-users">12. International users</H2>
      <P>
        Hone is operated from Canada with infrastructure in the United States.
        If you access Hone from outside Canada or the US, you consent to the
        transfer of your information to these jurisdictions.
      </P>
      <P>
        We do not currently target users in the European Economic Area, United
        Kingdom, or other jurisdictions with specific data residency
        requirements. If you are in one of these regions and have concerns,
        contact us before signing up.
      </P>

      <H2 id="changes-to-this-policy">13. Changes to this policy</H2>
      <P>
        We may update this policy from time to time. Material changes will be
        communicated via email to account holders at least 30 days before
        taking effect. The current version is always available at
        hone.care/privacy.
      </P>

      <H2 id="contact">14. Contact</H2>
      <P>
        <strong>Privacy questions:</strong>{" "}
        <a className="underline" href="mailto:privacy@hone.care">
          privacy@hone.care
        </a>
      </P>
      <P>
        <strong>Operator:</strong> Sam Vemuri (operating as Hone, pending
        incorporation), Ontario, Canada
      </P>
      <P>
        <strong>Filing a complaint:</strong> Office of the Privacy Commissioner
        of Canada, 30 Victoria Street, Gatineau QC K1A 1H3,{" "}
        <a
          className="underline"
          href="https://www.priv.gc.ca"
          target="_blank"
          rel="noreferrer"
        >
          https://www.priv.gc.ca
        </a>
      </P>
    </PolicyLayout>
  );
}
