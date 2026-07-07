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
const TRACKER_KEY = 'outreach_tracker'; // Redis key: JSON array of card objects
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
- supplier_hint -> flag card with 🏭 in Redis and draft a warm, natural follow-up
  to dig deeper without revealing intent.
- unknown -> flag 🟡 Needs Review, do not auto-send.

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
  supplier_hint:
    'Supplier says they cannot supply directly but points us toward another source/distributor. Thank them warmly for the lead and ask for an introduction or the contact details of the source they mentioned.',
};

// ===========================================================================
export default async function handler(req, res) {
  const startedAt = new Date().toISOString();
  console.log(`[cron] Eversen outreach responder started ${startedAt}`);

  const summary = { processed: 0, autoSent: 0, needsReview: 0, skipped: 0, errors: 0, actions: [] };

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

        if (classification.type === 'unknown' || !SCENARIOS[classification.type]) {
          await upsertTrackerCard({
            threadId, supplierEmail, subject,
            status: '🟡 Needs Review',
            classification: classification.type,
            note: classification.reason || 'Did not match a known scenario',
            lastReply: bodyText.slice(0, 500),
          });
          console.log(`[cron] thread ${threadId}: 🟡 Needs Review — NOT auto-sending`);
          summary.needsReview++;
          summary.actions.push({ threadId, action: 'needs_review', type: classification.type });
          continue; // do not mark read, so a human still sees it
        }

        // ---- Draft + send the reply as Eversen (via nodemailer OAuth2) ------
        const draft = await draftReply(classification.type, bodyText);
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
          threadId, supplierEmail, subject,
          status: statusForType(classification.type),
          classification: classification.type,
          note: 'Auto-replied by Eversen',
          lastReply: bodyText.slice(0, 500),
        });

        summary.autoSent++;
        summary.actions.push({ threadId, action: 'auto_sent', type: classification.type });
      } catch (innerErr) {
        console.error(`[cron] error on message ${msgRef.id}: ${innerErr.message}`);
        summary.errors++;
      }
    }

    console.log(`[cron] done — processed=${summary.processed} autoSent=${summary.autoSent} needsReview=${summary.needsReview} skipped=${summary.skipped} errors=${summary.errors}`);

    // Morning digest email (Resend)
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Shift64Diecast OS <onboarding@resend.dev>',
        to: ['Shift64Diecast@gmail.com', 'erictran925@gmail.com'],
        subject: `☀️ Shift64 Morning Digest — ${new Date().toLocaleDateString('en-US', {month:'short', day:'numeric'})}`,
        html: '<p>Good morning Eric! Open your <a href="https://brightsidelending.github.io/shift64diecast-os/">Shift64 OS dashboard</a> for today\'s buy opportunities and auctions.</p>'
      })
    });

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
{"type":"positive|needs_info|call_request|supplier_hint|unknown","confidence":"high|medium|low","reason":"one short sentence"}`;

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

// Merge/insert a card into the tracker array, keyed by threadId.
async function upsertTrackerCard(card) {
  try {
    const raw = await kvCmd(['GET', TRACKER_KEY]);
    let cards = [];
    if (raw) { try { cards = JSON.parse(raw); } catch (_) { cards = []; } }
    if (!Array.isArray(cards)) cards = [];

    const now = new Date().toISOString();
    const idx = cards.findIndex((c) => c.threadId === card.threadId);
    if (idx >= 0) cards[idx] = { ...cards[idx], ...card, updatedAt: now };
    else cards.push({ ...card, createdAt: now, updatedAt: now });

    await kvCmd(['SET', TRACKER_KEY, JSON.stringify(cards)]);
    console.log(`[cron] tracker updated: ${card.threadId} -> ${card.status}`);
  } catch (err) {
    console.error(`[cron] tracker update failed: ${err.message}`);
  }
}

function statusForType(type) {
  switch (type) {
    case 'positive': return '🟢 Positive';
    case 'needs_info': return '🔵 Info Sent';
    case 'call_request': return '📞 Call Requested';
    case 'supplier_hint': return '🏭 Supplier Hint';
    default: return '🟡 Needs Review';
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}
// end of api/cron.js
