import { supabase } from './supabase';

export type SyllabusTopic = { name: string; subtopics: string[] };
export type TopicCoverage = { topic: string; status: 'covered' | 'partial' | 'missing' | 'unavailable' };
export type SyllabusVideo = {
  video_id: string;
  title: string;
  thumbnail: string;
  channel: string;
  duration: string;
  view_count: number | null;
  description: string;
  relevant_topics: string[];
  coverage: {
    status: 'estimated' | 'metadata' | 'unavailable';
    source: 'gemini_video' | 'metadata' | 'unavailable';
    percentage?: number;
    relevance_score?: number | null;
    covered_topics: string[];
    partial_topics: string[];
    missing_topics: string[];
  };
};
export type SyllabusAnalysis = {
  topics: SyllabusTopic[];
  topic_coverage: TopicCoverage[];
  overall_coverage: number | null;
  videos: SyllabusVideo[];
  candidate_count: number;
  evaluated_candidate_count?: number;
  video_error?: string;
  coverage_note?: string;
};

const apiUrl = ((import.meta.env.VITE_AI_API_URL as string | undefined) || 'http://127.0.0.1:8000').replace(/\/+$/, '');

export async function analyzeSyllabus(subject: string, syllabus: string) {
  if (!supabase) throw new Error('Sign in with your Abhyas account to analyze a syllabus.');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in with your Abhyas account to analyze a syllabus.');

  const response = await fetch(`${apiUrl}/api/syllabus/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subject, syllabus }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.detail || 'Could not analyze this syllabus. Please try again.');
  return result as SyllabusAnalysis;
}
