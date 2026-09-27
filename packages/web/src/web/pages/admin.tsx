import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Logo } from "../components/shell";
import { useToast } from "../components/toast";
import { Button } from "../components/ui/button";
import { CATEGORY_ORDER, dateTime, plural, timeAgo, votes as fmtVotes } from "../lib/format";
import {
  type AdminBoard,
  type AdminFlag,
  useAdminBoard,
  useAdminBoards,
  useAdminLogout,
  useAdminSignIn,
  useAdminStatus,
  useApproveSensitive,
  useAuditLog,
  useCreateBoard,
  useDashboard,
  useDeleteBoard,
  useFlagDetail,
  useFlags,
  useMergeEntry,
  useModeration,
  useResolveFlag,
  useReviewClaim,
  useReviewNomination,
  useReviewReport,
  useRunJob,
  useSeedEntries,
  useSetBoardStatus,
  useUpdateBoard,
  useUpdateEntry,
  useVoidVotes,
} from "../queries/admin";

const TABS = ["Overview", "Boards", "Fraud", "Queue", "Audit"] as const;
type Tab = (typeof TABS)[number];

function errorMessage(err: unknown) {
  if (err && typeof err === "object" && "message" in err) return String((err as Error).message);
  return "Something went wrong.";
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  "mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-border bg-card p-4 sm:p-5 ${className}`}>
      {title ? (
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold tracking-wide uppercase">{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

function StatusTag({ status }: { status: string }) {
  const tone =
    status === "live"
      ? "border-accent/30 bg-accent/10 text-accent"
      : status === "frozen"
        ? "border-border bg-secondary text-muted-foreground"
        : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase ${tone}`}
    >
      {status}
    </span>
  );
}

/* ---------------------------------------------------------------- sign-in */

function SignIn({ bootstrapped }: { bootstrapped: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const mode = bootstrapped ? "login" : "bootstrap";
  const signIn = useAdminSignIn(mode);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16">
      <Link href="/" className="mb-8 inline-flex">
        <Logo />
      </Link>
      <Card>
        <h1 className="text-xl font-bold">
          {bootstrapped ? "Operator sign-in" : "Create the owner account"}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {bootstrapped
            ? "This console runs the boards, the fraud queue and the audit log."
            : "First run: this account becomes the owner and can approve sensitive boards."}
        </p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            signIn.mutate({
              email: email.trim(),
              password,
              ...(bootstrapped ? {} : { name: name.trim() || undefined }),
            });
          }}
        >
          {!bootstrapped && (
            <Field label="Name">
              <input
                aria-label="Operator name"
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </Field>
          )}
          <Field label="Email">
            <input
              aria-label="Operator email"
              className={inputClass}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </Field>
          <Field label="Password" hint={bootstrapped ? undefined : "At least 10 characters."}>
            <input
              aria-label="Operator password"
              className={inputClass}
              type="password"
              required
              minLength={bootstrapped ? 1 : 10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {signIn.isError && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage(signIn.error)}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={signIn.isPending}>
            {signIn.isPending ? "Checking…" : bootstrapped ? "Sign in" : "Create account"}
          </Button>
        </form>
      </Card>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        Five failed attempts locks the account for 15 minutes.
      </p>
    </main>
  );
}

/* --------------------------------------------------------------- overview */

function Overview() {
  const dashboard = useDashboard(true);
  const runJob = useRunJob();
  const toast = useToast();
  const data = dashboard.data;
  const HOUR_MS = 3_600_000;
  // Zero-fill every hour so the chart always reads as a full 24-hour window.
  const series = useMemo(() => {
    const counts = new Map((data?.hourly ?? []).map((h) => [h.hour, h.count]));
    const current = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    return Array.from({ length: 24 }, (_, i) => {
      const hour = current - (23 - i) * HOUR_MS;
      return { hour, count: counts.get(hour) ?? 0 };
    });
  }, [data?.hourly]);
  const peak = Math.max(1, ...series.map((h) => h.count));

  const stats = data
    ? [
        { label: "Boards live", value: String(data.boards.live), sub: `${data.boards.draft} draft · ${data.boards.frozen} frozen` },
        { label: "Votes · 24h", value: fmtVotes(data.votes24h), sub: `${fmtVotes(data.verifiedVotes24h)} verified` },
        { label: "Voters", value: fmtVotes(data.voters), sub: `${fmtVotes(data.verifiedVoters)} verified` },
        { label: "Voided · 24h", value: fmtVotes(data.voided24h), sub: "flagged then reviewed" },
      ]
    : [];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {dashboard.isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl border border-border bg-card" />
            ))
          : stats.map((stat) => (
              <div key={stat.label} className="rounded-2xl border border-border bg-card p-4">
                <p className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
                  {stat.label}
                </p>
                <p className="tabular mt-1.5 text-2xl font-bold">{stat.value}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{stat.sub}</p>
              </div>
            ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Votes per hour · last 24h">
          <div className="flex h-36 items-end gap-1">
            {series.map((hour) => (
              <div
                key={hour.hour}
                className={`flex-1 rounded-t ${hour.count ? "bg-primary/80" : "bg-secondary"}`}
                style={{ height: `${Math.max(3, (hour.count / peak) * 100)}%` }}
                title={`${new Date(hour.hour).toLocaleTimeString([], { hour: "2-digit" })} — ${hour.count} votes`}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
            <span>{new Date(series[0]!.hour).toLocaleTimeString([], { hour: "2-digit" })}</span>
            <span className="tabular">peak {peak}/h</span>
            <span>now</span>
          </div>
        </Card>

        <div className="space-y-5">
          <Card title="Queues">
            <ul className="space-y-2 text-sm">
              {data
                ? [
                    ["Open fraud flags", data.queues.flags],
                    ["Nominations", data.queues.nominations],
                    ["Reports", data.queues.reports],
                    ["Claims", data.queues.claims],
                  ].map(([label, count]) => (
                    <li key={String(label)} className="flex items-center justify-between">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="tabular font-bold">{String(count)}</span>
                    </li>
                  ))
                : null}
            </ul>
          </Card>

          <Card title="Jobs">
            <div className="flex flex-wrap gap-2">
              {(["reconcile", "scan", "snapshot", "purge"] as const).map((job) => (
                <Button
                  key={job}
                  size="sm"
                  variant="outline"
                  disabled={runJob.isPending}
                  onClick={() =>
                    runJob.mutate(
                      { job },
                      {
                        onSuccess: (result) => toast(`${job}: ${JSON.stringify(result)}`, "success"),
                        onError: (err) => toast(errorMessage(err), "error"),
                      },
                    )
                  }
                >
                  {job}
                </Button>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Reconcile recounts server-side vote totals. Scan re-runs fraud detection (flags only,
              never deletes). Snapshot writes the 24h rank baseline. Purge drops raw IP/ASN older
              than 90 days.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- boards */

function CreateBoard({ onDone }: { onDone: (boardId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(CATEGORY_ORDER[0]);
  const [description, setDescription] = useState("");
  const [entryLimit, setEntryLimit] = useState(10);
  const [sensitive, setSensitive] = useState(false);
  const create = useCreateBoard();
  const toast = useToast();

  if (!open)
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        New board
      </Button>
    );

  return (
    <Card title="New board" className="col-span-full">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              title: title.trim(),
              category,
              description: description.trim() || undefined,
              entryLimit,
              sensitive,
            },
            {
              onSuccess: (board) => {
                toast(`Draft created: ${board.title}`, "success");
                setOpen(false);
                setTitle("");
                setDescription("");
                onDone(board.id);
              },
              onError: (err) => toast(errorMessage(err), "error"),
            },
          );
        }}
      >
        <Field label="Title">
          <input
            aria-label="Board title"
            className={inputClass}
            required
            minLength={4}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Top 10 Nigerian Podcasts"
          />
        </Field>
        <Field label="Category" hint="Locked to the five approved categories.">
          <select
            aria-label="Board category"
            className={inputClass}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description">
          <textarea
            aria-label="Board description"
            className={`${inputClass} min-h-20`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="space-y-3">
          <Field label="Entry limit">
            <input
              aria-label="Entry limit"
              className={inputClass}
              type="number"
              min={3}
              max={100}
              value={entryLimit}
              onChange={(e) => setEntryLimit(Number(e.target.value))}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              aria-label="Mark this board as a sensitive subject"
              type="checkbox"
              className="mt-1"
              checked={sensitive}
              onChange={(e) => setSensitive(e.target.checked)}
            />
            <span>
              Sensitive subject
              <span className="block text-xs text-muted-foreground">
                Needs owner approval before it can go live.
              </span>
            </span>
          </label>
        </div>
        <div className="col-span-full flex gap-2">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create draft"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function BoardDetail({ boardId, role }: { boardId: string; role: string }) {
  const detail = useAdminBoard(boardId);
  const toast = useToast();
  const setStatus = useSetBoardStatus();
  const approve = useApproveSensitive();
  const remove = useDeleteBoard();
  const update = useUpdateBoard();
  const seed = useSeedEntries();
  const updateEntry = useUpdateEntry();
  const merge = useMergeEntry();
  const [csv, setCsv] = useState("");
  const [mergeSource, setMergeSource] = useState("");
  const [mergeTarget, setMergeTarget] = useState("");

  if (detail.isLoading) return <Card>Loading board…</Card>;
  if (!detail.data) return <Card>Board not found.</Card>;
  const { board, entries } = detail.data;

  const ok = (message: string) => ({
    onSuccess: () => toast(message, "success"),
    onError: (err: unknown) => toast(errorMessage(err), "error"),
  });

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <StatusTag status={board.status} />
              <span className="text-xs text-muted-foreground">{board.category}</span>
              {board.sensitive && (
                <span className="rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-destructive uppercase">
                  {board.sensitiveApprovedBy ? "sensitive · approved" : "sensitive · needs approval"}
                </span>
              )}
            </div>
            <h2 className="mt-2 text-lg font-bold">{board.title}</h2>
            <p className="text-xs text-muted-foreground">
              /b/{board.slug} · {plural(entries.filter((e) => e.status === "active").length, "active entry", "active entries")}
              · created {timeAgo(board.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {board.status !== "live" && (
              <Button
                size="sm"
                disabled={setStatus.isPending}
                onClick={() => setStatus.mutate({ boardId, status: "live" }, ok("Board is live."))}
              >
                Publish
              </Button>
            )}
            {board.status === "live" && (
              <Button
                size="sm"
                variant="outline"
                disabled={setStatus.isPending}
                onClick={() =>
                  setStatus.mutate({ boardId, status: "frozen" }, ok("Board frozen — results final."))
                }
              >
                Freeze
              </Button>
            )}
            {board.status === "frozen" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setStatus.mutate({ boardId, status: "live" }, ok("Board reopened."))}
              >
                Reopen
              </Button>
            )}
            {board.sensitive && role === "owner" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  approve.mutate(
                    { boardId, approve: !board.sensitiveApprovedBy },
                    ok(board.sensitiveApprovedBy ? "Approval revoked." : "Sensitive board approved."),
                  )
                }
              >
                {board.sensitiveApprovedBy ? "Revoke approval" : "Approve sensitive"}
              </Button>
            )}
            {board.status === "draft" && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  if (!window.confirm(`Delete draft "${board.title}"? This cannot be undone.`)) return;
                  remove.mutate({ boardId }, ok("Draft deleted."));
                }}
              >
                Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" asChild>
              <Link href={board.status === "frozen" ? `/b/${board.slug}/results` : `/b/${board.slug}`}>
                View
              </Link>
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Board settings">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const closes = String(form.get("closesAt") ?? "");
              update.mutate(
                {
                  boardId,
                  title: String(form.get("title") ?? "").trim(),
                  category: String(form.get("category") ?? ""),
                  description: String(form.get("description") ?? "").trim() || null,
                  entryLimit: Number(form.get("entryLimit") ?? 10),
                  closesAt: closes ? new Date(closes).getTime() : null,
                },
                ok("Board updated."),
              );
            }}
          >
            <Field label="Title">
              <input
                aria-label="Board title"
                className={inputClass}
                name="title"
                defaultValue={board.title}
                minLength={4}
              />
            </Field>
            <Field label="Category">
              <select
                aria-label="Board category"
                className={inputClass}
                name="category"
                defaultValue={board.category}
              >
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Description">
              <textarea
                aria-label="Board description"
                className={`${inputClass} min-h-20`}
                name="description"
                defaultValue={board.description ?? ""}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Entry limit">
                <input
                  aria-label="Entry limit"
                  className={inputClass}
                  name="entryLimit"
                  type="number"
                  min={3}
                  max={100}
                  defaultValue={board.entryLimit}
                />
              </Field>
              <Field label="Closes at" hint="Leave empty for an open-ended board.">
                <input
                  aria-label="Board closing time"
                  className={inputClass}
                  name="closesAt"
                  type="datetime-local"
                  defaultValue={
                    board.closesAt
                      ? new Date(board.closesAt).toISOString().slice(0, 16)
                      : ""
                  }
                />
              </Field>
            </div>
            <Button type="submit" size="sm" disabled={update.isPending}>
              Save changes
            </Button>
          </form>
        </Card>

        <Card title="Seed entries">
          <p className="mb-3 text-xs text-muted-foreground">
            One per line: <code>Name, Subtitle, Image URL</code>. Duplicates are reported, never
            merged — the unique index on (board, normalised name) decides.
          </p>
          <textarea
            aria-label="Entries to seed, one per line"
            className={`${inputClass} min-h-40 font-mono text-xs`}
            value={csv}
            placeholder={"Asake, Afrobeats, https://…\nAyra Starr, Mavin Records,"}
            onChange={(e) => setCsv(e.target.value)}
          />
          <Button
            className="mt-3"
            size="sm"
            disabled={seed.isPending || !csv.trim()}
            onClick={() =>
              seed.mutate(
                { boardId, csv },
                {
                  onSuccess: (result) => {
                    toast(
                      `${result.added.length} added, ${result.skipped.length} skipped.`,
                      result.added.length ? "success" : "default",
                    );
                    if (result.skipped.length)
                      toast(
                        `Skipped: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`,
                      );
                    setCsv("");
                  },
                  onError: (err) => toast(errorMessage(err), "error"),
                },
              )
            }
          >
            {seed.isPending ? "Seeding…" : "Add entries"}
          </Button>
        </Card>
      </div>

      <Card title={`Entries (${entries.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] tracking-wide text-muted-foreground uppercase">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Subtitle</th>
                <th className="tabular py-2 pr-3 text-right">Votes</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Flags</th>
                <th className="py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-3">
                    <input
                      aria-label={`Name of ${entry.name}`}
                      className="w-full min-w-40 rounded border border-transparent bg-transparent px-1 py-1 hover:border-border focus:border-primary focus:outline-none"
                      defaultValue={entry.name}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        if (!name || name === entry.name) return;
                        updateEntry.mutate({ entryId: entry.id, name }, ok("Entry renamed."));
                      }}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      aria-label={`Subtitle of ${entry.name}`}
                      className="w-full min-w-32 rounded border border-transparent bg-transparent px-1 py-1 text-muted-foreground hover:border-border focus:border-primary focus:outline-none"
                      defaultValue={entry.subtitle ?? ""}
                      onBlur={(e) => {
                        const subtitle = e.target.value.trim();
                        if (subtitle === (entry.subtitle ?? "")) return;
                        updateEntry.mutate(
                          { entryId: entry.id, subtitle: subtitle || null },
                          ok("Entry updated."),
                        );
                      }}
                    />
                  </td>
                  <td className="tabular py-2 pr-3 text-right font-semibold">
                    {entry.votesEffective.toFixed(2)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      /{entry.votesRaw}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      aria-label={`Status of ${entry.name}`}
                      className="rounded border border-border bg-background px-1.5 py-1 text-xs"
                      value={entry.status}
                      disabled={entry.status === "merged"}
                      onChange={(e) =>
                        updateEntry.mutate(
                          {
                            entryId: entry.id,
                            status: e.target.value as "active" | "pending" | "hidden",
                          },
                          ok("Status changed; totals reconciled."),
                        )
                      }
                    >
                      {["active", "pending", "hidden"].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                      {entry.status === "merged" && <option value="merged">merged</option>}
                    </select>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {entry.claimed ? "claimed " : ""}
                    {entry.isSponsored ? "sponsored" : ""}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        updateEntry.mutate(
                          { entryId: entry.id, isSponsored: !entry.isSponsored },
                          ok(entry.isSponsored ? "Sponsor label removed." : "Marked sponsored."),
                        )
                      }
                    >
                      {entry.isSponsored ? "Unsponsor" : "Sponsor"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 rounded-xl border border-border bg-secondary/40 p-4">
          <h3 className="text-xs font-bold tracking-wide uppercase">Merge duplicate</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Votes move to the canonical entry; a voter holding both keeps one vote.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="Duplicate">
              <select
                aria-label="Duplicate entry to merge away"
                className={inputClass}
                value={mergeSource}
                onChange={(e) => setMergeSource(e.target.value)}
              >
                <option value="">Select…</option>
                {entries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Canonical">
              <select
                aria-label="Canonical entry to merge into"
                className={inputClass}
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
              >
                <option value="">Select…</option>
                {entries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              size="sm"
              variant="outline"
              disabled={!mergeSource || !mergeTarget || merge.isPending}
              onClick={() =>
                merge.mutate(
                  { sourceEntryId: mergeSource, targetEntryId: mergeTarget },
                  {
                    onSuccess: (result) => {
                      toast(`${result.moved} votes moved, ${result.dropped} dropped.`, "success");
                      setMergeSource("");
                      setMergeTarget("");
                    },
                    onError: (err) => toast(errorMessage(err), "error"),
                  },
                )
              }
            >
              Merge
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Boards({ role }: { role: string }) {
  const boards = useAdminBoards(true);
  const [selected, setSelected] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const rows = boards.data ?? [];
    const order: Record<string, number> = { live: 0, draft: 1, frozen: 2 };
    return [...rows].sort(
      (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.title.localeCompare(b.title),
    );
  }, [boards.data]);

  if (selected)
    return (
      <div className="space-y-4">
        <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
          ← All boards
        </Button>
        <BoardDetail boardId={selected} role={role} />
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold tracking-wide uppercase">
          {grouped.length} board{grouped.length === 1 ? "" : "s"}
        </h2>
        <CreateBoard onDone={setSelected} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {grouped.map((board: AdminBoard) => (
          <button
            key={board.id}
            type="button"
            onClick={() => setSelected(board.id)}
            className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50"
          >
            <div className="flex items-center gap-2">
              <StatusTag status={board.status} />
              <span className="text-xs text-muted-foreground">{board.category}</span>
            </div>
            <h3 className="mt-2 font-bold">{board.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {plural(board.entryCount, "entry", "entries")} · {plural(board.totalVotesEffective ?? 0, "weighted vote")}
            </p>
            {board.sensitive && !board.sensitiveApprovedBy && (
              <p className="mt-2 text-xs font-semibold text-destructive">Awaiting owner approval</p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ fraud */

function FlagDetail({ flagId }: { flagId: string }) {
  const detail = useFlagDetail(flagId);
  const voidVotes = useVoidVotes();
  const resolve = useResolveFlag();
  const toast = useToast();
  const [reason, setReason] = useState("");

  if (detail.isLoading) return <Card>Loading flag…</Card>;
  if (!detail.data) return <Card>Flag not found.</Card>;
  const { flag, voteCount, sample } = detail.data;

  return (
    <Card title={`${flag.type} · ${flag.severity}`}>
      <p className="text-sm">{flag.detail ?? "No detail recorded."}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Detected {dateTime(flag.detectedAt)} · {voteCount} votes in scope
      </p>

      <div className="mt-4 overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-xs">
          <thead className="bg-secondary/50">
            <tr className="text-left tracking-wide text-muted-foreground uppercase">
              <th className="px-2 py-2">Voter</th>
              <th className="px-2 py-2">Weight</th>
              <th className="px-2 py-2">IP</th>
              <th className="px-2 py-2">ASN</th>
              <th className="px-2 py-2">Device</th>
              <th className="px-2 py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {sample.slice(0, 25).map((vote) => (
              <tr key={vote.id} className="border-t border-border/60">
                <td className="px-2 py-1.5 font-mono">{vote.voterId.slice(0, 8)}</td>
                <td className="tabular px-2 py-1.5">{vote.weight}</td>
                <td className="px-2 py-1.5 font-mono">{vote.ip ?? "—"}</td>
                <td className="px-2 py-1.5">{vote.asn ?? "—"}</td>
                <td className="px-2 py-1.5 font-mono">{vote.deviceFp?.slice(0, 8) ?? "—"}</td>
                <td className="px-2 py-1.5">{timeAgo(vote.createdAt)}</td>
              </tr>
            ))}
            {sample.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-muted-foreground">
                  No votes attached to this flag.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
        <Field
          label="Reason for voiding"
          hint="Mandatory, at least 8 characters, written into the audit log. Voided votes stop counting but are never deleted."
        >
          <textarea
            aria-label="Reason for voiding these votes"
            className={`${inputClass} min-h-16`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="42 votes from one ASN within 3 minutes, no verified identities."
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="destructive"
            disabled={reason.trim().length < 8 || voidVotes.isPending}
            onClick={() => {
              if (!window.confirm(`Void ${voteCount} votes? Totals will be reconciled.`)) return;
              voidVotes.mutate(
                { flagId, reason: reason.trim() },
                {
                  onSuccess: (result) => {
                    toast(`${result.voided} votes voided.`, "success");
                    setReason("");
                  },
                  onError: (err) => toast(errorMessage(err), "error"),
                },
              );
            }}
          >
            Void {voteCount} votes
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              resolve.mutate(
                { flagId, resolution: "dismissed", note: reason.trim() || undefined },
                {
                  onSuccess: () => toast("Flag dismissed — no votes touched.", "success"),
                  onError: (err) => toast(errorMessage(err), "error"),
                },
              )
            }
          >
            Dismiss
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              resolve.mutate(
                { flagId, resolution: "monitoring", note: reason.trim() || undefined },
                {
                  onSuccess: () => toast("Flag set to monitoring.", "success"),
                  onError: (err) => toast(errorMessage(err), "error"),
                },
              )
            }
          >
            Monitor
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Fraud() {
  const [resolution, setResolution] = useState<"open" | "all">("open");
  const flags = useFlags(true, resolution);
  const [selected, setSelected] = useState<string | null>(null);
  const runJob = useRunJob();
  const toast = useToast();

  const rows = flags.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-full border border-border bg-card p-1">
          {(["open", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setResolution(value)}
              className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${
                resolution === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={runJob.isPending}
          onClick={() =>
            runJob.mutate(
              { job: "scan" },
              {
                onSuccess: (result) => toast(`Scan done: ${JSON.stringify(result)}`, "success"),
                onError: (err) => toast(errorMessage(err), "error"),
              },
            )
          }
        >
          Run scan now
        </Button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1.3fr]">
        <Card title={`${rows.length} flag${rows.length === 1 ? "" : "s"}`}>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing flagged. The scanner runs every 30 seconds and only ever flags — it never
              removes votes by itself.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((flag: AdminFlag) => (
                <li key={flag.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(flag.id)}
                    className={`w-full rounded-xl border p-3 text-left transition-colors ${
                      selected === flag.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{flag.type}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                          flag.severity === "high"
                            ? "bg-destructive/15 text-destructive"
                            : flag.severity === "medium"
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                              : "bg-secondary text-muted-foreground"
                        }`}
                      >
                        {flag.severity}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {flag.detail ?? "—"}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {flag.boardTitle ?? "board —"}
                      {flag.entryName ? ` · ${flag.entryName}` : ""} · {flag.votesInvolved} votes ·{" "}
                      {timeAgo(flag.detectedAt)}
                      {flag.resolution ? ` · ${flag.resolution}` : ""}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {selected ? (
          <FlagDetail flagId={selected} />
        ) : (
          <Card>
            <p className="text-sm text-muted-foreground">
              Pick a flag to read its evidence before acting. Voiding always needs a written reason
              and is recorded in the audit log.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ queue */

function Queue() {
  const moderation = useModeration(true);
  const reviewNomination = useReviewNomination();
  const reviewReport = useReviewReport();
  const reviewClaim = useReviewClaim();
  const toast = useToast();
  const data = moderation.data;

  const ok = (message: string) => ({
    onSuccess: () => toast(message, "success"),
    onError: (err: unknown) => toast(errorMessage(err), "error"),
  });

  if (moderation.isLoading) return <Card>Loading queue…</Card>;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card title={`Nominations (${data?.nominations.length ?? 0})`}>
        <ul className="space-y-3">
          {data?.nominations.map((nomination) => (
            <li key={nomination.id} className="rounded-xl border border-border p-3">
              <p className="font-semibold">{nomination.submittedName}</p>
              <p className="text-xs text-muted-foreground">
                {nomination.boardTitle ?? "—"} · {nomination.upvotes} upvotes ·{" "}
                {timeAgo(nomination.createdAt)}
                {nomination.screeningResult ? ` · ${nomination.screeningResult}` : ""}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    reviewNomination.mutate(
                      { nominationId: nomination.id, decision: "approved" },
                      ok("Added to the board."),
                    )
                  }
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    reviewNomination.mutate(
                      { nominationId: nomination.id, decision: "rejected" },
                      ok("Nomination rejected."),
                    )
                  }
                >
                  Reject
                </Button>
              </div>
            </li>
          ))}
          {!data?.nominations.length && (
            <p className="text-sm text-muted-foreground">Nothing pending.</p>
          )}
        </ul>
      </Card>

      <Card title={`Reports (${data?.reports.length ?? 0})`}>
        <ul className="space-y-3">
          {data?.reports.map((report) => (
            <li key={report.id} className="rounded-xl border border-border p-3">
              <p className="font-semibold">{report.entryName ?? "—"}</p>
              <p className="text-xs text-muted-foreground">
                {report.reason} · {timeAgo(report.createdAt)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    reviewReport.mutate(
                      { reportId: report.id, decision: "actioned", hideEntry: true },
                      ok("Entry hidden, totals reconciled."),
                    )
                  }
                >
                  Hide entry
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    reviewReport.mutate(
                      { reportId: report.id, decision: "actioned", hideEntry: false },
                      ok("Marked actioned."),
                    )
                  }
                >
                  Actioned
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    reviewReport.mutate(
                      { reportId: report.id, decision: "dismissed", hideEntry: false },
                      ok("Report dismissed."),
                    )
                  }
                >
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
          {!data?.reports.length && <p className="text-sm text-muted-foreground">Nothing pending.</p>}
        </ul>
      </Card>

      <Card title={`Claims (${data?.claims.length ?? 0})`}>
        <ul className="space-y-3">
          {data?.claims.map((claim) => (
            <li key={claim.id} className="rounded-xl border border-border p-3">
              <p className="font-semibold">{claim.entryName ?? "—"}</p>
              <p className="text-xs break-all text-muted-foreground">
                {claim.requestedPhone ?? "no contact"} · {timeAgo(claim.createdAt)}
              </p>
              {claim.evidenceUrl && (
                <a
                  href={claim.evidenceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 block text-xs break-all text-primary underline"
                >
                  {claim.evidenceUrl}
                </a>
              )}
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    reviewClaim.mutate(
                      { claimId: claim.id, decision: "approved" },
                      ok("Claim approved."),
                    )
                  }
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    reviewClaim.mutate(
                      { claimId: claim.id, decision: "rejected" },
                      ok("Claim rejected."),
                    )
                  }
                >
                  Reject
                </Button>
              </div>
            </li>
          ))}
          {!data?.claims.length && <p className="text-sm text-muted-foreground">Nothing pending.</p>}
        </ul>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ audit */

function Audit() {
  const log = useAuditLog(true);
  const [filter, setFilter] = useState("");
  const rows = (log.data ?? []).filter((row) =>
    filter ? row.action.toLowerCase().includes(filter.toLowerCase()) : true,
  );

  return (
    <Card
      title={`Audit log · ${rows.length}`}
      action={
        <input
          aria-label="Filter audit log by action"
          className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
          placeholder="Filter by action…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left tracking-wide text-muted-foreground uppercase">
              <th className="py-2 pr-3">When</th>
              <th className="py-2 pr-3">Action</th>
              <th className="py-2 pr-3">Actor</th>
              <th className="py-2 pr-3">Target</th>
              <th className="py-2">Metadata</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border/60 align-top last:border-0">
                <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                  {dateTime(row.createdAt)}
                </td>
                <td className="py-2 pr-3 font-mono font-semibold">{row.action}</td>
                <td className="py-2 pr-3 text-muted-foreground">
                  {row.actorKind ?? "system"}
                  {row.actorId ? ` · ${row.actorId.slice(0, 8)}` : ""}
                </td>
                <td className="py-2 pr-3 text-muted-foreground">
                  {row.targetType ?? "—"}
                  {row.targetId ? ` · ${row.targetId.slice(0, 8)}` : ""}
                </td>
                <td className="py-2 font-mono break-all text-muted-foreground">
                  {row.metadata ? JSON.stringify(row.metadata).slice(0, 160) : "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-muted-foreground">
                  No entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- console */

function Console({ me }: { me: { email: string; name: string | null; role: string } }) {
  const [tab, setTab] = useState<Tab>("Overview");
  const logout = useAdminLogout();
  const dashboard = useDashboard(true);
  const badges: Partial<Record<Tab, number>> = {
    Fraud: dashboard.data?.queues.flags ?? 0,
    Queue:
      (dashboard.data?.queues.nominations ?? 0) +
      (dashboard.data?.queues.reports ?? 0) +
      (dashboard.data?.queues.claims ?? 0),
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <Logo className="h-6" />
          </Link>
          <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase">
            Operator console
          </span>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {me.name || me.email} · {me.role}
            </span>
            <Button size="sm" variant="outline" onClick={() => logout.mutate()}>
              Sign out
            </Button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors ${
                tab === item
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary"
              }`}
            >
              {item}
              {badges[item] ? (
                <span className="tabular rounded-full bg-destructive px-1.5 text-[10px] font-bold text-white">
                  {badges[item]}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {tab === "Overview" && <Overview />}
        {tab === "Boards" && <Boards role={me.role} />}
        {tab === "Fraud" && <Fraud />}
        {tab === "Queue" && <Queue />}
        {tab === "Audit" && <Audit />}
      </main>
    </div>
  );
}

export default function AdminPage() {
  const status = useAdminStatus();

  if (status.isLoading)
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading console…
      </div>
    );

  const me = status.data?.me;
  if (!me) return <SignIn bootstrapped={status.data?.bootstrapped ?? true} />;
  return <Console me={me} />;
}
