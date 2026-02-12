/**
 * Trel SDK for Cloudflare Workers
 * Wraps your worker's fetch handler to add tracing and send OTLP data to ingest.trel.to
 *
 * Usage: import { withTrel } from '@trel-to/cloudflare';
 * export default withTrel({ apiKey: 'trel_sk_xxx', service: 'my-worker' }, { fetch: ... });
 */

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const DEFAULT_ENDPOINT = "https://ingest.trel.to";

export interface TrelConfig {
  apiKey: string;
  service?: string;
  endpoint?: string;
}

export interface WorkerHandler {
  fetch?(
    request: Request,
    env: Record<string, unknown>,
    ctx: ExecutionContext
  ): Promise<Response>;
}

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sendTrace(
  config: TrelConfig,
  traceId: string,
  spanId: string,
  startTime: number,
  endTime: number,
  status: "ok" | "error",
  attributes: Record<string, string>
): Promise<void> {
  const url = `${config.endpoint ?? DEFAULT_ENDPOINT}/v1/traces`;
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: config.service ?? "unknown" } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: traceId.padStart(32, "0"),
                spanId: spanId.padStart(16, "0"),
                name: attributes["http.route"] ?? attributes["http.target"] ?? "request",
                kind: 1,
                startTimeUnixNano: String(startTime * 1e9),
                endTimeUnixNano: String(endTime * 1e9),
                status: { code: status === "error" ? 2 : 1 },
                attributes: Object.entries(attributes).map(([k, v]) => ({
                  key: k,
                  value: { stringValue: v },
                })),
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trel-key": config.apiKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Trel: Failed to send trace", e);
  }
}

export function withTrel<T extends WorkerHandler>(
  config: TrelConfig,
  handler: T
): T {
  if (!handler.fetch) return handler;

  const originalFetch = handler.fetch;
  handler.fetch = async (
    request: Request,
    env: Record<string, unknown>,
    ctx: ExecutionContext
  ): Promise<Response> => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const startTime = Date.now() / 1000;
    const url = new URL(request.url);

    let response: Response;
    let status: "ok" | "error" = "ok";
    let statusCode = 500;

    try {
      response = await originalFetch.call(handler, request, env, ctx);
      statusCode = response.status;
      if (response.status >= 400) status = "error";
    } catch (err) {
      status = "error";
      const endTime = Date.now() / 1000;
      ctx.waitUntil(
        sendTrace(config, traceId, spanId, startTime, endTime, status, {
          "http.method": request.method,
          "http.url": url.toString(),
          "http.target": url.pathname,
          "http.status_code": "500",
        })
      );
      throw err;
    }

    const endTime = Date.now() / 1000;
    ctx.waitUntil(
      sendTrace(config, traceId, spanId, startTime, endTime, status, {
        "http.method": request.method,
        "http.url": url.toString(),
        "http.target": url.pathname,
        "http.status_code": String(statusCode),
      })
    );

    return response;
  };

  return handler;
}
