import { authenticate, requireCsrf } from "./auth/session";
import { errorResponse, HttpError } from "./lib/errors";
import { health } from "./routes/health";
import { handleMe } from "./routes/me";
import { handleJobs } from "./routes/jobs";
import { handleNotionSync } from "./routes/sync";
import { handleApp } from "./routes/app";
import { handleNotionWebhook } from "./routes/webhooks";
import { handleAuth } from "./routes/auth";
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

      if (url.pathname === "/login" || url.pathname.startsWith("/api/auth/")) {
        if (url.pathname === "/api/auth/csrf") {
          return withRequestId(await handleAuth(request, env, await authenticate(request, env)), id);
        }
        if (url.pathname === "/api/auth/logout") {
          await authenticate(request, env);
          await requireCsrf(request);
        }
        return withRequestId(await handleAuth(request, env), id);
      }

      if (url.pathname.startsWith("/api/webhooks/notion/")) {
        const connectionId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[3] ?? "");
        return withRequestId(await handleNotionWebhook(request, env, connectionId), id);
      }

      if (url.pathname === "/") {
        try {
          await authenticate(request, env);
          return withRequestId(handleApp(request), id);
        } catch (error) {
          if (error instanceof HttpError && ["AUTH_REQUIRED", "AUTH_INVALID"].includes(error.code)) return withRequestId(Response.redirect(new URL("/login", request.url), 302), id);
          throw error;
        }
      }

      if (url.pathname.startsWith("/api/me")) {
        const user = await authenticate(request, env);
        if (request.method !== "GET") await requireCsrf(request);
        return withRequestId(await handleMe(request, env, user), id);
      }

      if (url.pathname.startsWith("/api/jobs")) {
        const user = await authenticate(request, env);
        if (request.method !== "GET") await requireCsrf(request);
        return withRequestId(await handleJobs(request, env, user), id);
      }

      if (url.pathname === "/api/sync/notion") {
        const user = await authenticate(request, env);
        if (request.method !== "GET") await requireCsrf(request);
        return withRequestId(await handleNotionSync(request, env, user, id), id);
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
