import { createServerFn } from "@tanstack/react-start";
import { optionalAuthMiddleware } from "./middleware";

/** Whether the caller has a live session. Used by route guards to redirect on the server. */
export const getViewerSignedIn = createServerFn({ method: "GET" })
  .middleware([optionalAuthMiddleware])
  .handler(async ({ context }): Promise<{ signedIn: boolean }> => ({
    signedIn: context.signedIn,
  }));
