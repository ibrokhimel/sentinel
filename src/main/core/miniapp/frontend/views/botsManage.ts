/**
 * botsManage.ts — Bots management view (owner-only tab)
 *
 * Registers 'bots' with App.registerView (owner:true hides tab for non-owners).
 * Provides: Import from URL, with a status note about the zip-upload stub.
 * No backticks or ${} in the embedded JS string — concatenation only.
 */
export const botsManageView: { js: string } = {
  js: '(function(){'
    + 'function render(root){'
    +   'var html=\'<div class="glass card"><b>Import bot</b>\''
    +     '+\'<label class="field"><span class="lab">Git URL</span>\''
    +     '+\'<input id="importurl" type="url" placeholder="https://github.com/…" /></label>\''
    +     '+\'<div class="btns"><button class="act" id="importbtn">Import from URL</button></div>\''
    +     '+\'<div class="sub" style="margin-top:8px">Zip upload is not yet supported — use a git URL above.</div></div>\';'
    +   'root.innerHTML=html;'
    +   'var btn=document.getElementById(\'importbtn\');'
    +   'btn.addEventListener(\'click\',function(){'
    +     'var url=document.getElementById(\'importurl\').value.trim();'
    +     'if(!url){App.toast(\'Enter a git URL\',\'err\');return;}'
    +     'btn.disabled=true;btn.textContent=\'Importing…\';'
    +     'App.api(\'/api/bots/import\',{method:\'POST\',body:JSON.stringify({url:url})})'
    +       '.then(function(){'
    +         'App.toast(\'Bot imported\');'
    +         'App.refresh().then(function(){App.go(\'fleet\');});'
    +       '})'
    +       '.catch(function(e){'
    +         'btn.disabled=false;btn.textContent=\'Import from URL\';'
    +         'App.toast(e.message,\'err\');'
    +       '});'
    +   '});'
    + '}'
    + 'App.registerView(\'bots\',{label:\'Bots\',icon:\'➕\',owner:true,render:render});'
    + '})();',
}
