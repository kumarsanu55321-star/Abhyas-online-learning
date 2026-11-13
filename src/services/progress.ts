import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type LearnerProfile = {
  user_id: string;
  display_name: string;
  username: string;
  goals: Record<string, unknown>;
  settings: Record<string, unknown>;
  show_on_leaderboard: boolean;
  total_xp: number;
  current_streak: number;
  best_streak: number;
  last_activity_date: string | null;
};

export type LearningEvent = {
  id: string;
  user_id: string;
  event_type: 'quiz_completed' | 'reverse_lecture_completed' | 'lecture_analyzed' | 'syllabus_analyzed' | 'study_session_completed' | 'room_joined';
  title: string;
  detail: string;
  subject: string | null;
  duration_seconds: number;
  xp_points: number;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ProgressSnapshot = { profile: LearnerProfile; events: LearningEvent[] };

function requireSupabase() {
  if (!supabase) throw new Error('Configure Supabase to save your learning progress.');
  return supabase;
}

export async function ensureLearnerProfile(_user: User) {
  const client = requireSupabase();
  const { data, error } = await client.rpc('ensure_learner_profile');
  if (error) throw new Error(error.message);
  return data as LearnerProfile;
}

export async function updateLearnerProfile(userId: string, updates: Partial<Pick<LearnerProfile, 'display_name' | 'username' | 'goals' | 'settings' | 'show_on_leaderboard'>>) {
  const { data, error } = await requireSupabase().from('learner_profiles').update({ ...updates, updated_at: new Date().toISOString() }).eq('user_id', userId).select('*').single();
  if (error) throw new Error(error.message);
  return data as LearnerProfile;
}

export async function loadProgress(userId: string): Promise<ProgressSnapshot> {
  const client = requireSupabase();
  const [{ data: profile, error: profileError }, { data: events, error: eventsError }] = await Promise.all([
    client.from('learner_profiles').select('*').eq('user_id', userId).single(),
    client.from('learning_events').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(500),
  ]);
  if (profileError) throw new Error(profileError.message);
  if (eventsError) throw new Error(eventsError.message);
  return { profile: profile as LearnerProfile, events: (events || []) as LearningEvent[] };
}

export async function recordLearningEvent(event: Pick<LearningEvent, 'event_type' | 'title' | 'detail' | 'subject' | 'duration_seconds' | 'idempotency_key' | 'metadata'>) {
  const client = requireSupabase();
  const { data: { user } } = await client.auth.getUser();
  if (!user) throw new Error('Sign in to save learning progress.');
  const payload = { ...event, user_id: user.id };
  const { data, error } = await client.from('learning_events').insert(payload).select('*').single();
  if (error?.code === '23505' && event.idempotency_key) return null;
  if (error) throw new Error(error.message);
  return data as LearningEvent;
}

export async function getLeaderboard(period: 'weekly' | 'global', subject: string | null = null) {
  const { data, error } = await requireSupabase().rpc('get_learning_leaderboard', { p_period: period, p_subject: subject });
  if (error) throw new Error(error.message);
  return (data || []) as Array<{ user_id: string; display_name: string; username: string; total_xp: number; level: number; rank: number }>;
}
