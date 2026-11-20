// Chat notifications: pointer-only messages posted to a project's webhook. Never throws to callers.
import { eq } from "drizzle-orm";
import { type Db, withWorkspace } from "../db/client.js";
import { events, projectConfig } from "../db/schema.js";
import { newId } from "../ids.js";
import type { NotifierConfig } from "../projects.js";
import { mattermostNotifier } from "./mattermost.js";
import { NotifyError } from "./post.js";
import { slackNotifier } from "./slack.js";

export interface Notifier {
  send(message: { text: string; link?: string }): Promise<void>;
}

export function createNotifier(config: NotifierConfig, fetchImpl: typeof fetch = globalThis.fetch): Notifier {
  // Resolved at send time so a missing global fetch surfaces as a failure, not at construction.
  const f: typeof fetch = (...a) => fetchImpl(...a);
  return config.kind === "slack" ? slackNotifier(config.webhookUrl, f) : mattermostNotifier(config.webhookUrl, f);
}

/**
 * Sends to the project's configured notifier, if any. This is the only reader of the webhook
 * URL. Failures never throw; they record a `notify.failed` system event holding only the
 * status and reason, never the URL or the message.
 */
export async function notifyProject(
  db: Db,
  workspaceId: string,
  projectId: string,
  message: { text: string; link?: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  try {
    const config = await withWorkspace(db, workspaceId, async (tx) => {
      const [row] = await tx
        .select({ notifier: projectConfig.notifier })
        .from(projectConfig)
        .where(eq(projectConfig.projectId, projectId));
      return row?.notifier ?? null;
    });
    if (!config) return;
    let data: Record<string, unknown> | null = null;
    try {
      await createNotifier(config, fetchImpl).send(message);
    } catch (err) {
      data =
        err instanceof NotifyError
          ? { reason: err.reason, ...(err.status === undefined ? {} : { status: err.status }) }
          : { reason: "network_error" };
    }
    if (data) {
      const failure = data;
      await withWorkspace(db, workspaceId, (tx) =>
        tx.insert(events).values({
          id: newId(),
          workspaceId,
          projectId,
          actorKind: "system",
          actorId: projectId,
          type: "notify.failed",
          subjectKind: "project",
          subjectId: projectId,
          data: failure,
        }),
      );
    }
  } catch {
    // Notification is best effort; a database problem here must not fail the caller.
  }
}

/** A display name made safe for a chat line: control characters removed, length capped. */
function safeName(s: string): string {
  // Control and format characters (bidi, zero-width) become spaces; @ < > are dropped so a
  // name cannot trigger a chat mention or markup, and Markdown link and emphasis characters
  // ([ ] ( ) * _ ~ `) are dropped so it cannot render as a link or formatting.
  const t = s
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[@<>[\]()*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(t);
  return chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : t;
}

export function handoffMessage(view: { ref: string; fromName: string; toRoleName: string; unassigned: boolean }): string {
  const base = `Handoff on ${safeName(view.ref)} from ${safeName(view.fromName)} to ${safeName(view.toRoleName)}.`;
  return view.unassigned ? `${base} Nobody holds that role yet.` : base;
}

export function blockerMessage(view: { ref?: string; ownerRoleName: string }): string {
  const owner = safeName(view.ownerRoleName);
  return view.ref ? `Blocker on ${safeName(view.ref)}, owned by ${owner}.` : `Blocker raised, owned by ${owner}.`;
}
