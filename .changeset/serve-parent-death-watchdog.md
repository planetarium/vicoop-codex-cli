---
"vicoop-codex-cli": patch
---

serve: self-terminate when the parent process dies (orphan watchdog)

Under the bridge, `vicoop-client` spawns `vicoop-codex serve` as a child
without `detached`, and several of the client's exit paths (a fatal WS close,
an uncaughtException, SIGKILL) tear the client down without signaling the
child. Node delivers no signal to a child when its parent dies, so an orphaned
`serve` kept LISTENing forever — a leaked ephemeral port and a stale process
that accumulated one generation per client restart.

`serve` now polls `process.ppid` and shuts itself down once the parent it was
spawned under goes away (reparented to init / a subreaper). Direct runs (a TTY,
or a real supervisor as pid 1) start with ppid 1 and are left untouched. Also
handles SIGHUP as a graceful stop. Disable with
`VICOOP_CODEX_SERVE_PARENT_WATCH=0`; tune the poll with
`VICOOP_CODEX_SERVE_PARENT_WATCH_MS` (default 5000).

Note: this intentionally overrides the ad-hoc `nohup vicoop-codex serve &` /
`disown` idiom (which blocks SIGHUP but not reparenting). Proper daemonization
(`setsid`/systemd/launchd/docker as pid 1) starts with ppid 1 and is unaffected
by the `ppid <= 1` guard; standalone background users can set
`VICOOP_CODEX_SERVE_PARENT_WATCH=0`.
