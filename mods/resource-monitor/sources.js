// Runs each platform's commands; parse.js turns their output into
// { procs: Process[], sys: System }.

import { exec, home, window as herdrWindow } from "herdr";
import { LINUX_SCRIPT, assembleLinux, assembleWindows, assembleMac } from "./parse.js";

export function platform() {
  const p = herdrWindow()?.platform;
  if (p) return p;
  const h = home() ?? "";
  if (/^[A-Za-z]:[\\/]/.test(h)) return "windows";
  if (h.startsWith("/Users/")) return "macos";
  return "linux";
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$p = @(Get-Process | ForEach-Object { [pscustomobject]@{ i = $_.Id; n = $_.ProcessName; m = $_.WorkingSet64; c = $_.TotalProcessorTime.TotalSeconds; f = $_.Path } })
$t = @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ p = $_.OwningProcess; l = $_.LocalPort } })
$u = @(Get-NetUDPEndpoint | ForEach-Object { [pscustomobject]@{ p = $_.OwningProcess; l = $_.LocalPort } })
$os = Get-CimInstance Win32_OperatingSystem
$pf = @(Get-CimInstance Win32_PageFileUsage)
[pscustomobject]@{
  procs = $p; tcp = $t; udp = $u
  totalKb = $os.TotalVisibleMemorySize; freeKb = $os.FreePhysicalMemory
  pfTotal = ($pf | Measure-Object AllocatedBaseSize -Sum).Sum
  pfUsed = ($pf | Measure-Object CurrentUsage -Sum).Sum
  ncpu = [Environment]::ProcessorCount
} | ConvertTo-Json -Compress -Depth 3
`;

async function collectMac() {
  const [ps, lsof, vm, sysctl] = await Promise.all([
    exec("ps", ["-axo", "pid=,pcpu=,rss=,user=,comm="]),
    exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-iUDP", "-F", "pPn"]).catch(() => ({ stdout: "" })),
    exec("vm_stat"),
    exec("sysctl", ["-n", "hw.memsize", "hw.ncpu", "vm.swapusage", "vm.loadavg", "kern.memorystatus_level"]),
  ]);
  return assembleMac(ps.stdout, lsof.stdout, vm.stdout, sysctl.stdout);
}

// Linux and Windows sample CPU between calls, so each collector keeps the
// previous sample.
function sampled(run, assemble) {
  let prev = null;
  return async () => {
    const r = await run();
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    const out = assemble(r.stdout, prev);
    prev = out.sample;
    return out;
  };
}

export function makeCollector(os = platform()) {
  if (os === "windows") {
    return sampled(
      () => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT]),
      assembleWindows,
    );
  }
  if (os === "linux") return sampled(() => exec("sh", ["-c", LINUX_SCRIPT]), assembleLinux);
  return collectMac;
}

// signal: "TERM" (ask it to quit) or "KILL" (force). Resolves { code, stderr }.
export async function killProcess(pid, signal, os = platform()) {
  if (os === "windows") {
    const args = ["/PID", String(pid)];
    if (signal === "KILL") args.push("/F");
    return exec("taskkill", args);
  }
  return exec("kill", [`-${signal}`, String(pid)]);
}
