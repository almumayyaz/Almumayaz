/// <reference types="youtube" />

export interface YouTubePlayerOptions {
  videoId: string;
  width?: number | string;
  height?: number | string;
  playerVars?: YT.PlayerVars;
}

export interface PlayerState {
  isPlaying: boolean;
  isReady: boolean;
  isBuffering: boolean;
  currentTime: number;
  duration: number;
  progress: number; // 0–100
  volume: number;
  ended: boolean;
}

export interface VideoProgress {
  seconds: number;
  percent: number;
  duration: number;
}

export interface PlayerEvents {
  onPlay?: () => void;
  onPause?: () => void;
  onEnd?: () => void;
  onStateChange?: (state: number) => void;
  onError?: (error: number) => void;
  onProgress?: (progress: VideoProgress) => void;
  onBuffering?: (isBuffering: boolean) => void;
  onReady?: () => void;
}

export interface CustomYouTubePlayerProps {
  videoId: string;
  lessonId?: string;
  courseId?: string;
  studentId?: string;
  onProgress?: (progress: VideoProgress) => void;
  onCompleted?: () => void;
  className?: string;
}

export const PLAYER_STATES = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;
