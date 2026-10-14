/** Only same-site absolute paths may be used as a post-sign-in destination. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
  if (value === "/signin" || value.startsWith("/signin?")) return undefined;
  return value;
}

/** Search params for sending a signed-out visitor to /signin and back to `path`. */
export function signInSearch(path: string): { redirect?: string } {
  const redirect = safeRedirect(path);
  return redirect && redirect !== "/" ? { redirect } : {};
}
