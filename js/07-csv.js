// ============================================================================
// 07-csv.js — Export CSV pour le Card Maker Manager
// ============================================================================

const CSV_FIELDS = [
  "Format", "Frame", "Name", "Attribute", "Star", "Spell/Trap Icon", "Art Link",
  "Type Ability", "Effect", "Set Id", "ATK", "DEF", "Password", "Sticker",
  "Copyright", "Is Pendulum", "Pendulum Effect", "Pendulum Scale Red",
  "Pendulum Scale Blue", "Is Link", "Link - Top Left Arrow", "Link - Top Arrow",
  "Link - Top Right Arrow", "Link - Left Arrow", "Link - Right Arrow",
  "Link - Bottom Left Arrow", "Link - Bottom Arrow", "Link - Bottom Right Arrow",
  "Is First Edition", "Is Speed Card", "Is Limited Edition",
  "Is Duel Terminal Card", "Is Legacy Card", "Foil", "Art Finish", "Card Finish",
  "Art Crop - X (%)", "Art Crop - Y (%)", "Art Crop - Width (%)",
  "Art Crop - Height (%)", "Is Using Full Art", "Region", "Star Type",
  "Star Alignment", "Card Icon Type", "Link Rating", "Opacity - Body",
  "Opacity - Pendulum", "Opacity - Text", "Opacity - Name",
  "Opacity - Base Fill", "Opacity - Art Border", "Opacity - Name Border",
  "Opacity - Effect Box", "Opacity - Boundless", "Has Background",
  "Background Link", "Is Using Full Background", "Background Type",
  "Background Crop - X (%)", "Background Crop - Y (%)",
  "Background Crop - Width (%)", "Background Crop - Height (%)",
  "Bottom Frame", "Condense Rate", "Use Furigana Helper", "Name Style Type",
  "Name Style - Font", "Name Style - Fill Style",
  "Name Style - Headtext Fill Style", "Name Style - Shadow Color",
  "Name Style - Shadow Offset Y", "Name Style - Shadow Offset X",
  "Name Style - Shadow Blur", "Name Style - Has Shadow",
  "Name Style - Line Color", "Name Style - Line Width",
  "Name Style - Line Offset Y", "Name Style - Line Offset X",
  "Name Style - Has Outline", "Name Style - Gradient Angle",
  "Name Style - Gradient Color", "Name Style - Has Gradient",
  "Name Style - Emboss Pitch", "Name Style - Emboss Yaw",
  "Name Style - Emboss Thickness", "Name Style - Has Emboss",
  "Name Style - Preset", "Name Style - Pattern", "Stat Style - Is Custom",
  "Stat Style - Fill Color", "Stat Style - Has Shadow",
  "Stat Style - Shadow Color", "Type Style - Is Custom",
  "Type Style - Fill Color", "Type Style - Has Shadow",
  "Type Style - Shadow Color", "Effect Style - Is Custom",
  "Effect Style - Fill Color", "Effect Style - Has Shadow",
  "Effect Style - Shadow Color", "Effect Style - Upsize",
  "Effect Style - Font Style", "Effect Style - Background",
  "Effect Style - Min Line", "Effect Style - Justify Ratio", "Pendulum Size",
  "Pendulum Effect Style - Is Custom", "Pendulum Effect Style - Fill Color",
  "Pendulum Effect Style - Has Shadow", "Pendulum Effect Style - Shadow Color",
  "Pendulum Effect Style - Upsize", "Pendulum Effect Style - Font Style",
  "Pendulum Effect Style - Background", "Pendulum Effect Style - Min Line",
  "Pendulum Effect Style - Justify Ratio", "Other Style - Is Custom",
  "Other Style - Fill Color", "Other Style - Has Shadow",
  "Other Style - Shadow Color", "Other Finish - Attribute",
  "Other Finish - Background", "Other Finish - Icon", "Other Finish - Sticker",
  "Left Frame", "Right Frame", "Bottom Right Frame", "Dye List", "Star List",
  "Flag", "External Info (JSON)",
];

const RACE_TO_ICON_INTERNAL = {
  Continuous: "CONTINUOUS", Counter: "COUNTER", Equip: "EQUIP",
  Field: "FIELD", "Quick-Play": "QUICK-PLAY", Ritual: "RITUAL", Normal: "NO ICON",
};
function buildIconInternal(card) {
  if (card.type === "Spell Card" || card.type === "Trap Card") return RACE_TO_ICON_INTERNAL[card.race] || "NO ICON";
  return "NO ICON";
}
function buildAttributeInternal(card) {
  if (card.type === "Spell Card") return "SPELL";
  if (card.type === "Trap Card") return "TRAP";
  if (!card.attribute) return "NONE";
  return card.attribute.toUpperCase();
}
function csvQuote(value) {
  if (value === undefined || value === null || value === "") return "";
  return `"${String(value).replace(/"/g, '""').replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ")}"`;
}

// ============================================================================
// 🖼️ ILLUSTRATION YGOPRODECK PRIORITAIRE
// ============================================================================
// Si l'image de la carte est un scan Yugipedia (carte entière avec cadre), on
// cherche l'illustration recadrée YGOPRODeck par le nom (FR, EN, ou nom EN
// trouvé dans le cache Yugipedia). Sinon on garde l'image d'origine.
// ============================================================================
let _artIndex = null;
function artKey(n) {
  return normalizeForSearch(n).replace(/[^a-z0-9]/g, "");
}
function buildArtIndex() {
  const idx = new Map();
  const add = (store) => {
    if (!store) return;
    for (const c of store.values()) {
      const url = c.card_images && c.card_images[0] && c.card_images[0].image_url_cropped;
      const k = artKey(c.name);
      if (url && k && !idx.has(k)) idx.set(k, url);
    }
  };
  add(window.memCacheEn);
  add(window.memCacheFr);
  return idx;
}
function resolveYgoproArt(card) {
  const img = card.card_images && card.card_images[0];
  const raw = img ? (img.image_url_cropped || img.image_url) : "";
  if (raw && !/yugipedia\.com/i.test(raw)) return raw; // déjà une image YGOPRODeck

  if (!_artIndex || _artIndex.size === 0) _artIndex = buildArtIndex();
  const y = window.yugiCache ? window.yugiCache.get(artKey(card.name)) : null;
  const names = [card.name, card._names && card._names.en, card._names && card._names.fr];
  if (y) names.push(y.en, y.fr);
  for (const n of names) {
    if (!n) continue;
    const url = _artIndex.get(artKey(n));
    if (url) return url;
  }
  return raw;
}

function buildCsvRow(card) {
  card = normalizePendulum(card); // 🔮 sépare effet Pendule / effet Monstre
  const isSpell = card.type === "Spell Card";
  const isTrap = card.type === "Trap Card";
  const [baseFrame, pendulumSuffix] = (card.frameType || "").split("_");
  const isPendulum = pendulumSuffix === "pendulum";
  const isLink = baseFrame === "link";
  const links = buildLinkMarkers(card);
  const img = card.card_images && card.card_images[0];
  const rawImgUrl = resolveYgoproArt(card);
  const PLACEHOLDER_RAW = "https://kevinraphael95.github.io/ygo_outil_fr/placeholder.png";
  const PLACEHOLDER_PROXIED = PLACEHOLDER_RAW;

  const imgUrl = rawImgUrl
    ? `https://images.weserv.nl/?url=${encodeURIComponent(rawImgUrl.replace(/^https?:\/\//, ""))}`
    : PLACEHOLDER_PROXIED;
  const values = {
    Format: "tcg",
    Frame: buildLayout(baseFrame).toLowerCase(),
    Name: card.name,
    Attribute: buildAttributeInternal(card),
    Star: String(card.level || card.linkval || ""),
    "Spell/Trap Icon": buildIconInternal(card),
    "Art Link": imgUrl,
    "Type Ability": buildTypeLine(card),
    Effect: buildEffectText(card),
    "Set Id": String(card.id || ""),
    ATK: isSpell || isTrap ? "" : String(card.atk ?? ""),
    DEF: isSpell || isTrap || isLink ? "" : String(card.def ?? ""),
    Sticker: "no-sticker",
    Copyright: "© 2026 YGOPRO.ORG",
    "Is Pendulum": isPendulum ? "true" : "false",
    "Pendulum Effect": isPendulum ? card.pend_desc || "" : "",
    "Pendulum Scale Red": isPendulum ? String(card.scale ?? "0") : "",
    "Pendulum Scale Blue": isPendulum ? String(card.scale ?? "0") : "",
    "Is Link": isLink ? "true" : "false",
    "Link - Top Left Arrow": links.topLeft ? "true" : "false",
    "Link - Top Arrow": links.topCenter ? "true" : "false",
    "Link - Top Right Arrow": links.topRight ? "true" : "false",
    "Link - Left Arrow": links.middleLeft ? "true" : "false",
    "Link - Right Arrow": links.middleRight ? "true" : "false",
    "Link - Bottom Left Arrow": links.bottomLeft ? "true" : "false",
    "Link - Bottom Arrow": links.bottomCenter ? "true" : "false",
    "Link - Bottom Right Arrow": links.bottomRight ? "true" : "false",
    Region: "fr",
    "Effect Style - Justify Ratio": "100",
    "Effect Style - Min Line": "0",
  };
  return CSV_FIELDS.map((f) => csvQuote(values[f])).join(",");
}

function buildManagerCsv(cards) {
  const header = CSV_FIELDS.join(",");
  const rows = cards.map(buildCsvRow);
  return [header, ...rows].join("\n");
}

function downloadManagerCsv(cards) {
  const csv = buildManagerCsv(cards);
  const BOM = "\uFEFF";
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, "cartes-ygopro-manager.csv");
}
