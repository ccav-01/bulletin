const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const nunjucks = require('nunjucks');
const {headline,headlineTheme,referenceHtml,filters}=require('../lib/bulletin');
const current=require('../src/_data/bulletin.json');
const archiveName=fs.readdirSync(path.join(__dirname,'../src/_data/previous')).sort().at(-1);
const archive=require('../src/_data/previous/'+archiveName);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Persistence tests use a future publication date; date-confirmation behavior is separate.
function futurePublicationDate(){const d=new Date();d.setUTCDate(d.getUTCDate()+7);return d.toISOString().slice(0,10);}
async function until(check){for(let i=0;i<100;i++){if(check())return;await wait(20);}assert.fail('Timed out waiting for editor state');}

test('legacy headlines recognize only trailing Bible references and preserve ambiguous content',()=>{
  assert.deepEqual(headline({theme:'"The Sermon on the Mount" - Matthew 5:1-2'}),{title:'"The Sermon on the Mount"',reference:'Matthew 5:1-2'});
  assert.deepEqual(headline({theme:'2 Peter 1:1–11'}),{title:'',reference:'2 Peter 1:1–11'});
  assert.deepEqual(headline({theme:'Faith — 1 Corinthians 12:1-13:13'}),{title:'Faith',reference:'1 Corinthians 12:1-13:13'});
  assert.deepEqual(headline({theme:'A title with no passage'}),{title:'A title with no passage',reference:''});
  const ambiguous='His Divine Power 2 Peter 1:1-11 With Guest Speaker: Zeke Flores';
  assert.equal(headline({theme:ambiguous}).title,ambiguous);
  assert.deepEqual(headline({theme:'Old theme',headline:{title:'',reference:'Matthew 5:1-2'}}),{title:'',reference:'Matthew 5:1-2'});
  assert.equal(headlineTheme({headline:{title:'Faith',reference:'John 3:16'}}),'Faith — John 3:16');
  assert.equal(referenceHtml('Matthew 5:1-2'),'Matthew <span class="reference-range">5:1-2</span>');
  assert.ok(referenceHtml('<img src=x onerror=alert(1)> 3:16').startsWith('&lt;img'));
});

const env=new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(__dirname,'../src/_includes')),{autoescape:true});
Object.entries(filters).forEach(([name,filter])=>env.addFilter(name,filter));
test('all header states have a single accessible heading and no blank reference',()=>{
  for(const [h,expected] of [[{title:'Faith',reference:'John 3:16'},'Faith'],[{title:'',reference:'Matthew 5:1-2'},'Matthew 5:1-2'],[{title:'A title',reference:''},'A title'],[{title:'',reference:''},'Weekly Bulletin']]){
    const doc=new JSDOM(env.render('hero.njk',{bulletin:{...current,headline:h}})).window.document;
    assert.equal(doc.querySelectorAll('h1').length,1);assert.equal(doc.querySelector('h1').textContent,expected);
    assert.equal(Boolean(doc.querySelector('.bulletin-hero__reference')),Boolean(h.title&&h.reference));
  }
});

async function editor(storage={},fixture=current,now=fixture.date+'T12:00:00-07:00'){
  const html=fs.readFileSync(path.join(__dirname,'../_site/admin/index.html'),'utf8');
  const dom=new JSDOM(html,{url:'http://localhost/__test/admin/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  const fixedNow=new Date(now).getTime();
  w.Date=class extends Date { constructor(...args){super(...(args.length?args:[fixedNow]));} static now(){return fixedNow;} };
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(value=''){this.returnValue=value;this.open=false;this.dispatchEvent(new w.Event('close'));};
  await new Promise(resolve=>w.document.addEventListener('DOMContentLoaded',resolve,{once:true}));
  w.structuredClone=structuredClone;w.ResizeObserver=class {observe(){}};
  w.scrollTo=()=>{};
  w.matchMedia=()=>({matches:true,addEventListener(){}});
  w.__fixtures={current:fixture,archive,archiveName};
  Object.entries(storage).forEach(([key,value])=>w.localStorage.setItem(key,value));
  const run=file=>w.eval(fs.readFileSync(path.join(__dirname,'..',file),'utf8'));
  run('tests/mock-github.js');
  run('src/assets/js/Sortable.min.js');run('src/assets/js/lucide.min.js');
  run('_site/admin/preview-context.js');run('_site/admin/preview-templates.js');run('_site/admin/preview-renderer.bundle.js');
  w.eval(fs.readFileSync(path.join(__dirname,'../src/admin/workspace.js'),'utf8')+'\n'+fs.readFileSync(path.join(__dirname,'../src/admin/editor.js'),'utf8'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await until(()=>w.document.querySelector('#admin-shell').style.display==='flex');
  const input=(selector,value)=>{const el=w.document.querySelector(selector);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const saved=()=>Object.fromEntries(Object.keys(w.localStorage).map(key=>[key,w.localStorage.getItem(key)]));
  return {w,dom,input,saved,close:()=>w.close()};
}

test('browser preview and public templates share markup, visibility, escaping and QR codes',async()=>{
  const e=await editor();
  try{
    const data=structuredClone(current);data.headline={title:'<img src=x>',reference:'Matthew 5:1-2'};
    data.announcements[0].ctas=[{label:'Register',url:'https://example.com/register'}];
    data.announcements[0].imageUrl='/assets/ccav-badge-black.png';data.scriptureEnabled=false;
    const browser=new JSDOM(e.w.Bulletin.render(data),{url:'https://bulletin.calvarychapelav.org/'}).window.document;
    const server=new JSDOM(env.render('bulletin-body.njk',{bulletin:data,previousList:require('../src/_data/previousList')()})).window.document;
    assert.equal(browser.querySelector('.bulletin-hero').outerHTML,server.querySelector('.bulletin-hero').outerHTML);
    assert.equal(browser.querySelector('#announcements').outerHTML,server.querySelector('#announcements').outerHTML);
    assert.equal(browser.querySelector('#scripture'),null);
    assert.equal(browser.querySelector('h1 img'),null);
    assert.ok(browser.querySelector('.cta-qr-wrap img').src.startsWith('data:image/svg+xml;base64,'));
    assert.equal(browser.querySelector('.item-image img').getAttribute('src'),data.announcements[0].imageUrl);
    data.announcements[0].ctas[0].showQr=false;
    e.w.applyJsonImport({announcements:[data.announcements[0]]},'announcement-with-link.json');
    const qrToggle=e.w.document.querySelector('.cta-qr-inp');
    assert.ok([...qrToggle.labels].some(label=>label.textContent.includes('Show QR code')));
    assert.equal(e.w.extractForm().announcements[0].ctas[0].showQr,false);
    let resizePreview;
    const previewMedia={matches:true,addEventListener:(_,fn)=>{resizePreview=fn;}};
    browser.defaultView.matchMedia=()=>previewMedia;
    e.w.Bulletin.initializePreview(browser,browser.defaultView);
    assert.ok(browser.querySelector('.bulletin-main #announcements'));
    assert.ok(browser.querySelector('.bulletin-sidebar #service'));
    previewMedia.matches=false;resizePreview();
    assert.equal(browser.querySelector('#announcements').parentElement.className,'bulletin-sections');
    assert.equal(e.w.__mockGithub.writes.length,0);
  }finally{e.close();}
});

test('drafts survive reload, headline imports are partial, and failed publishing preserves recovery',async()=>{
  let e=await editor();
  try{
    e.input('#f-date',futurePublicationDate());
    e.input('#f-headline-title','A saved draft');
    await wait(850);
    const saved=e.saved();assert.ok(Object.keys(saved).some(key=>key.startsWith('bulletin_admin_draft_v1')));
    e.close();e=await editor(saved);
    assert.equal(e.w.document.querySelector('#f-headline-title').value,'A saved draft');
    const reference=e.w.document.querySelector('#f-headline-reference').value;
    const announcementCount=e.w.document.querySelectorAll('#announcements-list .list-item').length;
    e.w.applyJsonImport({headline:{title:'Imported title'}},'header.json');
    assert.equal(e.w.document.querySelector('#f-headline-reference').value,reference);
    assert.equal(e.w.document.querySelectorAll('#announcements-list .list-item').length,announcementCount);
    e.w.__mockGithub.failWrites=true;e.w.document.querySelector('#publish-btn').click();
    await until(()=>e.w.document.querySelector('#status-msg').textContent.includes('Error publishing'));
    assert.equal(e.w.__mockGithub.writes.length,0);
    assert.ok(Object.keys(e.saved()).some(key=>key.startsWith('bulletin_admin_draft_v1')));
    e.w.__mockGithub.failWrites=false;e.w.document.querySelector('#publish-btn').click();
    await until(()=>e.w.__mockGithub.writes.length===1);
    assert.equal(e.w.__mockGithub.data.get('src/_data/bulletin.json').headline.title,'Imported title');
    assert.equal(e.w.__mockGithub.data.get('src/_data/bulletin.json').theme,'Imported title — '+reference);
  }finally{e.close();}
});

test('keyboard reorder, section toggles, imports and archive switching preserve their data',async()=>{
  const e=await editor();
  try{
    const w=e.w;const list=w.document.querySelector('#announcements-list');
    const first=list.firstElementChild;const second=list.children[1];
    first.querySelector('[aria-label="Move down"]').click();assert.equal(list.firstElementChild,second);
    const disabled=w.document.querySelector('#section-order-list [aria-label="Show Announcements"]');
    disabled.checked=false;disabled.dispatchEvent(new w.Event('change',{bubbles:true}));
    assert.equal(w.document.querySelector('#f-announcements-enabled').checked,false);
    assert.equal(new JSDOM(w.Bulletin.render(w.extractForm())).window.document.querySelector('#announcements'),null);
    e.input('#f-headline-title','Current draft');w.flushDraftSave();
    await w.editArchive('src/_data/previous/'+archiveName,archive.date);
    assert.equal(w.document.querySelector('#publish-btn').textContent,'Save Archive');
    assert.equal(w.document.querySelector('#week-actions').hidden,true);
    e.input('#f-headline-title','Archive draft');w.flushDraftSave();
    w.document.querySelector('#exit-archive-btn').click();
    assert.equal(w.document.querySelector('#week-actions').hidden,false);
    assert.equal(w.document.querySelector('#f-headline-title').value,'Current draft');
    await w.editArchive('src/_data/previous/'+archiveName,archive.date);
    assert.equal(w.document.querySelector('#f-headline-title').value,'Archive draft');
    assert.equal(w.__mockGithub.writes.length,0);
  }finally{e.close();}
});

test('a changed published SHA blocks writes while retaining the local draft',async()=>{
  const e=await editor();
  try{
    e.input('#f-date',futurePublicationDate());
    e.input('#f-headline-title','Conflict draft');e.w.flushDraftSave();
    e.w.__mockGithub.revisions.set('src/_data/bulletin.json','changed-by-another-editor');
    e.w.document.querySelector('#publish-btn').click();
    await until(()=>e.w.document.querySelector('#status-msg').textContent.includes('changed on GitHub'));
    assert.equal(e.w.__mockGithub.writes.length,0);
    assert.ok(Object.keys(e.saved()).some(key=>key.startsWith('bulletin_admin_draft_v1')));
  }finally{e.close();}
});

test('empty content, old-format imports, and preview failures do not lose editor data',async()=>{
  const e=await editor();
  try{
    const w=e.w;
    e.input('#f-headline-title','Keep this header');
    w.applyJsonImport({announcements:[]},'older-format.json');
    assert.equal(w.document.querySelector('#f-headline-title').value,'Keep this header');
    assert.equal(w.document.querySelectorAll('#announcements-list .list-item').length,0);
    assert.ok(w.Bulletin.render(w.extractForm()).includes('No announcements this week.'));
    w.renderBulletinPreview();
    const frame=w.document.querySelector('#bulletin-preview-frame');const previous=frame.srcdoc;
    w.Bulletin.render=()=>{throw new Error('Simulated renderer failure');};
    w.console.error=()=>{};
    e.input('#f-headline-title','Saved even if preview fails');w.renderBulletinPreview();w.flushDraftSave();
    assert.equal(frame.srcdoc,previous);
    assert.match(w.document.querySelector('#preview-status').textContent,/last successful preview/);
    assert.ok(Object.values(e.saved()).some(value=>value.includes('Saved even if preview fails')));
    assert.equal(w.__mockGithub.writes.length,0);
  }finally{e.close();}
});

test('starting a new week retains the structured headline and archives the correct bulletin',async()=>{
  const e=await editor({},{...current,date:'2026-09-20'});
  try{
    e.input('#f-headline-title','');e.input('#f-headline-reference','1 Corinthians 12:1-13:13');
    e.w.document.querySelector('#archive-btn').click();
    await until(()=>e.w.__mockGithub.writes.length===2);
    const next=e.w.__mockGithub.data.get('src/_data/bulletin.json');
    assert.equal(next.date,'2026-09-27');
    assert.equal(next.headline.title,'');assert.equal(next.headline.reference,'1 Corinthians 12:1-13:13');
    assert.equal(e.w.__mockGithub.data.get('src/_data/previous/2026-09-20.json').date,'2026-09-20');
    assert.equal(e.w.__mockGithub.writes[0].target,'src/_data/previous/2026-09-20.json');
  }finally{e.close();}
});

test('deployment outcomes distinguish a live site from an email sync failure',async()=>{
  const e=await editor();
  try{
    const w=e.w;const realTimeout=w.setTimeout;
    w.setTimeout=(fn,ms,...args)=>realTimeout(fn,ms===5000?0:ms,...args);
    await w.trackDeploy('test-commit');
    assert.match(w.document.querySelector('#status-msg').textContent,/Site is live and the email draft synced/);
    await w.trackDeploy('test-commit',undefined,{emailSkipped:true});
    assert.match(w.document.querySelector('#status-msg').textContent,/date has passed, so its Mailchimp email was not changed/);
    const previousFetch=w.fetch;
    w.fetch=async(url,options)=>String(url).includes('/actions/runs')?{ok:true,json:async()=>({workflow_runs:[
      {path:'.github/workflows/deploy.yml',status:'completed',conclusion:'success'},
      {path:'.github/workflows/sync-email.yml',name:'Email sync',status:'completed',conclusion:'failure',html_url:'https://github.com/example/run'},
    ]})}:previousFetch(url,options);
    await w.trackDeploy('test-commit');
    assert.match(w.document.querySelector('#status-msg').textContent,/Site is live, but the Mailchimp email sync failed/);
    assert.equal(w.__mockGithub.writes.length,0);
  }finally{e.close();}
});

test('the past-date check uses the church calendar day, not UTC midnight',async()=>{
  const e=await editor();
  try {
    assert.equal(e.w.bulletinDateHasPassed('2026-09-20',new Date('2026-09-21T06:59:59Z')),false);
    assert.equal(e.w.bulletinDateHasPassed('2026-09-20',new Date('2026-09-21T07:00:00Z')),true);
    assert.equal(e.w.bulletinDateHasPassed('2026-09-22',new Date('2026-09-21T07:00:00Z')),false);
    assert.equal(e.w.bulletinDateHasPassed('2026-02-30'),false);
    assert.equal(e.w.bulletinDateHasPassed(''),false);
  } finally {e.close();}
});

test('an older bulletin requires a choice; cancel keeps the draft and explicit publish writes once',async()=>{
  const e=await editor({},{...current,date:'2026-09-20'},'2026-09-24T12:00:00-07:00');
  try {
    const w=e.w,dialog=w.document.querySelector('#past-date-dialog'),publish=w.document.querySelector('#publish-btn');
    e.input('#f-headline-title','Date warning draft');
    publish.click();publish.click();
    assert.equal(dialog.open,true);assert.equal(w.__mockGithub.writes.length,0);
    w.document.querySelector('[data-date-choice="cancel"]').focus();
    w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
    assert.equal(w.document.activeElement.dataset.dateChoice,'archive');
    assert.match(w.document.querySelector('#past-date-description').textContent,/September 20, 2026/);
    w.document.querySelector('[data-date-choice="cancel"]').click();
    await wait(0);
    assert.equal(w.__mockGithub.writes.length,0);
    assert.ok(Object.values(e.saved()).some(value=>value.includes('Date warning draft')));
    publish.click();dialog.close();await wait(0);
    assert.equal(w.__mockGithub.writes.length,0);
    publish.click();w.document.querySelector('[data-date-choice="publish"]').click();
    await until(()=>w.__mockGithub.writes.length===1);
    assert.equal(w.__mockGithub.data.get('src/_data/bulletin.json').date,'2026-09-20');
  } finally {e.close();}
});

test('the warning can archive and start the next week through the existing protected workflow',async()=>{
  const e=await editor({},{...current,date:'2026-09-20'},'2026-09-24T12:00:00-07:00');
  try {
    const w=e.w;
    w.document.querySelector('#publish-btn').click();
    assert.match(w.document.querySelector('#past-date-archive-description').textContent,/September 27, 2026/);
    w.document.querySelector('[data-date-choice="archive"]').click();
    await until(()=>w.__mockGithub.writes.length===2);
    assert.equal(w.__mockGithub.writes[0].target,'src/_data/previous/2026-09-20.json');
    assert.equal(w.__mockGithub.data.get('src/_data/bulletin.json').date,'2026-09-27');
  } finally {e.close();}
});

test('today, future bulletins, and archive edits do not show the past-date warning',async()=>{
  for(const date of ['2026-09-20','2026-09-27']) {
    const e=await editor({},{...current,date},'2026-09-20T12:00:00-07:00');
    try {
      e.w.document.querySelector('#publish-btn').click();
      assert.equal(e.w.document.querySelector('#past-date-dialog').open,false);
      await until(()=>e.w.__mockGithub.writes.length===1);
    } finally {e.close();}
  }
  const e=await editor();
  try {
    await e.w.editArchive('src/_data/previous/'+archiveName,archive.date);
    e.w.document.querySelector('#publish-btn').click();
    assert.equal(e.w.document.querySelector('#past-date-dialog').open,false);
    await until(()=>e.w.__mockGithub.writes.length===1);
    assert.equal(e.w.__mockGithub.writes[0].target,'src/_data/previous/'+archiveName);
  } finally {e.close();}
});

test('QR selections survive draft reload and remain identical in public and browser previews',async()=>{
  const fixture=structuredClone(current);
  fixture.announcements[0].ctas=[{label:'Register',url:'https://example.com/register'},{label:'Details',url:'https://example.com/details',showQr:false}];
  let e=await editor({},fixture);
  try {
    let toggles=[...e.w.document.querySelectorAll('#announcements-list .cta-qr-inp')];
    assert.deepEqual(toggles.map(el=>el.checked),[true,false]);
    toggles[0].checked=false;toggles[0].dispatchEvent(new e.w.Event('change',{bubbles:true}));
    toggles[1].checked=true;toggles[1].dispatchEvent(new e.w.Event('change',{bubbles:true}));
    e.w.flushDraftSave();const saved=e.saved();e.close();e=await editor(saved,fixture);
    toggles=[...e.w.document.querySelectorAll('#announcements-list .cta-qr-inp')];
    assert.deepEqual(toggles.map(el=>el.checked),[false,true]);
    const data=e.w.extractForm();
    const browser=new JSDOM(e.w.Bulletin.render(data)).window.document;
    const server=new JSDOM(env.render('bulletin-body.njk',{bulletin:data})).window.document;
    assert.equal(browser.querySelector('#announcements').outerHTML,server.querySelector('#announcements').outerHTML);
    assert.equal(browser.querySelectorAll('#announcements .cta-qr-wrap').length,1);
    assert.equal(data.announcements[0].ctas[0].showQr,false);
    assert.equal(e.w.__mockGithub.writes.length,0);
  } finally { e.close(); }
});
