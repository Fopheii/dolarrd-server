const axios = require('axios');
const cheerio = require('cheerio');

const URL = 'https://www.bancentral.gov.do/SectorExterno/HistoricoTasas';

/**
 * Scrapes the official USD reference rate from Banco Central de la República Dominicana.
 * The page lists historical rates — we grab the most recent row.
 *
 * Banco Central only publishes a single "reference" rate, not a buy/sell spread.
 * We store it as both buy_rate and sell_rate so the data model stays consistent.
 */
async function scrapeBancentral() {
  const { data: html } = await axios.get(URL, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DolarRD-Bot/1.0)' },
  });

  console.log('Banco Central HTML:', html.substring(0, 2000));

  const $ = cheerio.load(html);

  let reference_rate = null;
  let rate_date = null;

  // The table has rows ordered newest-first (or oldest-first).
  // We scan all rows and take the last valid one to be safe.
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;

    const dateText = $(cells[0]).text().trim();
    const rateText = $(cells[1]).text().replace(/[^\d.]/g, '').trim();
    const parsed = parseFloat(rateText);

    if (!isNaN(parsed) && parsed > 1) {
      reference_rate = parsed;
      rate_date = dateText;
    }
  });

  if (reference_rate === null) {
    throw new Error('Banco Central: reference rate not found in table');
  }

  return {
    name: 'Banco Central',
    type: 'bank',
    buy_rate: reference_rate,
    sell_rate: reference_rate,
    fee: null,
    source: 'scraper',
    last_updated: new Date().toISOString(),
    _rate_date: rate_date, // informational only
  };
}

module.exports = { scrapeBancentral };
