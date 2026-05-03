const axios = require('axios');
const cheerio = require('cheerio');

const URL = 'https://banreservas.com/calculadoras';

/**
 * Scrapes USD buy/sell rates from Banreservas.
 * The page has a static HTML table with currency rows (USD, EUR, etc.)
 * and Compra / Venta columns.
 *
 * Returns null on failure so the caller can fallback gracefully.
 */
async function scrapeBanreservas() {
  const { data: html } = await axios.get(URL, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DolarRD-Bot/1.0)' },
  });

  const $ = cheerio.load(html);

  let buy_rate = null;
  let sell_rate = null;

  // Look for a table row that mentions "USD" or "Dólar"
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    const text = $(cells[0]).text().trim().toLowerCase();

    if (text.includes('usd') || text.includes('dólar') || text.includes('dolar')) {
      const rawBuy = $(cells[1]).text().replace(/[^\d.]/g, '').trim();
      const rawSell = $(cells[2]).text().replace(/[^\d.]/g, '').trim();

      const parsed_buy = parseFloat(rawBuy);
      const parsed_sell = parseFloat(rawSell);

      if (!isNaN(parsed_buy)) buy_rate = parsed_buy;
      if (!isNaN(parsed_sell)) sell_rate = parsed_sell;

      return false; // break
    }
  });

  if (buy_rate === null && sell_rate === null) {
    throw new Error('Banreservas: USD row not found in table');
  }

  return {
    name: 'Banreservas',
    type: 'bank',
    buy_rate,
    sell_rate,
    fee: null,
    source: 'scraper',
    last_updated: new Date().toISOString(),
  };
}

module.exports = { scrapeBanreservas };
