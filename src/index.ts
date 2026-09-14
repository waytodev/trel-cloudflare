/**
 * Trel SDK for Cloudflare Workers
 *
 * Usage: import { withTrel, captureException } from '@trel-to/cloudflare';
 * export default withTrel(
 *   { apiKey: 'trel_sk_xxx', service: 'my-worker', environment: 'qa', release: 'a1b2c3d' },
 *   { fetch: ... },
 * );
 *
 * Incoming `traceparent` headers are honoured so the Worker's span joins the caller's trace.
 */

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const DEFAULT_ENDPOINT = "https://ingest.trel.to";

export interface TrelConfig {
  apiKey: string;
  service?: string;
  environment?: string;
  /** Release / version tag (git sha, semver). Sent as `service.version` and `x-trel-release`. */
  release?: string;
  endpoint?: string;
  /** Attributes merged into every span (e.g. { region: 'weur', tier: 'edge' }). */
  attributes?: Record<string, string>;
}

export interface WorkerHandler {
  fetch?(
    request: Request,
    env: Record<string, unknown>,
    ctx: ExecutionContext
  ): Promise<Response>;
}

export interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue: string } }>;
}

interface SpanInput {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTime: number;
  endTime: number;
  status: "ok" | "error";
  attributes: Record<string, string>;
  events?: SpanEvent[];
}

export interface TraceParent {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateTraceId(): string {
  return randomHex(16);
}

function generateSpanId(): string {
  return randomHex(8);
}

/** Parses a W3C `traceparent` header (`00-<traceId32>-<spanId16>-<flags>`). */
export function parseTraceParent(header: string | null | undefined): TraceParent | null {
  if (!header) return null;
  const m = header.trim().match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (!m) return null;
  const [, version, traceId, spanId, flags] = m;
  if (version === "ff" || !traceId || !spanId) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    sampled: (parseInt(flags ?? "01", 16) & 1) === 1,
  };
}

function toNano(seconds: number): string {
  return String(Math.round(seconds * 1e9));
}

function attrList(attrs: Record<string, string>): Array<{ key: string; value: { stringValue: string } }> {
  return Object.entries(attrs).map(([k, v]) => ({ key: k, value: { stringValue: String(v) } }));
}

async function sendSpan(config: TrelConfig, span: SpanInput): Promise<void> {
  const url = `${config.endpoint ?? DEFAULT_ENDPOINT}/v1/traces`;
  const resourceAttrs: Record<string, string> = { "service.name": config.service ?? "unknown" };
  if (config.environment) resourceAttrs["deployment.environment"] = config.environment;
  if (config.release) resourceAttrs["service.version"] = config.release;

  const spanBody: Record<string, unknown> = {
    traceId: span.traceId.padStart(32, "0"),
    spanId: span.spanId.padStart(16, "0"),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: toNano(span.startTime),
    endTimeUnixNano: toNano(span.endTime),
    status: { code: span.status === "error" ? 2 : 1 },
    attributes: attrList({ ...(config.attributes ?? {}), ...span.attributes }),
  };
  if (span.parentSpanId) spanBody.parentSpanId = span.parentSpanId.padStart(16, "0");
  if (span.events && span.events.length > 0) spanBody.events = span.events;

  const payload = {
    resourceSpans: [
      {
        resource: { attributes: attrList(resourceAttrs) },
        scopeSpans: [{ scope: { name: "trel-cloudflare" }, spans: [spanBody] }],
      },
    ],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-trel-key": config.apiKey,
  };
  if (config.environment) headers["x-trel-environment"] = config.environment;
  if (config.release) headers["x-trel-release"] = config.release;

  try {
    await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  } catch (e) {
    console.error("Trel: Failed to send trace", e);
  }
}

function exceptionEvent(err: unknown, atSeconds: number): SpanEvent {
  const error = err instanceof Error ? err : new Error(String(err));
  return {
    name: "exception",
    timeUnixNano: toNano(atSeconds),
    attributes: attrList({
      "exception.type": error.name || "Error",
      "exception.message": error.message,
      "exception.stacktrace": error.stack ?? "",
    }),
  };
}

export interface CaptureOptions {
  /** Join an existing trace (e.g. from the request's `traceparent`). */
  traceId?: string;
  parentSpanId?: string;
  attributes?: Record<string, string>;
}

/**
 * Sends a short span with an `exception` event. Returns the promise so callers can
 * `ctx.waitUntil(captureException(config, err))`.
 */
export function captureException(config: TrelConfig, err: unknown, opts: CaptureOptions = {}): Promise<void> {
  const now = Date.now() / 1000;
  return sendSpan(config, {
    traceId: opts.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: opts.parentSpanId,
    name: "exception",
    kind: 1,
    startTime: now,
    endTime: now,
    status: "error",
    attributes: opts.attributes ?? {},
    events: [exceptionEvent(err, now)],
  });
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
    const parent = parseTraceParent(request.headers.get("traceparent"));
    const traceId = parent?.traceId ?? generateTraceId();
    const parentSpanId = parent?.spanId;
    const spanId = generateSpanId();
    const startTime = Date.now() / 1000;
    const url = new URL(request.url);

    const baseAttrs: Record<string, string> = {
      "http.method": request.method,
      "http.url": url.toString(),
      "http.target": url.pathname,
    };

    let response: Response;
    try {
      response = await originalFetch.call(handler, request, env, ctx);
    } catch (err) {
      const endTime = Date.now() / 1000;
      ctx.waitUntil(
        sendSpan(config, {
          traceId,
          spanId,
          parentSpanId,
          name: url.pathname,
          kind: 2,
          startTime,
          endTime,
          status: "error",
          attributes: { ...baseAttrs, "http.response.status_code": "500" },
          events: [exceptionEvent(err, endTime)],
        })
      );
      throw err;
    }

    const endTime = Date.now() / 1000;
    ctx.waitUntil(
      sendSpan(config, {
        traceId,
        spanId,
        parentSpanId,
        name: url.pathname,
        kind: 2,
        startTime,
        endTime,
        status: response.status >= 400 ? "error" : "ok",
        attributes: { ...baseAttrs, "http.response.status_code": String(response.status) },
      })
    );

    return response;
  };

  return handler;
}
