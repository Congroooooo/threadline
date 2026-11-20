// "/" and first-run screens: where a signed-in person lands, creating a first workspace,
// or (when this deployment limits who may create one) asking for an invite link.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { LOGO_SRC, NAME } from "../brand";
import { ErrorNote, Field } from "../components/ui";
import { errorText, keys, useMe } from "../queries";
import { pendingInvite } from "./Join";

const LAST_WORKSPACE = "threadline.lastWorkspace";

export function rememberWorkspace(ws: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE, ws);
  } catch {
    // A convenience only.
  }
}

function lastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE);
  } catch {
    return null;
  }
}

export function Home() {
  const [params] = useSearchParams();
  const me = useMe();
  if (params.get("signin") === "failed") return <Navigate to="/signin?signin=failed" replace />;
  const invite = pendingInvite();
  if (invite) return <Navigate to={`/join/${encodeURIComponent(invite)}`} replace />;
  if (me.isPending) return <p className="center muted">Loading…</p>;
  if (me.error || !me.data) {
    return (
      <div className="center">
        <ErrorNote error={errorText(me.error)} />
      </div>
    );
  }
  const memberships = me.data.memberships;
  if (memberships.length === 0) return <Navigate to={me.data.mayCreateWorkspaces ? "/new" : "/welcome"} replace />;
  const last = lastWorkspace();
  const target = memberships.find((m) => m.workspaceId === last) ?? memberships[0]!;
  return <Navigate to={`/w/${target.workspaceId}`} replace />;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="signin">
      <div className="signin-card signin-card-left">
        <img src={LOGO_SRC} alt={NAME} className="signin-logo signin-logo-small" width={44} height={41} />
        {children}
      </div>
    </main>
  );
}

export function NewWorkspace() {
  const me = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (me.data && !me.data.mayCreateWorkspaces) return <Navigate to="/welcome" replace />;
  return (
    <Frame>
      <h1>Create a workspace</h1>
      <p>A workspace holds your team's projects, people and roles. You will be its first admin.</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const { workspaceId } = await api.createWorkspace(name.trim());
            await client.invalidateQueries({ queryKey: keys.me });
            navigate(`/w/${workspaceId}`);
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Workspace name" hint="Usually your team or company name.">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <ErrorNote error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy || name.trim() === ""}>
          Create workspace
        </button>
      </form>
    </Frame>
  );
}

/** The code from a pasted invite link (…/join/<code>) or a bare code. */
export function inviteCodeFrom(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  const match = /\/join\/([^/?#\s]+)/.exec(text);
  if (match) return decodeURIComponent(match[1]!);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : null;
}

export function Welcome() {
  const navigate = useNavigate();
  const [link, setLink] = useState("");
  const code = inviteCodeFrom(link);
  return (
    <Frame>
      <h1>You're signed in</h1>
      <p>
        You're not in a workspace yet. Ask someone on your team for an invite link and open it, or paste it here.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (code) navigate(`/join/${encodeURIComponent(code)}`);
        }}
      >
        <Field label="Invite link">
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/join/…" />
        </Field>
        <button type="submit" className="btn btn-primary" disabled={!code}>
          Join
        </button>
      </form>
    </Frame>
  );
}
