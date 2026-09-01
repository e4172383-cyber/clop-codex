/* Заставка: осенний закат, дождь стекает по «стеклу» экрана, вся вода
   собирается в кольцо, кольцо разрывается на три капли — они прыгают,
   пока идёт загрузка, — и в конце вода складывается в улыбку.

   Всё рисует GPU в четыре прохода:
     1) небо — градиент заката, три слоя облаков параллаксом, солнце с
        лучами и виньетка;
     2) листья — квадраты, форма листа считается в пикселе;
     3) поле воды — капли складываются аддитивно ядром (1-d²)³, из суммы
        получается поле, где соседние капли сливаются в одну;
     4) сведение — по перепаду поля строится нормаль поверхности, а по ней
        берутся преломление заката (капля работает как линза), блик и
        бегущие по кромке искры.
   Порог поля берётся уже в разрешении экрана, поэтому кромка воды всегда
   чёткая: пикселей нет ни на 4K, ни при любом увеличении. Физика капель
   считается в своём условном пространстве шириной 380 — от разрешения она
   не зависит вовсе. */
const loaderReady = (() => {
  const el = document.getElementById('loader');
  const txt = document.getElementById('loaderText');
  const skyCv = el && document.getElementById('lSky');
  const wCv = el && document.getElementById('lWater');

  // Данные страницы приходят параллельно с анимацией: пока их нет, капли
  // продолжают прыгать. Кто первым готов — тот и ждёт другого.
  let dataOk = false;
  const api = { data: () => { dataOk = true; } };

  if (!el) { api.done = Promise.resolve(); return api; }
  const flat = () => {
    el.classList.add('flat');
    setTimeout(() => { el.classList.add('done'); if (txt) txt.textContent = 'Готово'; }, 420);
    api.done = new Promise((r) => setTimeout(r, 750));
    return api;
  };
  if (!skyCv || !wCv || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return flat();

  const gl = wCv.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, powerPreference: 'high-performance',
  }) || wCv.getContext('experimental-webgl');
  if (!gl) return flat();
  skyCv.style.display = 'none';

  /* ---------- облачная текстура: бесшовный фрактальный шум ---------- */
  const TILE = 256;
  const cloudCanvas = (() => {
    const c = document.createElement('canvas'); c.width = c.height = TILE;
    const g = c.getContext('2d');
    const im = g.createImageData(TILE, TILE);
    let seed = 20260901;
    const nrnd = () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    // Решётка каждой октавы делит TILE нацело — текстура стыкуется сама с
    // собой, и её можно бесконечно возить по экрану без швов
    const oct = [];
    for (let o = 0; o < 6; o++) {
      const f = 2 << o; const a = new Float32Array(f * f);
      for (let i = 0; i < f * f; i++) a[i] = nrnd();
      oct.push({ f, a });
    }
    const sm = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      let v = 0, amp = 1, nrm = 0;
      for (const o of oct) {
        const fx = x / TILE * o.f, fy = y / TILE * o.f;
        const xi = Math.floor(fx), yi = Math.floor(fy);
        const x0 = xi % o.f, y0 = yi % o.f, x1 = (x0 + 1) % o.f, y1 = (y0 + 1) % o.f;
        const tx = sm(fx - xi), ty = sm(fy - yi);
        const p = o.a[y0 * o.f + x0] + (o.a[y0 * o.f + x1] - o.a[y0 * o.f + x0]) * tx;
        const q = o.a[y1 * o.f + x0] + (o.a[y1 * o.f + x1] - o.a[y1 * o.f + x0]) * tx;
        v += amp * (p + (q - p) * ty); nrm += amp; amp *= 0.52;
      }
      v /= nrm;
      // Кривая «облачности»: низ отсекаем начисто, верх мягко насыщаем —
      // иначе шум читается как ровный туман, а не как отдельные облака
      let al = (v - 0.44) / 0.4;
      al = al < 0 ? 0 : al > 1 ? 1 : al; al = al * al * (3 - 2 * al);
      const i = (y * TILE + x) * 4;
      // Солнце низко: разреженные края облаков светятся тёплым, плотные
      // сердцевины уходят в пыльно-лиловую тень
      im.data[i] = 255 - al * 96;
      im.data[i + 1] = 214 - al * 96;
      im.data[i + 2] = 182 - al * 44;
      im.data[i + 3] = al * 235;
    }
    g.putImageData(im, 0, 0);
    return c;
  })();

  /* ---------- шейдеры ---------- */
  const PREC = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

  const VS_QUAD = 'attribute vec2 aPos;varying vec2 vUv;'
    + 'void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}';

  const FS_SKY = PREC
    + 'varying vec2 vUv;uniform sampler2D uCloud;uniform float uT;uniform float uAsp;'
    // Закат снизу вверх: охра у горизонта, остывающее небо наверху
    + 'vec3 grad(float y){'
    + ' vec3 c=mix(vec3(0.298,0.357,0.557),vec3(0.553,0.435,0.573),smoothstep(0.0,0.30,y));'
    + ' c=mix(c,vec3(0.851,0.561,0.388),smoothstep(0.30,0.56,y));'
    + ' c=mix(c,vec3(0.953,0.702,0.455),smoothstep(0.56,0.78,y));'
    + ' return mix(c,vec3(0.663,0.361,0.251),smoothstep(0.78,1.0,y));}'
    + 'vec4 layer(vec2 uv,float sc,float sp,float dy){'
    + ' return texture2D(uCloud,vec2(uv.x*uAsp,uv.y)/sc+vec2(uT*sp,dy));}'
    + 'void main(){'
    + ' vec2 uv=vUv;float sy=1.0-uv.y;'
    + ' vec3 col=grad(sy);'
    // Три слоя параллаксом: дальние медленнее и бледнее ближних
    + ' vec4 a=layer(uv,3.1,0.0022,0.02*sin(uT*0.07));col=mix(col,a.rgb,a.a*0.46);'
    + ' vec4 b=layer(uv,1.9,0.0052,0.03*sin(uT*0.09+1.0));col=mix(col,b.rgb,b.a*0.54);'
    + ' vec4 c=layer(uv,1.05,0.0115,0.04*sin(uT*0.06+2.0));col=mix(col,c.rgb,c.a*0.42);'
    // Солнце у горизонта: тёплое зарево плюс медленно дышащие лучи
    + ' vec2 sp=vec2(0.72,0.26);vec2 dv=(uv-sp)*vec2(uAsp,1.0);float d=length(dv);'
    + ' col+=vec3(1.0,0.79,0.5)*0.34*exp(-d*3.4);'
    + ' float an=atan(dv.y,dv.x);'
    + ' float ray=sin(an*7.0+uT*0.3)*sin(an*4.0-uT*0.19);'
    + ' col+=vec3(1.0,0.85,0.62)*pow(max(0.0,ray),3.0)*0.022*exp(-d*2.2);'
    + ' float vg=smoothstep(0.34,1.0,length((uv-vec2(0.5,0.5))*vec2(uAsp,1.0))/0.95);'
    + ' col=mix(col,vec3(0.29,0.13,0.086),vg*0.34);'
    + ' gl_FragColor=vec4(col,1.0);}';

  const VS_SPR = 'attribute vec2 aPos;attribute vec2 aLocal;attribute vec4 aCol;'
    + 'varying vec2 vL;varying vec4 vC;'
    + 'void main(){vL=aLocal;vC=aCol;gl_Position=vec4(aPos,0.0,1.0);}';

  // Лист — пересечение двух кругов: заострённая с двух концов долька
  const FS_LEAF = PREC
    + 'varying vec2 vL;varying vec4 vC;'
    + 'void main(){'
    + ' float d=max(length(vL-vec2(0.62,0.0))-1.0,length(vL+vec2(0.62,0.0))-1.0);'
    + ' float a=smoothstep(0.035,-0.012,d);'
    + ' if(a<=0.0) discard;'
    + ' float rib=smoothstep(0.06,0.0,abs(vL.x))*step(abs(vL.y),0.82);'
    + ' gl_FragColor=vec4(mix(vC.rgb,vC.rgb*0.6,rib*0.55),a*vC.a);}';

  // Ядро метабола: гладкое, обнуляется ровно на краю квадрата
  const FS_FIELD = PREC
    + 'varying vec2 vL;varying vec4 vC;'
    + 'void main(){float k=max(0.0,1.0-dot(vL,vL));float f=k*k*k*0.5*vC.a;'
    + ' gl_FragColor=vec4(f,0.0,0.0,f);}';

  // Вода как настоящая линза: из поля строится профиль купола, из него —
  // нормаль поверхности, а дальше преломление с показателем воды,
  // расхождение цвета по краю, блики Блинна-Фонга и Френель на кромке
  const FS_COMP = PREC
    + 'varying vec2 vUv;uniform sampler2D uField;uniform sampler2D uSky;'
    + 'uniform vec2 uPix;uniform float uT;'
    // Порог поля, во сколько условных пикселей переводится его перепад,
    // и радиус закругления кромки — им и задаётся толщина краёв
    + 'const float T=0.17;const float DS=6.0;const float ZR=2.2;'
    + 'float hgt(float d){if(d<=0.0)return 0.0;if(d>=ZR)return ZR;return sqrt(d*(2.0*ZR-d));}'
    + 'void main(){'
    + ' vec3 bg=texture2D(uSky,vUv).rgb;'
    + ' float f=texture2D(uField,vUv).r;'
    + ' if(f<T-0.06){gl_FragColor=vec4(bg,1.0);return;}'
    // Псевдоглубина внутрь капли: перепад поля переводим в условные пиксели,
    // поэтому картинка одинакова на любом разрешении экрана
    + ' float dC=(f-T)*DS;'
    + ' float e=1.0;'
    + ' float dL=(texture2D(uField,vUv-vec2(uPix.x*e,0.0)).r-T)*DS;'
    + ' float dR=(texture2D(uField,vUv+vec2(uPix.x*e,0.0)).r-T)*DS;'
    + ' float dU=(texture2D(uField,vUv+vec2(0.0,uPix.y*e)).r-T)*DS;'
    + ' float dD=(texture2D(uField,vUv-vec2(0.0,uPix.y*e)).r-T)*DS;'
    + ' vec2 hG=vec2(hgt(dR)-hgt(dL),hgt(dU)-hgt(dD))/(2.0*e);'
    + ' vec3 N=normalize(vec3(-hG,1.0));'
    + ' float mask=smoothstep(-0.16,0.16,dC);'
    + ' float edge=smoothstep(ZR,0.0,dC);'
    // Преломление на показателе воды 1.33
    + ' vec2 gin=vec2(dR-dL,dU-dD)/(2.0*e);'
    + ' float depth=smoothstep(0.0,ZR,dC);'
    + ' vec2 base=vUv+hG*0.248*26.0*uPix+gin*3.2*uPix;'
    // Расхождение цвета: у кромки стекло разводит красный и синий
    + ' vec2 ca=N.xy*(1.7*(edge*0.7+0.3))*uPix;'
    + ' vec3 col=vec3(texture2D(uSky,clamp(base+ca,0.002,0.998)).r,'
    + ' texture2D(uSky,clamp(base,0.002,0.998)).g,'
    + ' texture2D(uSky,clamp(base-ca,0.002,0.998)).b);'
    + ' col=mix(col,col*vec3(0.9,0.96,1.07),0.55);'
    + ' col*=1.0+0.1*depth;'
    // Два источника: узкий блик сверху и мягкий отражённый снизу
    + ' vec3 V=vec3(0.0,0.0,1.0);'
    + ' float s1=pow(max(dot(N,normalize(vec3(-0.42,0.62,0.66)+V)),0.0),90.0);'
    + ' float s2=pow(max(dot(N,normalize(vec3(0.35,-0.4,0.85)+V)),0.0),46.0)*0.32;'
    + ' float fres=pow(1.0-abs(N.z),4.0);'
    + ' col+=vec3((s1+s2)*1.15);'
    + ' col=mix(col,vec3(1.0),fres*0.17);'
    // Тонкая светлая кромка и бегущие по ней искры
    + ' float rim=smoothstep(0.34,0.0,dC)*step(0.0,dC);'
    + ' float sk=pow(max(0.0,sin((vUv.x*46.0-vUv.y*27.0)-uT*1.6)),26.0)*edge*0.45;'
    + ' col+=vec3(rim*0.16+sk);'
    + ' gl_FragColor=vec4(mix(bg,col,mask),1.0);}';

  function build(vs, fs) {
    const mk = (t, src) => {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aLocal');
    gl.bindAttribLocation(p, 2, 'aCol');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  let pSky, pLeaf, pField, pComp;
  try {
    pSky = build(VS_QUAD, FS_SKY);
    pLeaf = build(VS_SPR, FS_LEAF);
    pField = build(VS_SPR, FS_FIELD);
    pComp = build(VS_QUAD, FS_COMP);
  } catch (e) {
    return flat();
  }

  const uSky = { t: gl.getUniformLocation(pSky, 'uT'), asp: gl.getUniformLocation(pSky, 'uAsp'), cl: gl.getUniformLocation(pSky, 'uCloud') };
  const uCmp = {
    t: gl.getUniformLocation(pComp, 'uT'),
    pix: gl.getUniformLocation(pComp, 'uPix'), f: gl.getUniformLocation(pComp, 'uField'), s: gl.getUniformLocation(pComp, 'uSky'),
  };

  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  // Спрайты (капли и листья) льются одним динамическим буфером:
  // 8 чисел на вершину — позиция, локальные координаты, цвет с альфой
  const VSTRIDE = 8;
  let sprData = new Float32Array(VSTRIDE * 6 * 700);
  const sprBuf = gl.createBuffer();

  const cloudTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, cloudTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cloudCanvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);

  function makeFBO(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  /* ---------- размеры ----------
     Физика живёт в условном пространстве шириной SW=380 — все константы
     капель от разрешения экрана не зависят. Картинка же рисуется в полном
     разрешении устройства, вплоть до 4K. */
  const SW = 380;
  let W = 0, H = 0, dpr = 1, PW = 0, PH = 0, SH = 0, G = 1, cx = 0, cy = 0;
  let skyFBO = null, fieldFBO = null, dprCap = 2;

  function layout() {
    W = el.clientWidth || window.innerWidth;
    H = el.clientHeight || window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    PW = Math.max(2, Math.round(W * dpr));
    PH = Math.max(2, Math.round(H * dpr));
    wCv.width = PW; wCv.height = PH;
    SH = SW * H / W;
    G = Math.min(SW, SH) * 0.039;
    cx = SW / 2; cy = SH * 0.45;
    if (skyFBO) { gl.deleteTexture(skyFBO.tex); gl.deleteFramebuffer(skyFBO.fb); }
    if (fieldFBO) { gl.deleteTexture(fieldFBO.tex); gl.deleteFramebuffer(fieldFBO.fb); }
    skyFBO = makeFBO(PW, PH);
    // Поле гладкое по построению, поэтому ему хватает половины разрешения:
    // порог всё равно берётся в полном, и кромка воды остаётся чёткой
    const fw = Math.max(64, Math.min(1400, Math.round(PW * 0.5)));
    fieldFBO = makeFBO(fw, Math.max(64, Math.round(fw * PH / PW)));
    seedLeaves();
  }

  /* ---------- осенние листья ---------- */
  const leaves = [];
  const LEAF_COLORS = [[0.76, 0.35, 0.16], [0.85, 0.51, 0.19], [0.66, 0.25, 0.16], [0.88, 0.63, 0.24], [0.73, 0.42, 0.15]];
  function seedLeaves() {
    leaves.length = 0;
    const n = W < 640 ? 12 : 20;
    for (let i = 0; i < n; i++) {
      leaves.push({
        x: Math.random() * SW, y: Math.random() * SH,
        r: (2.6 + Math.random() * 3.4), sp: 4 + Math.random() * 7,
        sway: 0.5 + Math.random() * 1.2, ph: Math.random() * 6.3,
        rot: Math.random() * 6.3, spin: (Math.random() - 0.5) * 2.2,
        // Дальние листья мельче, бледнее и падают медленнее — глубина сцены
        depth: 0.45 + Math.random() * 0.55,
        c: LEAF_COLORS[i % LEAF_COLORS.length],
      });
    }
  }

  /* ---------- капли ---------- */
  const drops = [];
  let phase = 'flow';
  const rnd = Math.random;

  const addStatic = (x, y, r, decay) => drops.push({
    x, y, r, vx: 0, vy: 0, run: false, decay: decay || 0, seed: rnd() * 9,
    tx: 0, ty: 0, tr: 0, delay: 0, want: 0, dead: false, sx: 1, sy: 1,
  });
  const addRunner = () => drops.push({
    x: rnd() * SW, y: -3, r: 2.6 + rnd() * 4.4, vx: 0, vy: 5 + rnd() * 9,
    run: true, decay: 0, seed: rnd() * 9, tx: 0, ty: 0, tr: 0, delay: 0,
    want: 0, dead: false, sx: 1, sy: 1,
  });

  function seedGlass() {
    // Конденсат по всему стеклу: бегущие капли будут его собирать
    const n = Math.round(SW * SH / 1150);
    for (let i = 0; i < n; i++) addStatic(rnd() * SW, rnd() * SH, 1.3 + rnd() * 2.2, 0);
    for (let i = 0; i < 7; i++) addRunner();
  }

  function step(dt, t) {
    const f = Math.min(dt * 60, 2.4);
    if (phase === 'flow') {
      if (rnd() < dt * 22) addRunner();
      for (const d of drops) {
        if (d.dead) continue;
        if (d.run) {
          d.vy += 21 * dt;
          const vmax = 26 + d.r * 6;
          if (d.vy > vmax) d.vy = vmax;
          // Лёгкое рыскание: настоящая капля не едет строго вниз
          d.vx += (Math.sin(t * 1.9 + d.seed) * 0.9 - d.vx) * 0.08 * f;
          d.x += d.vx * f; d.y += d.vy * f;
          // Мокрый след: капля оставляет за собой мельчающие точки
          d.tr -= dt;
          if (d.tr <= 0 && d.r > 1.5) {
            d.tr = 0.025 + rnd() * 0.035;
            addStatic(d.x + (rnd() - 0.5), d.y, d.r * (0.34 + rnd() * 0.16), 0.7 + rnd() * 0.9);
            d.r *= 0.988;
          }
          if (d.y > SH + 6) d.dead = true;
        } else if (d.decay) {
          d.r -= d.decay * dt;
          if (d.r < 0.55) d.dead = true;
        }
      }
      // Слипание: бегущая капля вбирает всё, до чего дотянулась, и растёт
      for (const a of drops) {
        if (a.dead || !a.run) continue;
        for (const b of drops) {
          if (b.dead || b.run) continue;
          const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r * 0.7;
          if (dx * dx + dy * dy < rr * rr) {
            a.r = Math.cbrt(a.r * a.r * a.r + b.r * b.r * b.r);
            b.dead = true;
          }
        }
      }
    } else {
      // Дальше вода живёт пружиной к цели. Демпфирование чуть меньше единицы —
      // капли слегка проскакивают мимо цели, и вода выглядит живой
      const fast = phase === 'dots' || phase === 'scatter';
      const k = fast ? 0.05 : 0.019;
      const damp = Math.pow(fast ? 0.78 : 0.895, f);
      for (const d of drops) {
        if (d.dead) continue;
        if (d.delay > 0) { d.delay -= dt; continue; }
        d.vx += (d.tx - d.x) * k * f;
        d.vy += (d.ty - d.y) * k * f;
        d.vx *= damp; d.vy *= damp;
        d.x += d.vx * f; d.y += d.vy * f;
        if (d.want) d.r += (d.want - d.r) * 0.1 * f;
      }
    }

    // Поверхностное натяжение: каждая капля еле заметно дышит, а падающая
    // вытягивается по скорости — без этого вода выглядит мёртвой
    for (const d of drops) {
      if (d.dead) continue;
      const wob = Math.sin(t * 5.5 + d.seed * 2.1) * 0.055;
      const stretch = d.run ? Math.min(d.vy / 26, 0.8) : 0;
      d.sx = 1 - wob - stretch * 0.28;
      d.sy = 1 + wob + stretch * 0.75;
    }
  }

  // К моменту сбора капель много и они разного калибра — сводим их к ровному
  // набору, переливая объём в оставшиеся, иначе фигуры получатся рябыми
  function condense(n) {
    const live = drops.filter((d) => !d.dead);
    live.sort((a, b) => b.r - a.r);
    const keep = live.slice(0, n);
    let extra = 0;
    for (const d of live.slice(n)) { extra += d.r * d.r * d.r; d.dead = true; }
    const share = keep.length ? extra / keep.length : 0;
    for (const d of keep) {
      d.r = Math.min(Math.cbrt(d.r * d.r * d.r + share), 0.5 * G);
      d.run = false; d.decay = 0;
    }
    drops.length = 0;
    for (const d of keep) drops.push(d);
    return keep;
  }

  /* ---------- кольцо ---------- */
  let ring = [];
  function toRing() {
    ring = condense(112);
    ring.forEach((d, i) => {
      // Разрыв в 20% окружности превращает кольцо в узнаваемый спиннер
      d.ang = i / ring.length * Math.PI * 1.6 + rnd() * 0.03;
      d.rad = (2.55 + (rnd() - 0.5) * 0.16) * G;
      d.want = 0.42 * G;
    });
  }
  function ringTargets(t) {
    const pulse = 1 + Math.sin(t * 3.1) * 0.06;
    for (const d of ring) {
      if (d.dead) continue;
      const a = d.ang + t * 2.2;
      d.tx = cx + Math.cos(a) * d.rad * pulse;
      d.ty = cy + Math.sin(a) * d.rad * pulse * 0.96;
    }
  }

  /* ---------- три капли-ожидания ---------- */
  function toDots() {
    const live = condense(99);
    const per = Math.max(1, Math.floor(live.length / 3) - 1);
    live.forEach((d, i) => {
      d.grp = i % 3;
      const k = Math.floor(i / 3) / per;
      const a = k * 12.9, rr = Math.sqrt(Math.min(k, 1)) * 0.66 * G;
      d.ox = Math.cos(a) * rr; d.oy = Math.sin(a) * rr;
      d.want = 0.44 * G;
      d.vx *= 0.4; d.vy *= 0.4;
    });
  }
  function dotTargets(t) {
    for (const d of drops) {
      if (d.dead || d.grp === undefined) continue;
      // Капли прыгают по очереди; у земли каплю сплющивает, как настоящую
      const up = Math.abs(Math.sin(t * 3.3 - d.grp * 0.62));
      const sq = Math.max(0, 1 - up * 3.4);
      d.tx = cx + (d.grp - 1) * 2.5 * G + d.ox * (1 + sq * 0.42);
      d.ty = cy + 0.85 * G - up * 2.6 * G + d.oy * (1 - sq * 0.45) + sq * 0.3 * G;
    }
  }

  /* ---------- лицо ---------- */
  const bez = (t, x0, y0, x1, y1, x2, y2) => {
    const u = 1 - t;
    return [u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2];
  };

  function toFace() {
    const live = drops.filter((d) => !d.dead);
    const eyes = Math.round(live.length * 0.29);
    live.forEach((d, i) => {
      d.grp = undefined;
      d.vx *= 0.3; d.vy *= 0.3;
      if (i < eyes * 2) {
        // Два глаза: точки раскладываем по спирали — диск заполняется ровно
        const side = i % 2 ? 1 : -1;
        const k = Math.floor(i / 2) / Math.max(1, eyes - 1);
        const rr = Math.sqrt(k) * 0.62 * G, aa = k * 12.9;
        d.eye = 1;
        d.ecx = cx + side * 2.1 * G; d.ecy = cy - 1.0 * G;
        d.ox = Math.cos(aa) * rr; d.oy = Math.sin(aa) * rr;
        d.want = 0.4 * G; d.delay = 0.04 + k * 0.1;
      } else {
        // Улыбка «рисуется» слева направо: чем правее точка, тем позже старт
        const k = (i - eyes * 2) / Math.max(1, live.length - eyes * 2 - 1);
        const m = bez(k, cx - 2.45 * G, cy + 0.75 * G, cx, cy + 3.3 * G, cx + 2.45 * G, cy + 0.75 * G);
        d.eye = 0; d.fx = m[0]; d.fy = m[1];
        d.want = 0.36 * G; d.delay = 0.1 + k * 0.34;
      }
    });
  }
  // Последняя сцена: вода расходится по всему экрану и медленно дышит —
  // она становится фоном, на котором показываются спонсоры
  function toScatter() {
    for (const d of drops) {
      if (d.dead) continue;
      d.eye = 0; d.fx = undefined; d.grp = undefined;
      const a = rnd() * Math.PI * 2, rr = 0.46 + rnd() * 0.62;
      d.hx = Math.min(SW - 6, Math.max(6, cx + Math.cos(a) * SW * 0.52 * rr));
      d.hy = Math.min(SH - 6, Math.max(6, cy + Math.sin(a) * SH * 0.58 * rr));
      d.want = 1.5 + rnd() * 2.6;
      d.delay = rnd() * 0.3; d.seed = rnd() * 9;
      d.vx *= 0.4; d.vy *= 0.4;
    }
  }
  function scatterTargets(t) {
    for (const d of drops) {
      if (d.dead || d.hx === undefined) continue;
      d.tx = d.hx + Math.sin(t * 0.5 + d.seed) * 2.6;
      d.ty = d.hy + Math.cos(t * 0.43 + d.seed * 1.3) * 2.6;
    }
  }

  function faceTargets(t, since) {
    const bob = Math.sin(t * 2.2) * 0.16 * G;
    // Моргание: короткое схлопывание глаз примерно раз в две секунды
    const bt = (since - 0.75) % 2.1;
    const blink = bt > 0 && bt < 0.16 ? Math.sin(bt / 0.16 * Math.PI) : 0;
    for (const d of drops) {
      if (d.dead) continue;
      if (d.eye) {
        d.tx = d.ecx + d.ox * (1 + blink * 0.2);
        d.ty = d.ecy + d.oy * (1 - blink * 0.88) + bob;
      } else if (d.fx !== undefined) {
        d.tx = d.fx; d.ty = d.fy + bob;
      }
    }
  }

  /* ---------- отрисовка ---------- */
  function bindSprites(n) {
    gl.bindBuffer(gl.ARRAY_BUFFER, sprBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sprData.subarray(0, n * VSTRIDE), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2);
    const S = VSTRIDE * 4;
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, S, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 8);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, S, 16);
  }
  // Квад из двух треугольников: центр в физических координатах, полуоси в них же
  function pushQuad(o, x, y, rx, ry, rot, r, g, b, a) {
    const cxx = x / SW * 2 - 1, cyy = 1 - y / SH * 2;
    const ax = rx / SW * 2, ay = ry / SH * 2;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const c of corners) {
      const lx = c[0], ly = c[1];
      sprData[o] = cxx + (lx * cs - ly * sn) * ax;
      sprData[o + 1] = cyy + (lx * sn + ly * cs) * ay;
      sprData[o + 2] = lx; sprData[o + 3] = ly;
      sprData[o + 4] = r; sprData[o + 5] = g; sprData[o + 6] = b; sprData[o + 7] = a;
      o += VSTRIDE;
    }
    return o;
  }

  function drawFrame(t, dt) {
    gl.disable(gl.DEPTH_TEST);

    // 1) небо в свою текстуру
    gl.bindFramebuffer(gl.FRAMEBUFFER, skyFBO.fb);
    gl.viewport(0, 0, skyFBO.w, skyFBO.h);
    gl.disable(gl.BLEND);
    gl.useProgram(pSky);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, cloudTex);
    gl.uniform1i(uSky.cl, 0); gl.uniform1f(uSky.t, t); gl.uniform1f(uSky.asp, W / H);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0);
    gl.disableVertexAttribArray(1); gl.disableVertexAttribArray(2);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) листья поверх неба
    let o = 0;
    for (const l of leaves) {
      l.y += l.sp * l.depth * dt;
      l.x += Math.sin(t * l.sway + l.ph) * 7 * dt;
      l.rot += l.spin * dt;
      if (l.y > SH + 8) { l.y = -8; l.x = Math.random() * SW; }
      const r = l.r * l.depth;
      o = pushQuad(o, l.x, l.y, r * 0.62, r, l.rot, l.c[0], l.c[1], l.c[2], 0.35 + l.depth * 0.5);
    }
    if (o) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(pLeaf);
      bindSprites(o / VSTRIDE);
      gl.drawArrays(gl.TRIANGLES, 0, o / VSTRIDE);
    }

    // 3) поле воды: капли складываются аддитивно
    gl.bindFramebuffer(gl.FRAMEBUFFER, fieldFBO.fb);
    gl.viewport(0, 0, fieldFBO.w, fieldFBO.h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    o = 0;
    const maxV = sprData.length / VSTRIDE - 6;
    for (const d of drops) {
      if (d.dead || o / VSTRIDE > maxV) continue;
      const R = d.r * 2.15;
      o = pushQuad(o, d.x, d.y, R * d.sx, R * d.sy, 0, 0, 0, 0, 1);
    }
    if (o) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(pField);
      bindSprites(o / VSTRIDE);
      gl.drawArrays(gl.TRIANGLES, 0, o / VSTRIDE);
    }

    // 4) сведение: вода поверх неба, уже в разрешении экрана
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, PW, PH);
    gl.disable(gl.BLEND);
    gl.useProgram(pComp);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fieldFBO.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, skyFBO.tex);
    gl.uniform1i(uCmp.f, 0); gl.uniform1i(uCmp.s, 1);
    gl.uniform2f(uCmp.pix, 1 / SW, 1 / SH);
    gl.uniform1f(uCmp.t, t);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0);
    gl.disableVertexAttribArray(1); gl.disableVertexAttribArray(2);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ---------- сцена ----------
     Дождь → кольцо → три прыгающие капли (пока не придут данные, но не
     меньше DOTS_UNTIL) → улыбка. Полный проход занимает от 10 секунд. */
  const T_FLOW = 1600, T_RING = 2900, DOTS_UNTIL = 3800, FACE_DUR = 1800, SPON_DUR = 2600;
  let start = 0, prev = 0, slowFrames = 0, downgraded = false, faceAt = 0, sponAt = 0;
  layout(); seedGlass();

  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const oh = SH; layout();
      for (const d of drops) d.y = d.y / oh * SH;
      if (phase === 'face') toFace();
      else if (phase === 'dots') toDots();
    }, 180);
  };
  window.addEventListener('resize', onResize);

  api.done = new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    function frame(now) {
      if (!start) { start = now; prev = now; }
      if (!el.isConnected || el.classList.contains('out')) {
        window.removeEventListener('resize', onResize);
        finish();
        return;
      }
      const dt = Math.min((now - prev) / 1000, 0.05);
      prev = now;
      const ms = now - start, t = ms / 1000;

      // Если кадры не вытягивают, один раз опускаем разрешение картинки
      if (!downgraded && ms > 900) {
        if (dt > 0.032) slowFrames++; else slowFrames = Math.max(0, slowFrames - 1);
        if (slowFrames > 26) { downgraded = true; dprCap = 1; layout(); }
      }

      if (phase === 'flow' && ms >= T_FLOW) { phase = 'ring'; toRing(); }
      else if (phase === 'ring' && ms >= T_RING) { phase = 'dots'; toDots(); }
      else if (phase === 'dots' && ms >= DOTS_UNTIL && dataOk) {
        phase = 'face'; faceAt = ms; toFace();
      } else if (phase === 'face' && ms >= faceAt + FACE_DUR) {
        phase = 'scatter'; sponAt = ms; toScatter();
        el.classList.add('sponsors-on');
      } else if (phase === 'face' && !el.classList.contains('done') && ms >= faceAt + FACE_DUR - 700) {
        el.classList.add('done');
        if (txt) txt.textContent = 'Готово';
      }

      step(dt, t);
      if (phase === 'ring') ringTargets(t);
      else if (phase === 'dots') dotTargets(t);
      else if (phase === 'face') faceTargets(t, (ms - faceAt) / 1000);
      else if (phase === 'scatter') scatterTargets(t);

      drawFrame(t, dt);

      if (phase === 'scatter' && ms >= sponAt + SPON_DUR) finish();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  return api;
})();

function hideLoader() {
  const el = document.getElementById('loader');
  if (!el) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 600);
}
