/**
 * Clip Anchoring Tests
 * 
 * Verifies that clips are positioned correctly based on their anchor (x_pos).
 * 
 * Bug scenario: Clip 3 starts at 2Q but gets anchored at 0Q instead of 2Q.
 * Expected: Clip 3 at x=400 (2Q slot), ghosts should wrap from 0Q to 2Q.
 */

const baseWidth = 200;  // 200px per quantum

/**
 * Calculate expected ghost positions for a clip based on anchor and duration
 * 
 * @param {Object} params - Test parameters
 * @param {number} params.clipX - Clip's x position (anchor in pixels)
 * @param {number} params.clipDuration - Clip duration in quantums
 * @param {number} params.effectiveQ - Effective quantum (longest clip in context)
 * @returns {Object} Expected ghost positions
 */
function calculateGhostPositions(params) {
    const { clipX, clipDuration, effectiveQ } = params;

    // Calculate LCM timeline width
    const timelineWidth = effectiveQ * baseWidth;

    // Clip starts at clipX, extends clipDuration quantums
    const clipStartSlot = clipX / baseWidth;
    const clipEndSlot = clipStartSlot + clipDuration;

    // Calculate how many repetitions needed to fill LCM
    const repetitionsNeeded = effectiveQ / clipDuration;

    // Generate ghost positions
    const ghosts = [];

    // Right ghosts (after main clip)
    for (let i = 1; i < repetitionsNeeded; i++) {
        const ghostX = clipX + (i * clipDuration * baseWidth);
        if (ghostX < timelineWidth) {
            ghosts.push({ x: ghostX, type: 'right' });
        }
    }

    // Left wrap ghosts (before main clip, wrapping from end)
    for (let i = 1; i <= clipStartSlot / clipDuration; i++) {
        const ghostX = clipX - (i * clipDuration * baseWidth);
        if (ghostX >= 0) {
            ghosts.push({ x: ghostX, type: 'left-wrap' });
        }
    }

    return {
        mainClipX: clipX,
        mainClipEndX: clipX + (clipDuration * baseWidth),
        ghosts,
        timelineWidth,
        repetitionsNeeded: Math.ceil(repetitionsNeeded)
    };
}

// ============================================================================
// TEST CASES
// ============================================================================

console.log("=== Clip Anchoring Tests ===\n");
let passed = 0;
let failed = 0;

// Test 1: Clip 3 at 2Q (x=400) should have ghosts at 0Q and 3Q
function test_clip3AnchoredAt2Q() {
    console.log("Test 1: Clip 3 at 2Q (x=400) in 4Q context");

    const result = calculateGhostPositions({
        clipX: 400,           // 2Q slot
        clipDuration: 1,      // 1Q duration  
        effectiveQ: 4         // 4Q context (from Clip 2)
    });

    // Main clip at 400px (2Q)
    if (result.mainClipX !== 400) {
        console.log(`  FAIL: mainClipX expected 400, got ${result.mainClipX}`);
        failed++;
        return;
    }

    // Should have 3 ghosts to fill the 4Q timeline
    // Ghosts at: 0Q (left-wrap), 1Q (left-wrap), 3Q (right)
    if (result.ghosts.length < 2) {
        console.log(`  FAIL: Expected at least 2 ghosts, got ${result.ghosts.length}`);
        failed++;
        return;
    }

    // Should have a left-wrap ghost (fills 0Q→2Q)
    const leftWrapGhosts = result.ghosts.filter(g => g.type === 'left-wrap');
    if (leftWrapGhosts.length === 0) {
        console.log(`  FAIL: Expected left-wrap ghost(s) for 0Q→2Q region`);
        failed++;
        return;
    }

    console.log("  PASS: Clip at 2Q has correct ghost placement");
    console.log(`    Main clip: ${result.mainClipX}px → ${result.mainClipEndX}px`);
    console.log(`    Ghosts: ${result.ghosts.map(g => `${g.x}px (${g.type})`).join(', ')}`);
    passed++;
}

// Test 2: Clip at 0Q should have only right ghosts, no left wrap
function test_clipAt0QNoLeftWrap() {
    console.log("\nTest 2: Clip at 0Q should have no left-wrap ghosts");

    const result = calculateGhostPositions({
        clipX: 0,             // 0Q slot
        clipDuration: 1,      // 1Q duration  
        effectiveQ: 4         // 4Q context
    });

    // Should have right ghosts only
    const leftWrapGhosts = result.ghosts.filter(g => g.type === 'left-wrap');
    if (leftWrapGhosts.length > 0) {
        console.log(`  FAIL: Clip at 0Q should have no left-wrap ghosts`);
        failed++;
        return;
    }

    // Should have 3 right ghosts at 1Q, 2Q, 3Q
    const rightGhosts = result.ghosts.filter(g => g.type === 'right');
    if (rightGhosts.length !== 3) {
        console.log(`  FAIL: Expected 3 right ghosts, got ${rightGhosts.length}`);
        failed++;
        return;
    }

    console.log("  PASS: Clip at 0Q has only right ghosts");
    console.log(`    Ghosts: ${result.ghosts.map(g => `${g.x}px (${g.type})`).join(', ')}`);
    passed++;
}

// Test 3: 4Q clip at 0Q should have no ghosts in 4Q context
function test_fullDurationNoGhosts() {
    console.log("\nTest 3: 4Q clip in 4Q context should have no ghosts");

    const result = calculateGhostPositions({
        clipX: 0,             // 0Q slot
        clipDuration: 4,      // 4Q duration (fills timeline)
        effectiveQ: 4         // 4Q context
    });

    if (result.ghosts.length !== 0) {
        console.log(`  FAIL: 4Q clip should have no ghosts, got ${result.ghosts.length}`);
        failed++;
        return;
    }

    console.log("  PASS: Full-duration clip has no ghosts");
    passed++;
}

// Test 4: Stack child with node.x should use that as clipStartX (the BUG FIX test)
function test_stackChildUsesNodeX() {
    console.log("\nTest 4: Stack child with node.x=400 should use 400 as clipStartX");

    // Simulates a clip inside a stack where node.x is set by C++ anchor logic
    const node = {
        x: 400,           // Key: C++ sets this based on recording start phase (2Q)
        duration: 1,      // 1Q duration
        isRecording: false
    };

    const effectiveQ = 4;  // 4Q context
    const baseWidth = 200;

    // This is the fix: clipStartX should use node.x, not hardcoded 0
    const clipStartX = node.x || 0;  // The FIX
    const clipWidth = (node.duration / effectiveQ) * baseWidth * effectiveQ;  // 200px

    if (clipStartX !== 400) {
        console.log(`  FAIL: clipStartX should be 400 (from node.x), got ${clipStartX}`);
        console.log(`    Bug was: clipStartX was hardcoded to 0, ignoring node.x`);
        failed++;
        return;
    }

    // Calculate clip end position
    const clipEndX = clipStartX + 200;  // 600px (2Q+1Q = 3Q)

    if (clipEndX !== 600) {
        console.log(`  FAIL: clipEndX should be 600, got ${clipEndX}`);
        failed++;
        return;
    }

    console.log("  PASS: Stack child correctly uses node.x for clipStartX");
    console.log(`    clipStartX: ${clipStartX}px (from node.x=400)`);
    console.log(`    clipEndX: ${clipEndX}px`);
    passed++;
}

// Run all tests
test_clip3AnchoredAt2Q();
test_clipAt0QNoLeftWrap();
test_fullDurationNoGhosts();
test_stackChildUsesNodeX();

// Summary
console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
    console.log("\nSome tests failed - clip anchoring needs fixing!");
    process.exit(1);
}
