# COIL

Team 2's Repository for the UDayton CPS449 COIL project

## Release Deployments

Docker image publishing is handled by GitHub Actions when a new Git tag is pushed to `origin`.
The workflow lives at `.github/workflows/docker-deploy.yml` and only runs for newly created tags,
so normal branch pushes do not publish release images.

Before using the workflow, configure these repository secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

Release flow:

1. Commit and merge the release-ready code.
2. Create a tag such as `v1.0.0`.
3. Push the tag with `git push origin v1.0.0`.
4. GitHub Actions builds and pushes `bambam955/coil-team2:frontend`,
   `bambam955/coil-team2:backend`, and tag-specific images such as
   `bambam955/coil-team2:frontend-v1.0.0` and `bambam955/coil-team2:backend-v1.0.0`.

Azure note:

- This repository now automates image publishing, but it does not restart Azure for you.
- After a release tag is published, restart or redeploy the Azure workload so it pulls the updated
  `frontend` and `backend` images, unless the Azure service is already configured to refresh images
  automatically.
- `just deploy` remains a manual fallback, not the primary release path.

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
