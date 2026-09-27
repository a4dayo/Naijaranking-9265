import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { Shell } from "../components/shell";
import { RankRow } from "../components/rank-row";
import { ShareRow } from "../components/share";
import { OtpModal } from "../components/otp-modal";
import { NominationTray } from "../components/nominate";
import { useToast } from "../components/toast";
import { Button } from "../components/ui/button";
import { countdown, dateTime, timeAgo, votes as fmtVotes } from "../lib/format";
import {
  type RankedEntry,
  trackEvent,
  useBoard,
  useCastVote,
  useReact,
  useReportEntry,
} from "../queries/boards";

function StatusPill({ status }: { status: string }) {
  if (status === "frozen")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
        Final
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-bold tracking-wide text-accent uppercase">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      Live
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">{label}</p>
      <p className="tabular mt-0.5 truncate font-display text-[17px] font-extrabold" title={hint}>
        {value}
      </p>
    </div>
  );
}

function ReportDialog({
  entry,
  onClose,
}: {
  entry: RankedEntry | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const report = useReportEntry();
  const toast = useToast();
  if (!entry) return null;

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-foreground/45 p-4 backdrop-blur-sm">
      <button type="button" aria-label="Close" className="absolute inset-0" onClick={onClose} />
      <form
        className="nr-rise relative w-full max-w-sm space-y-3 rounded-2xl border border-border bg-card p-5"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await report.mutateAsync({ entryId: entry.id, reason: reason.trim() });
            toast("Report sent. An operator will review it.", "success");
            onClose();
          } catch (error) {
            toast((error as { message?: string }).message ?? "Could not send that report.", "error");
          }
        }}
      >
        <h2 className="font-display text-lg font-extrabold">Report “{entry.name}”</h2>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          Wrong person, impersonation, or something abusive? Tell us what is off. Every report goes
          to a human — nothing is removed automatically.
        </p>
        <textarea
          aria-label="What is wrong with this entry"
          required
          minLength={3}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          placeholder="What is wrong with this entry?"
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
        <div className="flex gap-2">
          <Button type="submit" className="flex-1" disabled={report.isPending}>
            Send report
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function BoardPage() {
  const [, params] = useRoute("/b/:slug");
  const slug = params?.slug ?? "";
  const { data, isLoading, error, dataUpdatedAt } = useBoard(slug);
  const cast = useCastVote(slug);
  const react = useReact(slug);
  const toast = useToast();

  const [otpOpen, setOtpOpen] = useState(false);
  const [otpReason, setOtpReason] = useState<string>();
  const [reporting, setReporting] = useState<RankedEntry | null>(null);
  const [pendingEntry, setPendingEntry] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seenBoard = useRef<string | null>(null);

  // Re-render once a second so the countdown and "updated" line stay honest.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (data?.board.id && seenBoard.current !== data.board.id) {
      seenBoard.current = data.board.id;
      trackEvent("board_viewed", { boardId: data.board.id });
    }
  }, [data?.board.id]);

  const board = data?.board;
  const entries = data?.entries ?? [];
  const myReactions = useMemo(() => new Set(data?.myReactions ?? []), [data?.myReactions]);
  const votable = board?.status === "live";
  const leader = entries[0];
  const topVotes = leader?.votesEffective ?? 0;
  const closing = countdown(board?.closesAt ?? null);
  void tick;

  const onVote = async (entry: RankedEntry) => {
    if (!board) return;
    setPendingEntry(entry.id);
    try {
      const result = await cast.mutateAsync({ boardId: board.id, entryId: entry.id });
      trackEvent("vote_cast", { boardId: board.id, entryId: entry.id, action: result.action });

      if (result.action === "toggled_off") {
        toast("Vote removed. Tap any name to vote again.");
      } else if (result.action === "moved") {
        toast(`Moved your vote from ${result.movedFromName ?? "your last pick"} to ${entry.name}.`, "success");
      } else if (result.action === "replayed") {
        toast("That vote was already counted.");
      } else {
        toast(
          result.verified
            ? `Counted for ${entry.name} — now #${result.newRank}.`
            : `Counted at 0.25 for ${entry.name}. Verify to make it 1.0.`,
          "success",
        );
      }

      // The prompt only ever appears after the vote is already counted.
      if (!result.verified && result.action !== "toggled_off") {
        setOtpReason(`Your vote for ${entry.name} counts 0.25 right now.`);
        setOtpOpen(true);
      }
    } catch (error) {
      toast((error as { message?: string }).message ?? "That vote did not go through.", "error");
    } finally {
      setPendingEntry(null);
    }
  };

  const onReact = async (entry: RankedEntry, emoji: string) => {
    try {
      await react.mutateAsync({ entryId: entry.id, emoji: emoji as "🔥" | "😂" | "😐" | "💯" });
    } catch (error) {
      toast((error as { message?: string }).message ?? "Vote on the board first, then react.", "error");
    }
  };

  if (isLoading) {
    return (
      <Shell>
        <div className="mx-auto max-w-6xl space-y-3 px-4 py-8">
          <div className="h-8 w-2/3 animate-pulse rounded-lg bg-muted" />
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
          <div className="space-y-2 pt-4">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="h-[74px] animate-pulse rounded-xl bg-muted/70" />
            ))}
          </div>
        </div>
      </Shell>
    );
  }

  if (error || !board) {
    return (
      <Shell>
        <div className="mx-auto max-w-lg px-4 py-20 text-center">
          <p className="rank-numeral text-5xl text-muted-foreground/40">404</p>
          <h1 className="mt-3 font-display text-2xl font-extrabold">This board is not public</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            It may be a draft, or the link may be wrong. Drafts stay invisible until an operator
            publishes them.
          </p>
          <Link href="/" className="mt-5 inline-block">
            <Button>See the live boards</Button>
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
        {/* Board header */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={board.status} />
          <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-bold tracking-wide text-secondary-foreground uppercase">
            {board.category}
          </span>
          {closing ? (
            <span className="tabular rounded-full border border-border px-2.5 py-1 text-[11px] font-bold text-muted-foreground">
              Closes in {closing}
            </span>
          ) : null}
        </div>

        <h1 className="mt-3 max-w-3xl font-display text-[27px] leading-[1.1] font-extrabold sm:text-4xl">
          {board.title}
        </h1>
        {board.description ? (
          <p className="mt-2 max-w-2xl text-[14.5px] leading-relaxed text-muted-foreground">
            {board.description}
          </p>
        ) : null}

        <div className="mt-5 grid grid-cols-2 gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-4">
          <Stat label="Total votes" value={fmtVotes(board.totalVotesEffective)} hint={`${board.totalVotesRaw} raw taps`} />
          <Stat label="Voters" value={fmtVotes(board.voterCount)} />
          <Stat label="Leader" value={leader?.name ?? "—"} hint={leader?.name} />
          <Stat
            label="Updated"
            value={timeAgo(board.lastVoteAt ?? new Date(dataUpdatedAt))}
            hint={dateTime(board.lastVoteAt)}
          />
        </div>

        {board.status === "frozen" ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-secondary/60 p-4">
            <p className="text-[13px] leading-relaxed">
              Voting is closed. This standing is final{board.frozenAt ? ` as of ${dateTime(board.frozenAt)}` : ""}.
            </p>
            <Link href={`/b/${board.slug}/results`}>
              <Button size="sm" variant="secondary" className="font-bold">
                See the final results page
              </Button>
            </Link>
          </div>
        ) : null}

        {data.sponsor ? (
          <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed border-gold/60 bg-gold/5 p-3">
            {data.sponsor.logoUrl ? (
              <img src={data.sponsor.logoUrl} alt="" className="h-7 w-auto" />
            ) : null}
            <p className="text-[12.5px] text-muted-foreground">
              <span className="font-bold tracking-wide text-gold uppercase">Sponsored</span> —
              presented by {data.sponsor.name}. Sponsorship pays for the banner, never the rank.
            </p>
          </div>
        ) : null}

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* Ranked rows */}
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="text-[11px] font-bold tracking-wider text-muted-foreground uppercase">
                {entries.length} ranked
              </h2>
              {data.me ? (
                <span className="text-[11.5px] font-medium text-muted-foreground">
                  {data.myVote
                    ? `Your vote: ${entries.find((e) => e.id === data.myVote?.entryId)?.name ?? "—"} (${data.myVote.weight})`
                    : "You have not voted here yet"}
                </span>
              ) : null}
            </div>

            {entries.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                No names on this board yet. Add the first one below.
              </p>
            ) : (
              <ul className="space-y-2">
                {entries.map((entry, index) => (
                  <RankRow
                    key={entry.id}
                    entry={entry}
                    index={index}
                    votable={Boolean(votable)}
                    isMyVote={data.myVote?.entryId === entry.id}
                    pending={pendingEntry === entry.id}
                    myReactions={myReactions}
                    onVote={(target) => void onVote(target)}
                    onReact={(target, emoji) => void onReact(target, emoji)}
                    onReport={(target) => setReporting(target)}
                    sharePercent={topVotes > 0 ? (entry.votesEffective / topVotes) * 100 : 0}
                  />
                ))}
              </ul>
            )}

            {!data.me?.verified ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4">
                <p className="max-w-sm text-[13px] leading-relaxed">
                  <span className="font-bold">Unverified votes count 0.25.</span> Verify once with
                  your email and every vote you have cast jumps to full weight.
                </p>
                <Button
                  size="sm"
                  className="font-bold"
                  onClick={() => {
                    setOtpReason(undefined);
                    setOtpOpen(true);
                  }}
                >
                  Verify me
                </Button>
              </div>
            ) : null}
          </div>

          {/* Sidebar */}
          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <section className="rounded-xl border border-border bg-card p-4">
              <h2 className="font-display text-base font-bold">Bring in the doubters</h2>
              <p className="mt-1 mb-3 text-[12.5px] text-muted-foreground">
                {leader
                  ? `${leader.name} is #1 right now. Send this to someone who will disagree.`
                  : "No votes yet — share it and start the argument."}
              </p>
              <ShareRow
                slug={board.slug}
                title={board.title}
                boardId={board.id}
                line={leader ? `${leader.name} is #1` : undefined}
              />
            </section>

            {data.movers.length > 0 ? (
              <section className="rounded-xl border border-border bg-card p-4">
                <h2 className="font-display text-base font-bold">Biggest movers · 24h</h2>
                <ul className="mt-2.5 space-y-2">
                  {data.movers.map((mover) => (
                    <li key={mover.id} className="flex items-center gap-2.5 text-[13px]">
                      <span className="rank-numeral w-6 text-right text-[15px] text-muted-foreground">
                        {mover.rank}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-semibold">{mover.name}</span>
                      <span className="tabular font-bold text-accent">+{fmtVotes(mover.gained24h)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="rounded-xl border border-border bg-card p-4">
              <h2 className="font-display text-base font-bold">Integrity</h2>
              <ul className="mt-2 space-y-1.5 text-[12.5px] text-muted-foreground">
                <li className="tabular">
                  <span className="font-bold text-foreground">{data.integrity.voidedLast24h}</span>{" "}
                  votes voided in the last 24 hours, after review.
                </li>
                <li className="tabular">
                  <span className="font-bold text-foreground">{data.integrity.openFlags}</span> flags
                  waiting on a human right now.
                </li>
                <li>
                  Suspicious voting is flagged automatically, but a vote is only ever removed by a
                  person, with a written reason.{" "}
                  <Link href="/legal/how-voting-works" className="underline">
                    How voting works
                  </Link>
                </li>
              </ul>
            </section>

            {votable ? <NominationTray boardId={board.id} /> : null}
          </aside>
        </div>
      </div>

      <OtpModal
        open={otpOpen}
        reason={otpReason}
        onClose={() => setOtpOpen(false)}
        onVerified={() => setOtpOpen(false)}
      />
      <ReportDialog entry={reporting} onClose={() => setReporting(null)} />
    </Shell>
  );
}
