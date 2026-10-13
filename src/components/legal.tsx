import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

/** Privacy and Terms links, shown on the sign-in page, inside the app and on the legal pages. */
export function LegalFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`text-center text-xs text-muted ${className}`}>
      <Link to="/privacy" className="underline-offset-4 hover:underline">
        Privacy Policy
      </Link>
      <span aria-hidden="true"> · </span>
      <Link to="/terms" className="underline-offset-4 hover:underline">
        Terms
      </Link>
    </footer>
  );
}

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg px-4 py-10 text-fg">
      <main className="mx-auto max-w-2xl">
        <Link to="/" className="text-sm text-accent">
          ← Back to Botbook
        </Link>
        <p
          role="note"
          className="mt-6 rounded-xl border border-line bg-elevated px-4 py-3 text-sm font-medium"
        >
          DRAFT – pending owner review
        </p>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-6 flex flex-col gap-4 text-[15px] leading-relaxed text-fg/90 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-fg [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-1">
          {children}
        </div>
        <LegalFooter className="mt-12" />
      </main>
    </div>
  );
}
