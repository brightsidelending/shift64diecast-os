// Allow large request bodies (image ID payloads, long prompts) and give the function the
// maximum runtime, since web_search tool calls take longer than a standard completion.
// Tools arrays (including web_search_20250305) are always forwarded to Anthropic as-is —
// there is no tools validation, size rejection, or whitelist that could drop them.
export const config = { api: { bodyParser: { sizeLimit: '10mb' } }, maxDuration: 60 };

// ────────────────────────────────────────────────────────────────────────────
// REQUIRED ENVIRONMENT VARIABLES (set these in Vercel → Project → Settings → Env):
//   ANTHROPIC_API_KEY      — Claude API key (research, drafting, reply analysis)
//   EBAY_APP_ID            — eBay app id (price/auction/sold lookups)
//   EBAY_CLIENT_SECRET     — eBay client secret
//   KV_REST_API_URL        — Upstash/Vercel KV REST url (cloud persistence)
//   KV_REST_API_TOKEN      — Upstash/Vercel KV REST token
//   GMAIL_CLIENT_ID        — Google OAuth client id     (Eversen Gmail automation)
//   GMAIL_CLIENT_SECRET    — Google OAuth client secret (Eversen Gmail automation)
//   GMAIL_REFRESH_TOKEN    — Google OAuth refresh token for shift64diecast@gmail.com
//   GMAIL_USER             — shift64diecast@gmail.com (the sending/monitored inbox)
// Gmail endpoints (routed through this single function to match the app's pattern):
//   POST /api/proxy?type=gmail_send    { to, subject, body, threadId? } → { messageId, threadId }
//   GET  /api/proxy?type=gmail_inbox   [&q=...]                          → { messages:[...] }
//   GET  /api/proxy?type=gmail_thread&threadId=X                        → { messages:[...] }
// ────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, anthropic-dangerous-direct-browser-access');

  // CORS preflight: the headers above are already set, so return 200 with them.
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

  // Gmail — send an email (or reply on a thread) from shift64diecast@gmail.com
  if (type === 'gmail_send') {
    try {
      const { to, subject, body, threadId } = req.body || {};
      if (!to || !subject) return res.status(400).json({ ok: false, error: 'Missing to or subject' });
      const token = await getGmailToken();
      if (!token) return res.status(200).json({ ok: false, error: 'Gmail not configured (missing GMAIL_* env vars)' });
      const from = process.env.GMAIL_USER || 'shift64diecast@gmail.com';
      const mime = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit'
      ].join('\r\n') + '\r\n\r\n' + String(body || '');
      const payload = { raw: b64urlEncode(mime) };
      if (threadId) payload.threadId = threadId;
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (data.error) return res.status(200).json({ ok: false, error: (data.error.message || 'Gmail send failed') });
      return res.status(200).json({ ok: true, messageId: data.id, threadId: data.threadId });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message });
    }
  }

  // Gmail — fetch the last 20 inbox emails (optionally filtered by ?q= Gmail search)
  if (type === 'gmail_inbox') {
    try {
      const token = await getGmailToken();
      if (!token) return res.status(200).json({ ok: false, error: 'Gmail not configured', messages: [] });
      const q = (req.query && req.query.q) || 'in:inbox newer_than:60d';
      const list = await gmailApi(`/users/me/messages?maxResults=20&q=${encodeURIComponent(q)}`, token);
      const ids = ((list && list.messages) || []).map(m => m.id);
      const messages = [];
      for (const id of ids) {
        const m = await gmailApi(`/users/me/messages/${id}?format=full`, token);
        if (!m || m.error) continue;
        messages.push({
          messageId: m.id,
          threadId: m.threadId,
          from: extractHeader(m.payload, 'From'),
          subject: extractHeader(m.payload, 'Subject'),
          date: extractHeader(m.payload, 'Date'),
          body: extractBody(m.payload),
          isUnread: Array.isArray(m.labelIds) && m.labelIds.indexOf('UNREAD') >= 0
        });
      }
      return res.status(200).json({ ok: true, messages });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message, messages: [] });
    }
  }

  // Gmail — fetch a full thread in order
  if (type === 'gmail_thread') {
    try {
      const threadId = req.query && req.query.threadId;
      if (!threadId) return res.status(400).json({ ok: false, error: 'Missing threadId', messages: [] });
      const token = await getGmailToken();
      if (!token) return res.status(200).json({ ok: false, error: 'Gmail not configured', messages: [] });
      const t = await gmailApi(`/users/me/threads/${threadId}?format=full`, token);
      const messages = ((t && t.messages) || []).map(m => ({
        messageId: m.id,
        threadId: m.threadId,
        from: extractHeader(m.payload, 'From'),
        subject: extractHeader(m.payload, 'Subject'),
        date: extractHeader(m.payload, 'Date'),
        body: extractBody(m.payload),
        isUnread: Array.isArray(m.labelIds) && m.labelIds.indexOf('UNREAD') >= 0
      }));
      return res.status(200).json({ ok: true, messages });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message, messages: [] });
    }
  }

  // Anthropic AI
  // The full request body is forwarded to Anthropic UNCHANGED — including any `tools`
  // array (e.g. the web_search_20250305 server tool used by Eversen). There is no tool
  // filtering or whitelist here, so web search passes straight through.
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    // Log the tools array so we can confirm web search is arriving from the client.
    const incomingTools = (req.body && req.body.tools) || null;
    if (incomingTools) {
      console.log('[proxy] tools received:', JSON.stringify(incomingTools));
    } else {
      console.log('[proxy] no tools array in request body');
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body) // forwarded unchanged, tools included
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

// ── Gmail helpers (OAuth refresh-token flow → access token; REST calls; MIME parsing) ──
async function getGmailToken() {
  const id = process.env.GMAIL_CLIENT_ID;
  const secret = process.env.GMAIL_CLIENT_SECRET;
  const refresh = process.env.GMAIL_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return null;
  const params = new URLSearchParams({
    client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await r.json();
  return data.access_token || null;
}
async function gmailApi(path, token) {
  const r = await fetch('https://gmail.googleapis.com/gmail/v1' + path, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return r.json();
}
function extractHeader(payload, name) {
  const hs = (payload && payload.headers) || [];
  const h = hs.find(x => x && x.name && x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}
function b64urlDecode(data) {
  if (!data) return '';
  const s = String(data).replace(/-/g, '+').replace(/_/g, '/');
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch (e) { return ''; }
}
function b64urlEncode(str) {
  return Buffer.from(String(str), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Walk the MIME tree preferring text/plain, falling back to text/html; cap length.
function extractBody(payload) {
  if (!payload) return '';
  function walk(part, mime) {
    if (!part) return '';
    if (part.mimeType === mime && part.body && part.body.data) return b64urlDecode(part.body.data);
    if (part.parts) {
      for (const p of part.parts) { const t = walk(p, mime); if (t) return t; }
    }
    return '';
  }
  let text = walk(payload, 'text/plain');
  if (!text && payload.body && payload.body.data) text = b64urlDecode(payload.body.data);
  if (!text) text = walk(payload, 'text/html');
  return (text || '').slice(0, 8000);
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
