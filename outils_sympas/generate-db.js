const fs = require("fs");
const https = require("https");

const API = "https://db.ygoprodeck.com/api/v7/cardinfo.php";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

(async () => {
  console.log("📥 Téléchargement EN...");
  const en = await fetchJson(API);
  console.log(`  → ${en.data.length} cartes EN`);

  console.log("📥 Téléchargement FR...");
  const fr = await fetchJson(API + "?language=fr");
  console.log(`  → ${fr.data.length} cartes FR`);

  // Index FR par ID
  const frById = new Map();
  fr.data.forEach((c) => frById.set(String(c.id), c));

  // Fusion
  const merged = {};
  en.data.forEach((c) => {
    const id = String(c.id);
    const frCard = frById.get(id);
    merged[id] = {
      fr: frCard ? frCard.name : null,
      en: c.name,
      type: c.type,
      frameType: c.frameType,
      desc_fr: frCard ? frCard.desc : null,
      desc_en: c.desc,
      atk: c.atk ?? null,
      def: c.def ?? null,
      level: c.level ?? null,
      race: c.race || null,
      attribute: c.attribute || null,
      linkval: c.linkval ?? null,
      linkmarkers: c.linkmarkers || null,
      scale: c.scale ?? null,
      img_cropped: `https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`,
      img_full: `https://images.ygoprodeck.com/images/cards/${id}.jpg`,
    };
  });

  const json = JSON.stringify(merged, null, 2);
  fs.writeFileSync("cards-db.json", json);
  console.log(`✅ cards-db.json généré (${(json.length / 1024 / 1024).toFixed(2)} Mo)`);
})();
