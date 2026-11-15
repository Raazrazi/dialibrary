(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

  /* ---------- live numbers from the server (falls back to sensible defaults) ---------- */
  const data = { titles: 44, items: 105, subjects: 35, loanDays: 14, graceDays: 1, finePerDay: 2, maxFine: 200, currency: '₹', libraryName: null, tagline: null };
  const ready = fetch('/api/public/stats').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) Object.assign(data, j); }).catch(() => {});

  ready.then(() => {
    if (data.libraryName) {
      $$('[data-lib-name]').forEach((e) => (e.textContent = data.libraryName));
      document.title = data.libraryName;
    }
    if (data.tagline) $$('[data-lib-tagline]').forEach((e) => (e.textContent = data.tagline));
    setupCalc();
    countObserver();
  });

  /* ---------- count up ---------- */
  function countObserver() {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      const el = $('[data-count]', e.target) || e.target;
      const to = Number(data[el.dataset.count]) || 0;
      if (still) { el.textContent = to.toLocaleString(); return; }
      const t0 = performance.now(), dur = 1400;
      (function tick(t) {
        const p = clamp((t - t0) / dur), eased = 1 - Math.pow(1 - p, 4);
        el.textContent = Math.round(to * eased).toLocaleString();
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    }), { threshold: 0.4 });
    $$('.num').forEach((n) => io.observe(n));
  }

  /* ---------- reveal on scroll ---------- */
  const rio = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); rio.unobserve(e.target); }
  }), { threshold: 0.15, rootMargin: '0px 0px -6% 0px' });
  $$('.reveal').forEach((el, i) => {
    // light stagger for siblings that enter together
    el.style.setProperty('--d', `${(i % 4) * 0.07}s`);
    rio.observe(el);
  });

  /* ---------- progress bar + sticky nav ---------- */
  const bar = $('#progress'), nav = $('#nav');
  /* ---------- the journey: a book that travels a winding path as you scroll ---------- */
  const journey = $('#journey'), trail = $('.trail', journey), base = $('#trailBase'), done = $('#trailDone'), traveler = $('#traveler');
  const chapters = $$('.chapter', journey);
  let pathLen = 0;
  const KEYS = [[.5, 0], [.14, .17], [.86, .34], [.14, .52], [.86, .69], [.5, .86], [.5, 1]];

  function buildPath() {
    const W = trail.clientWidth, H = trail.clientHeight;
    if (!W || !H) return;
    trail.setAttribute('viewBox', `0 0 ${W} ${H}`);
    trail.setAttribute('preserveAspectRatio', 'none');
    const pts = KEYS.map(([x, y]) => [x * W, y * H]);
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], dy = (y1 - y0) / 2;
      d += ` C${x0} ${y0 + dy} ${x1} ${y1 - dy} ${x1} ${y1}`;
    }
    base.setAttribute('d', d); done.setAttribute('d', d);
    pathLen = done.getTotalLength();
    done.style.strokeDasharray = pathLen;
    update();
  }

  function update() {
    const y = scrollY, h = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${h > 0 ? clamp(y / h) : 0})`;
    nav.classList.toggle('stuck', y > 24);

    if (!pathLen) return;
    const jr = journey.getBoundingClientRect();
    const focus = innerHeight * 0.55;
    const p = clamp((focus - jr.top) / jr.height);
    done.style.strokeDashoffset = pathLen * (1 - p);
    const pt = done.getPointAtLength(pathLen * p);
    const ahead = done.getPointAtLength(Math.min(pathLen, pathLen * p + 2));
    const tr = trail.getBoundingClientRect();
    const x = tr.left - jr.left + pt.x * (tr.width / trail.clientWidth);
    const yy = pt.y * (tr.height / trail.clientHeight);
    const angle = Math.atan2(ahead.x - pt.x, ahead.y - pt.y) * -45 / Math.PI * 0.9;
    traveler.style.transform = `translate(${x}px, ${yy}px) rotate(${angle}deg)`;
    traveler.style.opacity = p > 0.005 && p < 0.998 ? 1 : (p >= 0.998 ? 1 : 0.0);
    chapters.forEach((c) => {
      const r = c.getBoundingClientRect();
      c.classList.toggle('is-active', r.top < focus && r.bottom > innerHeight * 0.2);
    });
  }
  let ticking = false;
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; update(); }); } };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => { buildPath(); sizePetals(); });
  buildPath();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildPath);

  /* ---------- hero: pointer parallax + glow + petals ---------- */
  const hero = $('.hero'), art = $('#heroArt'), glow = $('#glow');
  if (!still) {
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      glow.style.setProperty('--gx', `${e.clientX - r.left}px`);
      glow.style.setProperty('--gy', `${e.clientY - r.top}px`);
      const a = art.getBoundingClientRect();
      art.style.setProperty('--mx', clamp((e.clientX - (a.left + a.width / 2)) / (innerWidth / 2), -1, 1).toFixed(3));
      art.style.setProperty('--my', clamp((e.clientY - (a.top + a.height / 2)) / (innerHeight / 2), -1, 1).toFixed(3));
    });
    hero.addEventListener('pointerleave', () => { art.style.setProperty('--mx', 0); art.style.setProperty('--my', 0); });
  }

  const cv = $('#petals'), ctx = cv.getContext('2d');
  let petals = [], dpr = 1, W = 0, H = 0;
  function sizePetals() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(clamp(W / 38, 12, 34));
    petals = Array.from({ length: n }, () => mkPetal(true));
  }
  function mkPetal(anywhere) {
    return {
      x: Math.random() * W, y: anywhere ? Math.random() * H : -20,
      s: 6 + Math.random() * 14, v: 0.12 + Math.random() * 0.35, sw: Math.random() * Math.PI * 2, r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.012, kind: Math.random() < 0.35 ? 'page' : 'dot', a: 0.25 + Math.random() * 0.4,
      c: ['#ff8e9a', '#ffb3bb', '#ffd0d5', '#d7263d'][Math.floor(Math.random() * 4)],
    };
  }
  function frame() {
    ctx.clearRect(0, 0, W, H);
    for (const p of petals) {
      p.y += p.v; p.sw += 0.012; p.x += Math.sin(p.sw) * 0.35; p.r += p.vr;
      if (p.y > H + 24) Object.assign(p, mkPetal(false), { x: Math.random() * W });
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = p.a; ctx.fillStyle = p.c;
      if (p.kind === 'dot') { ctx.beginPath(); ctx.arc(0, 0, p.s / 2.6, 0, 6.283); ctx.fill(); }
      else { ctx.beginPath(); ctx.roundRect(-p.s / 2, -p.s * 0.65, p.s, p.s * 1.3, 2.5); ctx.fill(); ctx.globalAlpha = p.a * 0.7; ctx.fillStyle = '#fff'; ctx.fillRect(-p.s / 3, -p.s * 0.3, p.s * 0.66, 1.4); ctx.fillRect(-p.s / 3, 0, p.s * 0.45, 1.4); }
      ctx.restore();
    }
    raf = requestAnimationFrame(frame);
  }
  let raf = 0;
  sizePetals();
  if (!still) {
    raf = requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', () => { cancelAnimationFrame(raf); if (!document.hidden) raf = requestAnimationFrame(frame); });
  }

  /* ---------- tilt on role cards ---------- */
  if (!still) $$('[data-tilt]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--ry', `${((e.clientX - r.left) / r.width - 0.5) * 7}deg`);
      el.style.setProperty('--rx', `${-((e.clientY - r.top) / r.height - 0.5) * 7}deg`);
    });
    el.addEventListener('pointerleave', () => { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); });
  });

  /* ---------- fine calculator ---------- */
  function setupCalc() {
    const range = $('#late'), out = $('#lateOut');
    const cur = data.currency, grace = data.graceDays, rate = data.finePerDay, cap = data.maxFine;
    const capDays = rate > 0 ? Math.ceil(cap / rate) + grace : Infinity;
    range.max = String(Math.max(60, Math.min(capDays + 10, 180)));
    $('#cGrace').textContent = `${grace} ${grace === 1 ? 'day' : 'days'}`;
    $('#cRate').textContent = `${cur}${rate}`;
    const calc = () => {
      const late = Number(range.value);
      const billable = Math.max(0, late - grace);
      const raw = billable * rate, fine = Math.min(raw, cap), capped = raw > cap;
      out.textContent = late;
      $('#cBill').textContent = billable;
      $('#cTotal').textContent = `${cur}${fine}`;
      $('#cNote').textContent = capped ? `Capped. A book never costs more than ${cur}${cap} in fines.`
        : late === 0 ? 'Returned on time. No fine at all.'
        : late <= grace ? 'Inside the grace period. No fine.'
        : `The fine stops growing at ${cur}${cap} per book.`;
      const max = Number(range.max);
      const gW = Math.min(late, grace), bW = Math.min(billable, Math.max(0, capDays - grace)), cW = capped ? late - capDays : 0;
      $('#segGrace').style.width = `${(gW / max) * 100}%`;
      $('#segBill').style.width = `${(bW / max) * 100}%`;
      $('#segCap').style.width = `${(Math.max(cW, 0) / max) * 100}%`;
    };
    range.addEventListener('input', calc); calc();
  }
})();
