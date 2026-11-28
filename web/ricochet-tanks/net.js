// Ricochet Tanks: the two-laptop message format. The host runs the game; the guest sends its
// keys and draws what the host sends back. Pairing and the link itself come from
// web/lib/qr-pair.js (see web/lib/qr-pair.md).
//
//   host → guest, reliable:  { t: 'round', r, maze, scores, last }   each new round, and on every open
//   host → guest, fast:      { t: 's', n, r, at, ph, pt, pz, tk, b }  full snapshot, ~60 Hz
//   guest → host, fast:      { t: 'in', n, k, f }                    keys bitmask + fire-press count
//
// Fast messages are numbered (n) so late or duplicate ones are dropped, and always carry full
// state so a lost one is healed by the next. Everything incoming is validated here before use.

import { CELL, MAX_BULLETS } from './sim.js';

export const APP = 'ricochet-tanks@1';    // bump @n whenever these messages change

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const round2 = (v) => Math.round(v * 100) / 100;
const MAX_INT = Number.MAX_SAFE_INTEGER;

// ————— Keys —————
export const KEY_BITS = { up: 1, down: 2, left: 4, right: 8 };
export const maskToInput = (k) => ({ up: !!(k & 1), down: !!(k & 2), left: !!(k & 4), right: !!(k & 8) });

export const inputMessage = (n, k, f) => ({ t: 'in', n, k, f });

export function parseInput(msg) {
    if (msg.t !== 'in' || !Number.isInteger(msg.n) || !isInt(msg.k, 0, 15) || !isInt(msg.f, 0, MAX_INT)) return null;
    return { n: msg.n, k: msg.k, f: msg.f };
}

// ————— Rounds —————
export const roundMessage = (game) => ({ t: 'round', r: game.round, maze: game.maze, scores: game.scores, last: game.lastResult });

const isBitGrid = (g, rows, cols) => Array.isArray(g) && g.length === rows
    && g.every(row => Array.isArray(row) && row.length === cols && row.every(x => x === 0 || x === 1));
const isMaze = (m) => m && typeof m === 'object' && isInt(m.cols, 3, 16) && isInt(m.rows, 3, 12)
    && isBitGrid(m.h, m.rows + 1, m.cols) && isBitGrid(m.v, m.rows, m.cols + 1);

export function parseRound(msg) {
    if (msg.t !== 'round' || !isInt(msg.r, 1, MAX_INT) || !isMaze(msg.maze)) return null;
    if (!Array.isArray(msg.scores) || msg.scores.length !== 2 || !msg.scores.every(s => isInt(s, 0, 1e6))) return null;
    if (!(msg.last === null || isInt(msg.last, -1, 1))) return null;
    const { cols, rows, h, v } = msg.maze;
    return { round: msg.r, maze: { cols, rows, h, v }, scores: msg.scores.slice(), lastResult: msg.last };
}

// ————— Snapshots —————
export function snapshotMessage(game, n, at, paused) {
    return {
        t: 's', n, r: game.round, at,
        ph: game.phase, pt: round2(game.phaseTime), pz: paused ? 1 : 0,
        tk: game.tanks.map(t => [round2(t.x), round2(t.y), Math.round(t.a * 1000) / 1000, t.alive ? 1 : 0]),
        b: game.bullets.map(b => [b.id, round2(b.x), round2(b.y)]),
    };
}

// Returns the snapshot if it is well-formed and inside this maze, else null.
export function parseSnapshot(msg, maze) {
    if (msg.t !== 's' || !maze || !Number.isInteger(msg.n) || !Number.isInteger(msg.r)) return null;
    if (!Number.isFinite(msg.at) || !isInt(msg.ph, 0, 2) || !Number.isFinite(msg.pt) || !isInt(msg.pz, 0, 1)) return null;
    const inWorld = (x, y) => Number.isFinite(x) && Number.isFinite(y)
        && x > -CELL && y > -CELL && x < (maze.cols + 1) * CELL && y < (maze.rows + 1) * CELL;
    const isTank = (t) => Array.isArray(t) && t.length === 4 && inWorld(t[0], t[1]) && Number.isFinite(t[2]) && (t[3] === 0 || t[3] === 1);
    const isBullet = (b) => Array.isArray(b) && b.length === 3 && isInt(b[0], 1, MAX_INT) && inWorld(b[1], b[2]);
    if (!Array.isArray(msg.tk) || msg.tk.length !== 2 || !msg.tk.every(isTank)) return null;
    if (!Array.isArray(msg.b) || msg.b.length > 2 * MAX_BULLETS || !msg.b.every(isBullet)) return null;
    return { n: msg.n, r: msg.r, at: msg.at, ph: msg.ph, pt: msg.pt, pz: msg.pz, tk: msg.tk, b: msg.b };
}

// Guest: blend the two buffered snapshots either side of renderAt (on the shared clock).
// Shells are matched by id; a shell new in the later snapshot appears where it is.
export function interpolate(snapshots, renderAt) {
    if (!snapshots.length) return null;
    let a = snapshots[0], b = snapshots[1] ?? null;
    for (let i = snapshots.length - 1; i >= 0; i--) {
        if (snapshots[i].at <= renderAt) { a = snapshots[i]; b = snapshots[i + 1] ?? null; break; }
    }
    const f = b ? Math.min(1, Math.max(0, (renderAt - a.at) / Math.max(1e-6, b.at - a.at))) : 0;
    const to = b ?? a;
    const lerp = (p, q) => p + (q - p) * f;
    const lerpAngle = (p, q) => { const d = q - p; return p + Math.atan2(Math.sin(d), Math.cos(d)) * f; };
    const older = new Map(a.b.map(row => [row[0], row]));
    return {
        phase: to.ph, phaseTime: to.pt, paused: !!to.pz,
        tanks: to.tk.map((t, i) => ({ x: lerp(a.tk[i][0], t[0]), y: lerp(a.tk[i][1], t[1]), a: lerpAngle(a.tk[i][2], t[2]), alive: t[3] === 1 })),
        bullets: to.b.map(([id, x, y]) => {
            const old = older.get(id);
            return old ? { x: lerp(old[1], x), y: lerp(old[2], y) } : { x, y };
        }),
    };
}
