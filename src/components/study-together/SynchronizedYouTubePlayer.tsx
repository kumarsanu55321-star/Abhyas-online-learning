import { useEffect, useMemo, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { AlertTriangle, CirclePause, CirclePlay, Headphones, LoaderCircle, Rewind, FastForward, Video, Volume2 } from 'lucide-react';
import { Card, Input } from '../common/UI';
import { getStudyRoomPlayback, removePlaybackSubscription, subscribeToStudyRoomPlayback, updateStudyRoomPlayback } from '../../services/studyRoomPlaybackService';
import { getStudyRoomPlaybackPermissions, removePlaybackPermissionsSubscription, subscribeToStudyRoomPlaybackPermissions } from '../../services/studyRoomPermissionsService';
import type { PlaybackStatus, StudyRoomPlayback } from '../../types/studyRoomPlayback';
import type { StudyRoomPlaybackPermission } from '../../types/studyRoomPermissions';
import type { YouTubePlayer, YouTubePlayerApi } from '../../services/youtube';

export type StudyRoomPlayerControls = {
  getCurrentTime: () => number | null;
  canSeek: boolean;
  seekTo: (seconds: number) => boolean;
};

let youTubeApiPromise: Promise<YouTubePlayerApi> | null = null;
function loadYouTubeApi(): Promise<YouTubePlayerApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youTubeApiPromise) return youTubeApiPromise;
  const promise = new Promise<YouTubePlayerApi>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    const timer = window.setTimeout(() => reject(new Error('YouTube player API did not load. Check your connection and try again.')), 15000);
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      window.clearTimeout(timer);
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('YouTube loaded without its player API.'));
    };
    let script = document.getElementById('abhyas-youtube-iframe-api') as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement('script');
      script.id = 'abhyas-youtube-iframe-api';
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => { window.clearTimeout(timer); reject(new Error('Could not load the YouTube player API.')); };
      document.head.appendChild(script);
    }
  }).catch(error => { youTubeApiPromise = null; throw error; });
  youTubeApiPromise = promise;
  return promise;
}

export function extractYouTubeVideoId(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let candidate: string | null = null;
    if (host === 'youtu.be') candidate = url.pathname.split('/').filter(Boolean)[0] ?? null;
    else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      if (url.pathname === '/watch') candidate = url.searchParams.get('v');
      else candidate = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1] ?? null;
    }
    return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
  } catch { return null; }
}

function playerErrorMessage(code: number): string {
  if (code === 2) return 'YouTube rejected this video ID. Ask the host to check the video link.';
  if (code === 5) return 'This video could not be played in the HTML5 player. Try another video.';
  if (code === 100) return 'This video is unavailable, private, or has been removed.';
  if (code === 101 || code === 150) return 'The video owner does not allow this video to be embedded. Open it on YouTube or choose another video.';
  if (code === 153) return 'YouTube could not verify this embed request. Reload the room and try again.';
  return `YouTube player error (${code}). Try another video.`;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function estimatedTime(playback: StudyRoomPlayback): number {
  const elapsed = playback.playback_status === 'playing' ? Math.max(0, (Date.now() - Date.parse(playback.updated_at)) / 1000) : 0;
  return Math.max(0, playback.position_seconds + elapsed);
}

export default function SynchronizedYouTubePlayer({ roomId, hostId, currentUserId, isHost, roomVideoUrl, playerControlsRef }: {
  roomId: string; hostId: string; currentUserId: string; isHost: boolean; roomVideoUrl: string | null;
  playerControlsRef: MutableRefObject<StudyRoomPlayerControls | null>;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const latestRef = useRef<StudyRoomPlayback | null>(null);
  const pendingRef = useRef<StudyRoomPlayback | null>(null);
  const videoIdRef = useRef<string | null>(null);
  const loadedVideoIdRef = useRef<string | null>(null);
  const applyingRemoteRef = useRef(false);
  const hostEventStatusRef = useRef<PlaybackStatus | null>(null);
  const hostEventWriterRef = useRef<(status: PlaybackStatus, currentTime: number) => void>(() => {});
  const lastDriftCorrectionRef = useRef(0);
  const permissionsRef = useRef<StudyRoomPlaybackPermission | null>(null);
  const [playback, setPlayback] = useState<StudyRoomPlayback | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState('');
  const [playerReady, setPlayerReady] = useState(false);
  const [loadingState, setLoadingState] = useState(true);
  const [saving, setSaving] = useState(false);
  const [playerError, setPlayerError] = useState('');
  const [serviceError, setServiceError] = useState('');
  const [realtimeStatus, setRealtimeStatus] = useState('CONNECTING');
  const [expectedStatus, setExpectedStatus] = useState<PlaybackStatus>('paused');
  const [permission, setPermission] = useState<StudyRoomPlaybackPermission | null>(null);
  const [permissionExists, setPermissionExists] = useState(false);
  const [permissionLoaded, setPermissionLoaded] = useState(false);
  const [permissionError, setPermissionError] = useState('');
  const [needsGesture, setNeedsGesture] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [videoUrl, setVideoUrl] = useState(roomVideoUrl ?? '');
  const [videoUrlError, setVideoUrlError] = useState('');
  const initialVideoId = useMemo(() => extractYouTubeVideoId(roomVideoUrl), [roomVideoUrl]);
  const invalidInitialUrl = Boolean(roomVideoUrl && !initialVideoId);
  const currentVideoId = playback ? playback.video_id : videoId;
  permissionsRef.current = permission;
  const canPlayPause = isHost || permission?.can_play_pause === true;
  const canSeek = isHost || permission?.can_seek === true;

  function applyPlayback(next: StudyRoomPlayback) {
    if (next.host_id !== hostId) return;
    const previous = latestRef.current;
    if (previous && next.updated_at < previous.updated_at) return;
    if (previous && next.updated_at === previous.updated_at
      && next.video_id === previous.video_id
      && next.playback_status === previous.playback_status
      && next.position_seconds === previous.position_seconds
      && next.host_id === previous.host_id) return;
    latestRef.current = next;
    pendingRef.current = next;
    setPlayback(next);
    setVideoId(next.video_id);
    videoIdRef.current = next.video_id;
    setExpectedStatus(next.playback_status);
    setNeedsGesture(false);
    if (playerRef.current) applyPlaybackToPlayer(next);
  }

  function applyPlaybackToPlayer(next: StudyRoomPlayback) {
    const player = playerRef.current;
    if (!player) { pendingRef.current = next; return; }
    applyingRemoteRef.current = true;
    const target = estimatedTime(next);
    const state = player.getPlayerState();
    const playerState = window.YT?.PlayerState;
    const loadingDifferentVideo = Boolean(next.video_id && next.video_id !== loadedVideoIdRef.current);
    if (loadingDifferentVideo && next.video_id) {
      loadedVideoIdRef.current = next.video_id;
      setVideoId(next.video_id);
      if (next.playback_status === 'playing') player.loadVideoById({ videoId: next.video_id, startSeconds: target });
      else player.cueVideoById({ videoId: next.video_id, startSeconds: target });
    } else if (next.video_id) {
      const actual = player.getCurrentTime();
      if (!Number.isFinite(actual) || Math.abs(actual - target) > 1.75) player.seekTo(target, true);
    }
    if (next.playback_status === 'playing') {
      if (state !== playerState?.PLAYING && state !== playerState?.BUFFERING && !loadingDifferentVideo) player.playVideo();
      window.setTimeout(() => {
        applyingRemoteRef.current = false;
        if (!isHost && latestRef.current?.playback_status === 'playing' && player.getPlayerState() !== window.YT?.PlayerState.PLAYING) setNeedsGesture(true);
      }, 900);
    } else {
      if (state !== playerState?.PAUSED && state !== playerState?.CUED && state !== playerState?.UNSTARTED && !loadingDifferentVideo) player.pauseVideo();
      applyingRemoteRef.current = false;
    }
  }

  useEffect(() => {
    let cancelled = false;
    let createdPlayer: YouTubePlayer | null = null;
    loadYouTubeApi().then(api => {
      if (cancelled || !mountRef.current) return;
      createdPlayer = new api.Player(mountRef.current, {
        width: '100%', height: '100%',
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 1, playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin },
        events: {
          onReady: event => {
            playerRef.current = event.target;
            setPlayerReady(true);
            setDuration(event.target.getDuration());
            setVideoTitle(event.target.getVideoData().title ?? '');
            if (pendingRef.current) applyPlaybackToPlayer(pendingRef.current);
            else if (videoIdRef.current) {
              loadedVideoIdRef.current = videoIdRef.current;
              event.target.cueVideoById({ videoId: videoIdRef.current, startSeconds: 0 });
            }
          },
          onStateChange: event => {
            const currentPlayerState = event.target.getPlayerState();
            setCurrentTime(event.target.getCurrentTime());
            setDuration(event.target.getDuration());
            setVideoTitle(event.target.getVideoData().title ?? '');
            if (currentPlayerState === api.PlayerState.BUFFERING) return;
            if (currentPlayerState === api.PlayerState.PLAYING) {
              setNeedsGesture(false);
              if ((isHost || permissionsRef.current?.can_play_pause) && !applyingRemoteRef.current) hostEventWriterRef.current('playing', event.target.getCurrentTime());
              else if (!isHost && latestRef.current) applyPlaybackToPlayer(latestRef.current);
              return;
            }
            if (currentPlayerState === api.PlayerState.PAUSED) {
              if ((isHost || permissionsRef.current?.can_play_pause) && !applyingRemoteRef.current) hostEventWriterRef.current('paused', event.target.getCurrentTime());
              else if (!isHost && latestRef.current) applyPlaybackToPlayer(latestRef.current);
              return;
            }
            if (currentPlayerState === api.PlayerState.ENDED) {
              if ((isHost || permissionsRef.current?.can_play_pause) && !applyingRemoteRef.current) hostEventWriterRef.current('paused', event.target.getCurrentTime());
              else if (!isHost && latestRef.current) applyPlaybackToPlayer(latestRef.current);
            }
          },
          onError: event => setPlayerError(playerErrorMessage(event.data)),
        },
      });
      playerRef.current = createdPlayer;
    }).catch(error => { if (!cancelled) setPlayerError(error instanceof Error ? error.message : 'Could not load YouTube.'); });
    return () => {
      cancelled = true;
      createdPlayer?.destroy();
      playerRef.current = null;
    };
  }, [Boolean(currentVideoId)]);

  useEffect(() => {
    let mounted = true;
    const channel = subscribeToStudyRoomPlayback(roomId, next => { if (mounted) applyPlayback(next); }, (status, error) => {
      if (!mounted) return;
      setRealtimeStatus(status);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setServiceError(error || 'Realtime playback updates are unavailable. Reload to retry.');
      else if (status === 'SUBSCRIBED') {
        setServiceError(current => current.startsWith('Realtime') ? '' : current);
        // Re-read after the channel is live so a write between the initial
        // snapshot and Realtime subscription cannot leave this client stale.
        void getStudyRoomPlayback(roomId).then(state => {
          if (mounted && state) applyPlayback(state);
        }).catch(error => {
          if (mounted) setServiceError(error instanceof Error ? error.message : 'Could not refresh shared playback state.');
        });
      }
    });
    void (async () => {
      try {
        const state = await getStudyRoomPlayback(roomId);
        if (!mounted) return;
        if (state) applyPlayback(state);
        else if (initialVideoId) {
          setVideoId(initialVideoId);
          videoIdRef.current = initialVideoId;
          if (isHost) {
            const initialized = await updateStudyRoomPlayback({ roomId, videoId: initialVideoId, status: 'paused', currentTime: 0 });
            if (mounted) applyPlayback(initialized);
          }
        }
      } catch (error) {
        if (mounted) setServiceError(error instanceof Error ? error.message : 'Could not load shared playback state.');
      } finally { if (mounted) setLoadingState(false); }
    })();
    return () => { mounted = false; void removePlaybackSubscription(channel); };
  }, [roomId, hostId, isHost, initialVideoId]);

  useEffect(() => {
    let mounted = true;
    setPermission(null);
    setPermissionExists(false);
    setPermissionLoaded(false);
    if (isHost) {
      setPermission(null);
      setPermissionExists(false);
      setPermissionLoaded(true);
      setPermissionError('');
      return () => { mounted = false; };
    }

    const refreshPermission = async () => {
      try {
        const rows = await getStudyRoomPlaybackPermissions(roomId);
        if (!mounted) return;
        const own = rows.find(row => row.user_id === currentUserId) ?? null;
        setPermission(own);
        setPermissionExists(Boolean(own));
        setPermissionLoaded(true);
        setPermissionError('');
      } catch (error) {
        if (mounted) {
          setPermissionLoaded(true);
          setPermissionError(error instanceof Error ? error.message : 'Could not load your playback permissions.');
        }
      }
    };

    let channel: ReturnType<typeof subscribeToStudyRoomPlaybackPermissions> | null = null;
    try {
      channel = subscribeToStudyRoomPlaybackPermissions(roomId, (row, event) => {
        if (!mounted) return;
        if (row?.user_id === currentUserId) {
          setPermission(row);
          setPermissionExists(true);
          setPermissionLoaded(true);
          setPermissionError('');
        } else if (event === 'DELETE') void refreshPermission();
      }, (status, message) => {
        if (!mounted) return;
        if (status === 'SUBSCRIBED') void refreshPermission();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setPermissionError(message ? `Permission updates disconnected: ${message}` : 'Permission updates disconnected. Reconnecting…');
        }
      });
    } catch (error) {
      setPermissionError(error instanceof Error ? error.message : 'Could not subscribe to playback permission updates.');
    }
    void refreshPermission();
    return () => {
      mounted = false;
      if (channel) void removePlaybackPermissionsSubscription(channel);
    };
  }, [roomId, currentUserId, isHost]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const player = playerRef.current;
      if (!playerReady || !player) return;
      const time = player.getCurrentTime();
      const total = player.getDuration();
      if (Number.isFinite(time)) setCurrentTime(time);
      if (Number.isFinite(total) && total > 0) setDuration(total);
      const shared = latestRef.current;
      if (shared?.playback_status === 'playing' && shared.video_id && !isHost) {
        const target = estimatedTime(shared);
        const actualState = player.getPlayerState();
        if (Math.abs(time - target) > 2.5 && Date.now() - lastDriftCorrectionRef.current > 4000) {
          player.seekTo(target, true);
          lastDriftCorrectionRef.current = Date.now();
        }
        if (actualState !== window.YT?.PlayerState.PLAYING
          && actualState !== window.YT?.PlayerState.BUFFERING
          && !needsGesture) player.playVideo();
      }
    }, 2500);
    return () => window.clearInterval(interval);
  }, [playerReady, isHost, needsGesture]);

  async function sendPlaybackCommand(status: PlaybackStatus, time = playerRef.current?.getCurrentTime() ?? 0, nextVideoId = videoId): Promise<boolean> {
    if (!isHost) {
      const activeVideoId = latestRef.current?.video_id ?? videoIdRef.current ?? initialVideoId;
      if (nextVideoId !== activeVideoId) { setServiceError('Only the room host can change the shared video.'); return false; }
      const sharedStatus = latestRef.current?.playback_status;
      if (status !== sharedStatus && !permissionsRef.current?.can_play_pause) {
        setServiceError('The host has not granted you Play/Pause permission.'); return false;
      }
      if (status === sharedStatus && !permissionsRef.current?.can_seek) {
        setServiceError('The host has not granted you Seek permission.'); return false;
      }
    }
    if (!nextVideoId) { setServiceError('Add a YouTube video before starting shared playback.'); return false; }
    setSaving(true); setServiceError(''); setPlayerError('');
    try {
      const saved = await updateStudyRoomPlayback({ roomId, videoId: nextVideoId, status, currentTime: time });
      applyPlayback(saved);
      return true;
    } catch (error) {
      if (!isHost && latestRef.current) applyPlaybackToPlayer(latestRef.current);
      setServiceError(error instanceof Error ? error.message : 'Could not sync this playback action.');
      return false;
    }
    finally { setSaving(false); }
  }

  hostEventWriterRef.current = (status, time) => {
    if (applyingRemoteRef.current || !videoIdRef.current) return;
    if (!isHost && !permissionsRef.current?.can_play_pause) {
      if (latestRef.current) applyPlaybackToPlayer(latestRef.current);
      return;
    }
    if (latestRef.current?.playback_status === status) {
      if (!isHost && !permissionsRef.current?.can_seek && latestRef.current) applyPlaybackToPlayer(latestRef.current);
      return;
    }
    if (hostEventStatusRef.current === status) return;
    hostEventStatusRef.current = status;
    void sendPlaybackCommand(status, time, videoIdRef.current).finally(() => {
      if (hostEventStatusRef.current === status) hostEventStatusRef.current = null;
    });
  };

  playerControlsRef.current = {
    canSeek,
    getCurrentTime: () => {
      const player = playerRef.current;
      if (!playerReady || !currentVideoId || !player) return null;
      const time = player.getCurrentTime();
      return Number.isFinite(time) && time >= 0 ? time : null;
    },
    seekTo: seconds => {
      if ((!isHost && !permissionsRef.current?.can_seek) || !currentVideoId || !Number.isFinite(seconds) || seconds < 0) return false;
      void sendPlaybackCommand(latestRef.current?.playback_status ?? expectedStatus, seconds, videoIdRef.current ?? currentVideoId);
      return true;
    },
  };

  useEffect(() => () => { playerControlsRef.current = null; }, [playerControlsRef]);

  async function changeVideo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setVideoUrlError('');
    const nextId = extractYouTubeVideoId(videoUrl);
    if (!nextId) { setVideoUrlError('Enter a valid YouTube watch, youtu.be, embed, or Shorts URL.'); return; }
    if (await sendPlaybackCommand('paused', 0, nextId)) setChangeOpen(false);
  }

  function nudgeSeek(delta: number) {
    const target = Math.max(0, Math.min(duration || 86400, (playerRef.current?.getCurrentTime() ?? currentTime) + delta));
    void sendPlaybackCommand(expectedStatus, target);
  }

  function commitSeek() {
    if (seekDraft === null) return;
    void sendPlaybackCommand(expectedStatus, seekDraft);
    setSeekDraft(null);
  }

  const initialUrlInvalid = invalidInitialUrl && !currentVideoId;
  const elapsed = formatTime(seekDraft ?? currentTime);
  const total = formatTime(duration);

  return <Card className="shared-video-card synced-player-card">
    <div className="synced-player-heading"><div><div className="section-kicker">SHARED LECTURE</div><h2>{videoTitle || (currentVideoId ? 'YouTube lecture' : 'Your shared lecture space')}</h2><span>{currentVideoId ? 'All room playback is controlled by the host.' : 'Add a YouTube lecture when your group is ready.'}</span></div><div className={`sync-badge ${realtimeStatus === 'SUBSCRIBED' ? 'connected' : 'connecting'}`}><i/>{realtimeStatus === 'SUBSCRIBED' ? 'SYNCED' : 'CONNECTING'}</div></div>
    {serviceError && <div className="player-message player-error" role="alert"><AlertTriangle size={15}/><span>{serviceError}</span></div>}
    {playerError && <div className="player-message player-error" role="alert"><AlertTriangle size={15}/><span>{playerError}</span></div>}
    {initialUrlInvalid && <div className="player-message player-error" role="alert"><AlertTriangle size={15}/><span>The saved YouTube link is invalid. Ask the host to replace it.</span></div>}
    {isHost && <div className="host-video-toolbar"><button className="change-video-toggle" onClick={() => setChangeOpen(!changeOpen)}><Video size={15}/>{currentVideoId ? 'Change video' : 'Add video'}</button>{changeOpen && <form className="change-video-form" onSubmit={changeVideo}><Input aria-label="YouTube video URL" placeholder="Paste a YouTube video URL" value={videoUrl} onChange={event => setVideoUrl(event.target.value)}/><button type="submit" disabled={saving}>{saving ? 'Loading…' : 'Load video'}</button>{videoUrlError && <small role="alert">{videoUrlError}</small>}</form>}</div>}
    {currentVideoId ? <div className="youtube-player-frame"><div className="youtube-player-mount" ref={mountRef}/>{(!playerReady || loadingState) && <div className="player-loading-overlay"><LoaderCircle size={23} className="spin-icon"/><span>{loadingState ? 'Joining playback sync…' : 'Loading YouTube player…'}</span></div>}{!isHost && needsGesture && expectedStatus === 'playing' && <button className="sync-play-overlay" onClick={() => { playerRef.current?.playVideo(); setNeedsGesture(false); }}><CirclePlay size={24}/> Start synchronized playback</button>}</div> : <div className="youtube-empty-state"><div><Video size={31}/></div><b>No lecture video yet</b><span>The host can add a YouTube link to start a shared lesson.</span></div>}
    <div className="synced-player-controls">
      {currentVideoId && canSeek && <>
        <button aria-label="Seek back 10 seconds" disabled={saving || !playerReady} onClick={() => nudgeSeek(-10)}><Rewind size={17}/><small>10</small></button>
        <button aria-label="Seek forward 10 seconds" disabled={saving || !playerReady} onClick={() => nudgeSeek(10)}><FastForward size={17}/><small>10</small></button>
        <span className="player-time">{elapsed} / {total}</span>
        <input aria-label="Seek video" type="range" min={0} max={duration || 100} step={1} value={seekDraft ?? Math.min(currentTime, duration || currentTime)} disabled={!playerReady || !duration || saving} onChange={event => setSeekDraft(Number(event.target.value))} onPointerUp={commitSeek} onKeyUp={commitSeek}/>
      </>}
      {currentVideoId && canPlayPause && <button className="main-play-control" disabled={saving || !playerReady} aria-label={expectedStatus === 'playing' ? 'Pause shared video' : 'Play shared video'} onClick={() => void sendPlaybackCommand(expectedStatus === 'playing' ? 'paused' : 'playing')}>{expectedStatus === 'playing' ? <CirclePause size={20}/> : <CirclePlay size={20}/>}</button>}
      {currentVideoId && !canPlayPause && <span className="participant-sync-state"><Headphones size={16}/>{canSeek ? 'Seek permission · ' : ''}{expectedStatus === 'playing' ? 'Following host playback' : 'Synced to host · Paused'}</span>}
      {currentVideoId && !canSeek && canPlayPause && <span className="player-time">{elapsed} / {total}</span>}
      {!currentVideoId && <span className="participant-sync-state">Waiting for the host to add a video</span>}
      {currentVideoId && <button className="volume-control" aria-label={muted ? 'Unmute video' : 'Mute video'} onClick={() => { const player = playerRef.current; if (!player) return; if (muted) player.unMute(); else player.mute(); setMuted(!muted); }}><Volume2 size={16}/></button>}
    </div>
    {permissionError && <div className="player-message player-error" role="status"><AlertTriangle size={15}/><span>{permissionError}</span></div>}
    <div className="shared-video-meta"><div><div className="section-kicker">{isHost ? 'HOST CONTROLS' : 'PLAYBACK PERMISSION'}</div><b>{currentVideoId ? (videoTitle || `YouTube video · ${currentVideoId}`) : 'Synchronized playback is ready when the host adds a video.'}</b><small>{isHost ? 'You always have full control, including changing the shared video.' : !permissionLoaded ? 'Checking your room permissions…' : permissionError ? permissionError : canPlayPause || canSeek ? `Playback control granted · ${[canPlayPause && 'Play/Pause', canSeek && 'Seek'].filter(Boolean).join(' and ')}` : permissionExists ? 'Permission revoked · View only' : 'View only · Ask the host for playback permissions.'}</small></div><span className="room-code-chip">{isHost ? 'HOST' : canPlayPause || canSeek ? 'CONTROL' : 'VIEW ONLY'}</span></div>
  </Card>;
}
