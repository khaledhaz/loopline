/* Loopline data layer — the single contract every page uses.
   Loads Supabase from CDN; exposes window.LP with typed-ish helpers.
   All writes go through SECURITY DEFINER RPCs (loop_*). Reads use RLS-guarded selects. */
(function () {
  const SB_URL = "https://durugcxsakdbgimgkyiw.supabase.co";
  const SB_KEY = "sb_publishable_rfZYlRhgpU23UJHox-tpHw_142Q3U2V";
  const sb = window.supabase.createClient(SB_URL, SB_KEY);

  // ---- tiny utils ---------------------------------------------------------
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const qs = (k) => new URLSearchParams(location.search).get(k);
  const timeAgo = (d) => {
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 60) return "just now";
    const m = s / 60; if (m < 60) return Math.floor(m) + "m ago";
    const h = m / 60; if (h < 24) return Math.floor(h) + "h ago";
    const dd = h / 24; if (dd < 30) return Math.floor(dd) + "d ago";
    return new Date(d).toLocaleDateString();
  };
  const STATUS = {
    open: { label: "Open", color: "#8a93a6" },
    under_review: { label: "Under Review", color: "#f5a623" },
    planned: { label: "Planned", color: "#6d5efc" },
    in_progress: { label: "In Progress", color: "#2f9bff" },
    shipped: { label: "Shipped", color: "#27c498" },
    declined: { label: "Declined", color: "#ff6b6b" },
    closed: { label: "Closed", color: "#5a6072" },
  };
  // identity remembered locally for voters
  const ident = {
    email: () => localStorage.getItem("lp_email") || "",
    name: () => localStorage.getItem("lp_name") || "",
    set: (email, name) => {
      if (email) localStorage.setItem("lp_email", email.trim().toLowerCase());
      if (name) localStorage.setItem("lp_name", name.trim());
    },
  };

  // ---- reads --------------------------------------------------------------
  async function workspace(slug) {
    const { data, error } = await sb.from("loop_workspaces").select("*").eq("slug", slug).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function boards(wsId) {
    const { data, error } = await sb.from("loop_boards").select("*").eq("workspace_id", wsId).order("sort");
    if (error) throw error;
    return data || [];
  }
  // sort: 'trending' (votes desc, recent weight), 'top' (votes), 'new' (created)
  async function posts(wsId, { boardId = null, status = null, sort = "trending", search = "" } = {}) {
    let q = sb.from("loop_posts").select("*").eq("workspace_id", wsId).is("merged_into", null);
    if (boardId) q = q.eq("board_id", boardId);
    if (status) q = q.eq("status", status);
    if (search) q = q.ilike("title", "%" + search + "%");
    if (sort === "new") q = q.order("created_at", { ascending: false });
    else q = q.order("pinned", { ascending: false }).order("vote_count", { ascending: false }).order("created_at", { ascending: false });
    const { data, error } = await q.limit(200);
    if (error) throw error;
    let rows = data || [];
    if (sort === "trending") {
      const now = Date.now();
      rows = rows.slice().sort((a, b) => score(b) - score(a));
      function score(p) {
        const ageDays = (now - new Date(p.created_at).getTime()) / 864e5;
        return (p.pinned ? 1e6 : 0) + p.vote_count / Math.pow(ageDays + 2, 0.4);
      }
    }
    return rows;
  }
  async function post(id) {
    const { data, error } = await sb.from("loop_posts").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function comments(postId) {
    const { data, error } = await sb.from("loop_comments").select("*").eq("post_id", postId).order("created_at");
    if (error) throw error;
    return data || [];
  }
  async function changelog(wsId, { publishedOnly = true } = {}) {
    let q = sb.from("loop_changelog").select("*").eq("workspace_id", wsId);
    if (publishedOnly) q = q.eq("status", "published");
    const { data, error } = await q.order("published_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function similar(wsSlug, text) {
    if (!text || text.trim().length < 4) return [];
    const { data, error } = await sb.rpc("loop_similar", { p_w_slug: wsSlug, p_q: text });
    if (error) return [];
    return data || [];
  }
  async function myVotes(email, postIds) {
    if (!email || !postIds.length) return new Set();
    const { data, error } = await sb.rpc("loop_my_votes", { p_email: email, p_post_ids: postIds });
    if (error) return new Set();
    return new Set((data || []).map((r) => (typeof r === "string" ? r : r.loop_my_votes)));
  }

  // ---- writes (voter) -----------------------------------------------------
  async function submitPost(wsSlug, boardSlug, title, body, email, name) {
    ident.set(email, name);
    const { data, error } = await sb.rpc("loop_submit_post", {
      p_w_slug: wsSlug, p_board_slug: boardSlug, p_title: title, p_body: body, p_email: email, p_name: name,
    });
    if (error) throw error;
    return data;
  }
  async function vote(postId, email) {
    const { data, error } = await sb.rpc("loop_vote", { p_post_id: postId, p_email: email });
    if (error) throw error;
    return data; // {voted, count}
  }
  async function comment(postId, email, name, body) {
    ident.set(email, name);
    const { data, error } = await sb.rpc("loop_comment", { p_post_id: postId, p_email: email, p_name: name, p_body: body });
    if (error) throw error;
    return data;
  }

  // ---- auth + admin -------------------------------------------------------
  const auth = {
    user: async () => (await sb.auth.getUser()).data.user,
    signInPassword: (email, password) => sb.auth.signInWithPassword({ email, password }),
    signUp: (email, password) => sb.auth.signUp({ email, password }),
    signInMagic: (email) => sb.auth.signInWithOtp({ email }),
    signOut: () => sb.auth.signOut(),
    onChange: (cb) => sb.auth.onAuthStateChange(cb),
  };
  async function myWorkspaces() {
    const u = await auth.user(); if (!u) return [];
    const { data } = await sb.from("loop_members").select("workspace_id, role, loop_workspaces(*)").eq("user_id", u.id);
    return (data || []).map((m) => ({ role: m.role, ...m.loop_workspaces }));
  }
  const admin = {
    setStatus: (postId, status, reason) => sb.rpc("loop_set_status", { p_post_id: postId, p_status: status, p_reason: reason || null }),
    pin: (postId, pinned) => sb.rpc("loop_pin", { p_post_id: postId, p_pinned: pinned }),
    reply: (postId, name, body) => sb.rpc("loop_admin_reply", { p_post_id: postId, p_name: name, p_body: body }),
    merge: (fromId, intoId) => sb.rpc("loop_merge_post", { p_from: fromId, p_into: intoId }),
    createBoard: (wsId, name, slug, desc, isPrivate) => sb.rpc("loop_create_board", { p_w_id: wsId, p_name: name, p_slug: slug, p_desc: desc, p_is_private: !!isPrivate }),
    upsertChangelog: (id, wsId, title, body, labels, status, linked) =>
      sb.rpc("loop_upsert_changelog", { p_id: id, p_w_id: wsId, p_title: title, p_body: body, p_labels: labels || [], p_status: status, p_linked_posts: linked || [] }),
    createWorkspace: (slug, name) => sb.rpc("loop_create_workspace", { p_slug: slug, p_name: name }),
    updateWorkspace: (wsId, name, accent, logo, tagline) => sb.rpc("loop_update_workspace", { p_w_id: wsId, p_name: name, p_accent: accent, p_logo: logo, p_tagline: tagline }),
  };
  async function analytics(wsId) {
    const { data: ps } = await sb.from("loop_posts").select("status,vote_count,created_at").eq("workspace_id", wsId).is("merged_into", null);
    const rows = ps || [];
    const byStatus = {}; let votes = 0;
    rows.forEach((p) => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; votes += p.vote_count; });
    return { posts: rows.length, votes, byStatus, rows };
  }

  window.LP = {
    sb, esc, qs, timeAgo, STATUS, ident,
    workspace, boards, posts, post, comments, changelog, similar, myVotes,
    submitPost, vote, comment, auth, myWorkspaces, admin, analytics,
  };
})();
