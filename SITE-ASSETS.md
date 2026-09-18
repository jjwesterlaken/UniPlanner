# What the website needs shot, in one sitting

Everything Jared and Grace have to produce before the marketing page can
go live. Read the whole thing before picking up a phone — the setup
notes at the bottom save more time than the shot list does.

**SHOT, 18 September 2026: iPhone 16 Pro Max simulator, 1320 × 2868**
(ratio 0.4603). The moto g05 was the original plan because the Android
build is verified on it; the website is the target rather than Play, and
the shots were taken on the simulator that was to hand.

**What matters for the page is that every phone shot has the SAME
RATIO**, because the slots are a fixed aspect box and `object-fit:
cover` crops whatever does not match. All six do — checked, not assumed.
The device is otherwise interchangeable.

The original reasoning, kept because it still applies the day these are
reshot for a store listing: shooting on a real device is the point
there, since a browser's device emulation has the wrong font rendering
and the wrong status bar, and both are visible.

---

## The short version

| | Count |
|---|---|
| Phone screenshots (iPhone 16 Pro Max, 1320 × 2868 portrait) | **6** |
| Desktop screenshots (1920 × 1032 browser, cropped to 1896 × 900) | **2** |
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
- **DARK MODE is the main set and light is the variant** — the reverse
  of what this document originally specified. Decided by looking at the
  shots: the app's dark ground photographs better against the page's
  own light ground, and the teal accents carry. Shoot in dark unless a
  shot is specifically listed as light.

**Turn on Do Not Disturb** and **hide the notification shade** before the
first shot. A carrier name and a battery icon are fine and make it look
real; a WhatsApp banner is a reshoot.

---

## The six phone shots

Portrait, full screen, no cropping — the site crops. Shoot at the
device's native 1600 × 720.

| # | Screen | What must be visible | Why it is on the list |
|---|---|---|---|
| **1** | **Home / Today** | The three courses, the next deadline with its countdown, the week number | The hero. It has to answer "what is this?" in one glance, and the week number is what says "this knows my semester". |
| **2** | **AI lecture notes — a finished note** | The summary's overview and 2–3 key points, the course folder it filed into | The thing being sold. Scroll so the overview and the first key points are both in frame; a screenshot of a heading with nothing under it sells nothing. |
| **3** | **Study — review in progress** | A card mid-review with the four rating buttons, and the "due today" count | The daily-use screen. Show the ANSWER side, not the question side — the question side is a screenshot of one sentence. |
| **4** | **Readings — a summary open** | A reading row expanded with its summary panel showing | The newest feature and the one nobody expects. The collapsed row plus the open panel in one frame shows how it attaches. |
| **5** | **Grades — a course with a required mark** | The assessments entered, and the "you need 80% for a Distinction" line | The feature Grace bounced off. The required-mark line is the payoff and the only part worth a screenshot. |
| **6** | **Light mode — the same screen as shot 1** | Same content, `--mode` set to light | One light shot is enough to say "it does both". Two is a waste of a slot. The main set is dark, so this is the variant. |

**Aspect ratio for the site: whatever the device gives, used as-is —
but the SAME one for all six.** The shipped set is 1320 × 2868 (0.4603).
No device frame in the source image — the page adds the frame in CSS so
it can be adjusted without a reshoot.

**The slots are `aspect-ratio: 9/16` (0.5625), so a 0.4603 shot is
cropped top and bottom by about 9% each end.** Frame accordingly: what
is at the very top or very bottom of a shot may not survive. The hero is
the exception and has its own ratio in CSS, because it is a 60% crop of
shot 1 and cropping it again would take ~13% off each side.

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
- Name them exactly: `phone-1-home.png`, `phone-2-ai-note.png`,
  `phone-3-study.png`, `phone-4-readings.png`, `phone-5-grades.png`,
  `phone-6-light.png`, `desktop-1-wide.png`, `desktop-2-recording.png`,
  `hero.png`.
- Drop them in `public/site/`. **`build-site.mjs` copies every `.png` it
  finds there to the site root, read from the folder rather than listed**
  — the claim that "the build copies `public/` wholesale, so no build
  change is needed" was wrong and cost a failed build: the site build
  copies named icons and fonts, and the link checker then refused the
  page for referencing files sitting in `public/site/` the whole time.
- **They are optimised at build time, not by hand.** Ship the originals;
  hand-compressed screenshots are how a re-crop becomes a reshoot.

## What is NOT on this list, deliberately

- **Store screenshots.** Play and the App Store have their own required
  sizes and their own rules, and shooting for both at once produces
  images that suit neither. Separate sitting, when a listing exists.
- **Anything with a real person's coursework in it.**
- **A video or a GIF.** A moving hero is a different decision and a much
  bigger asset budget; if it is wanted, it is wanted after the page
  exists and can be measured.
