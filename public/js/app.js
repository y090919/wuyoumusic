// ============================================================
// 无忧音乐播放器 - Main Application
// ============================================================

const App = {
  // State
  songs: [],
  playlists: {},
  currentPlaylist: null,
  currentSong: null,
  currentIndex: -1,
  isPlaying: false,
  isFavorited: false,
  favorites: [],
  favoritesSongs: [],
  lyricsData: [],
  lyricsSource: 'none',
  playMode: 'list',
  searchQuery: '',
  bgConfig: null,
  history: null,

  els: {},

  // ============================================================
  // Init
  // ============================================================
  async init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      audio: $('audio-player'),
      leftPanel: $('left-panel'),
      panelOverlay: $('panel-overlay'),
      menuBtn: $('menu-btn'),
      scanBtn: $('scan-btn'),
      playlistList: $('playlist-list'),
      favoritesList: $('favorites-list'),
      playerView: $('player-view'),
      emptyState: $('empty-state'),
      albumArt: $('album-art'),
      songTitle: $('song-title'),
      songArtist: $('song-artist'),
      lyricsScroll: $('lyrics-scroll'),
      lyricsContainer: $('lyrics-container'),
      progressBar: $('progress-bar'),
      progressFill: $('progress-fill'),
      progressThumb: $('progress-thumb'),
      currentTime: $('current-time'),
      totalTime: $('total-time'),
      playBtn: $('play-btn'),
      prevBtn: $('prev-btn'),
      nextBtn: $('next-btn'),
      favoriteBtn: $('favorite-btn'),
      modeBtn: $('mode-btn'),
      songList: $('song-list'),
      playlistTitle: $('playlist-title'),
      songCount: $('song-count'),
      bcSong: $('bc-song'),
      bottomBar: $('bottom-bar'),
      toast: $('toast'),
      lyricsBtn: $('lyrics-btn'),
      lyricsMenu: $('lyrics-menu'),
      songSearchInput: $('song-search-input'),
      audio: $('audio-player'),
      playIcon: $('play-icon'),
      pauseIcon: $('pause-icon'),
    };

    this.bindEvents();
    this.history = await this.apiGet('/api/history').then(d => d.history).catch(() => null);
    await this.scanSongs();
    await this.loadFavorites();
    await this.loadBgConfig();

    // Restore history
    if (this.history && this.history.songId) {
      const plName = this.history.playlist || '__all__';
      if (this.playlists[plName]) {
        await this.loadPlaylist(plName, false);
        const songs = this.currentPlaylistSongs;
        const idx = songs.findIndex(s => s.id === this.history.songId);
        if (idx >= 0) {
          this.playSong(idx, false);
          if (this.history.position && this.els.audio.duration) {
            this.els.audio.currentTime = this.history.position;
          }
        }
      }
    }

    // Show first playlist if nothing restored
    if (!this.currentSong) {
      const names = Object.keys(this.playlists).filter(n => n !== '__all__');
      if (names.length > 0) {
        this.loadPlaylist(names[0]);
      } else if (this.playlists.__all__ && this.playlists.__all__.length > 0) {
        this.loadPlaylist('__all__');
      }
    }
  },

  // ============================================================
  // API
  // ============================================================
  async apiGet(url, signal) { const r = await fetch(url, { signal }); return r.json(); },
  async apiPost(url, body = {}) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  },

  // Fetch with timeout
  async fetchWithTimeout(url, timeoutMs = 25000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.apiGet(url, ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  },

  // ============================================================
  // Toast
  // ============================================================
  showToast(msg) {
    const t = this.els.toast;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
  },

  // ============================================================
  // Events
  // ============================================================
  bindEvents() {
    const e = this.els;

    // Sidebar toggle (mobile)
    e.menuBtn.addEventListener('click', () => this.togglePanel(true));
    e.panelOverlay.addEventListener('click', () => this.togglePanel(false));

    // Scan
    e.scanBtn.addEventListener('click', () => this.scanSongs(true));

    // Player controls
    e.playBtn.addEventListener('click', () => this.togglePlay());
    e.prevBtn.addEventListener('click', () => this.prev());
    e.nextBtn.addEventListener('click', () => this.next());
    e.favoriteBtn.addEventListener('click', () => this.toggleFavorite());

    // Audio
    e.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
    e.audio.addEventListener('loadedmetadata', () => this.onLoadedMeta());
    e.audio.addEventListener('ended', () => this.onEnded());
    e.audio.addEventListener('error', () => {
      this.showToast('播放出错');
      this.isPlaying = false;
      this.setPlayBtn(false);
    });

    // Seek
    e.progressBar.addEventListener('click', (ev) => {
      const r = e.progressBar.getBoundingClientRect();
      const pct = (ev.clientX - r.left) / r.width;
      if (e.audio.duration) e.audio.currentTime = pct * e.audio.duration;
    });

    // Volume — default max
    e.audio.volume = 1.0;

    // Mode
    e.modeBtn.addEventListener('click', () => this.cyclePlayMode());

    // Lyrics dropdown
    e.lyricsBtn.addEventListener('click', () => this.toggleLyricsMenu());

    // Song search
    e.songSearchInput.addEventListener('input', () => this.filterSongList(e.songSearchInput.value));
    e.songSearchInput.addEventListener('keydown', (ev) => {
      if (ev.code === 'Escape') { e.songSearchInput.value = ''; this.filterSongList(''); }
    });

    // Close lyrics dropdown on outside click
    document.addEventListener('click', (ev) => {
      const dd = e.lyricsBtn.closest('.lyrics-dropdown');
      if (dd && !dd.contains(ev.target)) this.closeLyricsMenu();
    });

    // Save history periodically
    setInterval(() => this.saveHistory(), 30000);

    // Keyboard
    document.addEventListener('keydown', (ev) => {
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
      if (ev.code === 'Space') { ev.preventDefault(); this.togglePlay(); }
      if (ev.code === 'ArrowLeft') this.els.audio.currentTime -= 5;
      if (ev.code === 'ArrowRight') this.els.audio.currentTime += 5;
      if (ev.code === 'ArrowUp') { ev.preventDefault(); this.prev(); }
      if (ev.code === 'ArrowDown') { ev.preventDefault(); this.next(); }
    });
  },

  updateLyricsSourceDisplay() {
    const labels = { local: '本地', online: '在线', none: '无' };
    this.els.lyricsBtn.textContent = `歌词: ${labels[this.lyricsSource] || '无'}`;
  },

  // ============================================================
  // Lyrics Dropdown
  // ============================================================
  toggleLyricsMenu() {
    if (this.els.lyricsMenu.classList.contains('hidden')) {
      this.openLyricsMenu();
    } else {
      this.closeLyricsMenu();
    }
  },

  closeLyricsMenu() {
    this.els.lyricsMenu.classList.add('hidden');
  },

  async openLyricsMenu() {
    if (!this.currentSong) {
      this.showToast('请先选择一首歌曲');
      return;
    }

    const sourceLabels = { netease: '网易云', qq: 'QQ音乐', kugou: '酷狗' };
    const menu = this.els.lyricsMenu;
    menu.innerHTML = '<div class="lyrics-menu-msg">搜索中...</div>';
    menu.classList.remove('hidden');

    try {
      const data = await this.fetchWithTimeout(`/api/lyrics/search/${this.currentSong.id}`, 30000);
      menu.innerHTML = '';
      if (data.results && data.results.length > 0) {
        const header = document.createElement('div');
        header.className = 'lyrics-menu-header';
        header.textContent = '选择歌词版本：';
        menu.appendChild(header);

        data.results.forEach(r => {
          const item = document.createElement('div');
          item.className = 'lyrics-menu-item';
          const srcLabel = sourceLabels[r.source] || r.source;
          item.innerHTML = `<span class="lmi-title">${this.esc(r.title)}</span><span class="lmi-artist">${this.esc(r.artist)}</span><span class="lmi-source">${srcLabel}</span>`;
          item.dataset.source = r.source;
          item.dataset.sourceId = r.sourceId;
          item.addEventListener('click', () => this.applyLyrics(r.source, r.sourceId));
          menu.appendChild(item);
        });
      } else {
        menu.innerHTML = '<div class="lyrics-menu-msg">未找到在线歌词</div>';
      }
    } catch (e) {
      const msg = e.name === 'AbortError' ? '搜索超时，请重试' : '搜索失败（网络错误）';
      menu.innerHTML = `<div class="lyrics-menu-msg">${msg}</div>`;
    }
  },

  async applyLyrics(source, sourceId) {
    this.closeLyricsMenu();
    this.showToast('正在获取歌词...');
    try {
      const data = await this.apiPost(`/api/lyrics/apply/${this.currentSong.id}`, { source, sourceId });
      if (data.success) {
        this.lyricsData = this.parseLRC(data.lyrics);
        this.lyricsSource = 'online';
        this.renderLyrics();
        this.updateLyricsSourceDisplay();
        this.showToast('歌词已更新');
      } else {
        this.showToast(data.message || '获取失败');
      }
    } catch (e) {
      this.showToast('获取歌词失败');
    }
  },

  togglePanel(open) {
    this.els.leftPanel.classList.toggle('open', open);
    this.els.panelOverlay.classList.toggle('open', open);
  },

  // ============================================================
  // Scan
  // ============================================================
  async scanSongs(showToastMsg = false) {
    if (showToastMsg) this.showToast('正在扫描...');
    const data = await this.apiPost('/api/scan');
    this.songs = data.songs || [];
    this.playlists = data.playlists || {};
    this.renderPlaylists();
    this.renderSongListForCurrent();
    if (showToastMsg) this.showToast(`扫描完成，共 ${this.songs.length} 首`);
  },

  // ============================================================
  // Playlist
  // ============================================================
  renderPlaylists() {
    const list = this.els.playlistList;
    list.innerHTML = '';
    const names = Object.keys(this.playlists).filter(n => n !== '__all__');
    for (const name of names) {
      const li = document.createElement('li');
      li.textContent = name;
      li.dataset.playlist = name;
      li.addEventListener('click', () => {
        this.loadPlaylist(name);
        // Mobile: keep sidebar open so user can pick a song
        if (window.innerWidth > 820) this.togglePanel(false);
      });
      if (this.currentPlaylist === name) li.classList.add('active');
      list.appendChild(li);
    }
  },

  get currentPlaylistSongs() {
    if (!this.currentPlaylist || !this.playlists[this.currentPlaylist]) return [];
    return this.playlists[this.currentPlaylist].map(id => this.songs.find(s => s.id === id)).filter(Boolean);
  },

  async loadPlaylist(name, autoSelect = true) {
    this.currentPlaylist = name;
    // Clear search
    this.searchQuery = '';
    this.els.songSearchInput.value = '';
    this.renderPlaylists();
    this.renderSongListForCurrent();

    const songs = this.currentPlaylistSongs;
    if (songs.length === 0) return;

    if (autoSelect) {
      // Restore last played position from localStorage — highlight only, don't interrupt playback
      const savedIdx = this.getPlaylistHistory(name);
      if (savedIdx !== null && savedIdx >= 0 && savedIdx < songs.length) {
        this.highlightSongInList(savedIdx);
      }
    }
  },

  highlightSongInList(index) {
    this.els.songList.querySelectorAll('.song-item.active').forEach(el => el.classList.remove('active'));
    const items = this.els.songList.querySelectorAll('.song-item');
    if (items[index]) {
      items[index].classList.add('active');
      items[index].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  },

  renderSongListForCurrent() {
    const songs = this.currentPlaylistSongs;
    const filtered = this.searchQuery
      ? songs.filter(s => this.songMatchesSearch(s))
      : songs;
    const list = this.els.songList;
    list.innerHTML = '';
    const name = this.currentPlaylist || '选择列表';
    this.els.playlistTitle.textContent = name === '__all__' ? '全部歌曲' : name || '选择列表';
    this.els.songCount.textContent = songs.length ? `${songs.length} 首` : '';

    if (filtered.length === 0) {
      const msg = this.searchQuery ? '未找到匹配歌曲' : '暂无歌曲';
      list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px;">${msg}</div>`;
      return;
    }

    filtered.forEach((song, idx) => {
      const origIdx = songs.indexOf(song);
      const div = document.createElement('div');
      div.className = 'song-item';
      if (this.currentSong && song.id === this.currentSong.id) div.classList.add('active');
      div.innerHTML = `
        ${this.searchQuery ? '' : '<span class="song-item-index">' + (origIdx + 1) + '</span>'}
        <div class="song-item-info">
          <div class="song-item-title">${this.esc(song.title)}</div>
          <div class="song-item-artist">${this.esc(song.artist)}</div>
        </div>
        ${this.searchQuery ? '' : '<span class="song-item-dot' + (song.hasLocalLyrics ? ' has-lyrics' : '') + '"></span>'}
        ${this.searchQuery ? '' : '<span class="song-item-duration">' + (song.duration ? this.fmtTime(song.duration) : '') + '</span>'}
      `;
      div.addEventListener('click', () => this.playSong(origIdx));
      list.appendChild(div);
    });
  },

  songMatchesSearch(song) {
    const q = this.searchQuery.toLowerCase();
    return song.title.toLowerCase().includes(q) || song.artist.toLowerCase().includes(q);
  },

  filterSongList(query) {
    this.searchQuery = query.trim();
    this.renderSongListForCurrent();
  },

  // ============================================================
  // Favorites
  // ============================================================
  async loadFavorites() {
    const data = await this.apiGet('/api/favorites');
    this.favorites = data.ids || [];
    this.favoritesSongs = data.songs || [];
    this.renderFavorites();
    this.updateFavBtn();
  },

  renderFavorites() {
    const list = this.els.favoritesList;
    list.innerHTML = '';
    if (this.favoritesSongs.length === 0) {
      const li = document.createElement('li');
      li.textContent = '暂无收藏';
      li.style.color = 'var(--text3)';
      li.style.cursor = 'default';
      li.style.fontSize = '12px';
      list.appendChild(li);
      return;
    }
    this.favoritesSongs.forEach(song => {
      const li = document.createElement('li');
      li.textContent = `${song.title} - ${song.artist}`;
      li.addEventListener('click', () => {
        const folder = song.folder;
        if (this.playlists[folder]) {
          this.loadPlaylist(folder);
          const songs = this.currentPlaylistSongs;
          const idx = songs.findIndex(s => s.id === song.id);
          if (idx >= 0) this.playSong(idx);
        }
        if (window.innerWidth > 820) this.togglePanel(false);
      });
      list.appendChild(li);
    });
  },

  async toggleFavorite() {
    if (!this.currentSong) return;
    const id = this.currentSong.id;
    if (this.favorites.includes(id)) {
      await this.apiPost('/api/favorites/remove', { id });
      this.favorites = this.favorites.filter(i => i !== id);
      this.favoritesSongs = this.favoritesSongs.filter(s => s.id !== id);
      this.showToast('已取消收藏');
    } else {
      await this.apiPost('/api/favorites/add', { id });
      this.favorites.push(id);
      if (!this.favoritesSongs.find(s => s.id === id)) this.favoritesSongs.push(this.currentSong);
      this.showToast('已收藏');
    }
    this.renderFavorites();
    this.updateFavBtn();
  },

  updateFavBtn() {
    if (!this.currentSong) { this.els.favoriteBtn.classList.remove('favorited'); this.els.favoriteBtn.textContent = '♡'; return; }
    const isFav = this.favorites.includes(this.currentSong.id);
    this.els.favoriteBtn.classList.toggle('favorited', isFav);
    this.els.favoriteBtn.textContent = isFav ? '♥' : '♡';
  },

  // ============================================================
  // Playback
  // ============================================================
  playSong(index, autoplay = true) {
    const songs = this.currentPlaylistSongs;
    if (!songs || songs.length === 0) return;
    if (index < 0) index = 0;
    if (index >= songs.length) index = songs.length - 1;

    this.currentIndex = index;
    this.currentSong = songs[index];

    // Clear search and rebuild full list when playing from search
    if (this.searchQuery) {
      this.searchQuery = '';
      this.els.songSearchInput.value = '';
      this.renderSongListForCurrent();
    }

    // Update UI
    this.els.songTitle.textContent = this.currentSong.title;
    this.els.songArtist.textContent = this.currentSong.artist;
    this.els.bcSong.textContent = `${this.currentSong.title} - ${this.currentSong.artist}`;
    this.els.emptyState.classList.add('hidden');
    this.els.playerView.classList.remove('hidden');
    this.updateFavBtn();

    // Highlight and scroll in list
    this.els.songList.querySelectorAll('.song-item.active').forEach(el => el.classList.remove('active'));
    const items = this.els.songList.querySelectorAll('.song-item');
    if (items[index]) {
      items[index].classList.add('active');
      items[index].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Load audio
    this.els.audio.src = `/api/stream/${this.currentSong.id}`;
    this.els.audio.load();
    if (autoplay) {
      this.els.audio.play().then(() => {
        this.isPlaying = true;
        this.setPlayBtn(true);
      }).catch(() => {});
    } else {
      this.isPlaying = false;
      this.setPlayBtn(false);
    }

    // Load lyrics
    this.loadLyrics(this.currentSong);
    this.saveHistory();
    this.savePlaylistHistory(this.currentPlaylist, this.currentIndex);
  },

  togglePlay() {
    if (!this.currentSong) return;
    if (this.els.audio.paused) {
      this.els.audio.play().then(() => { this.isPlaying = true; this.setPlayBtn(true); }).catch(() => {});
    } else {
      this.els.audio.pause();
      this.isPlaying = false;
      this.setPlayBtn(false);
    }
  },

  setPlayBtn(playing) {
    this.els.playIcon.style.display = playing ? 'none' : '';
    this.els.pauseIcon.style.display = playing ? '' : 'none';
    this.els.playBtn.classList.toggle('is-playing', playing);
  },

  prev() {
    const songs = this.currentPlaylistSongs;
    if (songs.length === 0) return;
    let idx = this.currentIndex - 1;
    if (idx < 0) idx = songs.length - 1;
    this.playSong(idx);
  },

  next() {
    const songs = this.currentPlaylistSongs;
    if (songs.length === 0) return;
    if (this.playMode === 'shuffle') {
      let idx;
      do { idx = Math.floor(Math.random() * songs.length); } while (idx === this.currentIndex && songs.length > 1);
      this.playSong(idx);
    } else {
      let idx = this.currentIndex + 1;
      if (idx >= songs.length) idx = 0;
      this.playSong(idx);
    }
  },

  cyclePlayMode() {
    const modes = ['list', 'loop', 'shuffle'];
    const labels = { list: '列表循环', loop: '单曲循环', shuffle: '随机播放' };
    const idx = modes.indexOf(this.playMode);
    this.playMode = modes[(idx + 1) % modes.length];
    this.els.modeBtn.textContent = labels[this.playMode];
    this.showToast(labels[this.playMode]);
  },

  // ============================================================
  // Audio Events
  // ============================================================
  onTimeUpdate() {
    const a = this.els.audio;
    if (!a.duration) return;
    const pct = (a.currentTime / a.duration) * 100;
    this.els.progressFill.style.width = pct + '%';
    this.els.currentTime.textContent = this.fmtTime(a.currentTime);
    this.updateLyrics(a.currentTime);
  },

  onLoadedMeta() {
    const a = this.els.audio;
    this.els.totalTime.textContent = this.fmtTime(a.duration || 0);
    if (this.currentSong && !this.currentSong.duration) {
      this.currentSong.duration = a.duration || 0;
      this.renderSongListForCurrent();
    }
  },

  onEnded() {
    if (this.playMode === 'loop') {
      this.els.audio.currentTime = 0;
      this.els.audio.play().catch(() => {});
    } else {
      this.next();
    }
  },

  // ============================================================
  // LYRICS — FIXED
  // ============================================================
  async loadLyrics(song) {
    if (!song) return;
    try {
      const data = await this.apiGet(`/api/lyrics/${song.id}?source=auto`);
      if (data.lyrics && data.lyrics.trim().length > 0) {
        this.lyricsData = this.parseLRC(data.lyrics);
        this.lyricsSource = data.source;
      } else {
        this.lyricsData = [];
        this.lyricsSource = 'none';
      }
    } catch (e) {
      this.lyricsData = [];
      this.lyricsSource = 'none';
    }
    this.renderLyrics();
    this.updateLyricsSourceDisplay();
  },

  parseLRC(text) {
    // Remove BOM (U+FEFF)
    let clean = text;
    if (clean.charCodeAt(0) === 0xFEFF) clean = clean.slice(1);
    clean = clean.trim();
    const lines = clean.split('\n');
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Find all timestamps
      timeRegex.lastIndex = 0;
      const timestamps = [];
      let lastIdx = 0;
      let match;

      while ((match = timeRegex.exec(trimmed)) !== null) {
        const m = parseInt(match[1], 10);
        const s = parseInt(match[2], 10);
        let ms = parseInt(match[3], 10);
        if (match[3].length === 2) ms *= 10;
        timestamps.push(m * 60 + s + ms / 1000);
        lastIdx = match.index + match[0].length;
      }

      let text = trimmed.substring(lastIdx).trim().replace(/^[：:]\s*/, '').trim();

      if (timestamps.length > 0) {
        if (text) {
          for (const ts of timestamps) {
            result.push({ time: ts, text });
          }
        }
      } else {
        // No timestamp: treat as metadata or header
        // Only include if it doesn't look like metadata
        if (trimmed.length > 0 && this.isLyricLine(trimmed)) {
          result.push({ time: -1, text: trimmed });
        }
      }
    }

    // Sort by time
    result.sort((a, b) => a.time - b.time);
    // Separate no-time and timed
    const noTime = result.filter(r => r.time < 0);
    const withTime = result.filter(r => r.time >= 0);

    // Filter out metadata lines that have timestamps (e.g. "[00:00.000] 词 : xxx")
    // but keep actual lyrics
    const filteredTime = withTime.filter(d => {
      const t = d.text;
      // Remove common metadata prefixes
      return !/^(作词|作曲|编曲|制作|混音|母带|和声|录音|OP|SP|封面|出品|监制|企划|统筹|发行|OP：|SP：|词：|曲：)/.test(t);
    });

    // If all timed lines were filtered, keep metadata (better than nothing)
    const finalTimed = filteredTime.length > 0 ? filteredTime : withTime;

    return [...noTime, ...finalTimed];
  },

  isLyricLine(text) {
    // Check if this looks like an actual lyric line, not metadata
    const meta = ['作词', '作曲', '编曲', '制作', '混音', '母带', '和声', '录音', 'OP', 'SP', '封面', '出品', '监制', '企划', '统筹', '发行'];
    for (const m of meta) {
      if (text.startsWith(m) || text.startsWith(m + '：') || text.startsWith(m + ':')) return false;
    }
    // Lines with only punctuation or numbers are probably not lyrics
    if (/^[\s\W]+$/.test(text) && text.length < 5) return false;
    return true;
  },

  renderLyrics() {
    const scroll = this.els.lyricsScroll;
    scroll.innerHTML = '';

    if (!this.lyricsData || this.lyricsData.length === 0) {
      scroll.innerHTML = '<p class="lyrics-placeholder">暂无歌词</p>';
      return;
    }

    for (const line of this.lyricsData) {
      const p = document.createElement('p');
      p.textContent = line.text || ' ';
      p.dataset.time = line.time;
      // Click to seek
      if (line.time >= 0) {
        p.style.cursor = 'pointer';
        p.addEventListener('click', () => {
          this.els.audio.currentTime = line.time;
        });
      }
      scroll.appendChild(p);
    }
  },

  updateLyrics(currentTime) {
    const data = this.lyricsData;
    const lines = this.els.lyricsScroll.querySelectorAll('p');
    if (!lines.length || !data.length) return;

    let activeIdx = -1;

    // Find the current line: last line where time <= currentTime
    for (let i = 0; i < data.length; i++) {
      if (data[i].time >= 0 && data[i].time <= currentTime) {
        activeIdx = i;
      }
    }

    // More precise: check between timestamps
    for (let i = 0; i < data.length - 1; i++) {
      const d = data[i];
      const next = data[i + 1];
      if (d.time >= 0 && currentTime >= d.time && currentTime < next.time) {
        activeIdx = i;
        break;
      }
    }

    // Past last timestamp
    if (data.length > 0) {
      const last = data[data.length - 1];
      if (last.time >= 0 && currentTime >= last.time) {
        activeIdx = data.length - 1;
      }
    }

    lines.forEach((p, idx) => {
      p.classList.toggle('active', idx === activeIdx);
    });

    // Scroll to active
    if (activeIdx >= 0 && lines[activeIdx]) {
      lines[activeIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },

  // ============================================================
  // History
  // ============================================================
  getPlaylistHistory(name) {
    try {
      const h = JSON.parse(localStorage.getItem('playlistHistory') || '{}');
      return h[name] !== undefined ? h[name] : null;
    } catch(e) { return null; }
  },

  savePlaylistHistory(name, index) {
    try {
      const h = JSON.parse(localStorage.getItem('playlistHistory') || '{}');
      h[name] = index;
      localStorage.setItem('playlistHistory', JSON.stringify(h));
    } catch(e) {}
  },

  async saveHistory() {
    if (!this.currentSong) return;
    await this.apiPost('/api/history', {
      playlist: this.currentPlaylist,
      songId: this.currentSong.id,
      position: this.els.audio.currentTime || 0
    });
  },

  // ============================================================
  // Background Config
  // ============================================================
  async loadBgConfig() {
    try {
      const res = await fetch('/api/config/bg');
      this.bgConfig = await res.json();
    } catch (e) {
      this.bgConfig = null;
    }
    this.applyBackground();
    window.addEventListener('resize', () => this.applyBackground());
  },

  applyBackground() {
    if (!this.bgConfig) return;
    const isMobile = window.innerWidth <= 820;
    const mode = isMobile ? 'mobile' : 'desktop';
    const filename = this.bgConfig[mode] || null;

    const styleId = 'dynamic-bg';
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }

    if (filename) {
      styleEl.textContent = `.bg-layer { background-image: url(/bg-images/${encodeURIComponent(filename)}); background-size: cover; background-position: center; background-repeat: no-repeat; }`;
    } else {
      // Default Morandi gradient
      styleEl.textContent = `.bg-layer { background:
        radial-gradient(ellipse 70% 60% at 15% 85%, rgba(139,125,139,0.15) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at 85% 20%, rgba(138,154,138,0.12) 0%, transparent 55%),
        radial-gradient(ellipse 50% 40% at 50% 50%, rgba(154,138,130,0.08) 0%, transparent 50%),
        radial-gradient(ellipse 40% 60% at 70% 80%, rgba(125,138,154,0.10) 0%, transparent 50%),
        #0e0c10; }`;
    }
  },

  // ============================================================
  // Utils
  // ============================================================
  fmtTime(s) {
    if (!s || isNaN(s)) return '00:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  },

  esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
