
// ============================================================
// Constants
// ============================================================
const GITHUB_REPO    = 'ccav-01/bulletin';
const GITHUB_BRANCH  = 'main';
const BULLETIN_PATH  = 'src/_data/bulletin.json';
const PREVIOUS_PATH  = 'src/_data/previous';
const SESSION_KEY    = 'bulletin_admin_token';
const DRAFT_KEY_PREFIX = 'bulletin_admin_draft_v1';
const TAB_DRAFT_KEY_PREFIX = 'bulletin_admin_tab_draft_v1';
const DRAFT_SAVE_DELAY = 700;
const LOCAL_STORAGE_AREA = (() => { try { return window.localStorage; } catch (_) { return null; } })();
const SESSION_STORAGE_AREA = (() => { try { return window.sessionStorage; } catch (_) { return null; } })();

function safeStorageGet(storage, key) {
  if (!storage) return null;
  try { return storage.getItem(key); } catch (_) { return null; }
}
function safeStorageSet(storage, key, value) {
  if (!storage) return false;
  try { storage.setItem(key, value); return true; } catch (_) { return false; }
}
function safeStorageRemove(storage, key) {
  if (!storage) return false;
  try { storage.removeItem(key); return true; } catch (_) { return false; }
}

// ============================================================
// State
// ============================================================
let state = {};
let githubToken = '';
let githubLogin = '';
let editingArchivePath = null;
let editorBaseData = {};
let scriptureImgWidget = null;
let draftAutosaveReady = false;
let draftHydrating = false;
let draftSaveTimer = null;
let pendingDraftTarget = null;
let pendingImageUploads = 0;
let persistenceOperationActive = false;
let draftSaveBlocked = false;
const publishedDataByPath = new Map();
const publishedShaByPath = new Map();
const draftRawByPath = new Map();
const draftWriterId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

// ============================================================
// GitHub API
// ============================================================
function ghHeaders() {
  return {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
async function ghFetch(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/${path}`, {
    ...opts,
    headers: { ...ghHeaders(), ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const error = new Error(e.message || `GitHub API ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}
async function getFileSha(p) {
  try {
    return (await ghFetch(`contents/${p}?ref=${GITHUB_BRANCH}`)).sha;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
async function putFile(p, content, message, expectedSha = undefined) {
  const sha = await getFileSha(p);
  if (expectedSha !== undefined && sha !== expectedSha) {
    const error = new Error('This file changed on GitHub after you opened it. Your browser draft is safe — reload to review the newer published version before trying again.');
    error.code = 'CONTENT_CONFLICT';
    throw error;
  }
  const body = { message, content: btoa(unescape(encodeURIComponent(content))), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  return ghFetch(`contents/${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function loadBulletin() {
  const file = await ghFetch(`contents/${BULLETIN_PATH}?ref=${GITHUB_BRANCH}`);
  return {
    data: JSON.parse(decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))))),
    sha: file.sha,
  };
}

// ============================================================
// Deploy status tracking
// ============================================================
const DEPLOY_WORKFLOW = '.github/workflows/deploy.yml';
const EMAIL_WORKFLOW  = '.github/workflows/sync-email.yml';
let deployPollGeneration = 0;

// Polls the Actions runs for the given commit and walks the status bar
// through committed → queued → building → live/failed. Fire-and-forget.
async function trackDeploy(sha, initialMsg = 'Committed — waiting for GitHub to start building…') {
  const gen = ++deployPollGeneration;
  const deadline = Date.now() + 6 * 60 * 1000;
  setStatus(initialMsg, 'info', '⏳');
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    if (gen !== deployPollGeneration) return; // superseded by a newer publish
    let runs;
    try {
      runs = (await ghFetch(`actions/runs?head_sha=${sha}&per_page=10`)).workflow_runs || [];
    } catch (err) {
      // Most likely a fine-grained token without Actions: Read — fall back to the static message
      setStatus('Changes saved. Deployment status is unavailable; check the live site shortly.', 'info', 'ℹ️');
      return;
    }
    if (gen !== deployPollGeneration) return;
    const deploy = runs.find(r => r.path === DEPLOY_WORKFLOW);
    const email  = runs.find(r => r.path === EMAIL_WORKFLOW);
    if (!deploy || deploy.status !== 'completed') {
      if (!deploy || deploy.status === 'queued' || deploy.status === 'waiting' || deploy.status === 'pending') {
        setStatus('Build queued on GitHub…', 'info', '⏳');
      } else {
        setStatus('Building & deploying the site…', 'info', '🔄');
      }
      continue;
    }
    if (deploy.conclusion === 'cancelled' || deploy.conclusion === 'skipped') {
      setStatus('This publish was superseded by a newer one.', 'info', 'ℹ️');
      return;
    }
    if (deploy.conclusion !== 'success') {
      setStatus(`Site deploy failed (${deploy.name}).`, 'error', '❌', { url: deploy.html_url, text: 'View the failed run' });
      return;
    }
    // Site is live — report the email sync separately
    if (!email || email.status !== 'completed') {
      setStatus('Site is live! Finishing the Mailchimp email sync…', 'info', '📧');
      continue;
    }
    if (email.conclusion === 'success') {
      setStatus('Site is live and the email draft synced to Mailchimp.', 'success', '✅');
    } else if (email.conclusion === 'cancelled' || email.conclusion === 'skipped') {
      setStatus('Site is live. (Email sync was superseded by a newer publish.)', 'success', '✅');
    } else {
      setStatus(`Site is live, but the Mailchimp email sync failed (${email.name}).`, 'error', '❌', { url: email.html_url, text: 'View the failed run' });
    }
    return;
  }
  if (gen === deployPollGeneration) {
    setStatus('Still building — check the repo’s Actions tab if this persists.', 'info', '⏳');
  }
}

// ============================================================
// URL validation
// ============================================================
function validateUrls(data) {
  const errors = [];
  const httpsFields = [
    ['Giving URL',      data.giving?.url],
    ['Livestream URL',  data.service?.livestream],
    ['Website',         data.contact?.website],
    ['Facebook URL',    data.contact?.facebook],
    ['Instagram URL',   data.contact?.instagram],
    ['YouTube URL',     data.contact?.youtube],
    ...(data.announcements || []).flatMap((a, i) =>
      (a.ctas || []).map((c, j) => [`Announcement ${i + 1} link ${j + 1}`, c.url])),
    ...(data.savetheDates || []).flatMap((s, i) =>
      (s.ctas || []).map((c, j) => [`Save the Date ${i + 1} link ${j + 1}`, c.url])),
    ...(data.thisWeek || []).flatMap((t, i) =>
      (t.ctas || []).map((c, j) => [`This Week ${i + 1} link ${j + 1}`, c.url])),
  ];
  for (const [label, url] of httpsFields) {
    if (!url) continue;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') errors.push(`${label}: only https:// links are allowed (got "${u.protocol}")`);
    } catch {
      errors.push(`${label}: not a valid URL`);
    }
  }
  return errors;
}

// ============================================================
// Auth
// ============================================================
const authScreen  = document.getElementById('auth-screen');
const adminShell  = document.getElementById('admin-shell');

// Restore token — localStorage for "remember me", sessionStorage for tab-only
const storedLocalToken = safeStorageGet(LOCAL_STORAGE_AREA, SESSION_KEY);
const storedSessionToken = safeStorageGet(SESSION_STORAGE_AREA, SESSION_KEY);
const stored = storedLocalToken || storedSessionToken;
const storedTokenWasRemembered = Boolean(storedLocalToken);
if (stored) githubToken = stored;

function persistAuthToken(token, remember) {
  if (remember) {
    safeStorageRemove(SESSION_STORAGE_AREA, SESSION_KEY);
    if (safeStorageSet(LOCAL_STORAGE_AREA, SESSION_KEY, token)) return true;
    return safeStorageSet(SESSION_STORAGE_AREA, SESSION_KEY, token);
  }
  safeStorageRemove(LOCAL_STORAGE_AREA, SESSION_KEY);
  return safeStorageSet(SESSION_STORAGE_AREA, SESSION_KEY, token);
}

function clearStoredAuthToken() {
  safeStorageRemove(LOCAL_STORAGE_AREA, SESSION_KEY);
  safeStorageRemove(SESSION_STORAGE_AREA, SESSION_KEY);
}

async function handleSignIn(e) {
  e.preventDefault();
  const token    = document.getElementById('pat-input').value.trim();
  const remember = document.getElementById('remember-me').checked;
  if (!token) { showAuthError('Please enter your GitHub token.'); return; }

  const btn = document.getElementById('auth-btn');
  btn.textContent = 'Verifying…'; btn.disabled = true;
  document.getElementById('auth-error').style.display = 'none';

  try {
    // Verify token is valid and get user identity
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!userRes.ok) {
      const error = new Error('Invalid token — please check and try again.');
      error.status = userRes.status;
      throw error;
    }
    const user = await userRes.json();

    // Set token so ghFetch works, then load bulletin (verifies repo read access)
    githubToken = token;
    githubLogin = user.login;
    const loaded = await loadBulletin();
    state = loaded.data;
    editingArchivePath = null;

    const tokenStored = persistAuthToken(token, remember);
    activateEditorTarget(BULLETIN_PATH, state, loaded.sha);
    draftAutosaveReady = true;
    authScreen.style.display = 'none';
    adminShell.style.display = 'flex';
    document.getElementById('header-user').textContent = user.login;
    updateArchiveEditMode();
    navigateTo('overview');
    if (!tokenStored) {
      setStatus('Signed in, but this browser blocked session storage. You will need to sign in again after a refresh.', 'info', '⚠️');
    }
  } catch (err) {
    draftAutosaveReady = false;
    githubToken = '';
    githubLogin = '';
    if (err.status === 401) clearStoredAuthToken();
    showAuthError(err.message);
  } finally {
    btn.textContent = 'Sign In & Load Bulletin'; btn.disabled = false;
  }
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.style.display = 'block';
}

document.getElementById('auth-form').addEventListener('submit', handleSignIn);

document.getElementById('signout-btn').addEventListener('click', () => {
  if (!canStartPersistenceOperation()) return;
  if (!draftSavedBefore('sign out')) return;
  draftAutosaveReady = false;
  clearStoredAuthToken();
  githubToken = '';
  githubLogin = '';
  editingArchivePath = null;
  draftSaveBlocked = false;
  editorBaseData = {};
  publishedDataByPath.clear();
  publishedShaByPath.clear();
  draftRawByPath.clear();
  document.getElementById('pat-input').value = '';
  adminShell.style.display = 'none';
  authScreen.style.display = 'flex';
  setDraftStatus('No draft loaded');
  clearTimeout(statusHideTimer);
  document.getElementById('status-bar').className = '';
  document.getElementById('status-msg').textContent = '';
  updateArchiveEditMode();
  navigateTo('overview');
});

// Auto sign-in if we have a stored token
if (githubToken) {
  document.getElementById('pat-input').value = githubToken;
  document.getElementById('remember-me').checked = storedTokenWasRemembered;
  document.getElementById('auth-form').dispatchEvent(new Event('submit'));
}

// ============================================================
// Navigation
// ============================================================
function navigateTo(sectionId) {
  document.querySelectorAll('[data-section]').forEach(l => l.classList.remove('active'));
  const link = document.querySelector(`[data-section="${sectionId}"]`);
  if (link) link.classList.add('active');
  document.querySelectorAll('.editor-section').forEach(s => s.classList.remove('active'));
  document.getElementById('section-' + sectionId).classList.add('active');
  document.querySelectorAll('[data-section]').forEach(el => { if(el === link) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); });
  closeNavigation();
  setWorkspaceView('edit');
  window.scrollTo(0,0);
  jumpPreviewTo(sectionId);
}

document.querySelectorAll('[data-section]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    navigateTo(link.dataset.section);
    if (link.dataset.section === 'archives') loadArchiveList();
  });
});

// ============================================================
// Status bar
// ============================================================
let statusHideTimer = null;
function setStatus(msg, type = 'info', icon = 'ℹ️', link = null) {
  clearTimeout(statusHideTimer);
  const bar = document.getElementById('status-bar');
  bar.className = type;
  document.getElementById('status-icon').textContent = icon;
  const msgEl = document.getElementById('status-msg');
  msgEl.textContent = msg;
  if (link) {
    msgEl.append(' ');
    const a = document.createElement('a');
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.text;
    msgEl.appendChild(a);
  }
  // Keep deployment outcomes visible until the next operation.
}

// ============================================================
// Browser draft autosave
// ============================================================
function currentEditorPath() {
  return editingArchivePath || BULLETIN_PATH;
}

function updateBusyControls() {
  const actionsLocked = persistenceOperationActive || pendingImageUploads > 0;
  ['publish-btn', 'archive-btn', 'exit-archive-btn', 'signout-btn'].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.disabled = actionsLocked;
  });
  const main = document.querySelector('.admin-main');
  if (main) main.inert = actionsLocked;
}

function setPersistenceOperationActive(active) {
  persistenceOperationActive = active;
  updateBusyControls();
}

function canStartPersistenceOperation() {
  if (persistenceOperationActive) return false;
  if (pendingImageUploads > 0) {
    setStatus('Wait for the image upload to finish before continuing.', 'info', '⏳');
    return false;
  }
  return true;
}

function draftStorageKey(path) {
  return `${DRAFT_KEY_PREFIX}:${encodeURIComponent(githubLogin)}:${encodeURIComponent(path)}`;
}

function tabDraftStorageKey(path) {
  return `${TAB_DRAFT_KEY_PREFIX}:${encodeURIComponent(githubLogin)}:${encodeURIComponent(path)}`;
}

function readTabRecoveryDraft(path) {
  const raw = safeStorageGet(SESSION_STORAGE_AREA, tabDraftStorageKey(path));
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw);
    if (draft?.version !== 1 || draft.targetPath !== path || !draft.data || !draft.savedAt) throw new Error('Invalid recovery draft');
    return draft;
  } catch (_) {
    safeStorageRemove(SESSION_STORAGE_AREA, tabDraftStorageKey(path));
    return null;
  }
}

function writeTabRecoveryDraft(path, record) {
  return safeStorageSet(SESSION_STORAGE_AREA, tabDraftStorageKey(path), JSON.stringify(record));
}

function removeTabRecoveryDraft(path) {
  safeStorageRemove(SESSION_STORAGE_AREA, tabDraftStorageKey(path));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = sortJsonValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function sameFormData(a, b) {
  const normalized = value => value && typeof value === 'object' ? { ...value, headline: Bulletin.headline(value), theme: Bulletin.headlineTheme(value) } : value;
  return JSON.stringify(sortJsonValue(normalized(a))) === JSON.stringify(sortJsonValue(normalized(b)));
}

function setDraftStatus(message, type = '') {
  const el = document.getElementById('draft-status');
  if (!el) return;
  el.className = `draft-status${type ? ` draft-status--${type}` : ''}`;
  document.getElementById('draft-status-text').textContent = message;
}

function formatDraftTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function removeDraftRecord(path) {
  try {
    const key = draftStorageKey(path);
    const currentRaw = localStorage.getItem(key);
    const expectedRaw = draftRawByPath.has(path) ? draftRawByPath.get(path) : null;
    if (currentRaw !== expectedRaw) return 'conflict';
    localStorage.removeItem(key);
    draftRawByPath.set(path, null);
    return 'ok';
  } catch (_) {
    return 'error';
  }
}

function readDraftRecord(path, reportError = true) {
  let raw;
  try {
    raw = localStorage.getItem(draftStorageKey(path));
    draftRawByPath.set(path, raw);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (draft?.version !== 1 || draft.targetPath !== path || !draft.data || !draft.savedAt) {
      throw new Error('Unsupported draft data');
    }
    return draft;
  } catch (_) {
    if (raw !== undefined) removeDraftRecord(path);
    return reportError ? { invalid: raw !== undefined, unavailable: raw === undefined } : null;
  }
}

function writeDraftRecord(path, record) {
  try {
    const key = draftStorageKey(path);
    const currentRaw = localStorage.getItem(key);
    const expectedRaw = draftRawByPath.has(path) ? draftRawByPath.get(path) : null;
    if (currentRaw !== expectedRaw) return 'conflict';
    const serialized = JSON.stringify(record);
    localStorage.setItem(key, serialized);
    draftRawByPath.set(path, serialized);
    return 'ok';
  } catch (_) {
    return 'error';
  }
}

function showDraftWriteFailure(result, recoverySaved = false) {
  draftSaveBlocked = true;
  if (result === 'conflict') {
    setDraftStatus(
      recoverySaved
        ? 'Another tab has a different draft — this tab has a recovery copy'
        : 'Another tab has a different draft — keep this tab open',
      'error'
    );
  } else if (result === 'error') {
    setDraftStatus(
      recoverySaved
        ? 'Draft saved only in this tab — shared storage is unavailable'
        : 'Draft not saved — browser storage is unavailable',
      'error'
    );
  }
}

function chooseEditorData(path, publishedData, publishedSha) {
  draftSaveBlocked = false;
  const sharedDraft = readDraftRecord(path);
  let recoveryDraft = readTabRecoveryDraft(path);
  if (recoveryDraft && sameFormData(recoveryDraft.data, publishedData)) {
    removeTabRecoveryDraft(path);
    recoveryDraft = null;
  }
  const draft = recoveryDraft || sharedDraft;
  const isRecovery = Boolean(recoveryDraft);
  if (!draft) {
    draftSaveBlocked = false;
    return { data: publishedData, message: 'No draft changes', type: '' };
  }
  if (draft.invalid) return { data: publishedData, message: 'Unreadable draft discarded', type: 'error' };
  if (draft.unavailable) return { data: publishedData, message: 'Draft storage unavailable', type: 'error' };

  if (sameFormData(draft.data, publishedData)) {
    const result = removeDraftRecord(path);
    if (result !== 'ok') {
      return {
        data: publishedData,
        message: result === 'conflict' ? 'Another tab has a different draft' : 'Draft storage unavailable',
        type: 'error',
      };
    }
    draftSaveBlocked = false;
    return { data: publishedData, message: 'No draft changes', type: '' };
  }

  const savedAt = formatDraftTime(draft.savedAt);
  if (draft.baseSha === publishedSha) {
    draftSaveBlocked = false;
    const source = isRecovery ? 'this tab’s recovery draft' : 'your browser draft';
    setStatus(`Restored ${source}${savedAt ? ` from ${savedAt}` : ''}.`, 'info', '💾');
    return {
      data: draft.data,
      message: `${isRecovery ? 'Tab recovery' : 'Draft'} restored${savedAt ? ` · ${savedAt}` : ''}`,
      type: 'saved',
    };
  }

  const restore = confirm(
    `A browser draft${savedAt ? ` saved at ${savedAt}` : ''} was based on an older published bulletin.\n\n` +
    'Choose OK to restore and review that draft, or Cancel to discard it and load the latest published version.'
  );
  if (!restore) {
    const result = isRecovery ? (removeTabRecoveryDraft(path), 'ok') : removeDraftRecord(path);
    if (result === 'ok') {
      setStatus('Discarded the older browser draft and loaded the latest published version.', 'success', '✅');
      draftSaveBlocked = false;
    } else {
      showDraftWriteFailure(result);
      setStatus('Loaded the latest published version, but another tab changed the saved browser draft.', 'info', '⚠️');
    }
    return result === 'ok'
      ? { data: publishedData, message: 'No draft changes', type: '' }
      : { data: publishedData, message: 'Another tab has a different draft', type: 'error' };
  }

  const acknowledgedDraft = {
    ...draft,
    baseSha: publishedSha,
    writerId: draftWriterId,
    revision: (draft.revision || 0) + 1,
  };
  if (isRecovery) {
    writeTabRecoveryDraft(path, acknowledgedDraft);
  } else {
    const result = writeDraftRecord(path, acknowledgedDraft);
    if (result !== 'ok') showDraftWriteFailure(result, writeTabRecoveryDraft(path, acknowledgedDraft));
  }
  setStatus('Restored an older browser draft. Review it carefully before publishing.', 'info', '⚠️');
  return { data: draft.data, message: 'Older draft restored · review', type: 'error' };
}

function populateFormWithoutAutosave(data) {
  const wasHydrating = draftHydrating;
  draftHydrating = true;
  try {
    populateForm(data);
  } finally {
    draftHydrating = wasHydrating;
  }
}

function activateEditorTarget(path, publishedData, publishedSha, restoreDraft = true) {
  publishedDataByPath.set(path, publishedData);
  publishedShaByPath.set(path, publishedSha || null);
  const selected = restoreDraft
    ? chooseEditorData(path, publishedData, publishedSha || null)
    : { data: publishedData, message: 'No draft changes', type: '' };
  editorBaseData = selected.data;
  populateFormWithoutAutosave(selected.data);
  setDraftStatus(selected.message, selected.type);
  scheduleBulletinPreview(true);
}

function saveDraftNow(targetPath = currentEditorPath()) {
  if (!draftAutosaveReady || draftHydrating || !githubLogin || targetPath !== currentEditorPath()) return 'ok';
  if (pendingDraftTarget === targetPath) pendingDraftTarget = null;
  draftSaveTimer = null;

  try {
    const data = extractForm({ forDraft: true });
    const publishedData = publishedDataByPath.get(targetPath);
    if (publishedData && sameFormData(data, publishedData)) {
      const result = removeDraftRecord(targetPath);
      removeTabRecoveryDraft(targetPath);
      if (result === 'ok') {
        draftSaveBlocked = false;
        setDraftStatus('No draft changes');
      } else if (result === 'error') {
        draftSaveBlocked = false;
        setDraftStatus('No draft changes · shared storage unavailable', 'error');
        return 'ok';
      } else {
        showDraftWriteFailure(result);
      }
      return result;
    }

    const savedAt = new Date().toISOString();
    const previousRaw = draftRawByPath.get(targetPath);
    let previousRevision = 0;
    if (previousRaw) {
      try { previousRevision = JSON.parse(previousRaw).revision || 0; } catch (_) {}
    }
    const record = {
      version: 1,
      targetPath,
      baseSha: publishedShaByPath.get(targetPath) || null,
      savedAt,
      writerId: draftWriterId,
      revision: previousRevision + 1,
      data,
    };
    const result = writeDraftRecord(targetPath, record);
    if (result === 'ok') {
      removeTabRecoveryDraft(targetPath);
      draftSaveBlocked = false;
      setDraftStatus(`Draft saved in this browser · ${formatDraftTime(savedAt)}`, 'saved');
    } else {
      const recoverySaved = writeTabRecoveryDraft(targetPath, record);
      showDraftWriteFailure(result, recoverySaved);
      if (result === 'error' && recoverySaved) {
        draftSaveBlocked = false;
        return 'ok';
      }
    }
    return result;
  } catch (_) {
    showDraftWriteFailure('error');
    return 'error';
  }
}

function scheduleDraftSave() {
  scheduleBulletinPreview();
  if (!draftAutosaveReady || draftHydrating) return;
  const targetPath = currentEditorPath();
  clearTimeout(draftSaveTimer);
  pendingDraftTarget = targetPath;
  setDraftStatus('Saving draft…', 'saving');
  draftSaveTimer = setTimeout(() => saveDraftNow(targetPath), DRAFT_SAVE_DELAY);
}

function flushDraftSave() {
  if (!draftAutosaveReady || draftHydrating) return 'ok';
  const targetPath = pendingDraftTarget || currentEditorPath();
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  pendingDraftTarget = null;
  return saveDraftNow(targetPath);
}

function draftSavedBefore(actionLabel) {
  const result = flushDraftSave();
  if (result === 'ok') return true;
  setStatus(
    `Cannot ${actionLabel} until this draft is reconciled. Keep this tab open, close other admin tabs, then reload this tab and try again.`,
    'error',
    '❌'
  );
  return false;
}

function completePublishedSave(path, publishedData, publishedSha) {
  if (pendingDraftTarget === path) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    pendingDraftTarget = null;
  }
  publishedDataByPath.set(path, publishedData);
  publishedShaByPath.set(path, publishedSha || null);
  if (path === BULLETIN_PATH) state = publishedData;

  if (currentEditorPath() === path) {
    editorBaseData = publishedData;
    saveDraftNow(path); // Clears the draft, unless the editor changed again while publishing.
  } else {
    const expectedRaw = draftRawByPath.get(path) || null;
    let newerDraft = null;
    try { newerDraft = expectedRaw ? JSON.parse(expectedRaw) : null; } catch (_) {}
    if (!newerDraft || sameFormData(newerDraft.data, publishedData)) removeDraftRecord(path);
    else writeDraftRecord(path, { ...newerDraft, baseSha: publishedSha || null });
  }
}

['input', 'change'].forEach(eventName => {
  document.querySelector('.admin-main').addEventListener(eventName, event => {
    if (event.target.matches('input[type="file"]')) return;
    scheduleDraftSave();
  });
});

window.addEventListener('pagehide', flushDraftSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDraftSave();
});
window.addEventListener('beforeunload', event => {
  const draftResult = flushDraftSave();
  if (pendingImageUploads <= 0 && draftResult === 'ok' && !draftSaveBlocked) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('storage', event => {
  if (!githubLogin || event.storageArea !== LOCAL_STORAGE_AREA) return;
  const path = currentEditorPath();
  if (event.key !== draftStorageKey(path)) return;
  let currentRaw;
  try { currentRaw = localStorage.getItem(event.key); } catch (_) { currentRaw = undefined; }
  if (currentRaw !== undefined && currentRaw !== (draftRawByPath.get(path) || null)) {
    draftSaveBlocked = true;
    flushDraftSave(); // Preserves this tab's current form in its session recovery slot.
  }
});

// ============================================================
// Populate & extract
// ============================================================
function populateForm(data) {
  document.getElementById('f-date').value     = data.date || '';
  const heading = Bulletin.headline(data);
  document.getElementById('f-headline-title').value = heading.title;
  document.getElementById('f-headline-reference').value = heading.reference;
  document.getElementById('f-welcome').value  = data.welcomeMessage || '';
  renderTimes(data.service?.times || []);
  document.getElementById('new-time-day').value = data.__draftUi?.newTimeDay || 'Sunday';
  document.getElementById('new-time').value = data.__draftUi?.newTime || '';
  document.getElementById('f-pastor').value      = data.service?.pastor || '';
  document.getElementById('f-location').value    = data.service?.location || '';
  document.getElementById('f-address').value     = data.service?.address || '';
  document.getElementById('f-livestream').value  = data.service?.livestream || '';
  document.getElementById('f-verse').value         = data.scripture?.verse || '';
  document.getElementById('f-reference').value    = data.scripture?.reference || '';
  document.getElementById('f-sermon-title').value = data.scripture?.sermonTitle || '';
  document.getElementById('f-sermon-series').value= data.scripture?.sermonSeries || '';
  if (scriptureImgWidget) {
    scriptureImgWidget.setImageUrl(data.scripture?.imageUrl || '');
    scriptureImgWidget.setBlendMode(data.scripture?.imageBlendMode || '');
  }
  document.getElementById('f-scripture-enabled').checked    = data.scriptureEnabled !== false;
  document.getElementById('f-announcements-enabled').checked = data.announcementsEnabled !== false;
  document.getElementById('f-savedates-enabled').checked     = data.savetheDatesEnabled !== false;
  document.getElementById('f-thisweek-enabled').checked      = data.thisWeekEnabled !== false;
  renderSectionOrder(data.sectionOrder || DEFAULT_SECTION_ORDER);
  renderAnnouncements(data.announcements || []);
  renderSavedates(data.savetheDates || data.events || []);
  renderThisweek(data.thisWeek || []);
  updateSectionBody('f-scripture-enabled', 'scripture-body');
  updateSectionBody('f-announcements-enabled', 'announcements-body');
  updateSectionBody('f-savedates-enabled', 'savedates-body');
  updateSectionBody('f-thisweek-enabled', 'thisweek-body');
  renderScripturePreview();
  document.getElementById('f-give-url').value   = data.giving?.url || '';
  document.getElementById('f-give-text').value  = data.giving?.text || '';
  document.getElementById('f-phone').value      = data.contact?.phone || '';
  document.getElementById('f-email').value      = data.contact?.email || '';
  document.getElementById('f-website').value    = data.contact?.website || '';
  document.getElementById('f-facebook').value   = data.contact?.facebook || '';
  document.getElementById('f-instagram').value  = data.contact?.instagram || '';
  document.getElementById('f-youtube').value    = data.contact?.youtube || '';
  document.getElementById('f-backtowebsite-enabled').checked = data.backToWebsiteEnabled !== false;
  setSlider('f-logo-desktop',  'logo-desktop-val',  data.appearance?.logoDesktop  ?? 38);
  setSlider('f-logo-mobile',   'logo-mobile-val',   data.appearance?.logoMobile   ?? 32);
  setSlider('f-badge-desktop', 'badge-desktop-val', data.appearance?.badgeDesktop ?? 100);
  setSlider('f-badge-mobile',  'badge-mobile-val',  data.appearance?.badgeMobile  ?? 80);
  updateAppearancePreview();
}

function extractForm({ forDraft = false } = {}) {
  const data = {
    date: document.getElementById('f-date').value,
    headline: { title: document.getElementById('f-headline-title').value, reference: document.getElementById('f-headline-reference').value },
    headerImage: editorBaseData.headerImage || '',
    welcomeMessage: document.getElementById('f-welcome').value,
    service: {
      times: getTimesFromUI(),
      pastor: document.getElementById('f-pastor').value,
      location: document.getElementById('f-location').value,
      address: document.getElementById('f-address').value,
      livestream: document.getElementById('f-livestream').value,
    },
    scripture: Object.assign(
      { verse: document.getElementById('f-verse').value,
        reference: document.getElementById('f-reference').value,
        sermonTitle: document.getElementById('f-sermon-title').value,
        sermonSeries: document.getElementById('f-sermon-series').value },
      scriptureImgWidget && scriptureImgWidget.getImageUrl() ? {
        imageUrl: scriptureImgWidget.getImageUrl(),
        ...(scriptureImgWidget.getBlendMode() ? { imageBlendMode: scriptureImgWidget.getBlendMode() } : {})
      } : {}
    ),
    scriptureEnabled:     document.getElementById('f-scripture-enabled').checked,
    announcementsEnabled: document.getElementById('f-announcements-enabled').checked,
    savetheDatesEnabled:  document.getElementById('f-savedates-enabled').checked,
    thisWeekEnabled:      document.getElementById('f-thisweek-enabled').checked,
    sectionOrder: getSectionOrderFromUI(),
    announcements: getAnnouncementsFromUI(forDraft),
    savetheDates: getSavedatesFromUI(forDraft),
    thisWeek: getThisweekFromUI(forDraft),
    backToWebsiteEnabled: document.getElementById('f-backtowebsite-enabled').checked,
    appearance: {
      logoDesktop:  parseInt(document.getElementById('f-logo-desktop').value,  10),
      logoMobile:   parseInt(document.getElementById('f-logo-mobile').value,   10),
      badgeDesktop: parseInt(document.getElementById('f-badge-desktop').value, 10),
      badgeMobile:  parseInt(document.getElementById('f-badge-mobile').value,  10),
    },
    giving: { url: document.getElementById('f-give-url').value, text: document.getElementById('f-give-text').value },
    contact: {
      phone: document.getElementById('f-phone').value,
      email: document.getElementById('f-email').value,
      website: document.getElementById('f-website').value,
      facebook: document.getElementById('f-facebook').value,
      instagram: document.getElementById('f-instagram').value,
      youtube: document.getElementById('f-youtube').value,
    },
  };

  data.theme = Bulletin.headlineTheme(data);
  if (forDraft) {
    const newTime = document.getElementById('new-time').value;
    const newTimeDay = document.getElementById('new-time-day').value;
    if (newTime || newTimeDay !== 'Sunday') {
      data.__draftUi = {
        newTime,
        newTimeDay,
      };
    }
  }
  return data;
}

// ============================================================
// Section order
// ============================================================
const SECTION_LABELS = {
  service:       'Service Info',
  scripture:     'Scripture & Sermon',
  announcements: 'Announcements',
  savetheDates:  'Save the Dates',
  thisWeek:      'This Week at Calvary',
};
const DEFAULT_SECTION_ORDER = ['service', 'scripture', 'announcements', 'savetheDates', 'thisWeek'];
const SECTION_ENABLED_IDS = {
  scripture:     'f-scripture-enabled',
  announcements: 'f-announcements-enabled',
  savetheDates:  'f-savedates-enabled',
  thisWeek:      'f-thisweek-enabled',
};

function isSectionActive(key) {
  const cbId = SECTION_ENABLED_IDS[key];
  if (!cbId) return true;
  const cb = document.getElementById(cbId);
  return cb ? cb.checked : true;
}

let sectionOrderSortable;
function renderSectionOrder(order) {
  const c = document.getElementById('section-order-list');
  c.innerHTML = '';
  const keys = [...new Set([...(order || []), ...DEFAULT_SECTION_ORDER])].filter(key => SECTION_LABELS[key]);
  keys.forEach(key => {
    const el = document.createElement('div');
    el.className = 'section-order-item';
    el.dataset.key = key;
    el.innerHTML = `<span class="section-drag" title="Drag to reorder" aria-hidden="true">⠿</span><span class="section-order-name">${escHtml(SECTION_LABELS[key])}</span>`;
    const cbId = SECTION_ENABLED_IDS[key];
    if(cbId) {
      const label = document.createElement('label'); label.className = 'section-visibility';
      const toggle = document.createElement('input'); toggle.type='checkbox'; toggle.checked=isSectionActive(key); toggle.setAttribute('aria-label', 'Show '+SECTION_LABELS[key]);
      const status = document.createElement('span'); status.textContent=toggle.checked?'Shown':'Hidden';
      toggle.addEventListener('change',()=>{ const source=document.getElementById(cbId);source.checked=toggle.checked;source.dispatchEvent(new Event('change',{bubbles:true})); c.querySelector('[data-key="'+key+'"] input')?.focus(); });
      label.append(toggle,status);el.append(label);
    } else { const note=document.createElement('span');note.className='section-always';note.textContent='Always shown';el.append(note); }
    addMoveControls(el, scheduleDraftSave);
    c.appendChild(el);
  });
  if (sectionOrderSortable) sectionOrderSortable.destroy();
  sectionOrderSortable = Sortable.create(c, { handle: '.section-drag', ghostClass: 'sortable-ghost', animation: 150, onEnd: scheduleDraftSave });
}
function getSectionOrderFromUI() {
  return [...document.querySelectorAll('#section-order-list .section-order-item')].map(el => el.dataset.key);
}

// ============================================================
// Service times
// ============================================================
let currentTimes = [];
function renderTimes(times) {
  currentTimes = times.map(t => typeof t === 'string' ? { day: 'Sunday', time: t } : t);
  const list = document.getElementById('times-list');
  list.innerHTML = currentTimes.map((t, i) =>
    `<span class="time-chip">${escHtml(t.day)} ${escHtml(t.time)}<button class="time-chip__remove" data-i="${i}" aria-label="Remove">×</button></span>`
  ).join('');
  list.querySelectorAll('.time-chip__remove').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTimes.splice(Number(btn.dataset.i), 1);
      renderTimes(currentTimes);
      scheduleDraftSave();
    });
  });
}
function getTimesFromUI() { return [...currentTimes]; }
document.getElementById('add-time-btn').addEventListener('click', () => {
  const v = document.getElementById('new-time').value.trim();
  const day = document.getElementById('new-time-day').value;
  if (v) {
    currentTimes.push({ day, time: v });
    renderTimes(currentTimes);
    document.getElementById('new-time').value = '';
    scheduleDraftSave();
  }
});
document.getElementById('new-time').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('add-time-btn').click(); }
});

// ============================================================
// CTA helpers
// ============================================================
function makeCtaRow(cta, onChange) {
  const row = document.createElement('div');
  row.className = 'cta-row';
  row.innerHTML = `
    <input type="text" class="cta-label-inp" aria-label="Button text" value="${escHtml(cta.label || '')}" placeholder="Button label (e.g. Register)" />
    <input type="url" class="cta-url-inp" aria-label="Website URL" value="${escHtml(cta.url || '')}" placeholder="https://..." />
    <label class="cta-qr-option"><input type="checkbox" class="cta-qr-inp" ${cta.showQr !== false ? 'checked' : ''} /> Show QR code</label>
    <button class="cta-remove-btn" aria-label="Remove CTA">✕</button>
  `;
  row.querySelector('.cta-remove-btn').addEventListener('click', () => { row.remove(); if (onChange) onChange(); });
  row.querySelector('.cta-qr-inp').addEventListener('change', () => { if (onChange) onChange(); });
  return row;
}
function makeCtas(ctas, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'ctas-section';
  wrap.innerHTML = '<div class="ctas-label">Links (optional)</div><p class="cta-help">QR codes appear on desktop. Links are available on every device.</p>';
  const rowsWrap = document.createElement('div');
  rowsWrap.className = 'ctas-rows';
  (ctas || []).forEach(c => rowsWrap.appendChild(makeCtaRow(c, onChange)));
  const addBtn = document.createElement('button');
  addBtn.className = 'add-cta-btn';
  addBtn.textContent = '+ Add Link';
  addBtn.addEventListener('click', () => { rowsWrap.appendChild(makeCtaRow({}, onChange)); if (onChange) onChange(); });
  wrap.appendChild(rowsWrap);
  wrap.appendChild(addBtn);
  wrap.getCtas = (includeIncomplete = false) => {
    const rows = [...rowsWrap.querySelectorAll('.cta-row')].map(r => ({
      label: r.querySelector('.cta-label-inp').value,
      url:   r.querySelector('.cta-url-inp').value,
      showQr: r.querySelector('.cta-qr-inp').checked,
    }));
    return includeIncomplete ? rows : rows.filter(c => c.label && c.url);
  };
  return wrap;
}

// ============================================================
// Image upload widget
// ============================================================
const IMG_UPLOAD_PATH = 'src/assets/images/uploads';
const IMG_ACCEPTED    = ['image/jpeg', 'image/png', 'image/webp'];
const IMG_MAX_BYTES   = 500 * 1024;
const IMG_EXT_MAP     = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function makeImageUpload(aspectClass, hintText, slugPrefix, previewBg, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'img-upload-row';
  wrap.innerHTML = `
    <div class="img-upload-label">
      Image <span style="font-weight:400;text-transform:none;">(optional)</span>
      <span class="img-upload-hint">${escHtml(hintText)}</span>
    </div>
    <div class="img-dropzone" role="button" tabindex="0" aria-label="Upload image">
      <input type="file" accept="image/jpeg,image/png,image/webp" />
      Click or drag to upload &middot; JPG/PNG/WebP &middot; max 500 KB
    </div>
    <div class="img-preview-wrap">
      <div class="img-preview-aspect ${escHtml(aspectClass)}" style="${previewBg ? 'background:' + escHtml(previewBg) + ';' : ''}">
        <img src="" alt="Preview" />
        <div class="img-uploading-overlay">Uploading&hellip;</div>
      </div>
      <div class="img-url-display"></div>
      <button class="img-remove-btn" type="button">Remove image</button>
    </div>
    <div class="img-blend-row">
      <span class="img-blend-label">Blend</span>
      <select class="img-blend-select" aria-label="Image blend mode">
        <option value="normal">Normal</option>
        <option value="multiply">Multiply — fade white</option>
        <option value="screen">Screen — fade black</option>
        <option value="overlay">Overlay</option>
        <option value="darken">Darken</option>
        <option value="lighten">Lighten</option>
      </select>
    </div>
  `;

  let currentUrl = '';
  let currentBlobUrl = '';
  let uploadGeneration = 0;
  const fileInput    = wrap.querySelector('input[type="file"]');
  const previewWrap  = wrap.querySelector('.img-preview-wrap');
  const previewImg   = wrap.querySelector('.img-preview-aspect img');
  const overlay      = wrap.querySelector('.img-uploading-overlay');
  const urlDisplay   = wrap.querySelector('.img-url-display');
  const removeBtn    = wrap.querySelector('.img-remove-btn');
  const blendSelect  = wrap.querySelector('.img-blend-select');

  function applyBlend() {
    const v = blendSelect.value;
    previewImg.style.mixBlendMode = (v && v !== 'normal') ? v : '';
  }
  blendSelect.addEventListener('change', () => { applyBlend(); if (onChange) onChange(); });

  function showPreview(url, displaySrc) {
    if (currentBlobUrl && currentBlobUrl !== displaySrc) URL.revokeObjectURL(currentBlobUrl);
    currentUrl = url;
    previewImg.src = displaySrc || url;
    currentBlobUrl = displaySrc?.startsWith('blob:') ? displaySrc : '';
    urlDisplay.textContent = url;
    previewWrap.classList.add('has-image');
    applyBlend();
    if (onChange) onChange();
  }
  function clearPreview() {
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = '';
    currentUrl = '';
    previewImg.src = '';
    urlDisplay.textContent = '';
    previewWrap.classList.remove('has-image');
    if (onChange) onChange();
  }

  async function handleFile(file) {
    if (!IMG_ACCEPTED.includes(file.type)) {
      setStatus('Image must be JPG, PNG, or WebP.', 'error', '❌'); return;
    }
    if (file.size > IMG_MAX_BYTES) {
      setStatus(`Image too large (${(file.size/1024).toFixed(0)} KB). Maximum is 500 KB.`, 'error', '❌'); return;
    }
    const ext      = IMG_EXT_MAP[file.type] || 'jpg';
    const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
    const filename = `${slugPrefix}-${baseName}-${Date.now()}.${ext}`;
    const uploadPath = `${IMG_UPLOAD_PATH}/${filename}`;
    const publicUrl  = `/assets/images/uploads/${filename}`;

    // Preview locally, but keep the saved URL unchanged until GitHub confirms the upload.
    const generation = ++uploadGeneration;
    const blobUrl = URL.createObjectURL(file);
    const previous = {
      url: currentUrl,
      src: previewImg.getAttribute('src') || '',
      label: urlDisplay.textContent,
      visible: previewWrap.classList.contains('has-image'),
    };
    previewImg.src = blobUrl;
    urlDisplay.textContent = `Uploading ${publicUrl}`;
    previewWrap.classList.add('has-image');
    applyBlend();

    overlay.classList.add('active');
    fileInput.disabled = true;
    removeBtn.disabled = true;
    pendingImageUploads += 1;
    updateBusyControls();
    setStatus('Uploading image…', 'info', '⏳');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);

      const sha = await getFileSha(uploadPath);
      const body = { message: `Upload image: ${filename}`, content: b64, branch: GITHUB_BRANCH };
      if (sha) body.sha = sha;
      await ghFetch(`contents/${uploadPath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (generation !== uploadGeneration) return;
      showPreview(publicUrl, blobUrl);
      setStatus('Image uploaded. It will appear on the bulletin after the next publish.', 'success', '✅');
    } catch (err) {
      if (generation !== uploadGeneration) return;
      currentUrl = previous.url;
      previewImg.src = previous.src;
      urlDisplay.textContent = previous.label;
      previewWrap.classList.toggle('has-image', previous.visible);
      applyBlend();
      URL.revokeObjectURL(blobUrl);
      setStatus('Image upload failed: ' + err.message, 'error', '❌');
    } finally {
      pendingImageUploads = Math.max(0, pendingImageUploads - 1);
      updateBusyControls();
      if (generation === uploadGeneration) {
        overlay.classList.remove('active');
        fileInput.disabled = false;
        removeBtn.disabled = false;
        fileInput.value = '';
      }
    }
  }

  fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  removeBtn.addEventListener('click', () => clearPreview());

  wrap.getImageUrl   = () => currentUrl;
  wrap.getBlendMode  = () => blendSelect.value === 'normal' ? '' : blendSelect.value;
  wrap.setImageUrl   = (url) => { if (url) showPreview(url); else clearPreview(); };
  wrap.setBlendMode  = (v) => { blendSelect.value = v || 'normal'; applyBlend(); };
  return wrap;
}

// ============================================================
// Announcements
// ============================================================
function handleAnnouncementsChange() {
  renderAnnouncementsPreview();
  scheduleDraftSave();
}

let annSortable;
function makeAnnouncementItem(item, onChange) {
  const el = document.createElement('div');
  el.className = 'list-item';
  el.innerHTML = `
    <span class="list-item__handle" title="Drag to reorder">⠿</span>
    <button class="remove-btn" aria-label="Remove">✕</button>
    <div class="field" style="margin-top:0.5rem;">
      <label>Title</label>
      <input type="text" class="ann-title" value="${escHtml(item.title || '')}" placeholder="Announcement title" />
    </div>
    <div class="field">
      <label>Message</label>
      <textarea class="ann-body" rows="2">${escHtml(item.body || '')}</textarea>
    </div>
  `;
  const ctasEl = makeCtas(item.ctas || [], onChange);
  el.appendChild(ctasEl);
  const imgWidget = makeImageUpload('img-preview-aspect--16x9', '16:9 landscape · 1200×675 · max 500 KB', 'ann', '#F7F3EC', onChange);
  if (item.imageUrl) imgWidget.setImageUrl(item.imageUrl);
  if (item.imageBlendMode) imgWidget.setBlendMode(item.imageBlendMode);
  el.appendChild(imgWidget);
  el.querySelector('.remove-btn').addEventListener('click', () => { el.remove(); if (onChange) onChange(); });
  el._getCtas = includeIncomplete => ctasEl.getCtas(includeIncomplete);
  el._getImageUrl = () => imgWidget.getImageUrl();
  el._getImageBlendMode = () => imgWidget.getBlendMode();
  decorateEditorCard(el, '.ann-title', '.ann-body', onChange);
  return el;
}
function renderAnnouncements(items) {
  const c = document.getElementById('announcements-list');
  c.innerHTML = '';
  items.forEach(item => c.appendChild(makeAnnouncementItem(item, handleAnnouncementsChange)));
  openFirstCard(c);
  if (annSortable) annSortable.destroy();
  annSortable = Sortable.create(c, { handle: '.list-item__handle', ghostClass: 'sortable-ghost', animation: 150, onEnd: handleAnnouncementsChange });
  renderAnnouncementsPreview();
}
function getAnnouncementsFromUI(includeIncompleteCtas = false) {
  return [...document.querySelectorAll('#announcements-list .list-item')].map(el => ({
    title:           el.querySelector('.ann-title').value,
    body:            el.querySelector('.ann-body').value,
    imageUrl:        el._getImageUrl ? el._getImageUrl() : '',
    imageBlendMode:  el._getImageBlendMode ? el._getImageBlendMode() : '',
    ctas:            el._getCtas ? el._getCtas(includeIncompleteCtas) : [],
  })).map(a => {
    if (!a.imageUrl) { const { imageUrl, imageBlendMode, ...rest } = a; return rest; }
    if (!a.imageBlendMode) { const { imageBlendMode, ...rest } = a; return rest; }
    return a;
  });
}
document.getElementById('add-announcement-btn').addEventListener('click', () => {
  document.getElementById('announcements-list').appendChild(makeAnnouncementItem({}, handleAnnouncementsChange));
  handleAnnouncementsChange();
});

// ============================================================
// Save the Dates
// ============================================================
function handleSavedatesChange() {
  renderSavedatesPreview();
  scheduleDraftSave();
}

let saveSortable;
function makeSavedateItem(item, onChange) {
  const el = document.createElement('div');
  el.className = 'list-item';
  el.innerHTML = `
    <span class="list-item__handle" title="Drag to reorder">⠿</span>
    <button class="remove-btn" aria-label="Remove">✕</button>
    <div class="field" style="margin-top:0.5rem;">
      <label>Event Title</label>
      <input type="text" class="sd-title" value="${escHtml(item.title || '')}" placeholder="Event name" />
    </div>
    <div class="field-row">
      <div class="field"><label>Date</label><input type="date" class="sd-date" value="${escHtml(item.date || '')}" /></div>
      <div class="field"><label>Time</label><input type="text" class="sd-time" value="${escHtml(item.time || '')}" placeholder="e.g. 6:00 PM" /></div>
    </div>
    <div class="field">
      <label>Description</label>
      <textarea class="sd-desc" rows="2">${escHtml(item.description || '')}</textarea>
    </div>
  `;
  const ctasEl = makeCtas(item.ctas || [], onChange);
  el.appendChild(ctasEl);
  const imgWidget = makeImageUpload('img-preview-aspect--16x9', '16:9 landscape · 1200×675 · max 500 KB', 'sd', '#F7F3EC', onChange);
  if (item.imageUrl) imgWidget.setImageUrl(item.imageUrl);
  if (item.imageBlendMode) imgWidget.setBlendMode(item.imageBlendMode);
  el.appendChild(imgWidget);
  el.querySelector('.remove-btn').addEventListener('click', () => { el.remove(); if (onChange) onChange(); });
  el._getCtas = includeIncomplete => ctasEl.getCtas(includeIncomplete);
  el._getImageUrl = () => imgWidget.getImageUrl();
  el._getImageBlendMode = () => imgWidget.getBlendMode();
  decorateEditorCard(el, '.sd-title', '.sd-desc', onChange);
  return el;
}
function renderSavedates(items) {
  const c = document.getElementById('savedates-list');
  c.innerHTML = '';
  items.forEach(item => c.appendChild(makeSavedateItem(item, handleSavedatesChange)));
  openFirstCard(c);
  if (saveSortable) saveSortable.destroy();
  saveSortable = Sortable.create(c, { handle: '.list-item__handle', ghostClass: 'sortable-ghost', animation: 150, onEnd: handleSavedatesChange });
  renderSavedatesPreview();
}
function getSavedatesFromUI(includeIncompleteCtas = false) {
  return [...document.querySelectorAll('#savedates-list .list-item')].map(el => ({
    title:          el.querySelector('.sd-title').value,
    date:           el.querySelector('.sd-date').value,
    time:           el.querySelector('.sd-time').value,
    description:    el.querySelector('.sd-desc').value,
    imageUrl:       el._getImageUrl ? el._getImageUrl() : '',
    imageBlendMode: el._getImageBlendMode ? el._getImageBlendMode() : '',
    ctas:           el._getCtas ? el._getCtas(includeIncompleteCtas) : [],
  })).map(s => {
    if (!s.imageUrl) { const { imageUrl, imageBlendMode, ...rest } = s; return rest; }
    if (!s.imageBlendMode) { const { imageBlendMode, ...rest } = s; return rest; }
    return s;
  });
}
document.getElementById('add-savedate-btn').addEventListener('click', () => {
  document.getElementById('savedates-list').appendChild(makeSavedateItem({}, handleSavedatesChange));
  handleSavedatesChange();
});

// ============================================================
// This Week at Calvary
// ============================================================
function handleThisweekChange() {
  renderThisweekPreview();
  scheduleDraftSave();
}

let weekSortable;
function makeThisweekItem(item, onChange) {
  const el = document.createElement('div');
  el.className = 'list-item';
  el.innerHTML = `
    <span class="list-item__handle" title="Drag to reorder">⠿</span>
    <button class="remove-btn" aria-label="Remove">✕</button>
    <div class="field-row" style="margin-top:0.5rem;">
      <div class="field">
        <label>Day</label>
        <select class="tw-day">
          ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(d =>
            `<option${item.day === d ? ' selected' : ''}>${d}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field">
        <label>Time</label>
        <input type="text" class="tw-time" value="${escHtml(item.time || '')}" placeholder="e.g. 7:00 PM" />
      </div>
    </div>
    <div class="field">
      <label>Title / Ministry Name</label>
      <input type="text" class="tw-title" value="${escHtml(item.title || '')}" placeholder="e.g. Men's Bible Study" />
    </div>
    <div class="field">
      <label>Location <span style="font-weight:400;text-transform:none;">(optional)</span></label>
      <input type="text" class="tw-location" value="${escHtml(item.location || '')}" placeholder="e.g. Room 201" />
    </div>
    <div class="field">
      <label>Description <span style="font-weight:400;text-transform:none;">(optional)</span></label>
      <textarea class="tw-desc" rows="2">${escHtml(item.description || '')}</textarea>
    </div>
  `;
  const ctasEl = makeCtas(item.ctas || [], onChange);
  el.appendChild(ctasEl);
  el.querySelector('.remove-btn').addEventListener('click', () => { el.remove(); if (onChange) onChange(); });
  el._getCtas = includeIncomplete => ctasEl.getCtas(includeIncomplete);
  decorateEditorCard(el, '.tw-title', '.tw-location', onChange);
  return el;
}
function renderThisweek(items) {
  const c = document.getElementById('thisweek-list');
  c.innerHTML = '';
  items.forEach(item => c.appendChild(makeThisweekItem(item, handleThisweekChange)));
  openFirstCard(c);
  if (weekSortable) weekSortable.destroy();
  weekSortable = Sortable.create(c, { handle: '.list-item__handle', ghostClass: 'sortable-ghost', animation: 150, onEnd: handleThisweekChange });
  renderThisweekPreview();
}
function getThisweekFromUI(includeIncompleteCtas = false) {
  return [...document.querySelectorAll('#thisweek-list .list-item')].map(el => ({
    title:       el.querySelector('.tw-title').value,
    day:         el.querySelector('.tw-day').value,
    time:        el.querySelector('.tw-time').value,
    location:    el.querySelector('.tw-location').value,
    description: el.querySelector('.tw-desc').value,
    ctas:        el._getCtas ? el._getCtas(includeIncompleteCtas) : [],
  }));
}
document.getElementById('add-thisweek-btn').addEventListener('click', () => {
  document.getElementById('thisweek-list').appendChild(makeThisweekItem({}, handleThisweekChange));
  handleThisweekChange();
});

// ============================================================
// Live bulletin section previews
// ============================================================
function renderScripturePreview() { scheduleBulletinPreview(); }
function renderAnnouncementsPreview() { scheduleBulletinPreview(); }
function renderSavedatesPreview() { scheduleBulletinPreview(); }
function renderThisweekPreview() { scheduleBulletinPreview(); }

// ============================================================
// Publish
// ============================================================
let pastDateConfirmationPending = false;
document.getElementById('publish-btn').addEventListener('click', async () => {
  if (pastDateConfirmationPending) return;
  if (!canStartPersistenceOperation()) return;
  if (!draftSavedBefore(editingArchivePath ? 'save this archive' : 'publish')) return;
  const data = extractForm();
  const errors = validateUrls(data);
  if (errors.length) {
    setStatus('Cannot save — fix these URLs first:\n' + errors.join(' | '), 'error', '❌');
    return;
  }
  if (!editingArchivePath && bulletinDateHasPassed(data.date)) {
    pastDateConfirmationPending = true;
    let choice;
    try { choice = await confirmPastBulletinDate(data.date); }
    finally { pastDateConfirmationPending = false; }
    if (choice !== 'publish' && choice !== 'archive') return;
    if (!canStartPersistenceOperation()) return;
    if (editingArchivePath || !sameFormData(data, extractForm())) {
      setStatus('The bulletin changed while the date warning was open. Review your changes and try again.', 'info', 'ℹ️');
      return;
    }
    if (choice === 'archive') {
      document.getElementById('archive-btn').click();
      return;
    }
  }
  setPersistenceOperationActive(true);
  const btn = document.getElementById('publish-btn');
  btn.disabled = true;
  if (editingArchivePath) {
    const targetPath = editingArchivePath;
    setStatus('Saving archive…', 'info', '⏳');
    try {
      const res = await putFile(
        targetPath,
        JSON.stringify(data, null, 2),
        `Update archived bulletin for ${data.date}`,
        publishedShaByPath.get(targetPath)
      );
      completePublishedSave(targetPath, data, res.content?.sha);
      trackDeploy(res.commit.sha);
    } catch (err) { setStatus('Error saving archive: ' + err.message, 'error', '❌'); }
    finally { btn.disabled = false; setPersistenceOperationActive(false); }
  } else {
    setStatus('Publishing bulletin…', 'info', '⏳');
    try {
      const res = await putFile(
        BULLETIN_PATH,
        JSON.stringify(data, null, 2),
        `Update bulletin for ${data.date}`,
        publishedShaByPath.get(BULLETIN_PATH)
      );
      completePublishedSave(BULLETIN_PATH, data, res.content?.sha);
      trackDeploy(res.commit.sha);
    } catch (err) { setStatus('Error publishing: ' + err.message, 'error', '❌'); }
    finally { btn.disabled = false; setPersistenceOperationActive(false); }
  }
});

// ============================================================
// Archive & Start New
// ============================================================
document.getElementById('archive-btn').addEventListener('click', async () => {
  if (!canStartPersistenceOperation()) return;
  if (!draftSavedBefore('archive and start a new week')) return;
  const current = extractForm();
  const browserDraft = extractForm({ forDraft: true });
  if (browserDraft.__draftUi && !browserDraft.__draftUi.newTime) delete browserDraft.__draftUi;
  if (!sameFormData(browserDraft, current)) {
    setStatus('Finish or remove the staged service time and incomplete links before archiving. Your browser draft is safe.', 'error', '❌');
    return;
  }
  const errors = validateUrls(current);
  if (errors.length) {
    setStatus('Cannot archive — fix these URLs first:\n' + errors.join(' | '), 'error', '❌');
    return;
  }
  const [dateYear, dateMonth, dateDay] = current.date.split('-').map(Number);
  const parsedDate = new Date(dateYear, dateMonth - 1, dateDay, 12);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(current.date) || Number.isNaN(parsedDate.getTime()) ||
      parsedDate.getFullYear() !== dateYear || parsedDate.getMonth() !== dateMonth - 1 || parsedDate.getDate() !== dateDay) {
    setStatus('Choose a valid bulletin date before archiving.', 'error', '❌');
    return;
  }
  const nextDate = getNextSunday(current.date);
  if (!confirm(`Archive the bulletin for ${current.date} and start ${nextDate}? This copies its content forward and updates the live bulletin.`)) return;
  if (!canStartPersistenceOperation()) return;
  setPersistenceOperationActive(true);
  setStatus('Archiving…', 'info', '⏳');
  const btn = document.getElementById('archive-btn');
  btn.disabled = true;
  const archivedPath = `src/_data/previous/${current.date}.json`;
  let archiveReady = false;
  let archiveSha = null;
  try {
    const expectedLiveSha = publishedShaByPath.get(BULLETIN_PATH);
    const liveSha = await getFileSha(BULLETIN_PATH);
    if (liveSha !== expectedLiveSha) {
      throw new Error('The live bulletin changed on GitHub after you opened it. Your browser draft is safe — reload before archiving.');
    }

    let existingArchive = null;
    try {
      existingArchive = await ghFetch(`contents/${archivedPath}?ref=${GITHUB_BRANCH}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (existingArchive) {
      const existingData = JSON.parse(decodeURIComponent(escape(atob(existingArchive.content.replace(/\n/g, '')))));
      if (!sameFormData(existingData, current)) {
        throw new Error(`An archive for ${current.date} already exists with different content. Open that archive to review it before trying again.`);
      }
      archiveSha = existingArchive.sha;
      archiveReady = true; // Safe retry after a prior partial archive operation.
    } else {
      const archiveResult = await putFile(
        archivedPath,
        JSON.stringify(current, null, 2),
        `Archive bulletin for ${current.date}`,
        null
      );
      archiveSha = archiveResult.content?.sha || null;
      archiveReady = true;
    }
    const blank = {
      date: nextDate, headline: current.headline, theme: current.theme, headerImage: current.headerImage, welcomeMessage: current.welcomeMessage,
      service: current.service,
      scripture: Object.assign({}, current.scripture || { verse: '', reference: '', sermonTitle: '', sermonSeries: '' }, { imageUrl: '' }),
      scriptureEnabled: current.scriptureEnabled ?? true,
      announcementsEnabled: current.announcementsEnabled ?? true,
      savetheDatesEnabled: current.savetheDatesEnabled ?? true,
      thisWeekEnabled: current.thisWeekEnabled ?? true,
      sectionOrder: current.sectionOrder || DEFAULT_SECTION_ORDER,
      announcements: current.announcements || [], savetheDates: current.savetheDates || [], thisWeek: current.thisWeek || [],
      backToWebsiteEnabled: current.backToWebsiteEnabled ?? true,
      appearance: current.appearance,
      giving: current.giving, contact: current.contact,
    };
    const latestArchiveSha = await getFileSha(archivedPath);
    if (!archiveSha || latestArchiveSha !== archiveSha) {
      throw new Error('The archive changed on GitHub during this operation. The live bulletin was not reset; review the archive before retrying.');
    }
    const res = await putFile(
      BULLETIN_PATH,
      JSON.stringify(blank, null, 2),
      `Start new bulletin for ${nextDate}`,
      publishedShaByPath.get(BULLETIN_PATH)
    );
    state = blank;
    editingArchivePath = null;
    removeDraftRecord(archivedPath);
    const currentDraftRemoval = removeDraftRecord(BULLETIN_PATH);
    activateEditorTarget(BULLETIN_PATH, blank, res.content?.sha, false);
    if (currentDraftRemoval !== 'ok') showDraftWriteFailure(currentDraftRemoval);
    trackDeploy(res.commit.sha, `Archived ${current.date} and started bulletin for ${nextDate}. Waiting for GitHub to rebuild…`);
  } catch (err) {
    const prefix = archiveReady
      ? 'The archive copy is saved, but the new week was not started. Retry Archive & Start New; the matching archive will be reused. '
      : 'Error archiving: ';
    setStatus(prefix + err.message, 'error', '❌');
  }
  finally { btn.disabled = false; setPersistenceOperationActive(false); }
});

function getNextSunday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const daysUntil = d.getDay() === 0 ? 7 : 7 - d.getDay();
  d.setDate(d.getDate() + daysUntil);
  return d.toISOString().split('T')[0];
}

// ============================================================
// Section toggles
// ============================================================
function updateSectionBody(cbId, bodyId) {
  const cb = document.getElementById(cbId);
  const body = document.getElementById(bodyId);
  body.classList.toggle('section-body--disabled', !cb.checked);
}
const SECTION_PREVIEW_RENDERERS = {
  scripture:     () => renderScripturePreview(),
  announcements: () => renderAnnouncementsPreview(),
  savedates:     () => renderSavedatesPreview(),
  thisweek:      () => renderThisweekPreview(),
};
['scripture', 'announcements', 'savedates', 'thisweek'].forEach(key => {
  const cbId = `f-${key}-enabled`;
  const bodyId = `${key}-body`;
  document.getElementById(cbId).addEventListener('change', () => {
    updateSectionBody(cbId, bodyId);
    renderSectionOrder(getSectionOrderFromUI());
    SECTION_PREVIEW_RENDERERS[key]();
  });
});

// ============================================================
// Archives
// ============================================================
async function loadArchiveList() {
  const listEl = document.getElementById('archives-list');
  listEl.innerHTML = '<p style="color:var(--muted);font-size:0.875rem;">Loading…</p>';
  try {
    const files = await ghFetch(`contents/${PREVIOUS_PATH}?ref=${GITHUB_BRANCH}`);
    const jsonFiles = files.filter(f => f.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name));
    if (!jsonFiles.length) {
      listEl.innerHTML = '<p style="color:var(--muted);font-size:0.875rem;">No archived bulletins found.</p>';
      return;
    }
    listEl.innerHTML = '';
    jsonFiles.forEach(file => {
      const date = file.name.replace('.json', '');
      const row = document.createElement('div');
      row.className = 'archive-row';
      row.innerHTML = `
        <div>
          <div class="archive-row__date">${escHtml(date)}</div>
          <div class="archive-row__theme" id="arch-theme-${escHtml(date)}">Loading…</div>
        </div>
        <div class="archive-row__actions">
          <button class="btn btn--ghost btn--sm">Edit</button>
          <button class="btn btn--danger btn--sm">Delete</button>
        </div>
      `;
      const [editBtn, deleteBtn] = row.querySelectorAll('button');
      editBtn.addEventListener('click', () => editArchive(file.path, date));
      deleteBtn.addEventListener('click', () => deleteArchive(file.path, date, row, file.sha));
      listEl.appendChild(row);
      loadArchiveTheme(file.path, date);
    });
  } catch (err) {
    listEl.innerHTML = `<p style="color:var(--danger);font-size:0.875rem;">Error loading archives: ${escHtml(err.message)}</p>`;
  }
}

async function loadArchiveTheme(filePath, date) {
  try {
    const data = await ghFetch(`contents/${filePath}?ref=${GITHUB_BRANCH}`);
    const parsed = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))));
    const el = document.getElementById(`arch-theme-${date}`);
    if (el) el.textContent = Bulletin.headlineTheme(parsed) || '(no headline)';
  } catch (_) {
    const el = document.getElementById(`arch-theme-${date}`);
    if (el) el.textContent = '';
  }
}

async function editArchive(filePath, date) {
  if (!canStartPersistenceOperation()) return;
  if (!draftSavedBefore('switch bulletins')) return;
  setPersistenceOperationActive(true);
  setStatus(`Loading archive for ${date}…`, 'info', '⏳');
  try {
    const file = await ghFetch(`contents/${filePath}?ref=${GITHUB_BRANCH}`);
    const parsed = JSON.parse(decodeURIComponent(escape(atob(file.content.replace(/\n/g, '')))));
    editingArchivePath = filePath;
    activateEditorTarget(filePath, parsed, file.sha);
    navigateTo('overview');
    updateArchiveEditMode();
    setStatus(`Editing archive: ${date}. Make changes and click "Save Archive" when done.`, 'info', '✏️');
  } catch (err) {
    setStatus('Error loading archive: ' + err.message, 'error', '❌');
  } finally {
    setPersistenceOperationActive(false);
  }
}

async function deleteArchive(filePath, date, rowEl, expectedSha) {
  if (!canStartPersistenceOperation()) return;
  if (filePath === editingArchivePath) {
    setStatus('Exit this archive before deleting it.', 'error', '❌');
    return;
  }
  let savedBrowserDraft = false;
  try { savedBrowserDraft = Boolean(localStorage.getItem(draftStorageKey(filePath))); } catch (_) {}
  if (savedBrowserDraft) {
    setStatus('This archive has an unsaved browser draft. Open it and publish or discard that draft before deleting the archive.', 'error', '❌');
    return;
  }
  if (!confirm(`Permanently delete the archived bulletin for ${date}? This cannot be undone.`)) return;
  if (!canStartPersistenceOperation()) return;
  setPersistenceOperationActive(true);
  setStatus(`Deleting archive for ${date}…`, 'info', '⏳');
  try {
    if (!expectedSha) throw new Error('File version is unavailable. Reload the archive list and try again.');
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`, {
      method: 'DELETE',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Delete archived bulletin for ${date}`, sha: expectedSha, branch: GITHUB_BRANCH }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `GitHub API ${res.status}`); }
    rowEl.remove();
    removeDraftRecord(filePath);
    publishedDataByPath.delete(filePath);
    publishedShaByPath.delete(filePath);
    setStatus(`Deleted archive for ${date}.`, 'success', '✅');
  } catch (err) {
    setStatus('Error deleting archive: ' + err.message, 'error', '❌');
  } finally {
    setPersistenceOperationActive(false);
  }
}

function updateArchiveEditMode() {
  const banner = document.getElementById('archive-edit-banner');
  const publishBtn = document.getElementById('publish-btn');
  const archiveBtn = document.getElementById('archive-btn');
  const importPanel = document.querySelector('.import-panel');
  document.getElementById('week-actions').hidden = Boolean(editingArchivePath);
  if (editingArchivePath) {
    const date = editingArchivePath.split('/').pop().replace('.json', '');
    banner.querySelector('.archive-edit-banner__date').textContent = date;
    banner.style.display = 'flex';
    publishBtn.textContent = 'Save Archive';
    archiveBtn.style.display = 'none';
    importPanel.style.display = 'none';
  } else {
    banner.style.display = 'none';
    publishBtn.textContent = 'Publish Bulletin';
    archiveBtn.style.display = '';
    importPanel.style.display = '';
  }
}

document.getElementById('exit-archive-btn').addEventListener('click', () => {
  if (!canStartPersistenceOperation()) return;
  if (!draftSavedBefore('exit this archive')) return;
  editingArchivePath = null;
  activateEditorTarget(BULLETIN_PATH, state, publishedShaByPath.get(BULLETIN_PATH));
  updateArchiveEditMode();
  setStatus('Back to current bulletin. Browser drafts remain saved until you publish.', 'success', '✅');
});

// ============================================================
// Utility
// ============================================================
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ============================================================
// JSON Import
// ============================================================
function handleImportFile(file) {
  if (!file || !file.name.endsWith('.json')) {
    setStatus('Please select a valid .json file.', 'error', '❌');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      applyJsonImport(data, file.name);
    } catch {
      setStatus('Could not parse JSON — check the file format and try again.', 'error', '❌');
    }
  };
  reader.readAsText(file);
}

function applyJsonImport(data, filename) {
  const updated = [];
  if (data.headline && typeof data.headline === 'object') {
    if (typeof data.headline.title === 'string') document.getElementById('f-headline-title').value = data.headline.title;
    if (typeof data.headline.reference === 'string') document.getElementById('f-headline-reference').value = data.headline.reference;
    updated.push('Bulletin headline');
  }
  if (data.scripture) {
    document.getElementById('f-verse').value        = data.scripture.verse        || '';
    document.getElementById('f-reference').value    = data.scripture.reference    || '';
    document.getElementById('f-sermon-title').value = data.scripture.sermonTitle  || '';
    document.getElementById('f-sermon-series').value= data.scripture.sermonSeries || '';
    updated.push('Scripture & Sermon');
  }
  if (data.announcements) { renderAnnouncements(data.announcements); updated.push('Announcements'); }
  if (data.savetheDates)  { renderSavedates(data.savetheDates);       updated.push('Save the Dates'); }
  if (data.thisWeek)      { renderThisweek(data.thisWeek);            updated.push('This Week at Calvary'); }

  if (!updated.length) {
    setStatus('No recognized sections found. Make sure the JSON matches the template format.', 'error', '❌');
    return;
  }
  document.getElementById('import-file-name').textContent = `✓ ${filename} — updated: ${updated.join(', ')}`;
  scheduleDraftSave();
  setStatus(`Imported ${updated.join(', ')}. Review the sections, then publish when ready.`, 'success', '✅');
}

const importDropzone = document.getElementById('import-dropzone');
importDropzone.addEventListener('click', () => document.getElementById('import-file-input').click());
importDropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') document.getElementById('import-file-input').click(); });
document.getElementById('import-file-input').addEventListener('change', e => { if (e.target.files[0]) handleImportFile(e.target.files[0]); e.target.value = ''; });
importDropzone.addEventListener('dragover', e => { e.preventDefault(); importDropzone.classList.add('dragover'); });
importDropzone.addEventListener('dragleave', ()  => importDropzone.classList.remove('dragover'));
importDropzone.addEventListener('drop', e => {
  e.preventDefault(); importDropzone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleImportFile(e.dataTransfer.files[0]);
});

// ============================================================
// ============================================================
// Appearance sliders & live preview
// ============================================================


function setSlider(inputId, valId, value) {
  const input = document.getElementById(inputId);
  const display = document.getElementById(valId);
  input.value = value;
  display.textContent = value + 'px';
}

function updateAppearancePreview() { scheduleBulletinPreview(); }

['f-logo-desktop', 'f-logo-mobile', 'f-badge-desktop', 'f-badge-mobile'].forEach(id => {
  const input = document.getElementById(id);
  const valId = id.replace('f-', '').replace(/-(\w)/g, (_, c) => '-' + c) + '-val';
  input.addEventListener('input', () => {
    document.getElementById(valId).textContent = input.value + 'px';
    updateAppearancePreview();
  });
});

// ============================================================
// Download Template
// ============================================================
document.getElementById('download-template-btn').addEventListener('click', () => {
  const template = {
    "_instructions": [
      "HOW TO USE THIS TEMPLATE:",
      "1. Copy the entire contents of this file.",
      "2. Open an AI assistant (ChatGPT, Claude, etc.).",
      "3. Paste this template, then paste your paper bulletin text below it.",
      "4. Ask the AI: 'Fill out this JSON template using the bulletin content above. Keep the exact field names and structure. Use YYYY-MM-DD format for dates. The \"day\" field must be one of: Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday. Remove the _instructions field from your output.'",
      "5. Copy the AI's JSON output and save it as a .json file.",
      "6. Upload it in the Bulletin Admin to apply the changes.",
      "",
      "NOTES:",
      "- Only include sections you want to update. Remove any top-level key you don't need.",
      "- 'ctas' are optional call-to-action buttons with a QR code. Use [] if none.",
      "- All URLs must start with https://"
    ],
    "headline": { "title": "Sermon title (or empty string)", "reference": "e.g. Matthew 5:1–2" },
    "scripture": {
      "verse": "Paste the full scripture verse text here",
      "reference": "e.g. John 3:16",
      "sermonTitle": "Sermon title (or empty string if none)",
      "sermonSeries": "Series name (or empty string if none)"
    },
    "announcements": [
      {
        "title": "Announcement title",
        "body": "Announcement body text",
        "ctas": [
          { "label": "Button label e.g. Register", "url": "https://example.com" }
        ]
      }
    ],
    "savetheDates": [
      {
        "title": "Event name",
        "date": "YYYY-MM-DD",
        "time": "e.g. 6:00 PM",
        "description": "Brief description of the event",
        "ctas": []
      }
    ],
    "thisWeek": [
      {
        "title": "Ministry or activity name",
        "day": "Sunday",
        "time": "e.g. 9:00 AM",
        "location": "e.g. Room 201 (optional, use empty string if none)",
        "description": "Optional description (use empty string if none)",
        "ctas": []
      }
    ]
  };
  const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'bulletin-template.json';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
});

// ============================================================
// Scripture image widget (singleton — mounted once on load)
// ============================================================
scriptureImgWidget = makeImageUpload('img-preview-aspect--1x1', '1:1 square · 800×800 · max 500 KB', 'sermon', '#EEE8DC', () => {
  renderScripturePreview();
  scheduleDraftSave();
});
document.getElementById('scripture-img-widget-mount').appendChild(scriptureImgWidget);
