import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Headphones, MessageCircle, Play, Plus, Send, UsersRound, Video } from 'lucide-react';
import { Button, Card, Input, PageHeader } from '../components/common/UI';
import { useAuth } from '../context/AuthContext';
import { extractYouTubeId } from '../services/youtube';
import { broadcastPlayback, createStudyRoom, joinStudyRoom, leaveRoomChannel, loadRoomMessages, loadStudyRooms, sendRoomMessage, subscribeToRoom, type PlaybackCommand, type RoomMessage, type StudyRoom } from '../services/studyRooms';
import { supabase } from '../services/supabase';
import { recordLearningEvent } from '../services/progress';

export function StudyTogether() {
  const { session, preview } = useAuth();
  const user = session?.user;
  const [rooms, setRooms] = useState<StudyRoom[]>([]);
  const [room, setRoom] = useState<StudyRoom | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [playbackNotice, setPlaybackNotice] = useState('');
  const [channel, setChannel] = useState<ReturnType<typeof subscribeToRoom> | null>(null);
  const [seekTo, setSeekTo] = useState(0);

  async function refreshRooms() {
    if (!user) return;
    try { setRooms(await loadStudyRooms(user.id)); }
    catch (cause) { setError(cause instanceof Error ? `${cause.message}. Apply the learning progress and rooms migration.` : 'Could not load your rooms.'); }
  }
  useEffect(() => { void refreshRooms(); }, [user?.id]);

  async function openRoom(selected: StudyRoom) {
    if (!supabase) return;
    if (channel) await leaveRoomChannel(channel);
    setError(''); setNotice(''); setPlaybackNotice(''); setRoom(selected); setMessages([]); setVideoUrl(selected.video_url || '');
    try {
      setMessages(await loadRoomMessages(selected.id));
      const active = subscribeToRoom(selected.id, incoming => setMessages(current => current.some(item => item.id === incoming.id) ? current : [...current, incoming]), command => applyPlayback(command));
      setChannel(active);
    } catch (cause) { setError(cause instanceof Error ? `${cause.message}. Apply the learning progress and rooms migration.` : 'Could not open this room.'); }
  }
  useEffect(() => () => { if (channel) void leaveRoomChannel(channel); }, [channel]);

  async function createRoom(event: FormEvent) {
    event.preventDefault();
    if (preview || !user) { setError('Sign in to create or join a shared room.'); return; }
    if (!name.trim()) { setError('Enter a room name.'); return; }
    if (videoUrl.trim() && !extractYouTubeId(videoUrl)) { setError('Enter a valid YouTube video URL or leave it blank.'); return; }
    setBusy(true); setError('');
    try {
      const created = await createStudyRoom(name, subject, videoUrl);
      let historySaved = true;
      try { await recordLearningEvent({ event_type:'room_joined', title:`Created study room ${created.name}`, detail:'Shared a study room invite', subject:subject.trim()||null, duration_seconds:0, idempotency_key:`room-created:${created.id}`, metadata:{ room_id:created.id } }); }
      catch { historySaved = false; }
      setName(''); setSubject(''); setNotice(historySaved ? `Room created. Share code ${created.room_code} with your study group.` : `Room ${created.room_code} created. Apply the progress migration to record it in your history.`);
      await refreshRooms(); await openRoom(created);
    }
    catch (cause) { setError(cause instanceof Error ? `${cause.message}. Apply the learning progress and rooms migration.` : 'Could not create the room.'); }
    finally { setBusy(false); }
  }
  async function joinRoom(event: FormEvent) {
    event.preventDefault();
    if (preview || !user) { setError('Sign in to create or join a shared room.'); return; }
    if (!joinCode.trim()) { setError('Enter a room code.'); return; }
    setBusy(true); setError('');
    try {
      const joined = await joinStudyRoom(joinCode);
      let historySaved = true;
      try { await recordLearningEvent({ event_type:'room_joined', title:`Joined study room ${joined.name}`, detail:'Joined a shared study session', subject:joined.subject||null, duration_seconds:0, idempotency_key:`room-joined:${joined.id}:${user.id}`, metadata:{ room_id:joined.id } }); }
      catch { historySaved = false; }
      setJoinCode(''); setNotice(historySaved ? `Joined ${joined.name}.` : `Joined ${joined.name}. Apply the progress migration to record it in your history.`);
      await refreshRooms(); await openRoom(joined);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not join this room. Check the code and try again.'); }
    finally { setBusy(false); }
  }
  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!room || !user || !draft.trim() || busy) return;
    setBusy(true); setError('');
    try { const message = await sendRoomMessage(room.id, user.id, draft); setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]); setDraft(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send this message.'); }
    finally { setBusy(false); }
  }
  function applyPlayback(command: PlaybackCommand) {
    if (!user || command.user_id === user.id) return;
    const frame = document.getElementById('study-room-player') as HTMLIFrameElement | null;
    if (!frame?.contentWindow) { setPlaybackNotice('A teammate changed playback. Load the shared video to sync.'); return; }
    const func = command.action === 'play' ? 'playVideo' : command.action === 'pause' ? 'pauseVideo' : 'seekTo';
    frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: command.action === 'seek' ? [command.seconds || 0, true] : [] }), '*');
    setPlaybackNotice(command.action === 'seek' ? `A teammate moved the video to ${formatTime(command.seconds || 0)}.` : `A teammate ${command.action}ed the shared video.`);
  }
  async function sync(action: PlaybackCommand['action']) {
    if (!channel || !user) return;
    const frame = document.getElementById('study-room-player') as HTMLIFrameElement | null;
    const seconds = action === 'seek' ? Math.max(0, Number(seekTo)) : undefined;
    if (frame?.contentWindow) {
      const func = action === 'play' ? 'playVideo' : action === 'pause' ? 'pauseVideo' : 'seekTo';
      frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: action === 'seek' ? [seconds, true] : [] }), '*');
    }
    try { await broadcastPlayback(channel, { action, seconds, at: Date.now(), user_id: user.id }); setPlaybackNotice(`${action === 'seek' ? `Synced to ${formatTime(seconds || 0)}` : `Playback ${action} sent to the room`}.`); }
    catch { setPlaybackNotice('Could not sync playback. Check the room realtime setup.'); }
  }
  async function saveVideo(event: FormEvent) {
    event.preventDefault();
    if (!room || room.host_user_id !== user?.id || !supabase) return;
    const id = extractYouTubeId(videoUrl);
    if (!id) { setError('Enter a valid YouTube video URL.'); return; }
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    const { data, error: saveError } = await supabase.from('study_rooms').update({ video_url: canonical }).eq('id', room.id).select('*').single();
    if (saveError) { setError(saveError.message); return; }
    setRoom(data as StudyRoom); setVideoUrl(canonical); setError('');
  }

  const videoId = useMemo(() => extractYouTubeId(room?.video_url || ''), [room?.video_url]);
  return <div className="feature-page">
    <PageHeader eyebrow="BETTER TOGETHER" title="Study Together" description="Create a room, invite classmates, and learn together in real time." action={<Button onClick={() => document.getElementById('create-study-room')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><Plus size={17}/> Create a room</Button>}/>
    <Card className="join-room-card"><div className="join-room-icon"><UsersRound size={22}/></div><div className="join-room-copy"><b>Have a room code?</b><span>Join your friends’ study session.</span></div><form className="room-join-form" onSubmit={joinRoom}><Input placeholder="Enter room code" aria-label="Room code" value={joinCode} onChange={event => setJoinCode(event.target.value)}/><Button type="submit" variant="secondary" disabled={busy}>Join room <ArrowRight size={16}/></Button></form></Card>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="form-info" role="status">{notice}</div>}
    <div className="rooms-heading"><h2>Your study rooms</h2><span>Room links are shared by invite code.</span></div>
    <div className="room-grid">{rooms.map(item => <Card className="room-card" key={item.id}><div className="room-banner violet"><span className="room-emoji">📚</span><span className="room-tag">{item.room_code}</span></div><div className="room-info"><small>{item.subject || 'Study session'}</small><h3>{item.name}</h3><div className="room-meta"><span><UsersRound size={15}/> Shared room</span><span><Headphones size={15}/> Chat enabled</span></div><Button variant="secondary" onClick={() => void openRoom(item)}>Open room <ArrowRight size={15}/></Button></div></Card>)}{!rooms.length && <Card className="room-empty"><UsersRound size={22}/><p>{user ? 'Create a room or join one with an invite code. Rooms you belong to appear here.' : 'Sign in to create or join a shared room.'}</p></Card>}</div>
    <Card className="room-create-card" id="create-study-room"><div className="stage-top"><div><div className="section-kicker">START A STUDY GROUP</div><h2>Create a room</h2></div></div><form className="room-create-form" onSubmit={createRoom}><label className="form-label">Room name<Input placeholder="e.g. Algorithms study group" value={name} onChange={event => setName(event.target.value)} maxLength={80}/></label><label className="form-label">Subject<Input placeholder="e.g. Data Structures" value={subject} onChange={event => setSubject(event.target.value)} maxLength={80}/></label><label className="form-label">Shared YouTube lecture (optional)<Input placeholder="https://youtube.com/watch?v=..." value={videoUrl} onChange={event => setVideoUrl(event.target.value)}/></label><Button type="submit" disabled={busy || !name.trim()}><Plus size={16}/> Create room</Button></form></Card>
    {room && <Card className="room-stage"><div className="stage-top"><div><div className="section-kicker">ROOM CODE · {room.room_code}</div><h2>{room.name}</h2><small>{room.subject || 'Study together'}</small></div><button className="text-link" onClick={() => { setRoom(null); setChannel(null); }}>Close room</button></div><div className="stage-body"><div className="room-shared-video">{videoId ? <><iframe id="study-room-player" src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1&playsinline=1&origin=${encodeURIComponent(window.location.origin)}`} title="Shared study lecture" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen/><form className="room-video-controls" onSubmit={event => { event.preventDefault(); void sync('seek'); }}><Button type="button" variant="secondary" onClick={() => void sync('play')}><Play size={15}/> Play for room</Button><Button type="button" variant="secondary" onClick={() => void sync('pause')}>Pause for room</Button><Input type="number" min="0" aria-label="Seek to seconds" value={seekTo} onChange={event => setSeekTo(Number(event.target.value))}/><Button type="submit" variant="secondary">Sync position</Button></form></> : <div className="room-video-empty"><Video size={28}/><p>No shared lecture is loaded.</p>{room.host_user_id === user?.id && <form onSubmit={saveVideo}><Input placeholder="Paste a YouTube URL" value={videoUrl} onChange={event => setVideoUrl(event.target.value)}/><Button type="submit" variant="secondary">Load lecture</Button></form>}</div>}{playbackNotice && <small role="status">{playbackNotice}</small>}<small>Use the room controls above to share play, pause, and seek actions with connected members.</small></div><div className="room-chat"><div className="room-chat-head"><b><MessageCircle size={15}/> Room chat</b><span>{messages.length} messages</span></div><div className="room-message-list">{messages.map(message => <div className="room-person-message" key={message.id}><span className="avatar avatar-violet">{message.user_id === user?.id ? 'You' : message.user_id.slice(0, 2).toUpperCase()}</span><p><b>{message.user_id === user?.id ? 'You' : 'Study mate'}</b>{message.content}<small>{new Date(message.created_at).toLocaleTimeString()}</small></p></div>)}{!messages.length && <p className="room-empty-chat">Say hello to your study group.</p>}</div><form className="room-chat-input" onSubmit={sendMessage}><Input placeholder="Say something kind..." value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000}/><button aria-label="Send chat" type="submit" disabled={busy || !draft.trim()}><Send size={15}/></button></form></div></div></Card>}
  </div>;
}

function formatTime(seconds: number) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
