import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && anonKey);
export const supabase = supabaseConfigured
  ? createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

export const auth = {
  async getSessionUser() {
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const u = data.session?.user;
    return u ? { userId: u.id, id: u.id, email: u.email || '', name: String(u.user_metadata?.full_name || u.user_metadata?.name || u.email || 'Equipe BFGS') } : null;
  },
  async signInWithRedirect() {
    if (!supabase) throw new Error('Supabase não configurado. Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.');
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    if (error) throw error;
  },
  async signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    window.location.reload();
  },
  onAuthStateChange(callback: (user: any) => void) {
    if (!supabase) return { data: { subscription: { unsubscribe() {} } } };
    return supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      callback(u ? { userId: u.id, id: u.id, email: u.email || '', name: String(u.user_metadata?.full_name || u.user_metadata?.name || u.email || 'Equipe BFGS') } : null);
    });
  }
};
