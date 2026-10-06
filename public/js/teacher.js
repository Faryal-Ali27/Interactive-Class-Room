(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var icon = window.icon, icoHtml = window.icoHtml;
  var RX = { like: 'thumbs-up', love: 'heart', idea: 'lightbulb', smile: 'smile', wow: 'zap' };

  /* ---- helpers ---- */
  function rankRow(r, i) {
    var d = document.createElement('div'); d.className = 'lb';
    var w = document.createElement('span'); w.className = 'who';
    var k = document.createElement('span'); k.className = 'rank r' + (i + 1); k.textContent = i + 1;
    w.appendChild(k); w.appendChild(document.createTextNode(r.name)); d.appendChild(w);
    var b = document.createElement('b'); b.textContent = r.pts; d.appendChild(b);
    return d;
  }
  var el = function (t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };
  var STARS = ['1 star', '2 stars', '3 stars', '4 stars', '5 stars'];
  var TYPES = [
    ['mcq',    'list-checks',  'Multiple choice'],
    ['tf',     'check-square', 'True / False'],
    ['poll',   'bar-chart',    'Poll'],
    ['rating', 'star',         'Rating'],
    ['cloud',  'cloud',        'Word cloud'],
    ['text',   'pencil',       'Open text']
  ];
  var ICON = {}; TYPES.forEach(function (t) { ICON[t[0]] = t[1]; });

  /* ---- persistent browser storage (teacher login, open session, queue, drafts) ---- */
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var tkey = LS.get('cp-tkey') || '', tname = LS.get('cp-tname') || '', code = LS.get('cp-code') || '';
  var type = 'mcq', deadline = 0, cur = null, last = null, hideNames = false;
  var queue = [], queueSynced = false, pollT = null, busy = false, fails = 0;
  function loadQueue() { try { queue = JSON.parse(LS.get('cp-queue:' + code) || '[]'); } catch (e) { queue = []; } }
  var isLocal = /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname);

  /* ---- toast ---- */
  function toast(m) {
    var t = $('toast'); t.textContent = m; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  /* ---- API ---- */
  function raw(p, b) {
    return fetch('/api/' + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ code: code, tkey: tkey }, b || {}))
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; });
    });
  }
  function api(p, b) {
    return raw(p, b).then(function (j) {
      if (j._status >= 400) toast(j.error || 'Something went wrong');
      if (code) poll();
      return j;
    }).catch(function () { toast('Connection lost — your data is saved, retrying…'); });
  }
  function saveQ() {
    LS.set('cp-queue:' + code, JSON.stringify(queue));
    renderQueue();
    raw('queue', { queue: queue }).catch(function () {});
  }

  /* ---- Mobile sidebar ---- */
  var sidebar = $('sidebar'), overlay = $('sideOverlay');
  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
    document.body.style.overflow = '';
  }
  $('menuToggle').onclick = openSidebar;
  overlay.onclick = closeSidebar;

  /* ---- Screens: login -> my sessions -> session dashboard ---- */
  function screen(n) {
    $('startbar').hidden = n === 'app'; $('app').hidden = n !== 'app';
    $('login').hidden = n !== 'login'; $('sessions').hidden = n !== 'sessions';
    var li = n !== 'login';
    $('whoChip').hidden = !li; $('signOut').hidden = !li; if (li) $('whoChip').textContent = tname;
  }
  function login() {
    var n = $('tName').value.trim(), p = $('tPin').value;
    $('loginErr').textContent = '';
    if (!n) { $('loginErr').textContent = 'Enter your name'; return; }
    if (p.length < 4) { $('loginErr').textContent = 'PIN must be at least 4 characters'; return; }
    $('loginBtn').disabled = true;
    fetch('/api/t/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, pin: p }) })
      .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (r) {
        $('loginBtn').disabled = false;
        if (r.s !== 200) { $('loginErr').textContent = r.j.error || 'Sign in failed'; return; }
        tkey = r.j.tkey; tname = r.j.name; LS.set('cp-tkey', tkey); LS.set('cp-tname', tname);
        $('tPin').value = ''; showSessions();
        if (r.j.created) toast('Welcome, ' + tname + '! Remember your name and PIN.');
      })
      .catch(function () { $('loginBtn').disabled = false; $('loginErr').textContent = 'No connection to the server'; });
  }
  function signOut() {
    clearInterval(pollT); code = ''; tkey = ''; tname = '';
    LS.del('cp-tkey'); LS.del('cp-tname'); LS.del('cp-code');
    $('tName').value = ''; screen('login');
  }
  function showSessions() {
    clearInterval(pollT); code = ''; last = null; LS.del('cp-code');
    screen('sessions');
    var d = new Date(); $('nDate').value = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    fetch('/api/health').then(function (r) { return r.json(); }).then(function (h) {
      var w = $('storeWarn');
      if (h.storage === 'memory' && !isLocal) {
        w.hidden = false;
        w.textContent = 'Storage is not connected on this server, so sessions will disappear when it restarts. Add a free Upstash Redis database (see README) to keep all data.';
      } else w.hidden = true;
    }).catch(function () {});
    loadSessions();
  }
  function loadSessions() {
    fetch('/api/t/sessions?tkey=' + encodeURIComponent(tkey)).then(function (r) {
      if (r.status === 401) { signOut(); return null; }
      return r.json();
    }).then(function (j) {
      if (!j) return;
      var w = $('sessList'); w.innerHTML = '';
      $('sessEmpty').hidden = j.sessions.length > 0;
      j.sessions.forEach(function (x) {
        var r = el('div', 'sess-item'), info = el('div', 'info');
        info.appendChild(el('b', '', x.title));
        var tm = x.start ? x.start + (x.end ? '–' + x.end : '') : '';
        info.appendChild(el('span', '', [x.cls, x.date, tm].filter(Boolean).join(' · ') || 'No class details'));
        r.appendChild(info);
        r.appendChild(el('span', 'scode', x.code));
        r.appendChild(el('span', 'tag' + (x.ended ? '' : ' ok'), x.ended ? 'Ended' : 'Active'));
        var acts = el('div', 'acts');
        var o = el('button', 'sm', 'Open'); o.onclick = function () { openSession(x.code); };
        var d = el('button', 'ghost sm'); d.appendChild(icon('trash', 14)); d.title = 'Delete session';
        d.onclick = function () {
          if (!confirm('Delete "' + x.title + '" and all its data? This cannot be undone.')) return;
          code = x.code;
          raw('t/delete').then(function () { LS.del('cp-queue:' + x.code); LS.del('cp-draft:' + x.code); code = ''; loadSessions(); });
        };
        acts.appendChild(o); acts.appendChild(d); r.appendChild(acts); w.appendChild(r);
      });
    }).catch(function () { toast('Could not load sessions'); });
  }
  function createSession() {
    var b = $('startBtn'); b.disabled = true;
    var st = $('nStart').value, en = $('nEnd').value;
    if (st && en && en <= st) { toast('End time must be after start time'); b.disabled = false; return; }
    code = '';
    raw('create', { title: $('nTitle').value, cls: $('nCls').value, date: $('nDate').value, start: st, end: en })
      .then(function (r) {
        b.disabled = false;
        if (!r.code) { toast(r.error || 'Could not create session'); return; }
        $('nTitle').value = ''; $('nCls').value = ''; $('nStart').value = ''; $('nEnd').value = '';
        openSession(r.code);
      }).catch(function () { b.disabled = false; toast('Could not create session — is the server running?'); });
  }
  function openSession(c) {
    code = c; LS.set('cp-code', c); loadQueue(); queueSynced = false; last = null; $('demoBanner').hidden = true;
    connect();
  }
  var studentUrl = '', curView = 'home';
  function hms(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
  function dur(sec) { if (sec === null || sec === undefined) return '—'; var m = Math.floor(sec / 60), s = Math.round((sec - m * 60) * 10) / 10; return m ? m + 'm ' + (s < 10 ? '0' : '') + s + 's' : s + 's'; }
  function copyText(t, msg) {
    var done = function () { toast(msg); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () { prompt('Copy:', t); });
    else prompt('Copy:', t);
  }
  /* QR points to the student page only. The room code is NOT inside the QR: students type it themselves. */
  function makeQR() { var q = qrcode(0, 'M'); q.addData(studentUrl); q.make(); return q; }
  function drawQR() {
    if (!studentUrl || typeof qrcode !== 'function') return;
    var q = makeQR(), svg = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    $('qrBox').innerHTML = svg; $('qrBigBox').innerHTML = svg;
    $('qrBigCode').textContent = code; $('qrBigUrl').textContent = studentUrl;
  }
  function downloadQR() {
    if (!studentUrl) return;
    var q = makeQR(), n = q.getModuleCount(), px = 12, m = 4, size = (n + 2 * m) * px, cv = document.createElement('canvas');
    cv.width = cv.height = size; var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + m) * px, (r + m) * px, px, px);
    cv.toBlob(function (b) { var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'classpulse-join-qr.png'; a.click(); });
  }
  function connect() {
    screen('app');
    $('code').textContent = code; $('chipCode').textContent = code; $('chipCodeMob').textContent = code;
    $('qtext').value = LS.get('cp-draft:' + code) || '';
    fetch('/api/info').then(function (r) { return r.json(); }).then(function (i) {
      studentUrl = (isLocal ? i.urls[0] : location.origin) + '/student';
      $('url').textContent = studentUrl; drawQR();
    });
    renderQueue(); show('home');
    try { var c = JSON.parse(LS.get('cp-last-t:' + code) || 'null'); if (c) { last = c; render(c); } } catch (e) {}
    poll(); clearInterval(pollT); pollT = setInterval(poll, 1500);
  }
  function poll() {
    if (!code || busy) return; busy = true;
    fetch('/api/state?role=teacher&code=' + encodeURIComponent(code) + '&tkey=' + encodeURIComponent(tkey) + (curView === 'report' || curView === 'students' ? '&full=1' : ''), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404 || r.status === 403) { toast('Session not found'); showSessions(); return; }
        return r.json().then(function (v) {
          fails = 0; last = v; LS.set('cp-last-t:' + code, JSON.stringify(v));
          if (!queueSynced) { // first load: the server copy wins, else upload the local one
            queueSynced = true;
            if (v.queue && v.queue.length) { queue = v.queue; LS.set('cp-queue:' + code, JSON.stringify(queue)); }
            else if (queue.length) raw('queue', { queue: queue }).catch(function () {});
            renderQueue();
          }
          render(v);
        });
      })
      .catch(function () { if (++fails === 2) toast('Connection lost — your data is safe. Reconnecting…'); })
      .then(function () { busy = false; });
  }
  function toggleEnd() {
    if (!last) return;
    if (last.ended) { api('t/status', { ended: false }).then(function () { toast('Session reopened'); }); return; }
    if (confirm('End this session? Students will be locked out. All data is kept and you can reopen it later.'))
      api('t/status', { ended: true }).then(function () { toast('Session ended'); });
  }

  /* ---- DEMO MODE ---- */
  function startDemo() {
    var b = $('demoBtn'); b.disabled = true; code = '';
    raw('create', { title: 'Demo session', cls: 'Sample class' }).then(function (r) {
      b.disabled = false;
      if (!r.code) { toast('Could not start demo'); return; }
      openSession(r.code);
      var names = ['Ali', 'Sara', 'Ahmed', 'Zara', 'Omar', 'Hina'];
      var sids = names.map(function () { return Math.random().toString(36).slice(2, 10); });
      Promise.all(names.map(function (n, i) { return raw('demo-join', { sid: sids[i], name: n }); })).then(function () {
        $('demoBanner').hidden = false;
        return raw('question', { text: 'Which of the following is a renewable energy source?', type: 'mcq', options: ['Coal', 'Solar power', 'Natural gas', 'Petroleum'], correct: 1, dur: 0 });
      }).then(function () {
        show('live'); toast('Demo active! 6 students connected & answering…');
        [1, 1, 2, 1, 0, 1].forEach(function (choice, i) { setTimeout(function () { raw('answer', { sid: sids[i], choice: choice }); }, 400 + i * 300); });
        setTimeout(function () { raw('pace', { sid: sids[0], value: 'ok' }); }, 1200);
        setTimeout(function () { raw('pace', { sid: sids[1], value: 'fast' }); }, 1400);
        setTimeout(function () { raw('confused', { sid: sids[4], on: true }); }, 1700);
        setTimeout(function () { raw('ask', { sid: sids[2], text: 'Can you explain why solar is considered renewable?' }); }, 2200);
      });
    }).catch(function () { b.disabled = false; toast('Demo needs the server running. Run: node server.js'); });
  }

  /* ---- Composer ---- */
  function buildTypes() {
    var w = $('types'); w.innerHTML = '';
    TYPES.forEach(function (t) {
      var b = el('button', 'ghost');
      b.appendChild(icon(t[1], 20));
      b.appendChild(el('span', '', t[2]));
      b.dataset.k = t[0];
      b.onclick = function () { setType(t[0]); };
      w.appendChild(b);
    });
  }
  function setType(t) {
    type = t;
    Array.prototype.forEach.call(document.querySelectorAll('#types button'), function (b) {
      b.classList.toggle('on', b.dataset.k === t);
    });
    var o = $('opts'); o.innerHTML = '';
    if (t === 'rating' || t === 'cloud' || t === 'text') {
      var desc = t === 'rating' ? 'Students rate 1–5 stars.' :
                 t === 'cloud'  ? 'Students type a short word or phrase; a live word cloud appears.' :
                                  'Students type a short written answer.';
      o.appendChild(el('p', 'mute', desc)); return;
    }
    var defs = t === 'mcq' ? ['', '', '', ''] : t === 'tf' ? ['True', 'False'] : ['Got it', 'Somewhat', 'Lost me'];
    defs.forEach(function (d, i) {
      var r = el('div', 'opt');
      if (t !== 'poll') {
        var rd = el('input'); rd.type = 'radio'; rd.name = 'c'; rd.checked = (i === 0); rd.title = 'Mark as correct answer'; r.appendChild(rd);
      }
      var inp = el('input'); inp.type = 'text'; inp.value = d; inp.placeholder = 'Option ' + (i + 1); inp.readOnly = (t === 'tf');
      r.appendChild(inp); o.appendChild(r);
    });
    if (t !== 'poll') o.appendChild(el('p', 'mute', 'Click the radio button next to the correct answer.'));
  }
  function gather() {
    var text = $('qtext').value.trim();
    if (!text) { toast('Type a question first'); return null; }
    var options = [], correct = null;
    if (type === 'rating') options = STARS.slice();
    else if (type === 'mcq' || type === 'tf' || type === 'poll') {
      Array.prototype.forEach.call(document.querySelectorAll('#opts .opt'), function (r) {
        var v = r.querySelector('input[type=text]').value.trim(); if (!v) return;
        var rd = r.querySelector('input[type=radio]'); if (rd && rd.checked) correct = options.length;
        options.push(v);
      });
      if (options.length < 2) { toast('Add at least 2 options'); return null; }
    }
    return { text: text, type: type, options: options, correct: correct, dur: +$('dur').value };
  }
  function send(item, idx) {
    var q = item || gather(); if (!q) return;
    api('question', q).then(function () {
      toast('Question sent to class ✓'); show('live');
      if (item) { queue.splice(idx, 1); saveQ(); } else { $('qtext').value = ''; LS.del('cp-draft:' + code); setType(type); }
    });
  }
  function exitTicket() {
    var items = [
      { text: "How well did you understand today's lesson?", type: 'poll', options: ['Totally got it', 'Pretty well', 'Not very well', 'Not at all'], correct: null, dur: 0 },
      { text: "What did you learn in today's class?", type: 'text', options: [], correct: null, dur: 0 },
      { text: 'What was the most confusing part today?', type: 'text', options: [], correct: null, dur: 0 }
    ];
    api('question', items[0]).then(function () {
      queue = items.slice(1).concat(queue); saveQ();
      toast('Exit ticket started · 2 more in queue'); show('live');
    });
  }
  function renderQueue() {
    var w = $('queue'); w.innerHTML = '';
    queue.forEach(function (q, i) {
      var r = el('div', 'qitem');
      var sp = el('span');
      sp.appendChild(icon(ICON[q.type] || 'list', 14));
      sp.appendChild(document.createTextNode(' ' + q.text));
      r.appendChild(sp);
      var s = el('button', 'sm', 'Send now'); s.onclick = function () { send(q, i); };
      var d = el('button', 'ghost sm'); d.appendChild(icon('trash', 14)); d.title = 'Remove';
      d.onclick = function () { queue.splice(i, 1); saveQ(); };
      r.appendChild(s); r.appendChild(d); w.appendChild(r);
    });
    $('qempty').hidden = queue.length > 0;
    $('qcount').textContent = queue.length ? '(' + queue.length + ')' : '';
    $('nextBtn').hidden = !queue.length;
    $('qb').hidden = !queue.length; $('qb').textContent = queue.length;
  }

  /* ---- Results renderer ---- */
  function drawResults(q, v) {
    var box = $('res'); box.innerHTML = '';
    if (q.type === 'cloud') {
      var cw = el('div', 'cloud'); var mx = v.res.length ? v.res[0][1] : 1;
      if (!v.res.length) cw.appendChild(el('span', 'mute', 'Waiting for words…'));
      v.res.forEach(function (r, i) {
        var s = el('span', '', r[0]);
        s.style.fontSize = (16 + r[1] / mx * 36) + 'px';
        s.style.color = 'var(--c' + (i % 5 + 1) + ')';
        cw.appendChild(s);
      });
      box.appendChild(cw); return;
    }
    if (q.type === 'text') {
      var hb = el('button', 'ghost sm', hideNames ? 'Show names' : 'Hide names');
      hb.onclick = function () { hideNames = !hideNames; render(last); }; box.appendChild(hb);
      if (!v.res.length) box.appendChild(el('p', 'mute', 'Waiting for answers…'));
      v.res.forEach(function (r) {
        var d = el('div', 'resp');
        d.appendChild(el('span', '', r[0]));
        d.appendChild(el('small', '', hideNames ? '' : r[1]));
        box.appendChild(d);
      }); return;
    }
    var tot = v.res.reduce(function (a, c) { return a + c; }, 0), t = tot || 1;
    q.options.forEach(function (o, i) {
      var pct = Math.round(v.res[i] / t * 100), isC = (v.correct === i);
      var row = el('div', 'bar-row'), lab = el('div', 'bar-label');
      var ls = el('span', '', o);
      if (isC && !q.open) { ls.appendChild(icon('check', 14)); }
      lab.appendChild(ls);
      lab.appendChild(el('b', '', v.res[i] + ' · ' + pct + '%'));
      var tr = el('div', 'track'), f = el('div', 'fill' + (!q.open && v.correct !== null ? (isC ? ' right' : ' wrong') : ''));
      f.style.width = pct + '%'; tr.appendChild(f);
      row.appendChild(lab); row.appendChild(tr); box.appendChild(row);
    });
    if (q.type === 'rating' && tot) {
      var avg = v.res.reduce(function (a, c, i) { return a + c * (i + 1); }, 0) / tot;
      box.appendChild(el('p', 'mute', 'Average: ' + avg.toFixed(1) + ' / 5'));
    }
  }
  function statusTag(s) { return s.confused ? ['Confused', 'warn'] : s.answered ? ['Answered', 'ok'] : ['Waiting', '']; }

  function render(v) {
    /* stats */
    $('sOnline').textContent = v.joined; $('sbOnline').textContent = v.total;
    $('sideTitle').textContent = v.title || 'Session';
    $('sideSub').textContent = [v.cls, v.start ? v.start + (v.end ? '–' + v.end : '') : ''].filter(Boolean).join(' · ');
    $('endedBanner').hidden = !v.ended; $('endLbl').textContent = v.ended ? 'Reopen session' : 'End session';
    $('sConf').textContent = v.confused;
    $('meter').style.width = (v.total ? v.confused / v.total * 100 : 0) + '%';
    $('sPace').textContent = v.pace.fast + ' fast · ' + v.pace.slow + ' slow · ' + (v.pace.ok || 0) + ' ok';
    var rs = Object.keys(v.reacts).map(function (k) { return icoHtml(RX[k] || 'smile', 14) + ' ' + v.reacts[k]; }).join('&nbsp;&nbsp;');
    $('sReact').innerHTML = rs || '—';

    /* live results */
    var q = v.q; cur = q; deadline = v.left !== null ? Date.now() + v.left : 0;
    $('status').hidden = !q; $('closeBtn').hidden = !(q && q.open);
    if (q) {
      $('qt').textContent = q.text;
      $('status').textContent = q.open ? 'LIVE' : 'CLOSED';
      $('status').className = 'pill ' + (q.open ? 'live' : 'closed');
      $('sAns').textContent = v.answered + '/' + v.total;
      $('answered').textContent = v.answered + ' of ' + v.total + ' answered';
      drawResults(q, v);
    }

    /* students table (everyone who joined; progress is saved) */
    var st = $('stu'); st.innerHTML = '';
    v.students.forEach(function (x) {
      var tr = el('tr'), c = !x.online ? ['Offline', ''] : statusTag(x), td = el('td'), nm = el('td');
      var dot = el('span', 'dot' + (x.online ? ' on' : '')); nm.appendChild(dot); nm.appendChild(document.createTextNode(x.name || '—'));
      td.appendChild(el('span', 'tag ' + c[1], c[0]));
      tr.appendChild(nm); tr.appendChild(td);
      tr.appendChild(el('td', '', x.done + '/' + x.of + (x.right ? ' · ' + x.right + ' correct' : '')));
      tr.appendChild(el('td', '', x.pts));
      tr.appendChild(el('td', '', hms(x.joinedAt)));
      tr.appendChild(el('td', '', hms(x.lastAt)));
      tr.appendChild(el('td', '', x.done ? dur(x.secs) + ' · ' + dur(x.avg) : '—'));
      tr.appendChild(el('td', '', !x.online ? '' : x.pace === 'fast' ? '⏩ Too fast' : x.pace === 'slow' ? '⏪ Too slow' : x.pace === 'ok' ? '✓ Just right' : ''));
      st.appendChild(tr);
    });
    $('stuEmpty').hidden = v.students.length > 0;

    /* Q&A */
    $('mod').checked = v.mod;
    var pend = v.qa.filter(function (x) { return !x.done; }).length;
    $('qn').textContent = pend; $('qn').hidden = !pend;
    var ql = $('qalist'); ql.innerHTML = '';
    $('qaEmpty').hidden = v.qa.length > 0;
    v.qa.forEach(function (x) {
      var d = el('div', 'qa' + (x.done ? ' done' : ''));
      var vb = el('span', 'votes');
      vb.appendChild(icon('chevron-up', 15));
      vb.appendChild(document.createTextNode(' ' + x.votes));
      d.appendChild(vb);
      d.appendChild(el('span', 't', x.text + (x.ok ? '' : '  ⏳ pending review')));
      if (!x.ok) { var a = el('button', 'sm', 'Approve'); a.onclick = function () { api('qa-approve', { id: x.id }); }; d.appendChild(a); }
      var m = el('button', 'ghost sm', x.done ? 'Reopen' : 'Mark answered');
      m.onclick = function () { api('qa-done', { id: x.id }); }; d.appendChild(m);
      var rm = el('button', 'ghost sm'); rm.appendChild(icon('trash', 14)); rm.title = 'Delete';
      rm.onclick = function () { api('qa-del', { id: x.id }); }; d.appendChild(rm);
      ql.appendChild(d);
    });

    /* leaderboard */
    var lb = $('lb'); lb.innerHTML = '';
    if (!v.board.length) lb.appendChild(el('p', 'mute', 'Points appear after you close a question with a correct answer.'));
    v.board.forEach(function (r, i) { lb.appendChild(rankRow(r, i)); });

    /* answer log (only sent while Report / Students is open) */
    var lg = $('logBody'); lg.innerHTML = '';
    var logRows = v.log || [];
    $('logEmpty').hidden = logRows.length > 0;
    logRows.forEach(function (r) {
      var tr = el('tr');
      [r.n, r.name, r.ans, r.ok === null ? '—' : r.ok ? '✓ Correct' : '✗ Wrong', hms(r.at), dur(r.secs)].forEach(function (t) { tr.appendChild(el('td', '', t)); });
      lg.appendChild(tr);
    });

    /* report */
    var h = $('hist'); h.innerHTML = '';
    $('histEmpty').hidden = v.history.length > 0;
    v.history.forEach(function (x, i) {
      var tr = el('tr');
      var c = x.correct === null ? '—' : x.answered ? Math.round(x.res[x.correct] / x.answered * 100) + '%' : '0%';
      [i + 1, x.text, x.answered + '/' + x.joined, c, x.confused].forEach(function (txt) { tr.appendChild(el('td', '', txt)); });
      h.appendChild(tr);
    });
  }

  /* ---- CSV Export ---- */
  function csv() {
    if (!last) return;
    var q = function (s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
    var rows = [['#', 'Question', 'Type', 'Answered', 'Online', 'Correct %', 'Confused']];
    last.history.forEach(function (h, i) {
      rows.push([i + 1, h.text, h.type, h.answered, h.joined,
        h.correct === null ? '' : (h.answered ? Math.round(h.res[h.correct] / h.answered * 100) : 0), h.confused]);
    });
    rows.push([]); rows.push(['Student', 'Questions answered', 'Correct', 'Points', 'Joined at', 'Last answer at', 'Total time (s)', 'Avg time (s)']);
    last.students.forEach(function (x) { rows.push([x.name, x.done + '/' + x.of, x.right, x.pts, x.joinedAt ? new Date(x.joinedAt).toLocaleString() : '', x.lastAt ? new Date(x.lastAt).toLocaleString() : '', x.secs, x.avg === null ? '' : x.avg]); });
    rows.push([]); rows.push(['Q#', 'Student', 'Answer', 'Result', 'Answered at', 'Time taken (s)']);
    (last.log || []).forEach(function (r) { rows.push([r.n, r.name, r.ans, r.ok === null ? '' : r.ok ? 'Correct' : 'Wrong', r.at ? new Date(r.at).toLocaleString() : '', r.secs === null ? '' : r.secs]); });
    var a = el('a');
    a.href = URL.createObjectURL(new Blob([rows.map(function (r) { return r.map(q).join(','); }).join('\n')], { type: 'text/csv' }));
    a.download = 'classpulse-' + String(last.title || 'session').replace(/[^\w]+/g, '-') + '-' + code + '.csv'; a.click();
  }

  /* ---- View navigation ---- */
  var VIEWS  = ['home', 'ask', 'live', 'queue', 'students', 'qa', 'board', 'report'];
  var TITLES = { home: 'Overview', ask: 'Ask a question', live: 'Live results', queue: 'Question queue', students: 'Students', qa: 'Q&A', board: 'Leaderboard', report: 'Report' };
  function show(v) {
    curView = v; if ((v === 'report' || v === 'students') && code) poll();
    Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (x) { x.classList.toggle('on', x.dataset.v === v); });
    VIEWS.forEach(function (n) { $('v-' + n).hidden = n !== v; });
    $('title').textContent = TITLES[v];
    window.scrollTo(0, 0);
    closeSidebar();
  }
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) {
    b.onclick = function () { show(b.dataset.v); };
  });

  /* ---- Wire up all buttons ---- */
  $('startBtn').onclick = createSession;
  $('demoBtn').onclick = startDemo;
  $('endBtn').onclick = toggleEnd;
  $('backBtn').onclick = function () { showSessions(); };
  $('loginBtn').onclick = login;
  $('tPin').onkeydown = $('tName').onkeydown = function (e) { if (e.key === 'Enter') login(); };
  $('signOut').onclick = signOut;
  $('qtext').oninput = function () { LS.set('cp-draft:' + code, $('qtext').value); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  $('sendBtn').onclick = function () { send(); };
  $('queueBtn').onclick = function () {
    var q = gather(); if (q) { queue.push(q); saveQ(); $('qtext').value = ''; LS.del('cp-draft:' + code); setType(type); toast('Added to queue'); }
  };
  $('exitBtn').onclick = exitTicket;
  $('closeBtn').onclick = function () { api('close'); };
  $('nextBtn').onclick = function () { if (queue.length) send(queue[0], 0); };
  $('csvBtn').onclick = function () {
    if (!last) return;
    fetch('/api/state?role=teacher&full=1&code=' + encodeURIComponent(code) + '&tkey=' + encodeURIComponent(tkey), { cache: 'no-store' })
      .then(function (r) { return r.json(); }).then(function (v) { last = v; csv(); }).catch(function () { csv(); });
  };
  $('copyLink').onclick = function () { copyText(studentUrl || location.origin + '/student', 'Student link copied'); };
  $('qrBig').onclick = function () { drawQR(); $('qrOverlay').hidden = false; };
  $('qrClose').onclick = function () { $('qrOverlay').hidden = true; };
  $('qrOverlay').onclick = function (e) { if (e.target === $('qrOverlay')) $('qrOverlay').hidden = true; };
  $('qrDl').onclick = downloadQR;
  $('copyCode').onclick = function () { copyText(code, 'Room code copied'); };
  $('mod').onchange = function () { api('qa-mod', { on: $('mod').checked }); };
  $('clrReact').onclick = function (e) { e.preventDefault(); api('clear-react'); toast('Reactions cleared'); };
  $('goAsk').onclick = $('qa1').onclick = function () { show('ask'); };
  $('qa2').onclick = exitTicket;
  $('qa3').onclick = function () { show('live'); };

  /* ---- Timer countdown ---- */
  setInterval(function () {
    $('timer').innerHTML = (deadline && cur && cur.open)
      ? icoHtml('clock', 16) + ' ' + Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) + 's'
      : '';
  }, 250);

  /* ---- Boot ---- */
  buildTypes(); setType('mcq');
  if (tkey && code) { loadQueue(); renderQueue(); connect(); }
  else if (tkey) showSessions();
  else screen('login');
})();
