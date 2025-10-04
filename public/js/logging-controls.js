// public/js/logging-controls.js
(function(){
  function $(sel){ return document.querySelector(sel); }
  const startBtn = $("#logStartBtn");
  const stopBtn  = $("#logStopBtn");
  const statusEl = $("#logStatus");

  async function getStatus(){
    try{
      const r = await fetch('/logging/status');
      const j = await r.json();
      statusEl.textContent = j.enabled ? `enabled → ${j.file}` : 'disabled';
      if (startBtn && stopBtn){
        startBtn.disabled = j.enabled;
        stopBtn.disabled  = !j.enabled;
      }
    }catch(e){
      statusEl.textContent = 'status error';
    }
  }

  async function post(url){
    const r = await fetch(url, { method: 'POST' });
    const j = await r.json().catch(()=>({}));
    await getStatus();
    if (j && j.message) {
      console.log('[logging]', j.message);
    }
  }

  if (startBtn) startBtn.addEventListener('click', ()=>post('/logging/start'));
  if (stopBtn)  stopBtn.addEventListener('click',  ()=>post('/logging/stop'));

  // init
  getStatus();
})();
