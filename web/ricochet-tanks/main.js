// Ricochet Tanks: the page. Screens, keyboard, sound, the two-laptop link and the main loop.
//   sim.js     rules, maze and physics (no DOM)
//   net.js     the two-laptop message format and validation
//   render.js  canvas drawing and effects
// Pairing comes from the shared library: see web/lib/qr-pair.md.

import { mountPairing } from '../lib/qr-pair.js';
import { createGame, newMatch, step, queueFire, makeMaze, buildWalls, PHASE, STEP } from './sim.js';
import { APP, maskToInput, inputMessage, parseInput, roundMessage, parseRound, snapshotMessage, parseSnapshot, interpolate } from './net.js';
import { createRenderer } from './render.js';

const $ = (id) => document.getElementById(id);

const SNAPSHOT_MS = 15;          // host → guest positions, ~60 Hz
const INPUT_REPEAT_MS = 100;     // guest → host keys: on change, plus this heartbeat
const INTERP_MS = 35;            // the guest draws this far behind the host
const SILENT_MS = 1500;          // the other side counts as away after this long

// On the host and in one-keyboard mode this is the truth. A guest only uses maze, walls,
// round, scores and lastResult, all set by the host's 'round' message.
const game = createGame();
const renderer = createRenderer($('arena'));

let mode = null;                 // null | 'local' | 'host' | 'guest'
let pairing = null;              // the mountPairing component, while in two-laptop mode
let link = null;                 // the open PeerLink

// ————— Sound: tiny synthesised effects —————
const sound = {
    ctx: null,
    muted: false,
    unlock() {
        try {
            this.ctx ??= new AudioContext();
            if (this.ctx.state === 'suspended') this.ctx.resume();
        } catch { /* no audio: play silently */ }
    },
    ready() { return this.ctx && !this.muted && this.ctx.state === 'running'; },
    fire() {
        if (!this.ready()) return;
        const ctx = this.ctx, t = ctx.currentTime;
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(640, t);
        osc.frequency.exponentialRampToValueAtTime(180, t + 0.09);
        gain.gain.setValueAtTime(0.05, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.11);
    },
    boom() {
        if (!this.ready()) return;
        const ctx = this.ctx, t = ctx.currentTime, length = Math.floor(ctx.sampleRate * 0.6);
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
        const noise = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
        noise.buffer = buffer;
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, t);
        filter.frequency.exponentialRampToValueAtTime(120, t + 0.55);
        gain.gain.setValueAtTime(0.35, t);
        noise.connect(filter).connect(gain).connect(ctx.destination);
        noise.start(t);
    },
};

const explode = (index, x, y) => { renderer.explode(index, x, y); sound.boom(); };

// What the simulation tells the page about.
const simEvents = {
    fired: () => sound.fire(),
    destroyed: explode,
    roundStarted: () => afterNewRound(),
};

function afterNewRound() {
    renderer.clearEffects();
    updateScoreboard();
    if (mode === 'host' && link?.isOpen) link.send(roundMessage(game));
}

function startNewMatch() {
    newMatch(game);
    afterNewRound();
}

// ————— Keyboard —————
const LOCAL_KEYS = [
    { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: 'KeyQ' },
    { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: 'KeyM' },
];
const NET_FIRE_KEYS = new Set(['Space', 'KeyQ', 'KeyM', 'Enter']);
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyM', 'Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const keys = new Set();

// In two-laptop mode either key set drives your own tank.
const myMask = () => {
    const any = (a, b) => keys.has(a) || keys.has(b);
    return (any('KeyW', 'ArrowUp') ? 1 : 0) | (any('KeyS', 'ArrowDown') ? 2 : 0)
        | (any('KeyA', 'ArrowLeft') ? 4 : 0) | (any('KeyD', 'ArrowRight') ? 8 : 0);
};
const localInput = (map) => ({ up: keys.has(map.up), down: keys.has(map.down), left: keys.has(map.left), right: keys.has(map.right) });
const currentInputs = () => (mode === 'local'
    ? LOCAL_KEYS.map(localInput)
    : [maskToInput(myMask()), maskToInput(host.guestMask)]);

const gameActive = () => mode && !$('game').hidden;
window.addEventListener('keydown', (event) => {
    if (!gameActive() || event.metaKey || event.ctrlKey || event.altKey) return;
    if (GAME_KEYS.has(event.code)) event.preventDefault();
    sound.unlock();
    if (event.repeat) return;
    keys.add(event.code);
    if (mode === 'local') {
        LOCAL_KEYS.forEach((map, i) => { if (event.code === map.fire) queueFire(game, i); });
    } else if (NET_FIRE_KEYS.has(event.code)) {
        if (mode === 'host') queueFire(game, 0);
        else guest.fireCount++;
    }
});
window.addEventListener('keyup', (event) => {
    keys.delete(event.code);
    if (gameActive() && GAME_KEYS.has(event.code)) event.preventDefault();
});
window.addEventListener('blur', () => keys.clear());

// ————— Two-laptop link —————
const host = { lastInputSeq: 0, lastFire: 0, guestMask: 0, lastInputAt: 0, snapSeq: 0, lastSnapAt: 0 };
const guest = { inputSeq: 0, fireCount: 0, lastInputSent: 0, lastInputKey: '', snapshots: [], lastSnapSeq: 0, lastSnapAt: 0, newestBulletId: 0 };

function resetLinkState() {
    Object.assign(host, { lastInputSeq: 0, lastFire: 0, guestMask: 0, lastInputAt: performance.now(), snapSeq: 0, lastSnapAt: 0 });
    Object.assign(guest, { inputSeq: 0, fireCount: 0, lastInputSent: 0, lastInputKey: '', snapshots: [], lastSnapSeq: 0, lastSnapAt: performance.now(), newestBulletId: 0 });
}

// Host: the guest's keys. The fire count only ever grows; the host fires the difference.
function onHostMessage(msg) {
    const input = parseInput(msg);
    if (!input || input.n <= host.lastInputSeq) return;      // junk, stale or duplicate
    host.lastInputSeq = input.n;
    host.guestMask = input.k;
    host.lastInputAt = performance.now();
    for (; host.lastFire < input.f; host.lastFire++) queueFire(game, 1);
}

function onGuestMessage(msg) {
    if (msg.t === 'round') {
        const round = parseRound(msg);
        if (!round) return;
        Object.assign(game, round);
        game.walls = buildWalls(game.maze);
        guest.snapshots = [];
        guest.newestBulletId = 0;
        renderer.clearEffects();
        updateScoreboard();
    } else if (msg.t === 's') {
        const snap = parseSnapshot(msg, game.maze);
        // Snapshots from another round can overtake the reliable 'round' message: skip them.
        if (!snap || snap.n <= guest.lastSnapSeq || snap.r !== game.round) return;
        guest.lastSnapSeq = snap.n;
        guest.lastSnapAt = performance.now();
        // Effects the guest works out for itself: a tank that just died, a shell just fired.
        const previous = guest.snapshots[guest.snapshots.length - 1];
        snap.tk.forEach((t, i) => { if (previous?.tk[i][3] === 1 && t[3] === 0) explode(i, t[0], t[1]); });
        const newest = Math.max(0, ...snap.b.map(b => b[0]));
        if (newest > guest.newestBulletId) {
            if (previous) sound.fire();
            guest.newestBulletId = newest;
        }
        guest.snapshots.push(snap);
        if (guest.snapshots.length > 30) guest.snapshots.shift();
    }
}

function sendSnapshot(now, paused) {
    if (!link?.isOpen || now - host.lastSnapAt < SNAPSHOT_MS) return;
    host.lastSnapAt = now;
    link.sendFast(snapshotMessage(game, ++host.snapSeq, link.sharedNow(), paused));
}

function sendInput(now) {
    if (!link?.isOpen) return;
    const k = myMask();
    const key = `${k}:${guest.fireCount}`;
    if (key === guest.lastInputKey && now - guest.lastInputSent < INPUT_REPEAT_MS) return;
    link.sendFast(inputMessage(++guest.inputSeq, k, guest.fireCount));
    guest.lastInputKey = key;
    guest.lastInputSent = now;
}

function onConnected(newLink, { reconnected }) {
    // The link is ours now. Set every handler before returning so nothing is missed.
    link = newLink;
    mode = pairing.role === 'host' ? 'host' : 'guest';
    resetLinkState();
    link.onmessage = mode === 'host' ? onHostMessage : onGuestMessage;
    link.onstatechange = showConnectionState;
    if (mode === 'host') {
        // The same laptop as before: carry on with the match. Someone new: start afresh.
        if (!game.maze || !reconnected) startNewMatch();
        else link.send(roundMessage(game));
    } else {
        game.maze = null;
        game.walls = [];
    }
    showGame();
    showConnectionState('connected');
}

function showConnectionState(state, reason) {
    const closedLabels = { left: 'They disconnected', lost: 'Connection lost', mismatch: 'Different game version' };
    const labels = { connected: 'Connected', unstable: 'Lost contact, waiting…', closed: closedLabels[reason] ?? 'Disconnected' };
    $('conn-text').textContent = labels[state] ?? state;
    $('conn-status').className = `conn ${state}`;
    $('play-bar').className = `play-bar ${state}`;
    $('leave-btn').textContent = state === 'closed' ? 'Pair again' : 'Disconnect';
    if (state === 'closed') keys.clear();
}

// ————— Screens —————
function showGame() {
    $('mode-pick').hidden = true;
    $('pairing-wrap').hidden = true;
    $('about').hidden = true;
    $('game').hidden = false;
    const network = mode === 'host' || mode === 'guest';
    $('conn-status').hidden = !network;
    $('leave-btn').hidden = !network;
    $('new-match-btn').hidden = mode === 'guest';
    const you = mode === 'host' ? 0 : 1;
    for (const i of [0, 1]) {
        const colour = i === 0 ? 'Copper' : 'Blue';
        $(`name-${i}`).textContent = network ? `${colour} (${i === you ? 'you' : 'them'})` : colour;
    }
    $('controls-hint').innerHTML = network
        ? `You drive the <strong>${you === 0 ? 'copper' : 'blue'}</strong> tank: <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or arrow keys to drive, <kbd>Space</kbd> to fire.`
        : 'Copper: <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> drive, <kbd>Q</kbd> fire. &nbsp; Blue: arrow keys drive, <kbd>M</kbd> fire.';
    updateScoreboard();
}

function showMenu() {
    if (link?.isOpen) link.close();
    link = null;
    pairing?.destroy();
    pairing = null;
    mode = null;
    keys.clear();
    game.maze = null;
    $('game').hidden = true;
    $('pairing-wrap').hidden = true;
    $('mode-pick').hidden = false;
    $('about').hidden = false;
}

function updateScoreboard() {
    $('score-0').textContent = game.scores[0];
    $('score-1').textContent = game.scores[1];
}

$('mode-local').addEventListener('click', () => {
    mode = 'local';
    sound.unlock();
    startNewMatch();
    showGame();
});
$('mode-net').addEventListener('click', () => {
    sound.unlock();
    $('mode-pick').hidden = true;
    $('about').hidden = true;
    $('pairing-wrap').hidden = false;
    pairing = mountPairing($('pairing-root'), { app: APP, onConnected });
});
$('pairing-back').addEventListener('click', showMenu);
$('menu-btn').addEventListener('click', showMenu);
// Buttons give up focus after a click, so Space (fire) can't press them again.
$('new-match-btn').addEventListener('click', (event) => { event.currentTarget.blur(); startNewMatch(); });
$('leave-btn').addEventListener('click', (event) => {
    event.currentTarget.blur();
    if (link?.isOpen) { link.close(); return; }
    // "Pair again": same role, no reload, and the host's match carries on.
    $('game').hidden = true;
    $('pairing-wrap').hidden = false;
    pairing.start();
});
$('sound-btn').addEventListener('click', (event) => {
    event.currentTarget.blur();
    sound.muted = !sound.muted;
    event.currentTarget.textContent = `Sound: ${sound.muted ? 'off' : 'on'}`;
});

// ————— Main loop —————
function resultText() {
    const r = game.lastResult;
    if (r === null) return mode === 'local' ? 'Copper: WASD + Q   ·   Blue: arrows + M' : 'Drive with WASD or arrows, fire with Space';
    if (r === -1) return 'Last round: a draw';
    if (mode === 'local') return `${r === 0 ? 'Copper' : 'Blue'} took the last round`;
    return r === (mode === 'host' ? 0 : 1) ? 'You took the last round' : 'They took the last round';
}

function chooseBanner(view, now) {
    const disconnected = { title: 'Disconnected', subtitle: 'Press Pair again to carry on' };
    if (mode === 'guest') {
        if (!link?.isOpen) return disconnected;
        if (!game.maze) return { title: 'Waiting for the maze…', subtitle: '' };
        if (now - guest.lastSnapAt > SILENT_MS) return { title: 'Waiting for the host…', subtitle: 'Their game pauses while their tab is hidden' };
    }
    if (view?.paused) return link?.isOpen ? { title: 'Paused', subtitle: 'Waiting for the other laptop' } : disconnected;
    if (view?.phase === PHASE.READY) return { title: `Round ${game.round}`, subtitle: resultText() };
    return null;
}

let lastFrame = performance.now(), accumulator = 0, lastView = null;
function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!gameActive()) return;
    let view = null;
    if (mode === 'local' || mode === 'host') {
        // The host pauses while the guest is silent (its tab hidden, or the link wobbling).
        const paused = mode === 'host' && (!link?.isOpen || link.state !== 'connected' || now - host.lastInputAt > SILENT_MS);
        if (!paused && game.maze) {
            accumulator += dt;
            const inputs = currentInputs();
            while (accumulator >= STEP) { step(game, STEP, inputs, simEvents); accumulator -= STEP; }
        } else {
            accumulator = 0;
        }
        if (mode === 'host') sendSnapshot(now, paused);
        if (game.maze) view = { tanks: game.tanks, bullets: game.bullets, phase: game.phase, paused };
    } else {
        sendInput(now);
        view = interpolate(guest.snapshots, link?.clockReady ? link.sharedNow() - INTERP_MS : Infinity);
    }
    renderer.draw(game.maze, game.walls, view, chooseBanner(view, now), dt);
    lastView = view;
}
requestAnimationFrame(frame);

// Read-only hooks for tests/ricochet_tanks_test.py (module variables aren't global).
window.ricochetTanks = {
    game,
    get mode() { return mode; },
    get link() { return link; },
    get view() { return lastView; },
    get snapshots() { return guest.snapshots; },
    makeMaze,
};
