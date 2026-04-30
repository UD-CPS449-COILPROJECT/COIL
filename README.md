# COIL

Team 2's Repository for the UDayton CPS449 COIL project

## Backend Fraud Review

The backend `POST /fraud-check` endpoint is now LLM-powered via OpenRouter.

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

The backend sends the fraud-check payload to the LLM with fraud-analysis context and requires the model to return strict JSON:

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

If the model output cannot be parsed, does not match schema, or the provider fails, the backend returns HTTP 500:

```json
{
  "error": "Fraud review failed"
}
```

The backend also bundles read-only merchant whitelist and blacklist lookups from versioned JSON data in the repo. Those endpoints live under `/merchants/whitelist/:name` and `/merchants/blacklist/:name`.
