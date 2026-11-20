const audio = document.querySelector('#audio');
const audioInput = document.querySelector('#audioInput');
const coverInput = document.querySelector('#coverInput');
const trackList = document.querySelector('#trackList');
const emptyState = document.querySelector('#emptyState');
const trackCount = document.querySelector('#trackCount');
const playButton = document.querySelector('#playButton');
const seekBar = document.querySelector('#seekBar');
const currentTime = document.querySelector('#currentTime');
const duration = document.querySelector('#duration');
const record = document.querySelector('#record');
const tonearm = document.querySelector('#tonearm');
const tracks = [];
let currentIndex = -1;
let shuffle = false;
let repeat = false;
let restorePromise = Promise.resolve();
let cloud = null;
let cloudUser = null;
let activePlaylistId = null;
let activePlaylistName = '';
let activePlaylistOwnerId = null;
let cloudChannel = null;

const cloudPanel = document.querySelector('#cloudPanel');
const cloudAuthForm = document.querySelector('#cloudAuthForm');
const cloudStatus = document.querySelector('#cloudStatus');

function setCloudStatus(message) {
  cloudStatus.textContent = message;
}

function setOperationNotice(message, kind = 'info') {
  const notice = document.querySelector('#operationNotice');
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = !message;
}

async function refreshCloudTracks() {
  if (!cloud || !activePlaylistId) return;
  const selectedId = tracks[currentIndex]?.id;
  const { data, error } = await cloud.from('tracks')
    .select('*')
    .eq('playlist_id', activePlaylistId)
    .order('created_at', { ascending: true });
  if (error) {
    setCloudStatus(`Liste yüklenemedi: ${error.message}`);
    return;
  }
  const previous = new Map(tracks.map(track => [track.id, track]));
  const cloudTracks = (data || []).map(row => {
    const oldTrack = previous.get(row.id);
    return {
      ...oldTrack,
      id: row.id,
      title: row.title,
      artist: row.artist,
      url: oldTrack?.audioPath === row.audio_path ? oldTrack.url : '',
      coverUrl: oldTrack?.coverPath === row.cover_path ? oldTrack.coverUrl : '',
      audioPath: row.audio_path,
      coverPath: row.cover_path,
      createdAt: row.created_at,
      uploadState: 'ready'
    };
  });
  const cloudIds = new Set(cloudTracks.map(track => track.id));
  for (const pending of tracks) {
    if (pending.uploadState === 'uploading' && !cloudIds.has(pending.id)) cloudTracks.push(pending);
  }
  tracks.splice(0, tracks.length, ...cloudTracks);
  currentIndex = selectedId ? tracks.findIndex(track => track.id === selectedId) : -1;
  if (currentIndex >= 0) {
    const current = tracks[currentIndex];
    setCover(current);
  } else {
    audio.pause();
    audio.removeAttribute('src');
    if (tracks.length) void selectTrack(0, false);
    else setCover(null);
  }
  drawTracks();
}

function applyRemoteTrackChange(payload) {
  if (payload.eventType === 'DELETE') {
    const index = tracks.findIndex(track => track.id === payload.old.id);
    if (index >= 0) {
      const wasCurrent = index === currentIndex;
      const [removed] = tracks.splice(index, 1);
      if (removed.url?.startsWith('blob:')) URL.revokeObjectURL(removed.url);
      if (wasCurrent) {
        audio.pause();
        audio.removeAttribute('src');
        currentIndex = -1;
        setCover(null);
      } else if (index < currentIndex) currentIndex--;
      drawTracks();
    }
    return;
  }

  const selectedIdBefore = tracks[currentIndex]?.id;
  const row = payload.new;
  const index = tracks.findIndex(track => track.id === row.id);
  const previous = index >= 0 ? tracks[index] : null;
  const track = {
    ...previous,
    id: row.id,
    title: row.title,
    artist: row.artist,
    audioPath: row.audio_path,
    coverPath: row.cover_path,
    createdAt: row.created_at,
      url: previous?.audioPath === row.audio_path || previous?.uploadState === 'uploading' ? previous.url : '',
    coverUrl: previous?.coverPath === row.cover_path ? previous.coverUrl : '',
    uploadState: 'ready'
  };
  if (index >= 0) tracks[index] = track;
  else tracks.push(track);
  tracks.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  currentIndex = selectedIdBefore ? tracks.findIndex(item => item.id === selectedIdBefore) : -1;
  if (currentIndex < 0 && tracks.length) currentIndex = 0;
  if (currentIndex >= 0) setCover(tracks[currentIndex]);
  drawTracks();
  if (!previous) setOperationNotice(`Yeni şarkı eklendi: ${track.title}`, 'success');
}

async function loadCloudWorkspace() {
  if (!cloud || !cloudUser) return;
  document.querySelector('#cloudEmailLabel').textContent = cloudUser.email;
  document.querySelector('#cloudAccount').hidden = false;
  cloudAuthForm.hidden = true;
  setCloudStatus('Ortak liste kontrol ediliyor…');
  const { data: playlists, error } = await cloud.from('playlists').select('id,name,owner_id').order('created_at');
  if (error) {
    setCloudStatus(`Liste açılamadı: ${error.message}`);
    return;
  }
  if (!playlists?.length) {
    activePlaylistId = null;
    document.querySelector('#cloudPlaylistMessage').textContent = 'Henüz ortak bir listen yok. Önce sen oluştur, sonra arkadaşını davet et.';
    document.querySelector('#cloudCreatePlaylist').hidden = false;
    document.querySelector('#cloudInvite').hidden = true;
    tracks.splice(0);
    currentIndex = -1;
    drawTracks();
    return;
  }
  const playlist = playlists[0];
  activePlaylistId = playlist.id;
  activePlaylistName = playlist.name;
  activePlaylistOwnerId = playlist.owner_id;
  document.querySelector('#cloudPlaylistMessage').textContent = `Ortak liste: ${playlist.name}`;
  document.querySelector('#cloudPlaylistName').textContent = playlist.name;
  document.querySelector('#cloudCreatePlaylist').hidden = true;
  document.querySelector('#cloudInvite').hidden = playlist.owner_id !== cloudUser.id;
  setCloudStatus('Ortak listeniz bağlı; eklenen şarkılar iki cihazda da görünür.');
  await refreshCloudTracks();
  if (cloudChannel) await cloud.removeChannel(cloudChannel);
  cloudChannel = cloud.channel(`tracks-${activePlaylistId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'tracks',
      filter: `playlist_id=eq.${activePlaylistId}`
    }, payload => applyRemoteTrackChange(payload))
    .subscribe((status, error) => {
      if (status === 'SUBSCRIBED') setCloudStatus('Ortak liste bağlı; yeni şarkılar diğer cihazlara anlık gelir.');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setCloudStatus(`Canlı eşitleme bağlanamadı: ${error?.message || status}. Sayfayı yenileyip tekrar dene.`);
      }
    });
}

async function initializeCloud() {
  const config = window.SUPABASE_CONFIG;
  if (!config?.url || !config?.anonKey) return;
  cloudPanel.hidden = false;
  if (!window.supabase?.createClient) {
    setCloudStatus('Bulut bağlantısı yüklenemedi. İnternet bağlantını kontrol et.');
    return;
  }
  cloud = window.supabase.createClient(config.url, config.anonKey);
  cloud.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') return;
    cloudUser = session?.user || null;
    queueMicrotask(() => {
      if (cloudUser) loadCloudWorkspace();
      else {
        document.querySelector('#cloudAccount').hidden = true;
        cloudAuthForm.hidden = false;
        if (cloudChannel) cloud.removeChannel(cloudChannel);
        cloudChannel = null;
        activePlaylistId = null;
        tracks.splice(0);
        currentIndex = -1;
        audio.pause();
        audio.removeAttribute('src');
        setCover(null);
        drawTracks();
      }
    });
  });
  const { data, error } = await cloud.auth.getSession();
  if (error) setCloudStatus(error.message);
  cloudUser = data?.session?.user || null;
  if (cloudUser) await loadCloudWorkspace();
}

function startOptimisticCloudUpload(file) {
  const id = crypto.randomUUID();
  const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : 'audio';
  const track = {
    id,
    title: cleanTitle(file.name),
    artist: 'bizim şarkımız',
    audioBlob: file,
    url: URL.createObjectURL(file),
    coverUrl: '',
    uploadState: 'uploading'
  };
  tracks.push(track);
  drawTracks();
  setOperationNotice(`“${track.title}” yükleniyor…`);
  if (currentIndex < 0) void selectTrack(tracks.length - 1, false);
  void persistCloudTrack(file, track, extension);
}

async function persistCloudTrack(file, track, extension) {
  const audioPath = `${activePlaylistId}/${track.id}.${extension}`;
  let uploadAttempted = false;
  let insertAttempted = false;
  try {
    uploadAttempted = true;
    const upload = await cloud.storage.from('playlist-files').upload(audioPath, file);
    if (upload.error) throw new Error(`Dosya yüklenemedi. ${upload.error.message}`);
    insertAttempted = true;
    const { data, error } = await cloud.from('tracks').insert({
      id: track.id,
      playlist_id: activePlaylistId,
      title: track.title,
      artist: track.artist,
      audio_path: audioPath,
      created_by: cloudUser.id
    }).select('id,created_at').single();
    if (error) throw new Error(`Dosya yüklendi ama liste kaydı eklenemedi. ${error.message}`);
    track.audioPath = audioPath;
    track.createdAt = data.created_at;
    track.uploadState = 'ready';
    setOperationNotice(`“${track.title}” ortak listeye eklendi.`, 'success');
    drawTracks();
  } catch (error) {
    const cleanupErrors = [];
    let safeToRemoveFile = !insertAttempted;
    if (insertAttempted) {
      try {
        const { data: deletedRows, error: rowCleanupError } = await cloud.from('tracks')
          .delete().eq('id', track.id).select('id');
        if (rowCleanupError) {
          safeToRemoveFile = false;
          cleanupErrors.push(rowCleanupError.message);
        } else if (deletedRows?.length) {
          safeToRemoveFile = true;
        } else {
          const { data: remainingRow, error: verifyError } = await cloud.from('tracks')
            .select('id').eq('id', track.id).maybeSingle();
          safeToRemoveFile = !verifyError && !remainingRow;
          if (verifyError) cleanupErrors.push(verifyError.message);
          else if (remainingRow) cleanupErrors.push('Veritabanı kaydı silinemedi.');
        }
      } catch (cleanupError) {
        safeToRemoveFile = false;
        cleanupErrors.push(cleanupError.message);
      }
    }
    if (uploadAttempted && safeToRemoveFile) {
      try {
        const { error: fileCleanupError } = await cloud.storage.from('playlist-files').remove([audioPath]);
        if (fileCleanupError) cleanupErrors.push(fileCleanupError.message);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError.message);
      }
    } else if (uploadAttempted) {
      cleanupErrors.push('Dosya, veritabanındaki bağlantı güvenle temizlenemediği için depoda bırakıldı.');
    }
    const index = tracks.indexOf(track);
    if (index >= 0) {
      const wasCurrent = index === currentIndex;
      tracks.splice(index, 1);
      if (wasCurrent) {
        audio.pause();
        audio.removeAttribute('src');
        currentIndex = -1;
      } else if (index < currentIndex) currentIndex--;
    }
    URL.revokeObjectURL(track.url);
    drawTracks();
    if (currentIndex < 0 && tracks.length) void selectTrack(0, false);
    if (!tracks.length) setCover(null);
    const cleanupText = cleanupErrors.length ? ` Temizlik tamamlanamadı: ${cleanupErrors.join('; ')}` : '';
    const permissionHint = /row-level security|permission denied|bucket not found/i.test(error.message || '')
      ? ' Supabase depolama/RLS kurulumu için supabase-improvements.sql dosyasını çalıştır.'
      : '';
    setOperationNotice(`“${track.title}” yüklenemedi: ${error.message}${permissionHint}${cleanupText}`, 'error');
    console.error('Şarkı yükleme işlemi başarısız:', error);
  }
}

async function uploadCloudCover(file, track) {
  const fileId = crypto.randomUUID();
  const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : 'image';
  const coverPath = `${activePlaylistId}/${fileId}.${extension}`;
  const upload = await cloud.storage.from('playlist-files').upload(coverPath, file);
  if (upload.error) throw upload.error;
  const update = await cloud.from('tracks').update({ cover_path: coverPath }).eq('id', track.id);
  if (update.error) {
    await cloud.storage.from('playlist-files').remove([coverPath]);
    throw update.error;
  }
}

cloudAuthForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!cloud) return;
  setCloudStatus('Giriş yapılıyor…');
  const email = document.querySelector('#cloudEmail').value.trim();
  const password = document.querySelector('#cloudPassword').value;
  try {
    const { error } = await cloud.auth.signInWithPassword({ email, password });
    setCloudStatus(error ? `Giriş yapılamadı: ${error.message}` : 'Giriş başarılı.');
  } catch (error) {
    setCloudStatus(`Giriş yapılamadı: ${error.message || 'Bağlantı hatası.'}`);
  }
});

document.querySelector('#cloudSignUp').addEventListener('click', async () => {
  if (!cloud) return;
  setCloudStatus('Hesap oluşturuluyor…');
  const email = document.querySelector('#cloudEmail').value.trim();
  const password = document.querySelector('#cloudPassword').value;
  if (!email || password.length < 6) {
    setCloudStatus('E-posta gir ve en az 6 karakterli bir şifre seç.');
    return;
  }
  try {
    const { data, error } = await cloud.auth.signUp({ email, password });
    if (error) setCloudStatus(`Hesap oluşturulamadı: ${error.message}`);
    else if (!data.session) setCloudStatus('Hesap oluşturuldu. E-postanı doğrula, sonra giriş yap.');
    else setCloudStatus('Hesap hazır. Şimdi ortak liste oluşturabilirsin.');
  } catch (error) {
    setCloudStatus(`Hesap oluşturulamadı: ${error.message || 'Bağlantı hatası.'}`);
  }
});

document.querySelector('#cloudSignOut').addEventListener('click', async () => {
  if (!cloud) return;
  const { error } = await cloud.auth.signOut();
  if (error) setCloudStatus(`Çıkış yapılamadı: ${error.message}`);
});

document.querySelector('#cloudCreatePlaylist').addEventListener('click', async () => {
  if (!cloud) return;
  setCloudStatus('Ortak liste oluşturuluyor…');
  try {
    const { error } = await cloud.rpc('create_shared_playlist', { p_name: 'Bizim şarkılar' });
    if (error) setCloudStatus(`Ortak liste oluşturulamadı: ${error.message}`);
    else await loadCloudWorkspace();
  } catch (error) {
    setCloudStatus(`Ortak liste oluşturulamadı: ${error.message || 'Bağlantı hatası.'}`);
  }
});

document.querySelector('#inviteButton').addEventListener('click', async () => {
  const button = document.querySelector('#inviteButton');
  const input = document.querySelector('#inviteEmail');
  const email = input.value.trim().toLowerCase();
  if (!activePlaylistId || !cloudUser) {
    setCloudStatus('Davet göndermek için önce ortak listeye giriş yap.');
    return;
  }
  if (!input.checkValidity() || !email) {
    setCloudStatus('Geçerli bir e-posta adresi yaz.');
    input.focus();
    return;
  }
  if (email === cloudUser.email?.toLowerCase()) {
    setCloudStatus('Kendi hesabını davet edemezsin; arkadaşının e-postasını yaz.');
    input.focus();
    return;
  }
  button.disabled = true;
  button.textContent = 'Gönderiliyor…';
  setCloudStatus(`${email} adresine liste daveti hazırlanıyor…`);
  try {
    const { data, error } = await cloud.rpc('send_playlist_invite', {
      p_playlist_id: activePlaylistId,
      p_email: email
    });
    if (error) throw error;
    if (data === 'joined') {
      setCloudStatus(`${email} hesabı ortak listeye eklendi.`);
      setOperationNotice('Arkadaşın daveti kabul edip giriş yapınca şarkıları görebilir.', 'success');
    } else if (data === 'already') {
      setCloudStatus(`${email} bu ortak listede zaten var.`);
    } else {
      setCloudStatus(`Davet kaydedildi: ${email}. Arkadaşına site bağlantısını gönder; aynı e-posta ile kayıt olunca otomatik katılır.`);
      setOperationNotice('Davet beklemede. Arkadaşın aynı e-posta ile hesap oluşturunca liste açılır.', 'success');
    }
    input.value = '';
  } catch (error) {
    const migrationMissing = error.code === 'PGRST202' || /send_playlist_invite/i.test(error.message || '');
    const policyDenied = error.code === '42501' || /row-level security|permission denied/i.test(error.message || '');
    const message = migrationMissing
      ? 'Davet işlevi veritabanında kurulu değil. Supabase SQL Editor’de supabase-improvements.sql dosyasını çalıştır.'
      : policyDenied
        ? `Supabase izin vermedi: ${error.message}. RLS kurulumunu supabase-improvements.sql ile yenile.`
        : `Davet gönderilemedi: ${error.message || 'Beklenmeyen bir hata oluştu.'}`;
    setCloudStatus(message);
    setOperationNotice(message, 'error');
    console.error('Ortak liste daveti başarısız:', error);
  } finally {
    button.disabled = false;
    button.textContent = 'Listeye davet et';
  }
});

const databaseReady = new Promise((resolve, reject) => {
  if (!('indexedDB' in window)) {
    reject(new Error('IndexedDB is unavailable in this browser.'));
    return;
  }
  const request = indexedDB.open('sana-bir-sarki', 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('tracks')) {
      request.result.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('Could not open song storage.'));
});

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Storage transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Storage transaction was cancelled.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Storage request failed.'));
  });
}

async function saveTrack(track) {
  const database = await databaseReady;
  const transaction = database.transaction('tracks', 'readwrite');
  const done = transactionDone(transaction);
  const record = {
    title: track.title,
    artist: track.artist,
    audioBlob: track.audioBlob,
    coverBlob: track.coverBlob || null
  };
  const request = track.id
    ? transaction.objectStore('tracks').put({ ...record, id: track.id })
    : transaction.objectStore('tracks').add(record);
  const key = await requestResult(request);
  await done;
  if (!track.id) track.id = key;
}

async function restoreTracks() {
  try {
    const database = await databaseReady;
    const transaction = database.transaction('tracks', 'readonly');
    const done = transactionDone(transaction);
    const savedTracks = await requestResult(transaction.objectStore('tracks').getAll());
    await done;
    for (const saved of savedTracks) {
      tracks.push({
        id: saved.id,
        title: saved.title,
        artist: saved.artist,
        audioBlob: saved.audioBlob,
        coverBlob: saved.coverBlob,
        url: URL.createObjectURL(saved.audioBlob),
        coverUrl: saved.coverBlob ? URL.createObjectURL(saved.coverBlob) : ''
      });
    }
    drawTracks();
    if (tracks.length) selectTrack(0, false);
  } catch (error) {
    document.querySelector('#storageNote').innerHTML = '<span>♡</span> Bu tarayıcı kalıcı kayıt sunmuyor';
    console.warn('Şarkı listesi kalıcı depolamadan yüklenemedi:', error);
  }
}

function timeLabel(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function cleanTitle(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'İsimsiz şarkı';
}

function drawTracks() {
  trackList.replaceChildren();
  emptyState.hidden = tracks.length > 0;
  trackCount.textContent = `${String(tracks.length).padStart(2, '0')} PARÇA`;
  tracks.forEach((track, index) => {
    const button = document.createElement('button');
    button.className = `track${index === currentIndex ? ' active' : ''}${track.uploadState === 'uploading' ? ' uploading' : ''}`;
    button.type = 'button';
    button.setAttribute('aria-label', `${track.title}, çal`);
    const number = document.createElement('span');
    number.className = 'track-number';
    number.textContent = index === currentIndex && !audio.paused ? '♫' : String(index + 1).padStart(2, '0');
    const text = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'track-title';
    title.textContent = track.title;
    const artist = document.createElement('span');
    artist.className = 'track-artist';
    artist.textContent = track.uploadState === 'uploading' ? 'Yükleniyor…' : track.artist;
    text.append(title, artist);
    const tail = document.createElement('span');
    tail.className = 'track-duration';
    tail.textContent = track.uploadState === 'uploading'
      ? 'Yükleniyor'
      : index === currentIndex && Number.isFinite(audio.duration) ? timeLabel(audio.duration) : '♡';
    button.append(number, text, tail);
    button.addEventListener('click', () => selectTrack(index, true));
    trackList.append(button);
  });
}

function setCover(track) {
  const image = track?.coverUrl;
  const background = image ? `url("${image}")` : '';
  document.querySelector('#recordLabel').style.backgroundImage = background || 'radial-gradient(circle,#e6aca5,#c97a7b)';
  const mini = document.querySelector('#miniCover');
  mini.style.backgroundImage = background || 'linear-gradient(140deg,#e8b9a5,#bf777a)';
  mini.querySelector('span').hidden = Boolean(image);
  document.querySelector('#labelTitle').textContent = track ? track.title.slice(0, 13).toLocaleUpperCase('tr-TR') : 'SANA';
  document.querySelector('#labelArtist').textContent = track ? track.artist.slice(0, 14) : '♡';
  document.querySelector('#nowTitle').textContent = track?.title || 'Bir şarkı seç';
  document.querySelector('#nowArtist').textContent = track?.artist || 'ya da listene şarkı ekle';
  if (track?.coverPath && !track.coverUrl && !track.coverLoading && cloud) void ensureCoverUrl(track);
}

async function ensureCoverUrl(track) {
  track.coverLoading = true;
  const path = track.coverPath;
  try {
    const { data, error } = await cloud.storage.from('playlist-files').createSignedUrl(path, 60 * 60 * 24);
    if (error) throw error;
    if (track.coverPath === path) {
      track.coverUrl = data.signedUrl;
      if (tracks[currentIndex] === track) setCover(track);
    }
  } catch (error) {
    setOperationNotice(`Kapak görseli yüklenemedi: ${error.message}`, 'error');
  } finally {
    track.coverLoading = false;
  }
}

async function ensureAudioUrl(track) {
  if (track.url) return track.url;
  if (!cloud || !track.audioPath) throw new Error('Şarkı dosyasının bağlantısı bulunamadı.');
  const { data, error } = await cloud.storage.from('playlist-files').createSignedUrl(track.audioPath, 60 * 60 * 24);
  if (error) throw error;
  track.url = data.signedUrl;
  return track.url;
}

async function selectTrack(index, autoplay) {
  if (index < 0 || index >= tracks.length) return;
  const track = tracks[index];
  currentIndex = index;
  setCover(track);
  currentTime.textContent = '0:00';
  duration.textContent = '0:00';
  seekBar.value = '0';
  drawTracks();
  try {
    if (!track.url && track.audioPath) setOperationNotice(`“${track.title}” hazırlanıyor…`);
    const source = await ensureAudioUrl(track);
    if (!tracks.includes(track)) return;
    if (audio.src !== source) audio.src = source;
    setOperationNotice('');
    if (autoplay) await audio.play();
  } catch (error) {
    setPlaying(false);
    setOperationNotice(`Şarkı açılamadı: ${error.message}`, 'error');
  }
}

function setPlaying(playing) {
  record?.classList.toggle('playing', playing);
  tonearm?.classList.toggle('playing', playing);
  playButton.classList.toggle('is-playing', playing);
  playButton.setAttribute('aria-label', playing ? 'Duraklat' : 'Oynat');
  playButton.querySelector('.play-symbol').textContent = playing ? 'Ⅱ' : '▶';
  drawTracks();
}

function playNext() {
  if (!tracks.length) return;
  const next = shuffle && tracks.length > 1
    ? (currentIndex + 1 + Math.floor(Math.random() * (tracks.length - 1))) % tracks.length
    : (currentIndex + 1) % tracks.length;
  selectTrack(next, true);
}

audioInput.addEventListener('change', async event => {
  const files = [...event.target.files].filter(file => file.type.startsWith('audio/'));
  if (cloud && !cloudUser) {
    setCloudStatus('Şarkıları ortak listeye eklemek için önce giriş yap.');
    event.target.value = '';
    return;
  }
  if (cloudUser && !activePlaylistId) {
    setCloudStatus('Önce ortak liste oluştur veya davet edildiğin hesaba giriş yap.');
    event.target.value = '';
    return;
  }
  if (cloudUser && activePlaylistId) {
    for (const file of files) startOptimisticCloudUpload(file);
    event.target.value = '';
    return;
  }
  await restorePromise;
  for (const file of files) {
    const track = {
      title: cleanTitle(file.name),
      artist: 'bizim şarkımız',
      audioBlob: file,
      coverBlob: null,
      url: URL.createObjectURL(file),
      coverUrl: ''
    };
    try {
      await saveTrack(track);
    } catch (error) {
      document.querySelector('#storageNote').innerHTML = '<span>♡</span> Şarkı eklendi ama bu tarayıcıya kaydedilemedi';
      console.warn('Şarkı kalıcı depolamaya kaydedilemedi:', error);
    }
    tracks.push(track);
  }
  drawTracks();
  if (currentIndex === -1 && tracks.length) selectTrack(0, false);
  event.target.value = '';
});

coverInput.addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file || currentIndex < 0) return;
  if (cloud && !cloudUser) {
    setCloudStatus('Kapak görselini ortak listeye eklemek için önce giriş yap.');
    event.target.value = '';
    return;
  }
  const track = tracks[currentIndex];
  if (cloudUser && activePlaylistId) {
    try {
      await uploadCloudCover(file, track);
      await refreshCloudTracks();
    } catch (error) {
      setCloudStatus(`Kapak görseli yüklenemedi: ${error.message}`);
    }
    event.target.value = '';
    return;
  }
  track.coverBlob = file;
  track.coverUrl = URL.createObjectURL(file);
  try {
    await saveTrack(track);
  } catch (error) {
    document.querySelector('#storageNote').innerHTML = '<span>♡</span> Kapak görseli kaydedilemedi';
    console.warn('Kapak görseli kalıcı depolamaya kaydedilemedi:', error);
  }
  setCover(track);
  event.target.value = '';
});

playButton.addEventListener('click', async () => {
  if (tracks.length && (currentIndex < 0 || !audio.currentSrc)) await selectTrack(currentIndex < 0 ? 0 : currentIndex, true);
  else if (audio.paused) { try { await audio.play(); } catch { /* The browser may require a user gesture. */ } }
  else audio.pause();
});
audio.addEventListener('play', () => setPlaying(true));
audio.addEventListener('pause', () => setPlaying(false));
audio.addEventListener('ended', () => { if (repeat) { audio.currentTime = 0; audio.play(); } else if (currentIndex < tracks.length - 1 || shuffle) playNext(); else setPlaying(false); });
audio.addEventListener('loadedmetadata', () => { duration.textContent = timeLabel(audio.duration); drawTracks(); });
audio.addEventListener('timeupdate', () => {
  currentTime.textContent = timeLabel(audio.currentTime);
  if (Number.isFinite(audio.duration) && audio.duration > 0) seekBar.value = String((audio.currentTime / audio.duration) * 100);
});
seekBar.addEventListener('input', () => { if (Number.isFinite(audio.duration)) audio.currentTime = audio.duration * Number(seekBar.value) / 100; });
document.querySelector('#nextButton').addEventListener('click', playNext);
document.querySelector('#prevButton').addEventListener('click', () => {
  if (!tracks.length) return;
  if (audio.currentTime > 3) audio.currentTime = 0;
  else selectTrack((currentIndex - 1 + tracks.length) % tracks.length, true);
});
document.querySelector('#shuffleButton').addEventListener('click', event => { shuffle = !shuffle; event.currentTarget.classList.toggle('enabled', shuffle); });
document.querySelector('#repeatButton').addEventListener('click', event => { repeat = !repeat; event.currentTarget.classList.toggle('enabled', repeat); });
document.querySelector('#volumeBar').addEventListener('input', event => { audio.volume = Number(event.target.value); });
document.querySelector('#likeButton').addEventListener('click', event => { const button = event.currentTarget; button.classList.toggle('liked'); button.textContent = button.classList.contains('liked') ? '♥' : '♡'; });
audio.volume = 0.75;
drawTracks();
restorePromise = restoreTracks();
initializeCloud();
