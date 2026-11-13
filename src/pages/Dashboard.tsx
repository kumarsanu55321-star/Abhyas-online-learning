import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronRight, Clock3, Flame, Lightbulb, Play, Sparkles, Star, Target, Trophy, Zap, Brain, UsersRound, Compass, Mic2, CalendarDays } from 'lucide-react';
import { Button, Card, ProgressBar, SectionTitle } from '../components/common/UI';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ensureLearnerProfile, getLeaderboard, loadProgress, recordLearningEvent, type LearningEvent, type LearnerProfile } from '../services/progress';

const features = [{ title:'AI Learning Assistant', description:'Get personalized explanations and understand concepts faster.', icon:Brain, color:'violet', to:'/ai-tutor', action:'Ask anything' },{ title:'Study Together', description:'Learn with friends through synchronized lecture rooms.', icon:UsersRound, color:'mint', to:'/study-together', action:'Find a room' },{ title:'Syllabus Navigator AI', description:'Find videos that cover your syllabus.', icon:Compass, color:'coral', to:'/syllabus-navigator', action:'Explore topics' },{ title:'Reverse Lecture Mode', description:'Explain what you’ve learned and test your understanding.', icon:Mic2, color:'gold', to:'/reverse-lecture', action:'Start explaining' },{ title:'Leaderboard', description:'Compete with opted-in learners and level up.', icon:Trophy, color:'blue', to:'/leaderboard', action:'See rankings' }];
const todayUtc = () => new Date().toISOString().slice(0, 10);

export default function Dashboard() {
  const { session, preview } = useAuth();
  const user = session?.user;
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [events, setEvents] = useState<LearningEvent[]>([]);
  const [leaderboard, setLeaderboard] = useState<Array<{ user_id: string; display_name: string; total_xp: number; level: number }>>([]);
  const [error, setError] = useState('');
  const [focusStarted, setFocusStarted] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!user) return;
    try {
      await ensureLearnerProfile(user);
      const snapshot = await loadProgress(user.id);
      setProfile(snapshot.profile); setEvents(snapshot.events); setError('');
      setLeaderboard(await getLeaderboard('weekly'));
    } catch (cause) { setError(cause instanceof Error ? `${cause.message}. Apply the learning progress and rooms migration in Supabase.` : 'Could not load your learning progress.'); }
  }
  useEffect(() => { void refresh(); }, [user?.id]);
  useEffect(() => {
    if (focusStarted === null) return;
    const tick = () => setSeconds(Math.floor((Date.now() - focusStarted) / 1000));
    tick(); const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [focusStarted]);

  const currentEvents = useMemo(() => events.filter(item => item.created_at.slice(0, 10) === todayUtc()), [events]);
  const weekEvents = useMemo(() => events.filter(item => Date.now() - Date.parse(item.created_at) < 7 * 86400000), [events]);
  const totalXp = profile?.total_xp || 0;
  const level = Math.floor(totalXp / 500) + 1;
  const xpInLevel = totalXp % 500;
  const studySeconds = weekEvents.reduce((sum, item) => sum + item.duration_seconds, 0);
  const weekXp = weekEvents.reduce((sum, item) => sum + item.xp_points, 0);
  const topicCount = new Set(events.map(item => String(item.metadata?.topic || '')).filter(Boolean)).size;
  const quizDone = currentEvents.some(item => item.event_type === 'quiz_completed');
  const reverseDone = currentEvents.some(item => item.event_type === 'reverse_lecture_completed');
  const studyDone = currentEvents.some(item => item.event_type === 'study_session_completed' && item.duration_seconds >= 1800);
  const todayFocus = currentEvents.filter(item => item.event_type === 'study_session_completed').reduce((sum, item) => sum + item.duration_seconds, 0) + Math.max(0, focusStarted === null ? 0 : seconds);
  const recentTopics = [...new Map(events.filter(item => item.metadata?.topic).map(item => [String(item.metadata.topic), item])).values()].slice(0, 3);
  const weekBars = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(); date.setUTCDate(date.getUTCDate() - (6 - offset)); const key = date.toISOString().slice(0, 10);
    const minutes = weekEvents.filter(item => item.created_at.slice(0, 10) === key).reduce((sum, item) => sum + item.duration_seconds, 0) / 60;
    return { label: date.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }), height: Math.min(100, minutes * 2), minutes: Math.round(minutes) };
  });
  const startFocus = () => { if (focusStarted === null) { setSeconds(0); setFocusStarted(Date.now()); } else void stopFocus(); };
  async function stopFocus() {
    if (focusStarted === null || !user || busy) return;
    const duration = Math.max(0, Math.floor((Date.now() - focusStarted) / 1000));
    setFocusStarted(null); setSeconds(0); setBusy(true);
    try { await recordLearningEvent({ event_type: 'study_session_completed', title: 'Focused study session', detail: `${Math.floor(duration / 60)} minutes studied`, subject: null, duration_seconds: duration, idempotency_key: crypto.randomUUID(), metadata: {} }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the study session.'); }
    finally { setBusy(false); }
  }

  const greeting = profile?.display_name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Learner';
  return <div className="dashboard-page">
    <section className="welcome-banner"><div className="welcome-text"><div className="eyebrow"><CalendarDays size={14}/> {new Date().toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' })} <span className="eyebrow-spark">✦</span> YOUR DAY, YOUR PACE</div><h1>Hey, {greeting.split(' ')[0]}! <span className="wave">👋</span></h1><p>Ready to level up your learning today?</p><div className="welcome-tags"><span><Flame size={15}/> {profile?.current_streak || 0} day streak</span><span><Zap size={15}/> {500 - xpInLevel} XP to next level</span></div></div><div className="welcome-illustration"><div className="welcome-sun"/><div className="welcome-plant plant-left">🌱</div><div className="welcome-person">🧑‍🎓</div><div className="welcome-plant plant-right">📚</div><div className="welcome-float float-star">✦</div><div className="welcome-float float-idea">💡</div><div className="welcome-floor"/></div><div className="welcome-confetti confetti-a">✦</div><div className="welcome-confetti confetti-b">✧</div></section>
    {error && <div className="form-error" role="alert">{error}</div>}
    {preview && <div className="form-info">Preview mode does not save learning data. Sign in to track progress.</div>}
    <section className="stats-grid"><Stat title="Total XP" value={totalXp.toLocaleString()} detail={`+${weekXp.toLocaleString()} this week`} icon={<Zap size={19}/>} color="gold" progress={xpInLevel / 5} progressText={`${xpInLevel} / 500 XP`}/><Stat title="Learning streak" value={`${profile?.current_streak || 0} days`} detail={`Best: ${profile?.best_streak || 0} days`} icon={<Flame size={20}/>} color="coral"/><Stat title="Current level" value={`Level ${level}`} detail={`${500 - xpInLevel} XP to next level`} icon={<Star size={19}/>} color="purple" progress={xpInLevel / 5} progressText={`${xpInLevel} / 500 XP`}/><Stat title="Topics explored" value={`${topicCount} topics`} detail={`${currentEvents.length} activities today`} icon={<Target size={20}/>} color="mint"/></section>
    <div className="dashboard-columns"><div className="dashboard-main-col">
      <Card className="quests-card"><div className="card-head"><div><div className="section-kicker"><Sparkles size={15}/> YOUR DAILY CHALLENGES</div><SectionTitle title="Daily quests"/></div><span className="quest-reset">Resets at midnight UTC</span></div><div className="quest-list">
        <Quest done={quizDone} title="Complete one AI-generated quiz" xp={50} progress={quizDone ? 100 : 0} icon="🧠" to="/ai-tutor"/>
        <div className="quest-row"><div className={`quest-check ${studyDone ? 'checked' : ''}`}>{studyDone ? <Check size={16}/> : <span>⏱️</span>}</div><div className="quest-info"><b>Study for 30 minutes</b><div className="quest-progress-line"><ProgressBar value={Math.min(100, todayFocus / 18)} color="purple"/><small>{studyDone ? 'Completed' : `${Math.min(30, Math.floor(todayFocus / 60))}/30 min`}</small></div></div><Button variant="secondary" disabled={busy} onClick={startFocus}>{focusStarted === null ? 'Start focus' : `${formatTime(seconds)} · End session`}</Button></div>
        <Quest done={reverseDone} title="Explain a topic in Reverse Lecture" xp={75} progress={reverseDone ? 100 : 0} icon="🎙️" to="/reverse-lecture"/>
      </div><Link className="text-link quest-link" to="/history">View learning history <ArrowRight size={15}/></Link></Card>
      <div className="continue-section"><SectionTitle title="Continue learning" action={<Link className="text-link" to="/history">My learning <ArrowRight size={15}/></Link>}/><div className="course-grid">{recentTopics.length ? recentTopics.map(item => <Card className="course-card" key={String(item.metadata.topic)}><div className="course-visual violet"><span className="course-emoji">📘</span><span className="course-label">Recent topic</span><Link className="course-play" aria-label={`Continue ${item.metadata.topic}`} to="/ai-tutor"><Play size={17} fill="currentColor"/></Link></div><div className="course-body"><small className="course-subject">{item.event_type.replace(/_/g, ' ')}</small><h3>{String(item.metadata.topic)}</h3><div className="course-last"><Clock3 size={13}/>{new Date(item.created_at).toLocaleDateString()}</div><Link to="/ai-tutor" className="course-continue">Continue learning <ChevronRight size={15}/></Link></div></Card>) : <Card className="course-card"><div className="course-body"><h3>No learning sessions yet</h3><p>Complete a quiz or Reverse Lecture to build your learning history.</p><Link to="/ai-tutor" className="course-continue">Ask your first question <ChevronRight size={15}/></Link></div></Card>}</div></div>
      <div className="features-section"><SectionTitle title="Your learning toolkit" action={<span className="muted-note">Pick your next adventure ✨</span>}/><div className="feature-grid">{features.map(({title,description,icon:Icon,color,to,action})=><Link to={to} className={`feature-card feature-${color}`} key={title}><div className="feature-icon"><Icon size={21}/></div><h3>{title}</h3><p>{description}</p><span className="feature-cta">{action}<ArrowRight size={15}/></span><span className="feature-decoration">✦</span></Link>)}</div></div>
      <Card className="weekly-card"><div className="weekly-header"><div><div className="section-kicker">YOUR CONSISTENCY IS ADDING UP</div><SectionTitle title="Weekly learning progress"/></div><span>This week</span></div><div className="chart-area"><div className="chart-y-labels"><span>50m</span><span>35m</span><span>20m</span><span>0</span></div><div className="chart-content"><div className="chart-gridlines"><i/><i/><i/><i/></div><div className="chart-bars">{weekBars.map((bar,i)=><div className="chart-column" key={`${bar.label}-${i}`}><div className={`chart-bar ${i===6?'today':''}`} style={{height:`${bar.height}%`}} title={`${bar.minutes} minutes`}/><small>{bar.label}</small></div>)}</div></div></div><div className="weekly-summary"><div><span className="summary-dot purple-dot"/><b>{formatDuration(studySeconds)}</b><small>study time</small></div><div><span className="summary-dot mint-dot"/><b>{weekXp.toLocaleString()} XP</b><small>earned this week</small></div><div className="weekly-encourage">Based on your recorded learning activity <span>✦</span></div></div></Card>
    </div><aside className="dashboard-side-col"><Card className="leader-preview"><div className="side-card-head"><div><div className="section-kicker">FRIENDLY COMPETITION</div><h2>Weekly leaderboard</h2></div><div className="trophy-soft"><Trophy size={18}/></div></div>{leaderboard.length ? <div className="leader-list">{leaderboard.slice(0,5).map((person,i)=><div className={`leader-mini ${person.user_id===user?.id?'current-learner':''}`} key={person.user_id}><span className={`leader-rank rank-${i+1}`}>{i+1}</span><span className={`avatar avatar-${['coral','mint','gold','purple','blue'][i%5]}`}>{person.display_name.slice(0,2).toUpperCase()}</span><div className="leader-person"><b>{person.display_name}</b><small>Level {person.level}</small></div><strong>{person.total_xp.toLocaleString()} <small>XP</small></strong></div>)}</div> : <p className="chat-history-empty">No learners have opted into the leaderboard yet. You can enable sharing in your profile settings.</p>}<Link to="/leaderboard" className="leader-cta">View full leaderboard <ArrowRight size={15}/></Link></Card>
      <Card className="activity-card"><div className="side-card-head"><div><div className="section-kicker">LOOK AT YOU GO</div><h2>Recent activity</h2></div><Link to="/history" className="dots-button" aria-label="More activity">···</Link></div><div className="activity-list">{events.slice(0,3).map((activity,i)=><div className="activity-item" key={activity.id}><span className={`activity-icon activity-${eventColor(activity.event_type)}`}>{eventIcon(activity.event_type)}</span><div><b>{activity.title}</b><span>{activity.detail}</span><small>{new Date(activity.created_at).toLocaleString()}</small></div>{i<2&&<i className="activity-connector"/>}</div>)}{!events.length&&<p className="chat-history-empty">Learning activity will appear here after you finish a tool.</p>}</div><Link to="/history" className="activity-history">See all activity <ArrowRight size={15}/></Link></Card>
      <Card className="recommend-card"><div className="rec-heading"><div className="rec-icon"><Lightbulb size={18}/></div><div><div className="section-kicker">A LITTLE NUDGE</div><h2>Pick up where you left off</h2></div></div>{recentTopics.length ? recentTopics.slice(0,2).map(item=><Link to="/ai-tutor" className="recommend-item" key={String(item.metadata.topic)}><span>📚</span><div><b>{String(item.metadata.topic)}</b><small>Continue your last learning topic</small></div><ChevronRight size={17}/></Link>) : <Link to="/syllabus-navigator" className="recommend-item"><span>🧭</span><div><b>Map your syllabus</b><small>Find topics and learning videos</small></div><ChevronRight size={17}/></Link>}<Link to="/ai-tutor" className="refresh-rec"><Sparkles size={14}/> Ask the AI assistant</Link></Card><div className="motivation-note"><span>✦</span><p>Your progress grows with every session.</p><small>Keep learning, at your pace</small></div></aside></div>
  </div>;
}

function Quest({ done, title, xp, progress, icon, to }: { done:boolean; title:string; xp:number; progress:number; icon:string; to:string }) { return <div className={`quest-row ${done?'quest-done':''}`}><div className={`quest-check ${done?'checked':''}`}>{done?<Check size={16}/>:<span>{icon}</span>}</div><div className="quest-info"><b>{title}</b><div className="quest-progress-line"><ProgressBar value={progress} color={done?'mint':'purple'}/><small>{done?'Completed':'0%'}</small></div></div><span className="quest-xp">+{xp} <small>XP</small></span><Link className="quest-action" to={to} aria-label={`Open ${title}`}><ArrowRight size={15}/></Link></div>; }
function Stat({title,value,detail,icon,color,progress,progressText}:{title:string;value:string;detail:string;icon:React.ReactNode;color:string;progress?:number;progressText?:string}) { return <Card className="stat-card"><div className="stat-top"><span>{title}</span><span className={`stat-icon ${color}`}>{icon}</span></div><div className="stat-value">{value}</div><div className="stat-detail">{detail}</div>{progress!==undefined&&<div className="stat-progress"><ProgressBar value={progress} color={color}/><small>{progressText}</small></div>}</Card>; }
function formatTime(seconds:number) { return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`; }
function formatDuration(seconds:number) { return `${Math.floor(seconds/3600)}h ${Math.floor((seconds%3600)/60)}m`; }
function eventColor(type:string) { return type.includes('quiz')?'mint':type.includes('lecture')?'violet':type.includes('study')?'gold':'coral'; }
function eventIcon(type:string) { return type.includes('quiz')?'✓':type.includes('lecture')?'◉':type.includes('study')?'⏱':'✦'; }
