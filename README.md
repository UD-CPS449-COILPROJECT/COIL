# COIL

Team 2's Repository for the UDayton CPS449 COIL project

## Backend Fraud Review

The backend `POST /fraud-check` endpoint now uses deterministic backend scoring for the final fraud decision and OpenRouter for human-readable explanations when available.

Setup with Docker Compose:

1. Copy `.env.example` to `.env`
2. Paste your OpenRouter API key into `OPENROUTER_API_KEY`
3. Run `docker compose up --build`

Keep the OpenRouter key in the backend environment only. Do not add it to the frontend or commit it to the repo.

Required environment variables:

- `OPENROUTER_API_KEY`

Optional environment variables:

- `OPENROUTER_MODEL` defaults to `openrouter/free`
- `OPENROUTER_TIMEOUT_MS` defaults to `15000`

The success response shape is unchanged:

```json
{
  "status": "Flagged",
  "riskScore": 72,
  "flagged": true,
  "reasons": [
    "amount is far above the account's typical activity",
    "transaction location differs from the usual location"
  ]
}
```

If OpenRouter is rate-limited, times out, or returns unusable output, the backend falls back to deterministic backend reasons and still returns a normal fraud-check response.

The backend returns HTTP 500 for configuration or unrecoverable server errors, for example:

```json
{
  "error": "Fraud review failed"
}
```
