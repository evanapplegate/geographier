// Builds data/countries.json and data/us-states.json from Natural Earth 10m GeoJSON.
// Usage: node build.js <ne_dir>
const fs = require("fs");
const path = require("path");
const d3 = require("d3-geo");

const NE = process.argv[2];
const OUT = path.join(__dirname, "..", "data");
fs.mkdirSync(OUT, { recursive: true });

const BOX = +(process.env.BOX || 500);   // longest side in px
const TOL = +(process.env.TOL || 1.0);    // Douglas-Peucker tolerance in px
const MIN_RING_PX2 = +(process.env.MINRING || 10); // rings smaller than this become dots
const MAX_DOTS = 40;
const MAX_PTS = +(process.env.MAXPTS || 700); // per-feature vertex budget; tolerance grows until met
const R = 6371;

// ---------- helpers ----------
function polygons(geom) {
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  return [];
}
function km2(coords) { return d3.geoArea({ type: "Polygon", coordinates: coords }) * R * R; }
function distKm(a, b) { return d3.geoDistance(a, b) * R; }

function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    const [x1, y1] = pts[s], [x2, y2] = pts[e];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = pts[i]; let d;
      if (len2 === 0) d = Math.hypot(x - x1, y - y1);
      else { const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)); d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)); }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function ringArea(pts) { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; a += x1 * y2 - x2 * y1; } return a / 2; }
function ringCentroid(pts) { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; }

// Project a feature's geometry into a w x h box, return {w,h,d}
function outline(geom) {
  const polys = polygons(geom);
  const feat = { type: "Feature", geometry: geom };
  const [lon0, lat0] = d3.geoCentroid(feat);
  const b = d3.geoBounds(feat); // [[w,s],[e,n]]
  let s = b[0][1], n = b[1][1];
  if (n - s < 2) { s -= 1; n += 1; }
  const p1 = s + (n - s) / 6, p2 = n - (n - s) / 6;
  const proj = d3.geoConicEqualArea().rotate([-lon0, 0]).parallels([p1, p2]).precision(0);
  // project raw vertices (no resampling), then fit
  const rings = []; // {pts, hole}
  for (const poly of polys) poly.forEach((ring, i) => rings.push({ pts: ring.map(pt => proj(pt)).filter(Boolean), hole: i > 0 }));
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const r of rings) for (const [x, y] of r.pts) { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; }
  const scale = BOX / Math.max(maxx - minx, maxy - miny);
  const w = Math.max(1, Math.round((maxx - minx) * scale)), h = Math.max(1, Math.round((maxy - miny) * scale));
  let solid = [], dots = [], tol = TOL;
  for (let pass = 0; pass < 12; pass++) {
    solid = []; dots = [];
    for (const r of rings) {
      let pts = r.pts.map(([x, y]) => [(x - minx) * scale, (y - miny) * scale]);
      pts = dp(pts, tol);
      const a = Math.abs(ringArea(pts));
      if (pts.length < 4 || a < MIN_RING_PX2) { if (!r.hole) dots.push({ c: ringCentroid(r.pts.map(([x, y]) => [(x - minx) * scale, (y - miny) * scale])), a }); continue; }
      solid.push(pts);
    }
    const n = solid.reduce((acc, p) => acc + p.length, 0);
    if (n <= MAX_PTS) break;
    tol *= 1.25;
  }
  dots.sort((p, q) => q.a - p.a);
  let d = "";
  for (const pts of solid) {
    let px = 0, py = 0;
    pts.forEach(([x, y], i) => {
      const rx = Math.round(x), ry = Math.round(y);
      if (i === 0) d += `M${rx} ${ry}`;
      else { const ddx = rx - px, ddy = ry - py; if (ddx === 0 && ddy === 0) return; d += `l${ddx} ${ddy}`; }
      px = rx; py = ry;
    });
    d += "z";
  }
  const solidArea = solid.reduce((acc, p) => acc + Math.abs(ringArea(p)), 0);
  const nDots = solidArea < 20000 ? MAX_DOTS : Math.min(dots.length, 16);
  const dr = Math.max(3, Math.round(BOX / 120));
  for (const { c } of dots.slice(0, nDots)) {
    const [x, y] = c.map(v => Math.round(v - dr / 2));
    d += `M${x} ${y}h${dr}v${dr}h-${dr}z`;
  }
  return { w, h, d: d.replace(/l(-?\d+) (-?\d+)/g, (m, a, b) => "l" + a + (b[0] === "-" ? b : " " + b)).replace(/l(-?\d+)(-?\d+)/g, "l$1$2") };
}

// Keep only polygons within a distance budget of the area-weighted centroid.
function trimFarFlung(geom, keepAll) {
  const polys = polygons(geom);
  if (polys.length < 2 || keepAll === true) return geom;
  const feat = { type: "Feature", geometry: geom };
  const c = d3.geoCentroid(feat);
  const total = d3.geoArea(feat) * R * R;
  const D = Math.max(1400, 2.2 * Math.sqrt(total));
  let kept = polys.filter(p => distKm(d3.geoCentroid({ type: "Polygon", coordinates: p }), c) <= D);
  if (keepAll && typeof keepAll === "function") kept = polys.filter(p => keepAll(d3.geoCentroid({ type: "Polygon", coordinates: p })));
  return { type: "MultiPolygon", coordinates: kept.length ? kept : polys };
}

function uniq(arr) { const seen = new Set(); return arr.filter(x => { if (!x || typeof x !== "string") return false; const k = x.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }).map(x => x.trim()); }

// ---------- countries ----------
const DISPLAY = { RUS: "Russia", KOR: "South Korea", PRK: "North Korea", LAO: "Laos", CZE: "Czechia", BRN: "Brunei", CPV: "Cabo Verde", SWZ: "Eswatini", KGZ: "Kyrgyzstan", SVK: "Slovakia", FSM: "Micronesia", GMB: "The Gambia", PSX: "Palestine", KOS: "Kosovo", VAT: "Vatican City", TUR: "Turkey", CIV: "Côte d'Ivoire", MKD: "North Macedonia", SDS: "South Sudan", USA: "United States", GBR: "United Kingdom" };
const EXTRA = {
  USA: ["USA", "US", "U.S.", "U.S.A.", "America", "United States", "the States"],
  GBR: ["UK", "U.K.", "Britain", "Great Britain"],
  ARE: ["UAE", "Emirates"],
  COD: ["DRC", "DR Congo", "Congo-Kinshasa", "Zaire", "Democratic Republic of Congo", "Congo DRC", "Congo"],
  COG: ["Congo-Brazzaville", "Republic of Congo", "Congo"],
  MMR: ["Burma"], CIV: ["Ivory Coast", "Cote d'Ivoire"], SWZ: ["Swaziland"], MKD: ["Macedonia"], TLS: ["East Timor"],
  CPV: ["Cape Verde"], NLD: ["Holland", "The Netherlands"], KOR: ["Korea", "ROK", "Republic of Korea"], PRK: ["Korea", "DPRK"],
  BIH: ["Bosnia", "Bosnia-Herzegovina"], TTO: ["Trinidad"], KNA: ["St Kitts", "Saint Kitts", "St. Kitts and Nevis"], VCT: ["St Vincent", "Saint Vincent"],
  ATG: ["Antigua"], STP: ["Sao Tome", "Sao Tome and Principe"], PNG: ["PNG"], NZL: ["NZ", "Aotearoa"], ZAF: ["RSA"], CAF: ["CAR"],
  DOM: ["Dominican Rep", "DR"], GNQ: ["Eq Guinea"], SLB: ["Solomons"], MHL: ["Marshalls"], FSM: ["FSM", "Federated States of Micronesia"],
  PSX: ["Palestine", "Palestinian Territories", "West Bank and Gaza", "State of Palestine"], TWN: ["Republic of China", "Chinese Taipei", "ROC"], CHN: ["PRC"],
  IRN: ["Persia"], KHM: ["Kampuchea"], LKA: ["Ceylon"], BLR: ["Byelorussia", "Belorussia"], MDA: ["Moldavia"], KGZ: ["Kirghizia", "Kyrgyz Republic"],
  TUR: ["Türkiye", "Turkiye"], IND: ["Bharat"], JPN: ["Nippon"], DEU: ["Deutschland"], ESP: ["España"], CZE: ["Czech Republic", "Czechia"],
  LAO: ["Laos", "Lao"], RUS: ["Russia"], SYR: ["Syria"], VEN: ["Venezuela"], BOL: ["Bolivia"], TZA: ["Tanzania"], VNM: ["Viet Nam"],
  GMB: ["Gambia"], BHS: ["Bahamas"], MAC: ["Macau"], VAT: ["Vatican", "Holy See", "Vatican City"], BRN: ["Brunei"], KOS: ["Kosovo", "Kosova"],
  SDS: ["South Sudan"], ESH: ["Western Sahara"], SRB: ["Serbia"], MNE: ["Montenegro"], HRV: ["Croatia", "Hrvatska"], GRC: ["Greece", "Hellas"],
  CHE: ["Switzerland", "Swiss"], HUN: ["Hungary"], AUT: ["Austria"], SAU: ["Saudi", "KSA"], ETH: ["Abyssinia"], THA: ["Siam"], IRQ: ["Iraq"],
  EGY: ["Egypt"], MEX: ["Mexico", "México"], BRA: ["Brazil", "Brasil"], ARG: ["Argentina"], PHL: ["Philippines", "the Philippines", "Pilipinas"],
};
const EXCLUDE = new Set(["ABW", "ALD", "CUW", "GGY", "GRL", "HKG", "IMN", "JEY", "MAC", "SXM", "SOL", "CYN", "SMR", "VAT", "MCO", "NRU", "TUV"]);
const INCLUDE = new Set(["KOS", "PSX"]);
const TRIM = { NOR: c => c[1] > 55 && c[1] < 72 && c[0] > 0, ECU: c => c[0] > -85, PRT: c => c[0] > -20, ESP: c => c[1] > 30 };

const a0 = JSON.parse(fs.readFileSync(path.join(NE, "admin0.geojson")));
const countries = [];
for (const f of a0.features) {
  const p = f.properties, id = p.ADM0_A3;
  const ok = (["Sovereign country", "Country", "Sovereignty"].includes(p.TYPE) && !EXCLUDE.has(id)) || INCLUDE.has(id);
  if (!ok) continue;
  const geom = trimFarFlung(f.geometry, TRIM[id] || false);
  const name = DISPLAY[id] || p.NAME_LONG || p.NAME;
  const sortName = (p.NAME_SORT || "").replace(/^(.*), The$/, "The $1").replace(/^(.*), (.*)$/, "$2 $1");
  const aliases = uniq([name, p.NAME, p.NAME_LONG, p.NAME_EN, p.FORMAL_EN, sortName, p.NAME_CIAWF, p.NAME_ALT, p.BRK_NAME, p.ADMIN, p.GEOUNIT, p.SUBUNIT, p.ABBREV, ...(EXTRA[id] || [])]).filter(a => a !== name);
  const c = d3.geoCentroid({ type: "Feature", geometry: geom }).map(v => +v.toFixed(1));
  let cont = p.CONTINENT; if (cont === "Seven seas (open ocean)") cont = /Asia/.test(p.SUBREGION) ? "Asia" : "Africa";
  countries.push({ id, name, aliases, c, r: cont, ...outline(geom) });
}
countries.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(OUT, "countries.json"), JSON.stringify({ noun: "country", items: countries }));
console.log("countries:", countries.length, "bytes:", fs.statSync(path.join(OUT, "countries.json")).size);
const regs = {}; for (const c of countries) regs[c.r] = (regs[c.r] || 0) + 1; console.log(regs);

// ---------- US states (composite Albers USA map, all states in one coordinate space) ----------
// Input is produced by mapshaper: ne_10m_admin_1_states_provinces_lakes -> filter US states -> -proj albersusa -> simplify
const us = JSON.parse(fs.readFileSync(path.join(NE, "us_albers.geojson")));
const REGIONS = {
  "New England": ["CT", "ME", "MA", "NH", "RI", "VT"],
  "Mid-Atlantic": ["NY", "NJ", "PA", "DE", "MD"],
  "The South": ["VA", "WV", "NC", "SC", "GA", "FL", "KY", "TN", "AL", "MS"],
  "South Central": ["AR", "LA", "TX", "OK"],
  "Great Lakes": ["OH", "MI", "IN", "IL", "WI", "MN"],
  "Great Plains": ["IA", "MO", "ND", "SD", "NE", "KS"],
  "Mountain West": ["MT", "ID", "WY", "CO", "UT", "NV", "AZ", "NM"],
  "Pacific": ["WA", "OR", "CA", "AK", "HI"],
};
const REGION_OF = {}; for (const [r, ids] of Object.entries(REGIONS)) for (const id of ids) REGION_OF[id] = r;
{
  const W = 960;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const eachPt = (geom, fn) => { for (const poly of polygons(geom)) for (const ring of poly) for (const pt of ring) fn(pt); };
  for (const f of us.features) eachPt(f.geometry, ([x, y]) => { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; });
  const scale = W / (maxx - minx);
  const H = Math.round((maxy - miny) * scale);
  const states = [];
  for (const f of us.features) {
    const p = f.properties;
    let d = "";
    for (const poly of polygons(f.geometry)) for (const ring of poly) {
      let px = 0, py = 0;
      ring.forEach((pt, i) => {
        const rx = Math.round((pt[0] - minx) * scale), ry = Math.round((maxy - pt[1]) * scale);
        if (i === 0) d += `M${rx} ${ry}`;
        else { const dx = rx - px, dy = ry - py; if (dx === 0 && dy === 0) return; d += `l${dx} ${dy}`; }
        px = rx; py = ry;
      });
      d += "z";
    }
    d = d.replace(/l(-?\d+) (-?\d+)/g, (m, a, b) => "l" + a + (b[0] === "-" ? b : " " + b));
    const aliases = uniq([p.postal, p.abbrev, ...String(p.name_alt || "").split("|"), p.name_en, p.gn_name, p.woe_name, (p.iso_3166_2 || "").split("-")[1]]).filter(a => a !== p.name);
    if (!REGION_OF[p.postal]) throw new Error("no region for " + p.postal);
    states.push({ id: p.postal, name: p.name, aliases, c: [+(+p.longitude).toFixed(1), +(+p.latitude).toFixed(1)], r: REGION_OF[p.postal], d });
  }
  states.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(OUT, "us-states.json"), JSON.stringify({ noun: "state", map: { w: W, h: H }, items: states }));
  console.log("states:", states.length, "bytes:", fs.statSync(path.join(OUT, "us-states.json")).size, "map", W, "x", H);
}
