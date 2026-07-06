export interface UserDocTemplate {
  id: string;
  icon: string;
  title: string;
  content: string;
  createdAt: string;
}

const KEY = 'alcove-user-doc-templates';

export function loadUserTemplates(): UserDocTemplate[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

export function saveUserTemplate(tpl: Omit<UserDocTemplate, 'id' | 'createdAt'>): UserDocTemplate {
  const full: UserDocTemplate = { ...tpl, id: `user-${Date.now()}`, createdAt: new Date().toISOString() };
  const existing = loadUserTemplates().filter(t => t.title !== tpl.title);
  localStorage.setItem(KEY, JSON.stringify([...existing, full]));
  return full;
}

export function deleteUserTemplate(id: string) {
  localStorage.setItem(KEY, JSON.stringify(loadUserTemplates().filter(t => t.id !== id)));
}
