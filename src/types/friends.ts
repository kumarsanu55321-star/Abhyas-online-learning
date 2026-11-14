export type AbhyasProfile = {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

export type FriendRequest = {
  id: string;
  sender_id: string;
  receiver_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  created_at: string;
};

export type Friendship = {
  user_low_id: string;
  user_high_id: string;
  created_at: string;
};

export type ActiveStudyRoom = { id: string; name: string; room_code: string };

