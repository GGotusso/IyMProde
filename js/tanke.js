// Caras "Tanke" rebotando por la pantalla (estilo DVD).
// Se usa en dos lugares: el login (rebotan contra la tarjeta) y como capa
// de fondo sutil del menú principal (pantalla completa, sin tarjeta).
(function () {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // En mobile la card del login ocupa casi todo: las caras flotan por delante
  // y pasan por encima (sin esquivarla ni rebotar contra ella) para que se vean.
  const mobileMQ = window.matchMedia('(max-width: 620px)');

  // Crea un "rebotador" sobre un contenedor. cfg:
  //   wrap        -> elemento que define los límites (se mide su client*)
  //   field       -> elemento que contiene las caras .tanke
  //   card        -> tarjeta a esquivar/rebotar (o null)
  //   isVisible   -> fn() => bool: si la animación debe correr
  //   ignoreCardMobile -> en mobile ignora la card (pasa por encima)
  //   hideWhenIdle     -> oculta el field (display) cuando no está activo
  function makeBouncer(cfg) {
    const { wrap, field, card } = cfg;
    let faces = [];
    let raf = 0, running = false, last = 0;

    function bounds() { return { w: wrap.clientWidth, h: wrap.clientHeight }; }

    // Rect de la tarjeta relativo al contenedor.
    function cardRect() {
      if (!card) return null;
      const c = card.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      return { left: c.left - w.left, top: c.top - w.top, right: c.right - w.left, bottom: c.bottom - w.top };
    }

    function overlapsCard(f, c) {
      return c && f.x < c.right && f.x + f.size > c.left && f.y < c.bottom && f.y + f.size > c.top;
    }

    function useCard() {
      return card && !(cfg.ignoreCardMobile && mobileMQ.matches);
    }

    function setup() {
      const els = Array.from(field.querySelectorAll('.tanke'));
      const { w, h } = bounds();
      const c = cardRect();
      const avoid = useCard();
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
        } while (avoid && tries < 30 && overlapsCard({ x, y, size }, c));
        return { el, visible, size, x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed };
      });
    }

    function step(ts) {
      if (!running) return;
      if (!last) last = ts;
      let dt = (ts - last) / 1000;
      last = ts;
      if (dt > 0.05) dt = 0.05; // clamp si la pestaña estuvo en 2do plano

      const { w, h } = bounds();
      const c = cardRect();
      const collide = useCard();

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
        if (collide && f.x < c.right && f.x + f.size > c.left && f.y < c.bottom && f.y + f.size > c.top) {
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

    function sync() {
      if (cfg.isVisible()) {
        if (cfg.hideWhenIdle) field.style.display = '';
        setup();
        start();
      } else {
        stop();
        if (cfg.hideWhenIdle) field.style.display = 'none';
      }
    }

    window.addEventListener('resize', () => { if (running) setup(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (cfg.isVisible()) start();
    });

    return { sync };
  }

  // ===== Login: rebotan contra la tarjeta =====
  const loginWrap = document.getElementById('view-login');
  if (loginWrap) {
    const field = loginWrap.querySelector('.tanke-field');
    const card = loginWrap.querySelector('.login-card');
    if (field && card) {
      const b = makeBouncer({
        wrap: loginWrap, field, card, ignoreCardMobile: true,
        isVisible: () => !loginWrap.classList.contains('hidden'),
      });
      new MutationObserver(b.sync).observe(loginWrap, { attributes: true, attributeFilter: ['class'] });
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', b.sync);
      else b.sync();
    }
  }

  // ===== Fondo del menú principal: pantalla completa, sin tarjeta =====
  const bg = document.getElementById('tanke-bg');
  const topbar = document.getElementById('topbar');
  if (bg && topbar) {
    const b = makeBouncer({
      wrap: bg, field: bg, card: null, hideWhenIdle: true,
      isVisible: () => !topbar.classList.contains('hidden'),
    });
    new MutationObserver(b.sync).observe(topbar, { attributes: true, attributeFilter: ['class'] });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', b.sync);
    else b.sync();
  }
})();
