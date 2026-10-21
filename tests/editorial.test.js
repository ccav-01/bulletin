const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const nunjucks = require('nunjucks');
const { filters } = require('../lib/bulletin');
const current = require('../src/_data/bulletin.json');
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(__dirname, '../src/_includes')), { autoescape: true });
Object.entries(filters).forEach(([name, fn]) => env.addFilter(name, fn));
const render = data => new JSDOM(env.render('bulletin-body.njk', { bulletin: data })).window.document;

test('empty or disabled messages have no section or navigation link; partial messages are usable', () => {
  for (const scripture of [{}, {verse:'  ', reference:'\n', sermonSeries:' '}]) {
    const doc = render({...current, scriptureEnabled:true, scripture});
    assert.equal(doc.querySelector('#scripture'), null);
    assert.equal(doc.querySelector('[href="#scripture"]'), null);
  }
  for (const scripture of [{sermonSeries:'Poor in Spirit'}, {reference:'Matthew 5'}, {imageUrl:'/assets/ccav-badge-black.png'}]) {
    const doc = render({...current, scriptureEnabled:true, scripture});
    assert.ok(doc.querySelector('#scripture'));
    assert.equal(doc.querySelector('.scripture-verse'), null);
    assert.equal(Boolean(doc.querySelector('.scripture-block')), Boolean(scripture.reference));
  }
  assert.equal(render({...current, scriptureEnabled:false}).querySelector('#scripture'), null);
});

test('announcement optional images and independently optional QR codes leave no placeholder markup', () => {
  const actions = [{label:'Register',url:'https://example.com/register'}, {label:'Details',url:'https://example.com/details',showQr:false}, {label:'Volunteer',url:'https://example.com/volunteer',showQr:true}];
  const doc = render({...current, announcements:[
    {title:'Text only',body:'Full text',ctas:[]},
    {title:'Image only',body:'Keep the whole flyer',imageUrl:'/assets/ccav-badge-black.png',ctas:[]},
    {title:'Multiple actions',body:'Details',ctas:actions},
    {title:'Image and link',body:'Details',imageUrl:'/assets/ccav-badge-black.png',ctas:[actions[1]]},
  ]});
  const rows = [...doc.querySelectorAll('.announcement-item')];
  assert.equal(rows.length, 4);
  assert.equal(rows[0].querySelector('.item-image, .item-ctas'), null);
  assert.equal(rows[1].querySelector('.item-ctas'), null);
  assert.equal(rows[2].querySelectorAll('a').length, 3);
  assert.equal(rows[2].querySelectorAll('.cta-qr-wrap').length, 2);
  assert.equal(rows[3].querySelector('.cta-qr-wrap'), null);
  for (const group of rows[2].querySelectorAll('.cta-group')) {
    const qr = group.querySelector('img');
    if (qr) assert.equal(qr.src, filters.qrDataUri(group.querySelector('a').getAttribute('href')));
  }
});

test('responsive columns preserve configured order, unique sections and keyboard focus', () => {
  const order = ['scripture','announcements','thisWeek','service','savetheDates'];
  const data = {...current, scriptureEnabled:true, sectionOrder:order, savetheDates:[{title:'Event',date:'2026-10-17',ctas:[]}]};
  const dom = new JSDOM(env.render('bulletin-body.njk',{bulletin:data}), {url:'https://example.com/',runScripts:'outside-only'});
  const {window:w} = dom;
  let listener;
  const media = {matches:true,addEventListener:(_,fn)=>{listener=fn;}};
  w.matchMedia=()=>media;
  w.eval(fs.readFileSync(path.join(__dirname,'../src/assets/js/bulletin.js'),'utf8'));
  const ids = selector => [...w.document.querySelector(selector).children].map(el=>el.id);
  assert.deepEqual(ids('.bulletin-main'), ['announcements','savedates']);
  assert.deepEqual(ids('.bulletin-sidebar'), ['scripture','thisweek','service']);
  const link=w.document.querySelector('.service-livestream a');link.focus();
  media.matches=false;listener();
  assert.deepEqual(ids('.bulletin-sections').filter(Boolean), ['scripture','announcements','thisweek','service','savedates']);
  assert.equal(w.document.activeElement,link);
  media.matches=true;listener();
  assert.equal(w.document.querySelectorAll('#service').length,1);
  assert.deepEqual(ids('.bulletin-sidebar'), ['scripture','thisweek','service']);
  dom.window.close();
});

test('saved-date and schedule CTAs honor explicit QR opt-out while preserving their links', () => {
  const ctas=[{label:'Details',url:'https://example.com/details',showQr:false}];
  const doc=render({...current,savetheDates:[{title:'Event',date:'2026-10-17',ctas}],thisWeek:[{title:'Study',day:'Sunday',time:'10 AM',ctas}]});
  for(const id of ['savedates','thisweek']) {
    assert.equal(doc.querySelectorAll(`#${id} .cta-group a`).length,1);
    assert.equal(doc.querySelector(`#${id} .cta-qr-wrap`),null);
  }
});

test('editorial text and action color pairs meet AA text contrast', () => {
  const luminance = hex => {
    const channels=hex.match(/[a-f0-9]{2}/gi).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
    return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
  };
  const pairs=[['454139','fcfaf5'],['655f54','fcfaf5'],['805010','fcfaf5'],['181714','d49a32'],['f9f5eb','141413'],['d5ccbb','302d25'],['665e51','fffdf9'],['bdb4a3','141413'],['3b362e','f5f0e6']];
  for(const [fg,bg] of pairs) {
    const a=luminance(fg),b=luminance(bg);
    assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${fg} on ${bg}`);
  }
});
