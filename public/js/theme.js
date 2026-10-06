(function () {
  var K = 'cp-theme', root = document.documentElement;
  function get() { try { return localStorage.getItem(K) || 'light'; } catch (e) { return 'light'; } }
  function apply(t) {
    root.setAttribute('data-theme', t);
    document.querySelectorAll('#themeBtn,.js-theme').forEach(function (b) {
      b.innerHTML = window.icoHtml ? window.icoHtml(t === 'dark' ? 'sun' : 'moon', 18) : '';
      b.title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    });
  }
  apply(get());
  document.addEventListener('DOMContentLoaded', function () {
    apply(get());
    document.querySelectorAll('#themeBtn,.js-theme').forEach(function (b) {
      b.onclick = function () {
        var n = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(K, n); } catch (e) {}
        apply(n);
      };
    });
  });
})();

/* Show friendly error if opened as a plain file instead of via the server */
document.addEventListener('DOMContentLoaded', function () {
  if (location.protocol === 'file:') {
    document.body.innerHTML = '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:28px;border:1px solid #ccc;border-radius:14px;color:#111;background:#fff"><h2>Server not running</h2><p>Do not open this file directly in your browser.</p><p>Open a terminal in the project folder and run:<br><code style="background:#f4f4f4;padding:2px 8px;border-radius:6px;font-size:15px">node server.js</code></p><p>Then go to <a href="http://localhost:3000">http://localhost:3000</a></p></div>';
  }
});
