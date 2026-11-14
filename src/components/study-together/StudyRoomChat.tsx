import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { LoaderCircle, MessageCircle, Send } from 'lucide-react';
import { Card } from '../common/UI';
import { fetchRecentStudyRoomMessages, removeStudyRoomChatSubscription, sendStudyRoomMessage, subscribeToStudyRoomMessages } from '../../services/studyRoomChatService';
import type { StudyRoomParticipant } from '../../types/studyRoom';
import type { StudyRoomChatMessage } from '../../types/studyRoomChat';
import type { StudyRoomPlayerControls } from './SynchronizedYouTubePlayer';

const HISTORY_LIMIT = 100;

function mergeMessages(current: StudyRoomChatMessage[], incoming: StudyRoomChatMessage[]) {
  const byId = new Map(current.map(message => [message.id, message]));
  incoming.forEach(message => byId.set(message.id, message));
  return [...byId.values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .slice(-HISTORY_LIMIT);
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || 'L';
}

function formatVideoTimestamp(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function formatSentAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function StudyRoomChat({
  roomId, currentUserId, participants, playerControlsRef,
}: {
  roomId: string;
  currentUserId: string;
  participants: StudyRoomParticipant[];
  playerControlsRef: MutableRefObject<StudyRoomPlayerControls | null>;
}) {
  const [messages, setMessages] = useState<StudyRoomChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [realtimeError, setRealtimeError] = useState('');
  const [notice, setNotice] = useState('');
  const [realtimeStatus, setRealtimeStatus] = useState('CONNECTING');
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const sendingRef = useRef(false);
  const senderById = useMemo(() => new Map(participants.map(person => [person.user_id, person])), [participants]);

  useEffect(() => {
    let mounted = true;
    const merge = (incoming: StudyRoomChatMessage[]) => setMessages(current => mergeMessages(current, incoming));
    const loadHistory = async () => {
      try {
        const history = await fetchRecentStudyRoomMessages(roomId);
        if (mounted) { merge(history); setError(''); }
      } catch (loadError) {
        if (mounted) setError(loadError instanceof Error ? loadError.message : 'Could not load room chat.');
      } finally { if (mounted) setLoading(false); }
    };

    // Subscribe before fetching history; merge-by-id handles overlap between
    // the initial query and any INSERT events delivered during that query.
    let channel: RealtimeChannel | null = null;
    try {
      channel = subscribeToStudyRoomMessages(roomId, message => {
        if (mounted) merge([message]);
      }, (status, statusMessage) => {
        if (!mounted) return;
        setRealtimeStatus(status);
        if (status === 'SUBSCRIBED') { setRealtimeError(''); void loadHistory(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeError(statusMessage ? `Live chat disconnected: ${statusMessage}` : 'Live chat disconnected. Reconnecting…');
        }
      });
    } catch (subscribeError) {
      setRealtimeError(subscribeError instanceof Error ? subscribeError.message : 'Could not connect to live chat.');
    }
    void loadHistory();
    return () => {
      mounted = false;
      if (channel) void removeStudyRoomChatSubscription(channel);
    };
  }, [roomId]);

  useEffect(() => {
    const list = scrollRef.current;
    if (list && isAtBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  async function submitMessage() {
    const message = draft.trim();
    if (!message || sendingRef.current) return;
    if (message.length > 2000) { setError('Messages can be up to 2,000 characters.'); return; }
    sendingRef.current = true;
    setSending(true);
    setError('');
    setNotice('');
    try {
      const timestamp = playerControlsRef.current?.getCurrentTime() ?? null;
      const sent = await sendStudyRoomMessage({ roomId, message, videoTimestamp: timestamp });
      setMessages(current => mergeMessages(current, [sent]));
      setDraft('');
      isAtBottomRef.current = true;
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Could not send your message. Try again.');
    } finally { sendingRef.current = false; setSending(false); }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void submitMessage();
    }
  }

  function handleTimestampClick(seconds: number) {
    const timestamp = formatVideoTimestamp(seconds);
    if (!playerControlsRef.current?.canSeek) {
      setNotice(`You do not have Seek permission. Ask the host to jump to ${timestamp}.`);
      return;
    }
    if (!playerControlsRef.current?.seekTo(seconds)) {
      setNotice('The shared video is not ready to seek yet.');
      return;
    }
    setNotice(`Seeking shared video to ${timestamp}.`);
  }

  return <Card className="room-chat-card">
    <div className="room-chat-header">
      <div className="room-chat-heading-icon"><MessageCircle size={17}/></div>
      <div className="room-chat-heading-copy"><h2>Room Chat</h2><span>{participants.length} participant{participants.length === 1 ? '' : 's'}</span></div>
      <span className={`room-chat-live ${realtimeStatus === 'SUBSCRIBED' ? 'is-live' : ''}`}><i/>{realtimeStatus === 'SUBSCRIBED' ? 'LIVE' : 'CONNECTING'}</span>
    </div>

    {error && <div className="room-chat-error" role="alert">{error}</div>}
    {realtimeError && <div className="room-chat-error" role="status">{realtimeError}</div>}
    {notice && <div className="room-chat-notice" role="status">{notice}</div>}

    <div className="room-chat-messages" ref={scrollRef} onScroll={event => {
      const element = event.currentTarget;
      isAtBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
    }} aria-live="polite" aria-relevant="additions text">
      {loading && messages.length === 0 ? <div className="room-chat-state"><LoaderCircle className="spin-icon" size={19}/><span>Loading messages…</span></div>
        : messages.length === 0 ? <div className="room-chat-state"><div className="room-chat-empty-icon"><MessageCircle size={20}/></div><b>No messages yet</b><span>Start the conversation with your study crew.</span></div>
          : messages.map((item, index) => {
            const sender = senderById.get(item.user_id);
            const senderName = sender?.display_name ?? 'Room participant';
            const previous = messages[index - 1];
            const grouped = previous?.user_id === item.user_id
              && Date.now() - Date.parse(previous.created_at) < 5 * 60 * 1000;
            return <article className={`room-chat-message ${grouped ? 'is-grouped' : ''}`} key={item.id}>
              {grouped ? <span className="room-chat-avatar-spacer"/> : <span className={`room-chat-avatar participant-color-${Math.max(0, participants.findIndex(person => person.user_id === item.user_id) % 5)}`}>{initials(senderName)}</span>}
              <div className="room-chat-message-content">
                {!grouped && <div className="room-chat-sender"><b>{senderName}{item.user_id === currentUserId ? ' (you)' : ''}</b><time dateTime={item.created_at}>{formatSentAt(item.created_at)}</time></div>}
                <p>{item.message}</p>
                {item.video_timestamp !== null && <button type="button" className="room-chat-video-time" onClick={() => handleTimestampClick(item.video_timestamp!)} aria-label={`Seek to ${formatVideoTimestamp(item.video_timestamp)} in the shared video`}>
                  <span aria-hidden="true">▶</span>{formatVideoTimestamp(item.video_timestamp)}
                </button>}
              </div>
            </article>;
          })}
    </div>

    <form className="room-chat-compose" onSubmit={event => { event.preventDefault(); void submitMessage(); }}>
      <label className="sr-only" htmlFor={`room-chat-input-${roomId}`}>Message</label>
      <textarea id={`room-chat-input-${roomId}`} value={draft} maxLength={2000} rows={2} placeholder="Share a thought with your study crew…" onChange={event => { setDraft(event.target.value); if (error) setError(''); }} onKeyDown={handleKeyDown} disabled={sending} />
      <div className="room-chat-compose-footer"><span>{draft.length}/2000 · Enter to send, Shift + Enter for a new line</span><button type="submit" aria-label="Send message" disabled={sending || !draft.trim()}>{sending ? <LoaderCircle className="spin-icon" size={16}/> : <Send size={16}/>}</button></div>
    </form>
  </Card>;
}
