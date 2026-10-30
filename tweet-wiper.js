/*
 * Tweet Wiper: mass-delete your own posts, replies and reposts on X, for free.
 *
 * Run it: open https://x.com (logged in), press F12, open Console,
 * paste this whole file, press Enter. A panel opens at the top right.
 * Guide: README.md.
 *
 * It runs only in your own browser tab and talks only to x.com, the same way
 * the X website does. Nothing is sent anywhere else, and no password or login
 * is ever asked for or stored.
 *
 * Optional tweaks: before pasting, run for example
 *   window.tweetWiperConfig = { minDelayMs: 3000 }
 *
 * MIT License. See LICENSE.
 */
(() => {
  'use strict';

  // Pasting again: keep a running panel, or swap an idle one for this version and keep what it loaded.
  const previous = window.__tweetWiper;
  if (previous) {
    if (previous.state.running) {
      previous.show();
      return;
    }
    if (previous.remove) previous.remove();
    else (document.getElementById('tweet-wiper') || { remove() {} }).remove();
    delete window.__tweetWiper;
  }

  const CONFIG = Object.assign({
    // X's internal ids for the two delete actions; looked up again from X's own code if they stop working
    queryIds: { DeleteTweet: 'VaenaVgh5q5ih7kvyVjgtg', DeleteRetweet: 'iQtK4dl5hBmXewYZuEOKVw' },
    // the public app token that x.com's own web page sends with every request (not a password)
    bearer: 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    minDelayMs: 1500,     // random pause between deletes, from this...
    maxDelayMs: 3500,     // ...to this
    stopAtRemaining: 5,   // rest once X says this few deletes are left in its 15-minute window
    batchSize: 180,       // when X sends no limit info, rest after this many deletes
    batchRestMin: 16,     // for this many minutes (X allows about 200 deletes per 15 minutes)
    timeoutMs: 20000,
    scanIdleRounds: 6,    // scrolls with nothing new before a profile scan ends
    scanRetries: 45,      // when X stops loading the profile ("Something went wrong"), retry this many times...
    scanRetryWaitMs: 60000, // ...this far apart
    anyHost: false,
  }, window.tweetWiperConfig || {});

  if (!CONFIG.anyHost && !/(^|\.)(x|twitter)\.com$/.test(location.hostname)) {
    alert('Tweet Wiper: open https://x.com, log in, and paste it there.');
    return;
  }

  // ---------- small helpers ----------

  // Timers run in a worker so Chrome doesn't slow the run to a crawl when the tab is in the background.
  const sleep = (() => {
    let worker = null;
    let seq = 0;
    const waiting = new Map();
    try {
      const src = 'onmessage = e => setTimeout(() => postMessage(e.data.id), e.data.ms)';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = (e) => {
        const done = waiting.get(e.data);
        waiting.delete(e.data);
        if (done) done();
      };
    } catch {
      worker = null;
    }
    return (ms) => new Promise((resolve) => {
      if (!worker) return setTimeout(resolve, ms);
      const id = ++seq;
      waiting.set(id, resolve);
      worker.postMessage({ id, ms });
    });
  })();

  const rand = (a, b) => a + Math.random() * (b - a);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const cookie = (name) => (document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)')) || [])[1] || null;
  const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '????-??-??');
  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const dur = (min) => (min < 60 ? `${Math.max(1, Math.round(min))} min` : `${(min / 60).toFixed(1)} h`);
  const snippet = (t) => (t || '').replace(/\s+/g, ' ').slice(0, 60);
  const txId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(70)))).replace(/=+$/, '');

  // Tweet ids since Nov 2010 carry their own timestamp.
  function idToMs(id) {
    try {
      const n = BigInt(id);
      return n > 29700000000n ? Number((n >> 22n) + 1288834974657n) : null;
    } catch {
      return null;
    }
  }

  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  // Archive dates look like "Wed Oct 10 20:19:24 +0000 2018".
  function parseTwDate(s) {
    const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(s || '');
    if (!m || !(m[1] in MONTHS)) {
      const t = Date.parse(s);
      return Number.isNaN(t) ? null : t;
    }
    const offset = (m[6] === '-' ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8])) * 60000;
    return Date.UTC(+m[9], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]) - offset;
  }

  // "1,234 Likes. Like" -> 1234
  function parseCount(label) {
    if (!label) return null;
    const m = /(\d[\d.,]*)\s*([KM])?/i.exec(label);
    if (!m) return 0;
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
    return Math.round(n);
  }

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    return null;
  }

  // ---------- state ----------

  const S = {
    me: null,
    items: [],          // { id, date, type: post|reply|repost|mine|unknown, likes, text, sourceId?, author? }
    source: '',
    selection: [],
    done: new Set(),    // ids deleted in earlier runs, kept in this browser
    running: false,
    paused: false,
    stop: false,
    stats: null,
    sinceRest: 0,
    clickOps: new Set(), // delete actions that fall back to clicking through X's menus
    okByOp: {},
    brokenByOp: {},
    refreshed: false,
    halted: false,
    scanTab: null,      // profile tab scrolled when X's lists can't be read directly
    scanTabs: null,     // profile tabs listed straight from X for each round
  };

  function detectMe() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = a && a.getAttribute('href');
    return href ? href.replace(/^\//, '').split(/[/?#]/)[0].toLowerCase() : null;
  }

  const storeKey = () => 'tweetWiper.done.' + S.me;
  function loadDone() {
    try {
      S.done = new Set(JSON.parse(localStorage.getItem(storeKey()) || '[]'));
    } catch {
      S.done = new Set();
    }
  }
  function saveDone() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify([...S.done]));
    } catch {}
  }

  // ---------- sources: archive file or profile scan ----------

  function parseArchive(text, name) {
    const eq = text.indexOf('=');
    const head = eq > 0 ? text.slice(0, eq) : '';
    const kind = /\.tweet_headers\./.test(head) ? 'headers' : /\.tweets?\./.test(head) ? 'tweets' : null;
    if (!kind) throw new Error("isn't a tweets file. Pick data/tweets.js (and tweets-part1.js, ... if you have them).");
    const rows = JSON.parse(text.slice(eq + 1).trim().replace(/;$/, ''));
    return rows.map((row) => {
      const t = row.tweet || row;
      const id = String(t.id_str || t.tweet_id || t.id || '');
      if (!/^\d+$/.test(id)) return null;
      const date = parseTwDate(t.created_at) ?? idToMs(id);
      if (kind === 'headers') return { id, date, type: 'unknown', likes: null, text: '' };
      const body = t.full_text || t.text || '';
      const rt = /^RT @(\w+):/.exec(body);
      const type = rt ? 'repost' : t.in_reply_to_status_id_str ? 'reply' : 'post';
      const likes = rt || !Number.isFinite(+t.favorite_count) ? null : +t.favorite_count;
      return { id, date, type, likes, text: body, author: rt ? rt[1] : undefined };
    }).filter(Boolean);
  }

  async function loadFiles(files) {
    if (S.running || !files || !files.length) return;
    S.me = S.me || detectMe();
    const all = new Map();
    const names = [];
    for (const f of files) {
      try {
        const items = parseArchive(await f.text(), f.name);
        items.forEach((it) => all.set(it.id, it));
        names.push(`${f.name} (${fmt(items.length)})`);
      } catch (e) {
        log(`${f.name}: ${e.message}`, 'err');
      }
    }
    ui.file.value = '';
    if (!all.size) return;
    S.items = sortNewest([...all.values()]);
    S.source = names.join(', ');
    describeSource();
    if (S.items.every((it) => it.type === 'unknown')) {
      log('tweet-headers.js only has ids and dates, so the type, likes and text filters keep everything they would apply to. Load tweets.js for full filtering.', 'warn');
    }
    updateCount();
  }

  const TABS = ['posts', 'replies', 'reposts'];
  const TAB_PATHS = { posts: '', replies: '/with_replies', reposts: '/reposts' };
  const TAB_LABELS = { posts: 'Posts', replies: 'Replies', reposts: 'Reposts' };

  function onOwnProfile() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (!parts[0] || parts[0].toLowerCase() !== S.me) return null;
    if (parts.length === 1) return 'posts';
    return TABS.find((t) => TAB_PATHS[t] === '/' + parts[1]) || null;
  }

  function permalinkOf(art) {
    const time = art.querySelector('time');
    const link = time && time.closest('a[href*="/status/"]');
    const m = link && /^\/([^/]+)\/status\/(\d+)/.exec(link.getAttribute('href'));
    return m ? { author: m[1].toLowerCase(), id: m[2], time } : null;
  }

  function readArticle(art) {
    const p = permalinkOf(art);
    if (!p) return null;
    const textEl = art.querySelector('[data-testid="tweetText"]');
    const like = art.querySelector('[data-testid="like"], [data-testid="unlike"]');
    const base = {
      date: Date.parse(p.time.getAttribute('datetime')) || idToMs(p.id),
      text: textEl ? textEl.innerText : '',
      likes: parseCount(like && like.getAttribute('aria-label')),
    };
    if (p.author === S.me) return { ...base, id: p.id, type: 'mine' };
    // someone else's post on your profile with a green repost button = your repost
    if (art.querySelector('[data-testid="unretweet"]') && art.querySelector('[data-testid="socialContext"]')) {
      return { ...base, id: 'rt:' + p.id, sourceId: p.id, author: p.author, type: 'repost' };
    }
    return null;
  }

  const findRetry = () => [...document.querySelectorAll('[data-testid="primaryColumn"] button, [data-testid="primaryColumn"] [role="button"]')]
    .find((b) => b.textContent.trim() === 'Retry');

  // Remember the timeline requests x.com makes for your profile tabs, so they can be replayed later
  // to list your tweets fresh from X (the page itself keeps showing a stale copy after deletes).
  const timelines = window.__tweetWiperTimelines = window.__tweetWiperTimelines || {};
  if (!window.__tweetWiperHooked) {
    window.__tweetWiperHooked = true;
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        const m = /\/graphql\/[^/]+\/(User\w+)\?/.exec(String(url));
        if (m && /Tweets|Timeline|Repl/.test(m[1])) timelines[m[1]] = String(url);
      } catch {}
      return open.apply(this, arguments);
    };
  }

  function timelineFor(tab) {
    const want = {
      posts: (n) => /Originals/.test(n) || n === 'UserTweets',
      replies: (n) => /Repl/.test(n),
      reposts: (n) => /Repost|Retweet/.test(n),
    }[tab];
    const name = Object.keys(timelines).find(want);
    return name ? timelines[name] : null;
  }

  // Walk X's timeline JSON for tweets by userId and the next-page cursor.
  // `seen` counts your tweets on the page, including ones already found from another tab.
  function readTimeline(body, userId, found) {
    let next = null;
    const onPage = new Set();
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      const L = o.legacy;
      if (L && L.id_str && L.created_at && L.user_id_str === userId) onPage.add(L.id_str);
      if (L && L.id_str && L.created_at && L.user_id_str === userId && !found.has(L.id_str)) {
        const text = L.full_text || '';
        const rt = !!L.retweeted_status_result || /^RT @/.test(text);
        const item = {
          id: L.id_str,
          date: parseTwDate(L.created_at) ?? idToMs(L.id_str),
          type: rt ? 'repost' : L.in_reply_to_status_id_str ? 'reply' : 'post',
          likes: rt ? null : Number(L.favorite_count) || 0,
          text,
        };
        // A repost is undone through the post it shares.
        const src = rt && L.retweeted_status_result && L.retweeted_status_result.result;
        const shared = src && (src.tweet || src);
        if (shared && shared.rest_id) {
          const user = shared.core && shared.core.user_results && shared.core.user_results.result;
          item.sourceId = shared.rest_id;
          item.author = (user && ((user.core && user.core.screen_name) || (user.legacy && user.legacy.screen_name))) || 'i';
        }
        found.set(L.id_str, item);
      }
      if (o.cursorType === 'Bottom' && o.value) next = o.value;
      for (const k in o) walk(o[k]);
    };
    walk(body);
    return { next, seen: onPage.size };
  }

  // List your tweets on a profile tab straight from X, page by page, into `found`.
  // Returns null if that isn't possible.
  async function fetchProfile(tab, found = new Map()) {
    if (!timelineFor(tab)) {
      await openProfile(tab);
      for (let i = 0; i < 4 && !timelineFor(tab); i++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(2500);
      }
      window.scrollTo(0, 0);
      // nothing loaded and nothing shown: the tab is simply empty
      if (!timelineFor(tab) && onOwnProfile() === tab && !document.querySelector('article[data-testid="tweet"]')) return found;
    }
    const raw = timelineFor(tab);
    if (!raw) return null;
    const url = new URL(raw, location.origin);
    let vars;
    try { vars = JSON.parse(url.searchParams.get('variables') || '{}'); } catch { return null; }
    const userId = vars.userId;
    if (!userId) return null;
    delete vars.cursor;
    vars.count = 100;
    let cursor = null;
    let pages = 0;
    let empty = 0;
    let misses = 0;
    while (!S.stop) {
      if (cursor) vars.cursor = cursor;
      url.searchParams.set('variables', JSON.stringify(vars));
      let res;
      let body = null;
      try {
        res = await fetch(url.pathname + url.search, { credentials: 'include', headers: apiHeaders(), signal: AbortSignal.timeout(CONFIG.timeoutMs) });
        body = await res.json();
      } catch {
        if (++misses > 4) return pages ? found : null;
        await sleep(misses * 3000);
        continue;
      }
      if (res.status === 429) {
        await rest(untilReset(Number(res.headers.get('x-rate-limit-reset')) || null), 'X paused listing your profile');
        continue;
      }
      if (res.status !== 200) {
        if (++misses > 4) return pages ? found : null;
        await sleep(misses * 3000);
        continue;
      }
      misses = 0;
      const { next, seen } = readTimeline(body, userId, found);
      pages++;
      empty = seen ? 0 : empty + 1;
      status(`Listing your ${tab} straight from X... ${fmt(found.size)} found`);
      if (!next || next === cursor || empty >= 3) break;
      cursor = next;
      await sleep(rand(500, 1000));
    }
    status('');
    return found;
  }

  // Open your profile from scratch (via Home, so X loads it fresh) on one of its tabs.
  async function openProfile(tab) {
    const home = document.querySelector('a[data-testid="AppTabBar_Home_Link"]');
    if (home && onOwnProfile()) {
      home.click();
      await sleep(2000);
    }
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (link) link.click();
    await waitFor(() => onOwnProfile() === 'posts', 15000);
    const suffix = TAB_PATHS[tab];
    if (suffix && onOwnProfile() === 'posts') {
      const href = `/${S.me}${suffix}`;
      const tabLink = await waitFor(() => [...document.querySelectorAll(`a[href$="${suffix}"]`)]
        .find((a) => a.getAttribute('href').toLowerCase() === href), 10000);
      if (tabLink) tabLink.click();
    }
    await waitFor(() => onOwnProfile() === tab && document.querySelector('article[data-testid="tweet"]'), 15000);
    return onOwnProfile();
  }

  // Scroll the open profile tab to the end and collect your tweets and reposts.
  async function collectProfile(tab) {
    const found = new Map();
    let idle = 0;
    let stuck = 0;
    window.scrollTo(0, 0);
    await sleep(800);
    while (!S.stop && idle < CONFIG.scanIdleRounds) {
      const before = found.size;
      for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
        const it = readArticle(art);
        if (!it || found.has(it.id)) continue;
        if (it.type === 'mine' && tab === 'posts') it.type = 'post';
        found.set(it.id, it);
      }
      if (found.size > before) stuck = 0;
      status(`Scanning your ${TAB_LABELS[tab]} tab... ${fmt(found.size)} found`);
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(rand(1500, 2500));
      const retry = findRetry();
      if (retry && stuck < CONFIG.scanRetries) {
        stuck++;
        const end = Date.now() + CONFIG.scanRetryWaitMs;
        while (!S.stop && Date.now() < end) {
          status(`X stopped loading your profile for now (${fmt(found.size)} found). Trying again in ${clock(end - Date.now())} (${stuck}/${CONFIG.scanRetries}). Stop keeps what's found.`);
          await sleep(1000);
        }
        if (!S.stop && findRetry()) findRetry().click();
        await sleep(3000);
        continue;
      }
      idle = found.size === before ? idle + 1 : 0;
    }
    status('');
    return found;
  }

  // List every tab straight from X into one set. Returns null if none of them could be listed.
  async function listProfile(tabs) {
    const found = new Map();
    let listed = 0;
    for (const tab of tabs) {
      if (S.stop) break;
      if (await fetchProfile(tab, found)) listed++;
      else log(`Couldn't list your ${tab} straight from X.`, 'warn');
    }
    return listed ? found : null;
  }

  async function scan() {
    if (S.running) return;
    S.me = S.me || detectMe();
    if (!S.me) return log("Can't tell which account is logged in. Reload x.com, log in, and paste the script again.", 'err');
    setBusy('scan');
    let found = await listProfile(TABS);
    if (found) {
      S.scanTabs = TABS;
      S.source = 'profile scan: posts, replies and reposts';
    } else {
      log("Couldn't get the lists straight from X, so scrolling the page instead.", 'warn');
      const tab = await openProfile(onOwnProfile() || 'replies');
      found = tab ? await collectProfile(tab) : new Map();
      S.scanTabs = null;
      S.scanTab = tab || 'replies';
      S.source = `profile scan, ${TAB_LABELS[S.scanTab]} tab`;
      if (tab === 'replies') log("From the Replies tab your posts and replies look the same, so they're only deleted when both Posts and Replies are ticked.", 'warn');
    }
    setBusy(null);
    S.items = sortNewest([...found.values()]);
    describeSource();
    updateCount();
  }

  const sortNewest = (list) => list.sort((a, b) => (b.date || 0) - (a.date || 0));

  function countTypes(list) {
    const c = {};
    list.forEach((it) => { c[it.type] = (c[it.type] || 0) + 1; });
    const names = { post: 'posts', reply: 'replies', repost: 'reposts', mine: 'posts/replies', unknown: 'tweets' };
    return Object.entries(c).map(([k, n]) => `${fmt(n)} ${names[k]}`).join(', ');
  }

  function describeSource() {
    const dates = S.items.map((it) => it.date).filter(Boolean);
    const span = dates.length ? ` from ${day(Math.min(...dates))} to ${day(Math.max(...dates))}` : '';
    const already = S.items.filter((it) => S.done.has(it.id)).length;
    ui.src.textContent = `Loaded ${fmt(S.items.length)}: ${countTypes(S.items)}${span}.`;
    log(`Loaded ${fmt(S.items.length)} from ${S.source}.${already ? ` ${fmt(already)} were already deleted in an earlier run and will be skipped.` : ''}`, 'good');
  }

  // ---------- filters ----------

  function readFilters() {
    const date = (v) => (v ? new Date(v + 'T00:00:00').getTime() : null);
    const keepIds = new Set();
    ui.keep.value.split(/\n/).forEach((line) => {
      const m = /status(?:es)?\/(\d+)/.exec(line) || /^\s*(\d+)\s*$/.exec(line);
      if (m) keepIds.add(m[1]);
    });
    return {
      posts: ui.posts.checked,
      replies: ui.replies.checked,
      reposts: ui.reposts.checked,
      olderThan: date(ui.older.value),
      newerThan: date(ui.newer.value),
      minLikes: ui.likes.value === '' ? null : Math.max(0, Number(ui.likes.value)),
      words: ui.words.value.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean),
      keepIds,
    };
  }

  // Why a tweet is kept, or null if it should be deleted.
  function keepReason(it, f) {
    if (f.keepIds.has(it.id) || (it.sourceId && f.keepIds.has(it.sourceId))) return 'listed';
    if (it.type === 'post' && !f.posts) return 'type';
    if (it.type === 'reply' && !f.replies) return 'type';
    if (it.type === 'repost' && !f.reposts) return 'type';
    if (it.type === 'mine' && !(f.posts && f.replies)) return 'unclear';
    if (it.type === 'unknown' && (!(f.posts && f.replies && f.reposts) || f.minLikes != null || f.words.length)) return 'unclear';
    if ((f.olderThan || f.newerThan) && !it.date) return 'unclear';
    if (f.olderThan && it.date >= f.olderThan) return 'date';
    if (f.newerThan && it.date < f.newerThan) return 'date';
    if (f.minLikes != null && it.type !== 'repost') {
      if (it.likes == null) return 'unclear';
      if (it.likes >= f.minLikes) return 'likes';
    }
    if (f.words.length && f.words.some((w) => it.text.toLowerCase().includes(w))) return 'words';
    return null;
  }

  function select() {
    const f = readFilters();
    const out = { list: [], kept: 0, unclear: 0, done: 0 };
    for (const it of S.items) {
      if (S.done.has(it.id)) { out.done++; continue; }
      const why = keepReason(it, f);
      if (!why) out.list.push(it);
      else if (why === 'unclear') out.unclear++;
      else out.kept++;
    }
    S.selection = out.list;
    return out;
  }

  function updateCount() {
    if (!S.items.length) { ui.count.textContent = 'Load your archive or scan your profile first.'; return; }
    const sel = select();
    ui.count.textContent = `Will delete ${fmt(sel.list.length)} of ${fmt(S.items.length)}`;
    ui.csv.disabled = !sel.list.length;
    if (!S.running) ui.del.disabled = !sel.list.length;
  }

  function preview() {
    if (!S.items.length) return log('Load your archive or scan your profile first.', 'warn');
    const sel = select();
    log(`Preview: ${fmt(sel.list.length)} would be deleted${sel.list.length ? ` (${countTypes(sel.list)})` : ''}. Kept by your filters: ${fmt(sel.kept)}.${sel.done ? ` Already deleted earlier: ${fmt(sel.done)}.` : ''}`, 'good');
    if (sel.unclear) log(`${fmt(sel.unclear)} kept because this source can't tell their type, date, likes or text for the filters you set.`, 'warn');
    sel.list.slice(0, 5).forEach((it) => log(`  ${day(it.date)}  ${it.type === 'mine' ? 'post/reply' : it.type}  ${snippet(it.text)}`));
    if (sel.list.length > 5) log(`  ...and ${fmt(sel.list.length - 5)} more. "Download list" saves all of them as a spreadsheet.`);
  }

  function urlOf(it) {
    return it.sourceId ? `https://x.com/${it.author}/status/${it.sourceId}` : `https://x.com/${S.me}/status/${it.id}`;
  }

  function downloadCsv() {
    const rows = [['id', 'url', 'date', 'type', 'likes', 'text']].concat(S.selection.map((it) => [
      it.sourceId || it.id, urlOf(it), it.date ? new Date(it.date).toISOString() : '', it.type, it.likes ?? '', it.text,
    ]));
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `tweet-wiper-${S.me}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  // ---------- deleting: fast path (X's own API, as the web app calls it) ----------

  const opFor = (it) => (it.type === 'repost' && it.sourceId ? 'DeleteRetweet' : 'DeleteTweet');

  function apiHeaders() {
    return {
      authorization: 'Bearer ' + CONFIG.bearer,
      'x-csrf-token': cookie('ct0') || '',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': document.documentElement.lang || 'en',
      'x-client-transaction-id': txId(),
    };
  }

  async function gql(op, variables) {
    const qid = CONFIG.queryIds[op];
    const res = await fetch(`/i/api/graphql/${qid}/${op}`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ variables, queryId: qid }),
      signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });
    let body = null;
    try { body = await res.json(); } catch {}
    const num = (name) => {
      const v = res.headers.get(name);
      return v == null ? null : Number(v);
    };
    return { status: res.status, body, remaining: num('x-rate-limit-remaining'), reset: num('x-rate-limit-reset') };
  }

  async function deleteViaApi(it) {
    const op = opFor(it);
    const vars = op === 'DeleteRetweet'
      ? { source_tweet_id: it.sourceId, dark_request: false }
      : { tweet_id: it.id, dark_request: false };
    let r;
    try {
      r = await gql(op, vars);
    } catch (e) {
      return { result: 'retry', why: e && e.name === 'TimeoutError' ? 'request timed out' : 'network error' };
    }
    const errs = (r.body && r.body.errors) || [];
    const msg = errs.map((e) => e.message).join('; ');
    const has = (code) => errs.some((e) => e.code === code);
    if (r.status === 429 || has(88)) return { ...r, result: 'ratelimit' };
    if (r.status === 401) return { ...r, result: 'auth' };
    if (has(326)) return { ...r, result: 'locked', why: msg };
    if (r.status === 403 && has(353)) return { ...r, result: 'retry', why: 'session token changed' };
    if (r.status === 400 || r.status === 404) return { ...r, result: 'api-broken', why: `HTTP ${r.status}${msg ? ' ' + msg : ''}` };
    if (r.status >= 500) return { ...r, result: 'retry', why: `X server error ${r.status}` };
    if (r.status === 200) {
      if (!errs.length) return { ...r, result: 'ok' };
      if (has(144) || has(34) || /no status found|not found|does not exist|not (re)?(tweeted|posted)/i.test(msg)) return { ...r, result: 'gone' };
      return { ...r, result: 'fail', why: msg };
    }
    return { ...r, result: 'fail', why: `HTTP ${r.status}${msg ? ' ' + msg : ''}` };
  }

  // If X renamed its delete actions, find the new ids in the scripts x.com itself loaded.
  async function refreshQueryIds() {
    const urls = [...new Set(
      [...document.querySelectorAll('script[src]')].map((s) => s.src)
        .concat(performance.getEntriesByType('resource').map((e) => e.name))
        .filter((u) => /abs\.twimg\.com\/responsive-web\/.*\.js(\?|$)/.test(u)),
    )].sort((a, b) => /\/main\./.test(b) - /\/main\./.test(a));
    const ops = Object.keys(CONFIG.queryIds);
    const seen = new Set();
    let changed = false;
    for (const u of urls.slice(0, 40)) {
      if (seen.size === ops.length) break;
      let js;
      try { js = await (await fetch(u)).text(); } catch { continue; }
      for (const op of ops) {
        const m = new RegExp(`queryId:"([\\w-]+)",operationName:"${op}"`).exec(js);
        if (!m) continue;
        seen.add(op);
        if (m[1] !== CONFIG.queryIds[op]) {
          CONFIG.queryIds[op] = m[1];
          changed = true;
        }
      }
    }
    return changed;
  }

  // ---------- deleting: slow path (clicks through X's own menus) ----------

  function findArticle(id) {
    return [...document.querySelectorAll('article[data-testid="tweet"]')].find((a) => {
      const p = permalinkOf(a);
      return p && p.id === id;
    });
  }

  async function goTo(path) {
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    await sleep(400);
  }

  async function deleteViaClicks(it) {
    const id = it.sourceId || it.id;
    await goTo(`/${it.sourceId ? it.author : S.me}/status/${id}`);
    if (it.type === 'repost') {
      const btn = await waitFor(() => {
        const art = findArticle(id) || document.querySelector('article[data-testid="tweet"]');
        return art && art.querySelector('[data-testid="unretweet"], [data-testid="retweet"]');
      }, 12000);
      if (!btn) return { result: 'fail', why: "post page didn't load" };
      if (btn.dataset.testid === 'retweet') return { result: 'gone' };
      btn.click();
      const ok = await waitFor(() => document.querySelector('[data-testid="unretweetConfirm"]'), 5000);
      if (!ok) return { result: 'fail', why: 'undo-repost menu never opened' };
      ok.click();
      await sleep(800);
      return { result: 'ok' };
    }
    const art = await waitFor(() => findArticle(id), 12000);
    if (!art) return { result: document.querySelector('[data-testid="error-detail"]') ? 'gone' : 'fail', why: "post page didn't load" };
    const caret = art.querySelector('[data-testid="caret"]');
    if (!caret) return { result: 'fail', why: 'no ... menu on the post' };
    caret.click();
    const item = await waitFor(() => document.querySelector('[role="menu"] [role="menuitem"]'), 5000);
    if (!item || item.textContent.includes('@')) {
      caret.click();
      return { result: 'fail', why: "menu has no Delete (not your post?)" };
    }
    item.click();
    const confirmBtn = await waitFor(() => document.querySelector('[data-testid="confirmationSheetConfirm"]'), 5000);
    if (!confirmBtn) return { result: 'fail', why: 'delete confirmation never opened' };
    confirmBtn.click();
    if (await waitFor(() => !findArticle(id), 6000)) return { result: 'ok' };
    const toast = (document.querySelector('[data-testid="toast"]') || {}).textContent || '';
    return { result: /limit|later/i.test(toast) ? 'ratelimit' : 'retry', why: toast || "X didn't confirm the delete" };
  }

  // ---------- the run ----------

  async function rest(ms, why) {
    const end = Date.now() + ms;
    S.sinceRest = 0;
    log(`${why}. Resting ${Math.ceil(ms / 60000)} min, then it carries on by itself.`);
    while (!S.stop && Date.now() < end) {
      status(`${why}. Resuming in ${clock(end - Date.now())}`);
      await sleep(1000);
    }
    status('');
  }

  const untilReset = (reset) => (reset ? Math.max(reset * 1000 - Date.now(), 60000) : 15 * 60000) + rand(20000, 60000);

  async function pace(r) {
    if (r.remaining != null && r.reset && r.remaining <= CONFIG.stopAtRemaining) {
      return rest(untilReset(r.reset), `Near X's limit (${r.remaining} deletes left this window)`);
    }
    if (r.remaining == null && S.sinceRest >= CONFIG.batchSize) {
      return rest(CONFIG.batchRestMin * 60000 + rand(0, 90000), `Paused after ${S.sinceRest} deletes to stay under X's limit`);
    }
    await sleep(rand(CONFIG.minDelayMs, CONFIG.maxDelayMs));
  }

  async function startDelete() {
    if (S.running) return;
    S.me = S.me || detectMe();
    if (!S.me) return log("Can't tell which account is logged in. Reload x.com and log in.", 'err');
    let list = select().list.slice();
    if (!list.length) return log('Nothing to delete with these filters.', 'warn');
    const rounds = S.source.startsWith('profile');
    const more = rounds ? '\n\nAfter these it rescans your profile and keeps going, round after round, until nothing matching your filters is left.' : '';
    if (!confirm(`Permanently delete ${fmt(list.length)} from @${S.me}?\n\n${countTypes(list)}${more}\n\nThis can't be undone.`)) return;

    S.sinceRest = 0;
    setBusy('delete');
    keepAwake(true);
    log(`Deleting ${fmt(list.length)}. Keep this tab open. It slows down on its own before X's limit (about 200 per 15 min).`, 'good');
    const total = { ok: 0, gone: 0, fail: 0 };
    for (let round = 1; list.length; round++) {
      const r = await runList(list);
      total.ok += r.ok;
      total.gone += r.gone;
      total.fail += r.fail;
      if (S.stop || r.halted || !rounds) break;
      if (!r.ok) {
        log("Nothing could be deleted in that round, so it stopped here.", 'warn');
        break;
      }
      log(`Round ${round} done (${fmt(r.ok)} deleted). Rescanning your profile for more...`, 'good');
      let found = S.scanTabs ? await listProfile(S.scanTabs) : null;
      if (!found && !S.stop) {
        const tab = await openProfile(S.scanTab || 'replies');
        if (!tab) {
          log("Couldn't reopen your profile for the next round. Open it, press Scan, then Delete.", 'err');
          break;
        }
        found = await collectProfile(tab);
      }
      if (S.stop) break;
      S.items = sortNewest([...found.values()]);
      list = select().list.slice();
      log(list.length ? `Round ${round + 1}: ${fmt(list.length)} more found.` : 'Rescan found nothing left to delete.', 'good');
    }

    keepAwake(false);
    log(`${S.stop ? 'Stopped' : 'All done'}. Deleted ${fmt(total.ok)}, already gone ${fmt(total.gone)}, failed ${fmt(total.fail)}.${total.fail ? ' Press Delete again to retry the failed ones.' : ''}`, total.fail ? 'warn' : 'good');
    if (!S.stop && rounds) log('If your profile still shows old posts, reload x.com, paste the script and Scan again: X sometimes hides older ones until a fresh load.');
    setBusy(null);
    status('');
    updateCount();
  }

  async function runList(list) {
    S.stats = { total: list.length, ok: 0, gone: 0, fail: 0, start: Date.now() };
    S.halted = false;
    render();
    let retries = 0;
    let failStreak = 0;
    for (let i = 0; i < list.length && !S.stop;) {
      while (S.paused && !S.stop) await sleep(300);
      if (S.stop) break;
      const it = list[i];
      const op = opFor(it);
      let r = S.clickOps.has(op) ? await deleteViaClicks(it) : await deleteViaApi(it);

      if (r.result === 'api-broken') {
        S.brokenByOp[op] = (S.brokenByOp[op] || 0) + 1;
        if (S.okByOp[op] && S.brokenByOp[op] < 3) {
          r = { result: 'fail', why: r.why };
        } else if (!S.refreshed) {
          S.refreshed = true;
          log(`X turned down the request (${r.why}). Looking up X's current request ids...`, 'warn');
          log((await refreshQueryIds()) ? 'Found new ids. Trying again.' : 'No new ids found. Trying once more.');
          continue;
        } else {
          S.clickOps.add(op);
          log(`The fast way isn't working (${r.why}). Switching to clicking through X's menus: slower, same result.`, 'warn');
          continue;
        }
      }
      if (r.result === 'auth') {
        log("X says you're logged out. Log in, reload x.com, paste the script and press Delete again. Finished ones are remembered.", 'err');
        S.halted = true;
        break;
      }
      if (r.result === 'locked') {
        log(`X locked the account for a check (${r.why}). Open x.com in a new tab, pass the check, wait an hour, then press Delete again.`, 'err');
        S.halted = true;
        break;
      }
      if (r.result === 'ratelimit') {
        await rest(untilReset(r.reset), 'X rate limit reached');
        retries = 0;
        continue;
      }
      if (r.result === 'retry') {
        if (++retries <= 5) {
          await sleep(retries * 5000);
          continue;
        }
        r = { result: 'fail', why: r.why };
      }

      retries = 0;
      if (r.result === 'ok' || r.result === 'gone') {
        S.done.add(it.id);
        if (r.result === 'ok') {
          S.stats.ok++;
          S.sinceRest++;
          S.okByOp[op] = (S.okByOp[op] || 0) + 1;
          S.brokenByOp[op] = 0;
        } else {
          S.stats.gone++;
        }
        failStreak = 0;
        if ((S.stats.ok + S.stats.gone) % 10 === 0) saveDone();
      } else {
        S.stats.fail++;
        failStreak++;
        log(`Couldn't delete ${urlOf(it)}: ${r.why || 'unknown error'}`, 'warn');
        if (failStreak >= 15) {
          S.paused = true;
          ui.pause.textContent = 'Resume';
          log('15 failures in a row, so it paused. Check x.com in another tab, then press Resume.', 'err');
        }
      }
      i++;
      render();
      await pace(r);
    }

    saveDone();
    if (S.clickOps.size) await goTo('/' + S.me);
    return { ok: S.stats.ok, gone: S.stats.gone, fail: S.stats.fail, halted: S.halted };
  }

  function render() {
    const s = S.stats;
    if (!s) return;
    const n = s.ok + s.gone + s.fail;
    ui.bar.max = s.total;
    ui.bar.value = n;
    const mins = (Date.now() - s.start) / 60000;
    const left = n > 5 ? ` · about ${dur(((s.total - n) / n) * mins)} left` : '';
    ui.stats.textContent = `${fmt(n)} / ${fmt(s.total)} · deleted ${fmt(s.ok)} · gone ${fmt(s.gone)} · failed ${fmt(s.fail)}${left}`;
  }

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (S.running && document.visibilityState === 'visible') keepAwake(true);
  });
  window.addEventListener('beforeunload', (e) => {
    if (!S.running) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------- panel ----------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: min(352px, calc(100vw - 24px)); max-height: calc(100vh - 24px); display: flex; flex-direction: column; background: #0f1419; color: #e7e9ea; border: 1px solid #2f3336; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,.55); font: 13px/1.45 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif; overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2f3336; }
    header b { font-size: 15px; }
    .who { color: #71767b; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon { background: none; border: 0; color: #71767b; font: 18px/1 inherit; padding: 2px 7px; border-radius: 999px; cursor: pointer; }
    .icon:hover { background: #1d1f23; color: #e7e9ea; }
    .body { overflow: auto; padding: 0 12px 12px; }
    .panel.min .body { display: none; }
    .panel.min header { border-bottom: 0; }
    section { padding: 10px 0; border-bottom: 1px solid #2f3336; }
    section:last-child { border-bottom: 0; padding-bottom: 0; }
    h3 { margin: 0 0 6px; font-size: 13px; font-weight: 700; }
    p { margin: 6px 0 0; }
    .hint { color: #71767b; font-size: 12px; }
    .row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .row > button { flex: 1; }
    button.btn { font: inherit; font-weight: 700; padding: 7px 12px; border-radius: 999px; border: 1px solid #536471; background: transparent; color: #e7e9ea; cursor: pointer; }
    button.btn:hover:not(:disabled) { background: #1d1f23; }
    button.primary { background: #e7e9ea; color: #0f1419; border-color: #e7e9ea; }
    button.primary:hover:not(:disabled) { background: #d7dbdc; }
    button.danger { background: #f4212e; border-color: #f4212e; color: #fff; }
    button.danger:hover:not(:disabled) { background: #dc1e29; }
    button:disabled { opacity: .4; cursor: default; }
    button.link { flex: 0 0 auto; background: none; border: 0; padding: 0; color: #1d9bf0; font: inherit; font-size: 12px; cursor: pointer; }
    button.link:disabled { color: #71767b; }
    .checks { gap: 14px; }
    .checks label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
    .field { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
    .stack { display: block; margin-top: 8px; }
    input, textarea { font: inherit; color: #e7e9ea; background: #000; border: 1px solid #333639; border-radius: 6px; padding: 4px 6px; }
    .field input { width: 150px; }
    textarea { width: 100%; margin-top: 4px; resize: vertical; }
    input:focus, textarea:focus { outline: none; border-color: #1d9bf0; }
    input[type=checkbox] { accent-color: #1d9bf0; margin: 0; }
    input[type=date] { color-scheme: dark; }
    .count { font-weight: 700; margin-top: 10px; }
    progress { width: 100%; height: 6px; margin-top: 10px; accent-color: #f4212e; }
    .stats { font-variant-numeric: tabular-nums; }
    .status { color: #1d9bf0; min-height: 1.45em; }
    .log { margin-top: 8px; max-height: 160px; overflow: auto; background: #000; border: 1px solid #2f3336; border-radius: 8px; padding: 6px 8px; font: 11px/1.45 ui-monospace, Consolas, monospace; color: #8b98a5; white-space: pre-wrap; word-break: break-word; }
    .log .warn { color: #ffd400; }
    .log .err { color: #f4212e; }
    .log .good { color: #00ba7c; }
    .hidden { display: none; }
  `;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  const ui = {};
  let host;

  function log(msg, level) {
    console.log('[Tweet Wiper]', msg);
    if (!ui.log) return;
    const t = new Date().toTimeString().slice(0, 5);
    ui.log.append(h('div', { class: level || '' }, `${t}  ${msg}`));
    while (ui.log.childElementCount > 300) ui.log.firstElementChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function status(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function setBusy(mode) {
    S.running = mode === 'delete';
    S.stop = false;
    S.paused = false;
    const busy = !!mode;
    [ui.load, ui.scan, ui.prev, ui.del, ui.forget].forEach((b) => { b.disabled = busy; });
    ui.pause.disabled = mode !== 'delete';
    ui.pause.textContent = 'Pause';
    ui.stopBtn.disabled = !busy;
    ui.bar.classList.toggle('hidden', mode !== 'delete' && !S.stats);
    ui.del.textContent = mode === 'delete' ? 'Running...' : 'Delete';
    ui.count.style.color = mode === 'delete' ? '#00ba7c' : '';
    if (mode === 'delete') ui.count.textContent = 'Running by itself. Nothing to click: just leave this tab open.';
    if (!busy) updateCount();
  }

  function check(label, checked) {
    const input = h('input', { type: 'checkbox', checked, onchange: updateCount });
    return [input, h('label', {}, input, label)];
  }

  function buildUI() {
    host = h('div', { id: 'tweet-wiper' });
    const root = host.attachShadow({ mode: 'open' });
    root.append(h('style', {}, CSS));

    ui.file = h('input', { type: 'file', accept: '.js', multiple: true, class: 'hidden', onchange: (e) => loadFiles(e.target.files) });
    ui.load = h('button', { class: 'btn primary', onclick: () => ui.file.click() }, 'Load archive file');
    ui.scan = h('button', { class: 'btn', onclick: scan }, 'Scan my profile');
    ui.src = h('p', { class: 'hint' }, 'Nothing loaded yet.');

    const [posts, postsL] = check('Posts', true);
    const [replies, repliesL] = check('Replies', true);
    const [reposts, repostsL] = check('Reposts', true);
    Object.assign(ui, { posts, replies, reposts });
    ui.older = h('input', { type: 'date', oninput: updateCount });
    ui.newer = h('input', { type: 'date', oninput: updateCount });
    ui.likes = h('input', { type: 'number', min: 0, placeholder: 'off', oninput: updateCount });
    ui.words = h('input', { type: 'text', placeholder: 'word, another', oninput: updateCount });
    ui.keep = h('textarea', { rows: 2, placeholder: 'https://x.com/you/status/123...', oninput: updateCount });
    ui.count = h('p', { class: 'count' }, 'Load your archive or scan your profile first.');

    ui.prev = h('button', { class: 'btn', onclick: preview }, 'Preview');
    ui.del = h('button', { class: 'btn danger', disabled: true, onclick: startDelete }, 'Delete');
    ui.pause = h('button', { class: 'btn', disabled: true, onclick: () => {
      S.paused = !S.paused;
      ui.pause.textContent = S.paused ? 'Resume' : 'Pause';
      status(S.paused ? 'Paused' : '');
    } }, 'Pause');
    ui.stopBtn = h('button', { class: 'btn', disabled: true, onclick: () => { S.stop = true; status('Stopping...'); } }, 'Stop');
    ui.bar = h('progress', { class: 'hidden', value: 0, max: 1 });
    ui.stats = h('p', { class: 'stats' });
    ui.status = h('p', { class: 'status' });
    ui.log = h('div', { class: 'log' });
    ui.csv = h('button', { class: 'link', disabled: true, onclick: downloadCsv }, 'Download list (CSV)');
    ui.forget = h('button', { class: 'link', onclick: () => {
      if (!confirm('Forget which tweets were already deleted in this browser? They will be tried again next run.')) return;
      S.done.clear();
      saveDone();
      log('Progress cleared.');
      updateCount();
    } }, 'Forget progress');

    ui.who = h('span', { class: 'who' }, S.me ? '@' + S.me : 'not logged in?');
    const panel = h('div', { class: 'panel' },
      h('header', {},
        h('b', {}, 'Tweet Wiper'), ui.who,
        h('button', { class: 'icon', title: 'Minimize', onclick: () => panel.classList.toggle('min') }, '–'),
        h('button', { class: 'icon', title: 'Close', onclick: close }, '×')),
      h('div', { class: 'body' },
        h('section', {},
          h('h3', {}, '1. Load your tweets'),
          h('div', { class: 'row' }, ui.load, ui.scan), ui.file, ui.src,
          h('p', { class: 'hint' }, 'Scan lists your posts, replies and reposts straight from X. The archive file (data/tweets.js from your X data download) also covers old posts X no longer shows on your profile.')),
        h('section', {},
          h('h3', {}, '2. Choose what goes'),
          h('div', { class: 'row checks' }, postsL, repliesL, repostsL),
          h('label', { class: 'field' }, 'Only older than', ui.older),
          h('label', { class: 'field' }, 'Only newer than', ui.newer),
          h('label', { class: 'field' }, 'Keep if likes at least', ui.likes),
          h('label', { class: 'field' }, 'Keep if text contains', ui.words),
          h('label', { class: 'stack' }, 'Never delete these (links, one per line)', ui.keep),
          ui.count),
        h('section', {},
          h('h3', {}, '3. Delete'),
          h('div', { class: 'row' }, ui.prev, ui.del),
          h('div', { class: 'row' }, ui.pause, ui.stopBtn),
          ui.bar, ui.stats, ui.status, ui.log,
          h('div', { class: 'row' }, ui.csv, ui.forget))));
    ui.panel = panel;
    root.append(panel);
    document.body.append(host);
  }

  function close() {
    if (S.running && !confirm('A run is going. Stop it and close?')) return;
    S.stop = true;
    host.remove();
    delete window.__tweetWiper;
  }

  // ---------- start ----------

  S.me = detectMe();
  if (S.me) loadDone();
  buildUI();
  window.__tweetWiper = {
    show: () => { if (!host.isConnected) document.body.append(host); ui.panel.classList.remove('min'); },
    remove: () => { S.stop = true; host.remove(); delete window.__tweetWiper; },
    state: S,
    config: CONFIG,
    ui,
  };
  log(S.me
    ? `Logged in as @${S.me}. Load your archive file or scan your profile, check Preview, then Delete.`
    : "Can't see who's logged in yet. If you are logged in, wait for x.com to finish loading and paste again.", S.me ? 'good' : 'warn');
  if (S.me && S.done.size) log(`${fmt(S.done.size)} deletes from earlier runs are remembered and will be skipped.`);
  const carried = previous && previous.state;
  if (carried && carried.items && carried.items.length && carried.me === S.me) {
    S.items = carried.items;
    S.source = carried.source;
    S.scanTab = carried.scanTab || (/Replies/.test(carried.source) ? 'replies' : 'posts');
    S.scanTabs = carried.scanTabs || null;
    describeSource();
    updateCount();
  }
})();
