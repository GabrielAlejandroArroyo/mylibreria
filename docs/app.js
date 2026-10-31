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
  karaokeTimelines: new Map(),
  karaokeMeta: new Map(),
  karaokeActive: -1,
  audioLeadSec: 0,
  karaokeOffset: Number(localStorage.getItem("suno-karaoke-offset") || 0) || 0,
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
const SUNO_AUTOPLAY_LEAD = 1.15;
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

function updateLikesBadge() {
  const count = state.likes.size;
  document.querySelectorAll("[data-likes-badge]").forEach((badge) => {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  });
}

function paintLikeButtons(track) {
  const currentId = track?.id || currentTrack()?.id || "";
  document.querySelectorAll("#like-btn, #ficha-like").forEach((button) => {
    const on = Boolean(currentId && state.likes.has(currentId));
    button.classList.toggle("is-on", on);
    button.textContent = on ? "♥" : "♡";
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  document.querySelectorAll("[data-like]").forEach((button) => {
    const liked = state.likes.has(button.dataset.like);
    button.classList.toggle("is-on", liked);
    button.textContent = liked ? "♥" : "♡";
    button.setAttribute("aria-pressed", liked ? "true" : "false");
  });
}

function toggleLike(trackId) {
  if (!trackId) return;
  if (state.likes.has(trackId)) state.likes.delete(trackId);
  else state.likes.add(trackId);
  saveLikes();
  updateLikesBadge();
  paintLikeButtons(byId(trackId));
  paintPlayer();
  if (state.view === "gustos" || state.view === "inicio") render();
}

function seedLikesFromCatalog() {
  let added = false;
  for (const track of state.tracks) {
    if (track.me_gusta && !state.likes.has(track.id)) {
      state.likes.add(track.id);
      added = true;
    }
  }
  if (added) saveLikes();
  updateLikesBadge();
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
  const liked = state.likes.has(track.id);
  return `
    <article class="card" data-id="${track.id}">
      <div class="card-cover" style="${coverStyle(track)}"></div>
      <button class="card-like ${liked ? "is-on" : ""}" data-like="${track.id}" aria-label="Me gusta" aria-pressed="${liked}">${liked ? "♥" : "♡"}</button>
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
  if (state.view === "gustos" && !tracks.length) {
    viewEl.innerHTML = `<div class="empty">Todavía no marcaste ningún tema. Tocá ♡ en una tarjeta o en la ficha para guardarlo acá.</div>`;
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
    paintLikeButtons(null);
    link.hidden = true;
    return;
  }
  title.textContent = track.titulo;
  artist.textContent = track.etiquetas[0] || track.autor;
  cover.style.cssText = coverStyle(track);
  paintLikeButtons(track);
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
  paintLikeButtons(track);
  const lyricsBox = document.querySelector("#ficha-lyrics");
  lyricsBox.setAttribute("contenteditable", "false");
  if (lyricsBox.dataset.track !== track.id) {
    lyricsBox.dataset.track = track.id;
    lyricsBox.innerHTML = `<p class="muted">Cargando letra…</p>`;
    const lyrics = await loadLyrics(track);
    if (currentTrack()?.id !== track.id || sheet.hidden) return;
    mountKaraoke(track, lyrics, lyricsBox);
  }
  updateKaraokeHighlight(playbackElapsed());
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

function warmEmbed(trackId) {
  if (!shouldUseEmbedPool() || !trackId) return;
  if (state.embedPool.has(trackId)) return;
  if (currentTrack()?.id === trackId && state.usingEmbed) return;
  evictEmbedPool(new Set([trackId]));
  const pool = embedPoolEl();
  if (!pool) return;
  const iframe = document.createElement("iframe");
  iframe.className = "embed-engine embed-pool-frame";
  iframe.title = "Precarga";
  iframe.allow = "autoplay; encrypted-media; clipboard-write";
  iframe.src = embedWarmUrl(trackId);
  pool.appendChild(iframe);
  const entry = { iframe, status: "loading", trackId };
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

function clearEmbedPool() {
  for (const [, entry] of state.embedPool) {
    entry.iframe.removeAttribute("src");
    entry.iframe.remove();
  }
  state.embedPool.clear();
}

function stopAllPlayback() {
  window.clearTimeout(state.embedTimer);
  window.clearInterval(state.embedTick);
  audio.pause();
  audio.removeAttribute("src");
  state.usingEmbed = false;
  state.embedStarted = 0;
  state.audioLeadSec = 0;
  state.karaokeActive = -1;
  const frame = embedFrame();
  if (frame) frame.removeAttribute("src");
  clearEmbedPool();
  document.querySelectorAll("#ficha-lyrics .karaoke-line, #panel-body .karaoke-line").forEach((node) => {
    node.classList.remove("is-past", "is-active", "is-next");
    node.querySelector(".karaoke-fill")?.style.setProperty("--fill", "0");
  });
}

function stopEmbed() {
  stopAllPlayback();
}

function tickEmbedProgress() {
  const track = currentTrack();
  if (!state.usingEmbed || !track || !state.embedStarted) return;
  const elapsed = playbackElapsed();
  document.querySelector("#time-current").textContent = formatTime(elapsed);
  document.querySelector("#time-total").textContent = formatTime(track.duracion_seg);
  document.querySelector("#ficha-current").textContent = formatTime(elapsed);
  document.querySelector("#ficha-total").textContent = formatTime(track.duracion_seg);
  if (track.duracion_seg) {
    const value = String(Math.floor((elapsed / track.duracion_seg) * 1000));
    document.querySelector("#seek").value = value;
    document.querySelector("#ficha-seek").value = value;
  }
  updateKaraokeHighlight(elapsed);
}

function startEmbedTimers(track) {
  window.clearTimeout(state.embedTimer);
  window.clearInterval(state.embedTick);
  state.embedTick = window.setInterval(tickEmbedProgress, 200);
  tickEmbedProgress();
  if (track.duracion_seg > 0) {
    const waitMs = Math.max(1000, (track.duracion_seg + state.audioLeadSec) * 1000);
    state.embedTimer = window.setTimeout(() => step(1), waitMs);
  }
}

function startEmbedClock(autoplayAt) {
  const track = currentTrack();
  const lead = track ? state.karaokeMeta.get(track.id)?.lead : 0;
  state.audioLeadSec = Number.isFinite(lead) && lead > 0 ? lead : SUNO_AUTOPLAY_LEAD;
  state.embedStarted = autoplayAt || Date.now();
}

function playInPage(track) {
  state.usingEmbed = true;
  prefetchClipMedia(track.id);
  const frame = embedFrame();
  if (!frame) return;
  frame.src = embedPlayUrl(track.id);
  startEmbedClock(Date.now());
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

function parseLyricLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ kind: /^\[[^\]]+\]$/.test(line) ? "section" : "line", text: line }));
}

function buildLineTimeline(items, durationSec) {
  const duration = Math.max(Number(durationSec) || 0, 1);
  const intro = Math.min(9, Math.max(6, duration * 0.05));
  const outro = Math.min(8, Math.max(5, duration * 0.045));
  const singableWindow = Math.max(duration - intro - outro, duration * 0.72);
  const weights = items.map((item) => (item.kind === "line" ? Math.max(item.text.length, 10) : 0));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = intro;
  let lineIndex = 0;
  return items.map((item, index) => {
    if (item.kind !== "line") return { ...item, startSec: 0, endSec: 0, lineIndex: -1 };
    const span = (weights[index] / totalWeight) * singableWindow;
    const startSec = cursor;
    cursor += span;
    const current = lineIndex;
    lineIndex += 1;
    return { ...item, startSec, endSec: cursor, lineIndex: current };
  });
}

function buildLineTimelineFromStarts(items, starts, durationSec) {
  const duration = Math.max(Number(durationSec) || 0, 1);
  const stamps = Array.isArray(starts) ? starts : [];
  let lineIndex = 0;
  return items.map((item) => {
    if (item.kind !== "line") return { ...item, startSec: 0, endSec: 0, lineIndex: -1 };
    const startSec = Number(stamps[lineIndex]) || 0;
    const nextStart = Number(stamps[lineIndex + 1]);
    const endSec = Number.isFinite(nextStart) ? Math.min(nextStart, duration) : Math.min(startSec + 3.5, duration);
    const current = lineIndex;
    lineIndex += 1;
    return { ...item, startSec, endSec, lineIndex: current };
  });
}

function karaokeTimelineForTrack(track, lyrics) {
  const items = parseLyricLines(lyrics);
  const meta = state.karaokeMeta.get(track.id);
  if (meta?.starts?.length) return buildLineTimelineFromStarts(items, meta.starts, track.duracion_seg);
  return buildLineTimeline(items, track.duracion_seg);
}

function renderKaraokeDom(items) {
  if (!items.length) return `<p class="muted">Este tema no tiene letra guardada.</p>`;
  return items
    .map((item) => (
      item.kind === "section"
        ? `<p class="karaoke-section">${escapeHtml(item.text)}</p>`
        : `<p class="karaoke-line" data-i="${item.lineIndex}"><span class="karaoke-text">${escapeHtml(item.text)}</span><span class="karaoke-fill" aria-hidden="true">${escapeHtml(item.text)}</span></p>`
    ))
    .join("");
}

function mountKaraoke(track, lyrics, target) {
  const timeline = karaokeTimelineForTrack(track, lyrics);
  state.karaokeTimelines.set(track.id, timeline);
  state.karaokeActive = -1;
  target.innerHTML = renderKaraokeDom(timeline);
  const first = timeline.find((item) => item.kind === "line");
  updateKaraokeNow(first?.text || "La letra aparece acá cuando arranca el tema", true);
}

function playbackElapsed() {
  const track = currentTrack();
  if (state.usingEmbed && state.embedStarted) {
    const raw = (Date.now() - state.embedStarted) / 1000 - state.audioLeadSec + state.karaokeOffset;
    return Math.min(track?.duracion_seg || 0, Math.max(0, raw));
  }
  return Math.max(0, (audio.currentTime || 0) + state.karaokeOffset);
}

function paintKaraokeOffset() {
  const label = document.querySelector("#karaoke-offset");
  if (label) label.textContent = `${state.karaokeOffset > 0 ? "+" : ""}${state.karaokeOffset.toFixed(1)}s`;
}

function nudgeKaraoke(delta) {
  state.karaokeOffset = Math.max(-8, Math.min(8, Math.round((state.karaokeOffset + delta) * 10) / 10));
  localStorage.setItem("suno-karaoke-offset", String(state.karaokeOffset));
  paintKaraokeOffset();
  updateKaraokeHighlight(playbackElapsed());
}

function updateKaraokeNow(text, waiting) {
  const now = document.querySelector("#ficha-karaoke-now");
  if (!now) return;
  now.classList.toggle("is-waiting", Boolean(waiting));
  now.textContent = text;
}

function updateKaraokeHighlight(elapsedSec) {
  const track = currentTrack();
  if (!track) return;
  const timeline = state.karaokeTimelines.get(track.id);
  if (!timeline) return;
  const singable = timeline.filter((item) => item.kind === "line");
  if (!singable.length) {
    updateKaraokeNow("Este tema no tiene letra para cantar", true);
    return;
  }
  let active = -1;
  for (const item of singable) {
    if (elapsedSec >= item.startSec) active = item.lineIndex;
  }
  const current = singable[Math.max(active, 0)];
  const waiting = elapsedSec < singable[0].startSec;
  const span = Math.max((current.endSec - current.startSec) || 1, 0.4);
  const fill = waiting ? 0 : Math.max(0, Math.min(1, (elapsedSec - current.startSec) / span));
  updateKaraokeNow(waiting ? current.text : current.text, waiting);
  document.querySelectorAll("#ficha-lyrics .karaoke-line, #panel-body .karaoke-line").forEach((node) => {
    const index = Number(node.dataset.i);
    node.classList.toggle("is-past", !waiting && index < active);
    node.classList.toggle("is-active", !waiting && index === active);
    node.classList.toggle("is-next", waiting ? index === 0 : index === active + 1);
    const paint = node.querySelector(".karaoke-fill");
    if (paint) paint.style.setProperty("--fill", index === active && !waiting ? String(fill) : "0");
  });
  if (state.karaokeActive !== active) {
    state.karaokeActive = active;
    const focus = document.querySelector("#ficha-lyrics .karaoke-line.is-active, #ficha-lyrics .karaoke-line.is-next");
    const box = document.querySelector("#ficha-lyrics");
    if (focus && box) {
      const top = focus.offsetTop - box.clientHeight / 2 + focus.clientHeight / 2;
      if (Math.abs(box.scrollTop - top) > 16) box.scrollTo({ top, behavior: "smooth" });
    }
  }
}

function formatLyrics(text) {
  const track = currentTrack();
  const timeline = track ? karaokeTimelineForTrack(track, text) : buildLineTimeline(parseLyricLines(text), 1);
  return renderKaraokeDom(timeline);
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
  mountKaraoke(track, lyrics, panelBody);
  updateKaraokeHighlight(playbackElapsed());
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
  stopAllPlayback();
  const lyricsBox = document.querySelector("#ficha-lyrics");
  if (lyricsBox) lyricsBox.removeAttribute("data-track");
  const source = state.localApi ? audioUrl(track) : "";
  if (source) {
    audio.src = source;
    audio.play().catch(() => playInPage(track));
  } else {
    playInPage(track);
  }
  state.karaokeActive = -1;
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
      stopAllPlayback();
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
      stopAllPlayback();
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
  state.hoverWarmTimer = window.setTimeout(() => warmEmbed(trackId), 120);
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
  const likeHit = event.target.closest("[data-like]");
  if (likeHit) {
    event.stopPropagation();
    toggleLike(likeHit.dataset.like);
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
    stopAllPlayback();
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
  if (track) toggleLike(track.id);
});
document.querySelector("#ficha-like").addEventListener("click", () => {
  const track = currentTrack();
  if (track) toggleLike(track.id);
});
document.querySelector("#karaoke-late").addEventListener("click", () => nudgeKaraoke(-0.5));
document.querySelector("#karaoke-early").addEventListener("click", () => nudgeKaraoke(0.5));
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
  updateKaraokeHighlight(audio.currentTime);
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

async function loadKaraokeTimings() {
  state.karaokeMeta.clear();
  try {
    const response = await fetch("karaoke_timings.json", { cache: "no-cache" });
    if (!response.ok) return;
    const payload = await response.json();
    for (const [trackId, meta] of Object.entries(payload)) {
      if (!meta?.starts?.length) continue;
      state.karaokeMeta.set(trackId, meta);
    }
  } catch {
    /* sin archivo en local antiguo */
  }
}

async function reloadCatalog() {
  const catalogUrl = state.localApi ? `${state.localApi}/temas.json` : "temas.json";
  const response = await fetch(catalogUrl);
  const payload = await response.json();
  state.tracks = payload.temas || [];
  state.tags = payload.etiquetas || [];
  state.nuevos = payload.nuevos || [];
  await loadKaraokeTimings();
  seedLikesFromCatalog();
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
  paintKaraokeOffset();
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

