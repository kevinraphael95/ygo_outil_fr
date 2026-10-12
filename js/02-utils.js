// ============================================================================
// 02-utils.js — Utilitaires : toasts, presse-papier, téléchargements, ZIP
// ============================================================================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function downloadBlob(data, filename, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sanitizeFilename(name) { return name.replace(/[\\/:*?"<>|]/g, "").trim(); }
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ============================================================================
// TOASTS
// ============================================================================
function toast(msg, kind = "info") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  const icon = kind === "ok" ? "✅" : kind === "err" ? "❌" : kind === "warn" ? "⚠️" : "ℹ️";
  const text = String(msg);
  const truncated = text.length > TOAST_MAX_LENGTH ? text.slice(0, TOAST_MAX_LENGTH) + "…" : text;
  el.innerHTML = `<span>${icon}</span><span>${escapeHtml(truncated)}</span>`;
  toastsEl.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 0.3s, transform 0.3s";
    el.style.opacity = "0";
    el.style.transform = "translateX(40px)";
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

// ============================================================================
// COPIE PRESSE-PAPIER
// ============================================================================
function copyTextToClipboard(text, buttonEl, resetLabel) {
  const showResult = (ok) => {
    if (!buttonEl) { if (ok) toast("Copié !", "ok"); return; }
    buttonEl.textContent = ok ? "✅ Copié !" : "❌ Échec";
    setTimeout(() => (buttonEl.textContent = resetLabel), 1500);
  };
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    showResult(ok);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showResult(true), () => fallback());
  } else fallback();
}

// ============================================================================
// ZIP
// ============================================================================
async function downloadAsZip(files) {
  if (typeof JSZip === "undefined") { toast("JSZip non chargé.", "err"); return; }
  const zip = new JSZip();
  const usedNames = new Map();
  files.forEach(({ filename, json }) => {
    let finalName = filename;
    if (usedNames.has(filename)) {
      const n = usedNames.get(filename) + 1;
      usedNames.set(filename, n);
      finalName = filename.replace(/\.json$/, `-${n}.json`);
    } else usedNames.set(filename, 1);
    zip.file(finalName, json);
  });
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, "cartes-ygopro.zip");
}
