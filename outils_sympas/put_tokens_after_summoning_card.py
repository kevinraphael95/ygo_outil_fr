#!/usr/bin/env python3
"""
Place chaque token d'un .cdb juste après la carte qui l'invoque.

Usage :
    python tokens_apres_carte.py VAACT_S1.cdb                 -> VAACT_S1_tokens.cdb
    python tokens_apres_carte.py VAACT_S1.cdb sortie.cdb

Principe :
- La carte source est lue dans la description du token, entre guillemets
  (ex. : Token summon with "Multiply" effect.).
- Si plusieurs cartes ont ce nom, on prend celle dont le texte cite le token.
- Les ids sont renumérotés à la suite (à partir du plus petit id de la base),
  et datas.alias / texts.id sont mis à jour avec la même correspondance.
- Le fichier d'origine n'est pas modifié.
"""
import re
import sqlite3
import sys
from pathlib import Path

TOKEN_TYPE = 0x4000  # type Token


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_name(src.stem + "_tokens.cdb")
    if dst.exists():
        dst.unlink()

    s = sqlite3.connect(src)
    rows = s.execute(
        "SELECT d.id, d.type, t.name, t.desc FROM datas d JOIN texts t ON t.id = d.id ORDER BY d.id"
    ).fetchall()
    cards = [(i, n, d) for i, ty, n, d in rows if not ty & TOKEN_TYPE]
    tokens = [(i, n, d) for i, ty, n, d in rows if ty & TOKEN_TYPE]

    by_name = {}
    for i, n, d in cards:
        by_name.setdefault(n, []).append((i, d))

    after = {}  # id carte -> [ids tokens]
    orphans = []
    for tid, tname, tdesc in tokens:
        m = re.search(r'"([^"]+)"', tdesc or "")
        cands = by_name.get(m.group(1)) if m else None
        if not cands:
            orphans.append((tid, tname))
            continue
        if len(cands) > 1:
            citing = [c for c in cands if tname in (c[1] or "")]
            if citing:
                cands = citing
            else:
                print(f"! Ambigu : {tname} ({tid}) -> plusieurs cartes '{m.group(1)}', la première est prise")
        after.setdefault(cands[0][0], []).append(tid)

    # Nouvel ordre : chaque carte, suivie de ses tokens ; orphelins à la fin
    order = []
    for i, _, _ in cards:
        order.append(i)
        order += after.get(i, [])
    order += [tid for tid, _ in orphans]
    assert len(order) == len(rows) and len(set(order)) == len(rows)

    start = rows[0][0]
    mapping = {old: start + k for k, old in enumerate(order)}

    d = sqlite3.connect(dst)
    for (sql,) in s.execute("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL"):
        d.execute(sql)
    for old in order:
        r = list(s.execute("SELECT * FROM datas WHERE id=?", (old,)).fetchone())
        r[0] = mapping[old]
        if r[2]:  # alias
            r[2] = mapping.get(r[2], r[2])
        d.execute(f"INSERT INTO datas VALUES ({','.join('?' * len(r))})", r)
        r = list(s.execute("SELECT * FROM texts WHERE id=?", (old,)).fetchone())
        r[0] = mapping[old]
        d.execute(f"INSERT INTO texts VALUES ({','.join('?' * len(r))})", r)
    d.commit()
    d.close()

    print(f"{len(tokens) - len(orphans)} tokens replacés, {len(orphans)} sans carte trouvée.")
    for tid, tname in orphans:
        print(f"  orphelin (laissé à la fin) : {tname} ({tid})")
    print(f"-> {dst}")


if __name__ == "__main__":
    main()
