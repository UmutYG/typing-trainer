// Storage, built so that shipping a new version of the app never costs you
// your history.
//
// Three rules hold everything together:
//   1. schema upgrades only ever ADD stores — nothing is dropped or recreated
//   2. a snapshot is taken before the first write of any new app version, and
//      the last few are kept, so a bad release can be walked back
//   3. nothing is ever silently reset: unreadable data is set aside under its
//      own key and the app carries on with whatever did load
//
// The skill model is the irreplaceable part (it is months of keystrokes) and is
// never trimmed. Per-line session rows are the bulky part and are folded into
// daily totals once they age out, so the trend and the practice clock survive.

import { MODEL_VERSION, type SerializedModel } from "./model";

export interface SessionRecord {
  id?: number;
  time: number; // epoch ms
  ms: number; // how long the line took, for time-practised
  wpm: number;
  accuracy: number;
  rolloverRate: number;
  consistency: number;
  chars: number;
  errors: number;
  targets: string[];
  mode: string;
}

/** one row per day, holding everything the trimmed session rows used to say */
export interface DayRecord {
  day: string; // YYYY-MM-DD
  lines: number;
  ms: number;
  chars: number;
  errors: number;
  wpmSum: number; // divide by lines for the day's average
}

interface Backup {
  id?: number;
  time: number;
  appVersion: number;
  model: SerializedModel | undefined;
  sessionCount: number;
}

const DB_NAME = "typing-trainer";

/**
 * Bump only when a new object store is needed. Existing stores are left
 * untouched by upgrades, so old data rides through.
 */
const DB_VERSION = 4;

/** keep this many raw per-line rows; older ones live on as daily totals */
const KEEP_SESSIONS = 4000;
const TRIM_TRIGGER = 5000; // only compact when it is clearly worth it
const KEEP_BACKUPS = 5;

export class DbBlockedError extends Error {
  constructor() {
    super("Another tab has this app open and is blocking an update. Close other tabs and reload.");
    this.name = "DbBlockedError";
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // additive only — never deleteObjectStore, never clear
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("sessions"))
        db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("tests"))
        db.createObjectStore("tests", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("backups"))
        db.createObjectStore("backups", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("days")) db.createObjectStore("days", { keyPath: "day" });
    };
    // fires when an older open connection (another tab) is holding the DB
    // and won't let the version upgrade proceed — without this the open
    // request just hangs forever with no error and no success
    req.onblocked = () => reject(new DbBlockedError());
    req.onsuccess = () => {
      // if a second tab opens later and needs a future version, let it:
      // close cleanly instead of blocking it forever in turn
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/* ---------------- model ---------------- */

export function saveModel(model: SerializedModel): Promise<IDBValidKey> {
  return tx("kv", "readwrite", (s) => s.put(model, "model"));
}

export function loadModel(): Promise<SerializedModel | undefined> {
  return tx("kv", "readonly", (s) => s.get("model") as IDBRequest<SerializedModel | undefined>);
}

/**
 * Sets aside data we could not read, under its own key, so a future version can
 * still recover it. Nothing is deleted.
 */
export function quarantine(key: string, value: unknown): Promise<IDBValidKey> {
  return tx("kv", "readwrite", (s) => s.put({ time: Date.now(), value }, `quarantine:${key}`));
}

/* ---------------- sessions & days ---------------- */

export function addSession(rec: SessionRecord): Promise<IDBValidKey> {
  return tx("sessions", "readwrite", (s) => s.add(rec));
}

export function getSessions(): Promise<SessionRecord[]> {
  return tx("sessions", "readonly", (s) => s.getAll() as IDBRequest<SessionRecord[]>);
}

export function getDays(): Promise<DayRecord[]> {
  return tx("days", "readonly", (s) => s.getAll() as IDBRequest<DayRecord[]>);
}

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Folds the oldest per-line rows into daily totals and drops the rows. Called
 * after a line is saved; does nothing until the table is genuinely large.
 */
export async function compactSessions(): Promise<number> {
  const all = await getSessions();
  if (all.length < TRIM_TRIGGER) return 0;
  const sorted = all.slice().sort((a, b) => a.time - b.time);
  const cutIndex = sorted.length - KEEP_SESSIONS;
  const older = sorted.slice(0, cutIndex);
  if (older.length === 0) return 0;

  const existing = new Map((await getDays()).map((d) => [d.day, d]));
  for (const s of older) {
    const day = dayKey(s.time);
    const d = existing.get(day) ?? { day, lines: 0, ms: 0, chars: 0, errors: 0, wpmSum: 0 };
    d.lines++;
    d.ms += s.ms;
    d.chars += s.chars;
    d.errors += s.errors;
    d.wpmSum += s.wpm;
    existing.set(day, d);
  }

  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(["days", "sessions"], "readwrite");
    const days = t.objectStore("days");
    for (const rec of existing.values()) days.put(rec);
    const sess = t.objectStore("sessions");
    // only remove rows we have safely folded in
    for (const s of older) if (s.id !== undefined) sess.delete(s.id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  return older.length;
}

/* ---------------- backups ---------------- */

export function getBackups(): Promise<Backup[]> {
  return tx("backups", "readonly", (s) => s.getAll() as IDBRequest<Backup[]>);
}

const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Snapshots the model before a new app version touches it, and again whenever
 * the newest snapshot has gone stale, so there is always a recent copy to fall
 * back to.
 *
 * Nothing is recorded until there is actually a model to save — otherwise the
 * very first run on an empty database would claim the version as "backed up"
 * and the first real data would never get a snapshot at all.
 */
let backupInFlight: Promise<boolean> | null = null;

/** Concurrent callers share one run, so a double mount cannot write twice. */
export function ensureBackup(): Promise<boolean> {
  if (!backupInFlight) {
    backupInFlight = runEnsureBackup().finally(() => {
      backupInFlight = null;
    });
  }
  return backupInFlight;
}

async function runEnsureBackup(): Promise<boolean> {
  const model = await loadModel();
  if (!model) return false;

  const stamp =
    (await tx("kv", "readonly", (s) => s.get("lastBackupVersion") as IDBRequest<number | undefined>)) ?? 0;
  const all = await getBackups();
  const newest = all.length > 0 ? Math.max(...all.map((b) => b.time)) : 0;
  const versionChanged = stamp !== MODEL_VERSION;
  const stale = Date.now() - newest > BACKUP_MAX_AGE_MS;
  if (!versionChanged && !stale) return false;

  const sessions = await getSessions();
  await tx("backups", "readwrite", (s) =>
    s.add({
      time: Date.now(),
      appVersion: MODEL_VERSION,
      model,
      sessionCount: sessions.length,
    } as Backup),
  );

  const after = await getBackups();
  const extra = after
    .sort((a, b) => a.time - b.time)
    .slice(0, Math.max(0, after.length - KEEP_BACKUPS));
  if (extra.length > 0) {
    const d = await db();
    await new Promise<void>((resolve) => {
      const t = d.transaction("backups", "readwrite");
      const store = t.objectStore("backups");
      for (const b of extra) if (b.id !== undefined) store.delete(b.id);
      t.oncomplete = () => resolve();
    });
  }

  await tx("kv", "readwrite", (s) => s.put(MODEL_VERSION, "lastBackupVersion"));
  return true;
}

/** The most recent snapshot, for recovering from a bad load. */
export async function latestBackup(): Promise<SerializedModel | undefined> {
  const all = await getBackups();
  if (all.length === 0) return undefined;
  return all.sort((a, b) => b.time - a.time)[0].model;
}

/* ---------------- export / import ---------------- */

export async function exportAll(): Promise<string> {
  const [model, sessions, days] = await Promise.all([loadModel(), getSessions(), getDays()]);
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), modelVersion: MODEL_VERSION, model, sessions, days },
    null,
    2,
  );
}

export async function importAll(json: string): Promise<void> {
  const data = JSON.parse(json) as {
    model?: SerializedModel;
    sessions?: SessionRecord[];
    days?: DayRecord[];
  };
  if (data.model) await saveModel(data.model);
  for (const s of data.sessions ?? []) {
    const { id: _id, ...rest } = s;
    await addSession(rest as SessionRecord);
  }
  for (const d of data.days ?? []) {
    await tx("days", "readwrite", (s) => s.put(d));
  }
}
