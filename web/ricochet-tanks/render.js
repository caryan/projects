// Ricochet Tanks: drawing the arena on a canvas, plus explosion debris. Colours come from the
// page's CSS tokens, so it follows light and dark mode.

import { CELL, TANK_R, TANK_LEN, TANK_WID, BARREL, BULLET_R } from './sim.js';

export function createRenderer(canvas) {
    const ctx = canvas.getContext('2d');
    let palette = {};
    let debris = [];                 // { x, y, vx, vy, life, max, size, colour } or { ring, x, y, life, max }

    const readPalette = () => {
        const css = getComputedStyle(document.documentElement);
        const get = (name) => css.getPropertyValue(name).trim();
        palette = {
            ink: get('--ink'), inkSoft: get('--ink-soft'), surface: get('--surface'), faint: get('--line-faint'),
            tanks: [get('--copper'), get('--guest')],
        };
    };
    readPalette();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readPalette);

    const fillRounded = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); };

    function drawTank(t, colour) {
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.rotate(t.a);
        ctx.fillStyle = palette.ink;                     // treads
        fillRounded(-TANK_LEN / 2, -TANK_WID / 2, TANK_LEN, 5, 2);
        fillRounded(-TANK_LEN / 2, TANK_WID / 2 - 5, TANK_LEN, 5, 2);
        ctx.fillStyle = colour;                          // hull
        fillRounded(-TANK_LEN / 2 + 2, -TANK_WID / 2 + 3, TANK_LEN - 4, TANK_WID - 6, 3);
        ctx.fillStyle = palette.ink;                     // barrel
        ctx.fillRect(0, -2, BARREL + 1, 4);
        ctx.beginPath();                                 // turret
        ctx.arc(0, 0, 6, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = palette.ink;
        ctx.stroke();
        ctx.restore();
    }

    function drawBanner({ title, subtitle }, w, h) {
        const scale = Math.max(0.7, Math.min(1.4, w / 900));
        const titleFont = `500 ${Math.round(30 * scale)}px "IBM Plex Mono", monospace`;
        const subFont = `${Math.round(15 * scale)}px "IBM Plex Mono", monospace`;
        ctx.save();
        ctx.font = titleFont;
        const titleWidth = ctx.measureText(title).width;
        ctx.font = subFont;
        const subWidth = subtitle ? ctx.measureText(subtitle).width : 0;
        const boxW = Math.max(titleWidth, subWidth) + 48 * scale, boxH = (subtitle ? 92 : 64) * scale;
        const x = (w - boxW) / 2, y = (h - boxH) / 2;
        ctx.fillStyle = palette.faint;                   // the site's offset shadow
        ctx.fillRect(x + 4, y + 4, boxW, boxH);
        ctx.fillStyle = palette.surface;
        ctx.fillRect(x, y, boxW, boxH);
        ctx.strokeStyle = palette.ink;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, boxW, boxH);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = palette.ink;
        ctx.font = titleFont;
        ctx.fillText(title, w / 2, y + (subtitle ? 34 : 32) * scale);
        if (subtitle) {
            ctx.fillStyle = palette.inkSoft;
            ctx.font = subFont;
            ctx.fillText(subtitle, w / 2, y + 66 * scale);
        }
        ctx.restore();
    }

    return {
        explode(index, x, y) {
            for (let i = 0; i < 28; i++) {
                const angle = Math.random() * Math.PI * 2, speed = 40 + Math.random() * 140, life = 0.5 + Math.random() * 0.8;
                debris.push({
                    x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life, max: life,
                    size: 2 + Math.random() * 4, colour: i % 3 ? palette.tanks[index] : palette.ink,
                });
            }
            debris.push({ ring: true, x, y, life: 0.45, max: 0.45 });
        },

        clearEffects() { debris = []; },

        // maze/walls: the round's maze; view: { tanks, bullets } or null; banner: { title, subtitle } or null
        draw(maze, walls, view, banner, dt) {
            for (const p of debris) {
                p.life -= dt;
                if (p.ring) continue;
                p.x += p.vx * dt; p.y += p.vy * dt;
                p.vx *= 1 - 3 * dt; p.vy *= 1 - 3 * dt;
            }
            debris = debris.filter(p => p.life > 0);

            // Keep the backing store matched to the on-screen size.
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            if (maze) {
                const worldW = maze.cols * CELL, worldH = maze.rows * CELL, margin = 16;
                const s = Math.min(w / (worldW + 2 * margin), h / (worldH + 2 * margin));
                ctx.save();
                ctx.translate((w - worldW * s) / 2, (h - worldH * s) / 2);
                ctx.scale(s, s);
                // Floor: a faint cell grid, like the paper behind it
                ctx.strokeStyle = palette.faint;
                ctx.lineWidth = 1 / s;
                ctx.beginPath();
                for (let c = 1; c < maze.cols; c++) { ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, worldH); }
                for (let r = 1; r < maze.rows; r++) { ctx.moveTo(0, r * CELL); ctx.lineTo(worldW, r * CELL); }
                ctx.stroke();
                // Walls, with the offset shadow
                ctx.fillStyle = palette.faint;
                for (const r of walls) ctx.fillRect(r.x + 2, r.y + 2, r.w, r.h);
                ctx.fillStyle = palette.ink;
                for (const r of walls) ctx.fillRect(r.x, r.y, r.w, r.h);
                if (view) {
                    view.tanks.forEach((t, i) => { if (t.alive) drawTank(t, palette.tanks[i]); });
                    ctx.fillStyle = palette.ink;
                    for (const b of view.bullets) {
                        ctx.beginPath();
                        ctx.arc(b.x, b.y, BULLET_R + 0.4, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
                for (const p of debris) {
                    const fade = p.life / p.max;
                    ctx.globalAlpha = fade;
                    if (p.ring) {
                        ctx.strokeStyle = palette.ink;
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, TANK_R + (1 - fade) * 34, 0, Math.PI * 2);
                        ctx.stroke();
                    } else {
                        ctx.fillStyle = p.colour;
                        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
                    }
                }
                ctx.globalAlpha = 1;
                ctx.restore();
            }
            if (banner) drawBanner(banner, w, h);
        },
    };
}
