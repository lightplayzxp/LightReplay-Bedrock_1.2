# LightReplay Bedrock - Multi-Track Playback Architecture

## Overview
LightReplay is an advanced replay mod for Minecraft Bedrock featuring multi-track timeline editing with a shared master clock. This document specifies the three core architectural requirements and how they integrate.

---

## Requirement 1: Master Clock & Concurrent Playback (playback.js)

### Purpose
Implement a playback engine where all tracks play simultaneously on a single shared master clock, rather than sequentially waiting for prior tracks to finish.

### Implementation
**File:** `playback.js` → `startPlayback(player, startTick)`

**Key Logic:**
```javascript
// Master clock initialization
const baseTick = startTick !== undefined ? startTick : naturalBaseTick;

// All tracks start immediately on master clock
for (const track of playableTracks) {
    const trackStartTick = startTick !== undefined ? startTick + track.offsetTicks : track.offsetTicks;
    const handle = startTrackPlayback(player, track, trackStartTick);
    // Track plays independently with its own handle
    session.activeTrackHandles.push(handle);
}
```

### Key Requirements Met
✅ **Do not force sequential playback** — All tracks start immediately, not one after another  
✅ **Each track starts at precise offset** — `trackStartTick = startTick + track.offsetTicks`  
✅ **Shared master clock** — All tracks reference the same `baseTick`  
✅ **Independent timing** — Each track has its own `intervalId` and completes independently  

### Example Scenario
```
Master Clock (baseTick = 0)
├─ Track 1 (offset: 0, duration: 30) ────────────────── ends at tick 30
├─ Track 2 (offset: 10, duration: 40) ──────────────────────────── ends at tick 50
└─ Track 3 (offset: 0, duration: 20) ──────── ends at tick 20

All three play SIMULTANEOUSLY from their respective offsets.
Playback continues until tick 50 (the latest end time).
```

---

## Requirement 2: Track Metadata & Structure (track-manager.js)

### Purpose
Define a track object with all necessary metadata for independent recording and playback, supporting both Normal Mode (single track) and Advanced Mode (multi-track).

### Track Object Structure
```javascript
{
  id: number,                    // Unique identifier (auto-incremented)
  name: string,                  // Human-readable (e.g., "Track 1", "Actor - Steve")
  movementFrames: Array,         // [{tick, location, rotation, ...}, ...]
  actorType: string,             // Entity type (e.g., "mymod:replay_actor")
  skinIndex: number,             // Which skin variant to use (0, 1, 2, ...)
  offsetTicks: number            // Start time relative to master clock (ticks)
}
```

### Key Functions

#### `ensureDefaultTrack(session)`
- Creates a default track for Normal Mode if none exists
- Sets `offsetTicks = 0` so it starts at master clock zero
- Ensures `session.activeTrackId` points to a valid track

#### `createTrack(session, name)`
- Creates a new track with the given name
- Auto-generates name if not provided
- Sets `offsetTicks = 0` by default (can be adjusted later in Track Manager UI)
- Marks the new track as active

#### `getActiveTrack(session)` / `getTrack(session, id)`
- Retrieve the currently recording/editing track or a specific track by ID

#### `deleteTrack(session, id)`
- Removes a track from the project
- Reassigns `activeTrackId` if the active track is deleted

#### `trackDuration(track)`
- Returns the raw duration of a track (last frame's tick value)
- Does NOT include the offset; just the elapsed time of movement frames
- Returns 0 if the track has fewer than 1 frame

### Key Requirements Met
✅ **Track structure defined** — Contains id, name, movementFrames, actorType, skinIndex, offsetTicks  
✅ **Default track support** — Normal Mode auto-creates one track  
✅ **Advanced mode support** — Multiple tracks can be created with different properties  
✅ **Independent properties** — Each track has its own actor type, skin, and offset  
✅ **Duration calculation** — `trackDuration(track)` returns individual track length  

### Example: Advanced Mode Setup
```javascript
// Create Track 1: Steve, starts at tick 0
track1 = createTrack(session, "Steve - Main");
track1.offsetTicks = 0;
track1.actorType = "mymod:replay_actor";
track1.skinIndex = 0;

// Create Track 2: Alex, starts at tick 10
track2 = createTrack(session, "Alex - Camera Follow");
track2.offsetTicks = 10;
track2.actorType = "mymod:replay_actor";
track2.skinIndex = 1;

// Both record independently and play simultaneously with their offsets
```

---

## Requirement 3: Dynamic Timeline Span Calculation (getTimelineSpan)

### Purpose
Calculate the total playable duration of a project dynamically based on track offsets and durations, ensuring the master clock runs long enough for all tracks to complete.

### Implementation
**File:** `track-manager.js` → `getTimelineSpan(tracks)`

**Formula:**
```
Timeline Span = MAX(offset_i + duration_i) for all tracks i
```

**Code:**
```javascript
export function getTimelineSpan(tracks) {
    if (tracks.length === 0) return 0;
    return Math.max(...tracks.map((t) => t.offsetTicks + trackDuration(t)));
}
```

### Why This Matters
Without proper offset handling:
- ❌ Adding durations sequentially: 30 + 40 + 20 = 90 ticks (WRONG)
- ❌ Taking max of raw durations: MAX(30, 40, 20) = 40 ticks (WRONG if offset > 0)
- ✅ Taking max of (offset + duration): MAX(0+30, 10+40, 0+20) = 50 ticks (CORRECT)

### Integration Points

**In playback.js:**
```javascript
const tracksDuration = playableTracks.length 
    ? Math.max(...playableTracks.map(t => t.offsetTicks + trackEndTick(t))) 
    : 0;
```
This ensures:
- Night vision duration is long enough for all tracks
- Camera path scheduling respects track timing
- Playback doesn't end prematurely

**In future UI (Track Manager):**
- Display total project duration to the user
- Validate track offsets don't exceed timeline bounds
- Adjust master clock duration dynamically as tracks are added/modified

### Example Calculation
```
Project with 3 tracks:

Track A: offset 0, duration 20 → endpoint = 0 + 20 = 20
Track B: offset 15, duration 30 → endpoint = 15 + 30 = 45  ← MAX
Track C: offset 5, duration 25 → endpoint = 5 + 25 = 30

Timeline Span = 45 ticks

Playback Timeline:
0 ──────────────────────────── 20 (Track A ends)
   15 ──────────────────────── 45 (Track B ends)
  5 ────────────────────── 30 (Track C ends)
|                              |
Start (tick 0)            End (tick 45)
```

### Key Requirements Met
✅ **Dynamic calculation** — Adjusts automatically as tracks are added/modified  
✅ **Offset-aware** — Uses `offset + duration` not just `duration`  
✅ **No sequential addition** — Uses MAX not SUM  
✅ **Concurrent playback support** — Allows overlapping tracks  
✅ **Reusable** — Can be called from playback.js, UI, validation logic  

---

## Integration Summary

| Component | Purpose | Dependency |
|-----------|---------|------------|
| **playback.js** | Start all tracks concurrently on master clock | Uses track.offsetTicks from track-manager.js |
| **track-manager.js** | Manage track metadata and structure | Provides track objects and duration calculations |
| **getTimelineSpan()** | Calculate total project duration | Calls trackDuration() for each track |

### Data Flow: Recording → Playback
```
User Record → session.tracks[i].movementFrames populated
                              ↓
              Track duration auto-calculated by trackDuration()
                              ↓
              Timeline span auto-calculated by getTimelineSpan()
                              ↓
              startPlayback() uses offsets & span for master clock
                              ↓
              All tracks start at (baseTick + offsetTicks)
                              ↓
              Playback continues until MAX(offset + duration)
```

---

## Testing Scenarios

### Scenario 1: Normal Mode (Single Track)
- One track created with offset 0
- Records 30 seconds of movement
- Playback duration = 30 ticks ✅

### Scenario 2: Two Overlapping Tracks
- Track 1: offset 0, duration 30
- Track 2: offset 10, duration 25
- Timeline Span = MAX(30, 35) = 35 ticks
- Both play simultaneously ✅

### Scenario 3: Many Tracks with Different Offsets
- Track 1: offset 0, duration 15
- Track 2: offset 20, duration 30
- Track 3: offset 35, duration 20
- Timeline Span = MAX(15, 50, 55) = 55 ticks ✅

### Scenario 4: Sequential Tracks (User Choice)
- Track 1: offset 0, duration 30
- Track 2: offset 30, duration 20
- Track 3: offset 50, duration 25
- Timeline Span = MAX(30, 50, 75) = 75 ticks ✅

---

## Bedrock Constraints Respected

✅ **ES Module compatibility** — All code uses standard imports/exports  
✅ **Per-track 60-second limit** — Enforced in movement-record.js independently per track  
✅ **Tick-based timing** — All calculations use ticks, not milliseconds  
✅ **Memory efficiency** — No frame duplication; tracks reference shared clock  
✅ **No global limits** — Each track is independent; unlimited track count (per memory)  

---

## Future Enhancements

- **Track Manager UI:** Display timeline span, allow drag-to-adjust offsets
- **Validation:** Warn if track duration exceeds per-track limits
- **Optimization:** Cache timeline span, recalculate only when tracks change
- **Export:** Include timeline span in replay file metadata
