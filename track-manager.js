/**
 * ============================================================================
 * LIGHTREPLAY BEDROCK - TRACK METADATA & STRUCTURE
 * ============================================================================
 *
 * This module manages the track system for LightReplay's multi-track replay
 * engine. Each track represents a single "take" of recorded actor movement,
 * with independent timing via offsetTicks, custom actor properties, and
 * isolated movement frame data.
 *
 * TRACK OBJECT STRUCTURE:
 * {
 *   id: number,                    // Unique track identifier
 *   name: string,                  // Human-readable track name
 *   movementFrames: Array,         // Array of {tick, location, rotation, ...}
 *   actorType: string,             // Entity type (e.g., "mymod:replay_actor")
 *   skinIndex: number,             // Which skin to use for the actor
 *   offsetTicks: number            // Start time relative to master clock (ticks)
 * }
 *
 * NORMAL MODE (Single Track):
 * - Automatically creates one default track with offsetTicks = 0
 * - Behaves like a traditional single-actor replay
 * - User can only record one take at a time
 *
 * ADVANCED MODE (Multi-Track):
 * - User can create multiple tracks independently
 * - Each track can have a different actor and start offset
 * - Tracks play concurrently on the shared master clock
 * - Enables cinematic multi-character sequences
 *
 * ============================================================================
 */

/**
 * REQUIREMENT 2: TRACK METADATA & STRUCTURE
 * Ensures Normal Mode has a default track ready for recording.
 */
export function ensureDefaultTrack(session) {
    if (session.tracks.length === 0) {
        createTrack(session, "Track 1");
    }
    if (session.activeTrackId === undefined) {
        session.activeTrackId = session.tracks[0].id;
    }
}

/**
 * Creates a new track with the given name.
 *
 * @param {Object} session - The session object
 * @param {string} name - Human-readable name for the track
 * @returns {Object} The newly created track object
 */
export function createTrack(session, name) {
    const track = {
        id: session.nextTrackId++,
        name: name || `Track ${session.tracks.length + 1}`,
        movementFrames: [],
        actorType: "mymod:replay_actor",
        skinIndex: 0,
        offsetTicks: 0,  // Start at master clock zero by default
    };
    session.tracks.push(track);
    session.activeTrackId = track.id;
    return track;
}

/**
 * Retrieves the currently active track for recording/editing.
 *
 * @param {Object} session - The session object
 * @returns {Object|undefined} The active track, or undefined if none exists
 */
export function getActiveTrack(session) {
    return session.tracks.find((t) => t.id === session.activeTrackId);
}

/**
 * Retrieves a track by its ID.
 *
 * @param {Object} session - The session object
 * @param {number} id - The track ID to fetch
 * @returns {Object|undefined} The track with the given ID, or undefined
 */
export function getTrack(session, id) {
    return session.tracks.find((t) => t.id === id);
}

/**
 * Deletes a track and adjusts the active track if needed.
 *
 * @param {Object} session - The session object
 * @param {number} id - The track ID to delete
 */
export function deleteTrack(session, id) {
    session.tracks = session.tracks.filter((t) => t.id !== id);
    if (session.activeTrackId === id) {
        session.activeTrackId = session.tracks[0]?.id;
    }
}

/**
 * REQUIREMENT 2: TRACK DURATION HELPER
 * Gets the end tick of a single track (0 if empty).
 * Does NOT include the track's offset; just the raw duration of movement frames.
 *
 * @param {Object} track - The track object
 * @returns {number} The tick value of the last movement frame, or 0 if no frames
 */
export function trackDuration(track) {
    if (!track.movementFrames.length) return 0;
    return track.movementFrames[track.movementFrames.length - 1].tick;
}

/**
 * REQUIREMENT 3: DYNAMIC TIMELINE SPAN CALCULATION
 *
 * Calculates the total playable length of the entire project.
 * 
 * This is the maximum endpoint among all tracks:
 * MAX(offset_i + duration_i) for all tracks i
 *
 * Example:
 * - Track 1: offset 0, duration 30 → endpoint = 30
 * - Track 2: offset 10, duration 40 → endpoint = 50
 * - Track 3: offset 0, duration 20 → endpoint = 20
 * - Timeline Span = MAX(30, 50, 20) = 50 ticks
 *
 * This allows:
 * ✓ Tracks to start and end at different times
 * ✓ Proper calculation of total playback duration
 * ✓ No forced sequential playback
 * ✓ Concurrent multi-track playback on a shared master clock
 *
 * @param {Array} tracks - Array of track objects
 * @returns {number} Total timeline duration in ticks
 */
export function getTimelineSpan(tracks) {
    if (tracks.length === 0) return 0;
    return Math.max(...tracks.map((t) => t.offsetTicks + trackDuration(t)));
}
