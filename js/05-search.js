// ============================================================================
// 05-search.js — Recherche de cartes (locale, API, Yugipedia)
// ============================================================================

function normalizeForSearch(str) {
  return String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

async function searchCards(query, lang = "auto", allowYugipedia = false) {
  if (appState.dbReady) {
    const local = searchLocal(query, lang);
    if (local.cards.length) return local;
  } else {
    const remote = await searchRemote(query, lang);
    if (remote.cards.length) return remote;
  }
  if (allowYugipedia && window.yugiCache && query.length >= 3) {
    const key = normalizeForSearch(query).replace(/[^a-z0-9]/g, "");
    const yugiCard = window.yugiCache.get(key);
    if (yugiCard) {
      return {
        cards: [{
          id: "yugi-" + key,
          name: yugiCard.fr || yugiCard.en,
          type: yugiCard.card_type === "Spell" ? "Spell Card" : yugiCard.card_type === "Trap" ? "Trap Card" : "Effect Monster",
          frameType: yugiCard.type && yugiCard.type.toLowerCase().includes("fusion") ? "fusion" : "effect",
          desc: yugiCard.fr_lore || yugiCard.lore,
          atk: yugiCard.atk, def: yugiCard.def, level: yugiCard.level,
          race: yugiCard.race, attribute: yugiCard.attribute,
          card_images: yugiCard.img ? [{ image_url: yugiCard.img, image_url_cropped: yugiCard.img }] : [],
          _source: "yugipedia",
          _names: { fr: yugiCard.fr, en: yugiCard.en },
        }],
        usedLanguage: "yugipedia",
        source: "yugipedia",
      };
    }
  }
  return { cards: [], usedLanguage: lang === "auto" ? "fr" : lang };
}

function searchLocal(query, lang = "auto") {
  const q = normalizeForSearch(query);
  if (!q) return { cards: [], usedLanguage: lang };
  const sources = [];
  if (lang === "auto" || lang === "fr") sources.push({ store: memCacheFr, code: "fr" });
  if (lang === "auto" || lang === "en") sources.push({ store: memCacheEn, code: "en" });
  for (const { store, code } of sources) {
    const exact = [];
    const fuzzy = [];
    for (const card of store.values()) {
      const n = normalizeForSearch(card.name);
      if (n === q) exact.push(card);
      else if (n.includes(q)) fuzzy.push(card);
    }
    const found = [...exact, ...fuzzy];
    if (found.length) return { cards: found, usedLanguage: code };
  }
  return { cards: [], usedLanguage: lang === "auto" ? "fr" : lang };
}

async function searchRemote(query, lang) {
  const cacheKey = `${lang}::${query.toLowerCase()}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);
  const tryLanguages = { auto: ["fr", null], fr: ["fr"], en: [null], ja: ["ja"] }[lang] || ["fr", null];
  for (const language of tryLanguages) {
    const params = { fname: query };
    if (language) params.language = language;
    const cards = await apiFetchCards(params);
    if (cards.length) {
      const result = { cards, usedLanguage: language || "en" };
      searchCache.set(cacheKey, result);
      return result;
    }
  }
  const empty = { cards: [], usedLanguage: lang === "auto" ? "fr" : lang };
  searchCache.set(cacheKey, empty);
  return empty;
}

async function getCardById(id, language) {
  const key = String(id);
  if (key.startsWith("yugi-")) return null;
  if (appState.dbReady) {
    if (language === "fr") return memCacheFr.get(key) || null;
    if (!language) return memCacheEn.get(key) || null;
    return null;
  }
  const cache = language === "fr" ? cardFrByIdCache : cardByIdCache;
  if (cache.has(key)) return cache.get(key);
  try {
    const params = { id: key };
    if (language === "fr") params.language = "fr";
    const cards = await apiFetchCards(params);
    const card = cards[0] || null;
    if (card) cache.set(key, card);
    return card;
  } catch (err) { return null; }
}

// ============================================================================
// RECHERCHE DE CARTE PAR NOM (utilisée par decklist et .cdb)
// ============================================================================
async function findCardByName(name, lang) {
  const { cards } = await searchCards(name, lang, true);
  if (!cards.length) return null;
  const normalizedTarget = normalizeForSearch(name);
  const exact = cards.find((c) => normalizeForSearch(c.name) === normalizedTarget);
  return exact || cards[0];
}
