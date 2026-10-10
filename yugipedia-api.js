// ============================================================================
// YUGIPEDIA API MODULE — Fallback pour cartes absentes de YGOPRODeck
// ============================================================================
// Ce module interroge l'API MediaWiki de Yugipedia pour récupérer les
// traductions FR officielles des cartes absentes de YGOPRODeck.
//
// ⚡ RÈGLE STRICTE :
//   On ne récupère la carte QUE si elle a :
//     - un nom FRANÇAIS (fr_name) → on prend FR
//     - OU un nom ANGLAIS (en_name / translated_name en anglais) → on prend EN
//   Sinon → on IGNORE (japonais, coréen, chinois, etc. = pas utile)
//
// ⚡ OPTIMISATIONS :
//   1. Skip les noms japonais (romaji avec macrons) → pas de requête
//   2. Skip les noms CJK (kanji/kana/hangul) → pas de requête
//   3. BATCH : plusieurs titres en 1 requête (max 50 par appel)
//   4. Cache mémoire + IndexedDB (30 jours)
//
// ⚡ NOUVEAU — Recherche en 2 passes :
//   PASSE 1 : teste plusieurs variantes de titre ("Nom", "Nom (anime)",
//             "Nom (card)", "Nom (manga)", "Nom (Duel_Links)", "Nom (video_game)")
//             → toutes envoyées en 1 seul batch → rapide.
//   PASSE 2 : pour les cartes encore introuvables, utilise list=search de
//             MediaWiki (intitle:"Nom") → trouve TOUTES les pages dont le
//             titre contient ce nom, peu importe le suffixe. Lent (1 req/s)
//             mais exhaustif.
//
// Règles de politesse (obligatoires) :
//   • Max 1 requête / seconde
//   • Cache obligatoire (30 jours)
//   • Fallback gracieux (jamais de crash)
//
// ⚠️ NOTE CORS :
//   Le navigateur interdit l'envoi manuel du header User-Agent (forbidden
//   header name en CORS). On utilise donc le paramètre `origin=*` de
//   MediaWiki pour autoriser les requêtes cross-origin sans préflight.
//
// ⚠️ TEMPLATES SUPPORTÉS :
//   - {{CardTable2}}       → cartes TCG/OCG normales
//   - {{Anime card}}       → cartes d'anime
//   - {{Manga card}}       → cartes de manga
//   - {{Video game card}}  → cartes de jeux vidéo
//   - {{OCG card}}         → variantes OCG
//   - {{TCG card}}         → variantes TCG
//
// Exposé globalement via window.YugipediaAPI + raccourcis directs
// ============================================================================

(() => {
  "use strict";

  // ==========================================================================
  // CONFIGURATION
  // ==========================================================================

  const YUGIPEDIA_API = "https://yugipedia.com/api.php";
  const YUGIPEDIA_UA =
    "Yu-Gi-Oh Traducteur de cartes en VF/1.0 " +
    "(https://github.com/kevinraphael95; kevinyugioh@gmail.com)";
  const YUGIPEDIA_DELAY = 1100;
  const REQUEST_TIMEOUT = 12000;
  const MAX_RETRIES = 3;
  const RETRY_BASE_DELAY = 2000;
  const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  const BATCH_SIZE = 50; // Max 50 titres par requête (limite MediaWiki)

  const IDB_NAME = "ygo-cards-db";
  const IDB_VERSION = 2;
  const IDB_STORE_YUGI_CARDS = "yugipedia_cards";
  const IDB_STORE_YUGI_SEARCH = "yugipedia_search";

  const LS_KEY_ENABLED = "ygo-yugipedia-enabled";
  const LS_KEY_STATS = "ygo-yugipedia-stats";

  const CARD_TEMPLATES = [
    "CardTable2",
    "Anime card",
    "Manga card",
    "Video game card",
    "OCG card",
    "TCG card",
  ];

  // ⚡ Suffixes probables à tester sur Yugipedia (passe 1 du batch)
  const TITLE_SUFFIXES = [
    "anime",
    "manga",
    "card",
    "Duel_Links",
    "video_game",
  ];

  // ==========================================================================
  // ÉTAT INTERNE
  // ==========================================================================

  let lastCallTs = 0;
  let cancelRequested = false;

  const memCacheCards = new Map();
  const memCacheSearches = new Map();

  let todayStats = { date: "", count: 0 };

  // ==========================================================================
  // ACTIVATION / DÉSACTIVATION
  // ==========================================================================

  function isYugipediaEnabled() {
    try {
      return localStorage.getItem(LS_KEY_ENABLED) === "1";
    } catch (e) {
      return false;
    }
  }

  function setYugipediaEnabled(enabled) {
    try {
      localStorage.setItem(LS_KEY_ENABLED, enabled ? "1" : "0");
      window.dispatchEvent(
        new CustomEvent("yugipedia-toggle", { detail: { enabled } })
      );
    } catch (e) {
      console.warn("[Yugipedia] Impossible de sauvegarder le flag", e);
    }
  }

  // ==========================================================================
  // STATS DU JOUR
  // ==========================================================================

  function todayKey() {
    const d = new Date();
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  function loadTodayStats() {
    try {
      const raw = localStorage.getItem(LS_KEY_STATS);
      if (!raw) return { date: todayKey(), count: 0 };
      const parsed = JSON.parse(raw);
      if (parsed.date !== todayKey()) return { date: todayKey(), count: 0 };
      return parsed;
    } catch (e) {
      return { date: todayKey(), count: 0 };
    }
  }

  function incrementTodayStats(count = 1) {
    todayStats = loadTodayStats();
    todayStats.count += count;
    try {
      localStorage.setItem(LS_KEY_STATS, JSON.stringify(todayStats));
    } catch (e) { /* quota, pas grave */ }
    window.dispatchEvent(
      new CustomEvent("yugipedia-request", { detail: { count: todayStats.count } })
    );
  }

  function getYugipediaStats() {
    return { ...todayStats };
  }

  // ==========================================================================
  // RATE LIMITER
  // ==========================================================================

  async function waitForSlot() {
    const now = Date.now();
    const elapsed = now - lastCallTs;
    const wait = Math.max(0, YUGIPEDIA_DELAY - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallTs = Date.now();
  }

  // ==========================================================================
  // FETCH AVEC RETRY + TIMEOUT
  // ==========================================================================

  async function rawFetch(url, options = {}, attempt = 0) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...(options.headers || {}),
          Accept: "application/json",
        },
      });
      clearTimeout(timeoutId);

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        console.warn(`[Yugipedia] HTTP ${res.status}, retry dans ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        return rawFetch(url, options, attempt + 1);
      }
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt < MAX_RETRIES && err.name !== "AbortError") {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        console.warn(`[Yugipedia] Erreur réseau, retry dans ${delay}ms`, err.message);
        await new Promise((r) => setTimeout(r, delay));
        return rawFetch(url, options, attempt + 1);
      }
      throw err;
    }
  }

  async function yugipediaFetch(params) {
    if (cancelRequested) throw new Error("Annulé par l'utilisateur");
    await waitForSlot();
    incrementTodayStats(1);

    const url = new URL(YUGIPEDIA_API);
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    url.searchParams.set("origin", "*");
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await rawFetch(url.toString());
    if (!res.ok) throw new Error(`Yugipedia HTTP ${res.status}`);
    return res.json();
  }

  // ==========================================================================
  // NORMALISATION + FILTRES
  // ==========================================================================

  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  function looksLikeJapaneseRomaji(name) {
    return /[āīūēō]/i.test(String(name || ""));
  }

  function looksLikeCJK(name) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(String(name || ""));
  }

  function shouldSkipYugipedia(name) {
    return looksLikeJapaneseRomaji(name) || looksLikeCJK(name);
  }

  // ==========================================================================
  // INDEXEDDB
  // ==========================================================================

  let idbPromise = null;

  function openIDB() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
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

  async function idbGet(store, key) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return null; }
  }

  async function idbPut(store, item) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { /* ignore */ }
  }

  async function idbPutMany(store, items) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const s = tx.objectStore(store);
        for (const item of items) s.put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { /* ignore */ }
  }

  async function idbDelete(store, key) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { /* ignore */ }
  }

  async function idbGetMany(store, keys) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const s = tx.objectStore(store);
        const results = new Map();
        let pending = keys.length;
        if (pending === 0) return resolve(results);
        for (const key of keys) {
          const req = s.get(key);
          req.onsuccess = () => {
            if (req.result) results.set(key, req.result);
            if (--pending === 0) resolve(results);
          };
          req.onerror = () => {
            if (--pending === 0) resolve(results);
          };
        }
      });
    } catch (e) { return new Map(); }
  }

  async function idbGetAll(store) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) { return []; }
  }

  async function idbClear(store) {
    try {
      const db = await openIDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { /* ignore */ }
  }

  // ==========================================================================
  // PARSER MULTI-TEMPLATES
  // ==========================================================================

  function extractTemplate(wikitext, templateName) {
    const escaped = templateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const startRe = new RegExp("\\{\\{\\s*" + escaped + "\\s*(?=[|}\\n])", "i");
    const startMatch = startRe.exec(wikitext);
    if (!startMatch) return null;

    const startIdx = startMatch.index;
    const bodyStartIdx = startIdx + startMatch[0].length;

    let i = startIdx;
    let depth = 0;
    let bodyEndIdx = null;

    while (i < wikitext.length - 1) {
      const two = wikitext.substr(i, 2);
      if (two === "{{") { depth++; i += 2; continue; }
      if (two === "}}") {
        depth--;
        if (depth === 0) { bodyEndIdx = i; break; }
        i += 2;
        continue;
      }
      i++;
    }

    if (bodyEndIdx === null) return null;

    return {
      body: wikitext.slice(bodyStartIdx, bodyEndIdx),
      start: startIdx,
      end: bodyEndIdx + 2,
    };
  }

  function parseTemplateParams(body) {
    const params = {};
    let i = 0;
    const len = body.length;

    while (i < len && /\s/.test(body[i])) i++;
    if (body[i] === "|") i++;

    while (i < len) {
      const eqIdx = body.indexOf("=", i);
      if (eqIdx === -1) break;

      const key = body.slice(i, eqIdx).trim();
      const cleanKey = key.replace(/^[|\s]*/, "").trim();

      if (!/^[a-zA-Z_0-9]+$/.test(cleanKey)) {
        const nextPipe = body.indexOf("|", i);
        if (nextPipe === -1) break;
        i = nextPipe + 1;
        continue;
      }

      let j = eqIdx + 1;
      let depth = 0;
      const valStart = j;

      while (j < len) {
        const two = body.substr(j, 2);
        if (two === "{{") { depth++; j += 2; continue; }
        if (two === "}}") { depth--; j += 2; continue; }
        if (depth === 0 && body[j] === "|") break;
        j++;
      }

      const value = body.slice(valStart, j).trim();
      params[cleanKey.toLowerCase()] = value;

      i = j + 1;
    }

    return params;
  }

  function parseCardTable2(wikitext) {
    if (!wikitext) return null;

    for (const tpl of CARD_TEMPLATES) {
      const extracted = extractTemplate(wikitext, tpl);
      if (!extracted) continue;

      const params = parseTemplateParams(extracted.body);
      params._template = tpl;

      const hasFrName = params.fr_name && params.fr_name.trim();
      const hasEnName = (params.en_name && params.en_name.trim())
                     || (params.translated_name && params.translated_name.trim());

      if (!hasFrName && !hasEnName) continue;

      const hasCardType = params.card_type
                       || params.types
                       || params.attribute;
      if (!hasCardType) continue;

      const hasText = params.text || params.fr_text || params.lore;
      if (!hasText) continue;

      return params;
    }

    return null;
  }

  function cleanWikitext(text) {
    if (!text) return "";
    return String(text)
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\{\{[^{}]*\}\}/g, "")
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
      .replace(/<ref[^>]*\/>/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/'{2,}/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ==========================================================================
  // ⚡ VARIANTES DE TITRE — teste les suffixes probables (anime, manga, card…)
  // ==========================================================================

  function buildTitleVariants(query) {
    const q = String(query || "").trim();
    if (!q) return [];

    const variants = new Set();
    variants.add(q);                       // Nom exact
    variants.add(q.replace(/\s+/g, "_"));  // Nom avec underscores

    for (const s of TITLE_SUFFIXES) {
      variants.add(`${q} (${s})`);
      variants.add(`${q.replace(/\s+/g, "_")}_(${s})`);
    }

    return [...variants];
  }

  // Backward compat — l'ancien nom reste exposé
  function buildTitleCandidates(query) {
    return buildTitleVariants(query);
  }

  // ==========================================================================
  // ⚡ RECHERCHE FLOUE — list=search MediaWiki (trouve peu importe le suffixe)
  // ==========================================================================

  /**
   * Utilise list=search de MediaWiki pour trouver les pages dont le titre
   * CONTIENT le nom cherché, peu importe ce qu'il y a après.
   * Ex: "Natural Selection" → trouve "Natural Selection (anime)", "(card)"…
   *
   * @param {string} query - Nom de carte à chercher
   * @returns {string[]} - Liste de titres de pages trouvés
   */
  async function yugipediaListSearch(query) {
    const q = String(query || "").trim();
    if (!q || q.length < 3) return [];

    const safe = q.replace(/"/g, '\\"');

    try {
      const data = await yugipediaFetch({
        action: "query",
        list: "search",
        srsearch: `intitle:"${safe}"`,
        srlimit: "15",
        srnamespace: "0",
      });
      const results = data?.query?.search || [];
      return results.map((r) => r.title);
    } catch (err) {
      console.warn(`[Yugipedia] list=search échec pour "${q}":`, err.message);
      return [];
    }
  }

  /**
   * Choisit le meilleur titre parmi les résultats de list=search.
   * Priorité : titre commence par le nom cherché > contient > premier.
   */
  function pickBestTitle(candidates, query) {
    if (!candidates || !candidates.length) return null;
    const normQ = normalize(query);
    return (
      candidates.find((t) => normalize(t).startsWith(normQ)) ||
      candidates.find((t) => normalize(t).includes(normQ)) ||
      candidates[0]
    );
  }

  // ==========================================================================
  // RECHERCHE YUGIPEDIA (SIMPLE — UN TITRE)
  // ==========================================================================

  async function yugipediaSearch(query) {
    if (!query || query.length < 3) return [];

    if (shouldSkipYugipedia(query)) {
      console.log(`[Yugipedia] ⏭️ Skip japonais/CJK: "${query}"`);
      return [];
    }

    const normKey = normalize(query);

    if (memCacheSearches.has(normKey)) {
      console.log(`[Yugipedia] Cache mémoire HIT: "${query}"`);
      return memCacheSearches.get(normKey);
    }

    const cached = await idbGet(IDB_STORE_YUGI_SEARCH, normKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      console.log(`[Yugipedia] Cache IDB HIT: "${query}"`);
      memCacheSearches.set(normKey, cached.results);
      return cached.results;
    }

    try {
      console.log(`[Yugipedia] FETCH: "${query}"`);
      const candidates = buildTitleVariants(query);
      let card = null;

      // Passe 1 : variantes de titre
      for (const title of candidates) {
        if (cancelRequested) break;
        try {
          card = await fetchCardByTitle(title);
          if (card) {
            console.log(`[Yugipedia] ✅ Trouvé avec titre: "${title}"`);
            break;
          }
        } catch (e) {
          if (e.message === "Annulé par l'utilisateur") throw e;
          console.warn(`[Yugipedia] Échec "${title}":`, e.message);
        }
      }

      // Passe 2 : list=search si toujours rien
      if (!card && !cancelRequested) {
        const titles = await yugipediaListSearch(query);
        const best = pickBestTitle(titles, query);
        if (best) {
          try {
            card = await fetchCardByTitle(best);
            if (card) {
              console.log(`[Yugipedia] ✅ "${query}" → "${best}" (list=search)`);
            }
          } catch (e) {
            if (e.message === "Annulé par l'utilisateur") throw e;
            console.warn(`[Yugipedia] Échec fetch "${best}":`, e.message);
          }
        }
      }

      const cards = card ? [card] : [];
      memCacheSearches.set(normKey, cards);
      await idbPut(IDB_STORE_YUGI_SEARCH, {
        key: normKey,
        results: cards,
        ts: Date.now(),
      });
      return cards;
    } catch (err) {
      console.error("[Yugipedia] Erreur recherche", err);
      return [];
    }
  }

  async function fetchCardByTitle(title) {
    const normKey = normalize(title);

    if (memCacheCards.has(normKey)) return memCacheCards.get(normKey);

    const cached = await idbGet(IDB_STORE_YUGI_CARDS, normKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      memCacheCards.set(normKey, cached.data);
      return cached.data;
    }

    const pageData = await yugipediaFetch({
      action: "query",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: title,
      redirects: "1",
    });

    const pages = pageData?.query?.pages || [];
    if (!pages.length) return null;

    const page = pages[0];
    if (!page || page.missing) {
      console.log(`[Yugipedia] Page manquante: "${title}"`);
      return null;
    }

    const wikitext =
      page.revisions?.[0]?.slots?.main?.content ||
      page.revisions?.[0]?.content ||
      page.revisions?.[0]?.["*"];

    if (!wikitext) {
      console.log(`[Yugipedia] Pas de contenu pour: "${title}"`);
      return null;
    }

    const params = parseCardTable2(wikitext);
    if (!params) {
      console.warn(`[Yugipedia] Pas de template de carte dans "${title}"`);
      return null;
    }

    const card = convertToYgoprodeckFormat(params, title);
    if (!card) return null;

    memCacheCards.set(normKey, card);
    await idbPut(IDB_STORE_YUGI_CARDS, {
      key: normKey,
      data: card,
      ts: Date.now(),
    });
    return card;
  }

  // ==========================================================================
  // ⚡ BATCH v2 — Passe 1 : variantes | Passe 2 : list=search
  // ==========================================================================

  /**
   * Recherche PLUSIEURS cartes en un minimum de requêtes.
   *
   * Passe 1 (batchée) : envoie toutes les variantes de titres en 1 requête
   *                     groupée (max 50 titres par appel MediaWiki).
   * Passe 2 (individuelle) : pour les cartes restées introuvables, lance
   *                     un list=search par carte (1 req/s max).
   *
   * @param {string[]} queries - Noms à chercher
   * @param {function} [onProgress] - Callback optionnel : ({phase, done, total})
   * @returns {Map<string, object[]>} - Map { query → [cards] }
   */
  async function yugipediaSearchBatch(queries, onProgress) {
    const results = new Map();
    if (!queries || !queries.length) return results;

    // -----------------------------------------------------------------------
    // 0. Filtrage initial : skip japonais/CJK + déjà en cache
    // -----------------------------------------------------------------------
    const toFetch = [];
    for (const q of queries) {
      if (!q || q.length < 3) {
        results.set(q, []);
        continue;
      }
      if (shouldSkipYugipedia(q)) {
        results.set(q, []);
        continue;
      }
      const normKey = normalize(q);
      if (memCacheSearches.has(normKey)) {
        results.set(q, memCacheSearches.get(normKey));
        continue;
      }
      toFetch.push(q);
    }

    if (!toFetch.length) return results;

    // -----------------------------------------------------------------------
    // 1. Vérifie le cache IndexedDB
    // -----------------------------------------------------------------------
    const idbKeys = toFetch.map((q) => normalize(q));
    const idbCached = await idbGetMany(IDB_STORE_YUGI_SEARCH, idbKeys);
    const stillToFetch = [];
    for (const q of toFetch) {
      const normKey = normalize(q);
      const cached = idbCached.get(normKey);
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        memCacheSearches.set(normKey, cached.results);
        results.set(q, cached.results);
      } else {
        stillToFetch.push(q);
      }
    }

    if (!stillToFetch.length) return results;

    // -----------------------------------------------------------------------
    // 2. PASSE 1 — Batch de variantes
    // -----------------------------------------------------------------------
    const titleToQueries = new Map();  // normalizedTitle → [queries]
    const allTitles = [];

    for (const q of stillToFetch) {
      const variants = buildTitleVariants(q);
      for (const v of variants) {
        const key = normalize(v);
        if (!titleToQueries.has(key)) {
          titleToQueries.set(key, []);
          allTitles.push(v);
        }
        titleToQueries.get(key).push(q);
      }
    }

    console.log(
      `[Yugipedia] ⚡ Passe 1 : ${allTitles.length} variantes pour ${stillToFetch.length} cartes`
    );

    const queryToCard = new Map();  // query → card (1er trouvé gagne)

    const batches = [];
    for (let i = 0; i < allTitles.length; i += BATCH_SIZE) {
      batches.push(allTitles.slice(i, i + BATCH_SIZE));
    }

    for (let b = 0; b < batches.length; b++) {
      if (cancelRequested) break;
      const batch = batches[b];

      try {
        const pageData = await yugipediaFetch({
          action: "query",
          prop: "revisions",
          rvprop: "content",
          rvslots: "main",
          titles: batch.join("|"),
          redirects: "1",
        });

        const pages = pageData?.query?.pages || [];

        for (const page of pages) {
          if (!page || page.missing) continue;
          const wikitext =
            page.revisions?.[0]?.slots?.main?.content ||
            page.revisions?.[0]?.content ||
            page.revisions?.[0]?.["*"];
          if (!wikitext) continue;

          const params = parseCardTable2(wikitext);
          if (!params) continue;

          const card = convertToYgoprodeckFormat(params, page.title);
          if (!card) continue;

          // Trouve toutes les queries qui visaient ce titre (ou une variante)
          const key = normalize(page.title);
          const queriesForTitle = titleToQueries.get(key) || [];
          for (const q of queriesForTitle) {
            if (!queryToCard.has(q)) {
              queryToCard.set(q, card);
            }
          }

          // ⚡ Fallback : associe aussi via le titre sans suffixe
          //    (utile si l'API a renvoyé "Natural Selection (anime)" alors
          //     qu'on cherchait "Natural Selection")
          const baseTitle = page.title.replace(/\s*\([^)]+\)\s*$/, "");
          const baseKey = normalize(baseTitle);
          const baseQueries = titleToQueries.get(baseKey) || [];
          for (const q of baseQueries) {
            if (!queryToCard.has(q)) {
              queryToCard.set(q, card);
            }
          }
        }
      } catch (err) {
        console.error("[Yugipedia] Erreur batch", err);
      }

      if (onProgress) {
        onProgress({
          phase: "variants",
          done: b + 1,
          total: batches.length,
        });
      }
    }

    // -----------------------------------------------------------------------
    // 3. PASSE 2 — list=search pour les cartes encore introuvables
    // -----------------------------------------------------------------------
    const remaining = stillToFetch.filter((q) => !queryToCard.has(q));

    if (remaining.length) {
      console.log(
        `[Yugipedia] ⚡ Passe 2 : list=search pour ${remaining.length} carte(s)`
      );

      let done = 0;
      for (const q of remaining) {
        if (cancelRequested) break;

        const titles = await yugipediaListSearch(q);
        const best = pickBestTitle(titles, q);

        if (best) {
          try {
            const card = await fetchCardByTitle(best);
            if (card) {
              queryToCard.set(q, card);
              console.log(`[Yugipedia] ✅ "${q}" → "${best}" (list=search)`);
            }
          } catch (err) {
            if (err.message === "Annulé par l'utilisateur") throw err;
            console.warn(`[Yugipedia] Échec fetch "${best}":`, err.message);
          }
        }

        done++;
        if (onProgress) {
          onProgress({ phase: "search", done, total: remaining.length });
        }
      }
    }

    // -----------------------------------------------------------------------
    // 4. Consolide + cache
    // -----------------------------------------------------------------------
    const toSave = [];
    for (const q of stillToFetch) {
      const card = queryToCard.get(q);
      const cards = card ? [card] : [];
      const normKey = normalize(q);
      results.set(q, cards);
      memCacheSearches.set(normKey, cards);
      if (card) memCacheCards.set(normKey, card);
      toSave.push({ key: normKey, results: cards, ts: Date.now() });
    }
    if (toSave.length) await idbPutMany(IDB_STORE_YUGI_SEARCH, toSave);

    const resolvedCount = stillToFetch.filter((q) => queryToCard.has(q)).length;
    console.log(
      `[Yugipedia] 🎯 Résultat : ${resolvedCount} / ${stillToFetch.length} cartes trouvées`
    );

    return results;
  }

  function convertToYgoprodeckFormat(p, title) {
    const tpl = p._template || "CardTable2";

    const nameFr = cleanWikitext(p.fr_name || "");
    const nameEn = cleanWikitext(
      p.en_name ||
      p.translated_name ||
      title
    );

    if (!nameFr && !nameEn) return null;

    const descFr = cleanWikitext(p.fr_text || p.fr_lore || "");
    const descEn = cleanWikitext(
      p.text ||
      p.lore ||
      p.en_text ||
      p.en_lore ||
      p.effect ||
      ""
    );

    const cardType = (p.card_type || "").toLowerCase();
    const typesStr = (p.types || p.type || "").toLowerCase();
    let type, frameType;

    if (cardType.includes("spell") || typesStr.includes("spell")) {
      type = "Spell Card";
      frameType = "spell";
    } else if (cardType.includes("trap") || typesStr.includes("trap")) {
      type = "Trap Card";
      frameType = "trap";
    } else {
      if (typesStr.includes("fusion")) frameType = "fusion";
      else if (typesStr.includes("synchro")) frameType = "synchro";
      else if (typesStr.includes("xyz")) frameType = "xyz";
      else if (typesStr.includes("link")) frameType = "link";
      else if (typesStr.includes("ritual")) frameType = "ritual";
      else if (typesStr.includes("normal")) frameType = "normal";
      else frameType = "effect";
      type = frameType === "normal" ? "Normal Monster" : "Effect Monster";
    }

    const passcode = (p.passcode || p.password || "").toString().trim();
    const id = passcode || "yugi-" + hashString(nameEn || nameFr);

    const imageName = (p.image || p.en_image || p.ja_image || "").trim();
    const imageFilename = imageName.replace(/^.*?:/, "");
    const imageUrl = imageFilename
      ? `https://yugipedia.com/wiki/Special:Redirect/file/${encodeURIComponent(imageFilename)}`
      : "";

    return {
      id,
      name: nameFr || nameEn,
      _source: "yugipedia",
      _template: tpl,
      _names: { en: nameEn, fr: nameFr },
      type,
      frameType,
      desc: descFr || descEn,
      _descs: { en: descEn, fr: descFr },
      atk: p.atk !== undefined ? parseInt(p.atk, 10) || 0 : undefined,
      def: p.def !== undefined ? parseInt(p.def, 10) || 0 : undefined,
      level: p.level !== undefined ? parseInt(p.level, 10) || 0 : undefined,
      attribute: (p.attribute || "").toUpperCase() || undefined,
      race: (p.types || p.type || "").split("/")[0]?.trim() || undefined,
      archetype: p.archetype || p.archseries || undefined,
      card_images: imageUrl
        ? [{ image_url: imageUrl, image_url_cropped: imageUrl }]
        : [],
    };
  }

  function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
  }

  // ==========================================================================
  // NETTOYAGE CACHE
  // ==========================================================================

  async function cleanExpiredYugipediaCache() {
    const stores = [IDB_STORE_YUGI_CARDS, IDB_STORE_YUGI_SEARCH];
    const now = Date.now();
    let purged = 0;

    for (const store of stores) {
      const all = await idbGetAll(store);
      for (const item of all) {
        if (item.ts && now - item.ts > CACHE_TTL) {
          await idbDelete(store, item.key);
          purged++;
        }
      }
    }

    if (purged > 0) console.log(`[Yugipedia] Cache purgé : ${purged} entrées`);
    return purged;
  }

  async function clearYugipediaCache() {
    await idbClear(IDB_STORE_YUGI_CARDS);
    await idbClear(IDB_STORE_YUGI_SEARCH);
    memCacheCards.clear();
    memCacheSearches.clear();
    console.log("[Yugipedia] Cache vidé");
  }

  async function getYugipediaCacheStats() {
    const [cards, searches] = await Promise.all([
      idbGetAll(IDB_STORE_YUGI_CARDS),
      idbGetAll(IDB_STORE_YUGI_SEARCH),
    ]);
    return {
      cards: cards.length,
      searches: searches.length,
      total: cards.length + searches.length,
    };
  }

  // ==========================================================================
  // ANNULATION
  // ==========================================================================

  function cancelYugipedia() {
    cancelRequested = true;
    console.log("[Yugipedia] Annulation demandée");
  }

  function resetCancelFlag() {
    cancelRequested = false;
  }

  // ==========================================================================
  // INITIALISATION
  // ==========================================================================

  async function initYugipedia() {
    todayStats = loadTodayStats();
    setTimeout(() => {
      cleanExpiredYugipediaCache().catch((e) =>
        console.warn("[Yugipedia] Nettoyage cache échoué", e)
      );
    }, 2000);
  }

  // ==========================================================================
  // EXPORT GLOBAL
  // ==========================================================================

  window.YugipediaAPI = {
    isYugipediaEnabled,
    setYugipediaEnabled,
    yugipediaSearch,
    yugipediaSearchBatch,
    fetchCardByTitle,
    clearYugipediaCache,
    cleanExpiredYugipediaCache,
    getYugipediaCacheStats,
    getYugipediaStats,
    cancelYugipedia,
    resetCancelFlag,
    normalize,
    parseCardTable2,
    cleanWikitext,
    extractTemplate,
    parseTemplateParams,
    shouldSkipYugipedia,
    looksLikeJapaneseRomaji,
    looksLikeCJK,
    buildTitleVariants,      // ⚡ NOUVEAU
    buildTitleCandidates,    // ⚡ Backward compat
    yugipediaListSearch,     // ⚡ NOUVEAU
    pickBestTitle,           // ⚡ NOUVEAU
  };

  window.yugipediaSearch = yugipediaSearch;
  window.yugipediaSearchBatch = yugipediaSearchBatch;
  window.yugipediaListSearch = yugipediaListSearch;  // ⚡ NOUVEAU
  window.cancelYugipedia = cancelYugipedia;
  window.resetYugipediaCancel = resetCancelFlag;

  initYugipedia();

  console.log("[Yugipedia] Module chargé ✅ (v2 — variantes + list=search)");
})();
