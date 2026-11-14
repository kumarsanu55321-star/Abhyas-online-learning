import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { SetStudyRoomPlaybackPermission, StudyRoomPlaybackPermission } from '../types/studyRoomPermissions';

function requireSupabase() {
  if (!supabase) throw new Error('Playback permissions need a configured Supabase project.');
  return supabase;
}

function friendlyError(code?: string, message?: string) {
  if (message?.includes('NOT_ROOM_HOST')) return 'Only the room host can manage playback permissions.';
  if (message?.includes('TARGET_NOT_ROOM_PARTICIPANT')) return 'That learner is no longer a participant in this room.';
  if (message?.includes('ROOM_NOT_FOUND_OR_ENDED')) return 'Playback permissions can only be changed in an active room.';
  if (message?.includes('AUTH_REQUIRED')) return 'Sign in again to manage playback permissions.';
  if (code === '42501') return 'You do not have permission to read playback permissions in this room.';
  return 'Playback permissions could not be updated. Check your connection and try again.';
}

export async function getStudyRoomPlaybackPermissions(roomId: string): Promise<StudyRoomPlaybackPermission[]> {
  const client = requireSupabase();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError || !session) throw new Error('Sign in with an Abhyas account to read playback permissions.');
  const { data, error } = await client.from('study_room_playback_permissions')
    .select('room_id,user_id,can_play_pause,can_seek,updated_at')
    .eq('room_id', roomId);
  if (error) throw new Error(friendlyError(error.code, error.message));
  return (data ?? []) as StudyRoomPlaybackPermission[];
}

export async function setStudyRoomPlaybackPermission(input: SetStudyRoomPlaybackPermission): Promise<void> {
  const client = requireSupabase();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError || !session) throw new Error('Sign in again to manage playback permissions.');
  const { error } = await client.rpc('manage_study_room_playback_permission', {
    p_room_id: input.roomId,
    p_user_id: input.userId,
    p_can_play_pause: input.canPlayPause,
    p_can_seek: input.canSeek,
  });
  if (error) throw new Error(friendlyError(error.code, error.message));
}

export function subscribeToStudyRoomPlaybackPermissions(
  roomId: string,
  onPermission: (permission: StudyRoomPlaybackPermission | null, event: 'INSERT' | 'UPDATE' | 'DELETE') => void,
  onStatus: (status: string, message?: string) => void,
): RealtimeChannel {
  const client = requireSupabase();
  return client.channel(`study-room-playback-permissions:${roomId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'study_room_playback_permissions', filter: `room_id=eq.${roomId}`,
    }, payload => {
      if (payload.eventType === 'DELETE') {
        onPermission(null, 'DELETE');
      } else if (payload.new && 'room_id' in payload.new && 'user_id' in payload.new) {
        onPermission(payload.new as StudyRoomPlaybackPermission, payload.eventType as 'INSERT' | 'UPDATE');
      }
    })
    .subscribe((status, error) => onStatus(status, error?.message));
}

export async function removePlaybackPermissionsSubscription(channel: RealtimeChannel) {
  if (!supabase) return;
  await supabase.removeChannel(channel);
}
