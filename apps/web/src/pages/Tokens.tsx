// Agent tokens: create one for chosen projects (shown once, with setup snippets), list and
// revoke. The new token lives only in this component's state: leaving the page drops it.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { ConfirmButton, CopyButton, Empty, ErrorNote, Field, Loading, timeAgo } from "../components/ui";
import { errorText, keys, useProjects, useWs } from "../queries";

// The two snippets from integrations/claude-code/README.md (Task 14), verbatim.
export const HOOK_SCRIPT_URL = "https://github.com/Congroooooo/threadline/blob/main/integrations/claude-code/session-start.mjs";
export const MCP_SNIPPET = `{ "mcpServers": { "threadline": { "type": "http", "url": "\${THREADLINE_URL}/mcp",
    "headers": { "Authorization": "Bearer \${THREADLINE_TOKEN}" } } } }`;
export const HOOK_SNIPPET = `{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command",
    "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/threadline-session-start.mjs\\"" } ] } ] } }`;

function NewToken({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  const env = `export THREADLINE_URL=${window.location.origin}\nexport THREADLINE_TOKEN=${token}`;
  return (
    <section className="once" aria-label="New token">
      <h2>Token for {name}</h2>
      <p>
        Copy it now. This is the only time Threadline shows it; afterwards only its name is kept.
      </p>
      <p className="step">1. Set these in the agent's environment:</p>
      <pre className="code">{env}</pre>
      <div className="actions">
        <CopyButton text={token} label="Copy token" />
        <CopyButton text={env} label="Copy both lines" />
      </div>
      <p className="step">2. Connect the agent to Threadline (MCP settings, for example .mcp.json):</p>
      <pre className="code">{MCP_SNIPPET}</pre>
      <CopyButton text={MCP_SNIPPET} />
      <p className="step">
        3. For Claude Code, copy{" "}
        <a href={HOOK_SCRIPT_URL} target="_blank" rel="noreferrer">
          session-start.mjs
        </a>{" "}
        to your project's .claude/hooks/threadline-session-start.mjs, then add the hook (.claude/settings.json):
      </p>
      <pre className="code">{HOOK_SNIPPET}</pre>
      <CopyButton text={HOOK_SNIPPET} />
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

export function Tokens() {
  const ws = useWs();
  const client = useQueryClient();
  const projects = useProjects(ws);
  const tokens = useQuery({ queryKey: keys.tokens(ws), queryFn: () => api.tokens(ws) });
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown once: never put in the query cache or storage.
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  const projectKey = (id: string) => projects.data?.find((p) => p.id === id)?.key ?? "archived project";

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.createToken(ws, { name: name.trim(), projectIds: chosen });
      setCreated({ name: name.trim(), token });
      setName("");
      setChosen([]);
      await client.invalidateQueries({ queryKey: keys.tokens(ws) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1>Agent tokens</h1>
      <p className="lede">A token lets a coding agent work in chosen projects for you. It acts with your roles, never more.</p>

      {created ? (
        <NewToken name={created.name} token={created.token} onDone={() => setCreated(null)} />
      ) : (
        <form
          className="panel stack"
          aria-label="Create a token"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h2>New token</h2>
          <Field label="Token name" hint="Where the agent runs, for example “Ada's laptop”.">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </Field>
          <fieldset className="choices">
            <legend>Projects it can work in</legend>
            {projects.isPending ? <Loading what="projects" /> : null}
            {projects.data?.length === 0 ? <Empty>You can't read any projects yet.</Empty> : null}
            {projects.data?.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(p.id)}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))}
                />
                <span className="ref">{p.key}</span> {p.name}
              </label>
            ))}
          </fieldset>
          <ErrorNote error={error} />
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy || name.trim() === "" || chosen.length === 0}>
              Create token
            </button>
          </div>
        </form>
      )}

      <section>
        <h2>Tokens</h2>
        <ErrorNote error={tokens.error ? errorText(tokens.error) : null} />
        {tokens.isPending ? <Loading what="tokens" /> : null}
        {tokens.data?.length === 0 ? <Empty>No tokens yet. Create one above to connect an agent.</Empty> : null}
        <ul className="rows">
          {tokens.data?.map((t) => (
            <li key={t.id} className={t.revokedAt ? "row row-off" : "row"}>
              <div className="row-main">
                <strong>{t.name}</strong>
                <span className="muted">
                  {t.ownerName}; {t.projectIds.map(projectKey).join(", ")}; created {timeAgo(t.createdAt)};{" "}
                  {t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt)}` : "never used"}
                </span>
              </div>
              {t.revokedAt ? (
                <span className="tag">Revoked</span>
              ) : (
                <ConfirmButton
                  label="Revoke"
                  ariaLabel={`Revoke ${t.name}`}
                  confirmLabel="Yes, revoke"
                  onConfirm={async () => {
                    try {
                      await api.revokeToken(ws, t.id);
                      await client.invalidateQueries({ queryKey: keys.tokens(ws) });
                    } catch (err) {
                      setError(errorText(err));
                    }
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
