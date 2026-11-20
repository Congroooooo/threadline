// Sign-in: GitHub or GitLab through the API's OAuth routes, or "Continue" for the single
// local user (AUTH_MODE=local, which the API only allows on localhost). Only the options the
// deployment has turned on (GET /auth/providers) are shown.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { LOGO_SRC, NAME, TAGLINE } from "../brand";
import { ErrorNote } from "../components/ui";
import { errorText } from "../queries";

export function SignIn() {
  const [params] = useSearchParams();
  const failed = params.get("signin") === "failed";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const providers = useQuery({ queryKey: ["auth-providers"], queryFn: api.providers, staleTime: Infinity });
  const local = providers.data?.local ?? false;
  const github = providers.data?.github ?? false;
  const gitlab = providers.data?.gitlab ?? false;

  return (
    <main className="signin">
      <div className="signin-card">
        <img src={LOGO_SRC} alt="" className="signin-logo" width={88} height={83} />
        <h1 className="signin-name">{NAME}</h1>
        <p className="signin-tagline">{TAGLINE}</p>
        {failed ? (
          <p className="error" role="alert">
            Sign-in didn't finish. Try again, or pick the other provider if your account lives there.
          </p>
        ) : null}
        <ErrorNote error={error} />
        {providers.isPending ? <p className="muted">Loading sign-in options…</p> : null}
        {providers.error ? <ErrorNote error={`Could not load the sign-in options: ${errorText(providers.error)}`} /> : null}
        {providers.data && !local && !github && !gitlab ? (
          <p className="error" role="alert">
            No sign-in option is turned on for this deployment. Ask its admin to set up GitHub or GitLab sign-in.
          </p>
        ) : null}
        <div className="signin-actions">
          {local ? (
            <button
              type="button"
              className="btn btn-primary btn-wide"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api.signInLocal();
                  window.location.assign("/");
                } catch (err) {
                  setError(`Local sign-in failed: ${errorText(err)}`);
                  setBusy(false);
                }
              }}
            >
              Continue
            </button>
          ) : null}
          {github ? (
            <a className={local ? "btn btn-wide" : "btn btn-primary btn-wide"} href="/auth/github/start">
              Continue with GitHub
            </a>
          ) : null}
          {gitlab ? (
            <a className={local || github ? "btn btn-wide" : "btn btn-primary btn-wide"} href="/auth/gitlab/start">
              Continue with GitLab
            </a>
          ) : null}
        </div>
        <p className="signin-note">Threadline keeps no passwords. Your team's admin decides who can create workspaces.</p>
      </div>
    </main>
  );
}
