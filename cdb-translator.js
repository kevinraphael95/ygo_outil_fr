// ============================================================================
// CDB TRANSLATOR — Traduire un fichier .cdb EDOPro/YGO Pro (par nom)
// ============================================================================
// Les .cdb custom (VAACT, Project Ignis, fan-made) utilisent des IDs locaux
// qui n'ont rien à voir avec les passcodes Konami. On croise donc par NOM.
//
// Mode VAACT (option) :
//   Si l'effet du .cdb ≠ effet officiel EN → l'effet a été modifié par VAACT.
//   On garde alors l'effet original (anglais VAACT) puis on ajoute en dessous
//   l'effet officiel FR, préfixé de "(VAACT) ".
// ============================================================================

(() => {
  "use strict";

  // ==========================================================================
  // CONSTANTES
  // ==========================================================================

  const SQL_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3";
  const MAX_REPORT_LINES = 250;
  const YIELD_EVERY = 200;

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
    btnTranslate: $("cdb-translate"),
    btnClear:     $("cdb-clear"),
    btnDownload:  $("cdb-download"),
    vaactMode:    $("cdb-vaact-mode"),
    progressWrap: $("cdb-progress-wrap"),
    progressLbl:  $("cdb-progress-label"),
    progressPct:  $("cdb-progress-pct"),
    progressFill: $("cdb-progress-fill"),
    status:       $("cdb-status"),
    stats:        $("cdb-stats"),
    statTotal:    $("cdb-stat-total"),
    statDone:     $("cdb-stat-translated"),
    statMissing:  $("cdb-stat-missing"),
    results:      $("cdb-results"),
    downloads:    $("cdb-downloads"),
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

  /**
   * Compare deux textes d'effet en ignorant espaces/retours à la ligne.
   * Retourne true si différents (= modifié par VAACT).
   */
  function descDiffers(a, b) {
    const clean = (s) =>
      String(s || "")
        .replace(/\r\n/g, "\n")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    return clean(a) !== clean(b);
  }

  /**
   * Pour une carte du .cdb, essaie de trouver la version FR.
   * Retourne :
   *   { status: "translated", name, desc, vaact? }
   *   { status: "en_only",   name, desc }
   *   { status: "not_found" }
   */
  function resolveCard(localName, localDesc, vaactMode) {
    const key = normalize(localName);
    if (!key) return { status: "not_found" };

    // 1. Nom déjà FR officiel
    const frMatch = state.nameIndexFr.get(key);
    if (frMatch) {
      return {
        status: "translated",
        name: frMatch.name,
        desc: frMatch.desc || "",
      };
    }

    // 2. Nom EN officiel → chercher la version FR via l'id Konami
    const enMatch = state.nameIndexEn.get(key);
    if (enMatch) {
      const frById = window.memCacheFr.get(String(enMatch.id));
      if (frById) {
        // Détection modif VAACT : l'effet du cdb diffère-t-il de l'effet EN officiel ?
        const modified = vaactMode && descDiffers(localDesc, enMatch.desc);

        if (modified) {
          return {
            status: "translated",
            name: frById.name,
            desc: `(VAACT) ${localDesc || ""}\n\n${frById.desc || ""}`,
            vaact: true,
          };
        }
        return {
          status: "translated",
          name: frById.name,
          desc: frById.desc || "",
        };
      }
      // Pas de trad FR → garder l'EN
      return {
        status: "en_only",
        name: enMatch.name,
        desc: enMatch.desc || localDesc || "",
      };
    }

    // 3. Carte custom inconnue
    return { status: "not_found" };
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
      setStatus("Prêt. Clique sur « Traduire en français ».");
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
  // TRADUCTION
  // ==========================================================================

  async function translate() {
    if (!state.sqlite) {
      toast("Charge d'abord un fichier .cdb.", "err");
      return;
    }
    if (!window.memCacheFr || !window.memCacheEn) {
      toast(
        "La base locale n'est pas installée. Installe-la dans l'onglet Recherche.",
        "err"
      );
      return;
    }

    const vaactMode = dom.vaactMode ? dom.vaactMode.checked : false;

    dom.btnTranslate.disabled = true;
    dom.results.innerHTML = "";
    dom.stats.classList.add("hidden");
    dom.downloads.classList.add("hidden");
    dom.progressWrap.classList.add("visible");
    setProgress(0, "Préparation de l'index…");

    try {
      buildNameIndexes();
      await nextFrame();

      setProgress(5, "Lecture du .cdb…");
      const rows = state.sqlite.exec(
        "SELECT id, name, desc FROM texts"
      )[0].values;
      const total = rows.length;

      const updates = [];
      const report = [];
      let done = 0;
      let missing = 0;
      let vaactCount = 0;

      for (let i = 0; i < rows.length; i++) {
        const [localId, localName, localDesc] = rows[i];
        const resolved = resolveCard(localName, localDesc, vaactMode);

        if (resolved.status === "translated") {
          updates.push({
            id: localId,
            name: resolved.name,
            desc: resolved.desc,
          });
          done++;
          if (resolved.vaact) vaactCount++;
          pushReport(report, {
            id: localId,
            name: resolved.name,
            status: "ok",
            vaact: !!resolved.vaact,
          });
        } else if (resolved.status === "en_only") {
          missing++;
          pushReport(report, {
            id: localId,
            name: resolved.name,
            status: "warn",
          });
        } else {
          missing++;
          pushReport(report, {
            id: localId,
            name: localName,
            status: "warn",
          });
        }

        if (i % YIELD_EVERY === 0) {
          setProgress(
            5 + Math.round((i / total) * 80),
            `Analyse ${i.toLocaleString("fr-FR")} / ${total.toLocaleString("fr-FR")}…`
          );
          await nextFrame();
        }
      }

      setProgress(88, "Application des traductions…");
      applyUpdates(state.sqlite, updates);

      setProgress(96, "Génération du fichier…");
      state.patched = state.sqlite.export();

      setProgress(100, "Terminé !");
      renderResults(report, { total, done, missing, vaactCount });
      dom.downloads.classList.remove("hidden");

      const suffix =
        vaactMode && vaactCount > 0
          ? ` · ${vaactCount} modifiée(s) VAACT`
          : "";
      setStatus(
        `✅ Terminé : ${done.toLocaleString("fr-FR")} / ${total.toLocaleString("fr-FR")} carte(s) traduite(s)${suffix}.`
      );
      toast("Traduction terminée !", "ok");
    } catch (err) {
      console.error("[CDB] Erreur traduction", err);
      setStatus(`❌ Erreur : ${err.message}`);
    } finally {
      dom.btnTranslate.disabled = false;
    }
  }

  function pushReport(report, entry) {
    if (report.length < MAX_REPORT_LINES) report.push(entry);
  }

  function nextFrame() {
    return new Promise((r) => setTimeout(r, 0));
  }

  function applyUpdates(db, updates) {
    const columns = getColumns(db, "texts");
    const setClauses = ["name = ?"];
    if (columns.includes("desc")) setClauses.push("desc = ?");
    // ⚠️ On ne touche PAS à str1 : DataEditorX/EDOPro l'utilisent pour
    // d'autres usages (scripts, flags internes). On modifie seulement
    // le nom et l'effet.

    const stmt = db.prepare(
      `UPDATE texts SET ${setClauses.join(", ")} WHERE id = ?`
    );
    db.run("BEGIN TRANSACTION");
    for (const u of updates) {
      const params = [u.name];
      if (columns.includes("desc")) params.push(u.desc);
      params.push(u.id);
      stmt.run(params);
    }
    db.run("COMMIT");
    stmt.free();
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

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
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
    report.forEach((r) => dom.results.appendChild(buildResultItem(r)));

    const hidden = stats.total - report.length;
    if (hidden > 0) {
      const li = document.createElement("li");
      li.className = "gen-item";
      li.style.justifyContent = "center";
      li.style.color = "var(--text-muted)";
      li.textContent = `… et ${hidden.toLocaleString("fr-FR")} autres`;
      dom.results.appendChild(li);
    }
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

  function setStatus(text) {
    dom.status.textContent = text;
  }

  function resetUI() {
    state.file = null;
    state.sqlite = null;
    state.patched = null;

    dom.fileInput.value = "";
    dom.info.classList.add("hidden");
    dom.actions.classList.add("hidden");
    dom.stats.classList.add("hidden");
    dom.results.innerHTML = "";
    dom.downloads.classList.add("hidden");
    dom.progressWrap.classList.remove("visible");
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
    if (dom.btnTranslate) dom.btnTranslate.addEventListener("click", translate);
    if (dom.btnDownload) dom.btnDownload.addEventListener("click", downloadPatched);
    if (dom.btnClear) dom.btnClear.addEventListener("click", resetUI);
  }

  bindEvents();
})();
