import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FireSim, COLORS} from './fire.js';

// ---- Settings -------------------------------------------------------------
const TRIGGER_MODE = 'hover';     // 'hover' | 'click' | 'always'
const HOVER_DELAY_MS = 300;
const ZONE_RX = 0.12;             // trigger ellipse half-width, fraction of monitor width
const ZONE_RY = 0.16;             // trigger ellipse half-height, fraction of monitor height
const POINTER_POLL_MS = 100;

const FPS = 20;
const CELL_W = 11;                // px; replaced by the font's real advance when measurable
const CELL_H = 20;                // px
const FONT_FAMILY = 'Monospace';
const FONT_SIZE = 18;             // px
const BG_COLOR = [0x16, 0x16, 0x1d];
const FILL_BACKGROUND = true;     // paint BG_COLOR ourselves, regardless of the wallpaper

const PAUSE_CHECK_MS = 1000;      // how often to check for maximized/fullscreen windows
const SIM_OPTIONS = {};           // overrides for fire.js DEFAULTS (burnTime, fallTime, fullHeight, ...)
// ---------------------------------------------------------------------------

export default class AsciiFireExtension extends Extension {
    enable() {
        this._started = false;
        this._paused = false;
        this._hoverMs = 0;
        this._sim = null;
        this._cellW = CELL_W;
        this._cellMeasured = false;
        this._timers = [];

        this._area = new St.DrawingArea({reactive: false});
        this._repaintId = this._area.connect('repaint', a => this._repaint(a));
        Main.layoutManager._backgroundGroup.add_child(this._area);
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._relayout());
        this._relayout();

        if (TRIGGER_MODE === 'always')
            this._start();
        else
            this._pointerTimer = this._addTimer(POINTER_POLL_MS, () => this._pollPointer());

        this._pauseTimer = this._addTimer(PAUSE_CHECK_MS, () => {
            this._paused = this._desktopObscured();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = [];
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._area) {
            this._area.disconnect(this._repaintId);
            this._area.destroy();
            this._area = null;
        }
        this._sim = null;
    }

    _addTimer(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            const ret = fn();
            if (ret !== GLib.SOURCE_CONTINUE)
                this._timers = this._timers.filter(t => t !== id);
            return ret;
        });
        this._timers.push(id);
        return id;
    }

    _relayout() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._area)
            return;
        this._monitor = m;
        this._area.set_position(m.x, m.y);
        this._area.set_size(m.width, m.height);
        // Backgrounds are re-created at the bottom of the group; keep us on top.
        Main.layoutManager._backgroundGroup.set_child_above_sibling(this._area, null);
        this._sim?.resize(Math.ceil(m.width / this._cellW), Math.ceil(m.height / CELL_H), CELL_H / this._cellW);
        this._area.queue_repaint();
    }

    _pollPointer() {
        const m = this._monitor;
        if (!m)
            return GLib.SOURCE_CONTINUE;
        const [px, py, mods] = global.get_pointer();
        const dx = (px - (m.x + m.width / 2)) / (m.width * ZONE_RX);
        const dy = (py - (m.y + m.height / 2)) / (m.height * ZONE_RY);
        const inside = dx * dx + dy * dy <= 1;

        let fire = false;
        if (TRIGGER_MODE === 'click') {
            fire = inside && (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
        } else {
            this._hoverMs = inside ? this._hoverMs + POINTER_POLL_MS : 0;
            fire = this._hoverMs >= HOVER_DELAY_MS;
        }
        if (!fire)
            return GLib.SOURCE_CONTINUE;
        this._start();
        // Pointer is no longer needed once the fire is lit.
        this._pointerTimer = 0;
        return GLib.SOURCE_REMOVE;
    }

    _start() {
        if (this._started)
            return;
        this._started = true;
        const m = this._monitor;
        this._sim = new FireSim(Math.ceil(m.width / this._cellW), Math.ceil(m.height / CELL_H),
            {...SIM_OPTIONS, cellAspect: CELL_H / this._cellW});
        this._lastUs = GLib.get_monotonic_time();
        this._addTimer(Math.round(1000 / FPS), () => this._tick());
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.2, (now - this._lastUs) / 1e6);
        this._lastUs = now;
        if (!this._paused && this._sim && this._area) {
            this._sim.step(dt);
            this._area.queue_repaint();
        }
        return GLib.SOURCE_CONTINUE;
    }

    // True when a maximized or fullscreen window covers the primary monitor.
    _desktopObscured() {
        try {
            if (Main.overview.visible)
                return true;
            const primary = Main.layoutManager.primaryIndex;
            const ws = global.workspace_manager.get_active_workspace();
            for (const actor of global.get_window_actors()) {
                const w = actor.get_meta_window?.() ?? actor.meta_window;
                if (!w || w.minimized || !w.showing_on_its_workspace())
                    continue;
                if (w.get_monitor() !== primary)
                    continue;
                if (!w.is_on_all_workspaces() && w.get_workspace() !== ws)
                    continue;
                if (w.get_window_type() !== Meta.WindowType.NORMAL)
                    continue;
                if (w.is_fullscreen())
                    return true;
                const maximized = typeof w.is_maximized === 'function'
                    ? w.is_maximized()
                    : w.get_maximized() === Meta.MaximizeFlags.BOTH;
                if (maximized)
                    return true;
            }
        } catch (e) {
            console.warn(`[ascii-fire] pause check failed: ${e}`);
        }
        return false;
    }

    _repaint(area) {
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            if (FILL_BACKGROUND) {
                cr.setSourceRGB(BG_COLOR[0] / 255, BG_COLOR[1] / 255, BG_COLOR[2] / 255);
                cr.rectangle(0, 0, w, h);
                cr.fill();
            }
            if (!this._sim)
                return;

            cr.selectFontFace(FONT_FAMILY, Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(FONT_SIZE);
            this._measureCell(cr);

            const cw = this._cellW;
            const baseline = CELL_H * 0.8;
            const buckets = this._sim.collect();
            for (let c = 0; c < buckets.length; c++) {
                const runs = buckets[c];
                if (!runs.length)
                    continue;
                const [r, g, b] = COLORS[c];
                cr.setSourceRGB(r / 255, g / 255, b / 255);
                for (const [x, y, text] of runs) {
                    cr.moveTo(x * cw, y * CELL_H + baseline);
                    cr.showText(text);
                }
            }
        } catch (e) {
            console.error(`[ascii-fire] repaint failed: ${e}`);
        } finally {
            cr.$dispose();
        }
    }

    // Runs are drawn as whole strings, so the cell width must equal the glyph advance.
    _measureCell(cr) {
        if (this._cellMeasured)
            return;
        this._cellMeasured = true;
        try {
            const adv = cr.textExtents('M').xAdvance;
            if (adv > 2 && Math.abs(adv - this._cellW) > 0.01) {
                this._cellW = adv;
                this._relayout();
            }
        } catch (e) {
            console.warn(`[ascii-fire] font measure failed, using CELL_W: ${e}`);
        }
    }
}
