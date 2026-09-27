import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Shell } from "../components/shell";
import { Button } from "../components/ui/button";
import { CATEGORY_ORDER, timeAgo, votes as fmtVotes } from "../lib/format";
import { useBoards } from "../queries/boards";

type Board = NonNullable<ReturnType<typeof useBoards>["data"]>[number];

function Ticker({ boards }: { boards: Board[] }) {
  const items = boards
    .flatMap((board) =>
      board.top.map((entry) => ({
        key: `${board.id}-${entry.id}`,
        rank: entry.rank,
        name: entry.name,
        board: board.title,
        delta: entry.delta24h,
      })),
    )
    .slice(0, 14);

  if (items.length === 0) return null;
  const doubled = [...items, ...items];

  return (
    <div className="relative overflow-hidden border-y border-border/70 bg-card/60 py-2.5">
      <div className="nr-marquee flex w-max gap-7 pr-7">
        {doubled.map((item, index) => (
          <span
            key={`${item.key}-${index}`}
            className="flex shrink-0 items-center gap-2 text-[12.5px] whitespace-nowrap"
          >
            <span className="rank-numeral text-[13px] text-accent">#{item.rank}</span>
            <span className="font-semibold">{item.name}</span>
            <span className="text-muted-foreground">in {item.board}</span>
            {item.delta ? (
              <span className={`tabular font-bold ${item.delta > 0 ? "text-up" : "text-down"}`}>
                {item.delta > 0 ? "▲" : "▼"}
                {Math.abs(item.delta)}
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function BoardCard({ board }: { board: Board }) {
  const live = board.status === "live";
  return (
    <Link
      href={`/b/${board.slug}`}
      className="nr-rise group flex flex-col rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/40 hover:shadow-[0_8px_24px_-16px_rgba(11,93,46,0.45)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">
          {board.category}
        </span>
        {live ? (
          <span className="inline-flex items-center gap-1 text-[10.5px] font-bold tracking-wide text-accent uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Live
          </span>
        ) : (
          <span className="text-[10.5px] font-bold tracking-wide text-muted-foreground uppercase">
            Final
          </span>
        )}
      </div>

      <h3 className="mt-2 font-display text-[17px] leading-snug font-extrabold group-hover:text-primary">
        {board.title}
      </h3>

      <ol className="mt-3 flex-1 space-y-1.5">
        {board.top.length === 0 ? (
          <li className="text-[12.5px] text-muted-foreground">No votes yet. Be the first.</li>
        ) : (
          board.top.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 text-[13px]">
              <span
                className={`rank-numeral w-4 text-[14px] ${
                  entry.rank === 1 ? "text-gold" : entry.rank === 2 ? "text-silver" : "text-bronze"
                }`}
              >
                {entry.rank}
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold">{entry.name}</span>
              <span className="tabular text-[12px] text-muted-foreground">
                {fmtVotes(entry.votesEffective)}
              </span>
            </li>
          ))
        )}
      </ol>

      <div className="tabular mt-3 flex items-center gap-2 border-t border-border/70 pt-2.5 text-[11.5px] text-muted-foreground">
        <span className="font-semibold text-foreground">{fmtVotes(board.totalVotesEffective)}</span>
        {board.totalVotesEffective === 1 ? "vote" : "votes"}
        <span>·</span>
        <span>
          {fmtVotes(board.voterCount)} {board.voterCount === 1 ? "voter" : "voters"}
        </span>
        <span className="ml-auto">{board.lastVoteAt ? timeAgo(board.lastVoteAt) : "new"}</span>
      </div>
    </Link>
  );
}

const TRUST = [
  {
    title: "One vote per person",
    body: "Verified by email and weighted 1.0. Unverified votes still count, at 0.25.",
  },
  {
    title: "Live, not editorial",
    body: "No panel, no critics' list. The order is whatever Nigerians voted, refreshed every few seconds.",
  },
  {
    title: "Open and audited",
    body: "Suspicious votes are flagged by machine and removed only by a person, with a written reason.",
  },
];

export default function HomePage() {
  const { data, isLoading } = useBoards();
  const [category, setCategory] = useState<string>("All");

  const boards = useMemo(() => data ?? [], [data]);
  const hero = useMemo(
    () =>
      [...boards].sort((a, b) => b.totalVotesEffective - a.totalVotesEffective)[0] ?? null,
    [boards],
  );
  const filtered = useMemo(
    () => (category === "All" ? boards : boards.filter((board) => board.category === category)),
    [boards, category],
  );
  const totals = useMemo(
    () =>
      boards.reduce(
        (acc, board) => ({
          votes: acc.votes + board.totalVotesEffective,
          voters: acc.voters + board.voterCount,
        }),
        { votes: 0, voters: 0 },
      ),
    [boards],
  );

  const categories = ["All", ...CATEGORY_ORDER.filter((name) => boards.some((b) => b.category === name))];

  return (
    <Shell>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 -top-40 h-80 bg-[radial-gradient(60%_100%_at_50%_100%,var(--primary)_0%,transparent_70%)] opacity-[0.10]"
        />
        <div className="relative mx-auto max-w-6xl px-4 pt-10 pb-8 sm:pt-16">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[11.5px] font-bold tracking-wide uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Counting live · Nigeria
          </span>

          <h1 className="nr-rise mt-4 max-w-3xl font-display text-[34px] leading-[1.03] font-extrabold sm:text-[56px]">
            Who is really #1?
            <br />
            Nigeria decides, <span className="text-primary">live</span>.
          </h1>
          <p className="nr-rise mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:text-base">
            Biggest artist right now. Best jollof in Lagos. The arguments you have every week,
            settled by votes instead of critics — one tap, no sign-up, and the board moves while you
            watch.
          </p>

          <div className="nr-rise mt-6 flex flex-wrap items-center gap-3">
            {hero ? (
              <Link href={`/b/${hero.slug}`}>
                <Button size="lg" className="h-12 px-6 text-[15px] font-bold">
                  Cast your vote →
                </Button>
              </Link>
            ) : null}
            <span className="tabular text-[13px] text-muted-foreground">
              <span className="font-bold text-foreground">{fmtVotes(totals.votes)}</span>{" "}
              {totals.votes === 1 ? "vote" : "votes"} counted
              across <span className="font-bold text-foreground">{boards.length}</span> boards
              <span className="block text-[12px]">Takes one tap. No account needed.</span>
            </span>
          </div>

          {hero ? (
            <Link
              href={`/b/${hero.slug}`}
              className="nr-rise mt-8 block rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/40 sm:p-5"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10.5px] font-bold tracking-wider text-accent uppercase">
                    Hottest board right now
                  </p>
                  <h2 className="mt-1 truncate font-display text-xl font-extrabold sm:text-2xl">
                    {hero.title}
                  </h2>
                </div>
                <span className="tabular hidden shrink-0 text-right text-[12px] text-muted-foreground sm:block">
                  <span className="block font-display text-2xl font-extrabold text-foreground">
                    {fmtVotes(hero.totalVotesEffective)}
                  </span>
                  {hero.totalVotesEffective === 1 ? "vote" : "votes"}
                </span>
              </div>
              <ol className="mt-4 grid gap-2 sm:grid-cols-3">
                {hero.top.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center gap-3 rounded-xl bg-secondary/60 px-3 py-2.5"
                  >
                    <span
                      className={`rank-numeral text-[28px] leading-none ${
                        entry.rank === 1 ? "text-gold" : entry.rank === 2 ? "text-silver" : "text-bronze"
                      }`}
                    >
                      {entry.rank}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-display text-[14px] font-bold">
                        {entry.name}
                      </span>
                      <span className="tabular text-[11.5px] text-muted-foreground">
                        {fmtVotes(entry.votesEffective)}{" "}
                        {entry.votesEffective === 1 ? "vote" : "votes"}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </Link>
          ) : null}
        </div>
      </section>

      <Ticker boards={boards} />

      {/* Trust strip */}
      <section className="mx-auto grid max-w-6xl gap-3 px-4 py-8 sm:grid-cols-3">
        {TRUST.map((item) => (
          <div key={item.title} className="rounded-xl border border-border bg-card/70 p-4">
            <h3 className="font-display text-[15px] font-bold">{item.title}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{item.body}</p>
          </div>
        ))}
      </section>

      {/* Board grid */}
      <section className="mx-auto max-w-6xl px-4 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl font-extrabold">All boards</h2>
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
        </div>

        {isLoading ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="h-[210px] animate-pulse rounded-xl bg-muted/70" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No {category} board is live yet. New ones open every week — vote on another one
            meanwhile.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((board) => (
              <BoardCard key={board.id} board={board} />
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}
