/**
 * Ghost Cursor During Recording Tests
 * 
 * These tests verify ghost cursor visibility behavior during:
 * 1. Recording of clip 2 (while clip 1 is committed)
 * 2. Playback after all clips are committed
 */

// Constants matching app.js
const VISUAL_OFFSET = 120;
const baseWidth = 200;  // 200px per quantum

// Test scenario: Clip 1 is 1Q, Clip 2 is recording
function testDuringRecording() {
    console.log("=== TEST: Ghost Cursor During Recording ===\n");

    // Clip 1: 1Q committed
    const clip1 = {
        id: 'clip1',
        duration: 83200,  // 1Q in samples (approx)
        isRecording: false,
        x: 0
    };

    // Clip 2: Recording, growing
    const clip2 = {
        id: 'clip2',
        duration: 332800,  // 4Q worth of recording (growing)
        isRecording: true,
        x: 0
    };

    const effectiveQ = 83200;  // 1Q in samples
    const longestDuration = 332800;  // Clip 2's growing duration

    // Simulate ghosts for clip 1:
    // - Main clip: [0, 200)
    // - Ghost 0: [200, 400)
    // - Ghost 1: [400, 600)
    // - Ghost 2: [600, 800)

    const clip1Width = (clip1.duration / effectiveQ) * baseWidth;  // 200px
    const ghosts = [
        { left: 200, width: 200, range: "[200, 400)" },
        { left: 400, width: 200, range: "[400, 600)" },
        { left: 600, width: 200, range: "[600, 800)" },
        { left: 800, width: 200, range: "[800, 1000)" }
    ];

    // Test case: masterPos = 2.5Q (should be in ghost 1)
    const masterPos = 2.5 * effectiveQ;  // 208000 samples
    const anyRecording = true;

    // Current app.js logic:
    const timelinePos = anyRecording ? masterPos : (masterPos % longestDuration);
    const timelinePosPx = (timelinePos / effectiveQ) * baseWidth;

    console.log(`Input: masterPos=${masterPos}, effectiveQ=${effectiveQ}`);
    console.log(`Calculated: timelinePos=${timelinePos}, timelinePosPx=${timelinePosPx}`);
    console.log(`Expected: Ghost 1 [400, 600) should be active`);

    // Check which ghost is active
    let activeGhost = null;
    for (let i = 0; i < ghosts.length; i++) {
        const g = ghosts[i];
        const isActive = (timelinePosPx >= g.left - 1 && timelinePosPx < g.left + g.width);
        if (isActive) {
            activeGhost = i;
            console.log(`✓ Ghost ${i} ${g.range} IS ACTIVE at posPx=${timelinePosPx.toFixed(1)}`);
        }
    }

    // Also check main clip
    const mainActive = (timelinePosPx >= 0 && timelinePosPx < 200);
    if (mainActive) {
        console.log(`Main clip [0, 200) IS ACTIVE at posPx=${timelinePosPx.toFixed(1)}`);
    }

    // Verify expected result
    if (activeGhost === 1) {
        console.log("\n✓ PASS: Ghost 1 correctly activated at 2.5Q\n");
        return true;
    } else {
        console.log(`\n✗ FAIL: Expected ghost 1 to be active, got ghost ${activeGhost}`);
        console.log("This indicates the ghost cursor logic is broken during recording.\n");
        return false;
    }
}

// Test: Verify ghost creation keeps pace with recording
function testGhostCreationPace() {
    console.log("=== TEST: Ghost Creation Pace ===\n");

    // Simulate the ghost extension logic
    const effectiveQ = 83200;
    const baseWidth = 200;
    const clip1Duration = effectiveQ;  // 1Q
    const clip1Width = 200;  // 1Q in pixels

    // Timeline width grows as clip 2 records
    const testCases = [
        { timelineWidth: 200, expectedGhosts: 0 },   // 1Q - no ghosts
        { timelineWidth: 400, expectedGhosts: 1 },   // 2Q - 1 ghost
        { timelineWidth: 600, expectedGhosts: 2 },   // 3Q - 2 ghosts
        { timelineWidth: 800, expectedGhosts: 3 },   // 4Q - 3 ghosts
    ];

    let allPassed = true;

    for (const tc of testCases) {
        // Calculate how many ghosts fit
        const clipStartX = 0;
        let currentGhostX = clipStartX + clip1Width;  // Start after main clip
        let ghostCount = 0;

        while (currentGhostX < (tc.timelineWidth - 5) && ghostCount < 100) {
            ghostCount++;
            currentGhostX += clip1Width;
        }

        if (ghostCount === tc.expectedGhosts) {
            console.log(`✓ Timeline ${tc.timelineWidth}px → ${ghostCount} ghosts (expected ${tc.expectedGhosts})`);
        } else {
            console.log(`✗ Timeline ${tc.timelineWidth}px → ${ghostCount} ghosts (expected ${tc.expectedGhosts})`);
            allPassed = false;
        }
    }

    console.log(allPassed ? "\n✓ PASS: Ghost creation pace is correct\n" : "\n✗ FAIL: Ghost creation pace is incorrect\n");
    return allPassed;
}

// Test: Real log data reproduction
function testRealLogData() {
    console.log("=== TEST: Real Log Data Reproduction ===\n");
    console.log("From celestrian_debug.log:");
    console.log("  posPx=453, ghosts=1, firstGhost=[200, 400)\n");

    // At posPx=453, we should expect ghost 2 [400, 600) to be active
    // But only ghost 1 exists (ghosts=1 means only [200, 400) was created)

    // This reveals the BUG: Ghost creation is too slow!
    // When posPx reaches 453, we need ghost 2 [400, 600)
    // But timelineWidth hasn't grown enough yet to create ghost 2

    const posPx = 453;
    const ghostBounds = { left: 200, right: 400 };

    const isInGhost1 = (posPx >= ghostBounds.left - 1 && posPx < ghostBounds.right);
    console.log(`posPx=${posPx} in ghost 1 [200, 400)? ${isInGhost1}`);

    if (!isInGhost1) {
        console.log("\n✗ This confirms the bug: posPx has moved past the only available ghost!");
        console.log("Solution: Ghosts must be created AHEAD of the cursor, not behind.");
        return false;
    }

    return true;
}

// Run all tests
console.log("\n" + "=".repeat(60) + "\n");
const results = [];
results.push(testDuringRecording());
results.push(testGhostCreationPace());
results.push(testRealLogData());

console.log("=".repeat(60));
const passed = results.filter(r => r).length;
const total = results.length;
console.log(`\nResults: ${passed}/${total} tests passed\n`);

if (passed < total) {
    console.log("DIAGNOSIS: The ghost extension logic creates ghosts TOO SLOWLY.");
    console.log("The cursor (posPx) moves faster than ghosts are being created.");
    console.log("FIX: Create ghosts ahead of the current cursor position, not just up to timelineWidth.");
    process.exit(1);
}
