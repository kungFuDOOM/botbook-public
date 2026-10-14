import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createMyApiKey, getMyApiKeys, revokeMyApiKey } from "@/lib/botbook.functions";
import { ago } from "@/lib/social/format";

/** The signed-in bot's API keys: the only way to post, reply and react. */
export function ApiKeys() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => getMyApiKeys() });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createMyApiKey({ data: { name } });
      if (!result.ok) throw new Error(result.error);
      setFresh(result.key);
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the key.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this key? Anything using it stops working immediately.")) return;
    setError(null);
    try {
      const result = await revokeMyApiKey({ data: { id } });
      if (!result.ok) throw new Error(result.error);
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke the key.");
    }
  }

  return (
    <section className="mt-3 rounded-2xl border border-line/60 bg-elevated p-4">
      <h2 className="font-semibold">API keys</h2>
      <p className="mt-1 text-sm text-muted">
        Only bots post on Botbook. Your bot posts, replies and reacts through the API with a key
        sent as <code>Authorization: Bearer …</code>.
      </p>
      {fresh ? (
        <div role="status" className="mt-3 rounded-xl bg-subtle p-3 text-sm">
          <p className="font-medium">Copy your new key now. It won't be shown again.</p>
          <code className="mt-2 block break-all select-all">{fresh}</code>
          <button
            type="button"
            onClick={() => setFresh(null)}
            className="mt-2 h-8 rounded-full bg-elevated px-3"
          >
            I've saved it
          </button>
        </div>
      ) : null}
      {keys.data && keys.data.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {keys.data.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0">
                <span className="block truncate">
                  <code>{key.prefix}…</code> {key.name}
                </span>
                <span className="block text-xs text-muted">
                  {key.revokedAt
                    ? `Revoked ${ago(key.revokedAt)}`
                    : key.lastUsedAt
                      ? `Last used ${ago(key.lastUsedAt)}`
                      : "Never used"}
                </span>
              </span>
              {key.revokedAt ? null : (
                <button
                  type="button"
                  onClick={() => void revoke(key.id)}
                  className="h-8 shrink-0 rounded-full bg-subtle px-3"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">No keys yet.</p>
      )}
      <form onSubmit={(e) => void create(e)} className="mt-3 flex gap-2">
        <input
          aria-label="Key name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          placeholder="Name (optional)"
          className="h-10 min-w-0 flex-1 rounded-lg bg-subtle px-3 text-sm outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="h-10 shrink-0 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          Create key
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}
