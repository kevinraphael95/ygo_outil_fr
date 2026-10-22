// ============================================================================
// CDB TRANSLATOR — Version batchée (YGOPRODeck API + Yugipedia cache local)
// ============================================================================
// Passe 1 : Base locale (FR/EN) + tilde ~EN~
// Passe 2 : Batch YGOPRODeck via name= (40 noms/requête)
// Passe 3 : Cache Yugipedia local (window.yugiCache)
// Passe 3.5 : Re-batch YGOPRODeck avec les noms EN trouvés
// Passe 4 : Génération JSON + CSV
//
// STRUCTURE des cartes : décodée depuis le .cdb (decodeCdbCard) ; la carte
// officielle trouvée par nom ne sert qu'aux illustrations.
//
// 🆕 TRADUCTION .cdb — cartes modifiées (option "Préserver les effets modifiés") :
//   • la comparaison se fait AUSSI quand le nom est un nom FR officiel
//     (avant : l'effet custom était écrasé sans comparaison) ;
//   • la description locale est comparée à la desc FR ET EN officielles ;
//   • comparaison tolérante : on ignore casse, accents, ponctuation, retours
//     à la ligne, ~nom EN~, [tags] et le tag configuré ;
//   • un tag (défaut "[CUSTOM]") est ajouté au début de la description des
//     cartes modifiées (champ ajouté automatiquement sous la case à cocher) ;
//   • les cartes modifiées ne sont plus comptées dans "Traduites en FR".
// ============================================================================

(() => {
  "use strict";

  const SQL_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3";
  const YGOPRODECK_API = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
  const MAX_REPORT_LINES = 250;
  const YIELD_EVERY = 200;

  const state = {
    file: null, sqlite: null, patched: null, sqlLib: null, sqlReady: false,
    nameIndexFr: null, nameIndexEn: null, missingNames: [], cancelled: false,
    running: false, resolvedCards: [], generatedFiles: [], generatedCards: [],
    tag: "", modName: false,
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
    customTag: null, customName: null,
  };

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITAIRES
  // ═══════════════════════════════════════════════════════════════════════
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

  // Clé de comparaison tolérante : ignore casse, accents, ponctuation, retours
  // à la ligne, ~nom EN~, [tags / libellés Pendule] et le tag configuré.
  function descKey(s) {
    let t = String(s || "").toLowerCase();
    if (state.tag) t = t.split(state.tag.toLowerCase()).join("");
    return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/~[^~]*~/g, "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }
  function descDiffers(a, b) { return descKey(a) !== descKey(b); }

  // Modifiée = la desc locale diffère de TOUTES les descs officielles connues (FR et EN)
  function isModified(localDesc, ...officialDescs) {
    const valid = officialDescs.filter(Boolean);
    if (!valid.length || !String(localDesc || "").trim()) return false;
    return valid.every((d) => descDiffers(localDesc, d));
  }

  // Ajoute le tag au début de la description (une seule fois)
  function tagDesc(desc) {
    const d = String(desc || "");
    const tag = state.tag;
    if (!tag) return d;
    if (d.toLowerCase().includes(tag.toLowerCase())) return d;
    return d ? `${tag} ${d}` : tag;
  }

  // Nom d'une carte modifiée : conservé tel quel, sauf si l'option est cochée
  function modifiedName(frName, localName) {
    return state.modName ? frName : localName;
  }

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
  // BATCH YGOPRODECK — name= (40 noms par requête)
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
  // CACHE YUGIPEDIA LOCAL
  // ═══════════════════════════════════════════════════════════════════════
  function lookupYugiCache(name) {
    if (!window.yugiCache || !name) return null;
    const key = normalize(name);
    return window.yugiCache.get(key) || null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RÉSOLUTION DE CARTE (locale)
  // ═══════════════════════════════════════════════════════════════════════
  async function resolveCard(localName, localDesc, customMode) {
    const key = normalize(localName);
    if (!key) return { status: "not_found" };

    // --- Le nom local est un nom FR officiel ---
    const frMatch = state.nameIndexFr.get(key);
    if (frMatch) {
      if (customMode) {
        const enCard = window.memCacheEn.get(String(frMatch.id));
        if (isModified(localDesc, frMatch.desc, enCard && enCard.desc)) {
          return { status: "translated", name: modifiedName(frMatch.name, localName), desc: tagDesc(localDesc), modified: true, card: frMatch, source: "local" };
        }
      }
      return { status: "translated", name: frMatch.name, desc: frMatch.desc || "", card: frMatch, source: "local" };
    }

    // --- Le nom local est un nom EN officiel ---
    const enMatch = state.nameIndexEn.get(key);
    if (enMatch) {
      const frById = window.memCacheFr.get(String(enMatch.id));
      if (frById) {
        if (customMode && isModified(localDesc, enMatch.desc, frById.desc)) {
          return { status: "translated", name: modifiedName(frById.name, localName), desc: tagDesc(localDesc), modified: true, card: frById, source: "local" };
        }
        return { status: "translated", name: frById.name, desc: frById.desc || "", card: frById, source: "local" };
      }
      return { status: "en_only", name: enMatch.name, desc: enMatch.desc || localDesc || "", card: enMatch, source: "local" };
    }
    return { status: "not_found" };
  }

  function resolveCardFromYugiCache(localName, localDesc, customMode, yugiCard) {
    if (!yugiCard) return { status: "not_found" };
    const frName = yugiCard.fr || yugiCard.en || localName;
    const frDesc = yugiCard.fr_lore || yugiCard.lore || localDesc;
    if (customMode && isModified(localDesc, yugiCard.lore, yugiCard.fr_lore)) {
      return { status: "translated", name: modifiedName(frName, localName), desc: tagDesc(localDesc), modified: true, card: yugiCard, source: "yugipedia" };
    }
    return { status: "translated", name: frName, desc: frDesc || localDesc || "", card: yugiCard, source: "yugipedia" };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CHARGEMENT FICHIER
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

  // Champ "tag des cartes modifiées" ajouté automatiquement sous la case
  // "Préserver les effets modifiés" (aucune modification d'index.html requise).
  function ensureTagInput() {
    if (dom.customTag || !dom.customMode) return;
    const wrap = dom.customMode.closest(".cdb-option");
    if (!wrap) return;
    const box = document.createElement("div");
    box.id = "cdb-custom-tag-wrap";
    box.style.cssText = "margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
    box.innerHTML =
      '<label for="cdb-custom-tag" class="cdb-option-label">Tag ajouté aux cartes modifiées</label>' +
      '<input type="text" id="cdb-custom-tag" value="[CUSTOM]" autocomplete="off" placeholder="vide = aucun tag" ' +
      'style="padding:8px 10px;border-radius:8px;border:1px solid var(--border,#555);background:transparent;color:inherit;min-width:160px;">' +
      '<label class="cdb-option-label" style="flex-basis:100%;display:flex;align-items:center;gap:8px;cursor:pointer;">' +
      '<input type="checkbox" id="cdb-custom-name"> Traduire aussi le <strong>nom</strong> des cartes modifiées (sinon nom et effet restent intacts)</label>';
    wrap.insertAdjacentElement("afterend", box);
    dom.customTag = $("cdb-custom-tag");
    dom.customName = $("cdb-custom-name");
  }

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
    if (dom.customTag) {
      const on = !isJson && dom.customMode && dom.customMode.checked;
      dom.customTag.disabled = !on;
      if (dom.customName) dom.customName.disabled = !on;
      const tw = $("cdb-custom-tag-wrap");
      if (tw) tw.style.opacity = on ? "1" : "0.4";
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
  // ACTION 1 : TRADUIRE LE .CDB
  // ═══════════════════════════════════════════════════════════════════════
  async function runTranslation() {
    if (!state.sqlite) { toast("Charge un .cdb.", "err"); return; }
    const customMode = dom.customMode ? dom.customMode.checked : false;
    const yugiMode = dom.yugiMode ? dom.yugiMode.checked : false;
    state.tag = (customMode && dom.customTag) ? dom.customTag.value.trim() : "";
    state.modName = !!(customMode && dom.customName && dom.customName.checked);
    state.cancelled = false; state.running = true; state.missingNames = [];
    dom.btnRun.disabled = true; dom.btnClear.disabled = true;
    dom.progressWrap.classList.add("visible");
    setProgress(0, "Préparation…");

    try {
      buildNameIndexes(); await nextFrame();
      const rows = state.sqlite.exec("SELECT id, name, desc FROM texts")[0].values;
      const total = rows.length;
      const updates = [], missingCards = [];
      let done = 0, doneYugi = 0, missing = 0, modifiedCount = 0;

      for (let i = 0; i < rows.length; i++) {
        const [localId, localName, localDesc] = rows[i];
        let enNameFromTilde = null;
        if (localDesc) {
          const m = localDesc.match(/~([^~]+)~/);
          if (m && m[1]) enNameFromTilde = m[1].trim();
        }
        let resolved = await resolveCard(localName, localDesc, customMode);
        if (resolved.status === "not_found" && enNameFromTilde) {
          resolved = await resolveCard(enNameFromTilde, localDesc, customMode);
        }
        if (resolved.status === "translated") {
          updates.push({ id: localId, name: resolved.name, desc: resolved.desc });
          if (resolved.modified) modifiedCount++;
          else done++;
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

      // Passe 2 : Cache Yugipedia local
      if (yugiMode && missingCards.length > 0 && window.yugiCache) {
        let yugiResolved = 0;
        for (const card of missingCards) {
          if (state.cancelled) break;
          const yugiCard = lookupYugiCache(card.name);
          if (yugiCard) {
            const r = resolveCardFromYugiCache(card.name, card.desc, customMode, yugiCard);
            if (r.status === "translated") {
              updates.push({ id: card.id, name: r.name, desc: r.desc });
              if (r.modified) modifiedCount++;
              else { done++; doneYugi++; }
              missing--; yugiResolved++;
            } else state.missingNames.push(card.name);
          } else state.missingNames.push(card.name);
        }
        console.log(`[CDB] Cache Yugipedia : ${yugiResolved} cartes trouvées`);
      }

      applyUpdates(state.sqlite, updates);
      state.patched = state.sqlite.export();
      setProgress(100, "Terminé !");
      renderResults({ total, done, missing, modifiedCount, doneYugi });
      dom.downloads.classList.remove("hidden");
      showTranslateDownloadsOnly();
      setStatus(
        `✅ ${done} / ${total} traduite(s)` +
        (modifiedCount > 0 ? ` · ${modifiedCount} custom conservée(s)${state.tag ? ` (tag ${state.tag})` : ""}` : "") +
        (doneYugi > 0 ? ` · ${doneYugi} via cache Yugipedia` : "") + "."
      );
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
  // ACTION 2 : GÉNÉRER LES JSON
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

        // Structure décodée depuis le .cdb (null si la carte n'a pas de ligne `datas`)
        const cdbStruct = (dbType !== null && dbType !== undefined)
          ? { ...decodeCdbCard(dbType, dbRace, dbAttribute, dbLevel, dbAtk, dbDef), _fromCdb: true }
          : null;

        let card;
        const cardIndex = state.resolvedCards.length;
        if (matched) {
          card = { ...matched, ...(cdbStruct || {}), id: localId, name: localName, desc: localDesc };
          if (matchedSource === "local") foundLocal++;
          else foundTilde++;
        } else {
          if (cdbStruct) {
            card = { ...cdbStruct, id: localId, name: localName, desc: localDesc, card_images: [] };
          } else {
            card = {
              id: localId, name: localName, desc: localDesc,
              type: "Effect Monster", frameType: "effect",
              atk: 0, def: 0, level: 0,
              race: "Warrior", attribute: "DARK",
              card_images: [],
            };
          }
          foundCdb++;
        }
        if (!matched) {
          pending.push({ index: cardIndex, localId, name: localName, enName: enNameFromTilde || null });
        }
        state.resolvedCards.push({ localId, name: localName, enName: enNameFromTilde || null, desc: localDesc, card, source: matchedSource || "cdb" });
        done++;
        if (i % YIELD_EVERY === 0 || i === rows.length - 1) {
          setProgress(5 + Math.round((i / total) * 55), `Analyse ${i + 1} / ${total}…`);
          await nextFrame();
        }
        if (state.cancelled) break;
      }
      console.log(`[CDB] Passe 1 : ${foundLocal} loc, ${foundTilde} tilde, ${foundCdb} cdb · ${pending.length} à chercher`);

      // ═══ PASSE 2 : YGOPRODECK BATCH (illustrations uniquement) ═══
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

      // ═══ PASSE 3 : CACHE YUGIPEDIA LOCAL ═══
      const stillLeft = pending.filter((p) => !p.resolved);
      const yugiEnByIndex = new Map();
      if (stillLeft.length > 0 && !state.cancelled && window.yugiCache) {
        console.log(`[CDB] ⚡ Passe 3 : Cache Yugipedia pour ${stillLeft.length} carte(s)`);
        dom.yugiProgressWrap.classList.add("visible");
        dom.btnCancelYugi.classList.remove("hidden");
        setYugiProgress(0, `Cache Yugipedia…`);

        let yugiResolved = 0;
        for (let i = 0; i < stillLeft.length; i++) {
          if (state.cancelled) break;
          const p = stillLeft[i];

          let yugiCard = lookupYugiCache(p.name);
          if (!yugiCard && p.enName) yugiCard = lookupYugiCache(p.enName);

          if (yugiCard) {
            if (yugiCard.en) yugiEnByIndex.set(p.index, yugiCard.en);

            const img = yugiCard.img || yugiCard.img_en;
            if (img) {
              const item = state.resolvedCards[p.index];
              item.card = { ...item.card, card_images: [{ image_url: img, image_url_cropped: img }] };
              item.source = (item.source || "cdb") + "+yugi";
              yugiResolved++; foundYugi++;
              if (foundCdb > 0) foundCdb--;
            }
          }

          if (i % 20 === 0 || i === stillLeft.length - 1) {
            setYugiProgress(Math.round(((i + 1) / stillLeft.length) * 100),
              `Cache ${i + 1} / ${stillLeft.length}… (${yugiResolved} OK)`);
            await nextFrame();
          }
        }
        console.log(`[CDB] Passe 3 : ${yugiResolved} images via cache local`);
        dom.btnCancelYugi.classList.add("hidden");
        dom.yugiProgressWrap.classList.remove("visible");
      } else if (stillLeft.length > 0 && !window.yugiCache) {
        console.warn("[CDB] Passe 3 skippée : window.yugiCache indisponible");
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
        console.log(`[CDB] Passe 3.5 : ${improved} image(s) améliorée(s)`);
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
      renderResults({ total, done, missing: 0, modifiedCount: 0, doneYugi: 0 });
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
  // HELPERS — DÉCODAGE DU .CDB
  // ═══════════════════════════════════════════════════════════════════════
  // Bits de la colonne `type` d'EDOPro / YGOPro :
  //   0x1 Monstre · 0x2 Magie · 0x4 Piège · 0x10 Normal · 0x20 Effet · 0x40 Fusion
  //   0x80 Rituel · 0x200 Esprit · 0x400 Union · 0x800 Gémeau · 0x1000 Syntoniseur
  //   0x2000 Synchro · 0x4000 Token · 0x10000 Magie Rapide · 0x20000 Continue
  //   0x40000 Équipement · 0x80000 Terrain · 0x100000 Contre · 0x200000 Retournement
  //   0x400000 Toon · 0x800000 Xyz · 0x1000000 Pendule · 0x4000000 Lien
  // `level` : bas = niveau/rang/valeur Lien · bits 16-23 = échelle droite · 24-31 = échelle gauche
  // `def`   : pour un Lien, bitmask des flèches.
  function decodeCdbCard(t, race, attr, lvl, atk, def) {
    t = t | 0; lvl = lvl | 0; atk = atk ?? 0; def = def ?? 0;
    const has = (b) => (t & b) !== 0;
    const empty = { typeline: undefined, linkval: undefined, linkmarkers: undefined, scale: undefined, scaleRight: undefined };

    // ─── Magie / Piège ───
    if (has(0x2) || has(0x4)) {
      const spell = has(0x2);
      let sub = "Normal";
      if (has(0x10000)) sub = "Quick-Play";
      else if (has(0x20000)) sub = "Continuous";
      else if (has(0x40000)) sub = "Equip";
      else if (has(0x80000)) sub = "Field";
      else if (has(0x100000)) sub = "Counter";
      else if (has(0x80)) sub = "Ritual";
      return {
        ...empty,
        type: spell ? "Spell Card" : "Trap Card",
        frameType: spell ? "spell" : "trap",
        race: sub, attribute: undefined,
        atk: 0, def: 0, level: 0,
      };
    }

    // ─── Monstres ───
    const isLink = has(0x4000000);
    const isPend = has(0x1000000);
    const baseFrame =
      has(0x4000) ? "token"
      : isLink ? "link"
      : has(0x800000) ? "xyz"
      : has(0x2000) ? "synchro"
      : has(0x40) ? "fusion"
      : has(0x80) ? "ritual"
      : has(0x20) ? "effect"
      : has(0x10) ? "normal"
      : "effect";

    // Capacités, dans l'ordre d'affichage officiel
    const ab = [];
    if (has(0x40)) ab.push("Fusion");
    if (has(0x2000)) ab.push("Synchro");
    if (has(0x800000)) ab.push("Xyz");
    if (isLink) ab.push("Link");
    if (has(0x80)) ab.push("Ritual");
    if (has(0x200)) ab.push("Spirit");
    if (has(0x400)) ab.push("Union");
    if (has(0x800)) ab.push("Gemini");
    if (has(0x400000)) ab.push("Toon");
    if (isPend) ab.push("Pendulum");
    if (has(0x200000)) ab.push("Flip");
    if (has(0x1000)) ab.push("Tuner");
    if (has(0x20)) ab.push("Effect");
    if (has(0x10)) ab.push("Normal");

    const raceName = raceFromCode(race);
    const out = {
      ...empty,
      type: has(0x4000) ? "Token" : (ab.length ? ab.join(" ") : "Effect") + " Monster",
      frameType: isPend ? baseFrame + "_pendulum" : baseFrame,
      race: raceName,
      attribute: attributeFromCode(attr),
      typeline: [raceName, ...ab],
      atk: atk === -2 ? "?" : atk,
      def: def === -2 ? "?" : def,
      level: lvl & 0xff,
    };

    if (isPend) {
      out.scale = (lvl >> 24) & 0xff;       // échelle gauche (bleue)
      out.scaleRight = (lvl >> 16) & 0xff;  // échelle droite (rouge)
    }
    if (isLink) {
      out.linkval = lvl & 0xff;
      out.level = lvl & 0xff;
      const M = { 0x1: "Bottom-Left", 0x2: "Bottom", 0x4: "Bottom-Right", 0x8: "Left",
                  0x20: "Right", 0x40: "Top-Left", 0x80: "Top", 0x100: "Top-Right" };
      out.linkmarkers = Object.entries(M).filter(([b]) => (def & Number(b)) !== 0).map(([, n]) => n);
      out.def = "";
    }
    return out;
  }

  function raceFromCode(code) {
    if (!code) return "Warrior";
    const R = { 0x1:"Warrior",0x2:"Spellcaster",0x4:"Fairy",0x8:"Fiend",0x10:"Zombie",0x20:"Machine",0x40:"Aqua",0x80:"Pyro",0x100:"Rock",0x200:"Winged Beast",0x400:"Plant",0x800:"Insect",0x1000:"Thunder",0x2000:"Dragon",0x4000:"Beast",0x8000:"Beast-Warrior",0x10000:"Dinosaur",0x20000:"Fish",0x40000:"Sea Serpent",0x80000:"Reptile",0x100000:"Psychic",0x200000:"Divine-Beast",0x400000:"Creator God",0x800000:"Wyrm",0x1000000:"Cyberse",0x2000000:"Illusion" };
    for (const [b, n] of Object.entries(R)) if (code & parseInt(b)) return n;
    return "Warrior";
  }
  function attributeFromCode(code) {
    if (!code) return "DARK";
    const A = { 0x1:"EARTH",0x2:"WATER",0x4:"FIRE",0x8:"WIND",0x10:"LIGHT",0x20:"DARK",0x40:"DIVINE" };
    for (const [b, n] of Object.entries(A)) if (code & parseInt(b)) return n;
    return "DARK";
  }

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
  function renderResults(stats) {
    dom.statTotal.textContent = stats.total;
    dom.statDone.textContent = stats.done;
    dom.statMissing.textContent = stats.missing;
    dom.stats.classList.remove("hidden");
    dom.results.innerHTML = "";
    if (stats.modifiedCount > 0) {
      const li = document.createElement("li");
      li.textContent = `🛠️ ${stats.modifiedCount} carte(s) custom conservée(s) (effet${state.modName ? "" : " et nom"} non traduit${state.modName ? "" : "s"})` +
        (state.tag ? ` · tag ${state.tag} ajouté` : "");
      dom.results.appendChild(li);
    }
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
    ensureTagInput();
    if (dom.customMode) dom.customMode.addEventListener("change", updateActionUI);
    if (dom.btnRun) dom.btnRun.addEventListener("click", run);
    if (dom.btnClear) dom.btnClear.addEventListener("click", resetUI);
    if (dom.btnDownloadCdb) dom.btnDownloadCdb.addEventListener("click", downloadPatched);
    if (dom.btnDownloadZip) dom.btnDownloadZip.addEventListener("click", downloadJsonZip);
    if (dom.btnDownloadCsv) dom.btnDownloadCsv.addEventListener("click", downloadCsv);
    if (dom.btnCancelYugi) dom.btnCancelYugi.addEventListener("click", () => {
      state.cancelled = true;
      toast("Annulation…", "info");
    });
    if (dom.btnExportMissing) dom.btnExportMissing.addEventListener("click", exportMissing);
    updateActionUI();
  }

  bindEvents();
})();
