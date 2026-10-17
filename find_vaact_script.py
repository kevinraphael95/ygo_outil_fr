# find_scripts_vaact.py - à lancer dans C:\ProjectIgnis (python find_scripts_vaact.py)
import os, re, sqlite3

BASE = r"C:\ProjectIgnis"
VAACT_DIR = os.path.join(BASE, "expansions", "VAACT")
CDB_EN = os.path.join(VAACT_DIR, "VAACT S1.cdb")
CDB_FR = os.path.join(BASE, "config", "languages", "Français", "VAACT S1.cdb")
SCRIPT_DIR = os.path.join(VAACT_DIR, "script")        # lecture seule
OUT_DIR = os.path.join(VAACT_DIR, "testscript2")      # seul dossier modifié

DRY_RUN = False          # True = affiche seulement, ne crée rien
SKIP_EXISTING = True    # True = ignore les cartes qui ont déjà un script dans "script"

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

def build(cid, oid, name):
    code = read(lua[oid])
    code = re.sub(rf"\bc{oid}\b", f"c{cid}", code)
    code = re.sub(rf"\b{oid}\b", str(cid), code)
    return f"--[VAACT] base copiée de c{oid}.lua ({name}) - à modifier\n" + code

# scripts déjà présents dans script (lecture seule)
has_script = set()
if os.path.isdir(SCRIPT_DIR):
    for f in os.listdir(SCRIPT_DIR):
        m = re.fullmatch(r"c(\d+)\.lua", f)
        if m:
            has_script.add(int(m.group(1)))

if not DRY_RUN:
    os.makedirs(OUT_DIR, exist_ok=True)

# 3) uniquement les cartes [VAACT]
rapport, ok, deja = [], 0, 0
for cid, name in sorted(custom.items()):
    if not any("vaact" in d.lower() for d in descs[cid]):
        continue
    if SKIP_EXISTING and cid in has_script:
        deja += 1
        continue
    cands = sorted(o for o in official.get(norm(name), []) if o in lua)
    if not cands:
        rapport.append(f"{cid} | {name} | aucun script officiel trouvé")
        continue
    oid = cands[0]
    print(f"{cid} {name}  <-  c{oid}.lua")
    if not DRY_RUN:
        with open(os.path.join(OUT_DIR, f"c{cid}.lua"), "w", encoding="utf-8", newline="\n") as f:
            f.write(build(cid, oid, name))
    ok += 1

with open(os.path.join(BASE, "rapport_scripts_vaact.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(rapport))

print(f"\n{ok} scripts {'à copier' if DRY_RUN else 'copiés'} dans testscript2")
print(f"{deja} cartes [VAACT] ignorées (script déjà présent dans script)")
print(f"{len(rapport)} sans équivalent officiel (rapport_scripts_vaact.txt)")