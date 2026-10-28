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
    const BASE = SCRIPT_SRC ? new URL('../', SCRIPT_SRC).href : '../';
    YGO.url = (path) => new URL(path, BASE).href;

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

    window.YGO = YGO;
})();
