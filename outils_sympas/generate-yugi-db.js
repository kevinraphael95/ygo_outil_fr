// ============================================================================
// Génère yugipedia-db.json — TOUTES les cartes (6 templates) + indenté
// ============================================================================
// ⚡ v4.2 : Encodage UTF-8 forcé + Nettoyage des balises Ruby + Fix Artwork
// ============================================================================

const fs = require("fs");
const https = require("https");

const API = "https://yugipedia.com/api.php";
const DELAY = 1200;
const BATCH = 50;

const USER_AGENT = "YGO-Card-DB-Generator/1.0 (https://github.com/kevinraphael95; kevinyugioh@gmail.com)";

const CARD_TEMPLATES = [
  "Template:CardTable2",
  "Template:Anime card",
  "Template:Manga card",
  "Template:Video game card",
  "Template:OCG card",
  "Template:TCG card",
];

function fetchJson(params) {
  return new Promise((resolve, reject) => {
    const url = new URL(API);
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    url.searchParams.set("origin", "*");
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const options = {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
    };

    https.get(url.toString(), options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════
// Étape 1 : TOUS les titres (6 templates)
// ═══════════════════════════════════════════════════════════════════════════
async function getAllCardTitles() {
  console.log("📥 Récupération des pages de cartes (6 templates)...\n");
  const titles = new Set();

  for (const tpl of CARD_TEMPLATES) {
    console.log(`📥 ${tpl}`);
    let cont = null;
    let tplCount = 0;

    while (true) {
      const params = {
        action: "query",
        list: "embeddedin",
        eititle: tpl,
        einamespace: "0",
        eilimit: "500",
      };
      if (cont) params.eicontinue = cont;

      try {
        const data = await fetchJson(params);
        const members = data?.query?.embeddedin || [];
        for (const m of members) titles.add(m.title);
        tplCount += members.length;
        console.log(`  → ${titles.size} titres cumulés (${tplCount} pour ce template)`);

        cont = data?.continue?.eicontinue;
        if (!cont) break;
      } catch (e) {
        console.warn("  ⚠️ Erreur:", e.message);
        break;
      }
      await sleep(DELAY);
    }
    console.log();
  }
  return [...titles];
}

// ═══════════════════════════════════════════════════════════════════════════
// Étape 2 : contenu des pages en batch
// ═══════════════════════════════════════════════════════════════════════════
async function fetchWikitexts(titles) {
  console.log(`📥 Récupération du contenu de ${titles.length} pages...\n`);
  const results = new Map();
  let i = 0;

  for (let j = 0; j < titles.length; j += BATCH) {
    const chunk = titles.slice(j, j + BATCH);
    try {
      const data = await fetchJson({
        action: "query",
        prop: "revisions",
        rvprop: "content",
        rvslots: "main",
        titles: chunk.join("|"),
        redirects: "1",
      });
      const pages = data?.query?.pages || [];
      for (const p of pages) {
        if (!p || p.missing) continue;
        const wikitext = p.revisions?.[0]?.slots?.main?.content
                      || p.revisions?.[0]?.content
                      || p.revisions?.[0]?.["*"];
        if (wikitext) results.set(p.title, wikitext);
      }
      i += chunk.length;
      if (i % 500 === 0 || i >= titles.length) {
        console.log(`  → ${i} / ${titles.length} pages (${results.size} avec contenu)`);
      }
    } catch (e) {
      console.warn(`  ⚠️ Erreur batch ${j}:`, e.message);
    }
    await sleep(DELAY);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Étape 3 : parsing
// ═══════════════════════════════════════════════════════════════════════════
function extractTemplateParams(wikitext, templateName) {
  const escaped = templateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("\\{\\{\\s*" + escaped + "\\s*(?=[|}\\n])", "i");
  const m = re.exec(wikitext);
  if (!m) return null;

  const startIdx = m.index;
  let i = startIdx, depth = 0, endIdx = null;
  while (i < wikitext.length - 1) {
    const two = wikitext.substr(i, 2);
    if (two === "{{") { depth++; i += 2; continue; }
    if (two === "}}") { depth--; if (depth === 0) { endIdx = i; break; } i += 2; continue; }
    i++;
  }
  if (endIdx === null) return null;

  return wikitext.slice(startIdx + m[0].length, endIdx);
}

function parseParams(body) {
  const params = {};
  let i = 0;
  if (body[i] === "|") i++;

  while (i < body.length) {
    const eqIdx = body.indexOf("=", i);
    if (eqIdx === -1) break;
    const key = body.slice(i, eqIdx).trim().replace(/^[|\s]*/, "").trim();
    if (!/^[a-zA-Z_0-9]+$/.test(key)) {
      const np = body.indexOf("|", i);
      if (np === -1) break;
      i = np + 1;
      continue;
    }
    let j = eqIdx + 1, depth = 0;
    while (j < body.length) {
      const two = body.substr(j, 2);
      if (two === "{{") { depth++; j += 2; continue; }
      if (two === "}}") { depth--; j += 2; continue; }
      if (two === "[[") { depth++; j += 2; continue; }
      if (two === "]]") { depth--; j += 2; continue; }
      if (depth === 0 && body[j] === "|") break;
      j++;
    }
    params[key.toLowerCase()] = body.slice(eqIdx + 1, j).trim();
    i = j + 1;
  }
  return params;
}

function clean(s) {
  if (!s) return null;
  return String(s)
    .replace(/\{\{Ruby\|([^|]+)\|[^}]+\}\}/gi, "$1") // ⚡ Nettoyage propre des balises Ruby japonaises
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/'''?/g, "")
    .replace(/&nbsp;/g, " ")
    .trim() || null;
}

const TEMPLATES = ["CardTable2", "Anime card", "Manga card", "Video game card", "OCG card", "TCG card"];

function parseCard(wikitext, title) {
  for (const tpl of TEMPLATES) {
    const body = extractTemplateParams(wikitext, tpl);
    if (!body) continue;
    const p = parseParams(body);

    const frName = clean(p.fr_name);
    let enName = clean(p.en_name || p.translated_name);

    if (!enName && title) enName = clean(title);

    if (!frName && !enName) continue;

    const cardId = p.passcode ? String(p.passcode).trim() : null;
    const croppedArtworkUrl = cardId ? `https://images.ygoprodeck.com/images/card_cropped/${cardId}.jpg` : null;

    const rawImg = p.image_ca || p.artwork || p.image_cropped || p.image || p.en_image || p.ja_image || "";
    
    // ⚡ Nettoyage robuste pour extraire un nom de fichier image valide
    let imgName = null;
    if (rawImg) {
      const cleanLine = rawImg.split(/[\r\n]+/)[0].trim();
      const parts = cleanLine.split(";");
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed && !trimmed.includes("=")) {
          imgName = trimmed.replace(/^.*?:/, "").trim();
          break;
        }
      }
      if (!imgName) {
        imgName = cleanLine.replace(/^.*?:/, "").split(";")[0].trim();
      }
    }

    return {
      title: title || null,
      fr: frName,
      en: enName,
      tpl,
      id: cardId,
      database_id: p.database_id ? String(p.database_id).trim() : null,

      img: croppedArtworkUrl || (imgName
        ? `https://yugipedia.com/wiki/Special:Redirect/file/${encodeURIComponent(imgName)}`
        : null),

      img_en: p.en_image
        ? `https://yugipedia.com/wiki/Special:Redirect/file/${encodeURIComponent(p.en_image.replace(/^.*?:/, ""))}`
        : null,

      de: clean(p.de_name),
      it: clean(p.it_name),
      pt: clean(p.pt_name),
      es: clean(p.es_name),
      ja: clean(p.ja_name),
      ko: clean(p.ko_name),
      tc: clean(p.tc_name),
      sc: clean(p.sc_name),
      romaji: clean(p.romaji_name),

      card_type: clean(p.card_type),
      property: clean(p.property),
      type: clean(p.types || p.type),
      race: clean((p.types || p.type || "").split("/")[0]) || null,
      attribute: clean(p.attribute),

      atk: p.atk ? parseInt(p.atk) || null : null,
      def: p.def ? parseInt(p.def) || null : null,
      level: p.level ? parseInt(p.level) || null : null,
      rank: p.rank ? parseInt(p.rank) || null : null,
      link: p.link ? parseInt(p.link) || null : null,
      link_arrows: p.link_arrows ? clean(p.link_arrows) : null,
      scale: p.scale ? parseInt(p.scale) || null : null,

      lore: clean(p.lore || p.text),
      fr_lore: clean(p.fr_lore || p.fr_text),
      effect_types: clean(p.effect_types),

      archetype: clean(p.archetype),
      archseries: clean(p.archseries),
      supports: clean(p.supports),
      anti_supports: clean(p.anti_supports),
      supports_archetypes: clean(p.supports_archetypes),

      ocg_status: clean(p.ocg_status),
      tcg_status: clean(p.tcg_status),
    };
  }
  return null;
}

function normalize(s) {
  return String(s || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  const titles = await getAllCardTitles();
  console.log(`\n✅ ${titles.length} titres collectés au total\n`);

  if (titles.length === 0) {
    console.error("❌ Aucun titre trouvé.");
    process.exit(1);
  }

  const wikitexts = await fetchWikitexts(titles);
  console.log(`\n✅ ${wikitexts.size} wikitexts récupérés\n`);

  console.log("🔄 Parsing...");
  const db = {};
  let count = 0;

  for (const [title, wt] of wikitexts) {
    const card = parseCard(wt, title);
    if (!card) continue;

    const key = normalize(card.fr || card.en || title);
    if (!key) continue;
    if (!db[key]) {
      db[key] = card;
      count++;
    }

    const titleKey = normalize(title);
    if (titleKey && titleKey !== key && !db[titleKey]) {
      db[titleKey] = card;
    }
  }

  console.log(`✅ ${count} cartes uniques parsées`);
  console.log(`✅ ${Object.keys(db).length} entrées totales`);

  const json = JSON.stringify(db, null, 2);
  
  // ⚡ Encodage UTF-8 explicitement forcé ici pour éviter les bugs d'affichage
  fs.writeFileSync("yugipedia-db.json", json, "utf8");
  console.log(`\n💾 yugipedia-db.json généré : ${(json.length / 1024 / 1024).toFixed(2)} Mo`);
})();