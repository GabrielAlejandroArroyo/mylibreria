const audio = document.querySelector("#audio");
const viewEl = document.querySelector("#view");
const tagList = document.querySelector("#tag-list");
const searchInput = document.querySelector("#search");
const panel = document.querySelector("#panel");
const panelBody = document.querySelector("#panel-body");
const shell = document.querySelector(".shell");

const state = {
  tracks: [],
  tags: [],
  view: "inicio",
  tag: "",
  query: "",
  queue: [],
  index: -1,
  shuffle: false,
  repeat: "off",
  tab: "letra",
  likes: new Set(JSON.parse(localStorage.getItem("suno-likes") || "[]")),
  recent: JSON.parse(localStorage.getItem("suno-recent") || "[]"),
  lyrics: new Map(),
  seeking: false,
  localApi: "",
  nuevos: [],
  syncing: false,
  embedTimer: 0,
  embedTick: 0,
  embedStarted: 0,
  usingEmbed: false,
  embedPool: new Map(),
  warmVisibleTimer: 0,
  hoverWarmTimer: 0,
};

const EMBED_POOL_MAX = 6;
const CLOUDFRONT_CLIP = (id) => `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${encodeURIComponent(id)}.m4a`;

const PLAY = `<svg viewBox="0 0 24 24"><path d="M8 5v14l12-7z"/></svg>`;
const PAUSE = `<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>`;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" });
}

function hue(text) {
  let hash = 0;
  for (const char of text) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function coverStyle(track) {
  const color = `hsl(${hue(track.titulo)} 42% 32%)`;
  const safeUrl = String(track.portada || "").replaceAll("'", "%27");
  if (!safeUrl) return `background-color:${color}`;
  return `background-color:${color};background-image:url('${safeUrl}');background-size:cover;background-position:center`;
}

function currentTrack() {
  return state.queue[state.index] || null;
}

function isEmbedPlaying() {
  return state.usingEmbed && Boolean(state.embedStarted);
}

function isPlaybackPaused() {
  if (isEmbedPlaying()) return false;
  if (!currentTrack()) return true;
  return audio.paused;
}

function isTrackPlaying(track) {
  if (!track || currentTrack()?.id !== track.id) return false;
  return isEmbedPlaying() || !audio.paused;
}

function matchesQuery(track, query) {
  if (!query) return true;
  const haystack = `${track.titulo} ${track.estilo} ${track.etiquetas.join(" ")} ${track.autor}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

function visibleTracks() {
  const query = state.query.trim().toLowerCase();
  return state.tracks.filter((track) => {
    if (state.view === "gustos" && !state.likes.has(track.id)) return false;
    if (state.view === "nuevos" && !track.nuevo && !state.nuevos.includes(track.id)) return false;
    if (state.tag && !track.etiquetas.includes(state.tag)) return false;
    return matchesQuery(track, query);
  });
}

function byId(id) {
  return state.tracks.find((track) => track.id === id);
}

function saveLikes() {
  localStorage.setItem("suno-likes", JSON.stringify([...state.likes]));
}

function remember(track) {
  state.recent = [track.id, ...state.recent.filter((id) => id !== track.id)].slice(0, 24);
  localStorage.setItem("suno-recent", JSON.stringify(state.recent));
}

function syncNavUi(name, tag = "") {
  document.querySelectorAll(".sidebar .nav-btn, .mobile-nav [data-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === name && !tag);
  });
  document.querySelectorAll(".tag-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tag === tag);
  });
}

/** Cambia la vista del catálogo sin pausar ni cambiar el tema en reproducción. */
function navigateTo(name, { tag = "", clearSearch = true } = {}) {
  state.view = name;
  state.tag = tag;
  if (clearSearch) {
    state.query = "";
    searchInput.value = "";
  }
  syncNavUi(name, tag);
  closeFicha();
  render();
  paintPlayer();
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Buenos días";
  if (hour < 19) return "Buenas tardes";
  return "Buenas noches";
}

function card(track) {
  const playing = isTrackPlaying(track);
  return `
    <article class="card" data-id="${track.id}">
      <div class="card-cover" style="${coverStyle(track)}"></div>
      <button class="play-fab" data-play="${track.id}" aria-label="Reproducir">${playing ? PAUSE : PLAY}</button>
      <h3>${escapeHtml(track.titulo)}${track.nuevo ? '<span class="badge-new">NUEVO</span>' : ""}</h3>
      <p>${escapeHtml(track.etiquetas.slice(0, 2).join(" · ") || track.autor)}</p>
    </article>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function row(track, index) {
  const playing = isTrackPlaying(track);
  const chips = track.etiquetas.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("");
  return `
    <tr class="track ${playing ? "is-current" : ""}" data-id="${track.id}">
      <td class="num">${playing ? "▶" : index + 1}</td>
      <td>
        <div class="title-cell">
          <div class="row-cover" style="${coverStyle(track)}"></div>
          <div class="stack">
            <strong>${escapeHtml(track.titulo)}${track.nuevo ? '<span class="badge-new">NUEVO</span>' : ""}</strong>
            <span class="muted">${escapeHtml(track.autor)}${track.instrumental ? " · Instrumental" : ""}</span>
          </div>
        </div>
      </td>
      <td><div class="chips">${chips}</div></td>
      <td class="when">${formatDate(track.creado)}</td>
      <td class="dur">${formatTime(track.duracion_seg)}</td>
    </tr>`;
}

function table(tracks, title) {
  if (!tracks.length) {
    return `<div class="empty">No hay temas para mostrar.</div>`;
  }
  const rows = tracks.map((track, index) => row(track, index)).join("");
  return `
    <div class="section-head"><h2>${escapeHtml(title)}</h2><span class="muted">${tracks.length} temas</span></div>
    <table class="list">
      <thead><tr><th>#</th><th>Título</th><th>Estilo</th><th>Fecha</th><th>Duración</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function rowStrip(title, tracks, action) {
  if (!tracks.length) return "";
  return `
    <section>
      <div class="section-head">
        <h2>${escapeHtml(title)}</h2>
        ${action ? `<button class="linkish" data-jump="${action}">Mostrar todo</button>` : ""}
      </div>
      <div class="cards">${tracks.slice(0, 14).map(card).join("")}</div>
    </section>`;
}

function renderHome() {
  const latest = state.tracks[0];
  const recent = state.recent.map(byId).filter(Boolean);
  const popular = [...state.tracks].sort((a, b) => b.reproducciones - a.reproducciones).slice(0, 14);
  const liked = state.tracks.filter((track) => state.likes.has(track.id));
  const hero = latest
    ? `
      <section class="hero">
        <div class="hero-cover" style="${coverStyle(latest)}">
          <button class="play-fab" data-play="${latest.id}" aria-label="Reproducir">${PLAY}</button>
        </div>
        <div>
          <div class="kicker">Recién bajado</div>
          <h1>${escapeHtml(latest.titulo)}</h1>
          <p>${escapeHtml(latest.estilo_corto || latest.autor)}</p>
          <div class="row-actions">
            <button class="btn-green" data-play-all="recientes">Reproducir</button>
            <button class="btn-ghost" data-jump="biblioteca">Ver biblioteca</button>
          </div>
        </div>
      </section>`
    : `<div class="empty">Todavía no hay temas bajados.</div>`;

  viewEl.innerHTML = `
    <div class="kicker">${greeting()}</div>
    ${hero}
    ${rowStrip("Escuchados hace un rato", recent)}
    ${rowStrip("Los más reproducidos en Suno", popular)}
    ${rowStrip("Recién llegados de Suno", state.tracks.filter((track) => track.nuevo), "nuevos")}
    ${rowStrip("Tus me gusta", liked, "gustos")}
    ${rowStrip("Últimos temas", state.tracks.slice(0, 14), "biblioteca")}`;
}

function render() {
  const tracks = visibleTracks();
  if (state.view === "inicio" && !state.query && !state.tag) {
    renderHome();
    scheduleWarmVisible();
    return;
  }
  if (state.view === "buscar" && !state.query && !state.tag) {
    viewEl.innerHTML = `
      <div class="section-head"><h2>Buscar en la biblioteca</h2></div>
      <div class="cards wrap">${state.tracks.slice(0, 18).map(card).join("")}</div>`;
    scheduleWarmVisible();
    return;
  }
  const title = state.tag || (state.view === "gustos" ? "Me gusta" : state.view === "nuevos" ? "Temas nuevos" : state.query ? `Resultados de “${state.query}”` : "Tu biblioteca");
  if (state.view === "buscar" || state.tag) {
    viewEl.innerHTML = `
      <div class="section-head"><h2>${escapeHtml(title)}</h2><span class="muted">${tracks.length} temas</span></div>
      <div class="cards wrap">${tracks.map(card).join("") || `<div class="empty">Nada coincide con esa búsqueda.</div>`}</div>
      ${tracks.length ? table(tracks, "Lista") : ""}`;
    scheduleWarmVisible();
    return;
  }
  viewEl.innerHTML = table(tracks, title);
  scheduleWarmVisible();
}

function renderTags() {
  tagList.innerHTML = state.tags
    .map((tag) => `<button type="button" class="tag-btn" data-tag="${escapeHtml(tag)}"><span class="dot"></span>${escapeHtml(tag)}</button>`)
    .join("");
}

function paintPlayer() {
  const track = currentTrack();
  const title = document.querySelector("#now-title");
  const artist = document.querySelector("#now-artist");
  const cover = document.querySelector("#now-cover");
  const like = document.querySelector("#like-btn");
  const link = document.querySelector("#suno-link");
  const isPaused = isPlaybackPaused();
  document.querySelector("#play-icon").outerHTML = isPaused ? PLAY.replace("<svg", '<svg id="play-icon"') : PAUSE.replace("<svg", '<svg id="play-icon"');
  document.querySelector("#shuffle").classList.toggle("is-on", state.shuffle);
  document.querySelector("#repeat").classList.toggle("is-on", state.repeat !== "off");
  document.querySelector("#repeat").dataset.mode = state.repeat;
  if (!track) {
    title.textContent = "Elegí un tema";
    artist.textContent = `${state.tracks.length} temas en la biblioteca`;
    cover.style.cssText = "";
    like.classList.remove("is-on");
    link.hidden = true;
    return;
  }
  title.textContent = track.titulo;
  artist.textContent = track.etiquetas[0] || track.autor;
  cover.style.cssText = coverStyle(track);
  like.classList.toggle("is-on", state.likes.has(track.id));
  like.textContent = state.likes.has(track.id) ? "♥" : "♡";
  link.hidden = true;
  document.title = `${track.titulo} — Suno`;
  paintFicha(isPaused);
}

function fichaEl() {
  return document.querySelector("#ficha");
}

function openFicha() {
  fichaEl().hidden = false;
  paintFicha(isPlaybackPaused());
}

function closeFicha() {
  fichaEl().hidden = true;
}

async function paintFicha(isPaused) {
  const sheet = fichaEl();
  if (!sheet || sheet.hidden) return;
  const track = currentTrack();
  if (!track) return;
  document.querySelector("#ficha-cover").style.cssText = coverStyle(track);
  document.querySelector("#ficha-bg").style.cssText = coverStyle(track);
  document.querySelector("#ficha-title").textContent = track.titulo;
  document.querySelector("#ficha-artist").textContent = track.etiquetas.join(" · ") || track.autor;
  document.querySelector("#ficha-chips").innerHTML = track.etiquetas
    .map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`)
    .join("");
  document.querySelector("#ficha-play-icon").outerHTML = isPaused
    ? PLAY.replace("<svg", '<svg id="ficha-play-icon"')
    : PAUSE.replace("<svg", '<svg id="ficha-play-icon"');
  document.querySelector("#ficha-total").textContent = formatTime(track.duracion_seg);
  const lyricsBox = document.querySelector("#ficha-lyrics");
  lyricsBox.setAttribute("contenteditable", "false");
  if (lyricsBox.dataset.track === track.id) return;
  lyricsBox.dataset.track = track.id;
  lyricsBox.innerHTML = `<p class="muted">Cargando letra…</p>`;
  const lyrics = await loadLyrics(track);
  if (currentTrack()?.id !== track.id || sheet.hidden) return;
  lyricsBox.innerHTML = formatLyrics(lyrics);
}

function audioUrl(track) {
  if (state.localApi) return `${state.localApi}/api/audio/${track.id}`;
  if (track.audio_web) return track.audio_web;
  return "";
}

function embedFrame() {
  return document.querySelector("#embed-player");
}

function embedPoolEl() {
  return document.querySelector("#embed-pool");
}

function embedPlayUrl(trackId) {
  return `https://suno.com/embed/${encodeURIComponent(trackId)}?autoplay=1`;
}

function embedWarmUrl(trackId) {
  return `https://suno.com/embed/${encodeURIComponent(trackId)}`;
}

function shouldUseEmbedPool() {
  return !state.localApi;
}

function prefetchClipMedia(trackId) {
  if (!trackId) return;
  fetch(CLOUDFRONT_CLIP(trackId), { mode: "no-cors", cache: "force-cache" }).catch(() => {});
}

function evictEmbedPool(keepIds = new Set()) {
  if (state.embedPool.size < EMBED_POOL_MAX) return;
  const playingId = currentTrack()?.id;
  if (playingId) keepIds.add(playingId);
  for (const [trackId, entry] of state.embedPool) {
    if (state.embedPool.size < EMBED_POOL_MAX) break;
    if (keepIds.has(trackId)) continue;
    entry.iframe.remove();
    state.embedPool.delete(trackId);
  }
}

function warmEmbed(trackId, { intent = false } = {}) {
  if (!shouldUseEmbedPool() || !trackId) return;
  const existing = state.embedPool.get(trackId);
  if (existing) {
    if (intent && !existing.intent) {
      existing.intent = true;
      existing.status = "loading";
      existing.iframe.src = embedPlayUrl(trackId);
    }
    return;
  }
  evictEmbedPool(new Set([trackId]));
  const pool = embedPoolEl();
  if (!pool) return;
  const iframe = document.createElement("iframe");
  iframe.className = "embed-engine embed-pool-frame";
  iframe.title = "Precarga";
  iframe.allow = "autoplay; encrypted-media; clipboard-write";
  iframe.src = intent ? embedPlayUrl(trackId) : embedWarmUrl(trackId);
  pool.appendChild(iframe);
  const entry = { iframe, status: "loading", intent, trackId };
  state.embedPool.set(trackId, entry);
  iframe.addEventListener(
    "load",
    () => {
      if (state.embedPool.get(trackId) === entry) entry.status = "ready";
    },
    { once: true },
  );
  prefetchClipMedia(trackId);
}

function visibleTrackIds() {
  const ids = [];
  const seen = new Set();
  for (const node of viewEl.querySelectorAll(".card[data-id], tr.track[data-id]")) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom < -24 || rect.top > window.innerHeight + 24) continue;
    const id = node.dataset.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.slice(0, EMBED_POOL_MAX);
}

function scheduleWarmVisible() {
  if (!shouldUseEmbedPool()) return;
  window.clearTimeout(state.warmVisibleTimer);
  state.warmVisibleTimer = window.setTimeout(() => {
    visibleTrackIds().forEach((trackId, index) => {
      window.setTimeout(() => warmEmbed(trackId), index * 250);
    });
  }, 100);
}

function retireEmbedFrame(iframe) {
  if (!iframe) return;
  iframe.removeAttribute("id");
  iframe.className = "embed-engine embed-pool-frame";
  iframe.removeAttribute("src");
  embedPoolEl()?.appendChild(iframe);
}

function attachMainEmbed(iframe) {
  const current = embedFrame();
  if (current === iframe) return;
  if (current) retireEmbedFrame(current);
  iframe.id = "embed-player";
  iframe.className = "embed-engine";
  iframe.title = "Audio";
  document.body.appendChild(iframe);
}

function stopEmbed() {
  window.clearTimeout(state.embedTimer);
  window.clearInterval(state.embedTick);
  state.usingEmbed = false;
  state.embedStarted = 0;
  const frame = embedFrame();
  if (!frame) return;
  frame.removeAttribute("src");
}

function tickEmbedProgress() {
  const track = currentTrack();
  if (!state.usingEmbed || !track || !state.embedStarted) return;
  const elapsed = Math.min(track.duracion_seg || 0, (Date.now() - state.embedStarted) / 1000);
  document.querySelector("#time-current").textContent = formatTime(elapsed);
  document.querySelector("#time-total").textContent = formatTime(track.duracion_seg);
  document.querySelector("#ficha-current").textContent = formatTime(elapsed);
  document.querySelector("#ficha-total").textContent = formatTime(track.duracion_seg);
  if (track.duracion_seg) {
    const value = String(Math.floor((elapsed / track.duracion_seg) * 1000));
    document.querySelector("#seek").value = value;
    document.querySelector("#ficha-seek").value = value;
  }
}

function startEmbedTimers(track) {
  window.clearTimeout(state.embedTimer);
  window.clearInterval(state.embedTick);
  state.embedTick = window.setInterval(tickEmbedProgress, 400);
  tickEmbedProgress();
  if (track.duracion_seg > 0) {
    state.embedTimer = window.setTimeout(() => step(1), Math.max(1000, track.duracion_seg * 1000));
  }
}

function playInPage(track) {
  audio.pause();
  audio.removeAttribute("src");
  state.usingEmbed = true;
  state.embedStarted = Date.now();
  prefetchClipMedia(track.id);

  const pooled = state.embedPool.get(track.id);
  let frame = embedFrame();
  if (pooled?.status === "ready") {
    state.embedPool.delete(track.id);
    attachMainEmbed(pooled.iframe);
    frame = pooled.iframe;
    if (!pooled.intent) frame.src = embedPlayUrl(track.id);
  } else {
    attachMainEmbed(frame);
    const url = embedPlayUrl(track.id);
    if (!frame.src?.includes(track.id) || !frame.src.includes("autoplay=1")) frame.src = url;
  }

  startEmbedTimers(track);
  scheduleWarmVisible();
}

async function loadLyrics(track) {
  if (track.letra) return track.letra;
  if (state.lyrics.has(track.id)) return state.lyrics.get(track.id);
  const response = await fetch(`/api/temas/${track.id}`);
  if (!response.ok) return "";
  const detail = await response.json();
  state.lyrics.set(track.id, detail.letra || "");
  return detail.letra || "";
}

function formatLyrics(text) {
  if (!text.trim()) return `<p class="muted">Este tema no tiene letra guardada.</p>`;
  return `<div class="lyrics">${escapeHtml(text).replace(/^\[(.+)\]/gm, '<span class="section">[$1]</span>')}</div>`;
}

async function renderPanel() {
  if (panel.hidden) return;
  const track = currentTrack();
  if (state.tab === "cola") {
    panelBody.innerHTML = state.queue
      .map((item, index) => `
        <button class="queue-item ${index === state.index ? "is-current" : ""}" data-queue="${index}">
          <div class="row-cover" style="${coverStyle(item)}"></div>
          <div class="stack"><strong>${escapeHtml(item.titulo)}</strong><span class="muted">${formatTime(item.duracion_seg)}</span></div>
        </button>`)
      .join("") || `<p class="muted">La cola está vacía.</p>`;
    return;
  }
  if (!track) {
    panelBody.innerHTML = `<p class="muted">Reproducí un tema para ver la letra.</p>`;
    return;
  }
  panelBody.innerHTML = `<p class="muted">Cargando letra…</p>`;
  const lyrics = await loadLyrics(track);
  if (currentTrack()?.id !== track.id || state.tab !== "letra") return;
  panelBody.innerHTML = formatLyrics(lyrics);
}

function openPanel(tab) {
  state.tab = tab;
  panel.hidden = false;
  shell.classList.add("has-panel");
  document.querySelectorAll(".panel-tabs button[data-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tab);
  });
  renderPanel();
}

function closePanel() {
  panel.hidden = true;
  shell.classList.remove("has-panel");
}

function shuffled(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function playTrack(track, queue) {
  if (queue) {
    state.queue = state.shuffle ? [track, ...shuffled(queue.filter((item) => item.id !== track.id))] : [...queue];
    state.index = state.queue.findIndex((item) => item.id === track.id);
  }
  if (state.index < 0) return;
  const source = state.localApi ? audioUrl(track) : "";
  if (source) {
    stopEmbed();
    audio.src = source;
    audio.play().catch(() => playInPage(track));
  } else {
    playInPage(track);
  }
  remember(track);
  openFicha();
  paintPlayer();
  render();
  renderPanel();
}

function playFromList(trackId, list) {
  const track = list.find((item) => item.id === trackId) || byId(trackId);
  if (!track) return;
  if (currentTrack()?.id === trackId) {
    if (state.usingEmbed) {
      stopEmbed();
      paintPlayer();
      return;
    }
    if (audio.paused) audio.play();
    else audio.pause();
    return;
  }
  const queue = list.length ? list : state.tracks;
  playTrack(track, queue);
}

function step(direction) {
  if (!state.queue.length) return;
  if (direction > 0 && state.repeat === "one") {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  let next = state.index + direction;
  if (next >= state.queue.length) {
    if (state.repeat !== "all" && direction > 0) {
      audio.pause();
      stopEmbed();
      paintPlayer();
      return;
    }
    next = 0;
  }
  if (next < 0) next = 0;
  state.index = next;
  playTrack(state.queue[state.index]);
}

viewEl.addEventListener("mouseover", (event) => {
  const playFab = event.target.closest("[data-play]");
  const row = event.target.closest(".card[data-id], tr.track[data-id]");
  const trackId = playFab?.dataset.play || row?.dataset.id;
  if (!trackId) return;
  window.clearTimeout(state.hoverWarmTimer);
  state.hoverWarmTimer = window.setTimeout(() => warmEmbed(trackId, { intent: true }), 60);
});

searchInput.addEventListener("input", () => {
  state.query = searchInput.value;
  if (state.query && state.view === "inicio") {
    navigateTo("buscar", { clearSearch: false });
    return;
  }
  syncNavUi(state.view, state.tag);
  render();
  paintPlayer();
});

document.body.addEventListener("click", (event) => {
  const nav = event.target.closest(".sidebar .nav [data-view], .mobile-nav [data-view]");
  if (nav) {
    navigateTo(nav.dataset.view);
    return;
  }
  const tag = event.target.closest(".tag-btn");
  if (tag) {
    navigateTo("buscar", { tag: tag.dataset.tag });
    return;
  }
  const jump = event.target.closest("[data-jump]");
  if (jump) {
    navigateTo(jump.dataset.jump);
    return;
  }
  const playAll = event.target.closest("[data-play-all]");
  if (playAll) {
    const list = state.tracks;
    if (list[0]) playFromList(list[0].id, list);
    return;
  }
  const fab = event.target.closest("[data-play]");
  if (fab) {
    event.stopPropagation();
    const list = state.view === "inicio" && !state.query ? state.tracks : visibleTracks();
    playFromList(fab.dataset.play, list);
    return;
  }
  const rowClick = event.target.closest("tr.track, .card");
  if (rowClick?.dataset.id) {
    const list = visibleTracks();
    playFromList(rowClick.dataset.id, list.length ? list : state.tracks);
    return;
  }
  const queueItem = event.target.closest("[data-queue]");
  if (queueItem) {
    state.index = Number(queueItem.dataset.queue);
    playTrack(state.queue[state.index]);
  }
});

document.querySelector("#now-cover").addEventListener("click", () => {
  if (currentTrack()) openFicha();
});
document.querySelector("#now-title").addEventListener("click", () => {
  if (currentTrack()) openFicha();
});
document.querySelector("#ficha-back").addEventListener("click", closeFicha);
document.querySelector("#ficha-play").addEventListener("click", () => document.querySelector("#play").click());
document.querySelector("#ficha-prev").addEventListener("click", () => document.querySelector("#prev").click());
document.querySelector("#ficha-next").addEventListener("click", () => document.querySelector("#next").click());
document.querySelector("#ficha-seek").addEventListener("input", (event) => {
  document.querySelector("#seek").value = event.target.value;
  document.querySelector("#seek").dispatchEvent(new Event("input"));
});

document.querySelector("#play").addEventListener("click", () => {
  if (!currentTrack()) {
    if (state.tracks[0]) playFromList(state.tracks[0].id, state.tracks);
    return;
  }
  if (state.usingEmbed) {
    stopEmbed();
    paintPlayer();
    return;
  }
  if (audio.paused) audio.play();
  else audio.pause();
});
document.querySelector("#next").addEventListener("click", () => step(1));
document.querySelector("#prev").addEventListener("click", () => {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  step(-1);
});
document.querySelector("#shuffle").addEventListener("click", () => {
  state.shuffle = !state.shuffle;
  const track = currentTrack();
  if (track && state.queue.length) {
    const rest = state.queue.filter((item) => item.id !== track.id);
    state.queue = state.shuffle ? [track, ...shuffled(rest)] : [track, ...rest];
    state.index = 0;
  }
  paintPlayer();
  renderPanel();
});
document.querySelector("#repeat").addEventListener("click", () => {
  state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
  paintPlayer();
});
document.querySelector("#like-btn").addEventListener("click", () => {
  const track = currentTrack();
  if (!track) return;
  if (state.likes.has(track.id)) state.likes.delete(track.id);
  else state.likes.add(track.id);
  saveLikes();
  paintPlayer();
  if (state.view === "gustos" || state.view === "inicio") {
    render();
    paintPlayer();
  }
});
document.querySelector("#lyrics-btn").addEventListener("click", () => {
  if (!panel.hidden && state.tab === "letra") closePanel();
  else openPanel("letra");
});
document.querySelector("#close-panel").addEventListener("click", closePanel);
document.querySelectorAll(".panel-tabs button[data-tab]").forEach((button) => {
  button.addEventListener("click", () => openPanel(button.dataset.tab));
});

const seek = document.querySelector("#seek");
seek.addEventListener("pointerdown", () => {
  state.seeking = true;
});
seek.addEventListener("input", () => {
  if (!audio.duration) return;
  document.querySelector("#time-current").textContent = formatTime((seek.value / 1000) * audio.duration);
});
seek.addEventListener("change", () => {
  if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
  state.seeking = false;
});
document.querySelector("#volume").addEventListener("input", (event) => {
  audio.volume = Number(event.target.value);
  localStorage.setItem("suno-volume", String(audio.volume));
});

audio.addEventListener("timeupdate", () => {
  document.querySelector("#time-current").textContent = formatTime(audio.currentTime);
  document.querySelector("#time-total").textContent = formatTime(audio.duration || currentTrack()?.duracion_seg || 0);
  if (!state.seeking && audio.duration) seek.value = String(Math.floor((audio.currentTime / audio.duration) * 1000));
});
audio.addEventListener("play", paintPlayer);
audio.addEventListener("pause", paintPlayer);
audio.addEventListener("ended", () => step(1));
audio.addEventListener("error", () => {
  const artist = document.querySelector("#now-artist");
  const track = currentTrack();
  if (!track) return;
  if (state.localApi) {
    artist.textContent = "No se pudo abrir el audio local";
    return;
  }
  playInPage(track);
});

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea")) return;
  if (event.code === "Space") {
    event.preventDefault();
    document.querySelector("#play").click();
  } else if (event.code === "ArrowRight") {
    audio.currentTime = Math.min((audio.duration || 0), audio.currentTime + 5);
  } else if (event.code === "ArrowLeft") {
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  }
});

function setSyncStatus(text) {
  const node = document.querySelector("#sync-status");
  if (node) node.textContent = text;
}

async function probeLocalApi() {
  const candidates = ["localhost", "127.0.0.1"].includes(location.hostname)
    ? [""]
    : location.protocol === "http:"
      ? ["http://127.0.0.1:8765"]
      : [""];
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}/api/ping`);
      if (!response.ok) continue;
      const ping = await response.json();
      state.localApi = base;
      document.body.classList.add("is-local");
      const extra = ping.nuevos ? ` · ${ping.nuevos} nuevos` : "";
      setSyncStatus(ping.tiene_sesion ? `Suno conectado${extra}` : "Reproductor local listo. Falta conectar Suno.");
      return ping;
    } catch {
      continue;
    }
  }
  setSyncStatus("Estás en GitHub Pages. Para escuchar todo, abrí el reproductor local.");
  return null;
}

async function reloadCatalog() {
  const catalogUrl = state.localApi ? `${state.localApi}/temas.json` : "temas.json";
  const response = await fetch(catalogUrl);
  const payload = await response.json();
  state.tracks = payload.temas || [];
  state.tags = payload.etiquetas || [];
  state.nuevos = payload.nuevos || [];
  renderTags();
  render();
  paintPlayer();
}

document.querySelector("#session-btn").addEventListener("click", () => {
  document.querySelector("#session-dialog").showModal();
});
document.querySelector("#cancel-session").addEventListener("click", () => {
  document.querySelector("#session-dialog").close();
});
document.querySelector("#session-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.localApi && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    setSyncStatus("La conexión a Suno se hace en http://127.0.0.1:8765");
    return;
  }
  const cookie = document.querySelector("#cookie-input").value.trim();
  setSyncStatus("Guardando sesión…");
  const response = await fetch(`${state.localApi}/api/sesion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookie }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: "Cookie inválida" }));
    setSyncStatus(detail.detail || "No se pudo conectar Suno");
    return;
  }
  document.querySelector("#session-dialog").close();
  setSyncStatus("Sesión guardada. Sincronizando…");
  document.querySelector("#sync-btn").click();
});
document.querySelector("#sync-btn").addEventListener("click", async () => {
  if (state.syncing) return;
  if (!state.localApi && !["localhost", "127.0.0.1"].includes(location.hostname)) {
    setSyncStatus("Actualizá desde el reproductor local o esperá el sync automático de GitHub.");
    return;
  }
  state.syncing = true;
  setSyncStatus("Buscando temas nuevos en Suno…");
  try {
    const response = await fetch(`${state.localApi}/api/sincronizar`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      setSyncStatus(payload.detail || "Falló la sincronización");
      return;
    }
    await reloadCatalog();
    const names = (payload.titulos_nuevos || []).slice(0, 3).join(", ");
    setSyncStatus(payload.nuevos ? `Llegaron ${payload.nuevos} temas nuevos${names ? `: ${names}` : ""}` : "Biblioteca al día");
    if (payload.nuevos) navigateTo("nuevos");
  } catch {
    setSyncStatus("No se pudo sincronizar");
  } finally {
    state.syncing = false;
  }
});

async function boot() {
  const savedVolume = Number(localStorage.getItem("suno-volume"));
  if (Number.isFinite(savedVolume)) {
    audio.volume = savedVolume;
    document.querySelector("#volume").value = String(savedVolume);
  } else {
    audio.volume = 0.85;
  }
  await probeLocalApi();
  await reloadCatalog();
}

boot();

