# Guide : créer ou réparer un outil YGO Tools

Tout le projet est **statique** : des pages HTML qui tournent dans le navigateur, hébergées sur GitHub Pages. Pas de serveur, pas de build.

---

## 1. Structure du dépôt

```
index.html            ← accueil (liste des outils)
utils/
  ygo.css             ← design system (couleurs, boutons, cartes, tableaux…)
  ygo.js              ← utilitaires (thème, toasts, console, données du dépôt…)
data/
  cdb/en/, cdb/fr/    ← CDB officiels, rush, skills, unofficial, prerelease…
  script/             ← scripts Lua (goat, official, pre-errata, pre-release, rush, skill, unofficial)
  cardinfo_english.txt, cardinfo_fr.txt
  cards-db.json       ← base YGOPRODeck
  yugipedia-db.json   ← base Yugipedia
cdb/, data_generator/, deck/, files/, infos/, scripts/   ← les outils, rangés par thème
```

**Règle d'or : si un fichier est déjà dans `data/`, l'outil le lit depuis le dépôt. On ne le retélécharge pas et on ne le redemande pas à l'utilisateur** (sauf option « utiliser mon propre fichier »).

---

## 2. Squelette d'une page d'outil

Copier ce modèle dans un sous-dossier (ex. `files/mon_outil.html`).
⚠️ Dans un sous-dossier, les chemins commencent par `../`.

```html
<!DOCTYPE html>
<html lang="fr" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mon outil · YGO Tools</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;900&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<link rel="stylesheet" href="../utils/ygo.css">
<script src="../utils/ygo.js"></script>
<!-- Seulement si l'outil lit un .cdb : -->
<!-- <script src="https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js"></script> -->
</head>
<body>

<header class="app-header">
  <div class="app-header-inner">
    <a class="brand" href="../index.html" title="Accueil">
      <div class="brand-logo"><i class="fa-solid fa-dragon"></i></div>
      <div>
        <div class="brand-name">YGO Tools</div>
        <div class="brand-sub">Boîte à outils Yu-Gi-Oh!</div>
      </div>
    </a>
    <div class="header-actions">
      <button class="icon-btn" id="theme-toggle" type="button"></button>
    </div>
  </div>
</header>

<main class="container">
  <section class="hero">
    <div class="hero-icon"><i class="fa-solid fa-wrench"></i></div>
    <div>
      <h1>Mon outil</h1>
      <p>Une phrase qui explique ce que fait l'outil.</p>
    </div>
  </section>

  <section class="card">
    <h2 class="card-title"><i class="fa-solid fa-file"></i> Entrée</h2>
    <div class="field">
      <label for="file">Fichier</label>
      <input type="file" id="file">
    </div>
    <div class="actions">
      <button class="btn btn-primary" id="run" type="button">Lancer</button>
    </div>
  </section>

  <section class="card">
    <h2 class="card-title"><i class="fa-solid fa-terminal"></i> Journal</h2>
    <div class="console" id="console"></div>
  </section>
</main>

<footer class="app-footer">YGO Tools · tout s'exécute dans ton navigateur</footer>
<div class="toasts" id="toasts"></div>

<script>
const log = YGO.console(YGO.$('console'));

YGO.$('run').addEventListener('click', async () => {
    try {
        const file = YGO.$('file').files[0];
        if (!file) return YGO.toast('Choisis un fichier', 'err');
        log.log('Lecture de ' + file.name + '…');
        const text = await YGO.readFile(file);
        // … ton traitement ici …
        log.log('Terminé', 'ok');
        YGO.download(text, 'resultat.txt', 'text/plain');
    } catch (e) {
        log.log(e.message, 'err');
        YGO.toast(e.message, 'err');
    }
});
</script>
</body>
</html>
```

Pour une page placée **à la racine**, remplacer `../` par `./`.

---

## 3. Utilitaires JavaScript (`utils/ygo.js`)

| Fonction | À quoi ça sert |
|---|---|
| `YGO.$(id)` | `document.getElementById` |
| `YGO.el(tag, props, ...enfants)` | Crée un élément DOM (le texte est échappé, donc sûr). Props : `className`, `text`, `dataset`, `onClick`… |
| `YGO.toast(msg, 'ok'\|'err')` | Notification en bas à droite |
| `YGO.console(el)` | Renvoie `{log(msg, 'info'\|'ok'\|'warn'\|'err'), clear()}` |
| `YGO.progress(rootEl)` | Renvoie `{show(), hide(), set(pourcent, texte)}` |
| `YGO.download(data, nom, mime)` | Télécharge une chaîne, un Blob ou un Uint8Array |
| `YGO.copy(texte)` | Copie dans le presse-papiers (avec toast) |
| `YGO.readFile(file, 'text'\|'arrayBuffer')` | Lit un fichier choisi par l'utilisateur |
| `YGO.fetchJSON(url, {retries, delay})` | `fetch` JSON avec réessais (API externes) |
| `YGO.fold(texte)` | Minuscules + sans accents (recherches) |
| `YGO.debounce(fn, ms)` | Évite de relancer à chaque touche |
| `YGO.sleep(ms)` | Pause dans une fonction `async` |
| `YGO.fmtBytes(n)` | « 1,5 Mo » |
| `YGO.bindFileCount(input, hintEl, regex)` | Affiche « N fichier(s) retenu(s) » |
| `YGO.initSql()` | Initialise sql.js (nécessite `sql-wasm.js`) |

La barre de progression attend ce HTML :

```html
<div class="progress hidden" id="prog">
  <div class="progress-meta"><span class="progress-text"></span><span class="progress-percent"></span></div>
  <div class="progress-bar"><div class="progress-fill"></div></div>
</div>
```

---

## 4. Lire les données du dépôt (`YGO.data`)

```js
const cards   = await YGO.data.cardsDb();            // data/cards-db.json
const yugi    = await YGO.data.yugipediaDb();        // data/yugipedia-db.json
const infoFr  = await YGO.data.cardinfo('fr');       // data/cardinfo_fr.txt  (texte)
const infoEn  = await YGO.data.cardinfo('en');       // data/cardinfo_english.txt
const db      = await YGO.data.cdb('fr', 'cards.cdb'); // base SQLite (sql.js requis)
const lua     = await YGO.data.script('official', 12345678); // texte ou null
```

- Les résultats sont **mis en cache** : un second appel ne recharge rien.
- Les chemins sont calculés depuis l'emplacement de `ygo.js`, donc ça marche depuis n'importe quel dossier.
- Pour un autre fichier : `await YGO.fetchRepo('data/chemin/fichier.ext', 'text' | 'json' | 'arrayBuffer')`.

Lire un CDB (format standard EDOPro : tables `datas` et `texts`) :

```js
const res = db.exec("SELECT id, name FROM texts WHERE name LIKE '%Dragon%' LIMIT 20");
const rows = res[0] ? res[0].values : [];
```

**Pas de listing de dossier** : un site statique ne peut pas « lister » `data/cdb/fr/`. Soit on écrit la liste des fichiers en dur, soit on utilise un `data/manifest.json` généré automatiquement.

**Beaucoup de fichiers (ex. des milliers de scripts)** : ne pas lancer tous les `fetch` en même temps. Faire des lots de 8 à 10 et ne demander que les fichiers utiles.

---

## 5. Classes CSS utiles (`utils/ygo.css`)

- **Mise en page** : `.container` (`.wide` pour plus large), `.hero`, `.card` + `.card-title` + `.card-sub`, `.grid-2`, `.row`, `.toolbar`, `.actions`
- **Formulaires** : `.field` (label + champ), `.inline-field`, `.hint`, `.check`, `input[type=file]`, `textarea`, `select`
- **Boutons** : `.btn`, `.btn-primary`, `.btn-danger`, `.btn-sm`
- **Filtres** : `.tabs` + `.tab` (`.active`)
- **Retours** : `.alert` (`.info` `.ok` `.warn` `.err`), `.chip` (`.ok` `.warn` `.err`), `.stats`, `.console`, `.progress`
- **Zone de dépôt** : `.dropzone` (+ `.over`)
- **Tableaux** : `.table-wrap` > `table`, `.val`, `tr.ok` / `tr.miss`, `.preview-cell`, `.empty`
- **Texte** : `.muted`, `.dim`, `.mono`, `.hidden`, `.grad`
- **Tutoriels** : `.step`, `.num`, `.prose`, `.code-block`, `.final`

Les couleurs viennent de variables (`--gold`, `--surface`, `--text`, `--danger`…) qui changent avec le thème. **Toujours utiliser ces variables, jamais de couleur en dur**, sinon ça casse en thème clair.

Icônes : Font Awesome 6 (`<i class="fa-solid fa-nom"></i>`), voir fontawesome.com/icons.

---

## 6. Ajouter l'outil à l'accueil

Dans `index.html`, copier une carte dans la bonne section :

```html
<a class="tool-card" href="files/mon_outil.html">
    <div class="hero-icon"><i class="fa-solid fa-wrench"></i></div>
    <h3>Mon outil</h3>
    <p>Une phrase de description (la recherche de l'accueil lit ce texte).</p>
</a>
```

Choisir une icône qui n'est pas déjà utilisée.

---

## 7. Réparer un outil : checklist

1. **Ouvrir la console du navigateur** (F12 → Console). La première erreur rouge est presque toujours la bonne piste.
2. **Page sans style, ou `YGO is not defined`** → chemins `ygo.css` / `ygo.js` faux. Dans un sous-dossier, il faut `../utils/…`.
3. **`Failed to fetch` ou erreur CORS en ouvrant le fichier directement** → normal avec `file://`. Lancer un petit serveur local :
   ```
   python -m http.server 8000
   ```
   puis ouvrir `http://localhost:8000`.
4. **404 sur un fichier de `data/`** → vérifier le chemin et les **majuscules** (GitHub Pages distingue `Cards.cdb` de `cards.cdb`).
5. **`initSqlJs is not defined`** → le script `sql-wasm.js` manque dans le `<head>`.
6. **Rien ne s'affiche après modification** → vider le cache (Ctrl+F5). GitHub Pages met 1 à 2 minutes à se mettre à jour après un commit.
7. **Le bouton ne fait rien** → vérifier que l'`id` dans le HTML est le même que dans `YGO.$('...')`, et que le code est dans un `try/catch` qui affiche l'erreur.
8. **Fichier trop gros / page qui fige** → traiter par morceaux, mettre un `await YGO.sleep(0)` de temps en temps, afficher une barre de progression.
9. **Thème clair illisible** → chercher une couleur en dur (`#fff`, `black`…) et la remplacer par une variable `var(--…)`.

---

## 8. Conventions

- Noms de fichiers en minuscules, avec `_` : `file_splitter.html`, pas `File Spliter.html`.
- Un outil = **un seul fichier HTML** (le CSS commun et `ygo.js` suffisent). Pas de CSS ni de JS dupliqué.
- Toujours un `try/catch` autour des actions, avec `log.log(e.message, 'err')` + `YGO.toast(..., 'err')`.
- Toujours un message clair quand il n'y a rien à faire (`YGO.toast('Choisis un fichier', 'err')`).
- Tout s'exécute dans le navigateur : **aucune clé API ni mot de passe** dans le code (le dépôt est public).
- Tester dans les deux thèmes (bouton lune/soleil) et sur mobile (F12 → mode appareil).
- Un commit par outil, avec un message qui dit quoi : `Ajout : outil X`, `Fix : scripts_finder ne trouve pas les rush`.

---

## 9. Mettre à jour les données

Les générateurs (`data_generator/…`) produisent de nouveaux `cards-db.json` / `yugipedia-db.json`. Une fois le fichier téléchargé, le remplacer dans `data/` et faire un commit. Les CDB et scripts se mettent à jour de la même façon (remplacer les fichiers dans `data/cdb/` et `data/script/`).
