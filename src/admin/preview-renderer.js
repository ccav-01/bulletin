const nunjucks = require('nunjucks/browser/nunjucks-slim');
const shared = require('../../lib/bulletin');
const env = new nunjucks.Environment(new nunjucks.PrecompiledLoader(window.nunjucksPrecompiled), {autoescape:true});
Object.entries(shared.filters).forEach(([name, filter]) => env.addFilter(name,filter));
window.Bulletin = {
  ...shared,
  initializePreview: require('../assets/js/bulletin'),
  render(data, isArchive = false) {
    return env.render('preview-page.njk', {
      bulletin:data, isArchive,
      archivedBulletin:isArchive ? data : null,
      title:'Unpublished bulletin preview',
      previousList:window.bulletinPreviewContext?.previousList || [],
    });
  },
};
