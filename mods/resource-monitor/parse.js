// Pure parsers for each platform's command output. No herdr imports, so they
// run (and are tested) under plain Node too.
//
// A process: { pid, cpu, memMb, user, name, command, ports: string[] }
// cpu is percent of one core (like top / Activity Monitor): it can pass 100.
//
// System: { totalMb, segments: [{ key, mb }], usedMb, ncpu,
//           swapUsedMb, swapTotalMb, load: string | null, pressure: number | null }

export function basename(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

// "postgres: checkpointer" -> "postgres"; "/usr/bin/node x.js" -> "node";
// "[kthreadd]" stays as is.
export function nameFromArgs(args) {
  const first = args.trim().split(/\s+/)[0] ?? "";
  if (first.startsWith("[")) return args.trim();
  return basename(first).replace(/:$/, "") || args.trim();
}

function addPort(map, pid, label) {
  const list = map.get(pid) ?? [];
  if (!list.includes(label)) list.push(label);
  map.set(pid, list);
}

function sortPorts(map) {
  for (const list of map.values()) list.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return map;
}

// ---------- macOS / BSD ----------

// ps -axo pid=,pcpu=,rss=,user=,comm=   (comm is the executable's full path)
export function parsePsMac(stdout) {
  const map = new Map();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    map.set(pid, {
      pid,
      cpu: Number(m[2]),
      memMb: Number(m[3]) / 1024,
      user: m[4],
      name: basename(m[5]),
      command: m[5],
      ports: [],
    });
  }
  return map;
}

// lsof -nP -iTCP -sTCP:LISTEN -iUDP -F pPn: "p<pid>", then per socket
// "P<TCP|UDP>" and "n<addr:port>".
export function parseLsof(stdout) {
  const out = new Map();
  let pid = -1;
  let proto = "";
  for (const line of stdout.split("\n")) {
    const tag = line[0];
    const val = line.slice(1).trim();
    if (tag === "p") pid = Number(val);
    else if (tag === "P") proto = val;
    else if (tag === "n" && pid > 0) {
      const port = val.slice(val.lastIndexOf(":") + 1);
      if (!/^\d+$/.test(port)) continue;
      addPort(out, pid, proto === "UDP" ? `${port}/udp` : port);
    }
  }
  return sortPorts(out);
}

// vm_stat + `sysctl -n hw.memsize hw.ncpu vm.swapusage vm.loadavg kern.memorystatus_level`,
// counted the way Activity Monitor does: used = app (anonymous - purgeable)
// + wired + compressed; cached = file-backed + purgeable.
export function parseSysMac(vmStat, sysctlOut) {
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (label) => Number(vmStat.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  const mb = (n) => (n * pageSize) / 1048576;
  const [memsize, ncpu, swapLine, loadLine, level] = sysctlOut.split("\n");
  const swapNum = (key) => Number(swapLine?.match(new RegExp(`${key} = ([\\d.]+)M`))?.[1] ?? 0);
  const purgeable = pages("Pages purgeable");
  const app = mb(Math.max(0, pages("Anonymous pages") - purgeable));
  const wired = mb(pages("Pages wired down"));
  const compressed = mb(pages("Pages occupied by compressor"));
  const cached = mb(pages("File-backed pages") + purgeable);
  const lvl = level === undefined || level.trim() === "" ? null : Number(level);
  return {
    totalMb: Number(memsize) / 1048576,
    segments: [
      { key: "app", mb: app },
      { key: "wired", mb: wired },
      { key: "compressed", mb: compressed },
      { key: "cached", mb: cached },
    ],
    usedMb: app + wired + compressed,
    ncpu: Number(ncpu) || 1,
    swapUsedMb: swapNum("used"),
    swapTotalMb: swapNum("total"),
    load: (loadLine ?? "").replace(/[{}]/g, "").trim().split(/\s+/).slice(0, 3).join(" ") || null,
    pressure: lvl === null || Number.isNaN(lvl) ? null : Math.max(0, 100 - lvl),
  };
}

// ---------- Linux ----------

// ps -eo pid=,pcpu=,rss=,user:32=,args=
// pcpu here is the lifetime average; the caller replaces it with a sampled
// value from /proc/<pid>/stat once it has two samples.
export function parsePsLinux(stdout) {
  const map = new Map();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[5].trim();
    map.set(pid, {
      pid,
      cpu: Number(m[2]),
      memMb: Number(m[3]) / 1024,
      user: m[4],
      name: nameFromArgs(args),
      command: args,
      ports: [],
    });
  }
  return map;
}

// `cat /proc/[0-9]*/stat`: "pid (comm) state ..." with utime and stime as the
// 14th and 15th fields, in clock ticks. comm may hold spaces and ")".
export function parseProcStat(stdout) {
  const ticks = new Map();
  for (const line of stdout.split("\n")) {
    const close = line.lastIndexOf(")");
    if (close < 0) continue;
    const pid = Number(line.slice(0, line.indexOf("(")).trim());
    const rest = line.slice(close + 2).split(" ");
    // rest[0] is field 3 (state), so utime (14) is rest[11], stime (15) rest[12].
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    if (pid > 0 && Number.isFinite(utime) && Number.isFinite(stime)) ticks.set(pid, utime + stime);
  }
  return ticks;
}

// ss -H -tulnp: "tcp LISTEN 0 200 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=8,fd=6))"
export function parseSs(stdout) {
  const out = new Map();
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0];
    const local = cols[4];
    const port = local.slice(local.lastIndexOf(":") + 1);
    if (!/^\d+$/.test(port)) continue;
    const label = proto === "udp" ? `${port}/udp` : port;
    for (const m of line.matchAll(/pid=(\d+)/g)) addPort(out, Number(m[1]), label);
  }
  return sortPorts(out);
}

// /proc/meminfo, /proc/loadavg, nproc
export function parseSysLinux(meminfo, loadavg, nproc) {
  const kb = (key) => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  const total = kb("MemTotal") / 1024;
  const available = (kb("MemAvailable") || kb("MemFree")) / 1024;
  const used = Math.max(0, total - available);
  const cached = Math.max(0, (kb("Buffers") + kb("Cached") + kb("SReclaimable") - kb("Shmem")) / 1024);
  return {
    totalMb: total,
    segments: [
      { key: "used", mb: used },
      { key: "cached", mb: Math.min(cached, Math.max(0, total - used)) },
    ],
    usedMb: used,
    ncpu: Number(String(nproc).trim()) || 1,
    swapUsedMb: Math.max(0, (kb("SwapTotal") - kb("SwapFree")) / 1024),
    swapTotalMb: kb("SwapTotal") / 1024,
    load: String(loadavg).trim().split(/\s+/).slice(0, 3).join(" ") || null,
    pressure: null,
  };
}

// ---------- Windows ----------

// The JSON the PowerShell script in sources.js prints:
// { procs: [{ i, n, m, c, f }], tcp: [{ p, l }], udp: [{ p, l }],
//   totalKb, freeKb, pfTotal, pfUsed, ncpu }
// c is total CPU seconds (sampled by the caller), m the working set in bytes,
// pfTotal / pfUsed the page file in MB.
export function parseWindows(json) {
  const data = JSON.parse(json);
  const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
  const procs = new Map();
  const cpuSeconds = new Map();
  for (const p of arr(data.procs)) {
    const pid = Number(p.i);
    if (!Number.isFinite(pid)) continue;
    const name = p.n ? (/\.exe$/i.test(p.n) ? p.n : `${p.n}.exe`) : "?";
    procs.set(pid, {
      pid,
      cpu: 0,
      memMb: Number(p.m ?? 0) / 1048576,
      user: "",
      name,
      command: p.f || name,
      ports: [],
    });
    if (p.c != null && Number.isFinite(Number(p.c))) cpuSeconds.set(pid, Number(p.c));
  }
  const ports = new Map();
  for (const e of arr(data.tcp)) addPort(ports, Number(e.p), String(e.l));
  for (const e of arr(data.udp)) addPort(ports, Number(e.p), `${e.l}/udp`);
  sortPorts(ports);
  const total = Number(data.totalKb ?? 0) / 1024;
  const used = Math.max(0, total - Number(data.freeKb ?? 0) / 1024);
  return {
    procs,
    cpuSeconds,
    ports,
    sys: {
      totalMb: total,
      segments: [{ key: "used", mb: used }],
      usedMb: used,
      ncpu: Number(data.ncpu) || 1,
      swapUsedMb: Number(data.pfUsed ?? 0),
      swapTotalMb: Number(data.pfTotal ?? 0),
      load: null,
      pressure: null,
    },
  };
}

// CPU percent of one core from two samples of cumulative CPU time.
// prev / next: Map<pid, seconds>; elapsed in seconds.
export function cpuFromSamples(prev, next, elapsed) {
  const out = new Map();
  if (!prev || !(elapsed > 0)) return out;
  for (const [pid, now] of next) {
    const before = prev.get(pid);
    if (before === undefined) continue;
    out.set(pid, Math.max(0, ((now - before) / elapsed) * 100));
  }
  return out;
}

// ---------- whole-snapshot assembly (testable without herdr) ----------

function mergePorts(procs, ports) {
  for (const [pid, list] of ports) {
    const p = procs.get(pid);
    if (p) p.ports = list;
  }
}

export const LINUX_MARK = "@@RM@@";

// One shell call; sections split by a marker line. Ports come from ss
// (iproute2), else lsof; other users' sockets need root either way.
export const LINUX_SCRIPT = [
  "getconf CLK_TCK",
  `echo ${LINUX_MARK}; cat /proc/[0-9]*/stat 2>/dev/null`,
  `echo ${LINUX_MARK}; ps -eo pid=,pcpu=,rss=,user:32=,args=`,
  `echo ${LINUX_MARK}; cat /proc/meminfo`,
  `echo ${LINUX_MARK}; cat /proc/loadavg`,
  `echo ${LINUX_MARK}; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN`,
  `echo ${LINUX_MARK}; if command -v ss >/dev/null 2>&1; then echo ss; ss -H -tulnp 2>/dev/null; ` +
    "elif command -v lsof >/dev/null 2>&1; then echo lsof; lsof -nP -iTCP -sTCP:LISTEN -iUDP -F pPn 2>/dev/null; fi",
].join("; ");

// stdout of LINUX_SCRIPT -> { procs, sys, sample }. Pass the previous call's
// `sample` back in as `prev` to get CPU sampled over that interval; without
// it, cpu is ps's lifetime average.
export function assembleLinux(stdout, prev = null, now = Date.now()) {
  const [clk = "", stat = "", ps = "", meminfo = "", loadavg = "", nproc = "", ports = ""] =
    stdout.split(`${LINUX_MARK}\n`);
  const hz = Number(clk.trim()) || 100;
  const seconds = new Map([...parseProcStat(stat)].map(([pid, t]) => [pid, t / hz]));
  const sampled = prev ? cpuFromSamples(prev.secs, seconds, (now - prev.at) / 1000) : null;
  const procs = parsePsLinux(ps);
  if (sampled) for (const p of procs.values()) p.cpu = sampled.get(p.pid) ?? 0;
  const [tool = "", ...rest] = ports.split("\n");
  const body = rest.join("\n");
  mergePorts(procs, tool.trim() === "ss" ? parseSs(body) : tool.trim() === "lsof" ? parseLsof(body) : new Map());
  return {
    procs: [...procs.values()],
    sys: parseSysLinux(meminfo, loadavg, nproc),
    sample: { at: now, secs: seconds },
  };
}

// The PowerShell script's JSON -> { procs, sys, sample }; `prev` as above.
// Without it cpu is 0 (Windows only reports cumulative CPU seconds).
export function assembleWindows(json, prev = null, now = Date.now()) {
  const { procs, cpuSeconds, ports, sys } = parseWindows(json);
  const sampled = prev ? cpuFromSamples(prev.secs, cpuSeconds, (now - prev.at) / 1000) : null;
  if (sampled) for (const p of procs.values()) p.cpu = sampled.get(p.pid) ?? 0;
  mergePorts(procs, ports);
  return { procs: [...procs.values()], sys, sample: { at: now, secs: cpuSeconds } };
}

// lsof + ps + vm_stat + sysctl outputs -> { procs, sys }.
export function assembleMac(ps, lsof, vmStat, sysctl) {
  const procs = parsePsMac(ps);
  mergePorts(procs, parseLsof(lsof));
  return { procs: [...procs.values()], sys: parseSysMac(vmStat, sysctl) };
}
