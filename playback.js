/**
 * ============================================================================
 * LIGHTREPLAY BEDROCK - MASTER CLOCK & CONCURRENT PLAYBACK ENGINE
 * ============================================================================
 * 
 * This module implements the core playback system for LightReplay's multi-track
 * replay engine on Minecraft Bedrock. It ensures all tracks play concurrently
 * on a shared master clock, with proper offset handling and independent timing.
 * 
 * ARCHITECTURE:
 * - Master Clock: Single shared `baseTick` drives all playback
 * - Concurrent Playback: Tracks start and end independently via offsets
 * - Timeline Duration: Calculated as MAX(offset + duration) across all tracks
 * - Track Isolation: No sequential waiting; all tracks play simultaneously
 * 
 * ============================================================================
 */

import { system, EasingType } from "@minecraft/server";
import { getOrCreateSession } from "./session-store.js";
import { getSettings } from "./settings-store.js";
import { resolvePathPoints } from "./path-resolve.js";
import { curvedLocationAt } from "./curve-math.js";
import { startTrackPlayback, stopTrackPlayback, trackEndTick } from "./movement-playback.js";
import { startWorldEventPlayback } from "./world-playback.js";
import { clearTimelinePreview } from "./timeline-preview.js";
import { ensureNightVisionForReplay } from "./night-vision.js";
import { suppressMobSpawning, restoreMobSpawningIfIdle } from "./mob-spawning.js";
import { preloadReplayChunks, clearPreloadedChunks } from "./chunk-preload.js";
import { enterFreeCam, exitFreeCam } from "./free-cam.js";
import { getActiveCameraPoints } from "./camera-points.js";
import { drawPathPreview, clearPathPreview } from "./path-preview.js";

const SMOOTH_SUBSTEPS = 4; // capped on purpose - keeps scheduled calls bounded on low-end devices

/**
 * MASTER CLOCK INITIALIZATION & CONCURRENT TRACK STARTUP
 * 
 * Starts playback of:
 * 1. Camera path (if keyframes exist)
 * 2. All recorded tracks in parallel (each with independent offset)
 * 3. World events (drops, block toggles)
 * 4. Free Cam override (if enabled in Settings)
 *
 * All elements play on the same master clock (baseTick). Tracks are NOT
 * sequential; they all start immediately and play concurrently.
 *
 * Returns true if playback actually started, false if there was nothing
 * to play - callers (the Camera 1 state machine) should not advance to
 * the "playing" state on a false return.
 */
export function startPlayback(player, startTick) {
    const session = getOrCreateSession(player.id);
    const settings = getSettings(player.id);
    const resolved = resolvePathPoints(getActiveCameraPoints(session, player.id));
    const playableTracks = session.tracks.filter((t) => t.movementFrames.length >= 2);
    const hasWorldEvents = session.worldEvents.length > 0;
    const freeCam = settings.freeCam;

    if (!resolved && playableTracks.length === 0 && !hasWorldEvents && !freeCam) {
        player.onScreenDisplay.setActionBar("§cNothing to play - add keyframes and/or record a track first.");
        return false;
    }
    if (session.isPlaying) return true;
    session.isPlaying = true;

    try {
        session.activeTimeouts = [];
        session.activeTrackHandles = [];
        clearTimelinePreview(session);
        clearPathPreview(session);
        suppressMobSpawning();

        // MASTER CLOCK: Establish the shared timeline reference point
        const naturalBaseTick = resolved ? resolved.points[0].tick : 0;
        const baseTick = startTick !== undefined ? startTick : naturalBaseTick;
        
        // CAMERA DURATION: Time span of the camera path (if any)
        const cameraDuration = resolved ? resolved.points[resolved.points.length - 1].tick - baseTick : 0;
        
        // ===================================================================
        // REQUIREMENT 3: DYNAMIC TIMELINE SPAN CALCULATION
        // ===================================================================
        // Calculate total timeline duration accounting for track offsets.
        // This ensures playback runs long enough for all tracks, even if
        // they have different start offsets.
        // 
        // Formula: MAX(offset_i + duration_i) for all tracks i
        // This allows tracks with offset 0 to play while later tracks
        // (offset > 0) continue, without forcing sequential playback.
        // ===================================================================
        const tracksDuration = playableTracks.length 
            ? Math.max(...playableTracks.map(t => t.offsetTicks + trackEndTick(t))) 
            : 0;

        if (settings.nightVision) {
            ensureNightVisionForReplay(player, Math.max(cameraDuration, tracksDuration) + 100);
        }

        const pathLocations = [
            ...(resolved ? resolved.points.map((p) => p.location) : []),
            ...playableTracks.flatMap((t) => t.movementFrames.map((f) => f.location)),
        ];
        preloadReplayChunks(player.dimension, pathLocations);

        // ===================================================================
        // REQUIREMENT 1: CONCURRENT, INDEPENDENT MULTI-TRACK PLAYBACK
        // ===================================================================
        // Start ALL tracks immediately on the master clock.
        // Each track is given its individual offsetTicks so it starts at
        // the correct time relative to baseTick.
        // 
        // No track waits for another. They all run concurrently with their
        // own timing handle (intervalId). The only synchronization is that
        // they all reference the same master baseTick.
        // ===================================================================
        for (const track of playableTracks) {
            // Calculate this track's start tick: master clock + individual offset
            const trackStartTick = startTick !== undefined ? startTick + track.offsetTicks : track.offsetTicks;
            
            // Start the track on its own independent playback handle
            const handle = startTrackPlayback(player, track, trackStartTick);
            if (handle) {
                handle.onComplete = () => checkForNaturalEnd(player, session);
                session.activeTrackHandles.push(handle);
            }
        }
        
        if (hasWorldEvents) {
            startWorldEventPlayback(player, session, baseTick);
        }

        if (freeCam) {
            enterFreeCam(player, session);
        } else if (resolved) {
            playCameraPath(player, session, resolved, baseTick);
        }

        player.onScreenDisplay.setActionBar("§aPlaying replay...");
        return true;
    } catch (e) {
        // Something above failed - reset state instead of leaving isPlaying
        // stuck true forever (which would silently no-op every future press,
        // with no message at all).
        session.isPlaying = false;
        restoreMobSpawningIfIdle();
        exitFreeCam(player, session);
        player.sendMessage(`§c[MyMod] Replay failed to start: ${e}`);
        return false;
    }
}

/**
 * NATURAL END DETECTION
 * 
 * Once every scheduled timeout AND every track has finished (intervalId cleared),
 * end playback on its own. This prevents the playback state from hanging if
 * the user doesn't manually stop.
 */
function checkForNaturalEnd(player, session) {
    if (session.activeTimeouts.length === 0 && session.activeTrackHandles.every((h) => h.intervalId === undefined)) {
        stopPlayback(player);
    }
}

/**
 * CAMERA PATH PLAYBACK
 * 
 * Schedules camera movements frame-by-frame on the master clock.
 * Smooth interpolation between keyframes using easing.
 */
function playCameraPath(player, session, resolved, baseTick) {
    const { points, isPairCurved } = resolved;

    player.camera.setCamera("minecraft:free", { location: points[0].location, rotation: points[0].rotation });

    for (let i = 0; i < points.length - 1; i++) {
        const from = points[i];
        const to = points[i + 1];
        const tickDiff = Math.max(1, to.tick - from.tick);
        const curved = isPairCurved[i];

        if (curved) {
            const stepTicks = tickDiff / SMOOTH_SUBSTEPS;
            for (let s = 0; s < SMOOTH_SUBSTEPS; s++) {
                const tEnd = (s + 1) / SMOOTH_SUBSTEPS;
                const startDelay = from.tick + s * stepTicks - baseTick;
                const id = system.runTimeout(() => {
                    if (!player.isValid) return;
                    const loc = curvedLocationAt(points, i, tEnd);
                    const rot = lerpRotation(from.rotation, to.rotation, tEnd);
                    player.camera.setCamera("minecraft:free", {
                        location: loc,
                        rotation: rot,
                        easeOptions: { easeTime: stepTicks / 20, easeType: EasingType.Linear },
                    });
                }, Math.max(0, Math.round(startDelay)));
                session.activeTimeouts.push(id);
            }
        } else {
            const startDelay = from.tick - baseTick;
            const id = system.runTimeout(() => {
                if (!player.isValid) return;
                player.camera.setCamera("minecraft:free", {
                    location: to.location,
                    rotation: to.rotation,
                    easeOptions: { easeTime: tickDiff / 20, easeType: EasingType.Linear },
                });
            }, Math.max(0, startDelay));
            session.activeTimeouts.push(id);
        }
    }

    const lastTick = points[points.length - 1].tick;
    const endId = system.runTimeout(() => {
        session.activeTimeouts = session.activeTimeouts.filter((id) => id !== endId);
        checkForNaturalEnd(player, session);
    }, lastTick - baseTick + 5);
    session.activeTimeouts.push(endId);
}

/**
 * PLAYBACK CLEANUP & SAFE STATE RESET
 * 
 * Every step here is individually guarded - a failure in one cleanup step
 * (e.g. an actor that's already invalid) must never skip the others, and
 * session.isPlaying must always end up false. This function is called
 * from a lot of places (natural end, Camera 1, Track Manager, mode
 * switch, player leave/die) so it has to be safe to call repeatedly and
 * from any state.
 */
export function stopPlayback(player) {
    const session = getOrCreateSession(player.id);
    if (!session.isPlaying) return;

    safely(() => {
        for (const id of session.activeTimeouts) system.clearRun(id);
    });
    session.activeTimeouts = [];

    safely(() => {
        for (const handle of session.activeTrackHandles) stopTrackPlayback(handle);
    });
    session.activeTrackHandles = [];

    safely(restoreMobSpawningIfIdle);
    if (player.isValid) safely(() => clearPreloadedChunks(player.dimension));
    safely(() => exitFreeCam(player, session));

    session.isPlaying = false;

    if (player.isValid) {
        safely(() => player.camera.clear());
        safely(() => player.onScreenDisplay.setActionBar("§eReplay stopped."));
        safely(() => drawPathPreview(player, session, getActiveCameraPoints(session, player.id)));
    }
}

/** Runs fn, swallowing any error so cleanup always continues to the next step. */
function safely(fn) {
    try {
        fn();
    } catch {
        // intentionally ignored - this is best-effort cleanup, not the main flow
    }
}

function lerpRotation(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
