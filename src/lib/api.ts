import { supabase } from './supabase';

async function request(method: string, path: string, body?: unknown) {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  if (!session?.access_token) throw new Error('Sessão não encontrada. Entre novamente no portal.');
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || 'Falha na API (' + response.status + ')');
  return { data };
}
export const api = {
  get: (path: string) => request('GET', path),
  post: (path: string, body?: unknown) => request('POST', path, body)
};
