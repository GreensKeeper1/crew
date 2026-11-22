// [SYNCPARTY-1121] Crew Dance Party client: plays the shared timeline on this phone's own headphones.
// Sync WITHOUT streaming: each track is fetched once (HTTP, Range) and played at position now_alec - t0 - start_of(item).
//   clock "alec"  : offset to Alec from several GET /api/time probes, lowest round trip kept (NTP's idea), re-probed.
//   clock "device": the remote GitHub copy; this phone's own Date.now() (NTP-set by the phone) against schedule.json.
// Drift: every 200 ms compare audio.currentTime with the timeline; past 150 ms seek, else nudge playbackRate (max 5 %).
// Visuals follow the same timeline: the Crayon Crew page is driven frame by frame through its filmFrame(ms) hook
// (deterministic, the same frame the HD film renderer makes), a film <video> is kept within 300 ms.
// window.PARTY exposes the live numbers for tests (test_party_sync.py reads them through DevTools).
(function () {
  "use strict";
  var B = document.body, CLOCK = B.dataset.clock || "alec", STATE_URL = B.dataset.state || "/api/party",
    TIME_URL = B.dataset.time || "/api/time", CRAYON = B.dataset.crayon || "/party/crayon.html";
  var Q = new URLSearchParams(location.search), DJ = Q.get("dj"), SILENCE = B.dataset.silence || "silence.wav";
  var $ = function (id) { return document.getElementById(id); };
  var cid = (function () {
    var k = "partyCid", v = null;
    try { v = localStorage.getItem(k); } catch (e) {}
    if (!v) { v = Math.random().toString(36).slice(2, 10); try { localStorage.setItem(k, v); } catch (e) {} }
    return Q.get("cid") || v;
  })();
  var P = window.PARTY = { clock: CLOCK, cid: cid, offset: 0, rtt: null, samples: [], err: null, errs: [], seeks: 0,
    index: -2, pos: 0, state: null, joined: false, rate: 1, seekLead: 0.05, playLead: 0.05, outLat: 0, vis: "none", frames: 0 };
  try { P.outLat = +(localStorage.getItem("partyOutLat") || 0); } catch (e) {}
  $("lat").value = P.outLat;
  $("lat").addEventListener("change", function () {
    P.outLat = Math.max(0, Math.min(500, +$("lat").value || 0));
    try { localStorage.setItem("partyOutLat", P.outLat); } catch (e) {}
  });

  var local = function () { return performance.timeOrigin + performance.now(); };
  // every control-plane fetch has a deadline: one request that never answered froze a client's whole start-up chain
  // (3-client test, 2026-11-21: joined=false after 60 s)
  function tfetch(url, opt, ms) {
    var ac = window.AbortController ? new AbortController() : null, o = opt || {};
    if (ac) { o.signal = ac.signal; setTimeout(function () { ac.abort(); }, ms || 3000); }
    return fetch(url, o);
  }
  // party time now, as THIS device estimates it. The headphone trim plays the audio that much EARLIER.
  function partyNow() { return CLOCK === "alec" ? local() + P.offset : Date.now(); }

  // ---- clock: NTP-style probes ----------------------------------------------------------------------------------
  // The round trip is read from Resource Timing (requestStart -> responseStart, stamped by the network stack), not from
  // when the promise runs: on a busy page (the crayon canvas) the callback can be 100s of ms late, which inflated the
  // round trip to 402 ms and put the offset 174 ms off in the first 3-client test (measured 2026-11-21).
  function probe() {
    var t0 = local(), url = TIME_URL + "?c=" + cid + "&t=" + Math.round(t0) + Math.random().toString(36).slice(2, 6);
    return tfetch(url, { cache: "no-store" }, 2000)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var t1 = local(), e = performance.getEntriesByName(new URL(url, location.href).href)[0];
        if (e && e.requestStart > 0 && e.responseStart >= e.requestStart) {
          var a = performance.timeOrigin + e.requestStart, b = performance.timeOrigin + e.responseStart;
          return { rtt: b - a, off: j.now_ms - (a + b) / 2, at: t1, rt: true };
        }
        return { rtt: t1 - t0, off: j.now_ms - (t0 + t1) / 2, at: t1, rt: false };
      });
  }
  if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(1000);
  setInterval(function () { if (performance.clearResourceTimings) performance.clearResourceTimings(); }, 60000);
  function syncClock(n) {
    if (CLOCK !== "alec") { P.rtt = 0; return Promise.resolve(); }
    var chain = Promise.resolve();
    for (var i = 0; i < n; i++) {
      chain = chain.then(probe).then(function (s) { P.samples.push(s); }, function () {});
    }
    return chain.then(function () {
      var now = local();
      P.samples = P.samples.filter(function (s) { return now - s.at < 120000; }).slice(-40);
      if (!P.samples.length) return;
      var best = P.samples.reduce(function (a, b) { return b.rtt < a.rtt ? b : a; });
      P.offset = best.off; P.rtt = best.rtt;
    });
  }

  // ---- the playlist state ----------------------------------------------------------------------------------------
  function loadState() {
    return tfetch(STATE_URL + (STATE_URL.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(), { cache: "no-store" }, 4000)
      .then(function (r) { return r.json(); })
      .then(function (s) { if (!P.state || s.rev !== P.state.rev || s.t0_ms !== P.state.t0_ms) P.state = s; })
      .catch(function () {});
  }

  // ---- audio: two elements, the current one and the next one preloading --------------------------------------------
  // Each track is downloaded ONCE, whole, into a Blob and played from memory. Streaming it with Range requests kept
  // up to six connections open per page (one per seek), and the clock probes queued behind them: 310 ms round trips in
  // the 3-client test of 2026-11-21. From a Blob a seek is local and fast, and the network is quiet after the download.
  var players = {};
  function player(url) {
    if (players[url]) return players[url];
    var keep = {}; keep[url] = 1;
    var it = P.state && P.state.items, nx = it && it[(P.index + 1) % it.length];
    if (nx) keep[nx.url] = 1;
    Object.keys(players).forEach(function (u) {
      if (keep[u]) return;
      var o = players[u]; o.pause();
      if (o.__blob) URL.revokeObjectURL(o.__blob);
      o.removeAttribute("src"); o.load(); delete players[u];
    });
    var a = new Audio(); a.preload = "auto"; players[url] = a;
    // On a slow link (the remote copy over hotel Wi-Fi: a 4.3 MB song was still downloading after 30 s, silent) stream
    // after 5 s instead of waiting; a Blob that arrives later is then not swapped in mid-song.
    var slow = setTimeout(function () { if (players[url] === a && !a.__blob) { a.__streaming = true; a.src = url; } }, 5000);
    fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(function (b) {
        clearTimeout(slow);
        if (players[url] !== a || a.__streaming) return;
        a.__blob = URL.createObjectURL(b); a.src = a.__blob; P.loaded = (P.loaded || 0) + 1;
      })
      .catch(function () { clearTimeout(slow); if (players[url] === a) { a.__streaming = true; a.src = url; } });
    return a;
  }
  function stopAllBut(a, keep2) {
    Object.keys(players).forEach(function (u) {
      var p = players[u];
      if (p !== a && !(keep2 && p === keep2 && (p.__armed || p.__startedAt)) && !p.paused) p.pause();
    });
  }

  var lastSeek = 0, prevIdx = -2;
  function tick() {
    if (!P.joined || !P.state) return;
    var items = P.state.items || [];
    var t = PartyTimeline.position(P.state, partyNow() + P.outLat);
    P.index = t.index; P.pos = t.pos_ms;
    if (t.index < 0) {                                       // before t0: preload and count down
      if (items[0]) player(items[0].url);
      stopAllBut(null);
      $("now").textContent = "starting in " + Math.ceil(-t.pos_ms / 1000) + " s";
      return;
    }
    if (t.index >= items.length) { stopAllBut(null); $("now").textContent = "the party is over"; return; }
    var it = items[t.index], a = player(it.url);
    var nx = items[(t.index + 1) % items.length], an = (nx && nx.url !== it.url) ? player(nx.url) : null;
    if (t.index !== prevIdx) { prevIdx = t.index; P.errs = []; lastSeek = local(); showVisual(it); $("now").textContent = "♪ " + it.title + (it.credit ? " · " + it.credit : ""); }
    // Hand-over to the next song: start it from 0 EARLY by this device's learned start latency, so it is heard on the
    // boundary instead of a few hundred ms after it (the 11-21 measurement showed +-280 ms for ~2 s at each change).
    var left = it.dur_ms - t.pos_ms;
    if (an && an.paused && (an.__blob || an.__streaming) && an.readyState >= 1 && left < 450 && !an.__armed) {
      an.__armed = true;
      setTimeout(function () {
        an.currentTime = 0; an.playbackRate = 1;
        var pr = an.play(); if (pr && pr.catch) pr.catch(function () {});
        an.__startedAt = local(); an.__preroll = true; an.__armed = false;
      }, Math.max(0, left - 1000 * P.playLead));
    }
    stopAllBut(a, an);
    if (!a.__blob && !a.__streaming) return;                      // still downloading (or only the unlock clip)
    if (a.readyState < 1) return;                           // no metadata yet
    var target = t.pos_ms / 1000;
    if (target > a.duration - 0.05) return;                 // the tail end: the next item is about to start
    if (a.paused) {
      a.currentTime = target + P.seekLead; a.playbackRate = 1;
      // only a refusal to autoplay needs the tap again; an AbortError (play() interrupted by our own seek, src swap
      // or pause) is routine - treating it as "not joined" froze a client for good in the 3-client test of 11-21
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function (e) {
        if (e && e.name === "NotAllowedError") { P.joined = false; $("join").hidden = false; }
      });
      lastSeek = local(); a.__startedAt = local(); P.seeks++; P.errs = []; return;
    }
    var err = a.currentTime - target; P.err = err * 1000;
    if (a.__startedAt && local() - a.__startedAt > 700) {
      // learn this device's start latency from the first settled reading after a start (seek + play)
      // (a start from 0 at a song change and a mid-song seek have different latencies, so each learns its own lead)
      if (Math.abs(err) < 0.6) {
        if (a.__preroll) P.playLead = Math.max(0, Math.min(0.5, P.playLead - err * 0.7));
        else P.seekLead = Math.max(0, Math.min(0.5, P.seekLead - err * 0.7));
      }
      a.__startedAt = 0; a.__preroll = false;
    }
    if (local() - lastSeek > 600) { P.errs.push(P.err); if (P.errs.length > 50) P.errs.shift(); }
    // decide on the median of the last 3 settled readings, not one: on a busy device single readings of
    // currentTime jumped by up to a second and made the corrector hunt (11-21, LT at 100 % CPU)
    if (P.errs.length < 3) return;
    err = median(P.errs.slice(-3)) / 1000;
    if (Math.abs(err) > 0.15 && local() - lastSeek > 1500) {
      // seek, and learn how late this device's seeks land so the next one aims ahead by that much
      if (local() - lastSeek < 6000) P.seekLead = Math.max(0, Math.min(0.4, P.seekLead - err * 0.5));
      a.currentTime = target + P.seekLead; a.playbackRate = 1; lastSeek = local(); P.seeks++; P.errs = [];
    } else if (Math.abs(err) > 0.012) {
      P.rate = Math.max(0.95, Math.min(1.05, 1 - err * 0.5)); a.playbackRate = P.rate;
    } else if (P.rate !== 1) { P.rate = 1; a.playbackRate = 1; }
  }

  // ---- visuals on the same timeline -------------------------------------------------------------------------------
  var crayon = $("crayon"), film = $("film"), card = $("card");
  function showVisual(it) {
    P.vis = it.visual || "none";
    crayon.hidden = P.vis !== "crayon"; film.hidden = P.vis !== "film"; card.hidden = P.vis !== "none";
    if (P.vis === "crayon") {
      var src = CRAYON + "?film" + (it.danceoff === false ? "" : "&danceoff") + "&bpm=" + (it.bpm || 96);
      if (crayon.getAttribute("src") !== src) crayon.setAttribute("src", src);
    } else if (P.vis === "film" && it.film && film.getAttribute("src") !== it.film) {
      film.setAttribute("src", it.film);
    }
    $("cardTitle").textContent = it.title; $("cardSub").textContent = it.credit || "";
  }
  var lastFrame = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (!P.state || P.index < 0 || ts - lastFrame < 33) return;   // 30 fps is plenty for crayons, and saves phones
    lastFrame = ts;
    var t = PartyTimeline.position(P.state, partyNow());      // the picture is not delayed by headphones
    if (P.vis === "crayon") {
      var w = crayon.contentWindow;
      if (w && typeof w.filmFrame === "function") { w.filmFrame(t.pos_ms); P.frames++; }
    } else if (P.vis === "film" && film.readyState >= 1) {
      var d = film.currentTime - t.pos_ms / 1000;
      if (Math.abs(d) > 0.3) film.currentTime = t.pos_ms / 1000;
      if (film.paused) { var pr = film.play(); if (pr && pr.catch) pr.catch(function () {}); }
    }
  }

  // ---- status, reports, DJ ---------------------------------------------------------------------------------------
  function median(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }); return s[s.length >> 1]; }
  function status() {
    var m = median(P.errs), sync = $("sync");
    var clk = CLOCK === "alec" ? ("Alec's clock ±" + (P.rtt == null ? "?" : Math.round(P.rtt / 2)) + " ms")
                               : "this phone's clock";
    sync.textContent = clk + " · in step " + (m == null ? "…" : (m >= 0 ? "+" : "") + Math.round(m) + " ms") +
      " · seeks " + P.seeks + (P.rate !== 1 ? " · rate " + P.rate.toFixed(3) : "");
    if (CLOCK === "alec" && P.joined && m != null) {
      var abs = P.errs.map(Math.abs).sort(function (x, y) { return x - y; });
      fetch("/api/party/report", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cid: cid, err_ms: Math.round(m * 10) / 10, rtt_ms: P.rtt && Math.round(P.rtt * 10) / 10,
          offset_ms: Math.round(P.offset), item: P.index, rate: P.rate, seeks: P.seeks, out_lat_ms: P.outLat,
          abs_err_p95_ms: Math.round(abs[Math.floor(abs.length * 0.95)] || 0), ua: navigator.userAgent.slice(0, 60) }) })
        .catch(function () {});
    }
  }
  function dj(path) {
    fetch("/api/party/" + path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: DJ }) }).then(loadState);
  }
  if (DJ && CLOCK === "alec") {
    $("dj-skip").hidden = false; $("dj-restart").hidden = false;
    $("dj-skip").onclick = function () { dj("skip"); }; $("dj-restart").onclick = function () { dj("restart"); };
  }

  // ---- join (iPhone Safari will not start sound without one tap) -------------------------------------------------
  function join() {
    $("join").hidden = true; P.joined = true;
    var items = (P.state && P.state.items) || [];
    // bless an element for each of the first two tracks inside the tap, then hand them to the timeline
    // (an element still waiting for its Blob gets a 0.1 s silent clip so the tap can unlock it; iOS keeps the unlock
    //  when the src is swapped later)
    items.slice(0, 2).forEach(function (it) {
      var a = player(it.url);
      if (!a.getAttribute("src")) a.src = SILENCE;
      var pr = a.play();
      if (pr && pr.then) pr.then(function () { a.pause(); }, function () {});
    });
    tick();
  }
  $("joinBtn").addEventListener("click", join);
  $("joinNet").textContent = CLOCK === "alec" ? ("served by Alec at " + location.host + " (local network, no internet)")
                                              : "remote copy: synced by this phone's clock";

  syncClock(8).then(loadState).then(function () {
    if (Q.has("autojoin")) join();                          // test hook: headless Chrome / the APK's WebView
    setInterval(tick, 200);
    setInterval(function () { syncClock(3); }, 15000);
    setInterval(loadState, 5000);
    setInterval(status, 2000);
    requestAnimationFrame(frame);
  });
})();
