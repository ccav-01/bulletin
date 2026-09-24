// Generate a browser-only fixture route; no sample content is written to the website.
const fs = require('node:fs');
const path = require('node:path');
const nunjucks = require('nunjucks');
const {filters} = require('../lib/bulletin');
const root = path.resolve(__dirname, '..');
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(root,'src/_includes')), {autoescape:true});
Object.entries(filters).forEach(([name,fn])=>env.addFilter(name,fn));
const data = structuredClone(require('../src/_data/bulletin.json'));
const portrait = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="600" height="1000" fill="#e9dcc4"/><text x="300" y="70" text-anchor="middle" font-size="36">FLYER TOP — KEEP VISIBLE</text><text x="300" y="490" text-anchor="middle" font-size="40">Portrait image test</text><text x="300" y="960" text-anchor="middle" font-size="30">BOTTOM — KEEP VISIBLE</text></svg>';
const register = {label:'Register',url:'https://example.com/register',showQr:true};
const details = {label:'Details',url:'https://example.com/details',showQr:false};
data.announcements = [
  {title:'2026 Women’s Conference',body:'Be Strong · Proverbs 31:25. Join us June 27, 9:30 AM–3:30 PM. $35 per person, lunch included.',imageUrl:'/assets/images/uploads/ann-conference-cover-1776967026839.jpg',ctas:[register,details]},
  {title:'Men’s Bible Study',body:'Join us Tuesday, September 29 at 6:30 PM for worship, the Word, food, and fellowship.',ctas:[]},
  {title:'Women’s Spring Luncheon',body:'Beloved Bride · Revelation 19:7–8. Saturday, May 2 at noon. $20 per person.',ctas:[details]},
  {title:'Portrait flyer — no actions',body:'Both ends of this portrait flyer must remain visible.',imageUrl:'data:image/svg+xml;base64,'+Buffer.from(portrait).toString('base64'),ctas:[]},
  {title:'Unavailable image',body:'This announcement and its link remain usable when an image cannot load.',imageUrl:'/__review/missing-image.png',ctas:[details]},
  {title:'A long announcement title that needs to wrap without disrupting its neighbouring content',body:'Long text should wrap naturally. '+ 'Readable announcement content. '.repeat(12),ctas:[{...register,label:'Register for this upcoming community event with a longer button label'},details]},
];
data.savetheDates=[{title:'An upcoming event',date:'2026-10-17',time:'5 PM',description:'Event details and an optional link.',ctas:[details]}];
const html=env.renderString('{% extends "base.njk" %}{% block content %}{% include "bulletin-body.njk" %}{% endblock %}',{bulletin:data,title:'Design review — sample content'});
const code = `async page => {
  const results=[];
  await page.route('**/__review/variants/', route=>route.fulfill({contentType:'text/html',body:${JSON.stringify(html)}}));
  const checks=[
    ['desktop-current','/',1440,1100],['mobile-current','/',390,844],['tablet-current','/',820,1180],
    ['archive-desktop','/previous/',1440,1000],['archive-mobile','/previous/',390,844],
    ['past-issue','/previous/2026-09-13/',1440,1100],
    ['variants-desktop','/__review/variants/',1440,1100],['variants-mobile','/__review/variants/',390,844],
    ['small-mobile','/__review/variants/',320,800],['zoom-reflow','/',720,550]
  ];
  for(const [name,url,width,height] of checks) {
    await page.setViewportSize({width,height});
    await page.goto('http://127.0.0.1:4173'+url);
    await page.evaluate(async()=>{await document.fonts.ready; await Promise.all([...document.images].map(img=>{img.loading='eager';return img.decode().catch(()=>{});}));});
    const state=await page.evaluate(()=>({
      width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      sectionOrder:[...document.querySelectorAll('.bulletin-sections section[id]')].map(x=>x.id),
      fonts:[...document.fonts].filter(f=>f.family.includes('Source')||f.family.includes('Bulletin')).map(f=>({family:f.family,status:f.status})),
      images:[...document.querySelectorAll('.item-image img')].map(img=>({natural:[img.naturalWidth,img.naturalHeight],rendered:[img.width,img.height],hidden:img.closest('.item-image').classList.contains('is-unavailable')})),
      visibleQr:[...document.querySelectorAll('.cta-qr-wrap')].filter(el=>getComputedStyle(el).display!=='none').length
    }));
    if(state.scrollWidth>state.width) throw new Error(name+' has horizontal overflow: '+JSON.stringify(state));
    if(width<=768&&state.visibleQr) throw new Error('QR visible on mobile');
    for(const img of state.images) if(img.natural[0]&&!img.hidden && Math.abs(img.natural[0]/img.natural[1]-img.rendered[0]/img.rendered[1])>.02) throw new Error('Image distorted: '+name);
    results.push({name,...state});
    await page.screenshot({path:'output/playwright/'+name+'.png',fullPage:true});
    if(name==='mobile-current'||name==='variants-mobile') await page.screenshot({path:'output/playwright/'+name+'-top.png'});
    if(name==='variants-desktop') await page.locator('.cta-qr-wrap img').first().screenshot({path:'output/playwright/registration-qr.png'});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  const reduced=await page.evaluate(()=>getComputedStyle(document.documentElement).scrollBehavior);
  if(reduced!=='auto') throw new Error('Reduced motion not respected');
  await page.keyboard.press('Tab');
  const focused=await page.evaluate(()=>({text:document.activeElement.textContent,outline:getComputedStyle(document.activeElement).outlineStyle}));
  return {results,reduced,focused};
}`;
fs.mkdirSync(path.join(root,'output/playwright'),{recursive:true});
fs.writeFileSync(path.join(root,'output/playwright/browser-review.js'),code);
console.log('Prepared output/playwright/browser-review.js for playwright-cli run-code --filename.');
