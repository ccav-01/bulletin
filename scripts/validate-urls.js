#!/usr/bin/env node
// Fails with exit code 1 if any URL field in bulletin JSON contains a non-https link.
// Mirrors the validateUrls logic in src/admin/index.html.
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const dataDir = path.join(__dirname, '..', 'src', '_data');
const previousDir = path.join(dataDir, 'previous');

function collectFields(data, source) {
  return [
    [`${source} › Giving URL`,     data.giving?.url],
    [`${source} › Livestream URL`,  data.service?.livestream],
    [`${source} › Website`,         data.contact?.website],
    [`${source} › Facebook URL`,    data.contact?.facebook],
    [`${source} › Instagram URL`,   data.contact?.instagram],
    [`${source} › YouTube URL`,     data.contact?.youtube],
    ...(data.announcements || []).flatMap((a, i) =>
      (a.ctas || []).map((c, j) => [`${source} › Announcement ${i + 1} link ${j + 1}`, c.url])),
    ...(data.savetheDates || []).flatMap((s, i) =>
      (s.ctas || []).map((c, j) => [`${source} › Save the Date ${i + 1} link ${j + 1}`, c.url])),
    ...(data.thisWeek || []).flatMap((t, i) =>
      (t.ctas || []).map((c, j) => [`${source} › This Week ${i + 1} link ${j + 1}`, c.url])),
  ];
}

function validateFields(fields) {
  const errors = [];
  for (const [label, url] of fields) {
    if (!url) continue;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') {
        errors.push(`  ${label}: only https:// allowed (got "${u.protocol}")`);
      }
    } catch {
      errors.push(`  ${label}: not a valid URL ("${url}")`);
    }
  }
  return errors;
}

const files = [path.join(dataDir, 'bulletin.json')];
if (fs.existsSync(previousDir)) {
  for (const f of fs.readdirSync(previousDir)) {
    if (f.endsWith('.json')) files.push(path.join(previousDir, f));
  }
}

let allErrors = [];
for (const file of files) {
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    allErrors.push(`  ${rel}: failed to parse JSON — ${e.message}`);
    continue;
  }
  allErrors = allErrors.concat(validateFields(collectFields(data, rel)));
}

if (allErrors.length) {
  console.error('URL validation failed:\n' + allErrors.join('\n'));
  process.exit(1);
}

console.log(`URL validation passed (${files.length} file(s) checked).`);
