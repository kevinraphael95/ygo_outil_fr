// ============================================================================
// CDB TRANSLATOR — Traduire OU convertir un .cdb EDOPro/YGO Pro (par nom)
// ============================================================================
// Les .cdb custom (VAACT, Project Ignis, fan-made) utilisent des IDs locaux
// qui n'ont rien à voir avec les passcodes Konami. On croise donc par NOM.
//
// Deux actions supportées :
//   - "Traduire" : remplace noms + effets par leur VF. Sortie : .cdb_fr
//   - "JSON"     : génère un JSON par carte (ZIP) + CSV Manager.
//                  ⚡ Recherche multi-fallback :
//                    1. Nom FR base locale
//                    2. Nom EN base locale
//                    3. Nom EN entre ~...~ dans la desc
//                    4. Yugipedia (si activé) — en BATCH, pas carte par carte
//                    5. Infos du .cdb (dernier recours)
//
// Mode "Préserver les effets modifiés" (option, traduction uniquement) :
//   Si l'effet du .cdb ≠ effet officiel EN → l'effet a été modifié par un mod
//   custom (VAACT, Project Ignis, fan-made…). On garde alors l'effet ORIGINAL
//   du .cdb tel quel, et seul le NOM est traduit en FR.
//
// Fallback Yugipedia (option, traduction uniquement, désactivé par défaut) :
//   Si une carte est en anglais dans la base locale mais qu'une VF existe sur
//   Yugipedia, on récupère la VF. Sinon, on interroge Yugipedia uniquement
//   pour les cartes introuvables.
// ============================================================================

(() => {
  "use strict";

  // ==========================================================================
  // CONSTANTES
  // ==========================================================================

  const SQL_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3";
  const MAX_REPORT_LINES = 250;
  const YIELD_EVERY = 200;
  const YUGI_CONFIRM_THRESHOLD = 50;

  // ==========================================================================
  // ÉTAT
  // ==========================================================================

  const state = {
    file: null,
    sqlite: null,
    patched: null,
    sqlLib: null,
    sqlReady: false,
    nameIndexFr: null,
    nameIndexEn: null,
    missingNames: [],
    cancelled: false,
    running: false,
    resolvedCards: [],
    generatedFiles: [],
    generatedCards: [],
  };

  // ==========================================================================
  // DOM
  // ==========================================================================

  const $ = (id) => document.getElementById(id);
  const dom = {
    drop:         $("cdb-drop"),
    fileInput:    $("cdb-file"),
    info:         $("cdb-info"),
    actions:      $("cdb-actions"),
    btnRun:       $("cdb-translate"),
    btnClear:     $("cdb-clear"),

    actionTranslate: $("cdb-action-translate"),
    actionJson:      $("cdb-action-json"),

    customMode:   $("cdb-custom-mode"),
    yugiMode:     $("cdb-yugipedia-mode"),

    progressWrap: $("cdb-progress-wrap"),
    progressLbl:  $("cdb-progress-label"),
    progressPct:  $("cdb-progress-pct"),
    progressFill: $("cdb-progress-fill"),
    status:       $("cdb-status"),

    stats:        $("cdb-stats"),
    statTotal:    $("cdb-stat-total"),
    statDone:     $("cdb-stat-translated"),
    statMissing:  $("cdb-stat-missing"),
    statDoneLbl:  $("cdb-stat-translated-label"),
    statMissingLbl: $("cdb-stat-missing-label"),

    results:      $("cdb-results"),

    downloads:    $("cdb-downloads"),
    btnDownloadCdb: $("cdb-download"),
    btnDownloadZip: $("cdb-download-zip"),
    btnDownloadCsv: $("cdb-download-csv"),
    btnExportMissing: $("cdb-export-missing"),

    yugiProgressWrap: $("cdb-yugi-progress-wrap"),
    yugiLabel:        $("cdb-yugi-label"),
    yugiPct:          $("cdb-yugi-pct"),
    yugiFill:         $("cdb-yugi-fill"),
    btnCancelYugi:    $("cdb-cancel-yugi"),
  };

  // ==========================================================================
  // SQL.JS
  // ==========================================================================

  async function ensureSqlLoaded() {
    if (state.sqlReady) return state.sqlLib;
    if (typeof window.initSqlJs !== "function") {
      throw new Error("sql.js n'a pas été chargé (vérifie le <script> CDN).");
    }
    state.sqlLib = await window.initSqlJs({
      locateFile: (file) => `${SQL_CDN}/${file}`,
    });
    state.sqlReady = true;
    return state.sqlLib;
  }

  // ==========================================================================
  // INDEX PAR NOM
  // ==========================================================================

  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  function buildNameIndexes() {
    if (state.nameIndexFr && state.nameIndexEn) return;

    const fr = new Map();
    const en = new Map();

    window.memCacheFr.forEach((card) => {
      const key = normalize(card.name);
      if (!key) return;
      const existing = fr.get(key);
      if (!existing || card.name.length > existing.name.length) {
        fr.set(key, card);
      }
    });

    window.memCacheEn.forEach((card) => {
      const key = normalize(card.name);
      if (!key) return;
      const existing = en.get(key);
      if (!existing || card.name.length > existing.name.length) {
        en.set(key, card);
      }
    });

    state.nameIndexFr = fr;
    state.nameIndexEn = en;
    console.log(`[CDB] Index construits : ${fr.size} FR, ${en.size} EN`);
  }

  // ==========================================================================
  // COMPARAISON D'EFFETS (détection de mod custom)
  // ==========================================================================

  function cleanDesc(s) {
    return String(s || "")
      .replace(/\r\n/g, "\n")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function descDiffers(a, b) {
    const ca = cleanDesc(a);
    const cb = cleanDesc(b);
    return ca !== cb;
  }

  // ==========================================================================
  // RÉSOLUTION DE CARTE (pour la TRADUCTION uniquement)
  // ==========================================================================

  async function resolveCard(localName, localDesc, customMode, allowYugipedia) {
    const key = normalize(localName);
    if (!key) return { status: "not_found" };

    const frMatch = state.nameIndexFr.get(key);
    if (frMatch) {
      return {
        status: "translated",
        name: frMatch.name,
        desc: frMatch.desc || "",
        card: frMatch,
        source: "local",
      };
    }

    const enMatch = state.nameIndexEn.get(key);
    if (enMatch) {
      const frById = window.memCacheFr.get(String(enMatch.id));
      if (frById) {
        if (customMode && descDiffers(localDesc, enMatch.desc)) {
          return {
            status: "translated",
            name: frById.name,
            desc: localDesc || "",
            modified: true,
            card: frById,
            source: "local",
          };
        }
        return {
          status: "translated",
          name: frById.name,
          desc: frById.desc || "",
          card: frById,
          source: "local",
        };
      }

      if (allowYugipedia && window.YugipediaAPI && window.YugipediaAPI.isYugipediaEnabled()) {
        try {
          const yugiCards = await window.yugipediaSearch(enMatch.name);
          if (yugiCards && yugiCards.length) {
            const exact = yugiCards.find((c) => normalize(c._names?.en || "") === key)
                       || yugiCards.find((c) => normalize(c.name) === key)
                       || yugiCards[0];

            const frName = exact._names?.fr || "";
            const frDesc = exact._descs?.fr || "";

            if (frName && frName !== enMatch.name) {
              if (customMode && descDiffers(localDesc, enMatch.desc)) {
                return {
                  status: "translated",
                  name: frName,
                  desc: localDesc || "",
                  modified: true,
                  card: enMatch,
                  source: "yugipedia",
                };
              }
              return {
                status: "translated",
                name: frName,
                desc: frDesc || enMatch.desc || "",
                card: enMatch,
                source: "yugipedia",
              };
            }
          }
        } catch (err) {
          if (err.message === "Annulé par l'utilisateur") throw err;
          console.warn(`[CDB] Yugipedia VF échec pour "${enMatch.name}"`, err.message);
        }
      }

      return {
        status: "en_only",
        name: enMatch.name,
        desc: enMatch.desc || localDesc || "",
        card: enMatch,
        source: "local",
      };
    }

    if (allowYugipedia && window.YugipediaAPI && window.YugipediaAPI.isYugipediaEnabled()) {
      try {
        const yugiCards = await window.yugipediaSearch(localName);
        if (yugiCards && yugiCards.length) {
          const exact = yugiCards.find((c) => normalize(c.name) === key)
                     || yugiCards.find((c) => normalize(c._names?.en || "") === key)
                     || yugiCards[0];

          const frName = exact._names?.fr || exact.name;
          const frDesc = exact._descs?.fr || exact.desc || localDesc;
          const enDesc = exact._descs?.en || "";

          if (customMode && enDesc && descDiffers(localDesc, enDesc)) {
            return {
              status: "translated",
              name: frName,
              desc: localDesc || "",
              modified: true,
              card: exact,
              source: "yugipedia",
            };
          }

          return {
            status: "translated",
            name: frName,
            desc: frDesc || localDesc || "",
            card: exact,
            source: "yugipedia",
          };
        }
      } catch (err) {
        if (err.message === "Annulé par l'utilisateur") throw err;
        console.warn(`[CDB] Yugipedia échec pour "${localName}"`, err.message);
      }
    }

    return { status: "not_found" };
  }

  // ==========================================================================
  // RÉSOLUTION DE CARTE AVEC DONNÉES YUGIPEDIA PRÉ-CHARGÉES (batch)
  // ==========================================================================

  function resolveCardFromYugiCache(localName, localDesc, customMode, yugiCards) {
    const key = normalize(localName);
    if (!key) return { status: "not_found" };
    if (!yugiCards || !yugiCards.length) return { status: "not_found" };

    const exact = yugiCards.find((c) => normalize(c.name) === key)
               || yugiCards.find((c) => normalize(c._names?.en || "") === key)
               || yugiCards[0];

    const frName = exact._names?.fr || exact.name;
    const frDesc = exact._descs?.fr || exact.desc || localDesc;
    const enDesc = exact._descs?.en || "";

    if (customMode && enDesc && descDiffers(localDesc, enDesc)) {
      return {
        status: "translated",
        name: frName,
        desc: localDesc || "",
        modified: true,
        card: exact,
        source: "yugipedia",
      };
    }

    return {
      status: "translated",
      name: frName,
      desc: frDesc || localDesc || "",
      card: exact,
      source: "yugipedia",
    };
  }

  // ==========================================================================
  // CHARGEMENT FICHIER
  // ==========================================================================

  function bindDropZone() {
    if (!dom.drop) return;

    dom.drop.addEventListener("click", () => dom.fileInput.click());

    dom.drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      dom.drop.classList.add("dragover");
    });
    dom.drop.addEventListener("dragleave", () => {
      dom.drop.classList.remove("dragover");
    });
    dom.drop.addEventListener("drop", (e) => {
      e.preventDefault();
      dom.drop.classList.remove("dragover");
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
    });

    dom.fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) loadFile(file);
    });
  }

  async function loadFile(file) {
    if (state.running) {
      toast("Un traitement est en cours. Attends ou annule.", "err");
      return;
    }
    resetUI();
    setStatus("Lecture du fichier…");

    try {
      const SQL = await ensureSqlLoaded();
      const buffer = await file.arrayBuffer();
      state.file = file;
      state.sqlite = new SQL.Database(new Uint8Array(buffer));

      const tables = getTableNames(state.sqlite);
      if (!tables.includes("texts")) {
        throw new Error(
          "Ce fichier ne ressemble pas à un .cdb EDOPro (table `texts` manquante)."
        );
      }

      const total = countRows(state.sqlite, "texts");
      showFileInfo(file, total);
      dom.actions.classList.remove("hidden");
      setStatus("Prêt. Choisis l'action et clique sur « Lancer ».");
    } catch (err) {
      console.error("[CDB] Erreur chargement", err);
      setStatus(`❌ Erreur : ${err.message}`);
    }
  }

  function getTableNames(db) {
    const r = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    return r[0]?.values.flat() || [];
  }

  function countRows(db, table) {
    return db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0];
  }

  // ==========================================================================
  // SÉLECTEUR D'ACTION
  // ==========================================================================

  function getAction() {
    if (dom.actionJson && dom.actionJson.checked) return "json";
    return "translate";
  }

  function updateActionUI() {
    const action = getAction();
    const isJson = action === "json";

    if (dom.btnRun) {
      dom.btnRun.textContent = isJson ? "⚙️ Lancer" : "⚙️ Lancer";
    }

    if (dom.statDoneLbl) {
      dom.statDoneLbl.textContent = isJson ? "JSON générés" : "Traduites en FR";
    }
    if (dom.statMissingLbl) {
      dom.statMissingLbl.textContent = isJson ? "—" : "Pas de trad. FR";
    }

    if (dom.customMode) {
      dom.customMode.disabled = isJson;
      if (isJson) dom.customMode.checked = false;
      const wrap = dom.customMode.closest(".cdb-option");
      if (wrap) wrap.style.opacity = isJson ? "0.4" : "1";
    }
    if (dom.yugiMode) {
      dom.yugiMode.disabled = isJson;
      if (isJson) dom.yugiMode.checked = false;
      const wrap = dom.yugiMode.closest("#cdb-yugipedia-wrap");
      if (wrap) wrap.style.opacity = isJson ? "0.4" : "1";
    }

    if (dom.downloads) dom.downloads.classList.add("hidden");
    if (dom.stats) dom.stats.classList.add("hidden");
    if (dom.results) dom.results.innerHTML = "";
    if (dom.status) dom.status.textContent = "";
  }

  if (dom.actionTranslate) dom.actionTranslate.addEventListener("change", updateActionUI);
  if (dom.actionJson) dom.actionJson.addEventListener("change", updateActionUI);

  // ==========================================================================
  // DISPATCHER
  // ==========================================================================

  async function run() {
    const action = getAction();
    if (action === "json") {
      await runJsonGeneration();
    } else {
      await runTranslation();
    }
  }

  // ==========================================================================
  // ACTION 1 : TRADUIRE LE .CDB
  // ==========================================================================

  async function runTranslation() {
    if (!state.sqlite) {
      toast("Charge d'abord un fichier .cdb.", "err");
      return;
    }
    if (!window.memCacheFr || !window.memCacheEn) {
      toast(
        "La base locale n'est pas installée. Installe-la dans l'onglet Nom de carte.",
        "err"
      );
      return;
    }

    const customMode = dom.customMode ? dom.customMode.checked : false;
    const yugiMode = dom.yugiMode ? dom.yugiMode.checked : false;

    state.cancelled = false;
    state.running = true;
    state.missingNames = [];
    state.resolvedCards = [];
    if (window.resetYugipediaCancel) window.resetYugipediaCancel();

    dom.btnRun.disabled = true;
    dom.btnClear.disabled = true;
    dom.results.innerHTML = "";
    dom.stats.classList.add("hidden");
    dom.downloads.classList.add("hidden");
    dom.progressWrap.classList.add("visible");
    dom.yugiProgressWrap.classList.remove("visible");
    dom.btnCancelYugi.classList.add("hidden");
    dom.btnExportMissing.classList.add("hidden");
    setProgress(0, "Préparation de l'index…");

    try {
      buildNameIndexes();
      await nextFrame();

      setProgress(5, "Lecture du .cdb…");
      const rows = state.sqlite.exec("SELECT id, name, desc FROM texts")[0].values;
      const total = rows.length;

      const updates = [];
      const report = [];
      const reportIndex = new Map();
      const missingCards = [];
      let done = 0;
      let doneYugi = 0;
      let missing = 0;
      let modifiedCount = 0;

      for (let i = 0; i < rows.length; i++) {
        const [localId, localName, localDesc] = rows[i];

        // ⚡ Fallback tilde : nom EN entre ~...~ dans la desc
        let enNameFromTilde = null;
        if (localDesc) {
          const tildeMatch = localDesc.match(/~([^~]+)~/);
          if (tildeMatch && tildeMatch[1]) {
            enNameFromTilde = tildeMatch[1].trim();
          }
        }

        // 1er essai : nom local
        let resolved = await resolveCard(localName, localDesc, customMode, false);

        // 2e essai : nom tilde (si différent et 1er essai échoué)
        if (
          resolved.status === "not_found" &&
          enNameFromTilde &&
          normalize(enNameFromTilde) !== normalize(localName)
        ) {
          resolved = await resolveCard(enNameFromTilde, localDesc, customMode, false);
          if (resolved.status === "translated") {
            console.log(`[CDB] ✅ Trad. via ~nom~ : "${enNameFromTilde}"`);
          }
        }

        if (resolved.status === "translated") {
          updates.push({ id: localId, name: resolved.name, desc: resolved.desc });
          done++;
          if (resolved.modified) modifiedCount++;
          pushReport(report, reportIndex, {
            id: localId,
            name: resolved.name,
            status: "ok",
            modified: !!resolved.modified,
            source: resolved.source,
          });
        } else if (resolved.status === "en_only") {
          // ⚡ Bug fix : on envoie AUSSI les "en_only" au batch Yugipedia
          missing++;
          missingCards.push({
            id: localId,
            name: enNameFromTilde || localName,
            desc: localDesc,
          });
          pushReport(report, reportIndex, {
            id: localId,
            name: resolved.name,
            status: "warn",
          });
        } else {
          missing++;
          missingCards.push({
            id: localId,
            name: enNameFromTilde || localName,
            desc: localDesc,
          });
          pushReport(report, reportIndex, {
            id: localId,
            name: localName,
            status: "warn",
          });
        }

        if (i % YIELD_EVERY === 0 || i === rows.length - 1) {
          setProgress(
            5 + Math.round((i / total) * 60),
            `Analyse ${i.toLocaleString("fr-FR")} / ${total.toLocaleString("fr-FR")}…`
          );
          await nextFrame();
        }

        if (state.cancelled) break;
      }

      if (yugiMode && missingCards.length > 0 && !state.cancelled) {
        if (missingCards.length > YUGI_CONFIRM_THRESHOLD) {
          const estimatedSec = Math.ceil(missingCards.length / 50) + 2;
          const message =
            `⚠️ ${missingCards.length} cartes introuvables localement.\n\n` +
            `Interroger Yugipedia (batch de 50) prendra ~${estimatedSec} seconde(s).\n\n` +
            `Continuer ?`;
          const ok = window.showConfirm
            ? await window.showConfirm(message, "Fallback Yugipedia")
            : confirm(message);
          if (!ok) {
            console.log("[CDB] Fallback Yugipedia annulé par l'utilisateur");
            missingCards.length = 0;
          }
        }

        if (missingCards.length > 0) {
          dom.yugiProgressWrap.classList.add("visible");
          dom.btnCancelYugi.classList.remove("hidden");
          setYugiProgress(0, `Enrichissement Yugipedia (batch)…`);

          const totalMissing = missingCards.length;
          const uniqueNames = [...new Set(missingCards.map((c) => c.name))];
          console.log(`[CDB] ⚡ BATCH : ${uniqueNames.length} noms uniques pour ${missingCards.length} cartes`);

          let batchResults;
          try {
            batchResults = await window.yugipediaSearchBatch(uniqueNames);
          } catch (err) {
            console.error("[CDB] Erreur batch", err);
            batchResults = new Map();
          }

          let yugiResolved = 0;

          for (let i = 0; i < missingCards.length; i++) {
            if (state.cancelled) break;

            const card = missingCards[i];
            const yugiCards = batchResults.get(card.name) || [];

            if (yugiCards.length > 0) {
              const resolved = resolveCardFromYugiCache(
                card.name, card.desc, customMode, yugiCards
              );

              if (resolved.status === "translated") {
                updates.push({ id: card.id, name: resolved.name, desc: resolved.desc });
                done++;
                doneYugi++;
                missing--;                          // ← BUG FIX compteur
                if (resolved.modified) modifiedCount++;

                updateReport(reportIndex, card.id, {
                  name: resolved.name,
                  status: "ok",
                  source: "yugipedia",
                  modified: !!resolved.modified,
                });

                yugiResolved++;
              } else {
                state.missingNames.push(card.name);
              }
            } else {
              state.missingNames.push(card.name);
            }

            const pct = Math.round(((i + 1) / totalMissing) * 100);
            setYugiProgress(
              pct,
              `Yugipedia ${i + 1} / ${totalMissing}… (${yugiResolved} OK)`
            );
          }

          dom.btnCancelYugi.classList.add("hidden");
        }
      }

      if (state.cancelled) {
        applyUpdates(state.sqlite, updates);
        state.patched = state.sqlite.export();
        renderResults(report, { total, done, missing, modifiedCount, doneYugi });
        dom.downloads.classList.remove("hidden");
        showTranslateDownloadsOnly();
        if (state.missingNames.length > 0) {
          dom.btnExportMissing.classList.remove("hidden");
        }
        toast("Traduction interrompue", "info");
        return;
      }

      setProgress(88, "Application des traductions…");
      applyUpdates(state.sqlite, updates);

      setProgress(96, "Génération du fichier…");
      state.patched = state.sqlite.export();

      setProgress(100, "Terminé !");
      renderResults(report, { total, done, missing, modifiedCount, doneYugi });
      dom.downloads.classList.remove("hidden");
      showTranslateDownloadsOnly();
      if (state.missingNames.length > 0) {
        dom.btnExportMissing.classList.remove("hidden");
      }

      const parts = [];
      if (customMode && modifiedCount > 0) parts.push(`${modifiedCount} effet(s) modifié(s)`);
      if (doneYugi > 0) parts.push(`${doneYugi} via Yugipedia`);
      const suffix = parts.length ? ` · ${parts.join(" · ")}` : "";

      setStatus(
        `✅ Terminé : ${done.toLocaleString("fr-FR")} / ${total.toLocaleString("fr-FR")} carte(s) traduite(s)${suffix}.`
      );
      toast("Traduction terminée !", "ok");
    } catch (err) {
      console.error("[CDB] Erreur traduction", err);
      setStatus(`❌ Erreur : ${err.message}`);
    } finally {
      state.running = false;
      dom.btnRun.disabled = false;
      dom.btnClear.disabled = false;
      dom.btnCancelYugi.classList.add("hidden");
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

  // ==========================================================================
  // ACTION 2 : GÉNÉRER LES JSON — Recherche multi-fallback OPTIMISÉE
  // ==========================================================================
  // Structure en 3 passes :
  //   PASSE 1   : Recherche locale (FR/EN) + tilde → rapide, pas d'API
  //   PASSE 1.5 : BATCH Yugipedia (1 requête pour 50 titres)
  //   PASSE 2   : Génération des JSON + CSV
  // ==========================================================================

  async function runJsonGeneration() {
    if (!state.sqlite) {
      toast("Charge d'abord un fichier .cdb.", "err");
      return;
    }

    state.cancelled = false;
    state.running = true;
    state.missingNames = [];
    state.resolvedCards = [];
    state.generatedFiles = [];
    state.generatedCards = [];

    dom.btnRun.disabled = true;
    dom.btnClear.disabled = true;
    dom.results.innerHTML = "";
    dom.stats.classList.add("hidden");
    dom.downloads.classList.add("hidden");
    dom.progressWrap.classList.add("visible");
    dom.yugiProgressWrap.classList.remove("visible");
    dom.btnCancelYugi.classList.add("hidden");
    dom.btnExportMissing.classList.add("hidden");
    setProgress(0, "Préparation de l'index…");
    if (window.resetYugipediaCancel) window.resetYugipediaCancel();

    try {
      // ⚡ Construit les index FR/EN depuis la base locale
      if (window.memCacheFr && window.memCacheEn) {
        buildNameIndexes();
      }
      await nextFrame();

      setProgress(5, "Lecture du .cdb…");

      // ⚡ Jointure entre texts et datas pour récupérer TOUTES les infos
      const rows = state.sqlite.exec(`
        SELECT 
          t.id AS id,
          t.name AS name,
          t.desc AS desc,
          d.type AS type,
          d.atk AS atk,
          d.def AS def,
          d.level AS level,
          d.race AS race,
          d.attribute AS attribute
        FROM texts t
        LEFT JOIN datas d ON t.id = d.id
      `)[0].values;
      const total = rows.length;

      const report = [];
      const reportIndex = new Map();
      let done = 0;
      let foundLocal = 0;
      let foundTilde = 0;
      let foundYugi = 0;
      let foundCdb = 0;

      // ⚡ File d'attente pour le batch Yugipedia (AUCUN appel ici)
      const pendingYugi = [];

      // ======================================================================
      // PASSE 1 : Recherche locale (FR/EN) + fallback tilde ~nom~
      //           Les non-trouvées sont mises en attente pour le batch
      // ======================================================================
      for (let i = 0; i < rows.length; i++) {
        const [
          localId, localName, localDesc,
          dbType, dbAtk, dbDef, dbLevel, dbRace, dbAttribute
        ] = rows[i];

        // ⚡ 1. Recherche par nom dans la base locale (FR puis EN)
        const key = normalize(localName);
        let matched = null;
        let matchedSource = null;

        if (state.nameIndexFr || state.nameIndexEn) {
          const frMatch = state.nameIndexFr ? state.nameIndexFr.get(key) : null;
          const enMatch = state.nameIndexEn ? state.nameIndexEn.get(key) : null;
          matched = frMatch || enMatch;
          if (matched) matchedSource = "local";
        }

        // ⚡ 2. Fallback : nom EN entre ~...~ dans la desc
        let enNameFromTilde = null;
        if (!matched && localDesc) {
          const tildeMatch = localDesc.match(/~([^~]+)~/);
          if (tildeMatch && tildeMatch[1]) {
            enNameFromTilde = tildeMatch[1].trim();
            const enKey = normalize(enNameFromTilde);
            const enMatch2 = state.nameIndexEn ? state.nameIndexEn.get(enKey) : null;
            const frMatch2 = state.nameIndexFr ? state.nameIndexFr.get(enKey) : null;
            matched = frMatch2 || enMatch2;
            if (matched) {
              matchedSource = "tilde";
              console.log(`[CDB] ✅ Trouvé via ~nom~ : "${enNameFromTilde}"`);
            }
          }
        }

        // ⚡ Construire la carte (par défaut = infos du .cdb)
        let card;
        if (matched) {
          card = {
            ...matched,
            name: localName,
            desc: localDesc,
          };
          if (matchedSource === "local") foundLocal++;
          else if (matchedSource === "tilde") foundTilde++;
        } else {
          const frameType = detectFrameType(dbType);
          const isSpell = (dbType & 0x2) !== 0;
          const isTrap  = (dbType & 0x4) !== 0;

          card = {
            id: localId,
            name: localName,
            desc: localDesc,
            type: isSpell ? "Spell Card" : isTrap ? "Trap Card" : "Effect Monster",
            frameType: frameType,
            atk: dbAtk ?? 0,
            def: dbDef ?? 0,
            level: dbLevel ?? 0,
            race: raceFromCode(dbRace),
            attribute: attributeFromCode(dbAttribute),
            card_images: [{
              image_url: `https://images.ygoprodeck.com/images/cards/${localId}.jpg`,
              image_url_cropped: `https://images.ygoprodeck.com/images/cards_cropped/${localId}.jpg`,
            }],
          };
          foundCdb++;

          // ⚡ 3. Si Yugipedia activé → enregistrer pour le BATCH (pas d'appel HTTP)
          if (window.YugipediaAPI && window.YugipediaAPI.isYugipediaEnabled()) {
            const searchQuery = enNameFromTilde || localName;
            if (searchQuery && searchQuery.length >= 3) {
              pendingYugi.push({
                index: state.resolvedCards.length,  // index futur dans resolvedCards
                searchQuery,
                localId,
                localName,
                localDesc,
              });
            }
          }
        }

        state.resolvedCards.push({
          localId,
          name: localName,
          desc: localDesc,
          card: card,
          source: matchedSource || "cdb",
        });
        done++;
        pushReport(report, reportIndex, {
          id: localId,
          name: localName,
          status: "ok",
          source: matchedSource || "cdb",
        });

        if (i % YIELD_EVERY === 0 || i === rows.length - 1) {
          setProgress(
            5 + Math.round((i / total) * 60),
            `Analyse ${i.toLocaleString("fr-FR")} / ${total.toLocaleString("fr-FR")}…`
          );
          await nextFrame();
        }

        if (state.cancelled) break;
      }

      console.log(`[CDB] JSON passe 1 : ${foundLocal} locales, ${foundTilde} via ~nom~, ${foundCdb} via .cdb seul · ${pendingYugi.length} à chercher sur Yugipedia`);

      // ======================================================================
      // PASSE 1.5 : BATCH YUGIPEDIA (1 requête pour 50 titres)
      // ======================================================================
      if (pendingYugi.length > 0 && !state.cancelled) {
        const uniqueQueries = [...new Set(pendingYugi.map((p) => p.searchQuery))];
        console.log(`[CDB] ⚡ BATCH Yugipedia : ${uniqueQueries.length} noms uniques pour ${pendingYugi.length} cartes`);

        dom.yugiProgressWrap.classList.add("visible");
        dom.btnCancelYugi.classList.remove("hidden");
        setYugiProgress(0, `Yugipedia batch (${uniqueQueries.length} noms)…`);

        let batchResults;
        try {
          batchResults = await window.yugipediaSearchBatch(uniqueQueries);
        } catch (err) {
          console.error("[CDB] Erreur batch", err);
          batchResults = new Map();
        }

        let yugiResolved = 0;

        for (let j = 0; j < pendingYugi.length; j++) {
          if (state.cancelled) break;

          const p = pendingYugi[j];
          const yugiCards = batchResults.get(p.searchQuery) || [];

          if (yugiCards.length > 0) {
            const exact = yugiCards.find((c) =>
              normalize(c._names?.en || "") === normalize(p.searchQuery)
            ) || yugiCards.find((c) =>
              normalize(c.name) === normalize(p.searchQuery)
            ) || yugiCards[0];

            if (exact) {
              const item = state.resolvedCards[p.index];
              // On remplace les infos de base par celles de Yugipedia,
              // mais on garde nom + desc du .cdb (effet original)
              item.card = {
                ...item.card,
                ...exact,
                id: exact.id || p.localId,
                name: p.localName,
                desc: p.localDesc,
                card_images: exact.card_images || item.card.card_images,
              };
              item.source = "yugipedia";

              foundYugi++;
              if (foundCdb > 0) foundCdb--;  // Retire du compteur ".cdb seul"
              yugiResolved++;

              updateReport(reportIndex, p.localId, { source: "yugipedia" });
            }
          }

          if (j % 50 === 0 || j === pendingYugi.length - 1) {
            const pct = Math.round(((j + 1) / pendingYugi.length) * 100);
            setYugiProgress(
              pct,
              `Yugipedia ${j + 1} / ${pendingYugi.length}… (${yugiResolved} OK)`
            );
            await nextFrame();
          }
        }

        dom.btnCancelYugi.classList.add("hidden");
        dom.yugiProgressWrap.classList.remove("visible");
        console.log(`[CDB] JSON passe 1.5 : ${yugiResolved} cartes enrichies via Yugipedia (batch)`);
      }

      // ⚡ BUG FIX : sortir AVANT la phase 2 si annulation demandée
      if (state.cancelled) {
        console.warn("[CDB] Génération JSON annulée par l'utilisateur");
        setStatus("⚠️ Génération interrompue.");
        toast("Génération interrompue", "info");
        return;
      }

      // ======================================================================
      // PASSE 2 : Génération des JSON + CSV
      // ======================================================================
      setProgress(80, "Génération des JSON…");

      const totalResolved = state.resolvedCards.length;
      if (totalResolved === 0) {
        setStatus("❌ Aucune carte à convertir.");
        toast("Aucune carte à convertir.", "err");
        return;
      }

      for (let i = 0; i < totalResolved; i++) {
        if (state.cancelled) break;

        const item = state.resolvedCards[i];

        const mergedCard = {
          ...item.card,
          name: item.name,
          desc: item.desc,
        };

        try {
          const json = await window.generateJsonForCard(mergedCard, item.name);
          state.generatedFiles.push({
            filename: `${window.sanitizeFilename(item.name)}.json`,
            json: JSON.stringify(json, null, 2),
          });
          state.generatedCards.push(mergedCard);
        } catch (err) {
          console.error(`[CDB] Erreur génération JSON pour "${item.name}"`, err);
        }

        if (i % 100 === 0 || i === totalResolved - 1) {
          setProgress(
            80 + Math.round(((i + 1) / totalResolved) * 18),
            `JSON ${i + 1} / ${totalResolved}…`
          );
          await nextFrame();
        }
      }

      setProgress(100, "Terminé !");
      renderResults(report, { total, done, missing: 0, modifiedCount: 0, doneYugi: 0 });
      dom.downloads.classList.remove("hidden");
      showJsonDownloadsOnly();

      setStatus(
        `✅ Terminé : ${state.generatedFiles.length.toLocaleString("fr-FR")} JSON généré(s) sur ${total.toLocaleString("fr-FR")} carte(s) · ${foundLocal} locales, ${foundTilde} via ~nom~, ${foundYugi} Yugipedia, ${foundCdb} .cdb seul.`
      );
      toast(`${state.generatedFiles.length} JSON générés !`, "ok");
    } catch (err) {
      console.error("[CDB] Erreur génération JSON", err);
      setStatus(`❌ Erreur : ${err.message}`);
    } finally {
      state.running = false;
      dom.btnRun.disabled = false;
      dom.btnClear.disabled = false;
      dom.btnCancelYugi.classList.add("hidden");
    }
  }

  // ==========================================================================
  // ⚡ HELPERS — Décodage des codes numériques du .cdb
  // ==========================================================================

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
    const RACES = {
      0x1: "Warrior", 0x2: "Spellcaster", 0x4: "Fairy", 0x8: "Fiend",
      0x10: "Zombie", 0x20: "Machine", 0x40: "Aqua", 0x80: "Pyro",
      0x100: "Rock", 0x200: "Winged Beast", 0x400: "Plant", 0x800: "Insect",
      0x1000: "Thunder", 0x2000: "Dragon", 0x4000: "Beast",
      0x8000: "Beast-Warrior", 0x10000: "Dinosaur", 0x20000: "Fish",
      0x40000: "Sea Serpent", 0x80000: "Reptile", 0x100000: "Psychic",
      0x200000: "Divine-Beast", 0x400000: "Creator God", 0x800000: "Wyrm",
      0x1000000: "Cyberse",
    };
    for (const [bit, name] of Object.entries(RACES)) {
      if (code & parseInt(bit)) return name;
    }
    return "Warrior";
  }

  function attributeFromCode(code) {
    if (!code) return "DARK";
    const ATTRS = {
      0x1: "EARTH", 0x2: "WATER", 0x4: "FIRE",
      0x8: "WIND", 0x10: "LIGHT", 0x20: "DARK", 0x40: "DIVINE",
    };
    for (const [bit, name] of Object.entries(ATTRS)) {
      if (code & parseInt(bit)) return name;
    }
    return "DARK";
  }

  // ==========================================================================
  // RAPPORT
  // ==========================================================================

  function pushReport(report, reportIndex, entry) {
    if (report.length < MAX_REPORT_LINES) {
      report.push(entry);
      reportIndex.set(entry.id, entry);
    }
  }

  function updateReport(reportIndex, id, updates) {
    const item = reportIndex.get(id);
    if (item) Object.assign(item, updates);
  }

  function nextFrame() {
    return new Promise((r) => setTimeout(r, 0));
  }

  // ==========================================================================
  // APPLICATION SQL
  // ==========================================================================

  function applyUpdates(db, updates) {
    if (!updates.length) return;

    const columns = getColumns(db, "texts");
    const hasDesc = columns.includes("desc");

    const setClauses = hasDesc ? ["name = ?", "desc = ?"] : ["name = ?"];

    const stmt = db.prepare(
      `UPDATE texts SET ${setClauses.join(", ")} WHERE id = ?`
    );

    db.run("BEGIN TRANSACTION");
    try {
      for (const u of updates) {
        const name = String(u.name ?? "");
        const desc = String(u.desc ?? "");
        const id = parseInt(u.id, 10);

        if (isNaN(id)) {
          console.warn("[CDB] id invalide, skip:", u.id);
          continue;
        }

        const params = hasDesc ? [name, desc, id] : [name, id];
        stmt.run(params);
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    } finally {
      stmt.free();
    }
  }

  function getColumns(db, table) {
    return db.exec(`PRAGMA table_info(${table})`)[0].values.map((r) => r[1]);
  }

  // ==========================================================================
  // TÉLÉCHARGEMENT
  // ==========================================================================

  function downloadPatched() {
    if (!state.patched || !state.file) return;
    const baseName = state.file.name.replace(/\.cdb$/i, "");
    const blob = new Blob([state.patched], { type: "application/octet-stream" });
    triggerDownload(blob, `${baseName}_fr.cdb`);
    toast("Fichier .cdb téléchargé", "ok");
  }

  async function downloadJsonZip() {
    if (!state.generatedFiles.length) {
      toast("Aucun JSON à télécharger.", "err");
      return;
    }
    if (typeof JSZip === "undefined") {
      toast("JSZip non chargé.", "err");
      return;
    }
    await window.downloadAsZip(state.generatedFiles);
    toast(`${state.generatedFiles.length} JSON zippés !`, "ok");
  }

  function downloadCsv() {
    if (!state.generatedCards.length) {
      toast("Aucune carte pour le CSV.", "err");
      return;
    }
    window.downloadManagerCsv(state.generatedCards);
    toast("CSV Manager téléchargé", "ok");
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ==========================================================================
  // EXPORT DES CARTES NON TROUVÉES
  // ==========================================================================

  function exportMissing() {
    if (!state.missingNames.length) {
      toast("Aucune carte non trouvée à exporter.", "info");
      return;
    }
    const header =
      `# Cartes non trouvées — ${new Date().toLocaleString("fr-FR")}\n` +
      `# ${state.missingNames.length} carte(s)\n` +
      `# Source : ${state.file ? state.file.name : "inconnu"}\n\n`;
    const content = header + state.missingNames.join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const baseName = state.file ? state.file.name.replace(/\.cdb$/i, "") : "cdb";
    triggerDownload(blob, `${baseName}_non_trouvees.txt`);
    toast(`${state.missingNames.length} carte(s) exportée(s)`, "ok");
  }

  // ==========================================================================
  // UI
  // ==========================================================================

  function showFileInfo(file, total) {
    dom.info.classList.remove("hidden");
    dom.info.innerHTML = `
      <strong>📦 ${escapeHtml(file.name)}</strong><br>
      ${(file.size / 1024).toFixed(1)} Ko · ${total.toLocaleString("fr-FR")} entrées dans la table <code>texts</code>
    `;
  }

  function renderResults(report, stats) {
    dom.statTotal.textContent = stats.total.toLocaleString("fr-FR");
    dom.statDone.textContent = stats.done.toLocaleString("fr-FR");
    dom.statMissing.textContent = stats.missing.toLocaleString("fr-FR");
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

  function setStatus(text) {
    dom.status.textContent = text;
  }

  function resetUI() {
    if (state.running) return;

    state.file = null;
    state.sqlite = null;
    state.patched = null;
    state.missingNames = [];
    state.cancelled = false;
    state.resolvedCards = [];
    state.generatedFiles = [];
    state.generatedCards = [];

    dom.fileInput.value = "";
    dom.info.classList.add("hidden");
    dom.actions.classList.add("hidden");
    dom.stats.classList.add("hidden");
    dom.results.innerHTML = "";
    dom.downloads.classList.add("hidden");
    dom.progressWrap.classList.remove("visible");
    dom.yugiProgressWrap.classList.remove("visible");
    dom.btnCancelYugi.classList.add("hidden");
    dom.btnExportMissing.classList.add("hidden");
    setStatus("");
  }

  // ==========================================================================
  // UTILITAIRES
  // ==========================================================================

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ==========================================================================
  // BINDINGS
  // ==========================================================================

  function bindEvents() {
    bindDropZone();

    if (dom.btnRun) dom.btnRun.addEventListener("click", run);
    if (dom.btnClear) dom.btnClear.addEventListener("click", resetUI);
    if (dom.btnDownloadCdb) dom.btnDownloadCdb.addEventListener("click", downloadPatched);
    if (dom.btnDownloadZip) dom.btnDownloadZip.addEventListener("click", downloadJsonZip);
    if (dom.btnDownloadCsv) dom.btnDownloadCsv.addEventListener("click", downloadCsv);

    if (dom.btnCancelYugi) {
      dom.btnCancelYugi.addEventListener("click", () => {
        state.cancelled = true;
        if (window.cancelYugipedia) window.cancelYugipedia();
        toast("Annulation en cours…", "info");
      });
    }

    if (dom.btnExportMissing) {
      dom.btnExportMissing.addEventListener("click", exportMissing);
    }

    updateActionUI();
  }

  bindEvents();
})();
