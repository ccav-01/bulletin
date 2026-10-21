const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const nunjucks = require('nunjucks');
const { filters } = require('../lib/bulletin');
const current = require('../src/_data/bulletin.json');
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(__dirname, '../src/_includes')), { autoescape: true });
Object.entries(filters).forEach(([name, fn]) => env.addFilter(name, fn));
const render = data => new JSDOM(env.render('email-body.njk', { bulletin: data })).window.document;
const sectionLabels = doc => [...doc.querySelectorAll('p')].map(p => p.textContent.trim())
  .filter(t => ['Announcements', 'Save the Date', 'This Week', 'This Week’s Message'].includes(t) || / Service$/.test(t));

test('email follows the website section toggles and order', () => {
  const data = {
    ...current, scriptureEnabled: true, scripture: { sermonSeries: 'Poor in Spirit' },
    sectionOrder: ['thisWeek', 'scripture', 'announcements', 'service', 'savetheDates'],
    savetheDates: [{ title: 'Event', date: '2026-11-01', ctas: [] }],
    thisWeek: [{ day: 'Tuesday', time: '6:30 PM', title: 'Bible Study' }],
    service: { times: [{ day: 'Sunday', time: '10:30 AM' }] },
  };
  assert.deepEqual(sectionLabels(render(data)), ['This Week', 'This Week’s Message', 'Announcements', 'Sunday Service', 'Save the Date']);
  const hidden = render({ ...data, scriptureEnabled: false, announcementsEnabled: false, thisWeekEnabled: false, savetheDatesEnabled: false });
  assert.deepEqual(sectionLabels(hidden), ['Sunday Service']);
  // An enabled message with nothing in it doesn't leave an empty block
  assert.deepEqual(sectionLabels(render({ ...data, scripture: { verse: ' ', reference: '' } })), ['This Week', 'Announcements', 'Sunday Service', 'Save the Date']);
});

test('email keeps headline, line breaks, images and This Week details the website shows', () => {
  const doc = render({
    ...current, headline: { title: 'Guest Speaker: Rob Salvato', reference: '' },
    announcements: [
      { title: 'Flyer', body: 'Line one\nLine two <b>', imageUrl: '/assets/flyer.jpg', ctas: [] },
      { title: 'Hosted', body: 'x', imageUrl: 'https://cdn.example.com/a.png', ctas: [] },
      { title: 'Unsafe', body: 'x', imageUrl: 'javascript:alert(1)', ctas: [] },
    ],
    thisWeek: [{ day: 'Tuesday', title: 'Study', description: 'Bring a Bible', ctas: [{ label: 'Sign up', url: 'https://example.com/s' }] }],
    thisWeekEnabled: true,
    giving: { url: '', text: 'Give' },
  });
  assert.match(doc.querySelector('td[bgcolor="#0B0B0C"]').textContent, /Guest Speaker: Rob Salvato/);
  const body = [...doc.querySelectorAll('h3')].find(h => h.textContent === 'Flyer').nextElementSibling;
  assert.equal(body.innerHTML, 'Line one<br>\nLine two &lt;b&gt;');
  assert.deepEqual([...doc.querySelectorAll('img')].map(img => img.getAttribute('src')),
    ['https://bulletin.calvarychapelav.org/assets/flyer.jpg', 'https://cdn.example.com/a.png']);
  assert.match(doc.body.textContent, /Bring a Bible/);
  assert.ok(doc.querySelector('a[href="https://example.com/s"]'));
  // No giving link means no "Give Online" button pointing nowhere
  assert.doesNotMatch(doc.body.textContent, /Support Our Ministry/);
});
