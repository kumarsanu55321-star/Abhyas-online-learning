import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { StudyRoomPlayback, UpdateStudyRoomPlayback } from '../types/studyRoomPlayback';

type SupabaseError = { message: string; code?: string; details?: string; hint?: string };
function errorMessage(error: SupabaseError): string {
  if (error.message.includes('PLAY_PAUSE_PERMISSION_REQUIRED')) return 'The host has not granted you Play/Pause permission.';
  if (error.message.includes('SEEK_PERMISSION_REQUIRED')) return 'The host has not granted you Seek permission.';
  if (error.message.includes('VIDEO_CHANGE_HOST_ONLY')) return 'Only the room host can change the shared video.';
  if (error.message.includes('NOT_ROOM_HOST')) return 'Only the room host can control this playback action.';
  if (error.message.includes('ROOM_NOT_FOUND_OR_ENDED')) return 'This room has ended; shared playback is no longer available.';
  if (error.message.includes('AUTH_REQUIRED')) return 'Sign in again to control shared playback.';
  const details = [error.code && `Code ${error.code}`, error.details, error.hint && `Hint: ${error.hint}`].filter(Boolean);
  return details.length ? `${error.message} (${details.join(' · ')})` : error.message;
}

function requireSupabase() {
  if (!supabase) throw new Error('YouTube sync requires a configured Supabase project.');
  return supabase;
}

export async function getStudyRoomPlayback(roomId: string): Promise<StudyRoomPlayback | null> {
  const { data, error } = await requireSupabase()
    .from('study_room_playback').select('*').eq('room_id', roomId).maybeSingle();
  if (error) throw new Error(errorMessage(error));
  return data as StudyRoomPlayback | null;
}

export async function updateStudyRoomPlayback(input: UpdateStudyRoomPlayback): Promise<StudyRoomPlayback> {
  const client = requireSupabase();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw new Error(`Could not verify your sign-in: ${sessionError.message}`);
  if (!session) throw new Error('Sign in with an Abhyas account to control shared playback.');

  const { error } = await client.rpc('update_study_room_playback', {
    p_room_id: input.roomId,
    p_video_id: input.videoId,
    p_playback_status: input.status,
    p_current_time: Math.max(0, input.currentTime),
  });
  if (error) throw new Error(errorMessage(error));
  const playback = await getStudyRoomPlayback(input.roomId);
  if (!playback) throw new Error('Playback was saved, but its state could not be read. Check participant access and retry.');
  return playback;
}

export function subscribeToStudyRoomPlayback(
  roomId: string,
  onPlayback: (playback: StudyRoomPlayback) => void,
  onStatus: (status: string, error?: string) => void,
): RealtimeChannel {
  const client = requireSupabase();
  return client.channel(`study-room-playback:${roomId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'study_room_playback', filter: `room_id=eq.${roomId}`,
    }, payload => {
      if (payload.eventType === 'DELETE' || !payload.new || !('room_id' in payload.new)) return;
      onPlayback(payload.new as StudyRoomPlayback);
    })
    .subscribe((status, error) => onStatus(status, error?.message));
}

export async function removePlaybackSubscription(channel: RealtimeChannel) {
  if (!supabase) return;
  await supabase.removeChannel(channel);
}
