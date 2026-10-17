# find_official_scripts.py - à lancer dans C:\ProjectIgnis (python find_official_scripts.py)
import os, re, sqlite3

BASE = r"C:\ProjectIgnis"
VAACT_DIR = os.path.join(BASE, "expansions", "VAACT")
CDB_EN = os.path.join(VAACT_DIR, "VAACT S1.cdb")
CDB_FR = os.path.join(BASE, "config", "languages", "Français", "VAACT S1.cdb")
SCRIPT_DIR = os.path.join(VAACT_DIR, "script")      # lecture seule (sauf si FORCE_OVERWRITE)
OUT_DIR = os.path.join(VAACT_DIR, "testscript")     # seul dossier modifié

# === OPTIONS ===
DRY_RUN = False            # True = affiche seulement, ne crée rien
DELETE_BAD = False         # True = supprime de testscript les copies faites par erreur sur des cartes [VAACT]
FORCE_OVERWRITE = False    # True = ÉCRASE les scripts existants (même s'ils sont déjà dans 'script' ou 'testscript')

def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())

def read(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()

def same(a, b):
    return os.path.abspath(a).lower() == os.path.abspath(b).lower()

# 1) cartes VAACT : nom anglais + descriptions EN et FR
custom, descs = {}, {}
con = sqlite3.connect(CDB_EN)
for cid, name, desc in con.execute("SELECT id, name, desc FROM texts"):
    custom[cid] = name
    descs[cid] = [desc or ""]
con.close()

if os.path.exists(CDB_FR):
    con = sqlite3.connect(CDB_FR)
    for cid, desc in con.execute("SELECT id, desc FROM texts"):
        if cid in descs:
            descs[cid].append(desc or "")
    con.close()
else:
    print("ATTENTION : cdb français introuvable :", CDB_FR)

# 2) cartes et scripts officiels (tout sauf les fichiers VAACT)
official, lua = {}, {}
vaact_dir_abs = os.path.abspath(VAACT_DIR).lower()
for root, _, files in os.walk(BASE):
    in_vaact = os.path.abspath(root).lower().startswith(vaact_dir_abs)
    for f in files:
        p = os.path.join(root, f)
        if f.lower().endswith(".cdb"):
            if same(p, CDB_EN) or same(p, CDB_FR):
                continue
            try:
                con = sqlite3.connect(p)
                for oid, name in con.execute("SELECT id, name FROM texts"):
                    if oid not in custom:
                        official.setdefault(norm(name), set()).add(oid)
                con.close()
            except Exception as e:
                print("ignoré", p, e)
        elif not in_vaact:
            m = re.fullmatch(r"c(\d+)\.lua", f)
            if m and int(m.group(1)) not in lua:
                lua[int(m.group(1))] = p

# ============================================================
# AJOUT : Fonction pour injecter l'EFFECT_ADD_CODE dans le code
# ============================================================
def inject_add_code(code, oid):
    """
    Injecte l'effet EFFECT_ADD_CODE juste après la déclaration de initial_effect.
    """
    pattern = r"(function\s+s\.initial_effect\s*\(\s*c\s*\))"
    replacement = r"""\1
	-- === AJOUT AUTO : Considérée comme la carte officielle (ID %d) ===
	local e_add_code = Effect.CreateEffect(c)
	e_add_code:SetType(EFFECT_TYPE_SINGLE)
	e_add_code:SetCode(EFFECT_ADD_CODE)
	e_add_code:SetProperty(EFFECT_FLAG_CANNOT_DISABLE+EFFECT_FLAG_UNCOPYABLE)
	e_add_code:SetValue(%d)
	c:RegisterEffect(e_add_code)
	-- ================================================================""" % (oid, oid)
    
    new_code, count = re.subn(pattern, replacement, code, count=1)
    if count == 0:
        print(f"  ATTENTION: impossible d'injecter dans le script (pas de initial_effect trouvé)")
    return new_code

# ============================================================
# MODIFICATION : La fonction build() appelle inject_add_code()
# ============================================================
def build(cid, oid):
    code = read(lua[oid])
    code = re.sub(rf"\bc{oid}\b", f"c{cid}", code)
    code = re.sub(rf"\b{oid}\b", str(cid), code)
    code = inject_add_code(code, oid)
    return code

# scripts déjà présents dans script
has_script = set()
if os.path.isdir(SCRIPT_DIR):
    for f in os.listdir(SCRIPT_DIR):
        m = re.fullmatch(r"c(\d+)\.lua", f)
        if m:
            has_script.add(int(m.group(1)))

if not DRY_RUN:
    os.makedirs(OUT_DIR, exist_ok=True)

# 3) traitement
rapport, bad, ok, skipped = [], [], 0, 0
for cid, name in sorted(custom.items()):
    tagged = any("vaact" in d.lower() for d in descs[cid])
    cands = sorted(o for o in official.get(norm(name), []) if o in lua)

    # Gestion des cartes [VAACT]
    if tagged and not FORCE_OVERWRITE:
        skipped += 1
        p = os.path.join(OUT_DIR, f"c{cid}.lua")
        if os.path.exists(p) and any(read(p) == build(cid, o) for o in cands):
            bad.append((cid, name, p))
        continue

    # Gestion des scripts existants (si FORCE_OVERWRITE est False)
    if cid in has_script and not FORCE_OVERWRITE:
        print(f"{cid} {name} : script existant (ignoré)")
        continue

    if not cands:
        rapport.append(f"{cid} | {name} | aucun script officiel trouvé")
        continue
        
    oid = cands[0]
    print(f"{cid} {name}  <-  c{oid}.lua")
    
    if not DRY_RUN:
        with open(os.path.join(OUT_DIR, f"c{cid}.lua"), "w", encoding="utf-8", newline="\n") as f:
            f.write(build(cid, oid))
    ok += 1

print("\n--- copies auto faites par erreur sur des cartes [VAACT] (dans testscript) ---")
for cid, name, p in bad:
    print(cid, name, "->", p)
    if DELETE_BAD and not DRY_RUN:
        os.remove(p)

with open(os.path.join(BASE, "rapport_scripts.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(rapport))

print(f"\n{skipped} cartes [VAACT] ignorées")
print(f"{ok} scripts {'à copier' if DRY_RUN else 'copiés'}, {len(rapport)} sans correspondance (rapport_scripts.txt)")
print(f"{len(bad)} mauvaise(s) copie(s) {'supprimée(s)' if (DELETE_BAD and not DRY_RUN) else 'trouvée(s)'}")