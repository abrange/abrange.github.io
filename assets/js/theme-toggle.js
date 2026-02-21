(function () {
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;

  function savedTheme() {
    return localStorage.getItem('theme'); // 'dark' | 'light' | null
  }

  function osDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function effectiveIsDark() {
    var t = savedTheme();
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return osDark(); // auto: follow OS
  }

  function applyTheme(isDark) {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    btn.textContent = isDark ? '☀️' : '🌙';
    btn.setAttribute('title', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  // Render correct icon immediately
  applyTheme(effectiveIsDark());

  btn.addEventListener('click', function () {
    var next = !effectiveIsDark();
    localStorage.setItem('theme', next ? 'dark' : 'light');
    applyTheme(next);
  });

  // Keep in sync if user changes OS preference while page is open
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (!savedTheme()) applyTheme(osDark());
  });
})();
