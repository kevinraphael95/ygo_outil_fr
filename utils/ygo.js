/* ============================================================
   YGO Tools — utilitaires communs (thème, toasts, console, I/O, données du dépôt)
   Chargé dans le <head> pour appliquer le thème avant l'affichage.
   ============================================================ */
(function () {
    'use strict';

    // Doit être lu tout de suite (currentScript est null plus tard)
    const SCRIPT_SRC = document.currentScript && document.currentScript.src;

    const KEY = 'ygo_theme';
    const root = document.documentElement;

    /* ---------- Thème ---------- */
    function preferred() {
        try {
            const saved = localStorage.getItem(KEY);
            if (saved === 'dark' || saved === 'light') return saved;
        } catch (e) { /* stockage indisponible */ }
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }

    function applyTheme(theme) {
        root.setAttribute('data-theme', theme);
        const btn = document.getElementById('theme-toggle');
        if (btn) {
            btn.innerHTML = theme === 'dark'
                ? '<i class="fa-solid fa-moon"></i>'
                : '<i class="fa-solid fa-sun"></i>';
            btn.title = theme === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre';
            btn.setAttribute('aria-label', btn.title);
        }
    }

    applyTheme(preferred());

    document.addEventListener('DOMContentLoaded', () => {
        applyTheme(root.getAttribute('data-theme'));
        const btn = document.getElementById('theme-toggle');
        if (btn) btn.addEventListener('click', () => {
            const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
            applyTheme(next);
        });
    });

    window.addEventListener('storage', (e) => {
        if (e.key === KEY && (e.newValue === 'dark' || e.newValue === 'light')) applyTheme(e.newValue);
    });

    /* ---------- API ---------- */
    const YGO = {};

    YGO.$ = (id) => document.getElementById(id);
    YGO.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Minuscules + sans accents (pour les recherches). */
    YGO.fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    /** Normalise un nom : espaces compactés, minuscules (comparaison de noms de cartes). */
    YGO.norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

    /** Retire le suffixe entre parenthèses : « Gold Gadget (Buff) » → « Gold Gadget ». */
    YGO.stripParens = (s) => String(s || '').replace(/\s*\([^)]*\)\s*$/, '');

    /** Exécute fn sur chaque élément avec au plus `limit` appels en parallèle. */
    YGO.pool = async function (items, limit, fn) {
        let i = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (i < items.length) await fn(items[i++]);
        });
        await Promise.all(workers);
    };

    /** Retarde un appel (ex. recherche pendant la frappe). */
    YGO.debounce = function (fn, ms = 200) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    };

    /** Création rapide d'éléments DOM (texte toujours échappé). */
    YGO.el = function (tag, props, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v == null || v === false) continue;
            if (k === 'className') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k === 'dataset') Object.assign(node.dataset, v);
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
            else node.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) {
            if (c == null || c === false) continue;
            node.append(c.nodeType ? c : document.createTextNode(String(c)));
        }
        return node;
    };

    YGO.fmtBytes = function (n) {
        if (n < 1024) return n + ' o';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' Ko';
        return (n / 1048576).toFixed(2) + ' Mo';
    };

    /** Toast : type 'ok' | 'err'. */
    YGO.toast = function (message, type = 'ok') {
        let box = document.getElementById('toasts');
        if (!box) {
            box = YGO.el('div', { className: 'toasts', id: 'toasts' });
            document.body.append(box);
        }
        box.setAttribute('aria-live', 'polite');
        const t = YGO.el('div', { className: 'toast ' + type, role: 'status' },
            YGO.el('i', { className: 'fa-solid ' + (type === 'ok' ? 'fa-circle-check' : 'fa-circle-exclamation') }),
            YGO.el('span', { text: message }));
        box.append(t);
        setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3600);
    };

    /** Console d'exécution. level : 'info' | 'ok' | 'warn' | 'err'. */
    YGO.console = function (el) {
        return {
            log(msg, level = 'info') {
                const time = new Date().toLocaleTimeString('fr-FR');
                el.append(YGO.el('div', { className: 'console-line ' + level },
                    YGO.el('span', { className: 't', text: '[' + time + ']' }),
                    YGO.el('span', { className: 'm', text: msg })));
                while (el.childElementCount > 3000) el.firstElementChild.remove();
                el.scrollTop = el.scrollHeight;
            },
            clear() { el.textContent = ''; },
        };
    };

    /** Barre de progression : root contient .progress-text / .progress-percent / .progress-fill. */
    YGO.progress = function (root) {
        const fill = root.querySelector('.progress-fill');
        const pct = root.querySelector('.progress-percent');
        const txt = root.querySelector('.progress-text');
        return {
            show() { root.classList.remove('hidden'); },
            hide() { root.classList.add('hidden'); },
            set(value, text) {
                const v = Math.max(0, Math.min(100, Math.round(value)));
                fill.style.width = v + '%';
                if (pct) pct.textContent = v + '%';
                if (txt && text != null) txt.textContent = text;
            },
        };
    };

    /** Télécharge une chaîne, un Blob ou un Uint8Array. */
    YGO.download = function (data, filename, mime = 'application/octet-stream') {
        const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = YGO.el('a', { href: url, download: filename });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        return blob.size;
    };

    /** Copie dans le presse-papiers (avec repli pour les contextes non sécurisés). */
    YGO.copy = async function (text, okMessage = 'Copié dans le presse-papiers !') {
        let ok = true;
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            const ta = YGO.el('textarea', { style: 'position:fixed;opacity:0' });
            ta.value = text;
            document.body.append(ta);
            ta.select();
            try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
            ta.remove();
        }
        if (ok) { if (okMessage) YGO.toast(okMessage); }
        else YGO.toast('Impossible de copier', 'err');
        return ok;
    };

    /** Affiche "N fichier(s)" sous un champ fichier / dossier. */
    YGO.bindFileCount = function (input, hintEl, pattern) {
        input.addEventListener('change', () => {
            const files = [...input.files];
            const n = pattern ? files.filter((f) => pattern.test(f.name)).length : files.length;
            hintEl.textContent = n ? n.toLocaleString('fr-FR') + ' fichier(s) retenu(s)' : '';
        });
    };

    /** Lit un fichier choisi par l'utilisateur : 'text' (défaut) ou 'arrayBuffer'. */
    YGO.readFile = (file, type = 'text') => (type === 'arrayBuffer' ? file.arrayBuffer() : file.text());

    /** fetch + JSON avec quelques réessais (utile pour les API externes). */
    YGO.fetchJSON = async function (url, { retries = 2, delay = 800 } = {}) {
        let lastErr;
        for (let i = 0; i <= retries; i++) {
            try {
                const r = await fetch(url);
                if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return await r.json();
            } catch (e) {
                lastErr = e;
                if (i < retries) await YGO.sleep(delay * (i + 1));
            }
        }
        throw lastErr;
    };

    /** Initialise sql.js (le script sql-wasm.js doit être chargé). */
    YGO.initSql = () => initSqlJs({
        locateFile: (f) => 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/' + f,
    });

    /* ---------- Données du dépôt (dossier data/) ---------- */
    // Racine du dépôt déduite de l'emplacement de ygo.js : marche depuis n'importe quel sous-dossier.
    const BASE = new URL('../', SCRIPT_SRC || document.baseURI).href;
    YGO.url = (path) => new URL(path.split('/').map(encodeURIComponent).join('/'), BASE).href;

    /** Charge un fichier du dépôt : type = 'text' | 'json' | 'arrayBuffer'. */
    YGO.fetchRepo = async function (path, type = 'text') {
        const r = await fetch(YGO.url(path));
        if (!r.ok) throw new Error(path + ' : HTTP ' + r.status);
        return r[type]();
    };

    const cache = new Map();
    const once = (key, fn) => {
        if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
        return cache.get(key);
    };
    const CARDINFO = { en: 'cardinfo_english.txt', fr: 'cardinfo_fr.txt' };
    let sqlPromise;

    YGO.data = {
        cardsDb:     () => once('cards', () => YGO.fetchRepo('data/cards-db.json', 'json')),
        yugipediaDb: () => once('yugipedia', () => YGO.fetchRepo('data/yugipedia-db.json', 'json')),
        cardinfo:    (lang = 'en') => once('ci-' + lang, () => YGO.fetchRepo('data/' + CARDINFO[lang])),

        /** Ouvre un CDB du dépôt, ex. YGO.data.cdb('fr', 'cards.cdb'). Nécessite sql-wasm.js. */
        cdb: (lang, name) => once(`cdb-${lang}-${name}`, async () => {
            sqlPromise = sqlPromise || YGO.initSql();
            const [SQL, buf] = await Promise.all([
                sqlPromise, YGO.fetchRepo(`data/cdb/${lang}/${name}`, 'arrayBuffer')]);
            return new SQL.Database(new Uint8Array(buf));
        }),

        /** Script Lua d'une carte, ex. YGO.data.script('official', 12345678) ; null s'il n'existe pas. */
        script: async (folder, id) => {
            const r = await fetch(YGO.url(`data/script/${folder}/c${id}.lua`));
            return r.ok ? r.text() : null;
        },
    };

    /* ---------- Liste des fichiers du dépôt (data/manifest.json) ---------- */
    // Un site statique ne peut pas lister un dossier : data/manifest.json (généré par la
    // GitHub Action) contient la liste des CDB par langue, des dossiers de scripts
    // et des illustrations custom.
    function inferRepo() {
        const h = location.hostname;
        if (!h.endsWith('.github.io')) return null;
        const owner = h.split('.')[0];
        const repo = location.pathname.split('/').filter(Boolean)[0];
        return owner && repo ? { owner, repo } : null;
    }

    async function manifestFromGitHub() {
        const r = inferRepo();
        if (!r) throw new Error('data/manifest.json introuvable (voir le workflow « manifest »)');
        const resp = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/main?recursive=1`);
        if (!resp.ok) {
            throw new Error(resp.status === 403
                ? "data/manifest.json introuvable et limite de l'API GitHub atteinte"
                : 'data/manifest.json introuvable (API GitHub : HTTP ' + resp.status + ')');
        }
        const m = { cdb: {}, script: [], art: [] };
        const folders = new Set();
        for (const t of (await resp.json()).tree) {
            if (t.type !== 'blob') continue;
            let x = /^data\/cdb\/([^/]+)\/([^/]+\.cdb)$/i.exec(t.path);
            if (x) (m.cdb[x[1]] = m.cdb[x[1]] || []).push(x[2]);
            x = /^data\/script\/([^/]+)\//.exec(t.path);
            if (x) folders.add(x[1]);
            x = /^data\/YUGIOH CUSTOM ART\/([^/]+\.(?:png|jpe?g|webp))$/i.exec(t.path);
            if (x) m.art.push(x[1]);
        }
        m.script = [...folders].sort();
        return m;
    }

    YGO.data.manifest = () => once('manifest', async () => {
        try { return await YGO.fetchRepo('data/manifest.json', 'json'); }
        catch (e) { return manifestFromGitHub(); }
    });

    /** Illustrations custom (data/YUGIOH CUSTOM ART) : Map(nom normalisé → URL). */
    YGO.data.customArt = () => once('customArt', async () => {
        let m = await YGO.data.manifest();
        if (!m.art) m = await manifestFromGitHub(); // manifest.json sans la liste des images
        const map = new Map();
        for (const f of m.art || []) {
            const k = f.replace(/\.[a-z0-9]+$/i, '').toLowerCase().normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
            if (k && !map.has(k)) map.set(k, YGO.url('data/YUGIOH CUSTOM ART/' + f));
        }
        return map;
    });

    /** Fichier du dépôt présenté comme un File : { name, arrayBuffer() } (téléchargé une seule fois). */
    function repoFile(path) {
        let buf = null;
        return {
            name: path.split('/').pop(),
            arrayBuffer() {
                if (!buf) buf = YGO.fetchRepo(path, 'arrayBuffer').catch((e) => { buf = null; throw e; });
                return buf;
            },
        };
    }

    /** CDB du dépôt pour une langue, ex. YGO.data.cdbFiles('en', { ignore: ['vaact'] }). */
    YGO.data.cdbFiles = async function (lang = 'en', { ignore = [] } = {}) {
        const m = await YGO.data.manifest();
        const skip = ignore.map((t) => String(t).toLowerCase()).filter(Boolean);
        return ((m.cdb && m.cdb[lang]) || [])
            .filter((n) => !skip.some((t) => n.toLowerCase().includes(t)))
            .map((n) => repoFile(`data/cdb/${lang}/${n}`));
    };

    /* ---------- Format CDB (partagé par les outils de génération) ---------- */
    const DATAS_COLS = ['id', 'ot', 'alias', 'setcode', 'type', 'atk', 'def', 'level', 'race', 'attribute', 'category'];
    const TEXTS_COLS = ['id', 'name', 'desc', ...Array.from({ length: 16 }, (_, i) => 'str' + (i + 1))];
    YGO.cdb = {
        DATAS_COLS,
        TEXTS_COLS,
        SCHEMA: `
CREATE TABLE datas(id integer primary key, ot integer, alias integer, setcode integer, type integer, atk integer, def integer, level integer, race integer, attribute integer, category integer);
CREATE TABLE texts(id integer primary key, name text, "desc" text, ${TEXTS_COLS.slice(3).map((c) => c + ' text').join(', ')});`,
        /** Priorité d'un CDB quand une carte existe dans plusieurs (0 = prioritaire). */
        rank(name) {
            const n = String(name).toLowerCase();
            if (n === 'cards.delta.cdb') return 0;
            if (n === 'cards.cdb') return 1;
            if (/rush|skill|goat/.test(n)) return 4;
            if (/prerelease|release|unofficial/.test(n)) return 3;
            return 2;
        },
    };

    window.YGO = YGO;
})();
