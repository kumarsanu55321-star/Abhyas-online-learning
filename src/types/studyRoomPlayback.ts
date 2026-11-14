export type PlaybackStatus = 'playing' | 'paused';

export type StudyRoomPlayback = {
  room_id: string;
  host_id: string;
  video_id: string | null;
  playback_status: PlaybackStatus;
  position_seconds: number;
  updated_at: string;
};

export type UpdateStudyRoomPlayback = {
  roomId: string;
  videoId: string | null;
  status: PlaybackStatus;
  currentTime: number;
};
