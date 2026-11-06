// Parser tests: node --test tests/
// macOS and Linux fixtures are real command output (Linux from a Debian
// container running postgres and a `yes` CPU burner); the Windows JSON is
// hand-written in the shape the PowerShell script prints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  basename, nameFromArgs, parsePsMac, parseLsof, parseSysMac,
  parsePsLinux, parseProcStat, parseSs, parseSysLinux,
  assembleLinux, assembleWindows, assembleMac, cpuFromSamples,
} from "../mods/resource-monitor/parse.js";

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("nameFromArgs should take the executable's base name", () => {
  assert.equal(nameFromArgs("/usr/bin/node server.js"), "node");
  assert.equal(nameFromArgs("postgres: checkpointer "), "postgres");
  assert.equal(nameFromArgs("[kthreadd]"), "[kthreadd]");
});

test("basename should handle both path separators", () => {
  assert.equal(basename("/usr/libexec/logd"), "logd");
  assert.equal(basename("C:\\Program Files\\nodejs\\node.exe"), "node.exe");
});

test("macOS: ps rows parse with full path as command", () => {
  const procs = parsePsMac(fx("macos-ps.txt"));
  const launchd = procs.get(1);
  assert.ok(launchd);
  assert.equal(launchd.name, "launchd");
  assert.equal(launchd.command, "/sbin/launchd");
  assert.equal(launchd.user, "root");
  assert.ok(launchd.memMb > 0);
});

test("macOS: lsof gives listening ports per pid", () => {
  const ports = parseLsof(fx("macos-lsof.txt"));
  assert.ok(ports.size > 0);
  for (const list of ports.values()) for (const p of list) assert.match(p, /^\d+(\/udp)?$/);
});

test("macOS: memory adds up like Activity Monitor", () => {
  const sys = parseSysMac(fx("macos-vm_stat.txt"), fx("macos-sysctl.txt"));
  assert.ok(sys.totalMb > 1000);
  assert.ok(sys.ncpu >= 1);
  assert.deepEqual(sys.segments.map((s) => s.key), ["app", "wired", "compressed", "cached"]);
  const used = sys.segments.filter((s) => s.key !== "cached").reduce((a, s) => a + s.mb, 0);
  assert.ok(Math.abs(used - sys.usedMb) < 0.01);
  assert.ok(sys.usedMb <= sys.totalMb);
  assert.ok(sys.pressure === null || (sys.pressure >= 0 && sys.pressure <= 100));
  assert.match(sys.load, /^[\d.]+ [\d.]+ [\d.]+$/);
});

test("macOS: assembleMac attaches ports to processes", () => {
  const { procs, sys } = assembleMac(fx("macos-ps.txt"), fx("macos-lsof.txt"), fx("macos-vm_stat.txt"), fx("macos-sysctl.txt"));
  assert.ok(procs.length > 0);
  assert.ok(sys.totalMb > 0);
});

test("Linux: ps, ss and lsof parse", () => {
  const procs = parsePsLinux(fx("linux-ps.txt"));
  assert.equal(procs.get(8).name, "postgres");
  assert.equal(procs.get(72).name, "postgres");
  assert.equal(procs.get(72).command, "postgres: checkpointer");
  assert.deepEqual(parseSs(fx("linux-ss.txt")).get(8), ["5432"]);
  assert.deepEqual(parseLsof(fx("linux-lsof.txt")).get(8), ["5432"]);
});

test("Linux: /proc/meminfo gives used and cached", () => {
  const sys = parseSysLinux(fx("linux-meminfo.txt"), fx("linux-loadavg.txt"), "4\n");
  assert.equal(Math.round(sys.totalMb), Math.round(8126480 / 1024));
  assert.equal(Math.round(sys.usedMb), Math.round((8126480 - 7207212) / 1024));
  assert.equal(sys.ncpu, 4);
  assert.equal(sys.pressure, null);
  assert.ok(sys.segments.reduce((a, s) => a + s.mb, 0) <= sys.totalMb + 0.01);
});

test("Linux: /proc/<pid>/stat handles names with spaces and parens", () => {
  const line = "123 (Web (Content) x) S 1 123 123 0 -1 4194304 100 0 0 0 250 50 0 0 20 0 1 0 1000 0 0";
  assert.equal(parseProcStat(line).get(123), 300);
});

test("Linux: the real script's output samples CPU between two calls", () => {
  const first = assembleLinux(fx("linux-script-1.txt"), null, 0);
  const second = assembleLinux(fx("linux-script-2.txt"), first.sample, 2000);
  const yes = second.procs.find((p) => p.name === "yes");
  assert.ok(yes, "yes is listed");
  assert.ok(yes.cpu > 70 && yes.cpu < 130, `yes uses about one core, got ${yes.cpu}`);
  const pg = second.procs.find((p) => p.pid === 8);
  assert.deepEqual(pg.ports, ["5432"]);
  assert.ok(second.sys.totalMb > 0 && second.sys.ncpu >= 1);
  assert.match(second.sys.load, /^[\d.]+ [\d.]+ [\d.]+$/);
});

test("Windows: JSON assembles ports, memory and sampled CPU", () => {
  const first = assembleWindows(fx("windows-1.json"), null, 0);
  assert.equal(first.procs.find((p) => p.pid === 1234).cpu, 0);
  const second = assembleWindows(fx("windows-2.json"), first.sample, 1000);
  const node = second.procs.find((p) => p.pid === 1234);
  assert.equal(node.name, "node.exe");
  assert.equal(node.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(node.ports, ["3000", "5173", "5353/udp"]);
  assert.equal(Math.round(node.cpu), 150);
  assert.equal(Math.round(node.memMb), 100);
  assert.equal(second.sys.totalMb, 16384);
  assert.equal(second.sys.usedMb, 12288);
  assert.equal(second.sys.swapTotalMb, 4096);
  assert.equal(second.sys.load, null);
});

test("cpuFromSamples skips processes that started between samples", () => {
  const out = cpuFromSamples(new Map([[1, 10]]), new Map([[1, 11], [2, 5]]), 2);
  assert.equal(out.get(1), 50);
  assert.equal(out.has(2), false);
});
