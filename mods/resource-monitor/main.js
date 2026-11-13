// Resource: CPU and memory of this computer, and every process with its CPU,
// memory and the ports it listens on. Type to filter (name, PID, port;
// ":5173" matches ports only), click a column chip to sort, click a row to
// select it, then terminate or force kill it. The gear opens settings:
// language (English / 繁體中文) and refresh interval, kept in shared state
// "resource-monitor.settings" so every copy and every restart agree.
// macOS, Linux and Windows: the commands per platform are in sources.js.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, settings, notify, props, layout, shared, setShared } from "herdr";
import { makeCollector, killProcess, platform } from "./sources.js";

const MAX_ROWS = 300;
const SETTINGS_KEY = "resource-monitor.settings";
const OLD_SETTINGS_KEY = "proc-monitor.settings";
const DEFAULTS = { lang: "en", intervalSec: 3 };
const INTERVALS = [1, 2, 3, 5, 10, 30, 0]; // 0 = paused

const I18N = {
  "zh-TW": {
    title: "Resource",
    summary: (n, ports, time) => `${n} 個 process · ${ports} 個有 port · ${time}`,
    cpuLabel: "CPU",
    cores: (n) => `${n} 核心`,
    load: "負載",
    memLabel: "記憶體",
    app: "App",
    wired: "Wired",
    compressed: "壓縮",
    cached: "快取",
    used: "已使用",
    swap: "Swap",
    pressure: "壓力",
    placeholder: "搜尋名稱 / PID / port（:5173 只比對 port）",
    sort: "排序",
    cpu: "CPU",
    mem: "記憶體",
    port: "Port",
    portsOnly: "只看有 port",
    empty: "沒有符合的 process",
    loading: "讀取中…",
    more: (n) => `還有 ${n} 筆，請縮小搜尋範圍`,
    term: "終止",
    kill: "強制終止",
    cancel: "取消",
    sent: (sig) => (sig === "KILL" ? "已強制終止" : "已要求結束"),
    failed: (name) => `無法終止 ${name}`,
    gone: "Process 已經結束",
    refreshFailed: (e) => `更新失敗：${e}`,
    settings: "設定",
    language: "語言",
    interval: "更新頻率",
    seconds: (n) => `${n} 秒`,
    paused: "暫停",
    refreshNow: "立即重新整理",
    pausedNote: "自動更新已暫停",
  },
  en: {
    title: "Resource",
    summary: (n, ports, time) => `${n} processes · ${ports} with ports · ${time}`,
    cpuLabel: "CPU",
    cores: (n) => `${n} cores`,
    load: "Load",
    memLabel: "Memory",
    app: "App",
    wired: "Wired",
    compressed: "Compressed",
    cached: "Cached",
    used: "Used",
    swap: "Swap",
    pressure: "Pressure",
    placeholder: "Search name / PID / port (:5173 matches ports only)",
    sort: "Sort",
    cpu: "CPU",
    mem: "Memory",
    port: "Port",
    portsOnly: "With ports only",
    empty: "No matching processes",
    loading: "Loading…",
    more: (n) => `${n} more, narrow your search`,
    term: "Terminate",
    kill: "Force kill",
    cancel: "Cancel",
    sent: (sig) => (sig === "KILL" ? "Force killed" : "Asked to quit"),
    failed: (name) => `Couldn't terminate ${name}`,
    gone: "Process already exited",
    refreshFailed: (e) => `Refresh failed: ${e}`,
    settings: "Settings",
    language: "Language",
    interval: "Refresh every",
    seconds: (n) => `${n}s`,
    paused: "Paused",
    refreshNow: "Refresh now",
    pausedNote: "Auto refresh paused",
  },
};

function prefs() {
  const s = shared(SETTINGS_KEY) ?? shared(OLD_SETTINGS_KEY);
  const out = { ...DEFAULTS, ...(s && typeof s === "object" ? s : {}) };
  if (!I18N[out.lang]) out.lang = DEFAULTS.lang;
  if (!INTERVALS.includes(out.intervalSec)) out.intervalSec = DEFAULTS.intervalSec;
  return out;
}

function setPref(patch) {
  setShared(SETTINGS_KEY, { ...prefs(), ...patch });
}

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

// ps / lsof can occasionally hang; without a cap `busy` would stay true and
// the list would freeze on stale rows.
const COLLECT_TIMEOUT_MS = 8000;

function withTimeout(cx, promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = cx.timer.after(ms, () => reject(new Error(`timed out after ${ms / 1000}s`)));
  });
  return Promise.race([promise, timeout]).finally(() => timer?.cancel?.());
}

// kill / taskkill wording for "that PID doesn't exist".
const GONE_RE = /no such process|not found|找不到/i;

function fmtMem(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

export default class ResourceMonitor extends View {
  init(_props, cx) {
    this.procs = [];
    this.sys = null;
    this.os = platform();
    this.collect = makeCollector(this.os);
    this.filter = "";
    this.sort = "cpu";
    this.portsOnly = false;
    this.selected = null;
    this.busy = false;
    this.gen = 0;
    this.error = "";
    this.updatedAt = null;
    this.lastRun = 0;
    this.showSettings = false;
    // InputState has no placeholder setter and can't be created during
    // render, so make one field per language up front and show the current one.
    this.inputs = {};
    for (const lang of Object.keys(I18N)) {
      const input = InputState.new({ placeholder: I18N[lang].placeholder });
      input.on("change", (_e, cx) => {
        this.filter = input.value();
        cx.notify();
      });
      this.inputs[lang] = input;
    }
    // Opened as a dialog: type at once. Docked in the layout's side panel:
    // leave the keyboard with the terminal.
    if (props()?.overlay) {
      this.inputs[prefs().lang].focus();
      cx.timer.after(300, () => this.inputs[prefs().lang].focus());
    }
    this.refresh(cx);
    // One cheap 1 s tick; it refreshes only once the chosen interval passed.
    cx.timer.every(1000, (cx) => {
      const { intervalSec } = prefs();
      if (!intervalSec || !this.isShown()) return;
      if (Date.now() - this.lastRun >= intervalSec * 1000 - 50) this.refresh(cx);
    });
  }

  // Switch language from a click: carry the typed search into that field.
  setLang(lang) {
    const input = this.inputs[lang];
    if (input && input.value() !== this.filter) input.set_value(this.filter);
    setPref({ lang });
  }

  // A copy in the side panel keeps running while the panel is hidden or shows
  // Files / Changes; skip polling then.
  isShown() {
    if (props()?.overlay) return true;
    const root = layout();
    const panel = findNode(root, "panel");
    const body = findNode(root, "panel-body");
    if (!panel || !body || !findNode(body, "processes")) return true;
    return !panel.hidden && body.active === "processes";
  }

  // force: start a new run even if one is in flight; the older run's result
  // is dropped when it lands (gen no longer matches).
  refresh(cx, force = false) {
    if (this.busy && !force) return;
    const gen = ++this.gen;
    this.busy = true;
    this.lastRun = Date.now();
    cx.spawn(async (cx) => {
      try {
        const { procs, sys } = await withTimeout(cx, this.collect(), COLLECT_TIMEOUT_MS);
        if (gen !== this.gen) return;
        this.procs = procs;
        this.sys = sys;
        this.updatedAt = new Date();
        this.error = "";
      } catch (err) {
        if (gen !== this.gen) return;
        this.error = String(err);
      } finally {
        if (gen === this.gen) {
          this.busy = false;
          this.lastRun = Date.now();
        }
      }
      cx.notify();
    });
  }

  kill(proc, signal, cx) {
    const tr = I18N[prefs().lang];
    cx.spawn(async (cx) => {
      let r;
      try {
        r = await killProcess(proc.pid, signal, this.os);
      } catch (err) {
        r = { code: -1, stderr: String(err) };
      }
      const body = `${proc.name} (PID ${proc.pid})`;
      if (r.code === 0) {
        notify({ title: tr.sent(signal), body, level: "success", timeout: 3000 });
        this.selected = null;
      } else if (GONE_RE.test(`${r.stderr ?? ""} ${r.stdout ?? ""}`)) {
        // The row was stale: the process had already exited.
        notify({ title: tr.gone, body, level: "info", timeout: 3000 });
        this.selected = null;
      } else {
        notify({ title: tr.failed(proc.name), body: (r.stderr || `exit ${r.code}`).trim(), level: "error" });
      }
      cx.notify();
      this.refresh(cx, true);
    });
  }

  visible() {
    const q = this.filter.trim().toLowerCase();
    const portQuery = q.startsWith(":") ? q.slice(1) : null;
    const list = this.procs.filter((p) => {
      if (this.portsOnly && p.ports.length === 0) return false;
      if (!q) return true;
      if (portQuery !== null) return p.ports.some((x) => x.startsWith(portQuery));
      return (
        p.name.toLowerCase().includes(q) ||
        p.command.toLowerCase().includes(q) ||
        String(p.pid).startsWith(q) ||
        p.ports.some((x) => x.startsWith(q))
      );
    });
    const byPort = (p) => (p.ports.length ? parseInt(p.ports[0], 10) : Infinity);
    if (this.sort === "cpu") list.sort((a, b) => b.cpu - a.cpu || b.memMb - a.memMb);
    else if (this.sort === "mem") list.sort((a, b) => b.memMb - a.memMb || b.cpu - a.cpu);
    else list.sort((a, b) => byPort(a) - byPort(b) || b.cpu - a.cpu);
    return list;
  }

  chip(t, id, label, on, onClick) {
    return div()
      .id(id)
      .px(9)
      .py(3)
      .rounded(6)
      .text_size(11.5)
      .cursor_pointer()
      .border_1()
      .border_color(on ? t.accent : t.border)
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        onClick(cx);
        cx.notify();
      })
      .child(label);
  }

  button(t, id, label, color, onClick) {
    return div()
      .id(id)
      .px(10)
      .py(4)
      .rounded(6)
      .text_size(12)
      .cursor_pointer()
      .border_1()
      .border_color(color)
      .text_color(color)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick(cx);
      })
      .child(label);
  }

  settingsPanel(t, tr, p) {
    const label = (text) => div().w(72).flex_none().text_size(11.5).text_color(t.dim).child(text);
    return v_flex()
      .p(10)
      .gap(8)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(
        h_flex().gap(6).items_center().flex_wrap()
          .child(label(tr.language))
          .child(this.chip(t, "lang-en", "English", p.lang === "en", () => this.setLang("en")))
          .child(this.chip(t, "lang-zh", "繁體中文", p.lang === "zh-TW", () => this.setLang("zh-TW"))),
      )
      .child(
        h_flex().gap(6).items_center().flex_wrap()
          .child(label(tr.interval))
          .children(
            INTERVALS.map((sec) =>
              this.chip(t, `iv-${sec}`, sec ? tr.seconds(sec) : tr.paused, p.intervalSec === sec, () => setPref({ intervalSec: sec }))),
          ),
      )
      .child(
        h_flex().gap(6).items_center()
          .child(label(""))
          .child(this.button(t, "pm-refresh-now", `↻ ${tr.refreshNow}`, t.muted, (cx) => this.refresh(cx))),
      );
  }

  row(t, tr, mono, p) {
    const on = this.selected === p.pid;
    const hot = p.cpu >= 50;
    const head = h_flex()
      .gap(8)
      .items_center()
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).when(on, (d) => d.font_semibold()).child(p.name))
      .child(div().w(54).flex_none().font_family(mono).text_size(11.5).text_color(hot ? t.blocked : t.muted).child(`${p.cpu.toFixed(1)}%`))
      .child(div().w(64).flex_none().font_family(mono).text_size(11.5).text_color(t.muted).child(fmtMem(p.memMb)));

    const meta = h_flex()
      .gap(6)
      .items_center()
      .text_size(11)
      .child(div().font_family(mono).text_color(t.dim).child(`PID ${p.pid}`))
      .child(div().text_color(t.dim).child(p.user))
      .children(
        p.ports.slice(0, 6).map((port) =>
          div().px(5).rounded(4).bg(t.raised).font_family(mono).text_color(t.accent).child(`:${port}`)),
      )
      .when(p.ports.length > 6, (el) => el.child(div().text_color(t.dim).child(`+${p.ports.length - 6}`)));

    let el = v_flex()
      .id(`proc-${p.pid}`)
      .px(10)
      .py(6)
      .gap(3)
      .rounded(7)
      .cursor_pointer()
      .when(on, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.selected = on ? null : p.pid;
        cx.notify();
      })
      .child(head)
      .child(meta);

    if (on) {
      el = el
        .child(div().text_size(11).text_color(t.muted).font_family(mono).child(p.command))
        .child(
          h_flex()
            .pt(4)
            .gap(8)
            .flex_wrap()
            .child(this.button(t, `term-${p.pid}`, tr.term, t.blocked, (cx) => this.kill(p, "TERM", cx)))
            .child(this.button(t, `kill-${p.pid}`, tr.kill, t.ansi1, (cx) => this.kill(p, "KILL", cx)))
            .child(this.button(t, `cancel-${p.pid}`, tr.cancel, t.muted, (cx) => {
              this.selected = null;
              cx.notify();
            })),
        );
    }
    return el;
  }

  // A bar of colored segments, each { pct, color }, on a track.
  bar(t, segments) {
    return h_flex()
      .h(6)
      .w_full()
      .rounded(3)
      .overflow_hidden()
      .bg(t.raised)
      .children(
        segments
          .filter((s) => s.pct > 0)
          .map((s) => div().h_full().w(`${Math.min(100, s.pct).toFixed(2)}%`).bg(s.color)),
      );
  }

  overview(t, tr, mono, totalCpu) {
    const s = this.sys;
    const cpuPct = Math.min(100, totalCpu / s.ncpu);
    const usedMb = s.usedMb;
    // Segment colors by kind; every platform reports its own kinds (parse.js).
    const colorOf = { app: t.ansi4, used: t.ansi4, wired: t.ansi6, compressed: t.ansi5, cached: t.dim };
    const segments = s.segments.filter((g) => g.mb > 0);
    const pctOf = (mb) => (s.totalMb ? (mb / s.totalMb) * 100 : 0);
    const level = (pct, warn, crit) => (pct >= crit ? t.ansi1 : pct >= warn ? t.ansi3 : t.ansi2);
    const head = (label, value, color) =>
      h_flex()
        .items_center()
        .gap(8)
        .child(div().flex_1().text_size(11.5).text_color(t.muted).child(label))
        .child(div().font_family(mono).text_size(11.5).text_color(color ?? t.foreground).child(value));
    const legend = (color, label, mb) =>
      h_flex()
        .gap(4)
        .items_center()
        .child(div().size(7).rounded(2).bg(color))
        .child(div().text_color(t.dim).child(`${label} ${fmtMem(mb)}`));
    const swapPct = s.swapTotalMb ? (s.swapUsedMb / s.swapTotalMb) * 100 : 0;

    return v_flex()
      .p(10)
      .gap(6)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(head(`${tr.cpuLabel} · ${tr.cores(s.ncpu)}`, `${cpuPct.toFixed(0)}%`, level(cpuPct, 60, 85)))
      .child(this.bar(t, [{ pct: cpuPct, color: level(cpuPct, 60, 85) }]))
      .when(!!s.load, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${tr.load} ${s.load}`)))
      .child(div().h(2))
      .child(head(tr.memLabel, `${fmtMem(usedMb)} / ${fmtMem(s.totalMb)}`))
      .child(
        this.bar(t, segments.map((g) => ({ pct: pctOf(g.mb), color: colorOf[g.key] ?? t.muted }))),
      )
      .child(
        h_flex()
          .gap(10)
          .flex_wrap()
          .text_size(11)
          .children(segments.map((g) => legend(colorOf[g.key] ?? t.muted, tr[g.key] ?? g.key, g.mb))),
      )
      .child(
        h_flex()
          .gap(10)
          .flex_wrap()
          .text_size(11)
          .when(s.swapTotalMb > 0, (el) =>
            el.child(div().text_color(swapPct >= 80 ? t.ansi3 : t.dim).child(`${tr.swap} ${fmtMem(s.swapUsedMb)} / ${fmtMem(s.swapTotalMb)}`)))
          .when(s.pressure !== null, (el) =>
            el.child(div().text_color(level(s.pressure, 60, 85)).child(`${tr.pressure} ${s.pressure.toFixed(0)}%`))),
      );
  }

  render() {
    const t = theme();
    const p = prefs();
    const tr = I18N[p.lang];
    const mono = settings().font_family ?? "JetBrains Mono";
    const list = this.visible();
    const shown = list.slice(0, MAX_ROWS);
    const listening = this.procs.filter((x) => x.ports.length > 0).length;
    const totalCpu = this.procs.reduce((s, x) => s + x.cpu, 0);
    const time = this.updatedAt
      ? this.updatedAt.toLocaleTimeString(p.lang === "en" ? "en-US" : "zh-TW")
      : "—";
    const status = p.intervalSec ? time : `${time} · ${tr.pausedNote}`;

    return v_flex()
      .id("proc-monitor")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .p(12)
      .gap(10)
      .text_size(12.5)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(div().flex_1().text_size(14).font_semibold().text_color(t.foreground).child(tr.title))
          .child(
            h_flex()
              .id("pm-settings")
              .size(24)
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(6)
              .cursor_pointer()
              .text_color(this.showSettings ? t.foreground : t.muted)
              .when(this.showSettings, (el) => el.bg(t.selected))
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.showSettings = !this.showSettings;
                cx.notify();
              })
              .child(svg("mods/workspace-chrome/settings.svg").size(14)),
          ),
      )
      .when(this.showSettings, (el) => el.child(this.settingsPanel(t, tr, p)))
      .when(!!this.sys, (el) => el.child(this.overview(t, tr, mono, totalCpu)))
      .child(
        div()
          .text_size(11)
          .text_color(t.dim)
          .truncate()
          .child(tr.summary(this.procs.length, listening, status)),
      )
      .child(
        h_flex()
          .h(32)
          .flex_none()
          .px(10)
          .items_center()
          .rounded(8)
          .border_1()
          .border_color(t.input)
          .bg(t.background)
          .child(Input.new(this.inputs[p.lang]).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
      )
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .items_center()
          .child(div().text_size(11).text_color(t.dim).child(tr.sort))
          .child(this.chip(t, "sort-cpu", tr.cpu, this.sort === "cpu", () => (this.sort = "cpu")))
          .child(this.chip(t, "sort-mem", tr.mem, this.sort === "mem", () => (this.sort = "mem")))
          .child(this.chip(t, "sort-port", tr.port, this.sort === "port", () => (this.sort = "port")))
          .child(div().w(6))
          .child(this.chip(t, "ports-only", this.portsOnly ? `✓ ${tr.portsOnly}` : tr.portsOnly, this.portsOnly, () => (this.portsOnly = !this.portsOnly))),
      )
      .when(!!this.error, (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(tr.refreshFailed(this.error))))
      .child(
        v_flex()
          .id("pm-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .gap(2)
          .when(shown.length === 0, (el) =>
            el.child(div().p(12).text_color(t.dim).child(this.procs.length ? tr.empty : tr.loading)))
          .children(shown.map((x) => this.row(t, tr, mono, x)))
          .when(list.length > shown.length, (el) =>
            el.child(div().p(8).text_size(11).text_color(t.dim).child(tr.more(list.length - shown.length)))),
      );
  }
}
