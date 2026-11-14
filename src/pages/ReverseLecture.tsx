import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Check, ChevronRight, Clock3, Copy, LoaderCircle, Mic2, Play, RotateCcw, Sparkles, Target, Video } from 'lucide-react';
import { Button, Card, Input, PageHeader, ProgressBar, SectionTitle } from '../components/common/UI';
import { useAuth } from '../context/AuthContext';
import { getAssistantError, askAssistant } from '../services/ai';
import { extractYouTubeId } from '../services/youtube';
import { YouTubePlayerFrame } from './AITutor';
import { recordLearningEvent } from '../services/progress';
import { supabase } from '../services/supabase';

type Evaluation = { score: number; feedback: string; strengths: string[]; gaps: string[]; next_steps: string[]; follow_up_question: string };
type SavedSession = { id: string; title: string; topic: string; explanation: string; evaluation: Evaluation; created_at: string };
type QuickRecap = { main_concepts: string[]; definitions: { term: string; definition: string }[]; key_takeaways: string[]; example: string; revision_checklist: string[] };
const evaluationGuide = [['01', 'Choose a topic', 'Pick what you have been learning.'], ['02', 'Explain it back', 'Write in your own words.'], ['03', 'Get feedback', 'Spot strengths and gaps.'], ['04', 'Level up', 'Build a learning plan.']];

export function ReverseLecture() {
  const { session, preview } = useAuth();
  const user = session?.user;
  const [topic, setTopic] = useState('');
  const [explanation, setExplanation] = useState('');
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [previous, setPrevious] = useState<SavedSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lectureUrl, setLectureUrl] = useState('');
  const [videoId, setVideoId] = useState('');
  const [videoError, setVideoError] = useState('');
  const [videoComplete, setVideoComplete] = useState(false);
  const [lectureContent, setLectureContent] = useState('');
  const [sourceNotice, setSourceNotice] = useState('Paste actual transcript text or lecture notes, or load a public video for Gemini to analyze directly. Captions are not retrieved by this integration.');
  const [recap, setRecap] = useState<QuickRecap | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  const [recapError, setRecapError] = useState('');
  const [recapNotice, setRecapNotice] = useState('');
  const currentStep = evaluation ? 3 : busy ? 2 : topic.trim() ? 1 : 0;

  useEffect(() => {
    if (!videoId || !user || !supabase) return;
    let active = true;
    setSourceNotice('Checking your saved lecture sessions for an available transcript…');
    void supabase.from('ai_lecture_sessions').select('transcript').eq('user_id', user.id).eq('video_id', videoId).order('created_at', { ascending: false }).limit(1).maybeSingle().then(({ data, error: loadError }) => {
      if (!active) return;
      if (loadError) { setSourceNotice('Could not load a saved transcript. Paste actual transcript text or notes below.'); return; }
      const savedTranscript = data?.transcript?.trim();
      if (savedTranscript) { setLectureContent(current => current.trim() ? current : savedTranscript); setSourceNotice('Loaded the transcript from your saved AI Learning Assistant lecture session.'); }
      else setSourceNotice('No saved transcript is available. Captions are not retrieved here; Gemini can analyze the actual public video directly, or you can paste its transcript or notes.');
    });
    return () => { active = false; };
  }, [videoId, user?.id]);

  function loadLecture(event: FormEvent) {
    event.preventDefault();
    const id = extractYouTubeId(lectureUrl);
    setVideoError(''); setRecapError(''); setRecapNotice(''); setVideoComplete(false);
    if (!id) { setVideoId(''); setVideoError('Enter a valid YouTube watch, youtu.be, Shorts, or playlist video link.'); return; }
    setVideoId(id); setLectureUrl(`https://www.youtube.com/watch?v=${id}`); setLectureContent(''); setRecap(null);
    setSourceNotice('Checking your saved lecture sessions for an available transcript…');
  }

  function handleVideoEnded() {
    setVideoComplete(true);
    setRecapNotice(lectureContent.trim() ? 'Lecture finished. Your transcript or notes are ready for a recap.' : 'Lecture finished. Generate a recap from Gemini’s direct analysis of the video, or paste transcript/notes. Captions were not retrieved.');
  }

  async function generateRecap() {
    if ((!lectureContent.trim() && !videoId) || recapBusy) return;
    setRecapBusy(true); setRecapError(''); setRecapNotice('');
    try {
      const fromText = Boolean(lectureContent.trim());
      const result = await askAssistant(
        [{ role: 'user', content: fromText ? 'Generate the requested 60-second quick recap from the supplied lecture text.' : 'Generate the requested 60-second quick recap from the actual video content.' }],
        'recap',
        lectureContent.trim() || undefined,
        fromText ? undefined : `https://www.youtube.com/watch?v=${videoId}`,
      );
      const parsed = JSON.parse(result.content) as QuickRecap;
      if (!Array.isArray(parsed.main_concepts) || !Array.isArray(parsed.definitions) || !Array.isArray(parsed.key_takeaways) || !Array.isArray(parsed.revision_checklist) || typeof parsed.example !== 'string') throw new Error('The AI returned an incomplete recap. Please try again.');
      setRecap(parsed);
      setRecapNotice(result.source === 'gemini_video' ? 'Recap generated by Gemini from direct analysis of the video. Captions were not retrieved.' : 'Recap generated from the supplied transcript or notes.');
    } catch (cause) {
      setRecapError(cause instanceof SyntaxError ? 'The AI returned an unreadable recap. Please try again.' : getAssistantError(cause));
    } finally { setRecapBusy(false); }
  }

  async function copyRecap() {
    if (!recap) return;
    try { await navigator.clipboard.writeText(formatRecap(recap)); setRecapNotice('Recap copied to clipboard.'); }
    catch { setRecapError('Could not access the clipboard. Select and copy the recap text instead.'); }
  }

  async function loadPrevious() {
    if (!supabase || !user) return;
    const { data: conversations, error: chatsError } = await supabase.from('ai_conversations').select('id,title,created_at').eq('user_id', user.id).ilike('title', 'Reverse Lecture:%').order('created_at', { ascending: false }).limit(20);
    if (chatsError) { setError(`Previous sessions could not be loaded: ${chatsError.message}`); return; }
    if (!conversations?.length) { setPrevious([]); return; }
    const { data: messages, error: messagesError } = await supabase.from('ai_messages').select('conversation_id,role,content').in('conversation_id', conversations.map(chat => chat.id)).order('created_at', { ascending: true });
    if (messagesError) { setError(`Previous sessions could not be loaded: ${messagesError.message}`); return; }
    const byId = new Map<string, typeof messages>();
    for (const message of messages || []) byId.set(message.conversation_id, [...(byId.get(message.conversation_id) || []), message]);
    setPrevious(conversations.flatMap(chat => {
      const entries = byId.get(chat.id) || [];
      const original = entries.find(item => item.role === 'user');
      const result = entries.find(item => item.role === 'assistant');
      if (!original || !result) return [];
      try {
        const request = JSON.parse(original.content) as { topic: string; explanation: string };
        const parsed = JSON.parse(result.content) as Evaluation;
        return [{ id: chat.id, title: chat.title, topic: request.topic, explanation: request.explanation, evaluation: parsed, created_at: chat.created_at }];
      } catch { return []; }
    }));
  }

  useEffect(() => { void loadPrevious(); }, [user?.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!topic.trim() || !explanation.trim() || busy) return;
    if (preview || !user) { setError('Sign in to get AI feedback and save your session.'); return; }
    setBusy(true); setError(''); setNotice(''); setEvaluation(null);
    const request = { topic: topic.trim(), explanation: explanation.trim() };
    try {
      const response = await askAssistant([{ role: 'user', content: JSON.stringify(request) }], 'reverse_lecture');
      const parsed = JSON.parse(response.content) as Evaluation;
      if (!Number.isFinite(parsed.score) || !parsed.feedback || !Array.isArray(parsed.strengths) || !Array.isArray(parsed.gaps) || !Array.isArray(parsed.next_steps)) throw new Error('The AI returned an incomplete evaluation. Please try again.');
      parsed.score = Math.max(0, Math.min(100, Math.round(parsed.score)));
      setEvaluation(parsed);
      const { data: conversation, error: conversationError } = await supabase!.from('ai_conversations').insert({ user_id: user.id, title: `Reverse Lecture: ${request.topic.slice(0, 55)}` }).select('id').single();
      if (conversationError || !conversation) throw new Error(conversationError?.message || 'Could not save this session.');
      const { error: saveError } = await supabase!.from('ai_messages').insert([
        { conversation_id: conversation.id, user_id: user.id, role: 'user', content: JSON.stringify(request) },
        { conversation_id: conversation.id, user_id: user.id, role: 'assistant', content: response.content },
      ]);
      if (saveError) throw new Error(saveError.message);
      await recordLearningEvent({ event_type: 'reverse_lecture_completed', title: `Explained ${request.topic}`, detail: `AI evaluation: ${parsed.score}/100`, subject: null, duration_seconds: 0, idempotency_key: conversation.id, metadata: { topic: request.topic, score: parsed.score } });
      setNotice('Session saved · +75 XP');
      await loadPrevious();
    } catch (cause) {
      setError(cause instanceof SyntaxError ? 'The AI returned an unreadable evaluation. Please try again.' : getAssistantError(cause));
    } finally { setBusy(false); }
  }

  function openSession(saved: SavedSession) { setTopic(saved.topic); setExplanation(saved.explanation); setEvaluation(saved.evaluation); setError(''); setNotice('Saved session'); }

  return <div className="feature-page">
    <PageHeader eyebrow="TEACH IT TO LEARN IT" title="Reverse Lecture" description="When you can explain it, you know it. Teach it back and grow your understanding."/>
    <div className="reverse-page-layout">
    <div className="reverse-main">
    <Card className="reverse-lecture-card">
      <div className="reverse-lecture-heading"><div className="reverse-lecture-icon"><Video size={18}/></div><div><div className="section-kicker">WATCH · RECAP · EXPLAIN</div><h2>Learn from a YouTube lecture</h2><p>Use an available transcript or let Gemini analyze the public video directly.</p></div></div>
      <form className="reverse-lecture-url" onSubmit={loadLecture}><Input aria-label="YouTube lecture URL" placeholder="Paste a YouTube lecture URL..." value={lectureUrl} onChange={event => setLectureUrl(event.target.value)}/><Button type="submit" variant="secondary"><Play size={15}/> Load Lecture</Button></form>
      {videoError && <div className="form-error" role="alert">{videoError}</div>}
      {videoId && <div className="reverse-lecture-player"><YouTubePlayerFrame videoId={videoId} onEnded={handleVideoEnded}/></div>}
      <div className="quick-recap-source"><label className="form-label" htmlFor="reverse-lecture-content">Lecture transcript or notes</label><p>{sourceNotice}</p><textarea id="reverse-lecture-content" className="field textarea-field" placeholder="Paste the actual lecture transcript or your notes here..." value={lectureContent} onChange={event => { setLectureContent(event.target.value); setRecapNotice(''); }} rows={5} maxLength={100000}/></div>
      <div className="quick-recap-actions"><Button onClick={() => void generateRecap()} disabled={(!lectureContent.trim() && !videoId) || recapBusy}>{recapBusy ? <><LoaderCircle className="assistant-spinner" size={16}/> Generating recap...</> : <><Sparkles size={16}/> Generate 60-Second Quick Recap</>}</Button><span className="recap-source-hint">{!lectureContent.trim() && !videoId ? 'Load a video or paste its actual transcript/notes to generate a recap.' : videoComplete ? 'Video playback finished. Gemini can analyze its content directly; captions were not retrieved.' : 'You may generate before the video finishes, or recap notes from a video watched elsewhere.'}</span></div>
      {recapError && <div className="form-error" role="alert">{recapError}</div>}{recapNotice && <div className="form-info" role="status">{recapNotice}</div>}
      {recap && <section className="quick-recap-result" aria-live="polite"><div className="quick-recap-result-head"><div><div className="section-kicker">ABOUT 60 SECONDS</div><h3>Quick recap</h3></div><div className="quick-recap-result-actions"><Button type="button" variant="secondary" onClick={() => void copyRecap()}><Copy size={14}/> Copy Recap</Button><Button type="button" variant="secondary" onClick={() => void generateRecap()} disabled={recapBusy}>{recapBusy ? <LoaderCircle className="assistant-spinner" size={15}/> : <RotateCcw size={14}/>} Regenerate</Button></div></div>
        {recap.main_concepts.length>0&&<div className="quick-recap-section"><b>Main concepts</b><ul>{recap.main_concepts.map((item,index)=><li key={index}>{item}</li>)}</ul></div>}
        {recap.definitions.length>0&&<div className="quick-recap-section"><b>Important definitions</b><dl>{recap.definitions.map((item,index)=><div key={index}><dt>{item.term}</dt><dd>{item.definition}</dd></div>)}</dl></div>}
        {recap.key_takeaways.length>0&&<div className="quick-recap-section"><b>Key takeaways</b><ul>{recap.key_takeaways.map((item,index)=><li key={index}>{item}</li>)}</ul></div>}
        {recap.example&&<div className="quick-recap-example"><b>Simple real-world example</b><p>{recap.example}</p></div>}
        {recap.revision_checklist.length>0&&<div className="quick-recap-section"><b>Revision checklist</b><ul className="recap-checklist">{recap.revision_checklist.map((item,index)=><li key={index}><Check size={14}/>{item}</li>)}</ul></div>}
      </section>}
    </Card>
    <div className="reverse-layout">
      <Card className="reverse-session">
        <div className="session-title"><div className="session-mic"><Mic2 size={20}/></div><div><h2>{evaluation ? 'Your teaching session' : 'Start a new session'}</h2><span>Explain the idea in your own words</span></div><span className="session-duration"><Clock3 size={15}/> AI evaluated</span></div>
        <form onSubmit={submit}>
          <label className="form-label">What would you like to explain?<div className="field-wrap"><Input placeholder="e.g. How binary search trees work" value={topic} onChange={event => setTopic(event.target.value)} maxLength={160}/></div></label>
          <div className="session-mode-grid"><div className="session-mode"><Mic2 size={19}/><b>Speak it out</b><small>Voice input is not enabled in this browser yet</small><span>TYPE BELOW</span></div><div className="session-mode selected"><BookOpen size={19}/><b>Write it out</b><small>Type what you understand</small></div></div>
          <label className="form-label write-explanation">Your explanation<textarea className="field textarea-field" placeholder="Explain the concept in your own words. Include how it works and an example..." value={explanation} onChange={event => setExplanation(event.target.value)} rows={7} maxLength={12000}/></label>
          <Button type="submit" disabled={!topic.trim() || !explanation.trim() || busy}>{busy ? <><span className="spinner"/> Evaluating with Gemini...</> : <><Play size={16} fill="currentColor"/> Get AI feedback <ArrowRight size={16}/></>}</Button>
        </form>
        {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="form-info" role="status">{notice}</div>}
      </Card>
      <Card className="feedback-card"><div className="feedback-header"><div className="feedback-orb"><Sparkles size={18}/></div><div><h2>AI feedback</h2><span>{evaluation ? 'Based on the explanation you submitted' : 'Your personalized insights will show up here'}</span></div></div>
        {evaluation ? <div className="reverse-evaluation"><div className="reverse-score"><b>{evaluation.score}</b><span>/100 · understanding</span><ProgressBar value={evaluation.score}/></div><p>{evaluation.feedback}</p><h3><Check size={15}/> What you know</h3><ul>{evaluation.strengths.map((item, index) => <li key={index}>{item}</li>)}</ul><h3><Target size={15}/> Areas to grow</h3><ul>{evaluation.gaps.map((item, index) => <li key={index}>{item}</li>)}</ul><h3><Sparkles size={15}/> Next steps</h3><ul>{evaluation.next_steps.map((item, index) => <li key={index}>{item}</li>)}</ul>{evaluation.follow_up_question && <div className="form-info">Try this next: {evaluation.follow_up_question}</div>}</div> : <div className="feedback-empty"><div className="feedback-illustration"><span>💡</span><i>✧</i></div><b>Ready when you are</b><p>Write an explanation and Gemini will identify accurate strengths, gaps, and next steps.</p></div>}
        <div className="feedback-pillars"><span><Check size={14}/> What you know</span><span><Target size={14}/> Areas to grow</span><span><Sparkles size={14}/> Next steps</span></div>
      </Card>
    </div>
    <div className="previous-sessions"><SectionTitle title="Previous sessions"/><div className="previous-list">{previous.length ? previous.map(saved => <button className="previous-row previous-row-button" key={saved.id} onClick={() => openSession(saved)}><span className="activity-icon activity-mint">◉</span><span><b>{saved.topic}</b><small>{new Date(saved.created_at).toLocaleString()}</small></span><span className="understanding mint">{saved.evaluation.score}/100</span><ChevronRight size={17}/></button>) : <Card><p>{user ? 'Your saved Reverse Lecture sessions will appear here.' : 'Sign in to save and revisit Reverse Lecture sessions.'}</p></Card>}</div></div>
    </div>
    <aside className="learning-journey card" aria-label="Reverse Lecture learning journey"><div className="section-kicker">YOUR LEARNING JOURNEY</div><h2>Small steps, stronger recall</h2><ol>{evaluationGuide.map(([number,title,description],index)=><li className={`journey-step ${index<currentStep?'is-complete':index===currentStep?'is-current':'is-upcoming'}`} key={number} aria-current={index===currentStep?'step':undefined}><span className="journey-step-number">{index<currentStep?<Check size={14}/>:number}</span><div><b>{title}</b><small>{description}</small></div></li>)}</ol></aside>
    </div>
  </div>;
}

function formatRecap(recap: QuickRecap) {
  return [
    '60-Second Quick Recap',
    'Main concepts', ...recap.main_concepts.map(item => `• ${item}`),
    'Important definitions', ...recap.definitions.map(item => `• ${item.term}: ${item.definition}`),
    'Key takeaways', ...recap.key_takeaways.map(item => `• ${item}`),
    'Simple real-world example', recap.example,
    'Revision checklist', ...recap.revision_checklist.map(item => `□ ${item}`),
  ].join('\n');
}
