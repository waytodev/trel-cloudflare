/**
 * Trel SDK for Cloudflare Workers
 *
 * Usage: import { withTrel } from '@trel-to/cloudflare';
 * export default withTrel({ apiKey: 'trel_sk_xxx', service: 'my-worker', environment: 'qa' }, { fetch: ... });
 */

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const DEFAULT_ENDPOINT = "https://ingest.trel.to";

export interface TrelConfig {
  apiKey: string;
  service?: string;
  environment?: string;
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
  const resourceAttrs = [
    { key: "service.name", value: { stringValue: config.service ?? "unknown" } },
  ];
  if (config.environment) {
    resourceAttrs.push({
      key: "deployment.environment",
      value: { stringValue: config.environment },
    });
  }

  const payload = {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            spans: [
              {
                traceId: traceId.padStart(32, "0"),
                spanId: spanId.padStart(16, "0"),
                name: attributes["http.route"] ?? attributes["http.target"] ?? "request",
                kind: 2,
                startTimeUnixNano: String(Math.round(startTime * 1e9)),
                endTimeUnixNano: String(Math.round(endTime * 1e9)),
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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-trel-key": config.apiKey,
  };
  if (config.environment) headers["x-trel-environment"] = config.environment;

  try {
    await fetch(url, {
      method: "POST",
      headers,
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
          "http.response.status_code": "500",
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
        "http.response.status_code": String(statusCode),
      })
    );

    return response;
  };

  return handler;
}
