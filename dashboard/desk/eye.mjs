// THE EYE — the whole research universe drawn as a living Helix nebula.
// Pupil = decision core. Blue iris = agents. Gold rim = sources & datasets.
// Orange/red outer gas = experiments & unproven pattern hypotheses.
// Pure helpers (hash, layoutRecords, exampleUniverse, eventTone) are exported for tests.

const TAU = Math.PI * 2;

export const LAYERS = {
  agent:      { r: [0.17, 0.33], label: 'Agents',      hint: 'inner iris',  color: '#9fd3ff' },
  source:     { r: [0.47, 0.55], label: 'Sources',     hint: 'bright rim',  color: '#fff1cf' },
  dataset:    { r: [0.55, 0.64], label: 'Datasets',    hint: 'gold ring',   color: '#ffcf7a' },
  experiment: { r: [0.65, 0.76], label: 'Experiments', hint: 'amber gas',   color: '#ff9445' },
  pattern:    { r: [0.77, 0.92], label: 'Patterns',    hint: 'red wisps',   color: '#ff5a3a' },
  other:      { r: [0.60, 0.90], label: 'Other',       hint: 'scattered',   color: '#c9b8ff' },
};
export const ROLES = ['Scout', 'Filter', 'Analyst', 'Risk', 'Executor', 'Logger'];

export function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// Stable polar position for every record: same id → same place in the eye, always.
export function layoutRecords(records) {
  return records.map(r => {
    const layer = LAYERS[r.kind] ? r.kind : 'other';
    const [lo, hi] = LAYERS[layer].r;
    return { record: r, layer, angle: hash(r.id) * TAU, radius: lo + (hi - lo) * hash(r.id + '·r') };
  });
}

export function eventTone(e) {
  return /reject|fail|missing|unknown|stop|block|denied/i.test(e?.reason ?? '') ? 'reject' : 'accept';
}

// Labelled, deterministic example universe so the eye is never empty before you connect.
export function exampleUniverse() {
  const at = '2026-10-31T00:00:00Z';
  const src = [
    ['kalshi', 'Kalshi markets', 'prediction'], ['noaa-gfs', 'NOAA GFS forecasts', 'weather'],
    ['ecmwf', 'ECMWF open data', 'weather'], ['open-meteo', 'Open-Meteo archive', 'weather'],
    ['odds-api', 'The Odds API', 'prediction'], ['oanda', 'FX candles', 'forex'],
    ['helius', 'Helius Solana feed', 'crypto'], ['jupiter', 'Jupiter quotes', 'crypto'],
    ['fred', 'FRED macro series', 'other'], ['cot', 'CFTC positioning', 'commodities'],
  ];
  const out = [];
  const ex = (o) => out.push({ status: 'illustrative', updatedAt: at, description: 'Example record — not connected data. No finding or profit is claimed.', ...o });
  for (const [id, name, market] of src) {
    const ds = [];
    for (let i = 0; i < 4; i++) {
      const dId = `ex-${id}-d${i}`; ds.push(dId);
      ex({ id: dId, kind: 'dataset', name: `${name} · set ${i + 1}`, market, relatedIds: [`ex-${id}`] });
    }
    ex({ id: `ex-${id}`, kind: 'source', name, market, relatedIds: ds });
    for (let i = 0; i < 3; i++) {
      const eId = `ex-${id}-e${i}`, pId = `ex-${id}-p${i}`;
      ex({ id: eId, kind: 'experiment', name: `${name} test ${i + 1}`, market, status: 'not tested', relatedIds: [ds[i], pId] });
      ex({ id: pId, kind: 'pattern', name: `${name} hypothesis ${i + 1}`, market, status: 'unverified', relatedIds: [ds[(i + 1) % 4], eId] });
    }
  }
  return out;
}

// ---------- noise + random ----------
function rng(seed) { let s = (Math.imul(seed >>> 0, 2654435761) >>> 0) || 1; for (let i = 0; i < 12; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; } return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
function noise1(seed, period = 256) {
  const r = rng(seed), v = Float32Array.from({ length: period }, r);
  return x => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); const a = v[((i % period) + period) % period], b = v[(((i + 1) % period) + period) % period]; return a + (b - a) * u; };
}
const PAL = {
  ice: [120, 180, 255], blue: [30, 70, 190], white: [255, 236, 200], gold: [255, 190, 90],
  amber: [255, 128, 40], orange: [225, 72, 26], red: [170, 32, 20], crimson: [100, 16, 14],
};
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function ringColor(p) { // p = normalized radius 0..1.1
  if (p < 0.38) return mix(PAL.blue, PAL.ice, p / 0.38);
  if (p < 0.47) return mix(PAL.ice, PAL.white, (p - 0.38) / 0.09);
  if (p < 0.53) return mix(PAL.white, PAL.gold, (p - 0.47) / 0.06);
  if (p < 0.62) return mix(PAL.gold, PAL.amber, (p - 0.53) / 0.09);
  if (p < 0.72) return mix(PAL.amber, PAL.orange, (p - 0.62) / 0.10);
  if (p < 0.85) return mix(PAL.orange, PAL.red, (p - 0.72) / 0.13);
  return mix(PAL.red, PAL.crimson, Math.min(1, (p - 0.85) / 0.2));
}
const css = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function sprite(size, color) {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, css(color, 1)); grd.addColorStop(0.25, css(color, 0.45)); grd.addColorStop(1, css(color, 0));
  g.fillStyle = grd; g.fillRect(0, 0, size, size); return c;
}

// Pre-render the nebula into two layers (inner rim, outer gas) that rotate at different speeds.
function renderNebula(S, seed = 7) {
  const R = rng(seed), nA = noise1(seed + 1), nB = noise1(seed + 2), nC = noise1(seed + 3), nSpoke = noise1(seed + 4, 1024);
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'); g.globalCompositeOperation = 'lighter'; return [c, g]; };
  const [inner, gi] = mk(), [outer, go] = mk();
  const C = S / 2, U = S / 2 * 0.86; // U = unit radius in px
  const ring = th => 0.60 + 0.07 * (nA(th / TAU * 7) - 0.5) + 0.03 * (nB(th / TAU * 23) - 0.5);
  const spritesCache = new Map();
  const spr = (col, size) => { const k = col.map(v => (v / 24 | 0)).join() + size; if (!spritesCache.has(k)) spritesCache.set(k, sprite(size, col)); return spritesCache.get(k); };
  const put = (g, th, p, size, alpha) => {
    const col = ringColor(p), s = spr(col, size); g.globalAlpha = alpha;
    g.drawImage(s, C + Math.cos(th) * p * U - size / 2, C + Math.sin(th) * p * U - size / 2);
  };

  // 1. faint blue iris haze filling the pupil region
  for (let i = 0; i < 9000; i++) {
    const th = R() * TAU, p = Math.sqrt(R()) * ring(th) * 0.95;
    put(gi, th, p, 10 + R() * 26, 0.02 + 0.035 * p);
  }
  // 2. ring body: radial "spokes" carve the gas into filaments
  for (let i = 0; i < 90000; i++) {
    const th = R() * TAU, r0 = ring(th), spoke = nSpoke(th / TAU * 900 + R() * 0.15);
    if (R() > spoke * spoke * 1.6) continue;
    const u = R(), p = r0 - 0.11 + Math.pow(u, 1.05) * (0.34 + 0.14 * nC(th / TAU * 11));
    const outerGas = p > r0 + 0.06;
    put(outerGas ? go : gi, th, p, 3 + R() * (outerGas ? 10 : 6), 0.03 + 0.07 * Math.max(0, 1 - Math.abs(p - r0) * 3));
  }
  // 3. cometary knots on the inner edge: thin bright radial streaks pointing at the star
  gi.lineCap = 'round';
  for (let i = 0; i < 3800; i++) {
    const th = R() * TAU, r0 = ring(th), a = r0 - 0.13 - R() * 0.07, b = r0 - 0.02 + R() * 0.07;
    const x1 = C + Math.cos(th) * a * U, y1 = C + Math.sin(th) * a * U, x2 = C + Math.cos(th) * b * U, y2 = C + Math.sin(th) * b * U;
    const grd = gi.createLinearGradient(x1, y1, x2, y2);
    grd.addColorStop(0, css(PAL.ice, 0)); grd.addColorStop(0.5, css(PAL.white, 0.45)); grd.addColorStop(0.75, css(PAL.amber, 0.3)); grd.addColorStop(1, css(PAL.orange, 0));
    gi.globalAlpha = 0.06 + R() * 0.16; gi.strokeStyle = grd; gi.lineWidth = 0.5 + R() * 1.1;
    gi.beginPath(); gi.moveTo(x1, y1); gi.lineTo(x2, y2); gi.stroke();
    if (R() < 0.35) put(gi, th, b - 0.03, 4 + R() * 4, 0.35); // bright knot head
  }
  // 4. turbulent red wisps beyond the ring
  for (let i = 0; i < 4200; i++) {
    const th = R() * TAU, r0 = ring(th), p = r0 + 0.07 + Math.pow(R(), 1.3) * 0.45;
    const clump = nC(th / TAU * 31 + p * 9); if (R() > clump * 1.3) continue;
    put(go, th, Math.min(p, 1.1), 18 + R() * 46, 0.04 + 0.07 * clump);
  }
  // 5. outer filament lanes (slightly spiralled)
  go.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const th = R() * TAU, r0 = ring(th) + 0.08, len = 0.08 + R() * 0.26, tw = (R() - 0.5) * 0.25;
    go.strokeStyle = css(ringColor(r0 + len / 2), 0.08 + R() * 0.12); go.lineWidth = 0.6 + R() * 1.6;
    go.beginPath();
    for (let k = 0; k <= 8; k++) { const p = r0 + len * k / 8, t2 = th + tw * k / 8; const x = C + Math.cos(t2) * p * U, y = C + Math.sin(t2) * p * U; k ? go.lineTo(x, y) : go.moveTo(x, y); }
    go.stroke();
  }
  gi.globalAlpha = go.globalAlpha = 1;
  return { inner, outer, unit: 0.86 };
}

function renderStars(w, h, seed = 3) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), R = rng(seed);
  for (let i = 0; i < (w * h) / 1400; i++) {
    const x = R() * w, y = R() * h, m = Math.pow(R(), 6), tint = R();
    const col = tint < 0.08 ? [255, 214, 120] : tint < 0.16 ? [150, 190, 255] : tint < 0.2 ? [255, 140, 150] : [235, 238, 245];
    g.fillStyle = css(col, 0.25 + m * 0.75); g.beginPath(); g.arc(x, y, 0.35 + m * 1.6, 0, TAU); g.fill();
  }
  return c;
}

// ---------- mount ----------
export function mountEye({ navigate = () => false } = {}) {
  injectStyles();
  const root = document.createElement('section');
  root.id = 'eye'; root.className = 'page eye'; root.hidden = true;
  root.innerHTML = `
  <canvas class="eye-canvas" aria-label="The Eye: every record, agent and decision drawn as one nebula. Use search or the record list to inspect items."></canvas>
  <div class="eye-top">
    <div class="eye-brand">PARALLAX<small>THE EYE · EVERYTHING YOU KNOW, IN ONE VIEW</small></div>
    <div class="eye-search"><input type="search" placeholder="Search the universe…" aria-label="Search records" autocomplete="off"><div class="eye-results" role="listbox" aria-label="Matching records" hidden></div></div>
    <div class="eye-actions"><span class="eye-source" title="Where these records come from">EXAMPLE DATA</span><button data-act="connect">Connect data</button><button data-act="workspace">Workspace ↗</button><button data-act="motion" aria-pressed="false">Pause</button></div>
  </div>
  <div class="eye-legend" role="group" aria-label="Layers"><div class="eye-eyebrow">LAYERS · CLICK TO HIDE</div></div>
  <div class="eye-tip" hidden></div>
  <div class="eye-inspector" role="dialog" aria-label="Record details" hidden>
    <button class="eye-close" aria-label="Close record">✕</button>
    <div class="eye-eyebrow eye-kind"></div><h2></h2><dl></dl>
    <div class="eye-eyebrow">EVIDENCE</div><pre></pre>
    <div class="eye-eyebrow">CONNECTED</div><div class="eye-related"></div>
    <button class="eye-open">Open in data universe ↗</button>
  </div>
  <div class="eye-feed"><div class="eye-ticker" role="status">Waiting for decisions · the pupil flashes when an agent hands one in</div>
    <div class="eye-zoom"><button data-zoom="-1" aria-label="Zoom out">−</button><button data-zoom="0" aria-label="Reset view">◎</button><button data-zoom="1" aria-label="Zoom in">+</button></div></div>`;
  document.querySelector('main').append(root);

  const $ = s => root.querySelector(s);
  const canvas = $('canvas'), c = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1, stars = null, neb = null, t = 0, last = 0, open = 0;
  let paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let zoom = 1, panX = 0, panY = 0, mx = 0, my = 0, drag = null;
  let nodes = [], byId = new Map(), source = 'example', selected = null, hover = null, query = '';
  const hiddenLayers = new Set();
  let activeRole = null, flashes = [], streaks = [], seenEvents = 0;
  const gas = Array.from({ length: 1400 }, () => spawnGas());

  function spawnGas(R = Math.random) { return { th: R() * TAU, p: 0.42 + R() * 0.5, v: 0.004 + R() * 0.012, life: R(), s: 0.4 + R() * 1.4 }; }

  // ---- data ----
  function setRecords(records, from) {
    source = from;
    const agents = ROLES.map(name => ({ id: 'agent:' + name, kind: 'agent', name, status: 'idle', description: `${name} agent. Click to open its conversation.` }));
    nodes = layoutRecords([...agents, ...records]).map(n => ({ ...n, x: 0, y: 0, tw: hash(n.record.id + 't') * TAU }));
    byId = new Map(nodes.map(n => [n.record.id, n]));
    $('.eye-source').textContent = from === 'api' ? 'CONNECTED · ' + records.length + ' RECORDS' : 'EXAMPLE DATA · NOT LIVE';
    $('.eye-source').classList.toggle('live', from === 'api');
    renderLegend(); if (selected && !byId.has(selected.record.id)) inspect(null);
  }
  setRecords(exampleUniverse(), 'example');
  document.addEventListener('parallax:records', e => {
    const { records = [], source: from } = e.detail ?? {};
    if (from === 'api' && records.length) setRecords(records, 'api');
    else if (source === 'api') setRecords(exampleUniverse(), 'example');
  });

  function renderLegend() {
    const box = $('.eye-legend'); box.querySelectorAll('button').forEach(b => b.remove());
    for (const [key, L] of Object.entries(LAYERS)) {
      const count = nodes.filter(n => n.layer === key).length; if (!count && key === 'other') continue;
      const b = document.createElement('button'); b.setAttribute('aria-pressed', String(!hiddenLayers.has(key)));
      b.innerHTML = `<i style="--c:${L.color}"></i><span>${L.label}</span><small>${count} · ${L.hint}</small>`;
      b.onclick = () => { hiddenLayers.has(key) ? hiddenLayers.delete(key) : hiddenLayers.add(key); b.setAttribute('aria-pressed', String(!hiddenLayers.has(key))); };
      box.append(b);
    }
  }

  // ---- events from the paper desk + agent chats ----
  function ingestEvents(events) {
    if (!Array.isArray(events)) return;
    const fresh = events.slice(seenEvents); seenEvents = events.length;
    for (const e of fresh.slice(-12)) {
      const tone = eventTone(e);
      streaks.push({ from: 'agent:' + (ROLES.includes(e.agent) ? e.agent : 'Logger'), tone, t0: t + Math.random() * 0.6 });
      $('.eye-ticker').textContent = `${e.agent ?? 'Agent'} · ${e.mint ?? ''} — ${e.reason ?? ''}`;
    }
  }
  try { seenEvents = Math.max(0, (JSON.parse(localStorage.getItem('edge-paper-v1'))?.events?.length ?? 0) - 6); ingestEvents(JSON.parse(localStorage.getItem('edge-paper-v1'))?.events ?? []); } catch {}
  window.addEventListener('edge-desk-events', e => ingestEvents(e.detail));
  window.addEventListener('edge-agent-state', e => {
    activeRole = e.detail?.state === 'running' ? e.detail.role : null;
    if (e.detail?.state === 'done') streaks.push({ from: 'agent:' + e.detail.role, tone: 'accept', t0: t });
    $('.eye-ticker').textContent = `${e.detail?.role} · ${e.detail?.state}`;
  });

  // ---- geometry ----
  const eyeR = () => Math.min(w * 0.40, h * 0.62) * zoom;
  const SX = 1.30, SY = 0.86, TILT = -0.07; // almond eye
  function toScreen(th, p, parallax = 1) {
    const R = eyeR(), ox = w / 2 + panX + mx * 14 * parallax, oy = h / 2 + 10 + panY + my * 10 * parallax;
    const x = Math.cos(th) * p * R * SX, y = Math.sin(th) * p * R * SY * openEase();
    return [ox + x * Math.cos(TILT) - y * Math.sin(TILT), oy + x * Math.sin(TILT) + y * Math.cos(TILT)];
  }
  const openEase = () => { const k = Math.min(1, open); return 0.04 + 0.96 * (1 - Math.pow(1 - k, 3)); };
  const spin = layer => layer === 'agent' ? t * 0.05 : layer === 'pattern' || layer === 'experiment' ? t * 0.0045 : -t * 0.006;
  const matches = n => !query || [n.record.name, n.record.id, n.record.market, n.record.kind, n.record.description].join(' ').toLowerCase().includes(query);

  // ---- draw ----
  function drawLayer(img, rot, parallax, alpha) {
    const R = eyeR(), size = R / neb.unit * 2;
    const ox = w / 2 + panX + mx * 14 * parallax, oy = h / 2 + 10 + panY + my * 10 * parallax;
    c.save(); c.translate(ox, oy); c.rotate(TILT); c.scale(SX, SY * openEase()); c.rotate(rot);
    c.globalAlpha = alpha * Math.min(1, open * 1.4); c.drawImage(img, -size / 2, -size / 2, size, size); c.restore();
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (root.hidden || document.hidden || !w) { last = now; return; }
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (!paused) t += dt; open = Math.min(1.2, open + dt * 0.45 * (paused ? 3 : 1));
    if (!neb) { neb = renderNebula(1400); }
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    c.fillStyle = '#020309'; c.fillRect(0, 0, w, h);
    if (stars) { c.globalAlpha = 0.9; c.drawImage(stars, mx * -6 - 10, my * -5 - 10, w + 20, h + 20); }
    c.globalCompositeOperation = 'lighter';
    const breathe = 1 + Math.sin(t * 0.35) * 0.012;
    // outer gas behind, then inner rim — two speeds = depth
    drawLayer(neb.outer, t * 0.004, 1.6, 0.95 * breathe);
    drawLayer(neb.inner, -t * 0.006, 1.0, 1.0);
    drawLayer(neb.inner, t * 0.003 + 1.7, 0.7, 0.18); // ghost copy: shimmer

    // drifting gas: the nebula is expanding outward, like the real thing
    for (const g of gas) {
      if (!paused) { g.p += g.v * dt * 0.6; g.life += dt * 0.08; }
      if (g.p > 1.08 || g.life > 1) Object.assign(g, spawnGas(), { life: 0 });
      const a = Math.sin(g.life * Math.PI) * 0.55, [x, y] = toScreen(g.th + spin('dataset'), g.p, 1.1);
      c.fillStyle = css(ringColor(g.p), a); c.fillRect(x, y, g.s, g.s);
    }

    // pupil: the decision core star with diffraction spikes
    const [px, py] = toScreen(0, 0), R = eyeR();
    const pulse = flashes.reduce((m, f) => Math.max(m, 1 - (t - f) / 1.2), 0);
    const core = c.createRadialGradient(px, py, 0, px, py, R * 0.32);
    core.addColorStop(0, `rgba(170,215,255,${0.35 + pulse * 0.3})`); core.addColorStop(0.3, 'rgba(60,110,230,.12)'); core.addColorStop(1, 'rgba(20,40,120,0)');
    c.fillStyle = core; c.beginPath(); c.arc(px, py, R * 0.32, 0, TAU); c.fill();
    const sr = 2.4 + pulse * 3 + Math.sin(t * 2.1) * 0.3;
    c.fillStyle = '#fff'; c.beginPath(); c.arc(px, py, sr, 0, TAU); c.fill();
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + 0.25, L = (18 + pulse * 40) * (k % 2 ? 0.7 : 1);
      const gr = c.createLinearGradient(px, py, px + Math.cos(a) * L, py + Math.sin(a) * L);
      gr.addColorStop(0, 'rgba(220,240,255,.9)'); gr.addColorStop(1, 'rgba(120,170,255,0)');
      c.strokeStyle = gr; c.lineWidth = 1; c.beginPath(); c.moveTo(px - Math.cos(a) * L, py - Math.sin(a) * L); c.lineTo(px + Math.cos(a) * L, py + Math.sin(a) * L); c.stroke();
    }
    flashes = flashes.filter(f => t - f < 1.2);

    // data: every record is a knot of light
    const sel = selected?.record;
    const relatedIds = new Set(sel ? [...(sel.relatedIds ?? []), ...nodes.filter(n => n.record.relatedIds?.includes(sel.id)).map(n => n.record.id)] : []);
    for (const n of nodes) {
      const [x, y] = toScreen(n.angle + spin(n.layer), n.radius, n.layer === 'agent' ? 0.8 : n.radius > 0.7 ? 1.4 : 1.1);
      n.x = x; n.y = y;
    }
    // filaments from the selected record to everything it touches
    if (sel) {
      c.lineWidth = 1.1; c.setLineDash([4, 7]); c.lineDashOffset = -t * 24;
      for (const id of relatedIds) {
        const o = byId.get(id); if (!o) continue;
        const qx = (selected.x + o.x) / 2 + (px - (selected.x + o.x) / 2) * 0.45, qy = (selected.y + o.y) / 2 + (py - (selected.y + o.y) / 2) * 0.45;
        c.strokeStyle = 'rgba(255,214,150,.75)'; c.beginPath(); c.moveTo(selected.x, selected.y); c.quadraticCurveTo(qx, qy, o.x, o.y); c.stroke();
      }
      c.setLineDash([]);
    }
    for (const n of nodes) {
      if (hiddenLayers.has(n.layer)) continue;
      const L = LAYERS[n.layer], hit = matches(n), isSel = sel?.id === n.record.id, isRel = relatedIds.has(n.record.id);
      const dim = (query && !hit) || (sel && !isSel && !isRel) ? 0.18 : 1;
      const tw = 0.75 + 0.25 * Math.sin(t * 1.7 + n.tw), working = n.layer === 'agent' && activeRole === n.record.name;
      const size = (n.layer === 'agent' ? 22 : n.layer === 'source' ? 15 : 11) * (isSel ? 1.8 : 1) * (working ? 1.6 + Math.sin(t * 6) * 0.3 : 1);
      const halo = c.createRadialGradient(n.x, n.y, 0, n.x, n.y, size);
      halo.addColorStop(0, hexA(L.color, 0.55 * dim * tw)); halo.addColorStop(1, hexA(L.color, 0));
      c.fillStyle = halo; c.beginPath(); c.arc(n.x, n.y, size, 0, TAU); c.fill();
      // cometary tail pointing away from the star
      const dx = n.x - px, dy = n.y - py, d = Math.hypot(dx, dy) || 1, tl = n.layer === 'agent' ? 0 : 7 + n.radius * 12;
      if (tl) { c.strokeStyle = hexA(L.color, 0.35 * dim); c.lineWidth = 1; c.beginPath(); c.moveTo(n.x, n.y); c.lineTo(n.x + dx / d * tl, n.y + dy / d * tl); c.stroke(); }
      c.fillStyle = `rgba(255,255,255,${0.9 * dim})`; c.beginPath(); c.arc(n.x, n.y, n.layer === 'agent' ? 2.6 : isSel ? 2.6 : 1.5, 0, TAU); c.fill();
    }
    // decision streaks: agent → pupil (accepted) or agent → out into the red (rejected)
    streaks = streaks.filter(s => t - s.t0 < 1.6);
    for (const s of streaks) {
      const a = byId.get(s.from), k = (t - s.t0) / 1.4; if (!a || k < 0) continue;
      const e = Math.min(1, k), ease = e * e * (3 - 2 * e);
      const tx = s.tone === 'accept' ? px : a.x + (a.x - px) * 2.2, ty = s.tone === 'accept' ? py : a.y + (a.y - py) * 2.2;
      const hx = a.x + (tx - a.x) * ease, hy = a.y + (ty - a.y) * ease, col = s.tone === 'accept' ? [255, 222, 160] : [255, 90, 60];
      const gr = c.createLinearGradient(a.x, a.y, hx, hy); gr.addColorStop(0, css(col, 0)); gr.addColorStop(1, css(col, 0.9 * (1 - Math.max(0, k - 1) * 5)));
      c.strokeStyle = gr; c.lineWidth = 2; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(hx, hy); c.stroke();
      if (s.tone === 'accept' && k >= 1 && !s.flashed) { s.flashed = true; flashes.push(t); }
    }
    // labels: agents always, plus hover/selected/search hits
    c.globalCompositeOperation = 'source-over'; c.font = '600 10px "DM Sans",system-ui,sans-serif'; c.textBaseline = 'middle';
    for (const n of nodes) {
      if (hiddenLayers.has(n.layer)) continue;
      const show = n.layer === 'agent' || n === hover || n === selected || (query && matches(n) && nodes.length < 400);
      if (!show) continue;
      const label = n.layer === 'agent' ? n.record.name.toUpperCase() + (activeRole === n.record.name ? ' · WORKING' : '') : n.record.name.slice(0, 34);
      c.fillStyle = n.layer === 'agent' ? 'rgba(210,232,255,.92)' : 'rgba(255,240,215,.95)';
      c.fillText(label, n.x + 10, n.y - 1);
    }
  }
  function hexA(hex, a) { const v = parseInt(hex.slice(1), 16); return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${Math.max(0, a)})`; }

  // ---- interaction ----
  function nearest(x, y) {
    let best = null, bd = 16 * 16;
    for (const n of nodes) { if (hiddenLayers.has(n.layer)) continue; const d = (n.x - x) ** 2 + (n.y - y) ** 2; if (d < bd) { bd = d; best = n; } }
    return best;
  }
  const tip = $('.eye-tip');
  canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (!w || !h) return; mx = x / w - 0.5; my = y / h - 0.5;
    if (drag) { panX = drag.px + x - drag.x; panY = drag.py + y - drag.y; drag.moved ||= Math.abs(x - drag.x) + Math.abs(y - drag.y) > 4; return; }
    hover = nearest(x, y); canvas.style.cursor = hover ? 'pointer' : 'grab';
    if (hover) { tip.hidden = false; tip.style.transform = `translate(${x + 16}px,${y + 14}px)`; tip.innerHTML = ''; tip.append(txt('small', LAYERS[hover.layer].label.replace(/s$/, '').toUpperCase() + (hover.record.market ? ' · ' + hover.record.market : '')), txt('strong', hover.record.name), txt('span', hover.record.status ?? '')); }
    else tip.hidden = true;
  });
  canvas.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; });
  canvas.addEventListener('pointerdown', e => { const r = canvas.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top, px: panX, py: panY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', e => {
    const wasDrag = drag?.moved; drag = null; if (wasDrag) return;
    const r = canvas.getBoundingClientRect(), n = nearest(e.clientX - r.left, e.clientY - r.top);
    if (n?.layer === 'agent') { flashes.push(t); navigate('conversations'); window.dispatchEvent(new CustomEvent('edge-select-agent', { detail: n.record.name })); }
    else inspect(n);
  });
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoom = Math.min(3.2, Math.max(0.6, zoom * Math.exp(-e.deltaY * 0.0012))); }, { passive: false });
  canvas.addEventListener('dblclick', () => { zoom = 1; panX = panY = 0; });
  root.querySelectorAll('[data-zoom]').forEach(b => b.onclick = () => { const z = +b.dataset.zoom; if (!z) { zoom = 1; panX = panY = 0; } else zoom = Math.min(3.2, Math.max(0.6, zoom * (z > 0 ? 1.3 : 1 / 1.3))); });

  function txt(tag, s, cls) { const e = document.createElement(tag); e.textContent = s ?? ''; if (cls) e.className = cls; return e; }
  function inspect(n) {
    selected = n; const box = $('.eye-inspector'); box.hidden = !n; if (!n) return;
    const r = n.record;
    $('.eye-kind').textContent = LAYERS[n.layer].label.replace(/s$/, '').toUpperCase() + ' · ' + (source === 'api' ? 'CONNECTED' : 'EXAMPLE');
    box.querySelector('h2').textContent = r.name;
    const dl = box.querySelector('dl'); dl.replaceChildren();
    for (const [k, v] of [['Market', r.market], ['Status', r.status], ['Updated', r.updatedAt], ['Source', r.provenance?.source], ['Observed', r.provenance?.observedAt], ['About', r.description]]) if (v) dl.append(txt('dt', k), txt('dd', v));
    box.querySelector('pre').textContent = JSON.stringify(r.evidence ?? { status: 'No supporting evidence supplied' }, null, 2);
    const rel = box.querySelector('.eye-related'); rel.replaceChildren();
    const ids = new Set([...(r.relatedIds ?? []), ...nodes.filter(o => o.record.relatedIds?.includes(r.id)).map(o => o.record.id)]);
    for (const id of ids) { const o = byId.get(id); if (!o) continue; const b = txt('button', o.record.name); b.prepend(txt('i', '', '')); b.firstChild.style.setProperty('--c', LAYERS[o.layer].color); b.onclick = () => inspect(o); rel.append(b); }
    if (!rel.children.length) rel.append(txt('p', 'No supplied relationships.'));
  }
  $('.eye-close').onclick = () => inspect(null);
  $('.eye-open').onclick = () => navigate('parallax');

  const input = $('.eye-search input'), results = $('.eye-results');
  input.oninput = () => {
    query = input.value.trim().toLowerCase(); results.replaceChildren();
    const hits = query ? nodes.filter(matches).slice(0, 8) : []; results.hidden = !hits.length;
    for (const n of hits) { const b = txt('button', n.record.name); b.setAttribute('role', 'option'); b.prepend(txt('small', LAYERS[n.layer].label.replace(/s$/, ''))); b.onclick = () => { inspect(n); results.hidden = true; }; results.append(b); }
  };
  input.onkeydown = e => { if (e.key === 'Enter') results.querySelector('button')?.click(); if (e.key === 'Escape') { input.value = ''; input.oninput(); } };

  const motion = $('[data-act="motion"]');
  const motionLabel = () => { motion.textContent = paused ? 'Resume' : 'Pause'; motion.setAttribute('aria-pressed', String(paused)); };
  motion.onclick = () => { paused = !paused; motionLabel(); }; motionLabel();
  $('[data-act="workspace"]').onclick = () => { root.hidden = true; navigate('workflow'); };
  $('[data-act="connect"]').onclick = () => { root.hidden = true; navigate('parallax'); };
  addEventListener('keydown', e => { if (!root.hidden && e.key === 'Escape') inspect(null); });

  new ResizeObserver(() => {
    w = root.clientWidth; h = root.clientHeight; dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = w * dpr; canvas.height = h * dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = renderStars(w + 20, h + 20);
  }).observe(root);
  requestAnimationFrame(frame);

  function show() {
    document.querySelectorAll('.page').forEach(p => { if (p !== root) p.hidden = true; });
    document.body.classList.add('workflow-mode'); root.hidden = false; open = 0;
  }
  // a way back from the workspace
  const back = document.createElement('button'); back.textContent = '◉ The Eye'; back.className = 'eye-back'; back.onclick = show;
  document.querySelector('.wf-nav')?.prepend(back);
  return { show, setRecords };
}

function injectStyles() {
  if (document.getElementById('eye-styles')) return;
  const s = document.createElement('style'); s.id = 'eye-styles';
  s.textContent = `
.eye [hidden]{display:none!important}
.eye{position:fixed!important;inset:0;z-index:5;overflow:hidden;background:#020309;color:#f3ece2;padding:0!important;font-family:'DM Sans',system-ui,sans-serif}
.eye-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none}
.eye button{font:inherit;color:inherit;cursor:pointer;background:rgba(8,10,20,.55);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:8px 14px;font-size:11px;letter-spacing:.04em;backdrop-filter:blur(8px)}
.eye button:hover,.eye button:focus-visible{border-color:#e9c98f;color:#ffe2a6;outline:none}
.eye-top{position:absolute;top:22px;left:28px;right:28px;display:flex;align-items:flex-start;gap:20px;z-index:2;pointer-events:none}
.eye-top>*{pointer-events:auto}
.eye-brand{font:500 18px 'Space Grotesk',sans-serif;letter-spacing:.28em}
.eye-brand small{display:block;font:500 8px 'DM Sans',sans-serif;letter-spacing:.3em;color:#9aa3b2;margin-top:7px}
.eye-search{position:relative;margin:0 auto;width:min(420px,40vw)}
.eye-search input{width:100%;background:rgba(6,8,16,.6);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:10px 18px;color:#f3ece2;font:inherit;font-size:13px;backdrop-filter:blur(10px)}
.eye-search input:focus{outline:none;border-color:#e9c98f}
.eye-results{position:absolute;top:46px;left:0;right:0;display:grid;gap:2px;padding:6px;background:rgba(6,8,16,.92);border:1px solid rgba(255,255,255,.12);border-radius:14px}
.eye-results button{border:0;border-radius:8px;text-align:left;background:transparent;font-size:12px;padding:8px 10px}
.eye-results small{display:inline-block;width:78px;color:#e9c98f;font-size:9px;letter-spacing:.14em;text-transform:uppercase}
.eye-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.eye-source{font-size:9px;letter-spacing:.18em;color:#e9c98f;border:1px solid #6a5537;border-radius:999px;padding:6px 11px}
.eye-source.live{color:#9fe6c0;border-color:#2f6b52}
.eye-legend{position:absolute;left:28px;bottom:84px;z-index:2;display:grid;gap:4px;width:200px}
.eye-eyebrow{font-size:9px;letter-spacing:.22em;color:#8e97a8;margin:0 0 6px}
.eye-legend button{display:grid;grid-template-columns:14px 1fr;column-gap:8px;text-align:left;border-radius:10px;border-color:transparent;background:transparent;padding:6px 8px}
.eye-legend button[aria-pressed=false]{opacity:.35}
.eye-legend i,.eye-related i{width:9px;height:9px;border-radius:50%;background:var(--c);box-shadow:0 0 10px var(--c);align-self:center;display:inline-block}
.eye-legend small{grid-column:2;color:#8e97a8;font-size:10px;letter-spacing:0}
.eye-tip{position:absolute;left:0;top:0;z-index:3;pointer-events:none;display:grid;gap:2px;max-width:260px;padding:9px 12px;background:rgba(6,8,16,.9);border:1px solid rgba(233,201,143,.35);border-radius:10px;font-size:12px}
.eye-tip small{font-size:9px;letter-spacing:.16em;color:#e9c98f}.eye-tip span{color:#9aa3b2;font-size:11px}
.eye-inspector{position:absolute;right:24px;top:84px;bottom:84px;width:min(380px,calc(100vw - 48px));z-index:3;overflow:auto;padding:24px;background:rgba(6,8,16,.82);border:1px solid rgba(255,255,255,.1);border-radius:18px;backdrop-filter:blur(14px)}
.eye-inspector h2{font:500 22px/1.2 'Space Grotesk',sans-serif;margin:4px 0 16px}
.eye-kind{color:#e9c98f}
.eye-inspector dl{display:grid;grid-template-columns:80px 1fr;gap:6px 12px;font-size:12px;margin:0 0 18px}
.eye-inspector dt{color:#8e97a8}.eye-inspector dd{margin:0;overflow-wrap:anywhere}
.eye-inspector pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(0,0,0,.35);border-radius:10px;padding:12px;margin:0 0 18px;color:#cfd5df}
.eye-related{display:grid;gap:6px;margin-bottom:18px}
.eye-related button{text-align:left;border-radius:10px;display:flex;gap:9px;align-items:center}
.eye-related p{color:#8e97a8;font-size:12px}
.eye-close{position:absolute;right:16px;top:16px;padding:4px 10px!important}
.eye-feed{position:absolute;left:28px;right:28px;bottom:22px;z-index:2;display:flex;justify-content:space-between;align-items:center;gap:16px;font-size:11px;color:#9aa3b2;letter-spacing:.04em}
.eye-ticker{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.eye-zoom{display:flex;gap:6px}.eye-zoom button{width:34px;padding:7px 0}
.wf-nav .eye-back{color:#ffe2a6}
@media(max-width:760px){.eye-top{flex-wrap:wrap;left:16px;right:16px;top:16px;gap:12px}.eye-search{order:3;width:100%}.eye-legend{left:16px;bottom:70px;width:auto;grid-template-columns:repeat(3,auto)}.eye-legend small{display:none}.eye-feed{left:16px;right:16px}.eye-inspector{right:16px;left:16px;width:auto;top:auto;bottom:70px;max-height:55vh}}
@media(prefers-reduced-motion:reduce){.eye *{transition:none!important}}`;
  document.head.append(s);
}
