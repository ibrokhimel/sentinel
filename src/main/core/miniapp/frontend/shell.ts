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
 * Design language: Raycast dark command-palette — one continuous near-black
 * canvas (#07080a) with a faint 4-step surface ladder, hairline 1px borders
 * (#242728) and NO drop shadows, a single white CTA pill as the only primary
 * action color, Inter typography with the `ss03` stylistic set enabled
 * site-wide, tight 6–10px card radii, and saturated accent colors
 * (green/red/yellow/blue) reserved for status illustration only. Depth is
 * built entirely from the surface ladder, never from shadow or blur. The one
 * decorative moment is a red diagonal-stripe band behind the hero headline.
 * Honors `env(safe-area-inset-bottom)` and disables animation under
 * `prefers-reduced-motion`.
 */

export const CSS = `
:root{
  /* surface ladder — canvas -> surface -> elevated -> card */
  --canvas:#07080a;
  --surface:#0d0d0d;
  --surface-el:#101111;
  --surface-card:#121212;
  /* legacy aliases kept so view modules keep resolving */
  --bg:#07080a;
  --bg2:#0d0d0d;
  --glass:#0d0d0d;              /* card fill */
  --glass-brd:#242728;          /* hairline */
  --hair-strong:rgba(255,255,255,.16);
  /* the only primary action color is white — both accent stops resolve to it
     so every existing gradient CTA renders as Raycast's white pill */
  --accent:#ffffff;
  --accent2:#ffffff;
  --on-primary:#000000;
  --glow:0 0 0 1px var(--hair-strong);
  /* text ladder */
  --txt:#f4f4f6;                /* ink */
  --body:#cdcdcd;
  --hint:#9c9c9d;               /* mute */
  --ash:#6a6b6c;
  /* saturated accents — illustration / status only, never on chrome buttons */
  --ok:#59d499;
  --err:#ff6161;
  --warn:#ffc533;
  --info:#57c1ff;
  /* hero red stripe */
  --stripe-a:#ff5757;
  --stripe-b:#a1131a;
  /* geometry / fx */
  --radius:10px;
  --blur:14px;
  color-scheme:dark;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{margin:0;padding:0;}
body{
  font:16px/1.6 Inter,"Inter Fallback",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
  font-feature-settings:"calt","kern","liga","ss03";
  color:var(--txt);
  background:var(--canvas);
  min-height:100vh;
  padding-bottom:calc(96px + env(safe-area-inset-bottom));
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}

/* ---- card surface primitive (flat — depth from the surface ladder) ---- */
.glass{
  background:var(--surface);
  border:1px solid var(--glass-brd);
  border-radius:var(--radius);
}

/* ---- top bar (Raycast primary-nav: canvas, hairline bottom rule) ---- */
.topbar{
  position:sticky;top:0;z-index:20;
  display:flex;align-items:center;justify-content:space-between;
  gap:12px;padding:calc(env(safe-area-inset-top) + 14px) 18px 13px;
  background:var(--canvas);
  border-bottom:1px solid var(--glass-brd);
}
.topbar h1{
  margin:0;font-size:18px;font-weight:600;letter-spacing:.2px;
  display:flex;align-items:center;gap:8px;
}
.ico{
  width:36px;height:36px;border-radius:8px;border:1px solid var(--glass-brd);
  background:var(--surface-el);color:var(--txt);font-size:16px;line-height:1;
  display:grid;place-items:center;cursor:pointer;
  transition:transform .16s cubic-bezier(.2,.9,.3,1.4), border-color .2s ease, background .2s ease;
}
.ico:hover{border-color:var(--hair-strong);}
.ico:active{transform:scale(.92);}
.ico:focus-visible{outline:none;box-shadow:var(--glow);}

/* ---- inline line icons (Raycast monochrome, currentColor) ---- */
.ic-svg{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;vertical-align:-.18em;flex:0 0 auto;}
.brandmark{color:var(--txt);}

/* ---- main view region ---- */
#view{padding:14px 16px 24px;display:flex;flex-direction:column;gap:14px;}
.viewIn{animation:viewIn .28s cubic-bezier(.2,.8,.25,1) both;}

.card{padding:18px;}
.card>b{display:block;font-size:16px;font-weight:500;letter-spacing:.2px;margin-bottom:10px;}
.card .sub{color:var(--hint);font-size:14px;margin-top:6px;}
.row{display:flex;align-items:center;gap:12px;}
h2,h3{letter-spacing:.2px;font-weight:600;}
.muted{color:var(--hint);}

/* ---- tab bar (fixed bottom, safe-area aware) ---- */
.tabbar{
  position:fixed;left:12px;right:12px;z-index:30;
  bottom:calc(12px + env(safe-area-inset-bottom));
  display:flex;gap:6px;padding:6px;
  background:var(--surface);border:1px solid var(--glass-brd);border-radius:14px;
  justify-content:space-around;
}
.tab{
  flex:1 1 0;min-height:46px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
  border:none;background:transparent;cursor:pointer;
  color:var(--hint);font-size:11px;font-weight:500;letter-spacing:.2px;
  border-radius:8px;padding:6px 4px;
  transition:color .2s ease, background .2s ease, transform .16s cubic-bezier(.2,.9,.3,1.4);
}
.tab span{line-height:1;}
.tab svg,.tab .gl{font-size:18px;line-height:1;filter:grayscale(1) opacity(.8);}
.tab:active{transform:scale(.94);}
.tab:focus-visible{outline:none;box-shadow:var(--glow);}
.tab.active{
  color:var(--txt);
  background:var(--surface-el);
}
.tab.active svg,.tab.active .gl{filter:none;}

/* ---- chat bubbles ---- */
.bubble{
  max-width:84%;padding:10px 14px;border-radius:10px;
  font-size:15px;line-height:1.5;white-space:pre-wrap;word-break:break-word;
  animation:viewIn .22s ease both;
}
.bubble.user{
  align-self:flex-end;color:var(--on-primary);
  background:var(--accent);
  border-bottom-right-radius:4px;
}
.bubble.ai{
  align-self:flex-start;
  background:var(--surface);border:1px solid var(--glass-brd);
  border-bottom-left-radius:4px;
}

/* ---- streaming cursor ---- */
.cursor{
  display:inline-block;width:.5ch;height:1.05em;margin-left:1px;
  vertical-align:text-bottom;border-radius:1px;
  background:var(--txt);
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
.dot.run{background:var(--ok);animation:pulse 2s ease-in-out infinite;--pc:89,212,153;}
.dot.bad{background:var(--err);animation:pulse 1.2s ease-in-out infinite;--pc:255,97,97;}
.dot.warn{background:var(--warn);animation:pulse 1.8s ease-in-out infinite;--pc:255,197,51;}

/* ---- on/off + status pill ---- */
.pill{
  font-size:12px;font-weight:400;letter-spacing:.4px;
  padding:2px 8px;border-radius:4px;border:1px solid var(--glass-brd);
}
.pill.on{color:var(--ok);background:rgba(89,212,153,.15);border-color:rgba(89,212,153,.30);}
.pill.off{color:var(--hint);background:var(--surface-el);}

/* ---- buttons ----
   Primary = white pill (.btn.primary / .act). Secondary = transparent + hairline
   (.btn / .act.sec). Tertiary surface fill used for icon-load buttons. */
.btn,.act{
  appearance:none;border:1px solid transparent;
  color:var(--on-primary);background:var(--accent);
  font:inherit;font-weight:500;font-size:14px;letter-spacing:.2px;
  min-height:36px;padding:0 16px;border-radius:8px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  transition:transform .14s cubic-bezier(.2,.9,.3,1.4), background .18s ease, border-color .18s ease;
}
.btn:active,.act:active{transform:scale(.97);}
.btn:focus-visible,.act:focus-visible{outline:none;box-shadow:var(--glow);}
.btn:hover,.act:hover{background:#e8e8e8;}
.btn.primary,.act.primary{border:none;color:var(--on-primary);background:var(--accent);}
/* secondary / tertiary: drop the white fill */
.btn,.act.sec,.btn.sec{
  color:var(--txt);background:transparent;border-color:var(--glass-brd);
}
.btn:hover,.act.sec:hover,.btn.sec:hover{background:var(--surface-el);border-color:var(--hair-strong);}
.btn[disabled],.act[disabled]{opacity:.5;cursor:not-allowed;transform:none;}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}

/* ---- back link ---- */
.back{
  appearance:none;border:none;background:transparent;color:var(--hint);
  font:inherit;font-size:14px;font-weight:500;letter-spacing:.2px;
  padding:4px 0;cursor:pointer;align-self:flex-start;
}
.back:active{opacity:.7;}

/* ---- key/value rows (detail + settings) ---- */
.row .k{color:var(--hint);font-size:14px;flex:1;}
.row .v{color:var(--txt);font-size:14px;font-weight:500;}
.infoCard .row{justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--glass-brd);}
.infoCard .row:last-child{border-bottom:none;}

/* ---- form fields ---- */
.field{display:block;margin-top:12px;}
.field .lab{display:block;color:var(--hint);font-size:13px;letter-spacing:.1px;margin-bottom:6px;}
.field input,input[type=text],input[type=url],input[type=password],input[type=number]{
  width:100%;background:var(--surface-el);color:var(--txt);
  border:1px solid var(--glass-brd);border-radius:8px;
  font:inherit;font-size:16px;padding:8px 12px;min-height:36px;outline:none;
  transition:border-color .18s ease;
}
.field input:focus,input:focus{border-color:var(--hair-strong);}
.field input[disabled],input[disabled]{opacity:.6;}

/* ---- toggle row ---- */
.switch{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;}
.switch>span{font-size:14px;}
.switch .pill{cursor:pointer;font-weight:500;}

/* ---- sliding toggle switch (interactive on/off) ---- */
.toggle{
  position:relative;width:44px;height:26px;flex:0 0 auto;padding:0;cursor:pointer;
  border-radius:999px;border:1px solid var(--glass-brd);background:var(--surface-el);
  transition:background .18s ease,border-color .18s ease;
}
.toggle .knob{
  position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;
  background:var(--hint);
  transition:transform .2s cubic-bezier(.2,.9,.3,1.4),background .18s ease;
}
.toggle.on{background:var(--accent);border-color:var(--accent);}
.toggle.on .knob{transform:translateX(18px);background:var(--on-primary);}
.toggle:active .knob{width:23px;}
.toggle[disabled]{opacity:.5;cursor:not-allowed;}
.toggle:focus-visible{outline:none;box-shadow:var(--glow);}

/* ---- read-only / info banner ---- */
.banner{
  display:flex;align-items:center;gap:10px;padding:12px 14px;
  border-radius:8px;background:var(--surface-el);border:1px solid var(--glass-brd);
  color:var(--hint);font-size:13px;letter-spacing:.1px;
}
.banner .ic-svg{color:var(--hint);flex:0 0 auto;}
.banner b{color:var(--body);font-weight:500;}

/* ---- modal (in-app prompt/confirm — WebView-safe) ---- */
.modalWrap{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.6);animation:fadeIn .16s ease;}
.modal{width:100%;max-width:340px;background:var(--surface);border:1px solid var(--glass-brd);border-radius:12px;padding:18px;animation:viewIn .2s ease both;}
.modal h3{margin:0 0 6px;font-size:17px;font-weight:600;letter-spacing:.2px;}
.modal .sub{margin:0 0 14px;font-size:14px;}
.modal input{margin-bottom:14px;}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;}
.modal-actions .act{min-width:88px;}

/* ---- fleet sort/filter controls ---- */
.fleetControls{display:flex;flex-direction:column;gap:8px;margin:2px;}
.chipRow{display:flex;gap:6px;flex-wrap:wrap;}
.chipRow .lbl{align-self:center;color:var(--hint);font-size:12px;letter-spacing:.2px;margin-right:2px;}
.chip{appearance:none;border:1px solid var(--glass-brd);background:transparent;color:var(--body);font:inherit;font-size:13px;font-weight:500;letter-spacing:.2px;padding:5px 12px;border-radius:999px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;}
.chip:active{transform:scale(.95);}
.chip.on{background:var(--surface-el);color:var(--txt);border-color:var(--hair-strong);}

/* ---- sparkline ---- */
.spark{display:block;width:100%;height:auto;}
.sparkRow{margin-top:12px;}
.sparkLabel{display:flex;justify-content:space-between;color:var(--hint);font-size:11px;letter-spacing:.2px;margin-bottom:4px;}

/* ---- input with trailing affordance (e.g. show/hide key) ---- */
.inputWrap{position:relative;}
.inputWrap input{padding-right:42px;}
.eyeBtn{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:32px;height:30px;display:grid;place-items:center;border:none;background:transparent;color:var(--hint);cursor:pointer;border-radius:6px;}
.eyeBtn:active{color:var(--txt);}

/* ---- user / access rows (approved + pending) ---- */
.userRow{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--glass-brd);}
.userRow:last-child{border-bottom:none;}
.avatar{width:34px;height:34px;border-radius:50%;background:var(--surface-el);border:1px solid var(--glass-brd);display:grid;place-items:center;font-size:14px;font-weight:600;color:var(--body);flex:0 0 auto;}
.userMeta{flex:1;min-width:0;}
.userMeta b{display:block;font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.userMeta .sub{margin-top:1px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.userActs{display:flex;gap:6px;flex:0 0 auto;}
.pendingHint{color:var(--warn)!important;}

/* ---- risk badges (auto-approve scope) ---- */
.badgeRow{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}
.badge{font-size:12px;letter-spacing:.2px;padding:3px 8px;border-radius:4px;border:1px solid var(--glass-brd);display:inline-flex;align-items:center;gap:5px;}
.badge.ok{color:var(--ok);background:rgba(89,212,153,.15);border-color:rgba(89,212,153,.30);}
.badge.bad{color:var(--err);background:rgba(255,97,97,.15);border-color:rgba(255,97,97,.30);}
.badge .ic-svg{color:inherit;}

/* ---- collaborators (Team tab + bot-detail card) ---- */
.collabbox{margin-top:10px;}
.collabRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:14px 0;border-top:1px solid var(--glass-brd);}
.collabName{order:1;flex:1 1 auto;min-width:0;font-size:14px;font-weight:600;color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.collabRemove{order:2;flex:0 0 auto;}
.collabCaps{order:3;flex:1 1 100%;display:flex;flex-wrap:wrap;gap:6px;}
.capToggle{display:inline-flex;align-items:center;gap:6px;padding:7px 11px;border:1px solid var(--glass-brd);border-radius:999px;font-size:12px;line-height:1;color:var(--hint);cursor:pointer;user-select:none;transition:color .15s ease,background .15s ease,border-color .15s ease;}
.capToggle input{margin:0;width:15px;height:15px;accent-color:var(--ok);flex:0 0 auto;cursor:pointer;}
.capToggle:has(input:checked){color:var(--txt);background:var(--surface-el);border-color:var(--hair-strong);}
.collabAdd{display:flex;gap:8px;align-items:center;margin-top:14px;}
.collabSelect{flex:1 1 auto;min-width:0;appearance:none;-webkit-appearance:none;background:var(--surface-el);border:1px solid var(--glass-brd);color:var(--txt);border-radius:8px;padding:9px 12px;font:inherit;font-size:14px;}
.collabAddBtn{flex:0 0 auto;}

/* ---- env secret reveal row ---- */
.envRow{display:flex;align-items:center;gap:8px;}
.envRow input{flex:1 1 auto;min-width:0;}
.envToggle{flex:0 0 auto;}

/* ---- tab bar: keep five tabs from cramming on narrow phones ---- */
.tabbar{gap:4px;}
.tab{font-size:10.5px;padding:6px 3px;gap:2px;}
.tab span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

/* ---- toast ---- */
.toastWrap{position:fixed;left:12px;right:12px;bottom:calc(108px + env(safe-area-inset-bottom));z-index:60;display:flex;flex-direction:column;gap:8px;pointer-events:none;}
.toast{
  position:relative;transform:translateY(16px);
  width:100%;padding:11px 42px 11px 16px;border-radius:14px;font-size:14px;font-weight:700;
  background:var(--glass);border:1px solid var(--glass-brd);
  -webkit-backdrop-filter:blur(var(--blur));backdrop-filter:blur(var(--blur));
  box-shadow:0 10px 34px rgba(0,0,0,.5);
  opacity:0;pointer-events:auto;overflow:hidden;
  transition:opacity .28s ease, transform .28s cubic-bezier(.2,.9,.3,1.4);
}
.toast::after{content:"";position:absolute;left:0;bottom:0;height:2px;width:100%;background:var(--txt);opacity:.5;animation:toastLife 2.6s linear both;}
.toast.show{opacity:1;transform:translateY(0);}
.toast.ok{border-color:rgba(89,212,153,.34);}
.toast.ok::after{background:var(--ok);opacity:1;}
.toast.info{border-color:rgba(87,193,255,.34);}
.toast.info::after{background:var(--info);opacity:1;}
.toast.warn{color:#ffe8c5;border-color:rgba(255,197,51,.44);}
.toast.warn::after{background:var(--warn);opacity:1;}
.toast.err{color:#ffd9dd;border-color:rgba(255,97,97,.40);}
.toast.err::after{background:var(--err);opacity:1;}
.toast button{position:absolute;right:8px;top:7px;width:28px;height:28px;border:1px solid var(--glass-brd);border-radius:8px;background:var(--surface-el);color:inherit;cursor:pointer;}

/* ---- keyframes ---- */
@keyframes blink{0%,49%{opacity:1;}50%,100%{opacity:0;}}
@keyframes typing{0%,60%,100%{transform:translateY(0);opacity:.5;}30%{transform:translateY(-5px);opacity:1;}}
@keyframes shimmer{0%{transform:translateX(-100%);}100%{transform:translateX(100%);}}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(var(--pc,54,224,138),.55);}70%{box-shadow:0 0 0 7px rgba(var(--pc,54,224,138),0);}}
@keyframes viewIn{from{opacity:0;transform:translateY(10px) scale(.99);}to{opacity:1;transform:translateY(0) scale(1);}}
@keyframes toastLife{from{transform:scaleX(1);transform-origin:left;}to{transform:scaleX(0);transform-origin:left;}}

/* ---- Sentinel mini app product surfaces ---- */
/* hero carries the system's one decorative moment: a red diagonal-stripe band
   (Raycast hero launch-banner) layered across the top of the card. */
.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;padding:24px 20px;margin-bottom:12px;overflow:hidden;position:relative;border-radius:var(--radius);}
.hero::before{content:"";position:absolute;left:0;right:0;top:0;height:60px;pointer-events:none;
  background:
    repeating-linear-gradient(115deg,
      transparent 0 26px,
      rgba(255,87,87,.0) 26px 28px),
    linear-gradient(115deg,var(--stripe-a),var(--stripe-b) 70%,transparent 88%);
  -webkit-mask:linear-gradient(180deg,#000,transparent);mask:linear-gradient(180deg,#000,transparent);
  opacity:.5;}
.hero>*{position:relative;}
.hero h2{margin:6px 0 6px;font-size:28px;line-height:1.1;font-weight:600;}
.hero p{margin:0;color:var(--body);font-size:15px;max-width:250px;}
.hero.compact{margin-top:8px;}
.hero.compact::before{display:none;}
.eyebrow{color:var(--hint);font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.4px;}
.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:12px;}
.metric{padding:14px 16px;display:flex;flex-direction:column;gap:2px;}
.metric span,.metric em{color:var(--hint);font-size:12px;font-style:normal;letter-spacing:.4px;}.metric b{font-size:28px;font-weight:600;letter-spacing:.2px;}
.sectionTitle{display:flex;justify-content:space-between;align-items:end;margin:6px 2px 2px;}.sectionTitle b{font-weight:500;letter-spacing:.2px;}
.botgrid{display:grid;gap:12px;}.botcard{padding:16px;cursor:pointer;transition:border-color .18s ease,background .18s ease;}.botcard:hover{border-color:var(--hair-strong);}.botcard:active{background:var(--surface-el);}
.bothead{display:flex;align-items:center;gap:10px;justify-content:space-between;}.bothead>div{flex:1;min-width:0}.bothead b{display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.statusChip{font-size:12px;text-transform:capitalize;font-weight:500;letter-spacing:.2px;border:1px solid var(--glass-brd);border-radius:4px;padding:2px 8px;color:var(--hint);background:var(--surface-el);}.statusChip.running{color:var(--ok);border-color:rgba(89,212,153,.30);background:rgba(89,212,153,.15);}.statusChip.crashed,.statusChip.crash-looping{color:var(--err);border-color:rgba(255,97,97,.30);background:rgba(255,97,97,.15);}
.miniStats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px;}.miniStats span{background:var(--surface-el);border:1px solid var(--glass-brd);border-radius:8px;padding:8px 10px;color:var(--hint);font-size:11px;letter-spacing:.2px;}.miniStats b{display:block;color:var(--txt);font-size:13px;font-weight:500;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.botbar{display:flex;justify-content:space-between;margin-top:12px;color:var(--hint);font-size:14px;}
.botrow{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--glass-brd);}.botrow:last-child{border-bottom:none;}.botrow .name{flex:1;font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.botrow .sub{margin-top:0;text-transform:capitalize;}
.empty{text-align:center;padding:32px 20px;}.emptyIcon{display:inline-flex;color:var(--hint);margin-bottom:12px;}
.infoCard b{font-weight:500;}
.actionGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));}
.danger{color:var(--err)!important;border-color:rgba(255,97,97,.30)!important;background:rgba(255,97,97,.10)!important;}
.logbox{max-height:280px;overflow:auto;background:var(--canvas);border:1px solid var(--glass-brd);border-radius:8px;padding:12px;font:12px/1.45 ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,monospace;color:var(--body);}

/* ---- live log tail (line-by-line, search + level coloring) ---- */
.logHead{display:flex;align-items:center;gap:8px;margin:10px 0 6px;flex-wrap:wrap;}
.logHead .logSearch{position:relative;flex:1;min-width:150px;}
.logHead .logSearch .ic-svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--hint);pointer-events:none;}
.logHead .logSearch input{padding-left:32px;min-height:34px;font-size:14px;}
.logHead .logTail{display:flex;align-items:center;gap:6px;}
.logTail .ico{width:34px;height:34px;}
.logTail .ico.on{border-color:var(--hair-strong);background:var(--surface);color:var(--txt);}
.logLines{max-height:300px;overflow:auto;background:var(--canvas);border:1px solid var(--glass-brd);border-radius:8px;padding:8px 0;font:12px/1.5 ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,monospace;}
.logLine{display:block;padding:1px 12px;white-space:pre-wrap;word-break:break-word;color:var(--body);}
.logLine.err{color:var(--err);}
.logLine.warn{color:var(--warn);}
.logLine.dim{opacity:.32;}
.logLine.hit{background:rgba(87,193,255,.10);}
.logLine mark{background:rgba(255,197,51,.30);color:inherit;border-radius:2px;padding:0 1px;}
.logEmpty{padding:12px;color:var(--hint);font-size:13px;}

/* ---- bulk fleet actions (owner only) ---- */
.bulkRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 2px 0;}
.bulkRow .lbl{color:var(--hint);font-size:12px;letter-spacing:.2px;margin-right:2px;}
.bulkRow .chip[disabled]{opacity:.5;cursor:not-allowed;}
.progressBox{margin-top:12px;padding:12px;border-radius:8px;background:var(--surface-el);border:1px solid var(--glass-brd);}.disabledUpload{opacity:.72}.importList{display:grid;gap:0}.okText{color:var(--ok);font-weight:500}.err{color:var(--err);font-weight:500;}

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

  /* ---- inline line-icon set (Raycast monochrome, currentColor) ---- */
  var ICONS = {
    grid:'<rect x=\"3\" y=\"3\" width=\"7.5\" height=\"7.5\" rx=\"1.5\"/><rect x=\"13.5\" y=\"3\" width=\"7.5\" height=\"7.5\" rx=\"1.5\"/><rect x=\"3\" y=\"13.5\" width=\"7.5\" height=\"7.5\" rx=\"1.5\"/><rect x=\"13.5\" y=\"13.5\" width=\"7.5\" height=\"7.5\" rx=\"1.5\"/>',
    message:'<path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/>',
    sliders:'<line x1=\"4\" y1=\"21\" x2=\"4\" y2=\"14\"/><line x1=\"4\" y1=\"10\" x2=\"4\" y2=\"3\"/><line x1=\"12\" y1=\"21\" x2=\"12\" y2=\"12\"/><line x1=\"12\" y1=\"8\" x2=\"12\" y2=\"3\"/><line x1=\"20\" y1=\"21\" x2=\"20\" y2=\"16\"/><line x1=\"20\" y1=\"12\" x2=\"20\" y2=\"3\"/><line x1=\"1\" y1=\"14\" x2=\"7\" y2=\"14\"/><line x1=\"9\" y1=\"8\" x2=\"15\" y2=\"8\"/><line x1=\"17\" y1=\"16\" x2=\"23\" y2=\"16\"/>',
    gear:'<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z\"/>',
    plus:'<line x1=\"12\" y1=\"5\" x2=\"12\" y2=\"19\"/><line x1=\"5\" y1=\"12\" x2=\"19\" y2=\"12\"/>',
    plusCircle:'<circle cx=\"12\" cy=\"12\" r=\"9\"/><line x1=\"12\" y1=\"8\" x2=\"12\" y2=\"16\"/><line x1=\"8\" y1=\"12\" x2=\"16\" y2=\"12\"/>',
    refresh:'<polyline points=\"23 4 23 10 17 10\"/><polyline points=\"1 20 1 14 7 14\"/><path d=\"M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15\"/>',
    play:'<polygon points=\"6 4 20 12 6 20 6 4\" fill=\"currentColor\" stroke=\"none\"/>',
    stop:'<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/>',
    download:'<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><polyline points=\"7 10 12 15 17 10\"/><line x1=\"12\" y1=\"15\" x2=\"12\" y2=\"3\"/>',
    upload:'<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/><polyline points=\"17 8 12 3 7 8\"/><line x1=\"12\" y1=\"3\" x2=\"12\" y2=\"15\"/>',
    trash:'<polyline points=\"3 6 5 6 21 6\"/><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/>',
    send:'<line x1=\"12\" y1=\"19\" x2=\"12\" y2=\"5\"/><polyline points=\"5 12 12 5 19 12\"/>',
    chevronDown:'<polyline points=\"6 9 12 15 18 9\"/>',
    pencil:'<path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z\"/>',
    x:'<line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/>',
    lock:'<rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>',
    shield:'<path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\"/>',
    users:'<path d=\"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M23 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>',
    box:'<path d=\"M21 8 12 3 3 8v8l9 5 9-5z\"/><path d=\"M3 8l9 5 9-5\"/><path d=\"M12 13v8\"/>',
    eye:'<path d=\"M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>',
    eyeOff:'<path d=\"M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24\"/><line x1=\"1\" y1=\"1\" x2=\"23\" y2=\"23\"/>',
    bolt:'<polygon points=\"13 2 3 14 12 14 11 22 21 10 12 10 13 2\" fill=\"currentColor\" stroke=\"none\"/>',
    search:'<circle cx=\"11\" cy=\"11\" r=\"7\"/><line x1=\"21\" y1=\"21\" x2=\"16.65\" y2=\"16.65\"/>',
    pause:'<rect x=\"6\" y=\"5\" width=\"4\" height=\"14\" rx=\"1\"/><rect x=\"14\" y=\"5\" width=\"4\" height=\"14\" rx=\"1\"/>'
  };
  function icon(name, size){
    var p = ICONS[name]; if(!p) return '';
    var s = size || 18;
    return '<svg class=\"ic-svg\" viewBox=\"0 0 24 24\" width=\"'+s+'\" height=\"'+s+'\" aria-hidden=\"true\">'+p+'</svg>';
  }
  function dot(st){ if(st==='running')return '<span class=\"dot run\"></span>'; if(st==='crashed'||st==='crash-looping')return '<span class=\"dot bad\"></span>'; if(st==='scheduled'||st==='starting')return '<span class=\"dot warn\"></span>'; return '<span class=\"dot\"></span>'; }
  function pill(on){ return '<span class=\"pill '+(on?'on':'off')+'\">'+(on?'on':'off')+'</span>'; }
  function haptic(k){ try{ if(tg&&tg.HapticFeedback) tg.HapticFeedback.impactOccurred(k||'light'); }catch(e){} }

  /* ---- view-scoped timers (auto-cleared on navigation / re-render) ---- */
  var viewTimers=[];
  function viewTimer(id){ viewTimers.push(id); return id; }
  function clearViewTimers(){ viewTimers.forEach(function(t){ clearInterval(t); }); viewTimers=[]; }

  /* ---- metric history ring buffer (drives sparklines) ---- */
  function pushHistory(bots){
    var H=App.state.history||(App.state.history={});
    (bots||[]).forEach(function(b){
      var r=b.runtime||{}; var id=b.manifest.id;
      var e=H[id]||(H[id]={cpu:[],mem:[]});
      e.cpu.push(typeof r.cpu==='number'?r.cpu:null);
      e.mem.push(typeof r.memMB==='number'?r.memMB:null);
      while(e.cpu.length>60)e.cpu.shift();
      while(e.mem.length>60)e.mem.shift();
    });
  }

  /* ---- sparkline (inline SVG polyline) ---- */
  function spark(points, opts){
    opts=opts||{}; var w=opts.w||120, h=opts.h||28, pad=2;
    var pts=(points||[]).filter(function(n){ return typeof n==='number' && isFinite(n); });
    if(pts.length<2) return '<svg class=\"spark\" width=\"'+w+'\" height=\"'+h+'\"></svg>';
    var max=opts.max!=null?opts.max:Math.max.apply(null,pts);
    var min=opts.min!=null?opts.min:Math.min.apply(null,pts);
    if(max<=min)max=min+1;
    var n=pts.length, dx=(w-pad*2)/(n-1);
    var d=pts.map(function(v,i){ var x=pad+i*dx; var y=h-pad-((v-min)/(max-min))*(h-pad*2); return (i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1); }).join(' ');
    var col=opts.color||'var(--accent)';
    return '<svg class=\"spark\" width=\"'+w+'\" height=\"'+h+'\" viewBox=\"0 0 '+w+' '+h+'\" preserveAspectRatio=\"none\"><path d=\"'+d+'\" fill=\"none\" stroke=\"'+col+'\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>';
  }

  /* ---- modals (Telegram WebView blocks window.prompt/confirm/alert) ---- */
  function confirmModal(opts){
    opts=opts||{};
    return new Promise(function(resolve){
      var w=document.createElement('div'); w.className='modalWrap';
      w.innerHTML='<div class=\"modal\"><h3>'+esc(opts.title||'Are you sure?')+'</h3>'+(opts.body?'<p class=\"sub\">'+esc(opts.body)+'</p>':'')+'<div class=\"modal-actions\"><button type=\"button\" class=\"act sec\" data-no>'+esc(opts.cancel||'Cancel')+'</button><button type=\"button\" class=\"act'+(opts.danger?' danger':'')+'\" data-yes>'+esc(opts.ok||'Confirm')+'</button></div></div>';
      document.body.appendChild(w);
      function done(v){ w.remove(); resolve(v); }
      w.addEventListener('click',function(e){ if(e.target===w) done(false); });
      w.querySelector('[data-no]').addEventListener('click',function(){ haptic('light'); done(false); });
      w.querySelector('[data-yes]').addEventListener('click',function(){ haptic('medium'); done(true); });
    });
  }
  function promptModal(opts){
    opts=opts||{};
    return new Promise(function(resolve){
      var w=document.createElement('div'); w.className='modalWrap';
      w.innerHTML='<div class=\"modal\"><h3>'+esc(opts.title||'Enter a value')+'</h3>'+(opts.body?'<p class=\"sub\">'+esc(opts.body)+'</p>':'')+'<input type=\"text\" value=\"'+esc(opts.value||'')+'\" placeholder=\"'+esc(opts.placeholder||'')+'\" /><div class=\"modal-actions\"><button type=\"button\" class=\"act sec\" data-no>Cancel</button><button type=\"button\" class=\"act\" data-yes>'+esc(opts.ok||'Save')+'</button></div></div>';
      document.body.appendChild(w);
      var inp=w.querySelector('input');
      setTimeout(function(){ try{ inp.focus(); inp.select(); }catch(e){} },30);
      function done(v){ w.remove(); resolve(v); }
      w.addEventListener('click',function(e){ if(e.target===w) done(null); });
      w.querySelector('[data-no]').addEventListener('click',function(){ done(null); });
      w.querySelector('[data-yes]').addEventListener('click',function(){ haptic('light'); done(inp.value); });
      inp.addEventListener('keydown',function(e){ if(e.key==='Enter'){ done(inp.value); } else if(e.key==='Escape'){ done(null); } });
    });
  }

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
    var wrap=document.querySelector('.toastWrap');
    if(!wrap){ wrap=document.createElement('div'); wrap.className='toastWrap'; document.body.appendChild(wrap); }
    // collapse exact duplicates already on screen
    var ex=wrap.querySelectorAll('.toast');
    for(var i=0;i<ex.length;i++){ if(ex[i].getAttribute('data-msg')===String(msg)) return; }
    // cap the stack at 3 — drop the oldest
    while(wrap.children.length>=3){ wrap.removeChild(wrap.firstChild); }
    var t=document.createElement('div'); t.className='toast '+(kind||'ok'); t.setAttribute('data-msg', String(msg));
    t.innerHTML='<span>'+esc(msg)+'</span><button type=\"button\" aria-label=\"Dismiss\">×</button>';
    wrap.appendChild(t);
    var close=function(){ t.classList.remove('show'); setTimeout(function(){ t.remove(); if(!wrap.children.length)wrap.remove(); },300); };
    t.querySelector('button').addEventListener('click', close);
    setTimeout(function(){ t.classList.add('show'); },10);
    setTimeout(close, 2600);
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
    clearViewTimers();
    current=id; paintTabs();
    var v=views.filter(function(x){return x.id===id;})[0]; if(!v) return;
    root.classList.remove('viewIn'); void root.offsetWidth; root.classList.add('viewIn');
    root.innerHTML='';
    try { v.render(root, App.state); }
    catch(e){
      root.innerHTML='<div class=\"glass card empty\"><div class=\"emptyIcon\">'+icon('x',30)+'</div><h3>Something went wrong</h3><p class=\"sub\">'+esc(e&&e.message?e.message:'view error')+'</p><div class=\"btns\"><button class=\"act\" id=\"vbErr\">Reload</button></div></div>';
      var rb=document.getElementById('vbErr'); if(rb) rb.addEventListener('click', function(){ App.refresh(); });
    }
  }
  function refresh(){
    return api('/api/state').then(function(s){
      App.state.bots=s.bots||[]; App.state.config=s.config; App.state.owner=!!s.owner;
      pushHistory(App.state.bots);
      paintTabs(); if(current) go(current);
    });
  }
  var App = { state:{ bots:[], config:null, owner:false, initData:initData, history:{} },
    registerView:registerView, go:go, api:api, refresh:refresh, toast:toast,
    esc:esc, dot:dot, pill:pill, haptic:haptic, icon:icon,
    viewTimer:viewTimer, clearViewTimers:clearViewTimers, spark:spark,
    confirm:confirmModal, prompt:promptModal };
  window.App = App;

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState!=='loading') boot();
  function boot(){
    if (!initData){ root.innerHTML='<div class=\"glass card empty\"><div class=\"emptyIcon\">'+icon('lock',30)+'</div><h2>Sentinel access required</h2><p class=\"sub\">Open this Mini App from the Sentinel Telegram bot so Telegram can pass your signed session.</p><div class=\"btns\"><a class=\"act\" href=\"https://t.me/\" target=\"_blank\" rel=\"noreferrer\">Open Telegram bot</a></div><div class=\"sub\">If this keeps happening, refresh Telegram, reopen the bot menu, or request owner access.</div></div>'; return; }
    root.innerHTML='<div class=\"metrics\"><div class=\"glass metric\"><span class=\"skel\"></span><b class=\"skel\"></b><em class=\"skel\"></em></div><div class=\"glass metric\"><span class=\"skel\"></span><b class=\"skel\"></b><em class=\"skel\"></em></div></div><div class=\"glass card\"><div class=\"skel\" style=\"height:18px;width:60%;margin-bottom:12px\"></div><div class=\"skel\" style=\"height:70px;margin-bottom:10px\"></div><div class=\"skel\" style=\"height:70px\"></div></div>';
    refresh().then(function(){ if(!current && views.length) go(views[0].id); })
      .catch(function(e){ root.innerHTML=''; toast(e.message,'err'); });
  }
})();
`

export const HEAD = `<!doctype html><html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#07080a" />
<title>Sentinel</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" />
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>` + CSS + `</style></head>`

const SVG_SHIELD = '<svg class="ic-svg brandmark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
const SVG_REFRESH = '<svg class="ic-svg" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>'

export const SHELL_HTML = `<body>
<div class="topbar"><h1>` + SVG_SHIELD + ` Sentinel</h1><button class="ico" id="refresh" aria-label="Refresh">` + SVG_REFRESH + `</button></div>
<div id="view"></div>
<nav class="tabbar" id="tabbar"></nav>`

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
