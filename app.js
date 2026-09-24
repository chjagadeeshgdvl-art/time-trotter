/**
 * Triplet App v2 — Dual-mode controller
 *
 * - Online mode : WebSocket client → server is authoritative
 * - Offline mode: local TripletGame instance (pass-and-play)
 *
 * Flow:
 *   modeSelect → [online] onlineLobby → waitingRoom → game
 *             → [offline] lobby → game
 */
(function runTripletApp() {
  "use strict";

  const { TimeTrotterGame, TripletGame, CONFIGURATIONS, VALUES } = window.TimeTrotterEngine || window.TripletEngine;

  /* ─────────────────────────────────────────────────────────────
     DOM helpers
  ───────────────────────────────────────────────────────────── */
  const $  = (id)  => document.getElementById(id);
  const $$ = (sel, ctx = document) => ctx.querySelector(sel);

  /* ─────────────────────────────────────────────────────────────
     Global state
  ───────────────────────────────────────────────────────────── */
  let mode           = null;    // 'online' | 'offline'
  let ws             = null;
  let wsReady        = false;
  let myPlayerId     = null;
  let myRoomCode     = null;
  let isHost         = false;

  /* Auth state — tokens kept in memory (not localStorage) for XSS safety */
  let accessToken     = null;      // short-lived JWT
  let currentUser     = null;      // { id, username, email, is_admin, elo }
  let pendingEmail    = null;      // email awaiting OTP verification
  let forgotPhase     = "email";   // 'email' | 'code'
  let forgotEmailSent = false;     // whether reset-code phase has started
  let onlineState     = null;      // latest state_update from server
  let waitingPlayers  = [];        // [{id,name,connected}]
  let selectedDiff    = "normal";
  let isQuickMatch    = false;     // joined via Quick Match

  // Offline state
  let game          = null;
  let selectedCount = 3;

  // Shared UI timers
  let toastTimer    = null;
  let revealTimer   = null;
  let timerRaf      = null;
  let pingStart     = null;
  let pingInterval  = null;
  let reconnTimer   = null;
  let reconnDelay   = 1000;

  // Reveal state (shared offline + online)
  let previewSlot   = null;   // matrix slot currently face-up
  let activeReveal  = null;   // {title,card,slot}

  /* ─────────────────────────────────────────────────────────────
     Utility
  ───────────────────────────────────────────────────────────── */
  function esc(v) {
    return String(v)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
      .replace(/'/g,"&#039;");
  }

  const CARD_DESIGN_DATA = {
    "0":  { theme: "red",    topIcon: "✦",  motto: "A NEW<br/>BEGINNING",        badgeIcon: "⌖" },
    "1":  { theme: "blue",   topIcon: "🌙", motto: "ONE STEP<br/>AHEAD",         badgeIcon: "►" },
    "2":  { theme: "green",  topIcon: "🍃", motto: "TWO PATHS<br/>MORE CHOICES",  badgeIcon: "△" },
    "3":  { theme: "gold",   topIcon: "✨", motto: "THREE<br/>POSSIBILITIES",     badgeIcon: "☘" },
    "4":  { theme: "purple", topIcon: "🪐", motto: "FOUR IDEAS<br/>FURTHER",      badgeIcon: "⊞" },
    "5":  { theme: "red",    topIcon: "✦",  motto: "FIVE MOMENTS<br/>STRONGER",   badgeIcon: "⌛" },
    "6":  { theme: "blue",   topIcon: "🌙", motto: "SIX WAYS<br/>BOLDER",         badgeIcon: "⬡" },
    "7":  { theme: "green",  topIcon: "🍃", motto: "SEVEN STEPS<br/>BEYOND",      badgeIcon: "⇡" },
    "8":  { theme: "gold",   topIcon: "✨", motto: "EIGHT IDEAS<br/>GREATER",     badgeIcon: "∞" },
    "9":  { theme: "purple", topIcon: "🪐", motto: "NINE STORIES<br/>FOREVER",     badgeIcon: "🌀" },
    "+2": { theme: "teal",   topIcon: "⚡", motto: "CHRONO<br/>BOOST",            badgeIcon: "⚡" },
    "+4": { theme: "teal",   topIcon: "🌟", motto: "TIME<br/>WARP",               badgeIcon: "✦" },
  };

  function cardMarkup(card) {
    if (!card) return "";
    const valStr = String(card.value);
    const design = CARD_DESIGN_DATA[valStr] || { theme: card.colour || "blue", topIcon: "✦", motto: "TIME<br/>TROTTER", badgeIcon: "✦" };
    
    return `<div class="playing-card tt-card theme-${design.theme} suit-${card.colour}" aria-label="${esc(card.value)} ${card.colour}">
      <div class="tt-card-spine"></div>
      <div class="tt-card-header">
        <div class="tt-card-brand">TIME<br/>TRÖTTER</div>
        <div class="tt-card-top-icon">${design.topIcon}</div>
      </div>
      <div class="tt-tech-gauge">
        <span class="tt-gauge-dot top"></span>
        <span class="tt-gauge-line"></span>
        <span class="tt-gauge-dot bottom"></span>
      </div>
      <div class="tt-card-center-val">${esc(card.value)}</div>
      <div class="tt-card-footer">
        <div class="tt-card-motto">${design.motto}</div>
        <div class="tt-card-badge-triangle">
          <span class="tt-card-badge-icon">${design.badgeIcon}</span>
        </div>
      </div>
    </div>`;
  }

  function isRevealActive() {
    return Boolean(activeReveal || previewSlot !== null);
  }

  function showToast(msg, isError = false) {
    clearTimeout(toastTimer);
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("error", isError);
    t.classList.add("visible");
    toastTimer = setTimeout(() => t.classList.remove("visible"), 4800);
  }

  /**
   * Show the card-reveal popup for `duration` ms.
   * Also highlights the matrix slot if slot !== null.
   */
  function beginTimedReveal({ title = null, card = null, slot = null, duration = 4000 }) {
    clearTimeout(revealTimer);
    activeReveal = (title && card) ? { title, card, slot } : null;
    previewSlot  = slot;

    const popup = $("revealPopup");
    if (activeReveal) {
      $("revealTitle").textContent    = activeReveal.title;
      $("revealSubtitle").textContent = `Everyone has ${Math.round(duration / 1000)} seconds.`;
      $("revealCard").innerHTML       = cardMarkup(activeReveal.card);
      const bar = $("revealProgressBar");
      bar.style.setProperty("--reveal-duration", `${duration / 1000}s`);
      bar.style.animation = "none";
      bar.offsetHeight;           // force reflow to restart animation
      bar.style.animation = "";
      popup.hidden = false;
    } else {
      popup.hidden = true;
    }

    // Refresh matrix + actions during reveal (buttons disabled while popup is open)
    refreshMatrix();
    refreshActions();

    revealTimer = setTimeout(() => {
      activeReveal = null;
      previewSlot  = null;
      popup.hidden = true;
      refreshMatrix();
      refreshActions();
    }, duration);
  }

  function refreshMatrix() {
    if (mode === "online") renderOnlineMatrix();
    else                   renderOfflineMatrix();
  }

  function refreshActions() {
    if (mode === "online") renderOnlineActions();
    else                   renderOfflineActions();
  }

  /* ─────────────────────────────────────────────────────────────
     Screen management
  ───────────────────────────────────────────────────────────── */
  const SCREENS = ["authGate","modeSelect","onlineLobby","waitingRoom","lobby","game"];

  function showOnly(id) {
    SCREENS.forEach(s => { const el = $(s); if (el) el.hidden = (s !== id); });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  window.showOnly = showOnly;

  /* ─────────────────────────────────────────────────────────────
     WebSocket client
  ───────────────────────────────────────────────────────────── */
  function connectWS() {
    clearTimeout(reconnTimer);
    const proto  = location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = location.port
      ? `:${location.port}`
      : (location.hostname === "localhost" || location.hostname === "127.0.0.1" ? ":3000" : "");
    const url    = `${proto}//${location.hostname}${wsPort}`;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      setConnStatus("error");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      wsReady      = true;
      reconnDelay  = 1000;
      setConnStatus("connected");
      startPingLoop();
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMsg(msg);
    };

    ws.onclose = () => {
      wsReady = false;
      ws      = null;
      stopPingLoop();
      if (mode === "online") {
        setConnStatus("reconnecting");
        scheduleReconnect();
      }
    };

    ws.onerror = () => { /* handled by onclose */ };
  }

  function scheduleReconnect() {
    clearTimeout(reconnTimer);
    reconnTimer = setTimeout(() => {
      connectWS();
      reconnDelay = Math.min(reconnDelay * 2, 30000);
    }, reconnDelay);
  }

  function sendWS(data) {
    if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
    showToast("Not connected — reconnecting…", true);
    return false;
  }

  async function ensureWSConnected() {
    if (wsReady && ws && ws.readyState === WebSocket.OPEN) return true;

    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connectWS();
    }

    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (wsReady && ws && ws.readyState === WebSocket.OPEN) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return Boolean(wsReady && ws && ws.readyState === WebSocket.OPEN);
  }

  function startPingLoop() {
    stopPingLoop();
    pingInterval = setInterval(() => {
      if (!wsReady) return;
      pingStart = Date.now();
      sendWS({ type: "ping" });
    }, 5000);
  }

  function stopPingLoop() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  }

  function setConnStatus(status) {
    const el = $("connStatus");
    if (!el) return;
    el.hidden = (mode !== "online");
    $("connDot").className = `conn-dot ${status}`;
    $("connLabel").textContent = { connected:"Connected", reconnecting:"Reconnecting…", error:"Offline" }[status] || status;
  }

  /* ─────────────────────────────────────────────────────────────
     Server message handler
  ───────────────────────────────────────────────────────────── */
  function handleServerMsg(msg) {
    switch (msg.type) {

      case "pong":
        if (pingStart) {
          $("connPing").textContent = `${Date.now() - pingStart}ms`;
          pingStart = null;
        }
        break;

      case "room_created":
        myPlayerId     = msg.playerId;
        myRoomCode     = msg.code;
        isHost         = true;
        isQuickMatch   = !!msg.quickMatch;
        selectedDiff   = msg.difficulty || "normal";
        waitingPlayers = msg.playerList || [];
        showWaitingRoom();
        break;

      case "room_joined":
        myPlayerId     = msg.playerId;
        myRoomCode     = msg.code;
        isHost         = false;
        isQuickMatch   = !!msg.quickMatch;
        selectedDiff   = msg.difficulty || "normal";
        waitingPlayers = msg.playerList || [];
        showWaitingRoom();
        break;

      case "rejoined":
        myPlayerId = msg.playerId;
        isHost     = msg.isHost || false;
        // state_update will arrive next
        break;

      case "host_changed":
        waitingPlayers = msg.playerList || waitingPlayers;
        isHost = (myPlayerId === msg.newHost);
        if (!$("waitingRoom").hidden) {
          renderWaitingList();
          updateStartBtn();
          $('startOnlineGame').hidden = !isHost;
          $('waitingHint').textContent = isHost
            ? 'You are now the host. Press Start when ready.'
            : 'Waiting for the host to start…';
        }
        showToast(msg.message || `${msg.name} is now the host.`);
        break;

      case "kicked":
        showToast(msg.message || 'You were removed from the room.', true);
        if (ws) { ws.close(); ws = null; wsReady = false; }
        myPlayerId = null; myRoomCode = null; isHost = false;
        onlineState = null; waitingPlayers = [];
        mode = null;
        $('connStatus').hidden = true;
        showOnly('modeSelect');
        break;

      case "game_over":
        // state_update handles rendering; just show celebration toast
        if (msg.winnerName) showToast(`🏆 ${msg.winnerName} wins the game!`);
        break;

      case "chat":
        appendChatMessage(msg.name, msg.text, msg.ts);
        break;

      case "room_list":
        renderRoomBrowser(msg.rooms || []);
        break;

      case "player_joined":
        waitingPlayers = msg.playerList || waitingPlayers;
        if (!$("waitingRoom").hidden) { renderWaitingList(); updateStartBtn(); }
        showToast(`${msg.name} joined the room!`);
        break;

      case "player_left":
        waitingPlayers = msg.playerList || waitingPlayers;
        if (!$("waitingRoom").hidden) { renderWaitingList(); updateStartBtn(); }
        showToast(`${msg.name} left the room.`);
        if (!$("game").hidden && onlineState) renderOnlineGame();  // refresh conn dots
        break;

      case "player_rejoined":
        waitingPlayers = msg.playerList || waitingPlayers;
        showToast(`${msg.name} reconnected! ✓`);
        if (!$("game").hidden && onlineState) renderOnlineGame();
        break;

      case "game_started":
        $("difficultyBadge").hidden = (msg.difficulty !== "hard");
        $("turnTimerWrap").hidden   = false;
        showOnly("game");
        break;

      case "state_update":
        onlineState = msg.state;
        if (!onlineState) break;
        // If still in waiting room (game just started), switch to game view
        if (!$("game").hidden) {
          renderOnlineGame();
        } else {
          $("difficultyBadge").hidden = (onlineState.difficulty !== "hard");
          $("turnTimerWrap").hidden   = false;
          showOnly("game");
          renderOnlineGame();
        }
        break;

      case "reveal":
        beginTimedReveal({
          title:    msg.title,
          card:     msg.card,
          slot:     msg.slot !== undefined ? msg.slot : null,
          duration: msg.duration || 4000,
        });
        break;

      case "toast":
        showToast(msg.message, msg.isError || false);
        break;

      case "error":
        showToast(msg.message, true);
        break;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     Waiting Room
  ───────────────────────────────────────────────────────────── */
  const DIFF_RULES = {
    normal: ["3 triplets to win","4-second card reveals","40-second turn timer","Bonus clue on any value double"],
    hard:   ["4 triplets to win","3-second card reveals","25-second turn timer","Bonus: new discoveries only","Memory decay after 3 rounds"],
  };

  function showWaitingRoom() {
    showOnly("waitingRoom");
    if ($("connStatus"))    $("connStatus").hidden    = false;
    if ($("lobbyChatWrap")) $("lobbyChatWrap").hidden = false;
    $("roomCodeDisplay").textContent = myRoomCode || "------";
    const hintEl = document.querySelector(".room-code-hint");
    if (hintEl) {
      hintEl.innerHTML = `Open <strong style="color:#38bdf8">${location.origin}</strong> on other devices and enter this code.`;
    }

    // Difficulty info
    const isHard = selectedDiff === "hard";
    const dl = $("waitingDiffLabel");
    dl.textContent = isHard ? "⚡ Hard" : "Normal";
    dl.className   = `diff-label ${selectedDiff}`;

    $("waitingDiffRules").innerHTML = (DIFF_RULES[selectedDiff] || DIFF_RULES.normal)
      .map(r => `<li>${r}</li>`).join("");

    $("startOnlineGame").hidden      = !isHost;
    $("waitingHint").textContent     = isHost
      ? "Press Start when everyone is seated."
      : "Waiting for the host to start…";

    renderWaitingList();
    updateStartBtn();
  }

  function renderWaitingList() {
    const list = $("waitingPlayerList");
    $("waitingCount").textContent = `${waitingPlayers.length} / 5`;
    $("waitingTitle").textContent = waitingPlayers.length < 2
      ? "Waiting for players…"
      : `${waitingPlayers.length} player${waitingPlayers.length > 1 ? "s" : ""} at the table`;

    list.innerHTML = waitingPlayers.map((p) => {
      const tags = [];
      if (p.isHost)             tags.push(`<span class="waiting-player-tag host-tag">HOST</span>`);
      if (p.id === myPlayerId)  tags.push(`<span class="waiting-player-tag you-tag">YOU</span>`);
      const dotClass = p.connected === false ? "offline" : "online";

      let hostControls = "";
      if (isHost && p.id !== myPlayerId) {
        hostControls = `<div class="host-controls" style="margin-left:auto;display:flex;gap:4px">
          <button class="host-ctrl-btn host-btn" data-make-host="${esc(p.id)}" type="button" title="Make Host">★</button>
          <button class="host-ctrl-btn kick-btn" data-kick="${esc(p.id)}" type="button" title="Kick player">✕</button>
        </div>`;
      }

      return `<li class="waiting-player">
        <span class="player-status-dot ${dotClass}"></span>
        <span class="waiting-player-name">${esc(p.name)}</span>
        ${tags.join("")}
        ${hostControls}
      </li>`;
    }).join("");
  }

  function updateStartBtn() {
    const canStart = waitingPlayers.length >= 3;
    $("startOnlineGame").disabled = !canStart;
    $("minPlayersHint").hidden    = canStart;
  }

  /* ─────────────────────────────────────────────────────────────
     Online Game — render
  ───────────────────────────────────────────────────────────── */
  function renderOnlineGame() {
    if (!onlineState) return;
    const st       = onlineState;
    const me       = st.players.find(p => p.id === myPlayerId);
    const current  = st.players.find(p => p.isCurrentPlayer);
    const isMyTurn = st.currentPlayerId === myPlayerId;
    const winner   = st.winnerId ? st.players.find(p => p.id === st.winnerId) : null;
    const sets2win = st.setsToWin || 3;
    const clues    = st.remainingClues ?? 0;

    // Header bar
    $("roundLabel").textContent = st.isFinished ? "Game complete" : `Round ${st.turnNumber}`;
    $("turnHeading").textContent = winner
      ? `${winner.name} wins!`
      : st.finishedReason ? "The deck is exhausted"
      : isMyTurn ? "Your turn"
      : `${current?.name || "…"}'s turn`;

    $("turnStatus").innerHTML = winner
      ? `<strong>${esc(winner.name)} takes the win!</strong><span>${winner.sets.includes(7) ? "The 7 triplet sealed it." : `Completed ${sets2win} triplets.`}</span>`
      : st.finishedReason
      ? `<strong>No winning triplet.</strong><span>${esc(st.finishedReason)}</span>`
      : isMyTurn
      ? `<strong>${clues} guess${clues !== 1 ? "es" : ""} remaining</strong><span>Match 2 same numbers to earn a 3rd guess!</span>`
      : `<strong>Watching ${esc(current?.name || "…")}</strong><span>All reveals are public — memorize them.</span>`;

    renderOnlineScoreboard(st, sets2win);
    renderOnlineHand(st, me, isMyTurn);
    renderOnlineMatrix(st, isMyTurn);
    renderOnlineActions(st, isMyTurn);
    renderTimer(st);
  }

  function renderOnlineScoreboard(st, sets2win) {
    $("scoreboard").innerHTML = st.players.map(p => {
      const filled = p.sets.map(v => `<span class="set-dot filled">${esc(String(v))}</span>`).join("");
      const empty  = Array.from({ length: Math.max(0, sets2win - p.sets.length) }, () => '<span class="set-dot">·</span>').join("");
      return `<div class="player-chip ${p.isCurrentPlayer ? "current" : ""} ${p.penalized ? "penalized" : ""}">
        <span class="player-name">
          <span class="conn-dot-inline ${p.connected ? "connected" : "offline"}"></span>
          ${esc(p.name)}${p.isMe ? " <em>(you)</em>" : ""}
        </span>
        <div class="player-meta">
          <span>${p.handCount} card${p.handCount !== 1 ? "s" : ""}${p.penalized ? " · ⚠ skip" : ""}</span>
          <span class="set-dots" aria-label="${p.sets.length} triplets">${filled}${empty}</span>
        </div>
      </div>`;
    }).join("");
  }

  function renderOnlineHand(st, me, isMyTurn) {
    $("handHeading").textContent = me ? `${me.name}'s hand` : "Your hand";
    $("handCount").textContent   = me?.handCount ?? 0;
    $("handHint").textContent = st.isFinished
      ? "The game is over."
      : isMyTurn ? "Your private cards — only you can see these."
      : "Your hand is hidden until your turn.";

    const handEl = $("hand");
    if (isMyTurn && me?.hand?.length) {
      handEl.innerHTML = me.hand.map(cardMarkup).join("");
    } else if (isMyTurn && me?.hand?.length === 0) {
      handEl.innerHTML = '<p class="empty-state">No cards remain in your hand.</p>';
    } else {
      handEl.innerHTML = '<p class="quiet" style="margin:0;font-size:0.82rem">Visible on your turn.</p>';
    }
  }

  function renderOnlineMatrix(argSt, argMyTurn) {
    if (!onlineState) return;
    const st     = argSt     ?? onlineState;
    const myTurn = argMyTurn ?? (st.currentPlayerId === myPlayerId);
    const matrix = $("matrix");
    matrix.style.setProperty("--matrix-columns", st.configuration.columns);

    const clues   = st.remainingClues ?? 0;
    const noClues = clues === 0 || st.isFinished;

    matrix.innerHTML = st.board.map(slot => {
      if (slot.isEmpty) return '<div class="matrix-card empty" aria-label="Claimed">claimed</div>';
      const n       = slot.slot;
      const preview = previewSlot === n;
      const seen    = st.turn.seenSlots.includes(n);
      const canAct  = myTurn && !st.isFinished && !isRevealActive();
      const dis     = !canAct || seen || noClues;
      const lbl     = preview ? `Matrix ${n + 1} revealed` : `Flip matrix ${n + 1}`;
      return `<button class="matrix-card${preview ? " preview" : ""}" data-slot="${n}" type="button" ${dis ? "disabled" : ""} aria-label="${lbl}">
        ${preview && activeReveal?.card ? cardMarkup(activeReveal.card) : '<span class="card-back" aria-hidden="true"></span>'}
      </button>`;
    }).join("");

    const hint = $("matrixFlipHint");
    if (myTurn) {
      hint.textContent = `${clues} clue${clues !== 1 ? "s" : ""} left`;
      hint.className   = "matrix-flip-hint";
    } else {
      hint.textContent = "Memory matrix";
      hint.className   = "matrix-flip-hint";
    }
    $("matrixNote").textContent = previewSlot !== null
      ? "Memorize this card — it turns face down again soon."
      : "Every matrix flip or opponent question costs 1 clue.";
  }

  function renderOnlineActions(argSt, argMyTurn) {
    if (!onlineState) return;
    const st     = argSt     ?? onlineState;
    const myTurn = argMyTurn ?? (st.currentPlayerId === myPlayerId);
    const clues  = st.remainingClues ?? 0;
    const cur    = st.players.find(p => p.isCurrentPlayer);

    $("clueCount").innerHTML = st.isFinished
      ? "The game is complete."
      : myTurn
      ? `<span>${clues}</span> of ${st.turn.maxActions} clue${st.turn.maxActions !== 1 ? "s" : ""} available`
      : `Watching ${esc(cur?.name || "…")}`;

    const noClues  = !myTurn || clues === 0 || st.isFinished || isRevealActive();
    $("askList").innerHTML = st.players
      .filter(p => !p.isMe && p.handCount > 0)
      .map(p => `
        <div class="ask-row">
          <span class="ask-name">${esc(p.name)} <em>(${p.handCount})</em></span>
          <button class="ask-button high" data-ask="highest" data-player="${p.id}" type="button" ${(noClues || p.highSeen) ? "disabled" : ""}>High</button>
          <button class="ask-button low"  data-ask="lowest"  data-player="${p.id}" type="button" ${(noClues || p.lowSeen)  ? "disabled" : ""}>Low</button>
        </div>`)
      .join("") || '<p class="empty-state">No opponents with cards.</p>';

    const sel = $("tripletValue");
    if (myTurn && Array.isArray(st.readyTriplets)) {
      sel.innerHTML = `<option value="" selected disabled>Choose a value</option>${
        VALUES.map(v => {
          const sv = String(v);
          const ok = st.readyTriplets.includes(sv);
          return `<option value="${esc(sv)}">${esc(sv)} × 3${ok ? " ✓" : ""}</option>`;
        }).join("")}`;
    } else {
      sel.innerHTML = '<option value="" selected disabled>Not your turn</option>';
    }

    const lock = isRevealActive();
    $("tripletValue").disabled = !myTurn || st.isFinished || lock;
    $("claimTriplet").disabled = !myTurn || st.isFinished || lock;

    const canEnd = myTurn && !st.isFinished && st.turn.actions > 0 && !lock;
    $("endTurn").disabled    = !canEnd;
    $("endTurn").textContent = st.isFinished ? "Table complete" : "End turn";
  }

  function renderTimer(st) {
    const wrap = $("turnTimerWrap");
    if (!st || st.isFinished || !st.turnStartedAt) {
      wrap.hidden = true;
      stopTimer();
      return;
    }
    wrap.hidden = false;
    const duration   = st.difficulty === "hard" ? 25000 : 40000;
    const startedAt  = st.turnStartedAt;

    stopTimer();
    function tick() {
      const elapsed   = Date.now() - startedAt;
      const remaining = Math.max(0, duration - elapsed);
      const pct       = remaining / duration;

      $("turnTimerFill").style.width   = `${(pct * 100).toFixed(2)}%`;
      $("turnTimerLabel").textContent  = `${Math.ceil(remaining / 1000)}s`;

      const fill = $("turnTimerFill");
      fill.className = `turn-timer-fill${pct < 0.25 ? " danger" : pct < 0.5 ? " warning" : ""}`;

      if (remaining > 0) timerRaf = requestAnimationFrame(tick);
    }
    timerRaf = requestAnimationFrame(tick);
  }

  function stopTimer() {
    if (timerRaf) { cancelAnimationFrame(timerRaf); timerRaf = null; }
  }

  /* ─────────────────────────────────────────────────────────────
     Offline Game — render
  ───────────────────────────────────────────────────────────── */
  function renderOfflineGame() {
    if (!game) return;
    const cur    = game.currentPlayer;
    const winner = game.winnerId ? game.getPlayer(game.winnerId) : null;
    const clues  = game.getRemainingClues();

    $("roundLabel").textContent  = game.isFinished ? "Game complete" : `Round ${game.turnNumber}`;
    $("turnHeading").textContent = winner
      ? `${winner.name} wins!`
      : game.finishedReason ? "The deck is exhausted"
      : `${cur.name}'s turn`;

    $("turnStatus").innerHTML = winner
      ? `<strong>${esc(winner.name)} takes the win!</strong><span>${winner.sets.includes(7) ? "The 7 triplet sealed it." : "Completed 3 triplets."}</span>`
      : game.finishedReason
      ? `<strong>No winning triplet.</strong><span>${esc(game.finishedReason)}</span>`
      : `<strong>${clues} guess${clues !== 1 ? "es" : ""} remaining</strong><span>Match 2 same numbers to earn a 3rd guess!</span>`;

    // Scoreboard
    $("scoreboard").innerHTML = game.players.map(p => {
      const filled = p.sets.map(v => `<span class="set-dot filled">${esc(String(v))}</span>`).join("");
      const empty  = Array.from({ length: Math.max(0, 3 - p.sets.length) }, () => '<span class="set-dot">·</span>').join("");
      return `<div class="player-chip ${p.id === game.currentPlayer.id ? "current" : ""} ${p.penalized ? "penalized" : ""}">
        <span class="player-name">${esc(p.name)}</span>
        <div class="player-meta">
          <span>${p.hand.length} card${p.hand.length !== 1 ? "s" : ""}${p.penalized ? " · ⚠ skip" : ""}</span>
          <span class="set-dots">${filled}${empty}</span>
        </div>
      </div>`;
    }).join("");

    renderOfflineHand();
    renderOfflineMatrix();
    renderOfflineActions();
  }

  function renderOfflineHand() {
    const p = game.currentPlayer;
    $("handHeading").textContent = `${p.name}'s sorted hand`;
    $("handCount").textContent   = p.hand.length;
    $("handHint").textContent    = game.isFinished
      ? "Review the final state."
      : "Pass the device when the next player is ready to look.";
    $("hand").innerHTML = game.getHand(p.id).map(cardMarkup).join("")
      || '<p class="empty-state">No cards remain in this hand.</p>';
  }

  function renderOfflineMatrix() {
    const matrix  = $("matrix");
    matrix.style.setProperty("--matrix-columns", game.configuration.columns);

    const clues    = game.getRemainingClues();
    const noClues  = clues === 0 || game.isFinished;

    matrix.innerHTML = game.board.map(slot => {
      if (!slot.cardId) return '<div class="matrix-card empty">claimed</div>';
      const n       = slot.slot;
      const preview = previewSlot === n;
      const seen    = game.turn.seenSlots.has(n);
      const card    = game.getCard(slot.cardId);
      const canAct  = !game.isFinished && !isRevealActive();
      const dis     = !canAct || seen || noClues;
      const lbl     = preview ? `Matrix ${n + 1} revealed` : `Flip matrix ${n + 1}`;
      return `<button class="matrix-card${preview ? " preview" : ""}" data-slot="${n}" type="button" ${dis ? "disabled" : ""} aria-label="${lbl}">
        ${preview ? cardMarkup(card) : '<span class="card-back" aria-hidden="true"></span>'}
      </button>`;
    }).join("");

    const hint = $("matrixFlipHint");
    hint.textContent = `${clues} clue${clues !== 1 ? "s" : ""} left`;
    hint.className   = "matrix-flip-hint";

    $("matrixNote").textContent = previewSlot !== null
      ? "Memorize this card — turns face down again soon."
      : "Every matrix flip or opponent question costs 1 clue.";
  }

  function renderOfflineActions() {
    const clues = game.getRemainingClues();
    const max   = game.turn.maxActions;

    $("clueCount").innerHTML = game.isFinished
      ? "The game is complete."
      : `<span>${clues}</span> of ${max} clue${max !== 1 ? "s" : ""} available`;

    const noClues = clues === 0 || game.isFinished || isRevealActive();
    $("askList").innerHTML = game.players
      .filter(p => p.id !== game.currentPlayer.id && p.hand.length > 0)
      .map(p => {
        const asked  = game.turn.askedPlayers.get(p.id) || new Set();
        const hiDis  = noClues || asked.has("highest");
        const loDis  = noClues || asked.has("lowest");
        return `<div class="ask-row">
          <span class="ask-name">${esc(p.name)} <em>(${p.hand.length})</em></span>
          <button class="ask-button high" data-ask="highest" data-player="${p.id}" type="button" ${hiDis ? "disabled" : ""}>High</button>
          <button class="ask-button low"  data-ask="lowest"  data-player="${p.id}" type="button" ${loDis ? "disabled" : ""}>Low</button>
        </div>`;
      }).join("") || '<p class="empty-state">No opponents with cards.</p>';

    $("tripletValue").innerHTML = `<option value="" selected disabled>Choose a value</option>${
      VALUES.map(v => `<option value="${esc(String(v))}">${esc(String(v))} × 3</option>`).join("")}`;

    const lock = isRevealActive();
    $("tripletValue").disabled = game.isFinished || lock;
    $("claimTriplet").disabled = game.isFinished || lock;

    const canEnd = !game.isFinished && game.turn.actions > 0 && !lock;
    $("endTurn").disabled    = !canEnd;
    $("endTurn").textContent = game.isFinished ? "Table complete" : "End turn";
  }

  function safeOffline(fn) {
    try {
      fn();
    } catch (e) {
      showToast(e.message || "That move could not be completed.", true);
      renderOfflineGame();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     Offline Lobby
  ───────────────────────────────────────────────────────────── */
  function renderOfflineLobby() {
    $$('#countPicker').querySelectorAll("button").forEach(btn => {
      const sel = Number(btn.dataset.count) === selectedCount;
      btn.classList.toggle("selected", sel);
      btn.setAttribute("aria-pressed", String(sel));
    });
    const cfg = CONFIGURATIONS[selectedCount];
    $("dealSummary").textContent = `${cfg.handSize} cards per player · ${cfg.rows}×${cfg.columns} memory matrix`;
    $("nameFields").innerHTML = Array.from({ length: selectedCount }, (_, i) => `
      <label class="name-field">
        <span>${i + 1}</span>
        <input type="text" maxlength="18" data-name-index="${i}" value="Player ${i + 1}" aria-label="Name for player ${i + 1}" />
      </label>`).join("");
  }

  function startOfflineGame() {
    const names = [...$("nameFields").querySelectorAll("input")]
      .map((el, i) => el.value.trim() || `Player ${i + 1}`);
    game = new TripletGame({ playerNames: names, difficulty: "normal" });
    clearTimeout(revealTimer);
    previewSlot   = null;
    activeReveal  = null;
    $("revealPopup").hidden  = true;
    $("turnTimerWrap").hidden = true;
    $("difficultyBadge").hidden = true;
    $("connStatus").hidden   = true;
    showOnly("game");
    renderOfflineGame();
    showToast(`${game.currentPlayer.name} starts. Keep other hands private.`);
  }

  /* ─────────────────────────────────────────────────────────────
     Difficulty picker (online lobby)
  ───────────────────────────────────────────────────────────── */
  const DIFF_TAGS = {
    normal: ["3 triplets to win","4-second reveals","40-second turns","Bonus on any double"],
    hard:   ["4 triplets to win","3-second reveals","25-second turns","Bonus: new info only","Memory decay × 3 rounds"],
  };

  function updateDiffDesc(d) {
    $("diffDesc").innerHTML = (DIFF_TAGS[d] || DIFF_TAGS.normal).map(t => `<span>${t}</span>`).join("");
  }

  /* ─────────────────────────────────────────────────────────────
     Event listeners
  ───────────────────────────────────────────────────────────── */

  // ── Mode select ──
  $("goOnline")?.addEventListener("click", () => {
    mode = "online";
    if ($("connStatus")) $("connStatus").hidden = false;
    showOnly("onlineLobby");
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setConnStatus("reconnecting");
      connectWS();
    }
    // Pre-load room browser
    if (wsReady) sendWS({ type: "browse_rooms" });
  });

  // ── Quick Match button ──
  const qmBtn = $("quickMatch");
  if (qmBtn) {
    qmBtn.addEventListener("click", async () => {
      const name = $("createName")?.value.trim() || "Player";
      setLoading("quickMatch", true);
      const ok = await ensureWSConnected();
      setLoading("quickMatch", false);
      if (!ok) { showToast("Could not connect to multiplayer server. Please try again.", true); return; }
      sendWS({ type: "quick_match", name, difficulty: selectedDiff, token: accessToken });
    });
  }

  // ── Room browser: join from list ──
  const rbWrap = $("roomBrowserWrap");
  if (rbWrap) {
    rbWrap.addEventListener("click", async e => {
      const btn = e.target.closest("[data-join-code]");
      if (!btn) return;
      const code = btn.dataset.joinCode;
      const name = $("joinName")?.value.trim() || $("createName")?.value.trim() || "Player";
      const ok   = await ensureWSConnected();
      if (!ok) { showToast("Could not connect to server.", true); return; }
      sendWS({ type: "join_room", name, code, token: accessToken });
    });
    // Refresh room list button
    const refreshBtn = $("refreshRooms");
    if (refreshBtn) refreshBtn.addEventListener("click", async () => {
      const ok = await ensureWSConnected();
      if (ok) sendWS({ type: "browse_rooms" });
    });
  }

  $("goOffline")?.addEventListener("click", () => {
    mode = "offline";
    if ($("connStatus")) $("connStatus").hidden = true;
    showOnly("lobby");
    renderOfflineLobby();
  });

  $("backToMode")?.addEventListener("click", () => {
    mode = null;
    if ($("connStatus")) $("connStatus").hidden = true;
    showOnly("modeSelect");
  });

  $("brandHome")?.addEventListener("click", (e) => {
    e.preventDefault();
    if ($("game") && !$("game").hidden) {
      const confirm = mode === "online"
        ? window.confirm("Leave the current game? You can rejoin within 60 seconds.")
        : true;
      if (!confirm) return;
      stopTimer();
      clearTimeout(revealTimer);
      previewSlot = null; activeReveal = null;
      if ($("revealPopup")) $("revealPopup").hidden = true;
      mode = null;
      game = null;
      if ($("connStatus")) $("connStatus").hidden = true;
    }
    const user = window._auth ? window._auth.getUser() : null;
    if (user) {
      showOnly("modeSelect");
    } else {
      showOnly("authGate");
    }
  });

  // ── Online lobby: difficulty picker ──
  $("diffPicker")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-diff]");
    if (!btn) return;
    selectedDiff = btn.dataset.diff;
    $("diffPicker").querySelectorAll(".diff-btn").forEach(b => {
      const sel = b.dataset.diff === selectedDiff;
      b.classList.toggle("selected", sel);
      b.setAttribute("aria-pressed", String(sel));
    });
    updateDiffDesc(selectedDiff);
  });

  // ── Create room ──
  $("createRoom")?.addEventListener("click", async () => {
    const name = $("createName")?.value.trim() || "Player";
    setLoading("createRoom", true);
    const ok = await ensureWSConnected();
    setLoading("createRoom", false);
    if (!ok) { showToast("Could not connect to multiplayer server. Please try again.", true); return; }
    sendWS({ type: "create_room", name, difficulty: selectedDiff, token: accessToken });
  });
  $("createName")?.addEventListener("keydown", e => { if (e.key === "Enter") $("createRoom")?.click(); });

  // ── Join room ──
  $("joinRoom")?.addEventListener("click", async () => {
    const name = $("joinName")?.value.trim() || "Player";
    const code = $("joinCode")?.value.trim().toUpperCase() || "";
    if (code.length !== 6) { showToast("Enter a valid 6-character room code.", true); return; }
    setLoading("joinRoom", true);
    const ok = await ensureWSConnected();
    setLoading("joinRoom", false);
    if (!ok) { showToast("Could not connect to multiplayer server. Please try again.", true); return; }
    sendWS({ type: "join_room", name, code, token: accessToken });
  });
  $("joinCode")?.addEventListener("input",  e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""); });
  $("joinCode")?.addEventListener("keydown", e => { if (e.key === "Enter") $("joinRoom")?.click(); });

  // ── Waiting room ──
  $("startOnlineGame")?.addEventListener("click", () => sendWS({ type: "start_game" }));

  // ── Host controls: kick / transfer host ──
  $("waitingPlayerList")?.addEventListener("click", e => {
    const kickBtn     = e.target.closest("[data-kick]");
    const makeHostBtn = e.target.closest("[data-make-host]");
    if (kickBtn)     sendWS({ type: "kick_player",    targetId: kickBtn.dataset.kick });
    if (makeHostBtn) sendWS({ type: "transfer_host",  targetId: makeHostBtn.dataset.makeHost });
  });

  // ── Lobby chat ──
  const chatInput = $("lobbyChatInput");
  const chatSend  = $("lobbyChatSend");
  function sendChat() {
    if (!chatInput) return;
    const text = chatInput.value.trim();
    if (!text || !wsReady) return;
    sendWS({ type: "chat", text });
    chatInput.value = '';
  }
  if (chatSend)  chatSend.addEventListener("click", sendChat);
  if (chatInput) chatInput.addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

  $("leaveRoom")?.addEventListener("click", () => {
    if (ws) { ws.close(); ws = null; wsReady = false; }
    myPlayerId = null; myRoomCode = null; isHost = false;
    onlineState = null; waitingPlayers = [];
    stopTimer();
    mode = null;
    if ($("connStatus")) $("connStatus").hidden = true;
    showOnly("modeSelect");
  });

  $("copyCode")?.addEventListener("click", () => {
    if (!myRoomCode) return;
    navigator.clipboard.writeText(myRoomCode)
      .then(() => {
        if ($("copyLabel")) $("copyLabel").textContent = "✓ Copied!";
        if ($("copyCode")) $("copyCode").classList.add("copied");
        setTimeout(() => {
          if ($("copyLabel")) $("copyLabel").textContent = "⎘ Copy";
          if ($("copyCode")) $("copyCode").classList.remove("copied");
        }, 2200);
      })
      .catch(() => showToast("Code: " + myRoomCode, false));
  });

  // ── Offline lobby ──
  $("countPicker")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-count]");
    if (!btn) return;
    selectedCount = Number(btn.dataset.count);
    renderOfflineLobby();
  });
  $("startGame")?.addEventListener("click", startOfflineGame);

  // ── New table (from game view) ──
  $("newGame")?.addEventListener("click", () => {
    stopTimer();
    clearTimeout(revealTimer);
    previewSlot = null; activeReveal = null;
    if ($("revealPopup")) $("revealPopup").hidden = true;
    if (mode === "online") {
      if (ws) { ws.close(); ws = null; wsReady = false; }
      onlineState = null; myPlayerId = null; myRoomCode = null; waitingPlayers = [];
      mode = null;
      if ($("connStatus")) $("connStatus").hidden = true;
      showOnly("modeSelect");
    } else {
      game = null;
      mode = null;
      showOnly("modeSelect");
    }
  });

  // ── In-game actions ──
  $("game")?.addEventListener("click", e => {

    // Ask for high/low
    const askBtn = e.target.closest("[data-ask]");
    if (askBtn) {
      const targetId  = askBtn.dataset.player;
      const direction = askBtn.dataset.ask;
      if (mode === "online") {
        sendWS({ type: "ask", targetId, direction });
      } else {
        safeOffline(() => {
          const target = game.getPlayer(targetId);
          const result = game.ask(targetId, direction);
          beginTimedReveal({ title: `${target.name}'s ${direction} card`, card: result.card, duration: 4000 });
          if (result.bonus) showToast(`🎉 Bonus clue! ${game.currentPlayer.name} gets a 3rd clue this turn.`);
          else renderOfflineGame();
        });
      }
      return;
    }

    // Matrix flip
    const matBtn = e.target.closest("[data-slot]");
    if (matBtn) {
      const slot = Number(matBtn.dataset.slot);
      if (mode === "online") {
        sendWS({ type: "flip", slot });
      } else {
        safeOffline(() => {
          const result = game.flip(slot);
          beginTimedReveal({
            title:    `Matrix ${slot + 1}${result.free ? " (free flip)" : ""}`,
            card:     result.card,
            slot,
            duration: 4000,
          });
          if (result.bonus) showToast(`🎉 Bonus clue! ${game.currentPlayer.name} gets a 3rd clue.`);
          else renderOfflineGame();
        });
      }
      return;
    }

    // Animation Helpers
    function triggerTripletFlyAnimation(value) {
      const valStr = String(value);
      const overlay = document.createElement("div");
      overlay.className = "triplet-fly-overlay";
      overlay.innerHTML = `
        <div class="triplet-fly-title">✨ TRIPLET "${valStr}" CLAIMED! ✨</div>
        <div class="triplet-fly-cards">
          ${cardMarkup({ value: valStr, colour: "red" })}
          ${cardMarkup({ value: valStr, colour: "blue" })}
          ${cardMarkup({ value: valStr, colour: "green" })}
        </div>
      `;
      document.body.appendChild(overlay);
      setTimeout(() => overlay.remove(), 1600);
    }

    function triggerPanelShake() {
      const target = $("actionPanel") || $("matrixPanel") || $("game");
      if (!target) return;
      target.classList.add("shake-error");
      setTimeout(() => target.classList.remove("shake-error"), 600);
    }

    function triggerBonusGlow() {
      const target = $("turnStatus") || $("clueCount");
      if (!target) return;
      target.classList.add("bonus-glow-pulse");
      setTimeout(() => target.classList.remove("bonus-glow-pulse"), 1600);
    }

    // Claim triplet
    if (e.target.closest("#claimTriplet")) {
      const value = $("tripletValue").value;
      if (!value) { showToast("Select a triplet value first.", true); return; }
      if (mode === "online") {
        sendWS({ type: "claim_triplet", value });
      } else {
        safeOffline(() => {
          const result = game.claimTriplet(value);
          clearTimeout(revealTimer); previewSlot = null; activeReveal = null; $("revealPopup").hidden = true;
          
          if (result.wrongCall) {
            triggerPanelShake();
            showToast(`❌ Invalid triplet claim for "${value}"! Next turn skipped.`, true);
          } else {
            triggerTripletFlyAnimation(result.value || value);
            showToast(result.winner
              ? `🏆 ${result.winner.name} WINS!`
              : `✅ Triplet "${result.value}" claimed! Now ${game.currentPlayer.name}'s turn.`);
          }
          renderOfflineGame();
        });
      }
      return;
    }

    // End turn
    if (e.target.closest("#endTurn")) {
      if (mode === "online") {
        sendWS({ type: "end_turn" });
      } else {
        safeOffline(() => {
          const leaving = game.currentPlayer.name;
          game.endTurn();
          clearTimeout(revealTimer); previewSlot = null; activeReveal = null; $("revealPopup").hidden = true;
          renderOfflineGame();
          showToast(`${leaving} ended their turn. Pass device to ${game.currentPlayer.name}.`);
        });
      }
    }
  });

  // ── Rules dialog ──
  $("openRules")?.addEventListener("click", ()  => {
    const rd = $("rulesDialog");
    if (rd && !rd.open) rd.showModal();
  });
  $("closeRules")?.addEventListener("click", () => $("rulesDialog")?.close());
  $("rulesDialog")?.addEventListener("click", (e) => {
    if (e.target === $("rulesDialog")) $("rulesDialog").close();
  });

  /* ─────────────────────────────────────────────────────────────
     Init
  ───────────────────────────────────────────────────────────── */
  updateDiffDesc("normal");
  // NOTE: Auth is initialized by AuthModule below (after this IIFE closes).
  // Do NOT call initAuth() here — it is not defined yet at this point.

})();

/* ═══════════════════════════════════════════════════════════════════
   AUTH CONTROLLER  (runs outside IIFE so it can access DOM globals)
═══════════════════════════════════════════════════════════════════ */

(function AuthModule() {
  "use strict";

  /* ── DOM shortcuts ── */
  const $ = id => document.getElementById(id);
  const showOnly = id => (window.showOnly ? window.showOnly(id) : null);

  /* ── API base ── */
  const API = "/api";

  /* ── Expose to game IIFE ── */
  window._auth = {
    getToken: () => accessToken,
    getUser:  () => currentUser,
  };

  /* ──────────────────────────────────────────────────────────────
     Helpers
  ─────────────────────────────────────────────────────────────── */

  async function apiCall(method, path, body, token) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    };
    if (token) opts.headers["Authorization"] = `Bearer ${token}`;
    if (body)  opts.body = JSON.stringify(body);
    const res  = await fetch(API + path, opts);
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  function showAuthError(elId, msg) {
    const el = $(elId);
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function clearAuthError(elId) {
    const el = $(elId);
    if (el) { el.hidden = true; el.textContent = ""; }
  }

  function setLoading(btnId, loading) {
    const btn = $(btnId);
    if (!btn) return;
    btn.disabled = loading;
    btn._origText = btn._origText || btn.textContent;
    btn.textContent = loading ? "Please wait…" : btn._origText;
  }

  /* ──────────────────────────────────────────────────────────────
     Auth gate display
  ─────────────────────────────────────────────────────────────── */

  function showAuthGate() {
    const ag = $("authGate");
    if (!ag) return;
    try {
      if (!ag.open) ag.showModal();
    } catch {
      ag.setAttribute("open", "");
    }
  }

  function hideAuthGate() {
    const ag = $("authGate");
    if (ag && ag.open) ag.close();
    if (currentUser) {
      if ($("authTriggerBtn")) $("authTriggerBtn").hidden = true;
      if ($("profileBadge")) $("profileBadge").hidden = false;
    }
  }

  function showForm(id) {
    ["loginForm","registerForm","otpForm","forgotForm"].forEach(f => {
      const el = $(f);
      if (el) el.hidden = f !== id;
    });
  }

  /* ──────────────────────────────────────────────────────────────
     Profile badge update
  ─────────────────────────────────────────────────────────────── */

  function updateProfileBadge(user, elo) {
    if (!user) return;
    const initial = user.username.charAt(0).toUpperCase();
    $("profileAvatar").textContent   = initial;
    $("profileUsername").textContent = user.username;
    $("profileElo").textContent      = `ELO ${elo || user.elo || 1200}`;
    if (user.is_admin) $("openAdminPanel").hidden = false;
  }

  /* ──────────────────────────────────────────────────────────────
     Token refresh (silent, runs every 13 min)
  ─────────────────────────────────────────────────────────────── */

  async function refreshTokenSilently() {
    try {
      const data = await apiCall("POST", "/auth/refresh");
      accessToken = data.accessToken;
    } catch {
      // Refresh token expired — show auth gate
      onLogout();
    }
  }

  /* ──────────────────────────────────────────────────────────────
     Login success handler
  ─────────────────────────────────────────────────────────────── */

  function onLoginSuccess(data) {
    accessToken  = data.accessToken;
    currentUser  = data.user;
    hideAuthGate();
    updateProfileBadge(currentUser);
    // Silent refresh every 13 minutes
    setInterval(refreshTokenSilently, 13 * 60 * 1000);
    showEloToast(0, "Logged in as " + currentUser.username, false);
  }

  function onLogout() {
    accessToken = null;
    currentUser = null;
    showAuthGate();
    showForm("loginForm");
  }

  /* ──────────────────────────────────────────────────────────────
     ELO Toast
  ─────────────────────────────────────────────────────────────── */

  function showEloToast(delta, titleOverride, isElo = true) {
    const toast = $("eloToast");
    if (!toast) return;
    $("eloToastTitle").textContent = titleOverride || (isElo ? "ELO Updated" : "Welcome!");
    const deltaEl = $("eloToastDelta");
    if (isElo) {
      deltaEl.textContent = delta >= 0 ? `+${delta}` : String(delta);
      deltaEl.className = `elo-toast-delta ${delta < 0 ? "negative" : ""}`;
    } else {
      deltaEl.textContent = titleOverride ? "" : "";
    }
    toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.hidden = true; }, 5000);
  }

  // Listen for elo_update from WebSocket (dispatched by game IIFE)
  document.addEventListener("elo_update", (e) => {
    const { delta, eloAfter, position } = e.detail;
    $("profileElo").textContent = `ELO ${eloAfter}`;
    showEloToast(delta, position === 1 ? "🏆 Victory!" : "Match Result", true);
  });

  /* ──────────────────────────────────────────────────────────────
     Tab switching
  ─────────────────────────────────────────────────────────────── */

  function switchTab(active) {
    ["login", "register"].forEach(t => {
      const tab = $(`tab-${t}`);
      if (tab) {
        tab.classList.toggle("active", t === active);
        tab.setAttribute("aria-selected", t === active ? "true" : "false");
      }
    });
    showForm(active === "login" ? "loginForm" : "registerForm");
  }

  $("tab-login")?.addEventListener("click",    () => switchTab("login"));
  $("tab-register")?.addEventListener("click", () => switchTab("register"));

  /* ──────────────────────────────────────────────────────────────
     LOGIN
  ─────────────────────────────────────────────────────────────── */

  $("loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAuthError("loginError");
    const identifier = $("loginIdentifier").value.trim();
    const password   = $("loginPassword").value;
    if (!identifier || !password) return showAuthError("loginError", "Please fill in all fields.");
    setLoading("loginSubmit", true);
    try {
      const data = await apiCall("POST", "/auth/login", { identifier, password });
      onLoginSuccess(data);
    } catch (err) {
      showAuthError("loginError", err.message);
    } finally {
      setLoading("loginSubmit", false);
    }
  });

  /* ──────────────────────────────────────────────────────────────
     REGISTER
  ─────────────────────────────────────────────────────────────── */

  $("registerForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAuthError("registerError");
    const username = $("regUsername").value.trim();
    const email    = $("regEmail").value.trim();
    const phone    = $("regPhone")?.value.trim() || "";
    const password = $("regPassword").value;
    if (!username || !email || !password) return showAuthError("registerError", "Please fill in all required fields.");
    setLoading("registerSubmit", true);
    try {
      const data = await apiCall("POST", "/auth/register", { username, email, phone, password });
      onLoginSuccess(data);
    } catch (err) {
      showAuthError("registerError", err.message);
    } finally {
      setLoading("registerSubmit", false);
    }
  });

  /* ──────────────────────────────────────────────────────────────
     OTP VERIFICATION
  ─────────────────────────────────────────────────────────────── */

  $("otpForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAuthError("otpError");
    const otp = $("otpCode").value.trim();
    if (otp.length !== 6) return showAuthError("otpError", "Please enter the 6-digit code.");
    setLoading("otpSubmit", true);
    try {
      const data = await apiCall("POST", "/auth/verify-email", { email: pendingEmail, otp });
      // Fetch user profile
      const me = await apiCall("GET", "/auth/me", null, data.accessToken);
      onLoginSuccess({ accessToken: data.accessToken, user: { ...me, elo: me.elo || 1200 } });
    } catch (err) {
      showAuthError("otpError", err.message);
    } finally {
      setLoading("otpSubmit", false);
    }
  });

  $("resendOtpBtn")?.addEventListener("click", async () => {
    if (!pendingEmail) return;
    try {
      await apiCall("POST", "/auth/resend-otp", { email: pendingEmail, purpose: "verify_email" });
      if ($("otpCode")) $("otpCode").value = "";
      showAuthError("otpError", "✅ New verification code sent to your email!");
    } catch (err) {
      showAuthError("otpError", err.message);
    }
  });

  /* ──────────────────────────────────────────────────────────────
     FORGOT / RESET PASSWORD
  ─────────────────────────────────────────────────────────────── */

  $("forgotPasswordBtn")?.addEventListener("click", () => {
    forgotPhase = "email";
    $("resetCodeField").hidden = true;
    $("newPassField").hidden   = true;
    $("forgotSubmit")._origText = null;
    $("forgotSubmit").textContent = "Send Reset Code";
    clearAuthError("forgotError");
    showForm("forgotForm");
  });

  $("backToLoginBtn")?.addEventListener("click", () => showForm("loginForm"));

  $("forgotForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAuthError("forgotError");

    if (forgotPhase === "email") {
      const email = $("forgotEmail").value.trim();
      if (!email) return showAuthError("forgotError", "Please enter your email.");
      setLoading("forgotSubmit", true);
      try {
        await apiCall("POST", "/auth/forgot-password", { email });
        pendingEmail = email;
        forgotPhase  = "code";
        $("resetCodeField").hidden = false;
        $("newPassField").hidden   = false;
        $("forgotSubmit").textContent = "Reset Password";
        $("forgotSubmit")._origText   = "Reset Password";
        showAuthError("forgotError", "✅ If that email is registered, a code was sent.");
      } catch (err) {
        showAuthError("forgotError", err.message);
      } finally {
        setLoading("forgotSubmit", false);
      }
    } else {
      const otp         = $("resetCode").value.trim();
      const newPassword = $("newPassword").value;
      if (!otp || !newPassword) return showAuthError("forgotError", "Please fill in the code and new password.");
      setLoading("forgotSubmit", true);
      try {
        await apiCall("POST", "/auth/reset-password", { email: pendingEmail, otp, newPassword });
        showAuthError("forgotError", "✅ Password reset! Please log in.");
        setTimeout(() => showForm("loginForm"), 1500);
      } catch (err) {
        showAuthError("forgotError", err.message);
      } finally {
        setLoading("forgotSubmit", false);
      }
    }
  });

  /* ──────────────────────────────────────────────────────────────
     GUEST MODE
  ─────────────────────────────────────────────────────────────── */

  $("guestModeBtn")?.addEventListener("click", () => {
    currentUser = { username: "Guest", id: null, is_admin: false, elo: null };
    if ($("profileBadge")) $("profileBadge").hidden = false;
    if ($("authTriggerBtn")) $("authTriggerBtn").hidden = true;
    if ($("profileAvatar")) $("profileAvatar").textContent = "G";
    if ($("profileUsername")) $("profileUsername").textContent = "Guest";
    if ($("profileElo")) $("profileElo").textContent = "No ELO (Guest)";
    hideAuthGate();
  });

  $("closeAuthBtn")?.addEventListener("click", () => $("authGate")?.close());
  $("authGate")?.addEventListener("click", (e) => {
    if (e.target === $("authGate")) $("authGate").close();
  });

  /* ──────────────────────────────────────────────────────────────
     LOGOUT
  ─────────────────────────────────────────────────────────────── */

  $("logoutBtn")?.addEventListener("click", async () => {
    try { await apiCall("POST", "/auth/logout", null, accessToken); } catch {}
    onLogout();
  });

  /* ──────────────────────────────────────────────────────────────
     Auth trigger button (header)
  ─────────────────────────────────────────────────────────────── */

  $("authTriggerBtn")?.addEventListener("click", () => {
    showAuthGate();
    showForm("loginForm");
  });

  /* ──────────────────────────────────────────────────────────────
     LEADERBOARD
  ─────────────────────────────────────────────────────────────── */

  let lbPage    = 1;
  let lbSearch  = "";
  let lbSeason  = "";
  let lbTotal   = 0;
  const LB_LIMIT = 25;

  const TIER_COLORS = {
    "Grand Master": { bg: "rgba(255,107,53,0.15)",  color: "#ff6b35" },
    "Master":       { bg: "rgba(168,85,247,0.12)",  color: "#a855f7" },
    "Diamond":      { bg: "rgba(56,189,248,0.12)",  color: "#38bdf8" },
    "Platinum":     { bg: "rgba(52,211,153,0.12)",  color: "#34d399" },
    "Gold":         { bg: "rgba(251,191,36,0.15)",  color: "#fbbf24" },
    "Silver":       { bg: "rgba(148,163,184,0.15)", color: "#94a3b8" },
    "Bronze":       { bg: "rgba(180,87,9,0.12)",    color: "#b45309" },
  };

  async function loadLeaderboard() {
    const body = $("lbBody");
    if (!body) return;
    body.innerHTML = `<tr><td colspan="7" class="lb-loading">Loading…</td></tr>`;
    try {
      const params = new URLSearchParams({
        page: lbPage, limit: LB_LIMIT, q: lbSearch,
        ...(lbSeason ? { season: lbSeason } : {}),
      });
      const data = await apiCall("GET", `/leaderboard?${params}`);
      lbTotal = data.total;
      $("lbPageInfo").textContent = `Page ${lbPage} of ${data.totalPages || 1}`;
      $("lbPrevPage").disabled = lbPage <= 1;
      $("lbNextPage").disabled = lbPage >= (data.totalPages || 1);

      body.innerHTML = data.players.map((p, i) => {
        const rank    = (lbPage - 1) * LB_LIMIT + i + 1;
        const medal   = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "";
        const tier    = p.tier || {};
        const tc      = TIER_COLORS[tier.label] || TIER_COLORS["Bronze"];
        const isMe    = currentUser?.id === p.id;
        return `
          <tr${isMe ? " class='lb-my-row'" : ""}>
            <td>${medal ? `<span class="lb-rank-medal">${medal}</span>` : `<span class="lb-rank-num">${rank}</span>`}</td>
            <td>
              <div class="lb-player-cell">
                <div class="lb-avatar">${p.username.charAt(0).toUpperCase()}</div>
                <span class="lb-username">${escHtml(p.username)}</span>
                ${isMe ? '<span class="lb-you-badge">YOU</span>' : ""}
              </div>
            </td>
            <td>
              <span class="lb-tier-badge" style="background:${tc.bg};color:${tc.color}">
                ${tier.icon || ""} ${tier.label || ""}
              </span>
            </td>
            <td class="lb-elo-val">${p.elo}</td>
            <td>${p.wins}</td>
            <td>${p.losses}</td>
            <td>${p.winRate}</td>
          </tr>`;
      }).join("") || `<tr><td colspan="7" class="lb-loading">No players found.</td></tr>`;
    } catch (err) {
      body.innerHTML = `<tr><td colspan="7" class="lb-loading">Failed to load: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function escHtml(str) {
    return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  async function loadMyRank() {
    if (!accessToken || !currentUser?.id) return;
    try {
      const data = await apiCall("GET", "/leaderboard/me", null, accessToken);
      const card = $("myRankCard");
      card.hidden = false;
      $("myRankNumber").textContent = `#${data.rank}`;
      $("myRankTier").textContent   = `${data.tier?.icon || ""} ${data.tier?.label || ""}`;
      $("myRankElo").textContent    = data.elo;
      $("myRankWins").textContent   = data.wins;
      $("myRankGames").textContent  = data.games_played;
      $("myRankWR").textContent     = data.winRate;

      const hist = $("myRankHistory");
      hist.innerHTML = (data.recentMatches || []).map(m =>
        `<span class="rank-history-item ${m.position === 1 ? 'win' : 'loss'}">${m.position === 1 ? "W" : "L"} ${m.elo_delta >= 0 ? "+" : ""}${m.elo_delta}</span>`
      ).join("");
    } catch {}
  }

  function openLeaderboard() {
    const modal = $("leaderboardModal");
    if (!modal) return;
    try {
      if (!modal.open) modal.showModal();
    } catch {
      modal.setAttribute("open", "");
    }
    lbPage = 1; lbSearch = ""; lbSeason = "";
    if ($("lbSearch")) $("lbSearch").value = "";
    loadLeaderboard();
    loadMyRank();
  }

  $("leaderboardModal")?.addEventListener("click", (e) => {
    if (e.target === $("leaderboardModal")) $("leaderboardModal").close();
  });
  $("adminModal")?.addEventListener("click", (e) => {
    if (e.target === $("adminModal")) $("adminModal").close();
  });

  $("openLeaderboard")?.addEventListener("click",        openLeaderboard);
  $("leaderboardTriggerBtn")?.addEventListener("click",  openLeaderboard);
  $("lbMyRankBtn")?.addEventListener("click",            loadMyRank);

  $("lbPrevPage")?.addEventListener("click", () => { if (lbPage > 1) { lbPage--; loadLeaderboard(); } });
  $("lbNextPage")?.addEventListener("click", () => { lbPage++; loadLeaderboard(); });
  $("lbSeasonSelect")?.addEventListener("change", (e) => { lbSeason = e.target.value; lbPage = 1; loadLeaderboard(); });

  let lbSearchTimer;
  $("lbSearch")?.addEventListener("input", (e) => {
    lbSearch = e.target.value.trim();
    clearTimeout(lbSearchTimer);
    lbSearchTimer = setTimeout(() => { lbPage = 1; loadLeaderboard(); }, 350);
  });

  /* ──────────────────────────────────────────────────────────────
     ADMIN PANEL
  ─────────────────────────────────────────────────────────────── */

  async function loadAdminStats() {
    try {
      const data = await apiCall("GET", "/admin/stats", null, accessToken);
      $("asTotalUsers").textContent  = data.totalUsers;
      $("asVerified").textContent    = data.verifiedUsers;
      $("asBanned").textContent      = data.bannedUsers;
      $("asMatches").textContent     = data.totalMatches;
      $("asNewToday").textContent    = data.newUsersToday;
      $("asMatchesToday").textContent= data.matchesToday;
    } catch {}
  }

  $("openAdminPanel")?.addEventListener("click", () => {
    $("adminModal").showModal();
    loadAdminStats();
  });

  $("adminAnnounceBtn")?.addEventListener("click", async () => {
    const msg = $("adminAnnouncement")?.value.trim();
    if (!msg) return;
    try {
      await apiCall("POST", "/admin/announce", { message: msg }, accessToken);
      $("adminAnnouncement").value = "";
      alert("Announcement sent!");
    } catch (err) { alert(err.message); }
  });

  $("adminUserSearchBtn")?.addEventListener("click", async () => {
    const q    = $("adminUserSearch")?.value.trim() || "";
    const body = $("adminUserBody");
    if (!body) return;
    body.innerHTML = `<tr><td colspan="6" class="lb-loading">Searching…</td></tr>`;
    try {
      const data = await apiCall("GET", `/admin/users?q=${encodeURIComponent(q)}&limit=20`, null, accessToken);
      body.innerHTML = data.users.map(u => `
        <tr>
          <td>${u.id}</td>
          <td><strong>${escHtml(u.username)}</strong></td>
          <td>${escHtml(u.email)}</td>
          <td>${u.elo || 1200}</td>
          <td>${u.is_banned ? "<span style='color:var(--red);font-weight:700'>Banned</span>" : u.is_verified ? "Active" : "Unverified"}</td>
          <td>
            ${u.is_banned
              ? `<button class="admin-action-btn admin-action-unban" onclick="adminAction(${u.id},'unban')">Unban</button>`
              : `<button class="admin-action-btn admin-action-ban" onclick="adminAction(${u.id},'ban')">Ban</button>`}
          </td>
        </tr>
      `).join("") || `<tr><td colspan="6" class="lb-loading">No users found.</td></tr>`;
    } catch (err) {
      body.innerHTML = `<tr><td colspan="6" class="lb-loading">${escHtml(err.message)}</td></tr>`;
    }
  });

  // Global admin action (called from table onclick)
  window.adminAction = async function(userId, action) {
    const reason = action === "ban" ? prompt("Ban reason:") : undefined;
    if (action === "ban" && !reason) return;
    try {
      await apiCall("PATCH", `/admin/users/${userId}`, { action, reason }, accessToken);
      $("adminUserSearchBtn").click(); // refresh table
    } catch (err) { alert(err.message); }
  };

  /* ──────────────────────────────────────────────────────────────
     INIT — try silent refresh first, else show auth gate
  ─────────────────────────────────────────────────────────────── */

  async function initAuthFlow() {
    showOnly("modeSelect");

    try {
      // Try silent re-login via refresh cookie from previous session
      const data = await apiCall("POST", "/auth/refresh");
      accessToken = data.accessToken;
      const me = await apiCall("GET", "/auth/me", null, accessToken);
      onLoginSuccess({ accessToken, user: { ...me, elo: me.elo || 1200 } });
    } catch {
      // Unauthenticated: stay on landing page (modeSelect), show Sign In button
      if ($("authTriggerBtn")) $("authTriggerBtn").hidden = false;
      if ($("profileBadge")) $("profileBadge").hidden = true;
    }
  }

  // Expose for external reference, then boot immediately
  window.initAuth = initAuthFlow;
  initAuthFlow();

})();
