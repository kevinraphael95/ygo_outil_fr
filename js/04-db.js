// ============================================================================
// 04-db.js — Chargement des 2 fichiers JSON locaux (YGOPRODeck + Yugipedia)
// ============================================================================

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
