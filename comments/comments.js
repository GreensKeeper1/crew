/* Crew Films comments and optional sign-up.
 *
 * Adds a "Comments" button to every movie, trailer and poster on movies.html.
 * Anyone can read comments. Leaving one needs a free sign-up: email address as
 * the user name and a 6-digit code the viewer picks. A cookie remembers the
 * viewer, so they don't retype the code on that device.
 *
 * Two backends speak the same little JSON API (POST {op, ...}):
 *   - server/crew_server.py on the home LAN (works with no Internet), found at ./api
 *   - server/apps_script/Code.gs online, at CREW_COMMENTS.ONLINE_API
 * The page tries the LAN server first, then the online one. With neither,
 * the buttons stay hidden and the page works exactly as before.
 *
 * The page needs only these lines before </body>:
 *   <link rel="stylesheet" href="comments/comments.css">
 *   <script src="comments/config.js"></script>
 *   <script src="comments/comments.js" defer></script>
 */
(() => {
  "use strict";
  const CFG = window.CREW_COMMENTS || {};
  const COOKIE = "crew_token";
  let API = null, LOCAL = false, me = null, counts = {};

  // ---------- small helpers ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k) e.append(k);
    return e;
  };
  const getCookie = () => {
    const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([a-f0-9]{64})"));
    return m ? m[1] : "";
  };
  const setCookie = (tok) => {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = tok
      ? `${COOKIE}=${tok}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`
      : `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
  };
  const timeout = (ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };
  async function api(op, data = {}) {
    const tok = getCookie();
    const body = JSON.stringify(Object.assign({ op }, tok ? { token: tok } : {}, data));
    // text/plain keeps it a "simple" request, which Apps Script needs (no CORS preflight).
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, signal: timeout(15000) });
    let j;
    try { j = await r.json(); } catch (e) { throw new Error("The comment service didn't answer properly."); }
    if (!j.ok) throw new Error(j.error || "Something went wrong.");
    return j;
  }

  // ---------- find the things people can comment on ----------
  function findItems() {
    const items = [];
    document.querySelectorAll("article.card[id]").forEach((a) => {
      const kind = a.id.startsWith("m-") ? "Movie" : a.id.startsWith("t-") ? "Trailer" : "";
      if (!kind) return;
      const h = $("h3", a);
      items.push({ id: a.id, title: h ? h.textContent : a.id, kind, mount: $("p", a) || a });
    });
    const posterId = (href) => "p-" + href.split("/").pop().replace(/\.[a-z0-9]+$/i, "");
    document.querySelectorAll(".posters a.poster[href]").forEach((a) => {
      const wrap = el("div", { class: "ccw-poster" });
      a.replaceWith(wrap);
      wrap.append(a);
      const s = $("span", a);
      items.push({ id: posterId(a.getAttribute("href")), title: s ? s.textContent : "", kind: "Poster", mount: wrap });
    });
    document.querySelectorAll("#rail .rp").forEach((f) => {
      const a = $("a[href]", f), c = $("figcaption", f);
      if (!a) return;
      items.push({ id: posterId(a.getAttribute("href")), title: c ? c.textContent : "", kind: "Poster", mount: $("p", f) || f });
    });
    return items.filter((i) => /^[a-z0-9][a-z0-9-]{0,99}$/.test(i.id));
  }

  // ---------- the dialog ----------
  let dlg, head, list, foot, current = null;
  function buildDialog() {
    dlg = el("dialog", { id: "ccw", "aria-label": "Comments" });
    head = el("div", { class: "ccw-head" });
    list = el("div", { class: "ccw-list", "aria-live": "polite" });
    foot = el("div", { class: "ccw-foot" });
    const close = el("button", { class: "ccw-x", type: "button", "aria-label": "Close", text: "×", onclick: () => dlg.close() });
    dlg.append(close, head, list, foot);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
  }

  function renderComments(rows) {
    list.replaceChildren();
    if (!rows.length) { list.append(el("p", { class: "ccw-empty", text: "No comments yet. Be the first." })); return; }
    for (const c of rows) {
      const when = new Date(c.at);
      list.append(el("div", { class: "ccw-c" },
        el("div", { class: "ccw-meta" },
          el("b", { text: c.name || "Viewer" }),
          el("span", { text: isNaN(when) ? "" : when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) }),
          c.pending ? el("span", { class: "ccw-pend", text: "waiting to go online" }) : null),
        el("p", { text: c.text })));
    }
  }

  function note(text, bad) {
    const n = el("p", { class: "ccw-note" + (bad ? " bad" : ""), text });
    $(".ccw-note", foot)?.remove();
    foot.prepend(n);
  }

  function renderFoot() {
    foot.replaceChildren();
    if (me) {
      const ta = el("textarea", { maxlength: "1000", rows: "3", placeholder: "Say something about it", "aria-label": "Your comment", required: "" });
      const form = el("form", { class: "ccw-form", onsubmit: async (e) => {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) return;
        btn.disabled = true;
        try {
          await api("post", { item: current.id, text });
          ta.value = "";
          counts[current.id] = (counts[current.id] || 0) + 1;
          paintCount(current.id);
          await loadComments();
        } catch (err) { note(err.message, true); if (/sign in/i.test(err.message)) { me = null; setCookie(""); renderFoot(); } }
        btn.disabled = false;
      } });
      const btn = el("button", { class: "btn", type: "submit", text: "Post" });
      form.append(ta, el("div", { class: "ccw-row" },
        el("span", { class: "ccw-who", text: "Signed in as " + me.name }),
        el("button", { class: "ccw-link", type: "button", text: "Sign out", onclick: signOut }), btn));
      foot.append(form);
    } else {
      foot.append(el("div", { class: "ccw-row" },
        el("span", { class: "ccw-who", text: "Sign up free to leave a comment." }),
        el("button", { class: "btn", type: "button", text: "Sign up or sign in", onclick: renderSignIn })));
    }
    if (LOCAL) foot.append(el("p", { class: "ccw-small", text: "You're on the show's own network. Comments are kept here and go online when it next has Internet." }));
  }

  function renderSignIn() {
    foot.replaceChildren();
    let mode = "register";
    const email = el("input", { type: "email", autocomplete: "username", required: "", maxlength: "254", placeholder: "you@example.com" });
    const name = el("input", { type: "text", autocomplete: "nickname", maxlength: "40", placeholder: "Shown with your comments" });
    const code = el("input", { type: "password", inputmode: "numeric", autocomplete: "current-password", pattern: "[0-9]{6}", minlength: "6", maxlength: "6", required: "", placeholder: "6 digits" });
    const nameRow = el("label", {}, "Name", name);
    const title = el("b", { text: "Sign up to comment" });
    const swap = el("button", { class: "ccw-link", type: "button", text: "Already signed up? Sign in", onclick: () => {
      mode = mode === "register" ? "login" : "register";
      title.textContent = mode === "register" ? "Sign up to comment" : "Sign in";
      swap.textContent = mode === "register" ? "Already signed up? Sign in" : "New here? Sign up";
      nameRow.hidden = mode === "login";
      code.autocomplete = mode === "register" ? "new-password" : "current-password";
      go.textContent = mode === "register" ? "Sign up" : "Sign in";
    } });
    code.autocomplete = "new-password";
    const go = el("button", { class: "btn", type: "submit", text: "Sign up" });
    const form = el("form", { class: "ccw-form ccw-auth", onsubmit: async (e) => {
      e.preventDefault();
      if (!/^\d{6}$/.test(code.value)) { note("The code is exactly 6 digits.", true); return; }
      go.disabled = true;
      try {
        const r = await api(mode, { email: email.value.trim(), code: code.value, name: name.value.trim() });
        setCookie(r.token);
        me = { name: r.name };
        renderFoot();
      } catch (err) { note(err.message, true); }
      go.disabled = false;
    } });
    form.append(title,
      el("label", {}, "Email", email), nameRow,
      el("label", {}, "Your 6-digit code", code),
      el("p", { class: "ccw-small", text: "Pick any 6 digits you'll remember. It's a light lock for comments only, so don't reuse a bank PIN." }),
      el("div", { class: "ccw-row" }, swap, go),
      el("details", { class: "ccw-small" }, el("summary", { text: "What happens to my email" }),
        el("p", { text: "Your email is only used to recognise you and to let the site owner know someone signed up. It is never shown to other viewers or shared. Your code is stored scrambled, never as typed. A cookie on this device keeps you signed in for a year; Sign out removes it. Ask the site owner to delete your sign-up and comments at any time." })));
    foot.append(form);
    email.focus();
  }

  async function signOut() {
    try { await api("logout"); } catch (e) { /* signing out locally is enough */ }
    setCookie("");
    me = null;
    renderFoot();
  }

  async function loadComments() {
    const id = current.id;
    try {
      const r = await api("comments", { item: id });
      if (current && current.id === id) renderComments(r.comments || []);
    } catch (err) {
      list.replaceChildren(el("p", { class: "ccw-empty bad", text: "Couldn't load comments: " + err.message }));
    }
  }

  function open(item) {
    current = item;
    head.replaceChildren(el("span", { class: "ccw-kind", text: item.kind }), el("h3", { text: item.title }));
    list.replaceChildren(el("p", { class: "ccw-empty", text: "Loading…" }));
    renderFoot();
    if (!dlg.open) dlg.showModal();
    loadComments();
  }

  // ---------- buttons and counts ----------
  const buttons = {};
  function paintCount(id) {
    const n = counts[id] || 0;
    (buttons[id] || []).forEach((b) => { b.textContent = n ? `Comments (${n})` : "Comment"; });
  }

  async function findBackend() {
    try {
      const r = await fetch("api/health", { signal: timeout(1500), cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (j && j.ok && j.crew) { API = "api"; LOCAL = true; return true; } }
    } catch (e) { /* not on the home server */ }
    if (CFG.ONLINE_API && /^https:\/\//.test(CFG.ONLINE_API)) { API = CFG.ONLINE_API; return true; }
    return false;
  }

  async function start() {
    if (!(await findBackend())) return; // no service configured: page stays as it was
    buildDialog();
    const items = findItems();
    for (const it of items) {
      const b = el("button", { class: "btn ghost ccw-btn", type: "button", text: "Comment", onclick: (e) => { e.preventDefault(); e.stopPropagation(); open(it); } });
      it.mount.append(" ", b);
      (buttons[it.id] = buttons[it.id] || []).push(b);
    }
    try { counts = (await api("counts")).counts || {}; Object.keys(buttons).forEach(paintCount); } catch (e) { /* counts are a nicety */ }
    if (getCookie()) {
      try { me = { name: (await api("me")).name }; } catch (e) { setCookie(""); }
    }
    // Deep link: movies.html#comments-m-my-bad opens that item's comments.
    const m = location.hash.match(/^#comments-([a-z0-9-]+)$/);
    if (m) { const it = items.find((i) => i.id === m[1]); if (it) open(it); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
