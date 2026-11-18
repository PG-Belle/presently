#!/usr/bin/env node
// pdata: read and update Presently data from the terminal.
//
// Signs in with Google Application Default Credentials. One time setup:
//   gcloud auth application-default login
//
//   node scripts/pdata.js people [group]       list people (id, name, group, birthday, start date)
//   node scripts/pdata.js wish <kidKey>         show a kid wishlist and its family claims
//   node scripts/pdata.js apply <plan.json>     preview a plan (writes nothing)
//   node scripts/pdata.js apply <plan.json> --yes   write it, backing up first
//   node scripts/pdata.js undo <backup.json> --yes  put backed up docs back
//
// Plan format (every part optional):
//   { "people":  [{ "id":"p_x", "set":{ "birthday":"--09-28", "started":"2018-08-29" } }],
//     "add":     [{ "name":"Moses Badran", "group":"pg", "birthday":"--11-02", "started":"2026-09-22" }],
//     "remove":  ["p_x"],
//     "wishlist":{ "key":"<kidKey>", "add":[{ "name":"Mousepad", "star":1, "tier":1, "url":"",
//                                             "given":2026, "claimBy":"Belle" }] } }
// Only these docs can be touched: users/<uid>/items/*, wishlists/*, families/*.
const path = require('path');
const fs = require('fs');
const fromFunctions = (m) => require(require.resolve(m, {paths: [path.join(__dirname, '../functions')]}));
fromFunctions('firebase-admin/app').initializeApp({projectId: 'presently-63110'});
const db = fromFunctions('firebase-admin/firestore').getFirestore();
const BACKUPS = path.join(__dirname, '../.backups');
const PERSON_FIELDS = ['name', 'group', 'also', 'birthday', 'started', 'notes', 'budget', 'age', 'ageYear', 'icon', 'links', 'gifts'];
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const die = (m) => { console.error(m); process.exit(1); };
const okDate = (k, v) => v === '' || (k === 'birthday' ? /^(\d{4}|-)-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(v);

async function owner() {
  if (process.env.PRESENTLY_UID) return process.env.PRESENTLY_UID;
  const refs = await db.collection('users').listDocuments();
  if (refs.length !== 1) die(`Found ${refs.length} accounts. Set PRESENTLY_UID to pick one.`);
  return refs[0].id;
}

async function people(group) {
  const col = db.collection(`users/${await owner()}/items`);
  const snap = await col.get();
  const rows = snap.docs.map((d) => d.data()).filter((p) => p.type === 'person' && (!group || p.group === group || (p.also || []).includes(group)));
  rows.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  rows.forEach((p) => console.log([p.id, p.name, p.group + ((p.also || []).length ? '+' + p.also.join('+') : ''), p.birthday || '-', p.started || '-', p.wish ? 'wish:' + p.wish.k : ''].join('\t')));
  console.log(`${rows.length} people`);
}

async function wish(k) {
  const w = await db.doc(`wishlists/${k}`).get();
  if (!w.exists) die('No wishlist with that key');
  const fam = (await db.collection('families').where('kidKey', '==', k).limit(1).get()).docs[0];
  const claims = fam ? fam.get('claims') || {} : {};
  console.log(`${w.get('kid')}'s list${fam ? ` (family key ${fam.id})` : ''}`);
  (w.get('items') || []).forEach((i) => console.log(['', i.id, i.name, '★'.repeat(i.star || 0) || '-', '$'.repeat(i.tier || 0) || '-',
    i.gotYear ? 'given ' + i.gotYear : '', claims[i.id] ? 'claimed by ' + claims[i.id].by : ''].join('\t')));
}

// Works out every doc write in a plan, without writing.
async function build(plan) {
  const u = await owner();
  const writes = []; const notes = [];
  for (const {id, set} of plan.people || []) {
    const ref = db.doc(`users/${u}/items/${id}`); const snap = await ref.get();
    if (!snap.exists || snap.get('type') !== 'person') die(`No person ${id}`);
    const bad = Object.keys(set).filter((k) => !PERSON_FIELDS.includes(k)); if (bad.length) die(`Can't set ${bad.join(', ')}`);
    for (const k of ['birthday', 'started']) if (k in set && !okDate(k, set[k])) die(`Bad ${k} for ${snap.get('name')}: ${set[k]}`);
    const next = {...snap.data(), ...set}; if (set.birthday) next.age = null;
    const diff = Object.keys(set).filter((k) => JSON.stringify(snap.get(k) ?? '') !== JSON.stringify(set[k] ?? ''));
    if (!diff.length) continue;
    writes.push({ref, before: snap.data(), after: next});
    notes.push(`update ${snap.get('name')}: ${diff.map((k) => `${k} ${JSON.stringify(snap.get(k) ?? '')} -> ${JSON.stringify(set[k])}`).join(', ')}`);
  }
  for (const a of plan.add || []) {
    const bad = Object.keys(a).filter((k) => !PERSON_FIELDS.includes(k)); if (bad.length) die(`Can't set ${bad.join(', ')}`);
    if (!a.name || !a.group) die('New people need a name and group');
    for (const k of ['birthday', 'started']) if (a[k] && !okDate(k, a[k])) die(`Bad ${k} for ${a.name}`);
    const id = 'p_' + uid();
    const p = {id, type: 'person', name: a.name, group: a.group, birthday: '', started: '', age: null, ageYear: new Date().getFullYear(),
      icon: '', photo: '', links: [], notes: '', budget: '', gifts: [], created: Date.now(), ...a};
    writes.push({ref: db.doc(`users/${u}/items/${id}`), before: null, after: p});
    notes.push(`add ${a.name} to ${a.group}${a.birthday ? ', birthday ' + a.birthday : ''}${a.started ? ', started ' + a.started : ''}`);
  }
  for (const id of plan.remove || []) {
    const ref = db.doc(`users/${u}/items/${id}`); const snap = await ref.get();
    if (!snap.exists || snap.get('type') !== 'person') die(`No person ${id}`);
    writes.push({ref, before: snap.data(), after: null});
    notes.push(`remove ${snap.get('name')} (${snap.get('group')}, ${(snap.get('gifts') || []).length} gifts)`);
  }
  if (plan.wishlist) {
    const {key, add = []} = plan.wishlist;
    const wref = db.doc(`wishlists/${key}`); const w = await wref.get(); if (!w.exists) die('No wishlist with that key');
    const fsnap = (await db.collection('families').where('kidKey', '==', key).limit(1).get()).docs[0];
    const items = [...(w.get('items') || [])]; const claims = {...(fsnap ? fsnap.get('claims') || {} : {})};
    const have = new Set(items.map((i) => i.name.toLowerCase()));
    for (const x of add) {
      if (!x.name) die('Wishlist items need a name');
      if (have.has(x.name.toLowerCase())) { notes.push(`skip "${x.name}" (already on the list)`); continue; }
      const it = {id: uid(), name: String(x.name).slice(0, 120), url: x.url || '', star: Math.min(2, Math.max(0, x.star | 0)),
        tier: Math.min(3, Math.max(0, x.tier | 0)), added: Date.now()};
      if (x.given) it.gotYear = x.given;
      if (x.claimBy) { if (!fsnap) die('No family doc to claim on'); claims[it.id] = {by: x.claimBy, at: Date.now()}; }
      items.push(it);
      notes.push(`add to ${w.get('kid')}'s list: ${it.name} ${'★'.repeat(it.star)}${'$'.repeat(it.tier)}${it.gotYear ? ', given ' + it.gotYear : ''}${x.claimBy ? ', claimed by ' + x.claimBy : ''}`);
    }
    if (items.length > 150) die('A list holds up to 150 items');
    writes.push({ref: wref, before: w.data(), after: {...w.data(), items, updated: Date.now()}});
    if (fsnap) writes.push({ref: fsnap.ref, before: fsnap.data(), after: {...fsnap.data(), claims, updated: Date.now()}});
  }
  return {writes, notes};
}

async function commit(writes, label) {
  fs.mkdirSync(BACKUPS, {recursive: true});
  const file = path.join(BACKUPS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(writes.map((w) => ({path: w.ref.path, before: w.before})), null, 1));
  const batch = db.batch();
  writes.forEach((w) => (w.after === null ? batch.delete(w.ref) : batch.set(w.ref, w.after)));
  await batch.commit();
  return file;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2); const yes = process.argv.includes('--yes');
  if (cmd === 'people') return people(arg);
  if (cmd === 'wish') return wish(arg);
  if (cmd === 'apply') {
    const {writes, notes} = await build(JSON.parse(fs.readFileSync(arg, 'utf8')));
    notes.forEach((n) => console.log(n));
    if (!writes.length) return console.log('Nothing to change');
    if (!yes) return console.log(`\nPreview only. ${writes.length} docs would change. Add --yes to write.`);
    console.log(`\nWrote ${writes.length} docs. Backup: ${await commit(writes, 'apply')}`);
    return;
  }
  if (cmd === 'undo') {
    const saved = JSON.parse(fs.readFileSync(arg, 'utf8'));
    if (!saved.every((s) => /^(users\/[^/]+\/items|wishlists|families)\/[^/]+$/.test(s.path))) die('Backup has paths outside Presently');
    const writes = []; for (const s of saved) { const ref = db.doc(s.path); writes.push({ref, before: (await ref.get()).data() || null, after: s.before}); }
    saved.forEach((s) => console.log(`${s.before ? 'restore' : 'remove'} ${s.path}`));
    if (!yes) return console.log('\nPreview only. Add --yes to restore.');
    console.log(`\nRestored. Backup of what was replaced: ${await commit(writes, 'undo')}`);
    return;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 21).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
main().catch((e) => die(e.message.includes('default credentials') ? 'Not signed in. Run: gcloud auth application-default login' : e.message));
