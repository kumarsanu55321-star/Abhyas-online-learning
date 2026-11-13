import { useState } from 'react';
import { ArrowRight, Play, Sparkles, BookOpen, Target } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button, Card, Input, PageHeader, ProgressBar } from '../components/common/UI';
import { analyzeSyllabus, type SyllabusAnalysis } from '../services/syllabus';
import { recordLearningEvent } from '../services/progress';
export { AITutor } from './AITutor';
export { ReverseLecture } from './ReverseLecture';
export { StudyTogether } from './StudyTogether';
export { LearningHistory, Profile, Settings, Leaderboard } from './ProgressPages';
export function SyllabusNavigator(){
  const { session } = useAuth();
  const [subject, setSubject] = useState('Computer Science');
  const [customSubject, setCustomSubject] = useState('');
  const [syllabus, setSyllabus] = useState('');
  const [analysis, setAnalysis] = useState<SyllabusAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submitSyllabus(){
    const selectedSubject = subject === 'Other' ? customSubject.trim() : subject;
    if (!selectedSubject) { setError('Enter a subject before analyzing the syllabus.'); return; }
    if (!syllabus.trim()) { setError('Paste at least one syllabus topic before analyzing.'); return; }
    setBusy(true); setError(''); setAnalysis(null);
    try {
      const result = await analyzeSyllabus(selectedSubject, syllabus.trim());
      setAnalysis(result);
      if (session?.user) {
        try { await recordLearningEvent({ event_type:'syllabus_analyzed', title:`Analyzed ${selectedSubject} syllabus`, detail:`${result.topics.length} topics mapped`, subject:selectedSubject, duration_seconds:0, idempotency_key:crypto.randomUUID(), metadata:{ topic_count:result.topics.length } }); }
        catch (cause) { setError(`Syllabus analyzed, but progress was not saved: ${cause instanceof Error ? cause.message : 'database unavailable'}`); }
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not analyze this syllabus. Please try again.'); }
    finally { setBusy(false); }
  }

  const topics = analysis?.topics || [];
  const topicStatus = (topic: string) => analysis?.topic_coverage.find(item => item.topic.toLowerCase() === topic.toLowerCase())?.status || 'unavailable';
  const statusLabel = (status: string) => status === 'partial' ? 'partially covered' : status === 'unavailable' ? 'coverage unavailable' : status;

  return <div className="feature-page"><PageHeader eyebrow="YOUR SYLLABUS, DECODED" title="Syllabus Navigator" description="Know what to learn next. Find videos that actually match your course."/><div className="syllabus-layout">
    <Card className="syllabus-form"><div className="form-step"><span>01</span><div><b>Tell us what you are studying</b><small>We will map the topics and find helpful videos.</small></div></div>
      <label className="form-label">Subject<select className="field select-field" value={subject} onChange={event => setSubject(event.target.value)}><option>Computer Science</option><option>Mathematics</option><option>Physics</option><option>Biology</option><option>Other</option></select></label>
      {subject === 'Other' && <label className="form-label">Custom subject<Input placeholder="Enter your subject" value={customSubject} onChange={event => setCustomSubject(event.target.value)}/></label>}
      <label className="form-label">Syllabus topics<textarea className="field textarea-field" placeholder={'Paste your syllabus topics here, one per line...\n\nExample:\nBinary Trees\nTree Traversals\nGraph Algorithms'} value={syllabus} onChange={event => setSyllabus(event.target.value)}/></label>
      <div className="upload-hint"><BookOpen size={16}/> Pasted topics are sent to Gemini to build your learning path.</div>
      <Button onClick={() => void submitSyllabus()} disabled={busy}><Sparkles size={16}/> {busy ? 'Analyzing syllabus...' : 'Analyze syllabus'} <ArrowRight size={16}/></Button>
      {error && <div className="form-error" role="alert">{error}</div>}
    </Card>
    <div className="syllabus-results"><div className="results-intro"><div><div className="section-kicker">MADE FOR YOUR COURSE</div><h2>Learning path preview</h2></div><span className="coverage-score">{analysis?.overall_coverage == null ? '-' : analysis.overall_coverage + '%'} <small>{analysis?.overall_coverage == null ? 'coverage unavailable' : 'estimated'}</small></span></div>
      {!analysis ? <Card className="coverage-card"><p>{busy ? 'Analyzing topics and searching public YouTube videos...' : 'Enter a subject and syllabus to build your learning path.'}</p></Card> : <>
        <Card className="coverage-card"><div className="coverage-heading"><span><Target size={17}/> Topic coverage</span><b>{analysis.overall_coverage == null ? 'Coverage unavailable' : 'Gemini video estimate'}</b></div>
          {analysis.overall_coverage != null && <ProgressBar value={analysis.overall_coverage}/>}<small>{analysis.coverage_note || 'Coverage is unavailable when actual video content cannot be assessed.'}</small>
          <div className="coverage-topics">{topics.map(topic => { const status = topicStatus(topic.name); return <div className={'coverage-topic ' + status} key={topic.name}><i/><span className="syllabus-topic-name">{topic.name}</span><small>{statusLabel(status)}</small>{topic.subtopics.map(subtopic => <span className="syllabus-subtopic" key={subtopic}>{subtopic}<small>{statusLabel(topicStatus(subtopic))}</small></span>)}</div>; })}</div>
          {!topics.length && <p>No syllabus topics were extracted. Try adding more detail.</p>}
        </Card>
        <div className="recommend-video-list"><div className="video-list-head"><b>Recommended videos</b><span>{analysis.videos.length} recommended - {analysis.candidate_count} candidates searched; {analysis.evaluated_candidate_count || 0} content assessed</span></div>
          {analysis.videos.map(video => <a className="syllabus-video-link" key={video.video_id} href={'https://www.youtube.com/watch?v=' + video.video_id} target="_blank" rel="noreferrer" aria-label={'Watch ' + video.title + ' on YouTube'}><Card className="video-card"><div className="video-thumb"><img src={video.thumbnail} alt="" loading="lazy"/><small>{video.duration || 'Duration unavailable'}</small><div><Play size={16} fill="currentColor"/></div></div><div className="video-details"><span className="video-channel">{video.channel}{video.view_count != null ? ' - ' + new Intl.NumberFormat().format(video.view_count) + ' views' : ''}</span><h3>{video.title}</h3><div className={'video-coverage ' + video.coverage.status}><span>{video.coverage.status === 'estimated' ? 'GEMINI VIDEO COVERAGE ESTIMATE' : video.coverage.status === 'metadata' ? 'METADATA-BASED RELEVANCE ESTIMATE' : 'SYLLABUS COVERAGE'}</span><b>{video.coverage.status === 'estimated' && video.coverage.percentage != null ? video.coverage.percentage + '%' : video.coverage.status === 'metadata' && video.coverage.relevance_score != null ? 'Relevance ' + video.coverage.relevance_score + '/100' : 'Unavailable'}</b></div>{video.coverage.status === 'estimated' && video.coverage.percentage != null && <ProgressBar value={video.coverage.percentage}/>}
            {video.coverage.status === 'metadata' && <small>Coverage unavailable; topic matches are not verified.</small>}
            <div className="video-topics"><span className="syllabus-video-meta-label">Search matches</span>{video.relevant_topics.map(topic => <span className="syllabus-search-topic" key={'relevant-' + topic}>{topic}</span>)}{video.coverage.covered_topics.length > 0 && <span className="syllabus-video-meta-label">Gemini assessed</span>}{video.coverage.covered_topics.map(topic => <span key={'covered-' + topic}>Covered: {topic}</span>)}{video.coverage.partial_topics.map(topic => <span key={'partial-' + topic}>Partial: {topic}</span>)}{video.coverage.missing_topics.map(topic => <span className="missing-topic" key={'missing-' + topic}>Missing: {topic}</span>)}{video.coverage.status === 'unavailable' && <span className="missing-topic">Coverage unavailable</span>}</div>
          </div></Card></a>)}
          {analysis.video_error && <div className="form-info" role="status">{analysis.video_error}</div>}
          {!analysis.video_error && !analysis.videos.length && <Card><p>No suitable public YouTube recommendations were found for these topics.</p></Card>}
        </div>
      </>}
    </div>
  </div></div>;
}

