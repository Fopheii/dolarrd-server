const axios = require('axios');

const BASE_URL = 'https://tasareal.com/api/v1';
const API_KEY  = 'tcrd_7UHk7ktrWzse205CIeGX3v2c64XY15gVbtonXAO9w5BjRFcs';

/**
 * Fetches USD exchange rates from the TasaReal API.
 *
 * Response shape: { rates: [ { institution, name, type, buy, sell, updated_at }, ... ] }
 */
async function fetchTasareal() {
  const { data } = await axios.get(`${BASE_URL}/rates?currency=USD`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    timeout: 15000,
  });

  const raw = data.rates ?? [];
  return raw.map(normalize).filter(Boolean);
}

function normalize(entity) {
  if (!entity || !entity.institution) return null;

  const type = mapType(entity.institution_type ?? '');
  if (!type) return null;

  return {
    name:         (entity.institution_name ?? entity.institution).trim(),
    type,
    buy_rate:     parseRate(entity.buy),
    sell_rate:    parseRate(entity.sell),
    fee:          null,
    source:       'tasareal',
    last_updated: entity.date ? `${entity.date}T00:00:00Z` : new Date().toISOString(),
  };
}

function mapType(raw) {
  const s = String(raw).toLowerCase();
  if (s.includes('bank') || s.includes('banco') || s === 'official') return 'bank';
  if (s.includes('remit'))                                            return 'remittance';
  if (s.includes('exchange') || s.includes('casa') || s.includes('cambio')) return 'exchange';
  return null;
}

function parseRate(val) {
  if (val == null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

module.exports = { fetchTasareal };
