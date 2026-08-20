/**
 * "Listen" button (chantier #13) — reads a document's visible text aloud via
 * the Web Speech API. `getText` is called lazily on click so callers don't
 * need to compute/extract text unless the user actually presses play.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, Pause, Play, Square } from 'lucide-react';
import { speak, pauseTTS, resumeTTS, stopTTS, getTTSState, onTTSStateChange, isTTSSupported, TTSState } from '../lib/tts';

interface Props {
  getText: () => string;
  lang: 'fr' | 'en';
  className?: string;
}

export default function ListenButton({ getText, lang, className }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<TTSState>(getTTSState());
  // Whether THIS button instance is the one currently driving playback — the
  // module-level TTS state is global (only one utterance plays at a time
  // across the whole app), so a different pad's button shouldn't show
  // "playing" just because some other Listen button started it.
  const [isMine, setIsMine] = useState(false);

  useEffect(() => onTTSStateChange(s => {
    setState(s);
    if (s === 'idle') setIsMine(false);
  }), []);

  const handleClick = useCallback(() => {
    if (isMine && state === 'playing') { pauseTTS(); return; }
    if (isMine && state === 'paused') { resumeTTS(); return; }
    const text = getText();
    if (!text.trim()) return;
    speak(text, lang);
    setIsMine(true);
  }, [isMine, state, getText, lang]);

  const handleStop = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    stopTTS();
    setIsMine(false);
  }, []);

  if (!isTTSSupported()) return null;

  const active = isMine && state !== 'idle';
  const icon = active && state === 'playing' ? <Pause size={12} /> : active ? <Play size={12} /> : <Volume2 size={12} />;
  const label = active && state === 'playing'
    ? t('ai.listenPause', { defaultValue: 'Pause' })
    : t('ai.listen', { defaultValue: 'Écouter' });

  return (
    <button className={className ?? 'document-pad__toolbar-btn'} onClick={handleClick} title={label}>
      {icon} {label}
      {active && (
        <span
          onClick={handleStop}
          title={t('ai.listenStop', { defaultValue: 'Arrêter' })}
          style={{ display: 'inline-flex', marginLeft: 2 }}
        >
          <Square size={9} />
        </span>
      )}
    </button>
  );
}
