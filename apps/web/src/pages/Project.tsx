// One project: tasks by status, open blockers, the activity timeline and settings.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, type Project as ProjectData, type TaskStatus, type TaskView } from "../api";
import { Empty, ErrorNote, Field, Loading, Q, timeAgo } from "../components/ui";
import { errorText, keys, useMyPermissions, useRoles, useWs } from "../queries";
import { describeEvent, useTimeline } from "../timeline";
import { BlockerCard } from "./Inbox";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};
const STATUSES: TaskStatus[] = ["todo", "in_progress", "in_review", "done"];

function TaskRow({ ws, t }: { ws: string; t: TaskView }) {
  return (
    <li className="task">
      <Link to={`/w/${ws}/t/${t.id}`} className="task-link">
        <span className="ref">{t.ref}</span>
        <Q q={t.title} className="task-title" />
      </Link>
      <span className="task-meta">
        {t.blocked ? <span className="tag tag-blocked">Blocked</span> : null}
        <span className="muted">{t.ownerRole}</span>
      </span>
    </li>
  );
}

function NewTask({ ws, projectId, onDone }: { ws: string; projectId: string; onDone: () => void }) {
  const client = useQueryClient();
  const roles = useRoles(ws);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="panel stack"
      aria-label="New task"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api.createTask(ws, projectId, {
            title: title.trim(),
            ownerRoleId: owner,
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(branch.trim() ? { branch: branch.trim() } : {}),
          });
          await client.invalidateQueries({ queryKey: keys.tasks(ws, projectId) });
          onDone();
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <h2>New task</h2>
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={10_000} autoFocus />
      </Field>
      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={10_000} />
      </Field>
      <div className="two">
        <Field label="Owner role">
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="" disabled>
              Choose a role
            </option>
            {(roles.data ?? [])
              .filter((r) => !r.archived)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.key})
                </option>
              ))}
          </select>
        </Field>
        <Field label="Branch" hint="Optional. Agents on this branch get the task in their session context.">
          <input value={branch} onChange={(e) => setBranch(e.target.value)} maxLength={200} autoComplete="off" />
        </Field>
      </div>
      <ErrorNote error={error} />
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={title.trim() === "" || owner === ""}>
          Create task
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Timeline({ ws, projectId }: { ws: string; projectId: string }) {
  const { events, error } = useTimeline(ws, projectId);
  const newestFirst = [...events].reverse();
  return (
    <section className="timeline" aria-label="Activity">
      <h2>Activity</h2>
      <p className="muted small">The last 7 days. Updates every 15 seconds while this tab is open.</p>
      <ErrorNote error={error} />
      {newestFirst.length === 0 && !error ? <Empty>No activity yet.</Empty> : null}
      <ol className="thread">
        {newestFirst.map((e) => {
          const { who, what } = describeEvent(e);
          return (
            <li key={e.id} className={`thread-item thread-${e.actorKind}`}>
              <span className="thread-text">
                {who} {what}
              </span>
              <time dateTime={e.createdAt} className="muted small" title={new Date(e.createdAt).toLocaleString()}>
                {timeAgo(e.createdAt)}
              </time>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Settings({ ws, project }: { ws: string; project: ProjectData }) {
  const client = useQueryClient();
  const [repos, setRepos] = useState(project.repoUrls.join("\n"));
  const [kind, setKind] = useState<"mattermost" | "slack">("mattermost");
  const [webhook, setWebhook] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const save = async (patch: Parameters<typeof api.updateProjectConfig>[2], message: string) => {
    setError(null);
    setSaved(null);
    try {
      await api.updateProjectConfig(ws, project.id, patch);
      await client.invalidateQueries({ queryKey: keys.project(ws, project.id) });
      setSaved(message);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  return (
    <details className="panel settings">
      <summary>Project settings</summary>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const repoUrls = repos.split("\n").map((s) => s.trim()).filter((s) => s !== "");
          void save({ repoUrls }, "Repositories saved");
        }}
      >
        <Field label="Repositories" hint="One URL per line. Agents working in these repositories get this project's context.">
          <textarea value={repos} onChange={(e) => setRepos(e.target.value)} rows={3} spellCheck={false} />
        </Field>
        <div className="actions">
          <button type="submit" className="btn">
            Save repositories
          </button>
        </div>
      </form>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await save({ notifier: { kind, webhookUrl: webhook.trim() } }, "Chat webhook saved")) setWebhook("");
        }}
      >
        <h3>Chat notifications</h3>
        <p className="muted">
          {project.notifier
            ? `Posting to a ${project.notifier.kind} channel. Enter a new webhook to replace it.`
            : "Not set up. Handoffs and blockers can be announced in a Mattermost or Slack channel."}
        </p>
        <div className="two">
          <Field label="Chat service">
            <select value={kind} onChange={(e) => setKind(e.target.value as "mattermost" | "slack")}>
              <option value="mattermost">Mattermost</option>
              <option value="slack">Slack</option>
            </select>
          </Field>
          <Field label="Incoming webhook URL" hint="Stored on the server and never shown again.">
            <input value={webhook} onChange={(e) => setWebhook(e.target.value)} type="url" autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <div className="actions">
          <button type="submit" className="btn" disabled={webhook.trim() === ""}>
            Save webhook
          </button>
          {project.notifier ? (
            <button type="button" className="btn btn-quiet" onClick={() => void save({ notifier: null }, "Chat notifications turned off")}>
              Turn off
            </button>
          ) : null}
        </div>
      </form>
      <ErrorNote error={error} />
      {saved ? (
        <p className="muted" role="status">
          {saved}
        </p>
      ) : null}
    </details>
  );
}

export function Project() {
  const ws = useWs();
  const { projectId = "" } = useParams();
  const project = useQuery({ queryKey: keys.project(ws, projectId), queryFn: () => api.project(ws, projectId) });
  const tasks = useQuery({ queryKey: keys.tasks(ws, projectId), queryFn: () => api.tasks(ws, projectId) });
  const blockers = useQuery({ queryKey: keys.blockers(ws, projectId), queryFn: () => api.blockers(ws, projectId, "open") });
  const perms = useMyPermissions(ws, projectId);
  const [creating, setCreating] = useState(false);

  if (project.error) {
    return (
      <div className="page">
        <ErrorNote error={errorText(project.error)} />
      </div>
    );
  }
  const byStatus = (s: TaskStatus) => (tasks.data ?? []).filter((t) => t.status === s);

  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>
          {project.data?.name ?? "Project"} {project.data ? <span className="ref">{project.data.key}</span> : null}
        </h1>
        {perms.has("task.write") && !creating ? (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New task
          </button>
        ) : null}
      </div>
      {creating ? <NewTask ws={ws} projectId={projectId} onDone={() => setCreating(false)} /> : null}

      <div className="project-grid">
        <div className="project-main">
          <ErrorNote error={tasks.error ? errorText(tasks.error) : null} />
          {tasks.isPending ? <Loading what="tasks" /> : null}
          {tasks.data?.length === 0 ? <Empty>No tasks yet.</Empty> : null}
          {tasks.data && tasks.data.length > 0 ? (
            <div className="board">
              {STATUSES.map((s) => {
                const list = byStatus(s);
                return (
                  <section key={s} className={`column column-${s}`} aria-label={STATUS_LABEL[s]}>
                    <h2>
                      {STATUS_LABEL[s]} <span className="muted">{list.length}</span>
                    </h2>
                    <ul className="tasks">
                      {list.map((t) => (
                        <TaskRow key={t.id} ws={ws} t={t} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          ) : null}

          <section aria-label="Open blockers">
            <h2>Open blockers</h2>
            {blockers.data?.length === 0 ? <Empty>Nothing is blocked.</Empty> : null}
            {blockers.data?.map((b) => (
              <BlockerCard key={b.id} ws={ws} b={b} />
            ))}
          </section>

          {project.data && perms.has("workspace.admin") ? <Settings ws={ws} project={project.data} /> : null}
        </div>
        <aside className="project-side">
          <Timeline ws={ws} projectId={projectId} />
        </aside>
      </div>
    </div>
  );
}
