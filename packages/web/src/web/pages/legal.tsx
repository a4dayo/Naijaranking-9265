import { Link, useRoute } from "wouter";
import { Shell } from "../components/shell";
import { Button } from "../components/ui/button";
import { useToast } from "../components/toast";
import { useEraseMe, useMe, useSignOut } from "../queries/identity";

const UPDATED = "23 September 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="font-display text-lg font-extrabold">{title}</h2>
      <div className="mt-2 space-y-2.5 text-[14px] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

function Tabs({ active }: { active: string }) {
  const tabs = [
    ["privacy", "Privacy"],
    ["terms", "Terms"],
    ["how-voting-works", "How voting works"],
  ] as const;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tabs.map(([slug, label]) => (
        <Link
          key={slug}
          href={`/legal/${slug}`}
          className={[
            "flex h-8 items-center rounded-full border px-3 text-[12.5px] font-bold transition-colors",
            active === slug
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-muted-foreground hover:text-foreground",
          ].join(" ")}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}

/** NDPA 2023 self-service: sign out of this device, or erase the identity entirely. */
function DataControls() {
  const { data } = useMe();
  const erase = useEraseMe();
  const signOut = useSignOut();
  const toast = useToast();

  return (
    <div className="mt-4 rounded-xl border border-border bg-card p-4">
      <h3 className="font-display text-[15px] font-bold">Your data on this device</h3>
      {data?.voter ? (
        <p className="mt-1 text-[13px] text-muted-foreground">
          You are {data.voter.verified ? "verified" : "unverified"} here
          {data.voter.email ? ` as ${data.voter.email}` : ""}, vote weight {data.voter.weight}.
        </p>
      ) : (
        <p className="mt-1 text-[13px] text-muted-foreground">
          No voter record on this device yet — nothing to export or erase.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!data?.voter || signOut.isPending}
          onClick={async () => {
            await signOut.mutateAsync();
            toast("Signed out on this device.");
          }}
        >
          Sign out
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!data?.voter || erase.isPending}
          onClick={async () => {
            if (!window.confirm("Erase your email, phone and device trail? Votes already counted stay counted, but will no longer be linked to you.")) return;
            try {
              await erase.mutateAsync();
              toast("Your personal data has been erased.", "success");
            } catch (error) {
              toast((error as { message?: string }).message ?? "Could not erase right now.", "error");
            }
          }}
        >
          Erase my data
        </Button>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
        Erasure removes your email, phone, IP and device fingerprint. Votes you cast stay counted
        but detached from you — retroactively changing a published result would be its own
        integrity problem. You can also write to privacy@naijarank.ng.
      </p>
    </div>
  );
}

export default function LegalPage() {
  const [, params] = useRoute("/legal/:page");
  const page = params?.page ?? "privacy";

  return (
    <Shell>
      <article className="mx-auto max-w-2xl px-4 py-8">
        <Tabs active={page} />

        {page === "terms" ? (
          <>
            <h1 className="mt-5 font-display text-3xl font-extrabold">Terms of use</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">Last updated {UPDATED}</p>

            <Section title="What NaijaRank is">
              <p>
                NaijaRank publishes crowdsourced rankings. Every position on every board is the sum
                of votes cast by the public — it is not our opinion, an endorsement, or a statement
                of fact about anyone listed.
              </p>
            </Section>
            <Section title="Voting rules">
              <p>
                One vote per person per board. Voting again on the same board moves your vote; it
                never adds a second one. Verified votes carry weight 1.0, unverified 0.25.
              </p>
              <p>
                Automating votes, buying votes, or using multiple identities to vote is a breach of
                these terms. We flag such activity automatically and an operator may void the
                affected votes, with the reason recorded in our audit log.
              </p>
            </Section>
            <Section title="Entries and people">
              <p>
                Boards cover music, film, entertainment figures, places and culture. We do not run
                boards that rank private individuals as criminals, or that rank political
                officeholders, without explicit internal approval — and never as an accusation.
              </p>
              <p>
                If you are the subject of an entry you can claim it, ask for a correction, or report
                it from the board page. Reports reach a person, not a filter.
              </p>
            </Section>
            <Section title="Sponsorship">
              <p>
                Sponsored placements are labelled and outlined. Sponsorship buys visibility on a
                board and never affects a rank or a vote count.
              </p>
            </Section>
            <Section title="Liability">
              <p>
                Boards are provided as-is, for entertainment and public interest. We do not
                guarantee that a board is complete, or that a count is free of attempted
                manipulation — only that we detect it, act on it by hand, and say so publicly.
              </p>
            </Section>
            <Section title="Contact">
              <p>hello@naijarank.ng · Lagos, Nigeria</p>
            </Section>
          </>
        ) : page === "how-voting-works" ? (
          <>
            <h1 className="mt-5 font-display text-3xl font-extrabold">How voting works</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              The full methodology, in plain language.
            </p>

            <Section title="Your first vote counts immediately">
              <p>
                Tap Vote and it lands — no account, no login wall. An unverified vote carries weight
                0.25. We then ask you once to verify with your email; verifying upgrades every vote
                you have already cast, on every board, to full weight 1.0.
              </p>
            </Section>
            <Section title="One vote per person per board">
              <p>
                The database itself enforces one vote per voter per board, so a double vote is
                impossible rather than merely discouraged. Voting for another entry on the same
                board moves your vote atomically; tapping your own pick again removes it.
              </p>
            </Section>
            <Section title="The count you see is the server's count">
              <p>
                Vote totals and ranks are computed and stored server-side inside a single
                transaction, then reconciled on a 30-second job. Your screen shows an instant
                optimistic number, but the server's figure always replaces it.
              </p>
            </Section>
            <Section title="Fraud is flagged by machine, removed by a person">
              <p>
                A scanner watches for velocity spikes, one device spraying votes, datacentre and VPN
                traffic, and coordinated bursts. It raises flags — it never deletes a vote.
              </p>
              <p>
                An operator reviews each flag and, if they void votes, must write a reason. Every
                void is recorded in an append-only audit log, and each board shows how many votes
                were voided in the last 24 hours.
              </p>
            </Section>
            <Section title="Rank movement">
              <p>
                We snapshot every board's standing regularly. The arrow next to an entry is its
                change in position over the last 24 hours; "biggest movers" is vote weight gained in
                the same window.
              </p>
            </Section>
            <Section title="When a board freezes">
              <p>
                An operator can close voting. The standing at that moment becomes the board's
                permanent results page, and no vote can change it afterwards.
              </p>
            </Section>
          </>
        ) : (
          <>
            <h1 className="mt-5 font-display text-3xl font-extrabold">Privacy notice</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              Last updated {UPDATED} · Nigeria Data Protection Act 2023
            </p>

            <Section title="Who we are">
              <p>
                NaijaRank is the data controller for the personal data described here. Reach us at
                privacy@naijarank.ng.
              </p>
            </Section>
            <Section title="What we collect, and why">
              <p>
                <strong className="text-foreground">Email address</strong> — only if you verify.
                Used solely to keep one vote per person and to weight your vote at 1.0. Never shown
                publicly, never sold, never used for marketing.
              </p>
              <p>
                <strong className="text-foreground">IP address and network (ASN)</strong> — recorded
                with each vote to detect coordinated fraud.
              </p>
              <p>
                <strong className="text-foreground">Device fingerprint</strong> — a one-way hash of
                your browser's user-agent and language, used for rate limiting and fraud detection.
              </p>
              <p>
                <strong className="text-foreground">Session token</strong> — an HMAC-signed token in
                a cookie (180 days) so returning to vote takes one tap.
              </p>
            </Section>
            <Section title="Lawful basis (NDPA 2023, s.25)">
              <p>
                <strong className="text-foreground">Consent</strong> for your email address, given
                when you request a verification code. <strong className="text-foreground">
                Legitimate interest
                </strong>{" "}
                for IP, ASN and device data — running a vote-based ranking is impossible without
                fraud controls, and we hold this data for the minimum period useful for that.
              </p>
            </Section>
            <Section title="How long we keep it">
              <p>
                Raw IP addresses and ASN data are purged after 90 days by an automated job — the IP
                is replaced with a salted one-way hash, so historical fraud analysis survives but
                you are no longer identifiable from it. Votes themselves are kept indefinitely as
                part of the public record.
              </p>
            </Section>
            <Section title="Your rights">
              <p>
                You can access, correct, or erase your personal data, withdraw consent, or object to
                processing. Use the controls below, or write to privacy@naijarank.ng — we respond
                within 30 days. You may also complain to the Nigeria Data Protection Commission.
              </p>
            </Section>

            <DataControls />

            <Section title="Sharing">
              <p>
                We do not sell personal data. Email delivery of verification codes is handled by a
                transactional email provider acting as our processor. Board vote counts and rankings
                are public; the people behind them are not.
              </p>
            </Section>
            <Section title="Children">
              <p>
                NaijaRank is not directed at children under 13. If you believe a child has verified
                an account, write to us and we will erase it.
              </p>
            </Section>
          </>
        )}
      </article>
    </Shell>
  );
}
