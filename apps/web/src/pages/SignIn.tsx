// Sign-in: GitHub or GitLab through the API's OAuth routes, or "Continue" for the single
// local user (AUTH_MODE=local, which the API only allows on localhost).
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { LOGO_SRC, NAME, TAGLINE } from "../brand";
import { ErrorNote } from "../components/ui";
import { errorText } from "../queries";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function SignIn() {
  const [params] = useSearchParams();
  const failed = params.get("signin") === "failed";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Local mode only exists on localhost, so the button is only offered there.
  const local = LOCAL_HOSTS.has(window.location.hostname);

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
          <a className={local ? "btn btn-wide" : "btn btn-primary btn-wide"} href="/auth/github/start">
            Continue with GitHub
          </a>
          <a className="btn btn-wide" href="/auth/gitlab/start">
            Continue with GitLab
          </a>
        </div>
        <p className="signin-note">Threadline keeps no passwords. Your team's admin decides who can create workspaces.</p>
      </div>
    </main>
  );
}
