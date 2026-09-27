import { useEffect } from "react";
import { Link, useRoute } from "wouter";
import { Shell } from "../components/shell";
import { ShareRow } from "../components/share";
import { Button } from "../components/ui/button";
import { dateTime, shortDate, votes as fmtVotes } from "../lib/format";
import { useResults } from "../queries/boards";

/**
 * The permanent artifact. Once a board is frozen this page is the citable
 * standing — read-only, no vote buttons, no polling.
 */
export default function ResultsPage() {
  const [, params] = useRoute("/b/:slug/results");
  const slug = params?.slug ?? "";
  const { data, isLoading, error } = useResults(slug);

  useEffect(() => {
    if (data?.board.title) document.title = `${data.board.title} — final results · NaijaRank`;
    return () => {
      document.title = "NaijaRank — Nigeria's rankings, voted live";
    };
  }, [data?.board.title]);

  if (isLoading) {
    return (
      <Shell>
        <div className="mx-auto max-w-3xl space-y-3 px-4 py-10">
          <div className="h-9 w-2/3 animate-pulse rounded-lg bg-muted" />
          {Array.from({ length: 10 }, (_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-lg bg-muted/70" />
          ))}
        </div>
      </Shell>
    );
  }

  if (error || !data) {
    return (
      <Shell>
        <div className="mx-auto max-w-lg px-4 py-20 text-center">
          <h1 className="font-display text-2xl font-extrabold">No results to show yet</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The link may be off, or this board is still a draft.
          </p>
          <Link href="/" className="mt-5 inline-block">
            <Button>See what is live →</Button>
          </Link>
        </div>
      </Shell>
    );
  }

  const { board, entries, stats, integrity } = data;
  const live = board.status === "live";

  return (
    <Shell>
      <article className="mx-auto max-w-3xl px-4 py-8">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={[
              "rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase",
              live
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-border bg-secondary text-muted-foreground",
            ].join(" ")}
          >
            {live ? "Still live" : "Final result"}
          </span>
          <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase">
            {board.category}
          </span>
        </div>

        <h1 className="mt-3 font-display text-[28px] leading-[1.1] font-extrabold sm:text-4xl">
          {board.title}
        </h1>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          {live
            ? "Voting is still open — this table is a snapshot, not the final word."
            : `Voting closed ${board.frozenAt ? dateTime(board.frozenAt) : ""}. This standing is final.`}
        </p>

        {live ? (
          <Link href={`/b/${board.slug}`} className="mt-4 inline-block">
            <Button className="font-bold">Vote on the live board →</Button>
          </Link>
        ) : null}

        <table className="mt-6 w-full border-collapse text-left">
          <caption className="sr-only">Final standing for {board.title}</caption>
          <thead>
            <tr className="border-b border-border text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">
              <th scope="col" className="py-2 pr-2">
                #
              </th>
              <th scope="col" className="py-2">
                Entry
              </th>
              <th scope="col" className="py-2 text-right">
                Votes
              </th>
              <th scope="col" className="hidden py-2 text-right sm:table-cell">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const share =
                board.totalVotesEffective > 0
                  ? (entry.votesEffective / board.totalVotesEffective) * 100
                  : 0;
              return (
                <tr key={entry.id} className="border-b border-border/60">
                  <td
                    className={`rank-numeral py-2.5 pr-2 align-middle text-[19px] ${
                      entry.rank === 1
                        ? "text-gold"
                        : entry.rank === 2
                          ? "text-silver"
                          : entry.rank === 3
                            ? "text-bronze"
                            : "text-muted-foreground/70"
                    }`}
                  >
                    {entry.rank}
                  </td>
                  <td className="py-2.5 align-middle">
                    <span className="font-display text-[14.5px] font-bold">{entry.name}</span>
                    {entry.claimed ? (
                      <span className="ml-1.5 text-[10px] font-bold text-primary">✓</span>
                    ) : null}
                    {entry.subtitle ? (
                      <span className="block text-[12px] text-muted-foreground">{entry.subtitle}</span>
                    ) : null}
                  </td>
                  <td className="tabular py-2.5 text-right align-middle text-[13.5px] font-bold">
                    {fmtVotes(entry.votesEffective)}
                  </td>
                  <td className="tabular hidden py-2.5 text-right align-middle text-[13px] text-muted-foreground sm:table-cell">
                    {share.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <section className="mt-6 rounded-xl border border-border bg-card p-4">
          <h2 className="font-display text-base font-bold">How this was counted</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
            {[
              ["Voters", fmtVotes(stats.voters)],
              ["Verified voters", fmtVotes(stats.verifiedVoters)],
              ["Total weight", fmtVotes(board.totalVotesEffective)],
              ["Votes voided", fmtVotes(stats.votesVoided)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">
                  {label}
                </dt>
                <dd className="tabular mt-0.5 font-display text-[17px] font-extrabold">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
            Voting ran {shortDate(stats.votedFrom)} – {shortDate(stats.votedTo)}. A verified vote
            carries weight 1.0, an unverified one 0.25. {stats.votesVoided} vote
            {stats.votesVoided === 1 ? "" : "s"} were voided after human review of automated fraud
            flags; {integrity.openFlags} flag{integrity.openFlags === 1 ? "" : "s"} remain open.{" "}
            <Link href="/legal/how-voting-works" className="underline">
              Full methodology
            </Link>
            .
          </p>
        </section>

        <div className="mt-5">
          <ShareRow
            slug={board.slug}
            title={board.title}
            boardId={board.id}
            line={entries[0] ? `${entries[0].name} won` : undefined}
          />
        </div>
      </article>
    </Shell>
  );
}
