// ============================================================================
// yugipedia-db-generator.js
// ----------------------------------------------------------------------------
// Génère yugipedia-db.json — base de cartes Yu-Gi-Oh! depuis Yugipedia.
//
// ⚡ Version d'origine : récupère uniquement les pages qui utilisent
//    Template:CardTable2 (le gros template principal utilisé par la
//    majorité des cartes). C'est ce qui donnait ~47 000 entrées.
//
// Le script fait 3 choses :
//   1. Liste toutes les pages qui utilisent le template
//   2. Télécharge leur wikitexte (le code source wiki)
//   3. Parse chaque wikitexte pour extraire les infos de la carte
//      et écrit le tout dans yugipedia-db.json
// ============================================================================

const fs = require("fs");
const https = require("https");

// ─── Configuration ──────────────────────────────────────────────────────────
const API = "https://yugipedia.com/api.php";

// Délai entre chaque requête (ms). Empêche Yugipedia de nous bloquer
// pour cause de spam. 1,2 s est un bon compromis : assez lent pour ne pas
// se faire blacklister, assez rapide pour finir en ~15 min.
const DELAY = 1200;

// Nombre de pages par requête. MediaWiki accepte jusqu'à 50 titres dans
// le paramètre `titles=A|B|C`, ce qui divise le nombre de requêtes par 50.
const BATCH = 50;

// User-Agent : MediaWiki refuse les requêtes sans UA ou avec un UA générique
// (curl, wget…). On s'identifie avec un contact pour rester courtois.
const USER_AGENT = "YGO-Card-DB-Generator/1.0 (https://github.com/kevinraphael95; kevinyugioh@gmail.com)";

// ─── Requête HTTP vers l'API MediaWiki ──────────────────────────────────────
function fetchJson(params) {
  return new Promise((resolve, reject) => {
    const url = new URL(API);
    url.searchParams.set("format", "json");
    // formatversion=2 : sortie JSON moderne (array au lieu d'objets indexés)
    url.searchParams.set("formatversion", "2");
    // origin=* : nécessaire pour CORS si appelé depuis un navigateur.
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

// ============================================================================
// ÉTAPE 1 : récupérer tous les titres de pages qui utilisent CardTable2
// ============================================================================
// L'API `list=embeddedin` liste les pages qui transclusent un template.
// C'est la façon la plus efficace de découvrir toutes les cartes sans
// deviner les noms un par un.
async function getAllCardTitles() {
  console.log("📥 Récupération des pages avec Template:CardTable2...");
  const titles = new Set();
  let cont = null;

  while (true) {
    const params = {
      action: "query",
      list: "embeddedin",              // liste les pages qui incluent un template
      eititle: "Template:CardTable2",  // template ciblé
      einamespace: "0",                // namespace principal (pas User:, Talk:…)
      eilimit: "500",                  // 500 par requête (max pour les bots)
    };
    if (cont) params.eicontinue = cont; // pagination : "reprends où on s'est arrêté"

    try {
      const data = await fetchJson(params);
      const members = data?.query?.embeddedin || [];
      for (const m of members) titles.add(m.title);
      console.log(`  → ${titles.size} titres...`);

      // MediaWiki renvoie `continue.eicontinue` tant qu'il reste des pages.
      // Quand c'est absent, on a tout récupéré.
      cont = data?.continue?.eicontinue;
      if (!cont) break;
    } catch (e) {
      console.warn("  ⚠️ Erreur:", e.message);
      break;
    }
    await sleep(DELAY);
  }
  return [...titles];
}

// ============================================================================
// ÉTAPE 2 : télécharger le wikitexte de toutes les pages, en batch de 50
// ============================================================================
// On envoie jusqu'à 50 titres dans une seule requête. MediaWiki renvoie le
// contenu de chaque page dans un tableau. 50× plus rapide qu'une page à la fois.
async function fetchWikitexts(titles) {
  console.log(`📥 Récupération du contenu de ${titles.length} pages...`);
  const results = new Map();
  let i = 0;

  for (let j = 0; j < titles.length; j += BATCH) {
    const chunk = titles.slice(j, j + BATCH);
    try {
      const data = await fetchJson({
        action: "query",
        prop: "revisions",       // on veut les révisions (historique) de chaque page
        rvprop: "content",       // seulement le contenu (pas la date, l'auteur…)
        rvslots: "main",         // le slot "main" (le wikitexte principal)
        titles: chunk.join("|"), // 50 titres séparés par |
        redirects: "1",          // suit les redirections
      });
      const pages = data?.query?.pages || [];
      for (const p of pages) {
        if (!p || p.missing) continue; // page qui n'existe pas → on skip
        // Selon la version de MediaWiki, le contenu est à un endroit
        // légèrement différent. On teste les trois structures possibles.
        const wikitext = p.revisions?.[0]?.slots?.main?.content
                      || p.revisions?.[0]?.content
                      || p.revisions?.[0]?.["*"];
        if (wikitext) results.set(p.title, wikitext);
      }
      i += chunk.length;
      console.log(`  → ${i} / ${titles.length} pages...`);
    } catch (e) {
      console.warn(`  ⚠️ Erreur batch ${j}:`, e.message);
    }
    await sleep(DELAY);
  }
  return results;
}

// ============================================================================
// ÉTAPE 3 : parsing du wikitexte
// ============================================================================

// ─── Extraire le corps d'un template {{...}} ───
// Trouve `{{CardTable2` puis compte les accolades pour trouver le }}
// correspondant. Gère les templates imbriqués ({{A|x={{B}}}}).
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
    if (two === "}}") {
      depth--;
      if (depth === 0) { endIdx = i; break; }
      i += 2; continue;
    }
    i++;
  }
  if (endIdx === null) return null;
  return wikitext.slice(startIdx + m[0].length, endIdx);
}

// ─── Parser les `|clé=valeur` du template ───
// Retourne un objet { clé: valeur } en minuscules.
// Gère les valeurs contenant des `|` (dans des templates imbriqués).
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
      if (depth === 0 && body[j] === "|") break;
      j++;
    }
    params[key.toLowerCase()] = body.slice(eqIdx + 1, j).trim();
    i = j + 1;
  }
  return params;
}

// ─── Nettoyage du wikitexte ───
// Convertit le wikitexte en texte brut lisible.
function clean(s) {
  if (!s) return null;
  return String(s)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[lien|texte]] → texte
    .replace(/\[\[([^\]]+)\]\]/g, "$1")            // [[lien]] → lien
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")     // <ref>...</ref> → vide
    .replace(/<[^>]+>/g, "")                       // autres balises HTML → vide
    .replace(/'''?/g, "")                          // '''gras''' → gras
    .replace(/&nbsp;/g, " ")                       // &nbsp; → espace
    .trim() || null;
}

// Templates à essayer, dans l'ordre. La plupart des pages utilisent
// CardTable2, mais on teste aussi les autres au cas où (sans que ça change
// la collecte des titres, seulement le parsing).
const TEMPLATES = ["CardTable2", "Anime card", "Manga card", "Video game card", "OCG card", "TCG card"];

// ─── Parser une page entière → objet carte ───
function parseCard(wikitext) {
  for (const tpl of TEMPLATES) {
    const body = extractTemplateParams(wikitext, tpl);
    if (!body) continue;
    const p = parseParams(body);

    const frName = clean(p.fr_name);
    const enName = clean(p.en_name || p.translated_name);
    if (!frName && !enName) continue;

    // ⚡ Sélection de l'image : on garde l'artwork (image_ca) en priorité,
    //    sinon le scan (image). Tu peux modifier l'ordre ici si besoin.
    const imgCA = (p.image_ca || "").trim().replace(/^.*?:/, "").replace(/^File:/i, "");
    const imgMain = (p.image || "").trim().replace(/^.*?:/, "").replace(/^File:/i, "");
    const imgEn = (p.en_image || "").trim().replace(/^.*?:/, "").replace(/^File:/i, "");
    const imgJa = (p.ja_image || "").trim().replace(/^.*?:/, "").replace(/^File:/i, "");

    // Priorité : image_ca (artwork) > image (scan) > en > ja
    const chosenImg = imgCA || imgMain || imgEn || imgJa || null;

    return {
      fr: frName,
      en: enName,
      tpl,
      id: p.passcode ? String(p.passcode).trim() : null,
      database_id: p.database_id ? String(p.database_id).trim() : null,

      // Image principale (artwork si dispo, sinon scan)
      img: chosenImg
        ? `https://yugipedia.com/wiki/Special:Redirect/file/${encodeURIComponent(chosenImg)}`
        : null,
      // Artwork isolé (si dispo) — utile pour ton app si tu veux basculer
      img_artwork: imgCA
        ? `https://yugipedia.com/wiki/Special:Redirect/file/${encodeURIComponent(imgCA)}`
        : null,
      // Scan conservé
      img_scan: imgMain
        ? `https://yugipedia.com/wiki/Special:Redirect/file/${encodeURIComponent(imgMain)}`
        : null,
      img_en: imgEn
        ? `https://yugipedia.com/wiki/Special:Redirect/file/${encodeURIComponent(imgEn)}`
        : null,
      img_ja: imgJa
        ? `https://yugipedia.com/wiki/Special:Redirect/file/${encodeURIComponent(imgJa)}`
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

// ─── Normalisation d'une chaîne pour servir de clé ───
// "Dragon Blanc aux Yeux Bleus" → "dragonblancauxyeuxbleus"
function normalize(s) {
  return String(s || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

// ============================================================================
// MAIN — orchestrateur
// ============================================================================
(async () => {
  // 1. Liste toutes les pages de cartes
  const titles = await getAllCardTitles();
  console.log(`\n✅ ${titles.length} titres collectés\n`);
  if (titles.length === 0) {
    console.error("❌ Aucun titre trouvé.");
    process.exit(1);
  }

  // 2. Télécharge les wikitextes
  const wikitexts = await fetchWikitexts(titles);
  console.log(`\n✅ ${wikitexts.size} wikitexts récupérés\n`);

  // 3. Parse chaque page
  console.log("🔄 Parsing...");
  const db = {};
  let count = 0;
  let withArtwork = 0, withScanOnly = 0;

  for (const [title, wt] of wikitexts) {
    const card = parseCard(wt);
    if (!card) continue;
    const key = normalize(card.fr || card.en);
    if (!key) continue;
    if (!db[key]) {
      db[key] = card;
      count++;
      if (card.img_artwork) withArtwork++;
      else if (card.img) withScanOnly++;
    }
  }

  console.log(`✅ ${count} cartes parsées`);
  console.log(`   🎨 ${withArtwork} avec artwork`);
  console.log(`   📷 ${withScanOnly} avec scan uniquement`);

  // 4. Écrit le JSON
  const json = JSON.stringify(db, null, 2);
  fs.writeFileSync("yugipedia-db.json", json);
  console.log(`\n💾 yugipedia-db.json généré : ${(json.length / 1024 / 1024).toFixed(2)} Mo`);
})();
