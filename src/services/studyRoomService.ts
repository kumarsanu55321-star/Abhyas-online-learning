import { supabase } from './supabase';
import type { CreateStudyRoomInput, StudyRoom, StudyRoomDetails, StudyRoomParticipant } from '../types/studyRoom';

function requireSupabase() {
  if (!supabase) throw new Error('Study rooms need a configured Supabase backend. Add the Supabase URL and anon key, then try again.');
  return supabase;
}

function readableError(message: string): string {
  const code = message.match(/ROOM_[A-Z_]+|ALREADY_PARTICIPANT|NOT_ROOM_HOST|AUTH_REQUIRED|INVALID_ROOM/)?.[0];
  const messages: Record<string, string> = {
    ROOM_NOT_FOUND: 'We couldn’t find that room code. Check it and try again.',
    ROOM_ENDED: 'This room has ended and can no longer be joined.',
    ROOM_FULL: 'This room has reached its participant limit.',
    ALREADY_PARTICIPANT: 'You’re already in this room.',
    NOT_ROOM_HOST: 'Only the room host can end this room.',
    AUTH_REQUIRED: 'Sign in with a real Abhyas account to use study rooms.',
    INVALID_ROOM: 'Check the room details and participant limit, then try again.',
    ROOM_ACCESS_DENIED: 'This room does not exist, or you are not one of its participants.',
  };
  return code ? messages[code] ?? message : message;
}

type SupabaseError = { message: string; code?: string; details?: string; hint?: string };
function supabaseErrorMessage(error: SupabaseError): string {
  const friendly = readableError(error.message);
  if (friendly !== error.message) return friendly;
  const metadata = [error.code && `Code: ${error.code}`, error.details && `Details: ${error.details}`, error.hint && `Hint: ${error.hint}`].filter(Boolean);
  return metadata.length ? `${error.message} (${metadata.join(' · ')})` : error.message;
}

async function unwrap<T>(promise: PromiseLike<{ data: T | null; error: SupabaseError | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(supabaseErrorMessage(error));
  if (data === null) throw new Error('The room service returned no data. Please try again.');
  return data;
}

export async function createStudyRoom(input: CreateStudyRoomInput): Promise<StudyRoomDetails> {
  const client = requireSupabase();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw new Error(`Could not verify your sign-in: ${sessionError.message}`);
  if (!session) throw new Error('Sign in with a real Abhyas account to create a room. Preview sessions cannot create backend rooms.');
  const id = await unwrap(client.rpc('create_study_room', {
    p_name: input.name.trim(), p_subject: input.subject.trim(), p_youtube_url: input.youtubeUrl,
    p_visibility: input.visibility, p_max_participants: input.maxParticipants, p_display_name: input.displayName,
  }));
  return getStudyRoom(id);
}

export async function joinStudyRoom(roomCode: string, displayName: string): Promise<StudyRoomDetails> {
  const client = requireSupabase();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw new Error(`Could not verify your sign-in: ${sessionError.message}`);
  if (!session) throw new Error('Sign in with a real Abhyas account to join a room. Preview sessions cannot join backend rooms.');
  const normalizedCode = roomCode.trim().toUpperCase();
  const { data: roomId, error } = await client.rpc('join_study_room', {
    p_room_code: normalizedCode,
    p_display_name: displayName.trim(),
  });
  if (error) {
    if (error.message.includes('ALREADY_PARTICIPANT')) {
      const { data: existingRoom, error: lookupError } = await client
        .from('study_rooms').select('id').eq('room_code', normalizedCode).maybeSingle();
      if (lookupError) throw new Error(supabaseErrorMessage(lookupError));
      if (existingRoom) return getStudyRoom(existingRoom.id);
    }
    throw new Error(supabaseErrorMessage(error));
  }
  if (!roomId) throw new Error('The join RPC succeeded but returned no room ID.');
  return getStudyRoom(roomId);
}

export async function getStudyRoom(roomId: string): Promise<StudyRoomDetails> {
  const client = requireSupabase();
  const { data: room, error } = await client.from('study_rooms').select('*').eq('id', roomId).maybeSingle();
  if (error) throw new Error(supabaseErrorMessage(error));
  if (!room) throw new Error(readableError('ROOM_ACCESS_DENIED'));
  const participants = await unwrap(client.from('study_room_participants').select('*').eq('room_id', roomId).order('joined_at')) as StudyRoomParticipant[];
  return { room, participants };
}

export async function listPublicStudyRooms(): Promise<StudyRoomDetails[]> {
  const client = requireSupabase();
  const rooms = await unwrap(client.from('study_rooms').select('*').eq('visibility', 'public').eq('status', 'active').order('created_at', { ascending: false }).limit(20)) as StudyRoom[];
  if (!rooms.length) return [];
  const participants = await unwrap(client.from('study_room_participants').select('*').in('room_id', rooms.map(room => room.id)).order('joined_at')) as StudyRoomParticipant[];
  return rooms.map(room => ({ room, participants: participants.filter(participant => participant.room_id === room.id) }));
}

export async function leaveStudyRoom(roomId: string, isHost: boolean): Promise<void> {
  const client = requireSupabase();
  if (isHost) {
    await unwrap(client.rpc('end_study_room', { p_room_id: roomId }));
    return;
  }
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error('Sign in again to leave this room.');
  const { error } = await client.from('study_room_participants').delete().eq('room_id', roomId).eq('user_id', session.user.id);
  if (error) throw new Error(supabaseErrorMessage(error));
}
