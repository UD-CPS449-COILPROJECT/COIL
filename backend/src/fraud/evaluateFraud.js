import Ajv from 'ajv';
import { defaultMerchantLookup } from '../merchants/merchantLookup.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openrouter/free';
const DEFAULT_TIMEOUT_MS = 60000;

const fraudDecisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'riskScore', 'flagged', 'reasons'],
  properties: {
    status: {
      type: 'string',
      enum: ['Flagged', 'Not Flagged']
    },
    riskScore: {
      type: 'integer',
      minimum: 0,
      maximum: 100
    },
    flagged: {
      type: 'boolean'
    },
    reasons: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 200
      }
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validateFraudDecision = ajv.compile(fraudDecisionSchema);

class FraudReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FraudReviewError';
  }
}

function toBoolean(value) {
  return value === true || value === 'true' || value === '1';
}

function normalizeFraudPayload(payload) {
  const merchantName = String(payload.merchantName || '').trim();

  return {
    amount: Number(payload.amount),
    usualAmount: Number(payload.usualAmount),
    location: String(payload.location || '').trim(),
    usualLocation: String(payload.usualLocation || '').trim(),
    velocity: Number(payload.velocity),
    merchantRisk: String(payload.merchantRisk || 'low').trim().toLowerCase(),
    newDevice: toBoolean(payload.newDevice),
    newPayee: toBoolean(payload.newPayee),
    ...(merchantName ? { merchantName } : {})
  };
}

function getTimeoutMs(env) {
  const timeoutMs = Number.parseInt(env.OPENROUTER_TIMEOUT_MS || '', 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

function buildSystemPrompt() {
  return [
    'You are a bank fraud analyst assistant.',
    'Assess fraud risk for a single transaction using the provided transaction context.',
    'Use a strict additive rubric so the same input is scored the same way across repeated evaluations.',
    'Score signals independently and do not change the weighting based on narrative wording or tone.',
    'Priority order: absolute amount, amount relative to usualAmount, location relative to usualLocation, velocity, merchantRisk, newDevice, newPayee.',
    'Treat absolute amount as the highest-priority standalone signal.',
    'Compare amount to usualAmount and add risk when the transaction is materially larger than normal.',
    'Compare location to usualLocation and add risk when the transaction occurs in a meaningfully different place.',
    'Use velocity as an additive signal where higher velocity increases risk.',
    'Treat merchantRisk as additive, with high above medium above low.',
    'If merchantContext is present, use exact-match whitelist and blacklist results as additional evidence and do not broaden the match beyond the normalized merchant name.',
    'Treat newDevice and newPayee as separate additive signals that each increase risk when true.',
    'Do not double count the same signal.',
    'Return only JSON that matches the required schema.',
    'Output format requirements:',
    '- status: "Flagged" or "Not Flagged"',
    '- riskScore: integer from 0 to 100',
    '- flagged: boolean consistent with status',
    '- reasons: 1 to 5 concise evidence-based reasons'
  ].join('\n');
}

function buildRequestBody(payload, model, merchantLookup) {
  const requestPayload = { transaction: payload };

  if (payload.merchantName && merchantLookup?.buildFraudReviewContext) {
    const merchantContext = merchantLookup.buildFraudReviewContext(payload.merchantName);
    if (merchantContext) {
      requestPayload.merchantContext = merchantContext;
    }
  }

  return {
    model,
    // Keep generation as deterministic as possible for a score-oriented endpoint.
    temperature: 0,
    stream: false,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'fraud_decision',
        strict: true,
        schema: fraudDecisionSchema
      }
    },
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt()
      },
      {
        role: 'user',
        content: JSON.stringify(requestPayload, null, 2)
      }
    ]
  };
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

  return '';
}

function stripCodeFence(text) {
  const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : text;
}

function parseChoiceContent(content) {
  const normalized = normalizeChoiceText(content);

  if (!normalized) {
    throw new FraudReviewError('OpenRouter response did not include usable message content');
  }

  try {
    return JSON.parse(stripCodeFence(normalized));
  } catch (error) {
    throw new FraudReviewError(`Unable to parse LLM review payload: ${error.message}`);
  }
}

function validateDecisionShape(decision) {
  if (!validateFraudDecision(decision)) {
    const schemaErrors = ajv.errorsText(validateFraudDecision.errors, { separator: '; ' });
    throw new FraudReviewError(`OpenRouter returned schema-invalid JSON: ${schemaErrors}`);
  }

  const expectedFlagged = decision.riskScore >= 55;
  if (decision.flagged !== expectedFlagged) {
    throw new FraudReviewError('OpenRouter response is internally inconsistent: flagged does not match riskScore threshold');
  }

  const expectedStatus = decision.flagged ? 'Flagged' : 'Not Flagged';
  if (decision.status !== expectedStatus) {
    throw new FraudReviewError('OpenRouter response is internally inconsistent: status does not match flagged');
  }

  return decision;
}

async function sendOpenRouterRequest(fetchImpl, env, requestBody) {
  let response;

  try {
    response = await fetchImpl(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(getTimeoutMs(env))
    });
  } catch (error) {
    throw new FraudReviewError(`OpenRouter request failed: ${error.message}`);
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    throw new FraudReviewError(
      `OpenRouter request failed with status ${response.status}${responseText ? `: ${responseText}` : ''}`
    );
  }

  let completion;
  try {
    completion = await response.json();
  } catch (error) {
    throw new FraudReviewError(`OpenRouter returned invalid JSON: ${error.message}`);
  }

  return completion;
}

export function createFraudEvaluator({
  fetchImpl = fetch,
  env = process.env,
  merchantLookup = defaultMerchantLookup
} = {}) {
  return async function evaluateFraud(payload) {
    if (!env.OPENROUTER_API_KEY) {
      throw new FraudReviewError('OPENROUTER_API_KEY is required');
    }

    const normalizedPayload = normalizeFraudPayload(payload);
    const requestBody = buildRequestBody(
      normalizedPayload,
      env.OPENROUTER_MODEL || DEFAULT_MODEL,
      merchantLookup
    );
    const completion = await sendOpenRouterRequest(fetchImpl, env, requestBody);
    const messageContent = completion?.choices?.[0]?.message?.content;
    const decision = parseChoiceContent(messageContent);
    const validatedDecision = validateDecisionShape(decision);

    return {
      status: validatedDecision.status,
      score: validatedDecision.riskScore,
      flagged: validatedDecision.flagged,
      reasons: validatedDecision.reasons
    };
  };
}

export const evaluateFraud = createFraudEvaluator();
