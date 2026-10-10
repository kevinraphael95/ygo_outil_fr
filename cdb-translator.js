// ============================================================================
// CDB TRANSLATOR — Version batchée (YGOPRODeck + Yugipedia)
// ============================================================================

(() => {
  "use strict";

  const SQL_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3";
  const YGOPRODECK_API = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
  const MAX_REPORT_LINES = 250;
  const YIELD_EVERY = 200;
  const YUGI_CONFIRM_THRESHOLD = 50;

  const state = {
    file: null, sqlite: null, patched: null, sqlLib: null, sqlReady: false,
    nameIndexFr: null, nameIndexEn: null, missingNames: [], cancelled: false,
    running: false, resolvedCards: [], generatedFiles: [], generatedCards: [],
  };

  const $ = (id) => document.getElementById(id);
  const dom = {
    drop: $("cdb-drop"), fileInput: $("cdb-file"), info: $("cdb-info"),
    actions: $("cdb-actions"), btnRun: $("cdb-translate"), btnClear: $("cdb-clear"),
    actionTranslate: $("cdb-action-translate"), actionJson: $("cdb-action-json"),
    customMode: $("cdb-custom-mode"), yugiMode: $("cdb-yugipedia-mode"),
    progressWrap: $("cdb-progress-wrap"), progressLbl: $("cdb-progress-label"),
    progressPct: $("cdb-progress-pct"), progressFill: $("cdb-progress-fill"),
    status: $("cdb-status"), stats: $("cdb-stats"),
    statTotal: $("cdb-stat-total"), statDone: $("cdb-stat-translated"),
    statMissing: $("cdb-stat-missing"),
    statDoneLbl: $("cdb-stat-translated-label"), statMissingLbl: $("cdb-stat-missing-label"),
    results: $("cdb-results"), downloads: $("cdb-downloads"),
    btnDownloadCdb: $("cdb-download"), btnDownloadZip: $("cdb-download-zip"),
    btnDownloadCsv: $("cdb-download-csv"), btnExportMissing: $("cdb-export-missing"),
    yugiProgressWrap: $("cdb-yugi-progress-wrap"), yugiLabel: $("cdb-yugi-label"),
    yugiPct: $("cdb-yugi-pct"), yugiFill: $("cdb-yugi-fill"),
    btnCancelYugi: $("cdb-cancel-yugi"),
  };

  async function ensureSqlLoaded() {
    if (state.sqlReady) return state.sqlLib;
    if (typeof window.initSqlJs !== "function") throw new Error("sql.js non chargé.");
    state.sqlLib = await window.initSqlJs({ locateFile: (f) => `${SQL_CDN}/${f}` });
    state.sqlReady = true;
    return state.sqlLib;
  }

  function normalize(s) {
    return String(s || "").toLowerCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  }

  function buildNameIndexes() {
    if (state.nameIndexFr && state.nameIndexEn) return;
    const fr = new Map(), en = new Map();
    window.memCacheFr.forEach((c) => {
      const k = normalize(c.name); if (!k) return;
      const e = fr.get(k); if (!e || c.name.length > e.name.length) fr.set(k, c);
    });
    window.memCacheEn.forEach((c) => {
      const k = normalize(c.name); if (!k) return;
      const e = en.get(k); if (!e || c.name.length > e.name.length) en.set(k, c);
    });
    state.nameIndexFr = fr; state.nameIndexEn = en;
    console.log(`[CDB] Index : ${fr.size} FR, ${en.size} EN`);
  }

  function cleanDesc(s) {
    return String(s || "").replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function descDiffers(a, b) { return cleanDesc(a) !== cleanDesc(b); }

  function cleanNameForApi(name) {
    let n = String(name || "").trim();
    n = n.replace(/^Carte\s+Magie\s*:\s*/i, "");
    n = n.replace(/^Carte\s+Pi[eè]ge\s*:\s*/i, "");
    n = n.replace(/^Carte\s+Magie\s+de\s+/i, "");
    n = n.replace(/^Carte\s+Pi[eè]ge\s+de\s+/i, "");
    n = n.replace(/^Magie\s*:\s*/i, "").replace(/^Pi[eè]ge\s*:\s*/i, "");
    n = n.replace(/\s*\([^)]*\)\s*$/, "");
    return n.trim();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ⚡ BATCH name= — jusqu'à 40 cartes par requête YGOPRODeck
  // ═══════════════════════════════════════════════════════════════════════
  async function fetchCardsByNamesBatch(names, language) {
    const results = new Map();
    if (!names || !names.length) return results;
    const unique = [...new Set(names.filter((n) => n && n.trim()))];
    if (!unique.length) return results;
    const CHUNK = 40;

    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const nameParam = chunk.map((n) => encodeURIComponent(n)).join("|");
      const qs = `name=${nameParam}` + (language ? `&language=${language}` : "");
      try {
        const res = await fetch(`${YGOPRODECK_API}?${qs}`);
        if (!res.ok) continue;
        const data = await res.json();
        (data.data || []).forEach((card) => {
          results.set(String(card.name || "").toLowerCase(), card);
        });
      } catch (e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 60));
    }
    return results;
  }

  function findInBatch(map, name) {
    if (!map || !name) return null;
    return map.get(String(name).trim().toLowerCase()) || null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Résolution locale (traduction)
  // ═══════════════════════════════════════════════════════════════════════
  async function resolveCard(localName, localDesc, customMode, allowYugipedia) {
    const key = normalize(localName);
    if (!key) return { status: "not_found" };
    const frMatch = state.nameIndexFr.get(key);
    if (frMatch) return { status: "translated", name: frMatch.name, desc: frMatch.desc || "", card: frMatch, source: "local" };
    const enMatch = state.nameIndexEn.get(key);
    if (enMatch) {
      const frById = window.memCacheFr.get(String(enMatch.id));
      if (frById) {
        if (customMode && descDiffers(localDesc, enMatch.desc)) {
          return { status: "translated", name: frById.name, desc: localDesc || "", modified: true, card: frById, source: "local" };
        }
        return { status: "translated", name: frById.name, desc: frById.desc || "", card: frById, source: "local" };
      }
      return { status: "en_only", name: enMatch.name, desc: enMatch.desc || localDesc || "", card: enMatch, source: "local" };
    }
    return { status: "not_found" };
  }

  function resolveCardFromYugiCache(localName, localDesc, customMode, yugiCards) {
    if (!yugiCards || !yugiCards.length) return { status: "not_found" };
    const exact = yugiCards[0];
    const frName = exact._names?.fr || exact.name;
    const frDesc = exact._descs?.fr || exact.desc || localDesc;
    const enDesc = exact._descs?.en || "";
    if (customMode && enDesc && descDiffers(localDesc, enDesc)) {
      return { status: "translated", name: frName, desc: localDesc || "", modified: true, card: exact, source: "yugipedia" };
    }
    return { status: "translated", name: frName, desc: frDesc || localDesc || "", card: exact, source: "yugipedia" };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Chargement fichier
  // ═══════════════════════════════════════════════════════════════════════
  function bindDropZone() {
    if (!dom.drop) return;
    dom.drop.addEventListener("click", () => dom.fileInput.click());
    dom.drop.addEventListener("dragover", (e) => { e.preventDefault(); dom.drop.classList.add("dragover"); });
    dom.drop.addEventListener("dragleave", () => dom.drop.classList.remove("dragover"));
    dom.drop.addEventListener("drop", (e) => {
      e.preventDefault(); dom.drop.classList.remove("dragover");
      const f = e.dataTransfer.files[0]; if (f) loadFile(f);
    });
    dom.fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0]; if (f) loadFile(f);
    });
  }

  async function loadFile(file) {
    if (state.running) { toast("Traitement en cours.", "err"); return; }
    resetUI(); setStatus("Lecture du fichier…");
    try {
      const SQL = await ensureSqlLoaded();
      const buffer = await file.arrayBuffer();
      state.file = file;
      state.sqlite = new SQL.Database(new Uint8Array(buffer));
      const tables = getTableNames(state.sqlite);
      if (!tables.includes("texts")) throw new Error("Pas un .cdb (table `texts` manquante).");
      const total = countRows(state.sqlite, "texts");
      showFileInfo(file, total);
      dom.actions.classList.remove("hidden");
      setStatus("Prêt. Clique sur « Lancer ».");
    } catch (err) {
      console.error("[CDB]", err);
      setStatus(`❌ Erreur : ${err.message}`);
    }
  }

  function getTableNames(db) {
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    return r[0]?.values.flat() || [];
  }
  function countRows(db, t) { return db.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0]; }

  function getAction() { return (dom.actionJson && dom.actionJson.checked) ? "json" : "translate"; }

  function updateActionUI() {
    const isJson = getAction() === "json";
    if (dom.statDoneLbl) dom.statDoneLbl.textContent = isJson ? "JSON générés" : "Traduites en FR";
    if (dom.statMissingLbl) dom.statMissingLbl.textContent = isJson ? "—" : "Pas de trad. FR";
    if (dom.customMode) {
      dom.customMode.disabled = isJson;
      if (isJson) dom.customMode.checked = false;
      const w = dom.customMode.closest(".cdb-option");
      if (w) w.style.opacity = isJson ? "0.4" : "1";
    }
    if (dom.yugiMode) dom.yugiMode.disabled = false;
  }

  if (dom.actionTranslate) dom.actionTranslate.addEventListener("change", updateActionUI);
  if (dom.actionJson) dom.actionJson.addEventListener("change", updateActionUI);

  async function run() {
    if (getAction() === "json") await runJsonGeneration();
    else await runTranslation();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TRADUCTION (inchangée)
  // ═══════════════════════════════════════════════════════════════════════
  async function runTranslation() {
    if (!state.sqlite) { toast("Charge un .cdb.", "err"); return; }
    const customMode = dom.customMode ? dom.customMode.checked : false;
    const yugiMode = dom.yugiMode ? dom.yugiMode.checked : false;
    state.cancelled = false; state.running = true; state.missingNames = [];
    dom.btnRun.disabled = true; dom.btnClear.disabled = true;
    dom.progressWrap.classList.add("visible");
    setProgress(0, "Préparation…");

    try {
      buildNameIndexes(); await nextFrame();
      const rows = state.sqlite.exec("SELECT id, name, desc FROM texts")[0].values;
      const total = rows.length;
      const updates = [], report = [], reportIndex = new Map(), missingCards = [];
      let done = 0, doneYugi = 0, missing = 0, modifiedCount = 0;

      for (let i = 0; i < rows.length; i++) {
        const [localId, localName, localDesc] = rows[i];
        let enNameFromTilde = null;
        if (localDesc) {
          const m = localDesc.match(/~([^~]+)~/);
          if (m && m[1]) enNameFromTilde = m[1].trim();
        }
        let resolved = await resolveCard(localName, localDesc, customMode, false);
        if (resolved.status === "not_found" && enNameFromTilde) {
          resolved = await resolveCard(enNameFromTilde, localDesc, customMode, false);
        }
        if (resolved.status === "translated") {
          updates.push({ id: localId, name: resolved.name, desc: resolved.desc });
          done++;
          if (resolved.modified) modifiedCount++;
        } else {
          missing++;
          missingCards.push({ id: localId, name: enNameFromTilde || localName, desc: localDesc });
        }
        if (i % YIELD_EVERY === 0 || i === rows.length - 1) {
          setProgress(5 + Math.round((i / total) * 60), `Analyse ${i + 1} / ${total}…`);
          await nextFrame();
        }
        if (state.cancelled) break;
      }

      if (yugiMode && missingCards.length > 0) {
        if (missingCards.length > YUGI_CONFIRM_THRESHOLD) {
          const ok = window.showConfirm
            ? await window.showConfirm(`${missingCards.length} cartes introuvables. Continuer ?`, "Fallback")
            : confirm(`${missingCards.length} cartes introuvables. Continuer ?`);
          if (!ok) missingCards.length = 0;
        }
        if (missingCards.length > 0) {
          const uniqueNames = [...new Set(missingCards.map((c) => c.name))];
          let batchResults = new Map();
          try { batchResults = await window.yugipediaSearchBatch(uniqueNames); } catch (e) {}
          for (const card of missingCards) {
            if (state.cancelled) break;
            const yugiCards = batchResults.get(card.name) || [];
            if (yugiCards.length > 0) {
              const r = resolveCardFromYugiCache(card.name, card.desc, customMode, yugiCards);
              if (r.status === "translated") {
                updates.push({ id: card.id, name: r.name, desc: r.desc });
                done++; doneYugi++; missing--;
              } else state.missingNames.push(card.name);
            } else state.missingNames.push(card.name);
          }
        }
      }

      applyUpdates(state.sqlite, updates);
      state.patched = state.sqlite.export();
      setProgress(100, "Terminé !");
      renderResults(report, { total, done, missing, modifiedCount, doneYugi });
      dom.downloads.classList.remove("hidden");
      showTranslateDownloadsOnly();
      setStatus(`✅ ${done} / ${total} traduite(s)${doneYugi > 0 ? ` · ${doneYugi} via Yugipedia` : ""}.`);
      toast("Traduction terminée !", "ok");
    } catch (err) {
      console.error(err);
      setStatus(`❌ ${err.message}`);
    } finally {
      state.running = false;
      dom.btnRun.disabled = false; dom.btnClear.disabled = false;
    }
  }

  function showTranslateDownloadsOnly() {
    if (dom.btnDownloadCdb) dom.btnDownloadCdb.classList.remove("hidden");
    if (dom.btnDownloadZip) dom.btnDownloadZip.classList.add("hidden");
    if (dom.btnDownloadCsv) dom.btnDownloadCsv.classList.add("hidden");
  }
  function showJsonDownloadsOnly() {
    if (dom.btnDownloadCdb) dom.btnDownloadCdb.classList.add("hidden");
    if (dom.btnDownloadZip) dom.btnDownloadZip.classList.remove("hidden");
    if (dom.btnDownloadCsv) dom.btnDownloadCsv.classList.remove("hidden");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ⚡ JSON — Version batchée optimisée
  // ═══════════════════════════════════════════════════════════════════════
  async function runJsonGeneration() {
    if (!state.sqlite) { toast("Charge un .cdb.", "err"); return; }
    state.cancelled = false; state.running = true;
    state.missingNames = []; state.resolvedCards = [];
    state.generatedFiles = []; state.generatedCards = [];
    dom.btnRun.disabled = true; dom.btnClear.disabled = true;
    dom.progressWrap.classList.add("visible");
    dom.yugiProgressWrap.classList.remove("visible");
    dom.btnCancelYugi.classList.add("hidden");
    setProgress(0, "Préparation…");
    if (window.resetYugipediaCancel) window.resetYugipediaCancel();

    try {
      if (window.memCacheFr && window.memCacheEn) buildNameIndexes();
      await nextFrame();

      const rows = state.sqlite.exec(`
        SELECT t.id AS id, t.name AS name, t.desc AS desc,
          d.type AS type, d.atk AS atk, d.def AS def,
          d.level AS level, d.race AS race, d.attribute AS attribute
        FROM texts t LEFT JOIN datas d ON t.id = d.id
      `)[0].values;
      const total = rows.length;

      const report = [], reportIndex = new Map();
      let done = 0;
      let foundLocal = 0, foundTilde = 0, foundYugi = 0, foundApi = 0, foundCdb = 0;
      const pending = [];

      // ═══ PASSE 1 : LOCALE + TILDE ═══
      for (let i = 0; i < rows.length; i++) {
        const [localId, localName, localDesc, dbType, dbAtk, dbDef, dbLevel, dbRace, dbAttribute] = rows[i];
        const key = normalize(localName);
        let matched = null, matchedSource = null;
        if (state.nameIndexFr || state.nameIndexEn) {
          matched = (state.nameIndexFr ? state.nameIndexFr.get(key) : null)
                 || (state.nameIndexEn ? state.nameIndexEn.get(key) : null);
          if (matched) matchedSource = "local";
        }
        let enNameFromTilde = null;
        if (!matched && localDesc) {
          const m = localDesc.match(/~([^~]+)~/);
          if (m && m[1]) {
            enNameFromTilde = m[1].trim();
            const k2 = normalize(enNameFromTilde);
            matched = (state.nameIndexFr ? state.nameIndexFr.get(k2) : null)
                   || (state.nameIndexEn ? state.nameIndexEn.get(k2) : null);
            if (matched) matchedSource = "tilde";
          }
        }
        let card;
        const cardIndex = state.resolvedCards.length;
        if (matched) {
          card = { ...matched, id: localId, name: localName, desc: localDesc };
          if (matchedSource === "local") foundLocal++;
          else foundTilde++;
        } else {
          const frameType = detectFrameType(dbType);
          const isSpell = (dbType & 0x2) !== 0;
          const isTrap = (dbType & 0x4) !== 0;
          card = {
            id: localId, name: localName, desc: localDesc,
            type: isSpell ? "Spell Card" : isTrap ? "Trap Card" : "Effect Monster",
            frameType, atk: dbAtk ?? 0, def: dbDef ?? 0, level: dbLevel ?? 0,
            race: raceFromCode(dbRace), attribute: attributeFromCode(dbAttribute),
            card_images: [],
          };
          foundCdb++;
        }
        if (!matched) {
          pending.push({ index: cardIndex, localId, name: localName, enName: enNameFromTilde || null });
        }
        state.resolvedCards.push({ localId, name: localName, enName: enNameFromTilde || null, desc: localDesc, card, source: matchedSource || "cdb" });
        done++;
        pushReport(report, reportIndex, { id: localId, name: localName, status: "ok", source: matchedSource || "cdb" });
        if (i % YIELD_EVERY === 0 || i === rows.length - 1) {
          setProgress(5 + Math.round((i / total) * 55), `Analyse ${i + 1} / ${total}…`);
          await nextFrame();
        }
        if (state.cancelled) break;
      }
      console.log(`[CDB] Passe 1 : ${foundLocal} loc, ${foundTilde} tilde, ${foundCdb} cdb · ${pending.length} à chercher`);

      // ═══ PASSE 2 : YGOPRODECK BATCH ═══
      if (pending.length > 0 && !state.cancelled) {
        console.log(`[CDB] ⚡ Passe 2 : Batch YGOPRODeck pour ${pending.length} carte(s)`);
        dom.yugiProgressWrap.classList.add("visible");
        dom.btnCancelYugi.classList.remove("hidden");
        setYugiProgress(0, `Batch YGOPRODeck…`);

        let apiResolved = 0;

        // 2a. Noms FR
        const batchFr = await fetchCardsByNamesBatch(pending.map((p) => p.name), "fr");
        for (const p of pending) {
          const card = findInBatch(batchFr, p.name);
          if (card && card.card_images && card.card_images.length > 0) {
            const item = state.resolvedCards[p.index];
            item.card = { ...item.card, card_images: card.card_images };
            item.source = (item.source || "cdb") + "+api-fr";
            p.resolved = true; apiResolved++; foundApi++;
            if (foundCdb > 0) foundCdb--;
          }
        }
        setYugiProgress(30, `Batch FR : ${apiResolved} OK`);

        // 2b. Noms EN du tilde
        const still1 = pending.filter((p) => !p.resolved);
        const enNames = still1.filter((p) => p.enName).map((p) => p.enName);
        if (enNames.length) {
          const batchEn = await fetchCardsByNamesBatch(enNames, null);
          for (const p of still1) {
            if (!p.enName) continue;
            const card = findInBatch(batchEn, p.enName);
            if (card && card.card_images && card.card_images.length > 0) {
              const item = state.resolvedCards[p.index];
              item.card = { ...item.card, card_images: card.card_images };
              item.source = (item.source || "cdb") + "+api-en";
              p.resolved = true; apiResolved++; foundApi++;
              if (foundCdb > 0) foundCdb--;
            }
          }
        }
        setYugiProgress(60, `Batch EN tilde : ${apiResolved} OK`);

        // 2c. Noms FR nettoyés
        const still2 = pending.filter((p) => !p.resolved);
        const cleanedPairs = [];
        for (const p of still2) {
          const c = cleanNameForApi(p.name);
          if (c && c !== p.name) cleanedPairs.push({ p, c });
        }
        if (cleanedPairs.length) {
          const batchCl = await fetchCardsByNamesBatch(cleanedPairs.map((x) => x.c), "fr");
          for (const { p, c } of cleanedPairs) {
            if (p.resolved) continue;
            const card = findInBatch(batchCl, c);
            if (card && card.card_images && card.card_images.length > 0) {
              const item = state.resolvedCards[p.index];
              item.card = { ...item.card, card_images: card.card_images };
              item.source = (item.source || "cdb") + "+api-fr-clean";
              p.resolved = true; apiResolved++; foundApi++;
              if (foundCdb > 0) foundCdb--;
            }
          }
        }
        setYugiProgress(100, `Batch terminé : ${apiResolved} OK`);
        console.log(`[CDB] Passe 2 : ${apiResolved} images via batch API`);
        dom.btnCancelYugi.classList.add("hidden");
        dom.yugiProgressWrap.classList.remove("visible");
      }

      // ═══ PASSE 3 : YUGIPEDIA BATCH ═══
      const stillLeft = pending.filter((p) => !p.resolved);
      const yugiEnByIndex = new Map(); // index → nom EN trouvé via Yugipedia
      if (stillLeft.length > 0 && !state.cancelled &&
          window.YugipediaAPI && window.YugipediaAPI.isYugipediaEnabled()) {
        console.log(`[CDB] ⚡ Passe 3 : Yugipedia (batch) pour ${stillLeft.length} carte(s)`);
        dom.yugiProgressWrap.classList.add("visible");
        dom.btnCancelYugi.classList.remove("hidden");
        setYugiProgress(0, `Yugipedia batch…`);

        const allQueries = new Set();
        for (const p of stillLeft) {
          if (p.name) allQueries.add(p.name);
          if (p.enName) allQueries.add(p.enName);
        }

        let batchResults = new Map();
        try {
          batchResults = await window.yugipediaSearchBatch([...allQueries]);
        } catch (err) { console.error("[CDB] Erreur batch", err); }

        let yugiResolved = 0;
        for (let i = 0; i < stillLeft.length; i++) {
          const p = stillLeft[i];
          let yugiCards = batchResults.get(p.name) || [];
          if (!yugiCards.length && p.enName) yugiCards = batchResults.get(p.enName) || [];
          if (yugiCards.length > 0) {
            const exact = yugiCards[0];
            // On stocke le nom EN pour le re-batch YGOPRODeck en passe 3.5
            if (exact._names && exact._names.en) {
              yugiEnByIndex.set(p.index, exact._names.en);
            }
            if (exact && exact.card_images && exact.card_images.length > 0) {
              const item = state.resolvedCards[p.index];
              item.card = { ...item.card, card_images: exact.card_images };
              item.source = (item.source || "cdb") + "+yugi";
              yugiResolved++; foundYugi++;
              if (foundCdb > 0) foundCdb--;
            }
          }
          if (i % 20 === 0 || i === stillLeft.length - 1) {
            setYugiProgress(Math.round(((i + 1) / stillLeft.length) * 100),
              `Yugipedia ${i + 1} / ${stillLeft.length}… (${yugiResolved} OK)`);
            await nextFrame();
          }
        }
        console.log(`[CDB] Passe 3 : ${yugiResolved} images via Yugipedia`);
        dom.btnCancelYugi.classList.add("hidden");
        dom.yugiProgressWrap.classList.remove("visible");
      }

      // ═══ PASSE 3.5 : RE-BATCH YGOPRODECK avec noms EN de Yugipedia ═══
      if (yugiEnByIndex.size > 0 && !state.cancelled) {
        console.log(`[CDB] ⚡ Passe 3.5 : Re-batch YGOPRODeck avec ${yugiEnByIndex.size} nom(s) EN`);
        const enNamesToFetch = [...yugiEnByIndex.values()];
        const batchEn2 = await fetchCardsByNamesBatch(enNamesToFetch, null);
        let improved = 0;
        for (const [idx, enName] of yugiEnByIndex) {
          const card = findInBatch(batchEn2, enName);
          if (card && card.card_images && card.card_images.length > 0) {
            const item = state.resolvedCards[idx];
            item.card = { ...item.card, card_images: card.card_images };
            item.source = (item.source || "cdb") + "+api-en2";
            improved++;
          }
        }
        console.log(`[CDB] Passe 3.5 : ${improved} image(s) améliorée(s) (YGOPRODeck > Yugipedia)`);
      }

      if (state.cancelled) {
        setStatus("⚠️ Interrompu.");
        return;
      }

      // ═══ PASSE 4 : JSON + CSV ═══
      setProgress(80, "Génération des JSON…");
      const totalResolved = state.resolvedCards.length;

      for (let i = 0; i < totalResolved; i++) {
        const item = state.resolvedCards[i];
        const mergedCard = { ...item.card, name: item.name, desc: item.desc };
        try {
          const json = await window.generateJsonForCard(mergedCard, item.name);
          state.generatedFiles.push({
            filename: `${window.sanitizeFilename(item.name)}.json`,
            json: JSON.stringify(json, null, 2),
          });
          state.generatedCards.push(mergedCard);
        } catch (err) { console.error(`[CDB] JSON err "${item.name}"`, err); }
        if (i % 100 === 0 || i === totalResolved - 1) {
          setProgress(80 + Math.round(((i + 1) / totalResolved) * 18), `JSON ${i + 1} / ${totalResolved}…`);
          await nextFrame();
        }
      }

      setProgress(100, "Terminé !");
      renderResults(report, { total, done, missing: 0, modifiedCount: 0, doneYugi: 0 });
      dom.downloads.classList.remove("hidden");
      showJsonDownloadsOnly();

      setStatus(
        `✅ ${state.generatedFiles.length} JSON · ${foundLocal} loc, ${foundTilde} tilde, ${foundApi} API, ${foundYugi} Yugipedia, ${foundCdb} cdb seul.`
      );
      toast(`${state.generatedFiles.length} JSON générés !`, "ok");
    } catch (err) {
      console.error("[CDB] Erreur", err);
      setStatus(`❌ ${err.message}`);
    } finally {
      state.running = false;
      dom.btnRun.disabled = false; dom.btnClear.disabled = false;
      dom.btnCancelYugi.classList.add("hidden");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════
  function detectFrameType(type) {
    if (!type) return "effect";
    if (type & 0x4000000) return "link";
    if (type & 0x800000) return "xyz";
    if (type & 0x2000) return "synchro";
    if (type & 0x40) return "fusion";
    if (type & 0x80) return "ritual";
    if (type & 0x10) return "normal";
    if (type & 0x2) return "spell";
    if (type & 0x4) return "trap";
    return "effect";
  }
  function raceFromCode(code) {
    if (!code) return "Warrior";
    const R = { 0x1:"Warrior",0x2:"Spellcaster",0x4:"Fairy",0x8:"Fiend",0x10:"Zombie",0x20:"Machine",0x40:"Aqua",0x80:"Pyro",0x100:"Rock",0x200:"Winged Beast",0x400:"Plant",0x800:"Insect",0x1000:"Thunder",0x2000:"Dragon",0x4000:"Beast",0x8000:"Beast-Warrior",0x10000:"Dinosaur",0x20000:"Fish",0x40000:"Sea Serpent",0x80000:"Reptile",0x100000:"Psychic",0x200000:"Divine-Beast",0x400000:"Creator God",0x800000:"Wyrm",0x1000000:"Cyberse" };
    for (const [b, n] of Object.entries(R)) if (code & parseInt(b)) return n;
    return "Warrior";
  }
  function attributeFromCode(code) {
    if (!code) return "DARK";
    const A = { 0x1:"EARTH",0x2:"WATER",0x4:"FIRE",0x8:"WIND",0x10:"LIGHT",0x20:"DARK",0x40:"DIVINE" };
    for (const [b, n] of Object.entries(A)) if (code & parseInt(b)) return n;
    return "DARK";
  }

  function pushReport(r, ri, e) { if (r.length < MAX_REPORT_LINES) { r.push(e); ri.set(e.id, e); } }
  function updateReport(ri, id, u) { const i = ri.get(id); if (i) Object.assign(i, u); }
  function nextFrame() { return new Promise((r) => setTimeout(r, 0)); }

  function applyUpdates(db, updates) {
    if (!updates.length) return;
    const cols = getColumns(db, "texts");
    const hasDesc = cols.includes("desc");
    const stmt = db.prepare(`UPDATE texts SET ${hasDesc ? "name = ?, desc = ?" : "name = ?"} WHERE id = ?`);
    db.run("BEGIN TRANSACTION");
    try {
      for (const u of updates) {
        const id = parseInt(u.id, 10);
        if (isNaN(id)) continue;
        stmt.run(hasDesc ? [String(u.name ?? ""), String(u.desc ?? ""), id] : [String(u.name ?? ""), id]);
      }
      db.run("COMMIT");
    } catch (err) { db.run("ROLLBACK"); throw err; }
    finally { stmt.free(); }
  }
  function getColumns(db, t) { return db.exec(`PRAGMA table_info(${t})`)[0].values.map((r) => r[1]); }

  function downloadPatched() {
    if (!state.patched || !state.file) return;
    const base = state.file.name.replace(/\.cdb$/i, "");
    triggerDownload(new Blob([state.patched], { type: "application/octet-stream" }), `${base}_fr.cdb`);
    toast(".cdb téléchargé", "ok");
  }
  async function downloadJsonZip() {
    if (!state.generatedFiles.length) { toast("Aucun JSON.", "err"); return; }
    await window.downloadAsZip(state.generatedFiles);
    toast(`${state.generatedFiles.length} JSON zippés !`, "ok");
  }
  function downloadCsv() {
    if (!state.generatedCards.length) { toast("Aucune carte.", "err"); return; }
    window.downloadManagerCsv(state.generatedCards);
  }
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportMissing() {
    if (!state.missingNames.length) return;
    const blob = new Blob([state.missingNames.join("\n")], { type: "text/plain;charset=utf-8" });
    triggerDownload(blob, `non_trouvees.txt`);
  }

  function showFileInfo(file, total) {
    dom.info.classList.remove("hidden");
    dom.info.innerHTML = `<strong>📦 ${escapeHtml(file.name)}</strong><br>${(file.size / 1024).toFixed(1)} Ko · ${total} entrées`;
  }
  function renderResults(report, stats) {
    dom.statTotal.textContent = stats.total;
    dom.statDone.textContent = stats.done;
    dom.statMissing.textContent = stats.missing;
    dom.stats.classList.remove("hidden");
    dom.results.innerHTML = "";
  }
  function setProgress(pct, label) {
    dom.progressFill.style.width = pct + "%";
    dom.progressPct.textContent = pct + "%";
    if (label) dom.progressLbl.textContent = label;
  }
  function setYugiProgress(pct, label) {
    if (!dom.yugiFill) return;
    dom.yugiFill.style.width = pct + "%";
    dom.yugiPct.textContent = pct + "%";
    if (label) dom.yugiLabel.textContent = label;
  }
  function setStatus(text) { dom.status.textContent = text; }

  function resetUI() {
    if (state.running) return;
    state.file = null; state.sqlite = null; state.patched = null;
    state.missingNames = []; state.cancelled = false;
    state.resolvedCards = []; state.generatedFiles = []; state.generatedCards = [];
    dom.fileInput.value = ""; dom.info.classList.add("hidden");
    dom.actions.classList.add("hidden"); dom.stats.classList.add("hidden");
    dom.results.innerHTML = ""; dom.downloads.classList.add("hidden");
    dom.progressWrap.classList.remove("visible");
    dom.yugiProgressWrap.classList.remove("visible");
    dom.btnCancelYugi.classList.add("hidden");
    dom.btnExportMissing.classList.add("hidden");
    setStatus("");
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function bindEvents() {
    bindDropZone();
    if (dom.btnRun) dom.btnRun.addEventListener("click", run);
    if (dom.btnClear) dom.btnClear.addEventListener("click", resetUI);
    if (dom.btnDownloadCdb) dom.btnDownloadCdb.addEventListener("click", downloadPatched);
    if (dom.btnDownloadZip) dom.btnDownloadZip.addEventListener("click", downloadJsonZip);
    if (dom.btnDownloadCsv) dom.btnDownloadCsv.addEventListener("click", downloadCsv);
    if (dom.btnCancelYugi) dom.btnCancelYugi.addEventListener("click", () => {
      state.cancelled = true;
      if (window.cancelYugipedia) window.cancelYugipedia();
      toast("Annulation…", "info");
    });
    if (dom.btnExportMissing) dom.btnExportMissing.addEventListener("click", exportMissing);
    updateActionUI();
  }

  bindEvents();
})();
