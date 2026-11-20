// One task: description, dependencies, progress notes, evidence, handoffs and blockers.
// "Mark done" is shown only to people holding task.accept in the task's project.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, type TaskStatus } from "../api";
import { Empty, ErrorNote, EvidenceList, Field, Loading, Q, timeAgo } from "../components/ui";
import { errorText, keys, useMyPermissions, useProjects, useWs } from "../queries";
import { BlockerCard } from "./Inbox";
import { STATUS_LABEL } from "./Project";

const HANDOFF_STATUS = { pending: "Waiting for an answer", accepted: "Accepted", needs_changes: "Sent back" } as const;

export function Task() {
  const ws = useWs();
  const { taskId = "" } = useParams();
  const client = useQueryClient();
  const ctx = useQuery({ queryKey: keys.task(ws, taskId), queryFn: () => api.task(ws, taskId) });
  const projects = useProjects(ws);
  // Refs are `<project key>-<number>` and keys are unique in a workspace.
  const projectKey = ctx.data?.task.ref.replace(/-\d+$/, "");
  const project = projects.data?.find((p) => p.key === projectKey);
  const perms = useMyPermissions(ws, project?.id);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: keys.task(ws, taskId) });
    if (project) await client.invalidateQueries({ queryKey: keys.tasks(ws, project.id) });
  };
  const setStatus = async (status: TaskStatus) => {
    setError(null);
    try {
      await api.setTaskStatus(ws, taskId, status);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (ctx.isPending) return <div className="page"><Loading what="the task" /></div>;
  if (ctx.error || !ctx.data) return <div className="page"><ErrorNote error={errorText(ctx.error)} /></div>;
  const { task, dependencies, blockedBy, handoffs, blockers, progress, evidence } = ctx.data;
  const canWrite = perms.has("task.write");

  return (
    <div className="page">
      {project ? (
        <p className="crumb">
          <Link to={`/w/${ws}/p/${project.id}`}>{project.name}</Link>
        </p>
      ) : null}
      <h1 className="task-heading">
        <span className="ref">{task.ref}</span> <Q q={task.title} />
      </h1>
      <p className="task-facts">
        <span className={`tag tag-${task.status}`}>{STATUS_LABEL[task.status]}</span>
        {task.blocked ? <span className="tag tag-blocked">Blocked</span> : null}
        <span className="muted">Owned by {task.ownerRole}</span>
        {task.branch ? <code className="perm">{task.branch}</code> : null}
      </p>

      <div className="actions">
        {canWrite && task.status !== "done"
          ? (["todo", "in_progress", "in_review"] as const)
              .filter((s) => s !== task.status)
              .map((s) => (
                <button key={s} type="button" className="btn" onClick={() => void setStatus(s)}>
                  Move to “{STATUS_LABEL[s]}”
                </button>
              ))
          : null}
        {perms.has("task.accept") && task.status !== "done" ? (
          <button type="button" className="btn btn-primary" onClick={() => void setStatus("done")}>
            Mark done
          </button>
        ) : null}
        {perms.has("task.accept") && task.status === "done" ? (
          <button type="button" className="btn" onClick={() => void setStatus("in_review")}>
            Reopen
          </button>
        ) : null}
      </div>
      <ErrorNote error={error} />

      {task.description ? (
        <section>
          <h2>Description</h2>
          <p className="prose">
            <Q q={task.description} />
          </p>
        </section>
      ) : null}

      {dependencies.length > 0 ? (
        <section>
          <h2>Depends on</h2>
          <ul className="rows">
            {dependencies.map((d) => (
              <li key={d.id} className="row">
                <Link to={`/w/${ws}/t/${d.id}`}>
                  <span className="ref">{d.ref}</span> <Q q={d.title} />
                </Link>
                <span className="tag">{STATUS_LABEL[d.status]}</span>
              </li>
            ))}
          </ul>
          {blockedBy.dependencies.length > 0 ? (
            <p className="muted">Waiting on {blockedBy.dependencies.join(", ")}.</p>
          ) : null}
        </section>
      ) : null}

      <section>
        <h2>Progress</h2>
        {progress.length === 0 ? <Empty>No progress notes yet.</Empty> : null}
        <ol className="notes">
          {progress.map((n) => (
            <li key={n.id} className="note">
              <span className="muted small">
                <Q q={n.by} />, {timeAgo(n.createdAt)}
              </span>
              <p className="prose">
                <Q q={n.note} />
              </p>
            </li>
          ))}
        </ol>
        {canWrite ? (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await api.reportProgress(ws, taskId, { note: note.trim() });
                setNote("");
                await refresh();
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            <Field label="Add a progress note">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={10_000} />
            </Field>
            <div className="actions">
              <button type="submit" className="btn" disabled={note.trim() === ""}>
                Add note
              </button>
            </div>
          </form>
        ) : null}
      </section>

      {evidence.length > 0 ? (
        <section>
          <h2>Evidence</h2>
          <EvidenceList items={evidence} />
        </section>
      ) : null}

      <section>
        <h2>Handoffs</h2>
        {handoffs.length === 0 ? <Empty>No handoffs on this task.</Empty> : null}
        {handoffs.map((h) => (
          <article key={h.id} className="item item-handoff">
            <header className="item-head">
              <span className="tag">{HANDOFF_STATUS[h.status]}</span>
              <span className="muted">
                from <Q q={h.from} /> to {h.toRole}
                {h.unassigned ? " (nobody holds this role)" : ""}, {timeAgo(h.createdAt)}
              </span>
            </header>
            <dl className="handoff-body">
              <dt>Delivered</dt>
              <dd>
                <Q q={h.delivered} className="prose" />
              </dd>
              <dt>Asked</dt>
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
          </article>
        ))}
      </section>

      {blockers.length > 0 ? (
        <section>
          <h2>Blockers</h2>
          {blockers.map((b) => (
            <BlockerCard key={b.id} ws={ws} b={b} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
