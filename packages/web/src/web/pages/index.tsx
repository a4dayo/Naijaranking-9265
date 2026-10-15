import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Shell } from "../components/shell";
import { OtpModal } from "../components/otp-modal";
import { useToast } from "../components/toast";
import { Button } from "../components/ui/button";
import { countdown, initials, votes as fmtVotes } from "../lib/format";
import {
  type RankedEntry,
  trackEvent,
  useBoard,
  useBoards,
  useCastVote,
} from "../queries/boards";

type Board = NonNullable<ReturnType<typeof useBoards>["data"]>[number];

/**
 * Below these numbers a count reads as "nobody is here", so the page talks
 * about deadlines and contenders instead. Above them, the counts are the proof.
 */
const SITE_PROOF_MIN = 500; // verified votes across all boards
const BOARD_PROOF_MIN = 25; // verified votes on one board

/** Optional override for launch: pin a board to the hero by slug. */
const PINNED_HERO = import.meta.env.VITE_HERO_BOARD_SLUG as string | undefined;

const HERO_ROWS = 6;

function time(value: string | Date | null | undefined) {
  return value ? new Date(value).getTime() : 0;
}

/** "Sun 1 Nov, 9pm" — the closing line people repeat to each other. */
function closingLabel(value: string | Date | null | undefined) {
  if (!value) return null;
  // Always Lagos time: the deadline is the same for everyone sharing the link.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const minute = get("minute");
  const clock = `${get("hour")}${minute && minute !== "00" ? `:${minute}` : ""}${get("dayPeriod").toLowerCase()}`;
  return `${get("weekday")} ${get("day")} ${get("month")}, ${clock}`;
}

/** Two letters for the placeholder badge, letters only ("Body (danz)" → "BD"). */
function monogram(name: string) {
  return initials(name.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim());
}

function isOpen(board: Board, now: number) {
  return (
    board.status === "live" &&
    (!board.opensAt || time(board.opensAt) <= now) &&
    (!board.closesAt || time(board.closesAt) > now)
  );
}

function isUpcoming(board: Board, now: number) {
  return board.status === "live" && Boolean(board.opensAt) && time(board.opensAt) > now;
}

/** Medal colour only once there are real votes — a gold "1" on zero votes is a lie. */
function rankClass(rank: number) {
  if (rank === 1) return "text-gold";
  if (rank === 2) return "text-silver";
  if (rank === 3) return "text-bronze";
  return "text-muted-foreground/70";
}

/* ------------------------------------------------------------------ hero */

function HeroBoard({ slug }: { slug: string }) {
  const { data, isLoading } = useBoard(slug);
  const cast = useCastVote(slug);
  const toast = useToast();
  const [pendingEntry, setPendingEntry] = useState<string | null>(null);
  const [otpOpen, setOtpOpen] = useState(false);
  const [otpReason, setOtpReason] = useState<string>();
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (isLoading || !data) {
    return <div className="mt-8 h-[420px] animate-pulse rounded-2xl bg-muted/70" />;
  }

  const { board, entries } = data;
  const hasVotes = board.totalVotesEffective > 0;
  const showCounts = board.totalVotesEffective >= BOARD_PROOF_MIN;
  const left = countdown(board.closesAt);
  const closes = closingLabel(board.closesAt);
  const shown = entries.slice(0, HERO_ROWS);
  const myPick = data.myVote ? entries.find((e) => e.id === data.myVote?.entryId) : undefined;

  const onVote = async (entry: RankedEntry) => {
    setPendingEntry(entry.id);
    try {
      const result = await cast.mutateAsync({ boardId: board.id, entryId: entry.id });
      trackEvent("vote_cast", { boardId: board.id, entryId: entry.id, action: result.action, from: "home" });
      if (result.action === "toggled_off") {
        toast("Vote removed. Tap any name to vote again.");
      } else if (result.action === "moved") {
        toast(`Moved your vote from ${result.movedFromName ?? "your last pick"} to ${entry.name}.`, "success");
      } else if (result.verified) {
        toast(`Counted for ${entry.name}.`, "success");
      }
      if (!result.verified && result.action !== "toggled_off") {
        setOtpReason(`Your vote for ${entry.name} is saved. Confirm it so it counts.`);
        setOtpOpen(true);
      }
    } catch (error) {
      toast((error as { message?: string }).message ?? "That vote did not go through.", "error");
    } finally {
      setPendingEntry(null);
    }
  };

  return (
    <div className="nr-rise mt-8 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10.5px] font-bold tracking-wider text-accent uppercase">
            {board.category} · Vote now
          </p>
          <h2 className="mt-1 font-display text-xl leading-tight font-extrabold sm:text-2xl">
            <Link href={`/b/${board.slug}`} className="hover:text-primary">
              {board.title}
            </Link>
          </h2>
          {board.description ? (
            <p className="mt-1 text-[12.5px] text-muted-foreground">{board.description}</p>
          ) : null}
        </div>
        {left ? (
          <div className="shrink-0 text-right">
            <p className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">
              Closes in
            </p>
            <p className="tabular font-display text-lg leading-tight font-extrabold">{left}</p>
            {closes ? <p className="text-[11px] text-muted-foreground">{closes}</p> : null}
          </div>
        ) : null}
      </div>

      <ul className="mt-4 space-y-1.5">
        {shown.map((entry) => {
          const mine = data.myVote?.entryId === entry.id;
          const counted = entry.votesEffective > 0;
          return (
            <li
              key={entry.id}
              className={[
                "flex items-center gap-3 rounded-xl px-3 py-2",
                mine ? "bg-primary/8 ring-1 ring-primary/30" : "bg-secondary/60",
              ].join(" ")}
            >
              {hasVotes && counted ? (
                <span className={`rank-numeral w-7 text-center text-[22px] leading-none ${rankClass(entry.rank)}`}>
                  {entry.rank}
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card text-[10.5px] font-bold text-muted-foreground"
                >
                  {monogram(entry.name)}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-[14.5px] font-bold">{entry.name}</span>
                <span className="tabular block truncate text-[11.5px] text-muted-foreground">
                  {entry.subtitle}
                  {showCounts ? `${entry.subtitle ? " · " : ""}${fmtVotes(entry.votesEffective)} votes` : ""}
                </span>
              </span>
              <Button
                size="sm"
                variant={mine ? "secondary" : "default"}
                disabled={pendingEntry !== null}
                onClick={() => void onVote(entry)}
                aria-label={mine ? `Remove your vote for ${entry.name}` : `Vote for ${entry.name}`}
                className={[
                  "h-11 min-w-[76px] font-bold",
                  mine ? "border border-primary/35 text-primary" : "",
                ].join(" ")}
              >
                {pendingEntry === entry.id
                  ? "…"
                  : mine
                    ? data.myVote && data.myVote.weight > 0
                      ? "✓ Voted"
                      : "Pending"
                    : "Vote"}
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
        <span className="text-muted-foreground">
          {myPick
            ? data.myVote && data.myVote.weight > 0
              ? `Your vote: ${myPick.name}. Tap another name to move it.`
              : `Your vote for ${myPick.name} is pending until you confirm.`
            : showCounts
              ? `${fmtVotes(board.totalVotesEffective)} verified votes so far`
              : "Just opened. Be one of the first to vote."}
        </span>
        <Link href={`/b/${board.slug}`} className="font-bold text-primary hover:underline">
          {entries.length > HERO_ROWS ? `See all ${entries.length} →` : "Open the board →"}
        </Link>
      </div>

      {myPick && data.myVote && data.myVote.weight === 0 ? (
        <Button className="mt-3 h-11 w-full font-bold" onClick={() => setOtpOpen(true)}>
          Confirm my vote
        </Button>
      ) : null}

      <OtpModal
        open={otpOpen}
        reason={otpReason}
        onClose={() => setOtpOpen(false)}
        onVerified={() => {
          setOtpOpen(false);
          toast("Confirmed. Your vote now counts.", "success");
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- strips */

function Ticker({ boards }: { boards: Board[] }) {
  const items = boards
    .flatMap((board) =>
      board.top
        .filter((entry) => entry.delta24h)
        .map((entry) => ({
          key: `${board.id}-${entry.id}`,
          rank: entry.rank,
          name: entry.name,
          board: board.title,
          delta: entry.delta24h,
        })),
    )
    .slice(0, 14);

  // A ticker of nothing moving is worse than no ticker.
  if (items.length < 4) return null;
  const doubled = [...items, ...items];

  return (
    <div className="relative overflow-hidden border-y border-border/70 bg-card/60 py-2.5">
      <div className="nr-marquee flex w-max gap-7 pr-7">
        {doubled.map((item, index) => (
          <span key={`${item.key}-${index}`} className="flex shrink-0 items-center gap-2 text-[12.5px] whitespace-nowrap">
            <span className="rank-numeral text-[13px] text-accent">#{item.rank}</span>
            <span className="font-semibold">{item.name}</span>
            <span className="text-muted-foreground">in {item.board}</span>
            <span className={`tabular font-bold ${item.delta > 0 ? "text-up" : "text-down"}`}>
              {item.delta > 0 ? "▲" : "▼"}
              {Math.abs(item.delta)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** The early-days replacement for the ticker: what closes next. */
function ClosingStrip({ boards }: { boards: Board[] }) {
  if (boards.length === 0) return null;
  return (
    <div className="border-y border-border/70 bg-card/60">
      <div className="mx-auto flex max-w-6xl gap-2 overflow-x-auto px-4 py-2.5 text-[12.5px] whitespace-nowrap">
        <span className="shrink-0 font-bold tracking-wide text-accent uppercase">Closing next</span>
        {boards.map((board) => (
          <Link key={board.id} href={`/b/${board.slug}`} className="shrink-0 hover:text-primary">
            <span className="font-semibold">{board.title}</span>
            <span className="text-muted-foreground"> · {closingLabel(board.closesAt)}</span>
            <span className="px-2 text-border">|</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

const TRUST = [
  "Every vote confirmed by a code",
  "One vote per person per board",
  "Removals logged with a reason",
];

function TrustBand() {
  return (
    <section className="mx-auto max-w-6xl px-4 pt-6">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-card/70 px-4 py-3 text-[12.5px]">
        {TRUST.map((line) => (
          <span key={line} className="inline-flex items-center gap-1.5 font-semibold">
            <span className="text-up">✓</span>
            {line}
          </span>
        ))}
        <Link href="/legal/how-voting-works" className="font-bold text-primary hover:underline sm:ml-auto">
          How we count →
        </Link>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- boards */

function BoardCard({ board, now }: { board: Board; now: number }) {
  const upcoming = isUpcoming(board, now);
  const final = board.status === "frozen" || (board.closesAt ? time(board.closesAt) <= now : false);
  const showCounts = board.totalVotesEffective >= BOARD_PROOF_MIN;
  const hasVotes = board.totalVotesEffective > 0;
  const left = countdown(board.closesAt);

  return (
    <Link
      href={`/b/${board.slug}`}
      className="nr-rise group flex flex-col rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/40 hover:shadow-[0_8px_24px_-16px_rgba(11,93,46,0.45)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">
          {board.category}
        </span>
        {upcoming ? (
          <span className="text-[10.5px] font-bold tracking-wide text-muted-foreground uppercase">
            Opens {closingLabel(board.opensAt)}
          </span>
        ) : final ? (
          <span className="text-[10.5px] font-bold tracking-wide text-muted-foreground uppercase">Final</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-bold tracking-wide text-accent uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Live
          </span>
        )}
      </div>

      <h3 className="mt-2 font-display text-[17px] leading-snug font-extrabold group-hover:text-primary">
        {board.title}
      </h3>

      {hasVotes ? (
        <ol className="mt-3 flex-1 space-y-1.5">
          {board.top.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 text-[13px]">
              <span className={`rank-numeral w-4 text-[14px] ${rankClass(entry.rank)}`}>{entry.rank}</span>
              <span className="min-w-0 flex-1 truncate font-semibold">{entry.name}</span>
              {showCounts ? (
                <span className="tabular text-[12px] text-muted-foreground">{fmtVotes(entry.votesEffective)}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 flex-1 text-[13px] leading-relaxed text-muted-foreground">
          {board.top.length > 0
            ? `${board.top.map((e) => e.name).join(", ")} and more.`
            : "Contenders being added."}
          {upcoming ? "" : " No votes yet. Yours could be the first."}
        </p>
      )}

      <div className="tabular mt-3 flex items-center gap-2 border-t border-border/70 pt-2.5 text-[11.5px] text-muted-foreground">
        {showCounts ? (
          <span>
            <span className="font-semibold text-foreground">{fmtVotes(board.totalVotesEffective)}</span> votes
          </span>
        ) : (
          <span>{final ? "Results are in" : upcoming ? "Coming soon" : "Just opened"}</span>
        )}
        {!final && !upcoming && left ? (
          <span className="ml-auto font-semibold text-foreground">
            Closes {closingLabel(board.closesAt)}
          </span>
        ) : final ? (
          <span className="ml-auto font-semibold text-primary">See results →</span>
        ) : null}
      </div>
    </Link>
  );
}

function SuggestBoard() {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const toast = useToast();

  return (
    <section className="mx-auto max-w-6xl px-4 pt-8 pb-4">
      <div className="rounded-2xl border border-dashed border-border bg-card/60 p-5">
        <h2 className="font-display text-xl font-extrabold">What should Nigeria vote on next?</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          The most-asked-for argument opens as the next board.
        </p>
        {sent ? (
          <p className="mt-3 text-[13.5px] font-semibold text-primary">
            Got it. Watch this page for new boards every week.
          </p>
        ) : (
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              const value = text.trim();
              if (value.length < 4) {
                toast("Tell us a bit more. Something like “Best suya in Abuja”.", "error");
                return;
              }
              trackEvent("board_suggested", { text: value });
              setSent(true);
            }}
          >
            <input
              aria-label="Suggest a board"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={120}
              placeholder="e.g. Best suya in Abuja"
              className="h-11 w-full rounded-lg border border-input sm:flex-1 bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            />
            <Button type="submit" variant="outline" className="h-11 px-5 font-bold">
              Suggest it
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ page */

export default function HomePage() {
  const { data, isLoading } = useBoards();
  const [category, setCategory] = useState<string>("All");
  const now = Date.now();

  useEffect(() => {
    trackEvent("home_viewed");
  }, []);

  const boards = useMemo(() => data ?? [], [data]);
  const open = useMemo(() => boards.filter((b) => isOpen(b, now)), [boards, now]);

  const hero = useMemo(() => {
    const pinned = PINNED_HERO ? open.find((b) => b.slug === PINNED_HERO) : undefined;
    if (pinned) return pinned;
    // Most verified votes wins; on a tie (launch day: all zero) the board that runs longest.
    return (
      [...open].sort(
        (a, b) => b.totalVotesEffective - a.totalVotesEffective || time(b.closesAt) - time(a.closesAt),
      )[0] ?? null
    );
  }, [open]);

  const totalVotes = useMemo(() => boards.reduce((sum, b) => sum + b.totalVotesEffective, 0), [boards]);
  const early = totalVotes < SITE_PROOF_MIN;

  const closingNext = useMemo(
    () =>
      open
        .filter((b) => b.closesAt)
        .sort((a, b) => time(a.closesAt) - time(b.closesAt))
        .slice(0, 4),
    [open],
  );

  // Open boards first (closing soonest at the top), then upcoming, then finished.
  const ordered = useMemo(() => {
    const weight = (b: Board) => (isOpen(b, now) ? 0 : isUpcoming(b, now) ? 1 : 2);
    return [...boards].sort(
      (a, b) => weight(a) - weight(b) || (time(a.closesAt) || Infinity) - (time(b.closesAt) || Infinity),
    );
  }, [boards, now]);

  const filtered = category === "All" ? ordered : ordered.filter((b) => b.category === category);
  const categories = useMemo(() => ["All", ...new Set(ordered.map((b) => b.category))], [ordered]);

  return (
    <Shell>
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 -top-40 h-80 bg-[radial-gradient(60%_100%_at_50%_100%,var(--primary)_0%,transparent_70%)] opacity-[0.10]"
        />
        <div className="relative mx-auto max-w-6xl px-4 pt-10 pb-8 sm:pt-14">
          <div className="lg:grid lg:grid-cols-[1fr_1.05fr] lg:items-start lg:gap-10">
            <div className="lg:pt-6">
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[11.5px] font-bold tracking-wide uppercase">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                {early ? "Now open · Nigeria" : "Counting live · Nigeria"}
              </span>

              <h1 className="nr-rise mt-4 max-w-3xl font-display text-[34px] leading-[1.03] font-extrabold sm:text-[52px]">
                Who is really #1?
                <br />
                Nigeria decides, <span className="text-primary">live</span>.
              </h1>
              <p className="nr-rise mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:text-base">
                Song of the year. Best jollof in Lagos. The arguments you have every week, settled by
                verified votes instead of critics.
              </p>
              <p className="nr-rise mt-4 text-[13.5px] font-semibold">
                Vote in one tap. Confirm with a code so it counts.{" "}
                <Link href="/legal/how-voting-works" className="text-primary hover:underline">
                  How we count →
                </Link>
              </p>
              {!early ? (
                <p className="tabular mt-2 text-[13px] text-muted-foreground">
                  <span className="font-bold text-foreground">{fmtVotes(totalVotes)}</span> verified votes
                  across <span className="font-bold text-foreground">{boards.length}</span> boards
                </p>
              ) : null}
            </div>

            {isLoading ? (
              <div className="mt-8 h-[420px] animate-pulse rounded-2xl bg-muted/70" />
            ) : hero ? (
              <HeroBoard slug={hero.slug} />
            ) : (
              <p className="mt-8 rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                The first boards open soon.
              </p>
            )}
          </div>
        </div>
      </section>

      {early ? <ClosingStrip boards={closingNext} /> : <Ticker boards={open} />}

      <TrustBand />

      <section className="mx-auto max-w-6xl px-4 pt-8 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl font-extrabold">All boards</h2>
          {boards.length > 6 ? (
            <div className="flex flex-wrap gap-1.5">
              {categories.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setCategory(name)}
                  className={[
                    "h-8 rounded-full border px-3 text-[12.5px] font-bold transition-colors",
                    category === name
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                >
                  {name}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {isLoading ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="h-[190px] animate-pulse rounded-xl bg-muted/70" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No {category} board is open yet. New ones open every week.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((board) => (
              <BoardCard key={board.id} board={board} now={now} />
            ))}
          </div>
        )}
      </section>

      <SuggestBoard />
    </Shell>
  );
}
