let config = null;
let profiles = [];
let files = {};
let recommendedItems = [];
let recommendedSource = "";
let lastLogStatus = { lines: [], serverRunning: false };
let setupInfo = null;

const $ = id => document.getElementById(id);
const $$ = selector => Array.from(document.querySelectorAll(selector));

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function splitList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map(item => item.trim().replace(/^\\+/, "").replace(/^require\s*=\s*/i, ""))
    .filter(Boolean);
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function fillForm() {
  if ($("currentProfileName")) $("currentProfileName").textContent = config.serverName || "No profile";
  for (const id of ["serverName", "publicName", "serverPassword", "maxPlayers", "defaultPort", "udpPort", "memoryMb", "steamDir", "pzGameDir", "pzServerDir", "steamCmdDir", "serverDir"]) {
    if ($(id)) $(id).value = config[id] ?? "";
  }
}

function collectForm() {
  for (const id of ["serverName", "publicName", "serverPassword", "steamDir", "pzGameDir", "pzServerDir", "steamCmdDir", "serverDir"]) {
    if ($(id)) config[id] = $(id).value.trim();
  }
  for (const id of ["maxPlayers", "defaultPort", "udpPort", "memoryMb"]) {
    if ($(id)) config[id] = Number($(id).value || config[id] || 0);
  }
}

async function saveConfig(reason) {
  collectForm();
  normalizeLoadOrder();
  config = await api("/api/config", { method: "POST", body: config });
  if (reason !== "quiet") {
    await api("/api/apply", { method: "POST" });
    await loadFiles().catch(() => {});
  }
  renderAll();
  if (reason !== "quiet") await refreshChanges();
}

function normalizeLoadOrder() {
  config.mods = (config.mods || []).map((mod, index) => ({ ...mod, loadOrder: index + 1 }));
}

function activeMods() {
  return (config.mods || []).filter(mod => mod.enabled !== false);
}

function activeMaps() {
  const maps = [];
  for (const mod of activeMods()) maps.push(...(mod.mapFolders || []));
  maps.push(...(config.mapFolders || []));
  return unique(maps.filter(map => map !== "Muldraugh, KY")).concat("Muldraugh, KY");
}

function renderAll() {
  renderMods();
  renderMaps();
  renderWarnings();
  $("modCount").textContent = String(activeMods().length);
  $("mapCount").textContent = String(activeMaps().length);
  if ($("currentProfileName")) $("currentProfileName").textContent = config.serverName || "No profile";
}

function renderWarnings() {
  const warnings = [];
  for (const req of config.unresolvedRequirements || []) {
    warnings.push(`Missing downloaded dependency: ${req}`);
  }
  for (const mod of activeMods()) {
    if (!mod.workshopId) {
      warnings.push(`${mod.title}: missing Workshop ID`);
      continue;
    }
  }
  $("warnings").innerHTML = warnings.map(text => `<div>${escapeHtml(text)}</div>`).join("");
}

function renderMods() {
  const list = $("modsList");
  list.innerHTML = "";
  const mods = config.mods || [];
  if (!mods.length) {
    list.innerHTML = `<div class="empty">No mods yet. Scan downloaded mods or add a Workshop item.</div>`;
    return;
  }
  mods.forEach((mod, index) => {
    const row = document.createElement("article");
    row.className = `mod-row ${mod.enabled === false ? "disabled" : ""}`;
    row.innerHTML = `
      <button class="mod-thumb" data-action="preview" title="Open Steam-style Workshop preview" ${mod.workshopId ? "" : "disabled"}>
        ${renderThumbContent(mod)}
      </button>
      <div class="mod-main">
        <div class="mod-heading">
          <button class="title-preview" data-action="preview-title" title="Open Steam-style Workshop preview" ${mod.workshopId ? "" : "disabled"}>${escapeHtml(mod.title || "Untitled mod")}</button>
          <span class="rating-badge">${escapeHtml(formatRating(mod.workshopPreview?.rating))}</span>
        </div>
        <div class="mod-subline">${renderModSubline(mod)}</div>
        <details class="mod-details">
          <summary>Details</summary>
          <label>Local name <input class="title-input" value="${escapeAttr(mod.title || "")}" placeholder="Mod title"></label>
          <div class="mod-fields">
            <label>Workshop ID <input data-field="workshopId" value="${escapeAttr(mod.workshopId || "")}"></label>
            <label>Mod IDs <input data-field="modIds" value="${escapeAttr((mod.modIds || []).join(";"))}"></label>
            <label>Map folders <input data-field="mapFolders" value="${escapeAttr((mod.mapFolders || []).join(";"))}"></label>
            <label>Requires <input data-field="requiredMods" value="${escapeAttr((mod.requiredMods || []).join(";"))}"></label>
          </div>
          <textarea data-field="notes" placeholder="Notes, JSON setup, sandbox options, load order warning">${escapeHtml(mod.notes || "")}</textarea>
          ${renderConfigFileHints(mod)}
        </details>
      </div>
      <div class="row-tools">
        <label class="compact-toggle"><input type="checkbox" ${mod.enabled !== false ? "checked" : ""} aria-label="Enable ${escapeHtml(mod.title)}"> On</label>
        <button data-action="up" title="Move up">↑</button>
        <button data-action="down" title="Move down">↓</button>
        <button data-action="delete" title="Remove">Remove</button>
      </div>
    `;
    row.querySelector(".compact-toggle input").addEventListener("change", event => {
      mod.enabled = event.target.checked;
      saveConfig().catch(alertError);
    });
    row.querySelector(".title-input").addEventListener("change", event => {
      mod.title = event.target.value.trim();
      saveConfig().catch(alertError);
    });
    row.querySelectorAll("[data-field]").forEach(input => {
      input.addEventListener("change", event => {
        const field = event.target.dataset.field;
        if (["modIds", "mapFolders", "requiredMods"].includes(field)) mod[field] = splitList(event.target.value);
        else mod[field] = event.target.value.trim();
        saveConfig().catch(alertError);
      });
    });
    row.querySelector("[data-action='up']").addEventListener("click", () => moveMod(index, -1));
    row.querySelector("[data-action='down']").addEventListener("click", () => moveMod(index, 1));
    const previewButton = row.querySelector(".mod-thumb");
    previewButton.addEventListener("click", () => openWorkshopPreview(mod.workshopId).catch(alertError));
    const titlePreview = row.querySelector(".title-preview");
    titlePreview.addEventListener("click", () => openWorkshopPreview(mod.workshopId).catch(alertError));
    row.querySelector("[data-action='delete']").addEventListener("click", () => {
      config.mods.splice(index, 1);
      saveConfig().catch(alertError);
    });
    list.appendChild(row);
    hydrateThumb(mod, previewButton).catch(() => {});
  });
}

function renderModSubline(mod) {
  const bits = [];
  if (mod.modIds?.length) bits.push(mod.modIds.slice(0, 2).join(", "));
  if (mod.mapFolders?.length) bits.push(`${mod.mapFolders.length} map folder${mod.mapFolders.length === 1 ? "" : "s"}`);
  if (mod.workshopOnly) bits.push("Workshop dependency");
  return bits.length ? escapeHtml(bits.join(" | ")) : "Ready";
}

function renderThumbContent(mod) {
  const thumb = mod.workshopPreview?.thumb;
  if (thumb) return `<img src="${escapeAttr(thumb)}" alt="">`;
  return `<span>${escapeHtml(mod.workshopId ? "Load preview" : "No ID")}</span>`;
}

async function hydrateThumb(mod, button) {
  if (!mod.workshopId || mod.workshopPreview?.thumb || button.dataset.loading === "true") return;
  button.dataset.loading = "true";
  const detail = await api(`/api/workshop/${encodeURIComponent(mod.workshopId)}/thumb`);
  mod.workshopPreview = detail;
  button.innerHTML = renderThumbContent(mod);
  button.dataset.loading = "false";
  saveConfig("quiet").catch(() => {});
}

function renderConfigFileHints(mod) {
  const files = mod.configFiles || [];
  if (!files.length) return "";
  return `<details class="file-hints"><summary>${files.length} detected mod data file${files.length === 1 ? "" : "s"}</summary>${files.map(file => `
    <div><code>${escapeHtml(file.relativePath || file.path)}</code> <span>${Math.round((file.size || 0) / 1024)} KB</span></div>
  `).join("")}</details>`;
}

function moveMod(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= config.mods.length) return;
  const [item] = config.mods.splice(index, 1);
  config.mods.splice(next, 0, item);
  saveConfig().catch(alertError);
}

function renderMaps() {
  const target = $("mapList");
  const maps = activeMaps();
  target.innerHTML = maps.map((map, index) => `
    <div class="map-row">
      <span>${index + 1}</span>
      <input value="${escapeAttr(map)}" ${map === "Muldraugh, KY" ? "disabled" : ""} data-index="${index}">
      <button data-index="${index}" ${map === "Muldraugh, KY" ? "disabled" : ""}>Remove</button>
    </div>
  `).join("");
  target.querySelectorAll("input:not(:disabled)").forEach(input => {
    input.addEventListener("change", event => {
      const old = maps[Number(event.target.dataset.index)];
      const next = event.target.value.trim();
      config.mapFolders = (config.mapFolders || []).map(map => map === old ? next : map);
      for (const mod of config.mods || []) mod.mapFolders = (mod.mapFolders || []).map(map => map === old ? next : map);
      saveConfig().catch(alertError);
    });
  });
  target.querySelectorAll("button:not(:disabled)").forEach(button => {
    button.addEventListener("click", event => {
      const old = maps[Number(event.target.dataset.index)];
      config.mapFolders = (config.mapFolders || []).filter(map => map !== old);
      for (const mod of config.mods || []) mod.mapFolders = (mod.mapFolders || []).filter(map => map !== old);
      saveConfig().catch(alertError);
    });
  });
}

function addBlankMod() {
  config.mods = config.mods || [];
  config.mods.push({
    enabled: true,
    workshopId: "",
    title: "New mod",
    modIds: [],
    mapFolders: [],
    requiredMods: [],
    configFiles: [],
    workshopPreview: null,
    notes: "",
    loadOrder: config.mods.length + 1
  });
  saveConfig().catch(alertError);
}

async function loadProfiles() {
  const data = await api("/api/profiles");
  profiles = data.profiles || [];
  $("profileSelect").innerHTML = profiles.length ? profiles.map(profile => `
    <option value="${escapeAttr(profile.name)}" ${profile.name === config.serverName ? "selected" : ""}>${escapeHtml(profile.name)}</option>
  `).join("") : `<option value="">No Host profiles found</option>`;
}

async function loadSelectedProfile() {
  const name = $("profileSelect").value;
  if (!name) return;
  config = await api("/api/profile/load", { method: "POST", body: { name } });
  fillForm();
  renderAll();
  await loadFiles();
  await refreshChanges();
}

async function createProfile() {
  const input = $("newProfileName");
  const name = input.value.trim() || config.serverName || "FriendsB42";
  const data = await api("/api/profile/create", { method: "POST", body: { name } });
  config = data.config;
  input.value = "";
  fillForm();
  renderAll();
  await loadProfiles();
  await loadFiles();
  await refreshChanges();
  showToast("Profile created!");
}

async function loadSetup() {
  setupInfo = await api("/api/setup");
  config = setupInfo.config || config;
  fillForm();
  renderSetupSummary();
}

function renderSetupSummary() {
  if (!$("setupSummary") || !setupInfo) return;
  const detected = setupInfo.detected || {};
  $("setupSummary").innerHTML = `
    <div><strong>App data</strong><span>${escapeHtml(setupInfo.appDataDir || "")}</span></div>
    <div><strong>Steam</strong><span class="${detected.steamFound ? "ok" : "warn"}">${escapeHtml(config.steamDir || detected.steamDir || "Not found")}</span></div>
    <div><strong>Project Zomboid</strong><span class="${detected.pzGameFound ? "ok" : "warn"}">${escapeHtml(config.pzGameDir || detected.pzGameDir || "Not found")}</span></div>
    <div><strong>Host profiles</strong><span class="${detected.pzServerFound ? "ok" : "warn"}">${escapeHtml(config.pzServerDir || detected.pzServerDir || "Will be created")}</span></div>
  `;
}

async function saveSettings() {
  collectForm();
  const data = await api("/api/setup", { method: "POST", body: config });
  config = data.config;
  await loadSetup();
  await loadProfiles();
  renderAll();
  showToast("Settings saved!");
}

async function addWorkshopMod(workshopId, button) {
  if (!workshopId) return;
  const activeTabName = document.querySelector(".tab.active")?.dataset.tab || "workshop";
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Adding...";
  }
  try {
    await saveConfig("quiet");
    const data = await api("/api/mods/add-workshop", { method: "POST", body: { workshopId } });
    config = data.config;
    fillForm();
    renderAll();
    if (recommendedItems.length) showRecommended(recommendedItems, recommendedSource);
    switchTab(activeTabName);
    await loadFiles();
    await refreshChanges();
    if ($("workshopIdInput")?.value.trim() === workshopId) $("workshopIdInput").value = "";
    showToast("Added!");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || "Add";
    }
  }
}

async function loadRecommended() {
  const data = await api("/api/recommended");
  showRecommended([...(data.items || []), ...(data.maps || [])], data.source);
}

function showRecommended(items, source) {
  recommendedItems = items;
  recommendedSource = source;
  const target = $("recommended");
  const activeWorkshopIds = new Set((config.mods || []).map(mod => mod.workshopId).filter(Boolean));
  const visibleItems = items.filter(item => !activeWorkshopIds.has(item.workshopId));
  target.innerHTML = `<div class="source">${escapeHtml(source || "Steam Workshop Build 42 results")}</div>`;
  if (!visibleItems.length) {
    target.innerHTML += `<div class="empty">Everything shown here is already in your server list.</div>`;
    return;
  }
  for (const item of visibleItems.slice(0, 30)) {
    const card = document.createElement("article");
    card.className = "recommend";
    card.innerHTML = `
      <button class="recommend-thumb" data-action="preview" title="Open Steam-style Workshop preview">
        ${item.thumb ? `<img src="${escapeAttr(item.thumb)}" alt="">` : `<span>Loading media</span>`}
      </button>
      <div>
        <span class="rating-badge">${escapeHtml(formatRating(item.rating))}</span>
        <button class="recommend-title" data-action="preview-title">${escapeHtml(item.title)}</button>
        <span>${escapeHtml(item.author || "")} | ${escapeHtml(item.workshopId)}</span>
      </div>
      <div class="recommend-actions">
        <button data-action="add">Add</button>
      </div>
    `;
    card.querySelector(".recommend-thumb").addEventListener("click", () => openWorkshopPreview(item.workshopId).catch(alertError));
    card.querySelector(".recommend-title").addEventListener("click", () => openWorkshopPreview(item.workshopId).catch(alertError));
    card.querySelector("[data-action='add']").addEventListener("click", event => addWorkshopMod(item.workshopId, event.currentTarget).catch(alertError));
    target.appendChild(card);
    hydrateRecommendedThumb(item, card.querySelector(".recommend-thumb")).catch(() => {});
  }
}

async function hydrateRecommendedThumb(item, button) {
  if (!item.workshopId || item.thumb || button.dataset.loading === "true") return;
  if (document.querySelectorAll('.recommend-thumb[data-loading="true"]').length > 4) return;
  button.dataset.loading = "true";
  const detail = await api(`/api/workshop/${encodeURIComponent(item.workshopId)}/thumb`);
  item.thumb = detail.thumb;
  if (item.thumb) button.innerHTML = `<img src="${escapeAttr(item.thumb)}" alt="">`;
  button.dataset.loading = "false";
}

async function refreshRecommended() {
  const data = await api("/api/workshop/search", {
    method: "POST",
    body: { tags: ["Build 42"], sort: "toprated", days: 90, query: $("workshopSearch")?.value.trim() || "" }
  });
  const label = $("workshopSearch")?.value.trim() ? `Search results: ${data.url}` : `Live Steam Workshop results: ${data.url}`;
  showRecommended(data.items, label);
}

async function loadFiles() {
  files = await api("/api/files");
  $("iniText").value = files.ini?.text || "";
  $("sandboxText").value = files.sandbox?.text || "";
  $("spawnRegionsText").value = files.spawnRegions?.text || "";
  $("spawnPointsText").value = files.spawnPoints?.text || "";
  $("iniPath").textContent = files.ini?.path || "";
  $("sandboxPath").textContent = files.sandbox?.path || "";
  $("spawnRegionsPath").textContent = files.spawnRegions?.path || "";
  $("spawnPointsPath").textContent = files.spawnPoints?.path || "";
}

async function saveFiles() {
  files = await api("/api/files", {
    method: "POST",
    body: {
      files: {
        ini: $("iniText").value,
        sandbox: $("sandboxText").value,
        spawnRegions: $("spawnRegionsText").value,
        spawnPoints: $("spawnPointsText").value
      }
    }
  });
  await refreshChanges();
}

async function refreshLog() {
  const status = await api("/api/log");
  lastLogStatus = status;
  $("jobStatus").textContent = status.activeJob ? "Working" : "Idle";
  $("serverStatus").textContent = status.serverRunning ? "Running" : "Stopped";
  $("log").textContent = status.lines.join("\n");
  $("log").scrollTop = $("log").scrollHeight;
  renderTestStatus(status);
}

async function refreshChanges() {
  const data = await api("/api/changes");
  renderTestResults(data.entries || []);
}

function renderTestStatus(status) {
  if (!$("testState")) return;
  const lines = status.lines || [];
  const latest = [...lines].reverse().find(line =>
    /Workshop:|server is listening|server started|dedicated server|error|exception|download/i.test(line)
  );
  const exitLine = [...lines].reverse().find(line => /Dedicated server exited with code/i.test(line));
  const failedExit = exitLine && !/code 0\b/i.test(exitLine);
  const state = status.serverRunning ? "Running" : (failedExit ? "Failed" : "Stopped");
  $("testState").textContent = state;
  $("testState").className = state.toLowerCase();
  $("testModCount").textContent = String(activeMods().length);
  $("testActivity").textContent = latest ? cleanLogLine(latest) : "Waiting for a test run";
}

function diagnoseServerTest(lines, status, failedExit) {
  const text = lines.join("\n");
  const issues = [];
  const firstEvidence = pattern => cleanLogLine(lines.find(line => pattern.test(line)) || "");

  if (/whitelist_new.*already exists|no such table: role|ServerWorldDatabase|SQLITE_ERROR/i.test(text)) {
    issues.push({
      level: "bad",
      title: "Server database looks corrupted or from an incompatible run",
      reason: "The server reached Workshop loading, then crashed while opening the server SQLite database. The manager now repairs this automatically by quarantining stale runtime DB/save state before the next test or dedicated start.",
      steps: [
        "Run Test again; the repair engine will move stale runtime state into Zomboid/mod-manager-backups.",
        "The server profile files stay in place, and Project Zomboid creates a clean runtime database.",
        "If this appears again, the same repair will run before the next launch."
      ],
      evidence: firstEvidence(/whitelist_new.*already exists|no such table: role|ServerWorldDatabase|SQLITE_ERROR/i)
    });
  }

  if (/Install library folder not found|Staging library folder not found/i.test(text)) {
    issues.push({
      level: "warn",
      title: "Steam Workshop library path warning",
      reason: "Steam reported missing install/staging library folders while downloading Workshop content. Some items still installed, but this can make downloads stall or fail.",
      steps: [
        "Let the current Workshop downloads finish before starting another test.",
        "Make sure the dedicated server folder has a writable steamapps directory.",
        "If downloads stay at 0/0, update the dedicated tool again and rerun the test."
      ],
      evidence: firstEvidence(/Install library folder not found|Staging library folder not found/i)
    });
  }

  if (/Steam returned 429|too many requests/i.test(text)) {
    issues.push({
      level: "warn",
      title: "Steam is rate-limiting Workshop lookups",
      reason: "Steam returned 429 for metadata/media requests. The manager now falls back to cached metadata and SteamCMD for Workshop file downloads/sync.",
      steps: [
        "Avoid repeatedly opening thumbnails while Steam cools down.",
        "Use Scan Downloaded Mods or Run Test; both paths can invoke SteamCMD when files are missing.",
        "If SteamCMD is missing, use Utilities to install SteamCMD first."
      ],
      evidence: firstEvidence(/Steam returned 429|too many requests/i)
    });
  }

  if (/SteamCMD Workshop fallback|SteamCMD downloading Workshop|\[SteamCMD/i.test(text)) {
    issues.push({
      level: "warn",
      title: "SteamCMD fallback is handling Workshop files",
      reason: "The manager detected missing Workshop files or Steam rate limiting and switched to SteamCMD so the launch cache can be repaired without depending on Steam preview/API calls.",
      steps: [
        "Let the SteamCMD lines finish.",
        "When the log shows missing 0, retry Host or Run Test.",
        "If a Workshop item fails under anonymous SteamCMD, subscribe/update it in Steam and run Scan again."
      ],
      evidence: firstEvidence(/SteamCMD Workshop fallback|SteamCMD downloading Workshop|\[SteamCMD/i)
    });
  }

  if (/onItemNotSubscribed\s+itemID=(\d+)\s+result=(\d+)/i.test(text) || /Error Subscribing to workshop item/i.test(text)) {
    const ids = [...new Set([...text.matchAll(/onItemNotSubscribed\s+itemID=(\d+)\s+result=(\d+)/gi)].map(match => match[1]))];
    issues.push({
      level: "bad",
      title: "Steam failed while subscribing to a Workshop item",
      reason: ids.length
        ? `Project Zomboid asked Steam to subscribe/install Workshop ${ids.join(", ")}, and Steam returned a failure. The repair engine removes legacy collection-only entries from WorkshopItems so the Host screen stops trying to install something that has no loadable Mod ID.`
        : "Project Zomboid showed the subscription failure toast. The repair engine checks the latest game logs and removes legacy collection-only Workshop entries from the launch profile.",
      steps: [
        "Run Troubleshoot or Run Test; the manager will inspect the failed Workshop ID automatically.",
        "If the failed item only has a legacy marker and no mod.info, it is kept in the manager history but removed from WorkshopItems.",
        "Restart Host after the profile is repaired so Project Zomboid reads the updated WorkshopItems line."
      ],
      evidence: firstEvidence(/onItemNotSubscribed\s+itemID=(\d+)\s+result=(\d+)|Error Subscribing to workshop item/i)
    });
  }

  if (/resolving internal Mod ID/i.test(text) || document.querySelector(".warnings")?.innerText.includes("resolving internal Mod ID")) {
    issues.push({
      level: "warn",
      title: "Troubleshooting engine is resolving Mod IDs",
      reason: "The manager will inspect downloaded Workshop folders for mods/*/info.txt. If an item is a legacy Workshop-only dependency, it will be skipped from WorkshopItems because Project Zomboid cannot load it as a mod.",
      steps: [
        "Run Test or Scan Downloaded Mods; the troubleshooting engine runs automatically.",
        "If Steam has not downloaded the item yet, let the test finish downloading and run again.",
        "Only unresolved items remain warnings."
      ],
      evidence: document.querySelector(".warnings")?.innerText.split("\n").find(line => line.includes("resolving internal Mod ID")) || ""
    });
  }

  if (failedExit && !issues.some(issue => issue.level === "bad")) {
    issues.push({
      level: "bad",
      title: "Server process exited with an error",
      reason: "The dedicated server stopped before reaching a healthy running state. The live log has the raw exception, but this pattern is not recognized yet.",
      steps: [
        "Scroll the live log to the first ERROR or Exception line.",
        "Disable the most recently added mod batch and run the test again.",
        "If the clean list boots, re-enable mods in smaller groups until the failing item appears."
      ],
      evidence: firstEvidence(/ERROR|Exception|exited with code/i)
    });
  }

  return issues.slice(0, 4);
}

function renderTestResults(entries) {
  if (!$("testResults")) return;
  const lines = lastLogStatus.lines || [];
  const exitLine = [...lines].reverse().find(line => /Dedicated server exited with code/i.test(line));
  const failedExit = exitLine && !/code 0\b/i.test(exitLine);
  const issues = diagnoseServerTest(lines, lastLogStatus, failedExit);
  const testEntries = entries.filter(entry =>
    /test server|dedicated server|Applied mod list|Workshop mod/i.test(entry.action || "")
  ).slice(0, 18);
  const issueHtml = issues.map(issue => `
    <div class="test-result diagnostic ${escapeAttr(issue.level)}">
      <time>Debug</time>
      <strong>${escapeHtml(issue.title)}</strong>
      <span>
        ${escapeHtml(issue.reason)}
        ${issue.steps.length ? `<br>${issue.steps.map((step, index) => `${index + 1}. ${escapeHtml(step)}`).join("<br>")}` : ""}
        ${issue.evidence ? `<code>${escapeHtml(issue.evidence)}</code>` : ""}
      </span>
    </div>
  `).join("");
  const entryHtml = testEntries.map(entry => {
    const details = entry.details || {};
    return `
      <div class="test-result ${/exited|error/i.test(entry.action) ? "bad" : "good"}">
        <time>${escapeHtml(new Date(entry.at).toLocaleString())}</time>
        <strong>${escapeHtml(entry.action)}</strong>
        <span>${escapeHtml(formatTestDetails(details))}</span>
      </div>
    `;
  }).join("");
  $("testResults").innerHTML = issueHtml + entryHtml || `<div class="empty">No server test has run yet. Use Run Test to start the headless server check.</div>`;
}

function formatTestDetails(details) {
  const bits = [];
  if (details.server) bits.push(details.server);
  if (details.mods) bits.push(`${details.mods} mods`);
  if (details.pid) bits.push(`PID ${details.pid}`);
  if (details.code) bits.push(`exit ${details.code}`);
  if (details.workshopId) bits.push(`Workshop ${details.workshopId}`);
  if (details.added) bits.push(`${details.added} added`);
  if (details.attempted) bits.push(`${details.attempted} attempted`);
  if (details.downloaded) bits.push(`${details.downloaded} downloaded`);
  if (details.failed) bits.push(`${details.failed} failed`);
  if (details.file) bits.push(details.file);
  return bits.join(" | ");
}

function cleanLogLine(line) {
  return String(line || "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^LOG\s+:\s+General\s+[^>]*>\s*/, "")
    .trim();
}

async function openWorkshopPreview(workshopId) {
  if (!workshopId) throw new Error("This mod needs a Workshop ID before it can show a Steam preview.");
  const modal = $("workshopModal");
  modal.hidden = false;
  $("previewTitle").textContent = "Loading...";
  $("previewSubtitle").textContent = `Steam Workshop ${workshopId}`;
  $("mediaStage").innerHTML = `<div class="preview-loading">Loading Steam media...</div>`;
  $("mediaStrip").innerHTML = "";
  $("previewDescription").textContent = "";
  try {
    const detail = await api(`/api/workshop/${encodeURIComponent(workshopId)}/details`);
    rememberWorkshopPreview(detail);
    renderWorkshopPreview(detail);
  } catch (error) {
    $("previewTitle").textContent = `Workshop ${workshopId}`;
    $("previewSubtitle").textContent = "Steam did not return the full preview right now";
    $("previewSteamLink").href = `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(workshopId)}`;
    $("mediaStage").innerHTML = `<div class="preview-loading">${escapeHtml(error.message || "Could not load Steam media")}</div>`;
    $("mediaStrip").innerHTML = "";
    $("previewWorkshopId").textContent = workshopId;
    $("previewRating").textContent = "Not loaded";
    $("previewModIds").textContent = "Not loaded";
    $("previewMapFolders").textContent = "Not loaded";
    $("previewDeps").textContent = "Not loaded";
    $("previewDescription").textContent = "Steam may be rate-limiting preview requests. Open Steam directly or try again in a minute.";
  }
}

function rememberWorkshopPreview(detail) {
  const mod = (config.mods || []).find(item => item.workshopId === detail.workshopId);
  if (!mod) return;
  mod.workshopPreview = {
    workshopId: detail.workshopId,
    title: detail.title,
    author: detail.author,
    thumb: detail.media?.find(item => item.thumb)?.thumb || detail.media?.[0]?.url || "",
    rating: detail.rating,
    mediaCount: detail.media?.length || 0
  };
  saveConfig("quiet").catch(() => {});
}

function renderWorkshopPreview(detail) {
  $("previewTitle").textContent = detail.title || `Workshop ${detail.workshopId}`;
  $("previewSubtitle").textContent = detail.author ? `by ${detail.author}` : "Steam Workshop item";
  $("previewSteamLink").href = detail.url;
  $("previewWorkshopId").textContent = detail.workshopId || "";
  $("previewRating").textContent = formatRating(detail.rating);
  $("previewModIds").textContent = detail.modIds?.length ? detail.modIds.join("; ") : "Not detected";
  $("previewMapFolders").textContent = detail.mapFolders?.length ? detail.mapFolders.join("; ") : "None detected";
  $("previewDeps").textContent = detail.requiredWorkshopIds?.length ? detail.requiredWorkshopIds.join("; ") : "None detected";
  $("previewDescription").textContent = detail.description || "No description text detected.";
  $("previewTags").innerHTML = (detail.tags || []).slice(0, 10).map(tag => `<span>${escapeHtml(tag)}</span>`).join("");

  const media = detail.media || [];
  if (!media.length) {
    $("mediaStage").innerHTML = `<div class="preview-loading">No Workshop pictures or videos were exposed on this page.</div>`;
    $("mediaStrip").innerHTML = "";
    return;
  }
  renderMediaStage(media[0]);
  $("mediaStrip").innerHTML = media.map((item, index) => `
    <button class="media-thumb ${index === 0 ? "active" : ""}" data-index="${index}">
      ${item.thumb ? `<img src="${escapeAttr(item.thumb)}" alt="">` : `<span>${item.type === "youtube" || item.type === "video" ? "Video" : "Image"}</span>`}
    </button>
  `).join("");
  $("mediaStrip").querySelectorAll(".media-thumb").forEach(button => {
    button.addEventListener("click", () => {
      $("mediaStrip").querySelectorAll(".media-thumb").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      renderMediaStage(media[Number(button.dataset.index)]);
    });
  });
}

function renderMediaStage(item) {
  if (item.type === "youtube") {
    $("mediaStage").innerHTML = `<iframe src="${escapeAttr(item.url)}" title="Workshop video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
    return;
  }
  if (item.type === "video") {
    $("mediaStage").innerHTML = `<video src="${escapeAttr(item.url)}" controls></video>`;
    return;
  }
  $("mediaStage").innerHTML = `<img src="${escapeAttr(item.url)}" alt="Workshop screenshot">`;
}

function closeWorkshopPreview() {
  $("workshopModal").hidden = true;
  $("mediaStage").innerHTML = "";
  $("mediaStrip").innerHTML = "";
}

function formatRating(rating) {
  if (!rating) return "Rating unknown";
  const bits = [];
  if (rating.percent) bits.push(`${rating.percent}% positive`);
  if (Number.isFinite(rating.subscriptions) && rating.subscriptions > 0) bits.push(`${compactNumber(rating.subscriptions)} subs`);
  if (Number.isFinite(rating.favorited) && rating.favorited > 0) bits.push(`${compactNumber(rating.favorited)} favs`);
  if (!bits.length && rating.label && rating.label !== "Unknown rating") bits.push(`Steam ${rating.label}`);
  else if (!bits.length && rating.stars) bits.push(`Steam ${rating.stars}-star`);
  return bits.length ? bits.join(" · ") : "Not rated yet";
}

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function switchTab(name) {
  $$(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === name));
  $$(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.id === `tab-${name}`));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function alertError(error) {
  showToast(error.message || String(error), "error");
}

function showToast(message, type = "success") {
  const toast = $("toast");
  toast.innerHTML = `<span aria-hidden="true">✓</span>${escapeHtml(message)}`;
  toast.className = `toast ${type}`;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

async function testModsOnServer(button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Testing...";
  try {
    await saveConfig("quiet");
    const fixed = await api("/api/troubleshoot/fix", { method: "POST" });
    config = fixed.config;
    fillForm();
    renderAll();
    await refreshChanges();
    const result = await api("/api/server/test-mods", { method: "POST" });
    await refreshLog();
    await refreshChanges();
    const fixedCount = fixed.actions?.filter(action => action.level === "fixed").length || 0;
    showToast(fixedCount ? `Fixed ${fixedCount} issue(s), test started` : (result.message || "Test server started"));
    switchTab("log");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function init() {
  await loadSetup();
  if (!config) config = await api("/api/config");
  fillForm();
  renderAll();
  await loadProfiles();
  await refreshRecommended().catch(loadRecommended);
  await loadFiles();
  await refreshChanges();
  await refreshLog();

  $$(".tab").forEach(tab => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
  if ($("saveConfig")) $("saveConfig").addEventListener("click", () => saveConfig().catch(alertError));
  $("loadProfile").addEventListener("click", () => loadSelectedProfile().catch(alertError));
  $("createProfile").addEventListener("click", () => createProfile().catch(alertError));
  $("newProfileName").addEventListener("keydown", event => {
    if (event.key === "Enter") createProfile().catch(alertError);
  });
  $("saveSettings").addEventListener("click", () => saveSettings().catch(alertError));
  $("launchGame").addEventListener("click", () => saveConfig("quiet").then(() => api("/api/game/launch", { method: "POST" })).then(refreshChanges).catch(alertError));
  $("openFirewall").addEventListener("click", () => saveConfig("quiet").then(() => api("/api/firewall", { method: "POST" })).catch(alertError));
  $("installSteamCmd").addEventListener("click", () => saveConfig("quiet").then(() => api("/api/install/steamcmd", { method: "POST" })).catch(alertError));
  $("installServer").addEventListener("click", () => saveConfig("quiet").then(() => api("/api/install/server", { method: "POST" })).catch(alertError));
  $("testModsServer").addEventListener("click", event => testModsOnServer(event.currentTarget).catch(alertError));
  $("runServerTest").addEventListener("click", event => testModsOnServer(event.currentTarget).catch(alertError));
  $("startServer").addEventListener("click", () => saveConfig("quiet").then(() => api("/api/server/start", { method: "POST" })).catch(alertError));
  $("stopServer").addEventListener("click", () => api("/api/server/stop", { method: "POST" }).catch(alertError));
  $("scanMods").addEventListener("click", () => api("/api/mods/scan", { method: "POST" }).then(data => {
    config = data.config;
    fillForm();
    renderAll();
    const fixedCount = data.troubleshooting?.actions?.filter(action => action.level === "fixed").length || 0;
    if (fixedCount) showToast(`Fixed ${fixedCount} issue(s)`);
    return api("/api/apply", { method: "POST" });
  }).then(() => {
    loadFiles();
    refreshChanges();
  }).catch(alertError));
  $("addBlankMod").addEventListener("click", addBlankMod);
  $("addMapFolder").addEventListener("click", () => {
    const name = prompt("Map folder name");
    if (!name) return;
    config.mapFolders = unique([name.trim(), ...(config.mapFolders || []), "Muldraugh, KY"]);
    saveConfig().then(() => showToast("Map added!")).catch(alertError);
  });
  $("addWorkshopId").addEventListener("click", event => addWorkshopMod($("workshopIdInput").value.trim(), event.currentTarget).catch(alertError));
  $("workshopIdInput").addEventListener("keydown", event => {
    if (event.key === "Enter") addWorkshopMod($("workshopIdInput").value.trim(), $("addWorkshopId")).catch(alertError);
  });
  $("refreshRecommended").addEventListener("click", () => refreshRecommended().catch(alertError));
  $("searchWorkshop").addEventListener("click", () => refreshRecommended().catch(alertError));
  $("workshopSearch").addEventListener("keydown", event => {
    if (event.key === "Enter") refreshRecommended().catch(alertError);
  });
  $("reloadFiles").addEventListener("click", () => loadFiles().catch(alertError));
  $("saveFiles").addEventListener("click", () => saveFiles().catch(alertError));
  $("closePreview").addEventListener("click", closeWorkshopPreview);
  document.querySelector("[data-close-preview]").addEventListener("click", closeWorkshopPreview);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("workshopModal").hidden) closeWorkshopPreview();
  });

  setInterval(() => refreshLog().catch(() => {}), 1500);
}

init().catch(alertError);
