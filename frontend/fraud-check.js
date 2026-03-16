const form = document.getElementById('fraud-form');
const resultBox = document.getElementById('result');
const statusEl = document.getElementById('status');
const riskScoreEl = document.getElementById('riskScore');
const reasonEl = document.getElementById('reason');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const amount = Number(document.getElementById('amount').value);
  const usualAmount = Number(document.getElementById('usualAmount').value);
  const location = document.getElementById('location').value.trim().toLowerCase();
  const usualLocation = document.getElementById('usualLocation').value.trim().toLowerCase();
  const velocity = Number(document.getElementById('velocity').value);
  const merchantRisk = document.getElementById('merchantRisk').value;
  const newDevice = document.getElementById('newDevice').checked;
  const newPayee = document.getElementById('newPayee').checked;

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

  resultBox.classList.remove('neutral', 'safe', 'flagged');
  resultBox.classList.add(flagged ? 'flagged' : 'safe');

  statusEl.textContent = status;
  riskScoreEl.textContent = String(score);

  if (reasons.length === 0) {
    reasonEl.textContent = 'Low-risk profile based on provided inputs.';
  } else {
    reasonEl.textContent = `Key signals: ${reasons.join('; ')}.`;
  }
});
