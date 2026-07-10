'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import type { PlayerState, PlayerEvents, VideoProgress } from '../types/youtube';
import { PLAYER_STATES } from '../types/youtube';

interface UseYouTubePlayerOptions {
  videoId: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  events?: PlayerEvents;
  playerVars?: YT.PlayerVars;
}

export function useYoutubePlayer({
  videoId,
  containerRef,
  events,
  playerVars = {},
}: UseYouTubePlayerOptions) {
  const [playerState, setPlayerState] = useState<PlayerState>({
    isPlaying: false,
    isReady: false,
    isBuffering: false,
    currentTime: 0,
    duration: 0,
    progress: 0,
    volume: 100,
    ended: false,
  });

  const playerRef = useRef<YT.Player | null>(null);
  const apiReadyRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const completedRef = useRef(false);

  const syncProgress = useCallback(() => {
    const player = playerRef.current;
    if (!player || !player.getCurrentTime || !player.getDuration) return;
    try {
      const currentTime = player.getCurrentTime();
      const duration = player.getDuration();
      if (!duration || isNaN(duration)) return;
      const percent = (currentTime / duration) * 100;

      setPlayerState((prev) => ({
        ...prev,
        currentTime,
        duration,
        progress: Math.min(percent, 100),
      }));

      eventsRef.current?.onProgress?.({
        seconds: currentTime,
        percent: Math.min(percent, 100),
        duration,
      });

      // Detect completion (≥ 90% watched = completed for tracking)
      if (percent >= 90 && !completedRef.current) {
        completedRef.current = true;
        // Parent can use onProgress with percent >= 90 to trigger onCompleted
      }
    } catch {
      // Silently handle API call failures during cleanup
    }
  }, []);

  const startProgressSync = useCallback(() => {
    stopProgressSync();
    const loop = () => {
      syncProgress();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [syncProgress]);

  const stopProgressSync = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const playerVarsRef = useRef(playerVars);
  playerVarsRef.current = playerVars;

  // Load YouTube IFrame API once
  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.YT && typeof window.YT.Player === 'function') {
      apiReadyRef.current = true;
      return;
    }

    const existingScript = document.getElementById('youtube-iframe-api');
    if (existingScript) {
      const checkReady = setInterval(() => {
        if (window.YT && typeof window.YT.Player === 'function') {
          apiReadyRef.current = true;
          clearInterval(checkReady);
        }
      }, 200);
      return () => clearInterval(checkReady);
    }

    const tag = document.createElement('script');
    tag.id = 'youtube-iframe-api';
    tag.src = 'https://www.youtube.com/iframe_api';

    const firstScript = document.getElementsByTagName('script')[0];
    firstScript?.parentNode?.insertBefore(tag, firstScript);

    let checkInterval: ReturnType<typeof setInterval> | null = null;

    // YouTube calls onYouTubeIframeAPIReady globally
    (window as unknown as Record<string, unknown>).onYouTubeIframeAPIReady = () => {
      apiReadyRef.current = true;
      if (checkInterval) clearInterval(checkInterval);
    };

    checkInterval = setInterval(() => {
      if (window.YT && typeof window.YT.Player === 'function') {
        apiReadyRef.current = true;
        if (checkInterval) clearInterval(checkInterval);
      }
    }, 200);

    return () => {
      if (checkInterval) clearInterval(checkInterval);
    };
  }, []);

  // Initialize player when API is ready and container exists
  useEffect(() => {
    if (!apiReadyRef.current) return;
    if (!containerRef.current) return;
    if (playerRef.current) return;

    const defaults: YT.PlayerVars = {
      controls: 0,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      playsinline: 1,
      enablejsapi: 1,
      disablekb: 1,
      fs: 0,
      origin: typeof window !== 'undefined' ? window.location.origin : undefined,
    };

    const mergedVars = { ...defaults, ...playerVarsRef.current };

    playerRef.current = new YT.Player(containerRef.current, {
      videoId,
      height: '100%',
      width: '100%',
      playerVars: mergedVars,
      events: {
        onReady: () => {
          try {
            const duration = playerRef.current?.getDuration() || 0;
            setPlayerState((prev) => ({
              ...prev,
              isReady: true,
              duration,
            }));
            eventsRef.current?.onReady?.();
          } catch {
            // Player might be destroyed before this fires
          }
        },
        onStateChange: (event: YT.OnStateChangeEvent) => {
          const state = event.data;

          setPlayerState((prev) => {
            switch (state) {
              case PLAYER_STATES.PLAYING:
                return { ...prev, isPlaying: true, isBuffering: false, ended: false };
              case PLAYER_STATES.PAUSED:
                return { ...prev, isPlaying: false, isBuffering: false };
              case PLAYER_STATES.BUFFERING:
                return { ...prev, isBuffering: true };
              case PLAYER_STATES.ENDED:
                return { ...prev, isPlaying: false, isBuffering: false, ended: true, progress: 100 };
              default:
                return prev;
            }
          });

          switch (state) {
            case PLAYER_STATES.PLAYING:
              startProgressSync();
              eventsRef.current?.onPlay?.();
              break;
            case PLAYER_STATES.PAUSED:
              stopProgressSync();
              eventsRef.current?.onPause?.();
              break;
            case PLAYER_STATES.BUFFERING:
              eventsRef.current?.onBuffering?.(true);
              break;
            case PLAYER_STATES.ENDED:
              stopProgressSync();
              completedRef.current = true;
              eventsRef.current?.onEnd?.();
              break;
          }

          eventsRef.current?.onStateChange?.(state);
        },
        onError: (event: YT.OnErrorEvent) => {
          eventsRef.current?.onError?.(event.data);
        },
      },
    });

    // Cleanup on unmount
    return () => {
      stopProgressSync();
      if (playerRef.current && playerRef.current.destroy) {
        try {
          playerRef.current.destroy();
        } catch {
          // Already destroyed
        }
      }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const play = useCallback(() => {
    playerRef.current?.playVideo();
  }, []);

  const pause = useCallback(() => {
    playerRef.current?.pauseVideo();
  }, []);

  const togglePlay = useCallback(() => {
    if (!playerRef.current) return;
    const state = playerRef.current.getPlayerState();
    if (state === PLAYER_STATES.PLAYING) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  }, []);

  const seekTo = useCallback((seconds: number) => {
    playerRef.current?.seekTo(seconds, true);
  }, []);

  const setVolume = useCallback((vol: number) => {
    const clamped = Math.max(0, Math.min(100, vol));
    playerRef.current?.setVolume(clamped);
    setPlayerState((prev) => ({ ...prev, volume: clamped }));
  }, []);

  // Cleanup progress on unmount
  useEffect(() => {
    return () => {
      stopProgressSync();
    };
  }, [stopProgressSync]);

  return {
    playerState,
    playerRef,
    play,
    pause,
    togglePlay,
    seekTo,
    setVolume,
    syncProgress,
  };
}
