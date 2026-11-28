// Ricochet Tanks: the rules, maze and physics. No DOM, no networking, so it runs the same
// on the host, in one-keyboard mode, and in tests. The guest never runs step(): it only
// draws what the host sends.

export const CELL = 60;              // world units per maze cell
export const WALL = 4;               // wall thickness
export const TANK_R = 13;            // tank collision radius
export const TANK_LEN = 26, TANK_WID = 20;
export const BARREL = 17;            // tank centre to muzzle
export const TANK_SPEED = 100;       // units per second
export const REVERSE = 0.7;          // reversing is slower
export const TANK_TURN = 3.4;        // radians per second
export const BULLET_R = 2.6;
export const BULLET_SPEED = 165;
export const BULLET_LIFE = 9;        // seconds
export const MAX_BULLETS = 5;        // per tank, in the air at once
export const MAX_PENDING_FIRE = 3;   // queued shots per tank
export const READY_S = 1.0;          // frozen "Round N" banner at the start of a round
export const END_S = 2.6;            // time between the first hit and the next round
export const STEP = 1 / 120;         // fixed simulation step, seconds
export const MAZE_SIZES = [[7, 5], [8, 5], [8, 6], [9, 6], [10, 6], [10, 7]];
export const PHASE = { READY: 0, PLAY: 1, END: 2 };

const rand = (n) => Math.floor(Math.random() * n);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createGame() {
    return {
        round: 0,
        maze: null,                  // { cols, rows, h, v }: h[r][c] wall above cell, v[r][c] wall left of cell
        walls: [],                   // axis-aligned rectangles built from the maze
        tanks: [],                   // { x, y, a, alive }; index 0 copper (host), 1 blue (guest)
        bullets: [],                 // { id, owner, x, y, vx, vy, age, armed }
        nextBulletId: 1,
        pendingFire: [0, 0],         // shots waiting for the next step, per tank
        scores: [0, 0],
        lastResult: null,            // null (no round yet), -1 draw, or the winning tank index
        phase: PHASE.READY,
        phaseTime: 0,
    };
}

// ————— Maze —————
// Depth-first "recursive backtracker" walk, which joins every cell with exactly one route,
// then a quarter of the remaining inner walls knocked out to make loops.
export function makeMaze(cols, rows) {
    const h = Array.from({ length: rows + 1 }, () => Array(cols).fill(1));
    const v = Array.from({ length: rows }, () => Array(cols + 1).fill(1));
    const seen = Array.from({ length: rows }, () => Array(cols).fill(false));
    const start = [rand(cols), rand(rows)];
    seen[start[1]][start[0]] = true;
    const stack = [start];
    while (stack.length) {
        const [c, r] = stack[stack.length - 1];
        const options = [];
        if (r > 0 && !seen[r - 1][c]) options.push([c, r - 1, () => { h[r][c] = 0; }]);
        if (r < rows - 1 && !seen[r + 1][c]) options.push([c, r + 1, () => { h[r + 1][c] = 0; }]);
        if (c > 0 && !seen[r][c - 1]) options.push([c - 1, r, () => { v[r][c] = 0; }]);
        if (c < cols - 1 && !seen[r][c + 1]) options.push([c + 1, r, () => { v[r][c + 1] = 0; }]);
        if (!options.length) { stack.pop(); continue; }
        const [nc, nr, knockDown] = options[rand(options.length)];
        knockDown();
        seen[nr][nc] = true;
        stack.push([nc, nr]);
    }
    // Inner walls still standing (the border is never touched).
    const inner = [];
    for (let r = 1; r < rows; r++) for (let c = 0; c < cols; c++) if (h[r][c]) inner.push(() => { h[r][c] = 0; });
    for (let r = 0; r < rows; r++) for (let c = 1; c < cols; c++) if (v[r][c]) inner.push(() => { v[r][c] = 0; });
    for (let n = Math.round(inner.length * 0.25); n > 0; n--) inner.splice(rand(inner.length), 1)[0]();
    return { cols, rows, h, v };
}

// Runs of wall segments along one grid line become one rectangle each. Rectangles overhang
// the cell edge by half a wall, so corners are closed and neighbours overlap.
export function buildWalls({ cols, rows, h, v }) {
    const rects = [];
    const half = WALL / 2;
    for (let r = 0; r <= rows; r++) {
        for (let c = 0; c < cols;) {
            if (!h[r][c]) { c++; continue; }
            const from = c;
            while (c < cols && h[r][c]) c++;
            rects.push({ x: from * CELL - half, y: r * CELL - half, w: (c - from) * CELL + WALL, h: WALL });
        }
    }
    for (let c = 0; c <= cols; c++) {
        for (let r = 0; r < rows;) {
            if (!v[r][c]) { r++; continue; }
            const from = r;
            while (r < rows && v[r][c]) r++;
            rects.push({ x: c * CELL - half, y: from * CELL - half, w: WALL, h: (r - from) * CELL + WALL });
        }
    }
    return rects;
}

// Two cells well apart, each tank facing an open side of its cell.
export function spawnTanks({ cols, rows, h, v }) {
    const minDistance = Math.max(3, Math.floor((cols + rows) / 2));
    let a, b, tries = 0;
    do {
        a = [rand(cols), rand(rows)];
        b = [rand(cols), rand(rows)];
    } while (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < minDistance && ++tries < 500);
    return [a, b].map(([c, r]) => {
        const open = [];
        if (!v[r][c + 1]) open.push(0);
        if (!h[r + 1][c]) open.push(Math.PI / 2);
        if (!v[r][c]) open.push(Math.PI);
        if (!h[r][c]) open.push(-Math.PI / 2);
        return { x: (c + 0.5) * CELL, y: (r + 0.5) * CELL, a: open[rand(open.length)] ?? 0, alive: true };
    });
}

export function newRound(game) {
    const [cols, rows] = MAZE_SIZES[rand(MAZE_SIZES.length)];
    game.maze = makeMaze(cols, rows);
    game.walls = buildWalls(game.maze);
    game.tanks = spawnTanks(game.maze);
    game.bullets = [];
    game.pendingFire = [0, 0];
    game.round++;
    game.phase = PHASE.READY;
    game.phaseTime = 0;
}

export function newMatch(game) {
    game.scores = [0, 0];
    game.lastResult = null;
    game.round = 0;
    newRound(game);
}

export function queueFire(game, index) {
    game.pendingFire[index] = Math.min(MAX_PENDING_FIRE, game.pendingFire[index] + 1);
}

// ————— Physics —————
// Push a circle out of every wall it overlaps (a few passes settle corners).
function pushOutOfWalls(walls, t) {
    for (let pass = 0; pass < 3; pass++) {
        for (const w of walls) {
            const cx = clamp(t.x, w.x, w.x + w.w), cy = clamp(t.y, w.y, w.y + w.h);
            const dx = t.x - cx, dy = t.y - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 >= TANK_R * TANK_R) continue;
            if (d2 > 1e-9) {
                const d = Math.sqrt(d2);
                t.x += dx / d * (TANK_R - d);
                t.y += dy / d * (TANK_R - d);
            } else {
                // Centre inside the wall: leave by the shortest way out.
                const exits = [[t.x - w.x + TANK_R, -1, 0], [w.x + w.w - t.x + TANK_R, 1, 0], [t.y - w.y + TANK_R, 0, -1], [w.y + w.h - t.y + TANK_R, 0, 1]];
                const [dist, ex, ey] = exits.sort((p, q) => p[0] - q[0])[0];
                t.x += ex * dist;
                t.y += ey * dist;
            }
        }
    }
}

// Earliest wall a moving point (the shell's centre) would hit within displacement (dx, dy),
// against walls grown by the shell's radius. A slab test per rectangle; returns the fraction
// of the move travelled and the face normal, or null.
function sweep(walls, px, py, dx, dy) {
    let best = null;
    for (const w of walls) {
        const minX = w.x - BULLET_R, maxX = w.x + w.w + BULLET_R;
        const minY = w.y - BULLET_R, maxY = w.y + w.h + BULLET_R;
        if (px > minX && px < maxX && py > minY && py < maxY) continue; // already inside: let it out
        let enterX, exitX, enterY, exitY;
        if (dx === 0) {
            if (px <= minX || px >= maxX) continue;
            enterX = -Infinity; exitX = Infinity;
        } else {
            const t1 = (minX - px) / dx, t2 = (maxX - px) / dx;
            enterX = Math.min(t1, t2); exitX = Math.max(t1, t2);
        }
        if (dy === 0) {
            if (py <= minY || py >= maxY) continue;
            enterY = -Infinity; exitY = Infinity;
        } else {
            const t1 = (minY - py) / dy, t2 = (maxY - py) / dy;
            enterY = Math.min(t1, t2); exitY = Math.max(t1, t2);
        }
        const enter = Math.max(enterX, enterY), exit = Math.min(exitX, exitY);
        if (enter > exit || enter < 0 || enter > 1) continue;
        if (!best || enter < best.t) {
            best = enterX > enterY ? { t: enter, nx: -Math.sign(dx), ny: 0 } : { t: enter, nx: 0, ny: -Math.sign(dy) };
        }
    }
    return best;
}

// Move a shell for dt seconds, reflecting off each wall it meets along the way, so a fast
// shell can never tunnel through a wall or a corner.
function moveBullet(walls, b, dt) {
    let dx = b.vx * dt, dy = b.vy * dt;
    for (let bounce = 0; bounce < 6; bounce++) {
        const hit = sweep(walls, b.x, b.y, dx, dy);
        if (!hit) { b.x += dx; b.y += dy; return; }
        const rest = 1 - hit.t;
        b.x += dx * hit.t + hit.nx * 1e-3;
        b.y += dy * hit.t + hit.ny * 1e-3;
        if (hit.nx) { b.vx = -b.vx; dx = -dx * rest; dy *= rest; }
        else { b.vy = -b.vy; dy = -dy * rest; dx *= rest; }
    }
}

function fire(game, index, events) {
    const t = game.tanks[index];
    if (!t.alive || game.bullets.filter(b => b.owner === index).length >= MAX_BULLETS) return;
    const b = {
        id: game.nextBulletId++, owner: index, x: t.x, y: t.y,
        vx: Math.cos(t.a) * BULLET_SPEED, vy: Math.sin(t.a) * BULLET_SPEED, age: 0, armed: false,
    };
    // Trace from the tank's centre to the muzzle, so a barrel through a wall bounces instead.
    moveBullet(game.walls, b, BARREL / BULLET_SPEED);
    game.bullets.push(b);
    events.fired?.(index);
}

/**
 * One fixed step of the rules.
 *   inputs: [{ up, down, left, right }, …] per tank
 *   events: optional callbacks fired(index), destroyed(index, x, y), roundStarted()
 */
export function step(game, dt, inputs, events = {}) {
    game.phaseTime += dt;
    if (game.phase === PHASE.READY && game.phaseTime >= READY_S) { game.phase = PHASE.PLAY; game.phaseTime = 0; }
    const canDrive = game.phase !== PHASE.READY;
    game.tanks.forEach((t, i) => {
        if (!canDrive) { game.pendingFire[i] = 0; return; }
        if (!t.alive) return;
        const input = inputs[i];
        const turn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        const drive = (input.up ? 1 : 0) - (input.down ? REVERSE : 0);
        const a = t.a + turn * TANK_TURN * dt;
        t.a = Math.atan2(Math.sin(a), Math.cos(a));
        t.x += Math.cos(t.a) * drive * TANK_SPEED * dt;
        t.y += Math.sin(t.a) * drive * TANK_SPEED * dt;
        pushOutOfWalls(game.walls, t);
        if (game.pendingFire[i] > 0) { game.pendingFire[i]--; fire(game, i, events); }
    });
    // Tanks shove each other apart.
    const [p, q] = game.tanks;
    if (p.alive && q.alive) {
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
        if (d < 2 * TANK_R && d > 1e-6) {
            const push = (2 * TANK_R - d) / 2;
            p.x -= dx / d * push; p.y -= dy / d * push;
            q.x += dx / d * push; q.y += dy / d * push;
            pushOutOfWalls(game.walls, p);
            pushOutOfWalls(game.walls, q);
        }
    }
    // Shells keep flying through the end of a round.
    for (const b of game.bullets) {
        moveBullet(game.walls, b, dt);
        b.age += dt;
        const owner = game.tanks[b.owner];
        // A shell can't hit its own tank until it has cleared it (or bounced around a while).
        if (!b.armed && (b.age > 0.25 || Math.hypot(b.x - owner.x, b.y - owner.y) > TANK_R + BULLET_R + 1)) b.armed = true;
        game.tanks.forEach((t, i) => {
            if (!t.alive || b.age > BULLET_LIFE || (i === b.owner && !b.armed)) return;
            if (Math.hypot(b.x - t.x, b.y - t.y) < TANK_R + BULLET_R) {
                t.alive = false;
                b.age = Infinity;          // used up
                events.destroyed?.(i, t.x, t.y);
            }
        });
    }
    game.bullets = game.bullets.filter(b => b.age <= BULLET_LIFE);
    if (game.phase === PHASE.PLAY && game.tanks.some(t => !t.alive)) { game.phase = PHASE.END; game.phaseTime = 0; }
    if (game.phase === PHASE.END && game.phaseTime >= END_S) {
        // A point for the tank still standing; if both were hit, a draw.
        const standing = game.tanks.map((t, i) => (t.alive ? i : -1)).filter(i => i >= 0);
        if (standing.length === 1) game.scores[standing[0]]++;
        game.lastResult = standing.length === 1 ? standing[0] : -1;
        newRound(game);
        events.roundStarted?.();
    }
}
