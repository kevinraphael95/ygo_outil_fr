// ============================================================================
// 08-ui.js — Interface : thème, modals, onglets, recherche, résultats, drawer
// ============================================================================

// ============================================================================
// THÈME
// ============================================================================
// Le thème initial est posé sur <html> par le petit script du <head> de
// index.html (avant le chargement du CSS, donc sans flash). Ici on ne fait que
// synchroniser l'icône du bouton et gérer le clic.
(function initTheme() {
  const theme = document.documentElement.dataset.theme || "dark";
})();

themeToggle.addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  root.style.colorScheme = next;
  try { localStorage.setItem("ygo-theme", next); } catch (e) {}
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
