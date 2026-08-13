# Email delivery — setting up Resend

Account creation and password reset both depend on email that does not
reliably arrive today. Supabase's built-in sender is rate-limited to a
handful of messages an hour and lands in spam routinely.

**This blocks the closed test as much as it blocks launch.** A tester who
cannot confirm their account wastes the fortnight they are spending on
you, so this should be done before the twelve testers are invited.

Most of this is dashboard and DNS work. Nothing here is a code change —
the code side is already done and is confirmed at the end.

---

## ⚠️ Read this before touching DNS

**The domain already has an SPF record, for Google Workspace.**

A domain may have **exactly one** SPF TXT record. Publishing a second one
does not add to the first — it makes both invalid, and mail starts
failing for *both* senders. That would take down Jared's Google Workspace
mail, which is a considerably worse outcome than a slow signup email.

So:

- If Resend asks for SPF on the **root domain** (`uniplannerapp.com`),
  the `include:` must be **merged into the existing record**, not added
  beside it. One record, two includes:

  ```
  v=spf1 include:_spf.google.com include:amazonses.com ~all
  ```

  (Resend sends via Amazon SES, so its include is usually
  `include:amazonses.com`. **Use whatever Resend's own dashboard shows** —
  do not copy this line blindly.)

- **If Resend asks you to verify a subdomain instead — take that option.**
  A subdomain such as `send.uniplannerapp.com` carries its own SPF record,
  entirely separate from the root. **The conflict then cannot happen at
  all**, which is why it is the safer route and the one Resend now
  recommends by default.

**Send the exact records here before saving them.** SPF mistakes are
quiet: mail keeps flowing for a while from cached lookups, then stops.

DKIM and DMARC records do **not** have this problem — a domain can carry
many DKIM keys, and DMARC is a single record but the domain may not have
one yet.

---

## 1. At Resend

1. Create an account at `resend.com`. The free tier is 3,000 emails a
   month / 100 a day, which is far beyond what this needs.
2. **Domains → Add Domain.**
   - Enter `send.uniplannerapp.com` if offered the choice of a subdomain.
     This avoids the SPF conflict above entirely.
   - Region: choose the one nearest Australia if offered.
3. Resend shows a set of DNS records — typically three: an MX and a TXT
   (SPF) for the subdomain, and one or more CNAMEs for DKIM.
   **Copy them exactly and send them here before entering them.**
4. **API Keys → Create API Key.** Give it *Sending access* only. Copy the
   key — it is shown once. This is the SMTP password in step 3.

---

## 2. At Squarespace (DNS)

Squarespace holds the DNS for `uniplannerapp.com`. The nameservers were
deliberately never moved, so this is where records go.

**Squarespace → Settings → Domains → uniplannerapp.com → DNS Settings →
Custom Records.**

For each record Resend gave you, add a row. Notes that catch people out:

- **The host field is relative.** If Resend says the record is for
  `send.uniplannerapp.com`, enter `send` — not the full name. If it says
  `resend._domainkey.send.uniplannerapp.com`, enter
  `resend._domainkey.send`. Entering the full name creates
  `send.uniplannerapp.com.uniplannerapp.com`, which is the single most
  common failure here.
- **Do not touch the existing MX records.** Those are Google Workspace
  and carry Jared's actual mail. The Resend MX record, if there is one,
  is for the *subdomain* and does not conflict.
- **TXT values often need quotes stripped.** Squarespace usually wants
  the value without surrounding quotation marks.

Then wait. Propagation is usually minutes but can be an hour. Resend's
Domains page shows each record as verified when it sees it.

**Do not proceed to step 3 until Resend shows the domain as Verified.**
Supabase will accept the settings regardless and simply fail to send.

---

## 3. At Supabase

**Project → Authentication → Emails → SMTP Settings.** Enable custom
SMTP and enter:

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | the API key from step 1.4 |
| Sender email | `noreply@send.uniplannerapp.com` (must be on the domain you verified) |
| Sender name | `University Planner` |

Port 465 is implicit TLS. If Supabase rejects it, try `587`, which is
STARTTLS — both are supported.

**Also raise the rate limit.** Authentication → Rate Limits → *Rate limit
for sending emails*. The default is set for the built-in sender and is
the thing that throttles a burst of tester signups. Something like 100
per hour is sensible now that a real provider is behind it.

### Email templates

**Authentication → Emails → Templates.** These do **not** need changing
for the custom domain — Supabase builds the confirmation and recovery
links from the project's own URL and the `redirectTo` we pass, not from
the sending domain.

Worth doing anyway, once, because these are the first thing a new student
sees and the defaults say "Supabase":

- Change the subject lines to mention University Planner.
- Confirm signup, Reset password, and Magic Link are the three that
  matter. Leave `{{ .ConfirmationURL }}` exactly as it is — that is the
  link.

---

## 4. Redirect URLs — unchanged, and here is why

**Authentication → URL Configuration → Redirect URLs must still contain
`https://www.uniplannerapp.com`.**

This does *not* change when mail comes from a different sender. The two
are independent: the sending domain decides who the mail is *from*, and
the redirect allowlist decides where a link may *land*. Changing one has
no effect on the other.

It matters because the app passes `redirectTo` explicitly (derived from
`SITE_URL` in `src/legalLinks.js`) rather than relying on the project's
Site URL. **If that URL is not on the allowlist, Supabase silently
ignores it and falls back to the Site URL** — which is the failure that
looks like a code bug when it is a configuration one.

So: confirm it is still listed after making these changes. Nothing here
should have removed it.

---

## 5. Verification — with a real inbox, end to end

Neither of these can be verified by reading code, which is exactly how
password reset stayed broken. **Use an address that has never been used
with this app before**, on the live site.

### Signup

1. Sign up with a fresh address.
2. The email arrives within a minute or two — **check spam** and report
   if it was there, since that means DNS is incomplete rather than
   working.
3. The sender reads as University Planner, not Supabase.
4. Click the link. It confirms the address server-side and lands you on
   `www.uniplannerapp.com`.
5. Sign in with the password you chose. **The account works.**

### Password reset

1. Account → **Forgot your password?**
2. The email arrives.
3. Click the link. The app loads and a **"Set a new password"** card
   appears over it.
4. Set a new password. You are signed in.
5. Sign out; sign in with the new password. It works. The old one does
   not.

### Failure signatures — these are different problems

| What happens | Where the fault is |
|---|---|
| No email at all, no error in the app | DNS not verified, or the API key is wrong. Check Resend's **Logs** — if the send appears there, the problem is delivery; if it does not, Supabase never sent it. |
| Email lands in spam | DNS incomplete — usually DKIM missing, or no DMARC record. Not a code problem. |
| Email arrives from `supabase.io` | Custom SMTP is not actually enabled, or was saved without the domain verified. |
| Link opens the site but nothing happens (reset) | A code problem — `detectSessionInUrl` or the recovery listener. Report it. |
| Link 404s, or opens the wrong host | Redirect URL missing from the allowlist, so Supabase fell back to the Site URL. |
| "Email link is invalid or has expired" | The link was already used, or it is older than the token lifetime. Request a fresh one — only a bug if it happens on a first click. |

Step 2 succeeding tells you DNS and SMTP are right. Everything after that
is the app.

---

## What is already done, in code

Nothing here needs a change. For completeness:

- `resetPassword` passes `redirectTo` explicitly, derived from
  `SITE_URL`, so the app and the email cannot disagree.
- `detectSessionInUrl` is gated on the protocol being `http:`/`https:`,
  so the reset link is processed on the hosted site and ignored in the
  desktop and phone shells where no such link can appear.
- The "Forgot password?" link and the password-recovery screen both
  exist, and both backends implement `resetPassword` and
  `updatePassword`, so demo mode cannot throw on that path.
- Signup confirmation happens server-side at `/auth/v1/verify` before the
  browser reaches our code, so it works regardless of session detection.
  The only thing that was ever lost is auto-sign-in.
