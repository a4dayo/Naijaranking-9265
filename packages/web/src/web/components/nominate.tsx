import { useState } from "react";
import { Button } from "./ui/button";
import { useToast } from "./toast";
import { useNominate, useNominations, useUpvoteNomination } from "../queries/boards";
import { trackEvent } from "../queries/boards";

/** Missing-entry suggestions. Screened and queued — never auto-published. */
export function NominationTray({ boardId }: { boardId: string }) {
  const [name, setName] = useState("");
  const toast = useToast();
  const { data: nominations } = useNominations(boardId);
  const nominate = useNominate(boardId);
  const upvote = useUpvoteNomination(boardId);

  const submit = async () => {
    const value = name.trim();
    if (value.length < 2) return;
    try {
      const result = await nominate.mutateAsync({ boardId, name: value });
      setName("");
      trackEvent("nomination_submitted", { boardId });
      toast(
        result.screened === "clean"
          ? "Sent. An operator reviews it next."
          : "Got it — this one needs a closer look before it can show up.",
        "success",
      );
    } catch (error) {
      toast((error as { message?: string }).message ?? "Could not send that suggestion.", "error");
    }
  };

  const cheer = async (nominationId: string) => {
    try {
      const result = await upvote.mutateAsync({ nominationId });
      if (result.alreadyUpvoted) toast("You already backed that one.");
    } catch (error) {
      toast((error as { message?: string }).message ?? "Vote on the board first, then upvote.", "error");
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-display text-base font-bold">They left someone out?</h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
        Drop the name. A human reviews every suggestion before it joins the board, and 10 backers
        pushes it to the front of the queue.
      </p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          aria-label="Name to nominate"
          value={name}
          onChange={(event) => setName(event.target.value.slice(0, 80))}
          placeholder="Add a name"
          className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
        <Button type="submit" variant="secondary" className="h-10 px-3 text-[13px] font-bold" disabled={nominate.isPending || name.trim().length < 2}>
          Suggest
        </Button>
      </form>

      {nominations && nominations.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {nominations.slice(0, 6).map((nomination) => (
            <li
              key={nomination.id}
              className="flex items-center gap-2 rounded-lg bg-secondary/50 px-2.5 py-1.5 text-[13px]"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{nomination.submittedName}</span>
              <span className="text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
                {nomination.status === "approved" ? "approved" : "in review"}
              </span>
              <button
                type="button"
                onClick={() => void cheer(nomination.id)}
                className="tabular flex h-7 items-center gap-1 rounded-full border border-border bg-card px-2 text-[11.5px] font-bold transition-colors hover:bg-muted"
              >
                ▲ {nomination.upvotes}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
