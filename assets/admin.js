/* Loopline Admin JS — vanilla, event-delegation, no build.
   Depends on: window.LP (from sb.js, loaded before this file). */
(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────────────
  const S = {
    ws: null,          // selected workspace object
    boards: [],        // loop_boards for current ws
    posts: [],         // inbox posts (current filter)
    allPosts: [],      // all posts for current ws (for merge search / changelog link)
    expandedPostId: null,
    mergeFrom: null,
    mergeInto: null,
    clEntry: null,     // changelog entry being edited
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = LP.esc;

  let toastTimer;
  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.style.background = isError ? "var(--danger)" : "var(--ink)";
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function friendlyError(err) {
    if (!err) return "An unknown error occurred.";
    const msg = err.message || String(err);
    if (msg.includes("not_authorized") || msg.includes("Unauthorized") || msg.includes("JWT")) return "You don't have access to this workspace.";
    if (msg.includes("declined_requires_reason") || msg.includes("reason")) return "A reason is required when declining a post.";
    if (msg.includes("not found") || msg.includes("not_found")) return "The requested item was not found.";
    if (msg.includes("already exists") || msg.includes("duplicate")) return "This item already exists — try a different slug or name.";
    if (msg.includes("cannot merge into itself")) return "A post cannot be merged into itself.";
    if (msg.includes("network") || msg.includes("fetch") || msg.includes("Failed to fetch")) return "Network error — check your connection and try again.";
    if (msg.length > 120) return "Something went wrong. Please try again.";
    return msg;
  }

  function statusBadge(status) {
    const s = LP.STATUS[status] || { label: status, color: "#8a93a6" };
    return `<span class="badge pill-status" style="background:${esc(s.color)}">${esc(s.label)}</span>`;
  }

  function slugify(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function show(id) { const el = document.getElementById(id); if (el) el.classList.remove("hide"); }
  function hide(id) { const el = document.getElementById(id); if (el) el.classList.add("hide"); }

  // ── Auth gate ──────────────────────────────────────────────────────────────
  let authMode = "signin"; // or "signup"

  function setAuthMode(mode) {
    authMode = mode;
    const isSignup = mode === "signup";
    $("#auth-title").textContent = isSignup ? "Create your account" : "Welcome back";
    $("#auth-sub").textContent = isSignup ? "Start triaging feedback in minutes." : "Sign in to your admin dashboard.";
    $("#auth-btn").textContent = isSignup ? "Create account" : "Sign in";
    $("#auth-toggle-text").textContent = isSignup ? "Already have an account?" : "Don't have an account?";
    $("#auth-toggle-btn").textContent = isSignup ? "Sign in" : "Create account";
    $("#auth-password").autocomplete = isSignup ? "new-password" : "current-password";
    setAuthError("");
  }

  function setAuthError(msg) {
    const el = $("#auth-error");
    if (msg) { el.textContent = msg; el.classList.remove("hide"); }
    else el.classList.add("hide");
  }

  $("#auth-toggle-btn").addEventListener("click", () => {
    setAuthMode(authMode === "signin" ? "signup" : "signin");
  });

  // Deep-link: land cold traffic on Create-account when ?signup=1 or #create is present
  // (e.g. the "Start free" CTAs on the landing page). Default stays sign-in.
  (function applyAuthDeepLink() {
    const wantsSignup =
      new URLSearchParams(location.search).get("signup") === "1" ||
      location.hash === "#create";
    if (wantsSignup) setAuthMode("signup");
  })();

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    if (!email || !password) { setAuthError("Email and password are required."); return; }
    const btn = $("#auth-btn");
    btn.disabled = true;
    btn.textContent = authMode === "signin" ? "Signing in…" : "Creating account…";
    setAuthError("");
    try {
      let result;
      if (authMode === "signin") {
        result = await LP.auth.signInPassword(email, password);
      } else {
        result = await LP.auth.signUp(email, password);
      }
      if (result.error) throw result.error;
      // onAuthStateChange will fire next
    } catch (err) {
      setAuthError(friendlyError(err));
      btn.disabled = false;
      btn.textContent = authMode === "signin" ? "Sign in" : "Create account";
    }
  });

  // ── Workspace gate ─────────────────────────────────────────────────────────
  async function loadWorkspaces(user) {
    hide("auth-gate");
    show("ws-gate");
    hide("app");
    const listEl = $("#ws-list");
    listEl.innerHTML = `<div class="skel skel-row" aria-label="Loading workspaces…"></div>`;

    try {
      const wsList = await LP.myWorkspaces();
      if (wsList.length === 0) {
        listEl.innerHTML = "";
        show("ws-create-wrap");
        return;
      }
      hide("ws-create-wrap");
      if (wsList.length === 1) {
        selectWorkspace(wsList[0]);
        return;
      }
      // Multiple workspaces — show picker
      listEl.innerHTML = wsList.map((ws) => `
        <div class="ws-option" role="listitem" tabindex="0" data-ws-id="${esc(ws.id)}" aria-label="Select workspace ${esc(ws.name)}">
          <div class="ws-icon">${esc(ws.name.charAt(0).toUpperCase())}</div>
          <div class="ws-info">
            <strong>${esc(ws.name)}</strong>
            <span>${esc(ws.slug)} · ${esc(ws.role || "admin")}</span>
          </div>
        </div>`).join("");
    } catch (err) {
      listEl.innerHTML = `<p style="color:var(--danger);font-size:14px;">${esc(friendlyError(err))}</p>`;
    }
  }

  // Delegate workspace option clicks + keyboard
  $("#ws-list").addEventListener("click", (e) => {
    const opt = e.target.closest(".ws-option");
    if (!opt) return;
    const wsId = opt.dataset.wsId;
    // Find ws from DOM + stored data
    const allWs = Array.from($$(".ws-option")).map((o) => ({ id: o.dataset.wsId, name: o.querySelector("strong").textContent }));
    // We'll just trigger a re-fetch by ID. But we stored wsList only during render —
    // easier to re-fetch myWorkspaces and filter.
    LP.myWorkspaces().then((wsList) => {
      const ws = wsList.find((w) => w.id === wsId);
      if (ws) selectWorkspace(ws);
    });
  });
  $("#ws-list").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = e.target.closest(".ws-option");
      if (opt) opt.click();
    }
  });

  // Create workspace
  $("#ws-name-input").addEventListener("input", () => {
    const slug = slugify($("#ws-name-input").value);
    $("#ws-slug-input").value = slug;
  });

  $("#ws-create-btn").addEventListener("click", async () => {
    const name = $("#ws-name-input").value.trim();
    const slug = $("#ws-slug-input").value.trim();
    if (!name || !slug) { setWsCreateError("Name and slug are required."); return; }
    if (!/^[a-z0-9-]+$/.test(slug)) { setWsCreateError("Slug can only contain lowercase letters, numbers, and hyphens."); return; }
    const btn = $("#ws-create-btn");
    btn.disabled = true; btn.textContent = "Creating…";
    setWsCreateError("");
    try {
      const { error, data } = await LP.admin.createWorkspace(slug, name);
      if (error) throw error;
      // Re-load workspaces
      const wsList = await LP.myWorkspaces();
      const ws = wsList.find((w) => w.slug === slug) || wsList[0];
      if (ws) selectWorkspace(ws);
    } catch (err) {
      setWsCreateError(friendlyError(err));
      btn.disabled = false; btn.textContent = "Create workspace";
    }
  });

  function setWsCreateError(msg) {
    const el = $("#ws-create-error");
    if (msg) { el.textContent = msg; el.classList.remove("hide"); }
    else el.classList.add("hide");
  }

  // Sign out from ws gate
  $("#ws-signout-btn").addEventListener("click", () => LP.auth.signOut());

  // ── Select workspace & enter app ───────────────────────────────────────────
  async function selectWorkspace(ws) {
    S.ws = ws;
    // Apply accent color
    if (ws.accent_color) {
      document.documentElement.style.setProperty("--accent", ws.accent_color);
    }
    hide("auth-gate"); hide("ws-gate");
    const app = document.getElementById("app");
    app.classList.remove("hide");   // .hide is display:none !important — inline style alone can't win
    app.style.display = "flex";
    app.style.flexDirection = "column";

    // Topbar
    $("#topbar-ws-name").textContent = ws.name;
    const portalLink = document.getElementById("view-portal-link");
    portalLink.href = `portal.html?w=${encodeURIComponent(ws.slug)}`;

    // Load boards for filters
    await loadBoardsCache();

    // Navigate to inbox by default
    navigateTo("inbox");
  }

  // ── Auth state ─────────────────────────────────────────────────────────────
  LP.auth.onChange(async (event, session) => {
    if (event === "SIGNED_OUT" || !session) {
      S.ws = null;
      S.boards = [];
      hide("ws-gate"); hide("app");
      show("auth-gate");
      const btn = $("#auth-btn");
      btn.disabled = false;
      btn.textContent = authMode === "signin" ? "Sign in" : "Create account";
      return;
    }
    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
      await loadWorkspaces(session.user);
    }
  });

  // Initial check
  (async () => {
    const user = await LP.auth.user();
    if (user) await loadWorkspaces(user);
    // If not logged in auth gate is already visible
  })();

  // ── Sign out ───────────────────────────────────────────────────────────────
  $("#topbar-signout").addEventListener("click", () => LP.auth.signOut());

  // ── Sidebar nav ────────────────────────────────────────────────────────────
  document.querySelector(".sidebar").addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item");
    if (!btn) return;
    const section = btn.dataset.section;
    if (section) navigateTo(section);
  });

  function navigateTo(section) {
    // Update nav
    $$(".nav-item").forEach((b) => {
      const active = b.dataset.section === section;
      b.classList.toggle("active", active);
      b.setAttribute("aria-current", active ? "page" : "false");
    });
    // Show section
    $$(".section").forEach((s) => s.classList.toggle("active", s.id === "section-" + section));
    // Load content
    switch (section) {
      case "inbox":     loadInbox(); break;
      case "roadmap":   loadRoadmap(); break;
      case "changelog": loadChangelog(); break;
      case "boards":    loadBoards(); break;
      case "analytics": loadAnalytics(); break;
      case "settings":  loadSettings(); break;
    }
  }

  // ── Boards cache (used by filters and merge) ───────────────────────────────
  async function loadBoardsCache() {
    if (!S.ws) return;
    try {
      S.boards = await LP.boards(S.ws.id);
      // Populate inbox board filter
      const sel = $("#inbox-board-filter");
      sel.innerHTML = `<option value="">All boards</option>` +
        S.boards.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
    } catch (_) { /* non-fatal */ }
  }

  // ── INBOX ─────────────────────────────────────────────────────────────────
  let inboxDebounce;
  async function loadInbox() {
    if (!S.ws) return;
    const list = $("#inbox-list");
    list.innerHTML = skeletons(5);
    try {
      const boardId = $("#inbox-board-filter").value || null;
      const status = $("#inbox-status-filter").value || null;
      const sort = $("#inbox-sort-filter").value || "trending";
      const search = $("#inbox-search").value.trim();
      const rows = await LP.posts(S.ws.id, { boardId, status, sort, search });
      S.posts = rows;
      // Also keep a full post list for merge & changelog linking
      if (!search && !boardId && !status) S.allPosts = rows;
      else if (S.allPosts.length === 0) {
        // fetch all without filter in background
        LP.posts(S.ws.id, { sort: "new" }).then((all) => { S.allPosts = all; });
      }
      renderInbox(rows);
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(friendlyError(err))}</div>`;
    }
  }

  function renderInbox(rows) {
    const list = $("#inbox-list");
    const count = $("#inbox-count");
    count.textContent = rows.length ? `${rows.length} post${rows.length === 1 ? "" : "s"}` : "";
    if (!rows.length) {
      list.innerHTML = `<div class="empty"><p>No posts match your filters.</p></div>`;
      return;
    }
    list.innerHTML = rows.map((p) => renderPostRow(p)).join("");
  }

  function renderPostRow(p) {
    const board = S.boards.find((b) => b.id === p.board_id);
    return `
    <article class="post-row card" role="listitem" data-post-id="${esc(p.id)}">
      <div class="post-row-head" tabindex="0" role="button" aria-expanded="${S.expandedPostId === p.id}" aria-label="Toggle post: ${esc(p.title)}">
        <div class="post-vote" aria-label="${esc(p.vote_count)} votes">
          <span class="caret" aria-hidden="true">▲</span>
          <span class="n">${esc(p.vote_count)}</span>
        </div>
        <div class="post-main">
          <div class="post-title">${esc(p.title)}</div>
          <div class="post-meta">
            ${statusBadge(p.status)}
            ${board ? `<span class="badge board-badge">${esc(board.name)}</span>` : ""}
            ${p.pinned ? `<span class="post-pinned-icon" aria-label="Pinned" title="Pinned">📌</span>` : ""}
            <span class="muted small">${esc(p.comment_count)} comment${p.comment_count === 1 ? "" : "s"}</span>
            <span class="muted small">by ${esc(p.author_email || "unknown")}</span>
            <span class="muted small">${esc(LP.timeAgo(p.created_at))}</span>
          </div>
        </div>
      </div>
      <div class="post-expand${S.expandedPostId === p.id ? " open" : ""}" id="expand-${esc(p.id)}" aria-hidden="${S.expandedPostId !== p.id}">
        ${renderExpandPanel(p)}
      </div>
    </article>`;
  }

  function renderExpandPanel(p) {
    const board = S.boards.find((b) => b.id === p.board_id);
    return `
    <div class="expand-grid">
      <div class="expand-col">
        ${p.body ? `<div class="action-block"><div class="expand-label">Description</div><div class="post-body-text">${esc(p.body)}</div></div>` : ""}

        <div class="action-block" id="comments-wrap-${esc(p.id)}">
          <div class="expand-label">Comments <span class="muted small" id="comments-count-${esc(p.id)}"></span></div>
          <div id="comments-${esc(p.id)}" class="comments-list">
            <div class="skel skel-row" style="height:40px;margin-bottom:4px;" aria-label="Loading comments"></div>
          </div>
        </div>

        <div class="action-block reply-area">
          <div class="expand-label">Official reply</div>
          <textarea id="reply-body-${esc(p.id)}" placeholder="Write an official reply (shown highlighted to users)…" aria-label="Official reply text"></textarea>
          <button class="btn btn-primary btn-sm" data-action="reply" data-post-id="${esc(p.id)}" type="button">Post reply</button>
        </div>
      </div>

      <div class="expand-col">
        <div class="action-block">
          <div class="expand-label">Status</div>
          <select class="status-select" data-action="status" data-post-id="${esc(p.id)}" aria-label="Set post status" data-current="${esc(p.status)}">
            ${Object.entries(LP.STATUS).map(([k, v]) => `<option value="${esc(k)}"${k === p.status ? " selected" : ""}>${esc(v.label)}</option>`).join("")}
          </select>
          <div class="declined-reason hide" id="declined-wrap-${esc(p.id)}">
            <textarea id="declined-reason-${esc(p.id)}" placeholder="Reason for declining (shown to users)…" style="margin-top:8px;min-height:60px;font-size:13px;" aria-label="Reason for declining"></textarea>
            <button class="btn btn-sm btn-danger" data-action="status-confirm-declined" data-post-id="${esc(p.id)}" type="button" style="margin-top:6px;">Confirm decline</button>
          </div>
        </div>

        <div class="action-block">
          <div class="expand-label">Pin</div>
          <button class="btn btn-sm ${p.pinned ? "btn-primary" : "btn-ghost"}" data-action="pin" data-post-id="${esc(p.id)}" data-pinned="${p.pinned ? "1" : "0"}" type="button" aria-pressed="${p.pinned}">
            ${p.pinned ? "📌 Pinned" : "Pin post"}
          </button>
        </div>

        <div class="action-block">
          <div class="expand-label">Merge into another post</div>
          <div class="merge-search">
            <input type="search" id="merge-search-${esc(p.id)}" placeholder="Search posts to merge into…" aria-label="Search for post to merge into" autocomplete="off" />
            <div class="merge-results hide" id="merge-results-${esc(p.id)}" role="listbox" aria-label="Merge target candidates"></div>
          </div>
        </div>

        <div class="action-block" style="background:var(--surface-2);">
          <div class="expand-label">Post info</div>
          <div class="small muted" style="line-height:2;">
            ${board ? `<div>Board: <strong>${esc(board.name)}</strong></div>` : ""}
            <div>Author: <strong>${esc(p.author_name || p.author_email || "—")}</strong></div>
            <div>Created: <strong>${esc(new Date(p.created_at).toLocaleString())}</strong></div>
          </div>
        </div>
      </div>
    </div>`;
  }

  // Event delegation for inbox
  $("#inbox-list").addEventListener("click", (e) => {
    const head = e.target.closest(".post-row-head");
    const action = e.target.dataset.action || e.target.closest("[data-action]")?.dataset.action;
    const postIdEl = e.target.closest("[data-post-id]");
    const postId = postIdEl?.dataset.postId;

    if (head && !action) {
      const row = head.closest(".post-row");
      const pid = row?.dataset.postId;
      if (!pid) return;
      const panel = document.getElementById("expand-" + pid);
      const isOpen = panel?.classList.contains("open");
      // Close all
      $$(".post-expand.open").forEach((p) => {
        p.classList.remove("open");
        p.setAttribute("aria-hidden", "true");
        const h = p.previousElementSibling;
        if (h) h.setAttribute("aria-expanded", "false");
      });
      if (!isOpen && panel) {
        panel.classList.add("open");
        panel.setAttribute("aria-hidden", "false");
        head.setAttribute("aria-expanded", "true");
        S.expandedPostId = pid;
        loadComments(pid);
      } else {
        S.expandedPostId = null;
      }
      return;
    }

    if (!action || !postId) return;

    if (action === "reply") { handleReply(postId); return; }
    if (action === "pin") { handlePin(postId, e.target.closest("[data-action]")); return; }
    if (action === "status-confirm-declined") { handleStatusConfirmDeclined(postId); return; }
  });

  // Keyboard: Enter/Space on post-row-head
  $("#inbox-list").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const head = e.target.closest(".post-row-head");
    if (!head) return;
    e.preventDefault();
    head.click();
  });

  // Inline status change
  $("#inbox-list").addEventListener("change", (e) => {
    if (e.target.dataset.action !== "status") return;
    const postId = e.target.dataset.postId;
    const newStatus = e.target.value;
    const declineWrap = document.getElementById("declined-wrap-" + postId);
    if (newStatus === "declined") {
      if (declineWrap) declineWrap.classList.remove("hide");
    } else {
      if (declineWrap) declineWrap.classList.add("hide");
      handleSetStatus(postId, newStatus, null);
    }
  });

  // Merge search input
  $("#inbox-list").addEventListener("input", (e) => {
    const el = e.target;
    if (!el.id || !el.id.startsWith("merge-search-")) return;
    const postId = el.id.replace("merge-search-", "");
    const q = el.value.trim().toLowerCase();
    const resultsEl = document.getElementById("merge-results-" + postId);
    if (!resultsEl) return;
    if (!q || q.length < 2) { resultsEl.classList.add("hide"); return; }
    const matches = S.allPosts.filter((p) =>
      p.id !== postId &&
      p.merged_into == null &&
      p.title.toLowerCase().includes(q)
    ).slice(0, 8);
    if (!matches.length) { resultsEl.innerHTML = `<div class="merge-result-item" style="color:var(--mut);">No matching posts</div>`; resultsEl.classList.remove("hide"); return; }
    resultsEl.innerHTML = matches.map((p) =>
      `<div class="merge-result-item" role="option" tabindex="0" data-target-id="${esc(p.id)}" data-from-id="${esc(postId)}">
        <strong>${esc(p.title)}</strong>
        <span>${esc(p.vote_count)} votes · ${esc(LP.timeAgo(p.created_at))}</span>
      </div>`
    ).join("");
    resultsEl.classList.remove("hide");
  });

  // Merge result click
  $("#inbox-list").addEventListener("click", (e) => {
    const item = e.target.closest(".merge-result-item[data-target-id]");
    if (!item) return;
    const fromId = item.dataset.fromId;
    const intoId = item.dataset.targetId;
    if (!fromId || !intoId) return;
    const fromPost = S.allPosts.find((p) => p.id === fromId);
    const intoPost = S.allPosts.find((p) => p.id === intoId);
    if (!fromPost || !intoPost) return;
    S.mergeFrom = fromId;
    S.mergeInto = intoId;
    document.getElementById("merge-modal-body").innerHTML =
      `Merge <strong>${esc(fromPost.title)}</strong> into <strong>${esc(intoPost.title)}</strong>? ` +
      `All votes and comments will be combined. This cannot be undone.`;
    show("merge-modal");
    document.getElementById("merge-confirm-btn").focus();
    // Close dropdown
    const resultsEl = document.getElementById("merge-results-" + fromId);
    if (resultsEl) resultsEl.classList.add("hide");
  });

  // Merge result keyboard
  $("#inbox-list").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const item = e.target.closest(".merge-result-item[data-target-id]");
    if (!item) return;
    e.preventDefault();
    item.click();
  });

  // Merge modal
  document.getElementById("merge-confirm-btn").addEventListener("click", async () => {
    if (!S.mergeFrom || !S.mergeInto) return;
    const btn = document.getElementById("merge-confirm-btn");
    btn.disabled = true; btn.textContent = "Merging…";
    try {
      const { error } = await LP.admin.merge(S.mergeFrom, S.mergeInto);
      if (error) throw error;
      hide("merge-modal");
      toast("Posts merged — votes combined.");
      S.mergeFrom = null; S.mergeInto = null;
      await loadInbox();
    } catch (err) {
      hide("merge-modal");
      toast(friendlyError(err), true);
    } finally {
      btn.disabled = false; btn.textContent = "Yes, merge";
    }
  });

  document.getElementById("merge-cancel-btn").addEventListener("click", () => {
    hide("merge-modal");
    S.mergeFrom = null; S.mergeInto = null;
  });

  // Close modal on bg click
  document.getElementById("merge-modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("merge-modal")) {
      hide("merge-modal");
      S.mergeFrom = null; S.mergeInto = null;
    }
  });

  // Escape key closes modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hide("merge-modal");
      S.mergeFrom = null; S.mergeInto = null;
    }
  });

  // ── Inbox actions ──────────────────────────────────────────────────────────
  async function handleSetStatus(postId, newStatus, reason) {
    try {
      const { error } = await LP.admin.setStatus(postId, newStatus, reason);
      if (error) throw error;
      toast("Status updated.");
      await loadInbox();
    } catch (err) {
      toast(friendlyError(err), true);
      // Revert select UI
      const sel = document.querySelector(`select[data-action="status"][data-post-id="${postId}"]`);
      if (sel) sel.value = sel.dataset.current;
      const dw = document.getElementById("declined-wrap-" + postId);
      if (dw) dw.classList.add("hide");
    }
  }

  function handleStatusConfirmDeclined(postId) {
    const reason = document.getElementById("declined-reason-" + postId)?.value.trim();
    if (!reason) { toast("A reason is required when declining.", true); return; }
    handleSetStatus(postId, "declined", reason);
  }

  async function handlePin(postId, btn) {
    const currentlyPinned = btn.dataset.pinned === "1";
    const newPinned = !currentlyPinned;
    try {
      const { error } = await LP.admin.pin(postId, newPinned);
      if (error) throw error;
      toast(newPinned ? "Post pinned." : "Post unpinned.");
      await loadInbox();
    } catch (err) {
      toast(friendlyError(err), true);
    }
  }

  async function handleReply(postId) {
    const ta = document.getElementById("reply-body-" + postId);
    const body = ta?.value.trim();
    if (!body) { toast("Reply cannot be empty.", true); return; }
    const btn = document.querySelector(`button[data-action="reply"][data-post-id="${postId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Posting…"; }
    try {
      const { error } = await LP.admin.reply(postId, "Team", body);
      if (error) throw error;
      if (ta) ta.value = "";
      toast("Reply posted.");
      loadComments(postId); // refresh comments inline
    } catch (err) {
      toast(friendlyError(err), true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Post reply"; }
    }
  }

  async function loadComments(postId) {
    const el = document.getElementById("comments-" + postId);
    const countEl = document.getElementById("comments-count-" + postId);
    if (!el) return;
    el.innerHTML = `<div class="skel skel-row" style="height:40px;" aria-label="Loading comments"></div>`;
    try {
      const rows = await LP.comments(postId);
      if (countEl) countEl.textContent = `(${rows.length})`;
      if (!rows.length) { el.innerHTML = `<p class="small muted" style="margin:8px 0;">No comments yet.</p>`; return; }
      el.innerHTML = rows.map((c) => `
        <div class="comment-item">
          <div class="avatar" aria-hidden="true" style="font-size:11px;">${esc((c.author_name || c.author_email || "?").charAt(0).toUpperCase())}</div>
          <div class="comment-body${c.is_admin ? " is-admin" : ""}">
            <div class="comment-author${c.is_admin ? " admin-tag" : ""}">${esc(c.author_name || c.author_email || "Anonymous")}${c.is_admin ? " · Team" : ""}</div>
            <div class="comment-text">${esc(c.body)}</div>
            <div class="comment-time">${esc(LP.timeAgo(c.created_at))}</div>
          </div>
        </div>`).join("");
    } catch (_) {
      el.innerHTML = `<p class="small muted">Could not load comments.</p>`;
    }
  }

  // Inbox filter events
  ["inbox-board-filter", "inbox-status-filter", "inbox-sort-filter"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => loadInbox());
  });
  $("#inbox-search").addEventListener("input", () => {
    clearTimeout(inboxDebounce);
    inboxDebounce = setTimeout(() => loadInbox(), 320);
  });

  // ── ROADMAP ────────────────────────────────────────────────────────────────
  const ROADMAP_STATUSES = ["planned", "in_progress", "shipped"];

  async function loadRoadmap() {
    if (!S.ws) return;
    const cols = document.getElementById("roadmap-cols");
    cols.innerHTML = skeletons(3, "skel-row", "height:180px;");
    try {
      const rows = await LP.posts(S.ws.id, { sort: "top" });
      const grouped = {};
      ROADMAP_STATUSES.forEach((s) => { grouped[s] = []; });
      rows.forEach((p) => {
        if (ROADMAP_STATUSES.includes(p.status)) grouped[p.status].push(p);
      });
      cols.innerHTML = ROADMAP_STATUSES.map((status) => {
        const s = LP.STATUS[status];
        const cards = grouped[status];
        return `
          <div class="road-admin-col" role="listitem">
            <h3 style="color:${esc(s.color)}">${esc(s.label)} <span class="muted small">(${cards.length})</span></h3>
            ${cards.length ? cards.map((p) => renderRoadCard(p)).join("") : `<p class="small muted">No posts here yet.</p>`}
          </div>`;
      }).join("");
    } catch (err) {
      cols.innerHTML = `<div class="empty">${esc(friendlyError(err))}</div>`;
    }
  }

  function renderRoadCard(p) {
    const board = S.boards.find((b) => b.id === p.board_id);
    return `
      <div class="road-card" data-post-id="${esc(p.id)}">
        <div class="road-card-title">${esc(p.title)}</div>
        <div class="road-card-meta">
          <span class="muted small">▲ ${esc(p.vote_count)}</span>
          ${board ? `<span class="badge board-badge" style="font-size:11px;">${esc(board.name)}</span>` : ""}
        </div>
        <div style="margin-top:8px;">
          <select class="status-select" data-action="roadmap-status" data-post-id="${esc(p.id)}" data-current="${esc(p.status)}" aria-label="Change status for: ${esc(p.title)}">
            ${Object.entries(LP.STATUS).map(([k, v]) => `<option value="${esc(k)}"${k === p.status ? " selected" : ""}>${esc(v.label)}</option>`).join("")}
          </select>
        </div>
      </div>`;
  }

  document.getElementById("roadmap-cols").addEventListener("change", async (e) => {
    if (e.target.dataset.action !== "roadmap-status") return;
    const postId = e.target.dataset.postId;
    const newStatus = e.target.value;
    // data-prev is set on first change; before that we read data-current from render
    const oldStatus = e.target.dataset.prev || e.target.dataset.current;
    e.target.dataset.prev = oldStatus;
    if (newStatus === "declined") {
      // declined on roadmap requires a reason — use prompt for simplicity in roadmap context
      const reason = window.prompt("Reason for declining this post (required):");
      if (!reason || !reason.trim()) {
        e.target.value = oldStatus || "planned";
        toast("Decline cancelled — a reason is required.", true);
        return;
      }
      try {
        const { error } = await LP.admin.setStatus(postId, "declined", reason.trim());
        if (error) throw error;
        toast("Status updated.");
        loadRoadmap();
      } catch (err) {
        toast(friendlyError(err), true);
        e.target.value = oldStatus;
      }
      return;
    }
    try {
      const { error } = await LP.admin.setStatus(postId, newStatus, null);
      if (error) throw error;
      toast("Status updated.");
      loadRoadmap();
    } catch (err) {
      toast(friendlyError(err), true);
      e.target.value = oldStatus;
    }
  });

  // ── CHANGELOG ──────────────────────────────────────────────────────────────
  async function loadChangelog() {
    if (!S.ws) return;
    const listEl = document.getElementById("cl-list");
    listEl.innerHTML = skeletons(3, "skel-row", "height:80px;");
    try {
      const entries = await LP.changelog(S.ws.id, { publishedOnly: false });
      if (!entries.length) {
        listEl.innerHTML = `<div class="empty"><p>No changelog entries yet. Create your first announcement!</p></div>`;
      } else {
        listEl.innerHTML = entries.map((entry) => renderClEntry(entry)).join("");
      }
    } catch (err) {
      listEl.innerHTML = `<div class="empty">${esc(friendlyError(err))}</div>`;
    }
    // Populate linked posts select
    populateLinkedPostsSelect();
  }

  function renderClEntry(entry) {
    const labels = entry.labels || [];
    const isDraft = entry.status === "draft";
    return `
      <div class="cl-entry card" data-cl-id="${esc(entry.id)}">
        <div class="cl-entry-head">
          <div class="cl-entry-meta">
            <div class="cl-entry-title">${esc(entry.title)}</div>
            <div class="cl-entry-labels">
              ${isDraft ? `<span class="badge" style="background:var(--warn-soft,#fff8ea);color:var(--warn);">Draft</span>` : `<span class="badge" style="background:var(--ok-soft,#eaf9f4);color:var(--ok);">Published</span>`}
              ${labels.map((l) => `<span class="cl-label">${esc(l)}</span>`).join("")}
            </div>
            <div class="small muted" style="margin-top:4px;">${entry.published_at ? esc(new Date(entry.published_at).toLocaleDateString()) : esc(LP.timeAgo(entry.created_at))}</div>
          </div>
          <div class="cl-entry-status row" style="gap:6px;flex:0 0 auto;">
            <button class="btn btn-ghost btn-sm" data-action="cl-edit" data-cl-id="${esc(entry.id)}" type="button" aria-label="Edit: ${esc(entry.title)}">Edit</button>
          </div>
        </div>
      </div>`;
  }

  async function populateLinkedPostsSelect() {
    const sel = document.getElementById("cl-linked-posts");
    // Ensure we have a post list — fetch if needed
    if (!S.allPosts.length && S.ws) {
      try {
        S.allPosts = await LP.posts(S.ws.id, { sort: "top" });
      } catch (_) { /* non-fatal */ }
    }
    const posts = S.allPosts.length ? S.allPosts : S.posts;
    sel.innerHTML = posts
      .filter((p) => !["shipped", "declined", "closed"].includes(p.status))
      .map((p) => `<option value="${esc(p.id)}">${esc(p.title)} (${esc(LP.STATUS[p.status]?.label || p.status)}, ▲ ${esc(p.vote_count)})</option>`)
      .join("");
    if (!sel.innerHTML) sel.innerHTML = `<option value="" disabled>No open posts</option>`;
  }

  // New / Edit changelog
  document.getElementById("new-changelog-btn").addEventListener("click", () => {
    openClEditor(null);
  });

  document.getElementById("cl-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='cl-edit']");
    if (!btn) return;
    const clId = btn.dataset.clId;
    LP.changelog(S.ws.id, { publishedOnly: false }).then((entries) => {
      const entry = entries.find((x) => x.id === clId);
      if (entry) openClEditor(entry);
    });
  });

  function openClEditor(entry) {
    S.clEntry = entry;
    const isNew = !entry;
    document.getElementById("cl-editor-title").textContent = isNew ? "New changelog entry" : "Edit changelog entry";
    document.getElementById("cl-edit-id").value = entry?.id || "";
    document.getElementById("cl-title").value = entry?.title || "";
    document.getElementById("cl-body").value = entry?.body || "";
    document.getElementById("cl-labels").value = entry?.labels?.join(", ") || "";
    document.getElementById("cl-status-select").value = entry?.status || "draft";
    // Reset linked posts selection
    const sel = document.getElementById("cl-linked-posts");
    Array.from(sel.options).forEach((o) => { o.selected = false; });
    show("cl-editor-wrap");
    document.getElementById("cl-title").focus();
  }

  document.getElementById("cl-cancel-btn").addEventListener("click", () => {
    hide("cl-editor-wrap");
    S.clEntry = null;
  });

  document.getElementById("cl-save-btn").addEventListener("click", async () => {
    const id = document.getElementById("cl-edit-id").value || null;
    const title = document.getElementById("cl-title").value.trim();
    const body = document.getElementById("cl-body").value.trim();
    const labelsRaw = document.getElementById("cl-labels").value;
    const labels = labelsRaw.split(",").map((l) => l.trim()).filter(Boolean);
    const status = document.getElementById("cl-status-select").value;
    const sel = document.getElementById("cl-linked-posts");
    const linked = Array.from(sel.selectedOptions).map((o) => o.value);

    if (!title) { toast("Title is required.", true); return; }
    if (!body) { toast("Body is required.", true); return; }

    const btn = document.getElementById("cl-save-btn");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const { error } = await LP.admin.upsertChangelog(id, S.ws.id, title, body, labels, status, linked);
      if (error) throw error;
      toast(status === "published" ? "Changelog entry published!" : "Draft saved.");
      hide("cl-editor-wrap");
      S.clEntry = null;
      await loadChangelog();
    } catch (err) {
      toast(friendlyError(err), true);
    } finally {
      btn.disabled = false; btn.textContent = "Save entry";
    }
  });

  // ── BOARDS ─────────────────────────────────────────────────────────────────
  async function loadBoards() {
    if (!S.ws) return;
    const listEl = document.getElementById("boards-list");
    listEl.innerHTML = skeletons(3, "skel-row", "height:72px;");
    try {
      const boards = await LP.boards(S.ws.id);
      S.boards = boards;
      if (!boards.length) {
        listEl.innerHTML = `<div class="empty"><p>No boards yet. Create your first board to collect feedback.</p></div>`;
      } else {
        listEl.innerHTML = boards.map((b) => `
          <div class="board-card">
            <div class="board-card-head">
              <div class="board-card-icon" aria-hidden="true">📁</div>
              <div class="board-card-info">
                <strong>${esc(b.name)}</strong>
                <span>${esc(b.slug)}${b.description ? " · " + esc(b.description) : ""}</span>
              </div>
              ${b.is_private ? `<span class="board-priv">Private</span>` : `<span class="board-priv" style="background:var(--ok-soft,#eaf9f4);color:var(--ok);">Public</span>`}
            </div>
          </div>`).join("");
      }
    } catch (err) {
      listEl.innerHTML = `<div class="empty">${esc(friendlyError(err))}</div>`;
    }
  }

  document.getElementById("show-new-board-btn").addEventListener("click", () => {
    const form = document.getElementById("new-board-form");
    form.classList.toggle("hide");
    if (!form.classList.contains("hide")) document.getElementById("board-name").focus();
  });

  document.getElementById("cancel-board-btn").addEventListener("click", () => {
    hide("new-board-form");
  });

  document.getElementById("board-name").addEventListener("input", () => {
    document.getElementById("board-slug").value = slugify(document.getElementById("board-name").value);
  });

  document.getElementById("create-board-btn").addEventListener("click", async () => {
    const name = document.getElementById("board-name").value.trim();
    const slug = document.getElementById("board-slug").value.trim();
    const desc = document.getElementById("board-desc").value.trim();
    const isPrivate = document.getElementById("board-private").checked;

    if (!name) { toast("Board name is required.", true); return; }
    if (!slug) { toast("Board slug is required.", true); return; }
    if (!/^[a-z0-9-]+$/.test(slug)) { toast("Slug can only contain lowercase letters, numbers, and hyphens.", true); return; }

    const btn = document.getElementById("create-board-btn");
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const { error } = await LP.admin.createBoard(S.ws.id, name, slug, desc, isPrivate);
      if (error) throw error;
      toast("Board created!");
      hide("new-board-form");
      document.getElementById("board-name").value = "";
      document.getElementById("board-slug").value = "";
      document.getElementById("board-desc").value = "";
      document.getElementById("board-private").checked = false;
      await loadBoards();
      await loadBoardsCache(); // refresh filter dropdown
    } catch (err) {
      toast(friendlyError(err), true);
    } finally {
      btn.disabled = false; btn.textContent = "Create board";
    }
  });

  // ── ANALYTICS ──────────────────────────────────────────────────────────────
  async function loadAnalytics() {
    if (!S.ws) return;
    const kpiRow = document.getElementById("kpi-row");
    const statusBar = document.getElementById("status-bar");
    const statusLegend = document.getElementById("status-legend");
    const topList = document.getElementById("top-posts-list");

    kpiRow.innerHTML = skeletons(3, "kpi-card", "height:100px;");

    try {
      const data = await LP.analytics(S.ws.id);
      const { posts, votes, byStatus, rows } = data;

      // KPI cards
      const activeStatuses = Object.keys(byStatus).filter((s) => !["shipped", "declined", "closed"].includes(s));
      const activePosts = activeStatuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
      kpiRow.innerHTML = [
        { val: posts, label: "Total posts" },
        { val: votes, label: "Total votes" },
        { val: activePosts, label: "Active posts" },
      ].map((k) => `
        <div class="kpi-card" role="listitem">
          <div class="kpi-val">${esc(String(k.val))}</div>
          <div class="kpi-label">${esc(k.label)}</div>
        </div>`).join("");

      // Status bar
      const total = posts || 1;
      statusBar.innerHTML = Object.entries(LP.STATUS).map(([key, s]) => {
        const count = byStatus[key] || 0;
        const pct = (count / total * 100).toFixed(1);
        if (!count) return "";
        return `<div class="status-bar-seg" style="width:${pct}%;background:${esc(s.color)};" title="${esc(s.label)}: ${count} (${pct}%)" role="presentation"></div>`;
      }).join("");

      statusLegend.innerHTML = Object.entries(LP.STATUS).map(([key, s]) => {
        const count = byStatus[key] || 0;
        if (!count) return "";
        return `<div class="status-legend-item">
          <div class="status-legend-dot" style="background:${esc(s.color)};"></div>
          ${esc(s.label)}: <strong>${esc(String(count))}</strong>
        </div>`;
      }).join("");

      // Top 5 posts
      const top5 = rows.slice().sort((a, b) => b.vote_count - a.vote_count).slice(0, 5);
      if (!top5.length) {
        topList.innerHTML = `<p class="small muted">No posts yet.</p>`;
      } else {
        topList.innerHTML = top5.map((p, i) => `
          <div class="top-post-item">
            <div class="top-post-rank" aria-hidden="true">${esc(String(i + 1))}</div>
            <div class="top-post-info">
              <div class="top-post-title">${esc(p.title || "Untitled")}</div>
              <div class="top-post-votes small muted">▲ ${esc(String(p.vote_count))} votes · ${esc(LP.STATUS[p.status]?.label || p.status)}</div>
            </div>
          </div>`).join("");
      }

    } catch (err) {
      kpiRow.innerHTML = `<div class="empty" style="grid-column:1/-1;">${esc(friendlyError(err))}</div>`;
    }
  }

  // ── SETTINGS ───────────────────────────────────────────────────────────────
  function loadSettings() {
    if (!S.ws) return;
    document.getElementById("settings-name").value = S.ws.name || "";
    document.getElementById("settings-tagline").value = S.ws.settings?.tagline || "";
    const accent = S.ws.accent_color || "#6d5efc";
    document.getElementById("settings-accent-picker").value = accent;
    document.getElementById("settings-accent-hex").value = accent;
    document.getElementById("settings-plan-badge").textContent = (S.ws.plan || "free").charAt(0).toUpperCase() + (S.ws.plan || "free").slice(1);
  }

  document.getElementById("settings-accent-picker").addEventListener("input", (e) => {
    document.getElementById("settings-accent-hex").value = e.target.value;
    document.documentElement.style.setProperty("--accent", e.target.value);
  });

  document.getElementById("settings-accent-hex").addEventListener("input", (e) => {
    const val = e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      document.getElementById("settings-accent-picker").value = val;
      document.documentElement.style.setProperty("--accent", val);
    }
  });

  document.getElementById("settings-save-btn").addEventListener("click", async () => {
    if (!S.ws) return;
    const name = document.getElementById("settings-name").value.trim();
    const tagline = document.getElementById("settings-tagline").value.trim();
    const accent = document.getElementById("settings-accent-hex").value.trim() ||
                   document.getElementById("settings-accent-picker").value;
    if (!name) { toast("Workspace name cannot be empty.", true); return; }

    const btn = document.getElementById("settings-save-btn");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const { error } = await LP.admin.updateWorkspace(S.ws.id, name, accent, S.ws.logo_url || null, tagline);
      if (error) throw error;
      // Update local state
      S.ws.name = name;
      S.ws.accent_color = accent;
      if (!S.ws.settings) S.ws.settings = {};
      S.ws.settings.tagline = tagline;
      document.getElementById("topbar-ws-name").textContent = name;
      document.documentElement.style.setProperty("--accent", accent);
      toast("Settings saved.");
    } catch (err) {
      toast(friendlyError(err), true);
    } finally {
      btn.disabled = false; btn.textContent = "Save changes";
    }
  });

  // ── Skeleton helper ────────────────────────────────────────────────────────
  function skeletons(n, cls = "skel-row", style = "") {
    return Array.from({ length: n }).map(() =>
      `<div class="skel ${cls}" ${style ? `style="${style}"` : ""} aria-label="Loading…"></div>`
    ).join("");
  }

})();
