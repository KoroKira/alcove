/**
 * Contenu du pad "Guide Alcove" seedé au premier lancement (depuis l'Onboarding).
 *
 * Ce document est une antisèche VIVANTE : chaque bloc de syntaxe y est montré à la
 * fois en clair (pour copier) et rendu en direct (pour voir le résultat). Comme
 * c'est un vrai pad, il reste dans la liste, éditable, consultable à tout moment —
 * bien plus utile qu'une modale d'onboarding jetable.
 *
 * ⚠️ Si tu ajoutes/modifies une syntaxe supportée par le moteur de rendu
 * (DocumentPad.tsx), pense à la refléter ici pour que le guide reste exact.
 */

export const WELCOME_DOC_TITLE = 'Guide Alcove';

export const WELCOME_DOC_CONTENT = `# 👋 Bienvenue dans Alcove

Ce pad est ton **guide de démarrage**. Il reste dans ta liste — reviens-y quand tu veux.
Modifie-le, casse-le, teste tout : c'est fait pour ça.

> [!TIP]
> Ouvre la palette de commandes avec **⌘K** (ou **Ctrl+K**) pour accéder à tout,
> et tape **/** dans un document pour insérer un bloc (tableau, callout, formule…).

## En 30 secondes

1. **⌘N** → nouveau pad (canvas, document, kanban, gantt…)
2. Dans un document, tape **/** pour les blocs, **[[** pour lier un autre pad
3. **⌘K** ouvre la palette, **⌘/** affiche tous les raccourcis
4. L'icône **✦** en haut à droite du canvas ouvre l'assistant IA (100 % local)

---

## 🔗 Relier tes idées

Le cœur d'Alcove : connecter tes pads entre eux.

- **Wikilink** — écris \`[[nom-du-pad]]\` pour créer un lien. S'il apparaît en rouge,
  c'est que le pad n'existe pas encore — crée-le et le lien s'active.
- **Transclusion** — écris \`![[nom-du-pad]]\` pour **embarquer** le contenu d'un autre
  pad directement ici (il se met à jour tout seul).
- **Graphe** — **⌘⇧G** affiche la carte de tous tes liens.

Exemple de lien vivant (rouge tant que le pad n'existe pas) : [[mes-idées]]

## 💡 Callouts

Mets en valeur une info avec \`> [!TYPE]\`. Types : NOTE, TIP, WARNING, IMPORTANT, CAUTION.

> [!NOTE]
> Une note neutre pour contextualiser.

> [!WARNING]
> Un avertissement pour ne pas te tromper.

## ✅ Tâches & suivi d'habitudes

- [ ] Une tâche à faire
- [x] Une tâche terminée
- [ ] Boire de l'eau :: habit

> La ligne \`… :: habit\` se transforme en tracker 7 jours (coche chaque jour).

## 🧠 Flashcards (révision espacée)

Écris une paire \`Q:\` / \`A:\` et Alcove en fait une carte à réviser (algorithme SM-2,
comme Anki). Le **Flashcard Studio** regroupe toutes tes cartes.

Q: Quel raccourci ouvre la palette de commandes ?
A: ⌘K (ou Ctrl+K)

Q: Comment lie-t-on deux pads ?
A: Avec un wikilink : [[nom-du-pad]]

## 🧮 Maths

Formule en ligne avec \`$…$\` : $e^{i\\pi} + 1 = 0$

Formule en bloc avec \`$$…$$\` :

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

## 📊 Tableaux & diagrammes

| Feature | Raccourci |
|---------|-----------|
| Palette | ⌘K |
| Recherche | ⌘⇧F |
| Graphe | ⌘⇧G |

Diagrammes Mermaid (tape \`/mermaid\`) :

\`\`\`mermaid
flowchart LR
  Idée --> Note --> Projet --> Fait
\`\`\`

---

## ⌨️ Raccourcis à retenir

| Raccourci | Action |
|-----------|--------|
| ⌘K | Palette de commandes |
| ⌘N | Nouveau pad |
| ⌘⇧F | Recherche plein-texte |
| ⌘⇧G | Graphe de connaissances |
| ⌘T | Daily note du jour |
| ⌘⇧N | Capture rapide → Scratch |
| ⌘/ | Tous les raccourcis |

## 🚀 Pour aller plus loin

- **Templates** — **⌘N** propose réunion, projet, rétro, spec…
- **IA locale** — résumé, tags, liens suggérés, RAG, quiz, flashcards auto (via Ollama)
- **Import Obsidian** — récupère un vault existant (\`.md\` + images)
- **Thèmes** — 6 thèmes + un builder pour créer le tien

> [!IMPORTANT]
> Tes notes et ton IA **ne quittent jamais ta machine**. Tout est local.

Bon travail dans ton Alcove 🏔️
`;
