const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const ROOT = __dirname;
const USER_HOME = process.env.USERPROFILE || process.env.HOME;
const APP_DATA_DIR = process.env.PZ_MANAGER_DATA_DIR || path.join(process.env.APPDATA || USER_HOME, "PZLocalModManager");
const LOCAL_DATA_DIR = process.env.PZ_MANAGER_LOCAL_DIR || path.join(process.env.LOCALAPPDATA || APP_DATA_DIR, "PZLocalModManager");
const DEFAULT_CONFIG_PATH = path.join(ROOT, "config", "default-config.json");
const LEGACY_CONFIG_PATH = path.join(ROOT, "config", "server-config.json");
const CONFIG_PATH = path.join(APP_DATA_DIR, "server-config.json");
const PROFILE_STATE_DIR = path.join(APP_DATA_DIR, "profiles");
const RECOMMENDED_PATH = path.join(ROOT, "data", "recommended-mods.json");
const CHANGE_LOG_PATH = path.join(APP_DATA_DIR, "change-log.jsonl");
const WORKSHOP_CACHE_PATH = path.join(APP_DATA_DIR, "workshop-cache.sqlite");
const WORKSHOP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PORT = Number(process.env.PORT || 8787);
const STEAM_WORKSHOP_APP = "108600";
const SPECIAL_WORKSHOP_RULES = {
  commonSensePatch: {
    patchWorkshopId: "3667553980",
    patchModId: "FE_CommonSensePatch",
    requiredWorkshopId: "2875848298",
    requiredModId: "BB_CommonSense",
    requiredTitle: "Common Sense"
  }
};
const FALLBACK_STEAM_DIRS = [
  "C:\\Program Files (x86)\\Steam",
  "C:\\Program Files\\Steam"
];

let jobLog = [];
let activeJob = null;
let gameProcess = null;
let workshopCache = null;
let steamApiRateLimitedUntil = 0;

function log(line) {
  const stamp = new Date().toLocaleTimeString();
  jobLog.push(`[${stamp}] ${line}`);
  if (jobLog.length > 1000) jobLog = jobLog.slice(-1000);
  console.log(line);
}

function markSteamRateLimited(source = "Steam") {
  steamApiRateLimitedUntil = Date.now() + 30 * 60 * 1000;
  log(`${source} returned 429; using local cache/SteamCMD fallback for Workshop data`);
}

function isSteamRateLimited() {
  return Date.now() < steamApiRateLimitedUntil;
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readRegistryValue(key, name) {
  if (process.platform !== "win32") return "";
  const result = spawnSync("reg", ["query", key, "/v", name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "";
  const match = result.stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, "i"));
  return match ? match[1].trim() : "";
}

function detectSteamDir() {
  const registry = readRegistryValue("HKCU\\Software\\Valve\\Steam", "SteamPath") ||
    readRegistryValue("HKLM\\Software\\WOW6432Node\\Valve\\Steam", "InstallPath") ||
    readRegistryValue("HKLM\\Software\\Valve\\Steam", "InstallPath");
  const candidates = [
    registry ? registry.replace(/\//g, "\\") : "",
    ...FALLBACK_STEAM_DIRS
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0] || "";
}

function detectPzGameDir(steamDir = detectSteamDir()) {
  const candidate = steamDir ? path.join(steamDir, "steamapps", "common", "ProjectZomboid") : "";
  if (candidate && fs.existsSync(candidate)) return candidate;
  return candidate || "";
}

function defaultPzServerDir() {
  return path.join(USER_HOME, "Zomboid", "Server");
}

function defaultConfig() {
  const detectedSteamDir = detectSteamDir();
  const template = readJson(DEFAULT_CONFIG_PATH, {});
  return {
    serverName: "FriendsB42",
    publicName: "Friends B42 Server",
    mode: "host",
    adminPassword: "ChangeThisBeforeFirstRun",
    serverPassword: "",
    maxPlayers: 8,
    memoryMb: 8192,
    betaBranch: "unstable",
    steamDir: detectedSteamDir,
    pzGameDir: detectPzGameDir(detectedSteamDir),
    pzServerDir: defaultPzServerDir(),
    steamCmdDir: path.join(LOCAL_DATA_DIR, "steamcmd"),
    serverDir: path.join(LOCAL_DATA_DIR, "pz-dedicated"),
    defaultPort: 16261,
    udpPort: 16262,
    steamPort1: 8766,
    steamPort2: 8767,
    mapFolders: ["Muldraugh, KY"],
    disabledMapFolders: [],
    mods: [],
    unresolvedRequirements: [],
    notes: "",
    ...template
  };
}

function migrateLegacyConfig() {
  if (fs.existsSync(CONFIG_PATH)) return;
  if (!fs.existsSync(LEGACY_CONFIG_PATH)) return;
  const legacy = readJson(LEGACY_CONFIG_PATH, null);
  if (!legacy || !Array.isArray(legacy.mods) || !legacy.mods.length) return;
  writeJson(CONFIG_PATH, legacy);
}

function getWorkshopCache() {
  if (workshopCache) return workshopCache;
  fs.mkdirSync(path.dirname(WORKSHOP_CACHE_PATH), { recursive: true });
  workshopCache = new Database(WORKSHOP_CACHE_PATH);
  workshopCache.pragma("journal_mode = WAL");
  workshopCache.exec(`
    CREATE TABLE IF NOT EXISTS workshop_details (
      workshop_id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workshop_searches (
      cache_key TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);
  return workshopCache;
}

function readCache(table, keyField, key) {
  const row = getWorkshopCache()
    .prepare(`SELECT json, fetched_at FROM ${table} WHERE ${keyField} = ?`)
    .get(String(key));
  if (!row) return null;
  try {
    return {
      value: JSON.parse(row.json),
      fetchedAt: Number(row.fetched_at || 0),
      stale: Date.now() - Number(row.fetched_at || 0) > WORKSHOP_CACHE_TTL_MS
    };
  } catch {
    return null;
  }
}

function writeCache(table, keyField, key, value) {
  getWorkshopCache()
    .prepare(`INSERT INTO ${table} (${keyField}, json, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(${keyField}) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`)
    .run(String(key), JSON.stringify(value), Date.now());
}

function markCacheSource(value, source, cached) {
  if (!value || typeof value !== "object") return value;
  return { ...value, cache: { source, fetchedAt: cached?.fetchedAt || Date.now(), stale: Boolean(cached?.stale) } };
}

function fallbackWorkshopDetailFromLocalConfig(id) {
  const config = loadConfig();
  const mod = (config.mods || []).find(item => item.workshopId === String(id));
  if (!mod) return null;
  const preview = mod.workshopPreview || {};
  const thumb = preview.thumb || "";
  return {
    workshopId: String(id),
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`,
    title: preview.title || mod.title || `Workshop ${id}`,
    author: preview.author || "",
    description: mod.notes || "Steam is rate-limiting live details right now, so this preview is using locally cached mod-manager data.",
    tags: [],
    rating: preview.rating || null,
    modIds: mod.modIds || [],
    requiredWorkshopIds: [],
    mapFolders: mod.mapFolders || [],
    media: thumb ? [{ type: "image", url: thumb, thumb, label: "Cached preview" }] : []
  };
}

function addChange(action, details = {}) {
  fs.mkdirSync(path.dirname(CHANGE_LOG_PATH), { recursive: true });
  const entry = { at: new Date().toISOString(), action, details };
  fs.appendFileSync(CHANGE_LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  log(`${action}: ${Object.values(details).filter(Boolean).join(" | ")}`);
}

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readChanges(limit = 80) {
  if (!fs.existsSync(CHANGE_LOG_PATH)) return [];
  return fs.readFileSync(CHANGE_LOG_PATH, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { at: "", action: "Corrupt log line", details: { line } };
      }
    })
    .reverse();
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 4_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function ensureConfigShape(config) {
  const next = {
    ...defaultConfig(),
    ...config
  };
  next.steamDir = next.steamDir || detectSteamDir();
  next.pzGameDir = next.pzGameDir || detectPzGameDir(next.steamDir);
  next.pzServerDir = next.pzServerDir || defaultPzServerDir();
  next.steamCmdDir = next.steamCmdDir || path.join(LOCAL_DATA_DIR, "steamcmd");
  next.serverDir = next.serverDir || path.join(LOCAL_DATA_DIR, "pz-dedicated");
  next.mods = (next.mods || []).map((mod, index) => ({
    enabled: mod.enabled !== false,
    workshopId: String(mod.workshopId || "").trim(),
    title: mod.title || mod.name || mod.workshopId || "Untitled mod",
    modIds: mod.modIds || (mod.modId ? [mod.modId] : []),
    mapFolders: mod.mapFolders || [],
    loadOrder: Number.isFinite(mod.loadOrder) ? mod.loadOrder : index + 1,
    requiredMods: mod.requiredMods || [],
    configFiles: mod.configFiles || [],
    workshopPreview: mod.workshopPreview || null,
    workshopOnly: Boolean(mod.workshopOnly),
    skipWorkshopItem: Boolean(mod.skipWorkshopItem),
    notes: mod.notes || ""
  })).filter(mod => mod.workshopId || mod.modIds.length || mod.title);
  next.unresolvedRequirements = next.unresolvedRequirements || [];
  next.disabledMapFolders = next.disabledMapFolders || [];
  return next;
}

function loadConfig() {
  migrateLegacyConfig();
  return ensureConfigShape(readJson(CONFIG_PATH, {}));
}

function currentConfigRevision() {
  const current = readJson(CONFIG_PATH, {});
  return Number(current.revision || 0);
}

function saveConfig(config, reason = "Saved configuration", options = {}) {
  const currentRevision = currentConfigRevision();
  if (options.expectedRevision !== undefined && Number(options.expectedRevision || 0) !== currentRevision) {
    const error = new Error("This dashboard view is out of date. Reload the page and try again.");
    error.statusCode = 409;
    throw error;
  }
  const next = ensureConfigShape(config);
  next.revision = currentRevision + 1;
  writeJson(CONFIG_PATH, next);
  saveProfileState(next);
  addChange(reason, { server: next.serverName, mods: String(next.mods.length) });
  return next;
}

function profileStatePath(profileName) {
  const cleanName = String(profileName || "").trim().replace(/[\\/:*?"<>|]/g, "");
  return cleanName ? path.join(PROFILE_STATE_DIR, `${cleanName}.json`) : "";
}

function saveProfileState(config) {
  const file = profileStatePath(config.serverName);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, {
    serverName: config.serverName,
    publicName: config.publicName,
    disabledMapFolders: config.disabledMapFolders || [],
    unresolvedRequirements: config.unresolvedRequirements || [],
    mods: config.mods || []
  });
}

function readProfileState(profileName) {
  const file = profileStatePath(profileName);
  return file ? readJson(file, null) : null;
}

function configWithoutPreviewNoise(config) {
  const shaped = ensureConfigShape(config);
  return JSON.stringify({
    ...shaped,
    revision: 0,
    mods: (shaped.mods || []).map(mod => ({
      ...mod,
      workshopPreview: null,
      configFiles: (mod.configFiles || []).map(file => ({
        path: file.path,
        relativePath: file.relativePath,
        size: file.size,
        extension: file.extension
      }))
    }))
  });
}

function runPowershell(script, args = []) {
  if (activeJob) throw new Error("Another install/update job is already running.");
  const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args];
  log(`Starting: powershell ${psArgs.join(" ")}`);
  activeJob = spawn("powershell.exe", psArgs, { cwd: ROOT, windowsHide: true });
  activeJob.stdout.on("data", data => log(data.toString().trimEnd()));
  activeJob.stderr.on("data", data => log(data.toString().trimEnd()));
  activeJob.on("exit", code => {
    log(`Job exited with code ${code}`);
    activeJob = null;
  });
}

function escapeIniValue(value) {
  return String(value ?? "").replace(/\r?\n/g, " ");
}

function serverIniPath(config) {
  return path.join(config.pzServerDir || defaultPzServerDir(), `${config.serverName}.ini`);
}

function sandboxPath(config) {
  return path.join(config.pzServerDir || defaultPzServerDir(), `${config.serverName}_SandboxVars.lua`);
}

function spawnRegionsPath(config) {
  return path.join(config.pzServerDir || defaultPzServerDir(), `${config.serverName}_spawnregions.lua`);
}

function spawnPointsPath(config) {
  return path.join(config.pzServerDir || defaultPzServerDir(), `${config.serverName}_spawnpoints.lua`);
}

function profileRuntimeStatePaths(config) {
  const name = config.serverName;
  return [
    path.join(USER_HOME, "Zomboid", "db", `${name}.db`),
    path.join(USER_HOME, "Zomboid", "db", `${name}.db-journal`),
    path.join(USER_HOME, "Zomboid", `${name}.db`),
    path.join(USER_HOME, "Zomboid", `${name}.db-journal`),
    path.join(USER_HOME, "Zomboid", "Saves", "Multiplayer", name),
    path.join(USER_HOME, "Zomboid", "Saves", "Multiplayer", `${name}_player`)
  ];
}

function serverDbPath(config) {
  return path.join(USER_HOME, "Zomboid", "db", `${config.serverName}.db`);
}

function playersDbPath(config) {
  return path.join(USER_HOME, "Zomboid", "Saves", "Multiplayer", config.serverName, "players.db");
}

function fallbackServerRoles() {
  return [
    { id: 7, name: "admin" },
    { id: 6, name: "moderator" },
    { id: 5, name: "gm" },
    { id: 4, name: "observer" },
    { id: 3, name: "priority" },
    { id: 2, name: "user" },
    { id: 1, name: "banned" }
  ];
}

function readServerRoles(config) {
  const dbFile = serverDbPath(config);
  if (!fs.existsSync(dbFile)) return fallbackServerRoles();
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT id, name FROM role ORDER BY id DESC").all();
  } finally {
    db.close();
  }
}

function readKnownPlayers(config) {
  const roles = readServerRoles(config);
  const roleNames = new Map(roles.map(role => [Number(role.id), role.name]));
  const players = new Map();
  const profileDb = serverDbPath(config);
  const characterDb = playersDbPath(config);

  if (fs.existsSync(profileDb)) {
    const db = new Database(profileDb, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`
        SELECT w.id, w.world, w.username, w.role, w.authType, w.steamid, w.ownerid, w.displayName, r.name AS roleName
        FROM whitelist w
        LEFT JOIN role r ON r.id = w.role
        ORDER BY lower(w.username)
      `).all();
      for (const row of rows) {
        const key = String(row.username || "").toLowerCase();
        if (!key) continue;
        players.set(key, {
          source: "whitelist",
          id: row.id,
          username: row.username,
          displayName: row.displayName || row.username,
          characterName: "",
          world: row.world || "",
          role: row.role,
          roleName: row.roleName || roleNames.get(Number(row.role)) || "user",
          steamid: row.steamid ? String(row.steamid) : "",
          ownerid: row.ownerid ? String(row.ownerid) : "",
          authType: row.authType
        });
      }
    } finally {
      db.close();
    }
  }

  if (fs.existsSync(characterDb)) {
    const db = new Database(characterDb, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`
        SELECT username, name AS characterName, printf('%lld', steamid) AS steamid, x, y, z, isDead
        FROM networkPlayers
        WHERE username IS NOT NULL AND trim(username) <> ''
        ORDER BY lower(username)
      `).all();
      for (const row of rows) {
        const key = String(row.username || "").toLowerCase();
        if (!key) continue;
        const existing = players.get(key) || {
          source: "players",
          username: row.username,
          displayName: row.username,
          world: config.serverName,
          role: null,
          roleName: "not whitelisted",
          steamid: "",
          ownerid: "",
          authType: null
        };
        existing.characterName = row.characterName || existing.characterName || "";
        existing.steamid = row.steamid && row.steamid !== "0" ? String(row.steamid) : existing.steamid;
        existing.position = { x: row.x, y: row.y, z: row.z };
        existing.isDead = Boolean(row.isDead);
        players.set(key, existing);
      }
    } finally {
      db.close();
    }
  }

  return {
    profileDb,
    playersDb: characterDb,
    roles,
    players: [...players.values()].sort((a, b) => String(a.username).localeCompare(String(b.username)))
  };
}

function detectPlayerSteamId(config, username) {
  const characterDb = playersDbPath(config);
  if (!fs.existsSync(characterDb)) return "";
  const db = new Database(characterDb, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`
      SELECT printf('%lld', steamid) AS steamid
      FROM networkPlayers
      WHERE lower(username) = lower(?)
      ORDER BY rowid DESC
      LIMIT 1
    `).get(username);
    return row?.steamid && row.steamid !== "0" ? String(row.steamid) : "";
  } finally {
    db.close();
  }
}

function setPlayerAccess(config, username, roleName) {
  const cleanUsername = String(username || "").trim();
  const cleanRole = String(roleName || "").trim().toLowerCase();
  if (!cleanUsername) throw new Error("Enter a player username.");

  const profileDb = serverDbPath(config);
  if (!fs.existsSync(profileDb)) {
    throw new Error(`The server database does not exist yet: ${profileDb}. Host the profile once, then set access levels.`);
  }

  const db = new Database(profileDb, { fileMustExist: true });
  try {
    const role = db.prepare("SELECT id, name FROM role WHERE lower(name) = lower(?)").get(cleanRole);
    if (!role) {
      const allowed = db.prepare("SELECT name FROM role ORDER BY id DESC").all().map(item => item.name).join(", ");
      throw new Error(`Unknown access level "${roleName}". Use one of: ${allowed}.`);
    }

    const existing = db.prepare("SELECT * FROM whitelist WHERE lower(username) = lower(?) ORDER BY id DESC LIMIT 1").get(cleanUsername);
    const steamid = String(existing?.steamid || detectPlayerSteamId(config, cleanUsername) || "");
    const world = existing?.world || config.serverName || "";
    const authType = existing?.authType ?? (steamid ? 2 : 1);
    const displayName = existing?.displayName || cleanUsername;

    if (existing) {
      db.prepare(`
        UPDATE whitelist
        SET world = ?, role = ?, authType = ?, steamid = ?, displayName = ?
        WHERE id = ?
      `).run(world, role.id, authType, steamid, displayName, existing.id);
    } else {
      db.prepare(`
        INSERT INTO whitelist (world, username, password, lastConnection, role, authType, googleKey, steamid, ownerid, displayName)
        VALUES (?, ?, NULL, NULL, ?, ?, NULL, ?, NULL, ?)
      `).run(world, cleanUsername, role.id, authType, steamid, displayName);
    }

    addChange("Updated player access", {
      server: config.serverName,
      username: cleanUsername,
      role: role.name,
      steamid
    });
    return { username: cleanUsername, role: role.name };
  } finally {
    db.close();
  }
}

function latestServerLogText() {
  return [jobLog.slice(-1000).join("\n"), latestProjectZomboidLogText()].filter(Boolean).join("\n");
}

function latestProjectZomboidLogText() {
  const logDir = path.join(USER_HOME, "Zomboid", "Logs");
  if (!fs.existsSync(logDir)) return "";
  const files = fs.readdirSync(logDir)
    .filter(file => /_DebugLog.*\.txt$/i.test(file))
    .map(file => {
      const fullPath = path.join(logDir, file);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 3);
  return files.map(file => {
    const text = fs.readFileSync(file.fullPath, "utf8");
    return text.split(/\r?\n/).slice(-1200).join("\n");
  }).join("\n");
}

function parseWorkshopDownloadState(text) {
  const states = new Map();
  for (const match of String(text || "").matchAll(/Workshop:\s+download\s+(\d+)\/(\d+)\s+ID=(\d+)/gi)) {
    states.set(match[3], { downloaded: Number(match[1]), total: Number(match[2]) });
  }
  return [...states.entries()].map(([workshopId, state]) => ({ workshopId, ...state }));
}

function diagnoseServerLog(text, config = null) {
  const issues = [];
  if (/whitelist_new.*already exists|no such table: role|ServerWorldDatabase|SQLITE_ERROR/i.test(text)) {
    issues.push({
      code: "server-db-corrupt",
      level: "repairable",
      title: "Server database is corrupt or incompatible",
      details: "Project Zomboid reached Workshop loading, then failed while creating/loading the selected server database."
    });
  }
  const stuckDownloads = parseWorkshopDownloadState(text).filter(item => item.downloaded === 0 && item.total === 0);
  const deletedWorkshopFolders = [...new Set([...String(text || "").matchAll(/not removing install folder because it does not exist\s*:\s*"([^"]*?\\108600\\(\d+))"/gi)]
    .map(match => match[2]))];
  if (stuckDownloads.length || /Install library folder not found|Staging library folder not found/i.test(text)) {
    issues.push({
      code: "steam-workshop-download-delay",
      level: "watch",
      title: "Steam Workshop download delay",
      details: (stuckDownloads.length || deletedWorkshopFolders.length)
        ? `Steam reported 0/0 or missing install folders for Workshop ${[...new Set([...stuckDownloads.map(item => item.workshopId), ...deletedWorkshopFolders])].join(", ")}. The manager can pre-sync installed Workshop files into the Host/Dedicated launch folders.`
        : "Steam reported library staging warnings. The manager can pre-sync installed Workshop files into the Host/Dedicated launch folders.",
      workshopIds: [...new Set([...stuckDownloads.map(item => item.workshopId), ...deletedWorkshopFolders])]
    });
  }
  const staleManifestIds = [...new Set([...String(text || "").matchAll(/timeUpdated doesn't match[\s\S]{0,500}?ID=(\d+)|ID=(\d+)[\s\S]{0,500}?timeUpdated doesn't match/gi)]
    .map(match => match[1] || match[2])
    .filter(Boolean))];
  if (staleManifestIds.length || /ulManifestID != k_GIDNil|depotID != k_uDepotIdInvalid/i.test(text)) {
    issues.push({
      code: "steam-workshop-manifest-mismatch",
      level: "repairable",
      title: "Steam Workshop manifest mismatch",
      details: staleManifestIds.length
        ? `Steam rejected local Workshop metadata for ${staleManifestIds.join(", ")}. The manager will rebuild launch Workshop folders and manifests from the active profile.`
        : "Steam rejected local Workshop metadata. The manager will rebuild launch Workshop folders and manifests from the active profile.",
      workshopIds: staleManifestIds
    });
  }
  const skippedWorkshopIds = new Set((config?.mods || [])
    .filter(mod => mod.skipWorkshopItem)
    .map(mod => String(mod.workshopId || ""))
    .filter(Boolean));
  const subscribeFailedIds = [...new Set([...String(text || "").matchAll(/onItemNotSubscribed\s+itemID=(\d+)\s+result=(\d+)/gi)]
    .map(match => match[1]))]
    .filter(workshopId => !skippedWorkshopIds.has(workshopId));
  if (subscribeFailedIds.length) {
    issues.push({
      code: "steam-subscribe-failed",
      level: "repairable",
      title: "Steam failed to subscribe to a Workshop item",
      details: `Steam refused the client subscription/install step for Workshop ${subscribeFailedIds.join(", ")}. Legacy collection-only items should not be written to WorkshopItems because Project Zomboid tries to subscribe to them even though they do not expose a loadable Mod ID.`,
      workshopIds: subscribeFailedIds
    });
  }
  const duplicateLotHeaders = [...new Set([...String(text || "").matchAll(/duplicate RoomDef\.metaID[\s\S]*?filename=([0-9]+_[0-9]+\.lotheader)/gi)]
    .map(match => match[1]))];
  if (duplicateLotHeaders.length) {
    issues.push({
      code: "duplicate-map-roomdef",
      level: "repairable",
      title: "Duplicate map room metadata",
      details: `Map folders are colliding on ${duplicateLotHeaders.join(", ")}. The manager can remove the offending map folders from the profile Map line.`,
      lotHeaders: duplicateLotHeaders
    });
  }
  return issues;
}

function activeMapFolderSet(config) {
  return new Set([
    ...(config.mapFolders || []),
    ...sortedEnabledMods(config).flatMap(mod => mod.mapFolders || [])
  ].filter(Boolean));
}

function findMapFoldersForLotHeaders(config, lotHeaders) {
  const headers = new Set(lotHeaders || []);
  const activeFolders = activeMapFolderSet(config);
  const matches = new Set();
  function walk(dir, depth = 0) {
    if (depth > 7 || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (headers.has(name)) {
        const normalized = full.replace(/\\/g, "/");
        const folder = (normalized.match(/\/media\/maps\/([^/]+)\//i) || [])[1];
        if (folder && activeFolders.has(folder) && folder !== "Muldraugh, KY") matches.add(folder);
      }
    }
  }

  for (const mod of sortedEnabledMods(config)) {
    if (!mod.workshopId) continue;
    for (const root of workshopRoots(config)) {
      const itemRoot = path.join(root, mod.workshopId);
      if (fs.existsSync(itemRoot)) walk(itemRoot);
    }
  }
  return [...matches];
}

function quarantinePath(target, backupRoot) {
  if (!fs.existsSync(target)) return null;
  fs.mkdirSync(backupRoot, { recursive: true });
  const relativeName = path.relative(path.join(USER_HOME, "Zomboid"), target)
    .replace(/^[.\\/]+/, "")
    .replace(/[\\/]/g, "__");
  let destination = path.join(backupRoot, relativeName || path.basename(target));
  if (fs.existsSync(destination)) {
    const parsed = path.parse(destination);
    destination = path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
  }
  fs.renameSync(target, destination);
  return destination;
}

function repairServerIssues(config, issues, reason = "server repair") {
  const actions = [];
  if (issues.some(issue => issue.code === "steam-workshop-manifest-mismatch")) {
    const sync = syncWorkshopItemsToLaunchFolders(config);
    actions.push({
      level: sync.missing.length ? "blocked" : "fixed",
      code: "steam-workshop-manifest-mismatch",
      title: sync.missing.length ? "Workshop files are still missing" : "Rebuilt Workshop launch metadata",
      details: sync.missing.length
        ? `Missing: ${sync.missing.map(item => `${item.workshopId} (${item.target})`).join(", ")}`
        : `Synced ${sync.copied.length} Workshop folder(s) and rewrote Steam manifest files for Host/Dedicated launch folders.`
    });
    addChange("Rebuilt Workshop launch metadata", { server: config.serverName, reason, copied: String(sync.copied.length), missing: String(sync.missing.length) });
  }
  const subscribeIssue = issues.find(issue => issue.code === "steam-subscribe-failed");
  if (subscribeIssue) {
    for (const workshopId of subscribeIssue.workshopIds || []) {
      const mod = (config.mods || []).find(item => item.workshopId === workshopId);
      if (!mod) {
        actions.push({
          level: "blocked",
          code: "steam-subscribe-failed",
          title: `Steam subscribe failed for unknown Workshop ${workshopId}`,
          details: "This item is not in the active manager config, so no automatic profile edit was made.",
          workshopId
        });
        continue;
      }
      const inspected = inspectWorkshopItem(config, workshopId);
      if (inspected.legacyOnly || (mod.workshopOnly && !(mod.modIds || []).length && !(mod.mapFolders || []).length)) {
        mod.workshopOnly = true;
        mod.skipWorkshopItem = true;
        mod.modIds = [];
        mod.mapFolders = [];
        mod.requiredMods = [];
        const oldNote = "Workshop-only legacy dependency; keep in WorkshopItems, no internal Mod ID needed.";
        mod.notes = (mod.notes || "").replace(oldNote, "").replace(/\n{3,}/g, "\n\n").trim();
        const note = "Steam subscribe failed for this legacy collection/dependency, so the manager skips it from WorkshopItems.";
        if (!(mod.notes || "").includes(note)) mod.notes = [mod.notes, note].filter(Boolean).join("\n");
        actions.push({
          level: "fixed",
          code: "steam-subscribe-failed",
          title: `Removed legacy Workshop ${workshopId} from WorkshopItems`,
          details: `${mod.title} has no loadable Mod ID, so keeping it in WorkshopItems makes Project Zomboid ask Steam to subscribe to a non-loadable dependency and can stall the Host screen.`,
          workshopId
        });
      } else {
        actions.push({
          level: "blocked",
          code: "steam-subscribe-failed",
          title: `Steam could not subscribe to ${mod.title}`,
          details: "This item appears to contain a real mod, so the manager left it active. Subscribe/update it in Steam or sync it with SteamCMD, then run the test again.",
          workshopId
        });
      }
    }
    addChange("Repaired Steam Workshop subscribe failure", {
      server: config.serverName,
      workshopIds: (subscribeIssue.workshopIds || []).join(";")
    });
  }
  if (issues.some(issue => issue.code === "server-db-corrupt")) {
    const backupRoot = path.join(USER_HOME, "Zomboid", "mod-manager-backups", `${config.serverName}-${safeStamp()}`);
    for (const target of profileRuntimeStatePaths(config)) {
      const movedTo = quarantinePath(target, backupRoot);
      if (movedTo) {
        actions.push({
          level: "fixed",
          code: "server-db-corrupt",
          title: `Quarantined stale server state: ${path.basename(target)}`,
          details: `${target} -> ${movedTo}`,
          file: target,
          backup: movedTo
        });
      }
    }
    if (!actions.some(action => action.code === "server-db-corrupt")) {
      actions.push({
        level: "watch",
        code: "server-db-corrupt",
        title: "No server runtime database files were present",
        details: "The next start will create fresh runtime state."
      });
    }
    addChange("Repaired corrupt server runtime database", { server: config.serverName, reason, backup: backupRoot });
  }
  const duplicateIssue = issues.find(issue => issue.code === "duplicate-map-roomdef");
  if (duplicateIssue) {
    const folders = findMapFoldersForLotHeaders(config, duplicateIssue.lotHeaders || []);
    for (const folder of folders) {
      config.disabledMapFolders = [...new Set([...(config.disabledMapFolders || []), folder])];
      config.mapFolders = (config.mapFolders || []).filter(item => item !== folder);
      for (const mod of config.mods || []) mod.mapFolders = (mod.mapFolders || []).filter(item => item !== folder);
      actions.push({
        level: "fixed",
        code: "duplicate-map-roomdef",
        title: `Removed conflicting map folder: ${folder}`,
        details: "The map folder produced duplicate RoomDef.metaID errors during boot, so it was removed from the active Map line."
      });
    }
    if (folders.length) {
      addChange("Removed conflicting map folders", { server: config.serverName, maps: folders.join(";") });
    }
  }
  return actions;
}

function repairLastServerFailure(config, reason = "last server failure") {
  const issues = diagnoseServerLog(latestServerLogText(), config).filter(issue => issue.level === "repairable");
  const actions = repairServerIssues(config, issues, reason);
  if (actions.some(action => ["duplicate-map-roomdef", "steam-subscribe-failed"].includes(action.code))) {
    const next = saveConfig(config, "Repaired server launch profile");
    applyConfigToIni(next);
  }
  return { issues, actions };
}

function parseIni(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^#;][^=]+)=(.*)$/);
    if (match) values[match[1].trim()] = match[2];
  }
  return values;
}

function updateIniText(text, desired) {
  let lines = text ? text.split(/\r?\n/) : [];
  const seen = new Set();
  lines = lines.map(line => {
    const match = line.match(/^([^#;][^=]+)=(.*)$/);
    if (!match) return line;
    const key = match[1].trim();
    if (!(key in desired)) return line;
    seen.add(key);
    return `${key}=${escapeIniValue(desired[key])}`;
  });
  for (const [key, value] of Object.entries(desired)) {
    if (!seen.has(key)) lines.push(`${key}=${escapeIniValue(value)}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function sortedEnabledMods(config) {
  return [...(config.mods || [])]
    .filter(mod => mod.enabled !== false)
    .sort((a, b) => (a.loadOrder || 9999) - (b.loadOrder || 9999));
}

function buildServerLines(config) {
  const enabledMods = sortedEnabledMods(config);
  const workshopItems = enabledMods
    .filter(mod => !mod.skipWorkshopItem)
    .map(mod => mod.workshopId)
    .filter(Boolean);
  const modIds = enabledMods.flatMap(mod => mod.modIds || []).filter(Boolean);
  const maps = enabledMods.flatMap(mod => mod.mapFolders || []).filter(Boolean);
  maps.push(...(config.mapFolders || []).filter(Boolean));
  const orderedMaps = [...new Set(maps.filter(map => map !== "Muldraugh, KY"))];
  orderedMaps.push("Muldraugh, KY");

  return {
    PublicName: config.publicName,
    Public: true,
    DefaultPort: config.defaultPort,
    UDPPort: config.udpPort,
    SteamPort1: config.steamPort1,
    SteamPort2: config.steamPort2,
    MaxPlayers: config.maxPlayers,
    Password: config.serverPassword || "",
    WorkshopItems: [...new Set(workshopItems)].join(";"),
    Mods: [...new Set(modIds)].join(";"),
    Map: orderedMaps.join(";")
  };
}

function rebuildDerivedProfileState(config) {
  config.mods = (config.mods || []).map((mod, index) => ({ ...mod, loadOrder: index + 1 }));
  const activeMods = sortedEnabledMods(config);
  const activeModIds = new Set(activeMods.flatMap(mod => mod.modIds || []).filter(Boolean));
  const disabledMaps = new Set(config.disabledMapFolders || []);

  config.unresolvedRequirements = [...new Set(activeMods
    .flatMap(mod => mod.requiredMods || [])
    .map(normalizeModRequirement)
    .filter(Boolean)
    .filter(req => !activeModIds.has(req)))];

  const rebuiltMaps = [...new Set(activeMods
    .flatMap(mod => mod.mapFolders || [])
    .filter(Boolean)
    .filter(folder => folder !== "Muldraugh, KY")
    .filter(folder => !disabledMaps.has(folder)))];
  rebuiltMaps.push("Muldraugh, KY");
  config.mapFolders = rebuiltMaps;
  return config;
}

function removeWorkshopModFromConfig(config, workshopId) {
  const id = String(workshopId || "").trim();
  if (!id) throw new Error("Missing Workshop ID for removal.");
  config.mods = config.mods || [];
  const beforeCount = config.mods.length;
  const removed = config.mods.find(mod => String(mod.workshopId || "") === id);
  const removedModIds = new Set(removed?.modIds || []);
  const removedMapFolders = new Set(removed?.mapFolders || []);
  const removedConfigFiles = removed?.configFiles || [];
  config.mods = config.mods.filter(mod => String(mod.workshopId || "") !== id);
  if (config.mods.length === beforeCount) throw new Error(`Workshop ${id} is not in this server profile.`);

  for (const mod of config.mods) {
    mod.requiredMods = (mod.requiredMods || []).filter(req => !removedModIds.has(normalizeModRequirement(req)));
  }
  config.unresolvedRequirements = (config.unresolvedRequirements || []).filter(req => !removedModIds.has(normalizeModRequirement(req)));
  config.mapFolders = (config.mapFolders || []).filter(folder => !removedMapFolders.has(folder));
  rebuildDerivedProfileState(config);

  const next = saveConfig(config, "Removed Workshop mod from local Host profile");
  const iniPath = applyConfigToIni(next);
  addChange("Removed Workshop mod", {
    server: next.serverName,
    workshopId: id,
    title: removed?.title || "",
    modIds: [...removedModIds].join(";"),
    mapFolders: [...removedMapFolders].join(";"),
    configFiles: String(removedConfigFiles.length),
    file: iniPath
  });
  return { config: next, removed, iniPath };
}

function applyConfigToIni(config) {
  const iniPath = serverIniPath(config);
  fs.mkdirSync(path.dirname(iniPath), { recursive: true });
  const existing = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, "utf8") : "";
  const nextText = updateIniText(existing, buildServerLines(config));
  fs.writeFileSync(iniPath, nextText, "utf8");
  addChange("Applied mod list to local Host profile", { server: config.serverName, file: iniPath });
  return iniPath;
}

function listServerProfiles(config = loadConfig()) {
  const serverDir = config.pzServerDir || defaultPzServerDir();
  fs.mkdirSync(serverDir, { recursive: true });
  return fs.readdirSync(serverDir)
    .filter(file => file.toLowerCase().endsWith(".ini"))
    .map(file => {
      const fullPath = path.join(serverDir, file);
      const name = path.basename(file, ".ini");
      const values = parseIni(fs.readFileSync(fullPath, "utf8"));
      return {
        name,
        path: fullPath,
        publicName: values.PublicName || name,
        maxPlayers: values.MaxPlayers || "",
        mods: values.Mods || "",
        workshopItems: values.WorkshopItems || "",
        map: values.Map || ""
      };
    });
}

function loadProfileIntoConfig(profileName) {
  const config = loadConfig();
  const iniPath = path.join(config.pzServerDir || defaultPzServerDir(), `${profileName}.ini`);
  if (!fs.existsSync(iniPath)) throw new Error(`Profile not found: ${profileName}`);
  const values = parseIni(fs.readFileSync(iniPath, "utf8"));
  const profileState = readProfileState(profileName) || {};
  config.serverName = profileName;
  config.publicName = values.PublicName || profileState.publicName || profileName;
  config.maxPlayers = Number(values.MaxPlayers || config.maxPlayers || 8);
  config.serverPassword = values.Password || "";
  config.defaultPort = Number(values.DefaultPort || config.defaultPort || 16261);
  config.udpPort = Number(values.UDPPort || config.udpPort || 16262);
  config.steamPort1 = Number(values.SteamPort1 || config.steamPort1 || 8766);
  config.steamPort2 = Number(values.SteamPort2 || config.steamPort2 || 8767);
  const workshopIds = splitSemi(values.WorkshopItems);
  const mapFolders = splitSemi(values.Map).filter(map => map !== "Muldraugh, KY");
  const previousMods = profileState.mods || config.mods || [];
  config.disabledMapFolders = profileState.disabledMapFolders || config.disabledMapFolders || [];
  config.unresolvedRequirements = profileState.unresolvedRequirements || [];
  config.mapFolders = [...new Set([...mapFolders, "Muldraugh, KY"])];
  config.mods = workshopIds.map((workshopId, index) => {
    const existing = previousMods.find(mod => mod.workshopId === workshopId);
    const inspected = inspectWorkshopItem(config, workshopId);
    const inspectedModIds = [...new Set(inspected.modInfos.map(info => info.id).filter(Boolean))];
    const inspectedMapFolders = [...new Set(inspected.modInfos.flatMap(info => info.mapFolders || []).filter(Boolean))];
    const inspectedRequiredMods = [...new Set(inspected.modInfos.flatMap(info => info.requiredMods || []).map(normalizeModRequirement).filter(Boolean))];
    const inspectedConfigFiles = [...new Map(inspected.modInfos.flatMap(info => info.configFiles || []).map(file => [file.path, file])).values()];
    return {
      enabled: true,
      workshopId,
      title: existing?.title || inspected.modInfos.map(info => info.name).filter(Boolean).join(" / ") || `Workshop ${workshopId}`,
      modIds: inspectedModIds.length ? inspectedModIds : (existing?.modIds || []),
      mapFolders: inspectedMapFolders.length ? inspectedMapFolders : (existing?.mapFolders || []),
      loadOrder: index + 1,
      requiredMods: inspectedRequiredMods.length ? inspectedRequiredMods : (existing?.requiredMods || []),
      configFiles: inspectedConfigFiles.length ? inspectedConfigFiles : (existing?.configFiles || []),
      workshopPreview: existing?.workshopPreview || null,
      workshopOnly: existing?.workshopOnly || false,
      skipWorkshopItem: existing?.skipWorkshopItem || false,
      notes: existing?.notes || ""
    };
  });
  const skippedExisting = previousMods.filter(mod => mod.skipWorkshopItem && !workshopIds.includes(mod.workshopId));
  config.mods.push(...skippedExisting);
  saveConfig(config, "Loaded local Host profile");
  return config;
}

function freshProfileConfig(profileName, current = loadConfig()) {
  const cleanName = String(profileName || "").trim().replace(/[\\/:*?"<>|]/g, "");
  const fresh = defaultConfig();
  for (const key of ["steamDir", "pzGameDir", "pzServerDir", "steamCmdDir", "serverDir", "betaBranch"]) {
    fresh[key] = current[key] || fresh[key];
  }
  fresh.serverName = cleanName;
  fresh.publicName = cleanName;
  fresh.serverPassword = "";
  fresh.mapFolders = ["Muldraugh, KY"];
  fresh.disabledMapFolders = [];
  fresh.mods = [];
  fresh.unresolvedRequirements = [];
  return ensureConfigShape(fresh);
}

function createHostProfile(profileName, options = {}) {
  const cleanName = String(profileName || "").trim().replace(/[\\/:*?"<>|]/g, "");
  if (!cleanName) throw new Error("Enter a valid profile name.");
  const config = options.fresh ? freshProfileConfig(cleanName) : loadConfig();
  config.serverName = cleanName;
  config.publicName = options.fresh ? cleanName : (config.publicName || cleanName);
  fs.mkdirSync(config.pzServerDir || defaultPzServerDir(), { recursive: true });
  const iniPath = applyConfigToIni(config);
  for (const file of [sandboxPath(config), spawnRegionsPath(config), spawnPointsPath(config)]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, file.endsWith("_spawnregions.lua") ? "function SpawnRegions()\n  return {}\nend\n" : "", "utf8");
  }
  saveConfig(config, options.fresh ? "Created fresh local Host profile" : "Created local Host profile");
  return { config, iniPath };
}

function splitSemi(value) {
  return String(value || "").split(";").map(item => item.trim()).filter(Boolean);
}

function normalizeModRequirement(value) {
  return String(value || "")
    .trim()
    .replace(/^\\+/, "")
    .replace(/^require\s*=\s*/i, "")
    .trim();
}

function splitRequirementList(value) {
  return [...new Set(String(value || "")
    .split(/[;,]/)
    .map(normalizeModRequirement)
    .filter(item => item && item !== "require"))];
}

function extractWorkshopIds(value) {
  return [...new Set([...String(value || "").matchAll(/(?:id=|workshop[\s_-]*id[:=]?|WorkshopItems=|^|[^\d])(\d{6,})(?=$|[^\d])/gi)]
    .map(match => String(match[1]).trim())
    .filter(Boolean))];
}

function parseImportedModListText(text) {
  const raw = String(text || "");
  const ini = parseIni(raw);
  const workshopIds = extractWorkshopIds(raw);
  const modIds = [];

  if (ini.Mods) modIds.push(...splitSemi(ini.Mods));
  if (ini.WorkshopItems) workshopIds.push(...extractWorkshopIds(ini.WorkshopItems));

  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^(VERSION|WorkshopItems|Mods|Map|Server|PublicName|Password)\s*=/i.test(line)) continue;
    if (/^\d{6,}([,;\s]+\d{6,})*$/.test(line)) {
      workshopIds.push(...extractWorkshopIds(line));
      continue;
    }
    if (line.includes(";") && !line.includes("=")) {
      modIds.push(...splitSemi(line));
    }
  }

  return {
    workshopIds: [...new Set(workshopIds)],
    modIds: [...new Set(modIds.map(normalizeModRequirement).filter(Boolean))]
  };
}

function extractModIdsFromWorkshopText(plain) {
  return [...new Set([...String(plain || "").matchAll(/Mod ID:\s*([\s\S]{1,1000}?)(?=Workshop ID:|Map Folder:|Mod ID:|Popular Discussions|Description|Comments|Change Notes|Created by|$)/gi)]
    .map(match => normalizeModRequirement(match[1].replace(/\s+/g, " ")))
    .map(value => value.replace(/\b(Popular Discussions|Description|Subscribe to download|Created by)\b[\s\S]*$/i, "").trim())
    .filter(Boolean))];
}

function readProfileFiles(config) {
  const files = {
    ini: serverIniPath(config),
    sandbox: sandboxPath(config),
    spawnRegions: spawnRegionsPath(config),
    spawnPoints: spawnPointsPath(config)
  };
  return Object.fromEntries(Object.entries(files).map(([key, file]) => [
    key,
    { path: file, text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" }
  ]));
}

function saveProfileFiles(config, files) {
  const allowed = readProfileFiles(config);
  for (const [key, value] of Object.entries(files || {})) {
    if (!allowed[key]) continue;
    fs.mkdirSync(path.dirname(allowed[key].path), { recursive: true });
    fs.writeFileSync(allowed[key].path, String(value ?? ""), "utf8");
    addChange("Saved profile file", { server: config.serverName, file: allowed[key].path });
  }
}

function findStartBat(serverDir) {
  const candidates = ["StartServer64.bat", "start-server.bat", "StartServer64_nosteam.bat"].map(file => path.join(serverDir, file));
  return candidates.find(fs.existsSync);
}

function javaServerCommand(config) {
  const javaExe = path.join(config.serverDir, "jre64", "bin", "java.exe");
  if (!fs.existsSync(javaExe)) return null;
  const memory = `${Number(config.memoryMb || 8192)}m`;
  return {
    exe: javaExe,
    args: [
      "-Djava.awt.headless=true",
      "-Dzomboid.steam=1",
      "-Dzomboid.znetlog=1",
      "-XX:+UseZGC",
      "-XX:-CreateCoredumpOnCrash",
      "-XX:-OmitStackTraceInFastThrow",
      `-Xms${memory}`,
      `-Xmx${memory}`,
      "-Djava.library.path=natives/;natives/win64/;.",
      "-cp",
      "java/;java/projectzomboid.jar",
      "zombie.network.GameServer",
      "-servername",
      config.serverName,
      "-adminpassword",
      config.adminPassword
    ]
  };
}

function startDedicatedServer(config, options = {}) {
  const bat = findStartBat(config.serverDir);
  const javaCommand = javaServerCommand(config);
  if (!bat && !javaCommand) throw new Error(`Could not find server launcher files in ${config.serverDir}`);
  applyConfigToIni(config);
  stopOrphanDedicatedServers(config);
  const coop = findPzServerProcesses(config).find(proc => proc.coop);
  if (coop) throw new Error(`Project Zomboid Host Game is already launching this profile (PID ${coop.pid}). Close/finish Host before running the dedicated test server.`);
  if (gameProcess) throw new Error("Server is already running.");
  const exe = javaCommand ? javaCommand.exe : "cmd.exe";
  const args = javaCommand ? javaCommand.args : ["/c", bat, "-servername", config.serverName];
  log(`${options.label || "Starting dedicated server"}: ${exe}`);
  gameProcess = spawn(exe, args, { cwd: config.serverDir, windowsHide: options.hidden !== false, env: { ...process.env } });
  const pid = gameProcess.pid;
  gameProcess.stdout.on("data", data => log(data.toString().trimEnd()));
  gameProcess.stderr.on("data", data => log(data.toString().trimEnd()));
  gameProcess.on("exit", code => {
    log(`Dedicated server exited with code ${code}`);
    addChange("Dedicated server exited", { server: config.serverName, code: String(code) });
    gameProcess = null;
  });
  return { pid, exe };
}

function enabledWorkshopIds(config) {
  return [...new Set(sortedEnabledMods(config)
    .filter(mod => !mod.skipWorkshopItem)
    .map(mod => String(mod.workshopId || "").trim())
    .filter(Boolean))];
}

function enabledWorkshopItems(config) {
  const seen = new Set();
  return sortedEnabledMods(config)
    .filter(mod => mod.workshopId && !mod.skipWorkshopItem)
    .map(mod => ({ workshopId: String(mod.workshopId).trim(), workshopOnly: Boolean(mod.workshopOnly) }))
    .filter(item => {
      if (!item.workshopId || seen.has(item.workshopId)) return false;
      seen.add(item.workshopId);
      return true;
    });
}

function workshopContentRoot(baseDir) {
  return path.join(baseDir, "steamapps", "workshop", "content", STEAM_WORKSHOP_APP);
}

function workshopManifestPath(baseDir) {
  return path.join(baseDir, "steamapps", "workshop", `appworkshop_${STEAM_WORKSHOP_APP}.acf`);
}

function steamLibraryWorkshopRoot(config) {
  return path.join(config.steamDir || "", "steamapps", "workshop", "content", STEAM_WORKSHOP_APP);
}

function steamCmdWorkshopRoot(config) {
  return path.join(config.steamCmdDir || "", "steamapps", "workshop", "content", STEAM_WORKSHOP_APP);
}

function hostGameWorkshopRoot(config) {
  return workshopContentRoot(config.pzGameDir || "");
}

function workshopItemHasModInfo(itemRoot) {
  if (!fs.existsSync(itemRoot)) return false;
  const stack = [{ dir: itemRoot, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 5) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
      else if (name.toLowerCase() === "mod.info") return true;
    }
  }
  return false;
}

function directorySize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return total;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    total += stat.isDirectory() ? directorySize(full) : stat.size;
  }
  return total;
}

function vdfEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function writeSteamLibraryMetadata(config, baseDir) {
  const steamapps = path.join(baseDir, "steamapps");
  fs.mkdirSync(steamapps, { recursive: true });
  const libraryText = `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"${vdfEscape(baseDir)}"
\t\t"label"\t\t""
\t\t"contentid"\t\t"1"
\t\t"totalsize"\t\t"0"
\t\t"update_clean_bytes_tally"\t\t"0"
\t\t"time_last_update_corruption"\t\t"0"
\t\t"apps"
\t\t{
\t\t\t"${STEAM_WORKSHOP_APP}"\t\t"0"
\t\t}
\t}
}
`;
  fs.writeFileSync(path.join(steamapps, "libraryfolders.vdf"), libraryText, "utf8");
  const appManifest = path.join(config.steamDir || "", "steamapps", `appmanifest_${STEAM_WORKSHOP_APP}.acf`);
  if (fs.existsSync(appManifest)) {
    fs.copyFileSync(appManifest, path.join(steamapps, `appmanifest_${STEAM_WORKSHOP_APP}.acf`));
  }
}

function cachedWorkshopSteamMeta(workshopId) {
  const cached = readCache("workshop_details", "workshop_id", workshopId)?.value || {};
  return {
    fileSize: Number(cached.fileSize || cached.file_size || 0),
    timeUpdated: Number(cached.timeUpdated || cached.time_updated || 0),
    manifest: String(cached.manifest || cached.hcontentFile || cached.hcontent_file || "0")
  };
}

function parseWorkshopManifestMeta(manifestFile) {
  const map = new Map();
  if (!fs.existsSync(manifestFile)) return map;
  const text = fs.readFileSync(manifestFile, "utf8");
  for (const match of text.matchAll(/"(\d+)"\s*\{([\s\S]*?)\n\s*\}/g)) {
    const id = match[1];
    const block = match[2];
    const size = Number((block.match(/"size"\s*"(\d+)"/) || [])[1] || 0);
    const timeUpdated = Number((block.match(/"timeupdated"\s*"(\d+)"/) || [])[1] || 0);
    const manifest = (block.match(/"manifest"\s*"(\d+)"/) || [])[1] || "";
    const existing = map.get(id) || {};
    map.set(id, {
      fileSize: size || existing.fileSize || 0,
      timeUpdated: timeUpdated || existing.timeUpdated || 0,
      manifest: manifest || existing.manifest || ""
    });
  }
  return map;
}

function localWorkshopManifestDetails(config) {
  const files = [
    workshopManifestPath(config.steamCmdDir || ""),
    workshopManifestPath(config.steamDir || ""),
    workshopManifestPath(config.pzGameDir || ""),
    workshopManifestPath(config.serverDir || "")
  ];
  const details = new Map();
  for (const file of files) {
    for (const [id, meta] of parseWorkshopManifestMeta(file).entries()) {
      const existing = details.get(id) || {};
      details.set(id, {
        ...existing,
        file_size: String(meta.fileSize || existing.file_size || 0),
        time_updated: Number(meta.timeUpdated || existing.time_updated || 0),
        hcontent_file: String(meta.manifest || existing.hcontent_file || "")
      });
    }
  }
  return details;
}

function workshopSteamMeta(workshopId, steamDetails = new Map()) {
  const api = steamDetails.get(String(workshopId)) || {};
  const cached = cachedWorkshopSteamMeta(workshopId);
  return {
    fileSize: Number(api.file_size || cached.fileSize || 0),
    timeUpdated: Number(api.time_updated || cached.timeUpdated || 0),
    manifest: String(api.hcontent_file || cached.manifest || "0")
  };
}

async function fetchActiveWorkshopSteamDetails(config) {
  const ids = enabledWorkshopIds(config);
  const details = localWorkshopManifestDetails(config);
  if (isSteamRateLimited()) return details;
  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50);
    const chunkDetails = await fetchPublishedFileDetails(chunk);
    for (const [id, detail] of chunkDetails.entries()) {
      details.set(id, detail);
      const cached = readCache("workshop_details", "workshop_id", id)?.value || {};
      writeCache("workshop_details", "workshop_id", id, {
        ...cached,
        fileSize: Number(detail.file_size || cached.fileSize || 0),
        timeUpdated: Number(detail.time_updated || cached.timeUpdated || 0),
        manifest: String(detail.hcontent_file || cached.manifest || ""),
        title: cached.title || detail.title || `Workshop ${id}`
      });
    }
  }
  return details;
}

function writeWorkshopAppManifest(config, baseDir, steamDetails = new Map()) {
  const workshopDir = path.join(baseDir, "steamapps", "workshop");
  const contentRoot = path.join(workshopDir, "content", STEAM_WORKSHOP_APP);
  fs.mkdirSync(contentRoot, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const rows = enabledWorkshopItems(config).map(item => {
    const root = path.join(contentRoot, item.workshopId);
    const meta = workshopSteamMeta(item.workshopId, steamDetails);
    const localSize = directorySize(root);
    return {
      id: item.workshopId,
      size: meta.fileSize || localSize || 1,
      updated: meta.timeUpdated || 1,
      manifest: meta.manifest || "0"
    };
  });
  const sizeOnDisk = rows.reduce((sum, row) => sum + Number(row.size || 0), 0);
  let text = `"AppWorkshop"
{
\t"appid"\t\t"${STEAM_WORKSHOP_APP}"
\t"SizeOnDisk"\t\t"${sizeOnDisk}"
\t"NeedsUpdate"\t\t"0"
\t"NeedsDownload"\t\t"0"
\t"TimeLastUpdated"\t\t"${now}"
\t"TimeLastAppRan"\t\t"${now}"
\t"LastBuildID"\t\t"22695648"
\t"WorkshopItemsInstalled"
\t{
`;
  for (const row of rows) {
    text += `\t\t"${row.id}"
\t\t{
\t\t\t"size"\t\t"${row.size}"
\t\t\t"timeupdated"\t\t"${row.updated}"
\t\t\t"manifest"\t\t"${row.manifest}"
\t\t}
`;
  }
  text += `\t}
\t"WorkshopItemDetails"
\t{
`;
  for (const row of rows) {
    text += `\t\t"${row.id}"
\t\t{
\t\t\t"manifest"\t\t"${row.manifest}"
\t\t\t"timeupdated"\t\t"${row.updated}"
\t\t\t"timetouched"\t\t"${now}"
\t\t\t"subscribedby"\t\t"304339748"
\t\t\t"latest_timeupdated"\t\t"${row.updated}"
\t\t\t"latest_manifest"\t\t"${row.manifest}"
\t\t}
`;
  }
  text += `\t}
}
`;
  fs.writeFileSync(path.join(workshopDir, `appworkshop_${STEAM_WORKSHOP_APP}.acf`), text, "utf8");
}

function steamCmdExe(config) {
  const exe = path.join(config.steamCmdDir || "", "steamcmd.exe");
  return fs.existsSync(exe) ? exe : "";
}

function downloadWorkshopItemsWithSteamCmd(config, workshopIds, options = {}) {
  const exe = steamCmdExe(config);
  const ids = [...new Set((workshopIds || []).map(id => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return { attempted: [], downloaded: [], failed: [], skipped: true, reason: "No Workshop IDs requested" };
  if (!exe) {
    const reason = `steamcmd.exe not found at ${path.join(config.steamCmdDir || "", "steamcmd.exe")}`;
    log(reason);
    return { attempted: ids, downloaded: [], failed: ids.map(id => ({ workshopId: id, error: reason })), skipped: true, reason };
  }

  const downloaded = [];
  const failed = [];
  for (const id of ids) {
    const args = ["+login", "anonymous", "+workshop_download_item", STEAM_WORKSHOP_APP, id, "validate", "+quit"];
    log(`SteamCMD downloading Workshop ${id}`);
    const result = spawnSync(exe, args, {
      cwd: config.steamCmdDir,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs || 10 * 60 * 1000
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    if (output) output.split(/\r?\n/).filter(Boolean).slice(-30).forEach(line => log(`[SteamCMD ${id}] ${line}`));
    const target = path.join(steamCmdWorkshopRoot(config), id);
    if (result.status === 0 && fs.existsSync(target)) {
      downloaded.push(id);
    } else {
      failed.push({
        workshopId: id,
        error: result.error ? result.error.message : `SteamCMD exited with code ${result.status}`,
        output: output.slice(-2000)
      });
    }
  }

  addChange("SteamCMD Workshop fallback", {
    server: config.serverName,
    attempted: String(ids.length),
    downloaded: String(downloaded.length),
    failed: String(failed.length)
  });
  return { attempted: ids, downloaded, failed, skipped: false };
}

function copyWorkshopManifestTo(config, targetBaseDir) {
  const source = workshopManifestPath(config.steamDir || "");
  const target = workshopManifestPath(targetBaseDir);
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function syncWorkshopItemsToLaunchFolders(config, options = {}) {
  const steamDetails = options.steamDetails || new Map();
  const sourceRoots = [
    steamCmdWorkshopRoot(config),
    steamLibraryWorkshopRoot(config),
    workshopContentRoot(config.serverDir || ""),
    hostGameWorkshopRoot(config)
  ].filter(root => root && fs.existsSync(root));
  const targets = [
    { label: "Host Game", baseDir: config.pzGameDir, root: hostGameWorkshopRoot(config) },
    { label: "Dedicated Server", baseDir: config.serverDir, root: workshopContentRoot(config.serverDir || "") }
  ].filter(target => target.baseDir && fs.existsSync(target.baseDir));
  const items = enabledWorkshopItems(config);
  const copied = [];
  const missing = [];

  for (const target of targets) {
    fs.mkdirSync(target.root, { recursive: true });
    writeSteamLibraryMetadata(config, target.baseDir);
    for (const item of items) {
      const workshopId = item.workshopId;
      const targetItem = path.join(target.root, workshopId);
      if (item.workshopOnly ? fs.existsSync(targetItem) : workshopItemHasModInfo(targetItem)) continue;
      const sourceItem = sourceRoots
        .map(root => path.join(root, workshopId))
        .find(candidate => candidate !== targetItem && (item.workshopOnly ? fs.existsSync(candidate) : workshopItemHasModInfo(candidate)));
      if (!sourceItem) {
        missing.push({ workshopId, target: target.label });
        continue;
      }
      fs.cpSync(sourceItem, targetItem, { recursive: true, force: true });
      copied.push({ workshopId, target: target.label, from: sourceItem, to: targetItem });
      log(`Synced Workshop ${workshopId} into ${target.label}`);
    }
    writeWorkshopAppManifest(config, target.baseDir, steamDetails);
  }

  if (copied.length) {
    addChange("Synced Workshop files for launch", {
      server: config.serverName,
      count: String(copied.length),
      targets: [...new Set(copied.map(item => item.target))].join(", ")
    });
  }
  if (missing.length && options.throwOnMissing) {
    const list = missing.map(item => `${item.workshopId} (${item.target})`).join(", ");
    throw new Error(`Missing installed Workshop files: ${list}. Subscribe/download them in Steam, then scan again.`);
  }
  return { copied, missing, targets: targets.map(target => target.label) };
}

async function prepareWorkshopLaunchFolders(config, options = {}) {
  let steamDetails = await fetchActiveWorkshopSteamDetails(config);
  let sync = syncWorkshopItemsToLaunchFolders(config, { ...options, steamDetails, throwOnMissing: false });
  const missingIds = [...new Set(sync.missing.map(item => item.workshopId))];
  const shouldUseSteamCmd = missingIds.length || isSteamRateLimited() || options.forceSteamCmd;
  let steamCmd = null;
  if (shouldUseSteamCmd) {
    const ids = missingIds.length ? missingIds : enabledWorkshopIds(config);
    steamCmd = downloadWorkshopItemsWithSteamCmd(config, ids);
    steamDetails = localWorkshopManifestDetails(config);
    sync = syncWorkshopItemsToLaunchFolders(config, { ...options, steamDetails, throwOnMissing: false });
  }
  if (sync.missing.length && options.throwOnMissing) {
    const list = sync.missing.map(item => `${item.workshopId} (${item.target})`).join(", ");
    throw new Error(`Missing installed Workshop files after SteamCMD fallback: ${list}.`);
  }
  return { ...sync, steamCmd, rateLimited: isSteamRateLimited() };
}

function findPzServerProcesses(config) {
  const script = "Get-CimInstance Win32_Process -Filter \"name = 'java.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*zombie.network.GameServer*' } | " +
    "Select-Object ProcessId,CommandLine | ConvertTo-Json -Depth 3";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !String(result.stdout || "").trim()) return [];
  try {
    const rows = JSON.parse(result.stdout);
    return (Array.isArray(rows) ? rows : [rows]).map(row => {
      const commandLine = String(row.CommandLine || "");
      const coop = /\s-coop(\s|$)/i.test(commandLine);
      const serverName = (commandLine.match(/-servername\s+("?)([^"\s]+)\1/i) || [])[2] || "";
      return { pid: Number(row.ProcessId), commandLine, coop, serverName };
    }).filter(row => !config || !config.serverName || row.serverName === config.serverName);
  } catch {
    return [];
  }
}

function isProjectZomboidGameRunning(config) {
  const exe = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('ProjectZomboid64.exe','ProjectZomboid32.exe') -or ($_.Name -eq 'java.exe' -and $_.CommandLine -like '*ProjectZomboid*') } | Select-Object -First 1 ProcessId | ConvertTo-Json"
  ], { encoding: "utf8", windowsHide: true });
  if (exe.status === 0 && String(exe.stdout || "").trim()) return true;
  return findPzServerProcesses(config).some(proc => proc.coop);
}

function stopOrphanDedicatedServers(config) {
  const stopped = [];
  for (const proc of findPzServerProcesses(config)) {
    if (proc.coop) continue;
    try {
      process.kill(proc.pid);
      stopped.push(proc);
    } catch {}
  }
  if (stopped.length) {
    addChange("Stopped orphaned dedicated server process", {
      server: config.serverName,
      pids: stopped.map(item => String(item.pid)).join(", ")
    });
  }
  return stopped;
}

function workshopRoots(config) {
  const roots = [
    path.join(config.serverDir || "", "steamapps", "workshop", "content", STEAM_WORKSHOP_APP),
    hostGameWorkshopRoot(config),
    steamLibraryWorkshopRoot(config),
    ...FALLBACK_STEAM_DIRS.map(dir => path.join(dir, "steamapps", "workshop", "content", STEAM_WORKSHOP_APP))
  ];
  return [...new Set(roots)].filter(root => root && fs.existsSync(root));
}

function findCandidateConfigFiles(modRoot) {
  const results = [];
  const allowed = new Set([".json", ".ini", ".lua", ".txt"]);
  const ignored = new Set(["info.txt", "poster.png"]);
  function walk(dir, depth = 0) {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (!["media", "common", "server", "shared", "client", "config", "lua"].includes(name.toLowerCase()) && depth > 1) continue;
        walk(full, depth + 1);
      } else {
        const ext = path.extname(name).toLowerCase();
        const lower = name.toLowerCase();
        if (allowed.has(ext) && !ignored.has(lower) && stat.size < 256_000) {
          const rel = path.relative(modRoot, full);
          if (/config|option|setting|sandbox|spawn|distribution|\.json$/i.test(rel)) {
            results.push({ path: full, relativePath: rel, size: stat.size, extension: ext });
          }
        }
      }
    }
  }
  walk(modRoot);
  return results.slice(0, 40);
}

function findModInfoFiles(modRoot) {
  const candidates = [];
  function walk(dir, depth = 0) {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (/^(info\.txt|mod\.info)$/i.test(name)) {
        candidates.push(full);
      }
    }
  }
  walk(modRoot);
  return candidates.sort((a, b) => scoreModInfoPath(b) - scoreModInfoPath(a));
}

function scoreModInfoPath(file) {
  const normalized = file.replace(/\\/g, "/");
  const version = (normalized.match(/\/(42(?:\.\d+)*)\//) || [])[1];
  if (version) {
    return 1000 + version.split(".").reduce((score, part, index) => score + Number(part || 0) / Math.pow(100, index), 0);
  }
  if (/\/common\//i.test(normalized)) return 100;
  return 10;
}

function readModInfo(modRoot, fallbackFolder) {
  const infoPath = findModInfoFiles(modRoot)[0];
  if (!infoPath) return null;
  const text = fs.readFileSync(infoPath, "utf8");
  const id = (text.match(/^id=(.+)$/m) || [])[1]?.trim() || fallbackFolder;
  const name = (text.match(/^name=(.+)$/m) || [])[1]?.trim() || fallbackFolder;
  const poster = (text.match(/^poster=(.+)$/m) || [])[1]?.trim();
  const require = (text.match(/^require=(.+)$/m) || [])[1]?.trim();
  const versionMin = (text.match(/^versionMin=(.+)$/m) || [])[1]?.trim();
  const modRootForMaps = path.dirname(infoPath);
  const mapFolders = findMapFolders(modRootForMaps);
  return { id, name, poster, requiredMods: splitRequirementList(require), mapFolders, infoPath, versionMin };
}

function findMapFolders(modRoot) {
  const mapFolders = [];
  const checked = new Set();
  for (const base of [modRoot, path.join(modRoot, "common"), path.dirname(modRoot)]) {
    const mediaMaps = path.join(base, "media", "maps");
    if (checked.has(mediaMaps) || !fs.existsSync(mediaMaps)) continue;
    checked.add(mediaMaps);
    for (const folder of fs.readdirSync(mediaMaps)) {
      if (folder !== "challengemaps") mapFolders.push(folder);
    }
  }
  return [...new Set(mapFolders)];
}

function scanDownloadedMods(config) {
  const found = [];
  for (const workshopRoot of workshopRoots(config)) {
    for (const workshopId of fs.readdirSync(workshopRoot)) {
      const itemRoot = path.join(workshopRoot, workshopId, "mods");
      if (!fs.existsSync(itemRoot)) continue;
      for (const modFolder of fs.readdirSync(itemRoot)) {
        const modRoot = path.join(itemRoot, modFolder);
        const info = readModInfo(modRoot, modFolder);
        if (!info) continue;
        found.push({
          workshopId,
          modId: info.id,
          title: info.name,
          poster: info.poster,
          requiredMods: info.requiredMods,
          mapFolders: info.mapFolders,
          configFiles: findCandidateConfigFiles(modRoot),
          sourceRoot: workshopRoot
        });
      }
    }
  }
  return found;
}

function inspectWorkshopItem(config, workshopId) {
  const roots = workshopRoots(config);
  for (const workshopRoot of roots) {
    const itemRoot = path.join(workshopRoot, workshopId);
    if (!fs.existsSync(itemRoot)) continue;
    const modsRoot = path.join(itemRoot, "mods");
    const modInfos = [];
    if (fs.existsSync(modsRoot)) {
      for (const modFolder of fs.readdirSync(modsRoot)) {
        const modRoot = path.join(modsRoot, modFolder);
        const info = readModInfo(modRoot, modFolder);
        if (!info) continue;
        modInfos.push({
          id: info.id,
          name: info.name,
          requiredMods: info.requiredMods,
          mapFolders: info.mapFolders,
          configFiles: findCandidateConfigFiles(modRoot),
          infoPath: info.infoPath
        });
      }
    }
    const files = fs.readdirSync(itemRoot);
    const legacyOnly = !modInfos.length && files.some(file => /legacy\.bin$/i.test(file));
    return { workshopId, itemRoot, modInfos, legacyOnly, files };
  }
  return { workshopId, itemRoot: "", modInfos: [], legacyOnly: false, files: [] };
}

function activeInternalModIds(config) {
  return new Set(sortedEnabledMods(config).flatMap(mod => mod.modIds || []).filter(Boolean));
}

function modMatchesWorkshopOrModId(mod, workshopId, modId) {
  return String(mod.workshopId || "") === String(workshopId) || (mod.modIds || []).includes(modId);
}

function ensureModBefore(config, beforeMod, afterMod) {
  const mods = config.mods || [];
  const beforeIndex = mods.indexOf(beforeMod);
  const afterIndex = mods.indexOf(afterMod);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex < afterIndex) {
    mods.forEach((mod, index) => mod.loadOrder = index + 1);
    return false;
  }

  mods.splice(beforeIndex, 1);
  const nextAfterIndex = mods.indexOf(afterMod);
  mods.splice(Math.max(0, nextAfterIndex), 0, beforeMod);
  mods.forEach((mod, index) => mod.loadOrder = index + 1);
  return true;
}

function ensureCommonSensePatchDependency(config, actions = []) {
  const rule = SPECIAL_WORKSHOP_RULES.commonSensePatch;
  config.mods = config.mods || [];
  const patch = config.mods.find(mod => modMatchesWorkshopOrModId(mod, rule.patchWorkshopId, rule.patchModId));
  if (!patch || patch.enabled === false) return false;

  let changed = false;
  let original = config.mods.find(mod => modMatchesWorkshopOrModId(mod, rule.requiredWorkshopId, rule.requiredModId));
  if (!original) {
    original = {
      enabled: true,
      workshopId: rule.requiredWorkshopId,
      title: rule.requiredTitle,
      modIds: [rule.requiredModId],
      mapFolders: [],
      loadOrder: config.mods.length + 1,
      requiredMods: [],
      configFiles: [],
      workshopPreview: null,
      workshopOnly: false,
      skipWorkshopItem: false,
      notes: `Automatically added because ${patch.title || "Common Sense Patch"} requires the original Common Sense mod.`
    };
    config.mods.push(original);
    actions.push({
      level: "fixed",
      title: "Added Common Sense dependency",
      details: `${rule.requiredTitle} (${rule.requiredModId}) was added because ${patch.title || rule.patchModId} is installed.`,
      workshopId: rule.requiredWorkshopId
    });
    changed = true;
  } else {
    const before = JSON.stringify({
      enabled: original.enabled,
      workshopId: original.workshopId,
      modIds: original.modIds || [],
      workshopOnly: original.workshopOnly,
      skipWorkshopItem: original.skipWorkshopItem
    });
    original.enabled = true;
    original.workshopId = rule.requiredWorkshopId;
    original.title = original.title || rule.requiredTitle;
    original.modIds = [...new Set([...(original.modIds || []), rule.requiredModId])];
    original.workshopOnly = false;
    original.skipWorkshopItem = false;
    const after = JSON.stringify({
      enabled: original.enabled,
      workshopId: original.workshopId,
      modIds: original.modIds || [],
      workshopOnly: original.workshopOnly,
      skipWorkshopItem: original.skipWorkshopItem
    });
    if (before !== after) {
      actions.push({
        level: "fixed",
        title: "Repaired Common Sense dependency",
        details: `${rule.requiredTitle} is enabled with Mod ID ${rule.requiredModId}.`,
        workshopId: rule.requiredWorkshopId
      });
      changed = true;
    }
  }

  if (ensureModBefore(config, original, patch)) {
    actions.push({
      level: "fixed",
      title: "Moved Common Sense before its patch",
      details: `${rule.requiredTitle} now loads before ${patch.title || rule.patchModId}.`,
      workshopId: rule.patchWorkshopId
    });
    changed = true;
  }

  return changed;
}

function refreshModFromDownloadedFiles(config, mod, actions, options = {}) {
  if (!mod.workshopId) return false;
  const inspected = inspectWorkshopItem(config, mod.workshopId);
  if (inspected.modInfos.length) {
    const disabledMaps = new Set(config.disabledMapFolders || []);
    const ownIds = new Set(inspected.modInfos.map(info => info.id).filter(Boolean));
    const nextModIds = [...ownIds];
    const nextMapFolders = [...new Set(inspected.modInfos
      .flatMap(info => info.mapFolders || [])
      .filter(Boolean)
      .filter(folder => !disabledMaps.has(folder)))];
    const nextRequiredMods = [...new Set(inspected.modInfos
      .flatMap(info => info.requiredMods || [])
      .map(normalizeModRequirement)
      .filter(req => req && !ownIds.has(req)))];
    const nextConfigFiles = [...new Map(inspected.modInfos.flatMap(info => info.configFiles || []).map(file => [file.path, file])).values()];
    const before = JSON.stringify({
      modIds: mod.modIds || [],
      mapFolders: mod.mapFolders || [],
      requiredMods: mod.requiredMods || [],
      configFiles: (mod.configFiles || []).map(file => file.path),
      workshopOnly: mod.workshopOnly,
      skipWorkshopItem: mod.skipWorkshopItem
    });
    mod.modIds = nextModIds;
    mod.mapFolders = nextMapFolders;
    mod.requiredMods = nextRequiredMods;
    mod.configFiles = nextConfigFiles;
    mod.workshopOnly = false;
    mod.skipWorkshopItem = false;
    const after = JSON.stringify({
      modIds: mod.modIds || [],
      mapFolders: mod.mapFolders || [],
      requiredMods: mod.requiredMods || [],
      configFiles: (mod.configFiles || []).map(file => file.path),
      workshopOnly: mod.workshopOnly,
      skipWorkshopItem: mod.skipWorkshopItem
    });
    if (before !== after) {
      actions.push({
        level: "fixed",
        title: `Rebuilt ${mod.title} from downloaded files`,
        details: `Using Mod IDs: ${mod.modIds.join("; ") || "none"}${mod.mapFolders.length ? ` | Maps: ${mod.mapFolders.join("; ")}` : ""}`,
        workshopId: mod.workshopId
      });
      return true;
    }
    return false;
  }

  if (inspected.legacyOnly) {
    const before = JSON.stringify({ workshopOnly: mod.workshopOnly, skipWorkshopItem: mod.skipWorkshopItem, modIds: mod.modIds || [], mapFolders: mod.mapFolders || [] });
    mod.modIds = [];
    mod.mapFolders = [];
    mod.requiredMods = [];
    mod.configFiles = [];
    mod.workshopOnly = true;
    mod.skipWorkshopItem = true;
    const oldNote = "Workshop-only legacy dependency; keep in WorkshopItems, no internal Mod ID needed.";
    const note = "Legacy Workshop collection/dependency; skipped from WorkshopItems because it has no loadable Project Zomboid Mod ID.";
    mod.notes = (mod.notes || "").replace(oldNote, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!mod.notes.includes(note)) mod.notes = [mod.notes, note].filter(Boolean).join("\n");
    const after = JSON.stringify({ workshopOnly: mod.workshopOnly, skipWorkshopItem: mod.skipWorkshopItem, modIds: mod.modIds || [], mapFolders: mod.mapFolders || [] });
    if (before !== after) {
      actions.push({
        level: "fixed",
        title: `Skipped legacy Workshop item ${mod.title}`,
        details: "Installed item only contains a legacy Workshop marker and no mod.info, so it will stay out of WorkshopItems to avoid Steam subscribe/install failures.",
        workshopId: mod.workshopId
      });
      return true;
    }
    return false;
  }

  if ((mod.modIds || []).length) return false;

  if (!options.silentBlocked) {
    actions.push({
      level: "blocked",
      title: `Could not resolve Mod ID for ${mod.title}`,
      details: inspected.itemRoot ? "Downloaded item has no mods/info.txt or mod.info yet. Let Steam finish downloading, then run troubleshooting again." : "Workshop item is not downloaded in the dedicated server or Steam Workshop folders yet.",
      workshopId: mod.workshopId
    });
  }
  return false;
}

function resolveInstalledRequiredMods(config, actions) {
  let added = 0;
  const activeIds = activeInternalModIds(config);
  const required = [...new Set(sortedEnabledMods(config)
    .flatMap(mod => mod.requiredMods || [])
    .map(normalizeModRequirement)
    .filter(Boolean)
    .filter(req => !activeIds.has(req)))];
  if (!required.length) return { added, unresolved: [] };

  const found = scanDownloadedMods(config);
  const byModId = new Map();
  for (const item of found) {
    if (item.modId && !byModId.has(item.modId)) byModId.set(item.modId, item);
  }

  const unresolved = [];
  const toAdd = [];
  for (const req of required) {
    const item = byModId.get(req);
    if (!item) {
      unresolved.push(req);
      continue;
    }
    if (!config.mods.some(mod => mod.workshopId === item.workshopId)) toAdd.push(item);
  }

  if (toAdd.length) {
    added = mergeScannedMods(config, toAdd);
    for (const item of toAdd) {
      const mod = config.mods.find(candidate => candidate.workshopId === item.workshopId);
      if (mod) refreshModFromDownloadedFiles(config, mod, actions, { silentBlocked: true });
      actions.push({
        level: "fixed",
        title: `Added installed dependency ${item.modId}`,
        details: `Required internal Mod ID found in Workshop ${item.workshopId}; added it to WorkshopItems and Mods automatically.`,
        workshopId: item.workshopId
      });
    }
  }

  return { added, unresolved };
}

function troubleshootConfig(config) {
  const actions = [];
  let changed = false;
  config.mods = config.mods || [];
  config.mapFolders = config.mapFolders || ["Muldraugh, KY"];

  if (ensureCommonSensePatchDependency(config, actions)) changed = true;

  for (const mod of config.mods) {
    if (refreshModFromDownloadedFiles(config, mod, actions)) changed = true;
    if (!mod.workshopOnly && !(mod.modIds || []).length && mod.workshopId) {
      const cached = readCache("workshop_details", "workshop_id", mod.workshopId);
      const cachedModIds = cached?.value?.modIds || [];
      if (cachedModIds.length) {
        mod.modIds = [...new Set(cachedModIds)];
        actions.push({
          level: "fixed",
          title: `Resolved ${mod.title} from cached Workshop metadata`,
          details: `Using Mod IDs: ${mod.modIds.join("; ")}`,
          workshopId: mod.workshopId
        });
        changed = true;
      }
    }
  }

  const resolved = resolveInstalledRequiredMods(config, actions);
  if (resolved.added) {
    changed = true;
    if (ensureCommonSensePatchDependency(config, actions)) changed = true;
    for (const mod of config.mods) {
      if (refreshModFromDownloadedFiles(config, mod, actions, { silentBlocked: true })) changed = true;
    }
  }

  const beforeUnresolvedRequirements = JSON.stringify(config.unresolvedRequirements || []);
  const beforeMapFolders = JSON.stringify(config.mapFolders || []);
  rebuildDerivedProfileState(config);
  for (const req of config.unresolvedRequirements || []) {
    actions.push({
      level: "blocked",
      title: `Missing dependency Mod ID: ${req}`,
      details: "No downloaded Workshop item currently exposes this internal Mod ID. Add/download its Workshop item, then troubleshooting will wire it into the profile automatically."
    });
  }
  if (beforeUnresolvedRequirements !== JSON.stringify(config.unresolvedRequirements || [])) changed = true;
  const rebuiltMaps = config.mapFolders || [];
  if (beforeMapFolders !== JSON.stringify(rebuiltMaps)) {
    actions.push({
      level: "fixed",
      title: "Rebuilt Map line from installed Workshop folders",
      details: `Map now contains ${rebuiltMaps.length} folder(s), including vanilla Muldraugh last. Scraped page text was removed.`
    });
    changed = true;
  }

  return { changed, actions };
}

function mergeScannedMods(config, found) {
  config.mods = config.mods || [];
  const byWorkshop = new Map(config.mods.map(mod => [mod.workshopId, mod]));
  let added = 0;
  for (const item of found) {
    const existing = byWorkshop.get(item.workshopId);
    if (existing) {
      existing.modIds = [...new Set([...(existing.modIds || []), item.modId])];
      existing.mapFolders = [...new Set([...(existing.mapFolders || []), ...(item.mapFolders || [])])];
      existing.requiredMods = [...new Set([...(existing.requiredMods || []), ...(item.requiredMods || [])])];
      existing.configFiles = [...new Map([...(existing.configFiles || []), ...(item.configFiles || [])].map(file => [file.path, file])).values()];
      if ((existing.modIds || []).length || (existing.mapFolders || []).length) {
        existing.workshopOnly = false;
        existing.skipWorkshopItem = false;
      }
      if (!existing.title || existing.title.startsWith("Workshop ")) existing.title = item.title;
    } else {
      config.mods.push({
        enabled: true,
        workshopId: item.workshopId,
        title: item.title,
        modIds: [item.modId],
        mapFolders: item.mapFolders || [],
        loadOrder: config.mods.length + 1,
        requiredMods: item.requiredMods || [],
        configFiles: item.configFiles || [],
        workshopPreview: null,
        workshopOnly: false,
        skipWorkshopItem: false,
        notes: ""
      });
      added++;
    }
    for (const folder of item.mapFolders || []) {
      if (!config.mapFolders.includes(folder)) config.mapFolders.unshift(folder);
    }
  }
  return added;
}

function parseWorkshopItems(html) {
  const items = [];
  const blocks = html.split(/<div data-panel="\{&quot;type&quot;:&quot;PanelGroup&quot;\}" class="workshopItem">/g).slice(1);
  for (const block of blocks) {
    const id = (block.match(/data-publishedfileid="(\d+)"/) || [])[1];
    const title = (block.match(/workshopItemTitle ellipsis">([\s\S]*?)<\/div>/) || [])[1];
    const author = (block.match(/workshopItemAuthorName ellipsis">by&nbsp;<a[^>]*>([\s\S]*?)<\/a>/) || [])[1];
    const thumb = (block.match(/workshopItemPreviewImage[^"]*" src="([^"]+)"/) || [])[1];
    const ratingSrc = (block.match(/class="fileRating" src="([^"]+)"/) || [])[1] || "";
    const ratingKey = (ratingSrc.match(/sharedfiles\/([^/.]+)\.png/) || [])[1] || "";
    const rating = ratingKey === "not-yet"
      ? { label: "Not rated yet", stars: 0 }
      : { label: ratingKey ? ratingKey.replace("-", " ") : "Unknown rating", stars: Number((ratingKey.match(/^(\d+)/) || [])[1] || 0) };
    if (!id || !title) continue;
    items.push({
      workshopId: id,
      title: decodeHtml(title),
      author: decodeHtml(author || ""),
      thumb: decodeJsString(thumb || ""),
      rating,
      url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`
    });
  }

  if (!items.length) {
    for (const match of html.matchAll(/<a\s+href="https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/\?id=(\d+)"[^>]*>\s*<img\s+src="([^"]+)"\s+alt="([^"]*)"/gi)) {
      const id = match[1];
      const thumb = decodeJsString(match[2] || "");
      const title = decodeHtml(match[3] || `Workshop ${id}`);
      items.push({
        workshopId: id,
        title,
        author: "",
        thumb,
        rating: { label: "Unknown rating", stars: 0 },
        url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`
      });
    }
  }

  return uniqueBy(items, item => item.workshopId);
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "");
}

function decodeJsString(value) {
  return decodeHtml(String(value || "")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, "\"")
    .replace(/\\u0026/g, "&"));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "PZ-B42-local-server-manager/2.0" } });
  if (!response.ok) {
    if (response.status === 429) markSteamRateLimited("Steam Web");
    const error = new Error(`Steam returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

async function fetchPublishedFileDetails(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))].slice(0, 50);
  if (!uniqueIds.length) return new Map();
  const params = new URLSearchParams();
  params.set("itemcount", String(uniqueIds.length));
  uniqueIds.forEach((id, index) => params.set(`publishedfileids[${index}]`, id));
  try {
    const response = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "PZ-B42-local-server-manager/2.0"
      },
      body: params
    });
    if (!response.ok) {
      if (response.status === 429) markSteamRateLimited("Steam API");
      return new Map();
    }
    const data = await response.json();
    return new Map((data.response?.publishedfiledetails || [])
      .filter(item => item.publishedfileid)
      .map(item => [String(item.publishedfileid), item]));
  } catch {
    return new Map();
  }
}

function enrichRating(rating = {}, detail = {}) {
  const subscriptions = Number(detail.subscriptions || detail.lifetime_subscriptions || 0);
  const favorited = Number(detail.favorited || detail.lifetime_favorited || 0);
  const views = Number(detail.views || 0);
  const votesUp = Number(detail.votes_up || 0);
  const votesDown = Number(detail.votes_down || 0);
  const totalVotes = votesUp + votesDown;
  return {
    ...rating,
    subscriptions,
    favorited,
    views,
    votesUp,
    votesDown,
    percent: totalVotes ? Math.round((votesUp / totalVotes) * 100) : null
  };
}

async function lookupWorkshop(id, options = {}) {
  const detail = await workshopDetails(id, options);
  return {
    workshopId: id,
    title: detail.title,
    modIds: detail.modIds || [],
    requiredWorkshopIds: detail.requiredWorkshopIds || [],
    mapFolders: detail.mapFolders || [],
    cache: detail.cache
  };
}

function parseWorkshopDetails(id, html) {
  const plain = decodeHtml(html);
  const title = decodeHtml((html.match(/<div class="workshopItemTitle">([\s\S]*?)<\/div>/) || [])[1] || `Workshop ${id}`);
  const author = decodeHtml((html.match(/<div class="friendBlockContent">([\s\S]*?)<br>/) || [])[1] || "").trim();
  const mainPreview = decodeJsString((html.match(/id="previewImageMain"[^>]+src="([^"]+)"/) || [])[1] || "");
  const descriptionStart = html.indexOf('id="highlightContent"');
  const descriptionOpen = descriptionStart >= 0 ? html.indexOf(">", descriptionStart) : -1;
  const descriptionEndCandidates = [
    html.indexOf('<div class="workshopItemDescriptionTitle"', descriptionOpen),
    html.indexOf('<div class="rightDetailsBlock"', descriptionOpen),
    html.indexOf('<div class="comments"', descriptionOpen)
  ].filter(index => index > descriptionOpen);
  const descriptionEnd = descriptionEndCandidates.length ? Math.min(...descriptionEndCandidates) : -1;
  const descriptionHtml = descriptionOpen >= 0 && descriptionEnd > descriptionOpen ? html.slice(descriptionOpen + 1, descriptionEnd) : "";
  const description = decodeHtml(descriptionHtml)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1800);
  const modIds = extractModIdsFromWorkshopText(plain);
  const workshopIds = [...plain.matchAll(/Workshop ID:\s*(\d+)/gi)].map(match => match[1]);
  const requiredWorkshopIds = extractRequiredWorkshopIds(id, html, workshopIds);
  const mapFolders = [...plain.matchAll(/Map Folder:\s*([A-Za-z0-9_., '\-()]+)/gi)].map(match => match[1].trim());
  const tags = [...html.matchAll(/<a[^>]+class="[^"]*apphub_CardContentTag[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(match => decodeHtml(match[1]).trim())
    .filter(Boolean);
  const detailRatingSrc = (html.match(/class="fileRating(?:Details)?"[^>]+src="([^"]+)"/) || [])[1] || "";
  const detailRatingKey = (detailRatingSrc.match(/sharedfiles\/([^/.]+)\.png/) || [])[1] || "";
  const rating = detailRatingKey === "not-yet"
    ? { label: "Not rated yet", stars: 0 }
    : { label: detailRatingKey ? detailRatingKey.replace("-", " ") : "Unknown rating", stars: Number((detailRatingKey.match(/^(\d+)/) || [])[1] || 0) };

  const images = [];
  if (mainPreview) images.push({ type: "image", url: mainPreview, thumb: mainPreview, label: "Preview" });

  for (const match of html.matchAll(/\{\s*'previewid'\s*:\s*'([^']+)'\s*,\s*'url'\s*:\s*'([^']+)'/g)) {
    images.push({
      type: "image",
      id: match[1],
      url: decodeJsString(match[2]),
      thumb: "",
      label: "Screenshot"
    });
  }

  const thumbs = new Map();
  for (const match of html.matchAll(/thumb_screenshot_([^"]+)"[\s\S]*?<img src="([^"]+)"/g)) {
    thumbs.set(match[1], decodeJsString(match[2]));
  }
  for (const image of images) {
    if (image.id && thumbs.has(image.id)) image.thumb = thumbs.get(image.id);
  }

  const youtubeIds = [
    ...html.matchAll(/youtubevideoid"?\s*[:=]\s*"?([A-Za-z0-9_-]{8,})/gi),
    ...html.matchAll(/youtube\.com\/embed\/([A-Za-z0-9_-]{8,})/gi),
    ...html.matchAll(/youtu\.be\/([A-Za-z0-9_-]{8,})/gi)
  ].map(match => match[1]);
  const videos = [...new Set(youtubeIds)].map(videoId => ({
    type: "youtube",
    videoId,
    url: `https://www.youtube.com/embed/${videoId}`,
    thumb: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    label: "Video"
  }));

  for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'\s]+?\.(?:mp4|webm)(?:\?[^"'\s]*)?/gi)) {
    videos.push({
      type: "video",
      url: decodeJsString(match[0]),
      thumb: "",
      label: "Video"
    });
  }

  const media = uniqueBy([...videos, ...images], item => item.type + ":" + (item.url || item.videoId));
  return {
    workshopId: id,
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`,
    title,
    author,
    description,
    tags: [...new Set(tags)],
    rating,
    modIds: [...new Set(modIds)],
    requiredWorkshopIds,
    mapFolders: [...new Set(mapFolders)],
    media
  };
}

function detailFromSteamApi(id, apiDetail) {
  if (!apiDetail) return null;
  const description = String(apiDetail.description || "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const modIds = extractModIdsFromWorkshopText(description);
  const workshopIds = [...description.matchAll(/Workshop ID:\s*(\d+)/gi)].map(match => match[1]);
  const mapFolders = [...description.matchAll(/Map Folder:\s*([A-Za-z0-9_., '\-()]+)/gi)].map(match => match[1].trim());
  const thumb = apiDetail.preview_url || "";
  return {
    workshopId: String(id),
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`,
    title: apiDetail.title || `Workshop ${id}`,
    author: "",
    description: description.slice(0, 1800),
    tags: [],
    rating: enrichRating({}, apiDetail),
    fileSize: Number(apiDetail.file_size || 0),
    timeUpdated: Number(apiDetail.time_updated || 0),
    manifest: String(apiDetail.hcontent_file || ""),
    modIds: [...new Set(modIds)],
    requiredWorkshopIds: [...new Set(workshopIds.filter(foundId => foundId !== String(id)))],
    mapFolders: [...new Set(mapFolders)],
    media: thumb ? [{ type: "image", url: thumb, thumb, label: "Preview" }] : []
  };
}

async function workshopDetails(id, options = {}) {
  const cached = readCache("workshop_details", "workshop_id", id);
  const cachedHasModIds = (cached?.value?.modIds || []).length > 0;
  if (cached && !cached.stale && !options.forceRefresh && (cachedHasModIds || options.allowIncompleteCache)) {
    return markCacheSource(cached.value, "cache", cached);
  }

  try {
    const html = await fetchText(`https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`);
    const detail = parseWorkshopDetails(id, html);
    const apiDetail = (await fetchPublishedFileDetails([id])).get(String(id));
    if (apiDetail) {
      detail.title = apiDetail.title || detail.title;
      detail.description = detail.description || String(apiDetail.description || "").replace(/\[[^\]]+\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1800);
      detail.rating = enrichRating(detail.rating, apiDetail);
      if (!detail.media.length && apiDetail.preview_url) {
        detail.media.push({ type: "image", url: apiDetail.preview_url, thumb: apiDetail.preview_url, label: "Preview" });
      }
    }
    writeCache("workshop_details", "workshop_id", id, detail);
    return markCacheSource(detail, "steam", { fetchedAt: Date.now(), stale: false });
  } catch (error) {
    const apiDetail = (await fetchPublishedFileDetails([id])).get(String(id));
    const apiFallback = detailFromSteamApi(id, apiDetail);
    if (apiFallback && (apiFallback.modIds.length || apiFallback.title !== `Workshop ${id}` || apiFallback.media.length)) {
      writeCache("workshop_details", "workshop_id", id, apiFallback);
      addChange("Used Steam API Workshop fallback", { workshopId: id, reason: error.message });
      return markCacheSource(apiFallback, "steam-api", { fetchedAt: Date.now(), stale: false });
    }
    if (cached) {
      addChange("Used cached Steam Workshop detail", { workshopId: id, reason: error.message });
      return markCacheSource(cached.value, "stale-cache", cached);
    }
    const fallback = fallbackWorkshopDetailFromLocalConfig(id);
    if (fallback) {
      addChange("Used local Workshop detail fallback", { workshopId: id, reason: error.message });
      return markCacheSource(fallback, "local-config", { fetchedAt: Date.now(), stale: true });
    }
    throw error;
  }
}

function extractRequiredWorkshopIds(id, html, fallbackIds = []) {
  const ids = new Set(fallbackIds.filter(foundId => foundId !== id));
  const requiredMarkers = [
    "Required items",
    "This item requires all of the following",
    "requiredItems"
  ];

  for (const marker of requiredMarkers) {
    let start = html.indexOf(marker);
    while (start >= 0) {
      const chunk = html.slice(start, start + 16000);
      for (const match of chunk.matchAll(/sharedfiles\/filedetails\/\?id=(\d+)/g)) {
        if (match[1] !== id) ids.add(match[1]);
      }
      start = html.indexOf(marker, start + marker.length);
    }
  }

  return [...ids];
}

function workshopPreviewSummary(detail) {
  return {
    workshopId: detail.workshopId,
    title: detail.title,
    author: detail.author,
    thumb: detail.media?.find(item => item.thumb)?.thumb || detail.media?.[0]?.url || "",
    rating: detail.rating,
    mediaCount: detail.media?.length || 0
  };
}

function upsertWorkshopMod(config, detail, dependencyOf = "") {
  config.mods = config.mods || [];
  config.mapFolders = config.mapFolders || ["Muldraugh, KY"];
  const existing = config.mods.find(mod => mod.workshopId === detail.workshopId);
  const mod = existing || {
    enabled: true,
    workshopId: detail.workshopId,
    title: detail.title || `Workshop ${detail.workshopId}`,
    modIds: [],
    mapFolders: [],
    loadOrder: config.mods.length + 1,
    requiredMods: [],
    configFiles: [],
    workshopPreview: null,
    workshopOnly: false,
    skipWorkshopItem: false,
    notes: ""
  };

  mod.enabled = true;
  mod.title = detail.title || mod.title;
  if ((detail.modIds || []).length) mod.modIds = [...new Set(detail.modIds)];
  mod.mapFolders = [...new Set([...(mod.mapFolders || []), ...(detail.mapFolders || [])])];
  mod.workshopPreview = workshopPreviewSummary(detail);
  if ((mod.modIds || []).length || (mod.mapFolders || []).length) {
    mod.workshopOnly = false;
    mod.skipWorkshopItem = false;
  }
  if (dependencyOf && !mod.notes.includes(dependencyOf)) {
    mod.notes = [mod.notes, `Dependency for Workshop ${dependencyOf}`].filter(Boolean).join("\n");
  }

  if (!existing) config.mods.push(mod);
  for (const folder of mod.mapFolders) {
    if (folder && !config.mapFolders.includes(folder)) config.mapFolders.unshift(folder);
  }
  return !existing;
}

async function addWorkshopWithDependencies(config, workshopId) {
  const rule = SPECIAL_WORKSHOP_RULES.commonSensePatch;
  const queue = [{ id: workshopId, dependencyOf: "" }];
  if (String(workshopId) === rule.patchWorkshopId) {
    queue.push({ id: rule.requiredWorkshopId, dependencyOf: rule.patchWorkshopId });
  }
  const visited = new Set();
  const resolved = [];
  const failed = [];
  const maxItems = 16;

  for (let cursor = 0; cursor < queue.length && cursor < maxItems; cursor++) {
    const item = queue[cursor];
    if (!item.id || visited.has(item.id)) continue;
    visited.add(item.id);

    try {
      const detail = await workshopDetails(item.id, { requireModIds: true });
      for (const requiredId of detail.requiredWorkshopIds || []) {
        if (!visited.has(requiredId) && !queue.some(queued => queued.id === requiredId)) {
          queue.push({ id: requiredId, dependencyOf: item.id });
        }
      }
      resolved.push({ detail, dependencyOf: item.dependencyOf });
    } catch (error) {
      failed.push({ workshopId: item.id, error: error.message });
    }
  }

  let added = 0;
  for (const item of resolved.reverse()) {
    if (upsertWorkshopMod(config, item.detail, item.dependencyOf)) added++;
  }
  const ruleActions = [];
  if (ensureCommonSensePatchDependency(config, ruleActions)) added += ruleActions.filter(action => action.title.startsWith("Added ")).length;
  config.mods = (config.mods || []).map((mod, index) => ({ ...mod, loadOrder: index + 1 }));

  return {
    added,
    resolved: resolved.map(item => ({
      workshopId: item.detail.workshopId,
      title: item.detail.title,
      dependencyOf: item.dependencyOf
    })).reverse(),
    failed,
    actions: ruleActions
  };
}

async function addWorkshopIdsToConfig(config, workshopIds) {
  const ids = [...new Set((workshopIds || []).map(id => String(id || "").trim()).filter(Boolean))];
  const resolved = [];
  const failed = [];
  let added = 0;
  for (const id of ids) {
    try {
      const result = await addWorkshopWithDependencies(config, id);
      added += result.added || 0;
      resolved.push(...(result.resolved || []));
      failed.push(...(result.failed || []));
    } catch (error) {
      failed.push({ workshopId: id, error: error.message });
    }
  }
  config.mods = (config.mods || []).map((mod, index) => ({ ...mod, loadOrder: index + 1 }));
  return { requested: ids, added, resolved, failed };
}

async function importModListIntoConfig(config, text) {
  const parsed = parseImportedModListText(text);
  if (!parsed.workshopIds.length && !parsed.modIds.length) {
    throw new Error("No Workshop IDs or internal Mod IDs were found in that import text.");
  }
  const workshopResult = await addWorkshopIdsToConfig(config, parsed.workshopIds);
  const found = scanDownloadedMods(config);
  const byModId = new Map();
  for (const item of found) {
    if (item.modId && !byModId.has(item.modId)) byModId.set(item.modId, item);
  }

  const missingModIds = [];
  const scannedMatches = [];
  for (const modId of parsed.modIds) {
    if (activeInternalModIds(config).has(modId)) continue;
    const item = byModId.get(modId);
    if (!item) {
      missingModIds.push(modId);
      continue;
    }
    scannedMatches.push(item);
  }
  const scannedAdded = scannedMatches.length ? mergeScannedMods(config, scannedMatches) : 0;
  const actions = [];
  for (const mod of config.mods || []) refreshModFromDownloadedFiles(config, mod, actions, { silentBlocked: true });
  troubleshootConfig(config);
  rebuildDerivedProfileState(config);
  config.mods = (config.mods || []).map((mod, index) => ({ ...mod, loadOrder: index + 1 }));

  return {
    parsed,
    added: (workshopResult.added || 0) + scannedAdded,
    workshop: workshopResult,
    matchedModIds: scannedMatches.map(item => ({ modId: item.modId, workshopId: item.workshopId, title: item.title })),
    missingModIds,
    actions
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/config") return json(res, 200, loadConfig());
  if (req.method === "GET" && pathname === "/api/setup") {
    const config = loadConfig();
    const detectedSteamDir = detectSteamDir();
    const detectedPzGameDir = detectPzGameDir(config.steamDir || detectedSteamDir);
    return json(res, 200, {
      appDataDir: APP_DATA_DIR,
      localDataDir: LOCAL_DATA_DIR,
      configPath: CONFIG_PATH,
      detected: {
        steamDir: detectedSteamDir,
        pzGameDir: detectedPzGameDir,
        pzServerDir: defaultPzServerDir(),
        steamFound: Boolean((config.steamDir || detectedSteamDir) && fs.existsSync(config.steamDir || detectedSteamDir)),
        pzGameFound: Boolean((config.pzGameDir || detectedPzGameDir) && fs.existsSync(config.pzGameDir || detectedPzGameDir)),
        pzServerFound: Boolean((config.pzServerDir || defaultPzServerDir()) && fs.existsSync(config.pzServerDir || defaultPzServerDir()))
      },
      config
    });
  }
  if (req.method === "GET" && pathname === "/api/profiles") {
    const config = loadConfig();
    return json(res, 200, { dir: config.pzServerDir || defaultPzServerDir(), profiles: listServerProfiles(config) });
  }
  if (req.method === "GET" && pathname === "/api/recommended") return json(res, 200, readJson(RECOMMENDED_PATH, { items: [], maps: [] }));
  if (req.method === "GET" && pathname === "/api/changes") return json(res, 200, { entries: readChanges() });
  if (req.method === "GET" && pathname === "/api/files") return json(res, 200, readProfileFiles(loadConfig()));
  if (req.method === "GET" && pathname === "/api/server/players") return json(res, 200, readKnownPlayers(loadConfig()));
  if (req.method === "GET" && pathname === "/api/log") {
    const config = loadConfig();
    const pzProcesses = findPzServerProcesses(config);
    const dedicatedServerRunning = Boolean(gameProcess) || pzProcesses.some(proc => !proc.coop);
    return json(res, 200, {
      activeJob: Boolean(activeJob),
      serverRunning: dedicatedServerRunning,
      dedicatedServerRunning,
      managerTestRunning: Boolean(gameProcess),
      hostGameRunning: isProjectZomboidGameRunning(config),
      steamApiRateLimited: isSteamRateLimited(),
      lines: jobLog,
      diagnostics: diagnoseServerLog(latestServerLogText(), config)
    });
  }

  if (req.method === "POST" && pathname === "/api/config") {
    const incoming = await readBody(req);
    const current = loadConfig();
    if (configWithoutPreviewNoise(incoming) === configWithoutPreviewNoise(current)) return json(res, 200, current);
    return json(res, 200, saveConfig(incoming, "Saved configuration", { expectedRevision: incoming.revision || 0 }));
  }

  if (req.method === "POST" && pathname === "/api/setup") {
    const incoming = await readBody(req);
    const config = loadConfig();
    for (const key of ["steamDir", "pzGameDir", "pzServerDir", "steamCmdDir", "serverDir", "serverName", "publicName", "betaBranch"]) {
      if (typeof incoming[key] === "string") config[key] = incoming[key].trim();
    }
    for (const key of ["memoryMb", "defaultPort", "udpPort", "steamPort1", "steamPort2", "maxPlayers"]) {
      if (incoming[key] !== undefined) config[key] = Number(incoming[key] || config[key] || 0);
    }
    fs.mkdirSync(config.pzServerDir || defaultPzServerDir(), { recursive: true });
    const next = saveConfig(config, "Saved manager settings");
    return json(res, 200, { config: next, setup: { appDataDir: APP_DATA_DIR, localDataDir: LOCAL_DATA_DIR, configPath: CONFIG_PATH } });
  }

  if (req.method === "POST" && pathname === "/api/profile/load") {
    const body = await readBody(req);
    return json(res, 200, loadProfileIntoConfig(body.name));
  }

  if (req.method === "POST" && pathname === "/api/profile/create") {
    const body = await readBody(req);
    const result = createHostProfile(body.name, { fresh: Boolean(body.fresh) });
    return json(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/files") {
    const body = await readBody(req);
    saveProfileFiles(loadConfig(), body.files || {});
    return json(res, 200, readProfileFiles(loadConfig()));
  }

  if (req.method === "POST" && pathname === "/api/server/access") {
    const config = loadConfig();
    const body = await readBody(req);
    setPlayerAccess(config, body.username, body.role);
    return json(res, 200, readKnownPlayers(config));
  }

  if (req.method === "POST" && pathname === "/api/apply") {
    const config = loadConfig();
    const iniPath = applyConfigToIni(config);
    return json(res, 200, { iniPath, lines: buildServerLines(config) });
  }

  if (req.method === "POST" && pathname === "/api/game/launch") {
    const config = loadConfig();
    const troubleshooting = troubleshootConfig(config);
    if (troubleshooting.changed) saveConfig(config, "Troubleshot server mod list before Host launch");
    applyConfigToIni(config);
    await prepareWorkshopLaunchFolders(config);
    stopOrphanDedicatedServers(config);
    spawn("cmd.exe", ["/c", "start", "", "steam://run/108600"], { windowsHide: true, detached: true });
    addChange("Launched Project Zomboid through Steam", { mode: "Host menu" });
    return json(res, 202, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/install/steamcmd") {
    const config = loadConfig();
    runPowershell(path.join(ROOT, "scripts", "install-steamcmd.ps1"), ["-SteamCmdDir", config.steamCmdDir]);
    return json(res, 202, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/install/server") {
    const config = loadConfig();
    runPowershell(path.join(ROOT, "scripts", "install-server.ps1"), [
      "-SteamCmdDir", config.steamCmdDir,
      "-ServerDir", config.serverDir,
      "-BetaBranch", config.betaBranch
    ]);
    return json(res, 202, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/workshop/steamcmd-sync") {
    const config = loadConfig();
    const body = await readBody(req);
    const ids = (body.workshopIds && body.workshopIds.length) ? body.workshopIds : enabledWorkshopIds(config);
    const steamCmd = downloadWorkshopItemsWithSteamCmd(config, ids);
    const workshopSync = await prepareWorkshopLaunchFolders(config, { forceSteamCmd: false });
    return json(res, 200, { ok: !steamCmd.failed.length && !workshopSync.missing.length, steamCmd, workshopSync });
  }

  if (req.method === "POST" && pathname === "/api/firewall") {
    const config = loadConfig();
    runPowershell(path.join(ROOT, "scripts", "open-firewall.ps1"), [
      "-DefaultPort", String(config.defaultPort),
      "-UdpPort", String(config.udpPort),
      "-SteamPort1", String(config.steamPort1),
      "-SteamPort2", String(config.steamPort2)
    ]);
    return json(res, 202, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/server/start") {
    const config = loadConfig();
    try {
      const troubleshooting = troubleshootConfig(config);
      if (troubleshooting.changed) saveConfig(config, "Troubleshot server mod list");
      await prepareWorkshopLaunchFolders(config, { throwOnMissing: true });
      repairLastServerFailure(config, "before dedicated start");
      startDedicatedServer(config, { hidden: false });
    } catch (error) {
      return json(res, error.message.includes("already running") ? 409 : 400, { error: error.message });
    }
    return json(res, 202, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/server/test-mods") {
    const config = loadConfig();
    try {
      const troubleshooting = troubleshootConfig(config);
      if (troubleshooting.changed) saveConfig(config, "Troubleshot server mod list");
      const workshopSync = await prepareWorkshopLaunchFolders(config, { throwOnMissing: true });
      const repair = repairLastServerFailure(config, "before headless mod test");
      const started = startDedicatedServer(config, { hidden: true, label: "Testing mods on headless dedicated server" });
      const mods = String(sortedEnabledMods(config).length);
      addChange("Started headless mod test server", { server: config.serverName, mods, pid: String(started.pid || "") });
      return json(res, 202, { ok: true, message: `Test server started with ${mods} mods`, pid: started.pid, troubleshooting, repair, workshopSync });
    } catch (error) {
      if (error.message.includes("already running")) {
        return json(res, 200, { ok: true, message: "Test server is already running" });
      }
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && pathname === "/api/server/stop") {
    const config = loadConfig();
    const stopped = stopOrphanDedicatedServers(config);
    if (gameProcess) {
      gameProcess.kill();
      gameProcess = null;
    }
    addChange("Stopped dedicated server");
    return json(res, 200, { ok: true, stopped });
  }

  if (req.method === "POST" && pathname === "/api/server/repair-last-failure") {
    const config = loadConfig();
    const result = repairLastServerFailure(config, "manual repair");
    return json(res, 200, result);
  }

  if (req.method === "POST" && pathname === "/api/mods/scan") {
    const config = loadConfig();
    const body = await readBody(req);
    const found = scanDownloadedMods(config);
    const activeWorkshopIds = new Set((config.mods || []).map(mod => String(mod.workshopId || "")).filter(Boolean));
    const mergeTargets = body.includeAllDownloaded ? found : found.filter(item => activeWorkshopIds.has(String(item.workshopId)));
    const added = mergeScannedMods(config, mergeTargets);
    const troubleshooting = troubleshootConfig(config);
    saveConfig(config, body.includeAllDownloaded ? "Scanned all downloaded Workshop mods" : "Refreshed active Workshop mods");
    applyConfigToIni(config);
    const workshopSync = await prepareWorkshopLaunchFolders(config);
    if (troubleshooting.actions.length) {
      addChange("Resolved mod load issues", { server: config.serverName, fixed: String(troubleshooting.actions.filter(action => action.level === "fixed").length) });
    }
    return json(res, 200, { found, added, troubleshooting, workshopSync, config });
  }

  if (req.method === "POST" && pathname === "/api/troubleshoot/fix") {
    const config = loadConfig();
    const result = troubleshootConfig(config);
    const next = result.changed ? saveConfig(config, "Troubleshot server mod list") : config;
    if (result.changed) applyConfigToIni(next);
    addChange("Ran troubleshooting engine", {
      server: next.serverName,
      fixed: String(result.actions.filter(action => action.level === "fixed").length),
      blocked: String(result.actions.filter(action => action.level === "blocked").length)
    });
    return json(res, 200, { ...result, config: ensureConfigShape(next) });
  }

  if (req.method === "POST" && pathname === "/api/mods/add-workshop") {
    const body = await readBody(req);
    const workshopId = String(body.workshopId || "").trim();
    const workshopIds = extractWorkshopIds(workshopId);
    if (!workshopIds.length) return json(res, 400, { error: "Paste a valid Steam Workshop ID, URL, or comma-separated list." });
    const config = loadConfig();
    const result = workshopIds.length === 1
      ? await addWorkshopWithDependencies(config, workshopIds[0])
      : await addWorkshopIdsToConfig(config, workshopIds);
    troubleshootConfig(config);
    const next = saveConfig(config, "Added Workshop mod and dependencies");
    const iniPath = applyConfigToIni(next);
    const workshopSync = await prepareWorkshopLaunchFolders(next);
    addChange("Updated local Host profile for Workshop mod", {
      server: next.serverName,
      workshopId: workshopIds.join(";"),
      added: String(result.added),
      file: iniPath
    });
    return json(res, 200, { ...result, config: next, iniPath, workshopSync });
  }

  if (req.method === "POST" && pathname === "/api/mods/import-list") {
    const body = await readBody(req);
    const config = loadConfig();
    const result = await importModListIntoConfig(config, body.text || "");
    const next = saveConfig(config, "Imported mod list into Host profile");
    const iniPath = applyConfigToIni(next);
    const workshopSync = await prepareWorkshopLaunchFolders(next);
    addChange("Converted imported mod list for server", {
      server: next.serverName,
      workshopIds: String(result.parsed.workshopIds.length),
      modIds: String(result.parsed.modIds.length),
      missing: String(result.missingModIds.length),
      file: iniPath
    });
    return json(res, 200, { ...result, config: next, iniPath, workshopSync });
  }

  if (req.method === "POST" && pathname === "/api/mods/remove-workshop") {
    const body = await readBody(req);
    return json(res, 200, removeWorkshopModFromConfig(loadConfig(), body.workshopId));
  }

  if (req.method === "POST" && pathname === "/api/workshop/search") {
    const body = await readBody(req);
    const days = Number(body.days || 90);
    const directWorkshopId = (String(body.query || "").match(/(?:id=|^|\D)(\d{6,})(?:\D|$)/) || [])[1] || "";
    if (directWorkshopId) {
      const detail = await workshopDetails(directWorkshopId, { allowIncompleteCache: true });
      const item = {
        workshopId: detail.workshopId,
        title: detail.title || `Workshop ${directWorkshopId}`,
        author: detail.author || "",
        thumb: detail.media?.find(media => media.thumb)?.thumb || detail.media?.[0]?.url || "",
        rating: detail.rating || { label: "Unknown rating", stars: 0 },
        url: detail.url || `https://steamcommunity.com/sharedfiles/filedetails/?id=${directWorkshopId}`
      };
      return json(res, 200, markCacheSource({ url: item.url, items: [item] }, detail.cache?.source || "direct", { fetchedAt: Date.now(), stale: false }));
    }
    const tags = (body.tags || ["Build 42"]).map(tag => `requiredtags%5B%5D=${encodeURIComponent(tag).replace(/%20/g, "+")}`).join("&");
    const sort = body.sort || "toprated";
    const query = body.query ? `&searchtext=${encodeURIComponent(body.query)}` : "";
    const url = `https://steamcommunity.com/workshop/browse/?appid=108600&${tags}${query}&browsesort=${sort}&section=readytouseitems&actualsort=${sort}&p=1&days=${days}`;
    const cacheKey = JSON.stringify({ tags: body.tags || ["Build 42"], sort, days, query: body.query || "" });
    const cached = readCache("workshop_searches", "cache_key", cacheKey);
    const emptyTypedCache = body.query && !(cached?.value?.items || []).length;
    if (cached && !cached.stale && !body.forceRefresh && !emptyTypedCache) {
      return json(res, 200, markCacheSource(cached.value, "cache", cached));
    }
    try {
      const html = await fetchText(url);
      const items = parseWorkshopItems(html);
      const details = await fetchPublishedFileDetails(items.map(item => item.workshopId));
      for (const item of items) {
        const detail = details.get(String(item.workshopId));
        if (!detail) continue;
        item.rating = enrichRating(item.rating, detail);
        item.title = detail.title || item.title;
        item.thumb = detail.preview_url || item.thumb;
      }
      const value = { url, items };
      writeCache("workshop_searches", "cache_key", cacheKey, value);
      return json(res, 200, markCacheSource(value, "steam", { fetchedAt: Date.now(), stale: false }));
    } catch (error) {
      if (cached) {
        addChange("Used cached Steam Workshop search", { reason: error.message });
        return json(res, 200, markCacheSource(cached.value, "stale-cache", cached));
      }
      throw error;
    }
  }

  const details = pathname.match(/^\/api\/workshop\/(\d+)\/details$/);
  if (req.method === "GET" && details) {
    const forceRefresh = new URL(req.url, `http://${req.headers.host}`).searchParams.get("refresh") === "1";
    return json(res, 200, await workshopDetails(details[1], { forceRefresh }));
  }

  const thumb = pathname.match(/^\/api\/workshop\/(\d+)\/thumb$/);
  if (req.method === "GET" && thumb) {
    const detail = await workshopDetails(thumb[1], { allowIncompleteCache: true });
    return json(res, 200, {
      workshopId: detail.workshopId,
      title: detail.title,
      author: detail.author,
      thumb: detail.media?.find(item => item.thumb)?.thumb || detail.media?.[0]?.url || "",
      rating: detail.rating,
      mediaCount: detail.media?.length || 0,
      cache: detail.cache
    });
  }

  const lookup = pathname.match(/^\/api\/workshop\/(\d+)$/);
  if (req.method === "GET" && lookup) return json(res, 200, await lookupWorkshop(lookup[1]));

  return json(res, 404, { error: "Not found" });
}

function serveStatic(req, res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const full = path.normalize(path.join(ROOT, "public", file));
  if (!full.startsWith(path.join(ROOT, "public"))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
  res.writeHead(200, {
    "content-type": `${types[path.extname(full)] || "application/octet-stream"}; charset=utf-8`,
    "cache-control": "no-store"
  });
  fs.createReadStream(full).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) log(`Error: ${err.stack || err.message}`);
    return json(res, status, { error: err.message });
  }
}).listen(PORT, () => {
  log(`Project Zomboid local server mod manager running at http://localhost:${PORT}`);
});
