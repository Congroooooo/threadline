// /join/:code — accepts an invite, signing in first if needed. The code is parked in
// sessionStorage across the sign-in redirect (the OAuth callback always returns to "/"),
// and removed as soon as the invite has been tried.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api";
import { keys } from "../queries";

const PENDING_INVITE = "threadline.pendingInvite";

export function pendingInvite(): string | null {
  try {
    return sessionStorage.getItem(PENDING_INVITE);
  } catch {
    return null;
  }
}

function setPending(code: string | null): void {
  try {
    if (code === null) sessionStorage.removeItem(PENDING_INVITE);
    else sessionStorage.setItem(PENDING_INVITE, code);
  } catch {
    // Storage blocked: the invite still works if the person is already signed in.
  }
}

export function Join() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setPending(code);
    api
      .acceptInvite(code)
      .then(async ({ workspaceId }) => {
        setPending(null);
        await client.invalidateQueries({ queryKey: keys.me });
        navigate(`/w/${workspaceId}`, { replace: true });
      })
      .catch((err: unknown) => {
        // 401: the client is already on its way to sign-in; the code waits in storage.
        if (err instanceof ApiError && err.status === 401) return;
        setPending(null);
        setError(
          err instanceof ApiError && (err.status === 400 || err.status === 404)
            ? "This invite link is not valid any more. It may have been used, revoked or expired. Ask for a new one."
            : "The invite could not be accepted right now. Reload the page to try again.",
        );
      });
  }, [code, client, navigate]);

  return (
    <main className="signin">
      <div className="signin-card">
        {error ? (
          <>
            <h1>Invite not accepted</h1>
            <p className="error" role="alert">
              {error}
            </p>
            <Link to="/">Go to Threadline</Link>
          </>
        ) : (
          <p aria-busy="true">Joining the workspace…</p>
        )}
      </div>
    </main>
  );
}
