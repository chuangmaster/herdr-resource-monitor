# Changelog

## 0.1.1 — 2026-11-14

- Terminate / Force kill on a process that already exited now says so
  instead of showing an error, and always refreshes the list afterwards.
- A refresh that takes longer than 8 s is abandoned with an error, so a hung
  `ps` or `lsof` no longer freezes the list on stale rows.
- Tests now run on Windows CI.

## 0.1.0 — 2026-11-13

First public release.

- CPU (with load average), memory breakdown, swap and memory pressure.
- Process list with listening ports; search by name, PID or `:port`.
- Sort by CPU, memory or port; "With ports only" filter.
- Terminate and Force kill.
- macOS, Linux and Windows (Windows parsers are tested against hand-written
  fixtures only).
- English and 繁體中文; refresh interval 1–30 s or paused.
