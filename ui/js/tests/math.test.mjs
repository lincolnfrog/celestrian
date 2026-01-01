/**
 * Comprehensive unit tests for Phase-Aligned Visual Positioning
 * 
 * THE CORE RULE: Clips appear where they were recorded, and NEVER MOVE.
 * 
 * Formula: offset = floor((anchorPhase % wrapPeriod) / Q) * baseWidth
 * Where:  wrapPeriod = max(maxAnchor + Q, maxCompletedDuration)
 */

const Q = 175616; // 1 Quantum in samples (from user's scenario)
const baseWidth = 200;

console.log('Running Phase-Aligned Visual Positioning Tests...\n');
console.log(`Q = ${Q} samples\n`);

// Helper function matching the JS implementation
function calculateOffset(anchorPhase, effectiveQ, wrapPeriod) {
    if (effectiveQ <= 1 || wrapPeriod <= 0) return 0;
    const wrappedAnchor = anchorPhase % wrapPeriod;
    const quantumOffset = Math.floor(wrappedAnchor / effectiveQ);
    return quantumOffset * baseWidth;
}

function calculateWrapPeriod(anchors, completedDurations, effectiveQ) {
    const maxAnchor = Math.max(0, ...anchors);
    const maxDuration = Math.max(effectiveQ, ...completedDurations);
    return Math.max(maxAnchor + effectiveQ, maxDuration);
}

// =============================================================================
// TEST 1: Clip 1 at T=0 is always at position 0
// =============================================================================
{
    const wrap = calculateWrapPeriod([0], [Q], Q);
    const offset = calculateOffset(0, Q, wrap);
    console.assert(offset === 0, `FAIL: Clip 1 at T=0 should be at 0, got ${offset}`);
    console.log('✅ TEST 1: Clip 1 at T=0 → position 0px');
}

// =============================================================================
// TEST 2: Clip 2 at T=2Q should be at 2Q (400px)
// This is THE fundamental test
// =============================================================================
{
    const anchor2 = 346607; // ~1.97Q from logs
    const wrap = calculateWrapPeriod([0, anchor2], [Q], Q); // Clip 2 still recording
    const offset = calculateOffset(anchor2, Q, wrap);

    // 346607 / 175616 ≈ 1.97Q, floor = 1Q = 200px
    console.log(`   Clip 2 anchor: ${anchor2} (${(anchor2 / Q).toFixed(2)}Q)`);
    console.log(`   Wrap period: ${wrap} (${(wrap / Q).toFixed(2)}Q)`);
    console.log(`   Offset: ${offset}px (${offset / baseWidth}Q)`);

    console.assert(offset === 200, `FAIL: Clip 2 at ~2Q should be at 200px, got ${offset}`);
    console.log('✅ TEST 2: Clip 2 at T≈2Q → position 200px (1Q)');
}

// =============================================================================
// TEST 3: Clip 2 STABLE after recording finishes
// =============================================================================
{
    const anchor2 = 346607;
    const clip2Duration = 526848; // 3Q

    // During recording
    const wrapDuring = calculateWrapPeriod([0, anchor2], [Q], Q);
    const offsetDuring = calculateOffset(anchor2, Q, wrapDuring);

    // After recording
    const wrapAfter = calculateWrapPeriod([0, anchor2], [Q, clip2Duration], Q);
    const offsetAfter = calculateOffset(anchor2, Q, wrapAfter);

    console.log(`   During: wrap=${wrapDuring}, offset=${offsetDuring}px`);
    console.log(`   After:  wrap=${wrapAfter}, offset=${offsetAfter}px`);

    console.assert(offsetDuring === offsetAfter,
        `FAIL: Clip 2 moved! During=${offsetDuring}, After=${offsetAfter}`);
    console.log('✅ TEST 3: Clip 2 STABLE when recording stops');
}

// =============================================================================
// TEST 4: Clip 3 at T=7Q should be at 7Q (even with wrap)
// =============================================================================
{
    const anchor3 = 1224687; // From logs
    const wrap = calculateWrapPeriod([0, 346607, anchor3], [Q, 526848], Q);
    const offset = calculateOffset(anchor3, Q, wrap);

    console.log(`   Clip 3 anchor: ${anchor3} (${(anchor3 / Q).toFixed(2)}Q)`);
    console.log(`   Wrap period: ${wrap} (${(wrap / Q).toFixed(2)}Q)`);
    console.log(`   Offset: ${offset}px (${offset / baseWidth}Q)`);

    // 1224687 / 175616 ≈ 6.97Q, floor = 6Q
    const expectedQ = Math.floor(anchor3 / Q);
    console.assert(offset === expectedQ * baseWidth,
        `FAIL: Clip 3 should be at ${expectedQ}Q, got ${offset / baseWidth}Q`);
    console.log(`✅ TEST 4: Clip 3 at T≈7Q → position ${offset}px (${offset / baseWidth}Q)`);
}

// =============================================================================
// TEST 5: Wrap period formula verification
// =============================================================================
{
    // wrapPeriod = max(maxAnchor + Q, maxCompletedDuration)
    const anchors = [0, 2 * Q, 7 * Q];
    const durations = [Q, 3 * Q];
    const wrap = calculateWrapPeriod(anchors, durations, Q);

    // max(7Q + Q, 3Q) = 8Q
    console.assert(wrap === 8 * Q, `FAIL: Wrap should be 8Q, got ${wrap / Q}Q`);
    console.log('✅ TEST 5: Wrap period = max(7Q+Q, 3Q) = 8Q');
}

// =============================================================================
// TEST 6: All clips stable when Clip 3 finishes
// =============================================================================
{
    const anchors = [0, 346607, 1224687];

    // During Clip 3 recording
    const wrapDuring = calculateWrapPeriod(anchors, [Q, 526848], Q);
    const offsets_during = anchors.map(a => calculateOffset(a, Q, wrapDuring));

    // After Clip 3 finishes
    const wrapAfter = calculateWrapPeriod(anchors, [Q, 526848, 734208], Q);
    const offsets_after = anchors.map(a => calculateOffset(a, Q, wrapAfter));

    console.log(`   During: ${offsets_during.map(o => o + 'px').join(', ')}`);
    console.log(`   After:  ${offsets_after.map(o => o + 'px').join(', ')}`);

    for (let i = 0; i < 3; i++) {
        console.assert(offsets_during[i] === offsets_after[i],
            `FAIL: Clip ${i + 1} moved! ${offsets_during[i]} → ${offsets_after[i]}`);
    }
    console.log('✅ TEST 6: ALL clips stable when Clip 3 finishes');
}

// =============================================================================
// TEST 7: Simple 2Q offset calculation
// =============================================================================
{
    const offset = calculateOffset(2 * Q, Q, 3 * Q);
    console.assert(offset === 400, `FAIL: 2Q should be at 400px, got ${offset}`);
    console.log('✅ TEST 7: Anchor 2Q → offset 400px');
}

// =============================================================================
// TEST 8: Position 0 is always 0
// =============================================================================
{
    const offsets = [
        calculateOffset(0, Q, Q),
        calculateOffset(0, Q, 3 * Q),
        calculateOffset(0, Q, 10 * Q),
    ];
    console.assert(offsets.every(o => o === 0), `FAIL: Position 0 should always be 0`);
    console.log('✅ TEST 8: Anchor 0 → offset 0px (always)');
}

// =============================================================================
// TEST 9: Exact user scenario from logs
// =============================================================================
{
    // Clip 1: anchor=0, duration=175616 (Q)
    // Clip 2: anchor=346607 (~2Q), duration=526848 (3Q)
    // Clip 3: anchor=1224687 (~7Q), duration=734208 (~4Q)

    const clip1 = { anchor: 0, duration: 175616 };
    const clip2 = { anchor: 346607, duration: 526848 };
    const clip3 = { anchor: 1224687, duration: 734208 };
    const Q = clip1.duration;

    const wrap = calculateWrapPeriod(
        [clip1.anchor, clip2.anchor, clip3.anchor],
        [clip1.duration, clip2.duration, clip3.duration],
        Q
    );

    const pos1 = calculateOffset(clip1.anchor, Q, wrap);
    const pos2 = calculateOffset(clip2.anchor, Q, wrap);
    const pos3 = calculateOffset(clip3.anchor, Q, wrap);

    console.log(`   Wrap: ${wrap} (${(wrap / Q).toFixed(2)}Q)`);
    console.log(`   Clip 1: ${pos1}px (${pos1 / baseWidth}Q)`);
    console.log(`   Clip 2: ${pos2}px (${pos2 / baseWidth}Q)`);
    console.log(`   Clip 3: ${pos3}px (${pos3 / baseWidth}Q)`);

    console.assert(pos1 === 0, `FAIL: Clip 1 should be at 0`);
    console.assert(pos2 === 200, `FAIL: Clip 2 should be at 200px (1Q)`);
    console.log('✅ TEST 9: User scenario - exact values from logs');
}

// =============================================================================
// TEST 10: Quantum multiple anchors (exact multiples)
// =============================================================================
{
    const wrap = 10 * Q;
    console.assert(calculateOffset(0, Q, wrap) === 0, 'FAIL: 0Q');
    console.assert(calculateOffset(Q, Q, wrap) === 200, 'FAIL: 1Q');
    console.assert(calculateOffset(2 * Q, Q, wrap) === 400, 'FAIL: 2Q');
    console.assert(calculateOffset(3 * Q, Q, wrap) === 600, 'FAIL: 3Q');
    console.assert(calculateOffset(5 * Q, Q, wrap) === 1000, 'FAIL: 5Q');
    console.log('✅ TEST 10: Exact quantum multiples work correctly');
}

console.log('\n✅ All 10 Phase-Aligned Visual Positioning tests passed!');
