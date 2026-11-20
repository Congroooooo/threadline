// The app-level safety net: a render error anywhere shows a friendly message with a way
// back, instead of a blank page.
import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { failed: boolean };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("render error", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="center stack" role="alert">
        <h1>Something went wrong</h1>
        <p>This page hit an unexpected problem. Reloading usually fixes it; your work is saved on the server.</p>
        <p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>{" "}
          <a className="btn" href="/">
            Go to start
          </a>
        </p>
      </main>
    );
  }
}
