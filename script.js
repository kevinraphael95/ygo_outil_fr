// ============================================================================
// YGO -> ygopro.org Card Maker JSON generator (v7 — JSON local)
// ============================================================================
// L'app charge 2 fichiers JSON locaux :
//   • data/cards-db.json      → YGOPRODeck (EN + FR)
//   • data/yugipedia-db.json  → Yugipedia (anime, manga…)
// Aucune requête API au démarrage. Fallback API direct si JSON absents.
// ============================================================================

const API_BASE = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const MIN_QUERY_LENGTH = 2;

const MIN_DELAY_MS = 200;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const REQUEST_TIMEOUT = 15000;
const BATCH_ID_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;

const MAX_STRUCTURAL_CACHE = 500;
const TOAST_MAX_LENGTH = 200;

// --- Chemins des fichiers JSON ---
const JSON_CARDS_DB = "data/cards-db.json";
const JSON_YUGIPEDIA_DB = "data/yugipedia-db.json";

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

const deckActionJsonRadio = document.getElementById("deck-action-json");
const deckActionTranslateRadio = document.getElementById("deck-action-translate");
const deckTranslateOptions = document.getElementById("deck-translate-options");

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

const dbBadge = document.getElementById("db-badge");

// ----------------------------------------------------------------------------
// État global
// ----------------------------------------------------------------------------
const appState = {
  dbReady: false,
  dbMeta: null,
};

Object.defineProperty(window, "dbReady", {
  get: () => appState.dbReady,
  set: (v) => { appState.dbReady = v; },
});

let activeController = null;
let lastTranslationResult = null;

// ⚡ Maps en mémoire (chargées depuis les JSON)
const memCacheEn = new Map();
const memCacheFr = new Map();
window.yugiCache = new Map();

const searchCache = new Map();
const cardByIdCache = new Map();
const cardFrByIdCache = new Map();
const structuralCardCache = new Map();

// ============================================================================
// INITIALISATION — CHARGE LES 2 FICHIERS JSON LOCAUX
// ============================================================================
async function initDatabase() {
  try {
    // ─── 1. cards-db.json (YGOPRODeck) ───
    try {
      console.log("[DB] Chargement cards-db.json…");
      const res = await fetch(JSON_CARDS_DB);
      if (res.ok) {
        const cardsDb = await res.json();
        let count = 0;
        for (const [id, card] of Object.entries(cardsDb)) {
          const imgArray = card.img_cropped ? [{
            id: parseInt(id, 10),
            image_url: card.img_full,
            image_url_cropped: card.img_cropped,
          }] : [];

          memCacheEn.set(String(id), {
            id: parseInt(id, 10),
            name: card.en,
            type: card.type, frameType: card.frameType,
            desc: card.desc_en,
            atk: card.atk, def: card.def, level: card.level,
            race: card.race, attribute: card.attribute,
            linkval: card.linkval, linkmarkers: card.linkmarkers,
            scale: card.scale,
            card_images: imgArray,
          });

          if (card.fr) {
            memCacheFr.set(String(id), {
              id: parseInt(id, 10),
              name: card.fr,
              type: card.type, frameType: card.frameType,
              desc: card.desc_fr,
              atk: card.atk, def: card.def, level: card.level,
              race: card.race, attribute: card.attribute,
              linkval: card.linkval, linkmarkers: card.linkmarkers,
              scale: card.scale,
              card_images: imgArray,
            });
          }
          count++;
        }
        console.log(`[DB] ✅ cards-db.json : ${count} cartes`);
      } else {
        console.warn(`[DB] cards-db.json HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn("[DB] cards-db.json indisponible :", e.message);
    }

    // ─── 2. yugipedia-db.json (Yugipedia) ───
    try {
      console.log("[DB] Chargement yugipedia-db.json…");
      const res = await fetch(JSON_YUGIPEDIA_DB);
      if (res.ok) {
        const yugiDb = await res.json();
        let count = 0;
        for (const [key, card] of Object.entries(yugiDb)) {
          if (!card.en && !card.fr) continue;
          window.yugiCache.set(key, card);
          count++;
        }
        console.log(`[DB] ✅ yugipedia-db.json : ${count} cartes`);
      } else {
        console.warn(`[DB] yugipedia-db.json HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn("[DB] yugipedia-db.json indisponible :", e.message);
    }

    // ─── 3. Exposition ───
    window.memCacheEn = memCacheEn;
    window.memCacheFr = memCacheFr;

    // ─── 4. UI ───
    appState.dbReady = memCacheEn.size > 0 || memCacheFr.size > 0;
    if (appState.dbReady) {
      updateDbBadge(memCacheEn.size, memCacheFr.size);
      console.log(`[DB] 🎯 Prêt : ${memCacheEn.size} EN, ${memCacheFr.size} FR`);
    }
  } catch (err) {
    console.error("[DB] Init échouée", err);
    appState.dbReady = false;
  }
}

function updateDbBadge(countEn, countFr) {
  if (!dbBadge) return;
  const countYugi = window.yugiCache ? window.yugiCache.size : 0;
  dbBadge.classList.remove("hidden");
  dbBadge.innerHTML = `🟢 YGOPRODeck · ${countEn.toLocaleString("fr-FR")} · 🟣 Yugipedia · ${countYugi.toLocaleString("fr-FR")}`;
  dbBadge.title = `${countEn} cartes YGOPRODeck (EN), ${countFr} FR, ${countYugi} Yugipedia`;
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

async function getCardsByIds(ids, language) {
  if (!ids.length) return new Map();
  const results = new Map();
  const uncached = [];
  const cache = language === "fr" ? cardFrByIdCache : cardByIdCache;
  for (const id of ids) {
    const key = String(id);
    if (cache.has(key)) results.set(key, cache.get(key));
    else uncached.push(key);
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
      for (const id of chunk) if (!results.has(id)) results.set(id, null);
    } catch (err) { console.warn("[API] Batch échoué", err); }
  }
  return results;
}

// ============================================================================
// RECHERCHE
// ============================================================================
function normalizeForSearch(str) {
  return String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function searchCards(query, lang = "auto", allowYugipedia = false) {
  if (appState.dbReady) {
    const local = searchLocal(query, lang);
    if (local.cards.length) return local;
  } else {
    const remote = await searchRemote(query, lang);
    if (remote.cards.length) return remote;
  }
  if (allowYugipedia && window.yugiCache && query.length >= 3) {
      const key = normalizeForSearch(query).replace(/[^a-z0-9]/g, "");
      const yugiCard = window.yugiCache.get(key);
    if (yugiCard) {
      return {
        cards: [{
          id: "yugi-" + key,
          name: yugiCard.fr || yugiCard.en,
          type: yugiCard.card_type === "Spell" ? "Spell Card" : yugiCard.card_type === "Trap" ? "Trap Card" : "Effect Monster",
          frameType: yugiCard.type && yugiCard.type.toLowerCase().includes("fusion") ? "fusion" : "effect",
          desc: yugiCard.fr_lore || yugiCard.lore,
          atk: yugiCard.atk, def: yugiCard.def, level: yugiCard.level,
          race: yugiCard.race, attribute: yugiCard.attribute,
          card_images: yugiCard.img ? [{ image_url: yugiCard.img, image_url_cropped: yugiCard.img }] : [],
          _source: "yugipedia",
          _names: { fr: yugiCard.fr, en: yugiCard.en },
        }],
        usedLanguage: "yugipedia",
        source: "yugipedia",
      };
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
    if (found.length) return { cards: found, usedLanguage: code };
  }
  return { cards: [], usedLanguage: lang === "auto" ? "fr" : lang };
}

async function searchRemote(query, lang) {
  const cacheKey = `${lang}::${query.toLowerCase()}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);
  const tryLanguages = { auto: ["fr", null], fr: ["fr"], en: [null], ja: ["ja"] }[lang] || ["fr", null];
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
  } catch (err) { return null; }
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
// MODAL À PROPOS
// ============================================================================
aboutBtn.addEventListener("click", () => {
  aboutModal.classList.add("open");
});
aboutClose.addEventListener("click", closeAbout);
aboutModal.addEventListener("click", (e) => { if (e.target === aboutModal) closeAbout(); });
function closeAbout() { aboutModal.classList.remove("open"); }

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
  const truncated = text.length > TOAST_MAX_LENGTH ? text.slice(0, TOAST_MAX_LENGTH) + "…" : text;
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
  const allowYugi = window.yugiCache && window.yugiCache.size > 0;
  try {
    const { cards, usedLanguage, source } = await searchCards(query, lang, allowYugi);
    if (!cards.length) {
      resultsCountEl.textContent = "Aucune carte trouvée.";
      return;
    }
    resultsCountEl.textContent = `${cards.length} résultat${cards.length > 1 ? "s" : ""}`;
    resultsLangEl.innerHTML = source === "yugipedia" ? "🟣 trouvés sur Yugipedia" : langBadge(usedLanguage);
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
  const codes = { fr: "fr", en: "gb", ja: "jp", de: "de", it: "it", pt: "pt" };
  const names = { fr: "FR", en: "EN", ja: "JA", de: "DE", it: "IT", pt: "PT" };
  const code = codes[lang];
  const name = names[lang] || lang.toUpperCase();
  const flagImg = code ? `<img class="flag" src="https://flagcdn.com/${code}.svg" alt="">` : "🌐";
  if (lang === "en") return `${flagImg} trouvés en ${name} (pas de trad. FR)`;
  return `${flagImg} trouvés en ${name}`;
}

// ============================================================================
// RENDU DES RÉSULTATS
// ============================================================================
function renderResults(cards) {
  resultsEl.innerHTML = "";
  cards.slice(0, 60).forEach((card) => resultsEl.appendChild(buildCardTile(card)));
}

function buildCardTile(card) {
  const tile = document.createElement("div");
  tile.className = "card-tile";
  tile.dataset.frame = card.frameType || "normal";
  tile.tabIndex = 0;
  tile.setAttribute("role", "button");
  const img = card.card_images && card.card_images[0];
  const imgUrl = img ? (img.image_url_cropped || img.image_url) : "";
  const imgHtml = imgUrl ? `<img src="${imgUrl}" alt="${escapeHtml(card.name)}" loading="lazy">` : `<span>🃏</span>`;
  const gemClass = card.attribute ? `gem ${card.attribute.toUpperCase()}` : "";
  const gem = card.attribute ? `<span class="${gemClass}" title="${card.attribute}"></span>` : "";
  const stars = card.level ? `<span class="stars">${"★".repeat(Math.min(card.level, 12))}</span>` : "";
  const typeLabel = getTypeLabel(card);
  const yugiBadge = card._source === "yugipedia" ? `<span class="badge yugi" title="Traduit via Yugipedia">🟣 Yugipedia</span>` : "";
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
  const labels = { normal: "Normal", effect: "Effet", ritual: "Rituel", fusion: "Fusion", synchro: "Synchro", xyz: "Xyz", link: "Lien", token: "Jeton", skill: "Skill" };
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
  const stars = card.level ? `<span class="stars" style="color:var(--gold);">${"★".repeat(Math.min(card.level, 12))}</span>` : "";
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
    ? `<p style="color:#b88ae0; font-size:0.82rem; margin-top:8px;">🟣 Source : cache Yugipedia local</p>`
    : "";
  drawerBody.innerHTML = `
    <img class="drawer-image" id="drawer-img" alt="${escapeHtml(card.name)}" src="${imgUrl}">
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
    } catch (err) { structural = card; }
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
const FRAME_TO_LAYOUT = { normal: "Normal", effect: "Effect", ritual: "Ritual", fusion: "Fusion", synchro: "Synchro", xyz: "Xyz", link: "Link", token: "Token", spell: "Spell", trap: "Trap", skill: "Skill" };
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
const RACE_TO_ICON = { Continuous: "Continuous", Counter: "Counter", Equip: "Equip", Field: "Field", "Quick-Play": "Quick-play", Ritual: "Ritual", Normal: "None" };
function buildIcon(card) {
  if (card.type === "Spell Card" || card.type === "Trap Card") return RACE_TO_ICON[card.race] || "None";
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
  let text = card.desc || "";
  text = text.replace(/^[#=*\-_\s]{3,}$/gm, " ◆ ◆ ◆ ");
  text = text.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ");
  text = text.replace(/\s+/g, " ");
  text = text.replace(/(\s*●\s*)+/g, " ● ");
  text = text.replace(/^\s*●\s*/, "").replace(/\s*●\s*$/, "");
  return text.trim();
}
function buildLinkMarkers(card) {
  const base = { topLeft: false, topCenter: false, topRight: false, middleLeft: false, middleRight: false, bottomLeft: false, bottomCenter: false, bottomRight: false };
  if (!card.linkmarkers) return base;
  const map = { "Top-Left": "topLeft", Top: "topCenter", "Top-Right": "topRight", Left: "middleLeft", Right: "middleRight", "Bottom-Left": "bottomLeft", Bottom: "bottomCenter", "Bottom-Right": "bottomRight" };
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
// DECKLIST
// ============================================================================
function isDeckActionTranslate() { return deckActionTranslateRadio && deckActionTranslateRadio.checked; }
function updateDeckActionUI() {
  const isTranslate = isDeckActionTranslate();
  if (deckTranslateOptions) deckTranslateOptions.classList.toggle("hidden", !isTranslate);
  if (translationResultEl) translationResultEl.classList.add("hidden");
  if (translationActionsEl) translationActionsEl.classList.add("hidden");
  if (deckDownloadsRow) deckDownloadsRow.classList.add("hidden");
  if (deckResultsEl) deckResultsEl.innerHTML = "";
  if (deckStatusEl) deckStatusEl.textContent = "";
  if (progressWrap) progressWrap.classList.remove("visible");
  if (deckGenerateBtn) deckGenerateBtn.textContent = isTranslate ? "🌐 Traduire" : "⚙️ Générer les JSON";
}
if (deckActionJsonRadio) deckActionJsonRadio.addEventListener("change", updateDeckActionUI);
if (deckActionTranslateRadio) deckActionTranslateRadio.addEventListener("change", updateDeckActionUI);
updateDeckActionUI();

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
  deckInput.value = `Main Deck:
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
  const { cards } = await searchCards(name, lang, true);
  if (!cards.length) return null;
  const normalizedTarget = normalizeForSearch(name);
  const exact = cards.find((c) => normalizeForSearch(c.name) === normalizedTarget);
  return exact || cards[0];
}
deckGenerateBtn.addEventListener("click", async () => {
  if (isDeckActionTranslate()) await runDeckTranslation();
  else await runDeckJsonGeneration();
});

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
    li.innerHTML = `<span>⏳</span><span class="name serif">${escapeHtml(name)}</span><span class="badge info">En attente…</span>`;
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
    } catch (err) { console.warn(`Échec "${n}"`, err); }
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
    if (idsNeedingFr.length) { try { await getCardsByIds(idsNeedingFr, "fr"); } catch (e) {} }
  }
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const li = itemEls[i];
    const found = resolved.get(name);
    if (!found) setDeckItemStatus(li, "err", "❌ Introuvable");
    else {
      try {
        const json = await generateJsonForCard(found);
        generatedFiles.push({ filename: `${sanitizeFilename(found.name)}.json`, json: JSON.stringify(json, null, 2) });
        const fr = found._source === "yugipedia" ? null : await getCardById(found.id, "fr");
        const structural = found._source === "yugipedia" ? found : (structuralCardCache.get(found.id) || found);
        generatedCards.push({ ...structural, name: (fr && fr.name) || found.name, desc: found.desc, pend_desc: found.pend_desc, monster_desc: found.monster_desc, displayRace: found.race });
        setDeckItemStatus(li, found._source === "yugipedia" ? "info" : "ok", found._source === "yugipedia" ? "🟣 Yugipedia" : "✅ OK");
      } catch (err) { console.error(err); setDeckItemStatus(li, "err", "❌ Erreur"); }
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

function getTranslateSrc() { const r = document.querySelector('input[name="translate-src"]:checked'); return r ? r.value : "auto"; }
function getTranslateDst() { const r = document.querySelector('input[name="translate-dst"]:checked'); return r ? r.value : "fr"; }

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
    if (/^(main|extra|side)\s*deck\s*:?$/i.test(line)) { results[idx] = { type: "section", label: line }; return; }
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
    try { const card = await findCardByName(n, src); if (card) resolvedMap.set(n, card); } catch (err) {}
    done++;
    deckStatusEl.textContent = `Résolution ${done} / ${uniqueNames.length}…`;
  }
  const targetLang = dst === "fr" ? "fr" : null;
  if (!appState.dbReady) {
    const idsToResolve = [];
    for (const resolved of resolvedMap.values()) {
      if (resolved._source !== "yugipedia") idsToResolve.push(resolved.id);
    }
    if (idsToResolve.length) { try { await getCardsByIds(idsToResolve, targetLang); } catch (e) {} }
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
      r.status = "ok"; r.translated = resolved.name; r.source = "yugipedia"; okCount++; continue;
    }
    let target = null;
    if (appState.dbReady) {
      target = dst === "fr" ? memCacheFr.get(String(resolved.id)) : memCacheEn.get(String(resolved.id));
    } else {
      const cache = targetLang === "fr" ? cardFrByIdCache : cardByIdCache;
      target = cache.get(String(resolved.id)) || null;
    }
    if (!target) { r.status = "warn"; r.translated = resolved.name; continue; }
    const translatedName = target.name;
    const isSame = translatedName.toLowerCase() === name.toLowerCase();
    if (isSame) { r.status = "warn"; r.translated = translatedName; }
    else { r.status = "ok"; r.translated = translatedName; okCount++; }
  }
  translationResultEl.innerHTML = "";
  results.forEach((r) => {
    if (!r) return;
    if (r.type === "section") { translationResultEl.innerHTML += `<div class="line section">${escapeHtml(r.label)}</div>`; return; }
    let badge, translated;
    if (r.status === "err") {
      badge = '<span class="badge err">❌ introuvable</span>';
      translated = '<span style="color:var(--text-dim)">—</span>';
    } else if (r.status === "warn") {
      badge = '<span class="badge warn">⚠️ pas de trad.</span>';
      translated = `<span style="color:var(--text-muted)">${escapeHtml(r.translated || r.name)}</span>`;
    } else {
      badge = r.source === "yugipedia" ? '<span class="badge yugi">🟣 Yugipedia</span>' : '<span class="badge ok">✅</span>';
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
  if (card.type === "Spell Card" || card.type === "Trap Card") return RACE_TO_ICON_INTERNAL[card.race] || "NO ICON";
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
  return `"${String(value).replace(/"/g, '""').replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ")}"`;
}
function buildCsvRow(card) {
  const isSpell = card.type === "Spell Card";
  const isTrap = card.type === "Trap Card";
  const [baseFrame, pendulumSuffix] = (card.frameType || "").split("_");
  const isPendulum = pendulumSuffix === "pendulum";
  const isLink = baseFrame === "link";
  const links = buildLinkMarkers(card);
  const img = card.card_images && card.card_images[0];
  const rawImgUrl = img ? (img.image_url_cropped || img.image_url) : "";
  const imgUrl = rawImgUrl ? `https://images.weserv.nl/?url=${encodeURIComponent(rawImgUrl.replace(/^https?:\/\//, ""))}` : "";
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
    "Effect Style - Justify Ratio": "100",
    "Effect Style - Min Line": "0",
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
  const BOM = "\uFEFF";
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, "cartes-ygopro-manager.csv");
}

// ============================================================================
// UTILITAIRES
// ============================================================================
function downloadBlob(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sanitizeFilename(name) { return name.replace(/[\\/:*?"<>|]/g, "").trim(); }
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ============================================================================
// EXPOSITION POUR cdb-translator.js
// ============================================================================
window.appState = appState;
window.findCardByName = findCardByName;
window.generateJsonForCard = generateJsonForCard;
window.buildCsvRow = buildCsvRow;
window.CSV_FIELDS = CSV_FIELDS;
window.downloadAsZip = downloadAsZip;
window.downloadManagerCsv = downloadManagerCsv;
window.sanitizeFilename = sanitizeFilename;
window.searchCards = searchCards;
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
    if (!modal || !yesBtn || !noBtn) { resolve(window.confirm(message)); return; }
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
    toast("Aucune base locale chargée.", "err");
  }
})();
