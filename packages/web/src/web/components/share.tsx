import { useState } from "react";
import { trackEvent } from "../queries/boards";
import { useToast } from "./toast";

interface Props {
  slug: string;
  title: string;
  /** e.g. "Asake is #1 right now" — what the share text leads with. */
  line?: string;
  boardId?: string;
}

/**
 * Share targets point at /api/share/:slug, the server-rendered document that
 * carries per-board OG tags (the SPA's index.html cannot).
 */
export function ShareRow({ slug, title, line, boardId }: Props) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const url = `${window.location.origin}/api/share/${slug}`;
  const text = line
    ? `${line} in ${title} on NaijaRank. Disagree? Vote and move it.`
    : `${title} on NaijaRank — cast your vote and move the board.`;

  const record = (channel: string) => trackEvent("share_clicked", { boardId, channel });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      setCopied(true);
      record("copy");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Could not copy — long-press the link instead.", "error");
    }
  };

  const native = async () => {
    if (!navigator.share) return copy();
    try {
      await navigator.share({ title, text, url });
      record("native");
    } catch {
      /* dismissed */
    }
  };

  const base =
    "inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[12.5px] font-semibold transition-colors hover:bg-muted";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void native()} className={base}>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
          <path d="M18 16.08a3 3 0 0 0-2.02.79l-7.1-4.13a3.4 3.4 0 0 0 0-1.48l7.02-4.1A3 3 0 1 0 15 5a3 3 0 0 0 .06.59L8.04 9.68a3 3 0 1 0 0 4.64l7.1 4.14a3 3 0 1 0 2.86-2.38Z" />
        </svg>
        Share
      </button>
      <a
        className={base}
        target="_blank"
        rel="noreferrer noopener"
        onClick={() => record("whatsapp")}
        href={`https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`}
      >
        WhatsApp
      </a>
      <a
        className={base}
        target="_blank"
        rel="noreferrer noopener"
        onClick={() => record("x")}
        href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`}
      >
        X
      </a>
      <button type="button" onClick={() => void copy()} className={base}>
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}
