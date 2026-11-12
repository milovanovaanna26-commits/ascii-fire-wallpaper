// Prints frames across the whole timeline. Run: node test_fire.mjs  (or: gjs -m test_fire.mjs)
import {FireSim} from './ascii-fire@local/fire.js';

// Small seeded RNG so runs are reproducible.
let seed = 12345;
const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const sim = new FireSim(120, 45, {}, rng);
const dt = 1 / 20;
let t = 0;
for (const target of [0.3, 1.2, 4, 6.8, 7.3, 14]) {
    while (t < target - 1e-9) {
        sim.step(dt);
        t += dt;
    }
    const text = sim.toText();
    const widths = text.split('\n').map(l => l.trim().length);
    console.log(`===== t=${target}s  phase=${sim.phase}  widest row=${Math.max(...widths)} cols  lit rows=${widths.filter(w => w > 0).length} =====`);
    console.log(text.split('\n').map(l => `|${l}|`).join('\n'));
}
