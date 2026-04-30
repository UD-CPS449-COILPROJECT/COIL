import { readFileSync } from 'node:fs';

function normalizeMerchantName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizeMerchantRecord(record, sourceName, index) {
  if (!record || typeof record !== 'object') {
    throw new Error(`Merchant list ${sourceName} entry ${index + 1} must be an object`);
  }

  const name = String(record.name || '').trim();
  if (!name) {
    throw new Error(`Merchant list ${sourceName} entry ${index + 1} is missing a merchant name`);
  }

  const aliases = Array.isArray(record.aliases)
    ? record.aliases
        .map((alias) => String(alias || '').trim())
        .filter((alias) => alias.length > 0)
    : [];

  return { name, aliases };
}

export function loadMerchantRecords(fileName) {
  const fileUrl = new URL(fileName, import.meta.url);
  const rawRecords = JSON.parse(readFileSync(fileUrl, 'utf8'));

  if (!Array.isArray(rawRecords)) {
    throw new Error(`Merchant list ${fileName} must be a JSON array`);
  }

  return rawRecords.map((record, index) => normalizeMerchantRecord(record, fileName, index));
}

function buildMerchantIndex(records) {
  const index = new Map();

  // Index both the canonical merchant name and every alias so lookups stay exact after normalization.
  for (const record of records) {
    for (const key of [record.name, ...record.aliases]) {
      const normalized = normalizeMerchantName(key);
      if (normalized && !index.has(normalized)) {
        index.set(normalized, record);
      }
    }
  }

  return index;
}

function findMerchant(index, rawName) {
  const normalizedName = normalizeMerchantName(rawName);
  if (!normalizedName) {
    return null;
  }

  return index.get(normalizedName) || null;
}

function toLookupResponse(record) {
  if (!record) {
    return { found: false };
  }

  return {
    found: true,
    name: record.name,
    aliases: [...record.aliases]
  };
}

const defaultWhitelist = loadMerchantRecords('./whitelist.json');
const defaultBlacklist = loadMerchantRecords('./blacklist.json');

export function createMerchantLookup({
  whitelist = defaultWhitelist,
  blacklist = defaultBlacklist
} = {}) {
  const whitelistIndex = buildMerchantIndex(whitelist);
  const blacklistIndex = buildMerchantIndex(blacklist);

  return {
    lookupWhitelist(name) {
      return toLookupResponse(findMerchant(whitelistIndex, name));
    },
    lookupBlacklist(name) {
      return toLookupResponse(findMerchant(blacklistIndex, name));
    },
    buildFraudReviewContext(name) {
      const whitelistMatch = findMerchant(whitelistIndex, name);
      const blacklistMatch = findMerchant(blacklistIndex, name);

      if (!whitelistMatch && !blacklistMatch) {
        return null;
      }

      return {
        merchantName: String(name || '').trim(),
        whitelist: toLookupResponse(whitelistMatch),
        blacklist: toLookupResponse(blacklistMatch)
      };
    }
  };
}

export const defaultMerchantLookup = createMerchantLookup();
