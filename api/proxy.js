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

  // eBay Browse API - Live Auction Listings (returns currentBidPrice, bidCount, itemEndDate)
  if (type === 'ebay_auction') {
    try {
      const { query } = req.body;
      const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=50&filter=buyingOptions:{AUCTION}&sort=endTimeSoonest`;
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

  // eBay Finding API - Sold/Completed Listings (findCompletedItems with SoldItemsOnly=true).
  // The Browse API only returns ACTIVE listings, which is why Sold previously mirrored Active.
  // findCompletedItems returns genuinely sold items; we transform them into the Browse-style
  // itemSummaries shape the frontend already maps, so the Sold column displays correctly.
  if (type === 'ebay_sold') {
    try {
      const { query } = req.body;
      const appId = process.env.EBAY_APP_ID;
      const params = new URLSearchParams({
        'OPERATION-NAME': 'findCompletedItems',
        'SERVICE-VERSION': '1.13.0',
        'SECURITY-APPNAME': appId || '',
        'GLOBAL-ID': 'EBAY-US',
        'RESPONSE-DATA-FORMAT': 'JSON',
        'REST-PAYLOAD': 'true',
        'keywords': query || '',
        'itemFilter(0).name': 'SoldItemsOnly',
        'itemFilter(0).value': 'true',
        'sortOrder': 'EndTimeSoonest',
        'paginationInput.entriesPerPage': '10'
      });
      const r = await fetch('https://svcs.ebay.com/services/search/FindingService/v1?' + params.toString());
      const data = await r.json();
      const resp = (data && data.findCompletedItemsResponse && data.findCompletedItemsResponse[0]) || {};
      const rawItems = (resp.searchResult && resp.searchResult[0] && resp.searchResult[0].item) || [];
      const itemSummaries = rawItems.map(it => {
        const price = it.sellingStatus && it.sellingStatus[0] && it.sellingStatus[0].currentPrice && it.sellingStatus[0].currentPrice[0];
        const ship = it.shippingInfo && it.shippingInfo[0] && it.shippingInfo[0].shippingServiceCost && it.shippingInfo[0].shippingServiceCost[0];
        return {
          title: (it.title && it.title[0]) || '',
          price: price ? { value: price.__value__, currency: price['@currencyId'] } : undefined,
          condition: (it.condition && it.condition[0] && it.condition[0].conditionDisplayName && it.condition[0].conditionDisplayName[0]) || 'Used',
          itemWebUrl: (it.viewItemURL && it.viewItemURL[0]) || null,
          image: { imageUrl: (it.galleryURL && it.galleryURL[0]) || null },
          itemEndDate: (it.listingInfo && it.listingInfo[0] && it.listingInfo[0].endTime && it.listingInfo[0].endTime[0]) || null,
          shippingOptions: ship ? [{ shippingCost: { value: ship.__value__ } }] : []
        };
      });
      return res.status(200).json({ itemSummaries });
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

  // Generic JSON scrape proxy — fetch a public product feed server-side to avoid browser CORS
  if (type === 'scrape') {
    try {
      const target = (req.query && req.query.url) || (req.body && req.body.url);
      if (!target) return res.status(400).json({ error: 'Missing url' });
      let u;
      try { u = new URL(target); } catch (e) { return res.status(400).json({ error: 'Invalid url' }); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return res.status(400).json({ error: 'Only http/https URLs allowed' });
      }
      const r = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Shift64DiecastBot/1.0; +https://shift64diecast-os.vercel.app)',
          'Accept': 'application/json'
        }
      });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (data === null) {
        return res.status(200).json({ error: 'Non-JSON response from source', status: r.status });
      }
      return res.status(200).json(data);
    } catch (err) {
      return res.status(200).json({ error: err.message });
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
