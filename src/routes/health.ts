import { json, requestId } from "../lib/http";

export function health(request: Request): Response {
  return json({ status: "ok", requestId: requestId(request) });
}
