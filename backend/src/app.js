import express from 'express';
import cors from 'cors';
import { evaluateFraud as defaultEvaluateFraud } from './fraud/evaluateFraud.js';
import { validateFraudPayload } from './fraud/validateFraudPayload.js';

// Creates the Express application with all service routes and middleware.
export function createApp({ evaluateFraud = defaultEvaluateFraud } = {}) {
  const app = express();

  // Keep request parsing and CORS consistent for browser-hosted frontend callers.
  app.use(express.urlencoded({ extended: false }));
  app.use(cors());
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.send('Microservice Gateway\nVersion: 0.0.1');
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
      const result = await evaluateFraud(payload);

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
