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
Version: 0.2.0
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

### `GET /merchants/whitelist/:name`

Looks up a merchant in the versioned whitelist using the backend's normalized exact-match index.

Lookup rules:

- The path parameter is trimmed before lookup.
- Matching is case-insensitive after normalization.
- Internal whitespace is collapsed to a single space before lookup.
- Exact matches return the canonical merchant record and aliases.
- Non-matches still return `200 OK` with `found: false`.

Successful response:

- Status: `200 OK`

```json
{
  "found": true,
  "name": "Costco Wholesale",
  "aliases": ["Costco"]
}
```

No-match response:

- Status: `200 OK`

```json
{
  "found": false
}
```

### `GET /merchants/blacklist/:name`

Looks up a merchant in the versioned blacklist using the same normalized exact-match contract as the whitelist route.

Successful and no-match responses use the same shapes as `GET /merchants/whitelist/:name`.

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
  "merchantName": "Costco Wholesale",
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
- `merchantName`

Optional fields:

- `newDevice`
- `newPayee`

Field reference:

| Field | Purpose | Type | Required | Example | Notes |
| --- | --- | --- | --- | --- | --- |
| `amount` | Current transaction amount to evaluate. | number or numeric string | Yes | `5000` or `"5000"` | Must be greater than `0`. |
| `usualAmount` | Typical amount for this user or account, used as the baseline for comparison. | number or numeric string | Yes | `250` or `"250"` | Must be greater than `0`. |
| `location` | Current transaction location as free-form text. | string | Yes | `"New York, US"` | Cannot be blank; whitespace is trimmed before evaluation. |
| `usualLocation` | User's normal or historical location, used to detect location mismatch. | string | Yes | `"Dayton, US"` | Cannot be blank; whitespace is trimmed before evaluation. |
| `velocity` | Count of recent related transactions or a similar velocity signal for the current event. | number or numeric string | Yes | `6` or `"6"` | Must be greater than or equal to `0`. |
| `merchantName` | Merchant name supplied by the caller for exact-match whitelist and blacklist lookup. | string | Yes | `"Costco Wholesale"` | Whitespace is trimmed before evaluation. |
| `newDevice` | Whether the transaction came from a device the user has not used before. | boolean or supported boolean-like string | No | `true`, `"true"`, or `"1"` | Defaults to `false`; only `true`, `"true"`, and `"1"` become true. |
| `newPayee` | Whether the transaction targets a payee the user has not interacted with before. | boolean or supported boolean-like string | No | `false`, `"true"`, or `"1"` | Defaults to `false`; only `true`, `"true"`, and `"1"` become true. |

Validation rules:

- `amount` must be numeric and greater than `0`.
- `usualAmount` must be numeric and greater than `0`.
- `velocity` must be numeric and greater than or equal to `0`.
- `location` and `usualLocation` must be present and not blank.
- `merchantName` must be present and not blank.
- `merchantName` is trimmed before evaluation.
- `newDevice` and `newPayee` are optional booleans.
- The backend also treats the string values `"true"` and `"1"` as `true` for `newDevice` and `newPayee`.

Normalized transaction shape:

Before the backend sends the request to the fraud evaluator, it normalizes the payload to this shape:

```json
{
  "amount": 5000,
  "usualAmount": 250,
  "location": "New York, US",
  "usualLocation": "Dayton, US",
  "velocity": 6,
  "merchantName": "Costco Wholesale",
  "newDevice": true,
  "newPayee": false
}
```

Normalization behavior:

- Numeric fields are converted with `Number(...)`.
- `location` and `usualLocation` are converted to strings and trimmed.
- `merchantName` is converted to a trimmed string and used as the merchant lookup key.
- If `newDevice` or `newPayee` is omitted, the backend sends `false`.

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
    "merchant whitelist/blacklist lookup indicates elevated merchant risk",
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
    "merchantName is required"
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
- The backend currently exposes exactly six routes: `/`, `/health`, `/analyze`, `/merchants/whitelist/:name`, `/merchants/blacklist/:name`, and `/fraud-check`.
