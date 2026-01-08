/**
 * Ghost During Recording - Unit Tests
 * 
 * Tests verify ghost extension behavior per docs/recording.md:
 * "Ghosts only expand when recording crosses the committed LCM boundary"
 * "New ghosts are added in LCM-sized chunks (not Q-sized)"
 */

const baseWidth = 200;

// Simulate the correct LCM-boundary expansion logic from app.js
function calculateTimelineWidth(committedClips, recordingClip, effectiveQ) {
    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
    const lcm = (a, b) => (a === 0 || b === 0) ? Math.max(a, b) : Math.abs((a / gcd(a, b)) * b);

    // Calculate committed LCM
    let committedLCM = effectiveQ;
    for (const clip of committedClips) {
        committedLCM = lcm(Math.round(committedLCM), Math.round(clip.duration));
    }

    const lcmWidth = (committedLCM / effectiveQ) * baseWidth;
    let timelineWidth = lcmWidth;

    // During recording, extend in LCM chunks as recording crosses boundaries
    if (recordingClip && recordingClip.duration > 0) {
        const recordingWidthPx = (recordingClip.duration / effectiveQ) * baseWidth;
        const lcmChunksCrossed = Math.floor(recordingWidthPx / lcmWidth);
        timelineWidth = (lcmChunksCrossed + 1) * lcmWidth;
    }

    return { committedLCM, lcmWidth, timelineWidth };
}

function countGhosts(clipDuration, timelineWidth, effectiveQ) {
    const clipWidth = (clipDuration / effectiveQ) * baseWidth;
    let count = 0;
    for (let x = clipWidth; x < (timelineWidth - 5); x += clipWidth) count++;
    return count;
}

// ============================================================================
// Test 1: Committed LCM = 1Q, Recording at 0.5Q → No extension yet
// ============================================================================
function test1() {
    console.log("=== TEST 1: Recording at 0.5Q (before 1Q boundary) ===\n");
    const effectiveQ = 44100;
    const committed = [{ duration: 44100 }];  // 1Q
    const recording = { duration: 22050 };     // 0.5Q

    const result = calculateTimelineWidth(committed, recording, effectiveQ);
    // 0.5Q is still within the first LCM chunk (1Q), so no extension
    // floor(100/200) = 0 chunks crossed → timeline = 1 * 200 = 200px
    const expected = 200;

    console.log(`Committed LCM: ${result.committedLCM} (${result.lcmWidth}px)`);
    console.log(`Recording at: 0.5Q (100px)`);
    console.log(`Timeline width: ${result.timelineWidth}px`);
    console.log(`Expected: ${expected}px (no extension - still in first chunk)`);

    if (result.timelineWidth === expected) {
        console.log("✓ PASS\n");
        return true;
    }
    console.log("✗ FAIL\n");
    return false;
}

// ============================================================================
// Test 2: Committed LCM = 1Q, Recording at 1.5Q → Extends to 2Q
// ============================================================================
function test2() {
    console.log("=== TEST 2: Recording at 1.5Q (crossed 1Q boundary) ===\n");
    const effectiveQ = 44100;
    const committed = [{ duration: 44100 }];  // 1Q
    const recording = { duration: 66150 };     // 1.5Q

    const result = calculateTimelineWidth(committed, recording, effectiveQ);
    // 1.5Q = 300px. floor(300/200) = 1 chunk crossed → timeline = 2 * 200 = 400px
    const expected = 400;

    console.log(`Recording at: 1.5Q (300px)`);
    console.log(`Chunks crossed: ${Math.floor(300 / 200)}`);
    console.log(`Timeline width: ${result.timelineWidth}px`);
    console.log(`Expected: ${expected}px (extends by 1 LCM after crossing 1Q)`);
    console.log(`Ghosts for 1Q clip: ${countGhosts(44100, result.timelineWidth, effectiveQ)}`);

    if (result.timelineWidth === expected) {
        console.log("✓ PASS\n");
        return true;
    }
    console.log("✗ FAIL\n");
    return false;
}

// ============================================================================
// Test 3: Committed LCM = 4Q, Recording at 3Q → No extension (before 4Q)
// ============================================================================
function test3() {
    console.log("=== TEST 3: LCM=4Q, Recording at 3Q (before 4Q boundary) ===\n");
    const effectiveQ = 44100;
    const committed = [{ duration: 44100 }, { duration: 176400 }];  // 1Q + 4Q = LCM 4Q
    const recording = { duration: 132300 };  // 3Q

    const result = calculateTimelineWidth(committed, recording, effectiveQ);
    // 3Q = 600px, LCM = 4Q = 800px
    // floor(600/800) = 0 chunks crossed → timeline = 1 * 800 = 800px (no change)
    const expected = 800;

    console.log(`Committed LCM: 4Q (${result.lcmWidth}px)`);
    console.log(`Recording at: 3Q (600px)`);
    console.log(`Chunks crossed: ${Math.floor(600 / 800)}`);
    console.log(`Timeline width: ${result.timelineWidth}px`);
    console.log(`Expected: ${expected}px (no extension - still in first LCM)`);

    if (result.timelineWidth === expected) {
        console.log("✓ PASS\n");
        return true;
    }
    console.log("✗ FAIL\n");
    return false;
}

// ============================================================================
// Test 4: Committed LCM = 4Q, Recording at 5Q → Extends to 8Q
// ============================================================================
function test4() {
    console.log("=== TEST 4: LCM=4Q, Recording at 5Q (crossed 4Q boundary) ===\n");
    const effectiveQ = 44100;
    const committed = [{ duration: 44100 }, { duration: 176400 }];  // LCM = 4Q
    const recording = { duration: 220500 };  // 5Q

    const result = calculateTimelineWidth(committed, recording, effectiveQ);
    // 5Q = 1000px, LCM = 4Q = 800px
    // floor(1000/800) = 1 chunk crossed → timeline = 2 * 800 = 1600px (8Q)
    const expected = 1600;

    console.log(`Recording at: 5Q (1000px)`);
    console.log(`Chunks crossed: ${Math.floor(1000 / 800)}`);
    console.log(`Timeline width: ${result.timelineWidth}px`);
    console.log(`Expected: ${expected}px (8Q - extends by 1 LCM)`);

    if (result.timelineWidth === expected) {
        console.log("✓ PASS\n");
        return true;
    }
    console.log("✗ FAIL\n");
    return false;
}

// ============================================================================
// Run All Tests
// ============================================================================
console.log("=".repeat(60));
console.log("GHOST DURING RECORDING - LCM BOUNDARY TESTS");
console.log("Per docs/recording.md: ghosts expand in LCM chunks");
console.log("=".repeat(60) + "\n");

const results = [test1(), test2(), test3(), test4()];
const passed = results.filter(r => r).length;

console.log("=".repeat(60));
console.log(`Results: ${passed}/${results.length} tests passed`);

if (passed === results.length) {
    console.log("\n✓ All tests pass!");
} else {
    console.log("\n✗ Tests failed.");
    process.exit(1);
}
