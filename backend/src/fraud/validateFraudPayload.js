// Validates incoming fraud-check payloads before scoring to keep responses predictable.
export function validateFraudPayload(payload) {
  const errors = [];
  const requiredFields = [
    'amount',
    'usualAmount',
    'location',
    'usualLocation',
    'velocity',
    // Merchant identity is now caller-provided so the backend can own exact-match lookup.
    'merchantName'
  ];

  for (const field of requiredFields) {
    if (payload[field] === undefined || payload[field] === null || `${payload[field]}`.trim() === '') {
      errors.push(`${field} is required`);
    }
  }

  if (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) <= 0) {
    errors.push('amount must be a number greater than 0');
  }

  if (!Number.isFinite(Number(payload.usualAmount)) || Number(payload.usualAmount) <= 0) {
    errors.push('usualAmount must be a number greater than 0');
  }

  if (!Number.isFinite(Number(payload.velocity)) || Number(payload.velocity) < 0) {
    errors.push('velocity must be a number greater than or equal to 0');
  }

  return errors;
}
