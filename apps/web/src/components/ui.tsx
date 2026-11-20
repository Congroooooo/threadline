// Small shared pieces. Everything renders text through React (escaped); nothing here
// sets HTML.
import { cloneElement, type ReactElement, type ReactNode, useId, useState } from "react";
import type { Evidence, Quoted } from "../api";

/** Text someone else wrote. Always plain text; the source is kept for debugging. */
export function Q({ q, className }: { q: Quoted | null | undefined; className?: string }) {
  if (!q) return null;
  return (
    <span className={className} data-source={q.source}>
      {q.text}
    </span>
  );
}

/** Only http and https URLs become links; anything else is shown as text. */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const KIND_LABEL: Record<Evidence["kind"], string> = {
  change_request: "Change request",
  commit: "Commit",
  pipeline_run: "Pipeline run",
  deployment: "Deployment",
  ticket: "Ticket",
  file: "File",
  message: "Message",
};

export function EvidenceList({ items }: { items: Evidence[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="evidence">
      {items.map((e, i) => {
        const href = safeHref(e.url);
        const label = e.url.replace(/^https?:\/\//, "");
        return (
          <li key={`${e.url}-${i}`}>
            <span className="evidence-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {label}
              </a>
            ) : (
              <span className="evidence-url">{e.url}</span>
            )}
            {e.version ? <span className="muted"> ({e.version})</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** A destructive action that asks once, inline (no browser dialogs). */
export function ConfirmButton({
  label,
  ariaLabel,
  confirmLabel,
  onConfirm,
  disabled,
}: {
  label: string;
  ariaLabel?: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="btn btn-quiet" aria-label={ariaLabel} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm">
      <button
        type="button"
        className="btn btn-danger"
        onClick={async () => {
          setAsking(false);
          await onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn btn-quiet" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {error}
    </p>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="muted" aria-busy="true">Loading {what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** A field with a visible label (and an optional hint the control is described by). */
export function Field({ label, children, hint }: { label: string; children: ReactElement<Record<string, unknown>>; hint?: string }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {cloneElement(children, { id, ...(hint ? { "aria-describedby": hintId } : {}) })}
      {hint ? (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** Copies `text` to the clipboard and says so briefly. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}
