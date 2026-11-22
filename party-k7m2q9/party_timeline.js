// [SYNCPARTY-1121] The party timeline: which item is playing, and how far in, at party time `now` (ms).
// ONE browser implementation, shared by the LAN party (Alec) and the remote GitHub copy. test_party.py runs it under
// node and asserts it agrees with party.py Party.position() at the same instants (the cross-surface check).
(function (root) {
  function position(state, now) {
    var items = state.items || [], e = now - state.t0_ms, tot = 0, k;
    for (k = 0; k < items.length; k++) tot += items[k].dur_ms;
    if (e < 0 || !items.length) return { index: -1, pos_ms: e };
    if (state.loop !== false) e = e % tot;
    else if (e >= tot) return { index: items.length, pos_ms: 0 };
    for (k = 0; k < items.length; k++) {
      if (e < items[k].dur_ms) return { index: k, pos_ms: e };
      e -= items[k].dur_ms;
    }
    return { index: items.length - 1, pos_ms: items[items.length - 1].dur_ms };
  }
  var api = { position: position };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PartyTimeline = api;
})(this);
