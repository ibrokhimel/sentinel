/**
 * botsManage.ts — Bots management view (owner-only tab)
 *
 * Registers 'bots' with App.registerView (owner:true hides tab for non-owners).
 * No backticks or ${} in the embedded JS string — concatenation only.
 */
export const botsManageView: { js: string } = {
  js: '(function(){'
    + 'function render(root){'
    +   'var bots=App.state.bots||[];'
    +   'var html=\'<section class="hero glass"><div><div class="eyebrow">Onboarding</div><h2>Bots Management</h2><p>Import a bot from Git, watch progress, then manage it from the fleet.</p></div></section>\''
    +     '+\'<div class="glass card"><b>Import bot</b><p class="sub">Paste a public or private Git repository URL. Sentinel will clone, install, and add it to the managed fleet.</p>\''
    +     '+\'<label class="field"><span class="lab">Git repository URL</span><input id="importurl" type="url" placeholder="https://github.com/user/bot.git" /></label>\''
    +     '+\'<div class="btns"><button class="act" id="importbtn">Import bot</button></div><div id="importProgress" class="progressBox"><span class="sub">Ready to import.</span></div></div>\''
    +     '+\'<div class="glass card disabledUpload"><div class="bothead"><div><b>Upload .zip</b><div class="sub">Drag-and-drop packages are planned for a later version.</div></div><span class="pill off">Coming soon</span></div><button class="act sec" disabled>Choose .zip</button></div>\''
    +     '+\'<div class="glass card"><div class="switch"><b>Recent imports / managed bots</b><span class="sub">\'+bots.length+\' total</span></div>\';'
    +   'if(!bots.length){html+=\'<div class="empty"><div class="emptyIcon">\'+App.icon(\'plusCircle\',30)+\'</div><h3>No managed bots yet</h3><p class="sub">Start with a Git URL above. After import, the bot appears in the Fleet tab with health and action controls.</p></div>\';}'
    +   'else{html+=\'<div class="importList">\';bots.slice(0,6).forEach(function(b){html+=\'<div class="botrow"><span>\'+App.dot(b.runtime.status)+\'</span><span class="name">\'+App.esc(b.manifest.name)+\'</span><span class="sub">\'+App.esc(b.runtime.status)+\'</span></div>\';});html+=\'</div>\';}'
    +   'html+=\'</div>\';root.innerHTML=html;'
    +   'var btn=document.getElementById(\'importbtn\');btn.addEventListener(\'click\',function(){var url=document.getElementById(\'importurl\').value.trim();var prog=document.getElementById(\'importProgress\');if(!url){App.toast(\'Enter a git URL\',\'err\');return;}btn.disabled=true;btn.textContent=\'Importing…\';prog.innerHTML=\'<div class="skel" style="height:10px;margin:8px 0"></div><span class="sub">Cloning repository and preparing manifest…</span>\';App.api(\'/api/bots/import\',{method:\'POST\',body:JSON.stringify({url:url})}).then(function(){prog.innerHTML=\'<span class="okText">Imported successfully ✓</span>\';App.toast(\'Bot imported\');return App.refresh().then(function(){App.go(\'fleet\');});}).catch(function(e){btn.disabled=false;btn.textContent=\'Import bot\';prog.innerHTML=\'<span class="err">\'+App.esc(e.message)+\'</span>\';App.toast(e.message,\'err\');});});'
    + '}'
    + 'App.registerView(\'bots\',{label:\'Bots\',icon:App.icon(\'plusCircle\'),owner:true,render:render});'
    + '})();',
}
