// findDeals: given a family link key and a wishlist item, asks Claude to search
// the web for the best places to buy it, and saves the answer on the family doc
// so everyone with the family link sees it. Results are cached per item, and
// each list gets a daily cap so a shared link can't run up the bill.
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const Anthropic = require('@anthropic-ai/sdk');

initializeApp();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const DAILY_LIMIT = 15;
const CACHE_MS = 7 * 24 * 3600 * 1000;
const TIERS = ['', 'under about $25', 'about $25 to $75', 'over $75'];

const SAVE_TOOL = {
  name: 'save_options',
  description: 'Save the best places to buy the gift. Call this once, when your research is done.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      summary: {type: 'string', description: 'One short sentence: which version to get and why.'},
      options: {
        type: 'array',
        description: 'Two or three places to buy it, best first.',
        items: {
          type: 'object',
          properties: {
            store: {type: 'string'},
            price: {type: 'string', description: 'Current price as shown, like "$24.99"'},
            url: {type: 'string', description: 'Direct https link to the product page'},
            note: {type: 'string', description: 'A few words: shipping, why this pick, or a caveat'},
          },
          required: ['store', 'price', 'url', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'options'],
    additionalProperties: false,
  },
};

exports.findDeals = onCall(
  {secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, memory: '256MiB', maxInstances: 3, region: 'us-central1'},
  async (req) => {
    const {f, itemId} = req.data || {};
    if (!/^[A-Za-z0-9]{16,40}$/.test(f || '') || !/^[a-z0-9]{4,30}$/.test(itemId || '')) {
      throw new HttpsError('invalid-argument', 'Bad link');
    }
    const db = getFirestore();
    const famRef = db.doc(`families/${f}`);
    const fam = await famRef.get();
    if (!fam.exists) throw new HttpsError('not-found', 'List not found');
    const wish = await db.doc(`wishlists/${fam.get('kidKey')}`).get();
    const item = ((wish.exists && wish.get('items')) || []).find((i) => i.id === itemId);
    if (!item) throw new HttpsError('not-found', 'Item not found');

    const cached = (fam.get('research') || {})[itemId];
    if (cached && cached.name === item.name && Date.now() - cached.at < CACHE_MS) return cached;

    const day = new Date().toISOString().slice(0, 10);
    await db.runTransaction(async (t) => {
      const q = (await t.get(famRef)).get('quota') || {};
      const n = q.day === day ? q.n : 0;
      if (n >= DAILY_LIMIT) throw new HttpsError('resource-exhausted', 'Daily limit reached');
      t.update(famRef, {quota: {day, n: n + 1}});
    });

    const prompt = [
      `A family member is buying a gift for a kid in the US. The kid's wishlist says: "${item.name}".`,
      item.url ? `The kid linked this page: ${item.url}` : '',
      item.tier ? `Rough budget: ${TIERS[item.tier]}.` : '',
      'Search the web and find the two or three best places to buy it right now: well-reviewed versions,',
      'fair current prices, and reputable US stores. If the item is vague (like "keyboard"), pick the',
      'version most kids that age would want and say so in the summary. Then call save_options.',
    ].filter(Boolean).join('\n');

    const client = new Anthropic({apiKey: ANTHROPIC_API_KEY.value().trim()});
    const messages = [{role: 'user', content: prompt}];
    let result = null;
    for (let turn = 0; turn < 4 && !result; turn++) {
      const res = await client.beta.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {effort: 'medium'},
        tools: [
          {type: 'web_search_20260209', name: 'web_search', max_uses: 6,
            user_location: {type: 'approximate', country: 'US'}},
          SAVE_TOOL,
        ],
        tool_choice: {type: 'auto'},
        messages,
      });
      if (res.stop_reason === 'refusal') throw new HttpsError('failed-precondition', 'Lookup declined');
      const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'save_options');
      if (call) { result = call.input; break; }
      messages.push({role: 'assistant', content: res.content});
      // pause_turn means the server-side search loop wants to keep going: resend as is.
      if (res.stop_reason !== 'pause_turn') {
        messages.push({role: 'user', content: 'Please call save_options with what you found.'});
      }
    }
    if (!result) throw new HttpsError('internal', 'No result');

    const clean = (s, n) => String(s || '').slice(0, n);
    const saved = {
      name: item.name,
      at: Date.now(),
      summary: clean(result.summary, 300),
      options: (result.options || [])
        .filter((o) => /^https:\/\//.test(o.url || ''))
        .slice(0, 3)
        .map((o) => ({store: clean(o.store, 60), price: clean(o.price, 30), url: clean(o.url, 500), note: clean(o.note, 140)})),
    };
    await famRef.update({[`research.${itemId}`]: saved});
    return saved;
  },
);

// linkInfo: reads a product page's title so a pasted link can fill in the
// item name. Only someone holding a list link can call it, it only fetches
// public web addresses, and it returns nothing but a short title.
const dns = require('dns').promises;
const net = require('net');

function privateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
    return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function publicUrl(raw) {
  let u; try { u = new URL(raw); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || (u.port && !['80', '443'].includes(u.port)) || u.username) return null;
  const addrs = await dns.lookup(u.hostname, {all: true}).catch(() => []);
  return addrs.length && !addrs.some((a) => privateIp(a.address)) ? u : null;
}

async function readHead(url) {
  let u = await publicUrl(url);
  for (let hop = 0; u && hop < 4; hop++) {
    const res = await fetch(u, {redirect: 'manual', signal: AbortSignal.timeout(6000), headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'accept': 'text/html', 'accept-language': 'en-US,en;q=0.9'}});
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = await publicUrl(new URL(res.headers.get('location'), u).href); continue; }
    if (!res.ok || !/html/.test(res.headers.get('content-type') || '')) return '';
    // The title is near the top, so stop reading after 600 KB.
    const reader = res.body.getReader(); let html = ''; const dec = new TextDecoder();
    while (html.length < 600000) { const {done, value} = await reader.read(); if (done) break; html += dec.decode(value, {stream: true}); if (/<\/head>/i.test(html)) break; }
    reader.cancel().catch(() => {});
    return html;
  }
  return '';
}

const ENT = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'"};
const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ?
  String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);

function pickTitle(html) {
  const meta = (p) => (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*>`, 'i')) || [''])[0].match(/content=["']([^"']*)["']/i);
  const t = (meta('og:title') || meta('twitter:title') || html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  let s = unent(t).replace(/\s+/g, ' ').trim()
    .replace(/^Amazon\.com\s*:\s*/i, '').replace(/\s*:\s*[^:]*(Amazon\.com|Toys & Games|Electronics|Video Games)[^:]*$/i, '')
    .replace(/\s+[|–-]\s+[^|–-]{2,40}$/, '');
  if (!s || /^(amazon(\.com)?|robot check|page not found|access denied|just a moment|404|sorry!?.*|attention required.*)$/i.test(s)) return '';
  // Store titles pile on features after a comma or bar; keep the product name.
  const cut = s.slice(15).search(/\s*[,|(\[]/);
  if (cut >= 0) s = s.slice(0, cut + 15).trim();
  if (s.length > 70) s = s.slice(0, 70).replace(/\s+\S*$/, '');
  return s;
}

exports.linkInfo = onCall({timeoutSeconds: 20, memory: '256MiB', maxInstances: 3, region: 'us-central1'}, async (req) => {
  const {url, k, f} = req.data || {};
  const key = k || f; const ok = /^[A-Za-z0-9]{16,40}$/;
  if (!ok.test(key || '') || typeof url !== 'string' || url.length > 2000) throw new HttpsError('invalid-argument', 'Bad request');
  const doc = await getFirestore().doc(`${k ? 'wishlists' : 'families'}/${key}`).get();
  if (!doc.exists) throw new HttpsError('not-found', 'List not found');
  try { return {title: pickTitle(await readHead(url))}; } catch (e) { return {title: ''}; }
});
