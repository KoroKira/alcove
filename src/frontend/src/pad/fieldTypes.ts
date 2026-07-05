/* Shared field system for Kanban and Gantt */

export type FieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'url';

export interface FieldDef {
  id: string;
  name: string;
  type: FieldType;
  options?: string[]; // for 'select' type
}

export interface FieldValue {
  fieldId: string;
  value: string | number | boolean | null;
}

export interface Attachment {
  id: string;
  name: string;
  url: string;
}

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export const PRIORITY_LABELS: Record<Priority, string> = {
  none: 'Aucune', low: 'Basse', medium: 'Moyenne', high: 'Haute', urgent: 'Urgente',
};

export const PRIORITY_COLORS: Record<Priority, string> = {
  none: 'transparent', low: '#89b4fa', medium: '#f9e2af', high: '#fab387', urgent: '#f38ba8',
};

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Texte', number: 'Nombre', date: 'Date',
  select: 'Liste de choix', checkbox: 'Case à cocher', url: 'Lien',
};

export const uid = () => `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export function getFieldValue(values: FieldValue[], fieldId: string): string | number | boolean | null {
  return values.find(v => v.fieldId === fieldId)?.value ?? null;
}

export function setFieldValue(values: FieldValue[], fieldId: string, value: string | number | boolean | null): FieldValue[] {
  const existing = values.findIndex(v => v.fieldId === fieldId);
  if (existing >= 0) {
    return values.map((v, i) => i === existing ? { ...v, value } : v);
  }
  return [...values, { fieldId, value }];
}
