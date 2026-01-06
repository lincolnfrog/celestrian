
// Mock app.js logic for ghost cursors

const nodes = [
    { id: 'n1', duration: 44100, isRecording: false, x: 0, w: 200, effectiveQuantum: 44100 }, // 1Q
    { id: 'n2', duration: 176400, isRecording: false, x: 0, w: 800, effectiveQuantum: 44100 }, // 4Q
    { id: 'n3', duration: 132300, isRecording: false, x: 0, w: 600, effectiveQuantum: 44100 }  // 3Q
];

const state = { masterPos: 0, isPlaying: true };
const effectiveQ = 44100;
const baseWidth = 200;
const longestDuration = 529200; // 12Q

// Test Helper
function checkGhostVisibility(node, ghostIndex, masterPos) {
    state.masterPos = masterPos;

    // logic from app.js
    let timelinePosPx;
    // Assume no recording for this test case
    const timelinePos = state.masterPos % longestDuration;
    timelinePosPx = (timelinePos / effectiveQ) * baseWidth;

    const clipWidth = (node.duration / effectiveQ) * baseWidth;
    const clipStartX = node.x; // Simplified, assume 0 for now as per screenshot

    // Ghost Generation Loop Simulation
    let currentGhostX = clipStartX + clipWidth;
    let ghostCount = 0;

    // Fast forward to the specific ghost index we want to test
    // loops for ghost 0, ghost 1, etc.
    // The "ghosts" in app.js are repetitions. The "main" clip is at clipStartX.
    // The first ghost is at clipStartX + clipWidth.

    for (let i = 0; i <= ghostIndex; i++) {
        // currentGhostX is the START of the current ghost
        if (i === ghostIndex) {
            const isActiveGhost = (timelinePosPx >= currentGhostX - 0.1 && timelinePosPx < currentGhostX + clipWidth - 0.1);
            return {
                isActive: isActiveGhost,
                timelinePosPx,
                currentGhostX,
                currentGhostEnd: currentGhostX + clipWidth,
                debug: `Pos=${timelinePosPx.toFixed(1)} Range=[${currentGhostX.toFixed(1)}, ${(currentGhostX + clipWidth).toFixed(1)})`
            };
        }
        currentGhostX += clipWidth;
    }
    return { isActive: false, debug: "Ghost index out of bounds" };
}

console.log("--- Test Case: 1Q Clip (n1) in 12Q Timeline ---");
// Clip 1 (1Q=200px). 
// Main: [0, 200)
// Ghost 0: [200, 400) -> 2nd Q
// Ghost 1: [400, 600) -> 3rd Q
// ...

// Test time at 1.5Q (should be in Ghost 0)
// 1.5Q = 1.5 * 44100 = 66150 samples
let res = checkGhostVisibility(nodes[0], 0, 66150);
console.log(`Time 1.5Q (Expected Ghost 0 Active): ${res.isActive} | ${res.debug}`);

if (!res.isActive) {
    console.error("FAIL: Ghost 0 should be active at 1.5Q");
    process.exit(1);
}

// Test time at 4.5Q (should be in Ghost 3)
// 4.5Q = 198450 samples
res = checkGhostVisibility(nodes[0], 3, 198450);
console.log(`Time 4.5Q (Expected Ghost 3 Active): ${res.isActive} | ${res.debug}`);

if (!res.isActive) {
    console.error("FAIL: Ghost 3 should be active at 4.5Q");
    process.exit(1);
}

console.log("\n--- Test Case: 3Q Clip (n3) in 12Q Timeline ---");
// Clip 3 (3Q=600px).
// Main: [0, 600)
// Ghost 0: [600, 1200) -> 2nd repetition (covering Q4, Q5, Q6)
// Ghost 1: [1200, 1800) -> 3rd repetition 

// 12Q timeline width = 2400px.
// Timeline wraps at 2400px.

// Test time at 4.5Q (should be in Ghost 0 of Clip 3)
// 4.5Q is inside [3Q, 6Q) range of global time.
// Clip 3 is 3Q long.
// Ghost 0 covers [3Q, 6Q).
res = checkGhostVisibility(nodes[2], 0, 198450);
console.log(`Time 4.5Q (Expected Ghost 0 Active): ${res.isActive} | ${res.debug}`);

if (!res.isActive) {
    console.error("FAIL: Ghost 0 of Clip 3 should be active at 4.5Q");
    process.exit(1);
}

// Test boundary condition: Exactly at 3Q start (start of Ghost 0)
res = checkGhostVisibility(nodes[2], 0, 132300);
console.log(`Time 3.0Q (Expected Ghost 0 Active): ${res.isActive} | ${res.debug}`);

if (!res.isActive) {
    console.error("FAIL: Ghost 0 should be active exactly at start boundary");
    process.exit(1);
}

console.log("\nPASS: All cursor logic tests passed.");
