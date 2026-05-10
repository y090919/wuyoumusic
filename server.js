const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execSync } = require('child_process');

// ============================================================
// Configuration
// ============================================================
const ROOT_DIR = __dirname;
const MUSIC_DIR = path.join(ROOT_DIR, '__歌曲目录');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const BG_CONFIG_FILE = path.join(DATA_DIR, 'bg-config.json');
const BG_DIR = path.join(DATA_DIR, 'bg');

let serverInstance = null;
let currentPort = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { port: 8080 };
}

function saveConfig(config) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function loadJSON(file, defaultVal) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { /* ignore */ }
  return defaultVal;
}

function saveJSON(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ============================================================
// Song Database (in-memory, built on scan)
// ============================================================
let songDB = [];         // all songs
let playlists = {};      // { folderName: [songIndex, ...] }

function scanMusicFolder() {
  songDB = [];
  playlists = {};

  if (!fs.existsSync(MUSIC_DIR)) {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    return { songs: [], playlists: {} };
  }

  const audioExts = ['.mp3', '.flac', '.wav', '.ogg', '.aac', '.m4a', '.wma'];
  const folders = fs.readdirSync(MUSIC_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let idCounter = 0;

  for (const folder of folders) {
    const folderPath = path.join(MUSIC_DIR, folder);
    const files = fs.readdirSync(folderPath);
    const audioFiles = files.filter(f => audioExts.includes(path.extname(f).toLowerCase()));

    const playlistSongs = [];

    for (const file of audioFiles) {
      const filePath = path.join(folderPath, file);
      const stat = fs.statSync(filePath);
      const lrcFile = filePath.replace(path.extname(filePath), '.lrc');
      const hasLocalLyrics = fs.existsSync(lrcFile);

      // Parse title and artist from filename
      const nameWithoutExt = path.basename(file, path.extname(file));
      let title = nameWithoutExt;
      let artist = '未知艺术家';

      // Try "artist - title" or "artist-title" pattern
      const dashPatterns = [' - ', ' – ', ' — ', '-', '—'];
      for (const sep of dashPatterns) {
        const idx = nameWithoutExt.indexOf(sep);
        if (idx > 0) {
          artist = nameWithoutExt.substring(0, idx).trim();
          title = nameWithoutExt.substring(idx + sep.length).trim();
          break;
        }
      }

      const song = {
        id: String(idCounter++),
        title,
        artist,
        folder,
        filePath,
        fileName: file,
        hasLocalLyrics,
        size: stat.size,
        mtime: stat.mtimeMs
      };

      songDB.push(song);
      playlistSongs.push(song.id);
    }

    // Sort by artist name (pinyin order via localeCompare)
    playlistSongs.sort((a, b) => {
      const sa = songDB.find(s => s.id === a);
      const sb = songDB.find(s => s.id === b);
      if (!sa || !sb) return 0;
      return sa.artist.localeCompare(sb.artist, 'zh-CN-u-kf-upper');
    });

    if (playlistSongs.length > 0) {
      playlists[folder] = playlistSongs;
    }
  }

  // Build "all songs" playlist sorted by artist
  const allIds = songDB.map(s => s.id);
  allIds.sort((a, b) => {
    const sa = songDB.find(s => s.id === a);
    const sb = songDB.find(s => s.id === b);
    if (!sa || !sb) return 0;
    return sa.artist.localeCompare(sb.artist, 'zh-CN-u-kf-upper');
  });
  playlists['__all__'] = allIds;
  // Build favorites playlist (IDs only, populated lazily)

  return { songs: songDB, playlists };
}

// ============================================================
// HTTPS Helper (pkg-compatible alternative to fetch)
// ============================================================
function httpsGet(url, extraHeaders) {
  const baseHeaders = {
    'Referer': 'https://music.163.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign(baseHeaders, extraHeaders || {}),
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ============================================================
// Online Lyrics Fetching
// ============================================================
async function fetchNeteaseLyrics(title, artist) {
  const query = encodeURIComponent(`${title} ${artist}`);
  const searchUrl = `https://music.163.com/api/search/get?type=1&s=${query}&limit=5`;

  try {
    const searchData = await httpsGet(searchUrl);
    if (!searchData.result || !searchData.result.songs || searchData.result.songs.length === 0) {
      return null;
    }

    const songId = searchData.result.songs[0].id;

    const lyricData = await httpsGet(`https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`);

    if (lyricData.lrc && lyricData.lrc.lyric) {
      // Check if it's useful (not just instrumental info)
      if (lyricData.lrc.lyric.trim().length > 10) {
        return lyricData.lrc.lyric;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// Multi-source Lyrics Search & Fetch
// ============================================================
const SOURCE_LABELS = { netease: '网易云', qq: 'QQ音乐', kugou: '酷狗' };

async function searchNetease(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const d = await httpsGet(`https://music.163.com/api/search/get?type=1&s=${q}&limit=5`);
    const results = [];
    if (d.result && d.result.songs) {
      for (const s of d.result.songs) {
        const artists = s.artists ? s.artists.map(a => a.name).join(', ') : '未知';
        if (!results.some(r => r.sourceId === String(s.id))) {
          results.push({ source: 'netease', sourceId: String(s.id), title: s.name, artist: artists, duration: s.duration || 0 });
        }
      }
    }
    return results;
  } catch (e) { return []; }
}

async function fetchNeteaseLyricsById(sourceId) {
  const d = await httpsGet(`https://music.163.com/api/song/lyric?id=${sourceId}&lv=1&kv=1&tv=-1`);
  if (d.lrc && d.lrc.lyric && d.lrc.lyric.trim().length > 10) return d.lrc.lyric;
  return null;
}

async function searchQQ(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const d = await httpsGet(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${q}&p=1&n=8&format=json`, { Referer: 'https://y.qq.com' });
    const results = [];
    if (d.code === 0 && d.data && d.data.song && d.data.song.list) {
      for (const s of d.data.song.list) {
        const singers = s.singer ? s.singer.map(a => a.name).join(', ') : '未知';
        if (!results.some(r => r.sourceId === s.songmid)) {
          results.push({ source: 'qq', sourceId: s.songmid, title: s.songname, artist: singers, duration: (s.interval || 0) * 1000 });
        }
      }
    }
    return results;
  } catch (e) { return []; }
}

async function fetchQQLyricsById(sourceId) {
  try {
    const d = await httpsGet(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${sourceId}&format=json&nobase64=1`, { Referer: 'https://y.qq.com' });
    if (d.code === 0 && d.lyric && d.lyric.trim().length > 10) return d.lyric;
    // Fallback: try base64 decoded
    if (d.code === 0 && d.lyric) {
      const decoded = Buffer.from(d.lyric, 'base64').toString('utf8');
      if (decoded.trim().length > 10) return decoded;
    }
    return null;
  } catch (e) { return null; }
}

async function searchKugou(title, artist) {
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const d = await httpsGet(`https://songsearch.kugou.com/song_search_v2?keyword=${q}&page=1&pagesize=8&platform=WebFilter`, { Referer: 'https://www.kugou.com' });
    const results = [];
    if ((d.status === 0 || d.status === 1) && d.data && d.data.lists) {
      for (const s of d.data.lists) {
        if (!s.FileHash) continue;
        if (!results.some(r => r.sourceId === s.FileHash)) {
          results.push({ source: 'kugou', sourceId: s.FileHash, title: s.SongName || s.SongName, artist: s.SingerName || '未知', duration: (s.Duration || 0) * 1000 });
        }
      }
    }
    return results;
  } catch (e) { return []; }
}

async function fetchKugouLyricsById(sourceId) {
  try {
    const d = await httpsGet(`https://www.kugou.com/yy/index.php?r=play/getdata&hash=${sourceId}&mid=1`, { Referer: 'https://www.kugou.com' });
    if (d.status === 0 && d.data && d.data.lyrics) {
      const lyrics = d.data.lyrics;
      if (lyrics.trim().length > 10) return lyrics;
    }
    return null;
  } catch (e) { return null; }
}

async function searchAllSources(title, artist) {
  // Per-search timeout: prevent DNS / socket hangs from blocking the entire search
  const withTimeout = (prom, ms) => {
    let timer;
    return Promise.race([
      prom,
      new Promise(resolve => { timer = setTimeout(() => resolve([]), ms); })
    ]).finally(() => clearTimeout(timer));
  };

  const [netease, qq, kugou] = await Promise.all([
    withTimeout(searchNetease(title, artist), 6000),
    withTimeout(searchQQ(title, artist), 6000),
    withTimeout(searchKugou(title, artist), 6000)
  ]);
  return [...qq, ...netease, ...kugou];
}

async function fetchLyrics(source, sourceId) {
  switch (source) {
    case 'netease': return fetchNeteaseLyricsById(sourceId);
    case 'qq': return fetchQQLyricsById(sourceId);
    case 'kugou': return fetchKugouLyricsById(sourceId);
    default: return null;
  }
}

// ============================================================
// Express App Setup
// ============================================================
function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BG_DIR)) fs.mkdirSync(BG_DIR, { recursive: true });

  // Static files (works in dev and with pkg bundled assets)
  app.use(express.static(path.join(ROOT_DIR, 'public')));
  // Background images
  app.use('/bg-images', express.static(BG_DIR));

  // Fallback route handlers for critical pages (pkg compatibility)
  const serveFile = (file) => (req, res) => {
    const filePath = path.join(ROOT_DIR, 'public', file);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).send('File not found');
    }
  };

  app.get('/admin', serveFile('admin.html'));
  app.get('/', serveFile('index.html'));

  // Favicon
  app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
  });

  // ==================== Music APIs ====================

  // Scan music folder (manual only)
  app.post('/api/scan', (req, res) => {
    const result = scanMusicFolder();
    res.json({ success: true, ...result });
  });

  // Get all songs / playlists
  app.get('/api/songs', (req, res) => {
    res.json({ songs: songDB, playlists });
  });

  // Get songs for a specific playlist
  app.get('/api/playlist/:name', (req, res) => {
    const name = req.params.name;
    const ids = playlists[name];
    if (!ids) return res.status(404).json({ error: 'Playlist not found' });
    const songs = ids.map(id => songDB.find(s => s.id === id)).filter(Boolean);
    res.json({ name, songs });
  });

  // Stream audio file
  app.get('/api/stream/:id', (req, res) => {
    const song = songDB.find(s => s.id === req.params.id);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    if (!fs.existsSync(song.filePath)) return res.status(404).json({ error: 'File not found' });

    const stat = fs.statSync(song.filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;
      const stream = fs.createReadStream(song.filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'audio/mpeg'
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(song.filePath).pipe(res);
    }
  });

  // ==================== Lyrics APIs ====================

  // Helper: check if LRC has actual lyric content (not just metadata)
  function hasRealLyrics(lrcText) {
    if (!lrcText || lrcText.trim().length < 10) return false;
    // Remove BOM (U+FEFF) and trim
    let clean = lrcText;
    if (clean.charCodeAt(0) === 0xFEFF) clean = clean.slice(1);
    clean = clean.trim();
    const lines = clean.split('\n');
    // Count non-empty, non-metadata lines
    let lyricCount = 0;
    const metaPrefixes = ['作词', '作曲', '编曲', '制作', '混音', '母带', '和声', '录音', 'OP', 'SP', '封面', '出品', '监制', '企划', '统筹', '发行'];
    for (const line of lines) {
      const withoutTag = line.replace(/\[.*?\]/g, '').trim();
      if (!withoutTag) continue;
      const isMeta = metaPrefixes.some(p => withoutTag.startsWith(p));
      if (!isMeta) lyricCount++;
    }
    return lyricCount >= 2;
  }

  // Get lyrics: local first, fallback to online
  app.get('/api/lyrics/:id', async (req, res) => {
    const song = songDB.find(s => s.id === req.params.id);
    if (!song) return res.status(404).json({ error: 'Song not found' });

    const lrcPath = song.filePath.replace(path.extname(song.filePath), '.lrc');
    const source = req.query.source || 'auto';

    // Online only
    if (source === 'online') {
      const onlineLyrics = await fetchNeteaseLyrics(song.title, song.artist);
      if (onlineLyrics) {
        try { fs.writeFileSync(lrcPath, onlineLyrics, 'utf8'); song.hasLocalLyrics = true; } catch (e) { /* ignore */ }
        return res.json({ lyrics: onlineLyrics, source: 'online' });
      }
      return res.json({ lyrics: '', source: 'none' });
    }

    // Local only
    if (source === 'local') {
      if (fs.existsSync(lrcPath)) {
        const lyrics = fs.readFileSync(lrcPath, 'utf8');
        if (hasRealLyrics(lyrics)) {
          return res.json({ lyrics, source: 'local' });
        }
      }
      return res.json({ lyrics: '', source: 'none' });
    }

    // Auto: try local, if no real content fallback to online
    let localLyrics = null;
    if (fs.existsSync(lrcPath)) {
      localLyrics = fs.readFileSync(lrcPath, 'utf8');
      if (hasRealLyrics(localLyrics)) {
        return res.json({ lyrics: localLyrics, source: 'local' });
      }
    }

    // Local empty or not real lyrics → try online
    const onlineLyrics = await fetchNeteaseLyrics(song.title, song.artist);
    if (onlineLyrics) {
      try { fs.writeFileSync(lrcPath, onlineLyrics, 'utf8'); song.hasLocalLyrics = true; } catch (e) { /* ignore */ }
      return res.json({ lyrics: onlineLyrics, source: 'online' });
    }

    // Fallback: serve whatever local has (even if just metadata)
    if (localLyrics) {
      return res.json({ lyrics: localLyrics, source: 'local' });
    }

    res.json({ lyrics: '', source: 'none' });
  });

  // Force refresh online lyrics
  app.post('/api/lyrics/refresh/:id', async (req, res) => {
    const song = songDB.find(s => s.id === req.params.id);
    if (!song) return res.status(404).json({ error: 'Song not found' });

    const onlineLyrics = await fetchNeteaseLyrics(song.title, song.artist);
    if (onlineLyrics) {
      const lrcPath = song.filePath.replace(path.extname(song.filePath), '.lrc');
      try { fs.writeFileSync(lrcPath, onlineLyrics, 'utf8'); } catch (e) { /* ignore */ }
      return res.json({ lyrics: onlineLyrics, source: 'online' });
    }
    res.json({ lyrics: '', source: 'none' });
  });

  // Search lyrics candidates from all sources
  app.get('/api/lyrics/search/:id', async (req, res) => {
    const song = songDB.find(s => s.id === req.params.id);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    try {
      const results = await searchAllSources(song.title, song.artist);
      res.json({ results });
    } catch (e) {
      res.json({ results: [] });
    }
  });

  // Apply lyrics from a specific source
  app.post('/api/lyrics/apply/:id', async (req, res) => {
    const song = songDB.find(s => s.id === req.params.id);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    const { source, sourceId } = req.body;
    if (!source || !sourceId) return res.status(400).json({ error: 'Missing source or sourceId' });

    try {
      const lyrics = await fetchLyrics(source, sourceId);
      if (lyrics) {
        const lrcPath = song.filePath.replace(path.extname(song.filePath), '.lrc');
        fs.writeFileSync(lrcPath, lyrics, 'utf8');
        song.hasLocalLyrics = true;
        return res.json({ success: true, lyrics });
      }
      res.json({ success: false, message: '该版本无有效歌词' });
    } catch (e) {
      res.status(500).json({ success: false, message: '获取失败' });
    }
  });

  // ==================== Favorites APIs ====================

  app.get('/api/favorites', (req, res) => {
    const ids = loadJSON(FAVORITES_FILE, []);
    const songs = ids.map(id => songDB.find(s => s.id === id)).filter(Boolean);
    res.json({ ids, songs });
  });

  app.post('/api/favorites/add', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing song id' });
    let ids = loadJSON(FAVORITES_FILE, []);
    if (!ids.includes(id)) {
      ids.push(id);
      saveJSON(FAVORITES_FILE, ids);
    }
    res.json({ success: true, ids });
  });

  app.post('/api/favorites/remove', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing song id' });
    let ids = loadJSON(FAVORITES_FILE, []);
    ids = ids.filter(i => i !== id);
    saveJSON(FAVORITES_FILE, ids);
    res.json({ success: true, ids });
  });

  // ==================== History APIs ====================

  app.get('/api/history', (req, res) => {
    const history = loadJSON(HISTORY_FILE, null);
    res.json({ history });
  });

  app.post('/api/history', (req, res) => {
    const { playlist, songId, position } = req.body;
    const history = { playlist: playlist || '__all__', songId: songId || null, position: position || 0, timestamp: Date.now() };
    saveJSON(HISTORY_FILE, history);
    res.json({ success: true, history });
  });

  // ==================== Background Config API ====================

  app.get('/api/config/bg', (req, res) => {
    const bg = loadJSON(BG_CONFIG_FILE, null);
    // List available images in BG_DIR
    let images = [];
    try {
      if (fs.existsSync(BG_DIR)) {
        images = fs.readdirSync(BG_DIR).filter(f => /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(f));
      }
    } catch (e) { /* ignore */ }
    const config = bg || { desktop: null, mobile: null };
    // Normalize: old format had { type, customCss } objects — treat as no-image
    if (config.desktop && typeof config.desktop === 'object') config.desktop = null;
    if (config.mobile && typeof config.mobile === 'object') config.mobile = null;
    res.json({ ...config, images });
  });

  app.post('/api/config/bg', (req, res) => {
    const { desktop, mobile } = req.body;
    saveJSON(BG_CONFIG_FILE, { desktop: desktop || null, mobile: mobile || null });
    res.json({ success: true });
  });

  app.post('/api/config/bg/upload', (req, res) => {
    const { name, data } = req.body;
    if (!name || !data) return res.status(400).json({ error: '缺少文件名或数据' });
    const ext = path.extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
      return res.status(400).json({ error: '不支持的图片格式' });
    }
    if (!fs.existsSync(BG_DIR)) fs.mkdirSync(BG_DIR, { recursive: true });
    // Deduplicate filename
    let finalName = name;
    let counter = 1;
    while (fs.existsSync(path.join(BG_DIR, finalName))) {
      const base = path.basename(name, ext);
      finalName = `${base}_${counter}${ext}`;
      counter++;
    }
    const buf = Buffer.from(data, 'base64');
    fs.writeFileSync(path.join(BG_DIR, finalName), buf);
    res.json({ success: true, filename: finalName });
  });

  app.post('/api/config/bg/delete', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: '缺少文件名' });
    const filePath = path.join(BG_DIR, path.basename(filename));
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: '删除失败' });
    }
  });

  // ==================== Admin APIs ====================

  app.get('/api/admin/status', (req, res) => {
    res.json({
      running: true,
      port: currentPort,
      songCount: songDB.length,
      playlistCount: Object.keys(playlists).length,
      musicDir: MUSIC_DIR
    });
  });

  app.post('/api/admin/restart', (req, res) => {
    // Will restart the process
    res.json({ success: true, message: '正在重启服务...' });

    setTimeout(() => {
      const newPort = req.body.port || loadConfig().port;
      saveConfig({ port: newPort });

      if (process.pkg) {
        const exePath = process.execPath;
        const args = process.argv.slice(1);
        spawn(exePath, args, {
          stdio: 'inherit',
          detached: true
        });
        process.exit(0);
      } else {
        const child = spawn(process.argv[0], process.argv.slice(1), {
          stdio: 'inherit',
          detached: true
        });
        process.exit(0);
      }
    }, 500);
  });

  app.post('/api/admin/shutdown', (req, res) => {
    res.json({ success: true, message: '正在关闭服务...' });
    setTimeout(() => {
      process.exit(0);
    }, 500);
  });

  app.post('/api/admin/port', (req, res) => {
    const { port } = req.body;
    if (!port || port < 1 || port > 65535) {
      return res.status(400).json({ error: '无效端口号' });
    }
    saveConfig({ port });

    // If dev mode with launcher, just respond
    res.json({ success: true, port, message: '端口已保存。请重启服务以应用更改。' });

    // In production mode single-process, trigger restart
    setTimeout(() => {
      const exePath = process.pkg ? process.execPath : process.argv[0];
      const args = process.argv.slice(1);
      spawn(exePath, args, { stdio: 'inherit', detached: true });
      process.exit(0);
    }, 1000);
  });

  return app;
}

// ============================================================
// Start Server
// ============================================================
function startServer(port) {
  const app = createApp();
  return new Promise((resolve, reject) => {
    serverInstance = app.listen(port, () => {
      currentPort = port;
      console.log(`\n  🎵 无忧音乐播放器已启动`);
      console.log(`  📡 地址: http://localhost:${port}`);
      console.log(`  🎮 管理: http://localhost:${port}/admin`);
      console.log(`  📁 音乐目录: ${MUSIC_DIR}\n`);

      // Auto-hide to system tray when running as packaged exe
      if (process.pkg && process.platform === 'win32') {
        setTimeout(() => setupTray(port), 1500);
      }

      resolve(port);
    });
    serverInstance.on('error', (err) => {
      reject(err);
    });
  });
}

// ============================================================
// System Tray (Windows pkg mode)
// ============================================================
let trayProcess = null;
let trayPsPath = null;

function getTrayScript(port, pid) {
  return `param($p,$n)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$t=New-Object System.Windows.Forms.NotifyIcon
$t.Text="无忧音乐播放器 - http://localhost:$n"
try{$t.Icon=[System.Drawing.Icon]::ExtractAssociatedIcon("$env:SystemRoot\\system32\\wmploc.dll")}catch{}
$t.Visible=$true
$t.Add_Click({if($_.Button -eq [System.Windows.Forms.MouseButtons]::Left){[System.Diagnostics.Process]::Start("http://localhost:$n")}})
$m=New-Object System.Windows.Forms.ContextMenuStrip
$x=New-Object System.Windows.Forms.ToolStripMenuItem("关闭服务器 (&X)")
$o=New-Object System.Windows.Forms.ToolStripMenuItem("打开播放器 (&O)")
$o.Add_Click({[System.Diagnostics.Process]::Start("http://localhost:$n")})
$x.Add_Click({$t.Visible=$false;$t.Dispose();try{[System.Diagnostics.Process]::GetProcessById($p).Kill()}catch{};[System.Windows.Forms.Application]::Exit()})
[void]$m.Items.Add($o)
[void]$m.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$m.Items.Add($x)
$t.ContextMenuStrip=$m
Register-ObjectEvent -InputObject ([System.Diagnostics.Process]::GetProcessById($p)) -EventName Exited -Action{$t.Visible=$false;$t.Dispose();[System.Windows.Forms.Application]::Exit()} | Out-Null
[System.Windows.Forms.Application]::Run()`;
}

function setupTray(port) {
  try {
    const psScript = getTrayScript(process.pid, port);
    trayPsPath = path.join(DATA_DIR, `_tray_${process.pid}.ps1`);
    fs.writeFileSync(trayPsPath, psScript, 'utf8');

    trayProcess = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', trayPsPath, process.pid.toString(), port.toString()
    ], { detached: true, stdio: 'ignore' });
    trayProcess.unref();

    // Hide console window
    try {
      execSync(
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "& {[Console]::WindowVisible = $false}"',
        { stdio: 'inherit', timeout: 5000 }
      );
    } catch (_) {}
  } catch (e) {
    console.error('托盘启动失败:', e.message);
  }
}

// Cleanup tray temp file
process.on('exit', () => {
  try { if (trayPsPath) fs.unlinkSync(trayPsPath); } catch (_) {}
});

// ============================================================
// Main - runs when launched directly (not through launcher)
// ============================================================
if (require.main === module) {
  const config = loadConfig();
  const port = process.argv[2] || config.port || 8080;

  // Initialize: scan music folder
  scanMusicFolder();
  console.log(`已扫描 ${songDB.length} 首歌曲`);

  startServer(parseInt(port, 10)).catch(err => {
    console.error('启动失败:', err.message);
    process.exit(1);
  });
}

module.exports = { createApp, startServer, scanMusicFolder, songDB, playlists };
