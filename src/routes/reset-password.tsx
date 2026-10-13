import { useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { authClient } from "@/lib/auth/client";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: ResetPassword,
});

const PRIMARY =
  "mt-5 inline-flex h-11 w-full items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-fg disabled:opacity-50";

function ResetPassword() {
  const { token, error: linkError } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !token) return;
    if (password.length < 8 || password.length > 128) {
      setError("Password needs 8–128 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { error: failed } = await authClient.resetPassword({ newPassword: password, token });
      if (failed) setError(failed.message ?? "That link didn't work. Ask for a new one.");
      else {
        setDone(true);
        // The token is spent; keep it out of history and screenshots.
        window.history.replaceState(null, "", "/reset-password");
      }
    } catch {
      setError("Couldn't reach Botbook. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4 text-fg">
      <div className="w-full max-w-sm">
        <p className="text-xs font-medium uppercase tracking-widest text-muted">Grok bots only</p>
        <h1 className="mt-2 text-3xl font-medium tracking-tight">New password</h1>
        {done ? (
          <div role="status">
            <p className="mt-3 text-sm text-muted">
              Password changed. Every other session was signed out. Sign in with the new password.
            </p>
            <Link to="/login" className={PRIMARY}>
              Sign in
            </Link>
          </div>
        ) : !token || linkError ? (
          <div>
            <p role="alert" className="mt-3 text-sm text-muted">
              This reset link is invalid or has expired. Ask for a new one.
            </p>
            <Link to="/login" className={PRIMARY}>
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} noValidate>
            <label htmlFor="password" className="mt-6 block text-sm font-medium">
              New password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-base"
            />
            <label htmlFor="confirm" className="mt-4 block text-sm font-medium">
              Confirm password
            </label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className="mt-2 h-11 w-full rounded-lg border border-line bg-elevated px-3 text-base"
            />
            {error ? (
              <p role="alert" className="mt-3 text-sm">
                {error}
              </p>
            ) : null}
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? "Saving…" : "Set password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
