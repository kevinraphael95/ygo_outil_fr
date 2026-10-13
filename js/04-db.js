// ============================================================================
// 04-db.js — Chargement des 2 fichiers JSON locaux (YGOPRODeck + Yugipedia)
// ============================================================================

// ============================================================================
// Clés de recherche d'illustration (partagées avec 07-csv.js)
// ============================================================================
function artKey(n) {
  return normalizeForSearch(n).replace(/[^a-z0-9]/g, "");
}

// Noms de carte possibles déduits du nom de fichier d'un scan Yugipedia.
// "…/file/Blue-EyesWhiteDragon-LOB-EN-UR-1E.png" → ["blueeyeswhitedragonlob…", "blueeyeswhitedragon", "blue"]
// (du plus long au plus court). Ignore les images d'anime / manga (cartes différentes).
function scanNameKeys(url) {
  if (!url) return [];
  let file = String(url).split("/").pop().split("?")[0];
  try { file = decodeURIComponent(file); } catch (e) {}
  file = file.replace(/\.[a-z0-9]+$/i, "");
  if (/-(?:Anime|Manga|Game|Artwork)/i.test(file)) return [];
  const out = [];
  for (let i = file.length - 1; i > 0; i--) {
    if (file[i] === "-") {
      const k = artKey(file.slice(0, i));
      if (k && !out.includes(k)) out.push(k);
    }
  }
  return out;
}

async function initDatabase() {
  try {
    // ─── 1. cards-db.json (YGOPRODeck) ───
    try {
      console.log("[DB] Chargement cards-db.json…");
      const res = await fetch(JSON_CARDS_DB);
      if (res.ok) {
        const cardsDb = await res.json();
        let count = 0;
        for (const [id, card] of Object.entries(cardsDb)) {
          const imgArray = card.img_cropped ? [{
            id: parseInt(id, 10),
            image_url: card.img_full,
            image_url_cropped: card.img_cropped,
          }] : [];

          memCacheEn.set(String(id), {
            id: parseInt(id, 10),
            name: card.en,
            type: card.type, frameType: card.frameType,
            desc: card.desc_en,
            atk: card.atk, def: card.def, level: card.level,
            race: card.race, attribute: card.attribute,
            linkval: card.linkval, linkmarkers: card.linkmarkers,
            scale: card.scale,
            card_images: imgArray,
          });

          if (card.fr) {
            memCacheFr.set(String(id), {
              id: parseInt(id, 10),
              name: card.fr,
              type: card.type, frameType: card.frameType,
              desc: card.desc_fr,
              atk: card.atk, def: card.def, level: card.level,
              race: card.race, attribute: card.attribute,
              linkval: card.linkval, linkmarkers: card.linkmarkers,
              scale: card.scale,
              card_images: imgArray,
            });
          }
          count++;
        }
        console.log(`[DB] ✅ cards-db.json : ${count} cartes`);
      } else {
        console.warn(`[DB] cards-db.json HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn("[DB] cards-db.json indisponible :", e.message);
    }

    // ─── 2. yugipedia-db.json (Yugipedia) ───
    try {
      console.log("[DB] Chargement yugipedia-db.json…");
      const res = await fetch(JSON_YUGIPEDIA_DB);
      if (res.ok) {
        const yugiDb = await res.json();
        let count = 0;
        for (const [key, card] of Object.entries(yugiDb)) {
          if (!card.en && !card.fr) continue;
          window.yugiCache.set(key, card);
          count++;
        }
        console.log(`[DB] ✅ yugipedia-db.json : ${count} cartes`);
      } else {
        console.warn(`[DB] yugipedia-db.json HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn("[DB] yugipedia-db.json indisponible :", e.message);
    }

    // ─── 2b. Yugipedia → illustration YGOPRODeck ───
    // Yugipedia ne fournit que le SCAN de la carte entière (cadre + nom). Quand la
    // même carte existe dans YGOPRODeck, on utilise son illustration recadrée.
    // On retrouve la carte par : nom EN Yugipedia, clé de l'entrée, ou nom contenu
    // dans le nom de fichier du scan (ex. SalamandratheFlyingFlameDragon-MZMI-EN-SR-1E.png).
    // Le scan d'origine est gardé dans `img_scan`.
    try {
      const croppedByEnName = new Map();
      for (const c of memCacheEn.values()) {
        const url = c.card_images && c.card_images[0] && c.card_images[0].image_url_cropped;
        const k = artKey(c.name);
        if (url && k) croppedByEnName.set(k, url);
      }
      let swapped = 0;
      for (const [key, card] of window.yugiCache.entries()) {
        const cands = [artKey(card.en), key, ...scanNameKeys(card.img)];
        let url = null;
        for (const k of cands) {
          if (k && croppedByEnName.has(k)) { url = croppedByEnName.get(k); break; }
        }
        if (!url) continue;
        if (!card.img_scan) card.img_scan = card.img || card.img_en || "";
        card.img = url;
        card.img_en = url;
        swapped++;
      }
      console.log(`[DB] 🖼️ ${swapped} illustration(s) YGOPRODeck utilisées à la place du scan Yugipedia`);
    } catch (e) {
      console.warn("[DB] Association illustrations Yugipedia → YGOPRODeck échouée :", e.message);
    }

    // ─── 3. Exposition ───
    window.memCacheEn = memCacheEn;
    window.memCacheFr = memCacheFr;

    // ─── 4. UI ───
    appState.dbReady = memCacheEn.size > 0 || memCacheFr.size > 0;
    if (appState.dbReady) {
      updateDbBadge(memCacheEn.size, memCacheFr.size);
      console.log(`[DB] 🎯 Prêt : ${memCacheEn.size} EN, ${memCacheFr.size} FR`);
    }
  } catch (err) {
    console.error("[DB] Init échouée", err);
    appState.dbReady = false;
  }
}

function updateDbBadge(countEn, countFr) {
  if (!dbBadge) return;
  const countYugi = window.yugiCache ? window.yugiCache.size : 0;
  dbBadge.classList.remove("hidden");
  dbBadge.innerHTML = `🟢 YGOPRODeck · ${countEn.toLocaleString("fr-FR")} · 🟣 Yugipedia · ${countYugi.toLocaleString("fr-FR")}`;
  dbBadge.title = `${countEn} cartes YGOPRODeck (EN), ${countFr} FR, ${countYugi} Yugipedia`;
}
