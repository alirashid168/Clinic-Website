// Hero smile card: the real veneer result as a 3D photo card (depth-map parallax, tilts toward the pointer,
// sways when idle). Raw WebGL1, no libraries. Enhances the CSS arch in .smile-stage; if WebGL or the images
// are unavailable, the CSS arch simply stays.
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
    'uniform sampler2D uI,uD;uniform vec4 uS,uL;varying vec2 vP;\n' +
    'float rr(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}\n' +
    'void main(){vec2 p=vec2(vP.x,-vP.y);float d=rr(p,uS.xy,uS.w),e=uL.z;' +
    // aubergine-tinted drop shadow below the card
    'if(d>0.){vec2 o=p+vec2(0.,uS.z*.3);float d2=max(rr(o,uS.xy*.96,uS.w),0.);' +
    'float sh=exp(-d2/(uS.z*.38))*.55*(1.-smoothstep(uS.z*.6,uS.z,d2))*e;gl_FragColor=vec4(vec3(.133,.067,.231)*sh,sh);return;}' +
    'vec2 uv=p/(uS.xy*2.)+.5;uv.y=1.-uv.y;' +
    'vec2 dir=vec2(-uL.x,uL.y)*.11;float z=texture2D(uD,uv).r;vec2 q=uv;' +
    'for(int i=0;i<4;i++){q=uv-dir*(z-.55);z=texture2D(uD,clamp(q,0.,1.)).r;}' +
    'q=clamp((q-.5)*.965+.5,0.,1.);vec3 c=texture2D(uI,q).rgb;' +
    'vec2 n=uv-.5;float g=exp(-pow((n.x*.9+n.y*.5)-(uL.x*1.6-uL.y*.8)-.15,2.)*18.);c+=vec3(1.,.97,.92)*g*.08;' +
    'c*=1.-.3*dot(n*vec2(1.,1.4),n*vec2(1.,1.4));' +
    'float rim=smoothstep(-2.5*uL.w,0.,d);c=mix(c,vec3(.79,.643,.416),rim*.6);' + // champagne rim
    'float a=smoothstep(.5,-.5,d)*e;gl_FragColor=vec4(c*a,a);}';


let imgs = null, ready = null;
function load() {
  if (!ready) ready = Promise.all([PHOTO, DEPTH].map((src) => new Promise((res, rej) => {
    const im = new Image(); im.decoding = 'async'; im.onload = () => res(im); im.onerror = rej; im.src = src;
  }))).then((a) => { imgs = a; return a; });
  return ready;
}

export function smileCard(stage) {
  load().then(() => {
    let tries = 0;
    (function wait() { // the view is built before it is attached to the page
      if (stage.isConnected) return mount(stage);
      if (tries++ < 120) W.requestAnimationFrame(wait);
    })();
  }).catch(() => { /* keep the CSS arch */ });
}

function mount(stage) {
  var nav = W.navigator || {}, mq = W.matchMedia ? W.matchMedia('(prefers-reduced-motion: reduce)') : null,
    rm = !!(mq && mq.matches), cv = D.createElement('canvas'), arch = stage.querySelector('.arch'), gl, U = {}, Ls = [],
    ro, io, dead, ready, lost, inView = 1, raf, last, clock = 0, inT = 0, hasP = 0, pX = 0, pY = 0, yaw = 0, pitch = 0,
    cx = 0, cy = 0, hw = 1, hh = 1, vw = 1, vh = 1, dpr = 1, self = { stage: stage, cv: cv, kill: kill };

  if ((nav.connection && nav.connection.saveData) || !W.WebGLRenderingContext) return self;
  try { gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }); } catch (e) { gl = null; }
  if (!gl) return self;

  function on(t, ty, fn) { t.addEventListener(ty, fn, { passive: true }); Ls.push([t, ty, fn]); }
  function stop() { if (raf) W.cancelAnimationFrame(raf); raf = 0; }
  function kill() {
    if (dead) return; dead = 1; stop();
    try {
      if (ro) ro.disconnect(); if (io) io.disconnect();
      Ls.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
      var x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext();
    } catch (e) { /* ignore */ }
    if (cv.parentNode) cv.parentNode.removeChild(cv);
    if (arch) arch.style.visibility = '';
    stage.classList.remove('has-card');
  }
  function sh(t, src) {
    var s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw 0;
    return s;
  }
  function build() {
    var pg = gl.createProgram(), g = [], N = 24, i, j;
    gl.attachShader(pg, sh(gl.VERTEX_SHADER, 'precision highp float;\n' + VS));
    gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(pg, 0, 'aQ'); gl.linkProgram(pg);
    if (!gl.getProgramParameter(pg, gl.LINK_STATUS) && !gl.isContextLost()) throw 0;
    gl.useProgram(pg);
    for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
      var x0 = i / N * 2 - 1, x1 = (i + 1) / N * 2 - 1, y0 = j / N * 2 - 1, y1 = (j + 1) / N * 2 - 1;
      g.push(x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    U.n = g.length / 2;
    ['uC', 'uS', 'uA', 'uL', 'uI', 'uD'].forEach(function (u) { U[u] = gl.getUniformLocation(pg, u); });
    gl.uniform1i(U.uI, 0); gl.uniform1i(U.uD, 1);
    imgs.forEach(function (im, k) {
      var t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.clearColor(0, 0, 0, 0);
    ready = 1;
  }
  function layout() {
    var r = stage.getBoundingClientRect(), w = r.width + PAD * 2, h = r.height + PAD * 2, bw;
    if (r.width < 40 || r.height < 40) return;
    dpr = M.min(W.devicePixelRatio || 1, W.innerWidth <= 768 ? 1.5 : 2);
    var cw = M.round(w * dpr), ch = M.round(h * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    gl.viewport(0, 0, cw, ch); vw = cw; vh = ch;
    bw = M.min(r.width, r.height * .9 * AR); // card fills 90% of the stage height, never wider than the stage
    hw = bw / 2 * dpr; hh = hw / AR; cx = w / 2 * dpr; cy = h / 2 * dpr;
    draw();
  }
  function draw() {
    if (!ready || lost) return;
    var e = rm ? 1 : cl(inT / T_IN, 0, 1); e = 1 - M.pow(1 - e, 3);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4f(U.uC, cx, cy, vw, vh);
    gl.uniform4f(U.uS, hw, hh, 46 * dpr, 18 * dpr);
    gl.uniform3f(U.uA, yaw, pitch, e);
    gl.uniform4f(U.uL, yaw, pitch, e, dpr);
  }
  function render() { draw(); if (ready && !lost) gl.drawArrays(gl.TRIANGLES, 0, U.n); }
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
    if (!dead && ready && !lost && !rm && inView && !D.hidden) { if (!raf) { last = 0; raf = W.requestAnimationFrame(loop); } }
    else stop();
  }
  try { build(); } catch (e) { return self; }
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:absolute;left:' + -PAD + 'px;top:' + -PAD + 'px;width:calc(100% + ' + PAD * 2 + 'px);height:calc(100% + ' + PAD * 2 + 'px);pointer-events:none;';
  if (getComputedStyle(stage).position === 'static') stage.style.position = 'relative';
  stage.appendChild(cv);
  if (arch) arch.style.visibility = 'hidden';
  stage.classList.add('has-card');
  on(cv, 'webglcontextlost', function (e) { e.preventDefault(); lost = 1; ready = 0; stop(); });
  on(cv, 'webglcontextrestored', function () { lost = 0; try { build(); layout(); render(); kick(); } catch (e) { kill(); } });
  on(W, 'pointermove', function (e) { if (e.pointerType === 'touch') return; pX = e.clientX; pY = e.clientY; hasP = 1; });
  on(D.documentElement, 'pointerleave', function () { hasP = 0; });
  on(D, 'visibilitychange', kick);
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { rm = mq.matches; if (rm) { stop(); yaw = .07; pitch = .035; render(); } kick(); });
  if (W.ResizeObserver) { ro = new ResizeObserver(function () { layout(); render(); }); ro.observe(stage); } else on(W, 'resize', function () { layout(); render(); });
  if (W.IntersectionObserver) { io = new IntersectionObserver(function (en) { inView = en[0].isIntersecting; kick(); }); io.observe(stage); }
  layout();
  if (rm) { yaw = .07; pitch = .035; inT = T_IN; }
  render(); kick();
  return self;
}
