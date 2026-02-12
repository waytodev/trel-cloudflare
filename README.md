# @trel-to/cloudflare

Trel SDK for Cloudflare Workers — OpenTelemetry (OTEL) compatible observability for [trel.to](https://trel.to). Wraps your fetch handler and sends traces via OTLP.

## Install

```bash
npm install @trel-to/cloudflare
```

## Usage

```javascript
import { withTrel } from '@trel-to/cloudflare';

export default withTrel(
  {
    apiKey: 'trel_sk_your_api_key',
    service: 'my-worker',
  },
  {
    async fetch(request, env, ctx) {
      return new Response('Hello');
    },
  }
);
```

## Options

| Option     | Required | Default              | Description                   |
| ---------- | -------- | -------------------- | ----------------------------- |
| `apiKey`   | Yes      | —                    | Your Trel API key             |
| `service`  | No       | `'unknown'`          | Service name for your worker  |
| `endpoint` | No       | `https://ingest.trel.to` | Custom ingestion URL      |

**OpenTelemetry support:** Sends OTLP-formatted traces to Trel's ingestion endpoint. Use with any OTLP collector or alongside other OTEL instrumentations.

## License

MIT
