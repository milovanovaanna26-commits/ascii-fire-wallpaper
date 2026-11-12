// Doom-style ASCII fire simulation. No GNOME imports: runs in Node and GJS.
//
// Timeline: an unlit candle; a match flame floats in and lights the wick;
// the candle burns, tips over, bursts on impact and the fire spreads into
// a full-width band that burns forever.

export const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';

// Fire: dark red -> white with a yellow tint.
export const PALETTE = [
    [0x5a, 0x0d, 0x08],
    [0x9a, 0x1a, 0x0c],
    [0xd0, 0x36, 0x10],
    [0xf2, 0x6a, 0x16],
    [0xff, 0x9c, 0x2e],
    [0xff, 0xd2, 0x6a],
    [0xff, 0xf6, 0xd8],
];

// Unlit candle wax, dark -> light.
export const WAX = [
    [0x3a, 0x37, 0x3e],
    [0x5c, 0x57, 0x5e],
    [0x8c, 0x84, 0x86],
];

// Every color collect() may return; bucket i is drawn with COLORS[i].
export const COLORS = [...PALETTE, ...WAX];
const W0 = PALETTE.length;

const SPARK_CHARS = ['.', '\'', '*', '+'];
const RIM_CHARS = '$@B8%&$$';
const WAVE_CHARS = '-=~_-';

export const DEFAULTS = {
    // Timeline, seconds.
    strikeTime: 0.5,          // dim candle alone, then the match strikes
    travelTime: 1.4,          // match flame floats to the wick
    burnTime: 4.5,            // candle burns, its flame grows
    fallTime: 0.7,            // candle tips over to the right
    spreadTime: 1.4,          // burst spreads into the full-width band
    // Geometry, fractions of cols/rows.
    baseRow: 0.97,            // floor row
    waxWidth: 0.085,
    waxHeight: 0.36,
    // Flame heights, fractions of rows.
    matchHeight: 0.06,
    candleHeightStart: 0.09,
    candleHeightEnd: 0.2,
    burstHeight: 0.62,
    fullHeight: 0.42,
    candleHalfWidth: 2.5,     // cols, half width of the wick flame
    edgeFalloff: 0.10,        // fraction of width where the band fades at screen edges
    minHeat: 0.05,            // below this a cell is empty
    sparkRate: 6,             // sparks per second in the band
    sparkLife: 1.6,           // s
    burstSparks: 70,
    cellAspect: 20 / 11,      // cell height / width, so the falling candle keeps its shape
};

function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

export class FireSim {
    constructor(cols, rows, opts = {}, rng = Math.random) {
        this.opts = {...DEFAULTS, ...opts};
        this.rng = rng;
        this.time = 0;
        this.sparks = [];
        this._sparkAcc = 0;
        this._flicker = 1;
        this._events = new Set();
        const o = this.opts;
        this.tStrike = o.strikeTime;
        this.tIgnite = this.tStrike + o.travelTime;
        this.tFall = this.tIgnite + o.burnTime;
        this.tImpact = this.tFall + o.fallTime;
        this.resize(cols, rows);
    }

    resize(cols, rows, aspect = this.opts.cellAspect) {
        const o = this.opts;
        this.opts.cellAspect = aspect;
        this.cols = Math.max(8, cols | 0);
        this.rows = Math.max(8, rows | 0);
        this.base = Math.min(this.rows - 1, Math.round(this.rows * o.baseRow));
        this.heat = new Float32Array(this.cols * (this.base + 1));
        // Slow noise along the floor makes uneven tongues.
        this._srcNoise = new Float32Array(this.cols).map(() => this.rng());
        this._floorPat = new Float32Array(this.cols).map(() => this.rng());
        this.sparks = [];
        this.cx = Math.round((this.cols - 1) / 2);
        this.waxHalf = Math.max(3, Math.round(this.cols * o.waxWidth / 2));
        this.waxW = this.waxHalf * 2 + 1;
        this.waxH = Math.max(6, Math.round(this.rows * o.waxHeight));
        // Fixed per-cell texture so the wax looks solid rather than noisy.
        this._waxTex = new Float32Array(this.waxW * this.waxH).map(() => this.rng() - 0.5);
        // Pivot: bottom-right corner of the candle, on the floor.
        this.pivotX = this.cx + this.waxHalf + 1;
        this.pivotY = this.base;
        // Where the fallen candle lies; the burst and band grow from here.
        const lenCols = this.waxH * aspect;
        this.impactX = Math.min(this.cols - 1, Math.round(this.pivotX + lenCols / 2));
        this.impactHalf = lenCols / 2;
        this._wax = [];
    }

    get phase() {
        const t = this.time;
        if (t < this.tStrike)
            return 'unlit';
        if (t < this.tIgnite)
            return 'match';
        if (t < this.tFall)
            return 'burn';
        if (t < this.tImpact)
            return 'fall';
        if (t < this.tImpact + this.opts.spreadTime)
            return 'burst';
        return 'band';
    }

    // Candle tilt, radians clockwise.
    get angle() {
        const p = Math.min(1, Math.max(0, (this.time - this.tFall) / this.opts.fallTime));
        // Accelerates like a falling body.
        return Math.PI / 2 * p * p;
    }

    // Candle-local point (cols from the left edge, rows from the top) -> grid cell.
    _toWorld(u, v, angle) {
        const a = this.opts.cellAspect;
        const X = u - this.waxW, Y = (v - this.waxH) * a;
        const c = Math.cos(angle), s = Math.sin(angle);
        return [this.pivotX + X * c - Y * s, this.pivotY + (X * s + Y * c) / a];
    }

    // Cells covered by the candle at its current angle, via inverse rotation (no holes).
    _computeWax() {
        const angle = this.angle;
        const a = this.opts.cellAspect;
        const c = Math.cos(angle), s = Math.sin(angle);
        const corners = [[0, 0], [this.waxW, 0], [0, this.waxH], [this.waxW, this.waxH]]
            .map(([u, v]) => this._toWorld(u, v, angle));
        const x0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p[0]))));
        const x1 = Math.min(this.cols - 1, Math.ceil(Math.max(...corners.map(p => p[0]))));
        const y0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p[1]))));
        const y1 = Math.min(this.base, Math.ceil(Math.max(...corners.map(p => p[1]))));
        const cells = [];
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const Xw = x + 0.5 - this.pivotX, Yw = (y + 0.5 - this.pivotY) * a;
                const u = Xw * c + Yw * s + this.waxW;
                const v = (-Xw * s + Yw * c) / a + this.waxH;
                if (u < 0 || u >= this.waxW || v < 0 || v >= this.waxH)
                    continue;
                const ui = Math.floor(u), vi = Math.floor(v);
                // Rounded shoulders.
                if (vi === 0 && (ui === 0 || ui === this.waxW - 1))
                    continue;
                cells.push([x, y, ui, vi]);
            }
        }
        this._wax = cells;
    }

    // Wick tip cell at the current angle.
    _wick() {
        const [x, y] = this._toWorld(this.waxHalf + 0.5, -0.5, this.angle);
        return [Math.round(x - 0.5), Math.round(y - 0.5)];
    }

    // Match flame position and visibility (alpha 0..1).
    _match() {
        const t = this.time;
        if (t < this.tStrike || t > this.tIgnite + 0.6)
            return null;
        const [wx, wy] = this._wick();
        const sx = Math.max(1, wx - this.waxHalf - 12), sy = wy + 4;
        let p, alpha;
        if (t < this.tIgnite) {
            p = smoothstep(this.tStrike, this.tIgnite, t);
            alpha = smoothstep(this.tStrike, this.tStrike + 0.25, t);
        } else {
            // Pulls back and goes out once the wick has caught.
            p = 1 - 0.4 * smoothstep(this.tIgnite, this.tIgnite + 0.6, t);
            alpha = 1 - smoothstep(this.tIgnite, this.tIgnite + 0.6, t);
        }
        const x = lerp(sx, wx - 2, p);
        const y = lerp(sy, wy, p) - Math.sin(Math.PI * p) * 3;
        return {x: Math.round(x), y: Math.round(y), alpha};
    }

    // How brightly the candle is lit by its own flame, 0..1.
    get _lit() {
        return smoothstep(this.tIgnite, this.tIgnite + 0.6, this.time) * this._flicker;
    }

    _flameHeight() {
        const o = this.opts, t = this.time;
        if (t < this.tIgnite)
            return o.matchHeight;
        if (t < this.tImpact)
            return lerp(o.candleHeightStart, o.candleHeightEnd, smoothstep(this.tIgnite, this.tFall, t));
        return lerp(o.burstHeight, o.fullHeight, smoothstep(this.tImpact, this.tImpact + o.spreadTime + 1, t));
    }

    _setHeat(x, y, h) {
        if (x >= 0 && x < this.cols && y >= 0 && y <= this.base) {
            const i = y * this.cols + x;
            this.heat[i] = Math.max(this.heat[i], h);
        }
    }

    _once(name) {
        if (this._events.has(name))
            return false;
        this._events.add(name);
        return true;
    }

    step(dt) {
        this.time += dt;
        const {cols, base, heat, rng, opts} = this;
        const t = this.time;
        this._flicker += ((0.8 + rng() * 0.2) - this._flicker) * 0.5;
        const meanDecay = 1 / Math.max(2, this.rows * this._flameHeight());

        if (t < this.tImpact)
            this._computeWax();
        else
            this._wax = [];

        // Match flame.
        const m = this._match();
        if (m) {
            if (this._once('strike'))
                this._burst(8, m.x, m.y, 5, 0.6);
            for (let dx = -1; dx <= 1; dx++)
                this._setHeat(m.x + dx, m.y, m.alpha * (dx === 0 ? 1 : 0.65) * (0.85 + 0.15 * rng()));
        }

        // Wick flame, following the candle as it falls.
        if (t >= this.tIgnite && t < this.tImpact) {
            const [wx, wy] = this._wick();
            if (this._once('ignite'))
                this._burst(12, wx, wy, 6, 0.8);
            const amp = smoothstep(this.tIgnite, this.tIgnite + 0.4, t);
            const hw = opts.candleHalfWidth;
            for (let dx = -Math.ceil(hw); dx <= Math.ceil(hw); dx++) {
                const h = 1 - smoothstep(hw - 1.5, hw + 0.5, Math.abs(dx));
                this._setHeat(wx + dx, wy, amp * h * (0.85 + 0.15 * rng()));
            }
        }

        // Impact: the candle bursts into a dome of fire.
        if (t >= this.tImpact) {
            const since = t - this.tImpact;
            if (this._once('impact'))
                this._burst(opts.burstSparks, this.impactX, base - 2, 18, this.impactHalf);
            if (since < 0.45) {
                const a = 1 - 0.5 * since / 0.45;
                const rx = this.impactHalf + 3, ry = this.waxH * 0.9;
                for (let y = Math.max(0, Math.round(base - ry)); y <= base; y++) {
                    for (let x = Math.max(0, Math.round(this.impactX - rx)); x <= Math.min(cols - 1, this.impactX + rx); x++) {
                        const dx = (x - this.impactX) / rx, dy = (base - y) / ry;
                        const r2 = dx * dx + dy * dy;
                        if (r2 < 1)
                            this._setHeat(x, y, a * (0.65 + 0.35 * (1 - r2)) * (0.8 + 0.2 * rng()));
                    }
                }
            }
            this._floorSource(since);
        }

        // Propagate up: each cell copies from below, cooled and shifted sideways.
        for (let y = 1; y <= base; y++) {
            const row = y * cols;
            const up = row - cols;
            for (let x = 0; x < cols; x++) {
                const v = heat[row + x];
                if (v <= 0)
                    continue;
                const shift = (rng() * 3) | 0;
                let dx = x - shift + 1;
                if (dx < 0 || dx >= cols)
                    dx = x;
                const decay = rng() < 0.4 ? 0 : rng() * 2.6 * meanDecay;
                heat[up + dx] = Math.max(0, v - decay);
            }
        }
        // Cells with nothing beneath must cool too, or ghosts linger.
        // Faster while the match moves, so it leaves no long trail.
        const cool = t < this.tIgnite ? 0.7 : 0.9;
        for (let i = 0; i < base * cols; i++)
            heat[i] *= cool;
        // Before impact only the flames' own sources may stay lit on the floor row.
        if (t < this.tImpact)
            heat.fill(0, base * cols);
        // The candle body hides any fire behind it.
        for (const [x, y] of this._wax)
            heat[y * cols + x] = 0;

        this._stepSparks(dt);
    }

    // Floor row after impact: spreads from the impact point to the screen edges.
    _floorSource(since) {
        const {cols, base, heat, rng, opts} = this;
        const p = Math.min(1, since / opts.spreadTime);
        const ease = 1 - Math.pow(1 - p, 3);
        const reach = Math.max(this.impactX, cols - this.impactX) + 2;
        const halfW = lerp(this.impactHalf, reach, ease);
        const edge = Math.max(1, cols * opts.edgeFalloff);
        this._bandHalf = halfW;
        for (let x = 0; x < cols; x++) {
            this._srcNoise[x] = Math.min(1, Math.max(0, this._srcNoise[x] + (rng() - 0.5) * 0.15));
            let h = 1 - smoothstep(halfW - 1.5, halfW + 0.5, Math.abs(x - this.impactX));
            // Band fades toward the screen edges once it is wide.
            h *= 1 - ease * (1 - smoothstep(0, edge, Math.min(x, cols - 1 - x))) * 0.6;
            h *= 0.75 + 0.25 * this._srcNoise[x];
            h *= 0.85 + 0.15 * rng();
            heat[base * cols + x] = h;
        }
    }

    // n sparks around (x, y), spread over ±halfW columns.
    _burst(n, x, y, speed, halfW) {
        const {rng, opts} = this;
        for (let i = 0; i < n; i++) {
            this.sparks.push({
                x: x + (rng() * 2 - 1) * halfW, y,
                vx: (rng() - 0.5) * speed * 1.2,
                vy: -speed * (0.4 + rng() * 0.6),
                g: speed * 0.5,
                life: opts.sparkLife * (0.4 + rng() * 0.6),
                age: 0,
            });
        }
    }

    _stepSparks(dt) {
        const {opts, rng, cols} = this;
        const t = this.time;
        // Steady sparks: a few from the candle, more from the band.
        let rate = 0, x0 = 0, x1 = 0;
        if (t >= this.tIgnite && t < this.tImpact) {
            const [wx] = this._wick();
            rate = 1.5;
            x0 = wx - 1;
            x1 = wx + 1;
        } else if (t >= this.tImpact) {
            rate = opts.sparkRate;
            x0 = Math.max(0, this.impactX - this._bandHalf);
            x1 = Math.min(cols - 1, this.impactX + this._bandHalf);
        }
        this._sparkAcc += dt * rate;
        while (this._sparkAcc >= 1) {
            this._sparkAcc -= 1;
            const x = lerp(x0, x1, rng());
            const y = this._flameTop(Math.round(x));
            if (y < 0)
                continue;
            this.sparks.push({
                x, y,
                vx: (rng() - 0.5) * 1.5,
                vy: -(4 + rng() * 6),
                g: 0,
                life: opts.sparkLife * (0.5 + rng() * 0.5),
                age: 0,
            });
        }
        for (const s of this.sparks) {
            s.age += dt;
            s.vy += s.g * dt;
            s.x += s.vx * dt + (rng() - 0.5) * 0.3;
            s.y += s.vy * dt;
        }
        this.sparks = this.sparks.filter(s => s.age < s.life && s.y >= 0 && s.y <= this.base && s.x >= 0 && s.x < cols);
    }

    // Highest row in column x that still holds visible heat.
    _flameTop(x) {
        const {cols, base, heat, opts} = this;
        if (x < 0 || x >= cols)
            return -1;
        for (let y = 0; y <= base; y++) {
            if (heat[y * cols + x] > opts.minHeat * 2)
                return y;
        }
        return -1;
    }

    /**
     * Visible cells grouped by color index, so the renderer sets each color once.
     * Returns COLORS.length arrays of runs [col, row, text] with contiguous chars.
     */
    collect() {
        const {cols, base, heat, rng, opts} = this;
        const buckets = COLORS.map(() => []);
        const nC = PALETTE.length;
        const nR = RAMP.length;
        for (let y = 0; y <= base; y++) {
            const row = y * cols;
            let runColor = -1, runStart = 0, runText = '';
            for (let x = 0; x <= cols; x++) {
                let c = -1, ch = '';
                if (x < cols) {
                    const v = heat[row + x];
                    if (v > opts.minHeat) {
                        // Jitter both lookups so the glyphs flicker every frame.
                        const j = v + (rng() - 0.5) * 0.08;
                        const ri = Math.min(nR - 1, Math.max(1, Math.floor(Math.pow(j, 0.65) * nR)));
                        ch = RAMP[ri];
                        c = Math.min(nC - 1, Math.max(0, Math.floor(Math.pow(j, 0.6) * nC * 1.08)));
                    }
                }
                if (c !== runColor) {
                    if (runColor >= 0)
                        buckets[runColor].push([runStart, y, runText]);
                    runColor = c;
                    runStart = x;
                    runText = '';
                }
                runText += ch;
            }
        }
        if (this.time < this.tImpact) {
            this._collectFloor(buckets);
            this._collectCandle(buckets);
            this._collectMatch(buckets);
        } else {
            this._collectShockwave(buckets);
        }
        for (const s of this.sparks) {
            const k = 1 - s.age / s.life;
            const ch = SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor(k * SPARK_CHARS.length))];
            const c = Math.min(nC - 1, Math.floor(k * 5) + 1);
            buckets[c].push([Math.round(s.x), Math.round(s.y), ch]);
        }
        return buckets;
    }

    // Wax lit from above: a blazing rim of dense glyphs, letters below, dim grey sticks at the foot.
    _collectCandle(buckets) {
        const {rng, waxW, waxH, waxHalf} = this;
        const nR = RAMP.length;
        const lit = this._lit;
        const m = this._match();
        const a = this.opts.cellAspect;
        for (const [x, y, u, v] of this._wax) {
            if (v === 0 && u === waxHalf) {
                // Wick.
                buckets[lit > 0.3 ? 1 : W0].push([x, y, '|']);
                continue;
            }
            const d = v / waxH;
            const side = Math.abs(u + 0.5 - waxW / 2) / (waxW / 2);
            let b = 0.16 + lit * (0.2 + 0.72 * Math.exp(-d * 3.2));
            b *= 1 - 0.35 * side * side;
            if (m) {
                // The approaching match lights up the side of the candle.
                const dist = Math.hypot(x - m.x, (y - m.y) * a);
                b += 0.5 * m.alpha * Math.exp(-dist / 6);
            }
            b += this._waxTex[v * waxW + u] * 0.1;
            let ch;
            if (v < 2 && lit > 0.3)
                ch = RIM_CHARS[(rng() * RIM_CHARS.length) | 0];
            else
                // Even unlit wax uses mid-ramp glyphs ([{|) so the body reads as solid.
                ch = RAMP[Math.min(nR - 1, Math.floor((0.24 + 0.76 * Math.min(1, Math.max(0, b))) * (nR - 1)))];
            let c;
            if (v < 2 && lit > 0.3)
                c = b > 0.75 ? 6 : 5;
            else if (b > 0.82)
                c = 5;
            else if (b > 0.68)
                c = 4;
            else if (b > 0.55)
                c = 3;
            else if (b > 0.42)
                c = W0 + 2;
            else if (b > 0.28)
                c = W0 + 1;
            else
                c = W0;
            buckets[c].push([x, y, ch]);
        }
    }

    // Match stick: a short diagonal under the flame.
    _collectMatch(buckets) {
        const m = this._match();
        if (!m)
            return;
        for (let k = 1; k <= 6; k++) {
            if (this.rng() > m.alpha)
                continue;
            const x = m.x - Math.round(k * 0.9), y = m.y + Math.round(k * 0.55);
            if (x >= 0 && y <= this.base)
                buckets[k <= 2 ? 2 : W0 + 1].push([x, y, '/']);
        }
    }

    // Dotted table line under the candle, catching some light near it.
    _collectFloor(buckets) {
        const {base, cx, waxHalf} = this;
        const x0 = Math.max(0, cx - waxHalf - 8);
        const x1 = Math.min(this.cols - 1, this.impactX + this.impactHalf + 6);
        const lit = this._lit;
        let text = '';
        for (let x = x0; x <= x1; x++) {
            const p = this._floorPat[x];
            text += p < 0.55 ? '.' : p < 0.7 ? '_' : ' ';
        }
        buckets[lit > 0.3 ? W0 + 1 : W0].push([x0, base, text]);
    }

    // Shockwave after impact: dim horizontal streaks racing out across the screen.
    _collectShockwave(buckets) {
        const since = this.time - this.tImpact;
        if (since > 0.9)
            return;
        const {cols, base, heat, rng, opts} = this;
        const k = since / 0.9;
        const fade = 1 - k;
        const r = since * cols * 1.4;
        const top = Math.max(0, Math.round(base - this.rows * 0.7));
        for (let y = top; y <= base; y += 2) {
            for (let x = 0; x < cols; x++) {
                const d = Math.abs(x - this.impactX);
                if (d > r || heat[y * cols + x] > opts.minHeat)
                    continue;
                const front = d > r - 4;
                if (!front && rng() > 0.35 * fade)
                    continue;
                const ch = WAVE_CHARS[(rng() * WAVE_CHARS.length) | 0];
                buckets[front ? 2 : fade > 0.5 ? 0 : W0].push([x, y, ch]);
            }
        }
    }

    // Plain-text frame for debugging.
    toText() {
        const lines = Array.from({length: this.rows}, () => new Array(this.cols).fill(' '));
        for (const bucket of this.collect()) {
            for (const [x, y, text] of bucket) {
                for (let i = 0; i < text.length; i++) {
                    if (lines[y] && x + i < this.cols)
                        lines[y][x + i] = text[i];
                }
            }
        }
        return lines.map(l => l.join('')).join('\n');
    }
}
