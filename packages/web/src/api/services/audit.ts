import { db } from "../database";
import * as schema from "../database/schema";

type Actor = { id?: string | null; kind: "system" | "voter" | "admin" };

export interface AuditEntry {
  actor?: Actor;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Writes one immutable audit row. Never throws into the caller's path. */
export async function audit(entry: AuditEntry, tx: typeof db | Tx = db) {
  try {
    await tx.insert(schema.auditLog).values({
      actor: entry.actor?.id ?? null,
      actorKind: entry.actor?.kind ?? "system",
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    console.error("[audit] failed to write", entry.action, err);
  }
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Fire-and-forget product event (§9 instrumentation). */
export async function track(
  name: string,
  props: {
    boardId?: string | null;
    entryId?: string | null;
    voterId?: string | null;
    sessionKey?: string | null;
    referrer?: string | null;
    [key: string]: unknown;
  } = {},
) {
  const { boardId, entryId, voterId, sessionKey, referrer, ...rest } = props;
  try {
    await db.insert(schema.events).values({
      name,
      boardId: boardId ?? null,
      entryId: entryId ?? null,
      voterId: voterId ?? null,
      sessionKey: sessionKey ?? null,
      referrer: referrer ?? null,
      props: Object.keys(rest).length ? rest : null,
    });
  } catch (err) {
    console.error("[track] failed", name, err);
  }
}
