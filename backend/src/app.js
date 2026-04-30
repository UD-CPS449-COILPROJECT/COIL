import express from 'express';
import cors from 'cors';
import { createFraudEvaluator } from './fraud/evaluateFraud.js';
import { validateFraudPayload } from './fraud/validateFraudPayload.js';
import { defaultMerchantLookup } from './merchants/merchantLookup.js';

// Creates the Express application with all service routes and middleware.
export function createApp({ evaluateFraud } = {}) {
  const fraudEvaluator = evaluateFraud || createFraudEvaluator();
  const app = express();

  // Keep request parsing and CORS consistent for browser-hosted frontend callers.
  app.use(express.urlencoded({ extended: false }));
  app.use(cors());
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.send('Microservice Gateway\nVersion: 0.2.1');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', message: 'Backend is running' });
  });

  app.post('/analyze', (req, res) => {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text input is required' });
    }

    let result = 'unknown request';

    if (text.toLowerCase().includes('deposit')) {
      result = 'deposit request';
    } else if (text.toLowerCase().includes('withdraw')) {
      result = 'withdraw request';
    } else if (text.toLowerCase().includes('transfer')) {
      result = 'transfer request';
    } else if (text.toLowerCase().includes('balance')) {
      result = 'balance inquiry';
    }

    res.json({
      input: text,
      prediction: result
    });
  });

  // These merchant routes are read-only views over the versioned in-repo lookup data.
  app.get('/merchants/whitelist/:name', (req, res) => {
    return res.json(defaultMerchantLookup.lookupWhitelist(req.params.name));
  });

  app.get('/merchants/blacklist/:name', (req, res) => {
    return res.json(defaultMerchantLookup.lookupBlacklist(req.params.name));
  });

  app.post('/fraud-check', async (req, res) => {
    const payload = req.body || {};
    const errors = validateFraudPayload(payload);

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Invalid fraud-check input',
        details: errors
      });
    }

    try {
      const result = await fraudEvaluator(payload);

      // Keep response keys aligned with the frontend renderer.
      return res.json({
        status: result.status,
        riskScore: result.score,
        flagged: result.flagged,
        reasons: result.reasons
      });
    } catch (error) {
      console.error('Fraud review failed', error);
      return res.status(500).json({ error: 'Fraud review failed' });
    }
  });

  return app;
}
