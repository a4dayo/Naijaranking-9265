import { useState } from "react";
import type { RankedEntry } from "../queries/boards";
import { initials, votes as fmtVotes } from "../lib/format";
import { Button } from "./ui/button";

const EMOJI = ["🔥", "😂", "😐", "💯"] as const;

function medalClass(rank: number) {
  if (rank === 1) return "text-gold";
  if (rank === 2) return "text-silver";
  if (rank === 3) return "text-bronze";
  return "text-muted-foreground/70";
}

function Delta({ value }: { value: number }) {
  if (!value)
    return (
      <span className="tabular text-[11px] font-semibold text-muted-foreground/70" title="No change in 24h">
        —
      </span>
    );
  const up = value > 0;
  return (
    <span
      className={`tabular inline-flex items-center gap-0.5 text-[11px] font-bold ${up ? "text-up" : "text-down"}`}
      title={`${up ? "Up" : "Down"} ${Math.abs(value)} place${Math.abs(value) === 1 ? "" : "s"} in 24h`}
    >
      <svg viewBox="0 0 12 12" className={`h-2.5 w-2.5 ${up ? "" : "rotate-180"}`} fill="currentColor" aria-hidden="true">
        <path d="M6 1.5 11 9H1z" />
      </svg>
      {Math.abs(value)}
    </span>
  );
}

interface Props {
  entry: RankedEntry;
  index: number;
  votable: boolean;
  isMyVote: boolean;
  pending: boolean;
  myReactions: Set<string>;
  onVote: (entry: RankedEntry) => void;
  onReact?: (entry: RankedEntry, emoji: string) => void;
  onReport?: (entry: RankedEntry) => void;
  sharePercent: number;
}

export function RankRow({
  entry,
  index,
  votable,
  isMyVote,
  pending,
  myReactions,
  onVote,
  onReact,
  onReport,
  sharePercent,
}: Props) {
  const [showReactions, setShowReactions] = useState(false);
  const reactionTotal = Object.values(entry.reactions).reduce((a, b) => a + b, 0);

  return (
    <li
      className={[
        "nr-rise group relative overflow-hidden rounded-xl border bg-card transition-colors",
        isMyVote ? "border-primary/45 ring-1 ring-primary/20" : "border-border hover:border-border",
        entry.isSponsored ? "border-dashed border-gold/60" : "",
      ].join(" ")}
      style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
    >
      {/* Vote share as a hairline bar behind the row — proportion at a glance. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 bg-primary/6"
        style={{ width: `${Math.max(1.5, sharePercent)}%` }}
      />

      <div className="relative flex items-center gap-3 p-3 sm:gap-4 sm:p-3.5">
        <div className="flex w-9 shrink-0 flex-col items-center sm:w-12">
          <span className={`rank-numeral text-[26px] leading-none sm:text-[34px] ${medalClass(entry.rank)}`}>
            {entry.rank}
          </span>
          <Delta value={entry.delta24h} />
        </div>

        {entry.imageUrl ? (
          <img
            src={entry.imageUrl}
            alt=""
            loading="lazy"
            className="h-11 w-11 shrink-0 rounded-lg object-cover sm:h-12 sm:w-12"
          />
        ) : (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-secondary font-display text-sm font-extrabold text-muted-foreground sm:h-12 sm:w-12">
            {initials(entry.name)}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-display text-[15px] font-bold sm:text-base">{entry.name}</span>
            {entry.claimed ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary"
                title="Claimed by its subject"
              >
                ✓ Claimed
              </span>
            ) : null}
            {entry.isSponsored ? (
              <span className="rounded-full border border-dashed border-gold/70 px-1.5 py-0.5 text-[10px] font-bold text-gold">
                Sponsored
              </span>
            ) : null}
          </div>
          {entry.subtitle ? (
            <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{entry.subtitle}</p>
          ) : null}
          <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="tabular font-semibold text-foreground">
              {fmtVotes(entry.votesEffective)}
            </span>
            <span>{entry.votesEffective === 1 ? "vote" : "votes"}</span>
            {reactionTotal > 0 ? (
              <span className="hidden items-center gap-1 sm:inline-flex">
                ·
                {EMOJI.filter((emoji) => entry.reactions[emoji]).map((emoji) => (
                  <span key={emoji} className="tabular">
                    {emoji} {entry.reactions[emoji]}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {votable ? (
            <Button
              type="button"
              size="sm"
              variant={isMyVote ? "secondary" : "default"}
              disabled={pending}
              onClick={() => onVote(entry)}
              aria-label={isMyVote ? `Remove your vote for ${entry.name}` : `Vote for ${entry.name}`}
              className={[
                "h-9 min-w-[74px] px-3 text-[13px] font-bold",
                isMyVote ? "border border-primary/35 text-primary" : "",
              ].join(" ")}
            >
              {pending ? "…" : isMyVote ? "✓ Voted" : "Vote"}
            </Button>
          ) : null}
          {onReact ? (
            <button
              type="button"
              onClick={() => setShowReactions((open) => !open)}
              className="px-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              aria-expanded={showReactions}
            >
              React
            </button>
          ) : null}
        </div>
      </div>

      {showReactions && onReact ? (
        <div className="relative flex flex-wrap items-center gap-1.5 border-t border-border/70 bg-secondary/40 px-3 py-2">
          {EMOJI.map((emoji) => {
            const on = myReactions.has(`${entry.id}:${emoji}`);
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact(entry, emoji)}
                className={[
                  "tabular flex h-8 items-center gap-1 rounded-full border px-2.5 text-[13px] transition-colors",
                  on ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-card hover:bg-muted",
                ].join(" ")}
              >
                {emoji}
                <span className="text-[11px] font-semibold">{entry.reactions[emoji] ?? 0}</span>
              </button>
            );
          })}
          {onReport ? (
            <button
              type="button"
              onClick={() => onReport(entry)}
              className="ml-auto text-[11px] font-medium text-muted-foreground underline transition-colors hover:text-destructive"
            >
              Report this entry
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
