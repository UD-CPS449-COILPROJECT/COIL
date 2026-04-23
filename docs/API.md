# Backend API Reference

This document describes the backend microservice exposed by the Express app in `backend/src/app.js`.

## Overview

- Base URL: the backend serves routes from the root path with no version prefix.
- Authentication: none.
- CORS: enabled for all routes.
- Request bodies: JSON and URL-encoded form bodies are accepted for `POST` routes.
- Response formats:
  - `GET /` returns plain text.
  - All other routes return JSON.

## Endpoints

### `GET /`

Returns a simple startup banner.

Response:

- Status: `200 OK`
- Content-Type: plain text

```text
Microservice Gateway
Version: 0.0.1
```

### `GET /health`

Returns a health check response for the backend service.

Response:

- Status: `200 OK`

```json
{
  "status": "ok",
  "message": "Backend is running"
}
```

### `POST /analyze`

Performs simple keyword-based classification for banking-related text.

Request body:

```json
{
  "text": "transfer money to savings"
}
```

Rules:

- `text` is required.
- If `text` is missing or falsy, the route returns `400 Bad Request`.
- Classification is case-insensitive.
- The first matching keyword determines the result in this order:
  - `deposit`
  - `withdraw`
  - `transfer`
  - `balance`
- If no keyword matches, the prediction is `unknown request`.

Successful response:

- Status: `200 OK`

```json
{
  "input": "transfer money to savings",
  "prediction": "transfer request"
}
```

Possible `prediction` values:

- `deposit request`
- `withdraw request`
- `transfer request`
- `balance inquiry`
- `unknown request`

Validation error response:

- Status: `400 Bad Request`

```json
{
  "error": "Text input is required"
}
```

### `POST /fraud-check`

Sends transaction context to the backend fraud evaluator and returns a structured fraud decision.

Request body:

```json
{
  "amount": 5000,
  "usualAmount": 250,
  "location": "New York, US",
  "usualLocation": "Dayton, US",
  "velocity": 6,
  "merchantRisk": "high",
  "newDevice": true,
  "newPayee": false
}
```

Required fields:

- `amount`
- `usualAmount`
- `location`
- `usualLocation`
- `velocity`
- `merchantRisk`

Optional fields:

- `newDevice`
- `newPayee`

Validation rules:

- `amount` must be numeric and greater than `0`.
- `usualAmount` must be numeric and greater than `0`.
- `velocity` must be numeric and greater than or equal to `0`.
- `location` and `usualLocation` must be present and not blank.
- `merchantRisk` must be one of `low`, `medium`, or `high`.
- `merchantRisk` is normalized to lowercase before evaluation.
- `newDevice` and `newPayee` are optional booleans.
- The backend also treats the string values `"true"` and `"1"` as `true` for `newDevice` and `newPayee`.

Successful response:

- Status: `200 OK`

```json
{
  "status": "Flagged",
  "riskScore": 93,
  "flagged": true,
  "reasons": [
    "transaction amount is much higher than normal behavior",
    "transaction location differs from historical activity",
    "merchant category has elevated fraud risk",
    "payment came from a previously unseen device"
  ]
}
```

Response fields:

- `status`: `Flagged` or `Not Flagged`
- `riskScore`: integer from `0` to `100`
- `flagged`: boolean
- `reasons`: array of 1 to 5 short explanation strings

Validation error response:

- Status: `400 Bad Request`

```json
{
  "error": "Invalid fraud-check input",
  "details": [
    "amount must be a number greater than 0",
    "merchantRisk must be one of low, medium, high"
  ]
}
```

Backend failure response:

- Status: `500 Internal Server Error`
- Returned when the fraud evaluator cannot complete successfully, including configuration errors, upstream provider failures, invalid provider output, or schema mismatches.

```json
{
  "error": "Fraud review failed"
}
```

## Notes

- There is no route-level API versioning such as `/api/v1`.
- The fraud-check response is intentionally normalized before being returned to the frontend.
- The backend currently exposes exactly four routes: `/`, `/health`, `/analyze`, and `/fraud-check`.
