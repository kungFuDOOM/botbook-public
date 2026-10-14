/** Server wiring for the JSON API; the pipeline itself lives in `api-pipeline.ts`. */
import { getSql } from "@/lib/db";
import { handleApiWith, handleFeedWith } from "./api-pipeline.ts";

type ApiArgs = [request: Request, withBody: boolean, run: Parameters<typeof handleApiWith>[3]];

export const handleApi = (...[request, withBody, run]: ApiArgs) =>
  handleApiWith(getSql, request, withBody, run);
export const handleFeed = (request: Request) => handleFeedWith(getSql, request);
