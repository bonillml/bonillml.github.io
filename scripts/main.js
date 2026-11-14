/*
Author: Matt Bonilla
Shared behavior for every page. Each feature only runs if its elements exist.
*/

var globe = globe || {};

/* Dropdown menus: click to toggle, Escape or outside click to close */
globe.initDropdowns = function ()
{
    const dropdowns = document.querySelectorAll('.mb-dropdown');

    const close = (dd) =>
    {
        dd.querySelector('.mb-menu').classList.remove('is-open');
        dd.querySelector('[aria-haspopup]').setAttribute('aria-expanded', 'false');
    };

    dropdowns.forEach((dd) =>
    {
        const btn = dd.querySelector('[aria-haspopup]');
        const menu = dd.querySelector('.mb-menu');

        btn.addEventListener('click', () =>
        {
            const open = !menu.classList.contains('is-open');
            dropdowns.forEach(close);
            if (open)
            {
                menu.classList.add('is-open');
                btn.setAttribute('aria-expanded', 'true');
            }
        });
    });

    document.addEventListener('click', (e) => dropdowns.forEach((dd) => { if (!dd.contains(e.target)) close(dd); }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dropdowns.forEach(close); });
};

/* Back-to-top: appears after the user scrolls up a little */
globe.initBackToTop = function ()
{
    const btn = document.getElementById('mb-back-to-top-btn');
    if (!btn) return;

    const THRESH = 100;
    let lastY = window.scrollY;
    let upDist = 0;
    let paused = false;

    btn.addEventListener('click', () =>
    {
        paused = true;
        upDist = 0;
        btn.classList.remove('visible');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => { paused = false; lastY = window.scrollY; }, 700);
    });

    window.addEventListener('scroll', () =>
    {
        if (paused) return;
        const y = window.scrollY;

        if (y < lastY) upDist += lastY - y;
        else { upDist = 0; btn.classList.remove('visible'); }

        if (upDist > THRESH && y > 100) btn.classList.add('visible');
        if (y <= 100) { upDist = 0; btn.classList.remove('visible'); }

        lastY = y;
    }, { passive: true });
};

/* Career rows: the row nearest the middle of the screen is highlighted */
globe.initRows = function ()
{
    const lists = document.querySelectorAll('.mb-rows');
    if (!lists.length) return;

    const update = () =>
    {
        const mid = window.innerHeight / 2;

        lists.forEach((list) =>
        {
            const r = list.getBoundingClientRect();
            const visible = r.top < window.innerHeight && r.bottom > 0;
            list.classList.toggle('is-tracking', visible);
            if (!visible) return;

            let best = null, bestDist = Infinity;
            list.querySelectorAll('.mb-row').forEach((row) =>
            {
                const b = row.getBoundingClientRect();
                const d = Math.abs(b.top + b.height / 2 - mid);
                if (d < bestDist) { bestDist = d; best = row; }
                row.classList.remove('is-active');
            });
            if (best) best.classList.add('is-active');
        });
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
};

/* Carousel: prev/next buttons on top of a scroll-snap track */
globe.initCarousels = function ()
{
    document.querySelectorAll('.mb-carousel').forEach((carousel) =>
    {
        const track = carousel.querySelector('.mb-carousel-track');
        const slides = Array.from(track.children);
        const prev = carousel.querySelector('[data-carousel="prev"]');
        const next = carousel.querySelector('[data-carousel="next"]');

        const current = () => slides.reduce((best, s, i) =>
            Math.abs(s.offsetLeft - track.offsetLeft - track.scrollLeft) <
            Math.abs(slides[best].offsetLeft - track.offsetLeft - track.scrollLeft) ? i : best, 0);

        const goTo = (i) =>
        {
            const t = slides[Math.max(0, Math.min(slides.length - 1, i))];
            track.scrollTo({ left: t.offsetLeft - track.offsetLeft, behavior: 'smooth' });
        };

        const update = () =>
        {
            prev.disabled = track.scrollLeft <= 4;
            next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
        };

        prev.addEventListener('click', () => goTo(current() - 1));
        next.addEventListener('click', () => goTo(current() + 1));
        track.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        update();
    });
};

/* Hero: a scrolling digital timing diagram (clock + two data lines).
   Moving the mouse speeds it up and brightens the nearest trace. */
globe.initWaveform = function ()
{
    const canvas = document.querySelector('.mb-hero-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const CELL = 40;                      // pixels per clock half-period
    const bitsA = [1,0,0,1,1,0,1,0,0,0,1,1,1,0,1,0,0,1,0,1,1,0,0,1];
    const bitsB = [0,1,1,0,0,0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0,1,0,0];
    const traces = [
        { fromBottom: 150, bits: null },  // clock (px above the hero's bottom edge)
        { fromBottom: 100, bits: bitsA },
        { fromBottom: 50,  bits: bitsB }
    ];

    let dpr = 1, w = 0, h = 0, offset = 0, last = 0, speed = 24, targetSpeed = 24, mouseY = -1, running = true;

    const resize = () =>
    {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = canvas.clientWidth; h = canvas.clientHeight;
        canvas.width = w * dpr; canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
    };

    const levelAt = (t, i) =>
    {
        const idx = Math.floor(t / CELL);
        const bits = traces[i].bits;
        return bits ? bits[((idx % bits.length) + bits.length) % bits.length] : idx % 2;
    };

    const draw = () =>
    {
        ctx.clearRect(0, 0, w, h);
        const amp = 16;

        traces.forEach((tr, i) =>
        {
            const base = Math.round(h - tr.fromBottom);
            const near = mouseY >= 0 && Math.abs(mouseY - base) < 28;
            ctx.strokeStyle = near ? 'rgba(158, 187, 226, 0.95)' : 'rgba(158, 187, 226, 0.45)';
            ctx.lineWidth = near ? 3 : 2;
            ctx.beginPath();

            let prev = null;
            for (let x = -CELL; x <= w + CELL; x += CELL)
            {
                const t = x + offset;
                const snapped = Math.round((Math.floor(t / CELL) * CELL - offset) * dpr) / dpr;
                const lvl = levelAt(t, i);
                const yy = base - (lvl ? amp : 0);
                if (prev === null) ctx.moveTo(snapped, yy);
                else { ctx.lineTo(snapped, prev); ctx.lineTo(snapped, yy); }
                ctx.lineTo(snapped + CELL, yy);
                prev = yy;
            }
            ctx.stroke();
        });
    };

    const tick = (now) =>
    {
        if (!running) return;
        const dt = Math.min(0.05, (now - last) / 1000 || 0);
        last = now;
        speed += (targetSpeed - speed) * Math.min(1, dt * 4);
        offset += speed * dt;
        draw();
        requestAnimationFrame(tick);
    };

    const hero = canvas.parentElement;
    hero.addEventListener('mousemove', (e) =>
    {
        const r = hero.getBoundingClientRect();
        mouseY = e.clientY - r.top;
        targetSpeed = 24 + (e.clientX / r.width) * 140;
    });
    hero.addEventListener('mouseleave', () => { mouseY = -1; targetSpeed = 24; });

    new IntersectionObserver(([entry]) =>
    {
        const was = running;
        running = entry.isIntersecting && !reduced;
        if (running && !was) { last = performance.now(); requestAnimationFrame(tick); }
    }).observe(hero);

    new ResizeObserver(resize).observe(canvas);   // keeps the bitmap in sync with the hero's real size
    resize();
    if (!reduced) { last = performance.now(); requestAnimationFrame(tick); }
};

/* Main */
globe.main = function ()
{
    globe.initDropdowns();
    globe.initBackToTop();
    globe.initRows();
    globe.initCarousels();
    globe.initWaveform();
};

document.addEventListener('DOMContentLoaded', globe.main);
