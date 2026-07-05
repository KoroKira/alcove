# Guide d'installation

Ce guide t'explique comment installer et lancer **alko-pad.ws** sur macOS en moins de 5 minutes.

> Pas besoin d'être développeur. Si tu sais ouvrir un terminal, tu peux le faire.

---

## Ce que c'est

Un espace de travail personnel : tableau blanc (dessin libre), éditeur de notes Markdown, kanban, Gantt, et un assistant IA qui tourne entièrement sur ta machine (pas de cloud, pas d'abonnement).

---

## Prérequis

### 1. Homebrew (gestionnaire de paquets macOS)

Ouvre le **Terminal** (cherche "Terminal" dans Spotlight avec `Cmd+Espace`) et colle cette commande :

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Suis les instructions à l'écran. Ça prend ~2 minutes.

> **Tu as déjà Homebrew ?** Tape `brew --version` dans le terminal. Si tu vois un numéro de version, c'est bon.

### 2. Git

Git est normalement pré-installé sur macOS. Vérifie avec :

```bash
git --version
```

Si ce n'est pas le cas : `brew install git`

---

## Installation

### Étape 1 — Télécharger le projet

```bash
git clone https://github.com/guilhem/alko-pad.ws.git
cd alko-pad.ws
```

### Étape 2 — Lancer

```bash
bash scripts/run.sh
```

Le script va automatiquement :
- Installer PostgreSQL et Redis (base de données + cache)
- Installer les dépendances Python et Node.js
- Créer le fichier de configuration
- Démarrer tous les services

La première fois ça prend ~3-5 minutes. Les fois suivantes, quelques secondes.

### Étape 3 — Ouvrir l'app

Une fois que tu vois `pad.ws → http://localhost:8000` dans le terminal, ouvre ton navigateur sur :

**[http://localhost:8000](http://localhost:8000)**

Tu es automatiquement connecté. Crée un pad en cliquant sur **+** dans la barre du haut.

---

## Arrêter l'app

Dans le terminal où l'app tourne, appuie sur `Ctrl+C`.

Pour arrêter les bases de données aussi :

```bash
brew services stop postgresql@16
brew services stop redis
```

---

## Relancer l'app

La prochaine fois, retourne dans le dossier et relance :

```bash
cd alko-pad.ws
bash scripts/run.sh
```

---

## IA locale (optionnel mais recommandé)

L'assistant IA de l'app utilise **Ollama** — un moteur d'IA qui tourne entièrement sur ta machine. Tes données ne quittent jamais ton ordinateur.

### Installer Ollama

```bash
brew install ollama
```

### Télécharger un modèle

```bash
# Modèle léger et rapide (~1 Go) — recommandé pour commencer
ollama pull deepseek-r1:1.5b

# Autres options
ollama pull llama3.2      # Polyvalent (~2 Go)
ollama pull mistral       # Très capable (~4 Go)
```

Le téléchargement prend quelques minutes selon ta connexion.

### Utiliser l'IA dans l'app

L'app détecte Ollama automatiquement. Clique sur l'icône **✦** (étoile) en haut à droite pour ouvrir le panneau IA. Si Ollama n'est pas lancé, l'app le démarre toute seule.

Tu peux ensuite :
- **Poser des questions** librement
- **Résumer** le document ouvert
- **Générer des tags** automatiquement
- **Rechercher** dans toutes tes notes par sens (RAG)
- **Créer des flashcards** depuis tes documents

---

## Raccourcis utiles

| Raccourci | Action |
|---|---|
| `Cmd + N` | Nouveau canvas |
| `Cmd + K` | Palette de commandes (tout ce qu'on peut faire) |
| `Cmd + Shift + F` | Recherche dans toutes les notes |
| `Cmd + D` | Dashboard (vue de tous les pads) |
| `Cmd + J` | Note du jour |

---

## Problèmes courants

### L'app ne démarre pas

```bash
# Vérifie que PostgreSQL tourne
brew services list | grep postgresql

# Redémarre si nécessaire
brew services restart postgresql@16
brew services restart redis
```

### "Port already in use"

Un autre service utilise le port 8000. Arrête le processus qui l'occupe :

```bash
lsof -ti :8000 | xargs kill -9
```

### L'IA ne répond pas

```bash
# Lance Ollama manuellement
ollama serve

# Dans un autre terminal, teste qu'il répond
curl http://localhost:11434/api/tags
```

### Réinitialiser complètement

```bash
# Supprimer la base de données et recommencer
dropdb pad
bash scripts/run.sh
```

---

## Pour aller plus loin

- **Sync locale** : tes pads canvas sont automatiquement sauvegardés en `.excalidraw` dans `~/Documents/pads/`
- **Import Obsidian** : tu peux importer un vault Obsidian directement depuis l'interface
- **Export** : chaque document peut être exporté en `.md`, PDF ou ZIP

---

## Questions ?

Ouvre une issue sur le dépôt GitHub ou contacte-moi directement.
