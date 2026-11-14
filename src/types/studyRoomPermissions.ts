export type StudyRoomPlaybackPermission = {
  room_id: string;
  user_id: string;
  can_play_pause: boolean;
  can_seek: boolean;
  updated_at: string;
};

export type SetStudyRoomPlaybackPermission = {
  roomId: string;
  userId: string;
  canPlayPause: boolean;
  canSeek: boolean;
};
