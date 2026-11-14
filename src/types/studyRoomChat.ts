export type StudyRoomChatMessage = {
  id: string;
  room_id: string;
  user_id: string;
  message: string;
  video_timestamp: number | null;
  created_at: string;
};

export type SendStudyRoomChatMessage = {
  roomId: string;
  message: string;
  videoTimestamp: number | null;
};
