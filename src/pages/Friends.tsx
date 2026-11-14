import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Clock3, Link2, LoaderCircle, MailPlus, Search, Send, UserMinus, UserPlus, UsersRound, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button, Card, Input, PageHeader } from '../components/common/UI';
import { createFriendRequest, getActiveStudyRooms, getFriendOverview, getProfileByUsername, removeFriend, respondToFriendRequest, searchAbhyasProfiles, subscribeToPresence } from '../services/friendsService';
import type { AbhyasProfile, ActiveStudyRoom } from '../types/friends';

type Tab = 'friends' | 'find' | 'requests';
function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'; }
function Avatar({ profile, small = false }: { profile: AbhyasProfile; small?: boolean }) {
  return <span className={`friends-avatar${small ? ' small' : ''}`}>{profile.avatar_url ? <img src={profile.avatar_url} alt=""/> : initials(profile.display_name)}</span>;
}
function ProfileLine({ profile, online, action }: { profile: AbhyasProfile; online?: boolean; action?: ReactNode }) {
  return <div className="friends-person"><Avatar profile={profile}/><div className="friends-person-copy"><b>{profile.display_name}</b><Link to={`/profile/${encodeURIComponent(profile.username)}`}>@{profile.username}</Link>{online !== undefined && <span className={`friends-presence ${online ? 'online' : ''}`}><i/>{online ? 'Online' : 'Offline'}</span>}</div>{action && <div className="friends-person-actions">{action}</div>}</div>;
}
type Overview = Awaited<ReturnType<typeof getFriendOverview>>;

export function FriendsPage() {
  const { session, preview } = useAuth();
  const navigate = useNavigate();
  const userId = session?.user.id;
  const [tab, setTab] = useState<Tab>('friends');
  const [overview, setOverview] = useState<Overview>({ friends: [], incoming: [], outgoing: [] });
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [friendFilter, setFriendFilter] = useState('');
  const [results, setResults] = useState<AbhyasProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inviteTarget, setInviteTarget] = useState<AbhyasProfile | null>(null);
  const [activeRooms, setActiveRooms] = useState<ActiveStudyRoom[]>([]);
  const [inviteBusy, setInviteBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) { setLoading(false); return; }
    try { setError(''); setOverview(await getFriendOverview(userId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load friends.'); }
    finally { setLoading(false); }
  }, [userId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const friendIdKey = overview.friends.map((profile) => profile.user_id).sort().join(',');
  useEffect(() => { if (!userId) return; return subscribeToPresence(userId, friendIdKey ? friendIdKey.split(',') : [], setOnline); }, [userId, friendIdKey]);
  useEffect(() => {
    const clean = query.trim();
    if (tab !== 'find' || clean.length < 2) { setResults([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    setResults([]);
    const timer = window.setTimeout(() => {
      void searchAbhyasProfiles(clean).then((profiles) => { if (!cancelled) setResults(profiles.filter((profile) => profile.user_id !== userId)); })
        .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Search failed.'); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, tab, userId]);

  const friends = useMemo(() => overview.friends.filter((profile) => `${profile.display_name} ${profile.username}`.toLowerCase().includes(friendFilter.trim().toLowerCase())), [overview.friends, friendFilter]);
  const friendIds = useMemo(() => new Set(overview.friends.map((profile) => profile.user_id)), [overview.friends]);
  const pendingIds = useMemo(() => new Set([...overview.incoming.map(({ profile }) => profile.user_id), ...overview.outgoing.map(({ profile }) => profile.user_id)]), [overview]);
  const perform = async (id: string, action: () => Promise<void>, message: string) => {
    setBusyId(id); setError(''); setNotice('');
    try { await action(); await refresh(); setNotice(message); }
    catch (cause) { setError(cause instanceof Error ? cause.message.replace(/_/g, ' ').toLowerCase() : 'That action could not be completed.'); }
    finally { setBusyId(''); }
  };
  const openInvite = async (profile: AbhyasProfile) => {
    if (!userId) return;
    setInviteTarget(profile); setInviteBusy(true); setError('');
    try { setActiveRooms(await getActiveStudyRooms(userId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load your active rooms.'); }
    finally { setInviteBusy(false); }
  };
  const shareRoom = async (room: ActiveStudyRoom) => {
    const url = `${window.location.origin}/study-together?code=${encodeURIComponent(room.room_code)}`;
    try {
      if (navigator.share) await navigator.share({ title: `Join my Study Together room: ${room.name}`, text: `${inviteTarget?.display_name ?? 'A friend'} invited you to study together. Room code: ${room.room_code}`, url });
      else { await navigator.clipboard.writeText(url); setNotice('Room invite link copied. Send it to your friend.'); }
      setInviteTarget(null);
    } catch (cause) { if (cause instanceof Error && cause.name !== 'AbortError') setError('Could not share the room invite. Copy the room code and send it to your friend.'); }
  };

  if (!session) return <><PageHeader title="Friends" description="Find your people and study together."/><Card className="friends-state">{preview ? 'Friends are available after signing in with a real account.' : 'Sign in to view and manage your friends.'}</Card></>;

  return <div className="friends-page">
    <PageHeader title="Friends" description="Build your study circle and keep each other moving."/>
    <Card className="friends-hero"><div className="friends-hero-icon"><UsersRound size={23}/></div><div><span className="friends-kicker">YOUR STUDY CIRCLE</span><h2>Better learning, together.</h2><p>Connect with learners, see who’s online, and invite friends to your active study room.</p></div><div className="friends-hero-count"><b>{overview.friends.length}</b><span>friends</span></div></Card>
    {error && <div className="friends-alert" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
    {notice && <div className="friends-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={15}/></button></div>}
    <div className="friends-tabs" role="tablist" aria-label="Friends sections">{([['friends', 'Friends'], ['find', 'Find Friends'], ['requests', 'Requests']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}{key === 'requests' && overview.incoming.length > 0 && <span className="friends-count">{overview.incoming.length}</span>}</button>)}</div>
    {tab === 'friends' && <Card className="friends-list-card"><div className="friends-section-head"><div><h2>Your friends</h2><p>{overview.friends.length} connected learner{overview.friends.length === 1 ? '' : 's'}</p></div><label className="friends-filter"><Search size={17}/><Input placeholder="Filter friends" value={friendFilter} onChange={(event) => setFriendFilter(event.target.value)}/></label></div>
      {loading ? <div className="friends-skeletons">{[0,1,2].map((n) => <div key={n} className="friends-skeleton"/>)}</div> : friends.length ? <div className="friends-rows">{friends.map((profile) => <ProfileLine key={profile.user_id} profile={profile} online={online.has(profile.user_id)} action={<><Button variant="secondary" onClick={() => void openInvite(profile)}><Send size={14}/> Invite to Study Together</Button><Button variant="secondary" aria-label={`Remove ${profile.display_name}`} onClick={() => { if (window.confirm(`Remove ${profile.display_name} as a friend?`)) void perform(profile.user_id, () => removeFriend(profile.user_id), 'Friend removed.'); }} disabled={busyId === profile.user_id}><UserMinus size={15}/></Button></>}/> )}</div> : <div className="friends-empty"><span><UsersRound size={22}/></span><b>{friendFilter ? 'No matching friends' : 'Your study circle starts here'}</b><p>{friendFilter ? 'Try another name or username.' : 'Find learners you know and send your first friend request.'}</p>{!friendFilter && <Button onClick={() => setTab('find')}><UserPlus size={15}/> Find Friends</Button>}</div>}
    </Card>}
    {tab === 'find' && <Card className="friends-list-card"><div className="friends-section-head"><div><h2>Find learners</h2><p>Search by name or username.</p></div></div><label className="friends-search"><Search size={18}/><Input autoFocus placeholder="Try a name or @username" value={query} onChange={(event) => setQuery(event.target.value)}/>{searching && <LoaderCircle size={17} className="spin"/>}</label>
      {query.trim().length < 2 ? <div className="friends-hint">Enter at least 2 characters to search.</div> : searching ? <div className="friends-skeletons">{[0,1,2].map((n) => <div key={n} className="friends-skeleton"/>)}</div> : results.length ? <div className="friends-rows">{results.map((profile) => {
        const incoming = overview.incoming.find((row) => row.profile.user_id === profile.user_id);
        const outgoing = overview.outgoing.some((row) => row.profile.user_id === profile.user_id);
        const action = friendIds.has(profile.user_id) ? <span className="friends-status-pill"><Check size={14}/> Friends</span> : incoming ? <Button onClick={() => { setTab('requests'); }}><Clock3 size={14}/> Respond</Button> : outgoing ? <span className="friends-status-pill pending"><Clock3 size={14}/> Request sent</span> : <Button disabled={busyId === profile.user_id || pendingIds.has(profile.user_id)} onClick={() => void perform(profile.user_id, () => createFriendRequest(profile.user_id), 'Friend request sent.')}><UserPlus size={14}/> Add friend</Button>;
        return <ProfileLine key={profile.user_id} profile={profile} action={action}/>;
      })}</div> : <div className="friends-empty"><span><Search size={21}/></span><b>No learners found</b><p>Try another name or username.</p></div>}
    </Card>}
    {tab === 'requests' && <div className="friends-request-grid"><RequestList title="Incoming requests" description="Accept to add them to your friends." empty="No incoming requests right now." rows={overview.incoming} busyId={busyId} onAction={(id, action) => void perform(id, () => respondToFriendRequest(id, action), action === 'accept' ? 'Friend request accepted.' : 'Friend request declined.')}/><RequestList title="Sent requests" description="Requests waiting for a reply." empty="You have no pending sent requests." rows={overview.outgoing} busyId={busyId} onAction={(id) => void perform(id, () => respondToFriendRequest(id, 'cancel'), 'Friend request cancelled.')}/></div>}
    {inviteTarget && <div className="friends-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInviteTarget(null); }}><section className="friends-modal" role="dialog" aria-modal="true" aria-labelledby="invite-heading"><header><div><span className="friends-kicker">STUDY TOGETHER</span><h2 id="invite-heading">Invite {inviteTarget.display_name}</h2><p>Share an active room invite. No new room will be created.</p></div><button className="friends-modal-close" aria-label="Close" onClick={() => setInviteTarget(null)}><X size={18}/></button></header>{inviteBusy ? <div className="friends-modal-state"><LoaderCircle className="spin"/> Loading your active rooms…</div> : activeRooms.length ? <div className="friends-room-options">{activeRooms.map((room) => <div key={room.id}><span className="friends-room-icon"><Link2 size={17}/></span><div><b>{room.name}</b><small>Room code: {room.room_code}</small></div><Button onClick={() => void shareRoom(room)}><Send size={14}/> Share</Button></div>)}</div> : <div className="friends-empty compact"><span><MailPlus size={20}/></span><b>No active rooms</b><p>Join or create a Study Together room first.</p><Button variant="secondary" onClick={() => { setInviteTarget(null); navigate('/study-together'); }}>Go to Study Together</Button></div>}</section></div>}
  </div>;
}

function RequestList({ title, description, empty, rows, busyId, onAction }: { title: string; description: string; empty: string; rows: { request: { id: string }; profile: AbhyasProfile }[]; busyId: string; onAction: (id: string, action: 'accept' | 'reject' | 'cancel') => void }) {
  const incoming = title.startsWith('Incoming');
  return <Card className="friends-list-card request-card"><div className="friends-section-head"><div><h2>{title}</h2><p>{description}</p></div></div>{rows.length ? <div className="friends-rows">{rows.map(({ request, profile }) => <ProfileLine key={request.id} profile={profile} action={incoming ? <><Button onClick={() => onAction(request.id, 'accept')} disabled={busyId === request.id}><Check size={14}/> Accept</Button><Button variant="secondary" onClick={() => onAction(request.id, 'reject')} disabled={busyId === request.id}><X size={14}/> Decline</Button></> : <Button variant="secondary" onClick={() => onAction(request.id, 'cancel')} disabled={busyId === request.id}>Cancel</Button>}/>)}</div> : <div className="friends-empty compact"><span><Clock3 size={20}/></span><p>{empty}</p></div>}</Card>;
}

export function PublicProfilePage() {
  const { username = '' } = useParams();
  const { session } = useAuth();
  const [profile, setProfile] = useState<AbhyasProfile | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => { let active = true; void getProfileByUsername(username).then((value) => { if (active) setProfile(value); }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load this profile.'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [username]);
  if (loading) return <Card className="friends-state"><LoaderCircle className="spin"/> Loading profile…</Card>;
  if (error || !profile) return <Card className="friends-state"><p>{error || 'This profile could not be found.'}</p><Link to="/friends"><ArrowLeft size={15}/> Back to Friends</Link></Card>;
  return <div className="friends-page"><PageHeader title="Learner profile" description="Get to know someone in the Abhyas community."/><Card className="public-profile-card"><Avatar profile={profile}/><span className="friends-kicker">ABHYAS LEARNER</span><h2>{profile.display_name}</h2><p>@{profile.username}</p>{session?.user.id !== profile.user_id && <Link className="button" to="/friends">Find on Friends <UserPlus size={15}/></Link>}</Card></div>;
}
