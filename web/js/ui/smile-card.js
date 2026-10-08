// Hero smile card: the real veneer result as a 3D photo card (depth-map parallax, tilts toward the pointer,
// sways when idle). Raw WebGL1, no libraries. Enhances the CSS arch in .smile-stage; if WebGL or the images
// are unavailable, the CSS arch simply stays.
// Heavy work stays off the first frames: the images decode off the main thread, the card is built in idle
// time and shaders compile in parallel where the browser allows. The card frees its GPU context and listeners
// as soon as its stage leaves the page, whether or not it is animating. It holds still under prefers-reduced-motion.
// setPaused() is an internal API only: the page shows no pause control (the owner removed the button on purpose), so
// a visitor cannot stop the sway from the UI. That is the open audit item a11y-public-13 (WCAG 2.2.2), left open by decision.
const W = window, D = document, M = Math;
const AR = 1400 / 781, T_IN = 1.4, PAD = 56;
const PHOTO = 'img/hero-smile.webp', DEPTH = 'img/hero-smile-depth.png';
function cl(v, a, b) { return v < a ? a : v > b ? b : v; }
const VS = 'attribute vec2 aQ;uniform vec4 uC,uS;uniform vec3 uA;varying vec2 vP;\nvoid main(){' +
    'vec2 h=uS.xy+uS.z;vec3 p=vec3(aQ*h,0.);vP=aQ*h;float e=uA.z;p.xy*=.94+.06*e;' +
    'float cy=cos(uA.x),sy=sin(uA.x),cp=cos(uA.y),sp=sin(uA.y);' +
    'p=vec3(p.x,p.y*cp-p.z*sp,p.y*sp+p.z*cp);p=vec3(p.x*cy+p.z*sy,p.y,-p.x*sy+p.z*cy);' +
    'p.z-=(1.-e)*160.;float k=1600./(1600.-p.z);vec2 c=uC.xy+p.xy*k;' +
    'gl_Position=vec4(c.x/uC.z*2.-1.,1.-c.y/uC.w*2.,0.,1.);}';
const FS = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n' +
    'uniform sampler2D uI,uD;uniform vec4 uS,uL;uniform vec3 uK,uR;varying vec2 vP;\n' +
    'float rr(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}\n' +
    'void main(){vec2 p=vec2(vP.x,-vP.y);float d=rr(p,uS.xy,uS.w),e=uL.z;' +
    // drop shadow below the card, tinted with the deep aubergine token (uK)
    'if(d>0.){vec2 o=p+vec2(0.,uS.z*.3);float d2=max(rr(o,uS.xy*.96,uS.w),0.);' +
    'float sh=exp(-d2/(uS.z*.38))*.55*(1.-smoothstep(uS.z*.6,uS.z,d2))*e;gl_FragColor=vec4(uK*sh,sh);return;}' +
    'vec2 uv=p/(uS.xy*2.)+.5;uv.y=1.-uv.y;' +
    'vec2 dir=vec2(-uL.x,uL.y)*.11;float z=texture2D(uD,uv).r;vec2 q=uv;' +
    'for(int i=0;i<4;i++){q=uv-dir*(z-.55);z=texture2D(uD,clamp(q,0.,1.)).r;}' +
    'q=clamp((q-.5)*.965+.5,0.,1.);vec3 c=texture2D(uI,q).rgb;' +
    'vec2 n=uv-.5;float g=exp(-pow((n.x*.9+n.y*.5)-(uL.x*1.6-uL.y*.8)-.15,2.)*18.);c+=vec3(1.,.97,.92)*g*.08;' +
    'c*=1.-.3*dot(n*vec2(1.,1.4),n*vec2(1.,1.4));' +
    'float rim=smoothstep(-2.5*uL.w,0.,d);c=mix(c,uR,rim*.6);' + // rim in the brand gold token (uR)
    'float a=smoothstep(.5,-.5,d)*e;gl_FragColor=vec4(c*a,a);}';

// Brand colours come from the CSS tokens, so the card follows the stylesheet. Fallbacks are today's values.
function rgb(v) {
  var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v), x;
  if (m) {
    x = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return [0, 2, 4].map(function (i) { return parseInt(x.slice(i, i + 2), 16) / 255; });
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  return m ? [m[1] / 255, m[2] / 255, m[3] / 255] : null;
}
function token(names, fallback) {
  var cs = getComputedStyle(D.documentElement), i, c;
  for (i = 0; i < names.length; i++) { c = rgb(cs.getPropertyValue(names[i]).trim()); if (c) return c; }
  return fallback;
}

function idle(fn) { return W.requestIdleCallback ? W.requestIdleCallback(fn, { timeout: 1200 }) : W.setTimeout(fn, 120); }

let imgs = null, loading = null;
function decode(src) {
  return new Promise(function (res, rej) {
    var im = new Image(); im.decoding = 'async'; im.onload = function () { res(im); }; im.onerror = rej; im.src = src;
  }).then(function (im) { // decode off the main thread, so the texture upload does not stall the page
    if (W.createImageBitmap) return W.createImageBitmap(im).catch(function () { return im; });
    return im.decode ? im.decode().then(function () { return im; }, function () { return im; }) : im;
  });
}
function load() {
  if (!loading) loading = Promise.all([PHOTO, DEPTH].map(decode)).then(function (a) { imgs = a; return a; }, function (e) { loading = null; throw e; });
  return loading;
}

/** Resolves in idle time once the stage is on the page (the view is built before it is attached, sometimes well before). */
function whenAttached(stage) {
  return new Promise(function (res, rej) {
    var t0 = Date.now();
    (function wait() {
      if (stage.isConnected) return idle(res);
      if (Date.now() - t0 > 30000) return rej(0);
      W.setTimeout(wait, 100);
    })();
  });
}

/**
 * Starts loading the photo card for this stage. Returns a controller:
 * setPaused(true|false) stops or restarts the motion (internal: no control in the page calls it); destroy() removes the card.
 */
export function smileCard(stage, opts) {
  var ctl = {
    paused: !!(opts && opts.paused), card: null, gone: false,
    setPaused: function (p) { ctl.paused = !!p; if (ctl.card) ctl.card.pause(ctl.paused); },
    destroy: function () { ctl.gone = true; if (ctl.card) ctl.card.kill(); },
  };
  load().then(function () { return whenAttached(stage); }).then(function () {
    if (!ctl.gone && stage.isConnected) ctl.card = mount(stage, ctl);
  }).catch(function () { /* keep the CSS arch */ });
  return ctl;
}

function mount(stage, ctl) {
  var nav = W.navigator || {}, mq = W.matchMedia ? W.matchMedia('(prefers-reduced-motion: reduce)') : null,
    rm = !!(mq && mq.matches), paused = ctl.paused, cv = D.createElement('canvas'), arch = stage.querySelector('.arch'), gl, U = {}, Ls = [],
    ro, io, mo, dead, ready, lost, inView = 1, raf, last, clock = 0, inT = 0, hasP = 0, pX = 0, pY = 0, yaw = 0, pitch = 0,
    cx = 0, cy = 0, hw = 1, hh = 1, vw = 1, vh = 1, dpr = 1, bx = -1, self = { stage: stage, cv: cv, kill: kill, pause: pause };

  if ((nav.connection && nav.connection.saveData) || !W.WebGLRenderingContext) return self;
  try { gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }); } catch (e) { gl = null; }
  if (!gl) return self;

  function on(t, ty, fn, active) { t.addEventListener(ty, fn, active ? false : { passive: true }); Ls.push([t, ty, fn]); }
  function stop() { if (raf) W.cancelAnimationFrame(raf); raf = 0; }
  function kill() {
    if (dead) return; dead = 1; ready = 0; stop();
    try {
      if (ro) ro.disconnect(); if (io) io.disconnect(); if (mo) mo.disconnect();
      Ls.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
      var x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext();
    } catch (e) { /* ignore */ }
    if (cv.parentNode) cv.parentNode.removeChild(cv);
    if (arch) arch.style.visibility = '';
    stage.classList.remove('has-card');
  }
  // The view was replaced: free the GPU context, observers and listeners even if the loop is not running.
  function gone() { if (!dead && !stage.isConnected) kill(); return dead; }
  function sh(t, src) { var s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return s; }
  // Compile and link without asking for the result straight away (that would block the main thread until the
  // driver finishes). With KHR_parallel_shader_compile we wait for completion frame by frame; either way the
  // status is read later, in idle time.
  function compile() {
    var pg = gl.createProgram(), ext = gl.getExtension('KHR_parallel_shader_compile');
    gl.attachShader(pg, sh(gl.VERTEX_SHADER, 'precision highp float;\n' + VS));
    gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(pg, 0, 'aQ'); gl.linkProgram(pg);
    return new Promise(function (res) {
      (function poll() {
        if (dead || lost) return res(null);
        if (ext && !gl.getProgramParameter(pg, ext.COMPLETION_STATUS_KHR)) { W.requestAnimationFrame(poll); return; }
        idle(function () { res(pg); });
      })();
    });
  }
  function finish(pg) {
    var g = [], N = 24, i, j, k, r;
    if (gl.isContextLost() || !gl.getProgramParameter(pg, gl.LINK_STATUS)) throw 0;
    gl.useProgram(pg);
    for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
      var x0 = i / N * 2 - 1, x1 = (i + 1) / N * 2 - 1, y0 = j / N * 2 - 1, y1 = (j + 1) / N * 2 - 1;
      g.push(x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    U.n = g.length / 2;
    ['uC', 'uS', 'uA', 'uL', 'uI', 'uD', 'uK', 'uR'].forEach(function (u) { U[u] = gl.getUniformLocation(pg, u); });
    gl.uniform1i(U.uI, 0); gl.uniform1i(U.uD, 1);
    k = token(['--aubergine-deep', '--night'], [.133, .067, .231]);
    r = token(['--gold', '--champagne'], [.79, .643, .416]);
    gl.uniform3f(U.uK, k[0], k[1], k[2]); gl.uniform3f(U.uR, r[0], r[1], r[2]);
    imgs.forEach(function (im, n) {
      var t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + n); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.clearColor(0, 0, 0, 0);
    ready = 1;
  }
  function build() { return compile().then(function (pg) { if (pg && !dead && !lost) finish(pg); }); }
  function layout() {
    if (gone()) return;
    var r = stage.getBoundingClientRect(), pageW = D.documentElement.clientWidth || W.innerWidth, px, w, h, bw;
    if (r.width < 40 || r.height < 40) return;
    // Bleed sideways for the shadow, but never past the edge of the page, so the canvas cannot widen it.
    px = M.floor(M.max(0, M.min(PAD, r.left, pageW - r.right)));
    if (px !== bx) { bx = px; cv.style.left = -px + 'px'; cv.style.width = 'calc(100% + ' + px * 2 + 'px)'; }
    w = r.width + px * 2; h = r.height + PAD * 2;
    dpr = M.min(W.devicePixelRatio || 1, W.innerWidth <= 768 ? 1.5 : 2);
    var cw = M.round(w * dpr), ch = M.round(h * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    gl.viewport(0, 0, cw, ch); vw = cw; vh = ch;
    bw = M.min(r.width, r.height * .9 * AR); // card fills 90% of the stage height, never wider than the stage
    hw = bw / 2 * dpr; hh = hw / AR; cx = w / 2 * dpr; cy = h / 2 * dpr;
    draw();
  }
  function draw() {
    if (dead || !ready || lost) return;
    var e = rm ? 1 : cl(inT / T_IN, 0, 1); e = 1 - M.pow(1 - e, 3);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4f(U.uC, cx, cy, vw, vh);
    gl.uniform4f(U.uS, hw, hh, 46 * dpr, 18 * dpr);
    gl.uniform3f(U.uA, yaw, pitch, e);
    gl.uniform4f(U.uL, yaw, pitch, e, dpr);
  }
  function render() { draw(); if (!dead && ready && !lost) gl.drawArrays(gl.TRIANGLES, 0, U.n); }
  function step(dt) {
    var k = 1 - M.exp(-dt * 3.2), ty = .1 * M.sin(clock * .35), tp = .05 * M.sin(clock * .27 + 1), r;
    inT += dt;
    if (hasP) {
      r = cv.getBoundingClientRect();
      ty = cl(((pX - r.left) * dpr - cx) / (hw * 2.4), -1, 1) * .24;
      tp = cl(((pY - r.top) * dpr - cy) / (hh * 3.2), -1, 1) * .16;
    }
    yaw += (ty - yaw) * k; pitch += (tp - pitch) * k;
  }
  function loop(now) {
    raf = 0; if (dead) return;
    if (!D.contains(cv)) return kill();
    try {
      var dt = last ? M.min((now - last) / 1000, .05) : 1 / 60;
      last = now; clock += dt; step(dt); render();
      raf = W.requestAnimationFrame(loop);
    } catch (e) { kill(); }
  }
  function kick() {
    if (gone()) return;
    if (ready && !lost && !rm && !paused && inView && !D.hidden) { if (!raf) { last = 0; raf = W.requestAnimationFrame(loop); } }
    else stop();
  }
  // A finished, calm pose for reduced motion or when paused before the card appears.
  function still() { yaw = .07; pitch = .035; inT = T_IN; }
  function pause(p) {
    paused = !!p;
    if (dead) return;
    if (paused) { stop(); inT = T_IN; render(); } // freeze where it is, with the entrance completed
    kick();
  }

  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:absolute;top:' + -PAD + 'px;height:calc(100% + ' + PAD * 2 + 'px);pointer-events:none;';
  build().then(function () {
    if (gone() || !ready) return kill();
    if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
    stage.appendChild(cv);
    if (arch) arch.style.visibility = 'hidden';
    stage.classList.add('has-card');
    on(cv, 'webglcontextlost', function (e) { e.preventDefault(); lost = 1; ready = 0; stop(); }, true); // not passive: preventDefault allows a restore
    on(cv, 'webglcontextrestored', function () { lost = 0; build().then(function () { layout(); render(); kick(); }).catch(kill); });
    on(W, 'pointermove', function (e) { if (e.pointerType === 'touch' || gone()) return; pX = e.clientX; pY = e.clientY; hasP = 1; });
    on(D.documentElement, 'pointerleave', function () { hasP = 0; });
    on(D, 'visibilitychange', kick);
    if (mq && mq.addEventListener) on(mq, 'change', function () { rm = mq.matches; if (rm) { stop(); still(); render(); } kick(); });
    on(W, 'resize', function () { layout(); render(); });
    if (W.ResizeObserver) { ro = new ResizeObserver(function () { layout(); render(); }); ro.observe(stage); }
    if (W.IntersectionObserver) { io = new IntersectionObserver(function (en) { if (gone()) return; inView = en[en.length - 1].isIntersecting; kick(); }); io.observe(stage); }
    // Resize and intersection observers do not report a stage that was removed, so watch the page for that too.
    if (W.MutationObserver) { mo = new MutationObserver(gone); mo.observe(D.documentElement, { childList: true, subtree: true }); }
    layout();
    if (rm || paused) still();
    render(); kick();
  }).catch(kill);
  return self;
}
