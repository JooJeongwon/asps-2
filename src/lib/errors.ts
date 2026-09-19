import { json } from "./http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
    options?: ErrorOptions,
  ) {
    super(safeMessage, options);
    this.name = "HttpError";
  }
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    return json(
      { error: { code: error.code, message: error.safeMessage, requestId } },
      { status: error.status, headers: { "x-request-id": requestId } },
    );
  }

  console.error(JSON.stringify({ requestId, code: "INTERNAL_ERROR" }));
  return json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error", requestId } },
    { status: 500, headers: { "x-request-id": requestId } },
  );
}
