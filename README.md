# FortiAIGate Raw Comparator

Local lab tool for comparing the same OpenAI-compatible chat completion request sent directly to a raw model backend and through FortiAIGate.

The app is built for interference analysis, not benchmarking. It exposes outbound payloads, inbound headers, raw response chunks, event timing, request diffs, output diffs, and latency metrics.

## Features

- Two-panel comparator: `RAW MODEL` and `FortiAIGate Secured`
- Shared prompt with send-to-raw, send-to-FortiAIGate, and send-to-both controls
- `Send to Both` runs RAW first, then FortiAIGate after RAW finishes
- Demo/Analytic mode toggle; Demo hides configuration, JSON logs, metrics, and diffs
- OpenAI-compatible request shape: `POST {base_url}/v1/chat/completions`
- Server-Sent Events from the FastAPI proxy to the browser
- Streaming and non-streaming upstream support
- Raw outbound request JSON log
- Raw inbound response/event log with per-chunk timestamps
- Status code and response header capture
- Metrics for first byte, first token, final token, total latency, character count, and estimated tokens/sec
- Request and output diff views
- Heuristics for added system messages and changed `model`, `temperature`, `max_tokens`, and `stream`
- Per-panel self-signed TLS allowance for HTTPS lab endpoints
- Local JSON profile storage for target settings only
- Named prompts and optional system prompts stored separately under `backend/prompts/`
- API tokens are not saved unless each panel's `Save token` checkbox is enabled

## Run With Docker Compose

```bash
docker compose up --build
```

Open:

```text
http://localhost:5173
```

From another machine on the same network, open:

```text
http://<server-ip-or-hostname>:5173
```

Backend API:

```text
http://localhost:8000
```

In Docker Compose, the frontend serves the app and proxies `/api/*` to the backend container. This keeps the browser from calling `localhost:8000`, which would point at the remote user's own machine instead of the server.

## Run Locally

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

For remote Vite development, use the server IP or hostname:

```text
http://<server-ip-or-hostname>:5173
```

The Vite dev server is configured with `host: 0.0.0.0` and proxies `/api` to `VITE_DEV_API_TARGET`, defaulting to `http://localhost:8000`.

## Profiles And Prompts

Named configuration profiles are stored separately under:

```text
backend/profiles/
```

`Save` stores panel settings only: base URLs, model names, generation parameters, streaming flags, self-signed TLS flags, and tokens only when `Save token` is checked. The active prompt is not saved in the profile. Use the profile dropdown, `Load Profile`, `Save`, `Save As`, `Export`, and `Import` in Analytic mode to manage multiple configurations. `Save As` opens a prompt for a new profile name. Export/import handles one selected profile JSON file at a time.

Prompts are saved separately as named JSON files under:

```text
backend/prompts/
```

Use the saved prompt dropdown, `Load Prompt`, `Save`, `Save As`, `Export`, `Import`, and the trash button to manage prompt text. `Save` overwrites the selected prompt. `Save As` opens a prompt for a new saved prompt name. Export/import handles one selected prompt JSON file at a time. In Analytic mode, optional system prompt and `X-Scenario` fields are also shown and saved with the prompt. Demo mode hides those fields, but loaded system prompts and scenario headers are still sent.

Blank `X-Scenario` is the default and sends no custom scenario header. When populated, the proxy sends:

```json
{
  "Content-Type": "application/json",
  "X-Scenario": "<value>"
}
```

## Remote Access Notes

The app binds to all interfaces in Docker Compose:

```text
0.0.0.0:5173->80
0.0.0.0:8000->8000
```

Allow inbound TCP `5173` on the host firewall for the UI. Port `8000` is exposed for direct backend inspection, but normal browser use goes through `http://<server>:5173/api`.

This remains a lab debug tool. Remote accessible should mean a trusted lab network, VPN, or SSH tunnel, not public internet exposure.

## Endpoint

`POST /api/chat/stream`

Request body:

```json
{
  "base_url": "http://localhost:11434",
  "api_token": "",
  "allow_self_signed": false,
  "payload": {
    "model": "example-model",
    "messages": [
      {
        "role": "user",
        "content": "hello"
      }
    ],
    "temperature": 0.7,
    "max_tokens": 1024,
    "stream": true
  }
}
```

The backend forwards to:

```text
POST {base_url}/v1/chat/completions
```

For HTTPS endpoints with a self-signed certificate, enable `Allow self-signed TLS` on that panel. This disables upstream certificate verification only for that request path through the local proxy.

## Security Note

This is a local debug tool only. Do not expose it to the internet.

The proxy intentionally returns raw diagnostics to the frontend, including errors, status codes, headers, payloads, and response chunks. The UI masks Authorization headers for display and skips token persistence unless explicitly enabled.
