import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, Brain, ChevronDown, Home, History, Menu, Search, Settings, Trophy, UserRound, UsersRound, X, Bell, LogOut, Sparkles, Mic2, Compass } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../services/supabase';
import type { LearningEvent, LearnerProfile } from '../../services/progress';
import { Link } from 'react-router-dom';

const primary = [
  { to: '/dashboard', label: 'Dashboard', icon: Home },
  { to: '/ai-tutor', label: 'AI Learning Assistant', icon: Brain },
  { to: '/study-together', label: 'Study Together', icon: UsersRound },
  { to: '/friends', label: 'Friends', icon: UserRound },
  { to: '/syllabus-navigator', label: 'Syllabus Navigator', icon: Compass },
  { to: '/reverse-lecture', label: 'Reverse Lecture', icon: Mic2 },
  { to: '/leaderboard', label: 'Leaderboard', icon: Trophy },
];
const secondary = [{ to: '/history', label: 'Learning History', icon: History }, { to: '/profile', label: 'My Profile', icon: UserRound }, { to: '/settings', label: 'Settings', icon: Settings }];
export default function AppLayout() {
  const { session, signOut } = useAuth();
  const user = session?.user;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notice, setNotice] = useState(false);
  const [search, setSearch] = useState('');
  const [profile, setProfile] = useState<Pick<LearnerProfile, 'display_name'|'total_xp'|'current_streak'> | null>(null);
  const [events, setEvents] = useState<LearningEvent[]>([]);
  const [noticeError, setNoticeError] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    if (!supabase || !user) { setProfile(null); return; }
    void supabase.from('learner_profiles').select('display_name,total_xp,current_streak').eq('user_id',user.id).maybeSingle().then(({data})=>setProfile(data));
  },[user?.id]);
  useEffect(() => {
    if (!notice || !supabase || !user) return;
    void supabase.from('learning_events').select('*').eq('user_id',user.id).order('created_at',{ascending:false}).limit(5).then(({data,error})=>{setEvents((data||[]) as LearningEvent[]);setNoticeError(error? 'Apply the learning progress and rooms migration to view activity notifications.':'');});
  },[notice,user?.id]);
  const nav = (items: typeof primary) => items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><Icon size={18} strokeWidth={1.8}/><span>{label}</span></NavLink>);
  const doLogout = async () => { await signOut(); navigate('/login'); };
  const submitSearch = (event: FormEvent) => { event.preventDefault(); if (!search.trim()) return; navigate(`/ai-tutor?prompt=${encodeURIComponent(search.trim())}`); setSearch(''); };
  const name = profile?.display_name || String(user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Learner');
  const initials = name.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
  const xp = profile?.total_xp || 0;
  const level = Math.floor(xp/500)+1;
  return <div className="app-shell"><aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}><div className="brand"><span className="brand-mark"><BookOpen size={21}/></span><span>Abhyas</span><button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X/></button></div><div className="sidebar-label">YOUR LEARNING</div><nav>{nav(primary)}</nav><div className="sidebar-label bottom-label">YOUR SPACE</div><nav>{nav(secondary)}</nav><div className="sidebar-spacer"/><div className="sidebar-promo"><div className="promo-icon"><Sparkles size={17}/></div><b>Keep your streak alive!</b><span>One more learning session today?</span><div className="mini-streak">🔥 &nbsp;{profile?.current_streak||0} day streak</div></div><button className="nav-link logout-link" onClick={doLogout}><LogOut size={18}/><span>Log out</span></button><div className="sidebar-foot">Made for curious minds <span>✦</span></div></aside>
  {mobileOpen && <button className="drawer-backdrop" onClick={() => setMobileOpen(false)} aria-label="Close navigation"/>}<main className="main-area"><header className="topbar"><button className="hamburger" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu/></button><form className="search-box" role="search" onSubmit={submitSearch}><Search size={18}/><input placeholder="Search topics, lessons..." aria-label="Search topics" value={search} onChange={event=>setSearch(event.target.value)}/><kbd>Enter</kbd></form><div className="topbar-actions"><button className={`icon-button notification ${notice ? 'has-notice' : ''}`} aria-label="Recent learning activity" aria-expanded={notice} onClick={() => setNotice(!notice)}><Bell size={19}/></button><div className="top-xp"><span>⚡</span><b>{xp.toLocaleString()}</b><small>XP</small></div><div className="level-pill">Lvl {level}</div><div className="profile-wrap"><button className="profile-trigger" onClick={() => setProfileOpen(!profileOpen)}><span className="avatar avatar-purple">{initials}</span><span className="profile-name">{name}</span><ChevronDown size={15}/></button>{profileOpen && <div className="profile-menu"><button onClick={() => {navigate('/profile');setProfileOpen(false)}}><UserRound size={16}/>My Profile</button><button onClick={() => {navigate('/settings');setProfileOpen(false)}}><Settings size={16}/>Settings</button><button onClick={doLogout}><LogOut size={16}/>Log out</button></div>}</div></div></header>
  {notice && <div className="notice-pop"><b>Recent learning activity</b>{noticeError?<span>{noticeError}</span>:events.length?events.map(item=><Link key={item.id} to="/history" onClick={()=>setNotice(false)}><span>{item.title}</span><small>{new Date(item.created_at).toLocaleString()}</small></Link>):<span>No saved learning activity yet.</span>}<Link to="/history" onClick={()=>setNotice(false)}>Open learning history</Link></div>}
  <div className="page-content"><Outlet/></div></main></div>;
}
