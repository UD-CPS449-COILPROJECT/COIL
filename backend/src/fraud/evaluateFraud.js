function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toBoolean(value) {
  return value === true || value === 'true' || value === '1';
}

// Encapsulates the fraud-score scoring formula used by the UI.
export function evaluateFraud(payload) {
  const amount = Number(payload.amount);
  const usualAmount = Number(payload.usualAmount);
  const location = String(payload.location || '').trim().toLowerCase();
  const usualLocation = String(payload.usualLocation || '').trim().toLowerCase();
  const velocity = Number(payload.velocity);
  const merchantRisk = String(payload.merchantRisk || 'low').toLowerCase();
  const newDevice = toBoolean(payload.newDevice);
  const newPayee = toBoolean(payload.newPayee);

  let score = 8;
  const reasons = [];

  const amountRatio = usualAmount > 0 ? amount / usualAmount : 1;
  if (amountRatio >= 4) {
    score += 36;
    reasons.push('amount is far above normal spending behavior');
  } else if (amountRatio >= 2) {
    score += 20;
    reasons.push('amount is above the account\'s usual range');
  }

  if (location && usualLocation && location !== usualLocation) {
    score += 22;
    reasons.push('transaction location differs from the user\'s usual location');
  }

  if (velocity >= 8) {
    score += 20;
    reasons.push('unusually high number of recent transactions');
  } else if (velocity >= 4) {
    score += 10;
    reasons.push('elevated transaction velocity in last 24 hours');
  }

  if (merchantRisk === 'high') {
    score += 14;
    reasons.push('merchant category is marked as high risk');
  } else if (merchantRisk === 'medium') {
    score += 6;
  }

  if (newDevice) {
    score += 12;
    reasons.push('transaction initiated from a new device');
  }

  if (newPayee) {
    score += 12;
    reasons.push('payment is sent to a new payee');
  }

  score = clamp(Math.round(score), 0, 100);
  const flagged = score >= 55;
  const status = flagged ? 'Flagged' : 'Not Flagged';

  return {
    status,
    score,
    flagged,
    reasons
  };
}
