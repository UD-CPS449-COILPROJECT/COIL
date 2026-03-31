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

function createDecisionResponse(decision, { fenced = false } = {}) {
  const payload = JSON.stringify(decision);
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

function createAppWithFetch(fetchImpl, env = {}) {
  return createApp({
    evaluateFraud: createFraudEvaluator({
      fetchImpl,
      env: {
        OPENROUTER_API_KEY: 'test-key',
        OPENROUTER_MODEL: 'openrouter/free',
        OPENROUTER_TIMEOUT_MS: '15000',
        ...env
      }
    })
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

test('POST /fraud-check uses OpenRouter decision output when schema-valid', async () => {
  let capturedRequest;
  const app = createAppWithFetch(async (_url, options) => {
    capturedRequest = JSON.parse(options.body);
    return createDecisionResponse({
      status: 'Flagged',
      riskScore: 93,
      flagged: true,
      reasons: [
        'transaction amount is much higher than normal behavior',
        'transaction location differs from historical activity',
        'merchant category has elevated fraud risk',
        'payment came from a previously unseen device'
      ]
    });
  });

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: 'Flagged',
    riskScore: 93,
    flagged: true,
    reasons: [
      'transaction amount is much higher than normal behavior',
      'transaction location differs from historical activity',
      'merchant category has elevated fraud risk',
      'payment came from a previously unseen device'
    ]
  });
  assert.equal(capturedRequest.model, 'openrouter/free');
  assert.equal(capturedRequest.response_format.type, 'json_schema');
  assert.deepEqual(capturedRequest.response_format.json_schema.schema.required, ['status', 'riskScore', 'flagged', 'reasons']);
  assert.equal(capturedRequest.messages[1].content.includes('ACC-2026-001'), true);
  assert.equal(capturedRequest.messages[1].content.includes('5000'), true);
});

test('POST /fraud-check accepts fenced JSON when content is otherwise schema-valid', async () => {
  const app = createAppWithFetch(async () => createDecisionResponse({
      status: 'Not Flagged',
      riskScore: 40,
      flagged: false,
      reasons: ['amount and behavior align with known account history']
    }, { fenced: true }));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'Not Flagged');
  assert.equal(response.body.riskScore, 40);
  assert.equal(response.body.flagged, false);
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

test('POST /fraud-check returns 500 when OPENROUTER_API_KEY is missing', async () => {
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

test('POST /fraud-check returns 500 when OpenRouter returns non-OK status', async () => {
  const app = createAppWithFetch(async () => createJsonResponse(
      { error: { message: 'Provider returned error' } },
      { ok: false, status: 429 }
    ));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Fraud review failed' });
});

test('POST /fraud-check returns 500 when OpenRouter returns malformed JSON payload text', async () => {
  const app = createAppWithFetch(async () => createJsonResponse({
      choices: [
        {
          message: {
            content: '{"status":"Flagged"'
          }
        }
      ]
    }));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Fraud review failed' });
});

test('POST /fraud-check returns 500 when OpenRouter JSON fails schema validation', async () => {
  const app = createAppWithFetch(async () => createDecisionResponse({
      status: 'Flagged',
      riskScore: 90,
      flagged: true
    }));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Fraud review failed' });
});

test('POST /fraud-check returns 500 when flagged is inconsistent with riskScore threshold', async () => {
  const app = createAppWithFetch(async () => createDecisionResponse({
      status: 'Not Flagged',
      riskScore: 88,
      flagged: false,
      reasons: ['output is inconsistent by design for this test']
    }));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Fraud review failed' });
});
