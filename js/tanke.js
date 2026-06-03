// Caras "Tanke" rebotando por la pantalla del login (estilo DVD).
// Rebotan contra los bordes del contenedor y contra la tarjeta de login.
(function () {
  const wrap = document.getElementById('view-login');
  const field = wrap && wrap.querySelector('.tanke-field');
  const card = wrap && wrap.querySelector('.login-card');
  if (!wrap || !field || !card) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // En mobile la card ocupa casi todo: las caras flotan por delante y pasan
  // por encima (sin esquivarla ni rebotar contra ella) para que se vean.
  const mobileMQ = window.matchMedia('(max-width: 620px)');

  // Estado por cada cara: posición (x,y) y velocidad (vx,vy) en px/seg.
  let faces = [];

  function bounds() {
    return { w: wrap.clientWidth, h: wrap.clientHeight };
  }

  // Rect de la tarjeta relativo al contenedor.
  function cardRect() {
    const c = card.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    return { left: c.left - w.left, top: c.top - w.top, right: c.right - w.left, bottom: c.bottom - w.top };
  }

  function setup() {
    const els = Array.from(field.querySelectorAll('.tanke'));
    const { w, h } = bounds();
    const card = cardRect();
    faces = els.map((el) => {
      // Saltea las ocultas (display:none en mobile).
      const visible = el.offsetParent !== null;
      const size = el.offsetWidth || 64;
      const speed = 55 + Math.random() * 55; // px/seg
      const ang = Math.random() * Math.PI * 2;
      let x, y, tries = 0;
      do {
        x = Math.random() * (w - size);
        y = Math.random() * (h - size);
        tries++;
      } while (!mobileMQ.matches && tries < 30 && overlapsCard({ x, y, size }, card));
      return { el, visible, size, x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed };
    });
  }

  function overlapsCard(f, c) {
    return f.x < c.right && f.x + f.size > c.left && f.y < c.bottom && f.y + f.size > c.top;
  }

  let last = 0;
  function step(ts) {
    if (!running) return;
    if (!last) last = ts;
    let dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.05) dt = 0.05; // clamp si la pestaña estuvo en 2do plano

    const { w, h } = bounds();
    const c = cardRect();

    for (const f of faces) {
      if (!f.visible) continue;
      f.x += f.vx * dt;
      f.y += f.vy * dt;

      // Rebote contra los bordes del contenedor.
      if (f.x <= 0) { f.x = 0; f.vx = Math.abs(f.vx); }
      else if (f.x + f.size >= w) { f.x = w - f.size; f.vx = -Math.abs(f.vx); }
      if (f.y <= 0) { f.y = 0; f.vy = Math.abs(f.vy); }
      else if (f.y + f.size >= h) { f.y = h - f.size; f.vy = -Math.abs(f.vy); }

      // Rebote contra la tarjeta: resuelve por el eje de menor penetración.
      // En mobile no rebota: pasa por encima de la card (capa por delante).
      if (!mobileMQ.matches && f.x < c.right && f.x + f.size > c.left && f.y < c.bottom && f.y + f.size > c.top) {
        const penL = c.right - f.x;          // empujar a la derecha
        const penR = f.x + f.size - c.left;  // empujar a la izquierda
        const penT = c.bottom - f.y;         // empujar hacia abajo
        const penB = f.y + f.size - c.top;   // empujar hacia arriba
        const min = Math.min(penL, penR, penT, penB);
        if (min === penR) { f.x = c.left - f.size; f.vx = -Math.abs(f.vx); }
        else if (min === penL) { f.x = c.right; f.vx = Math.abs(f.vx); }
        else if (min === penB) { f.y = c.top - f.size; f.vy = -Math.abs(f.vy); }
        else { f.y = c.bottom; f.vy = Math.abs(f.vy); }
      }

      f.el.style.transform = `translate(${f.x}px, ${f.y}px)`;
    }
    raf = requestAnimationFrame(step);
  }

  let raf = 0, running = false;
  function start() {
    if (running || reduce) return;
    running = true; last = 0;
    raf = requestAnimationFrame(step);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // Arranca sólo cuando el login está visible; pausa cuando se oculta.
  function sync() {
    const visible = !wrap.classList.contains('hidden');
    if (visible) { setup(); start(); } else { stop(); }
  }

  // Observa cambios de clase (.hidden) sobre la vista de login.
  const mo = new MutationObserver(sync);
  mo.observe(wrap, { attributes: true, attributeFilter: ['class'] });

  window.addEventListener('resize', () => { if (running) setup(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (!wrap.classList.contains('hidden')) start();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sync);
  } else {
    sync();
  }
})();
