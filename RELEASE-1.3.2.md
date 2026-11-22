# 1.3.2 — the hardening release

Started 22 November 2026 (Sydney). 1.3.2 is a hardening release on every
platform: web, iOS, Android and desktop. What was planned as 1.3.2 moved
to RELEASE-1.4.0.md unchanged.

A record of what is planned and what has merged, not evidence of what is
live. Each item lands as its own pull request with a test that failed
before the change and passes after it.

**The version bump is the last commit**, and it waits until desktop
v1.3.1 is published.

| # | Item | State |
|---|---|---|
| 1 | CI: test fixtures take their dates from the clock; the test workflow also runs once a day; a browser suite that skips for want of Chromium still fails on a check that ran | In review |
| 2 | Semester setup: the mid-semester break saves when its two dates are entered one at a time. Website: photos added to a reading or to marking criteria show their thumbnails. The app's script, styles and worker are revalidated on every load | Planned |
| 3 | Plans: a web subscriber changes plan in the billing portal; the panel follows a web purchase until it lands and names Stripe; the account-deletion confirmation names an active subscription and links to managing it | Planned |
| 4 | Lecture notes: "Get it back" keeps the lecture's course, week and translation, and a recovered summary can be retried | Planned |
| 5 | Wording: the website, privacy policy, terms, store listing and backup panel describe what the app does | Planned |
| 6 | Version 1.3.2 on every platform | Waits for desktop v1.3.1 |
