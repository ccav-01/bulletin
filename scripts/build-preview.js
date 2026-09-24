const fs = require('fs');
const path = require('path');
const nunjucks = require('nunjucks');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');

async function buildPreview() {
  const output = path.join(root, '_site/admin');
  fs.mkdirSync(output, {recursive:true});
  let compiled = '';
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), name + '/');
      else if (entry.name.endsWith('.njk')) compiled += nunjucks.precompileString(fs.readFileSync(path.join(dir, entry.name), 'utf8'), {name});
    }
  }
  walk(path.join(root, 'src/_includes'));
  compiled += nunjucks.precompileString('{% extends "base.njk" %}{% block content %}{% include "bulletin-body.njk" %}{% endblock %}', {name:'preview-page.njk'});
  fs.writeFileSync(path.join(output, 'preview-templates.js'), compiled);
  await esbuild.build({entryPoints:[path.join(root,'src/admin/preview-renderer.js')], bundle:true, platform:'browser', minify:true, outfile:path.join(output,'preview-renderer.bundle.js')});
  const previousList = require('../src/_data/previousList')().slice(0,6);
  fs.writeFileSync(path.join(output,'preview-context.js'), 'window.bulletinPreviewContext=' + JSON.stringify({previousList}).replace(/</g,'\\u003c') + ';');
}
module.exports = buildPreview;
if (require.main === module) buildPreview().catch(e => {console.error(e);process.exitCode=1;});
