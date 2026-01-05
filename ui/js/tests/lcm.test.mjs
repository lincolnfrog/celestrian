const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
const lcm = (a, b) => (a === 0 || b === 0) ? Math.max(a, b) : Math.abs((a * b) / gcd(a, b));

const nodes = [
    { isRecording: false, duration: 44100 }, // Clip 1 (1Q)
    { isRecording: false, duration: 176400 }, // Clip 2 (4Q)
    { isRecording: false, duration: 132300 }, // Clip 3 (3Q)
];
const effectiveQ = 44100;

let committedLCM = effectiveQ;
let maxDuration = 0;

nodes.forEach(n => {
    if (n.duration > maxDuration) maxDuration = n.duration;
    if (!n.isRecording && n.duration > 0) {
        committedLCM = lcm(committedLCM, n.duration);
    }
});

console.log(`LCM: ${committedLCM}`);
console.assert(committedLCM === 529200, `Expected 529200 (12Q), got ${committedLCM}`);

if (committedLCM === 529200) console.log("PASS");
else console.log("FAIL");
