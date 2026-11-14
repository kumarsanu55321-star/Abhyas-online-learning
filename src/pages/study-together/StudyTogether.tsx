import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpen, Check, Clipboard, Globe2, Headphones, LockKeyhole, Plus, ShieldCheck, UsersRound, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { Button, Card, Input, PageHeader } from '../../components/common/UI';
import SynchronizedYouTubePlayer from '../../components/study-together/SynchronizedYouTubePlayer';
import type { StudyRoomPlayerControls } from '../../components/study-together/SynchronizedYouTubePlayer';
import StudyRoomChat from '../../components/study-together/StudyRoomChat';
import PlaybackPermissionsManager from '../../components/study-together/PlaybackPermissionsManager';
import { createStudyRoom, getStudyRoom, joinStudyRoom, leaveStudyRoom, listPublicStudyRooms } from '../../services/studyRoomService';
import { supabaseConfigured } from '../../services/supabase';
import type { StudyRoomDetails, StudyRoomVisibility } from '../../types/studyRoom';

function displayName(name?: string, email?: string) { return name?.trim() || email?.split('@')[0] || 'Learner'; }
function validYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean).length > 0;
    if (!['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) return false;
    return Boolean(url.searchParams.get('v') || url.pathname.match(/^\/(embed|shorts|live)\/[^/]+/));
  } catch { return false; }
}

export default function StudyTogether() {
  const { session, preview } = useAuth(); const navigate = useNavigate(); const [params] = useSearchParams();
  const [rooms, setRooms] = useState<StudyRoomDetails[]>([]); const [loadingRooms, setLoadingRooms] = useState(true); const [roomError, setRoomError] = useState('');
  const [modalOpen, setModalOpen] = useState(false); const [saving, setSaving] = useState(false); const [formError, setFormError] = useState('');
  const [code, setCode] = useState(params.get('code')?.toUpperCase() ?? ''); const [joiningCode, setJoiningCode] = useState<string | null>(null); const [joinError, setJoinError] = useState('');
  const [name, setName] = useState(''); const [subject, setSubject] = useState(''); const [youtubeUrl, setYoutubeUrl] = useState(''); const [visibility, setVisibility] = useState<StudyRoomVisibility>('public'); const [capacity, setCapacity] = useState('5');
  const learnerName = useMemo(() => displayName(session?.user.user_metadata.full_name as string | undefined ?? session?.user.user_metadata.name as string | undefined, session?.user.email), [session]);

  async function loadRooms() {
    setLoadingRooms(true); setRoomError('');
    try {
      if (!session) throw new Error(preview ? 'Sign in with a real Abhyas account to browse and join study rooms. Preview sessions cannot access room data.' : 'Sign in with your Abhyas account to see available rooms.');
      setRooms(await listPublicStudyRooms());
    } catch (error) { setRoomError(error instanceof Error ? error.message : 'Could not load study rooms. Please try again.'); }
    finally { setLoadingRooms(false); }
  }
  useEffect(() => { void loadRooms(); }, [session?.user.id, preview]);

  async function createRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError('');
    const max = Number(capacity);
    if (!name.trim() || !subject.trim()) { setFormError('Room name and subject are required.'); return; }
    if (youtubeUrl.trim() && !validYouTubeUrl(youtubeUrl.trim())) { setFormError('Enter a valid YouTube video URL, or leave this field empty.'); return; }
    if (!Number.isInteger(max) || max < 2 || max > 10) { setFormError('Choose a participant limit from 2 to 10, including you as host.'); return; }
    setSaving(true);
    try {
      const result = await createStudyRoom({ name, subject, youtubeUrl: youtubeUrl.trim() || null, visibility, maxParticipants: max, displayName: learnerName });
      setModalOpen(false); navigate(`/study-together/room/${result.room.id}`);
    } catch (error) { setFormError(error instanceof Error ? error.message : 'Room creation failed. Please try again.'); }
    finally { setSaving(false); }
  }

  async function joinRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setJoinError('');
    const normalized = code.trim().toUpperCase();
    if (!/^[A-F0-9]{10}$/.test(normalized)) { setJoinError('Room codes are 10 characters. Check the code and try again.'); return; }
    await joinRoomWithCode(normalized);
  }

  async function joinRoomWithCode(roomCode: string) {
    const normalized = roomCode.trim().toUpperCase();
    setJoinError(''); setJoiningCode(normalized);
    try {
      const result = await joinStudyRoom(normalized, learnerName);
      if (!result.room.id) throw new Error('The room service did not return a room ID.');
      navigate(`/study-together/room/${result.room.id}`);
    } catch (error) {
      setJoinError(error instanceof Error ? error.message : 'Could not join this room. Please try again.');
    } finally { setJoiningCode(null); }
  }

  return <div className="feature-page study-together-page">
    <PageHeader eyebrow="BETTER TOGETHER" title="Study Together" description="Good company, great focus. Create a room or join your friends’ session." action={<Button onClick={() => { setFormError(''); setModalOpen(true); }}><Plus size={17}/> Create a room</Button>}/>
    <form className="join-room-card" onSubmit={joinRoom}>
      <div className="join-room-icon"><UsersRound size={22}/></div><div className="join-room-copy"><b>Have a room code?</b><span>Private room codes work as invitations.</span></div>
      <label className="sr-only" htmlFor="study-room-code">Room code</label><Input id="study-room-code" placeholder="Enter 10-character code" autoComplete="off" maxLength={10} value={code} onChange={event => setCode(event.target.value.toUpperCase())}/>
      <Button variant="secondary" disabled={joiningCode !== null || !code.trim()}>{joiningCode !== null ? <><span className="spinner spinner-purple"/> Joining...</> : <>Join room <ArrowRight size={16}/></>}</Button>
    </form>

    <div className="rooms-heading"><div><div className="section-kicker">OPEN TO ABHYAS LEARNERS</div><h2>Public study rooms</h2></div><button className="text-link" type="button" onClick={() => void loadRooms()}>Refresh rooms <ArrowRight size={15}/></button></div>
    {joinError && <div className="room-inline-error room-load-error" role="alert">{joinError}</div>}
    {!supabaseConfigured && <div className="room-config-note">Study rooms need Supabase configured before they can be created or joined.</div>}
    {roomError && <div className="room-inline-error room-load-error" role="alert">{roomError}<button type="button" onClick={() => void loadRooms()}>Try again</button></div>}
    {loadingRooms ? <div className="room-loading"><span className="spinner spinner-purple"/> Loading available rooms...</div> : !roomError && rooms.length === 0 ? <div className="room-empty"><div className="room-empty-icon"><BookOpen size={22}/></div><b>No public rooms yet</b><span>Create a room for your study group, or join a friend with their room code.</span><Button variant="secondary" onClick={() => setModalOpen(true)}><Plus size={15}/> Create the first room</Button></div> : <div className="room-grid">{rooms.map(({ room, participants }) => <Card className="room-card" key={room.id}>
      <div className={`room-banner ${['violet','mint','coral'][room.subject.length % 3]}`}><span className="room-emoji">📚</span><span className="room-tag">{room.subject}</span><span className="live-badge"><i/> ACTIVE</span></div>
      <div className="room-info"><small>{room.visibility === 'public' ? 'Public room' : 'Private room'}</small><h3>{room.name}</h3><div className="room-meta"><span><UsersRound size={15}/>{participants.length} / {room.max_participants} learners</span><span><Headphones size={15}/> Voice optional</span></div><div className="room-host-line">Hosted by {participants.find(person => person.role === 'host')?.display_name ?? 'Abhyas learner'}</div>
        <Button variant="secondary" disabled={participants.length >= room.max_participants || joiningCode !== null} onClick={() => void joinRoomWithCode(room.room_code)}>{joiningCode === room.room_code ? <><span className="spinner spinner-purple"/> Joining...</> : participants.length >= room.max_participants ? 'Room is full' : 'Join room'} {joiningCode !== room.room_code && <ArrowRight size={15}/>}</Button>
      </div></Card>)}</div>}
    {modalOpen && <div className="room-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !saving) setModalOpen(false); }}><section className="room-modal" role="dialog" aria-modal="true" aria-labelledby="create-room-title"><div className="room-modal-head"><div><span className="section-kicker">MAKE IT A STUDY SESSION</span><h2 id="create-room-title">Create a room</h2><p>Bring your study group together in one place.</p></div><button className="room-modal-close" type="button" onClick={() => setModalOpen(false)} disabled={saving} aria-label="Close dialog"><X size={18}/></button></div>
      <form onSubmit={createRoom} className="room-form"><label className="form-label">Room name<Input autoFocus required maxLength={80} placeholder="e.g. Data Structures Study Group" value={name} onChange={event => setName(event.target.value)}/></label><label className="form-label">Subject<Input required maxLength={80} placeholder="e.g. Computer Science" value={subject} onChange={event => setSubject(event.target.value)}/></label><label className="form-label">YouTube video URL <span className="optional-label">Optional</span><Input type="url" placeholder="https://youtube.com/watch?v=..." value={youtubeUrl} onChange={event => setYoutubeUrl(event.target.value)}/></label>
      <fieldset className="visibility-fieldset"><legend>Room visibility</legend><label className={`visibility-choice ${visibility === 'public' ? 'chosen' : ''}`}><input type="radio" name="visibility" value="public" checked={visibility === 'public'} onChange={() => setVisibility('public')}/><Globe2 size={18}/><span><b>Public</b><small>Listed for other learners</small></span></label><label className={`visibility-choice ${visibility === 'private' ? 'chosen' : ''}`}><input type="radio" name="visibility" value="private" checked={visibility === 'private'} onChange={() => setVisibility('private')}/><LockKeyhole size={18}/><span><b>Private</b><small>Join by invitation code</small></span></label></fieldset>
      <label className="form-label">Maximum participants <span className="optional-label">Including host</span><select className="field" value={capacity} onChange={event => setCapacity(event.target.value)}>{Array.from({length:9},(_,i)=>i+2).map(count=><option key={count} value={count}>{count} learners</option>)}</select></label>
      {formError && <div className="form-error" role="alert">{formError}</div>}{!session && <div className="form-info">{preview ? 'Preview mode cannot create real rooms. Sign in with Supabase to continue.' : 'A real Abhyas account is required to host a room.'}</div>}
      <div className="room-form-actions"><Button type="button" variant="secondary" disabled={saving} onClick={() => setModalOpen(false)}>Cancel</Button><Button disabled={saving}>{saving ? <><span className="spinner"/> Creating...</> : <>Create room <ArrowRight size={16}/></>}</Button></div></form>
    </section></div>}
  </div>;
}

export function StudyRoomPage() {
  const { session, preview } = useAuth(); const navigate = useNavigate();
  const { roomId = '' } = useParams();
  const playerControlsRef = useRef<StudyRoomPlayerControls | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [details, setDetails] = useState<StudyRoomDetails | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [copied, setCopied] = useState(false); const [leaving, setLeaving] = useState(false);
  const currentUserId = session?.user.id; const me = details?.participants.find(person => person.user_id === currentUserId); const isHost = me?.role === 'host';
  async function refresh() { setLoading(true); setError(''); try { setDetails(await getStudyRoom(roomId)); } catch (e) { setError(e instanceof Error ? e.message : 'This room is unavailable.'); } finally { setLoading(false); } }
  useEffect(() => { void refresh(); }, [roomId, currentUserId, preview]);
  async function copyInvite() { if (!details) return; try { await navigator.clipboard.writeText(`${window.location.origin}/study-together?code=${details.room.room_code}`); setCopied(true); window.setTimeout(() => setCopied(false), 2200); } catch { setError('Could not copy the invitation link. You can share room code ' + details.room.room_code + ' instead.'); } }
  async function leave() { if (!details) return; setLeaving(true); try { await leaveStudyRoom(details.room.id, Boolean(isHost)); navigate('/study-together'); } catch (e) { setError(e instanceof Error ? e.message : 'Could not leave this room.'); setLeaving(false); } }

  if (loading) return <div className="room-page-loading"><span className="spinner spinner-purple"/> Opening your study room...</div>;
  if (error || !details || !me) return <Card className="room-unauthorized"><div className="room-empty-icon"><LockKeyhole size={22}/></div><h2>{preview && !session ? 'Sign in to access study rooms' : 'This room isn’t available to you'}</h2><p>{error || 'You need to join this room before you can see its participants.'}</p><Button variant="secondary" onClick={() => navigate('/study-together')}>Back to Study Together</Button></Card>;
  const { room, participants } = details;
  return <div className="feature-page study-room-page"><div className="study-room-header"><div><Link to="/study-together" className="room-back-link">← Study Together</Link><div className="room-title-row"><h1>{room.name}</h1><span className={`room-status ${room.status}`}>{room.status === 'active' ? '● Active' : 'Ended'}</span></div><p>{room.subject} <span>·</span> Room code <b>{room.room_code}</b></p></div><div className="study-room-actions"><Button variant="secondary" onClick={copyInvite}>{copied ? <Check size={16}/> : <Clipboard size={16}/>} {copied ? 'Link copied' : 'Copy invite link'}</Button>{isHost && room.status === 'active' && <Button className="playback-permissions-trigger" variant="secondary" onClick={() => setPermissionsOpen(true)}><ShieldCheck size={16}/> Manage Playback Permissions</Button>}<Button variant="secondary" disabled={leaving || room.status === 'ended'} onClick={leave}>{leaving ? 'Leaving...' : isHost ? 'End room' : 'Leave room'}</Button></div></div>
    <div className="study-room-layout"><div className="study-room-main"><SynchronizedYouTubePlayer roomId={room.id} hostId={room.host_id} currentUserId={currentUserId ?? ''} isHost={Boolean(isHost)} roomVideoUrl={room.youtube_url} playerControlsRef={playerControlsRef}/><StudyRoomChat roomId={room.id} currentUserId={currentUserId ?? ''} participants={participants} playerControlsRef={playerControlsRef}/></div>
      <Card className="participants-panel"><div className="participants-title"><div><div className="section-kicker">YOUR STUDY CREW</div><h2>Participants</h2></div><span className="participant-count">{participants.length} / {room.max_participants}</span></div><div className="participant-capacity"><span>{participants.length} learner{participants.length === 1 ? '' : 's'} in this room</span><span>{room.max_participants - participants.length} spots left</span></div><div className="capacity-track"><i style={{width:`${participants.length / room.max_participants * 100}%`}}/></div><div className="participant-list">{participants.map((person,index)=><div className="participant-row" key={person.id}><span className={`participant-avatar participant-color-${index % 5}`}>{person.display_name.trim().split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase()}</span><div><b>{person.display_name}{person.user_id === currentUserId ? ' (you)' : ''}</b><small>{person.role === 'host' ? 'Room host' : 'Learner'}</small></div>{person.role === 'host' && <span className="host-badge">HOST</span>}</div>)}</div><button className="refresh-participants" onClick={() => void refresh()}>Refresh participant list</button></Card></div>
    {permissionsOpen && isHost && room.status === 'active' && <PlaybackPermissionsManager roomId={room.id} participants={participants} onClose={() => setPermissionsOpen(false)}/>}
  </div>;
}
