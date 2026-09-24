/* Layout and preview behavior. Persistence remains in editor.js. */
let previewTimer;
let previewWidth = 390;
let previewRevision = 0;
let previewTarget = null;
let previewTargetPath = null;
let lastPreviewHtml = '';
let lastPreviewScroll = 0;
let lastEditorFocus = null;
let cardSequence = 0;
let workspaceReady = false;

function bulletinDateHasPassed(value, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(value + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) return false;
  // Use the church's calendar date, including when an editor is traveling.
  const parts = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part = type => parts.find(item=>item.type===type).value;
  return value < `${part('year')}-${part('month')}-${part('day')}`;
}

function confirmPastBulletinDate(value) {
  const dialog=document.getElementById('past-date-dialog');
  if(dialog.open)return Promise.resolve('cancel');
  const format=date=>new Date(date+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  document.getElementById('past-date-description').textContent=`This bulletin is dated ${format(value)}, which is before today. Are you sure you want to publish this date?`;
  document.getElementById('past-date-archive-description').textContent=`Archive this bulletin and copy its content forward to ${format(getNextSunday(value))}. This also updates the live bulletin.`;
  dialog.returnValue='cancel';
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue || 'cancel'),{once:true});
    dialog.showModal();
  });
}

function refreshIcons(root = document) {
  root.querySelectorAll('[data-lucide]').forEach(node => {
    const name = node.getAttribute('data-lucide').replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
    if (window.lucide?.icons[name]) node.replaceWith(lucide.createElement(lucide.icons[name], {'aria-hidden':'true'}));
  });
}

function addMoveControls(row, onChange) {
  const controls = document.createElement('span');
  controls.className = 'move-controls';
  ['up', 'down'].forEach(direction => {
    const button = document.createElement('button');
    button.type='button'; button.className='icon-button';
    button.setAttribute('aria-label', 'Move ' + direction);
    button.innerHTML = `<i data-lucide="arrow-${direction}"></i>`;
    button.addEventListener('click', () => {
      const sibling = direction==='up' ? row.previousElementSibling : row.nextElementSibling;
      if (!sibling) return;
      if (direction==='up') row.parentElement.insertBefore(row,sibling);
      else row.parentElement.insertBefore(sibling,row);
      button.focus();
      if(onChange) onChange();
      document.getElementById('workspace-announcement').textContent = `Moved ${direction}.`;
    });
    controls.append(button);
  });
  row.append(controls); refreshIcons(controls);
}

function decorateEditorCard(el, titleSelector, summarySelector, onChange) {
  const title = el.querySelector(titleSelector);
  const summary = el.querySelector(summarySelector);
  const remove = el.querySelector('.remove-btn');
  const handle = el.querySelector('.list-item__handle');
  const header = document.createElement('div'); header.className='editor-item-header';
  const toggle = document.createElement('button'); toggle.type='button';toggle.className='editor-item-toggle';
  const body = document.createElement('div'); body.className='editor-item-body';body.id=`item-body-${++cardSequence}`;
  toggle.setAttribute('aria-controls',body.id);
  const updateSummary = () => {
    toggle.replaceChildren();
    const name = document.createElement('strong');name.textContent=title.value.trim() || 'Untitled item';
    const description = document.createElement('span');description.textContent=(summary?.value.trim() || 'Add the details for this item').slice(0,120);description.setAttribute('aria-hidden','true');
    toggle.append(name,description);
    remove.setAttribute('aria-label',`Remove ${title.value.trim() || 'item'}`);
  };
  updateSummary();
  handle.setAttribute('aria-hidden','true');
  remove.classList.add('icon-button');
  [...el.children].forEach(child=>{if(child!==handle&&child!==remove)body.append(child);});
  header.append(handle,toggle);el.replaceChildren(header,body);
  // Controls operate on the whole card even though they are displayed in its header.
  addMoveControls(el,onChange);
  header.append(el.querySelector('.move-controls'),remove);
  const opened = !title.value.trim();
  body.hidden=!opened;toggle.setAttribute('aria-expanded',String(opened));
  toggle.addEventListener('click',()=>{body.hidden=!body.hidden;toggle.setAttribute('aria-expanded',String(!body.hidden));});
  el.addEventListener('input',updateSummary);
  el.querySelectorAll('label').forEach((label,index)=>{
    const input=label.querySelector('input:not([type=file]),textarea,select') || label.parentElement.querySelector('input:not([type=file]),textarea,select');
    if(input&&!label.htmlFor){input.id ||= `${body.id}-field-${index}`;label.htmlFor=input.id;}
  });
  el.querySelectorAll('input[type=file]').forEach(input=>input.setAttribute('aria-label','Upload image'));
}

function openFirstCard(container) {
  const first=container.querySelector('.list-item');
  if(first){first.querySelector('.editor-item-body').hidden=false;first.querySelector('.editor-item-toggle').setAttribute('aria-expanded','true');}
}

function scheduleBulletinPreview(reset = false) {
  if (!workspaceReady) return;
  if(reset){previewTarget='overview';lastPreviewScroll=0;}
  clearTimeout(previewTimer);
  previewTimer=setTimeout(renderBulletinPreview,180);
}

function previewSectionId(section) {
  return ({overview:null, appearance:null, announcements:'announcements',savedates:'savedates',thisweek:'thisweek',scripture:'scripture',service:'service',giving:'giving'})[section];
}

function jumpPreviewTo(section) {
  previewTarget=section;
  const frame=document.getElementById('bulletin-preview-frame');
  if(frame?.contentDocument && lastPreviewHtml) scrollPreview(frame,section);
  scheduleBulletinPreview();
}

function scrollPreview(frame,section) {
  const id=previewSectionId(section);
  const doc=frame.contentDocument;
  if(id){
    const target=id==='giving'?doc.querySelector('.giving-card'):doc.getElementById(id);
    if(target) frame.contentWindow.scrollTo(0, Math.max(0,target.getBoundingClientRect().top+frame.contentWindow.scrollY-120));
  }else if(section==='overview'||section==='appearance')frame.contentWindow.scrollTo(0,0);
  lastPreviewScroll=frame.contentWindow.scrollY;
  previewTarget=null;
}

function renderBulletinPreview() {
  if (!workspaceReady || !githubLogin) return;
  const status=document.getElementById('preview-status');
  const frame=document.getElementById('bulletin-preview-frame');
  try {
    updateWorkspaceDate();
    const path=currentEditorPath();
    if(previewTargetPath!==path){lastPreviewScroll=0;previewTarget='overview';previewTargetPath=path;}
    const html=Bulletin.render(extractForm(),Boolean(editingArchivePath));
    if(html===lastPreviewHtml){status.textContent=''; if(previewTarget)scrollPreview(frame,previewTarget);return;}
    const parsed=new DOMParser().parseFromString(html,'text/html');
    // No scripts, forms, or inline event handlers run inside the draft viewport.
    parsed.querySelectorAll('script').forEach(el=>el.remove());
    parsed.querySelectorAll('*').forEach(el=>[...el.attributes].forEach(attr=>{if(/^on/i.test(attr.name))el.removeAttribute(attr.name);}));
    if(lastPreviewHtml)lastPreviewScroll=frame.contentWindow.scrollY;
    const revision=++previewRevision;
    frame.onload=()=>{
      if(revision!==previewRevision)return;
      fitPreview();
      Bulletin.initializePreview(frame.contentDocument,frame.contentWindow);
      refreshIcons(frame.contentDocument);
      frame.contentDocument.addEventListener('click',event=>{
        const link=event.target.closest('a');if(!link)return;
        event.preventDefault();
        const href=link.getAttribute('href');
        if(href?.startsWith('#')) frame.contentDocument.getElementById(href.slice(1))?.scrollIntoView();
        else status.textContent='Links are inactive in this draft preview. Use “View live site” to visit the published bulletin.';
      });
      frame.contentDocument.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&document.getElementById('preview-panel').classList.contains('is-expanded'))expandPreview(false);
      });
      frame.contentDocument.fonts.ready.then(()=>{
        if(revision!==previewRevision)return;
        fitPreview();
        if(previewTarget)scrollPreview(frame,previewTarget);
        else frame.contentWindow.scrollTo(0,lastPreviewScroll);
      });
      status.textContent='';status.classList.remove('preview-error');
    };
    frame.srcdoc='<!doctype html>'+parsed.documentElement.outerHTML;
    lastPreviewHtml=html;
    status.textContent='Updating preview…';
  }catch(error){
    status.textContent='Preview could not update. Showing the last successful preview; your edits are still saved as a draft.';
    status.classList.add('preview-error');
    console.error('Bulletin preview:',error);
  }
}

function fitPreview() {
  const viewport=document.getElementById('preview-viewport');
  const frame=document.getElementById('bulletin-preview-frame');
  if(!viewport?.clientWidth)return;
  const scale=Math.min(1,viewport.clientWidth/previewWidth);
  frame.style.width=previewWidth+'px';
  frame.style.height=Math.max(400,viewport.clientHeight/scale)+'px';
  frame.style.transform=`scale(${scale})`;
  frame.style.marginLeft=Math.max(0,(viewport.clientWidth-previewWidth*scale)/2)+'px';
}

function updateWorkspaceDate() {
  const value=document.getElementById('f-date').value;
  document.getElementById('workspace-date').textContent=(editingArchivePath?'Archive · ':'')+(value?new Date(value+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'Choose a bulletin date');
}

function setWorkspaceView(view) {
  const shell=document.getElementById('admin-shell');if(!shell)return;
  shell.dataset.view=view;
  document.querySelectorAll('[data-workspace-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.workspaceView===view)));
  requestAnimationFrame(fitPreview);
}

function closeNavigation() {
  const nav=document.getElementById('admin-navigation');if(!nav)return;
  const wasOpen=nav.classList.contains('drawer-open');
  nav.classList.remove('drawer-open');nav.removeAttribute('role');nav.removeAttribute('aria-modal');
  document.getElementById('nav-backdrop').hidden=true;
  document.getElementById('nav-toggle').setAttribute('aria-expanded','false');
  if(typeof updateBusyControls==='function')updateBusyControls();
  document.getElementById('preview-panel').inert=false;
  document.getElementById('week-actions').inert=false;
  if(wasOpen)document.getElementById('nav-toggle').focus();
}

function expandPreview(expanded) {
  const panel=document.getElementById('preview-panel');
  panel.classList.toggle('is-expanded',expanded);
  document.getElementById('week-actions').inert=expanded;
  document.getElementById('close-preview').hidden=!expanded;
  document.getElementById('expand-preview').hidden=expanded;
  if(expanded){
    lastEditorFocus=document.activeElement;
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
    document.getElementById('editor-main').inert=true;
    document.getElementById('admin-navigation').inert=true;
    document.querySelector('.admin-header').inert=true;
    document.querySelector('.mobile-actions').inert=true;
    document.querySelector('.mobile-view-tabs').inert=true;
    document.getElementById('close-preview').focus();
  }else{
    panel.removeAttribute('role');panel.removeAttribute('aria-modal');
    document.getElementById('editor-main').inert=persistenceOperationActive;
    document.getElementById('admin-navigation').inert=false;
    document.querySelector('.admin-header').inert=false;
    document.querySelector('.mobile-actions').inert=false;
    document.querySelector('.mobile-view-tabs').inert=false;
    lastEditorFocus?.focus();
  }
  fitPreview();
}

document.addEventListener('DOMContentLoaded',()=>{
  const announcer=document.createElement('span');announcer.id='workspace-announcement';announcer.className='sr-only';announcer.setAttribute('aria-live','polite');document.body.append(announcer);
  refreshIcons();workspaceReady=true;
  document.querySelectorAll('[data-date-choice]').forEach(button=>button.addEventListener('click',()=>document.getElementById('past-date-dialog').close(button.dataset.dateChoice)));
  document.getElementById('past-date-dialog').addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const choices=[...event.currentTarget.querySelectorAll('[data-date-choice]')];
    if(!event.shiftKey && document.activeElement===choices.at(-1)){event.preventDefault();choices[0].focus();}
    else if(event.shiftKey && document.activeElement===choices[0]){event.preventDefault();choices.at(-1).focus();}
  });
  const measureToolbar=()=>{
    document.documentElement.style.setProperty('--admin-header-height',document.querySelector('.admin-header').getBoundingClientRect().height+'px');
    document.documentElement.style.setProperty('--week-actions-height',document.getElementById('week-actions').getBoundingClientRect().height+'px');
  };
  const toolbarObserver=new ResizeObserver(measureToolbar);
  toolbarObserver.observe(document.querySelector('.admin-header'));toolbarObserver.observe(document.getElementById('week-actions'));
  measureToolbar();
  const mobileActions=document.createElement('div');mobileActions.className='mobile-actions';
  const mobilePreview=document.createElement('button');mobilePreview.type='button';mobilePreview.className='btn btn--ghost';mobilePreview.textContent='Preview';mobilePreview.addEventListener('click',()=>setWorkspaceView('preview'));
  const mobilePublish=document.createElement('button');mobilePublish.type='button';mobilePublish.className='btn btn--primary';mobilePublish.addEventListener('click',()=>document.getElementById('publish-btn').click());
  const publishSource=document.getElementById('publish-btn');
  const syncPublish=()=>{mobilePublish.textContent=publishSource.textContent;mobilePublish.disabled=publishSource.disabled;};syncPublish();
  new MutationObserver(syncPublish).observe(publishSource,{attributes:true,childList:true,subtree:true});
  mobileActions.append(mobilePreview,mobilePublish);document.getElementById('admin-shell').append(mobileActions);
  const accountTools=document.createElement('div');accountTools.className='nav-account-tools';
  const liveLink=document.createElement('a');liveLink.href='/';liveLink.target='_blank';liveLink.rel='noopener';liveLink.textContent='View live site';liveLink.className='btn btn--ghost';
  const signout=document.createElement('button');signout.type='button';signout.className='btn btn--ghost';signout.textContent='Sign out';
  signout.addEventListener('click',()=>document.getElementById('signout-btn').click());accountTools.append(liveLink,signout);
  document.getElementById('admin-navigation').append(accountTools);
  document.querySelectorAll('[data-workspace-view]').forEach(button=>button.addEventListener('click',()=>setWorkspaceView(button.dataset.workspaceView)));
  document.querySelectorAll('[data-preview-width]').forEach(button=>button.addEventListener('click',()=>{
    previewWidth=Number(button.dataset.previewWidth);
    document.querySelectorAll('[data-preview-width]').forEach(el=>el.setAttribute('aria-pressed',String(el===button)));
    fitPreview();
    const section=document.querySelector('[data-section].active')?.dataset.section;
    if(section)requestAnimationFrame(()=>jumpPreviewTo(section));
  }));
  document.getElementById('expand-preview').addEventListener('click',()=>expandPreview(true));
  document.getElementById('close-preview').addEventListener('click',()=>expandPreview(false));
  document.getElementById('nav-toggle').addEventListener('click',()=>{
    const nav=document.getElementById('admin-navigation');nav.classList.add('drawer-open');nav.setAttribute('role','dialog');nav.setAttribute('aria-modal','true');
    document.getElementById('nav-toggle').setAttribute('aria-expanded','true');document.getElementById('nav-backdrop').hidden=false;
    document.getElementById('editor-main').inert=true;document.getElementById('preview-panel').inert=true;
    document.getElementById('week-actions').inert=true;
    document.getElementById('nav-close').focus();
  });
  document.getElementById('nav-close').addEventListener('click',closeNavigation);
  document.getElementById('nav-backdrop').addEventListener('click',closeNavigation);
  document.addEventListener('keydown',event=>{
    const expanded=document.querySelector('.preview-panel.is-expanded');
    const drawer=document.querySelector('.drawer-open');
    if(event.key==='Escape'){if(expanded)expandPreview(false);if(drawer)closeNavigation();}
    const modal=expanded||drawer;
    if(event.key==='Tab'&&modal){
      const controls=[...modal.querySelectorAll('button:not([hidden]),a[href],iframe')].filter(el=>el.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  const ro=new ResizeObserver(fitPreview);ro.observe(document.getElementById('preview-viewport'));
  matchMedia('(min-width:1200px)').addEventListener('change',()=>{closeNavigation();fitPreview();});
  // Give static controls without a visible associated label an accessible name.
  document.querySelectorAll('.size-control input').forEach(input=>input.setAttribute('aria-label',input.id.replace('f-','').replaceAll('-',' ')+' size'));
  document.getElementById('new-time-day').setAttribute('aria-label','Service day');
  document.getElementById('new-time').setAttribute('aria-label','Service time');
  document.querySelector('.img-dropzone')?.setAttribute('aria-label','Upload scripture image');
  setWorkspaceView('edit');scheduleBulletinPreview(true);
});
