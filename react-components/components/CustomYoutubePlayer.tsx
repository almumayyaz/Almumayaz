'use client';

import React, { useRef, useCallback, useEffect, useState } from 'react';
import { useYoutubePlayer } from '../hooks/useYoutubePlayer';
import type {
  CustomYouTubePlayerProps,
  VideoProgress,
} from '../types/youtube';
import styles from '../styles/youtube-player.module.css';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function CustomYouTubePlayer({
  videoId,
  lessonId,
  courseId,
  studentId,
  onProgress: onProgressProp,
  onCompleted,
  className,
}: CustomYouTubePlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedRef = useRef(false);

  // Track 90%+ for completion callback
  const handleProgress = useCallback(
    (progress: VideoProgress) => {
      onProgressProp?.(progress);

      if (progress.percent >= 90 && !completedRef.current) {
        completedRef.current = true;
        onCompleted?.();
      }
    },
    [onProgressProp, onCompleted],
  );

  const handleError = useCallback((code: number) => {
    const messages: Record<number, string> = {
      2: 'رابط الفيديو غير صالح',
      5: 'تعذر تشغيل الفيديو، قد يكون محمياً بكلمة مرور',
      100: 'الفيديو غير متاح أو تم حذفه',
      101: 'لا يُسمح بتضمين هذا الفيديو',
      150: 'لا يُسمح بتضمين هذا الفيديو',
    };
    setError(messages[code] || 'حدث خطأ أثناء تشغيل الفيديو');
  }, []);

  const { playerState, togglePlay, seekTo } = useYoutubePlayer({
    videoId,
    containerRef,
    events: {
      onProgress: handleProgress,
      onError: handleError,
      onEnd: () => {
        if (!completedRef.current) {
          completedRef.current = true;
          onCompleted?.();
        }
      },
    },
    playerVars: {
      /*
       * YouTube playerVars reference:
       * https://developers.google.com/youtube/player_parameters
       *
       * Key restrictions:
       * - controls=0       hides player controls (logo still visible)
       * - modestbranding=1  reduces YouTube logo size
       * - rel=0            prevents related videos from same channel
       *                    (NOTE: YouTube deprecated rel=0 for channel-wide
       *                     control; now it only affects the current video)
       * - iv_load_policy=3 hides video annotations
       * - fs=0             removes fullscreen button
       * - disablekb=1      disables keyboard controls
       * - playsinline=1    plays inline on iOS
       * - origin=...       restricts domain for API
       *
       * What CANNOT be removed by API:
       * - YouTube logo (small, bottom-right) → covered by CSS ::after
       * - "Watch on YouTube" text on hover   → covered by transparent overlay
       * - End-screen suggested videos        → see note above (rel=0)
       */
      controls: 0,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      playsinline: 1,
      enablejsapi: 1,
      disablekb: 1,
      fs: 0,
    },
  });

  // Auto-hide controls after inactivity
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (playerState.isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  }, [playerState.isPlaying]);

  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      const seconds = ratio * playerState.duration;
      seekTo(seconds);
    },
    [playerState.duration, seekTo],
  );

  // Cleanup hide timer
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  // Reset completed state when videoId changes
  useEffect(() => {
    completedRef.current = false;
    setError(null);
  }, [videoId]);

  if (!videoId) {
    return (
      <div className={`${styles.wrapper} ${className ?? ''}`}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.5)',
            fontSize: 14,
          }}
        >
          لا يوجد فيديو
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${styles.wrapper} ${className ?? ''}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => playerState.isPlaying && setShowControls(false)}
    >
      {/* YouTube API replaces this div with an iframe */}
      <div ref={containerRef} className={styles.playerContainer} />

      {/* Cover YouTube logo at bottom-right */}
      <div className={styles.logoCover} />

      {/* Loading spinner */}
      {playerState.isBuffering && !playerState.isPlaying && (
        <div className={styles.spinner} />
      )}

      {/* Center play button (visible when paused) */}
      <button
        className={`${styles.centerPlayBtn} ${
          playerState.isPlaying ? styles.centerPlayBtnHidden : ''
        }`}
        onClick={(e) => {
          e.stopPropagation();
          togglePlay();
        }}
        aria-label={playerState.isPlaying ? 'إيقاف' : 'تشغيل'}
      >
        {playerState.ended ? (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.65 6.35A7.96 7.96 0 0012 4a8 8 0 100 16c4.42 0 8-3.58 8-8h-2a6 6 0 11-9.33-4.69l1.5 1.5A4 4 0 1014 8V4l-3.76 3.76L12 10.5 16 6.5z" />
          </svg>
        ) : (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {/* Bottom controls bar */}
      <div
        className={`${styles.controlsBar} ${
          showControls ? styles.controlsBarVisible : ''
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Small play/pause in control bar */}
        <button
          className={styles.controlPlayBtn}
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          aria-label={playerState.isPlaying ? 'إيقاف' : 'تشغيل'}
        >
          {playerState.isPlaying ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Progress bar */}
        <div className={styles.progressWrap} onClick={handleProgressClick}>
          <div
            className={styles.progressFill}
            style={{ width: `${playerState.progress}%` }}
          >
            <div className={styles.progressThumb} />
          </div>
        </div>

        {/* Time display */}
        <span className={styles.timeDisplay}>
          {formatTime(playerState.currentTime)} /{' '}
          {formatTime(playerState.duration)}
        </span>
      </div>

      {/* Error overlay */}
      {error && (
        <div className={styles.errorOverlay}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="#e50914">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
          <p>{error}</p>
          <button onClick={() => setError(null)}>إعادة المحاولة</button>
        </div>
      )}
    </div>
  );
}
