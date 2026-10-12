// ============================================================================
// 10-main.js — Exposition pour cdb-translator.js + démarrage
// ============================================================================
// ⚠️ À charger EN DERNIER (juste avant cdb-translator.js).
// ============================================================================

window.appState = appState;
window.findCardByName = findCardByName;
window.generateJsonForCard = generateJsonForCard;
window.buildCsvRow = buildCsvRow;
window.CSV_FIELDS = CSV_FIELDS;
window.downloadAsZip = downloadAsZip;
window.downloadManagerCsv = downloadManagerCsv;
window.sanitizeFilename = sanitizeFilename;
window.searchCards = searchCards;
window.toast = toast;
window.downloadBlob = downloadBlob;
window.escapeHtml = escapeHtml;
window.normalizeForSearch = normalizeForSearch;
window.CUSTOM_IDS = CUSTOM_IDS;
window.showConfirm = showConfirm;

// ============================================================================
// DÉMARRAGE
// ============================================================================
(async function boot() {
  await initDatabase();
  if (appState.dbReady) {
    toast("Base locale prête ⚡", "ok");
  } else {
    toast("Aucune base locale chargée.", "err");
  }
})();
