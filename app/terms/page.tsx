import type { Metadata } from "next";
import {
  H2,
  H3,
  P,
  UL,
  PolicyLayout,
} from "@/app/_components/PolicyLayout";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms governing your use of Hone, the practice memory system for permanent hair removal. Includes data processing agreement, acceptable use, and limitation of liability.",
};

export default function TermsOfServicePage() {
  return (
    <PolicyLayout
      title="Hone Terms of Service"
      effectiveDate="May 22, 2026"
      lastUpdated="May 22, 2026"
    >
      <H2 id="acceptance">1. Acceptance of these terms</H2>
      <P>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of Hone, a
        software service for electrolysis and skincare practitioners.
      </P>
      <P>
        By creating an account, accessing, or using Hone, you agree to be
        bound by these Terms. If you do not agree, do not use Hone.
      </P>
      <P>
        Hone is operated by <strong>Sam Vemuri</strong> (an individual
        operating as Hone, pending incorporation), located in Ontario, Canada.
        References in these Terms to &ldquo;we,&rdquo; &ldquo;us,&rdquo; and
        &ldquo;our&rdquo; refer to this operator.
      </P>

      <H2 id="the-service">2. The Service</H2>
      <P>Hone provides software tools for practitioners to:</P>
      <UL>
        <li>Manage client records and contact information</li>
        <li>Schedule appointments and accept online bookings</li>
        <li>Record electrolysis and skincare treatment sessions</li>
        <li>Send appointment confirmations and reminders</li>
        <li>Track treatment plans and progress</li>
        <li>Process payments (when integrated with a payment processor)</li>
        <li>Other related practice management functions</li>
      </UL>
      <P>
        Hone is provided as a software-as-a-service. Features may be added,
        modified, or removed over time.
      </P>

      <H2 id="eligibility">3. Eligibility</H2>
      <P>You must:</P>
      <UL>
        <li>Be at least 18 years old</li>
        <li>
          Be a licensed or qualified practitioner of electrolysis, skincare,
          or related services, OR an employee of such a practitioner
        </li>
        <li>
          Use Hone only for lawful purposes in jurisdictions where you are
          authorized to provide your services
        </li>
        <li>Provide accurate registration information and keep it current</li>
      </UL>
      <P>
        You are responsible for ensuring you have the right to collect, store,
        and process any personal information you enter into Hone about your
        clients.
      </P>

      <H2 id="your-account">4. Your account</H2>
      <P>You are responsible for:</P>
      <UL>
        <li>Maintaining the confidentiality of your login credentials</li>
        <li>All activity that occurs under your account</li>
        <li>
          Notifying us immediately of any unauthorized access
          (privacy@hone.care)
        </li>
      </UL>
      <H2 id="acceptable-use">5. Acceptable use</H2>
      <P>You may not:</P>
      <UL>
        <li>Use Hone for any illegal purpose</li>
        <li>
          Violate any applicable laws or regulations, including health
          information privacy laws
        </li>
        <li>Use Hone to harass, threaten, or harm any person</li>
        <li>
          Attempt to gain unauthorized access to Hone systems or other
          users&rsquo; accounts
        </li>
        <li>
          Reverse engineer, decompile, or attempt to extract Hone&rsquo;s
          source code
        </li>
        <li>
          Use Hone to send spam, unsolicited marketing, or any communication
          that violates anti-spam laws
        </li>
        <li>
          Scrape, crawl, or harvest data from Hone except as permitted by your
          subscription
        </li>
        <li>
          Resell, sublicense, or redistribute Hone access without our written
          permission
        </li>
        <li>Upload viruses, malware, or other harmful code</li>
      </UL>
      <P>We may suspend or terminate accounts that violate these rules.</P>

      <H2 id="your-data-and-content">6. Your data and content</H2>
      <P>
        You retain ownership of all content and data you enter into Hone,
        including client records, treatment notes, and photos (&ldquo;Your
        Data&rdquo;).
      </P>
      <P>
        You grant us a limited license to process Your Data solely to:
      </P>
      <UL>
        <li>Provide and improve the Hone service to you</li>
        <li>
          Send notifications you have configured (e.g., appointment reminders
          to your clients)
        </li>
        <li>Comply with legal obligations</li>
      </UL>
      <P>
        We do not use Your Data to train machine learning models or for any
        purpose unrelated to operating Hone.
      </P>
      <P>You are responsible for:</P>
      <UL>
        <li>The legality of collecting and storing Your Data</li>
        <li>Obtaining required consents from your clients</li>
        <li>Providing your clients with appropriate privacy notices</li>
        <li>Responding to your clients&rsquo; requests regarding their information</li>
      </UL>

      <H2 id="dpa">7. Data Processing Agreement</H2>
      <P>
        This Section 7 forms a Data Processing Agreement (&ldquo;DPA&rdquo;)
        that applies when you (the &ldquo;Controller&rdquo;) use Hone (the
        &ldquo;Processor&rdquo;) to process personal information about your
        clients (&ldquo;Client Data&rdquo;).
      </P>

      <H3 id="dpa-scope">7.1 Scope</H3>
      <P>
        We process Client Data only on your documented instructions, which
        include these Terms, your account configuration, and any specific
        written instructions you provide.
      </P>

      <H3 id="dpa-confidentiality">7.2 Confidentiality</H3>
      <P>
        Our personnel who access Client Data are bound by confidentiality
        obligations.
      </P>

      <H3 id="dpa-security">7.3 Security</H3>
      <P>
        We implement appropriate technical and organizational measures to
        protect Client Data, including:
      </P>
      <UL>
        <li>TLS encryption in transit</li>
        <li>Row-level security to isolate each studio&rsquo;s data</li>
        <li>Access controls and audit logging</li>
        <li>We review security-sensitive changes before deployment</li>
      </UL>

      <H3 id="dpa-subprocessors">7.4 Sub-processors</H3>
      <P>We use the following sub-processors to provide Hone:</P>
      <UL>
        <li>Supabase (database and authentication, AWS US-East-1)</li>
        <li>Vercel (web hosting)</li>
        <li>Resend (transactional email)</li>
        <li>Twilio (SMS, when enabled)</li>
        <li>Stripe (payment processing, when enabled)</li>
        <li>Anthropic (AI features, when enabled)</li>
      </UL>
      <P>
        We will notify account holders by email at least 30 days before adding
        or replacing a sub-processor that processes Client Data.
      </P>

      <H3 id="dpa-data-subject-requests">7.5 Data subject requests</H3>
      <P>
        If a client of yours contacts us directly with a request to access,
        correct, or delete their information, we will direct them to you (as
        the data controller) and assist you in responding.
      </P>

      <H3 id="dpa-breach-notification">7.6 Breach notification</H3>
      <P>
        We will notify you without undue delay, and in any event within 72
        hours, of any confirmed security incident affecting Client Data.
      </P>

      <H3 id="dpa-return-or-deletion">7.7 Return or deletion</H3>
      <P>
        On termination of your account, you may export Your Data. Client Data
        is then archived and removed from everyday use. We do not currently
        operate an automatic timed purge. We review permanent-deletion requests
        sent to <strong>privacy@hone.care</strong> and respond based on what can
        be deleted, subject to applicable legal and professional
        record-retention requirements.
      </P>

      <H3 id="dpa-audit">7.8 Audit</H3>
      <P>
        You may request a summary of our security practices and sub-processors
        at any time by emailing privacy@hone.care.
      </P>

      <H3 id="dpa-studio-marketing">
        7.9 Studio-controlled marketing and analytics providers
      </H3>
      <P>
        Hone may provide integration tools that let a studio enable optional
        marketing or analytics providers (for example Meta, Google, TikTok,
        Pinterest, LinkedIn, or Microsoft Ads). Enabling a provider is
        studio-controlled. Where a studio enables one, and subject to applicable
        consent and configuration:
      </P>
      <UL>
        <li>
          You are responsible for choosing and configuring your providers, and
          for your own ad accounts, pixels, datasets, provider settings, consent
          banners, and privacy disclosures on your own website.
        </li>
        <li>
          The provider account, dataset, pixel, and tokens belong to you, not to
          Hone, unless we state otherwise.
        </li>
        <li>
          Hone does not mix conversion data across studios, and does not use one
          studio&rsquo;s tracking data for another studio&rsquo;s advertising.
        </li>
        <li>
          Any marketing tracking Hone may conduct for its own website is
          separate from studio-owned tracking.
        </li>
        <li>
          Hone sends only minimal, non-clinical conversion data to these
          providers, and does not send clinical, intake, treatment, photo,
          body-area, or appointment-note information.
        </li>
      </UL>

      <H2 id="payment-and-billing">8. Payment and billing</H2>
      <P>
        Hone is currently operated as a supervised pilot.{" "}
        <strong>
          There is no automated Hone subscription billing system at this time.
        </strong>{" "}
        Any fees for your use of Hone are agreed directly with you as a
        participating studio, and invoiced or collected by arrangement. We do
        not currently charge studios on a recurring subscription, and no
        Hone-to-studio subscription, plan, or entitlement is created,
        enforced, or cancelled automatically by the product.
      </P>
      <P>
        Automated subscription billing may be introduced later. If it is, we
        will publish the applicable pricing and give existing studios at least
        30 days&rsquo; notice before it begins to apply to them, and these
        Terms will be updated at the same time.
      </P>
      <P>
        <strong>This section is about what your studio pays Hone.</strong> It
        is separate from the payments your studio takes from its own clients
        through Stripe, which are governed by your own Stripe agreement and by
        the policies you set for your clients. Nothing in this section changes
        how client payments, refunds, or fees work.
      </P>

      <H2 id="termination">9. Termination</H2>
      <P>
        You may terminate your account at any time by contacting
        privacy@hone.care.
      </P>
      <P>We may suspend or terminate your account if:</P>
      <UL>
        <li>You violate these Terms</li>
        <li>
          You fail to pay any fees separately agreed with us (see section{" "}
          <a href="#payment-and-billing" className="underline">
            8
          </a>
          )
        </li>
        <li>Required by law</li>
        <li>We discontinue the service (with at least 90 days notice)</li>
      </UL>
      <P>
        On termination, you may export Your Data. After that, Your Data may be
        archived and removed from everyday use, subject to section{" "}
        <a href="#data-export" className="underline">
          16
        </a>
        .
      </P>

      <H2 id="disclaimers">10. Disclaimers</H2>
      <P>
        Hone is provided <strong>&ldquo;AS IS&rdquo; and &ldquo;AS AVAILABLE&rdquo;</strong> without
        warranties of any kind, whether express or implied.
      </P>
      <P>We do not warrant that:</P>
      <UL>
        <li>The service will be uninterrupted, error-free, or secure</li>
        <li>Any data will be free from loss or corruption</li>
        <li>The service will meet your specific requirements</li>
      </UL>
      <P>
        <strong>No service level agreement.</strong> We do not commit to any
        specific uptime, response time, or availability percentage. We aim to
        provide reliable service but make no binding commitments. Planned
        maintenance windows, third-party service disruptions (Supabase,
        Vercel, Resend, Twilio, Stripe, AWS), and unforeseen outages may
        interrupt service without notice. Such interruptions do not constitute
        a breach of these Terms.
      </P>
      <P>
        <strong>Clinical and professional disclaimer.</strong> Hone is a
        record-keeping and practice management tool.{" "}
        <strong>
          Hone does not provide medical advice, clinical guidance, or
          professional recommendations.
        </strong>{" "}
        Practitioners are solely responsible for:
      </P>
      <UL>
        <li>
          All clinical decisions, including treatment plans, settings, and
          contraindication assessments
        </li>
        <li>
          Compliance with their professional licensing body&rsquo;s rules and
          regulations
        </li>
        <li>
          Verification of client allergies, medications, and health conditions
          before treatment
        </li>
        <li>
          The appropriateness, safety, and outcomes of any service they
          provide
        </li>
        <li>
          Maintaining their own clinical judgment independently of any
          information displayed in Hone
        </li>
      </UL>
      <P>
        Information displayed in Hone, including treatment time totals,
        treatment plan progress, automated reminders, and historical session
        data, is provided for record-keeping purposes only and is{" "}
        <strong>not a recommendation, diagnosis, or clinical guidance</strong>.
        Practitioners must independently verify all information and exercise
        their own professional judgment.
      </P>
      <P>
        <strong>Photography and image consent.</strong> Where practitioners
        upload photographs of clients (skin, treatment areas, before/after
        images), the practitioner is solely responsible for obtaining
        explicit, informed, written consent from the client for the capture,
        storage, and any future use of those images. Hone does not verify such
        consent and assumes none has been obtained for any purpose beyond
        internal record-keeping.
      </P>
      <P>We do not provide medical, legal, or professional advice.</P>

      <H2 id="limitation-of-liability">11. Limitation of liability</H2>
      <P>To the maximum extent permitted by law:</P>
      <P>
        <strong>Our total cumulative liability</strong> for any claim arising
        from or related to these Terms or the Hone service is limited to the
        greater of:
      </P>
      <UL>
        <li>
          <strong>$100 CAD</strong>, or
        </li>
        <li>
          The total amount you paid us for Hone in the 12 months preceding the
          claim.
        </li>
      </UL>
      <P>
        We are <strong>not liable</strong> for indirect, incidental, special,
        consequential, or punitive damages, including loss of profits,
        revenue, data, or business opportunities.
      </P>
      <P>
        <strong>
          We are not liable for any harm caused by a practitioner&rsquo;s use
          or misuse of client data
        </strong>
        , including but not limited to: unauthorized disclosure of client
        information by a practitioner, a practitioner&rsquo;s failure to
        obtain required client consents, a practitioner&rsquo;s negligent or
        wrongful entry of client data, or a practitioner&rsquo;s use of Hone
        in violation of applicable health information, privacy, or
        professional regulations. Practitioners are solely responsible for
        their handling of client data and their compliance with laws governing
        their professional practice.
      </P>
      <P>
        This limitation applies even if we have been advised of the
        possibility of such damages and even if a remedy fails its essential
        purpose.
      </P>
      <P>
        Some jurisdictions do not allow these limitations. In those
        jurisdictions, our liability is limited to the maximum extent
        permitted by law.
      </P>

      <H2 id="indemnification">12. Indemnification</H2>
      <P>
        You agree to indemnify and hold us harmless from any claims, damages,
        losses, or expenses (including legal fees) arising from:
      </P>
      <UL>
        <li>Your use of Hone in violation of these Terms or applicable law</li>
        <li>Your Data or content you upload</li>
        <li>Your interactions with your clients</li>
        <li>Your violation of any third party&rsquo;s rights</li>
      </UL>

      <H2 id="governing-law">13. Governing law and disputes</H2>
      <P>
        These Terms are governed by the laws of the Province of Ontario and
        the federal laws of Canada applicable therein, without regard to
        conflict of laws principles.
      </P>
      <P>
        Any dispute arising from these Terms or use of Hone will be resolved
        in the courts of Ontario, Canada, and you consent to the exclusive
        jurisdiction of these courts.
      </P>
      <P>
        You waive any right to participate in a class action or class
        arbitration against us.
      </P>

      <H2 id="force-majeure">14. Force majeure</H2>
      <P>
        We are not liable for any failure to perform our obligations under
        these Terms when such failure results from causes beyond our
        reasonable control, including but not limited to:
      </P>
      <UL>
        <li>Acts of God, natural disasters, fire, flood, earthquake</li>
        <li>War, terrorism, civil unrest, government action, sanctions</li>
        <li>Pandemic, epidemic, or public health emergency</li>
        <li>
          Internet outages, denial of service attacks, security incidents
          originating from third parties
        </li>
        <li>
          Failure or unavailability of third-party services (including but
          not limited to Supabase, Vercel, AWS, Resend, Twilio, Stripe,
          Anthropic)
        </li>
        <li>
          Power outages, telecommunications failures, infrastructure failures
        </li>
        <li>Labour disputes, strikes</li>
        <li>Changes in law or regulation that materially affect the service</li>
      </UL>
      <P>
        If a force majeure event prevents us from providing the service for
        more than 30 consecutive days, either party may terminate these Terms
        by written notice, with no further liability.
      </P>

      <H2 id="audit-rights">15. Audit rights</H2>
      <P>
        If you require information about our security practices,
        sub-processors, or data handling to satisfy your own compliance
        obligations, we will provide a summary report on written request to
        privacy@hone.care. Requests are limited to once per calendar year per
        practitioner. We are not required to permit on-site inspections,
        access to our systems beyond the summary report, or audits conducted
        by third parties without our prior written consent.
      </P>

      <H2 id="data-export">16. Data export and return on termination</H2>
      <P>
        On termination of your account, you may request a copy of Your Data
        within 30 days of termination by emailing privacy@hone.care.
      </P>
      <P>
        We will provide Your Data in a machine-readable format that we select
        (typically CSV or JSON). We are not obligated to provide data in any
        specific proprietary format, in a format compatible with any specific
        third-party software, or with any specific data transformation or
        restructuring.
      </P>
      <P>
        After termination we may archive Your Data and remove it from everyday
        use. We do not currently guarantee a fixed timetable for permanent
        erasure or for the expiry of backup copies; we review permanent-deletion
        requests and respond based on what can be deleted, subject to applicable
        legal and professional record-retention requirements. Export Your Data
        before you terminate if you need your own copy.
      </P>

      <H2 id="changes-to-these-terms">17. Changes to these Terms</H2>
      <P>
        We may update these Terms from time to time. Material changes will be
        communicated by email at least 30 days before taking effect.
        Continued use of Hone after changes take effect constitutes acceptance.
      </P>
      <P>The current version is always at hone.care/terms.</P>

      <H2 id="miscellaneous">18. Miscellaneous</H2>
      <P>
        <strong>Entire agreement.</strong> These Terms, together with the
        Privacy Policy, constitute the entire agreement between you and us
        regarding Hone.
      </P>
      <P>
        <strong>Severability.</strong> If any provision is found
        unenforceable, the remaining provisions remain in effect.
      </P>
      <P>
        <strong>No waiver.</strong> Our failure to enforce a provision is not
        a waiver of our right to enforce it later.
      </P>
      <P>
        <strong>Assignment.</strong> You may not assign these Terms without
        our consent. We may assign these Terms in connection with a merger,
        acquisition, or sale of assets.
      </P>
      <P>
        <strong>Independent contractors.</strong> Nothing in these Terms
        creates a partnership, joint venture, or employment relationship.
      </P>
      <P>
        <strong>Anti-reverse engineering.</strong> You will not, and will not
        permit any third party to: (a) reverse engineer, decompile,
        disassemble, or attempt to derive the source code or underlying
        algorithms of Hone; (b) copy or modify Hone&rsquo;s interface,
        features, or functionality for the purpose of creating a competing
        product; (c) use Hone to benchmark or develop a competing service.
        This applies regardless of any local law that would otherwise permit
        such activities, to the maximum extent permitted by law.
      </P>
      <P>
        <strong>Survival.</strong> Sections that by their nature should
        survive termination (including limitation of liability,
        indemnification, governing law, and any payment obligations) will
        survive termination of these Terms.
      </P>

      <H2 id="contact">19. Contact</H2>
      <P>
        <strong>General questions:</strong>{" "}
        <a className="underline" href="mailto:privacy@hone.care">
          privacy@hone.care
        </a>
      </P>
      <P>
        <strong>Legal notices:</strong> privacy@hone.care (mailing address
        forthcoming, will be provided upon request)
      </P>
      <P>
        <strong>Operator:</strong> Sam Vemuri (operating as Hone, pending
        incorporation), Ontario, Canada
      </P>
    </PolicyLayout>
  );
}
