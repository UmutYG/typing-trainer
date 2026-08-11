// IndexedDB persistence: model aggregates + per-line session records,
// with JSON export/import for backup.

import type { SerializedModel } from "./model";

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

const DB_NAME = "typing-trainer";
const DB_VERSION = 2; // v2 adds the "tests" store

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
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("sessions"))
        db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("tests"))
        db.createObjectStore("tests", { keyPath: "id", autoIncrement: true });
    };
    // fires when an older open connection (another tab) is holding the DB
    // and won't let the version upgrade proceed — without this the open
    // request just hangs forever with no error and no success
    req.onblocked = () => reject(new DbBlockedError());
    req.onsuccess = () => {
      // if a second tab opens *after* us and needs a future version, let it:
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

function tx<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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

export function saveModel(model: SerializedModel): Promise<IDBValidKey> {
  return tx("kv", "readwrite", (s) => s.put(model, "model"));
}

export function loadModel(): Promise<SerializedModel | undefined> {
  return tx("kv", "readonly", (s) => s.get("model") as IDBRequest<SerializedModel | undefined>);
}

export function addSession(rec: SessionRecord): Promise<IDBValidKey> {
  return tx("sessions", "readwrite", (s) => s.add(rec));
}

export function getSessions(): Promise<SessionRecord[]> {
  return tx("sessions", "readonly", (s) => s.getAll() as IDBRequest<SessionRecord[]>);
}

export async function exportAll(): Promise<string> {
  const [model, sessions] = await Promise.all([loadModel(), getSessions()]);
  return JSON.stringify({ exportedAt: new Date().toISOString(), model, sessions }, null, 2);
}

export async function importAll(json: string): Promise<void> {
  const data = JSON.parse(json) as {
    model?: SerializedModel;
    sessions?: SessionRecord[];
  };
  if (data.model) await saveModel(data.model);
  for (const s of data.sessions ?? []) {
    const { id: _id, ...rest } = s;
    await addSession(rest as SessionRecord);
  }
}
