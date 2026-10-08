# Device check for 1.3 and 1.3.1 — Grace

Everything merged since 1.1.0 that a phone can actually show, and the
new essay feedback in §8. Grouped
by screen, one line each, and each says **what you should see** — so a
step that looks right but says the wrong thing is still a fail.

**Two surfaces, and they are not the same app.** Steps marked
**[app]** are the installed build; **[web]** means the site in a phone
browser, at `www.uniplannerapp.com`. A few things only exist on one of
them and are marked accordingly. If a step says [web] and you are in
the installed app, skip it.

**Build 1.3.0 from `main` after the essay-persistence fix has merged**
(the pull request after #155). Everything in §8 is in that build. If
the version on the Account tab is older than the one Jared gives you,
§8 will fail correctly and is not a bug.

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

## 8. Essay feedback

There are two ways in, and both end on the same place:

- [ ] **From the AI tab:** below the lecture notes there is a card,
      **Essay feedback**, with a **Course (optional)** dropdown set
      to **No course** and the draft and criteria boxes **right there**.
      Pick a course — it should switch to it. Paste, run, and the result
      should appear **on the AI tab**, without moving you anywhere. Then
      go to **Courses → Grades**: under that course there is a new row,
      **"Essay draft, <today's date>"**, reading **no weight**. Your
      grade for the course should not change. Type a mark into that row
      and tap away: the mark question should appear.
- [ ] **Linking a draft to the real assessment.** Run a draft from the
      AI tab under a course, then add the real assessment (say "Essay 1",
      with its weight) using **Add assessment** at the foot of that
      course's card on Grades. The draft's row should now offer
      **This draft is for [Essay 1] · Link**. Link it: the draft's row
      disappears, and Essay 1 says it **includes feedback from a draft
      you linked**. Type a mark on Essay 1 and tap away: the mark
      question appears there. On a course with no real assessment, the
      draft's row should say to add the real one first.
- [ ] **From Courses → Grades**, on any assessment row: **Essay
      feedback**. (Named "Get feedback on a draft" before 1.3.1.)

Every step below happens on that assessment's row. **Use your
own account, not the reviewer account** — its consent is deliberately
untouched for Apple. The order matters: a student meets the screens in
this order.

- [ ] **The consent screen first.** Tapping **Essay feedback**
      the first time should show the AI consent screen (v8) if you have
      not agreed since it changed. It must say an essay is sent **exactly
      as written, including your name and student ID**, and that we do
      not remove anything. Screenshot it.
- [ ] **Then the essay opt-in.** A short list: it can be wrong and your
      marker's judgement counts; your unit's rules on AI help apply; it
      can show an example rewrite of one passage and puts nothing into
      your essay; we check it against real marks and **will ask once how
      we did when your mark comes back**; we ask after each read
      whether it was useful; and **a result you haven't saved is lost if
      the app reloads or closes, so Save to notes to keep it**. There should be **no** "use at your own
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
- [ ] **Photograph your criteria**, under the criteria box. Before you
      tap it, the line under it says **up to 4 photos cost 18 credits**, says a screenshot counts as a photo, and
      says pasting costs nothing extra. Photograph a real rubric (a
      printout, and a screenshot of the LMS page). The criteria should
      appear **in the box, word for word, with the band names exactly as
      written**, and you can edit them. Say which words or bands it got
      wrong. **If it could only read part of the page it must say so** —
      naming what it missed and that nothing was charged — and never
      present half a rubric as done. A photo of a task-description page
      with no marking table on it should say it found no criteria. Five photos at once should be refused before anything
      is sent. A photo of something that isn't a rubric should say it
      found no criteria and that nothing was charged.
- [ ] **The `?` beside the panel's title** opens three numbered steps
      inline (paste before you submit; you're pointed at problems and
      can ask for an example rewrite; tell us how we did when the mark
      comes back), with a line under them saying an unsaved result is
      lost on reload, and closes again from the same `?`.
- [ ] **THE RESULT SURVIVES LEAVING THE TAB — the bug from Jared's
      run.** With a result on screen, tap **Study**, then **Courses**.
      The result should still be there, **not** the empty form, and your
      credits should have moved **once** (9), not twice. Then try it
      **mid-run**: press **Read my draft** and switch tab immediately;
      come back and it should either still be working (no button to
      press again) or show the result. Never an empty form you could
      pay for twice.
- [ ] **Closing the panel (×) throws the result away**, and opening it
      again starts empty. Force-quitting also loses an unsaved result —
      that is deliberate (your essay is never stored); **Save to notes**
      is how you keep one.
- [ ] **Opening it again does not re-ask** the consent or the opt-in.
- [ ] **Save to notes** puts it in **Notes → Essay feedback**, titled
      **"<assessment name> — <date>"**, and files it into that course's
      folder. It opens **read-only** (no Edit), and it carries the
      not-a-prediction paragraph under the band.
- [ ] **"Was this useful?"** Pick **Partly**: reasons appear. The comment
      box stays closed until you tick **Also send a comment**, and when
      open it says it is only sent on the tick and trains nothing. Send
      it: you should see a thank-you.
- [ ] **The example rewrite.** Each point has a **button** — bordered,
      obviously pressable — reading **Show an example rewrite**, with
      **"An example costs 3 credits."** on a line underneath. If it
      reads as a caption rather than a button, say so. It should come back **beside** your
      passage, labelled, with a line saying it isn't put into your essay
      and your unit's rules apply. Nothing in your essay or notes
      changes. Check the example **adds nothing your essay didn't say** —
      no new name, number or source — and say if it does. If it is ever
      refused ("went outside your passage"), the message must say
      **nothing was charged**, and your credits must not move. The
      same goes for a feedback read that is refused or comes back
      unusable: the message says nothing was charged, and nothing is.
      Afterwards **Your AI-use record** on that panel should list it,
      with **none of your essay's words in it**, and Copy should copy it.
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

## 9. What's new in 1.3.1  **[app]** and **[web]**

**Build 1.3.1 from `main` after the last 1.3.1 change has merged** (the
pull request after #181). The Account tab's version must match the one
Jared gives you. Seed a semester with two courses, each with two or
three assessments (one an exam with a date), two assignments in Plan
(one with the same title and date as an assessment), and a few study
cards.

**Courses and Grades**
- [ ] **Courses tab** opens on **Semester setup**, then **Grades**.
      There is no separate Courses list any more.
- [ ] **Add a course** is the last card in Grades. Type a name you
      already have, in different capitals: it says *"You already have a
      course called …"* and the Add button stays off. A new name makes a
      new card.
- [ ] **Rename a course** with the pencil on its card. Afterwards its
      assessments, its study cards, its assignments in Plan and its
      readings all show the **new name**. Try renaming it to another
      course's name: it refuses on the card and nothing changes.
- [ ] **Remove a course** with the bin. Before anything happens it says
      how many assessments go with it and that everything else keeps
      the tag. Cancel works. Remove takes the card away; its study
      cards still say the old name.
- [ ] **Tap a course's tag** on its card: everything for that course is
      highlighted across the app. Tap again to clear.
- [ ] Each card has its own **Add assessment**; the new row lands on
      that card. Assessments with no course are on a **No course** card
      at the bottom.

**The same piece of work in Plan and Grades**
- [ ] **Plan → Assignments** also lists Grades' assessments that have a
      date, in a dashed box, *"In Grades · 40%"*, with **Open in Grades →**.
      Tap it: you land on that row in Grades.
- [ ] **Grades** shows, on each course card, *"Also in Plan, no weight
      yet"* with your Plan assignments for that course and **Open in
      Plan →**. They are **not** counted in the mark.
- [ ] The essay you entered in **both** places shows as **two rows on
      both screens**, each labelled with where it lives. Nothing is
      merged, and editing one does not change the other.

**Calendar**
- [ ] A day with a Grades date shows it in a dashed box, *"From
      Grades · 40%"*, with **Open in Grades →**, and **no** edit or delete
      buttons. The day has a dot for it.
- [ ] **Add** on the Calendar: under the form, *"Exams and assessments go
      in Courses → Grades…"*. Type a title with **exam**, **quiz** or
      **test** in it: a note suggests Grades instead, and **Add to
      calendar still works**.

**Upcoming, non-teaching weeks, recurring events**
- [ ] **Plan → Upcoming**: an exam shows on its own week as *"Exam · N
      days to go"*, even ten weeks out, and its study plan opens from it.
      There is no separate exam countdown in Study.
- [ ] **Semester setup → Other non-teaching weeks**: add two ranges.
      Teaching-week numbers in Upcoming skip them, and a week inside one
      reads *"Non-teaching week"*.
- [ ] A **weekly class** set to end with the semester skips the break
      and both extra ranges.

**Notes, Study, To-do, AI**
- [ ] **Notes** has an **Essay feedback** section; a saved result opens
      **read-only** (no Edit) and is not listed again among your notes.
- [ ] **Study cards**: the per-course option is **Drill** ("Drill · 3 to
      go", "Drill done", "Drill again"). Nothing in Study cards says
      Practice; **Practice questions** (the AI one) still does.
- [ ] **Break this into steps** on an assignment, then **To-do**: each
      step says *"From <assignment> →"* on its own line; tapping it opens
      that assignment with its steps showing. A ticked step's link is not
      crossed out. Delete the assignment: its steps say *"From an
      assignment you deleted"*.
- [ ] **Recording, Stop and Pause** (the recorder's ending was rebuilt in
      1.3.1, and phones are the one place no test here can drive it):
      record a minute from the microphone, **Pause**, **Resume**, then
      **Stop** — notes arrive as before. Stop from the floating
      indicator on another tab does the same. A Stop that does nothing
      is the failure to report.
- [ ] **[web, on a computer]** **This computer's audio**, share a tab that
      is playing sound, then go to that tab: the planner's tab reads
      *"● Recording · UniPlanner"*. Close the shared tab: it reads
      *"Recording stopped · UniPlanner"* until you go back to it. The
      review says sharing stopped and offers **Record the rest**; tap it:
      the notes so far are saved and the share picker opens for the same
      course and week.
- [ ] **AI lecture notes**: after a result, *"Were these notes useful?"*
      with Yes / Partly / No. Partly or No shows six reasons; the comment
      box only appears when you tick to send one. Send says thanks. Save
      first instead, and the question is still there on the Saved screen.
      Jared checks the rows in `lecture_notes_feedback`.

**The five store screenshots** (6.9", 1320×2868, iPhone only, your own
seeded account, never the reviewer account)
- [ ] 1. **Upcoming** with a busy week and an exam row with its days to go.
- [ ] 2. **An AI lecture note result**, with the rating question visible.
- [ ] 3. **An essay feedback result** on an assessment.
- [ ] 4. **A Grades course card** showing what you need for an HD, with
      its rename and remove controls.
- [ ] 5. **A study card under review.**

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
