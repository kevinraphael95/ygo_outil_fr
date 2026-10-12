// ============================================================================
// 09-deck.js — Onglet Decklist : JSON, .ydk, traduction
// ============================================================================

// ============================================================================
// DECKLIST — GESTION DES ACTIONS
// ============================================================================
function getDeckAction() {
  const r = document.querySelector('input[name="deck-action"]:checked');
  return r ? r.value : "json";
}

function updateDeckActionUI() {
  const action = getDeckAction();
  const isTranslate = action === "translate";
  const isYdk = action === "ydk";

  if (deckTranslateOptions) deckTranslateOptions.classList.toggle("hidden", !isTranslate);
  if (translationResultEl) translationResultEl.classList.add("hidden");
  if (translationActionsEl) translationActionsEl.classList.add("hidden");
  if (deckDownloadsRow) deckDownloadsRow.classList.add("hidden");
  if (deckResultsEl) deckResultsEl.innerHTML = "";
  if (deckStatusEl) deckStatusEl.textContent = "";
  if (progressWrap) progressWrap.classList.remove("visible");

  if (deckGenerateBtn) {
    if (isTranslate) deckGenerateBtn.textContent = "🌐 Traduire";
    else if (isYdk) deckGenerateBtn.textContent = "📦 Générer le .ydk";
    else deckGenerateBtn.textContent = "⚙️ Générer les JSON";
  }
}

if (deckActionJsonRadio) deckActionJsonRadio.addEventListener("change", updateDeckActionUI);
if (deckActionTranslateRadio) deckActionTranslateRadio.addEventListener("change", updateDeckActionUI);
if (deckActionYdkRadio) deckActionYdkRadio.addEventListener("change", updateDeckActionUI);
updateDeckActionUI();

// ============================================================================
// PARSING DE DECKLIST
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

function parseDecklistWithSections(text) {
  const main = [], extra = [], side = [];
  let currentSection = main;

  text.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    if (/^main\s*deck\s*:?$/i.test(line)) { currentSection = main; return; }
    if (/^extra\s*deck\s*:?$/i.test(line)) { currentSection = extra; return; }
    if (/^side\s*deck\s*:?$/i.test(line)) { currentSection = side; return; }

    const match = line.match(DECK_LINE_RE);
    const name = match ? match[2].trim() : line;
    const count = match ? parseInt(match[1], 10) : 1;

    for (let i = 0; i < count; i++) currentSection.push(name);
  });

  return { main, extra, side };
}

// ============================================================================
// RENDU COMPACT UNIVERSEL (JSON / .ydk / Traduction)
// ============================================================================
function renderCompactResults({
  total,
  ok = 0,
  warn = 0,
  failed = [],
  custom = 0,
  type = "json",
  detailsId = null,
  detailsLabel = "Voir le détail complet",
}) {
  deckResultsEl.innerHTML = "";

  // ─── Ligne de résumé ───
  const summary = document.createElement("li");
  summary.className = "gen-summary";

  const parts = [];
  parts.push(
    `<span class="gen-summary-item total">📦 <strong>${total}</strong> carte${total > 1 ? "s" : ""}</span>`
  );
  if (ok > 0) parts.push(
    `<span class="gen-summary-item ok">✅ <strong>${ok}</strong> résolue${ok > 1 ? "s" : ""}</span>`
  );
  if (warn > 0) parts.push(
    `<span class="gen-summary-item warn">⚠️ <strong>${warn}</strong> sans trad.</span>`
  );
  if (failed.length > 0) parts.push(
    `<span class="gen-summary-item err">❌ <strong>${failed.length}</strong> introuvable${failed.length > 1 ? "s" : ""}</span>`
  );
  if (custom > 0) parts.push(
    `<span class="gen-summary-item custom">🟣 <strong>${custom}</strong> custom</span>`
  );

  const actionLabel =
    type === "ydk" ? "📄 Format .ydk"
    : type === "translate" ? "🌐 Traduction"
    : "📄 Format JSON";
  parts.push(`<span class="gen-summary-item info">${actionLabel}</span>`);

  summary.innerHTML = `<div class="gen-summary-bar">${parts.join("")}</div>`;
  deckResultsEl.appendChild(summary);

  // ─── Bouton "Voir le détail" (optionnel) ───
  if (detailsId) {
    const toggleLi = document.createElement("li");
    toggleLi.className = "gen-details-toggle";
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = `👁️ ${detailsLabel}`;
    btn.addEventListener("click", () => {
      const el = document.getElementById(detailsId);
      if (!el) return;
      const nowHidden = el.classList.toggle("hidden");
      btn.textContent = nowHidden ? `👁️ ${detailsLabel}` : "🙈 Masquer le détail";
    });
    toggleLi.appendChild(btn);
    deckResultsEl.appendChild(toggleLi);
  }

  // ─── Liste compacte des échecs ───
  if (failed.length > 0) {
    const header = document.createElement("li");
    header.className = "gen-failed-header";
    header.innerHTML = `<span>❌ Cartes non résolues</span>`;
    deckResultsEl.appendChild(header);

    const grid = document.createElement("li");
    grid.className = "gen-failed-grid";
    failed.forEach((name) => {
      const chip = document.createElement("span");
      chip.className = "gen-failed-chip";
      chip.textContent = name;
      chip.title = name;
      grid.appendChild(chip);
    });
    deckResultsEl.appendChild(grid);
  }
}

// ============================================================================
// BOUTONS EXEMPLE / EFFACER
// ============================================================================
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

// ============================================================================
// DISPATCHER DE L'ACTION
// ============================================================================
deckGenerateBtn.addEventListener("click", async () => {
  const action = getDeckAction();
  if (action === "translate") await runDeckTranslation();
  else if (action === "ydk") await runYdkGeneration();
  else await runDeckJsonGeneration();
});

// ============================================================================
// ACTION 1 : GÉNÉRATION JSON
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

  const generatedFiles = [];
  const generatedCards = [];
  const resolved = new Map();
  const failed = [];
  const uniqueNames = [...new Set(names)];
  let done = 0;

  for (const n of uniqueNames) {
    try {
      const card = await findCardByName(n, "auto");
      if (card) resolved.set(n, card);
      else failed.push(n);
    } catch (err) { console.warn(`Échec "${n}"`, err); failed.push(n); }
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
    const found = resolved.get(name);
    if (found) {
      try {
        const json = await generateJsonForCard(found);
        generatedFiles.push({ filename: `${sanitizeFilename(found.name)}.json`, json: JSON.stringify(json, null, 2) });
        const fr = found._source === "yugipedia" ? null : await getCardById(found.id, "fr");
        const structural = found._source === "yugipedia" ? found : (structuralCardCache.get(found.id) || found);
        generatedCards.push({ ...structural, name: (fr && fr.name) || found.name, desc: found.desc, pend_desc: found.pend_desc, monster_desc: found.monster_desc, displayRace: found.race });
      } catch (err) { console.error(err); }
    }
    const pct = 60 + Math.round(((i + 1) / names.length) * 40);
    progressFill.style.width = pct + "%";
    progressPct.textContent = pct + "%";
    progressLabel.textContent = `Génération ${i + 1} / ${names.length}…`;
  }

  // ═══ RENDU COMPACT ═══
  renderCompactResults({
    total: names.length,
    ok: generatedFiles.length,
    failed: [...new Set(failed)],
    type: "json",
  });

  deckGenerateBtn.disabled = false;
  progressLabel.textContent = `Terminé : ${generatedFiles.length} / ${names.length}`;
  progressPct.textContent = "100%";
  progressFill.style.width = "100%";
  if (generatedFiles.length) {
    deckDownloadsRow.classList.remove("hidden");
    if (deckDownloadYdkBtn) deckDownloadYdkBtn.classList.add("hidden");
    if (deckDownloadZipBtn) deckDownloadZipBtn.classList.remove("hidden");
    if (deckDownloadCsvBtn) deckDownloadCsvBtn.classList.remove("hidden");
    deckDownloadZipBtn.onclick = () => downloadAsZip(generatedFiles);
    deckDownloadCsvBtn.onclick = () => downloadManagerCsv(generatedCards);
  }
}

// ============================================================================
// ACTION 2 : GÉNÉRATION .YDK (EDOPro / YGOPro / YGO Omega)
// ============================================================================
async function runYdkGeneration() {
  const { main, extra, side } = parseDecklistWithSections(deckInput.value);
  const allCards = [...main, ...extra, ...side];
  if (!allCards.length) { toast("Colle d'abord une decklist.", "err"); return; }

  deckGenerateBtn.disabled = true;
  deckResultsEl.innerHTML = "";
  deckDownloadsRow.classList.add("hidden");
  translationResultEl.classList.add("hidden");
  translationActionsEl.classList.add("hidden");
  progressWrap.classList.add("visible");
  progressFill.style.width = "0%";
  progressPct.textContent = "0%";
  deckStatusEl.textContent = appState.dbReady ? "Résolution des cartes…" : "Résolution via API…";

  const uniqueNames = [...new Set(allCards)];
  const resolvedMap = new Map();
  const unresolved = [];
  const sourceInfo = new Map();
  let done = 0;

  for (const n of uniqueNames) {
    const key = normalizeForSearch(n).replace(/[^a-z0-9]/g, "");
    let passcode = CUSTOM_IDS[key] || null;
    let source = passcode ? "custom" : null;

    if (!passcode) {
      try {
        const card = await findCardByName(n, "auto");
        if (card && card.id && !String(card.id).startsWith("yugi-")) {
          passcode = String(card.id);
          source = "local";
        }
      } catch (err) { console.warn(`Échec "${n}"`, err); }
    }

    if (passcode) {
      resolvedMap.set(n, passcode);
      sourceInfo.set(n, source);
    } else {
      unresolved.push(n);
    }

    done++;
    const pct = Math.round((done / uniqueNames.length) * 80);
    progressFill.style.width = pct + "%";
    progressPct.textContent = pct + "%";
    progressLabel.textContent = `Résolution ${done} / ${uniqueNames.length}…`;
  }

  // ─── Construction du .ydk ───
  let ydk = "#created by YGO Card Maker JSON\n";
  function appendSection(header, list) {
    ydk += header + "\n";
    list.forEach((name) => {
      const id = resolvedMap.get(name);
      if (id) ydk += id + "\n";
      else ydk += "# " + name + " (ID introuvable)\n";
    });
  }
  appendSection("#main", main);
  appendSection("#extra", extra);
  appendSection("!side", side);

  // ─── Stats ───
  const customCount = [...resolvedMap.keys()].filter((n) => sourceInfo.get(n) === "custom").length;
  const okCount = allCards.length - unresolved.length;

  // ═══ RENDU COMPACT ═══
  renderCompactResults({
    total: allCards.length,
    ok: okCount,
    failed: [...new Set(unresolved)],
    custom: customCount,
    type: "ydk",
  });

  progressFill.style.width = "100%";
  progressPct.textContent = "100%";
  progressLabel.textContent = `Terminé : ${okCount} / ${allCards.length}`;
  deckStatusEl.textContent = `✅ ${okCount} carte(s) résolue(s) · ${unresolved.length} introuvable(s)`;
  deckDownloadsRow.classList.remove("hidden");

  if (deckDownloadZipBtn) deckDownloadZipBtn.classList.add("hidden");
  if (deckDownloadCsvBtn) deckDownloadCsvBtn.classList.add("hidden");
  if (deckDownloadYdkBtn) {
    deckDownloadYdkBtn.classList.remove("hidden");
    deckDownloadYdkBtn.onclick = () => {
      const blob = new Blob([ydk], { type: "text/plain;charset=utf-8" });
      downloadBlob(blob, "deck.ydk");
      toast(".ydk téléchargé !", "ok");
    };
  }

  deckGenerateBtn.disabled = false;
  if (unresolved.length) toast(`${unresolved.length} carte(s) sans ID`, "warn");
  else toast("Fichier .ydk généré avec succès !", "ok");
}

// ============================================================================
// ACTION 3 : TRADUCTION DE DECKLIST
// ============================================================================
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
  let warnCount = 0;
  let totalCards = 0;
  const failedNames = [];

  for (const idx of cardIndexes) {
    const r = results[idx];
    const name = r.name;
    const resolved = resolvedMap.get(name);
    totalCards++;
    if (!resolved) { r.status = "err"; failedNames.push(name); continue; }
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
    if (!target) { r.status = "warn"; r.translated = resolved.name; warnCount++; continue; }
    const translatedName = target.name;
    const isSame = translatedName.toLowerCase() === name.toLowerCase();
    if (isSame) { r.status = "warn"; r.translated = translatedName; warnCount++; }
    else { r.status = "ok"; r.translated = translatedName; okCount++; }
  }

  // ─── Panneau détaillé (caché par défaut) ───
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
  translationResultEl.classList.add("hidden");

  // ═══ RENDU COMPACT ═══
  renderCompactResults({
    total: totalCards,
    ok: okCount,
    warn: warnCount,
    failed: [...new Set(failedNames)],
    type: "translate",
    detailsId: "translation-result",
    detailsLabel: "Voir la decklist traduite",
  });

  translationActionsEl.classList.remove("hidden");
  deckGenerateBtn.disabled = false;
  deckStatusEl.textContent = `Terminé : ${okCount} / ${totalCards} carte(s) traduite(s).`;
  lastTranslationResult = { results, dst };
  toast("Traduction terminée !", "ok");
}

// ============================================================================
// BOUTONS DE TRADUCTION
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
    toast("Utilise plutôt « Générer le .ydk » dans l'onglet Decklist.", "info");
  });
}
function buildTranslatedDecklist({ results }) {
  return results.filter(Boolean).map((r) => {
    if (r.type === "section") return r.label;
    const name = r.translated || r.name;
    return `${r.qty} ${name}`;
  }).join("\n");
}
