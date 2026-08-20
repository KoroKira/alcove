import React, { useState } from 'react';
import { PenLine, FileText, Columns3, GanttChart, ArrowRight, Zap, BookOpen, CheckCircle2, Loader } from 'lucide-react';
import { useOllamaModels } from '../hooks/useOllama';
import OllamaSetup from './OllamaSetup';
import './Onboarding.scss';

interface Props {
  onDone: () => void;
  onCreatePad: (type: 'canvas' | 'document' | 'kanban' | 'gantt') => void;
  /** Seed the "Guide Alcove" pad. `open: true` selects it right away. */
  onSeedWelcome: (opts: { open: boolean }) => void;
}

// 4 steps: welcome → local-AI check (Alcove's own differentiator vs cloud
// tools like Recall — silently broken AI is a much worse first impression
// than a broken feature the user hasn't tried yet) → first pad → shortcuts.
const STEPS = 4;

export default function Onboarding({ onDone, onCreatePad, onSeedWelcome }: Props) {
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const ollama = useOllamaModels();

  const next = () => {
    if (step < STEPS - 1) setStep(s => s + 1);
    else finish({ open: false });
  };

  // Always seed the guide once (so it's discoverable later); only open it now
  // when the user explicitly asks to.
  const finish = ({ open }: { open: boolean }) => {
    onSeedWelcome({ open });
    localStorage.setItem('alcove_onboarded', '1');
    onDone();
  };

  const skip = () => { localStorage.setItem('alcove_onboarded', '1'); onDone(); };

  return (
    <div className="onboarding">
      {/* Progress dots */}
      <div className="onboarding__dots">
        {Array.from({ length: STEPS }).map((_, i) => (
          <span key={i} className={`onboarding__dot${i === step ? ' onboarding__dot--active' : i < step ? ' onboarding__dot--done' : ''}`} />
        ))}
      </div>

      {/* Step 0: Welcome */}
      {step === 0 && (
        <div className="onboarding__step">
          <div className="onboarding__logo">
            <Zap size={48} />
          </div>
          <h1 className="onboarding__h1">Bienvenue sur<br /><span className="onboarding__accent">Alcove</span></h1>
          <p className="onboarding__p">Ton espace de travail tout-en-un — canvas, notes, kanban, gantt, IA. Tout au même endroit.</p>
          <button className="onboarding__btn onboarding__btn--primary" onClick={next}>
            Commencer <ArrowRight size={16} />
          </button>
          <button className="onboarding__skip" onClick={skip}>Passer</button>
        </div>
      )}

      {/* Step 1: Local AI check — Alcove's AI runs 100% on your own machine
          via Ollama, unlike cloud tools. A new user who skips this and only
          discovers it's not configured deep inside some other feature gets a
          confusing silent failure instead of a clear "here's what to do". */}
      {step === 1 && (
        <div className="onboarding__step onboarding__step--wide">
          {ollama.available === null && (
            <>
              <div className="onboarding__logo">
                <Loader size={40} className="onboarding__spin" />
              </div>
              <h2 className="onboarding__h2">Vérification de l'IA locale…</h2>
              <p className="onboarding__p">On regarde si Ollama tourne déjà sur ta machine.</p>
            </>
          )}
          {ollama.available === true && (
            <>
              <div className="onboarding__logo onboarding__logo--done">
                <CheckCircle2 size={40} />
              </div>
              <h2 className="onboarding__h2">IA locale détectée ✓</h2>
              <p className="onboarding__p">
                Ollama tourne avec {ollama.modelNames.length} modèle{ollama.modelNames.length > 1 ? 's' : ''} installé{ollama.modelNames.length > 1 ? 's' : ''}
                {ollama.modelNames.length > 0 && <> (<strong>{ollama.modelNames.slice(0, 3).join(', ')}</strong>{ollama.modelNames.length > 3 ? '…' : ''})</>}.
                Le chat, les résumés et la génération de flashcards sont prêts à l'emploi.
              </p>
              <button className="onboarding__btn onboarding__btn--primary" onClick={next}>
                Continuer <ArrowRight size={16} />
              </button>
            </>
          )}
          {ollama.available === false && (
            <>
              <OllamaSetup onDone={next} />
              <button className="onboarding__skip" onClick={next}>Configurer plus tard</button>
            </>
          )}
        </div>
      )}

      {/* Step 2: Create first pad */}
      {step === 2 && (
        <div className="onboarding__step">
          <h2 className="onboarding__h2">Crée ton premier pad</h2>
          <p className="onboarding__p">Choisis le type de pad que tu veux utiliser en premier.</p>
          <div className="onboarding__pad-grid">
            {[
              { type: 'canvas' as const, icon: <PenLine size={24} />, label: 'Canvas', desc: 'Dessine et brainstorme librement', color: '#cba6f7' },
              { type: 'document' as const, icon: <FileText size={24} />, label: 'Document', desc: 'Notes, wiki, markdown', color: '#89b4fa' },
              { type: 'kanban' as const, icon: <Columns3 size={24} />, label: 'Kanban', desc: 'Gère tes tâches en colonnes', color: '#a6e3a1' },
              { type: 'gantt' as const, icon: <GanttChart size={24} />, label: 'Gantt', desc: 'Planifie tes projets', color: '#fab387' },
            ].map(({ type, icon, label, desc, color }) => (
              <button
                key={type}
                className={`onboarding__pad-card${picked === type ? ' onboarding__pad-card--active' : ''}`}
                style={{ '--card-color': color } as React.CSSProperties}
                onClick={() => { setPicked(type); onCreatePad(type); next(); }}
              >
                <span className="onboarding__pad-icon">{icon}</span>
                <span className="onboarding__pad-label">{label}</span>
                <span className="onboarding__pad-desc">{desc}</span>
              </button>
            ))}
          </div>
          <button className="onboarding__skip" onClick={next}>Décider plus tard</button>
        </div>
      )}

      {/* Step 3: Ready */}
      {step === 3 && (
        <div className="onboarding__step">
          <div className="onboarding__logo onboarding__logo--done">✓</div>
          <h2 className="onboarding__h2">Tu es prêt !</h2>
          <p className="onboarding__p">Quelques raccourcis pour bien démarrer :</p>
          <div className="onboarding__tips">
            {[
              { kbd: '⌘P', desc: 'Palette de commandes — accès rapide à tout' },
              { kbd: '⌘N', desc: 'Nouveau pad' },
              { kbd: '⌘⇧N', desc: 'Capture rapide vers le pad Scratch' },
              { kbd: '⌘/', desc: 'Tous les raccourcis' },
            ].map(({ kbd, desc }) => (
              <div key={kbd} className="onboarding__tip">
                <kbd className="onboarding__kbd">{kbd}</kbd>
                <span>{desc}</span>
              </div>
            ))}
          </div>
          <button className="onboarding__btn onboarding__btn--primary" onClick={() => finish({ open: true })}>
            <BookOpen size={16} /> Ouvrir le guide de démarrage
          </button>
          <button className="onboarding__skip" onClick={() => finish({ open: false })}>
            Explorer par moi-même
          </button>
        </div>
      )}
    </div>
  );
}

export function shouldShowOnboarding(): boolean {
  return !localStorage.getItem('alcove_onboarded');
}
