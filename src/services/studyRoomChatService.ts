import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { SendStudyRoomChatMessage, StudyRoomChatMessage } from '../types/studyRoomChat';

const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 100;

function requireSupabase() {
  if (!supabase) throw new Error('Room chat is unavailable because Supabase is not configured.');
  return supabase;
}

function readableError(code?: string): string {
  if (code === '42501') return 'You do not have permission to access chat in this room.';
  if (code === '23514') return 'Messages must be 1–2,000 characters and use a valid video timestamp.';
  if (code === '23503') return 'This room or participant is no longer available.';
  return 'Chat could not be updated. Check your connection and try again.';
}

function validateMessage(message: string, videoTimestamp: number | null) {
  const trimmed = message.trim();
  if (!trimmed) throw new Error('Write a message before sending.');
  if (trimmed.length > MAX_MESSAGE_LENGTH) throw new Error('Messages can be up to 2,000 characters.');
  if (videoTimestamp !== null && (!Number.isFinite(videoTimestamp) || videoTimestamp < 0 || videoTimestamp >= 86400)) {
    throw new Error('The current video timestamp is invalid.');
  }
  return trimmed;
}

export async function fetchRecentStudyRoomMessages(roomId: string): Promise<StudyRoomChatMessage[]> {
  const client = requireSupabase();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError || !session) throw new Error('Sign in with an Abhyas account to read room chat.');

  const { data, error } = await client.from('study_room_messages')
    .select('id,room_id,user_id,message,video_timestamp,created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw new Error(readableError(error.code));
  return (data ?? []).reverse() as StudyRoomChatMessage[];
}

export async function sendStudyRoomMessage(input: SendStudyRoomChatMessage): Promise<StudyRoomChatMessage> {
  const client = requireSupabase();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError || !session) throw new Error('Sign in with an Abhyas account to send a message.');
  const message = validateMessage(input.message, input.videoTimestamp);

  // user_id is omitted: the database default derives it from auth.uid(), and
  // the insert policy independently verifies the authenticated participant.
  const { data, error } = await client.from('study_room_messages').insert({
    room_id: input.roomId,
    message,
    video_timestamp: input.videoTimestamp,
  }).select('id,room_id,user_id,message,video_timestamp,created_at').single();
  if (error) throw new Error(readableError(error.code));
  return data as StudyRoomChatMessage;
}

export function subscribeToStudyRoomMessages(
  roomId: string,
  onMessage: (message: StudyRoomChatMessage) => void,
  onStatus: (status: string, message?: string) => void,
): RealtimeChannel {
  const client = requireSupabase();
  return client.channel(`study-room-chat:${roomId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'study_room_messages', filter: `room_id=eq.${roomId}`,
    }, payload => {
      if (payload.new && 'id' in payload.new && 'room_id' in payload.new) {
        onMessage(payload.new as StudyRoomChatMessage);
      }
    })
    .subscribe((status, error) => onStatus(status, error?.message));
}

export async function removeStudyRoomChatSubscription(channel: RealtimeChannel) {
  if (!supabase) return;
  await supabase.removeChannel(channel);
}
