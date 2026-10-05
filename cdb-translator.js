// ============================================================================
// CDB TRANSLATOR — Traduire OU convertir un .cdb EDOPro/YGO Pro (par nom)
// ============================================================================
// Les .cdb custom (VAACT, Project Ignis, fan-made) utilisent des IDs locaux
// qui n'ont rien à voir avec les passcodes Konami. On croise donc par NOM.
//
// Deux actions supportées :
//   - "Traduire" : remplace noms + effets par leur VF. Sortie : .cdb_fr
//   - "JSON"     : génère un JSON par carte (ZIP) + CSV Manager.
//                  ⚡ SANS recherche : on prend DIRECTEMENT les infos du .cdb
//                  (id, name, desc). Pas de croisement avec la base locale.
//
// Mode VAACT (option, traduction uniquement) :
//   Si l'effet du .cdb ≠ effet officiel EN → l'effet a été modifié par VAACT.
//   On garde alors l'effet original (anglais VAACT) puis on ajoute en dessous
//   l'effet officiel FR, préfixé de "(VAACT) ".
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
    // ⚡ Pour l'action JSON
    resolvedCards: [],   // { localId, name, desc, card }
    generatedFiles: [],  // { filename, json }
    generatedCards: [],  // pour le CSV Manager
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

    // Actions (radios)
    actionTranslate: $("cdb-action-translate"),
    actionJson:      $("cdb-action-json"),

    // Options
    vaactMode:    $("cdb-vaact-mode"),
    yugiMode:     $("cdb-yugipedia-mode"),

    // Progression
    progressWrap: $("cdb-progress-wrap"),
    progressLbl:  $("cdb-progress-label"),
    progressPct:  $("cdb-progress-pct"),
    progressFill: $("cdb-progress-fill"),
    status:       $("cdb-status"),

    // Stats
    stats:        $("cdb-stats"),
    statTotal:    $("cdb-stat-total"),
    statDone:     $("cdb-stat-translated"),
    statMissing:  $("cdb-stat-missing"),
    statDoneLbl:  $("cdb-stat-translated-label"),
    statMissingLbl: $("cdb-stat-missing-label"),

    // Résultats
    results:      $("cdb-results"),

    // Téléchargements
    downloads:    $("cdb-downloads"),
    btnDownloadCdb: $("cdb-download"),
    btnDownloadZip: $("cdb-download-zip"),
    btnDownloadCsv: $("cdb-download-csv"),
    btnExportMissing: $("cdb-export-missing"),

    // Barre Yugipedia
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
  // COMPARAISON D'EFFETS (VAACT) — ⚡ STRICTE ⚡
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

  async function resolveCard(localName, localDesc, vaactMode, allowYugipedia) {
    const key = normalize(localName);
    if (!key) return { status: "not_found" };

    // 1. Nom déjà FR officiel en base locale
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

    // 2. Nom EN officiel en base locale
    const enMatch = state.nameIndexEn.get(key);
    if (enMatch) {
      // 2a. Chercher la VF via l'ID Konami dans memCacheFr
      const frById = window.memCacheFr.get(String(enMatch.id));
      if (frById) {
        const modified = vaactMode && descDiffers(localDesc, enMatch.desc);
        if (modified) {
          return {
            status: "translated",
            name: frById.name,
            desc: `(VAACT) ${localDesc || ""}\n\n${frById.desc || ""}`,
            vaact: true,
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

      // 2b. Pas de VF en base → essayer Yugipedia
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
              const modified = vaactMode && descDiffers(localDesc, enMatch.desc);
              if (modified) {
                return {
                  status: "translated",
                  name: frName,
                  desc: `(VAACT) ${localDesc || ""}\n\n${frDesc || enMatch.desc || ""}`,
                  vaact: true,
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

      // 2c. Pas de VF trouvée → garder l'anglais
      return {
        status: "en_only",
        name: enMatch.name,
        desc: enMatch.desc || localDesc || "",
        card: enMatch,
        source: "local",
      };
    }

    // 3. Carte pas trouvée en base → essayer Yugipedia
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

          const modified = vaactMode && enDesc && descDiffers(localDesc, enDesc);

          if (modified) {
            return {
              status: "translated",
              name: frName,
              desc: `(VAACT) ${localDesc || ""}\n\n${frDesc || ""}`,
              vaact: true,
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

  function resolveCardFromYugiCache(localName, localDesc, vaactMode, yugiCards) {
    const key = normalize(localName);
    if (!key) return { status: "not_found" };
    if (!yugiCards || !yugiCards.length) return { status: "not_found" };

    const exact = yugiCards.find((c) => normalize(c.name) === key)
               || yugiCards.find((c) => normalize(c._names?.en || "") === key)
               || yugiCards[0];

    const frName = exact._names?.fr || exact.name;
    const frDesc = exact._descs?.fr || exact.desc || localDesc;
    const enDesc = exact._descs?.en || "";

    const modified = vaactMode && enDesc && descDiffers(localDesc, enDesc);

    if (modified) {
      return {
        status: "translated",
        name: frName,
        desc: `(VAACT) ${localDesc || ""}\n\n${frDesc || ""}`,
        vaact: true,
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
    return "translate"; // par défaut
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

    // ⚡ Désactiver VAACT + Yugipedia en mode JSON
    if (dom.vaactMode) {
      dom.vaactMode.disabled = isJson;
      if (isJson) dom.vaactMode.checked = false;
      const wrap = dom.vaactMode.closest(".cdb-option");
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
  // ACTION 1 : TRADUIRE LE .CDB (inchangé)
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

    const vaactMode = dom.vaactMode ? dom.vaactMode.checked : false;
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
      let vaactCount = 0;

      // PHASE 1 : Analyse locale
      for (let i = 0; i < rows.length; i++) {
        const [localId, localName, localDesc] = rows[i];

        const resolved = await resolveCard(localName, localDesc, vaactMode, false);

        if (resolved.status === "translated") {
          updates.push({ id: localId, name: resolved.name, desc: resolved.desc });
          done++;
          if (resolved.vaact) vaactCount++;
          pushReport(report, reportIndex, {
            id: localId,
            name: resolved.name,
            status: "ok",
            vaact: !!resolved.vaact,
            source: resolved.source,
          });
        } else if (resolved.status === "en_only") {
          missing++;
          pushReport(report, reportIndex, {
            id: localId,
            name: resolved.name,
            status: "warn",
          });
        } else {
          missing++;
          missingCards.push({ id: localId, name: localName, desc: localDesc });
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

      // PHASE 2 : BATCH Yugipedia
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
                card.name, card.desc, vaactMode, yugiCards
              );

              if (resolved.status === "translated") {
                updates.push({ id: card.id, name: resolved.name, desc: resolved.desc });
                done++;
                doneYugi++;
                if (resolved.vaact) vaactCount++;

                updateReport(reportIndex, card.id, {
                  name: resolved.name,
                  status: "ok",
                  source: "yugipedia",
                  vaact: !!resolved.vaact,
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
        renderResults(report, { total, done, missing, vaactCount, doneYugi });
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
      renderResults(report, { total, done, missing, vaactCount, doneYugi });
      dom.downloads.classList.remove("hidden");
      showTranslateDownloadsOnly();
      if (state.missingNames.length > 0) {
        dom.btnExportMissing.classList.remove("hidden");
      }

      const parts = [];
      if (vaactMode && vaactCount > 0) parts.push(`${vaactCount} VAACT`);
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
  // ACTION 2 : GÉNÉRER LES JSON — ⚡ DIRECTEMENT depuis le .cdb
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
    setProgress(0, "Lecture du .cdb…");

    try {
      await nextFrame();

      setProgress(5, "Lecture du .cdb…");
      const rows = state.sqlite.exec("SELECT id, name, desc FROM texts")[0].values;
      const total = rows.length;

      const report = [];
      const reportIndex = new Map();
      let done = 0;

      // ======================================================================
      // PHASE 1 : On prend DIRECTEMENT les infos du .cdb (pas de recherche)
      // ======================================================================
      for (let i = 0; i < rows.length; i++) {
        const [localId, localName, localDesc] = rows[i];

        state.resolvedCards.push({
          localId,
          name: localName,
          desc: localDesc,
          // Carte minimale construite à partir des infos du CDB
          card: {
            id: localId,
            name: localName,
            desc: localDesc,
            type: "Effect Monster",
            frameType: "effect",
            atk: 0,
            def: 0,
            level: 0,
            race: "Warrior",
            attribute: "DARK",
            card_images: [],
            _minimal: true,
          },
          source: "cdb",
        });
        done++;
        pushReport(report, reportIndex, {
          id: localId,
          name: localName,
          status: "ok",
          source: "cdb",
        });

        if (i % YIELD_EVERY === 0 || i === rows.length - 1) {
          setProgress(
            5 + Math.round((i / total) * 70),
            `Lecture ${i.toLocaleString("fr-FR")} / ${total.toLocaleString("fr-FR")}…`
          );
          await nextFrame();
        }

        if (state.cancelled) break;
      }

      // ======================================================================
      // PHASE 2 : Génération des JSON + CSV
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
      renderResults(report, { total, done, missing: 0, vaactCount: 0, doneYugi: 0 });
      dom.downloads.classList.remove("hidden");
      showJsonDownloadsOnly();

      setStatus(
        `✅ Terminé : ${state.generatedFiles.length.toLocaleString("fr-FR")} JSON généré(s) sur ${total.toLocaleString("fr-FR")} carte(s).`
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

  function buildResultItem(r) {
    const li = document.createElement("li");
    li.className = "gen-item";
    const isOk = r.status === "ok";
    const icon = isOk ? "✅" : "⚠️";

    let badgeText, badgeClass;
    if (isOk && r.vaact) {
      badgeText = "Traduit (VAACT)";
      badgeClass = "info";
    } else if (isOk && r.source === "yugipedia") {
      badgeText = "🟣 Yugipedia";
      badgeClass = "yugi";
    } else if (isOk) {
      badgeText = "Traduit";
      badgeClass = "ok";
    } else {
      badgeText = "Pas de trad.";
      badgeClass = "warn";
    }

    li.innerHTML = `
      <span>${icon}</span>
      <span class="name">${escapeHtml(r.name)}</span>
      <span class="badge ${badgeClass}">${badgeText}</span>
    `;
    return li;
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
