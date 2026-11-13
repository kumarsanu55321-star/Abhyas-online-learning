import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type StudyRoom = { id: string; room_code: string; host_user_id: string; name: string; subject: string; video_url: string | null; created_at: string };
export type RoomMessage = { id: string; room_id: string; user_id: string; content: string; created_at: string };

function client() {
  if (!supabase) throw new Error('Configure Supabase to use Study Together.');
  return supabase;
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, value => alphabet[value % alphabet.length]).join('');
}

export async function createStudyRoom(name: string, subject: string, videoUrl: string) {
  const { data, error } = await client().rpc('create_study_room', {
    p_room_code: roomCode(), p_name: name.trim(), p_subject: subject.trim(), p_video_url: videoUrl.trim() || null,
  });
  if (error) throw new Error(error.message);
  return data as StudyRoom;
}

export async function joinStudyRoom(code: string) {
  const { data, error } = await client().rpc('join_study_room', { p_room_code: code.trim() });
  if (error) throw new Error(error.message);
  return data as StudyRoom;
}

export async function loadStudyRooms(userId: string) {
  const { data: memberships, error: memberError } = await client().from('study_room_members').select('room_id').eq('user_id', userId);
  if (memberError) throw new Error(memberError.message);
  if (!memberships?.length) return [] as StudyRoom[];
  const { data, error } = await client().from('study_rooms').select('*').in('id', memberships.map(member => member.room_id)).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as StudyRoom[];
}

export async function loadRoomMessages(roomId: string) {
  const { data, error } = await client().from('study_room_messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true }).limit(100);
  if (error) throw new Error(error.message);
  return (data || []) as RoomMessage[];
}

export async function sendRoomMessage(roomId: string, userId: string, content: string) {
  const { data, error } = await client().from('study_room_messages').insert({ room_id: roomId, user_id: userId, content: content.trim() }).select('*').single();
  if (error) throw new Error(error.message);
  return data as RoomMessage;
}

export function subscribeToRoom(roomId: string, onMessage: (message: RoomMessage) => void, onPlayback: (payload: PlaybackCommand) => void) {
  const channel = client().channel(`study-room-${roomId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'study_room_messages', filter: `room_id=eq.${roomId}` }, event => onMessage(event.new as RoomMessage))
    .on('broadcast', { event: 'playback' }, event => onPlayback(event.payload as PlaybackCommand));
  channel.subscribe();
  return channel;
}

export async function leaveRoomChannel(channel: RealtimeChannel) {
  await client().removeChannel(channel);
}

export type PlaybackCommand = { action: 'play' | 'pause' | 'seek'; seconds?: number; at: number; user_id: string };
export async function broadcastPlayback(channel: RealtimeChannel, command: PlaybackCommand) {
  await channel.send({ type: 'broadcast', event: 'playback', payload: command });
}
