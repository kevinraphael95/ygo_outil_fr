#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
find_official_scripts.py
============================
À lancer depuis C:\\ProjectIgnis :  python find_official_scripts.py

Rôle
----
Pour chaque carte custom de "VAACT S1.cdb" qui n'est PAS taguée [VAACT]
(= identique à la carte officielle), le script :
  1. cherche la carte officielle du même nom (dans tous les autres .cdb) ;
  2. copie son script Lua en remplaçant l'ID officiel par l'ID VAACT ;
  3. (optionnel) injecte un EFFECT_ADD_CODE pour que la carte custom soit
     considérée comme la carte officielle en jeu ;
  4. écrit le résultat dans OUT_DIR (jamais dans "script").

Les cartes taguées [VAACT] (effet modifié) sont ignorées : pour elles,
utiliser find_vaact_scripts_overwrite.py.
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
SCRIPT_DIR = os.path.join(VAACT_DIR, "script")     # lecture seule
OUT_DIR = os.path.join(BASE, "testscripts", "officiel")  # seul dossier modifié
REPORT_PATH = os.path.join(BASE, "rapport_scripts.txt")

# ============================================================
# OPTIONS
# ============================================================
DRY_RUN = False          # True  = affiche seulement, ne crée rien
DELETE_BAD = False       # True  = supprime de OUT_DIR les copies faites par erreur
                         #         sur des cartes [VAACT]
FORCE_OVERWRITE = False  # True  = ÉCRASE les scripts existants (dans 'script' et
                         #         OUT_DIR) et traite aussi les cartes [VAACT]
ADD_OFFICIAL_CODE = True # True  = injecte EFFECT_ADD_CODE (la carte custom est
                         #         considérée comme la carte officielle)
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
# Accepte "function s.initial_effect(c)" (scripts récents)
# ainsi que "function c123.initial_effect(c)" (anciens scripts,
# déjà renommés en cID_VAACT au moment de l'injection).
INITIAL_EFFECT_RE = re.compile(
    r"(function\s+(?:s|c\d+)\.initial_effect\s*\(\s*c\s*\))"
)

ADD_CODE_TEMPLATE = """
\t-- === AJOUT AUTO : considérée comme la carte officielle (ID {oid}) ===
\tlocal e_add_code = Effect.CreateEffect(c)
\te_add_code:SetType(EFFECT_TYPE_SINGLE)
\te_add_code:SetCode(EFFECT_ADD_CODE)
\te_add_code:SetProperty(EFFECT_FLAG_CANNOT_DISABLE+EFFECT_FLAG_UNCOPYABLE)
\te_add_code:SetValue({oid})
\tc:RegisterEffect(e_add_code)
\t-- ====================================================================="""


def inject_add_code(code, oid):
    """
    Insère l'EFFECT_ADD_CODE juste après la déclaration de initial_effect.
    Retourne (nouveau_code, succès).
    """
    block = ADD_CODE_TEMPLATE.format(oid=oid)
    new_code, count = INITIAL_EFFECT_RE.subn(
        lambda m: m.group(1) + block, code, count=1
    )
    return new_code, count > 0


def build(cid, oid, lua, add_code):
    """
    Construit le script de la carte VAACT `cid` à partir du script officiel `oid`.
    Retourne (code, injection_ok).

    Note : le remplacement de l'ID par regex touche tous les nombres identiques
    à l'ID officiel dans le script. Vérifie le résultat en cas de doute.
    """
    code = read(lua[oid])
    code = re.sub(rf"\bc{oid}\b", f"c{cid}", code)
    code = re.sub(rf"\b{oid}\b", str(cid), code)

    injected = True
    if add_code:
        code, injected = inject_add_code(code, oid)
    return code, injected


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

    rapport, bad = [], []
    ok = skipped = no_inject = 0

    for cid, name in sorted(custom.items()):
        tagged = any("vaact" in d.lower() for d in descs[cid])
        cands = sorted(o for o in official.get(norm(name), []) if o in lua)

        # --- Cartes [VAACT] : ignorées (sauf FORCE_OVERWRITE) ----------
        if tagged and not FORCE_OVERWRITE:
            skipped += 1
            p = os.path.join(OUT_DIR, f"c{cid}.lua")
            # Détecte une copie auto faite par erreur (avec ou sans injection)
            if os.path.exists(p):
                existing = read(p)
                if any(
                    existing == build(cid, o, lua, flag)[0]
                    for o in cands
                    for flag in (True, False)
                ):
                    bad.append((cid, name, p))
            continue

        # --- Script déjà présent dans "script" -------------------------
        if cid in has_script and not FORCE_OVERWRITE:
            print(f"{cid} {name} : script existant (ignoré)")
            continue

        # --- Aucun équivalent officiel ---------------------------------
        if not cands:
            rapport.append(f"{cid} | {name} | aucun script officiel trouvé")
            continue

        oid = cands[0]
        print(f"{cid} {name}  <-  c{oid}.lua")
        code, injected = build(cid, oid, lua, ADD_OFFICIAL_CODE)
        if ADD_OFFICIAL_CODE and not injected:
            no_inject += 1
            print("  ATTENTION : initial_effect introuvable, EFFECT_ADD_CODE non injecté")

        if not DRY_RUN:
            with open(os.path.join(OUT_DIR, f"c{cid}.lua"), "w",
                      encoding="utf-8", newline="\n") as f:
                f.write(code)
        ok += 1

    # --- Copies faites par erreur ---------------------------------------
    print("\n--- copies auto faites par erreur sur des cartes [VAACT] "
          f"(dans {os.path.basename(OUT_DIR)}) ---")
    for cid, name, p in bad:
        print(cid, name, "->", p)
        if DELETE_BAD and not DRY_RUN:
            os.remove(p)

    # --- Rapport ----------------------------------------------------------
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(rapport))

    # --- Résumé -----------------------------------------------------------
    deleted = DELETE_BAD and not DRY_RUN
    print(f"\n{skipped} cartes [VAACT] ignorées")
    print(f"{ok} scripts {'à copier' if DRY_RUN else 'copiés'}, "
          f"{len(rapport)} sans correspondance ({os.path.basename(REPORT_PATH)})")
    if ADD_OFFICIAL_CODE:
        print(f"{no_inject} script(s) sans injection EFFECT_ADD_CODE")
    print(f"{len(bad)} mauvaise(s) copie(s) {'supprimée(s)' if deleted else 'trouvée(s)'}")


if __name__ == "__main__":
    main()
