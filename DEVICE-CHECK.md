# Device check for 1.3 — Grace

Everything merged since 1.1.0 that a phone can actually show, and the
new essay feedback in §8. Grouped
by screen, one line each, and each says **what you should see** — so a
step that looks right but says the wrong thing is still a fail.

**Two surfaces, and they are not the same app.** Steps marked
**[app]** are the installed build; **[web]** means the site in a phone
browser, at `www.uniplannerapp.com`. A few things only exist on one of
them and are marked accordingly. If a step says [web] and you are in
the installed app, skip it.

**[†] marks a step that depends on a pull request that has NOT merged
yet** — #150 for the essay panel, #151 for the example rewrite. If the
build you are holding predates them, the step will fail correctly and
is not a bug. Check with Jared which build you have before reporting one
of those.

**Before you start:** Account tab, bottom of the screen — note the
**version** (twelve characters). Every bug report needs it, and if two
devices disagree about anything below, the first question is whether
they are on the same one. Sign in; most of this needs an account.

---

## 1. Everywhere

- [ ] **Tap into any text field.** The page should NOT pan sideways or
      zoom. Text in fields will look slightly larger than before — that
      is the fix, not a bug.
- [ ] **Rotate, and try the narrowest thing you have.** No row of
      buttons should run off the right edge, and nothing should sit
      under the status bar or the home indicator.
- [ ] **Switch to dark mode** (system settings). No white bars at the
      top or bottom when you scroll past the end. Note paper stays
      light in both modes, and text on it stays dark — that is
      deliberate.
- [ ] **Start a recording, then switch tabs.** The recording indicator
      should stay visible from every tab, with a working Stop on it.

## 2. AI lecture notes

- [ ] **First visit, signed in:** a full-screen consent gate naming
      **Groq** and **OpenAI**, both in the United States, with a way to
      decline that hands the tab back. Nothing about the AI features
      should work before you agree.
- [ ] **Record a short lecture and save it.** It should file itself
      into that course's folder.
- [ ] **[app] After that first saved note**, the phone's own *rate this
      app* prompt should appear — once, and never again on that device.
      It must NOT appear after a failed save. On Android the store may
      decline to show it at all (there is a per-device quota), so a
      no-show once is not conclusive; a prompt after the *second* note
      is a definite bug.
- [ ] **Open a saved lecture note from Notes.** There is now a
      **pencil/Edit** button beside the close button. Tapping it should
      put you straight into the editor with the note's text already in
      it — not a read-only view with a second button.
- [ ] **Edit it, save, reopen.** Your edit should be what you see. The
      notes list preview should quote **your text**, not the original
      AI summary.
- [ ] **Turn on airplane mode and open a lecture note you have not
      opened before.** No Edit button should appear at all. It should
      not appear and then do nothing.
- [ ] **If the note has a translation**, switch language and confirm
      the copy you are reading is the one that opens in the editor.

## 3. Readings (Textbook tab)

- [ ] **Summarise a reading by pasting text.** Before it runs you
      should see an estimate saying how many parts and how many
      credits, and how much you have left.
- [ ] **Choose photographs instead.** Before you take the first photo
      there should be a sentence comparing the two: photographs cost
      **18 credits per 4 pages**, pasting costs **3** for a section —
      and it should say a **screenshot counts as a photograph**.
- [ ] **On a free account, try nine photographed pages.** It should
      refuse before taking any money, saying the free plan covers eight
      and that paid plans are not capped.
- [ ] **After summarising a reading**, the reading's row should say
      **Summarised** and link to the note. Close the app, reopen, and
      check it still does — this one used to disappear on the next sync.
- [ ] **A reading long enough to split**: the saved note should say it
      was put together from several sections.

## 4. Notes and Folders

- [ ] **Make a note with bold, colour and a highlight**, press Done,
      then reopen it. All the formatting should still be there.
- [ ] **An old note that only ever had handwriting** should read
      **"Empty note"** in the list, keep its title, and open as an
      empty text note — not blank, not a stroke count.

## 5. Study

- [ ] **Tap the `?` on any Study section.** A panel opens **inline**
      (not a tooltip), with a concrete example and a line saying what
      the feature costs you.
- [ ] **Practice questions, explain-it-back, weak spots, summarise a
      note**: each should show what it will cost before it runs, and the
      allowance line should never say "this month" on a **free** account
      — it should say the credits do not reset.

## 6. Account

- [ ] **Bottom of the tab:** the version. Under it: *"Found a problem, or
      have an idea? Tell us"*. **[app] on iPhone** it opens Mail with the
      version and platform already in it; on Android and on the web it
      goes to the support page and asks you to quote the version.
- [ ] **The plan panel** should show your plan by name, the privacy
      policy link, and a terms link.
- [ ] **[app]** The plan you are on should still show. Whether there are
      buy buttons depends on the build: with no RevenueCat key set when
      that APK was built you should see **"In-app purchases aren't set up
      in this build."** — which is a *different* sentence from the web
      one on purpose, and seeing the web sentence in an installed app is
      itself a bug worth reporting. With a key but no products in the
      store dashboard, expect a plain "couldn't load the plans" rather
      than a purchase screen with nothing to buy.
- [ ] **[web]** There should be six plan buttons. Tap one while signed
      in: it must reach Stripe's checkout, **not** "Please sign in
      again." Back out without paying.
- [ ] The refund line should say credits already spent stay spent, and
      differ by surface: **[web]** *"the plan ends straight away"*,
      **[app]** *"the plan ends once the store tells us about the
      refund"* with no timing promised.
- [ ] **Backup panel:** the size of your planner, on every visit.
- [ ] **Archive:** signed out it should name the tool and say an account
      is needed; signed in, a failed load must read *"couldn't load"*,
      never *"nothing archived yet"*.

## 7. The website, in a phone browser  **[web]**

- [ ] **`uniplannerapp.com`** → the marketing page, and the app is at
      **`/app`**. Both the bare domain and `www` should work.
- [ ] **If you had the app installed or bookmarked before the split**,
      open it from the home screen: it should land on the working app,
      not a stale cached copy of the old one. This is the step most
      worth doing on a phone that had the app before.
- [ ] **The four legal pages** — `/privacy`, `/terms`, `/support`,
      `/delete-account` — all load, and `/terms` §7 mentions **20% of
      one month's credits**, `/support` mentions **180 / 600**.
- [ ] **A reset-password email link**, opened on the phone, should land
      on a screen that lets you set a new password.

## 8. Essay feedback  **[†] #150, #151**

Courses tab → **Grades** → add an assessment (a title and a weight is
enough). Every step below happens on that assessment's row. **Use your
own account, not the reviewer account** — its consent is deliberately
untouched for Apple. The order matters: a student meets the screens in
this order.

- [ ] **The consent screen first.** Tapping **Get feedback on a draft**
      the first time should show the AI consent screen (v8) if you have
      not agreed since it changed. It must say an essay is sent **exactly
      as written, including your name and student ID**, and that we do
      not remove anything. Screenshot it.
- [ ] **Then the essay opt-in.** A short list: it can be wrong and your
      marker's judgement counts; your unit's rules on AI help apply; it
      can show an example rewrite of one passage and puts nothing into
      your essay; we check it against real marks and **will ask once how
      we did when your mark comes back**; and we ask after each read
      whether it was useful. There should be **no** "use at your own
      risk". **Not now** closes it; opening the panel again asks again.
      Screenshot it.
- [ ] **One real run.** Paste a real draft and real criteria. Before it
      runs you should see **"One read costs 9 credits."** What comes
      back: if your criteria name bands, *"Against the criteria you
      pasted, this reads like a …"* **with the paragraph under it saying
      it is not a prediction of your mark** — the band must never
      appear without that paragraph. Then points, **"Worth working on
      first"** before **"Smaller things"**, each quoting your own words.
      The real question: do the points name things a marker would care
      about? Say which ones don't.
- [ ] **Opening it again does not re-ask** the consent or the opt-in.
- [ ] **Save to notes** files it into that course's folder, and the saved
      note carries the not-a-prediction paragraph under the band.
- [ ] **"Was this useful?"** Pick **Partly**: reasons appear. The comment
      box stays closed until you tick **Also send a comment**, and when
      open it says it is only sent on the tick and trains nothing. Send
      it: you should see a thank-you.
- [ ] **The example rewrite, if it is switched on in your build.** Each
      point then has **Show an example rewrite · An example costs 3
      credits.** It should come back **beside** your passage, labelled,
      with a line saying it isn't put into your essay and your unit's
      rules apply. Nothing in your essay or notes changes. **If there is
      no such button, it is switched off in this build — that is
      expected, not a bug.** If you do use it: afterwards **Your AI-use
      record** on that panel should list it, with **none of your essay's
      words in it**, and Copy should copy it.
- [ ] **The mark question must NOT appear yet** — nothing is marked.
- [ ] **Type a mark** into that assessment's mark box. While you are
      typing, nothing appears. Tap away: *"Your mark is in. How did our
      feedback compare to your marker's?"* Answer with the share tick
      **off**. It thanks you and **never asks again** on that assessment —
      check after force-quitting, and on a second device after a sync.
- [ ] **On a second assessment**, run feedback, enter a mark, and tap
      **Don't ask**. It never comes back either.
- [ ] **An assessment you never ran feedback on**, with a mark: no
      question, ever.

Jared checks the database half of this from the dashboard: a
`delivered` row per run, a `rated` row per answer, `on_mark` rows with
`mark` and `band` null when the tick was off.

---

## What is NOT on this list, and why

So you are not hunting for changes that cannot appear on a phone. Of
the 29 things merged since 1.1.0:

- **The macOS build** — signing, notarising, the disk image, and what
  the release publishes (six separate changes). Desktop only, and the
  check is `spctl` on a Mac.
- **The Stripe server half** — how a refund ends a plan, where the
  billing period is read from, the restricted-key permissions. Nothing
  renders. The part you *can* see is §6's refund line.
- **The photo model and its pricing** — the numbers in §3 are the
  visible half; which model runs behind them is not.
- **The re-summarise retry, the no-writing harness, the ASAP sampler,
  the Windows build fix, and the consent-material guard** — tests,
  measurement scripts and documents.

## If something is wrong

Note the **version** from §6 and which surface you were on ([app] or
[web]), and say what you saw rather than what you expected — "the Edit
button was there and did nothing" and "there was no Edit button" are
different bugs with different causes.
