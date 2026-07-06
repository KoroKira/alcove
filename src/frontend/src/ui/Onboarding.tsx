import React, { useState } from 'react';
import { PenLine, FileText, Columns3, GanttChart, ArrowRight, Zap } from 'lucide-react';
import './Onboarding.scss';

interface Props {
  onDone: () => void;
  onCreatePad: (type: 'canvas' | 'document' | 'kanban' | 'gantt') => void;
}

const STEPS = 3;

export default function Onboarding({ onDone, onCreatePad }: Props) {
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);

  const next = () => {
    if (step < STEPS - 1) setStep(s => s + 1);
    else { localStorage.setItem('alcove_onboarded', '1'); onDone(); }
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

      {/* Step 1: Create first pad */}
      {step === 1 && (
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

      {/* Step 2: Ready */}
      {step === 2 && (
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
          <button className="onboarding__btn onboarding__btn--primary" onClick={next}>
            C'est parti !
          </button>
        </div>
      )}
    </div>
  );
}

export function shouldShowOnboarding(): boolean {
  return !localStorage.getItem('alcove_onboarded');
}
