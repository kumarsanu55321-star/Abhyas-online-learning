import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Brain, BookOpen, Check, ChevronRight, Copy, LoaderCircle, MessageCircle, Play, Plus, Send, Sparkles, Video } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../services/supabase';
import { askAssistant, getAssistantError, type AssistantMessage, type AssistantMode } from '../services/ai';
import { extractYouTubeId, loadYouTubePlayerApi, type YouTubePlayer } from '../services/youtube';
import { recordLearningEvent } from '../services/progress';
import { Button, Card, Input, PageHeader } from '../components/common/UI';

type Conversation = { id: string; title: string; updated_at: string };
type SavedMessage = AssistantMessage & { id: string; created_at: string };
type QuizQuestion = { question: string; options: string[]; answer: number; explanation: string };
type LectureMaterials = { summary: string; topics: { name: string; timestamp?: string }[]; notes: string; flashcards: { question: string; answer: string }[]; quiz: { questions: QuizQuestion[] } };
type LectureSession = { id: string; video_id: string; video_url: string; transcript: string; materials: LectureMaterials; created_at: string };

export function YouTubePlayerFrame({ videoId, onEnded }: { videoId: string; onEnded?: () => void }) {
  const element = useRef<HTMLIFrameElement>(null);
  const player = useRef<YouTubePlayer | null>(null);
  const [error, setError] = useState<{ message: string; watch: boolean } | null>(null);
  useEffect(() => {
    let mounted = true;
    setError(null);
    loadYouTubePlayerApi().then(() => {
      if (mounted && element.current && window.YT?.Player) {
        player.current = new window.YT.Player(element.current, {
          events: {
            onReady: event => { event.target.getIframe().referrerPolicy = 'strict-origin-when-cross-origin'; },
            onStateChange: event => { if (event.data === 0) onEnded?.(); },
            onError: event => {
              const message = event.data === 101 || event.data === 150
                ? 'The video owner has disabled embedded playback.'
                : event.data === 100
                  ? 'This video is unavailable or private.'
                  : event.data === 153
                    ? 'YouTube could not identify the embedding app. Check the app origin and referrer settings.'
                    : event.data === 2
                      ? 'This YouTube video URL is invalid.'
                      : 'YouTube could not play this video in the embedded player.';
              setError({ message, watch: event.data !== 2 });
            },
          },
        });
      }
    }).catch(() => setError({ message: 'The YouTube player could not be loaded. Check your connection and try again.', watch: true }));
    return () => { mounted = false; player.current?.destroy(); player.current = null; };
  }, [videoId]);
  return <><div className="youtube-player-frame"><iframe ref={element} src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1&playsinline=1&origin=${encodeURIComponent(window.location.origin)}`} title="YouTube lecture player" referrerPolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen/></div>{error && <div className="youtube-player-error" role="alert"><span>{error.message}</span>{error.watch && <a href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">Watch on YouTube <ChevronRight size={13}/></a>}</div>}</>;
}

function Quiz({ questions, messageId }: { questions: QuizQuestion[]; messageId: string }) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [progressNotice, setProgressNotice] = useState('');
  const done = Object.keys(answers).length === questions.length;
  const score = questions.reduce((total, question, index) => total + (answers[index] === question.answer ? 1 : 0), 0);
  function answer(index: number, option: number) {
    if (answers[index] !== undefined) return;
    const next = { ...answers, [index]: option };
    setAnswers(next);
    if (Object.keys(next).length === questions.length) {
      const correct = questions.reduce((total, question, questionIndex) => total + (next[questionIndex] === question.answer ? 1 : 0), 0);
      void recordLearningEvent({ event_type: 'quiz_completed', title: 'Completed practice quiz', detail: `${correct}/${questions.length} correct`, subject: null, duration_seconds: 0, idempotency_key: `quiz:${messageId}`, metadata: {} })
        .then(() => setProgressNotice('Progress saved · +50 XP'))
        .catch(() => setProgressNotice('Quiz completed. Sign in and apply the learning progress migration to save XP.'));
    }
  }
  return <div className="ai-quiz" data-quiz={messageId}>
    {questions.map((question, index) => <div className="ai-quiz-question" key={`${messageId}-${index}`}>
      <b>{index + 1}. {question.question}</b>
      {question.options.map((option, optionIndex) => <button key={optionIndex} disabled={answers[index] !== undefined} className={answers[index] === optionIndex ? (optionIndex === question.answer ? 'correct' : 'incorrect') : answers[index] !== undefined && optionIndex === question.answer ? 'correct' : ''} onClick={() => answer(index, optionIndex)}>{option}</button>)}
      {answers[index] !== undefined && <small>{answers[index] === question.answer ? 'Correct. ' : 'Not quite. '}{question.explanation}</small>}
    </div>)}
    {done && <><strong className="ai-quiz-score">Score: {score}/{questions.length}</strong>{progressNotice && <small role="status">{progressNotice}</small>}</>}
  </div>;
}

function AssistantContent({ message, id }: { message: string; id: string }) {
  try {
    const parsed = JSON.parse(message);
    if (Array.isArray(parsed?.flashcards)) return <Flashcards cards={parsed.flashcards} id={id}/>;
    if (Array.isArray(parsed?.questions)) return <Quiz questions={parsed.questions} messageId={id}/>;
  } catch { /* Regular assistant text */ }
  return <p className="ai-answer-text">{message}</p>;
}

function Flashcards({ cards, id }: { cards: { question: string; answer: string }[]; id: string }) {
  const [index, setIndex] = useState(0);
  const card = cards[index];
  return <div className="ai-flashcards">
    <details key={`${id}-${index}`}><summary>{card.question}</summary><p>{card.answer}</p></details>
    <div className="assistant-flashcard-navigation"><button className="button button-secondary" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous</button><span>{index + 1} / {cards.length}</span><button className="button button-secondary" disabled={index === cards.length - 1} onClick={() => setIndex(index + 1)}>Next</button></div>
  </div>;
}

function LectureResult({ materials, videoId }: { materials: LectureMaterials; videoId: string }) {
  return <div className="lecture-result">
    <h3>Lecture summary</h3><p>{materials.summary}</p>
    {materials.topics?.length > 0 && <><h3>Key topics</h3><ul>{materials.topics.map((topic, index) => { const seconds = topic.timestamp?.split(':').reduce((total, part) => total * 60 + Number(part), 0); return <li key={`${topic.name}-${index}`}>{seconds !== undefined && Number.isFinite(seconds) ? <a href={`https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`} target="_blank" rel="noreferrer">{topic.timestamp}</a> : null} {topic.name}</li>; })}</ul></>}
    <details><summary>Revision notes</summary><p>{materials.notes}</p></details>
    {materials.flashcards?.length > 0 && <><h3>Flashcards</h3><div className="ai-flashcards">{materials.flashcards.map((card, index) => <details key={index}><summary>{card.question}</summary><p>{card.answer}</p></details>)}</div></>}
    {materials.quiz?.questions?.length > 0 && <><h3>Practice quiz</h3><Quiz questions={materials.quiz.questions} messageId={`lecture-quiz-${videoId}`}/></>}
  </div>;
}

export function AITutor() {
  const { session } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const userId = session?.user.id;
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<SavedMessage[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingTool, setPendingTool] = useState<AssistantMode | null>(null);
  const [toolTopic, setToolTopic] = useState('');
  const [lectureUrl, setLectureUrl] = useState('');
  const [videoId, setVideoId] = useState('');
  const [transcript, setTranscript] = useState('');
  const [lectureBusy, setLectureBusy] = useState(false);
  const [lectureError, setLectureError] = useState('');
  const [lectureMaterials, setLectureMaterials] = useState<LectureMaterials | null>(null);
  const [lectureSessions, setLectureSessions] = useState<LectureSession[]>([]);

  useEffect(() => {
    const searchPrompt = searchParams.get('prompt');
    if (searchPrompt) { setPrompt(searchPrompt); setSearchParams({}, { replace: true }); }
  }, [searchParams, setSearchParams]);

  async function loadHistory() {
    if (!supabase || !userId) return;
    const [{ data: chats, error: chatsError }, { data: lectures, error: lecturesError }] = await Promise.all([
      supabase.from('ai_conversations').select('id,title,updated_at').eq('user_id', userId).order('updated_at', { ascending: false }),
      supabase.from('ai_lecture_sessions').select('id,video_id,video_url,transcript,materials,created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    ]);
    if (chatsError || lecturesError) { setError(`Could not load saved learning history: ${(chatsError || lecturesError)?.message}. Check that the AI learning migration is applied.`); return; }
    setConversations((chats || []) as Conversation[]);
    setLectureSessions((lectures || []) as LectureSession[]);
  }

  useEffect(() => { void loadHistory(); }, [userId]);

  async function openConversation(id: string) {
    if (!supabase) return;
    setPendingTool(null);
    setError(''); setConversationId(id); setLectureMaterials(null); setVideoId(''); setTranscript(''); setLectureUrl('');
    const { data, error: loadError } = await supabase.from('ai_messages').select('id,role,content,created_at').eq('conversation_id', id).order('created_at', { ascending: true });
    if (loadError) { setError(`Could not load this conversation: ${loadError.message}. Check that the AI learning migration is applied.`); return; }
    setMessages((data || []) as SavedMessage[]);
  }

  function newConversation() { setConversationId(null); setMessages([]); setPrompt(''); setError(''); setPendingTool(null); setToolTopic(''); setLectureMaterials(null); setLectureUrl(''); setVideoId(''); setTranscript(''); setLectureError(''); }

  async function saveMessage(id: string, role: AssistantMessage['role'], content: string) {
    if (!supabase || !userId) throw new Error('Sign in with your Abhyas account to save conversations.');
    const { data, error: saveError } = await supabase.from('ai_messages').insert({ conversation_id: id, user_id: userId, role, content }).select('id,role,content,created_at').single();
    if (saveError) throw new Error(saveError.message);
    return data as SavedMessage;
  }

  async function sendMessage(text = prompt, mode: AssistantMode = 'chat') {
    const content = text.trim();
    if (!content || busy) return;
    setError(''); setBusy(true); setPrompt('');
    try {
      if (!supabase || !userId) throw new Error('Sign in with your Abhyas account to save conversations and use the AI assistant.');
      let id = conversationId;
      const localUserMessage: SavedMessage = { id: crypto.randomUUID(), role: 'user', content, created_at: new Date().toISOString() };
      let nextMessages = [...messages, localUserMessage];
      setMessages(nextMessages);
      let historyError = '';
      try {
        if (!id) {
          const { data, error: createError } = await supabase.from('ai_conversations').insert({ user_id: userId, title: content.slice(0, 70) }).select('id').single();
          if (createError || !data) throw new Error(createError?.message || 'Conversation was not created.');
          id = data.id; setConversationId(id);
        }
        if (!id) throw new Error('Conversation was not created.');
        const savedUserMessage = await saveMessage(id, 'user', content);
        nextMessages = [...messages, savedUserMessage];
        setMessages(nextMessages);
        const { error: updateError } = await supabase.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', id);
        if (updateError) throw new Error(updateError.message);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Database request failed.';
        historyError = `Your answer can still be generated, but chat history could not be saved: ${detail}. Check that the AI learning migration and policies are applied.`;
      }
      const lectureContext = transcript.trim() || (lectureMaterials ? JSON.stringify(lectureMaterials) : '');
      const result = await askAssistant(nextMessages.map(({ role, content: body }) => ({ role, content: body })), mode, lectureContext || undefined);
      let assistantMessage: SavedMessage = { id: crypto.randomUUID(), role: 'assistant', content: result.content, created_at: new Date().toISOString() };
      if (id && !historyError) {
        try { assistantMessage = await saveMessage(id, 'assistant', result.content); }
        catch (cause) {
          const detail = cause instanceof Error ? cause.message : 'Database request failed.';
          historyError = `Your answer was generated, but chat history could not be saved: ${detail}. Check that the AI learning migration and policies are applied.`;
        }
      }
      setMessages(current => [...current, assistantMessage]);
      if (id && !historyError) await loadHistory();
      if (historyError) setError(historyError);
    } catch (cause) { setError(getAssistantError(cause)); }
    finally { setBusy(false); }
  }

  async function runTool(mode: AssistantMode, topic = '') {
    const hasLectureContext = Boolean(transcript.trim() || lectureMaterials);
    if (!topic.trim() && !messages.length && !hasLectureContext) {
      setPendingTool(mode); setToolTopic(''); setError(''); return;
    }
    setPendingTool(null);
    const task = mode === 'summary' ? 'Summarize' : mode === 'notes' ? 'Create structured revision notes for' : mode === 'flashcards' ? 'Create interactive question-and-answer flashcards for' : 'Create exactly 5 practice MCQs for';
    const request = topic.trim()
      ? `${task} the topic "${topic.trim()}". Keep the explanation simple and accurate${mode === 'notes' ? ', with definitions, key points, and examples' : ''}.`
      : mode === 'summary' ? 'Summarize our conversation and current lesson.' : mode === 'notes' ? 'Create structured revision notes from our conversation and current lesson, with definitions, key points, and examples.' : mode === 'flashcards' ? 'Create interactive question-and-answer flashcards from our conversation and current lesson.' : 'Create exactly 5 practice MCQs from our conversation and current lesson.';
    await sendMessage(request, mode);
  }

  async function loadLecture(event: FormEvent) {
    event.preventDefault(); setLectureError(''); setLectureMaterials(null);
    const id = extractYouTubeId(lectureUrl);
    if (!id) { setLectureError('Enter a valid YouTube lecture link.'); return; }
    setVideoId(id); setTranscript('');
    void analyzeLecture(`https://www.youtube.com/watch?v=${id}`, id);
  }

  async function analyzeLecture(videoUrl?: string, targetVideoId = videoId) {
    if (!targetVideoId || (!videoUrl && !transcript.trim()) || lectureBusy) return;
    setLectureBusy(true); setLectureError(''); setError('');
    try {
      const lectureTranscript = transcript.trim();
      const result = await askAssistant(
        [{ role: 'user', content: videoUrl ? 'Analyze this public YouTube lecture video and prepare study materials.' : 'Analyze this lecture transcript and prepare study materials.' }],
        'lecture',
        lectureTranscript || undefined,
        videoUrl,
      );
      const materials = JSON.parse(result.content) as LectureMaterials;
      setLectureMaterials(materials);
      setLectureError(videoUrl ? 'Gemini analyzed the public video directly. Captions were not retrieved.' : 'Analysis is based on the transcript you provided.');
      if (supabase && userId) {
        const { data: savedSession, error: saveError } = await supabase.from('ai_lecture_sessions').insert({ user_id: userId, video_id: targetVideoId, video_url: `https://www.youtube.com/watch?v=${targetVideoId}`, transcript: lectureTranscript, materials }).select('id').single();
        if (saveError) throw new Error('Lecture analyzed, but it could not be saved. Apply the AI learning database migration and try again.');
        try { await recordLearningEvent({ event_type:'lecture_analyzed', title:'Analyzed YouTube lecture', detail:lectureTranscript ? 'Based on the supplied transcript' : 'Analyzed directly by Gemini', subject:null, duration_seconds:0, idempotency_key:`lecture:${savedSession.id}`, metadata:{ video_id:targetVideoId } }); }
        catch { setLectureError('Lecture materials were saved, but progress could not be saved. Apply the learning progress and rooms migration.'); }
        await loadHistory();
      }
    } catch (cause) { setLectureError(cause instanceof SyntaxError ? 'The AI returned an unreadable lecture analysis. Please try again.' : getAssistantError(cause)); }
    finally { setLectureBusy(false); }
  }

  function openLecture(lecture: LectureSession) {
    setVideoId(lecture.video_id); setLectureUrl(lecture.video_url); setTranscript(lecture.transcript); setLectureMaterials(lecture.materials); setLectureError(lecture.transcript ? 'Analysis is based on the transcript you provided.' : 'This session was analyzed directly by Gemini from the video. Captions were not retrieved.');
  }

  const quickPrompts = ['Explain this in simple terms', 'Give me a real-world analogy', 'Create a quiz for this topic', 'Summarize our conversation'];
  return <div className="feature-page tutor-page">
    <PageHeader eyebrow="YOUR PERSONAL STUDY BUDDY" title="AI Learning Assistant" description="Big questions, small steps. Let’s figure it out together." action={<Button variant="secondary" onClick={newConversation}><Plus size={17}/> New chat</Button>}/>
    <div className="tutor-layout">
      <Card className="chat-sidebar">
        <Button className="new-chat" onClick={newConversation}><Plus size={17}/> New conversation</Button>
        <div className="chat-history-label">RECENT CHATS</div>
        {conversations.length ? conversations.map(chat => <button className={`chat-history-item ${conversationId === chat.id ? 'selected' : ''}`} key={chat.id} onClick={() => void openConversation(chat.id)}><MessageCircle size={16}/>{chat.title}<span>{new Date(chat.updated_at).toLocaleDateString()}</span></button>) : <p className="chat-history-empty">Your saved conversations will appear here.</p>}
        <div className="chat-history-label">LECTURE SESSIONS</div>
        {lectureSessions.map(lecture => <button className="chat-history-item" key={lecture.id} onClick={() => openLecture(lecture)}><Video size={15}/>{lecture.materials?.summary?.slice(0, 25) || 'YouTube lecture'}<ChevronRight size={13}/></button>)}
        <div className="chat-sidebar-footer"><div className="ai-orb"><Sparkles size={17}/></div><b>Learn at your own pace</b><span>Your learning buddy is always here when you need a hand.</span></div>
      </Card>
      <Card className="chat-window">
        <div className="chat-window-top"><div className="ai-avatar"><Brain size={19}/></div><div><b>Abhyas Learning Buddy</b><span><i/> Here to help you learn</span></div><button className="dots-button" aria-label="New conversation" onClick={newConversation}>···</button></div>
        <div className="lecture-panel">
          <form className="lecture-url-form" onSubmit={loadLecture}><Video size={16}/><Input aria-label="YouTube lecture URL" placeholder="Paste YouTube Lecture URL" value={lectureUrl} onChange={event => setLectureUrl(event.target.value)}/><Button type="submit" variant="secondary"><Play size={15}/> Load lecture</Button></form>
          {videoId && <div className="lecture-workspace"><YouTubePlayerFrame videoId={videoId}/><div className="transcript-prompt"><b>Lecture transcript</b><span>Gemini analyzes public YouTube videos directly when supported. If the video can’t be analyzed, paste its actual transcript here; add times like [02:14] when available.</span><textarea className="field textarea-field" placeholder="Paste lecture transcript here..." value={transcript} onChange={event => setTranscript(event.target.value)}/><Button onClick={() => void analyzeLecture()} disabled={lectureBusy || !transcript.trim()}>{lectureBusy ? <><LoaderCircle className="assistant-spinner" size={16}/> Analyzing transcript</> : <><Sparkles size={16}/> Analyze transcript</>}</Button></div></div>}
          {lectureError && <div className="form-info lecture-notice" role="status">{lectureError}</div>}
          {lectureMaterials && <LectureResult materials={lectureMaterials} videoId={videoId}/>}
        </div>
        <div className="chat-messages" aria-live="polite">
          {!messages.length && !busy ? <div className="chat-empty"><div className="empty-orbit"><div className="empty-brain"><Brain size={33}/></div><span>✦</span><i>✧</i></div><h2>What are we learning?</h2><p>Ask me anything in English, Hindi, or Hinglish.</p></div> : messages.map(message => <div className={`chat-message ${message.role === 'user' ? 'user-message' : 'ai-message'}`} key={message.id}><span className={message.role === 'user' ? 'avatar avatar-purple' : 'ai-avatar'}>{message.role === 'user' ? 'You' : <Sparkles size={17}/>}</span><div className="chat-message-body">{message.role === 'assistant' ? <AssistantContent message={message.content} id={message.id}/> : <p>{message.content}</p>}{message.role === 'assistant' && <button className="copy-button" onClick={() => void navigator.clipboard?.writeText(message.content)}><Copy size={13}/> Copy</button>}</div></div>)}
          {busy && <div className="chat-loading"><LoaderCircle className="assistant-spinner" size={17}/> Thinking through your question…</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <div className="assistant-tools"><button onClick={() => void runTool('summary')}><Sparkles size={14}/> Summarize</button><button onClick={() => void runTool('notes')}><BookOpen size={14}/> Create notes</button><button onClick={() => void runTool('flashcards')}><Check size={14}/> Flashcards</button><button onClick={() => void runTool('quiz')}><Brain size={14}/> Practice quiz</button></div>
        {pendingTool && <form className="assistant-topic-form" onSubmit={event => { event.preventDefault(); if (toolTopic.trim()) void runTool(pendingTool, toolTopic); }}><Input autoFocus aria-label="Learning topic" placeholder="Enter a topic, e.g. Binary Search Trees" value={toolTopic} onChange={event => setToolTopic(event.target.value)}/><Button type="submit" disabled={!toolTopic.trim() || busy}>Generate</Button><button type="button" className="copy-button" onClick={() => setPendingTool(null)}>Cancel</button></form>}
        <div className="prompt-suggestions">{quickPrompts.map((text, index) => <button key={text} onClick={() => index === 2 ? void runTool('quiz') : index === 3 ? void runTool('summary') : setPrompt(text)}><span>{['✨','🌍','📝','📚'][index]}</span>{text}</button>)}</div>
        <form className="chat-input-row" onSubmit={event => { event.preventDefault(); void sendMessage(); }}><Input placeholder="Ask a question or paste a concept..." value={prompt} onChange={event => setPrompt(event.target.value)}/><button className="send-button" aria-label="Send message" type="submit" disabled={busy}><Send size={18}/></button><span className="chat-disclaimer">Abhyas AI can make mistakes. Check important information.</span></form>
      </Card>
    </div>
  </div>;
}
