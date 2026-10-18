#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
find_vaact_scripts_overwrite.py
===============================
À lancer depuis C:\\ProjectIgnis :  python find_vaact_scripts_overwrite.py

Rôle
----
Pour chaque carte de "VAACT S1.cdb" taguée [VAACT] (effet modifié par rapport
à l'officielle), le script :
  1. cherche la carte officielle du même nom (dans tous les autres .cdb) ;
  2. copie son script Lua en remplaçant l'ID officiel par l'ID VAACT ;
  3. (optionnel) ajoute en première ligne un commentaire rappelant l'origine
     du script, pour savoir qu'il reste à modifier ;
  4. écrit le résultat dans OUT_DIR (jamais dans "script").

Les cartes non taguées (identiques à l'officielle) sont ignorées : pour elles,
utiliser find_and_identify_scripts.py.
"""

import os
import re
import sqlite3

# ============================================================
# CHEMINS
# ============================================================
BASE = r"C:\ProjectIgnis"
VAACT_DIR = os.path.join(BASE, "expansions", "VAACT")
CDB_EN = os.path.join(VAACT_DIR, "VAACT S1.cdb")
CDB_FR = os.path.join(BASE, "config", "languages", "Français", "VAACT S1.cdb")
LUA_ROOT = os.path.join(BASE, "script")  # scripts officiels (+ sous-dossiers)
SCRIPT_DIR = os.path.join(VAACT_DIR, "script")      # lecture seule
OUT_DIR = os.path.join(BASE, "testscripts", "modified")  # seul dossier modifié
REPORT_PATH = os.path.join(BASE, "rapport_scripts_vaact.txt")

# ============================================================
# OPTIONS
# ============================================================
DRY_RUN = False          # True = affiche seulement, ne crée rien
SKIP_EXISTING = False    # True = ignore les cartes qui ont déjà un script dans "script"
FORCE_OVERWRITE = False  # True = écrase les scripts déjà présents dans OUT_DIR
ADD_HEADER_COMMENT = True  # True  = ajoute le commentaire d'origine en 1re ligne
                           # False = copie le script officiel tel quel


# ============================================================
# OUTILS
# ============================================================
def norm(s):
    """Normalise un nom de carte : minuscules, espaces simplifiés."""
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def read(path):
    """Lit un fichier texte en UTF-8 (caractères invalides remplacés)."""
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def same(a, b):
    """Compare deux chemins sans tenir compte de la casse (Windows)."""
    return os.path.abspath(a).lower() == os.path.abspath(b).lower()


# ============================================================
# 1) CARTES VAACT (nom anglais + descriptions EN et FR)
# ============================================================
def load_vaact_cards():
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

    return custom, descs


# ============================================================
# 2) CARTES ET SCRIPTS OFFICIELS
# ============================================================
def load_official(custom):
    """
    Retourne :
      official : {nom normalisé: {ids officiels}}
      lua      : {id officiel: chemin du cXXXX.lua}
    """
    official, lua = {}, {}
    lua_root_abs = os.path.abspath(LUA_ROOT).lower() + os.sep

    # Les .cdb sont cherchés partout dans BASE (noms des cartes) ;
    # les .lua uniquement dans LUA_ROOT (scripts officiels).
    for root, _, files in os.walk(BASE):
        root_abs = os.path.abspath(root).lower() + os.sep
        in_lua_root = root_abs.startswith(lua_root_abs)
        # Un script du dossier "official" est prioritaire sur les variantes
        # (goat, pre-errata, rush, skill...) qui ont le même ID.
        is_official = in_lua_root and any(
            part.lower() == "official" for part in root.split(os.sep)
        )
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

            elif in_lua_root:
                m = re.fullmatch(r"c(\d+)\.lua", f)
                if m:
                    i = int(m.group(1))
                    if i not in lua or is_official:
                        lua[i] = p

    return official, lua


# ============================================================
# 3) GÉNÉRATION DU SCRIPT
# ============================================================
def build(cid, oid, name, lua):
    """
    Construit le script de la carte VAACT `cid` à partir du script officiel `oid`.

    Note : le remplacement de l'ID par regex touche tous les nombres identiques
    à l'ID officiel dans le script. Vérifie le résultat en cas de doute.
    """
    code = read(lua[oid])
    code = re.sub(rf"\bc{oid}\b", f"c{cid}", code)
    code = re.sub(rf"\b{oid}\b", str(cid), code)

    if ADD_HEADER_COMMENT:
        header = f"--[VAACT] base copiée de c{oid}.lua ({name}) - à modifier\n"
        code = header + code
    return code


# ============================================================
# 4) PROGRAMME PRINCIPAL
# ============================================================
def main():
    custom, descs = load_vaact_cards()
    official, lua = load_official(custom)

    # Scripts déjà présents dans le dossier "script" (lecture seule)
    has_script = set()
    if os.path.isdir(SCRIPT_DIR):
        for f in os.listdir(SCRIPT_DIR):
            m = re.fullmatch(r"c(\d+)\.lua", f)
            if m:
                has_script.add(int(m.group(1)))

    if not DRY_RUN:
        os.makedirs(OUT_DIR, exist_ok=True)

    rapport = []
    ok = deja = 0

    for cid, name in sorted(custom.items()):
        # Uniquement les cartes taguées [VAACT]
        if not any("vaact" in d.lower() for d in descs[cid]):
            continue

        out_path = os.path.join(OUT_DIR, f"c{cid}.lua")

        # --- Script déjà présent dans "script" -------------------------
        if SKIP_EXISTING and cid in has_script and not FORCE_OVERWRITE:
            deja += 1
            continue

        # --- Fichier déjà généré dans OUT_DIR --------------------------
        if os.path.exists(out_path) and not FORCE_OVERWRITE:
            print(f"{cid} {name} : déjà dans {os.path.basename(OUT_DIR)} (ignoré)")
            deja += 1
            continue

        # --- Aucun équivalent officiel ---------------------------------
        cands = sorted(o for o in official.get(norm(name), []) if o in lua)
        if not cands:
            rapport.append(f"{cid} | {name} | aucun script officiel trouvé")
            continue

        oid = cands[0]
        print(f"{cid} {name}  <-  c{oid}.lua")
        if not DRY_RUN:
            with open(out_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(build(cid, oid, name, lua))
        ok += 1

    # --- Rapport ----------------------------------------------------------
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport))

    # --- Résumé -----------------------------------------------------------
    print(f"\n{ok} scripts {'à copier' if DRY_RUN else 'copiés'} "
          f"dans {os.path.basename(OUT_DIR)}")
    print(f"{deja} cartes [VAACT] ignorées (script déjà présent ou existant)")
    print(f"{len(rapport)} sans équivalent officiel ({os.path.basename(REPORT_PATH)})")


if __name__ == "__main__":
    main()
