// findDeals: given a family link key and a wishlist item, asks Claude to search
// the web for the best places to buy it, and saves the answer on the family doc
// so everyone with the family link sees it. Results are cached per item, and
// each list gets a daily cap so a shared link can't run up the bill.
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
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
    const db = admin.firestore();
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

    const client = new Anthropic({apiKey: ANTHROPIC_API_KEY.value()});
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
