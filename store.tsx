import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import type { DB, User, ActivityLog } from "./types";
import { defaultDocumentFormats, seedDB } from "./seed";
import { defaultPermissionsForRole, normalizePermissions } from "./permissions";
import { fetchRemoteDB, saveRemoteDB } from "./supabaseState";
import { isSupabaseConfigured, supabase } from "./supabase";

const KEY = "amrest_erp_db_v1";
const SESSION_KEY = "amrest_erp_session";
const THEME_KEY = "amrest_theme";

function loadDB(): DB {
  return migrateDB(seedDB());
}

function migrateDB(db: DB): DB {
  const seeded = seedDB();
  const existingIds = new Set(db.users.map(u => u.id));
  const missingDepartmentUsers = seeded.users.filter(u => !existingIds.has(u.id));
  const users = [...db.users, ...missingDepartmentUsers].map(u => ({
    ...u,
    permissions: u.permissions ? normalizePermissions(u) : defaultPermissionsForRole(u.role),
  }));
  const seededDtrFormat = seeded.qcFormats.find(f => f.id === "qcf-dtr");
  const seededCtFormat = seeded.qcFormats.find(f => f.id === "qcf-ct");
  const seededPtFormat = seeded.qcFormats.find(f => f.id === "qcf-pt");
  const seededCtPtFormat = seeded.qcFormats.find(f => f.id === "qcf-oil");
  const qcFormats = db.qcFormats?.length ? db.qcFormats.map(format => {
    if (format.id === "qcf-dtr" && seededDtrFormat && !format.columns.some(c => c.id === "nllFreq")) return seededDtrFormat;
    if (format.id === "qcf-ct" && seededCtFormat && !format.columns.some(c => c.id === "sepHv")) return seededCtFormat;
    if (format.id === "qcf-pt" && seededPtFormat && !format.columns.some(c => c.id === "sepLv03")) return seededPtFormat;
    if (format.id === "qcf-oil" && seededCtPtFormat && format.name === "Oil Test Format") return seededCtPtFormat;
    return format;
  }) : (seeded.qcFormats || []);
  const seedFormats = seeded.settings.documentFormats || defaultDocumentFormats(new Date().toISOString());
  const existingFormats = db.settings?.documentFormats || [];
  const mergedDocumentFormats = [
    ...existingFormats,
    ...seedFormats.filter(sf => !existingFormats.some(ef => ef.documentType === sf.documentType)),
  ];
  return {
    ...db,
    leads: db.leads || [],
    ctCostings: db.ctCostings || [],
    materialIssues: db.materialIssues || [],
    productionEntries: db.productionEntries || [],
    serials: db.serials || [],
    qcTests: db.qcTests || [],
    qcFinalReports: db.qcFinalReports || [],
    qcFormats,
    users,
    settings: { ...seeded.settings, ...db.settings, documentFormats: mergedDocumentFormats },
  };
}

function loadLegacyLocalDB(): DB | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? migrateDB(JSON.parse(raw) as DB) : null;
  } catch {
    return null;
  }
}

interface Ctx {
  db: DB;
  setDB: (updater: (db: DB) => DB) => void;
  currentUser: User | null;
  login: (username: string, password: string) => { ok: boolean; msg?: string };
  logout: () => void;
  changePassword: (oldPwd: string, newPwd: string) => { ok: boolean; msg?: string };
  log: (action: string, module: string) => void;
  syncStatus: "syncing" | "connected" | "error" | "not-configured";
  syncError: string;
  syncNow: () => Promise<void>;
  theme: "light" | "dark";
  toggleTheme: () => void;
}

const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<DB>(() => loadDB());
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const id = localStorage.getItem(SESSION_KEY);
    if (!id) return null;
    const initial = loadDB();
    return initial.users.find(u => u.id === id) || null;
  });
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem(THEME_KEY) as any) || "light");
  const [syncStatus, setSyncStatus] = useState<Ctx["syncStatus"]>(() => isSupabaseConfigured ? "syncing" : "not-configured");
  const [syncError, setSyncError] = useState("");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function hydrateFromSupabase() {
      if (!isSupabaseConfigured) {
        setSyncStatus("not-configured");
        setSyncError("Supabase URL or anon key is missing.");
        return;
      }
      setSyncStatus("syncing");
      setSyncError("");
      try {
        const remote = await fetchRemoteDB();
        const next = migrateDB(remote || loadLegacyLocalDB() || seedDB());
        if (cancelled) return;
        setDb(next);
        if (!remote) await saveRemoteDB(next);
        setSyncStatus("connected");
        setSyncError("");
        const sessionId = localStorage.getItem(SESSION_KEY);
        if (sessionId) setCurrentUser(next.users.find(u => u.id === sessionId) || null);
      } catch (err: any) {
        console.error("Supabase data load failed", err);
        if (!cancelled) {
          setSyncStatus("error");
          setSyncError(err?.message || "Supabase data load failed");
        }
      }
    }

    hydrateFromSupabase();
    if (isSupabaseConfigured) {
      channel = supabase
        .channel("amrest-erp-state-realtime")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "erp_state", filter: "id=eq.amrest-main" },
          payload => {
            if (cancelled) return;
            const row = payload.new as { data?: DB } | null;
            if (!row?.data) return;
            const next = migrateDB(row.data);
            setDb(next);
            const sessionId = localStorage.getItem(SESSION_KEY);
            if (sessionId) setCurrentUser(next.users.find(u => u.id === sessionId) || null);
            setSyncStatus("connected");
            setSyncError("");
          }
        )
        .subscribe(status => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            setSyncStatus(prev => prev === "error" ? prev : "connected");
            setSyncError(prev => prev.includes("Realtime") ? "" : prev);
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setSyncStatus("error");
            setSyncError(`Realtime connection ${status.toLowerCase().replace("_", " ")}`);
          }
        });
    }

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  const persistRemote = useCallback(async (next: DB) => {
    if (!isSupabaseConfigured) {
      setSyncStatus("not-configured");
      setSyncError("Supabase URL or anon key is missing.");
      return;
    }
    setSyncStatus("syncing");
    try {
      await saveRemoteDB(next);
      setSyncStatus("connected");
      setSyncError("");
    } catch (err: any) {
      console.error("Supabase save failed", err);
      setSyncStatus("error");
      setSyncError(err?.message || "Supabase save failed");
    }
  }, []);

  const setDB = useCallback((updater: (db: DB) => DB) => {
    setDb(prev => {
      const next = updater(prev);
      persistRemote(next);
      return next;
    });
  }, [persistRemote]);

  const syncNow = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setSyncStatus("not-configured");
      setSyncError("Supabase URL or anon key is missing.");
      return;
    }
    setSyncStatus("syncing");
    try {
      const remote = await fetchRemoteDB();
      const next = migrateDB(remote || db);
      setDb(next);
      if (!remote) await saveRemoteDB(next);
      setSyncStatus("connected");
      setSyncError("");
    } catch (err: any) {
      console.error("Manual Supabase sync failed", err);
      setSyncStatus("error");
      setSyncError(err?.message || "Manual Supabase sync failed");
    }
  }, [db]);

  const log = useCallback((action: string, module: string) => {
    if (!currentUser) return;
    const entry: ActivityLog = {
      id: crypto.randomUUID(),
      userId: currentUser.id,
      action,
      module,
      timestamp: new Date().toISOString(),
    };
    setDb(prev => {
      const next = { ...prev, logs: [entry, ...prev.logs].slice(0, 500) };
      persistRemote(next);
      return next;
    });
  }, [currentUser, persistRemote]);

  const login = useCallback((username: string, password: string) => {
    const u = db.users.find(x => x.username.toLowerCase() === username.toLowerCase() && x.password === password);
    if (!u) return { ok: false, msg: "Invalid credentials" };
    if (!u.active) return { ok: false, msg: "User is deactivated" };
    setCurrentUser(u);
    localStorage.setItem(SESSION_KEY, u.id);
    const entry: ActivityLog = {
      id: crypto.randomUUID(), userId: u.id, action: "Logged in", module: "Auth", timestamp: new Date().toISOString(),
    };
    setDb(prev => {
      const next = { ...prev, logs: [entry, ...prev.logs].slice(0, 500) };
      persistRemote(next);
      return next;
    });
    return { ok: true };
  }, [db.users]);

  const logout = useCallback(() => {
    if (currentUser) {
      const entry: ActivityLog = {
        id: crypto.randomUUID(), userId: currentUser.id, action: "Logged out", module: "Auth", timestamp: new Date().toISOString(),
      };
      setDb(prev => {
        const next = { ...prev, logs: [entry, ...prev.logs].slice(0, 500) };
        persistRemote(next);
        return next;
      });
    }
    setCurrentUser(null);
    localStorage.removeItem(SESSION_KEY);
  }, [currentUser, persistRemote]);

  const changePassword = useCallback((oldPwd: string, newPwd: string) => {
    if (!currentUser) return { ok: false, msg: "Not logged in" };
    if (currentUser.password !== oldPwd) return { ok: false, msg: "Old password is incorrect" };
    setDB(prev => ({
      ...prev,
      users: prev.users.map(u => u.id === currentUser.id ? { ...u, password: newPwd } : u),
    }));
    setCurrentUser({ ...currentUser, password: newPwd });
    return { ok: true };
  }, [currentUser, setDB]);

  const toggleTheme = () => setTheme(t => t === "light" ? "dark" : "light");

  return (
    <StoreCtx.Provider value={{ db, setDB, currentUser, login, logout, changePassword, log, syncStatus, syncError, syncNow, theme, toggleTheme }}>
      {children}
    </StoreCtx.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore must be inside StoreProvider");
  return ctx;
}

export function uid() { return crypto.randomUUID(); }
