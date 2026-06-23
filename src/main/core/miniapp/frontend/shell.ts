/**
 * Frontend shell for the Sentinel Telegram Mini App.
 *
 * This module owns the design system (`CSS`), the client-side framework
 * (`CORE_JS` — a view registry + `App.*` API used by every view module), and
 * the document scaffolding (`HEAD`, `SHELL_HTML`) plus the `assemble()` function
 * that stitches a self-contained HTML document from a list of view modules.
 *
 * IMPORTANT: `CORE_JS` (and any view JS) nests inside this TS template string,
 * so the embedded JS MUST NOT use backtick template literals or `${}`. Use
 * 'a' + b string concatenation and escaped double quotes only.
 *
 * Design language: modern dark glassmorphic — translucent blurred surfaces,
 * a teal→violet gradient accent, glow on active states, springy
 * micro-interactions, animated status dots, a streaming cursor, typing dots,
 * skeleton shimmer, and smooth view/tab transitions. Honors
 * `env(safe-area-inset-bottom)` and disables animation under
 * `prefers-reduced-motion`.
 */

export const CSS = `
:root{
  /* surfaces */
  --bg:#0a0d14;
  --bg2:#10141f;
  --glass:rgba(22,27,40,.62);
  --glass-brd:rgba(255,255,255,.10);
  /* gradient accent pair */
  --accent:#39e3c7;
  --accent2:#7c6bff;
  --glow:0 0 0 1px rgba(124,107,255,.28), 0 8px 28px rgba(57,227,199,.18);
  /* text */
  --txt:#e8ecf4;
  --hint:#8b93a7;
  /* status */
  --ok:#36e08a;
  --err:#ff5d6c;
  --warn:#ffb454;
  /* geometry / fx */
  --radius:18px;
  --blur:18px;
  color-scheme:dark;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{margin:0;padding:0;}
body{
  font:16px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif;
  color:var(--txt);
  background:
    radial-gradient(120% 80% at 18% -10%, rgba(124,107,255,.20), transparent 60%),
    radial-gradient(120% 90% at 92% 0%, rgba(57,227,199,.14), transparent 55%),
    linear-gradient(180deg, var(--bg2), var(--bg) 42%);
  background-attachment:fixed;
  min-height:100vh;
  padding-bottom:calc(96px + env(safe-area-inset-bottom));
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}

/* ---- glass surface primitive ---- */
.glass{
  background:var(--glass);
  -webkit-backdrop-filter:blur(var(--blur)) saturate(150%);
  backdrop-filter:blur(var(--blur)) saturate(150%);
  border:1px solid var(--glass-brd);
  box-shadow:0 8px 30px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.05);
  border-radius:var(--radius);
}

/* ---- top bar ---- */
.topbar{
  position:sticky;top:0;z-index:20;
  display:flex;align-items:center;justify-content:space-between;
  gap:12px;padding:calc(env(safe-area-inset-top) + 14px) 18px 14px;
  background:linear-gradient(180deg, rgba(10,13,20,.86), rgba(10,13,20,.0));
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
}
.topbar h1{
  margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em;
  display:flex;align-items:center;gap:8px;
}
.ico{
  width:40px;height:40px;border-radius:12px;border:1px solid var(--glass-brd);
  background:var(--glass);color:var(--txt);font-size:18px;line-height:1;
  display:grid;place-items:center;cursor:pointer;
  transition:transform .18s cubic-bezier(.2,.9,.3,1.4), box-shadow .2s ease, background .2s ease;
}
.ico:hover{background:rgba(36,43,64,.7);}
.ico:active{transform:scale(.9) rotate(-90deg);}
.ico:focus-visible{outline:none;box-shadow:var(--glow);}

/* ---- main view region ---- */
#view{padding:8px 16px 24px;display:flex;flex-direction:column;gap:14px;}
.viewIn{animation:viewIn .34s cubic-bezier(.2,.8,.25,1) both;}

.card{padding:16px 18px;}
.card .sub{color:var(--hint);font-size:14px;margin-top:6px;}
.row{display:flex;align-items:center;gap:12px;}
h2,h3{letter-spacing:-.01em;}
.muted{color:var(--hint);}

/* ---- tab bar (fixed bottom, safe-area aware) ---- */
.tabbar{
  position:fixed;left:12px;right:12px;z-index:30;
  bottom:calc(12px + env(safe-area-inset-bottom));
  display:flex;gap:6px;padding:8px;
  justify-content:space-around;
}
.tab{
  flex:1 1 0;min-height:48px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
  border:none;background:transparent;cursor:pointer;
  color:var(--hint);font-size:11px;font-weight:600;letter-spacing:.01em;
  border-radius:13px;padding:6px 4px;
  transition:color .2s ease, background .25s ease, transform .18s cubic-bezier(.2,.9,.3,1.4);
}
.tab span{line-height:1;}
.tab svg,.tab .gl{font-size:19px;line-height:1;}
.tab:active{transform:scale(.92);}
.tab:focus-visible{outline:none;box-shadow:var(--glow);}
.tab.active{
  color:#06121a;
  background:linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow:0 6px 20px rgba(124,107,255,.40), 0 0 0 1px rgba(255,255,255,.10) inset;
}

/* ---- chat bubbles ---- */
.bubble{
  max-width:84%;padding:11px 14px;border-radius:16px;
  font-size:15px;line-height:1.5;white-space:pre-wrap;word-break:break-word;
  animation:viewIn .26s ease both;
}
.bubble.user{
  align-self:flex-end;color:#06121a;
  background:linear-gradient(135deg, var(--accent), var(--accent2));
  border-bottom-right-radius:5px;
  box-shadow:0 4px 16px rgba(124,107,255,.30);
}
.bubble.ai{
  align-self:flex-start;
  background:var(--glass);border:1px solid var(--glass-brd);
  -webkit-backdrop-filter:blur(var(--blur));backdrop-filter:blur(var(--blur));
  border-bottom-left-radius:5px;
}

/* ---- streaming cursor ---- */
.cursor{
  display:inline-block;width:.5ch;height:1.05em;margin-left:1px;
  vertical-align:text-bottom;border-radius:1px;
  background:linear-gradient(180deg, var(--accent), var(--accent2));
  animation:blink 1s steps(2,start) infinite;
}

/* ---- typing dots ---- */
.typing{display:inline-flex;align-items:center;gap:5px;padding:4px 2px;}
.typing i{
  width:7px;height:7px;border-radius:50%;display:inline-block;
  background:var(--hint);
  animation:typing 1.2s ease-in-out infinite;
}
.typing i:nth-child(2){animation-delay:.18s;}
.typing i:nth-child(3){animation-delay:.36s;}

/* ---- skeleton shimmer ---- */
.skel{
  position:relative;overflow:hidden;border-radius:10px;
  background:rgba(255,255,255,.05);min-height:14px;
}
.skel::after{
  content:"";position:absolute;inset:0;transform:translateX(-100%);
  background:linear-gradient(90deg, transparent, rgba(255,255,255,.10), transparent);
  animation:shimmer 1.4s ease infinite;
}

/* ---- status dots ---- */
.dot{
  width:9px;height:9px;border-radius:50%;display:inline-block;flex:0 0 auto;
  background:var(--hint);box-shadow:0 0 0 0 transparent;
}
.dot.run{background:var(--ok);animation:pulse 2s ease-in-out infinite;}
.dot.bad{background:var(--err);animation:pulse 1.2s ease-in-out infinite;--pc:255,93,108;}
.dot.warn{background:var(--warn);animation:pulse 1.8s ease-in-out infinite;--pc:255,180,84;}
.dot.run{--pc:54,224,138;}

/* ---- on/off pill ---- */
.pill{
  font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  padding:3px 9px;border-radius:999px;border:1px solid var(--glass-brd);
}
.pill.on{color:var(--ok);background:rgba(54,224,138,.12);border-color:rgba(54,224,138,.30);}
.pill.off{color:var(--hint);background:rgba(255,255,255,.04);}

/* ---- buttons ---- */
.btn{
  appearance:none;border:1px solid var(--glass-brd);background:var(--glass);
  color:var(--txt);font:inherit;font-weight:600;font-size:14px;
  min-height:44px;padding:0 16px;border-radius:12px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  transition:transform .16s cubic-bezier(.2,.9,.3,1.4), box-shadow .2s ease, background .2s ease;
}
.btn:active{transform:scale(.96);}
.btn:focus-visible{outline:none;box-shadow:var(--glow);}
.btn.primary{
  border:none;color:#06121a;
  background:linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow:0 6px 20px rgba(124,107,255,.34);
}
.btn[disabled]{opacity:.5;cursor:not-allowed;transform:none;}

/* ---- toast ---- */
.toast{
  position:fixed;left:50%;bottom:calc(108px + env(safe-area-inset-bottom));
  transform:translate(-50%, 16px);z-index:50;
  max-width:88%;padding:11px 16px;border-radius:14px;font-size:14px;font-weight:600;
  background:var(--glass);border:1px solid var(--glass-brd);
  -webkit-backdrop-filter:blur(var(--blur));backdrop-filter:blur(var(--blur));
  box-shadow:0 10px 34px rgba(0,0,0,.5);
  opacity:0;pointer-events:none;
  transition:opacity .28s ease, transform .28s cubic-bezier(.2,.9,.3,1.4);
}
.toast.show{opacity:1;transform:translate(-50%,0);}
.toast.ok{border-color:rgba(54,224,138,.34);}
.toast.err{color:#ffd9dd;border-color:rgba(255,93,108,.40);background:rgba(58,22,28,.6);}

/* ---- keyframes ---- */
@keyframes blink{0%,49%{opacity:1;}50%,100%{opacity:0;}}
@keyframes typing{0%,60%,100%{transform:translateY(0);opacity:.5;}30%{transform:translateY(-5px);opacity:1;}}
@keyframes shimmer{0%{transform:translateX(-100%);}100%{transform:translateX(100%);}}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(var(--pc,54,224,138),.55);}70%{box-shadow:0 0 0 7px rgba(var(--pc,54,224,138),0);}}
@keyframes viewIn{from{opacity:0;transform:translateY(10px) scale(.99);}to{opacity:1;transform:translateY(0) scale(1);}}

@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{
    animation-duration:.001ms !important;animation-iteration-count:1 !important;
    transition-duration:.001ms !important;scroll-behavior:auto !important;
  }
}
`

export const CORE_JS = `
(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  var initData = (tg && tg.initData) || '';
  var root = document.getElementById('view');
  var tabbar = document.getElementById('tabbar');
  var views = [];           // {id,label,icon,render,owner}
  var current = null;

  function esc(s){ return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];}); }
  function dot(st){ if(st==='running')return '<span class=\"dot run\"></span>'; if(st==='crashed'||st==='crash-looping')return '<span class=\"dot bad\"></span>'; if(st==='scheduled'||st==='starting')return '<span class=\"dot warn\"></span>'; return '<span class=\"dot\"></span>'; }
  function pill(on){ return '<span class=\"pill '+(on?'on':'off')+'\">'+(on?'on':'off')+'</span>'; }
  function haptic(k){ try{ if(tg&&tg.HapticFeedback) tg.HapticFeedback.impactOccurred(k||'light'); }catch(e){} }

  function api(path, opts){
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['X-Tg-Init-Data'] = initData;
    if (opts.body) opts.headers['Content-Type'] = 'application/json';
    return fetch(path, opts).then(function(r){
      return r.json().then(function(j){ if(!r.ok) throw new Error(j&&j.error?j.error:('HTTP '+r.status)); return j; });
    });
  }
  function toast(msg, kind){
    var t=document.createElement('div'); t.className='toast '+(kind||'ok'); t.textContent=msg;
    document.body.appendChild(t);
    setTimeout(function(){ t.classList.add('show'); },10);
    setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ t.remove(); },300); }, 2600);
  }
  function registerView(id, def){ def.id=id; views.push(def); }
  function paintTabs(){
    var h='';
    views.forEach(function(v){ if(v.owner && !App.state.owner) return;
      h += '<button class=\"tab'+(current===v.id?' active':'')+'\" data-v=\"'+v.id+'\">'+(v.icon||'')+'<span>'+esc(v.label)+'</span></button>'; });
    tabbar.innerHTML=h;
    Array.prototype.forEach.call(tabbar.querySelectorAll('[data-v]'), function(el){
      el.addEventListener('click', function(){ haptic('light'); go(el.getAttribute('data-v')); });
    });
  }
  function go(id){
    current=id; paintTabs();
    var v=views.filter(function(x){return x.id===id;})[0]; if(!v) return;
    root.classList.remove('viewIn'); void root.offsetWidth; root.classList.add('viewIn');
    root.innerHTML=''; v.render(root, App.state);
  }
  function refresh(){
    return api('/api/state').then(function(s){
      App.state.bots=s.bots||[]; App.state.config=s.config; App.state.owner=!!s.owner;
      paintTabs(); if(current) go(current);
    });
  }
  var App = { state:{ bots:[], config:null, owner:false, initData:initData },
    registerView:registerView, go:go, api:api, refresh:refresh, toast:toast,
    esc:esc, dot:dot, pill:pill, haptic:haptic };
  window.App = App;

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState!=='loading') boot();
  function boot(){
    if (!initData){ root.innerHTML='<div class=\"glass card\"><b>Open this from your Sentinel bot.</b><div class=\"sub\">No signed Telegram session here.</div></div>'; return; }
    refresh().then(function(){ if(!current && views.length) go(views[0].id); })
      .catch(function(e){ root.innerHTML=''; toast(e.message,'err'); });
  }
})();
`

export const HEAD = `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Sentinel</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>` + CSS + `</style></head>`

export const SHELL_HTML = `<body>
<div class="topbar"><h1>🛰️ Sentinel</h1><button class="ico" id="refresh">↻</button></div>
<div id="view"></div>
<nav class="tabbar glass" id="tabbar"></nav>`

// views: each contributes { css?, html?, js } — js runs AFTER CORE_JS so App exists.
export function assemble(views: { css?: string; js: string }[]): string {
  const viewCss = views.map((v) => v.css || '').join('\n')
  const viewJs = views.map((v) => v.js).join('\n')
  return HEAD.replace('</style>', viewCss + '</style>')
    + SHELL_HTML
    + '<script>' + CORE_JS + '</script>'
    + '<script>' + viewJs + '</script>'
    + '<script>(function(){var r=document.getElementById("refresh");if(r)r.addEventListener("click",function(){App.haptic("light");App.refresh();});})();</script>'
    + '</body></html>'
}
