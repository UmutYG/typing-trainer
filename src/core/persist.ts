// IndexedDB persistence: model aggregates + per-line session records,
// with JSON export/import for backup.

import type { SerializedModel } from "./model";
import type { GoalState } from "./goals";

export interface TestRecord {
  id?: number;
  time: number; // epoch ms
  wpm: number;
  accuracy: number;
  chars: number;
  errors: number;
  seconds: number;
}

export interface SessionRecord {
  id?: number;
  time: number; // epoch ms
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
    req.onsuccess = () => resolve(req.result);
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

export function addTest(rec: TestRecord): Promise<IDBValidKey> {
  return tx("tests", "readwrite", (s) => s.add(rec));
}

export function getTests(): Promise<TestRecord[]> {
  return tx("tests", "readonly", (s) => s.getAll() as IDBRequest<TestRecord[]>);
}

export function saveGoals(goals: GoalState): Promise<IDBValidKey> {
  return tx("kv", "readwrite", (s) => s.put(goals, "goals"));
}

export function loadGoals(): Promise<GoalState | undefined> {
  return tx("kv", "readonly", (s) => s.get("goals") as IDBRequest<GoalState | undefined>);
}

export async function exportAll(): Promise<string> {
  const [model, sessions, tests, goals] = await Promise.all([
    loadModel(),
    getSessions(),
    getTests(),
    loadGoals(),
  ]);
  return JSON.stringify({ exportedAt: new Date().toISOString(), model, sessions, tests, goals }, null, 2);
}

export async function importAll(json: string): Promise<void> {
  const data = JSON.parse(json) as {
    model?: SerializedModel;
    sessions?: SessionRecord[];
    tests?: TestRecord[];
    goals?: GoalState;
  };
  if (data.model) await saveModel(data.model);
  if (data.goals) await saveGoals(data.goals);
  for (const s of data.sessions ?? []) {
    const { id: _id, ...rest } = s;
    await addSession(rest as SessionRecord);
  }
  for (const t of data.tests ?? []) {
    const { id: _id, ...rest } = t;
    await addTest(rest as TestRecord);
  }
}
