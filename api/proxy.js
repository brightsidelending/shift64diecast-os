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
  const action = req.query && req.query.action;

  // ── Eversen Pipeline endpoints (Upstash Redis key "eversenPipeline") ──
  if (action === 'getEversenPipeline') {
    try { return res.status(200).json(await orLoadArray('eversenPipeline')); }
    catch (err) { return res.status(200).json([]); }
  }
  if (action === 'saveEversenPipeline') {
    try {
      const pipeline = (req.body && req.body.pipeline) || [];
      await orKvCmd(['SET', 'eversenPipeline', JSON.stringify(Array.isArray(pipeline) ? pipeline : [])]);
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(200).json({ success: false, error: err.message }); }
  }
  if (action === 'triggerSendNow') {
    try {
      const { brand, website } = req.body || {};
      if (!brand) return res.status(400).json({ success: false, error: 'Missing brand' });
      // Step 1: Use Claude with web search to find the real contact email and generate outreach
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          system: 'You are Eversen Chan, a wholesale procurement agent for Shift64 Diecast, a US-based premium 1/64 diecast reseller. Your job is to SEARCH THE WEB to find the real, verified wholesale or trade contact email for diecast manufacturers — do not guess. Search the brand website, their contact page, LinkedIn, and distributor pages. Then write a short cold email. Always sign as Eversen Chan. Never reveal you are an AI. Keep emails under 100 words. Lead in English. Do not ask for pricing or MOQ in the first email.',
          messages: [{ role: 'user', content: 'Search the web to find the real wholesale or trade contact email for ' + brand + ' diecast manufacturer (website: ' + (website || 'unknown') + '). Check their contact page, about page, and any distributor or press pages. Then write a cold email introducing Shift64 Diecast as a US wholesale buyer. Return ONLY valid JSON as your final response: { "contactEmail": "real@email.com", "subject": "subject here", "body": "full email body here" }' }]
        })
      });
      const claudeData = await claudeRes.json();
      let rawText = '';
      if (claudeData && Array.isArray(claudeData.content)) rawText = claudeData.content.filter(c => c.type === 'text').map(c => c.text).join('');
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(200).json({ success: false, error: 'Claude could not generate email' });
      const emailData = JSON.parse(jsonMatch[0]);
      if (!emailData.contactEmail || emailData.contactEmail === 'email@example.com') return res.status(200).json({ success: false, error: 'No contact email found for ' + brand });
      // Step 2: Send via Gmail SMTP using nodemailer + App Password
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({
        service: 'gmail',
        auth: { user: 'shift64diecast@gmail.com', pass: process.env.GMAIL_APP_PASSWORD }
      });
      await transporter.sendMail({
        from: '"Eversen Chan" <shift64diecast@gmail.com>',
        to: emailData.contactEmail,
        subject: emailData.subject,
        text: emailData.body
      });
      // Step 3: Update brand status in Redis
      const pipeline = await orLoadArray('eversenPipeline');
      const idx = pipeline.findIndex(b => String(b.brand || '').toLowerCase().trim() === String(brand).toLowerCase().trim());
      if (idx >= 0) {
        pipeline[idx].status = 'Contacted';
        pipeline[idx].notes = 'Email sent to ' + emailData.contactEmail;
        pipeline[idx].contactedAt = new Date().toISOString();
        await orKvCmd(['SET', 'eversenPipeline', JSON.stringify(pipeline)]);
      }
      return res.status(200).json({ success: true, contactEmail: emailData.contactEmail, subject: emailData.subject });
    } catch (err) { return res.status(200).json({ success: false, error: err.message }); }
  }
  if (action === 'updateEversenBrand') {
    try {
      const { brand, updates } = req.body || {};
      if (!brand) return res.status(400).json({ success: false, error: 'Missing brand' });
      const pipeline = await orLoadArray('eversenPipeline');
      const idx = pipeline.findIndex(b => String(b.brand || '').toLowerCase().trim() === String(brand).toLowerCase().trim());
      if (idx < 0) return res.status(200).json({ success: false, error: 'Brand not found' });
      const merged = Object.assign({}, pipeline[idx], updates || {});
      // Track when a brand entered "Researching" so the stuck-timer is accurate across refreshes.
      if (updates && updates.status === 'Researching') {
        if (!merged.researchingStarted) merged.researchingStarted = Date.now();
      } else if (updates && updates.status) {
        merged.researchingStarted = null; // moved out of Researching → clear the timer
      }
      pipeline[idx] = merged;
      await orKvCmd(['SET', 'eversenPipeline', JSON.stringify(pipeline)]);
      return res.status(200).json({ success: true, brand: pipeline[idx] });
    } catch (err) { return res.status(200).json({ success: false, error: err.message }); }
  }
  // Ask Eversen chat — forward the request body to the Anthropic Messages API.
  if (action === 'claude') {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(req.body)
      });
      const data = await response.json();
      return res.status(200).json(data);
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // Ask Eversen chat WITH LIVE WEB SEARCH — calls Anthropic with the web_search
  // server tool enabled so Eversen can search the web in real time (brand research,
  // current pricing, etc.). Takes { messages, system } from the request body,
  // returns { response: <final text block> }.
  if (action === 'eversenChat') {
    try {
      const { messages, system } = req.body;
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 2000,
          system: system,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: messages
        })
      });
      const aiData = await aiRes.json();
      console.log('eversenChat:', JSON.stringify(aiData).substring(0, 500));
      const textBlock = aiData.content.filter(c => c.type === 'text').pop();
      return res.json({ response: textBlock ? textBlock.text : 'No response' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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

  // eBay Sold/Completed Listings via HTML scrape of eBay's public sold-search page.
  // The Finding API (findCompletedItems) is retired, so we fetch the rendered sold
  // results page with a browser User-Agent and parse the item cards out of the HTML,
  // returning the same Browse-style itemSummaries shape the frontend already maps.
  if (type === 'ebay_sold') {
    try {
      const { query } = req.body;
      const url = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query || '') +
        '&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=60';
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      const html = await r.text();

      const stripTags = (s) => (s || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'")
        .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
        .replace(/\s+/g, ' ').trim();

      // Split into individual result cards. Each result is an <li class="s-item ...">.
      const chunks = html.split(/<li[^>]+class="[^"]*s-item[^"]*"/i).slice(1);
      const itemSummaries = [];
      for (const chunk of chunks) {
        if (itemSummaries.length >= 30) break;

        const titleM = chunk.match(/class="s-item__title"[^>]*>([\s\S]*?)<\/(?:div|h3)>/i);
        const title = titleM ? stripTags(titleM[1]).replace(/^New Listing/i, '').trim() : '';
        if (!title || /^shop on ebay$/i.test(title)) continue;

        const priceM = chunk.match(/class="s-item__price"[^>]*>([\s\S]*?)<\/span>/i);
        const priceText = priceM ? stripTags(priceM[1]) : '';
        const priceNum = parseFloat((priceText.match(/[0-9][0-9,]*(?:\.[0-9]{2})?/) || [''])[0].replace(/,/g, ''));
        if (!priceNum || isNaN(priceNum)) continue;

        const linkM = chunk.match(/href="(https:\/\/www\.ebay\.com\/itm\/[^"]+)"/i);
        const itemWebUrl = linkM ? linkM[1].replace(/&amp;/g, '&') : null;

        const imgM = chunk.match(/<img[^>]+(?:data-src|src)="(https:\/\/i\.ebayimg\.com\/[^"]+)"/i);
        const imageUrl = imgM ? imgM[1] : null;

        const soldM = chunk.match(/s-item__caption--signal[^>]*>([\s\S]*?)<\/span>/i) ||
          chunk.match(/s-item__title--tagblock[^>]*>([\s\S]*?)<\/span>/i);
        const soldText = soldM ? stripTags(soldM[1]) : null;

        const shipM = chunk.match(/class="[^"]*s-item__(?:shipping|logisticsCost)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const shipText = shipM ? stripTags(shipM[1]) : '';
        let shipVal = null;
        if (/free/i.test(shipText)) shipVal = 0;
        else { const sm = shipText.match(/[0-9][0-9,]*(?:\.[0-9]{2})?/); if (sm) shipVal = parseFloat(sm[0].replace(/,/g, '')); }

        itemSummaries.push({
          title,
          price: { value: String(priceNum), currency: 'USD' },
          condition: 'Used',
          itemWebUrl,
          image: { imageUrl },
          itemEndDate: soldText,
          shippingOptions: shipVal != null ? [{ shippingCost: { value: String(shipVal) } }] : []
        });
      }

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
      // Raw mode: return the page text (capped) so the client can parse HTML catalogs.
      const wantRaw = (req.query && (req.query.raw === '1' || req.query.raw === 'true')) || (req.body && req.body.raw);
      if (wantRaw) {
        return res.status(200).json({ raw: text.slice(0, 200000), status: r.status });
      }
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (data === null) {
        return res.status(200).json({ error: 'Non-JSON response from source', status: r.status, raw: text.slice(0, 200000) });
      }
      return res.status(200).json(data);
    } catch (err) {
      return res.status(200).json({ error: err.message });
    }
  }

  // Gmail — send an email (or reply on a thread) via nodemailer (Gmail App Password)
  if (type === 'gmail_send') {
    try {
      const { to, subject, body, threadId } = req.body || {};
      if (!to || !subject) return res.status(400).json({ ok: false, error: 'Missing to or subject' });
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({
        service: 'gmail',
        auth: {
          user: 'Shift64Diecast@gmail.com',
          pass: process.env.GMAIL_APP_PASSWORD
        }
      });
      const mailOptions = {
        from: 'Eversen Chan <Shift64Diecast@gmail.com>',
        to,
        subject,
        html: body,
      };
      if (threadId) {
        mailOptions.references = threadId;
        mailOptions.inReplyTo = threadId;
      }
      const info = await transporter.sendMail(mailOptions);
      return res.status(200).json({ ok: true, messageId: info.messageId, threadId: info.messageId });
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

  // Eversen — classify a supplier reply and auto-send Eversen Chan's response
  if (type === 'eversen_reply') {
    try {
      const { from, subject, body, threadId } = req.body || {};
      if (!from || !body) return res.status(400).json({ ok: false, error: 'Missing from or body' });

      const persona = `You are Eversen Chan, procurement professional for Shift64 Diecast (a growing US-based diecast reseller selling on eBay, Shopify, and Whatnot). Warm, confident, specific, respectful — never robotic or generic. Always write in English as the primary language, and end the email with a single closing line offering to communicate in Mandarin or Cantonese if more comfortable for their team. Sign as "Eversen Chan / Shift64 Diecast / shift64diecast@gmail.com".`;

      const rules = `Classify the supplier's reply as exactly one of:
- "positive": receptive / wants to move forward -> draft a reply moving toward wholesale pricing and MOQ.
- "needs_info": asks who we are / for business details -> draft a reply giving detail about Shift64's sales volume (eBay, Shopify, Whatnot) and growing marketplace presence.
- "call_request": wants a phone/video call -> reply with exactly this sentiment: "Our sourcing team is currently attending trade shows across the US but we are happy to move quickly over email. Once we align on the basics I would love to set up a proper introduction call."
- "referral": supplier cannot supply directly but points us toward another source/distributor -> draft a warm, natural follow-up to dig deeper without revealing intent. (This will be queued for human approval, NOT auto-sent.)
- "unknown": does not clearly match any of the above (off-topic, spam, hostile, ambiguous). (Queued for human review, NOT auto-sent.)`;

      const prompt = `${persona}

${rules}

Supplier reply (from ${from}${subject ? `, subject "${subject}"` : ''}):
"""
${String(body).slice(0, 4000)}
"""

Return ONLY minified JSON: {"type":"positive|needs_info|call_request|referral|unknown","replySummary":"a one or two sentence English summary of what the supplier said","reply":"the full email body Eversen should send or queue, plain text, ending with the Mandarin/Cantonese offer line and the signature"}`;

      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 900,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const aiData = await aiResp.json();
      const text = (aiData && aiData.content && aiData.content[0] && aiData.content[0].text) || '';
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
      }
      if (!parsed || !parsed.type || !parsed.reply) {
        return res.status(200).json({ ok: false, error: 'Could not classify reply', raw: text.slice(0, 300) });
      }

      const AUTO_TYPES = ['positive', 'needs_info', 'call_request'];
      const nowDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const reSubject = subject ? (String(subject).toLowerCase().startsWith('re:') ? subject : 'Re: ' + subject) : 'Re: Wholesale inquiry — Shift64 Diecast';

      // referral / unknown -> Pending Approvals (no auto-send)
      if (!AUTO_TYPES.includes(parsed.type)) {
        await orPushPending({
          id: 'or_' + (threadId || Date.now().toString(36)),
          from,
          brand: '',
          replySummary: parsed.replySummary || String(body).slice(0, 400),
          draftedReply: parsed.reply,
          threadId: threadId || '',
          subject: reSubject
        });
        console.log(`[proxy] eversen_reply: classified ${parsed.type} -> queued for approval (${from})`);
        return res.status(200).json({ ok: true, type: parsed.type, queued: true });
      }

      // positive / needs_info / call_request -> auto-send + tracker (status "Replied")
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({
        service: 'gmail',
        auth: { user: 'Shift64Diecast@gmail.com', pass: process.env.GMAIL_APP_PASSWORD }
      });
      const mailOptions = {
        from: 'Eversen Chan <Shift64Diecast@gmail.com>',
        to: from,
        subject: reSubject,
        text: parsed.reply
      };
      if (threadId) { mailOptions.references = threadId; mailOptions.inReplyTo = threadId; }
      const info = await transporter.sendMail(mailOptions);

      await orUpsertTracker({
        brand: '',
        contactName: '',
        contactEmail: from,
        status: 'Replied',
        lastActivity: nowDate,
        notes: `Auto-replied by Eversen (${parsed.type})`,
        threadId: threadId || ''
      });
      console.log(`[proxy] eversen_reply: classified ${parsed.type}, sent to ${from} (${info.messageId})`);

      return res.status(200).json({ ok: true, type: parsed.type, messageId: info.messageId });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err.message });
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

// ── Outreach Redis helpers (Upstash REST) — shapes match the Outreach tab ──
async function orKvCmd(command) {
  const kv = kvConfig();
  if (!kv) { console.warn('[proxy] Redis not configured — outreach write skipped'); return null; }
  const r = await fetch(kv.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const data = await r.json();
  return data.result;
}
async function orLoadArray(key) {
  const raw = await orKvCmd(['GET', key]);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
// Stable unique id for Outreach-tab records (so the row action buttons work).
function orGenId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'or_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
// Tracker record: { brand, contactName, contactEmail, status, lastActivity, notes, threadId }
async function orUpsertTracker(record) {
  try {
    const items = await orLoadArray('outreach_tracker');
    const idx = items.findIndex(c =>
      (record.threadId && c.threadId === record.threadId) ||
      (record.contactEmail && c.contactEmail === record.contactEmail));
    if (idx >= 0) items[idx] = { ...items[idx], ...record }; // preserve existing id
    else items.push({ id: orGenId(), ...record });
    await orKvCmd(['SET', 'outreach_tracker', JSON.stringify(items)]);
  } catch (e) { console.error('[proxy] orUpsertTracker failed:', e.message); }
}
// Pending record: { id, from, brand, replySummary, draftedReply, threadId, subject }
async function orPushPending(record) {
  try {
    const items = await orLoadArray('outreach_pending');
    const idx = items.findIndex(x => x.id === record.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...record };
    else items.push(record);
    await orKvCmd(['SET', 'outreach_pending', JSON.stringify(items)]);
  } catch (e) { console.error('[proxy] orPushPending failed:', e.message); }
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
 
