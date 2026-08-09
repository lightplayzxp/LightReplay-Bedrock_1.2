/**
 * A track is one recorded "take": {id, name, movementFrames, actorType,
 * skinIndex, offsetTicks}. Normal Mode always has exactly one (auto
 * created here, offset 0) so it behaves exactly like a single-actor
 * replay always has. Advanced Mode creates a new one every time you
 * start a fresh recording, and lets you assign a different actor +
 * start-offset to each from the Track Manager.
 */
export function ensureDefaultTrack(session) {
    if (session.tracks.length === 0) {
        createTrack(session, "Track 1");
    }
    if (session.activeTrackId === undefined) {
        session.activeTrackId = session.tracks[0].id;
    }
}

export function createTrack(session, name) {
    const track = {
        id: session.nextTrackId++,
        name: name || `Track ${session.tracks.length + 1}`,
        movementFrames: [],
        actorType: "mymod:replay_actor",
        skinIndex: 0,
        offsetTicks: 0,
    };
    session.tracks.push(track);
    session.activeTrackId = track.id;
    return track;
}

export function getActiveTrack(session) {
    return session.tracks.find((t) => t.id === session.activeTrackId);
}

export function getTrack(session, id) {
    return session.tracks.find((t) => t.id === id);
}

export function deleteTrack(session, id) {
    session.tracks = session.tracks.filter((t) => t.id !== id);
    if (session.activeTrackId === id) {
        session.activeTrackId = session.tracks[0]?.id;
    }
}

/** Track duration in ticks (0 if empty). */
export function trackDuration(track) {
    if (!track.movementFrames.length) return 0;
    return track.movementFrames[track.movementFrames.length - 1].tick;
}

/**
 * Total timeline span: the maximum value of (track.offsetTicks + trackDuration).
 * This ensures playback runs long enough for all tracks to complete,
 * regardless of their individual offsets.
 */
export function getTimelineSpan(tracks) {
    if (tracks.length === 0) return 0;
    return Math.max(...tracks.map((t) => t.offsetTicks + trackDuration(t)));
}
