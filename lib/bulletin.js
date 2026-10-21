// Shared by Eleventy and the unpublished browser preview.
const QRCode = require('qrcode/lib/core/qrcode');

const books = ['Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth','Samuel','Kings','Chronicles','Ezra','Nehemiah','Esther','Job','Psalms?','Proverbs','Ecclesiastes','Song of Solomon','Song of Songs','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi','Matthew','Mark','Luke','John','Acts','Romans','Corinthians','Galatians','Ephesians','Philippians','Colossians','Thessalonians','Timothy','Titus','Philemon','Hebrews','James','Peter','Jude','Revelation','Matt\\.?','Jn\\.?','Rom\\.?','Cor\\.?','Pet\\.?','Ps\\.?'];
const trailingReference = new RegExp('(?:^|\\s)((?:[1-3]\\s+)?(?:' + books.join('|') + ')\\s+\\d+(?::\\d+)?(?:\\s*[-–—]\\s*\\d+(?::\\d+)?)?(?:\\s*,\\s*\\d+(?:\\s*[-–—]\\s*\\d+)?)*)\\s*$', 'i');
const text = value => typeof value === 'string' ? value.trim() : '';

function headline(data = {}) {
  if (data.headline && typeof data.headline === 'object') {
    return { title: text(data.headline.title), reference: text(data.headline.reference) };
  }
  const theme = text(data.theme);
  const match = theme.match(trailingReference);
  if (!match) return { title: theme, reference: '' };
  return { title: theme.slice(0, match.index).replace(/\s*[-–—|]\s*$/, '').trim(), reference: match[1] };
}

function headlineTheme(data) {
  const h = headline(data);
  return [h.title, h.reference].filter(Boolean).join(' — ');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function referenceHtml(value) {
  // Protect numeric ranges, while allowing long book names/multiple readings to wrap.
  return escapeHtml(value).replace(/\d+(?::\d+)?(?:\s*[-–—]\s*\d+(?::\d+)?)+|\d+:\d+/g,
    range => `<span class="reference-range">${range}</span>`);
}

function groupThisWeek(items) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  function time(value = '') {
    const m = value.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i);
    return m ? (Number(m[1]) % 12 + (/pm/i.test(m[3]) ? 12 : 0)) * 60 + Number(m[2] || 0) : 0;
  }
  const groups = [];
  [...(items || [])].sort((a,b) => days.indexOf(a.day) - days.indexOf(b.day) || time(a.time) - time(b.time)).forEach(item => {
    if (groups.at(-1)?.day !== item.day) groups.push({day:item.day, items:[]});
    groups.at(-1).items.push(item);
  });
  return groups;
}

function qrDataUri(url) {
  if (!url || !/^https:\/\//i.test(url)) return '';
  const matrix = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
  const dim = (matrix.size + 8) * 4;
  let rects = '';
  for (let r=0;r<matrix.size;r++) for(let c=0;c<matrix.size;c++) {
    if(matrix.get(r,c)) rects += `<rect x="${(c+4)*4}" y="${(r+4)*4}" width="4" height="4"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="160" height="160"><rect width="${dim}" height="${dim}" fill="#F7F3EC"/><g fill="#0B0B0C">${rects}</g></svg>`;
  return 'data:image/svg+xml;base64,' + (typeof btoa === 'function' ? btoa(svg) : Buffer.from(svg).toString('base64'));
}

// Email clients have no base URL, so site-relative images need the full origin.
const SITE_ORIGIN = 'https://bulletin.calvarychapelav.org';
function absoluteUrl(value) {
  const url = text(value);
  if (/^https?:\/\//i.test(url)) return url;
  return url.startsWith('/') && !url.startsWith('//') ? SITE_ORIGIN + url : '';
}

const date = value => new Date(value + 'T12:00:00');
function visibleSections(data = {}) {
  const order = data.sectionOrder || ['service', 'scripture', 'announcements', 'savetheDates', 'thisWeek'];
  const hasMessage = ['verse', 'reference', 'sermonTitle', 'sermonSeries', 'imageUrl']
    .some(key => text(data.scripture?.[key]));
  const visible = {
    service: true,
    scripture: data.scriptureEnabled !== false && hasMessage,
    announcements: data.announcementsEnabled !== false,
    savetheDates: data.savetheDatesEnabled !== false && data.savetheDates?.length > 0,
    thisWeek: data.thisWeekEnabled !== false && data.thisWeek?.length > 0,
  };
  return [...new Set(order)].filter(key => visible[key]);
}
const filters = {
  headline, headlineTheme, referenceHtml, groupThisWeek, qrDataUri, visibleSections, absoluteUrl,
  readableDate: value => date(value).toLocaleDateString('en-US', {weekday:'long',year:'numeric',month:'long',day:'numeric'}),
  isoDate: value => date(value).toISOString().split('T')[0],
  shortMonth: value => date(value).toLocaleDateString('en-US',{month:'short'}).toUpperCase(),
  dayNumber: value => date(value).getDate(),
  urlencode: encodeURIComponent,
};
module.exports = { filters, headline, headlineTheme, referenceHtml, escapeHtml };
