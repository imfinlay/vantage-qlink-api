// public/js/logging-controls.js (enhanced)
(function () {
  function $(sel) { return document.querySelector(sel); }
  function ensureUI() {
    let root = $("#logging-controls");
    if (!root) {
      root = document.createElement("div");
      root.id = "logging-controls";
      root.className = "hb-card hb-stack";
      document.body.prepend(root);
    }
    if (!root.querySelector("#logStatus")) {
      root.innerHTML = `
        <h3 class="hb-card__title" style="margin-right:auto">Logging</h3>
        <span id="logStatus" class="hb-badge"><span class="hb-dot"></span> …</span>
        <button id="logStartBtn" class="hb-btn hb-btn--primary" type="button">Start logging</button>
        <button id="logStopBtn" class="hb-btn hb-btn--ghost" type="button">Stop logging</button>
      `;
    } else {
      $("#logStartBtn")?.classList.add("hb-btn","hb-btn--primary");
      $("#logStopBtn")?.classList.add("hb-btn","hb-btn--ghost");
      $("#logStatus")?.classList.add("hb-badge");
      root.classList.add("hb-card","hb-stack");
    }
  }
  function applyStatus(enabled, file) {
    const statusEl = $("#logStatus");
    if (!statusEl) return;
    statusEl.textContent = enabled ? `enabled → ${file || ""}` : "disabled";
    const dot = document.createElement("span"); dot.className = "hb-dot"; statusEl.prepend(dot);
    statusEl.classList.remove("hb-badge--ok","hb-badge--warn","hb-badge--danger");
    statusEl.classList.add(enabled ? "hb-badge--ok" : "hb-badge--warn");
    if ($("#logStartBtn")) $("#logStartBtn").disabled = enabled;
    if ($("#logStopBtn"))  $("#logStopBtn").disabled  = !enabled;
  }
  async function getStatus() {
    try { const r = await fetch("/logging/status", { cache: "no-store" }); const j = await r.json(); applyStatus(!!j.enabled, j.file); }
    catch { const s = $("#logStatus"); if (s) { s.textContent = "status error"; s.classList.add("hb-badge--danger"); } }
  }
  async function post(url){ await fetch(url, { method: "POST" }); await getStatus(); }
  function wire() {
    $("#logStartBtn")?.addEventListener("click", () => post("/logging/start"));
    $("#logStopBtn")?.addEventListener("click",  () => post("/logging/stop"));
    getStatus(); setInterval(getStatus, 15000);
  }
  function init(){ ensureUI(); wire(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
