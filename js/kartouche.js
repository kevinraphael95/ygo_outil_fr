/* ============================================================
   Kartouche · import des effets depuis un script Lua EDOPro
   Charger après utils/ygo.js, AVANT le <script> principal de la page.
   - KLua.parse(src, opts)  : parseur pur (sans DOM)
   - loadScriptFor(id)      : cherche data/script/c<id>.lua et remplit le formulaire
   - onScriptFolder(files)  : indexe un dossier de scripts choisi à la main
   - importLuaFile(file)    : importe un .lua isolé
   Remplace aussi generateScript() et renderEffects() de la page
   (versions compatibles avec les effets importés).
   ============================================================ */
(function (root) {
'use strict';

/* ------------------------------------------------------------
   1. Petit lexer Lua (commentaires, chaînes, mots-clés de blocs)
   ------------------------------------------------------------ */
const KW = new Set(['function', 'if', 'do', 'end', 'repeat', 'until']);

/* Si on est au début d'un commentaire / d'une chaîne, renvoie l'index juste après ; sinon i. */
function skipNonCode(src, i) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
        const m = /^--\[(=*)\[/.exec(src.substr(i, 40));
        if (m) {
            const close = ']' + m[1] + ']';
            const j = src.indexOf(close, i + m[0].length);
            return j < 0 ? src.length : j + close.length;
        }
        const j = src.indexOf('\n', i);
        return j < 0 ? src.length : j;
    }
    if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
        return j + 1;
    }
    if (c === '[') {
        const m = /^\[(=*)\[/.exec(src.substr(i, 40));
        if (m) {
            const close = ']' + m[1] + ']';
            const j = src.indexOf(close, i + m[0].length);
            return j < 0 ? src.length : j + close.length;
        }
    }
    return i;
}

function keywords(src) {
    const out = [], n = src.length;
    let i = 0;
    while (i < n) {
        const k = skipNonCode(src, i);
        if (k !== i) { i = k; continue; }
        const c = src[i];
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < n && /\w/.test(src[j])) j++;
            const w = src.slice(i, j);
            if (KW.has(w)) {
                let p = i - 1;
                while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--;
                if (!(p >= 0 && (src[p] === '.' || src[p] === ':'))) out.push({ w, i, e: j });
            }
            i = j; continue;
        }
        if (/[0-9]/.test(c)) { let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j++; i = j; continue; }
        i++;
    }
    return out;
}

/* Blocs `function ...  end` situés au niveau 0 du fichier */
function topBlocks(src) {
    const res = [];
    let depth = 0, cur = null;
    for (const k of keywords(src)) {
        if (k.w === 'function' || k.w === 'if' || k.w === 'do' || k.w === 'repeat') {
            if (depth === 0 && k.w === 'function') {
                const ls = src.lastIndexOf('\n', k.i - 1) + 1;
                if (/^[ \t]*(local[ \t]+)?$/.test(src.slice(ls, k.i))) cur = { start: ls };
            }
            depth++;
        } else {
            depth--;
            if (depth <= 0) {
                if (cur) { cur.end = k.e; res.push(cur); cur = null; }
                depth = 0;
            }
        }
    }
    return res.map((b) => {
        const text = src.slice(b.start, b.end);
        const m = /function\s+([\w.:]+)\s*\(([^)]*)\)/.exec(text);
        return Object.assign(b, { text, name: m ? m[1] : '', args: m ? m[2] : '' });
    });
}

/* texte complet (parenthèses + blocs équilibrés) ? */
function isComplete(t) {
    let d = 0;
    for (let i = 0; i < t.length;) {
        const k = skipNonCode(t, i);
        if (k !== i) { i = k; continue; }
        const c = t[i];
        if (c === '(' || c === '{' || c === '[') d++;
        else if (c === ')' || c === '}' || c === ']') d--;
        i++;
    }
    if (d > 0) return false;
    let bd = 0;
    for (const k of keywords(t)) bd += (k.w === 'end' || k.w === 'until') ? -1 : 1;
    return bd <= 0;
}

function matchParen(t, open) {
    let d = 0;
    for (let i = open; i < t.length;) {
        const k = skipNonCode(t, i);
        if (k !== i) { i = k; continue; }
        const c = t[i];
        if (c === '(' || c === '{' || c === '[') d++;
        else if (c === ')' || c === '}' || c === ']') { d--; if (d === 0) return i; }
        i++;
    }
    return -1;
}

function splitArgs(s) {
    const out = [];
    let d = 0, st = 0;
    for (let i = 0; i < s.length;) {
        const k = skipNonCode(s, i);
        if (k !== i) { i = k; continue; }
        const c = s[i];
        if (c === '(' || c === '{' || c === '[') d++;
        else if (c === ')' || c === '}' || c === ']') d--;
        else if (c === ',' && d === 0) { out.push(s.slice(st, i).trim()); st = i + 1; }
        i++;
    }
    const last = s.slice(st).trim();
    if (last || out.length) out.push(last);
    return out;
}

function dedent(t) {
    const lines = t.split('\n');
    let min = Infinity;
    lines.forEach((l) => { if (l.trim()) min = Math.min(min, /^[ \t]*/.exec(l)[0].length); });
    if (!isFinite(min)) min = 0;
    return lines.map((l) => l.slice(Math.min(min, /^[ \t]*/.exec(l)[0].length))).join('\n');
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------
   2. Découpage de initial_effect en instructions
   ------------------------------------------------------------ */
function splitStatements(body) {
    const stm = [];
    let buf = [], lead = [];
    for (const line of body.split('\n')) {
        if (!buf.length) {
            const t = line.trim();
            if (t === '') { lead = []; continue; }
            if (t.startsWith('--') && !/^--\[=*\[/.test(t)) { lead.push(t.replace(/^-+\s*/, '')); continue; }
        }
        buf.push(line);
        const text = buf.join('\n');
        if (isComplete(text)) { stm.push({ text: dedent(text).trim(), lead }); buf = []; lead = []; }
    }
    if (buf.length) stm.push({ text: dedent(buf.join('\n')).trim(), lead });
    return stm;
}

function parseCall(t) {
    const m = /^([A-Za-z_]\w*):(\w+)\(/.exec(t);
    if (!m) return null;
    const open = m[0].length - 1, close = matchParen(t, open);
    if (close < 0) return null;
    const rest = t.slice(close + 1).replace(/--.*$/, '').trim();
    if (rest && rest !== ';') return null;
    return { obj: m[1], method: m[2], args: t.slice(open + 1, close).trim(), text: t };
}

const RE_CREATE = /^(?:local\s+)?([A-Za-z_]\w*)\s*=\s*Effect\.CreateEffect\(\s*(\w+)\s*\)\s*;?\s*(--.*)?$/;
const RE_CLONE = /^(?:local\s+)?([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*):Clone\(\)\s*;?\s*(--.*)?$/;

/* ------------------------------------------------------------
   3. Fonctions : extraction de corps / renommage
   ------------------------------------------------------------ */
const STD_COND = ['e', 'tp', 'eg', 'ep', 'ev', 're', 'r', 'rp'];
const STD_COST = STD_COND.concat(['chk']);

function fnParts(b) {
    const m = /function\s+[\w.:]+\s*\(([^)]*)\)/.exec(b.text);
    const args = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    let body = b.text.slice(m.index + m[0].length, b.text.length - 3).replace(/^[ \t]*\n/, '');
    body = dedent(body).replace(/\s+$/, '').replace(/^\n+/, '');
    return { args, body: body.trim() ? body : '' };
}
const prefixOk = (args, std) => args.every((a, i) => a === std[i]);
/* « function(e,tp) ... end » passé directement en argument -> pseudo-bloc nommé */
const inlineFn = (x) => (/^function\s*\([^)]*\)[\s\S]*\bend$/.test(x) ? { text: x.replace(/^function\s*\(/, 'function f(') } : null);
const wrapExpr = (x) => (/^s\.\w+$/.test(x) ? x : '(' + x + ')');
const typeTokens = (a) => a.replace(/\s+/g, '').split(/[+|]/).filter(Boolean);
const normEv = (s) => s.replace(/\s+/g, '').replace(/\|/g, '+');

const GEN_TYPES = {
    M: { IGNITION: ['IGNITION'], QUICK_O: ['QUICK_O'], QUICK_F: ['QUICK_F'], TRIGGER_O: ['SINGLE', 'TRIGGER_O'], TRIGGER_F: ['SINGLE', 'TRIGGER_F'], FLIP: ['FLIP', 'TRIGGER_O'] },
    S: { ACTIVATE: ['ACTIVATE'], QUICK_O: ['QUICK_O'] }
};

/* ------------------------------------------------------------
   4. Parseur principal
   ------------------------------------------------------------ */
function parse(srcRaw, o) {
    o = o || {};
    const isMonster = o.isMonster !== false;
    const catKeys = new Set(o.categoryKeys || []);
    const trigEvents = o.triggerEvents || [];
    const cloneEvents = o.cloneEvents || [];
    const src = String(srcRaw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const warnings = [];

    const blocks = topBlocks(src);
    const init = blocks.find((b) => b.name === 's.initial_effect');
    if (!init) throw new Error('s.initial_effect introuvable dans ce script.');
    const fn = new Map();
    blocks.forEach((b) => { const m = /^s\.(\w+)$/.exec(b.name); if (m && b !== init) fn.set(m[1], b); });
    const refs = (name) => (src.match(new RegExp('\\bs\\.' + name + '\\b', 'g')) || []).length - 1;
    const consumed = new Set();

    /* --- initial_effect --- */
    const hm = /function\s+s\.initial_effect\s*\(\s*(\w+)\s*\)/.exec(init.text);
    if (!hm) throw new Error('Signature de s.initial_effect(c) non reconnue.');
    const cName = hm[1];
    if (cName !== 'c') warnings.push('Paramètre de initial_effect nommé « ' + cName + ' » (attendu « c »).');
    const body = init.text.slice(hm.index + hm[0].length, init.text.length - 3);
    const stmts = splitStatements(body);

    const seq = [];                // { text, lead, owner }
    const vars = new Map();        // nom de variable -> objet effet courant
    const order = [];              // enregistrements (c:RegisterEffect) dans l'ordre
    for (const st of stmts) {
        const t = st.text;
        const entry = { text: t, lead: st.lead, owner: null };
        seq.push(entry);
        let m;
        if ((m = RE_CREATE.exec(t))) {
            const ef = { var: m[1], calls: [], lead: st.lead, reg: false, regArgs: '', cloneBase: null, baseLen: 0 };
            vars.set(m[1], ef); entry.owner = ef; continue;
        }
        if ((m = RE_CLONE.exec(t)) && vars.has(m[2])) {
            const b = vars.get(m[2]);
            const ef = { var: m[1], calls: b.calls.slice(), lead: st.lead.length ? st.lead : b.lead, reg: false, regArgs: '', cloneBase: b, baseLen: b.calls.length };
            vars.set(m[1], ef); entry.owner = ef; continue;
        }
        const call = parseCall(t);
        if (call && vars.has(call.obj)) {
            const ef = vars.get(call.obj);
            ef.calls.push(call); entry.owner = ef; continue;
        }
        if (call && call.obj === cName && call.method === 'RegisterEffect') {
            const a = splitArgs(call.args);
            if (vars.has(a[0])) {
                let ef = vars.get(a[0]);
                if (ef.reg) ef = Object.assign({}, ef, { calls: ef.calls.slice(), cloneBase: null });
                ef.reg = true;
                ef.regArgs = a.length > 1 ? ',' + a.slice(1).join(',') : '';
                order.push(ef); entry.owner = vars.get(a[0]); entry.isReg = true; continue;
            }
        }
    }

    /* instructions conservées telles quelles dans initial_effect */
    const keep = seq.filter((s) => !s.owner || !s.owner.reg);
    const impInit = keep.map((s) => (s.lead.length ? s.lead.map((l) => '-- ' + l).join('\n') + '\n' : '') + s.text).join('\n');

    /* --- mapping des effets --- */
    const effects = [];
    const mappedBy = new Map();
    let idSeq = 0;
    const handledFns = new Set();

    for (const rec of order) {
        /* clone qui ne change que le code d'event -> "se déclenche aussi sur" */
        if (rec.cloneBase && rec.calls.length === rec.baseLen + 1) {
            const last = rec.calls[rec.calls.length - 1];
            const base = mappedBy.get(rec.cloneBase);
            const ev = normEv(last.args);
            if (last.method === 'SetCode' && base && !base.verbatim && /^TRIGGER_/.test(base.typeMain) &&
                base.cloneEvent === 'NONE' && base.eventCode !== 'CUSTOM' && cloneEvents.includes(ev)) {
                base.cloneEvent = ev; mappedBy.set(rec, base); continue;
            }
        }
        const id = ++idSeq;
        const eff = mapEffect(rec, id);
        effects.push(eff);
        mappedBy.set(rec, eff);
        rec._eff = eff;
    }

    function mapEffect(rec, id) {
        const label = rec.lead.length ? rec.lead[rec.lead.length - 1].slice(0, 60) : 'Effet ' + id;
        const base = {
            id, label, typeMain: 'IGNITION', categories: [], optScope: 'NONE', optN: 1, optOath: false, optDuel: false,
            cond: 'NONE', condRaw: '', cost: 'NONE', costAmount: 1000, costRaw: '',
            op: 'CUSTOM', opAmount: 1, opRaw: '', continuousRaw: '', eventCode: 'EVENT_SUMMON_SUCCESS', eventRaw: '',
            cloneEvent: 'NONE', extraFunctions: '', regArgs: rec.regArgs || ''
        };
        const verb = () => {
            base.verbatim = true;
            const hasAct = rec.calls.some((c) => c.method === 'SetType' && /EFFECT_TYPE_ACTIVATE/.test(c.args));
            base.typeMain = (!isMonster && hasAct) ? 'ACTIVATE' : 'CONTINUOUS';
            base.continuousRaw = rec.calls.map((c) => c.text).join('\n');
            return base;
        };
        const count = (m) => rec.calls.filter((c) => c.method === m).length;
        const get = (m) => rec.calls.find((c) => c.method === m) || null;
        for (const m of ['SetType', 'SetCategory', 'SetCode', 'SetRange', 'SetCountLimit', 'SetCondition', 'SetCost', 'SetTarget', 'SetOperation']) {
            if (count(m) > 1) return verb();
        }
        const tc = get('SetType');
        if (!tc) return verb();
        const toks = typeTokens(tc.args);
        if (!toks.length || toks.some((t) => !/^EFFECT_TYPE_\w+$/.test(t))) return verb();
        const has = (t) => toks.includes('EFFECT_TYPE_' + t);

        let tm = null;
        if (isMonster) {
            tm = has('IGNITION') ? 'IGNITION' : has('QUICK_O') ? 'QUICK_O' : has('QUICK_F') ? 'QUICK_F'
                : has('FLIP') ? 'FLIP' : has('TRIGGER_O') ? 'TRIGGER_O' : has('TRIGGER_F') ? 'TRIGGER_F' : null;
        } else {
            tm = has('ACTIVATE') ? 'ACTIVATE' : (has('QUICK_O') && !has('FIELD') && !has('SINGLE')) ? 'QUICK_O' : null;
        }
        if (!tm) return verb();
        base.typeMain = tm;
        const handled = new Set();
        const gen = (isMonster ? GEN_TYPES.M : GEN_TYPES.S)[tm].map((x) => 'EFFECT_TYPE_' + x).sort().join('+');
        if (toks.slice().sort().join('+') === gen) handled.add(tc);   // sinon le SetType d'origine reste en ligne brute

        /* catégories */
        const cc = get('SetCategory');
        if (cc) {
            const ct = typeTokens(cc.args);
            if (ct.length && ct.every((t) => /^CATEGORY_/.test(t) && catKeys.has(t.slice(9)))) {
                base.categories = ct.map((t) => t.slice(9)); handled.add(cc);
            }
        }

        /* code d'event */
        const sc = get('SetCode');
        if (sc) {
            const ev = normEv(sc.args);
            if (tm === 'TRIGGER_O' || tm === 'TRIGGER_F') {
                if (trigEvents.includes(ev)) base.eventCode = ev;
                else { base.eventCode = 'CUSTOM'; base.eventRaw = sc.args.trim(); }
                handled.add(sc);
            } else if (tm === 'FLIP') {
                if (ev === 'EVENT_FLIP') handled.add(sc);
            } else if (tm === 'QUICK_O' || tm === 'QUICK_F' || tm === 'ACTIVATE') {
                if (ev === 'EVENT_FREE_CHAIN') handled.add(sc);
            }
        }

        /* portée */
        const rg = get('SetRange');
        if (rg && isMonster && ['IGNITION', 'QUICK_O', 'QUICK_F', 'FLIP'].includes(tm) && rg.args.replace(/\s+/g, '') === 'LOCATION_MZONE') handled.add(rg);

        /* limite par tour */
        const cl = get('SetCountLimit');
        if (cl) {
            const a = splitArgs(cl.args);
            let ok = /^\d+$/.test(a[0] || '');
            if (ok) {
                base.optN = +a[0];
                if (a.length === 1) base.optScope = 'COPY';
                else if (a[1] === 'id') base.optScope = 'CARD';
                else ok = false;
                if (ok && a.length >= 3) {
                    const ft = typeTokens(a[2]);
                    if (a.length === 3 && ft.every((t) => t === 'EFFECT_COUNT_CODE_OATH' || t === 'EFFECT_COUNT_CODE_DUEL')) {
                        base.optOath = ft.includes('EFFECT_COUNT_CODE_OATH');
                        base.optDuel = ft.includes('EFFECT_COUNT_CODE_DUEL');
                    } else ok = false;
                }
                if (a.length > 3) ok = false;
            }
            if (ok) handled.add(cl);
            else { base.optScope = 'NONE'; base.optOath = base.optDuel = false; }
        }

        /* condition */
        const cd = get('SetCondition');
        if (cd) {
            const x = cd.args.trim(), nm = (/^s\.(\w+)$/.exec(x) || [])[1];
            base.cond = 'CUSTOM';
            const b = nm && fn.get(nm), il = inlineFn(x);
            if (il && prefixOk(fnParts(il).args, STD_COND)) {
                base.condRaw = fnParts(il).body || 'return true';
            } else if (b && !consumed.has(b) && refs(nm) === 1 && prefixOk(fnParts(b).args, STD_COND)) {
                base.condRaw = fnParts(b).body || 'return true'; consumed.add(b);
            } else base.condRaw = 'return ' + wrapExpr(x) + '(e,tp,eg,ep,ev,re,r,rp)';
            handled.add(cd);
        }

        /* coût */
        const cs = get('SetCost');
        if (cs) {
            const x = cs.args.trim(), nm = (/^s\.(\w+)$/.exec(x) || [])[1];
            const lp = /^Cost\.PayLP\(\s*(\d+)\s*\)$/.exec(x);
            if (lp) { base.cost = 'LP'; base.costAmount = +lp[1]; }
            else {
                base.cost = 'CUSTOM';
                const b = nm && fn.get(nm), il = inlineFn(x);
                if (il && prefixOk(fnParts(il).args, STD_COST)) {
                    base.costRaw = fnParts(il).body || 'if chk==0 then return true end';
                } else if (b && !consumed.has(b) && refs(nm) === 1 && prefixOk(fnParts(b).args, STD_COST)) {
                    base.costRaw = fnParts(b).body || 'if chk==0 then return true end'; consumed.add(b);
                } else base.costRaw = 'return ' + wrapExpr(x) + '(e,tp,eg,ep,ev,re,r,rp,chk)';
            }
            handled.add(cs);
        }

        /* cible + opération : fonctions renommées s.tg<id> / s.op<id> */
        const parts = [];
        const slot = (call, newName, sig) => {
            if (!call) return;
            const x = call.args.trim(), nm = (/^s\.(\w+)$/.exec(x) || [])[1];
            const b = nm && fn.get(nm);
            if (/^function\s*\(/.test(x) && inlineFn(x)) {
                parts.push(x.replace(/^function\s*\(/, 'function s.' + newName + '('));
            } else if (b && !consumed.has(b) && refs(nm) === 1) {
                consumed.add(b);
                parts.push(b.text.replace(/^([ \t]*(?:local[ \t]+)?function\s+)s\.\w+/, '$1s.' + newName));
            } else {
                parts.push('function s.' + newName + '(' + sig + ')\n\treturn ' + wrapExpr(x) + '(' + sig + ')\nend');
            }
            handled.add(call);
        };
        slot(get('SetTarget'), 'tg' + id, 'e,tp,eg,ep,ev,re,r,rp,chk,chkc');
        slot(get('SetOperation'), 'op' + id, 'e,tp,eg,ep,ev,re,r,rp');
        base.op = 'CUSTOM';
        base.opRaw = parts.length ? parts.join('\n\n') : '-- (aucun target / operation dans le script d\'origine)';

        /* le reste (SetDescription, SetProperty, SetLabel, SetHintTiming…) reste en lignes brutes */
        base.continuousRaw = rec.calls.filter((c) => !handled.has(c)).map((c) => c.text).join('\n');
        return base;
    }

    /* variables d'effet -> e<id> dans les lignes brutes */
    const lastVar = {};
    order.forEach((r) => { if (r._eff) lastVar[r.var] = r._eff.id; });
    function renameVars(text, own) {
        const map = Object.assign({}, lastVar, own);
        const keys = Object.keys(map).filter((k) => !STD_COST.includes(k) && k !== 'c' && k !== 's' && k !== 'id');
        if (!keys.length || !text) return text;
        const re = new RegExp('(?<![\\w.:])(' + keys.map(escRe).join('|') + ')(?![\\w])', 'g');
        return text.replace(re, (m, v) => 'e' + map[v]);
    }
    order.forEach((r) => {
        if (!r._eff) return;
        r._eff.continuousRaw = renameVars(r._eff.continuousRaw, { [r.var]: r._eff.id });
    });

    /* --- reste du fichier : fonctions d'aide + lignes hors fonctions --- */
    const listed = {};
    const segs = [];
    {
        let pos = 0;
        blocks.slice().sort((a, b) => a.start - b.start).forEach((b) => {
            segs.push({ text: src.slice(pos, b.start) });
            segs.push({ block: b });
            pos = b.end;
        });
        segs.push({ text: src.slice(pos) });
    }
    const helpers = [];
    let first = true;
    for (const sg of segs) {
        if (sg.block) {
            if (sg.block !== init && !consumed.has(sg.block)) helpers.push(sg.block.text);
            continue;
        }
        let t = sg.text;
        if (first) { t = t.replace(/^(\s*--.*\n)+(?=\s*local\s+s\s*,\s*id)/, ''); first = false; }
        t = t.replace(/^[ \t]*local\s+s\s*,\s*id(\s*,\s*\w+)*\s*=\s*GetID\(\)[ \t]*$/m, '');
        t = t.replace(/s\.listed_(names|series)\s*=\s*\{([\s\S]*?)\}[ \t]*/g, (m, kind, inner) => {
            listed[kind] = inner.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim().replace(/,\s*$/, '');
            return '';
        });
        if (t.trim()) helpers.push(t.trim());
    }
    const impFuncs = helpers.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

    const verbCount = effects.filter((e) => e.verbatim).length;
    if (verbCount) warnings.push(verbCount + ' effet(s) conservé(s) tel quel (passif / non couvert par le formulaire).');
    return {
        effects, impInit, impFuncs,
        listedNames: listed.names !== undefined ? listed.names : null,
        listedSeries: listed.series !== undefined ? listed.series.split(',').map((s) => s.trim()).filter(Boolean) : null,
        warnings
    };
}

root.KLua = { parse, _internals: { keywords, topBlocks, splitStatements, parseCall, splitArgs, isComplete } };

/* ============================================================
   5. Partie navigateur (chargement, rendu, génération)
   ============================================================ */
if (typeof document === 'undefined') return;

const E = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const A = (s) => E(s).replace(/"/g, '&quot;');
const byId = (id) => document.getElementById(id);

/* ---------- chargement des scripts ---------- */
const LOCAL_SCRIPTS = new Map();   // passcode -> File (dossier choisi à la main)
let lastBase = null;

function setScriptStatus(text, cls) {
    const el = byId('script-status');
    if (el) { el.className = 'chip ' + (cls || ''); el.textContent = text; }
}
function scriptBases() {
    const d = (typeof DATA_DIR !== 'undefined' ? DATA_DIR : './data/') + 'script/';
    const list = [d, d + 'official/', d + 'pre-release/', d + 'unofficial/', d + 'rush/', d + 'goat/', d + 'anime/', d + 'speed/'];
    if (lastBase && list.includes(lastBase)) { list.splice(list.indexOf(lastBase), 1); list.unshift(lastBase); }
    return list;
}
async function fetchScript(id) {
    const f = LOCAL_SCRIPTS.get(String(id));
    if (f) return { text: await f.text(), from: f.webkitRelativePath || f.name };
    for (const b of scriptBases()) {
        try {
            const r = await fetch(b + 'c' + id + '.lua');
            if (!r.ok) continue;
            const t = await r.text();
            if (/initial_effect|GetID/.test(t)) { lastBase = b; return { text: t, from: b + 'c' + id + '.lua' }; }
        } catch (e) { /* page ouverte en local : on passera par le dossier choisi à la main */ }
    }
    return null;
}

let SET_REV = null;
function setRev() {
    if (SET_REV) return SET_REV;
    SET_REV = {};
    if (typeof SET_NAMES !== 'undefined') for (const [h, c] of Object.entries(SET_NAMES)) if (!(c in SET_REV)) SET_REV[c] = h;
    return SET_REV;
}

function applyScript(text, id, from) {
    const res = KLua.parse(text, {
        isMonster: cardType === 'MONSTER',
        categoryKeys: CATEGORIES.map((c) => c[0]),
        triggerEvents: TRIGGER_EVENTS.map((t) => t[0]).filter((v) => v !== 'CUSTOM'),
        cloneEvents: CLONE_EVENTS.map((t) => t[0]).filter((v) => v !== 'NONE')
    });
    effects = res.effects;
    effSeq = effects.reduce((m, e) => Math.max(m, e.id), 0);
    byId('imp-init').value = res.impInit;
    byId('imp-funcs').value = res.impFuncs;
    byId('imp-box').open = !!(res.impInit || res.impFuncs);
    if (res.listedNames !== null) byId('card-listed-id').value = res.listedNames;
    let nSets = 0;
    if (res.listedSeries) {
        const rev = setRev();
        res.listedSeries.forEach((tok) => {
            const h = /^0x[0-9a-f]+$/i.test(tok) ? tok.toLowerCase() : (rev[tok] || null);
            if (!h) return;
            if (!setcodes.find((s) => s.h === h)) {
                const a = ARCH.find((x) => x.h === h);
                setcodes.push({ n: a ? (a.en || a.fr) : tok, h }); nSets++;
            }
        });
    }
    if (id && !byId('card-id').value) byId('card-id').value = id;
    renderEffects();
    if (typeof refreshSetWidgets === 'function') refreshSetWidgets();
    render();
    const nTotal = effects.length;
    setScriptStatus('script · ' + (from || 'importé').split('/').slice(-2).join('/'), 'ok');
    YGO.toast(nTotal + ' effet' + (nTotal > 1 ? 's' : '') + ' chargé' + (nTotal > 1 ? 's' : '') + ' depuis le script' + (res.warnings.length ? ' — ' + res.warnings[0] : ''));
}

root.loadScriptFor = async function (id) {
    setScriptStatus('recherche du script…', 'warn');
    try {
        const got = await fetchScript(id);
        if (!got) {
            setScriptStatus('c' + id + '.lua introuvable', 'err');
            YGO.toast('Script c' + id + '.lua introuvable (data/script, ou choisis le dossier à la main)', 'err');
            return false;
        }
        applyScript(got.text, String(id), got.from);
        return true;
    } catch (err) {
        console.error(err);
        setScriptStatus('erreur de lecture', 'err');
        YGO.toast('Import du script : ' + err.message, 'err');
        return false;
    }
};
root.onScriptFolder = function (files) {
    let n = 0;
    for (const f of files) {
        const m = /^c(\d+)\.lua$/i.exec(f.name);
        if (m) { LOCAL_SCRIPTS.set(m[1], f); n++; }
    }
    setScriptStatus(n ? n.toLocaleString('fr-FR') + ' scripts indexés' : 'aucun cXXXX.lua trouvé', n ? 'ok' : 'err');
    if (!n) YGO.toast('Aucun fichier cXXXX.lua dans ce dossier', 'err');
};
root.importLuaFile = async function (file) {
    if (!file) return;
    try {
        const m = /^c(\d+)\.lua$/i.exec(file.name);
        applyScript(await file.text(), m ? m[1] : '', file.name);
    } catch (err) {
        console.error(err);
        YGO.toast('Import : ' + err.message, 'err');
    }
};

/* ---------- génération du script ---------- */
function familyOf(line) {
    const t = line.trim();
    return /^c:EnableReviveLimit/.test(t) ? 'revive' : /^Pendulum\./.test(t) ? 'pendulum' : /^Gemini\./.test(t) ? 'gemini'
        : /^Spirit\./.test(t) ? 'spirit' : /^aux\.AddUnionProcedure/.test(t) ? 'union' : /^aux\.AddEquipProcedure/.test(t) ? 'equip'
        : /^Ritual\./.test(t) ? 'ritual' : /^Fusion\./.test(t) ? 'fusion' : /^Synchro\./.test(t) ? 'synchro'
        : /^Xyz\./.test(t) ? 'xyz' : /^Link\./.test(t) ? 'link' : null;
}
const rawBlock = (t) => (t && t.trim() ? t.replace(/\s+$/, '').split('\n').map((l) => (l ? '\t' + l : l)).join('\n') + '\n' : '');

function generateScriptV2() {
    const cardName = byId('card-name').value;
    const listedRaw = byId('card-listed-id').value.trim();
    const impInit = (byId('imp-init') ? byId('imp-init').value : '').replace(/\s+$/, '');
    const impFuncs = (byId('imp-funcs') ? byId('imp-funcs').value : '').trim();

    let code = cardName ? `-- ${cardName}\n` : `-- Script généré — Kartouche\n`;
    code += `local s,id=GetID()\n`;
    code += `function s.initial_effect(c)\n`;
    const zone = (cardType === 'SPELL' && byId('s-sub').value === 'FIELD') ? 'LOCATION_FZONE' : 'LOCATION_SZONE';

    /* procédures : celles du script d'origine priment sur celles du formulaire */
    const have = new Set(impInit.split('\n').map(familyOf).filter(Boolean));
    code += genProcedures().split('\n').filter((l) => { const f = familyOf(l); return !(f && have.has(f)); }).join('\n');
    if (impInit) code += rawBlock(impInit) + '\n';

    const hasActivate = effects.some((e) => e.typeMain === 'ACTIVATE' || /EFFECT_TYPE_ACTIVATE/.test(e.continuousRaw || '')) || /EFFECT_TYPE_ACTIVATE/.test(impInit);
    if (needsActivationShell() && !hasActivate) {
        code += `\t-- Activation\n\tlocal e0=Effect.CreateEffect(c)\n\te0:SetType(EFFECT_TYPE_ACTIVATE)\n\te0:SetCode(EVENT_FREE_CHAIN)\n\tc:RegisterEffect(e0)\n\n`;
    }
    const isGemini = cardType === 'MONSTER' && byId('flag-gemini').checked;

    effects.forEach((e) => {
        const n = e.id;   // numéro stable : e<id>, s.tg<id>, s.op<id>… ne bougent pas si on supprime un autre effet
        code += `\t-- ${e.label}\n`;
        code += `\tlocal e${n}=Effect.CreateEffect(c)\n`;
        if (e.verbatim) {
            code += rawBlock(e.continuousRaw);
            code += `\tc:RegisterEffect(e${n}${e.regArgs || ''})\n\n`;
            return;
        }
        if (e.categories.length) code += `\te${n}:SetCategory(CATEGORY_${e.categories.join('+CATEGORY_')})\n`;

        if (cardType === 'MONSTER') {
            if (e.typeMain === 'IGNITION') { code += `\te${n}:SetType(EFFECT_TYPE_IGNITION)\n\te${n}:SetRange(LOCATION_MZONE)\n`; }
            else if (e.typeMain === 'QUICK_O') { code += `\te${n}:SetType(EFFECT_TYPE_QUICK_O)\n\te${n}:SetCode(EVENT_FREE_CHAIN)\n\te${n}:SetRange(LOCATION_MZONE)\n`; }
            else if (e.typeMain === 'QUICK_F') { code += `\te${n}:SetType(EFFECT_TYPE_QUICK_F)\n\te${n}:SetCode(EVENT_FREE_CHAIN)\n\te${n}:SetRange(LOCATION_MZONE)\n`; }
            else if (e.typeMain === 'TRIGGER_O' || e.typeMain === 'TRIGGER_F') {
                const ev = e.eventCode === 'CUSTOM' ? (e.eventRaw || 'EVENT_SUMMON_SUCCESS') : e.eventCode;
                code += `\te${n}:SetType(EFFECT_TYPE_SINGLE+EFFECT_TYPE_${e.typeMain})\n\te${n}:SetCode(${ev})\n`;
            }
            else if (e.typeMain === 'FLIP') { code += `\te${n}:SetType(EFFECT_TYPE_FLIP+EFFECT_TYPE_TRIGGER_O)\n\te${n}:SetCode(EVENT_FLIP)\n\te${n}:SetRange(LOCATION_MZONE)\n`; }
            else if (e.typeMain === 'CONTINUOUS' || e.typeMain === 'SINGLE') { code += `\te${n}:SetType(EFFECT_TYPE_SINGLE)\n\te${n}:SetProperty(EFFECT_FLAG_SINGLE_RANGE)\n\te${n}:SetRange(LOCATION_MZONE)\n`; }
            else if (e.typeMain === 'FIELD') { code += `\te${n}:SetType(EFFECT_TYPE_FIELD)\n\te${n}:SetRange(LOCATION_MZONE)\n\te${n}:SetTargetRange(1,0)\n`; }
        } else {
            if (e.typeMain === 'ACTIVATE') { code += `\te${n}:SetType(EFFECT_TYPE_ACTIVATE)\n\te${n}:SetCode(EVENT_FREE_CHAIN)\n`; }
            else if (e.typeMain === 'CONTINUOUS') { code += `\te${n}:SetType(EFFECT_TYPE_SINGLE)\n\te${n}:SetProperty(EFFECT_FLAG_SINGLE_RANGE)\n\te${n}:SetRange(${zone})\n`; }
            else if (e.typeMain === 'FIELD') { code += `\te${n}:SetType(EFFECT_TYPE_FIELD)\n\te${n}:SetRange(${zone})\n\te${n}:SetTargetRange(0,1)\n`; }
            else if (e.typeMain === 'EQUIP') { code += `\te${n}:SetType(EFFECT_TYPE_EQUIP)\n`; }
            else if (e.typeMain === 'QUICK_O') { code += `\te${n}:SetType(EFFECT_TYPE_QUICK_O)\n\te${n}:SetCode(EVENT_FREE_CHAIN)\n`; }
        }

        if (e.optScope !== 'NONE') {
            const flags = [];
            if (e.optOath) flags.push('EFFECT_COUNT_CODE_OATH');
            if (e.optDuel) flags.push('EFFECT_COUNT_CODE_DUEL');
            const idArg = e.optScope === 'CARD' ? ',id' : '';
            code += flags.length ? `\te${n}:SetCountLimit(${e.optN}${idArg},${flags.join('+')})\n` : `\te${n}:SetCountLimit(${e.optN}${idArg})\n`;
        }

        if (e.cond !== 'NONE') code += `\te${n}:SetCondition(s.con${n})\n`;
        else if (isGemini) code += `\te${n}:SetCondition(Gemini.EffectStatusCondition)\n`;
        if (e.cost !== 'NONE') code += `\te${n}:SetCost(s.cost${n})\n`;
        if (!isPassive(e)) {
            /* en mode « Lua personnalisé », on ne pose SetTarget / SetOperation que si la fonction existe */
            const raw = e.opRaw || '';
            const custom = e.op === 'CUSTOM' && raw.trim();
            const hasTg = !custom || new RegExp('\\bs\\.tg' + n + '\\b').test(raw);
            const hasOp = !custom || new RegExp('\\bs\\.op' + n + '\\b').test(raw);
            if (hasTg) code += `\te${n}:SetTarget(s.tg${n})\n`;
            if (hasOp) code += `\te${n}:SetOperation(s.op${n})\n`;
        }
        code += rawBlock(e.continuousRaw);
        code += `\tc:RegisterEffect(e${n}${e.regArgs || ''})\n`;
        if (['TRIGGER_O', 'TRIGGER_F'].includes(e.typeMain) && e.cloneEvent && e.cloneEvent !== 'NONE') {
            code += `\tlocal e${n}b=e${n}:Clone()\n\te${n}b:SetCode(${e.cloneEvent})\n\tc:RegisterEffect(e${n}b)\n`;
        }
        code += `\n`;
    });

    code += `end\n\n`;

    if (setcodes.length) code += `s.listed_series={${setcodes.map((s) => setRef(s.h)).join(',')}}\n`;
    if (listedRaw) code += `s.listed_names={${listedRaw}}\n`;
    if (setcodes.length || listedRaw) code += `\n`;

    effects.forEach((e) => {
        const n = e.id;
        if (e.verbatim) { if (e.extraFunctions && e.extraFunctions.trim()) code += e.extraFunctions.trim() + '\n\n'; return; }
        code += genCondition(e, n);
        code += genCost(e, n);
        if (!isPassive(e)) code += genTargetOperation(e, n);
        if (e.extraFunctions && e.extraFunctions.trim()) code += e.extraFunctions.trim() + '\n\n';
    });
    if (impFuncs) code += impFuncs + '\n\n';

    return code.replace(/\n{3,}/g, '\n\n');
}

/* ---------- cartes d'effets ---------- */
function renderEffectsV2() {
    const container = byId('effects-container');
    byId('effects-empty').style.display = effects.length ? 'none' : 'block';
    byId('eff-count-sub').innerText = effects.length + (effects.length > 1 ? ' effets' : ' effet');
    const typeOptions = EFFECT_TYPES[cardType === 'MONSTER' ? 'MONSTER' : 'ST'];

    container.innerHTML = effects.map((e, effIdx) => {
        const n = effIdx + 1, k = e.id;
        const head = `
      <h3 class="card-title">
        <span class="chip">#${n}</span>
        <input type="text" style="flex:1" value="${A(e.label)}" oninput="updateEff(${e.id},'label',this.value)">
        <button class="btn btn-sm btn-danger" type="button" onclick="removeEffect(${e.id})" title="Supprimer" aria-label="Supprimer l'effet"><i class="fa-solid fa-trash"></i></button>
      </h3>`;

        if (e.verbatim) return `
    <div class="card">${head}
      <div>
        <div class="field">
          <label>Lignes de l'effet (<code>e${k}</code>) — importées telles quelles</label>
          <textarea class="mono" rows="9" oninput="updateEff(${e.id},'continuousRaw',this.value)">${E(e.continuousRaw)}</textarea>
          <span class="hint">Effet passif ou non couvert par le formulaire : le code d'origine est conservé tel quel. Les fonctions qu'il utilise sont dans « Code importé du script » plus bas.</span>
        </div>
      </div>
    </div>`;

        return `
    <div class="card">${head}
      <div>

        <div class="grid-2">
          <div class="field">
            <label>Type d'effet</label>
            <select onchange="updateEff(${e.id},'typeMain',this.value)">
              ${typeOptions.map(([v, l]) => `<option value="${v}" ${e.typeMain === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Portée OPT</label>
            <select onchange="updateEff(${e.id},'optScope',this.value)">
              <option value="CARD" ${e.optScope === 'CARD' ? 'selected' : ''}>Par carte nommée (id)</option>
              <option value="COPY" ${e.optScope === 'COPY' ? 'selected' : ''}>Par exemplaire sur le terrain</option>
              <option value="NONE" ${e.optScope === 'NONE' ? 'selected' : ''}>Aucune limite</option>
            </select>
          </div>
          <div class="field">
            <label>Fois par tour</label>
            <input type="number" min="1" value="${A(e.optN)}" oninput="updateEff(${e.id},'optN',this.value)">
          </div>
          <div class="field">
            <label>Options OPT</label>
            <div class="row" style="gap:8px">
              <label class="check"><input type="checkbox" ${e.optOath ? 'checked' : ''} onchange="updateEff(${e.id},'optOath',this.checked)"> Serment (Oath)</label>
              <label class="check"><input type="checkbox" ${e.optDuel ? 'checked' : ''} onchange="updateEff(${e.id},'optDuel',this.checked)"> Par duel entier</label>
            </div>
          </div>
        </div>

        ${['TRIGGER_O', 'TRIGGER_F'].includes(e.typeMain) ? `
        <div class="grid-2">
          <div class="field">
            <label>Event déclencheur</label>
            <select onchange="updateEff(${e.id},'eventCode',this.value)">
              ${TRIGGER_EVENTS.map(([v, l]) => `<option value="${v}" ${e.eventCode === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          ${e.eventCode === 'CUSTOM' ? `<div class="field"><label>Event Lua (ex: EVENT_PHASE+PHASE_MAIN)</label><input type="text" value="${A(e.eventRaw || '')}" placeholder="EVENT_..." oninput="updateEff(${e.id},'eventRaw',this.value)"></div>` : `
          <div class="field">
            <label>Se déclenche aussi sur</label>
            <select onchange="updateEff(${e.id},'cloneEvent',this.value)">
              ${CLONE_EVENTS.map(([v, l]) => `<option value="${v}" ${e.cloneEvent === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>`}
        </div>` : ''}

        <div class="field">
          <label>Catégories (SetCategory — cumulables)</label>
          <div class="row" style="gap:8px;max-height:190px;overflow:auto">
            ${CATEGORIES.map(([v, l]) => `
              <label class="check">
                <input type="checkbox" ${e.categories.includes(v) ? 'checked' : ''} onchange="toggleEffCategory(${e.id},'${v}')"> ${l}
              </label>`).join('')}
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label>Condition préalable</label>
            <select onchange="updateEff(${e.id},'cond',this.value)">
              ${CONDITIONS.map(([v, l]) => `<option value="${v}" ${e.cond === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Coût d'activation</label>
            <select onchange="updateEff(${e.id},'cost',this.value)">
              ${COSTS.map(([v, l]) => `<option value="${v}" ${e.cost === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          ${e.cost === 'LP' ? `<div class="field"><label>Montant LP</label><input type="number" value="${A(e.costAmount)}" oninput="updateEff(${e.id},'costAmount',this.value)"></div>` : ''}
          ${(e.cost === 'DISCARD' || e.cost === 'BANISH_GY' || e.cost === 'TRIBUTE') ? `<div class="field"><label>Nombre de cartes</label><input type="number" min="1" value="${A(e.costAmount)}" oninput="updateEff(${e.id},'costAmount',this.value)"></div>` : ''}
        </div>
        ${e.cost === 'CUSTOM' ? `<div class="field"><label>Corps de s.cost${k} (raw)</label><textarea class="mono" placeholder="if chk==0 then return ... end" oninput="updateEff(${e.id},'costRaw',this.value)">${E(e.costRaw)}</textarea></div>` : ''}

        ${e.cond === 'CUSTOM' ? `<div class="field"><label>Corps de s.con${k} (raw)</label><textarea class="mono" placeholder="return Duel...(...)" oninput="updateEff(${e.id},'condRaw',this.value)">${E(e.condRaw)}</textarea></div>` : ''}

        ${isPassive(e) ? '' : `
        <div class="grid-2">
          <div class="field">
            <label>Action de résolution (target + operation)</label>
            <select onchange="updateEff(${e.id},'op',this.value)">
              ${OPERATIONS.map(([v, l]) => `<option value="${v}" ${e.op === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          ${['SPECIAL_SUMMON_DECK', 'SPECIAL_SUMMON_GY', 'TOHAND_DECK', 'TOHAND_GY', 'DESTROY_FIELD', 'BANISH_FIELD', 'BANISH_GY_OP', 'MILL', 'DRAW', 'TOKEN_SUMMON'].includes(e.op) ? `<div class="field"><label>Quantité</label><input type="number" min="1" value="${A(e.opAmount)}" oninput="updateEff(${e.id},'opAmount',this.value)"></div>` : ''}
          ${['DAMAGE', 'RECOVER', 'ATK_UP', 'ATK_DOWN'].includes(e.op) ? `<div class="field"><label>Valeur</label><input type="number" min="0" step="100" value="${A(e.opAmount)}" oninput="updateEff(${e.id},'opAmount',this.value)"></div>` : ''}
        </div>
        ${e.op === 'CUSTOM' ? `<div class="field"><label>Fonctions s.tg${k} / s.op${k} (raw)</label><textarea class="mono" rows="8" placeholder="function s.tg${k}(e,tp,eg,ep,ev,re,r,rp,chk)&#10;&#9;if chk==0 then return true end&#10;end&#10;function s.op${k}(e,tp,eg,ep,ev,re,r,rp)&#10;&#9;-- ...&#10;end" oninput="updateEff(${e.id},'opRaw',this.value)">${E(e.opRaw)}</textarea><span class="hint">Si tu supprimes la fonction <code>s.tg${k}</code> (ou <code>s.op${k}</code>), la ligne SetTarget (ou SetOperation) correspondante n'est pas générée.</span></div>` : ''}
        `}

        <div class="field">
          <label>${isPassive(e) ? `Lignes ajoutées dans initial_effect (SetCode / SetValue / SetOperation…)` : `Lignes brutes ajoutées à l'effet (SetDescription, SetProperty, SetLabel…)`}</label>
          <textarea class="mono" rows="${isPassive(e) ? 4 : 3}" placeholder="e${k}:SetProperty(EFFECT_FLAG_DELAY)" oninput="updateEff(${e.id},'continuousRaw',this.value)">${E(e.continuousRaw)}</textarea>
          ${isPassive(e) ? `<span class="hint">Un effet Continu/Passif n'a pas de target/operation — c'est ici que vous branchez le vrai comportement (immunité, restriction, octroi de stats…).</span>` : ''}
        </div>

        <div class="field">
          <label>Fonctions Lua additionnelles (optionnel — s.val${k}, s.cfilter${k}, etc.)</label>
          <textarea class="mono" placeholder="function s.cfilter${k}(c)&#10;&#9;return c:IsCode(CARD_DARK_MAGICIAN)&#10;end" oninput="updateEff(${e.id},'extraFunctions',this.value)">${E(e.extraFunctions || '')}</textarea>
        </div>

      </div>
    </div>`;
    }).join('');
}

/* Les versions du module remplacent celles de la page (la page les appelle par leur nom global). */
document.addEventListener('DOMContentLoaded', function () {
    root.generateScript = generateScriptV2;
    root.renderEffects = renderEffectsV2;
});

})(typeof window !== 'undefined' ? window : globalThis);
