// ============================================================================
// 01-config.js — Constantes, IDs custom, références DOM, état global, caches
// ============================================================================
// ⚠️ À charger EN PREMIER (tous les autres fichiers en dépendent).
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
// IDs CUSTOM — Cartes anime / non officielles
// ----------------------------------------------------------------------------
const CUSTOM_IDS = {
  // ─── Magies / Pièges classiques de l'anime ───
  "potde cupidite": "55144522",
  "pot of greed": "55144522",
  "charitegracieuse": "79571449",
  "graceful charity": "79571449",

  // ─── Ajoute tes autres cartes anime ici ───
  // "nom de la carte": "passcode",
};

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
const deckDownloadYdkBtn = document.getElementById("deck-download-ydk");
const deckDownloadsRow = document.getElementById("deck-downloads");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const progressPct = document.getElementById("progress-pct");

const deckActionJsonRadio = document.getElementById("deck-action-json");
const deckActionTranslateRadio = document.getElementById("deck-action-translate");
const deckActionYdkRadio = document.getElementById("deck-action-ydk");
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
