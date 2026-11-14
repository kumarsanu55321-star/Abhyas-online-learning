import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { AbhyasProfile, ActiveStudyRoom, FriendRequest, Friendship } from '../types/friends';

function client() {
  if (!supabase) throw new Error('Friends requires a configured Supabase connection.');
  return supabase;
}

export async function searchAbhyasProfiles(query: string): Promise<AbhyasProfile[]> {
  const { data, error } = await client().rpc('search_abhyas_profiles', { p_query: query });
  if (error) throw error;
  return (data ?? []) as AbhyasProfile[];
}

export async function getFriendOverview(userId: string) {
  const db = client();
  const [friendResult, incomingResult, outgoingResult] = await Promise.all([
    db.from('friendships').select('user_low_id,user_high_id,created_at').or(`user_low_id.eq.${userId},user_high_id.eq.${userId}`),
    db.from('friend_requests').select('id,sender_id,receiver_id,status,created_at').eq('receiver_id', userId).eq('status', 'pending').order('created_at', { ascending: false }),
    db.from('friend_requests').select('id,sender_id,receiver_id,status,created_at').eq('sender_id', userId).eq('status', 'pending').order('created_at', { ascending: false }),
  ]);
  if (friendResult.error) throw friendResult.error;
  if (incomingResult.error) throw incomingResult.error;
  if (outgoingResult.error) throw outgoingResult.error;

  const friendships = (friendResult.data ?? []) as Friendship[];
  const incoming = (incomingResult.data ?? []) as FriendRequest[];
  const outgoing = (outgoingResult.data ?? []) as FriendRequest[];
  const friendIds = friendships.map((row) => row.user_low_id === userId ? row.user_high_id : row.user_low_id);
  const profileIds = [...new Set([...friendIds, ...incoming.map((row) => row.sender_id), ...outgoing.map((row) => row.receiver_id)])];
  let profiles: AbhyasProfile[] = [];
  if (profileIds.length) {
    const { data, error } = await db.rpc('get_abhyas_profiles', { p_user_ids: profileIds });
    if (error) throw error;
    profiles = (data ?? []) as AbhyasProfile[];
  }
  const byId = new Map(profiles.map((profile) => [profile.user_id, profile]));
  return {
    friends: friendIds.map((id) => byId.get(id)).filter((profile): profile is AbhyasProfile => Boolean(profile)),
    incoming: incoming.map((request) => ({ request, profile: byId.get(request.sender_id) })).filter((row): row is { request: FriendRequest; profile: AbhyasProfile } => Boolean(row.profile)),
    outgoing: outgoing.map((request) => ({ request, profile: byId.get(request.receiver_id) })).filter((row): row is { request: FriendRequest; profile: AbhyasProfile } => Boolean(row.profile)),
  };
}

export async function createFriendRequest(receiverId: string) {
  const { error } = await client().rpc('create_friend_request', { p_receiver_id: receiverId });
  if (error) throw error;
}

export async function respondToFriendRequest(requestId: string, action: 'accept' | 'reject' | 'cancel') {
  const { error } = await client().rpc('respond_to_friend_request', { p_request_id: requestId, p_action: action });
  if (error) throw error;
}

export async function removeFriend(friendId: string) {
  const { error } = await client().rpc('remove_friend', { p_friend_id: friendId });
  if (error) throw error;
}

export async function getActiveStudyRooms(userId: string): Promise<ActiveStudyRoom[]> {
  const db = client();
  const { data: memberships, error: membershipError } = await db.from('study_room_participants').select('room_id').eq('user_id', userId);
  if (membershipError) throw membershipError;
  const ids = [...new Set((memberships ?? []).map((membership) => membership.room_id as string))];
  if (!ids.length) return [];
  const { data, error } = await db.from('study_rooms').select('id,name,room_code').in('id', ids).eq('status', 'active').order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ActiveStudyRoom[];
}

export async function getProfileByUsername(username: string): Promise<AbhyasProfile | null> {
  const { data, error } = await client().rpc('get_public_abhyas_profile', { p_username: username.toLowerCase() });
  if (error) throw error;
  return ((data ?? []) as AbhyasProfile[])[0] ?? null;
}

export function subscribeToPresence(userId: string, friendIds: string[], onChange: (onlineIds: Set<string>) => void): () => void {
  const db = client();
  let active = true;
  const targets = [...new Set([userId, ...friendIds])];
  const channels: { targetId: string; channel: RealtimeChannel }[] = [];
  const publish = () => {
    if (!active) return;
    const online = new Set<string>();
    for (const { targetId, channel } of channels) {
      if (Object.keys(channel.presenceState()).length > 0) online.add(targetId);
    }
    onChange(online);
  };
  for (const targetId of targets) {
    const isSelf = targetId === userId;
    const channel = db.channel(`abhyas:user-presence:${targetId}`, { config: { private: true } })
      .on('presence', { event: 'sync' }, publish)
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED' && active && isSelf) {
          // The identity is bound to the channel topic and checked by RLS;
          // payload fields are deliberately not used to identify an online user.
          const response = await channel.track({ online_at: new Date().toISOString() });
          if (response !== 'ok') console.error('Could not publish online presence:', response);
        }
      });
    channels.push({ targetId, channel });
  }
  return () => {
    active = false;
    for (const { channel } of channels) {
      void channel.untrack().finally(() => { void db.removeChannel(channel); });
    }
  };
}
