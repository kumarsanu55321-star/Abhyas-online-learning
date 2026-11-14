export type StudyRoomVisibility = 'public' | 'private';
export type StudyRoomStatus = 'active' | 'ended';
export type StudyRoomRole = 'host' | 'participant';

export type StudyRoom = {
  id: string;
  room_code: string;
  name: string;
  subject: string;
  host_id: string;
  youtube_url: string | null;
  visibility: StudyRoomVisibility;
  max_participants: number;
  status: StudyRoomStatus;
  created_at: string;
};

export type StudyRoomParticipant = {
  id: string;
  room_id: string;
  user_id: string;
  display_name: string;
  joined_at: string;
  role: StudyRoomRole;
};

export type StudyRoomDetails = {
  room: StudyRoom;
  participants: StudyRoomParticipant[];
};

export type CreateStudyRoomInput = {
  name: string;
  subject: string;
  youtubeUrl: string | null;
  visibility: StudyRoomVisibility;
  maxParticipants: number;
  displayName: string;
};
