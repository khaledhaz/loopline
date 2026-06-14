/* portal.js — Loopline public portal
   Single-page, no framework, no build step.
   All data via window.LP (sb.js). All user text via LP.esc (XSS-safe). */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    ws: null,         // workspace row
    boards: [],       // board rows
    posts: [],        // post rows for current view
    myVotes: new Set(),
    sort: "trending", // trending | top | new
    boardId: null,    // active board filter
    search: "",
    view: "feedback", // feedback | roadmap | changelog | detail
    detailPost: null, // post row for detail view
    detailComments: [],
    pendingVotePostId: null, // waiting for identity capture
    _searchTimer: null,
    _similarTimer: null,
    _submitting: false,
    slug: "acme",
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  function esc(s) { return LP.esc(s); }

  function timeAgo(d) { return LP.timeAgo(d); }

  function toast(msg, duration = 3000) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), duration);
  }

  function showEl(el) { if (el) el.classList.remove("hide"); }
  function hideEl(el) { if (el) el.classList.add("hide"); }

  function avatarInitial(name, email) {
    const n = name || email || "?";
    return n.trim()[0].toUpperCase();
  }

  // Parse URL params on demand (not cached — URL changes between views)
  function param(k) { return LP.qs(k); }

  // Build href preserving workspace slug
  function buildHref(overrides = {}) {
    const p = new URLSearchParams();
    p.set("w", state.slug);
    Object.entries(overrides).forEach(([k, v]) => { if (v != null) p.set(k, v); });
    return "?" + p.toString();
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  async function boot() {
    state.slug = param("w") || "acme";
    state.view = param("view") || "feedback";
    const postId = param("post");

    // Update tab hrefs to include workspace slug
    $$(".tab[data-view]").forEach(t => {
      t.href = buildHref({ view: t.dataset.view });
    });
    // Brand link
    const brandLink = $("#brand-link");
    if (brandLink) brandLink.href = buildHref({ view: "feedback" });

    // Activate correct tab
    activateTab(state.view);

    // Load workspace
    try {
      const ws = await LP.workspace(state.slug);
      if (!ws) {
        renderError("Workspace not found. Check the URL and try again.");
        return;
      }
      state.ws = ws;
      applyBranding(ws);

      const wsNameEl = $("#ws-name");
      if (wsNameEl) wsNameEl.textContent = ws.name || "";

      // Update page title
      document.title = `${ws.name || "Loopline"} — Feedback`;

      // Load boards
      const boards = await LP.boards(ws.id);
      state.boards = boards;

      if (postId) {
        // Direct post detail link
        await showDetail(postId);
      } else {
        await renderView();
      }
    } catch (e) {
      renderError("Could not load workspace. Please try refreshing.");
    }
  }

  function applyBranding(ws) {
    if (ws.accent_color) {
      document.documentElement.style.setProperty("--accent", ws.accent_color);
      // Derive soft version (very light tint)
      document.documentElement.style.setProperty("--accent-soft", ws.accent_color + "18");
    }
  }

  function activateTab(view) {
    $$(".tab[data-view]").forEach(t => {
      const active = t.dataset.view === view;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    });
  }

  // ---------------------------------------------------------------------------
  // Main router
  // ---------------------------------------------------------------------------
  async function renderView() {
    activateTab(state.view);
    if (state.view === "roadmap") {
      await renderRoadmap();
    } else if (state.view === "changelog") {
      await renderChangelog();
    } else {
      await renderFeedback();
    }
  }

  function renderError(msg) {
    const main = $("#main-view");
    main.innerHTML = `<div class="wrap" style="padding:60px 20px"><div class="err-inline">${esc(msg)}</div></div>`;
  }

  // ---------------------------------------------------------------------------
  // FEEDBACK VIEW
  // ---------------------------------------------------------------------------
  async function renderFeedback() {
    const main = $("#main-view");
    main.innerHTML = `
      <div class="wrap">
        <div class="feedback-layout">
          <aside class="sidebar" aria-label="Board filters">
            <div class="sidebar-label">Boards</div>
            <div id="board-list"></div>
          </aside>
          <div class="main-col">
            <div class="list-toolbar">
              <div class="sort-group" role="group" aria-label="Sort posts">
                <button class="sort-btn${state.sort === "trending" ? " active" : ""}" data-sort="trending" type="button">Trending</button>
                <button class="sort-btn${state.sort === "top" ? " active" : ""}" data-sort="top" type="button">Top</button>
                <button class="sort-btn${state.sort === "new" ? " active" : ""}" data-sort="new" type="button">New</button>
              </div>
              <div class="search-wrap">
                <span class="icon-search" aria-hidden="true">&#128269;</span>
                <input type="search" id="search-input" placeholder="Search feedback…" value="${esc(state.search)}" aria-label="Search feedback" autocomplete="off" />
              </div>
            </div>
            <div id="post-list-container" aria-live="polite" aria-label="Feedback posts">
              ${skeletonRows(4)}
            </div>
          </div>
        </div>
      </div>`;

    renderBoards();
    await loadAndRenderPosts();
  }

  function renderBoards() {
    const el = $("#board-list");
    if (!el) return;
    const boards = state.boards;
    let html = `<a href="${buildHref({ view: "feedback" })}" class="board-item${state.boardId === null ? " active" : ""}" data-board="all">All Feedback</a>`;
    boards.forEach(b => {
      html += `<a href="${buildHref({ view: "feedback", board: b.id })}" class="board-item${state.boardId === b.id ? " active" : ""}" data-board="${esc(b.id)}">${esc(b.name)}</a>`;
    });
    el.innerHTML = html;
  }

  async function loadAndRenderPosts() {
    const container = $("#post-list-container");
    if (!container) return;

    try {
      const posts = await LP.posts(state.ws.id, {
        boardId: state.boardId,
        sort: state.sort,
        search: state.search,
      });
      state.posts = posts;

      // Fetch my votes if we have an email
      const email = LP.ident.email();
      if (email && posts.length) {
        state.myVotes = await LP.myVotes(email, posts.map(p => p.id));
      }

      renderPostList(container, posts);
    } catch (e) {
      container.innerHTML = `<div class="err-inline">Could not load posts. Please refresh and try again.</div>`;
    }
  }

  function renderPostList(container, posts) {
    if (!posts.length) {
      container.innerHTML = `<div class="empty" role="status">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect x="6" y="10" width="28" height="22" rx="5" stroke="currentColor" stroke-width="1.8"/><path d="M13 19h14M13 24h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <p style="margin-top:14px;font-weight:600;">No feedback yet</p>
        <p class="small">Be the first to share an idea or request.</p>
      </div>`;
      return;
    }

    const html = posts.map(p => postRowHTML(p)).join("");
    container.innerHTML = `<div class="post-list" role="list">${html}</div>`;
  }

  function postRowHTML(p) {
    const voted = state.myVotes.has(p.id);
    const boardName = state.boards.find(b => b.id === p.board_id)?.name || "";
    const statusInfo = LP.STATUS[p.status] || LP.STATUS.open;

    return `<article class="card card-p post-row hover-lift" data-post-id="${esc(p.id)}" role="listitem" tabindex="0" aria-label="${esc(p.title)}">
      <button class="vote${voted ? " voted" : ""}" data-action="vote" data-post-id="${esc(p.id)}" data-voted="${voted}"
        aria-label="${voted ? "Remove vote for" : "Vote for"} ${esc(p.title)}, ${p.vote_count} vote${p.vote_count === 1 ? "" : "s"}"
        type="button">
        <span class="caret" aria-hidden="true">▲</span>
        <span class="n" aria-live="polite">${p.vote_count}</span>
      </button>
      <div class="post-body-col">
        <div class="post-title">${esc(p.title)}</div>
        ${p.body ? `<div class="post-snippet">${esc(p.body)}</div>` : ""}
        <div class="post-meta">
          <span class="pill" style="background:${esc(statusInfo.color)}" aria-label="Status: ${esc(statusInfo.label)}">${esc(statusInfo.label)}</span>
          ${boardName ? `<span class="meta-item">&#128193; ${esc(boardName)}</span>` : ""}
          <span class="meta-item">&#128172; ${p.comment_count || 0}</span>
          <span class="meta-item">&#128336; ${timeAgo(p.created_at)}</span>
        </div>
      </div>
    </article>`;
  }

  function skeletonRows(n) {
    return Array.from({ length: n }, () => `
      <div class="skel-row card" style="margin-bottom:10px;" aria-hidden="true">
        <div class="skel skel-vote"></div>
        <div class="skel-content">
          <div class="skel skel-line w80"></div>
          <div class="skel skel-line w60"></div>
          <div class="skel skel-line w40"></div>
        </div>
      </div>`).join("");
  }

  // ---------------------------------------------------------------------------
  // POST DETAIL
  // ---------------------------------------------------------------------------
  async function showDetail(postId) {
    const main = $("#main-view");
    main.innerHTML = `<div class="wrap" style="padding:28px 0 60px"><div role="status" aria-label="Loading post">${skeletonRows(1)}</div></div>`;

    try {
      const [p, comments] = await Promise.all([
        LP.post(postId),
        LP.comments(postId),
      ]);
      if (!p) {
        renderError("Post not found.");
        return;
      }
      state.detailPost = p;
      state.detailComments = comments;

      // Update voted state for this post
      const email = LP.ident.email();
      if (email) {
        state.myVotes = await LP.myVotes(email, [p.id]);
      }

      renderDetail(p, comments);
    } catch (e) {
      renderError("Could not load post. Please try refreshing.");
    }
  }

  function renderDetail(p, comments) {
    const main = $("#main-view");
    const voted = state.myVotes.has(p.id);
    const statusInfo = LP.STATUS[p.status] || LP.STATUS.open;
    const boardName = state.boards.find(b => b.id === p.board_id)?.name || "";

    const identEmail = LP.ident.email();

    const commentsHTML = comments.length
      ? comments.map(c => commentHTML(c)).join("")
      : `<p class="muted small" style="margin:0;">No comments yet. Be the first.</p>`;

    main.innerHTML = `
      <div class="wrap" style="padding:28px 0 60px">
        <button class="detail-back" id="btn-back" type="button" aria-label="Back to feedback list">
          &#8592; Back
        </button>
        <div class="detail-header">
          <button class="vote${voted ? " voted" : ""}" id="detail-vote-btn" data-post-id="${esc(p.id)}" data-voted="${voted}"
            aria-label="${voted ? "Remove vote" : "Vote for this post"}, ${p.vote_count} vote${p.vote_count === 1 ? "" : "s"}"
            type="button" style="min-width:58px;padding:10px 8px;">
            <span class="caret" aria-hidden="true">▲</span>
            <span class="n" id="detail-vote-count" aria-live="polite">${p.vote_count}</span>
          </button>
          <div class="detail-title-col">
            <div class="detail-meta">
              <span class="pill" style="background:${esc(statusInfo.color)}">${esc(statusInfo.label)}</span>
              ${boardName ? `<span class="badge">${esc(boardName)}</span>` : ""}
              <span class="muted small">${timeAgo(p.created_at)}</span>
            </div>
            <h1 class="detail-title">${esc(p.title)}</h1>
          </div>
        </div>

        ${p.body ? `<div class="detail-body">${esc(p.body)}</div>` : ""}
        ${(p.status === "declined" && p.status_reason)
          ? `<div class="status-reason" role="note" aria-label="Decline reason"><strong>Declined:</strong> ${esc(p.status_reason)}</div>`
          : ""}

        <section class="comments-section" aria-label="Comments">
          <h2 style="font-size:16px;margin-bottom:16px;">Comments <span class="muted small">(${comments.length})</span></h2>
          <div id="comments-list" aria-live="polite">${commentsHTML}</div>
        </section>

        <section class="add-comment" aria-label="Add a comment">
          <h3 style="font-size:14px;margin-bottom:12px;">Leave a comment</h3>
          <div class="comment-fields" style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
            <input type="email" id="cmnt-email" placeholder="your@email.com" value="${esc(identEmail)}" autocomplete="email" aria-label="Your email" style="flex:1;min-width:140px;" />
            <input type="text" id="cmnt-name" placeholder="Your name (optional)" value="${esc(LP.ident.name())}" autocomplete="name" aria-label="Your name" style="flex:1;min-width:140px;" />
          </div>
          <textarea id="cmnt-body" placeholder="Share your thoughts…" rows="3" aria-label="Comment text"></textarea>
          <div class="err-inline hide" id="cmnt-err" role="alert" style="margin:8px 0;"></div>
          <div style="display:flex;justify-content:flex-end;margin-top:10px;">
            <button type="button" class="btn btn-primary btn-sm" id="btn-post-comment">Post comment</button>
          </div>
        </section>
      </div>`;
  }

  function commentHTML(c) {
    const isOfficial = c.is_admin;
    const initial = avatarInitial(c.author_name, c.author_email);

    return `<div class="comment-item${isOfficial ? " comment-official" : ""}" data-comment-id="${esc(c.id)}">
      <div class="avatar" aria-hidden="true">${esc(initial)}</div>
      <div class="comment-body-col">
        <div class="comment-meta">
          <span class="comment-name">${esc(c.author_name || c.author_email || "Anonymous")}</span>
          ${isOfficial ? `<span class="official-badge" aria-label="Official team reply">&#10003; Official</span>` : ""}
          <span>${timeAgo(c.created_at)}</span>
        </div>
        <div class="comment-text">${esc(c.body)}</div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // ROADMAP VIEW
  // ---------------------------------------------------------------------------
  async function renderRoadmap() {
    const main = $("#main-view");
    main.innerHTML = `
      <div class="wrap road-view">
        <h1 style="font-size:clamp(20px,3vw,28px);margin-bottom:20px;">Roadmap</h1>
        <div id="roadmap-container" role="status" aria-label="Loading roadmap">${roadmapSkeleton()}</div>
      </div>`;

    try {
      const allPosts = await LP.posts(state.ws.id, { sort: "top" });
      renderRoadmapCols(allPosts);
    } catch (e) {
      $("#roadmap-container").innerHTML = `<div class="err-inline">Could not load roadmap. Please refresh.</div>`;
    }
  }

  function roadmapSkeleton() {
    return `<div class="road" aria-hidden="true">
      ${["Planned","In Progress","Shipped"].map(label => `
        <div class="road-col">
          <h3>${label}</h3>
          ${Array.from({length:3}).map(()=>`<div class="skel" style="height:60px;border-radius:8px;margin-bottom:8px;"></div>`).join("")}
        </div>`).join("")}
    </div>`;
  }

  function renderRoadmapCols(allPosts) {
    const cols = {
      planned: allPosts.filter(p => p.status === "planned"),
      in_progress: allPosts.filter(p => p.status === "in_progress"),
      shipped: allPosts.filter(p => p.status === "shipped"),
    };

    const colDefs = [
      { key: "planned", label: "Planned", icon: "&#128221;" },
      { key: "in_progress", label: "In Progress", icon: "&#9889;" },
      { key: "shipped", label: "Shipped", icon: "&#10003;" },
    ];

    const html = `<div class="road" role="list" aria-label="Roadmap columns">
      ${colDefs.map(col => `
        <div class="road-col" role="listitem" aria-label="${col.label} column">
          <h3>${col.icon} ${col.label} <span class="muted small">(${cols[col.key].length})</span></h3>
          ${cols[col.key].length
            ? cols[col.key].map(p => roadCardHTML(p, col.key === "shipped")).join("")
            : `<div class="empty" style="padding:24px 10px;font-size:13px;">Nothing here yet</div>`
          }
        </div>`).join("")}
    </div>`;

    const container = $("#roadmap-container");
    if (container) container.innerHTML = html;
  }

  function roadCardHTML(p, isShipped) {
    return `<div class="road-card" data-post-id="${esc(p.id)}" tabindex="0" role="button"
      aria-label="${esc(p.title)}, ${p.vote_count} vote${p.vote_count === 1 ? "" : "s"}">
      <div class="road-card-title">${esc(p.title)}</div>
      <div class="road-card-votes">
        ${isShipped ? `<span aria-hidden="true">&#10003;</span>` : `<span aria-hidden="true">&#9650;</span>`}
        ${p.vote_count} vote${p.vote_count === 1 ? "" : "s"}
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // CHANGELOG VIEW
  // ---------------------------------------------------------------------------
  async function renderChangelog() {
    const main = $("#main-view");
    main.innerHTML = `
      <div class="wrap">
        <div class="cl-view">
          <h1 style="font-size:clamp(20px,3vw,28px);margin-bottom:4px;">Changelog</h1>
          <p class="muted small" style="margin-bottom:24px;">What's new — shipped updates from the team.</p>
          <div id="cl-container" role="status" aria-label="Loading changelog">
            ${Array.from({length:2}).map(()=>`
              <div class="cl-entry card" aria-hidden="true">
                <div class="skel" style="height:22px;width:60%;margin-bottom:10px;border-radius:6px;"></div>
                <div class="skel" style="height:14px;width:35%;margin-bottom:14px;border-radius:6px;"></div>
                <div class="skel" style="height:80px;border-radius:6px;"></div>
              </div>`).join("")}
          </div>
        </div>
      </div>`;

    try {
      const entries = await LP.changelog(state.ws.id, { publishedOnly: true });
      renderChangelogEntries(entries);
    } catch (e) {
      $("#cl-container").innerHTML = `<div class="err-inline">Could not load changelog. Please refresh.</div>`;
    }
  }

  function renderChangelogEntries(entries) {
    const container = $("#cl-container");
    if (!container) return;
    if (!entries.length) {
      container.innerHTML = `<div class="empty" role="status">
        <p style="font-weight:600;margin-bottom:4px;">Nothing published yet</p>
        <p class="small">Check back soon for updates.</p>
      </div>`;
      return;
    }

    container.innerHTML = entries.map(e => changelogEntryHTML(e)).join("");
  }

  function changelogEntryHTML(e) {
    const labels = Array.isArray(e.labels) ? e.labels : [];
    const dateStr = e.published_at
      ? new Date(e.published_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
      : timeAgo(e.created_at);

    return `<article class="cl-entry" aria-label="Changelog: ${esc(e.title)}">
      <div class="cl-entry-header">
        <h2 class="cl-entry-title">${esc(e.title)}</h2>
        <div class="cl-entry-meta">
          <time class="cl-entry-date" datetime="${esc(e.published_at || e.created_at)}">${esc(dateStr)}</time>
          ${labels.map(l => `<span class="cl-label">${esc(l)}</span>`).join("")}
        </div>
      </div>
      <div class="cl-body">${esc(e.body)}</div>
    </article>`;
  }

  // ---------------------------------------------------------------------------
  // VOTING
  // ---------------------------------------------------------------------------
  async function handleVote(postId) {
    const email = LP.ident.email();
    if (!email) {
      // Capture identity first
      state.pendingVotePostId = postId;
      openIdentModal();
      return;
    }

    await doVote(postId, email);
  }

  async function doVote(postId, email) {
    // Snapshot state before optimistic update so rollback is accurate
    const wasVoted = state.myVotes.has(postId);
    const newVoted = !wasVoted;

    // Find all vote buttons for this post (list view + detail view)
    const btns = $$(`[data-action="vote"][data-post-id="${postId}"], #detail-vote-btn[data-post-id="${postId}"]`);

    // Capture original counts for rollback
    const origCounts = btns.map(btn => {
      const nEl = btn.querySelector(".n");
      return parseInt(nEl?.textContent || "0", 10);
    });

    // Optimistic UI update
    btns.forEach((btn, i) => {
      const nEl = btn.querySelector(".n");
      const next = newVoted ? origCounts[i] + 1 : Math.max(0, origCounts[i] - 1);
      if (nEl) nEl.textContent = next;
      btn.classList.toggle("voted", newVoted);
      btn.dataset.voted = String(newVoted);
      btn.setAttribute("aria-label", `${newVoted ? "Remove vote" : "Vote for this post"}, ${next} vote${next === 1 ? "" : "s"}`);
    });

    if (newVoted) {
      state.myVotes.add(postId);
    } else {
      state.myVotes.delete(postId);
    }

    try {
      const result = await LP.vote(postId, email);
      // Reconcile with authoritative server count
      if (result && typeof result.count === "number") {
        const v = !!result.voted;
        btns.forEach(btn => {
          const nEl = btn.querySelector(".n");
          if (nEl) nEl.textContent = result.count;
          btn.classList.toggle("voted", v);
          btn.dataset.voted = String(v);
          btn.setAttribute("aria-label", `${v ? "Remove vote" : "Vote for this post"}, ${result.count} vote${result.count === 1 ? "" : "s"}`);
        });
        if (v) state.myVotes.add(postId); else state.myVotes.delete(postId);
      }
      toast(newVoted ? "Upvoted!" : "Vote removed.");
    } catch (e) {
      // Rollback to pre-optimistic state
      btns.forEach((btn, i) => {
        const nEl = btn.querySelector(".n");
        if (nEl) nEl.textContent = origCounts[i];
        btn.classList.toggle("voted", wasVoted);
        btn.dataset.voted = String(wasVoted);
        btn.setAttribute("aria-label", `${wasVoted ? "Remove vote" : "Vote for this post"}, ${origCounts[i]} vote${origCounts[i] === 1 ? "" : "s"}`);
      });
      if (wasVoted) state.myVotes.add(postId); else state.myVotes.delete(postId);
      toast("Could not save your vote. Please try again.");
    }
  }

  // ---------------------------------------------------------------------------
  // SUBMIT FEEDBACK MODAL
  // ---------------------------------------------------------------------------
  function openSubmitModal() {
    populateBoardSelect();
    prefillIdentity();
    hideEl($("#similar-panel"));
    hideEl($("#sf-title-err"));
    hideEl($("#sf-form-err"));
    $("#sf-title").value = "";
    $("#sf-body").value = "";
    showEl($("#modal-submit"));
    // Trap focus
    setTimeout(() => $("#sf-board")?.focus(), 50);
  }

  function closeSubmitModal() {
    hideEl($("#modal-submit"));
    clearTimeout(state._similarTimer);
    hideEl($("#similar-panel"));
  }

  function populateBoardSelect() {
    const sel = $("#sf-board");
    if (!sel) return;
    sel.innerHTML = state.boards.map(b => `<option value="${esc(b.slug)}">${esc(b.name)}</option>`).join("")
      || `<option value="general">General</option>`;
  }

  function prefillIdentity() {
    const email = LP.ident.email();
    const name = LP.ident.name();
    const emailEl = $("#sf-email");
    const nameEl = $("#sf-name");
    if (emailEl && email) emailEl.value = email;
    if (nameEl && name) nameEl.value = name;
  }

  // Similar posts debounce
  function onTitleInput() {
    const title = $("#sf-title")?.value || "";
    clearTimeout(state._similarTimer);
    if (title.trim().length < 4) {
      hideEl($("#similar-panel"));
      return;
    }
    state._similarTimer = setTimeout(() => loadSimilar(title), 350);
  }

  async function loadSimilar(title) {
    try {
      const hits = await LP.similar(state.slug, title);
      renderSimilar(hits);
    } catch (e) {
      // Non-fatal
    }
  }

  function renderSimilar(hits) {
    const panel = $("#similar-panel");
    const list = $("#similar-list");
    if (!panel || !list) return;

    if (!hits || hits.length === 0) {
      hideEl(panel);
      return;
    }

    list.innerHTML = hits.slice(0, 5).map(h =>
      `<div class="similar-item" data-post-id="${esc(h.id)}" tabindex="0" role="button"
        aria-label="Upvote: ${esc(h.title)}, ${h.vote_count} votes">
        <span>${esc(h.title)}</span>
        <span class="votes">▲ ${h.vote_count}</span>
      </div>`
    ).join("");
    showEl(panel);
  }

  async function handleSimilarUpvote(postId) {
    const email = LP.ident.email() || $("#sf-email")?.value?.trim() || "";
    const name = $("#sf-name")?.value?.trim() || "";
    if (!email) {
      toast("Enter your email first so we can save your vote.");
      $("#sf-email")?.focus();
      return;
    }
    LP.ident.set(email, name);
    closeSubmitModal();
    await doVote(postId, email);
  }

  async function handleSubmitPost(e) {
    e.preventDefault();
    if (state._submitting) return;

    const titleEl = $("#sf-title");
    const boardEl = $("#sf-board");
    const bodyEl = $("#sf-body");
    const emailEl = $("#sf-email");
    const nameEl = $("#sf-name");
    const errEl = $("#sf-form-err");
    const titleErrEl = $("#sf-title-err");

    const title = titleEl?.value?.trim() || "";
    const boardSlug = boardEl?.value || "";
    const body = bodyEl?.value?.trim() || "";
    const email = emailEl?.value?.trim() || "";
    const name = nameEl?.value?.trim() || "";

    // Validation
    hideEl(titleErrEl);
    hideEl(errEl);

    if (!title) {
      titleErrEl.textContent = "Please enter a title for your feedback.";
      showEl(titleErrEl);
      titleEl?.focus();
      return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = "Please enter a valid email address.";
      showEl(errEl);
      emailEl?.focus();
      return;
    }

    const btn = $("#btn-submit-post");
    state._submitting = true;
    btn.disabled = true;
    btn.textContent = "Submitting…";

    try {
      const newPost = await LP.submitPost(state.slug, boardSlug, title, body, email, name);
      closeSubmitModal();
      toast("Thanks! Your feedback was posted.");

      // Navigate to detail if we got a post back
      if (newPost && newPost.id) {
        await showDetail(newPost.id);
      } else {
        // Refresh the list
        state.view = "feedback";
        await renderFeedback();
      }
    } catch (e) {
      const msg = (e && e.message) ? e.message : "Could not submit. Please try again.";
      // Never show raw error to user — sanitise
      errEl.textContent = msg.length < 200 ? msg : "Could not submit. Please try again.";
      showEl(errEl);
    } finally {
      state._submitting = false;
      btn.disabled = false;
      btn.textContent = "Submit";
    }
  }

  // ---------------------------------------------------------------------------
  // IDENTITY MODAL
  // ---------------------------------------------------------------------------
  function openIdentModal() {
    const emailEl = $("#id-email");
    const nameEl = $("#id-name");
    if (emailEl) emailEl.value = LP.ident.email() || "";
    if (nameEl) nameEl.value = LP.ident.name() || "";
    hideEl($("#id-err"));
    showEl($("#modal-ident"));
    setTimeout(() => emailEl?.focus(), 50);
  }

  function closeIdentModal() {
    hideEl($("#modal-ident"));
    state.pendingVotePostId = null;
  }

  async function handleIdentSubmit(e) {
    e.preventDefault();
    const email = $("#id-email")?.value?.trim() || "";
    const name = $("#id-name")?.value?.trim() || "";
    const errEl = $("#id-err");

    hideEl(errEl);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = "Please enter a valid email address.";
      showEl(errEl);
      return;
    }

    LP.ident.set(email, name);
    closeIdentModal();

    if (state.pendingVotePostId) {
      const pid = state.pendingVotePostId;
      state.pendingVotePostId = null;
      await doVote(pid, email);
    }
  }

  // ---------------------------------------------------------------------------
  // ADD COMMENT
  // ---------------------------------------------------------------------------
  async function handlePostComment() {
    const p = state.detailPost;
    if (!p) return;

    const emailEl = $("#cmnt-email");
    const nameEl = $("#cmnt-name");
    const bodyEl = $("#cmnt-body");
    const errEl = $("#cmnt-err");

    const email = emailEl?.value?.trim() || "";
    const name = nameEl?.value?.trim() || "";
    const body = bodyEl?.value?.trim() || "";

    hideEl(errEl);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = "Please enter a valid email address.";
      showEl(errEl);
      emailEl?.focus();
      return;
    }
    if (!body) {
      errEl.textContent = "Please write a comment before posting.";
      showEl(errEl);
      bodyEl?.focus();
      return;
    }

    const btn = $("#btn-post-comment");
    btn.disabled = true;
    btn.textContent = "Posting…";

    try {
      const newComment = await LP.comment(p.id, email, name, body);
      LP.ident.set(email, name);
      if (bodyEl) bodyEl.value = "";

      // Append comment optimistically
      const c = newComment || { id: "tmp-" + Date.now(), post_id: p.id, author_email: email, author_name: name, body, is_admin: false, created_at: new Date().toISOString() };
      const listEl = $("#comments-list");
      if (listEl) {
        // Remove "no comments" placeholder if present
        if (listEl.querySelector("p.muted")) listEl.innerHTML = "";
        listEl.insertAdjacentHTML("beforeend", commentHTML(c));
      }
      toast("Comment posted!");
    } catch (e) {
      errEl.textContent = "Could not post comment. Please try again.";
      showEl(errEl);
    } finally {
      btn.disabled = false;
      btn.textContent = "Post comment";
    }
  }

  // ---------------------------------------------------------------------------
  // EVENT DELEGATION
  // ---------------------------------------------------------------------------
  function setupEvents() {
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeydown);

    // Search + similar-title inputs (delegated via input event)
    document.addEventListener("input", e => {
      if (e.target.id === "search-input") {
        clearTimeout(state._searchTimer);
        const q = e.target.value.trim();
        state._searchTimer = setTimeout(() => {
          state.search = q;
          loadAndRenderPosts();
        }, 350);
      }
      if (e.target.id === "sf-title") {
        onTitleInput();
      }
    });

    // Forms (static in HTML — safe to bind once)
    const formSubmit = $("#form-submit");
    if (formSubmit) formSubmit.addEventListener("submit", handleSubmitPost);

    const formIdent = $("#form-ident");
    if (formIdent) formIdent.addEventListener("submit", handleIdentSubmit);
  }

  function handleClick(e) {
    // Give feedback button
    if (e.target.closest("#btn-give-feedback")) {
      openSubmitModal();
      return;
    }

    // Close modals via buttons
    if (e.target.closest("#btn-close-submit")) { closeSubmitModal(); return; }
    if (e.target.closest("#btn-cancel-submit")) { closeSubmitModal(); return; }
    if (e.target.closest("#btn-close-ident")) { closeIdentModal(); return; }

    // Close modals via backdrop click
    if (e.target.id === "modal-submit") { closeSubmitModal(); return; }
    if (e.target.id === "modal-ident") { closeIdentModal(); return; }

    // Tab navigation (SPA intercept)
    const tab = e.target.closest(".tab[data-view]");
    if (tab) {
      e.preventDefault();
      navigateTo({ view: tab.dataset.view });
      return;
    }

    // Back button in detail
    if (e.target.closest("#btn-back")) {
      navigateTo({ view: "feedback" });
      return;
    }

    // Vote buttons (list and detail)
    const voteBtn = e.target.closest("[data-action='vote']");
    if (voteBtn) {
      e.stopPropagation();
      e.preventDefault();
      handleVote(voteBtn.dataset.postId);
      return;
    }

    const detailVote = e.target.closest("#detail-vote-btn");
    if (detailVote) {
      handleVote(detailVote.dataset.postId);
      return;
    }

    // Post row click → detail
    const postRow = e.target.closest(".post-row[data-post-id]");
    if (postRow && !e.target.closest("[data-action='vote']")) {
      navigateTo({ post: postRow.dataset.postId });
      return;
    }

    // Roadmap card click → detail
    const roadCard = e.target.closest(".road-card[data-post-id]");
    if (roadCard) {
      navigateTo({ post: roadCard.dataset.postId });
      return;
    }

    // Board filter
    const boardItem = e.target.closest(".board-item[data-board]");
    if (boardItem) {
      e.preventDefault();
      const boardVal = boardItem.dataset.board;
      state.boardId = boardVal === "all" ? null : boardVal;
      renderBoards();
      loadAndRenderPosts();
      return;
    }

    // Similar post upvote
    const simItem = e.target.closest(".similar-item[data-post-id]");
    if (simItem) {
      handleSimilarUpvote(simItem.dataset.postId);
      return;
    }

    // Sort buttons
    const sortBtn = e.target.closest(".sort-btn[data-sort]");
    if (sortBtn) {
      state.sort = sortBtn.dataset.sort;
      $$(".sort-btn").forEach(b => b.classList.toggle("active", b.dataset.sort === state.sort));
      loadAndRenderPosts();
      return;
    }

    // Post comment
    if (e.target.closest("#btn-post-comment")) {
      handlePostComment();
      return;
    }
  }

  function handleKeydown(e) {
    // Escape closes open modals
    if (e.key === "Escape") {
      if (!$("#modal-submit")?.classList.contains("hide")) { closeSubmitModal(); return; }
      if (!$("#modal-ident")?.classList.contains("hide")) { closeIdentModal(); return; }
    }

    // Tab navigation via keyboard (treat tab links as buttons for SPA)
    if (e.key === "Enter" || e.key === " ") {
      const tab = e.target.closest(".tab[data-view]");
      if (tab) {
        e.preventDefault();
        navigateTo({ view: tab.dataset.view });
        return;
      }

      // Post rows
      const postRow = e.target.closest(".post-row[data-post-id]");
      if (postRow && !e.target.closest("[data-action='vote']")) {
        e.preventDefault();
        navigateTo({ post: postRow.dataset.postId });
        return;
      }

      // Roadmap cards
      const roadCard = e.target.closest(".road-card[data-post-id]");
      if (roadCard) {
        e.preventDefault();
        navigateTo({ post: roadCard.dataset.postId });
        return;
      }

      // Similar-post items in submit modal
      const simItem = e.target.closest(".similar-item[data-post-id]");
      if (simItem) {
        e.preventDefault();
        handleSimilarUpvote(simItem.dataset.postId);
        return;
      }

      // Modal backdrop click targets
      if (e.target.id === "modal-submit") { e.preventDefault(); closeSubmitModal(); return; }
      if (e.target.id === "modal-ident") { e.preventDefault(); closeIdentModal(); return; }
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation (SPA-style history push)
  // ---------------------------------------------------------------------------
  function navigateTo(params) {
    const newP = new URLSearchParams();
    newP.set("w", state.slug);

    if (params.post) {
      // Stay on current view but add post param
      newP.set("view", "feedback");
      newP.set("post", params.post);
    } else if (params.view) {
      newP.set("view", params.view);
      state.view = params.view;
    }

    const newUrl = "?" + newP.toString();
    history.pushState({}, "", newUrl);

    // Re-render based on new params
    if (params.post) {
      showDetail(params.post);
    } else {
      state.detailPost = null;
      renderView();
    }
  }

  // Handle browser back/forward
  window.addEventListener("popstate", () => {
    const view = param("view") || "feedback";
    const postId = param("post");
    state.view = view;

    if (postId) {
      showDetail(postId);
    } else {
      state.detailPost = null;
      renderView();
    }
  });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    setupEvents();
    boot().catch(() => renderError("An unexpected error occurred. Please refresh the page."));
  }

  // Wait for LP to be available
  if (typeof window.LP !== "undefined") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
