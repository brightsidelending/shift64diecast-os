// api/cron.js — Eversen Chan outreach auto-responder (Vercel cron, every 6h)
//
// Flow:
//   1. Auth to Gmail with a stored refresh token.
//   2. Find unread inbox replies that belong to threads where the LAST message
//      we sent came from shift64diecast@gmail.com (i.e. Eversen's outreach).
//   3. Ask Claude to classify each reply into one of the known scenarios.
//   4. Auto-send the matching reply signed as "Eversen Chan".
//   5. Update the Outreach Tracker in Redis (Upstash REST).
//   6. Unknown replies -> flag card 🟡 Needs Review, do NOT auto-send.
//
// Required env vars:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER
//   ANTHROPIC_API_KEY
//   KV_REST_API_URL / KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL / _TOKEN)

import nodemailer from 'nodemailer';

const OUR_ADDRESS = 'shift64diecast@gmail.com';
const SIGNATURE = 'Eversen Chan';
const TRACKER_KEY = 'outreach_tracker'; // Redis key: JSON array of tracker records
const PENDING_KEY = 'outreach_pending'; // Redis key: JSON array of pending-approval records
const MODEL = 'claude-sonnet-4-5-20250929';

// ---------------------------------------------------------------------------
// EVERSEN PERSONA + RESPONSE RULES
// The classifier and the reply drafts both read from this block.
// ---------------------------------------------------------------------------
const EVERSEN_PERSONA = `
PERSONA: Eversen Chan, procurement professional for Shift64 Diecast. Warm,
confident, specific, respectful. Never robotic or generic. Always signs as
"Eversen Chan / Shift64 Diecast / shift64diecast@gmail.com".

LANGUAGE: Always English first. End every email with:
"We are also happy to communicate in Mandarin or Cantonese if that is more
comfortable for your team."

RESPONSE RULES:
- positive -> draft a second email moving toward wholesale pricing and MOQ.
- needs_info -> provide more detail about Shift64's sales volume (eBay, Shopify,
  Whatnot) and growing marketplace presence.
- call_request -> respond: "Our sourcing team is currently attending trade shows
  across the US but we are happy to move quickly over email. Once we align on the
  basics I would love to set up a proper introduction call."
- referral -> supplier points us to another source; draft a warm, natural follow-up
  to dig deeper without revealing intent, and route to Pending Approvals (no auto-send).
- unknown -> route to Pending Approvals (no auto-send).

Never ask for pricing or MOQ in the first exchange.
Never reveal we are trying to find their supplier.
`.trim();

// The five known scenarios. "unknown" is handled separately (no auto-send).
const SCENARIOS = {
  positive:
    'Supplier is receptive / wants to move forward. Thank them, confirm interest, ask for their full wholesale price list, MOQ, and payment/shipping terms.',
  needs_info:
    'Supplier asks who we are / for business details before quoting. Provide a short, credible intro to Shift64 Diecast (US reseller of premium 1:64 diecast), our interest in a wholesale account, and offer to share any docs they need.',
  call_request:
    'Supplier wants a phone/video call. Agree enthusiastically, propose that they suggest 2-3 time windows (with timezone), and ask for the best number / platform (WhatsApp, WeChat, Zoom).',
  referral:
    'Supplier says they cannot supply directly but points us toward another source/distributor. Thank them warmly for the lead and ask for an introduction or the contact details of the source they mentioned.',
};

// Types that Eversen auto-sends and logs to the tracker. Everything else
// (referral, unknown) is routed to Pending Approvals for a human to review.
const AUTO_TYPES = ['positive', 'needs_info', 'call_request'];

// Shared negotiation sequence baked into every outreach and follow-up email.
const NEGOTIATION_FRAMEWORK = `SHIFT64 NEGOTIATION FRAMEWORK — weave this sequence in naturally (never number it or make it robotic):
1. Introduce who Shift64 Diecast is and what we do — a US-based diecast retailer.
2. State what we want: wholesale / direct pricing to eliminate middlemen.
3. Ask whether they can communicate in English via WeChat.
4. If language is a barrier, note that our China-based contact can continue in Mandarin or Cantonese.
5. Ask about sample availability before committing to a larger order.
6. Ask about MOQ (minimum order quantity) beyond the sample.
7. Ask about shipping to California — rates, methods, and efficiency.
8. If they cannot ship directly, ask for a referral to a shipping partner or freight forwarder.
Tailor the tone and channel to the brand/region (some makers are more reachable via WeChat, Instagram, Alibaba, or trade expos) rather than a one-size-fits-all approach.`;

// ===========================================================================
export default async function handler(req, res) {
  const startedAt = new Date().toISOString();
  console.log(`[cron] Eversen outreach responder started ${startedAt}`);

  const summary = { processed: 0, autoSent: 0, needsReview: 0, skipped: 0, errors: 0, followupsSent: 0, alertsEmailed: 0, actions: [] };

  try {
    // nodemailer OAuth2 transport handles token refresh automatically for SENDING.
    const transporter = createTransporter();
    // Reading the inbox (list/get/modify) needs a REST access token — nodemailer
    // only sends, so we obtain a token for those read-only Gmail API calls.
    const accessToken = await getGmailAccessToken();
    console.log('[cron] Gmail transporter + read token ready');

    // Unread messages in the inbox. We filter to Eversen threads below.
    const listUrl = gmailUrl('/messages') + '?q=' + encodeURIComponent('is:unread in:inbox') + '&maxResults=50';
    const listResp = await gapi(listUrl, accessToken);
    const messages = listResp.messages || [];
    console.log(`[cron] ${messages.length} unread inbox message(s) to inspect`);

    // De-dupe by thread so we only reply once per conversation.
    const seenThreads = new Set();

    for (const msgRef of messages) {
      try {
        const msg = await gapi(gmailUrl('/messages/' + msgRef.id) + '?format=full', accessToken);
        const threadId = msg.threadId;
        if (seenThreads.has(threadId)) continue;
        seenThreads.add(threadId);

        const thread = await gapi(gmailUrl('/threads/' + threadId) + '?format=full', accessToken);
        const threadMsgs = thread.messages || [];

        // Only handle threads where a message was sent BY us (Eversen outreach),
        // and where the most recent message is an inbound reply (not from us).
        const sentByUs = threadMsgs.some((m) => fromMatches(m, OUR_ADDRESS));
        const lastMsg = threadMsgs[threadMsgs.length - 1];
        const lastFromUs = fromMatches(lastMsg, OUR_ADDRESS);

        if (!sentByUs || lastFromUs) {
          console.log(`[cron] thread ${threadId}: not an Eversen reply (sentByUs=${sentByUs}, lastFromUs=${lastFromUs}) — skipping`);
          summary.skipped++;
          continue;
        }

        summary.processed++;
        const replyHeaders = headerMap(lastMsg);
        const supplierEmail = parseAddress(replyHeaders['from']);
        const subject = replyHeaders['subject'] || '(no subject)';
        const bodyText = extractPlainText(lastMsg.payload) || lastMsg.snippet || '';
        console.log(`[cron] thread ${threadId}: reply from ${supplierEmail} — "${subject}"`);

        // ---- Classify with Claude -------------------------------------------
        const classification = await classifyReply(bodyText);
        console.log(`[cron] thread ${threadId}: classified as ${classification.type} (${classification.confidence})`);

        // Always draft a reply (used for auto-send OR for the approval queue).
        const draft = await draftReply(
          AUTO_TYPES.includes(classification.type) ? classification.type : 'referral',
          bodyText
        );

        // ---- referral / unknown -> Pending Approvals (no auto-send) ---------
        if (!AUTO_TYPES.includes(classification.type)) {
          await pushPending({
            id: 'or_' + threadId,
            from: supplierEmail,
            brand: '',
            replySummary: (classification.reason ? classification.reason + ' — ' : '') + bodyText.slice(0, 400),
            draftedReply: draft,
            threadId,
            subject: subject.toLowerCase().startsWith('re:') ? subject : 'Re: ' + subject,
          });
          console.log(`[cron] thread ${threadId}: ${classification.type} -> Pending Approvals (no auto-send)`);
          summary.needsReview++;
          summary.actions.push({ threadId, action: 'pending', type: classification.type });
          continue; // do not mark read, so a human still sees it
        }

        // ---- positive / needs_info / call_request -> auto-send + tracker ----
        await transporter.sendMail({
          from: `${SIGNATURE} <${GMAIL_USER()}>`,
          to: supplierEmail,
          subject: subject.toLowerCase().startsWith('re:') ? subject : 'Re: ' + subject,
          inReplyTo: replyHeaders['message-id'],       // keeps Gmail threading intact
          references: replyHeaders['references'] || replyHeaders['message-id'],
          text: draft,
        });
        console.log(`[cron] thread ${threadId}: auto-sent ${classification.type} reply to ${supplierEmail}`);

        // Mark the inbound reply as read now that it's handled.
        await gapi(gmailUrl('/messages/' + lastMsg.id + '/modify'), accessToken, {
          method: 'POST',
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
        });

        await upsertTrackerCard({
          brand: '',
          contactName: '',
          contactEmail: supplierEmail,
          status: 'Replied',
          lastActivity: displayDate(),
          notes: `Auto-replied by Eversen (${classification.type})`,
          threadId,
        });

        summary.autoSent++;
        summary.actions.push({ threadId, action: 'auto_sent', type: classification.type });
      } catch (innerErr) {
        console.error(`[cron] error on message ${msgRef.id}: ${innerErr.message}`);
        summary.errors++;
      }
    }

    console.log(`[cron] done — processed=${summary.processed} autoSent=${summary.autoSent} needsReview=${summary.needsReview} skipped=${summary.skipped} errors=${summary.errors}`);

    // --- Daily follow-up automation: nudge stale "Sent" outreach with no reply ---
    await runFollowups(summary);
    console.log(`[cron] follow-ups sent=${summary.followupsSent}`);

    // --- Daily price-alert scan: eBay + AliExpress target-price hits ---
    await runPriceAlerts(summary);
    console.log(`[cron] price alerts emailed=${summary.alertsEmailed}`);

    const hour = new Date().getUTCHours();
    if (hour === 13) {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({
        service: 'gmail',
        auth: {
          user: 'Shift64Diecast@gmail.com',
          pass: process.env.GMAIL_APP_PASSWORD
        }
      });
      await transporter.sendMail({
        from: 'Shift64Diecast OS <Shift64Diecast@gmail.com>',
        to: ['Shift64Diecast@gmail.com', 'erictran925@gmail.com'],
        subject: `☀️ Shift64 Morning Digest — ${new Date().toLocaleDateString('en-US', {month:'short', day:'numeric'})}`,
        html: '<div style="font-family:sans-serif;max-width:600px;margin:0 auto"><h2 style="color:#d4af37">☀️ Shift64Diecast Morning Digest</h2><p>Good morning Eric! <a href="https://brightsidelending.github.io/shift64diecast-os/" style="background:#d4af37;color:#000;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:bold">Open Shift64 OS →</a></p></div>'
      });
    }

    return res.status(200).json({ ok: true, startedAt, summary });
  } catch (err) {
    console.error(`[cron] fatal: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message, summary });
  }
}

// ---------------------------------------------------------------------------
// Claude — classification + drafting
// ---------------------------------------------------------------------------
async function classifyReply(bodyText) {
  const scenarioList = Object.entries(SCENARIOS)
    .map(([k, v]) => `- "${k}": ${v}`)
    .join('\n');

  const prompt = `${EVERSEN_PERSONA}

A supplier has replied to one of Eversen's wholesale outreach emails. Classify the reply into exactly ONE type:
${scenarioList}
- "unknown": The reply does not clearly match any of the above (off-topic, spam, hostile, ambiguous, or a scenario not listed).

Supplier reply:
"""
${bodyText.slice(0, 4000)}
"""

Respond with ONLY a JSON object, no prose:
{"type":"positive|needs_info|call_request|referral|unknown","confidence":"high|medium|low","reason":"one short sentence"}`;

  const data = await callClaude([{ role: 'user', content: prompt }], 300);
  const text = (data?.content?.[0]?.text || '').trim();
  const parsed = safeJson(text);
  if (!parsed || !parsed.type) {
    return { type: 'unknown', confidence: 'low', reason: 'Classifier returned unparseable output' };
  }
  return parsed;
}

async function draftReply(type, bodyText) {
  const prompt = `${EVERSEN_PERSONA}

The supplier's reply was classified as "${type}".
Guidance for this scenario: ${SCENARIOS[type]}

Supplier reply:
"""
${bodyText.slice(0, 4000)}
"""

Write Eversen's email reply. Rules:
- Plain text only, no subject line, no markdown.
- Warm, concise, professional, specific — never robotic or generic. 2-4 short paragraphs max.
- Follow all PERSONA, LANGUAGE, and RESPONSE RULES above exactly, including the
  required bilingual closing line and the "${SIGNATURE} / Shift64 Diecast /
  ${GMAIL_USER()}" sign-off.

Output ONLY the email body.`;

  const data = await callClaude([{ role: 'user', content: prompt }], 700);
  return (data?.content?.[0]?.text || '').trim();
}

// ---------------------------------------------------------------------------
// Follow-up automation — nudge stale "Sent" outreach that got no reply
// ---------------------------------------------------------------------------
const FOLLOWUP_SKIP = ['Replied', 'Follow-up Sent', 'Closed', 'Queued'];
const FOLLOWUP_AFTER_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

async function runFollowups(summary) {
  try {
    const raw = await kvCmd(['GET', TRACKER_KEY]);
    let records = [];
    if (raw) { try { records = JSON.parse(raw); } catch (_) { records = []; } }
    if (!Array.isArray(records) || !records.length) return;

    const now = Date.now();
    let transporter = null;
    let changed = false;

    for (const rec of records) {
      if (!rec || FOLLOWUP_SKIP.includes(rec.status)) continue;
      if (rec.status !== 'Sent') continue;         // only chase records still awaiting a reply
      if (!rec.contactEmail) continue;              // need somewhere to send
      const last = Date.parse(rec.lastActivity);
      if (isNaN(last) || (now - last) < FOLLOWUP_AFTER_MS) continue;

      const draft = await draftFollowup(rec);
      if (!draft) continue;

      if (!transporter) {
        const nodemailer = await import('nodemailer');
        transporter = nodemailer.default.createTransport({
          service: 'gmail',
          auth: { user: 'Shift64Diecast@gmail.com', pass: process.env.GMAIL_APP_PASSWORD },
        });
      }
      const mail = {
        from: 'Eversen Chan <Shift64Diecast@gmail.com>',
        to: rec.contactEmail,
        subject: `Following up — Shift64 Diecast${rec.brand ? ' x ' + rec.brand : ''}`,
        text: draft,
      };
      if (rec.threadId) { mail.references = rec.threadId; mail.inReplyTo = rec.threadId; }
      await transporter.sendMail(mail);

      rec.status = 'Follow-up Sent';
      rec.lastActivity = displayDate();
      changed = true;
      summary.followupsSent = (summary.followupsSent || 0) + 1;
      console.log(`[cron] follow-up sent to ${rec.contactEmail} (${rec.brand || 'no brand'})`);
    }

    if (changed) await kvCmd(['SET', TRACKER_KEY, JSON.stringify(records)]);
  } catch (err) {
    console.error(`[cron] follow-up automation failed: ${err.message}`);
  }
}

async function draftFollowup(rec) {
  const prompt = `${EVERSEN_PERSONA}

You emailed this supplier about wholesale diecast sourcing more than 5 days ago and have NOT heard back. Write a SHORT, friendly follow-up nudge as Eversen Chan that references that original outreach and gently re-opens the conversation.
Context — brand: "${rec.brand || '(unspecified)'}"; contact: ${rec.contactEmail}; notes from the first contact: ${rec.notes || '(none)'}.

${NEGOTIATION_FRAMEWORK}

Rules:
- Plain text only, no subject line, no markdown. 2-3 short paragraphs max.
- Low-pressure and warm. For a brief follow-up, prioritize re-introducing Shift64, the wholesale/direct-pricing ask, and the "English via WeChat / else Mandarin or Cantonese" option — don't cram all eight points in.
- End with the "${SIGNATURE} / Shift64 Diecast / ${GMAIL_USER()}" sign-off.

Output ONLY the email body.`;
  const data = await callClaude([{ role: 'user', content: prompt }], 600);
  return (data?.content?.[0]?.text || '').trim();
}

// ---------------------------------------------------------------------------
// Price alerts — daily scan of eBay + AliExpress for target-price hits
// ---------------------------------------------------------------------------
const PROXY_BASE = 'https://shift64diecast-os.vercel.app';
const ALERTS_KEY = 'price_alerts';
const ALERTS_SENT_KEY = 'price_alerts_sent'; // { listingUrl: ISO timestamp } — for 24h dedupe
const OS_URL = 'https://brightsidelending.github.io/shift64diecast-os/';

async function runPriceAlerts(summary) {
  try {
    const rawA = await kvCmd(['GET', ALERTS_KEY]);
    let alerts = [];
    if (rawA) { try { alerts = JSON.parse(rawA); } catch (_) { alerts = []; } }
    if (!Array.isArray(alerts) || !alerts.length) return;

    const rawS = await kvCmd(['GET', ALERTS_SENT_KEY]);
    let sent = {};
    if (rawS) { try { sent = JSON.parse(rawS) || {}; } catch (_) { sent = {}; } }

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // Prune dedupe entries older than 7 days so the map doesn't grow forever.
    for (const k of Object.keys(sent)) { if (now - Date.parse(sent[k]) > 7 * DAY) delete sent[k]; }

    let transporter = null;

    for (const alert of alerts) {
      if (!alert || !alert.active) continue;
      const target = parseFloat(alert.targetPrice);
      if (!(target > 0)) { alert.lastChecked = displayDate(); continue; }

      let matches = [];
      if (alert.platform === 'ebay' || alert.platform === 'both') {
        matches = matches.concat(await searchEbayForAlert(alert, target));
      }
      if (alert.platform === 'aliexpress' || alert.platform === 'both') {
        matches = matches.concat(await searchAliExpressForAlert(alert, target));
      }
      alert.lastChecked = displayDate();

      // Never send a duplicate for the same listing within 24h.
      const fresh = matches.filter(m => m.url && !(sent[m.url] && (now - Date.parse(sent[m.url])) < DAY));
      if (!fresh.length) continue;

      if (!transporter) {
        const nodemailer = await import('nodemailer');
        transporter = nodemailer.default.createTransport({
          service: 'gmail',
          auth: { user: 'Shift64Diecast@gmail.com', pass: process.env.GMAIL_APP_PASSWORD },
        });
      }
      await transporter.sendMail({
        from: 'Shift64Diecast OS <Shift64Diecast@gmail.com>',
        to: ['erictran925@gmail.com', 'Shift64Diecast@gmail.com'],
        subject: `🔔 Price alert: "${alert.keyword}" at/below $${target.toFixed(2)}`,
        html: priceAlertEmailHtml(alert, fresh, target),
      });
      fresh.forEach(m => { sent[m.url] = new Date().toISOString(); });
      summary.alertsEmailed = (summary.alertsEmailed || 0) + fresh.length;
      console.log(`[cron] price alert emailed: ${alert.keyword} — ${fresh.length} match(es)`);
    }

    await kvCmd(['SET', ALERTS_KEY, JSON.stringify(alerts)]);
    await kvCmd(['SET', ALERTS_SENT_KEY, JSON.stringify(sent)]);
  } catch (err) {
    console.error(`[cron] price alerts failed: ${err.message}`);
  }
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// eBay dispatch: honor the alert's listing type.
//  - "bin"      -> Buy It Now only (alert immediately at/below target)
//  - "auction"  -> Auctions only (alert only when ending within 2h AND current bid <= target)
//  - "any"      -> both (BIN immediate + auctions with the 2-hour rule)
async function searchEbayForAlert(alert, target) {
  const lt = alert.listingType || 'any';
  const out = [];
  if (lt === 'bin' || lt === 'any') out.push(...await searchEbayBinForAlert(alert, target));
  if (lt === 'auction' || lt === 'any') out.push(...await searchEbayAuctionForAlert(alert, target));
  return out;
}

// Buy It Now (fixed price) — alert immediately when price is at/below target.
async function searchEbayBinForAlert(alert, target) {
  try {
    const r = await fetch(PROXY_BASE + '/api/proxy?type=ebay_active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: alert.keyword }),
    });
    const d = await r.json();
    const items = (d && d.itemSummaries) || [];
    const out = [];
    for (const it of items) {
      const price = parseFloat(it.price && it.price.value);
      if (!(price <= target)) continue;
      if (alert.condition === 'new' && !/new/i.test(it.condition || '')) continue;
      if (alert.condition === 'used' && !/used|pre-?owned/i.test(it.condition || '')) continue;
      if (alert.usOnly && !(it.itemLocation && it.itemLocation.country === 'US')) continue;
      out.push({ platform: 'eBay', kind: 'bin', title: it.title || alert.keyword, price, url: it.itemWebUrl || '' });
    }
    return out;
  } catch (e) { console.error('[cron] eBay BIN alert search failed:', e.message); return []; }
}

// Auctions — only alert when the auction ends within 2 hours AND the current bid is at/below target.
async function searchEbayAuctionForAlert(alert, target) {
  try {
    const r = await fetch(PROXY_BASE + '/api/proxy?type=ebay_auction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: alert.keyword }),
    });
    const d = await r.json();
    const items = (d && d.itemSummaries) || [];
    const now = Date.now();
    const out = [];
    for (const it of items) {
      if (!(Array.isArray(it.buyingOptions) && it.buyingOptions.includes('AUCTION'))) continue; // must be an auction
      const bid = parseFloat(it.currentBidPrice && it.currentBidPrice.value);
      if (!(bid <= target)) continue;                       // current bid at/below target
      const end = Date.parse(it.itemEndDate);
      if (isNaN(end)) continue;
      const remaining = end - now;
      if (!(remaining > 0 && remaining <= TWO_HOURS_MS)) continue; // ONLY within the final 2 hours
      if (alert.condition === 'new' && !/new/i.test(it.condition || '')) continue;
      if (alert.condition === 'used' && !/used|pre-?owned/i.test(it.condition || '')) continue;
      if (alert.usOnly && !(it.itemLocation && it.itemLocation.country === 'US')) continue;
      out.push({ platform: 'eBay', kind: 'auction', title: it.title || alert.keyword, price: bid, url: it.itemWebUrl || '', endsInMin: Math.max(1, Math.round(remaining / 60000)) });
    }
    return out;
  } catch (e) { console.error('[cron] eBay auction alert search failed:', e.message); return []; }
}

// AliExpress via the web_search tool through the proxy passthrough.
async function searchAliExpressForAlert(alert, target) {
  try {
    const prompt = `Search AliExpress for "${alert.keyword}" diecast listings priced at or below $${target} USD. Return ONLY minified JSON: {"listings":[{"title":"","price":<number USD>,"url":"https://..."}]} — include only real AliExpress product URLs you actually find, up to 5, each priced <= ${target}. If none, return {"listings":[]}.`;
    const r = await fetch(PROXY_BASE + '/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const d = await r.json();
    const txt = (d && Array.isArray(d.content)) ? d.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n') : '';
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch (_) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch (e) {} } }
    const list = (parsed && Array.isArray(parsed.listings)) ? parsed.listings : [];
    return list
      .filter(x => x && x.url && parseFloat(x.price) <= target)
      .slice(0, 5)
      .map(x => ({ platform: 'AliExpress', title: x.title || alert.keyword, price: parseFloat(x.price), url: x.url }));
  } catch (e) { console.error('[cron] AliExpress alert search failed:', e.message); return []; }
}

function formatRemaining(min) {
  const h = Math.floor((min || 0) / 60);
  const m = (min || 0) % 60;
  return (h > 0 ? h + 'h ' : '') + m + 'm';
}
function priceAlertEmailHtml(alert, matches, target) {
  const rows = matches.map(m => {
    if (m.kind === 'auction') {
      return `
    <div style="border:1px solid #E67E22;border-radius:8px;padding:12px;margin-bottom:10px;">
      <div style="color:#E67E22;font-weight:bold;font-size:13px;margin-bottom:4px;">⏰ Auction Ending Soon — ${formatRemaining(m.endsInMin)} remaining</div>
      <div style="font-weight:bold;color:#fff;">${escapeHtml(m.title)}</div>
      <div style="color:#d4af37;font-size:18px;font-weight:bold;margin:4px 0;">Current bid $${Number(m.price).toFixed(2)} <span style="color:#999;font-size:12px;font-weight:normal;">on eBay</span></div>
      <a href="${escapeHtml(m.url)}" style="color:#4A90D9;font-size:13px;">Bid now →</a>
    </div>`;
    }
    return `
    <div style="border:1px solid #333;border-radius:8px;padding:12px;margin-bottom:10px;">
      <div style="font-weight:bold;color:#fff;">${escapeHtml(m.title)}</div>
      <div style="color:#d4af37;font-size:18px;font-weight:bold;margin:4px 0;">$${Number(m.price).toFixed(2)} <span style="color:#999;font-size:12px;font-weight:normal;">on ${escapeHtml(m.platform)}</span></div>
      <a href="${escapeHtml(m.url)}" style="color:#4A90D9;font-size:13px;">View listing →</a>
    </div>`;
  }).join('');
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#111;padding:20px;color:#eee;">
    <h2 style="color:#d4af37;">🔔 Price Alert Hit</h2>
    <p>Your alert for <b>${escapeHtml(alert.keyword)}</b> (target $${target.toFixed(2)}) matched ${matches.length} listing${matches.length > 1 ? 's' : ''}:</p>
    ${rows}
    <p style="margin-top:16px;"><a href="${OS_URL}" style="background:#d4af37;color:#000;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold;">View in OS →</a></p>
  </div>`;
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function callClaude(messages, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages }),
  });
  return r.json();
}

// ---------------------------------------------------------------------------
// Gmail helpers
// ---------------------------------------------------------------------------
function GMAIL_USER() {
  return process.env.GMAIL_USER || OUR_ADDRESS;
}
function gmailUrl(path) {
  return `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(GMAIL_USER())}${path}`;
}

// SENDING: nodemailer Gmail OAuth2 transport. Nodemailer refreshes the access
// token itself from the refresh token on each send — no manual token handling.
function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: process.env.GMAIL_USER,
      clientId: process.env.GMAIL_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN,
    },
  });
}

// READING: nodemailer cannot list/read/modify messages, so we still need a REST
// access token for those calls. This is the standard OAuth2 refresh-token grant.
async function getGmailAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('Gmail token error: ' + JSON.stringify(data));
  return data.access_token;
}

async function gapi(url, token, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gmail API ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function headerMap(message) {
  const out = {};
  const headers = message?.payload?.headers || [];
  for (const h of headers) out[h.name.toLowerCase()] = h.value;
  return out;
}
function fromMatches(message, address) {
  const from = headerMap(message)['from'] || '';
  return from.toLowerCase().includes(address.toLowerCase());
}
function parseAddress(raw) {
  if (!raw) return '';
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

// Walk the MIME tree for a text/plain part; fall back to decoding text/html.
function extractPlainText(payload) {
  if (!payload) return '';
  const decode = (d) => Buffer.from((d || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const stack = [payload];
  let htmlFallback = '';
  while (stack.length) {
    const part = stack.shift();
    if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data);
    if (part.mimeType === 'text/html' && part.body?.data && !htmlFallback) {
      htmlFallback = decode(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    }
    if (part.parts) stack.push(...part.parts);
  }
  return htmlFallback;
}

// ---------------------------------------------------------------------------
// Redis (Upstash REST) — Outreach Tracker
// ---------------------------------------------------------------------------
function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}
async function kvCmd(command) {
  const kv = kvConfig();
  if (!kv) { console.warn('[cron] Redis not configured — tracker update skipped'); return null; }
  const r = await fetch(kv.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json();
  return data.result;
}

// Display date matching the Outreach tab's format, e.g. "Jul 6, 2026".
function displayDate() {
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Stable unique id for Outreach-tab records (so View Thread / Follow-up / Mark Closed work).
function genId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'or_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Merge/insert a tracker record (Outreach-tab shape), keyed by threadId (or contactEmail).
// Shape: { brand, contactName, contactEmail, status, lastActivity, notes, threadId }
async function upsertTrackerCard(card) {
  try {
    const raw = await kvCmd(['GET', TRACKER_KEY]);
    let cards = [];
    if (raw) { try { cards = JSON.parse(raw); } catch (_) { cards = []; } }
    if (!Array.isArray(cards)) cards = [];

    const idx = cards.findIndex((c) =>
      (card.threadId && c.threadId === card.threadId) ||
      (card.contactEmail && c.contactEmail === card.contactEmail));
    if (idx >= 0) cards[idx] = { ...cards[idx], ...card }; // preserve existing id
    else cards.push({ id: genId(), ...card });

    await kvCmd(['SET', TRACKER_KEY, JSON.stringify(cards)]);
    console.log(`[cron] tracker updated: ${card.threadId || card.contactEmail} -> ${card.status}`);
  } catch (err) {
    console.error(`[cron] tracker update failed: ${err.message}`);
  }
}

// Append/replace a pending-approval record (Outreach-tab shape), keyed by id.
// Shape: { id, from, brand, replySummary, draftedReply, threadId, subject }
async function pushPending(record) {
  try {
    const raw = await kvCmd(['GET', PENDING_KEY]);
    let items = [];
    if (raw) { try { items = JSON.parse(raw); } catch (_) { items = []; } }
    if (!Array.isArray(items)) items = [];

    const idx = items.findIndex((x) => x.id === record.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...record };
    else items.push(record);

    await kvCmd(['SET', PENDING_KEY, JSON.stringify(items)]);
    console.log(`[cron] pending queued: ${record.id} from ${record.from}`);
  } catch (err) {
    console.error(`[cron] pending update failed: ${err.message}`);
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}
// end of api/cron.js
