import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../services/supabase';
type AuthState = { session: Session | null; preview: boolean; loading: boolean; signOut: () => Promise<void> };
const AuthContext = createContext<AuthState | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null); const [preview, setPreview] = useState(() => sessionStorage.getItem('abhyas-preview') === 'yes'); const [loading, setLoading] = useState(supabaseConfigured);
  useEffect(() => { if (!supabase) return; supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); }); const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setLoading(false); }); return () => subscription.unsubscribe(); }, []);
  const value = useMemo(() => ({ session, preview, loading, signOut: async () => { if (supabase) await supabase.auth.signOut(); sessionStorage.removeItem('abhyas-preview'); setSession(null); setPreview(false); } }), [session, preview, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() { const context = useContext(AuthContext); if (!context) throw new Error('useAuth must be used inside AuthProvider'); return context; }
export function enablePreview() { sessionStorage.setItem('abhyas-preview', 'yes'); }
