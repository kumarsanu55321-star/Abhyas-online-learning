import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Clock3, Flame, History as HistoryIcon, Search, Sparkles, Target, Trophy, UserRound, Zap } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, Input, PageHeader, ProgressBar, SectionTitle } from '../components/common/UI';
import { useAuth } from '../context/AuthContext';
import { ensureLearnerProfile, getLeaderboard, loadProgress, updateLearnerProfile, type LearningEvent, type LearnerProfile } from '../services/progress';
import { supabase } from '../services/supabase';

function useLearnerData() {
  const { session } = useAuth();
  const user = session?.user;
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [events, setEvents] = useState<LearningEvent[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(user));
  async function refresh() {
    if (!user) return;
    setLoading(true);
    try { await ensureLearnerProfile(user); const result = await loadProgress(user.id); setProfile(result.profile); setEvents(result.events); setError(''); }
    catch (cause) { setError(cause instanceof Error ? `${cause.message}. Apply the learning progress and rooms migration in Supabase.` : 'Could not load learner data.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [user?.id]);
  return { user, profile, setProfile, events, setEvents, error, setError, loading, refresh };
}

export function LearningHistory() {
  const { user, profile, events, error, loading } = useLearnerData();
  const [filter, setFilter] = useState('All activity');
  const [query, setQuery] = useState('');
  const [range, setRange] = useState('all');
  const [savedItems, setSavedItems] = useState<Array<{id:string;event_type:string;title:string;detail:string;subject:string|null;xp_points:number;created_at:string}>>([]);
  const [savedError, setSavedError] = useState('');
  const filters = ['All activity','AI Tutor','Quiz','Reverse Lecture','Study Together','Lecture','Syllabus'];
  useEffect(() => {
    if (!supabase || !user) { setSavedItems([]); return; }
    void Promise.all([
      supabase.from('ai_conversations').select('id,title,created_at,updated_at').eq('user_id',user.id).order('updated_at',{ascending:false}).limit(100),
      supabase.from('ai_lecture_sessions').select('id,video_id,materials,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(100),
    ]).then(([chatResult,lectureResult]) => {
      if (chatResult.error || lectureResult.error) { setSavedError(`Some saved AI history could not load: ${(chatResult.error||lectureResult.error)?.message}`); return; }
      const chats=(chatResult.data||[]).filter(item=>!item.title.startsWith('Reverse Lecture:')).map(item=>({id:`chat:${item.id}`,event_type:'ai_chat',title:item.title,detail:'Saved AI tutor conversation',subject:null,xp_points:0,created_at:item.updated_at||item.created_at}));
      const lectures=(lectureResult.data||[]).map(item=>({id:`lecture:${item.id}`,event_type:'lecture_session',title:String(item.materials?.summary||'YouTube lecture').slice(0,100),detail:`Saved lecture analysis · ${item.video_id}`,subject:null,xp_points:0,created_at:item.created_at}));
      setSavedItems([...chats,...lectures]); setSavedError('');
    });
  },[user?.id]);
  const now = Date.now();
  const history = useMemo(() => [...events.filter(event=>event.event_type!=='lecture_analyzed'),...savedItems], [events,savedItems]);
  const items = useMemo(() => history.filter(event => {
    const label = category(event.event_type);
    const categoryMatch = filter === 'All activity' || filter === label || filter === 'Study Together' && event.event_type === 'study_session_completed';
    const queryMatch = `${event.title} ${event.detail} ${event.subject || ''}`.toLowerCase().includes(query.toLowerCase());
    const rangeMatch = range === 'all' || now - Date.parse(event.created_at) <= Number(range) * 86400000;
    return categoryMatch && queryMatch && rangeMatch;
  }), [history, filter, query, range]);
  const xp = events.reduce((sum, item) => sum + item.xp_points, 0);
  const minutes = Math.round(events.reduce((sum, item) => sum + item.duration_seconds, 0) / 60);
  const topics = new Set(events.map(item => String(item.metadata?.topic || '')).filter(Boolean)).size;
  const today = new Date().toISOString().slice(0, 10);
  return <div className="feature-page"><PageHeader eyebrow="LOOK HOW FAR YOU’VE COME" title="Learning history" description="Your saved quizzes, explanations, and study sessions." action={<label className="history-range"><CalendarDays size={16}/><select aria-label="History date range" value={range} onChange={event => setRange(event.target.value)}><option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></label>}/>
    {error && <div className="form-error" role="alert">{error}</div>}{savedError&&<div className="form-info" role="status">{savedError}</div>}
    <div className="history-stats"><Card><span className="stat-icon purple"><Clock3 size={19}/></span><div><b>{formatDuration(minutes)}</b><small>Total recorded study time</small></div></Card><Card><span className="stat-icon gold"><Zap size={19}/></span><div><b>{xp.toLocaleString()} XP</b><small>From saved learning events</small></div></Card><Card><span className="stat-icon mint"><Target size={19}/></span><div><b>{topics} topics</b><small>Topics explored</small></div></Card><Card><span className="stat-icon coral"><Flame size={19}/></span><div><b>{profile?.current_streak || 0} days</b><small>Current streak</small></div></Card></div>
    <Card className="history-card"><div className="history-controls"><div className="history-tabs">{filters.map(item => <button className={filter===item?'selected':''} key={item} onClick={() => setFilter(item)}>{item}</button>)}</div><label className="history-search"><Search size={16}/><Input placeholder="Search activity..." value={query} onChange={event => setQuery(event.target.value)}/></label></div>
      {loading ? <div className="history-empty">Loading saved activity…</div> : items.length ? <><div className="history-date-label">SAVED LEARNING ACTIVITY</div>{items.map(event => <div className="history-row" key={event.id}><span className={`activity-icon activity-${color(event.event_type)}`}>{icon(event.event_type)}</span><div><b>{event.title}</b><span>{event.detail}{event.subject ? ` · ${event.subject}` : ''}</span></div><small>{new Date(event.created_at).toLocaleString()}</small><span className="history-xp">+{event.xp_points} XP</span></div>)}</> : <div className="history-empty"><HistoryIcon size={26}/><b>{user ? 'No matching activity yet' : 'Sign in to see your saved activity'}</b><span>Finished quizzes and Reverse Lecture sessions are saved here.</span><Link to="/ai-tutor" className="text-link">Start learning <ArrowRight size={15}/></Link></div>}</Card>
    <div className="sr-only">{today}</div>
  </div>;
}

export function Profile() {
  const { user, profile, setProfile, events, error } = useLearnerData();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (profile) { setName(profile.display_name); setUsername(profile.username); } }, [profile]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!user || !name.trim() || !username.trim()) return;
    setBusy(true); setSaveError('');
    try { setProfile(await updateLearnerProfile(user.id, { display_name: name.trim(), username: username.trim().replace(/^@/, '') })); setEditing(false); }
    catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Could not save your profile.'); }
    finally { setBusy(false); }
  }
  const xp = profile?.total_xp || 0;
  const level = Math.floor(xp / 500) + 1;
  const topics = new Set(events.map(item => String(item.metadata?.topic || '')).filter(Boolean)).size;
  const quizzes = events.filter(item => item.event_type === 'quiz_completed').length;
  const achievements = [
    ...(profile?.current_streak && profile.current_streak >= 7 ? [['🔥','On a roll',`${profile.current_streak} day streak`,'coral']] : []),
    ...(xp >= 2000 ? [['⚡','Quick learner','Earned 2,000 XP','gold']] : []),
    ...(quizzes >= 10 ? [['🎯','Quiz whiz',`${quizzes} quizzes completed`,'mint']] : []),
    ...(events.length ? [['🌱','First steps','Completed a learning activity','violet']] : []),
    ...(topics >= 20 ? [['🧠','Deep thinker',`Explored ${topics} topics`,'coral']] : []),
  ];
  const initials = (profile?.display_name || 'L').split(/\s+/).slice(0,2).map(part => part[0]).join('').toUpperCase();
  return <div className="feature-page"><PageHeader eyebrow="YOUR LEARNING IDENTITY" title="My profile" description="Your account and learning milestones." action={<Button variant="secondary" onClick={() => { setEditing(value => !value); setSaveError(''); }}>{editing?'Cancel':'Edit profile'}</Button>}/>
    {error && <div className="form-error" role="alert">{error}</div>}{saveError && <div className="form-error" role="alert">{saveError}</div>}
    <Card className="profile-hero"><div className="profile-cover"><span>✦</span><span>✧</span><span>✦</span></div><div className="profile-details"><div className="avatar avatar-purple profile-large">{initials}</div><div className="profile-main">{editing?<form onSubmit={save} className="profile-edit-form"><label className="form-label">Display name<Input value={name} onChange={event => setName(event.target.value)} maxLength={80}/></label><label className="form-label">Username<Input value={username} onChange={event => setUsername(event.target.value)} maxLength={40}/></label><Button type="submit" disabled={busy}>{busy?'Saving...':'Save profile'}</Button></form>:<><h2>{profile?.display_name || user?.email?.split('@')[0] || 'Learner'}</h2><span>@{profile?.username || 'learner'} · Joined {user?.created_at ? new Date(user.created_at).toLocaleDateString() : 'recently'}</span><span>{user?.email || 'Sign in to manage your profile'}</span></>}</div><div className="level-badge-profile"><span>⭐</span><div><b>Level {level}</b><small>{xp.toLocaleString()} XP</small></div></div></div><div className="profile-stats"><div><b>{xp.toLocaleString()}</b><span>Total XP</span></div><div><b>{profile?.current_streak || 0} days</b><span>Learning streak</span></div><div><b>{topics}</b><span>Topics explored</span></div><div><b>{achievements.length}</b><span>Achievements earned</span></div></div></Card>
    <div className="profile-lower"><Card className="achievements-card"><SectionTitle title="Achievements" action={<span className="muted-note">{achievements.length} earned</span>}/>{achievements.length ? <div className="achievement-grid">{achievements.map(([emoji,title,description,tint])=><div className="achievement" key={title}><span className={`achievement-icon ${tint}`}>{emoji}</span><b>{title}</b><small>{description}</small></div>)}</div> : <div className="history-empty"><Trophy size={23}/><span>Complete learning activities to earn achievements.</span></div>}</Card><Card className="profile-focus"><div className="section-kicker">CURRENT FOCUS</div><h2>Your learning goals</h2><GoalSummary label="Explore 40 topics" current={topics} target={numberGoal(profile?.goals.topics_goal,40)}/><GoalSummary label="Study 20 hours this month" current={Math.floor(events.filter(item=>new Date(item.created_at).getMonth()===new Date().getMonth()).reduce((sum,item)=>sum+item.duration_seconds,0)/60)} target={numberGoal(profile?.goals.monthly_minutes_goal,1200)}/><Link to="/settings" className="text-link">Manage your goals <ArrowRight size={15}/></Link></Card></div>
  </div>;
}

function GoalSummary({label,current,target}:{label:string;current:number;target:number}) { return <div className="goal-row"><span className="goal-icon">🎯</span><div><b>{label}</b><small>{Math.min(current,target)} of {target} {label.includes('hours')?'minutes':'topics'}</small><ProgressBar value={target ? current*100/target : 0}/></div></div>; }

export function Settings() {
  const { user, profile, setProfile, error, loading } = useLearnerData();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [goals, setGoals] = useState({ topics_goal:40, monthly_minutes_goal:1200 });
  const [settings, setSettings] = useState<Record<string, boolean>>({ daily_reminders:true, quest_updates:true, room_invites:true, weekly_recap:true, personalized_suggestions:true });
  useEffect(() => { if (profile) { setDisplayName(profile.display_name); setUsername(profile.username); setGoals({ topics_goal:numberGoal(profile.goals.topics_goal,40), monthly_minutes_goal:numberGoal(profile.goals.monthly_minutes_goal,1200) }); setSettings(current => ({ ...current, ...(profile.settings as Record<string,boolean>) })); } }, [profile]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!user) return;
    setBusy(true); setSaveError(''); setSaved(false);
    try { const updated = await updateLearnerProfile(user.id, { display_name:displayName.trim(), username:username.trim().replace(/^@/,''), goals, settings }); setProfile(updated); setSaved(true); }
    catch (cause) { setSaveError(cause instanceof Error ? cause.message : 'Could not save settings.'); }
    finally { setBusy(false); }
  }
  function toggle(key:string) { setSettings(current => ({ ...current, [key]:!current[key] })); setSaved(false); }
  const jump = (id:string) => document.getElementById(id)?.scrollIntoView({ behavior:'smooth', block:'start' });
  return <div className="feature-page"><PageHeader eyebrow="MAKE ABHYAS YOURS" title="Settings" description="Manage your account, learning goals, and notification preferences."/>{error && <div className="form-error" role="alert">{error}</div>}{saveError && <div className="form-error" role="alert">{saveError}</div>}
    <div className="settings-layout"><div className="settings-nav"><button className="selected" onClick={()=>jump('settings-account')}><UserRound size={17}/> Account</button><button onClick={()=>jump('settings-notifications')}><span className="bell-emoji">♧</span> Notifications</button><button onClick={()=>jump('settings-privacy')}><Target size={17}/> Privacy</button><button onClick={()=>jump('settings-goals')}><Sparkles size={17}/> Learning goals</button></div><form className="settings-sections" onSubmit={save}>
      <Card className="settings-card" id="settings-account"><div className="settings-title"><div><h2>Account information</h2><p>Manage the details tied to your learning account.</p></div><span className="settings-section-icon"><UserRound size={17}/></span></div><label className="form-label">Full name<Input value={displayName} onChange={event=>setDisplayName(event.target.value)} maxLength={80}/></label><label className="form-label">Email address<Input type="email" value={user?.email || ''} disabled/></label><small>Email is managed by your Supabase sign-in provider.</small><label className="form-label">Username<Input value={username} onChange={event=>setUsername(event.target.value)} maxLength={40}/></label></Card>
      <Card className="settings-card" id="settings-notifications"><div className="settings-title"><div><h2>Notifications</h2><p>Save your notification preferences for this account.</p></div><span className="settings-section-icon"><span className="bell-emoji">♧</span></span></div>{[['daily_reminders','Daily learning reminders','A gentle nudge to keep your streak alive.'],['quest_updates','Quest updates','Know when daily challenges are ready.'],['room_invites','Study room invites','Get notified when friends invite you.'],['weekly_recap','Weekly progress recap','A snapshot of your learning every week.']].map(([key,title,description])=><Toggle key={key} title={title} description={description} enabled={Boolean(settings[key])} onChange={()=>toggle(key)}/>)}</Card>
      <Card className="settings-card" id="settings-privacy"><div className="settings-title"><div><h2>Privacy</h2><p>Choose what appears to other learners.</p></div><span className="settings-section-icon"><Target size={17}/></span></div><Toggle title="Show my XP on the leaderboard" description="Your display name and weekly XP are shown when enabled." enabled={profile?.show_on_leaderboard || false} onChange={()=>setProfile(current => current ? {...current,show_on_leaderboard:!current.show_on_leaderboard}:current)}/><Toggle title="Personalized learning suggestions" description="Save whether you want topic suggestions based on your history." enabled={Boolean(settings.personalized_suggestions)} onChange={()=>toggle('personalized_suggestions')}/></Card>
      <Card className="settings-card" id="settings-goals"><div className="settings-title"><div><h2>Learning goals</h2><p>Set the targets shown on your profile and dashboard.</p></div><span className="settings-section-icon"><Sparkles size={17}/></span></div><label className="form-label">Topics to explore<Input type="number" min="1" max="1000" value={goals.topics_goal} onChange={event=>setGoals(current=>({...current,topics_goal:Number(event.target.value)}))}/></label><label className="form-label">Monthly study minutes<Input type="number" min="1" max="100000" value={goals.monthly_minutes_goal} onChange={event=>setGoals(current=>({...current,monthly_minutes_goal:Number(event.target.value)}))}/></label></Card>
      <div className="settings-save-row"><Button type="submit" disabled={busy||loading}>{busy?'Saving...':'Save changes'}</Button>{saved&&<span className="saved-note" role="status">Settings saved to your account.</span>}</div>
      <Card className="settings-logout"><div><b>Ready to take a break?</b><span>You can always come back to your learning journey.</span></div><button type="button" className="logout-button" onClick={async()=>{await signOut();navigate('/login');}}>Log out</button></Card>
    </form></div>
  </div>;
}

export function Leaderboard() {
  const { session } = useAuth();
  const user = session?.user;
  const [tab,setTab]=useState('Weekly');
  const [subject,setSubject]=useState('');
  const [rows,setRows]=useState<Array<{user_id:string;display_name:string;username:string;total_xp:number;level:number;rank:number}>>([]);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  async function refresh() {
    setLoading(true); setError('');
    try { if (tab==='Friends') { setRows([]); return; } setRows(await getLeaderboard(tab==='Global'?'global':'weekly',tab==='By subject'?subject||null:null)); }
    catch (cause) { setError(cause instanceof Error ? `${cause.message}. Apply the learning progress and rooms migration.` : 'Could not load leaderboard.'); }
    finally { setLoading(false); }
  }
  useEffect(()=>{void refresh();},[tab,subject]);
  const displayRows=tab==='By subject'&&subject?rows:rows;
  const myRank=displayRows.find(row=>row.user_id===user?.id)?.rank;
  return <div className="feature-page"><PageHeader eyebrow="A LITTLE FRIENDLY COMPETITION" title="Leaderboard" description="Rankings use saved XP from learners who opted in." action={<div className="leader-period"><CalendarDays size={15}/> {tab==='Global'?'All time':'Last 7 days'}</div>}/>
    <div className="leader-filter-tabs">{['Weekly','Friends','Global','By subject'].map(item=><button className={tab===item?'selected':''} onClick={()=>setTab(item)} key={item}>{item}</button>)}</div>
    {tab==='By subject'&&<label className="leader-subject-filter">Filter by subject<Input placeholder="Enter exact subject" value={subject} onChange={event=>setSubject(event.target.value)}/></label>}
    {error&&<div className="form-error" role="alert">{error}</div>}
    {tab==='Friends'?<Card className="leader-table-card"><div className="history-empty"><UsersIcon/><b>Friend rankings are not available</b><span>Abhyas does not have a friend connection feature yet. Weekly and global rankings are available for learners who opt in.</span></div></Card>:<Card className="leader-table-card"><div className="leader-table-head"><div><div className="section-kicker">{tab.toUpperCase()} LEARNERS</div><h2>Keep showing up</h2></div></div>{loading?<p>Loading opted-in learners…</p>:displayRows.length?<><div className="leader-table"><div className="leader-table-labels"><span>RANK</span><span>LEARNER</span><span>LEVEL</span><span>XP EARNED</span></div>{displayRows.map(person=><div className={`leader-table-row ${person.user_id===user?.id?'you-row':''}`} key={person.user_id}><span className={`table-rank ${person.rank<=3?'top-rank':''}`}>{person.rank<=3?['🥇','🥈','🥉'][person.rank-1]:`#${person.rank}`}</span><div className="table-learner"><span className="avatar avatar-purple">{person.display_name.slice(0,2).toUpperCase()}</span><div><b>{person.display_name}</b>{person.user_id===user?.id&&<small>That’s you!</small>}</div></div><span className="table-level">Level {person.level}</span><strong>{person.total_xp.toLocaleString()} <small>XP</small></strong></div>)}</div>{myRank&&<div className="your-rank-note"><Sparkles size={17}/><span>Your current rank is <b>#{myRank}</b>.</span><span className="your-rank">#{myRank}</span></div>}</>:<div className="history-empty"><Trophy size={25}/><b>No opted-in learners have recorded XP yet</b><span>Complete learning activities and enable leaderboard sharing in Settings to appear here.</span><Link className="text-link" to="/settings">Open privacy settings <ArrowRight size={15}/></Link></div>}</Card>}
  </div>;
}

function Toggle({title,description,enabled,onChange}:{title:string;description:string;enabled:boolean;onChange:()=>void}) { return <div className="toggle-row"><div><b>{title}</b><small>{description}</small></div><button type="button" className={`toggle ${enabled?'enabled':''}`} role="switch" aria-checked={enabled} aria-label={title} onClick={onChange}><i/></button></div>; }
function UsersIcon(){return <span aria-hidden="true">👥</span>;}
function numberGoal(value:unknown,fallback:number) { const number=Number(value); return Number.isFinite(number)&&number>0?number:fallback; }
function formatDuration(minutes:number) { return `${Math.floor(minutes/60)}h ${minutes%60}m`; }
function category(type:string) { return type==='quiz_completed'?'Quiz':type==='reverse_lecture_completed'?'Reverse Lecture':type==='study_session_completed'||type==='room_joined'?'Study Together':type==='lecture_analyzed'||type==='lecture_session'?'Lecture':type==='syllabus_analyzed'?'Syllabus':'AI Tutor'; }
function color(type:string) { return type.includes('quiz')?'mint':type.includes('lecture')?'violet':type.includes('study')?'gold':'coral'; }
function icon(type:string) { return type.includes('quiz')?'✓':type.includes('lecture')?'◉':type.includes('study')?'⏱':'✦'; }
