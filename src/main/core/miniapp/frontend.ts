/**
 * Self-contained Sentinel dashboard served by service.ts. Single HTML document
 * (inline CSS + vanilla JS, no build step). Mirrors the desktop GUI: fleet
 * status, per-bot Start/Stop/Restart + autostart + logs + env, and global
 * settings. Every API call carries the Telegram `initData` for server-side auth.
 *
 * The inline script intentionally avoids backtick template literals so it nests
 * safely inside this TS template string.
 */
export const MINIAPP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Sentinel</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--tg-theme-bg-color, #0f1115);
    color: var(--tg-theme-text-color, #f2f2f2);
    padding: 14px 14px calc(14px + env(safe-area-inset-bottom));
    line-height: 1.45;
  }
  h1 { font-size: 19px; margin: 0; }
  .muted { color: var(--tg-theme-hint-color, #8a8f98); }
  .sub { color: var(--tg-theme-hint-color, #8a8f98); font-size: 13px; }
  .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 14px; }
  .tab {
    flex: 1; text-align: center; padding: 8px; border-radius: 10px; font-weight: 600; font-size: 14px;
    background: var(--tg-theme-secondary-bg-color, #1b1e24); color: var(--tg-theme-hint-color, #8a8f98);
    border: none; cursor: pointer;
  }
  .tab.active { background: var(--tg-theme-button-color, #2481cc); color: var(--tg-theme-button-text-color, #fff); }
  .card {
    background: var(--tg-theme-secondary-bg-color, #1b1e24);
    border-radius: 14px; padding: 12px 14px; margin-bottom: 10px;
  }
  .botrow { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .botrow .name { font-weight: 600; flex: 1; }
  .dot { font-size: 13px; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; font-size: 14px; }
  .row .k { color: var(--tg-theme-hint-color, #8a8f98); }
  .row .v { font-weight: 600; text-align: right; word-break: break-word; }
  .btns { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
  button.act {
    flex: 1; min-width: 84px; padding: 9px; border-radius: 10px; border: none; font-weight: 600; font-size: 14px;
    background: var(--tg-theme-button-color, #2481cc); color: var(--tg-theme-button-text-color, #fff); cursor: pointer;
  }
  button.act.sec { background: var(--tg-theme-secondary-bg-color, #2a2e36); color: var(--tg-theme-text-color, #f2f2f2); }
  button.act:disabled { opacity: .5; }
  pre {
    white-space: pre-wrap; word-break: break-all; font-size: 12px; margin: 8px 0 0;
    max-height: 320px; overflow: auto; color: var(--tg-theme-hint-color, #aab);
  }
  label.field { display: block; margin: 8px 0; }
  label.field .lab { font-size: 12px; color: var(--tg-theme-hint-color, #8a8f98); display: block; margin-bottom: 4px; }
  input[type=text], input[type=password] {
    width: 100%; padding: 8px 10px; border-radius: 9px; font: inherit;
    border: 1px solid var(--tg-theme-hint-color, #333); background: var(--tg-theme-bg-color, #0f1115);
    color: var(--tg-theme-text-color, #f2f2f2);
  }
  .switch { display: flex; align-items: center; justify-content: space-between; padding: 7px 0; }
  .pill { font-size: 12px; padding: 2px 9px; border-radius: 999px; background: #8883; }
  .pill.on { background: #1faa5933; color: #34d27b; }
  .pill.off { background: #e53e3e22; color: #ef6b6b; }
  .back { background: none; border: none; color: var(--tg-theme-link-color, #62a8ff); font: inherit; padding: 0; cursor: pointer; }
  .err { color: #ef6b6b; font-size: 13px; margin: 8px 0; }
  .ico { background: none; border: none; color: var(--tg-theme-link-color, #62a8ff); font: inherit; cursor: pointer; }
</style>
</head>
<body>
<div class="topbar">
  <h1>🛰️ Sentinel</h1>
  <button class="ico" id="refresh">↻ Refresh</button>
</div>
<div class="tabs">
  <button class="tab active" id="tab-fleet">Fleet</button>
  <button class="tab" id="tab-settings">Settings</button>
</div>
<div id="view"></div>

<script>
(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  var initData = (tg && tg.initData) || '';
  var view = document.getElementById('view');
  var state = { tab: 'fleet', bots: [], config: null, owner: false, detail: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c];
    });
  }
  function dot(status) {
    if (status === 'running') return '🟢';
    if (status === 'crashed' || status === 'crash-looping') return '🔴';
    if (status === 'scheduled') return '🟡';
    if (status === 'starting') return '🟠';
    return '⚪️';
  }
  function pill(on) { return '<span class="pill ' + (on?'on':'off') + '">' + (on?'on':'off') + '</span>'; }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['X-Tg-Init-Data'] = initData;
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j && j.error ? j.error : ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function showErr(msg) {
    var d = document.createElement('div');
    d.className = 'err';
    d.textContent = msg;
    view.insertBefore(d, view.firstChild);
  }

  function load() {
    if (!initData) {
      view.innerHTML = '<div class="card"><b>Open this from your Sentinel bot.</b>'
        + '<div class="sub" style="margin-top:6px">There is no signed Telegram session here, '
        + 'so the dashboard cannot authenticate. Tap your bot\\'s menu button to open it.</div></div>';
      return;
    }
    api('/api/state').then(function (s) {
      state.bots = s.bots || [];
      state.config = s.config;
      state.owner = !!s.owner;
      render();
    }).catch(function (e) { view.innerHTML=''; showErr(e.message); });
  }

  function render() {
    if (state.detail) return renderDetail();
    if (state.tab === 'settings') return renderSettings();
    return renderFleet();
  }

  // ---- Fleet ----
  function renderFleet() {
    if (!state.bots.length) { view.innerHTML = '<div class="card muted">No bots imported yet.</div>'; return; }
    var running = state.bots.filter(function (b){ return b.runtime.status==='running'; }).length;
    var html = '<div class="sub" style="margin-bottom:8px">' + running + '/' + state.bots.length + ' running</div>';
    state.bots.forEach(function (b) {
      var r = b.runtime;
      var meta = r.status==='running'
        ? (r.pid ? 'pid ' + r.pid : 'running') + (r.cpu!=null ? ' · ' + r.cpu + '% cpu' : '')
        : (r.status==='crashed' ? 'exit ' + (r.lastExitCode==null?'?':r.lastExitCode) : r.status);
      html += '<div class="card botrow" data-id="' + esc(b.manifest.id) + '">'
        + '<span class="dot">' + dot(r.status) + '</span>'
        + '<span class="name">' + esc(b.manifest.name) + '</span>'
        + '<span class="sub">' + esc(meta) + '</span></div>';
    });
    view.innerHTML = html;
    Array.prototype.forEach.call(view.querySelectorAll('.botrow'), function (el) {
      el.addEventListener('click', function () { openDetail(el.getAttribute('data-id')); });
    });
  }

  function openDetail(id) {
    state.detail = state.bots.filter(function (b){ return b.manifest.id===id; })[0] || null;
    render();
  }

  // ---- Bot detail ----
  function renderDetail() {
    var b = state.detail, m = b.manifest, r = b.runtime;
    var html = '<button class="back" id="back">‹ Fleet</button>'
      + '<div class="card"><div class="botrow" style="cursor:default">'
      + '<span class="dot">' + dot(r.status) + '</span><span class="name">' + esc(m.name) + '</span>'
      + '<span class="sub">' + esc(r.status) + '</span></div>'
      + '<div class="row"><span class="k">PID</span><span class="v">' + (r.pid==null?'—':r.pid) + '</span></div>'
      + '<div class="row"><span class="k">Restarts</span><span class="v">' + (r.restarts||0) + '</span></div>'
      + (r.uptime ? '<div class="row"><span class="k">Uptime</span><span class="v">' + esc(r.uptime) + '</span></div>' : '')
      + (r.memMB!=null ? '<div class="row"><span class="k">Memory</span><span class="v">' + r.memMB + ' MB</span></div>' : '')
      + '<div class="row"><span class="k">Installed</span><span class="v">' + pill(r.installed) + '</span></div>'
      + '<div class="row"><span class="k">Autostart</span><span class="v">' + pill(m.autostart) + '</span></div>';
    if (state.owner) {
      html += '<div class="btns">'
        + '<button class="act" data-act="start">▶ Start</button>'
        + '<button class="act sec" data-act="stop">■ Stop</button>'
        + '<button class="act sec" data-act="restart">↻ Restart</button></div>'
        + '<div class="btns"><button class="act sec" data-act="' + (m.autostart?'autostart-off':'autostart-on') + '">'
        + (m.autostart?'Disable autostart':'Enable autostart') + '</button></div>';
    }
    html += '</div>'
      + '<div class="card"><div class="switch"><b>Logs</b><button class="ico" id="loadlogs">Load</button></div>'
      + '<pre id="logs" class="muted">tap Load…</pre></div>'
      + '<div class="card"><div class="switch"><b>Environment</b><button class="ico" id="loadenv">Load</button></div>'
      + '<div id="envbox" class="sub">tap Load…</div></div>';
    view.innerHTML = html;

    document.getElementById('back').addEventListener('click', function () { state.detail=null; render(); });
    Array.prototype.forEach.call(view.querySelectorAll('[data-act]'), function (el) {
      el.addEventListener('click', function () { doAction(m.id, el.getAttribute('data-act'), el); });
    });
    document.getElementById('loadlogs').addEventListener('click', function () { loadLogs(m.id); });
    document.getElementById('loadenv').addEventListener('click', function () { loadEnv(m.id); });
  }

  function doAction(id, action, btn) {
    if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    Array.prototype.forEach.call(view.querySelectorAll('[data-act]'), function(e){ e.disabled=true; });
    api('/api/action', { method:'POST', body: JSON.stringify({ id:id, action:action }) })
      .then(function (res) {
        // refresh underlying list + this detail
        return api('/api/state').then(function (s) {
          state.bots = s.bots; state.config = s.config; state.owner = !!s.owner;
          state.detail = state.bots.filter(function(b){ return b.manifest.id===id; })[0] || null;
          render();
        });
      })
      .catch(function (e) { render(); showErr(e.message); });
  }

  function loadLogs(id) {
    var pre = document.getElementById('logs');
    pre.textContent = 'loading…';
    api('/api/logs?id=' + encodeURIComponent(id) + '&n=80')
      .then(function (r) { pre.textContent = r.text || '(no logs)'; })
      .catch(function (e) { pre.textContent = 'error: ' + e.message; });
  }

  function loadEnv(id) {
    var box = document.getElementById('envbox');
    box.textContent = 'loading…';
    api('/api/env?id=' + encodeURIComponent(id)).then(function (env) {
      if (!env.keys.length) { box.innerHTML = '<span class="muted">no env keys</span>'; return; }
      var secret = {}; (env.secretKeys||[]).forEach(function(k){ secret[k]=true; });
      var html = '';
      env.keys.forEach(function (k) {
        var isSec = !!secret[k];
        var ph = isSec ? (env.hasValue[k] ? '•••••• (set — leave blank to keep)' : 'not set') : '';
        html += '<label class="field"><span class="lab">' + esc(k) + (isSec?' 🔒':'') + '</span>'
          + '<input type="' + (isSec?'password':'text') + '" data-k="' + esc(k) + '" '
          + 'value="' + esc(isSec ? '' : (env.current[k]||'')) + '" placeholder="' + esc(ph) + '" /></label>';
      });
      if (state.owner) html += '<div class="btns"><button class="act" id="saveenv">Save env</button></div>';
      box.innerHTML = html;
      var save = document.getElementById('saveenv');
      if (save) save.addEventListener('click', function () {
        var values = {};
        Array.prototype.forEach.call(box.querySelectorAll('input[data-k]'), function (inp) {
          values[inp.getAttribute('data-k')] = inp.value;
        });
        save.disabled = true; save.textContent = 'Saving…';
        api('/api/env', { method:'POST', body: JSON.stringify({ id:id, values:values }) })
          .then(function () { save.textContent = 'Saved ✓'; })
          .catch(function (e) { save.disabled=false; save.textContent='Save env'; showErr(e.message); });
      });
    }).catch(function (e) { box.textContent = 'error: ' + e.message; });
  }

  // ---- Settings ----
  function renderSettings() {
    var c = state.config; if (!c) { view.innerHTML=''; return; }
    var ro = !state.owner;
    var html = '<div class="card"><b>Notifications</b>'
      + switchRow('notifyEnabled', 'Crash alerts', c.notify.enabled, ro)
      + field('notifyChatId', 'Owner chat ID', c.notify.chatId, ro, false)
      + '<div class="row"><span class="k">Bot token</span><span class="v">' + pill(c.notify.hasToken) + '</span></div></div>'

      + '<div class="card"><b>AI agent</b>'
      + field('agentBaseUrl', 'Base URL', c.agent.baseUrl, ro, false)
      + field('agentModel', 'Model', c.agent.model, ro, false)
      + field('agentKey', 'API key (blank = keep)', '', ro, true)
      + '<div class="row"><span class="k">Configured</span><span class="v">' + pill(c.agent.ready) + '</span></div></div>'

      + '<div class="card"><b>Automation</b>'
      + switchRow('autoApprove', 'Auto-approve agent actions (YOLO)', c.autoApprove, ro)
      + switchRow('autoUpdate', 'Scheduled auto-update', c.autoUpdateEnabled, ro) + '</div>'

      + '<div class="card"><b>Runtime</b> <span class="sub">(read-only here)</span>'
      + '<div class="row"><span class="k">Remote control</span><span class="v">' + pill(c.control.enabled) + '</span></div>'
      + '<div class="row"><span class="k">Background agent</span><span class="v">' + pill(c.backgroundAgent) + '</span></div>'
      + '<div class="sub" style="margin-top:6px">Toggle these from the desktop app — turning control off would close this dashboard.</div></div>';

    if (!ro) html += '<div class="btns"><button class="act" id="savesettings">Save settings</button></div>';
    view.innerHTML = html;
    wireSwitches();
    var ss = document.getElementById('savesettings');
    if (ss) ss.addEventListener('click', saveSettings);
  }

  function switchRow(id, label, on, ro) {
    return '<div class="switch"><span>' + esc(label) + '</span>'
      + '<button class="pill ' + (on?'on':'off') + '" data-switch="' + id + '" data-on="' + (on?'1':'0') + '"'
      + (ro?' disabled':'') + '>' + (on?'on':'off') + '</button></div>';
  }
  function field(id, label, val, ro, pw) {
    return '<label class="field"><span class="lab">' + esc(label) + '</span>'
      + '<input id="' + id + '" type="' + (pw?'password':'text') + '" value="' + esc(val) + '"'
      + (ro?' disabled':'') + ' /></label>';
  }
  function wireSwitches() {
    Array.prototype.forEach.call(view.querySelectorAll('[data-switch]'), function (el) {
      el.addEventListener('click', function () {
        var on = el.getAttribute('data-on') === '1';
        el.setAttribute('data-on', on ? '0' : '1');
        el.className = 'pill ' + (on ? 'off' : 'on');
        el.textContent = on ? 'off' : 'on';
      });
    });
  }
  function sw(id) {
    var el = view.querySelector('[data-switch="' + id + '"]');
    return el ? el.getAttribute('data-on') === '1' : undefined;
  }
  function val(id) { var el = document.getElementById(id); return el ? el.value : undefined; }

  function saveSettings() {
    var payload = {
      autoApprove: sw('autoApprove'),
      autoUpdateEnabled: sw('autoUpdate'),
      notify: { enabled: sw('notifyEnabled'), chatId: val('notifyChatId') },
      agent: { baseUrl: val('agentBaseUrl'), model: val('agentModel') }
    };
    var key = val('agentKey'); if (key) payload.agent.key = key;
    var btn = document.getElementById('savesettings');
    btn.disabled = true; btn.textContent = 'Saving…';
    api('/api/settings', { method:'POST', body: JSON.stringify(payload) })
      .then(function (r) { state.config = r.config; btn.textContent = 'Saved ✓'; setTimeout(function(){ btn.disabled=false; btn.textContent='Save settings'; }, 1200); })
      .catch(function (e) { btn.disabled=false; btn.textContent='Save settings'; showErr(e.message); });
  }

  // ---- tabs ----
  document.getElementById('tab-fleet').addEventListener('click', function () {
    state.tab='fleet'; state.detail=null; setTabs(); render();
  });
  document.getElementById('tab-settings').addEventListener('click', function () {
    state.tab='settings'; state.detail=null; setTabs(); render();
  });
  document.getElementById('refresh').addEventListener('click', load);
  function setTabs() {
    document.getElementById('tab-fleet').className = 'tab' + (state.tab==='fleet'?' active':'');
    document.getElementById('tab-settings').className = 'tab' + (state.tab==='settings'?' active':'');
  }

  load();
})();
</script>
</body>
</html>`
