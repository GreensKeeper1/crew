/**
 * Crew Films comments: the online service (Google Apps Script + a Google Sheet).
 *
 * Free, runs on the owner's own Google account, stores everything in one Sheet
 * the owner can read and edit, and emails the owner from their own Gmail when
 * someone signs up. Speaks the same API as server/crew_server.py.
 *
 * Setup (see server/README.md for the click-by-click):
 *   1. Make a new Google Sheet, then Extensions > Apps Script, paste this file.
 *   2. Project Settings > Script Properties:
 *        PEPPER      = the "pepper" from server/crew.conf.json (or any 64 random hex chars)
 *        OWNER_EMAIL = where sign-up notices go
 *        SYNC_KEY    = a long random string, also put in crew.conf.json as sync_key
 *        NOTIFY      = on   (anything else, or missing, means no emails are sent)
 *   3. Run setup() once from the editor and accept Google's permission prompt.
 *   4. Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 *      Paste the /exec URL into comments/config.js and crew.conf.json (online_api).
 *
 * Moderation: put TRUE in a comment's "hidden" column and it disappears
 * everywhere (the show server picks that up on its next sync).
 */

var MAX_TRIES = 5;              // wrong codes per email before a lock
var LOCK_SECS = 15 * 60;
var GLOBAL_FAILS_PER_HOUR = 200; // across everyone: stops a slow sweep of all codes
var SESSION_DAYS = 365;

var SHEETS = {
  Users: ['email', 'name', 'salt', 'hash', 'created_at', 'origin', 'received_at'],
  Sessions: ['token_hash', 'email', 'expires'],
  Comments: ['id', 'item', 'email', 'name', 'text', 'at', 'received_at', 'hidden']
};

function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(function (n) {
    var sh = ss.getSheetByName(n) || ss.insertSheet(n);
    sh.getRange(1, 1, 1, SHEETS[n].length).setValues([SHEETS[n]]).setFontWeight('bold');
    sh.getRange('A:Z').setNumberFormat('@'); // keep dates, hashes and ids as plain text
    sh.setFrozenRows(1);
  });
  var p = props_();
  ['PEPPER', 'OWNER_EMAIL', 'SYNC_KEY'].forEach(function (k) {
    if (!p[k]) Logger.log('Missing Script Property ' + k);
  });
  MailApp.getRemainingDailyQuota(); // makes Google ask for the email permission now, not later
}

// ------------------------------------------------------------------ entry points
function doGet() {
  return json_({ ok: true, crew: false, service: 'crew-comments' });
}

function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = handle_(body);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: err && err.userMessage ? err.userMessage : 'Something went wrong.' };
    if (!(err && err.userMessage)) console.error(err);
  }
  return json_(out);
}

function handle_(b) {
  switch (b.op) {
    case 'counts': return counts_();
    case 'comments': return { comments: commentsFor_(item_(b.item)) };
    case 'register':
    case 'login': return auth_(b);
    case 'me': {
      var u = sessionUser_(b.token);
      if (!u) throw oops_('Please sign in again.');
      return { name: u.name };
    }
    case 'logout': {
      if (typeof b.token === 'string') deleteSession_(sha_(b.token));
      return {};
    }
    case 'post': return post_(b);
    case 'sync': return sync_(b);
  }
  throw oops_('Unknown request.');
}

// ------------------------------------------------------------------ sign-up / sign-in
function auth_(b) {
  var cache = CacheService.getScriptCache();
  var hourKey = 'gf:' + Math.floor(Date.now() / 3600000);
  if (Number(cache.get(hourKey) || 0) >= GLOBAL_FAILS_PER_HOUR)
    throw oops_('Sign-in is paused for a little while. Please try again later.');
  var email = email_(b.email), code = code_(b.code);
  var fk = 'f:' + sha_(email);
  if (Number(cache.get(fk) || 0) >= MAX_TRIES)
    throw oops_('Too many wrong codes for this email. Try again in 15 minutes.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var u = findUser_(email);
    if (!u) {
      if (b.op === 'login') throw oops_('No sign-up for that email yet. Choose Sign up instead.');
      var salt = randHex_(16);
      var name = name_(b.name, email);
      var t = iso_();
      sheet_('Users').appendRow([email, safe_(name), salt, hmac_(salt, code), t, 'online', t]);
      notify_(name, email, 'on the website', t);
      return { token: newSession_(email), name: name, 'new': true };
    }
    if (hmac_(u.salt, code) !== u.hash) {
      cache.put(fk, String(Number(cache.get(fk) || 0) + 1), LOCK_SECS);
      cache.put(hourKey, String(Number(cache.get(hourKey) || 0) + 1), 3600);
      throw oops_(b.op === 'register' ? 'That email is signed up with a different code.' : 'Wrong code for that email.');
    }
    cache.remove(fk);
    return { token: newSession_(email), name: u.name };
  } finally {
    lock.releaseLock();
  }
}

function notify_(name, email, where, when) {
  var p = props_();
  if (p.NOTIFY !== 'on' || !p.OWNER_EMAIL) return;
  MailApp.sendEmail({
    to: p.OWNER_EMAIL,
    subject: 'Crew Films: ' + name + ' signed up',
    body: name + ' (' + email + ') signed up to comment on Crew Films ' + where + ' at ' + when + ' UTC.\n\n' +
      'Their comments show under the name "' + name + '". Their email is not shown to other viewers.\n' +
      'To remove them, delete their row in the Users sheet and hide their comments.'
  });
}

// ------------------------------------------------------------------ comments
function post_(b) {
  var u = sessionUser_(b.token);
  if (!u) throw oops_('Please sign in again to comment.');
  var item = item_(b.item);
  var text = String(typeof b.text === 'string' ? b.text : '').trim().slice(0, 1000);
  if (!text) throw oops_('Write something first.');
  var cache = CacheService.getScriptCache(), rk = 'r:' + sha_(u.email);
  var n = Number(cache.get(rk) || 0);
  if (n >= 5) throw oops_('Slow down a little: 5 comments a minute at most.');
  cache.put(rk, String(n + 1), 60);
  var c = { id: Utilities.getUuid().replace(/-/g, ''), item: item, name: u.name, text: text, at: iso_() };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sheet_('Comments').appendRow([c.id, item, u.email, safe_(u.name), safe_(text), c.at, c.at, '']);
  } finally { lock.releaseLock(); }
  CacheService.getScriptCache().remove('counts');
  return { comment: c };
}

function allComments_() {
  return rows_('Comments').filter(function (c) { return c.id; });
}

function commentsFor_(item) {
  return allComments_()
    .filter(function (c) { return c.item === item && !isHidden_(c); })
    .sort(function (a, b) { return a.at < b.at ? -1 : 1; })
    .map(function (c) { return { name: c.name, text: c.text, at: c.at }; });
}

function counts_() {
  var cache = CacheService.getScriptCache(), hit = cache.get('counts');
  if (hit) return { counts: JSON.parse(hit) };
  var out = {};
  allComments_().forEach(function (c) { if (!isHidden_(c)) out[c.item] = (out[c.item] || 0) + 1; });
  cache.put('counts', JSON.stringify(out), 30);
  return { counts: out };
}

// ------------------------------------------------------------------ sync with the show server
function sync_(b) {
  var key = props_().SYNC_KEY;
  if (!key || typeof b.key !== 'string' || hmac_('sync', b.key) !== hmac_('sync', key))
    throw oops_('Not allowed.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var t = iso_();
    var users = sheet_('Users'), have = {};
    rows_('Users').forEach(function (u) { have[u.email] = true; });
    (b.users || []).slice(0, 500).forEach(function (u) {
      var email;
      try { email = email_(u.email); } catch (e) { return; }
      if (have[email] || !/^[a-f0-9]{32}$/.test(u.salt) || !/^[a-f0-9]{64}$/.test(u.hash)) return;
      var name = name_(u.name, email);
      users.appendRow([email, safe_(name), u.salt, u.hash, String(u.created_at || t), 'lan', t]);
      have[email] = true;
      notify_(name, email, 'at a home show (sent when the show box got back online)', String(u.created_at || t));
    });
    var comments = sheet_('Comments'), seen = {};
    allComments_().forEach(function (c) { seen[c.id] = true; });
    (b.comments || []).slice(0, 2000).forEach(function (c) {
      if (!/^[a-f0-9]{32}$/.test(c.id) || seen[c.id]) return;
      var item;
      try { item = item_(c.item); } catch (e) { return; }
      var text = String(c.text || '').trim().slice(0, 1000);
      if (!text) return;
      comments.appendRow([c.id, item, String(c.email || ''), safe_(String(c.name || 'Viewer').slice(0, 40)),
        safe_(text), String(c.at || t), t, '']);
      seen[c.id] = true;
    });
    CacheService.getScriptCache().remove('counts');
    var since = typeof b.since === 'string' ? b.since : '';
    // Hidden comments are sent every time, so a hide done in the Sheet reaches the show box.
    var outC = allComments_().filter(function (c) { return c.received_at > since || isHidden_(c); })
      .map(function (c) { return { id: c.id, item: c.item, name: c.name, text: c.text, at: c.at, hidden: isHidden_(c) }; });
    var outU = rows_('Users').filter(function (u) { return u.received_at > since; })
      .map(function (u) { return { email: u.email, name: u.name, salt: u.salt, hash: u.hash, created_at: u.created_at }; });
    return { users: outU, comments: outC, cursor: t };
  } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------------ sessions
function newSession_(email) {
  var tok = randHex_(32);
  sheet_('Sessions').appendRow([sha_(tok), email, String(Date.now() + SESSION_DAYS * 86400000)]);
  return tok;
}

function sessionUser_(tok) {
  if (typeof tok !== 'string' || !/^[a-f0-9]{64}$/.test(tok)) return null;
  var h = sha_(tok), now = Date.now();
  var s = rows_('Sessions').filter(function (r) { return r.token_hash === h && Number(r.expires) > now; })[0];
  return s ? findUser_(s.email) : null;
}

function deleteSession_(h) {
  var sh = sheet_('Sessions'), vals = sh.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) if (vals[i][0] === h) sh.deleteRow(i + 1);
}

// ------------------------------------------------------------------ helpers
function oops_(msg) { var e = new Error(msg); e.userMessage = msg; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function props_() { return PropertiesService.getScriptProperties().getProperties(); }
function iso_() { return new Date().toISOString(); }
function sheet_(n) { return SpreadsheetApp.getActive().getSheetByName(n); }
function isHidden_(c) { return c.hidden === true || String(c.hidden).toUpperCase() === 'TRUE'; }

function rows_(n) {
  var vals = sheet_(n).getDataRange().getValues(), head = SHEETS[n];
  return vals.slice(1).map(function (r) {
    var o = {};
    head.forEach(function (k, i) { o[k] = typeof r[i] === 'boolean' ? r[i] : String(r[i]); });
    return o;
  });
}

function findUser_(email) {
  return rows_('Users').filter(function (u) { return u.email === email; })[0] || null;
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function sha_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function hmac_(salt, code) {
  var pepper = props_().PEPPER;
  if (!pepper || pepper.length < 32) throw oops_('The comment service is not set up yet.');
  // Same as the show server: HMAC-SHA256(key = pepper, message = salt + ":" + code)
  return hex_(Utilities.computeHmacSha256Signature(salt + ':' + code, pepper, Utilities.Charset.UTF_8));
}
function randHex_(nBytes) {
  var s = '';
  while (s.length < nBytes * 2) s += sha_(Utilities.getUuid() + Utilities.getUuid() + Date.now() + Math.random());
  return s.slice(0, nBytes * 2);
}

// Stop a name or comment like "=IMPORTXML(...)" from becoming a Sheet formula.
function safe_(s) { return /^[=+\-@']/.test(s) ? "'" + s : s; }

function email_(v) {
  v = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (v.length > 254 || !/^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{2,}$/.test(v)) throw oops_('Please enter a valid email address.');
  return v;
}
function code_(v) {
  if (typeof v !== 'string' || !/^\d{6}$/.test(v)) throw oops_('The code is exactly 6 digits.');
  return v;
}
function name_(v, email) {
  v = (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return v || email.split('@')[0].slice(0, 20);
}
function item_(v) {
  if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(v)) throw oops_('Unknown item.');
  return v;
}
