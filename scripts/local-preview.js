// Local-only review server. /__test/admin/ uses an in-memory GitHub stand-in.
// Nothing in this server is copied into the deployed site.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const site = path.join(root, '_site');
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf','.json':'application/json'};
function fixtureScript() {
  const current = JSON.parse(fs.readFileSync(path.join(root,'src/_data/bulletin.json'),'utf8'));
  const archiveName = fs.readdirSync(path.join(root,'src/_data/previous')).sort().at(-1);
  const archive = JSON.parse(fs.readFileSync(path.join(root,'src/_data/previous',archiveName),'utf8'));
  return `window.__fixtures=${JSON.stringify({current,archive,archiveName}).replace(/</g,'\\u003c')};\n` + fs.readFileSync(path.join(root,'tests/mock-github.js'),'utf8');
}
function createServer() {
  return http.createServer((req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname==='/__test/mock-github.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(fixtureScript());return;}
    if(pathname==='/__test/admin/'){
      let html=fs.readFileSync(path.join(site,'admin/index.html'),'utf8');
      html=html.replace('<head>','<head><script src="/__test/mock-github.js"></script>');
      res.writeHead(200,{'Content-Type':'text/html'});res.end(html);return;
    }
    const file=path.resolve(site,'.'+pathname+(pathname.endsWith('/')?'index.html':''));
    if(!file.startsWith(site+path.sep)){res.writeHead(403);res.end();return;}
    try {const content=fs.readFileSync(file);res.writeHead(200,{'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream'});res.end(content);}
    catch{res.writeHead(404);res.end('Not found');}
  });
}
module.exports={createServer};
if(require.main===module)createServer().listen(4173,'127.0.0.1',()=>console.log('Local review: http://127.0.0.1:4173/__test/admin/ (mocked publishing only)'));
