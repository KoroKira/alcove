import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Youtube, ExternalLink, ChevronDown, ChevronUp, RefreshCw, Loader2 } from 'lucide-react';
import type { VideoMeta } from '../lib/videoMeta';
import './VideoEmbed.scss';

/** Ref surface exposed to DocumentPad so timestamp clicks in the preview can
 * drive the same embed the user is watching. */
export interface VideoEmbedHandle {
  seekTo(seconds: number): void;
}

interface Props {
  meta: VideoMeta;
  /** Called by the parent when a chapter is clicked (parent may want to jump
   * both the embed AND scroll the preview to the chapter heading). */
  onChapterClick?: (start: number) => void;
  /** When set: show a "Regenerate report" button; the parent handles the
   * actual re-run and content replacement. `progress` is the latest SSE
   * step message ("Analyse 3/8…"), `busy` disables the button. */
  onRegenerate?: () => void;
  regenerateBusy?: boolean;
  regenerateProgress?: string | null;
}

function fmtHms(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
    : `${m}:${r.toString().padStart(2, '0')}`;
}

// `enablejsapi=1` + `origin` are required for the postMessage seekTo command.
// Cross-origin so we send commands as JSON strings to the iframe.
function buildEmbedSrc(videoId: string, autoplay: boolean, start = 0): string {
  const params = new URLSearchParams({
    enablejsapi: '1',
    rel: '0',
    modestbranding: '1',
    origin: window.location.origin,
  });
  if (autoplay) params.set('autoplay', '1');
  if (start > 0) params.set('start', Math.floor(start).toString());
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

/** Post a `seekTo` command to the YouTube iframe. Uses the "listening handshake
 * → command" contract the JS API expects when the caller doesn't load the SDK. */
function seekIframe(iframe: HTMLIFrameElement, seconds: number) {
  const send = (message: unknown) => {
    try {
      iframe.contentWindow?.postMessage(JSON.stringify(message), '*');
    } catch { /* silently ignore — cross-origin restrictions vary by browser */ }
  };
  send({ event: 'listening', id: 1, channel: 'widget' });
  send({ event: 'command', func: 'seekTo', args: [seconds, true] });
  send({ event: 'command', func: 'playVideo', args: [] });
}

const VideoEmbed = forwardRef<VideoEmbedHandle, Props>(function VideoEmbed(
  { meta, onChapterClick, onRegenerate, regenerateBusy, regenerateProgress }, ref,
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Deferred load: browsers ding you for auto-embedding a YT iframe on every
  // pad open (~600KB of JS + tracking). We show the thumbnail first, load the
  // iframe on first play/seek. Also cheaper on scroll perf.
  const [activated, setActivated] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useImperativeHandle(ref, () => ({
    seekTo(seconds: number) {
      if (!meta.id) {
        // No video id: best we can do is open the source URL with the
        // timestamp in a new tab.
        if (meta.url) window.open(`${meta.url}${meta.url.includes('?') ? '&' : '?'}t=${Math.floor(seconds)}s`, '_blank');
        return;
      }
      if (!activated) {
        // First seek doubles as activation — the iframe mounts with the right
        // start time already applied.
        setActivated(true);
        // Give React a tick to mount the iframe before we try to command it.
        setTimeout(() => iframeRef.current && seekIframe(iframeRef.current, seconds), 250);
        return;
      }
      if (iframeRef.current) seekIframe(iframeRef.current, seconds);
    },
  }), [meta.id, meta.url, activated]);

  const hasVideo = Boolean(meta.id);
  const thumb = meta.thumbnail || (meta.id && `https://i.ytimg.com/vi/${meta.id}/hqdefault.jpg`);

  return (
    <div className={`video-embed${collapsed ? ' video-embed--collapsed' : ''}`}>
      <div className="video-embed__header">
        <Youtube size={14} className="video-embed__logo" />
        {meta.author && <span className="video-embed__author">{meta.author}</span>}
        {meta.duration != null && (
          <span className="video-embed__duration">{fmtHms(meta.duration)}</span>
        )}
        <span className="video-embed__spacer" />
        {onRegenerate && (
          <button
            className="video-embed__regen"
            onClick={onRegenerate}
            disabled={regenerateBusy}
            title={regenerateBusy ? (regenerateProgress || 'Régénération…') : 'Régénérer le rapport avec l\'IA'}
            type="button"
          >
            {regenerateBusy
              ? <Loader2 size={12} className="video-embed__regen-spin" />
              : <RefreshCw size={12} />}
            <span>{regenerateBusy ? (regenerateProgress || 'Régénère…') : 'Régénérer'}</span>
          </button>
        )}
        {meta.url && (
          <a
            className="video-embed__ext"
            href={meta.url}
            target="_blank"
            rel="noreferrer"
            title="Ouvrir sur la source"
          >
            <ExternalLink size={12} />
          </a>
        )}
        <button
          className="video-embed__collapse"
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Déplier' : 'Replier'}
          type="button"
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="video-embed__frame">
            {hasVideo && activated ? (
              <iframe
                ref={iframeRef}
                className="video-embed__iframe"
                src={buildEmbedSrc(meta.id!, true)}
                title="Vidéo source"
                allow="accelerometer; autoplay; encrypted-media; picture-in-picture; web-share"
                allowFullScreen
              />
            ) : (
              <button
                type="button"
                className="video-embed__thumb"
                onClick={() => hasVideo ? setActivated(true) : meta.url && window.open(meta.url, '_blank')}
                title={hasVideo ? 'Lire la vidéo' : 'Ouvrir la source'}
                style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}
              >
                <span className="video-embed__play">▶</span>
              </button>
            )}
          </div>

          {meta.chapters && meta.chapters.length > 0 && (
            <details className="video-embed__chapters">
              <summary>{meta.chapters.length} chapitre(s)</summary>
              <ol className="video-embed__chapters-list">
                {meta.chapters.map((c, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="video-embed__chapter"
                      onClick={() => {
                        const s = c.start_time ?? 0;
                        if (hasVideo) {
                          if (!activated) setActivated(true);
                          setTimeout(() => iframeRef.current && seekIframe(iframeRef.current, s), 250);
                        }
                        onChapterClick?.(s);
                      }}
                    >
                      {c.start_time != null && (
                        <span className="video-embed__chapter-time">{fmtHms(c.start_time)}</span>
                      )}
                      <span className="video-embed__chapter-title">{c.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </div>
  );
});

export default VideoEmbed;
