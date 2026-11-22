# Real-browser integration tests

Run `npm run build`, then `npm run test:browser`. The browser test command uses
`reslop t -- node --test browser/rtc.integration.js`, which saves its reduced
report and raw output under `.log/`. These tests are outside ordinary Node unit
test discovery and do not run with `npm t`.

Install Google Chrome separately. The default executable is
`/usr/bin/google-chrome`; set `CHROME_BIN` to select another compatible Chromium
executable. The harness uses Node's built-in WebSocket client and Chrome's
DevTools protocol, with no browser automation dependency. It creates a temporary
profile, launches headless Chrome with `--no-sandbox` for container execution,
and closes pages, unregisters service workers, stops the browser/server, and
removes the temporary profile after testing. Run it only with trusted fixtures.
Child processes, local listening sockets, and browser launches must be permitted
by the execution environment.

Coverage includes separate tabs and windows, both offer roles, concurrent peers,
large JSON fragmentation, RPC success/errors, events, byte-identical streams,
and a real service worker using an explicitly authorized owner-tab bridge.
Lifecycle checks terminate the application's worker through DevTools, replace
its controller, close the owner, and attach a fresh owner connection.

The relay test sends canvas video and an oscillator tone across three tabs
using two six-slot links. The relay plays the original incoming audio track in
an unmuted element with `volume = 0` and forwards that track. The receiving tab
uses native playback and checks rising audio packet counts and energy, a
positive audio level, and decoded video frames. It repeats the checks after
reopening the relay link, then verifies that clearing both slots stops the
packets while the upstream link keeps delivering media. The Chrome launcher
allows autoplay and mutes the browser's audio output.

Verified on 2026-11-12 with Chrome 157.0.8103.50 on Linux. The successful report
is `.log/2026-11-12-node-20.raw` (ten tests, zero failures, including the runnable
examples and explicit-origin popup signaling adapter). Firefox, Safari,
and remote STUN/TURN paths were not tested by this harness; the local tests use
host ICE candidates and no external signaling or ICE servers.
