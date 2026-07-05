export interface CanvasTemplate {
  id: string;
  name: string;
  description: string;
  emoji: string;
  elements: unknown[];
  appState?: Partial<{ gridModeEnabled: boolean; viewBackgroundColor: string }>;
}

const W = 1000;

const text = (x: number, y: number, value: string, size = 20, bold = false) => ({
  type: 'text', id: `t_${Math.random().toString(36).slice(2,9)}`,
  x, y, width: 400, height: size * 1.5,
  angle: 0, strokeColor: '#cdd6f4', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
  roughness: 0, opacity: 100, groupIds: [], roundness: null,
  seed: Math.floor(Math.random() * 99999),
  version: 1, versionNonce: 1, isDeleted: false,
  boundElements: null, updated: Date.now(), link: null, locked: false,
  text: value, fontSize: size, fontFamily: 1,
  textAlign: 'left', verticalAlign: 'top',
  baseline: size * 1.2, containerId: null, originalText: value,
  lineHeight: 1.25,
  fontWeight: bold ? 700 : 400,
});

const rect = (x: number, y: number, w: number, h: number, bg = 'transparent', stroke = '#45475a') => ({
  type: 'rectangle', id: `r_${Math.random().toString(36).slice(2,9)}`,
  x, y, width: w, height: h,
  angle: 0, strokeColor: stroke, backgroundColor: bg,
  fillStyle: bg === 'transparent' ? 'hachure' : 'solid',
  strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100,
  groupIds: [], roundness: { type: 3, value: 10 }, seed: Math.floor(Math.random() * 99999),
  version: 1, versionNonce: 1, isDeleted: false,
  boundElements: null, updated: Date.now(), link: null, locked: false,
});

export const CANVAS_TEMPLATES: CanvasTemplate[] = [
  {
    id: 'blank',
    name: 'Vierge',
    description: 'Canvas vide, prêt à accueillir vos idées',
    emoji: '⬜',
    elements: [],
  },

  {
    id: 'meeting',
    name: 'Réunion',
    description: 'Template pour structurer une réunion : ordre du jour, notes, actions',
    emoji: '📋',
    elements: [
      text(60, 40, '📋 Réunion', 32, true),
      text(60, 100, new Date().toLocaleDateString('fr-FR'), 16),

      rect(60, 150, W - 120, 160, '#1e1e2e', '#89b4fa'),
      text(80, 160, 'Participants', 14, true),
      text(80, 185, '• ', 14),
      text(80, 210, '• ', 14),
      text(80, 235, '• ', 14),
      text(80, 260, '• ', 14),

      rect(60, 330, W - 120, 220, '#1e1e2e', '#a6e3a1'),
      text(80, 340, 'Ordre du jour', 14, true),
      text(80, 365, '1. ', 14),
      text(80, 390, '2. ', 14),
      text(80, 415, '3. ', 14),
      text(80, 440, '4. ', 14),
      text(80, 465, '5. ', 14),

      rect(60, 570, (W - 150) / 2, 240, '#1e1e2e', '#cba6f7'),
      text(80, 580, 'Notes', 14, true),

      rect(60 + (W - 150) / 2 + 30, 570, (W - 150) / 2, 240, '#1e1e2e', '#f9e2af'),
      text(80 + (W - 150) / 2 + 30, 580, '✅ Actions', 14, true),
    ],
  },

  {
    id: 'brainstorm',
    name: 'Brainstorm',
    description: 'Carte mentale radiale pour explorer des idées librement',
    emoji: '🧠',
    elements: [
      rect(430, 280, 140, 60, '#89b4fa', '#89b4fa'),
      text(445, 295, '💡 Idée centrale', 14, true),

      rect(100, 120, 130, 50, '#a6e3a1', '#a6e3a1'),
      text(110, 135, 'Axe 1', 14),

      rect(770, 120, 130, 50, '#f38ba8', '#f38ba8'),
      text(780, 135, 'Axe 2', 14),

      rect(100, 440, 130, 50, '#f9e2af', '#f9e2af'),
      text(110, 455, 'Axe 3', 14),

      rect(770, 440, 130, 50, '#cba6f7', '#cba6f7'),
      text(780, 455, 'Axe 4', 14),
    ],
    appState: { viewBackgroundColor: '#0d0d1a' },
  },

  {
    id: 'kanban',
    name: 'Kanban',
    description: '3 colonnes : À faire · En cours · Terminé',
    emoji: '📊',
    elements: [
      text(60, 40, '📊 Kanban', 28, true),

      // À faire
      rect(60, 100, 280, 500, '#1e1e2e', '#f38ba8'),
      text(80, 110, '📋 À faire', 15, true),
      rect(70, 140, 260, 60, '#313244', '#45475a'),
      text(82, 155, 'Tâche 1', 13),
      rect(70, 210, 260, 60, '#313244', '#45475a'),
      text(82, 225, 'Tâche 2', 13),

      // En cours
      rect(360, 100, 280, 500, '#1e1e2e', '#f9e2af'),
      text(380, 110, '⚙️ En cours', 15, true),
      rect(370, 140, 260, 60, '#313244', '#45475a'),
      text(382, 155, 'Tâche 3', 13),

      // Terminé
      rect(660, 100, 280, 500, '#1e1e2e', '#a6e3a1'),
      text(680, 110, '✅ Terminé', 15, true),
      rect(670, 140, 260, 60, '#313244', '#45475a'),
      text(682, 155, 'Tâche 4', 13),
    ],
  },

  {
    id: 'architecture',
    name: 'Architecture',
    description: 'Diagramme système : frontend · backend · DB · services',
    emoji: '🏗️',
    elements: [
      text(380, 20, '🏗️ Architecture', 24, true),

      // Frontend
      rect(80, 100, 200, 80, '#89b4fa', '#89b4fa'),
      text(125, 128, '🌐 Frontend', 14),

      // API Gateway
      rect(390, 100, 220, 80, '#cba6f7', '#cba6f7'),
      text(435, 128, '⚡ API / Gateway', 14),

      // Backend
      rect(680, 100, 200, 80, '#f9e2af', '#f9e2af'),
      text(730, 128, '🔧 Backend', 14),

      // DB
      rect(680, 280, 200, 80, '#a6e3a1', '#a6e3a1'),
      text(742, 308, '🗄️ DB', 14),

      // Cache
      rect(390, 280, 220, 80, '#f38ba8', '#f38ba8'),
      text(455, 308, '⚡ Cache', 14),

      // Auth
      rect(80, 280, 200, 80, '#94e2d5', '#94e2d5'),
      text(140, 308, '🔒 Auth', 14),
    ],
  },
];

export const getTemplate = (id: string) => CANVAS_TEMPLATES.find(t => t.id === id);
