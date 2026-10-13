// ============================================================================
// 06-json-builder.js — Génération du JSON ygopro.org (+ gestion des Pendules)
// ============================================================================

// ============================================================================
// 🔮 PENDULE — sépare "effet Pendule" et "effet de Monstre"
// ============================================================================
// La base (cards-db.json) ne fournit que `desc` : l'effet Pendule et l'effet de
// monstre y sont collés. On les coupe ici pour remplir pendulum.effect (Pendule)
// et effect (Monstre). Gère aussi les cartes venant d'un .cdb (échelle cachée
// dans le level, frameType sans "pendulum").
// ============================================================================
const PEND_HEAD = /\[\s*(?:Pendulum Effect|Effet Pendule|Effet de Pendule)\s*\]/i;
const MON_HEAD = /\[\s*(?:Monster Effect|Flavor Text|Effet de Monstre|Effet Monstre|Texte d['’]ambiance)\s*\]/i;
const SCALE_RE = /(?:Pendulum Scale|[ÉE]chelle Pendule|[ÉE]chelle)\s*=\s*(\d+)/i;

function cleanPendPart(s) {
  return String(s || "")
    .replace(/^[-=_\s]{5,}$/gm, " ")
    .replace(/(?:\s*◆\s*){3}/g, " ")
    .replace(/(?:Pendulum Scale|[ÉE]chelle Pendule|[ÉE]chelle)\s*=\s*\d+/gi, "")
    .replace(/\[\s*(?:VAACT|VAN|VNM|VSYN|VXYZ|VLINK|VRIT)\s*\]/gi, "")
    .replace(/\[\s*(?:Pendulum Effect|Effet Pendule|Effet de Pendule)\s*\]\s*:?/gi, "")
    .replace(/\[\s*(?:Monster Effect|Flavor Text|Effet de Monstre|Effet Monstre|Texte d['’]ambiance)\s*\]\s*:?/gi, "")
    .replace(/^[\s|:-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitPendulumDesc(desc) {
  if (typeof desc !== "string") return null;
  const pm = desc.match(PEND_HEAD);
  let scale = null;
  const sm = desc.match(SCALE_RE);
  if (sm) scale = parseInt(sm[1], 10);

  let pendText = "";
  let monText = "";

  if (pm) {
    // Cas normal : en-têtes [ Effet Pendule ] / [ Effet de Monstre ]
    const mm = desc.match(MON_HEAD);
    const pendStart = pm.index + pm[0].length;
    if (mm && mm.index > pm.index) {
      pendText = desc.slice(pendStart, mm.index);
      monText = desc.slice(mm.index + mm[0].length);
    } else {
      pendText = desc.slice(pendStart);
    }
  } else {
    // Sans en-têtes : on coupe seulement s'il y a un vrai saut de paragraphe.
    // Sinon on ne devine pas : tout va dans l'effet de monstre.
    const paragraphs = desc.split(/\r?\n\s*\r?\n/).filter((x) => x.trim());
    if (paragraphs.length >= 2) {
      pendText = paragraphs[0];
      monText = paragraphs.slice(1).join("\n\n");
    } else {
      monText = desc;
    }
  }

  return { pend: cleanPendPart(pendText), monster: cleanPendPart(monText), scale };
}

function normalizePendulum(card) {
  if (!card || card.type === "Spell Card" || card.type === "Trap Card") return card;

  const frame = card.frameType || "";
  const levelRaw = typeof card.level === "number" ? card.level : parseInt(card.level, 10);
  const levelHasScale = Number.isFinite(levelRaw) && levelRaw > 255; // .cdb : échelles dans les bits hauts

  const isPend =
    frame.includes("pendulum") ||
    String(card.type || "").includes("Pendulum") ||
    PEND_HEAD.test(String(card.desc || "")) ||
    levelHasScale;

  if (!isPend) return card;

  const sp = splitPendulumDesc(card.desc);

  let pend = card.pend_desc;
  let mon = card.monster_desc;
  let scale = card.scale;
  let level = card.level;

  if (sp) {
    if (!pend) pend = sp.pend;
    if (!mon) mon = sp.monster;
    if ((scale === undefined || scale === null) && sp.scale !== null) scale = sp.scale;
  }
  if (levelHasScale) {
    if (scale === undefined || scale === null) scale = (levelRaw >> 24) & 0xff;
    level = levelRaw & 0xff;
  }

  const base = (frame || "effect").split("_")[0];
  return {
    ...card,
    frameType: base + "_pendulum",
    pend_desc: cleanPendPart(pend || ""),
    monster_desc: cleanPendPart(mon || ""),
    scale: scale ?? 0,
    level,
    desc: cleanPendPart(mon || card.desc),
  };
}

// ============================================================================
// GÉNÉRATION JSON
// ============================================================================
async function generateJsonForCard(card, overrideName, providedStructural) {
  if (card._source === "yugipedia") {
    return buildYgoproJson({
      ...card,
      name: overrideName || card.name,
      desc: card.desc || card._descs?.fr || card._descs?.en || "",
    });
  }
  let structural = providedStructural || structuralCardCache.get(card.id);
  if (!structural) {
    try {
      structural = (await getCardById(card.id, null)) || card;
      cacheStructural(card.id, structural);
    } catch (err) { structural = card; }
  }
  const merged = {
    ...structural,
    name: overrideName || card.name,
    desc: card.desc,
    pend_desc: card.pend_desc,
    monster_desc: card.monster_desc,
    displayRace: card.race,
  };
  return buildYgoproJson(merged);
}

function cacheStructural(id, card) {
  if (structuralCardCache.size >= MAX_STRUCTURAL_CACHE) {
    const firstKey = structuralCardCache.keys().next().value;
    structuralCardCache.delete(firstKey);
  }
  structuralCardCache.set(id, card);
}

function buildYgoproJson(card) {
  card = normalizePendulum(card); // 🔮 sépare effet Pendule / effet Monstre
  const isSpell = card.type === "Spell Card";
  const isTrap = card.type === "Trap Card";
  const [baseFrame, pendulumSuffix] = (card.frameType || "").split("_");
  const isPendulum = pendulumSuffix === "pendulum";
  const isLink = baseFrame === "link";
  return {
    version: "1.0.0",
    name: card.name,
    level: String(card.level || card.linkval || 0),
    type: buildTypeLine(card),
    icon: buildIcon(card),
    effect: buildEffectText(card),
    atk: isSpell || isTrap ? "" : String(card.atk ?? "0"),
    def: isSpell || isTrap || isLink ? "" : String(card.def ?? "0"),
    serial: "",
    copyright: "© 2026 YGOPRO.ORG",
    attribute: buildAttribute(card),
    id: String(card.id || ""),
    rarity: "common",
    pendulum: {
      enabled: isPendulum,
      effect: isPendulum ? cleanPendPart(card.pend_desc) : "",
      blue: isPendulum ? String(card.scale ?? "0") : "0",
      red: isPendulum ? String(card.scale ?? "0") : "0",
      boxSize: "Normal",
      boxSizeEnabled: true,
    },
    variant: "Normal",
    link: buildLinkMarkers(card),
    layout: buildLayout(baseFrame),
    boxSize: (card.desc || "").length > 300 ? "Small" : "Normal",
  };
}

const FRAME_TO_LAYOUT = { normal: "Normal", effect: "Effect", ritual: "Ritual", fusion: "Fusion", synchro: "Synchro", xyz: "Xyz", link: "Link", token: "Token", spell: "Spell", trap: "Trap", skill: "Skill" };
function buildLayout(baseFrame) { return FRAME_TO_LAYOUT[baseFrame] || "Effect"; }

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
function translateRace(race) { return RACE_FR[race] || race; }

const ABILITY_FR = {
  Effect: "Effet", Normal: "Normal", Fusion: "Fusion", Synchro: "Synchro",
  Xyz: "Xyz", Ritual: "Rituel", Link: "Lien", Tuner: "Syntoniseur",
  Flip: "Retournement", Spirit: "Esprit", Union: "Union", Toon: "Toon",
  Gemini: "Gémeau", Pendulum: "Pendule",
};
function translateAbilities(entries) { return entries.map((e) => ABILITY_FR[e] || e); }

function buildTypeLine(card) {
  if (card.type === "Spell Card") return "Carte Magie";
  if (card.type === "Trap Card") return "Carte Piège";
  const displayRace = translateRace(card.race);
  let line;
  if (Array.isArray(card.typeline) && card.typeline.length) {
    line = [displayRace, ...translateAbilities(card.typeline.slice(1))].join("/");
  } else {
    const abilities = [];
    const t = card.type;
    if (t.includes("Ritual")) abilities.push("Ritual");
    if (t.includes("Fusion")) abilities.push("Fusion");
    if (t.includes("Synchro")) abilities.push("Synchro");
    if (t.includes("XYZ")) abilities.push("Xyz");
    if (t.includes("Link")) abilities.push("Link");
    if (t.includes("Gemini")) abilities.push("Gemini");
    if (t.includes("Spirit")) abilities.push("Spirit");
    if (t.includes("Union")) abilities.push("Union");
    if (t.includes("Toon")) abilities.push("Toon");
    if (t.includes("Flip")) abilities.push("Flip");
    if (t.includes("Tuner")) abilities.push("Tuner");
    if (t.includes("Effect") && !abilities.length) abilities.push("Effect");
    if (t === "Normal Monster") abilities.push("Normal");
    if (!abilities.length) abilities.push("Effect");
    line = `${displayRace}/${translateAbilities(abilities).join("/")}`;
  }

  // 🔮 Pendule : ajoute "Pendule" → Magicien/Synchro/Pendule/Effet
  const isPend =
    String(card.frameType || "").includes("pendulum") ||
    String(card.type || "").includes("Pendulum");
  if (isPend) {
    const parts = line.split("/");
    if (!parts.includes("Pendule")) {
      const last = parts[parts.length - 1];
      if (parts.length > 1 && (last === "Effet" || last === "Normal")) {
        parts.splice(parts.length - 1, 0, "Pendule");
      } else {
        parts.push("Pendule");
      }
      line = parts.join("/");
    }
  }
  return line;
}

const RACE_TO_ICON = { Continuous: "Continuous", Counter: "Counter", Equip: "Equip", Field: "Field", "Quick-Play": "Quick-play", Ritual: "Ritual", Normal: "None" };
function buildIcon(card) {
  if (card.type === "Spell Card" || card.type === "Trap Card") return RACE_TO_ICON[card.race] || "None";
  return "None";
}

function buildAttribute(card) {
  if (card.type === "Spell Card") return "Spell";
  if (card.type === "Trap Card") return "Trap";
  if (!card.attribute) return "Light";
  return card.attribute.charAt(0) + card.attribute.slice(1).toLowerCase();
}

function buildEffectText(card) {
  // Carte Pendule : monster_desc est déjà propre. Autres cartes : texte brut d'origine.
  let text = card.monster_desc || card.desc || "";
  text = text.replace(/^[#=*\-_\s]{3,}$/gm, " ◆ ◆ ◆ ");
  text = text.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ");
  text = text.replace(/\s+/g, " ");
  text = text.replace(/(\s*●\s*)+/g, " ● ");
  text = text.replace(/^\s*●\s*/, "").replace(/\s*●\s*$/, "");
  return text.trim();
}

function buildLinkMarkers(card) {
  const base = { topLeft: false, topCenter: false, topRight: false, middleLeft: false, middleRight: false, bottomLeft: false, bottomCenter: false, bottomRight: false };
  if (!card.linkmarkers) return base;
  const map = { "Top-Left": "topLeft", Top: "topCenter", "Top-Right": "topRight", Left: "middleLeft", Right: "middleRight", "Bottom-Left": "bottomLeft", Bottom: "bottomCenter", "Bottom-Right": "bottomRight" };
  card.linkmarkers.forEach((m) => { const k = map[m]; if (k) base[k] = true; });
  return base;
}
