(function () {
    "use strict";

    // ─── Constants ────────────────────────────────────────────────────────────

    const CLICK_THRESHOLD = 20; // max clicks/sec before anti-cheat kicks in
    const COMBO_RESET_DELAY = 1500; // ms before combo resets on inactivity
    const OBJECT_LIFETIME = 2000;

    const SETTINGS = {
        easy:   { duration: 60, spawnRate: 1200 },
        medium: { duration: 45, spawnRate: 800  },
        hard:   { duration: 30, spawnRate: 500  },
    };

    const TYPES = [
        { img: "assets/egg.png",        points:  1, weight: 55, type: "egg"    },
        { img: "assets/golden-egg.png", points:  5, weight: 10, type: "golden" },
        { img: "assets/poule.png",       points: -2, weight: 25, type: "malus"  },
        { img: "assets/clock.png",       points:  0, weight:  5, type: "time"   }, // +5s
        { img: "assets/shield.png",      points:  0, weight:  5, type: "shield" }, // absorb 1 malus
    ];

    // Precompute cumulative weights for O(n) weighted random
    const TOTAL_WEIGHT = TYPES.reduce((s, t) => s + t.weight, 0);

    // ─── State ────────────────────────────────────────────────────────────────

    let state = {};

    function resetState() {
        state = {
            score: 0,
            timeLeft: 0,
            difficulty: "",
            combo: 0,
            comboTimer: null,
            shieldActive: false,
            timerInterval: null,
            spawnInterval: null,
            activeTimeouts: new Set(),
            stats: { clicked: 0, missed: 0, maxCombo: 0 },
            // Anti-cheat
            clicksThisSecond: 0,
            clickResetInterval: null,
        };
    }

    // ─── DOM refs ─────────────────────────────────────────────────────────────

    const gameArea      = document.getElementById("game-area");
    const scoreDisplay  = document.getElementById("score");
    const timerDisplay  = document.getElementById("timer");
    const timerBar      = document.getElementById("timer-bar"); // new element expected in HTML
    const comboDisplay  = document.getElementById("combo");     // new element expected in HTML

    // ─── Audio ────────────────────────────────────────────────────────────────

    let audio = null;

    function getAudio() {
        if (!audio) audio = new AudioContext();
        if (audio.state === "suspended") audio.resume();
        return audio;
    }

    function playNote(freq, duration, type = "sine", vol = 0.12, delay = 0) {
        const ctx = getAudio();
        const t = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol, t);
        gain.gain.linearRampToValueAtTime(0, t + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + duration);
    }

    function playNoise(duration, vol = 0.15, delay = 0) {
        const ctx = getAudio();
        const t = ctx.currentTime + delay;
        const buf = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = 3000;
        gain.gain.setValueAtTime(vol, t);
        gain.gain.linearRampToValueAtTime(0, t + duration);
        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(t);
    }

    const sounds = {
        collect:  () => { playNoise(0.08, 0.18); playNote(800, 0.06, "sawtooth", 0.1); playNote(1200, 0.04, "sawtooth", 0.06, 0.02); },
        golden:   () => { playNoise(0.12, 0.2); playNote(600, 0.08, "sawtooth", 0.12); playNote(900, 0.06, "sawtooth", 0.1, 0.03); playNote(1400, 0.1, "sawtooth", 0.08, 0.06); playNote(200, 0.3, "triangle", 0.06, 0.1); },
        malus:    () => { playNote(150, 0.15, "sawtooth", 0.15); playNote(80, 0.4, "square", 0.12, 0.05); playNoise(0.1, 0.1, 0.02); },
        gameOver: () => { playNote(250, 0.3, "sawtooth", 0.12); playNote(180, 0.4, "sawtooth", 0.1, 0.2); playNote(100, 0.6, "square", 0.08, 0.5); playNoise(0.15, 0.08); },
        powerup:  () => { playNote(600, 0.1, "sine", 0.15); playNote(900, 0.08, "sine", 0.12, 0.08); playNote(1200, 0.12, "sine", 0.1, 0.15); },
        combo:    () => { playNote(1000, 0.05, "sine", 0.1); playNote(1400, 0.07, "sine", 0.1, 0.05); },
    };

    const music = new Audio("assets/heroic-age.mp3");
    music.loop = true;
    music.volume = 0.15;

    // ─── Screens ──────────────────────────────────────────────────────────────

    function showScreen(id) {
        document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
        document.getElementById(id).classList.add("active");
    }

    // ─── Anti-cheat ───────────────────────────────────────────────────────────

    function startAntiCheat() {
        state.clicksThisSecond = 0;
        state.clickResetInterval = setInterval(() => { state.clicksThisSecond = 0; }, 1000);
    }

    function registerClick() {
        state.clicksThisSecond++;
        if (state.clicksThisSecond > CLICK_THRESHOLD) {
            console.warn("Click rate exceeded — possible auto-clicker");
            endGame();
        }
    }

    // ─── Combo ────────────────────────────────────────────────────────────────

    function incrementCombo() {
        clearTimeout(state.comboTimer);
        state.combo++;
        if (state.combo > state.stats.maxCombo) state.stats.maxCombo = state.combo;
        if (state.combo >= 3) sounds.combo();
        updateComboDisplay();
        state.comboTimer = setTimeout(resetCombo, COMBO_RESET_DELAY);
    }

    function resetCombo() {
        state.combo = 0;
        updateComboDisplay();
    }

    function updateComboDisplay() {
        if (!comboDisplay) return;
        if (state.combo >= 2) {
            comboDisplay.textContent = `COMBO x${state.combo}`;
            comboDisplay.classList.add("active");
        } else {
            comboDisplay.textContent = "";
            comboDisplay.classList.remove("active");
        }
    }

    function getComboMultiplier() {
        if (state.combo < 3) return 1;
        if (state.combo < 6) return 2;
        return 3;
    }

    // ─── Timer UI ─────────────────────────────────────────────────────────────

    function updateTimerUI() {
        timerDisplay.textContent = state.timeLeft;
        if (!timerBar) return;
        const pct = (state.timeLeft / SETTINGS[state.difficulty].duration) * 100;
        timerBar.style.width = pct + "%";
        timerBar.className = "timer-bar" + (state.timeLeft <= 10 ? " danger" : "");
    }

    // ─── Score ────────────────────────────────────────────────────────────────

    function addScore(raw) {
        const multiplier = raw > 0 ? getComboMultiplier() : 1;
        const delta = raw * multiplier;
        state.score = Math.max(0, state.score + delta);
        scoreDisplay.textContent = state.score;
        if (raw > 0 && multiplier > 1) scoreDisplay.classList.add("shake-up");
        else if (raw < 0) scoreDisplay.classList.add("shake");
        scoreDisplay.addEventListener("animationend", () => {
            scoreDisplay.classList.remove("shake", "shake-up");
        }, { once: true });
        return delta;
    }

    // ─── Particles & FX ──────────────────────────────────────────────────────

    function spawnParticles(cx, cy, points) {
        const count = points === 5 ? 20 : points < 0 ? 8 : 12;
        const color = points === 5 ? "#ffd700" : points < 0 ? "#ff3333" : "#d4943a";
        for (let i = 0; i < count; i++) {
            const p = document.createElement("div");
            p.className = "particle";
            p.style.cssText = `left:${cx}px;top:${cy}px;background:${color}`;
            const angle = (Math.PI * 2 * i) / count;
            const dist = 60 + Math.random() * 100;
            p.style.setProperty("--dx", Math.cos(angle) * dist + "px");
            p.style.setProperty("--dy", Math.sin(angle) * dist + "px");
            if (points === 5) p.style.boxShadow = `0 0 8px ${color}`;
            gameArea.appendChild(p); // fix: gameArea not body
            p.addEventListener("animationend", () => p.remove(), { once: true });
        }
    }

    function showFloatingScore(cx, cy, delta, multiplier) {
        const txt = document.createElement("div");
        txt.className = "floating-score";
        const sign = delta > 0 ? "+" : "";
        txt.textContent = multiplier > 1 ? `${sign}${delta} (x${multiplier})` : `${sign}${delta}`;
        if (delta >= 5)  txt.classList.add("golden");
        if (delta < 0)   txt.classList.add("negative");
        txt.style.cssText = `left:${cx}px;top:${cy}px`;
        gameArea.appendChild(txt);
        txt.addEventListener("animationend", () => txt.remove(), { once: true });
    }

    function flashRed() {
        const overlay = document.createElement("div");
        overlay.className = "red-flash";
        gameArea.appendChild(overlay);
        overlay.addEventListener("animationend", () => overlay.remove(), { once: true });
    }

    function showPowerupBanner(text) {
        const banner = document.createElement("div");
        banner.className = "powerup-banner";
        banner.textContent = text;
        gameArea.appendChild(banner);
        banner.addEventListener("animationend", () => banner.remove(), { once: true });
    }

    // ─── Weighted random ─────────────────────────────────────────────────────

    function pickType() {
        let r = Math.random() * TOTAL_WEIGHT;
        for (const t of TYPES) {
            r -= t.weight;
            if (r <= 0) return t;
        }
        return TYPES[0];
    }

    // ─── Spawn ────────────────────────────────────────────────────────────────

    function spawnObject() {
        const type = pickType();
        const el = document.createElement("img");
        el.classList.add("game-object");
        el.src = type.img;
        el.style.top  = Math.random() * 60 + 10 + "%";
        el.style.left = Math.random() * 60 + 15 + "%";

        el.addEventListener("click", (e) => {
            e.stopPropagation();
            registerClick();
            handleObjectClick(el, type);
        });

        gameArea.appendChild(el);

        const id = setTimeout(() => {
            state.activeTimeouts.delete(id);
            if (!el.parentNode) return;
            el.remove();
            if (type.points > 0 || type.type === "time" || type.type === "shield") {
                state.stats.missed++;
                endGame();
            }
        }, OBJECT_LIFETIME);

        state.activeTimeouts.add(id);
    }

    function handleObjectClick(el, type) {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        el.remove();

        switch (type.type) {
            case "egg":
            case "golden": {
                const mult = getComboMultiplier();
                const delta = addScore(type.points);
                incrementCombo();
                spawnParticles(cx, cy, type.points);
                showFloatingScore(cx, cy, delta, mult);
                type.type === "golden" ? sounds.golden() : sounds.collect();
                state.stats.clicked++;
                break;
            }
            case "malus": {
                if (state.shieldActive) {
                    state.shieldActive = false;
                    showPowerupBanner("🛡️ Shield absorbé !");
                    sounds.powerup();
                } else {
                    const delta = addScore(type.points);
                    resetCombo();
                    spawnParticles(cx, cy, type.points);
                    showFloatingScore(cx, cy, delta, 1);
                    flashRed();
                    sounds.malus();
                }
                state.stats.clicked++;
                break;
            }
            case "time": {
                state.timeLeft += 5;
                updateTimerUI();
                showPowerupBanner("⏱️ +5 secondes !");
                sounds.powerup();
                state.stats.clicked++;
                break;
            }
            case "shield": {
                state.shieldActive = true;
                showPowerupBanner("🛡️ Shield actif !");
                sounds.powerup();
                state.stats.clicked++;
                break;
            }
        }
    }

    // ─── Game lifecycle ──────────────────────────────────────────────────────

    function startGame(key) {
        resetState();
        state.difficulty = key;
        state.timeLeft   = SETTINGS[key].duration;

        scoreDisplay.textContent = state.score;
        updateTimerUI();
        resetCombo();
        gameArea.innerHTML = "";
        showScreen("screen-game");

        state.timerInterval = setInterval(() => {
            state.timeLeft--;
            updateTimerUI();
            if (state.timeLeft <= 0) endGame();
        }, 1000);

        state.spawnInterval = setInterval(spawnObject, SETTINGS[key].spawnRate);
        gameArea.addEventListener("click", onMissClick);
        startAntiCheat();

        music.currentTime = 3;
        music.play();
    }

    function onMissClick(e) {
        if (e.target === gameArea) {
            state.stats.missed++;
            endGame();
        }
    }

    function endGame() {
        // Guard: prevent double call
        if (!state.timerInterval && !state.spawnInterval) return;

        clearInterval(state.timerInterval);
        clearInterval(state.spawnInterval);
        clearInterval(state.clickResetInterval);
        clearTimeout(state.comboTimer);
        state.timerInterval = null;
        state.spawnInterval = null;

        // Cleanup all pending timeouts
        state.activeTimeouts.forEach(clearTimeout);
        state.activeTimeouts.clear();

        gameArea.removeEventListener("click", onMissClick);
        gameArea.innerHTML = "";

        // Scores
        document.getElementById("final-score").textContent = state.score;

        const bestKey = "best_" + state.difficulty;
        const prev    = parseInt(localStorage.getItem(bestKey)) || 0;
        const isNew   = state.score > prev;
        document.getElementById("new-record").style.display = isNew ? "block" : "none";
        if (isNew) localStorage.setItem(bestKey, state.score);

        // Stats
        const statsEl = document.getElementById("end-stats");
        if (statsEl) {
            statsEl.innerHTML = `
                Cliqués : <b>${state.stats.clicked}</b> &nbsp;|&nbsp;
                Ratés : <b>${state.stats.missed}</b> &nbsp;|&nbsp;
                Meilleur combo : <b>x${state.stats.maxCombo}</b>
            `;
        }

        music.pause();
        sounds.gameOver();
        loadHighScores();
        showScreen("screen-gameover");
    }

    // ─── High scores ─────────────────────────────────────────────────────────

    function loadHighScores() {
        ["easy", "medium", "hard"].forEach(k => {
            const el = document.getElementById("high-" + k);
            if (el) el.textContent = localStorage.getItem("best_" + k) || 0;
        });
    }

    // ─── Event bindings ──────────────────────────────────────────────────────

    document.querySelectorAll(".menu-buttons button").forEach(btn => {
        btn.addEventListener("click", () => startGame(btn.dataset.difficulty));
    });

    document.getElementById("btn-replay").addEventListener("click", () => startGame(state.difficulty));
    document.getElementById("btn-menu").addEventListener("click", () => showScreen("screen-menu"));

    loadHighScores();

})();
