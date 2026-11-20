// A workspace's projects and "New project".
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { Empty, ErrorNote, Field, Loading } from "../components/ui";
import { errorText, keys, useMe, useMyPermissions, useProjects, useWs } from "../queries";

function NewProject({ ws, onDone }: { ws: string; onDone: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const keyOk = /^[A-Z][A-Z0-9]{1,9}$/.test(key);
  return (
    <form
      className="panel stack"
      aria-label="New project"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const { id } = await api.createProject(ws, { key, name: name.trim() });
          await client.invalidateQueries({ queryKey: keys.projects(ws) });
          navigate(`/w/${ws}/p/${id}`);
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <h2>New project</h2>
      <div className="two">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <Field label="Key" hint="2 to 10 capitals or digits. Task numbers start with it, like WEB-12.">
          <input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} maxLength={10} autoComplete="off" />
        </Field>
      </div>
      <ErrorNote error={error} />
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!keyOk || name.trim() === ""}>
          Create project
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Workspace() {
  const ws = useWs();
  const me = useMe();
  const projects = useProjects(ws);
  const perms = useMyPermissions(ws);
  const [creating, setCreating] = useState(false);
  const name = me.data?.memberships.find((m) => m.workspaceId === ws)?.workspaceName ?? "Workspace";

  return (
    <div className="page">
      <div className="page-head">
        <h1>{name}</h1>
        {perms.has("workspace.admin") && !creating ? (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New project
          </button>
        ) : null}
      </div>
      {creating ? <NewProject ws={ws} onDone={() => setCreating(false)} /> : null}
      <ErrorNote error={projects.error ? errorText(projects.error) : null} />
      {projects.isPending ? <Loading what="projects" /> : null}
      {projects.data?.length === 0 ? (
        <Empty>
          {perms.has("workspace.admin")
            ? "No projects yet. Create the first one to start handing work over."
            : "You can't see any projects yet. Ask an admin to give you a role."}
        </Empty>
      ) : null}
      <ul className="projects">
        {projects.data?.map((p) => (
          <li key={p.id}>
            <Link to={`/w/${ws}/p/${p.id}`} className="project-link">
              <span className="ref">{p.key}</span>
              <span className="project-name">{p.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
