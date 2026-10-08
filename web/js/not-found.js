// The 404 page (404.html). Sends old addresses of the previous website to the matching page of
// this one, and anything else to the homepage. This is a plain script, not a module, because the
// 404 page is served at any address and shares nothing with the app.
(function () {
  var path = location.pathname.replace(/\/+$/, '').replace(/\.html?$/, '').toLowerCase();
  var route = path.replace(/^\//, '');
  var target = '/#/';
  if (/^(visitor|clinics|dr-ali|login\/(staff|patient)|patient(\/demo)?)$/.test(route)) target = '/#/' + route;
  else if (/contact|location|branch|clinic|address|timing/.test(path)) target = '/#/clinics';
  else if (/service|treatment|brace|price|orthodont|veneer|smile/.test(path)) target = '/#/visitor';

  var go = document.getElementById('go');
  var auto = document.getElementById('auto');
  if (go) {
    go.href = target;
    if (target !== '/#/') go.textContent = 'Go to the new page';
  }
  if (!auto) return;

  // The sentence is written here, not in the page, so it never promises a move that cannot happen
  // (JavaScript off, or this script blocked). The wait ends as soon as someone presses a key or
  // taps, so nobody is moved while they are still reading.
  auto.textContent = 'You will be taken to ' + (target === '/#/' ? 'the homepage' : 'the page you were looking for') + ' in a few seconds.';
  var timer = setTimeout(function () { location.replace(target); }, 6000);
  function stay() {
    clearTimeout(timer);
    auto.textContent = '';
    document.removeEventListener('keydown', stay);
    document.removeEventListener('pointerdown', stay);
  }
  document.addEventListener('keydown', stay);
  document.addEventListener('pointerdown', stay);
})();
