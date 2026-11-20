// The bar on every signed-in page: logo and name, workspace switcher, navigation with the
// Inbox count, and sign-out. WorkspaceLayout wraps every /w/:ws page in it.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { api } from "../api";
import { LOGO_SRC, NAME } from "../brand";
import { rememberWorkspace } from "../pages/Start";
import { useInbox, useMe, useWs } from "../queries";

export function Header() {
  const ws = useWs();
  const me = useMe();
  const inbox = useInbox(ws);
  const navigate = useNavigate();
  const client = useQueryClient();
  const memberships = me.data?.memberships ?? [];

  const signOut = async () => {
    try {
      await api.signOut();
    } finally {
      client.clear();
      window.location.assign("/signin");
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <NavLink to={`/w/${ws}`} end className="brand" aria-label={`${NAME} home`}>
          <img src={LOGO_SRC} alt="" width={28} height={26} />
          <span className="brand-name">{NAME}</span>
        </NavLink>
        <label className="switcher">
          <span className="sr-only">Workspace</span>
          <select
            value={ws}
            onChange={(e) => {
              if (e.target.value === "__new") navigate("/new");
              else navigate(`/w/${e.target.value}`);
            }}
          >
            {memberships.map((m) => (
              <option key={m.workspaceId} value={m.workspaceId}>
                {m.workspaceName}
              </option>
            ))}
            {me.data?.mayCreateWorkspaces ? <option value="__new">New workspace…</option> : null}
          </select>
        </label>
        <nav className="nav" aria-label="Workspace">
          <NavLink to={`/w/${ws}`} end>
            Projects
          </NavLink>
          <NavLink to={`/w/${ws}/inbox`}>
            Inbox
            {inbox.count > 0 ? (
              <span className="count" aria-label={`${inbox.count} waiting`}>
                {inbox.count}
              </span>
            ) : null}
          </NavLink>
          <NavLink to={`/w/${ws}/members`}>Members</NavLink>
          <NavLink to={`/w/${ws}/roles`}>Roles</NavLink>
          <NavLink to={`/w/${ws}/tokens`}>Tokens</NavLink>
        </nav>
        <div className="me">
          <span className="me-name">{me.data?.user.displayName}</span>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

export function WorkspaceLayout() {
  const ws = useWs();
  const me = useMe();
  useEffect(() => rememberWorkspace(ws), [ws]);
  const member = me.data?.memberships.some((m) => m.workspaceId === ws);
  return (
    <>
      <Header />
      <main className="main">
        {me.data && !member ? (
          <div className="page">
            <h1>Not in this workspace</h1>
            <p>You're not a member of this workspace. Pick one of yours from the switcher, or ask its admin for an invite.</p>
          </div>
        ) : (
          <Outlet />
        )}
      </main>
    </>
  );
}
