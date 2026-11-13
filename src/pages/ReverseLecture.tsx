import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Check, ChevronRight, Clock3, Mic2, Play, Sparkles, Target } from 'lucide-react';
import { Button, Card, Input, PageHeader, ProgressBar, SectionTitle } from '../components/common/UI';
import { useAuth } from '../context/AuthContext';
import { getAssistantError, askAssistant } from '../services/ai';
import { recordLearningEvent } from '../services/progress';
import { supabase } from '../services/supabase';

type Evaluation = { score: number; feedback: string; strengths: string[]; gaps: string[]; next_steps: string[]; follow_up_question: string };
type SavedSession = { id: string; title: string; topic: string; explanation: string; evaluation: Evaluation; created_at: string };
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
    <div className="process-steps">{evaluationGuide.map(([number, title, description], index) => <div className="process-step" key={number}><span className={`process-num step-${index}`}>{number}</span><div><b>{title}</b><small>{description}</small></div>{index < 3 && <ArrowRight size={17}/>}</div>)}</div>
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
  </div>;
}
