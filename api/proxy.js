export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type } = req.query;

  // eBay Browse API - Active Listings
  if (type === 'ebay_active') {
    try {
      const { query } = req.body;
      const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=10&filter=buyingOptions:{FIXED_PRICE}`;
      const token = await getEbayToken();
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }
      });
      const data = await r.json();
      return res.status(200).json(data);
    } catch(err) {
      return res.status(200).json({ error: err.message, itemSummaries: [] });
    }
  }

  // eBay Browse API - Sold/Completed Listings
  if (type === 'ebay_sold') {
    try {
      const { query } = req.body;
      const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=10&filter=buyingOptions:{FIXED_PRICE}&sort=endTimeSoonest`;
      const token = await getEbayToken();
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }
      });
      const data = await r.json();
      return res.status(200).json(data);
    } catch(err) {
      return res.status(200).json({ error: err.message, itemSummaries: [] });
    }
  }

  // Vercel KV — save data (persistent, cross-device)
  if (type === 'save_data') {
    try {
      const { key, value } = req.body || {};
      if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
      const kv = kvConfig();
      if (!kv) return res.status(200).json({ ok: false, error: 'KV not configured' });
      const r = await fetch(kv.url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', key, JSON.stringify(value)])
      });
      const data = await r.json();
      return res.status(200).json({ ok: true, result: data.result });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message });
    }
  }

  // Vercel KV — load data
  if (type === 'load_data') {
    try {
      const { key } = req.body || {};
      if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
      const kv = kvConfig();
      if (!kv) return res.status(200).json({ ok: false, error: 'KV not configured' });
      const r = await fetch(kv.url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', key])
      });
      const data = await r.json();
      let value = null;
      if (data && data.result != null) {
        try { value = JSON.parse(data.result); } catch (e) { value = data.result; }
      }
      return res.status(200).json({ ok: true, value });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message, value: null });
    }
  }

  // Anthropic AI
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function getEbayToken() {
  const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
  });
  const data = await r.json();
  return data.access_token;
}
