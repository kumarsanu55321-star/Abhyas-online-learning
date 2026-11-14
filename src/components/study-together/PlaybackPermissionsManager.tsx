import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { getStudyRoomPlaybackPermissions, removePlaybackPermissionsSubscription, setStudyRoomPlaybackPermission, subscribeToStudyRoomPlaybackPermissions } from '../../services/studyRoomPermissionsService';
import type { StudyRoomParticipant } from '../../types/studyRoom';
import type { StudyRoomPlaybackPermission } from '../../types/studyRoomPermissions';

export default function PlaybackPermissionsManager({ roomId, participants, onClose }: {
  roomId: string;
  participants: StudyRoomParticipant[];
  onClose: () => void;
}) {
  const [permissions, setPermissions] = useState<Map<string, StudyRoomPlaybackPermission>>(new Map());
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState('');
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const rows = await getStudyRoomPlaybackPermissions(roomId);
        if (mounted) {
          setPermissions(new Map(rows.map(row => [row.user_id, row])));
          setError('');
        }
      } catch (loadError) {
        if (mounted) setError(loadError instanceof Error ? loadError.message : 'Could not load playback permissions.');
      } finally { if (mounted) setLoading(false); }
    };

    let channel: RealtimeChannel | null = null;
    try {
      channel = subscribeToStudyRoomPlaybackPermissions(roomId, (row, event) => {
        if (!mounted) return;
        if (row) setPermissions(current => new Map(current).set(row.user_id, row));
        else if (event === 'DELETE') void refresh();
      }, (status, message) => {
        if (!mounted) return;
        setLive(status === 'SUBSCRIBED');
        if (status === 'SUBSCRIBED') void refresh();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setError(message ? `Live permission updates disconnected: ${message}` : 'Live permission updates disconnected. Reconnecting…');
      });
    } catch (subscribeError) {
      setError(subscribeError instanceof Error ? subscribeError.message : 'Could not subscribe to permission updates.');
    }
    void refresh();
    return () => {
      mounted = false;
      if (channel) void removePlaybackPermissionsSubscription(channel);
    };
  }, [roomId]);

  async function update(participant: StudyRoomParticipant, field: 'can_play_pause' | 'can_seek', checked: boolean) {
    const current = permissions.get(participant.user_id);
    const canPlayPause = field === 'can_play_pause' ? checked : current?.can_play_pause ?? false;
    const canSeek = field === 'can_seek' ? checked : current?.can_seek ?? false;
    setSavingKey(`${participant.user_id}:${field}`);
    setError('');
    try {
      await setStudyRoomPlaybackPermission({ roomId, userId: participant.user_id, canPlayPause, canSeek });
      const rows = await getStudyRoomPlaybackPermissions(roomId);
      setPermissions(new Map(rows.map(row => [row.user_id, row])));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update playback permissions.');
    } finally { setSavingKey(''); }
  }

  const learners = participants.filter(person => person.role !== 'host');

  return <div className="room-modal-backdrop playback-permissions-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget && !savingKey) onClose();
  }}>
    <section className="playback-permissions-dialog" role="dialog" aria-modal="true" aria-labelledby="playback-permissions-title">
      <header className="playback-permissions-header">
        <div className="playback-permissions-icon"><ShieldCheck size={19}/></div>
        <div><span className="section-kicker">ROOM HOST</span><h2 id="playback-permissions-title">Manage Playback Permissions</h2><p>Choose which learners can control the shared lecture.</p></div>
        <button type="button" className="room-modal-close" aria-label="Close permissions" onClick={onClose} disabled={Boolean(savingKey)}><X size={18}/></button>
      </header>
      <div className="playback-permissions-host-note"><ShieldCheck size={15}/><span>You always retain full playback control.</span></div>
      {error && <div className="room-chat-error" role="alert">{error}</div>}
      {loading ? <div className="playback-permissions-state"><LoaderCircle className="spin-icon" size={18}/> Loading permissions…</div>
        : learners.length === 0 ? <div className="playback-permissions-state">There are no participants to manage yet.</div>
          : <div className="playback-permissions-list">{learners.map(person => {
            const permission = permissions.get(person.user_id);
            const granted = Boolean(permission?.can_play_pause || permission?.can_seek);
            const revoked = Boolean(permission && !granted);
            return <article className="playback-permission-row" key={person.user_id}>
              <div className="playback-permission-person"><span className="participant-avatar participant-color-1">{person.display_name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase()}</span><div><b>{person.display_name}</b><small className={granted ? 'permission-granted' : revoked ? 'permission-revoked' : ''}>{granted ? 'Playback control granted' : revoked ? 'Permission revoked' : 'View only'}</small></div></div>
              <div className="playback-permission-options">
                <label><input type="checkbox" checked={Boolean(permission?.can_play_pause)} disabled={Boolean(savingKey)} onChange={event => void update(person, 'can_play_pause', event.target.checked)}/><span>Play / Pause</span></label>
                <label><input type="checkbox" checked={Boolean(permission?.can_seek)} disabled={Boolean(savingKey)} onChange={event => void update(person, 'can_seek', event.target.checked)}/><span>Seek</span></label>
              </div>
            </article>;
          })}</div>}
      <footer className="playback-permissions-footer"><span className={live ? 'permissions-live' : ''}><i/>{live ? 'Permission updates live' : 'Connecting to live updates…'}</span><button type="button" className="button button-secondary" onClick={onClose} disabled={Boolean(savingKey)}>Done</button></footer>
    </section>
  </div>;
}
