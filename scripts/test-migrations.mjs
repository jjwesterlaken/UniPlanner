/* Tests for supabase/migrations/*.sql against a real PostgreSQL.

   SQL is the one part of this project that can't be checked by reading
   it: a migration either applies to a live database or it doesn't, and
   `delete_my_account()` is the single function where being wrong means a
   deleted account quietly keeps its lecture transcripts. So this spins up
   a throwaway cluster in a temp dir, applies the migrations to it, and
   asserts on what actually happened to the rows.

   Nothing here touches your Supabase project — it's entirely local, and
   the cluster is deleted afterwards.

   **Skips itself (exit 0) when PostgreSQL isn't installed**, which is the
   normal case on the machines this app is usually built from. Install it
   (macOS: `brew install postgresql@16`) if you want this coverage.

   Run via `npm run test:migrations`, or as part of `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const migrationsDir = path.join(rootDir, "supabase", "migrations");

/* ---------- locating postgres ---------- */

function findBinDir() {
  // A packaged postgres usually isn't on PATH (Debian/Ubuntu hides it in
  // /usr/lib/postgresql/<version>/bin), so look there too before giving up.
  const onPath = spawnSync("initdb", ["--version"], { stdio: "ignore" });
  if (onPath.status === 0) return "";

  const candidates = [];
  for (const base of ["/usr/lib/postgresql", "/usr/local/opt", "/opt/homebrew/opt"]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      const bin = path.join(base, entry, "bin");
      if (fs.existsSync(path.join(bin, "initdb"))) candidates.push(bin);
    }
  }
  // Highest version number wins.
  candidates.sort();
  return candidates.length ? candidates[candidates.length - 1] : null;
}

const binDir = findBinDir();
if (binDir === null) {
  console.log("migration tests skipped: no PostgreSQL install found (this is fine — see the comment in scripts/test-migrations.mjs)");
  process.exit(0);
}

const bin = (name) => (binDir ? path.join(binDir, name) : name);

/* initdb and postgres refuse to run as root. In a root container (CI, some
   Docker images) fall back to the `postgres` system user, which owns the
   data dir in that setup anyway. */
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const unprivilegedUser = asRoot ? "postgres" : null;

function exec(command, args, { input, allowFail = false } = {}) {
  const [cmd, cmdArgs] = unprivilegedUser
    ? ["su", [unprivilegedUser, "-c", [command, ...args].map((a) => `'${a}'`).join(" ")]]
    : [command, args];
  const result = spawnSync(cmd, cmdArgs, { input, encoding: "utf8" });
  if (!allowFail && result.status !== 0) {
    throw new Error(`${path.basename(command)} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

/* ---------- cluster lifecycle ---------- */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uniplanner-pg-"));
const dataDir = path.join(tmpRoot, "data");
const sockDir = path.join(tmpRoot, "sock");
fs.mkdirSync(sockDir);
if (asRoot) {
  // The unprivileged user needs to traverse in and write to both.
  fs.chmodSync(tmpRoot, 0o777);
  fs.chmodSync(sockDir, 0o777);
}

let started = false;

function stopCluster() {
  if (started) {
    exec(bin("pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], { allowFail: true });
    started = false;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

process.on("exit", stopCluster);

function psql(db, sql) {
  // -v ON_ERROR_STOP=1 makes a failing statement fail the whole script
  // rather than psql plowing on and exiting 0.
  const result = exec(bin("psql"), ["-h", sockDir, "-d", db, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-f", "-"], {
    input: sql,
    allowFail: true,
  });
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

function psqlOrThrow(db, sql) {
  const r = psql(db, sql);
  if (!r.ok) throw new Error(r.err || r.out);
  return r;
}

function applyMigration(db, file) {
  return psqlOrThrow(db, fs.readFileSync(path.join(migrationsDir, file), "utf8"));
}

/* ---------- Supabase stand-ins ---------- */

/* Just enough of what Supabase's platform provides for the migrations to
   have something to bind to. auth.uid() reads a GUC so a test can act as
   any user — that's the whole mechanism these functions are built on. */
const SUPABASE_STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;

  create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid;
  $$;

  create schema if not exists storage;
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text, name text, owner uuid
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select string_to_array(name, '/');
  $$;
`;

/* Documented in SUPABASE-SETUP.md §1 rather than created by a migration,
   so it's set up separately — some tests deliberately leave it out. */
const PLANNER_DATA = `
  create table public.planner_data (
    user_id uuid primary key references auth.users(id) on delete cascade,
    data jsonb not null,
    updated_at timestamptz not null default now()
  );
  alter table public.planner_data enable row level security;
`;

let dbCounter = 0;
function freshDb({ withPlannerData = true } = {}) {
  const name = `uniplanner_test_${dbCounter++}`;
  psqlOrThrow("postgres", `drop database if exists ${name}; create database ${name};`);
  psqlOrThrow(name, SUPABASE_STUBS);
  if (withPlannerData) psqlOrThrow(name, PLANNER_DATA);
  return name;
}

const one = (db, sql) => psqlOrThrow(db, sql).out;
const count = (db, table, where = "true") => Number(one(db, `select count(*) from ${table} where ${where};`));

/* ---------- tiny test harness (same shape as test-ai-notes.mjs) ---------- */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

const USER = "'11111111-1111-1111-1111-111111111111'";
const OTHER = "'22222222-2222-2222-2222-222222222222'";

function seedTwoUsers(db, { withPlannerData = true } = {}) {
  psqlOrThrow(
    db,
    `insert into auth.users (id) values (${USER}), (${OTHER});
     insert into public.ai_usage (user_id, month, minutes_used) values (${USER}, '2026-08', 12), (${OTHER}, '2026-08', 5);
     insert into public.ai_notes_requests (idempotency_key, user_id, status, result) values
       (gen_random_uuid(), ${USER}, 'done', '{"transcript":"my lecture"}'),
       (gen_random_uuid(), ${OTHER}, 'done', '{"transcript":"their lecture"}');
     ${withPlannerData ? `insert into public.planner_data (user_id, data) values (${USER}, '{}'), (${OTHER}, '{}');` : ""}`
  );
}

async function run() {
  console.log(`using postgres at ${binDir || "(on PATH)"}`);
  exec(bin("initdb"), ["-D", dataDir, "-A", "trust", "-U", "postgres"]);
  exec(bin("pg_ctl"), ["-D", dataDir, "-o", `-k ${sockDir} -h ""`, "-l", path.join(tmpRoot, "log"), "-w", "start"]);
  started = true;

  await test("every migration applies cleanly to an empty database, in order", () => {
    const db = freshDb();
    for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      applyMigration(db, file);
    }
  });

  await test("the signup trigger gives every new user a free-tier profile", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    psqlOrThrow(db, `insert into auth.users (id) values (${USER});`);
    assert.equal(one(db, `select tier from public.profiles where user_id = ${USER};`), "free");
  });

  await test("delete_my_account() removes every trace of the caller", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db);

    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);

    for (const table of ["public.profiles", "public.ai_usage", "public.ai_notes_requests", "public.planner_data"]) {
      assert.equal(count(db, table, `user_id = ${USER}`), 0, `${table} still holds the deleted user's rows`);
    }
    assert.equal(count(db, "auth.users", `id = ${USER}`), 0, "the auth.users row itself must go");
  });

  await test("delete_my_account() touches nobody else's data", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db);

    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);

    for (const table of ["public.profiles", "public.ai_usage", "public.ai_notes_requests", "public.planner_data"]) {
      assert.equal(count(db, table, `user_id = ${OTHER}`), 1, `${table} lost another user's rows`);
    }
    assert.equal(count(db, "auth.users", `id = ${OTHER}`), 1);
  });

  await test("the cascade alone would also clear the AI tables (belt and braces both hold)", () => {
    // If delete_my_account() ever loses its explicit deletes, ON DELETE
    // CASCADE still has to carry it — this is that half, tested on its own.
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    seedTwoUsers(db);
    psqlOrThrow(db, `delete from auth.users where id = ${USER};`);
    for (const table of ["public.profiles", "public.ai_usage", "public.ai_notes_requests"]) {
      assert.equal(count(db, table, `user_id = ${USER}`), 0, `${table} does not cascade from auth.users`);
    }
  });

  await test("a signed-out caller is refused, not silently ignored", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db);

    for (const fn of ["public.delete_my_account()", "public.delete_my_account_data()"]) {
      const r = psql(db, `set test.uid = ''; select ${fn};`);
      assert.equal(r.ok, false, `${fn} must raise when auth.uid() is null`);
      assert.match(r.err, /must be called by a signed-in user/);
    }
    // And nothing was deleted on the way to refusing.
    assert.equal(count(db, "public.ai_notes_requests"), 2);
  });

  await test("anon can't call the deletion functions; authenticated can", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    for (const fn of ["public.delete_my_account()", "public.delete_my_account_data()"]) {
      assert.equal(one(db, `select has_function_privilege('anon', '${fn}', 'execute');`), "f", `anon must not be able to call ${fn}`);
      assert.equal(one(db, `select has_function_privilege('authenticated', '${fn}', 'execute');`), "t", `authenticated must be able to call ${fn}`);
    }
  });

  await test("0002 never overwrites a delete_my_account() the project already had", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    psqlOrThrow(
      db,
      `create table public.sentinel (note text);
       create function public.delete_my_account() returns void language plpgsql security definer as $$
       begin insert into public.sentinel values ('the project''s own logic ran'); end; $$;`
    );

    const result = applyMigration(db, "0002_account_deletion.sql");
    assert.match(result.err || "", /already exists and was left unchanged/, "0002 must say so rather than replacing it silently");

    psqlOrThrow(db, `insert into auth.users (id) values (${USER}); set test.uid = ${USER}; select public.delete_my_account();`);
    assert.equal(count(db, "public.sentinel"), 1, "the project's own deletion logic was replaced");
    // ...and the helper it's told to call is available to be added to it.
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account_data();`);
    assert.equal(count(db, "public.profiles", `user_id = ${USER}`), 0);
  });

  await test("0002 is re-runnable (a second apply changes nothing and fails nothing)", () => {
    const db = freshDb();
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db);
    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);
    assert.equal(count(db, "auth.users", `id = ${USER}`), 0);
  });

  await test("deletion still works on a project that never created planner_data", () => {
    // SUPABASE-SETUP.md §1 documents planner_data, but no migration creates
    // it — so it genuinely may not exist. It mustn't take the AI-notes
    // cleanup down with it.
    const db = freshDb({ withPlannerData: false });
    applyMigration(db, "0001_ai_notes.sql");
    applyMigration(db, "0002_account_deletion.sql");
    seedTwoUsers(db, { withPlannerData: false });

    psqlOrThrow(db, `set test.uid = ${USER}; select public.delete_my_account();`);
    assert.equal(count(db, "public.ai_notes_requests", `user_id = ${USER}`), 0);
    assert.equal(count(db, "auth.users", `id = ${USER}`), 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
