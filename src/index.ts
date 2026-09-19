import { authenticate } from "./auth/access";
import { errorResponse } from "./lib/errors";
import { health } from "./routes/health";
import { handleMe } from "./routes/me";
import { handleJobs } from "./routes/jobs";
import { handleNotionSync } from "./routes/sync";
import { handleApp } from "./routes/app";
import { consumeJobs } from "./workflows/jobs";
import type { Env } from "./types/env";
import { json, requestId, withRequestId } from "./lib/http";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = requestId(request);

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return withRequestId(health(request), id);
      }

      if (url.pathname === "/") {
        await authenticate(request, env);
        return withRequestId(handleApp(request), id);
      }

      if (url.pathname.startsWith("/api/me")) {
        return withRequestId(await handleMe(request, env, await authenticate(request, env)), id);
      }

      if (url.pathname.startsWith("/api/jobs")) {
        return withRequestId(await handleJobs(request, env, await authenticate(request, env)), id);
      }

      if (url.pathname === "/api/sync/notion") {
        return withRequestId(await handleNotionSync(request, env, await authenticate(request, env), id), id);
      }

      return withRequestId(json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 }), id);
    } catch (error) {
      return errorResponse(error, id);
    }
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await consumeJobs(batch, env);
  },
} satisfies ExportedHandler<Env>;
