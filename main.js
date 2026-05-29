/* ============================================================
   FIVE-MINUTE FIRE — interactive observatory
   Animates GOES-16 fire detections over the Jan 2025 LA fires.
   ============================================================ */

const FIRE_NAMES = ["Palisades", "Eaton"];
const DECAY = 0.84; // per-frame heat decay (15-min steps)
const HEAT_MIN = 7; // MW below which a pixel stops glowing
const FRP_MIN = 10,
    FRP_MAX = 4000;
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* on-map callouts — shown when the animation reaches their frame range */
const ANNOS = [
    {
        f0: 0,
        f1: 12,
        lat: 34.0653,
        lon: -118.552,
        color: "#ff7a2e",
        side: "right",
        title: "10:36 AM · JAN 7",
        body: "The Palisades fire ignites in the hills above Pacific Palisades.",
    },
    {
        f0: 31,
        f1: 45,
        lat: 34.1891,
        lon: -118.0962,
        color: "#b98bf0",
        side: "left",
        title: "6:26 PM · JAN 7",
        body: "The Eaton fire ignites above Altadena. A second front opens.",
    },
    {
        f0: 47,
        f1: 57,
        lat: 34.0681,
        lon: -118.5829,
        color: "#ffce6a",
        side: "right",
        title: "11:00 PM · JAN 7",
        body: "Santa Ana gusts drive the basin to its 43 GW firestorm peak.",
    },
    {
        f0: 69,
        f1: 86,
        lat: 34.1891,
        lon: -118.0962,
        color: "#74c4d0",
        side: "left",
        title: "DAWN · JAN 8",
        body: "The overnight surge passes. The fires sink below the satellite's view, though the wind still blows.",
    },
];

/* cadence-comparison sampling intervals (in 15-min frames) */
const C_INTERVALS = [
    { frames: 1, label: "Every 15 minutes", short: "15 min", perDay: "~96" },
    { frames: 4, label: "Every hour", short: "1 hr", perDay: "24" },
    { frames: 12, label: "Every 3 hours", short: "3 hr", perDay: "8" },
    { frames: 24, label: "Every 6 hours", short: "6 hr", perDay: "4" },
    { frames: 48, label: "Every 12 hours", short: "12 hr", perDay: "2" },
    { frames: 96, label: "Once a day", short: "24 hr", perDay: "1" },
];

const els = {
    canvas: document.getElementById("map"),
    tooltip: document.getElementById("tooltip"),
    annos: document.getElementById("annos"),
    time: document.getElementById("r-time"),
    frp: document.getElementById("r-frp"),
    px: document.getElementById("r-px"),
    area: document.getElementById("r-area"),
    play: document.getElementById("play"),
    restart: document.getElementById("restart"),
    tlSvg: d3.select("#timeline-svg"),
    legendScale: document.getElementById("legend-scale"),
    windHud: document.getElementById("wind-hud"),
    windSpd: document.getElementById("wind-spd"),
    windGust: document.getElementById("wind-gust"),
    windFrom: document.getElementById("wind-from"),
    windNeedle: document.getElementById("wind-needle"),
};

let DATA, BASEMAP, WIND, projection;
let basemapCache; // offscreen canvas with static map
let frameIdx = 0,
    playing = false,
    speedMult = 2,
    scrubbing = false;
let lastTick = 0,
    tween = null;
let litPixels = [];
const pixels = new Map(); // "lat,lon" -> {lat,lon,fire,heat,lastPower,sx,sy,r}

/* ambient wind streaks: persistent drift layer over the map */
let particles = [],
    ambientRunning = false,
    lastAmbient = 0;

/* ---------- load ---------- */
Promise.all([
    d3.json("data/goes_frames.json"),
    d3.json("data/socal_basemap.json"),
    // wind is an enhancement layer — never let a missing file break the core viz
    d3.json("data/wind.json").catch(() => null),
])
    .then(([frames, basemap, wind]) => {
        DATA = frames;
        BASEMAP = basemap;
        WIND = wind;
        if (WIND) setupWind();
        setupMap();
        buildAnnos();
        setupTimeline();
        setupCadence();
        setupControls();
        setupKeyboard();
        setupScrollReveal();
        setupScrolly();
        rebuildHeatTo(0);
        render();
        if (WIND) setupAmbient();
        // rebuild on resize — and once more when the canvas reaches its real
        // size, in case layout had not settled when the projection was first built
        const onResizeD = debounce(onResize, 180);
        window.addEventListener("resize", onResizeD);
        new ResizeObserver(onResizeD).observe(els.canvas);
    })
    .catch((err) => {
        document.getElementById("observatory").insertAdjacentHTML(
            "beforeend",
            `<p style="color:#ff5a1f;font-family:var(--mono);padding:1rem">
     Could not load data, serve this folder over http (e.g. <code>python3 -m http.server</code>).</p>`,
        );
        console.error(err);
    });

/* ============================================================
   MAP SETUP
   ============================================================ */
/* the four corners of the view window — used to fit the projection.
   (A MultiPoint, not a Polygon: a polygon ring's winding can be read as
   the whole globe, which collapses the map.) */
function viewCorners() {
    const m = DATA.meta;
    return {
        type: "MultiPoint",
        coordinates: [
            [m.lonMin, m.latMin],
            [m.lonMax, m.latMin],
            [m.lonMax, m.latMax],
            [m.lonMin, m.latMax],
        ],
    };
}

function setupMap() {
    sizeCanvas();
    projection = d3.geoMercator().fitSize([cssW(), cssH()], viewCorners());
    buildBasemapCache();
    seedParticles();

    els.canvas.addEventListener("mousemove", onHover);
    els.canvas.addEventListener("mouseleave", () => {
        els.tooltip.hidden = true;
        windMouse.active = false;
    });

    els.legendScale.innerHTML = "";
}

function cssW() {
    return els.canvas.clientWidth;
}

/* map height: width-based, but capped so the sticky instrument fits the viewport */
function cssH() {
    const w = els.canvas.clientWidth;
    const cap = window.innerHeight * (window.innerWidth <= 960 ? 0.32 : 0.46);
    return Math.round(Math.max(150, Math.min(w / 1.92, cap)));
}

function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = cssW(),
        h = cssH();
    els.canvas.style.height = h + "px";
    els.canvas.width = w * dpr;
    els.canvas.height = h * dpr;
    const ctx = els.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* pixel size on screen of one 2 km GOES cell */
function cellPx() {
    const m = DATA.meta;
    const latMid = (m.latMin + m.latMax) / 2,
        lonMid = (m.lonMin + m.lonMax) / 2;
    const a = projection([lonMid, latMid]);
    const b = projection([lonMid + 2 / 92, latMid]); // ~2 km in lon
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/* draw the static basemap once into an offscreen canvas */
function buildBasemapCache() {
    const dpr = window.devicePixelRatio || 1;
    const w = cssW(),
        h = cssH();
    basemapCache = document.createElement("canvas");
    basemapCache.width = w * dpr;
    basemapCache.height = h * dpr;
    const ctx = basemapCache.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const geo = d3.geoPath(projection, ctx);

    // ocean
    ctx.fillStyle = "#0b0a09";
    ctx.fillRect(0, 0, w, h);

    // land (counties)
    ctx.beginPath();
    BASEMAP.features.forEach((f) => geo(f));
    ctx.fillStyle = "#15120f";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#2c2620";
    ctx.stroke();

    // edge vignette
    ctx.strokeStyle = "#1c1813";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    // scale bar (10 km)
    const tenKm = cellPx() * 5; // 5 cells = 10 km
    const x0 = 16,
        y0 = h - 18;
    ctx.strokeStyle = "#938878";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + tenKm, y0);
    ctx.moveTo(x0, y0 - 3);
    ctx.lineTo(x0, y0 + 3);
    ctx.moveTo(x0 + tenKm, y0 - 3);
    ctx.lineTo(x0 + tenKm, y0 + 3);
    ctx.stroke();
    // label sizing scales with the map so a small mobile map stays legible
    const fs = Math.max(7.5, Math.min(11, w / 62));

    ctx.fillStyle = "#b6ab96";
    ctx.font = `${Math.round(fs - 1)}px 'IBM Plex Mono', monospace`;
    ctx.fillText("10 KM", x0 + tenKm + 7, y0 + 3);

    // city reference markers (fewer on a cramped map)
    let cities = [
        ["Santa Monica", 34.013, -118.49],
        ["Malibu", 34.036, -118.7],
        ["Downtown LA", 34.05, -118.243],
        ["Pasadena", 34.156, -118.132],
        ["Burbank", 34.181, -118.309],
    ];
    if (w < 520)
        cities = cities.filter((c) =>
            ["Santa Monica", "Downtown LA", "Pasadena"].includes(c[0]),
        );
    cities.forEach(([name, lat, lon]) => {
        const p = projection([lon, lat]);
        if (!p) return;
        ctx.fillStyle = "#8a7f6e";
        ctx.beginPath();
        ctx.arc(p[0], p[1], 2.4, 0, 7);
        ctx.fill();
        ctx.fillStyle = "#bcb19a";
        ctx.font = `${Math.round(fs)}px 'Hanken Grotesk', sans-serif`;
        ctx.fillText(name, p[0] + 6, p[1] + 3.5);
    });

    // fire name labels
    ctx.font = `600 ${Math.round(fs)}px 'IBM Plex Mono', monospace`;
    ctx.fillStyle = "rgba(255,138,74,0.92)";
    label(ctx, "PALISADES FIRE", 34.005, -118.66);
    ctx.fillStyle = "rgba(199,158,247,0.92)";
    label(ctx, "EATON FIRE", 34.275, -118.16);
}
function label(ctx, text, lat, lon) {
    const p = projection([lon, lat]);
    if (p) ctx.fillText(text, p[0], p[1]);
}

/* ============================================================
   HEAT MODEL
   ============================================================ */
function rebuildHeatTo(idx) {
    pixels.forEach((p) => {
        p.heat = 0;
    });
    for (let f = 0; f <= idx; f++) applyFrame(f, f === 0);
    frameIdx = idx;
}
function stepForward() {
    if (frameIdx >= DATA.frames.length - 1) {
        stop();
        return;
    }
    applyFrame(++frameIdx, false);
}
function applyFrame(f, first) {
    if (!first)
        pixels.forEach((p) => {
            p.heat *= DECAY;
        });
    for (const d of DATA.frames[f].d) {
        const [lat, lon, power, fire] = d;
        const key = lat + "," + lon;
        let p = pixels.get(key);
        if (!p) {
            p = {
                lat,
                lon,
                fire,
                heat: 0,
                lastPower: 0,
                phase: Math.random() * 6.283, // flicker offset
            };
            pixels.set(key, p);
        }
        p.heat = Math.max(p.heat, power);
        p.lastPower = power;
    }
}

/* ============================================================
   RENDER
   ============================================================ */
function render() {
    const ctx = els.canvas.getContext("2d");
    ctx.clearRect(0, 0, cssW(), cssH());
    ctx.drawImage(basemapCache, 0, 0, cssW(), cssH());

    // wind trails (offscreen layer) sit under the fire so flames stay dominant
    if (WIND && windLayer) ctx.drawImage(windLayer, 0, 0, cssW(), cssH());

    const base = cellPx();
    const now = performance.now();
    ctx.globalCompositeOperation = "lighter";
    const lit = [];
    pixels.forEach((p) => {
        if (p.heat < HEAT_MIN) return;
        const xy = projection([p.lon, p.lat]);
        if (!xy) return;
        const t = norm(p.heat); // 0..1 (log)
        // a living flicker so the flames breathe even when paused
        const fl = 1 + 0.08 * Math.sin(now * 0.006 + (p.phase || 0));
        const R = base * (0.72 + 1.7 * t) * fl; // glow radius
        drawGlow(ctx, xy[0], xy[1], R, t, fl);
        p.sx = xy[0];
        p.sy = xy[1];
        p.r = R;
        lit.push(p);
    });
    ctx.globalCompositeOperation = "source-over";
    litPixels = lit;
    updateReadouts();
    renderAnnos();
}

function drawGlow(ctx, x, y, R, t, k = 1) {
    const c = fireColor(t);
    let g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, rgba(c, (0.55 + 0.25 * t) * k));
    g.addColorStop(0.45, rgba(c, 0.18 * k));
    g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, 7);
    ctx.fill();
    // hot core
    const cr = R * (0.22 + 0.16 * t);
    g = ctx.createRadialGradient(x, y, 0, x, y, cr);
    g.addColorStop(0, rgba([255, 244, 214], Math.min(1, (0.7 + 0.3 * t) * k)));
    g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, cr, 0, 7);
    ctx.fill();
}

/* log-normalized intensity 0..1 */
function norm(v) {
    const t =
        (Math.log(Math.max(v, FRP_MIN)) - Math.log(FRP_MIN)) /
        (Math.log(FRP_MAX) - Math.log(FRP_MIN));
    return Math.max(0, Math.min(1, t));
}
/* fire ramp: ember -> flare -> gold -> white-hot */
const RAMP = [
    [0.0, [150, 38, 12]],
    [0.3, [255, 90, 31]],
    [0.58, [255, 148, 54]],
    [0.8, [255, 206, 106]],
    [1.0, [255, 242, 212]],
];
function fireColor(t) {
    for (let i = 1; i < RAMP.length; i++) {
        if (t <= RAMP[i][0]) {
            const [t0, c0] = RAMP[i - 1],
                [t1, c1] = RAMP[i];
            const u = (t - t0) / (t1 - t0);
            return c0.map((c, k) => Math.round(c + u * (c1[k] - c)));
        }
    }
    return RAMP[RAMP.length - 1][1];
}
function rgba(c, a) {
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/* ============================================================
   WIND  (real Open-Meteo ERA5 reanalysis, aligned to the frames)
   The Santa Ana is a regional offshore flow, so one basin reading
   drives a uniform field — honest, not faked spatial structure.
   ============================================================ */
const DIRS8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function cardinal(deg) {
    return DIRS8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
function setupWind() {
    WIND.gustMax = d3.max(WIND.gust) || 1;
    WIND.speedMax = d3.max(WIND.speed) || 1;
}
/* normalized 0..1 wind speed at frame i (drives the flow field, matches the
   km/h on the dial so the visual and the number agree) */
function windMag(i) {
    return Math.max(0, Math.min(1, WIND.speed[i] / WIND.speedMax));
}
/* unit screen vector of the flow (where the wind blows TO).
   dir is meteorological FROM-degrees; flow bearing = dir + 180.
   screen: east = +x, north = -y. */
function flowVec(dir) {
    const th = ((dir + 180) * Math.PI) / 180;
    return { x: Math.sin(th), y: -Math.cos(th) };
}

/* ---- ambient flow field: streaming trails of Santa Ana air ----
   Particles are drawn onto an offscreen layer that fades a little each frame,
   so each one leaves a long flowing trail (like a wind map) rather than a short
   falling streak. Trail length, speed and brightness all scale with wind speed,
   so a 6 km/h breeze and a 34 km/h blow look clearly different. */
let windMouse = { x: 0, y: 0, active: false };
let windLayer = null,
    windLayerCtx = null;
function ensureWindLayer() {
    const dpr = window.devicePixelRatio || 1;
    if (!windLayer) windLayer = document.createElement("canvas");
    windLayer.width = cssW() * dpr;
    windLayer.height = cssH() * dpr;
    windLayerCtx = windLayer.getContext("2d");
    windLayerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function mkParticle(w, h) {
    return {
        x: Math.random() * w,
        y: Math.random() * h,
        a: 0.55 + Math.random() * 0.6, // opacity jitter
        s: 0.7 + Math.random() * 0.7, // speed jitter
        w: 0.8 + Math.random() * 0.9, // trail width
        o: Math.random() * 6.28, // meander phase
        life: 1.5 + Math.random() * 3.5, // seconds before it respawns
    };
}
function seedParticles() {
    if (!WIND) return;
    const w = cssW(),
        h = cssH();
    if (!w || !h) return;
    ensureWindLayer();
    const n = Math.min(72, Math.round((w * h) / 6500)); // sparse → airy
    particles = Array.from({ length: n }, () => mkParticle(w, h));
}
/* advance the field and lay fresh trail segments onto the fading layer */
function updateWindField(dt, now) {
    if (!windLayerCtx || !particles.length || !WIND) return;
    const w = cssW(),
        h = cssH();
    const v = flowVec(WIND.dir[frameIdx]);
    const eff = Math.pow(windMag(frameIdx), 1.5); // exaggerate calm ↔ strong
    const spd = 7 + 240 * eff; // px/sec — barely moving when calm
    const R = Math.min(w, h) * 0.26; // cursor influence radius
    const wlc = windLayerCtx;
    // fade existing trails (a touch crisper when it's windy)
    wlc.globalCompositeOperation = "destination-out";
    wlc.fillStyle = `rgba(0,0,0,${(0.05 + 0.06 * eff).toFixed(3)})`;
    wlc.fillRect(0, 0, w, h);
    wlc.globalCompositeOperation = "lighter";
    wlc.lineCap = "round";
    const tph = now * 0.00018;
    for (const p of particles) {
        let vx = v.x,
            vy = v.y;
        // perpendicular meander so the air streams rather than falls like rain
        const wob = Math.sin(p.y * 0.011 + p.x * 0.006 + tph + p.o) * 0.5;
        vx += -v.y * wob;
        vy += v.x * wob;
        // stir the field with the cursor
        if (windMouse.active) {
            const dx = p.x - windMouse.x,
                dy = p.y - windMouse.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < R * R) {
                const d = Math.sqrt(d2) || 1;
                const f = (1 - d / R) * 1.7;
                vx += (-dy / d) * f;
                vy += (dx / d) * f;
            }
        }
        const nx = p.x + vx * spd * dt * p.s;
        const ny = p.y + vy * spd * dt * p.s;
        wlc.strokeStyle = `rgba(186,221,236,${((0.05 + 0.4 * eff) * p.a).toFixed(3)})`;
        wlc.lineWidth = p.w;
        wlc.beginPath();
        wlc.moveTo(p.x, p.y);
        wlc.lineTo(nx, ny);
        wlc.stroke();
        p.x = nx;
        p.y = ny;
        p.life -= dt;
        if (p.life <= 0 || nx < -30 || nx > w + 30 || ny < -30 || ny > h + 30) {
            p.x = Math.random() * w; // respawn (next frame starts a fresh trail)
            p.y = Math.random() * h;
            p.life = 1.5 + Math.random() * 3.5;
        }
    }
    wlc.globalCompositeOperation = "source-over";
}

/* ---- on-map compass dial: direction needle, magnitude ring, numbers ---- */
let windHudAngle = 0;
function updateWindHUD(i) {
    if (!WIND || !els.windHud) return;
    els.windSpd.textContent = Math.round(WIND.speed[i]);
    els.windGust.textContent = Math.round(WIND.gust[i]);
    els.windFrom.textContent = cardinal(WIND.dir[i]);
    // needle points the way the wind blows, matching the flow field
    let target = WIND.dir[i] + 180;
    while (target - windHudAngle > 180) target -= 360;
    while (target - windHudAngle < -180) target += 360;
    windHudAngle = target;
    els.windNeedle.setAttribute(
        "transform",
        `rotate(${target.toFixed(1)} 30 30)`,
    );
}

/* ---- persistent ticker: drifts streaks + advances playback ---- */
function ambientTick(now) {
    if (!ambientRunning) return;
    const dt = lastAmbient ? Math.min(0.05, (now - lastAmbient) / 1000) : 0;
    lastAmbient = now;
    if (playing) {
        const interval = 1000 / (6 * speedMult);
        if (now - lastTick >= interval) {
            lastTick = now;
            stepForward();
        }
    }
    updateWindField(dt, now);
    render();
    requestAnimationFrame(ambientTick);
}
function startAmbient() {
    if (!WIND || ambientRunning) return;
    ambientRunning = true;
    lastAmbient = 0;
    requestAnimationFrame(ambientTick);
}
function stopAmbient() {
    ambientRunning = false;
}
/* only run the idle drift while the map is actually on screen */
function setupAmbient() {
    if (!WIND) return;
    const obs = document.getElementById("observatory");
    if (!obs) {
        startAmbient();
        return;
    }
    new IntersectionObserver(
        (es) =>
            es.forEach((e) =>
                e.isIntersecting ? startAmbient() : stopAmbient(),
            ),
        { threshold: 0 },
    ).observe(obs);
}

/* ============================================================
   ANNOTATIONS
   ============================================================ */
function buildAnnos() {
    els.annos.innerHTML = "";
    ANNOS.forEach((a) => {
        const el = document.createElement("div");
        el.className = "anno" + (a.side === "left" ? " left" : "");
        el.style.color = a.color;
        el.innerHTML =
            `<div class="anno-dot"></div>` +
            `<div class="anno-card">` +
            `<div class="anno-title">${a.title}</div>` +
            `<div class="anno-body">${a.body}</div>` +
            `</div>`;
        els.annos.appendChild(el);
        a.el = el;
    });
}
function renderAnnos() {
    ANNOS.forEach((a) => {
        const on = frameIdx >= a.f0 && frameIdx <= a.f1;
        a.el.classList.toggle("show", on);
        if (on) {
            const p = projection([a.lon, a.lat]);
            if (p) {
                a.el.style.left = (p[0] / cssW()) * 100 + "%";
                a.el.style.top = (p[1] / cssH()) * 100 + "%";
            }
        }
    });
}

/* ============================================================
   READOUTS
   ============================================================ */
const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];
/* "2025-01-07T23:15" -> "Jan 7 · 11:15 PM" */
function fmtTime(iso) {
    const [date, time] = iso.split("T");
    const [, mo, day] = date.split("-").map(Number);
    const [h, mn] = time.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = ((h + 11) % 12) + 1;
    return `${MONTHS[mo - 1]} ${day} · ${h12}:${String(mn).padStart(2, "0")} ${ampm}`;
}
function updateReadouts() {
    const fr = DATA.frames[frameIdx];
    els.time.textContent = fmtTime(fr.t);

    const frp = DATA.pulse.Palisades[frameIdx] + DATA.pulse.Eaton[frameIdx];
    els.frp.innerHTML = `${frp.toFixed(1)}<span class="unit">GW</span>`;
    els.px.textContent = fr.d.length;
    els.area.innerHTML = `${Math.round(DATA.cumKm2[frameIdx])}<span class="unit">km²</span>`;

    if (WIND) updateWindHUD(frameIdx);
    movePlayhead();
}

/* ============================================================
   TIMELINE  (D3 SVG area chart + scrubber)
   ============================================================ */
let tl = {};
function setupTimeline() {
    const svg = els.tlSvg;
    const W = svg.node().clientWidth;
    const H = window.innerWidth <= 600 ? 106 : 132;
    const M = { t: 30, r: WIND ? 42 : 14, b: 22, l: 40 };
    svg.attr("viewBox", `0 0 ${W} ${H}`).style("height", H + "px");
    svg.selectAll("*").remove();

    const n = DATA.frames.length;
    const x = d3
        .scaleLinear()
        .domain([0, n - 1])
        .range([M.l, W - M.r]);
    const yMax = d3.max(DATA.pulse.Palisades) * 1.08;
    const y = d3
        .scaleLinear()
        .domain([0, yMax])
        .range([H - M.b, M.t]);

    // areas
    const area = (key) =>
        d3
            .area()
            .x((_, i) => x(i))
            .y0(y(0))
            .y1((d) => y(d))
            .curve(d3.curveBasis)(DATA.pulse[key]);
    svg.append("path")
        .attr("d", area("Palisades"))
        .attr("fill", "#ff7a2e")
        .attr("opacity", 0.5);
    svg.append("path")
        .attr("d", area("Eaton"))
        .attr("fill", "#b98bf0")
        .attr("opacity", 0.6);

    // wind-speed line on its own right-hand axis — the fire surges with the wind
    if (WIND) {
        const wTop = Math.ceil(WIND.speedMax / 10) * 10; // nice round axis top
        const yW = d3
            .scaleLinear()
            .domain([0, wTop])
            .range([H - M.b, M.t]);
        svg.append("path")
            .attr("class", "tl-wind-line")
            .attr(
                "d",
                d3
                    .line()
                    .x((_, i) => x(i))
                    .y((d) => yW(d))
                    .curve(d3.curveBasis)(WIND.speed),
            );
        d3.range(0, wTop + 1, 10).forEach((v) =>
            svg
                .append("text")
                .attr("class", "tl-wind-axis")
                .attr("x", W - M.r + 5)
                .attr("y", yW(v) + 3)
                .text(v === wTop ? `${v} km/h` : v),
        );
    }

    // ignition markers — the two fires start only hours apart, so the labels sit
    // stacked in the top margin (clear of the wind line and fire areas) with a
    // faint fire-coloured rule dropping to the moment each fire first appears.
    // Listed earliest-first so the upper label's rule never crosses the lower one.
    [
        ["Palisades", "#ff7a2e"],
        ["Eaton", "#b98bf0"],
    ].forEach(([k, col], gi) => {
        const i = DATA.pulse[k].findIndex((v) => v > 0);
        if (i < 0) return;
        const ly = 11 + gi * 12; // label baseline, in the top margin
        svg.append("line")
            .attr("class", "tl-ignite")
            .attr("x1", x(i))
            .attr("x2", x(i))
            .attr("y1", ly + 3)
            .attr("y2", H - M.b)
            .style("stroke", col);
        svg.append("text")
            .attr("class", "tl-ignite-label")
            .attr("x", x(i) + 5)
            .attr("y", ly)
            .style("fill", col)
            .text(k + " ignites");
    });

    // x axis — one tick per day
    const ticks = dayLabelTicks();
    const axis = svg
        .append("g")
        .attr("class", "tl-axis")
        .attr("transform", `translate(0,${H - M.b})`);
    axis.append("path").attr("d", `M${M.l},0H${W - M.r}`);
    ticks.forEach((i) => {
        const [, mo, day] = DATA.frames[i].t
            .slice(0, 10)
            .split("-")
            .map(Number);
        axis.append("line").attr("x1", x(i)).attr("x2", x(i)).attr("y2", 5);
        axis.append("text")
            .attr("x", x(i))
            .attr("y", 15)
            .attr("text-anchor", "middle")
            .text(`${MONTHS[mo - 1].toUpperCase()} ${day}`);
    });
    // y axis label ticks
    [0, Math.round(yMax / 2), Math.round(yMax)].forEach((v) => {
        svg.append("text")
            .attr("class", "tl-axis")
            .attr("x", M.l - 6)
            .attr("y", y(v) + 3)
            .attr("text-anchor", "end")
            .style("font-family", "var(--mono)")
            .style("font-size", "9px")
            .style("fill", "var(--ash)")
            .text(v + (v === Math.round(yMax) ? " GW" : ""));
    });

    // playhead
    const ph = svg.append("g");
    ph.append("line")
        .attr("class", "tl-playhead")
        .attr("y1", M.t - 3)
        .attr("y2", H - M.b);
    ph.append("path")
        .attr("class", "tl-playhead-grip")
        .attr("d", "M-5,-3 L5,-3 L0,5 Z")
        .attr("transform", `translate(0,${M.t - 3})`);

    tl = { svg, x, y, M, W, H, ph };

    // scrub interaction
    const toFrame = (ev) => {
        const r = svg.node().getBoundingClientRect();
        const px = (ev.clientX - r.left) * (W / r.width);
        return Math.max(0, Math.min(n - 1, Math.round(x.invert(px))));
    };
    svg.on("pointerdown", (ev) => {
        scrubbing = true;
        stop();
        cancelTween();
        svg.node().setPointerCapture(ev.pointerId);
        jumpTo(toFrame(ev));
    });
    svg.on("pointermove", (ev) => {
        if (scrubbing) jumpTo(toFrame(ev));
    });
    svg.on("pointerup pointercancel", () => {
        scrubbing = false;
    });

    movePlayhead();
}
function movePlayhead() {
    if (!tl.ph) return;
    tl.ph.attr("transform", `translate(${tl.x(frameIdx)},0)`);
}
/* frame nearest local noon of each calendar day. Day labels sit at these
   centered positions so the partial first day (the record starts 10:30 AM
   Jan 7) doesn't make the dates look unevenly spaced. The axis is still
   linear time — only the label anchor moves to each day's midpoint. */
function dayLabelTicks() {
    const out = [],
        seen = new Set();
    DATA.frames.forEach((f) => {
        const day = f.t.slice(0, 10);
        if (seen.has(day)) return;
        seen.add(day);
        const noon = +new Date(day + "T12:00");
        let best = 0,
            bd = Infinity;
        DATA.frames.forEach((g, j) => {
            const d = Math.abs(+new Date(g.t) - noon);
            if (d < bd) {
                bd = d;
                best = j;
            }
        });
        out.push(best);
    });
    return out;
}

/* ============================================================
   CADENCE COMPARISON  (why 5 minutes matters)
   ============================================================ */
let cd = {};
function setupCadence() {
    cd.tot = DATA.pulse.Palisades.map((v, i) => v + DATA.pulse.Eaton[i]);
    cd.truePeak = d3.max(cd.tot);
    cd.idx = 0;

    const ticksEl = document.getElementById("cadence-ticks");
    // place each label at its value's thumb-center: 10px inset at each end
    // (half the 20px thumb) + the value's fraction of the remaining travel
    const last = C_INTERVALS.length - 1;
    ticksEl.innerHTML = C_INTERVALS.map(
        (c, i) =>
            `<span style="left:calc(10px + ${(i / last).toFixed(4)} * (100% - 20px))">${c.short}</span>`,
    ).join("");
    cd.tickSpans = [...ticksEl.children];

    const slider = document.getElementById("cadence-slider");
    slider.addEventListener("input", () => {
        cd.idx = +slider.value;
        drawCadence();
    });

    drawCadence();
}

function drawCadence() {
    const svg = d3.select("#cadence-svg");
    const W = svg.node().clientWidth || 700,
        H = 300;
    const M = { t: 18, r: 18, b: 26, l: 46 };
    svg.attr("viewBox", `0 0 ${W} ${H}`).selectAll("*").remove();

    const tot = cd.tot,
        n = tot.length;
    const x = d3
        .scaleLinear()
        .domain([0, n - 1])
        .range([M.l, W - M.r]);
    const yMax = cd.truePeak * 1.12;
    const y = d3
        .scaleLinear()
        .domain([0, yMax])
        .range([H - M.b, M.t]);

    // ground-truth curve
    svg.append("path")
        .attr("class", "cd-truth")
        .attr(
            "d",
            d3
                .area()
                .x((_, i) => x(i))
                .y0(y(0))
                .y1((d) => y(d))(tot),
        );
    svg.append("path")
        .attr("class", "cd-truthline")
        .attr(
            "d",
            d3
                .line()
                .x((_, i) => x(i))
                .y((d) => y(d))(tot),
        );

    // resampled curve
    const step = C_INTERVALS[cd.idx].frames;
    const sIdx = [];
    for (let i = 0; i < n; i += step) sIdx.push(i);
    if (sIdx[sIdx.length - 1] !== n - 1) sIdx.push(n - 1);
    svg.append("path")
        .attr("class", "cd-sample")
        .attr(
            "d",
            d3
                .line()
                .x((i) => x(i))
                .y((i) => y(tot[i]))(sIdx),
        );
    const tip = document.getElementById("cadence-tooltip");
    svg.append("g")
        .selectAll("circle")
        .data(sIdx)
        .join("circle")
        .attr("class", "cd-dot")
        .attr("r", 2.7)
        .attr("cx", (i) => x(i))
        .attr("cy", (i) => y(tot[i]))
        .on("pointerenter", function (_ev, i) {
            d3.select(this).attr("r", 4.6);
            showCadenceTip(tip, i, sIdx, tot, x, y, W);
        })
        .on("pointerleave", function () {
            d3.select(this).attr("r", 2.7);
            if (tip) tip.hidden = true;
        });

    // true-peak reference line
    svg.append("line")
        .attr("class", "cd-peakline")
        .attr("x1", M.l)
        .attr("x2", W - M.r)
        .attr("y1", y(cd.truePeak))
        .attr("y2", y(cd.truePeak));
    svg.append("text")
        .attr("class", "cd-peaklabel")
        .attr("x", W - M.r)
        .attr("y", y(cd.truePeak) - 5)
        .attr("text-anchor", "end")
        .text(`actual firestorm peak · ${Math.round(cd.truePeak)} GW`);

    // x axis — one tick per day
    const axis = svg
        .append("g")
        .attr("class", "cd-axis")
        .attr("transform", `translate(0,${H - M.b})`);
    axis.append("path").attr("d", `M${M.l},0H${W - M.r}`);
    dayLabelTicks().forEach((i) => {
        const [, mo, day] = DATA.frames[i].t
            .slice(0, 10)
            .split("-")
            .map(Number);
        axis.append("line").attr("x1", x(i)).attr("x2", x(i)).attr("y2", 5);
        axis.append("text")
            .attr("x", x(i))
            .attr("y", 16)
            .attr("text-anchor", "middle")
            .text(`${MONTHS[mo - 1].toUpperCase()} ${day}`);
    });
    // y axis  (bare <text> — style inline; the ".cd-axis text" rule only
    // matches descendants, not the labelled element itself)
    [0, Math.round(cd.truePeak / 2), Math.round(cd.truePeak)].forEach((v) => {
        svg.append("text")
            .attr("x", M.l - 7)
            .attr("y", y(v) + 3)
            .attr("text-anchor", "end")
            .style("font-family", "var(--mono)")
            .style("font-size", "9.5px")
            .style("fill", "var(--ash)")
            .text(v + (v === Math.round(cd.truePeak) ? " GW" : ""));
    });

    // readouts — "rhythm lost" = fraction of the curve's total rise-and-fall
    // that the straight-line resampling smooths away (phase-robust, monotonic)
    const tv = (a) => {
        let s = 0;
        for (let k = 1; k < a.length; k++) s += Math.abs(a[k] - a[k - 1]);
        return s;
    };
    const tvTruth = tv(tot);
    const tvSample = tv(sIdx.map((i) => tot[i]));
    const lost = Math.max(0, Math.round((1 - tvSample / tvTruth) * 100));
    const peakSeen = d3.max(sIdx, (i) => tot[i]);

    document.getElementById("c-interval").textContent =
        C_INTERVALS[cd.idx].label;
    document.getElementById("c-perday").textContent =
        C_INTERVALS[cd.idx].perDay;
    document.getElementById("c-loss").innerHTML =
        `${lost}<span class="unit">%</span>`;

    cd.tickSpans.forEach((s, i) => s.classList.toggle("on", i === cd.idx));

    const cap = document.getElementById("cadence-caption");
    if (cd.idx === 0) {
        cap.innerHTML =
            `At its full cadence GOES-16 catches the <em>${Math.round(cd.truePeak)} GW</em> ` +
            `firestorm peak and every surge and collapse in between. This is the fire's true pulse.`;
    } else {
        cap.innerHTML =
            `Looking only ${C_INTERVALS[cd.idx].label.toLowerCase()}, a satellite smooths away ` +
            `<strong>${lost}%</strong> of the fire's rise and fall and sees a peak of just ` +
            `<em>${peakSeen.toFixed(0)} GW</em>. The straight lines between its looks are surges ` +
            `and collapses it never saw.`;
    }
}

/* tooltip for a cadence sample dot: when it was taken, what the satellite read,
   and — at slower cadences — the true peak hiding in the gap to the next look */
function showCadenceTip(tip, i, sIdx, tot, x, y, W) {
    if (!tip) return;
    const reading = tot[i];
    let html =
        `<span class="tip-time">${fmtTime(DATA.frames[i].t)}</span>` +
        `<span class="tip-read">this look · <b>${reading.toFixed(1)} GW</b></span>`;
    if (cd.idx === 0) {
        html += `<span class="tip-sub">full cadence — nothing missed</span>`;
    } else {
        // the true peak hiding between this look and the next one
        const ni = sIdx[sIdx.indexOf(i) + 1];
        let peak = reading;
        if (ni != null)
            for (let k = i; k <= ni; k++) peak = Math.max(peak, tot[k]);
        if (ni != null && peak > reading + 0.3) {
            html +=
                `<span class="tip-miss">misses a <b>${Math.round(peak)} GW</b> peak</span>` +
                `<span class="tip-sub">before its next look, ${C_INTERVALS[cd.idx].short} later</span>`;
        }
    }
    tip.innerHTML = html;
    tip.hidden = false;
    // measure the card, then clamp it inside the plot so it never gets clipped
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(4, Math.min(W - tw - 4, x(i) - tw / 2)) + "px";
    const topPx = y(tot[i]);
    tip.style.top = topPx + "px";
    // sit above the dot when there's room, else below — never over the readouts
    tip.style.transform =
        topPx < 120 ? "translateY(14px)" : "translateY(calc(-100% - 12px))";
}

/* ============================================================
   TRANSPORT
   ============================================================ */
function setupControls() {
    els.play.addEventListener("click", () => (playing ? stop() : start()));
    els.restart.addEventListener("click", () => {
        stop();
        cancelTween();
        jumpTo(0);
    });
    document.querySelectorAll(".speed-btn").forEach((b) => {
        b.addEventListener("click", () => {
            speedMult = +b.dataset.mult;
            document
                .querySelectorAll(".speed-btn")
                .forEach((x) => x.classList.remove("is-on"));
            b.classList.add("is-on");
        });
    });
}
function setupKeyboard() {
    document.addEventListener("keydown", (e) => {
        const tag = e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
        const last = DATA.frames.length - 1;
        if (e.code === "Space") {
            e.preventDefault();
            playing ? stop() : start();
        } else if (e.code === "ArrowRight") {
            e.preventDefault();
            stop();
            cancelTween();
            jumpTo(Math.min(last, frameIdx + 1));
        } else if (e.code === "ArrowLeft") {
            e.preventDefault();
            stop();
            cancelTween();
            jumpTo(Math.max(0, frameIdx - 1));
        } else if (e.code === "Home") {
            e.preventDefault();
            stop();
            cancelTween();
            jumpTo(0);
        }
    });
}
function start() {
    cancelTween();
    if (frameIdx >= DATA.frames.length - 1) rebuildHeatTo(0);
    playing = true;
    els.play.querySelector(".play-icon").textContent = "❚❚";
    els.play.querySelector(".play-text").textContent = "PAUSE";
    lastTick = performance.now();
    // the persistent flow-field ticker advances frames too; only the
    // no-wind fallback path needs the old loop
    if (WIND) startAmbient();
    else requestAnimationFrame(loop);
}
function stop() {
    playing = false;
    els.play.querySelector(".play-icon").textContent = "▶";
    els.play.querySelector(".play-text").textContent = "PLAY";
}
function loop(now) {
    if (!playing) return;
    const interval = 1000 / (6 * speedMult); // frames per second = 6×mult
    if (now - lastTick >= interval) {
        lastTick = now;
        stepForward();
        render();
    }
    requestAnimationFrame(loop);
}
function jumpTo(idx) {
    rebuildHeatTo(idx);
    render();
}

/* eased scrub between two frames — used by the scrollytelling steps */
function cancelTween() {
    if (tween) {
        cancelAnimationFrame(tween);
        tween = null;
    }
}
function tweenTo(target) {
    stop();
    cancelTween();
    if (REDUCED || target === frameIdx) {
        jumpTo(target);
        return;
    }
    const start = frameIdx;
    const dist = Math.abs(target - start);
    const dur = Math.min(1500, 320 + dist * 14);
    const t0 = performance.now();
    function frame(now) {
        const e = Math.min(1, (now - t0) / dur);
        const eased = e < 0.5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2;
        jumpTo(Math.round(start + (target - start) * eased));
        if (e < 1) tween = requestAnimationFrame(frame);
        else {
            tween = null;
            jumpTo(target);
        }
    }
    tween = requestAnimationFrame(frame);
}

/* ============================================================
   SCROLLYTELLING — scroll position drives the active step
   ============================================================ */
function setupScrolly() {
    const scrolly = document.getElementById("scrolly");
    const graphic = document.querySelector(".scrolly-graphic");
    const steps = [...document.querySelectorAll(".step")];
    if (!steps.length) return;
    let active = -1;

    function pick() {
        const sr = scrolly.getBoundingClientRect();
        if (sr.bottom < 0 || sr.top > window.innerHeight) return; // section off-screen
        // trigger line: mid-viewport on desktop; just below the sticky graphic on mobile
        let line;
        if (window.innerWidth <= 960) {
            const gb = graphic.getBoundingClientRect().bottom;
            line = gb + (window.innerHeight - gb) * 0.45;
        } else {
            line = window.innerHeight * 0.6;
        }
        let best = 0,
            bestD = Infinity;
        steps.forEach((s, i) => {
            const r = s.getBoundingClientRect();
            const d = Math.abs(r.top + r.height / 2 - line);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        });
        if (best !== active) {
            active = best;
            steps.forEach((s, i) =>
                s.classList.toggle("is-active", i === best),
            );
            if (!scrubbing) tweenTo(+steps[best].dataset.frame);
        }
    }

    let ticking = false;
    window.addEventListener(
        "scroll",
        () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                pick();
                ticking = false;
            });
        },
        { passive: true },
    );
    pick();
}

/* ============================================================
   HOVER TOOLTIP
   ============================================================ */
function onHover(ev) {
    const r = els.canvas.getBoundingClientRect();
    const mx = (ev.clientX - r.left) * (cssW() / r.width);
    const my = (ev.clientY - r.top) * (cssH() / r.height);
    windMouse.x = mx; // let the cursor stir the wind field
    windMouse.y = my;
    windMouse.active = true;
    let best = null,
        bd = 16 * 16;
    for (const p of litPixels) {
        const d = (p.sx - mx) ** 2 + (p.sy - my) ** 2;
        if (d < bd) {
            bd = d;
            best = p;
        }
    }
    if (!best) {
        els.tooltip.hidden = true;
        return;
    }
    const t = els.tooltip;
    t.hidden = false;
    t.style.left = (best.sx / cssW()) * 100 + "%";
    t.style.top = (best.sy / cssH()) * 100 + "%";
    t.innerHTML =
        `<b>${FIRE_NAMES[best.fire]} fire</b><br>` +
        `${Math.round(best.lastPower).toLocaleString()} MW radiative power<br>` +
        `${best.lat.toFixed(3)}°, ${best.lon.toFixed(3)}°`;
}

/* ============================================================
   MISC
   ============================================================ */
function setupScrollReveal() {
    const targets = document.querySelectorAll(
        ".beat-text, .obs-head, .writeup-grid article",
    );
    targets.forEach((t) => t.classList.add("fade-up"));
    const io = new IntersectionObserver(
        (es) => {
            es.forEach((e) => {
                if (e.isIntersecting) {
                    e.target.classList.add("in");
                    io.unobserve(e.target);
                }
            });
        },
        { threshold: 0.2 },
    );
    targets.forEach((t) => io.observe(t));
}

function onResize() {
    sizeCanvas();
    projection = d3.geoMercator().fitSize([cssW(), cssH()], viewCorners());
    buildBasemapCache();
    seedParticles();
    setupTimeline();
    drawCadence();
    render();
}
function debounce(fn, ms) {
    let h;
    return (...a) => {
        clearTimeout(h);
        h = setTimeout(() => fn(...a), ms);
    };
}
