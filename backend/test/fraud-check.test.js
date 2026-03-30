import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createFraudEvaluator } from '../src/fraud/evaluateFraud.js';

const highRiskPayload = {
  accountId: 'ACC-2026-001',
  amount: 5000,
  usualAmount: 250,
  location: 'New York, US',
  usualLocation: 'Dayton, US',
  velocity: 6,
  merchantRisk: 'high',
  newDevice: true,
  newPayee: false
};

const merchantRiskPayload = {
  accountId: 'ACC-2026-003',
  amount: 1000,
  usualAmount: 200,
  location: 'denver',
  usualLocation: 'dayton',
  velocity: 2,
  merchantRisk: 'low',
  newDevice: true,
  newPayee: false
};

const deterministicHighRiskReasons = [
  'amount is far above the account\'s usual range',
  'transaction location differs from the usual location',
  'merchant category is marked as high risk',
  'transaction originated from a new device'
];

const deterministicHighRiskResponse = {
  status: 'Flagged',
  riskScore: 100,
  flagged: true,
  reasons: deterministicHighRiskReasons
};

const explanationReasons = [
  'amount is far above the account\'s typical activity',
  'transaction location differs from the usual profile',
  'merchant category is considered high risk',
  'the payment came from a new device'
];

function createJsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

function createTimeoutError(message = 'The operation was aborted due to timeout') {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function createExplanationResponse(reasons, { fenced = false } = {}) {
  const payload = JSON.stringify({ reasons });
  const content = fenced ? `\`\`\`json\n${payload}\n\`\`\`` : payload;

  return createJsonResponse({
    choices: [
      {
        message: {
          content
        }
      }
    ]
  });
}

function createEvaluator(fetchImpl, env = {}) {
  return createFraudEvaluator({
    fetchImpl,
    env: {
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_MODEL: 'openrouter/free',
      OPENROUTER_TIMEOUT_MS: '15000',
      ...env
    }
  });
}

function createAppWithFetch(fetchImpl, env = {}) {
  return createApp({
    evaluateFraud: createEvaluator(fetchImpl, env)
  });
}

async function getFraudCheckHandler(app) {
  return app.router.stack.find((entry) => entry.route?.path === '/fraud-check')?.route?.stack?.[0]?.handle;
}

async function invokeFraudCheck(app, body) {
  const handler = await getFraudCheckHandler(app);
  let statusCode = 200;
  let jsonBody;
  const originalConsoleError = console.error;

  const req = { body };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      jsonBody = payload;
      return this;
    }
  };

  console.error = () => {};

  try {
    await handler(req, res);
  } finally {
    console.error = originalConsoleError;
  }

  return {
    status: statusCode,
    body: jsonBody
  };
}

function assertPrimaryRequestShape(requestBody) {
  assert.equal(requestBody.model, 'openrouter/free');
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.provider.require_parameters, true);
  assert.deepEqual(requestBody.plugins, [{ id: 'response-healing' }]);
  assert.deepEqual(requestBody.response_format.json_schema.schema.required, ['reasons']);
}

function assertFallbackRequestShape(requestBody) {
  assert.equal(requestBody.response_format, undefined);
  assert.equal(requestBody.provider, undefined);
  assert.equal(requestBody.plugins, undefined);
  assert.equal(requestBody.stream, false);
}

function assertDeterministicHighRiskResponse(response) {
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, deterministicHighRiskResponse);
}

test('POST /fraud-check uses deterministic scoring and only takes explanations from the LLM', async () => {
  let capturedRequest;
  const app = createAppWithFetch(async (_url, options) => {
    capturedRequest = JSON.parse(options.body);
    return createExplanationResponse(explanationReasons);
  });

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: 'Flagged',
    riskScore: 100,
    flagged: true,
    reasons: explanationReasons
  });
  assertPrimaryRequestShape(capturedRequest);
  assert.equal(capturedRequest.messages[1].content.includes('ACC-2026-001'), false);
  assert.equal(capturedRequest.messages[1].content.includes('"riskScore": 100'), true);
  assert.equal(capturedRequest.messages[1].content.includes('amount is far above the account\'s usual range'), true);
});

test('POST /fraud-check retries with a simpler OpenRouter request after compatibility 404s', async () => {
  const requestBodies = [];
  const app = createAppWithFetch(async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));

    if (requestBodies.length === 1) {
      return createJsonResponse(
        '{"error":{"message":"No endpoints found that can handle the requested parameters."}}',
        {
          ok: false,
          status: 404
        }
      );
    }

    return createExplanationResponse([
      'amount is substantially above the usual range',
      'transaction location differs from the usual location',
      'merchant category is high risk',
      'transaction originated from a new device'
    ], { fenced: true });
  });

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 200);
  assert.equal(response.body.riskScore, 100);
  assert.equal(response.body.flagged, true);
  assert.equal(requestBodies.length, 2);
  assertPrimaryRequestShape(requestBodies[0]);
  assertFallbackRequestShape(requestBodies[1]);
});

test('POST /fraud-check falls back to deterministic reasons when the LLM returns contradictory meta commentary', async () => {
  const app = createAppWithFetch(async () => createExplanationResponse([
      'low risk overall',
      'safe routine purchase',
      'not flagged by the model',
      'benign account activity'
    ]));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assertDeterministicHighRiskResponse(response);
});

test('POST /fraud-check returns 400 for invalid request payloads', async () => {
  const app = createApp({
    evaluateFraud: async () => {
      throw new Error('should not be called');
    }
  });

  const response = await invokeFraudCheck(app, {
    ...highRiskPayload,
    amount: 0,
    merchantRisk: 'extreme'
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Invalid fraud-check input');
  assert.ok(response.body.details.includes('amount must be a number greater than 0'));
  assert.ok(response.body.details.includes('merchantRisk must be one of low, medium, high'));
});

test('POST /fraud-check still returns 500 when OPENROUTER_API_KEY is missing', async () => {
  const app = createApp({
    evaluateFraud: createFraudEvaluator({
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      },
      env: {}
    })
  });

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Fraud review failed' });
});

const nonFatalFallbackScenarios = [
  {
    name: 'provider 429 errors',
    fetchImpl: async () => createJsonResponse(
      '{"error":{"message":"Provider returned error","code":429}}',
      { ok: false, status: 429 }
    ),
    expectedRequestCount: 1
  },
  {
    name: 'both explanation attempts time out',
    fetchImpl: async () => {
      throw createTimeoutError();
    },
    expectedRequestCount: 2
  },
  {
    name: 'explanation payloads are malformed',
    fetchImpl: async () => createJsonResponse({
      choices: [
        {
          message: {
            content: '{"reasons": ["broken json"]'
          }
        }
      ]
    }),
    expectedRequestCount: 2
  },
  {
    name: 'explanation payloads fail validation',
    fetchImpl: async () => createExplanationResponse([]),
    expectedRequestCount: 2
  }
];

for (const scenario of nonFatalFallbackScenarios) {
  test(`POST /fraud-check returns a deterministic result when ${scenario.name}`, async () => {
    let requestCount = 0;
    const app = createAppWithFetch(async (...args) => {
      requestCount += 1;
      return await scenario.fetchImpl(...args);
    });

    const response = await invokeFraudCheck(app, highRiskPayload);

    assertDeterministicHighRiskResponse(response);
    assert.equal(requestCount, scenario.expectedRequestCount);
  });
}

test('merchant risk scoring is monotonic from low to medium to high', async () => {
  const app = createAppWithFetch(async () => createExplanationResponse([
      'amount is far above the account\'s usual range',
      'transaction location differs from the usual location',
      'transaction originated from a new device',
      'merchant category carries additional risk'
    ]));

  const lowRiskResponse = await invokeFraudCheck(app, {
    ...merchantRiskPayload,
    merchantRisk: 'low'
  });
  const mediumRiskResponse = await invokeFraudCheck(app, {
    ...merchantRiskPayload,
    merchantRisk: 'medium'
  });
  const highRiskResponse = await invokeFraudCheck(app, {
    ...merchantRiskPayload,
    merchantRisk: 'high'
  });

  assert.equal(lowRiskResponse.body.riskScore, 79);
  assert.equal(mediumRiskResponse.body.riskScore, 85);
  assert.equal(highRiskResponse.body.riskScore, 93);
  assert.ok(highRiskResponse.body.riskScore >= mediumRiskResponse.body.riskScore);
  assert.ok(mediumRiskResponse.body.riskScore >= lowRiskResponse.body.riskScore);
});

test('POST /fraud-check keeps threshold behavior around 54 and 55', async () => {
  const evaluateFraud = createFraudEvaluator({
    fetchImpl: async (_url, options) => {
      const requestBody = JSON.parse(options.body);
      const explanationInput = JSON.parse(requestBody.messages[1].content);
      return createExplanationResponse(explanationInput.signals);
    },
    env: {
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_MODEL: 'openrouter/free',
      OPENROUTER_TIMEOUT_MS: '15000'
    }
  });

  const score54 = await evaluateFraud({
    accountId: 'ACC-54',
    amount: 200,
    usualAmount: 200,
    location: 'denver',
    usualLocation: 'dayton',
    velocity: 4,
    merchantRisk: 'high',
    newDevice: false,
    newPayee: false
  });

  const score55 = await evaluateFraud({
    accountId: 'ACC-55',
    amount: 400,
    usualAmount: 200,
    location: 'dayton',
    usualLocation: 'dayton',
    velocity: 2,
    merchantRisk: 'high',
    newDevice: true,
    newPayee: false
  });

  assert.deepEqual(score54, {
    status: 'Not Flagged',
    score: 54,
    flagged: false,
    reasons: [
      'transaction location differs from the usual location',
      'merchant category is marked as high risk',
      'elevated transaction velocity in the last 24 hours'
    ]
  });
  assert.deepEqual(score55, {
    status: 'Flagged',
    score: 55,
    flagged: true,
    reasons: [
      'amount is above the account\'s usual range',
      'merchant category is marked as high risk',
      'transaction originated from a new device'
    ]
  });
});
