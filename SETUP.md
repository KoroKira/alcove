# Guide d'installation

Ce guide t'explique comment installer et lancer **Alcove** sur macOS en moins de 5 minutes.

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
git clone https://github.com/KoroKira/alcove.git
cd alcove
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

Une fois que tu vois `Alcove → http://localhost:8000` dans le terminal, ouvre ton navigateur sur :

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
cd alcove
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

Depuis la refonte browser-side, **le chat parle directement à ton Ollama local** (pas de proxy serveur). Vérifie :

```bash
# 1. Ollama tourne ?
ollama serve

# 2. Il répond bien sur ce port ?
curl http://localhost:11434/api/tags
```

**Si Alcove est servi via une URL différente de `http://localhost` (par ex. un self-host via Tailscale HTTPS), il faut aussi autoriser cette origine dans Ollama :**

```bash
# Mac (permanent, à faire une seule fois puis relancer Ollama)
launchctl setenv OLLAMA_ORIGINS "https://alcove-server.<ton-tailnet>.ts.net"

# Ou au lancement manuel :
OLLAMA_ORIGINS='*' ollama serve
```

Sur Windows : Panneau de config → Variables d'env système → ajouter `OLLAMA_ORIGINS=*` (personnel, single-user) puis relancer Ollama.

**Ollama sur une autre URL ?** Ajoute dans la console DevTools du navigateur : `localStorage.setItem('alcove_ollama_url', 'http://192.168.1.50:11434')`, puis reload la page.

### Réinitialiser complètement

```bash
# Supprimer la base de données et recommencer
dropdb pad
bash scripts/run.sh
```

---

## Windows

Homebrew n'existe pas sous Windows, donc le mode local utilise Docker (déjà
nécessaire de toute façon pour beaucoup d'usages) à la place, uniquement pour
PostgreSQL et Redis — le backend et le frontend tournent nativement, comme
sur Mac.

### Prérequis

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (pour Postgres + Redis uniquement)
- Python 3.11/3.12/3.13, Node.js, Yarn
- [Ollama pour Windows](https://ollama.com/download/windows) (IA locale, optionnel) — ou `winget install Ollama.Ollama`

### Lancer

```powershell
git clone https://github.com/KoroKira/alcove.git
cd alcove
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
```

Le script `scripts/run.ps1` :
- démarre PostgreSQL + Redis via `scripts/docker-compose.local.yml` (conteneurs Docker légers, pas le stack Keycloak/Coder du mode partage) ;
- crée le virtualenv Python et installe les dépendances backend ;
- installe les dépendances frontend (`yarn install`) et lance Vite ;
- démarre Ollama automatiquement s'il est installé ;
- lance le backend FastAPI sur [http://localhost:8000](http://localhost:8000).

### Limitation connue

Le **terminal embarqué** (pad "Terminal", basé sur `ttyd`) n'est pas disponible
sous Windows — pas de build fiable. Le reste de l'app fonctionne normalement.

### Arrêter / relancer

`Ctrl+C` arrête le backend, Vite et Ollama. Les conteneurs Docker restent actifs ;
pour les arrêter : `docker compose -f scripts/docker-compose.local.yml stop`.
Pour relancer plus tard : rejouer `scripts\run.ps1`.

---

## Pour aller plus loin

- **Sync locale** : tes pads canvas sont automatiquement sauvegardés en `.excalidraw` dans `~/Documents/pads/`
- **Import Obsidian** : tu peux importer un vault Obsidian directement depuis l'interface
- **Export** : chaque document peut être exporté en `.md`, PDF ou ZIP

---

## Questions ?

Ouvre une issue sur le dépôt GitHub ou contacte-moi directement.
