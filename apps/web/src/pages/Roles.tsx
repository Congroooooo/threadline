// Roles and their permissions: create, rename, change permissions, archive and restore.
// Changing roles is for workspace admins; everyone else sees them read-only.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type Role } from "../api";
import { ErrorNote, Field, Loading } from "../components/ui";
import { HUMAN_ONLY, type Permission, PERMISSION_LABELS, PERMISSIONS } from "../permissions";
import { errorText, keys, useMyPermissions, useRoles, useWs } from "../queries";

/** Same permissions, whatever the order. */
function samePermissions(a: readonly Permission[], b: readonly Permission[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((p) => set.has(p));
}

function PermissionBoxes({
  value,
  onChange,
  disabled,
}: {
  value: Permission[];
  onChange: (next: Permission[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="permissions" disabled={disabled}>
      <legend>Permissions</legend>
      {PERMISSIONS.map((p) => (
        <label key={p} className="check">
          <input
            type="checkbox"
            checked={value.includes(p)}
            // Kept in PERMISSIONS order, so the request lists exactly what is ticked.
            onChange={(e) => onChange(PERMISSIONS.filter((x) => (x === p ? e.target.checked : value.includes(x))))}
          />
          <span>
            {PERMISSION_LABELS[p]} <code className="perm">{p}</code>
            {HUMAN_ONLY.includes(p) ? <span className="human-only">people only, never agents</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function RoleForm({ ws, role, canEdit }: { ws: string; role: Role; canEdit: boolean }) {
  const client = useQueryClient();
  const [name, setName] = useState(role.name);
  const [permissions, setPermissions] = useState<Permission[]>(role.permissions);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The form stays mounted across refetches (so "Saved" survives the refetch after saving);
  // when the stored role changes, the fields follow it.
  const storedPermissions = role.permissions.join();
  useEffect(() => {
    setName(role.name);
    setPermissions(role.permissions);
    // role.permissions is a new array on every refetch; storedPermissions tracks its content.
  }, [role.name, storedPermissions]);

  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    setSaved(false);
    try {
      await work();
      await client.invalidateQueries({ queryKey: keys.roles(ws) });
      await client.invalidateQueries({ queryKey: keys.members(ws) });
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  const changed = name !== role.name || !samePermissions(permissions, role.permissions);
  const locked = role.archived || !canEdit;
  return (
    <form
      className={role.archived ? "panel role role-archived" : "panel role"}
      aria-label={`Role ${role.key}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api.updateRole(ws, role.id, { name: name.trim(), permissions }))) setSaved(true);
      }}
    >
      <header className="role-head">
        <h2>
          {role.name} <code className="perm">{role.key}</code>
        </h2>
        <span className="muted">
          {role.memberCount === 1 ? "1 member" : `${role.memberCount} members`}
          {role.archived ? "; archived" : ""}
        </span>
      </header>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          maxLength={200}
          disabled={locked}
        />
      </Field>
      <PermissionBoxes
        value={permissions}
        onChange={(next) => {
          setPermissions(next);
          setSaved(false);
        }}
        disabled={locked}
      />
      <ErrorNote error={error} />
      {canEdit ? (
        <div className="actions">
          {role.archived ? (
            <button type="button" className="btn" onClick={() => void run(() => api.restoreRole(ws, role.id))}>
              Restore
            </button>
          ) : (
            <>
              <button type="submit" className="btn btn-primary" disabled={!changed || name.trim() === ""}>
                Save
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => void run(() => api.archiveRole(ws, role.id))}>
                Archive
              </button>
              {saved ? <span className="muted" role="status">Saved</span> : null}
            </>
          )}
        </div>
      ) : null}
    </form>
  );
}

function NewRole({ ws }: { ws: string }) {
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const keyOk = /^[a-z][a-z0-9_]{1,30}$/.test(key);
  return (
    <form
      className="panel role"
      aria-label="New role"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api.createRole(ws, { key, name: name.trim(), permissions });
          setKey("");
          setName("");
          setPermissions([]);
          await client.invalidateQueries({ queryKey: keys.roles(ws) });
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <h2>New role</h2>
      <div className="two">
        <Field label="Key" hint="Lower case letters, digits and _, starting with a letter. Cannot be changed later.">
          <input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} maxLength={31} autoComplete="off" />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
      </div>
      <PermissionBoxes value={permissions} onChange={setPermissions} />
      <ErrorNote error={error} />
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!keyOk || name.trim() === ""}>
          Create role
        </button>
      </div>
    </form>
  );
}

export function Roles() {
  const ws = useWs();
  const roles = useRoles(ws);
  const isAdmin = useMyPermissions(ws).has("workspace.admin");
  const list = roles.data ?? [];
  const active = list.filter((r) => !r.archived);
  const archived = list.filter((r) => r.archived);
  return (
    <div className="page">
      <h1>Roles</h1>
      <p className="lede">
        Agents act with their person's roles, except for the permissions marked “people only, never agents”.
      </p>
      <ErrorNote error={roles.error ? errorText(roles.error) : null} />
      {roles.isPending ? <Loading what="roles" /> : null}
      {!isAdmin && list.length > 0 ? <p className="muted">Only workspace admins can change roles.</p> : null}
      {active.map((r) => (
        <RoleForm key={r.id} ws={ws} role={r} canEdit={isAdmin} />
      ))}
      {isAdmin ? <NewRole ws={ws} /> : null}
      {archived.length > 0 ? (
        <section>
          <h2>Archived roles</h2>
          <p className="muted">Archived roles grant nothing and are hidden from pickers. Restore one to use it again.</p>
          {archived.map((r) => (
            <RoleForm key={`${r.id}-archived`} ws={ws} role={r} canEdit={isAdmin} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
