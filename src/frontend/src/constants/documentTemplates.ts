const today = () =>
  new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export interface DocumentTemplate {
  id: string;
  icon: string;
  titleKey: string;
  descKey: string;
  content: () => string;
}

export const DOCUMENT_TEMPLATES: DocumentTemplate[] = [
  {
    id: 'blank',
    icon: '📄',
    titleKey: 'templates.blank',
    descKey: 'templates.blank_desc',
    content: () => '',
  },
  {
    id: 'meeting',
    icon: '🤝',
    titleKey: 'templates.meeting',
    descKey: 'templates.meeting_desc',
    content: () => `# Réunion — ${today()}

## Participants
-

## Ordre du jour
1.
2.
3.

## Notes & décisions

> [!NOTE]
> Ajoutez vos notes ici

## Actions
- [ ]
`,
  },
  {
    id: 'project',
    icon: '🚀',
    titleKey: 'templates.project',
    descKey: 'templates.project_desc',
    content: () => `# Nom du projet

## Objectif
> Quelle est la mission principale de ce projet ?

## Jalons
| Étape | Description | Échéance | Statut |
|-------|-------------|----------|--------|
| M1    |             |          | 🔄     |
| M2    |             |          | ⏳     |

## Risques
| Risque | Probabilité | Impact | Mitigation |
|--------|-------------|--------|------------|
|        | Moyen       | Haut   |            |

## Ressources
-

## Notes
`,
  },
  {
    id: 'daily',
    icon: '📅',
    titleKey: 'templates.daily',
    descKey: 'templates.daily_desc',
    content: () => `# Daily — ${today()}

## Hier
-

## Aujourd'hui
-

## Blocages
-
`,
  },
  {
    id: 'retro',
    icon: '🔄',
    titleKey: 'templates.retro',
    descKey: 'templates.retro_desc',
    content: () => `# Rétrospective — ${today()}

## Ce qui a bien marché 🟢
-

## À améliorer 🟡
-

## À arrêter 🔴
-

## Actions pour le prochain sprint
- [ ]
`,
  },
  {
    id: 'spec',
    icon: '📋',
    titleKey: 'templates.spec',
    descKey: 'templates.spec_desc',
    content: () => `# Spécification — [Titre]

## Contexte
> Pourquoi ce projet/feature est-il nécessaire ?

## Exigences fonctionnelles
1.
2.

## Exigences non-fonctionnelles
- Performance :
- Sécurité :
- Scalabilité :

## Critères d'acceptation
- [ ]
- [ ]

## Hors périmètre
-

## Références
-
`,
  },
];
