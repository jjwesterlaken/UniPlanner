import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  backend,
  mergeData,
  purgeOldTombstones,
  getDeviceId,
  nowISO,
  COLLECTIONS,
} from "./sync.js";
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
  Save,
  UserRound,
  LogOut,
  RefreshCw,
  CloudCheck,
  TriangleAlert,
} from "lucide-react";

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
  async set(key, val) {
    try {
      if (typeof window !== "undefined" && window.storage && window.storage.set) {
        await window.storage.set(key, val);
        return;
      }
    } catch (e) {
      /* fall through */
    }
    try {
      window.localStorage.setItem(key, val);
    } catch (e) {
      /* ignore */
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

function Todos({ todos, addItem, patchItem, removeItem }) {
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
                  onClick={() => patchItem("todos", t.id, { done: !t.done })}
                  className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border ${
                    t.done ? "u-accent-bg u-accent-border text-white" : "border-stone-300 bg-white u-hover-border"
                  }`}
                  aria-label={t.done ? "Mark not done" : "Mark done"}
                >
                  {t.done && <Check size={13} />}
                </button>
                <span className={`flex-1 text-sm ${t.done ? "text-stone-400 line-through" : "text-stone-800"}`}>{t.text}</span>
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
                      <span className="mt-0.5 flex-shrink-0 rounded-md bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-600">{e.week ? `Wk ${e.week}` : "—"}</span>
                      <div className="min-w-0 flex-1">
                        {e.pages ? <p className="text-sm font-medium text-stone-800">{e.pages}</p> : <p className="text-sm text-stone-400">No pages set</p>}
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

function Assignments({ assignments, courses, addItem, patchItem, removeItem, focused }) {
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
/*  Notes (free notebook pages with titles, lined or blank)           */
/* ------------------------------------------------------------------ */

/* ---- Shared note pieces ---- */

function PageTypeChooser({ onPick, onCancel }) {
  return (
    <div>
      <p className="mb-3 text-sm text-stone-500">Choose a page type for your new note.</p>
      <div className="grid grid-cols-2 gap-3">
        <button onClick={() => onPick("lined")} className="rounded-xl border border-stone-300 p-3 text-left u-hover-border u-hover-soft u-focus">
          <div className="mb-2 h-20 rounded-md border border-stone-200 lined-paper" />
          <span className="text-sm font-medium text-stone-800">Lined page</span>
        </button>
        <button onClick={() => onPick("blank")} className="rounded-xl border border-stone-300 p-3 text-left u-hover-border u-hover-soft u-focus">
          <div className="mb-2 h-20 rounded-md border border-stone-200 bg-white" />
          <span className="text-sm font-medium text-stone-800">Blank page</span>
        </button>
      </div>
      <div className="mt-3 flex justify-end">
        <button className={btnGhost} onClick={onCancel}>
          <X size={15} /> Cancel
        </button>
      </div>
    </div>
  );
}

function NoteEditor({ draft, setDraft, onSave, onCancel }) {
  return (
    <div className="space-y-3">
      <span className="inline-flex items-center gap-1.5 rounded-full u-accent-soft u-accent-deeptext px-2.5 py-1 text-xs font-medium capitalize">
        {draft.style} page
      </span>
      <div>
        <label className={labelCls}>Title</label>
        <input className={inputCls} spellCheck placeholder="Note title" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
      </div>
      <div>
        <label className={labelCls}>Note</label>
        <textarea
          className={`w-full rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-800 placeholder-stone-400 u-field ${draft.style === "lined" ? "lined-paper" : "bg-white"}`}
          rows={8}
          spellCheck
          placeholder="Start writing..."
          value={draft.body}
          onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onCancel}>
          <X size={15} /> Cancel
        </button>
        <button className={btnPrimary} onClick={onSave}>
          <Check size={15} /> Save note
        </button>
      </div>
    </div>
  );
}

function NoteRow({ p, folders, onEdit, onMove, onDelete }) {
  const [menu, setMenu] = useState(false);
  const f = folders.find((x) => x.id === p.folderId);
  return (
    <li className="rounded-xl border border-stone-200 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-stone-800">{p.title || <span className="text-stone-400">Untitled note</span>}</h3>
          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-stone-400">
            <span className="capitalize">{p.style} page</span>
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
          <button className={iconBtn} onClick={() => setMenu((m) => !m)} aria-label="More options">
            <MoreVertical size={15} />
          </button>
          {menu && (
            <div className="absolute right-0 top-9 z-20 w-52 rounded-xl border border-stone-200 bg-white p-2 shadow-lg">
              <p className="px-2 pb-1 pt-0.5 text-xs font-medium text-stone-500">Move to folder</p>
              {folders.length === 0 && <p className="px-2 py-1 text-xs text-stone-400">No folders yet. Create one in the Folders tab.</p>}
              <div className="max-h-48 overflow-y-auto">
                {folders.map((fo) => (
                  <button key={fo.id} onClick={() => { onMove(p.id, fo.id); setMenu(false); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-stone-700 hover:bg-stone-100">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: folderColor(fo.color).hex }} />
                    {fo.name}
                    {p.folderId === fo.id && <Check size={13} className="ml-auto text-stone-400" />}
                  </button>
                ))}
              </div>
              {p.folderId && (
                <button onClick={() => { onMove(p.id, null); setMenu(false); }} className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-stone-100 px-2 py-1.5 text-left text-sm text-stone-500 hover:bg-stone-100">
                  <X size={13} /> Remove from folder
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {p.body && <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-sm text-stone-600">{p.body}</p>}
    </li>
  );
}

/* ---- Notes tab: a flat list of all notes (folders live in their own tab) ---- */

function Notes({ pages, folders, addItem, patchItem, removeItem }) {
  const [draft, setDraft] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const isNew = draft && !draft.id;
  const showList = !draft && !choosing;

  const startWith = (style) => { setDraft({ title: "", body: "", style, folderId: null }); setChoosing(false); };
  const save = () => {
    if (isNew) addItem("pages", { id: uid(), title: draft.title, body: draft.body, style: draft.style, folderId: draft.folderId || null });
    else patchItem("pages", draft.id, { title: draft.title, body: draft.body, style: draft.style });
    setDraft(null);
  };

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
      {choosing && <PageTypeChooser onPick={startWith} onCancel={() => setChoosing(false)} />}
      {draft && <NoteEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setDraft(null)} />}
      {showList && pages.length === 0 && <Empty>No notes yet. Tap "New note" to add one.</Empty>}
      {showList && pages.length > 0 && (
        <ul className="mt-3 space-y-2">
          {pages.map((p) => (
            <NoteRow key={p.id} p={p} folders={folders} onEdit={(n) => setDraft({ ...n })} onMove={(id, folderId) => patchItem("pages", id, { folderId })} onDelete={(id) => removeItem("pages", id)} />
          ))}
        </ul>
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

  const saveFolder = () => {
    const name = (folderForm.name || "").trim() || "Untitled folder";
    if (folderForm.id) patchItem("folders", folderForm.id, { name, color: folderForm.color });
    else addItem("folders", { id: uid(), name, color: folderForm.color });
    setFolderForm(null);
  };
  const saveNote = () => { patchItem("pages", draft.id, { title: draft.title, body: draft.body, style: draft.style }); setDraft(null); };
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
                        <NoteRow key={p.id} p={p} folders={folders} onEdit={(n) => setDraft({ ...n })} onMove={(id, folderId) => patchItem("pages", id, { folderId })} onDelete={(id) => removeItem("pages", id)} />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
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

function StudyGame({ notes }) {
  const [selected, setSelected] = useState("");
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [mastered, setMastered] = useState(0);
  const [total, setTotal] = useState(0);
  const [reviews, setReviews] = useState(0);

  const coursesWithNotes = useMemo(() => {
    const counts = {};
    notes.forEach((n) => {
      const key = n.course || "No course";
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts);
  }, [notes]);

  const cardFront = (n) => n.term || (n.week ? `Week ${n.week}` : "Recall this note");
  const cardBack = (n) => n.content || "(No notes written for this card)";

  const start = (courseName) => {
    const deck = shuffle(notes.filter((n) => (n.course || "No course") === courseName));
    setSelected(courseName);
    setQueue(deck.slice(1));
    setCurrent(deck[0] || null);
    setTotal(deck.length);
    setMastered(0);
    setReviews(0);
    setRevealed(false);
  };

  const next = (got) => {
    if (got) setMastered((m) => m + 1);
    let q = queue;
    if (!got) {
      setReviews((r) => r + 1);
      q = [...queue, current];
    }
    setCurrent(q[0] || null);
    setQueue(q.slice(1));
    setRevealed(false);
  };

  const exit = () => {
    setSelected("");
    setCurrent(null);
    setQueue([]);
    setTotal(0);
    setMastered(0);
  };

  if (!selected) {
    return (
      <Card>
        {coursesWithNotes.length === 0 ? (
          <Empty>Add some class notes above first, then come back to study them.</Empty>
        ) : (
          <>
            <p className="mb-3 text-sm text-stone-500">Pick a course to study. Each note becomes a card; recall the answer, then mark how you went. Cards you miss come back around.</p>
            <div className="flex flex-col gap-2">
              {coursesWithNotes.map(([name, count]) => (
                <button key={name} onClick={() => start(name)} className="flex items-center justify-between rounded-xl border border-stone-200 px-4 py-3 text-left u-hover-border u-hover-soft u-focus">
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

  if (!current) {
    return (
      <Card className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full u-accent-soft u-accent-deeptext">
          <Check size={24} />
        </div>
        <h3 className="font-serif text-xl font-semibold text-stone-800">All cards mastered</h3>
        <p className="mt-1 text-sm text-stone-500">
          {total} card{total === 1 ? "" : "s"} in {selected}
          {reviews > 0 && ` · ${reviews} needed another look`}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <button className={btnGhost} onClick={exit}>Pick another course</button>
          <button className={btnPrimary} onClick={() => start(selected)}>
            <RotateCcw size={15} /> Study again
          </button>
        </div>
      </Card>
    );
  }

  const progress = total ? Math.round((mastered / total) * 100) : 0;
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm text-stone-500">
          <CourseChip name={selected === "No course" ? "" : selected} />
          {mastered} / {total} mastered
        </span>
        <button className={iconBtn} onClick={exit} aria-label="Exit study">
          <X size={18} />
        </button>
      </div>

      <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
        <div className="h-full rounded-full u-accent-bg transition-all" style={{ width: `${progress}%` }} />
      </div>

      <div className="rounded-2xl border border-stone-200 bg-stone-50 p-6 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-stone-400">{current.week ? `Week ${current.week}` : "Note"}</p>
        <p className="mt-2 text-lg font-medium text-stone-800">{cardFront(current)}</p>
        {revealed && (
          <div className="mt-4 border-t border-stone-200 pt-4">
            <p className="whitespace-pre-wrap text-left text-sm text-stone-700">{cardBack(current)}</p>
          </div>
        )}
      </div>

      {!revealed ? (
        <button className={`${btnPrimary} mt-4 w-full`} onClick={() => setRevealed(true)}>Show answer</button>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className={`${btnGhost} justify-center`} onClick={() => next(false)}>
            <RotateCcw size={15} /> Review again
          </button>
          <button className={`${btnPrimary} w-full`} onClick={() => next(true)}>
            <Check size={15} /> Got it
          </button>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Account + sync                                                    */
/* ------------------------------------------------------------------ */

function AccountPanel({ session, syncing, syncError, lastSyncedAt, onSignIn, onSignUp, onSignOut, onSync }) {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

      <button className={`${btnPrimary} mt-4 w-full`} onClick={submit} disabled={busy}>
        {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
      </button>

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

const TABS = [
  { id: "courses", label: "Courses", icon: BookOpen },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "planner", label: "Planner", icon: ClipboardList },
  { id: "todo", label: "To-do", icon: ListTodo },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "folders", label: "Folders", icon: Folder },
  { id: "study", label: "Study", icon: Brain },
  { id: "account", label: "Account", icon: UserRound },
];

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

  // Save whenever data changes (after the initial load)
  useEffect(() => {
    if (!loaded) return;
    setSaveState("saving");
    store.set(STORAGE_KEY, JSON.stringify(data));
    const t = setTimeout(() => setSaveState("saved"), 300);
    return () => clearTimeout(t);
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
      await store.set(STORAGE_KEY, JSON.stringify(stamped));
      await backend.push({ session: activeSession, data: stamped });
    } catch (e) {
      setSyncError(e.message || "Couldn't sync. Please try again.");
    } finally {
      setSyncing(false);
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

  const handleSignOut = async () => {
    await backend.signOut();
    setSession(null);
    setSyncError("");
  };

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
  const removeItem = (key, id) =>
    updateSem((s) => ({
      ...s,
      [key]: s[key].map((it) =>
        it.id === id ? { ...it, deletedAt: nowISO(), updatedAt: nowISO() } : it
      ),
    }));

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

  // What the UI works with: the active semester, minus anything deleted.
  const rawSem = data.semesters[data.semester] || makeSemester();
  const sem = useMemo(() => {
    const out = {};
    for (const key of COLLECTIONS) out[key] = live(rawSem[key]);
    return out;
  }, [rawSem]);

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
                {saveState === "saving" ? (
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
          <Section icon={BookOpen} title="Courses" subtitle="Your units this semester">
            <Courses courses={sem.courses} addItem={addItem} removeItem={removeItem} focused={focused} onToggleFocus={toggleFocus} />
          </Section>
        )}

        {tab === "calendar" && (
          <Section icon={CalendarDays} title="Calendar" subtitle="Class times and important dates (DD/MM/YYYY)">
            <Calendar events={sem.events} courses={sem.courses} addItem={addItem} patchItem={patchItem} removeItem={removeItem} focused={focused} />
          </Section>
        )}

        {tab === "planner" && (
          <>
            <Section icon={ClipboardList} title="Weekly reading planner" subtitle="Add as many weeks per course as you need">
              <Textbook textbook={sem.textbook} courses={sem.courses} addItem={addItem} patchItem={patchItem} removeItem={removeItem} focused={focused} />
            </Section>
            <Section icon={FileText} title="Assignments" subtitle="Editable, with due dates in DD/MM/YYYY">
              <Assignments assignments={sem.assignments} courses={sem.courses} addItem={addItem} patchItem={patchItem} removeItem={removeItem} focused={focused} />
            </Section>
          </>
        )}

        {tab === "todo" && (
          <Section icon={ListTodo} title="To-do list">
            <Todos todos={sem.todos} addItem={addItem} patchItem={patchItem} removeItem={removeItem} />
          </Section>
        )}

        {tab === "notes" && (
          <Section icon={StickyNote} title="Notes" subtitle="Titled notes on lined or blank pages">
            <Notes pages={sem.pages} folders={sem.folders} addItem={addItem} patchItem={patchItem} removeItem={removeItem} />
          </Section>
        )}

        {tab === "folders" && (
          <Section icon={Folder} title="Folders" subtitle="Create colour-coded folders and browse their notes">
            <Folders pages={sem.pages} folders={sem.folders} addItem={addItem} patchItem={patchItem} removeItem={removeItem} onDeleteFolder={deleteFolder} />
          </Section>
        )}

        {tab === "study" && (
          <>
            <Section icon={StickyNote} title="Class notes" subtitle="These become your study cards">
              <ClassNotes notes={sem.notes} courses={sem.courses} addItem={addItem} patchItem={patchItem} removeItem={removeItem} focused={focused} />
            </Section>
            <Section icon={Brain} title="Study cards" subtitle="Turn your class notes into a recall game">
              <StudyGame notes={sem.notes} />
            </Section>
          </>
        )}

        {tab === "account" && (
          <Section icon={UserRound} title="Account" subtitle="Sync your planner across your devices">
            <AccountPanel
              session={session}
              syncing={syncing}
              syncError={syncError}
              lastSyncedAt={(data.meta && data.meta.lastSyncedAt) || null}
              onSignIn={handleSignIn}
              onSignUp={handleSignUp}
              onSignOut={handleSignOut}
              onSync={() => runSync()}
            />
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
