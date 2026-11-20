// People in the workspace, their roles (as removable chips), invites and removal.
//
// The roles route replaces a member's roles in one scope (workspace-wide, or one project),
// so adding or removing a chip sends every key the member keeps in that scope. Changing
// roles, removing people and invites are for workspace admins; others see the list only.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Member, type ProjectSummary, type Role } from "../api";
import { ConfirmButton, CopyButton, Empty, ErrorNote, Field, Loading, timeAgo } from "../components/ui";
import { errorText, keys, useMembers, useMyPermissions, useProjects, useRoles, useWs } from "../queries";

function keysIn(member: Member, projectId: string | null): string[] {
  return member.roles.filter((r) => r.projectId === projectId).map((r) => r.key);
}

function scopeInput(roleKeys: string[], projectId: string | null) {
  return projectId === null ? { roleKeys } : { roleKeys, projectId };
}

function AddRole({
  member,
  roles,
  projects,
  onSave,
  onCancel,
}: {
  member: Member;
  roles: Role[];
  projects: ProjectSummary[];
  onSave: (roleKey: string, projectId: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [roleKey, setRoleKey] = useState("");
  const [where, setWhere] = useState("");
  return (
    <form
      className="inline-form"
      aria-label={`Add a role to ${member.displayName}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (roleKey) void onSave(roleKey, where === "" ? null : where);
      }}
    >
      <Field label="Role">
        <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
          <option value="" disabled>
            Choose a role
          </option>
          {roles.map((r) => (
            <option key={r.id} value={r.key}>
              {r.name} ({r.key})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Where">
        <select value={where} onChange={(e) => setWhere(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key} only
            </option>
          ))}
        </select>
      </Field>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={roleKey === ""}>
          Add
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function InvitePanel({ ws, roles, projects }: { ws: string; roles: Role[]; projects: ProjectSummary[] }) {
  const client = useQueryClient();
  const [chosen, setChosen] = useState<string[]>([]);
  const [where, setWhere] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Shown once: kept only in this component's state.
  const [link, setLink] = useState<string | null>(null);

  if (link) {
    return (
      <section className="once" aria-label="New invite link">
        <h2>Invite link</h2>
        <p>Send this link to the person you're inviting. It is shown only now and works once.</p>
        <div className="copy-row">
          <Field label="Invite link">
            <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <CopyButton text={link} label="Copy link" />
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setLink(null)}>
            Done
          </button>
        </div>
      </section>
    );
  }

  return (
    <form
      className="panel stack"
      aria-label="Invite people"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const ordered = roles.filter((r) => chosen.includes(r.key)).map((r) => r.key);
          const { code } = await api.createInvite(ws, where === "" ? { roleKeys: ordered } : { roleKeys: ordered, projectId: where });
          setLink(`${window.location.origin}/join/${encodeURIComponent(code)}`);
          setChosen([]);
          await client.invalidateQueries({ queryKey: keys.invites(ws) });
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Invite people</h2>
      <fieldset className="choices">
        <legend>Roles they get</legend>
        {roles.map((r) => (
          <label key={r.id} className="check">
            <input
              type="checkbox"
              checked={chosen.includes(r.key)}
              onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.key] : c.filter((k) => k !== r.key)))}
            />
            {r.name} <span className="muted">({r.key})</span>
          </label>
        ))}
      </fieldset>
      <Field label="Where">
        <select value={where} onChange={(e) => setWhere(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.key} only
            </option>
          ))}
        </select>
      </Field>
      <ErrorNote error={error} />
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Create invite link
        </button>
      </div>
    </form>
  );
}

export function Members() {
  const ws = useWs();
  const client = useQueryClient();
  const members = useMembers(ws);
  const roles = useRoles(ws);
  const projects = useProjects(ws);
  const isAdmin = useMyPermissions(ws).has("workspace.admin");
  const invites = useQuery({ queryKey: keys.invites(ws), queryFn: () => api.invites(ws), retry: false, enabled: isAdmin });
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeRoles = (roles.data ?? []).filter((r) => !r.archived);
  const projectList = projects.data ?? [];
  const projectKey = (id: string) => projectList.find((p) => p.id === id)?.key ?? "a project";

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await client.invalidateQueries({ queryKey: keys.members(ws) });
      await client.invalidateQueries({ queryKey: keys.roles(ws) });
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  const active = (members.data ?? []).filter((m) => m.status === "active");
  const former = (members.data ?? []).filter((m) => m.status === "removed");

  return (
    <div className="page">
      <h1>Members</h1>
      <p className="lede">Roles decide what each person, and each agent working for them, can do.</p>
      <ErrorNote error={error ?? (members.error ? errorText(members.error) : null)} />
      {members.isPending ? <Loading what="members" /> : null}

      <ul className="rows">
        {active.map((m) => (
          <li key={m.memberId} className="row row-wrap">
            <div className="row-main">
              <strong>{m.displayName}</strong>
              <div className="chips">
                {m.roles.length === 0 ? <span className="muted">No roles yet</span> : null}
                {m.roles.map((r) => (
                  <span key={`${r.key}-${r.projectId ?? "all"}`} className="chip">
                    {r.key}
                    {r.projectId ? <span className="chip-scope"> in {projectKey(r.projectId)}</span> : null}
                    {isAdmin ? (
                      <button
                        type="button"
                        className="chip-x"
                        aria-label={`Remove role ${r.key}${r.projectId ? ` in ${projectKey(r.projectId)}` : ""} from ${m.displayName}`}
                        onClick={() =>
                          void run(() =>
                            api.setMemberRoles(ws, m.memberId, scopeInput(keysIn(m, r.projectId).filter((k) => k !== r.key), r.projectId)),
                          )
                        }
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
              {isAdmin && adding === m.memberId ? (
                <AddRole
                  member={m}
                  roles={activeRoles}
                  projects={projectList}
                  onCancel={() => setAdding(null)}
                  onSave={async (roleKey, projectId) => {
                    const current = keysIn(m, projectId);
                    const next = current.includes(roleKey) ? current : [...current, roleKey];
                    if (await run(() => api.setMemberRoles(ws, m.memberId, scopeInput(next, projectId)))) setAdding(null);
                  }}
                />
              ) : null}
            </div>
            {isAdmin ? (
              <div className="row-actions">
                {adding !== m.memberId ? (
                  <button type="button" className="btn" aria-label={`Add role to ${m.displayName}`} onClick={() => setAdding(m.memberId)}>
                    Add role
                  </button>
                ) : null}
                <ConfirmButton
                  label="Remove member"
                  ariaLabel={`Remove ${m.displayName}`}
                  confirmLabel="Yes, remove"
                  onConfirm={() => void run(() => api.removeMember(ws, m.memberId))}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {former.length > 0 ? (
        <p className="muted">Former members: {former.map((m) => m.displayName).join(", ")}</p>
      ) : null}

      {isAdmin ? <InvitePanel ws={ws} roles={activeRoles} projects={projectList} /> : null}

      {isAdmin ? (
        <section>
          <h2>Pending invites</h2>
          <ErrorNote error={invites.error ? errorText(invites.error) : null} />
          {invites.data?.length === 0 ? <Empty>No invites waiting.</Empty> : null}
          <ul className="rows">
            {invites.data?.map((i) => (
              <li key={i.id} className="row">
                <div className="row-main">
                  <strong>{i.roleKeys.length > 0 ? i.roleKeys.join(", ") : "No roles"}</strong>
                  <span className="muted">
                    {i.projectId ? `${projectKey(i.projectId)} only` : "All projects"}; created by {i.createdByName}{" "}
                    {timeAgo(i.createdAt)}; expires {new Date(i.expiresAt).toLocaleDateString()}
                  </span>
                </div>
                <ConfirmButton
                  label="Revoke"
                  ariaLabel={`Revoke invite for ${i.roleKeys.join(", ") || "no roles"}`}
                  confirmLabel="Yes, revoke"
                  onConfirm={async () => {
                    setError(null);
                    try {
                      await api.revokeInvite(ws, i.id);
                      await client.invalidateQueries({ queryKey: keys.invites(ws) });
                    } catch (err) {
                      setError(errorText(err));
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="muted">Only workspace admins can change roles, remove people or invite someone.</p>
      )}
    </div>
  );
}
