import Ajv from 'ajv';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openrouter/free';
const DEFAULT_TIMEOUT_MS = 15000;
const FLAG_THRESHOLD = 55;
const PRIMARY_STRATEGY = 'structured';
const FALLBACK_STRATEGY = 'prompted-json';
const MAX_REASONS = 4;
const META_REASON_PATTERN = /\b(risk score|low risk|safe|benign|no fraud|not flagged|flagged)\b/i;

const fraudExplanationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reasons'],
  properties: {
    reasons: {
      type: 'array',
      minItems: 0,
      maxItems: MAX_REASONS,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 160
      }
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validateFraudExplanation = ajv.compile(fraudExplanationSchema);

class FraudReviewError extends Error {
  constructor(message, { retryEligible = false, nonFatal = false } = {}) {
    super(message);
    this.name = 'FraudReviewError';
    this.retryEligible = retryEligible;
    this.nonFatal = nonFatal;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toBoolean(value) {
  return value === true || value === 'true' || value === '1';
}

function normalizeFraudPayload(payload) {
  return {
    amount: Number(payload.amount),
    usualAmount: Number(payload.usualAmount),
    location: String(payload.location || '').trim(),
    usualLocation: String(payload.usualLocation || '').trim(),
    velocity: Number(payload.velocity),
    merchantRisk: String(payload.merchantRisk || 'low').trim().toLowerCase(),
    newDevice: toBoolean(payload.newDevice),
    newPayee: toBoolean(payload.newPayee)
  };
}

function getTimeoutMs(env) {
  const timeoutMs = Number.parseInt(env.OPENROUTER_TIMEOUT_MS || '', 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

function buildDeterministicAssessment(payload) {
  const amountRatio = payload.usualAmount > 0 ? payload.amount / payload.usualAmount : 1;
  let score = 8;
  let signalIndex = 0;
  const signals = [];

  function addSignal(weight, reason) {
    signals.push({
      weight,
      reason,
      order: signalIndex
    });
    signalIndex += 1;
  }

  if (amountRatio >= 4) {
    score += 36;
    addSignal(36, 'amount is far above the account\'s usual range');
  } else if (amountRatio >= 2) {
    score += 20;
    addSignal(20, 'amount is above the account\'s usual range');
  }

  if (payload.location && payload.usualLocation && payload.location.toLowerCase() !== payload.usualLocation.toLowerCase()) {
    score += 22;
    addSignal(22, 'transaction location differs from the usual location');
  }

  if (payload.velocity >= 8) {
    score += 20;
    addSignal(20, 'unusually high number of recent transactions');
  } else if (payload.velocity >= 4) {
    score += 10;
    addSignal(10, 'elevated transaction velocity in the last 24 hours');
  }

  if (payload.merchantRisk === 'high') {
    score += 14;
    addSignal(14, 'merchant category is marked as high risk');
  } else if (payload.merchantRisk === 'medium') {
    score += 6;
    addSignal(6, 'merchant category carries moderate risk');
  }

  if (payload.newDevice) {
    score += 13;
    addSignal(13, 'transaction originated from a new device');
  }

  if (payload.newPayee) {
    score += 12;
    addSignal(12, 'payment is being sent to a new payee');
  }

  score = clamp(Math.round(score), 0, 100);
  const flagged = score >= FLAG_THRESHOLD;
  const prioritizedSignals = [...signals]
    .sort((left, right) => right.weight - left.weight || left.order - right.order)
    .slice(0, MAX_REASONS)
    .map((signal) => signal.reason);

  return {
    score,
    flagged,
    status: flagged ? 'Flagged' : 'Not Flagged',
    fallbackReasons: prioritizedSignals
  };
}

function buildSystemPrompt(strategy) {
  const basePrompt = [
    'You explain a deterministic fraud assessment produced by a banking backend.',
    'The backend has already decided the score and status; do not change, reinterpret, or summarize them.',
    'You will receive a list of deterministic risk signals.',
    'Rewrite each provided signal into one concise user-facing reason.',
    'Keep the same number of reasons and preserve the same order as the provided signals.',
    'Do not add or remove signals.',
    'Do not mention risk score, status, flagged/not flagged, safety, or overall fraud conclusions.',
    'Keep each reason short, factual, and specific to the provided signals.'
  ];

  if (strategy === PRIMARY_STRATEGY) {
    return [
      ...basePrompt,
      'Return only JSON that matches the provided schema with the reasons array.',
      'Return JSON only with no markdown, prose, or code fences.'
    ].join('\n');
  }

  return [
    ...basePrompt,
    'Return a single JSON object with exactly one key: reasons.',
    'Return JSON only with no markdown, prose, or code fences.'
  ].join('\n');
}

function buildExplanationInput(assessment) {
  return {
    riskScore: assessment.score,
    status: assessment.status,
    flagged: assessment.flagged,
    signals: assessment.fallbackReasons
  };
}

function buildStructuredRequestBody(assessment, model) {
  return {
    model,
    temperature: 0.2,
    stream: false,
    plugins: [{ id: 'response-healing' }],
    provider: {
      require_parameters: true
    },
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'fraud_explanation',
        strict: true,
        schema: fraudExplanationSchema
      }
    },
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(PRIMARY_STRATEGY)
      },
      {
        role: 'user',
        content: JSON.stringify(buildExplanationInput(assessment), null, 2)
      }
    ]
  };
}

function buildFallbackRequestBody(assessment, model) {
  return {
    model,
    temperature: 0.2,
    stream: false,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(FALLBACK_STRATEGY)
      },
      {
        role: 'user',
        content: JSON.stringify(buildExplanationInput(assessment), null, 2)
      }
    ]
  };
}

function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || /timeout|timed out|aborted due to timeout/i.test(error?.message || '');
}

function isCompatibilityFailure(status, responseText) {
  return status === 404 && /no endpoints found/i.test(responseText);
}

function createFraudReviewError(message, options) {
  return new FraudReviewError(message, options);
}

function isNonFatalProviderFailure(status, responseText) {
  if ([404, 408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return /rate-limit|rate limit|temporarily rate-limited|provider returned error|timeout|timed out/i.test(responseText);
}

function normalizeChoiceText(content) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (part && typeof part.text === 'string') {
          return part.text;
        }

        return '';
      })
      .join('')
      .trim();
  }

  if (content && typeof content === 'object') {
    return content;
  }

  return '';
}

function stripCodeFence(text) {
  const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : text;
}

function normalizeExplanationPayload(parsedExplanation, expectedReasonCount) {
  const rawReasons = Array.isArray(parsedExplanation?.reasons) ? parsedExplanation.reasons : null;

  if (!rawReasons) {
    throw createFraudReviewError('OpenRouter response did not include a reasons array', {
      retryEligible: true,
      nonFatal: true
    });
  }

  const reasons = rawReasons
    .filter((reason) => typeof reason === 'string')
    .map((reason) => reason.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, expectedReasonCount);

  if (reasons.length !== expectedReasonCount) {
    throw createFraudReviewError('OpenRouter response did not preserve the expected number of reasons', {
      retryEligible: true,
      nonFatal: true
    });
  }

  if (reasons.some((reason) => META_REASON_PATTERN.test(reason))) {
    throw createFraudReviewError('OpenRouter response included meta commentary instead of signal explanations', {
      retryEligible: true,
      nonFatal: true
    });
  }

  return { reasons };
}

function parseChoiceContent(content, { allowCodeFences = false } = {}) {
  const normalizedContent = normalizeChoiceText(content);

  if (normalizedContent && typeof normalizedContent === 'object') {
    return normalizedContent;
  }

  if (!normalizedContent) {
    throw createFraudReviewError('OpenRouter response did not include a usable message content payload', {
      retryEligible: true,
      nonFatal: true
    });
  }

  const candidate = allowCodeFences ? stripCodeFence(normalizedContent) : normalizedContent;

  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw createFraudReviewError(`Unable to parse LLM review payload: ${error.message}`, {
      retryEligible: true,
      nonFatal: true
    });
  }
}

function toPublicResponse(assessment, reasons) {
  return {
    status: assessment.status,
    score: assessment.score,
    flagged: assessment.flagged,
    reasons
  };
}

async function sendOpenRouterRequest(fetchImpl, env, requestBody) {
  try {
    return await fetchImpl(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(getTimeoutMs(env))
    });
  } catch (error) {
    throw createFraudReviewError(`OpenRouter request failed: ${error.message}`, {
      retryEligible: isTimeoutError(error),
      nonFatal: isTimeoutError(error)
    });
  }
}

async function parseCompletionResponse(response, strategy, expectedReasonCount) {
  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    throw createFraudReviewError(
      `OpenRouter request failed with status ${response.status}${responseText ? `: ${responseText}` : ''}`,
      {
        retryEligible: strategy === PRIMARY_STRATEGY && isCompatibilityFailure(response.status, responseText),
        nonFatal: isNonFatalProviderFailure(response.status, responseText)
      }
    );
  }

  let completion;
  try {
    completion = await response.json();
  } catch (error) {
    throw createFraudReviewError(`OpenRouter returned invalid JSON: ${error.message}`, {
      retryEligible: strategy === PRIMARY_STRATEGY,
      nonFatal: true
    });
  }

  const messageContent = completion?.choices?.[0]?.message?.content;
  const parsedExplanation = parseChoiceContent(messageContent, {
    allowCodeFences: strategy === FALLBACK_STRATEGY
  });
  const normalizedExplanation = normalizeExplanationPayload(parsedExplanation, expectedReasonCount);

  if (!validateFraudExplanation(normalizedExplanation)) {
    const schemaErrors = ajv.errorsText(validateFraudExplanation.errors, { separator: '; ' });
    throw createFraudReviewError(`OpenRouter returned schema-invalid JSON: ${schemaErrors}`, {
      retryEligible: strategy === PRIMARY_STRATEGY,
      nonFatal: true
    });
  }

  return normalizedExplanation;
}

async function requestFraudExplanation(fetchImpl, env, assessment, strategy) {
  const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const requestBody = strategy === PRIMARY_STRATEGY
    ? buildStructuredRequestBody(assessment, model)
    : buildFallbackRequestBody(assessment, model);

  const response = await sendOpenRouterRequest(fetchImpl, env, requestBody);
  return await parseCompletionResponse(response, strategy, assessment.fallbackReasons.length);
}

export function createFraudEvaluator({ fetchImpl = fetch, env = process.env } = {}) {
  return async function evaluateFraud(payload) {
    const normalizedPayload = normalizeFraudPayload(payload);
    const assessment = buildDeterministicAssessment(normalizedPayload);
    const fallbackResponse = toPublicResponse(assessment, assessment.fallbackReasons);

    if (assessment.fallbackReasons.length === 0) {
      return fallbackResponse;
    }

    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw createFraudReviewError('OPENROUTER_API_KEY is required');
    }

    try {
      const explanation = await requestFraudExplanation(fetchImpl, env, assessment, PRIMARY_STRATEGY);
      return toPublicResponse(assessment, explanation.reasons);
    } catch (error) {
      if (!error.nonFatal) {
        throw error;
      }

      if (!error.retryEligible) {
        return fallbackResponse;
      }

      try {
        const explanation = await requestFraudExplanation(fetchImpl, env, assessment, FALLBACK_STRATEGY);
        return toPublicResponse(assessment, explanation.reasons);
      } catch (fallbackError) {
        if (!fallbackError.nonFatal) {
          throw fallbackError;
        }

        return fallbackResponse;
      }
    }
  };
}

export const evaluateFraud = createFraudEvaluator();
