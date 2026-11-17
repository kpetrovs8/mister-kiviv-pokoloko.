'use strict';

const FILMS = {
  bunny: { type: 'video', title: 'Big Buck Bunny', url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
  sintel: { type: 'video', title: 'Sintel', url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4' },
  elephants: { type: 'video', title: 'Elephants Dream', url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4' },
  steel: { type: 'video', title: 'Tears of Steel', url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4' }
};
const $ = (id) => document.getElementById(id);
const socket = io({ autoConnect: false, reconnection: true, reconnectionDelayMax: 3000 });
let roomId = '';
let myId = '';
let myName = '';
let joined = false;
let state = null;
let receivedAt = performance.now();
let currentMediaKey = null;
let ytPlayer = null;
let ytReady = false;
let ytApiReady = false;
let ytRequested = false;
let localVolume = Number(localStorage.getItem('cinema-volume') ?? 70);
let lastChatCount = 0;
let toastTimer = null;
let isScrubbing = false;
let lastAppliedRevision = -1;
let roomFullRetries = 0;
let ytLastId = '';
let lastNativeSource = '';
let showOverlayDueToBlock = false;

localVolume = Number.isFinite(localVolume) ? Math.max(0, Math.min(100, localVolume)) : 70;
$('volumeSlider').value = String(localVolume);
$('volumeSlider').style.setProperty('--progress', `${localVolume}%`);

function toast(message) {
  const target = $('toast');
  target.textContent = message;
  target.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => target.classList.remove('show'), 3500);
}

function setStatus(label, kind = '') {
  $('statusText').textContent = label;
  $('statusPill').className = `status-pill ${kind}`;
}

function showDialog(id) {
  const target = $(id);
  if (typeof target.showModal === 'function') target.showModal();
  else target.setAttribute('open', '');
}
function hideDialog(id) {
  const target = $(id);
  if (typeof target.close === 'function') target.close();
  else target.removeAttribute('open');
}

function parseMovieUrl(raw) {
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = parsed.pathname.split('/')[1];
  } else if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtube-nocookie.com','www.youtube-nocookie.com'].includes(host)) {
    const parts = parsed.pathname.split('/').filter(Boolean);
    id = parts[0] === 'watch' ? parsed.searchParams.get('v') :
      ['embed', 'shorts', 'live', 'v'].includes(parts[0]) ? parts[1] : null;
  }
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return { type: 'youtube', id };
  if (/\.(mp4|webm|ogg)$/i.test(parsed.pathname)) {
    if (location.protocol === 'https:' && parsed.protocol === 'http:') return { error: 'На защищённом сайте видео тоже должно быть по ссылке HTTPS.' };
    return { type: 'video', url: parsed.href };
  }
  return null;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hrs ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}` :
    `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function expectedPosition(s = state) {
  if (!s) return 0;
  const elapsedAtReceipt = Math.max(0, (s.sentAt - s.changedAt) / 1000);
  const elapsedSinceReceipt = Math.max(0, (performance.now() - receivedAt) / 1000);
  return Math.max(0, s.position + (s.playing ? elapsedAtReceipt + elapsedSinceReceipt : 0));
}

function getPlayerPosition() {
  if (!state || !state.movie) return 0;
  if (state.movie.type === 'youtube' && ytReady && ytPlayer) {
    const n = Number(ytPlayer.getCurrentTime());
    return Number.isFinite(n) ? Math.max(0, n) : expectedPosition();
  }
  if (state.movie.type === 'video') {
    const n = $('nativePlayer').currentTime;
    return Number.isFinite(n) ? Math.max(0, n) : expectedPosition();
  }
  return expectedPosition();
}

function getDuration() {
  if (!state?.movie) return 0;
  if (state.movie.type === 'youtube' && ytReady && ytPlayer) return Number(ytPlayer.getDuration()) || 0;
  if (state.movie.type === 'video') return Number.isFinite($('nativePlayer').duration) ? $('nativePlayer').duration : 0;
  return 0;
}

function setPlayIcon(playing) {
  $('playIcon').innerHTML = playing ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="m8 5 11 7-11 7V5Z"/>';
  $('playBtn').setAttribute('aria-label', playing ? 'Поставить на паузу у обоих' : 'Включить у обоих');
  $('playBtn').title = playing ? 'Пауза для обоих' : 'Продолжить для обоих';
}

function markSelectedCard(movie) {
  document.querySelectorAll('.movie-card').forEach((card) => {
    const preset = FILMS[card.dataset.film];
    const selected = movie && preset && movie.type === 'video' && preset.url === movie.url;
    card.classList.toggle('selected', Boolean(selected));
  });
}

function ensureYouTubeAPI() {
  if (ytApiReady) { ensureYouTubePlayer(); return; }
  if (ytRequested) return;
  ytRequested = true;
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  script.async = true;
  script.onerror = () => toast('Не получилось загрузить YouTube. Попробуй другую ссылку.');
  document.head.appendChild(script);
}
window.onYouTubeIframeAPIReady = () => {
  ytApiReady = true;
  ensureYouTubePlayer();
};

function ensureYouTubePlayer() {
  if (!ytApiReady || ytPlayer || !state?.movie || state.movie.type !== 'youtube') return;
  ytPlayer = new YT.Player('youtubeHolder', {
    width: '100%', height: '100%',
    playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady: () => {
        ytReady = true;
        try { ytPlayer.setVolume(localVolume); } catch (_) { /* api */ }
        loadYoutubeIfNeeded();
        applyPlayerState(true);
      },
      onError: (event) => {
        if ([100, 101, 150, 153].includes(event.data)) {
          toast('Это видео нельзя воспроизвести во встроенном YouTube-плеере. Выбери другое.');
        }
      },
      onStateChange: (event) => {
        if (event.data === YT.PlayerState.ENDED && state?.playing && state?.movie?.type === 'youtube') {
          sendCommand('pause', getDuration());
        }
      }
    }
  });
}

function loadYoutubeIfNeeded() {
  if (!state?.movie || state.movie.type !== 'youtube' || !ytReady) return;
  if (ytLastId === state.movie.id) return;
  ytLastId = state.movie.id;
  try { ytPlayer.cueVideoById({ videoId: ytLastId, startSeconds: 0 }); } catch (_) { /* player initializing */ }
}

function loadMedia(movie) {
  const video = $('nativePlayer');
  const youtube = $('youtubeLayer');
  $('emptyScreen').classList.add('hidden');
  $('movieTitleOverlay').classList.remove('hidden');
  $('onScreenTitle').textContent = movie.title;
  $('trackTitle').textContent = movie.title;
  $('trackSub').textContent = movie.type === 'youtube' ? 'Видео с YouTube · смотрим вместе' : 'Наш фильм · смотрим вместе';
  $('theaterBadge').textContent = 'Всё синхронно ♡';
  $('seekSlider').disabled = false;
  $('playBtn').disabled = false;
  markSelectedCard(movie);
  hidePlaybackOverlay();

  if (movie.type === 'video') {
    if (ytReady && ytPlayer) {
      try { ytPlayer.pauseVideo(); } catch (_) { /* no-op */ }
    }
    youtube.classList.add('hidden');
    video.classList.remove('hidden');
    if (lastNativeSource !== movie.url) {
      lastNativeSource = movie.url;
      video.pause();
      video.src = movie.url;
      video.load();
    }
    video.volume = localVolume / 100;
  } else {
    video.pause();
    video.classList.add('hidden');
    youtube.classList.remove('hidden');
    ensureYouTubeAPI();
    ensureYouTubePlayer();
    loadYoutubeIfNeeded();
  }
}

function hidePlaybackOverlay() {
  showOverlayDueToBlock = false;
  $('startOverlay').classList.add('hidden');
}
function showPlaybackOverlay() {
  if (!state?.playing || !state.movie) return;
  showOverlayDueToBlock = true;
  $('startOverlay').classList.remove('hidden');
}

function nativeReady() {
  const player = $('nativePlayer');
  return player.readyState >= 1;
}

function applyPlayerState(force = false) {
  if (!state?.movie) return;
  const position = expectedPosition();
  const duration = getDuration();
  const target = duration > 0 ? Math.min(duration, position) : position;

  if (state.movie.type === 'video') {
    const player = $('nativePlayer');
    if (nativeReady() && Number.isFinite(target) && Math.abs(player.currentTime - target) > (force ? .15 : .85)) {
      try { player.currentTime = target; } catch (_) { /* metadata unavailable */ }
    }
    if (state.playing) {
      const play = player.play();
      if (play && typeof play.catch === 'function') play.then(hidePlaybackOverlay).catch(showPlaybackOverlay);
    } else {
      player.pause();
      hidePlaybackOverlay();
    }
  } else if (ytReady && ytPlayer) {
    loadYoutubeIfNeeded();
    try {
      const ytPosition = Number(ytPlayer.getCurrentTime()) || 0;
      if (Math.abs(ytPosition - target) > (force ? .15 : 1.1)) ytPlayer.seekTo(target, true);
      if (state.playing) {
        ytPlayer.playVideo();
        // Браузеры часто блокируют автозапуск YouTube со звуком без нажатия зрителем.
        setTimeout(() => {
          if (state?.playing && state.movie?.type === 'youtube' && ytReady) {
            try {
              const playbackState = ytPlayer.getPlayerState();
              if (playbackState !== YT.PlayerState.PLAYING && playbackState !== YT.PlayerState.BUFFERING) {
                showPlaybackOverlay();
              } else hidePlaybackOverlay();
            } catch (_) { /* api */ }
          }
        }, 1600);
      } else { ytPlayer.pauseVideo(); hidePlaybackOverlay(); }
    } catch (_) { /* player not ready */ }
  }
}

function acceptState(nextState, pulse = false) {
  if (!nextState || typeof nextState.revision !== 'number') return;
  if (state && nextState.revision < state.revision) return;
  const mediaChanged = nextState.movie?.key !== currentMediaKey;
  const revisionChanged = nextState.revision !== lastAppliedRevision;
  state = nextState;
  receivedAt = performance.now();

  if (nextState.movie && mediaChanged) {
    currentMediaKey = nextState.movie.key;
    loadMedia(nextState.movie);
  }
  if (!nextState.movie) return;
  setPlayIcon(nextState.playing);
  $('trackSub').textContent = nextState.playing ? 'Идёт совместный просмотр ✨' : 'Пауза у вас обоих ♡';
  if (revisionChanged || mediaChanged) {
    lastAppliedRevision = nextState.revision;
    applyPlayerState(true);
  } else if (pulse && nextState.playing && !isScrubbing) {
    const delta = Math.abs(getPlayerPosition() - expectedPosition());
    if (delta > 1.15) applyPlayerState();
  }
  updateTimeline();
}

function sendCommand(action, position = getPlayerPosition()) {
  if (!joined || !state?.movie) { toast('Сначала выбери фильм и подключись к залу.'); return; }
  if (!Number.isFinite(position)) position = 0;
  const duration = getDuration();
  if (duration > 0) position = Math.min(duration, position);
  socket.emit('player:command', { action, position: Math.max(0, position) });
}

function updateTimeline() {
  if (!state?.movie || isScrubbing) return;
  const duration = getDuration();
  const rawPosition = expectedPosition();
  const position = duration ? Math.min(duration, rawPosition) : rawPosition;
  $('currentTime').textContent = formatTime(position);
  $('durationTime').textContent = duration ? formatTime(duration) : '--:--';
  const fraction = duration ? Math.min(1, position / duration) : 0;
  $('seekSlider').value = String(Math.round(1000 * fraction));
  $('seekSlider').style.setProperty('--progress', `${fraction * 100}%`);
}

function selectFilm(film) {
  if (!joined) { toast('Подключаем кинозал. Попробуй ещё раз.'); return; }
  socket.emit('movie:select', film);
  hideDialog('movieDialog');
  $('screen').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function addMessage(message) {
  const container = $('messages');
  const empty = container.querySelector('.chat-welcome');
  if (empty) empty.remove();
  if (message.kind === 'system') {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.textContent = message.text;
    container.appendChild(el);
  } else {
    const mine = message.authorId === myId;
    const row = document.createElement('div');
    row.className = `message-row ${mine ? 'mine' : ''}`;
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = (message.name || '?').charAt(0).toUpperCase();
    const body = document.createElement('div');
    body.className = 'message-body';
    const name = document.createElement('span');
    name.className = 'message-name';
    name.textContent = mine ? 'Ты' : message.name;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = message.text;
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    body.append(name, bubble, time);
    row.append(avatar, body);
    container.appendChild(row);
  }
  while (container.children.length > 90) container.firstElementChild?.remove();
  container.scrollTop = container.scrollHeight;
  lastChatCount++;
}
function renderChat(messages) {
  $('messages').replaceChildren();
  lastChatCount = 0;
  if (!messages?.length) {
    const welcome = document.createElement('div');
    welcome.className = 'chat-welcome';
    const emoji = document.createElement('span');
    emoji.textContent = '💌';
    const strong = document.createElement('strong');
    strong.textContent = 'Здесь начинаются наши воспоминания';
    const p = document.createElement('p');
    p.textContent = 'Напиши первое сообщение. Можно даже просто «я тебя люблю».';
    welcome.append(emoji, strong, p);
    $('messages').appendChild(welcome);
  } else messages.forEach(addMessage);
}
function updatePresence(members) {
  const n = members.length;
  $('memberCount').textContent = n === 2 ? 'Вы оба здесь ♡' : n === 1 ? 'Пока только ты' : 'Никого нет';
  $('memberHint').textContent = n === 2 ? members.map((m) => m.name).join(' и ') : 'Пригласи свою половинку';
  $('syncLabel').innerHTML = n === 2 ? '<span class="sync-flower">✳</span> Смотрим вместе' : '<span class="sync-flower">✳</span> Один экран, два сердца';
}

socket.on('connect', () => {
  setStatus('Подключаем комнату…');
  joined = false;
  const preferredName = localStorage.getItem(`cinema-name:${roomId}`) || '';
  socket.emit('room:join', { roomId, preferredName });
});
socket.on('room:joined', (payload) => {
  joined = true;
  roomFullRetries = 0;
  myId = payload.yourId;
  myName = payload.yourName;
  localStorage.setItem(`cinema-name:${roomId}`, myName);
  setStatus('Вы на связи', 'connected');
  updatePresence(payload.members);
  renderChat(payload.messages);
  lastAppliedRevision = -1;
  acceptState(payload.state);
});
socket.on('room:presence', updatePresence);
socket.on('room:error', (problem) => {
  toast(problem.message || 'Что-то пошло не так');
  if (problem.code === 'full' && roomFullRetries < 3) {
    roomFullRetries++;
    setTimeout(() => {
      if (!joined && socket.connected) socket.emit('room:join', {
        roomId, preferredName: localStorage.getItem(`cinema-name:${roomId}`) || ''
      });
    }, 1500);
  }
  if (problem.code === 'full') setStatus('Комната занята', 'offline');
});
socket.on('player:state', (s) => acceptState(s));
socket.on('player:pulse', (s) => acceptState(s, true));
socket.on('chat:message', addMessage);
socket.on('disconnect', () => { joined = false; setStatus('Связь потеряна', 'offline'); });
socket.io.on('reconnect_attempt', () => setStatus('Переподключаемся…'));

$('playBtn').addEventListener('click', () => {
  if (!state?.movie) return;
  if (state.playing) {
    sendCommand('pause');
  } else {
    // Клик человека помогает браузеру разрешить звук и автозапуск.
    if (state.movie.type === 'video') $('nativePlayer').play().catch(showPlaybackOverlay);
    if (state.movie.type === 'youtube' && ytReady) ytPlayer.playVideo();
    sendCommand('play');
  }
});
$('startOverlayBtn').addEventListener('click', () => {
  hidePlaybackOverlay();
  applyPlayerState(true);
  if (state?.movie?.type === 'video') $('nativePlayer').play().catch(showPlaybackOverlay);
  if (state?.movie?.type === 'youtube' && ytReady) ytPlayer.playVideo();
});
$('nativePlayer').addEventListener('loadedmetadata', () => {
  if (state?.movie?.type === 'video') { applyPlayerState(true); updateTimeline(); }
});
$('nativePlayer').addEventListener('error', () => {
  if (state?.movie?.type === 'video') toast('Видео не открылось. Убедись, что ссылка доступна обоим.');
});
$('nativePlayer').addEventListener('ended', () => {
  if (state?.playing && state?.movie?.type === 'video') sendCommand('pause', getDuration());
});

$('seekSlider').addEventListener('pointerdown', () => { isScrubbing = true; });
$('seekSlider').addEventListener('input', () => {
  isScrubbing = true;
  const duration = getDuration();
  const position = duration * Number($('seekSlider').value) / 1000;
  $('currentTime').textContent = formatTime(position);
  $('seekSlider').style.setProperty('--progress', `${Number($('seekSlider').value) / 10}%`);
});
$('seekSlider').addEventListener('change', () => {
  const duration = getDuration();
  if (duration) sendCommand('seek', duration * Number($('seekSlider').value) / 1000);
  isScrubbing = false;
});
$('seekSlider').addEventListener('pointerup', () => { if (!isScrubbing) updateTimeline(); });

$('volumeSlider').addEventListener('input', (event) => {
  localVolume = Number(event.target.value);
  localStorage.setItem('cinema-volume', String(localVolume));
  event.target.style.setProperty('--progress', `${localVolume}%`);
  $('nativePlayer').volume = localVolume / 100;
  if (ytReady && ytPlayer) ytPlayer.setVolume(localVolume);
});

$('fullscreenBtn').addEventListener('click', () => {
  const target = document.querySelector('.theater-card');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (target.requestFullscreen) target.requestFullscreen().catch(() => toast('На этом устройстве полный экран недоступен.'));
  else toast('На этом устройстве полный экран недоступен.');
});

$('chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('chatInput');
  const value = input.value.trim();
  if (!value || !joined) return;
  socket.emit('chat:send', value);
  input.value = '';
  input.focus();
});
document.querySelectorAll('.reaction').forEach((button) => button.addEventListener('click', () => {
  if (!joined) return toast('Нет связи с комнатой.');
  socket.emit('chat:send', button.dataset.reaction);
}));

document.querySelectorAll('.movie-card').forEach((button) => button.addEventListener('click', () => selectFilm(FILMS[button.dataset.film])));
$('addMovieBtn').addEventListener('click', () => showDialog('movieDialog'));
$('emptyChooseBtn').addEventListener('click', () => $('library').scrollIntoView({ behavior: 'smooth', block: 'start' }));
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => hideDialog(button.dataset.closeDialog)));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
}));

$('movieForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('movieTitleInput').value.trim();
  const rawUrl = $('movieUrlInput').value.trim();
  const parsed = parseMovieUrl(rawUrl);
  if (!parsed || parsed.error || !title) {
    $('movieError').textContent = parsed?.error || 'Поддерживаются ссылки на YouTube и прямые ссылки на видео .mp4, .webm, .ogg.';
    $('movieError').classList.remove('hidden');
    return;
  }
  $('movieError').classList.add('hidden');
  selectFilm({ title, ...parsed });
});

$('renameBtn').addEventListener('click', () => {
  $('nameInput').value = myName || 'Мистер Кивив';
  showDialog('nameDialog');
});
$('nameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('nameInput').value.trim().slice(0, 24);
  if (!name || !joined) return;
  myName = name;
  localStorage.setItem(`cinema-name:${roomId}`, name);
  socket.emit('profile:name', name);
  hideDialog('nameDialog');
  toast(`Теперь твоё имя — ${name}`);
});

$('inviteBtn').addEventListener('click', async () => {
  const link = location.href;
  try {
    await navigator.clipboard.writeText(link);
    toast('Ссылка скопирована! Отправь её своей половинке 💌');
  } catch (_) {
    // Запасной вариант для браузеров без Clipboard API.
    const temp = document.createElement('textarea');
    temp.value = link;
    document.body.appendChild(temp);
    temp.select();
    const copied = document.execCommand('copy');
    temp.remove();
    toast(copied ? 'Ссылка скопирована! 💌' : `Ссылка на комнату: ${link}`);
  }
});

async function init() {
  try {
    const params = new URLSearchParams(location.search);
    roomId = params.get('room') || '';
    if (!/^[a-zA-Z0-9_-]{12,64}$/.test(roomId)) {
      const response = await fetch('/api/new-room', { cache: 'no-store' });
      if (!response.ok) throw new Error('create room failed');
      const data = await response.json();
      roomId = data.roomId;
      history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(roomId)}`);
    }
    $('roomCode').textContent = roomId.slice(0, 8).toUpperCase();
    socket.connect();
  } catch (_) {
    setStatus('Сервер недоступен', 'offline');
    toast('Не удалось создать комнату. Обнови страницу.');
  }
}

setInterval(() => {
  if (!state?.movie || !state.playing) return;
  updateTimeline();
}, 500);

init();
