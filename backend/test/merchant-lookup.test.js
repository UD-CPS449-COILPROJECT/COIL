import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { unlinkSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { createFraudEvaluator } from '../src/fraud/evaluateFraud.js';
import {
  createMerchantLookup,
  loadMerchantRecords,
  normalizeMerchantRecord
} from '../src/merchants/merchantLookup.js';

function createJsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

function createMerchantTestApp() {
  return createApp({
    evaluateFraud: async () => ({
      status: 'Not Flagged',
      score: 0,
      flagged: false,
      reasons: ['merchant route test stub']
    })
  });
}

function getRouteHandler(app, method, path) {
  return app.router.stack.find((entry) => (
    entry.route?.path === path && entry.route?.methods?.[method]
  ))?.route?.stack?.[0]?.handle;
}

async function invokeRoute(app, { method = 'get', path, body, params } = {}) {
  const handler = getRouteHandler(app, method, path);
  let statusCode = 200;
  let jsonBody;

  const req = { body, params: params || {} };
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

  await handler(req, res);

  return {
    status: statusCode,
    body: jsonBody
  };
}

function withTempMerchantFile(fileName, contents, callback) {
  const filePath = fileURLToPath(new URL(`../src/merchants/${fileName}`, import.meta.url));
  writeFileSync(filePath, contents);

  try {
    return callback(`./${fileName}`);
  } finally {
    unlinkSync(filePath);
  }
}

test('merchant lookup indexes canonical names and aliases with normalization', () => {
  const merchantLookup = createMerchantLookup({
    whitelist: [
      {
        name: 'Trusted Merchant',
        aliases: ['Trusted Merchant LLC']
      }
    ],
    blacklist: [
      {
        name: 'Shady Vendor',
        aliases: ['Shady Vendor LLC']
      }
    ]
  });

  assert.deepEqual(merchantLookup.lookupWhitelist('  trusted   merchant llc  '), {
    found: true,
    name: 'Trusted Merchant',
    aliases: ['Trusted Merchant LLC']
  });
  assert.deepEqual(merchantLookup.lookupBlacklist('shady vendor'), {
    found: true,
    name: 'Shady Vendor',
    aliases: ['Shady Vendor LLC']
  });
  assert.deepEqual(merchantLookup.lookupWhitelist('missing merchant'), {
    found: false
  });
});

test('merchant lookup returns not found for blank names and missing contexts', () => {
  const merchantLookup = createMerchantLookup({
    whitelist: [
      {
        name: 'Trusted Merchant',
        aliases: ['Trusted Merchant LLC']
      }
    ]
  });

  assert.deepEqual(merchantLookup.lookupWhitelist('   '), {
    found: false
  });
  assert.equal(merchantLookup.buildFraudReviewContext('   '), null);
  assert.equal(merchantLookup.buildFraudReviewContext('missing merchant'), null);
});

test('merchant lookup builds fraud review context for matched merchants', () => {
  const merchantLookup = createMerchantLookup({
    whitelist: [
      {
        name: 'Trusted Merchant',
        aliases: ['Trusted Merchant LLC']
      }
    ],
    blacklist: [
      {
        name: 'Shady Vendor',
        aliases: ['Shady Vendor LLC']
      }
    ]
  });

  assert.deepEqual(merchantLookup.buildFraudReviewContext('Trusted Merchant LLC'), {
    merchantName: 'Trusted Merchant LLC',
    whitelist: {
      found: true,
      name: 'Trusted Merchant',
      aliases: ['Trusted Merchant LLC']
    },
    blacklist: {
      found: false
    }
  });
});

test('merchant record normalization rejects malformed records', () => {
  assert.throws(
    () => normalizeMerchantRecord(null, 'whitelist.json', 0),
    /must be an object/
  );
  assert.throws(
    () => normalizeMerchantRecord({}, 'whitelist.json', 0),
    /missing a merchant name/
  );
  assert.deepEqual(
    normalizeMerchantRecord(
      {
        name: 'Alias Merchant',
        aliases: ['  alias one  ', '', null, 'alias two', '   ']
      },
      'whitelist.json',
      0
    ),
    {
      name: 'Alias Merchant',
      aliases: ['alias one', 'alias two']
    }
  );
});

test('merchant file loading rejects non-array JSON payloads', () => {
  assert.throws(
    () => withTempMerchantFile('.merchant-lookup-test-fixture.json', '{"name":"not-an-array"}', (relativeFileName) => {
      loadMerchantRecords(relativeFileName);
    }),
    /must be a JSON array/
  );
});

test('GET /merchants/whitelist/:name and GET /merchants/blacklist/:name return lookup responses', async () => {
  const app = createMerchantTestApp();

  const whitelistResponse = await invokeRoute(app, {
    method: 'get',
    path: '/merchants/whitelist/:name',
    params: { name: '  Costco  ' }
  });
  const blacklistResponse = await invokeRoute(app, {
    method: 'get',
    path: '/merchants/blacklist/:name',
    params: { name: 'Wire Transfer Fraud LLC' }
  });

  assert.equal(whitelistResponse.status, 200);
  assert.deepEqual(whitelistResponse.body, {
    found: true,
    name: 'Costco Wholesale',
    aliases: ['Costco']
  });
  assert.equal(blacklistResponse.status, 200);
  assert.deepEqual(blacklistResponse.body, {
    found: true,
    name: 'Wire Transfer Scam LLC',
    aliases: ['Wire Transfer Fraud LLC']
  });
});

test('fraud evaluator adds merchant lookup context when merchantName is provided', async () => {
  let capturedMerchantContext;
  let capturedTransaction;
  const merchantLookup = {
    buildFraudReviewContext(name) {
      assert.equal(name, 'Trusted Merchant LLC');
      return {
        merchantName: 'Trusted Merchant LLC',
        whitelist: {
          found: true,
          name: 'Trusted Merchant',
          aliases: ['Trusted Merchant LLC']
        },
        blacklist: {
          found: false
        }
      };
    }
  };

  const evaluateFraud = createFraudEvaluator({
    merchantLookup,
    fetchImpl: async (_url, options) => {
      const requestBody = JSON.parse(options.body);
      const promptPayload = JSON.parse(requestBody.messages[1].content);
      capturedTransaction = promptPayload.transaction;
      capturedMerchantContext = promptPayload.merchantContext;

      return createJsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: 'Not Flagged',
                riskScore: 0,
                flagged: false,
                reasons: ['merchant lookup context was attached']
              })
            }
          }
        ]
      });
    },
    env: {
      OPENROUTER_API_KEY: 'test-key'
    }
  });

  const result = await evaluateFraud({
    amount: 25,
    usualAmount: 25,
    location: 'Dallas, US',
    usualLocation: 'Dallas, US',
    velocity: 0,
    merchantRisk: 'low',
    merchantName: ' Trusted Merchant LLC '
  });

  assert.deepEqual(result, {
    status: 'Not Flagged',
    score: 0,
    flagged: false,
    reasons: ['merchant lookup context was attached']
  });
  assert.deepEqual(capturedTransaction, {
    amount: 25,
    usualAmount: 25,
    location: 'Dallas, US',
    usualLocation: 'Dallas, US',
    velocity: 0,
    merchantRisk: 'low',
    newDevice: false,
    newPayee: false,
    merchantName: 'Trusted Merchant LLC'
  });
  assert.deepEqual(capturedMerchantContext, {
    merchantName: 'Trusted Merchant LLC',
    whitelist: {
      found: true,
      name: 'Trusted Merchant',
      aliases: ['Trusted Merchant LLC']
    },
    blacklist: {
      found: false
    }
  });
});
