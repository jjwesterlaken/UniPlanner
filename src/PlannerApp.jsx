import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  backend,
  mergeData,
  purgeOldTombstones,
  getDeviceId,
  nowISO,
  COLLECTIONS,
  COUNTABLE_COLLECTIONS,
  supabase,
} from "./sync.js";
import {
  schedule,
  readSrs,
  isDue,
  localDay,
  buildReviewSession,
  buildPracticeSession,
  nextDueDay,
  daysBetween,
  weakSpots,
  recordStudy,
  studySummary,
  clampSessionMinutes,
  MAX_SESSION_MINUTES,
  idleTimer,
  timerElapsedMs,
  timerMinutes,
  timerStart,
  timerPause,
  timerStop,
  timerDiscard,
  timerPark,
} from "./srs.js";
import {
  GRADE_BANDS,
  bandByCode,
  summarise,
  hurdleOf,
  requiredForBand,
  bestReachableBand,
  displayMark,
  describeRequirement,
  ROUNDING_RULES,
  DEFAULT_ROUNDING,
  inheritedRounding,
} from "./grades.js";
import {
  forecastWorkload,
  buildBreakdown,
  reconcileBreakdown,
  strandedSubTasks,
  examCountdowns,
  buildStudyPlan,
  topicsForCourse,
  weekLabel,
  BREAKDOWN_TEMPLATES,
} from "./workload.js";
import {
  GraduationCap,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  BookOpen,
  ClipboardList,
  FileText,
  ListTodo,
  StickyNote,
  Flame,
  Timer,
  TrendingDown,
  Sparkles,
  Target,
  AlarmClock,
  CalendarClock,
  Brain,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Repeat,
  Palette,
  RotateCcw,
  ArrowRight,
  MoreVertical,
  Folder,
  FolderPlus,
  Type,
  PenLine,
  Bold,
  Italic,
  Underline,
  Baseline,
  Highlighter,
  Droplet,
  Eraser,
  Undo2,
  Download,
  Upload,
  DatabaseBackup,
  Save,
  UserRound,
  LogOut,
  RefreshCw,
  CloudCheck,
  TriangleAlert,
  Mic,
} from "lucide-react";
import { AiNotesPanel, AiLectureNoteView } from "./aiNotes.jsx";
import { PracticePanel, WeakSpotsExplain, ExplainItBack, SummariseNote, useTextAllowance } from "./aiText.jsx";
import { buildAttempt, pruneAttempts, weakTopics } from "./practice.js";
import { classifyStorageError, describeSaveFailure, describeSize, formatBytes } from "./storageHealth.js";
import { aiNotePreview, mapAiResultToItems } from "./aiNotesLogic.js";
import {
  isAiNote,
  isRemote,
  buildContent,
  migrateNote,
  pagesNeedingMigration,
  deleteNote,
  reconcile,
  previewFor,
} from "./aiNotesStore.js";
import { noteCache } from "./noteCache.js";
import { deleteAccount, confirmationMatches, DELETE_CONFIRMATION_PHRASE } from "./accountDeletion.js";
import {
  nextReadState,
  readingProgress,
  isRead,
  isStarted,
  rubricProgress,
  hasRubric,
  validateRubric,
  splitPastedRubric,
  emptyCriterion,
  checkLength,
  canAddRubric,
  RUBRIC_LABEL_MAX,
  RUBRIC_NOTE_MAX,
  RUBRIC_CRITERIA_MAX,
  isReferenceSheet,
  sheetSummary,
  validateSheet,
  canAddSheet,
  emptyEntry,
  FORMULA_KIND,
  ENTRY_LABEL_MAX,
  ENTRY_BODY_MAX,
  SHEET_ENTRIES_MAX,
} from "./reference.js";
import { PRIVACY_URL, DELETE_ACCOUNT_URL } from "./legalLinks.js";

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "uni-planner-v1";

// Works in two places: the Claude preview (window.storage) and a hosted
// copy on your phone (the browser's own localStorage). Everything is guarded
// so it never crashes if a store is unavailable.
const store = {
  async get(key) {
    try {
      if (typeof window !== "undefined" && window.storage && window.storage.get) {
        const r = await window.storage.get(key);
        return r && r.value ? r.value : null;
      }
    } catch (e) {
      /* fall through */
    }
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  },
  /* Returns { ok } or { ok:false, reason, bytes }.
     This used to swallow the failure. It must not: once the planner
     outgrows the browser's quota, saving stops, and a demo-mode user
     loses everything on refresh with nothing on screen to say so.
     See src/storageHealth.js. */
  async set(key, val) {
    const bytes = typeof val === "string" ? val.length : 0;
    try {
      if (typeof window !== "undefined" && window.storage && window.storage.set) {
        await window.storage.set(key, val);
        return { ok: true };
      }
    } catch (e) {
      /* fall through to localStorage rather than reporting — the
         preview host being absent isn't a failure the user can act on */
    }
    try {
      window.localStorage.setItem(key, val);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: classifyStorageError(e), bytes };
    }
  },
  async del(key) {
    try {
      if (typeof window !== "undefined" && window.storage && window.storage.delete) {
        await window.storage.delete(key);
        return;
      }
    } catch (e) {
      /* fall through */
    }
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
  },
};

const SEMESTER_NAMES = ["Semester 1", "Semester 2"];

// Collections the user thinks of as "their stuff". studyStats syncs like
// any other collection but is bookkeeping, not content -- counting its ~43
// rows per semester would make "247 items" in the backup panel meaningless.
// Classified in sync.js, beside the list it classifies.
const COUNTABLE = COUNTABLE_COLLECTIONS;

// Each semester holds its own independent set of content.
const makeSemester = () => ({
  courses: [],
  todos: [],
  textbook: [],
  assignments: [],
  notes: [], // class notes that feed the study cards
  events: [], // calendar entries
  pages: [], // free notebook pages with titles
  folders: [], // folders for organising notebook pages
  assessments: [], // weights and marks per course (src/grades.js)
  settings: [], // one row: teaching calendar + grade rounding rule
  studyStats: [], // one row per studied day + one totals row (src/srs.js)
});

const DEFAULT = {
  semester: "Semester 1",
  theme: "teal",
  semesters: {
    "Semester 1": makeSemester(),
    "Semester 2": makeSemester(),
  },
  // Bookkeeping used by cross-device sync.
  meta: { updatedAt: nowISO(), lastSyncedAt: null },
};

// Accept older saved data and always return a valid, sync-ready shape.
function normalizeData(parsed) {
  const out = { semester: SEMESTER_NAMES.includes(parsed.semester) ? parsed.semester : "Semester 1", theme: parsed.theme || "teal" };
  let sems = parsed.semesters;
  if (!sems || typeof sems !== "object") {
    // migrate a flat save into its semester
    const flat = makeSemester();
    for (const k of Object.keys(flat)) if (Array.isArray(parsed[k])) flat[k] = parsed[k];
    sems = {};
    sems[out.semester] = flat;
  }
  out.semesters = {};
  for (const name of SEMESTER_NAMES) {
    const sem = { ...makeSemester(), ...(sems[name] || {}) };
    // Items saved before sync existed have no timestamp; give them one so
    // they take part in merging instead of being treated as ancient.
    for (const key of COLLECTIONS) {
      sem[key] = (sem[key] || []).map((it) =>
        it && it.updatedAt ? it : { ...it, updatedAt: nowISO() }
      );
    }
    out.semesters[name] = sem;
  }
  out.meta = { updatedAt: nowISO(), lastSyncedAt: null, ...(parsed.meta || {}) };
  return out;
}

/** Items the user should see — everything except deleted tombstones. */
const live = (list) => (list || []).filter((it) => !it.deletedAt);

const THEMES = {
  teal: { label: "Teal", accent: "#0f766e", accentDeep: "#115e59", accentSoft: "#ccfbf1", accentDeepText: "#115e59" },
  ocean: { label: "Ocean", accent: "#1d4ed8", accentDeep: "#1e40af", accentSoft: "#dbeafe", accentDeepText: "#1e40af" },
  forest: { label: "Forest", accent: "#047857", accentDeep: "#065f46", accentSoft: "#d1fae5", accentDeepText: "#065f46" },
  plum: { label: "Plum", accent: "#7c3aed", accentDeep: "#6d28d9", accentSoft: "#ede9fe", accentDeepText: "#5b21b6" },
  berry: { label: "Berry", accent: "#be123c", accentDeep: "#9f1239", accentSoft: "#ffe4e6", accentDeepText: "#9f1239" },
  sunset: { label: "Sunset", accent: "#c2410c", accentDeep: "#9a3412", accentSoft: "#ffedd5", accentDeepText: "#9a3412" },
  slate: { label: "Slate", accent: "#334155", accentDeep: "#1e293b", accentSoft: "#e2e8f0", accentDeepText: "#1e293b" },
  rose: { label: "Rose", accent: "#db2777", accentDeep: "#be185d", accentSoft: "#fce7f3", accentDeepText: "#be185d" },
};

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const pad = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (iso) => new Date(iso + "T00:00:00");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Australian date format: DD/MM/YYYY
function formatAU(iso) {
  if (!iso) return "";
  const p = iso.split("-");
  if (p.length !== 3) return iso;
  return `${p[2]}/${p[1]}/${p[0]}`;
}
function formatAULong(iso) {
  if (!iso) return "";
  const d = parseISO(iso);
  return `${WEEKDAYS_LONG[d.getDay()]} ${formatAU(iso)}`;
}
function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ap = h < 12 ? "am" : "pm";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${pad(m)} ${ap}`;
}

function dueMeta(iso) {
  if (!iso) return null;
  const due = parseISO(iso);
  if (isNaN(due)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((due - today) / 86400000);
  if (diff < 0) return { label: "Overdue", cls: "bg-rose-100 text-rose-800" };
  if (diff === 0) return { label: "Due today", cls: "bg-rose-100 text-rose-800" };
  if (diff <= 7) return { label: `In ${diff} day${diff === 1 ? "" : "s"}`, cls: "bg-amber-100 text-amber-800" };
  return { label: `In ${diff} days`, cls: "bg-stone-100 text-stone-600" };
}

const COURSE_TAGS = [
  "bg-teal-100 text-teal-800",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-800",
  "bg-sky-100 text-sky-800",
  "bg-violet-100 text-violet-800",
  "bg-lime-100 text-lime-800",
];
function courseTag(name) {
  if (!name) return "bg-stone-100 text-stone-600";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COURSE_TAGS[h % COURSE_TAGS.length];
}

const FOLDER_COLORS = {
  teal: { hex: "#0f766e", soft: "#ccfbf1", text: "#115e59" },
  blue: { hex: "#1d4ed8", soft: "#dbeafe", text: "#1e40af" },
  green: { hex: "#047857", soft: "#d1fae5", text: "#065f46" },
  amber: { hex: "#b45309", soft: "#fef3c7", text: "#92400e" },
  rose: { hex: "#be123c", soft: "#ffe4e6", text: "#9f1239" },
  violet: { hex: "#7c3aed", soft: "#ede9fe", text: "#5b21b6" },
  slate: { hex: "#334155", soft: "#e2e8f0", text: "#1e293b" },
  pink: { hex: "#db2777", soft: "#fce7f3", text: "#be185d" },
};
const FOLDER_COLOR_KEYS = Object.keys(FOLDER_COLORS);
const folderColor = (key) => FOLDER_COLORS[key] || FOLDER_COLORS.slate;

/* Shared class strings */
const inputCls =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder-stone-400 u-field";
const labelCls = "block text-xs font-medium text-stone-500 mb-1";
const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-lg u-accent-bg px-3.5 py-2 text-sm font-medium text-white u-focus disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
const btnGhost =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 u-focus transition-colors";
const iconBtn =
  "inline-flex items-center justify-center rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700 u-focus transition-colors";
const editBox = "rounded-xl border border-stone-300 bg-stone-50 p-3";

/* ------------------------------------------------------------------ */
/*  Shared bits                                                       */
/* ------------------------------------------------------------------ */

function Section({ icon: Icon, title, subtitle, children }) {
  return (
    <section className="mb-5">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg u-accent-soft u-accent-deeptext">
          <Icon size={17} />
        </span>
        <div>
          <h2 className="font-serif text-lg font-semibold leading-tight text-stone-800">{title}</h2>
          {subtitle && <p className="text-xs text-stone-500">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-2xl border border-stone-200 bg-white p-4 shadow-sm ${className}`}>{children}</div>
  );
}

function Empty({ children }) {
  return <p className="py-2 text-sm text-stone-400">{children}</p>;
}

function CourseChip({ name }) {
  if (!name) return null;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${courseTag(name)}`}>{name}</span>;
}

function CourseSelect({ value, onChange, courses, allowNone = true }) {
  return (
    <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">No course</option>}
      {courses.map((c) => (
        <option key={c.id} value={c.name}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

// Re-exported so aiNotes.jsx can match the app's existing look and id scheme
// instead of inventing its own.
export { inputCls, labelCls, btnPrimary, btnGhost, iconBtn, editBox, Section, Card, Empty, CourseChip, CourseSelect, uid };

/* ------------------------------------------------------------------ */
/*  Courses                                                           */
/* ------------------------------------------------------------------ */

function Courses({ courses, addItem, removeItem, focused, onToggleFocus }) {
  const [name, setName] = useState("");
  const add = () => {
    const n = name.trim();
    if (!n) return;
    addItem("courses", { id: uid(), name: n });
    setName("");
  };
  return (
    <Card>
      <div className="flex gap-2">
        <input
          className={inputCls}
          placeholder="Add a course, e.g. PSYC1001"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className={btnPrimary} onClick={add} disabled={!name.trim()}>
          <Plus size={16} /> Add
        </button>
      </div>
      {courses.length === 0 ? (
        <Empty>Add the units you're taking this semester to tag everything else.</Empty>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {courses.map((c) => {
              const isFocused = focused === c.name;
              return (
                <span
                  key={c.id}
                  className={`inline-flex items-center gap-1.5 rounded-full px-1 py-0.5 text-xs font-medium ${courseTag(c.name)} ${isFocused ? "u-highlight" : ""}`}
                >
                  <button onClick={() => onToggleFocus(c.name)} className="rounded-full px-1.5 py-0.5 u-focus" aria-pressed={isFocused} aria-label={`Highlight ${c.name}`}>
                    {c.name}
                  </button>
                  <button className="rounded-full p-0.5 hover:bg-black/10" onClick={() => removeItem("courses", c.id)} aria-label={`Remove ${c.name}`}>
                    <X size={12} />
                  </button>
                </span>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-stone-400">
            {focused ? `Highlighting "${focused}" across the app. Tap it again to clear.` : "Tap a course to highlight everything linked to it across the other tabs."}
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  To-do                                                             */
/* ------------------------------------------------------------------ */

function Todos({ todos, addItem, patchItem, removeItem, assignments = [] }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (!t) return;
    addItem("todos", { id: uid(), text: t, done: false });
    setText("");
  };
  const remaining = todos.filter((t) => !t.done).length;
  return (
    <Card>
      <div className="flex gap-2">
        <input
          className={inputCls}
          placeholder="Add a task..."
          spellCheck
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className={btnPrimary} onClick={add} disabled={!text.trim()}>
          <Plus size={16} /> Add
        </button>
      </div>
      {todos.length === 0 ? (
        <Empty>Nothing on the list yet.</Empty>
      ) : (
        <>
          <ul className="mt-3 space-y-1.5">
            {todos.map((t) => (
              <li key={t.id} className="flex items-center gap-2.5">
                <button
                  onClick={() =>
                    patchItem("todos", t.id, {
                      done: !t.done,
                      // Ticking a generated step counts as touching it, so
                      // regenerating can never resurrect it as unfinished.
                      ...(t.gen ? { edited: true } : {}),
                    })
                  }
                  className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border ${
                    t.done ? "u-accent-bg u-accent-border text-white" : "border-stone-300 bg-white u-hover-border"
                  }`}
                  aria-label={t.done ? "Mark not done" : "Mark done"}
                >
                  {t.done && <Check size={13} />}
                </button>
                <span className={`flex-1 text-sm ${t.done ? "text-stone-400 line-through" : "text-stone-800"}`}>
                  {t.text}
                  {/* Sub-tasks live in this list rather than a parallel one,
                      so they need to say what they belong to and when. */}
                  {t.due && (
                    <span className="ml-1.5 text-xs text-stone-400">
                      {t.due < localDay() && !t.done ? "overdue · " : ""}
                      {formatAU(t.due)}
                    </span>
                  )}
                  {t.parentId && (
                    <span className="ml-1.5 text-xs text-stone-400">
                      {(assignments.find((a) => a.id === t.parentId) || {}).title || "assignment"}
                    </span>
                  )}
                </span>
                <button className={iconBtn} onClick={() => removeItem("todos", t.id)}>
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-stone-400">{remaining} left to do</p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Textbook planner                                                  */
/* ------------------------------------------------------------------ */

/* Three states, cycled by one tap: untouched -> started -> done.

   Drawn with CSS rather than three icons so the states differ by shape
   as well as colour -- an empty ring, a half ring, a filled tick -- and
   stay legible to someone who can't tell the accent colour from grey. */
function ReadTick({ state, onCycle, label }) {
  const done = state === "done";
  const part = state === "part";
  return (
    <button
      onClick={onCycle}
      aria-label={label}
      aria-pressed={done}
      title={done ? "Read" : part ? "Started" : "Not started"}
      className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 u-focus transition-colors ${
        done ? "u-accent-bg border-transparent text-white" : part ? "u-accent-border" : "border-stone-300 hover:border-stone-400"
      }`}
    >
      {done && <Check size={13} strokeWidth={3} />}
      {part && <span className="h-2 w-2 rounded-full u-accent-bg" />}
    </button>
  );
}

function Textbook({ textbook, courses, addItem, patchItem, removeItem, focused }) {
  const [form, setForm] = useState({ course: "", week: "", pages: "", notes: "" });
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({});

  const add = () => {
    addItem("textbook", { id: uid(), ...form });
    setForm({ course: form.course, week: "", pages: "", notes: "" });
  };

  const groups = useMemo(() => {
    const map = new Map();
    for (const e of textbook) {
      const key = e.course || "__none";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const wa = parseInt(a.week, 10);
        const wb = parseInt(b.week, 10);
        if (isNaN(wa) && isNaN(wb)) return 0;
        if (isNaN(wa)) return 1;
        if (isNaN(wb)) return -1;
        return wa - wb;
      });
    }
    return Array.from(map.entries());
  }, [textbook]);

  return (
    <Card>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="col-span-2 sm:col-span-1">
          <label className={labelCls}>Course</label>
          <CourseSelect value={form.course} onChange={(v) => setForm((f) => ({ ...f, course: v }))} courses={courses} />
        </div>
        <div>
          <label className={labelCls}>Week</label>
          <input type="number" min="1" className={inputCls} placeholder="e.g. 3" value={form.week} onChange={(e) => setForm((f) => ({ ...f, week: e.target.value }))} />
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Textbook pages</label>
          <input className={inputCls} placeholder="e.g. pp. 40-58" value={form.pages} onChange={(e) => setForm((f) => ({ ...f, pages: e.target.value }))} />
        </div>
        <div className="col-span-2 sm:col-span-4">
          <label className={labelCls}>Notes (optional)</label>
          <textarea className={inputCls} rows={2} spellCheck placeholder="Anything to remember for this reading..." value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <button className={btnPrimary} onClick={add}>
          <Plus size={16} /> Add week
        </button>
      </div>

      {textbook.length === 0 ? (
        <Empty>No reading planned yet. Every field is optional, so add a week whenever you like.</Empty>
      ) : (
        <div className="mt-4 space-y-4">
          {groups.map(([key, entries]) => (
            <div key={key}>
              <div className="mb-2 flex items-center gap-2">
                {key === "__none" ? (
                  <span className="text-xs font-semibold uppercase tracking-wide text-stone-400">Unassigned</span>
                ) : (
                  <CourseChip name={key} />
                )}
                <span className="text-xs text-stone-400">
                  {entries.length} week{entries.length === 1 ? "" : "s"}
                </span>
                {(() => {
                  const p = readingProgress(entries);
                  return p.done > 0 ? (
                    <span className="text-xs font-medium u-accent-text">{p.done} of {p.total} done</span>
                  ) : null;
                })()}
              </div>
              <ul className="space-y-2">
                {entries.map((e) =>
                  editingId === e.id ? (
                    <li key={e.id} className={editBox}>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <div className="col-span-2 sm:col-span-1">
                          <label className={labelCls}>Course</label>
                          <CourseSelect value={edit.course || ""} onChange={(v) => setEdit((x) => ({ ...x, course: v }))} courses={courses} />
                        </div>
                        <div>
                          <label className={labelCls}>Week</label>
                          <input type="number" className={inputCls} value={edit.week || ""} onChange={(e2) => setEdit((x) => ({ ...x, week: e2.target.value }))} />
                        </div>
                        <div className="col-span-2">
                          <label className={labelCls}>Pages</label>
                          <input className={inputCls} value={edit.pages || ""} onChange={(e2) => setEdit((x) => ({ ...x, pages: e2.target.value }))} />
                        </div>
                        <div className="col-span-2 sm:col-span-4">
                          <label className={labelCls}>Notes</label>
                          <textarea className={inputCls} rows={2} spellCheck value={edit.notes || ""} onChange={(e2) => setEdit((x) => ({ ...x, notes: e2.target.value }))} />
                        </div>
                      </div>
                      <div className="mt-2 flex justify-end gap-2">
                        <button className={btnGhost} onClick={() => setEditingId(null)}>
                          <X size={15} /> Cancel
                        </button>
                        <button className={btnPrimary} onClick={() => { patchItem("textbook", e.id, edit); setEditingId(null); }}>
                          <Check size={15} /> Save
                        </button>
                      </div>
                    </li>
                  ) : (
                    <li key={e.id} className={`flex items-start gap-3 rounded-xl border border-stone-200 p-3 ${focused && e.course === focused ? "u-highlight" : ""}`}>
                      <ReadTick
                        state={e.read || ""}
                        label={`Mark ${e.pages || `week ${e.week || "?"}`} as read`}
                        onCycle={() => {
                          const next = nextReadState(e.read);
                          // readAt is only meaningful once something is
                          // finished, and is cleared when it is un-ticked
                          // rather than left pointing at a stale date.
                          patchItem("textbook", e.id, next === "done" ? { read: next, readAt: localDay() } : { read: next || null, readAt: null });
                        }}
                      />
                      <span className="mt-0.5 flex-shrink-0 rounded-md bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-600">{e.week ? `Wk ${e.week}` : "—"}</span>
                      <div className="min-w-0 flex-1">
                        {e.pages ? <p className={`text-sm font-medium ${isRead(e) ? "text-stone-400 line-through" : "text-stone-800"}`}>{e.pages}</p> : <p className="text-sm text-stone-400">No pages set</p>}
                        {e.notes && <p className="mt-0.5 whitespace-pre-wrap text-sm text-stone-500">{e.notes}</p>}
                      </div>
                      <div className="flex flex-shrink-0 gap-0.5">
                        <button className={iconBtn} onClick={() => { setEditingId(e.id); setEdit({ ...e }); }}>
                          <Pencil size={15} />
                        </button>
                        <button className={iconBtn} onClick={() => removeItem("textbook", e.id)}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </li>
                  )
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Assignments                                                       */
/* ------------------------------------------------------------------ */

function AssignmentFields({ state, set, courses }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="col-span-2 sm:col-span-1">
        <label className={labelCls}>Course</label>
        <CourseSelect value={state.course || ""} onChange={(v) => set((x) => ({ ...x, course: v }))} courses={courses} />
      </div>
      <div className="col-span-2 sm:col-span-1">
        <label className={labelCls}>Due date</label>
        <input type="date" className={inputCls} value={state.due || ""} onChange={(e) => set((x) => ({ ...x, due: e.target.value }))} />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Title</label>
        <input className={inputCls} spellCheck placeholder="e.g. Research essay" value={state.title || ""} onChange={(e) => set((x) => ({ ...x, title: e.target.value }))} />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Requirements / details</label>
        <textarea className={inputCls} rows={2} spellCheck placeholder="Word count, format, marking criteria..." value={state.requirements || ""} onChange={(e) => set((x) => ({ ...x, requirements: e.target.value }))} />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Extra notes</label>
        <textarea className={inputCls} rows={2} spellCheck placeholder="Anything else..." value={state.notes || ""} onChange={(e) => set((x) => ({ ...x, notes: e.target.value }))} />
      </div>
    </div>
  );
}

/* The rubric checklist.

   Deliberately NOT using maxLength on any field. In most browsers that
   silently cuts a paste, so a student pasting criteria out of a unit
   outline would lose the end and never be told. Instead the text is
   accepted whole, the counter turns red, and Save is blocked with the
   overage named. See src/reference.js. */
function CriterionRow({ c, onChange, onRemove }) {
  const label = checkLength(c.label, RUBRIC_LABEL_MAX, "This");
  const note = checkLength(c.note, RUBRIC_NOTE_MAX, "This note");
  return (
    <li className="rounded-lg border border-stone-200 p-2.5">
      <div className="flex items-start gap-2">
        <button
          onClick={() => onChange({ ...c, done: !c.done })}
          aria-label={c.done ? "Mark as not done" : "Mark as done"}
          aria-pressed={!!c.done}
          className={`mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border-2 u-focus ${
            c.done ? "u-accent-bg border-transparent text-white" : "border-stone-300 hover:border-stone-400"
          }`}
        >
          {c.done && <Check size={12} strokeWidth={3} />}
        </button>
        <div className="min-w-0 flex-1">
          <textarea
            rows={2}
            className={inputCls}
            spellCheck
            placeholder="What the marker is looking for"
            value={c.label || ""}
            onChange={(e) => onChange({ ...c, label: e.target.value })}
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <input
              className={`${inputCls} text-xs`}
              spellCheck
              placeholder="Your note (optional)"
              value={c.note || ""}
              onChange={(e) => onChange({ ...c, note: e.target.value })}
            />
            <button className={iconBtn} onClick={onRemove} aria-label="Remove criterion">
              <Trash2 size={14} />
            </button>
          </div>
          {(!label.ok || !note.ok) && (
            <p className="mt-1 text-xs font-medium text-rose-600">{!label.ok ? label.message : note.message}</p>
          )}
        </div>
      </div>
    </li>
  );
}

function RubricPanel({ assignment, assignments, patchItem }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState("");

  const live = (draft || assignment.rubric || []).filter((c) => c && !c.deletedAt);
  const progress = rubricProgress(assignment.rubric);
  const check = validateRubric(live);
  const room = canAddRubric(assignments.filter((x) => x.id !== assignment.id));

  const start = () => {
    setDraft(assignment.rubric && assignment.rubric.length ? [...assignment.rubric] : [emptyCriterion(uid)]);
    setOpen(true);
  };
  const save = () => {
    patchItem("assignments", assignment.id, { rubric: live });
    setDraft(null);
    setOpen(false);
  };
  const applyPaste = () => {
    const r = splitPastedRubric(pasted, uid);
    if (!r.ok) return setPasteError(r.message);
    setDraft([...(draft || []).filter((c) => (c.label || "").trim()), ...r.criteria]);
    setPasted("");
    setPasteError("");
    setPasting(false);
  };

  if (!open) {
    return (
      <button
        className="mt-2 text-xs font-medium text-stone-500 hover:u-accent-text"
        onClick={start}
        disabled={!hasRubric(assignment) && !room.ok}
        title={!hasRubric(assignment) && !room.ok ? room.message : undefined}
      >
        {hasRubric(assignment) ? `Rubric · ${progress.done} of ${progress.total}` : "Add rubric"}
      </button>
    );
  }

  return (
    <div className={`${editBox} mt-2`}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-stone-700">Rubric</p>
        <p className="text-xs text-stone-400">{live.length} of {RUBRIC_CRITERIA_MAX}</p>
      </div>

      {live.length > 0 && (
        <ul className="mt-2 space-y-2">
          {live.map((c) => (
            <CriterionRow
              key={c.id}
              c={c}
              onChange={(next) => setDraft(live.map((x) => (x.id === c.id ? next : x)))}
              onRemove={() => setDraft(live.filter((x) => x.id !== c.id))}
            />
          ))}
        </ul>
      )}

      {pasting ? (
        <div className="mt-2">
          <label className={labelCls}>Paste your rubric, one criterion per line</label>
          <textarea rows={5} className={inputCls} value={pasted} onChange={(e) => setPasted(e.target.value)} />
          {pasteError && <p className="mt-1 text-xs font-medium text-rose-600">{pasteError}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => { setPasting(false); setPasteError(""); }}>Cancel</button>
            <button className={btnPrimary} onClick={applyPaste}>Split into criteria</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button className={btnGhost} onClick={() => setDraft([...live, emptyCriterion(uid)])} disabled={live.length >= RUBRIC_CRITERIA_MAX}>
            <Plus size={14} /> Add criterion
          </button>
          <button className={btnGhost} onClick={() => setPasting(true)}>Paste a rubric</button>
        </div>
      )}

      {!check.ok && (
        <ul className="mt-2 space-y-0.5">
          {check.problems.map((p, i) => (
            <li key={i} className="text-xs font-medium text-rose-600">{p}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button className={btnGhost} onClick={() => { setDraft(null); setOpen(false); }}>
          <X size={15} /> Cancel
        </button>
        <button className={btnPrimary} onClick={save} disabled={!check.ok}>
          <Check size={15} /> Save rubric
        </button>
      </div>
    </div>
  );
}

function Assignments({ assignments, courses, addItem, patchItem, removeItem, focused, todos = [], onBreakdown }) {
  const blank = { course: "", title: "", due: "", requirements: "", notes: "" };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({});

  const add = () => {
    addItem("assignments", { id: uid(), ...form });
    setForm(blank);
  };

  const sorted = useMemo(
    () =>
      [...assignments].sort((a, b) => {
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due.localeCompare(b.due);
      }),
    [assignments]
  );

  return (
    <Card>
      <AssignmentFields state={form} set={setForm} courses={courses} />
      <div className="mt-2 flex justify-end">
        <button className={btnPrimary} onClick={add}>
          <Plus size={16} /> Add assignment
        </button>
      </div>

      {assignments.length === 0 ? (
        <Empty>No assignments yet. All fields are optional, so add one and fill it in later.</Empty>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {sorted.map((a) => {
            const meta = dueMeta(a.due);
            if (editingId === a.id) {
              return (
                <li key={a.id} className={editBox}>
                  <AssignmentFields state={edit} set={setEdit} courses={courses} />
                  <div className="mt-2 flex justify-end gap-2">
                    <button className={btnGhost} onClick={() => setEditingId(null)}>
                      <X size={15} /> Cancel
                    </button>
                    <button className={btnPrimary} onClick={() => { patchItem("assignments", a.id, edit); setEditingId(null); }}>
                      <Check size={15} /> Save changes
                    </button>
                  </div>
                </li>
              );
            }
            return (
              <li key={a.id} className={`rounded-xl border border-stone-200 p-3.5 ${focused && a.course === focused ? "u-highlight" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CourseChip name={a.course} />
                      <h3 className="font-medium text-stone-800">{a.title || <span className="text-stone-400">Untitled assignment</span>}</h3>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-stone-500">
                      {a.due ? <span>Due {formatAU(a.due)}</span> : <span className="text-stone-400">No due date</span>}
                      {meta && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{meta.label}</span>}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 gap-0.5">
                    <button className={iconBtn} onClick={() => { setEditingId(a.id); setEdit({ ...a }); }}>
                      <Pencil size={15} />
                    </button>
                    <button className={iconBtn} onClick={() => removeItem("assignments", a.id)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                {a.requirements && <p className="mt-2 whitespace-pre-wrap text-sm text-stone-600">{a.requirements}</p>}
                {a.notes && <p className="mt-1.5 whitespace-pre-wrap text-sm text-stone-400">{a.notes}</p>}
                <RubricPanel assignment={a} assignments={assignments} patchItem={patchItem} />
                {onBreakdown && (
                  <BreakdownPanel assignment={a} todos={todos} onBreakdown={onBreakdown} patchItem={patchItem} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Calendar                                                          */
/* ------------------------------------------------------------------ */

function EventFields({ state, set, courses }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="col-span-2">
        <label className={labelCls}>Title</label>
        <input className={inputCls} spellCheck placeholder="e.g. Statistics lecture" value={state.title || ""} onChange={(e) => set((x) => ({ ...x, title: e.target.value }))} />
      </div>
      <div className="col-span-2 sm:col-span-1">
        <label className={labelCls}>Course</label>
        <CourseSelect value={state.course || ""} onChange={(v) => set((x) => ({ ...x, course: v }))} courses={courses} />
      </div>
      <div className="col-span-2 sm:col-span-1">
        <label className={labelCls}>Date</label>
        <input type="date" className={inputCls} value={state.date || ""} onChange={(e) => set((x) => ({ ...x, date: e.target.value }))} />
      </div>
      <div>
        <label className={labelCls}>Start time</label>
        <input type="time" className={inputCls} value={state.start || ""} onChange={(e) => set((x) => ({ ...x, start: e.target.value }))} />
      </div>
      <div>
        <label className={labelCls}>End time</label>
        <input type="time" className={inputCls} value={state.end || ""} onChange={(e) => set((x) => ({ ...x, end: e.target.value }))} />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Location / room</label>
        <input className={inputCls} spellCheck placeholder="e.g. Building 8, Room 204" value={state.location || ""} onChange={(e) => set((x) => ({ ...x, location: e.target.value }))} />
      </div>
      <label className="col-span-2 flex items-center gap-2 text-sm text-stone-700">
        <input type="checkbox" className="h-4 w-4 u-accent-text" checked={state.repeat === "weekly"} onChange={(e) => set((x) => ({ ...x, repeat: e.target.checked ? "weekly" : "none" }))} />
        Repeats weekly (for recurring class times)
      </label>
    </div>
  );
}

function Calendar({ events, courses, addItem, patchItem, removeItem, focused }) {
  const today = new Date();
  const [viewY, setViewY] = useState(today.getFullYear());
  const [viewM, setViewM] = useState(today.getMonth());
  const [selected, setSelected] = useState(toISO(today));
  const [showForm, setShowForm] = useState(false);
  const blank = { title: "", course: "", date: toISO(today), start: "", end: "", location: "", repeat: "none" };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({});

  const eventsForDay = (iso) => {
    const d = parseISO(iso);
    const wd = d.getDay();
    return events
      .filter((e) => {
        if (!e.date) return false;
        if (e.repeat === "weekly") return parseISO(e.date).getDay() === wd && iso >= e.date;
        return e.date === iso;
      })
      .sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  };

  const firstOffset = (new Date(viewY, viewM, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstOffset; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(toISO(new Date(viewY, viewM, day)));

  const move = (delta) => {
    let m = viewM + delta;
    let y = viewY;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    setViewM(m);
    setViewY(y);
  };

  const todayISO = toISO(today);
  const dayEvents = eventsForDay(selected);

  const openAdd = () => {
    setForm({ ...blank, date: selected });
    setEditingId(null);
    setShowForm(true);
  };

  return (
    <Card>
      {/* Month controls */}
      <div className="mb-3 flex items-center justify-between">
        <button className={iconBtn} onClick={() => move(-1)} aria-label="Previous month">
          <ChevronLeft size={18} />
        </button>
        <h3 className="font-serif text-base font-semibold text-stone-800">
          {MONTHS[viewM]} {viewY}
        </h3>
        <button className={iconBtn} onClick={() => move(1)} aria-label="Next month">
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-stone-400">
        {WEEKDAYS_SHORT.map((w) => (
          <div key={w} className="py-1">{w}</div>
        ))}
      </div>

      {/* Day grid */}
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((iso, i) => {
          if (!iso) return <div key={`e${i}`} />;
          const evs = eventsForDay(iso);
          const isSel = iso === selected;
          const isToday = iso === todayISO;
          let cls = "text-stone-700 hover:bg-stone-100";
          if (isSel) cls = "u-accent-bg text-white";
          else if (isToday) cls = "u-accent-soft u-accent-deeptext";
          return (
            <button key={iso} onClick={() => setSelected(iso)} className={`flex h-11 flex-col items-center justify-center rounded-lg text-sm u-focus ${cls}`}>
              <span>{parseInt(iso.slice(-2), 10)}</span>
              {evs.length > 0 && (
                <span className="mt-0.5 flex gap-0.5">
                  {evs.slice(0, 3).map((_, k) => (
                    <span key={k} className={`h-1 w-1 rounded-full ${isSel ? "bg-white" : "u-accent-bg"}`} />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Selected day */}
      <div className="mt-4 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-stone-700">{formatAULong(selected)}</h4>
        <button className={btnPrimary} onClick={openAdd}>
          <Plus size={15} /> Add
        </button>
      </div>

      {showForm && (
        <div className={`mt-3 ${editBox}`}>
          <EventFields state={form} set={setForm} courses={courses} />
          <div className="mt-2 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setShowForm(false)}>
              <X size={15} /> Cancel
            </button>
            <button className={btnPrimary} onClick={() => { addItem("events", { id: uid(), ...form }); setShowForm(false); }}>
              <Check size={15} /> Add to calendar
            </button>
          </div>
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {dayEvents.length === 0 && !showForm && <Empty>No classes or events on this day.</Empty>}
        {dayEvents.map((e) =>
          editingId === e.id ? (
            <li key={e.id} className={editBox}>
              <EventFields state={edit} set={setEdit} courses={courses} />
              <div className="mt-2 flex justify-end gap-2">
                <button className={btnGhost} onClick={() => setEditingId(null)}>
                  <X size={15} /> Cancel
                </button>
                <button className={btnPrimary} onClick={() => { patchItem("events", e.id, edit); setEditingId(null); }}>
                  <Check size={15} /> Save
                </button>
              </div>
            </li>
          ) : (
            <li key={e.id} className={`flex items-start gap-3 rounded-xl border border-stone-200 p-3 ${focused && e.course === focused ? "u-highlight" : ""}`}>
              <div className="flex w-16 flex-shrink-0 flex-col items-center rounded-lg u-accent-soft u-accent-deeptext py-1.5 text-xs font-semibold">
                {e.start ? <span>{formatTime(e.start)}</span> : <Clock size={15} />}
                {e.end && <span className="font-normal opacity-70">{formatTime(e.end)}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h5 className="font-medium text-stone-800">{e.title || "Class"}</h5>
                  <CourseChip name={e.course} />
                  {e.repeat === "weekly" && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">
                      <Repeat size={11} /> Weekly
                    </span>
                  )}
                </div>
                {e.location && (
                  <p className="mt-0.5 flex items-center gap-1 text-sm text-stone-500">
                    <MapPin size={13} /> {e.location}
                  </p>
                )}
              </div>
              <div className="flex flex-shrink-0 gap-0.5">
                <button className={iconBtn} onClick={() => { setEditingId(e.id); setEdit({ ...e }); setShowForm(false); }}>
                  <Pencil size={15} />
                </button>
                <button className={iconBtn} onClick={() => removeItem("events", e.id)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </li>
          )
        )}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Notes (typed pages with formatting, or handwritten pages)         */
/* ------------------------------------------------------------------ */

/* ---- Formatting options ---- */

const NOTE_FONTS = [
  { id: "sans", label: "Default", css: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: "times", label: "Times New Roman", css: '"Times New Roman", Times, serif' },
  { id: "comfortaa", label: "Comfortaa", css: '"Comfortaa", ui-rounded, sans-serif' },
];

const TEXT_COLORS = [
  { id: "black", label: "Black", hex: "#1c1917" },
  { id: "blue", label: "Blue", hex: "#1d4ed8" },
  { id: "red", label: "Red", hex: "#dc2626" },
];

const HIGHLIGHTERS = [
  { id: "pink", label: "Pink", hex: "#fbcfe8" },
  { id: "blue", label: "Blue", hex: "#bfdbfe" },
  { id: "purple", label: "Purple", hex: "#e9d5ff" },
  { id: "yellow", label: "Yellow", hex: "#fef08a" },
];

/* ---- Keeping saved HTML safe ----
   Notes are stored as HTML so formatting survives. Anything loaded back
   is rebuilt from an allow-list of tags and styles, so a note can never
   carry scripts or anything else executable. */

const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "SPAN", "DIV", "P", "BR", "UL", "OL", "LI"]);
const ALLOWED_STYLES = ["color", "background-color", "font-family", "font-weight", "font-style", "text-decoration"];

function sanitizeHtml(dirty) {
  if (!dirty) return "";
  try {
    const doc = new DOMParser().parseFromString(`<div>${dirty}</div>`, "text/html");
    const root = doc.body.firstChild;

    const clean = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) continue; // plain text is fine
        if (child.nodeType !== 1) {
          child.remove();
          continue;
        }
        if (!ALLOWED_TAGS.has(child.tagName)) {
          // keep the words, drop the tag
          const text = doc.createTextNode(child.textContent || "");
          child.replaceWith(text);
          continue;
        }
        const keep = [];
        for (const prop of ALLOWED_STYLES) {
          const val = child.style.getPropertyValue(prop);
          if (val && !/expression|javascript:|url\s*\(/i.test(val)) keep.push(`${prop}: ${val}`);
        }
        for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name);
        if (keep.length) child.setAttribute("style", keep.join("; "));
        clean(child);
      }
    };

    clean(root);
    return root.innerHTML;
  } catch (e) {
    return "";
  }
}

/** Plain text version, used for list previews and the study cards. */
function htmlToText(html) {
  if (!html) return "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.textContent || "").replace(/\u200B/g, "").trim();
  } catch (e) {
    return "";
  }
}

/* ---- Choosing what kind of note to make ---- */

function PageTypeChooser({ onCreate, onCancel, sheetsFull = false }) {
  const [style, setStyle] = useState("lined");
  const [kind, setKind] = useState("text");

  const Option = ({ active, onClick, preview, label, hint }) => (
    <button
      onClick={onClick}
      className={`rounded-xl border p-3 text-left u-focus ${active ? "u-accent-border u-accent-soft" : "border-stone-300 u-hover-border"}`}
    >
      {preview}
      <span className="block text-sm font-medium text-stone-800">{label}</span>
      {hint && <span className="block text-xs text-stone-500">{hint}</span>}
    </button>
  );

  return (
    <div>
      <p className={labelCls}>Page style</p>
      <div className="grid grid-cols-2 gap-3">
        <Option
          active={style === "lined"}
          onClick={() => setStyle("lined")}
          preview={<div className="mb-2 h-16 rounded-md border border-stone-200 lined-paper" />}
          label="Lined page"
        />
        <Option
          active={style === "blank"}
          onClick={() => setStyle("blank")}
          preview={<div className="mb-2 h-16 rounded-md border border-stone-200 bg-white" />}
          label="Blank page"
        />
      </div>

      <p className={`${labelCls} mt-4`}>Note type</p>
      <div className="grid grid-cols-2 gap-3">
        <Option
          active={kind === "text"}
          onClick={() => setKind("text")}
          preview={
            <div className="mb-2 flex h-16 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-400">
              <Type size={22} />
            </div>
          }
          label="Typed"
          hint="Fonts, colours, highlighters"
        />
        <Option
          active={kind === "drawing"}
          onClick={() => setKind("drawing")}
          preview={
            <div className="mb-2 flex h-16 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-400">
              <PenLine size={22} />
            </div>
          }
          label="Handwritten"
          hint="Draw with a stylus or finger"
        />
        {!sheetsFull && <Option
          active={kind === FORMULA_KIND}
          onClick={() => setKind(FORMULA_KIND)}
          preview={
            <div className="mb-2 flex h-16 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-400">
              <ListTodo size={22} />
            </div>
          }
          label="Reference sheet"
          hint="Formulas and definitions to look up"
        />}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onCancel}>
          <X size={15} /> Cancel
        </button>
        <button className={btnPrimary} onClick={() => onCreate({ style, kind })}>
          <Check size={15} /> Create note
        </button>
      </div>
    </div>
  );
}

/* ---- Typed notes: fonts, text colour, highlighters ---- */

function RichTextEditor({ draft, setDraft }) {
  const ref = useRef(null);
  const [hint, setHint] = useState("");

  // Load the saved note in once; after that the div owns its own content
  // (rewriting it on every keystroke would move the cursor to the start).
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (draft.html || "")) {
      ref.current.innerHTML = sanitizeHtml(draft.html || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  const save = () => {
    if (!ref.current) return;
    const html = sanitizeHtml(ref.current.innerHTML);
    setDraft((d) => ({ ...d, html, body: htmlToText(html) }));
  };

  /* Toolbar buttons must not steal focus, or the text selection is lost
     before the formatting can be applied - hence preventDefault on mousedown. */
  const hold = (e) => e.preventDefault();

  /** Is any text actually selected inside this editor? */
  const hasSelection = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    return ref.current && ref.current.contains(sel.anchorNode);
  };

  /* After highlighting, the cursor is left sitting inside the coloured span,
     so anything typed next would come out highlighted too. This drops the
     cursor just outside that span so typing continues clean. */
  const stepOutOfHighlight = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !ref.current) return;

    let node = sel.getRangeAt(0).endContainer;
    let span = null;
    while (node && node !== ref.current) {
      if (
        node.nodeType === 1 &&
        node.style &&
        node.style.backgroundColor &&
        node.style.backgroundColor !== "transparent"
      ) {
        span = node;
      }
      node = node.parentNode;
    }
    if (!span || !span.parentNode) return;

    // An invisible character placed after the span gives the cursor
    // somewhere to sit that isn't inside the highlight.
    const escapeHatch = document.createTextNode("\u200B");
    span.parentNode.insertBefore(escapeHatch, span.nextSibling);
    const range = document.createRange();
    range.setStart(escapeHatch, 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const run = (command, value) => {
    if (!ref.current) return;
    ref.current.focus();
    try {
      document.execCommand("styleWithCSS", false, true);
      if (command === "highlight") {
        // Safari historically only understands backColor
        if (!document.execCommand("hiliteColor", false, value)) {
          document.execCommand("backColor", false, value);
        }
        stepOutOfHighlight();
      } else {
        document.execCommand(command, false, value);
      }
    } catch (e) {
      /* formatting unavailable - typing still works */
    }
    save();
  };

  /* Highlighters only ever colour text you've selected. Without this they
     "arm" themselves and highlight whatever you type next, which isn't what
     a highlighter should do. */
  const highlight = (hex) => {
    if (!hasSelection()) {
      setHint("Select some words first, then tap a highlighter.");
      return;
    }
    setHint("");
    run("highlight", hex);
  };

  /* Clearing works on a selection if there is one, and always frees the
     cursor from any highlight it's sitting in. */
  const clearHighlight = () => {
    if (hasSelection()) {
      run("highlight", "transparent");
    } else {
      ref.current.focus();
      stepOutOfHighlight();
      save();
    }
    setHint("");
  };

  const ToolButton = ({ onClick, title, children, active }) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={hold}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-md u-focus ${
        active ? "u-accent-soft u-accent-deeptext" : "text-stone-600 hover:bg-stone-100"
      }`}
    >
      {children}
    </button>
  );

  const fontCss = (NOTE_FONTS.find((f) => f.id === (draft.font || "sans")) || NOTE_FONTS[0]).css;

  return (
    <div>
      {/* Toolbar */}
      <div className="rounded-t-lg border border-b-0 border-stone-300 bg-stone-50 p-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Font — applies to the whole note, and is saved with it */}
          <select
            className="rounded-md border border-stone-300 bg-white px-2 py-1 text-sm text-stone-700 u-field"
            value={draft.font || "sans"}
            onChange={(e) => setDraft((d) => ({ ...d, font: e.target.value }))}
            style={{ fontFamily: fontCss }}
            aria-label="Font"
          >
            {NOTE_FONTS.map((f) => (
              <option key={f.id} value={f.id} style={{ fontFamily: f.css }}>
                {f.label}
              </option>
            ))}
          </select>

          <span className="h-5 w-px bg-stone-300" />

          <ToolButton title="Bold" onClick={() => run("bold")}>
            <Bold size={15} />
          </ToolButton>
          <ToolButton title="Italic" onClick={() => run("italic")}>
            <Italic size={15} />
          </ToolButton>
          <ToolButton title="Underline" onClick={() => run("underline")}>
            <Underline size={15} />
          </ToolButton>

          <span className="h-5 w-px bg-stone-300" />

          {/* Text colour */}
          <span className="flex items-center gap-1">
            <Baseline size={15} className="text-stone-500" />
            {TEXT_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                title={`${c.label} text`}
                aria-label={`${c.label} text`}
                onMouseDown={hold}
                onClick={() => run("foreColor", c.hex)}
                className="h-6 w-6 rounded-full border border-stone-300 u-focus"
                style={{ backgroundColor: c.hex }}
              />
            ))}
          </span>

          <span className="h-5 w-px bg-stone-300" />

          {/* Highlighters */}
          <span className="flex items-center gap-1">
            <Highlighter size={15} className="text-stone-500" />
            {HIGHLIGHTERS.map((h) => (
              <button
                key={h.id}
                type="button"
                title={`${h.label} highlighter`}
                aria-label={`${h.label} highlighter`}
                onMouseDown={hold}
                onClick={() => highlight(h.hex)}
                className="h-6 w-6 rounded-full border border-stone-300 u-focus"
                style={{ backgroundColor: h.hex }}
              />
            ))}
            <ToolButton title="Remove highlight" onClick={clearHighlight}>
              <Droplet size={15} />
            </ToolButton>
          </span>
        </div>
      </div>

      {/* Writing area */}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={save}
        onBlur={save}
        data-placeholder="Start writing..."
        className={`min-h-[220px] w-full rounded-b-lg border border-stone-300 px-3 py-2 text-sm text-stone-800 u-field ${
          draft.style === "lined" ? "lined-paper" : "bg-white"
        }`}
        style={{ fontFamily: fontCss, outline: "none" }}
      />
      <p className={`mt-1 text-xs ${hint ? "u-accent-text" : "text-stone-400"}`}>
        {hint || "Select some words first, then tap a highlighter."}
      </p>
    </div>
  );
}

/* ---- Handwritten notes ----
   Works with Apple Pencil, other styluses, a finger, or a mouse.
   Strokes are stored as points rather than as a picture, so notes stay
   small, stay sharp at any zoom, and sync quickly. */

const CANVAS_W = 1000;
const CANVAS_H = 1400;

const PEN_PRESETS = ["#1c1917", "#1d4ed8", "#dc2626", "#db2777", "#7c3aed", "#f59e0b", "#059669"];

function DrawingCanvas({ draft, setDraft }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const drawing = useRef(false);
  const currentStroke = useRef(null);
  const penSeen = useRef(false);

  const [hue, setHue] = useState(220);
  const [light, setLight] = useState(35);
  const [color, setColor] = useState("#1c1917");
  const [width, setWidth] = useState(3);
  const [erasing, setErasing] = useState(false);

  const strokes = draft.strokes || [];

  /* ---- drawing ---- */

  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    for (const s of strokes) drawStroke(ctx, s);
    if (currentStroke.current) drawStroke(ctx, currentStroke.current);
  };

  useEffect(redraw, [strokes, draft.id]);

  // Keep the drawing crisp on high-resolution screens
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = CANVAS_W * ratio;
    canvas.height = CANVAS_H * ratio;
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- pointer handling ---- */

  const toCanvas = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    ];
  };

  const pressureOf = (e) => {
    // Mice report 0.5 when pressed; a stylus reports real pressure.
    if (e.pointerType === "pen" && e.pressure > 0) return e.pressure;
    if (e.pressure > 0 && e.pressure !== 0.5) return e.pressure;
    return 0.5;
  };

  const onPointerDown = (e) => {
    if (e.pointerType === "pen") penSeen.current = true;
    // Once a stylus has been used, ignore fingers so a resting palm
    // doesn't scribble on the page.
    if (penSeen.current && e.pointerType === "touch") return;

    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {
      /* not supported - drawing still works */
    }
    drawing.current = true;
    const [x, y] = toCanvas(e);
    currentStroke.current = {
      color,
      width: erasing ? width * 3 : width,
      erase: erasing,
      points: [[x, y, pressureOf(e)]],
    };
    redraw();
  };

  const onPointerMove = (e) => {
    if (!drawing.current || !currentStroke.current) return;
    if (penSeen.current && e.pointerType === "touch") return;
    e.preventDefault();

    // iPads report several points per frame; using them all gives a
    // noticeably smoother line.
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = toCanvas(ev);
      currentStroke.current.points.push([x, y, pressureOf(ev)]);
    }
    redraw();
  };

  const endStroke = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const stroke = currentStroke.current;
    currentStroke.current = null;
    if (!stroke || stroke.points.length === 0) return;
    setDraft((d) => ({ ...d, strokes: [...(d.strokes || []), stroke] }));
  };

  const undo = () => setDraft((d) => ({ ...d, strokes: (d.strokes || []).slice(0, -1) }));
  const clearAll = () => setDraft((d) => ({ ...d, strokes: [] }));

  const pickShade = (h, l) => {
    setHue(h);
    setLight(l);
    setColor(`hsl(${h}, 75%, ${l}%)`);
    setErasing(false);
  };

  return (
    <div>
      {/* Tools */}
      <div className="rounded-t-lg border border-b-0 border-stone-300 bg-stone-50 p-2">
        <div className="flex flex-wrap items-center gap-2">
          {PEN_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              title="Pen colour"
              aria-label={`Pen colour ${c}`}
              onClick={() => {
                setColor(c);
                setErasing(false);
              }}
              className={`h-7 w-7 rounded-full border-2 u-focus ${
                color === c && !erasing ? "border-stone-800" : "border-stone-300"
              }`}
              style={{ backgroundColor: c }}
            />
          ))}

          <span className="h-5 w-px bg-stone-300" />

          <button
            type="button"
            onClick={() => setErasing((v) => !v)}
            title="Eraser"
            aria-label="Eraser"
            className={`flex h-8 w-8 items-center justify-center rounded-md u-focus ${
              erasing ? "u-accent-soft u-accent-deeptext" : "text-stone-600 hover:bg-stone-100"
            }`}
          >
            <Eraser size={16} />
          </button>
          <button
            type="button"
            onClick={undo}
            title="Undo"
            aria-label="Undo"
            className="flex h-8 w-8 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100 u-focus"
          >
            <Undo2 size={16} />
          </button>
          <button
            type="button"
            onClick={clearAll}
            title="Clear page"
            aria-label="Clear page"
            className="flex h-8 w-8 items-center justify-center rounded-md text-stone-600 hover:bg-stone-100 u-focus"
          >
            <Trash2 size={16} />
          </button>
        </div>

        {/* Colour and shade */}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span
            className="h-8 w-8 flex-shrink-0 rounded-full border border-stone-300"
            style={{ backgroundColor: erasing ? "#ffffff" : color }}
            aria-label="Current colour"
          />
          <label className="flex min-w-[130px] flex-1 items-center gap-2 text-xs text-stone-500">
            Colour
            <input
              type="range"
              min="0"
              max="360"
              value={hue}
              onChange={(e) => pickShade(Number(e.target.value), light)}
              className="w-full"
              style={{
                background:
                  "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
                borderRadius: "999px",
                height: "6px",
                appearance: "none",
              }}
            />
          </label>
          <label className="flex min-w-[130px] flex-1 items-center gap-2 text-xs text-stone-500">
            Shade
            <input
              type="range"
              min="10"
              max="85"
              value={light}
              onChange={(e) => pickShade(hue, Number(e.target.value))}
              className="w-full"
              style={{
                background: `linear-gradient(to right, hsl(${hue},75%,10%), hsl(${hue},75%,50%), hsl(${hue},75%,85%))`,
                borderRadius: "999px",
                height: "6px",
                appearance: "none",
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-stone-500">
            Size
            <input
              type="range"
              min="1"
              max="14"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              className="w-24"
            />
          </label>
        </div>
      </div>

      {/* Page */}
      <div ref={wrapRef} className="overflow-hidden rounded-b-lg border border-stone-300">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
          className={draft.style === "lined" ? "lined-paper" : "bg-white"}
          style={{
            width: "100%",
            aspectRatio: `${CANVAS_W} / ${CANVAS_H}`,
            display: "block",
            touchAction: "none", // stops the page scrolling while drawing
            cursor: "crosshair",
            // Stops iPad selecting text or popping up the copy/paste menu
            // when the Pencil or a finger rests on the page.
            WebkitUserSelect: "none",
            userSelect: "none",
            WebkitTouchCallout: "none",
          }}
        />
      </div>
      <p className="mt-1 text-xs text-stone-400">
        {strokes.length} stroke{strokes.length === 1 ? "" : "s"} · Apple Pencil and other styluses
        draw thicker when pressed harder. Once a stylus is used, your palm won't leave marks.
      </p>
    </div>
  );
}

/* ---- The editor, which shows whichever kind the note is ---- */

function NoteEditor({ draft, setDraft, onSave, onCancel, saveLabel = "Save note" }) {
  const isDrawing = draft.kind === "drawing";
  return (
    <div className="space-y-3">
      <span className="inline-flex items-center gap-1.5 rounded-full u-accent-soft u-accent-deeptext px-2.5 py-1 text-xs font-medium">
        {isDrawing ? "Handwritten" : "Typed"} · {draft.style} page
      </span>
      <div>
        <label className={labelCls}>Title</label>
        <input
          className={inputCls}
          spellCheck
          placeholder="Note title"
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
      </div>
      {isDrawing ? (
        <DrawingCanvas draft={draft} setDraft={setDraft} />
      ) : (
        <RichTextEditor draft={draft} setDraft={setDraft} />
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button className={btnGhost} onClick={onCancel}>
            <X size={15} /> Cancel
          </button>
        )}
        <button className={btnPrimary} onClick={onSave}>
          <Check size={15} /> {saveLabel}
        </button>
      </div>
    </div>
  );
}

/** The list's preview, whichever of the three shapes a note is in. */
const notePreview = (p) => (isRemote(p) ? previewFor(p) : aiNotePreview(p));

/* Hoisted out of the drawing editor so the READ-ONLY view can render the
   same strokes. Two copies of stroke rendering is how a note comes to
   look different depending on which screen you opened it from. */
const drawStroke = (ctx, stroke) => {
  const pts = stroke.points;
  if (!pts || pts.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (stroke.erase) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    ctx.strokeStyle = stroke.color;
  }

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], (stroke.width * (pts[0][2] || 0.5) * 2) / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.erase ? "rgba(0,0,0,1)" : stroke.color;
    ctx.fill();
    ctx.restore();
    return;
  }

  // Each little segment is drawn at its own width, which is how pressure
  // from a stylus turns into thick and thin lines.
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1, p1] = pts[i - 1];
    const [x2, y2, p2] = pts[i];
    const pressure = ((p1 || 0.5) + (p2 || 0.5)) / 2;
    ctx.lineWidth = Math.max(0.5, stroke.width * (0.4 + pressure * 1.6));
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();
};


/** Someone's handwriting, rendered but not editable. */
function StrokeCanvas({ strokes = [], style }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = CANVAS_W * ratio;
    canvas.height = CANVAS_H * ratio;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    for (const st of strokes) drawStroke(ctx, st);
  }, [strokes]);
  return (
    <canvas
      ref={ref}
      className={`w-full rounded-lg border border-stone-200 ${style === "lined" ? "lined-paper" : "bg-white"}`}
      style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}`, touchAction: "none" }}
    />
  );
}

/* Extracted from NoteRow so the read-only view can carry the same menu.
   The brief asks for it in both modes, and two copies of a folder picker
   is how they drift apart. */
function NoteMenu({ page, folders, onMove }) {
  const [menu, setMenu] = useState(false);
  return (
    <>
      <button className={iconBtn} onClick={() => setMenu((m) => !m)} aria-label="More options">
        <MoreVertical size={15} />
      </button>
      {menu && (
        <div className="absolute right-0 top-9 z-20 w-52 rounded-xl border border-stone-200 bg-white p-2 shadow-lg">
          <p className="px-2 pb-1 pt-0.5 text-xs font-medium text-stone-500">Move to folder</p>
          {folders.length === 0 && <p className="px-2 py-1 text-xs text-stone-400">No folders yet. Create one in the Folders tab.</p>}
          <div className="max-h-48 overflow-y-auto">
            {folders.map((fo) => (
              <button key={fo.id} onClick={() => { onMove(page.id, fo.id); setMenu(false); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-stone-700 hover:bg-stone-100">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: folderColor(fo.color).hex }} />
                {fo.name}
                {page.folderId === fo.id && <Check size={13} className="ml-auto text-stone-400" />}
              </button>
            ))}
          </div>
          {page.folderId && (
            <button onClick={() => { onMove(page.id, null); setMenu(false); }} className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-stone-100 px-2 py-1.5 text-left text-sm text-stone-500 hover:bg-stone-100">
              <X size={13} /> Remove from folder
            </button>
          )}
        </div>
      )}
    </>
  );
}

function NoteRow({ p, folders, onEdit, onMove, onDelete }) {
  const f = folders.find((x) => x.id === p.folderId);
  return (
    <li className="rounded-xl border border-stone-200 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-stone-800">{p.title || <span className="text-stone-400">Untitled note</span>}</h3>
          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-stone-400">
            <span className="capitalize">
              {isReferenceSheet(p) ? "Reference sheet" : `${p.kind === "drawing" ? "Handwritten" : "Typed"} · ${p.style} page`}
            </span>
            {f && (
              <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5" style={{ backgroundColor: folderColor(f.color).soft, color: folderColor(f.color).text }}>
                <Folder size={10} /> {f.name}
              </span>
            )}
          </span>
        </div>
        <div className="relative flex flex-shrink-0 gap-0.5">
          <button className={iconBtn} onClick={() => onEdit(p)} aria-label="Edit note">
            <Pencil size={15} />
          </button>
          <button className={iconBtn} onClick={() => onDelete(p.id)} aria-label="Delete note">
            <Trash2 size={15} />
          </button>
          <NoteMenu page={p} folders={folders} onMove={onMove} />
        </div>
      </div>
      {isReferenceSheet(p) ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-sm text-stone-500">
          <ListTodo size={14} /> {sheetSummary(p)}
        </p>
      ) : p.kind === "drawing" ? (
        (p.strokes || []).length > 0 && (
          <p className="mt-1.5 flex items-center gap-1.5 text-sm text-stone-500">
            <PenLine size={14} /> {p.strokes.length} stroke{p.strokes.length === 1 ? "" : "s"}
          </p>
        )
      ) : (
        /* Three shapes to preview, in age order: a moved AI note reads
           its stub's stored preview (in the language being read), an
           older one still has the whole summary in aiMeta, and an
           ordinary note has html. The list must never need the network --
           it is the first thing on screen. */
        (notePreview(p) || htmlToText(p.html)) && (
          <p className="mt-1.5 line-clamp-3 text-sm text-stone-600">{notePreview(p) || htmlToText(p.html)}</p>
        )
      )}
    </li>
  );
}

/* ---- Reference sheet editor ----

   A page with kind "formula" and an `entries` array. Same enforcement
   rule as rubrics: no maxLength anywhere, the overage is named, and
   Save is blocked rather than the text being cut. */

function ReferenceSheetEditor({ draft, setDraft }) {
  const entries = (draft.entries || []).filter((e) => e && !e.deletedAt);
  const check = validateSheet(entries);
  const set = (next) => setDraft({ ...draft, entries: next });

  return (
    <div>
      <label className={labelCls}>Title</label>
      <input
        className={inputCls}
        spellCheck
        placeholder="e.g. MATH2001 exam sheet"
        value={draft.title || ""}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
      />

      <div className="mt-3 flex items-center justify-between">
        <p className={labelCls}>Entries</p>
        <p className="text-xs text-stone-400">{entries.length} of {SHEET_ENTRIES_MAX}</p>
      </div>

      {entries.length === 0 && <Empty>Nothing on this sheet yet. Add your first formula or definition.</Empty>}

      <ul className="space-y-2">
        {entries.map((e) => {
          const label = checkLength(e.label, ENTRY_LABEL_MAX, "This name");
          const body = checkLength(e.body, ENTRY_BODY_MAX, "This entry");
          return (
            <li key={e.id} className="rounded-lg border border-stone-200 p-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <input
                    className={inputCls}
                    spellCheck
                    placeholder="What it's called"
                    value={e.label || ""}
                    onChange={(ev) => set(entries.map((x) => (x.id === e.id ? { ...x, label: ev.target.value } : x)))}
                  />
                  <textarea
                    rows={2}
                    className={`${inputCls} mt-1 font-mono text-sm`}
                    spellCheck={false}
                    placeholder="The formula or definition"
                    value={e.body || ""}
                    onChange={(ev) => set(entries.map((x) => (x.id === e.id ? { ...x, body: ev.target.value } : x)))}
                  />
                  {(!label.ok || !body.ok) && (
                    <p className="mt-1 text-xs font-medium text-rose-600">{!label.ok ? label.message : body.message}</p>
                  )}
                </div>
                <button className={iconBtn} onClick={() => set(entries.filter((x) => x.id !== e.id))} aria-label="Remove entry">
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-2">
        <button className={btnGhost} onClick={() => set([...entries, emptyEntry(uid)])} disabled={entries.length >= SHEET_ENTRIES_MAX}>
          <Plus size={14} /> Add entry
        </button>
      </div>

      {!check.ok && (
        <ul className="mt-2 space-y-0.5">
          {check.problems.map((p, i) => (
            <li key={i} className="text-xs font-medium text-rose-600">{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* Read-only view, opened from the notes list. Plain text on purpose --
   there is no maths rendering, so a formula is whatever the student
   typed. See CLAUDE.md. */
/**
 * A note, read rather than edited.
 *
 * Tapping a note used to open the editor directly, which is wrong once a
 * stylus is involved: a palm resting on an editable page writes into it.
 * Reading is the common case and should be the safe one.
 *
 * This is not a fourth pattern -- reference sheets and AI lecture notes
 * already open read-only. It brings text and handwritten notes into line
 * with them, so all four behave the same way.
 */
function NoteView({ page, folders, onEdit, onClose, onMove, onDelete }) {
  if (!page) return null;
  const isDrawing = page.kind === "drawing";
  return (
    <Card className="mt-3">
      <div className="flex items-start justify-between gap-2">
        <button className={iconBtn} onClick={onClose} aria-label="Back to notes">
          <ChevronLeft size={18} />
        </button>
        <h3 className="min-w-0 flex-1 truncate font-serif text-base font-semibold text-stone-800">
          {page.title || "Untitled note"}
        </h3>
        <div className="flex flex-shrink-0 gap-0.5">
          <button className={btnGhost} onClick={onEdit}>
            <Pencil size={15} /> Edit
          </button>
          {/* The ⋯ menu stays in BOTH modes -- move and delete are things
              you want while reading, not only while editing. */}
          <NoteMenu page={page} folders={folders} onMove={onMove} onDelete={onDelete} />
        </div>
      </div>

      {isDrawing ? (
        <div className="mt-3">
          <StrokeCanvas strokes={page.strokes || []} readOnly style={page.style} />
        </div>
      ) : (
        <div
          className={`mt-3 whitespace-pre-wrap text-sm text-stone-700 ${page.style === "lined" ? "lined-paper px-1" : ""} ${
            page.font === "serif" ? "font-serif" : page.font === "mono" ? "font-mono" : ""
          }`}
        >
          {page.body || htmlToText(page.html) || <span className="text-stone-400">This note is empty.</span>}
        </div>
      )}
    </Card>
  );
}

function ReferenceSheetView({ page, onEdit, onClose }) {
  const entries = ((page && page.entries) || []).filter((e) => e && !e.deletedAt);
  if (!page) return null;
  return (
    <Card className="mt-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-serif text-base font-semibold text-stone-800">{page.title || "Reference sheet"}</h3>
        <div className="flex gap-0.5">
          <button className={iconBtn} onClick={onEdit} aria-label="Edit sheet"><Pencil size={15} /></button>
          <button className={iconBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
      </div>
      {entries.length === 0 ? (
        <Empty>No entries yet.</Empty>
      ) : (
        <dl className="mt-3 space-y-2.5">
          {entries.map((e) => (
            <div key={e.id} className="rounded-lg bg-stone-50 p-2.5">
              <dt className="text-sm font-medium text-stone-800">{e.label || "Untitled"}</dt>
              <dd className="mt-0.5 whitespace-pre-wrap font-mono text-sm text-stone-600">{e.body}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

/* ---- Notes tab: a flat list of all notes (folders live in their own tab) ---- */

function Notes({ pages, folders, addItem, patchItem, removeItem, session, textAllowance, onSummariseNote }) {
  const [draft, setDraft] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const [aiViewId, setAiViewId] = useState(null);
  const isNew = draft && !draft.id;
  /* Reading is the default; editing is a deliberate act. A palm resting
     on an editable page writes into it, which is the failure this
     prevents -- and it brings text and handwritten notes into line with
     reference sheets and AI notes, which already open read-only. */
  const [viewId, setViewId] = useState(null);
  const showList = !draft && !choosing && !viewId;

  const [sheetViewId, setSheetViewId] = useState(null);
  const room = canAddSheet(pages);

  const startNew = ({ style, kind }) => {
    setDraft({ title: "", body: "", html: "", strokes: [], entries: [], style, kind, font: "sans", folderId: null });
    setChoosing(false);
  };
  /* ---------- autosave ----------

     WHY A DEBOUNCE IS THE WHOLE FEATURE, not a nicety: the app-level
     effect that persists the planner serialises the ENTIRE blob on every
     `data` change, synchronously, with no debounce of its own. Measured:
     a realistic 670KB account is ~1.1ms per JSON.stringify in Node, and
     CLAUDE.md's phone figure (45-75ms at ~1MB) puts a mid-range device
     25-45x slower -- so ~30-50ms per commit on the hardware that
     matters. Committing per keystroke at 8-10 characters a second would
     spend 300-500ms of every second blocking the main thread, which is
     unusable typing. One commit per idle pause costs that once.

     1200ms is long enough that ordinary typing never triggers it
     mid-flow and short enough that a dropped tab loses about a sentence.

     HANDWRITING USES THE SAME PAUSE, deliberately. The brief asked for a
     commit on stroke end; the measurement argued otherwise. A stroke
     serialises to ~1.7KB, so a 200-stroke page grows the blob by 336KB
     while it is being written -- committing per pen lift means 200
     full-blob serialises, each slower than the last. Debouncing keeps
     the property that actually mattered (never mid-stroke) and turns
     continuous writing into one commit per natural pause. */
  const AUTOSAVE_MS = 1200;

  const draftRef = useRef(null);
  const autosaveTimer = useRef(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const flushAutosave = () => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  };

  /* Whether there is anything worth creating a note for. An empty draft
     never becomes a row -- that is what stops "New note, changed my
     mind" leaving litter behind. */
  const hasContent = (d) =>
    !!d &&
    ((d.title || "").trim() ||
      (d.body || "").trim() ||
      (d.strokes || []).length > 0 ||
      ((d.entries || []).length > 0));

  useEffect(() => {
    if (!draft) return;
    // A brand-new empty draft is not created until it has something in it.
    if (!draft.id && !hasContent(draft)) return;
    flushAutosave();
    autosaveTimer.current = setTimeout(() => {
      autosaveTimer.current = null;
      commit(draftRef.current);
    }, AUTOSAVE_MS);
    return flushAutosave;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  /* Leaving the tab or the window is the case a debounce alone misses:
     the timer is cleared on unmount and the last edits would go with it. */
  useEffect(() => {
    const commitNow = () => {
      if (autosaveTimer.current) {
        flushAutosave();
        commit(draftRef.current);
      }
    };
    window.addEventListener("blur", commitNow);
    document.addEventListener("visibilitychange", commitNow);
    return () => {
      window.removeEventListener("blur", commitNow);
      document.removeEventListener("visibilitychange", commitNow);
      // Unmounting with work pending -- switching tabs inside the app,
      // or the component going away -- must not lose it either.
      commitNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fieldsOf = (d) => ({
    title: d.title,
    body: d.body || "",
    html: d.html || "",
    strokes: d.strokes || [],
    style: d.style,
    kind: d.kind || "text",
    font: d.font || "sans",
    // Only reference sheets carry entries; every other page keeps the
    // key absent rather than an empty array it never reads.
    ...(isReferenceSheet(d) ? { entries: d.entries || [] } : {}),
  });

  /* Write the draft into `data`, WITHOUT leaving the editor.
     Autosave and Done both go through here, so there is exactly one
     commit path -- the one already wired into sync, offline handling and
     the storage-failure banner. */
  const commit = (d) => {
    if (!d) return;
    const fields = fieldsOf(d);
    if (!d.id) {
      /* A NEW note is created on its first content-bearing autosave, not
         when the editor opens: tap New note, change your mind, and
         nothing was ever created. From here on it patches like any
         other, so the id is written back into the draft. */
      const id = uid();
      addItem("pages", { id, ...fields, folderId: d.folderId || null });
      setDraft((cur) => (cur ? { ...cur, id } : cur));
      setViewId(id);
      return;
    }
    patchItem("pages", d.id, fields);
  };

  const save = () => {
    flushAutosave();
    commit(draftRef.current || draft);
    setDraft(null);
  };
  const sheetOk = !isReferenceSheet(draft) || validateSheet((draft && draft.entries) || []).ok;

  return (
    <Card>
      {showList && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-stone-500">{pages.length} note{pages.length === 1 ? "" : "s"}</p>
          <button className={btnPrimary} onClick={() => setChoosing(true)} aria-label="New note">
            <Plus size={16} /> New note
          </button>
        </div>
      )}
      {choosing && (
        <>
          {!room.ok && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{room.message}</p>}
          <PageTypeChooser onCreate={startNew} onCancel={() => setChoosing(false)} sheetsFull={!room.ok} />
        </>
      )}
      {draft && isReferenceSheet(draft) && (
        <div>
          <ReferenceSheetEditor draft={draft} setDraft={setDraft} />
          <div className="mt-3 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setDraft(null)}><X size={15} /> Cancel</button>
            <button className={btnPrimary} onClick={save} disabled={!sheetOk}><Check size={15} /> Save sheet</button>
          </div>
        </div>
      )}
      {draft && !isReferenceSheet(draft) && (
        <>
          {/* `fromView` means this note was opened for reading and the
              student chose Edit. Done commits and returns to reading;
              there is deliberately no Cancel, because a discard path is
              the "are you sure?" class of bug Grace asked us to avoid on
              the most-used screen. A NEW note still has Cancel, where
              discarding is a meaningful thing to want. */}
          <NoteEditor
            draft={draft}
            setDraft={setDraft}
            onSave={save}
            onCancel={isNew ? () => setDraft(null) : null}
            saveLabel={isNew ? "Save note" : "Done"}
          />
          {/* Only on a note that already HAS something in it, and only
              once saved -- summarising an empty draft would spend
              allowance on nothing. SummariseNote returns null when the
              body is blank, so a new note shows no control at all. */}
          {session && !isNew && (
            <SummariseNote
              session={session}
              page={draft}
              allowanceApi={textAllowance}
              onSummarised={(result) => onSummariseNote(draft, result)}
            />
          )}
        </>
      )}
      {showList && pages.length === 0 && <Empty>No notes yet. Tap "New note" to add one.</Empty>}
      {showList && pages.length > 0 && (
        <ul className="mt-3 space-y-2">
          {pages.map((p) => (
            <NoteRow key={p.id} p={p} folders={folders} onEdit={(n) => (n.aiMeta ? setAiViewId(n.id) : isReferenceSheet(n) ? setSheetViewId(n.id) : setViewId(n.id))} onMove={(id, folderId) => patchItem("pages", id, { folderId })} onDelete={(id) => removeItem("pages", id)} />
          ))}
        </ul>
      )}
      {viewId && !draft && (
        <NoteView
          page={pages.find((p) => p.id === viewId)}
          folders={folders}
          onEdit={() => setDraft({ ...pages.find((p) => p.id === viewId) })}
          onClose={() => setViewId(null)}
          onMove={(id, folderId) => patchItem("pages", id, { folderId })}
          onDelete={(id) => { removeItem("pages", id); setViewId(null); }}
        />
      )}
      {sheetViewId && (
        <ReferenceSheetView
          page={pages.find((p) => p.id === sheetViewId)}
          onEdit={() => { setDraft({ ...pages.find((p) => p.id === sheetViewId) }); setSheetViewId(null); }}
          onClose={() => setSheetViewId(null)}
        />
      )}
      {aiViewId && (
        <AiLectureNoteView
          page={pages.find((p) => p.id === aiViewId)}
          patchItem={patchItem}
          onClose={() => setAiViewId(null)}
          /* Only ever called for a row that is DEFINITIVELY absent -- the
             other device deleted it and this one still has the stub. */
          onMissing={(id) => removeItem("pages", id)}
        />
      )}
    </Card>
  );
}

/* ---- Folders tab: create / name / colour / delete folders and browse their notes ---- */

function Folders({ pages, folders, addItem, patchItem, removeItem, onDeleteFolder }) {
  const [folderForm, setFolderForm] = useState(null); // {id?, name, color}
  const [confirmId, setConfirmId] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [aiViewId, setAiViewId] = useState(null);

  const saveFolder = () => {
    const name = (folderForm.name || "").trim() || "Untitled folder";
    if (folderForm.id) patchItem("folders", folderForm.id, { name, color: folderForm.color });
    else addItem("folders", { id: uid(), name, color: folderForm.color });
    setFolderForm(null);
  };
  const saveNote = () => {
    patchItem("pages", draft.id, {
      title: draft.title,
      body: draft.body || "",
      html: draft.html || "",
      strokes: draft.strokes || [],
      style: draft.style,
      kind: draft.kind || "text",
      font: draft.font || "sans",
    });
    setDraft(null);
  };
  const countFor = (fid) => pages.filter((p) => p.folderId === fid).length;

  if (draft) {
    return (
      <Card>
        <NoteEditor draft={draft} setDraft={setDraft} onSave={saveNote} onCancel={() => setDraft(null)} />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-sm text-stone-500">{folders.length} folder{folders.length === 1 ? "" : "s"}</p>
        {!folderForm && (
          <button className={btnPrimary} onClick={() => setFolderForm({ name: "", color: "teal" })}>
            <FolderPlus size={16} /> New folder
          </button>
        )}
      </div>

      {folderForm && (
        <div className={`mt-3 ${editBox}`}>
          <label className={labelCls}>Folder name</label>
          <input className={inputCls} spellCheck placeholder="e.g. Lecture notes" value={folderForm.name} onChange={(e) => setFolderForm((s) => ({ ...s, name: e.target.value }))} />
          <label className={`${labelCls} mt-2`}>Colour</label>
          <div className="flex flex-wrap gap-2">
            {FOLDER_COLOR_KEYS.map((key) => (
              <button key={key} onClick={() => setFolderForm((s) => ({ ...s, color: key }))} className="flex h-8 w-8 items-center justify-center rounded-full u-focus" style={{ backgroundColor: FOLDER_COLORS[key].hex }} aria-label={key}>
                {folderForm.color === key && <Check size={15} className="text-white" />}
              </button>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setFolderForm(null)}>
              <X size={15} /> Cancel
            </button>
            <button className={btnPrimary} onClick={saveFolder}>
              <Check size={15} /> {folderForm.id ? "Save folder" : "Create folder"}
            </button>
          </div>
        </div>
      )}

      {folders.length === 0 && !folderForm && <Empty>No folders yet. Create one, then move notes into it from the Notes tab.</Empty>}

      <ul className="mt-3 space-y-2">
        {folders.map((f) => {
          const c = folderColor(f.color);
          const open = openId === f.id;
          const notes = pages.filter((p) => p.folderId === f.id);
          return (
            <li key={f.id} className="rounded-xl border border-stone-200">
              <div className="flex items-center justify-between gap-2 p-3">
                <button onClick={() => setOpenId(open ? null : f.id)} className="flex min-w-0 items-center gap-2 text-left u-focus">
                  <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: c.hex }} />
                  <span className="truncate font-medium text-stone-800">{f.name}</span>
                  <span className="flex-shrink-0 text-xs text-stone-400">{countFor(f.id)} note{countFor(f.id) === 1 ? "" : "s"}</span>
                </button>
                <div className="flex flex-shrink-0 gap-0.5">
                  <button className={iconBtn} onClick={() => setFolderForm({ ...f })} aria-label="Edit folder">
                    <Pencil size={15} />
                  </button>
                  <button className={iconBtn} onClick={() => setConfirmId(confirmId === f.id ? null : f.id)} aria-label="Delete folder">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {confirmId === f.id && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 px-3 py-2">
                  <span className="text-xs text-stone-500">Delete this folder? Its notes are kept and moved to Unfiled.</span>
                  <span className="flex gap-2">
                    <button className={btnGhost} onClick={() => setConfirmId(null)}>
                      <X size={15} /> Cancel
                    </button>
                    <button className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700 u-focus" onClick={() => { onDeleteFolder(f.id); setConfirmId(null); if (openId === f.id) setOpenId(null); }}>
                      <Trash2 size={15} /> Delete
                    </button>
                  </span>
                </div>
              )}

              {open && (
                <div className="border-t border-stone-200 p-3">
                  {notes.length === 0 ? (
                    <Empty>No notes in this folder yet.</Empty>
                  ) : (
                    <ul className="space-y-2">
                      {notes.map((p) => (
                        <NoteRow key={p.id} p={p} folders={folders} onEdit={(n) => (n.aiMeta ? setAiViewId(n.id) : setDraft({ ...n }))} onMove={(id, folderId) => patchItem("pages", id, { folderId })} onDelete={(id) => removeItem("pages", id)} />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {aiViewId && (
        <AiLectureNoteView
          page={pages.find((p) => p.id === aiViewId)}
          patchItem={patchItem}
          onClose={() => setAiViewId(null)}
          /* Only ever called for a row that is DEFINITIVELY absent -- the
             other device deleted it and this one still has the stub. */
          onMissing={(id) => removeItem("pages", id)}
        />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Class notes (study-card source)                                   */
/* ------------------------------------------------------------------ */

function ClassNoteFields({ state, set, courses }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className={labelCls}>Course</label>
        <CourseSelect value={state.course || ""} onChange={(v) => set((x) => ({ ...x, course: v }))} courses={courses} />
      </div>
      <div>
        <label className={labelCls}>Week</label>
        <input type="number" min="1" className={inputCls} placeholder="e.g. 5" value={state.week || ""} onChange={(e) => set((x) => ({ ...x, week: e.target.value }))} />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Key term / prompt (the flashcard front)</label>
        <input className={inputCls} spellCheck placeholder="e.g. Classical conditioning" value={state.term || ""} onChange={(e) => set((x) => ({ ...x, term: e.target.value }))} />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>Notes (the answer side)</label>
        <textarea className={inputCls} rows={3} spellCheck placeholder="Write what you learned this week..." value={state.content || ""} onChange={(e) => set((x) => ({ ...x, content: e.target.value }))} />
      </div>
    </div>
  );
}

function ClassNotes({ notes, courses, addItem, patchItem, removeItem, focused }) {
  const [form, setForm] = useState({ course: "", week: "", term: "", content: "" });
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({});

  const add = () => {
    if (!form.content.trim() && !form.term.trim()) return;
    addItem("notes", { id: uid(), ...form });
    setForm({ course: form.course, week: form.week, term: "", content: "" });
  };

  const sorted = useMemo(
    () =>
      [...notes].sort((a, b) => {
        const c = (a.course || "").localeCompare(b.course || "");
        if (c !== 0) return c;
        return (parseInt(a.week) || 0) - (parseInt(b.week) || 0);
      }),
    [notes]
  );

  return (
    <Card>
      <ClassNoteFields state={form} set={setForm} courses={courses} />
      <div className="mt-2 flex justify-end">
        <button className={btnPrimary} onClick={add} disabled={!form.content.trim() && !form.term.trim()}>
          <Plus size={16} /> Add card
        </button>
      </div>

      {notes.length === 0 ? (
        <Empty>Add a key term and notes here. Each one becomes a study card in the game below.</Empty>
      ) : (
        <ul className="mt-4 space-y-2">
          {sorted.map((n) =>
            editingId === n.id ? (
              <li key={n.id} className={editBox}>
                <ClassNoteFields state={edit} set={setEdit} courses={courses} />
                <div className="mt-2 flex justify-end gap-2">
                  <button className={btnGhost} onClick={() => setEditingId(null)}>
                    <X size={15} /> Cancel
                  </button>
                  <button className={btnPrimary} onClick={() => { patchItem("notes", n.id, edit); setEditingId(null); }}>
                    <Check size={15} /> Save
                  </button>
                </div>
              </li>
            ) : (
              <li key={n.id} className={`rounded-xl border border-stone-200 p-3 ${focused && n.course === focused ? "u-highlight" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <CourseChip name={n.course} />
                    {n.week && <span className="rounded-md bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-600">Week {n.week}</span>}
                  </div>
                  <div className="flex flex-shrink-0 gap-0.5">
                    <button className={iconBtn} onClick={() => { setEditingId(n.id); setEdit({ ...n }); }}>
                      <Pencil size={15} />
                    </button>
                    <button className={iconBtn} onClick={() => removeItem("notes", n.id)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                {n.term && <p className="mt-2 font-medium text-stone-800">{n.term}</p>}
                {n.content && <p className="mt-0.5 whitespace-pre-wrap text-sm text-stone-600">{n.content}</p>}
              </li>
            )
          )}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Study game                                                        */
/* ------------------------------------------------------------------ */

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Two ways to study, deliberately kept separate:

   REVIEW is spaced repetition. It pulls only what's due, interleaves it
   across courses, and writes scheduling state.

   PRACTICE is the night-before-the-exam drill. It walks every card in a
   course regardless of due date and writes NOTHING -- cramming shouldn't
   be able to push a card the student is actually shaky on out to a
   three-week interval. This is also the pre-existing behaviour of this
   screen, kept for anyone who preferred it. */

const RATING_BUTTONS = [
  { key: "again", label: "Again", hint: "Didn't know it", cls: "border-stone-200 text-stone-700 hover:bg-stone-50" },
  { key: "good", label: "Good", hint: "Got there", cls: "border-stone-200 text-stone-700 hover:bg-stone-50" },
  { key: "easy", label: "Easy", hint: "Instant", cls: "border-stone-200 text-stone-700 hover:bg-stone-50" },
];

function StudyGame({ notes, onRate, session, textAllowance }) {
  const [mode, setMode] = useState(""); // "" | "review" | "practice"
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const [courseName, setCourseName] = useState("");

  const today = localDay();

  const coursesWithNotes = useMemo(() => {
    const counts = {};
    (notes || []).forEach((n) => {
      const key = n.course || "No course";
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts);
  }, [notes]);

  const dueCount = useMemo(() => (notes || []).filter((n) => isDue(n, today)).length, [notes, today]);

  const cardFront = (n) => n.term || (n.week ? `Week ${n.week}` : "Recall this note");
  const cardBack = (n) => n.content || "(No notes written for this card)";

  const startReview = () => {
    const deck = buildReviewSession(notes || [], { today });
    setMode("review");
    setCourseName("");
    setCurrent(deck[0] || null);
    setQueue(deck.slice(1));
    setDone(0);
    setRevealed(false);
  };

  const startPractice = (name) => {
    const deck = buildPracticeSession(notes || [], name);
    setMode("practice");
    setCourseName(name);
    setCurrent(deck[0] || null);
    setQueue(deck.slice(1));
    setDone(0);
    setRevealed(false);
  };

  const exit = () => {
    setMode("");
    setCurrent(null);
    setQueue([]);
    setDone(0);
    setRevealed(false);
  };

  const rate = (rating) => {
    if (!current) return;
    // Practice writes no scheduling state at all.
    if (mode === "review") {
      onRate(current.id, rating);
    }
    // "Again" sends the card back to the end of this session, matching
    // the scheduler putting it due today rather than days out.
    const q = rating === "again" ? [...queue, current] : queue;
    if (rating !== "again") setDone((d) => d + 1);
    setCurrent(q[0] || null);
    setQueue(q.slice(1));
    setRevealed(false);
  };

  /* ---- picker ---- */
  if (!mode) {
    const next = nextDueDay(notes || [], today);
    const daysAway = next ? daysBetween(today, next) : null;
    return (
      <Card>
        {coursesWithNotes.length === 0 ? (
          <Empty>Add some class notes above first, then come back to study them.</Empty>
        ) : (
          <>
            <button
              onClick={startReview}
              disabled={dueCount === 0}
              className="mb-3 flex w-full items-center justify-between rounded-xl border border-stone-200 px-4 py-3 text-left u-hover-border u-hover-soft u-focus disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>
                <span className="flex items-center gap-2 font-medium text-stone-800">
                  <Brain size={16} /> Review what's due
                </span>
                <span className="mt-0.5 block text-sm text-stone-500">
                  {dueCount > 0
                    ? `${dueCount} card${dueCount === 1 ? "" : "s"} across all your courses`
                    : daysAway !== null && daysAway > 0
                      ? `Nothing due — next review in ${daysAway} day${daysAway === 1 ? "" : "s"}`
                      : "Nothing due right now"}
                </span>
              </span>
              {dueCount > 0 && <ArrowRight size={15} className="shrink-0 text-stone-400" />}
            </button>

            <p className="mb-2 text-sm text-stone-500">
              Or drill one course — practice runs through every card and doesn't affect your review schedule.
            </p>
            <div className="flex flex-col gap-2">
              {coursesWithNotes.map(([name, count]) => (
                <button key={name} onClick={() => startPractice(name)} className="flex items-center justify-between rounded-xl border border-stone-200 px-4 py-3 text-left u-hover-border u-hover-soft u-focus">
                  <span className="flex items-center gap-2">
                    <CourseChip name={name === "No course" ? "" : name} />
                    <span className="font-medium text-stone-800">{name}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-sm text-stone-500">
                    {count} card{count === 1 ? "" : "s"} <ArrowRight size={15} />
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </Card>
    );
  }

  /* ---- session finished ---- */
  if (!current) {
    const next = nextDueDay(notes || [], today);
    const daysAway = next ? daysBetween(today, next) : null;
    return (
      <Card className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full u-accent-soft u-accent-deeptext">
          <Check size={24} />
        </div>
        <h3 className="font-serif text-xl font-semibold text-stone-800">
          {mode === "review" ? "Review done" : "Practice done"}
        </h3>
        <p className="mt-1 text-sm text-stone-500">
          {done} card{done === 1 ? "" : "s"}
          {mode === "review"
            ? daysAway !== null && daysAway > 0
              ? ` · next review in ${daysAway} day${daysAway === 1 ? "" : "s"}`
              : ""
            : ` in ${courseName}`}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button className={btnGhost} onClick={exit}>Back to study</button>
          {mode === "review" && courseName === "" && coursesWithNotes.length > 0 && (
            <button className={btnPrimary} onClick={() => startPractice(coursesWithNotes[0][0])}>
              <RotateCcw size={15} /> Practice a course
            </button>
          )}
          {mode === "practice" && (
            <button className={btnPrimary} onClick={() => startPractice(courseName)}>
              <RotateCcw size={15} /> Practice again
            </button>
          )}
        </div>
      </Card>
    );
  }

  /* ---- a card ---- */
  const remaining = queue.length + 1;
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm text-stone-500">
          <CourseChip name={(current.course || "") === "No course" ? "" : current.course || ""} />
          {mode === "practice" ? "Practice" : "Review"} · {remaining} to go
        </span>
        <button className={iconBtn} onClick={exit} aria-label="Exit study">
          <X size={18} />
        </button>
      </div>

      <div className="rounded-2xl border border-stone-200 bg-stone-50 p-6 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-stone-400">{current.week ? `Week ${current.week}` : "Note"}</p>
        <p className="mt-2 text-lg font-medium text-stone-800">{cardFront(current)}</p>
        {revealed && (
          <div className="mt-4 border-t border-stone-200 pt-4">
            <p className="whitespace-pre-wrap text-left text-sm text-stone-700">{cardBack(current)}</p>
            {/* COLLAPSED by default, and only after the answer is shown.
                This is the screen students use daily, so the review flow
                is byte-for-byte unchanged for anyone who never opens it:
                one extra button, below the answer, above the rating. */}
            {session && textAllowance && (
              <div className="text-left">
                <ExplainItBack session={session} card={current} allowanceApi={textAllowance} />
              </div>
            )}
          </div>
        )}
      </div>

      {!revealed ? (
        <button className={`${btnPrimary} mt-4 w-full`} onClick={() => setRevealed(true)}>Show answer</button>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-2">
          {RATING_BUTTONS.map((b) => (
            <button
              key={b.key}
              onClick={() => rate(b.key)}
              className={`flex flex-col items-center justify-center rounded-xl border px-2 py-2.5 u-focus ${b.cls}`}
            >
              <span className="text-sm font-medium">{b.label}</span>
              <span className="text-xs text-stone-400">{b.hint}</span>
            </button>
          ))}
        </div>
      )}
      {mode === "practice" && revealed && (
        <p className="mt-2 text-center text-xs text-stone-400">Practice doesn't change your review schedule.</p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Setting a new password after a reset link                         */
/* ------------------------------------------------------------------ */

/**
 * Shown when Supabase reports a PASSWORD_RECOVERY event.
 *
 * A blocking overlay rather than a panel on the Account tab, because a
 * recovery session is a strange state to leave someone in: they are
 * signed in, they did not sign in, and the only thing they came to do is
 * set a password. Burying that behind a tab is how someone clicks a
 * reset link, sees their planner, and never changes anything -- which is
 * indistinguishable from the link not working.
 */
function PasswordRecovery({ onSet, onCancel }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < 8;

  const submit = async () => {
    if (password !== confirm) return setError("Those two don't match.");
    setBusy(true);
    setError("");
    try {
      await onSet(password);
      setDone(true);
    } catch (e) {
      setError(e.message || "We couldn't change your password. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4">
      <Card className="w-full max-w-sm">
        {done ? (
          <>
            <h2 className="font-serif text-lg font-semibold text-stone-800">Password changed</h2>
            <p className="mt-1 text-sm text-stone-600">
              You're signed in on this device. You'll need the new password next time you sign in anywhere else.
            </p>
            <button className={`${btnPrimary} mt-4 w-full`} onClick={onCancel}>
              Back to my planner
            </button>
          </>
        ) : (
          <>
            <h2 className="font-serif text-lg font-semibold text-stone-800">Set a new password</h2>
            <p className="mt-1 text-sm text-stone-600">
              You followed a reset link, so you can choose a new password now.
            </p>
            <div className="mt-3 space-y-2">
              <div>
                <label className={labelCls}>New password</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  className={inputCls}
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>Type it again</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  className={inputCls}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !mismatch && !tooShort && submit()}
                />
              </div>
            </div>
            {tooShort && <p className="mt-2 text-xs text-stone-500">A bit longer — at least 8 characters.</p>}
            {mismatch && <p className="mt-2 text-xs text-rose-600">Those two don't match.</p>}
            {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button
                className={`${btnPrimary} flex-1`}
                onClick={submit}
                disabled={busy || password.length < 8 || mismatch}
              >
                {busy ? "Saving…" : "Save new password"}
              </button>
              {/* An escape hatch, because a recovery session that can't be
                  dismissed is a trap for anyone who clicked the link by
                  accident or changed their mind. */}
              <button className={btnGhost} onClick={onCancel} disabled={busy}>
                Not now
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Weak spots — derived entirely from scheduling state               */
/* ------------------------------------------------------------------ */

function WeakSpots({ notes }) {
  const groups = useMemo(() => weakSpots(notes || []), [notes]);
  if (groups.size === 0) {
    return (
      <Card>
        <Empty>Nothing to flag yet. Cards you get wrong in a review will show up here.</Empty>
      </Card>
    );
  }
  return (
    <Card>
      <p className="mb-3 text-sm text-stone-500">Cards you've missed most often, worst first.</p>
      <div className="flex flex-col gap-4">
        {[...groups.entries()].map(([course, rows]) => (
          <div key={course}>
            <div className="mb-1.5 flex items-center gap-2">
              <CourseChip name={course === "No course" ? "" : course} />
              <span className="text-sm font-medium text-stone-700">{course}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {rows.map(({ card, lapses }) => (
                <li key={card.id} className="flex items-center justify-between rounded-lg border border-stone-100 px-3 py-2 text-sm">
                  <span className="truncate text-stone-800">{card.term || "(untitled card)"}</span>
                  <span className="ml-3 shrink-0 text-xs text-stone-500">
                    missed {lapses}×
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Study timer                                                       */
/* ------------------------------------------------------------------ */

/* The running timer is deliberately NOT part of the synced planner data:
   "currently running on this device" is not a fact other devices should
   inherit, and syncing it would make two devices fight over one clock.
   It lives in localStorage, keyed per semester, so a refresh doesn't lose
   it and Semester 1's clock can't be mistaken for Semester 2's. Only the
   finished minutes are ever committed to the semester. */
const timerKey = (semester) => `uni-planner-timer:${semester}`;

function readTimer(semester) {
  try {
    const raw = window.localStorage.getItem(timerKey(semester));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function writeTimer(semester, v) {
  try {
    if (v) window.localStorage.setItem(timerKey(semester), JSON.stringify(v));
    else window.localStorage.removeItem(timerKey(semester));
  } catch (e) {
    /* ignore -- a timer that can't persist still works for this session */
  }
}

function StudyTimer({ courses, onLog, semester }) {
  const [timer, setTimerState] = useState(idleTimer(""));
  const [note, setNote] = useState("");
  const [, setTick] = useState(0);

  /* One funnel for every transition. The ref exists because the unmount
     cleanup below runs from a closure and needs the latest values; going
     through here means state and ref can never disagree, so a cleanup
     firing in the same tick as a save cannot re-park minutes that have
     just been committed. */
  const timerRef = useRef(timer);
  const apply = (next) => {
    timerRef.current = next;
    setTimerState(next);
  };

  // Restore a timer left behind when the app was closed or the semester
  // was switched away from.
  useEffect(() => {
    const saved = readTimer(semester);
    if (saved) apply({ course: saved.course || "", accumulatedMs: saved.accumulatedMs || 0, startedAt: saved.startedAt || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semester]);

  useEffect(() => {
    if (!timer.startedAt) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [timer.startedAt]);

  // Park on unmount rather than letting a running clock accrue in the
  // background while the user is in another semester.
  useEffect(() => {
    return () => writeTimer(semester, timerPark(timerRef.current, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semester]);

  const persist = (next) => writeTimer(semester, next.startedAt || next.accumulatedMs ? next : null);
  const move = (next) => {
    apply(next);
    persist(next);
  };

  const now = Date.now();
  const elapsedMs = timerElapsedMs(timer, now);
  const minutes = timerMinutes(timer, now);
  const atCap = elapsedMs / 60000 > MAX_SESSION_MINUTES;

  const start = () => {
    setNote("");
    move(timerStart(timer, Date.now()));
  };
  const pause = () => move(timerPause(timer, Date.now()));
  const save = () => {
    const { next, minutes: mins, recorded, tooShort } = timerStop(timer, Date.now());
    if (recorded) {
      onLog(next.course || timer.course, mins);
      setNote("");
    } else if (tooShort) {
      // Never silently do nothing, and never round a few seconds up into
      // study time that didn't happen.
      setNote("That session was too short to record — keep going and save again.");
    }
    move(next);
  };
  const discard = () => {
    setNote("");
    move(timerDiscard(timer));
  };

  const hh = Math.floor(elapsedMs / 3600000);
  const mm = Math.floor((elapsedMs % 3600000) / 60000);
  const ss = Math.floor((elapsedMs % 60000) / 1000);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <select
          className={inputCls + " w-auto min-w-[10rem]"}
          value={timer.course}
          onChange={(e) => move({ ...timer, course: e.target.value })}
        >
          <option value="">No course</option>
          {(courses || []).map((c) => (
            <option key={c.id} value={c.name}>{c.name}</option>
          ))}
        </select>
        <span className="font-mono text-2xl tabular-nums text-stone-800">
          {hh > 0 ? `${hh}:` : ""}{String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
        </span>
        <div className="ml-auto flex gap-2">
          {!timer.startedAt ? (
            <button className={btnPrimary} onClick={start}>Start</button>
          ) : (
            <button className={btnGhost} onClick={pause}>Pause</button>
          )}
          {/* Deliberately not disabled on a short session: a dead control
              with no explanation is worse than a button that tells you
              why nothing happened. */}
          <button className={btnPrimary} onClick={save}>
            Save{minutes > 0 ? ` ${minutes}m` : ""}
          </button>
          {elapsedMs > 0 && (
            <button className={iconBtn} onClick={discard} aria-label="Discard timer">
              <X size={18} />
            </button>
          )}
        </div>
      </div>
      {note && <p className="mt-2 text-xs text-stone-500">{note}</p>}
      {atCap && (
        <p className="mt-2 text-xs text-stone-500">
          A single session is capped at {MAX_SESSION_MINUTES / 60} hours — saving will log {minutes} minutes.
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Streaks and stats — all derived at read time                      */
/* ------------------------------------------------------------------ */

function StudyStats({ studyStats }) {
  const s = useMemo(() => studySummary(studyStats || [], localDay()), [studyStats]);
  const courseRows = Object.entries(s.byCourse).sort((a, b) => b[1] - a[1]);
  const fmt = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`);

  return (
    <Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Current streak" value={s.current === 0 ? "—" : `${s.current} day${s.current === 1 ? "" : "s"}`} />
        <Stat label="Longest streak" value={s.longest === 0 ? "—" : `${s.longest} day${s.longest === 1 ? "" : "s"}`} />
        <Stat label="Cards today" value={s.cardsToday} />
        <Stat label="Studied today" value={fmt(s.minutesToday)} />
      </div>
      <p className="mt-3 text-sm text-stone-500">
        {fmt(s.minutesWeek)} this week · {s.activeDays} active day{s.activeDays === 1 ? "" : "s"} in the last 6 weeks
      </p>
      {courseRows.length > 0 && (
        <div className="mt-3 border-t border-stone-100 pt-3">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-stone-400">Time by course</p>
          <ul className="flex flex-col gap-1">
            {courseRows.map(([name, mins]) => (
              <li key={name} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <CourseChip name={name === "No course" ? "" : name} />
                  <span className="text-stone-700">{name}</span>
                </span>
                <span className="text-stone-500">{fmt(mins)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-stone-100 bg-stone-50 px-3 py-2">
      <p className="text-xs text-stone-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-stone-800">{value}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Backup: save everything to a file, and restore from one           */
/* ------------------------------------------------------------------ */

function BackupPanel({ data, onRestore, session }) {
  const fileRef = useRef(null);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(null); // parsed file waiting for a choice

  const counts = useMemo(() => {
    let items = 0;
    for (const sem of Object.values(data.semesters || {})) {
      for (const key of COUNTABLE) items += live(sem[key]).length;
    }
    return items;
  }, [data]);

  /* Measured, not estimated: this is the same JSON.stringify the save
     path runs, so the number shown is the number that counts against the
     browser's quota. Recomputed only when the data changes. */
  const size = useMemo(
    () =>
      describeSize({
        bytes: JSON.stringify(data).length,
        signedIn: !!session,
        isDemo: backend.isDemo,
      }),
    [data, session]
  );

  const download = () => {
    try {
      const stamp = new Date().toISOString().slice(0, 10).split("-").reverse().join("-");
      const payload = JSON.stringify({ app: "university-planner", exportedAt: nowISO(), data }, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `university-planner-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Backup saved to your downloads.");
    } catch (e) {
      setStatus("Couldn't save the backup on this device.");
    }
  };

  const pickFile = () => fileRef.current && fileRef.current.click();

  const readFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // let the same file be chosen again later
    if (!file) return;
    setStatus("");
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const restored = parsed && parsed.data ? parsed.data : parsed;
      if (!restored || typeof restored !== "object" || !restored.semesters) {
        setStatus("That doesn't look like a planner backup file.");
        return;
      }
      let found = 0;
      for (const sem of Object.values(restored.semesters || {})) {
        for (const key of COUNTABLE) found += ((sem || {})[key] || []).length;
      }
      setPending({ data: normalizeData(restored), found });
    } catch (err) {
      setStatus("Couldn't read that file - it may be damaged.");
    }
  };

  return (
    <Card className="mb-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full u-accent-soft u-accent-deeptext">
          <DatabaseBackup size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-stone-800">Backup</p>
          <p className="text-xs text-stone-500">
            {counts} item{counts === 1 ? "" : "s"} across your semesters · {size.line.replace("Your planner is ", "").replace(".", "")}
          </p>
        </div>
      </div>

      {/* Always visible, warning or not. A size only shown once it is a
          problem teaches nobody anything -- the point is that a student
          whose planner is growing can see it coming. */}
      {size.warn && (
        <p role="status" className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" />
          <span>
            <strong>{size.line}</strong> {size.detail}
          </span>
        </p>
      )}

      {!pending && (
        <>
          <div className="mt-4 flex gap-2">
            <button className={`${btnPrimary} flex-1`} onClick={download}>
              <Download size={15} /> Save a backup
            </button>
            <button className={btnGhost} onClick={pickFile}>
              <Upload size={15} /> Restore
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            onChange={readFile}
            style={{ display: "none" }}
            aria-hidden="true"
          />
          <p className="mt-3 text-xs text-stone-400">
            The backup is a single file holding everything - courses, notes, drawings, assignments,
            both semesters. Keep it somewhere safe like a cloud drive.
          </p>
        </>
      )}

      {pending && (
        <div className={`mt-4 ${editBox}`}>
          <p className="text-sm text-stone-700">
            That backup holds <strong>{pending.found}</strong> item
            {pending.found === 1 ? "" : "s"}. How should it be brought in?
          </p>
          <div className="mt-3 space-y-2">
            <button
              className={`${btnPrimary} w-full justify-start`}
              onClick={() => {
                onRestore(pending.data, "merge");
                setPending(null);
                setStatus("Backup merged in.");
              }}
            >
              <Check size={15} /> Merge with what's here now
            </button>
            <button
              className="inline-flex w-full items-center justify-start gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-rose-700 u-focus"
              onClick={() => {
                onRestore(pending.data, "replace");
                setPending(null);
                setStatus("Everything replaced with the backup.");
              }}
            >
              <RotateCcw size={15} /> Replace everything with the backup
            </button>
            <button className={`${btnGhost} w-full`} onClick={() => setPending(null)}>
              <X size={15} /> Cancel
            </button>
          </div>
          <p className="mt-2 text-xs text-stone-500">
            <strong>Merge</strong> keeps both, newest edit winning - safe. <strong>Replace</strong>
            {" "}throws away what's on this device first - use it when restoring after losing data.
          </p>
        </div>
      )}

      {status && <p className="mt-3 text-sm u-accent-text">{status}</p>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Account + sync                                                    */
/* ------------------------------------------------------------------ */

function AccountPanel({ session, syncing, syncError, lastSyncedAt, onSignIn, onSignUp, onSignOut, onSync, onDeleteAccount, onResetPassword }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const runDelete = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      await onDeleteAccount();
    } catch (e) {
      setDeleteError(e.message || "We couldn't delete your account. Please try again.");
      setDeleting(false);
    }
  };
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [resetNote, setResetNote] = useState("");

  /* Deliberately says the same thing whether or not the address has an
     account. Confirming which emails are registered would turn this box
     into a way to enumerate the user list, and the honest phrasing --
     "if there's an account" -- costs nothing. */
  const forgot = async () => {
    if (!email.trim()) {
      setError("Enter your email address first, then tap this again.");
      return;
    }
    setBusy(true);
    setError("");
    setResetNote("");
    try {
      const result = await onResetPassword({ email });
      setResetNote(
        result && result.sent === false
          ? "There's no email server connected yet, so a reset link can't be sent from this build."
          : `If there's an account for ${email.trim()}, a link to set a new password is on its way. It expires in an hour, and check your spam folder.`
      );
    } catch (e) {
      setError(e.message || "We couldn't send that. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") await onSignUp({ email, password });
      else await onSignIn({ email, password });
      setEmail("");
      setPassword("");
    } catch (e) {
      setError(e.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  if (session) {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full u-accent-soft u-accent-deeptext">
            <UserRound size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-stone-800">{session.user.email}</p>
            <p className="text-xs text-stone-500">
              {lastSyncedAt ? `Last synced ${formatAU(lastSyncedAt.slice(0, 10))} at ${lastSyncedAt.slice(11, 16)}` : "Not synced yet"}
            </p>
          </div>
        </div>

        {syncError && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{syncError}</p>
        )}

        <div className="mt-4 flex gap-2">
          <button className={`${btnPrimary} flex-1`} onClick={onSync} disabled={syncing}>
            <RefreshCw size={15} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button className={btnGhost} onClick={onSignOut} disabled={syncing}>
            <LogOut size={15} /> Sign out
          </button>
        </div>

        {/* Deleting an account is irreversible and takes the user's notes
            with it, so it is typed rather than tapped, and it is the last
            thing on the panel rather than next to "Sign out". */}
        {!backend.isDemo && (
          <div className="mt-5 border-t border-stone-200 pt-4">
            {!confirmDelete ? (
              <button
                className="text-xs font-medium text-stone-400 hover:text-rose-600"
                onClick={() => { setConfirmDelete(true); setTyped(""); setDeleteError(""); }}
              >
                Delete account
              </button>
            ) : (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
                <p className="text-sm font-medium text-rose-800">Delete your account permanently?</p>
                <p className="mt-1 text-xs text-rose-700">
                  This removes your planner, your notes and everything we hold, on every device.
                  It can't be undone. Back up your planner first if you want to keep any of it.
                </p>
                <label className={`${labelCls} mt-3 text-rose-800`}>
                  Type {DELETE_CONFIRMATION_PHRASE} to confirm
                </label>
                <input
                  className={inputCls}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  aria-label={`Type ${DELETE_CONFIRMATION_PHRASE} to confirm`}
                />
                {deleteError && <p className="mt-2 text-sm text-rose-700">{deleteError}</p>}
                <div className="mt-3 flex justify-end gap-2">
                  <button className={btnGhost} onClick={() => setConfirmDelete(false)} disabled={deleting}>
                    Cancel
                  </button>
                  <button
                    className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50 u-focus"
                    disabled={!confirmationMatches(typed) || deleting}
                    onClick={runDelete}
                  >
                    <Trash2 size={14} /> {deleting ? "Deleting…" : "Delete everything"}
                  </button>
                </div>
                <p className="mt-2 text-xs text-rose-700">
                  <a className="underline" href={DELETE_ACCOUNT_URL} target="_blank" rel="noreferrer">
                    What gets deleted
                  </a>
                </p>
              </div>
            )}
          </div>
        )}

        {backend.isDemo && (
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" />
            <span>
              <strong>Demo mode.</strong> Your account and "cloud" copy are stored on this device
              only, so nothing actually travels between devices yet. Everything else works exactly
              as it will once the server is connected.
            </span>
          </p>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-4 flex gap-1 rounded-lg bg-stone-100 p-1">
        {[
          ["signin", "Sign in"],
          ["signup", "Create account"],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => { setMode(id); setError(""); }}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium u-focus ${
              mode === id ? "bg-white text-stone-800 shadow-sm" : "text-stone-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="mb-3 text-sm text-stone-500">
        An account lets your planner follow you between your phone, tablet and computer.
      </p>

      <div className="space-y-2">
        <div>
          <label className={labelCls}>Email</label>
          <input
            type="email"
            autoComplete="email"
            className={inputCls}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls}>Password</label>
          <input
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className={inputCls}
            placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
      </div>

      {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {resetNote && <p className="mt-3 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-600">{resetNote}</p>}

      <button className={`${btnPrimary} mt-4 w-full`} onClick={submit} disabled={busy}>
        {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
      </button>

      {/* The entry point that did not exist. `resetPassword` has been on
          the backend all along with nothing calling it, so a user who
          forgot their password had no route back into their account. */}
      {mode === "signin" && (
        <button
          className="mt-3 w-full text-center text-xs text-stone-500 underline u-focus"
          onClick={forgot}
          disabled={busy}
        >
          Forgot your password?
        </button>
      )}

      {backend.isDemo && (
        <p className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" />
          <span>
            <strong>Demo mode.</strong> There's no server connected yet, so accounts live on this
            device and passwords aren't checked. Don't use a real password here.
          </span>
        </p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Assignment breakdown — sub-tasks that live in the real to-do list  */
/* ------------------------------------------------------------------ */

function BreakdownPanel({ assignment, todos, onBreakdown, patchItem }) {
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState("essay");

  const mine = useMemo(
    () => (todos || []).filter((t) => t.parentId === assignment.id).sort((a, b) => (a.due || "") < (b.due || "") ? -1 : 1),
    [todos, assignment.id]
  );
  const stranded = useMemo(
    () => strandedSubTasks({ assignment, todos, today: localDay() }),
    [assignment, todos]
  );

  if (!assignment.due) return null;

  return (
    <div className="mt-2 border-t border-stone-100 pt-2">
      <button className="text-xs font-medium u-accent-deeptext u-focus" onClick={() => setOpen(!open)}>
        {mine.length > 0 ? `${mine.filter((t) => !t.done).length} of ${mine.length} steps left` : "Break this into steps"}
      </button>

      {stranded.length > 0 && (
        <div className="mt-1.5 rounded-lg bg-stone-50 px-2.5 py-2">
          <p className="text-xs text-stone-600">
            {stranded.length === 1 ? "A step is" : `${stranded.length} steps are`} scheduled after this is due.
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {stranded.map((sub) => (
              <li key={sub.id} className="flex items-center gap-2 text-xs">
                <span className="flex-1 truncate text-stone-600">{sub.text}</span>
                <span className="shrink-0 text-stone-400">{formatAU(sub.due)}</span>
                {/* Never rewritten automatically: the user edited this, so
                    moving it is their call. */}
                <button
                  className="shrink-0 underline u-focus"
                  onClick={() => patchItem("todos", sub.id, { due: assignment.due, edited: true })}
                >
                  move to {formatAU(assignment.due)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-2">
            <select className={inputCls + " w-auto"} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {BREAKDOWN_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <button className={btnPrimary} onClick={() => onBreakdown(assignment, templateId)}>
              {mine.length > 0 ? "Regenerate steps" : "Add steps to my to-do list"}
            </button>
          </div>
          {mine.length > 0 && (
            <>
              <ul className="mt-2 flex flex-col gap-1">
                {mine.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-xs">
                    <span className={`flex-1 truncate ${t.done ? "text-stone-400 line-through" : "text-stone-700"}`}>{t.text}</span>
                    {t.edited && <span className="shrink-0 text-stone-400">edited</span>}
                    <span className="shrink-0 text-stone-400">{t.due ? formatAU(t.due) : ""}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-stone-400">
                Regenerating leaves anything you've edited or ticked off exactly as it is.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Semester setup — the teaching calendar and the rounding rule       */
/* ------------------------------------------------------------------ */

function SemesterSetup({ settings, rounding, patchSettings }) {
  const breaks = settings.breaks || [];
  const first = breaks[0] || {};
  const rule = rounding || DEFAULT_ROUNDING;
  const inherited = !settings.rounding && rule !== DEFAULT_ROUNDING;

  const setBreak = (patch) => {
    const next = { ...first, ...patch };
    patchSettings({ breaks: next.from && next.to ? [next] : [] });
  };

  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Semester starts (week 1, Monday)</label>
          <input
            className={inputCls}
            type="date"
            value={settings.start || ""}
            onChange={(e) => patchSettings({ start: e.target.value })}
          />
          <p className="mt-1 text-xs text-stone-400">
            Optional. Without it, deadlines are labelled by date instead of teaching week.
          </p>
        </div>
        <div>
          <label className={labelCls}>Mid-semester break</label>
          <div className="flex gap-2">
            <input className={inputCls} type="date" value={first.from || ""} onChange={(e) => setBreak({ from: e.target.value })} aria-label="Break starts" />
            <input className={inputCls} type="date" value={first.to || ""} onChange={(e) => setBreak({ to: e.target.value })} aria-label="Break ends" />
          </div>
          <p className="mt-1 text-xs text-stone-400">
            Counting straight through a non-teaching week puts everything after it a week out.
          </p>
        </div>
      </div>

      <div className="mt-3 border-t border-stone-100 pt-3">
        <label className={labelCls}>How your university rounds the final mark</label>
        <div className="flex flex-wrap gap-2">
          {ROUNDING_RULES.map((r) => (
            <button
              key={r.id}
              onClick={() => patchSettings({ rounding: r.id })}
              className={`rounded-full px-3 py-1.5 text-xs font-medium u-focus ${
                r.id === rule ? "u-accent-bg text-white" : "border border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
              }`}
            >
              {r.label} <span className="opacity-70">({r.hint})</span>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-stone-400">
          This changes what you need. Check your unit outline if you're unsure — the default is the
          common case, and getting it wrong understates what you need by up to 1.7 marks.
          {inherited && " Carried over from your other semester."}
        </p>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Grades — weighted mark and the "what do I need" calculator         */
/* ------------------------------------------------------------------ */

const ASSESSMENT_KINDS = [
  { id: "assignment", label: "Assignment" },
  { id: "exam", label: "Exam" },
  { id: "quiz", label: "Quiz" },
  { id: "other", label: "Other" },
];

function Grades({ assessments, courses, addItem, patchItem, removeItem, focused, rule = DEFAULT_ROUNDING }) {
  const blank = { course: "", title: "", w: "", mark: "", kind: "assignment", due: "", hurdle: "" };
  const [form, setForm] = useState(blank);
  const [targets, setTargets] = useState({}); // course -> band code the student is aiming at

  const byCourse = useMemo(() => {
    const map = new Map();
    for (const a of assessments) {
      const key = a.course || "No course";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    }
    return map;
  }, [assessments]);

  const shown = [...byCourse.entries()].filter(([name]) => !focused || name === focused);

  const add = () => {
    const w = Number(form.w);
    if (!form.title.trim() || !Number.isFinite(w) || w <= 0) return;
    addItem("assessments", {
      id: uid(),
      course: form.course,
      title: form.title.trim(),
      w,
      // Absent, not zero: an unmarked assessment and one marked zero are
      // different things and must never be conflated.
      ...(form.mark === "" ? {} : { mark: Number(form.mark) }),
      kind: form.kind,
      ...(form.due ? { due: form.due } : {}),
      ...(form.hurdle === "" ? {} : { hurdle: Number(form.hurdle) }),
    });
    setForm({ ...blank, course: form.course, kind: form.kind });
  };

  return (
    <>
      <Card className="mb-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Course</label>
            <CourseSelect courses={courses} value={form.course} onChange={(v) => setForm({ ...form, course: v })} />
          </div>
          <div>
            <label className={labelCls}>What is it</label>
            <input className={inputCls} placeholder="Essay 1" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Worth (% of the unit)</label>
            <input className={inputCls} type="number" inputMode="decimal" placeholder="30" value={form.w} onChange={(e) => setForm({ ...form, w: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Your mark (%) — leave blank if not marked yet</label>
            <input className={inputCls} type="number" inputMode="decimal" placeholder="" value={form.mark} onChange={(e) => setForm({ ...form, mark: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Type</label>
            <select className={inputCls} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {ASSESSMENT_KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Due / exam date</label>
            <input className={inputCls} type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Hurdle minimum (%) — only if the unit has one</label>
            <input className={inputCls} type="number" inputMode="decimal" placeholder="e.g. 45" value={form.hurdle} onChange={(e) => setForm({ ...form, hurdle: e.target.value })} />
          </div>
        </div>
        <button className={`${btnPrimary} mt-3`} onClick={add} disabled={!form.title.trim() || !Number(form.w)}>
          <Plus size={16} /> Add assessment
        </button>
      </Card>

      {shown.length === 0 ? (
        <Card><Empty>Add your assessments from the unit outline and this works out what you need.</Empty></Card>
      ) : (
        shown.map(([course, list]) => (
          <CourseGrades
            key={course}
            course={course}
            list={list}
            target={targets[course]}
            rule={rule}
            onTarget={(code) => setTargets({ ...targets, [course]: code })}
            patchItem={patchItem}
            removeItem={removeItem}
          />
        ))
      )}
    </>
  );
}

function CourseGrades({ course, list, target, rule, onTarget, patchItem, removeItem }) {
  const summary = useMemo(() => summarise(list), [list]);
  const best = useMemo(() => bestReachableBand(list, rule), [list, rule]);
  const bandCode = target || best.code;
  const band = bandByCode(bandCode) || GRADE_BANDS[GRADE_BANDS.length - 1];
  const result = useMemo(() => requiredForBand(list, band.min, rule), [list, band, rule]);
  const sentence = describeRequirement(result, band.label);
  const hurdles = result.hurdles;

  return (
    <Card className="mb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <CourseChip name={course === "No course" ? "" : course} />
          <span className="font-medium text-stone-800">{course}</span>
        </span>
        <span className="text-sm text-stone-500">
          {summary.average === null ? "Nothing marked yet" : `${displayMark(summary.average)}% so far`}
          {summary.markedWeight > 0 && ` · ${summary.markedWeight}% of the unit marked`}
        </span>
      </div>

      <ul className="mb-3 flex flex-col gap-1">
        {list.map((a) => (
          <li key={a.id} className="flex items-center gap-2 rounded-lg border border-stone-100 px-3 py-2 text-sm">
            <span className="flex-1 truncate text-stone-800">
              {a.title}
              {a.kind === "exam" && <span className="ml-1.5 text-xs text-stone-400">exam</span>}
              {hurdleOf(a) !== null && <span className="ml-1.5 text-xs text-stone-400">hurdle {hurdleOf(a)}%</span>}
            </span>
            <span className="shrink-0 text-xs text-stone-500">{a.w}%</span>
            <input
              className="w-16 shrink-0 rounded border border-stone-200 px-2 py-1 text-right text-sm u-field"
              type="number"
              inputMode="decimal"
              placeholder="—"
              value={a.mark ?? ""}
              onChange={(e) =>
                patchItem("assessments", a.id, e.target.value === "" ? { mark: null } : { mark: Number(e.target.value) })
              }
              aria-label={`Mark for ${a.title}`}
            />
            <button className={iconBtn} onClick={() => removeItem("assessments", a.id)} aria-label={`Remove ${a.title}`}>
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>

      {summary.weightSum !== 100 && (
        <p className="mb-2 flex items-start gap-1.5 text-xs text-stone-500">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          Your weights add up to {summary.weightSum}%, not 100% — worth checking against the unit outline. Nothing is
          scaled, so the most you can finish on is {displayMark(summary.ceiling)}%.
        </p>
      )}

      <div className="rounded-xl u-accent-soft p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-stone-500">Aiming for</span>
          {GRADE_BANDS.map((b) => (
            <button
              key={b.code}
              onClick={() => onTarget(b.code)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium u-focus ${
                b.code === bandCode ? "u-accent-bg text-white" : "bg-white text-stone-600 hover:bg-stone-50"
              }`}
            >
              {b.code} {b.min}+
            </button>
          ))}
        </div>
        <p className="text-sm font-medium u-accent-deeptext">{sentence}</p>
        <p className="mt-1 text-xs text-stone-500">
          {rule === "truncate"
            ? `Final marks are rounded down, so you need a full ${band.min}% for ${band.label}.`
            : `Final marks are rounded to the nearest whole number, so ${band.min - 0.5}% is enough for ${band.label}.`}
        </p>
        {hurdles.failed.length > 0 && (
          <p className="mt-1.5 text-xs text-stone-600">
            {hurdles.failed.map((h) => `${h.title} is below its ${h.min}% hurdle`).join("; ")}.
          </p>
        )}
        {hurdles.pending.length > 0 && !result.hurdleBinds && (
          <p className="mt-1.5 text-xs text-stone-500">
            Still to clear: {hurdles.pending.map((h) => `${h.title} (${h.min}%)`).join(", ")}.
          </p>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Workload forecast — crunch weeks, derived from existing dates      */
/* ------------------------------------------------------------------ */

function WorkloadForecast({ assignments, assessments, calendar }) {
  const weeks = useMemo(
    () => forecastWorkload({ assignments, assessments, today: localDay() }),
    [assignments, assessments]
  );
  if (weeks.length === 0) {
    return <Card><Empty>Nothing due in the next six weeks. Add due dates and this fills in.</Empty></Card>;
  }
  return (
    <Card>
      <div className="flex flex-col gap-3">
        {weeks.map((w) => (
          <div key={w.weekStart} className={`rounded-xl border px-3 py-2 ${w.crunch ? "border-stone-300 bg-stone-50" : "border-stone-100"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-stone-800">{weekLabel(w.weekStart, calendar, formatAU)}</span>
              <span className="text-xs text-stone-500">
                {w.items.length} due{w.totalWeight > 0 && ` · ${w.totalWeight}% of your grade`}
              </span>
            </div>
            {w.crunch && (
              <p className="mt-1 text-xs font-medium u-accent-deeptext">
                Busy week — {w.items.length > 2 ? `${w.items.length} things land together` : "a lot of your grade lands here"}. Start early.
              </p>
            )}
            <ul className="mt-1.5 flex flex-col gap-1">
              {w.items.map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-sm">
                  <CourseChip name={i.course} />
                  <span className={`flex-1 truncate ${i.overdue ? "text-stone-500 line-through" : "text-stone-700"}`}>{i.title}</span>
                  <span className="shrink-0 text-xs text-stone-400">
                    {i.overdue ? "overdue" : formatAU(i.due)}
                    {i.weight ? ` · ${i.weight}%` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Exam countdown + a derived study plan                             */
/* ------------------------------------------------------------------ */

function ExamPlanner({ assessments, notes, addItem }) {
  const today = localDay();
  const exams = useMemo(() => examCountdowns(assessments, today), [assessments, today]);
  const [openId, setOpenId] = useState(null);

  if (exams.length === 0) {
    return <Card><Empty>Add an assessment with the type "Exam" and a date, and its countdown appears here.</Empty></Card>;
  }

  return (
    <Card>
      <div className="flex flex-col gap-2">
        {exams.map((e) => {
          const topics = topicsForCourse(notes, e.course);
          const plan = buildStudyPlan({ exam: e, topics, today });
          const open = openId === e.id;
          return (
            <div key={e.id} className="rounded-xl border border-stone-100 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <CourseChip name={e.course} />
                  <span className="font-medium text-stone-800">{e.title}</span>
                </span>
                <span className="text-sm text-stone-500">
                  {e.past ? `was ${Math.abs(e.days)} day${Math.abs(e.days) === 1 ? "" : "s"} ago` : e.today ? "today" : `${e.days} day${e.days === 1 ? "" : "s"} to go`}
                  {" · "}{formatAU(e.due)}
                </span>
              </div>
              {plan.length > 0 && (
                <>
                  <button className="mt-1 text-xs font-medium u-accent-deeptext u-focus" onClick={() => setOpenId(open ? null : e.id)}>
                    {open ? "Hide" : "Show"} a study plan ({plan.length} sessions across {topics.length} topic{topics.length === 1 ? "" : "s"})
                  </button>
                  {open && (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {plan.map((p) => (
                        <li key={p.day} className="flex items-center gap-2 text-sm">
                          <span className="w-20 shrink-0 text-xs text-stone-400">{formatAU(p.day)}</span>
                          <span className={`flex-1 ${p.review ? "font-medium text-stone-800" : "text-stone-700"}`}>{p.topic}</span>
                          <button
                            className="shrink-0 text-xs text-stone-500 underline u-focus"
                            onClick={() => addItem("events", { id: uid(), title: `Study: ${p.topic}`, course: e.course, date: p.day, start: "", end: "", location: "", repeat: "none" })}
                          >
                            add to calendar
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {plan.length === 0 && !e.past && (
                <p className="mt-1 text-xs text-stone-400">
                  {topics.length === 0 ? "Add study cards for this course and a plan appears here." : "No days left to plan."}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const TABS = [
  { id: "courses", label: "Courses", icon: BookOpen },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "planner", label: "Planner", icon: ClipboardList },
  { id: "todo", label: "To-do", icon: ListTodo },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "folders", label: "Folders", icon: Folder },
  { id: "study", label: "Study", icon: Brain },
  { id: "ai-notes", label: "AI Notes", icon: Mic },
  { id: "account", label: "Account", icon: UserRound },
];

/* Shown when the planner could not be written to this device.
   Deliberately not dismissible: the whole failure mode this exists to
   fix is one the user can't otherwise see, and dismissing it would put
   them back where they started. It clears itself when a save works. */
function SaveFailureBanner({ reason, bytes, signedIn }) {
  const { title, detail, severity } = describeSaveFailure({ reason, bytes, signedIn });
  const danger = severity === "danger";
  return (
    <div
      role="alert"
      className={`mb-4 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${
        danger ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-900"
      }`}
    >
      <TriangleAlert size={16} className="mt-0.5 flex-shrink-0" />
      <span className="min-w-0">
        <strong className="font-semibold">{title}</strong> {detail}
      </span>
    </div>
  );
}

/* Which build this device is actually running.

   Stamped into index.html by scripts/build-web.mjs and read back here.
   Worth the four lines: until this existed there was no way to answer
   "which version is this user on", which matters for any bug report and
   mattered immediately for proving that a stale-cache fix had landed.
   Reads "development" when unstamped, which is the case in the smoke
   test and when serving public/ directly. */
export function buildId() {
  if (typeof document === "undefined") return "development";
  const meta = document.querySelector('meta[name="build-id"]');
  const value = (meta && meta.getAttribute("content")) || "";
  return value && !value.startsWith("__") ? value : "development";
}

function BuildLine() {
  return (
    <p className="mt-4 text-center text-xs text-stone-400">
      Version <span className="font-mono">{buildId()}</span>
    </p>
  );
}

export default function PlannerApp() {
  const [data, setData] = useState(DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [tab, setTab] = useState("courses");
  const [themeOpen, setThemeOpen] = useState(false);
  const [focusedCourse, setFocusedCourse] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [session, setSession] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  // { reason, bytes } while the last local save failed, null once one succeeds.
  const [saveError, setSaveError] = useState(null);
  const dataRef = useRef(DEFAULT);
  const toggleFocus = (name) => setFocusedCourse((cur) => (cur === name ? null : name));
  const navRef = useRef(null);
  const [navScroll, setNavScroll] = useState({ left: false, right: false });

  const updateNavScroll = () => {
    const el = navRef.current;
    if (!el) return;
    setNavScroll({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  };
  useEffect(() => {
    const t = setTimeout(updateNavScroll, 60);
    window.addEventListener("resize", updateNavScroll);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", updateNavScroll);
    };
  }, []);
  const scrollNav = (dx) => navRef.current && navRef.current.scrollBy({ left: dx, behavior: "smooth" });

  // Load any saved data once on start
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const raw = await store.get(STORAGE_KEY);
      if (!cancelled && raw) {
        try {
          setData(normalizeData(JSON.parse(raw)));
        } catch (e) {
          /* ignore corrupt data */
        }
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* The one place the planner is written to this device.
     Every caller goes through here so a failure can never be reported
     by one path and swallowed by another. */
  const persist = async (next) => {
    const res = await store.set(STORAGE_KEY, JSON.stringify(next));
    setSaveError(res.ok ? null : { reason: res.reason, bytes: res.bytes });
    return res;
  };

  // Save whenever data changes (after the initial load)
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let t;
    setSaveState("saving");
    persist(data).then((res) => {
      if (cancelled) return;
      // "Saved" has to be earned. Claiming it after a failed write is
      // how the silent-quota bug stayed invisible for so long.
      if (!res.ok) return setSaveState("error");
      t = setTimeout(() => setSaveState("saved"), 300);
    });
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [data, loaded]);

  // Keep a live reference to the newest data so sync never pushes a stale copy.
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Restore an existing sign-in on startup
  useEffect(() => {
    let cancelled = false;
    backend
      .getSession()
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- sync ----
     Pull whatever the server has, merge it with what's on this device
     (newest edit wins, per item), save the result, then push it back. */
  const runSync = async (activeSession = session) => {
    if (!activeSession) return;
    setSyncing(true);
    setSyncError("");
    try {
      const remote = await backend.pull({ session: activeSession });
      const merged = purgeOldTombstones(mergeData(dataRef.current, remote));
      const stamped = {
        ...merged,
        meta: { ...(merged.meta || {}), lastSyncedAt: nowISO(), deviceId: getDeviceId() },
      };
      setData(stamped);
      dataRef.current = stamped;
      await persist(stamped);
      await backend.push({ session: activeSession, data: stamped });

      /* Both of these run only after the push has succeeded, and neither
         is allowed to fail the sync — the planner is already saved and
         pushed by this point, so a failure here is worth retrying next
         time rather than showing as "couldn't sync". */
      await migrateAiNotes(activeSession);
      await reconcile({
        supabaseClient: supabase,
        userId: activeSession.user.id,
        pages: allAiPages(dataRef.current),
        syncSucceeded: true,
        cache: noteCache,
      }).catch(() => {});
    } catch (e) {
      setSyncError(e.message || "Couldn't sync. Please try again.");
    } finally {
      setSyncing(false);
    }
  };

  /* Every AI note the planner knows about, tombstoned ones included —
     reconciliation works from the tombstones, so filtering them out here
     would leave it with nothing to act on. Flattened across semesters
     because `ai_notes` has no notion of one. */
  const allAiPages = (d) =>
    Object.values((d || {}).semesters || {}).flatMap((s) => ((s || {}).pages || []).filter(isAiNote));

  /* Move any note still carrying its content in the blob into its own
     row. Runs on every sync because that is when we know we have a
     session and a network, and because it must be safe to run again: an
     interrupted pass leaves the note in both places, and the upsert makes
     the retry a no-op.

     One at a time, deliberately. This is background work on a device that
     may be on a phone connection, and a burst of parallel writes is how
     you make the sync the user IS waiting for feel slow. */
  const migrateAiNotes = async (activeSession) => {
    if (!supabase || !activeSession) return;
    const d = dataRef.current || {};
    const pending = [];
    for (const [name, s] of Object.entries(d.semesters || {})) {
      for (const p of pagesNeedingMigration((s || {}).pages)) pending.push({ semester: name, page: p });
    }
    if (pending.length === 0) return;

    for (const { semester, page } of pending) {
      const { ok, stub } = await migrateNote({
        supabaseClient: supabase,
        userId: activeSession.user.id,
        page,
      });
      // A failure leaves the note whole in the blob and readable. Nothing
      // to report and nothing to undo -- the next sync tries again.
      if (!ok) continue;
      await noteCache.put(page.id, buildContent(page));
      setData((prev) => ({
        ...prev,
        semesters: {
          ...prev.semesters,
          [semester]: {
            ...prev.semesters[semester],
            pages: (prev.semesters[semester].pages || []).map((p) =>
              p.id === page.id ? { ...stub, updatedAt: nowISO() } : p
            ),
          },
        },
        meta: { ...(prev.meta || {}), updatedAt: nowISO() },
      }));
    }
  };

  const handleSignIn = async ({ email, password }) => {
    const s = await backend.signIn({ email, password });
    setSession(s);
    await runSync(s);
  };

  const handleSignUp = async ({ email, password }) => {
    const s = await backend.signUp({ email, password });
    setSession(s);
    await runSync(s);
  };

  /* Supabase fires PASSWORD_RECOVERY once it has processed a recovery
     token out of the URL -- which only happens because detectSessionInUrl
     is now on for http(s) origins (see sync.js). Listening for the event
     rather than parsing the hash ourselves means we never have to know
     the token format, and it fires after the session is genuinely
     established rather than merely present in the address bar. */
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecovering(true);
        // The recovery session IS a session, so the app should reflect
        // that rather than showing a signed-out shell behind the overlay.
        if (s) setSession({ user: { id: s.user.id, email: s.user.email }, token: s.access_token });
      }
    });
    return () => data && data.subscription && data.subscription.unsubscribe();
  }, []);

  const handleResetPassword = async ({ email }) => backend.resetPassword({ email });

  const handleSetPassword = async (password) => {
    await backend.updatePassword({ password });
    /* Sync straight away: the recovery session is a real one, and a
       student who has just proved they own the account should have their
       planner rather than an empty app behind the confirmation. */
    const s = await backend.getSession();
    if (s) {
      setSession(s);
      await runSync(s);
    }
  };

  const handleSignOut = async () => {
    await backend.signOut();
    /* Lecture content cached for offline reading is this account's, and
       a shared or family device is exactly where signing out is meant to
       mean something. The planner blob in localStorage is deliberately
       left alone -- that is the same "your planner works signed out"
       copy a brand-new user has -- but the AI note contents are not part
       of that promise and go. */
    await noteCache.purgeAll();
    setSession(null);
    setSyncError("");
  };

  /* Deleting the account. Order matters and is enforced in
     accountDeletion.js: the staged audio has to go while the session is
     still valid, because the RPC ends by deleting the auth user and
     every request after that fails.

     The local wipe happens only after the server confirms, so a failed
     deletion leaves the user with their planner intact rather than with
     an empty app and an account that still exists. */
  const handleDeleteAccount = async () => {
    await deleteAccount({ supabaseClient: supabase, session });
    await backend.signOut();
    await store.del(STORAGE_KEY);
    await noteCache.purgeAll();
    const empty = { ...DEFAULT, semesters: { "Semester 1": makeSemester(), "Semester 2": makeSemester() } };
    dataRef.current = empty;
    setData(empty);
    setSession(null);
    setSyncError("");
    setSaveError(null);
  };

  /* ---- automatic syncing ----
     So the planner is up to date without anyone pressing a button:
       - when the app starts (once signed in)
       - when you come back to the window / reopen the app
       - a few seconds after you stop making changes  */

  const syncRef = useRef(runSync);
  useEffect(() => {
    syncRef.current = runSync;
  });

  // On launch, and whenever the window regains focus
  useEffect(() => {
    if (!session || !loaded) return;

    syncRef.current(session);

    const onFocus = () => syncRef.current(session);
    const onVisible = () => {
      if (document.visibilityState === "visible") syncRef.current(session);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // Runs when the signed-in user changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session && session.user.id, loaded]);

  // A few seconds after edits stop, push them up
  const lastPushed = useRef(null);
  useEffect(() => {
    if (!session || !loaded) return;
    const stamp = (data.meta && data.meta.updatedAt) || null;
    if (!stamp || stamp === lastPushed.current) return;

    const t = setTimeout(() => {
      lastPushed.current = stamp;
      syncRef.current(session);
    }, 4000);
    return () => clearTimeout(t);
  }, [data, session, loaded]);

  // All content edits apply to the currently selected semester only.
  // Every change is timestamped so cross-device sync can tell which edit is newest.
  const updateSem = (updater) =>
    setData((d) => ({
      ...d,
      semesters: { ...d.semesters, [d.semester]: updater(d.semesters[d.semester]) },
      meta: { ...(d.meta || {}), updatedAt: nowISO() },
    }));
  const addItem = (key, item) =>
    updateSem((s) => ({ ...s, [key]: [...s[key], { ...item, updatedAt: nowISO() }] }));
  const patchItem = (key, id, patch) =>
    updateSem((s) => ({
      ...s,
      [key]: s[key].map((it) => (it.id === id ? { ...it, ...patch, updatedAt: nowISO() } : it)),
    }));
  // Deleting marks the item instead of dropping it. Without this record of the
  // deletion, another device would sync the item straight back.
  const tombstone = (key, id) =>
    updateSem((s) => ({
      ...s,
      [key]: s[key].map((it) =>
        it.id === id ? { ...it, deletedAt: nowISO(), updatedAt: nowISO() } : it
      ),
    }));

  /* An AI note whose content lives in `ai_notes` needs the row deleted
     too, and the ORDER is the point: the row goes first, and the
     tombstone only follows if that succeeded.

     Tombstoning first would be the ordinary shape and is wrong here. The
     stub would vanish from every device while the row -- the transcript
     and summary of a lecture -- stayed on the server, with nothing left
     pointing at it to ever clean it up. The privacy policy says notes in
     the planner are the student's until they delete them; a delete that
     leaves the content behind makes that untrue.

     Signed out, the row can't be reached, so the tombstone is taken
     locally and reconciliation finishes the job after the next sync. */
  const removeItem = (key, id) => {
    /* Read through dataRef rather than the `sem` memo below: that memo is
       declared later in this component, and a closure reaching backwards
       up the file for a `const` is how the temporal-dead-zone crash in
       CLAUDE.md happened. dataRef is also simply more current — a sync
       can land between render and click. */
    const d = dataRef.current || {};
    const pages = ((d.semesters && d.semesters[d.semester]) || {}).pages || [];
    const page = key === "pages" ? pages.find((p) => p.id === id) : null;
    if (!page || !isRemote(page)) return tombstone(key, id);

    deleteNote({ supabaseClient: session ? supabase : null, id, cache: noteCache }).then((res) => {
      if (res.tombstone) return tombstone(key, id);
      setSyncError("Couldn't delete that note from the server, so it hasn't been deleted here either. Try again.");
    });
  };

  /* One allowance read per app mount, shared by all four text features.
     A hook per feature would be four RLS reads on a screen that shows
     two of them. */
  const textAllowance = useTextAllowance(session);

  /* Store the ATTEMPT, never the questions -- see practice.js. Pruned on
     the way in, because this collection grows with use and
     purgeOldTombstones only runs on sync: a signed-out student would
     otherwise accumulate rows and their tombstones forever. */
  const recordPracticeAttempt = ({ cardIds, correctIds }) =>
    updateSem((sm) => ({
      ...sm,
      practiceAttempts: pruneAttempts(
        [...(sm.practiceAttempts || []), { ...buildAttempt({ cardIds, correctIds, at: nowISO(), uid }), updatedAt: nowISO() }],
        { now: nowISO() }
      ),
    }));

  /* A note the student wrote, summarised into the SAME shape a recorded
     lecture produces -- so it goes down the whole existing storage path
     (row first, then the stub; cache; reconciliation) rather than
     becoming a second kind of AI note with rules of its own.

     The original note is untouched. Summarising is additive: a student
     who dislikes the result deletes the new note and still has what they
     wrote, which is the only safe shape for something that reinterprets
     someone's coursework. */
  const summariseNote = async (sourcePage, result) => {
    const { pageItem, noteItems } = mapAiResultToItems({
      result: { summaryFailed: false, original: result, translated: null },
      course: (sourcePage && sourcePage.title) || "",
      week: "",
      language: null,
      uid,
      nowISO,
    });
    pageItem.title = `Summary of ${(sourcePage && sourcePage.title) || "a note"}`;

    let toStore = pageItem;
    if (supabase && session && session.user) {
      const { ok, stub } = await migrateNote({ supabaseClient: supabase, userId: session.user.id, page: pageItem });
      if (ok) {
        toStore = stub;
        await noteCache.put(pageItem.id, buildContent(pageItem));
      }
    }
    addItem("pages", toStore);
    noteItems.forEach((n) => addItem("notes", n));
  };

  /* Study bookkeeping.

     Both of these read the CURRENT collection inside the updater and
     increment it. Nothing is captured when a session starts: a sync can
     land mid-session (the app syncs on window focus, not just on the
     4-second debounce), and a cached copy written back afterwards would
     silently discard whatever the other device recorded. */

  const rateCard = (cardId, rating) =>
    updateSem((s) => {
      const day = localDay();
      const card = (s.notes || []).find((n) => n.id === cardId);
      // The card can be gone: deleted on another device and synced away
      // mid-session. Rating it must be a no-op rather than logging a
      // review of a card that no longer exists.
      if (!card || card.deletedAt) return s;
      const notes = (s.notes || []).map((n) =>
        n.id === cardId ? { ...n, srs: schedule(n, rating, day), updatedAt: nowISO() } : n
      );
      return {
        ...s,
        notes,
        studyStats: recordStudy(s.studyStats || [], {
          day,
          course: (card && card.course) || "",
          minutes: 0,
          cards: 1,
          now: nowISO(),
        }),
      };
    });

  const logStudyMinutes = (course, minutes) => {
    const mins = clampSessionMinutes(minutes);
    if (mins <= 0) return;
    updateSem((s) => ({
      ...s,
      studyStats: recordStudy(s.studyStats || [], {
        day: localDay(),
        course,
        minutes: mins,
        cards: 0,
        now: nowISO(),
      }),
    }));
  };

  /* Generate or regenerate an assignment's sub-tasks.

     Everything happens inside one updateSem so the decision is made
     against the CURRENT todos, not a copy captured when the panel
     rendered -- the same rule the study stats follow. reconcileBreakdown
     decides what to create, update, leave and tombstone; nothing the
     user has edited or completed is ever rewritten. */
  const applyBreakdown = (assignment, templateId) =>
    updateSem((s) => {
      const slots = buildBreakdown({ assignment, templateId, today: localDay() });
      const plan = reconcileBreakdown({ slots, existing: s.todos || [], parentId: assignment.id });
      const stamp = nowISO();

      let todos = (s.todos || []).map((t) => {
        const patch = plan.update.find((u) => u.id === t.id);
        if (patch) return { ...t, ...patch.patch, updatedAt: stamp };
        // Tombstoned, never removed: a hard delete comes back on the next sync.
        if (plan.tombstone.includes(t.id)) return { ...t, deletedAt: stamp, updatedAt: stamp };
        return t;
      });

      todos = todos.concat(
        plan.create.map((slot) => ({
          id: uid(),
          text: slot.text,
          done: false,
          course: slot.course,
          due: slot.due,
          parentId: slot.parentId,
          gen: slot.gen,
          slot: slot.slot,
          updatedAt: stamp,
        }))
      );

      return { ...s, todos };
    });

  const patchSettings = (patch) =>
    updateSem((s) => {
      const existing = (s.settings || []).find((x) => x && !x.deletedAt);
      const stamp = nowISO();
      if (existing) {
        return {
          ...s,
          settings: s.settings.map((x) => (x.id === existing.id ? { ...x, ...patch, updatedAt: stamp } : x)),
        };
      }
      return { ...s, settings: [...(s.settings || []), { id: uid(), ...patch, updatedAt: stamp }] };
    });

  const reset = () => {
    setData({ ...DEFAULT, semesters: { "Semester 1": makeSemester(), "Semester 2": makeSemester() } });
    store.del(STORAGE_KEY);
    setConfirmReset(false);
  };

  const deleteFolder = (folderId) =>
    updateSem((s) => ({
      ...s,
      folders: s.folders.map((f) =>
        f.id === folderId ? { ...f, deletedAt: nowISO(), updatedAt: nowISO() } : f
      ),
      pages: s.pages.map((p) =>
        p.folderId === folderId ? { ...p, folderId: null, updatedAt: nowISO() } : p
      ),
    }));

  const restoreBackup = (incoming, mode) => {
    setData((current) => {
      const next =
        mode === "replace"
          ? incoming
          : purgeOldTombstones(mergeData(current, incoming));
      const stamped = { ...next, meta: { ...(next.meta || {}), updatedAt: nowISO() } };
      dataRef.current = stamped;
      persist(stamped);
      return stamped;
    });
  };

  // What the UI works with: the active semester, minus anything deleted.
  const rawSem = data.semesters[data.semester] || makeSemester();
  const sem = useMemo(() => {
    const out = {};
    for (const key of COLLECTIONS) out[key] = live(rawSem[key]);
    return out;
  }, [rawSem]);

  /* The semester's settings row. One item, created on first edit, so an
     untouched semester carries nothing and every week label falls back
     to a date rather than a guessed number. */
  const settings = useMemo(() => (sem.settings || [])[0] || {}, [sem.settings]);

  /* The rounding rule carries across semesters; the calendar does not.
     Someone shouldn't re-pick their university's convention every
     semester, but copying start dates forward would date every deadline
     in the new semester wrongly. */
  const rounding = useMemo(() => {
    const others = [];
    for (const [name, other] of Object.entries(data.semesters || {})) {
      if (name === data.semester) continue;
      for (const row of other.settings || []) others.push(row);
    }
    return inheritedRounding(settings, others);
  }, [settings, data.semesters, data.semester]);

  const theme = THEMES[data.theme] || THEMES.teal;
  const focused = focusedCourse && sem.courses.some((c) => c.name === focusedCourse) ? focusedCourse : null;
  const themeVars = {
    "--accent": theme.accent,
    "--accent-deep": theme.accentDeep,
    "--accent-soft": theme.accentSoft,
    "--accent-deep-text": theme.accentDeepText,
  };

  return (
    <div style={themeVars} className="min-h-screen bg-stone-100 text-stone-800">
      <style>{`
        .u-accent-bg{background-color:var(--accent);}
        .u-accent-bg:hover{background-color:var(--accent-deep);}
        .u-accent-text{color:var(--accent);}
        .u-accent-soft{background-color:var(--accent-soft);}
        .u-accent-deeptext{color:var(--accent-deep-text);}
        .u-accent-border{border-color:var(--accent);}
        .u-hover-soft:hover{background-color:var(--accent-soft);}
        .u-hover-border:hover{border-color:var(--accent);}
        .u-focus:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
        .u-field:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);}
        .u-highlight{box-shadow:0 0 0 2px var(--accent);}
        .lined-paper{background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 27px,#d6d3d1 27px,#d6d3d1 28px);line-height:28px;background-attachment:local;}
        .no-scrollbar{scrollbar-width:none;}
        .no-scrollbar::-webkit-scrollbar{display:none;}
      `}</style>
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-stone-50/90 backdrop-blur">
        <div className="relative mx-auto max-w-2xl px-4">
          <div className="flex items-center gap-3 py-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl u-accent-bg text-white">
              <GraduationCap size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="font-serif text-xl font-semibold leading-none text-stone-800">University Planner</h1>
              <p className="mt-0.5 text-xs text-stone-500">
                {saveState === "error" ? (
                  <span className="inline-flex items-center gap-1 font-medium text-rose-600"><TriangleAlert size={11} /> Not saved on this device</span>
                ) : saveState === "saving" ? (
                  <span className="inline-flex items-center gap-1"><Save size={11} /> Saving…</span>
                ) : saveState === "saved" ? (
                  <span className="inline-flex items-center gap-1 u-accent-text"><Check size={11} /> Saved</span>
                ) : (
                  "Auto-saves on this device"
                )}
              </p>
            </div>
            <select
              className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-700 u-field"
              value={data.semester}
              onChange={(e) => { setData((d) => ({ ...d, semester: e.target.value })); setFocusedCourse(null); }}
            >
              <option>Semester 1</option>
              <option>Semester 2</option>
            </select>
            <button className={iconBtn} onClick={() => setThemeOpen((o) => !o)} aria-label="Colour theme">
              <Palette size={19} />
            </button>
          </div>

          {themeOpen && (
            <div className="absolute right-3 top-16 z-20 rounded-xl border border-stone-200 bg-white p-3 shadow-lg">
              <p className="mb-2 text-xs font-medium text-stone-500">Colour theme</p>
              <div className="grid grid-cols-4 gap-2">
                {Object.entries(THEMES).map(([key, t]) => (
                  <button
                    key={key}
                    onClick={() => { setData((d) => ({ ...d, theme: key })); setThemeOpen(false); }}
                    className="flex h-9 w-9 items-center justify-center rounded-full u-focus"
                    style={{ backgroundColor: t.accent }}
                    aria-label={t.label}
                  >
                    {data.theme === key && <Check size={15} className="text-white" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tab navigation with scroll controls */}
          <div className="relative">
            {navScroll.left && (
              <button onClick={() => scrollNav(-180)} aria-label="Scroll tabs left" className="absolute left-0 top-1 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-stone-600 shadow-sm u-focus">
                <ChevronLeft size={16} />
              </button>
            )}
            <nav ref={navRef} onScroll={updateNavScroll} className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-2">
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium u-focus transition-colors ${
                      active ? "u-accent-soft u-accent-deeptext" : "text-stone-500 hover:bg-stone-100"
                    }`}
                  >
                    <Icon size={15} /> {t.label}
                  </button>
                );
              })}
            </nav>
            {navScroll.right && (
              <button onClick={() => scrollNav(180)} aria-label="Scroll tabs right" className="absolute right-0 top-1 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-stone-600 shadow-sm u-focus">
                <ChevronRight size={16} />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-5">
        {/* A failed local save is invisible by nature, so it gets the most
            prominent spot in the app and stays until a save succeeds. */}
        {saveError && <SaveFailureBanner reason={saveError.reason} bytes={saveError.bytes} signedIn={!!session} />}
        {recovering && <PasswordRecovery onSet={handleSetPassword} onCancel={() => setRecovering(false)} />}

        {focused && (
          <div className="mb-4 flex items-center justify-between gap-2 rounded-xl u-accent-soft u-accent-deeptext px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <BookOpen size={15} /> Highlighting <strong>{focused}</strong> across your planner
            </span>
            <button onClick={() => setFocusedCourse(null)} className="rounded-full p-1 hover:bg-black/10 u-focus" aria-label="Clear highlight">
              <X size={15} />
            </button>
          </div>
        )}

        {tab === "courses" && (
          <>
            <Section icon={BookOpen} title="Courses" subtitle="Your units this semester">
              <Courses courses={sem.courses} addItem={addItem} removeItem={removeItem} focused={focused} onToggleFocus={toggleFocus} />
            </Section>
            <Section icon={CalendarClock} title="Semester setup" subtitle="Teaching weeks and how your marks are rounded">
              <SemesterSetup settings={settings} rounding={rounding} patchSettings={patchSettings} />
            </Section>
            <Section icon={Target} title="Grades" subtitle="What you've got, and what you still need">
              <Grades
                assessments={sem.assessments}
                courses={sem.courses}
                addItem={addItem}
                patchItem={patchItem}
                removeItem={removeItem}
                focused={focused}
                rule={rounding}
              />
            </Section>
          </>
        )}

        {tab === "calendar" && (
          <Section icon={CalendarDays} title="Calendar" subtitle="Class times and important dates (DD/MM/YYYY)">
            <Calendar events={sem.events} courses={sem.courses} addItem={addItem} patchItem={patchItem} removeItem={removeItem} focused={focused} />
          </Section>
        )}

        {tab === "planner" && (
          <>
            <Section icon={CalendarClock} title="What's coming" subtitle="Crunch weeks, from your due dates">
              <WorkloadForecast assignments={sem.assignments} assessments={sem.assessments} calendar={settings} />
            </Section>
            <Section icon={ClipboardList} title="Weekly reading planner" subtitle="Add as many weeks per course as you need">
              <Textbook textbook={sem.textbook} courses={sem.courses} addItem={addItem} patchItem={patchItem} removeItem={removeItem} focused={focused} />
            </Section>
            <Section icon={FileText} title="Assignments" subtitle="Editable, with due dates in DD/MM/YYYY">
              <Assignments
                assignments={sem.assignments}
                courses={sem.courses}
                addItem={addItem}
                patchItem={patchItem}
                removeItem={removeItem}
                focused={focused}
                todos={sem.todos}
                onBreakdown={applyBreakdown}
              />
            </Section>
          </>
        )}

        {tab === "todo" && (
          <Section icon={ListTodo} title="To-do list">
            <Todos todos={sem.todos} addItem={addItem} patchItem={patchItem} removeItem={removeItem} assignments={sem.assignments} />
          </Section>
        )}

        {tab === "notes" && (
          <Section icon={StickyNote} title="Notes" subtitle="Titled notes on lined or blank pages">
            <Notes pages={sem.pages} folders={sem.folders} addItem={addItem} patchItem={patchItem} removeItem={removeItem} session={session} textAllowance={textAllowance} onSummariseNote={summariseNote} />
          </Section>
        )}

        {tab === "folders" && (
          <Section icon={Folder} title="Folders" subtitle="Create colour-coded folders and browse their notes">
            <Folders pages={sem.pages} folders={sem.folders} addItem={addItem} patchItem={patchItem} removeItem={removeItem} onDeleteFolder={deleteFolder} />
          </Section>
        )}

        {tab === "study" && (
          <>
            <Section icon={Flame} title="Your studying" subtitle="Streaks, time and cards — this semester only">
              <StudyStats studyStats={sem.studyStats} />
            </Section>
            <Section icon={Timer} title="Study timer" subtitle="Track time against a course">
              {/* Keyed by semester so switching semesters tears the timer
                  down rather than letting it keep running and then commit
                  its minutes to the wrong semester. */}
              <StudyTimer key={data.semester} courses={sem.courses} onLog={logStudyMinutes} semester={data.semester} />
            </Section>
            <Section icon={StickyNote} title="Class notes" subtitle="These become your study cards">
              <ClassNotes notes={sem.notes} courses={sem.courses} addItem={addItem} patchItem={patchItem} removeItem={removeItem} focused={focused} />
            </Section>
            <Section icon={Brain} title="Study cards" subtitle="Review what's due, or drill a course">
              {/* Same reason: a half-finished session must not survive a
                  semester switch and rate cards that are no longer here. */}
              <StudyGame key={data.semester} notes={sem.notes} onRate={rateCard} session={session} textAllowance={textAllowance} />
            </Section>
            <Section icon={TrendingDown} title="Weak spots" subtitle="The cards you keep missing">
              <WeakSpots notes={sem.notes} />
              {/* Sits BELOW the existing panel and renders nothing when
                  there is nothing to explain, so the screen a student
                  already knows is unchanged until they have weak spots
                  worth reasoning about. */}
              {session && (
                <WeakSpotsExplain
                  session={session}
                  topics={weakTopics({ attempts: sem.practiceAttempts, cards: sem.notes })}
                  allowanceApi={textAllowance}
                />
              )}
            </Section>
            <Section icon={Sparkles} title="Practice questions" subtitle="Written from your own study cards">
              {session ? (
                <PracticePanel
                  session={session}
                  cards={sem.notes}
                  allowanceApi={textAllowance}
                  onRecordAttempt={recordPracticeAttempt}
                />
              ) : (
                <Card>
                  <Empty>Sign in to use the AI study features.</Empty>
                </Card>
              )}
            </Section>
            <Section icon={AlarmClock} title="Exams" subtitle="Countdown, and a plan for the time left">
              <ExamPlanner assessments={sem.assessments} notes={sem.notes} addItem={addItem} />
            </Section>
          </>
        )}

        {tab === "ai-notes" && (
          // AI notes are saved into the existing `pages`/`notes` collections
          // (below), so they ride along inside the single `planner_data`
          // JSON blob that syncs in full on every change (4-BACKEND-GUIDE.md).
          // They're bigger than manual notes — if sync ever gets noticeably
          // slower, splitting AI notes into their own table/row is the fix.
          <Section icon={Mic} title="AI lecture notes" subtitle="Record a lecture and get an AI-generated summary and study cards">
            <AiNotesPanel session={session} backend={backend} courses={sem.courses} folders={sem.folders} data={data} setData={setData} addItem={addItem} />
          </Section>
        )}

        {tab === "account" && (
          <Section icon={UserRound} title="Account" subtitle="Sync your planner across your devices">
            <BackupPanel data={data} onRestore={restoreBackup} session={session} />
            <AccountPanel
              session={session}
              syncing={syncing}
              syncError={syncError}
              lastSyncedAt={(data.meta && data.meta.lastSyncedAt) || null}
              onResetPassword={handleResetPassword}
              onSignIn={handleSignIn}
              onSignUp={handleSignUp}
              onSignOut={handleSignOut}
              onSync={() => runSync()}
              onDeleteAccount={handleDeleteAccount}
            />
            <BuildLine />
          </Section>
        )}

        <div className="mt-6 flex justify-center">
          {confirmReset ? (
            <div className="flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2">
              <span className="text-xs text-stone-500">Clear everything? This can't be undone.</span>
              <button className={btnGhost} onClick={() => setConfirmReset(false)}>Cancel</button>
              <button className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700 u-focus" onClick={reset}>
                <Trash2 size={13} /> Clear
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmReset(true)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-stone-400 hover:text-rose-600">
              <Trash2 size={13} /> Clear all data
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
