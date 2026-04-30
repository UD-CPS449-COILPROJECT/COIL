import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createFraudEvaluator } from '../src/fraud/evaluateFraud.js';

const highRiskPayload = {
  amount: 5000,
  usualAmount: 250,
  location: 'New York, US',
  usualLocation: 'Dayton, US',
  velocity: 6,
  merchantName: 'Costco Wholesale',
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

function getRouteHandler(app, method, path) {
  // Direct handler invocation keeps these unit tests fast without opening a port.
  return app.router.stack.find((entry) => (
    entry.route?.path === path && entry.route?.methods?.[method]
  ))?.route?.stack?.[0]?.handle;
}

async function getFraudCheckHandler(app) {
  return getRouteHandler(app, 'post', '/fraud-check');
}

async function invokeRoute(app, { method = 'get', path, body } = {}) {
  const handler = getRouteHandler(app, method, path);
  let statusCode = 200;
  let jsonBody;
  let textBody;

  const req = { body };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      jsonBody = payload;
      return this;
    },
    send(payload) {
      textBody = payload;
      return this;
    }
  };

  await handler(req, res);

  return {
    status: statusCode,
    body: jsonBody,
    text: textBody
  };
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

test('GET / and GET /health return startup responses', async () => {
  const app = createApp();

  const rootResponse = await invokeRoute(app, { path: '/' });
  const healthResponse = await invokeRoute(app, { path: '/health' });

  assert.equal(rootResponse.status, 200);
  assert.equal(rootResponse.text, 'Microservice Gateway\nVersion: 0.2.1');
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(healthResponse.body, { status: 'ok', message: 'Backend is running' });
});

test('POST /analyze classifies supported banking text', async () => {
  const app = createApp();
  const cases = [
    ['please deposit this check', 'deposit request'],
    ['I need to withdraw cash', 'withdraw request'],
    ['transfer money to savings', 'transfer request'],
    ['show my balance', 'balance inquiry'],
    ['what can you do for me?', 'unknown request']
  ];

  for (const [text, prediction] of cases) {
    const response = await invokeRoute(app, {
      method: 'post',
      path: '/analyze',
      body: { text }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { input: text, prediction });
  }
});

test('POST /analyze returns 400 when text is missing', async () => {
  const app = createApp();

  const response = await invokeRoute(app, {
    method: 'post',
    path: '/analyze',
    body: {}
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: 'Text input is required' });
});

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
  assert.equal(capturedRequest.messages[1].content.includes('5000'), true);
  assert.equal(capturedRequest.temperature, 0);
});

test('POST /fraud-check sends a strict additive fraud-scoring rubric to OpenRouter', async () => {
  let capturedRequest;
  const app = createAppWithFetch(async (_url, options) => {
    capturedRequest = JSON.parse(options.body);
    return createDecisionResponse({
      status: 'Not Flagged',
      riskScore: 12,
      flagged: false,
      reasons: ['prompt rubric is captured for regression coverage']
    });
  });

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 200);
  assert.ok(capturedRequest.messages[0].content.includes('Use a strict additive rubric'));
  assert.ok(capturedRequest.messages[0].content.includes('absolute amount, amount relative to usualAmount, location relative to usualLocation, velocity, merchantContext, newDevice, newPayee'));
  assert.ok(capturedRequest.messages[0].content.includes('merchantContext as advisory merchant evidence'));
  assert.ok(capturedRequest.messages[0].content.includes('Treat absolute amount as the highest-priority standalone signal'));
  assert.ok(capturedRequest.messages[0].content.includes('Do not double count the same signal'));
  assert.equal(capturedRequest.temperature, 0);
});

test('POST /fraud-check normalizes text payload values before review', async () => {
  let capturedTransaction;
  const app = createApp({
    evaluateFraud: createFraudEvaluator({
      fetchImpl: async (_url, options) => {
        const requestBody = JSON.parse(options.body);
        capturedTransaction = JSON.parse(requestBody.messages[1].content).transaction;

        return createDecisionResponse({
          status: 'Flagged',
          riskScore: 56,
          flagged: true,
          reasons: ['string inputs normalize before reaching OpenRouter']
        });
      },
      env: {
        OPENROUTER_API_KEY: 'test-key'
      }
    })
  });

  const response = await invokeFraudCheck(app, {
    amount: '5000',
    usualAmount: '250',
    location: ' New York, US ',
    usualLocation: ' Dayton, US ',
    velocity: '6',
    merchantName: ' Costco Wholesale ',
    newDevice: '1',
    newPayee: 'true'
  });

  assert.equal(response.status, 200);
  assert.deepEqual(capturedTransaction, {
    amount: 5000,
    usualAmount: 250,
    location: 'New York, US',
    usualLocation: 'Dayton, US',
    velocity: 6,
    merchantName: 'Costco Wholesale',
    newDevice: true,
    newPayee: true
  });
});

test('fraud evaluator falls back for omitted optional-normalized fields', async () => {
  let capturedTransaction;
  const evaluateFraud = createFraudEvaluator({
    fetchImpl: async (_url, options) => {
      const requestBody = JSON.parse(options.body);
      capturedTransaction = JSON.parse(requestBody.messages[1].content).transaction;

      return createDecisionResponse({
        status: 'Not Flagged',
        riskScore: 5,
        flagged: false,
        reasons: ['defaults are used for omitted normalized fields']
      });
    },
    env: {
      OPENROUTER_API_KEY: 'test-key'
    }
  });

  const result = await evaluateFraud({
    amount: 25,
    usualAmount: 40,
    location: 'Dallas, US',
    usualLocation: 'Dallas, US',
    velocity: 0,
    merchantName: 'Unknown Merchant'
  });

  assert.deepEqual(result, {
    status: 'Not Flagged',
    score: 5,
    flagged: false,
    reasons: ['defaults are used for omitted normalized fields']
  });
  assert.deepEqual(capturedTransaction, {
    amount: 25,
    usualAmount: 40,
    location: 'Dallas, US',
    usualLocation: 'Dallas, US',
    velocity: 0,
    merchantName: 'Unknown Merchant',
    newDevice: false,
    newPayee: false
  });
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

test('POST /fraud-check accepts unlabeled fenced JSON and invalid timeout fallback', async () => {
  const decision = {
    status: 'Not Flagged',
    riskScore: 10,
    flagged: false,
    reasons: ['unlabeled fences are accepted']
  };
  const app = createAppWithFetch(async () => createJsonResponse({
    choices: [
      {
        message: {
          content: `\`\`\`\n${JSON.stringify(decision)}\n\`\`\``
        }
      }
    ]
  }), {
    OPENROUTER_TIMEOUT_MS: '0'
  });

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: 'Not Flagged',
    riskScore: 10,
    flagged: false,
    reasons: ['unlabeled fences are accepted']
  });
});

test('POST /fraud-check accepts array-based OpenRouter message content', async () => {
  const decision = {
    status: 'Not Flagged',
    riskScore: 20,
    flagged: false,
    reasons: ['array-form content still contains valid decision JSON']
  };
  const app = createAppWithFetch(async () => createJsonResponse({
    choices: [
      {
        message: {
          content: [
            ' ',
            { text: JSON.stringify(decision) },
            { ignored: 'no text field' },
            null
          ]
        }
      }
    ]
  }));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: 'Not Flagged',
    riskScore: 20,
    flagged: false,
    reasons: ['array-form content still contains valid decision JSON']
  });
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
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Invalid fraud-check input');
  assert.deepEqual(response.body.details, ['amount must be a number greater than 0']);
});

test('POST /fraud-check returns 400 when request body is missing', async () => {
  const app = createApp({
    evaluateFraud: async () => {
      throw new Error('should not be called');
    }
  });

  const response = await invokeFraudCheck(app);

  assert.equal(response.status, 400);
  assert.ok(response.body.details.includes('amount is required'));
  assert.ok(response.body.details.includes('merchantName is required'));
});

test('POST /fraud-check returns 400 when merchantName is blank', async () => {
  const app = createApp({
    evaluateFraud: async () => {
      throw new Error('should not be called');
    }
  });

  const response = await invokeFraudCheck(app, {
    ...highRiskPayload,
    merchantName: '   '
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body.details, ['merchantName is required']);
});

test('POST /fraud-check returns all validation errors for missing numeric fields', async () => {
  const app = createApp({
    evaluateFraud: async () => {
      throw new Error('should not be called');
    }
  });

  const response = await invokeFraudCheck(app, {
    amount: '   ',
    usualAmount: null,
    location: '',
    usualLocation: undefined,
    velocity: -1,
    merchantName: 'Costco Wholesale'
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body.details, [
    'amount is required',
    'usualAmount is required',
    'location is required',
    'usualLocation is required',
    'amount must be a number greater than 0',
    'usualAmount must be a number greater than 0',
    'velocity must be a number greater than or equal to 0'
  ]);
});

test('POST /fraud-check returns numeric validation errors for non-numeric values', async () => {
  const app = createApp({
    evaluateFraud: async () => {
      throw new Error('should not be called');
    }
  });

  const response = await invokeFraudCheck(app, {
    amount: 'not-a-number',
    usualAmount: 'not-a-number',
    location: 'Dayton, US',
    usualLocation: 'Dayton, US',
    velocity: 'not-a-number',
    merchantName: 'Costco Wholesale'
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body.details, [
    'amount must be a number greater than 0',
    'usualAmount must be a number greater than 0',
    'velocity must be a number greater than or equal to 0',
  ]);
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

test('POST /fraud-check returns 500 when OpenRouter fetch fails', async () => {
  const app = createAppWithFetch(async () => {
    throw new Error('network unavailable');
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

test('POST /fraud-check returns 500 when OpenRouter error text is unavailable', async () => {
  const app = createAppWithFetch(async () => ({
    ok: false,
    status: 503,
    async text() {
      throw new Error('body stream unavailable');
    }
  }));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Fraud review failed' });
});

test('POST /fraud-check returns 500 when OpenRouter returns invalid response JSON', async () => {
  const app = createAppWithFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      throw new Error('unexpected token');
    }
  }));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Fraud review failed' });
});

test('POST /fraud-check returns 500 when OpenRouter omits message content', async () => {
  const app = createAppWithFetch(async () => createJsonResponse({
    choices: [
      {
        message: {}
      }
    ]
  }));

  const response = await invokeFraudCheck(app, highRiskPayload);

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Fraud review failed' });
});

test('POST /fraud-check returns 500 when OpenRouter completion is empty', async () => {
  const app = createAppWithFetch(async () => createJsonResponse(null));

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

test('POST /fraud-check returns 500 when status does not match flagged', async () => {
  const app = createAppWithFetch(async () => createDecisionResponse({
      status: 'Flagged',
      riskScore: 30,
      flagged: false,
      reasons: ['output is inconsistent by design for this test']
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
