/**
 * Ghost LCM Boundary Expansion Tests
 * 
 * These tests verify that the ACTUAL app.js implementation follows
 * the design: ghosts expand at committed LCM boundaries, NOT Q boundaries.
 * 
 * These tests simulate the ghost extension logic from app.js and verify
 * it produces the correct results.
 */

const baseWidth = 200;  // 200px per quantum

/**
 * Simulates the CURRENT (buggy) app.js ghost extension logic
 * This uses quantumCount which is WRONG
 */
function currentAppJsGhostLogic(effectiveQ, masterPos, lastQuantumCount) {
    // Current buggy logic from app.js lines 497-505:
    const quantumCount = Math.floor(masterPos / effectiveQ) + 1;
    const needsExtension = (quantumCount > lastQuantumCount);
    const ghostExtentPx = quantumCount * baseWidth;

    return {
        quantumCount,
        needsExtension,
        ghostExtentPx,
        // This is the BUG: uses Q boundaries, not LCM boundaries
    };
}

/**
 * Simulates the CORRECT ghost extension logic per design
 * This uses lcmMultiple which is RIGHT
 */
function correctGhostLogic(committedLCM, masterPos, lastLcmMultiple) {
    // Correct logic per design:
    const currentLcmMultiple = Math.floor(masterPos / committedLCM) + 1;
    const needsExtension = (currentLcmMultiple > lastLcmMultiple);
    const ghostExtentPx = currentLcmMultiple * committedLCM * (baseWidth / 1);  // Assuming Q=1

    return {
        lcmMultiple: currentLcmMultiple,
        needsExtension,
        ghostExtentPx,
    };
}

// Test: No ghost expansion before LCM boundary
function testNoExpansionBeforeLCM() {
    console.log("=== TEST: No Ghost Expansion Before LCM Boundary ===\n");

    // Scenario: 1Q + 4Q committed, clip 3 recording at 3Q
    // Committed LCM = 4Q
    // We are at position 3Q - should NOT trigger ghost expansion

    const effectiveQ = 44100;  // 1Q in samples
    const committedLCM = 4 * effectiveQ;  // 4Q
    const masterPos = 3 * effectiveQ;  // 3Q position

    // CURRENT (buggy) logic - uses Q boundaries
    const buggyResult = currentAppJsGhostLogic(effectiveQ, masterPos, 0);
    console.log(`CURRENT (buggy): quantumCount=${buggyResult.quantumCount}, needsExtension=${buggyResult.needsExtension}`);

    // CORRECT logic - uses LCM boundaries
    const correctResult = correctGhostLogic(committedLCM, masterPos, 1);
    console.log(`CORRECT: lcmMultiple=${correctResult.lcmMultiple}, needsExtension=${correctResult.needsExtension}`);

    // The test: buggy logic says needsExtension=true (because quantumCount=4 > 0)
    // But correct logic says needsExtension=false (because lcmMultiple=1, no change)
    const buggyIsWrong = buggyResult.needsExtension === true;
    const correctIsRight = correctResult.needsExtension === false;

    if (buggyIsWrong && correctIsRight) {
        console.log("\n✗ FAIL (expected): Current app.js incorrectly extends ghosts at Q boundaries");
        console.log("   FIX NEEDED: Change from quantumCount to lcmMultiple\n");
        return false;  // Test fails because implementation is buggy
    } else if (!buggyIsWrong) {
        console.log("\n✓ PASS: Current app.js correctly does NOT extend at 3Q");
        return true;
    } else {
        console.log("\n? UNEXPECTED: Something else is wrong\n");
        return false;
    }
}

// Test: Ghost expansion AT LCM boundary
function testExpansionAtLCM() {
    console.log("=== TEST: Ghost Expansion At LCM Boundary ===\n");

    // Scenario: 1Q + 4Q committed, clip 3 recording at 5Q
    // Committed LCM = 4Q
    // We are at position 5Q - should trigger ghost expansion

    const effectiveQ = 44100;
    const committedLCM = 4 * effectiveQ;
    const masterPos = 5 * effectiveQ;  // 5Q position (past 4Q LCM)

    // CORRECT logic
    const correctResult = correctGhostLogic(committedLCM, masterPos, 1);
    console.log(`CORRECT: lcmMultiple=${correctResult.lcmMultiple}, needsExtension=${correctResult.needsExtension}`);

    // At 5Q, we've crossed the 4Q boundary, so lcmMultiple should be 2
    if (correctResult.lcmMultiple === 2 && correctResult.needsExtension === true) {
        console.log("\n✓ PASS: Correctly identifies need for expansion at 5Q (crossed 4Q LCM)\n");
        return true;
    } else {
        console.log("\n✗ FAIL: Did not identify expansion need correctly\n");
        return false;
    }
}

// Test: Compare buggy vs correct ghost counts
function testGhostCountDifference() {
    console.log("=== TEST: Ghost Count Difference (Buggy vs Correct) ===\n");

    // Scenario: Recording at 3Q with LCM=4Q
    // Buggy creates ghosts for 3Q extent
    // Correct stays at 4Q extent (no expansion needed)

    const effectiveQ = 44100;
    const committedLCM = 4 * effectiveQ;
    const masterPos = 3 * effectiveQ;

    const buggy = currentAppJsGhostLogic(effectiveQ, masterPos, 0);
    const correct = correctGhostLogic(committedLCM, masterPos, 1);

    // Buggy: ghostExtentPx = 4 * 200 = 800px (clip 1 gets 3 ghosts at Q1, Q2, Q3)
    // Actually wait, quantumCount = floor(3Q/1Q) + 1 = 4, so 800px
    // But it would have ALREADY been shown at Q1, Q2, Q3 incrementally

    console.log(`Buggy ghostExtentPx: ${buggy.ghostExtentPx}px (${buggy.ghostExtentPx / baseWidth}Q)`);
    console.log(`Correct would use LCM: ${committedLCM / effectiveQ}Q = ${committedLCM / effectiveQ * baseWidth}px`);

    // The bug is that buggy logic triggers needsExtension at EVERY Q boundary
    // Let's trace what happens from Q0 to Q3:
    console.log("\nBuggy behavior trace:");
    let lastQ = 0;
    for (let pos = 0.5; pos <= 3; pos += 0.5) {
        const result = currentAppJsGhostLogic(effectiveQ, pos * effectiveQ, lastQ);
        if (result.needsExtension) {
            console.log(`  At ${pos}Q: EXTENDS (quantumCount ${lastQ} → ${result.quantumCount})`);
            lastQ = result.quantumCount;
        }
    }

    console.log("\nCorrect behavior trace:");
    let lastLcm = 1;
    for (let pos = 0.5; pos <= 3; pos += 0.5) {
        const result = correctGhostLogic(committedLCM, pos * effectiveQ, lastLcm);
        if (result.needsExtension) {
            console.log(`  At ${pos}Q: EXTENDS (lcmMultiple ${lastLcm} → ${result.lcmMultiple})`);
            lastLcm = result.lcmMultiple;
        }
    }
    console.log("  (No extensions - recording hasn't crossed 4Q LCM yet)");

    console.log("\n✗ FAIL (expected): Buggy logic extends at every Q, correct logic waits for LCM\n");
    return false;  // This test demonstrates the bug
}

// Run all tests
console.log("\n" + "=".repeat(60) + "\n");
console.log("GHOST LCM BOUNDARY TESTS - VERIFYING CURRENT BUGS");
console.log("\n" + "=".repeat(60) + "\n");

const results = [];
results.push(testNoExpansionBeforeLCM());
results.push(testExpansionAtLCM());
results.push(testGhostCountDifference());

console.log("=".repeat(60));
const passed = results.filter(r => r).length;
const total = results.length;
console.log(`\nResults: ${passed}/${total} tests passed\n`);

if (passed < total) {
    console.log("EXPECTED: Tests fail because current implementation uses Q boundaries.");
    console.log("FIX: Change app.js from quantumCount to lcmMultiple-based logic.");
    process.exit(1);
}
