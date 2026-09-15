(() => {
  const $ = id => document.getElementById(id);
  const els = {
    menu: $("menu"), quiz: $("quiz"), decks: $("decks"), modes: $("modes"), start: $("start"), home: $("home"),
    question: $("question"), map: $("map"), svg: $("svg"), shape: $("shape"), feedback: $("feedback"),
    options: $("options"), form: $("typeform"), guess: $("guess"), skip: $("skip"), next: $("next"),
    streak: $("streak"), best: $("best"), menuStats: $("menu-stats"),
  };

  // ---------- persistence ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("geographier:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("geographier:" + k, JSON.stringify(v)); } catch {} },
  };
  const prefs = store.get("prefs", { deck: "us-states", mode: "easy" });
  const statKey = () => `${prefs.deck}:${prefs.mode}`;
  const stats = () => store.get("stats:" + statKey(), { streak: 0, best: 0, seen: 0, right: 0 });
  const saveStats = s => store.set("stats:" + statKey(), s);

  // ---------- data ----------
  const cache = {};
  async function loadDeck(name) {
    if (cache[name]) return cache[name];
    const r = await fetch(`data/${name}.json`);
    if (!r.ok) throw new Error("Could not load deck");
    const deck = await r.json();
    for (const it of deck.items) it.keys = uniq([it.name, ...it.aliases].map(norm));
    cache[name] = deck;
    return deck;
  }

  // ---------- text matching ----------
  function norm(s) {
    return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/&/g, " and ").replace(/\bst\.?\s+/g, "saint ").replace(/\bmt\.?\s+/g, "mount ")
      .replace(/[^a-z0-9]+/g, " ").trim().replace(/^the\s+/, "").replace(/\s+/g, " ");
  }
  function uniq(a) { return [...new Set(a.filter(Boolean))]; }
  // Optimal string alignment distance (Levenshtein + adjacent transpositions)
  function osa(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev2 = null, prev = Array.from({ length: n + 1 }, (_, j) => j), cur;
    for (let i = 1; i <= m; i++) {
      cur = [i];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
      }
      prev2 = prev; prev = cur;
    }
    return prev[n];
  }
  const tolerance = len => len <= 3 ? 0 : len <= 5 ? 1 : len <= 12 ? 2 : 3;
  function bestDist(guess, keys) {
    let best = Infinity;
    for (const k of keys) {
      const d = osa(guess, k);
      if (d < best) best = d;
      if (best === 0) break;
    }
    return best;
  }
  // Accept if the guess is within tolerance of one of the item's names and is not
  // at least as close to some other item in the deck.
  function matches(guess, item, items) {
    const g = norm(guess);
    if (g.length < 2) return false;
    if (item.keys.includes(g)) return true;
    let dc = Infinity, tolOk = false;
    for (const k of item.keys) {
      const d = osa(g, k);
      if (d <= tolerance(k.length) && d < dc) { dc = d; tolOk = true; }
    }
    if (!tolOk) return false;
    for (const other of items) {
      if (other === item) continue;
      if (bestDist(g, other.keys) < dc) return false;
    }
    return true;
  }

  // ---------- geometry helpers ----------
  function distKm(a, b) {
    const toR = Math.PI / 180, dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const rnd = a => a[Math.floor(Math.random() * a.length)];

  // ---------- quiz state ----------
  let deck = null, queue = [], current = null, answered = false, advanceTimer = null;

  function refillQueue() {
    const last = current;
    queue = shuffle(deck.items.slice());
    if (last && queue[0] === last && queue.length > 1) queue.push(queue.shift());
  }
  function nextItem() {
    if (!queue.length) refillQueue();
    return queue.shift();
  }
  function requeueMissed(item) {
    const at = Math.min(queue.length, 3 + Math.floor(Math.random() * 4));
    queue.splice(at, 0, item);
  }
  function distractors(item, n) {
    const others = deck.items.filter(x => x !== item);
    const near = others.map(x => [distKm(item.c, x.c), x]).sort((a, b) => a[0] - b[0]).slice(0, 7).map(x => x[1]);
    const pick = new Set();
    const nearCount = Math.min(n - 1, 2);
    while (pick.size < nearCount && near.length) { const x = rnd(near); pick.add(x); near.splice(near.indexOf(x), 1); }
    while (pick.size < n) pick.add(rnd(others));
    return [...pick];
  }

  function renderStreak(bumped) {
    const s = stats();
    els.streak.textContent = `🔥 ${s.streak}`;
    els.best.textContent = `🏆 ${s.best}`;
    if (bumped) { els.streak.classList.remove("bump"); void els.streak.offsetWidth; els.streak.classList.add("bump"); }
  }
  function renderMenuStats() {
    const s = stats();
    els.menuStats.textContent = s.seen ? `This deck and mode: best streak ${s.best}, ${s.right}/${s.seen} correct (${Math.round(100 * s.right / s.seen)}%).` : "";
  }

  function showItem(item) {
    current = item; answered = false;
    clearTimeout(advanceTimer);
    const noun = deck.noun;
    els.question.textContent = `Which ${noun} is this?`;
    els.svg.setAttribute("viewBox", `0 0 ${item.w} ${item.h}`);
    els.shape.setAttribute("d", item.d);
    els.map.classList.remove("pop"); void els.map.offsetWidth; els.map.classList.add("pop");
    els.feedback.textContent = ""; els.feedback.className = "feedback";
    els.next.hidden = true;
    if (prefs.mode === "easy") {
      els.form.hidden = true; els.options.hidden = false;
      els.options.innerHTML = "";
      const choices = shuffle([item, ...distractors(item, 3)]);
      choices.forEach((c, i) => {
        const b = document.createElement("button");
        b.textContent = c.name; b.dataset.i = i; b.dataset.id = c.id;
        b.addEventListener("click", () => pickOption(c, b));
        els.options.appendChild(b);
      });
    } else {
      els.options.hidden = true; els.form.hidden = false;
      els.guess.value = ""; els.guess.disabled = false; els.guess.className = "";
      els.guess.focus({ preventScroll: true });
    }
  }

  function record(correct) {
    const s = stats();
    s.seen++;
    if (correct) { s.streak++; s.right++; if (s.streak > s.best) s.best = s.streak; }
    else { s.streak = 0; requeueMissed(current); }
    saveStats(s);
    renderStreak(correct);
  }

  function pickOption(choice, btn) {
    if (answered) return;
    answered = true;
    const correct = choice === current;
    for (const b of els.options.querySelectorAll("button")) {
      b.disabled = true;
      if (b.dataset.id === current.id) b.classList.add("good");
      else if (b === btn) b.classList.add("bad");
    }
    record(correct);
    finish(correct, null);
  }

  function checkTyped(e) {
    e.preventDefault();
    if (answered) return;
    const guess = els.guess.value.trim();
    if (!guess) return;
    answered = true;
    const correct = matches(guess, current, deck.items);
    els.guess.disabled = true;
    els.guess.classList.add(correct ? "good" : "bad");
    record(correct);
    finish(correct, guess);
  }
  function skipTyped() {
    if (answered) return;
    answered = true;
    els.guess.disabled = true; els.guess.classList.add("bad");
    record(false);
    finish(false, null, true);
  }

  function finish(correct, guess, skipped) {
    if (correct) {
      els.feedback.className = "feedback good";
      els.feedback.innerHTML = `${rnd(["Correct!", "Yes!", "Nice.", "Got it.", "Right!"])} <small>${escapeHtml(current.name)}</small>`;
      advanceTimer = setTimeout(advance, 800);
    } else {
      els.feedback.className = "feedback bad";
      els.feedback.innerHTML = `${skipped ? "Skipped." : "Wrong."} It’s ${escapeHtml(current.name)}.` +
        (guess ? `<small>You typed “${escapeHtml(guess)}”</small>` : "");
      els.next.hidden = false;
      els.next.focus({ preventScroll: true });
    }
  }
  function advance() { clearTimeout(advanceTimer); showItem(nextItem()); }
  const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- screens ----------
  function syncMenu() {
    for (const b of els.decks.querySelectorAll("button")) b.classList.toggle("on", b.dataset.deck === prefs.deck);
    for (const b of els.modes.querySelectorAll("button")) b.classList.toggle("on", b.dataset.mode === prefs.mode);
    renderStreak(false); renderMenuStats();
  }
  function showMenu() {
    clearTimeout(advanceTimer);
    els.quiz.hidden = true; els.menu.hidden = false;
    syncMenu();
    history.replaceState(null, "", location.pathname);
  }
  async function startQuiz() {
    els.start.disabled = true; els.start.textContent = "Loading…";
    try {
      deck = await loadDeck(prefs.deck);
    } catch (err) {
      els.start.textContent = "Couldn’t load. Tap to retry"; els.start.disabled = false; return;
    }
    els.start.disabled = false; els.start.textContent = "Start";
    refillQueue();
    els.menu.hidden = true; els.quiz.hidden = false;
    renderStreak(false);
    showItem(nextItem());
    history.replaceState(null, "", `#${prefs.deck}/${prefs.mode}`);
  }

  els.decks.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; prefs.deck = b.dataset.deck; store.set("prefs", prefs); syncMenu(); });
  els.modes.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; prefs.mode = b.dataset.mode; store.set("prefs", prefs); syncMenu(); });
  els.start.addEventListener("click", startQuiz);
  els.home.addEventListener("click", showMenu);
  els.form.addEventListener("submit", checkTyped);
  els.skip.addEventListener("click", skipTyped);
  els.next.addEventListener("click", advance);
  document.addEventListener("keydown", e => {
    if (els.quiz.hidden) return;
    if (e.key === "Enter" && answered && !els.next.hidden) { e.preventDefault(); advance(); return; }
    if (prefs.mode === "easy" && !answered && /^[1-4]$/.test(e.key)) {
      const b = els.options.querySelector(`button[data-i="${+e.key - 1}"]`); if (b) b.click();
    }
    if (e.key === "Escape") showMenu();
  });

  // Deep link: #countries/hard
  const m = location.hash.match(/^#(us-states|countries)\/(easy|hard)$/);
  if (m) { prefs.deck = m[1]; prefs.mode = m[2]; store.set("prefs", prefs); }
  syncMenu();
  if (m) startQuiz();
  // Warm the other deck in the background.
  setTimeout(() => loadDeck(prefs.deck === "countries" ? "us-states" : "countries").catch(() => {}), 2500);
})();
