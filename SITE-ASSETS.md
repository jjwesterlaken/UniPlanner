# What the website needs shot, in one sitting

Everything Jared and Grace have to produce before the marketing page can
go live. Read the whole thing before picking up a phone — the setup
notes at the bottom save more time than the shot list does.

## THE PAGE NEEDS NO FIXED PIXEL SIZE — it needs ONE RATIO and ENOUGH PIXELS

**Ruled 18 September 2026**, replacing "Device: moto g05, 1600 × 720".
The device was never the requirement; it was a stand-in for one, and
naming it made a change of phone look like a change of spec. Read off
the CSS the page actually uses (`.shot` in `public/site/index.html`):

| what the box does | consequence for a shot |
|---|---|
| `aspect-ratio: 9/16` | the box is 0.5625 wide-over-tall, whatever you shot |
| `max-height: 520px` | the largest it ever renders is **292 × 520 CSS px** |
| `object-fit: cover` | a shot of any other ratio is **centre-cropped, never distorted** |

So the three requirements, and none of them is a pixel count:

1. **One ratio across all six phone shots.** Shoot them all on the same
   device and this is free. Mixing devices is the only way to get it
   wrong, because the box crops each one by a different amount and the
   framing stops matching between shots.
2. **At least ~900 px on the long-edge-perpendicular (the width).** 292
   CSS px at 3× is 878. Anything above that is wasted on this page and
   costs nothing, so do not downscale. **A 720 px-wide shot is
   marginal** — which the moto g05 was, and is one reason the device
   requirement was worth dropping rather than porting.
3. **Compose for the crop, because there IS one.** `cover` fills the
   9:16 box from the centre, so a taller shot loses its top and bottom:

   | shot ratio | height lost | each end |
   |---|---|---|
   | 20:9 (0.450) — moto g05 | ~20% | ~10% |
   | 19.5:9 (0.462) — iPhone Pro Max | ~18% | ~9% |

   **The status bar and the tab bar are cut.** That is usually what you
   want and it is why the old text said "the site crops" — but it never
   said how much, so anything you deliberately framed at the very top or
   the very bottom will not survive.

**iPhone 17 Pro Max simulator is fine, and better than the moto g05 on
point 2.** Shoot every phone shot on it, note its native size once at
the top of the delivery, and the ratio takes care of itself. A simulator
screenshot is acceptable here in a way it would not be for a store
listing: this page renders each shot inside a CSS frame at 292 px wide,
where the font-rendering differences the old text warned about are not
resolvable.

**Desktop stays at exactly 1440 × 900**, because those two shots are
shown side by side and a mismatch between them IS visible.

---

## The short version

| | Count |
|---|---|
| Phone screenshots (one device, one ratio, ≥900px wide) | **6** |
| Desktop screenshots (1440 × 900 window) | **2** |
| Hero image | **1** — a re-crop of phone shot 1, no separate shoot |
| **Total to shoot** | **8** |

One sitting, maybe forty minutes with the data set up beforehand.

---

## Before you shoot anything: the account

**Use a demo account with plausible-but-fake content, not a real one.**
Every screenshot goes on a public page, and real coursework is the
student's. Set up once and shoot all eight from it.

What needs to exist for the screens below to look alive rather than
empty:

- **3 courses**, with codes that read as real but are not a real
  university's units — e.g. `BIOL120 Cell Biology`, `HIST210 Modern
  Europe`, `STAT150 Data Analysis`. Give each a distinct colour.
- **4–6 assignments** across those courses, at least one due within a
  week (so the countdown shows something urgent) and one overdue.
- **A semester start date set**, so the workload forecast says "Week 9"
  rather than a bare date. This is the difference between a screenshot
  that shows the feature and one that shows a date.
- **~20 study cards** across two courses, with **at least 6 due today**
  so the review screen has a number in it.
- **A study streak of at least 3 days.** It cannot be faked in the UI;
  either study on three consecutive days or set the device date forward
  twice. Worth doing — "3 day streak" is the single most
  screenshot-friendly number in the app.
- **One AI lecture note**, saved, with a real-looking summary. Record
  something read aloud for three or four minutes rather than a real
  lecture; the note only has to look plausible at screenshot size.
- **Light mode**, unless a shot is specifically listed as dark.

**AND THE TWO THE LIST USED TO MISS.** Shots 4 and 5 need data no other
shot needs, and neither was on this checklist until 18 September 2026 —
which is how a sitting ends with four shots and two reshoots.

- **For shot 4, a reading with a SAVED SUMMARY.** Readings were absent
  from this list entirely. A reading row with pages entered is not
  enough: the shot is of the summary panel, so the summary has to have
  been generated and saved against that row already. It is the one
  setup item that **spends credits**, so do it first — discovering it at
  the camera means waiting on a provider call with the phone in your
  hand. Enter a reading on `HIST210` (e.g. *pp. 89–112, "The Vienna
  Settlement"*), paste a few paragraphs, summarise it, and check the row
  then reads **Summarised** with the panel opening inline.

- **For shot 5, ASSESSMENTS WITH WEIGHTS AND MARKS.** The "4–6
  assignments" above are the deadlines collection — a different thing
  from the assessments that carry weights and marks, and Grades reads
  only the latter. With no marks entered there is no required-mark line
  and the screen is empty.

  **Enter exactly this on one course** (`BIOL120` is a good choice —
  three marked pieces and an unmarked exam reads as a real unit in
  week 11). The marks are not illustrative; they were derived by running
  the real `requiredForBand()` from `src/grades.js`, and they produce
  the exact sentence this page's copy quotes:

  | Assessment | Weight | Mark |
  |---|---|---|
  | Quiz 1 | 10% | 75 |
  | Essay | 25% | 70 |
  | Lab report | 25% | 70 |
  | **Final exam** | **40%** | *leave unmarked* |

  Weights total 100, earned is 42.5 of a possible 60, and the screen
  then reads:

  > **You need 80% on Final exam for a Distinction.**

  Rounding must be left on the default (**half-up**); switching it to
  *rounded down* moves the target half a mark and the line changes.

  **Known cosmetic, decide before you shoot:** with a 40% exam
  remaining, High Distinction reads *"isn't reachable — full marks on
  everything left would finish you on 82.5%"*. That is the feature being
  honest and it may be exactly what you want in frame. If you would
  rather every band still be live, make the final worth **50%** and the
  three marked pieces **10/20/20 at 75 / 70 / 65** — every band is then
  reachable, HD needs 100% and D still needs exactly 80%.

  *(That second table was wrong the first time it was written here —
  75/70/70 gives 78%, not 80%. Both variants above were checked by
  running `requiredForBand()`, which is the only way to know: the
  arithmetic is one subtraction and it still came out wrong by two
  marks.)*

**Turn on Do Not Disturb** and **hide the notification shade** before the
first shot. A carrier name and a battery icon are fine and make it look
real; a WhatsApp banner is a reshoot.

---

## The six phone shots

Portrait, full screen, no cropping of your own — the page crops, by
about a ninth off each end. Shoot at the device's native resolution and
deliver it unscaled.

| # | Screen | What must be visible | Why it is on the list |
|---|---|---|---|
| **1** | **Home / Today** | The three courses, the next deadline with its countdown, the week number | The hero. It has to answer "what is this?" in one glance, and the week number is what says "this knows my semester". |
| **2** | **AI lecture notes — a finished note** | The summary's overview and 2–3 key points, the course folder it filed into | The thing being sold. Scroll so the overview and the first key points are both in frame; a screenshot of a heading with nothing under it sells nothing. |
| **3** | **Study — review in progress** | A card mid-review with the four rating buttons, and the "due today" count | The daily-use screen. Show the ANSWER side, not the question side — the question side is a screenshot of one sentence. |
| **4** | **Readings — a summary open** | A reading row expanded with its summary panel showing | The newest feature and the one nobody expects. The collapsed row plus the open panel in one frame shows how it attaches. |
| **5** | **Grades — a course with a required mark** | The assessments entered, and the "you need 80% for a Distinction" line | The feature Grace bounced off. The required-mark line is the payoff and the only part worth a screenshot. |
| **6** | **Dark mode — whichever of 1 or 3 looks best** | Same content, `--mode` set to dark | One dark shot is enough to say "it does dark mode". Two is a waste of a slot. |

No device frame in the source image — the page adds the frame in CSS so
it can be adjusted without a reshoot.

## The two desktop shots

**Window sized to exactly 1440 × 900** before shooting, so the two match
each other. Chrome's device toolbar at "Responsive → 1440 × 900" is
easiest; do not use full-screen on a 4K monitor, the text ends up
unreadably small on the page.

| # | Screen | What must be visible |
|---|---|---|
| **7** | **The planner, wide** | The sidebar and a course open — the layout that a phone screenshot cannot show |
| **8** | **AI notes on desktop, mid-recording** | The recording indicator and the timer running, with the course and week fields filled |

Shot 8 is the one that justifies the desktop download existing at all:
**system-audio recording is the first genuine reason to install the
desktop build**, so it should be the desktop screenshot that is not just
"the same thing but wider".

## The hero

**A re-crop of phone shot 1**, not a separate shoot: the top ~60% of the
frame, so the deadline and the week number survive and the tab bar is
cut off. Supply it as a crop rather than re-shooting, so it can never
drift out of step with shot 1.

---

## Delivery

- **PNG, unmodified, straight off the device.** No annotation, no
  arrows, no drop shadows, no phone frames — all of that is CSS and all
  of it should stay changeable.
- **Name them exactly.** Four of these used to be an ellipsis, which is
  not a name; they were settled on 18 September 2026 and the page
  references these strings literally:

  | # | File |
  |---|---|
  | 1 | `phone-1-home.png` |
  | 2 | `phone-2-ai-note.png` |
  | 3 | `phone-3-study.png` |
  | 4 | `phone-4-readings.png` |
  | 5 | `phone-5-grades.png` |
  | 6 | `phone-6-dark.png` |
  | 7 | `desktop-1-wide.png` |
  | 8 | `desktop-2-recording.png` |
  | — | `hero.png` |
- Drop them in `public/site/` — the build copies `public/` wholesale, so
  no build change is needed.
- **They are optimised at build time, not by hand.** Ship the originals;
  hand-compressed screenshots are how a re-crop becomes a reshoot.

## WIRING THE PAGE COMES AFTER THE SHOOT, and the build enforces it

`index.html` still carries five `<div class="shot">` PLACEHOLDERS. They
cannot be turned into `<img>` tags before the files exist, because
`scripts/build-site.mjs` checks every `src`/`href` against the built
output and **throws** on one that resolves to nothing:

```
Error: index.html links to files that are not in dist-site: hero.png, …
```

That guard is right and stays — its own comment records the bug it was
written for, a rewritten `site.js` path that pointed somewhere and not
at a file, which shipped a dead script tag and an entirely empty page
that looked fine in the markup. **A rewrite that points somewhere is not
the same claim as a rewrite that points at a file.** So the order is:
shoot → drop the PNGs in `public/site/` → wire the page. Trying it the
other way fails the build rather than shipping a broken image, which is
the direction you want.

Three things are ready to apply the moment the files land:

- each placeholder becomes `<div class="shot"><img src="…" alt="…"
  loading="lazy" decoding="async"><span>…caption…</span></div>`, with
  the **hero on `loading="eager" fetchpriority="high"`** instead — it
  is the largest element above the fold, so lazy-loading it would defer
  the LCP of the page it is the hero of;
- `.shot > *{grid-area:1/1}` so the caption sits BEHIND the image in the
  same cell: a shot that loads covers it, a shot that 404s leaves it
  showing, and that half needs no script;
- a `captionTheMissingShots()` in `site.js` adding `.noimg` on `error`,
  which is the one thing CSS cannot do — suppress the browser's
  broken-image glyph drawn on top of the caption. It must also test
  `img.complete && img.naturalWidth === 0`, because a cached failure
  resolves before the listener attaches and that is the second page
  load, which is the one most visitors get.

## THE PAGE HAS FIVE SLOTS AND THIS LIST SPECIFIES NINE ASSETS

Unreconciled, and it is a design decision rather than a naming one. The
five `.shot` slots map to: **hero**, **shot 2** (AI notes), **shot 5**
(grades), **shot 3** (study), **shot 1** (home, in the Planner block).

That leaves **`phone-4-readings.png`, `phone-6-dark.png`,
`desktop-1-wide.png` and `desktop-2-recording.png` with nowhere to
go.** Readings is not one of the page's four feature blocks, and there
is no dark-mode or desktop strip. Either the page grows somewhere to put
them — Grace's call, it is her mockup — or those four come off this
list. **Decide before the sitting**: four of the eight shots are
currently for a page that cannot show them.

## What is NOT on this list, deliberately

- **Store screenshots.** Play and the App Store have their own required
  sizes and their own rules, and shooting for both at once produces
  images that suit neither. Separate sitting, when a listing exists.
- **Anything with a real person's coursework in it.**
- **A video or a GIF.** A moving hero is a different decision and a much
  bigger asset budget; if it is wanted, it is wanted after the page
  exists and can be measured.
