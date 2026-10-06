(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var icon = window.icon, icoHtml = window.icoHtml;
  var RX = { like: ['thumbs-up', 'Like'], love: ['heart', 'Love'], idea: ['lightbulb', 'Idea'], smile: ['smile', 'Happy'], wow: ['zap', 'Wow'] };

  function rankRow(r, i) {
    var d = document.createElement('div'); d.className = 'lb';
    var w = document.createElement('span'); w.className = 'who';
    var k = document.createElement('span'); k.className = 'rank r' + (i + 1); k.textContent = i + 1;
    w.appendChild(k); w.appendChild(document.createTextNode(r.name)); d.appendChild(w);
    var b = document.createElement('b'); b.textContent = r.pts; d.appendChild(b);
    return d;
  }
  var el = function (t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };

  /* ---- persistent identity (survives refresh / closing the tab) ---- */
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var sid = LS.get('cp-sid') || Math.random().toString(36).slice(2, 12);
  LS.set('cp-sid', sid);
  var code = '', last = null, deadline = 0, builtKey = '', timer = null, busy = false, fails = 0, joined = false;
  var params = new URLSearchParams(location.search);
  $('codeIn').value = params.get('code') || LS.get('cp-code') || '';
  $('nameIn').value = LS.get('cp-name') || '';

  function api(p, b) {
    return fetch('/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ code: code, sid: sid }, b || {})) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (r.status === 410) poll(); return j; }); })
      .then(function (j) { poll(); return j; })
      .catch(function () { toast('Offline — try again'); });
  }
  function toast(m) {
    var t = $('toast'); t.textContent = m; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  function showJoin(msg) {
    joined = false; clearInterval(timer); timer = null;
    $('join').hidden = false; $('room').hidden = true; $('me').hidden = true;
    $('err').textContent = msg || ''; $('joinBtn').disabled = false;
  }

  /* ---- join: room code + name only ---- */
  function join(silent) {
    code = $('codeIn').value.trim();
    var nm = $('nameIn').value.trim();
    if (!code || !nm) { if (!silent) $('err').textContent = 'Enter the room code and your name.'; return; }
    $('err').textContent = ''; $('joinBtn').disabled = true;
    fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code, sid: sid, name: nm }) })
      .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (r) {
        if (r.s === 200) {
          LS.set('cp-code', code); LS.set('cp-name', nm); joined = true;
          $('join').hidden = true; $('room').hidden = false; $('joinBtn').disabled = false;
          $('sessInfo').textContent = [r.j.title, r.j.cls].filter(Boolean).join(' · ');
          poll(); clearInterval(timer); timer = setInterval(poll, 2000);
        } else {
          if (r.s === 404) LS.del('cp-code');
          showJoin(r.s === 404 ? 'Room not found. Check the code and try again.' : (r.j.error || 'Could not join'));
        }
      })
      .catch(function () {
        $('joinBtn').disabled = false;
        if (LS.get('cp-last') && silent) { renderCached(); poll(); clearInterval(timer); timer = setInterval(poll, 2000); }
        else $('err').textContent = 'No connection. Please try again.';
      });
  }

  /* ---- live updates (short polling; works on serverless hosts) ---- */
  function poll() {
    if (!code || busy) return; busy = true;
    fetch('/api/state?role=student&code=' + encodeURIComponent(code) + '&sid=' + sid, { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) { busy = false; return rejoin(); }
        return r.json().then(function (v) { fails = 0; $('conn').hidden = true; last = v; LS.set('cp-last', JSON.stringify({ code: code, v: v })); render(v); });
      })
      .catch(function () { if (++fails >= 2) $('conn').hidden = false; })
      .then(function () { busy = false; });
  }
  function rejoin() { // session or my record missing: try once to join again with the saved name
    var nm = LS.get('cp-name');
    if (!nm) return showJoin('Please join again.');
    fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code, sid: sid, name: nm }) })
      .then(function (r) { if (r.status === 200) { poll(); } else { LS.del('cp-code'); LS.del('cp-last'); showJoin(r.status === 410 ? 'This session has ended.' : 'Room not found. Check the code and try again.'); } })
      .catch(function () {});
  }
  function renderCached() {
    try { var c = JSON.parse(LS.get('cp-last') || 'null'); if (c && c.code === code) { $('join').hidden = true; $('room').hidden = false; render(c.v); } } catch (e) {}
  }

  function buildQuestion(v) {
    var q = v.q, c = $('choices'); c.innerHTML = '';
    if (q.type === 'cloud' || q.type === 'text') {
      if (q.open) {
        var inp = el(q.type === 'text' ? 'textarea' : 'input');
        inp.id = 'ans'; inp.maxLength = q.type === 'text' ? 200 : 30;
        inp.placeholder = q.type === 'text' ? 'Type your answer…' : 'One word or short phrase';
        if (q.type === 'text') inp.rows = 3;
        if (typeof v.mine === 'string') inp.value = v.mine;
        var b = el('button', 'full', 'Submit answer');
        b.onclick = function () { api('answer', { text: inp.value }); };
        c.appendChild(inp); c.appendChild(b);
      } else if (q.type === 'cloud') {
        var w = el('div', 'cloud');
        (v.res || []).forEach(function (r, i) {
          var s = el('span', '', r[0]);
          s.style.fontSize = (16 + r[1] * 8) + 'px';
          s.style.color = 'var(--c' + (i % 5 + 1) + ')';
          w.appendChild(s);
        });
        c.appendChild(w);
      }
      return;
    }
    if (q.type === 'rating') {
      var d = el('div', 'stars');
      q.options.forEach(function (o, i) {
        var b = el('button', v.mine === i ? 'sel' : '');
        b.appendChild(icon('star', 20));
        b.appendChild(document.createTextNode(' ' + (i + 1)));
        b.disabled = !q.open;
        b.onclick = function () { api('answer', { choice: i }); };
        d.appendChild(b);
      });
      c.appendChild(d); return;
    }
    var tot = (v.res || []).reduce(function (a, x) { return a + x; }, 0) || 1;
    q.options.forEach(function (o, i) {
      var b = el('button', 'choice'); b.appendChild(el('span', '', o));
      if (q.open) {
        if (v.mine === i) b.classList.add('sel');
        b.onclick = function () { api('answer', { choice: i }); };
      } else {
        b.disabled = true; b.style.opacity = 1;
        b.appendChild(el('span', '', Math.round(v.res[i] / tot * 100) + '%'));
        if (v.correct === i) b.classList.add('right');
        else if (v.mine === i && v.correct !== null) b.classList.add('wrong');
        else if (v.mine === i) b.classList.add('sel');
      }
      c.appendChild(b);
    });
  }

  function render(v) {
    var q = v.q;
    $('me').hidden = !v.name; $('me').textContent = v.name || '';
    $('wait').hidden = !!q && !v.ended; $('qcard').hidden = !q || v.ended;
    $('wt').textContent = v.ended ? 'Session ended' : "You're in!";
    $('wp').textContent = v.ended ? 'Your teacher has closed this session. Thanks for taking part!' : 'Waiting for your teacher to send a question…';
    $('sessInfo').textContent = [v.title, v.cls, v.start ? v.start + (v.end ? '–' + v.end : '') : ''].filter(Boolean).join(' · ');
    $('myPts').textContent = v.myPts ? 'Your points: ' + v.myPts : '';
    deadline = v.left !== null ? Date.now() + v.left : 0;

    // Confused button
    $('cbtn').innerHTML = icoHtml('help-circle', 18) + (v.confusedMe ? ' Confused — tap to undo' : " I'm confused");
    $('cbtn').className = 'confused-btn' + (v.confusedMe ? ' on' : '');

    // Pace buttons
    Array.prototype.forEach.call(document.querySelectorAll('#pace button'), function (b) {
      b.classList.toggle('on', b.dataset.v === v.paceMe);
    });

    if (q) {
      $('qt').textContent = q.text;
      $('st').textContent = q.open ? 'OPEN' : 'CLOSED';
      $('st').className = 'pill ' + (q.open ? 'live' : 'closed');
      var textual = q.type === 'cloud' || q.type === 'text';
      var key = v.n + '|' + q.open + '|' + q.type;
      if (!textual || key !== builtKey) { buildQuestion(v); builtKey = key; }

      var fb = '';
      if (q.open) {
        fb = v.mine !== null
          ? 'Answer submitted. ' + (textual ? 'You can submit again to change it.' : 'You can change it until time is up.')
          : (textual ? '' : 'Tap an option to answer');
      } else {
        fb = v.correct === null
          ? 'Closed. Thanks for taking part!'
          : v.mine === null ? 'You did not answer this one.'
          : v.mine === v.correct ? '✓ Correct — points added!'
          : 'Not quite — the correct answer is highlighted.';
      }
      var fbEl = $('fb');
      fbEl.hidden = !fb; fbEl.textContent = fb;
    }

    // Q&A list (Ask tab)
    var ql = $('qalist'); ql.innerHTML = '';
    v.qa.forEach(function (x) {
      var d = el('div', 'qa card' + (x.done ? ' done' : '')); d.style.marginBottom = '8px';
      d.appendChild(el('span', 't', x.text + (x.done ? '  (answered)' : '') + (x.ok ? '' : '  (waiting for review)')));
      var b = el('button', 'ghost sm' + (x.mine ? ' on' : ''));
      b.appendChild(icon('chevron-up', 14)); b.appendChild(document.createTextNode(' ' + x.votes));
      b.onclick = function () { api('vote', { id: x.id }); }; d.appendChild(b); ql.appendChild(d);
    });

    // Leaderboard
    var lb = $('lb'); lb.innerHTML = '';
    if (!v.board.length) lb.appendChild(el('p', 'mute', 'Scores appear after quiz questions close.'));
    v.board.forEach(function (r, i) { lb.appendChild(rankRow(r, i)); });
  }

  /* ---- Wiring ---- */
  $('joinBtn').onclick = join;
  $('codeIn').onkeydown = $('nameIn').onkeydown = function (e) { if (e.key === 'Enter') join(); };
  $('askBtn').onclick = function () {
    var t = $('ask').value.trim(); if (!t) return;
    api('ask', { text: t }); $('ask').value = ''; toast('Question sent!');
  };
  $('cbtn').onclick = function () { if (last) api('confused', { on: !last.confusedMe }); };
  Array.prototype.forEach.call(document.querySelectorAll('#pace button'), function (b) {
    b.onclick = function () { api('pace', { value: b.dataset.v }); };
  });

  // Build reaction buttons
  Object.keys(RX).forEach(function (k) {
    var b = el('button', 'ghost');
    b.appendChild(icon(RX[k][0], 22));
    var lbl = el('span', 'label', RX[k][1]); b.appendChild(lbl);
    b.title = RX[k][1]; b.setAttribute('aria-label', RX[k][1]);
    b.onclick = function () { api('react', { emoji: k }); toast(RX[k][1] + ' sent!'); };
    $('reacts').appendChild(b);
  });

  // Bottom nav switching
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) {
    b.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (x) { x.classList.toggle('on', x === b); });
      ['q', 'f', 'a', 'l'].forEach(function (p) { $('p-' + p).hidden = p !== b.dataset.p; });
    };
  });

  // Timer
  setInterval(function () {
    $('timer').innerHTML = deadline && last && last.q && last.q.open
      ? icoHtml('clock', 16) + ' ' + Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) + 's'
      : '';
  }, 250);

  $('leaveBtn').onclick = function () {
    LS.del('cp-code'); LS.del('cp-last'); code = ''; last = null; showJoin('');
    $('codeIn').value = '';
  };
  document.addEventListener('visibilitychange', function () { if (!document.hidden && joined) poll(); });
  window.addEventListener('online', function () { if (joined) poll(); });

  // Auto-resume: a refresh or reopened tab goes straight back into the same class
  if ($('codeIn').value && $('nameIn').value && !params.get('code')) { code = $('codeIn').value; renderCached(); join(true); }
})();
