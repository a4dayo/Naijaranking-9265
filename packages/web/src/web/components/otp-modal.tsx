import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { useToast } from "./toast";
import { useRequestCode, useVerifyCode } from "../queries/identity";
import { trackEvent } from "../queries/boards";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Shown above the form — e.g. "Your vote for Asake counts 0.25 right now." */
  reason?: string;
  onVerified?: (upgradedBoards: number) => void;
}

function errorMessage(error: unknown, fallback: string) {
  const message = (error as { message?: string } | null)?.message;
  return message && message.length < 200 ? message : fallback;
}

/**
 * "Make your vote count" — the only identity prompt in the product, and it is
 * always after the vote has already been counted, never a gate in front of it.
 */
export function OtpModal({ open, onClose, reason, onVerified }: Props) {
  const [destination, setDestination] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"destination" | "code">("destination");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const toast = useToast();
  const request = useRequestCode();
  const verify = useVerifyCode();
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      trackEvent("otp_prompt_shown");
      setTimeout(() => firstField.current?.focus(), 60);
    } else {
      setCode("");
      setStage("destination");
      setDevCode(null);
    }
  }, [open]);

  useEffect(() => {
    if (expiresIn <= 0) return;
    const timer = setInterval(() => setExpiresIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [expiresIn]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const send = async () => {
    try {
      const result = await request.mutateAsync({ destination: destination.trim() });
      setStage("code");
      setDevCode(result.devCode ?? null);
      setExpiresIn(result.expiresInSeconds ?? 600);
      trackEvent("otp_requested", { channel: result.channel });
      setTimeout(() => firstField.current?.focus(), 60);
      if (!result.delivered && !result.devCode) {
        toast("Could not send the code. Try a different address.", "error");
      }
    } catch (error) {
      toast(errorMessage(error, "Could not send that code."), "error");
    }
  };

  const submit = async () => {
    try {
      const result = await verify.mutateAsync({ destination: destination.trim(), code: code.trim() });
      trackEvent("otp_verified", { upgradedBoards: result.upgradedBoards });
      toast(
        result.upgradedBoards > 0
          ? `Verified. Your vote now counts full weight on ${result.upgradedBoards} board${result.upgradedBoards === 1 ? "" : "s"}.`
          : "Verified. Your votes now count at full weight.",
        "success",
      );
      onVerified?.(result.upgradedBoards);
      onClose();
    } catch (error) {
      toast(errorMessage(error, "That code did not match. Check it, or resend."), "error");
    }
  };

  return (
    <div className="fixed inset-0 z-100 flex items-end justify-center bg-foreground/45 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <button type="button" aria-label="Close" className="absolute inset-0" onClick={onClose} />
      <dialog
        open
        aria-modal="true"
        aria-label="Verify your vote"
        className="nr-rise relative m-0 w-full max-w-md rounded-t-2xl border border-border bg-card p-5 text-card-foreground shadow-2xl sm:rounded-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3.5 right-3.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
            <path d="M18.3 5.71 12 12.01l-6.3-6.3-1.4 1.41 6.29 6.3-6.3 6.3 1.42 1.41 6.29-6.3 6.3 6.3 1.41-1.42-6.3-6.29 6.3-6.3z" />
          </svg>
        </button>

        <h2 className="pr-8 font-display text-xl font-extrabold">Make your vote count 4×</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {reason ?? "Your vote is already counted."} Verifying your email lifts it from 0.25 to a
          full 1.0 — four times the weight. One check covers every board, and there is no password
          and no account to create.
        </p>

        {stage === "destination" ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Email address
              <input
                ref={firstField}
                aria-label="Email address"
                type="email"
                required
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                inputMode="email"
                className="mt-1.5 h-11 w-full rounded-xl border border-input bg-background px-3 text-base font-normal text-foreground normal-case outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              />
            </label>
            <Button
              type="submit"
              size="lg"
              className="h-11 w-full text-[15px]"
              disabled={request.isPending || destination.trim().length < 5}
            >
              {request.isPending ? "Sending code…" : "Send my code"}
            </Button>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              We store your address only to keep one vote per person, and never show it publicly.
              You can delete it any time from the{" "}
              <a href="/legal/privacy" className="underline">
                privacy page
              </a>
              .
            </p>
          </form>
        ) : (
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p className="text-sm text-muted-foreground">
              Code sent to <span className="font-semibold text-foreground">{destination}</span>.
              {expiresIn > 0 ? ` Expires in ${Math.ceil(expiresIn / 60)} min.` : ""}
            </p>
            {devCode ? (
              <p className="rounded-lg border border-dashed border-accent/50 bg-accent/10 px-3 py-2 text-[13px] text-foreground">
                Dev mode — no mail provider configured. Your code is{" "}
                <span className="rank-numeral tracking-normal">{devCode}</span>
              </p>
            ) : null}
            <label className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              6-digit code
              <input
                ref={firstField}
                aria-label="6-digit verification code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="rank-numeral mt-1.5 h-12 w-full rounded-xl border border-input bg-background px-3 text-center text-2xl tracking-[0.35em] text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              />
            </label>
            <Button
              type="submit"
              size="lg"
              className="h-11 w-full text-[15px]"
              disabled={verify.isPending || code.length < 4}
            >
              {verify.isPending ? "Checking…" : "Unlock full weight"}
            </Button>
            <div className="flex items-center justify-between text-[12px]">
              <button
                type="button"
                className="font-medium text-muted-foreground underline"
                onClick={() => setStage("destination")}
              >
                Use another address
              </button>
              <button
                type="button"
                className="font-medium text-muted-foreground underline disabled:opacity-50"
                disabled={request.isPending}
                onClick={() => void send()}
              >
                Resend code
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
