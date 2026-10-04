// ============================================================================
// YGO -> ygopro.org Card Maker JSON generator (v6 - fusion Deck/Traduire)
// ============================================================================
// Stratégie :
//   1. Au premier lancement, propose de télécharger TOUTE la base de cartes
//      (EN + FR) dans IndexedDB. Une seule fois. ~30 Mo.
//   2. Ensuite, toutes les recherches/decks/traductions sont LOCALES.
//      → 0 requête API, instantané, offline-friendly.
//   3. Bouton "Synchroniser" pour rafraîchir via checkDBVer.php
//      (clic = vérif intelligente, clic droit ou Shift+clic = force)
//   4. Fallback API si l'utilisateur refuse le dump (avec rate limiter).
//   5. Fallback Yugipedia pour les cartes absentes de la base (optionnel).
//
// Nouveauté v6 :
//   L'onglet "Decklist" fusionne les actions "Transformer en JSON" et
//   "Traduire". Un sélecteur d'action (radio) détermine le comportement.
// ============================================================================

const API_BASE = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const API_DBVER = "https://db.ygoprodeck.com/api/v7/checkDBVer.php";
const MIN_QUERY_LENGTH = 2;

// --- Rate limiter (uniquement utilisé en fallback API) ---
const MIN_DELAY_MS = 200;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const REQUEST_TIMEOUT = 15000;
const BATCH_ID_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;

// --- Cache localStorage (fallback API) ---
const LS_CACHE_KEY = "ygo-api-cache-v2";
const LS_CACHE_TTL = 1000 * 60 * 60 * 24;

// --- IndexedDB ---
const IDB_NAME = "ygo-cards-db";
const IDB_VERSION = 2;
const IDB_STORE_EN = "cards_en";
const IDB_STORE_FR = "cards_fr";
const IDB_STORE_META = "meta";
const IDB_STORE_YUGI_CARDS = "yugipedia_cards";
const IDB_STORE_YUGI_SEARCH = "yugipedia_search";

// --- Limites caches ---
const MAX_STRUCTURAL_CACHE = 500;
const TOAST_MAX_LENGTH = 200;

// ----------------------------------------------------------------------------
// DOM
// ----------------------------------------------------------------------------
const form = document.getElementById("search-form");
const input = document.getElementById("search-input");
const submitBtn = document.getElementById("search-submit");
const resultsEl = document.getElementById("results-grid");
const resultsCountEl = document.getElementById("results-count");
const resultsLangEl = document.getElementById("results-lang");

const drawer = document.getElementById("drawer");
const drawerBackdrop = document.getElementById("drawer-backdrop");
const drawerClose = document.getElementById("drawer-close");
const drawerTitle = document.getElementById("drawer-title");
const drawerBody = document.getElementById("drawer-body");

// --- Decklist (fusion Deck + Traduire) ---
const deckInput = document.getElementById("deck-input");
const deckGenerateBtn = document.getElementById("deck-generate");
const deckStatusEl = document.getElementById("deck-status");
const deckResultsEl = document.getElementById("deck-results");
const deckDownloadZipBtn = document.getElementById("deck-download-zip");
const deckDownloadCsvBtn = document.getElementById("deck-download-csv");
const deckDownloadsRow = document.getElementById("deck-downloads");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const progressPct = document.getElementById("progress-pct");

// Sélecteur d'action (Deck)
const deckActionJsonRadio = document.getElementById("deck-action-json");
const deckActionTranslateRadio = document.getElementById("deck-action-translate");
const deckTranslateOptions = document.getElementById("deck-translate-options");

// Résultats de traduction (dans le panel deck maintenant)
const translationResultEl = document.getElementById("translation-result");
const translationActionsEl = document.getElementById("translation-actions");
const translateCopyBtn = document.getElementById("translate-copy");
const translateDownloadTxtBtn = document.getElementById("translate-download-txt");
const translateDownloadYdkBtn = document.getElementById("translate-download-ydk");

const themeToggle = document.getElementById("theme-toggle");
const aboutBtn = document.getElementById("about-btn");
const aboutModal = document.getElementById("about-modal");
const aboutClose = document.getElementById("about-close");
const toastsEl = document.getElementById("toasts");

// Base locale
const dbBadge = document.getElementById("db-badge");
const dbBanner = document.getElementById("db-banner");
const dbBannerInstall = document.getElementById("db-install");
const dbBannerSkip = document.getElementById("db-skip");
const dbBannerBody = document.getElementById("db-banner-body");
const dbSyncBtn = document.getElementById("db-sync");

// Yugipedia
const searchYugipediaCb = document.getElementById("search-yugipedia");
const deckYugipediaCb = document.getElementById("deck-yugipedia");
const cdbYugipediaCb = document.getElementById("cdb-yugipedia-mode");
const clearYugiCacheBtn = document.getElementById("clear-yugi-cache");
const yugiCacheStatsEl = document.getElementById("yugi-cache-stats");

// ----------------------------------------------------------------------------
// État global (exposé pour modules externes)
// ----------------------------------------------------------------------------
const appState = {
  dbReady: false,
  dbMeta: null,
};

// Raccourci pour compatibilité avec l'ancien code
Object.defineProperty(window, "dbReady", {
  get: () => appState.dbReady,
  set: (v) => { appState.dbReady = v; },
});

let activeController = null;
let lastTranslationResult = null;

const memCacheEn = new Map();
const memCacheFr = new Map();

const searchCache = new Map();
const cardByIdCache = new Map();
const cardFrByIdCache = new Map();
const structuralCardCache = new Map();

// ============================================================================
// INDEXEDDB — COUCHE DE STOCKAGE
// ============================================================================
let idbPromise = null;

function openIDB() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE_EN)) {
        db.createObjectStore(IDB_STORE_EN, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_FR)) {
        db.createObjectStore(IDB_STORE_FR, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_META)) {
        db.createObjectStore(IDB_STORE_META, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_YUGI_CARDS)) {
        db.createObjectStore(IDB_STORE_YUGI_CARDS, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_YUGI_SEARCH)) {
        db.createObjectStore(IDB_STORE_YUGI_SEARCH, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

async function idbPutAll(storeName, items) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const item of items) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear(storeName) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(storeName, key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, item) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAll(storeName) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbCount(storeName) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSetMeta(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_META, "readwrite");
    tx.objectStore(IDB_STORE_META).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetMeta(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_META, "readonly");
    const req = tx.objectStore(IDB_STORE_META).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

// ============================================================================
// INITIALISATION DE LA BASE
// ============================================================================
async function initDatabase() {
  try {
    const countEn = await idbCount(IDB_STORE_EN);
    const countFr = await idbCount(IDB_STORE_FR);
    appState.dbMeta = await idbGetMeta("meta");

    if (countEn > 1000) {
      appState.dbReady = true;
      updateDbBadge(countEn, countFr);
      await loadMemCache();
      console.log(`[DB] Base locale chargée : ${countEn} EN, ${countFr} FR`);
    } else {
      appState.dbReady = false;
      showInstallBanner();
    }
  } catch (err) {
    console.error("[DB] Init échouée", err);
    appState.dbReady = false;
    showInstallBanner();
  }
}

async function loadMemCache() {
  const [en, fr] = await Promise.all([
    idbGetAll(IDB_STORE_EN),
    idbGetAll(IDB_STORE_FR),
  ]);
  en.forEach((c) => memCacheEn.set(String(c.id), c));
  fr.forEach((c) => memCacheFr.set(String(c.id), c));
  console.log(`[DB] Cache mémoire : ${memCacheEn.size} EN, ${memCacheFr.size} FR`);

  // Exposition pour cdb-translator.js
  window.memCacheEn = memCacheEn;
  window.memCacheFr = memCacheFr;
}

function updateDbBadge(countEn, countFr) {
  if (!dbBadge) return;
  dbBadge.classList.remove("hidden");
  dbBadge.innerHTML = `🟢 Base locale · ${countEn.toLocaleString("fr-FR")} cartes`;
  dbBadge.title = `${countEn} cartes EN, ${countFr} cartes FR`;
}

function showInstallBanner() {
  if (!dbBanner) return;
  dbBanner.classList.remove("hidden");
  dbBannerBody.innerHTML = `
    <p><strong>📥 Base de cartes non installée.</strong></p>
    <p>Pour des recherches instantanées et zéro requête API, télécharge la base locale (~30 Mo, une seule fois).</p>
    <p style="color:var(--text-muted); font-size:0.82rem; margin-top:6px;">
      Sans elle, l'app utilise l'API en direct (plus lent, limité à 20 req/s).
    </p>
  `;
  dbBannerInstall.classList.remove("hidden");
  dbBannerSkip.classList.remove("hidden");
}

function hideInstallBanner() {
  if (dbBanner) dbBanner.classList.add("hidden");
}

// ============================================================================
// TÉLÉCHARGEMENT DE LA BASE
// ============================================================================
async function downloadFullDatabase() {
  hideInstallBanner();
  showDownloadProgress();

  try {
    updateProgressText("Téléchargement de la base anglaise…", 5);
    const enCards = await fetchAllCards(null, (pct) => {
      updateProgressText(`Téléchargement EN… ${pct}%`, Math.round(pct * 0.4));
    });
    console.log(`[DB] ${enCards.length} cartes EN reçues`);

    updateProgressText("Téléchargement de la base française…", 50);
    const frCards = await fetchAllCards("fr", (pct) => {
      updateProgressText(`Téléchargement FR… ${pct}%`, Math.round(50 + pct * 0.3));
    });
    console.log(`[DB] ${frCards.length} cartes FR reçues`);

    updateProgressText("Stockage de la base anglaise…", 80);
    await idbClear(IDB_STORE_EN);
    await idbPutAll(IDB_STORE_EN, enCards);

    updateProgressText("Stockage de la base française…", 90);
    await idbClear(IDB_STORE_FR);
    await idbPutAll(IDB_STORE_FR, frCards);

    let version = "unknown";
    try {
      const verRes = await fetch(API_DBVER);
      if (verRes.ok) {
        const verData = await verRes.json();
        version = verData.database_version || "unknown";
      }
    } catch (e) { /* pas grave */ }

    const meta = {
      version,
      date: new Date().toISOString(),
      countEn: enCards.length,
      countFr: frCards.length,
    };
    await idbSetMeta("meta", meta);
    appState.dbMeta = meta;

    updateProgressText("Chargement en mémoire…", 98);
    await loadMemCache();
    appState.dbReady = true;
    updateDbBadge(enCards.length, frCards.length);

    updateProgressText("✅ Base installée !", 100);
    toast(`Base locale prête : ${enCards.length} cartes`, "ok");
    setTimeout(hideDownloadProgress, 1200);

  } catch (err) {
    console.error("[DB] Téléchargement échoué", err);
    updateProgressText(`❌ Erreur : ${err.message}`, 0);
    toast("Téléchargement échoué. Réessaie ou utilise l'app sans base locale.", "err");
    setTimeout(() => {
      hideDownloadProgress();
      showInstallBanner();
    }, 3000);
  }
}

async function fetchAllCards(language, onProgress) {
  const url = new URL(API_BASE);
  if (language) url.searchParams.set("language", language);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const total = parseInt(res.headers.get("content-length") || "0", 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && onProgress) {
      onProgress(Math.min(99, Math.round((received / total) * 100)));
    }
  }

  const blob = new Blob(chunks);
  const text = await blob.text();
  const data = JSON.parse(text);
  return data.data || [];
}

// ============================================================================
// UI DE PROGRESSION DU TÉLÉCHARGEMENT
// ============================================================================
function showDownloadProgress() {
  if (!dbBanner) return;
  dbBanner.classList.remove("hidden");
  dbBannerBody.innerHTML = `
    <div class="progress-info">
      <span id="db-progress-label">Préparation…</span>
      <span id="db-progress-pct">0%</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" id="db-progress-fill" style="width:0%"></div></div>
    <p style="color:var(--text-muted); font-size:0.8rem; margin-top:10px;">
      Une seule fois. Ensuite, tout sera instantané.
    </p>
  `;
  dbBannerInstall.classList.add("hidden");
  dbBannerSkip.classList.add("hidden");
}

function updateProgressText(label, pct) {
  const lbl = document.getElementById("db-progress-label");
  const p = document.getElementById("db-progress-pct");
  const fill = document.getElementById("db-progress-fill");
  if (lbl) lbl.textContent = label;
  if (p) p.textContent = pct + "%";
  if (fill) fill.style.width = pct + "%";
}

function hideDownloadProgress() {
  if (dbBanner) dbBanner.classList.add("hidden");
}

// ============================================================================
// SYNCHRONISATION
// ============================================================================
async function syncDatabase(force = false) {
  if (!appState.dbReady) {
    await downloadFullDatabase();
    return;
  }
  if (force) {
    toast("Mise à jour forcée…", "info");
    await downloadFullDatabase();
    return;
  }
  try {
    const res = await fetch(API_DBVER);
    if (!res.ok) return;
    const data = await res.json();
    const remoteVer = data.database_version || "unknown";
    if (appState.dbMeta && appState.dbMeta.version !== remoteVer) {
      toast("Nouvelle version de la base disponible. Sync en cours…", "info");
      await downloadFullDatabase();
    } else {
      toast("Base déjà à jour ✅", "ok");
    }
  } catch (err) {
    console.warn("Sync impossible", err);
    toast("Impossible de vérifier la version", "err");
  }
}

// ============================================================================
// RATE LIMITER + FETCH API (fallback YGOPRODeck)
// ============================================================================
const apiQueue = [];
let apiBusy = false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function enqueueApiFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    apiQueue.push({ url, options, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (apiBusy) return;
  apiBusy = true;
  while (apiQueue.length) {
    const job = apiQueue.shift();
    try {
      const result = await rawFetchWithRetry(job.url, job.options);
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    }
    await sleep(MIN_DELAY_MS);
  }
  apiBusy = false;
}

async function rawFetchWithRetry(url, options = {}, attempt = 0) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  const extSignal = options.signal;
  if (extSignal) {
    if (extSignal.aborted) {
      clearTimeout(timeoutId);
      const e = new Error("Aborted"); e.name = "AbortError"; throw e;
    }
    extSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
      console.warn(`API ${res.status}, retry dans ${delay}ms`);
      await sleep(delay);
      return rawFetchWithRetry(url, options, attempt + 1);
    }
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError" && extSignal && extSignal.aborted) throw err;
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
      await sleep(delay);
      return rawFetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

async function apiFetchCards(params, signal) {
  const url = new URL(API_BASE);
  Object.entries(params).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach((val) => url.searchParams.append(k, val));
    else url.searchParams.set(k, v);
  });
  const res = await enqueueApiFetch(url.toString(), signal ? { signal } : {});
  if (!res.ok) {
    if (res.status === 400) return [];
    throw new Error(`API error ${res.status}`);
  }
  const data = await res.json();
  return data.data || [];
}

/**
 * Récupère plusieurs cartes par ID en UNE ou plusieurs requêtes batchées.
 * Utilise BATCH_ID_LIMIT (50) pour respecter la limite de l'API.
 */
async function getCardsByIds(ids, language) {
  if (!ids.length) return new Map();

  const results = new Map();
  const uncached = [];
  const cache = language === "fr" ? cardFrByIdCache : cardByIdCache;

  for (const id of ids) {
    const key = String(id);
    if (cache.has(key)) {
      results.set(key, cache.get(key));
    } else {
      uncached.push(key);
    }
  }

  if (!uncached.length) return results;

  for (let i = 0; i < uncached.length; i += BATCH_ID_LIMIT) {
    const chunk = uncached.slice(i, i + BATCH_ID_LIMIT);
    const params = { id: chunk.join(",") };
    if (language === "fr") params.language = "fr";

    try {
      const cards = await apiFetchCards(params);
      for (const card of cards) {
        const key = String(card.id);
        cache.set(key, card);
        results.set(key, card);
      }
      for (const id of chunk) {
        if (!results.has(id)) results.set(id, null);
      }
    } catch (err) {
      console.warn("[API] Batch échoué", err);
    }
  }

  return results;
}

// ============================================================================
// RECHERCHE (locale / API / Yugipedia)
// ============================================================================
function normalizeForSearch(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function searchCards(query, lang = "auto", allowYugipedia = false) {
  if (appState.dbReady) {
    const local = searchLocal(query, lang);
    if (local.cards.length) return local;
  } else {
    const remote = await searchRemote(query, lang);
    if (remote.cards.length) return remote;
  }

  if (allowYugipedia && window.yugipediaSearch && query.length >= 3) {
    try {
      const yugiCards = await window.yugipediaSearch(query);
      if (yugiCards && yugiCards.length) {
        return {
          cards: yugiCards,
          usedLanguage: "yugipedia",
          source: "yugipedia",
        };
      }
    } catch (e) {
      console.warn("[Yugipedia] Fallback recherche échoué", e);
    }
  }

  return { cards: [], usedLanguage: lang === "auto" ? "fr" : lang };
}

function searchLocal(query, lang = "auto") {
  const q = normalizeForSearch(query);
  if (!q) return { cards: [], usedLanguage: lang };

  const sources = [];
  if (lang === "auto" || lang === "fr") sources.push({ store: memCacheFr, code: "fr" });
  if (lang === "auto" || lang === "en") sources.push({ store: memCacheEn, code: "en" });

  for (const { store, code } of sources) {
    const exact = [];
    const fuzzy = [];
    for (const card of store.values()) {
      const n = normalizeForSearch(card.name);
      if (n === q) exact.push(card);
      else if (n.includes(q)) fuzzy.push(card);
    }
    const found = [...exact, ...fuzzy];
    if (found.length) {
      return { cards: found, usedLanguage: code };
    }
  }
  return { cards: [], usedLanguage: lang === "auto" ? "fr" : lang };
}

async function searchRemote(query, lang) {
  const cacheKey = `${lang}::${query.toLowerCase()}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);

  const tryLanguages = {
    auto: ["fr", null],
    fr: ["fr"],
    en: [null],
    ja: ["ja"],
  }[lang] || ["fr", null];

  for (const language of tryLanguages) {
    const params = { fname: query };
    if (language) params.language = language;
    const cards = await apiFetchCards(params);
    if (cards.length) {
      const result = { cards, usedLanguage: language || "en" };
      searchCache.set(cacheKey, result);
      return result;
    }
  }
  const empty = { cards: [], usedLanguage: lang === "auto" ? "fr" : lang };
  searchCache.set(cacheKey, empty);
  return empty;
}

// ============================================================================
// RÉCUPÉRATION PAR ID (locale ou API)
// ============================================================================
async function getCardById(id, language) {
  const key = String(id);

  if (key.startsWith("yugi-")) return null;

  if (appState.dbReady) {
    if (language === "fr") return memCacheFr.get(key) || null;
    if (!language) return memCacheEn.get(key) || null;
    return null;
  }

  const cache = language === "fr" ? cardFrByIdCache : cardByIdCache;
  if (cache.has(key)) return cache.get(key);

  try {
    const params = { id: key };
    if (language === "fr") params.language = "fr";
    const cards = await apiFetchCards(params);
    const card = cards[0] || null;
    if (card) cache.set(key, card);
    return card;
  } catch (err) {
    return null;
  }
}

// ============================================================================
// THÈME
// ============================================================================
(function initTheme() {
  const saved = localStorage.getItem("ygo-theme");
  const prefers = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const theme = saved || prefers;
  document.body.dataset.theme = theme;
  themeToggle.textContent = theme === "dark" ? "🌙" : "☀️";
})();

themeToggle.addEventListener("click", () => {
  const next = document.body.dataset.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = next;
  localStorage.setItem("ygo-theme", next);
  themeToggle.textContent = next === "dark" ? "🌙" : "☀️";
  toast(`Thème ${next === "dark" ? "sombre" : "clair"} activé`, "info");
});

// ============================================================================
// MODAL À PROPOS + CACHE YUGIPEDIA
// ============================================================================
aboutBtn.addEventListener("click", () => {
  aboutModal.classList.add("open");
  refreshYugiCacheStats();
});
aboutClose.addEventListener("click", closeAbout);
aboutModal.addEventListener("click", (e) => { if (e.target === aboutModal) closeAbout(); });
function closeAbout() { aboutModal.classList.remove("open"); }

async function refreshYugiCacheStats() {
  if (!yugiCacheStatsEl || !window.YugipediaAPI) return;
  try {
    const stats = await window.YugipediaAPI.getYugipediaCacheStats();
    yugiCacheStatsEl.textContent = `${stats.total} entrées en cache (${stats.cards} cartes, ${stats.searches} recherches)`;
  } catch (e) {
    yugiCacheStatsEl.textContent = "";
  }
}

if (clearYugiCacheBtn) {
  clearYugiCacheBtn.addEventListener("click", async () => {
    if (!window.YugipediaAPI) return;
    await window.YugipediaAPI.clearYugipediaCache();
    toast("Cache Yugipedia vidé", "ok");
    refreshYugiCacheStats();
  });
}

// ============================================================================
// TABS
// ============================================================================
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
  });
});

// ============================================================================
// TOASTS
// ============================================================================
function toast(msg, kind = "info") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  const icon = kind === "ok" ? "✅" : kind === "err" ? "❌" : "ℹ️";
  const text = String(msg);
  const truncated = text.length > TOAST_MAX_LENGTH
    ? text.slice(0, TOAST_MAX_LENGTH) + "…"
    : text;
  el.innerHTML = `<span>${icon}</span><span>${escapeHtml(truncated)}</span>`;
  toastsEl.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.3s, transform 0.3s";
    el.style.opacity = "0";
    el.style.transform = "translateX(40px)";
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

// ============================================================================
// CHECKBOXES YUGIPEDIA — SYNCHRONISATION
// ============================================================================
function syncYugipediaCheckboxes() {
  if (!window.YugipediaAPI) return;
  const enabled = window.YugipediaAPI.isYugipediaEnabled();
  [searchYugipediaCb, deckYugipediaCb, cdbYugipediaCb].forEach((cb) => {
    if (cb) cb.checked = enabled;
  });
}

function bindYugipediaCheckbox(cb) {
  if (!cb || !window.YugipediaAPI) return;
  cb.addEventListener("change", () => {
    window.YugipediaAPI.setYugipediaEnabled(cb.checked);
    toast(
      cb.checked ? "Fallback Yugipedia activé" : "Fallback Yugipedia désactivé",
      cb.checked ? "ok" : "info"
    );
  });
}

bindYugipediaCheckbox(searchYugipediaCb);
bindYugipediaCheckbox(deckYugipediaCb);
bindYugipediaCheckbox(cdbYugipediaCb);
syncYugipediaCheckboxes();

window.addEventListener("yugipedia-toggle", syncYugipediaCheckboxes);

function isYugipediaEnabled() {
  return window.YugipediaAPI ? window.YugipediaAPI.isYugipediaEnabled() : false;
}

// ============================================================================
// RECHERCHE UI
// ============================================================================
let searchDebounceTimer = null;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const query = input.value.trim();
  if (query.length < MIN_QUERY_LENGTH) {
    toast(`Tape au moins ${MIN_QUERY_LENGTH} caractères.`, "err");
    return;
  }
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => search(query), SEARCH_DEBOUNCE_MS);
});

function getSearchLanguage() {
  const radio = document.querySelector('input[name="lang"]:checked');
  return radio ? radio.value : "auto";
}

async function search(query) {
  if (activeController) activeController.abort();
  activeController = new AbortController();

  resultsEl.innerHTML = "";
  resultsCountEl.textContent = "Recherche en cours…";
  resultsLangEl.classList.add("hidden");
  submitBtn.disabled = true;

  const lang = getSearchLanguage();
  const allowYugi = isYugipediaEnabled();

  try {
    const { cards, usedLanguage, source } = await searchCards(query, lang, allowYugi);
    if (!cards.length) {
      resultsCountEl.textContent = "Aucune carte trouvée.";
      return;
    }
    resultsCountEl.textContent = `${cards.length} résultat${cards.length > 1 ? "s" : ""}`;
    resultsLangEl.textContent = source === "yugipedia"
      ? "🟣 trouvés sur Yugipedia"
      : langBadge(usedLanguage);
    resultsLangEl.classList.remove("hidden");
    renderResults(cards);
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    resultsCountEl.textContent = "Erreur pendant la recherche.";
  } finally {
    submitBtn.disabled = false;
    activeController = null;
  }
}

function langBadge(lang) {
  const flags = { fr: "🇫🇷", en: "🇬🇧", ja: "🇯🇵", de: "🇩🇪", it: "🇮🇹", pt: "🇵🇹" };
  const names = { fr: "FR", en: "EN", ja: "JA", de: "DE", it: "IT", pt: "PT" };
  const flag = flags[lang] || "🌐";
  const name = names[lang] || lang.toUpperCase();
  if (lang === "en") return `${flag} trouvés en ${name} (pas de trad. FR)`;
  return `${flag} trouvés en ${name}`;
}

// ============================================================================
// RENDU DES RÉSULTATS
// ============================================================================
function renderResults(cards) {
  resultsEl.innerHTML = "";
  cards.slice(0, 60).forEach((card) => {
    resultsEl.appendChild(buildCardTile(card));
  });
}

function buildCardTile(card) {
  const tile = document.createElement("div");
  tile.className = "card-tile";
  tile.dataset.frame = card.frameType || "normal";
  tile.tabIndex = 0;
  tile.setAttribute("role", "button");

  const img = card.card_images && card.card_images[0];
  const imgUrl = img ? (img.image_url_cropped || img.image_url) : "";
  const imgHtml = imgUrl
    ? `<img src="${imgUrl}" alt="${escapeHtml(card.name)}" loading="lazy">`
    : `<span>🃏</span>`;

  const gemClass = card.attribute ? `gem ${card.attribute.toUpperCase()}` : "";
  const gem = card.attribute ? `<span class="${gemClass}" title="${card.attribute}"></span>` : "";
  const stars = card.level
    ? `<span class="stars">${"★".repeat(Math.min(card.level, 12))}</span>`
    : "";
  const typeLabel = getTypeLabel(card);
  const yugiBadge = card._source === "yugipedia"
    ? `<span class="badge yugi" title="Traduit via Yugipedia">🟣 Yugipedia</span>`
    : "";

  tile.innerHTML = `
    <div class="card-tile-img">
      ${imgHtml}
      <div class="card-tile-overlay">
        <div class="overlay-actions">
          <button class="mini-btn" data-act="open" type="button">Voir</button>
          <button class="mini-btn" data-act="json" type="button">JSON</button>
          ${imgUrl ? `<button class="mini-btn" data-act="img" type="button">IMG</button>` : ""}
        </div>
      </div>
    </div>
    <div class="card-tile-body">
      <div class="card-tile-name">${escapeHtml(card.name)}</div>
      <div class="card-tile-meta">
        ${gem} ${stars}
        <span class="type-tag">${escapeHtml(typeLabel)}</span>
        ${yugiBadge}
      </div>
    </div>`;

  tile.addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    if (act === "json") { showCardAndCopyJson(card); return; }
    if (act === "img" && imgUrl) {
      const a = document.createElement("a");
      a.href = imgUrl;
      a.download = `${sanitizeFilename(card.name)}.jpg`;
      a.target = "_blank";
      a.click();
      return;
    }
    showCard(card);
  });
  tile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showCard(card); }
  });
  return tile;
}

function getTypeLabel(card) {
  if (card.type === "Spell Card") return "Magie";
  if (card.type === "Trap Card") return "Piège";
  const frame = (card.frameType || "").split("_")[0];
  const labels = {
    normal: "Normal", effect: "Effet", ritual: "Rituel", fusion: "Fusion",
    synchro: "Synchro", xyz: "Xyz", link: "Lien", token: "Jeton", skill: "Skill",
  };
  return labels[frame] || "Monstre";
}

// ============================================================================
// DRAWER
// ============================================================================
async function showCardAndCopyJson(card) {
  const json = await generateJsonForCard(card);
  copyTextToClipboard(JSON.stringify(json, null, 2), null, null);
  toast("JSON copié !", "ok");
}

async function showCard(card) {
  drawerTitle.textContent = card.name;
  drawerBody.innerHTML = `<p style="color:var(--text-muted);">Chargement…</p>`;
  drawer.classList.add("open");
  drawerBackdrop.classList.add("open");

  const img = card.card_images && card.card_images[0];
  const imgUrl = img ? (img.image_url_cropped || img.image_url) : "";
  let showingCropped = true;

  const gemClass = card.attribute ? `gem ${card.attribute.toUpperCase()}` : "";
  const gem = card.attribute ? `<span class="${gemClass}"></span>` : "";
  const stars = card.level
    ? `<span class="stars" style="color:var(--gold);">${"★".repeat(Math.min(card.level, 12))}</span>`
    : "";
  const typeLabel = getTypeLabel(card);

  let enCard = null;
  let frCard = null;
  if (card._source !== "yugipedia") {
    enCard = await getCardById(card.id, null).catch(() => null);
    frCard = await getCardById(card.id, "fr").catch(() => null);
  }

  let json;
  try {
    json = await generateJsonForCard(card, undefined, enCard);
  } catch (err) {
    console.error(err);
    json = buildYgoproJson(card);
  }

  const jsonString = JSON.stringify(json, null, 2);
  const yugiNote = card._source === "yugipedia"
    ? `<p style="color:#b88ae0; font-size:0.82rem; margin-top:8px;">🟣 Source : Yugipedia (cache 30j)</p>`
    : "";

  drawerBody.innerHTML = `
    <img class="drawer-image" id="drawer-img" alt="${escapeHtml(card.name)}"
         src="${imgUrl}">
    <div class="drawer-meta">
      ${gem} ${stars}
      <span class="type-tag" style="background:var(--surface-3); color:var(--text);">${escapeHtml(typeLabel)}</span>
      <span>· ID ${card.id}</span>
    </div>
    ${yugiNote}
    <div class="drawer-actions">
      <button class="btn" id="drawer-copy-url" type="button">🔗 URL image</button>
      <button class="btn" id="drawer-toggle-img" type="button">🖼️ Carte complète</button>
      <a class="btn" id="drawer-download-img" download target="_blank" rel="noopener">⬇️ Illustration</a>
    </div>
    <div class="name-toggle">
      <span class="name-toggle-label">Nom utilisé dans le JSON</span>
      <div class="name-toggle-row" id="json-name-row">
        <label class="name-opt"><input type="radio" name="jsonname" value="display" checked> 🌐 Nom affiché</label>
      </div>
    </div>
    <div class="drawer-actions">
      <button class="btn" id="drawer-copy-json" type="button">📋 Copier le JSON</button>
      <button class="btn" id="drawer-download-json" type="button">💾 .json</button>
    </div>
    <textarea class="json-preview" id="drawer-json" readonly>${escapeHtml(jsonString)}</textarea>
  `;

  const drawerImg = document.getElementById("drawer-img");
  const downloadImgBtn = document.getElementById("drawer-download-img");
  const toggleImgBtn = document.getElementById("drawer-toggle-img");
  const copyUrlBtn = document.getElementById("drawer-copy-url");

  function applyImage() {
    if (!img) return;
    const url = showingCropped ? (img.image_url_cropped || img.image_url) : (img.image_url || img.image_url_cropped);
    drawerImg.src = url;
    downloadImgBtn.href = url;
    downloadImgBtn.setAttribute("download", `${sanitizeFilename(card.name)}${showingCropped ? "" : "-complete"}.jpg`);
    toggleImgBtn.textContent = showingCropped ? "🖼️ Carte complète" : "🖼️ Illustration";
  }
  applyImage();
  toggleImgBtn.addEventListener("click", () => { showingCropped = !showingCropped; applyImage(); });
  copyUrlBtn.addEventListener("click", () => {
    const url = showingCropped ? (img.image_url_cropped || img.image_url) : (img.image_url || img.image_url_cropped);
    copyTextToClipboard(url, copyUrlBtn, "🔗 URL image");
  });

  const row = document.getElementById("json-name-row");
  if (frCard && frCard.name !== card.name) {
    const lbl = document.createElement("label");
    lbl.className = "name-opt";
    lbl.innerHTML = `<input type="radio" name="jsonname" value="fr"> 🇫🇷 ${escapeHtml(frCard.name)}`;
    row.appendChild(lbl);
  }
  if (enCard && enCard.name !== card.name && (!frCard || enCard.name !== frCard.name)) {
    const lbl = document.createElement("label");
    lbl.className = "name-opt";
    lbl.innerHTML = `<input type="radio" name="jsonname" value="en"> 🇬🇧 ${escapeHtml(enCard.name)}`;
    row.appendChild(lbl);
  }
  row.querySelectorAll('input[name="jsonname"]').forEach((radio) => {
    radio.addEventListener("change", async () => {
      const val = radio.value;
      let newName = card.name;
      if (val === "fr" && frCard) newName = frCard.name;
      if (val === "en" && enCard) newName = enCard.name;
      const newJson = await generateJsonForCard(card, newName, enCard);
      document.getElementById("drawer-json").value = JSON.stringify(newJson, null, 2);
      drawerTitle.textContent = newName;
    });
  });

  const jsonTextarea = document.getElementById("drawer-json");
  document.getElementById("drawer-copy-json").addEventListener("click", () => {
    copyTextToClipboard(jsonTextarea.value, null, null);
    toast("JSON copié !", "ok");
  });
  document.getElementById("drawer-download-json").addEventListener("click", () => {
    downloadBlob(jsonTextarea.value, `${sanitizeFilename(card.name)}.json`, "application/json");
  });
}

function closeDrawer() {
  drawer.classList.remove("open");
  drawerBackdrop.classList.remove("open");
}

drawerClose.addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeDrawer(); closeAbout(); }
});

// ============================================================================
// GÉNÉRATION JSON
// ============================================================================
async function generateJsonForCard(card, overrideName, providedStructural) {
  if (card._source === "yugipedia") {
    return buildYgoproJson({
      ...card,
      name: overrideName || card.name,
      desc: card.desc || card._descs?.fr || card._descs?.en || "",
    });
  }

  let structural = providedStructural || structuralCardCache.get(card.id);
  if (!structural) {
    try {
      structural = (await getCardById(card.id, null)) || card;
      cacheStructural(card.id, structural);
    } catch (err) {
      structural = card;
    }
  }
  const merged = {
    ...structural,
    name: overrideName || card.name,
    desc: card.desc,
    pend_desc: card.pend_desc,
    monster_desc: card.monster_desc,
    displayRace: card.race,
  };
  return buildYgoproJson(merged);
}

function cacheStructural(id, card) {
  if (structuralCardCache.size >= MAX_STRUCTURAL_CACHE) {
    const firstKey = structuralCardCache.keys().next().value;
    structuralCardCache.delete(firstKey);
  }
  structuralCardCache.set(id, card);
}

function buildYgoproJson(card) {
  const isSpell = card.type === "Spell Card";
  const isTrap = card.type === "Trap Card";
  const [baseFrame, pendulumSuffix] = (card.frameType || "").split("_");
  const isPendulum = pendulumSuffix === "pendulum";
  const isLink = baseFrame === "link";

  return {
    version: "1.0.0",
    name: card.name,
    level: String(card.level || card.linkval || 0),
    type: buildTypeLine(card),
    icon: buildIcon(card),
    effect: buildEffectText(card),
    atk: isSpell || isTrap ? "" : String(card.atk ?? "0"),
    def: isSpell || isTrap || isLink ? "" : String(card.def ?? "0"),
    serial: "",
    copyright: "© 2026 YGOPRO.ORG",
    attribute: buildAttribute(card),
    id: String(card.id || ""),
    rarity: "common",
    pendulum: {
      enabled: isPendulum,
      effect: isPendulum ? card.pend_desc || "" : "",
      blue: isPendulum ? String(card.scale ?? "0") : "0",
      red: isPendulum ? String(card.scale ?? "0") : "0",
      boxSize: "Normal",
      boxSizeEnabled: true,
    },
    variant: "Normal",
    link: buildLinkMarkers(card),
    layout: buildLayout(baseFrame),
    boxSize: (card.desc || "").length > 300 ? "Small" : "Normal",
  };
}

const FRAME_TO_LAYOUT = {
  normal: "Normal", effect: "Effect", ritual: "Ritual", fusion: "Fusion",
  synchro: "Synchro", xyz: "Xyz", link: "Link", token: "Token",
  spell: "Spell", trap: "Trap", skill: "Skill",
};
function buildLayout(baseFrame) { return FRAME_TO_LAYOUT[baseFrame] || "Effect"; }

const RACE_FR = {
  Aqua: "Aqua", Beast: "Bête", "Beast-Warrior": "Bête-Guerrier",
  "Creator God": "Dieu Créateur", Cyberse: "Cyberse", Dinosaur: "Dinosaure",
  "Divine-Beast": "Bête Divine", Dragon: "Dragon", Fairy: "Fée",
  Fiend: "Démon", Fish: "Poisson", Illusion: "Illusion", Insect: "Insecte",
  Machine: "Machine", Plant: "Plante", Psychic: "Psychique", Pyro: "Pyro",
  Reptile: "Reptile", Rock: "Rocher", "Sea Serpent": "Serpent de Mer",
  Spellcaster: "Magicien", Thunder: "Tonnerre", Warrior: "Guerrier",
  "Winged Beast": "Bête Ailée", Wyrm: "Wyrm", Zombie: "Zombie",
};
function translateRace(race) { return RACE_FR[race] || race; }

const ABILITY_FR = {
  Effect: "Effet", Normal: "Normal", Fusion: "Fusion", Synchro: "Synchro",
  Xyz: "Xyz", Ritual: "Rituel", Link: "Lien", Tuner: "Syntoniseur",
  Flip: "Retournement", Spirit: "Esprit", Union: "Union", Toon: "Toon",
  Gemini: "Gémeau", Pendulum: "Pendule",
};
function translateAbilities(entries) { return entries.map((e) => ABILITY_FR[e] || e); }

function buildTypeLine(card) {
  if (card.type === "Spell Card") return "Carte Magie";
  if (card.type === "Trap Card") return "Carte Piège";
  const displayRace = translateRace(card.race);
  if (Array.isArray(card.typeline) && card.typeline.length) {
    return [displayRace, ...translateAbilities(card.typeline.slice(1))].join("/");
  }
  const abilities = [];
  const t = card.type;
  if (t.includes("Ritual")) abilities.push("Ritual");
  if (t.includes("Fusion")) abilities.push("Fusion");
  if (t.includes("Synchro")) abilities.push("Synchro");
  if (t.includes("XYZ")) abilities.push("Xyz");
  if (t.includes("Link")) abilities.push("Link");
  if (t.includes("Gemini")) abilities.push("Gemini");
  if (t.includes("Spirit")) abilities.push("Spirit");
  if (t.includes("Union")) abilities.push("Union");
  if (t.includes("Toon")) abilities.push("Toon");
  if (t.includes("Flip")) abilities.push("Flip");
  if (t.includes("Tuner")) abilities.push("Tuner");
  if (t.includes("Effect") && !abilities.length) abilities.push("Effect");
  if (t === "Normal Monster") abilities.push("Normal");
  if (!abilities.length) abilities.push("Effect");
  return `${displayRace}/${translateAbilities(abilities).join("/")}`;
}

const RACE_TO_ICON = {
  Continuous: "Continuous", Counter: "Counter", Equip: "Equip",
  Field: "Field", "Quick-Play": "Quick-play", Ritual: "Ritual", Normal: "None",
};
function buildIcon(card) {
  if (card.type === "Spell Card" || card.type === "Trap Card") {
    return RACE_TO_ICON[card.race] || "None";
  }
  return "None";
}
function buildAttribute(card) {
  if (card.type === "Spell Card") return "Spell";
  if (card.type === "Trap Card") return "Trap";
  if (!card.attribute) return "Light";
  return card.attribute.charAt(0) + card.attribute.slice(1).toLowerCase();
}
function buildEffectText(card) {
  if (card.type.includes("Pendulum") && card.monster_desc) return card.monster_desc;
  return card.desc || "";
}
function buildLinkMarkers(card) {
  const base = {
    topLeft: false, topCenter: false, topRight: false,
    middleLeft: false, middleRight: false,
    bottomLeft: false, bottomCenter: false, bottomRight: false,
  };
  if (!card.linkmarkers) return base;
  const map = {
    "Top-Left": "topLeft", Top: "topCenter", "Top-Right": "topRight",
    Left: "middleLeft", Right: "middleRight",
    "Bottom-Left": "bottomLeft", Bottom: "bottomCenter", "Bottom-Right": "bottomRight",
  };
  card.linkmarkers.forEach((m) => { const k = map[m]; if (k) base[k] = true; });
  return base;
}

// ============================================================================
// COPIE PRESSE-PAPIER
// ============================================================================
function copyTextToClipboard(text, buttonEl, resetLabel) {
  const showResult = (ok) => {
    if (!buttonEl) { if (ok) toast("Copié !", "ok"); return; }
    buttonEl.textContent = ok ? "✅ Copié !" : "❌ Échec";
    setTimeout(() => (buttonEl.textContent = resetLabel), 1500);
  };
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    showResult(ok);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showResult(true), () => fallback());
  } else fallback();
}

// ============================================================================
// DECKLIST — SÉLECTEUR D'ACTION
// ============================================================================
function isDeckActionTranslate() {
  return deckActionTranslateRadio && deckActionTranslateRadio.checked;
}

function updateDeckActionUI() {
  const isTranslate = isDeckActionTranslate();

  // Afficher/masquer les options de traduction (langue source/cible)
  if (deckTranslateOptions) {
    deckTranslateOptions.classList.toggle("hidden", !isTranslate);
  }

  // Masquer les résultats de l'autre action au changement
  if (translationResultEl) translationResultEl.classList.add("hidden");
  if (translationActionsEl) translationActionsEl.classList.add("hidden");
  if (deckDownloadsRow) deckDownloadsRow.classList.add("hidden");

  // Vider les résultats
  if (deckResultsEl) deckResultsEl.innerHTML = "";
  if (deckStatusEl) deckStatusEl.textContent = "";
  if (progressWrap) progressWrap.classList.remove("visible");

  // Changer le libellé du bouton
  if (deckGenerateBtn) {
    deckGenerateBtn.textContent = isTranslate ? "🌐 Traduire" : "⚙️ Générer les JSON";
  }
}

if (deckActionJsonRadio) deckActionJsonRadio.addEventListener("change", updateDeckActionUI);
if (deckActionTranslateRadio) deckActionTranslateRadio.addEventListener("change", updateDeckActionUI);
updateDeckActionUI();

// ============================================================================
// DECKLIST — PARSING
// ============================================================================
const DECK_LINE_RE = /^(\d+)\s*x?\s+(.+)$/i;

function parseDecklist(text) {
  const names = [];
  text.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    if (/^(main|extra|side)\s*deck\s*:?$/i.test(line)) return;
    const match = line.match(DECK_LINE_RE);
    const name = match ? match[2].trim() : line;
    const count = match ? parseInt(match[1], 10) : 1;
    for (let i = 0; i < count; i++) names.push(name);
  });
  return names;
}

function setDeckItemStatus(li, statusClass, text) {
  const badge = li.querySelector(".badge");
  if (!badge) return;
  badge.className = `badge ${statusClass}`;
  badge.textContent = text;
}

document.getElementById("deck-fill-example").addEventListener("click", () => {
  deckInput.value =
`Main Deck:
1 Dark Magician
2 Blue-Eyes White Dragon
1 Buster Blader

Extra Deck:
1 Dark Paladin

Side Deck:
1 Fissure`;
});

document.getElementById("deck-clear").addEventListener("click", () => {
  deckInput.value = "";
  deckResultsEl.innerHTML = "";
  deckStatusEl.textContent = "";
  deckDownloadsRow.classList.add("hidden");
  progressWrap.classList.remove("visible");
  if (translationResultEl) translationResultEl.classList.add("hidden");
  if (translationActionsEl) translationActionsEl.classList.add("hidden");
  lastTranslationResult = null;
});

async function findCardByName(name, lang) {
  const allowYugi = isYugipediaEnabled();
  const { cards } = await searchCards(name, lang, allowYugi);
  if (!cards.length) return null;
  const normalizedTarget = normalizeForSearch(name);
  const exact = cards.find((c) => normalizeForSearch(c.name) === normalizedTarget);
  return exact || cards[0];
}

// ============================================================================
// DECKLIST — DISPATCHER (JSON ou Traduire)
// ============================================================================
deckGenerateBtn.addEventListener("click", async () => {
  if (isDeckActionTranslate()) {
    await runDeckTranslation();
  } else {
    await runDeckJsonGeneration();
  }
});

// ============================================================================
// DECKLIST — ACTION : GÉNÉRER LES JSON
// ============================================================================
async function runDeckJsonGeneration() {
  const names = parseDecklist(deckInput.value);
  if (!names.length) { toast("Colle d'abord une decklist.", "err"); return; }

  deckGenerateBtn.disabled = true;
  deckResultsEl.innerHTML = "";
  deckDownloadsRow.classList.add("hidden");
  translationResultEl.classList.add("hidden");
  translationActionsEl.classList.add("hidden");
  progressWrap.classList.add("visible");
  progressFill.style.width = "0%";
  progressPct.textContent = "0%";
  deckStatusEl.textContent = appState.dbReady ? "Recherche locale…" : "Recherche via API…";

  const itemEls = names.map((name) => {
    const li = document.createElement("li");
    li.className = "gen-item";
    li.innerHTML = `
      <span>⏳</span>
      <span class="name serif">${escapeHtml(name)}</span>
      <span class="badge info">En attente…</span>`;
    deckResultsEl.appendChild(li);
    return li;
  });

  const generatedFiles = [];
  const generatedCards = [];
  const resolved = new Map();

  const uniqueNames = [...new Set(names)];
  let done = 0;
  for (const n of uniqueNames) {
    try {
      const card = await findCardByName(n, "auto");
      if (card) resolved.set(n, card);
    } catch (err) {
      console.warn(`Échec recherche "${n}"`, err);
    }
    done++;
    const pct = Math.round((done / uniqueNames.length) * 60);
    progressFill.style.width = pct + "%";
    progressPct.textContent = pct + "%";
    progressLabel.textContent = `Recherche ${done} / ${uniqueNames.length} · ${n.slice(0, 30)}…`;
  }

  if (!appState.dbReady) {
    const idsNeedingFr = [];
    for (const card of resolved.values()) {
      if (card._source !== "yugipedia") idsNeedingFr.push(card.id);
    }
    if (idsNeedingFr.length) {
      try {
        await getCardsByIds(idsNeedingFr, "fr");
      } catch (e) { /* toléré */ }
    }
  }

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const li = itemEls[i];
    const found = resolved.get(name);
    if (!found) {
      setDeckItemStatus(li, "err", "❌ Introuvable");
    } else {
      try {
        const json = await generateJsonForCard(found);
        generatedFiles.push({
          filename: `${sanitizeFilename(found.name)}.json`,
          json: JSON.stringify(json, null, 2),
        });
        const fr = found._source === "yugipedia" ? null : await getCardById(found.id, "fr");
        const structural = found._source === "yugipedia"
          ? found
          : (structuralCardCache.get(found.id) || found);
        generatedCards.push({
          ...structural,
          name: (fr && fr.name) || found.name,
          desc: found.desc,
          pend_desc: found.pend_desc,
          monster_desc: found.monster_desc,
          displayRace: found.race,
        });
        setDeckItemStatus(li, found._source === "yugipedia" ? "info" : "ok",
          found._source === "yugipedia" ? "🟣 Yugipedia" : "✅ OK");
      } catch (err) {
        console.error(err);
        setDeckItemStatus(li, "err", "❌ Erreur");
      }
    }
    const pct = 60 + Math.round(((i + 1) / names.length) * 40);
    progressFill.style.width = pct + "%";
    progressPct.textContent = pct + "%";
    progressLabel.textContent = `Génération ${i + 1} / ${names.length}…`;
  }

  deckGenerateBtn.disabled = false;
  progressLabel.textContent = `Terminé : ${generatedFiles.length} / ${names.length}`;
  progressPct.textContent = "100%";
  progressFill.style.width = "100%";

  if (generatedFiles.length) {
    deckDownloadsRow.classList.remove("hidden");
    deckDownloadZipBtn.onclick = () => downloadAsZip(generatedFiles);
    deckDownloadCsvBtn.onclick = () => downloadManagerCsv(generatedCards);
  }
}

// ============================================================================
// DECKLIST — ACTION : TRADUIRE
// ============================================================================
function getTranslateSrc() {
  const r = document.querySelector('input[name="translate-src"]:checked');
  return r ? r.value : "auto";
}
function getTranslateDst() {
  const r = document.querySelector('input[name="translate-dst"]:checked');
  return r ? r.value : "fr";
}

async function runDeckTranslation() {
  const text = deckInput.value.trim();
  if (!text) { toast("Colle d'abord une decklist.", "err"); return; }

  const src = getTranslateSrc();
  const dst = getTranslateDst();

  deckGenerateBtn.disabled = true;
  deckStatusEl.textContent = appState.dbReady ? "Analyse locale…" : "Analyse via API…";
  translationResultEl.innerHTML = "";
  translationResultEl.classList.add("hidden");
  translationActionsEl.classList.add("hidden");
  deckResultsEl.innerHTML = "";
  deckDownloadsRow.classList.add("hidden");
  progressWrap.classList.remove("visible");

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const results = [];
  const cardNames = [];
  const cardIndexes = [];

  lines.forEach((line, idx) => {
    if (/^(main|extra|side)\s*deck\s*:?$/i.test(line)) {
      results[idx] = { type: "section", label: line };
      return;
    }
    const m = line.match(DECK_LINE_RE);
    const qty = m ? parseInt(m[1], 10) : 1;
    const name = m ? m[2].trim() : line;
    results[idx] = { type: "card", qty, name, translated: null, status: "pending" };
    cardNames.push(name);
    cardIndexes.push(idx);
  });

  const uniqueNames = [...new Set(cardNames)];
  const resolvedMap = new Map();
  let done = 0;

  for (const n of uniqueNames) {
    try {
      const card = await findCardByName(n, src);
      if (card) resolvedMap.set(n, card);
    } catch (err) { /* ignore */ }
    done++;
    deckStatusEl.textContent = `Résolution ${done} / ${uniqueNames.length}…`;
  }

  const targetLang = dst === "fr" ? "fr" : null;
  if (!appState.dbReady) {
    const idsToResolve = [];
    for (const resolved of resolvedMap.values()) {
      if (resolved._source !== "yugipedia") idsToResolve.push(resolved.id);
    }
    if (idsToResolve.length) {
      try {
        await getCardsByIds(idsToResolve, targetLang);
      } catch (e) { /* toléré */ }
    }
  }

  let okCount = 0;
  let totalCards = 0;

  for (const idx of cardIndexes) {
    const r = results[idx];
    const name = r.name;
    const resolved = resolvedMap.get(name);
    totalCards++;

    if (!resolved) { r.status = "err"; continue; }

    if (resolved._source === "yugipedia") {
      r.status = "ok";
      r.translated = resolved.name;
      r.source = "yugipedia";
      okCount++;
      continue;
    }

    let target = null;
    if (appState.dbReady) {
      target = dst === "fr"
        ? memCacheFr.get(String(resolved.id))
        : memCacheEn.get(String(resolved.id));
    } else {
      const cache = targetLang === "fr" ? cardFrByIdCache : cardByIdCache;
      target = cache.get(String(resolved.id)) || null;
    }

    if (!target) {
      r.status = "warn";
      r.translated = resolved.name;
      continue;
    }
    const translatedName = target.name;
    const isSame = translatedName.toLowerCase() === name.toLowerCase();
    if (isSame) {
      r.status = "warn";
      r.translated = translatedName;
    } else {
      r.status = "ok";
      r.translated = translatedName;
      okCount++;
    }
  }

  translationResultEl.innerHTML = "";
  results.forEach((r) => {
    if (!r) return;
    if (r.type === "section") {
      translationResultEl.innerHTML += `<div class="line section">${escapeHtml(r.label)}</div>`;
      return;
    }
    let badge, translated;
    if (r.status === "err") {
      badge = '<span class="badge err">❌ introuvable</span>';
      translated = '<span style="color:var(--text-dim)">—</span>';
    } else if (r.status === "warn") {
      badge = '<span class="badge warn">⚠️ pas de trad.</span>';
      translated = `<span style="color:var(--text-muted)">${escapeHtml(r.translated || r.name)}</span>`;
    } else {
      badge = r.source === "yugipedia"
        ? '<span class="badge yugi">🟣 Yugipedia</span>'
        : '<span class="badge ok">✅</span>';
      translated = `<span class="translated">${escapeHtml(r.translated)}</span>`;
    }
    translationResultEl.innerHTML += `
      <div class="line">
        <span class="qty">${r.qty}</span>
        <span class="name">${escapeHtml(r.name)}</span>
        <span class="arrow">→</span>
        ${translated}
        <span style="flex:1"></span>
        ${badge}
      </div>`;
  });

  translationResultEl.classList.remove("hidden");
  translationActionsEl.classList.remove("hidden");
  deckGenerateBtn.disabled = false;
  deckStatusEl.textContent = `Terminé : ${okCount} / ${totalCards} carte(s) traduite(s).`;
  lastTranslationResult = { results, dst };
  toast("Traduction terminée !", "ok");
}

// ============================================================================
// DECKLIST — BOUTONS DE TÉLÉCHARGEMENT (JSON)
// ============================================================================
async function downloadAsZip(files) {
  if (typeof JSZip === "undefined") { toast("JSZip non chargé.", "err"); return; }
  const zip = new JSZip();
  const usedNames = new Map();
  files.forEach(({ filename, json }) => {
    let finalName = filename;
    if (usedNames.has(filename)) {
      const n = usedNames.get(filename) + 1;
      usedNames.set(filename, n);
      finalName = filename.replace(/\.json$/, `-${n}.json`);
    } else usedNames.set(filename, 1);
    zip.file(finalName, json);
  });
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, "cartes-ygopro.zip");
}

// ============================================================================
// DECKLIST — BOUTONS DE TÉLÉCHARGEMENT (TRADUCTION)
// ============================================================================
if (translateCopyBtn) {
  translateCopyBtn.addEventListener("click", () => {
    if (!lastTranslationResult) return;
    const txt = buildTranslatedDecklist(lastTranslationResult);
    copyTextToClipboard(txt, null, null);
    toast("Decklist copiée !", "ok");
  });
}
if (translateDownloadTxtBtn) {
  translateDownloadTxtBtn.addEventListener("click", () => {
    if (!lastTranslationResult) return;
    const txt = buildTranslatedDecklist(lastTranslationResult);
    downloadBlob(txt, "decklist-traduite.txt", "text/plain;charset=utf-8");
  });
}
if (translateDownloadYdkBtn) {
  translateDownloadYdkBtn.addEventListener("click", () => {
    toast("Export .ydk non supporté en traduction.", "info");
  });
}

function buildTranslatedDecklist({ results }) {
  return results.filter(Boolean).map((r) => {
    if (r.type === "section") return r.label;
    const name = r.translated || r.name;
    return `${r.qty} ${name}`;
  }).join("\n");
}

// ============================================================================
// CSV MANAGER
// ============================================================================
const CSV_FIELDS = [
  "Format", "Frame", "Name", "Attribute", "Star", "Spell/Trap Icon", "Art Link",
  "Type Ability", "Effect", "Set Id", "ATK", "DEF", "Password", "Sticker",
  "Copyright", "Is Pendulum", "Pendulum Effect", "Pendulum Scale Red",
  "Pendulum Scale Blue", "Is Link", "Link - Top Left Arrow", "Link - Top Arrow",
  "Link - Top Right Arrow", "Link - Left Arrow", "Link - Right Arrow",
  "Link - Bottom Left Arrow", "Link - Bottom Arrow", "Link - Bottom Right Arrow",
  "Is First Edition", "Is Speed Card", "Is Limited Edition",
  "Is Duel Terminal Card", "Is Legacy Card", "Foil", "Art Finish", "Card Finish",
  "Art Crop - X (%)", "Art Crop - Y (%)", "Art Crop - Width (%)",
  "Art Crop - Height (%)", "Is Using Full Art", "Region", "Star Type",
  "Star Alignment", "Card Icon Type", "Link Rating", "Opacity - Body",
  "Opacity - Pendulum", "Opacity - Text", "Opacity - Name",
  "Opacity - Base Fill", "Opacity - Art Border", "Opacity - Name Border",
  "Opacity - Effect Box", "Opacity - Boundless", "Has Background",
  "Background Link", "Is Using Full Background", "Background Type",
  "Background Crop - X (%)", "Background Crop - Y (%)",
  "Background Crop - Width (%)", "Background Crop - Height (%)",
  "Bottom Frame", "Condense Rate", "Use Furigana Helper", "Name Style Type",
  "Name Style - Font", "Name Style - Fill Style",
  "Name Style - Headtext Fill Style", "Name Style - Shadow Color",
  "Name Style - Shadow Offset Y", "Name Style - Shadow Offset X",
  "Name Style - Shadow Blur", "Name Style - Has Shadow",
  "Name Style - Line Color", "Name Style - Line Width",
  "Name Style - Line Offset Y", "Name Style - Line Offset X",
  "Name Style - Has Outline", "Name Style - Gradient Angle",
  "Name Style - Gradient Color", "Name Style - Has Gradient",
  "Name Style - Emboss Pitch", "Name Style - Emboss Yaw",
  "Name Style - Emboss Thickness", "Name Style - Has Emboss",
  "Name Style - Preset", "Name Style - Pattern", "Stat Style - Is Custom",
  "Stat Style - Fill Color", "Stat Style - Has Shadow",
  "Stat Style - Shadow Color", "Type Style - Is Custom",
  "Type Style - Fill Color", "Type Style - Has Shadow",
  "Type Style - Shadow Color", "Effect Style - Is Custom",
  "Effect Style - Fill Color", "Effect Style - Has Shadow",
  "Effect Style - Shadow Color", "Effect Style - Upsize",
  "Effect Style - Font Style", "Effect Style - Background",
  "Effect Style - Min Line", "Effect Style - Justify Ratio", "Pendulum Size",
  "Pendulum Effect Style - Is Custom", "Pendulum Effect Style - Fill Color",
  "Pendulum Effect Style - Has Shadow", "Pendulum Effect Style - Shadow Color",
  "Pendulum Effect Style - Upsize", "Pendulum Effect Style - Font Style",
  "Pendulum Effect Style - Background", "Pendulum Effect Style - Min Line",
  "Pendulum Effect Style - Justify Ratio", "Other Style - Is Custom",
  "Other Style - Fill Color", "Other Style - Has Shadow",
  "Other Style - Shadow Color", "Other Finish - Attribute",
  "Other Finish - Background", "Other Finish - Icon", "Other Finish - Sticker",
  "Left Frame", "Right Frame", "Bottom Right Frame", "Dye List", "Star List",
  "Flag", "External Info (JSON)",
];

const RACE_TO_ICON_INTERNAL = {
  Continuous: "CONTINUOUS", Counter: "COUNTER", Equip: "EQUIP",
  Field: "FIELD", "Quick-Play": "QUICK-PLAY", Ritual: "RITUAL", Normal: "NO ICON",
};

function buildIconInternal(card) {
  if (card.type === "Spell Card" || card.type === "Trap Card") {
    return RACE_TO_ICON_INTERNAL[card.race] || "NO ICON";
  }
  return "NO ICON";
}
function buildAttributeInternal(card) {
  if (card.type === "Spell Card") return "SPELL";
  if (card.type === "Trap Card") return "TRAP";
  if (!card.attribute) return "NONE";
  return card.attribute.toUpperCase();
}
function csvQuote(value) {
  if (value === undefined || value === null || value === "") return "";
  return `"${String(value).replace(/"/g, '""')}"`;
}

function buildCsvRow(card) {
  const isSpell = card.type === "Spell Card";
  const isTrap = card.type === "Trap Card";
  const [baseFrame, pendulumSuffix] = (card.frameType || "").split("_");
  const isPendulum = pendulumSuffix === "pendulum";
  const isLink = baseFrame === "link";
  const links = buildLinkMarkers(card);
  const img = card.card_images && card.card_images[0];
  const imgUrl = img ? (img.image_url_cropped || img.image_url) : "";

  const values = {
    Format: "tcg",
    Frame: buildLayout(baseFrame).toLowerCase(),
    Name: card.name,
    Attribute: buildAttributeInternal(card),
    Star: String(card.level || card.linkval || ""),
    "Spell/Trap Icon": buildIconInternal(card),
    "Art Link": imgUrl,
    "Type Ability": buildTypeLine(card),
    Effect: buildEffectText(card),
    "Set Id": String(card.id || ""),
    ATK: isSpell || isTrap ? "" : String(card.atk ?? ""),
    DEF: isSpell || isTrap || isLink ? "" : String(card.def ?? ""),
    Sticker: "no-sticker",
    Copyright: "© 2026 YGOPRO.ORG",
    "Is Pendulum": isPendulum ? "true" : "false",
    "Pendulum Effect": isPendulum ? card.pend_desc || "" : "",
    "Pendulum Scale Red": isPendulum ? String(card.scale ?? "0") : "",
    "Pendulum Scale Blue": isPendulum ? String(card.scale ?? "0") : "",
    "Is Link": isLink ? "true" : "false",
    "Link - Top Left Arrow": links.topLeft ? "true" : "false",
    "Link - Top Arrow": links.topCenter ? "true" : "false",
    "Link - Top Right Arrow": links.topRight ? "true" : "false",
    "Link - Left Arrow": links.middleLeft ? "true" : "false",
    "Link - Right Arrow": links.middleRight ? "true" : "false",
    "Link - Bottom Left Arrow": links.bottomLeft ? "true" : "false",
    "Link - Bottom Arrow": links.bottomCenter ? "true" : "false",
    "Link - Bottom Right Arrow": links.bottomRight ? "true" : "false",
    Region: "fr",
  };
  return CSV_FIELDS.map((f) => csvQuote(values[f])).join(",");
}

function buildManagerCsv(cards) {
  const header = CSV_FIELDS.join(",");
  const rows = cards.map(buildCsvRow);
  return [header, ...rows].join("\n");
}
function downloadManagerCsv(cards) {
  const csv = buildManagerCsv(cards);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, "cartes-ygopro-manager.csv");
}

// ============================================================================
// UTILITAIRES
// ============================================================================
function downloadBlob(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sanitizeFilename(name) { return name.replace(/[\\/:*?"<>|]/g, "").trim(); }
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ============================================================================
// BOUTONS BASE LOCALE
// ============================================================================
if (dbBannerInstall) dbBannerInstall.addEventListener("click", () => downloadFullDatabase());
if (dbBannerSkip) dbBannerSkip.addEventListener("click", () => {
  hideInstallBanner();
  toast("Mode API activé. Tu peux installer la base plus tard.", "info");
});

if (dbSyncBtn) {
  dbSyncBtn.addEventListener("click", (e) => {
    syncDatabase(e.shiftKey === true);
  });
  dbSyncBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    syncDatabase(true);
  });
  dbSyncBtn.title = "Synchroniser (Shift+clic ou clic droit pour forcer)";
}

// ============================================================================
// EXPOSITION POUR cdb-translator.js
// ============================================================================
window.appState = appState;
window.idbGet = idbGet;
window.idbPut = idbPut;
window.idbDelete = idbDelete;
window.idbGetAll = idbGetAll;
window.IDB_STORE_YUGI_CARDS = IDB_STORE_YUGI_CARDS;
window.IDB_STORE_YUGI_SEARCH = IDB_STORE_YUGI_SEARCH;

// Exposer les helpers utiles au cdb-translator
window.findCardByName = findCardByName;
window.generateJsonForCard = generateJsonForCard;
window.buildCsvRow = buildCsvRow;
window.CSV_FIELDS = CSV_FIELDS;
window.downloadAsZip = downloadAsZip;
window.downloadManagerCsv = downloadManagerCsv;
window.sanitizeFilename = sanitizeFilename;
window.searchCards = searchCards;
window.isYugipediaEnabled = isYugipediaEnabled;
window.toast = toast;
window.downloadBlob = downloadBlob;
window.escapeHtml = escapeHtml;

// ============================================================================
// MODAL DE CONFIRMATION CUSTOM
// ============================================================================
function showConfirm(message, title = "Confirmation") {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-title");
    const msgEl = document.getElementById("confirm-message");
    const yesBtn = document.getElementById("confirm-yes");
    const noBtn = document.getElementById("confirm-no");

    if (!modal || !yesBtn || !noBtn) {
      resolve(window.confirm(message));
      return;
    }

    titleEl.textContent = title;
    msgEl.textContent = message;
    modal.classList.add("open");

    const cleanup = (result) => {
      modal.classList.remove("open");
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => { if (e.key === "Escape") cleanup(false); };

    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

window.showConfirm = showConfirm;

// ============================================================================
// DÉMARRAGE
// ============================================================================
(async function boot() {
  await initDatabase();
  if (appState.dbReady) {
    toast("Base locale prête ⚡", "ok");
  } else {
    toast("Mode API. Installe la base pour plus de vitesse.", "info");
  }
})();
