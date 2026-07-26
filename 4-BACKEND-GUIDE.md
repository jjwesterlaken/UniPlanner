# Connecting a real server (accounts + sync)

The app already has the whole account and sync system built. What's missing is
the server. This explains exactly what that server has to do.

Everything lives in **`src/sync.js`**. You will not need to touch the app's UI.

---

## What's already done

- Sign up / sign in / sign out screens
- A "Sync now" button and last-synced timestamp
- Timestamping of every single edit
- **Merging** two devices' data, deciding per item which edit is newest
- **Tombstones**, so a note deleted on your phone doesn't come back from your laptop
- Automatic cleanup of tombstones after 60 days

The merge logic is the fiddly part of sync and it's finished and tested.

## What's simulated for now

`demoBackend` in `src/sync.js` pretends to be a server using this device's own
storage. It lets the whole flow be used and tested, but **nothing actually
travels between devices**, and passwords are not checked.

---

## Step 1 — Pick a backend

You mentioned AWS. You can absolutely use it, but for an app this size raw AWS
is a lot of work (Cognito + API Gateway + Lambda + DynamoDB, all wired by hand).
These give you accounts and a database out of the box:

| Option | Why you'd pick it |
|---|---|
| **Supabase** | Postgres + accounts + per-user security rules. Generous free tier. Easiest good choice. |
| **Firebase** | Google's equivalent. Very easy, real-time sync built in. |
| **AWS Amplify** | If you specifically want to be on AWS, this is the manageable front door to it. |
| **PocketBase** | One small program you host yourself. Cheapest long term, but you maintain the server. |

If you use Supabase or Firebase, their own SDK replaces most of the code in
`remoteBackend` — you'd call their auth functions instead of `fetch`.

## Step 2 — The server needs five routes

If you build your own API instead, this is the whole contract:

| Route | Receives | Returns |
|---|---|---|
| `POST /auth/signup` | `{email, password}` | `{user: {id, email}, token}` |
| `POST /auth/login` | `{email, password}` | `{user: {id, email}, token}` |
| `POST /auth/logout` | Bearer token | `{}` |
| `GET /planner` | Bearer token | `{data}` — or 404 if none saved yet |
| `PUT /planner` | Bearer token, `{data}` | `{serverUpdatedAt}` |

The app stores everything as **one JSON blob per user**, so the database can be
tiny:

```
users(id, email, password_hash, created_at)
planner_data(user_id, data JSON, updated_at)
```

## Step 3 — Flip the switch

1. In `src/sync.js`, set `API_BASE` to your server's address.
2. At the very bottom of that file, change one line:

```js
// export const backend = demoBackend;
export const backend = remoteBackend;
```

3. Rebuild. The demo-mode warnings disappear on their own, because the UI reads
   `backend.isDemo`.

---

## Security rules you must not skip

The demo is deliberately insecure so it's obvious it isn't finished. A real
server must:

- **Hash passwords** with bcrypt or argon2. Never store them as text.
- **Check the password** on the server. The demo doesn't — it can't safely.
- **Scope every query to the signed-in user**, so nobody can read anyone else's
  planner. On Supabase this is Row Level Security; on your own API it's a
  `where user_id = ...` on every single query.
- **Use HTTPS only.**
- **Expire tokens**, and offer password reset by email.
- **Rate-limit sign-in** to slow down guessing.

## Two things worth deciding early

**Do notes need to be private from you?** If you want true end-to-end privacy,
the data must be encrypted on the device before it's uploaded. That's a much
bigger job and makes password resets destructive (a lost password means lost
data). Most planner apps don't do this, but it's easier to decide now than later.

**How often should it sync?** Right now it syncs when you sign in and when you
press "Sync now". Automatic syncing on a timer or when the app regains focus is
a few lines once the server is live — deliberately left out so you can see
exactly when it happens while testing.
