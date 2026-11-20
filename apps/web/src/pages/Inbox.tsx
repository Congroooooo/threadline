// Everything waiting on the signed-in person: pending handoffs to their roles and open
// blockers their roles own, across every project they can read.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type BlockerView, type HandoffView } from "../api";
import { EvidenceList, ErrorNote, Empty, Field, Loading, Q, timeAgo } from "../components/ui";
import { errorText, keys, useInbox, useWs } from "../queries";

function HandoffCard({ ws, projectId, h }: { ws: string; projectId: string; h: HandoffView }) {
  const client = useQueryClient();
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (input: { response: "accepted" } | { response: "needs_changes"; note: string }) => {
    setBusy(true);
    setError(null);
    try {
      await api.respondToHandoff(ws, h.id, input);
      await client.invalidateQueries({ queryKey: keys.openItems(ws, projectId) });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const trimmed = note.trim();
  return (
    <article className="item item-handoff" aria-label={`Handoff on ${h.taskRef}`}>
      <header className="item-head">
        <span className="ref">{h.taskRef}</span>
        <span className="muted">
          from <Q q={h.from} /> to {h.toRole}, {timeAgo(h.createdAt)}
        </span>
      </header>
      <dl className="handoff-body">
        <dt>Delivered</dt>
        <dd>
          <Q q={h.delivered} className="prose" />
        </dd>
        <dt>Asked of you</dt>
        <dd>
          <Q q={h.requiredAction} className="prose" />
        </dd>
        {h.knownLimits ? (
          <>
            <dt>Known limits</dt>
            <dd>
              <Q q={h.knownLimits} className="prose" />
            </dd>
          </>
        ) : null}
      </dl>
      <EvidenceList items={h.evidence} />
      <ErrorNote error={error} />
      {returning ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed) void respond({ response: "needs_changes", note: trimmed });
          }}
        >
          <Field label="What needs to change?">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={10_000} autoFocus />
          </Field>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy || trimmed === ""}>
              Send back
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setReturning(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void respond({ response: "accepted" })}>
            Accept
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setReturning(true)}>
            Needs changes
          </button>
        </div>
      )}
    </article>
  );
}

export function BlockerCard({ ws, b }: { ws: string; b: BlockerView }) {
  const client = useQueryClient();
  const [resolving, setResolving] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  return (
    <article className="item item-blocker" aria-label={b.taskRef ? `Blocker on ${b.taskRef}` : "Project blocker"}>
      <header className="item-head">
        <span className="ref">{b.taskRef ?? "Project"}</span>
        <span className="muted">
          owned by {b.ownerRole}, {timeAgo(b.createdAt)}
        </span>
      </header>
      <p className="prose">
        <Q q={b.observed} />
      </p>
      {b.cause ? (
        <p className="muted">
          Cause ({b.causeStatus}): <Q q={b.cause} />
        </p>
      ) : null}
      <ErrorNote error={error} />
      {b.status === "open" &&
        (resolving ? (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!trimmed) return;
              try {
                await api.resolveBlocker(ws, b.id, trimmed);
                // Open items, the project's blocker list and task "blocked" markers all change.
                await client.invalidateQueries({ queryKey: [ws] });
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            <Field label="How was it resolved?">
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={10_000} autoFocus />
            </Field>
            <div className="actions">
              <button type="submit" className="btn btn-primary" disabled={trimmed === ""}>
                Resolve
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => setResolving(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="actions">
            <button type="button" className="btn" onClick={() => setResolving(true)}>
              Resolve
            </button>
          </div>
        ))}
    </article>
  );
}

export function Inbox() {
  const ws = useWs();
  const inbox = useInbox(ws);
  const withItems = inbox.sections.filter((s) => s.query.data && (s.query.data.handoffs.length > 0 || s.query.data.blockers.length > 0));

  return (
    <div className="page">
      <h1>Inbox</h1>
      <p className="lede">Handoffs sent to your roles and blockers your roles own.</p>
      <ErrorNote error={inbox.error ? errorText(inbox.error) : null} />
      {inbox.loading && withItems.length === 0 ? <Loading what="your inbox" /> : null}
      {!inbox.loading && withItems.length === 0 && !inbox.error ? <Empty>Nothing is waiting on you.</Empty> : null}
      {withItems.map(({ project, query }) => (
        <section key={project.id} className="inbox-project">
          <h2>
            <Link to={`/w/${ws}/p/${project.id}`}>{project.name}</Link> <span className="ref">{project.key}</span>
          </h2>
          {query.data!.handoffs.map((h) => (
            <HandoffCard key={h.id} ws={ws} projectId={project.id} h={h} />
          ))}
          {query.data!.blockers.map((b) => (
            <BlockerCard key={b.id} ws={ws} b={b} />
          ))}
        </section>
      ))}
    </div>
  );
}
