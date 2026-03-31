// Keep all browser-side backend calls behind one small module boundary.
const MERCHANT_RISK_LEVELS = new Set(['low', 'medium', 'high']);

export class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? null;
    this.details = options.details ?? [];
    this.cause = options.cause;
  }
}

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

function resolveConfiguredBackendUrl(overrideBackendUrl) {
  // Allow tests or future callers to inject a backend URL without depending on
  // the runtime config script that the container writes at startup.
  if (typeof overrideBackendUrl === 'string' && overrideBackendUrl.trim()) {
    return overrideBackendUrl.trim();
  }

  return window.__APP_CONFIG__?.backendUrl?.trim() || '';
}

function resolveBackendBaseUrl(overrideBackendUrl) {
  const configuredBackendUrl = resolveConfiguredBackendUrl(overrideBackendUrl);

  if (!configuredBackendUrl) {
    return '';
  }

  if (/^https?:\/\//i.test(configuredBackendUrl)) {
    return trimTrailingSlashes(configuredBackendUrl);
  }

  // Docker Compose passes backend:8080 to the frontend container, but browsers
  // need the host that served the page with the backend's published port.
  const serviceAddress = configuredBackendUrl.match(/^([^:/]+):(\d+)$/);
  if (serviceAddress) {
    return `${window.location.protocol}//${window.location.hostname}:${serviceAddress[2]}`;
  }

  const normalizedPath = trimTrailingSlashes(configuredBackendUrl);

  // Preserve compatibility with the previous single-endpoint configuration.
  if (normalizedPath === '/fraud-check') {
    return '';
  }

  return normalizedPath;
}

function createEndpointResolver(overrideBackendUrl) {
  const baseUrl = resolveBackendBaseUrl(overrideBackendUrl);

  return function resolveEndpoint(pathname) {
    // Keep endpoint construction explicit so callers cannot accidentally build
    // malformed URLs by passing partial paths such as "health".
    if (!pathname.startsWith('/')) {
      throw new Error(`API path must start with "/": ${pathname}`);
    }

    return baseUrl ? `${baseUrl}${pathname}` : pathname;
  };
}

function normalizeRequiredString(value) {
  // Mirror backend behavior by treating nullish values as empty strings before
  // trimming, which keeps required-field checks predictable.
  return String(value ?? '').trim();
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === '1';
}

function normalizeNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : Number.NaN;
}

function validateAnalyzeInput(input) {
  const text = normalizeRequiredString(input?.text);
  const details = [];

  if (!text) {
    details.push('text is required');
  }

  if (details.length > 0) {
    throw new ValidationError('Analyze request is invalid.', details);
  }

  return { text };
}

function validateFraudInput(input) {
  // Preserve the original string form for "required" checks so empty inputs do
  // not get collapsed into numeric validation errors only.
  const rawPayload = {
    accountId: normalizeRequiredString(input?.accountId),
    amount: normalizeRequiredString(input?.amount),
    usualAmount: normalizeRequiredString(input?.usualAmount),
    location: normalizeRequiredString(input?.location),
    usualLocation: normalizeRequiredString(input?.usualLocation),
    velocity: normalizeRequiredString(input?.velocity),
    merchantRisk: normalizeRequiredString(input?.merchantRisk).toLowerCase(),
  };

  const normalizedPayload = {
    accountId: rawPayload.accountId,
    // Coerce numbers and booleans once here so downstream callers always send
    // the backend the same shape regardless of how the form values were read.
    amount: normalizeNumber(input?.amount),
    usualAmount: normalizeNumber(input?.usualAmount),
    location: rawPayload.location,
    usualLocation: rawPayload.usualLocation,
    velocity: normalizeNumber(input?.velocity),
    merchantRisk: rawPayload.merchantRisk,
    newDevice: normalizeBoolean(input?.newDevice),
    newPayee: normalizeBoolean(input?.newPayee),
  };

  const details = [];

  for (const [field, value] of Object.entries(rawPayload)) {
    if (!value) {
      details.push(`${field} is required`);
    }
  }

  if (!Number.isFinite(normalizedPayload.amount) || normalizedPayload.amount <= 0) {
    details.push('amount must be a number greater than 0');
  }

  if (!Number.isFinite(normalizedPayload.usualAmount) || normalizedPayload.usualAmount <= 0) {
    details.push('usualAmount must be a number greater than 0');
  }

  if (!Number.isFinite(normalizedPayload.velocity) || normalizedPayload.velocity < 0) {
    details.push('velocity must be a number greater than or equal to 0');
  }

  if (!MERCHANT_RISK_LEVELS.has(normalizedPayload.merchantRisk)) {
    details.push('merchantRisk must be one of low, medium, high');
  }

  if (details.length > 0) {
    throw new ValidationError('Fraud check input is invalid.', details);
  }

  return normalizedPayload;
}

async function parseJsonResponse(response, fallbackMessage) {
  try {
    return await response.json();
  } catch (error) {
    // Treat unreadable JSON as an API contract failure rather than making each
    // caller decide how to interpret a parse exception.
    throw new ApiError(fallbackMessage, {
      status: response.status,
      cause: error,
    });
  }
}

async function requestJson(url, init) {
  let response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    // Surface transport failures with the same error type used for HTTP
    // failures so the UI can handle backend problems in one place.
    throw new ApiError('Could not reach the backend service.', { cause: error });
  }

  const payload = await parseJsonResponse(response, 'Backend returned an unreadable JSON response.');

  if (!response.ok) {
    // Preserve backend-provided validation details so the UI can show a useful
    // summary without hard-coding endpoint-specific response parsing.
    throw new ApiError(
      payload?.error || payload?.message || 'Backend request failed.',
      {
        status: response.status,
        details: Array.isArray(payload?.details) ? payload.details : [],
      }
    );
  }

  return payload;
}

export function createApiClient(options = {}) {
  // Resolve the backend target once per client instance so all endpoint methods
  // share the same configuration and container-host mapping rules.
  const resolveEndpoint = createEndpointResolver(options.backendUrl);

  return {
    async getHealth() {
      return requestJson(resolveEndpoint('/health'), {
        method: 'GET',
      });
    },

    async analyze(input) {
      const payload = validateAnalyzeInput(input);

      return requestJson(resolveEndpoint('/analyze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },

    async checkFraud(input) {
      const payload = validateFraudInput(input);
      const response = await requestJson(resolveEndpoint('/fraud-check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      return {
        status: normalizeRequiredString(response?.status),
        riskScore: normalizeNumber(response?.riskScore),
        flagged: typeof response?.flagged === 'boolean'
          ? response.flagged
          : normalizeNumber(response?.riskScore) >= 55,
        reasons: Array.isArray(response?.reasons)
          ? response.reasons.map((reason) => normalizeRequiredString(reason)).filter(Boolean)
          : [],
      };
    },
  };
}
