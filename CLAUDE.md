# Presently

Belle's holiday gift tracker. Tracks gifts for ProductsGo staff, Auragami staff, home (nanny), family and friends, year after year, with budgets, a shopping list and printable gift tags.

Live at https://presentlyhqpresently-gifts.web.app (Firebase project `presently-63110`, Hosting site `presentlyhqpresently-gifts`). Data in Firestore. Google sign-in.

## Layout

```
public/index.html          the whole app: HTML, CSS and JS in one file (no build step)
public/manifest.webmanifest, icon-*.png, apple-touch-icon.png   add-to-home-screen bits
firebase.json              hosting (serves public/) + Firestore rules
firestore.rules            each user can only read/write users/<their uid>/items/*
```

Keep it a single self-contained `index.html` with no bundler unless Belle asks otherwise. Firebase is loaded with the compat SDK from gstatic, and the project config comes from the Hosting reserved URL `/__/firebase/init.js`, so there is no config or API key in the repo.

## Run and deploy

```
firebase emulators:start --only hosting,firestore,auth   # local, serves /__/firebase/init.js
firebase deploy                                           # hosting + rules
firebase deploy --only hosting                            # page changes only
```

Opening `public/index.html` straight from disk works too, but without Firebase it runs signed out on localStorage only.

## Data model

One Firestore doc per person plus one `settings` doc, under `users/<uid>/items/`. Mirrored to localStorage (`presently.v1`) as an on-device copy; signed out, the app runs on that copy, and on first sign-in with an empty account the local list is uploaded.

```js
// person
{ type:'person', id:'p_x', name, group:'pg', birthday:'YYYY-MM-DD'|'', started:'YYYY-MM-DD'|'' /* work start */, age:null|n, ageYear,
  icon:'', photo:'' /* small jpeg data URL */, links:[{url}], notes, budget:''|n,
  gifts:[{ id, name, price, url, got, year, occasion:'holiday'|'birthday'|'anniversary' }] }
// settings
{ budgets:{ '2026':1500 }, groups:[{id,label,color}], from, greet, tagStyle:'burst'|'eye'|'spark' }
```

Default groups: ProductsGo (`pg`), Auragami, Home, Family, Friends. Holiday progress counts only holiday gifts (birthday and anniversary gifts are tracked but not counted) in the selected year; "spent" sums prices of gifts marked got.

## Features (keep working when changing things)

People with photo or icon, birthday or age (age ticks up yearly), wishlist links, notes, per-person budget. Groups with filter chips and a Groups editor. "Add a team" (paste many names into a group, optional same gift for each). "Gift for all <group>" (one gift added to everyone in the filtered group, with Undo). Gifts with got-it circles and a "Got it!" sticker. Past years per card. Summary boards with year switcher, budget bar, Christmas countdown. Birthdays-coming-up and work-milestone (1, 5, 10, 15+ yr) chips, tenure on cards, tap-to-cycle fun facts. Calendar view: 12 months of birthday lunches and work anniversaries, plus a Missing dates table that saves on change. Shopping list view. Gift tags (canvas preview, 10 per letter page PDF via jsPDF). Search. Sample people. Backup / import (JSON copy and paste, or choose a .json file). Undo toasts.

## Staff gifting

PG staff each get four holiday items: Book, Library card holder + card, Cash bonus (cash goes inside the book with the card), Small gift to open. Work anniversary gifts at 1, 5 and 10 years. Monthly birthday lunches. Staff data lives in Firestore, never in this repo.

## Design

Retro sale-flyer look: black ground, cream hairline frames, flat color, no outlines on shapes.

- Colors: bg `#0d0c0b`, card `#171513`, cream ink `#f6ecd4`, soft `#b8ad96`, blue `#4b87c9`, pink `#f08da4`, yellow `#f5b945`, green `#2f9b4c`, orange `#ee7b2f`, red `#e8483f`, sky `#8fbbe8`
- Type: Rammetto One (uppercase) for display and buttons, Poppins for body
- Signature pieces: arched double-line cream frame with green starburst medallions; header scene of a green sunburst flanked by pink pillars with eyes, red and orange half-domes; pink pill CTA with a hard yellow offset shadow
- Phone first: 44px tap targets, 16px inputs, chips scroll sideways on phone, bottom-sheet modals

## Rules

- No em dashes anywhere in UI copy or docs. Use periods, commas or colons.
- Keep copy short and direct.
- After changes, check the page at phone width (390px) and desktop.
