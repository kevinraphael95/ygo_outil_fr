// ============================================================================
// CDB TRANSLATOR — Traduire OU convertir un .cdb EDOPro/YGO Pro
// ============================================================================
// Les .cdb custom (VAACT, Project Ignis, fan-made) utilisent des IDs locaux
// qui n'ont rien à voir avec les passcodes Konami.
//
// Deux actions supportées :
//   - "Traduire" : croise par nom avec la base locale pour avoir les VF.
//                  Sortie : .cdb_fr
//   - "JSON"     : lit DIRECTEMENT le .cdb (tables texts + datas), décode
//                  les bitfields, et génère un JSON par carte SANS croiser
//                  avec la base locale. Préserve 100% des cartes custom.
//
// Mode VAACT (option, traduction uniquement) :
//   Si l'effet du .cdb ≠ effet officiel EN → l'effet a été modifié par VAACT.
//   On garde alors l'effet original puis on ajoute en dessous l'effet
//   officiel FR, préfixé de "(VAACT) ".
//
// Fallback Yugipedia (option, désactivé par défaut, traduction uniquement) :
//   Interroge l'API Yugipedia pour les cartes absentes de la base locale.
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
  // ⚡ DÉCODEUR DE BITFIELDS EDOPro/YGO Pro
  // ==========================================================================
  // Toutes les valeurs viennent de la doc standard (card_data.h) — stables
  // depuis 15 ans.
  // ==========================================================================

  // --- TYPE (bitfield) ---
  const T_MONSTER     = 0x1;
  const T_SPELL       = 0x2;
  const T_TRAP        = 0x4;
  const T_NORMAL      = 0x10;
  const T_EFFECT      = 0x20;
  const T_FUSION      = 0x40;
  const T_RITUAL      = 0x80;
  const T_SPIRIT      = 0x100;
  const T_UNION       = 0x200;
  const T_GEMINI      = 0x400;
  const T_TUNER       = 0x800;
  const T_SYNCHRO     = 0x1000;
  const T_TOKEN       = 0x2000;
  const T_QUICKPLAY   = 0x10000;
  const T_CONTINUOUS  = 0x20000;
  const T_EQUIP       = 0x40000;
  const T_FIELD       = 0x80000;
  const T_COUNTER     = 0x100000;
  const T_FLIP        = 0x200000;
  const T_TOON        = 0x400000;
  const T_XYZ         = 0x800000;
  const T_PENDULUM    = 0x1000000;
  const T_SPSUMMON    = 0x2000000; // invocation spéciale
  const T_LINK        = 0x4000000;

  // --- ATTRIBUTE (bitfield) ---
  const ATTR = {
    0x01: "EARTH",
    0x02: "WATER",
    0x04: "FIRE",
    0x08: "WIND",
    0x10: "LIGHT",
    0x20: "DARK",
    0x40: "DIVINE",
  };

  // --- RACE (bitfield) ---
  const RACE = {
    0x1:       "Warrior",
    0x2:       "Spellcaster",
    0x4:       "Fairy",
    0x8:       "Fiend",
    0x10:      "Zombie",
    0x20:      "Machine",
    0x40:      "Aqua",
    0x80:      "Pyro",
    0x100:     "Rock",
    0x200:     "Winged Beast",
    0x400:     "Plant",
    0x800:     "Insect",
    0x1000:    "Thunder",
    0x2000:    "Dragon",
    0x4000:    "Beast",
    0x8000:    "Beast-Warrior",
    0x10000:   "Dinosaur",
    0x20000:   "Fish",
    0x40000:   "Sea Serpent",
    0x80000:   "Reptile",
    0x100000:  "Psychic",
    0x200000:  "Divine-Beast",
    0x400000:  "Creator God",
    0x800000:  "Wyrm",
    0x1000000: "Cyberse",
    0x2000000: "Illusion",
  };

  // --- LINK MARKERS (bits 0-8 du type pour les Link) ---
  const LINK_MARKERS = {
    0x1:   "Bottom-Left",
    0x2:   "Bottom",
    0x4:   "Bottom-Right",
    0x8:   "Left",
    0x10:  "Right",
    0x20:  "Top-Left",
    0x40:  "Top",
    0x80:  "Top-Right",
  };

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

    vaactMode:    $("cdb-vaact-mode"),
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
  // INDEX PAR NOM (pour la TRADUCTION uniquement)
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

    if (window.memCacheFr) {
      window.memCacheFr.forEach((card) => {
        const key = normalize(card.name);
        if (!key) return;
        const existing = fr.get(key);
        if (!existing || card.name.length > existing.name.length) {
          fr.set(key, card);
        }
      });
    }

    if (window.memCacheEn) {
      window.memCacheEn.forEach((card) => {
        const key = normalize(card.name);
        if (!key) return;
        const existing = en.get(key);
        if (!existing || card.name.length > existing.name.length) {
          en.set(key, card);
        }
      });
    }

    state.nameIndexFr = fr;
    state.nameIndexEn = en;
    console.log(`[CDB] Index construits : ${fr.size} FR, ${en.size} EN`);
  }

  // ==========================================================================
  // COMPARAISON D'EFFETS (VAACT)
  // ==========================================================================

  function cleanDesc(s) {
    return String(s || "")
      .replace(/\r\n/g, "\n")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function descDiffers(a, b) {
    return cleanDesc(a) !== cleanDesc(b);
  }

  // ==========================================================================
  // ⚡ DÉCODAGE D'UNE LIGNE DU .CDB → OBJET CARTE (format YGOPRODeck)
  // ==========================================================================
  // Prend une ligne de `datas` + une ligne de `texts` et retourne un objet
  // carte qui ressemble à ce que l'API YGOPRODeck renvoie. Compatible avec
  // buildYgoproJson() de script.js.
  // ==========================================================================

  function decodeCdbCard(datasRow, textsRow) {
    const id = datasRow.id;
    const type = datasRow.type || 0;
    const race = datasRow.race || 0;
    const attribute = datasRow.attribute || 0;
    const levelRaw = datasRow.level || 0;
    const atk = datasRow.atk || 0;
    const def = datasRow.def || 0;

    const name = (textsRow && textsRow.name) || "";
    const desc = (textsRow && textsRow.desc) || "";

    // --- Détermine le type de carte ---
    const isMonster = (type & T_MONSTER) !== 0;
    const isSpell   = (type & T_SPELL) !== 0;
    const isTrap    = (type & T_TRAP) !== 0;
    const isPendulum = (type & T_PENDULUM) !== 0;
    const isLink    = (type & T_LINK) !== 0;
    const isXyz     = (type & T_XYZ) !== 0;
    const isFusion  = (type & T_FUSION) !== 0;
    const isSynchro = (type & T_SYNCHRO) !== 0;
    const isRitual  = (type & T_RITUAL) !== 0;
    const isNormal  = (type & T_NORMAL) !== 0;
    const isEffect  = (type & T_EFFECT) !== 0;
    const isToken   = (type & T_TOKEN) !== 0;
    const isTuner   = (type & T_TUNER) !== 0;
    const isFlip    = (type & T_FLIP) !== 0;
    const isSpirit  = (type & T_SPIRIT) !== 0;
    const isUnion   = (type & T_UNION) !== 0;
    const isToon    = (type & T_TOON) !== 0;
    const isGemini  = (type & T_GEMINI) !== 0;

    // --- Construit frameType (pour buildYgoproJson) ---
    let frameType = "normal";
    if (isSpell) frameType = "spell";
    else if (isTrap) frameType = "trap";
    else if (isLink) frameType = "link";
    else if (isXyz) frameType = "xyz";
    else if (isSynchro) frameType = "synchro";
    else if (isFusion) frameType = "fusion";
    else if (isRitual) frameType = "ritual";
    else if (isToken) frameType = "token";
    else if (isEffect) frameType = "effect";
    else if (isNormal) frameType = "normal";

    if (isPendulum) frameType += "_pendulum";

    // --- Construit type (string) ---
    let typeStr;
    if (isSpell) typeStr = "Spell Card";
    else if (isTrap) typeStr = "Trap Card";
    else if (isToken) typeStr = "Token";
    else if (isNormal && !isEffect) typeStr = "Normal Monster";
    else typeStr = "Effect Monster";

    // --- Typeline (pour les monstres) ---
    let typeline = null;
    if (isMonster) {
      const raceStr = RACE[race] || "Warrior";
      typeline = [raceStr];
      if (isNormal && !isEffect) typeline.push("Normal");
      if (isEffect) typeline.push("Effect");
      if (isRitual) typeline.push("Ritual");
      if (isFusion) typeline.push("Fusion");
      if (isSynchro) typeline.push("Synchro");
      if (isXyz) typeline.push("Xyz");
      if (isLink) typeline.push("Link");
      if (isPendulum) typeline.push("Pendulum");
      if (isTuner) typeline.push("Tuner");
      if (isFlip) typeline.push("Flip");
      if (isSpirit) typeline.push("Spirit");
      if (isUnion) typeline.push("Union");
      if (isToon) typeline.push("Toon");
      if (isGemini) typeline.push("Gemini");
    }

    // --- Niveau / Rank / Link Rating / Scale ---
    let levelValue = 0;
    let scaleValue = null;
    if (isLink) {
      levelValue = levelRaw & 0xFF; // link rating
    } else if (isXyz) {
      levelValue = levelRaw & 0xFF; // rank
    } else {
      levelValue = levelRaw & 0xFF; // level
    }
    if (isPendulum) {
      scaleValue = (levelRaw >> 24) & 0xFF;
    }

    // --- Attribut ---
    let attributeStr = null;
    if (isMonster && attribute) {
      attributeStr = ATTR[attribute] || null;
    } else if (isSpell) {
      attributeStr = "SPELL";
    } else if (isTrap) {
      attributeStr = "TRAP";
    }

    // --- Link markers ---
    let linkmarkers = null;
    if (isLink) {
      linkmarkers = [];
      for (const [bit, marker] of Object.entries(LINK_MARKERS)) {
        if ((type & parseInt(bit, 10)) !== 0) {
          linkmarkers.push(marker);
        }
      }
    }

    // --- icon (pour magies/pièges) ---
    let icon = "None";
    if (isSpell) {
      if (type & T_RITUAL) icon = "Ritual";
      else if (type & T_QUICKPLAY) icon = "Quick-play";
      else if (type & T_CONTINUOUS) icon = "Continuous";
      else if (type & T_EQUIP) icon = "Equip";
      else if (type & T_FIELD) icon = "Field";
      else icon = "None";
    } else if (isTrap) {
      if (type & T_CONTINUOUS) icon = "Continuous";
      else if (type & T_COUNTER) icon = "Counter";
      else icon = "None";
    }

    // --- Race lisible (pour magies/pièges, on a la catégorie) ---
    let raceStr;
    if (isSpell) {
      raceStr = icon; // "Quick-play", "Continuous", etc.
    } else if (isTrap) {
      raceStr = icon;
    } else {
      raceStr = RACE[race] || "Warrior";
    }

    // --- Objet carte compatible YGOPRODeck ---
    return {
      id: id,
      name: name,
      desc: desc,
      type: typeStr,
      frameType: frameType,
      typeline: typeline,
      race: raceStr,
      attribute: attributeStr,
      level: isSpell || isTrap ? undefined : levelValue,
      linkval: isLink ? levelValue : undefined,
      scale: scaleValue,
      atk: isSpell || isTrap ? undefined : atk,
      def: isSpell || isTrap || isLink ? undefined : def,
      linkmarkers: linkmarkers,
      _source: "cdb",
      _icon: icon,
      _raw: {
        type: type,
        race: race,
        attribute: attribute,
        level: levelRaw,
        ot: datasRow.ot,
        alias: datasRow.alias,
        setcode: datasRow.setcode,
        category: datasRow.category,
      },
    };
  }

  // ==========================================================================
  // RÉSOLUTION DE CARTE (pour la TRADUCTION uniquement)
  // ==========================================================================

  async function resolveCard(localName, localDesc, vaactMode, allowYugipedia) {
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
      }
    }

    return { status: "not_found" };
  }

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

  function getColumns(db, table) {
    return db.exec(`PRAGMA table_info(${table})`)[0].values.map((r) => r[1]);
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
      dom.btnRun.textContent = "⚙️ Lancer";
    }

    if (dom.statDoneLbl) {
      dom.statDoneLbl.textContent = isJson ? "Cartes lues" : "Traduites en FR";
    }
    if (dom.statMissingLbl) {
      dom.statMissingLbl.textContent = isJson ? "Erreurs" : "Pas de trad. FR";
    }

    // ⚡ Cacher les options VAACT + Yugipedia en mode JSON (pas utilisées)
    const vaactWrap = document.getElementById("cdb-vaact-wrap");
    const yugiWrap = document.getElementById("cdb-yugipedia-wrap");
    if (vaactWrap) vaactWrap.style.display = isJson ? "none" : "";
    if (yugiWrap) yugiWrap.style.display = isJson ? "none" : "";
    // Et les <p class="cdb-option-help"> associés
    const helps = document.querySelectorAll(".cdb-option-help");
    if (helps.length >= 2) {
      helps[0].style.display = isJson ? "none" : "";
      helps[1].style.display = isJson ? "none" : "";
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
  // ACTION 1 : TRADUIRE LE .CDB (croise par nom avec la base locale)
  // ==========================================================================

  async function runTranslation() {
    if (!state.sqlite) {
      toast("Charge d'abord un fichier .cdb.", "err");
      return;
    }
    if (!window.memCacheFr || !window.memCacheEn) {
      toast("La base locale n'est pas installée.", "err");
      return;
    }

    const vaactMode = dom.vaactMode ? dom.vaactMode.checked : false;
    const yugiMode = dom.yugiMode ? dom.yugiMode.checked : false;

    state.cancelled = false;
    state.running = true;
    state.missingNames = [];
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
            missingCards.length = 0;
          }
        }

        if (missingCards.length > 0) {
          dom.yugiProgressWrap.classList.add("visible");
          dom.btnCancelYugi.classList.remove("hidden");
          setYugiProgress(0, `Enrichissement Yugipedia (batch)…`);

          const totalMissing = missingCards.length;
          const uniqueNames = [...new Set(missingCards.map((c) => c.name))];

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

      applyUpdates(state.sqlite, updates);
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
  // ACTION 2 : GÉNÉRER LES JSON DIRECTEMENT DEPUIS LE .CDB
  // ==========================================================================
  // ⚡ AUCUN croisement avec la base locale. On lit texts + datas, on décode,
  //    on génère le JSON. Les cartes custom sont préservées à 100%.
  // ==========================================================================

  async function runJsonGeneration() {
    if (!state.sqlite) {
      toast("Charge d'abord un fichier .cdb.", "err");
      return;
    }

    state.cancelled = false;
    state.running = true;
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

      // ⚡ Vérifier qu'on a bien la table datas
      const tables = getTableNames(state.sqlite);
      const hasDatas = tables.includes("datas");
      if (!hasDatas) {
        throw new Error(
          "Ce .cdb n'a pas de table `datas` — impossible de générer les JSON."
        );
      }

      setProgress(10, "Extraction des données…");

      // ⚡ Jointure texts + datas
      const rows = state.sqlite.exec(`
        SELECT
          t.id, t.name, t.desc,
          d.type, d.atk, d.def, d.level, d.race, d.attribute,
          d.ot, d.alias, d.setcode, d.category
        FROM texts t
        INNER JOIN datas d ON t.id = d.id
      `)[0].values;

      const total = rows.length;
      if (total === 0) {
        throw new Error("Aucune carte trouvée dans le .cdb.");
      }

      const report = [];
      const reportIndex = new Map();
      let done = 0;
      let errors = 0;

      setProgress(20, `Génération de ${total.toLocaleString("fr-FR")} JSON…`);

      for (let i = 0; i < rows.length; i++) {
        if (state.cancelled) break;

        const [id, name, desc, type, atk, def, level, race, attribute, ot, alias, setcode, category] = rows[i];

        try {
          const datasRow = { id, type, atk, def, level, race, attribute, ot, alias, setcode, category };
          const textsRow = { id, name, desc };

          const card = decodeCdbCard(datasRow, textsRow);
          const json = buildYgoproJsonFromCdb(card);

          state.generatedFiles.push({
            filename: `${sanitizeFilename(name)}.json`,
            json: JSON.stringify(json, null, 2),
          });
          state.generatedCards.push(card);

          done++;
          pushReport(report, reportIndex, {
            id: id,
            name: name,
            status: "ok",
            source: "cdb",
          });
        } catch (err) {
          console.error(`[CDB] Erreur décodage carte "${name}"`, err);
          errors++;
          pushReport(report, reportIndex, {
            id: id,
            name: name,
            status: "warn",
          });
        }

        if (i % 100 === 0 || i === rows.length - 1) {
          setProgress(
            20 + Math.round(((i + 1) / total) * 75),
            `Génération ${(i + 1).toLocaleString("fr-FR")} / ${total.toLocaleString("fr-FR")}…`
          );
          await nextFrame();
        }
      }

      setProgress(100, "Terminé !");
      renderResults(report, { total, done, missing: errors, vaactCount: 0, doneYugi: 0 });
      dom.downloads.classList.remove("hidden");
      showJsonDownloadsOnly();

      setStatus(
        `✅ Terminé : ${done.toLocaleString("fr-FR")} JSON généré(s) sur ${total.toLocaleString("fr-FR")} carte(s).`
      );
      toast(`${done} JSON générés depuis le .cdb !`, "ok");
    } catch (err) {
      console.error("[CDB] Erreur génération JSON", err);
      setStatus(`❌ Erreur : ${err.message}`);
    } finally {
      state.running = false;
      dom.btnRun.disabled = false;
      dom.btnClear.disabled = false;
    }
  }

  // ==========================================================================
  // ⚡ CONSTRUCTION DU JSON card maker ygopro.org (depuis une carte décodée)
  // ==========================================================================
  // Reprend exactement la même logique que buildYgoproJson() de script.js,
  // mais en local pour ne pas dépendre du format YGOPRODeck exact.
  // ==========================================================================

  function buildYgoproJsonFromCdb(card) {
    const isSpell = card.type === "Spell Card";
    const isTrap = card.type === "Trap Card";
    const [baseFrame, pendulumSuffix] = (card.frameType || "").split("_");
    const isPendulum = pendulumSuffix === "pendulum";
    const isLink = baseFrame === "link";

    return {
      version: "1.0.0",
      name: card.name,
      level: String(card.level || card.linkval || 0),
      type: buildTypeLineFr(card),
      icon: card._icon || "None",
      effect: card.desc || "",
      atk: isSpell || isTrap ? "" : String(card.atk ?? "0"),
      def: isSpell || isTrap || isLink ? "" : String(card.def ?? "0"),
      serial: "",
      copyright: "© 2026 YGOPRO.ORG",
      attribute: buildAttributeFr(card),
      id: String(card.id || ""),
      rarity: "common",
      pendulum: {
        enabled: isPendulum,
        effect: isPendulum ? (card.desc || "") : "",
        blue: isPendulum ? String(card.scale ?? "0") : "0",
        red: isPendulum ? String(card.scale ?? "0") : "0",
        boxSize: "Normal",
        boxSizeEnabled: true,
      },
      variant: "Normal",
      link: buildLinkMarkersFr(card),
      layout: buildLayoutFr(baseFrame),
      boxSize: (card.desc || "").length > 300 ? "Small" : "Normal",
    };
  }

  const FRAME_TO_LAYOUT_FR = {
    normal: "Normal", effect: "Effect", ritual: "Ritual", fusion: "Fusion",
    synchro: "Synchro", xyz: "Xyz", link: "Link", token: "Token",
    spell: "Spell", trap: "Trap", skill: "Skill",
  };
  function buildLayoutFr(baseFrame) {
    return FRAME_TO_LAYOUT_FR[baseFrame] || "Effect";
  }

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
  function translateRaceFr(race) { return RACE_FR[race] || race; }

  const ABILITY_FR = {
    Effect: "Effet", Normal: "Normal", Fusion: "Fusion", Synchro: "Synchro",
    Xyz: "Xyz", Ritual: "Rituel", Link: "Lien", Tuner: "Syntoniseur",
    Flip: "Retournement", Spirit: "Esprit", Union: "Union", Toon: "Toon",
    Gemini: "Gémeau", Pendulum: "Pendule",
  };
  function translateAbilitiesFr(entries) {
    return entries.map((e) => ABILITY_FR[e] || e);
  }

  function buildTypeLineFr(card) {
    if (card.type === "Spell Card") return "Carte Magie";
    if (card.type === "Trap Card") return "Carte Piège";
    const displayRace = translateRaceFr(card.race);
    if (Array.isArray(card.typeline) && card.typeline.length) {
      return [displayRace, ...translateAbilitiesFr(card.typeline.slice(1))].join("/");
    }
    return displayRace;
  }

  function buildAttributeFr(card) {
    if (card.type === "Spell Card") return "Spell";
    if (card.type === "Trap Card") return "Trap";
    if (!card.attribute) return "Light";
    const a = card.attribute.toUpperCase();
    if (a === "DIVINE") return "Divine";
    return a.charAt(0) + a.slice(1).toLowerCase();
  }

  function buildLinkMarkersFr(card) {
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
    card.linkmarkers.forEach((m) => {
      const k = map[m];
      if (k) base[k] = true;
    });
    return base;
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
  // APPLICATION SQL (pour la traduction uniquement)
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

        if (isNaN(id)) continue;

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

    const zip = new JSZip();
    const usedNames = new Map();
    state.generatedFiles.forEach(({ filename, json }) => {
      let finalName = filename;
      if (usedNames.has(filename)) {
        const n = usedNames.get(filename) + 1;
        usedNames.set(filename, n);
        finalName = filename.replace(/\.json$/, `-${n}.json`);
      } else {
        usedNames.set(filename, 1);
      }
      zip.file(finalName, json);
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const baseName = state.file ? state.file.name.replace(/\.cdb$/i, "") : "cdb";
    triggerDownload(blob, `${baseName}_json.zip`);
    toast(`${state.generatedFiles.length} JSON zippés !`, "ok");
  }

  function downloadCsv() {
    if (!state.generatedCards.length) {
      toast("Aucune carte pour le CSV.", "err");
      return;
    }
    if (typeof window.downloadManagerCsv === "function") {
      window.downloadManagerCsv(state.generatedCards);
      toast("CSV Manager téléchargé", "ok");
    } else {
      toast("Fonction CSV non disponible.", "err");
    }
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
  // EXPORT DES CARTES NON TROUVÉES (traduction)
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
    } else if (isOk && r.source === "yugipedia") {
      badgeText = "🟣 Yugipedia";
      badgeClass = "yugi";
    } else if (isOk && r.source === "cdb") {
      badgeText = "Lu du .cdb";
      badgeClass = "ok";
    } else if (isOk) {
      badgeText = "Traduit";
      badgeClass = "ok";
    } else {
      badgeText = "Erreur";
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

  function sanitizeFilename(name) {
    if (typeof window.sanitizeFilename === "function") {
      return window.sanitizeFilename(name);
    }
    return String(name).replace(/[\\/:*?"<>|]/g, "").trim();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toast(msg, kind) {
    if (typeof window.toast === "function") {
      window.toast(msg, kind);
    } else {
      console.log(`[${kind || "info"}] ${msg}`);
    }
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
