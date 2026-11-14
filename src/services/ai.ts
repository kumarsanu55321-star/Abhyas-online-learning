import { supabase } from './supabase';

export type AssistantMessage = { role: 'user' | 'assistant'; content: string };
export type AssistantMode = 'chat' | 'summary' | 'notes' | 'flashcards' | 'quiz' | 'lecture' | 'reverse_lecture' | 'recap';

const apiUrl = ((import.meta.env.VITE_AI_API_URL as string | undefined) || 'http://127.0.0.1:8000').replace(/\/+$/, '');

export async function askAssistant(messages: AssistantMessage[], mode: AssistantMode = 'chat', transcript?: string, videoUrl?: string) {
  if (!supabase) throw new Error('Supabase is not configured. Add the project URL and anon key to .env.local.');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in with your Abhyas account to use the AI assistant.');

  const response = await fetch(`${apiUrl}/api/assistant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages, mode, transcript, video_url: videoUrl }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.detail || 'The AI assistant could not respond. Please try again.');
  return result as { content: string; data?: unknown; source?: 'gemini_video' };
}

export function getAssistantError(error: unknown) {
  if (error instanceof TypeError) return `Could not reach the AI API at ${apiUrl}. Start the backend and check its CORS origin.`;
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
